/**
 * E7 controlled import boundary and review gate (P-24, ADR-0003/0007).
 *
 * Public user imports under contributor authority through the existing
 * access helpers. Provenance is never caller-supplied: every evidence row
 * written here derives `counterpartyRole: "userImport"` and
 * `executionMode: "recorded"` server-side, so an import can never assert
 * live transport or vendor authorship.
 *
 * Durable boundary without schema change:
 * - Equipment CSV: the immutable source bytes are captured on the
 *   evidence row (`protectedSourceText` + `contentHash` over the exact
 *   bytes) with a files metadata row (size/content type only — storage is
 *   NOT claimed). Idempotency: the submit event
 *   `imports.equipmentCsv:<key>` on the existing projectEvents table gives
 *   one exact indexed lookup per idempotency key; an identical retry
 *   returns the original result and creates no duplicate evidence, files
 *   or requirements, while the same key with a changed payload conflicts.
 *   Identical source bytes in the same project deduplicate through the
 *   `by_project_and_contentHash` evidence index regardless of key.
 * - Quote/manual attachments: source evidence plus file metadata and a
 *   durable review-required event. Bytes and storage are unavailable in
 *   this boundary, so completeness is recorded as "unavailable" and no
 *   quote or extraction success is ever synthesized.
 *
 * Review gate: imported rows are drafts only. The review action re-reads
 * the exact source identity (recomputed byte hash against the stored and
 * caller-pinned content hash — version/currentness), re-parses the source
 * with the pure parser, and promotes only explicitly selected valid rows
 * to draft requirements. Invalid or unreadable rows are never promotable,
 * promotion is idempotent by deterministic requirement key, and nothing
 * here ever approves a requirement, creates sourcing records, quotes,
 * comparisons, selections, approvals, orders or financial commitments.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, type F1MutationCtx } from "../server.js";
import { denialValidator, checkProjectAccess, identityOf, requireCapability } from "../access/checks.js";
import { denial, type AuthorityResult } from "../shared/denials.js";
import {
  normalizeBoundedText,
  normalizeRequirementDate,
  REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
} from "../shared/domainContracts.js";
import { canonicalJson } from "../shared/hashing.js";
import { sha256HexSync } from "../shared/sha256.js";
import {
  ATTACHMENT_SOURCE_KIND,
  EQUIPMENT_CSV_SOURCE_KIND,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_SELECTED_ROWS,
  decodeEquipmentCsvBytes,
  equipmentCsvRowKey,
  parseEquipmentCsv,
  promotedRequirementKey,
  validateDraftRowForPromotion,
  type EquipmentCsvDraftRow,
  type EquipmentCsvParseOutcome,
} from "./equipmentCsv.js";

const encoder = new TextEncoder();

interface DenialShape {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

function asDenial(result: AuthorityResult<unknown>): DenialShape {
  if (result.ok) return { ok: false, code: "invalid-payload", message: "unexpected approval shape" };
  return { ok: false, code: result.code, message: result.message };
}

/**
 * Contributor-or-stronger authority through the existing access helpers,
 * plus the shipped evidence-record capability (record change). Returns a
 * typed denial with zero new effect on any failure.
 */
async function requireImportAccess(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
): Promise<AuthorityResult<{ readonly identity: string }>> {
  const identity = await identityOf(ctx);
  if (identity === null) return denial("forged-identity", "unauthenticated");
  const access = await checkProjectAccess(ctx, identity, organizationId, projectId, "contributor", Date.now());
  if (!access.ok) return access;
  const capability = requireCapability("evidence.record", access.value);
  if (!capability.ok) return capability;
  return { ok: true, value: { identity } };
}

function normalizeImportIdempotencyKey(raw: string): AuthorityResult<string> {
  try {
    return { ok: true, value: normalizeBoundedText(raw, "idempotency key", REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH) };
  } catch (error) {
    return denial("invalid-payload", error instanceof Error ? error.message : "idempotency key is invalid");
  }
}

