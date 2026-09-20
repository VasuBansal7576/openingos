/**
 * F1 shared deterministic hashing (controlled contract).
 *
 * A pure-TypeScript canonical JSON + FNV-1a 64-bit hash used for approved
 * payload binding and idempotency keys. It runs identically in Convex
 * functions, Bun tests, and the browser, with no Node-only APIs.
 *
 * This is a controlled-test binding helper, not a cryptographic security
 * boundary: equality is decided by exact canonical-string comparison, and
 * the hash is a compact index key for that string.
 */

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const kind = typeof value;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new Error("payload-hash: non-finite number");
    return JSON.stringify(value);
  }
  if (kind === "string" || kind === "boolean") return JSON.stringify(value);
  if (kind === "bigint") return `{"$bigint":"${value.toString()}"}`;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error("payload-hash: unsupported value");
}

/** Canonical JSON string for payload binding and comparison. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit hex digest of the canonical form. */
export function payloadHash(value: unknown): string {
  const text = canonicalize(value);
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Request idempotency key: organization + operation kind + requestId. */
export function requestKey(organizationId: string, operationKind: string, requestId: string): string {
  return `${organizationId}|${operationKind}|${requestId}`;
}

/** Normalize an email mailbox for exact comparison (no dot/plus folding). */
export function normalizeMailbox(mailbox: string): string {
  return mailbox.trim().toLowerCase();
}
