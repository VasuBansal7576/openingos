/**
 * F1 quote semantics bridge (controlled contract, ADR-0003).
 *
 * The real Convex quote surface implements the complete accepted
 * proofs/money/quote.ts and comparison.ts semantics: discriminated
 * known/included/estimated(point-or-range)/unknown/notApplicable charge
 * states with required reasons or coveringIds, quote/line/allocated
 * scopes with evidence, exact comparison scopes, duplicate and lineage
 * rejection, and decision-field hashing. Parsing runs through the
 * reviewed proofs constructors so the durable contract cannot drift from
 * the accepted proof; this module only adapts proofs values to plain
 * Convex-storable shapes (quantities as canonical decimal strings) and
 * maps proofs comparison results to the F1 verdict shape.
 *
 * This module registers no Convex functions.
 */

import { v } from "convex/values";
import { createQuote } from "../../proofs/money/quote.js";
import { compareQuotes } from "../../proofs/money/comparison.js";
import { decimalToString } from "../../proofs/money/decimal.js";
import type {
  ChargeInput,
  ChargeState,
  ComparisonScope,
  ComparisonScopeInput,
  EvidenceRef,
  Quote,
  QuoteCharge,
  QuoteInput,
  QuoteLine,
  QuoteLineInput,
  TaxBasis,
  TaxBasisInput,
} from "../../proofs/money/index.js";

// -- Validators -----------------------------------------------------------

export const quoteMoneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});

export const quoteEvidenceRefValidator = v.object({
  sourceId: v.string(),
  version: v.string(),
  locator: v.optional(v.string()),
});

export const quoteChargeScopeValidator = v.union(
  v.object({ kind: v.literal("quote") }),
  v.object({ kind: v.literal("line"), lineId: v.string() }),
  v.object({
    kind: v.literal("allocated"),
    lineId: v.string(),
    method: v.union(v.literal("fixed"), v.literal("proportional")),
  }),
);

export const quoteEstimateValidator = v.union(
  v.object({ kind: v.literal("point"), amount: quoteMoneyValidator }),
  v.object({
    kind: v.literal("range"),
    minimum: quoteMoneyValidator,
    maximum: quoteMoneyValidator,
  }),
);

export const quoteChargeStateValidator = v.union(
  v.object({ kind: v.literal("known"), amount: quoteMoneyValidator }),
  v.object({ kind: v.literal("included"), coveringId: v.string() }),
  v.object({ kind: v.literal("estimated"), estimate: quoteEstimateValidator }),
  v.object({ kind: v.literal("unknown"), reason: v.string() }),
  v.object({ kind: v.literal("notApplicable"), reason: v.string() }),
);

/** Loose line shape for public/provider input boundaries (proofs defaults the rest). */
export const quoteLineInputValidator = v.object({
  lineId: v.string(),
  description: v.string(),
  quantity: v.union(v.string(), v.number()),
  unitPrice: quoteMoneyValidator,
  evidenceRefs: v.optional(v.array(quoteEvidenceRefValidator)),
});

/** Loose charge shape for public/provider input boundaries. */
export const quoteChargeInputValidator = v.object({
  chargeId: v.string(),
  label: v.string(),
  scope: v.optional(quoteChargeScopeValidator),
  state: quoteChargeStateValidator,
  evidenceRefs: v.optional(v.array(quoteEvidenceRefValidator)),
});

/** Normalized stored line shape (scope-independent; evidence always present). */
export const storedQuoteLineValidator = v.object({
  lineId: v.string(),
  description: v.string(),
  quantity: v.string(),
  unitPrice: quoteMoneyValidator,
  evidenceRefs: v.array(quoteEvidenceRefValidator),
});

/** Normalized stored charge shape (scope and evidence always present). */
export const storedQuoteChargeValidator = v.object({
  chargeId: v.string(),
  label: v.string(),
  scope: quoteChargeScopeValidator,
  state: quoteChargeStateValidator,
  evidenceRefs: v.array(quoteEvidenceRefValidator),
});

