/**
 * F1 collision-resistant payload digest (controlled contract).
 *
 * `payloadHash` (FNV-1a, sync) in `hashing.ts` is an index hint only.
 * The validated boundary records `sha256Hex` of the exact canonical bytes
 * via `crypto.subtle` (available in Convex actions/mutations, Bun, and
 * modern browsers). Backend equality is ALWAYS decided by exact
 * canonical-string comparison (`sameCanonicalPayload`); the SHA-256 digest
 * is a second binding that must also match whenever both sides present it.
 */

import { canonicalJson } from "./hashing.js";

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let index = 0; index < view.length; index += 1) {
    const byte = view[index];
    if (byte === undefined) continue;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** SHA-256 hex of the canonical JSON bytes of `value`. */
export async function sha256Hex(value: unknown): Promise<string> {
  const text = canonicalJson(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(digest);
}

/** SHA-256 hex of an already-canonical string (no re-canonicalization). */
export async function sha256HexOfCanonical(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(digest);
}

/**
 * Exact canonical-payload equality. This is the authoritative comparison
 * for idempotency and claim binding; hashes never override it.
 */
export function sameCanonicalPayload(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  if (left === right) return true;
  let equal = true;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      equal = false;
      break;
    }
  }
  return equal;
}

/**
 * Digest cross-check: passes when either side omits the digest (controlled
 * fixture path) or when both digests match exactly. A present mismatch is
 * a binding failure.
 */
export function sha256BindingOk(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  return left === right;
}
