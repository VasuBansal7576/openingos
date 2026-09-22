/**
 * F1 shared provider-budget reservations (controlled contract, ADR-0004).
 *
 * Equipment budget and provider allowance are separate values, kept in
 * integer micro-USD. Every reservation draws atomically from the
 * organization-level `providerBudgets` ledger inside the same mutation, so
 * two concurrent branches or jobs cannot each reserve the full shared
 * allowance. While an outcome or charge is unknown the reservation is
 * retained as `unresolved`, never released as free. Identity and time are
 * server-derived.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";
import {
  ensureGlobalAllowance,
  getGlobalAllowance,
  attributedGlobalExposure,
  tryDebitGlobalForReservation,
} from "./allowance.js";
import {
  MAX_RECONCILIATION_READS,
  parseReconciliationPricingBasis,
} from "../communication/contracts.js";
import {
  MAX_JOBS_PER_GRANT,
  MAX_RESERVATIONS_PER_JOB,
} from "../shared/scope.js";

const reservationViewValidator = v.object({
  id: v.id("reservations"),
  jobId: v.id("jobs"),
  ceilingMicroUsd: v.number(),
  reservedMicroUsd: v.number(),
  spentMicroUsd: v.number(),
  unresolvedMicroUsd: v.number(),
  pricingBasis: v.string(),
  state: v.string(),
});

async function boundedGrantExposure(
  ctx: F1MutationCtx,
  grantId: Id<"grants">,
): Promise<{ ok: true; committedMicroUsd: number } | { ok: false }> {
  const grantJobs = await ctx.db
    .query("jobs")
    .withIndex("by_grant", (q) => q.eq("grantId", grantId))
    .take(MAX_JOBS_PER_GRANT + 1);
  if (grantJobs.length > MAX_JOBS_PER_GRANT) return { ok: false };
  let committedMicroUsd = 0;
  for (const grantJob of grantJobs) {
    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_job", (q) => q.eq("jobId", grantJob._id))
      .take(MAX_RESERVATIONS_PER_JOB + 1);
    if (reservations.length > MAX_RESERVATIONS_PER_JOB) return { ok: false };
    for (const reservation of reservations) {
      committedMicroUsd +=
        reservation.reservedMicroUsd + reservation.spentMicroUsd + reservation.unresolvedMicroUsd;
    }
  }
  return { ok: true, committedMicroUsd };
}

/** Reserve shared allowance for a job (atomic against the org ledger). */
export const reserve = f1Mutation({
  args: {
    jobId: v.id("jobs"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    amountMicroUsd: v.number(),
    pricingBasis: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), reservationId: v.id("reservations") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (!Number.isSafeInteger(args.amountMicroUsd) || args.amountMicroUsd <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "reservation amount must be a positive safe integer" };
    }
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.organizationId !== args.organizationId ||
      job.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    const grant = await ctx.db.get(job.grantId);
    if (grant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    // The reservation binds to the grant cost ceiling as well as the
    // shared budget: neither the single amount nor the grant-wide running
    // total may exceed what the grant authorizes. F1R-01: exposure spans
    // every job bound to this grant (reserved + spent + unresolved),
    // summed atomically inside this mutation so two jobs cannot each
    // spend the same approval.
    if (args.amountMicroUsd > grant.costCeilingMicroUsd) {
      return { ok: false as const, code: "grant-ceiling-exceeded", message: "reservation exceeds the grant cost ceiling" };
    }
    const exposure = await boundedGrantExposure(ctx, grant._id);
    if (!exposure.ok) {
      return { ok: false as const, code: "grant-accounting-limit", message: "grant exposure exceeds the bounded accounting contract" };
    }
    if (exposure.committedMicroUsd + args.amountMicroUsd > grant.costCeilingMicroUsd) {
      return { ok: false as const, code: "grant-ceiling-exceeded", message: "grant-wide reservations exceed the grant cost ceiling" };
    }
    const jobReservations = await ctx.db
      .query("reservations")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(MAX_RESERVATIONS_PER_JOB + 1);
    if (jobReservations.length >= MAX_RESERVATIONS_PER_JOB) {
      return { ok: false as const, code: "reservation-admission-limit", message: "job reservation admission limit reached" };
    }
    const budget = await ctx.db
      .query("providerBudgets")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .unique();
    if (budget === null) {
      return { ok: false as const, code: "allowance-exhausted", message: "no provider budget configured" };
    }
    const committed =
      budget.reservedMicroUsd + budget.spentMicroUsd + budget.unresolvedMicroUsd;
    if (committed + args.amountMicroUsd > budget.ceilingMicroUsd) {
      await ctx.db.patch(args.jobId, { state: "pausedBudget", updatedAt: now });
      return {
        ok: false as const,
        code: "allowance-exhausted",
        message: "shared allowance cannot cover another full reservation",
      };
    }
    // Deployment aggregate: the sum across organizations is globally
    // bounded. Ensure the singleton exists (legacy rows inserted it), then
    // debit it in the SAME mutation before touching the org ledger, so a
    // concurrent organization serializes on the global row via OCC.
    // Migration invariant: a first global row created after legacy org
    // ledgers already carry spend seeds from their bounded sum instead of
    // zero, so observed spend is not forgotten and re-spendable.
    await ensureGlobalAllowance(ctx, budget.ceilingMicroUsd, budget.pricingBasis);
    const global = await getGlobalAllowance(ctx);
    if (global === null) {
      return { ok: false as const, code: "allowance-exhausted", message: "deployment allowance is unavailable" };
    }
    const globalCommitted =
      global.reservedMicroUsd + global.spentMicroUsd + global.unresolvedMicroUsd;
    if (globalCommitted + args.amountMicroUsd > global.ceilingMicroUsd) {
      await ctx.db.patch(args.jobId, { state: "pausedBudget", updatedAt: now });
      return {
        ok: false as const,
        code: "allowance-exhausted",
        message: "deployment allowance cannot cover another full reservation",
      };
    }
    const reservationId = await ctx.db.insert("reservations", {
      organizationId: args.organizationId,
      jobId: args.jobId,
      budgetId: budget._id,
      ceilingMicroUsd: budget.ceilingMicroUsd,
      reservedMicroUsd: args.amountMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: args.pricingBasis,
      state: "open",
      updatedAt: now,
      // Global attribution: this row's exact hold on the deployment
      // aggregate, debited above in the same mutation. Cancellation and
      // settlement release exactly this amount — never another tenant's.
      globalReservedMicroUsd: args.amountMicroUsd,
    });
    await ctx.db.patch(budget._id, {
      reservedMicroUsd: budget.reservedMicroUsd + args.amountMicroUsd,
      updatedAt: now,
    });
    await ctx.db.patch(global._id, {
      reservedMicroUsd: global.reservedMicroUsd + args.amountMicroUsd,
      updatedAt: now,
    });
    return { ok: true as const, reservationId };
  },
});

