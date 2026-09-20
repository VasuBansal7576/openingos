// Bounded browser-job lifecycle with cancellation fencing and evidence.
//
// A job moves through queued/running/waiting/completed/partial/failed/
// cancelled (ADR-0004 states); attempts move through prepared/dispatching/
// observed outcomes separately. Cancellation before the dispatch claim
// prevents the send; an already-dispatched request may still complete, and
// its late read-only result is recorded with its truthful status without
// reopening the job or authorizing new work. Three consecutive no-progress
// observations fail the job with all verified evidence preserved, and a
// strategy change starts a new operation epoch that keeps prior results.
// Completion requires independently verified coverage of the job's required
// outputs — a model's claim alone never completes a job.
//
// Invalid callbacks are quarantined for inspection without settling the
// awaiting attempt, so a later valid callback can still be accepted exactly
// once. The executor transport and the callback verifier are injected. This
// module performs no network calls and holds no secrets.
//
// Execution reaches a transport only through an authoritative driver that
// consumes single-use operation claims (see driver.ts); the prepare/settle
// primitives below never invoke a transport themselves.

import type {
  AttemptState,
  BrowserJobRequest,
  BrowserObservation,
  Denial,
  JobState,
  ObservedTarget,
  QuarantinedCallback,
} from "./types.ts";
import { denied, isDenial } from "./types.ts";
import type { CallbackResult } from "./signing.ts";
import { authorizeOperation } from "./operations.ts";
import { checkTarget, validateDestination, validateNavigation } from "./policy.ts";
import { parseObservation, parseRequiredOutputs } from "./validation.ts";

/** ADR-0004 proposed default: three consecutive no-progress observations. */
export const NON_PROGRESS_LIMIT = 3;

/** Bounded quarantine log per job; oldest entries are dropped past the cap. */
export const QUARANTINE_LIMIT = 50;

export interface AttemptRecord {
  readonly attemptId: string;
  readonly operationId: string;
  readonly epoch: number;
  readonly state: AttemptState;
  readonly dispatchedAtMs: number | undefined;
  readonly observation: BrowserObservation | undefined;
  readonly verified: boolean;
  readonly lateResult: boolean;
}

export interface VerifiedOutcome {
  readonly attemptId: string;
  readonly operationId: string;
  readonly url: string;
  readonly checkedAtMs: number;
  readonly confirmedOutputs: readonly string[];
}

export interface BrowserJob {
  readonly request: BrowserJobRequest;
  readonly state: JobState;
  readonly attempts: readonly AttemptRecord[];
  readonly verifiedOutcomes: readonly VerifiedOutcome[];
  readonly lateResults: readonly BrowserObservation[];
  readonly quarantined: readonly QuarantinedCallback[];
  readonly consecutiveNoProgress: number;
  readonly epoch: number;
  readonly stepsUsed: number;
  readonly cancelReason: string | undefined;
  readonly createdAtMs: number;
  readonly nextAttempt: number;
  readonly nextObservationVersion: number;
  readonly requiredOutputs: readonly string[];
}

export function createJob(
  request: BrowserJobRequest,
  nowMs: number,
  requiredOutputs: unknown = [],
): BrowserJob {
  return Object.freeze({
    request,
    state: "queued" as JobState,
    attempts: Object.freeze([]) as readonly AttemptRecord[],
    verifiedOutcomes: Object.freeze([]) as readonly VerifiedOutcome[],
    lateResults: Object.freeze([]) as readonly BrowserObservation[],
    quarantined: Object.freeze([]) as readonly QuarantinedCallback[],
    consecutiveNoProgress: 0,
    epoch: 1,
    stepsUsed: 0,
    cancelReason: undefined as string | undefined,
    createdAtMs: nowMs,
    nextAttempt: 1,
    nextObservationVersion: 1,
    requiredOutputs: parseRequiredOutputs(requiredOutputs),
  });
}

