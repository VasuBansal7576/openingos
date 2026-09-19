// Controlled contract tests for the browser-executor boundary.
//
// Every transport is an injected stub, every secret is synthetic, and every
// clock is fixed. No live browser, provider, or network calls; no
// credentials; no claim of deployed D-04 success.

import { describe, expect, it } from "bun:test";
import type {
  AuthorizeInput,
  BrowserJob,
  BrowserObservation,
  CallbackVerifier,
  ClaimedOutcome,
  Decision,
  Denial,
  DenialReason,
  NonceStore,
  ObservedTarget,
  StepClaim,
  StepTransport,
  TransportInput,
  TransportResult,
} from "./index.ts";
import {
  OPERATION_CATALOG_VERSION,
  applyIndependentCheck,
  authorizeOperation,
  authorizeStep,
  cancelJob,
  catalogEntries,
  changeStrategy,
  checkTarget,
  createJob,
  createMemoryNonceStore,
  createSessionRegistry,
  dispatchStep,
  fenceExpired,
  isLeaseDecision,
  parseJobRequest,
  parseObservation,
  prepareAttempt,
  recordLateObservation,
  signJobRequest,
  signObservation,
  tryComplete,
  validateDestination,
  validateNavigation,
  verifyCallback,
  verifyJobRequest,
} from "./index.ts";

const SECRET = "ts-test-synthetic-secret-0001";
const OTHER_SECRET = "ts-test-synthetic-secret-0002";
const NOW = 1_786_500_000_000;
const ORIGINS = Object.freeze(["https://supplier-a.example", "https://supplier-b.example"]);
const GOOD_URL = "https://supplier-a.example/variant-42";

function requestFixture(overrides: { readonly [key: string]: unknown } = {}): unknown {
  return {
    jobId: "job-a",
    organizationId: "org-a",
    projectId: "proj-a",
    grantVersion: "grant-3",
    inputVersion: "input-7",
    allowedOrigins: [...ORIGINS],
    operationCatalogVersion: OPERATION_CATALOG_VERSION,
    sessionLease: { leaseId: "lease-1", expiresAtMs: NOW + 60_000 },
    maximumSteps: 45,
    expiresAt: NOW + 120_000,
    reservationId: "res-1",
    callbackNonce: "req-nonce-1",
    ...overrides,
  };
}

function observationFixture(
  attemptId: string,
  overrides: { readonly [key: string]: unknown } = {},
): { readonly [key: string]: unknown } {
  return {
    jobId: "job-a",
    attemptId,
    observationVersion: 1,
    url: GOOD_URL,
    capturedAt: NOW + 1_000,
    visibleText: "Espresso machine variant 42, EUR 7950 installed",
    observedTargets: [],
    collectedEvidence: [],
    claimedOutcome: "success",
    meteredUsage: { operationsUsed: 1, millisUsed: 500 },
    ...overrides,
  };
}

function targetFixture(targetId: string, documentVersion: string, occluded = false): ObservedTarget {
  return { targetId, documentVersion, occluded };
}

function asDenial(value: unknown): Denial {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const candidate = value as { readonly ok: unknown; readonly reason: unknown; readonly detail: unknown };
    if (
      candidate.ok === false &&
      typeof candidate.reason === "string" &&
      typeof candidate.detail === "string"
    ) {
      return candidate as Denial;
    }
  }
  throw new Error("expected a denial");
}

function mustJob(value: unknown): BrowserJob {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const denial = asDenial(value);
    throw new Error(`expected job, got denial ${denial.reason}: ${denial.detail}`);
  }
  return value as BrowserJob;
}

function mustDenialReason(value: unknown, reason: DenialReason): string {
  const denial = asDenial(value);
  expect(denial.reason).toBe(reason);
  return denial.detail;
}

function setupJob(overrides: { readonly [key: string]: unknown } = {}): BrowserJob {
  return createJob(parseJobRequest(requestFixture(overrides)), NOW);
}

