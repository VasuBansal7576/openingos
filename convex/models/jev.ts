import {
  applyIfCurrent,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_MAX_RETRY_AFTER_MS,
  JEV_MAX_REQUEST_BYTES,
  JEV_MAX_RESPONSE_BYTES,
  JEV_PINNED_MODEL,
  jevAttemptOnce,
  validChoiceQuestion,
  validNoulQuestion,
  validScoreQuestion,
  type JevAnswer,
  type JevAttemptResult,
  type JevFetch,
  type JevAttemptOptions,
  type JevQuestion,
} from "../../proofs/jev/jev-boundary.js";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { internalAction, env } from "../_generated/server";
import { v } from "convex/values";
import { f1InternalQuery } from "../server.js";
import * as attempts from "../execution/attempts.js";
import * as operations from "../execution/operations.js";
import { checkProjectAccess, denialValidator } from "../access/checks.js";
import { lookupCapability } from "../shared/scope.js";
import { canonicalJson, parseBoundedPayloadJson } from "../shared/hashing.js";
import { sha256BindingOk, sha256Hex } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";

export const JEV_MAX_ATTEMPTS = 3;
export const JEV_WORKLOAD_BINDING_VERSION = "jev-workload-v1" as const;
export const JEV_WORKLOAD_INPUT_VERSION_KEY = "jevWorkloadSha256" as const;
export const JEV_WORKLOAD_BINDING_PREFIX = "[openingos-jev-workload:v1" as const;
export const JEV_PRICING_ENV_VARS = {
  attemptMaxCostMicroUsd: "JEV_ATTEMPT_MAX_COST_MICRO_USD",
  pricingVersion: "JEV_PRICING_VERSION",
  pricingBasis: "JEV_PRICING_BASIS",
} as const;

export interface JevPricingPolicy {
  readonly attemptMaxCostMicroUsd: number;
  readonly maxReservationMicroUsd: number;
  readonly pricingVersion: string;
  readonly pricingBasis: string;
  readonly reservationPricingBasis: string;
}

export type JevPricingPolicyResult =
  | { readonly ok: true; readonly policy: JevPricingPolicy }
  | { readonly ok: false; readonly code: "invalid-pricing-config"; readonly message: string };

export interface JevWorkload {
  readonly state: unknown;
  readonly questions: Record<string, JevQuestion>;
  readonly inputVersion: string;
}

function invalidJevPricingPolicy(): JevPricingPolicyResult {
  return {
    ok: false,
    code: "invalid-pricing-config",
    message: "Jev pricing policy is unavailable or invalid",
  };
}

function reservationPricingBasis(
  pricingVersion: string,
  pricingBasis: string,
): string {
  return canonicalJson({
    basis: pricingBasis,
    provider: "jev",
    version: pricingVersion,
  });
}

/**
 * Read the owner-configured Jev allowance policy at the server boundary.
 * Pricing is intentionally not a source constant: the owner must configure
 * a versioned basis and a positive safe-integer per-attempt maximum before
 * any operation can claim or dispatch.
 */
export function loadJevPricingPolicy(): JevPricingPolicyResult {
  const rawCost = env[JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd]?.trim();
  const pricingVersion = env[JEV_PRICING_ENV_VARS.pricingVersion]?.trim();
  const pricingBasis = env[JEV_PRICING_ENV_VARS.pricingBasis]?.trim();
  if (
    rawCost === undefined ||
    pricingVersion === undefined ||
    pricingVersion.length === 0 ||
    pricingBasis === undefined ||
    pricingBasis.length === 0 ||
    !/^[0-9]+$/.test(rawCost)
  ) {
    return invalidJevPricingPolicy();
  }

  const attemptMaxCostMicroUsd = Number(rawCost);
  if (!Number.isSafeInteger(attemptMaxCostMicroUsd) || attemptMaxCostMicroUsd <= 0) {
    return invalidJevPricingPolicy();
  }
  const maxReservationMicroUsd = attemptMaxCostMicroUsd * JEV_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxReservationMicroUsd) || maxReservationMicroUsd <= 0) {
    return invalidJevPricingPolicy();
  }

  return {
    ok: true,
    policy: {
      attemptMaxCostMicroUsd,
      maxReservationMicroUsd,
      pricingVersion,
      pricingBasis,
      reservationPricingBasis: reservationPricingBasis(pricingVersion, pricingBasis),
    },
  };
}

