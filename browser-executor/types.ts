// F0-BROWSER controlled contract proof.
//
// ADR-0006 (proposed) boundary for hosted isolated browser execution:
// validated job requests, HMAC-signed dispatch, replay-protected callbacks,
// one-org/project/job session leases, destination policy, a closed operation
// catalog, and bounded recovery with preserved evidence.
//
// Controlled proof only: the executor transport is injected by the caller.
// This module performs zero live browser, provider, or network calls, holds
// no credentials, and claims no D-04 deployed/hosted success.

export type JobState =
  | "queued"
  | "running"
  | "waitingForSupplier"
  | "waitingForUser"
  | "pausedBudget"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type AttemptState =
  | "prepared"
  | "dispatching"
  | "observedSuccess"
  | "observedFailure"
  | "outcomeUnknown"
  | "cancelled";

export type ClaimedOutcome =
  | "success"
  | "operationFailure"
  | "noProgress"
  | "waiting"
  | "blockedByPolicy";

/** Effect class of a catalogued browser operation. */
export type OperationEffect =
  | "read"
  | "vendorWrite"
  | "purchase"
  | "account"
  | "download"
  | "script";

export interface SessionLeaseSpec {
  readonly leaseId: string;
  /** Absolute expiry in epoch milliseconds. */
  readonly expiresAtMs: number;
}

export interface BrowserJobRequest {
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly grantVersion: string;
  readonly inputVersion: string;
  /** Exact https origins the job may observe, e.g. "https://example.com". */
  readonly allowedOrigins: readonly string[];
  readonly operationCatalogVersion: string;
  readonly sessionLease: SessionLeaseSpec;
  /** Upper bound on dispatched browser operations; ADR-0004 default is 45. */
  readonly maximumSteps: number;
  /** Absolute job expiry in epoch milliseconds. */
  readonly expiresAt: number;
  readonly reservationId: string;
  readonly callbackNonce: string;
}

export interface ObservedTarget {
  readonly targetId: string;
  readonly documentVersion: string;
  readonly occluded: boolean;
}

export interface CollectedEvidence {
  readonly kind: string;
  readonly locator: string;
  readonly excerpt: string;
}

export interface MeteredUsage {
  readonly operationsUsed: number;
  readonly millisUsed: number;
}

export interface BrowserObservation {
  readonly jobId: string;
  readonly attemptId: string;
  readonly observationVersion: number;
  readonly url: string;
  readonly capturedAt: number;
  readonly visibleText: string;
  readonly observedTargets: readonly ObservedTarget[];
  readonly collectedEvidence: readonly CollectedEvidence[];
  readonly claimedOutcome: ClaimedOutcome;
  readonly verificationEvidence?: string;
  readonly meteredUsage: MeteredUsage;
  /**
   * HMAC digest of the immutable authorized request this observation answers.
   * Binds the callback to one organization/project/grant/input/lease
   * authority so same-ID jobs under other tenants cannot accept it.
   */
  readonly requestDigest: string;
  /** Task outputs this observation claims to produce; checked independently. */
  readonly producedOutputs?: readonly string[];
}

/** A rejected callback preserved for inspection without settling the attempt. */
export interface QuarantinedCallback {
  readonly attemptId: string;
  readonly reason: string;
  readonly detail: string;
  readonly receivedAtMs: number;
}

/** Denial reasons returned instead of throwing for expected policy outcomes. */
export type DenialReason =
  | "unknown-operation"
  | "stale-catalog"
  | "vendor-write-blocked"
  | "purchase-blocked"
  | "account-blocked"
  | "download-blocked"
  | "script-blocked"
  | "arbitrary-selector-blocked"
  | "unknown-target"
  | "stale-document"
  | "occluded-target"
  | "unsupported-protocol"
  | "blocked-host"
  | "private-network"
  | "metadata-endpoint"
  | "origin-not-allowed"
  | "invalid-url"
  | "redirect-downgrade"
  | "redirect-origin-not-allowed"
  | "too-many-redirects"
  | "job-cancelled"
  | "job-terminal"
  | "job-expired"
  | "lease-invalid"
  | "steps-exhausted"
  | "non-progress-limit"
  | "unverified"
  | "pending-attempts"
  | "replay-detected"
  | "stale-callback"
  | "bad-signature"
  | "unknown-callback"
  | "conflict"
  | "invalid-transition"
  | "missing-destination"
  | "missing-target"
  | "unknown-claim"
  | "claim-reused"
  | "claim-job-mismatch"
  | "nonce-store-full"
  | "missing-outputs"
  | "unknown-job";

export interface Denial {
  readonly ok: false;
  readonly reason: DenialReason;
  readonly detail: string;
}

export interface Approval {
  readonly ok: true;
}

export type Decision = Approval | Denial;

export function denied(reason: DenialReason, detail: string): Denial {
  return { ok: false, reason, detail };
}

export function approved(): Approval {
  return { ok: true };
}

/** Narrow an unknown outcome to a denial (ok === false). */
export function isDenial(value: unknown): value is Denial {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  const candidate = value as { readonly ok: unknown; readonly reason: unknown; readonly detail: unknown };
  return candidate.ok === false && typeof candidate.reason === "string" && typeof candidate.detail === "string";
}
