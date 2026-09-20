/**
 * F1 J-02/J-04 compatible Jev validators and stale-result fencing
 * (controlled, ADR-0005). Reuses the accepted adapter's validators without
 * altering `convex/models/jev.ts` or `proofs/jev/jev-boundary.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  areValidJevQuestions,
  fenceJevResult,
  isValidJevQuestion,
  mayProceedToAuthorityCheck,
} from "./jevResults.js";
import type { JevAttemptResult } from "./jevResults.js";

const decidedChoice = (inputVersion: string): JevAttemptResult => ({
  outcome: "decided",
  model: "jev-1.13.0",
  answers: {
    move: {
      type: "choice",
      choice: "clarify",
      probabilities: { clarify: 0.7, hold: 0.3 },
      confidence: 0.7,
    },
  },
  usage: { input_tokens: 10, output_tokens: 4 },
  latencyMs: 12,
  inputVersion,
});

describe("J-02 question validation parity", () => {
  test("accepts well-formed noul, choice, and score questions", () => {
    expect(
      areValidJevQuestions({
        urgent: { type: "noul", instructions: "Is this urgent?" },
        move: {
          type: "choice",
          instructions: "Pick a move.",
          criteria: { clarify: "Ask", hold: "Wait" },
        },
        rank: { type: "score", instructions: "Score.", criteria: ["low", "high"] },
      }),
    ).toBe(true);
  });

  test("rejects empty maps, poisoned keys, and malformed questions", () => {
    expect(areValidJevQuestions({})).toBe(false);
    expect(areValidJevQuestions({ __proto__: { type: "noul", instructions: "x" } })).toBe(false);
    expect(isValidJevQuestion("q", { type: "choice", instructions: "Pick." })).toBe(false);
    expect(isValidJevQuestion("q", { type: "noul", instructions: "" })).toBe(false);
    expect(isValidJevQuestion("q", { type: "mystery", instructions: "Pick." })).toBe(false);
    expect(isValidJevQuestion("constructor", { type: "noul", instructions: "Is this urgent?" })).toBe(false);
  });

  test("rejects choice answers that cannot decide (covered at fence)", () => {
    expect(
      isValidJevQuestion("q", {
        type: "choice",
        instructions: "Pick.",
        criteria: {},
      }),
    ).toBe(false);
  });
});

describe("J-04 stale-result fencing", () => {
  test("current decided result is usable", () => {
    const fenced = fenceJevResult({
      result: decidedChoice("input-1"),
      currentInputVersion: "input-1",
      authorityCurrent: true,
    });
    expect(fenced.usable).toBe(true);
    expect(fenced.reason).toBe("current");
    expect(mayProceedToAuthorityCheck(fenced)).toBe(true);
  });

  test("late response after input change is stale and unusable", () => {
    const fenced = fenceJevResult({
      result: decidedChoice("input-1"),
      currentInputVersion: "input-2",
      authorityCurrent: true,
    });
    expect(fenced.usable).toBe(false);
    expect(fenced.reason).toBe("input-version-changed");
    expect(mayProceedToAuthorityCheck(fenced)).toBe(false);
  });

  test("revoked authority invalidates even a current decided result", () => {
    const fenced = fenceJevResult({
      result: decidedChoice("input-1"),
      currentInputVersion: "input-1",
      authorityCurrent: false,
    });
    expect(fenced.usable).toBe(false);
    expect(fenced.reason).toBe("authority-invalidated");
    expect(mayProceedToAuthorityCheck(fenced)).toBe(false);
  });

  test("non-decided results never authorize effects", () => {
    const review: JevAttemptResult = {
      outcome: "needsReview",
      reason: "invalid-questions",
      retry: { kind: "nonretryable", status: null, retryAfterMs: null },
      latencyMs: 3,
      inputVersion: "input-1",
    };
    const fenced = fenceJevResult({
      result: review,
      currentInputVersion: "input-1",
      authorityCurrent: true,
    });
    expect(fenced.usable).toBe(false);
    expect(mayProceedToAuthorityCheck(fenced)).toBe(false);
  });

  test("fenced decisions cannot authorize another recipient or revive a grant", () => {
    // The fence output carries no recipient or grant power: only the backend
    // claim (tested in execution suites) can permit an effect, and it
    // rechecks the live grant and recipient version.
    const fenced = fenceJevResult({
      result: decidedChoice("input-1"),
      currentInputVersion: "input-1",
      authorityCurrent: true,
    });
    expect(mayProceedToAuthorityCheck(fenced)).toBe(true);
    expect(JSON.stringify(fenced)).not.toContain("recipient");
    expect(JSON.stringify(fenced)).not.toContain("grant");
  });
});