const JEV_RETRY_BACKOFF_MS = [250, 1_000] as const;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type JevRetryKind = "none" | "retryable" | "nonretryable";

type JevRetryAdvice = {
  kind: JevRetryKind;
  status: number | null;
  retryAfterMs: number | null;
};

type JevClassificationResult =
  | {
      outcome: "decided";
      model: "jev-1.13.0";
      answers: Record<string, JevAnswer>;
      usage: { input_tokens: number; output_tokens: number };
      latencyMs: number;
      inputVersion: string;
      attempts: number;
    }
  | {
      outcome: "needsReview" | "unavailable" | "stale";
      reason: string;
      retry: JevRetryAdvice;
      latencyMs: number;
      inputVersion: string;
      attempts: number;
    };

export interface JevClassificationOptions {
  apiKey: string | undefined;
  state: unknown;
  questions: Record<string, JevQuestion>;
  inputVersion: string;
  timeoutMs?: number;
  fetchImpl?: JevFetch;
  signal?: AbortSignal;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  currentInputVersion?: () => string | Promise<string>;
  isCurrentAuthority?: () => boolean | Promise<boolean>;
  /**
   * Durable server-side authority check invoked before every transport
   * attempt, including the initial attempt and after retry backoff.  The
   * synchronous callbacks above remain available for controlled adapter
   * tests and callers that already own a local fence.
   */
  beforeAttempt?: () =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;
}

const retryAdviceValidator = v.object({
  kind: v.union(v.literal("none"), v.literal("retryable"), v.literal("nonretryable")),
  status: v.union(v.number(), v.null()),
  retryAfterMs: v.union(v.number(), v.null()),
});

const answerValidator = v.union(
  v.object({ type: v.literal("noul"), noul: v.number() }),
  v.object({
    type: v.literal("choice"),
    choice: v.string(),
    probabilities: v.record(v.string(), v.number()),
    confidence: v.number(),
  }),
  v.object({
    type: v.literal("score"),
    score: v.number(),
    legend: v.record(v.string(), v.string()),
    probabilities: v.record(v.string(), v.number()),
    confidence: v.number(),
  }),
);

const classificationResultValidator = v.union(
  v.object({
    outcome: v.literal("decided"),
    model: v.literal("jev-1.13.0"),
    answers: v.record(v.string(), answerValidator),
    usage: v.object({ input_tokens: v.number(), output_tokens: v.number() }),
    latencyMs: v.number(),
    inputVersion: v.string(),
    attempts: v.number(),
  }),
  v.object({
    outcome: v.literal("needsReview"),
    reason: v.string(),
    retry: retryAdviceValidator,
    latencyMs: v.number(),
    inputVersion: v.string(),
    attempts: v.number(),
  }),
  v.object({
    outcome: v.literal("unavailable"),
    reason: v.string(),
    retry: retryAdviceValidator,
    latencyMs: v.number(),
    inputVersion: v.string(),
    attempts: v.number(),
  }),
  v.object({
    outcome: v.literal("stale"),
    reason: v.string(),
    retry: retryAdviceValidator,
    latencyMs: v.number(),
    inputVersion: v.string(),
    attempts: v.number(),
  }),
);

const actionResultValidator = v.union(classificationResultValidator, denialValidator);

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return>
  ? Args
  : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return>
  ? Awaited<Return>
  : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _Visibility, infer Args, infer _Return>
  ? Args
  : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _Visibility, infer _Args, infer Return>
  ? Awaited<Return>
  : never;

const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const recordOutcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.recordOutcome>,
  MutationReturn<typeof attempts.recordOutcome>
>("execution/attempts:recordOutcome");

function staleResult(inputVersion: string, reason: string, attempts: number): JevClassificationResult {
  return {
    outcome: "stale",
    reason,
    retry: { kind: "none", status: null, retryAfterMs: null },
    latencyMs: 0,
    inputVersion,
    attempts,
  };
}

