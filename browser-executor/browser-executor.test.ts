// Controlled contract tests for the browser-executor boundary.
//
// Every transport is an injected stub, every secret is synthetic, every
// clock is fixed, and every lease/claim/nonce lives in an in-memory
// controlled store. No live browser, provider, or network calls; no
// credentials; no claim of deployed D-04 success.
//
// Includes regression coverage for independent review findings BR1-BR9
// (boolean-safe signing, numeric policy, single-use bound claims,
// compare-and-set dispatch, callback quarantine, digest binding,
// fail-closed replay store, operation-specific inputs, truthful late
// outcomes) converted from the reviewer probes into repository tests.

import { describe, expect, it } from "bun:test";
import type {
  AuthorizeInput,
  BrowserJob,
  BrowserObservation,
  CallbackExpectation,
  CallbackVerifier,
  ClaimedOutcome,
  ControlledDriverOptions,
  DenialReason,
  IssuedClaim,
  NonceStore,
  ObservedTarget,
  SessionLease,
  StepClaim,
  StepTransport,
  TransportInput,
  TransportResult,
} from "./index.ts";
import {
  ControlledDriver,
  OPERATION_CATALOG_VERSION,
  authorizeOperation,
  authorizeStep,
  cancelJob,
  canonicalJson,
  catalogEntries,
  changeStrategy,
  checkTarget,
  computeRequestDigest,
  createJob,
  createMemoryNonceStore,
  createSessionRegistry,
  fenceExpired,
  isDenial,
  isLeaseDecision,
  parseJobRequest,
  parseObservation,
  prepareAttempt,
  recordLateObservation,
  settleAttempt,
  signObservation,
  signJobRequest,
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

const TEST_DIGEST = computeRequestDigest(SECRET, parseJobRequest(requestFixture()));

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
    requestDigest: TEST_DIGEST,
    ...overrides,
  };
}

function targetFixture(targetId: string, documentVersion: string, occluded = false): ObservedTarget {
  return { targetId, documentVersion, occluded };
}

function mustJob(value: unknown): BrowserJob {
  if (isDenial(value)) {
    throw new Error(`expected job, got denial ${value.reason}: ${value.detail}`);
  }
  return value as BrowserJob;
}

function mustDenialReason(value: unknown, reason: DenialReason): string {
  if (!isDenial(value)) {
    throw new Error("expected a denial");
  }
  expect(value.reason).toBe(reason);
  return value.detail;
}

function mustClaim(job: BrowserJob, operationId = "readVisibleText", extra: Partial<AuthorizeInput> = {}): StepClaim {
  const result: unknown = authorizeStep(job, {
    nowMs: NOW,
    operationId,
    viaRecovery: false,
    leaseOk: true,
    ...extra,
  });
  if (isDenial(result)) {
    throw new Error(`expected claim, got denial ${result.reason}: ${result.detail}`);
  }
  return (result as { readonly claim: StepClaim }).claim;
}

function strictVerifier(
  store: NonceStore,
  exp: { readonly nonce: string; readonly digest?: string; readonly jobId?: string; readonly attemptId?: string },
): CallbackVerifier {
  return {
    verify: (envelope: unknown, signature: unknown, version: number) => {
      const expectation: CallbackExpectation = {
        nonce: exp.nonce,
        requestDigest: exp.digest ?? TEST_DIGEST,
        jobId: exp.jobId ?? "job-a",
        attemptId: exp.attemptId ?? "a_job-a_1",
        version,
        validUntilMs: NOW + 120_000,
        nowMs: NOW,
      };
      return verifyCallback(SECRET, store, envelope, signature, expectation);
    },
  };
}

function signedEnvelope(
  attemptId: string,
  nonce: string,
  overrides: { readonly [key: string]: unknown } = {},
  secret: string = SECRET,
): { readonly envelope: unknown; readonly signature: unknown } {
  const raw = observationFixture(attemptId, overrides);
  const observation = parseObservation(raw);
  return { envelope: { observation: raw, callbackNonce: nonce }, signature: signObservation(secret, observation, nonce) };
}

interface DriverSetup {
  readonly driver: ControlledDriver;
  readonly jobId: string;
  readonly handle: string;
}

function setupDriver(
  reqOverrides: { readonly [key: string]: unknown } = {},
  options?: ControlledDriverOptions,
  requiredOutputs: unknown = [],
): DriverSetup {
  const driver = new ControlledDriver(SECRET, options);
  const request = parseJobRequest(requestFixture(reqOverrides));
  const registered: unknown = driver.registerJob(request, NOW, requiredOutputs);
  if (typeof registered !== "string") {
    throw new Error(`registration failed: ${isDenial(registered) ? registered.detail : "unknown"}`);
  }
  const lease: unknown = driver.acquireLease(registered, {
    organizationId: request.organizationId,
    projectId: request.projectId,
    leaseId: "lease-1",
    expiresAtMs: NOW + 60_000,
    guest: false,
  }, NOW);
  if (isDenial(lease)) {
    throw new Error(`lease failed: ${lease.detail}`);
  }
  return { driver, jobId: registered, handle: (lease as SessionLease).handle };
}

function issue(
  setup: DriverSetup,
  operationId = "readVisibleText",
  extra: Partial<Omit<DriverAuthorizeExtra, "jobId">> = {},
): IssuedClaim {
  const result: unknown = setup.driver.authorize({
    jobId: setup.jobId,
    nowMs: NOW,
    operationId,
    viaRecovery: false,
    sessionHandle: setup.handle,
    ...extra,
  });
  if (isDenial(result)) {
    throw new Error(`expected claim: ${result.reason} ${result.detail}`);
  }
  return result as IssuedClaim;
}

interface DriverAuthorizeExtra {
  readonly jobId: string;
  readonly viaRecovery?: boolean;
  readonly destination?: string;
  readonly redirectHops?: readonly string[];
  readonly targetId?: string;
  readonly currentTargets?: readonly ObservedTarget[];
  readonly currentDocumentVersion?: string;
  readonly nowMs?: number;
}

interface StubDef {
  readonly url?: string;
  readonly outcome?: ClaimedOutcome;
  readonly version?: number;
  readonly targets?: readonly ObservedTarget[];
  readonly outputs?: readonly string[];
  readonly digest?: string;
  readonly nonce?: string;
  readonly badSecret?: boolean;
  readonly throws?: boolean;
}

function driverStub(driver: ControlledDriver, defs: readonly StubDef[] = [{}]): {
  readonly transport: StepTransport;
  readonly calls: TransportInput[];
} {
  const calls: TransportInput[] = [];
  let count = 0;
  const transport: StepTransport = {
    execute: async (input: TransportInput): Promise<TransportResult> => {
      calls.push(input);
      count += 1;
      const def = defs[Math.min(count - 1, defs.length - 1)] as StubDef;
      if (def.throws === true) {
        throw new Error("synthetic transport failure");
      }
      const expectation = driver.expectationFor(input.jobId, input.attemptId);
      const raw = observationFixture(input.attemptId, {
        url: def.url ?? GOOD_URL,
        claimedOutcome: def.outcome ?? "success",
        observationVersion: def.version ?? expectation?.version ?? 1,
        requestDigest: def.digest ?? input.requestDigest,
        ...(def.targets === undefined ? {} : { observedTargets: def.targets }),
        ...(def.outputs === undefined ? {} : { producedOutputs: def.outputs }),
      });
      const observation = parseObservation(raw);
      const nonce = def.nonce ?? input.callbackNonce;
      const signature = signObservation(def.badSecret === true ? OTHER_SECRET : SECRET, observation, nonce);
      return { envelope: { observation: raw, callbackNonce: nonce }, signature };
    },
  };
  return { transport, calls };
}

async function runDispatch(
  setup: DriverSetup,
  claim: IssuedClaim,
  defs: readonly StubDef[] = [{}],
  timeoutMs?: number,
): Promise<{ readonly job: BrowserJob; readonly outcome: string; readonly detail: string; readonly calls: number }> {
  const stub = driverStub(setup.driver, defs);
  const result = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, {
    nowMs: NOW,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
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
    expect(observation.requestDigest).toBe(TEST_DIGEST);
  });

  it("rejects an unknown claimed outcome", () => {
    expect(() => parseObservation(observationFixture("a_job-a_1", { claimedOutcome: "done" }))).toThrow();
  });

  it("rejects a missing request digest", () => {
    const raw = observationFixture("a_job-a_1") as { [key: string]: unknown };
    delete raw.requestDigest;
    expect(() => parseObservation(raw)).toThrow();
  });
});

