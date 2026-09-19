import {
  decimalAdd,
  decimalCompare,
  decimalSubtract,
  decimalZero,
  parsePositiveQuantity,
} from "./decimal";
import type { Quantity } from "./decimal";
import { evidenceKey, parseEvidenceRefs } from "./evidence";
import type { EvidenceRef } from "./evidence";
import {
  addMoney,
  assertSameCurrency,
  currencyCode,
  money,
  moneyDifference,
  moneyZero,
  multiplyMoneyByQuantity,
  normalizeMoney,
  subtractMoney,
  subtractMoneyOrZero,
} from "./money";
import type { Money, MoneyDelta } from "./money";
import { isRecord, requiredString } from "./validation";

export interface SettledSegmentInput {
  readonly quantity: unknown;
  readonly unitPrice: unknown;
  readonly evidenceRefs?: unknown;
}

export interface OrderedQuantityInput {
  readonly quantity: unknown;
  readonly unitPrice: unknown;
  readonly settled?: readonly SettledSegmentInput[];
}

export interface PricedQuantityInput {
  readonly quantity: unknown;
  readonly unitPrice: unknown;
}

export interface ForecastLineInput {
  readonly lineId: unknown;
  readonly requiredQuantity: unknown;
  readonly ordered?: OrderedQuantityInput;
  readonly selected?: PricedQuantityInput;
  readonly estimated?: PricedQuantityInput;
}

export interface ForecastInput {
  readonly currency: unknown;
  readonly lines: readonly ForecastLineInput[];
}

export interface SettledSegment {
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ForecastLineResult {
  readonly lineId: string;
  readonly requiredQuantity: Quantity;
  readonly orderedQuantity: Quantity;
  readonly selectedQuantity: Quantity;
  readonly estimatedQuantity: Quantity;
  readonly uncoveredQuantity: Quantity;
  readonly settledQuantity: Quantity;
  readonly orderedCurrentCost: Money;
  readonly settledCost: Money;
  readonly selectedForecastCost: Money;
  readonly estimatedForecastCost: Money;
  readonly projectedCost: Money;
}

export interface ForecastResult {
  readonly currency: string;
  readonly status: "complete" | "incomplete";
  readonly lines: readonly ForecastLineResult[];
  readonly orderedCurrentCost: Money;
  readonly settledCost: Money;
  readonly selectedForecastCost: Money;
  readonly estimatedForecastCost: Money;
  readonly projectedCompletionCost: Money;
  readonly uncoveredQuantity: Quantity;
}

function priceForCurrency(input: unknown, currency: string, label: string): Money {
  const price = normalizeMoney(input, label);
  if (price.currency !== currency) {
    throw new TypeError(`${label} currency does not match forecast currency`);
  }
  return price;
}

function readQuantity(input: unknown, label: string): Quantity {
  return parsePositiveQuantity(input, label);
}

function addSettledQuantity(segments: readonly SettledSegment[]): Quantity {
  let total = decimalZero();
  for (const segment of segments) {
    total = decimalAdd(total, segment.quantity);
  }
  return total;
}

interface CostFragment {
  readonly kind: "remainingOrdered" | "settled";
  readonly quantity: Quantity;
  readonly unitPrice: Money;
}

/**
 * Round one forecast line once, then allocate exact fragment products.
 * Every fragment before the final one receives its exact floor and the final
 * settled fragment receives the residual, so unchanged quantity and price
 * cannot gain a minor unit when a quantity moves to settled. A price change
 * remains visible in the exact line total before this residual allocation.
 */
function allocateLineCost(currency: string, fragments: readonly CostFragment[]): readonly Money[] {
  if (fragments.length === 0) {
    return [];
  }

  const commonScale = fragments.reduce(
    (scale, fragment) => Math.max(scale, fragment.quantity.scale),
    0,
  );
  const denominator = 10n ** BigInt(commonScale);
  let numerator = 0n;
  for (const fragment of fragments) {
    const fragmentNumerator = BigInt(fragment.unitPrice.minorUnits) * fragment.quantity.coefficient;
    numerator += fragmentNumerator * 10n ** BigInt(commonScale - fragment.quantity.scale);
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const roundedTotal = remainder * 2n >= denominator ? quotient + 1n : quotient;
  let residual = roundedTotal;
  const allocated: Money[] = [];
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (fragment === undefined) {
      throw new Error("forecast line cost fragment is missing");
    }
    const isFinal = index === fragments.length - 1;
    const amount = isFinal ? residual : (
      BigInt(fragment.unitPrice.minorUnits)
      * fragment.quantity.coefficient
      * 10n ** BigInt(commonScale - fragment.quantity.scale)
      / denominator
    );
    const allocatedAmount = money(currency, amount);
    allocated.push(allocatedAmount);
    residual -= amount;
  }
  return Object.freeze(allocated);
}

function parseSettledSegments(
  input: unknown,
  currency: string,
  lineId: string,
): readonly SettledSegment[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new TypeError(`line ${lineId} settled must be an array`);
  }
  return input.map((rawSegment, index) => {
    if (!isRecord(rawSegment)) {
      throw new TypeError(`line ${lineId} settled[${index}] must be an object`);
    }
    return {
      quantity: readQuantity(rawSegment.quantity, `line ${lineId} settled[${index}] quantity`),
      unitPrice: priceForCurrency(rawSegment.unitPrice, currency, `line ${lineId} settled[${index}] unit price`),
      evidenceRefs: parseEvidenceRefs(rawSegment.evidenceRefs, `line ${lineId} settled[${index}] evidenceRefs`),
    };
  });
}