function unavailableResult(inputVersion: string, reason: string, attempts: number): JevClassificationResult {
  return {
    outcome: "unavailable",
    reason,
    retry: { kind: "none", status: null, retryAfterMs: null },
    latencyMs: 0,
    inputVersion,
    attempts,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseQuestions(value: unknown): Record<string, JevQuestion> | null {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) return null;
  const result: Record<string, JevQuestion> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (id === "__proto__" || id === "constructor" || id === "prototype" || !isPlainRecord(raw)) return null;
    const type = raw["type"];
    if (type === "noul") {
      const question = raw as unknown as Extract<JevQuestion, { type: "noul" }>;
      if (!validNoulQuestion(question)) return null;
      result[id] = question;
      continue;
    }
    if (type === "choice") {
      const question = raw as unknown as Extract<JevQuestion, { type: "choice" }>;
      if (!validChoiceQuestion(question)) return null;
      result[id] = question;
      continue;
    }
    if (type === "score") {
      const question = raw as unknown as Extract<JevQuestion, { type: "score" }>;
      if (!validScoreQuestion(question)) return null;
      result[id] = question;
      continue;
    }
    return null;
  }
  return result;
}

function isBoundedNonEmptyString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function validJevState(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isPlainRecord(value) && Object.keys(value).length > 0;
}

type RetrySnapshot = { ok: true; value: unknown } | { ok: false };

function copyRetryInput(value: unknown, depth: number, ancestors: Set<object>): RetrySnapshot {
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (depth > 64 || typeof value !== "object") return { ok: false };
  if (ancestors.has(value)) return { ok: false };
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      ancestors.delete(value);
      return { ok: false };
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
        ancestors.delete(value);
        return { ok: false };
      }
      const entry = copyRetryInput(descriptor.value, depth + 1, ancestors);
      if (!entry.ok) {
        ancestors.delete(value);
        return { ok: false };
      }
      copy.push(entry.value);
    }
    ancestors.delete(value);
    return { ok: true, value: copy };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return { ok: false };
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
      ancestors.delete(value);
      return { ok: false };
    }
    const entry = copyRetryInput(descriptor.value, depth + 1, ancestors);
    if (!entry.ok) {
      ancestors.delete(value);
      return { ok: false };
    }
    if (key === "__proto__") {
      Object.defineProperty(copy, key, {
        value: entry.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      copy[key] = entry.value;
    }
  }
  ancestors.delete(value);
  return { ok: true, value: copy };
}

function immutableRetryInput(value: unknown): RetrySnapshot {
  try {
    const copy = copyRetryInput(value, 0, new Set<object>());
    if (!copy.ok) return copy;

    const freeze = (entry: unknown): void => {
      if (typeof entry !== "object" || entry === null || Object.isFrozen(entry)) return;
      Object.freeze(entry);
      if (Array.isArray(entry)) {
        for (const child of entry) freeze(child);
        return;
      }
      for (const key of Object.keys(entry)) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor !== undefined && "value" in descriptor) freeze(descriptor.value);
      }
    };
    freeze(copy.value);
    return copy;
  } catch {
    return { ok: false };
  }
}

type RetryRequest = {
  state: unknown;
  questions: Record<string, JevQuestion>;
  inputVersion: string;
};

type ParsedJevWorkload =
  | { readonly ok: true; readonly value: RetryRequest }
  | { readonly ok: false; readonly reason: string };

function parseJevWorkload(
  state: unknown,
  questions: unknown,
  inputVersion: string,
): ParsedJevWorkload {
  if (!isBoundedNonEmptyString(inputVersion, 256)) {
    return { ok: false, reason: "missing-input-version" };
  }
  const stateSnapshot = immutableRetryInput(state);
  const questionSnapshot = immutableRetryInput(questions);
  if (!stateSnapshot.ok || !questionSnapshot.ok) {
    return { ok: false, reason: "non-json-workload" };
  }
  if (!validJevState(stateSnapshot.value)) {
    return { ok: false, reason: "invalid-state" };
  }
  const parsedQuestions = parseQuestions(questionSnapshot.value);
  if (parsedQuestions === null) {
    return { ok: false, reason: "invalid-questions" };
  }
  const request: RetryRequest = {
    state: stateSnapshot.value,
    questions: parsedQuestions,
    inputVersion,
  };
  try {
    const body = JSON.stringify({
      model: JEV_PINNED_MODEL,
      state: request.state,
      questions: request.questions,
    });
    if (new TextEncoder().encode(body).byteLength > JEV_MAX_REQUEST_BYTES) {
      return { ok: false, reason: "request-too-large" };
    }
  } catch {
    return { ok: false, reason: "request-serialize-failed" };
  }
  Object.freeze(request);
  Object.freeze(parsedQuestions);
  return { ok: true, value: request };
}

function freezeRetryRequest(options: JevClassificationOptions): RetryRequest | null {
  const parsed = parseJevWorkload(options.state, options.questions, options.inputVersion);
  return parsed.ok ? parsed.value : null;
}

