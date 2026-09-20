// Authoritative controlled driver for browser-job execution.
//
// The pure job primitives (authorize/prepare/settle) never invoke a
// transport. This driver is the only path that does: it issues single-use,
// immutable operation claims bound to one job/organization/project/grant/
// input/lease/catalog/destination/target/document/request digest, holds the
// authoritative job versions, and consumes each claim with a
// compare-and-set commit immediately before external execution. Duplicate,
// cross-job, released-lease, or exact-expiry dispatches are refused with
// zero transport calls. After the await, settlement applies to the latest
// authoritative version, so cancellation and expiry are never overwritten
// and late outcomes are preserved on the settled job.
//
// Controlled proof only: in-memory maps stand in for the eventual durable
// execution store (no Convex transactions, crash recovery, or hosted
// sessions are claimed). Transports are injected; no network calls happen here.

import type {
  BrowserJobRequest,
  Decision,
  Denial,
  ObservedTarget,
} from "./types.ts";
import { denied, isDenial } from "./types.ts";
import type { CallbackExpectation, NonceStore } from "./signing.ts";
import { computeRequestDigest, verifyCallback } from "./signing.ts";
import { createMemoryNonceStore } from "./signing.ts";
import type { LeaseContext, SessionLease, SessionRegistry } from "./sessions.ts";
import { createSessionRegistry } from "./sessions.ts";
import type {
  AttemptRecord,
  BrowserJob,
  CallbackVerifier,
  DispatchReceipt,
  IndependentCheck,
  StepClaim,
  StepTransport,
  TransportInput,
  TransportResult,
} from "./jobs.ts";
import {
  applyIndependentCheck,
  authorizeStep,
  cancelJob,
  changeStrategy,
  createJob,
  fenceExpired,
  prepareAttempt,
  quarantinePolicyRejection,
  recordLateObservation,
  settleAttempt,
  tryComplete,
} from "./jobs.ts";
import { checkTarget, validateDestination } from "./policy.ts";
import { parseJobRequest, parseObservation } from "./validation.ts";

/** Default per-step transport deadline for the controlled driver. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/** ADR-0004 active-execution ceiling: 15 minutes from job creation. */
export const ACTIVE_JOB_CEILING_MS = 15 * 60 * 1_000;

/**
 * Bounded reconciliation horizon after the execution cutoff: an authenticated
 * in-flight result may still settle once within this window past claim
 * expiry while the job stays fenced. Execution permission ends at claim
 * expiry; reconciliation permission ends at claim expiry plus this window.
 * Controlled proof only; all values are synthetic test clocks.
 */
export const RECONCILIATION_WINDOW_MS = 5 * 60 * 1_000;

function activeCeilingAt(job: BrowserJob): number {
  return job.createdAtMs + ACTIVE_JOB_CEILING_MS;
}

export interface IssuedClaim {
  readonly claimId: string;
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly grantVersion: string;
  readonly inputVersion: string;
  readonly leaseId: string;
  readonly leaseHandle: string;
  readonly operationCatalogVersion: string;
  readonly operationId: string;
  readonly destination: string | undefined;
  readonly redirectHops: readonly string[];
  readonly targetId: string | undefined;
  readonly documentVersion: string | undefined;
  readonly requestDigest: string;
  readonly callbackNonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly viaRecovery: boolean;
}

export interface DriverAuthorizeInput {
  readonly jobId: string;
  readonly nowMs: number;
  readonly operationId: string;
  readonly viaRecovery: boolean;
  readonly sessionHandle: string;
  readonly destination?: string;
  readonly redirectHops?: readonly string[];
  readonly targetId?: string;
  readonly currentTargets?: readonly ObservedTarget[];
  readonly currentDocumentVersion?: string;
}

export interface DriverDispatchOptions {
  readonly nowMs: number;
  readonly timeoutMs?: number;
  readonly currentTargets?: readonly ObservedTarget[];
  readonly currentDocumentVersion?: string;
}

interface ClaimEntry {
  readonly claim: IssuedClaim;
  used: boolean;
}

interface AttemptExpectation {
  readonly nonce: string;
  readonly requestDigest: string;
  readonly version: number;
  /** Bounded reconciliation horizon (execution cutoff + window). */
  readonly validUntilMs: number;
  /** Execution cutoff (claim expiry) for fencing decisions. */
  readonly claimExpiryMs: number;
}

export interface ControlledDriverOptions {
  readonly stepTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "transport failed";
}

/**
 * One absolute execution cutoff for a dispatch: the earliest of the per-step
 * timeout budget, the claim expiry, the job expiry, the signed-request lease
 * expiry, and the 15-minute active ceiling. The deadline timer is scheduled
 * against this single cutoff, so an early timer wake cannot slip under an
 * authority deadline. Controlled proof only; all inputs are logical clocks.
 */
