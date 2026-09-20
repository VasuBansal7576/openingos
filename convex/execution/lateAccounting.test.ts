/**
 * F1 late-delivery accounting, resend reservations, and cross-operation
 * event dedupe tests (controlled, C2 / F1-20).
 *
 * Unknown allowance moves exactly once from unresolved to spent on a
 * confirmed late delivery. Token and event binding hold even from
 * outcomeUnknown, provider events persist and dedupe globally, attempts
 * update, and reviewed resends require a fresh reservation while prior
 * unknown exposure remains.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

function reservedComms(fixture: ReturnType<typeof buildControlledFixture>, requestId: string, amount = 100_000) {
  const job = fixture.store.requestWork(
    { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
    fixture.now,
  );
  if (!job.ok) throw new Error("job failed");
  const reservation = fixture.store.reserve(job.value.id, amount, "controlled-fixture", fixture.now);
  if (!reservation.ok) throw new Error("reserve failed");
  const created = fixture.store.createOperation(
    { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId, payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
    fixture.now,
  );
  if (!created.ok) throw new Error("create failed");
  const claim = fixture.store.claimOperation(
    { identity: fixture.ownerA, operationId: created.value.operation.id },
    fixture.now,
  );
  if (!claim.ok) throw new Error("claim failed");
  return { job: job.value, op: created.value.operation.id, token: claim.value.attemptToken, reservationId: reservation.value.id };
}

describe("late delivery records receipt while unresolved stays reserved", () => {
  test("late delivery updates receipt/attempt; actual-cost reconciliation settles spend exactly once", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = reservedComms(fixture, "req-late-acct");
    const unknown = store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-late-acct-1" },
      now,
    );
    expect(unknown.ok && unknown.value.state).toBe("outcomeUnknown");
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);

    const late = store.recordLateDelivery(flow.op, flow.token, "evt-late-acct-2", now + 1);
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error("late delivery failed");
    expect(late.value.jobState).not.toBe("cancelled");
    expect(late.value.delivery).toBe("observedSuccess");
    // The receipt is recorded but the unresolved charge stays unresolved
    // until separate authoritative reconciliation.
    const held = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(held?.unresolvedMicroUsd).toBe(100_000);
    expect(held?.spentMicroUsd).toBe(0);
    expect(held?.reservedMicroUsd).toBe(0);

    const attempts = [...store.attempts.values()].filter((attempt) => attempt.operationId === flow.op);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("observedSuccess");
    expect(attempts[0]?.providerEventId).toBe("evt-late-acct-2");

    // A second late confirmation is denied (the operation already shows
    // the confirmed delivery).
    const repeat = store.recordLateDelivery(flow.op, flow.token, "evt-late-acct-3", now + 2);
    expect(repeat.ok).toBe(false);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);

    // Authoritative actual-cost reconciliation settles the held charge
    // exactly once: partial spend, remainder released.
    const settled = store.reconcileActualCost(flow.op, 60_000, now + 3);
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error("reconciliation failed");
    expect(settled.value.spentMicroUsd).toBe(60_000);
    expect(settled.value.releasedMicroUsd).toBe(40_000);
    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.unresolvedMicroUsd).toBe(0);
    expect(ledger?.spentMicroUsd).toBe(60_000);
    expect(ledger?.reservedMicroUsd).toBe(0);

    const twice = store.reconcileActualCost(flow.op, 60_000, now + 4);
    expect(twice.ok).toBe(false);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd).toBe(60_000);
  });

  test("wrong token is denied even from outcomeUnknown", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = reservedComms(fixture, "req-late-token");
    store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-late-tok-1" },
      now,
    );
    const forged = store.recordLateDelivery(flow.op, "att-token-forged", "evt-late-tok-2", now + 1);
    expect(forged.ok).toBe(false);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);
  });
});

describe("reviewed resends require fresh reservations under exposure", () => {
  test("resend without a fresh reservation is denied while unknown remains", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = reservedComms(fixture, "req-resend-exposure");
    store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-resend-1" },
      now,
    );
    const denied = store.reviewedResend(flow.op, "req-resend-fresh-missing", fixture.approverA, now + 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unknown-charges-reserved");
  });

  test("resend with a fresh reservation proceeds without touching the old one", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = reservedComms(fixture, "req-resend-fresh");
    store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-resend-2" },
      now,
    );
    const fresh = store.reserve(flow.job.id, 100_000, "controlled-fixture", now + 1);
    if (!fresh.ok) throw new Error("fresh reserve failed");
    const resent = store.reviewedResend(flow.op, "req-resend-fresh-ok", fixture.approverA, now + 1, fresh.value.id);
    expect(resent.ok).toBe(true);
    if (!resent.ok) throw new Error("resend failed");
    expect(resent.value.operation.reservationId).toBe(fresh.value.id);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);
  });
});

describe("F1-20 duplicate event IDs never settle a second effect", () => {
  test("same provider event across two operations changes nothing twice", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const first = reservedComms(fixture, "req-evt-a");
    const second = reservedComms(fixture, "req-evt-b");
    const done = store.recordOutcome(
      { operationId: first.op, token: first.token, outcome: "success", providerEventId: "evt-shared-1" },
      now,
    );
    expect(done.ok && done.value.state).toBe("observedSuccess");
    const before = store.snapshotCounts();
    const spentBefore = store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd;

    const duplicate = store.recordOutcome(
      { operationId: second.op, token: second.token, outcome: "success", providerEventId: "evt-shared-1" },
      now + 1,
    );
    expect(duplicate.ok).toBe(false);
    expect(store.operations.get(second.op)?.state).toBe("dispatching");
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd).toBe(spentBefore);
    expect(store.snapshotCounts().sends).toBe(before.sends);
  });
});
