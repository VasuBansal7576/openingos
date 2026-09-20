/**
 * F1 durable job lifecycle (controlled contract, ADR-0004).
 *
 * Job states: queued, running, waitingForSupplier, waitingForUser,
 * pausedBudget, completed, partial, failed, cancelled. Supplier waits
 * suspend work rather than keeping a provider loop alive. Cancellation
 * before the dispatch claim prevents the send; cancellation after the
 * claim prevents subsequent work but cannot unsend — reconciliation
 * exposes that outcome honestly. Identity and time are server-derived;
 * callers supply neither.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { canonicalJson, payloadHash } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";
import { classifyScope, containsInstructionOverride } from "../shared/scope.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../access/checks.js";

const jobKindValidator = v.union(
  v.literal("research"),
  v.literal("communication"),
  v.literal("execution"),
);

const jobViewValidator = v.object({
  id: v.id("jobs"),
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  kind: v.string(),
  state: v.string(),
  grantVersion: v.number(),
  cancelledAt: v.optional(v.number()),
  cancelReason: v.optional(v.string()),
});

/**
 * Start a scope-gated job. Unrelated/unavailable requests are refused with
 * no job; supplier-evidence instructions cannot expand capabilities.
 * Research jobs without an explicit grant receive a server-bound
 * no-spend grant so the job always carries a versioned authority.
 */
export const start = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    text: v.string(),
    operationId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    grantId: v.optional(v.id("grants")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), jobId: v.id("jobs"), state: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
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
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability(operationId, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }

    const kind = args.kind ?? "research";
    let grantId: Id<"grants"> | undefined = args.grantId;
    let grantVersion = 0;
    let inputVersions: Record<string, string> = {};
    if (kind === "communication") {
      if (grantId === undefined) {
        return { ok: false as const, code: "denied-capability", message: "communication requires a grant" };
      }
      const grant = await ctx.db.get(grantId);
      if (
        grant === null ||
        grant.organizationId !== args.organizationId ||
        grant.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      if (grant.status !== "active") {
        return { ok: false as const, code: "revoked-grant", message: "grant is not active" };
      }
      if (isExpired(now, grant.expiresAt)) {
        return { ok: false as const, code: "expired-grant", message: "grant expired" };
      }
      grantVersion = grant.revocationVersion;
      inputVersions = { ...grant.inputVersions };
    } else if (grantId !== undefined) {
      const grant = await ctx.db.get(grantId);
      if (grant !== null) {
        grantVersion = grant.revocationVersion;
        inputVersions = { ...grant.inputVersions };
      }
    } else {
      const recipient = await ctx.db
        .query("recipientConfigs")
        .withIndex("by_active", (q) => q.eq("active", true))
        .unique();
      const autoPayload = { research: "bounded-server-grant" };
      const autoCanonical = canonicalJson(autoPayload);
      grantId = await ctx.db.insert("grants", {
        organizationId: args.organizationId,
        projectId: args.projectId,
        operations: [operationId],
        communicationProfile: "ownerRoleplay",
        recipientConfigVersion: recipient?.version ?? 0,
        inputVersions: {},
        canonicalPayload: autoCanonical,
        payloadHash: payloadHash(autoPayload),
        payloadSha256: await sha256HexOfCanonical(autoCanonical),
        costCeilingMicroUsd: 0,
        roundLimit: 0,
        expiresAt: now + 900_000,
        revocationVersion: 1,
        status: "active",
        createdAt: now,
      });
      grantVersion = 1;
    }

    const jobId = await ctx.db.insert("jobs", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      grantId,
      grantVersion,
      kind,
      state: "queued",
      inputVersions,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, jobId, state: "queued" };
  },
});

/** Cancel a job: undispatched work stops; in-flight work reconciles. */
export const cancel = f1Mutation({
  args: { jobId: v.id("jobs"), reason: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), unresolvedOperationIds: v.array(v.id("operations")) }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      job.organizationId,
      job.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const operations = await ctx.db
      .query("operations")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    const unresolved: Id<"operations">[] = [];
    for (const operation of operations) {
      if (operation.state === "prepared") {
        await ctx.db.patch(operation._id, { state: "cancelled", updatedAt: now });
      } else if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
        unresolved.push(operation._id);
      }
    }
    await ctx.db.patch(args.jobId, {
      state: "cancelled",
      cancelledAt: now,
      cancelReason: args.reason,
      updatedAt: now,
    });
    return { ok: true as const, state: "cancelled", unresolvedOperationIds: unresolved };
  },
});

/** Read one authorized job. */
export const get = f1Query({
  args: { jobId: v.id("jobs") },
  returns: v.union(jobViewValidator.extend({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      job.organizationId,
      job.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return {
      ok: true as const,
      id: args.jobId,
      organizationId: job.organizationId,
      projectId: job.projectId,
      kind: job.kind,
      state: job.state,
      grantVersion: job.grantVersion,
      ...(job.cancelledAt === undefined ? {} : { cancelledAt: job.cancelledAt }),
      ...(job.cancelReason === undefined ? {} : { cancelReason: job.cancelReason }),
    };
  },
});
