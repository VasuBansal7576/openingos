import { describe, expect, it } from "bun:test";
import {
  AdjustmentIdempotencyConflictError,
  AdjustmentIdentityConflictError,
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
import type { ChargeInput, ComparisonScopeInput, FinancialAdjustmentInput } from "./index";

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
  scope?: ComparisonScopeInput,
) {
  return createQuote({
    quoteId,
    version: "v1",
    currency: EUR,
    lines,
    charges,
    taxBasis: tax,
    comparisonScope: scope ?? {
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
    expect(multiplyMoneyByQuantity(money(EUR, 795000), quantity("1.25")).minorUnits).toBe(993750);
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
    const left = quote("left", [line("equipment", 795000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment", evidenceRefs: [source("freight")] }),
      unknownCharge({ chargeId: "installation", label: "Installation", reason: "supplier did not state it", evidenceRefs: [source("installation")] }),
    ]);
    const right = quote("right", [line("equipment", 850000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);

    const result = compareQuotes(left, right);
    expect(result.status).toBe("incomplete");
    expect(result.left.knownTotal.minorUnits).toBe(795000);
    expect(result.equivalent).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("Installation");
  });

  it("calculates a deterministic delta only for equivalent complete offers", () => {
    const left = quote("left", [line("equipment", 795000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "equipment" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "equipment" }),
    ]);
    const right = quote("right", [line("equipment", 750000)], [
      knownChargeForTest({ chargeId: "freight", label: "Freight", amount: 60000 }),
      knownChargeForTest({ chargeId: "installation", label: "Installation", amount: 40000 }),
    ]);

    const result = compareQuotes(left, right);
    expect(result.status).toBe("complete");
    expect(result.left.total?.minorUnits).toBe(795000);
    expect(result.right.total?.minorUnits).toBe(850000);
    expect(result.equivalent?.delta.minorUnits).toBe(-55000);
    expect(result.equivalent?.savings.minorUnits).toBe(55000);
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

  it("requires an explicit stable scope before calling different quantities equivalent", () => {
    const one = quote("one", [line("machine", 10000)], [], undefined, {
      requirementId: "req-machine",
      scopeId: "scope-machine",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    });
    const two = quote("two", [line("machine-a", 9000), line("machine-b", 9000)], [], undefined, {
      requirementId: "req-machine",
      scopeId: "scope-machine",
      items: [
        { itemId: "machine-a", lineId: "machine-a", unit: "piece", requiredQuantity: "1" },
        { itemId: "machine-b", lineId: "machine-b", unit: "piece", requiredQuantity: "1" },
      ],
    });
    const result = compareQuotes(one, two);
    expect(result.status).toBe("incompatible");
    expect(result.equivalent).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("comparison scopes are not compatible");

    const mixed = quote("mixed", [line("machine", 9000), line("grinder", 9000)], [], undefined, {
      requirementId: "req-purchase",
      scopeId: "scope-purchase",
      items: [
        { itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" },
        { itemId: "grinder", lineId: "grinder", unit: "piece", requiredQuantity: "1" },
      ],
    });
    const twoMachines = quote("two-machines", [line("machine-a", 9000), line("machine-b", 9000)], [], undefined, {
      requirementId: "req-purchase",
      scopeId: "scope-purchase",
      items: [
        { itemId: "machine-a", lineId: "machine-a", unit: "piece", requiredQuantity: "1" },
        { itemId: "machine-b", lineId: "machine-b", unit: "piece", requiredQuantity: "1" },
      ],
    });
    expect(compareQuotes(mixed, twoMachines).equivalent).toBeUndefined();

    const localLeft = quote("local-left", [line("left-machine", 10000)], [], undefined, {
      requirementId: "req-local",
      scopeId: "scope-local",
      items: [{ itemId: "machine", lineId: "left-machine", unit: "piece", requiredQuantity: "1" }],
    });
    const localRight = quote("local-right", [line("right-equipment", 10000)], [], undefined, {
      requirementId: "req-local",
      scopeId: "scope-local",
      items: [{ itemId: "machine", lineId: "right-equipment", unit: "piece", requiredQuantity: "1" }],
    });
    expect(compareQuotes(localLeft, localRight).status).toBe("complete");

    const unitMismatch = quote("unit-mismatch", [line("right-equipment", 10000)], [], undefined, {
      requirementId: "req-local",
      scopeId: "scope-local",
      items: [{ itemId: "machine", lineId: "right-equipment", unit: "set", requiredQuantity: "1" }],
    });
    expect(compareQuotes(localLeft, unitMismatch).equivalent).toBeUndefined();
  });

  it("compares equivalent selected quantities despite differing offered quantities", () => {
    const left = quote("offered-two", [line("a-machine", 10000, "2")], [
      knownChargeForTest({
        chargeId: "delivery-a",
        label: "Delivery",
        amount: 500,
        scope: { kind: "allocated", lineId: "a-machine", method: "fixed" },
      }),
    ], undefined, {
      requirementId: "req-selected",
      scopeId: "scope-selected",
      items: [{ itemId: "machine", lineId: "a-machine", unit: "piece", requiredQuantity: "2" }],
    });
    const right = quote("offered-three", [line("b-machine", 9000, "3")], [
      knownChargeForTest({
        chargeId: "delivery-b",
        label: "Delivery",
        amount: 500,
        scope: { kind: "allocated", lineId: "b-machine", method: "fixed" },
      }),
    ], undefined, {
      requirementId: "req-selected",
      scopeId: "scope-selected",
      items: [{ itemId: "machine", lineId: "b-machine", unit: "piece", requiredQuantity: "3" }],
    });
    const selected = compareQuotes(left, right, {
      leftSelection: [{ lineId: "a-machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "b-machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(selected.status).toBe("complete");
    expect(selected.left.total?.minorUnits).toBe(10500);
    expect(selected.right.total?.minorUnits).toBe(9500);
    expect(selected.equivalent?.savings.minorUnits).toBe(1000);

    const mismatchedFullVersusPartial = compareQuotes(left, right, {
      rightSelection: [{ lineId: "b-machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(mismatchedFullVersusPartial.status).toBe("incompatible");
    expect(mismatchedFullVersusPartial.equivalent).toBeUndefined();

    const fullOne = quote("full-one", [line("full-machine", 10000)], [
      knownChargeForTest({
        chargeId: "delivery-full",
        label: "Delivery",
        amount: 500,
        scope: { kind: "allocated", lineId: "full-machine", method: "fixed" },
      }),
    ], undefined, {
      requirementId: "req-selected",
      scopeId: "scope-selected",
      items: [{ itemId: "machine", lineId: "full-machine", unit: "piece", requiredQuantity: "1" }],
    });
    const fullVersusPartial = compareQuotes(fullOne, right, {
      rightSelection: [{ lineId: "b-machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(fullVersusPartial.status).toBe("complete");
    expect(fullVersusPartial.left.total?.minorUnits).toBe(10500);
    expect(fullVersusPartial.right.total?.minorUnits).toBe(9500);
    expect(fullVersusPartial.equivalent?.savings.minorUnits).toBe(1000);
  });

  it("keeps unresolved and unselected included coverage incomplete", () => {
    const unresolved = quote("unresolved", [line("machine", 1000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "missing" }),
    ]);
    const unresolvedResult = compareQuotes(unresolved, unresolved);
    expect(unresolvedResult.status).toBe("incomplete");
    expect(unresolvedResult.reasons.join(" ")).toContain("coverage is unresolved");

    const selectedOnly = quote("selected-only", [line("machine", 1000), line("grinder", 1000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "grinder" }),
    ]);
    const partial = compareQuotes(selectedOnly, selectedOnly, {
      leftSelection: [{ lineId: "machine", quantity: "1" }],
      rightSelection: [{ lineId: "machine", quantity: "1" }],
    });
    expect(partial.status).toBe("incomplete");
    expect(partial.reasons.join(" ")).toContain("unselected scope");

    const excludedLineCharge = quote("excluded-charge", [line("machine", 1000), line("grinder", 1000)], [
      includedCharge({
        chargeId: "grinder-warranty",
        label: "Grinder warranty",
        coveringId: "grinder",
        scope: { kind: "line", lineId: "grinder" },
      }),
    ]);
    const excludedResult = compareQuotes(excludedLineCharge, excludedLineCharge, {
      leftSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(excludedResult.status).toBe("complete");
    expect(excludedResult.left.total?.minorUnits).toBe(1000);

    const applicableUnresolved = quote("applicable-unresolved", [line("machine", 1000), line("grinder", 1000)], [
      includedCharge({
        chargeId: "shared-warranty",
        label: "Shared warranty",
        coveringId: "grinder",
        scope: { kind: "quote" },
      }),
    ]);
    const unresolvedPartial = compareQuotes(applicableUnresolved, applicableUnresolved, {
      leftSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(unresolvedPartial.status).toBe("incomplete");

    const excludedIntermediate = quote("excluded-intermediate", [line("machine", 1000), line("grinder", 1000)], [
      includedCharge({
        chargeId: "installation",
        label: "Installation",
        coveringId: "service",
        scope: { kind: "line", lineId: "machine" },
      }),
      includedCharge({
        chargeId: "service",
        label: "Service",
        coveringId: "machine",
        scope: { kind: "line", lineId: "grinder" },
      }),
    ]);
    const excludedIntermediateResult = compareQuotes(excludedIntermediate, excludedIntermediate, {
      leftSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "machine", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(excludedIntermediateResult.status).toBe("incomplete");
    expect(excludedIntermediateResult.reasons.join(" ")).toContain("Installation");
  });

  it("rejects included coverage cycles", () => {
    expect(() => quote("cycle", [line("machine", 1000)], [
      includedCharge({ chargeId: "freight", label: "Freight", coveringId: "installation" }),
      includedCharge({ chargeId: "installation", label: "Installation", coveringId: "freight" }),
    ])).toThrow("coverage cycle");
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
    expect(partial.left.status).toBe("complete");
    expect(partial.left.knownTotal.minorUnits).toBe(1050);
    expect(partial.right.knownTotal.minorUnits).toBe(1000);
    expect(partial.right.estimatedRange?.minimum.minorUnits).toBe(50);
  });

  it("compares explicitly mapped partial scopes with proportional and fixed allocations", () => {
    const left = quote("partial-left", [line("supplier-a-machine", 500, "2")], [
      knownChargeForTest({
        chargeId: "freight",
        label: "Allocated freight",
        amount: 200,
        scope: { kind: "allocated", lineId: "supplier-a-machine", method: "proportional" },
      }),
    ], undefined, {
      requirementId: "req-partial",
      scopeId: "scope-partial",
      items: [{ itemId: "machine", lineId: "supplier-a-machine", unit: "piece", requiredQuantity: "2" }],
    });
    const right = quote("partial-right", [line("supplier-b-equipment", 550, "2")], [
      knownChargeForTest({
        chargeId: "installation",
        label: "Fixed installation",
        amount: 100,
        scope: { kind: "allocated", lineId: "supplier-b-equipment", method: "fixed" },
      }),
    ], undefined, {
      requirementId: "req-partial",
      scopeId: "scope-partial",
      items: [{ itemId: "machine", lineId: "supplier-b-equipment", unit: "piece", requiredQuantity: "2" }],
    });
    const result = compareQuotes(left, right, {
      leftSelection: [{ lineId: "supplier-a-machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "supplier-b-equipment", itemId: "machine", unit: "piece", quantity: "1" }],
    });
    expect(result.status).toBe("complete");
    expect(result.left.total?.minorUnits).toBe(600);
    expect(result.right.total?.minorUnits).toBe(650);
    expect(result.equivalent?.delta.minorUnits).toBe(-50);
    expect(result.equivalent?.savings.minorUnits).toBe(50);

    const inferred = compareQuotes(left, right, {
      leftSelection: [{ lineId: "supplier-a-machine", quantity: "1" }],
      rightSelection: [{ lineId: "supplier-b-equipment", quantity: "1" }],
    });
    expect(inferred.status).toBe("incompatible");
    expect(inferred.equivalent).toBeUndefined();
  });

  it("rejects partial scope quantity and item composition mismatches", () => {
    const left = quote("partial-left", [line("a-machine", 1000, "2"), line("a-grinder", 400, "1")], [], undefined, {
      requirementId: "req-partial",
      scopeId: "scope-partial",
      items: [
        { itemId: "machine", lineId: "a-machine", unit: "piece", requiredQuantity: "2" },
        { itemId: "grinder", lineId: "a-grinder", unit: "piece", requiredQuantity: "1" },
      ],
    });
    const right = quote("partial-right", [line("b-machine", 1100, "2"), line("b-grinder", 400, "1")], [], undefined, {
      requirementId: "req-partial",
      scopeId: "scope-partial",
      items: [
        { itemId: "machine", lineId: "b-machine", unit: "piece", requiredQuantity: "2" },
        { itemId: "grinder", lineId: "b-grinder", unit: "piece", requiredQuantity: "1" },
      ],
    });
    const differingQuantity = compareQuotes(left, right, {
      leftSelection: [{ lineId: "a-machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "b-machine", itemId: "machine", unit: "piece", quantity: "1.5" }],
    });
    expect(differingQuantity.status).toBe("incompatible");
    expect(differingQuantity.equivalent).toBeUndefined();

    const mixedItems = compareQuotes(left, right, {
      leftSelection: [{ lineId: "a-machine", itemId: "machine", unit: "piece", quantity: "1" }],
      rightSelection: [{ lineId: "b-grinder", itemId: "grinder", unit: "piece", quantity: "1" }],
    });
    expect(mixedItems.status).toBe("incompatible");
    expect(mixedItems.equivalent).toBeUndefined();
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

  it("conserves line rounding across fractional forecast state partitions", () => {
    const selectedBefore = calculateForecast({
      currency: EUR,
      lines: [{ lineId: "equipment", requiredQuantity: "1", selected: { quantity: "1", unitPrice: money(EUR, 1) } }],
    });
    const orderedAndSelected = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "1",
        ordered: { quantity: "0.5", unitPrice: money(EUR, 1) },
        selected: { quantity: "0.5", unitPrice: money(EUR, 1) },
      }],
    });
    const before = calculateForecast({
      currency: EUR,
      lines: [{ lineId: "equipment", requiredQuantity: "1", ordered: { quantity: "1", unitPrice: money(EUR, 1) } }],
    });
    const after = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "1",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [{ quantity: "0.5", unitPrice: money(EUR, 1) }],
        },
      }],
    });
    const changedPrice = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "1",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 100),
          settled: [{ quantity: "0.5", unitPrice: money(EUR, 90) }],
        },
      }],
    });
    const changedSelectedPrice = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "1",
        ordered: { quantity: "0.5", unitPrice: money(EUR, 1) },
        selected: { quantity: "0.5", unitPrice: money(EUR, 3) },
      }],
    });
    const allPartitions = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "1",
        ordered: {
          quantity: "0.5",
          unitPrice: money(EUR, 1),
          settled: [{ quantity: "0.25", unitPrice: money(EUR, 3) }],
        },
        selected: { quantity: "0.25", unitPrice: money(EUR, 5) },
        estimated: { quantity: "0.25", unitPrice: money(EUR, 7) },
      }],
    });
    const oneSettledRecord = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [{ quantity: "1", unitPrice: money(EUR, 1) }],
        },
        selected: { quantity: "1", unitPrice: money(EUR, 0) },
      }],
    });
    const splitSettledRecords = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [
            { quantity: "0.5", unitPrice: money(EUR, 1) },
            { quantity: "0.5", unitPrice: money(EUR, 1) },
          ],
        },
        selected: { quantity: "1", unitPrice: money(EUR, 0) },
      }],
    });
    const unequalSettledRecords = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [
            { quantity: "0.75", unitPrice: money(EUR, 1) },
            { quantity: "0.25", unitPrice: money(EUR, 1) },
          ],
        },
        selected: { quantity: "1", unitPrice: money(EUR, 0) },
      }],
    });
    const reorderedSettledRecords = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [
            { quantity: "0.25", unitPrice: money(EUR, 1) },
            { quantity: "0.75", unitPrice: money(EUR, 1) },
          ],
        },
        selected: { quantity: "1", unitPrice: money(EUR, 0) },
      }],
    });
    const changedSettledPrices = calculateForecast({
      currency: EUR,
      lines: [{
        lineId: "equipment",
        requiredQuantity: "2",
        ordered: {
          quantity: "1",
          unitPrice: money(EUR, 1),
          settled: [
            { quantity: "0.5", unitPrice: money(EUR, 1) },
            { quantity: "0.5", unitPrice: money(EUR, 3) },
          ],
        },
        selected: { quantity: "1", unitPrice: money(EUR, 0) },
      }],
    });
    const orderedAndSelectedLine = orderedAndSelected.lines[0];
    const allPartitionsLine = allPartitions.lines[0];
    const splitSettledLine = splitSettledRecords.lines[0];
    const changedSettledPricesLine = changedSettledPrices.lines[0];
    expect(before.projectedCompletionCost.minorUnits).toBe(1);
    expect(selectedBefore.projectedCompletionCost.minorUnits).toBe(1);
    expect(orderedAndSelected.projectedCompletionCost.minorUnits).toBe(1);
    expect(orderedAndSelectedLine === undefined
      ? undefined
      : orderedAndSelectedLine.orderedCurrentCost.minorUnits
        + orderedAndSelectedLine.selectedForecastCost.minorUnits
        + orderedAndSelectedLine.estimatedForecastCost.minorUnits).toBe(1);
    expect(after.projectedCompletionCost.minorUnits).toBe(1);
    expect(after.lines[0]?.settledCost.minorUnits).toBe(1);
    expect(changedPrice.projectedCompletionCost.minorUnits).toBe(95);
    expect(changedSelectedPrice.projectedCompletionCost.minorUnits).toBe(2);
    expect(allPartitions.projectedCompletionCost.minorUnits).toBe(4);
    expect(allPartitionsLine === undefined
      ? undefined
      : allPartitionsLine.projectedCost.minorUnits).toBe(4);
    expect(allPartitionsLine === undefined
      ? undefined
      : allPartitionsLine.orderedCurrentCost.minorUnits
        + allPartitionsLine.selectedForecastCost.minorUnits
        + allPartitionsLine.estimatedForecastCost.minorUnits).toBe(4);
    expect(oneSettledRecord.projectedCompletionCost.minorUnits).toBe(1);
    expect(oneSettledRecord.orderedCurrentCost.minorUnits).toBe(1);
    expect(oneSettledRecord.settledCost.minorUnits).toBe(1);
    expect(oneSettledRecord.selectedForecastCost.minorUnits).toBe(0);
    expect(splitSettledRecords.projectedCompletionCost.minorUnits).toBe(1);
    expect(splitSettledRecords.orderedCurrentCost.minorUnits).toBe(1);
    expect(splitSettledRecords.settledCost.minorUnits).toBe(1);
    expect(splitSettledRecords.selectedForecastCost.minorUnits).toBe(0);
    expect(unequalSettledRecords.projectedCompletionCost.minorUnits).toBe(1);
    expect(unequalSettledRecords.orderedCurrentCost.minorUnits).toBe(1);
    expect(unequalSettledRecords.settledCost.minorUnits).toBe(1);
    expect(unequalSettledRecords.selectedForecastCost.minorUnits).toBe(0);
    expect(reorderedSettledRecords.projectedCompletionCost.minorUnits).toBe(1);
    expect(reorderedSettledRecords.orderedCurrentCost.minorUnits).toBe(1);
    expect(reorderedSettledRecords.settledCost.minorUnits).toBe(1);
    expect(reorderedSettledRecords.selectedForecastCost.minorUnits).toBe(0);
    expect(changedSettledPrices.projectedCompletionCost.minorUnits).toBe(2);
    expect(changedSettledPrices.settledCost.minorUnits).toBe(2);
    expect(changedSettledPrices.selectedForecastCost.minorUnits).toBe(0);
    expect(splitSettledLine === undefined
      ? undefined
      : splitSettledLine.orderedCurrentCost.minorUnits
        + splitSettledLine.selectedForecastCost.minorUnits
        + splitSettledLine.estimatedForecastCost.minorUnits).toBe(1);
    expect(changedSettledPricesLine === undefined
      ? undefined
      : changedSettledPricesLine.orderedCurrentCost.minorUnits
        + changedSettledPricesLine.selectedForecastCost.minorUnits
        + changedSettledPricesLine.estimatedForecastCost.minorUnits).toBe(2);
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
    const depositOnly = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [
        { id: "deposit-1", idempotencyKey: "deposit-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 200000) },
      ],
    });
    expect(depositOnly.outstanding.minorUnits).toBe(650000);

    const withCredit = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [
        { id: "deposit-1", idempotencyKey: "deposit-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 200000) },
        { id: "credit-1", idempotencyKey: "credit-key", orderId: "order-1", kind: "credit", amount: money(EUR, 50000) },
      ],
    });
    expect(withCredit.obligation.minorUnits).toBe(800000);
    expect(withCredit.outstanding.minorUnits).toBe(600000);

    const result = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [
        { id: "deposit-1", idempotencyKey: "deposit-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 200000) },
        { id: "credit-1", idempotencyKey: "credit-key", orderId: "order-1", kind: "credit", amount: money(EUR, 50000) },
        { id: "refund-1", idempotencyKey: "refund-key", orderId: "order-1", kind: "cashRefund", amount: money(EUR, 50000), linkedAdjustmentId: "credit-1" },
      ],
    });
    expect(result.obligation.minorUnits).toBe(800000);
    expect(result.appliedPayments.minorUnits).toBe(150000);
    expect(result.outstanding.minorUnits).toBe(650000);
    expect(result.actualAcquisitionCost).toBeUndefined();

    const settled = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      settlement: { amount: money(EUR, 800000), evidenceRefs: [source("settlement")] },
    });
    expect(settled.actualAcquisitionCost?.minorUnits).toBe(800000);
    expect(settled.settlementEvidence).toHaveLength(1);
  });

  it("deduplicates identical adjustments and rejects changed duplicates", () => {
    const duplicate = { id: "deposit-1", idempotencyKey: "same-key", orderId: "order-1", kind: "deposit", amount: money(EUR, 200000) } satisfies FinancialAdjustmentInput;
    const result = calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [duplicate, { ...duplicate }],
    });
    expect(result.grossPayments.minorUnits).toBe(200000);
    expect(() => calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [duplicate, { ...duplicate, amount: money(EUR, 2100) }],
    })).toThrow(AdjustmentIdempotencyConflictError);

    expect(() => calculateCommitmentFinancials({
      currency: EUR,
      orderId: "order-1",
      amount: money(EUR, 850000),
      adjustments: [
        { ...duplicate, idempotencyKey: "key-1", amount: money(EUR, 50000), kind: "credit" },
        { ...duplicate, idempotencyKey: "key-2", amount: money(EUR, 50000), kind: "credit" },
      ],
    })).toThrow(AdjustmentIdentityConflictError);
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

  it("freezes decimal and quote snapshot state", () => {
    const callerQuantity = quantity("1");
    const callerLines = [quoteLine({ lineId: "equipment", description: "equipment", quantity: callerQuantity, unitPrice: money(EUR, 1000) })];
    const snapshot = createQuote({
      quoteId: "snapshot",
      version: "v1",
      currency: EUR,
      lines: callerLines,
      charges: [],
      taxBasis: inclusiveTaxBasis("NL-EUR-INCLUSIVE"),
      comparisonScope: {
        requirementId: "req-purchase",
        scopeId: "scope-purchase",
        items: [{ itemId: "equipment", lineId: "equipment", unit: "piece", requiredQuantity: "1" }],
      },
      evidenceRefs: [],
    });
    expect(Object.isFrozen(callerQuantity)).toBe(true);
    expect(() => Object.assign(callerQuantity, { coefficient: 2n })).toThrow();
    callerLines[0] = line("equipment", 2000);
    expect(snapshot.lines[0]?.unitPrice.minorUnits).toBe(1000);
    expect(Object.isFrozen(snapshot.lines)).toBe(true);
    expect(Object.isFrozen(snapshot.charges)).toBe(true);
    expect(snapshot.lines[0]?.quantity.toString()).toBe("1");
  });
});
