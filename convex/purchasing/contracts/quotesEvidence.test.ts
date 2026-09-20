/**
 * F1 quote/evidence contract tests (controlled, P-06/P-07/P-08 / D-02/D-08).
 *
 * €7,950 complete versus €7,500 + €600 + €400 = €8,500: the equivalent-scope
 * difference is €550 (55,000 minor units). Unknown charges block complete
 * claims. Versions are immutable; owner terms keep their provenance.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture } from "./fixtures.js";
import { provenanceLabel } from "../../shared/provenance.js";

const TAX = "NL-EUR-INCLUSIVE";
const source = (id: string) => ({ sourceId: id, version: "v1", locator: "controlled" });

function recordQuote(
  fixture: ReturnType<typeof buildControlledFixture>,
  version: string,
  lines: { lineId: string; amount: number }[],
  charges: { chargeId: string; state: string; amount?: number }[],
  counterpartyRole: "vendor" | "ownerStandIn" = "ownerStandIn",
) {
  const result = fixture.store.ingestProviderQuote(
    fixture.orgPrivateA,
    fixture.projAOpen,
    {
      version,
      currency: "EUR",
      lines: lines.map((line) => ({
        lineId: line.lineId,
        description: line.lineId,
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: line.amount },
        evidenceRefs: [source(`${line.lineId}-source`)],
      })),
      charges: charges.map((charge) => ({
        chargeId: charge.chargeId,
        label: charge.chargeId,
        state: charge.state,
        ...(charge.amount === undefined ? {} : { amount: { currency: "EUR", minorUnits: charge.amount } }),
      })),
      taxBasis: TAX,
      evidenceRefs: [source(`${version}-source`)],
      counterpartyRole,
      executionMode: "recorded",
    },
    fixture.now,
  );
  if (!result.ok) throw new Error(`record failed: ${result.ok === false ? result.message : ""}`);
  return result.value;
}

describe("P-07 equivalent-scope comparison", () => {
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
    expect(compared.value.reason).toContain("unknown-charge");
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
        lines: [],
        charges: [{ chargeId: "install", label: "install", state: "unknown", amount: { currency: "EUR", minorUnits: 0 } }],
        taxBasis: TAX,
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
        lines: [],
        charges: [],
        taxBasis: TAX,
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
        taxBasis: "NL-EUR-EXCLUSIVE",
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
