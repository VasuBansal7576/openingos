import { requiredString } from "./validation";

const MAX_DECIMAL_SCALE = 18;
const MAX_DECIMAL_DIGITS = 36;

export class DecimalValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecimalValidationError";
  }
}

export class Decimal {
  public readonly coefficient: bigint;
  public readonly scale: number;

  private constructor(coefficient: bigint, scale: number) {
    this.coefficient = coefficient;
    this.scale = scale;
  }

  public static fromParts(coefficient: bigint, scale: number): Decimal {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
      throw new DecimalValidationError(`decimal scale must be between 0 and ${MAX_DECIMAL_SCALE}`);
    }

    if (coefficient < 0n) {
      throw new DecimalValidationError("decimal values cannot be negative");
    }

    let normalizedCoefficient = coefficient;
    let normalizedScale = scale;
    while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
      normalizedCoefficient /= 10n;
      normalizedScale -= 1;
    }

    const digits = normalizedCoefficient === 0n
      ? 1
      : normalizedCoefficient.toString().length;
    if (digits > MAX_DECIMAL_DIGITS) {
      throw new DecimalValidationError("decimal value exceeds the supported precision");
    }

    return new Decimal(normalizedCoefficient, normalizedScale);
  }

  public static parse(input: unknown, allowZero = true): Decimal {
    if (input instanceof Decimal) {
      if (!allowZero && input.isZero()) {
        throw new DecimalValidationError("quantity must be greater than zero");
      }
      return input;
    }

    let text: string;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new DecimalValidationError("decimal number must be finite");
      }
      text = input.toString();
    } else if (typeof input === "string") {
      text = input.trim();
    } else {
      throw new DecimalValidationError("decimal value must be a string or number");
    }

    if (text.length === 0 || text.includes("e") || text.includes("E")) {
      throw new DecimalValidationError("decimal value must use ordinary decimal notation");
    }

    const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
    if (match === null) {
      throw new DecimalValidationError("decimal value is invalid");
    }

    const whole = match[1];
    const fraction = match[2] ?? "";
    const digits = whole === "0" ? fraction.replace(/0+$/, "").length : `${whole}${fraction}`.length;
    if (digits > MAX_DECIMAL_DIGITS) {
      throw new DecimalValidationError("decimal value exceeds the supported precision");
    }
    if (fraction.length > MAX_DECIMAL_SCALE) {
      throw new DecimalValidationError(`decimal scale must be at most ${MAX_DECIMAL_SCALE}`);
    }

    const coefficientText = `${whole}${fraction}`;
    const coefficient = BigInt(coefficientText);
    const decimal = Decimal.fromParts(coefficient, fraction.length);
    if (!allowZero && decimal.isZero()) {
      throw new DecimalValidationError("quantity must be greater than zero");
    }

    return decimal;
  }

  public isZero(): boolean {
    return this.coefficient === 0n;
  }

  public toString(): string {
    return decimalToString(this);
  }
}

export type Quantity = Decimal;

export function quantity(input: unknown): Quantity {
  return Decimal.parse(input, false);
}

export function nonNegativeDecimal(input: unknown): Decimal {
  return Decimal.parse(input, true);
}

export function decimalZero(): Decimal {
  return Decimal.fromParts(0n, 0);
}

export function decimalCompare(left: Decimal, right: Decimal): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  if (leftCoefficient < rightCoefficient) {
    return -1;
  }
  if (leftCoefficient > rightCoefficient) {
    return 1;
  }
  return 0;
}

export function decimalAdd(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return Decimal.fromParts(leftCoefficient + rightCoefficient, scale);
}

export function decimalSubtract(left: Decimal, right: Decimal): Decimal {
  if (decimalCompare(left, right) < 0) {
    throw new DecimalValidationError("decimal subtraction would become negative");
  }

  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return Decimal.fromParts(leftCoefficient - rightCoefficient, scale);
}

export function decimalToString(value: Decimal): string {
  if (value.scale === 0) {
    return value.coefficient.toString();
  }

  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  const splitAt = digits.length - value.scale;
  return `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

export function decimalEqual(left: Decimal, right: Decimal): boolean {
  return decimalCompare(left, right) === 0;
}

export function decimalMin(left: Decimal, right: Decimal): Decimal {
  return decimalCompare(left, right) <= 0 ? left : right;
}

export function decimalMax(left: Decimal, right: Decimal): Decimal {
  return decimalCompare(left, right) >= 0 ? left : right;
}

export function parsePositiveQuantity(input: unknown, label = "quantity"): Quantity {
  try {
    return quantity(input);
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw new DecimalValidationError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

export function parseDecimalString(input: unknown, label = "decimal"): Decimal {
  const text = requiredString(input, label);
  try {
    return nonNegativeDecimal(text);
  } catch (error) {
    if (error instanceof DecimalValidationError) {
      throw new DecimalValidationError(`${label}: ${error.message}`);
    }
    throw error;
  }
}
