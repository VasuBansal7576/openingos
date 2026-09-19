import { Quantity } from "./decimal";
import { isRecord } from "./validation";

export const EUR = "EUR";
export const MAX_SAFE_MINOR_UNITS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_MINOR_UNITS_BIGINT = BigInt(MAX_SAFE_MINOR_UNITS);

export class MoneyValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MoneyValidationError";
  }
}

export interface Money {
  readonly currency: string;
  readonly minorUnits: number;
}

export interface MoneyDelta {
  readonly currency: string;
  readonly minorUnits: number;
}

export function currencyCode(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Z]{3}$/.test(input)) {
    throw new MoneyValidationError("currency must be a three-letter uppercase ISO code");
  }
  return input;
}

function parseMinorUnits(input: unknown, allowNegative: boolean): bigint {
  let value: bigint;
  if (typeof input === "bigint") {
    value = input;
  } else if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) {
      throw new MoneyValidationError("minor units must be a safe integer");
    }
    value = BigInt(input);
  } else if (typeof input === "string" && /^-?\d+$/.test(input.trim())) {
    value = BigInt(input.trim());
  } else {
    throw new MoneyValidationError("minor units must be an integer");
  }

  if (!allowNegative && value < 0n) {
    throw new MoneyValidationError("money amounts cannot be negative");
  }
  if (value > MAX_SAFE_MINOR_UNITS_BIGINT || value < -MAX_SAFE_MINOR_UNITS_BIGINT) {
    throw new MoneyValidationError("minor units exceed the safe integer range");
  }
  return value;
}

function moneyFromMinorUnits(currency: string, minorUnits: bigint): Money {
  const safeValue = parseMinorUnits(minorUnits, false);
  return Object.freeze({ currency, minorUnits: Number(safeValue) });
}

function deltaFromMinorUnits(currency: string, minorUnits: bigint): MoneyDelta {
  const safeValue = parseMinorUnits(minorUnits, true);
  return Object.freeze({ currency, minorUnits: Number(safeValue) });
}

export function money(currency: unknown, minorUnits: unknown): Money {
  const code = currencyCode(currency);
  return moneyFromMinorUnits(code, parseMinorUnits(minorUnits, false));
}

export function normalizeMoney(input: unknown, label = "money"): Money {
  if (!isRecord(input)) {
    throw new MoneyValidationError(`${label} must be an object`);
  }

  try {
    return money(input.currency, input.minorUnits);
  } catch (error) {
    if (error instanceof MoneyValidationError) {
      throw new MoneyValidationError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

export function moneyZero(currency: unknown): Money {
  return money(currency, 0);
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new MoneyValidationError(`currency mismatch: ${left.currency} versus ${right.currency}`);
  }
}

export function addMoney(leftInput: Money, rightInput: Money): Money {
  const left = normalizeMoney(leftInput, "left money");
  const right = normalizeMoney(rightInput, "right money");
  assertSameCurrency(left, right);
  return moneyFromMinorUnits(left.currency, BigInt(left.minorUnits) + BigInt(right.minorUnits));
}

export function subtractMoney(leftInput: Money, rightInput: Money): Money {
  const left = normalizeMoney(leftInput, "left money");
  const right = normalizeMoney(rightInput, "right money");
  assertSameCurrency(left, right);
  const difference = BigInt(left.minorUnits) - BigInt(right.minorUnits);
  if (difference < 0n) {
    throw new MoneyValidationError("money subtraction would become negative");
  }
  return moneyFromMinorUnits(left.currency, difference);
}

export function subtractMoneyOrZero(leftInput: Money, rightInput: Money): Money {
  const left = normalizeMoney(leftInput, "left money");
  const right = normalizeMoney(rightInput, "right money");
  assertSameCurrency(left, right);
  const difference = BigInt(left.minorUnits) - BigInt(right.minorUnits);
  return moneyFromMinorUnits(left.currency, difference < 0n ? 0n : difference);
}

export function compareMoney(leftInput: Money, rightInput: Money): -1 | 0 | 1 {
  const left = normalizeMoney(leftInput, "left money");
  const right = normalizeMoney(rightInput, "right money");
  assertSameCurrency(left, right);
  if (left.minorUnits < right.minorUnits) {
    return -1;
  }
  if (left.minorUnits > right.minorUnits) {
    return 1;
  }
  return 0;
}

export function sumMoney(currency: string, values: readonly Money[]): Money {
  let total = moneyZero(currency);
  for (const value of values) {
    total = addMoney(total, value);
  }
  return total;
}

/**
 * All quantity-to-money products use exact integer arithmetic and positive
 * half-up rounding at the minor-unit boundary. No floating-point value is
 * used, and a result outside the safe integer range is rejected.
 */
export function multiplyMoneyByQuantity(moneyInput: Money, quantity: Quantity): Money {
  const value = normalizeMoney(moneyInput);
  const numerator = BigInt(value.minorUnits) * quantity.coefficient;
  const denominator = 10n ** BigInt(quantity.scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return moneyFromMinorUnits(value.currency, rounded);
}

export function moneyDifference(leftInput: Money, rightInput: Money): MoneyDelta {
  const left = normalizeMoney(leftInput, "left money");
  const right = normalizeMoney(rightInput, "right money");
  assertSameCurrency(left, right);
  return deltaFromMinorUnits(left.currency, BigInt(left.minorUnits) - BigInt(right.minorUnits));
}

export function absoluteMoneyDelta(delta: MoneyDelta): Money {
  return money(delta.currency, Math.abs(delta.minorUnits));
}

export function moneyToString(valueInput: Money): string {
  const value = normalizeMoney(valueInput);
  const whole = Math.floor(value.minorUnits / 100);
  const fraction = String(value.minorUnits % 100).padStart(2, "0");
  return `${value.currency} ${whole}.${fraction}`;
}
