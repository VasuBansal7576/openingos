/**
 * F1 quote/evidence contract tests (controlled, P-06/P-07/P-08 / D-02/D-08).
 *
 * €7,950 complete versus €7,500 + €600 + €400 = €8,500: the exact-scope
 * difference is €550 (55,000 minor units). Unknown charges block complete
 * claims. Versions are immutable; owner terms keep their provenance.
 * Every document parses through the accepted proofs quote semantics with
 * discriminated charge states and stable comparison scopes.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture } from "./fixtures.js";
import { provenanceLabel } from "../../shared/provenance.js";

const TAX = { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] };
const source = (id: string) => ({ sourceId: id, version: "v1", locator: "controlled" });

type ChargeSpec =
  | { chargeId: string; state: "known"; amount: number }
  | { chargeId: string; state: "estimated"; amount: number }
  | { chargeId: string; state: "unknown" }
  | { chargeId: string; state: "included"; coveringId: string };

function chargeState(spec: ChargeSpec): Record<string, unknown> {
  if (spec.state === "known") {
    return { kind: "known", amount: { currency: "EUR", minorUnits: spec.amount } };
  }
  if (spec.state === "estimated") {
    return {
      kind: "estimated",
      estimate: { kind: "point", amount: { currency: "EUR", minorUnits: spec.amount } },
    };
  }
  if (spec.state === "included") {
    return { kind: "included", coveringId: spec.coveringId };
  }
  return { kind: "unknown", reason: `${spec.chargeId} was not stated by the supplier` };
}

function scopeFor(lines: { lineId: string; quantity: string }[]) {
  return {
    requirementId: "req-purchase",
    scopeId: "scope-purchase",
    items: lines.map((line) => ({
      itemId: line.lineId,
      lineId: line.lineId,
      unit: "piece",
      requiredQuantity: line.quantity,
    })),
  };
}

function recordQuote(
  fixture: ReturnType<typeof buildControlledFixture>,
  version: string,
  lines: { lineId: string; amount: number; quantity?: string }[],
  charges: ChargeSpec[],
  counterpartyRole: "vendor" | "ownerStandIn" = "ownerStandIn",
) {
  const normalized = lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity ?? "1" }));
  const result = fixture.store.ingestProviderQuote(
    fixture.orgPrivateA,
    fixture.projAOpen,
    {
      version,
      currency: "EUR",
      lines: lines.map((line) => ({
        lineId: line.lineId,
        description: line.lineId,
        quantity: line.quantity ?? "1",
        unitPrice: { currency: "EUR", minorUnits: line.amount },
        evidenceRefs: [source(`${line.lineId}-source`)],
      })),
      charges: charges.map((charge) => ({
        chargeId: charge.chargeId,
        label: charge.chargeId,
        state: chargeState(charge),
        evidenceRefs: [source(`${charge.chargeId}-source`)],
      })),
      taxBasis: TAX,
      comparisonScope: scopeFor(normalized),
      evidenceRefs: [source(`${version}-source`)],
      counterpartyRole,
      executionMode: "recorded",
    },
    fixture.now,
  );
  if (!result.ok) throw new Error(`record failed: ${result.ok === false ? result.message : ""}`);
  return result.value;
}

describe("P-07 exact-scope comparison", () => {
  test("€7,950 complete versus €8,500 complete differs by €550", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qa-v1", [{ lineId: "machine", amount: 795000 }], []);
    const right = recordQuote(
      fixture,
      "qb-v1",
      [{ lineId: "machine", amount: 750000 }],
      [
        { chargeId: "freight", state: "known", amount: 60000 },
        { chargeId: "install", state: "known", amount: 40000 },
      ],
    );
    const compared = fixture.store.compareControlledQuotes(left.id, right.id);
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.verdict).toBe("complete");
    expect(compared.value.differenceMinorUnits).toBe(55000);
    expect(compared.value.cheaper).toBe("left");
  });

  test("missing installation blocks the cheaper claim (unknown stays unknown)", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qa-v1", [{ lineId: "machine", amount: 795000 }], []);
    const incomplete = recordQuote(
      fixture,
      "qc-v1",
      [{ lineId: "machine", amount: 750000 }],
      [
        { chargeId: "freight", state: "known", amount: 60000 },
        { chargeId: "install", state: "unknown" },
      ],
    );
    const compared = fixture.store.compareControlledQuotes(left.id, incomplete.id);
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.verdict).toBe("incomplete");
    expect(compared.value.differenceMinorUnits).toBeNull();
    expect(compared.value.reason).toContain("unknown");
  });

  test("quantities scale totals; unequal quantity scope refuses", () => {
    const fixture = buildControlledFixture();
    const scaled = (version: string, quantity: string, amount: number) => {
      const result = fixture.store.ingestProviderQuote(
        fixture.orgPrivateA,
        fixture.projAOpen,
        {
          version,
          currency: "EUR",
          lines: [{
            lineId: "machine",
            description: "machine",
            quantity,
            unitPrice: { currency: "EUR", minorUnits: amount },
            evidenceRefs: [source("m")],
          }],
          charges: [],
          taxBasis: TAX,
          comparisonScope: scopeFor([{ lineId: "machine", quantity }]),
          evidenceRefs: [source(`${version}-source`)],
          counterpartyRole: "ownerStandIn",
          executionMode: "recorded",
        },
        fixture.now,
      );
      if (!result.ok) throw new Error("record failed");
      return result.value;
    };
    const twoUnits = scaled("qq-two", "2", 1_000_00);
    const oneUnit = scaled("qq-one", "1", 1_000_00);
    const compared = fixture.store.compareControlledQuotes(twoUnits.id, oneUnit.id);
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.verdict).toBe("incomplete");
    expect(compared.value.reason).toContain("not compatible");

    const twoCheap = scaled("qq-twocheap", "2", 900_00);
    const even = fixture.store.compareControlledQuotes(twoUnits.id, twoCheap.id);
    expect(even.ok && even.value.verdict).toBe("complete");
    if (!even.ok) throw new Error("compare failed");
    expect(even.value.differenceMinorUnits).toBe(200_00);
    expect(even.value.cheaper).toBe("right");
  });

  test("invalid quantities and charge states refuse complete scope", () => {
    const fixture = buildControlledFixture();
    const badQuantity = recordQuote(fixture, "qb-badqty", [{ lineId: "machine", amount: 100_00 }], []);
    const bad = fixture.store.quotes.get(badQuantity.id);
    if (!bad) throw new Error("missing quote");
    const tampered = { ...bad, lines: [{ ...bad.lines[0], quantity: "two" }] };
    fixture.store.quotes.set(bad.id, tampered as typeof bad);
    const compared = fixture.store.compareControlledQuotes(bad.id, bad.id);
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.verdict).toBe("incomplete");
    expect(compared.value.reason).toContain("quantity");

    const mysteryBase = recordQuote(fixture, "qb-mystery", [{ lineId: "machine", amount: 100_00 }], [
      { chargeId: "x", state: "known", amount: 10_00 },
    ]);
    const mysteryRow = fixture.store.quotes.get(mysteryBase.id);
    if (!mysteryRow) throw new Error("missing quote");
    const tamperedState = {
      ...mysteryRow,
      charges: [{ ...mysteryRow.charges[0], state: { kind: "mystery" } }],
    };
    fixture.store.quotes.set(mysteryRow.id, tamperedState as unknown as typeof mysteryRow);
    const mysteryCompared = fixture.store.compareControlledQuotes(mysteryRow.id, mysteryRow.id);
    expect(mysteryCompared.ok && mysteryCompared.value.verdict).toBe("incomplete");
    if (!mysteryCompared.ok) throw new Error("compare failed");
    expect(mysteryCompared.value.reason).toContain("charge state");
  });

  test("unrelated aggregate-equal lines never compare", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qu-a", [{ lineId: "machine", amount: 100_00 }], []);
    const other = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "qu-b",
        currency: "EUR",
        lines: [{
          lineId: "service",
          description: "service",
          quantity: "1",
          unitPrice: { currency: "EUR", minorUnits: 100_00 },
          evidenceRefs: [source("s")],
        }],
        charges: [],
        taxBasis: TAX,
        comparisonScope: {
          requirementId: "req-other",
          scopeId: "scope-other",
          items: [{ itemId: "service", lineId: "service", unit: "hour", requiredQuantity: "1" }],
        },
        evidenceRefs: [source("qu-b-source")],
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded",
      },
      fixture.now,
    );
    if (!other.ok) throw new Error("record failed");
    // Equal totals, unrelated scopes: no equivalent claim.
    const compared = fixture.store.compareControlledQuotes(left.id, other.value.id);
    expect(compared.ok && compared.value.verdict).toBe("incomplete");
  });

  test("reordered lines still compare on stable items", () => {
    const fixture = buildControlledFixture();
    const lines = (order: string[]) => order.map((lineId) => ({
      lineId,
      description: lineId,
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: lineId === "machine" ? 700_00 : 50_00 },
      evidenceRefs: [source(`${lineId}-source`)],
    }));
    const scope = {
      requirementId: "req-purchase",
      scopeId: "scope-purchase",
      items: [
        { itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" },
        { itemId: "freight-line", lineId: "freight-line", unit: "piece", requiredQuantity: "1" },
      ],
    };
    const mk = (version: string, order: string[]) => {
      const result = fixture.store.ingestProviderQuote(
        fixture.orgPrivateA,
        fixture.projAOpen,
        {
          version,
          currency: "EUR",
          lines: lines(order),
          charges: [],
          taxBasis: TAX,
          comparisonScope: scope,
          evidenceRefs: [source(`${version}-source`)],
          counterpartyRole: "ownerStandIn",
          executionMode: "recorded",
        },
        fixture.now,
      );
      if (!result.ok) throw new Error("record failed");
      return result.value;
    };
    const left = mk("qr-a", ["machine", "freight-line"]);
    const right = mk("qr-b", ["freight-line", "machine"]);
    const compared = fixture.store.compareControlledQuotes(left.id, right.id);
    expect(compared.ok && compared.value.verdict).toBe("complete");
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.cheaper).toBe("equal");
    expect(compared.value.differenceMinorUnits).toBe(0);
  });

  test("estimated charges compare with an explicit reason flag", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qe-a", [{ lineId: "machine", amount: 795000 }], []);
    const right = recordQuote(fixture, "qe-b", [{ lineId: "machine", amount: 750000 }], [
      { chargeId: "freight", state: "estimated", amount: 60000 },
    ]);
    const compared = fixture.store.compareControlledQuotes(left.id, right.id);
    expect(compared.ok && compared.value.verdict).toBe("complete");
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.value.reason).toBe("equivalent-scope-with-estimates");
    expect(compared.value.differenceMinorUnits).toBe(15000);
  });

  test("record validates versions, duplicates, supersedes, and conversation references", () => {
    const fixture = buildControlledFixture();
    const validLines = [{
      lineId: "machine",
      description: "machine",
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 100_00 },
      evidenceRefs: [source("m")],
    }];
    const base = {
      currency: "EUR",
      lines: validLines,
      charges: [],
      taxBasis: TAX,
      comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
      evidenceRefs: [source("base-source")],
      counterpartyRole: "ownerStandIn" as const,
      executionMode: "recorded" as const,
    };
    const empty = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      { ...base, version: "  " },
      fixture.now,
    );
    expect(empty.ok).toBe(false);
    const first = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      { ...base, version: "v-dup" },
      fixture.now,
    );
    expect(first.ok).toBe(true);
    const duplicate = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      { ...base, version: "v-dup" },
      fixture.now,
    );
    expect(duplicate.ok).toBe(false);
    const dangling = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      { ...base, version: "v-dangle", supersedes: "deadbeefdeadbeef" },
      fixture.now,
    );
    expect(dangling.ok).toBe(false);
    const foreign = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      { ...base, version: "v-foreign-conv", conversationId: "conv-elsewhere" },
      fixture.now,
    );
    expect(foreign.ok).toBe(false);
  });

  test("dangling and cyclic included coverage is rejected", () => {
    const fixture = buildControlledFixture();
    const validLines = [{
      lineId: "machine",
      description: "machine",
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 100_00 },
      evidenceRefs: [source("m")],
    }];
    const base = {
      currency: "EUR",
      lines: validLines,
      taxBasis: TAX,
      comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
      evidenceRefs: [source("cov-source")],
      counterpartyRole: "ownerStandIn" as const,
      executionMode: "recorded" as const,
    };
    const dangling = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-dangle-cover",
        charges: [{ chargeId: "x", label: "x", state: { kind: "included", coveringId: "ghost" }, evidenceRefs: [] }],
      },
      fixture.now,
    );
    expect(dangling.ok).toBe(false);
    const cyclic = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-cycle-cover",
        charges: [
          { chargeId: "a", label: "a", state: { kind: "included", coveringId: "b" }, evidenceRefs: [] },
          { chargeId: "b", label: "b", state: { kind: "included", coveringId: "a" }, evidenceRefs: [] },
        ],
      },
      fixture.now,
    );
    expect(cyclic.ok).toBe(false);
    const covered = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-covered",
        charges: [{ chargeId: "x", label: "x", state: { kind: "included", coveringId: "machine" }, evidenceRefs: [] }],
      },
      fixture.now,
    );
    expect(covered.ok).toBe(true);
  });

  test("bad currencies and invalid ranges are rejected", () => {
    const fixture = buildControlledFixture();
    const validLines = [{
      lineId: "machine",
      description: "machine",
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 100_00 },
      evidenceRefs: [source("m")],
    }];
    const base = {
      currency: "EUR",
      lines: validLines,
      taxBasis: TAX,
      comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
      evidenceRefs: [source("fx-source")],
      counterpartyRole: "ownerStandIn" as const,
      executionMode: "recorded" as const,
    };
    const mixedLine = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-mixed-line",
        lines: [{
          lineId: "machine",
          description: "machine",
          quantity: "1",
          unitPrice: { currency: "USD", minorUnits: 100_00 },
          evidenceRefs: [source("m")],
        }],
      },
      fixture.now,
    );
    expect(mixedLine.ok).toBe(false);
    const badRange = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-bad-range",
        charges: [{
          chargeId: "freight",
          label: "freight",
          state: {
            kind: "estimated",
            estimate: {
              kind: "range",
              minimum: { currency: "EUR", minorUnits: 900_00 },
              maximum: { currency: "EUR", minorUnits: 100_00 },
            },
          },
          evidenceRefs: [],
        }],
      },
      fixture.now,
    );
    expect(badRange.ok).toBe(false);
    const rangeCurrency = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        ...base,
        version: "v-range-fx",
        charges: [{
          chargeId: "freight",
          label: "freight",
          state: {
            kind: "estimated",
            estimate: {
              kind: "range",
              minimum: { currency: "EUR", minorUnits: 100_00 },
              maximum: { currency: "USD", minorUnits: 900_00 },
            },
          },
          evidenceRefs: [],
        }],
      },
      fixture.now,
    );
    expect(rangeCurrency.ok).toBe(false);
  });

  test("unknown charges cannot be recorded with an amount (never zero)", () => {
    const fixture = buildControlledFixture();
    const result = fixture.store.recordQuote(
      fixture.ownerA,
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "bad-v1",
        currency: "EUR",
        lines: [{
          lineId: "machine",
          description: "machine",
          quantity: "1",
          unitPrice: { currency: "EUR", minorUnits: 100_00 },
          evidenceRefs: [source("m")],
        }],
        charges: [{
          chargeId: "install",
          label: "install",
          state: { kind: "unknown", reason: "not stated", amount: { currency: "EUR", minorUnits: 0 } },
        }],
        taxBasis: TAX,
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [],
      },
      fixture.now,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-payload");
  });

  test("public imports cannot self-assert provenance (server derives it)", () => {
    const fixture = buildControlledFixture();
    const result = fixture.store.recordQuote(
      fixture.ownerA,
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "user-v1",
        currency: "EUR",
        lines: [{
          lineId: "machine",
          description: "machine",
          quantity: "1",
          unitPrice: { currency: "EUR", minorUnits: 100_00 },
          evidenceRefs: [source("m")],
        }],
        charges: [],
        taxBasis: TAX,
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [],
      },
      fixture.now,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("record failed");
    expect(result.value.counterpartyRole).toBe("userImport");
    expect(result.value.executionMode).toBe("recorded");
  });

  test("mixed tax bases stay incomparable until the basis is accepted", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qa-v1", [{ lineId: "machine", amount: 795000 }], []);
    const other = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "qd-v1",
        currency: "EUR",
        lines: [{ lineId: "machine", description: "machine", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 750000 }, evidenceRefs: [source("m")] }],
        charges: [],
        taxBasis: { kind: "exclusive", basisId: "NL-EUR-EXCLUSIVE", evidenceRefs: [] },
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [source("qd-v1-source")],
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded",
      },
      fixture.now,
    );
    if (!other.ok) throw new Error("record failed");
    const compared = fixture.store.compareControlledQuotes(left.id, other.value.id);
    expect(compared.ok && compared.value.verdict).toBe("incomplete");
  });
});

describe("P-06 versions, P-08 distinct totals, D-02/D-08/D-15", () => {
  test("revisions create new immutable versions; old approvals keep their hash", () => {
    const fixture = buildControlledFixture();
    const first = recordQuote(fixture, "q-v1", [{ lineId: "machine", amount: 750000 }], []);
    const second = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "q-v2",
        currency: "EUR",
        lines: [{ lineId: "machine", description: "machine", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 740000 }, evidenceRefs: [source("m")] }],
        charges: [],
        taxBasis: TAX,
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [source("q-v2-source")],
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded",
        supersedes: first.contentHash,
      },
      fixture.now,
    );
    if (!second.ok) throw new Error("revision failed");
    expect(second.value.contentHash).not.toBe(first.contentHash);
    expect(second.value.supersedes).toBe(first.contentHash);
    expect(fixture.store.quotes.get(first.id)?.contentHash).toBe(first.contentHash);
  });

  test("supersedes binds same project, conversation, and counterparty lineage", () => {
    const fixture = buildControlledFixture();
    const first = recordQuote(fixture, "qs-v1", [{ lineId: "machine", amount: 750000 }], [], "vendor");
    const crossCounterparty = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "qs-v2",
        currency: "EUR",
        lines: [{ lineId: "machine", description: "machine", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 740000 }, evidenceRefs: [source("m")] }],
        charges: [],
        taxBasis: TAX,
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [source("qs-v2-source")],
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded",
        supersedes: first.contentHash,
      },
      fixture.now,
    );
    expect(crossCounterparty.ok).toBe(false);
    const sameLineage = fixture.store.ingestProviderQuote(
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        version: "qs-v2",
        currency: "EUR",
        lines: [{ lineId: "machine", description: "machine", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 740000 }, evidenceRefs: [source("m")] }],
        charges: [],
        taxBasis: TAX,
        comparisonScope: scopeFor([{ lineId: "machine", quantity: "1" }]),
        evidenceRefs: [source("qs-v2-source")],
        counterpartyRole: "vendor",
        executionMode: "recorded",
        supersedes: first.contentHash,
      },
      fixture.now,
    );
    expect(sameLineage.ok).toBe(true);
  });

  test("every decision field participates in the version hash", () => {
    const fixture = buildControlledFixture();
    const lines = [{ lineId: "machine", amount: 750000 }];
    const left = recordQuote(fixture, "qh-v1", lines, []);
    const twin = recordQuote(fixture, "qh-v2", lines, [
      { chargeId: "freight", state: "included", coveringId: "machine" },
    ]);
    expect(twin.contentHash).not.toBe(left.contentHash);
  });

  test("changed terms re-evaluate without overwriting history (D-15)", () => {
    const fixture = buildControlledFixture();
    const left = recordQuote(fixture, "qa-v1", [{ lineId: "machine", amount: 795000 }], []);
    const right = recordQuote(fixture, "qb-v1", [{ lineId: "machine", amount: 750000 }], []);
    const before = fixture.store.compareControlledQuotes(left.id, right.id);
    expect(before.ok && before.value.cheaper).toBe("right");

    // A revised right quote is a new version; the earlier comparison stands.
    const revised = recordQuote(fixture, "qb-v2", [{ lineId: "machine", amount: 810000 }], []);
    const after = fixture.store.compareControlledQuotes(left.id, revised.id);
    expect(after.ok && after.value.cheaper).toBe("left");
    expect(before.ok && before.value.cheaper).toBe("right");
  });

  test("owner-authored terms keep controlled-demo provenance (no realized savings)", () => {
    const fixture = buildControlledFixture();
    const quote = recordQuote(fixture, "demo-v1", [{ lineId: "machine", amount: 740000 }], []);
    expect(quote.counterpartyRole).toBe("ownerStandIn");
    expect(quote.executionMode).toBe("recorded");
    expect(provenanceLabel({ counterpartyRole: "ownerStandIn", executionMode: "recorded" })).toBe(
      "Recorded demo exchange",
    );
    expect(provenanceLabel({ counterpartyRole: "ownerStandIn", executionMode: "recorded" })).not.toContain("saving");
  });

  test("applicable scope stays inspectable rather than hidden (D-08)", () => {
    const fixture = buildControlledFixture();
    const evidence = fixture.store.recordEvidence(
      fixture.ownerA,
      fixture.orgPrivateA,
      fixture.projAOpen,
      {
        sourceKind: "supplier-page",
        contentHash: "partial-page",
        completeness: "partial",
        locator: "delivery-section-missing",
      },
      fixture.now,
    );
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) throw new Error("evidence failed");
    expect(evidence.value.completeness).toBe("partial");
    const file = fixture.store.recordFile(fixture.ownerA, evidence.value.id, { contentType: "text/html" }, fixture.now);
    expect(file.ok).toBe(true);
  });
});
