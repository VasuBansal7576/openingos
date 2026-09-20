/**
 * F1 event reconciliation and late-delivery separation (controlled contract).
 *
 * Signed provider events deduplicate by stable event ID before any product
 * effect. Cancellation and confirmed late delivery remain separate facts:
 * a cancelled job keeps its cancellation while a late-confirmed send is
 * recorded honestly on the operation.
 *
 * Visibility: both transitions are internal executor work. `ingestEvent`
 * runs from the verified provider webhook path and `recordLateDelivery`
 * from server-side reconciliation — browser callers reach neither, so a
 * forged identity or a bare attempt token can never record success.
 */

import { v } from "convex/values";
import { f1InternalMutation } from "../server.js";
import { denialValidator } from "../access/checks.js";

/** Internal: ingest one provider event idempotently. */
export const ingestEvent = f1InternalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    provider: v.string(),
    environment: v.string(),
    eventId: v.string(),
    processingVersion: v.number(),
    outcome: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), deduplicated: v.boolean(), outcome: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (args.eventId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "eventId required" };
    }
    const seen = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_and_event", (q) =>
        q.eq("provider", args.provider).eq("eventId", args.eventId),
      )
      .unique();
    if (seen !== null) {
      return { ok: true as const, deduplicated: true, outcome: seen.outcome };
    }
    await ctx.db.insert("processedEvents", {
      provider: args.provider,
      environment: args.environment,
      eventId: args.eventId,
      processingVersion: args.processingVersion,
      outcome: args.outcome,
      createdAt: Date.now(),
    });
    return { ok: true as const, deduplicated: false, outcome: args.outcome };
  },
});

/**
 * Internal: record a confirmed late delivery after cancellation. The job
 * keeps its cancelled state; the delivery is a separate recorded fact.
 */
export const recordLateDelivery = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    token: v.string(),
    providerEventId: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), jobState: v.string(), delivery: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.state !== "dispatching" && operation.state !== "outcomeUnknown") {
      return { ok: false as const, code: "already-claimed", message: `operation is already ${operation.state}` };
    }
    if (operation.state === "dispatching" && operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    await ctx.db.patch(args.operationId, { state: "observedSuccess", updatedAt: now });
    if (operation.reservationId !== undefined) {
      const reservation = await ctx.db.get(operation.reservationId);
      if (reservation !== null) {
        const amount = reservation.reservedMicroUsd;
        const budget = await ctx.db.get(reservation.budgetId);
        if (budget !== null) {
          await ctx.db.patch(reservation.budgetId, {
            reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
            spentMicroUsd: budget.spentMicroUsd + amount,
            updatedAt: now,
          });
        }
        await ctx.db.patch(operation.reservationId, {
          reservedMicroUsd: 0,
          spentMicroUsd: reservation.spentMicroUsd + amount,
          state: "closed",
          updatedAt: now,
        });
      }
    }
    const job = await ctx.db.get(operation.jobId);
    return {
      ok: true as const,
      jobState: job?.state ?? "unknown",
      delivery: "observedSuccess",
    };
  },
});