function workloadBindingText(workloadSha256: string): string {
  return `${JEV_WORKLOAD_BINDING_PREFIX} sha256=${workloadSha256}]`;
}

function parseJevWorkloadBinding(
  payload: unknown,
): { readonly ok: true; readonly workloadSha256: string } | { readonly ok: false; readonly reason: string } {
  if (!isPlainRecord(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "query")) {
    return { ok: false, reason: "jev-workload-binding-shape" };
  }
  const query = payload["query"];
  if (!isBoundedNonEmptyString(query, 65_536)) {
    return { ok: false, reason: "jev-workload-binding-query" };
  }
  const markerIndex = query.indexOf(JEV_WORKLOAD_BINDING_PREFIX);
  if (
    markerIndex <= 0 ||
    markerIndex !== query.lastIndexOf(JEV_WORKLOAD_BINDING_PREFIX) ||
    query.slice(0, markerIndex).trim().length === 0
  ) {
    return { ok: false, reason: "jev-workload-binding-missing" };
  }
  const marker = query.slice(markerIndex);
  const match = /^\[openingos-jev-workload:v1 sha256=([0-9a-f]{64})\]$/.exec(marker);
  if (match === null || match[1] === undefined) {
    return { ok: false, reason: "jev-workload-binding-shape" };
  }
  return { ok: true, workloadSha256: match[1] };
}

function workloadBindingMatches(payload: unknown, workloadSha256: string): boolean {
  const binding = parseJevWorkloadBinding(payload);
  return binding.ok && binding.workloadSha256 === workloadSha256;
}

/** Compute the digest bound into the approved workflow payload. */
export async function jevWorkloadSha256(workload: JevWorkload): Promise<string> {
  const parsed = parseJevWorkload(workload.state, workload.questions, workload.inputVersion);
  if (!parsed.ok) throw new Error(`invalid Jev workload: ${parsed.reason}`);
  return sha256Hex({ version: JEV_WORKLOAD_BINDING_VERSION, workload: parsed.value });
}

/**
 * Add the complete Jev workload digest to the generic research query carrier.
 * The provider request remains the ADR-0005 `{ model, state, questions }`
 * boundary; this marker binds that request to the approved operation without
 * placing state or question instructions in the generic workflow payload.
 */
