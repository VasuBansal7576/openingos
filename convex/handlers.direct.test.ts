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

type MutationArgs<T> = T extends RegisteredMutation<any, infer A, any> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<any, any, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<any, infer A, any> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<any, any, infer R> ? R : never;

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
const configureRecipientRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof recipients.configure>,
  MutationReturn<typeof recipients.configure>
>("access/recipients:configure");
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
  const recipient = await asOwner.mutation(configureRecipientRef, {
    organizationId: org.organizationId,
    mailbox: OWNER_MAILBOX,
  });
  if (!recipient.ok) throw new Error("recipient setup failed");
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
        const handler = value as { isMutation?: boolean; isQuery?: boolean; isAction?: boolean };
        expect(handler.isMutation === true).toBe(false);
        expect(handler.isQuery === true).toBe(false);
        expect(handler.isAction === true).toBe(false);
      }
    }
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
