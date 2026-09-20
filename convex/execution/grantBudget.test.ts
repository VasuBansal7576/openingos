/**
 * F1 grant ceilings, round limits, and binding tests (controlled, C2).
 *
 * Reservations and claims bind to the grant cost ceiling; operations bind
 * to the job's grant; rounds are counted per grant for C1. Claims compare
 * the operation's captured input versions against current authority
 * (F1-22) and recheck reservation job/budget/org relationships (F1-24).
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";

function commsJob(fixture: ReturnType<typeof buildControlledFixture>, grantId?: string) {
  const job = fixture.store.requestWork(
    {
      identity: fixture.ownerA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projAOpen,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: grantId ?? fixture.grantCommsA,
    },
    fixture.now,
  );
  if (!job.ok) throw new Error("job failed");
  return job.value;
}

describe("grant numeric authority fields validate at issue", () => {
  function baseGrant(
    fixture: ReturnType<typeof buildControlledFixture>,
    overrides: {
      roundLimit?: number;
      recipientConfigVersion?: number;
      conversationId?: string;
      costCeilingMicroUsd?: number;
    } = {},
  ) {
    return {
      issuerIdentity: fixture.ownerA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projAOpen,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
      costCeilingMicroUsd: 500_000,
      roundLimit: 3,
      expiresAt: fixture.now + 3_600_000,
      ...overrides,
    };
  }

  test("roundLimit zero is rejected", () => {
    const fixture = buildControlledFixture();
    const grant = fixture.store.issueGrant(baseGrant(fixture, { roundLimit: 0 }), fixture.now);
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.code).toBe("invalid-payload");
  });

  test("comms grants must bind the active recipient version", () => {
    const fixture = buildControlledFixture();
    fixture.store.configureRecipient("owner-supplier-2@example.test", "deployment", fixture.now);
    const stale = fixture.store.issueGrant(baseGrant(fixture, { recipientConfigVersion: 1 }), fixture.now);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("invalid-payload");
    const current = fixture.store.issueGrant(baseGrant(fixture, { recipientConfigVersion: 2 }), fixture.now);
    expect(current.ok).toBe(true);
  });

  test("grants must own their conversation", () => {
    const fixture = buildControlledFixture();
    const foreign = fixture.store.issueGrant(
      baseGrant(fixture, { conversationId: "conv-elsewhere" }),
      fixture.now,
    );
    expect(foreign.ok).toBe(false);
  });
});

describe("grant ceilings bind reservations and claims", () => {
  test("reservation above the grant ceiling is denied", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = commsJob(fixture);
    // Fixture comms grant ceiling is 2M; the shared budget ceiling is 1M.
    const tooMuch = store.reserve(job.id, 2_000_001, "controlled-fixture", now);
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.code).toBe("grant-ceiling-exceeded");
  });

  test("job reservation totals cannot exceed the grant ceiling", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grant = store.issueGrant(
      {
        issuerIdentity: fixture.ownerA,
        organizationId: fixture.orgPrivateA,
        projectId: fixture.projAOpen,
        operations: ["communication.send"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: { brief: "v9" },
        payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
        costCeilingMicroUsd: 150_000,
        roundLimit: 5,
        expiresAt: now + 3_600_000,
      },
      now,
    );
    if (!grant.ok) throw new Error("grant failed");
    const job = commsJob(fixture, grant.value.id);
    expect(store.reserve(job.id, 100_000, "controlled-fixture", now).ok).toBe(true);
    const second = store.reserve(job.id, 100_000, "controlled-fixture", now);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("grant-ceiling-exceeded");
  });
});

describe("round limits bind operations per grant (C1)", () => {
  test("creating beyond the round limit is denied", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grant = store.issueGrant(
      {
        issuerIdentity: fixture.ownerA,
        organizationId: fixture.orgPrivateA,
        projectId: fixture.projAOpen,
        operations: ["communication.send"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: { brief: "rounds" },
        payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
        costCeilingMicroUsd: 500_000,
        roundLimit: 1,
        expiresAt: now + 3_600_000,
      },
      now,
    );
    if (!grant.ok) throw new Error("grant failed");
    const job = commsJob(fixture, grant.value.id);
    const first = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-r1", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: grant.value.id },
      now,
    );
    expect(first.ok).toBe(true);
    const second = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-r2", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: grant.value.id },
      now,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("round-limit-exceeded");
  });
});

describe("F1-23 operation grant binds to the job grant", () => {
  test("an alternate grant cannot claim under a revoked job grant", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grant2 = store.issueGrant(
      {
        issuerIdentity: fixture.ownerA,
        organizationId: fixture.orgPrivateA,
        projectId: fixture.projAOpen,
        operations: ["communication.send"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: { brief: "v1" },
        payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
        costCeilingMicroUsd: 500_000,
        roundLimit: 3,
        expiresAt: now + 3_600_000,
      },
      now,
    );
    if (!grant2.ok) throw new Error("grant2 failed");
    const job = commsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-alt-grant", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: grant2.value.id },
      now,
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("denied-capability");
  });
});

describe("F1-22 coordinated input-version advancement", () => {
  test("claim compares captured versions against current authority", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = commsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-versions", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    // Coordinated advancement of job and grant together must still stale
    // the prepared operation's captured versions.
    const jobRow = store.jobs.get(job.id);
    const grantRow = store.grants.get(fixture.grantCommsA);
    if (!jobRow || !grantRow) throw new Error("missing rows");
    store.jobs.set(job.id, { ...jobRow, inputVersions: { brief: "v2" } });
    store.grants.set(fixture.grantCommsA, { ...grantRow, inputVersions: { brief: "v2" } });
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("stale-input-version");
  });
});

describe("F1-24 reservation relationship rechecks at claim", () => {
  test("swapped reservation job denies the claim", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = commsJob(fixture);
    const other = commsJob(fixture);
    const reservation = store.reserve(job.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-resrel", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const resRow = store.reservations.get(reservation.value.id);
    if (!resRow) throw new Error("missing reservation");
    store.reservations.set(reservation.value.id, { ...resRow, jobId: other.id });
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("allowance-exhausted");
  });

  test("foreign-budget reservation denies without leakage", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = commsJob(fixture);
    const reservation = store.reserve(job.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-resorg", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const resRow = store.reservations.get(reservation.value.id);
    const budgetB = store.getBudgetForOrganization(fixture.orgPrivateB);
    if (!resRow || !budgetB) throw new Error("missing rows");
    store.reservations.set(reservation.value.id, { ...resRow, budgetId: budgetB.id });
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("denied-membership");
  });
});
