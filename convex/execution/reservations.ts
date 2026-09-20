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
import { f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";
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
    });
    await ctx.db.patch(budget._id, {
      reservedMicroUsd: budget.reservedMicroUsd + args.amountMicroUsd,
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
