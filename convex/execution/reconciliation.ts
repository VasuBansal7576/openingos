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
import type { Id } from "../_generated/dataModel.js";

function receiptScopeMatches(
  receipt: { readonly organizationId?: Id<"organizations">; readonly projectId?: Id<"projects"> },
  operation: {
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
  },
): boolean {
  return receipt.organizationId === operation.organizationId && receipt.projectId === operation.projectId;
}

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
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", args.provider).eq("environment", args.environment).eq("eventId", args.eventId),
      )
      .unique();
    if (seen !== null) {
      if (
        !receiptScopeMatches(seen, { organizationId: args.organizationId, projectId: args.projectId }) ||
        seen.processingVersion !== args.processingVersion ||
        seen.outcome !== args.outcome
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "event receipt facts conflict" };
      }
      return { ok: true as const, deduplicated: true, outcome: seen.outcome };
    }
    await ctx.db.insert("processedEvents", {
      provider: args.provider,
      environment: args.environment,
      eventId: args.eventId,
      processingVersion: args.processingVersion,
      outcome: args.outcome,
      organizationId: args.organizationId,
      projectId: args.projectId,
      createdAt: Date.now(),
    });
    return { ok: true as const, deduplicated: false, outcome: args.outcome };
  },
});

/**
 * Internal: record a confirmed late delivery after cancellation. The job
 * keeps its cancelled state; the delivery is a separate recorded fact.
 *
 * The late delivery updates only the receipt (persisted provider event),
 * the operation state, and the attempt. An undetermined charge stays
 * reserved until the separate authoritative `reconcileActualCost`
 * transition settles it. Token and event binding hold even from
 * outcomeUnknown, the provider event persists with global dedupe, and
 * the attempt updates to the confirmed outcome.
 */
export const recordLateDelivery = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    token: v.string(),
    providerEventId: v.string(),
    provider: v.optional(v.string()),
    environment: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      jobState: v.string(),
      delivery: v.string(),
      deduplicated: v.boolean(),
    }),
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
    if (operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    if (args.providerEventId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "providerEventId required" };
    }
    const provider = args.provider ?? "controlled";
    const environment = args.environment ?? "controlled";
    const seen = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", provider).eq("environment", environment).eq("eventId", args.providerEventId),
      )
      .unique();
    const job = await ctx.db.get(operation.jobId);
    if (seen !== null) {
      if (!receiptScopeMatches(seen, operation)) {
        return { ok: false as const, code: "duplicate-conflict", message: "event receipt belongs to another project" };
      }
      if (seen.operationId !== undefined && seen.operationId !== args.operationId) {
        return { ok: false as const, code: "duplicate-conflict", message: "event receipt is bound to another operation" };
      }
      // A failure receipt is final. An unknown receipt can later gain an
      // authoritative success application, but the immutable receipt fact
      // itself is never rewritten.
      if (seen.outcome === "failure") {
        return { ok: false as const, code: "duplicate-conflict", message: "event receipt records failure" };
      }
      await ctx.db.patch(seen._id, {
        operationId: args.operationId,
        applicationOutcome: "success",
        applicationState: "observedSuccess",
        appliedAt: now,
      });
    } else {
      await ctx.db.insert("processedEvents", {
        provider,
        environment,
        eventId: args.providerEventId,
        processingVersion: 1,
        outcome: "success",
        organizationId: operation.organizationId,
        projectId: operation.projectId,
        operationId: args.operationId,
        applicationOutcome: "success",
        applicationState: "observedSuccess",
        appliedAt: now,
        createdAt: now,
      });
    }
    await ctx.db.patch(args.operationId, { state: "observedSuccess", updatedAt: now });
    // No fund movement here: unresolved allowance remains reserved until
    // `reconcileActualCost` authoritatively settles the real charge.
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .collect();
    for (const attempt of attempts) {
      if (attempt.operationId === args.operationId) {
        await ctx.db.patch(attempt._id, {
          state: "observedSuccess",
          observedAt: now,
          providerEventId: args.providerEventId,
          detail: "late-confirmation",
        });
      }
    }
    return {
      ok: true as const,
      jobState: job?.state ?? "unknown",
      delivery: "observedSuccess",
      deduplicated: false,
    };
  },
});

/**
 * Internal: authoritatively reconcile the actual provider cost for an
 * operation whose charge stayed undetermined. Moves exactly `actualSpentMicroUsd`
 * from the reservation's held allowance (reserved + unresolved) to spent
 * and releases the remainder back to the organization ledger. The
 * reservation closes exactly once; a repeat with the same settled state
 * is denied so allowance never moves twice.
 *
 * Reachable only from server-side reconciliation — browser callers can
 * never settle spend directly.
 */
export const reconcileActualCost = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    actualSpentMicroUsd: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      spentMicroUsd: v.number(),
      releasedMicroUsd: v.number(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.reservationId === undefined) {
      return { ok: false as const, code: "allowance-exhausted", message: "operation carries no reservation to reconcile" };
    }
    if (!Number.isSafeInteger(args.actualSpentMicroUsd) || args.actualSpentMicroUsd < 0) {
      return { ok: false as const, code: "invalid-payload", message: "actual spend must be a non-negative safe integer" };
    }
    const reservation = await ctx.db.get(operation.reservationId);
    if (reservation === null) {
      return { ok: false as const, code: "allowance-exhausted", message: "reservation is not available" };
    }
    if (reservation.jobId !== operation.jobId || reservation.organizationId !== operation.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const held = reservation.reservedMicroUsd + reservation.unresolvedMicroUsd;
    if (reservation.state === "closed" || held <= 0) {
      return { ok: false as const, code: "already-claimed", message: "reservation already reconciled" };
    }
    if (args.actualSpentMicroUsd > held) {
      return { ok: false as const, code: "invalid-payload", message: "actual spend exceeds the held allowance" };
    }
    const released = held - args.actualSpentMicroUsd;
    const budget = await ctx.db.get(reservation.budgetId);
    if (budget !== null) {
      await ctx.db.patch(reservation.budgetId, {
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - reservation.reservedMicroUsd),
        unresolvedMicroUsd: Math.max(0, budget.unresolvedMicroUsd - reservation.unresolvedMicroUsd),
        spentMicroUsd: budget.spentMicroUsd + args.actualSpentMicroUsd,
        updatedAt: now,
      });
    }
    await ctx.db.patch(operation.reservationId, {
      reservedMicroUsd: 0,
      unresolvedMicroUsd: 0,
      spentMicroUsd: reservation.spentMicroUsd + args.actualSpentMicroUsd,
      state: "closed",
      updatedAt: now,
    });
    return { ok: true as const, spentMicroUsd: args.actualSpentMicroUsd, releasedMicroUsd: released };
  },
});
