import { expect, test } from "bun:test";
import {
  storedQuoteCost,
  type StoredComparableQuote,
  type StoredQuoteCharge,
  type StoredQuoteLine,
} from "./quoteSemantics.js";

const line = (lineId: string, minorUnits: number, quantity = "1"): StoredQuoteLine => ({
  lineId,
  description: `${lineId} line`,
  quantity,
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

const inclusiveTax = { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] };

function quoteWith(
  lines: readonly StoredQuoteLine[],
  charges: readonly StoredQuoteCharge[] = [],
  taxBasis: StoredComparableQuote["taxBasis"] = inclusiveTax,
): StoredComparableQuote {
  return { version: "v1", currency: "EUR", lines, charges, taxBasis, evidenceRefs: [] };
}

test("sums quoted lines with known charges on an accepted tax basis", () => {
  const cost = storedQuoteCost(quoteWith([line("machine", 750000)], [knownCharge("freight", "Freight", 60000), knownCharge("installation", "Installation", 40000)]));
  expect(cost.status).toBe("complete");
  expect(cost.totalMinorUnits).toBe(850000);
  expect(cost.comparableTotalMinorUnits).toBeNull();
  expect(cost.reason).toContain("without an accepted comparison scope");
});

test("keeps an exact total for a scope-bearing quote and proves comparable only through the accepted result", () => {
  const scoped = (requiredQuantity: string): StoredComparableQuote => ({
    ...quoteWith([line("machine", 750000)], [knownCharge("freight", "Freight", 60000), knownCharge("installation", "Installation", 40000)]),
    comparisonScope: {
      requirementId: "requirement-e4",
      scopeId: "scope-e4",
      items: [{ itemId: "item-e4", lineId: "machine", unit: "piece", requiredQuantity }],
    },
  });
  const withScope = storedQuoteCost(scoped("1"));
  expect(withScope.status).toBe("complete");
  expect(withScope.totalMinorUnits).toBe(850000);
  expect(withScope.comparableTotalMinorUnits).toBe(850000);
  expect(withScope.reason).toBe("complete comparable scope");

  const mismatchedScope = storedQuoteCost(scoped("2"));
  expect(mismatchedScope.status).toBe("incomplete");
  expect(mismatchedScope.totalMinorUnits).toBeNull();
  expect(mismatchedScope.comparableTotalMinorUnits).toBeNull();
});

test("counts an included charge once through its covering line", () => {
  const cost = storedQuoteCost(quoteWith([line("machine", 795000)], [{
    chargeId: "delivery",
    label: "Delivery",
    scope: { kind: "quote" },
    state: { kind: "included", coveringId: "machine" },
    evidenceRefs: [],
  }]));
  expect(cost.status).toBe("complete");
  expect(cost.totalMinorUnits).toBe(795000);
  expect(cost.comparableTotalMinorUnits).toBeNull();
});

test("fails closed for unknown and estimated charges", () => {
  const unknown = storedQuoteCost(quoteWith([line("machine", 750000)], [{
    chargeId: "freight",
    label: "Freight",
    scope: { kind: "quote" },
    state: { kind: "unknown", reason: "not confirmed" },
    evidenceRefs: [],
  }]));
  expect(unknown.status).toBe("incomplete");
  expect(unknown.totalMinorUnits).toBeNull();
  expect(unknown.reason).toContain("Freight");

  const estimated = storedQuoteCost(quoteWith([line("machine", 750000)], [{
    chargeId: "installation",
    label: "Installation",
    scope: { kind: "quote" },
    state: { kind: "estimated", estimate: { kind: "point", amount: { currency: "EUR", minorUnits: 50000 } } },
    evidenceRefs: [],
  }]));
  expect(estimated.status).toBe("estimated");
  expect(estimated.totalMinorUnits).toBeNull();
  expect(estimated.estimatedMinimumMinorUnits).toBe(50000);
  expect(estimated.estimatedMaximumMinorUnits).toBe(50000);
});

test("fails closed for unresolved included coverage and an unknown tax basis", () => {
  const dangling = storedQuoteCost(quoteWith([line("machine", 750000)], [{
    chargeId: "delivery",
    label: "Delivery",
    scope: { kind: "quote" },
    state: { kind: "included", coveringId: "ghost-line" },
    evidenceRefs: [],
  }]));
  expect(dangling.status).toBe("incomplete");
  expect(dangling.totalMinorUnits).toBeNull();

  const unknownBasis = storedQuoteCost(quoteWith([line("machine", 750000)], [], { kind: "unknown", reason: "basis not confirmed", evidenceRefs: [] }));
  expect(unknownBasis.status).toBe("incomplete");
  expect(unknownBasis.totalMinorUnits).toBeNull();
  expect(unknownBasis.reason).toContain("tax basis");
});

test("rejects malformed stored money through the accepted constructors", () => {
  const malformed = storedQuoteCost({
    ...quoteWith([{
      lineId: "machine",
      description: "Machine",
      quantity: "not-a-quantity",
      unitPrice: { currency: "EUR", minorUnits: 750000 },
      evidenceRefs: [],
    }]),
  });
  expect(malformed.status).toBe("incomplete");
  expect(malformed.totalMinorUnits).toBeNull();
  expect(malformed.comparableTotalMinorUnits).toBeNull();
});

test("negative stored money is rejected by the accepted money boundary", () => {
  const negative = storedQuoteCost(quoteWith([{
    lineId: "machine",
    description: "Machine",
    quantity: "1",
    unitPrice: { currency: "EUR", minorUnits: -750000 },
    evidenceRefs: [],
  }]));
  expect(negative.status).toBe("incomplete");
  expect(negative.totalMinorUnits).toBeNull();
  expect(negative.comparableTotalMinorUnits).toBeNull();
});
