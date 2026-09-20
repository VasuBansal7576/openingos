/**
 * F1 attempts, outcomes, and crash/replay reconciliation (controlled contract).
 *
 * Attempts record prepared/dispatching/observedSuccess/observedFailure/
 * outcomeUnknown separately from job state. Process/response loss and
 * workflow replay reconcile to `outcomeUnknown` without an automatic second
 * send; an explicit reviewed resend creates a linked new operation. Unknown
 * charges remain reserved after failure.
 */

import { mutation, query, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { requestKey } from "../shared/hashing.js";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";

const outcomeValidator = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("unknown"),
);

async function settleReservation(
  ctx: MutationCtx,
  reservationId: string,
  mode: "spend" | "release" | "retainUnknown",
  now: number,
): Promise<void> {
  const reservation = (await ctx.db.get(reservationId as never)) as unknown as {
    budgetId?: string;
    reservedMicroUsd?: number;
    spentMicroUsd?: number;
    unresolvedMicroUsd?: number;
  } | null;
  if (!reservation) return;
  const amount = reservation.reservedMicroUsd ?? 0;
  if (reservation.budgetId !== undefined) {
    const budget = (await ctx.db.get(reservation.budgetId as never)) as unknown as {
      reservedMicroUsd?: number;
      spentMicroUsd?: number;
      unresolvedMicroUsd?: number;
    } | null;
    if (budget) {
      if (mode === "spend") {
        await ctx.db.patch(reservation.budgetId as never, {
          reservedMicroUsd: Math.max(0, (budget.reservedMicroUsd ?? 0) - amount),
          spentMicroUsd: (budget.spentMicroUsd ?? 0) + amount,
          updatedAt: now,
        });
      } else if (mode === "retainUnknown") {
        await ctx.db.patch(reservation.budgetId as never, {
          reservedMicroUsd: Math.max(0, (budget.reservedMicroUsd ?? 0) - amount),
          unresolvedMicroUsd: (budget.unresolvedMicroUsd ?? 0) + amount,
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(reservation.budgetId as never, {
          reservedMicroUsd: Math.max(0, (budget.reservedMicroUsd ?? 0) - amount),
          updatedAt: now,
        });
      }
    }
  }
  if (mode === "spend") {
    await ctx.db.patch(reservationId as never, {
      reservedMicroUsd: 0,
      spentMicroUsd: (reservation.spentMicroUsd ?? 0) + amount,
      state: "closed",
      updatedAt: now,
    });
  } else if (mode === "retainUnknown") {
    await ctx.db.patch(reservationId as never, {
      reservedMicroUsd: 0,
      unresolvedMicroUsd: (reservation.unresolvedMicroUsd ?? 0) + amount,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(reservationId as never, {
      reservedMicroUsd: 0,
      state: "closed",
      updatedAt: now,
    });
  }
}

/** Record a validated provider outcome for a claimed attempt token. */
export const recordOutcome = mutation({
  args: {
    operationId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    token: v.string(),
    outcome: outcomeValidator,
    providerEventId: v.optional(v.string()),
    unknownCharges: v.optional(v.boolean()),
    detail: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), deduplicated: v.boolean() }),
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
      state?: string;
      attemptToken?: string;
      reservationId?: string;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    if (operation.state !== "dispatching" || operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    let deduplicated = false;
    if (args.providerEventId !== undefined) {
      const seen = (await ctx.db
        .query("processedEvents")
        .filter((q) =>
          q.and(
            q.eq(q.field("provider"), "controlled"),
            q.eq(q.field("eventId"), args.providerEventId as string),
          ),
        )
        .unique()) as unknown as { _id: string } | null;
      if (seen) {
        deduplicated = true;
      } else {
        await ctx.db.insert("processedEvents", {
          provider: "controlled",
          environment: "controlled",
          eventId: args.providerEventId,
          processingVersion: 1,
          outcome: args.outcome,
          createdAt: args.now,
        });
      }
    }
    let state = "observedSuccess";
    if (args.outcome === "unknown" || (args.outcome === "failure" && args.unknownCharges === true)) {
      state = "outcomeUnknown";
      if (operation.reservationId !== undefined) {
        await settleReservation(ctx, operation.reservationId, "retainUnknown", args.now);
      }
    } else if (args.outcome === "failure") {
      state = "observedFailure";
      if (operation.reservationId !== undefined) {
        await settleReservation(ctx, operation.reservationId, "release", args.now);
      }
    } else if (operation.reservationId !== undefined) {
      await settleReservation(ctx, operation.reservationId, "spend", args.now);
    }
    await ctx.db.patch(args.operationId as never, { state, updatedAt: args.now });
    const attempts = (await ctx.db
      .query("attempts")
      .filter((q) => q.eq(q.field("token"), args.token))
      .collect()) as unknown as { _id: string; operationId: string }[];
    for (const attempt of attempts) {
      if (String(attempt.operationId) === String(args.operationId)) {
        await ctx.db.patch(attempt._id as never, {
          state,
          observedAt: args.now,
          ...(args.providerEventId === undefined ? {} : { providerEventId: args.providerEventId }),
          ...(args.detail === undefined ? {} : { detail: args.detail }),
        });
      }
    }
    return { ok: true as const, state, deduplicated };
  },
});

/**
 * Reconcile after process loss: an abandoned `dispatching` operation becomes
 * `outcomeUnknown`. Never resends; never invents success.
 */
export const reconcileAfterCrash = mutation({
  args: {
    operationId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), reconciled: v.boolean(), state: v.string() }),
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
      state?: string;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    if (operation.state !== "dispatching") {
      return { ok: true as const, reconciled: false, state: operation.state ?? "unknown" };
    }
    await ctx.db.patch(args.operationId as never, { state: "outcomeUnknown", updatedAt: args.now });
    const attempts = (await ctx.db
      .query("attempts")
      .filter((q) => q.eq(q.field("operationId"), args.operationId))
      .collect()) as unknown as { _id: string; state: string }[];
    for (const attempt of attempts) {
      if (attempt.state === "dispatching") {
        await ctx.db.patch(attempt._id as never, {
          state: "outcomeUnknown",
          observedAt: args.now,
          detail: "crash-reconciliation",
        });
      }
    }
    return { ok: true as const, reconciled: true, state: "outcomeUnknown" };
  },
});

