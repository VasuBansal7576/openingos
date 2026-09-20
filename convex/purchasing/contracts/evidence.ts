/**
 * F1 evidence, files, and provider identifiers (controlled contract).
 *
 * Evidence snapshots carry source kind, capture time, hash, completeness,
 * and controlled provenance. Provider IDs are opaque correlation data,
 * never authorization. Completeness (complete/partial/unavailable) is
 * separate from claim verification; omitted terms are never treated as
 * absent.
 */

import { mutation, query } from "../../_generated/server";
import { v } from "convex/values";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../../access/checks.js";

const completenessValidator = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unavailable"),
);

const executionModeValidator = v.union(
  v.literal("live"),
  v.literal("recorded"),
  v.literal("fixture"),
);

/** Record an evidence snapshot under project authority. */
export const record = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    sourceKind: v.string(),
    sourceUrl: v.optional(v.string()),
    providerIds: v.optional(v.string()),
    contentHash: v.string(),
    completeness: completenessValidator,
    counterpartyRole: v.string(),
    executionMode: executionModeValidator,
    locator: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), evidenceId: v.string() }),
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
    const capability = requireCapability("evidence.record", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    if (args.contentHash.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "contentHash required" };
    }
    const evidenceId = await ctx.db.insert("evidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      sourceKind: args.sourceKind,
      ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
      ...(args.providerIds === undefined ? {} : { providerIds: args.providerIds }),
      capturedAt: args.now,
      contentHash: args.contentHash,
      completeness: args.completeness,
      counterpartyRole: args.counterpartyRole,
      executionMode: args.executionMode,
      ...(args.locator === undefined ? {} : { locator: args.locator }),
    });
    return { ok: true as const, evidenceId: evidenceId as unknown as string };
  },
});

/** Attach a file record to evidence in the same project. */
export const recordFile = mutation({
  args: {
    evidenceId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    storageRef: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), fileId: v.string() }),
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
    const evidence = (await ctx.db.get(args.evidenceId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
    } | null;
    if (!evidence || evidence.organizationId !== args.organizationId || evidence.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "evidence is not in this project" };
    }
    const fileId = await ctx.db.insert("files", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      evidenceId: args.evidenceId as never,
      ...(args.sizeBytes === undefined ? {} : { sizeBytes: args.sizeBytes }),
      ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
      ...(args.storageRef === undefined ? {} : { storageRef: args.storageRef }),
    });
    return { ok: true as const, fileId: fileId as unknown as string };
  },
});

/** List evidence summaries for an authorized project (bounded). */
export const list = query({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    limit: v.number(),
    now: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      evidence: v.array(
        v.object({
          id: v.string(),
          sourceKind: v.string(),
          completeness: v.string(),
          counterpartyRole: v.string(),
          executionMode: v.string(),
        }),
      ),
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
    const rows = (await ctx.db
      .query("evidence")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))))) as unknown as {
      _id: string;
      organizationId: string;
      sourceKind: string;
      completeness: string;
      counterpartyRole: string;
      executionMode: string;
    }[];
    return {
      ok: true as const,
      evidence: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          id: row._id,
          sourceKind: row.sourceKind,
          completeness: row.completeness,
          counterpartyRole: row.counterpartyRole,
          executionMode: row.executionMode,
        })),
    };
  },
});
