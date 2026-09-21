/**
 * E5 changed-term impact and substitution (controlled contract, PRD 17,
 * ADR-0003; P-11, P-12, P-13, D-15).
 *
 * An impact assessment is a durable, append-only, evidence-backed
 * re-evaluation of a requirement's alternatives, triggered either by a
 * superseding quote revision (exact `supersedes` lineage) or by an
 * explicit watch observation. It distinguishes an unplaced selection
 * change from already placed orders and carries explicit unknown and
 * incomplete states. A failed watch check stays `unknown`; no code path
 * here can mark a placed order delayed, because no assessment field
 * expresses delivery delay. Reason text derives only from stored rows:
 * assessments never invent savings, availability, vendor replies, or
 * recommendations.
 *
 * A substitute proposal always requires fresh approval. It references
 * the assessment that explains it, pins the exact proposed candidate,
 * quote revision, and line quantities, and only a pending proposal
 * whose quote revision and requirement version are still current can be
 * approved by an approver. Approval records a new approvals row whose
 * snapshot binds the proposal decision. No proposal ever deletes or
 * rewrites prior selection, approval, order, or financial history;
 * executing an approved substitute remains an explicit new selection
 * through the decision machinery, which re-fences staleness itself.
 *
 * Affected placed orders are assessed independently of the latest
 * selection: a revision affects every selection pinned to any revision
 * in its supersedes ancestry (bounded indexed lineage), so an order on
 * an older selection stays impacted after a newer selection is recorded.
 * Old orders are never rewritten; over-bound scans produce explicit
 * incompleteness instead of an undercounted commitment figure. Only the
 * current selection's unplaced basis change is `selectionOnly`:
 * historical unplaced selections create no fresh decision once the
 * requirement is re-selected, while placed orders on any affected
 * selection still make the impact `reviewRequired`.
 */

import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalCompare,
  decimalZero,
  quantity,
} from "../../proofs/money/decimal.js";
import { canonicalJson } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import {
  normalizeLineQuantity,
  normalizeLineUnit,
  scopedLineUnit,
  sortLinesById,
  type NormalizedOrderLine,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

/**
 * Bounded alternative re-evaluation: at most this many candidates are
 * read per assessment. One row past the bound is probed to detect
 * truncation; an over-bound requirement returns explicit incompleteness
 * instead of a prefix evaluation labeled complete.
 */
export const ALTERNATIVE_EVALUATION_BOUND = 25;

/**
 * Bounded placed-order probe per affected selection. One row past the
 * bound is probed; a selection with more orders than the bound produces
 * explicit incompleteness instead of an undercounted commitment figure.
 */
export const PLACED_ORDER_PROBE_BOUND = 100;

/**
 * Bounded revision-lineage walk: at most this many predecessor generations
 * are resolved through the exact content-hash index when an assessment
 * determines which selections a superseding revision affects. A longer
 * chain produces explicit incompleteness instead of silently ignoring the
 * oldest generations.
 */
export const REVISION_LINEAGE_BOUND = 10;

/**
 * Bounded selection scan per requirement: at most this many selections
 * are read through the requirement index when an assessment determines
 * the affected selections. One row past the bound is probed; an
 * over-bound requirement produces explicit incompleteness instead of an
 * assessment that only sees the newest selections.
 */
export const SELECTION_SCAN_BOUND = 50;

/** Caller-provided proposal explanations stay bounded. */
export const PROPOSAL_REASON_MAX_LENGTH = 500;

const watchResultValidator = v.union(
  v.literal("ok"),
  v.literal("stale"),
  v.literal("error"),
  v.literal("unknown"),
);

const alternativeValidator = v.object({
  candidateId: v.id("candidates"),
  status: v.union(
    v.literal("current"),
    v.literal("superseded"),
    v.literal("noQuote"),
    v.literal("unknown"),
  ),
  quoteId: v.optional(v.id("quotes")),
  quoteVersion: v.optional(v.string()),
  note: v.string(),
});

const assessmentResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    assessmentId: v.id("impactAssessments"),
    deduplicated: v.boolean(),
  }),
  denialValidator,
);

// -- Shared bounded evaluation helpers (no direct writes) --------------------

interface AssessmentBasis {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
}

/**
 * Latest selection for the requirement, bounded to one indexed read.
 * Only the current decision matters for impact: historical selections
 * are never rewritten or re-decided.
 */
async function latestSelection(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
): Promise<{
  readonly _id: Id<"selections">;
  readonly candidateId: Id<"candidates">;
  readonly quoteId: Id<"quotes">;
  readonly quoteVersion: string;
} | null> {
  const rows = await ctx.db
    .query("selections")
    .withIndex("by_requirement", (q) => q.eq("requirementId", basis.requirementId))
    .order("desc")
    .take(1);
  const row = rows[0];
  if (row === undefined) return null;
  if (
    row.organizationId !== basis.organizationId ||
    row.projectId !== basis.projectId
  ) {
    return null;
  }
  return {
    _id: row._id,
    candidateId: row.candidateId,
    quoteId: row.quoteId,
    quoteVersion: row.quoteVersion,
  };
}

/**
 * Bounded placed-order probe on one selection. Returns the observed
 * count (at most one past the bound) so the caller can detect an
 * over-bound scan and mark explicit incompleteness.
 */
