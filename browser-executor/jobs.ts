// Bounded browser-job lifecycle with cancellation fencing and evidence.
//
// A job moves through queued/running/waiting/completed/partial/failed/
// cancelled (ADR-0004 states); attempts move through prepared/dispatching/
// observed outcomes separately. Cancellation before the dispatch claim
// prevents the send; an already-dispatched request may still complete, and
// its late read-only result is recorded as evidence without reopening the
// job or authorizing new work. Three consecutive no-progress observations
// fail the job with all verified evidence preserved, and a strategy change
// starts a new operation epoch that keeps prior results. Completion
// requires an independently verified outcome — a model's claim alone never
// completes a job.
//
// The executor transport and the callback verifier are injected. This
// module performs no network calls and holds no secrets.

import type {
  AttemptState,
  BrowserJobRequest,
  BrowserObservation,
  Decision,
  JobState,
  ObservedTarget,
} from "./types.ts";
import { denied } from "./types.ts";
import type { CallbackResult } from "./signing.ts";
import { authorizeOperation } from "./operations.ts";
import { checkTarget, validateDestination, validateNavigation } from "./policy.ts";

/** ADR-0004 proposed default: three consecutive no-progress observations. */
export const NON_PROGRESS_LIMIT = 3;

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
}

export interface BrowserJob {
  readonly request: BrowserJobRequest;
  readonly state: JobState;
  readonly attempts: readonly AttemptRecord[];
  readonly verifiedOutcomes: readonly VerifiedOutcome[];
  readonly lateResults: readonly BrowserObservation[];
  readonly consecutiveNoProgress: number;
  readonly epoch: number;
  readonly stepsUsed: number;
  readonly cancelReason: string | undefined;
  readonly createdAtMs: number;
  readonly nextAttempt: number;
  readonly nextObservationVersion: number;
}