export interface AuthorizeInput {
  readonly nowMs: number;
  readonly operationId: string;
  readonly viaRecovery: boolean;
  readonly leaseOk: boolean;
  readonly destination?: string;
  readonly redirectHops?: readonly string[];
  readonly targetId?: string;
  readonly currentTargets?: readonly ObservedTarget[];
  readonly currentDocumentVersion?: string;
}

export interface StepClaim {
  readonly operationId: string;
  readonly destination: string | undefined;
  readonly targetId: string | undefined;
  readonly viaRecovery: boolean;
}

function terminalDenial(state: JobState): Denial {
  if (state === "cancelled") {
    return denied("job-cancelled", "job is cancelled; no new work may dispatch");
  }
  return denied("job-terminal", `job is ${state}; no new work may dispatch`);
}

/** Operations that require a navigation destination. */
function requiresDestination(operationId: string): boolean {
  return operationId === "navigate";
}

/** Operations that require an observed target and document identity. */
function requiresTarget(operationId: string): boolean {
  return operationId === "inspectTarget";
}

/**
 * Authorize one dispatch claim. Checks run in fencing order: job state,
 * expiry (exact expiry denies), session-lease expiry from the authorized
 * request, operation catalog (identical for recovery routes), step budget,
 * operation-specific destination/target requirements, then destination
 * policy. This static pre-check never dispatches; the authoritative driver
 * re-verifies every invariant at the actual commit point.
 */
export function authorizeStep(
  job: BrowserJob,
  input: AuthorizeInput,
): { readonly ok: true; readonly claim: StepClaim } | Denial {
  if (job.state !== "queued" && job.state !== "running") {
    return terminalDenial(job.state);
  }
  if (input.nowMs >= job.request.expiresAt) {
    return denied("job-expired", "job reached its expiry; recheck authority before any dispatch");
  }
  if (input.nowMs >= job.request.sessionLease.expiresAtMs) {
    return denied("lease-invalid", "the authorized session lease reached its expiry");
  }
  if (!input.leaseOk) {
    return denied("lease-invalid", "no valid session lease for this organization/project/job");
  }
  const opDecision = authorizeOperation(input.operationId, job.request.operationCatalogVersion, input.viaRecovery);
  if (!opDecision.ok) {
    return opDecision;
  }
  if (job.stepsUsed >= job.request.maximumSteps) {
    return denied("steps-exhausted", `step budget of ${job.request.maximumSteps} is exhausted`);
  }
  if (requiresDestination(input.operationId) && input.destination === undefined) {
    return denied("missing-destination", `operation "${input.operationId}" requires a validated destination`);
  }
  if (requiresTarget(input.operationId)) {
    if (
      input.targetId === undefined ||
      input.currentTargets === undefined ||
      input.currentDocumentVersion === undefined
    ) {
      return denied("missing-target", `operation "${input.operationId}" requires an observed target and document identity`);
    }
  }
  if (input.targetId !== undefined) {
    if (input.currentTargets === undefined || input.currentDocumentVersion === undefined) {
      return denied("unknown-target", "target check needs the current observed document");
    }
    const targetDecision = checkTarget(input.currentTargets, input.currentDocumentVersion, input.targetId);
    if (!targetDecision.ok) {
      return targetDecision;
    }
  }
  if (input.destination !== undefined) {
    const hops = input.redirectHops ?? Object.freeze([] as string[]);
    const destinationDecision = validateNavigation(input.destination, hops, job.request.allowedOrigins);
    if (!destinationDecision.ok) {
      return destinationDecision;
    }
  }
  const claim: StepClaim = {
    operationId: input.operationId,
    destination: input.destination,
    targetId: input.targetId,
    viaRecovery: input.viaRecovery,
  };
  return { ok: true, claim };
}

export interface TransportInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly destination: string | undefined;
  readonly targetId: string | undefined;
  readonly documentVersion: string | undefined;
  readonly callbackNonce: string;
  readonly requestDigest: string;
}

export interface TransportResult {
  readonly envelope: unknown;
  readonly signature: unknown;
}