describe("canonical signing (BR1)", () => {
  it("serializes booleans separately from numbers", () => {
    expect(canonicalJson({ occluded: false })).toBe('{"occluded":false}');
    expect(canonicalJson({ occluded: true })).toBe('{"occluded":true}');
  });

  it("round-trips observations with targets both occluded values", () => {
    for (const occluded of [false, true]) {
      const store = createMemoryNonceStore();
      const raw = observationFixture("a_job-a_1", {
        observationVersion: 1,
        observedTargets: [{ targetId: "t", documentVersion: "v1", occluded }],
      });
      const observation = parseObservation(raw);
      const nonce = `cb-target-${occluded}`;
      const signature = signObservation(SECRET, observation, nonce);
      const result = verifyCallback(SECRET, store, { observation: raw, callbackNonce: nonce }, signature, {
        nonce,
        requestDigest: TEST_DIGEST,
        jobId: "job-a",
        attemptId: "a_job-a_1",
        version: 1,
        validUntilMs: NOW + 120_000,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("settles a target-bearing observation through settleAttempt", () => {
    const store = createMemoryNonceStore();
    const job = createJob(parseJobRequest(requestFixture()), NOW);
    const prepared = prepareAttempt(job, mustClaim(job), NOW);
    if (isDenial(prepared)) {
      throw new Error("expected preparation");
    }
    const nonce = "cb-settle-target-1";
    const { envelope, signature } = signedEnvelope(prepared.attemptId, nonce, {
      observedTargets: [{ targetId: "t", documentVersion: "v1", occluded: false }],
    });
    const settled = settleAttempt(prepared.job, prepared.attemptId, envelope, signature, strictVerifier(store, { nonce }), NOW);
    if (isDenial(settled)) {
      throw new Error(`expected settlement: ${settled.detail}`);
    }
    expect(settled.receipt.outcome).toBe("observed-success");
    expect(settled.job.attempts[0]?.observation?.observedTargets.length).toBe(1);
  });

  it("keeps sorted-key equivalence and tamper rejection", () => {
    const request = parseJobRequest(requestFixture());
    const signed = signJobRequest(SECRET, request);
    expect(verifyJobRequest(SECRET, requestFixture(), signed.signature).jobId).toBe("job-a");
    expect(() => verifyJobRequest(SECRET, requestFixture({ jobId: "job-b" }), signed.signature)).toThrow();
    expect(() => verifyJobRequest(OTHER_SECRET, requestFixture(), signed.signature)).toThrow();
  });

  it("still rejects non-finite numbers in canonicalization", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("callback verification with issued expectations (BR6/BR7)", () => {
  function expectation(nonce: string, overrides: Partial<CallbackExpectation> = {}): CallbackExpectation {
    return {
      nonce,
      requestDigest: TEST_DIGEST,
      jobId: "job-a",
      attemptId: "a_job-a_1",
      version: 1,
      validUntilMs: NOW + 120_000,
      nowMs: NOW,
      ...overrides,
    };
  }

  it("accepts a first valid callback", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-once-1");
    expect(verifyCallback(SECRET, store, envelope, signature, expectation("cb-once-1")).ok).toBe(true);
  });

  it("rejects a replayed nonce", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-once-1");
    expect(verifyCallback(SECRET, store, envelope, signature, expectation("cb-once-1")).ok).toBe(true);
    const replay = verifyCallback(SECRET, store, envelope, signature, expectation("cb-once-1"));
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.reason).toBe("replay-detected");
    }
  });

  it("rejects a stale version without consuming the nonce", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-stale-1", { observationVersion: 5 });
    const stale = verifyCallback(SECRET, store, envelope, signature, expectation("cb-stale-1"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe("stale-callback");
    }
    expect(store.isConsumed("cb-stale-1", NOW)).toBe(false);
  });

  it("rejects a bad signature", () => {
    const store = createMemoryNonceStore();
    const { envelope } = signedEnvelope("a_job-a_1", "cb-bad-1");
    const raw = observationFixture("a_job-a_1");
    const bad = signObservation(OTHER_SECRET, parseObservation(raw), "cb-bad-1");
    const result = verifyCallback(SECRET, store, envelope, bad, expectation("cb-bad-1"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("bad-signature");
    }
  });

  it("rejects an unissued nonce without burning the rightful result", () => {
    const store = createMemoryNonceStore();
    const right = signedEnvelope("a_job-a_1", "cb-right-1");
    const wrongRoute = verifyCallback(SECRET, store, right.envelope, right.signature, expectation("cb-other-1"));
    expect(wrongRoute.ok).toBe(false);
    if (!wrongRoute.ok) {
      expect(wrongRoute.reason).toBe("unknown-callback");
    }
    expect(verifyCallback(SECRET, store, right.envelope, right.signature, expectation("cb-right-1")).ok).toBe(true);
  });

  it("rejects a callback answering another tenant's request", () => {
    const store = createMemoryNonceStore();
    const otherDigest = computeRequestDigest(SECRET, parseJobRequest(requestFixture({ organizationId: "org-guest", projectId: "proj-guest" })));
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-tenant-1", { requestDigest: otherDigest });
    const result = verifyCallback(SECRET, store, envelope, signature, expectation("cb-tenant-1"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-callback");
    }
  });

  it("rejects a callback bound to another attempt", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedEnvelope("a_job-a_9", "cb-attempt-1");
    const result = verifyCallback(SECRET, store, envelope, signature, expectation("cb-attempt-1"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown-callback");
    }
  });

  it("fails closed when the atomic consume is refused", () => {
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-refused-1");
    const refusing: NonceStore = { isConsumed: () => false, tryConsume: () => false };
    expect(verifyCallback(SECRET, refusing, envelope, signature, expectation("cb-refused-1")).ok).toBe(false);
  });

  it("retains replay markers at capacity instead of evicting them", () => {
    const store = createMemoryNonceStore();
    const { envelope, signature } = signedEnvelope("a_job-a_1", "cb-cap-1");
    expect(verifyCallback(SECRET, store, envelope, signature, expectation("cb-cap-1")).ok).toBe(true);
    for (let n = 0; n < 9_999; n += 1) {
      expect(store.tryConsume(`other-${n}`, NOW + 120_000, NOW)).toBe(true);
    }
    const replay = verifyCallback(SECRET, store, envelope, signature, expectation("cb-cap-1"));
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.reason).toBe("replay-detected");
    }
    expect(store.tryConsume("fresh-after-full", NOW + 120_000, NOW)).toBe(false);
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
    expect(isLeaseDecision(registry.resolve(lease.handle, contextA, NOW))).toBe(false);
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
    expect(isLeaseDecision(registry.acquire(
      { organizationId: "org-a", projectId: "proj-a", jobId: "job-a", leaseId: "lease-2", expiresAtMs: NOW + 60_000, guest: false },
      NOW,
    ))).toBe(false);
  });
});

describe("destination policy (BR2)", () => {
  it("permits an allowed https origin", () => {
    expect(validateDestination(GOOD_URL, ORIGINS).ok).toBe(true);
  });

  it("denies private IPv6 and reserved IPv4 literals even when allowlisted", () => {
    const inputs = [
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://[fe80::1]/",
      "https://[fe80::abcd]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[ff02::1]/",
      "https://[2001:db8::1]/",
      "https://224.0.0.1/",
      "https://240.0.0.1/",
      "https://192.0.2.1/",
      "https://198.51.100.7/",
      "https://203.0.113.9/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://192.168.1.20/",
      "https://172.16.4.9/",
      "https://169.254.169.254/",
      "https://0x7f.0.0.1/",
      "https://2130706433/",
    ];
    for (const raw of inputs) {
      const allowlisted = [new URL(raw).origin];
      const result = validateDestination(raw, allowlisted);
      expect(result.ok).toBe(false);
    }
  });

  it("denies metadata and blocked-host aliases including trailing dots", () => {
    mustDenialReason(validateDestination("https://169.254.169.254/latest/meta-data", ORIGINS), "metadata-endpoint");
    mustDenialReason(validateDestination("https://metadata.google.internal/x", ORIGINS), "blocked-host");
    mustDenialReason(validateDestination("https://localhost./admin", ["https://localhost.:443"]), "blocked-host");
    mustDenialReason(validateDestination("https://intranet/admin", ["https://intranet"]), "blocked-host");
  });

  it("blocks origins outside the allowlist", () => {
    mustDenialReason(validateDestination("https://evil.example/x", ORIGINS), "origin-not-allowed");
  });

  it("validates every redirect position", () => {
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
      validateNavigation("https://supplier-a.example/final", ["https://[::1]/step"], ORIGINS),
      "private-network",
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

  it("freezes every catalog entry at runtime", () => {
    expect(catalogEntries().every((entry) => Object.isFrozen(entry))).toBe(true);
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

describe("authorizeStep static checks (BR3/BR8/BR10)", () => {
  function baseJob(): BrowserJob {
    return createJob(parseJobRequest(requestFixture()), NOW);
  }

  it("denies dispatch at exact expiry", () => {
    const job = baseJob();
    mustDenialReason(authorizeStep(job, { nowMs: job.request.expiresAt, operationId: "readVisibleText", viaRecovery: false, leaseOk: true }), "job-expired");
  });

  it("denies dispatch on an expired request session lease", () => {
    const job = createJob(parseJobRequest(requestFixture({ sessionLease: { leaseId: "l", expiresAtMs: NOW - 1 } })), NOW - 2_000);
    mustDenialReason(
      authorizeStep(job, { nowMs: NOW, operationId: "readVisibleText", viaRecovery: false, leaseOk: true }),
      "lease-invalid",
    );
  });

  it("requires a destination for navigation", () => {
    mustDenialReason(
      authorizeStep(baseJob(), { nowMs: NOW, operationId: "navigate", viaRecovery: false, leaseOk: true }),
      "missing-destination",
    );
  });

  it("requires an observed target and document for inspection", () => {
    mustDenialReason(
      authorizeStep(baseJob(), { nowMs: NOW, operationId: "inspectTarget", viaRecovery: false, leaseOk: true }),
      "missing-target",
    );
  });
});

describe("settle quarantine (BR5)", () => {
  function prepared(): { readonly job: BrowserJob; readonly attemptId: string } {
    const job = createJob(parseJobRequest(requestFixture()), NOW);
    const result: unknown = prepareAttempt(job, mustClaim(job), NOW);
    if (isDenial(result)) {
      throw new Error("expected preparation");
    }
    return result as { readonly job: BrowserJob; readonly attemptId: string };
  }

  it("does not settle on a bad signature and accepts the later valid callback", () => {
    const store = createMemoryNonceStore();
    const { job, attemptId } = prepared();
    const { envelope } = signedEnvelope(attemptId, "cb-quar-1");
    const bad = signObservation(OTHER_SECRET, parseObservation(observationFixture(attemptId)), "cb-quar-1");
    const verifier = strictVerifier(store, { nonce: "cb-quar-1", attemptId });
    const rejected = settleAttempt(job, attemptId, envelope, bad, verifier, NOW);
    if (isDenial(rejected)) {
      throw new Error("expected a receipt");
    }
    expect(rejected.receipt.outcome).toBe("callback-rejected");
    expect(rejected.job.attempts[0]?.state).toBe("dispatching");
    expect(rejected.job.quarantined.length).toBe(1);
    const valid = signedEnvelope(attemptId, "cb-quar-1");
    const accepted = settleAttempt(rejected.job, attemptId, valid.envelope, valid.signature, verifier, NOW);
    if (isDenial(accepted)) {
      throw new Error("expected settlement");
    }
    expect(accepted.receipt.outcome).toBe("observed-success");
  });

  it("quarantines wrong-version callbacks without settling", () => {
    const store = createMemoryNonceStore();
    const { job, attemptId } = prepared();
    const { envelope, signature } = signedEnvelope(attemptId, "cb-ver-1", { observationVersion: 7 });
    const verifier = strictVerifier(store, { nonce: "cb-ver-1", attemptId });
    const result = settleAttempt(job, attemptId, envelope, signature, verifier, NOW);
    if (isDenial(result)) {
      throw new Error("expected a receipt");
    }
    expect(result.receipt.outcome).toBe("callback-rejected");
    expect(result.job.attempts[0]?.state).toBe("dispatching");
  });

  it("quarantines replays without settling", () => {
    const store = createMemoryNonceStore();
    const { job, attemptId } = prepared();
    const first = signedEnvelope(attemptId, "cb-replay-1");
    const verifier = strictVerifier(store, { nonce: "cb-replay-1", attemptId });
    const accepted = settleAttempt(job, attemptId, first.envelope, first.signature, verifier, NOW);
    if (isDenial(accepted)) {
      throw new Error("expected settlement");
    }
    expect(accepted.receipt.outcome).toBe("observed-success");
    const replay = settleAttempt(accepted.job, attemptId, first.envelope, first.signature, verifier, NOW);
    if (isDenial(replay)) {
      expect(replay.reason).toBe("unknown-callback");
      return;
    }
    expect(replay.receipt.outcome).toBe("callback-rejected");
  });

  it("quarantines wrong-job callbacks and keeps the right attempt open", () => {
    const store = createMemoryNonceStore();
    const { job, attemptId } = prepared();
    const foreign = signedEnvelope("a_job-a_9", "cb-foreign-1", { attemptId: "a_job-a_9" });
    const strictForAttempt = strictVerifier(store, { nonce: "cb-foreign-1", attemptId });
    const result = settleAttempt(job, attemptId, foreign.envelope, foreign.signature, strictForAttempt, NOW);
    if (isDenial(result)) {
      throw new Error("expected a receipt");
    }
    expect(result.receipt.outcome).toBe("callback-rejected");
    expect(result.job.attempts[0]?.state).toBe("dispatching");
    const valid = signedEnvelope(attemptId, "cb-foreign-2");
    const accepted = settleAttempt(result.job, attemptId, valid.envelope, valid.signature, strictVerifier(store, { nonce: "cb-foreign-2", attemptId }), NOW);
    if (isDenial(accepted)) {
      throw new Error("expected settlement");
    }
    expect(accepted.receipt.outcome).toBe("observed-success");
  });

  it("rejects cross-tenant callbacks at the digest binding", () => {
    const store = createMemoryNonceStore();
    const guestRequest = parseJobRequest(requestFixture({ jobId: "job-a", organizationId: "org-guest", projectId: "proj-guest" }));
    const guestJob = createJob(guestRequest, NOW);
    const guestPrepared: unknown = prepareAttempt(guestJob, mustClaim(guestJob), NOW);
    if (isDenial(guestPrepared)) {
      throw new Error("expected preparation");
    }
    const { job, attemptId } = guestPrepared as { readonly job: BrowserJob; readonly attemptId: string };
    const guestDigest = computeRequestDigest(SECRET, guestRequest);
    const { envelope, signature } = signedEnvelope(attemptId, "cb-tenant-2", { requestDigest: TEST_DIGEST });
    const verifier = strictVerifier(store, { nonce: "cb-tenant-2", digest: guestDigest, attemptId });
    const result = settleAttempt(job, attemptId, envelope, signature, verifier, NOW);
    if (isDenial(result)) {
      throw new Error("expected a receipt");
    }
    expect(result.receipt.outcome).toBe("callback-rejected");
  });
});

describe("authoritative driver dispatch (BR3/BR4)", () => {
  it("dispatches a step and preserves inputs through the transport boundary", async () => {
    const setup = setupDriver();
    const claim = issue(setup, "inspectTarget", {
      targetId: "t",
      currentTargets: [targetFixture("t", "v1")],
      currentDocumentVersion: "v1",
    });
    const stub = driverStub(setup.driver, [{ targets: [targetFixture("t", "v1")] }]);
    let sent: TransportInput | undefined;
    const watching: StepTransport = {
      execute: async (input: TransportInput, signal: AbortSignal) => {
        sent = input;
        return stub.transport.execute(input, signal);
      },
    };
    // Mandatory dispatch freshness: target effects require current observed
    // targets and document version at dispatch, not only at authorize time.
    const result = await setup.driver.dispatch(setup.jobId, claim.claimId, watching, {
      nowMs: NOW,
      currentTargets: [targetFixture("t", "v1")],
      currentDocumentVersion: "v1",
    });
    expect(result.receipt.outcome).toBe("observed-success");
    expect(sent?.targetId).toBe("t");
    expect(sent?.documentVersion).toBe("v1");
    expect(sent?.callbackNonce).toBe(claim.callbackNonce);
    expect(sent?.requestDigest).toBe(claim.requestDigest);
  });

  it("refuses target effects without dispatch-time freshness evidence", async () => {
    const setup = setupDriver();
    const claim = issue(setup, "inspectTarget", {
      targetId: "t",
      currentTargets: [targetFixture("t", "v1")],
      currentDocumentVersion: "v1",
    });
    const stub = driverStub(setup.driver);
    const result = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses a fabricated claim with zero transport calls", async () => {
    const setup = setupDriver();
    const stub = driverStub(setup.driver);
    const result = await setup.driver.dispatch(setup.jobId, "claim_forged_1", stub.transport, { nowMs: NOW });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses a reused claim after the budget is spent", async () => {
    const setup = setupDriver({ maximumSteps: 1 });
    const claim = issue(setup);
    const stub = driverStub(setup.driver);
    const first = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(first.receipt.outcome).toBe("observed-success");
    const second = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(second.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(1);
  });

  it("refuses a claim bound to another job", async () => {
    const setupA = setupDriver();
    const driverB = new ControlledDriver(SECRET);
    const registered: unknown = driverB.registerJob(requestFixture({ jobId: "job-b", organizationId: "org-a", projectId: "proj-a" }), NOW);
    if (typeof registered !== "string") {
      throw new Error("expected registration");
    }
    const claim = issue(setupA);
    const stub = driverStub(driverB);
    const result = await driverB.dispatch("job-b", claim.claimId, stub.transport, { nowMs: NOW });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses dispatch on a released lease with zero transport calls", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    expect(setup.driver.releaseLease(setup.jobId).ok).toBe(true);
    const stub = driverStub(setup.driver);
    const result = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses dispatch at exact expiry with zero transport calls", async () => {
    const setup = setupDriver({ expiresAt: NOW });
    const early: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: NOW - 1,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: setup.handle,
    });
    if (isDenial(early)) {
      throw new Error("expected an early claim");
    }
    const stub = driverStub(setup.driver);
    const result = await setup.driver.dispatch(setup.jobId, (early as IssuedClaim).claimId, stub.transport, { nowMs: NOW });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
    expect(setup.driver.snapshot(setup.jobId)?.state).toBe("cancelled");
  });

  it("denies blocked operations at authorize time, including recovery", () => {
    const setup = setupDriver();
    const direct: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: NOW,
      operationId: "submitContactForm",
      viaRecovery: false,
      sessionHandle: setup.handle,
    });
    mustDenialReason(direct, "vendor-write-blocked");
    const recovery: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: NOW,
      operationId: "sendChatMessage",
      viaRecovery: true,
      sessionHandle: setup.handle,
    });
    mustDenialReason(recovery, "vendor-write-blocked");
    expect(setup.driver.snapshot(setup.jobId)?.stepsUsed).toBe(0);
  });

  it("executes concurrent claims once each with accurate accounting", async () => {
    const setup = setupDriver();
    const first = issue(setup);
    const second = issue(setup);
    const stub = driverStub(setup.driver);
    const [a, b] = await Promise.all([
      setup.driver.dispatch(setup.jobId, first.claimId, stub.transport, { nowMs: NOW }),
      setup.driver.dispatch(setup.jobId, second.claimId, stub.transport, { nowMs: NOW }),
    ]);
    expect(a.receipt.outcome).toBe("observed-success");
    expect(b.receipt.outcome).toBe("observed-success");
    expect(stub.calls.length).toBe(2);
    expect(stub.calls[0]?.attemptId).toBe("a_job-a_1");
    expect(stub.calls[1]?.attemptId).toBe("a_job-a_2");
    expect(setup.driver.snapshot(setup.jobId)?.stepsUsed).toBe(2);
  });

  it("runs one transport for a duplicated concurrent claim", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    const stub = driverStub(setup.driver);
    const ids: string[] = [];
    const counting: StepTransport = {
      execute: async (input: TransportInput, signal: AbortSignal) => {
        ids.push(input.attemptId);
        return stub.transport.execute(input, signal);
      },
    };
    const [a, b] = await Promise.all([
      setup.driver.dispatch(setup.jobId, claim.claimId, counting, { nowMs: NOW }),
      setup.driver.dispatch(setup.jobId, claim.claimId, counting, { nowMs: NOW }),
    ]);
    expect(ids.length).toBe(1);
    const outcomes = [a.receipt.outcome, b.receipt.outcome].sort();
    expect(outcomes).toEqual(["claim-refused", "observed-success"]);
  });

  it("preserves cancellation across an awaiting dispatch and keeps the late outcome", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    let deliver!: (value: TransportResult) => void;
    const gated: StepTransport = {
      execute: () => new Promise<TransportResult>((resolve) => {
        deliver = resolve;
      }),
    };
    const pending = setup.driver.dispatch(setup.jobId, claim.claimId, gated, { nowMs: NOW });
    const cancelled = setup.driver.cancel(setup.jobId, NOW + 1, "cancel during transport");
    expect((cancelled as BrowserJob).state).toBe("cancelled");
    const raw = observationFixture("a_job-a_1", { requestDigest: setup.driver.requestDigestOf(setup.jobId) });
    const observation = parseObservation(raw);
    deliver({ envelope: { observation: raw, callbackNonce: claim.callbackNonce }, signature: signObservation(SECRET, observation, claim.callbackNonce) });
    const result = await pending;
    expect(result.job.state).toBe("cancelled");
    expect(result.job.lateResults.length).toBe(1);
    expect(result.job.attempts[0]?.lateResult).toBe(true);
  });

  it("records a throwing transport as unknown without losing the attempt", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    const out = await runDispatch(setup, claim, [{ throws: true }]);
    expect(out.outcome).toBe("transport-unknown");
    expect(out.job.attempts[0]?.state).toBe("outcomeUnknown");
  });

  it("fails after three consecutive no-progress observations with evidence preserved", async () => {
    const setup = setupDriver();
    let job = setup.driver.snapshot(setup.jobId) as BrowserJob;
    for (let round = 0; round < 3; round += 1) {
      const out = await runDispatch(setup, issue(setup), [{ outcome: "noProgress" }]);
      job = out.job;
    }
    expect(job.state).toBe("failed");
    expect(job.consecutiveNoProgress).toBe(3);
    expect(job.attempts.length).toBe(3);
  });

  it("changes strategy while preserving verified results", async () => {
    const setup = setupDriver();
    const first = await runDispatch(setup, issue(setup), [{ outputs: ["variant-price"] }]);
    let job = first.job;
    const attemptId = job.attempts[0]?.attemptId as string;
    job = mustJob(setup.driver.applyCheck(setup.jobId, attemptId, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant-price"],
    }, NOW));
    expect(job.verifiedOutcomes.length).toBe(1);
    for (let round = 0; round < 2; round += 1) {
      const out = await runDispatch(setup, issue(setup), [{ outcome: "noProgress" }]);
      job = out.job;
    }
    expect(job.consecutiveNoProgress).toBe(2);
    job = mustJob(setup.driver.changeStrategy(setup.jobId, "switch to read-only extraction"));
    expect(job.state).toBe("running");
    expect(job.epoch).toBe(2);
    expect(job.consecutiveNoProgress).toBe(0);
    expect(job.verifiedOutcomes.length).toBe(1);
    const resumed = await runDispatch(setup, issue(setup));
    expect(resumed.outcome).toBe("observed-success");
  });

  it("enforces the step budget at the commit point", async () => {
    const setup = setupDriver({ maximumSteps: 1 });
    const firstClaim = issue(setup);
    const secondClaim = issue(setup);
    const stub = driverStub(setup.driver);
    const first = await setup.driver.dispatch(setup.jobId, firstClaim.claimId, stub.transport, { nowMs: NOW });
    expect(first.receipt.outcome).toBe("observed-success");
    const second = await setup.driver.dispatch(setup.jobId, secondClaim.claimId, stub.transport, { nowMs: NOW });
    expect(second.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(1);
    expect(setup.driver.snapshot(setup.jobId)?.stepsUsed).toBe(1);
  });

  it("moves to waiting on a waiting outcome and suspends dispatch", async () => {
    const setup = setupDriver();
    const out = await runDispatch(setup, issue(setup), [{ outcome: "waiting" }]);
    expect(out.job.state).toBe("waitingForSupplier");
    const staleHandle: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: NOW,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: setup.handle,
    });
    mustDenialReason(staleHandle, "lease-invalid");
    const resumed = setup.driver.reacquireLease(setup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-2",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW);
    if (isDenial(resumed)) {
      throw new Error("expected reacquisition on a waiting job");
    }
    const suspended: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: NOW,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: resumed.handle,
    });
    mustDenialReason(suspended, "job-terminal");
  });
});