export const quoteTaxBasisValidator = v.union(
  v.object({
    kind: v.literal("inclusive"),
    basisId: v.string(),
    evidenceRefs: v.array(quoteEvidenceRefValidator),
  }),
  v.object({
    kind: v.literal("exclusive"),
    basisId: v.string(),
    evidenceRefs: v.array(quoteEvidenceRefValidator),
  }),
  v.object({
    kind: v.literal("unknown"),
    reason: v.string(),
    evidenceRefs: v.array(quoteEvidenceRefValidator),
  }),
);

export const quoteComparisonScopeValidator = v.object({
  requirementId: v.string(),
  scopeId: v.string(),
  items: v.array(
    v.object({
      itemId: v.string(),
      lineId: v.string(),
      unit: v.string(),
      requiredQuantity: v.string(),
    }),
  ),
});

// -- Stored types (plain Convex-storable mirrors of the proofs values) -----

export interface StoredEvidenceRef {
  readonly sourceId: string;
  readonly version: string;
  readonly locator?: string;
}

export interface StoredMoney {
  readonly currency: string;
  readonly minorUnits: number;
}

export type StoredChargeScope =
  | Readonly<{ kind: "quote" }>
  | Readonly<{ kind: "line"; lineId: string }>
  | Readonly<{ kind: "allocated"; lineId: string; method: "fixed" | "proportional" }>;

export type StoredEstimate =
  | Readonly<{ kind: "point"; amount: StoredMoney }>
  | Readonly<{ kind: "range"; minimum: StoredMoney; maximum: StoredMoney }>;

export type StoredChargeState =
  | Readonly<{ kind: "known"; amount: StoredMoney }>
  | Readonly<{ kind: "included"; coveringId: string }>
  | Readonly<{ kind: "estimated"; estimate: StoredEstimate }>
  | Readonly<{ kind: "unknown"; reason: string }>
  | Readonly<{ kind: "notApplicable"; reason: string }>;

export interface StoredQuoteLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: StoredMoney;
  readonly evidenceRefs: readonly StoredEvidenceRef[];
}

export interface StoredQuoteCharge {
  readonly chargeId: string;
  readonly label: string;
  readonly scope: StoredChargeScope;
  readonly state: StoredChargeState;
  readonly evidenceRefs: readonly StoredEvidenceRef[];
}

export type StoredTaxBasis =
  | Readonly<{ kind: "inclusive" | "exclusive"; basisId: string; evidenceRefs: readonly StoredEvidenceRef[] }>
  | Readonly<{ kind: "unknown"; reason: string; evidenceRefs: readonly StoredEvidenceRef[] }>;

export interface StoredComparisonScopeItem {
  readonly itemId: string;
  readonly lineId: string;
  readonly unit: string;
  readonly requiredQuantity: string;
}

export interface StoredComparisonScope {
  readonly requirementId: string;
  readonly scopeId: string;
  readonly items: readonly StoredComparisonScopeItem[];
}

// -- Proofs bridge ----------------------------------------------------------

export interface QuoteDocumentInput {
  readonly quoteId: unknown;
  readonly version: unknown;
  readonly currency: unknown;
  readonly lines: unknown;
  readonly charges?: unknown;
  readonly taxBasis: unknown;
  readonly comparisonScope?: unknown;
  readonly evidenceRefs?: unknown;
}

function toStoredEvidence(refs: readonly EvidenceRef[]): StoredEvidenceRef[] {
  return refs.map((ref) =>
    ref.locator === undefined
      ? { sourceId: ref.sourceId, version: ref.version }
      : { sourceId: ref.sourceId, version: ref.version, locator: ref.locator },
  );
}

function toStoredMoney(amount: { readonly currency: string; readonly minorUnits: number }): StoredMoney {
  return { currency: amount.currency, minorUnits: amount.minorUnits };
}