function authorize(
  job: BrowserJob,
  operationId = "readVisibleText",
  extra: Partial<AuthorizeInput> = {},
): { readonly ok: true; readonly claim: StepClaim } | Decision {
  const input: AuthorizeInput = {
    nowMs: NOW,
    operationId,
    viaRecovery: false,
    leaseOk: true,
    ...extra,
  };
  return authorizeStep(job, input);
}

function mustClaim(job: BrowserJob, operationId = "readVisibleText", extra: Partial<AuthorizeInput> = {}): StepClaim {
  const result: unknown = authorize(job, operationId, extra);
  if (typeof result === "object" && result !== null && "claim" in result) {
    return (result as { readonly claim: StepClaim }).claim;
  }
  const denial = asDenial(result);
  throw new Error(`expected claim, got denial ${denial.reason}: ${denial.detail}`);
}

interface StubStep {
  readonly url?: string;
  readonly outcome?: ClaimedOutcome;
  readonly version?: number;
  readonly targets?: readonly ObservedTarget[];
  readonly throws?: boolean;
}

function stubTransport(store: NonceStore, steps: readonly StubStep[], baseVersion: number): {
  readonly transport: StepTransport;
  readonly calls: TransportInput[];
  readonly verifier: CallbackVerifier;
} {
  const calls: TransportInput[] = [];
  let count = 0;
  const verifier: CallbackVerifier = {
    verify: (envelope, signature, expectedVersion) =>
      verifyCallback(SECRET, store, envelope, signature, expectedVersion),
  };
  const transport: StepTransport = {
    async execute(input: TransportInput): Promise<TransportResult> {
      calls.push(input);
      count += 1;
      const step = steps[Math.min(count - 1, steps.length - 1)] as StubStep;
      if (step.throws === true) {
        throw new Error("synthetic transport failure");
      }
      const nonce = `cb-nonce-${count}-${input.attemptId}`;
      const raw = observationFixture(input.attemptId, {
        url: step.url ?? GOOD_URL,
        claimedOutcome: step.outcome ?? "success",
        observationVersion: step.version ?? baseVersion + (count - 1),
        ...(step.targets === undefined ? {} : { observedTargets: step.targets }),
      });
      const observation = parseObservation(raw) as BrowserObservation;
      const signature = signObservation(SECRET, observation, nonce);
      return { envelope: { observation: raw, callbackNonce: nonce }, signature };
    },
  };
  return { transport, calls, verifier };
}

async function dispatch(
  job: BrowserJob,
  claim: StepClaim,
  store: NonceStore,
  steps: readonly StubStep[],
): Promise<{ readonly job: BrowserJob; readonly outcome: string; readonly detail: string; readonly calls: number }> {
  const stub = stubTransport(store, steps, job.nextObservationVersion);
  const result = await dispatchStep(job, claim, stub.transport, stub.verifier, NOW);
  return { job: result.job, outcome: result.receipt.outcome, detail: result.receipt.detail, calls: stub.calls.length };
}

