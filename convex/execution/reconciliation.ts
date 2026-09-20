/**
 * F1 event reconciliation and late-delivery separation (controlled contract).
 *
 * Signed provider events deduplicate by stable event ID before any product
 * effect. Cancellation and confirmed late delivery remain separate facts:
 * a cancelled job keeps its cancellation while a late-confirmed send is
 * recorded honestly on the operation.
 */

import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";

/** Ingest one provider event idempotently (duplicate has no second effect). */
export const ingestEvent = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    provider: v.string(),
    environment: v.string(),
    eventId: v.string(),
    processingVersion: v.number(),
    outcome: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), deduplicated: v.boolean(), outcome: v.string() }),
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
    if (args.eventId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "eventId required" };
    }
    const seen = (await ctx.db
      .query("processedEvents")
      .filter((q) =>
        q.and(
          q.eq(q.field("provider"), args.provider),
          q.eq(q.field("eventId"), args.eventId),
        ),
      )
      .unique()) as unknown as { outcome?: string } | null;
    if (seen) {
      return { ok: true as const, deduplicated: true, outcome: seen.outcome ?? "unknown" };
    }
    await ctx.db.insert("processedEvents", {
      provider: args.provider,
      environment: args.environment,
      eventId: args.eventId,
      processingVersion: args.processingVersion,
      outcome: args.outcome,
      createdAt: args.now,
    });
    return { ok: true as const, deduplicated: false, outcome: args.outcome };
  },
});

/**
 * Record a confirmed late delivery after cancellation. The job keeps its
 * cancelled state; the delivery is a separate recorded fact.
 */
export const recordLateDelivery = mutation({
  args: {
    operationId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    token: v.string(),
    providerEventId: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), jobState: v.string(), delivery: v.string() }),
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
    const operation = (await ctx.db.get(args.operationId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      jobId?: string;
      state?: string;
      attemptToken?: string;
      reservationId?: string;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    if (operation.state !== "dispatching" && operation.state !== "outcomeUnknown") {
      return { ok: false as const, code: "already-claimed", message: `operation is already ${operation.state}` };
    }
    if (operation.state === "dispatching" && operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    await ctx.db.patch(args.operationId as never, { state: "observedSuccess", updatedAt: args.now });
    if (operation.reservationId !== undefined) {
      const reservation = (await ctx.db.get(operation.reservationId as never)) as unknown as {
        budgetId?: string;
        reservedMicroUsd?: number;
        spentMicroUsd?: number;
      } | null;
      if (reservation) {
        const amount = reservation.reservedMicroUsd ?? 0;
        if (reservation.budgetId !== undefined) {
          const budget = (await ctx.db.get(reservation.budgetId as never)) as unknown as {
            reservedMicroUsd?: number;
            spentMicroUsd?: number;
          } | null;
          if (budget) {
            await ctx.db.patch(reservation.budgetId as never, {
              reservedMicroUsd: Math.max(0, (budget.reservedMicroUsd ?? 0) - amount),
              spentMicroUsd: (budget.spentMicroUsd ?? 0) + amount,
              updatedAt: args.now,
            });
          }
        }
        await ctx.db.patch(operation.reservationId as never, {
          reservedMicroUsd: 0,
          spentMicroUsd: (reservation.spentMicroUsd ?? 0) + amount,
          state: "closed",
          updatedAt: args.now,
        });
      }
    }
    const job = (await ctx.db.get((operation.jobId ?? "") as never)) as unknown as {
      state?: string;
    } | null;
    return {
      ok: true as const,
      jobState: job?.state ?? "unknown",
      delivery: "observedSuccess",
    };
  },
});