describe("required outputs and independent checks (R9)", () => {
  it("waiting cannot complete from a generic URL match", async () => {
    const setup = setupDriver({}, undefined, ["variant-price"]);
    const out = await runDispatch(setup, issue(setup), [{ outcome: "waiting" }]);
    // Waiting never proves outputs: verification itself is denied, so no
    // verified outcome exists and completion stays denied.
    mustDenialReason(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: [],
    }, NOW), "unverified");
    mustDenialReason(setup.driver.complete(setup.jobId), "unverified");
  });

  it("noProgress cannot count as a successful task output", async () => {
    const setup = setupDriver({}, undefined, ["variant-price"]);
    const out = await runDispatch(setup, issue(setup), [{ outcome: "noProgress" }]);
    mustDenialReason(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: [],
    }, NOW), "unverified");
    mustDenialReason(setup.driver.complete(setup.jobId), "unverified");
  });

  it("a confirmed output must be evidenced by the observation", async () => {
    const setup = setupDriver({}, undefined, ["variant-price"]);
    const out = await runDispatch(setup, issue(setup));
    mustDenialReason(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant-price"],
    }, NOW), "unverified");
  });

  it("completes with verified coverage of every required output", async () => {
    const setup = setupDriver({}, undefined, ["variant-price"]);
    const out = await runDispatch(setup, issue(setup), [{ outputs: ["variant-price"] }]);
    mustJob(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant-price"],
    }, NOW));
    const completed = mustJob(setup.driver.complete(setup.jobId));
    expect(completed.state).toBe("completed");
  });

  it("denies self-reported checks", async () => {
    const setup = setupDriver();
    const out = await runDispatch(setup, issue(setup));
    mustDenialReason(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "self",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: [],
    }, NOW), "unverified");
  });
});