/** Read the org ledger plus one job's reservations (authorized readers). */
export const ledger = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    jobId: v.id("jobs"),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      budget: v.union(
        v.object({
          ceilingMicroUsd: v.number(),
          reservedMicroUsd: v.number(),
          spentMicroUsd: v.number(),
          unresolvedMicroUsd: v.number(),
        }),
        v.null(),
      ),
      reservations: v.array(reservationViewValidator),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.organizationId !== args.organizationId ||
      job.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const budget = await ctx.db
      .query("providerBudgets")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .unique();
    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(MAX_RESERVATIONS_PER_JOB + 1);
    if (reservations.length > MAX_RESERVATIONS_PER_JOB) {
      return { ok: false as const, code: "reservation-admission-limit", message: "job reservation history exceeds the bounded contract" };
    }
    return {
      ok: true as const,
      budget: budget
        ? {
          ceilingMicroUsd: budget.ceilingMicroUsd,
          reservedMicroUsd: budget.reservedMicroUsd,
          spentMicroUsd: budget.spentMicroUsd,
          unresolvedMicroUsd: budget.unresolvedMicroUsd,
        }
        : null,
      reservations: reservations.map((reservation) => ({
        id: reservation._id,
        jobId: reservation.jobId,
        ceilingMicroUsd: reservation.ceilingMicroUsd,
        reservedMicroUsd: reservation.reservedMicroUsd,
        spentMicroUsd: reservation.spentMicroUsd,
        unresolvedMicroUsd: reservation.unresolvedMicroUsd,
        pricingBasis: reservation.pricingBasis,
        state: reservation.state,
      })),
    };
  },
});

/**
 * Internal: admit one server-owned reconciliation read run. Unlike the
 * user-identity `reserve` above, authority here is server-verified: the job
 * and grant must exist, match, and be current, and the pricing basis must
 * parse as the canonical reconciliation contract. The atomic ledger debit
 * is identical, so server reads cannot bypass the shared allowance or the
 * grant ceiling. Used only by the oversized-reply recovery gate.
 */
