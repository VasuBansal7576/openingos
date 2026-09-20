/**
 * Wave A regression tests for Astra review 2cd59ec (F1R-01, F1R-02, F1R-12).
 *
 * Controlled contract only: synthetic identities, budgets, and grants.
 * No provider calls, mail, or external writes occur.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";

function smallResearchGrant(fixture: ReturnType<typeof buildControlledFixture>, ceiling: number) {
  const grant = fixture.store.issueGrant(
    {
      issuerIdentity: fixture.ownerA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projAOpen,
      operations: ["research.collect"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "espresso-opening-v1" },
      payload: { query: "Research commercial espresso machine suppliers for equivalent quotes." },
      costCeilingMicroUsd: ceiling,
      roundLimit: 10,
      expiresAt: fixture.now + 3_600_000,
    },
    fixture.now,
  );
  if (!grant.ok) throw new Error(`grant failed: ${grant.message}`);
  return grant.value.id;
}

function researchJob(fixture: ReturnType<typeof buildControlledFixture>, grantId: string, label: string) {
  const job = fixture.store.requestWork(
    {
      identity: fixture.ownerA,
      organizationId: fixture.orgPrivateA,
      projectId: fixture.projAOpen,
      text: `Research commercial espresso machine suppliers for the opening ${label}.`,
      kind: "research",
      grantId,
    },
    fixture.now,
  );
  if (!job.ok) throw new Error(`job failed: ${job.message}`);
  return job.value.id;
}

function researchOp(
  fixture: ReturnType<typeof buildControlledFixture>,
  jobId: string,
  grantId: string,
  requestId: string,
  reservationId: string,
) {
  const created = fixture.store.createOperation(
    {
      identity: fixture.ownerA,
      jobId,
      kind: "research.collect",
      requestId,
      payload: { query: "Research commercial espresso machine suppliers for equivalent quotes." },
      grantId,
      reservationId,
    },
    fixture.now,
  );
  if (!created.ok) throw new Error(`create failed: ${created.message}`);
  return created.value.operation.id;
}

function commsFlow(fixture: ReturnType<typeof buildControlledFixture>, requestId: string, amount = 100_000) {
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
  if (!job.ok) throw new Error("job failed");
  const reservation = fixture.store.reserve(job.value.id, amount, "controlled-fixture", fixture.now);
  if (!reservation.ok) throw new Error("reserve failed");
  const created = fixture.store.createOperation(
    {
      identity: fixture.ownerA,
      jobId: job.value.id,
      kind: "communication.send",
      requestId,
      payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
      grantId: fixture.grantCommsA,
      reservationId: reservation.value.id,
    },
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

describe("F1R-01 grant-wide cost ceiling", () => {
  test("sequential shared-grant jobs cannot each spend the ceiling", () => {
    const fixture = buildControlledFixture();
    const grantId = smallResearchGrant(fixture, 100);
    const jobA = researchJob(fixture, grantId, "alpha");
    const jobB = researchJob(fixture, grantId, "beta");
    expect(fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now).ok).toBe(true);
    const second = fixture.store.reserve(jobB, 60, "controlled-fixture", fixture.now);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("grant-ceiling-exceeded");
  });

  test("interleaved (concurrent) shared-grant reserves stay within one ceiling", () => {
    const fixture = buildControlledFixture();
    const grantId = smallResearchGrant(fixture, 100);
    const jobA = researchJob(fixture, grantId, "one");
    const jobB = researchJob(fixture, grantId, "two");
    // Interleaved arrival order: A, B, A-remainder.
    expect(fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now).ok).toBe(true);
    expect(fixture.store.reserve(jobB, 60, "controlled-fixture", fixture.now).ok).toBe(false);
    expect(fixture.store.reserve(jobB, 40, "controlled-fixture", fixture.now).ok).toBe(true);
    expect(fixture.store.reserve(jobA, 1, "controlled-fixture", fixture.now).ok).toBe(false);
  });

  test("spent exposure counts against the grant ceiling", () => {
    const fixture = buildControlledFixture();
    const grantId = smallResearchGrant(fixture, 100);
    const jobA = researchJob(fixture, grantId, "spender");
    const jobB = researchJob(fixture, grantId, "latecomer");
    const first = fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now);
    if (!first.ok) throw new Error("reserve failed");
    const op = researchOp(fixture, jobA, grantId, "req-spent", first.value.id);
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: op }, fixture.now);
    if (!claim.ok) throw new Error("claim failed");
    const outcome = fixture.store.recordOutcome(
      { operationId: op, token: claim.value.attemptToken, outcome: "success", providerEventId: "evt-espresso-opening-spent" },
      fixture.now,
    );
    expect(outcome.ok).toBe(true);
    const second = fixture.store.reserve(jobB, 60, "controlled-fixture", fixture.now);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("grant-ceiling-exceeded");
  });

  test("unresolved exposure counts and blocks fresh resend reserves", () => {
    const fixture = buildControlledFixture();
    const grantId = smallResearchGrant(fixture, 100);
    const jobA = researchJob(fixture, grantId, "ambiguous");
    const jobB = researchJob(fixture, grantId, "resender");
    const first = fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now);
    if (!first.ok) throw new Error("reserve failed");
    const op = researchOp(fixture, jobA, grantId, "req-unknown", first.value.id);
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: op }, fixture.now);
    if (!claim.ok) throw new Error("claim failed");
    const outcome = fixture.store.recordOutcome(
      {
        operationId: op,
        token: claim.value.attemptToken,
        outcome: "unknown",
        providerEventId: "evt-espresso-opening-unresolved",
      },
      fixture.now,
    );
    expect(outcome.ok).toBe(true);
    // Unresolved 60 leaves only 40 of headroom under the 100 ceiling.
    expect(fixture.store.reserve(jobB, 60, "controlled-fixture", fixture.now).ok).toBe(false);
    expect(fixture.store.reserve(jobB, 40, "controlled-fixture", fixture.now).ok).toBe(true);
    // A fresh resend reserve for the same ambiguous job is also fenced by the ceiling.
    expect(fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now).ok).toBe(false);
  });

  test("a second operation is allowed when both grant and org limits permit", () => {
    const fixture = buildControlledFixture();
    const grantId = smallResearchGrant(fixture, 200);
    const jobA = researchJob(fixture, grantId, "fits-a");
    const jobB = researchJob(fixture, grantId, "fits-b");
    const first = fixture.store.reserve(jobA, 60, "controlled-fixture", fixture.now);
    const second = fixture.store.reserve(jobB, 60, "controlled-fixture", fixture.now);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("reserves should fit");
    const opA = researchOp(fixture, jobA, grantId, "req-fits-a", first.value.id);
    const opB = researchOp(fixture, jobB, grantId, "req-fits-b", second.value.id);
    expect(fixture.store.claimOperation({ identity: fixture.ownerA, operationId: opA }, fixture.now).ok).toBe(true);
    expect(fixture.store.claimOperation({ identity: fixture.ownerA, operationId: opB }, fixture.now).ok).toBe(true);
  });
});

describe("F1R-02 cancellation releases orphan reservations", () => {
  test("cancel after reserve with no operation releases the hold", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grantId = smallResearchGrant(fixture, 1_000_000);
    const jobId = researchJob(fixture, grantId, "orphan");
    const reserved = store.reserve(jobId, 60, "controlled-fixture", now);
    if (!reserved.ok) throw new Error("reserve failed");
    const cancelled = store.cancelJob(jobId, fixture.ownerA, now + 1, "cancel after reserve checkpoint");
    expect(cancelled.ok).toBe(true);
    const row = store.reservations.get(reserved.value.id);
    expect(row?.reservedMicroUsd).toBe(0);
    expect(row?.state).toBe("closed");
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.reservedMicroUsd).toBe(0);
  });

  test("cancel after a failed operation creation still releases the orphan", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grantId = smallResearchGrant(fixture, 1_000_000);
    const jobId = researchJob(fixture, grantId, "failed-create");
    const reserved = store.reserve(jobId, 60, "controlled-fixture", now);
    if (!reserved.ok) throw new Error("reserve failed");
    // A mismatched grant fails creation and leaves the reservation orphaned.
    const bad = store.createOperation(
      {
        identity: fixture.ownerA,
        jobId,
        kind: "research.collect",
        requestId: "req-bad-grant",
        payload: { query: "Research commercial espresso machine suppliers for equivalent quotes." },
        grantId: fixture.grantResearchA,
        reservationId: reserved.value.id,
      },
      now,
    );
    expect(bad.ok).toBe(false);
    const cancelled = store.cancelJob(jobId, fixture.ownerA, now + 1, "cancel after failed create");
    expect(cancelled.ok).toBe(true);
    expect(store.reservations.get(reserved.value.id)?.reservedMicroUsd).toBe(0);
  });

  test("cancel of ordinary prepared work releases its reservation", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grantId = smallResearchGrant(fixture, 1_000_000);
    const jobId = researchJob(fixture, grantId, "prepared");
    const reserved = store.reserve(jobId, 60, "controlled-fixture", now);
    if (!reserved.ok) throw new Error("reserve failed");
    researchOp(fixture, jobId, grantId, "req-prepared", reserved.value.id);
    const cancelled = store.cancelJob(jobId, fixture.ownerA, now + 1, "cancel prepared");
    expect(cancelled.ok).toBe(true);
    expect(store.reservations.get(reserved.value.id)?.reservedMicroUsd).toBe(0);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.reservedMicroUsd).toBe(0);
  });

  test("in-flight dispatching and outcomeUnknown holds survive cancellation", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const grantId = smallResearchGrant(fixture, 1_000_000);
    const dispatchingJob = researchJob(fixture, grantId, "dispatching");
    const unknownJob = researchJob(fixture, grantId, "unknown");
    const resDispatching = store.reserve(dispatchingJob, 60, "controlled-fixture", now);
    const resUnknown = store.reserve(unknownJob, 70, "controlled-fixture", now);
    if (!resDispatching.ok || !resUnknown.ok) throw new Error("reserve failed");
    const opDispatching = researchOp(fixture, dispatchingJob, grantId, "req-inflight", resDispatching.value.id);
    const opUnknown = researchOp(fixture, unknownJob, grantId, "req-unknown-hold", resUnknown.value.id);
    const claimA = store.claimOperation({ identity: fixture.ownerA, operationId: opDispatching }, now);
    const claimB = store.claimOperation({ identity: fixture.ownerA, operationId: opUnknown }, now);
    if (!claimA.ok || !claimB.ok) throw new Error("claim failed");
    store.recordOutcome(
      { operationId: opUnknown, token: claimB.value.attemptToken, outcome: "unknown", providerEventId: "evt-hold" },
      now,
    );
    const cancelledA = store.cancelJob(dispatchingJob, fixture.ownerA, now + 1, "cancel in-flight");
    const cancelledB = store.cancelJob(unknownJob, fixture.ownerA, now + 1, "cancel unknown");
    expect(cancelledA.ok && cancelledB.ok).toBe(true);
    if (!cancelledA.ok || !cancelledB.ok) throw new Error("cancel failed");
    expect(cancelledA.value.unresolvedOperationIds).toContain(opDispatching);
    expect(cancelledB.value.unresolvedOperationIds).toContain(opUnknown);
    // Dispatching hold stays reserved; unknown hold stays unresolved.
    expect(store.reservations.get(resDispatching.value.id)?.reservedMicroUsd).toBe(60);
    expect(store.reservations.get(resUnknown.value.id)?.unresolvedMicroUsd).toBe(70);
  });
});

describe("F1R-12 early receipt binds late delivery exactly once", () => {
  test("callback-before-response: early receipt applies on late delivery", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-early-bind");
    const receipt = store.processEvent(
      "synthetic-provider",
      "controlled",
      "early-event-1",
      1,
      "success",
      now,
      flow.job.organizationId,
      flow.job.projectId,
    );
    expect(receipt.deduplicated).toBe(false);
    store.reconcileAfterCrash(flow.op, now + 1);
    const delivery = store.recordLateDelivery(flow.op, flow.token, "early-event-1", now + 2, "synthetic-provider", "controlled");
    expect(delivery.ok).toBe(true);
    if (!delivery.ok) throw new Error("late delivery failed");
    expect(delivery.value.delivery).toBe("observedSuccess");
    expect(delivery.value.deduplicated).toBe(false);
    expect(store.operations.get(flow.op)?.state).toBe("observedSuccess");
  });

  test("late delivery without an early receipt still applies", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-late-only");
    store.reconcileAfterCrash(flow.op, now + 1);
    const delivery = store.recordLateDelivery(flow.op, flow.token, "late-only-1", now + 2);
    expect(delivery.ok).toBe(true);
    if (!delivery.ok) throw new Error("late delivery failed");
    expect(delivery.value.delivery).toBe("observedSuccess");
  });

  test("unknown receipt on the same event gains an applied late-success state", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-unknown-then-confirmed");
    const unknown = store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-unknown-confirmed" },
      now,
    );
    expect(unknown.ok).toBe(true);
    expect(store.operations.get(flow.op)?.state).toBe("outcomeUnknown");
    const delivery = store.recordLateDelivery(flow.op, flow.token, "evt-unknown-confirmed", now + 1);
    expect(delivery.ok).toBe(true);
    if (!delivery.ok) throw new Error("late delivery failed");
    expect(delivery.value.delivery).toBe("observedSuccess");
    expect(delivery.value.deduplicated).toBe(false);
    expect(store.operations.get(flow.op)?.state).toBe("observedSuccess");
    expect(store.processedEvents.get("controlled|controlled|evt-unknown-confirmed")?.outcome).toBe("unknown");
    expect(store.processedEvents.get("controlled|controlled|evt-unknown-confirmed")?.applicationOutcome).toBe("success");
  });

  test("duplicate delivery after application dedupes with no second effect", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-duplicate");
    const first = store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "success", providerEventId: "evt-dup-1" },
      now,
    );
    expect(first.ok).toBe(true);
    const spent = store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd;
    const repeat = store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "success", providerEventId: "evt-dup-1" },
      now + 1,
    );
    // Already terminal: token no longer valid, and spend must not move twice.
    expect(repeat.ok).toBe(false);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd).toBe(spent);
  });

  test("an event applied to one operation stays fenced from another", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const first = commsFlow(fixture, "req-fence-a");
    const second = commsFlow(fixture, "req-fence-b");
    const done = store.recordOutcome(
      { operationId: first.op, token: first.token, outcome: "success", providerEventId: "evt-shared-fence" },
      now,
    );
    expect(done.ok).toBe(true);
    const spentBefore = store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd;
    const duplicate = store.recordOutcome(
      { operationId: second.op, token: second.token, outcome: "success", providerEventId: "evt-shared-fence" },
      now + 1,
    );
    expect(duplicate.ok).toBe(false);
    expect(store.operations.get(second.op)?.state).toBe("dispatching");
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd).toBe(spentBefore);
    const lateFence = store.recordLateDelivery(second.op, second.token, "evt-shared-fence", now + 2);
    expect(lateFence.ok).toBe(false);
    expect(store.operations.get(second.op)?.state).toBe("dispatching");
  });

  test("cancellation followed by confirmed late success keeps both facts", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-cancel-then-confirm");
    const cancelled = store.cancelJob(flow.job.id, fixture.ownerA, now + 1, "cancel before confirmation");
    expect(cancelled.ok).toBe(true);
    const delivery = store.recordLateDelivery(flow.op, flow.token, "evt-cancel-confirm", now + 2);
    expect(delivery.ok).toBe(true);
    if (!delivery.ok) throw new Error("late delivery failed");
    expect(delivery.value.delivery).toBe("observedSuccess");
    expect(delivery.value.jobState).toBe("cancelled");
    expect(store.operations.get(flow.op)?.state).toBe("observedSuccess");
  });

  test("unresolved charges stay held until authoritative reconciliation", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const flow = commsFlow(fixture, "req-retain-unresolved");
    store.recordOutcome(
      { operationId: flow.op, token: flow.token, outcome: "unknown", providerEventId: "evt-retain-1" },
      now,
    );
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);
    const late = store.recordLateDelivery(flow.op, flow.token, "evt-retain-2", now + 1);
    expect(late.ok).toBe(true);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(100_000);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.spentMicroUsd).toBe(0);
    const settled = store.reconcileActualCost(flow.op, 60_000, now + 2);
    expect(settled.ok).toBe(true);
    expect(store.getBudgetForOrganization(fixture.orgPrivateA)?.unresolvedMicroUsd).toBe(0);
  });
});
