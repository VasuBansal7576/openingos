// HMAC-signed job requests and replay-protected callback verification.
//
// The signing secret is injected by the caller (a synthetic test secret in
// this proof, never a real credential). Signatures use HMAC-SHA256 over a
// canonical JSON encoding of the validated payload so semantically identical
// payloads always produce identical bytes.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BrowserJobRequest, BrowserObservation, Decision } from "./types.ts";
import { denied } from "./types.ts";
import { parseJobRequest, parseObservation } from "./validation.ts";

export const SIGNATURE_VERSION = "hmac-sha256-1";

function canonicalize(input: unknown, seen: Set<object>): string {
  if (input === null) {
    return "null";
  }
  const kind = typeof input;
  if (kind === "string") {
    return JSON.stringify(input) as string;
  }
  if (kind === "number" || kind === "boolean") {
    if (!Number.isFinite(input)) {
      throw new TypeError("canonical payload must contain only finite numbers");
    }
    return JSON.stringify(input) as string;
  }
  if (Array.isArray(input)) {
    const parts: string[] = [];
    for (const item of input) {
      parts.push(canonicalize(item, seen));
    }
    return `[${parts.join(",")}]`;
  }
  if (kind === "object") {
    const record = input as { readonly [key: string]: unknown };
    if (seen.has(record)) {
      throw new TypeError("canonical payload must not contain cycles");
    }
    seen.add(record);
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
    }
    seen.delete(record);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("canonical payload must contain only JSON values");
}

/** Stable JSON encoding with sorted object keys. Plain JSON data only. */
export function canonicalJson(input: unknown): string {
  return canonicalize(input, new Set());
}

function hmacHex(secret: string, message: string): string {
  if (secret.length === 0) {
    throw new TypeError("signing secret must not be empty");
  }
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function equalHex(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}

export interface SignedJobRequest {
  readonly request: BrowserJobRequest;
  readonly signatureVersion: string;
  readonly signature: string;
}

/** Sign a validated job request. The canonical bytes are fixed at sign time. */
export function signJobRequest(secret: string, request: BrowserJobRequest): SignedJobRequest {
  const canonical = canonicalJson(request);
  const signature = hmacHex(secret, `browser-job-request\u0000${canonical}`);
  return Object.freeze({ request, signatureVersion: SIGNATURE_VERSION, signature });
}

/** Verify a signed request against the current secret. Unknown-shaped input throws. */
export function verifyJobRequest(
  secret: string,
  payload: unknown,
  signature: unknown,
): BrowserJobRequest {
  const request = parseJobRequest(payload);
  const canonical = canonicalJson(request);
  const expected = hmacHex(secret, `browser-job-request\u0000${canonical}`);
  if (!equalHex(expected, signature)) {
    throw new TypeError("job request signature mismatch");
  }
  return request;
}

export interface CallbackEnvelope {
  readonly jobId: string;
  readonly attemptId: string;
  readonly observationVersion: number;
  readonly nonce: string;
  readonly observation: BrowserObservation;
}

/** Bounded store of consumed callback nonces; injected so tests stay deterministic. */
export interface NonceStore {
  has(nonce: string): boolean;
  /** Returns false when the nonce was already consumed (a replay). */
  consume(nonce: string): boolean;
}

const NONCE_STORE_LIMIT = 10_000;

export function createMemoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  return {
    has(nonce: string): boolean {
      return seen.has(nonce);
    },
    consume(nonce: string): boolean {
      if (seen.has(nonce)) {
        return false;
      }
      if (seen.size >= NONCE_STORE_LIMIT) {
        const oldest = seen.keys().next();
        if (!oldest.done) {
          seen.delete(oldest.value);
        }
      }
      seen.set(nonce, Date.now());
      return true;
    },
  };
}

export function signObservation(
  secret: string,
  observation: BrowserObservation,
  nonce: string,
): string {
  if (nonce.trim().length === 0) {
    throw new TypeError("callback nonce must not be empty");
  }
  const canonical = canonicalJson(observation);
  return hmacHex(secret, `browser-observation\u0000${nonce}\u0000${canonical}`);
}

export interface CallbackAccept {
  readonly ok: true;
  readonly envelope: CallbackEnvelope;
}

export type CallbackResult = CallbackAccept | { readonly ok: false; readonly reason: string; readonly detail: string };

/**
 * Verify an executor callback: signature first, then replay protection, then
 * per-attempt version ordering (a stale observation version is rejected even
 * with a valid signature). `expectedVersion` is the next version the job
 * will accept for `attemptId`, tracked by the job module.
 *
 * The envelope carries the observation plus its one-time `callbackNonce`;
 * the nonce is covered by the signature but is not part of the observation.
 */
export function verifyCallback(
  secret: string,
  store: NonceStore,
  envelope: unknown,
  signature: unknown,
  expectedVersion: number,
): CallbackResult {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { ok: false, reason: "invalid-callback", detail: "envelope must be an object" };
  }
  const fields = envelope as { readonly [key: string]: unknown };
  let observation: BrowserObservation;
  try {
    observation = parseObservation(fields.observation);
  } catch (error) {
    return { ok: false, reason: "invalid-callback", detail: error instanceof Error ? error.message : "invalid" };
  }
  const nonce = fields.callbackNonce;
  if (typeof nonce !== "string" || nonce.trim().length === 0) {
    return { ok: false, reason: "invalid-callback", detail: "callbackNonce missing" };
  }
  const canonical = canonicalJson(observation);
  const expected = hmacHex(secret, `browser-observation\u0000${nonce}\u0000${canonical}`);
  if (!equalHex(expected, signature)) {
    const decision: Decision = denied("bad-signature", "callback signature mismatch");
    return { ok: false, reason: decision.reason, detail: decision.detail };
  }
  if (store.has(nonce)) {
    const decision: Decision = denied("replay-detected", `nonce "${nonce}" was already consumed`);
    return { ok: false, reason: decision.reason, detail: decision.detail };
  }
  if (observation.observationVersion !== expectedVersion) {
    const decision: Decision = denied(
      "stale-callback",
      `version ${observation.observationVersion} does not match expected ${expectedVersion}`,
    );
    return { ok: false, reason: decision.reason, detail: decision.detail };
  }
  store.consume(nonce);
  const accepted: CallbackEnvelope = Object.freeze({
    jobId: observation.jobId,
    attemptId: observation.attemptId,
    observationVersion: observation.observationVersion,
    nonce,
    observation,
  });
  return { ok: true, envelope: accepted };
}