export async function bindJevWorkloadPayload(
  workload: JevWorkload,
  workflowQuery: string,
): Promise<string> {
  const parsed = parseJevWorkload(workload.state, workload.questions, workload.inputVersion);
  if (!parsed.ok) throw new Error(`invalid Jev workload: ${parsed.reason}`);
  if (
    !isBoundedNonEmptyString(workflowQuery, 8_192) ||
    workflowQuery.includes(JEV_WORKLOAD_BINDING_PREFIX)
  ) {
    throw new Error("Jev workload requires an unbound workflow query");
  }
  const workloadSha256 = await sha256Hex({ version: JEV_WORKLOAD_BINDING_VERSION, workload: parsed.value });
  return canonicalJson({ query: `${workflowQuery.trim()} ${workloadBindingText(workloadSha256)}` });
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleepImpl: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<boolean> {
  if (milliseconds <= 0) return isAborted(signal);
  if (isAborted(signal)) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => settle(true);
    const cleanup = (): void => {
      if (timerId !== undefined) clearTimeout(timerId);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(aborted || isAborted(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) {
      settle(true);
      return;
    }

    if (sleepImpl === undefined) {
      timerId = setTimeout(() => settle(false), milliseconds);
      return;
    }
    try {
      const pending = sleepImpl(milliseconds);
      void pending.then(
        () => settle(false),
        () => settle(false),
      );
    } catch {
      settle(false);
    }
  });
}

type CurrentRequestFence = { ok: true } | { ok: false; reason: string };

async function currentRequestFence(
  options: JevClassificationOptions,
  request: RetryRequest,
): Promise<CurrentRequestFence> {
  if (isAborted(options.signal)) return { ok: false, reason: "cancelled" };
  try {
    if (options.beforeAttempt !== undefined) {
      const durableFence = await options.beforeAttempt();
      if (!durableFence.ok) return durableFence;
    }
    if (
      options.currentInputVersion !== undefined &&
      (await options.currentInputVersion()) !== request.inputVersion
    ) {
      return { ok: false, reason: "input-version-changed" };
    }
    if (options.isCurrentAuthority !== undefined && !(await options.isCurrentAuthority())) {
      return { ok: false, reason: "authority-invalidated" };
    }
  } catch {
    return { ok: false, reason: "authority-invalidated" };
  }
  return { ok: true };
}

type JevClassificationRun = {
  readonly result: JevClassificationResult;
  readonly ambiguousAttempt: boolean;
};

function isAmbiguousProviderResult(result: JevAttemptResult | JevClassificationResult): boolean {
  if (result.outcome === "stale") return true;
  if (result.outcome === "unavailable") {
    return result.reason === "timeout" ||
      result.reason === "transport-error" ||
      result.reason === "body-error";
  }
  if (result.outcome !== "needsReview") return false;
  // A valid HTTP response with malformed, incomplete, or unclassifiable
  // output does not establish that the provider did not process the request.
  // Explicit HTTP rejection statuses remain definitive failures unless an
  // earlier attempt already left the charge unresolved.
  return result.reason.startsWith("response-") ||
    result.reason === "model-mismatch" ||
    result.reason === "answers-shape" ||
    result.reason === "answers-mismatch" ||
    result.reason === "answer-reserved-id" ||
    result.reason.startsWith("answer-invalid:") ||
    result.reason.startsWith("usage-");
}

/**
 * Server-only Jev transport adapter. The imported proof owns unknown response
 * parsing and one-attempt transport bounds; this wrapper owns only the bounded
 * three-attempt retry and cancellation composition required by ADR-0005.
 */
async function runJevClassificationWithAccounting(
  options: JevClassificationOptions,
): Promise<JevClassificationRun> {
  if (isAborted(options.signal)) {
    return {
      result: staleResult(options.inputVersion, "cancelled-before-start", 0),
      ambiguousAttempt: false,
    };
  }
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    return {
      result: unavailableResult(options.inputVersion, "provider-unconfigured", 0),
      ambiguousAttempt: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const request = freezeRetryRequest(options);
  if (request === null) {
    return {
      result: unavailableResult(options.inputVersion, "invalid-input", 0),
      ambiguousAttempt: false,
    };
  }

  const beforeStart = await currentRequestFence(options, request);
  if (!beforeStart.ok) {
    return {
      result: staleResult(request.inputVersion, beforeStart.reason, 0),
      ambiguousAttempt: false,
    };
  }

  let lastResult: JevClassificationResult = unavailableResult(request.inputVersion, "no-attempt", 0);
  let ambiguousAttempt = false;

  for (let attempt = 0; attempt < JEV_MAX_ATTEMPTS; attempt += 1) {
    const beforeAttempt = await currentRequestFence(options, request);
    if (!beforeAttempt.ok) {
      return {
        result: staleResult(request.inputVersion, beforeAttempt.reason, attempt),
        ambiguousAttempt,
      };
    }
    const attemptOptions: JevAttemptOptions = {
      apiKey: options.apiKey,
      state: request.state,
      questions: request.questions,
      inputVersion: request.inputVersion,
      timeoutMs,
      maxResponseBytes: JEV_MAX_RESPONSE_BYTES,
    };
    if (options.fetchImpl !== undefined) attemptOptions.fetchImpl = options.fetchImpl;
    if (options.signal !== undefined) attemptOptions.signal = options.signal;
    const result = await jevAttemptOnce(attemptOptions);
    ambiguousAttempt = ambiguousAttempt || isAmbiguousProviderResult(result);
    const afterAttempt = await currentRequestFence(options, request);
    if (!afterAttempt.ok) {
      return {
        result: staleResult(request.inputVersion, afterAttempt.reason, attempt + 1),
        // A provider response was already observed, but authority changed
        // before it could be applied. Keep the charge unresolved.
        ambiguousAttempt: true,
      };
    }
    const freshResult = options.currentInputVersion === undefined
      ? result
      : applyIfCurrent(result, request.inputVersion);
    lastResult = { ...freshResult, attempts: attempt + 1 };
    if (freshResult.outcome === "stale") ambiguousAttempt = true;

    if (freshResult.outcome !== "unavailable" || freshResult.retry.kind !== "retryable") {
      return { result: lastResult, ambiguousAttempt };
    }
    if (attempt + 1 >= JEV_MAX_ATTEMPTS) return { result: lastResult, ambiguousAttempt };

    const retryAfter = freshResult.retry.retryAfterMs;
    if (retryAfter !== null && retryAfter > JEV_MAX_RETRY_AFTER_MS) {
      // Do not sleep an untrusted provider-controlled duration. The proof
      // preserves the exact server minimum, so over-policy advice becomes an
      // explicit review result instead of an automatic retry.
      return {
        result: {
          outcome: "needsReview",
          reason: `${freshResult.reason}:manual-review-required`,
          retry: { ...freshResult.retry, kind: "nonretryable" },
          latencyMs: freshResult.latencyMs,
          inputVersion: freshResult.inputVersion,
          attempts: attempt + 1,
        },
        ambiguousAttempt,
      };
    }
    const delay = retryAfter === null
      ? attempt === 0 ? JEV_RETRY_BACKOFF_MS[0] : JEV_RETRY_BACKOFF_MS[1]
      : retryAfter;
    if (await waitForRetry(delay, options.signal, options.sleepImpl)) {
      return {
        result: staleResult(request.inputVersion, "cancelled-during-retry-backoff", attempt + 1),
        ambiguousAttempt: true,
      };
    }
    const afterWait = await currentRequestFence(options, request);
    if (!afterWait.ok) {
      return {
        result: staleResult(request.inputVersion, afterWait.reason, attempt + 1),
        ambiguousAttempt,
      };
    }
  }

  return { result: lastResult, ambiguousAttempt };
}

export async function runJevClassification(
  options: JevClassificationOptions,
): Promise<JevClassificationResult> {
  const run = await runJevClassificationWithAccounting(options);
  return run.result;
}

const attemptFenceResultValidator = v.union(
  v.object({ ok: v.literal(true) }),
  denialValidator,
);

/**
 * Pre-claim authority fence. The workload digest is copied by F1 from the
 * approved grant into the job and operation input-version snapshots. The
 * exact marker in the approved payload prevents a caller from pairing a
 * fresh state/question set with an older generic research operation.
 */
export const preClaimFence = f1InternalQuery({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    inputVersion: v.string(),
    workloadSha256: v.string(),
  },
  returns: attemptFenceResultValidator,
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing operation identity" };
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "operation is not authorized" };
    }
    if (operation.state !== "prepared") {
      return operation.state === "cancelled"
        ? { ok: false as const, code: "cancelled-before-claim", message: "operation was cancelled before claim" }
        : { ok: false as const, code: "already-claimed", message: "operation is no longer prepared" };
    }
    if (operation.kind !== "research.collect") {
      return { ok: false as const, code: "unavailable-capability", message: "Jev is not authorized for this operation" };
    }
    const operationPayload = parseBoundedPayloadJson(operation.normalizedPayload);
    if (!operationPayload.ok || operationPayload.payload.canonical !== operation.normalizedPayload) {
      return { ok: false as const, code: "invalid-payload", message: "payload must be canonical bounded JSON" };
    }
    const job = await ctx.db.get(operation.jobId);
    if (
      job === null ||
      job.organizationId !== operation.organizationId ||
      job.projectId !== operation.projectId ||
      job.grantId !== operation.grantId
    ) {
      return { ok: false as const, code: "denied-membership", message: "operation authority is unavailable" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    const capability = lookupCapability(operation.kind);
    if (capability === undefined) {
      return { ok: false as const, code: "unknown-operation", message: `unknown operation ${operation.kind}` };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      capability.requiredRole,
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };

    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "operation authority is unavailable" };
    }
    if (!grant.operations.includes(operation.kind)) {
      return { ok: false as const, code: "denied-capability", message: "grant no longer authorizes Jev" };
    }
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant is no longer active" };
    }
    if (grant.revocationVersion !== operation.grantVersion || grant.revocationVersion !== job.grantVersion) {
      return { ok: false as const, code: "stale-grant-version", message: "grant was re-issued before claim" };
    }
    if (isExpired(Date.now(), grant.expiresAt)) {
      return { ok: false as const, code: "grant-expired-at-claim", message: "grant expired before claim" };
    }
    if (
      canonicalJson(operation.inputVersions) !== canonicalJson(grant.inputVersions) ||
      canonicalJson(job.inputVersions) !== canonicalJson(grant.inputVersions) ||
      !Object.values(grant.inputVersions).includes(args.inputVersion)
    ) {
      return { ok: false as const, code: "stale-input-version", message: "inputs changed before claim" };
    }
    if (
      grant.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256 ||
      operation.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256 ||
      job.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256
    ) {
      return { ok: false as const, code: "stale-input-version", message: "Jev workload binding is not approved" };
    }
    const grantPayload = parseBoundedPayloadJson(grant.canonicalPayload);
    if (!grantPayload.ok || grantPayload.payload.canonical !== grant.canonicalPayload) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload must be canonical bounded JSON" };
    }
    if (
      grant.canonicalPayload !== operation.normalizedPayload ||
      !sha256BindingOk(operation.payloadSha256, grant.payloadSha256) ||
      !workloadBindingMatches(operationPayload.payload.value, args.workloadSha256) ||
      !workloadBindingMatches(grantPayload.payload.value, args.workloadSha256)
    ) {
      return { ok: false as const, code: "changed-draft", message: "approved Jev workload does not match the operation" };
    }
    return { ok: true as const };
  },
});

