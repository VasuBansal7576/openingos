/**
 * F1 fulfillment graph (controlled contract, PRD 17, ADR-0003).
 *
 * Orders record externally placed commitments against a selection;
 * selection changes forecast, only recorded orders change commitments.
 * Order events track confirmation through commissioning with accepted
 * quantities kept separate from ordered quantities. Cost entries record
 * payments, settled costs, refunds, and credits with idempotency keys;
 * a price-reducing credit changes the obligation once and a cash refund
 * changes applied payments once (linked, never double-subtracted).
 * Commissioning creates installed-asset provenance; service cases track
 * equipment issues against those assets.
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalAdd,
  decimalCompare,
  decimalToString,
  decimalZero,
  parseDecimalString,
  quantity,
  type Decimal,
} from "../../proofs/money/decimal.js";
import {
  assetDocumentInputValidator,
  assetInputValidator,
  costEntryInputValidator,
  normalizeLineQuantity,
  normalizeLineUnit,
  orderEventInputValidator,
  orderInputValidator,
  scopedLineUnit,
  serviceCaseInputValidator,
  sortLinesById,
  storedOrderLineValidator,
  type NormalizedAcceptanceLine,
  type NormalizedOrderLine,
} from "../shared/domainContracts.js";
import { checkMoney } from "../shared/money.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";
import { storedSelectionLines } from "./decisions.js";

const orderResultValidator = v.union(
  v.object({ ok: v.literal(true), orderId: v.id("orders"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * F1R-16 reload bound: at most this many events and cost entries per
 * lineage call. One row past the bound is probed to detect truncation;
 * over-bound histories return explicit incompleteness, never prefix
 * aggregates labeled complete.
 */
const ORDER_LINEAGE_HISTORY_BOUND = 200;

/**
 * Greptile r4056517360: the prior-order commitment scan is bounded.
 * At most this many orders on one selection are read inside a single
 * commitment mutation, so the read set can never approach Convex
 * transaction limits no matter how long the selection history grows.
 * A selection breaching the bound denies new commitments with explicit
 * incompleteness instead of undercounting them; exact replays return
 * before this scan and are unaffected.
 */
const SELECTION_ORDER_SCAN_BOUND = 100;

/**
 * Coordinator broaden-behind-r4056517360: the per-line acceptance
 * accumulation scan is bounded the same way. At most this many prior
 * events on one order are read inside a single acceptance mutation —
 * two orders of magnitude above demonstrated histories and far below
 * transaction limits. An order breaching the bound denies new
 * acceptances with explicit incompleteness instead of undercounting
 * them; exact replays return before this scan and are unaffected.
 */
const ORDER_EVENT_SCAN_BOUND = 1000;

// -- F1R-13 effective-line helpers (no I/O) ----------------------------------

type QuoteLineRef = {
  readonly lines: readonly { readonly lineId: string }[];
  readonly comparisonScope?: {
    readonly items: readonly { readonly lineId: string; readonly unit: string }[];
  };
};

/**
 * Effective normalized selection lines for an in-project selection plus
 * its quote. Current rows carry `selectionLines`; pre-F1R-13 rows carry
 * only the scalar mirror and resolve single-line from the quote.
 */
function effectiveSelectionLines(
  selection: { readonly quantity?: string; readonly selectionLines?: readonly NormalizedOrderLine[] },
  quote: QuoteLineRef,
): NormalizedOrderLine[] {
  if (selection.selectionLines !== undefined) return [...selection.selectionLines];
  if (selection.quantity === undefined || quote.lines.length !== 1) return [];
  const only = quote.lines[0];
  if (only === undefined) return [];
  let normalized: string;
  try {
    normalized = decimalToString(quantity(selection.quantity));
  } catch {
    return [];
  }
  return [{
    quoteLineId: only.lineId,
    quantity: normalized,
    unit: scopedLineUnit(quote.comparisonScope, only.lineId) ?? "",
  }];
}

/**
 * Effective normalized order lines for an in-project order. Current rows
 * carry `orderLines`; pre-F1R-13 rows carry only the scalar mirror and
 * resolve single-line from the selection's effective lines.
 */
function effectiveOrderLines(
  order: { readonly orderedQuantity?: string; readonly orderLines?: readonly NormalizedOrderLine[] },
  selectionLines: readonly NormalizedOrderLine[],
): NormalizedOrderLine[] {
  if (order.orderLines !== undefined) return [...order.orderLines];
  if (order.orderedQuantity === undefined || selectionLines.length !== 1) return [];
  const only = selectionLines[0];
  if (only === undefined) return [];
  let normalized: string;
  try {
    normalized = decimalToString(quantity(order.orderedQuantity));
  } catch {
    return [];
  }
  return [{ quoteLineId: only.quoteLineId, quantity: normalized, unit: only.unit }];
}

/**
 * Effective normalized acceptances for a stored event. Current rows carry
 * `acceptanceLines`; pre-F1R-13 rows carry only the scalar mirror and
 * resolve single-line from the order's effective lines.
 */
function effectiveEventAcceptances(
  event: { readonly acceptedQuantity?: string; readonly acceptanceLines?: readonly NormalizedAcceptanceLine[] },
  orderLines: readonly NormalizedOrderLine[],
): NormalizedAcceptanceLine[] {
  if (event.acceptanceLines !== undefined) return [...event.acceptanceLines];
  if (event.acceptedQuantity === undefined || orderLines.length !== 1) return [];
  const only = orderLines[0];
  if (only === undefined) return [];
  let normalized: string;
  try {
    normalized = decimalToString(parseDecimalString(event.acceptedQuantity, "accepted quantity"));
  } catch {
    return [];
  }
  return [{ quoteLineId: only.quoteLineId, acceptedQuantity: normalized, unit: only.unit }];
}

function sameOrderLines(
  left: readonly NormalizedOrderLine[],
  right: readonly NormalizedOrderLine[],
): boolean {
  const orderedLeft = sortLinesById(left);
  const orderedRight = sortLinesById(right);
  if (orderedLeft.length !== orderedRight.length) return false;
  return orderedLeft.every((line, index) => {
    const other = orderedRight[index];
    return (
      other !== undefined &&
      line.quoteLineId === other.quoteLineId &&
      line.quantity === other.quantity &&
      line.unit === other.unit
    );
  });
}

function sameAcceptanceLines(
  left: readonly NormalizedAcceptanceLine[],
  right: readonly NormalizedAcceptanceLine[],
): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort((a, b) => (a.quoteLineId < b.quoteLineId ? -1 : a.quoteLineId > b.quoteLineId ? 1 : 0));
  const orderedRight = [...right].sort((a, b) => (a.quoteLineId < b.quoteLineId ? -1 : a.quoteLineId > b.quoteLineId ? 1 : 0));
  return orderedLeft.every((line, index) => {
    const other = orderedRight[index];
    return (
      other !== undefined &&
      line.quoteLineId === other.quoteLineId &&
      line.acceptedQuantity === other.acceptedQuantity &&
      line.unit === other.unit
    );
  });
}

