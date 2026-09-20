export type UnknownRecord = { readonly [key: string]: unknown };

export function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  const value = input.trim();
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }

  return value;
}

export function optionalString(input: unknown, label: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return requiredString(input, label);
}

export function requiredArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${label} must be an array`);
  }

  return input;
}