describe("request validation", () => {
  it("accepts a valid job request and freezes it", () => {
    const request = parseJobRequest(requestFixture());
    expect(request.jobId).toBe("job-a");
    expect(request.maximumSteps).toBe(45);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("rejects an empty jobId", () => {
    expect(() => parseJobRequest(requestFixture({ jobId: "  " }))).toThrow();
  });

  it("rejects empty allowed origins", () => {
    expect(() => parseJobRequest(requestFixture({ allowedOrigins: [] }))).toThrow();
  });

  it("rejects a non-https allowed origin", () => {
    expect(() => parseJobRequest(requestFixture({ allowedOrigins: ["http://supplier-a.example"] }))).toThrow();
  });

  it("rejects step budgets outside 1..45", () => {
    expect(() => parseJobRequest(requestFixture({ maximumSteps: 0 }))).toThrow();
    expect(() => parseJobRequest(requestFixture({ maximumSteps: 46 }))).toThrow();
  });

  it("rejects prototype-pollution keys", () => {
    const base = requestFixture() as { readonly [key: string]: unknown };
    const raw = (JSON.stringify(base) as string).replace(/^\{/, '{"__proto__":{"jobId":"evil"},');
    const parsed: unknown = JSON.parse(raw);
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
    expect(() => parseJobRequest(parsed)).toThrow();
  });
});

describe("observation validation", () => {
  it("accepts a valid observation", () => {
    const observation = parseObservation(observationFixture("a_job-a_1"));
    expect(observation.claimedOutcome).toBe("success");
  });

  it("rejects an unknown claimed outcome", () => {
    expect(() => parseObservation(observationFixture("a_job-a_1", { claimedOutcome: "done" }))).toThrow();
  });
});

describe("request signing", () => {
  it("round-trips sign and verify", () => {
    const request = parseJobRequest(requestFixture());
    const signed = signJobRequest(SECRET, request);
    const back = verifyJobRequest(SECRET, requestFixture(), signed.signature);
    expect(back.jobId).toBe("job-a");
  });

  it("rejects a tampered payload", () => {
    const request = parseJobRequest(requestFixture());
    const signed = signJobRequest(SECRET, request);
    expect(() => verifyJobRequest(SECRET, requestFixture({ jobId: "job-b" }), signed.signature)).toThrow();
  });

  it("rejects the wrong secret", () => {
    const request = parseJobRequest(requestFixture());
    const signed = signJobRequest(SECRET, request);
    expect(() => verifyJobRequest(OTHER_SECRET, requestFixture(), signed.signature)).toThrow();
  });
});

describe("callback verification", () => {
  function signedCallback(version: number, nonce: string): { envelope: unknown; signature: unknown } {
    const raw = observationFixture("a_job-a_1", { observationVersion: version });
    const observation = parseObservation(raw);
    const signature = signObservation(SECRET, observation, nonce);
    return { envelope: { observation: raw, callbackNonce: nonce }, signature };
  }

  it("accepts a first valid callback", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedCallback(1, "cb-once-1");
    const result = verifyCallback(SECRET, store, envelope, signature, 1);
    expect(result.ok).toBe(true);
  });

  it("rejects a replayed nonce", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedCallback(1, "cb-once-1");
    expect(verifyCallback(SECRET, store, envelope, signature, 1).ok).toBe(true);
    const replay = verifyCallback(SECRET, store, envelope, signature, 2);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.reason).toBe("replay-detected");
    }
  });

  it("rejects a stale observation version without consuming the nonce", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedCallback(5, "cb-stale-1");
    const stale = verifyCallback(SECRET, store, envelope, signature, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe("stale-callback");
    }
    expect(store.has("cb-stale-1")).toBe(false);
  });

  it("rejects a bad signature", () => {
    const store = createMemoryNonceStore();
    const raw = observationFixture("a_job-a_1", { observationVersion: 1 });
    const observation = parseObservation(raw);
    const bad = signObservation(OTHER_SECRET, observation, "cb-bad-1");
    const result = verifyCallback(SECRET, store, { observation: raw, callbackNonce: "cb-bad-1" }, bad, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("bad-signature");
    }
  });
});

