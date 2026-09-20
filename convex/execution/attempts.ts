/**
 * F1 attempts, outcomes, and crash/replay reconciliation (controlled contract).
 *
 * Attempts record prepared/dispatching/observedSuccess/observedFailure/
 * outcomeUnknown separately from job state. Process/response loss and
 * workflow replay reconcile to `outcomeUnknown` without an automatic second
 * send; an explicit reviewed resend creates a linked new operation. Unknown
 * charges remain reserved after failure.
 *
 * Visibility: outcome recording, crash reconciliation, and reviewed resend
 * are internal executor transitions. Browser token possession never
 * authorizes success — outcomes arrive only through server-side dispatch
 * and provider reconciliation. `attemptsForOperation` is an authorized
 * read with no product effect.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, f1Query, type F1MutationCtx } from "../server.js";
import { requestKey } from "../shared/hashing.js";
import {
  MAX_OPERATIONS_PER_GRANT,
  MAX_OPERATIONS_PER_JOB,
} from "../shared/scope.js";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";

const outcomeValidator = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("unknown"),
);

async function settleReservation(
  ctx: F1MutationCtx,
  reservationId: Id<"reservations">,
  mode: "spend" | "release" | "retainUnknown",
  now: number,
): Promise<void> {
  const reservation = await ctx.db.get(reservationId);
  if (reservation === null) return;
  const amount = reservation.reservedMicroUsd;
  const budget = await ctx.db.get(reservation.budgetId);
  if (budget !== null) {
    if (mode === "spend") {
      await ctx.db.patch(reservation.budgetId, {
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        spentMicroUsd: budget.spentMicroUsd + amount,
        updatedAt: now,
      });
    } else if (mode === "retainUnknown") {
      await ctx.db.patch(reservation.budgetId, {
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        unresolvedMicroUsd: budget.unresolvedMicroUsd + amount,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(reservation.budgetId, {
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        updatedAt: now,
      });
    }
  }
  if (mode === "spend") {
    await ctx.db.patch(reservation._id, {
      reservedMicroUsd: 0,
      spentMicroUsd: reservation.spentMicroUsd + amount,
      state: "closed",
      updatedAt: now,
    });
  } else if (mode === "retainUnknown") {
    await ctx.db.patch(reservation._id, {
      reservedMicroUsd: 0,
      unresolvedMicroUsd: reservation.unresolvedMicroUsd + amount,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(reservation._id, {
      reservedMicroUsd: 0,
      state: "closed",
      updatedAt: now,
    });
  }
}

type AppliedOutcome = "success" | "failure" | "unknown";
type AppliedState = "observedSuccess" | "observedFailure" | "outcomeUnknown";

function appliedOutcome(outcome: "success" | "failure" | "unknown", unknownCharges: boolean | undefined): AppliedOutcome {
  if (outcome === "unknown" || (outcome === "failure" && unknownCharges === true)) return "unknown";
  return outcome;
}

function appliedState(outcome: AppliedOutcome): AppliedState {
  if (outcome === "success") return "observedSuccess";
  if (outcome === "failure") return "observedFailure";
  return "outcomeUnknown";
}

function receiptScopeMatches(
  receipt: { readonly organizationId?: Id<"organizations">; readonly projectId?: Id<"projects"> },
  operation: { readonly organizationId: Id<"organizations">; readonly projectId: Id<"projects"> },
): boolean {
  return receipt.organizationId === operation.organizationId && receipt.projectId === operation.projectId;
}

async function applyOutcome(
  ctx: F1MutationCtx,
  operation: {
    readonly _id: Id<"operations">;
    readonly reservationId?: Id<"reservations">;
  },
  args: {
    readonly outcome: "success" | "failure" | "unknown";
    readonly unknownCharges?: boolean;
    readonly providerEventId?: string;
    readonly detail?: string;
    readonly token: string;
  },
  now: number,
): Promise<AppliedState> {
  const outcome = appliedOutcome(args.outcome, args.unknownCharges);
  const state = appliedState(outcome);
  if (state === "outcomeUnknown") {
    if (operation.reservationId !== undefined) await settleReservation(ctx, operation.reservationId, "retainUnknown", now);
  } else if (state === "observedFailure") {
    if (operation.reservationId !== undefined) await settleReservation(ctx, operation.reservationId, "release", now);
  } else if (operation.reservationId !== undefined) {
    await settleReservation(ctx, operation.reservationId, "spend", now);
  }
  await ctx.db.patch(operation._id, { state, updatedAt: now });
  const attempts = await ctx.db
    .query("attempts")
    .withIndex("by_token", (q) => q.eq("token", args.token))
    .collect();
  for (const attempt of attempts) {
    if (attempt.operationId === operation._id) {
      await ctx.db.patch(attempt._id, {
        state,
        observedAt: now,
        ...(args.providerEventId === undefined ? {} : { providerEventId: args.providerEventId }),
        ...(args.detail === undefined ? {} : { detail: args.detail }),
      });
    }
  }
  return state;
}

/**
 * Internal: record a validated provider outcome for a claimed token.
 *
 * F1-20: provider events dedupe GLOBALLY by provider, environment, and
 * event ID. A duplicate event returns the recorded outcome with zero new
 * effect — it never settles a second outcome, spends budget, or touches
 * another operation. The response carries only the coarse outcome, so a
 * duplicate from another tenant leaks nothing.
 */
