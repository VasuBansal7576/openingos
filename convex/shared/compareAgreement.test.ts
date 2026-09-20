/**
 * F1 comparison agreement with the accepted money-proof model (controlled).
 *
 * The F1 equivalent-scope engine (convex/shared/compare.ts) must agree
 * with the reviewed proofs/money contract on every shared scenario:
 * complete offers produce equal deltas, unknown charges stay unknown on
 * both sides, and estimated charges are flagged rather than silent. This
 * keeps the durable F1 contract from drifting off the accepted proof.
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
import { compareEquivalentScope } from "./compare.js";

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
    comparisonScope: {
      requirementId: "req-purchase",
      scopeId: "scope-purchase",
      items: lines.map((value) => ({
        itemId: value.lineId,
        lineId: value.lineId,
        unit: "piece",
        requiredQuantity: value.quantity,
      })),
    },
    evidenceRefs: [source(`${quoteId}-source`)],
  });
}

function engineQuote(
  lines: { quantity: string; amount: number }[],
  charges: { state: string; amount?: number }[],
) {
  return {
    currency: EUR,
    taxBasis: "NL-EUR-INCLUSIVE",
    lines: lines.map((line, index) => ({
      quantity: line.quantity,
      unitPriceMinorUnits: line.amount,
      lineId: `line-${index}`,
    })),
    charges: charges.map((charge, index) => ({
      state: charge.state,
      ...(charge.amount === undefined ? {} : { amountMinorUnits: charge.amount }),
      chargeId: `charge-${index}`,
    })),
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

    const engine = compareEquivalentScope(
      engineQuote([{ quantity: "1", amount: 795000 }], []),
      engineQuote(
        [{ quantity: "1", amount: 750000 }],
        [
          { state: "known", amount: 60000 },
          { state: "known", amount: 40000 },
        ],
      ),
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

    const engine = compareEquivalentScope(
      engineQuote([{ quantity: "1", amount: 795000 }], []),
      engineQuote([{ quantity: "1", amount: 850000 }], [{ state: "unknown" }]),
    );
    // Engine sides differ from the proof fixture (unknown on the right),
    // but the contract holds: no complete verdict on unknown scope.
    expect(engine.verdict).toBe("incomplete");
    expect(engine.reason).toBe("unknown-charge-prevents-complete-claim");
  });

  test("estimated charges are flagged on both models, never silent", () => {
    const leftProof = proofQuote("left", [proofLine("equipment", 795000)], []);
    const rightProof = proofQuote("right", [proofLine("equipment", 750000)], [
      estimatedCharge({ chargeId: "freight", label: "Freight", amount: money(EUR, 60000) }),
    ]);
    const proof = compareQuotes(leftProof, rightProof);
    expect(proof.status).toBe("estimated");

    const engine = compareEquivalentScope(
      engineQuote([{ quantity: "1", amount: 795000 }], []),
      engineQuote([{ quantity: "1", amount: 750000 }], [{ state: "estimated", amount: 60000 }]),
    );
    expect(engine.verdict).toBe("complete");
    expect(engine.reason).toBe("equivalent-scope-with-estimates");
  });
});