export interface StepTransport {
  execute(input: TransportInput, signal: AbortSignal): Promise<TransportResult>;
}

export interface CallbackVerifier {
  verify(envelope: unknown, signature: unknown, expectedVersion: number): CallbackResult;
}

export type StepOutcome =
  | "observed-success"
  | "observed-failure"
  | "transport-unknown"
  | "transport-timeout"
  | "callback-rejected"
  | "claim-refused";

export interface DispatchReceipt {
  readonly attemptId: string;
  readonly outcome: StepOutcome;
  readonly detail: string;
}

function withAttempt(job: BrowserJob, attempt: AttemptRecord): BrowserJob {
  return Object.freeze({
    ...job,
    state: job.state === "queued" ? ("running" as JobState) : job.state,
    attempts: Object.freeze([...job.attempts, attempt]),
    stepsUsed: job.stepsUsed + 1,
    nextAttempt: job.nextAttempt + 1,
  });
}

function replaceAttempt(job: BrowserJob, attempt: AttemptRecord): BrowserJob {
  return Object.freeze({
    ...job,
    attempts: Object.freeze(job.attempts.map((item) => (item.attemptId === attempt.attemptId ? attempt : item))),
  });
}

function failAttempt(job: BrowserJob, attemptId: string): BrowserJob {
  const current = job.attempts.find((item) => item.attemptId === attemptId);
  if (current === undefined) {
    return job;
  }
  return replaceAttempt(job, { ...current, state: "observedFailure" as AttemptState });
}

function quarantine(job: BrowserJob, entry: QuarantinedCallback): BrowserJob {
  const kept = job.quarantined.length >= QUARANTINE_LIMIT
    ? job.quarantined.slice(job.quarantined.length - QUARANTINE_LIMIT + 1)
    : job.quarantined;
  return Object.freeze({ ...job, quarantined: Object.freeze([...kept, entry]) });
}

/**
 * Bounded rejected-callback recording shared by normal and late
 * reconciliation: preserves the explicit policy reason on the job snapshot
 * without accepting success, consuming the rightful nonce, settling the
 * awaiting attempt, or reopening the job. Controlled proof only.
 */
export function quarantinePolicyRejection(
  job: BrowserJob,
  attemptId: string,
  reason: string,
  detail: string,
  nowMs: number,
): BrowserJob {
  return quarantine(job, { attemptId, reason, detail, receivedAtMs: nowMs });
}

/**
 * Claim one dispatch: recheck liveness and expiry at the commit point and
 * record a dispatching attempt. Cancellation before this claim prevents the
 * send; after it, the attempt is in flight and needs reconciliation. This
 * primitive checks only job state and expiry; full authority (lease
 * registry, catalog binding, single-use claims) is enforced by the
 * authoritative driver at its own commit point.
 */
export function prepareAttempt(
  job: BrowserJob,
  claim: StepClaim,
  nowMs: number,
): { readonly job: BrowserJob; readonly attemptId: string } | Denial {
  if (job.state !== "queued" && job.state !== "running") {
    return terminalDenial(job.state);
  }
  if (nowMs >= job.request.expiresAt) {
    return denied("job-expired", "job reached its expiry; recheck authority before any dispatch");
  }
  const attemptId = `a_${job.request.jobId}_${job.nextAttempt}`;
  const prepared: AttemptRecord = Object.freeze({
    attemptId,
    operationId: claim.operationId,
    epoch: job.epoch,
    state: "dispatching" as AttemptState,
    dispatchedAtMs: nowMs,
    observation: undefined as BrowserObservation | undefined,
    verified: false,
    lateResult: false,
  });
  return { job: withAttempt(job, prepared), attemptId };
}

