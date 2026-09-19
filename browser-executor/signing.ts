// HMAC-signed job requests and replay-protected callback verification.
//
// The signing secret is injected by the caller (a synthetic test secret in
// this proof, never a real credential). Signatures use HMAC-SHA256 over a
// canonical JSON encoding of the validated payload so semantically identical
// payloads always produce identical bytes.
//
// Callback verification validates the expected issued nonce and the full
// request/attempt context BEFORE consuming replay state, and consumption is
// committed atomically with acceptance: a callback routed to the wrong job,
// another tenant, or an old grant/lease is rejected without burning the
// rightful result's nonce. A refused atomic consume (already consumed or
// store at capacity) fails closed.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BrowserJobRequest, BrowserObservation } from "./types.ts";
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
  if (kind === "boolean") {
    return input ? "true" : "false";
  }
  if (kind === "number") {
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

/**
 * Immutable digest of the authorized request's authority and versions
 * (organization, project, grant, input, lease, catalog, origins, expiry).
 * Observations echo it so a callback is bound to exactly one issued request.
 */
export function computeRequestDigest(secret: string, request: BrowserJobRequest): string {
  return hmacHex(secret, `browser-request-digest\u0000${canonicalJson(request)}`);
}

export interface CallbackEnvelope {
  readonly jobId: string;
  readonly attemptId: string;
  readonly observationVersion: number;
  readonly nonce: string;
  readonly observation: BrowserObservation;
}

/**
 * Bounded store of consumed callback nonces. Consumption is atomic:
 * tryConsume returns false when the nonce was already consumed or when no
 * capacity remains, and verification must treat false as a denial.
 * Markers are retained through their validity horizon; only expired markers
 * are purged, and purging never admits a still-valid replay because the
 * per-attempt version check independently rejects reused versions.
 */
export interface NonceStore {
  isConsumed(nonce: string, nowMs: number): boolean;
  tryConsume(nonce: string, validUntilMs: number, nowMs: number): boolean;
}

const NONCE_STORE_LIMIT = 10_000;

export function createMemoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  function purge(nowMs: number): void {
    for (const [nonce, validUntilMs] of seen) {
      if (validUntilMs <= nowMs) {
        seen.delete(nonce);
      }
    }
  }
  return {
    isConsumed(nonce: string, nowMs: number): boolean {
      const validUntilMs = seen.get(nonce);
      if (validUntilMs === undefined) {
        return false;
      }
      if (validUntilMs <= nowMs) {
        seen.delete(nonce);
        return false;
      }
      return true;
    },
    tryConsume(nonce: string, validUntilMs: number, nowMs: number): boolean {
      if (nonce.trim().length === 0 || !Number.isFinite(validUntilMs)) {
        return false;
      }
      purge(nowMs);
      if (seen.has(nonce)) {
        return false;
      }
      if (seen.size >= NONCE_STORE_LIMIT) {
        return false;
      }
      seen.set(nonce, validUntilMs);
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

/** The issued context a callback must match before replay state is touched. */
export interface CallbackExpectation {
  readonly nonce: string;
  readonly requestDigest: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly version: number;
  readonly validUntilMs: number;
  readonly nowMs: number;
}

export interface CallbackAccept {
  readonly ok: true;
  readonly envelope: CallbackEnvelope;
}

export type CallbackResult = CallbackAccept | { readonly ok: false; readonly reason: string; readonly detail: string };

function reject(reason: string, detail: string): CallbackResult {
  return { ok: false, reason, detail };
}

/**
 * Verify an executor callback. The expected issued nonce and the full
 * request/attempt context are validated before replay consumption, and
 * consumption is committed only together with acceptance: misrouted,
 * cross-tenant, stale, or forged callbacks leave the rightful result
 * consumable. A refused atomic consume fails closed.
 */
export function verifyCallback(
  secret: string,
  store: NonceStore,
  envelope: unknown,
  signature: unknown,
  expected: CallbackExpectation,
): CallbackResult {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return reject("invalid-callback", "envelope must be an object");
  }
  const fields = envelope as { readonly [key: string]: unknown };
  let observation: BrowserObservation;
  try {
    observation = parseObservation(fields.observation);
  } catch (error) {
    return reject("invalid-callback", error instanceof Error ? error.message : "invalid");
  }
  const nonce = fields.callbackNonce;
  if (typeof nonce !== "string" || nonce.trim().length === 0) {
    return reject("invalid-callback", "callbackNonce missing");
  }
  if (nonce !== expected.nonce) {
    return reject("unknown-callback", "callback nonce was not issued for this attempt");
  }
  if (observation.requestDigest !== expected.requestDigest) {
    return reject("unknown-callback", "callback answers a different authorized request");
  }
  if (observation.jobId !== expected.jobId || observation.attemptId !== expected.attemptId) {
    return reject("unknown-callback", "callback is bound to another job or attempt");
  }
  let canonical: string;
  try {
    canonical = canonicalJson(observation);
  } catch (error) {
    return reject("invalid-callback", error instanceof Error ? error.message : "not canonicalizable");
  }
  const expectedSignature = hmacHex(secret, `browser-observation\u0000${nonce}\u0000${canonical}`);
  if (!equalHex(expectedSignature, signature)) {
    return reject("bad-signature", "callback signature mismatch");
  }
  if (observation.observationVersion !== expected.version) {
    return reject(
      "stale-callback",
      `version ${observation.observationVersion} does not match expected ${expected.version}`,
    );
  }
  if (store.isConsumed(nonce, expected.nowMs)) {
    return reject("replay-detected", `nonce was already consumed`);
  }
  if (!store.tryConsume(nonce, expected.validUntilMs, expected.nowMs)) {
    return reject("nonce-store-full", "replay store refused admission; failing closed");
  }
  const accepted: CallbackEnvelope = Object.freeze({
    jobId: observation.jobId,
    attemptId: observation.attemptId,
    observationVersion: observation.observationVersion,
    nonce,
    observation,
  });
  return { ok: true, envelope: accepted };
}
