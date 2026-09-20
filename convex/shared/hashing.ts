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

/** Maximum accepted payload JSON size at any public boundary. */
export const MAX_PAYLOAD_JSON_BYTES = 65_536;

/** Maximum accepted nesting depth for payload JSON values. */
export const MAX_PAYLOAD_JSON_DEPTH = 64;

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

/**
 * Mailbox helpers live in `./mailbox.js` on the maintained validator
 * library path. These re-exports preserve the historical import site for
 * existing callers; new code imports from `./mailbox.js` directly.
 */
export { isValidSingleMailbox, normalizeMailbox } from "./mailbox.js";

export interface BoundedPayload {
  readonly canonical: string;
  readonly hash: string;
  readonly value: unknown;
}

function jsonDepth(value: unknown): number {
  let deepest = 0;
  const stack: { entry: unknown; depth: number }[] = [{ entry: value, depth: 1 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.depth > deepest) deepest = frame.depth;
    if (frame.depth > MAX_PAYLOAD_JSON_DEPTH) return frame.depth;
    const entry = frame.entry;
    if (typeof entry !== "object" || entry === null) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) stack.push({ entry: child, depth: frame.depth + 1 });
    } else {
      for (const key of Object.keys(entry)) {
        stack.push({ entry: (entry as Record<string, unknown>)[key], depth: frame.depth + 1 });
      }
    }
  }
  return deepest;
}

/**
 * Validate a public `payloadJson` boundary value: string input, byte-size
 * bound, well-formed JSON, supported depth, canonical form. Returns the
 * canonical string plus its index hash; callers compute the SHA-256 digest
 * on the server and never trust client digests.
 */
export function parseBoundedPayloadJson(raw: unknown):
  | { readonly ok: true; readonly payload: BoundedPayload }
  | { readonly ok: false; readonly code: "invalid-payload"; readonly message: string } {
  if (typeof raw !== "string") {
    return { ok: false, code: "invalid-payload", message: "payload must be a JSON string" };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_PAYLOAD_JSON_BYTES) {
    return { ok: false, code: "invalid-payload", message: "payload exceeds the size bound" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid-payload", message: "payload is not valid JSON" };
  }
  if (jsonDepth(value) > MAX_PAYLOAD_JSON_DEPTH) {
    return { ok: false, code: "invalid-payload", message: "payload nesting exceeds the depth bound" };
  }
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return { ok: false, code: "invalid-payload", message: "payload shape is not supported" };
  }
  return { ok: true, payload: { canonical, hash: payloadHash(value), value } };
}