describe("late outcomes stay truthful (BR9/R13)", () => {
  async function lateOutcome(outcome: ClaimedOutcome): Promise<BrowserJob> {
    const setup = setupDriver();
    const claim = issue(setup);
    let deliver!: (value: TransportResult) => void;
    const gated: StepTransport = {
      execute: () => new Promise<TransportResult>((resolve) => {
        deliver = resolve;
      }),
    };
    const pending = setup.driver.dispatch(setup.jobId, claim.claimId, gated, { nowMs: NOW });
    mustJob(setup.driver.cancel(setup.jobId, NOW + 1, "cancel"));
    const digest = setup.driver.requestDigestOf(setup.jobId) as string;
    const raw = observationFixture("a_job-a_1", { claimedOutcome: outcome, requestDigest: digest });
    const observation = parseObservation(raw);
    deliver({ envelope: { observation: raw, callbackNonce: claim.callbackNonce }, signature: signObservation(SECRET, observation, claim.callbackNonce) });
    const result = await pending;
    expect(result.job.state).toBe("cancelled");
    return result.job;
  }

  it("records a late failure as observedFailure", async () => {
    const job = await lateOutcome("operationFailure");
    expect(job.attempts[0]?.state).toBe("observedFailure");
    expect(job.attempts[0]?.lateResult).toBe(true);
    expect(job.lateResults.length).toBe(1);
  });

  it("records a late blocked policy as observedFailure", async () => {
    const job = await lateOutcome("blockedByPolicy");
    expect(job.attempts[0]?.state).toBe("observedFailure");
  });

  it("records a late success as observedSuccess without reopening", async () => {
    const job = await lateOutcome("success");
    expect(job.attempts[0]?.state).toBe("observedSuccess");
    expect(job.state).toBe("cancelled");
  });

  it("records late no-progress without a terminal transition", async () => {
    const job = await lateOutcome("noProgress");
    expect(job.attempts[0]?.state).toBe("observedSuccess");
    expect(job.state).toBe("cancelled");
    expect(job.consecutiveNoProgress).toBe(1);
  });
});

