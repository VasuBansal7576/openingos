/**
 * F1 NR03 gate test (controlled): durable shared-schema authority.
 *
 * One integrated flow proves the frozen contract set together: tenant and
 * guest isolation, restricted projects, forged IDs, stale grants, a rotated
 * owner-recipient configuration, exact-payload idempotency, the shared
 * organization budget ledger, crash reconciliation, and scope refusal —
 * each with typed denials and zero stray effects.
 */

import { describe, expect, test } from "bun:test";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";

describe("NR03 durable shared-schema authority gate", () => {
  test("integrated authority flow holds every invariant", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;

    // 1. Isolation: guest2 and the attacker see nothing of guest project 1.
    expect(store.checkProjectAccess(fixture.guest2, fixture.guestOrg1, fixture.guestProj1, "viewer", now).ok).toBe(false);
    expect(store.checkProjectAccess(fixture.attacker, fixture.orgPrivateA, fixture.projAOpen, "viewer", now).ok).toBe(false);
    // 2. Restricted project admits only explicit members.
    expect(store.checkProjectAccess(fixture.contribA, fixture.orgPrivateA, fixture.projARestricted, "viewer", now).ok).toBe(false);
    expect(store.checkProjectAccess(fixture.approverA, fixture.orgPrivateA, fixture.projARestricted, "viewer", now).ok).toBe(true);

    // 3. Legitimate comms flow: job -> operation -> reservation -> claim -> send.
    const job = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const reservation = store.reserve(job.value.id, 200_000, "controlled-fixture", now);
    expect(reservation.ok).toBe(true);
    const created = store.createOperation(
      {
        identity: fixture.ownerA,
        jobId: job.value.id,
        kind: "communication.send",
        requestId: "req-nr03",
        payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
        grantId: fixture.grantCommsA,
        ...(reservation.ok ? { reservationId: reservation.value.id } : {}),
      },
      now,
    );
    if (!created.ok) throw new Error("create failed");
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("claim failed");
    const send = store.dispatchControlledSend(created.value.operation.id, claim.value.attemptToken, now);
    expect(send.ok).toBe(true);

    // 4. Exact-payload idempotency returns the same operation.
    const duplicate = store.createOperation(
      { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId: "req-nr03", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    expect(duplicate.ok && duplicate.value.deduped).toBe(true);

    // 5. Rotating the recipient invalidates the next prepared operation.
    const prepared = store.createOperation(
      { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId: "req-nr03-next", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA },
      now,
    );
    if (!prepared.ok) throw new Error("second create failed");
    store.configureRecipient("owner-supplier-2@example.test", fixture.ownerA, now + 1);
    const stale = store.claimOperation({ identity: fixture.ownerA, operationId: prepared.value.operation.id }, now + 2);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale-recipient-version");

    // 6. Shared ledger: the 200k reservation plus a 900k branch cannot both fit.
    const branch = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Research suppliers for a parallel branch.", kind: "research", grantId: fixture.grantResearchA },
      now,
    );
    if (!branch.ok) throw new Error("branch job failed");
    expect(store.reserve(branch.value.id, 900_000, "controlled-fixture", now).ok).toBe(false);

    // 7. Crash reconciliation keeps the confirmed send intact.
    const reconciled = store.reconcileAfterCrash(prepared.value.operation.id, now + 3);
    expect(reconciled.reconciled).toBe(false);
    expect(store.operations.get(created.value.operation.id)?.state).toBe("dispatching");

    // 8. Unrelated refusal leaves the legitimate flow untouched.
    const refused = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Write my novel about a lighthouse." },
      now,
    );
    expect(refused.ok).toBe(false);
    expect(store.sentMessages).toHaveLength(1);

    // 9. Outcome accounting: the 200k reservation spends exactly once.
    const outcome = store.recordOutcome(
      { operationId: created.value.operation.id, token: claim.value.attemptToken, outcome: "success", providerEventId: "evt-nr03-1" },
      now + 4,
    );
    expect(outcome.ok && outcome.value.state).toBe("observedSuccess");
    const ledger = store.getBudgetForOrganization(fixture.orgPrivateA);
    expect(ledger?.spentMicroUsd).toBe(200_000);
    expect(ledger?.reservedMicroUsd).toBe(0);
  });
});
