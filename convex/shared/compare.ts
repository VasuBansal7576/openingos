/**
 * F1 exact equivalent-scope comparison (controlled contract, ADR-0003).
 *
 * The comparison implements the accepted proofs/money/comparison.ts
 * semantics over stored quote documents: matched by stable comparison
 * scope items (requirementId, scopeId, itemId, lineId, unit, required
 * quantity), so line reorder is tolerated while unrelated
 * aggregate-equal lines never compare. Unknown charges block complete
 * claims, estimates are flagged, and mixed currencies stay incomparable
 * until a conversion basis is accepted. All arithmetic is the proofs
 * exact minor-unit math; this module only maps proofs results to the F1
 * verdict shape shared by handlers and the deterministic backend.
 */

import {
  compareStoredQuotes,
  type F1Comparison,
  type StoredComparableQuote,
} from "./quoteSemantics.js";

export interface ComparisonVerdict {
  readonly verdict: "complete" | "incomplete";
  readonly differenceMinorUnits: number | null;
  readonly cheaper: "left" | "right" | "equal" | null;
  readonly reason: string;
}

export function compareStoredQuoteDocuments(
  left: StoredComparableQuote,
  right: StoredComparableQuote,
): ComparisonVerdict {
  const result: F1Comparison = compareStoredQuotes(left, right);
  return {
    verdict: result.verdict,
    differenceMinorUnits: result.differenceMinorUnits,
    cheaper: result.cheaper,
    reason: result.reason,
  };
}

export type { StoredComparableQuote };