export const reserveServerRead = f1InternalMutation({
  args: {
    jobId: v.id("jobs"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    grantId: v.id("grants"),
    amountMicroUsd: v.number(),
    pricingBasis: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), reservationId: v.id("reservations") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.organizationId !== args.organizationId ||
      job.projectId !== args.projectId ||
      job.grantId !== args.grantId
    ) {
      return { ok: false as const, code: "denied-membership", message: "recovery job is not authorized for this project" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "recovery job is fenced for cancellation" };
    }
    const grant = await ctx.db.get(args.grantId);
    if (
      grant === null ||
      grant.organizationId !== args.organizationId ||
      grant.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "recovery grant is not authorized for this project" };
    }
    if (grant.status !== "active" || grant.expiresAt <= now) {
      return { ok: false as const, code: "alternate-channel-denied", message: "recovery grant is not active" };
    }
    if (!Number.isSafeInteger(args.amountMicroUsd) || args.amountMicroUsd <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "reservation amount must be a positive safe integer" };
    }
    if (parseReconciliationPricingBasis(args.pricingBasis) === null) {
      return { ok: false as const, code: "stale-pricing-basis", message: "reconciliation pricing basis is unavailable or stale" };
    }
    if (args.amountMicroUsd > grant.costCeilingMicroUsd) {
      return { ok: false as const, code: "grant-ceiling-exceeded", message: "reservation exceeds the grant cost ceiling" };
    }
    const exposure = await boundedGrantExposure(ctx, grant._id);
    if (!exposure.ok) {
      return { ok: false as const, code: "grant-accounting-limit", message: "grant exposure exceeds the bounded accounting contract" };
    }
    if (exposure.committedMicroUsd + args.amountMicroUsd > grant.costCeilingMicroUsd) {
      return { ok: false as const, code: "grant-ceiling-exceeded", message: "grant-wide reservations exceed the grant cost ceiling" };
    }
    const jobReservations = await ctx.db
      .query("reservations")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(MAX_RESERVATIONS_PER_JOB + 1);
    if (jobReservations.length >= MAX_RESERVATIONS_PER_JOB) {
      return { ok: false as const, code: "reservation-admission-limit", message: "job reservation admission limit reached" };
    }
    const budget = await ctx.db
      .query("providerBudgets")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .unique();
    if (budget === null) {
      return { ok: false as const, code: "allowance-exhausted", message: "no provider budget configured" };
    }
    if (budget.pricingBasis !== args.pricingBasis) {
      return { ok: false as const, code: "stale-pricing-basis", message: "operation allowance pricing policy is stale" };
    }
    const committed =
      budget.reservedMicroUsd + budget.spentMicroUsd + budget.unresolvedMicroUsd;
    if (committed + args.amountMicroUsd > budget.ceilingMicroUsd) {
      await ctx.db.patch(args.jobId, { state: "pausedBudget", updatedAt: now });
      return {
        ok: false as const,
        code: "allowance-exhausted",
        message: "shared allowance cannot cover another full reservation",
      };
    }
    // Legacy bridge: server-read recovery fixtures predate the deployment
    // aggregate, so seed it from the bounded partition sum (same migration
    // invariant as the user-identity reserve) instead of failing closed.
    if ((await getGlobalAllowance(ctx)) === null) {
      await ensureGlobalAllowance(ctx, budget.ceilingMicroUsd, budget.pricingBasis);
    }
    const globalAdmitted = await tryDebitGlobalForReservation(ctx, args.amountMicroUsd);
    if (!globalAdmitted) {
      await ctx.db.patch(args.jobId, { state: "pausedBudget", updatedAt: now });
      return {
        ok: false as const,
        code: "allowance-exhausted",
        message: "deployment allowance cannot cover another full reservation",
      };
    }
    const reservationId = await ctx.db.insert("reservations", {
      organizationId: args.organizationId,
      jobId: args.jobId,
      budgetId: budget._id,
      ceilingMicroUsd: budget.ceilingMicroUsd,
      reservedMicroUsd: args.amountMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: args.pricingBasis,
      state: "open",
      updatedAt: now,
      // Global attribution: this row's exact hold on the deployment
      // aggregate, debited above in the same mutation.
      globalReservedMicroUsd: args.amountMicroUsd,
    });
    await ctx.db.patch(budget._id, {
      reservedMicroUsd: budget.reservedMicroUsd + args.amountMicroUsd,
      updatedAt: now,
    });
    return { ok: true as const, reservationId };
  },
});

/**
 * Internal: settle a server-owned reconciliation reservation. A definitive
 * provider rejection releases the held allowance; every other terminal
 * outcome retains the used portion as unresolved because a read that may
 * have executed must never be freed as if it cost nothing, and no actual
 * spend number is ever invented. The run always closes.
 *
 * The deployment aggregate mirrors the exact retained/released split —
 * never the whole hold: the owned attributed reserved hold closes, at
 * most that owned hold moves to unresolved, and the released remainder
 * simply leaves reserved. Retain beyond owned reserved attribution is
 * org-only: a post-global unbound (or partially attributed) reservation
 * can never invent global unresolved exposure or consume another
 * tenant's capacity. A zero-read settlement (`readsUsed=0`) therefore
 * releases the full hold globally and retains nothing. Every denial
 * precedes every write: budget, aggregate, and reservation patches all
 * happen after the last possible denial, so a denied settlement commits
 * no partial debit on any ledger.
 */
