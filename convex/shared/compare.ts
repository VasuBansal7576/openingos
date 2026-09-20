/**
 * F1 exact equivalent-scope comparison (controlled contract, ADR-0003).
 *
 * The accepted money contract: integer minor units, quantities scale
 * totals exactly, unknown charges never become zero, and equivalent scope
 * is never claimed from currency/tax equality alone. All arithmetic is
 * exact BigInt rational math over bounded decimal quantities; anything
 * unparseable, unequal, or incomplete refuses a complete verdict.
 */

export interface ComparableLine {
  readonly quantity: string;
  readonly unitPriceMinorUnits: number;
}

export interface ComparableCharge {
  readonly state: string;
  readonly amountMinorUnits?: number;
}

export interface ComparableQuote {
  readonly currency: string;
  readonly taxBasis: string;
  readonly lines: readonly ComparableLine[];
  readonly charges: readonly ComparableCharge[];
}

export interface ComparisonVerdict {
  readonly verdict: "complete" | "incomplete";
  readonly differenceMinorUnits: number | null;
  readonly cheaper: "left" | "right" | "equal" | null;
  readonly reason: string;
}

const QUANTITY_PATTERN = /^(\d+)(?:\.(\d{1,6}))?$/;

function parseQuantity(raw: string): { num: bigint; den: bigint } | null {
  const match = QUANTITY_PATTERN.exec(raw.trim());
  if (!match) return null;
  const intPart = match[1] ?? "0";
  const fracPart = match[2] ?? "";
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart) * den + (fracPart === "" ? 0n : BigInt(fracPart));
  return { num, den };
}

function scalePower(values: { den: bigint }[]): bigint {
  let max = 0n;
  for (const value of values) {
    let den = value.den;
    let power = 0n;
    while (den > 1n) {
      den /= 10n;
      power += 1n;
    }
    if (power > max) max = power;
  }
  return 10n ** max;
}

export function compareEquivalentScope(
  left: ComparableQuote,
  right: ComparableQuote,
): ComparisonVerdict {
  const incomplete = (reason: string): ComparisonVerdict => ({
    verdict: "incomplete",
    differenceMinorUnits: null,
    cheaper: null,
    reason,
  });
  if (left.currency !== right.currency) {
    return incomplete("mixed-currency-requires-accepted-conversion-basis");
  }
  if (left.taxBasis !== right.taxBasis) {
    return incomplete("mixed-tax-basis");
  }

  const scaleDens = [
    ...left.lines.map((line) => {
      const parsed = parseQuantity(line.quantity);
      return { den: parsed?.den ?? 10n };
    }),
    ...right.lines.map((line) => {
      const parsed = parseQuantity(line.quantity);
      return { den: parsed?.den ?? 10n };
    }),
  ];
  const scale = scalePower(scaleDens);

  const sideTotal = (
    quote: ComparableQuote,
  ): { ok: true; total: bigint; quantity: bigint; estimated: boolean } | { ok: false; reason: string } => {
    let total = 0n;
    let quantity = 0n;
    let estimated = false;
    for (const line of quote.lines) {
      const parsed = parseQuantity(line.quantity);
      if (parsed === null) return { ok: false, reason: "invalid-quantity" };
      if (!Number.isSafeInteger(line.unitPriceMinorUnits)) {
        return { ok: false, reason: "invalid-amount" };
      }
      const factor = scale / parsed.den;
      total += BigInt(line.unitPriceMinorUnits) * parsed.num * factor;
      quantity += parsed.num * factor;
    }
    for (const charge of quote.charges) {
      if (charge.state === "unknown") return { ok: false, reason: "unknown-charge-prevents-complete-claim" };
      if (charge.state === "known" || charge.state === "estimated") {
        if (charge.amountMinorUnits === undefined || !Number.isSafeInteger(charge.amountMinorUnits)) {
          return { ok: false, reason: "invalid-charge-amount" };
        }
        total += BigInt(charge.amountMinorUnits) * scale;
        if (charge.state === "estimated") estimated = true;
        continue;
      }
      if (charge.state === "included" || charge.state === "notApplicable") continue;
      return { ok: false, reason: "invalid-charge-state" };
    }
    return { ok: true, total, quantity, estimated };
  };

  const leftTotal = sideTotal(left);
  if (!leftTotal.ok) return incomplete(leftTotal.reason);
  const rightTotal = sideTotal(right);
  if (!rightTotal.ok) return incomplete(rightTotal.reason);
  if (leftTotal.quantity !== rightTotal.quantity) {
    return incomplete("unequal-quantity-scope");
  }
  const difference = leftTotal.total >= rightTotal.total
    ? leftTotal.total - rightTotal.total
    : rightTotal.total - leftTotal.total;
  const scaledDiff = difference / scale;
  const remainder = difference % scale;
  if (remainder !== 0n) {
    return {
      verdict: "complete",
      differenceMinorUnits: null,
      cheaper: leftTotal.total === rightTotal.total ? "equal" : leftTotal.total < rightTotal.total ? "left" : "right",
      reason: "equivalent-scope-fractional-difference",
    };
  }
  if (scaledDiff > BigInt(Number.MAX_SAFE_INTEGER)) {
    return incomplete("amount-overflow");
  }
  const differenceMinorUnits = Number(scaledDiff);
  const cheaper = leftTotal.total === rightTotal.total
    ? "equal"
    : leftTotal.total < rightTotal.total
      ? "left"
      : "right";
  return {
    verdict: "complete",
    differenceMinorUnits,
    cheaper,
    reason: leftTotal.estimated || rightTotal.estimated ? "equivalent-scope-with-estimates" : "equivalent-scope",
  };
}