function classifyLiveOutcome(
  job: BrowserJob,
  attempt: AttemptRecord,
  observation: BrowserObservation,
): { readonly job: BrowserJob; readonly failed: boolean } {
  const accepted: AttemptRecord = Object.freeze({ ...attempt, state: "observedSuccess" as AttemptState, observation });
  let current = replaceAttempt(job, accepted);
  current = Object.freeze({ ...current, nextObservationVersion: current.nextObservationVersion + 1 });
  if (observation.claimedOutcome === "noProgress") {
    const consecutive = current.consecutiveNoProgress + 1;
    current = Object.freeze({ ...current, consecutiveNoProgress: consecutive });
    if (consecutive >= NON_PROGRESS_LIMIT) {
      return { job: Object.freeze({ ...current, state: "failed" as JobState }), failed: true };
    }
    return { job: current, failed: false };
  }
  current = Object.freeze({ ...current, consecutiveNoProgress: 0 });
  if (observation.claimedOutcome === "waiting") {
    current = Object.freeze({ ...current, state: "waitingForSupplier" as JobState });
    return { job: current, failed: false };
  }
  if (observation.claimedOutcome === "blockedByPolicy" || observation.claimedOutcome === "operationFailure") {
    return { job: failAttempt(current, attempt.attemptId), failed: true };
  }
  return { job: current, failed: false };
}

/**
 * Classify a late observation truthfully without any state transition: the
 * job stays cancelled, but the attempt records its actual verified status
 * under the same outcome rules as live settlement.
 */
function classifyLateOutcome(
  job: BrowserJob,
  attempt: AttemptRecord,
  observation: BrowserObservation,
): BrowserJob {
  const failed =
    observation.claimedOutcome === "blockedByPolicy" || observation.claimedOutcome === "operationFailure";
  const settled: AttemptRecord = Object.freeze({
    ...attempt,
    state: (failed ? "observedFailure" : "observedSuccess") as AttemptState,
    observation,
    lateResult: true,
  });
  let current = replaceAttempt(job, settled);
  current = Object.freeze({ ...current, nextObservationVersion: current.nextObservationVersion + 1 });
  if (observation.claimedOutcome === "noProgress") {
    current = Object.freeze({ ...current, consecutiveNoProgress: current.consecutiveNoProgress + 1 });
  } else if (!failed) {
    current = Object.freeze({ ...current, consecutiveNoProgress: 0 });
  }
  return Object.freeze({
    ...current,
    lateResults: Object.freeze([...current.lateResults, observation]),
  });
}

/**
 * Shared destination precheck before replay admission: parses the unverified
 * envelope and denies policy-forbidden URLs without consuming the rightful
 * callback's nonce. Fail-closed: unparsable envelopes proceed to verification
 * (which quarantines), allowed URLs proceed, disallowed URLs are quarantined
 * with an explicit policy status and never become observed success.
 */
function precheckObservationDestination(
  job: BrowserJob,
  attemptId: string,
  envelope: unknown,
  nowMs: number,
): { readonly job: BrowserJob; readonly receipt: { readonly attemptId: string; readonly outcome: "callback-rejected"; readonly detail: string } } | undefined {
  let rawObservation: unknown;
  try {
    const fields = envelope as { readonly [key: string]: unknown };
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      return undefined;
    }
    rawObservation = fields.observation;
    const parsed = parseObservation(rawObservation);
    const check = validateDestination(parsed.url, job.request.allowedOrigins);
    if (!check.ok) {
      const held = quarantine(job, {
        attemptId,
        reason: check.reason,
        detail: check.detail,
        receivedAtMs: nowMs,
      });
      return {
        job: held,
        receipt: { attemptId, outcome: "callback-rejected", detail: `${check.reason}: ${check.detail}` },
      };
    }
    return undefined;
  } catch {
    // Unparsable shape: let verification quarantine it without settling.
    return undefined;
  }
}

function failAttemptWithObservation(
  job: BrowserJob,
  attempt: AttemptRecord,
  observation: BrowserObservation,
): BrowserJob {
  const failed: AttemptRecord = Object.freeze({
    ...attempt,
    state: "observedFailure" as AttemptState,
    observation,
  });
  let current = replaceAttempt(job, failed);
  current = Object.freeze({ ...current, nextObservationVersion: current.nextObservationVersion + 1 });
  return current;
}

