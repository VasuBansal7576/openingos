/**
 * F1 callable controlled fixtures (controlled contract).
 *
 * `buildControlledFixture` assembles two private organizations, two guest
 * organizations, open and restricted projects, role-graded memberships, an
 * owner-recipient configuration, shared budgets, version-bound grants, and
 * a bound conversation — all labeled controlled with synthetic `.test`
 * identities and addresses. No live credentials, provider calls, mail, or
 * external writes occur. Tests exercise isolation, forgery, staleness,
 * injection, deadlines, duplicates, concurrency, crash/replay, and refusal
 * against this fixture.
 */

import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../../shared/provenance.js";
import { ControlledBackend } from "../../shared/store.js";

export const CONTROLLED_OWNER_MAILBOX = "owner-supplier@example.test";

export function commsPayload(to: string): Record<string, unknown> {
  return {
    to,
    cc: [],
    bcc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject: "Controlled RFQ fixture",
    body: "Controlled fixture body for the owner playing supplier.",
  };
}

export interface ControlledFixture {
  readonly store: ControlledBackend;
  readonly now: number;
  readonly orgPrivateA: string;
  readonly orgPrivateB: string;
  readonly guestOrg1: string;
  readonly guestOrg2: string;
  readonly projAOpen: string;
  readonly projARestricted: string;
  readonly projBOpen: string;
  readonly guestProj1: string;
  readonly guestProj2: string;
  readonly ownerA: string;
  readonly approverA: string;
  readonly contribA: string;
  readonly ownerB: string;
  readonly guest1: string;
  readonly guest2: string;
  readonly attacker: string;
  readonly grantCommsA: string;
  readonly grantResearchA: string;
  readonly conversationA: string;
}

export function buildControlledFixture(now = 1_700_000_000_000): ControlledFixture {
  const store = new ControlledBackend();
  const ownerA = "id-owner-a";
  const approverA = "id-approver-a";
  const contribA = "id-contrib-a";
  const ownerB = "id-owner-b";
  const guest1 = "id-guest-1";
  const guest2 = "id-guest-2";
  const attacker = "id-attacker";

  const orgPrivateA = store.createOrganization("Private A", "private", now).id;
  const orgPrivateB = store.createOrganization("Private B", "private", now).id;
  const guestOrg1 = store.createOrganization("Guest 1", "guest", now).id;
  const guestOrg2 = store.createOrganization("Guest 2", "guest", now).id;

  const projAOpen = store.createProject(orgPrivateA, "A open", "open", now).id;
  const projARestricted = store.createProject(orgPrivateA, "A restricted", "restricted", now).id;
  const projBOpen = store.createProject(orgPrivateB, "B open", "open", now).id;
  const guestProj1 = store.createProject(guestOrg1, "Guest project 1", "open", now).id;
  const guestProj2 = store.createProject(guestOrg2, "Guest project 2", "open", now).id;

  store.addMembership(orgPrivateA, null, ownerA, "owner", now);
  store.addMembership(orgPrivateA, null, approverA, "approver", now);
  store.addMembership(orgPrivateA, projARestricted, approverA, "approver", now);
  store.addMembership(orgPrivateA, null, contribA, "contributor", now);
  store.addMembership(orgPrivateB, null, ownerB, "owner", now);
  store.addMembership(guestOrg1, null, guest1, "contributor", now);
  store.addMembership(guestOrg2, null, guest2, "contributor", now);

  store.configureRecipient(CONTROLLED_OWNER_MAILBOX, ownerA, now);
  for (const org of [orgPrivateA, orgPrivateB, guestOrg1, guestOrg2]) {
    store.ensureBudget(org, 1_000_000, "controlled-fixture:1-firecrawl-call=25000uUSD", now);
  }

  const grantComms = store.issueGrant(
    {
      issuerIdentity: ownerA,
      organizationId: orgPrivateA,
      projectId: projAOpen,
      operations: ["communication.send", "communication.clarify"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payload: commsPayload(CONTROLLED_OWNER_MAILBOX),
      costCeilingMicroUsd: 2_000_000,
      roundLimit: 3,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  if (!grantComms.ok) throw new Error(`fixture grant failed: ${grantComms.message}`);
  const grantResearch = store.issueGrant(
    {
      issuerIdentity: ownerA,
      organizationId: orgPrivateA,
      projectId: projAOpen,
      operations: ["research.collect", "evidence.record", "quote.record", "comparison.read"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payload: { research: "bounded-controlled-fixture" },
      costCeilingMicroUsd: 2_000_000,
      roundLimit: 3,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  if (!grantResearch.ok) throw new Error(`fixture research grant failed: ${grantResearch.message}`);

  const conversation = store.openConversation(orgPrivateA, projAOpen, grantComms.value.id, now);
  store.bindConversation(grantComms.value.id, conversation.id);

  return {
    store,
    now,
    orgPrivateA,
    orgPrivateB,
    guestOrg1,
    guestOrg2,
    projAOpen,
    projARestricted,
    projBOpen,
    guestProj1,
    guestProj2,
    ownerA,
    approverA,
    contribA,
    ownerB,
    guest1,
    guest2,
    attacker,
    grantCommsA: grantComms.value.id,
    grantResearchA: grantResearch.value.id,
    conversationA: conversation.id,
  };
}

/**
 * Test-only provisioning note: production seeding flows through
 * `access/memberships.createOrganization` + `createProject` (authenticated,
 * server time). This module intentionally exports no Convex functions so
 * no fixture path can become a production mutation.
 */
export const FIXTURE_MODULE_HAS_NO_CONVEX_FUNCTIONS = true as const;
