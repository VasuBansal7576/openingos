/**
 * F1 selections and approvals (controlled contract, PRD 17/35, ADR-0003).
 *
 * A selection pins the exact quote version, quantity, actor, and the
 * requirement version it was decided against; it changes forecast only.
 * An approval snapshots the exact decision canonical string and hash;
 * changed inputs invalidate the approval (new row state) instead of
 * rewriting history. Concurrent edits cannot make an older approval
 * authorize newer terms: the snapshot hash binds the decision.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import {
  decimalCompare,
  decimalToString,
  decimalZero,
  quantity,
  type Decimal,
} from "../../proofs/money/decimal.js";
import { canonicalJson } from "../shared/hashing.js";
import {
  approvalInputValidator,
  normalizeLineQuantity,
  normalizeLineUnit,
  scopedLineUnit,
  selectionInputValidator,
  sortLinesById,
  type NormalizedOrderLine,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

const selectionResultValidator = v.union(
  v.object({ ok: v.literal(true), selectionId: v.id("selections"), deduplicated: v.boolean() }),
  denialValidator,
);

type SelectionReplayFields = {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
  readonly candidateId: Id<"candidates">;
  readonly quoteId: Id<"quotes">;
  readonly quoteVersion: string;
  readonly selectionLines: readonly NormalizedOrderLine[];
  readonly requirementVersion: number;
  readonly actor: string;
};

function selectionReplayKey(
  args: SelectionReplayFields,
): string {
  return `legacy:${canonicalJson({
    organizationId: args.organizationId,
    projectId: args.projectId,
    requirementId: args.requirementId,
    candidateId: args.candidateId,
    quoteId: args.quoteId,
    quoteVersion: args.quoteVersion,
    selectionLines: sortLinesById(args.selectionLines),
    requirementVersion: args.requirementVersion,
    actor: args.actor,
  })}`;
}

/**
 * Exact pre-F1R-13 derived key for a scalar-quantity call with no
 * explicit idempotency key (b27b027): the canonical payload carries the
 * normalized scalar quantity, not a line array. A no-key scalar retry
 * must resolve the identical key byte-for-byte, including retries of
 * rows seeded before F1R-13. Explicit line calls without a key use the
 * line-aware key above; replay comparison binds normalized effective
 * lines plus actor in both cases.
 */
function legacyScalarSelectionKey(args: {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
  readonly candidateId: Id<"candidates">;
  readonly quoteId: Id<"quotes">;
  readonly quoteVersion: string;
  readonly quantity: string;
  readonly requirementVersion: number;
  readonly actor: string;
}): string {
  return `legacy:${canonicalJson({
    organizationId: args.organizationId,
    projectId: args.projectId,
    requirementId: args.requirementId,
    candidateId: args.candidateId,
    quoteId: args.quoteId,
    quoteVersion: args.quoteVersion,
    quantity: args.quantity,
    requirementVersion: args.requirementVersion,
    actor: args.actor,
  })}`;
}

function sameSelectionLines(
  left: readonly NormalizedOrderLine[],
  right: readonly NormalizedOrderLine[],
): boolean {
  const orderedLeft = sortLinesById(left);
  const orderedRight = sortLinesById(right);
  if (orderedLeft.length !== orderedRight.length) return false;
  return orderedLeft.every(
    (line, index) => {
      const other = orderedRight[index];
      return (
        other !== undefined &&
        line.quoteLineId === other.quoteLineId &&
        line.quantity === other.quantity &&
        line.unit === other.unit
      );
    },
  );
}

function sameSelectionReplay(
  existing: SelectionReplayFields,
  wanted: SelectionReplayFields,
): boolean {
  return (
    existing.organizationId === wanted.organizationId &&
    existing.projectId === wanted.projectId &&
    existing.requirementId === wanted.requirementId &&
    existing.candidateId === wanted.candidateId &&
    existing.quoteId === wanted.quoteId &&
    existing.quoteVersion === wanted.quoteVersion &&
    sameSelectionLines(existing.selectionLines, wanted.selectionLines) &&
    existing.requirementVersion === wanted.requirementVersion &&
    existing.actor === wanted.actor
  );
}

/**
 * Read the effective normalized selection lines of a stored selection
 * row. Rows written before F1R-13 carry only the legacy scalar
 * `quantity`: they are single-line by construction, and the quote line
 * id resolves from the selection's own quote at the call site. Exported
 * for the fulfillment line-validation path, which enforces per-line
 * order and acceptance caps against the same effective lines.
 */