export function computeExecutionCutoff(input: {
  readonly nowMs: number;
  readonly timeoutMs: number | undefined;
  readonly stepTimeoutMs: number;
  readonly claimExpiryMs: number;
  readonly jobExpiryMs: number;
  readonly requestLeaseExpiryMs: number;
  readonly ceilingAtMs: number;
}): number {
  const stepBudget = Math.max(0, input.timeoutMs ?? input.stepTimeoutMs);
  return Math.min(
    input.nowMs + stepBudget,
    input.claimExpiryMs,
    input.jobExpiryMs,
    input.requestLeaseExpiryMs,
    input.ceilingAtMs,
  );
}

export class ControlledDriver {
  private readonly secret: string;
  private readonly sessions: SessionRegistry;
  private readonly nonces: NonceStore;
  private readonly stepTimeoutMs: number;
  private readonly requests = new Map<string, { readonly request: BrowserJobRequest; readonly digest: string }>();
  private readonly jobs = new Map<string, BrowserJob>();
  private readonly claims = new Map<string, ClaimEntry>();
  private readonly expectations = new Map<string, AttemptExpectation>();
  private readonly leases = new Map<string, string>();
  private readonly everAcquired = new Set<string>();
  private claimSequence = 0;

  constructor(secret: string, options?: ControlledDriverOptions, sessions?: SessionRegistry, nonces?: NonceStore) {
    if (secret.length === 0) {
      throw new TypeError("driver secret must not be empty");
    }
    this.secret = secret;
    this.stepTimeoutMs = options?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.sessions = sessions ?? createSessionRegistry();
    this.nonces = nonces ?? createMemoryNonceStore();
  }

  /** Register one authorized request. A duplicate jobId is a conflict. */
  registerJob(payload: unknown, nowMs: number, requiredOutputs: unknown = []): string | Denial {
    let request: BrowserJobRequest;
    try {
      request = parseJobRequest(payload);
    } catch (error) {
      return denied("invalid-transition", error instanceof Error ? error.message : "invalid request");
    }
    if (this.jobs.has(request.jobId)) {
      return denied("conflict", `job "${request.jobId}" is already registered`);
    }
    const digest = computeRequestDigest(this.secret, request);
    this.requests.set(request.jobId, { request, digest });
    this.jobs.set(request.jobId, createJob(request, nowMs, requiredOutputs));
    return request.jobId;
  }

  snapshot(jobId: string): BrowserJob | undefined {
    return this.jobs.get(jobId);
  }

  requestDigestOf(jobId: string): string | undefined {
    return this.requests.get(jobId)?.digest;
  }

