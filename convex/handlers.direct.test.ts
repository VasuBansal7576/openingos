/// <reference types="vite/client" />
/**
 * F1 direct Convex handler tests (controlled, repair gate).
 *
 * These tests run the ACTUAL exported Convex handlers against the REAL
 * schema with authenticated identities via official convex-test — no
 * mocks, no source-text assertions. Static guards and ControlledBackend
 * parity tests remain, but the proofs below come from handler execution:
 * public ID validator failures, cross-org and restricted-project denials
 * before dedupe, forged `now` input rejection, internal-only visibility of
 * claim/outcome/event/late-delivery transitions, fixture-seed absence,
 * and no public fake-send endpoint.
 *
 * Function references use explicit makeFunctionReference generics
 * instantiated from conditional Args/Return extraction: no cast helper,
 * no assertions.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type FunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import schema from "./schema.js";
import * as memberships from "./access/memberships.js";
import * as grants from "./access/grants.js";
import * as recipients from "./access/recipients.js";
import * as jobs from "./execution/jobs.js";
import * as operations from "./execution/operations.js";
import * as attempts from "./execution/attempts.js";
import * as reconciliation from "./execution/reconciliation.js";
import * as quotes from "./purchasing/contracts/quotes.js";
import * as evidence from "./purchasing/contracts/evidence.js";
import * as fixtures from "./purchasing/contracts/fixtures.js";
import { commsPayload } from "./purchasing/contracts/fixtures.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "./shared/provenance.js";
import { normalizeMailbox, payloadHash } from "./shared/hashing.js";

const modules = import.meta.glob([
  "./access/**/*.ts",
  "./execution/**/*.ts",
  "./purchasing/**/*.ts",
  "./shared/**/*.ts",
  "./server.ts",
  "./_generated/*.js",
  "!./access/**/*.test.ts",
  "!./execution/**/*.test.ts",
  "!./purchasing/**/*.test.ts",
  "!./shared/**/*.test.ts",
]);

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;

const createOrganizationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createOrganization>,
  MutationReturn<typeof memberships.createOrganization>
>("access/memberships:createOrganization");
const createProjectRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createProject>,
  MutationReturn<typeof memberships.createProject>
>("access/memberships:createProject");
const grantProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.grantProjectAccess>,
  MutationReturn<typeof memberships.grantProjectAccess>
>("access/memberships:grantProjectAccess");
const myProjectRoleRef = makeFunctionReference<
  "query",
  QueryArgs<typeof memberships.myProjectRole>,
  QueryReturn<typeof memberships.myProjectRole>
>("access/memberships:myProjectRole");
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");
const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.start>,
  MutationReturn<typeof jobs.start>
>("execution/jobs:start");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const getOperationRef = makeFunctionReference<
  "query",
  QueryArgs<typeof operations.get>,
  QueryReturn<typeof operations.get>
>("execution/operations:get");
const revokeProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.revokeProjectAccess>,
  MutationReturn<typeof memberships.revokeProjectAccess>
>("access/memberships:revokeProjectAccess");
const recordEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof evidence.record>,
  MutationReturn<typeof evidence.record>
>("purchasing/contracts/evidence:record");
const listEvidenceRef = makeFunctionReference<
  "query",
  QueryArgs<typeof evidence.list>,
  QueryReturn<typeof evidence.list>
>("purchasing/contracts/evidence:list");
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");

const OWNER_A = { tokenIdentifier: "direct-owner-a" };
const APPROVER_A = { tokenIdentifier: "direct-approver-a" };
const CONTRIB_A = { tokenIdentifier: "direct-contrib-a" };
const OWNER_B = { tokenIdentifier: "direct-owner-b" };
const ATTACKER = { tokenIdentifier: "direct-attacker" };
const OWNER_MAILBOX = "owner-supplier@example.test";