function toStoredState(state: ChargeState): StoredChargeState {
  if (state.kind === "known") {
    return { kind: "known", amount: toStoredMoney(state.amount) };
  }
  if (state.kind === "included") {
    return { kind: "included", coveringId: state.coveringId };
  }
  if (state.kind === "estimated") {
    const estimate = state.estimate;
    return {
      kind: "estimated",
      estimate:
        estimate.kind === "point"
          ? { kind: "point", amount: toStoredMoney(estimate.amount) }
          : {
            kind: "range",
            minimum: toStoredMoney(estimate.minimum),
            maximum: toStoredMoney(estimate.maximum),
          },
    };
  }
  if (state.kind === "unknown") {
    return { kind: "unknown", reason: state.reason };
  }
  return { kind: "notApplicable", reason: state.reason };
}

/**
 * Parse one quote document through the accepted proofs constructors.
 * Throws an Error describing the first violation: duplicate lines,
 * charges, or scope items, bad currencies, invalid ranges, unknown line
 * references, unmapped scope lines, quantity mismatches, dangling or
 * cyclic included coverage, or missing reasons/coveringIds.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unknown and notApplicable charges carry a reason and never an amount:
 * stray amount/estimate/range/covering payloads inside those states are
 * rejected rather than silently dropped.
 */
function rejectStrayChargeAmounts(charges: unknown): void {
  if (!Array.isArray(charges)) return;
  for (const raw of charges) {
    if (!isUnknownRecord(raw) || !isUnknownRecord(raw["state"])) continue;
    const state = raw["state"];
    const kind = state["kind"];
    if (kind !== "unknown" && kind !== "notApplicable") continue;
    const chargeId = typeof raw["chargeId"] === "string" ? raw["chargeId"].trim() : "charge";
    for (const stray of ["amount", "estimate", "minimum", "maximum", "coveringId"]) {
      if (state[stray] !== undefined) {
        throw new Error(`charge ${chargeId || "charge"} must not carry an amount`);
      }
    }
  }
}

export function parseQuoteDocument(input: QuoteDocumentInput): Quote {
  rejectStrayChargeAmounts(input.charges);
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const document: QuoteInput = {
    quoteId: input.quoteId,
    version: input.version,
    currency: input.currency,
    lines: rawLines as QuoteLineInput[],
    ...(input.charges === undefined ? {} : { charges: input.charges as ChargeInput[] }),
    taxBasis: input.taxBasis as TaxBasisInput,
    ...(input.comparisonScope === undefined
      ? {}
      : { comparisonScope: input.comparisonScope as ComparisonScopeInput }),
    ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs as EvidenceRef[] }),
  };
  let quote: Quote;
  try {
    quote = createQuote(document);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "quote is invalid");
  }
  assertCoverageTargets(quote.lines, quote.charges);
  return quote;
}

/**
 * Dangling included coverage is rejected: every coveringId must resolve
 * to a real line or charge, and chains must terminate without cycles.
 * The proofs constructor rejects cycles; this rejects unknown targets,
 * which the proofs chain walk otherwise tolerates silently.
 */
export function assertCoverageTargets(
  lines: readonly { readonly lineId: string }[],
  charges: readonly QuoteCharge[],
): void {
  const lineIds = new Set(lines.map((line) => line.lineId));
  const chargesById = new Map(charges.map((charge) => [charge.chargeId, charge]));
  const resolve = (coveringId: string, path: readonly string[]): void => {
    if (lineIds.has(coveringId)) return;
    const covering = chargesById.get(coveringId);
    if (covering === undefined) {
      throw new Error(`included charge coverage ${coveringId} does not resolve to a line or charge`);
    }
    if (covering.state.kind !== "included") return;
    if (path.includes(covering.chargeId)) {
      throw new Error(`included charge coverage cycle includes ${covering.chargeId}`);
    }
    resolve(covering.state.coveringId, [...path, covering.chargeId]);
  };
  for (const charge of charges) {
    if (charge.state.kind === "included") {
      resolve(charge.state.coveringId, [charge.chargeId]);
    }
  }
}

export interface StoredQuoteParts {
  readonly currency: string;
  readonly lines: StoredQuoteLine[];
  readonly charges: StoredQuoteCharge[];
  readonly taxBasis: StoredTaxBasis;
  readonly comparisonScope?: StoredComparisonScope;
  readonly evidenceRefs: StoredEvidenceRef[];
}

