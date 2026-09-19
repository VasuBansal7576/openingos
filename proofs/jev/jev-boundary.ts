/**
 * F1-J controlled proof: fixed-origin, single-attempt Jev HTTP boundary.
 *
 * Scope: bounded proof only under proposed ADR-0005 / ADR-0004 and sponsor
 * plan J-01 through J-04. This module is NOT the Convex application adapter,
 * performs NO live calls, claims NO application credentials, and owns NO
 * retry loop, reservation, or backend authority. The coordinator owns the
 * eventual shared reservation/retry state, so a single-attempt `decided`
 * result here never completes integrated J-03/J-04.
 *
 * Contract enforced:
 * - Fixed origin POST https://api.typesafe.ai/v1/systemone (no base-URL input).
 * - Pinned model `jev-1.13.0`; the versioned response model must match.
 *   The `jev-latest` alias is never sent (it can move between releases).
 * - Exactly one `fetch` per attempt; no hidden retry inside this module.
 * - Finite positive timeout and safe-integer byte configuration are
 *   validated before any dispatch; one absolute deadline is enforced after
 *   every await and before acceptance, covering headers and body alike.
 * - A normalized immutable JSON snapshot of the exact sent bytes is built
 *   before dispatch; non-JSON evidence (NaN, undefined, functions, morphing
 *   toJSON) is rejected and responses validate only against the sent
 *   snapshot, so mid-flight caller mutation cannot smuggle unsent options.
 * - Responses are parsed from `unknown` with exact key/type checks for
 *   `noul`, `choice`, and `score` answers; `__proto__`/`constructor`/
 *   `prototype` IDs are rejected in requests and responses so no decided
 *   result can omit an own question key.
 * - Responses are parsed from `unknown` with exact key/type checks for
 *   `noul`, `choice`, and `score` answers.
 * - Noul answers carry NO confidence field (official schema: type + noul).
 * - Choice answers require full distributions over exactly the criteria
 *   options, normalized within tolerance, with `choice` at maximum
 *   probability and a finite confidence in [0, 1].
 * - Score answers require a legend matching the criteria order
 *   (keys "0".."n-1"), full distributions over exactly the legend keys,
 *   a probability-weighted `score` within tolerance, and finite confidence.
 * - `usage.input_tokens` / `usage.output_tokens` must be nonnegative safe
 *   integers; unknown charges stay unknown (never invented).
 * - Response bytes and the whole attempt latency are bounded: the same
 *   absolute deadline covers headers AND the body stream, a stalled body
 *   reports `unavailable/timeout`, a rejected stream reports
 *   `unavailable/body-error`, and an abort during or after the body cancels
 *   the reader and reports `stale`. Ignored non-2xx/redirect bodies are
 *   cancelled without awaiting an unbounded close. Pre-abort dispatches
 *   zero requests; redirects are refused, never followed.
 * - Error results never embed the raw response body or the API key.
 *
 * Official schema sources checked 2026-09-19: https://docs.typesafe.ai/api
 * and https://docs.typesafe.ai/models. Drift notes live in README.md.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_PINNED_MODEL = "jev-1.13.0";
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;
export const JEV_MAX_RESPONSE_BYTES = 256 * 1024;
export const JEV_MAX_REQUEST_BYTES = 1024 * 1024;
export const JEV_PROBABILITY_SUM_TOLERANCE = 1e-3;
/**
 * Policy horizon for server backoff advice. Retry-After values at or below
 * this threshold are routine; larger values keep their exact server minimum
 * and are reported with an exceeds-policy reason so the coordinator waits
 * the full server delay instead of retrying early.
 */
export const JEV_MAX_RETRY_AFTER_MS = 60_000;

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export type JevOutcome = "decided" | "needsReview" | "unavailable" | "stale";

export type JevRetryKind = "none" | "retryable" | "nonretryable";

export interface JevRetryAdvice {
  kind: JevRetryKind;
  status: number | null;
  retryAfterMs: number | null;
}

export interface JevDecided {
  outcome: "decided";
  model: typeof JEV_PINNED_MODEL;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  latencyMs: number;
  inputVersion: string;
}

export interface JevNeedsReview {
  outcome: "needsReview";
  reason: string;
  retry: JevRetryAdvice;
  latencyMs: number;
  inputVersion: string;
}

