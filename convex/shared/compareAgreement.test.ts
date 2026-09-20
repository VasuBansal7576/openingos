/**
 * F1 comparison agreement with the accepted money-proof model (controlled).
 *
 * The stored-quote comparison (convex/shared/compare.ts over
 * quoteSemantics.ts) must agree with the reviewed proofs/money contract
 * on every shared scenario: complete offers produce equal deltas,
 * unknown charges stay unknown on both sides, and estimated charges are
 * flagged rather than silent. This keeps the durable F1 contract from
 * drifting off the accepted proof.
 */

import { describe, expect, test } from "bun:test";
import {
  compareQuotes,
  createQuote,
  estimatedCharge,
  EUR,
  includedCharge,
  inclusiveTaxBasis,
  knownCharge,
  money,
  quoteLine,
  unknownCharge,
  evidenceRef,
} from "../../proofs/money/index.js";
import { compareStoredQuoteDocuments } from "./compare.js";
import { storedQuoteParts } from "./quoteSemantics.js";

const source = (id: string) => evidenceRef({ sourceId: id, version: "v1", locator: "controlled" });

function proofLine(lineId: string, amount: number, quantityValue = "1") {
  return quoteLine({
    lineId,
    description: lineId,
    quantity: quantityValue,
    unitPrice: money(EUR, amount),
    evidenceRefs: [source(`${lineId}-source`)],
  });
}

function proofScope(lines: readonly ReturnType<typeof proofLine>[]) {
  return {
    requirementId: "req-purchase",
    scopeId: "scope-purchase",
    items: lines.map((value) => ({
      itemId: value.lineId,
      lineId: value.lineId,
      unit: "piece",
      requiredQuantity: value.quantity,
    })),
  };
}

function proofQuote(
  quoteId: string,
  lines: readonly ReturnType<typeof proofLine>[],
  charges: readonly ReturnType<typeof knownCharge>[] = [],
) {
  return createQuote({
    quoteId,
    version: "v1",
    currency: EUR,
    lines,
    charges,
    taxBasis: inclusiveTaxBasis("NL-EUR-INCLUSIVE", [source(`${quoteId}-source`)]),
    comparisonScope: proofScope(lines),
    evidenceRefs: [source(`${quoteId}-source`)],
  });
}

function storedQuote(version: string, lines: readonly ReturnType<typeof proofLine>[], charges: readonly ReturnType<typeof knownCharge>[]) {
  const quote = proofQuote(version, lines, charges);
  const parts = storedQuoteParts(quote);
  return {
    version,
    currency: parts.currency,
    lines: parts.lines,
    charges: parts.charges,
    taxBasis: parts.taxBasis,
    ...(parts.comparisonScope === undefined ? {} : { comparisonScope: parts.comparisonScope }),
    evidenceRefs: parts.evidenceRefs,
  };
}

describe("money-proof agreement", () => {
  test("benchmark pair agrees on complete delta and cheaper side", () => {
    const leftProof = proofQuote("left", [proofLine("equipment", 795000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);
    const rightProof = proofQuote("right", [proofLine("equipment", 750000)], [
      knownCharge({ chargeId: "freight", label: "Freight", amount: money(EUR, 60000) }),
      knownCharge({ chargeId: "installation", label: "Installation", amount: money(EUR, 40000) }),
    ]);
    const proof = compareQuotes(leftProof, rightProof);
    expect(proof.status).toBe("complete");
    expect(proof.equivalent?.delta.minorUnits).toBe(-55000);
    expect(proof.equivalent?.cheaperQuoteId).toBe("left");

    const engine = compareStoredQuoteDocuments(
      storedQuote("left", [proofLine("equipment", 795000)], [
        includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
        includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
      ]),
      storedQuote("right", [proofLine("equipment", 750000)], [
        knownCharge({ chargeId: "freight", label: "Freight", amount: money(EUR, 60000) }),
        knownCharge({ chargeId: "installation", label: "Installation", amount: money(EUR, 40000) }),
      ]),
    );
    expect(engine.verdict).toBe("complete");
    expect(engine.differenceMinorUnits).toBe(55000);
    expect(engine.cheaper).toBe("left");
    if (engine.differenceMinorUnits === null) throw new Error("expected a complete difference");
    expect(Math.abs(proof.equivalent?.delta.minorUnits ?? 0)).toBe(engine.differenceMinorUnits);
  });

  test("unknown charges stay unknown on both models", () => {
    const leftProof = proofQuote("left", [proofLine("equipment", 795000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      unknownCharge({ chargeId: "installation", label: "Installation", reason: "supplier did not state it" }),
    ]);
    const rightProof = proofQuote("right", [proofLine("equipment", 850000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);
    const proof = compareQuotes(leftProof, rightProof);
    expect(proof.status).toBe("incomplete");
    expect(proof.equivalent).toBeUndefined();

    const engine = compareStoredQuoteDocuments(
      storedQuote("left", [proofLine("equipment", 795000)], [
        includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
        unknownCharge({ chargeId: "installation", label: "Installation", reason: "supplier did not state it" }),
      ]),
      storedQuote("right", [proofLine("equipment", 850000)], [
        includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
        includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
      ]),
    );
    expect(engine.verdict).toBe("incomplete");
    expect(engine.differenceMinorUnits).toBeNull();
  });

  test("estimated charges are flagged on both models, never silent", () => {
    const leftProof = proofQuote("left", [proofLine("equipment", 795000)], []);
    const rightProof = proofQuote("right", [proofLine("equipment", 750000)], [
      estimatedCharge({ chargeId: "freight", label: "Freight", amount: money(EUR, 60000) }),
    ]);
    const proof = compareQuotes(leftProof, rightProof);
    expect(proof.status).toBe("estimated");

    const engine = compareStoredQuoteDocuments(
      storedQuote("left", [proofLine("equipment", 795000)], []),
      storedQuote("right", [proofLine("equipment", 750000)], [
        estimatedCharge({ chargeId: "freight", label: "Freight", amount: money(EUR, 60000) }),
      ]),
    );
    expect(engine.verdict).toBe("complete");
    expect(engine.reason).toBe("equivalent-scope-with-estimates");
  });
});
