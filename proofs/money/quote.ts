import { decimalCompare, parsePositiveQuantity } from "./decimal";
import type { Decimal, Quantity } from "./decimal";
import { evidenceRef, parseEvidenceRefs } from "./evidence";
import type { EvidenceRef } from "./evidence";
import { currencyCode, normalizeMoney } from "./money";
import type { Money } from "./money";
import { isRecord, requiredArray, requiredString } from "./validation";

export type ChargeScope =
  | Readonly<{ kind: "quote" }>
  | Readonly<{ kind: "line"; lineId: string }>
  | Readonly<{ kind: "allocated"; lineId: string; method: "fixed" | "proportional" }>;

export type EstimatedChargeValue =
  | Readonly<{ kind: "point"; amount: Money }>
  | Readonly<{ kind: "range"; minimum: Money; maximum: Money }>;

export type ChargeState =
  | Readonly<{ kind: "known"; amount: Money }>
  | Readonly<{ kind: "included"; coveringId: string }>
  | Readonly<{ kind: "estimated"; estimate: EstimatedChargeValue }>
  | Readonly<{ kind: "unknown"; reason: string }>
  | Readonly<{ kind: "notApplicable"; reason: string }>;

export interface ChargeInput {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly scope?: unknown;
  readonly state: unknown;
  readonly evidenceRefs?: unknown;
}

export interface QuoteCharge {
  readonly chargeId: string;
  readonly label: string;
  readonly scope: ChargeScope;
  readonly state: ChargeState;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface QuoteLineInput {
  readonly lineId: unknown;
  readonly description: unknown;
  readonly quantity: unknown;
  readonly unitPrice: unknown;
  readonly evidenceRefs?: unknown;
}

export interface QuoteLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type TaxBasis =
  | Readonly<{ kind: "inclusive" | "exclusive"; basisId: string; evidenceRefs: readonly EvidenceRef[] }>
  | Readonly<{ kind: "unknown"; reason: string; evidenceRefs: readonly EvidenceRef[] }>;

export interface ComparisonScopeInput {
  readonly requirementId: unknown;
  readonly scopeId: unknown;
  readonly items: unknown;
}

export interface ComparisonScopeItemInput {
  readonly itemId: unknown;
  readonly lineId: unknown;
  readonly unit: unknown;
  readonly requiredQuantity: unknown;
}

export interface ComparisonScopeItem {
  readonly itemId: string;
  readonly lineId: string;
  readonly unit: string;
  readonly requiredQuantity: Quantity;
}

export interface ComparisonScope {
  readonly requirementId: string;
  readonly scopeId: string;
  readonly items: readonly ComparisonScopeItem[];
}

export interface TaxBasisInput {
  readonly kind: unknown;
  readonly basisId?: unknown;
  readonly reason?: unknown;
  readonly evidenceRefs?: unknown;
}

export interface QuoteInput {
  readonly quoteId: unknown;
  readonly version: unknown;
  readonly currency: unknown;
  readonly lines: readonly QuoteLineInput[];
  readonly charges?: readonly ChargeInput[];
  readonly taxBasis: TaxBasisInput;
  readonly comparisonScope?: unknown;
  readonly evidenceRefs?: unknown;
}

export interface Quote {
  readonly quoteId: string;
  readonly version: string;
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  readonly charges: readonly QuoteCharge[];
  readonly taxBasis: TaxBasis;
  readonly comparisonScope?: ComparisonScope;
  readonly evidenceRefs: readonly EvidenceRef[];
}

function parseScope(input: unknown): ChargeScope {
  if (input === undefined || input === "quote") {
    return Object.freeze({ kind: "quote" });
  }
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new TypeError("charge scope must be quote, line, or allocated");
  }
  if (input.kind === "quote") {
    return Object.freeze({ kind: "quote" });
  }
  const lineId = requiredString(input.lineId, "charge scope lineId");
  if (input.kind === "line") {
    return Object.freeze({ kind: "line", lineId });
  }
  if (input.kind === "allocated") {
    if (input.method !== "fixed" && input.method !== "proportional") {
      throw new TypeError("allocated charge scope method must be fixed or proportional");
    }
    return Object.freeze({ kind: "allocated", lineId, method: input.method });
  }
  throw new TypeError("charge scope kind is invalid");
}