export interface JevUnavailable {
  outcome: "unavailable";
  reason: string;
  retry: JevRetryAdvice;
  latencyMs: number;
  inputVersion: string;
}

export interface JevStale {
  outcome: "stale";
  reason: string;
  retry: JevRetryAdvice;
  latencyMs: number;
  inputVersion: string;
}

export type JevAttemptResult = JevDecided | JevNeedsReview | JevUnavailable | JevStale;

export interface JevAttemptOptions {
  /** Synthetic test key only. Never a real credential; never logged. */
  apiKey: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  inputVersion: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: JevFetch;
  signal?: AbortSignal;
}

/**
 * Precise single-request fetch boundary type. This avoids Bun's ambient
 * `typeof fetch`, which carries extra members such as `preconnect` that a
 * controlled stub must not be forced to implement.
 */
export type JevFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Fresh abort check behind a function boundary (no stale narrowing across awaits). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * IDs that must never appear as question, option, or answer keys. A plain
 * `obj[key] = value` write with one of these names invokes a prototype
 * setter instead of creating an own property, so a validated result could
 * silently omit an own question key. Rejected in requests and responses.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/** Maximum nesting accepted by the defensive JSON copy (cycles and deeper graphs are rejected). */
const MAX_JSON_COPY_DEPTH = 64;

type JsonCopy = { ok: true; value: unknown } | { ok: false };

/**
 * Bounded defensive copy of plain JSON data. Only null-prototype or
 * Object-prototype objects and dense arrays are accepted; inherited or
 * non-enumerable serialization hooks are never consulted because the copy
 * is built from validated own data, and accessors are rejected without
 * being invoked. Cycles and over-deep graphs fail closed instead of
 * throwing. The caller-owned original is never serialized.
 */
function copyJsonData(value: unknown, depth: number, ancestors: Set<object>): JsonCopy {
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (depth > MAX_JSON_COPY_DEPTH) return { ok: false };
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return { ok: false };
    ancestors.add(value);
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        ancestors.delete(value);
        return { ok: false };
      }
      const element: unknown = value[index];
      const copied = copyJsonData(element, depth + 1, ancestors);
      if (!copied.ok) {
        ancestors.delete(value);
        return { ok: false };
      }
      out.push(copied.value);
    }
    ancestors.delete(value);
    return { ok: true, value: out };
  }
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { ok: false };
    if (ancestors.has(value)) return { ok: false };
    ancestors.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        ancestors.delete(value);
        return { ok: false };
      }
      if (!("value" in descriptor)) {
        ancestors.delete(value);
        return { ok: false };
      }
      const entry: unknown = descriptor.value;
      const copied = copyJsonData(entry, depth + 1, ancestors);
      if (!copied.ok) {
        ancestors.delete(value);
        return { ok: false };
      }
      if (key === "__proto__") {
        Object.defineProperty(out, key, { value: copied.value, enumerable: true, writable: true, configurable: true });
      } else {
        out[key] = copied.value;
      }
    }
    ancestors.delete(value);
    return { ok: true, value: out };
  }
  return { ok: false };
}

function copyJson(value: unknown): JsonCopy {
  return copyJsonData(value, 0, new Set<object>());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameKeySet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = new Set(expected);
  for (const key of actual) {
    if (!remaining.delete(key)) return false;
  }
  return remaining.size === 0;
}