/**
 * Record an externally placed order. The order pins the selection's full
 * lineage (requirement, quote, exact quote version, requirement version)
 * so fulfillment never floats free of the decision it executes. The
 * commitment is per-line (F1R-13): explicit `orderLines` name every
 * selected line with normalized quantity and unit, each capped by its
 * selected line quantity; the legacy scalar `orderedQuantity` derives
 * the single effective line for one-line selections only and is rejected
 * as ambiguous otherwise. The idempotency key is unique per project: a
 * replay with the identical normalized line payload returns the existing
 * row, while a replay with different lines is a `duplicate-conflict` so
 * a collision can never silently swap the commitment.
 */
export const recordOrder = f1Mutation({
  args: orderInputValidator.fields,
  returns: orderResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.orderLines !== undefined && args.orderedQuantity !== undefined) {
      return { ok: false as const, code: "invalid-payload", message: "supply either order lines or a single ordered quantity, not both" };
    }
    // F1R-17: exact historical replay precedes new-write validation. A
    // scalar call looks up its explicit key before the selection is ever
    // loaded, so a stored pre-F1R-13 row (scalar quantity only, accepted
    // by the old handlers without any line mapping) is recognized before
    // multi-line or cap rules for new records can reject it. No lineage
    // is invented: the stored row is compared field-for-field and
    // returned as-is.
    if (args.orderLines === undefined && args.orderedQuantity !== undefined) {
      let historicalOrdered: string;
      try {
        historicalOrdered = normalizeLineQuantity(args.orderedQuantity, "ordered quantity");
      } catch (error) {
        return { ok: false as const, code: "invalid-payload", message: error instanceof Error ? error.message : "ordered quantity is not a valid decimal" };
      }
      const historical = await ctx.db
        .query("orders")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (historical !== null && historical.orderLines === undefined) {
        let storedOrdered: string | null = null;
        try {
          storedOrdered = historical.orderedQuantity === undefined
            ? null
            : decimalToString(quantity(historical.orderedQuantity));
        } catch {
          storedOrdered = null;
        }
        if (
          storedOrdered !== null &&
          historical.organizationId === args.organizationId &&
          historical.selectionId === args.selectionId &&
          storedOrdered === historicalOrdered &&
          (historical.supplierReference ?? undefined) === args.supplierReference
        ) {
          return { ok: true as const, orderId: historical._id, deduplicated: true };
        }
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
    }
    // Shape-normalize explicit lines before any read, so the replay key
    // binds the complete normalized payload. Line-against-selection
    // checks follow the replay lookup.
    let shapedLines: NormalizedOrderLine[] | null = null;
    if (args.orderLines !== undefined) {
      try {
        if (args.orderLines.length === 0) {
          return { ok: false as const, code: "invalid-payload", message: "order lines required" };
        }
        const seen = new Set<string>();
        shapedLines = args.orderLines.map((line) => {
          const lineId = line.quoteLineId.trim();
          if (lineId.length === 0) throw new Error("order line id required");
          if (seen.has(lineId)) throw new Error(`order line ${lineId} is duplicated`);
          seen.add(lineId);
          return {
            quoteLineId: lineId,
            quantity: normalizeLineQuantity(line.quantity, `order line ${lineId} quantity`),
            unit: normalizeLineUnit(line.unit, `order line ${lineId} unit`),
          };
        });
      } catch (error) {
        return { ok: false as const, code: "invalid-payload", message: error instanceof Error ? error.message : "order lines are invalid" };
      }
      const replayed = await ctx.db
        .query("orders")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (replayed !== null) {
        if (replayed.organizationId !== args.organizationId) {
          return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
        }
        const replayedLines = replayed.orderLines !== undefined ? [...replayed.orderLines] : [];
        const sameSupplier =
          (replayed.supplierReference ?? undefined) === args.supplierReference;
        if (
          replayed.selectionId !== args.selectionId ||
          !sameOrderLines(replayedLines, sortLinesById(shapedLines)) ||
          !sameSupplier
        ) {
          return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
        }
        return { ok: true as const, orderId: replayed._id, deduplicated: true };
      }
    }
    const selection = await requireOwnedRef(
      await ctx.db.get(args.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    const selectionLines = effectiveSelectionLines(selection.value, quote);
    if (selectionLines.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "selection carries no resolvable lines" };
    }
    // Resolve the complete normalized effective line payload: explicit
    // lines validated here, or the legacy scalar derived single-line.
    let effectiveLines: NormalizedOrderLine[];
    if (shapedLines !== null) {
      effectiveLines = sortLinesById(shapedLines);
    } else {
      if (args.orderedQuantity === undefined) {
        return { ok: false as const, code: "invalid-payload", message: "order lines or an ordered quantity required" };
      }
      if (selectionLines.length !== 1) {
        return { ok: false as const, code: "invalid-payload", message: "multi-line selections require explicit order lines" };
      }
      const only = selectionLines[0];
      if (only === undefined) {
        return { ok: false as const, code: "invalid-payload", message: "selection carries no resolvable lines" };
      }
      let normalizedOrdered: string;
      try {
        normalizedOrdered = decimalToString(quantity(args.orderedQuantity));
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "ordered quantity is not a valid decimal" };
      }
      try {
        if (decimalCompare(quantity(normalizedOrdered), decimalZero()) <= 0) {
          return { ok: false as const, code: "invalid-payload", message: "ordered quantity must be positive" };
        }
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "ordered quantity is not a valid decimal" };
      }
      effectiveLines = [{ quoteLineId: only.quoteLineId, quantity: normalizedOrdered, unit: only.unit }];
      const legacyReplayed = await ctx.db
        .query("orders")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (legacyReplayed !== null) {
        if (legacyReplayed.organizationId !== args.organizationId) {
          return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
        }
        const legacyLines = effectiveOrderLines(
          legacyReplayed,
          effectiveSelectionLines(selection.value, quote),
        );
        const sameSupplier =
          (legacyReplayed.supplierReference ?? undefined) === args.supplierReference;
        if (
          legacyReplayed.selectionId !== args.selectionId ||
          !sameOrderLines(legacyLines, effectiveLines) ||
          !sameSupplier
        ) {
          return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
        }
        return { ok: true as const, orderId: legacyReplayed._id, deduplicated: true };
      }
    }
    // Every ordered line must resolve to a quoted and selected line with
    // a matching unit, and no line may order more than was selected.
    // Quantities compare in normalized decimal form so `1` and `1.0`
    // replay as the same commitment instead of conflicting.
    const selectedByLine = new Map(selectionLines.map((line) => [line.quoteLineId, line]));
    for (const line of effectiveLines) {
      const selected = selectedByLine.get(line.quoteLineId);
      if (selected === undefined) {
        return { ok: false as const, code: "denied-project", message: `order line ${line.quoteLineId} is not on this selection` };
      }
      if (!quote.lines.some((entry) => entry.lineId === line.quoteLineId)) {
        return { ok: false as const, code: "denied-project", message: `order line ${line.quoteLineId} is not on this quote` };
      }
      if (selected.unit !== "" && line.unit !== selected.unit) {
        return { ok: false as const, code: "invalid-payload", message: `order line ${line.quoteLineId} unit does not match the selected unit` };
      }
      const scoped = scopedLineUnit(quote.comparisonScope, line.quoteLineId);
      if ((selected.unit === "" || line.unit === "") && scoped !== undefined && line.unit !== scoped && line.unit !== "") {
        return { ok: false as const, code: "invalid-payload", message: `order line ${line.quoteLineId} unit does not match the quoted scope` };
      }
      let ordered: Decimal;
      let capped: Decimal;
      try {
        ordered = quantity(line.quantity);
        capped = quantity(selected.quantity);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "stored selected quantity is invalid" };
      }
      if (decimalCompare(ordered, decimalZero()) <= 0) {
        return { ok: false as const, code: "invalid-payload", message: "ordered quantity must be positive" };
      }
      if (decimalCompare(ordered, capped) > 0) {
        return { ok: false as const, code: "invalid-payload", message: `order line ${line.quoteLineId} exceeds the selected quantity` };
      }
    }
    // F1R-14: cumulative commitment cap across every order on this
    // selection. Prior orders count toward each selected line, so a new
    // idempotency key can never reset the allowance: split orders may
    // cover the selected quantity together, but their combined lines can
    // never exceed it. The bounded scan and the insert below execute in
    // one atomic mutation transaction, so concurrent excess attempts
    // conflict on the shared selection range and the loser rechecks on
    // retry instead of double-committing. Exact replays return above,
    // before this cap is enforced.
    const committedByLine = new Map<string, Decimal>();
    const priors = await ctx.db
      .query("orders")
      .withIndex("by_selection", (q) => q.eq("selectionId", args.selectionId))
      .take(SELECTION_ORDER_SCAN_BOUND + 1);
    if (priors.length > SELECTION_ORDER_SCAN_BOUND) {
      return {
        ok: false as const,
        code: "incomplete-history",
        message: "selection carries more orders than the commitment scan bound; new commitments are unavailable until history is reconciled",
      };
    }
    let ambiguousHistory = false;
    for (const prior of priors) {
      if (
        prior.organizationId !== args.organizationId ||
        prior.projectId !== args.projectId
      ) {
        continue;
      }
      // Greptile r4056517364: a prior scalar commitment that cannot be
      // resolved to lines (legacy row behind a multi-line selection, or
      // a row with no quantity at all) must never contribute zero
      // silently. It flags the history ambiguous so the new commitment
      // is denied below instead of undercounting toward over-ordering.
      const priorLines = effectiveOrderLines(prior, selectionLines);
      if (priorLines.length === 0 && prior.orderLines === undefined) {
        ambiguousHistory = true;
        continue;
      }
      for (const priorLine of priorLines) {
        try {
          const priorQuantity = quantity(priorLine.quantity);
          const running = committedByLine.get(priorLine.quoteLineId);
          committedByLine.set(
            priorLine.quoteLineId,
            running === undefined ? priorQuantity : decimalAdd(running, priorQuantity),
          );
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "stored ordered quantity is invalid" };
        }
      }
    }
    if (ambiguousHistory) {
      return {
        ok: false as const,
        code: "incomplete-history",
        message: "selection carries ambiguous historical commitments that cannot be capped per line; new commitments are unavailable until history is reconciled",
      };
    }
    for (const line of effectiveLines) {
      const selected = selectedByLine.get(line.quoteLineId);
      if (selected === undefined) continue;
      let wanted: Decimal;
      let cap: Decimal;
      try {
        wanted = quantity(line.quantity);
        cap = quantity(selected.quantity);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "stored selected quantity is invalid" };
      }
      const committed = committedByLine.get(line.quoteLineId) ?? decimalZero();
      if (decimalCompare(decimalAdd(committed, wanted), cap) > 0) {
        return { ok: false as const, code: "invalid-payload", message: `order line ${line.quoteLineId} exceeds the remaining selected quantity` };
      }
    }
    const now = Date.now();
    const orderId = await ctx.db.insert("orders", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      selectionId: args.selectionId,
      requirementId: selection.value.requirementId,
      quoteId: selection.value.quoteId,
      quoteVersion: selection.value.quoteVersion,
      requirementVersion: selection.value.requirementVersion,
      idempotencyKey: args.idempotencyKey,
      ...(effectiveLines.length === 1 && effectiveLines[0] !== undefined
        ? { orderedQuantity: effectiveLines[0].quantity }
        : {}),
      orderLines: sortLinesById(effectiveLines),
      ...(args.supplierReference === undefined ? {} : { supplierReference: args.supplierReference }),
      state: "recorded",
      amendmentCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, orderId, deduplicated: false };
  },
});

