import {
  applyIfCurrent,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_MAX_RETRY_AFTER_MS,
  JEV_MAX_RESPONSE_BYTES,
  jevAttemptOnce,
  validChoiceQuestion,
  validNoulQuestion,
  validScoreQuestion,
  type JevAnswer,
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
import { canonicalJson } from "../shared/hashing.js";
import { sha256BindingOk } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";

export const JEV_MAX_ATTEMPTS = 3;
/**
 * Conservative per-request allowance bound for the pinned Jev transport.
 * The reservation covers all three possible HTTP attempts before the first
 * request, so a retry cannot race another job for the same remaining budget.
 */
export const JEV_ATTEMPT_MAX_COST_MICRO_USD = 1_000;
export const JEV_MAX_RESERVATION_MICRO_USD =
  JEV_MAX_ATTEMPTS * JEV_ATTEMPT_MAX_COST_MICRO_USD;
export const JEV_PRICING_BASIS =
  `typesafe-jev-1.13.0;max-attempts=${JEV_MAX_ATTEMPTS};maximum-cost-micro-usd=${JEV_MAX_RESERVATION_MICRO_USD}`;
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

function freezeRetryRequest(options: JevClassificationOptions): RetryRequest | null {
  const state = immutableRetryInput(options.state);
  const questions = immutableRetryInput(options.questions);
  if (!state.ok || !questions.ok) return null;
  const parsedQuestions = parseQuestions(questions.value);
  if (parsedQuestions === null) return null;
  Object.freeze(parsedQuestions);
  const request: RetryRequest = {
    state: state.value,
    questions: parsedQuestions,
    inputVersion: options.inputVersion,
  };
  return Object.freeze(request);
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

/**
 * Server-only Jev transport adapter. The imported proof owns unknown response
 * parsing and one-attempt transport bounds; this wrapper owns only the bounded
 * three-attempt retry and cancellation composition required by ADR-0005.
 */
export async function runJevClassification(
  options: JevClassificationOptions,
): Promise<JevClassificationResult> {
  if (isAborted(options.signal)) return staleResult(options.inputVersion, "cancelled-before-start", 0);
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    return unavailableResult(options.inputVersion, "provider-unconfigured", 0);
  }

  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const request = freezeRetryRequest(options);
  if (request === null) {
    return unavailableResult(options.inputVersion, "invalid-input", 0);
  }

  const beforeStart = await currentRequestFence(options, request);
  if (!beforeStart.ok) return staleResult(request.inputVersion, beforeStart.reason, 0);

  let lastResult: JevClassificationResult = unavailableResult(request.inputVersion, "no-attempt", 0);

  for (let attempt = 0; attempt < JEV_MAX_ATTEMPTS; attempt += 1) {
    const beforeAttempt = await currentRequestFence(options, request);
    if (!beforeAttempt.ok) return staleResult(request.inputVersion, beforeAttempt.reason, attempt);
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
    const afterAttempt = await currentRequestFence(options, request);
    if (!afterAttempt.ok) return staleResult(request.inputVersion, afterAttempt.reason, attempt + 1);
    const freshResult = options.currentInputVersion === undefined
      ? result
      : applyIfCurrent(result, request.inputVersion);
    lastResult = { ...freshResult, attempts: attempt + 1 };

    if (freshResult.outcome !== "unavailable" || freshResult.retry.kind !== "retryable") return lastResult;
    if (attempt + 1 >= JEV_MAX_ATTEMPTS) return lastResult;

    const retryAfter = freshResult.retry.retryAfterMs;
    if (retryAfter !== null && retryAfter > JEV_MAX_RETRY_AFTER_MS) {
      // Do not sleep an untrusted provider-controlled duration. The proof
      // preserves the exact server minimum, so over-policy advice becomes an
      // explicit review result instead of an automatic retry.
      return {
        outcome: "needsReview",
        reason: `${freshResult.reason}:manual-review-required`,
        retry: { ...freshResult.retry, kind: "nonretryable" },
        latencyMs: freshResult.latencyMs,
        inputVersion: freshResult.inputVersion,
        attempts: attempt + 1,
      };
    }
    const delay = retryAfter === null
      ? attempt === 0 ? JEV_RETRY_BACKOFF_MS[0] : JEV_RETRY_BACKOFF_MS[1]
      : retryAfter;
    if (await waitForRetry(delay, options.signal, options.sleepImpl)) {
      return staleResult(request.inputVersion, "cancelled-during-retry-backoff", attempt + 1);
    }
    const afterWait = await currentRequestFence(options, request);
    if (!afterWait.ok) return staleResult(request.inputVersion, afterWait.reason, attempt + 1);
  }

  return lastResult;
}

const attemptFenceResultValidator = v.union(
  v.object({ ok: v.literal(true) }),
  denialValidator,
);

/**
 * Recheck the durable authority chain between bounded Jev transport attempts.
 * The initial claim mints the single-use attempt token; this query prevents a
 * retry from starting after cancellation, grant/input drift, expiry, or loss
 * of the reservation's full three-attempt bound.
 */
export const attemptFence = f1InternalQuery({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    inputVersion: v.string(),
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
    if (operation.normalizedPayload !== grant.canonicalPayload || !sha256BindingOk(operation.payloadSha256, grant.payloadSha256)) {
      return { ok: false as const, code: "changed-draft", message: "approved payload changed during dispatch" };
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
      reservation.reservedMicroUsd + reservation.unresolvedMicroUsd < JEV_MAX_RESERVATION_MICRO_USD
    ) {
      return { ok: false as const, code: "allowance-exhausted", message: "Jev reservation cannot cover its bounded attempts" };
    }
    const budget = await ctx.db.get(reservation.budgetId);
    if (budget === null || budget.organizationId !== operation.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "operation allowance is unavailable" };
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
  if (result.attempts === 0) return false;
  if (result.outcome === "stale") return true;
  if (result.outcome !== "unavailable") return false;
  return result.reason === "timeout" ||
    result.reason === "transport-error" ||
    result.reason === "body-error";
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
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing operation identity" };
    }
    const claim = await ctx.runMutation(claimRef, {
      operationId: args.operationId,
      identity: args.identity,
    });
    if (!claim.ok) return claim;

    const questions = parseQuestions(args.questions);
    const result = questions === null
      ? unavailableResult(args.inputVersion, "invalid-questions", 0)
      : await runJevClassification({
          apiKey: env.TYPESAFE_API_KEY,
          state: args.state,
          questions,
          inputVersion: args.inputVersion,
          beforeAttempt: async () => {
            const fence = await ctx.runQuery(attemptFenceRef, {
              operationId: args.operationId,
              identity: args.identity,
              inputVersion: args.inputVersion,
            });
            return fence.ok ? fence : { ok: false as const, reason: fence.code };
          },
        });

    const ambiguous = isAmbiguousJevResult(result);
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