async function probePlacedOrders(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
  selectionId: Id<"selections">,
): Promise<number> {
  const rows = await ctx.db
    .query("orders")
    .withIndex("by_selection", (q) => q.eq("selectionId", selectionId))
    .take(PLACED_ORDER_PROBE_BOUND + 1);
  return rows.filter(
    (row) => row.organizationId === basis.organizationId && row.projectId === basis.projectId,
  ).length;
}

/**
 * Bounded revision-ancestry walk for a superseding quote revision. Each
 * predecessor resolves through one exact `by_project_and_contentHash`
 * index seek, starting from the already-resolved immediate predecessor.
 * Returns the set of ancestor quote ids (immediate predecessor plus
 * older generations, up to REVISION_LINEAGE_BOUND) and whether a longer
 * chain was cut off. Old generations are never skipped silently: a cut
 * chain marks the assessment incomplete.
 */
async function collectRevisionAncestry(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
  predecessor: {
    readonly _id: Id<"quotes">;
    readonly supersedes?: string;
  },
): Promise<{ ancestorQuoteIds: Set<Id<"quotes">>; lineageTruncated: boolean }> {
  const ancestorQuoteIds = new Set<Id<"quotes">>([predecessor._id]);
  let currentSupersedes = predecessor.supersedes;
  while (currentSupersedes !== undefined && ancestorQuoteIds.size < REVISION_LINEAGE_BOUND) {
    const ancestor = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_contentHash", (q) =>
        q.eq("projectId", basis.projectId).eq("contentHash", currentSupersedes as string),
      )
      .first();
    if (ancestor === null || ancestor.organizationId !== basis.organizationId) break;
    ancestorQuoteIds.add(ancestor._id);
    currentSupersedes = ancestor.supersedes;
  }
  // One-row existence probe past the bound: a still-resolvable older
  // generation means the walk was cut short.
  let lineageTruncated = false;
  if (currentSupersedes !== undefined && ancestorQuoteIds.size >= REVISION_LINEAGE_BOUND) {
    const beyond = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_contentHash", (q) =>
        q.eq("projectId", basis.projectId).eq("contentHash", currentSupersedes as string),
      )
      .first();
    lineageTruncated =
      beyond !== null && beyond.organizationId === basis.organizationId;
  }
  return { ancestorQuoteIds, lineageTruncated };
}

interface SelectionScan {
  readonly rows: {
    readonly _id: Id<"selections">;
    readonly candidateId: Id<"candidates">;
    readonly quoteId: Id<"quotes">;
    readonly quoteVersion: string;
  }[];
  readonly selectionScanOverBound: boolean;
}

/**
 * Bounded indexed scan of a requirement's selections (oldest first, at
 * most SELECTION_SCAN_BOUND rows). One row past the bound is probed so
 * an over-bound requirement yields explicit incompleteness instead of a
 * newest-only view that silently drops older affected selections.
 */
async function scanSelections(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
): Promise<SelectionScan> {
  const rows = await ctx.db
    .query("selections")
    .withIndex("by_requirement", (q) => q.eq("requirementId", basis.requirementId))
    .take(SELECTION_SCAN_BOUND + 1);
  const selectionScanOverBound = rows.length > SELECTION_SCAN_BOUND;
  const inScope = rows
    .slice(0, SELECTION_SCAN_BOUND)
    .filter(
      (row) =>
        row.organizationId === basis.organizationId && row.projectId === basis.projectId,
    );
  return { rows: inScope, selectionScanOverBound };
}

/**
 * Bounded placed-order probe across several affected selections. Returns
 * the total observed placed-order count and whether any selection's scan
 * exceeded the per-selection probe bound. Old orders are only read,
 * never rewritten.
 */
async function probePlacedOrdersAcross(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
  selectionIds: readonly Id<"selections">[],
): Promise<{ placedOrderCount: number; orderScanOverBound: boolean }> {
  let placedOrderCount = 0;
  let orderScanOverBound = false;
  for (const selectionId of selectionIds) {
    const count = await probePlacedOrders(ctx, basis, selectionId);
    placedOrderCount += count;
    if (count > PLACED_ORDER_PROBE_BOUND) orderScanOverBound = true;
  }
  return { placedOrderCount, orderScanOverBound };
}

/**
 * Bounded per-candidate currentness evaluation. Each candidate's latest
 * stored quote resolves through one exact compound-index seek, and its
 * currentness through one bounded successor existence probe. Statuses
 * derive only from stored rows: `noQuote` is explicit missing evidence,
 * never an invented unavailability.
 */