/** Normalize a parsed proofs quote to plain Convex-storable parts. */
export function storedQuoteParts(quote: Quote): StoredQuoteParts {
  const lines = quote.lines.map((line: QuoteLine): StoredQuoteLine => ({
    lineId: line.lineId,
    description: line.description,
    quantity: decimalToString(line.quantity),
    unitPrice: toStoredMoney(line.unitPrice),
    evidenceRefs: toStoredEvidence(line.evidenceRefs),
  }));
  const charges = quote.charges.map((charge: QuoteCharge): StoredQuoteCharge => ({
    chargeId: charge.chargeId,
    label: charge.label,
    scope: { ...charge.scope },
    state: toStoredState(charge.state),
    evidenceRefs: toStoredEvidence(charge.evidenceRefs),
  }));
  const taxBasis: StoredTaxBasis = quote.taxBasis.kind === "unknown"
    ? {
      kind: "unknown",
      reason: quote.taxBasis.reason,
      evidenceRefs: toStoredEvidence(quote.taxBasis.evidenceRefs),
    }
    : {
      kind: quote.taxBasis.kind,
      basisId: quote.taxBasis.basisId,
      evidenceRefs: toStoredEvidence(quote.taxBasis.evidenceRefs),
    };
  const parts: StoredQuoteParts = {
    currency: quote.currency,
    lines,
    charges,
    taxBasis,
    evidenceRefs: toStoredEvidence(quote.evidenceRefs),
  };
  if (quote.comparisonScope !== undefined) {
    const scope: ComparisonScope = quote.comparisonScope;
    return {
      ...parts,
      comparisonScope: {
        requirementId: scope.requirementId,
        scopeId: scope.scopeId,
        items: scope.items.map((item) => ({
          itemId: item.itemId,
          lineId: item.lineId,
          unit: item.unit,
          requiredQuantity: decimalToString(item.requiredQuantity),
        })),
      },
    };
  }
  return parts;
}

export interface StoredComparableQuote {
  readonly version: string;
  readonly currency: string;
  readonly lines: readonly StoredQuoteLine[];
  readonly charges: readonly StoredQuoteCharge[];
  readonly taxBasis: StoredTaxBasis;
  readonly comparisonScope?: StoredComparisonScope;
  readonly evidenceRefs: readonly StoredEvidenceRef[];
}

function taxBasisInput(taxBasis: StoredTaxBasis): Record<string, unknown> {
  if (taxBasis.kind === "unknown") {
    return { kind: "unknown", reason: taxBasis.reason, evidenceRefs: [...taxBasis.evidenceRefs] };
  }
  return { kind: taxBasis.kind, basisId: taxBasis.basisId, evidenceRefs: [...taxBasis.evidenceRefs] };
}