export function calculateForecast(input: ForecastInput): ForecastResult {
  const currency = currencyCode(input.currency);
  if (!Array.isArray(input.lines)) {
    throw new TypeError("forecast lines must be an array");
  }
  const rawLines = input.lines;
  if (rawLines.length === 0) {
    throw new TypeError("forecast must contain at least one line");
  }

  const lineIds = new Set<string>();
  const lines: ForecastLineResult[] = [];
  let orderedCurrentCost = moneyZero(currency);
  let settledCost = moneyZero(currency);
  let selectedForecastCost = moneyZero(currency);
  let estimatedForecastCost = moneyZero(currency);
  let uncoveredQuantity = decimalZero();

  for (const rawLine of rawLines) {
    if (!isRecord(rawLine)) {
      throw new TypeError("forecast line must be an object");
    }
    const lineId = requiredString(rawLine.lineId, "forecast lineId");
    if (lineIds.has(lineId)) {
      throw new TypeError(`duplicate forecast line ${lineId}`);
    }
    lineIds.add(lineId);

    const requiredQuantity = readQuantity(rawLine.requiredQuantity, `line ${lineId} required quantity`);
    const orderedInput = rawLine.ordered;
    if (orderedInput !== undefined && !isRecord(orderedInput)) {
      throw new TypeError(`line ${lineId} ordered data must be an object`);
    }
    const orderedQuantity = orderedInput === undefined
      ? decimalZero()
      : readQuantity(orderedInput.quantity, `line ${lineId} ordered quantity`);
    if (decimalCompare(orderedQuantity, requiredQuantity) > 0) {
      throw new TypeError(`line ${lineId} ordered quantity exceeds required quantity`);
    }

    const orderedUnitPrice = orderedInput === undefined
      ? moneyZero(currency)
      : priceForCurrency(orderedInput.unitPrice, currency, `line ${lineId} ordered unit price`);
    const settledSegments = orderedInput === undefined
      ? []
      : parseSettledSegments(orderedInput.settled, currency, lineId);
    const settledQuantity = addSettledQuantity(settledSegments);
    if (decimalCompare(settledQuantity, orderedQuantity) > 0) {
      throw new TypeError(`line ${lineId} settled quantity exceeds ordered quantity`);
    }

    const remainingOrderedQuantity = decimalSubtract(orderedQuantity, settledQuantity);
    const costFragments: CostFragment[] = [];
    if (!remainingOrderedQuantity.isZero()) {
      costFragments.push({ kind: "remainingOrdered", quantity: remainingOrderedQuantity, unitPrice: orderedUnitPrice });
    }
    for (const segment of settledSegments) {
      costFragments.push({ kind: "settled", quantity: segment.quantity, unitPrice: segment.unitPrice });
    }
    const allocatedLineCosts = allocateLineCost(currency, costFragments);
    let lineSettledCost = moneyZero(currency);
    let remainingOrderedCost = moneyZero(currency);
    for (const [index, fragment] of costFragments.entries()) {
      const fragmentCost = allocatedLineCosts[index];
      if (fragmentCost === undefined) {
        throw new Error("forecast line cost allocation is incomplete");
      }
      if (fragment.kind === "settled") {
        lineSettledCost = addMoney(lineSettledCost, fragmentCost);
      } else {
        remainingOrderedCost = addMoney(remainingOrderedCost, fragmentCost);
      }
    }
    const lineOrderedCurrentCost = addMoney(lineSettledCost, remainingOrderedCost);

    const selectedInput = rawLine.selected;
    if (selectedInput !== undefined && !isRecord(selectedInput)) {
      throw new TypeError(`line ${lineId} selected data must be an object`);
    }
    const selectedQuantity = selectedInput === undefined
      ? decimalZero()
      : readQuantity(selectedInput.quantity, `line ${lineId} selected quantity`);
    const selectedUnitPrice = selectedInput === undefined
      ? moneyZero(currency)
      : priceForCurrency(selectedInput.unitPrice, currency, `line ${lineId} selected unit price`);
    const remainingAfterOrdered = decimalSubtract(requiredQuantity, orderedQuantity);
    if (decimalCompare(selectedQuantity, remainingAfterOrdered) > 0) {
      throw new TypeError(`line ${lineId} selected quantity overlaps ordered quantity`);
    }
    const lineSelectedCost = multiplyMoneyByQuantity(selectedUnitPrice, selectedQuantity);

    const estimatedInput = rawLine.estimated;
    if (estimatedInput !== undefined && !isRecord(estimatedInput)) {
      throw new TypeError(`line ${lineId} estimated data must be an object`);
    }
    const estimatedQuantity = estimatedInput === undefined
      ? decimalZero()
      : readQuantity(estimatedInput.quantity, `line ${lineId} estimated quantity`);
    const remainingAfterSelection = decimalSubtract(remainingAfterOrdered, selectedQuantity);
    if (decimalCompare(estimatedQuantity, remainingAfterSelection) > 0) {
      throw new TypeError(`line ${lineId} estimated quantity overlaps ordered or selected quantity`);
    }
    const estimatedUnitPrice = estimatedInput === undefined
      ? moneyZero(currency)
      : priceForCurrency(estimatedInput.unitPrice, currency, `line ${lineId} estimated unit price`);
    const lineEstimatedCost = multiplyMoneyByQuantity(estimatedUnitPrice, estimatedQuantity);
    const lineUncoveredQuantity = decimalSubtract(remainingAfterSelection, estimatedQuantity);
    const lineProjectedCost = addMoney(addMoney(lineOrderedCurrentCost, lineSelectedCost), lineEstimatedCost);

    orderedCurrentCost = addMoney(orderedCurrentCost, lineOrderedCurrentCost);
    settledCost = addMoney(settledCost, lineSettledCost);
    selectedForecastCost = addMoney(selectedForecastCost, lineSelectedCost);
    estimatedForecastCost = addMoney(estimatedForecastCost, lineEstimatedCost);
    uncoveredQuantity = decimalAdd(uncoveredQuantity, lineUncoveredQuantity);
    lines.push({
      lineId,
      requiredQuantity,
      orderedQuantity,
      selectedQuantity,
      estimatedQuantity,
      uncoveredQuantity: lineUncoveredQuantity,
      settledQuantity,
      orderedCurrentCost: lineOrderedCurrentCost,
      settledCost: lineSettledCost,
      selectedForecastCost: lineSelectedCost,
      estimatedForecastCost: lineEstimatedCost,
      projectedCost: lineProjectedCost,
    });
  }

  return {
    currency,
    status: uncoveredQuantity.isZero() ? "complete" : "incomplete",
    lines,
    orderedCurrentCost,
    settledCost,
    selectedForecastCost,
    estimatedForecastCost,
    projectedCompletionCost: addMoney(addMoney(orderedCurrentCost, selectedForecastCost), estimatedForecastCost),
    uncoveredQuantity,
  };
}