async function setupCommsProject(
  t: ReturnType<typeof convexTest>,
  owner: { tokenIdentifier: string },
  visibility: "open" | "restricted" = "open",
  seed: { identity: string; role: "owner" | "approver" | "contributor" | "viewer"; projectScoped: boolean }[] = [],
  issuer: { tokenIdentifier: string } = owner,
) {
  const asOwner = t.withIdentity(owner);
  const org = await asOwner.mutation(createOrganizationRef, { name: "Direct org", kind: "private" });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asOwner.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: "Direct project",
    visibility,
  });
  if (!proj.ok) throw new Error("project setup failed");
  if (seed.length > 0) {
    // Test scaffolding only: direct membership rows for identities that the
    // public grant path cannot yet reach (e.g. a restricted project whose
    // owner holds no implicit project access).
    await t.run(async (ctx) => {
      for (const member of seed) {
        await ctx.db.insert("memberships", {
          organizationId: org.organizationId,
          ...(member.projectScoped ? { projectId: proj.projectId } : {}),
          identity: member.identity,
          role: member.role,
          status: "active",
          version: 1,
          updatedAt: Date.now(),
        });
      }
    });
  }
  // Server-controlled recipient seeding (the test harness acts as the
  // deployment boundary): recipient configuration is never a public call.
  await t.run(async (ctx) => {
    await ctx.db.insert("recipientConfigs", {
      version: 1,
      mailboxNormalized: normalizeMailbox(OWNER_MAILBOX),
      mailboxHash: payloadHash(normalizeMailbox(OWNER_MAILBOX)),
      active: true,
      configuredAt: Date.now(),
      configuredBy: "deployment",
    });
  });
  const recipient = { version: 1 };
  const grant = await t.withIdentity(issuer).mutation(issueGrantRef, {
    organizationId: org.organizationId,
    projectId: proj.projectId,
    operations: ["communication.send"],
    communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    recipientConfigVersion: recipient.version,
    inputVersions: { brief: "v1" },
    payloadJson: JSON.stringify(commsPayload(OWNER_MAILBOX)),
    costCeilingMicroUsd: 100_000,
    roundLimit: 2,
    expiresAt: Date.now() + 3_600_000,
  });
  if (!grant.ok) throw new Error("grant setup failed");
  return { orgId: org.organizationId, projectId: proj.projectId, grantId: grant.grantId };
}

describe("direct public ID validator failures", () => {
  test("malformed IDs are rejected by v.id before any handler logic", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    // Loosely typed ref: precise handler types already reject this at
    // compile time; here the malformed value must reach the registered
    // runtime validator.
    const getOp: FunctionReference<"query", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("execution/operations:get");
    await expect(asOwner.query(getOp, { operationId: "not-an-id" })).rejects.toThrow();
  });

  test("wrong-table IDs are rejected by v.id", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "ID org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const getOp: FunctionReference<"query", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("execution/operations:get");
    await expect(
      asOwner.query(getOp, { operationId: org.organizationId }),
    ).rejects.toThrow();
  });
});