/** List orders for a project (bounded through the project index). */
export const listOrders = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      orders: v.array(
        v.object({
          id: v.id("orders"),
          state: v.string(),
          // The legacy scalar mirror is present only for single-line
          // orders; multi-line orders carry `orderLines` alone.
          orderedQuantity: v.optional(v.string()),
          orderLines: v.array(storedOrderLineValidator),
        }),
      ),
    }),
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
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      orders: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          id: row._id,
          state: row.state,
          ...(row.orderedQuantity === undefined ? {} : { orderedQuantity: row.orderedQuantity }),
          orderLines: row.orderLines !== undefined ? [...row.orderLines] : [],
        })),
    };
  },
});

/**
 * Append an order event (confirmation through commissioning). The order
 * must live in the caller's project; accepted quantities are recorded
 * per order line (F1R-13) and kept separate from ordered quantities.
 * Accepted units accumulate per line across the order's exact event
 * history and can never exceed that line's ordered quantity — never the
 * whole order total. Explicit `acceptanceLines` name every accepted
 * line; the legacy scalar `acceptedQuantity` derives the single
 * acceptance for one-line orders only and is rejected as ambiguous
 * otherwise.
 */
export const appendOrderEvent = f1Mutation({
  args: orderEventInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), eventId: v.id("orderEvents"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.acceptanceLines !== undefined && args.acceptedQuantity !== undefined) {
      return { ok: false as const, code: "invalid-payload", message: "supply either acceptance lines or a single accepted quantity, not both" };
    }
    // Shape-normalize explicit acceptances before any read, so replay
    // binds the complete normalized line payload. Accepted quantities
    // compare normalized so `1` and `1.0` replay as the same event.
    let shapedAcceptances: NormalizedAcceptanceLine[] | null = null;
    if (args.acceptanceLines !== undefined) {
      try {
        if (args.acceptanceLines.length === 0) {
          return { ok: false as const, code: "invalid-payload", message: "acceptance lines required" };
        }
        const seen = new Set<string>();
        shapedAcceptances = args.acceptanceLines.map((line) => {
          const lineId = line.quoteLineId.trim();
          if (lineId.length === 0) throw new Error("acceptance line id required");
          if (seen.has(lineId)) throw new Error(`acceptance line ${lineId} is duplicated`);
          seen.add(lineId);
          return {
            quoteLineId: lineId,
            acceptedQuantity: normalizeLineQuantity(line.acceptedQuantity, `acceptance line ${lineId} quantity`),
            unit: normalizeLineUnit(line.unit, `acceptance line ${lineId} unit`),
          };
        });
      } catch (error) {
        return { ok: false as const, code: "invalid-payload", message: error instanceof Error ? error.message : "acceptance lines are invalid" };
      }
    }
    let legacyAccepted: string | null = null;
    if (args.acceptedQuantity !== undefined) {
      try {
        legacyAccepted = decimalToString(
          parseDecimalString(args.acceptedQuantity, "accepted quantity"),
        );
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "accepted quantity is not a valid decimal" };
      }
    }
    const existing = await ctx.db
      .query("orderEvents")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const existingLines = existing.acceptanceLines !== undefined ? [...existing.acceptanceLines] : [];
      // Replay binds the complete normalized acceptance payload. New
      // rows always store per-line acceptances, so an explicit replay
      // compares per-line; a legacy scalar replay matches a stored
      // single acceptance by quantity, or a pre-F1R-13 scalar mirror.
      let sameLines: boolean;
      if (shapedAcceptances !== null) {
        sameLines = existingLines.length > 0 &&
          sameAcceptanceLines(existingLines, shapedAcceptances);
      } else if (legacyAccepted !== null) {
        const singleStored = existingLines.length === 1 ? existingLines[0] : undefined;
        sameLines = (singleStored !== undefined && singleStored.acceptedQuantity === legacyAccepted) ||
          (existingLines.length === 0 &&
            (existing.acceptedQuantity ?? undefined) === legacyAccepted);
      } else {
        sameLines = existingLines.length === 0 && existing.acceptedQuantity === undefined;
      }
      const sameNote = (existing.note ?? undefined) === args.note;
      if (
        existing.orderId !== args.orderId ||
        existing.kind !== args.kind ||
        !sameLines ||
        !sameNote
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, eventId: existing._id, deduplicated: true };
    }
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    const selection = await requireOwnedRef(
      await ctx.db.get(order.value.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    const orderLines = effectiveOrderLines(
      order.value,
      effectiveSelectionLines(selection.value, quote),
    );
    if (orderLines.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "order carries no resolvable lines" };
    }
    // Resolve the complete normalized acceptance payload.
    let effectiveAcceptances: NormalizedAcceptanceLine[];
    if (shapedAcceptances !== null) {
      effectiveAcceptances = [...shapedAcceptances].sort((a, b) =>
        a.quoteLineId < b.quoteLineId ? -1 : a.quoteLineId > b.quoteLineId ? 1 : 0,
      );
    } else if (legacyAccepted !== null) {
      if (orderLines.length !== 1) {
        return { ok: false as const, code: "invalid-payload", message: "multi-line orders require explicit acceptance lines" };
      }
      const only = orderLines[0];
      if (only === undefined) {
        return { ok: false as const, code: "invalid-payload", message: "order carries no resolvable lines" };
      }
      effectiveAcceptances = [{
        quoteLineId: only.quoteLineId,
        acceptedQuantity: legacyAccepted,
        unit: only.unit,
      }];
    } else {
      effectiveAcceptances = [];
    }
    const orderedByLine = new Map(orderLines.map((line) => [line.quoteLineId, line]));
    for (const line of effectiveAcceptances) {
      const ordered = orderedByLine.get(line.quoteLineId);
      if (ordered === undefined) {
        return { ok: false as const, code: "denied-project", message: `acceptance line ${line.quoteLineId} is not on this order` };
      }
      if (ordered.unit !== "" && line.unit !== ordered.unit) {
        return { ok: false as const, code: "invalid-payload", message: `acceptance line ${line.quoteLineId} unit does not match the ordered unit` };
      }
    }
    if (effectiveAcceptances.length > 0) {
      // Per-line accumulation: every prior acceptance for the same line
      // counts toward that line's ordered cap. A line that would exceed
      // its own ordered quantity is rejected even when the order total
      // would still fit. Greptile r4056517364: a prior scalar acceptance
      // that cannot be resolved to lines (legacy mirror behind a
      // multi-line order) must never contribute zero silently. It flags
      // the history ambiguous so the new acceptance is denied below
      // instead of undercounting toward over-acceptance. Exact replays
      // return above, before this accumulation.
      const cumulativeByLine = new Map<string, Decimal>();
      for (const line of effectiveAcceptances) {
        try {
          cumulativeByLine.set(line.quoteLineId, quantity(line.acceptedQuantity));
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "accepted quantity is not a valid decimal" };
        }
      }
      const priorEvents = await ctx.db
        .query("orderEvents")
        .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
        .take(ORDER_EVENT_SCAN_BOUND + 1);
      if (priorEvents.length > ORDER_EVENT_SCAN_BOUND) {
        return {
          ok: false as const,
          code: "incomplete-history",
          message: "order carries more events than the acceptance scan bound; new acceptances are unavailable until history is reconciled",
        };
      }
      for (const prior of priorEvents) {
        if (
          prior.organizationId !== args.organizationId ||
          prior.projectId !== args.projectId
        ) {
          continue;
        }
        if (
          prior.acceptedQuantity !== undefined &&
          prior.acceptanceLines === undefined &&
          orderLines.length !== 1
        ) {
          return {
            ok: false as const,
            code: "incomplete-history",
            message: "order carries ambiguous historical acceptances that cannot be capped per line; new acceptances are unavailable until history is reconciled",
          };
        }
        for (const priorLine of effectiveEventAcceptances(prior, orderLines)) {
          const running = cumulativeByLine.get(priorLine.quoteLineId);
          if (running === undefined) continue;
          try {
            cumulativeByLine.set(
              priorLine.quoteLineId,
              decimalAdd(running, quantity(priorLine.acceptedQuantity)),
            );
          } catch {
            return { ok: false as const, code: "invalid-payload", message: "stored accepted quantity is invalid" };
          }
        }
      }
      for (const line of effectiveAcceptances) {
        const ordered = orderedByLine.get(line.quoteLineId);
        if (ordered === undefined) continue;
        let cap: Decimal;
        try {
          cap = quantity(ordered.quantity);
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "stored ordered quantity is invalid" };
        }
        const cumulative = cumulativeByLine.get(line.quoteLineId);
        if (cumulative !== undefined && decimalCompare(cumulative, cap) > 0) {
          return { ok: false as const, code: "invalid-payload", message: `acceptance line ${line.quoteLineId} exceeds the ordered quantity` };
        }
      }
    }
    // The stored row keeps the authoritative per-line acceptances. The
    // legacy scalar mirror is written only for single-acceptance events.
    const eventId = await ctx.db.insert("orderEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      orderId: args.orderId,
      kind: args.kind,
      ...(effectiveAcceptances.length === 1 && effectiveAcceptances[0] !== undefined
        ? { acceptedQuantity: effectiveAcceptances[0].acceptedQuantity }
        : {}),
      ...(effectiveAcceptances.length === 0
        ? {}
        : { acceptanceLines: [...effectiveAcceptances] }),
      ...(args.note === undefined ? {} : { note: args.note }),
      recordedBy: access.value.identity,
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, eventId, deduplicated: false };
  },
});