export function createJob(request: BrowserJobRequest, nowMs: number): BrowserJob {
  return Object.freeze({
    request,
    state: "queued" as JobState,
    attempts: Object.freeze([]) as readonly AttemptRecord[],
    verifiedOutcomes: Object.freeze([]) as readonly VerifiedOutcome[],
    lateResults: Object.freeze([]) as readonly BrowserObservation[],
    consecutiveNoProgress: 0,
    epoch: 1,
    stepsUsed: 0,
    cancelReason: undefined as string | undefined,
    createdAtMs: nowMs,
    nextAttempt: 1,
    nextObservationVersion: 1,
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

function terminalDenial(state: JobState): Decision {
  if (state === "cancelled") {
    return denied("job-cancelled", "job is cancelled; no new work may dispatch");
  }
  return denied("job-terminal", `job is ${state}; no new work may dispatch`);
}

/**
 * Authorize one dispatch claim. Checks run in fencing order: job state,
 * expiry, session lease, operation catalog (identical for recovery routes),
 * step budget, observed-target freshness, then destination policy.
 */
export function authorizeStep(
  job: BrowserJob,
  input: AuthorizeInput,
): { readonly ok: true; readonly claim: StepClaim } | Decision {
  if (job.state !== "queued" && job.state !== "running") {
    return terminalDenial(job.state);
  }
  if (input.nowMs > job.request.expiresAt) {
    return denied("job-expired", "job passed its expiry; recheck authority before any dispatch");
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

/**
 * Claim one dispatch: recheck liveness and expiry at the commit point and
 * record a dispatching attempt. Cancellation before this claim prevents the
 * send; after it, the attempt is in flight and needs reconciliation.
 */
export function prepareAttempt(
  job: BrowserJob,
  claim: StepClaim,
  nowMs: number,
): { readonly job: BrowserJob; readonly attemptId: string } | Decision {
  if (job.state !== "queued" && job.state !== "running") {
    return terminalDenial(job.state);
  }
  if (nowMs > job.request.expiresAt) {
    return denied("job-expired", "job passed its expiry; recheck authority before any dispatch");
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

export interface TransportInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly destination: string | undefined;
}

export interface TransportResult {
  readonly envelope: unknown;
  readonly signature: unknown;
}

export interface StepTransport {
  execute(input: TransportInput): Promise<TransportResult>;
}

export interface CallbackVerifier {
  verify(envelope: unknown, signature: unknown, expectedVersion: number): CallbackResult;
}

export type StepOutcome = "observed-success" | "observed-failure" | "transport-unknown" | "callback-rejected";

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

/**
 * Settle a dispatching attempt from its delivered callback: verify the
 * signature, enforce replay and version protection, bind the observation to
 * this job and attempt, and apply the no-progress bound. A settled attempt
 * on a job that has since been cancelled must go through
 * recordLateObservation instead, so late effects stay explicit.
 */
export function settleAttempt(
  job: BrowserJob,
  attemptId: string,
  envelope: unknown,
  signature: unknown,
  callbacks: CallbackVerifier,
): { readonly job: BrowserJob; readonly receipt: DispatchReceipt } | Decision {
  if (job.state === "cancelled") {
    return denied("job-cancelled", "a cancelled job settles in-flight attempts via recordLateObservation");
  }
  if (job.state !== "queued" && job.state !== "running") {
    return terminalDenial(job.state);
  }
  const attempt = job.attempts.find((item) => item.attemptId === attemptId);
  if (attempt === undefined || (attempt.state !== "dispatching" && attempt.state !== "outcomeUnknown")) {
    return denied("unknown-callback", `attempt "${attemptId}" is not awaiting a result`);
  }

  const verified = callbacks.verify(envelope, signature, job.nextObservationVersion);
  if (!verified.ok) {
    return { job: failAttempt(job, attemptId), receipt: { attemptId, outcome: "callback-rejected", detail: `${verified.reason}: ${verified.detail}` } };
  }
  const observation = verified.envelope.observation;
  if (observation.jobId !== job.request.jobId || observation.attemptId !== attemptId) {
    return {
      job: failAttempt(job, attemptId),
      receipt: { attemptId, outcome: "observed-failure", detail: "observation is bound to another job or attempt" },
    };
  }
  const destinationCheck = validateDestination(observation.url, job.request.allowedOrigins);
  if (!destinationCheck.ok) {
    return {
      job: failAttempt(job, attemptId),
      receipt: { attemptId, outcome: "observed-failure", detail: `observed URL rejected: ${destinationCheck.detail}` },
    };
  }

  const accepted: AttemptRecord = Object.freeze({ ...attempt, state: "observedSuccess" as AttemptState, observation });
  let current = replaceAttempt(job, accepted);
  current = Object.freeze({ ...current, nextObservationVersion: current.nextObservationVersion + 1 });

  if (observation.claimedOutcome === "noProgress") {
    const consecutive = current.consecutiveNoProgress + 1;
    current = Object.freeze({ ...current, consecutiveNoProgress: consecutive });
    if (consecutive >= NON_PROGRESS_LIMIT) {
      current = Object.freeze({ ...current, state: "failed" as JobState });
      return {
        job: current,
        receipt: {
          attemptId,
          outcome: "observed-failure",
          detail: `non-progress limit of ${NON_PROGRESS_LIMIT} reached; evidence preserved`,
        },
      };
    }
    return { job: current, receipt: { attemptId, outcome: "observed-success", detail: "no progress yet" } };
  }

  current = Object.freeze({ ...current, consecutiveNoProgress: 0 });
  if (observation.claimedOutcome === "waiting") {
    current = Object.freeze({ ...current, state: "waitingForSupplier" as JobState });
  }
  if (observation.claimedOutcome === "blockedByPolicy" || observation.claimedOutcome === "operationFailure") {
    current = failAttempt(current, attemptId);
    return {
      job: current,
      receipt: { attemptId, outcome: "observed-failure", detail: `executor reported ${observation.claimedOutcome}` },
    };
  }
  return { job: current, receipt: { attemptId, outcome: "observed-success", detail: "observation recorded" } };
}

/**
 * Dispatch one authorized claim through the injected transport and account
 * for its callback. The claim must come from authorizeStep; this function
 * never reopens a cancelled or expired job.
 */
export async function dispatchStep(
  job: BrowserJob,
  claim: StepClaim,
  transport: StepTransport,
  callbacks: CallbackVerifier,
  nowMs: number,
): Promise<{ readonly job: BrowserJob; readonly receipt: DispatchReceipt }> {
  const prepared = prepareAttempt(job, claim, nowMs);
  if ("ok" in prepared) {
    const denial = prepared as Decision;
    if (denial.ok === false) {
      return {
        job,
        receipt: { attemptId: "", outcome: "callback-rejected", detail: `${denial.reason}: ${denial.detail}` },
      };
    }
  }
  const { job: claimed, attemptId } = prepared as { readonly job: BrowserJob; readonly attemptId: string };

  let delivered: TransportResult;
  try {
    delivered = await transport.execute({
      jobId: job.request.jobId,
      attemptId,
      operationId: claim.operationId,
      destination: claim.destination,
    });
  } catch (error) {
    const stranded = claimed.attempts.find((item) => item.attemptId === attemptId) as AttemptRecord;
    const current = replaceAttempt(claimed, { ...stranded, state: "outcomeUnknown" as AttemptState });
    return {
      job: current,
      receipt: {
        attemptId,
        outcome: "transport-unknown",
        detail: error instanceof Error ? error.message : "transport failed",
      },
    };
  }

  const settled = settleAttempt(claimed, attemptId, delivered.envelope, delivered.signature, callbacks);
  if ("ok" in settled) {
    const denial = settled as Decision;
    if (denial.ok === false) {
      return { job: claimed, receipt: { attemptId, outcome: "callback-rejected", detail: `${denial.reason}: ${denial.detail}` } };
    }
  }
  return settled as { readonly job: BrowserJob; readonly receipt: DispatchReceipt };
}

/**
 * Cancel a job. Attempts not yet dispatched are cancelled with it; an
 * already-dispatched in-flight attempt keeps its state for later
 * reconciliation through recordLateObservation — cancellation cannot unsend.
 */
export function cancelJob(job: BrowserJob, nowMs: number, reason: string): BrowserJob | Decision {
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

/** Fence an expired job: active work becomes cancelled with reason "expired". */
export function fenceExpired(job: BrowserJob, nowMs: number): BrowserJob {
  const active =
    job.state === "queued" ||
    job.state === "running" ||
    job.state === "waitingForSupplier" ||
    job.state === "waitingForUser" ||
    job.state === "pausedBudget";
  if (!active || nowMs <= job.request.expiresAt) {
    return job;
  }
  const cancelled = cancelJob(job, nowMs, "expired");
  if ("ok" in cancelled && cancelled.ok === false) {
    return job;
  }
  return cancelled as BrowserJob;
}

export interface LateReceipt {
  readonly attemptId: string;
  readonly recorded: boolean;
  readonly detail: string;
}

/**
 * Record a late read-only result for an in-flight attempt after
 * cancellation. The observation is preserved as evidence and the attempt is
 * marked, but the job stays cancelled and no new work is authorized.
 */
export async function recordLateObservation(
  job: BrowserJob,
  attemptId: string,
  envelope: unknown,
  signature: unknown,
  callbacks: CallbackVerifier,
): Promise<{ readonly job: BrowserJob; readonly receipt: LateReceipt } | Decision> {
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
  const verified = callbacks.verify(envelope, signature, job.nextObservationVersion);
  if (!verified.ok) {
    return denied("bad-signature", `${verified.reason}: ${verified.detail}`);
  }
  const observation = verified.envelope.observation;
  if (observation.jobId !== job.request.jobId || observation.attemptId !== attemptId) {
    return denied("unknown-callback", "late observation is bound to another job or attempt");
  }
  const settled: AttemptRecord = Object.freeze({
    ...attempt,
    state: "observedSuccess" as AttemptState,
    observation,
    lateResult: true,
  });
  const next: BrowserJob = Object.freeze({
    ...replaceAttempt(job, settled),
    nextObservationVersion: job.nextObservationVersion + 1,
    lateResults: Object.freeze([...job.lateResults, observation]),
  });
  return {
    job: next,
    receipt: { attemptId, recorded: true, detail: "late result preserved as evidence; job remains cancelled" },
  };
}

export interface IndependentCheck {
  readonly checker: "independent" | "self";
  readonly observedUrl: string;
  readonly matches: boolean;
}

/**
 * Apply an independent result check. Only a separate independent check that
 * matches the recorded observation verifies an outcome; self-reported
 * success stays unverified and can never complete the job.
 */
export function applyIndependentCheck(
  job: BrowserJob,
  attemptId: string,
  check: IndependentCheck,
  nowMs: number,
): BrowserJob | Decision {
  const attempt = job.attempts.find((item) => item.attemptId === attemptId);
  if (attempt === undefined || attempt.observation === undefined) {
    return denied("unknown-callback", `attempt "${attemptId}" has no recorded observation`);
  }
  if (attempt.state !== "observedSuccess") {
    return denied("unverified", `attempt "${attemptId}" did not succeed`);
  }
  if (check.checker !== "independent" || !check.matches || check.observedUrl !== attempt.observation.url) {
    return denied("unverified", "outcome lacks a matching independent check");
  }
  const outcome: VerifiedOutcome = Object.freeze({
    attemptId,
    operationId: attempt.operationId,
    url: attempt.observation.url,
    checkedAtMs: nowMs,
  });
  return Object.freeze({
    ...replaceAttempt(job, { ...attempt, verified: true }),
    verifiedOutcomes: Object.freeze([...job.verifiedOutcomes, outcome]),
  });
}

/** Complete a job only with a verified outcome and no unsettled attempts. */
export function tryComplete(job: BrowserJob): BrowserJob | Decision {
  if (job.verifiedOutcomes.length === 0) {
    return denied("unverified", "completion needs at least one independently verified outcome");
  }
  for (const attempt of job.attempts) {
    if (attempt.state === "prepared" || attempt.state === "dispatching" || attempt.state === "outcomeUnknown") {
      return denied("pending-attempts", `attempt "${attempt.attemptId}" is still unsettled`);
    }
  }
  if (job.state !== "running" && job.state !== "partial" && job.state !== "waitingForSupplier" && job.state !== "waitingForUser") {
    return terminalDenial(job.state);
  }
  return Object.freeze({ ...job, state: "completed" as JobState });
}

/**
 * Change strategy after weak progress: keep every verified outcome and
 * recorded observation, reset the no-progress counter, and continue in a
 * new operation epoch. Blocked operations stay blocked in the new epoch.
 */
export function changeStrategy(job: BrowserJob, reason: string): BrowserJob | Decision {
  void reason;
  if (job.state !== "running" && job.state !== "partial" && job.state !== "failed") {
    return denied("invalid-transition", `cannot change strategy from ${job.state}`);
  }
  return Object.freeze({
    ...job,
    state: "running" as JobState,
    epoch: job.epoch + 1,
    consecutiveNoProgress: 0,
  });
}