  /** Acquire the session lease that later authorizations must present. */
  acquireLease(
    jobId: string,
    spec: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly leaseId: string;
      readonly expiresAtMs: number;
      readonly guest: boolean;
    },
    nowMs: number,
  ): SessionLease | Denial {
    const record = this.requests.get(jobId);
    const job = this.jobs.get(jobId);
    if (record === undefined || job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    // Terminal acquisition fails closed: completed/failed/cancelled jobs can
    // never mint a fresh active session. Waiting jobs must use the authorized
    // resume path (reacquireLease), never a fresh acquire.
    if (job.state !== "queued" && job.state !== "running") {
      return denied("lease-invalid", `cannot acquire a session for a ${job.state} job; use the authorized resume path`);
    }
    if (this.everAcquired.has(jobId)) {
      return denied(
        "lease-invalid",
        `job "${jobId}" already holds or held its authorized lease; use reacquireLease for the authorized resume path`,
      );
    }
    if (spec.organizationId !== record.request.organizationId || spec.projectId !== record.request.projectId) {
      return denied("lease-invalid", "lease triple does not match the registered job");
    }
    // Request-bound lease authority: the initial acquisition must present the
    // exact lease identity authorized by the signed request, and must not
    // extend beyond its expiry. A replacement or extended lease requires a new
    // authorized request/version transition (see reacquireLease for the
    // waiting-resume path), never a caller-supplied spec.
    if (spec.leaseId !== record.request.sessionLease.leaseId) {
      return denied(
        "lease-invalid",
        `lease "${spec.leaseId}" does not match the authorized request lease "${record.request.sessionLease.leaseId}"; a replacement requires a new authorized request`,
      );
    }
    if (spec.expiresAtMs > record.request.sessionLease.expiresAtMs) {
      return denied(
        "lease-invalid",
        `lease expiry ${spec.expiresAtMs} exceeds the authorized request lease expiry ${record.request.sessionLease.expiresAtMs}; an extension requires a new authorized request`,
      );
    }
    const lease = this.sessions.acquire({ ...spec, jobId }, nowMs);
    if (isDenial(lease)) {
      return lease;
    }
    this.leases.set(jobId, lease.handle);
    this.everAcquired.add(jobId);
    return lease;
  }

  releaseLease(jobId: string): Decision {
    const handle = this.leases.get(jobId);
    const record = this.requests.get(jobId);
    if (handle === undefined || record === undefined) {
      return denied("lease-invalid", `job "${jobId}" holds no tracked lease`);
    }
    const context: LeaseContext = {
      organizationId: record.request.organizationId,
      projectId: record.request.projectId,
      jobId,
    };
    const result = this.sessions.release(handle, context);
    this.leases.delete(jobId);
    return result;
  }

  /** Reacquire after an authorized resume; denied on terminal/cancelled/paused jobs. */
  reacquireLease(
    jobId: string,
    spec: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly leaseId: string;
      readonly expiresAtMs: number;
      readonly guest: boolean;
    },
    nowMs: number,
  ): SessionLease | Denial {
    const job = this.jobs.get(jobId);
    const record = this.requests.get(jobId);
    if (job === undefined || record === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    if (job.state !== "queued" && job.state !== "running" && job.state !== "waitingForSupplier" && job.state !== "waitingForUser") {
      return denied("lease-invalid", `cannot reacquire a session for a ${job.state} job`);
    }
    if (spec.organizationId !== record.request.organizationId || spec.projectId !== record.request.projectId) {
      return denied("lease-invalid", "lease triple does not match the registered job");
    }
    // Authorized resume path: only a job that previously held its
    // request-bound lease may mint a fresh opaque handle, and the handle must
    // always carry the SAME lease identity authorized by the signed request.
    // A replacement lease identity requires a recorded authorized
    // request/version transition (a new registration), never a public
    // reacquisition call: rotating "authorized" to "replacement" on a running
    // job without waiting or new authority is denied. Handle rotation (new
    // sess_* handle, same leaseId) is the only permitted reacquire shape.
    if (!this.everAcquired.has(jobId)) {
      return denied(
        "lease-invalid",
        `job "${jobId}" never held its authorized lease; acquire the authorized request lease first`,
      );
    }
    if (spec.leaseId !== record.request.sessionLease.leaseId) {
      return denied(
        "lease-invalid",
        `lease "${spec.leaseId}" does not match the authorized request lease "${record.request.sessionLease.leaseId}"; a replacement identity requires a new authorized request/version`,
      );
    }
    if (spec.expiresAtMs > record.request.sessionLease.expiresAtMs) {
      return denied(
        "lease-invalid",
        `lease expiry ${spec.expiresAtMs} exceeds the authorized request lease expiry ${record.request.sessionLease.expiresAtMs}`,
      );
    }
    const lease = this.sessions.acquire({ ...spec, jobId }, nowMs);
    if (isDenial(lease)) {
      return lease;
    }
    this.leases.set(jobId, lease.handle);
    this.everAcquired.add(jobId);
    return lease;
  }

  private leaseContext(jobId: string): LeaseContext | undefined {
    const record = this.requests.get(jobId);
    if (record === undefined) {
      return undefined;
    }
    return { organizationId: record.request.organizationId, projectId: record.request.projectId, jobId };
  }

  /**
   * Issue one single-use operation claim after full authorization: job
   * state, exact expiry, request lease expiry, live registry lease bound to
   * this job's triple, catalog, budget, operation-specific inputs, and
   * destination policy.
   */
  authorize(input: DriverAuthorizeInput): IssuedClaim | Denial {
    const job = this.jobs.get(input.jobId);
    const record = this.requests.get(input.jobId);
    if (job === undefined || record === undefined) {
      return denied("unknown-job", `job "${input.jobId}" is not registered`);
    }
    // ADR-0004 15-minute active-execution ceiling: no new claims past it.
    if (input.nowMs >= activeCeilingAt(job)) {
      this.expire(input.jobId, input.nowMs);
      return denied("job-expired", "job reached the 15-minute active-execution ceiling");
    }
    // Mandatory request-lease freshness at authorize time (authorizeStep also
    // enforces it, but the driver rechecks the authoritative request record).
    // A reached request-lease deadline uses the same truthful fence/release
    // transition as dispatch: the job is fenced so no executable session
    // remains tracked past authority.
    if (input.nowMs >= record.request.sessionLease.expiresAtMs) {
      this.expire(input.jobId, input.nowMs);
      return denied("lease-invalid", "the authorized request lease reached its expiry");
    }
    // Mandatory job-expiry freshness at authorize time: a reached job deadline
    // fences through the single transition before returning the denial, so a
    // running job authorized exactly at its expiry cannot stay running with a
    // tracked and registry-live session.
    if (input.nowMs >= job.request.expiresAt) {
      this.expire(input.jobId, input.nowMs);
      return denied("job-expired", "job reached its expiry; fenced with session release");
    }
    const context = this.leaseContext(input.jobId) as LeaseContext;
    const live = this.sessions.resolve(input.sessionHandle, context, input.nowMs);
    if (isDenial(live)) {
      // A reached acquired-lease deadline on the currently tracked handle
      // fences through the single transition before denying: the inspected
      // record exposes the deadline without widening any authority.
      // Unknown, cross-context, already-released, or stale untracked handles
      // keep the documented non-active invariant below and never fence while
      // another valid tracked session is active.
      const inspected = this.sessions.inspect(input.sessionHandle);
      if (
        inspected !== undefined &&
        this.leases.get(input.jobId) === input.sessionHandle &&
        inspected.organizationId === context.organizationId &&
        inspected.projectId === context.projectId &&
        inspected.jobId === input.jobId &&
        inspected.leaseId === record.request.sessionLease.leaseId &&
        !inspected.released &&
        input.nowMs >= inspected.expiresAtMs
      ) {
        this.expire(input.jobId, input.nowMs, undefined, inspected.expiresAtMs);
        return denied(
          "lease-invalid",
          `session lease "${inspected.leaseId}" reached its expiry; fenced with session release`,
        );
      }
      // Non-active invariant (documented, not fenced): any other failed
      // resolve means no live session exists for this handle — unknown
      // handles, cross-context handles, released handles, and stale untracked
      // handles while another valid tracked session is active — so the denial
      // leaves state untouched. Waiting jobs hold no session by design, and
      // authorizing must not convert a waiting job into cancelled merely for
      // presenting a stale handle.
      return denied("lease-invalid", "no live session lease for this organization/project/job");
    }
    const lease: SessionLease = live as SessionLease;
    const checked = authorizeStep(job, {
      nowMs: input.nowMs,
      operationId: input.operationId,
      viaRecovery: input.viaRecovery,
      leaseOk: true,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
      ...(input.redirectHops === undefined ? {} : { redirectHops: input.redirectHops }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.currentTargets === undefined ? {} : { currentTargets: input.currentTargets }),
      ...(input.currentDocumentVersion === undefined ? {} : { currentDocumentVersion: input.currentDocumentVersion }),
    });
    if ("ok" in checked) {
      const denial = checked as Denial;
      if (denial.ok === false) {
        // Defensive: any job-expiry denial from the static checks fences
        // through the single transition (the pre-check above already covers
        // the live path).
        if (denial.reason === "job-expired") {
          this.expire(input.jobId, input.nowMs);
        }
        return denial;
      }
    }
    const authorized = checked as { readonly ok: true; readonly claim: StepClaim };
    this.claimSequence += 1;
    const claimId = `claim_${input.jobId}_${this.claimSequence}`;
    // The claim is bounded by every relevant expiry: the job expiry, the
    // authoritative signed-request lease expiry, and the live registry lease
    // expiry. A replacement/extended registry lease can never widen the claim
    // beyond the authorized request lease.
    const expiresAtMs = Math.min(
      job.request.expiresAt,
      record.request.sessionLease.expiresAtMs,
      lease.expiresAtMs,
      activeCeilingAt(job),
    );
    const claim: IssuedClaim = Object.freeze({
      claimId,
      jobId: input.jobId,
      organizationId: record.request.organizationId,
      projectId: record.request.projectId,
      grantVersion: record.request.grantVersion,
      inputVersion: record.request.inputVersion,
      leaseId: lease.leaseId,
      leaseHandle: lease.handle,
      operationCatalogVersion: record.request.operationCatalogVersion,
      operationId: authorized.claim.operationId,
      destination: authorized.claim.destination,
      redirectHops: Object.freeze([...(input.redirectHops ?? [])]),
      targetId: authorized.claim.targetId,
      documentVersion: input.currentDocumentVersion,
      requestDigest: record.digest,
      callbackNonce: `cb_${claimId}`,
      issuedAtMs: input.nowMs,
      expiresAtMs,
      viaRecovery: authorized.claim.viaRecovery,
    });
    this.claims.set(claimId, { claim, used: false });
    return claim;
  }

  private verifierFor(jobId: string, attemptId: string, nowMs: number): CallbackVerifier {
    return {
      verify: (envelope: unknown, signature: unknown, _version: number) => {
        const expectation = this.expectations.get(`${jobId}\u0000${attemptId}`);
        if (expectation === undefined) {
          return { ok: false, reason: "unknown-callback", detail: "no callback was issued for this attempt" };
        }
        const full: CallbackExpectation = {
          nonce: expectation.nonce,
          requestDigest: expectation.requestDigest,
          jobId,
          attemptId,
          version: expectation.version,
          validUntilMs: expectation.validUntilMs,
          nowMs,
        };
        return verifyCallback(this.secret, this.nonces, envelope, signature, full);
      },
    };
  }

  private trackLeaseRelease(job: BrowserJob): void {
    // Every state that cannot actively execute releases its active session:
    // waiting, terminal (completed/failed/cancelled), paused, and partial.
    // Only queued/running may hold an active browser session.
    if (job.state !== "queued" && job.state !== "running" && this.leases.has(job.request.jobId)) {
      this.releaseLease(job.request.jobId);
    }
  }

  /**
   * Dispatch one issued claim. The commit consumes the single-use claim,
   * rechecks state/expiry/lease/budget/target freshness against the latest
   * authoritative version, and reserves a unique attempt ordinal before any
   * transport call; settlement then applies to the latest version so
   * cancellation and expiry survive the await.
   *
   * Target effects require mandatory dispatch-time freshness evidence;
   * expiry uses a progressing authoritative clock (logical start plus real
   * elapsed time) and fences at job/lease/claim/ceiling deadlines, releasing
   * the active session. Synchronous transport throws use the same typed
   * unknown-outcome path with timer cleanup.
   */
  async dispatch(
    jobId: string,
    claimId: string,
    transport: StepTransport,
    options: DriverDispatchOptions,
  ): Promise<{ readonly job: BrowserJob; readonly receipt: DispatchReceipt }> {
    const refused = (detail: string): { readonly job: BrowserJob; readonly receipt: DispatchReceipt } => {
      const job = this.jobs.get(jobId);
      if (job === undefined) {
        throw new Error(`job "${jobId}" is not registered`);
      }
      return { job, receipt: { attemptId: "", outcome: "claim-refused", detail } };
    };
    const record = this.requests.get(jobId);
    const job = this.jobs.get(jobId);
    if (job === undefined || record === undefined) {
      throw new Error(`job "${jobId}" is not registered`);
    }
    const entry = this.claims.get(claimId);
    if (entry === undefined || entry.claim.jobId !== jobId) {
      return refused("unknown claim for this job; zero transport calls");
    }
    if (entry.used) {
      return refused(`claim "${claimId}" was already consumed; zero transport calls`);
    }
    if (job.state !== "queued" && job.state !== "running") {
      return refused(`job is ${job.state}; no new work may dispatch`);
    }
    // Request-bound lease authority is rechecked at dispatch: the signed
    // request lease expiry participates independently of the acquired lease.
    if (
      options.nowMs >= job.request.expiresAt ||
      options.nowMs >= entry.claim.expiresAtMs ||
      options.nowMs >= record.request.sessionLease.expiresAtMs ||
      options.nowMs >= activeCeilingAt(job)
    ) {
      this.expire(jobId, options.nowMs, entry.claim.expiresAtMs);
      return refused("job reached its expiry; fenced with zero transport calls");
    }
    const context = this.leaseContext(jobId) as LeaseContext;
    const live = this.sessions.resolve(entry.claim.leaseHandle, context, options.nowMs);
    if ("ok" in live) {
      return refused("session lease is no longer live; zero transport calls");
    }
    if (job.stepsUsed >= job.request.maximumSteps) {
      return refused(`step budget of ${job.request.maximumSteps} is exhausted`);
    }
    // Mandatory dispatch freshness for target effects: absent, stale, missing
    // or occluded target evidence produces zero effect execution.
    if (entry.claim.targetId !== undefined) {
      if (options.currentTargets === undefined || options.currentDocumentVersion === undefined) {
        return refused("target effect requires current observed targets and document version; re-observe before effect execution");
      }
      if (
        entry.claim.documentVersion !== undefined &&
        options.currentDocumentVersion !== entry.claim.documentVersion
      ) {
        return refused("document changed since authorization; re-observe before effect execution");
      }
      const recheck = checkTarget(options.currentTargets, options.currentDocumentVersion, entry.claim.targetId);
      if (!recheck.ok) {
        return refused(`target recheck failed: ${recheck.detail}`);
      }
    }

    const prepared = prepareAttempt(job, {
      operationId: entry.claim.operationId,
      destination: entry.claim.destination,
      targetId: entry.claim.targetId,
      viaRecovery: entry.claim.viaRecovery,
    }, options.nowMs);
    if ("ok" in prepared) {
      const denial = prepared as Denial;
      if (denial.ok === false) {
        return refused(`${denial.reason}: ${denial.detail}`);
      }
    }
    const { job: claimed, attemptId } = prepared as { readonly job: BrowserJob; readonly attemptId: string };
    entry.used = true;
    // Execution permission ends at claim expiry; reconciliation permission
    // extends a bounded window past it so one authenticated in-flight outcome
    // can still settle on the fenced job. Nonce markers are retained through
    // the reconciliation horizon (see signing.ts retention).
    this.expectations.set(`${jobId}\u0000${attemptId}`, {
      nonce: entry.claim.callbackNonce,
      requestDigest: entry.claim.requestDigest,
      version: claimed.nextObservationVersion,
      validUntilMs: entry.claim.expiresAtMs + RECONCILIATION_WINDOW_MS,
      claimExpiryMs: entry.claim.expiresAtMs,
    });
    this.jobs.set(jobId, claimed);

    const input: TransportInput = {
      jobId,
      attemptId,
      operationId: entry.claim.operationId,
      destination: entry.claim.destination,
      targetId: entry.claim.targetId,
      documentVersion: entry.claim.documentVersion,
      callbackNonce: entry.claim.callbackNonce,
      requestDigest: entry.claim.requestDigest,
    };
    // Monotonic elapsed time: performance.now() never rolls back, so a
    // wall-clock adjustment cannot conceal an elapsed deadline. The
    // authoritative effective time is the logical dispatch start plus real
    // monotonic elapsed time, covering synchronous event-loop blocking that
    // no timer callback can observe. Transport completions and errors that
    // beat the timer use this clock only and never advance it to the cutoff.
    const monoStart = performance.now();
    const effectiveNow = (): number => options.nowMs + Math.max(0, performance.now() - monoStart);
    // One absolute execution cutoff: the earliest of the per-step timeout,
    // claim expiry, job expiry, signed-request lease expiry, and the active
    // ceiling. The deadline timer is scheduled against it.
    const executionCutoffMs = computeExecutionCutoff({
      nowMs: options.nowMs,
      timeoutMs: options.timeoutMs,
      stepTimeoutMs: this.stepTimeoutMs,
      claimExpiryMs: entry.claim.expiresAtMs,
      jobExpiryMs: job.request.expiresAt,
      requestLeaseExpiryMs: record.request.sessionLease.expiresAtMs,
      ceilingAtMs: activeCeilingAt(claimed),
    });
    const isExpiredAt = (atMs: number): boolean => {
      const latest = this.jobs.get(jobId) as BrowserJob;
      const rec = this.requests.get(jobId);
      if (rec === undefined) {
        return true;
      }
      return (
        atMs >= latest.request.expiresAt ||
        atMs >= entry.claim.expiresAtMs ||
        atMs >= rec.request.sessionLease.expiresAtMs ||
        atMs >= activeCeilingAt(latest)
      );
    };
    const markUnknown = (id: string): BrowserJob => {
      const latest = this.jobs.get(jobId) as BrowserJob;
      const stranded = latest.attempts.find((item) => item.attemptId === id) as AttemptRecord;
      const current = Object.freeze({
        ...latest,
        attempts: Object.freeze(latest.attempts.map((item) =>
          item.attemptId === id ? { ...stranded, state: "outcomeUnknown" as const } : item,
        )),
      });
      this.jobs.set(jobId, current);
      return current;
    };
    const controller = new AbortController();
    const timerDelayMs = Math.max(0, executionCutoffMs - options.nowMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ readonly timedOut: true; readonly cutoffMs: number }>((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        controller.abort();
        resolve({ timedOut: true, cutoffMs: executionCutoffMs });
      }, timerDelayMs);
    });
    let transportPromise: Promise<TransportResult>;
    try {
      transportPromise = transport.execute(input, controller.signal);
    } catch (error) {
      // Synchronous invocation errors use the same typed unknown-outcome path
      // with timer cleanup; the claimed attempt is preserved and no automatic
      // redispatch occurs.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const atMs = effectiveNow();
      if (isExpiredAt(atMs)) {
        this.expire(jobId, atMs, entry.claim.expiresAtMs);
        const fenced = this.jobs.get(jobId) as BrowserJob;
        // Preserve the claimed attempt as unknown on the fenced job.
        const stranded = fenced.attempts.find((item) => item.attemptId === attemptId);
        if (stranded !== undefined && (stranded.state === "dispatching" || stranded.state === "outcomeUnknown")) {
          this.jobs.set(jobId, Object.freeze({
            ...fenced,
            attempts: Object.freeze(fenced.attempts.map((item) =>
              item.attemptId === attemptId ? { ...item, state: "outcomeUnknown" as const } : item,
            )),
          }));
        }
        const current = this.jobs.get(jobId) as BrowserJob;
        return { job: current, receipt: { attemptId, outcome: "transport-unknown", detail: errorMessage(error) } };
      }
      const current = markUnknown(attemptId);
      return { job: current, receipt: { attemptId, outcome: "transport-unknown", detail: errorMessage(error) } };
    }
    // The absolute step deadline is enforced after every await below
    // (transport result, rejection, or timer): effectiveNow() covers
    // synchronous event-loop blocking that no timer callback can observe, so
    // an overrun is never presented as on-time success.
    const raced = await Promise.race([
      transportPromise.then(
        (result) => ({ result }),
        (error: unknown) => ({ transportError: errorMessage(error) }),
      ),
      timeoutPromise,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const settleLateResult = (late: TransportResult, baseMs: number): void => {
      void this.settleTransportResult(jobId, attemptId, late.envelope, late.signature, Math.max(baseMs, effectiveNow()));
    };
    if ("timedOut" in raced) {
      // The deadline timer resolved: treat logical time as at least the
      // scheduled cutoff, even if the monotonic clock reports a
      // sub-millisecond early wake. This makes authority-deadline fencing
      // deterministic under timer imprecision.
      const atMs = Math.max(effectiveNow(), raced.cutoffMs);
      if (isExpiredAt(atMs)) {
        // Reached job/lease/claim/ceiling expiry: fence, release the session,
        // and retain any late outcome on the fenced job.
        this.expire(jobId, atMs, entry.claim.expiresAtMs);
        const fencedAt = effectiveNow();
        void transportPromise.then(
          (late) => settleLateResult(late, Math.max(atMs, fencedAt)),
          () => undefined,
        );
        const current = this.jobs.get(jobId) as BrowserJob;
        return { job: current, receipt: { attemptId, outcome: "transport-timeout", detail: "transport deadline elapsed at job expiry; fenced with lease release" } };
      }
      const current = markUnknown(attemptId);
      const timeoutAt = atMs;
      void transportPromise.then(
        (late) => settleLateResult(late, timeoutAt),
        () => undefined,
      );
      return { job: current, receipt: { attemptId, outcome: "transport-timeout", detail: "transport deadline elapsed; attempt marked unknown" } };
    }
    if ("transportError" in raced) {
      const atMs = effectiveNow();
      if (isExpiredAt(atMs)) {
        this.expire(jobId, atMs, entry.claim.expiresAtMs);
        const fenced = this.jobs.get(jobId) as BrowserJob;
        const stranded = fenced.attempts.find((item) => item.attemptId === attemptId);
        if (stranded !== undefined && (stranded.state === "dispatching" || stranded.state === "outcomeUnknown")) {
          this.jobs.set(jobId, Object.freeze({
            ...fenced,
            attempts: Object.freeze(fenced.attempts.map((item) =>
              item.attemptId === attemptId ? { ...item, state: "outcomeUnknown" as const } : item,
            )),
          }));
        }
        const current = this.jobs.get(jobId) as BrowserJob;
        return { job: current, receipt: { attemptId, outcome: "transport-unknown", detail: raced.transportError } };
      }
      const current = markUnknown(attemptId);
      return { job: current, receipt: { attemptId, outcome: "transport-unknown", detail: raced.transportError } };
    }
    const arrivedAt = effectiveNow();
    if (isExpiredAt(arrivedAt)) {
      // Result arrived after an authority deadline (including synchronous
      // overrun past lease/claim/ceiling): fence first, then reconcile the
      // authenticated outcome once on the fenced job without reopening it.
      return this.settleTransportResult(jobId, attemptId, raced.result.envelope, raced.result.signature, arrivedAt);
    }
    if (arrivedAt >= executionCutoffMs) {
      // Past the absolute execution cutoff but within authority (so the cutoff
      // was the per-step budget): not an on-time success. Mark unknown,
      // report timeout, and reconcile the received evidence once without
      // presenting it as on-time execution. Logical time is NOT advanced to
      // the cutoff here — the transport beat the timer, so effectiveNow rules.
      const current = markUnknown(attemptId);
      const late = raced.result;
      void this.settleTransportResult(jobId, attemptId, late.envelope, late.signature, arrivedAt);
      return { job: current, receipt: { attemptId, outcome: "transport-timeout", detail: "transport exceeded its step deadline; result reconciled separately" } };
    }
    return this.settleTransportResult(jobId, attemptId, raced.result.envelope, raced.result.signature, arrivedAt);
  }

  private settleTransportResult(
    jobId: string,
    attemptId: string,
    envelope: unknown,
    signature: unknown,
    nowMs: number,
  ): { readonly job: BrowserJob; readonly receipt: DispatchReceipt } {
    let latest = this.jobs.get(jobId) as BrowserJob;
    const rec = this.requests.get(jobId);
    const expectation = this.expectations.get(`${jobId}\u0000${attemptId}`);
    const claimExpiryMs = expectation?.claimExpiryMs;
    if (rec !== undefined) {
      if (
        nowMs >= latest.request.expiresAt ||
        nowMs >= rec.request.sessionLease.expiresAtMs ||
        nowMs >= activeCeilingAt(latest) ||
        (claimExpiryMs !== undefined && nowMs >= claimExpiryMs)
      ) {
        this.expire(jobId, nowMs, claimExpiryMs);
        latest = this.jobs.get(jobId) as BrowserJob;
      }
    } else if (nowMs >= latest.request.expiresAt) {
      this.expire(jobId, nowMs, claimExpiryMs);
      latest = this.jobs.get(jobId) as BrowserJob;
    }
    if (latest.state === "cancelled") {
      // Shared late policy check BEFORE replay admission: a forbidden late
      // destination is quarantined with its explicit policy reason without
      // consuming the rightful nonce, settling the attempt, or reopening.
      try {
        if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
          const fields = envelope as { readonly [key: string]: unknown };
          try {
            const parsed = parseObservation(fields.observation);
            const destCheck = validateDestination(parsed.url, latest.request.allowedOrigins);
            if (!destCheck.ok) {
              const quarantined = quarantinePolicyRejection(
                latest,
                attemptId,
                destCheck.reason,
                destCheck.detail,
                nowMs,
              );
              this.jobs.set(jobId, quarantined);
              return {
                job: quarantined,
                receipt: { attemptId, outcome: "callback-rejected", detail: `${destCheck.reason}: ${destCheck.detail}` },
              };
            }
          } catch {
            // Unparsable: let recordLateObservation handle it below.
          }
        }
      } catch {
        // Fall through to recordLateObservation.
      }
      const late = recordLateObservation(latest, attemptId, envelope, signature, this.verifierFor(jobId, attemptId, nowMs), nowMs);
      if (isDenial(late)) {
        return { job: latest, receipt: { attemptId, outcome: "callback-rejected", detail: `${late.reason}: ${late.detail}` } };
      }
      const settled = late as { readonly job: BrowserJob; readonly receipt: { readonly recorded: boolean; readonly detail: string } };
      this.jobs.set(jobId, settled.job);
      const attempt = settled.job.attempts.find((item) => item.attemptId === attemptId);
      const truthful = attempt?.state === "observedFailure" ? "observed-failure" as const : "observed-success" as const;
      return { job: settled.job, receipt: { attemptId, outcome: truthful, detail: settled.receipt.detail } };
    }
    const settled = settleAttempt(latest, attemptId, envelope, signature, this.verifierFor(jobId, attemptId, nowMs), nowMs);
    if (isDenial(settled)) {
      return { job: latest, receipt: { attemptId, outcome: "callback-rejected", detail: `${settled.reason}: ${settled.detail}` } };
    }
    const done = settled as { readonly job: BrowserJob; readonly receipt: DispatchReceipt };
    this.jobs.set(jobId, done.job);
    this.trackLeaseRelease(done.job);
    return done;
  }

  cancel(jobId: string, nowMs: number, reason: string): BrowserJob | Denial {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    const next = cancelJob(job, nowMs, reason);
    if ("ok" in next) {
      return next as Denial;
    }
    const cancelled = next as BrowserJob;
    this.jobs.set(jobId, cancelled);
    this.trackLeaseRelease(cancelled);
    return cancelled;
  }

  /**
   * Single fencing transition for every enforced deadline: job expiry, the
   * authoritative signed-request lease expiry, the live/claim expiry and the
   * active-execution ceiling. Fencing cancels active work (including waiting,
   * which must not hold a session past a deadline) and releases the tracked
   * session; unresolved in-flight attempts keep their dispatching state for
   * truthful reconciliation.
   */
  expire(jobId: string, nowMs: number, claimExpiryMs?: number, acquiredExpiryMs?: number): BrowserJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`job "${jobId}" is not registered`);
    }
    const record = this.requests.get(jobId);
    const fenced = fenceExpired(job, nowMs, {
      ...(record === undefined ? {} : { leaseExpiryMs: record.request.sessionLease.expiresAtMs }),
      ...(acquiredExpiryMs === undefined ? {} : { acquiredExpiryMs }),
      ...(claimExpiryMs === undefined ? {} : { claimExpiryMs }),
      ceilingAtMs: activeCeilingAt(job),
    });
    this.jobs.set(jobId, fenced);
    this.trackLeaseRelease(fenced);
    return fenced;
  }

  recordLate(
    jobId: string,
    attemptId: string,
    envelope: unknown,
    signature: unknown,
    nowMs: number,
  ): { readonly job: BrowserJob; readonly recorded: boolean; readonly detail: string } | Denial {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    // Shared late policy check before admission: quarantine the forbidden
    // destination with its explicit reason without consuming the nonce.
    try {
      if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
        const fields = envelope as { readonly [key: string]: unknown };
        try {
          const parsed = parseObservation(fields.observation);
          const destCheck = validateDestination(parsed.url, job.request.allowedOrigins);
          if (!destCheck.ok) {
            const quarantined = quarantinePolicyRejection(job, attemptId, destCheck.reason, destCheck.detail, nowMs);
            this.jobs.set(jobId, quarantined);
            return denied(destCheck.reason, `late observation destination rejected: ${destCheck.detail}`);
          }
        } catch {
          // Unparsable: let recordLateObservation handle it below.
        }
      }
    } catch {
      // Fall through.
    }
    const result = recordLateObservation(job, attemptId, envelope, signature, this.verifierFor(jobId, attemptId, nowMs), nowMs);
    if ("ok" in result) {
      return result as Denial;
    }
    const done = result as { readonly job: BrowserJob; readonly receipt: { readonly recorded: boolean; readonly detail: string } };
    this.jobs.set(jobId, done.job);
    return { job: done.job, recorded: done.receipt.recorded, detail: done.receipt.detail };
  }

  applyCheck(jobId: string, attemptId: string, check: IndependentCheck, nowMs: number): BrowserJob | Denial {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    const next = applyIndependentCheck(job, attemptId, check, nowMs);
    if ("ok" in next) {
      return next as Denial;
    }
    const checked = next as BrowserJob;
    this.jobs.set(jobId, checked);
    return checked;
  }

  complete(jobId: string): BrowserJob | Denial {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    const next = tryComplete(job);
    if ("ok" in next) {
      return next as Denial;
    }
    const completed = next as BrowserJob;
    this.jobs.set(jobId, completed);
    // Terminal release: completed jobs can never actively execute again, so
    // their active session is released while evidence is preserved.
    this.trackLeaseRelease(completed);
    return completed;
  }

  changeStrategy(jobId: string, reason: string): BrowserJob | Denial {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return denied("unknown-job", `job "${jobId}" is not registered`);
    }
    const next = changeStrategy(job, reason);
    if ("ok" in next) {
      return next as Denial;
    }
    const resumed = next as BrowserJob;
    this.jobs.set(jobId, resumed);
    return resumed;
  }

  /** Test hook: the live callback expectation issued for one attempt. */
  expectationFor(jobId: string, attemptId: string): { readonly nonce: string; readonly requestDigest: string; readonly version: number } | undefined {
    return this.expectations.get(`${jobId}\u0000${attemptId}`);
  }

  /** Test hook: the session handle currently tracked for one job. */
  trackedLease(jobId: string): string | undefined {
    return this.leases.get(jobId);
  }

  /** Test hook: the controlled session registry backing this driver. */
  sessionsForTests(): SessionRegistry {
    return this.sessions;
  }
}
