import { isRecord, requiredArray, requiredString } from "./validation";

export interface EvidenceRef {
  readonly sourceId: string;
  readonly version: string;
  readonly locator?: string;
}

export interface EvidenceRefInput {
  readonly sourceId: unknown;
  readonly version: unknown;
  readonly locator?: unknown;
}

export function evidenceRef(input: EvidenceRefInput): EvidenceRef {
  const sourceId = requiredString(input.sourceId, "evidence sourceId");
  const version = requiredString(input.version, "evidence version");
  let locator: string | undefined;
  if (input.locator !== undefined) {
    locator = requiredString(input.locator, "evidence locator");
  }
  return Object.freeze(locator === undefined ? { sourceId, version } : { sourceId, version, locator });
}

export function parseEvidenceRefs(input: unknown, label = "evidenceRefs"): readonly EvidenceRef[] {
  if (input === undefined) {
    return Object.freeze([]);
  }

  const values = requiredArray(input, label);
  return Object.freeze(values.map((value, index) => {
    if (!isRecord(value)) {
      throw new TypeError(`${label}[${index}] must be an object`);
    }
    return evidenceRef({
      sourceId: value.sourceId,
      version: value.version,
      locator: value.locator,
    });
  }));
}

export function evidenceKey(value: EvidenceRef): string {
  return `${value.sourceId}\u0000${value.version}\u0000${value.locator ?? ""}`;
}

export function mergeEvidenceRefs(...groups: readonly (readonly EvidenceRef[])[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  const merged: EvidenceRef[] = [];
  for (const group of groups) {
    for (const value of group) {
      const key = evidenceKey(value);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(value);
      }
    }
  }
  return Object.freeze(merged);
}