describe("session leases", () => {
  const contextA = { organizationId: "org-a", projectId: "proj-a", jobId: "job-a" };
  const contextB = { organizationId: "org-b", projectId: "proj-b", jobId: "job-b" };

  it("acquires and resolves a lease", () => {
    const registry = createSessionRegistry();
    const lease = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-1", expiresAtMs: NOW + 60_000, guest: true },
      NOW,
    );
    expect(isLeaseDecision(lease)).toBe(false);
    if (isLeaseDecision(lease)) {
      return;
    }
    const resolved = registry.resolve(lease.handle, contextA, NOW);
    expect(isLeaseDecision(resolved)).toBe(false);
  });

  it("rejects a second active lease for the same job", () => {
    const registry = createSessionRegistry();
    const spec = { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-1", expiresAtMs: NOW + 60_000, guest: true };
    expect(isLeaseDecision(registry.acquire(spec, NOW))).toBe(false);
    mustDenialReason(registry.acquire({ ...spec, leaseId: "lease-2" }, NOW), "conflict");
  });

  it("rejects resolution under another organization/project/job", () => {
    const registry = createSessionRegistry();
    const lease = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-1", expiresAtMs: NOW + 60_000, guest: true },
      NOW,
    );
    if (isLeaseDecision(lease)) {
      throw new Error("expected a lease");
    }
    mustDenialReason(registry.resolve(lease.handle, contextB, NOW), "lease-invalid");
    mustDenialReason(
      registry.resolve(lease.handle, { organizationId: "org-a", projectId: "proj-a", jobId: "job-other" }, NOW),
      "lease-invalid",
    );
  });

  it("rejects expired leases", () => {
    const registry = createSessionRegistry();
    mustDenialReason(
      registry.acquire(
        { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-old", expiresAtMs: NOW - 1, guest: false },
        NOW,
      ),
      "lease-invalid",
    );
    const lease = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-1", expiresAtMs: NOW + 1_000, guest: false },
      NOW,
    );
    if (isLeaseDecision(lease)) {
      throw new Error("expected a lease");
    }
    mustDenialReason(registry.resolve(lease.handle, contextA, NOW + 2_000), "lease-invalid");
  });

  it("keeps two isolated sessions mutually unusable", () => {
    const registry = createSessionRegistry();
    const guest = registry.acquire(
      { organizationId: "org-guest", projectId: "proj-guest", jobId: "job-guest", leaseId: "lease-g", expiresAtMs: NOW + 60_000, guest: true },
      NOW,
    );
    const priv = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-p", expiresAtMs: NOW + 60_000, guest: false },
      NOW,
    );
    if (isLeaseDecision(guest) || isLeaseDecision(priv)) {
      throw new Error("expected two leases");
    }
    expect(guest.guest).toBe(true);
    expect(priv.guest).toBe(false);
    mustDenialReason(
      registry.resolve(guest.handle, { organizationId: "org-a", projectId: "proj-a", jobId: "job-a" }, NOW),
      "lease-invalid",
    );
    mustDenialReason(
      registry.resolve(priv.handle, { organizationId: "org-guest", projectId: "proj-guest", jobId: "job-guest" }, NOW),
      "lease-invalid",
    );
  });

  it("allows re-acquire after release", () => {
    const registry = createSessionRegistry();
    const first = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-1", expiresAtMs: NOW + 60_000, guest: false },
      NOW,
    );
    if (isLeaseDecision(first)) {
      throw new Error("expected a lease");
    }
    expect(registry.release(first.handle, contextA).ok).toBe(true);
    const second = registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-2", expiresAtMs: NOW + 60_000, guest: false },
      NOW,
    );
    expect(isLeaseDecision(second)).toBe(false);
  });
});

describe("destination policy", () => {
  it("permits an allowed https origin", () => {
    expect(validateDestination(GOOD_URL, ORIGINS).ok).toBe(true);
  });

  it("blocks non-https protocols", () => {
    mustDenialReason(validateDestination("http://supplier-a.example/x", ORIGINS), "unsupported-protocol");
  });

  it("blocks private IPv4 ranges", () => {
    mustDenialReason(validateDestination("https://10.0.0.5/admin", ORIGINS), "private-network");
    mustDenialReason(validateDestination("https://192.168.1.20/admin", ORIGINS), "private-network");
    mustDenialReason(validateDestination("https://172.16.4.9/admin", ORIGINS), "private-network");
  });

  it("blocks loopback", () => {
    mustDenialReason(validateDestination("https://127.0.0.1/admin", ORIGINS), "private-network");
  });

  it("blocks cloud metadata destinations", () => {
    mustDenialReason(validateDestination("https://169.254.169.254/latest/meta-data", ORIGINS), "metadata-endpoint");
    mustDenialReason(validateDestination("https://metadata.google.internal/x", ORIGINS), "blocked-host");
  });

  it("blocks origins outside the allowlist", () => {
    mustDenialReason(validateDestination("https://evil.example/x", ORIGINS), "origin-not-allowed");
  });

  it("validates redirect chains", () => {
    expect(
      validateNavigation("https://supplier-a.example/final", ["https://supplier-a.example/step"], ORIGINS).ok,
    ).toBe(true);
    mustDenialReason(
      validateNavigation("https://evil.example/final", ["https://supplier-a.example/step"], ORIGINS),
      "origin-not-allowed",
    );
    mustDenialReason(
      validateNavigation("https://supplier-a.example/final", ["https://evil.example/step"], ORIGINS),
      "redirect-origin-not-allowed",
    );
    mustDenialReason(
      validateNavigation("https://supplier-a.example/final", ["http://supplier-a.example/step"], ORIGINS),
      "redirect-downgrade",
    );
    mustDenialReason(
      validateNavigation("https://supplier-a.example/final", [
        "https://supplier-a.example/1",
        "https://supplier-a.example/2",
        "https://supplier-a.example/3",
        "https://supplier-a.example/4",
        "https://supplier-a.example/5",
        "https://supplier-a.example/6",
      ], ORIGINS),
      "too-many-redirects",
    );
  });
});

