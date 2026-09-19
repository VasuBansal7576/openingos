import { describe, expect, it } from "bun:test";
import {
  AdjustmentIdempotencyConflictError,
  calculateCommitmentFinancials,
  calculateForecast,
  compareQuotes,
  createQuote,
  DecimalValidationError,
  decimalToString,
  evidenceRef,
  estimatedCharge,
  exclusiveTaxBasis,
  EUR,
  includedCharge,
  inclusiveTaxBasis,
  money,
  MoneyValidationError,
  multiplyMoneyByQuantity,
  notApplicableCharge,
  quantity,
  quoteLine,
  unknownCharge,
} from "./index";
import type { ChargeInput, FinancialAdjustmentInput } from "./index";

const source = (id: string) => evidenceRef({ sourceId: id, version: "v1", locator: "controlled" });

function line(lineId: string, amount: number, quantityValue: string = "1") {
  return quoteLine({
    lineId,
    description: lineId,
    quantity: quantityValue,
    unitPrice: money(EUR, amount),
    evidenceRefs: [source(`${lineId}-source`)],
  });
}

function quote(
  quoteId: string,
  lines: readonly ReturnType<typeof line>[],
  charges: readonly ChargeInput[] = [],
  tax = inclusiveTaxBasis("NL-EUR-INCLUSIVE", [source(`${quoteId}-source`)]),
) {
  return createQuote({
    quoteId,
    version: "v1",
    currency: EUR,
    lines,
    charges,
    taxBasis: tax,
    evidenceRefs: [source(`${quoteId}-source`)],
  });
}

function knownChargeForTest(input: {
  chargeId: string;
  label: string;
  amount: number;
  scope?: unknown;
}) {
  return {
    chargeId: input.chargeId,
    label: input.label,
    scope: input.scope,
    state: { kind: "known", amount: money(EUR, input.amount) },
    evidenceRefs: [source(`${input.chargeId}-source`)],
  };
}

