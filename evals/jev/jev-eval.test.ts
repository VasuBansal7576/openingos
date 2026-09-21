/**
 * J-06 controlled evaluation tests. Offline only: fixed stub confidences and
 * latencies, no network, no live models, no provider claims. Every result is
 * labeled controlled (or injected per row); nothing here is live evidence.
 */
import { describe, expect, test } from "bun:test";
import {
  CANDIDATE_THRESHOLDS,
  EVAL_CATEGORIES,
  EVAL_CORPUS_VERSION,
  EVAL_MODEL_VERSION,
  EVAL_QUESTION_VERSION,
  J06_CORPUS,
  type EvalCase,
} from "./corpus.js";
import { evaluateCorpus } from "./runner.js";

function thresholdsCopy(): Record<
  "offer-completeness" | "followup-scope" | "scope-classification" | "injection-refusal" | "reply-freshness",
  readonly number[]
> {
  return {
    "offer-completeness": [...CANDIDATE_THRESHOLDS["offer-completeness"]],
    "followup-scope": [...CANDIDATE_THRESHOLDS["followup-scope"]],
    "scope-classification": [...CANDIDATE_THRESHOLDS["scope-classification"]],
    "injection-refusal": [...CANDIDATE_THRESHOLDS["injection-refusal"]],
    "reply-freshness": [...CANDIDATE_THRESHOLDS["reply-freshness"]],
  };
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1);
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