const preClaimFenceRef = makeFunctionReference<
  "query",
  QueryArgs<typeof preClaimFence>,
  QueryReturn<typeof preClaimFence>
>("models/jev:preClaimFence");

/**
 * Recheck the durable authority chain between bounded Jev transport attempts.
 * The initial claim mints the single-use attempt token; this query prevents a
 * retry from starting after cancellation, grant/input drift, expiry, or loss
 * of the reservation's full three-attempt bound or its configured pricing
 * version/basis.
 */
export const attemptFence = f1InternalQuery({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    inputVersion: v.string(),
    workloadSha256: v.string(),
  },
  returns: attemptFenceResultValidator,
  handler: async (ctx, args) => {
    const pricing = loadJevPricingPolicy();
    if (!pricing.ok) return pricing;
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing operation identity" };
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "operation is not authorized" };
    }
    if (operation.state !== "dispatching") {
      return { ok: false as const, code: "already-claimed", message: "operation is no longer dispatching" };
    }
    const job = await ctx.db.get(operation.jobId);
    if (
      job === null ||
      job.organizationId !== operation.organizationId ||
      job.projectId !== operation.projectId ||
      job.grantId !== operation.grantId
    ) {
      return { ok: false as const, code: "denied-membership", message: "operation authority is unavailable" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    const capability = lookupCapability(operation.kind);
    if (capability === undefined) {
      return { ok: false as const, code: "unknown-operation", message: `unknown operation ${operation.kind}` };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      capability.requiredRole,
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };

    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "operation authority is unavailable" };
    }
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant is no longer active" };
    }
    if (grant.revocationVersion !== operation.grantVersion || grant.revocationVersion !== job.grantVersion) {
      return { ok: false as const, code: "stale-grant-version", message: "grant was re-issued after dispatch" };
    }
    if (isExpired(Date.now(), grant.expiresAt)) {
      return { ok: false as const, code: "grant-expired-at-claim", message: "grant expired during dispatch" };
    }
    if (
      canonicalJson(operation.inputVersions) !== canonicalJson(grant.inputVersions) ||
      canonicalJson(job.inputVersions) !== canonicalJson(grant.inputVersions)
    ) {
      return { ok: false as const, code: "stale-input-version", message: "inputs changed during dispatch" };
    }
    if (!Object.values(grant.inputVersions).includes(args.inputVersion)) {
      return { ok: false as const, code: "stale-input-version", message: "Jev input version is not current for this grant" };
    }
    if (
      grant.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256 ||
      operation.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256 ||
      job.inputVersions[JEV_WORKLOAD_INPUT_VERSION_KEY] !== args.workloadSha256
    ) {
      return { ok: false as const, code: "stale-input-version", message: "Jev workload binding changed during dispatch" };
    }
    const operationPayload = parseBoundedPayloadJson(operation.normalizedPayload);
    const grantPayload = parseBoundedPayloadJson(grant.canonicalPayload);
    if (
      !operationPayload.ok ||
      operationPayload.payload.canonical !== operation.normalizedPayload ||
      !grantPayload.ok ||
      grantPayload.payload.canonical !== grant.canonicalPayload
    ) {
      return { ok: false as const, code: "invalid-payload", message: "approved payload is not canonical bounded JSON" };
    }
    if (
      operation.normalizedPayload !== grant.canonicalPayload ||
      !sha256BindingOk(operation.payloadSha256, grant.payloadSha256) ||
      !workloadBindingMatches(operationPayload.payload.value, args.workloadSha256) ||
      !workloadBindingMatches(grantPayload.payload.value, args.workloadSha256)
    ) {
      return { ok: false as const, code: "changed-draft", message: "approved Jev workload changed during dispatch" };
    }

    if (operation.reservationId === undefined) {
      return { ok: false as const, code: "allowance-exhausted", message: "Jev requires a bounded reservation" };
    }
    const reservation = await ctx.db.get(operation.reservationId);
    if (
      reservation === null ||
      reservation.state !== "open" ||
      reservation.jobId !== operation.jobId ||
      reservation.organizationId !== operation.organizationId ||
      reservation.reservedMicroUsd < pricing.policy.maxReservationMicroUsd
    ) {
      return { ok: false as const, code: "allowance-exhausted", message: "Jev reservation cannot cover its bounded attempts" };
    }
    if (reservation.pricingBasis !== pricing.policy.reservationPricingBasis) {
      return { ok: false as const, code: "stale-pricing-basis", message: "Jev reservation pricing policy is stale" };
    }
    // ADR-0004: the org-wide `providerBudgets` row is one shared allowance
    // ledger across branches, retries, and providers. Its own basis label is
    // not a per-model contract; the reservation above binds this operation to
    // the exact Jev pricing basis. The budget only must exist and belong to
    // the operation organization.
    const budget = await ctx.db.get(reservation.budgetId);
    if (budget === null || budget.organizationId !== operation.organizationId) {
      return { ok: false as const, code: "allowance-exhausted", message: "operation allowance budget is unavailable" };
    }
    return { ok: true as const };
  },
});