export type AdjustmentKind = "deposit" | "payment" | "credit" | "cashRefund" | "surcharge";

export interface FinancialAdjustmentInput {
  readonly id: unknown;
  readonly idempotencyKey: unknown;
  readonly orderId: unknown;
  readonly kind: unknown;
  readonly amount: unknown;
  readonly linkedAdjustmentId?: unknown;
  readonly evidenceRefs?: unknown;
}

export interface NormalizedAdjustment {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly kind: AdjustmentKind;
  readonly amount: Money;
  readonly linkedAdjustmentId?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly fingerprint: string;
}

export interface CommitmentInput {
  readonly currency: unknown;
  readonly orderId: unknown;
  readonly amount: unknown;
  readonly adjustments?: readonly FinancialAdjustmentInput[];
  readonly settlement?: unknown;
}

export interface CommitmentFinancials {
  readonly orderId: string;
  readonly currency: string;
  readonly baseCommitment: Money;
  readonly obligation: Money;
  readonly credits: Money;
  readonly surcharges: Money;
  readonly grossPayments: Money;
  readonly refunds: Money;
  readonly appliedPayments: Money;
  readonly outstanding: Money;
  readonly overpayment: Money;
  readonly actualAcquisitionCost?: Money;
  readonly settlementEvidence: readonly EvidenceRef[];
  readonly adjustments: readonly NormalizedAdjustment[];
}