/**
 * Reconcile an already-dispatched sibling outcome on a waiting/failed job
 * without reopening the job or authorizing new work. The authenticated
 * in-flight result is preserved with its truthful status, accounting and
 * evidence are retained, and exactly one settlement per attempt is enforced
 * by the dispatching/outcomeUnknown guard.
 */
function reconcileSiblingOutcome(
  job: BrowserJob,
  attempt: AttemptRecord,
  observation: BrowserObservation,
): { readonly job: BrowserJob; readonly failed: boolean } {
  const failed =
    observation.claimedOutcome === "blockedByPolicy" || observation.claimedOutcome === "operationFailure";
  const settled: AttemptRecord = Object.freeze({
    ...attempt,
    state: (failed ? "observedFailure" : "observedSuccess") as AttemptState,
    observation,
    lateResult: false,
  });
  let current = replaceAttempt(job, settled);
  current = Object.freeze({ ...current, nextObservationVersion: current.nextObservationVersion + 1 });
  if (observation.claimedOutcome === "noProgress") {
    current = Object.freeze({ ...current, consecutiveNoProgress: current.consecutiveNoProgress + 1 });
  } else if (!failed) {
    current = Object.freeze({ ...current, consecutiveNoProgress: 0 });
  }
  // Job state is deliberately unchanged: waiting stays waiting, failed stays
  // failed. No new work is authorized by this reconciliation.
  return { job: current, failed };
}

/**
 * Settle a dispatching attempt from its delivered callback. Verification,
 * binding, and replay failures are quarantined for inspection WITHOUT
 * settling the attempt, so a later valid callback can still be accepted
 * exactly once and no uncertain outcome is misreported as an observed
 * failure. Destination policy is shared with late settlement and checked
 * BEFORE replay admission, so a policy-forbidden observation never consumes
 * the rightful callback and never becomes observed success. Already-claimed
 * sibling outcomes on waiting/failed jobs are reconciled without reopening
 * the job. A settled attempt on a job that has since been cancelled must go
 * through recordLateObservation instead.
 */
