import { expect, test } from "bun:test";
import { formatMoney, parseWorkbenchSnapshot, type WorkbenchSnapshot } from "../workbench-state";

/**
 * F2 parser contract regressions: the browser consumes the backend's
 * authoritative pairwise verdicts, native money, tax-basis identity and
 * complete comparison scope verbatim, and fails closed on malformed
 * verdict data. Nothing here ranks or subtracts offers itself.
 */

function baseSnapshot(offers: unknown): Record<string, unknown> {
  return {
    ok: true,
    project: {
      id: "project-1",
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      budgetMinorUnits: null,
      needByAt: null,
      createdAt: 1,
    },
    access: {
      role: "owner",
      capabilities: {
        canResearch: true,
        canRecordEvidence: true,
        canRecordQuote: true,
        canCompare: true,
        canCommunicate: true,
        canClarify: true,
        canApprove: true,
        canOpenServiceCase: true,
      },
    },
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: false },
    requirements: [],
    requirementsTruncated: false,
    candidates: offers,
    candidatesTruncated: false,
    jobs: [],
    jobsTruncated: false,
    decisions: [],
    decisionsTruncated: false,
    activity: { page: [], isDone: true, continueCursor: null },
    equipment: { assets: [], assetsTruncated: false },
  };
}

function quote(input: {
  readonly id: string;
  readonly currency: string;
  readonly totalMinorUnits: number | null;
  readonly total?: unknown;
  readonly taxBasis?: unknown;
  readonly comparisonScope?: unknown;
}): Record<string, unknown> {
  return {
    id: input.id,
    version: "v1",
    currency: input.currency,
    lines: [
      {
        lineId: "machine",
        description: "Machine",
        quantity: "1",
        unit: "piece",
        unitPrice: { currency: input.currency, minorUnits: input.totalMinorUnits ?? 0 },
      },
    ],
    charges: [],
    taxBasis: input.taxBasis ?? { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE" },
    createdAt: 1,
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: false },
    currentness: "current",
    superseded: false,
    totalMinorUnits: input.totalMinorUnits,
    comparableTotalMinorUnits: input.totalMinorUnits,
    total: input.total ?? (input.totalMinorUnits === null ? null : { currency: input.currency, minorUnits: input.totalMinorUnits }),
    comparisonScope: input.comparisonScope ?? {
      requirementId: "requirement-f2",
      scopeId: "scope-f2",
      items: [{ itemId: "item-f2", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
  };
}

function offer(input: {
  readonly id: string;
  readonly quote: unknown;
  readonly comparisons?: unknown;
}): Record<string, unknown> {
  return {
    id: input.id,
    requirementId: "requirement-f2",
    productModel: "Model",
    variant: "220V",
    compatibility: "pass",
    conversationState: "quoteReceived",
    latestValidQuote: input.quote,
    comparisons: input.comparisons ?? [],
    evidence: [],
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: false },
  };
}

function comparableVerdict(againstCandidateId: string, againstQuoteId: string, differenceMinorUnits: number, cheaper: "self" | "other" | "equal"): unknown {
  return {
    againstCandidateId,
    againstQuoteId,
    status: "comparable",
    reason: "equivalent-scope",
    differenceMinorUnits,
    cheaper,
    estimatedDeltaMinorUnits: null,
  };
}

function parse(offers: unknown): WorkbenchSnapshot | null {
  return parseWorkbenchSnapshot(baseSnapshot(offers), "project-1");
}

test("comparable pair keeps native money, tax identity, scope and the exact 54951 difference", () => {
  const snapshot = parse([
    offer({
      id: "offer-a",
      quote: quote({ id: "quote-a", currency: "EUR", totalMinorUnits: 795049 }),
      comparisons: [comparableVerdict("offer-b", "quote-b", 54951, "self")],
    }),
    offer({
      id: "offer-b",
      quote: quote({ id: "quote-b", currency: "EUR", totalMinorUnits: 850000 }),
      comparisons: [comparableVerdict("offer-a", "quote-a", 54951, "other")],
    }),
  ]);
  expect(snapshot).not.toBeNull();
  const [alpha, beta] = snapshot?.offers ?? [];
  expect(alpha?.quote?.totalMinorUnits).toBe(795049);
  expect(alpha?.quote?.total).toEqual({ currency: "EUR", minorUnits: 795049 });
  expect(beta?.quote?.total).toEqual({ currency: "EUR", minorUnits: 850000 });
  expect(alpha?.quote?.taxBasisId).toBe("NL-EUR-INCLUSIVE");
  expect(alpha?.quote?.comparisonScope).toEqual({
    requirementId: "requirement-f2",
    scopeId: "scope-f2",
    items: [{ itemId: "item-f2", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
  });
  expect(alpha?.comparisons).toEqual([
    {
      againstOfferId: "offer-b",
      againstQuoteId: "quote-b",
      status: "comparable",
      reason: "equivalent-scope",
      differenceMinorUnits: 54951,
      cheaper: "self",
      estimatedDeltaMinorUnits: null,
    },
  ]);
  expect(beta?.comparisons[0]?.cheaper).toBe("other");
});

test("money formatting preserves authoritative minor units without forced trailing zeros", () => {
  expect(formatMoney(54951, "EUR")).toContain("549.51");
  expect(formatMoney(850000, "EUR")).toContain("8,500");
});

test("mixed-currency, tax and scope verdicts parse with their machine statuses and reasons", () => {
  const snapshot = parse([
    offer({
      id: "offer-usd",
      quote: quote({ id: "quote-usd", currency: "USD", totalMinorUnits: 795049, taxBasis: { kind: "inclusive", basisId: "US-USD-INCLUSIVE" } }),
      comparisons: [
        {
          againstCandidateId: "offer-eur",
          againstQuoteId: "quote-eur",
          status: "incompatible",
          reason: "mixed-currency-requires-accepted-conversion-basis",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: null,
        },
      ],
    }),
    offer({
      id: "offer-eur",
      quote: quote({ id: "quote-eur", currency: "EUR", totalMinorUnits: 850000, taxBasis: { kind: "exclusive", basisId: "DE-EUR-EXCLUSIVE" } }),
      comparisons: [
        {
          againstCandidateId: "offer-usd",
          againstQuoteId: "quote-usd",
          status: "incompatible",
          reason: "mixed-currency-requires-accepted-conversion-basis",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: null,
        },
        {
          againstCandidateId: "offer-scope",
          againstQuoteId: "quote-scope",
          status: "incompatible",
          reason: "comparison scopes are not compatible: requirement-f2/scope-f2 [item-f2:1 piece] versus requirement-f2/scope-f2 [item-f2:1 piece, item-extra:1 piece]",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: null,
        },
        {
          againstCandidateId: "offer-unknown",
          againstQuoteId: "quote-unknown",
          status: "incomplete",
          reason: "Freight is unknown (not confirmed)",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: null,
        },
      ],
    }),
    offer({ id: "offer-scope", quote: quote({ id: "quote-scope", currency: "EUR", totalMinorUnits: 850000 }) }),
    offer({ id: "offer-unknown", quote: quote({ id: "quote-unknown", currency: "EUR", totalMinorUnits: null }) }),
  ]);
  expect(snapshot).not.toBeNull();
  // Every offer stays visible, including incompatible and incomplete ones.
  expect(snapshot?.offers.map((entry) => entry.id)).toEqual([
    "offer-usd",
    "offer-eur",
    "offer-scope",
    "offer-unknown",
  ]);
  const eur = snapshot?.offers.find((entry) => entry.id === "offer-eur");
  expect(eur?.comparisons).toHaveLength(3);
  expect(eur?.comparisons.map((entry) => entry.status)).toEqual([
    "incompatible",
    "incompatible",
    "incomplete",
  ]);
  const unknown = snapshot?.offers.find((entry) => entry.id === "offer-unknown");
  expect(unknown?.quote?.total).toBeNull();
  expect(unknown?.comparisons).toEqual([]);
});

test("an estimated verdict carries only its signed delta range", () => {
  const snapshot = parse([
    offer({
      id: "offer-a",
      quote: quote({ id: "quote-a", currency: "EUR", totalMinorUnits: null }),
      comparisons: [
        {
          againstCandidateId: "offer-b",
          againstQuoteId: "quote-b",
          status: "estimated",
          reason: "equivalent-scope-with-estimates",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: { minimum: -60000, maximum: -50000 },
        },
      ],
    }),
    offer({ id: "offer-b", quote: quote({ id: "quote-b", currency: "EUR", totalMinorUnits: 850000 }) }),
  ]);
  expect(snapshot).not.toBeNull();
  expect(snapshot?.offers[0]?.comparisons[0]?.estimatedDeltaMinorUnits).toEqual({
    minimum: -60000,
    maximum: -50000,
  });
});

test("a malformed verdict rejects the whole payload", () => {
  const brokenDifference = parse([
    offer({
      id: "offer-a",
      quote: quote({ id: "quote-a", currency: "EUR", totalMinorUnits: 795049 }),
      comparisons: [
        {
          againstCandidateId: "offer-b",
          againstQuoteId: "quote-b",
          status: "comparable",
          reason: "equivalent-scope",
          differenceMinorUnits: 54951.5,
          cheaper: "self",
          estimatedDeltaMinorUnits: null,
        },
      ],
    }),
    offer({ id: "offer-b", quote: quote({ id: "quote-b", currency: "EUR", totalMinorUnits: 850000 }) }),
  ]);
  expect(brokenDifference).toBeNull();

  const missingCheaper = parse([
    offer({
      id: "offer-a",
      quote: quote({ id: "quote-a", currency: "EUR", totalMinorUnits: 795049 }),
      comparisons: [
        {
          againstCandidateId: "offer-b",
          againstQuoteId: "quote-b",
          status: "comparable",
          reason: "equivalent-scope",
          differenceMinorUnits: 54951,
          estimatedDeltaMinorUnits: null,
        },
      ],
    }),
  ]);
  expect(missingCheaper).toBeNull();

  const unknownStatus = parse([
    offer({
      id: "offer-a",
      quote: quote({ id: "quote-a", currency: "EUR", totalMinorUnits: 795049 }),
      comparisons: [
        {
          againstCandidateId: "offer-b",
          againstQuoteId: "quote-b",
          status: "cheaper",
          reason: "guessing",
          differenceMinorUnits: null,
          cheaper: null,
          estimatedDeltaMinorUnits: null,
        },
      ],
    }),
  ]);
  expect(unknownStatus).toBeNull();
});

test("a total whose currency disagrees with the quote rejects the payload", () => {
  const snapshot = parse([
    offer({
      id: "offer-a",
      quote: quote({
        id: "quote-a",
        currency: "EUR",
        totalMinorUnits: 795049,
        total: { currency: "USD", minorUnits: 795049 },
      }),
    }),
  ]);
  expect(snapshot).toBeNull();
});

test("legacy payloads without the F2 blocks still parse without ranking data", () => {
  const legacyQuote = quote({ id: "quote-a", currency: "EUR", totalMinorUnits: 795049 });
  delete legacyQuote.total;
  delete legacyQuote.comparisonScope;
  const legacyOffer = {
    id: "offer-a",
    requirementId: "requirement-f2",
    productModel: "Model",
    variant: "220V",
    compatibility: "pass",
    conversationState: "quoteReceived",
    latestValidQuote: legacyQuote,
    evidence: [],
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: false },
  };
  const snapshot = parse([legacyOffer]);
  expect(snapshot).not.toBeNull();
  const offer = snapshot?.offers[0];
  expect(offer?.quote?.totalMinorUnits).toBe(795049);
  expect(offer?.quote?.total).toEqual({ currency: "EUR", minorUnits: 795049 });
  expect(offer?.quote?.taxBasisId).toBe("NL-EUR-INCLUSIVE");
  expect(offer?.quote?.comparisonScope).toBeNull();
  expect(offer?.comparisons).toEqual([]);
});