async function evaluateAlternatives(
  ctx: Parameters<typeof requireDomainAccess>[0],
  basis: AssessmentBasis,
  selectedCandidateId: Id<"candidates"> | null,
): Promise<{ alternatives: Infer<typeof alternativeValidator>[]; truncated: boolean }> {
  const candidates = await ctx.db
    .query("candidates")
    .withIndex("by_requirement", (q) => q.eq("requirementId", basis.requirementId))
    .take(ALTERNATIVE_EVALUATION_BOUND + 1);
  const truncated = candidates.length > ALTERNATIVE_EVALUATION_BOUND;
  const alternatives: Infer<typeof alternativeValidator>[] = [];
  for (const candidate of candidates) {
    if (alternatives.length >= ALTERNATIVE_EVALUATION_BOUND) break;
    if (
      candidate.organizationId !== basis.organizationId ||
      candidate.projectId !== basis.projectId
    ) {
      continue;
    }
    const selected = candidate._id === selectedCandidateId;
    const latest = await ctx.db
      .query("quotes")
      .withIndex(
        "by_project_and_requirement_and_vendor_and_created_at",
        (q) =>
          q
            .eq("projectId", basis.projectId)
            .eq("requirementId", basis.requirementId)
            .eq("vendorId", candidate.vendorId),
      )
      .order("desc")
      .first();
    if (latest === null || latest.vendorId === undefined) {
      alternatives.push({
        candidateId: candidate._id,
        status: "noQuote",
        note: selected
          ? "selected candidate has no recorded quote"
          : "no recorded quote for this candidate",
      });
      continue;
    }
    // Bounded indexed existence probe: one row at most per candidate.
    const successor = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_supersedes", (q) =>
        q.eq("projectId", basis.projectId).eq("supersedes", latest.contentHash),
      )
      .first();
    if (successor !== null) {
      alternatives.push({
        candidateId: candidate._id,
        status: "superseded",
        quoteId: latest._id,
        quoteVersion: latest.version,
        note: selected
          ? "selected candidate's latest quote version has a recorded revision"
          : "latest quote version has a recorded revision",
      });
      continue;
    }
    alternatives.push({
      candidateId: candidate._id,
      status: "current",
      quoteId: latest._id,
      quoteVersion: latest.version,
      note: selected
        ? "currently selected candidate; latest quote version is current"
        : "latest quote version is current",
    });
  }
  return { alternatives, truncated };
}

// -- Assessments ---------------------------------------------------------------

/**
 * Record the durable impact of a superseding quote revision. The quote
 * must be a requirement-bound revision whose `supersedes` content hash
 * resolves to an in-project predecessor, so the assessment always rests
 * on exact revision lineage. Only the current selection's unplaced basis
 * change is `selectionOnly`: affected historical selections without
 * placed orders create no fresh decision once the requirement is
 * re-selected, while placed orders on any affected selection make the
 * impact `reviewRequired` — the order history stays untouched and any
 * substitute needs fresh approval.
 */