function parseChargeState(input: unknown): ChargeState {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new TypeError("charge state must be a discriminated object");
  }

  if (input.kind === "known") {
    return Object.freeze({ kind: "known", amount: normalizeMoney(input.amount, "known charge amount") });
  }
  if (input.kind === "included") {
    return Object.freeze({ kind: "included", coveringId: requiredString(input.coveringId, "included coveringId") });
  }
  if (input.kind === "unknown") {
    return Object.freeze({ kind: "unknown", reason: requiredString(input.reason, "unknown charge reason") });
  }
  if (input.kind === "notApplicable") {
    return Object.freeze({ kind: "notApplicable", reason: requiredString(input.reason, "notApplicable charge reason") });
  }
  if (input.kind === "estimated") {
    const estimate = input.estimate;
    if (!isRecord(estimate) || typeof estimate.kind !== "string") {
      throw new TypeError("estimated charge requires a point or range estimate");
    }
    if (estimate.kind === "point") {
      return Object.freeze({
        kind: "estimated",
        estimate: Object.freeze({ kind: "point", amount: normalizeMoney(estimate.amount, "estimated charge amount") }),
      });
    }
    if (estimate.kind === "range") {
      const minimum = normalizeMoney(estimate.minimum, "estimated charge minimum");
      const maximum = normalizeMoney(estimate.maximum, "estimated charge maximum");
      if (minimum.currency !== maximum.currency || minimum.minorUnits > maximum.minorUnits) {
        throw new TypeError("estimated charge range is invalid");
      }
      return Object.freeze({ kind: "estimated", estimate: Object.freeze({ kind: "range", minimum, maximum }) });
    }
  }

  throw new TypeError("charge state kind is invalid");
}

export function charge(input: ChargeInput): QuoteCharge {
  const chargeId = requiredString(input.chargeId, "chargeId");
  const label = requiredString(input.label, "charge label");
  return Object.freeze({
    chargeId,
    label,
    scope: parseScope(input.scope),
    state: parseChargeState(input.state),
    evidenceRefs: parseEvidenceRefs(input.evidenceRefs, `charge ${chargeId} evidenceRefs`),
  });
}

export function knownCharge(input: {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly amount: unknown;
  readonly scope?: unknown;
  readonly evidenceRefs?: unknown;
}): QuoteCharge {
  return charge({
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state: { kind: "known", amount: input.amount },
    evidenceRefs: input.evidenceRefs,
  });
}

export function includedCharge(input: {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly coveringId: unknown;
  readonly scope?: unknown;
  readonly evidenceRefs?: unknown;
}): QuoteCharge {
  return charge({
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state: { kind: "included", coveringId: input.coveringId },
    evidenceRefs: input.evidenceRefs,
  });
}

export function estimatedCharge(input: {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly amount?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly scope?: unknown;
  readonly evidenceRefs?: unknown;
}): QuoteCharge {
  const state = input.amount !== undefined
    ? { kind: "estimated", estimate: { kind: "point", amount: input.amount } }
    : { kind: "estimated", estimate: { kind: "range", minimum: input.minimum, maximum: input.maximum } };
  return charge({
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state,
    evidenceRefs: input.evidenceRefs,
  });
}

export function unknownCharge(input: {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly reason: unknown;
  readonly scope?: unknown;
  readonly evidenceRefs?: unknown;
}): QuoteCharge {
  return charge({
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state: { kind: "unknown", reason: input.reason },
    evidenceRefs: input.evidenceRefs,
  });
}

export function notApplicableCharge(input: {
  readonly chargeId: unknown;
  readonly label: unknown;
  readonly reason: unknown;
  readonly scope?: unknown;
  readonly evidenceRefs?: unknown;
}): QuoteCharge {
  return charge({
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state: { kind: "notApplicable", reason: input.reason },
    evidenceRefs: input.evidenceRefs,
  });
}

export function quoteLine(input: QuoteLineInput): QuoteLine {
  const lineId = requiredString(input.lineId, "lineId");
  return Object.freeze({
    lineId,
    description: requiredString(input.description, "line description"),
    quantity: parsePositiveQuantity(input.quantity, `line ${lineId} quantity`),
    unitPrice: normalizeMoney(input.unitPrice, `line ${lineId} unit price`),
    evidenceRefs: parseEvidenceRefs(input.evidenceRefs, `line ${lineId} evidenceRefs`),
  });
}