describe("deterministic EUR money", () => {
  it("uses exact minor units and documented half-up quantity rounding", () => {
    expect(multiplyMoneyByQuantity(money(EUR, 100), quantity("1.005")).minorUnits).toBe(101);
    expect(multiplyMoneyByQuantity(money(EUR, 7950), quantity("1.25")).minorUnits).toBe(9938);
    expect(decimalToString(quantity("2.5000"))).toBe("2.5");
  });

  it("rejects invalid, negative, unsafe, and mismatched monetary inputs", () => {
    expect(() => money(EUR, -1)).toThrow(MoneyValidationError);
    expect(() => money(EUR, Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyValidationError);
    expect(() => quantity("-0.5")).toThrow(DecimalValidationError);
    expect(() => money("USD", 1)).not.toThrow();
    expect(() => multiplyMoneyByQuantity(money(EUR, Number.MAX_SAFE_INTEGER), quantity("2"))).toThrow(MoneyValidationError);
  });
});

describe("quote comparison", () => {
  it("does not imply a saving when installation is unknown", () => {
    const left = quote("left", [line("equipment", 7950)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment", evidenceRefs: [source("freight")] }),
      unknownCharge({ chargeId: "installation", label: "Installation", reason: "supplier did not state it", evidenceRefs: [source("installation")] }),
    ]);
    const right = quote("right", [line("equipment", 8500)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);

    const result = compareQuotes(left, right);
    expect(result.status).toBe("incomplete");
    expect(result.left.knownTotal.minorUnits).toBe(7950);
    expect(result.equivalent).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("Installation");
  });

  it("calculates a deterministic delta only for equivalent complete offers", () => {
    const left = quote("left", [line("equipment", 7950)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);
    const right = quote("right", [line("equipment", 7500)], [
      knownChargeForTest({ chargeId: "freight", label: "Freight", amount: 600 }),
      knownChargeForTest({ chargeId: "installation", label: "Installation", amount: 400 }),
    ]);

    const result = compareQuotes(left, right);
    expect(result.status).toBe("complete");
    expect(result.left.total?.minorUnits).toBe(7950);
    expect(result.right.total?.minorUnits).toBe(8500);
    expect(result.equivalent?.delta.minorUnits).toBe(-550);
    expect(result.equivalent?.savings.minorUnits).toBe(550);
    expect(result.equivalent?.cheaperQuoteId).toBe("left");
  });

  it("counts shared freight once and refuses unallocated partial selection", () => {
    const left = quote("left", [line("machine", 1000), line("grinder", 1000)], [
      knownChargeForTest({ chargeId: "freight", label: "Shared freight", amount: 100 }),
    ]);
    const right = quote("right", [line("machine", 1000), line("grinder", 1000)], [
      knownChargeForTest({ chargeId: "freight", label: "Shared freight", amount: 100 }),
    ]);

    const complete = compareQuotes(left, right);
    expect(complete.status).toBe("complete");
    expect(complete.left.total?.minorUnits).toBe(2100);

    const partial = compareQuotes(left, right, {
      leftSelection: [{ lineId: "machine", quantity: "1" }],
      rightSelection: [{ lineId: "machine", quantity: "1" }],
    });
    expect(partial.status).toBe("incomplete");
    expect(partial.left.knownTotal.minorUnits).toBe(1000);
    expect(partial.reasons.join(" ")).toContain("explicit allocation");
  });

  it("supports explicit proportional allocation and distinguishes estimates", () => {
    const left = quote("left", [line("machine", 1000, "2")], [
      knownChargeForTest({ chargeId: "freight", label: "Allocated freight", amount: 100, scope: { kind: "allocated", lineId: "machine", method: "proportional" } }),
    ]);
    const right = quote("right", [line("machine", 1000, "2")], [
      estimatedCharge({ chargeId: "freight", label: "Estimated freight", amount: money(EUR, 100), scope: { kind: "allocated", lineId: "machine", method: "proportional" } }),
    ]);
    const partial = compareQuotes(left, right, {
      leftSelection: [{ lineId: "machine", quantity: "1" }],
      rightSelection: [{ lineId: "machine", quantity: "1" }],
    });
    expect(partial.status).toBe("estimated");
    expect(partial.left.knownTotal.minorUnits).toBe(1050);
    expect(partial.right.knownTotal.minorUnits).toBe(1000);
    expect(partial.right.estimatedRange?.minimum.minorUnits).toBe(50);
  });

  it("does not compare mixed tax bases as equivalent", () => {
    const left = quote("left", [line("equipment", 1000)], [], inclusiveTaxBasis("NL-EUR-INCLUSIVE"));
    const right = quote("right", [line("equipment", 1000)], [], exclusiveTaxBasis("NL-EUR-EXCLUSIVE"));
    const result = compareQuotes(left, right);
    expect(result.status).toBe("incompatible");
    expect(result.equivalent).toBeUndefined();
  });
});

describe("forecast and commitment financial state", () => {
  it("counts ordered, settled, selected, and estimated quantities once", () => {
    const result = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "10",
        ordered: {
          quantity: "4",
          unitPrice: money(EUR, 100),
          settled: [{ quantity: "1", unitPrice: money(EUR, 90), evidenceRefs: [source("settled")] }],
        },
        selected: { quantity: "3", unitPrice: money(EUR, 110) },
        estimated: { quantity: "3", unitPrice: money(EUR, 120) },
      }],
    });
    expect(result.status).toBe("complete");
    expect(result.lines[0]?.settledCost.minorUnits).toBe(90);
    expect(result.orderedCurrentCost.minorUnits).toBe(390);
    expect(result.selectedForecastCost.minorUnits).toBe(330);
    expect(result.estimatedForecastCost.minorUnits).toBe(360);
    expect(result.projectedCompletionCost.minorUnits).toBe(1080);
  });

  it("reports uncovered quantities instead of silently treating them as zero", () => {
    const result = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "3",
        ordered: { quantity: "1", unitPrice: money(EUR, 100) },
        selected: { quantity: "1", unitPrice: money(EUR, 110) },
      }],
    });
    expect(result.status).toBe("incomplete");
    expect(result.uncoveredQuantity.toString()).toBe("1");
    expect(result.projectedCompletionCost.minorUnits).toBe(210);
  });

  it("applies deposit, credit, and linked refund exactly once", () => {
    const result = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 8500),
      adjustments: [
        { id: "deposit-1", idempotencyKey: "deposit-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 2000) },
        { id: "credit-1", idempotencyKey: "credit-key", orderId: "order-1", kind: "credit", amount: money(EUR, 500) },
        { id: "refund-1", idempotencyKey: "refund-key", orderId: "order-1", kind: "cashRefund", amount: money(EUR, 500), linkedAdjustmentId: "credit-1" },
      ],
    });
    expect(result.obligation.minorUnits).toBe(8000);
    expect(result.appliedPayments.minorUnits).toBe(1500);
    expect(result.outstanding.minorUnits).toBe(6500);
    expect(result.actualAcquisitionCost.minorUnits).toBe(8000);
  });

  it("deduplicates identical adjustments and rejects changed duplicates", () => {
    const duplicate = { id: "deposit-1", idempotencyKey: "same-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 2000) } satisfies FinancialAdjustmentInput;
    const result = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 8500),
      adjustments: [duplicate, { ...duplicate }],
    });
    expect(result.grossPayments.minorUnits).toBe(2000);
    expect(() => calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 8500),
      adjustments: [duplicate, { ...duplicate, amount: money(EUR, 2100) }],
    })).toThrow(AdjustmentIdempotencyConflictError);
  });

  it("rejects overlapping quantities, mismatched currencies, and invalid credits", () => {
    expect(() => calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: { quantity: "1", unitPrice: money(EUR, 100) },
        selected: { quantity: "2", unitPrice: money(EUR, 110) },
      }],
    })).toThrow();
    expect(() => calculateForecast({
      currency: EUR,
      lines: [{ lineId: "equipment", requiredQuantity: "1", selected: { quantity: "1", unitPrice: money("USD", 110) } }],
    })).toThrow();
    expect(() => calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 100),
      adjustments: [{ id: "credit", idempotencyKey: "credit", orderId: "order-1", kind: "credit", amount: money(EUR, 101) }],
    })).toThrow();
  });

  it("keeps non-applicable charges out of known totals with a documented reason", () => {
    const left = quote("left", [line("equipment", 1000)], [
      notApplicableCharge({ chargeId: "installation", label: "Installation", reason: "not required for this variant" }),
    ]);
    const result = compareQuotes(left, left);
    expect(result.status).toBe("complete");
    expect(result.left.total?.minorUnits).toBe(1000);
  });
});