const costEntryResultValidator = v.union(
  v.object({ ok: v.literal(true), entryId: v.id("costEntries"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Record a payment, settled cost, refund, or credit. The idempotency key
 * is unique per project: a replay with identical fields returns the
 * existing row, while a replay with different order, kind, amount, line,
 * quantity, evidence, or link is a `duplicate-conflict` so a collision
 * can never silently swap cash. Linked credit/refund pairs reference
 * each other without subtracting either twice (that rule lives in the
 * budget engine, which reads each entry exactly once).
 *
 * F1R-13 adjustment lineage: credits and refunds must name the affected
 * order line and quantity with nonempty immutable evidence; payments and
 * settled costs may stay order-level (no line fields) or name a complete
 * line triple. Every evidence reference is validated — same authorized
 * project and matching content hash — before any new write, and the
 * exact references are stored. F1R-17: an exact stored command replays
 * before those new-write rules, so pre-F1R-13 entries without line or
 * evidence fields remain replayable without inventing lineage. A linked entry must form a credit/refund
 * pair on the same order, line, quantity, and currency, and neither side
 * may be paired twice, so entries cannot be silently cross-linked or
 * double-counted. Quote-level shared charges stay quote-level: no line
 * allocation is ever inferred from descriptions.
 */
export const recordCostEntry = f1Mutation({
  args: costEntryInputValidator.fields,
  returns: costEntryResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    // F1R-09: cost-entry money validates through the accepted
    // proofs/money contract before any write. Nonfinite, fractional,
    // or unsafe minor units and invalid currency are denied; zero and
    // negative amounts are forbidden for every entry kind.
    let checkedAmount: { currency: string; minorUnits: number };
    try {
      checkedAmount = checkMoney(args.amount, "entry amount");
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "entry amount is invalid" };
    }
    if (checkedAmount.minorUnits <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "entry amount must be positive" };
    }
    // The line triple is all-or-nothing: a line without a quantity (or a
    // quantity without a line) never writes.
    const hasLine = args.quoteLineId !== undefined;
    const hasQuantity = args.affectedQuantity !== undefined;
    const hasUnit = args.affectedUnit !== undefined;
    if (hasLine !== hasQuantity || hasLine !== hasUnit) {
      return { ok: false as const, code: "invalid-payload", message: "order line, affected quantity, and affected unit are required together" };
    }
    let normalizedLineId: string | undefined;
    let normalizedAffected: string | undefined;
    let normalizedAffectedUnit: string | undefined;
    if (hasLine && hasQuantity && hasUnit) {
      normalizedLineId = args.quoteLineId?.trim();
      if (normalizedLineId === undefined || normalizedLineId.length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "order line id required" };
      }
      try {
        normalizedAffected = normalizeLineQuantity(args.affectedQuantity ?? "", "affected quantity");
        normalizedAffectedUnit = normalizeLineUnit(args.affectedUnit ?? "", "affected unit");
      } catch (error) {
        return { ok: false as const, code: "invalid-payload", message: error instanceof Error ? error.message : "affected quantity is invalid" };
      }
    }
    const evidenceRefs = args.evidenceRefs !== undefined ? [...args.evidenceRefs] : [];
    for (const ref of evidenceRefs) {
      if (ref.contentHash.trim().length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "evidence content hash required" };
      }
    }
    // F1R-17: exact historical replay precedes new-write validation. The
    // lookup compares the complete stored command — order, kind, exact
    // money, link, line triple, and evidence references, with absent
    // fields matching only absent fields — so a stored pre-F1R-13 entry
    // (no affected line or evidence, accepted by the old handlers) is
    // recognized before triple, evidence, currency, or pairing rules for
    // new records can reject it. No lineage is invented: the stored row
    // is returned as-is, and any material change conflicts.
    const existing = await ctx.db
      .query("costEntries")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameLink =
        (existing.linkedEntryId ?? undefined) === args.linkedEntryId;
      const sameLine = (existing.quoteLineId ?? undefined) === normalizedLineId;
      const sameAffected = (existing.affectedQuantity ?? undefined) === normalizedAffected;
      const sameUnit = (existing.affectedUnit ?? undefined) === normalizedAffectedUnit;
      const existingRefs = existing.evidenceRefs !== undefined ? [...existing.evidenceRefs] : [];
      const sameEvidence = existingRefs.length === evidenceRefs.length &&
        existingRefs.every((stored, index) => {
          const wanted = evidenceRefs[index];
          return wanted !== undefined &&
            stored.evidenceId === wanted.evidenceId &&
            stored.contentHash === wanted.contentHash;
        });
      if (
        existing.orderId !== args.orderId ||
        existing.kind !== args.kind ||
        existing.amount.currency !== checkedAmount.currency ||
        existing.amount.minorUnits !== checkedAmount.minorUnits ||
        !sameLink ||
        !sameLine ||
        !sameAffected ||
        !sameUnit ||
        !sameEvidence
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, entryId: existing._id, deduplicated: true };
    }
    if (args.kind === "credit" || args.kind === "refund") {
      if (normalizedLineId === undefined || normalizedAffected === undefined || normalizedAffectedUnit === undefined) {
        return { ok: false as const, code: "invalid-payload", message: `${args.kind} must name the affected order line and quantity` };
      }
      if (evidenceRefs.length === 0) {
        return { ok: false as const, code: "invalid-payload", message: `${args.kind} requires nonempty evidence` };
      }
    }
    // Financial evidence validates before any new write: each
    // referenced immutable evidence row must live in the authorized
    // project and its stored hash must equal the referenced hash.
    // (Exact replays already returned above, so this never re-validates
    // the evidence behind a stored historical command.)
    for (const ref of evidenceRefs) {
      const evidence = await ctx.db.get(ref.evidenceId);
      if (
        evidence === null ||
        evidence.organizationId !== args.organizationId ||
        evidence.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "evidence is not in this project" };
      }
      if (evidence.contentHash !== ref.contentHash) {
        return { ok: false as const, code: "invalid-payload", message: "evidence content hash does not match" };
      }
    }
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    // Currency lineage: the entry currency must match the quote currency
    // pinned on the order, so mixed-currency cash can never slip in
    // without an accepted conversion basis.
    const selection = await requireOwnedRef(
      await ctx.db.get(order.value.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    if (checkedAmount.currency !== quote.currency) {
      return { ok: false as const, code: "invalid-payload", message: "mixed-currency-requires-accepted-conversion-basis" };
    }
    if (normalizedLineId !== undefined) {
      if (!quote.lines.some((entry) => entry.lineId === normalizedLineId)) {
        return { ok: false as const, code: "denied-project", message: `order line ${normalizedLineId} is not on this quote` };
      }
      const orderLines = effectiveOrderLines(
        order.value,
        effectiveSelectionLines(selection.value, quote),
      );
      const orderedLine = orderLines.find((entry) => entry.quoteLineId === normalizedLineId);
      if (orderedLine === undefined) {
        return { ok: false as const, code: "denied-project", message: `order line ${normalizedLineId} is not on this order` };
      }
      // F1R-15: the adjustment binds to the effective order line even
      // when the quote carries no comparison scope. The affected unit
      // must equal the ordered unit (a quantity-changing amendment or an
      // explicit unit conversion needs its own validated basis), and the
      // affected quantity must fit inside the ordered line quantity.
      // Order lines predating units carry an empty unit and accept any
      // nonempty affected unit as valid legacy lineage.
      if (orderedLine.unit !== "" && normalizedAffectedUnit !== orderedLine.unit) {
        return { ok: false as const, code: "invalid-payload", message: `order line ${normalizedLineId} unit does not match the ordered unit` };
      }
      try {
        const affected = quantity(normalizedAffected ?? "");
        const ordered = quantity(orderedLine.quantity);
        if (decimalCompare(affected, ordered) > 0) {
          return { ok: false as const, code: "invalid-payload", message: `affected quantity exceeds the ordered line quantity` };
        }
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "affected quantity is not a valid decimal" };
      }
    }
    if (args.linkedEntryId !== undefined) {
      const linked = await ctx.db.get(args.linkedEntryId);
      if (
        linked === null ||
        linked.organizationId !== args.organizationId ||
        linked.projectId !== args.projectId ||
        linked.orderId !== args.orderId
      ) {
        return { ok: false as const, code: "denied-project", message: "linked entry is not on this order" };
      }
      // A valid link is exactly one credit plus one refund. Same-kind
      // links and links involving order-level payments or settled costs
      // are rejected, so cash can never be silently re-paired.
      const kinds = [args.kind, linked.kind].sort().join("+");
      if (kinds !== "credit+refund") {
        return { ok: false as const, code: "invalid-payload", message: "linked entries must form a credit/refund pair" };
      }
      if (
        (linked.quoteLineId ?? undefined) !== normalizedLineId ||
        (linked.affectedQuantity ?? undefined) !== normalizedAffected ||
        (linked.affectedUnit ?? undefined) !== normalizedAffectedUnit ||
        linked.amount.currency !== checkedAmount.currency
      ) {
        return { ok: false as const, code: "invalid-payload", message: "linked entry must share the order line, quantity, unit, and currency" };
      }
      // Exclusive pairing: neither side may already be paired elsewhere,
      // or one credit could absorb several refunds (double-counting).
      if (linked.linkedEntryId !== undefined) {
        return { ok: false as const, code: "invalid-payload", message: "linked entry is already paired" };
      }
      // Bounded existence lookup over the link index: at most one row is
      // read, never the whole order history. Cross-order siblings cannot
      // exist because links are denied unless the linked entry is on this
      // order, so scoping the probe to this order preserves the exact
      // prior semantics.
      const siblings = await ctx.db
        .query("costEntries")
        .withIndex("by_linked_entry", (q) => q.eq("linkedEntryId", args.linkedEntryId))
        .take(1);
      if (
        siblings.some(
          (entry) =>
            entry.organizationId === args.organizationId &&
            entry.projectId === args.projectId &&
            entry.orderId === args.orderId,
        )
      ) {
        return { ok: false as const, code: "invalid-payload", message: "linked entry is already paired" };
      }
    }
    const entryId = await ctx.db.insert("costEntries", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      orderId: args.orderId,
      kind: args.kind,
      amount: { currency: checkedAmount.currency, minorUnits: checkedAmount.minorUnits },
      idempotencyKey: args.idempotencyKey,
      ...(args.linkedEntryId === undefined ? {} : { linkedEntryId: args.linkedEntryId }),
      ...(normalizedLineId === undefined ? {} : { quoteLineId: normalizedLineId }),
      ...(normalizedAffected === undefined ? {} : { affectedQuantity: normalizedAffected }),
      ...(normalizedAffectedUnit === undefined ? {} : { affectedUnit: normalizedAffectedUnit }),
      ...(evidenceRefs.length === 0
        ? {}
        : {
          evidenceRefs: evidenceRefs.map((ref) => ({
            evidenceId: ref.evidenceId,
            contentHash: ref.contentHash,
          })),
        }),
      recordedBy: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, entryId, deduplicated: false };
  },
});

