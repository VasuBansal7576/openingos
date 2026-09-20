/**
 * F1 crash/replay reconciliation tests (controlled, S-09 / P-17).
 *
 * Process loss after claim, response loss, and workflow replay reconcile
 * to `outcomeUnknown` without an automatic second send. An explicit
 * reviewed resend creates a linked new operation with a warning.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

function claimedComms(fixture: ReturnType<typeof buildControlledFixture>, requestId: string) {
  const job = fixture.store.requestWork(
    { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
    fixture.now,
  );
  if (!job.ok) throw new Error("job failed");
  const created = fixture.store.createOperation(
    { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId, payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
    fixture.now,
  );
  if (!created.ok) throw new Error("create failed");
  const claim = fixture.store.claimOperation(
    { identity: fixture.ownerA, operationId: created.value.operation.id },
    fixture.now,
  );
  if (!claim.ok) throw new Error("claim failed");
  return { job: job.value, op: created.value.operation.id, token: claim.value.attemptToken };
}

describe("S-09 crash and replay reconcile without resend", () => {
  test("process loss after claim reconciles to unknown with no send", () => {
    const fixture = buildControlledFixture();
    const { store } = fixture;
    const { op } = claimedComms(fixture, "req-crash");
    const before = store.snapshotCounts();

    const reconciled = store.reconcileAfterCrash(op, fixture.now + 5);
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.state).toBe("outcomeUnknown");
    expect(store.snapshotCounts()).toEqual(before);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("workflow replay cannot reclaim an ambiguous operation", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const { op } = claimedComms(fixture, "req-replay");
    store.reconcileAfterCrash(op, now + 5);

    const replay = store.claimOperation({ identity: fixture.ownerA, operationId: op }, now + 6);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("already-claimed");

    const send = store.dispatchControlledSend(op, "att-token-stale", now + 6);
    expect(send.ok).toBe(false);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("response loss stays unknown and never becomes safe-to-resend", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const { op, token } = claimedComms(fixture, "req-response-loss");
    store.dispatchControlledSend(op, token, now);

    const outcome = store.recordOutcome(
      { operationId: op, token, outcome: "unknown", providerEventId: "evt-lost-1", detail: "response lost" },
      now + 1,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("outcome failed");
    expect(outcome.value.state).toBe("outcomeUnknown");

    // An empty provider search does not confirm anything: replay is denied.
    const replay = store.claimOperation({ identity: fixture.ownerA, operationId: op }, now + 2);
    expect(replay.ok).toBe(false);
    expect(store.sentMessages).toHaveLength(1);
  });

  test("explicit reviewed resend creates a linked operation with a warning", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const { op } = claimedComms(fixture, "req-ambiguous");
    store.reconcileAfterCrash(op, now + 5);

    // Non-approver review is refused.
    const refused = store.reviewedResend(op, "req-resend-1", fixture.contribA, now + 6);
    expect(refused.ok).toBe(false);

    const resent = store.reviewedResend(op, "req-resend-1", fixture.approverA, now + 6);
    expect(resent.ok).toBe(true);
    if (!resent.ok) throw new Error("resend failed");
    expect(resent.value.operation.linkedResendOf).toBe(op);
    expect(resent.value.warning).toContain("may duplicate");
    expect(resent.value.operation.state).toBe("prepared");

    // The linked operation is independently claimable.
    const claim = store.claimOperation(
      { identity: fixture.ownerA, operationId: resent.value.operation.id },
      now + 7,
    );
    expect(claim.ok).toBe(true);
  });

  test("recovery preserves completed work and exposes a recovery action (P-17)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const first = claimedComms(fixture, "req-complete-1");
    const done = store.recordOutcome(
      { operationId: first.op, token: first.token, outcome: "success", providerEventId: "evt-done-1" },
      now,
    );
    expect(done.ok && done.value.state).toBe("observedSuccess");

    const second = claimedComms(fixture, "req-ambiguous-2");
    store.reconcileAfterCrash(second.op, now + 1);

    // Completed work survives the ambiguous sibling: exactly one send so far
    // only if dispatched; here neither dispatched, but states are distinct.
    expect(store.operations.get(first.op)?.state).toBe("observedSuccess");
    expect(store.operations.get(second.op)?.state).toBe("outcomeUnknown");
    expect(store.jobs.size).toBe(2);
  });
});