const attemptFenceRef = makeFunctionReference<
  "query",
  QueryArgs<typeof attemptFence>,
  QueryReturn<typeof attemptFence>
>("models/jev:attemptFence");

function isAmbiguousJevResult(result: JevClassificationResult): boolean {
  return result.attempts > 0 && isAmbiguousProviderResult(result);
}

export const classify = internalAction({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    state: v.any(),
    questions: v.any(),
    inputVersion: v.string(),
  },
  returns: actionResultValidator,
  handler: async (ctx, args): Promise<JevClassificationResult | { ok: false; code: string; message: string }> => {
    const pricing = loadJevPricingPolicy();
    if (!pricing.ok) return pricing;
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing operation identity" };
    }
    const workload = parseJevWorkload(args.state, args.questions, args.inputVersion);
    if (!workload.ok) {
      return { ok: false as const, code: "invalid-payload", message: workload.reason };
    }
    let workloadSha256: string;
    try {
      workloadSha256 = await sha256Hex({
        version: JEV_WORKLOAD_BINDING_VERSION,
        workload: workload.value,
      });
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "Jev workload binding could not be computed" };
    }
    const preClaim = await ctx.runQuery(preClaimFenceRef, {
      operationId: args.operationId,
      identity: args.identity,
      inputVersion: args.inputVersion,
      workloadSha256,
    });
    if (!preClaim.ok) {
      // Preserve the ADR-0005 classification boundary for a caller-selected
      // stale version while refusing the operation before it can claim.
      if (preClaim.code === "stale-input-version") {
        return staleResult(args.inputVersion, preClaim.code, 0);
      }
      return preClaim;
    }
    const claim = await ctx.runMutation(claimRef, {
      operationId: args.operationId,
      identity: args.identity,
    });
    if (!claim.ok) return claim;

    const run = await runJevClassificationWithAccounting({
      apiKey: env.TYPESAFE_API_KEY,
      state: workload.value.state,
      questions: workload.value.questions,
      inputVersion: workload.value.inputVersion,
      beforeAttempt: async () => {
        const fence = await ctx.runQuery(attemptFenceRef, {
          operationId: args.operationId,
          identity: args.identity,
          inputVersion: args.inputVersion,
          workloadSha256,
        });
        return fence.ok ? fence : { ok: false as const, reason: fence.code };
      },
    });
    const result = run.result;
    const ambiguous = run.ambiguousAttempt || isAmbiguousJevResult(result);
    const recorded = await ctx.runMutation(recordOutcomeRef, {
      operationId: args.operationId,
      token: claim.attemptToken,
      outcome: result.outcome === "decided" ? "success" : ambiguous ? "unknown" : "failure",
      provider: "typesafe",
      environment: "production",
      ...(ambiguous ? { unknownCharges: true } : {}),
      detail: result.outcome === "decided"
        ? "decided"
        : `${result.outcome}:${result.reason}`,
    });
    if (!recorded.ok) return recorded;
    return result;
  },
});