/**
 * Record installed equipment. Location and order provenance must resolve
 * inside the project when supplied; the order's full decision lineage
 * (selection, requirement, quote) is re-verified so an asset can never
 * dangle off a foreign commitment. Purchase provenance stays a label,
 * never a rewritten history. The idempotency key replays exactly or
 * conflicts.
 */
export const recordAsset = f1Mutation({
  args: assetInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), assetId: v.id("assets"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.label.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "label required" };
    }
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameLocation = (existing.locationId ?? undefined) === args.locationId;
      const sameOrder = (existing.orderId ?? undefined) === args.orderId;
      const sameSerial = (existing.serial ?? undefined) === args.serial;
      const sameConstraints = (existing.constraints ?? undefined) === args.constraints;
      const sameProvenance =
        (existing.purchaseProvenance ?? undefined) === args.purchaseProvenance;
      if (
        existing.label !== args.label ||
        !sameLocation ||
        !sameOrder ||
        !sameSerial ||
        !sameConstraints ||
        !sameProvenance
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, assetId: existing._id, deduplicated: true };
    }
    if (args.locationId !== undefined) {
      const location = await ctx.db.get(args.locationId);
      if (location === null || location.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "location is not in this organization" };
      }
    }
    if (args.orderId !== undefined) {
      const order = await requireOwnedRef(
        await ctx.db.get(args.orderId),
        args.organizationId,
        args.projectId,
      );
      if (!order.ok) {
        return { ok: false as const, code: order.code, message: order.message };
      }
      const selection = await requireOwnedRef(
        await ctx.db.get(order.value.selectionId),
        args.organizationId,
        args.projectId,
      );
      if (!selection.ok) {
        return { ok: false as const, code: selection.code, message: selection.message };
      }
    }
    const assetId = await ctx.db.insert("assets", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.locationId === undefined ? {} : { locationId: args.locationId }),
      ...(args.orderId === undefined ? {} : { orderId: args.orderId }),
      label: args.label,
      ...(args.serial === undefined ? {} : { serial: args.serial }),
      ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
      ...(args.purchaseProvenance === undefined ? {} : { purchaseProvenance: args.purchaseProvenance }),
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, assetId, deduplicated: false };
  },
});

