import {
  decimalCompare,
  decimalZero,
  parsePositiveQuantity,
} from "./decimal";
import type { Decimal, Quantity } from "./decimal";
import { mergeEvidenceRefs } from "./evidence";
import type { EvidenceRef } from "./evidence";
import {
  absoluteMoneyDelta,
  addMoney,
  assertSameCurrency,
  money,
  moneyDifference,
  moneyZero,
  multiplyMoneyByQuantity,
  normalizeMoney,
} from "./money";
import type { Money, MoneyDelta } from "./money";
import type {
  ChargeState,
  ComparisonScope,
  Quote,
  QuoteCharge,
  QuoteLine,
} from "./quote";

export interface LineSelectionInput {
  readonly lineId: unknown;
  readonly quantity: unknown;
}

export interface CompareOptions {
  readonly leftSelection?: readonly LineSelectionInput[];
  readonly rightSelection?: readonly LineSelectionInput[];
}

export interface MoneyRange {
  readonly minimum: Money;
  readonly maximum: Money;
}

export interface MoneyDeltaRange {
  readonly minimum: MoneyDelta;
  readonly maximum: MoneyDelta;
}

export interface ChargeIssue {
  readonly chargeId: string;
  readonly label: string;
  readonly kind: "unknown" | "unallocated";
  readonly reason: string;
}

export type QuoteCostStatus = "complete" | "estimated" | "incomplete";

export interface QuoteLineCost {
  readonly lineId: string;
  readonly quantity: Quantity;
  readonly total: Money;
}