export const assessQuoteRevisionImpact = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    quoteId: v.id("quotes"),
  },
  returns: assessmentResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "contributor");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    const quote = await requireOwnedRef(
      await ctx.db.get(args.quoteId),
      args.organizationId,
      args.projectId,
    );
    if (!quote.ok) {
      return { ok: false as const, code: quote.code, message: quote.message };
    }
    if (quote.value.requirementId === undefined) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "quote requirement lineage is unavailable; assessment needs a requirement-bound revision",
      };
    }
    const supersededHash = quote.value.supersedes;
    if (supersededHash === undefined) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "quote is not a superseding revision",
      };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(quote.value.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    // Exact revision lineage: the predecessor content hash must resolve
    // to one in-project quote through a bounded exact-index probe.
    const predecessor = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_contentHash", (q) =>
        q.eq("projectId", args.projectId).eq("contentHash", supersededHash),
      )
      .first();
    if (
      predecessor === null ||
      predecessor.organizationId !== args.organizationId
    ) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "superseded revision does not resolve in this project",
      };
    }
    const existing = await ctx.db
      .query("impactAssessments")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.trigger !== "quoteRevision" ||
        existing.quoteId !== quote.value._id ||
        existing.requirementId !== quote.value.requirementId
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, assessmentId: existing._id, deduplicated: true };
    }
    const basis: AssessmentBasis = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: quote.value.requirementId,
    };
    // Affected selections resolve through bounded revision ancestry,
    // not through the latest selection alone: every selection pinned to
    // the predecessor or any older generation in this revision's
    // supersedes chain is affected, so an order on an older selection
    // stays impacted after a newer selection is recorded. Old orders are
    // only read here, never rewritten.
    const selection = await latestSelection(ctx, basis);
    const { ancestorQuoteIds, lineageTruncated } = await collectRevisionAncestry(
      ctx,
      basis,
      predecessor,
    );
    const scan = await scanSelections(ctx, basis);
    const affected = scan.rows.filter((row) => ancestorQuoteIds.has(row.quoteId));
    // Current-vs-historical separation: the current selection is resolved
    // exactly (newest indexed row), independently of the bounded scan, so
    // a replaced historical selection never reopens a fresh decision.
    // Only the current selection's unplaced basis change is `selectionOnly`;
    // historical unplaced selections create no fresh decision, while placed
    // orders on any affected selection still make the impact
    // `reviewRequired`.
    const currentAffected =
      selection !== null && ancestorQuoteIds.has(selection.quoteId);
    const { placedOrderCount, orderScanOverBound } = await probePlacedOrdersAcross(
      ctx,
      basis,
      affected.map((row) => row._id),
    );
    // Primary affected selection: the oldest affected selection carrying
    // placed orders, else the oldest affected selection. Preferring the
    // oldest keeps the original affected order stable when a newer
    // selection is recorded later.
    let primaryAffected: (typeof affected)[number] | null = null;
    if (affected.length > 0) {
      if (placedOrderCount > 0 && !orderScanOverBound) {
        for (const row of affected) {
          const count = await probePlacedOrders(ctx, basis, row._id);
          if (count > 0) {
            primaryAffected = row;
            break;
          }
        }
      }
      primaryAffected ??= affected[0] ?? null;
    }
    let orderImpact: "none" | "selectionOnly" | "reviewRequired" = "none";
    let impactClause: string;
    if (scan.rows.length === 0) {
      impactClause = "no selection exists for this requirement";
    } else if (affected.length === 0) {
      impactClause =
        selection === null
          ? "no selection exists for this requirement"
          : selection.quoteId === quote.value._id
            ? "the current selection already pins this revision"
            : `the current selection pins another revision (${selection.quoteVersion})`;
    } else if (orderScanOverBound) {
      orderImpact = "reviewRequired";
      impactClause = `the placed-order scan exceeded ${PLACED_ORDER_PROBE_BOUND} rows; the re-evaluation is incomplete`;
    } else if (scan.selectionScanOverBound) {
      if (placedOrderCount > 0) {
        orderImpact = "reviewRequired";
        impactClause = `${placedOrderCount} placed order(s) keep their history and need fresh approval before any substitute; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`;
      } else if (currentAffected) {
        orderImpact = "selectionOnly";
        impactClause = `the unplaced selection basis changed and can be re-decided; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`;
      } else {
        impactClause =
          selection === null
            ? `no selection exists for this requirement; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`
            : `the current selection pins another revision (${selection.quoteVersion}); historical unplaced selections create no fresh decision; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`;
      }
    } else if (lineageTruncated) {
      if (placedOrderCount > 0) {
        orderImpact = "reviewRequired";
        impactClause = `${placedOrderCount} placed order(s) keep their history and need fresh approval before any substitute; the revision lineage exceeded ${REVISION_LINEAGE_BOUND} generations, so the re-evaluation is incomplete`;
      } else if (currentAffected) {
        orderImpact = "selectionOnly";
        impactClause = `the unplaced selection basis changed and can be re-decided; the revision lineage exceeded ${REVISION_LINEAGE_BOUND} generations, so the re-evaluation is incomplete`;
      } else {
        impactClause =
          selection === null
            ? `no selection exists for this requirement; the revision lineage exceeded ${REVISION_LINEAGE_BOUND} generations, so the re-evaluation is incomplete`
            : `the current selection pins another revision (${selection.quoteVersion}); historical unplaced selections create no fresh decision; the revision lineage exceeded ${REVISION_LINEAGE_BOUND} generations, so the re-evaluation is incomplete`;
      }
    } else if (placedOrderCount > 0) {
      orderImpact = "reviewRequired";
      impactClause =
        affected.length > 1
          ? `${placedOrderCount} placed order(s) across ${affected.length} affected selection(s) keep their history and need fresh approval before any substitute`
          : `${placedOrderCount} placed order(s) keep their history and need fresh approval before any substitute`;
    } else if (selection !== null && selection.quoteId === quote.value._id) {
      // The current decision already pins the new revision while older
      // affected selections carry no placed orders: nothing to re-decide.
      impactClause = "the current selection already pins this revision";
    } else if (currentAffected) {
      orderImpact = "selectionOnly";
      impactClause =
        affected.length > 1
          ? `the unplaced selection basis changed on ${affected.length} affected selection(s) and can be re-decided`
          : "the unplaced selection basis changed and can be re-decided";
    } else {
      // The affected selections are all historical and unplaced while the
      // current selection pins another revision: no fresh decision.
      impactClause =
        selection === null
          ? "no selection exists for this requirement"
          : `the current selection pins another revision (${selection.quoteVersion}); historical unplaced selections create no fresh decision`;
    }
    if (orderImpact === "none") {
      // No fresh decision means no affected selection pointer: a `none`
      // assessment never reopens a historical selection.
      primaryAffected = null;
    }
    const { alternatives, truncated } = await evaluateAlternatives(
      ctx,
      basis,
      selection?.candidateId ?? null,
    );
    const state: "recorded" | "incomplete" =
      truncated || orderScanOverBound || scan.selectionScanOverBound || lineageTruncated
        ? "incomplete"
        : "recorded";
    const assessmentId = await ctx.db.insert("impactAssessments", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      idempotencyKey: args.idempotencyKey,
      requirementId: quote.value.requirementId,
      trigger: "quoteRevision",
      quoteId: quote.value._id,
      quoteVersion: quote.value.version,
      predecessorQuoteId: predecessor._id,
      predecessorQuoteVersion: predecessor.version,
      orderImpact,
      state,
      ...(primaryAffected !== null ? { affectedSelectionId: primaryAffected._id } : {}),
      placedOrderCount,
      reason: `Quote ${predecessor.version} was superseded by ${quote.value.version}; ${impactClause}`,
      alternatives,
      evidenceRefs: [
        { sourceId: predecessor._id, version: predecessor.version },
        { sourceId: quote.value._id, version: quote.value.version },
      ],
      createdAt: Date.now(),
    });
    return { ok: true as const, assessmentId, deduplicated: false };
  },
});

/**
 * Record the durable impact of an explicit watch observation. A failed
 * check (error/unknown) keeps the whole assessment `unknown`: availability
 * stays unknown, and placed orders are never marked delayed or otherwise
 * changed — the observation only records what is (not) known. A stale
 * observation is explicitly incomplete. Only the current selection of the
 * watched candidate is `selectionOnly`: historical unplaced selections of
 * the watched candidate create no fresh decision once the requirement is
 * re-selected, while placed orders on any watched selection still make
 * the impact `reviewRequired`. Alternatives are re-evaluated
 * from stored quote rows only.
 */