describe("J-06 domain evaluation corpus", () => {
  test("covers all five required categories", () => {
    const seen = new Set(J06_CORPUS.map((item) => item.category));
    for (const required of EVAL_CATEGORIES) {
      expect(seen.has(required)).toBe(true);
    }
    expect(J06_CORPUS.length).toBeGreaterThanOrEqual(EVAL_CATEGORIES.length);
  });

  test("uses per-decision-type candidate thresholds, not one universal value", () => {
    const sets = Object.values(CANDIDATE_THRESHOLDS).map((set) => [...set].sort().join(","));
    expect(new Set(sets).size).toBeGreaterThan(1);
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    expect(report.results.length).toBe(5);
    for (const result of report.results) {
      expect(result.outcomes.length).toBeGreaterThan(0);
    }
  });

  test("computes false-accept and intervention counts on a known slice", () => {
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    const completeness = report.results.find((r) => r.decisionType === "offer-completeness");
    if (completeness === undefined) throw new Error("missing offer-completeness report");
    // Confidences: 0.55 (expect intervene), 0.9 (expect accept), 0.72 (expect intervene).
    const at06 = completeness.outcomes.find((o) => o.threshold === 0.6);
    if (at06 === undefined) throw new Error("missing 0.6 outcome");
    expect(at06.falseAccepts).toBe(1);
    expect(at06.falseRejects).toBe(0);
    expect(at06.falseAcceptRate).toBe(0.5);
    expect(at06.falseRejectRate).toBe(0);
    expect(at06.interventionCount).toBe(1);
    expect(at06.intervened).toBe(1);
  });

  test("keeps model-decision latency separate from total work", () => {
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    for (const result of report.results) {
      expect(result.latency.count).toBeGreaterThan(0);
      expect(Number.isFinite(result.latency.modelMeanMs)).toBe(true);
      expect(Number.isFinite(result.latency.totalMeanMs)).toBe(true);
      expect(result.latency.totalMeanMs).toBeGreaterThan(result.latency.modelMeanMs);
      expect(result.latency.modelP50Ms).toBeGreaterThanOrEqual(0);
      expect(result.latency.totalP50Ms).toBeGreaterThanOrEqual(result.latency.modelP50Ms);
    }
  });

  test("preserves model, input, question, and evaluation versions on every row", () => {
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    expect(report.evalVersion).toBe(EVAL_CORPUS_VERSION);
    expect(report.modelVersion).toBe(EVAL_MODEL_VERSION);
    expect(report.questionVersion).toBe(EVAL_QUESTION_VERSION);
    expect(report.evidenceMode).toBe("controlled");
    for (const row of report.cases) {
      expect(row.modelVersion).toBe(EVAL_MODEL_VERSION);
      expect(row.questionVersion).toBe(EVAL_QUESTION_VERSION);
      expect(row.inputVersion.length).toBeGreaterThan(0);
    }
  });

  test("labels injected adversarial cases without claiming live outcomes", () => {
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    const adversarial = report.cases.filter((row) => row.category === "adversarial");
    expect(adversarial.length).toBeGreaterThan(0);
    for (const row of adversarial) {
      expect(row.provenance).toBe("injected");
    }
    const payload = JSON.stringify(report);
    expect(payload).not.toContain("live");
  });

  test("is deterministic under shuffled input order", () => {
    const first = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    const second = evaluateCorpus(shuffled(J06_CORPUS), thresholdsCopy());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const ids = first.cases.map((row) => row.id);
    expect([...ids].sort()).toEqual(ids);
  });

  test("rejects duplicate case IDs before scoring, latency, or evidence construction", () => {
    const first = J06_CORPUS[0];
    if (first === undefined) throw new Error("empty corpus");
    const appended: EvalCase[] = [...J06_CORPUS, { ...first }];
    expect(() => evaluateCorpus(appended, thresholdsCopy())).toThrow("eval-duplicate-case:j06-inc-01");
    const prepended: EvalCase[] = [{ ...first }, ...J06_CORPUS];
    expect(() => evaluateCorpus(prepended, thresholdsCopy())).toThrow("eval-duplicate-case:j06-inc-01");
  });

  test("rejects duplicates without reading stub metrics, so no model work is consumed", () => {
    const first = J06_CORPUS[0];
    if (first === undefined) throw new Error("empty corpus");
    const boobyTrapped = { ...first };
    Object.defineProperty(boobyTrapped, "stubConfidence", {
      enumerable: true,
      get() {
        throw new Error("model-called");
      },
    });
    Object.defineProperty(boobyTrapped, "stubModelLatencyMs", {
      enumerable: true,
      get() {
        throw new Error("model-called");
      },
    });
    expect(() => evaluateCorpus([...J06_CORPUS, boobyTrapped], thresholdsCopy())).toThrow("eval-duplicate-case");
  });

  test("keeps the valid corpus free of duplicates and skew", () => {
    const report = evaluateCorpus(J06_CORPUS, thresholdsCopy());
    expect(report.cases.length).toBe(J06_CORPUS.length);
    expect(new Set(report.cases.map((row) => row.id)).size).toBe(J06_CORPUS.length);
    const scored = report.results.reduce((total, result) => total + result.latency.count, 0);
    expect(scored).toBe(J06_CORPUS.length);
  });

  test("rejects a corpus missing a required category", () => {
    const subset = J06_CORPUS.filter((item) => item.category !== "adversarial");
    expect(() => evaluateCorpus(subset, thresholdsCopy())).toThrow("eval-missing-category:adversarial");
  });

  test("rejects drifted question, model, and corpus versions", () => {
    const driftedQuestion = J06_CORPUS.map((item) =>
      item.id === "j06-inc-01" ? { ...item, questionVersion: "j06-questions-v2" } : item,
    );
    expect(() => evaluateCorpus(driftedQuestion, thresholdsCopy())).toThrow("eval-version-drift");
    expect(() =>
      evaluateCorpus(J06_CORPUS, thresholdsCopy(), {
        evalVersion: EVAL_CORPUS_VERSION,
        questionVersion: EVAL_QUESTION_VERSION,
        modelVersion: "jev-latest",
      }),
    ).toThrow("eval-version-drift:model");
    expect(() =>
      evaluateCorpus(J06_CORPUS, thresholdsCopy(), {
        evalVersion: "j06-corpus-v0",
        questionVersion: EVAL_QUESTION_VERSION,
        modelVersion: EVAL_MODEL_VERSION,
      }),
    ).toThrow("eval-version-drift:corpus");
  });

  test("rejects nonfinite or malformed metrics", () => {
    const first = J06_CORPUS[0];
    if (first === undefined) throw new Error("empty corpus");
    const nanConfidence: EvalCase[] = [
      { ...first, stubConfidence: Number.NaN },
      ...J06_CORPUS.slice(1),
    ];
    expect(() => evaluateCorpus(nanConfidence, thresholdsCopy())).toThrow("eval-malformed-metric");
    const infiniteLatency: EvalCase[] = [
      { ...first, stubModelLatencyMs: Number.POSITIVE_INFINITY },
      ...J06_CORPUS.slice(1),
    ];
    expect(() => evaluateCorpus(infiniteLatency, thresholdsCopy())).toThrow("eval-malformed-metric");
  });

  test("rejects misleading live labels", () => {
    const first = J06_CORPUS[0];
    if (first === undefined) throw new Error("empty corpus");
    const liveLabeled = [
      { ...first, provenance: "live" },
      ...J06_CORPUS.slice(1),
    ] as unknown as EvalCase[];
    expect(() => evaluateCorpus(liveLabeled, thresholdsCopy())).toThrow("eval-misleading-live-label");
  });

  test("rejects missing or malformed per-type thresholds", () => {
    const partial = thresholdsCopy();
    const narrowed = {
      "offer-completeness": partial["offer-completeness"],
      "followup-scope": partial["followup-scope"],
      "scope-classification": partial["scope-classification"],
      "injection-refusal": partial["injection-refusal"],
    } as unknown as Parameters<typeof evaluateCorpus>[1];
    expect(() => evaluateCorpus(J06_CORPUS, narrowed)).toThrow("eval-missing-thresholds");
    const malformed = thresholdsCopy();
    const bad = {
      ...malformed,
      "injection-refusal": [Number.NaN],
    } as unknown as Parameters<typeof evaluateCorpus>[1];
    expect(() => evaluateCorpus(J06_CORPUS, bad)).toThrow("eval-malformed-threshold");
  });
});