const orderHistoryEventValidator = v.object({
  id: v.id("orderEvents"),
  kind: v.string(),
  acceptanceLines: v.array(
    v.object({
      quoteLineId: v.string(),
      acceptedQuantity: v.string(),
      unit: v.string(),
    }),
  ),
  note: v.optional(v.string()),
});

const orderHistoryEntryValidator = v.object({
  id: v.id("costEntries"),
  kind: v.string(),
  amount: v.object({ currency: v.string(), minorUnits: v.number() }),
  quoteLineId: v.optional(v.string()),
  affectedQuantity: v.optional(v.string()),
  affectedUnit: v.optional(v.string()),
  evidenceRefs: v.array(
    v.object({ evidenceId: v.id("evidence"), contentHash: v.string() }),
  ),
  linkedEntryId: v.optional(v.id("costEntries")),
});

const orderLineageValidator = v.object({
  ok: v.literal(true),
  order: v.object({
    id: v.id("orders"),
    state: v.string(),
    supplierReference: v.optional(v.string()),
  }),
  selection: v.object({
    id: v.id("selections"),
    selectionLines: v.array(storedOrderLineValidator),
  }),
  quote: v.object({
    id: v.id("quotes"),
    version: v.string(),
    currency: v.string(),
    contentHash: v.string(),
    lines: v.array(
      v.object({
        lineId: v.string(),
        description: v.string(),
        quantity: v.string(),
        unitPrice: v.object({ currency: v.string(), minorUnits: v.number() }),
      }),
    ),
    // Quote-level shared charges stay quote-level with their stored
    // scopes: the lineage never allocates them to lines.
    charges: v.array(
      v.object({
        chargeId: v.string(),
        label: v.string(),
        scope: v.object({ kind: v.string(), lineId: v.optional(v.string()) }),
      }),
    ),
  }),
  orderLines: v.array(storedOrderLineValidator),
  acceptedByLine: v.array(
    v.object({
      quoteLineId: v.string(),
      acceptedQuantity: v.string(),
      unit: v.string(),
    }),
  ),
  events: v.array(orderHistoryEventValidator),
  costEntries: v.array(orderHistoryEntryValidator),
});