export function comparisonScope(input: ComparisonScopeInput): ComparisonScope {
  const requirementId = requiredString(input.requirementId, "comparison requirementId");
  const scopeId = requiredString(input.scopeId, "comparison scopeId");
  const itemIds = new Set<string>();
  const lineIds = new Set<string>();
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new TypeError("comparison scope requires at least one item");
  }
  const items = Object.freeze(rawItems.map((rawItem, index) => {
    if (!isRecord(rawItem)) {
      throw new TypeError(`comparison item ${index} must be an object`);
    }
    const itemId = requiredString(rawItem.itemId, `comparison item ${index} itemId`);
    const lineId = requiredString(rawItem.lineId, `comparison item ${index} lineId`);
    if (itemIds.has(itemId)) {
      throw new TypeError(`duplicate comparison item ${itemId}`);
    }
    if (lineIds.has(lineId)) {
      throw new TypeError(`duplicate comparison line mapping ${lineId}`);
    }
    itemIds.add(itemId);
    lineIds.add(lineId);
    return Object.freeze({
      itemId,
      lineId,
      unit: requiredString(rawItem.unit, `comparison item ${index} unit`),
      requiredQuantity: parsePositiveQuantity(rawItem.requiredQuantity, `comparison item ${index} required quantity`),
    });
  }));
  return Object.freeze({
    requirementId,
    scopeId,
    items,
  });
}

export function taxBasis(input: TaxBasisInput): TaxBasis {
  const evidenceRefs = parseEvidenceRefs(input.evidenceRefs, "tax basis evidenceRefs");
  if (input.kind === "inclusive" || input.kind === "exclusive") {
    return Object.freeze({
      kind: input.kind,
      basisId: input.basisId === undefined ? "unspecified" : requiredString(input.basisId, "tax basisId"),
      evidenceRefs,
    });
  }
  if (input.kind === "unknown") {
    return Object.freeze({
      kind: "unknown",
      reason: requiredString(input.reason, "tax basis reason"),
      evidenceRefs,
    });
  }
  throw new TypeError("tax basis kind must be inclusive, exclusive, or unknown");
}

export function inclusiveTaxBasis(basisId = "unspecified", evidenceRefs: readonly EvidenceRef[] = []): TaxBasis {
  return taxBasis({ kind: "inclusive", basisId, evidenceRefs });
}

export function exclusiveTaxBasis(basisId = "unspecified", evidenceRefs: readonly EvidenceRef[] = []): TaxBasis {
  return taxBasis({ kind: "exclusive", basisId, evidenceRefs });
}

export function unknownTaxBasis(reason: unknown, evidenceRefs: readonly EvidenceRef[] = []): TaxBasis {
  return taxBasis({ kind: "unknown", reason, evidenceRefs });
}