export const assessWatchObservation = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    watchId: v.id("watches"),
    result: watchResultValidator,
  },
  returns: assessmentResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "contributor");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    const watch = await requireOwnedRef(
      await ctx.db.get(args.watchId),
      args.organizationId,
      args.projectId,
    );
    if (!watch.ok) {
      return { ok: false as const, code: watch.code, message: watch.message };
    }
    const candidate = await requireOwnedRef(
      await ctx.db.get(watch.value.targetId),
      args.organizationId,
      args.projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(candidate.value.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const existing = await ctx.db
      .query("impactAssessments")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.trigger !== "watchObservation" ||
        existing.watchId !== watch.value._id ||
        existing.watchResult !== args.result
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, assessmentId: existing._id, deduplicated: true };
    }
    const basis: AssessmentBasis = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: candidate.value.requirementId,
    };
    // The watched candidate is matched against every recorded selection
    // for the requirement (bounded indexed scan), not only the latest:
    // an order placed on an older selection of the watched candidate
    // stays impacted after the requirement is re-selected. Old orders are
    // only read here, never rewritten.
    const selection = await latestSelection(ctx, basis);
    const scan = await scanSelections(ctx, basis);
    const watched = scan.rows.filter((row) => row.candidateId === watch.value.targetId);
    // Current-vs-historical separation, mirroring the quote-revision path:
    // a replaced historical selection of the watched candidate never
    // reopens a fresh decision. Only the current selection of the watched
    // candidate is `selectionOnly`; historical unplaced selections create
    // no fresh decision, while placed orders on any watched selection
    // still make the impact `reviewRequired`.
    const currentWatched =
      selection !== null && selection.candidateId === watch.value.targetId;
    const failedCheck = args.result === "error" || args.result === "unknown";
    const { placedOrderCount, orderScanOverBound } = await probePlacedOrdersAcross(
      ctx,
      basis,
      watched.map((row) => row._id),
    );
    // Primary affected selection: the latest watched selection, matching
    // the previous single-selection behavior when only one exists. A
    // `none` assessment points at no selection: a replaced historical
    // selection is never reopened.
    let primaryWatched: (typeof watched)[number] | null =
      watched.length === 0 ? null : watched[watched.length - 1]!;
    let orderImpact: "none" | "selectionOnly" | "reviewRequired" | "unknown" = "none";
    if (failedCheck) {
      orderImpact = "unknown";
    } else if (watched.length === 0) {
      orderImpact = "none";
    } else if (orderScanOverBound || scan.selectionScanOverBound || placedOrderCount > 0) {
      orderImpact = "reviewRequired";
    } else if (!currentWatched) {
      orderImpact = "none";
    } else {
      orderImpact = "selectionOnly";
    }
    if (orderImpact === "none") {
      primaryWatched = null;
    }
    let impactClause: string;
    if (failedCheck) {
      impactClause = "availability stays unknown and placed orders are unchanged";
    } else if (orderScanOverBound) {
      impactClause = `the placed-order scan exceeded ${PLACED_ORDER_PROBE_BOUND} rows; the re-evaluation is incomplete`;
    } else if (scan.selectionScanOverBound) {
      impactClause =
        placedOrderCount > 0
          ? `${placedOrderCount} placed order(s) keep their history and need fresh approval before any substitute; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`
          : `the watched candidate is not the current selection; the selection scan exceeded ${SELECTION_SCAN_BOUND} rows, so the re-evaluation is incomplete`;
    } else if (watched.length === 0) {
      impactClause = "the watched candidate is not the current selection";
    } else if (placedOrderCount > 0) {
      impactClause =
        watched.length > 1
          ? `${placedOrderCount} placed order(s) across ${watched.length} watched selection(s) keep their history and need fresh approval before any substitute`
          : `${placedOrderCount} placed order(s) keep their history and need fresh approval before any substitute`;
    } else if (!currentWatched) {
      impactClause =
        "the watched candidate is not the current selection; historical unplaced selections create no fresh decision";
    } else {
      impactClause = "the unplaced selection can be re-decided";
    }
    const observationClause =
      args.result === "ok"
        ? "Watch check reported ok; stored quote terms are unchanged unless a recorded revision says otherwise"
        : args.result === "stale"
          ? "Watch check reported stale evidence; the re-evaluation is incomplete"
          : `Watch check reported ${args.result}`;
    const { alternatives, truncated } = await evaluateAlternatives(
      ctx,
      basis,
      selection?.candidateId ?? null,
    );
    const state: "recorded" | "unknown" | "incomplete" = failedCheck
      ? "unknown"
      : truncated || orderScanOverBound || scan.selectionScanOverBound || args.result === "stale"
        ? "incomplete"
        : "recorded";
    const assessmentId = await ctx.db.insert("impactAssessments", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      idempotencyKey: args.idempotencyKey,
      requirementId: candidate.value.requirementId,
      trigger: "watchObservation",
      watchId: watch.value._id,
      watchResult: args.result,
      orderImpact,
      state,
      ...(primaryWatched !== null ? { affectedSelectionId: primaryWatched._id } : {}),
      placedOrderCount,
      reason: `${observationClause}; ${impactClause}`,
      alternatives,
      ...(watch.value.evidenceRefs === undefined
        ? {}
        : { evidenceRefs: [...watch.value.evidenceRefs] }),
      createdAt: Date.now(),
    });
    return { ok: true as const, assessmentId, deduplicated: false };
  },
});