const eventKindForImport = (key: string): string => `imports.equipmentCsv:${key}`;
const eventKindForAttachment = (key: string): string => `imports.attachment:${key}`;

/**
 * Durable key binding: every accepted import key is bound to the exact
 * source content hash through one exact indexed projectEvents row, so a
 * later changed payload under the same key always conflicts — including
 * keys that were first seen on the dedupe path.
 */
async function bindImportKey(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  eventKind: string,
  sourceId: string,
  identity: string,
  contentHash: string,
  now: number,
): Promise<void> {
  await ctx.db.insert("projectEvents", {
    organizationId,
    projectId,
    kind: eventKind,
    actor: identity,
    evidenceRefs: [{ sourceId, version: "1", locator: contentHash }],
    createdAt: now,
  });
}

type ParsedPlan = Extract<EquipmentCsvParseOutcome, { ok: true }>["plan"];

interface PlanRowSummary {
  rowIndex: number;
  status: "valid" | "invalid";
  rowKey?: string;
  title?: string;
  category?: string;
  quantity?: string;
  unit?: string;
  priority?: string;
  errors: { column?: string; message: string }[];
}

function summarizePlan(parsed: ParsedPlan, contentHash: string): {
  rows: PlanRowSummary[];
  validCount: number;
  invalidCount: number;
} {
  const rows: PlanRowSummary[] = parsed.rows.map((entry) => {
    if (entry.status === "valid") {
      return {
        rowIndex: entry.rowIndex,
        status: "valid" as const,
        rowKey: equipmentCsvRowKey(contentHash, entry.rowIndex),
        title: entry.row.title,
        category: entry.row.category,
        quantity: entry.row.quantity,
        unit: entry.row.unit,
        priority: entry.row.priority,
        errors: [],
      };
    }
    return {
      rowIndex: entry.rowIndex,
      status: "invalid" as const,
      errors: entry.errors.map((error) => ({
        ...(error.column === undefined ? {} : { column: error.column }),
        message: error.message,
      })),
    };
  });
  return { rows, validCount: parsed.validCount, invalidCount: parsed.invalidCount };
}

const planRowValidator = v.object({
  rowIndex: v.number(),
  status: v.union(v.literal("valid"), v.literal("invalid")),
  rowKey: v.optional(v.string()),
  title: v.optional(v.string()),
  category: v.optional(v.string()),
  quantity: v.optional(v.string()),
  unit: v.optional(v.string()),
  priority: v.optional(v.string()),
  errors: v.array(v.object({ column: v.optional(v.string()), message: v.string() })),
});

const submitResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    evidenceId: v.id("evidence"),
    fileId: v.id("files"),
    contentHash: v.string(),
    deduplicated: v.boolean(),
    validCount: v.number(),
    invalidCount: v.number(),
    rows: v.array(planRowValidator),
    reviewRequired: v.literal(true),
  }),
  denialValidator,
);

interface ReplayedImport {
  ok: true;
  evidenceId: Id<"evidence">;
  fileId: Id<"files">;
  contentHash: string;
  validCount: number;
  invalidCount: number;
  rows: PlanRowSummary[];
}

/**
 * Re-derive an original import result from the immutable source record.
 * The parser is deterministic, so a replay produces exactly the original
 * plan without persisting it.
 */