export function storedSelectionLines(
  row: { readonly quantity?: string; readonly selectionLines?: readonly NormalizedOrderLine[] },
  singleQuoteLineId: string,
  singleQuoteLineUnit: string,
): NormalizedOrderLine[] {
  if (row.selectionLines !== undefined) return [...row.selectionLines];
  if (row.quantity === undefined) return [];
  let normalized: string;
  try {
    normalized = decimalToString(quantity(row.quantity));
  } catch {
    return [];
  }
  return [{ quoteLineId: singleQuoteLineId, quantity: normalized, unit: singleQuoteLineUnit }];
}

/**
 * Record a selection. Requirement, candidate, and quote must all live in
 * the caller's project, the quote version must match exactly, and the
 * requirement version must be current. Quantities are normalized
 * per-line decimals with units (F1R-13): explicit `selectionLines` name
 * every quoted line, while the legacy scalar `quantity` derives the
 * single effective line for one-line quotes only and is rejected as
 * ambiguous otherwise. Mixed currencies are refused until an explicit
 * dated conversion basis is accepted (PRD 17): a requirement currency
 * that disagrees with the quote currency blocks the selection.
 */
export const recordSelection = f1Mutation({
  args: selectionInputValidator.fields,
  returns: selectionResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey !== undefined && args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.selectionLines !== undefined && args.quantity !== undefined) {
      return { ok: false as const, code: "invalid-payload", message: "supply either selection lines or a single quantity, not both" };
    }
    // F1R-17: exact historical replay precedes new-write validation. A
    // scalar call resolves its idempotency key without touching the
    // quote, so a stored pre-F1R-13 row (scalar quantity only, accepted
    // even behind a multi-line quote by the old handlers) is recognized
    // before multi-line ambiguity, unit, or cap rules for new records
    // can reject it. No lineage is invented: the stored row is compared
    // field-for-field against the normalized scalar plus actor and
    // returned as-is. New keys and material changes keep strict
    // validation on the full line-aware path below.
    if (args.selectionLines === undefined && args.quantity !== undefined) {
      let historicalQuantity: string;
      try {
        historicalQuantity = normalizeLineQuantity(args.quantity, "selected quantity");
      } catch (error) {
        return { ok: false as const, code: "invalid-payload", message: error instanceof Error ? error.message : "selected quantity is not a valid decimal" };
      }
      const historicalKey = args.idempotencyKey?.trim() ?? legacyScalarSelectionKey({
        organizationId: args.organizationId,
        projectId: args.projectId,
        requirementId: args.requirementId,
        candidateId: args.candidateId,
        quoteId: args.quoteId,
        quoteVersion: args.quoteVersion,
        quantity: historicalQuantity,
        requirementVersion: args.requirementVersion,
        actor: access.value.identity,
      });
      const historical = await ctx.db
        .query("selections")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.projectId).eq("idempotencyKey", historicalKey),
        )
        .unique();
      if (historical !== null && historical.selectionLines === undefined) {
        let storedQuantity: string | null = null;
        try {
          storedQuantity = historical.quantity === undefined
            ? null
            : decimalToString(quantity(historical.quantity));
        } catch {
          storedQuantity = null;
        }
        if (
          storedQuantity !== null &&
          historical.organizationId === args.organizationId &&
          historical.requirementId === args.requirementId &&
          historical.candidateId === args.candidateId &&
          historical.quoteId === args.quoteId &&
          historical.quoteVersion === args.quoteVersion &&
          storedQuantity === historicalQuantity &&
          historical.requirementVersion === args.requirementVersion &&
          historical.actor === access.value.identity
        ) {
          return { ok: true as const, selectionId: historical._id, deduplicated: true };
        }
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
    }
    const quote = await ctx.db.get(args.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    // Derive the complete normalized effective line payload before the
    // replay lookup, so idempotency binds every line (not a scalar) plus
    // the actor. The quote is immutable, so resolving lines here keeps
    // exact historical replays stable after supersession.
    let effectiveLines: NormalizedOrderLine[];
    try {
      if (args.selectionLines !== undefined) {
        if (args.selectionLines.length === 0) {
          return { ok: false as const, code: "invalid-payload", message: "selection lines required" };
        }
        const seen = new Set<string>();
        effectiveLines = args.selectionLines.map((line) => {
          const lineId = line.quoteLineId.trim();
          if (lineId.length === 0) {
            throw new Error("selection line id required");
          }
          if (seen.has(lineId)) {
            throw new Error(`selection line ${lineId} is duplicated`);
          }
          seen.add(lineId);
          if (!quote.lines.some((entry) => entry.lineId === lineId)) {
            throw new Error(`selection line ${lineId} is not on this quote`);
          }
          const normalizedQuantity = normalizeLineQuantity(line.quantity, `selection line ${lineId} quantity`);
          const unit = normalizeLineUnit(line.unit, `selection line ${lineId} unit`);
          const scoped = scopedLineUnit(quote.comparisonScope, lineId);
          if (scoped !== undefined && scoped !== unit) {
            throw new Error(`selection line ${lineId} unit does not match the quoted scope`);
          }
          return { quoteLineId: lineId, quantity: normalizedQuantity, unit };
        });
      } else {
        if (args.quantity === undefined) {
          return { ok: false as const, code: "invalid-payload", message: "selection quantity or selection lines required" };
        }
        // Safe compatibility path: a bare scalar is unambiguous only for
        // a one-line quote. Multi-line quotes must name every line.
        if (quote.lines.length !== 1) {
          return { ok: false as const, code: "invalid-payload", message: "multi-line quotes require explicit selection lines" };
        }
        const only = quote.lines[0];
        if (only === undefined) {
          return { ok: false as const, code: "invalid-payload", message: "quote has no lines" };
        }
        const normalizedQuantity = normalizeLineQuantity(args.quantity, "selected quantity");
        if (decimalCompare(quantity(normalizedQuantity), decimalZero()) <= 0) {
          return { ok: false as const, code: "invalid-payload", message: "selected quantity must be positive" };
        }
        effectiveLines = [{
          quoteLineId: only.lineId,
          quantity: normalizedQuantity,
          unit: scopedLineUnit(quote.comparisonScope, only.lineId) ?? "",
        }];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "selection lines are invalid";
      // A line naming another quote's line id, or a unit contradicting
      // the quoted scope, is a cross-reference denial; malformed
      // quantities, missing units, and duplicates are payload denials.
      // No row writes before this point, so every denial is no-write.
      if (message.includes("is not on this quote") || message.includes("does not match")) {
        return { ok: false as const, code: "denied-project" as const, message };
      }
      return { ok: false as const, code: "invalid-payload" as const, message };
    }
    for (const line of effectiveLines) {
      try {
        if (decimalCompare(quantity(line.quantity), decimalZero()) <= 0) {
          return { ok: false as const, code: "invalid-payload", message: "selected quantity must be positive" };
        }
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "selected quantity is not a valid decimal" };
      }
    }
    const replayFields = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      candidateId: args.candidateId,
      quoteId: args.quoteId,
      quoteVersion: args.quoteVersion,
      selectionLines: sortLinesById(effectiveLines),
      requirementVersion: args.requirementVersion,
      actor: access.value.identity,
    } satisfies SelectionReplayFields;
    // Derived-key compatibility: a scalar call with no explicit key keeps
    // the exact pre-F1R-13 canonical payload (normalized scalar
    // quantity). Explicit line calls without a key use the line-aware
    // key. Replay comparison binds normalized effective lines plus actor
    // in both cases.
    const singleLegacyQuantity = args.selectionLines === undefined &&
        effectiveLines.length === 1 &&
        effectiveLines[0] !== undefined
      ? effectiveLines[0].quantity
      : null;
    const idempotencyKey = args.idempotencyKey?.trim() ??
      (singleLegacyQuantity !== null
        ? legacyScalarSelectionKey({ ...replayFields, quantity: singleLegacyQuantity })
        : selectionReplayKey(replayFields));
    // Replay lookup follows project authorization but precedes all current
    // basis checks. An exact historical selection remains replayable after
    // its quote is superseded; any changed field or actor conflicts without
    // writing a second row. The project-local index scopes a key to the
    // authorized project, so the same key remains independent elsewhere.
    const existingInProject = await ctx.db
      .query("selections")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingInProject !== null) {
      // Pre-F1R-13 rows carry only the legacy scalar quantity. Their
      // effective lines resolve single-line from the selection's own
      // quote; a multi-line quote behind a legacy row can never match a
      // normalized payload, so it conflicts instead of merging.
      const existingLines = existingInProject.selectionLines !== undefined
        ? [...existingInProject.selectionLines]
        : storedSelectionLines(
          existingInProject,
          quote.lines.length === 1 ? (quote.lines[0]?.lineId ?? "") : "",
          quote.lines.length === 1
            ? (scopedLineUnit(quote.comparisonScope, quote.lines[0]?.lineId ?? "") ?? "")
            : "",
        );
      const existingReplay: SelectionReplayFields = {
        organizationId: existingInProject.organizationId,
        projectId: existingInProject.projectId,
        requirementId: existingInProject.requirementId,
        candidateId: existingInProject.candidateId,
        quoteId: existingInProject.quoteId,
        quoteVersion: existingInProject.quoteVersion,
        selectionLines: existingLines,
        requirementVersion: existingInProject.requirementVersion,
        actor: existingInProject.actor,
      };
      if (!sameSelectionReplay(existingReplay, replayFields)) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, selectionId: existingInProject._id, deduplicated: true };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const candidate = await requireOwnedRef(
      await ctx.db.get(args.candidateId),
      args.organizationId,
      args.projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    if (candidate.value.requirementId !== args.requirementId) {
      return { ok: false as const, code: "denied-project", message: "candidate is for another requirement" };
    }
    if (quote.version !== args.quoteVersion) {
      return { ok: false as const, code: "invalid-payload", message: "quote version mismatch" };
    }
    // F1R-03: the quote's own lineage must agree with the selection
    // graph. A quote bound to another requirement, another vendor's
    // offer, or another RFQ scope can never authorize this selection,
    // even inside the same project. Quotes without lineage fields keep
    // their existing behavior; hashing preserves but never validates.
    if (quote.requirementId !== undefined && quote.requirementId !== args.requirementId) {
      return { ok: false as const, code: "denied-project", message: "quote is bound to another requirement" };
    }
    if (quote.vendorId !== undefined && candidate.value.vendorId !== quote.vendorId) {
      return { ok: false as const, code: "denied-project", message: "quote is bound to another vendor offer" };
    }
    if (quote.rfqId !== undefined) {
      const rfq = await ctx.db.get(quote.rfqId);
      if (
        rfq === null ||
        rfq.organizationId !== args.organizationId ||
        rfq.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "quote RFQ is not in this project" };
      }
      if (rfq.requirementId !== args.requirementId) {
        return { ok: false as const, code: "denied-project", message: "quote RFQ is bound to another requirement" };
      }
      if (!rfq.scenarioVendorIds.includes(candidate.value.vendorId)) {
        return { ok: false as const, code: "denied-project", message: "quote RFQ scope excludes the candidate vendor" };
      }
    }
    if (requirement.value.version !== args.requirementVersion) {
      return { ok: false as const, code: "invalid-payload", message: "requirement version is stale" };
    }
    // F1R-04: the selected quote version must still be current. A
    // recorded successor (supersedes === this content hash) makes a new
    // selection of the old terms a stale-basis denial. Historical
    // selections and orders stay intact; only new authority is refused.
    // Bounded indexed existence probe (PRD 30): reads at most one indexed
    // successor row instead of collecting the project's quote history.
    const revisionSuccessor = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_supersedes", (q) =>
        q.eq("projectId", args.projectId).eq("supersedes", quote.contentHash),
      )
      .first();
    if (revisionSuccessor !== null) {
      return { ok: false as const, code: "stale-quote-version", message: "quote version has been superseded; select the current revision" };
    }
    if (
      requirement.value.currency !== undefined &&
      requirement.value.currency !== quote.currency
    ) {
      return { ok: false as const, code: "invalid-payload", message: "mixed-currency-requires-accepted-conversion-basis" };
    }
    // Every selected line is capped by its immutable quoted line
    // quantity: partial selection is preserved, but selecting more than
    // the quote offers on any line is rejected for both the legacy
    // scalar and explicit line forms. This check sits after the replay
    // lookup on purpose: an exact historical replay returns its row even
    // when legacy data would fail this newly introduced cap, matching
    // the F1R-11 replay-before-current-validation behavior.
    const quotedByLine = new Map(quote.lines.map((entry) => [entry.lineId, entry.quantity]));
    for (const line of effectiveLines) {
      const quoted = quotedByLine.get(line.quoteLineId);
      if (quoted === undefined) {
        return { ok: false as const, code: "denied-project", message: `selection line ${line.quoteLineId} is not on this quote` };
      }
      let quotedQuantity: Decimal;
      try {
        quotedQuantity = quantity(quoted);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "stored quoted quantity is invalid" };
      }
      try {
        if (decimalCompare(quantity(line.quantity), quotedQuantity) > 0) {
          return { ok: false as const, code: "invalid-payload", message: `selection line ${line.quoteLineId} exceeds the quoted quantity` };
        }
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "selected quantity is not a valid decimal" };
      }
    }
    // The stored row keeps the authoritative normalized selection lines.
    // The legacy scalar mirror is written only for single-line
    // selections so pre-F1R-13 readers keep their shape; multi-line
    // selections carry lines alone and never a summed quantity.
    const selectionId = await ctx.db.insert("selections", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      idempotencyKey,
      requirementId: args.requirementId,
      candidateId: args.candidateId,
      quoteId: args.quoteId,
      quoteVersion: args.quoteVersion,
      ...(effectiveLines.length === 1 && effectiveLines[0] !== undefined
        ? { quantity: effectiveLines[0].quantity }
        : {}),
      selectionLines: sortLinesById(effectiveLines),
      requirementVersion: args.requirementVersion,
      actor: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, selectionId, deduplicated: false };
  },
});