describe("direct cross-org and restricted denials before dedupe", () => {
  test("foreign organization cannot dedupe or conflict on a victim key", async () => {
    const t = convexTest(schema, modules);
    const victim = await setupCommsProject(t, OWNER_A);
    const asVictim = t.withIdentity(OWNER_A);
    const job = await asVictim.mutation(startJobRef, {
      organizationId: victim.orgId,
      projectId: victim.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: victim.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const payloadJson = JSON.stringify(commsPayload(OWNER_MAILBOX));
    const created = await asVictim.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: victim.orgId,
      projectId: victim.projectId,
      kind: "communication.send",
      requestId: "req-direct-victim",
      payloadJson,
      grantId: victim.grantId,
    });
    expect(created.ok).toBe(true);

    const asForeign = t.withIdentity(OWNER_B);
    const forged = await asForeign.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: victim.orgId,
      projectId: victim.projectId,
      kind: "communication.send",
      requestId: "req-direct-victim",
      payloadJson,
      grantId: victim.grantId,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");

    const changed = await asForeign.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: victim.orgId,
      projectId: victim.projectId,
      kind: "communication.send",
      requestId: "req-direct-victim",
      payloadJson: JSON.stringify(commsPayload("other@example.test")),
      grantId: victim.grantId,
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.code).toBe("denied-membership");
  });

  test("restricted project denies before dedupe for members without access", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(
      t,
      OWNER_A,
      "restricted",
      [
        { identity: APPROVER_A.tokenIdentifier, role: "approver", projectScoped: true },
        { identity: CONTRIB_A.tokenIdentifier, role: "contributor", projectScoped: false },
      ],
      APPROVER_A,
    );
    const asApprover = t.withIdentity(APPROVER_A);
    // The public grant path works for an authorized approver: a new viewer
    // can be admitted and can then read their own role.
    const GRANTEE = { tokenIdentifier: "direct-grantee" };
    const granted = await asApprover.mutation(grantProjectAccessRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      targetIdentity: GRANTEE.tokenIdentifier,
      role: "viewer",
    });
    expect(granted.ok).toBe(true);
    const granteeRole = await t.withIdentity(GRANTEE).query(myProjectRoleRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
    });
    expect(granteeRole.ok).toBe(true);
    // Contributor holds org-level membership but no restricted-project grant.
    const asContrib = t.withIdentity(CONTRIB_A);
    const role = await asContrib.query(myProjectRoleRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
    });
    expect(role.ok).toBe(false);

    const job = await asApprover.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("restricted job failed");
    const payloadJson = JSON.stringify(commsPayload(OWNER_MAILBOX));
    const created = await asApprover.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-direct-restricted",
      payloadJson,
      grantId: setup.grantId,
    });
    expect(created.ok).toBe(true);

    const forged = await asContrib.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-direct-restricted",
      payloadJson,
      grantId: setup.grantId,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("denied-membership");
  });

  test("unauthenticated and unknown-ID reads deny without oracles", async () => {
    const t = convexTest(schema, modules);
    const victim = await setupCommsProject(t, OWNER_A);
    const asVictim = t.withIdentity(OWNER_A);
    const job = await asVictim.mutation(startJobRef, {
      organizationId: victim.orgId,
      projectId: victim.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: victim.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const created = await asVictim.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: victim.orgId,
      projectId: victim.projectId,
      kind: "communication.send",
      requestId: "req-direct-oracle",
      payloadJson: JSON.stringify(commsPayload(OWNER_MAILBOX)),
      grantId: victim.grantId,
    });
    if (!created.ok) throw new Error("operation setup failed");

    const anonymous = await t.query(getOperationRef, { operationId: created.operationId });
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.code).toBe("forged-identity");

    const attacker = t.withIdentity(ATTACKER);
    const probed = await attacker.query(getOperationRef, { operationId: created.operationId });
    expect(probed.ok).toBe(false);
    if (!probed.ok) expect(probed.code).toBe("denied-membership");
  });
});

describe("direct forged now handling", () => {
  test("extra now input is rejected by the registered validator", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    // Loosely typed ref so the forged field passes compile-time checks and
    // exercises the registered validator directly.
    const looseCreate: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("access/memberships:createOrganization");
    await expect(
      asOwner.mutation(looseCreate, { name: "Clock org", kind: "private", now: 1 }),
    ).rejects.toThrow(/Unexpected field/);
  });

  test("past expiry is rejected under the server clock", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    // The registered validator accepts no `now` field (proven by the
    // companion rejection test), so expiry can only follow the server
    // clock: a past expiry is rejected even though the caller wants it live.
    const expired = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["research.collect"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: {},
      payloadJson: JSON.stringify({ research: "x" }),
      costCeilingMicroUsd: 1,
      roundLimit: 1,
      expiresAt: Date.now() - 60_000,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("invalid-payload");
  });
});

