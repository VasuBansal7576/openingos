/**
 * F1 owner-only transport tests (controlled, S-22 / D-07 / D-14).
 *
 * Guest and private direct calls, model output, Reply-To/CC injection,
 * retries, and recovery cannot contact any address except the configured
 * owner mailbox, nor submit vendor forms or chat. Missing configuration
 * and changed recipient versions block new claims. A confident Jev
 * decision still passes through the same backend claim.
 */

import { describe, expect, test } from "bun:test";
import { ControlledBackend } from "../shared/store.js";
import { fenceJevResult } from "../shared/jevResults.js";
import type { JevAttemptResult } from "../shared/jevResults.js";
import { buildControlledFixture, commsPayload, CONTROLLED_OWNER_MAILBOX } from "../purchasing/contracts/fixtures.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";

function commsOp(
  fixture: ReturnType<typeof buildControlledFixture>,
  requestId: string,
  payload: unknown,
) {
  const job = fixture.store.requestWork(
    { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
    fixture.now,
  );
  if (!job.ok) throw new Error("job failed");
  return fixture.store.createOperation(
    { identity: fixture.ownerA, jobId: job.value.id, kind: "communication.send", requestId, payload, grantId: fixture.grantCommsA },
    fixture.now,
  );
}

describe("S-22 owner-only transport", () => {
  test("missing recipient configuration blocks comms grants at issuance", () => {
    const store = new ControlledBackend();
    const now = 1_700_000_000_000;
    const org = store.createOrganization("Solo", "private", now).id;
    const proj = store.createProject(org, "P", "open", now).id;
    store.addMembership(org, null, "owner", "owner", now);
    store.ensureBudget(org, 1_000_000, "controlled", now);
    const before = store.snapshotCounts();
    // No active recipient: a communication grant cannot even be issued,
    // so no downstream claim can exist.
    const grant = store.issueGrant(
      {
        issuerIdentity: "owner",
        organizationId: org,
        projectId: proj,
        operations: ["communication.send"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: {},
        payload: commsPayload("owner-supplier@example.test"),
        costCeilingMicroUsd: 10,
        roundLimit: 1,
        expiresAt: now + 1000,
      },
      now,
    );
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.code).toBe("invalid-payload");
    expect(store.snapshotCounts()).toEqual(before);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("changed recipient version blocks new claims until re-approval", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const created = commsOp(fixture, "req-rotate", commsPayload(CONTROLLED_OWNER_MAILBOX));
    if (!created.ok) throw new Error("create failed");
    const before = store.snapshotCounts();

    store.configureRecipient("owner-supplier-2@example.test", fixture.ownerA, now + 1);
    const claim = store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, now + 2);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("stale-recipient-version");
    expect(store.snapshotCounts()).toEqual(before);
    expect(store.sentMessages).toHaveLength(0);
  });

  test("CC injection is denied with no send", () => {
    const fixture = buildControlledFixture();
    const created = commsOp(fixture, "req-cc", { ...commsPayload(CONTROLLED_OWNER_MAILBOX), cc: ["sneaky@example.test"] });
    if (!created.ok) throw new Error("create failed");
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, fixture.now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("cc-not-empty");
    expect(fixture.store.sentMessages).toHaveLength(0);
  });

  test("BCC injection is denied with no send", () => {
    const fixture = buildControlledFixture();
    const created = commsOp(fixture, "req-bcc", { ...commsPayload(CONTROLLED_OWNER_MAILBOX), bcc: ["hidden@example.test"] });
    if (!created.ok) throw new Error("create failed");
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, fixture.now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("bcc-not-empty");
  });

  test("Reply-To redirection is denied with no send", () => {
    const fixture = buildControlledFixture();
    const created = commsOp(fixture, "req-replyto", { ...commsPayload(CONTROLLED_OWNER_MAILBOX), replyTo: "attacker@example.test" });
    if (!created.ok) throw new Error("create failed");
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, fixture.now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("reply-to-redirect");
  });

  test("wrong recipient is denied even with a valid grant (D-14)", () => {
    const fixture = buildControlledFixture();
    const created = commsOp(fixture, "req-vendor", commsPayload("real-vendor@example.test"));
    if (!created.ok) throw new Error("create failed");
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, fixture.now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("recipient-mismatch");
  });

  test("guest direct calls cannot reach any other address either", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const guestGrant = store.issueGrant(
      {
        issuerIdentity: fixture.guest1,
        organizationId: fixture.guestOrg1,
        projectId: fixture.guestProj1,
        operations: ["communication.send"],
        communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
        recipientConfigVersion: 1,
        inputVersions: {},
        payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
        costCeilingMicroUsd: 10,
        roundLimit: 1,
        expiresAt: now + 1000,
      },
      now,
    );
    // Guests hold contributor, not approver: grant issuance itself is denied.
    expect(guestGrant.ok).toBe(false);
  });

  test("vendor form/chat and other alternate channels never execute (S-22)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = store.requestWork(
      { identity: fixture.ownerA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Research suppliers for the espresso machine.", kind: "research", grantId: fixture.grantResearchA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const before = store.snapshotCounts();
    for (const kind of ["submitContactForm", "sendChatMessage", "submitRfq", "browserOutreach"]) {
      const created = store.createOperation(
        { identity: fixture.ownerA, jobId: job.value.id, kind, requestId: `req-${kind}`, payload: { op: kind }, grantId: fixture.grantResearchA },
        now,
      );
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(["alternate-channel-denied", "unknown-operation", "denied-capability"]).toContain(created.code);
      }
    }
    expect(store.snapshotCounts()).toEqual(before);
  });

  test("covered clarification proceeds without repeated approval (D-07)", () => {
    const fixture = buildControlledFixture();
    const { store, now } = fixture;
    const job = store.requestWork(
      { identity: fixture.approverA, organizationId: fixture.orgPrivateA, projectId: fixture.projAOpen, text: "Send the RFQ to the demo supplier.", kind: "communication", grantId: fixture.grantCommsA },
      now,
    );
    if (!job.ok) throw new Error("job failed");
    const reservation = store.reserve(job.value.id, 50_000, "controlled-fixture", now);
    if (!reservation.ok) throw new Error("reserve failed");
    // Same approved draft, clarification kind: covered by the brief.
    const created = store.createOperation(
      { identity: fixture.approverA, jobId: job.value.id, kind: "communication.clarify", requestId: "req-clarify", payload: commsPayload(CONTROLLED_OWNER_MAILBOX), grantId: fixture.grantCommsA, reservationId: reservation.value.id },
      now,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("clarify create failed");
    const claim = store.claimOperation({ identity: fixture.approverA, operationId: created.value.operation.id }, now);
    expect(claim.ok).toBe(true);
  });

  test("a confident Jev decision still passes the backend claim (D-14)", () => {
    const fixture = buildControlledFixture();
    const decided: JevAttemptResult = {
      outcome: "decided",
      model: "jev-1.13.0",
      answers: {
        move: { type: "choice", choice: "send", probabilities: { send: 0.99, hold: 0.01 }, confidence: 0.99 },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
      latencyMs: 5,
      inputVersion: "brief-v1",
    };
    const fenced = fenceJevResult({ result: decided, currentInputVersion: "brief-v1", authorityCurrent: true });
    expect(fenced.usable).toBe(true);
    // The backend claim still enforces the recipient binding: a confident
    // model cannot redirect the send.
    const created = commsOp(fixture, "req-confident", commsPayload("real-vendor@example.test"));
    if (!created.ok) throw new Error("create failed");
    const claim = fixture.store.claimOperation({ identity: fixture.ownerA, operationId: created.value.operation.id }, fixture.now);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("recipient-mismatch");
  });
});