const approvalResultValidator = v.union(
  v.object({ ok: v.literal(true), approvalId: v.id("approvals"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Record an approval snapshot. The client-supplied hash is verified
 * server-side against SHA-256 of the canonical snapshot: a hash that
 * does not match the canonical text is rejected, so callers can never
 * bind an approval to terms the hash does not cover. The verified hash
 * is unique per project: replaying the same decision returns the
 * existing row. Optional selection/quote links must resolve inside the
 * project.
 */
export const recordApproval = f1Mutation({
  args: approvalInputValidator.fields,
  returns: approvalResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.snapshotHash.trim().length === 0 || args.snapshotCanonical.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "decision snapshot required" };
    }
    const computedHash = await sha256HexOfCanonical(args.snapshotCanonical);
    if (computedHash !== args.snapshotHash) {
      return { ok: false as const, code: "invalid-payload", message: "snapshot hash does not match canonical decision" };
    }
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_project_and_snapshot", (q) =>
        q.eq("projectId", args.projectId).eq("snapshotHash", args.snapshotHash),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      // F1R-05: replay identity covers every material field, not just
      // the hash. A reused snapshot with a changed scope, selection,
      // quote, or canonical text conflicts instead of returning the old
      // row, so one approval id can never authorize another decision.
      if (
        existing.scope !== args.scope ||
        existing.snapshotCanonical !== args.snapshotCanonical ||
        (existing.selectionId ?? undefined) !== args.selectionId ||
        (existing.quoteId ?? undefined) !== args.quoteId
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "snapshot hash already used with different decision fields" };
      }
      return { ok: true as const, approvalId: existing._id, deduplicated: true };
    }
    let selectionQuoteId: Id<"quotes"> | undefined;
    let approvalRequirementId: Id<"requirements"> | undefined;
    let approvalRequirementVersion: number | undefined;
    if (args.selectionId !== undefined) {
      const selection = await requireOwnedRef(
        await ctx.db.get(args.selectionId),
        args.organizationId,
        args.projectId,
      );
      if (!selection.ok) {
        return { ok: false as const, code: selection.code, message: selection.message };
      }
      selectionQuoteId = selection.value.quoteId;
      const requirement = await requireOwnedRef(
        await ctx.db.get(selection.value.requirementId),
        args.organizationId,
        args.projectId,
      );
      if (!requirement.ok) {
        return { ok: false as const, code: requirement.code, message: requirement.message };
      }
      approvalRequirementId = requirement.value._id;
      approvalRequirementVersion = selection.value.requirementVersion;
    }
    if (args.quoteId !== undefined) {
      const quote = await ctx.db.get(args.quoteId);
      if (
        quote === null ||
        quote.organizationId !== args.organizationId ||
        quote.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
      }
      if (selectionQuoteId !== undefined && selectionQuoteId !== args.quoteId) {
        return {
          ok: false as const,
          code: "denied-project",
          message: "selection and quote must refer to the same quote",
        };
      }
      if (approvalRequirementId === undefined && quote.requirementId !== undefined) {
        const requirement = await requireOwnedRef(
          await ctx.db.get(quote.requirementId),
          args.organizationId,
          args.projectId,
        );
        if (!requirement.ok) {
          return { ok: false as const, code: requirement.code, message: requirement.message };
        }
        approvalRequirementId = requirement.value._id;
        approvalRequirementVersion = requirement.value.version;
      }
    }
    const approvalId = await ctx.db.insert("approvals", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      scope: args.scope,
      snapshotCanonical: args.snapshotCanonical,
      snapshotHash: args.snapshotHash,
      ...(args.selectionId === undefined ? {} : { selectionId: args.selectionId }),
      ...(args.quoteId === undefined ? {} : { quoteId: args.quoteId }),
      ...(approvalRequirementId === undefined ? {} : { requirementId: approvalRequirementId }),
      ...(approvalRequirementVersion === undefined ? {} : { requirementVersion: approvalRequirementVersion }),
      state: "pending",
      approver: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, approvalId, deduplicated: false };
  },
});