export function settleAttempt(
  job: BrowserJob,
  attemptId: string,
  envelope: unknown,
  signature: unknown,
  callbacks: CallbackVerifier,
  nowMs: number,
): { readonly job: BrowserJob; readonly receipt: DispatchReceipt } | Denial {
  if (job.state === "cancelled") {
    return denied("job-cancelled", "a cancelled job settles in-flight attempts via recordLateObservation");
  }
  const attempt = job.attempts.find((item) => item.attemptId === attemptId);
  if (attempt === undefined || (attempt.state !== "dispatching" && attempt.state !== "outcomeUnknown")) {
    return denied("unknown-callback", `attempt "${attemptId}" is not awaiting a result`);
  }
  // Waiting/failed reconciliation still requires an awaiting attempt; the
  // state check below separates live classification from sibling preservation.
  const isLive = job.state === "queued" || job.state === "running";
  if (!isLive && job.state !== "waitingForSupplier" && job.state !== "waitingForUser" && job.state !== "failed") {
    return terminalDenial(job.state);
  }

  const prechecked = precheckObservationDestination(job, attemptId, envelope, nowMs);
  if (prechecked !== undefined) {
    return prechecked;
  }

  const verified = callbacks.verify(envelope, signature, job.nextObservationVersion);
  if (!verified.ok) {
    const held = quarantine(job, {
      attemptId,
      reason: verified.reason,
      detail: verified.detail,
      receivedAtMs: nowMs,
    });
    return {
      job: held,
      receipt: { attemptId, outcome: "callback-rejected", detail: `${verified.reason}: ${verified.detail}` },
    };
  }
  const observation = verified.envelope.observation;
  if (observation.jobId !== job.request.jobId || observation.attemptId !== attemptId) {
    const held = quarantine(job, {
      attemptId,
      reason: "unknown-callback",
      detail: "observation is bound to another job or attempt",
      receivedAtMs: nowMs,
    });
    return {
      job: held,
      receipt: { attemptId, outcome: "callback-rejected", detail: "observation is bound to another job or attempt" },
    };
  }
  // Defense in depth: precheck already denied forbidden URLs without consuming.
  // If this ever triggers (allowlist changed mid-flight), retain the failure
  // observation explicitly instead of dropping it, and never report success.
  const destinationCheck = validateDestination(observation.url, job.request.allowedOrigins);
  if (!destinationCheck.ok) {
    const current = failAttemptWithObservation(job, attempt, observation);
    return {
      job: current,
      receipt: { attemptId, outcome: "observed-failure", detail: `observed URL rejected: ${destinationCheck.detail}` },
    };
  }

  if (!isLive) {
    const { job: current, failed } = reconcileSiblingOutcome(job, attempt, observation);
    if (failed) {
      return {
        job: current,
        receipt: { attemptId, outcome: "observed-failure", detail: `sibling in-flight result preserved as failure; job remains ${job.state}` },
      };
    }
    if (observation.claimedOutcome === "noProgress") {
      return { job: current, receipt: { attemptId, outcome: "observed-success", detail: "sibling no-progress preserved; job remains waiting/failed" } };
    }
    return { job: current, receipt: { attemptId, outcome: "observed-success", detail: `sibling in-flight result preserved; job remains ${job.state}` } };
  }

  const { job: current, failed } = classifyLiveOutcome(job, attempt, observation);
  if (failed && current.state === "failed") {
    return {
      job: current,
      receipt: {
        attemptId,
        outcome: "observed-failure",
        detail: `non-progress limit of ${NON_PROGRESS_LIMIT} reached; evidence preserved`,
      },
    };
  }
  if (failed) {
    return {
      job: current,
      receipt: { attemptId, outcome: "observed-failure", detail: `executor reported ${observation.claimedOutcome}` },
    };
  }
  if (observation.claimedOutcome === "noProgress") {
    return { job: current, receipt: { attemptId, outcome: "observed-success", detail: "no progress yet" } };
  }
  return { job: current, receipt: { attemptId, outcome: "observed-success", detail: "observation recorded" } };
}

/**
 * Cancel a job. Attempts not yet dispatched are cancelled with it; an
 * already-dispatched in-flight attempt keeps its state for later
 * reconciliation through recordLateObservation — cancellation cannot unsend.
 */
export function cancelJob(job: BrowserJob, nowMs: number, reason: string): BrowserJob | Denial {
  void nowMs;
  if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
    return denied("invalid-transition", `cannot cancel a ${job.state} job`);
  }
  return Object.freeze({
    ...job,
    state: "cancelled" as JobState,
    cancelReason: reason,
    attempts: Object.freeze(
      job.attempts.map((attempt) =>
        attempt.state === "prepared" ? { ...attempt, state: "cancelled" as AttemptState } : attempt,
      ),
    ),
  });
}

/**
 * Fence an expired job: active work becomes cancelled with reason "expired".
 * This is the single fencing transition for every enforced deadline: the job
 * deadline, the signed-request lease expiry, the live lease/claim expiry and
 * the active-execution ceiling. Any reached deadline fences active work (and
 * the driver releases the tracked session); waiting work is fenced like
 * running work because neither may hold an active session past a deadline.
 */
export function fenceExpired(
  job: BrowserJob,
  nowMs: number,
  extra?: {
    readonly leaseExpiryMs?: number;
    readonly claimExpiryMs?: number;
    readonly ceilingAtMs?: number;
  },
): BrowserJob {
  const active =
    job.state === "queued" ||
    job.state === "running" ||
    job.state === "waitingForSupplier" ||
    job.state === "waitingForUser" ||
    job.state === "pausedBudget";
  if (!active) {
    return job;
  }
  const deadlines = [job.request.expiresAt];
  if (extra?.leaseExpiryMs !== undefined) {
    deadlines.push(extra.leaseExpiryMs);
  }
  if (extra?.claimExpiryMs !== undefined) {
    deadlines.push(extra.claimExpiryMs);
  }
  if (extra?.ceilingAtMs !== undefined) {
    deadlines.push(extra.ceilingAtMs);
  }
  const fenced = deadlines.some((deadline) => nowMs >= deadline);
  if (!fenced) {
    return job;
  }
  const cancelled = cancelJob(job, nowMs, "expired");
  if (isDenial(cancelled)) {
    return job;
  }
  return cancelled;
}

