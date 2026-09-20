/**
 * F1 shared provider-budget reservations (controlled contract, ADR-0004).
 *
 * Equipment budget and provider allowance are separate values, kept in
 * integer micro-USD. Every reservation draws atomically from the
 * organization-level `providerBudgets` ledger inside the same mutation, so
 * two concurrent branches or jobs cannot each reserve the full shared
 * allowance. While an outcome or charge is unknown the reservation is
 * retained as `unresolved`, never released as free.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";

const reservationViewValidator = v.object({
  id: v.string(),
  jobId: v.string(),
  ceilingMicroUsd: v.number(),
  reservedMicroUsd: v.number(),
  spentMicroUsd: v.number(),
  unresolvedMicroUsd: v.number(),
  pricingBasis: v.string(),
  state: v.string(),
});

/** Reserve shared allowance for a job (atomic against the org ledger). */
export const reserve = mutation({
  args: {
    jobId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    amountMicroUsd: v.number(),
    pricingBasis: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), reservationId: v.string() }),
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
      "contributor",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (!Number.isSafeInteger(args.amountMicroUsd) || args.amountMicroUsd <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "reservation amount must be a positive safe integer" };
    }
    const job = (await ctx.db.get(args.jobId as never)) as unknown as {
      organizationId?: string;
      state?: string;
    } | null;
    if (!job || job.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "job is not in this organization" };
    }
    if (job.state === "cancelled") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is cancelled" };
    }
    const budgets = (await ctx.db
      .query("providerBudgets")
      .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
      .collect()) as unknown as {
      _id: string;
      ceilingMicroUsd: number;
      reservedMicroUsd: number;
      spentMicroUsd: number;
      unresolvedMicroUsd: number;
    }[];
    const budget = budgets[0];
    if (!budget) {
      return { ok: false as const, code: "allowance-exhausted", message: "no provider budget configured" };
    }
    const committed =
      budget.reservedMicroUsd + budget.spentMicroUsd + budget.unresolvedMicroUsd;
    if (committed + args.amountMicroUsd > budget.ceilingMicroUsd) {
      await ctx.db.patch(args.jobId as never, { state: "pausedBudget", updatedAt: args.now });
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
      updatedAt: args.now,
    });
    await ctx.db.patch(budget._id as never, {
      reservedMicroUsd: budget.reservedMicroUsd + args.amountMicroUsd,
      updatedAt: args.now,
    });
    return { ok: true as const, reservationId: reservationId as unknown as string };
  },
});

/** Read the org ledger plus one job's reservations (authorized readers). */
export const ledger = query({
  args: { organizationId: v.string(), projectId: v.string(), jobId: v.string(), now: v.number() },
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
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const budgets = (await ctx.db
      .query("providerBudgets")
      .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
      .collect()) as unknown as {
      ceilingMicroUsd: number;
      reservedMicroUsd: number;
      spentMicroUsd: number;
      unresolvedMicroUsd: number;
    }[];
    const reservations = (await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("jobId"), args.jobId))
      .collect()) as unknown as {
      _id: string;
      jobId: string;
      ceilingMicroUsd: number;
      reservedMicroUsd: number;
      spentMicroUsd: number;
      unresolvedMicroUsd: number;
      pricingBasis: string;
      state: string;
    }[];
    const budget = budgets[0];
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