/**
 * Read the durable order lineage needed after reload (F1R-13, F1R-16). A
 * bounded authorized query over the order's own indexes: the pinned quote
 * lines with exact money, the authoritative selection and order lines,
 * the per-line acceptance totals, and the typed cost entries with
 * evidence hashes and links. The payload carries every stored id,
 * quantity, unit, hash, and link required for accepted-quantity
 * calculation without reconstructing descriptions.
 *
 * The history bound is 200 events and 200 entries per call. Histories
 * beyond the bound are never presented as complete: the probe reads one
 * row past the bound, and an over-bound history returns an explicit
 * typed `incomplete-history` denial instead of prefix aggregates, so no
 * caller can mistake a truncated total for an authoritative one.
 */
export const getOrderLineage = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    orderId: v.id("orders"),
  },
  returns: v.union(orderLineageValidator, denialValidator),
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
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    const selection = await requireOwnedRef(
      await ctx.db.get(order.value.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    const selectionLines = effectiveSelectionLines(selection.value, quote);
    const orderLines = effectiveOrderLines(order.value, selectionLines);
    const events = await ctx.db
      .query("orderEvents")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .take(ORDER_LINEAGE_HISTORY_BOUND + 1);
    const entries = await ctx.db
      .query("costEntries")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .take(ORDER_LINEAGE_HISTORY_BOUND + 1);
    if (events.length > ORDER_LINEAGE_HISTORY_BOUND || entries.length > ORDER_LINEAGE_HISTORY_BOUND) {
      return {
        ok: false as const,
        code: "incomplete-history",
        message: "order history exceeds the reload bound; totals are unavailable until paginated reads land",
      };
    }
    const acceptedTotals = new Map<string, { quantity: Decimal; unit: string }>();
    for (const event of events) {
      if (
        event.organizationId !== args.organizationId ||
        event.projectId !== args.projectId
      ) {
        continue;
      }
      for (const line of effectiveEventAcceptances(event, orderLines)) {
        const running = acceptedTotals.get(line.quoteLineId);
        try {
          const addition = quantity(line.acceptedQuantity);
          acceptedTotals.set(
            line.quoteLineId,
            running === undefined
              ? { quantity: addition, unit: line.unit }
              : { quantity: decimalAdd(running.quantity, addition), unit: running.unit },
          );
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "stored accepted quantity is invalid" };
        }
      }
    }
    return {
      ok: true as const,
      order: {
        id: order.value._id,
        state: order.value.state,
        ...(order.value.supplierReference === undefined
          ? {}
          : { supplierReference: order.value.supplierReference }),
      },
      selection: { id: selection.value._id, selectionLines: sortLinesById(selectionLines) },
      quote: {
        id: quote._id,
        version: quote.version,
        currency: quote.currency,
        contentHash: quote.contentHash,
        lines: quote.lines.map((line) => ({
          lineId: line.lineId,
          description: line.description,
          quantity: line.quantity,
          unitPrice: { currency: line.unitPrice.currency, minorUnits: line.unitPrice.minorUnits },
        })),
        charges: quote.charges.map((charge) => ({
          chargeId: charge.chargeId,
          label: charge.label,
          scope: charge.scope.kind === "quote"
            ? { kind: "quote" as const }
            : { kind: charge.scope.kind, lineId: charge.scope.lineId },
        })),
      },
      orderLines: sortLinesById(orderLines),
      acceptedByLine: [...acceptedTotals.entries()].map(([quoteLineId, total]) => ({
        quoteLineId,
        acceptedQuantity: decimalToString(total.quantity),
        unit: total.unit,
      })),
      events: events
        .filter(
          (event) =>
            event.organizationId === args.organizationId &&
            event.projectId === args.projectId,
        )
        .map((event) => ({
          id: event._id,
          kind: event.kind,
          acceptanceLines: [...effectiveEventAcceptances(event, orderLines)],
          ...(event.note === undefined ? {} : { note: event.note }),
        })),
      costEntries: entries
        .filter(
          (entry) =>
            entry.organizationId === args.organizationId &&
            entry.projectId === args.projectId,
        )
        .map((entry) => ({
          id: entry._id,
          kind: entry.kind,
          amount: { currency: entry.amount.currency, minorUnits: entry.amount.minorUnits },
          ...(entry.quoteLineId === undefined ? {} : { quoteLineId: entry.quoteLineId }),
          ...(entry.affectedQuantity === undefined ? {} : { affectedQuantity: entry.affectedQuantity }),
          ...(entry.affectedUnit === undefined ? {} : { affectedUnit: entry.affectedUnit }),
          evidenceRefs: entry.evidenceRefs !== undefined ? [...entry.evidenceRefs] : [],
          ...(entry.linkedEntryId === undefined ? {} : { linkedEntryId: entry.linkedEntryId }),
        })),
    };
  },
});

/**
 * Greptile pagination hardening: caller-controlled page sizes are
 * clamped server-side to this documented safe positive maximum before
 * they reach `paginate`, so an oversized, fractional, zero, negative,
 * or non-finite `numItems` can never broaden the read. Cursor semantics
 * and all other pagination options pass through unchanged.
 */
const ORDER_HISTORY_PAGE_MAX = 200;