export interface QuoteCostSummary {
  readonly quoteId: string;
  readonly quoteVersion: string;
  readonly currency: string;
  readonly status: QuoteCostStatus;
  readonly lineCosts: readonly QuoteLineCost[];
  readonly knownSubtotal: Money;
  readonly knownTotal: Money;
  readonly estimatedRange?: MoneyRange;
  readonly unknownCharges: readonly ChargeIssue[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly selectedAllLines: boolean;
  readonly total?: Money;
}

export interface EquivalentComparison {
  readonly leftTotal: Money;
  readonly rightTotal: Money;
  readonly delta: MoneyDelta;
  readonly savings: Money;
  readonly cheaperQuoteId?: string;
}

export interface ComparisonResult {
  readonly status: "complete" | "estimated" | "incomplete" | "incompatible";
  readonly left: QuoteCostSummary;
  readonly right: QuoteCostSummary;
  readonly knownDelta: MoneyDelta;
  readonly estimatedDeltaRange?: MoneyDeltaRange;
  readonly equivalent?: EquivalentComparison;
  readonly reasons: readonly string[];
}

function selectionMap(quote: Quote, input: readonly LineSelectionInput[] | undefined): Map<string, Quantity> | undefined {
  if (input === undefined) {
    return undefined;
  }

  const lineIds = new Set(quote.lines.map((line) => line.lineId));
  const selected = new Map<string, Quantity>();
  for (const item of input) {
    if (typeof item.lineId !== "string" || !lineIds.has(item.lineId)) {
      throw new TypeError("line selection references an unknown quote line");
    }
    if (selected.has(item.lineId)) {
      throw new TypeError(`duplicate line selection ${item.lineId}`);
    }
    selected.set(item.lineId, parsePositiveQuantity(item.quantity, `selection ${item.lineId} quantity`));
  }

  for (const line of quote.lines) {
    const selectedQuantity = selected.get(line.lineId);
    if (selectedQuantity !== undefined && decimalCompare(selectedQuantity, line.quantity) > 0) {
      throw new TypeError(`selection for ${line.lineId} exceeds quoted quantity`);
    }
  }

  return selected;
}

function selectedQuantity(
  line: QuoteLine,
  selected: Map<string, Quantity> | undefined,
): Quantity {
  return selected === undefined ? line.quantity : selected.get(line.lineId) ?? decimalZero();
}

function isAllLinesSelected(quote: Quote, selected: Map<string, Quantity> | undefined): boolean {
  if (selected === undefined) {
    return true;
  }
  return quote.lines.every((line) => decimalCompare(selectedQuantity(line, selected), line.quantity) === 0);
}

function addRange(left: MoneyRange | undefined, right: MoneyRange): MoneyRange {
  if (left === undefined) {
    return right;
  }
  return {
    minimum: addMoney(left.minimum, right.minimum),
    maximum: addMoney(left.maximum, right.maximum),
  };
}

function stateRange(state: ChargeState): MoneyRange | undefined {
  if (state.kind !== "estimated") {
    return undefined;
  }
  if (state.estimate.kind === "point") {
    return { minimum: state.estimate.amount, maximum: state.estimate.amount };
  }
  return { minimum: state.estimate.minimum, maximum: state.estimate.maximum };
}

function ratioMoney(valueInput: Money, numerator: Decimal, denominator: Decimal): Money {
  const value = normalizeMoney(valueInput);
  if (denominator.isZero() || decimalCompare(numerator, denominator) > 0) {
    throw new TypeError("money allocation ratio is invalid");
  }

  const scaledNumerator = numerator.coefficient * 10n ** BigInt(denominator.scale);
  const scaledDenominator = denominator.coefficient * 10n ** BigInt(numerator.scale);
  const product = BigInt(value.minorUnits) * scaledNumerator;
  const quotient = product / scaledDenominator;
  const remainder = product % scaledDenominator;
  const rounded = remainder * 2n >= scaledDenominator ? quotient + 1n : quotient;
  return money(value.currency, rounded);
}

function chargeApplies(
  quote: Quote,
  charge: QuoteCharge,
  selected: Map<string, Quantity> | undefined,
  allLines: boolean,
): { readonly applies: boolean; readonly unallocated: boolean } {
  if (allLines) {
    return { applies: true, unallocated: false };
  }

  const scope = charge.scope;
  if (scope.kind === "quote") {
    return { applies: false, unallocated: true };
  }

  const line = quote.lines.find((candidate) => candidate.lineId === scope.lineId);
  if (line === undefined) {
    throw new TypeError(`charge ${charge.chargeId} references an unknown line`);
  }
  const lineQuantity = selectedQuantity(line, selected);
  return { applies: !lineQuantity.isZero(), unallocated: false };
}

type CoverageStatus = "covered" | "unselected" | "unresolved";

function includedCoverage(
  quote: Quote,
  charge: QuoteCharge,
  selected: Map<string, Quantity> | undefined,
  allLines: boolean,
  path: ReadonlySet<string> = new Set([charge.chargeId]),
): CoverageStatus {
  if (charge.state.kind !== "included") {
    return "unresolved";
  }
  const coveringId = charge.state.coveringId;
  const coveringLine = quote.lines.find((line) => line.lineId === coveringId);
  if (coveringLine !== undefined) {
    return selectedQuantity(coveringLine, selected).isZero() ? "unselected" : "covered";
  }

  const coveringCharge = quote.charges.find((candidate) => candidate.chargeId === coveringId);
  if (coveringCharge === undefined || path.has(coveringId)) {
    return "unresolved";
  }
  if (coveringCharge.state.kind === "included") {
    const nextPath = new Set(path);
    nextPath.add(coveringId);
    return includedCoverage(quote, coveringCharge, selected, allLines, nextPath);
  }
  const application = chargeApplies(quote, coveringCharge, selected, allLines);
  if (application.unallocated) {
    return "unresolved";
  }
  if (!application.applies) {
    return "unselected";
  }
  return coveringCharge.state.kind === "unknown" ? "unresolved" : "covered";
}

function allocatedStateRange(
  state: ChargeState,
  quote: Quote,
  charge: QuoteCharge,
  selected: Map<string, Quantity> | undefined,
): MoneyRange | undefined {
  const range = stateRange(state);
  const scope = charge.scope;
  if (range === undefined || scope.kind !== "allocated" || scope.method !== "proportional") {
    return range;
  }
  const line = quote.lines.find((candidate) => candidate.lineId === scope.lineId);
  if (line === undefined) {
    throw new TypeError(`charge ${charge.chargeId} references an unknown line`);
  }
  const selectedLineQuantity = selectedQuantity(line, selected);
  return {
    minimum: ratioMoney(range.minimum, selectedLineQuantity, line.quantity),
    maximum: ratioMoney(range.maximum, selectedLineQuantity, line.quantity),
  };
}

function summarizeQuote(quote: Quote, selected: Map<string, Quantity> | undefined): QuoteCostSummary {
  const allLines = isAllLinesSelected(quote, selected);
  let knownSubtotal = moneyZero(quote.currency);
  let estimatedRange: MoneyRange | undefined;
  const unknownCharges: ChargeIssue[] = [];
  const lineCosts: QuoteLineCost[] = [];
  const lineEvidence = quote.lines.map((line) => line.evidenceRefs);
  const chargeEvidence = quote.charges.map((charge) => charge.evidenceRefs);

  for (const line of quote.lines) {
    const lineQuantity = selectedQuantity(line, selected);
    const total = multiplyMoneyByQuantity(line.unitPrice, lineQuantity);
    knownSubtotal = addMoney(knownSubtotal, total);
    lineCosts.push({ lineId: line.lineId, quantity: lineQuantity, total });
  }

  for (const charge of quote.charges) {
    const application = chargeApplies(quote, charge, selected, allLines);
    if (charge.state.kind === "included") {
      const coverage = includedCoverage(quote, charge, selected, allLines);
      if (coverage !== "covered") {
        unknownCharges.push({
          chargeId: charge.chargeId,
          label: charge.label,
          kind: "unallocated",
          reason: coverage === "unselected"
            ? "included charge is covered by an unselected scope"
            : "included charge coverage is unresolved",
        });
      }
      continue;
    }
    if (application.unallocated) {
      if (charge.state.kind !== "notApplicable") {
        unknownCharges.push({
          chargeId: charge.chargeId,
          label: charge.label,
          kind: "unallocated",
          reason: "quote-level charge has no explicit allocation for a partial selection",
        });
      }
      continue;
    }
    if (!application.applies) {
      continue;
    }

    if (charge.state.kind === "known") {
      const scope = charge.scope;
      let amount = charge.state.amount;
      if (scope.kind === "allocated" && scope.method === "proportional") {
        const line = quote.lines.find((candidate) => candidate.lineId === scope.lineId);
        if (line === undefined) {
          throw new TypeError(`charge ${charge.chargeId} references an unknown line`);
        }
        amount = ratioMoney(charge.state.amount, selectedQuantity(line, selected), line.quantity);
      }
      knownSubtotal = addMoney(knownSubtotal, amount);
      continue;
    }
    if (charge.state.kind === "estimated") {
      const range = allocatedStateRange(charge.state, quote, charge, selected);
      if (range !== undefined) {
        estimatedRange = addRange(estimatedRange, range);
      }
      continue;
    }
    if (charge.state.kind === "unknown") {
      unknownCharges.push({
        chargeId: charge.chargeId,
        label: charge.label,
        kind: "unknown",
        reason: charge.state.reason,
      });
    }
  }

  const status: QuoteCostStatus = unknownCharges.length > 0
    ? "incomplete"
    : estimatedRange !== undefined
      ? "estimated"
      : "complete";
  const evidenceRefs = mergeEvidenceRefs(quote.evidenceRefs, quote.taxBasis.evidenceRefs, ...lineEvidence, ...chargeEvidence);
  const summaryBase = {
    quoteId: quote.quoteId,
    quoteVersion: quote.version,
    currency: quote.currency,
    status,
    lineCosts,
    knownSubtotal,
    knownTotal: knownSubtotal,
    unknownCharges,
    evidenceRefs,
    selectedAllLines: allLines,
  };
  if (status === "complete") {
    return { ...summaryBase, total: knownSubtotal };
  }
  if (estimatedRange !== undefined) {
    return { ...summaryBase, estimatedRange };
  }
  return summaryBase;
}

function taxBasesCompatible(left: Quote, right: Quote): boolean {
  if (left.taxBasis.kind === "unknown" || right.taxBasis.kind === "unknown") {
    return false;
  }
  return left.taxBasis.kind === right.taxBasis.kind && left.taxBasis.basisId === right.taxBasis.basisId;
}

function comparisonScopesCompatible(left: Quote, right: Quote): boolean {
  const leftScope = left.comparisonScope;
  const rightScope = right.comparisonScope;
  if (leftScope === undefined || rightScope === undefined) {
    return false;
  }
  if (leftScope.requirementId !== rightScope.requirementId || leftScope.scopeId !== rightScope.scopeId) {
    return false;
  }
  if (leftScope.items.length !== rightScope.items.length) {
    return false;
  }
  const rightItems = new Map(rightScope.items.map((item) => [item.itemId, item]));
  return leftScope.items.every((leftItem) => {
    const rightItem = rightItems.get(leftItem.itemId);
    return rightItem !== undefined
      && leftItem.unit === rightItem.unit
      && decimalCompare(leftItem.requiredQuantity, rightItem.requiredQuantity) === 0;
  });
}

function comparisonScopeText(scope: ComparisonScope): string {
  const items = scope.items.map((item) => `${item.itemId}:${item.requiredQuantity.toString()} ${item.unit}`).join(", ");
  return `${scope.requirementId}/${scope.scopeId} [${items}]`;
}

function deltaRange(left: QuoteCostSummary, right: QuoteCostSummary): MoneyDeltaRange | undefined {
  if (left.estimatedRange === undefined && right.estimatedRange === undefined) {
    return undefined;
  }
  const leftRange = left.estimatedRange ?? { minimum: moneyZero(left.currency), maximum: moneyZero(left.currency) };
  const rightRange = right.estimatedRange ?? { minimum: moneyZero(right.currency), maximum: moneyZero(right.currency) };
  const minimumLeft = addMoney(left.knownTotal, leftRange.minimum);
  const maximumLeft = addMoney(left.knownTotal, leftRange.maximum);
  const minimumRight = addMoney(right.knownTotal, rightRange.minimum);
  const maximumRight = addMoney(right.knownTotal, rightRange.maximum);
  return {
    minimum: moneyDifference(minimumLeft, maximumRight),
    maximum: moneyDifference(maximumLeft, minimumRight),
  };
}

function comparisonResult(
  status: ComparisonResult["status"],
  left: QuoteCostSummary,
  right: QuoteCostSummary,
  knownDelta: MoneyDelta,
  estimatedDeltaRange: MoneyDeltaRange | undefined,
  reasons: readonly string[],
): ComparisonResult {
  const base = { status, left, right, knownDelta, reasons };
  return estimatedDeltaRange === undefined ? base : { ...base, estimatedDeltaRange };
}

export function compareQuotes(left: Quote, right: Quote, options: CompareOptions = {}): ComparisonResult {
  if (left.currency !== right.currency) {
    throw new TypeError(`quote currency mismatch: ${left.currency} versus ${right.currency}`);
  }
  const leftSelection = selectionMap(left, options.leftSelection);
  const rightSelection = selectionMap(right, options.rightSelection);
  const leftSummary = summarizeQuote(left, leftSelection);
  const rightSummary = summarizeQuote(right, rightSelection);
  const knownDelta = moneyDifference(leftSummary.knownTotal, rightSummary.knownTotal);
  const reasons: string[] = [];

  if (!taxBasesCompatible(left, right)) {
    reasons.push("tax bases are not compatible");
  }
  const scopesCompatible = comparisonScopesCompatible(left, right);
  if (!scopesCompatible) {
    if (left.comparisonScope === undefined || right.comparisonScope === undefined) {
      reasons.push("comparison scopes are required for equivalent savings");
    } else {
      reasons.push(`comparison scopes are not compatible: ${comparisonScopeText(left.comparisonScope)} versus ${comparisonScopeText(right.comparisonScope)}`);
    }
  }
  for (const issue of leftSummary.unknownCharges) {
    reasons.push(`${left.quoteId}: ${issue.label} is ${issue.kind} (${issue.reason})`);
  }
  for (const issue of rightSummary.unknownCharges) {
    reasons.push(`${right.quoteId}: ${issue.label} is ${issue.kind} (${issue.reason})`);
  }

  const estimatedDeltaRange = deltaRange(leftSummary, rightSummary);
  if (!taxBasesCompatible(left, right)) {
    return comparisonResult("incompatible", leftSummary, rightSummary, knownDelta, estimatedDeltaRange, reasons);
  }
  if (leftSummary.status === "incomplete" || rightSummary.status === "incomplete") {
    return comparisonResult("incomplete", leftSummary, rightSummary, knownDelta, estimatedDeltaRange, reasons);
  }
  if (leftSummary.status === "estimated" || rightSummary.status === "estimated") {
    return comparisonResult("estimated", leftSummary, rightSummary, knownDelta, estimatedDeltaRange, reasons);
  }

  if (!scopesCompatible || !leftSummary.selectedAllLines || !rightSummary.selectedAllLines) {
    if (!leftSummary.selectedAllLines || !rightSummary.selectedAllLines) {
      reasons.push("partial selections require explicit per-item quantities before savings");
    }
    return comparisonResult("incompatible", leftSummary, rightSummary, knownDelta, estimatedDeltaRange, reasons);
  }

  const leftTotal = leftSummary.total;
  const rightTotal = rightSummary.total;
  if (leftTotal === undefined || rightTotal === undefined) {
    throw new Error("complete quote summaries must have totals");
  }
  assertSameCurrency(leftTotal, rightTotal);
  const delta = moneyDifference(leftTotal, rightTotal);
  const cheaperQuoteId = delta.minorUnits < 0
    ? left.quoteId
    : delta.minorUnits > 0
      ? right.quoteId
      : undefined;
  const equivalentBase = {
    leftTotal,
    rightTotal,
    delta,
    savings: absoluteMoneyDelta(delta),
  };
  const equivalent: EquivalentComparison = cheaperQuoteId === undefined
    ? equivalentBase
    : { ...equivalentBase, cheaperQuoteId };
  return { status: "complete", left: leftSummary, right: rightSummary, knownDelta, equivalent, reasons };
}