/**
 * Decide an approval (approve or reject). Only pending approvals move;
 * invalidation after a basis change uses `invalidateApproval` so the
 * reason for invalidation stays explicit.
 */
export const decideApproval = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    if (approval.value.state !== "pending") {
      return { ok: false as const, code: "invalid-payload", message: "approval is no longer pending" };
    }
    // F1R-04: a pending approval whose quoted basis has since been
    // superseded cannot authorize the old terms. The check resolves the
    // directly linked quote and the selection's quote atomically in this
    // mutation, so a revision racing the decision still fences it.
    // Historical approvals and orders stay intact.
    const basisQuoteIds: Id<"quotes">[] = [];
    if (approval.value.quoteId !== undefined) {
      basisQuoteIds.push(approval.value.quoteId);
    }
    if (approval.value.selectionId !== undefined) {
      const selection = await ctx.db.get(approval.value.selectionId);
      if (
        selection === null ||
        selection.organizationId !== args.organizationId ||
        selection.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "approval selection is not in this project" };
      }
      const selectionRequirement = await ctx.db.get(selection.requirementId);
      if (
        selectionRequirement === null ||
        selectionRequirement.organizationId !== args.organizationId ||
        selectionRequirement.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "approval requirement is not in this project" };
      }
      // Requirement edits advance the requirement version without rewriting
      // the historical selection. A pending approval based on that older
      // selection is therefore fenced at decision time.
      if (selection.requirementVersion !== selectionRequirement.version) {
        return { ok: false as const, code: "stale-approval-basis", message: "requirement changed since approval; renewed authority required" };
      }
      if (
        approval.value.requirementId !== undefined &&
        approval.value.requirementId !== selectionRequirement._id
      ) {
        return { ok: false as const, code: "stale-approval-basis", message: "approval requirement basis changed; renewed authority required" };
      }
      if (
        approval.value.requirementVersion !== undefined &&
        approval.value.requirementVersion !== selectionRequirement.version
      ) {
        return { ok: false as const, code: "stale-approval-basis", message: "requirement changed since approval; renewed authority required" };
      }
      if (!basisQuoteIds.includes(selection.quoteId)) {
        basisQuoteIds.push(selection.quoteId);
      }
    } else if (
      approval.value.requirementId !== undefined &&
      approval.value.requirementVersion !== undefined
    ) {
      const requirement = await ctx.db.get(approval.value.requirementId);
      if (
        requirement === null ||
        requirement.organizationId !== args.organizationId ||
        requirement.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "approval requirement is not in this project" };
      }
      if (requirement.version !== approval.value.requirementVersion) {
        return { ok: false as const, code: "stale-approval-basis", message: "requirement changed since approval; renewed authority required" };
      }
    }
    for (const basisQuoteId of basisQuoteIds) {
      const basisQuote = await ctx.db.get(basisQuoteId);
      if (basisQuote === null) continue;
      // Bounded indexed existence probe (PRD 30): one row at most per
      // basis quote, never a full project collect per loop iteration.
      const basisSuccessor = await ctx.db
        .query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", args.projectId).eq("supersedes", basisQuote.contentHash),
        )
        .first();
      if (basisSuccessor !== null) {
        return { ok: false as const, code: "stale-approval-basis", message: "quoted terms changed since approval; renewed authority required" };
      }
    }
    await ctx.db.patch(args.approvalId, {
      state: args.decision,
      approver: access.value.identity,
      decidedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Invalidate an approval whose basis changed (new quote, spec, or
 * quantity). Terminal states never move again.
 */
export const invalidateApproval = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    if (approval.value.state === "invalidated" || approval.value.state === "rejected") {
      return { ok: false as const, code: "invalid-payload", message: "approval already terminal" };
    }
    await ctx.db.patch(args.approvalId, { state: "invalidated" });
    return { ok: true as const };
  },
});

/** Read one approval snapshot in the caller's project. */
export const getApproval = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), snapshotHash: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    return {
      ok: true as const,
      state: approval.value.state,
      snapshotHash: approval.value.snapshotHash,
    };
  },
});
