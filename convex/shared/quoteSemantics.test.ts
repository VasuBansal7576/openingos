import { expect, test } from "bun:test";
import {
  compareStoredQuotes,
  type StoredComparableQuote,
  type StoredQuoteCharge,
  type StoredQuoteLine,
} from "./quoteSemantics.js";

const line = (lineId: string, minorUnits: number): StoredQuoteLine => ({
  lineId,
  description: `${lineId} line`,
  quantity: "1",
  unitPrice: { currency: "EUR", minorUnits },
  evidenceRefs: [],
});

const knownCharge = (chargeId: string, label: string, minorUnits: number): StoredQuoteCharge => ({
  chargeId,
  label,
  scope: { kind: "quote" },
  state: { kind: "known", amount: { currency: "EUR", minorUnits } },
  evidenceRefs: [],
});

const includedCharge = (chargeId: string, label: string, coveringId: string): StoredQuoteCharge => ({
  chargeId,
  label,
  scope: { kind: "quote" },
  state: { kind: "included", coveringId },
  evidenceRefs: [],
});

const inclusiveTax = { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] };

const scope = (lineId: string) => ({
  requirementId: "requirement-e4",
  scopeId: "scope-e4",
  items: [{ itemId: "item-e4", lineId, unit: "piece", requiredQuantity: "1" }],
});

/** Supplier A: equipment 7950 with delivery and installation included. */
const includedOffer = (): StoredComparableQuote => ({
  version: "v1",
  currency: "EUR",
  lines: [line("machine", 795000)],
  charges: [includedCharge("delivery", "Delivery", "machine"), includedCharge("installation", "Installation", "machine")],
  taxBasis: inclusiveTax,
  comparisonScope: scope("machine"),
  evidenceRefs: [],
});

/** Supplier B: equipment 7500 plus 600 delivery and 400 installation. */
const itemizedOffer = (): StoredComparableQuote => ({
  version: "v1",
  currency: "EUR",
  lines: [line("machine", 750000)],
  charges: [knownCharge("freight", "Freight", 60000), knownCharge("installation", "Installation", 40000)],
  taxBasis: inclusiveTax,
  comparisonScope: scope("machine"),
  evidenceRefs: [],
});

test("reports the left side as cheaper when same-version quotes make left the cheaper offer", () => {
  const result = compareStoredQuotes(includedOffer(), itemizedOffer());
  expect(result.status).toBe("complete");
  expect(result.cheaper).toBe("left");
  expect(result.differenceMinorUnits).toBe(55000);
});

test("reports the right side as cheaper when same-version quotes make right the cheaper offer", () => {
  const result = compareStoredQuotes(itemizedOffer(), includedOffer());
  expect(result.status).toBe("complete");
  expect(result.cheaper).toBe("right");
  expect(result.differenceMinorUnits).toBe(55000);
});

test("reports equal totals for identical same-version offers with a zero difference", () => {
  const result = compareStoredQuotes(includedOffer(), includedOffer());
  expect(result.status).toBe("complete");
  expect(result.cheaper).toBe("equal");
  expect(result.differenceMinorUnits).toBe(0);
});

test("keeps the incompatible status for mixed currencies without a cheaper side", () => {
  const euro = includedOffer();
  const dollarBase = itemizedOffer();
  const dollarLine = dollarBase.lines[0];
  if (dollarLine === undefined) throw new Error("itemized offer must include its equipment line");
  const dollar: StoredComparableQuote = {
    ...dollarBase,
    currency: "USD",
    lines: [{ ...dollarLine, unitPrice: { currency: "USD", minorUnits: 750000 } }],
    charges: dollarBase.charges.map((charge) =>
      charge.state.kind === "known"
        ? { ...charge, state: { kind: "known", amount: { currency: "USD", minorUnits: charge.state.amount.minorUnits } } }
        : charge,
    ),
  };
  const result = compareStoredQuotes(euro, dollar);
  expect(result.status).toBe("incompatible");
  expect(result.cheaper).toBeNull();
  expect(result.differenceMinorUnits).toBeNull();
});