export interface LateReceipt {
  readonly attemptId: string;
  readonly recorded: boolean;
  readonly detail: string;
}

/**
 * Record a late read-only result for an in-flight attempt after
 * cancellation. The observation is preserved with its truthful status and
 * the job stays cancelled: no new work is authorized and no terminal
 * transition is applied. Destination policy is shared with normal settlement
 * and checked BEFORE replay admission, so a policy-forbidden late observation
 * never consumes the rightful callback and never becomes observed success.
 */
export function recordLateObservation(
  job: BrowserJob,
  attemptId: string,
  envelope: unknown,
  signature: unknown,
  callbacks: CallbackVerifier,
  nowMs: number,
): { readonly job: BrowserJob; readonly receipt: LateReceipt } | Denial {
  if (job.state !== "cancelled") {
    return denied("invalid-transition", "late results apply only to cancelled jobs");
  }
  const attempt = job.attempts.find((item) => item.attemptId === attemptId);
  if (attempt === undefined) {
    return denied("unknown-callback", `attempt "${attemptId}" does not belong to this job`);
  }
  if (attempt.state !== "dispatching" && attempt.state !== "outcomeUnknown") {
    return denied("invalid-transition", `attempt "${attemptId}" is already settled`);
  }
  // Shared destination validation before replay admission.
  try {
    if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
      const fields = envelope as { readonly [key: string]: unknown };
      try {
        const parsed = parseObservation(fields.observation);
        const destCheck = validateDestination(parsed.url, job.request.allowedOrigins);
        if (!destCheck.ok) {
          return denied(destCheck.reason, `late observation destination rejected: ${destCheck.detail}`);
        }
      } catch {
        // Unparsable: let verification handle it below.
      }
    }
  } catch {
    // Fall through to verification.
  }
  const verified = callbacks.verify(envelope, signature, job.nextObservationVersion);
  if (!verified.ok) {
    return denied("bad-signature", `${verified.reason}: ${verified.detail}`);
  }
  const observation = verified.envelope.observation;
  if (observation.jobId !== job.request.jobId || observation.attemptId !== attemptId) {
    return denied("unknown-callback", "late observation is bound to another job or attempt");
  }
  // Defense in depth: precheck already denied forbidden late URLs without
  // consuming. If this triggers, deny rather than recording success.
  const lateDestCheck = validateDestination(observation.url, job.request.allowedOrigins);
  if (!lateDestCheck.ok) {
    return denied(lateDestCheck.reason, `late observation destination rejected: ${lateDestCheck.detail}`);
  }
  const next = classifyLateOutcome(job, attempt, observation);
  return {
    job: next,
    receipt: { attemptId, recorded: true, detail: "late result preserved with its status; job remains cancelled" },
  };
}

export interface IndependentCheck {
  readonly checker: "independent" | "self";
  readonly observedUrl: string;
  readonly matches: boolean;
  /** Required outputs this check confirms, each evidenced by the observation. */
  readonly confirmedOutputs: readonly string[];
}

/**
 * Apply an independent result check. Only a separate independent check that
 * matches a successful-production observation verifies an outcome: the
 * observation must claim success (waiting/no-progress/blocked/failure never
 * prove task outputs, even when producedOutputs echoes an ID), and every
 * confirmed output must appear in the observation's produced outputs.
 * Self-reported success stays unverified and can never complete the job.
 */