describe("lease lifecycle on wait/cancel/expiry (R11)", () => {
  const context = { organizationId: "org-a", projectId: "proj-a", jobId: "job-a" };

  it("waiting releases the associated active session", async () => {
    const setup = setupDriver();
    const liveBefore = setup.driver.sessionsForTests().resolve(setup.handle, context, NOW);
    expect(isDenial(liveBefore)).toBe(false);
    const out = await runDispatch(setup, issue(setup), [{ outcome: "waiting" }]);
    expect(out.job.state).toBe("waitingForSupplier");
    expect(setup.driver.trackedLease(setup.jobId)).toBe(undefined);
    mustDenialReason(setup.driver.sessionsForTests().resolve(setup.handle, context, NOW + 1), "lease-invalid");
  });

  it("reacquires after an authorized resume but not after cancellation", async () => {
    const setup = setupDriver();
    const out = await runDispatch(setup, issue(setup), [{ outcome: "waiting" }]);
    expect(out.job.state).toBe("waitingForSupplier");
    const resumed = mustJob(setup.driver.changeStrategy(setup.jobId, "resume after supplier wait"));
    expect(resumed.state).toBe("running");
    const second = setup.driver.reacquireLease(setup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-2",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW);
    expect(isDenial(second)).toBe(false);
    mustJob(setup.driver.cancel(setup.jobId, NOW + 2, "done"));
    const afterCancel = setup.driver.reacquireLease(setup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-3",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW + 2);
    mustDenialReason(afterCancel, "lease-invalid");
  });
});

describe("bounded transport deadline (R14)", () => {
  it("settles a never-settling transport at the deadline", async () => {
    const setup = setupDriver({}, { stepTimeoutMs: 5 });
    const claim = issue(setup);
    const never: StepTransport = {
      execute: () => new Promise<TransportResult>(() => undefined),
    };
    const raced = await Promise.race([
      setup.driver.dispatch(setup.jobId, claim.claimId, never, { nowMs: NOW }),
      Bun.sleep(200).then(() => "still-pending-after-budget" as const),
    ]);
    expect(raced).not.toBe("still-pending-after-budget");
    if (typeof raced === "string") {
      throw new Error("dispatch did not settle");
    }
    expect(raced.receipt.outcome).toBe("transport-timeout");
    expect(raced.job.attempts[0]?.state).toBe("outcomeUnknown");
    expect(raced.job.state).toBe("running");
  });

  it("late delivery after the deadline is recorded on the active job", async () => {
    const setup = setupDriver({}, { stepTimeoutMs: 5 });
    const claim = issue(setup);
    let deliver!: (value: TransportResult) => void;
    const lazy: StepTransport = {
      execute: () => new Promise<TransportResult>((resolve) => {
        deliver = resolve;
      }),
    };
    const first = await setup.driver.dispatch(setup.jobId, claim.claimId, lazy, { nowMs: NOW });
    expect(first.receipt.outcome).toBe("transport-timeout");
    const digest = setup.driver.requestDigestOf(setup.jobId) as string;
    const raw = observationFixture("a_job-a_1", { requestDigest: digest });
    const observation = parseObservation(raw);
    deliver({ envelope: { observation: raw, callbackNonce: claim.callbackNonce }, signature: signObservation(SECRET, observation, claim.callbackNonce) });
    await Bun.sleep(10);
    const job = setup.driver.snapshot(setup.jobId) as BrowserJob;
    expect(job.attempts[0]?.state).toBe("observedSuccess");
    expect(job.attempts[0]?.lateResult).toBe(false);
    expect(job.attempts[0]?.observation?.url).toBe(GOOD_URL);
  });
});

describe("registration authority (BR6)", () => {
  it("rejects a duplicate jobId across tenants", () => {
    const driver = new ControlledDriver(SECRET);
    const first: unknown = driver.registerJob(requestFixture(), NOW);
    expect(typeof first).toBe("string");
    mustDenialReason(driver.registerJob(requestFixture({ organizationId: "org-guest" }), NOW), "conflict");
  });
});

describe("evidence control", () => {
  it("keeps parsed callback evidence deeply frozen", () => {
    const observation = parseObservation(observationFixture("a_job-a_1"));
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.collectedEvidence)).toBe(true);
    expect(Object.isFrozen(observation.observedTargets)).toBe(true);
    expect(Object.isFrozen(observation.meteredUsage)).toBe(true);
  });
});