function toProofInput(stored: StoredComparableQuote): Record<string, unknown> {
  return {
    quoteId: stored.version,
    version: stored.version,
    currency: stored.currency,
    lines: stored.lines.map((line) => ({
      lineId: line.lineId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: { ...line.unitPrice },
      evidenceRefs: line.evidenceRefs.map((ref) => ({ ...ref })),
    })),
    charges: stored.charges.map((charge) => ({
      chargeId: charge.chargeId,
      label: charge.label,
      scope: { ...charge.scope },
      state: JSON.parse(JSON.stringify(charge.state)) as unknown,
      evidenceRefs: charge.evidenceRefs.map((ref) => ({ ...ref })),
    })),
    taxBasis: taxBasisInput(stored.taxBasis),
    ...(stored.comparisonScope === undefined
      ? {}
      : {
        comparisonScope: {
          requirementId: stored.comparisonScope.requirementId,
          scopeId: stored.comparisonScope.scopeId,
          items: stored.comparisonScope.items.map((item) => ({ ...item })),
        },
      }),
    evidenceRefs: stored.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

export interface F1Comparison {
  readonly verdict: "complete" | "incomplete";
  readonly differenceMinorUnits: number | null;
  readonly cheaper: "left" | "right" | "equal" | null;
  readonly reason: string;
}

/**
 * Exact comparison over stored quotes through the accepted proofs
 * comparison: matched by stable scope items (reorder-tolerant),
 * incompatible without shared requirement/scope identity, unknown
 * charges blocking, estimates flagged. Mixed currencies stay
 * incomparable until a conversion basis is accepted.
 */
export function compareStoredQuotes(left: StoredComparableQuote, right: StoredComparableQuote): F1Comparison {
  const incomplete = (reason: string): F1Comparison => ({
    verdict: "incomplete",
    differenceMinorUnits: null,
    cheaper: null,
    reason,
  });
  let leftQuote: Quote;
  let rightQuote: Quote;
  try {
    leftQuote = parseQuoteDocument(toProofInput(left) as unknown as QuoteDocumentInput);
    rightQuote = parseQuoteDocument(toProofInput(right) as unknown as QuoteDocumentInput);
  } catch (error) {
    return incomplete(error instanceof Error ? error.message : "stored quote is invalid");
  }
  let result: ReturnType<typeof compareQuotes>;
  try {
    result = compareQuotes(leftQuote, rightQuote);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("currency mismatch")) {
      return incomplete("mixed-currency-requires-accepted-conversion-basis");
    }
    return incomplete(message.length > 0 ? message : "comparison-failed");
  }
  if (result.status === "complete" && result.equivalent !== undefined) {
    const delta = result.equivalent.delta.minorUnits;
    return {
      verdict: "complete",
      differenceMinorUnits: Math.abs(delta),
      cheaper:
        result.equivalent.cheaperQuoteId === undefined
          ? "equal"
          : result.equivalent.cheaperQuoteId === result.left.quoteId
            ? "left"
            : "right",
      reason: "equivalent-scope",
    };
  }
  if (result.status === "estimated" && result.estimatedDeltaRange !== undefined) {
    // Point estimates settle exactly; true ranges summarize to the
    // half-up midpoint magnitude, always flagged as estimates.
    const range = result.estimatedDeltaRange;
    const sum = BigInt(range.minimum.minorUnits) + BigInt(range.maximum.minorUnits);
    const negative = sum < 0n;
    const magnitude = negative ? -sum : sum;
    const midpoint = magnitude / 2n + (magnitude % 2n === 0n ? 0n : 1n);
    if (midpoint > BigInt(Number.MAX_SAFE_INTEGER)) {
      return incomplete("amount-overflow");
    }
    return {
      verdict: "complete",
      differenceMinorUnits: Number(midpoint),
      cheaper: midpoint === 0n ? "equal" : negative ? "left" : "right",
      reason: "equivalent-scope-with-estimates",
    };
  }
  if (result.status === "estimated") {
    return incomplete("estimated comparison has no delta range");
  }
  return incomplete(result.reasons.join("; "));
}

/**
 * Every decision-relevant field hashed for a quote version: identity,
 * money, quantities, charge scopes and states, tax basis, comparison
 * scope, evidence, counterparty lineage, and conversation binding.
 */
export function quoteDecisionFields(input: {
  readonly version: string;
  readonly currency: string;
  readonly lines: readonly StoredQuoteLine[];
  readonly charges: readonly StoredQuoteCharge[];
  readonly taxBasis: StoredTaxBasis;
  readonly comparisonScope?: StoredComparisonScope;
  readonly evidenceRefs: readonly StoredEvidenceRef[];
  readonly counterpartyRole: string;
  readonly executionMode: string;
  readonly conversationId?: string;
}): Record<string, unknown> {
  return {
    version: input.version,
    currency: input.currency,
    lines: input.lines.map((line) => ({ ...line })),
    charges: input.charges.map((charge) => ({ ...charge })),
    taxBasis: { ...input.taxBasis },
    ...(input.comparisonScope === undefined ? {} : { comparisonScope: { ...input.comparisonScope } }),
    evidenceRefs: input.evidenceRefs.map((ref) => ({ ...ref })),
    counterpartyRole: input.counterpartyRole,
    executionMode: input.executionMode,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  };
}

export type { EvidenceRef, Quote, QuoteCharge, QuoteLine, TaxBasis };