// -- Substitute proposals ------------------------------------------------------

/**
 * Create a substitute proposal from a recorded impact assessment. The
 * proposed candidate and quote must belong to the assessment's
 * requirement, the quote must be requirement-bound and still current
 * (no recorded successor), line quantities are normalized decimals
 * capped by the quoted quantities, and a mixed requirement/quote
 * currency is refused exactly as selection refuses it. The proposal
 * starts pending and authorizes nothing by itself.
 */
export const createSubstituteProposal = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    assessmentId: v.id("impactAssessments"),
    proposedCandidateId: v.id("candidates"),
    proposedQuoteId: v.id("quotes"),
    proposedLines: v.array(
      v.object({
        quoteLineId: v.string(),
        quantity: v.string(),
        unit: v.string(),
      }),
    ),
    reason: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), proposalId: v.id("substituteProposals"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "contributor");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.reason.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "reason required" };
    }
    if (args.reason.trim().length > PROPOSAL_REASON_MAX_LENGTH) {
      return { ok: false as const, code: "invalid-payload", message: "reason exceeds the bounded length" };
    }
    const assessment = await requireOwnedRef(
      await ctx.db.get(args.assessmentId),
      args.organizationId,
      args.projectId,
    );
    if (!assessment.ok) {
      return { ok: false as const, code: assessment.code, message: assessment.message };
    }
    const candidate = await requireOwnedRef(
      await ctx.db.get(args.proposedCandidateId),
      args.organizationId,
      args.projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    if (candidate.value.requirementId !== assessment.value.requirementId) {
      return { ok: false as const, code: "denied-project", message: "proposed candidate is for another requirement" };
    }
    const quote = await requireOwnedRef(
      await ctx.db.get(args.proposedQuoteId),
      args.organizationId,
      args.projectId,
    );
    if (!quote.ok) {
      return { ok: false as const, code: quote.code, message: quote.message };
    }
    if (quote.value.requirementId !== assessment.value.requirementId) {
      return { ok: false as const, code: "denied-project", message: "proposed quote is bound to another requirement" };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(assessment.value.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    let proposedLines: NormalizedOrderLine[];
    try {
      if (args.proposedLines.length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "proposed lines required" };
      }
      const seen = new Set<string>();
      proposedLines = args.proposedLines.map((line) => {
        const lineId = line.quoteLineId.trim();
        if (lineId.length === 0) {
          throw new Error("proposed line id required");
        }
        if (seen.has(lineId)) {
          throw new Error(`proposed line ${lineId} is duplicated`);
        }
        seen.add(lineId);
        const quoted = quote.value.lines.find((entry) => entry.lineId === lineId);
        if (quoted === undefined) {
          throw new Error(`proposed line ${lineId} is not on this quote`);
        }
        const normalizedQuantity = normalizeLineQuantity(line.quantity, `proposed line ${lineId} quantity`);
        const unit = normalizeLineUnit(line.unit, `proposed line ${lineId} unit`);
        const scoped = scopedLineUnit(quote.value.comparisonScope, lineId);
        if (scoped !== undefined && scoped !== unit) {
          throw new Error(`proposed line ${lineId} unit does not match the quoted scope`);
        }
        if (decimalCompare(quantity(normalizedQuantity), decimalZero()) <= 0) {
          throw new Error(`proposed line ${lineId} quantity must be positive`);
        }
        if (decimalCompare(quantity(normalizedQuantity), quantity(quoted.quantity)) > 0) {
          throw new Error(`proposed line ${lineId} exceeds the quoted quantity`);
        }
        return { quoteLineId: lineId, quantity: normalizedQuantity, unit };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "proposed lines are invalid";
      if (message.includes("is not on this quote") || message.includes("does not match")) {
        return { ok: false as const, code: "denied-project" as const, message };
      }
      return { ok: false as const, code: "invalid-payload" as const, message };
    }
    // Replay lookup precedes current-basis checks: an exact historical
    // proposal stays replayable after its quote is later superseded; any
    // changed field conflicts without writing a second row.
    const existing = await ctx.db
      .query("substituteProposals")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.assessmentId !== assessment.value._id ||
        existing.proposedCandidateId !== candidate.value._id ||
        existing.proposedQuoteId !== quote.value._id ||
        existing.reason !== args.reason.trim() ||
        !sameLines(sortLinesById(existing.proposedLines), sortLinesById(proposedLines))
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, proposalId: existing._id, deduplicated: true };
    }
    // Authoritative candidate-to-quote lineage, mirroring recordSelection
    // (F1R-03): a quote bound to another vendor's offer, an out-of-project
    // RFQ, another requirement's RFQ, or an RFQ scope that excludes the
    // candidate vendor can never back this proposal.
    if (quote.value.vendorId !== undefined && quote.value.vendorId !== candidate.value.vendorId) {
      return { ok: false as const, code: "denied-project", message: "proposed quote is bound to another vendor offer" };
    }
    if (quote.value.rfqId !== undefined) {
      const rfq = await ctx.db.get(quote.value.rfqId);
      if (
        rfq === null ||
        rfq.organizationId !== args.organizationId ||
        rfq.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "proposed quote RFQ is not in this project" };
      }
      if (rfq.requirementId !== assessment.value.requirementId) {
        return { ok: false as const, code: "denied-project", message: "proposed quote RFQ is bound to another requirement" };
      }
      if (!rfq.scenarioVendorIds.includes(candidate.value.vendorId)) {
        return { ok: false as const, code: "denied-project", message: "proposed quote RFQ scope excludes the candidate vendor" };
      }
    }
    if (
      requirement.value.currency !== undefined &&
      requirement.value.currency !== quote.value.currency
    ) {
      return { ok: false as const, code: "invalid-payload", message: "mixed-currency-requires-accepted-conversion-basis" };
    }
    // The proposed basis must still be current: a recorded successor
    // fences the proposal at creation, deterministically.
    const successor = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_supersedes", (q) =>
        q.eq("projectId", args.projectId).eq("supersedes", quote.value.contentHash),
      )
      .first();
    if (successor !== null) {
      return { ok: false as const, code: "stale-quote-version", message: "proposed quote version has been superseded" };
    }
    const latest = await latestSelection(ctx, {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: assessment.value.requirementId,
    });
    const now = Date.now();
    const proposalId = await ctx.db.insert("substituteProposals", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      idempotencyKey: args.idempotencyKey,
      assessmentId: assessment.value._id,
      requirementId: assessment.value.requirementId,
      requirementVersion: requirement.value.version,
      ...(latest === null ? {} : { currentSelectionId: latest._id }),
      proposedCandidateId: candidate.value._id,
      proposedQuoteId: quote.value._id,
      proposedQuoteVersion: quote.value.version,
      proposedLines: sortLinesById(proposedLines),
      reason: args.reason.trim(),
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, proposalId, deduplicated: false };
  },
});