async function replayOriginalResult(
  ctx: F1MutationCtx,
  projectId: Id<"projects">,
  contentHash: string,
): Promise<ReplayedImport | null> {
  const source = await ctx.db
    .query("evidence")
    .withIndex("by_project_and_contentHash", (q) =>
      q.eq("projectId", projectId).eq("contentHash", contentHash),
    )
    .filter((q) => q.eq(q.field("sourceKind"), EQUIPMENT_CSV_SOURCE_KIND))
    .first();
  if (source === null || source.protectedSourceText === undefined) return null;
  const storedHash = sha256HexSync(encoder.encode(source.protectedSourceText));
  if (storedHash !== source.contentHash) return null;
  const parsed = parseEquipmentCsv(source.protectedSourceText);
  if (!parsed.ok) return null;
  const file = await ctx.db
    .query("files")
    .withIndex("by_evidence", (q) => q.eq("evidenceId", source._id))
    .first();
  if (file === null) return null;
  const summary = summarizePlan(parsed.plan, contentHash);
  return {
    ok: true,
    evidenceId: source._id,
    fileId: file._id,
    contentHash,
    validCount: summary.validCount,
    invalidCount: summary.invalidCount,
    rows: summary.rows,
  };
}

/**
 * Public user import: bounded controlled equipment CSV template. Parses
 * the exact source bytes, records the immutable source evidence plus file
 * metadata, and returns the typed review plan. Nothing here promotes,
 * approves, or creates requirements — review is a separate action.
 */
export const submitEquipmentCsv = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    csvBytes: v.bytes(),
  },
  returns: submitResultValidator,
  handler: async (ctx, args) => {
    const access = await requireImportAccess(ctx, args.organizationId, args.projectId);
    if (!access.ok) return asDenial(access);
    const key = normalizeImportIdempotencyKey(args.idempotencyKey);
    if (!key.ok) return asDenial(key);
    const bytes = new Uint8Array(args.csvBytes);
    if (bytes.length > IMPORT_MAX_BYTES) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: `csv input exceeds the ${IMPORT_MAX_BYTES}-byte import bound`,
      };
    }
    const contentHash = sha256HexSync(bytes);
    const now = Date.now();

    // 1. Idempotency-key binding: one exact indexed event per key. A key
    // already bound to a different payload conflicts; the same key with
    // the same payload replays the original result.
    const priorEvent = await ctx.db
      .query("projectEvents")
      .withIndex("by_project_and_kind", (q) =>
        q.eq("projectId", args.projectId).eq("kind", eventKindForImport(key.value)),
      )
      .first();
    if (priorEvent !== null) {
      const boundHash = priorEvent.evidenceRefs?.[0]?.locator;
      if (boundHash !== contentHash) {
        return {
          ok: false as const,
          code: "duplicate-conflict",
          message: "idempotency key was already used for a different payload",
        };
      }
      const replay = await replayOriginalResult(ctx, args.projectId, contentHash);
      return replay === null
        ? { ok: false as const, code: "invalid-payload", message: "import source record is missing" }
        : {
          ok: true as const,
          evidenceId: replay.evidenceId,
          fileId: replay.fileId,
          contentHash: replay.contentHash,
          deduplicated: true,
          validCount: replay.validCount,
          invalidCount: replay.invalidCount,
          rows: replay.rows,
          reviewRequired: true as const,
        };
    }

    // 2. Identical source bytes in the same project deduplicate to the
    // original import regardless of the caller's key. The new key is
    // still durably bound to the same source hash, so a later changed
    // payload under that key conflicts.
    const byteDedupe = await replayOriginalResult(ctx, args.projectId, contentHash);
    if (byteDedupe !== null) {
      await bindImportKey(
        ctx,
        args.organizationId,
        args.projectId,
        eventKindForImport(key.value),
        "imports.equipmentCsv",
        access.value.identity,
        contentHash,
        now,
      );
      return {
        ok: true as const,
        evidenceId: byteDedupe.evidenceId,
        fileId: byteDedupe.fileId,
        contentHash: byteDedupe.contentHash,
        deduplicated: true,
        validCount: byteDedupe.validCount,
        invalidCount: byteDedupe.invalidCount,
        rows: byteDedupe.rows,
        reviewRequired: true as const,
      };
    }

    // 3. Parse the exact source. Document-level failures create no record.
    const decoded = decodeEquipmentCsvBytes(bytes);
    if (!decoded.ok) return { ok: false as const, code: decoded.code, message: decoded.message };
    const parsed = parseEquipmentCsv(decoded.text);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, message: parsed.message };

    // 4. Immutable source evidence: recorded user-import provenance is
    // derived server-side; the exact source bytes stay on the evidence row.
    const evidenceId = await ctx.db.insert("evidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      sourceKind: EQUIPMENT_CSV_SOURCE_KIND,
      capturedAt: now,
      contentHash,
      protectedSourceText: decoded.text,
      completeness: "complete",
      counterpartyRole: "userImport",
      executionMode: "recorded",
      locator: `equipment-csv/key/${key.value}`,
    });
    // File metadata only: no storageRef, so no storage is claimed.
    const fileId = await ctx.db.insert("files", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      evidenceId,
      sizeBytes: bytes.length,
      contentType: "text/csv",
    });
    await bindImportKey(
      ctx,
      args.organizationId,
      args.projectId,
      eventKindForImport(key.value),
      "imports.equipmentCsv",
      access.value.identity,
      contentHash,
      now,
    );

    const summary = summarizePlan(parsed.plan, contentHash);
    return {
      ok: true as const,
      evidenceId,
      fileId,
      contentHash,
      deduplicated: false,
      validCount: summary.validCount,
      invalidCount: summary.invalidCount,
      rows: summary.rows,
      reviewRequired: true as const,
    };
  },
});

const reviewResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    promotedCount: v.number(),
    alreadyPromotedCount: v.number(),
    requirementIds: v.array(v.id("requirements")),
  }),
  denialValidator,
);

/**
 * An exact-match requirement for a promoted row: every promoted field,
 * the promoted state, and the tenant binding must match, otherwise the
 * key is occupied by a conflicting row and the review denies entirely.
 */
function promotedRowMatches(
  existing: {
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    state: string;
    fulfillment: string;
    title: string;
    category: string;
    quantity: string;
    unit: string;
    priority: string;
    budgetMinorUnits?: number;
    currency?: string;
    needByAt?: number;
    hardConstraints?: string;
    responsible?: string;
  },
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  row: EquipmentCsvDraftRow,
): boolean {
  return (
    existing.organizationId === organizationId &&
    existing.projectId === projectId &&
    existing.state === "draft" &&
    existing.fulfillment === "notOrdered" &&
    existing.title === row.title &&
    existing.category === row.category &&
    existing.quantity === row.quantity &&
    existing.unit === row.unit &&
    existing.priority === row.priority &&
    (existing.budgetMinorUnits ?? undefined) === row.budgetMinorUnits &&
    (existing.currency ?? undefined) === row.currency &&
    (existing.needByAt ?? undefined) === row.needByAt &&
    (existing.hardConstraints ?? undefined) === row.hardConstraints &&
    (existing.responsible ?? undefined) === row.responsible
  );
}

/**
 * Separate explicit review action: re-reads the exact source identity and
 * version/currentness, requires contributor-or-stronger authority plus the
 * shipped record-change capability, and promotes only explicitly selected
 * valid rows to draft requirements. Every selected row is prefetched and
 * validated BEFORE the first write: an exact existing draft deduplicates,
 * any occupied conflicting key denies the entire review with zero partial
 * requirements and no review event. Invalid/unreadable rows are never
 * promotable, promotion is idempotent, and rows are never approved here.
 */