interface SettlementEvidence {
  readonly amount: Money;
  readonly evidenceRefs: readonly EvidenceRef[];
}

function parseSettlement(input: unknown, currency: string): SettlementEvidence | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new TypeError("settlement must be an object");
  }
  const amount = normalizeMoney(input.amount, "settlement amount");
  if (amount.currency !== currency) {
    throw new TypeError("settlement currency does not match commitment currency");
  }
  const evidenceRefs = parseEvidenceRefs(input.evidenceRefs, "settlement evidenceRefs");
  if (evidenceRefs.length === 0) {
    throw new TypeError("settlement requires evidenceRefs");
  }
  return { amount, evidenceRefs };
}

function parseAdjustment(input: unknown, currency: string, orderId: string): NormalizedAdjustment {
  if (!isRecord(input)) {
    throw new TypeError("financial adjustment must be an object");
  }
  const id = requiredString(input.id, "adjustment id");
  const idempotencyKey = requiredString(input.idempotencyKey, "adjustment idempotencyKey");
  const adjustmentOrderId = requiredString(input.orderId, `adjustment ${id} orderId`);
  if (adjustmentOrderId !== orderId) {
    throw new TypeError(`adjustment ${id} belongs to a different order`);
  }
  if (input.kind !== "deposit" && input.kind !== "payment" && input.kind !== "credit" && input.kind !== "cashRefund" && input.kind !== "surcharge") {
    throw new TypeError(`adjustment ${id} kind is invalid`);
  }
  const amount = normalizeMoney(input.amount, `adjustment ${id} amount`);
  if (amount.currency !== currency) {
    throw new TypeError(`adjustment ${id} currency does not match commitment currency`);
  }
  let linkedAdjustmentId: string | undefined;
  if (input.linkedAdjustmentId !== undefined) {
    linkedAdjustmentId = requiredString(input.linkedAdjustmentId, `adjustment ${id} linkedAdjustmentId`);
  }
  const evidenceRefs = parseEvidenceRefs(input.evidenceRefs, `adjustment ${id} evidenceRefs`);
  const evidenceFingerprint = evidenceRefs.map(evidenceKey).join(",");
  const fingerprint = [id, adjustmentOrderId, input.kind, amount.minorUnits.toString(), linkedAdjustmentId ?? "", evidenceFingerprint].join("|");
  const normalizedBase: Omit<NormalizedAdjustment, "linkedAdjustmentId"> = {
    id,
    idempotencyKey,
    orderId: adjustmentOrderId,
    kind: input.kind,
    amount,
    evidenceRefs,
    fingerprint,
  };
  return linkedAdjustmentId === undefined ? normalizedBase : { ...normalizedBase, linkedAdjustmentId };
}

export class AdjustmentIdempotencyConflictError extends Error {
  public constructor(idempotencyKey: string) {
    super(`adjustment idempotency key ${idempotencyKey} was reused with different data`);
    this.name = "AdjustmentIdempotencyConflictError";
  }
}

export class AdjustmentIdentityConflictError extends Error {
  public constructor(id: string) {
    super(`adjustment id ${id} was reused with different identity data`);
    this.name = "AdjustmentIdentityConflictError";
  }
}

