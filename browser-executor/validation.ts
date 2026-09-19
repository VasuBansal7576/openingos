// Unknown-input validation for the browser-executor boundary.
//
// Every value crossing into this module is validated from `unknown` and
// either normalized into a frozen record or rejected with a TypeError.
// Policy denials (wrong org, blocked destination, ...) are NOT TypeErrors;
// they are typed Denial values produced by the policy, session, and job
// modules after validation succeeds.

import type {
  BrowserJobRequest,
  BrowserObservation,
  ClaimedOutcome,
  CollectedEvidence,
  MeteredUsage,
  ObservedTarget,
  SessionLeaseSpec,
} from "./types.ts";

export type UnknownRecord = { readonly [key: string]: unknown };

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function assertSafeKeys(value: UnknownRecord, label: string): void {
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) {
      throw new TypeError(`${label} contains forbidden key "${key}"`);
    }
  }
}

export function requiredRecord(input: unknown, label: string): UnknownRecord {
  if (!isRecord(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  assertSafeKeys(input, label);
  return input;
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

export function requiredStringArray(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${label} must be an array`);
  }
  const out: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item: unknown = input[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`${label}[${index}] must be a non-empty string`);
    }
    out.push(item);
  }
  return Object.freeze(out);
}

export function requiredInteger(
  input: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    throw new TypeError(`${label} must be an integer`);
  }
  if (!Number.isFinite(input) || input < minimum || input > maximum) {
    throw new TypeError(`${label} must be within [${minimum}, ${maximum}]`);
  }
  return input;
}

export function requiredFiniteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return input;
}

export function requiredBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return input;
}

/** ADR-0004 proposed default: at most 45 browser operations per job. */
export const MAXIMUM_STEPS_LIMIT = 45;

export function parseSessionLease(input: unknown): SessionLeaseSpec {
  const record = requiredRecord(input, "sessionLease");
  const leaseId = requiredString(record.leaseId, "sessionLease.leaseId");
  const expiresAtMs = requiredFiniteNumber(record.expiresAtMs, "sessionLease.expiresAtMs");
  if (expiresAtMs <= 0) {
    throw new TypeError("sessionLease.expiresAtMs must be positive");
  }
  return Object.freeze({ leaseId, expiresAtMs });
}

export function parseJobRequest(input: unknown): BrowserJobRequest {
  const record = requiredRecord(input, "BrowserJobRequest");
  const jobId = requiredString(record.jobId, "jobId");
  const organizationId = requiredString(record.organizationId, "organizationId");
  const projectId = requiredString(record.projectId, "projectId");
  const grantVersion = requiredString(record.grantVersion, "grantVersion");
  const inputVersion = requiredString(record.inputVersion, "inputVersion");
  const allowedOrigins = requiredStringArray(record.allowedOrigins, "allowedOrigins");
  if (allowedOrigins.length === 0) {
    throw new TypeError("allowedOrigins must not be empty");
  }
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(`allowedOrigins entry "${origin}" is not a valid origin`);
    }
    if (parsed.protocol !== "https:") {
      throw new TypeError(`allowedOrigins entry "${origin}" must be an https origin`);
    }
  }
  const operationCatalogVersion = requiredString(
    record.operationCatalogVersion,
    "operationCatalogVersion",
  );
  const sessionLease = parseSessionLease(record.sessionLease);
  const maximumSteps = requiredInteger(record.maximumSteps, "maximumSteps", 1, MAXIMUM_STEPS_LIMIT);
  const expiresAt = requiredFiniteNumber(record.expiresAt, "expiresAt");
  if (expiresAt <= 0) {
    throw new TypeError("expiresAt must be positive");
  }
  const reservationId = requiredString(record.reservationId, "reservationId");
  const callbackNonce = requiredString(record.callbackNonce, "callbackNonce");
  return Object.freeze({
    jobId,
    organizationId,
    projectId,
    grantVersion,
    inputVersion,
    allowedOrigins,
    operationCatalogVersion,
    sessionLease,
    maximumSteps,
    expiresAt,
    reservationId,
    callbackNonce,
  });
}

const CLAIMED_OUTCOMES: readonly ClaimedOutcome[] = Object.freeze([
  "success",
  "operationFailure",
  "noProgress",
  "waiting",
  "blockedByPolicy",
]);

function parseClaimedOutcome(input: unknown): ClaimedOutcome {
  if (typeof input !== "string") {
    throw new TypeError("claimedOutcome must be a string");
  }
  for (const outcome of CLAIMED_OUTCOMES) {
    if (input === outcome) {
      return outcome;
    }
  }
  throw new TypeError(`claimedOutcome "${input}" is not a known outcome`);
}

function parseObservedTarget(input: unknown, label: string): ObservedTarget {
  const record = requiredRecord(input, label);
  return Object.freeze({
    targetId: requiredString(record.targetId, `${label}.targetId`),
    documentVersion: requiredString(record.documentVersion, `${label}.documentVersion`),
    occluded: requiredBoolean(record.occluded, `${label}.occluded`),
  });
}

function parseCollectedEvidence(input: unknown, label: string): CollectedEvidence {
  const record = requiredRecord(input, label);
  return Object.freeze({
    kind: requiredString(record.kind, `${label}.kind`),
    locator: requiredString(record.locator, `${label}.locator`),
    excerpt: requiredString(record.excerpt, `${label}.excerpt`),
  });
}

function parseMeteredUsage(input: unknown): MeteredUsage {
  const record = requiredRecord(input, "meteredUsage");
  return Object.freeze({
    operationsUsed: requiredInteger(record.operationsUsed, "meteredUsage.operationsUsed", 0, 1_000_000),
    millisUsed: requiredInteger(record.millisUsed, "meteredUsage.millisUsed", 0, 3_600_000),
  });
}

export function parseObservation(input: unknown): BrowserObservation {
  const record = requiredRecord(input, "BrowserObservation");
  const jobId = requiredString(record.jobId, "jobId");
  const attemptId = requiredString(record.attemptId, "attemptId");
  const observationVersion = requiredInteger(
    record.observationVersion,
    "observationVersion",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const url = requiredString(record.url, "url");
  const capturedAt = requiredFiniteNumber(record.capturedAt, "capturedAt");
  const visibleText = requiredRecord(record, "BrowserObservation").visibleText;
  if (typeof visibleText !== "string") {
    throw new TypeError("visibleText must be a string");
  }
  const targetsInput = record.observedTargets;
  if (!Array.isArray(targetsInput)) {
    throw new TypeError("observedTargets must be an array");
  }
  const observedTargets = Object.freeze(
    targetsInput.map((item, index) => parseObservedTarget(item, `observedTargets[${index}]`)),
  );
  const evidenceInput = record.collectedEvidence;
  if (!Array.isArray(evidenceInput)) {
    throw new TypeError("collectedEvidence must be an array");
  }
  const collectedEvidence = Object.freeze(
    evidenceInput.map((item, index) => parseCollectedEvidence(item, `collectedEvidence[${index}]`)),
  );
  const claimedOutcome = parseClaimedOutcome(record.claimedOutcome);
  const meteredUsage = parseMeteredUsage(record.meteredUsage);
  const rawVerification = record.verificationEvidence;
  if (rawVerification !== undefined && typeof rawVerification !== "string") {
    throw new TypeError("verificationEvidence must be a string when present");
  }
  const base = {
    jobId,
    attemptId,
    observationVersion,
    url,
    capturedAt,
    visibleText,
    observedTargets,
    collectedEvidence,
    claimedOutcome,
    meteredUsage,
  };
  return Object.freeze(
    rawVerification === undefined ? base : { ...base, verificationEvidence: rawVerification },
  );
}
