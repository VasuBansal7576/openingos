/**
 * F1 exact equivalent-scope comparison (controlled contract, ADR-0003).
 *
 * The comparison implements the accepted proofs/money/comparison.ts
 * semantics over stored quote documents, preserving the proofs status:
 * matched by stable comparison scope items (requirementId, scopeId,
 * itemId, lineId, unit, required quantity), so line reorder is tolerated
 * while unrelated aggregate-equal lines never compare. Unknown charges
 * block complete claims, estimates surface as their exact signed delta
 * range with no cheaper claim on a zero-crossing range, and only
 * complete comparisons carry a singular difference/cheaper. All
 * arithmetic is the proofs exact minor-unit math; this module only maps
 * proofs results to the F1 verdict shape shared by handlers and the
 * deterministic backend.
 */

import {
  compareStoredQuotes,
  type F1Comparison,
  type F1ComparisonStatus,
  type StoredComparableQuote,
} from "./quoteSemantics.js";

export interface ComparisonVerdict {
  readonly status: F1ComparisonStatus;
  readonly differenceMinorUnits: number | null;
  readonly cheaper: "left" | "right" | "equal" | null;
  readonly estimatedDeltaRange?: { readonly minimum: number; readonly maximum: number };
  readonly reason: string;
}

export function compareStoredQuoteDocuments(
  left: StoredComparableQuote,
  right: StoredComparableQuote,
): ComparisonVerdict {
  const result: F1Comparison = compareStoredQuotes(left, right);
  return {
    status: result.status,
    differenceMinorUnits: result.differenceMinorUnits,
    cheaper: result.cheaper,
    ...(result.estimatedDeltaRange === undefined ? {} : { estimatedDeltaRange: result.estimatedDeltaRange }),
    reason: result.reason,
  };
}

export type { StoredComparableQuote };
