/**
 * F1 evidence, files, and provider identifiers (controlled contract).
 *
 * Evidence snapshots carry source kind, capture time, hash, completeness,
 * and controlled provenance. Provider IDs are opaque correlation data,
 * never authorization. Completeness (complete/partial/unavailable) is
 * separate from claim verification; omitted terms are never treated as
 * absent.
 *
 * Visibility: `record`/`recordFile` are public user imports — an
 * authenticated caller with project capability uploads documents.
 * `ingestProviderEvidence`/`ingestProviderFile` are internal provider
 * writes for the verified ingestion pipeline (R1/C1); browsers cannot
 * call them. Both paths share one validation core.
 */

import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../../server.js";
import { approved, denial, type AuthorityResult } from "../../shared/denials.js";
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

const evidenceFieldsValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  providerIds: v.optional(v.string()),
  contentHash: v.string(),
  completeness: completenessValidator,
  counterpartyRole: v.string(),
  executionMode: executionModeValidator,
  locator: v.optional(v.string()),
});

type EvidenceFields = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  sourceKind: string;
  sourceUrl?: string;
  providerIds?: string;
  contentHash: string;
  completeness: "complete" | "partial" | "unavailable";
  counterpartyRole: string;
  executionMode: "live" | "recorded" | "fixture";
  locator?: string;
};

function validateEvidenceFields(fields: EvidenceFields): AuthorityResult<EvidenceFields> {
  if (fields.sourceKind.trim().length === 0) {
    return denial("invalid-payload", "sourceKind required");
  }
  if (fields.contentHash.trim().length === 0) {
    return denial("invalid-payload", "contentHash required");
  }
  return approved(fields);
}

async function insertEvidenceRecord(
  ctx: F1MutationCtx,
  fields: EvidenceFields,
  now: number,
): Promise<Id<"evidence">> {
  return await ctx.db.insert("evidence", {
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    sourceKind: fields.sourceKind,
    ...(fields.sourceUrl === undefined ? {} : { sourceUrl: fields.sourceUrl }),
    ...(fields.providerIds === undefined ? {} : { providerIds: fields.providerIds }),
    capturedAt: now,
    contentHash: fields.contentHash,
    completeness: fields.completeness,
    counterpartyRole: fields.counterpartyRole,
    executionMode: fields.executionMode,
    ...(fields.locator === undefined ? {} : { locator: fields.locator }),
  });
}

const recordResultValidator = v.union(
  v.object({ ok: v.literal(true), evidenceId: v.id("evidence") }),
  denialValidator,
);

/** Public user import: record an evidence snapshot under project authority. */
export const record = f1Mutation({
  args: evidenceFieldsValidator,
  returns: recordResultValidator,
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
    const capability = requireCapability("evidence.record", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    const valid = validateEvidenceFields(args);
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const evidenceId = await insertEvidenceRecord(ctx, valid.value, now);
    return { ok: true as const, evidenceId };
  },
});

/** Internal provider write: verified ingestion pipeline only. */
export const ingestProviderEvidence = f1InternalMutation({
  args: evidenceFieldsValidator,
  returns: recordResultValidator,
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const valid = validateEvidenceFields(args);
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const evidenceId = await insertEvidenceRecord(ctx, valid.value, Date.now());
    return { ok: true as const, evidenceId };
  },
});

/** Public user import: attach a file record to evidence in the same project. */
export const recordFile = f1Mutation({
  args: {
    evidenceId: v.id("evidence"),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    storageRef: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), fileId: v.id("files") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const evidence = await ctx.db.get(args.evidenceId);
    if (evidence === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      evidence.organizationId,
      evidence.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const fileId = await ctx.db.insert("files", {
      organizationId: evidence.organizationId,
      projectId: evidence.projectId,
      evidenceId: args.evidenceId,
      ...(args.sizeBytes === undefined ? {} : { sizeBytes: args.sizeBytes }),
      ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
      ...(args.storageRef === undefined ? {} : { storageRef: args.storageRef }),
    });
    return { ok: true as const, fileId };
  },
});

/** Internal provider write: attach a pipeline file to bound evidence. */
export const ingestProviderFile = f1InternalMutation({
  args: {
    evidenceId: v.id("evidence"),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    storageRef: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), fileId: v.id("files") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const evidence = await ctx.db.get(args.evidenceId);
    if (evidence === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const fileId = await ctx.db.insert("files", {
      organizationId: evidence.organizationId,
      projectId: evidence.projectId,
      evidenceId: args.evidenceId,
      ...(args.sizeBytes === undefined ? {} : { sizeBytes: args.sizeBytes }),
      ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
      ...(args.storageRef === undefined ? {} : { storageRef: args.storageRef }),
    });
    return { ok: true as const, fileId };
  },
});

/** List evidence summaries for an authorized project (bounded). */
export const list = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      evidence: v.array(
        v.object({
          id: v.id("evidence"),
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
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
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