function isInstructions(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function validNoulQuestionShape(entry: Record<string, unknown>): boolean {
  if (!isInstructions(entry["instructions"])) return false;
  const criteria: unknown = entry["criteria"];
  if (criteria === undefined) return true;
  if (!isRecord(criteria)) return false;
  for (const key of Object.keys(criteria)) {
    if (key !== "true" && key !== "false") return false;
    const text: unknown = criteria[key];
    if (text !== undefined && typeof text !== "string") return false;
  }
  return true;
}

function validChoiceQuestionShape(entry: Record<string, unknown>): boolean {
  if (!isInstructions(entry["instructions"])) return false;
  const criteria: unknown = entry["criteria"];
  if (!isRecord(criteria)) return false;
  const keys = Object.keys(criteria);
  if (keys.length < 1) return false;
  for (const key of keys) {
    if (key.length === 0 || isReservedKey(key)) return false;
    const detail: unknown = criteria[key];
    if (detail !== null && typeof detail !== "string") return false;
  }
  return true;
}

function validScoreQuestionShape(entry: Record<string, unknown>): boolean {
  if (!isInstructions(entry["instructions"])) return false;
  const criteria: unknown = entry["criteria"];
  if (!Array.isArray(criteria)) return false;
  if (criteria.length < 2) return false;
  for (const level of criteria) {
    if (typeof level !== "string" || level.length === 0) return false;
  }
  return true;
}

export function validNoulQuestion(question: JevNoulQuestion): boolean {
  if (!isInstructions(question.instructions)) return false;
  if (question.criteria === undefined) return true;
  if (!isRecord(question.criteria)) return false;
  for (const key of Object.keys(question.criteria)) {
    if (key !== "true" && key !== "false") return false;
    const text: unknown = question.criteria[key];
    if (text !== undefined && typeof text !== "string") return false;
  }
  return true;
}

export function validChoiceQuestion(question: JevChoiceQuestion): boolean {
  if (!isInstructions(question.instructions)) return false;
  if (!isRecord(question.criteria)) return false;
  const keys = Object.keys(question.criteria);
  if (keys.length < 1) return false;
  for (const key of keys) {
    if (key.length === 0 || isReservedKey(key)) return false;
    const detail: unknown = question.criteria[key];
    if (detail !== null && typeof detail !== "string") return false;
  }
  return true;
}

export function validScoreQuestion(question: JevScoreQuestion): boolean {
  if (!isInstructions(question.instructions)) return false;
  if (!Array.isArray(question.criteria)) return false;
  if (question.criteria.length < 2) return false;
  for (const level of question.criteria) {
    if (typeof level !== "string" || level.length === 0) return false;
  }
  return true;
}

function validQuestions(questions: unknown): questions is Record<string, JevQuestion> {
  if (!isRecord(questions)) return false;
  const keys = Object.keys(questions);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (key.length === 0 || isReservedKey(key)) return false;
    const entry: unknown = questions[key];
    if (!isRecord(entry)) return false;
    const kind: unknown = entry["type"];
    if (kind === "noul") {
      if (!validNoulQuestionShape(entry)) return false;
    } else if (kind === "choice") {
      if (!validChoiceQuestionShape(entry)) return false;
    } else if (kind === "score") {
      if (!validScoreQuestionShape(entry)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function validState(state: unknown): boolean {
  if (typeof state === "string") return state.length > 0;
  if (Array.isArray(state)) return state.length > 0;
  return isRecord(state) && Object.keys(state).length > 0;
}

interface Invalid {
  ok: false;
  reason: string;
}

interface ValidAnswer {
  ok: true;
  answer: JevAnswer;
}

function fail(reason: string): Invalid {
  return { ok: false, reason };
}

function validDistribution(probabilities: unknown, expectedKeys: string[]): probabilities is Record<string, number> {
  if (!isRecord(probabilities)) return false;
  if (!sameKeySet(Object.keys(probabilities), expectedKeys)) return false;
  let sum = 0;
  for (const key of expectedKeys) {
    const value: unknown = probabilities[key];
    if (!isFiniteUnit(value)) return false;
    sum += value;
  }
  return Math.abs(sum - 1) <= JEV_PROBABILITY_SUM_TOLERANCE;
}

function validNoulAnswer(answer: Record<string, unknown>): ValidAnswer | Invalid {
  if (!sameKeySet(Object.keys(answer), ["type", "noul"])) return fail("noul-extra-keys");
  const value: unknown = answer["noul"];
  if (!isFiniteUnit(value)) return fail("noul-range");
  return { ok: true, answer: { type: "noul", noul: value } };
}

function validChoiceAnswer(answer: Record<string, unknown>, question: JevChoiceQuestion): ValidAnswer | Invalid {
  if (!sameKeySet(Object.keys(answer), ["type", "choice", "probabilities", "confidence"])) {
    return fail("choice-shape");
  }
  const options = Object.keys(question.criteria);
  const choice: unknown = answer["choice"];
  if (typeof choice !== "string" || !options.includes(choice)) return fail("choice-unknown-option");
  const probabilities: unknown = answer["probabilities"];
  if (!validDistribution(probabilities, options)) return fail("choice-distribution");
  const confidence: unknown = answer["confidence"];
  if (!isFiniteUnit(confidence)) return fail("choice-confidence");
  let peak = 0;
  for (const option of options) {
    const value: unknown = probabilities[option];
    if (typeof value === "number" && value > peak) peak = value;
  }
  const chosen: unknown = probabilities[choice];
  if (typeof chosen !== "number" || chosen < peak - 1e-9) return fail("choice-not-maximum");
  const distribution: Record<string, number> = {};
  for (const option of options) {
    const value: unknown = probabilities[option];
    if (typeof value === "number") distribution[option] = value;
  }
  return { ok: true, answer: { type: "choice", choice, probabilities: distribution, confidence } };
}

function validScoreAnswer(answer: Record<string, unknown>, question: JevScoreQuestion): ValidAnswer | Invalid {
  if (!sameKeySet(Object.keys(answer), ["type", "score", "legend", "probabilities", "confidence"])) {
    return fail("score-shape");
  }
  const levels = question.criteria.map((_, index) => String(index));
  const legend: unknown = answer["legend"];
  if (!isRecord(legend)) return fail("score-legend-shape");
  if (!sameKeySet(Object.keys(legend), levels)) return fail("score-legend-keys");
  for (let index = 0; index < question.criteria.length; index += 1) {
    const entry: unknown = legend[String(index)];
    if (entry !== question.criteria[index]) return fail("score-legend-text");
  }
  const probabilities: unknown = answer["probabilities"];
  if (!validDistribution(probabilities, levels)) return fail("score-distribution");
  const confidence: unknown = answer["confidence"];
  if (!isFiniteUnit(confidence)) return fail("score-confidence");
  const score: unknown = answer["score"];
  if (typeof score !== "number" || !Number.isFinite(score)) return fail("score-range");
  if (score < 0 || score > question.criteria.length - 1) return fail("score-range");
  let weighted = 0;
  for (let index = 0; index < levels.length; index += 1) {
    const value: unknown = probabilities[levels[index] ?? ""];
    if (typeof value === "number") weighted += index * value;
  }
  if (Math.abs(weighted - score) > JEV_PROBABILITY_SUM_TOLERANCE) return fail("score-weighted-mismatch");
  const legendOut: Record<string, string> = {};
  for (const level of levels) {
    const entry: unknown = legend[level];
    if (typeof entry === "string") legendOut[level] = entry;
  }
  const distribution: Record<string, number> = {};
  for (const level of levels) {
    const value: unknown = probabilities[level];
    if (typeof value === "number") distribution[level] = value;
  }
  return { ok: true, answer: { type: "score", score, legend: legendOut, probabilities: distribution, confidence } };
}

interface ValidResponse {
  ok: true;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

function validResponse(payload: unknown, questions: Record<string, JevQuestion>): ValidResponse | Invalid {
  if (!isRecord(payload)) return fail("response-shape");
  if (!sameKeySet(Object.keys(payload), ["model", "answers", "usage"])) return fail("response-keys");
  if (payload["model"] !== JEV_PINNED_MODEL) return fail("model-mismatch");
  const answers: unknown = payload["answers"];
  if (!isRecord(answers)) return fail("answers-shape");
  const answerIds = Object.keys(answers);
  for (const id of answerIds) {
    if (isReservedKey(id)) return fail("answer-reserved-id");
  }
  if (!sameKeySet(answerIds, Object.keys(questions))) return fail("answers-mismatch");
  const usage: unknown = payload["usage"];
  if (!isRecord(usage)) return fail("usage-shape");
  if (!sameKeySet(Object.keys(usage), ["input_tokens", "output_tokens"])) return fail("usage-keys");
  if (!isNonNegativeSafeInteger(usage["input_tokens"])) return fail("usage-input");
  if (!isNonNegativeSafeInteger(usage["output_tokens"])) return fail("usage-output");
  const accepted: Record<string, JevAnswer> = {};
  for (const id of Object.keys(questions)) {
    const raw: unknown = answers[id];
    if (!isRecord(raw)) return fail(`answer-invalid:${id}`);
    if (raw["type"] !== questions[id]?.type) return fail(`answer-invalid:${id}`);
    let checked: ValidAnswer | Invalid;
    const question = questions[id];
    if (question?.type === "noul") {
      checked = validNoulAnswer(raw);
    } else if (question?.type === "choice") {
      checked = validChoiceAnswer(raw, question);
    } else if (question?.type === "score") {
      checked = validScoreAnswer(raw, question);
    } else {
      return fail(`answer-invalid:${id}`);
    }
    if (!checked.ok) {
      const detail: Invalid = checked;
      return fail(`answer-invalid:${id}:${detail.reason}`);
    }
    const good: ValidAnswer = checked;
    accepted[id] = good.answer;
  }
  return {
    ok: true,
    answers: accepted,
    usage: { input_tokens: usage["input_tokens"], output_tokens: usage["output_tokens"] },
  };
}

/**
 * Parse a Retry-After value to an exact millisecond delay. The valid server
 * minimum is always preserved: values above JEV_MAX_RETRY_AFTER_MS are
 * returned whole so the coordinator never retries earlier than the server
 * allows, and the caller reports the policy excess via a distinct reason.
 */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    const ms = seconds * 1000;
    if (!Number.isSafeInteger(ms)) return null;
    return ms;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const delta = when - Date.now();
  if (!(delta > 0) || !Number.isFinite(delta)) return null;
  return delta;
}

/**
 * Release an ignored response body without awaiting an unbounded cancel, so
 * completed non-2xx/redirect attempts retain no transport resources. Error
 * results are unchanged.
 */
function discardBody(response: Response): void {
  const stream = response.body;
  if (stream === null) return;
  try {
    void stream.cancel().then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Outcome already determined; a sync cancel failure changes nothing.
  }
}

type BodyRead =
  | { kind: "ok"; text: string }
  | { kind: "too-large" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error" };

function isBodyMarker(value: unknown): value is BodyRead {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value)) return false;
  const kind: unknown = value.kind;
  return kind === "ok" || kind === "too-large" || kind === "timeout" || kind === "aborted" || kind === "error";
}

/**
 * Read a response body under the attempt's remaining budget. Every stall,
 * rejection, and abort during the body resolves to a typed marker instead
 * of hanging the attempt or throwing a raw stream error.
 */
async function readBodyBounded(response: Response, maxBytes: number, budgetMs: number, signal?: AbortSignal): Promise<BodyRead> {
  if (signal?.aborted === true) return { kind: "aborted" };

  let onAbort: (() => void) | null = null;
  const aborted = new Promise<BodyRead>((resolve) => {
    if (signal === undefined) return;
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let fireTimeout: () => void = () => undefined;
  const expired = new Promise<BodyRead>((resolve) => {
    fireTimeout = () => resolve({ kind: "timeout" });
  });
  const timeoutId = setTimeout(fireTimeout, Math.max(0, budgetMs));
  const cleanup = (): void => {
    clearTimeout(timeoutId);
    if (signal !== undefined && onAbort !== null) signal.removeEventListener("abort", onAbort);
  };
  const racersFor = (pending: Promise<BodyRead>): Array<Promise<BodyRead>> =>
    signal === undefined ? [pending, expired] : [pending, aborted, expired];

  const stream = response.body;
  if (stream === null) {
    const pending = response.text().then(
      (text): BodyRead => {
        if (new TextEncoder().encode(text).byteLength > maxBytes) return { kind: "too-large" };
        return { kind: "ok", text };
      },
      (): BodyRead => ({ kind: "error" }),
    );
    const result = await Promise.race(racersFor(pending));
    void pending.then(
      () => undefined,
      () => undefined,
    );
    cleanup();
    return result;
  }

  const reader = stream.getReader();
  const cancelQuiet = (): void => {
    void reader.cancel().then(
      () => undefined,
      () => undefined,
    );
  };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const pending = reader.read();
      const racers = signal === undefined ? [pending, expired] : [pending, aborted, expired];
      const next = await Promise.race(racers);
      if (isBodyMarker(next)) {
        void pending.then(
          () => undefined,
          () => undefined,
        );
        cancelQuiet();
        cleanup();
        return next;
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        cancelQuiet();
        cleanup();
        return { kind: "too-large" };
      }
      chunks.push(next.value);
    }
    cleanup();
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", text: new TextDecoder().decode(merged) };
  } catch {
    cancelQuiet();
    cleanup();
    if (isAborted(signal)) return { kind: "aborted" };
    return { kind: "error" };
  }
}

/**
 * Pure stale-input check for application composition.
 *
 * This helper has NO backend authority: it compares version strings only and
 * cannot verify grants, expiry, revocation, recipients, or tool allowlists.
 * Backend enforcement (ADR-0004/ADR-0007) must still run before any effect.
 */
export function isStaleInput(resultInputVersion: string, currentInputVersion: string): boolean {
  return resultInputVersion !== currentInputVersion;
}

/**
 * Pure freshness gate: keep a validated `decided` result only when its input
 * version still matches. Like `isStaleInput`, this carries NO backend
 * authority and never approves an external effect on its own.
 */
export function applyIfCurrent(result: JevAttemptResult, currentInputVersion: string): JevAttemptResult {
  if (result.outcome !== "decided") return result;
  if (!isStaleInput(result.inputVersion, currentInputVersion)) return result;
  return {
    outcome: "stale",
    reason: "input-version-changed",
    retry: { kind: "none", status: null, retryAfterMs: null },
    latencyMs: 0,
    inputVersion: result.inputVersion,
  };
}

/**
 * Perform exactly one bounded Jev attempt. Never retries internally: 429/529
 * outcomes are reported as `retryable` for the coordinator-owned execution
 * module, while 401/422 are reported as `nonretryable`. A Retry-After above
 * the policy horizon keeps its exact server minimum with an exceeds-policy
 * reason, never an earlier advice.
 */
export async function jevAttemptOnce(options: JevAttemptOptions): Promise<JevAttemptResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? JEV_MAX_RESPONSE_BYTES;
  const fetchImpl: JevFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const none: JevRetryAdvice = { kind: "none", status: null, retryAfterMs: null };
  // Snapshot the primitive version and the abort signal before dispatch; every
  // later registration, cleanup, body read, freshness echo, and final check
  // uses these values, never a reread of `options` after awaits.
  const attemptedVersion = options.inputVersion;
  const attemptedSignal = options.signal;
  // One absolute deadline for the whole attempt, enforced after every await,
  // immediately before dispatch, and before acceptance.
  const deadlineMs = started + timeoutMs;

  let body: string;
  let sent: Record<string, JevQuestion>;
  try {
    if (!isNonEmptyString(options.apiKey)) {
    return { outcome: "needsReview", reason: "missing-api-key", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (!isNonEmptyString(attemptedVersion)) {
    return { outcome: "needsReview", reason: "missing-input-version", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: "" };
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { outcome: "needsReview", reason: "invalid-timeout", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { outcome: "needsReview", reason: "invalid-max-bytes", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (!validState(options.state)) {
    return { outcome: "needsReview", reason: "invalid-state", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
    // Defensive copies first: only plain JSON data survives, inherited or
    // non-enumerable serialization hooks are never consulted, accessors are
    // rejected without invocation, and cycles/deep graphs fail closed. The
    // caller-owned originals are never serialized.
    const stateCopy = copyJson(options.state);
    if (!stateCopy.ok) {
      return { outcome: "needsReview", reason: "non-json-state", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }
    const questionsCopy = copyJson(options.questions);
    if (!questionsCopy.ok) {
      return { outcome: "needsReview", reason: "non-json-questions", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }
    if (!validQuestions(questionsCopy.value)) {
      return { outcome: "needsReview", reason: "invalid-questions", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }
    if (isAborted(attemptedSignal)) {
      return { outcome: "stale", reason: "pre-aborted", retry: none, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }

    // Normalized immutable request snapshot: the exact bytes sent. Re-parsing
    // proves the sent bytes carry the validated shape.
    try {
      body = JSON.stringify({ model: JEV_PINNED_MODEL, state: stateCopy.value, questions: questionsCopy.value });
    } catch {
      return { outcome: "needsReview", reason: "request-serialize-failed", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }
  if (new TextEncoder().encode(body).byteLength > JEV_MAX_REQUEST_BYTES) {
    return { outcome: "needsReview", reason: "request-too-large", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  let normalized: unknown;
  try {
    normalized = JSON.parse(body);
  } catch {
    return { outcome: "needsReview", reason: "request-normalize-failed", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (!isRecord(normalized) || normalized["model"] !== JEV_PINNED_MODEL) {
    return { outcome: "needsReview", reason: "request-normalize-failed", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
    // The sent snapshot is the only authority for later validation; the live
    // `options.questions` object is never consulted again.
    const wireQuestions: unknown = normalized["questions"];
    if (!validState(normalized["state"]) || !validQuestions(wireQuestions)) {
      return { outcome: "needsReview", reason: "request-normalize-failed", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
    }
    sent = wireQuestions;
  } catch {
    return { outcome: "needsReview", reason: "request-validate-failed", retry: { kind: "nonretryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }

  // Preparation counts against the deadline: never dispatch once it is spent.
  if (isAborted(attemptedSignal)) {
    return { outcome: "stale", reason: "aborted", retry: none, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (Date.now() > deadlineMs) {
    return { outcome: "unavailable", reason: "timeout", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  attemptedSignal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let fireTimeout: () => void = () => undefined;
  const timeoutFired = new Promise<never>((_, reject) => {
    fireTimeout = () => {
      timedOut = true;
      controller.abort();
      reject(new Error("jev-timeout"));
    };
  });
  // Header wait uses only the budget remaining after preparation.
  const timeoutId = setTimeout(fireTimeout, Math.max(0, deadlineMs - Date.now()));

  let response: Response;
  try {
    const attempt = fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    response = await Promise.race([attempt, timeoutFired]);
  } catch {
    const latencyMs = Date.now() - started;
    clearTimeout(timeoutId);
    attemptedSignal?.removeEventListener("abort", onAbort);
    if (isAborted(attemptedSignal) && !timedOut) {
      return { outcome: "stale", reason: "aborted", retry: none, latencyMs, inputVersion: attemptedVersion };
    }
    if (timedOut) {
      return { outcome: "unavailable", reason: "timeout", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs, inputVersion: attemptedVersion };
    }
    return { outcome: "unavailable", reason: "transport-error", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs, inputVersion: attemptedVersion };
  }
  clearTimeout(timeoutId);
  attemptedSignal?.removeEventListener("abort", onAbort);
  if (isAborted(attemptedSignal)) {
    discardBody(response);
    return { outcome: "stale", reason: "aborted", retry: none, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (Date.now() > deadlineMs) {
    discardBody(response);
    return { outcome: "unavailable", reason: "timeout", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }

  const status = response.status;
  if (status >= 300 && status < 400) {
    discardBody(response);
    return { outcome: "needsReview", reason: "redirect-refused", retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (status === 401) {
    discardBody(response);
    return { outcome: "needsReview", reason: "http-401", retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (status === 422) {
    discardBody(response);
    return { outcome: "needsReview", reason: "http-422", retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (status === 429 || status === 529) {
    discardBody(response);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const exceedsPolicy = retryAfterMs !== null && retryAfterMs > JEV_MAX_RETRY_AFTER_MS;
    const reason = exceedsPolicy ? `http-${String(status)}-retry-after-exceeds-policy` : `http-${String(status)}`;
    return { outcome: "unavailable", reason, retry: { kind: "retryable", status, retryAfterMs }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (status >= 400 && status < 500) {
    discardBody(response);
    return { outcome: "needsReview", reason: `http-${String(status)}`, retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (status < 200 || status >= 300) {
    discardBody(response);
    return { outcome: "unavailable", reason: `http-${String(status)}`, retry: { kind: "retryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }

  const budgetMs = Math.max(0, deadlineMs - Date.now());
  const bounded = await readBodyBounded(response, maxBytes, budgetMs, attemptedSignal);
  if (bounded.kind === "timeout") {
    return { outcome: "unavailable", reason: "timeout", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (bounded.kind === "aborted") {
    return { outcome: "stale", reason: "aborted", retry: none, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (bounded.kind === "error") {
    return { outcome: "unavailable", reason: "body-error", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (bounded.kind === "too-large") {
    return { outcome: "needsReview", reason: "response-too-large", retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (isAborted(attemptedSignal)) {
    return { outcome: "stale", reason: "aborted", retry: none, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  if (Date.now() > deadlineMs) {
    return { outcome: "unavailable", reason: "timeout", retry: { kind: "retryable", status: null, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bounded.text);
  } catch {
    return { outcome: "needsReview", reason: "response-not-json", retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  const checked = validResponse(payload, sent);
  if (!checked.ok) {
    const invalid: Invalid = checked;
    return { outcome: "needsReview", reason: invalid.reason, retry: { kind: "nonretryable", status, retryAfterMs: null }, latencyMs: Date.now() - started, inputVersion: attemptedVersion };
  }
  return {
    outcome: "decided",
    model: JEV_PINNED_MODEL,
    answers: checked.answers,
    usage: checked.usage,
    latencyMs: Date.now() - started,
    inputVersion: attemptedVersion,
  };
}
