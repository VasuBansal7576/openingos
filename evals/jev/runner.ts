/**
 * J-06 deterministic evaluation runner.
 *
 * Scores decision-type-specific candidate thresholds against the versioned
 * corpus. Pure and offline: no network, no live models, no provider calls.
 * Thresholds are keyed per decision type (plus model/question/eval versions);
 * this module never invents a universal threshold.
 *
 * Reported per decision type and candidate threshold:
 * - false-accept / false-reject counts and rates (equivalent error rates)
 * - intervention counts
 * - model-decision latency kept separate from total work latency
 */
import {
  EVAL_CATEGORIES,
  EVAL_CORPUS_VERSION,
  EVAL_MODEL_VERSION,
  EVAL_QUESTION_VERSION,
  type EvalCase,
  type EvalDecisionType,
} from "./corpus.js";

export interface ExpectedVersions {
  readonly evalVersion: string;
  readonly questionVersion: string;
  readonly modelVersion: string;
}

export interface ThresholdOutcome {
  readonly threshold: number;
  readonly accepted: number;
  readonly intervened: number;
  /** Accepted by the threshold but ground truth says intervene. */
  readonly falseAccepts: number;
  /** Sent to intervention by the threshold but ground truth says accept. */
  readonly falseRejects: number;
  /** falseAccepts / expected-intervene count; null when denominator is 0. */
  readonly falseAcceptRate: number | null;
  /** falseRejects / expected-accept count; null when denominator is 0. */
  readonly falseRejectRate: number | null;
  readonly interventionCount: number;
}

export interface LatencySummary {
  readonly count: number;
  readonly modelMeanMs: number;
  readonly modelP50Ms: number;
  readonly totalMeanMs: number;
  readonly totalP50Ms: number;
}

export interface DecisionTypeReport {
  readonly decisionType: EvalDecisionType;
  readonly evalVersion: string;
  readonly modelVersion: string;
  readonly questionVersion: string;
  readonly caseIds: readonly string[];
  readonly latency: LatencySummary;
  readonly outcomes: readonly ThresholdOutcome[];
}

export interface EvalCaseRow {
  readonly id: string;
  readonly category: string;
  readonly decisionType: EvalDecisionType;
  readonly inputVersion: string;
  readonly questionVersion: string;
  readonly modelVersion: string;
  readonly provenance: string;
  readonly expectedAccept: boolean;
}

export interface EvalReport {
  readonly evalVersion: string;
  readonly modelVersion: string;
  readonly questionVersion: string;
  /** Always controlled demo evidence; injected cases are labeled per row. */
  readonly evidenceMode: "controlled";
  readonly results: readonly DecisionTypeReport[];
  readonly cases: readonly EvalCaseRow[];
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function percentile50(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  const lower = sorted[middle - 1] as number;
  const upper = sorted[middle] as number;
  return (lower + upper) / 2;
}

function checkRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const rate = numerator / denominator;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`eval-malformed-rate:${numerator}/${denominator}`);
  }
  return rate;
}

/**
 * Validate one corpus case. Rejects drifted versions, nonfinite or
 * malformed metrics, and misleading live labels without guessing.
 */
function validateCase(
  raw: EvalCase,
  expected: ExpectedVersions,
): asserts raw is EvalCase {
  const record = raw as unknown as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("eval-malformed-case:missing-id");
  }
  if (typeof raw.inputVersion !== "string" || raw.inputVersion.length === 0) {
    throw new Error(`eval-malformed-case:${raw.id}:missing-input-version`);
  }
  if (raw.questionVersion !== expected.questionVersion) {
    throw new Error(`eval-version-drift:${raw.id}:question:${String(record["questionVersion"])}`);
  }
  const provenance = record["provenance"];
  if (provenance === "live" || provenance === "live-provider" || provenance === "production-live") {
    throw new Error(`eval-misleading-live-label:${raw.id}`);
  }
  if (provenance !== "controlled" && provenance !== "injected") {
    throw new Error(`eval-malformed-case:${raw.id}:provenance`);
  }
  if (!isFiniteInRange(raw.stubConfidence, 0, 1)) {
    throw new Error(`eval-malformed-metric:${raw.id}:confidence`);
  }
  if (
    typeof raw.stubModelLatencyMs !== "number" ||
    !Number.isFinite(raw.stubModelLatencyMs) ||
    raw.stubModelLatencyMs < 0 ||
    typeof raw.stubTotalWorkMs !== "number" ||
    !Number.isFinite(raw.stubTotalWorkMs) ||
    raw.stubTotalWorkMs < 0
  ) {
    throw new Error(`eval-malformed-metric:${raw.id}:latency`);
  }
  if (typeof raw.expectedAccept !== "boolean") {
    throw new Error(`eval-malformed-case:${raw.id}:expected`);
  }
}

function validateThresholds(
  thresholds: Record<EvalDecisionType, readonly number[]>,
): void {
  const keys = Object.keys(thresholds) as EvalDecisionType[];
  if (keys.length === 0) {
    throw new Error("eval-missing-thresholds:empty");
  }
  for (const decisionType of keys) {
    const set = thresholds[decisionType];
    if (set === undefined || set.length === 0) {
      throw new Error(`eval-missing-thresholds:${decisionType}`);
    }
    for (const threshold of set) {
      if (!isFiniteInRange(threshold, 0, 1) || threshold <= 0 || threshold >= 1) {
        throw new Error(`eval-malformed-threshold:${decisionType}:${String(threshold)}`);
      }
    }
  }
}