export const recordOutcome = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    token: v.string(),
    outcome: outcomeValidator,
    provider: v.optional(v.string()),
    environment: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    unknownCharges: v.optional(v.boolean()),
    detail: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), deduplicated: v.boolean(), outcome: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.state !== "dispatching" || operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    const provider = args.provider ?? "controlled";
    const environment = args.environment ?? "controlled";
    if (args.providerEventId !== undefined) {
      if (args.providerEventId.trim().length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "providerEventId required" };
      }
      const seen = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_event", (q) =>
          q
            .eq("provider", provider)
            .eq("environment", environment)
            .eq("eventId", args.providerEventId ?? ""),
        )
        .unique();
      if (seen !== null) {
        const effective = appliedOutcome(args.outcome, args.unknownCharges);
        if (!receiptScopeMatches(seen, operation)) {
          return { ok: false as const, code: "duplicate-conflict", message: "event receipt belongs to another project" };
        }
        if (seen.outcome !== args.outcome || (seen.applicationOutcome !== undefined && seen.applicationOutcome !== effective)) {
          return { ok: false as const, code: "duplicate-conflict", message: "event receipt facts conflict" };
        }
        if (seen.operationId === args.operationId) {
          return { ok: true as const, state: operation.state, deduplicated: true, outcome: seen.outcome };
        }
        if (seen.operationId !== undefined) {
          return { ok: false as const, code: "duplicate-conflict", message: "event receipt is bound to another operation" };
        }
        await ctx.db.patch(seen._id, {
          operationId: args.operationId,
          applicationOutcome: effective,
          applicationState: appliedState(effective),
          appliedAt: now,
        });
      } else {
        const effective = appliedOutcome(args.outcome, args.unknownCharges);
        await ctx.db.insert("processedEvents", {
          provider,
          environment,
          eventId: args.providerEventId,
          processingVersion: 1,
          outcome: args.outcome,
          organizationId: operation.organizationId,
          projectId: operation.projectId,
          operationId: args.operationId,
          applicationOutcome: effective,
          applicationState: appliedState(effective),
          appliedAt: now,
          createdAt: now,
        });
      }
    }
    const state = await applyOutcome(ctx, operation, args, now);
    return { ok: true as const, state, deduplicated: false, outcome: args.outcome };
  },
});

/**
 * Internal: reconcile after process loss. An abandoned `dispatching`
 * operation becomes `outcomeUnknown`. Never resends; never invents success.
 */
