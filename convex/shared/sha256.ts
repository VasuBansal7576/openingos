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

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * Synchronous SHA-256 hex over raw bytes (FIPS 180-4). Exists for the
 * deterministic synchronous controlled backend, which cannot await
 * `crypto.subtle`; byte-identical to it for the same input. Cross-checked
 * against `crypto.subtle` in bindings tests.
 */
export function sha256HexSync(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w: number[] = new Array<number>(64).fill(0);
  const at = (index: number): number => w[index] ?? 0;
  const roundConstant = (index: number): number => SHA256_K[index] ?? 0;
  const rotateRight = (value: number, bits: number): number =>
    ((value >>> bits) | (value << (32 - bits))) | 0;
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotateRight(at(i - 15), 7) ^ rotateRight(at(i - 15), 18) ^ (at(i - 15) >>> 3);
      const s1 =
        rotateRight(at(i - 2), 17) ^ rotateRight(at(i - 2), 19) ^ (at(i - 2) >>> 10);
      w[i] = (at(i - 16) + s0 + at(i - 7) + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + roundConstant(i) + at(i)) | 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0 >>> 0);
  outView.setUint32(4, h1 >>> 0);
  outView.setUint32(8, h2 >>> 0);
  outView.setUint32(12, h3 >>> 0);
  outView.setUint32(16, h4 >>> 0);
  outView.setUint32(20, h5 >>> 0);
  outView.setUint32(24, h6 >>> 0);
  outView.setUint32(28, h7 >>> 0);
  return bytesToHex(out.buffer);
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