/**
 * Evaluate the corpus at the given per-decision-type candidate thresholds.
 * Input order is ignored: cases are sorted by id so results are stable.
 */
export function evaluateCorpus(
  cases: readonly EvalCase[],
  thresholds: Record<EvalDecisionType, readonly number[]>,
  expected: ExpectedVersions = {
    evalVersion: EVAL_CORPUS_VERSION,
    questionVersion: EVAL_QUESTION_VERSION,
    modelVersion: EVAL_MODEL_VERSION,
  },
): EvalReport {
  if (expected.evalVersion !== EVAL_CORPUS_VERSION) {
    throw new Error(`eval-version-drift:corpus:${expected.evalVersion}`);
  }
  if (expected.questionVersion !== EVAL_QUESTION_VERSION) {
    throw new Error(`eval-version-drift:question:${expected.questionVersion}`);
  }
  if (expected.modelVersion !== EVAL_MODEL_VERSION) {
    throw new Error(`eval-version-drift:model:${expected.modelVersion}`);
  }
  if (cases.length === 0) {
    throw new Error("eval-missing-category:empty-corpus");
  }
  validateThresholds(thresholds);

  const ordered = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Reject duplicate case IDs before grouping, scoring, latency summaries, or
  // evidence construction so a repeated case can never skew error rates or
  // intervention counts. This runs before any per-case metric reads, so no
  // model/adapter work is consumed by a duplicated corpus.
  const seenIds = new Set<string>();
  for (const item of ordered) {
    if (seenIds.has(item.id)) {
      throw new Error(`eval-duplicate-case:${item.id}`);
    }
    seenIds.add(item.id);
  }
  for (const item of ordered) validateCase(item, expected);

  const seenCategories = new Set<string>();
  for (const item of ordered) seenCategories.add(item.category);
  for (const required of EVAL_CATEGORIES) {
    if (!seenCategories.has(required)) {
      throw new Error(`eval-missing-category:${required}`);
    }
  }

  const byDecision = new Map<EvalDecisionType, EvalCase[]>();
  for (const item of ordered) {
    const group = byDecision.get(item.decisionType);
    if (group === undefined) byDecision.set(item.decisionType, [item]);
    else group.push(item);
  }

  const results: DecisionTypeReport[] = [];
  const decisionOrder = Object.keys(thresholds) as EvalDecisionType[];
  decisionOrder.sort();
  for (const decisionType of byDecision.keys()) {
    if (thresholds[decisionType] === undefined) {
      throw new Error(`eval-missing-thresholds:${decisionType}`);
    }
  }
  for (const decisionType of decisionOrder) {
    const group = byDecision.get(decisionType) ?? [];
    if (group.length === 0) {
      throw new Error(`eval-missing-decision-type:${decisionType}`);
    }
    const candidateSet = thresholds[decisionType] as readonly number[];
    const candidates = [...candidateSet].sort((a, b) => a - b);
    const expectedAcceptCount = group.filter((item) => item.expectedAccept).length;
    const expectedInterveneCount = group.length - expectedAcceptCount;

    const outcomes: ThresholdOutcome[] = candidates.map((threshold) => {
      let accepted = 0;
      let falseAccepts = 0;
      let falseRejects = 0;
      for (const item of group) {
        const decided = item.stubConfidence >= threshold;
        if (decided) {
          accepted += 1;
          if (!item.expectedAccept) falseAccepts += 1;
        } else if (item.expectedAccept) {
          falseRejects += 1;
        }
      }
      return {
        threshold,
        accepted,
        intervened: group.length - accepted,
        falseAccepts,
        falseRejects,
        falseAcceptRate: checkRate(falseAccepts, expectedInterveneCount),
        falseRejectRate: checkRate(falseRejects, expectedAcceptCount),
        interventionCount: group.length - accepted,
      };
    });

    const modelLatencies = group.map((item) => item.stubModelLatencyMs).sort((a, b) => a - b);
    const totalLatencies = group.map((item) => item.stubTotalWorkMs).sort((a, b) => a - b);
    results.push({
      decisionType,
      evalVersion: expected.evalVersion,
      questionVersion: expected.questionVersion,
      modelVersion: expected.modelVersion,
      caseIds: group.map((item) => item.id),
      latency: {
        count: group.length,
        modelMeanMs: mean(modelLatencies),
        modelP50Ms: percentile50(modelLatencies),
        totalMeanMs: mean(totalLatencies),
        totalP50Ms: percentile50(totalLatencies),
      },
      outcomes,
    });
  }

  return {
    evalVersion: expected.evalVersion,
    modelVersion: expected.modelVersion,
    questionVersion: expected.questionVersion,
    evidenceMode: "controlled",
    results,
    cases: ordered.map((item) => ({
      id: item.id,
      category: item.category,
      decisionType: item.decisionType,
      inputVersion: item.inputVersion,
      questionVersion: item.questionVersion,
      modelVersion: expected.modelVersion,
      provenance: item.provenance,
      expectedAccept: item.expectedAccept,
    })),
  };
}