/**
 * Greptile pagination budget hardening: the caller-controlled read
 * budgets are normalized alongside the page size so total server work
 * stays deterministically bounded even when an `endCursor` range is
 * supplied or the maximum limits are oversized or non-positive.
 * Tighter caller budgets are preserved (the minimum wins); absent,
 * non-finite, or non-positive budgets fall back to these server caps,
 * so every call carries an explicit bound into `paginate`.
 */
const ORDER_HISTORY_SCAN_ROW_CAP = 1000;
const ORDER_HISTORY_SCAN_BYTE_CAP = 2 * 1024 * 1024;

function normalizeHistoryBudget(value: number | undefined, cap: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return cap;
  return Math.min(Math.floor(value), cap);
}

function clampHistoryPageOpts(paginationOpts: {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
  readonly maximumRowsRead?: number;
  readonly maximumBytesRead?: number;
  readonly id?: number;
}): {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
  readonly maximumRowsRead?: number;
  readonly maximumBytesRead?: number;
  readonly id?: number;
} {
  const floored = Math.floor(paginationOpts.numItems);
  const numItems = Number.isFinite(floored)
    ? Math.min(Math.max(floored, 1), ORDER_HISTORY_PAGE_MAX)
    : ORDER_HISTORY_PAGE_MAX;
  return {
    ...paginationOpts,
    numItems,
    maximumRowsRead: normalizeHistoryBudget(paginationOpts.maximumRowsRead, ORDER_HISTORY_SCAN_ROW_CAP),
    maximumBytesRead: normalizeHistoryBudget(paginationOpts.maximumBytesRead, ORDER_HISTORY_SCAN_BYTE_CAP),
  };
}

/**
 * Paged order history (Greptile r4056517362). When an order's history
 * exceeds the lineage summary bound, every row stays reloadable and
 * reconcilable through this bounded cursor path: each call reads one
 * page over the order's own index with the caller-supplied cursor and a
 * server-clamped page size, so no call can approach transaction limits
 * however long the history grows. The existing `getOrderLineage`
 * summary response is unchanged for under-bound histories.
 * Authorization matches the summary on every page: viewer role plus
 * order, selection, and quote ownership in the caller's project.
 */
export const listOrderHistoryPage = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    orderId: v.id("orders"),
    kind: v.union(v.literal("events"), v.literal("entries")),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      kind: v.string(),
      page: v.array(v.union(orderHistoryEventValidator, orderHistoryEntryValidator)),
      isDone: v.boolean(),
      continueCursor: v.string(),
    }),
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
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    const selection = await requireOwnedRef(
      await ctx.db.get(order.value.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    const orderLines = effectiveOrderLines(
      order.value,
      effectiveSelectionLines(selection.value, quote),
    );
    if (args.kind === "events") {
      const result = await ctx.db
        .query("orderEvents")
        .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
        .paginate(clampHistoryPageOpts(args.paginationOpts));
      return {
        ok: true as const,
        kind: args.kind,
        page: result.page
          .filter(
            (event) =>
              event.organizationId === args.organizationId &&
              event.projectId === args.projectId,
          )
          .map((event) => ({
            id: event._id,
            kind: event.kind,
            acceptanceLines: [...effectiveEventAcceptances(event, orderLines)],
            ...(event.note === undefined ? {} : { note: event.note }),
          })),
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      };
    }
    const result = await ctx.db
      .query("costEntries")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .paginate(clampHistoryPageOpts(args.paginationOpts));
    return {
      ok: true as const,
      kind: args.kind,
      page: result.page
        .filter(
          (entry) =>
            entry.organizationId === args.organizationId &&
            entry.projectId === args.projectId,
        )
        .map((entry) => ({
          id: entry._id,
          kind: entry.kind,
          amount: { currency: entry.amount.currency, minorUnits: entry.amount.minorUnits },
          ...(entry.quoteLineId === undefined ? {} : { quoteLineId: entry.quoteLineId }),
          ...(entry.affectedQuantity === undefined ? {} : { affectedQuantity: entry.affectedQuantity }),
          ...(entry.affectedUnit === undefined ? {} : { affectedUnit: entry.affectedUnit }),
          evidenceRefs: entry.evidenceRefs !== undefined ? [...entry.evidenceRefs] : [],
          ...(entry.linkedEntryId === undefined ? {} : { linkedEntryId: entry.linkedEntryId }),
        })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** Attach an authorized document link to an in-project asset. */
export const recordAssetDocument = f1Mutation({
  args: assetDocumentInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), documentId: v.id("assetDocuments"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.kind.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "document kind required" };
    }
    const existing = await ctx.db
      .query("assetDocuments")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameStorage = (existing.storageRef ?? undefined) === args.storageRef;
      if (existing.assetId !== args.assetId || existing.kind !== args.kind || !sameStorage) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, documentId: existing._id, deduplicated: true };
    }
    const asset = await requireOwnedRef(
      await ctx.db.get(args.assetId),
      args.organizationId,
      args.projectId,
    );
    if (!asset.ok) {
      return { ok: false as const, code: asset.code, message: asset.message };
    }
    const documentId = await ctx.db.insert("assetDocuments", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      assetId: args.assetId,
      kind: args.kind,
      ...(args.storageRef === undefined ? {} : { storageRef: args.storageRef }),
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, documentId, deduplicated: false };
  },
});

/** Open a service case against an in-project asset. */
export const openServiceCase = f1Mutation({
  args: serviceCaseInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), caseId: v.id("serviceCases"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.summary.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "summary required" };
    }
    const existing = await ctx.db
      .query("serviceCases")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      if (
        existing.assetId !== args.assetId ||
        existing.urgency !== args.urgency ||
        existing.summary !== args.summary
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, caseId: existing._id, deduplicated: true };
    }
    const asset = await requireOwnedRef(
      await ctx.db.get(args.assetId),
      args.organizationId,
      args.projectId,
    );
    if (!asset.ok) {
      return { ok: false as const, code: asset.code, message: asset.message };
    }
    const now = Date.now();
    const caseId = await ctx.db.insert("serviceCases", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      assetId: args.assetId,
      urgency: args.urgency,
      summary: args.summary,
      state: "open",
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, caseId, deduplicated: false };
  },
});

/** Advance a service case; terminal cases never reopen. */
export const updateServiceCase = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    caseId: v.id("serviceCases"),
    state: v.union(
      v.literal("open"),
      v.literal("inProgress"),
      v.literal("waitingForSupplier"),
      v.literal("resolved"),
      v.literal("closed"),
    ),
    outcome: v.optional(v.string()),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const serviceCase = await requireOwnedRef(
      await ctx.db.get(args.caseId),
      args.organizationId,
      args.projectId,
    );
    if (!serviceCase.ok) {
      return { ok: false as const, code: serviceCase.code, message: serviceCase.message };
    }
    if (serviceCase.value.state === "closed" && args.state !== "closed") {
      return { ok: false as const, code: "invalid-payload", message: "closed cases never reopen" };
    }
    await ctx.db.patch(args.caseId, {
      state: args.state,
      ...(args.outcome === undefined ? {} : { outcome: args.outcome }),
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});