/**
 * Explicit reviewed resend: creates a linked new operation with a fresh
 * requestId and warns that the prior attempt may still complete.
 */
export const reviewedResend = mutation({
  args: {
    operationId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    newRequestId: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), operationId: v.string(), warning: v.string() }),
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
      "approver",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const operation = (await ctx.db.get(args.operationId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      jobId?: string;
      kind?: string;
      state?: string;
      normalizedPayload?: string;
      normalizedPayloadHash?: string;
      payloadSha256?: string;
      inputVersions?: Record<string, string>;
      grantId?: string;
      grantVersion?: number;
      recipientConfigVersion?: number;
      conversationVersion?: number;
      reservationId?: string;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    if (operation.state !== "outcomeUnknown") {
      return { ok: false as const, code: "already-claimed", message: "only an ambiguous operation may be resent after review" };
    }
    if (args.newRequestId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "resend requestId required" };
    }
    const key = requestKey(args.organizationId, operation.kind ?? "", args.newRequestId);
    const clash = (await ctx.db
      .query("operations")
      .filter((q) => q.eq(q.field("requestKey"), key))
      .unique()) as unknown as { _id: string } | null;
    if (clash) {
      return { ok: false as const, code: "duplicate-conflict", message: "resend requestId is already in use" };
    }
    const freshId = await ctx.db.insert("operations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      jobId: operation.jobId as never,
      kind: operation.kind ?? "",
      requestId: args.newRequestId,
      requestKey: key,
      normalizedPayload: operation.normalizedPayload ?? "",
      normalizedPayloadHash: operation.normalizedPayloadHash ?? "",
      ...(operation.payloadSha256 === undefined ? {} : { payloadSha256: operation.payloadSha256 }),
      inputVersions: { ...(operation.inputVersions ?? {}) },
      grantId: operation.grantId as never,
      grantVersion: operation.grantVersion ?? 1,
      ...(operation.recipientConfigVersion === undefined
        ? {}
        : { recipientConfigVersion: operation.recipientConfigVersion }),
      ...(operation.conversationVersion === undefined
        ? {}
        : { conversationVersion: operation.conversationVersion }),
      state: "prepared",
      ...(operation.reservationId === undefined ? {} : { reservationId: operation.reservationId as never }),
      linkedResendOf: args.operationId as never,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      ok: true as const,
      operationId: freshId as unknown as string,
      warning: "prior attempt outcome remains unknown; resend may duplicate the external effect",
    };
  },
});

/** Attempts for one authorized operation (read-only, no authority). */
export const attemptsForOperation = query({
  args: { operationId: v.string(), organizationId: v.string(), projectId: v.string(), now: v.number() },
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
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const attempts = (await ctx.db
      .query("attempts")
      .filter((q) => q.eq(q.field("operationId"), args.operationId))
      .collect()) as unknown as { token: string; state: string }[];
    return {
      ok: true as const,
      attempts: attempts.map((attempt) => ({ token: attempt.token, state: attempt.state })),
    };
  },
});
