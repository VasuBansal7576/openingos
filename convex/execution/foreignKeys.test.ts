/**
 * F1 foreign-key idempotency and forged-time probes (controlled, repair).
 *
 * Authorization precedes the idempotency lookup in both the controlled
 * store and the callable `createOperation`: a foreign request key can
 * neither reveal existence (identical payload must not dedupe) nor
 * conflict (changed payload must not reach the conflict check). Authority
 * follows the backend clock; production handlers always pass the server
 * clock (see `handlerGuards`), so callers cannot forge past/future time.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";

function restrictedCommsSetup(fixture: ReturnType<typeof buildControlledFixture>) {
  const { store, now } = fixture;
  const grant = store.issueGrant(
    {
      issuerIdentity: fixture.approverA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projARestricted,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
      costCeilingMicroUsd: 10_000,
      roundLimit: 2,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  if (!grant.ok) throw new Error("restricted grant failed");
  const conversation = store.openConversation(
    fixture.orgPrivateA,
    fixture.projARestricted,
    grant.value.id,
    now,
  );
  store.bindConversation(grant.value.id, conversation.id);
  const job = store.requestWork(
    {
      identity: fixture.approverA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projARestricted,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: grant.value.id,
    },
    now,
  );
  if (!job.ok) throw new Error("restricted job failed");
  return { grantId: grant.value.id, jobId: job.value.id };
}

describe("foreign request keys cannot probe idempotency", () => {
  test("identical payload from an unauthorized project does not dedupe", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const { grantId, jobId } = restrictedCommsSetup(fixture);
    const payload = commsPayload(CONTROLLED_OWNER_MAILBOX);

    const original = store.createOperation(
      { identity: fixture.approverA, jobId, kind: "communication.send", requestId: "req-collide", payload, grantId },
      now,
    );
    expect(original.ok).toBe(true);

    // contribA has no restricted-project access: identical key+payload must
    // deny on authorization, never return the other project's operation.
    const before = store.snapshotCounts();
    const forged = store.createOperation(
      { identity: fixture.contribA, jobId, kind: "communication.send", requestId: "req-collide", payload, grantId },
      now,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("changed payload from an unauthorized project does not conflict", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const { grantId, jobId } = restrictedCommsSetup(fixture);

    const original = store.createOperation(
      { identity: fixture.approverA, jobId, kind: "communication.send", requestId: "req-collide-2", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId },
      now,
    );
    expect(original.ok).toBe(true);

    const forged = store.createOperation(
      { identity: fixture.contribA, jobId, kind: "communication.send", requestId: "req-collide-2", payload: commsPayload("other@example.test"), grantId },
      now,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");
  });

  test("foreign organization identity cannot touch a victim job key", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId: "req-victim", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    expect(created.ok).toBe(true);

    // ownerB (another organization) reuses the exact key and payload.
    const forged = store.createOperation(
      { identity: fixture.ownerB, jobId: job.value.id, kind: "communication.send", requestId: "req-victim", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");
  });

  test("unknown job IDs deny without an existence oracle", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const forged = store.createOperation(
      { identity: fixture.ownerA, jobId: "job-does-not-exist", kind: "communication.send", requestId: "req-x", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");
  });

  test("same key in a second authorized job conflicts instead of deduping", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const mkJob = () => {
      const job = store.requestWork(
        { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
        now,
      );
      if (!job.ok) throw new Error("job failed");
      return job.value.id;
    };
    const firstJob = mkJob();
    const secondJob = mkJob();
    const payload = commsPayload(CONTROLLED_OWNER_MAILBOX);
    const first = store.createOperation(
      { identity: fixture.ownerA, jobId: firstJob, kind: "communication.send", requestId: "req-shared", payload, grantId: fixture.grantCommsA },
      now,
    );
    expect(first.ok).toBe(true);
    const clash = store.createOperation(
      { identity: fixture.ownerA, jobId: secondJob, kind: "communication.send", requestId: "req-shared", payload, grantId: fixture.grantCommsA },
      now,
    );
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe("duplicate-conflict");
  });
});

describe("forged past/future time probes", () => {
  test("grants cannot be issued with past expiry (callers cannot backdate authority)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grant = store.issueGrant(
      {
        issuerIdentity: fixture.ownerA,
        organizationId: fixture.orgPrivateA,
        projectId: fixture.projAOpen,
        operations: ["research.collect"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: {},
        payload: { research: "x" },
        costCeilingMicroUsd: 1,
        roundLimit: 1,
        expiresAt: now - 1_000,
      },
      now,
    );
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.code).toBe("invalid-payload");
  });

  test("claims evaluated under a forged future clock expire honestly", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId: "req-clock", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    // Production handlers always pass the server clock; here the fixture
    // clock stands in for it. A future reading past grant expiry denies.
    const grant = store.grants.get(fixture.grantCommsA);
    if (!grant) throw new Error("missing grant");
    const claim = store.claimOperation(
      { identity: fixture.ownerA, operationId: created.value.operation.id },
      grant.expiresAt + 60_000,
    );
    expect(claim.ok).toBe(false);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("membership expiry follows the backend clock at exact boundaries", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    store.addMembership(fixture.orgPrivateA, null, "id-clock-1", "contributor", now, now + 1_000);
    expect(
      store.checkProjectAccess("id-clock-1", fixture.orgPrivateA, fixture.projAOpen, "viewer", now).ok,
    ).toBe(true);
    expect(
      store.checkProjectAccess("id-clock-1", fixture.orgPrivateA, fixture.projAOpen, "viewer", now + 999).ok,
    ).toBe(true);
    const at = store.checkProjectAccess("id-clock-1", fixture.orgPrivateA, fixture.projAOpen, "viewer", now + 1_000);
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.code).toBe("expired-membership");
  });
});