function sameLines(
  left: readonly NormalizedOrderLine[],
  right: readonly NormalizedOrderLine[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      line.quoteLineId === other.quoteLineId &&
      line.quantity === other.quantity &&
      line.unit === other.unit
    );
  });
}

/**
 * Decide a pending substitute proposal. Rejection is always available to
 * an approver while the proposal is pending. Replay safety: after
 * authorization and tenancy checks, an identical retried decision on an
 * already decided proposal returns the stable original result without
 * adding another approval row, while an opposite later decision fails as
 * a deterministic `duplicate-conflict` with no writes. Approval is
 * fenced: the requirement version, the proposed quote revision, and the
 * captured current selection identity must all still be current, so
 * changed offer terms, edited requirements, or selection drift cannot
 * let an obsolete proposal take effect (P-13). An approved proposal
 * records a fresh approvals row whose snapshot binds the exact decision
 * including the captured selection; prior selections, approvals,
 * orders, and financial rows are never touched.
 */
export const decideSubstituteProposal = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    proposalId: v.id("substituteProposals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      decisionApprovalId: v.optional(v.id("approvals")),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "approver");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const proposal = await requireOwnedRef(
      await ctx.db.get(args.proposalId),
      args.organizationId,
      args.projectId,
    );
    if (!proposal.ok) {
      return { ok: false as const, code: proposal.code, message: proposal.message };
    }
    // Decision replay safety, checked after authorization and tenancy but
    // before the pending-only rule: an identical retry returns the stable
    // original result without adding another approval row, while an
    // opposite later decision is a deterministic conflict with no writes.
    if (proposal.value.state !== "pending") {
      if (args.decision === proposal.value.state) {
        return {
          ok: true as const,
          ...(proposal.value.decisionApprovalId === undefined
            ? {}
            : { decisionApprovalId: proposal.value.decisionApprovalId }),
        };
      }
      return { ok: false as const, code: "duplicate-conflict", message: "proposal was already decided differently" };
    }
    let decisionApprovalId: Id<"approvals"> | undefined;
    if (args.decision === "approved") {
      const requirement = await ctx.db.get(proposal.value.requirementId);
      if (
        requirement === null ||
        requirement.organizationId !== args.organizationId ||
        requirement.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "proposal requirement is not in this project" };
      }
      if (requirement.version !== proposal.value.requirementVersion) {
        return { ok: false as const, code: "stale-proposal-basis", message: "requirement changed since the proposal; renewed authority required" };
      }
      const quote = await ctx.db.get(proposal.value.proposedQuoteId);
      if (
        quote === null ||
        quote.organizationId !== args.organizationId ||
        quote.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "proposed quote is not in this project" };
      }
      if (quote.version !== proposal.value.proposedQuoteVersion) {
        return { ok: false as const, code: "stale-proposal-basis", message: "proposed quote version changed; renewed authority required" };
      }
      // Bounded indexed existence probe: a recorded successor fences the
      // approval exactly as it fences new selections.
      const successor = await ctx.db
        .query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", args.projectId).eq("supersedes", quote.contentHash),
        )
        .first();
      if (successor !== null) {
        return { ok: false as const, code: "stale-proposal-basis", message: "proposed quote terms changed; renewed authority required" };
      }
      // Selection drift fence: the approval re-reads the latest selection
      // for the requirement and requires its identity to equal the value
      // captured at proposal creation, including no-selection becoming
      // selected or a selected requirement changing its selection.
      const latest = await latestSelection(ctx, {
        organizationId: args.organizationId,
        projectId: args.projectId,
        requirementId: proposal.value.requirementId,
      });
      if ((latest?._id ?? undefined) !== proposal.value.currentSelectionId) {
        return { ok: false as const, code: "stale-proposal-basis", message: "the current selection changed since the proposal; renewed authority required" };
      }
      const snapshotCanonical = canonicalJson({
        kind: "substituteProposal",
        proposalId: proposal.value._id,
        assessmentId: proposal.value.assessmentId,
        requirementId: proposal.value.requirementId,
        requirementVersion: proposal.value.requirementVersion,
        currentSelectionId: proposal.value.currentSelectionId,
        proposedCandidateId: proposal.value.proposedCandidateId,
        proposedQuoteId: proposal.value.proposedQuoteId,
        proposedQuoteVersion: proposal.value.proposedQuoteVersion,
        proposedLines: sortLinesById(proposal.value.proposedLines),
        decidedBy: access.value.identity,
      });
      const snapshotHash = await sha256HexOfCanonical(snapshotCanonical);
      decisionApprovalId = await ctx.db.insert("approvals", {
        organizationId: args.organizationId,
        projectId: args.projectId,
        scope: "substituteProposal",
        snapshotCanonical,
        snapshotHash,
        quoteId: proposal.value.proposedQuoteId,
        requirementId: proposal.value.requirementId,
        requirementVersion: proposal.value.requirementVersion,
        state: "approved",
        approver: access.value.identity,
        decidedAt: Date.now(),
        createdAt: Date.now(),
      });
    }
    const now = Date.now();
    await ctx.db.patch(args.proposalId, {
      state: args.decision,
      decidedBy: access.value.identity,
      decidedAt: now,
      updatedAt: now,
      ...(decisionApprovalId === undefined ? {} : { decisionApprovalId }),
    });
    return {
      ok: true as const,
      ...(decisionApprovalId === undefined ? {} : { decisionApprovalId }),
    };
  },
});