export function applyIndependentCheck(
  job: BrowserJob,
  attemptId: string,
  check: IndependentCheck,
  nowMs: number,
): BrowserJob | Denial {
  const attempt = job.attempts.find((item) => item.attemptId === attemptId);
  if (attempt === undefined || attempt.observation === undefined) {
    return denied("unknown-callback", `attempt "${attemptId}" has no recorded observation`);
  }
  if (attempt.state !== "observedSuccess") {
    return denied("unverified", `attempt "${attemptId}" did not succeed`);
  }
  // Meaningful output semantics: only a successful production observation can
  // evidence task outputs. Waiting/no-progress observations produce no outputs
  // for completion, so a generic URL match or an echoed string ID on those
  // states can never verify.
  if (attempt.observation.claimedOutcome !== "success") {
    return denied(
      "unverified",
      `attempt "${attemptId}" claimed "${attempt.observation.claimedOutcome}", not successful production; waiting/no-progress never prove outputs`,
    );
  }
  if (check.checker !== "independent" || !check.matches || check.observedUrl !== attempt.observation.url) {
    return denied("unverified", "outcome lacks a matching independent check");
  }
  const produced = attempt.observation.producedOutputs ?? Object.freeze([] as string[]);
  for (const output of check.confirmedOutputs) {
    if (!produced.includes(output)) {
      return denied("unverified", `confirmed output "${output}" is not evidenced by the observation`);
    }
  }
  const outcome: VerifiedOutcome = Object.freeze({
    attemptId,
    operationId: attempt.operationId,
    url: attempt.observation.url,
    checkedAtMs: nowMs,
    confirmedOutputs: Object.freeze([...check.confirmedOutputs]),
  });
  return Object.freeze({
    ...replaceAttempt(job, { ...attempt, verified: true }),
    verifiedOutcomes: Object.freeze([...job.verifiedOutcomes, outcome]),
  });
}

/**
 * Complete a job only with independently verified coverage of every
 * required output and no unsettled attempts. Completion requires meaningful
 * task outputs: outputless jobs (empty requiredOutputs) are explicitly
 * rejected, and waiting/no-progress observations can never verify outputs, so
 * a generic URL match alone can never complete any job.
 */
export function tryComplete(job: BrowserJob): BrowserJob | Denial {
  if (job.requiredOutputs.length === 0) {
    return denied("missing-outputs", "completion requires meaningful task outputs; outputless jobs cannot complete");
  }
  if (job.verifiedOutcomes.length === 0) {
    return denied("unverified", "completion needs at least one independently verified outcome");
  }
  for (const attempt of job.attempts) {
    if (attempt.state === "prepared" || attempt.state === "dispatching" || attempt.state === "outcomeUnknown") {
      return denied("pending-attempts", `attempt "${attempt.attemptId}" is still unsettled`);
    }
  }
  const covered = new Set<string>();
  for (const outcome of job.verifiedOutcomes) {
    for (const output of outcome.confirmedOutputs) {
      covered.add(output);
    }
  }
  for (const required of job.requiredOutputs) {
    if (!covered.has(required)) {
      return denied("missing-outputs", `required output "${required}" has no verified evidence`);
    }
  }
  if (job.state !== "running" && job.state !== "partial" && job.state !== "waitingForSupplier" && job.state !== "waitingForUser") {
    return terminalDenial(job.state);
  }
  return Object.freeze({ ...job, state: "completed" as JobState });
}

/**
 * Change strategy after weak progress — or resume after a wait: keep every
 * verified outcome and recorded observation, reset the no-progress counter,
 * and continue in a new operation epoch. Waiting jobs resume to running;
 * blocked operations stay blocked in the new epoch.
 */
export function changeStrategy(job: BrowserJob, reason: string): BrowserJob | Denial {
  void reason;
  if (
    job.state !== "running" &&
    job.state !== "partial" &&
    job.state !== "failed" &&
    job.state !== "waitingForSupplier" &&
    job.state !== "waitingForUser"
  ) {
    return denied("invalid-transition", `cannot change strategy from ${job.state}`);
  }
  return Object.freeze({
    ...job,
    state: "running" as JobState,
    epoch: job.epoch + 1,
    consecutiveNoProgress: 0,
  });
}