describe("target freshness", () => {
  const targets = Object.freeze([targetFixture("t-1", "doc-9"), targetFixture("t-hidden", "doc-9", true)]);

  it("accepts a fresh visible target", () => {
    expect(checkTarget(targets, "doc-9", "t-1").ok).toBe(true);
  });

  it("denies an arbitrary unobserved selector", () => {
    mustDenialReason(checkTarget(targets, "doc-9", "#model-chosen-checkout"), "unknown-target");
  });

  it("denies a stale document version", () => {
    mustDenialReason(checkTarget(targets, "doc-10", "t-1"), "stale-document");
  });

  it("denies an occluded target", () => {
    mustDenialReason(checkTarget(targets, "doc-9", "t-hidden"), "occluded-target");
  });
});

describe("operation catalog", () => {
  it("permits the six read-only operations", () => {
    for (const operationId of ["navigate", "readVisibleText", "listTargets", "inspectTarget", "captureSnapshot", "reobserve"]) {
      expect(authorizeOperation(operationId, OPERATION_CATALOG_VERSION, false).ok).toBe(true);
    }
    expect(catalogEntries().filter((entry) => entry.permitted).length).toBe(6);
  });

  it("denies unknown operations", () => {
    mustDenialReason(authorizeOperation("brewCoffee", OPERATION_CATALOG_VERSION, false), "unknown-operation");
  });

  it("denies a stale catalog version", () => {
    mustDenialReason(authorizeOperation("navigate", "browser-catalog-0", false), "stale-catalog");
  });

  it("blocks vendor writes, purchases, accounts, downloads, and scripts directly", () => {
    mustDenialReason(authorizeOperation("submitContactForm", OPERATION_CATALOG_VERSION, false), "vendor-write-blocked");
    mustDenialReason(authorizeOperation("sendChatMessage", OPERATION_CATALOG_VERSION, false), "vendor-write-blocked");
    mustDenialReason(authorizeOperation("submitRfq", OPERATION_CATALOG_VERSION, false), "vendor-write-blocked");
    mustDenialReason(authorizeOperation("purchase", OPERATION_CATALOG_VERSION, false), "purchase-blocked");
    mustDenialReason(authorizeOperation("createAccount", OPERATION_CATALOG_VERSION, false), "account-blocked");
    mustDenialReason(authorizeOperation("downloadFile", OPERATION_CATALOG_VERSION, false), "download-blocked");
    mustDenialReason(authorizeOperation("runScript", OPERATION_CATALOG_VERSION, false), "script-blocked");
    mustDenialReason(authorizeOperation("selectArbitrary", OPERATION_CATALOG_VERSION, false), "arbitrary-selector-blocked");
  });

  it("blocks contact and chat attempts through the recovery route too", () => {
    mustDenialReason(authorizeOperation("submitContactForm", OPERATION_CATALOG_VERSION, true), "vendor-write-blocked");
    mustDenialReason(authorizeOperation("sendChatMessage", OPERATION_CATALOG_VERSION, true), "vendor-write-blocked");
  });
});

