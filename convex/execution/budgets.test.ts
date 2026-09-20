/**
 * F1 shared-budget reservation tests (controlled, S-08 / D-16 / P-17).
 *
 * Two concurrent branches cannot each reserve the full shared allowance:
 * reservations draw atomically from the organization ledger. Unknown
 * charges remain reserved after failure; successes spend and clean
 * failures release.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

describe("S-08 shared allowance across branches and jobs", () => {
  test("two branches cannot each reserve the full shared allowance", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const budget = store.getBudgetForOrganization(fixture.orgPrivateA);
    if (!budget) throw new Error("missing budget");
    expect(budget.ceilingMicroUsd).toBe(1_000_000);

    const firstJob = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Research suppliers for branch one.", kind: "research", grantId: fixture.grantResearchA },
      now,
    );
    const secondJob = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Research suppliers for branch two.", kind: "research", grantId: fixture.grantResearchA },
      now,
    );
    if (!firstJob.ok || !secondJob.ok) throw new Error("jobs failed");

    const full = store.reserve(firstJob.value.id, 1_000_000, "controlled-fixture", now);
    expect(full.ok).toBe(true);

    const before = store.snapshotCounts();
    const clash = store.reserve(secondJob.value.id, 1_000_000, "controlled-fixture", now);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe("allowance-exhausted");
    expect(store.snapshotCounts()).toEqual(before);

    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.reservedMicroUsd).toBe(1_000_000);
  });

  test("concurrent jobs share one organization ledger (D-16)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const mkJob = (label: string) => {
      const job = store.requestWork(
        { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: `Research suppliers ${label}.`, kind: "research", grantId: fixture.grantResearchA },
        now,
      );
      if (!job.ok) throw new Error("job failed");
      return job.value.id;
    };
    const jobA = mkJob("alpha");
    const jobB = mkJob("beta");

    expect(store.reserve(jobA, 600_000, "controlled-fixture", now).ok).toBe(true);
    expect(store.reserve(jobB, 600_000, "controlled-fixture", now).ok).toBe(false);
    // A fitting remainder still works.
    expect(store.reserve(jobB, 400_000, "controlled-fixture", now).ok).toBe(true);
    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.reservedMicroUsd).toBe(1_000_000);
  });

  test("unknown charges remain reserved after failure (P-17)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const reservation = store.reserve(job.value.id, 100_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");

    const created = store.createOperation(
      { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId: "req-unknown-charge", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    if (!claim.ok) throw new Error("claim failed");

    const outcome = store.recordOutcome(
      { operationId: created.value.operation.id, token: claim.value.attemptToken, outcome: "failure", providerEventId: "evt-unknown-1", unknownCharges: true },
      now,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("outcome failed");
    expect(outcome.value.state).toBe("outcomeUnknown");

    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.reservedMicroUsd).toBe(0);
    expect(ledger?.unresolvedMicroUsd).toBe(100_000);
    expect(ledger?.spentMicroUsd).toBe(0);
  });

  test("success spends and clean failure releases", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const mkOp = (label: string, requestId: string) => {
      const job = store.requestWork(
        { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: `Send the RFQ ${label}.`, kind: "communication", grantId: fixture.grantCommsA },
        now,
      );
      if (!job.ok) throw new Error("job failed");
      const reservation = store.reserve(job.value.id, 50_000, "controlled-fixture", now);
      if (!reservation.ok) throw new Error("reserve failed");
      const created = store.createOperation(
        { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId, payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
        now,
      );
      if (!created.ok) throw new Error("create failed");
      const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
      if (!claim.ok) throw new Error("claim failed");
      return { op: created.value.operation.id, token: claim.value.attemptToken };
    };

    const ok = mkOp("success case", "req-spend");
    const recorded = store.recordOutcome({ operationId: ok.op, token: ok.token, outcome: "success", providerEventId: "evt-ok-1" }, now);
    expect(recorded.ok && recorded.value.state).toBe("observedSuccess");

    const failed = mkOp("failure case", "req-release");
    const released = store.recordOutcome({ operationId: failed.op, token: failed.token, outcome: "failure", providerEventId: "evt-fail-1" }, now);
    expect(released.ok && released.value.state).toBe("observedFailure");

    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.spentMicroUsd).toBe(50_000);
    expect(ledger?.unresolvedMicroUsd).toBe(0);
    expect(ledger?.reservedMicroUsd).toBe(0);
  });

  test("reservation stress: interleaved branches never exceed the ceiling", () => {
    for (let round = 0; round < 25; round += 1) {
      const fixture = buildControlledFixture();
      const { store, now } = fixture;
      const jobIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const job = store.requestWork(
          { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: `Research suppliers round ${round} branch ${index}.`, kind: "research", grantId: fixture.grantResearchA },
          now,
        );
        if (!job.ok) throw new Error("job failed");
        jobIds.push(job.value.id);
      }
      let accepted = 0;
      for (const jobId of jobIds) {
        const reserved = store.reserve(jobId, 400_000, "controlled-fixture", now);
        if (reserved.ok) accepted += 1;
      }
      expect(accepted).toBeLessThanOrEqual(2);
      const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
      expect((ledger?.reservedMicroUsd ?? 0)).toBeLessThanOrEqual(1_000_000);
    }
  });
});