export const reconcileAfterCrash = f1InternalMutation({
  args: { operationId: v.id("operations") },
  returns: v.union(
    v.object({ ok: v.literal(true), reconciled: v.boolean(), state: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.state !== "dispatching") {
      return { ok: true as const, reconciled: false, state: operation.state };
    }
    const now = Date.now();
    await ctx.db.patch(args.operationId, { state: "outcomeUnknown", updatedAt: now });
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .collect();
    for (const attempt of attempts) {
      if (attempt.state === "dispatching") {
        await ctx.db.patch(attempt._id, {
          state: "outcomeUnknown",
          observedAt: now,
          detail: "crash-reconciliation",
        });
      }
    }
    return { ok: true as const, reconciled: true, state: "outcomeUnknown" };
  },
});

/**
 * Internal: explicit reviewed resend. Creates a linked new operation with a
 * fresh requestId and warns that the prior attempt may still complete. The
 * resend never inherits the old reservation: while prior unknown exposure
 * remains, a fresh open reservation for the same job is required, otherwise
 * the resend is denied and the exposure stays locked.
 */
export const reviewedResend = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    newRequestId: v.string(),
    newReservationId: v.optional(v.id("reservations")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), operationId: v.id("operations"), warning: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      "approver",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const job = await ctx.db.get(operation.jobId);
    if (
      job === null ||
      job.organizationId !== operation.organizationId ||
      job.projectId !== operation.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (job.state === "cancelling" || job.state === "cancelled") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    if (operation.state !== "outcomeUnknown") {
      return { ok: false as const, code: "already-claimed", message: "only an ambiguous operation may be resent after review" };
    }
    if (args.newRequestId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "resend requestId required" };
    }
    const key = requestKey(operation.organizationId, operation.kind, args.newRequestId);
    const clash = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .unique();
    if (clash !== null) {
      return { ok: false as const, code: "duplicate-conflict", message: "resend requestId is already in use" };
    }
    const grant = await ctx.db.get(operation.grantId);
    // F1R-22: a reviewed resend is a new operation, so the existing finite
    // admission contract binds before insertion. Operation 65 under one
    // grant (or one job) is refused here with zero new effect. Both reads
    // are bounded takes; the bounded page is the complete set whenever both
    // checks pass, which is what makes the round accounting below exact.
    const grantOperations = await ctx.db
      .query("operations")
      .withIndex("by_grant", (q) => q.eq("grantId", operation.grantId))
      .take(MAX_OPERATIONS_PER_GRANT + 1);
    if (grantOperations.length >= MAX_OPERATIONS_PER_GRANT) {
      return { ok: false as const, code: "operation-admission-limit", message: "grant operation admission limit reached" };
    }
    const jobOperations = await ctx.db
      .query("operations")
      .withIndex("by_job", (q) => q.eq("jobId", operation.jobId))
      .take(MAX_OPERATIONS_PER_JOB + 1);
    if (jobOperations.length >= MAX_OPERATIONS_PER_JOB) {
      return { ok: false as const, code: "operation-admission-limit", message: "job operation admission limit reached" };
    }
    if (grant !== null) {
      const roundsUsed = grantOperations.filter(
        (entry) => entry.state !== "cancelled" && entry.state !== "denied",
      ).length;
      if (roundsUsed >= grant.roundLimit) {
        return { ok: false as const, code: "round-limit-exceeded", message: "grant round limit exhausted" };
      }
    }
    // A reviewed resend always carries its own fresh reservation: the
    // resend never inherits the old reservation, and while prior unknown
    // exposure remains the old allowance stays locked. The fresh
    // reservation is fully bound to this job, organization, and budget.
    if (args.newReservationId === undefined) {
      return { ok: false as const, code: "unknown-charges-reserved", message: "resend requires its own fresh reservation" };
    }
    const fresh = await ctx.db.get(args.newReservationId);
    if (fresh === null || fresh.state !== "open") {
      return { ok: false as const, code: "allowance-exhausted", message: "fresh reservation is not available for this job" };
    }
    if (fresh.jobId !== operation.jobId) {
      return { ok: false as const, code: "allowance-exhausted", message: "fresh reservation does not belong to this job" };
    }
    if (fresh.organizationId !== operation.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const freshBudget = await ctx.db.get(fresh.budgetId);
    if (freshBudget === null || freshBudget.organizationId !== operation.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const freshSiblings = jobOperations;
    const freshBound = freshSiblings.some(
      (sibling) =>
        sibling.reservationId === args.newReservationId &&
        sibling.state !== "cancelled" &&
        sibling.state !== "denied",
    );
    if (freshBound) {
      return { ok: false as const, code: "allowance-exhausted", message: "fresh reservation is already bound to another operation" };
    }
    const resendReservationId: typeof operation.reservationId = args.newReservationId;
    const freshId = await ctx.db.insert("operations", {
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      jobId: operation.jobId,
      kind: operation.kind,
      requestId: args.newRequestId,
      requestKey: key,
      normalizedPayload: operation.normalizedPayload,
      normalizedPayloadHash: operation.normalizedPayloadHash,
      ...(operation.payloadSha256 === undefined ? {} : { payloadSha256: operation.payloadSha256 }),
      inputVersions: { ...operation.inputVersions },
      grantId: operation.grantId,
      grantVersion: operation.grantVersion,
      ...(operation.recipientConfigVersion === undefined
        ? {}
        : { recipientConfigVersion: operation.recipientConfigVersion }),
      ...(operation.conversationVersion === undefined
        ? {}
        : { conversationVersion: operation.conversationVersion }),
      state: "prepared",
      ...(resendReservationId === undefined ? {} : { reservationId: resendReservationId }),
      linkedResendOf: args.operationId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      ok: true as const,
      operationId: freshId,
      warning: "prior attempt outcome remains unknown; resend may duplicate the external effect",
    };
  },
});

/** Attempts for one authorized operation (read-only, no authority). */
export const attemptsForOperation = f1Query({
  args: { operationId: v.id("operations") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      attempts: v.array(v.object({ token: v.string(), state: v.string() })),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      operation.organizationId,
      operation.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .collect();
    return {
      ok: true as const,
      attempts: attempts.map((attempt) => ({ token: attempt.token, state: attempt.state })),
    };
  },
});