describe("direct handler visibility and absent endpoints", () => {
  function flags(handler: { isQuery?: boolean; isMutation?: boolean; isAction?: boolean; isPublic?: boolean; isInternal?: boolean }) {
    return {
      isQuery: handler.isQuery === true,
      isMutation: handler.isMutation === true,
      isAction: handler.isAction === true,
      isPublic: handler.isPublic === true,
      isInternal: handler.isInternal === true,
    };
  }

  test("claim, outcome, event, and late-delivery transitions are internal-only", () => {
    expect(flags(operations.claim)).toEqual({
      isQuery: false,
      isMutation: true,
      isAction: false,
      isPublic: false,
      isInternal: true,
    });
    expect(flags(attempts.recordOutcome)).toEqual({
      isQuery: false,
      isMutation: true,
      isAction: false,
      isPublic: false,
      isInternal: true,
    });
    expect(flags(attempts.reconcileAfterCrash).isInternal).toBe(true);
    expect(flags(attempts.reviewedResend).isInternal).toBe(true);
    expect(flags(reconciliation.ingestEvent).isInternal).toBe(true);
    expect(flags(reconciliation.recordLateDelivery).isInternal).toBe(true);
  });

  test("product calls stay public while provider ingestion stays internal", () => {
    expect(flags(operations.create).isPublic).toBe(true);
    expect(flags(jobs.start).isPublic).toBe(true);
    expect(flags(jobs.cancel).isPublic).toBe(true);
    expect(flags(grants.issue).isPublic).toBe(true);
    expect(flags(quotes.record).isPublic).toBe(true);
    expect(flags(quotes.ingestProviderQuote).isInternal).toBe(true);
    expect(flags(evidence.record).isPublic).toBe(true);
    expect(flags(evidence.ingestProviderEvidence).isInternal).toBe(true);
  });

  test("fixture seed is absent and no fake-send endpoint resolves", () => {
    expect("seed" in fixtures).toBe(false);
    for (const value of Object.values(fixtures)) {
      if (typeof value === "function") {
        expect(Reflect.get(value, "isMutation") === true).toBe(false);
        expect(Reflect.get(value, "isQuery") === true).toBe(false);
        expect(Reflect.get(value, "isAction") === true).toBe(false);
      }
    }
  });
});

