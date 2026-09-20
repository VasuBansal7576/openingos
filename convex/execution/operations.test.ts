/**
 * F1 idempotency, pre-claim denial, and late-delivery tests
 * (controlled, S-05 / S-06 / S-07 / P-13 / P-14 / D-07 / D-14).
 *
 * Duplicate identical requestIds return one operation; changed payloads
 * conflict. Revocation, expiry, changed drafts, relevant replies, and
 * pre-claim cancellation produce typed denials with zero sends. After a
 * claim, cancellation and confirmed late delivery remain separate facts.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

function startCommsJob(fixture: ReturnType<typeof buildControlledFixture>) {
  const job = fixture.store.requestWork(
    {
      identity: fixture.ownerA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projAOpen,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: fixture.grantCommsA,
    },
    fixture.now,
  );
  if (!job.ok) throw new Error(`job failed: ${job.ok === false ? job.message : ""}`);
  return job.value;
}

describe("S-05 idempotent operations, one send", () => {
  test("duplicate identical requestId returns one operation and one send", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const payload = commsPayload(CONTROLLED_OWNER_MAILBOX);
    const reservation = store.reserve(job.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");

    const first = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-dup", payload, grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first create failed");
    expect(first.value.deduped).toBe(false);

    const second = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-dup", payload, grantId: fixture.grantCommsA },
      now,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second create failed");
    expect(second.value.deduped).toBe(true);
    expect(second.value.operation.id).toBe(first.value.operation.id);

    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: first.value.operation.id }, now);
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");

    const send = store.dispatchControlledSend(first.value.operation.id, claim.value.attemptToken, now);
    expect(send.ok).toBe(true);
    expect(store.sentMessages).toHaveLength(1);

    // Replay with the same token sends nothing more.
    const replay = store.dispatchControlledSend(first.value.operation.id, claim.value.attemptToken, now);
    expect(replay.ok).toBe(false);
    expect(store.sentMessages).toHaveLength(1);
  });

  test("changed payload under the same requestId conflicts with no new record", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const before = store.snapshotCounts();

    const first = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-key", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    expect(first.ok).toBe(true);

    const conflict = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-key", payload: commsPayload("other@example.test"), grantId: fixture.grantCommsA },
      now,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("duplicate-conflict");
    expect(store.snapshotCounts().operations).toBe(before.operations + 1);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("a second claim cannot mint another attempt token", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const reservation = store.reserve(job.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-once", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const first = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(first.ok).toBe(true);
    const second = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already-claimed");
    expect(store.attempts.size).toBe(1);
  });
});

describe("S-06 pre-claim denials leave zero new effect", () => {
  test("revoked grant blocks the claim with zero sends", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-revoked", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const before = store.snapshotCounts();
    store.revokeGrant(fixture.grantCommsA, now);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("revoked-grant");
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("expired grant blocks the claim, including the exact expiry boundary", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-expired", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const grant = store.grants.get(fixture.grantCommsA);
    if (!grant) throw new Error("missing grant");
    // Claim exactly at expiry: authority has ended (inclusive boundary).
    const claim = store.claimOperation(
      { identity: fixture.ownerA, operationId: created.value.operation.id },
      grant.expiresAt,
    );
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("grant-expired-at-claim");
    expect(store.sentMessages).toHaveLength(0);
  });

  test("changed draft blocks the claim (P-13)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-draft", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const before = store.snapshotCounts();
    const amended = store.amendGrantDraft(
      fixture.grantCommsA,
      fixture.ownerA,
      { ...commsPayload(CONTROLLED_OWNER_MAILBOX), subject: "Changed subject" },
      now,
    );
    expect(amended.ok).toBe(true);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("changed-draft");
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("relevant reply blocks the claim (P-13)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-reply", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const before = store.snapshotCounts();
    store.recordReply(fixture.conversationA, now + 1);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now + 2);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("relevant-reply-superseded");
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("cancelled job before claim blocks the send (P-13)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-cancel", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const before = store.snapshotCounts();
    const cancelled = store.cancelJob(job.id, fixture.ownerA, now, "user takeover");
    expect(cancelled.ok).toBe(true);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("cancelled-before-claim");
    expect(store.snapshotCounts().sends).toBe(before.sends);
    expect(store.operations.get(created.value.operation.id)?.state).toBe("cancelled");
  });
});

describe("S-07 cancellation and late delivery stay separate", () => {
  test("cancel after claim cannot erase a confirmed late send", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = startCommsJob(fixture);
    const reservation = store.reserve(job.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");
    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.id, kind: "communication.send", requestId: "req-late", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    if (!claim.ok) throw new Error("claim failed");

    const cancelled = store.cancelJob(job.id, fixture.ownerA, now + 1, "user takeover");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("cancel failed");
    expect(cancelled.value.unresolvedOperationIds).toContain(created.value.operation.id);

    const late = store.recordLateDelivery(created.value.operation.id, claim.value.attemptToken, "evt-late-1", now + 2);
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error("late delivery failed");
    expect(late.value.jobState).toBe("cancelled");
    expect(late.value.delivery).toBe("observedSuccess");
    expect(store.jobs.get(job.id)?.state).toBe("cancelled");
    expect(store.operations.get(created.value.operation.id)?.state).toBe("observedSuccess");
  });

  test("duplicate provider events deduplicate with no second effect (P-14)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const first = store.processEvent("controlled", "controlled", "evt-1", 1, "observedSuccess", now);
    expect(first.deduplicated).toBe(false);
    const before = store.snapshotCounts();
    const second = store.processEvent("controlled", "controlled", "evt-1", 1, "observedSuccess", now);
    expect(second.deduplicated).toBe(true);
    expect(second.outcome).toBe("observedSuccess");
    expect(store.snapshotCounts()).toEqual(before);
  });
});