export function calculateCommitmentFinancials(input: CommitmentInput): CommitmentFinancials {
  const currency = currencyCode(input.currency);
  const orderId = requiredString(input.orderId, "orderId");
  const baseCommitment = normalizeMoney(input.amount, "base commitment");
  if (baseCommitment.currency !== currency) {
    throw new TypeError("base commitment currency does not match commitment currency");
  }
  const settlement = parseSettlement(input.settlement, currency);
  const rawAdjustments = input.adjustments ?? [];
  if (!Array.isArray(rawAdjustments)) {
    throw new TypeError("commitment adjustments must be an array");
  }
  const unique = new Map<string, NormalizedAdjustment>();
  for (const rawAdjustment of rawAdjustments) {
    const normalized = parseAdjustment(rawAdjustment, currency, orderId);
    const previous = unique.get(normalized.idempotencyKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== normalized.fingerprint) {
        throw new AdjustmentIdempotencyConflictError(normalized.idempotencyKey);
      }
      continue;
    }
    unique.set(normalized.idempotencyKey, normalized);
  }

  const adjustments = Object.freeze([...unique.values()]);
  const byId = new Map<string, NormalizedAdjustment>();
  for (const adjustment of adjustments) {
    const previous = byId.get(adjustment.id);
    if (previous !== undefined) {
      if (previous.idempotencyKey !== adjustment.idempotencyKey || previous.fingerprint !== adjustment.fingerprint) {
        throw new AdjustmentIdentityConflictError(adjustment.id);
      }
      continue;
    }
    byId.set(adjustment.id, adjustment);
  }
  for (const adjustment of adjustments) {
    if (adjustment.kind !== "cashRefund") {
      if (adjustment.linkedAdjustmentId !== undefined) {
        throw new TypeError(`adjustment ${adjustment.id} may not link another adjustment`);
      }
      continue;
    }
    if (adjustment.linkedAdjustmentId === undefined) {
      throw new TypeError(`cash refund ${adjustment.id} must link its source adjustment`);
    }
    const linked = byId.get(adjustment.linkedAdjustmentId);
    if (linked === undefined || (linked.kind !== "deposit" && linked.kind !== "payment" && linked.kind !== "credit")) {
      throw new TypeError(`cash refund ${adjustment.id} links an invalid adjustment`);
    }
  }

  let credits = moneyZero(currency);
  let surcharges = moneyZero(currency);
  let grossPayments = moneyZero(currency);
  let refunds = moneyZero(currency);
  for (const adjustment of adjustments) {
    if (adjustment.kind === "credit") {
      credits = addMoney(credits, adjustment.amount);
    } else if (adjustment.kind === "surcharge") {
      surcharges = addMoney(surcharges, adjustment.amount);
    } else if (adjustment.kind === "deposit" || adjustment.kind === "payment") {
      grossPayments = addMoney(grossPayments, adjustment.amount);
    } else {
      refunds = addMoney(refunds, adjustment.amount);
    }
  }
  const obligation = subtractMoney(addMoney(baseCommitment, surcharges), credits);
  if (refunds.minorUnits > grossPayments.minorUnits) {
    throw new TypeError("cash refunds cannot exceed gross applied payments");
  }
  const appliedPayments = subtractMoney(grossPayments, refunds);
  const outstanding = subtractMoneyOrZero(obligation, appliedPayments);
  const overpayment = subtractMoneyOrZero(appliedPayments, obligation);
  const base = {
    orderId,
    currency,
    baseCommitment,
    obligation,
    credits,
    surcharges,
    grossPayments,
    refunds,
    appliedPayments,
    outstanding,
    overpayment,
    settlementEvidence: settlement?.evidenceRefs ?? Object.freeze([]),
    adjustments,
  };
  return settlement === undefined
    ? base
    : { ...base, actualAcquisitionCost: settlement.amount };
}

export function adjustmentEvidence(adjustment: NormalizedAdjustment): readonly EvidenceRef[] {
  return adjustment.evidenceRefs;
}

export function commitmentDelta(before: CommitmentFinancials, after: CommitmentFinancials): MoneyDelta {
  if (before.currency !== after.currency) {
    throw new TypeError("commitment currency mismatch");
  }
  return moneyDifference(after.obligation, before.obligation);
}

export function assertCommitmentCurrency(value: Money, currency: string): void {
  assertSameCurrency(value, moneyZero(currency));
}
