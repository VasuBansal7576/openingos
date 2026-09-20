/**
 * F1 durable job lifecycle (controlled contract, ADR-0004).
 *
 * Job states: queued, running, waitingForSupplier, waitingForUser,
 * pausedBudget, completed, partial, failed, cancelled. Supplier waits
 * suspend work rather than keeping a provider loop alive. Cancellation
 * before the dispatch claim prevents the send; cancellation after the
 * claim prevents subsequent work but cannot unsend — reconciliation
 * exposes that outcome honestly.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { isExpired } from "../shared/time.js";
import { classifyScope, containsInstructionOverride } from "../shared/scope.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../access/checks.js";

const jobKindValidator = v.union(
  v.literal("research"),
  v.literal("communication"),
  v.literal("execution"),
);

const jobViewValidator = v.object({
  id: v.string(),
  organizationId: v.string(),
  projectId: v.string(),
  kind: v.string(),
  state: v.string(),
  grantVersion: v.number(),
  cancelledAt: v.optional(v.number()),
  cancelReason: v.optional(v.string()),
});

/**
 * Start a scope-gated job. Unrelated/unavailable requests are refused with
 * no job; supplier-evidence instructions cannot expand capabilities.
 */
export const start = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    text: v.string(),
    operationId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    grantId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), jobId: v.string(), state: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    if (containsInstructionOverride(args.text)) {
      return { ok: false as const, code: "prompt-injection-denied", message: "supplier evidence cannot expand capabilities" };
    }
    const classified = classifyScope({
      text: args.text,
      ...(args.operationId === undefined ? {} : { operationId: args.operationId }),
    });
    if (classified.verdict === "unrelatedRefused") {
      return { ok: false as const, code: "unrelated-refusal", message: classified.reason };
    }
    if (classified.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: classified.reason };
    }
    const operationId = classified.operationId;
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability(operationId, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }

    const kind = args.kind ?? "research";
    let grantId = args.grantId;
    let grantVersion = 0;
    let inputVersions: Record<string, string> = {};
    if (kind === "communication") {
      if (grantId === undefined) {
        return { ok: false as const, code: "denied-capability", message: "communication requires a grant" };
      }
      const grant = (await ctx.db.get(grantId as never)) as unknown as {
        organizationId?: string;
        projectId?: string;
        status?: string;
        expiresAt?: number;
        revocationVersion?: number;
        inputVersions?: Record<string, string>;
      } | null;
      if (!grant || grant.organizationId !== args.organizationId || grant.projectId !== args.projectId) {
        return { ok: false as const, code: "denied-project", message: "grant is not in this project" };
      }
      if (grant.status !== "active") {
        return { ok: false as const, code: "revoked-grant", message: "grant is not active" };
      }
      if (grant.expiresAt !== undefined && isExpired(args.now, grant.expiresAt)) {
        return { ok: false as const, code: "expired-grant", message: "grant expired" };
      }
      grantVersion = grant.revocationVersion ?? 1;
      inputVersions = { ...(grant.inputVersions ?? {}) };
    } else if (grantId !== undefined) {
      const grant = (await ctx.db.get(grantId as never)) as unknown as {
        revocationVersion?: number;
        inputVersions?: Record<string, string>;
      } | null;
      if (grant) {
        grantVersion = grant.revocationVersion ?? 1;
        inputVersions = { ...(grant.inputVersions ?? {}) };
      }
    }

    const jobId = await ctx.db.insert("jobs", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      grantId: (grantId ?? "") as never,
      grantVersion,
      kind,
      state: "queued",
      inputVersions,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { ok: true as const, jobId: jobId as unknown as string, state: "queued" };
  },
});

/** Cancel a job: undispatched work stops; in-flight work reconciles. */
export const cancel = mutation({
  args: {
    jobId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), unresolvedOperationIds: v.array(v.string()) }),
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
    const job = (await ctx.db.get(args.jobId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
    } | null;
    if (!job || job.organizationId !== args.organizationId || job.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "job is not in this project" };
    }
    const operations = (await ctx.db
      .query("operations")
      .filter((q) => q.eq(q.field("jobId"), args.jobId))
      .collect()) as unknown as { _id: string; state: string }[];
    const unresolved: string[] = [];
    for (const operation of operations) {
      if (operation.state === "prepared") {
        await ctx.db.patch(operation._id as never, { state: "cancelled", updatedAt: args.now });
      } else if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
        unresolved.push(operation._id);
      }
    }
    await ctx.db.patch(args.jobId as never, {
      state: "cancelled",
      cancelledAt: args.now,
      cancelReason: args.reason,
      updatedAt: args.now,
    });
    return { ok: true as const, state: "cancelled", unresolvedOperationIds: unresolved };
  },
});

/** Read one authorized job. */
export const get = query({
  args: {
    jobId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    now: v.number(),
  },
  returns: v.union(jobViewValidator.extend({ ok: v.literal(true) }), denialValidator),
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
    const job = (await ctx.db.get(args.jobId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      kind?: string;
      state?: string;
      grantVersion?: number;
      cancelledAt?: number;
      cancelReason?: string;
    } | null;
    if (!job || job.organizationId !== args.organizationId || job.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "job is not in this project" };
    }
    return {
      ok: true as const,
      id: args.jobId,
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: job.kind ?? "research",
      state: job.state ?? "queued",
      grantVersion: job.grantVersion ?? 0,
      ...(job.cancelledAt === undefined ? {} : { cancelledAt: job.cancelledAt }),
      ...(job.cancelReason === undefined ? {} : { cancelReason: job.cancelReason }),
    };
  },
});