describe("NR01 complete numeric-address policy", () => {
  it("denies reserved/site-local IPv6 literals even when allowlisted", () => {
    const inputs = [
      "https://[fec0::1]/",
      "https://[::127.0.0.1]/",
      "https://[100::1]/",
      "https://[64:ff9b:1::a00:1]/",
      "https://[4000::1]/",
    ];
    for (const raw of inputs) {
      const allowlisted = [new URL(raw).origin];
      const result = validateDestination(raw, allowlisted);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects site-local IPv6 at every redirect position", () => {
    const bad = "https://[fec0::1]/";
    const origins = ["https://supplier-a.example", new URL(bad).origin];
    for (let n = 0; n < 5; n += 1) {
      const hops = Array(5).fill(GOOD_URL);
      hops[n] = bad;
      expect(validateNavigation(GOOD_URL, hops, origins).ok).toBe(false);
    }
  });

  it("allows public global-unicast IPv6 positive controls", () => {
    for (const raw of ["https://[2606:4700:4700::1111]/", "https://[2001:4860:4860::8888]/"]) {
      expect(validateDestination(raw, [new URL(raw).origin]).ok).toBe(true);
    }
  });

  it("classifies embedded IPv4 and boundary ranges", () => {
    // Public embedded stays reachable; private embedded stays shut.
    for (const raw of ["https://[::ffff:8.8.8.8]/", "https://[2002:0808:0808::1]/"]) {
      expect(validateDestination(raw, [new URL(raw).origin]).ok).toBe(true);
    }
    for (const raw of [
      "https://[::ffff:127.0.0.1]/",
      "https://[2002:7f00:0001::1]/",
      "https://[fc00::1]/",
      "https://[febf::1]/",
      "https://[ff02::1]/",
      "https://[2001:db8::1]/",
      "https://[2001::1]/",
    ]) {
      expect(validateDestination(raw, [new URL(raw).origin]).ok).toBe(false);
    }
  });
});

describe("NR02 request-bound lease authority", () => {
  it("denies initial acquire with mismatched lease identity", () => {
    const driver = new ControlledDriver(SECRET);
    const registered: unknown = driver.registerJob(
      requestFixture({ sessionLease: { leaseId: "authorized", expiresAtMs: NOW + 1_000 } }),
      NOW,
    );
    expect(typeof registered).toBe("string");
    const jobId = registered as string;
    mustDenialReason(
      driver.acquireLease(jobId, {
        organizationId: "org-a",
        projectId: "proj-a",
        leaseId: "replacement",
        expiresAtMs: NOW + 5_000,
        guest: false,
      }, NOW),
      "lease-invalid",
    );
  });

  it("denies extended lifetime beyond the authorized request lease", () => {
    const driver = new ControlledDriver(SECRET);
    const registered: unknown = driver.registerJob(
      requestFixture({ sessionLease: { leaseId: "lease-1", expiresAtMs: NOW + 1_000 } }),
      NOW,
    );
    const jobId = registered as string;
    mustDenialReason(
      driver.acquireLease(jobId, {
        organizationId: "org-a",
        projectId: "proj-a",
        leaseId: "lease-1",
        expiresAtMs: NOW + 5_000,
        guest: false,
      }, NOW),
      "lease-invalid",
    );
  });

  it("refuses dispatch at exact request-lease expiry with zero transport calls", async () => {
    const driver = new ControlledDriver(SECRET);
    const req = parseJobRequest(requestFixture({ sessionLease: { leaseId: "lease-1", expiresAtMs: NOW + 5 } }));
    const jobId = driver.registerJob(req, NOW) as string;
    const lease = driver.acquireLease(jobId, {
      organizationId: req.organizationId,
      projectId: req.projectId,
      leaseId: "lease-1",
      expiresAtMs: NOW + 5,
      guest: false,
    }, NOW);
    if (isDenial(lease)) {
      throw new Error("expected lease");
    }
    const claim = driver.authorize({
      jobId,
      nowMs: NOW,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: (lease as SessionLease).handle,
    });
    if (isDenial(claim)) {
      throw new Error("expected claim");
    }
    const stub = driverStub(driver);
    const result = await driver.dispatch(jobId, (claim as IssuedClaim).claimId, stub.transport, { nowMs: NOW + 5 });
    expect(result.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("denies released-lease dispatch and supports authorized resume", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    expect(setup.driver.releaseLease(setup.jobId).ok).toBe(true);
    const stub = driverStub(setup.driver);
    const refused = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(refused.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
    // Authorized resume: waiting releases, reacquires with a fresh handle
    // bounded by the same request expiry, then resumes and dispatches once.
    const waitingSetup = setupDriver();
    const waitingOut = await runDispatch(waitingSetup, issue(waitingSetup), [{ outcome: "waiting" }]);
    expect(waitingOut.job.state).toBe("waitingForSupplier");
    const resumed = mustJob(waitingSetup.driver.changeStrategy(waitingSetup.jobId, "resume after supplier wait"));
    expect(resumed.state).toBe("running");
    const fresh = waitingSetup.driver.reacquireLease(waitingSetup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-2",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW);
    expect(isDenial(fresh)).toBe(false);
    const handle = (fresh as SessionLease).handle;
    const nextClaim: unknown = waitingSetup.driver.authorize({
      jobId: waitingSetup.jobId,
      nowMs: NOW,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: handle,
    });
    expect(isDenial(nextClaim)).toBe(false);
  });
});

describe("NR04 mandatory dispatch freshness", () => {
  it("requires current targets and document at dispatch for target effects", async () => {
    const setup = setupDriver();
    const claim = issue(setup, "inspectTarget", {
      targetId: "t",
      currentTargets: [targetFixture("t", "v1")],
      currentDocumentVersion: "v1",
    });
    const stub = driverStub(setup.driver);
    const absent = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, { nowMs: NOW });
    expect(absent.receipt.outcome).toBe("claim-refused");
    expect(stub.calls.length).toBe(0);
  });

  it("denies stale, missing, and occluded target evidence with zero calls", async () => {
    for (const variant of ["stale", "missing", "occluded"] as const) {
      const setup = setupDriver();
      const claim = issue(setup, "inspectTarget", {
        targetId: "t",
        currentTargets: [targetFixture("t", "v1")],
        currentDocumentVersion: "v1",
      });
      const stub = driverStub(setup.driver);
      const options =
        variant === "stale"
          ? { nowMs: NOW, currentTargets: [targetFixture("t", "v2")], currentDocumentVersion: "v2" }
          : variant === "occluded"
            ? { nowMs: NOW, currentTargets: [targetFixture("t", "v1", true)], currentDocumentVersion: "v1" }
            : { nowMs: NOW, currentTargets: [], currentDocumentVersion: "v1" };
      const result = await setup.driver.dispatch(setup.jobId, claim.claimId, stub.transport, options);
      expect(result.receipt.outcome).toBe("claim-refused");
      expect(stub.calls.length).toBe(0);
    }
  });
});

describe("NR05 authoritative clock and expiry fencing", () => {
  it("fences exact expiry timer and releases the lease", async () => {
    const setup = setupDriver({ expiresAt: NOW + 10 });
    const claim = issue(setup);
    let signal: AbortSignal | undefined;
    const result = await setup.driver.dispatch(setup.jobId, claim.claimId, {
      execute: (_input: TransportInput, sg: AbortSignal) => {
        signal = sg;
        return new Promise<TransportResult>(() => undefined);
      },
    }, { nowMs: NOW });
    expect(signal?.aborted).toBe(true);
    expect(result.job.state).toBe("cancelled");
    expect(setup.driver.trackedLease(setup.jobId)).toBeUndefined();
  });

  it("cannot accept success after synchronous overrun past expiry", async () => {
    const start = Date.now();
    const driver = new ControlledDriver(SECRET);
    const req = parseJobRequest(requestFixture({
      expiresAt: start + 5,
      sessionLease: { leaseId: "lease-1", expiresAtMs: start + 60_000 },
    }));
    const jobId = driver.registerJob(req, start) as string;
    const lease = driver.acquireLease(jobId, {
      organizationId: req.organizationId,
      projectId: req.projectId,
      leaseId: "lease-1",
      expiresAtMs: start + 60_000,
      guest: false,
    }, start);
    const claim = driver.authorize({
      jobId,
      nowMs: start,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: (lease as SessionLease).handle,
    }) as IssuedClaim;
    const out = await driver.dispatch(jobId, claim.claimId, {
      execute: (input: TransportInput) => {
        const spinUntil = Date.now() + 15;
        while (Date.now() < spinUntil) {
          // Intentional synchronous overrun past the 5ms job expiry.
        }
        const digest = driver.requestDigestOf(jobId) as string;
        const raw = observationFixture(input.attemptId, { jobId, requestDigest: digest });
        const observation = parseObservation(raw);
        return Promise.resolve({
          envelope: { observation: raw, callbackNonce: input.callbackNonce },
          signature: signObservation(SECRET, observation, input.callbackNonce),
        });
      },
    }, { nowMs: start });
    expect(out.job.state).toBe("cancelled");
  });

  it("keeps late outcomes on the fenced job without reopening", async () => {
    const start = Date.now();
    const driver = new ControlledDriver(SECRET);
    const req = parseJobRequest(requestFixture({
      expiresAt: start + 10,
      sessionLease: { leaseId: "lease-1", expiresAtMs: start + 60_000 },
    }));
    const jobId = driver.registerJob(req, start) as string;
    const lease = driver.acquireLease(jobId, {
      organizationId: req.organizationId,
      projectId: req.projectId,
      leaseId: "lease-1",
      expiresAtMs: start + 60_000,
      guest: false,
    }, start);
    const claim = driver.authorize({
      jobId,
      nowMs: start,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: (lease as SessionLease).handle,
    }) as IssuedClaim;
    let deliver!: (value: TransportResult) => void;
    const pending = driver.dispatch(jobId, claim.claimId, {
      execute: () => new Promise<TransportResult>((resolve) => {
        deliver = resolve;
      }),
    }, { nowMs: start });
    await Bun.sleep(25);
    const digest = driver.requestDigestOf(jobId) as string;
    const expectation = driver.expectationFor(jobId, `a_${jobId}_1`);
    const raw = observationFixture(`a_${jobId}_1`, {
      jobId,
      observationVersion: expectation?.version ?? 1,
      requestDigest: digest,
    });
    const observation = parseObservation(raw);
    deliver({
      envelope: { observation: raw, callbackNonce: claim.callbackNonce },
      signature: signObservation(SECRET, observation, claim.callbackNonce),
    });
    const result = await pending;
    // The timeout path already fenced at expiry; the delayed result stays on
    // the cancelled job without reopening it.
    expect(driver.snapshot(jobId)?.state).toBe("cancelled");
    void result;
  });

  it("enforces the 15-minute active-execution ceiling", () => {
    const setup = setupDriver();
    const pastCeiling = NOW + 15 * 60 * 1_000;
    const deniedClaim: unknown = setup.driver.authorize({
      jobId: setup.jobId,
      nowMs: pastCeiling,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: setup.handle,
    });
    mustDenialReason(deniedClaim, "job-expired");
  });
});

describe("NR06 replay horizon and retention", () => {
  function expectationAt(nonce: string, nowMs: number, validUntilMs: number): CallbackExpectation {
    return {
      nonce,
      requestDigest: TEST_DIGEST,
      jobId: "job-a",
      attemptId: "a_job-a_1",
      version: 1,
      validUntilMs,
      nowMs,
    };
  }

  it("rejects at exact horizon equality and after it", () => {
    const store = createMemoryNonceStore();
    const first = signedEnvelope("a_job-a_1", "cb-horizon-1");
    expect(verifyCallback(SECRET, store, first.envelope, first.signature, expectationAt("cb-horizon-1", NOW, NOW + 1_000)).ok).toBe(true);
    const atExpiry = signedEnvelope("a_job-a_1", "cb-horizon-1");
    expect(verifyCallback(SECRET, store, atExpiry.envelope, atExpiry.signature, expectationAt("cb-horizon-1", NOW + 1_000, NOW + 1_000)).ok).toBe(false);
    const afterExpiry = signedEnvelope("a_job-a_1", "cb-horizon-1");
    expect(verifyCallback(SECRET, store, afterExpiry.envelope, afterExpiry.signature, expectationAt("cb-horizon-1", NOW + 1_001, NOW + 1_000)).ok).toBe(false);
  });

  it("refuses already-expired markers and retains replay evidence", () => {
    const store = createMemoryNonceStore();
    expect(store.tryConsume("cb-expired-new", NOW, NOW)).toBe(false);
    const first = signedEnvelope("a_job-a_1", "cb-retain-1");
    expect(verifyCallback(SECRET, store, first.envelope, first.signature, expectationAt("cb-retain-1", NOW, NOW + 1_000)).ok).toBe(true);
    // Retained past expiry: the same signature is still replay-detected (or
    // horizon-rejected), never acceptable again.
    const replay = signedEnvelope("a_job-a_1", "cb-retain-1");
    expect(verifyCallback(SECRET, store, replay.envelope, replay.signature, expectationAt("cb-retain-1", NOW + 2_000, NOW + 1_000)).ok).toBe(false);
    expect(store.isConsumed("cb-retain-1", NOW + 2_000)).toBe(true);
  });

  it("fails closed at capacity without evicting live markers", () => {
    const store = createMemoryNonceStore();
    const first = signedEnvelope("a_job-a_1", "cb-cap-nr06");
    expect(verifyCallback(SECRET, store, first.envelope, first.signature, expectationAt("cb-cap-nr06", NOW, NOW + 120_000)).ok).toBe(true);
    for (let n = 0; n < 9_999; n += 1) {
      expect(store.tryConsume(`nr06-other-${n}`, NOW + 120_000, NOW)).toBe(true);
    }
    expect(store.tryConsume("nr06-fresh", NOW + 120_000, NOW)).toBe(false);
  });
});

describe("NR07 shared destination validation", () => {
  it("late disallowed URL is never observed success", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    let input!: TransportInput;
    let deliver!: (value: TransportResult) => void;
    const pending = setup.driver.dispatch(setup.jobId, claim.claimId, {
      execute: (seen: TransportInput) => new Promise<TransportResult>((resolve) => {
        input = seen;
        deliver = resolve;
      }),
    }, { nowMs: NOW });
    mustJob(setup.driver.cancel(setup.jobId, NOW + 1, "cancel"));
    const digest = setup.driver.requestDigestOf(setup.jobId) as string;
    const expectation = setup.driver.expectationFor(setup.jobId, input.attemptId);
    const raw = observationFixture(input.attemptId, {
      jobId: setup.jobId,
      url: "https://127.0.0.1/",
      observationVersion: expectation?.version ?? 1,
      requestDigest: digest,
    });
    const observation = parseObservation(raw);
    deliver({
      envelope: { observation: raw, callbackNonce: input.callbackNonce },
      signature: signObservation(SECRET, observation, input.callbackNonce),
    });
    const result = await pending;
    expect(result.job.attempts[0]?.state).not.toBe("observedSuccess");
  });

  it("checks disallowed URL before nonce admission", () => {
    const job = createJob(parseJobRequest(requestFixture()), NOW);
    const prepared = prepareAttempt(job, mustClaim(job), NOW);
    if (isDenial(prepared)) {
      throw new Error("expected preparation");
    }
    const store = createMemoryNonceStore();
    const raw = observationFixture(prepared.attemptId, { url: "https://127.0.0.1/" });
    const observation = parseObservation(raw);
    const nonce = "cb-policy-precheck-1";
    const signature = signObservation(SECRET, observation, nonce);
    const verifier: CallbackVerifier = {
      verify: (envelope: unknown, sig: unknown, version: number) => verifyCallback(SECRET, store, envelope, sig, {
        nonce,
        requestDigest: TEST_DIGEST,
        jobId: "job-a",
        attemptId: prepared.attemptId,
        version,
        validUntilMs: NOW + 120_000,
        nowMs: NOW,
      }),
    };
    const result = settleAttempt(prepared.job, prepared.attemptId, { observation: raw, callbackNonce: nonce }, signature, verifier, NOW);
    if (isDenial(result)) {
      throw new Error("expected a receipt");
    }
    expect(result.receipt.outcome).toBe("callback-rejected");
    expect(store.isConsumed(nonce, NOW)).toBe(false);
  });
});

describe("NR08 sibling in-flight reconciliation", () => {
  it("preserves the second result when a sibling enters waiting first", async () => {
    const setup = setupDriver();
    const first = issue(setup);
    const second = issue(setup);
    let firstInput!: TransportInput;
    let secondInput!: TransportInput;
    let firstDeliver!: (value: TransportResult) => void;
    let secondDeliver!: (value: TransportResult) => void;
    const firstPending = setup.driver.dispatch(setup.jobId, first.claimId, {
      execute: (input: TransportInput) => new Promise<TransportResult>((resolve) => {
        firstInput = input;
        firstDeliver = resolve;
      }),
    }, { nowMs: NOW });
    const secondPending = setup.driver.dispatch(setup.jobId, second.claimId, {
      execute: (input: TransportInput) => new Promise<TransportResult>((resolve) => {
        secondInput = input;
        secondDeliver = resolve;
      }),
    }, { nowMs: NOW });
    const digest = setup.driver.requestDigestOf(setup.jobId) as string;
    const firstExpectation = setup.driver.expectationFor(setup.jobId, firstInput.attemptId);
    const firstRaw = observationFixture(firstInput.attemptId, {
      jobId: setup.jobId,
      claimedOutcome: "waiting",
      observationVersion: firstExpectation?.version ?? 1,
      requestDigest: digest,
    });
    firstDeliver({
      envelope: { observation: firstRaw, callbackNonce: firstInput.callbackNonce },
      signature: signObservation(SECRET, parseObservation(firstRaw), firstInput.callbackNonce),
    });
    await firstPending;
    const secondExpectation = setup.driver.expectationFor(setup.jobId, secondInput.attemptId);
    const secondRaw = observationFixture(secondInput.attemptId, {
      jobId: setup.jobId,
      observationVersion: secondExpectation?.version ?? 1,
      requestDigest: digest,
    });
    secondDeliver({
      envelope: { observation: secondRaw, callbackNonce: secondInput.callbackNonce },
      signature: signObservation(SECRET, parseObservation(secondRaw), secondInput.callbackNonce),
    });
    const result = await secondPending;
    expect(result.job.attempts.find((item) => item.attemptId === secondInput.attemptId)?.observation).toBeDefined();
    expect(result.job.state).toBe("waitingForSupplier");
    expect(result.job.stepsUsed).toBe(2);
  });

  it("preserves both orders and a failing sibling without reopening", async () => {
    for (const firstOutcome of ["waiting", "success"] as const) {
      const setup = setupDriver();
      const first = issue(setup);
      const second = issue(setup);
      const stub = driverStub(setup.driver, [{ outcome: firstOutcome }, { outcome: "operationFailure" }]);
      // Dispatch sequentially to keep ordinals deterministic; the second
      // in-flight result on the waiting/failed job is still preserved.
      const firstResult = await setup.driver.dispatch(setup.jobId, first.claimId, {
        execute: (input: TransportInput, signal: AbortSignal) => stub.transport.execute(input, signal),
      }, { nowMs: NOW });
      void firstResult;
      const secondResult = await setup.driver.dispatch(setup.jobId, second.claimId, stub.transport, { nowMs: NOW });
      // If the first moved to waiting, the second cannot dispatch (waiting is
      // terminal for new work) — that refusal itself preserves accounting and
      // authorizes no further effect. If the first stayed running, the second
      // settles as observed failure without reopening.
      if (firstOutcome === "waiting") {
        expect(secondResult.receipt.outcome).toBe("claim-refused");
        expect(setup.driver.snapshot(setup.jobId)?.stepsUsed).toBe(1);
      } else {
        expect(secondResult.receipt.outcome).toBe("observed-failure");
      }
    }
  });
});

describe("NR09 meaningful output completion", () => {
  it("rejects completion for outputless jobs", () => {
    const setup = setupDriver();
    mustDenialReason(setup.driver.complete(setup.jobId), "missing-outputs");
  });

  it("waiting with echoed output IDs cannot verify or complete", async () => {
    const setup = setupDriver({}, undefined, ["variant"]);
    const out = await runDispatch(setup, issue(setup), [{ outcome: "waiting", outputs: ["variant"] }]);
    mustDenialReason(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant"],
    }, NOW), "unverified");
    mustDenialReason(setup.driver.complete(setup.jobId), "unverified");
  });

  it("only successful production can verify outputs", async () => {
    const setup = setupDriver({}, undefined, ["variant-price"]);
    const out = await runDispatch(setup, issue(setup), [{ outputs: ["variant-price"] }]);
    mustJob(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant-price"],
    }, NOW));
    expect(mustJob(setup.driver.complete(setup.jobId)).state).toBe("completed");
  });
});