export const settleServerRead = f1InternalMutation({
  args: {
    reservationId: v.id("reservations"),
    organizationId: v.id("organizations"),
    jobId: v.id("jobs"),
    readsUsed: v.number(),
    mode: v.union(v.literal("retainUnknown"), v.literal("release")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), retainedMicroUsd: v.number(), releasedMicroUsd: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!Number.isSafeInteger(args.readsUsed) || args.readsUsed < 0 || args.readsUsed > MAX_RECONCILIATION_READS) {
      return { ok: false as const, code: "invalid-payload", message: "settlement read count is outside the bounded retry policy" };
    }
    const reservation = await ctx.db.get(args.reservationId);
    if (
      reservation === null ||
      reservation.organizationId !== args.organizationId ||
      reservation.jobId !== args.jobId ||
      reservation.state !== "open"
    ) {
      return { ok: false as const, code: "allowance-exhausted", message: "reconciliation reservation is unavailable" };
    }
    const pricing = parseReconciliationPricingBasis(reservation.pricingBasis);
    if (pricing === null) {
      return { ok: false as const, code: "stale-pricing-basis", message: "reconciliation pricing basis is unavailable or stale" };
    }
    const amount = reservation.reservedMicroUsd;
    const retain = args.mode === "release" ? 0 : Math.min(amount, args.readsUsed * pricing.readCostMicroUsd);
    if (!Number.isSafeInteger(retain) || retain < 0) {
      return { ok: false as const, code: "invalid-payload", message: "settlement accounting overflow" };
    }
    const released = amount - retain;
    // A missing budget row must fail closed: silently closing the
    // reservation would lose the ledger side of this accounting.
    const budget = await ctx.db.get(reservation.budgetId);
    if (budget === null || budget.organizationId !== args.organizationId) {
      return { ok: false as const, code: "allowance-exhausted", message: "reconciliation budget is unavailable" };
    }
    // Global pre-validation before any write. An attributed reserved hold
    // larger than the settling amount would free another tenant's
    // exposure, and an aggregate that cannot cover the attributed hold is
    // genuine drift: both fail closed here, before the org ledger moves.
    // Legacy deployments without a global row keep org-only accounting.
    const global = await getGlobalAllowance(ctx);
    const attribution = attributedGlobalExposure(reservation, global);
    if (global !== null) {
      if (attribution.reserved > amount) {
        return { ok: false as const, code: "allowance-exhausted", message: "deployment allowance ledger drift: attributed hold exceeds the settling reservation" };
      }
      if (global.reservedMicroUsd < attribution.reserved) {
        return { ok: false as const, code: "allowance-exhausted", message: "deployment allowance ledger drift: global reserved cannot cover settlement" };
      }
    }
    await ctx.db.patch(reservation.budgetId, {
      reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
      unresolvedMicroUsd: budget.unresolvedMicroUsd + retain,
      updatedAt: now,
    });
    // Exact owned-attribution mirror: close only this reservation's owned
    // attributed reserved hold (see `attributedGlobalExposure`) — never
    // another tenant's exposure — and move into unresolved at most that
    // owned hold. Retain beyond owned attribution settles org-side only
    // and never reaches the aggregate.
    const ownedClose = Math.min(attribution.reserved, amount);
    const globalRetain = Math.min(retain, ownedClose);
    if (global !== null && ownedClose > 0) {
      await ctx.db.patch(global._id, {
        reservedMicroUsd: global.reservedMicroUsd - ownedClose,
        unresolvedMicroUsd: global.unresolvedMicroUsd + globalRetain,
        updatedAt: now,
      });
    }
    await ctx.db.patch(reservation._id, {
      reservedMicroUsd: 0,
      unresolvedMicroUsd: reservation.unresolvedMicroUsd + retain,
      state: "closed",
      updatedAt: now,
      // Pin the exact remainder of both attribution legs in the same
      // mutation: the owned reserved hold fully closes here, while the
      // globally retained split joins the reservation's unresolved
      // attribution. A fully unbound reservation stays unmarked: it gains
      // no global marker for exposure it never owned.
      ...(global === null || (attribution.reserved <= 0 && attribution.unresolved <= 0)
        ? {}
        : {
          globalReservedMicroUsd: 0,
          globalUnresolvedMicroUsd: attribution.unresolved + globalRetain,
        }),
    });
    return { ok: true as const, retainedMicroUsd: retain, releasedMicroUsd: released };
  },
});