describe("job lifecycle", () => {
  it("dispatches a step and records the observation", async () => {
    const job = setupJob();
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    expect(out.outcome).toBe("observed-success");
    expect(out.job.attempts.length).toBe(1);
    expect(out.job.attempts[0]?.state).toBe("observedSuccess");
    expect(out.job.attempts[0]?.observation?.url).toBe(GOOD_URL);
    expect(out.calls).toBe(1);
  });

  it("marks an observation bound to another job as a failure", async () => {
    const job = setupJob();
    const store = createMemoryNonceStore();
    const verifier: CallbackVerifier = {
      verify: (envelope, signature, expectedVersion) =>
        verifyCallback(SECRET, store, envelope, signature, expectedVersion),
    };
    const raw = observationFixture("a_job-a_1", { jobId: "job-other", observationVersion: 1 });
    const observation = parseObservation(raw);
    const nonce = "cb-foreign-1";
    const transport: StepTransport = {
      async execute(): Promise<TransportResult> {
        return { envelope: { observation: raw, callbackNonce: nonce }, signature: signObservation(SECRET, observation, nonce) };
      },
    };
    const result = await dispatchStep(job, mustClaim(job), transport, verifier, NOW);
    expect(result.receipt.outcome).toBe("observed-failure");
    expect(result.job.attempts[0]?.state).toBe("observedFailure");
  });

  it("records a throwing transport as unknown without losing the attempt", async () => {
    const job = setupJob();
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ throws: true }]);
    expect(out.outcome).toBe("transport-unknown");
    expect(out.job.attempts[0]?.state).toBe("outcomeUnknown");
  });

  it("cancellation before dispatch prevents any send", () => {
    const job = setupJob();
    const cancelled = mustJob(cancelJob(job, NOW, "user revoked authority"));
    expect(cancelled.state).toBe("cancelled");
    mustDenialReason(authorize(cancelled, "readVisibleText"), "job-cancelled");
    expect(cancelled.attempts.length).toBe(0);
    expect(cancelled.stepsUsed).toBe(0);
  });

  it("records a late read-only result after cancellation without reopening the job", async () => {
    const store = createMemoryNonceStore();
    const verifier: CallbackVerifier = {
      verify: (envelope, signature, expectedVersion) =>
        verifyCallback(SECRET, store, envelope, signature, expectedVersion),
    };
    // Claim an attempt, then cancel while it is in flight.
    const opened = setupJob();
    const prepared = prepareAttempt(opened, mustClaim(opened), NOW);
    if ("ok" in prepared && prepared.ok === false) {
      throw new Error("expected a prepared attempt");
    }
    const { job: inFlight, attemptId } = prepared as { readonly job: BrowserJob; readonly attemptId: string };
    let job = mustJob(cancelJob(inFlight, NOW, "user revoked authority"));
    expect(job.state).toBe("cancelled");
    expect(job.attempts[0]?.state).toBe("dispatching");
    // The in-flight executor delivery arrives late with a read-only result.
    const raw = observationFixture(attemptId, { observationVersion: 1, claimedOutcome: "success" });
    const observation = parseObservation(raw);
    const envelope = { observation: raw, callbackNonce: "cb-late-1" };
    const signature = signObservation(SECRET, observation, "cb-late-1");
    const late: unknown = await recordLateObservation(job, attemptId, envelope, signature, verifier);
    if (typeof late !== "object" || late === null || !("receipt" in late)) {
      throw new Error(`expected a late receipt: ${asDenial(late).detail}`);
    }
    const settled = late as { readonly job: BrowserJob; readonly receipt: { readonly recorded: boolean } };
    expect(settled.receipt.recorded).toBe(true);
    job = settled.job;
    expect(job.state).toBe("cancelled");
    expect(job.lateResults.length).toBe(1);
    expect(job.attempts[0]?.state).toBe("observedSuccess");
    expect(job.attempts[0]?.lateResult).toBe(true);
    // No new work may dispatch, and the same result cannot settle twice.
    mustDenialReason(authorize(job, "readVisibleText"), "job-cancelled");
    const again = await recordLateObservation(job, attemptId, envelope, signature, verifier);
    expect("ok" in again && again.ok === false).toBe(true);
  });

  it("fences expired jobs and denies expired dispatches", () => {
    const job = setupJob({ expiresAt: NOW - 1 });
    mustDenialReason(authorize(job, "readVisibleText"), "job-expired");
    const fenced = fenceExpired(job, NOW);
    expect(fenced.state).toBe("cancelled");
    expect(fenced.cancelReason).toBe("expired");
  });

  it("denies dispatch without a valid session lease", () => {
    const job = setupJob();
    mustDenialReason(authorize(job, "readVisibleText", { leaseOk: false }), "lease-invalid");
  });

  it("fails after three consecutive no-progress observations with evidence preserved", async () => {
    let job = setupJob();
    const store = createMemoryNonceStore();
    for (let round = 0; round < 3; round += 1) {
      const out = await dispatch(job, mustClaim(job), store, [{ outcome: "noProgress" }]);
      job = out.job;
    }
    expect(job.state).toBe("failed");
    expect(job.consecutiveNoProgress).toBe(3);
    expect(job.attempts.length).toBe(3);
    mustDenialReason(authorize(job, "readVisibleText"), "job-terminal");
  });

  it("changes strategy while preserving verified results", async () => {
    let job = setupJob();
    const store = createMemoryNonceStore();
    const first = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    job = first.job;
    const attemptId = job.attempts[0]?.attemptId as string;
    job = mustJob(applyIndependentCheck(job, attemptId, { checker: "independent", observedUrl: GOOD_URL, matches: true }, NOW));
    expect(job.verifiedOutcomes.length).toBe(1);
    for (let round = 0; round < 2; round += 1) {
      const out = await dispatch(job, mustClaim(job), store, [{ outcome: "noProgress" }]);
      job = out.job;
    }
    expect(job.consecutiveNoProgress).toBe(2);
    job = mustJob(changeStrategy(job, "switch to read-only extraction"));
    expect(job.state).toBe("running");
    expect(job.epoch).toBe(2);
    expect(job.consecutiveNoProgress).toBe(0);
    expect(job.verifiedOutcomes.length).toBe(1);
    expect(job.attempts.length).toBe(3);
    const resumed = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    expect(resumed.outcome).toBe("observed-success");
  });

  it("completes only with an independently verified outcome", async () => {
    let job = setupJob();
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    job = out.job;
    const attemptId = job.attempts[0]?.attemptId as string;
    mustDenialReason(tryComplete(job), "unverified");
    mustDenialReason(
      applyIndependentCheck(job, attemptId, { checker: "self", observedUrl: GOOD_URL, matches: true }, NOW),
      "unverified",
    );
    mustDenialReason(
      applyIndependentCheck(job, attemptId, { checker: "independent", observedUrl: GOOD_URL, matches: false }, NOW),
      "unverified",
    );
    job = mustJob(
      applyIndependentCheck(job, attemptId, { checker: "independent", observedUrl: GOOD_URL, matches: true }, NOW),
    );
    expect(job.verifiedOutcomes.length).toBe(1);
    job = mustJob(tryComplete(job));
    expect(job.state).toBe("completed");
  });

  it("denies a self-reported claim as completion without an independent check", async () => {
    let job = setupJob();
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    job = out.job;
    mustDenialReason(tryComplete(job), "unverified");
  });

  it("enforces the step budget", async () => {
    let job = setupJob({ maximumSteps: 1 });
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ outcome: "success" }]);
    job = out.job;
    expect(job.stepsUsed).toBe(1);
    mustDenialReason(authorize(job, "readVisibleText"), "steps-exhausted");
  });

  it("denies a blocked operation before any transport call", async () => {
    const job = setupJob();
    const store = createMemoryNonceStore();
    mustDenialReason(authorize(job, "submitContactForm"), "vendor-write-blocked");
    const stub = stubTransport(store, [{ outcome: "success" }], job.nextObservationVersion);
    expect(stub.calls.length).toBe(0);
    expect(job.stepsUsed).toBe(0);
  });

  it("moves to waiting on a waiting outcome and suspends dispatch", async () => {
    let job = setupJob();
    const store = createMemoryNonceStore();
    const out = await dispatch(job, mustClaim(job), store, [{ outcome: "waiting" }]);
    job = out.job;
    expect(job.state).toBe("waitingForSupplier");
    mustDenialReason(authorize(job, "readVisibleText"), "job-terminal");
  });
});