describe("direct checkpoint-1 authority boundaries", () => {
  test("recipient configuration is internal-only (no public rotation)", () => {
    expect(recipients.configure.isInternal === true).toBe(true);
    expect("isPublic" in recipients.configure).toBe(false);
    expect(recipients.describe.isPublic === true).toBe(true);
  });

  test("public evidence imports cannot self-assert provenance or provider IDs", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Prov org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Prov project",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const looseRecord: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("purchasing/contracts/evidence:record");
    await expect(
      asOwner.mutation(looseRecord, {
        organizationId: org.organizationId,
        projectId: proj.projectId,
        sourceKind: "supplier-page",
        contentHash: "hash-live",
        completeness: "complete",
        counterpartyRole: "vendor",
        executionMode: "live",
        providerIds: "inbox-1/message-1",
      }),
    ).rejects.toThrow(/Unexpected field/);
  });

  test("recorded evidence carries server-derived user provenance", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Prov org 2", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Prov project 2",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const recorded = await asOwner.mutation(recordEvidenceRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      sourceKind: "user-document",
      contentHash: "hash-user-doc",
      completeness: "complete",
    });
    expect(recorded.ok).toBe(true);
    const listed = await asOwner.query(listEvidenceRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      limit: 10,
    });
    if (!listed.ok) throw new Error("list failed");
    expect(listed.evidence).toHaveLength(1);
    expect(listed.evidence[0]?.counterpartyRole).toBe("userImport");
    expect(listed.evidence[0]?.executionMode).toBe("recorded");
  });

  test("public quote imports cannot self-assert live or vendor provenance", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Quote prov org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Quote prov project",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const looseQuote: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("purchasing/contracts/quotes:record");
    await expect(
      asOwner.mutation(looseQuote, {
        organizationId: org.organizationId,
        projectId: proj.projectId,
        version: "v1",
        currency: "EUR",
        lines: [],
        charges: [],
        taxBasis: "NL-EUR-INCLUSIVE",
        evidenceRefs: [],
        counterpartyRole: "vendor",
        executionMode: "live",
      }),
    ).rejects.toThrow(/Unexpected field/);
  });

  test("approvers cannot grant owner or roles above themselves", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Esc org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Esc project",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const elevated = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      targetIdentity: APPROVER_A.tokenIdentifier,
      role: "approver",
    });
    expect(elevated.ok).toBe(true);
    const asApprover = t.withIdentity(APPROVER_A);
    const sameLevel = await asApprover.mutation(grantProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      targetIdentity: CONTRIB_A.tokenIdentifier,
      role: "approver",
    });
    expect(sameLevel.ok).toBe(true);
    const escalate = await asApprover.mutation(grantProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      targetIdentity: OWNER_B.tokenIdentifier,
      role: "owner",
    });
    expect(escalate.ok).toBe(false);
    if (!escalate.ok) expect(escalate.code).toBe("denied-capability");
  });

  test("revoke binds the target membership to the stated project", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Revoke org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const projA = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Revoke A",
      visibility: "open",
    });
    if (!projA.ok) throw new Error("project A setup failed");
    const projB = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Revoke B",
      visibility: "open",
    });
    if (!projB.ok) throw new Error("project B setup failed");
    for (const proj of [projA, projB]) {
      const elevated = await asOwner.mutation(grantProjectAccessRef, {
        organizationId: org.organizationId,
        projectId: proj.projectId,
        targetIdentity: APPROVER_A.tokenIdentifier,
        role: "approver",
      });
      expect(elevated.ok).toBe(true);
    }
    const member = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: projA.projectId,
      targetIdentity: CONTRIB_A.tokenIdentifier,
      role: "viewer",
    });
    if (!member.ok) throw new Error("member setup failed");
    const asApprover = t.withIdentity(APPROVER_A);
    const crossRevoke = await asApprover.mutation(revokeProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: projB.projectId,
      membershipId: member.membershipId,
    });
    expect(crossRevoke.ok).toBe(false);
    const boundRevoke = await asApprover.mutation(revokeProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: projA.projectId,
      membershipId: member.membershipId,
    });
    expect(boundRevoke.ok).toBe(true);
  });

  test("project-scoped owners cannot administer the organization", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Scoped org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Scoped project",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const SCOPED = { tokenIdentifier: "direct-scoped-owner" };
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        organizationId: org.organizationId,
        projectId: proj.projectId,
        identity: SCOPED.tokenIdentifier,
        role: "owner",
        status: "active",
        version: 1,
        updatedAt: Date.now(),
      });
    });
    const attempt = await t.withIdentity(SCOPED).mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Lateral project",
      visibility: "open",
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe("denied-capability");
  });

  test("project-scoped-only roles cannot leak into another project", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "Leak org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const projOpen = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Leak open",
      visibility: "open",
    });
    if (!projOpen.ok) throw new Error("open project setup failed");
    const projRestricted = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "Leak restricted",
      visibility: "restricted",
    });
    if (!projRestricted.ok) throw new Error("restricted project setup failed");
    const SCOPED = { tokenIdentifier: "direct-scoped-only" };
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        organizationId: org.organizationId,
        projectId: projRestricted.projectId,
        identity: SCOPED.tokenIdentifier,
        role: "contributor",
        status: "active",
        version: 1,
        updatedAt: Date.now(),
      });
    });
    const leaked = await t.withIdentity(SCOPED).query(myProjectRoleRef, {
      organizationId: org.organizationId,
      projectId: projOpen.projectId,
    });
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.code).toBe("denied-membership");
  });

  test("unregistered paths fail to resolve in the test runtime", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const missing: FunctionReference<"mutation", "public", Record<string, never>, unknown> =
      makeFunctionReference("execution/dispatch:dispatchCommunication");
    await expect(asOwner.mutation(missing, {})).rejects.toThrow();
    const removed: FunctionReference<"mutation", "public", Record<string, never>, unknown> =
      makeFunctionReference("execution/communication:recordControlledSend");
    await expect(asOwner.mutation(removed, {})).rejects.toThrow();
    const seed: FunctionReference<"mutation", "public", Record<string, never>, unknown> =
      makeFunctionReference("purchasing/contracts/fixtures:seed");
    await expect(asOwner.mutation(seed, {})).rejects.toThrow();
  });
});
