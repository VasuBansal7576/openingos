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
import { internalAction, env } from "../_generated/server";
import { v } from "convex/values";

export const JEV_MAX_ATTEMPTS = 3;
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
  currentInputVersion?: () => string;
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

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleepImpl: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  if (milliseconds <= 0) return isAborted(signal);
  if (isAborted(signal)) return true;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await sleepImpl(milliseconds);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return aborted || isAborted(signal);
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

  const sleepImpl = options.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  let lastResult: JevClassificationResult = unavailableResult(options.inputVersion, "no-attempt", 0);

  for (let attempt = 0; attempt < JEV_MAX_ATTEMPTS; attempt += 1) {
    if (isAborted(options.signal)) return staleResult(options.inputVersion, "cancelled", attempt);
    const attemptOptions: JevAttemptOptions = {
      apiKey: options.apiKey,
      state: options.state,
      questions: options.questions,
      inputVersion: options.inputVersion,
      timeoutMs,
      maxResponseBytes: JEV_MAX_RESPONSE_BYTES,
    };
    if (options.fetchImpl !== undefined) attemptOptions.fetchImpl = options.fetchImpl;
    if (options.signal !== undefined) attemptOptions.signal = options.signal;
    const result = await jevAttemptOnce(attemptOptions);
    const freshResult = options.currentInputVersion === undefined
      ? result
      : applyIfCurrent(result, options.currentInputVersion());
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
    if (await waitForRetry(delay, options.signal, sleepImpl)) {
      return staleResult(options.inputVersion, "cancelled-during-retry-backoff", attempt + 1);
    }
  }

  return lastResult;
}

export const classify = internalAction({
  args: {
    state: v.any(),
    questions: v.any(),
    inputVersion: v.string(),
  },
  returns: classificationResultValidator,
  handler: async (_ctx, args): Promise<JevClassificationResult> => {
    const questions = parseQuestions(args.questions);
    if (questions === null) return unavailableResult(args.inputVersion, "invalid-questions", 0);
    return await runJevClassification({
      apiKey: env.TYPESAFE_API_KEY,
      state: args.state,
      questions,
      inputVersion: args.inputVersion,
    });
  },
});
