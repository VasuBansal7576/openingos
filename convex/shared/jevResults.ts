/**
 * F1 J-02/J-04 compatible Jev validators and stale-result fencing
 * (controlled contract, ADR-0005).
 *
 * This module does NOT alter the accepted Jev adapter in
 * `convex/models/jev.ts` or `proofs/jev/jev-boundary.ts`. It reuses their
 * exact question validators and freshness helpers so F1 policy decisions
 * (grant binding, recipient binding, expiry) compose with Jev results
 * without forking transport behavior.
 */

import {
  applyIfCurrent,
  isStaleInput,
  validChoiceQuestion,
  validNoulQuestion,
  validScoreQuestion,
  type JevAttemptResult,
  type JevQuestion,
} from "../../proofs/jev/jev-boundary.js";

export type { JevAttemptResult, JevQuestion };
export { applyIfCurrent, isStaleInput };

/** J-02: validate one question the same way the adapter does. */
export function isValidJevQuestion(id: string, question: unknown): boolean {
  if (id === "__proto__" || id === "constructor" || id === "prototype") return false;
  if (typeof question !== "object" || question === null || Array.isArray(question)) return false;
  const typed = question as { type?: unknown } & Record<string, unknown>;
  if (typed["type"] === "noul") return validNoulQuestion(typed as unknown as Parameters<typeof validNoulQuestion>[0]);
  if (typed["type"] === "choice") {
    return validChoiceQuestion(typed as unknown as Parameters<typeof validChoiceQuestion>[0]);
  }
  if (typed["type"] === "score") {
    return validScoreQuestion(typed as unknown as Parameters<typeof validScoreQuestion>[0]);
  }
  return false;
}

/** J-02: validate a whole question map; rejects empty and poisoned keys. */
export function areValidJevQuestions(questions: unknown): questions is Record<string, JevQuestion> {
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) return false;
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([id, question]) => isValidJevQuestion(id, question));
}

export interface FencedDecision {
  readonly usable: boolean;
  readonly result: JevAttemptResult;
  readonly reason: string;
}

/**
 * J-04: fence a validated Jev result before backend application.
 * A `decided` result is usable only when ALL hold:
 * - its input version still matches the current input version, and
 * - the grant/recipient authority that bound the request is still current.
 * Anything else becomes `usable: false` with a typed reason; the caller must
 * treat it as stale and perform zero external effects.
 */
export function fenceJevResult(input: {
  readonly result: JevAttemptResult;
  readonly currentInputVersion: string;
  readonly authorityCurrent: boolean;
}): FencedDecision {
  if (!input.authorityCurrent) {
    return { usable: false, result: input.result, reason: "authority-invalidated" };
  }
  const gated = applyIfCurrent(input.result, input.currentInputVersion);
  if (gated.outcome === "stale") {
    return { usable: false, result: gated, reason: "input-version-changed" };
  }
  if (gated.outcome !== "decided") {
    return { usable: false, result: gated, reason: gated.reason };
  }
  return { usable: true, result: gated, reason: "current" };
}

/**
 * J-04: a fenced `decided` result can never authorize another recipient,
 * revive an expired grant, or override a refusal. This helper answers
 * whether the decision may proceed to the backend authority checks (which
 * must still run); it never approves an effect by itself.
 */
export function mayProceedToAuthorityCheck(fenced: FencedDecision): boolean {
  return fenced.usable && fenced.result.outcome === "decided";
}
