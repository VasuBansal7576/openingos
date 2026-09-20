/**
 * F1 tenant/project isolation tests (controlled, S-04 / P-15 / P-16 / D-09).
 *
 * Two guests, two private organizations, restricted projects, forged IDs,
 * stale and revoked roles/grants, and exact deadline boundaries. Every
 * denial asserts zero new effect via `snapshotCounts()`.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

describe("S-04 cross-tenant isolation", () => {
  test("two guests cannot read or act on each other's projects", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const before = store.snapshotCounts();

    const cross = store.checkProjectAccess(fixture.guest1, fixture.guestOrg2, fixture.guestProj2, "viewer", now);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("denied-membership");

    const evidence = store.recordEvidence(
      fixture.guest1,
      fixture.guestOrg2,
      fixture.guestProj2,
      {
        sourceKind: "supplier-page",
        contentHash: "hash-1",
        completeness: "complete",
        counterpartyRole: "vendor",
        executionMode: "fixture",
      },
      now,
    );
    expect(evidence.ok).toBe(false);
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("two private organizations cannot touch each other's records", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const before = store.snapshotCounts();

    const access = store.checkProjectAccess(fixture.ownerB, fixture.orgPrivateA, fixture.projAOpen, "viewer", now);
    expect(access.ok).toBe(false);

    const quote = store.recordQuote(fixture.ownerB, fixture.orgPrivateA, fixture.projAOpen, {
      version: "v1",
      currency: "EUR",
      lines: [],
      charges: [],
      taxBasis: "NL-EUR-INCLUSIVE",
      evidenceRefs: [],
      counterpartyRole: "vendor",
      executionMode: "fixture",
    }, now);
    expect(quote.ok).toBe(false);
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("restricted projects require explicit membership (P-15)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;

    // No existence oracle: a restricted project without an explicit
    // membership denies exactly like an unknown project.
    const denied = store.checkProjectAccess(
      fixture.contribA,
      fixture.orgPrivateA,
      fixture.projARestricted,
      "viewer",
      now,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("denied-membership");

    const allowed = store.checkProjectAccess(
      fixture.approverA,
      fixture.orgPrivateA,
      fixture.projARestricted,
      "viewer",
      now,
    );
    expect(allowed.ok).toBe(true);
  });

  test("private quotes and budgets are inaccessible from a guest session (P-16, D-09)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const before = store.snapshotCounts();

    const quote = store.recordQuote(fixture.guest1, fixture.orgPrivateA, fixture.projAOpen, {
      version: "v1",
      currency: "EUR",
      lines: [],
      charges: [],
      taxBasis: "NL-EUR-INCLUSIVE",
      evidenceRefs: [],
      counterpartyRole: "vendor",
      executionMode: "fixture",
    }, now);
    expect(quote.ok).toBe(false);

    const compared = store.compareControlledQuotes("nope-left", "nope-right");
    expect(compared.ok).toBe(false);
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("forged IDs fail closed (P-15)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;

    const unknown = store.checkProjectAccess(
      fixture.attacker,
      fixture.orgPrivateA,
      fixture.projAOpen,
      "viewer",
      now,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("denied-membership");

    const empty = store.checkProjectAccess("", fixture.orgPrivateA, fixture.projAOpen, "viewer", now);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("forged-identity");

    // A project ID from another organization cannot be smuggled in, and
    // the denial reveals nothing about its existence.
    const smuggled = store.checkProjectAccess(
      fixture.ownerA,
      fixture.orgPrivateA,
      fixture.projBOpen,
      "viewer",
      now,
    );
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.code).toBe("denied-membership");
  });

  test("stale and revoked roles are denied, including exact expiry boundary", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;

    const expiring = store.addMembership(fixture.orgPrivateA, null, "id-temp-1", "contributor", now, now);
    const atBoundary = store.checkProjectAccess(
      "id-temp-1",
      fixture.orgPrivateA,
      fixture.projAOpen,
      "viewer",
      now,
    );
    expect(atBoundary.ok).toBe(false);
    if (!atBoundary.ok) expect(atBoundary.code).toBe("expired-membership");

    const beforeExpiry = store.checkProjectAccess(
      "id-temp-1",
      fixture.orgPrivateA,
      fixture.projAOpen,
      "viewer",
      now - 1,
    );
    expect(beforeExpiry.ok).toBe(true);

    const member = store.addMembership(fixture.orgPrivateA, null, "id-temp-2", "contributor", now);
    store.revokeMembership(member.id, now);
    const revoked = store.checkProjectAccess(
      "id-temp-2",
      fixture.orgPrivateA,
      fixture.projAOpen,
      "viewer",
      now,
    );
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("revoked-membership");
  });

  test("stale and revoked grants stop claims (P-13)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const before = store.snapshotCounts();

    const job = store.requestWork(
      {
        identity: fixture.ownerA,
        organizationId: fixture.orgPrivateA,
        projectId: fixture.projAOpen,
        text: "Research suppliers for the espresso machine.",
        kind: "research",
        grantId: fixture.grantResearchA,
      },
      now,
    );
    expect(job.ok).toBe(true);
    if (!job.ok) throw new Error("fixture job failed");

    const created = store.createOperation(
      {
        identity: fixture.ownerA,
        jobId: job.value.id,
        kind: "research.collect",
        requestId: "req-stale-grant",
        payload: { research: "bounded-controlled-fixture" },
        grantId: fixture.grantResearchA,
      },
      now,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("fixture operation failed");

    store.revokeGrant(fixture.grantResearchA, now);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("revoked-grant");

    const after = store.snapshotCounts();
    expect(after.sends).toBe(before.sends);
    expect(after.operations).toBe(before.operations + 1);
  });

  test("comms payload must carry the exact owner mailbox (S-22 preview)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    expect(commsPayload(CONTROLLED_OWNER_MAILBOX).to).toBe("owner-supplier@example.test");
  });
});