export const reviewEquipmentCsv = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    evidenceId: v.id("evidence"),
    expectedContentHash: v.string(),
    selectedRowKeys: v.array(v.string()),
  },
  returns: reviewResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(ctx, identity, args.organizationId, args.projectId, "contributor", now);
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability("evidence.record", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    if (args.selectedRowKeys.length > IMPORT_MAX_SELECTED_ROWS) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: `selection exceeds the ${IMPORT_MAX_SELECTED_ROWS}-row review bound`,
      };
    }

    // Cross-organization or cross-project references deny without
    // revealing existence: unknown and foreign evidence share one denial.
    const evidence = await ctx.db.get(args.evidenceId);
    if (
      evidence === null ||
      evidence.organizationId !== args.organizationId ||
      evidence.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (evidence.sourceKind !== EQUIPMENT_CSV_SOURCE_KIND) {
      return { ok: false as const, code: "invalid-payload", message: "evidence is not an equipment CSV import" };
    }

    // Version/currentness: the stored source must still hash to the
    // recorded identity, and the caller must have reviewed exactly that
    // identity. Any mismatch is a stale review denial.
    if (evidence.protectedSourceText === undefined) {
      return {
        ok: false as const,
        code: "stale-input-version",
        message: "import source bytes are no longer available",
      };
    }
    const recomputedHash = sha256HexSync(encoder.encode(evidence.protectedSourceText));
    if (recomputedHash !== evidence.contentHash || recomputedHash !== args.expectedContentHash) {
      return {
        ok: false as const,
        code: "stale-input-version",
        message: "import source changed since review; re-submit or re-review the current source",
      };
    }

    const parsed = parseEquipmentCsv(evidence.protectedSourceText);
    if (!parsed.ok) {
      return { ok: false as const, code: parsed.code, message: parsed.message };
    }

    const validByRowKey = new Map<string, number>();
    for (const entry of parsed.plan.rows) {
      if (entry.status === "valid") {
        validByRowKey.set(equipmentCsvRowKey(args.expectedContentHash, entry.rowIndex), entry.rowIndex);
      }
    }
    const requested = new Set(args.selectedRowKeys);
    for (const rowKey of requested) {
      if (!validByRowKey.has(rowKey)) {
        return {
          ok: false as const,
          code: "invalid-payload",
          message: "selection names an unknown or invalid row; invalid rows are not promotable",
        };
      }
    }

    // Full preflight before the first write: every selected row is
    // validated and reconciled against any existing occupant of its
    // deterministic key, so a later collision can never leave an earlier
    // write behind.
    interface PreflightRow {
      readonly rowIndex: number;
      readonly row: EquipmentCsvDraftRow;
      readonly existingRequirementId?: Id<"requirements">;
    }
    const preflight: PreflightRow[] = [];
    for (const entry of parsed.plan.rows) {
      if (entry.status !== "valid") continue;
      const rowKey = equipmentCsvRowKey(args.expectedContentHash, entry.rowIndex);
      if (!requested.has(rowKey)) continue;
      const validated = validateDraftRowForPromotion(entry.row);
      if (!validated.ok) {
        return {
          ok: false as const,
          code: validated.code,
          message: `row ${entry.rowIndex}: ${validated.message}`,
        };
      }
      const row = validated.normalized;
      const key = promotedRequirementKey(args.expectedContentHash, entry.rowIndex);
      const existing = await ctx.db
        .query("requirements")
        .withIndex("by_project_and_key", (q) => q.eq("projectId", args.projectId).eq("key", key))
        .unique();
      if (existing !== null) {
        if (!promotedRowMatches(existing, args.organizationId, args.projectId, row)) {
          return {
            ok: false as const,
            code: "duplicate-conflict",
            message: `requirement key ${key} is occupied by a conflicting requirement; the review was denied with zero changes`,
          };
        }
        preflight.push({ rowIndex: entry.rowIndex, row, existingRequirementId: existing._id });
        continue;
      }
      preflight.push({ rowIndex: entry.rowIndex, row });
    }

    const requirementIds: Id<"requirements">[] = [];
    let promotedCount = 0;
    let alreadyPromotedCount = 0;
    for (const entry of preflight) {
      if (entry.existingRequirementId !== undefined) {
        alreadyPromotedCount += 1;
        requirementIds.push(entry.existingRequirementId);
        continue;
      }
      const row = entry.row;
      promotedCount += 1;
      const requirementId = await ctx.db.insert("requirements", {
        organizationId: args.organizationId,
        projectId: args.projectId,
        key: promotedRequirementKey(args.expectedContentHash, entry.rowIndex),
        title: row.title,
        category: row.category,
        quantity: row.quantity,
        unit: row.unit,
        priority: row.priority,
        state: "draft",
        fulfillment: "notOrdered",
        version: 1,
        ...(row.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: row.budgetMinorUnits }),
        ...(row.currency === undefined ? {} : { currency: row.currency }),
        ...(row.needByAt === undefined ? {} : { needByAt: row.needByAt }),
        ...(row.hardConstraints === undefined ? {} : { hardConstraints: row.hardConstraints }),
        ...(row.responsible === undefined ? {} : { responsible: row.responsible }),
        createdAt: now,
        updatedAt: now,
      });
      requirementIds.push(requirementId);
    }

    // Review audit only when promotion advanced; pure retries stay
    // side-effect free. Nothing here approves or creates sourcing,
    // quote, selection, approval, order, or financial records.
    if (promotedCount > 0) {
      await bindImportKey(
        ctx,
        args.organizationId,
        args.projectId,
        "imports.equipmentCsv.reviewed",
        "imports.equipmentCsv",
        identity,
        args.expectedContentHash,
        Date.now(),
      );
    }
    return { ok: true as const, promotedCount, alreadyPromotedCount, requirementIds };
  },
});

const attachmentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    evidenceId: v.id("evidence"),
    fileId: v.id("files"),
    deduplicated: v.boolean(),
    extractionStatus: v.literal("reviewRequired"),
  }),
  denialValidator,
);

/**
 * Quote/manual attachment ingestion: records the canonical normalized
 * attachment metadata as protected source evidence (hashed), plus file
 * metadata and a durable review-required extraction status. Bytes,
 * storage, and provider extraction are unavailable in this boundary, so
 * completeness is honestly "unavailable", no storageRef is written, and
 * no quote or extraction success is ever synthesized.
 *
 * Idempotency: the key event `imports.attachment:<key>` binds each
 * accepted key to the exact metadata hash before any replay — same key
 * with changed metadata conflicts, identical replay revalidates the
 * stored metadata hash and exact file metadata, and identical metadata
 * under a new key deduplicates only after that new key is bound too.
 */
export const recordAttachment = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
  },
  returns: attachmentResultValidator,
  handler: async (ctx, args) => {
    const access = await requireImportAccess(ctx, args.organizationId, args.projectId);
    if (!access.ok) return asDenial(access);
    const key = normalizeImportIdempotencyKey(args.idempotencyKey);
    if (!key.ok) return asDenial(key);
    if (args.sizeBytes !== undefined && (!Number.isSafeInteger(args.sizeBytes) || args.sizeBytes < 0)) {
      return { ok: false as const, code: "invalid-payload", message: "sizeBytes must be a non-negative safe integer" };
    }
    if (args.contentType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(args.contentType)) {
      return { ok: false as const, code: "invalid-payload", message: "contentType must be a type/subtype media type" };
    }
    let fileName: string | undefined;
    if (args.fileName !== undefined) {
      try {
        fileName = normalizeBoundedText(args.fileName, "file name", 512);
      } catch (error) {
        return {
          ok: false as const,
          code: "invalid-payload",
          message: error instanceof Error ? error.message : "file name is invalid",
        };
      }
    }

    // The canonical normalized metadata IS the recorded source: it is
    // persisted as protected source evidence and hashed exactly.
    const metadataCanonical = canonicalJson({
      fileName: fileName ?? null,
      contentType: args.contentType ?? null,
      sizeBytes: args.sizeBytes ?? null,
    });
    const contentHash = sha256HexSync(encoder.encode(metadataCanonical));
    const now = Date.now();

    // 1. Key binding first: one exact indexed event per key.
    const priorEvent = await ctx.db
      .query("projectEvents")
      .withIndex("by_project_and_kind", (q) =>
        q.eq("projectId", args.projectId).eq("kind", eventKindForAttachment(key.value)),
      )
      .first();
    if (priorEvent !== null) {
      const boundHash = priorEvent.evidenceRefs?.[0]?.locator;
      if (boundHash !== contentHash) {
        return {
          ok: false as const,
          code: "duplicate-conflict",
          message: "idempotency key was already used for different attachment metadata",
        };
      }
      const replay = await replayAttachment(ctx, args.projectId, contentHash, {
        fileName,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
      });
      return replay === null
        ? { ok: false as const, code: "invalid-payload", message: "stored attachment metadata does not match its content hash" }
        : { ...replay, deduplicated: true };
    }

    // 2. Identical metadata in the same project deduplicates; the new key
    // is bound to the same metadata hash first.
    const metadataDedupe = await replayAttachment(ctx, args.projectId, contentHash, {
      fileName,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
    });
    if (metadataDedupe !== null) {
      await bindImportKey(
        ctx,
        args.organizationId,
        args.projectId,
        eventKindForAttachment(key.value),
        "imports.quoteAttachment",
        access.value.identity,
        contentHash,
        now,
      );
      return { ...metadataDedupe, deduplicated: true };
    }

    const evidenceId = await ctx.db.insert("evidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      sourceKind: ATTACHMENT_SOURCE_KIND,
      capturedAt: now,
      contentHash,
      protectedSourceText: metadataCanonical,
      completeness: "unavailable",
      counterpartyRole: "userImport",
      executionMode: "recorded",
      locator: `attachment/key/${key.value}`,
    });
    const fileId = await ctx.db.insert("files", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      evidenceId,
      ...(args.sizeBytes === undefined ? {} : { sizeBytes: args.sizeBytes }),
      ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
    });
    await bindImportKey(
      ctx,
      args.organizationId,
      args.projectId,
      eventKindForAttachment(key.value),
      "imports.quoteAttachment",
      access.value.identity,
      contentHash,
      now,
    );
    // Durable review-required extraction status marker for fresh
    // attachments; replay and dedupe paths add no duplicate marker.
    await ctx.db.insert("projectEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: "imports.attachment.reviewRequired",
      actor: access.value.identity,
      evidenceRefs: [{ sourceId: "imports.quoteAttachment", version: "1", locator: contentHash }],
      createdAt: now,
    });
    return {
      ok: true as const,
      evidenceId,
      fileId,
      deduplicated: false,
      extractionStatus: "reviewRequired" as const,
    };
  },
});