export function createQuote(input: QuoteInput): Quote {
  const quoteId = requiredString(input.quoteId, "quoteId");
  const version = requiredString(input.version, "quote version");
  const currency = currencyCode(input.currency);
  const rawLines = requiredArray(input.lines, "quote lines");
  if (rawLines.length === 0) {
    throw new TypeError("quote must contain at least one line");
  }

  const lines = Object.freeze(rawLines.map((value, index) => {
    if (!isRecord(value)) {
      throw new TypeError(`quote lines[${index}] must be an object`);
    }
    const line = quoteLine({
      lineId: value.lineId,
      description: value.description,
      quantity: value.quantity,
      unitPrice: value.unitPrice,
      evidenceRefs: value.evidenceRefs,
    });
    if (line.unitPrice.currency !== currency) {
      throw new TypeError(`line ${line.lineId} currency does not match quote currency`);
    }
    return line;
  }));

  const lineIds = new Set<string>();
  for (const line of lines) {
    if (lineIds.has(line.lineId)) {
      throw new TypeError(`duplicate quote line ${line.lineId}`);
    }
    lineIds.add(line.lineId);
  }

  const rawCharges = input.charges ?? [];
  const charges = Object.freeze(rawCharges.map((value, index) => {
    if (!isRecord(value)) {
      throw new TypeError(`quote charges[${index}] must be an object`);
    }
    const parsed = charge({
      chargeId: value.chargeId,
      label: value.label,
      scope: value.scope,
      state: value.state,
      evidenceRefs: value.evidenceRefs,
    });
    if (parsed.state.kind === "known" && parsed.state.amount.currency !== currency) {
      throw new TypeError(`charge ${parsed.chargeId} currency does not match quote currency`);
    }
    if (parsed.state.kind === "estimated") {
      const estimate = parsed.state.estimate;
      const estimateCurrency = estimate.kind === "point" ? estimate.amount.currency : estimate.minimum.currency;
      const maximumCurrency = estimate.kind === "point" ? estimate.amount.currency : estimate.maximum.currency;
      if (estimateCurrency !== currency || maximumCurrency !== currency) {
        throw new TypeError(`charge ${parsed.chargeId} currency does not match quote currency`);
      }
    }
    if ((parsed.scope.kind === "line" || parsed.scope.kind === "allocated") && !lineIds.has(parsed.scope.lineId)) {
      throw new TypeError(`charge ${parsed.chargeId} references an unknown line`);
    }
    return parsed;
  }));

  const chargeIds = new Set<string>();
  for (const parsed of charges) {
    if (chargeIds.has(parsed.chargeId)) {
      throw new TypeError(`duplicate quote charge ${parsed.chargeId}`);
    }
    chargeIds.add(parsed.chargeId);
  }

  const chargesById = new Map(charges.map((parsed) => [parsed.chargeId, parsed]));
  const resolveCoverage = (coveringId: string, path: ReadonlySet<string>): void => {
    if (lineIds.has(coveringId)) {
      return;
    }
    const coveringCharge = chargesById.get(coveringId);
    if (coveringCharge === undefined) {
      return;
    }
    if (coveringCharge.state.kind !== "included") {
      return;
    }
    if (path.has(coveringCharge.chargeId)) {
      throw new TypeError(`included charge coverage cycle includes ${coveringCharge.chargeId}`);
    }
    const nextPath = new Set(path);
    nextPath.add(coveringCharge.chargeId);
    resolveCoverage(coveringCharge.state.coveringId, nextPath);
  };
  for (const parsed of charges) {
    if (parsed.state.kind === "included") {
      resolveCoverage(parsed.state.coveringId, new Set([parsed.chargeId]));
    }
  }

  const parsedTaxBasis = taxBasis(input.taxBasis);
  const parsedComparisonScope = input.comparisonScope === undefined
    ? undefined
    : (() => {
      if (!isRecord(input.comparisonScope)) {
        throw new TypeError("comparisonScope must be an object");
      }
      return comparisonScope({
        requirementId: input.comparisonScope.requirementId,
        scopeId: input.comparisonScope.scopeId,
        items: input.comparisonScope.items,
      });
    })();
  if (parsedComparisonScope !== undefined) {
    const mappedLineIds = new Set<string>();
    for (const item of parsedComparisonScope.items) {
      if (mappedLineIds.has(item.lineId) || !lineIds.has(item.lineId)) {
        throw new TypeError(`comparison item ${item.itemId} references an unknown or duplicate line`);
      }
      const line = lines.find((candidate) => candidate.lineId === item.lineId);
      if (line === undefined || decimalCompare(line.quantity, item.requiredQuantity) !== 0) {
        throw new TypeError(`comparison item ${item.itemId} quantity does not match its quote line`);
      }
      mappedLineIds.add(item.lineId);
    }
    if (mappedLineIds.size !== lines.length) {
      throw new TypeError("comparison scope must map every quote line");
    }
  }
  const base = {
    quoteId,
    version,
    currency,
    lines,
    charges,
    taxBasis: parsedTaxBasis,
    evidenceRefs: parseEvidenceRefs(input.evidenceRefs, `quote ${quoteId} evidenceRefs`),
  };
  return parsedComparisonScope === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, comparisonScope: parsedComparisonScope });
}

export function quoteEvidenceRef(sourceId: unknown, version: unknown, locator?: unknown): EvidenceRef {
  return evidenceRef({ sourceId, version, locator });
}

export function decimalQuantityString(value: Decimal): string {
  return value.toString();
}