describe("NR10 terminal lease release", () => {
  it("releases the session on completion and fails closed afterwards", async () => {
    const setup = setupDriver({}, undefined, ["variant"]);
    const out = await runDispatch(setup, issue(setup), [{ outputs: ["variant"] }]);
    mustJob(setup.driver.applyCheck(setup.jobId, out.job.attempts[0]?.attemptId as string, {
      checker: "independent",
      observedUrl: GOOD_URL,
      matches: true,
      confirmedOutputs: ["variant"],
    }, NOW));
    mustJob(setup.driver.complete(setup.jobId));
    expect(setup.driver.trackedLease(setup.jobId)).toBeUndefined();
    mustDenialReason(setup.driver.acquireLease(setup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-1",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW), "lease-invalid");
    mustDenialReason(setup.driver.reacquireLease(setup.jobId, {
      organizationId: "org-a",
      projectId: "proj-a",
      leaseId: "lease-2",
      expiresAtMs: NOW + 60_000,
      guest: false,
    }, NOW), "lease-invalid");
  });

  it("releases on failure, cancellation, expiry, and waiting", async () => {
    const failedSetup = setupDriver();
    for (let round = 0; round < 3; round += 1) {
      await runDispatch(failedSetup, issue(failedSetup), [{ outcome: "noProgress" }]);
    }
    expect(failedSetup.driver.snapshot(failedSetup.jobId)?.state).toBe("failed");
    expect(failedSetup.driver.trackedLease(failedSetup.jobId)).toBeUndefined();

    const cancelSetup = setupDriver();
    mustJob(cancelSetup.driver.cancel(cancelSetup.jobId, NOW + 1, "cancel"));
    expect(cancelSetup.driver.trackedLease(cancelSetup.jobId)).toBeUndefined();

    const expirySetup = setupDriver({ expiresAt: NOW + 5 });
    const early: unknown = expirySetup.driver.authorize({
      jobId: expirySetup.jobId,
      nowMs: NOW,
      operationId: "readVisibleText",
      viaRecovery: false,
      sessionHandle: expirySetup.handle,
    });
    if (isDenial(early)) {
      throw new Error("expected early claim");
    }
    const stub = driverStub(expirySetup.driver);
    await expirySetup.driver.dispatch(expirySetup.jobId, (early as IssuedClaim).claimId, stub.transport, { nowMs: NOW + 5 });
    expect(expirySetup.driver.snapshot(expirySetup.jobId)?.state).toBe("cancelled");
    expect(expirySetup.driver.trackedLease(expirySetup.jobId)).toBeUndefined();

    const waitingSetup = setupDriver();
    const waitingOut = await runDispatch(waitingSetup, issue(waitingSetup), [{ outcome: "waiting" }]);
    expect(waitingOut.job.state).toBe("waitingForSupplier");
    expect(waitingSetup.driver.trackedLease(waitingSetup.jobId)).toBeUndefined();
  });
});

describe("NR15 synchronous transport errors", () => {
  it("routes sync throws through typed unknown with timer cleanup", async () => {
    const setup = setupDriver();
    const claim = issue(setup);
    const result = await setup.driver.dispatch(setup.jobId, claim.claimId, {
      execute: () => {
        throw new Error("controlled synchronous failure");
      },
    }, { nowMs: NOW, timeoutMs: 5 });
    expect(result.receipt.outcome).toBe("transport-unknown");
    expect(result.job.attempts[0]?.state).toBe("outcomeUnknown");
    expect(result.job.attempts[0]?.attemptId).toBe(result.receipt.attemptId);
    await Bun.sleep(8);
    // No automatic redispatch: exactly one attempt, still unknown.
    expect(setup.driver.snapshot(setup.jobId)?.attempts.length).toBe(1);
    expect(setup.driver.snapshot(setup.jobId)?.attempts[0]?.state).toBe("outcomeUnknown");
  });
});