/**
 * Re-derive an original attachment result from the durable record,
 * revalidating the stored metadata hash and the exact file metadata.
 */
async function replayAttachment(
  ctx: F1MutationCtx,
  projectId: Id<"projects">,
  contentHash: string,
  metadata: {
    readonly fileName?: string | undefined;
    readonly contentType?: string | undefined;
    readonly sizeBytes?: number | undefined;
  },
): Promise<{
  ok: true;
  evidenceId: Id<"evidence">;
  fileId: Id<"files">;
  extractionStatus: "reviewRequired";
} | null> {
  const evidence = await ctx.db
    .query("evidence")
    .withIndex("by_project_and_contentHash", (q) =>
      q.eq("projectId", projectId).eq("contentHash", contentHash),
    )
    .filter((q) => q.eq(q.field("sourceKind"), ATTACHMENT_SOURCE_KIND))
    .first();
  if (evidence === null || evidence.protectedSourceText === undefined) return null;
  if (sha256HexSync(encoder.encode(evidence.protectedSourceText)) !== evidence.contentHash) return null;
  const file = await ctx.db
    .query("files")
    .withIndex("by_evidence", (q) => q.eq("evidenceId", evidence._id))
    .first();
  if (file === null) return null;
  if ((file.sizeBytes ?? undefined) !== metadata.sizeBytes) return null;
  if ((file.contentType ?? undefined) !== metadata.contentType) return null;
  return {
    ok: true as const,
    evidenceId: evidence._id,
    fileId: file._id,
    extractionStatus: "reviewRequired" as const,
  };
}