// -- Bounded reads -------------------------------------------------------------

/** Read one impact assessment in the caller's project (viewer access). */
export const getImpactAssessment = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    assessmentId: v.id("impactAssessments"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), assessment: v.any() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "viewer");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const assessment = await requireOwnedRef(
      await ctx.db.get(args.assessmentId),
      args.organizationId,
      args.projectId,
    );
    if (!assessment.ok) {
      return { ok: false as const, code: assessment.code, message: assessment.message };
    }
    return { ok: true as const, assessment: assessment.value };
  },
});

/** List a requirement's impact assessments, newest first (bounded read). */
export const listImpactAssessments = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      assessments: v.array(
        v.object({
          assessmentId: v.id("impactAssessments"),
          trigger: v.union(v.literal("quoteRevision"), v.literal("watchObservation")),
          state: v.union(v.literal("recorded"), v.literal("unknown"), v.literal("incomplete")),
          orderImpact: v.union(
            v.literal("none"),
            v.literal("selectionOnly"),
            v.literal("reviewRequired"),
            v.literal("unknown"),
          ),
          reason: v.string(),
          createdAt: v.number(),
        }),
      ),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "viewer");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const rows = await ctx.db
      .query("impactAssessments")
      .withIndex("by_requirement", (q) => q.eq("requirementId", args.requirementId))
      .order("desc")
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      assessments: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          assessmentId: row._id,
          trigger: row.trigger,
          state: row.state,
          orderImpact: row.orderImpact,
          reason: row.reason,
          createdAt: row.createdAt,
        })),
    };
  },
});

/** Read one substitute proposal in the caller's project (viewer access). */
export const getSubstituteProposal = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    proposalId: v.id("substituteProposals"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), proposal: v.any() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "viewer");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const proposal = await requireOwnedRef(
      await ctx.db.get(args.proposalId),
      args.organizationId,
      args.projectId,
    );
    if (!proposal.ok) {
      return { ok: false as const, code: proposal.code, message: proposal.message };
    }
    return { ok: true as const, proposal: proposal.value };
  },
});

/** List a requirement's substitute proposals, newest first (bounded read). */
export const listSubstituteProposals = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      proposals: v.array(
        v.object({
          proposalId: v.id("substituteProposals"),
          assessmentId: v.id("impactAssessments"),
          proposedCandidateId: v.id("candidates"),
          proposedQuoteId: v.id("quotes"),
          proposedQuoteVersion: v.string(),
          state: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
          reason: v.string(),
          createdAt: v.number(),
        }),
      ),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(ctx, args.organizationId, args.projectId, "viewer");
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const rows = await ctx.db
      .query("substituteProposals")
      .withIndex("by_requirement", (q) => q.eq("requirementId", args.requirementId))
      .order("desc")
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      proposals: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          proposalId: row._id,
          assessmentId: row.assessmentId,
          proposedCandidateId: row.proposedCandidateId,
          proposedQuoteId: row.proposedQuoteId,
          proposedQuoteVersion: row.proposedQuoteVersion,
          state: row.state,
          reason: row.reason,
          createdAt: row.createdAt,
        })),
    };
  },
});
