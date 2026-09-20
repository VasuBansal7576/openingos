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
import type { Id } from "./_generated/dataModel.js";
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
import { payloadHash } from "./shared/hashing.js";
import { normalizeMailbox } from "./shared/mailbox.js";

const modules = import.meta.glob([
  "./access/**/*.ts",
  "./execution/**/*.ts",
  "./purchasing/**/*.ts",
  "./shared/**/*.ts",
  "./server.ts",
  "./auth.ts",
  "./models/**/*.ts",
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
const claimOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const recordOutcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.recordOutcome>,
  MutationReturn<typeof attempts.recordOutcome>
>("execution/attempts:recordOutcome");
const lateDeliveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.recordLateDelivery>,
  MutationReturn<typeof reconciliation.recordLateDelivery>
>("execution/reconciliation:recordLateDelivery");
const ingestEventRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.ingestEvent>,
  MutationReturn<typeof reconciliation.ingestEvent>
>("execution/reconciliation:ingestEvent");
const reviewedResendRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.reviewedResend>,
  MutationReturn<typeof attempts.reviewedResend>
>("execution/attempts:reviewedResend");
const configureRecipientInternalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof recipients.configure>,
  MutationReturn<typeof recipients.configure>
>("access/recipients:configure");
const cancelJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.cancel>,
  MutationReturn<typeof jobs.cancel>
>("execution/jobs:cancel");
const revokeGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.revoke>,
  MutationReturn<typeof grants.revoke>
>("access/grants:revoke");
const reconcileActualCostRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.reconcileActualCost>,
  MutationReturn<typeof reconciliation.reconcileActualCost>
>("execution/reconciliation:reconcileActualCost");
const reserveBudgetRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof import("./execution/reservations.js").reserve>,
  MutationReturn<typeof import("./execution/reservations.js").reserve>
>("execution/reservations:reserve");
const readLedgerRef = makeFunctionReference<
  "query",
  QueryArgs<typeof import("./execution/reservations.js").ledger>,
  QueryReturn<typeof import("./execution/reservations.js").ledger>
>("execution/reservations:ledger");
const listAttemptsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof import("./execution/attempts.js").attemptsForOperation>,
  QueryReturn<typeof import("./execution/attempts.js").attemptsForOperation>
>("execution/attempts:attemptsForOperation");
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const compareQuotesRef = makeFunctionReference<
  "query",
  QueryArgs<typeof quotes.compare>,
  QueryReturn<typeof quotes.compare>
>("purchasing/contracts/quotes:compare");
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
const OWNER_A = { tokenIdentifier: "direct-owner-a" };
const APPROVER_A = { tokenIdentifier: "direct-approver-a" };
const CONTRIB_A = { tokenIdentifier: "direct-contrib-a" };
const OWNER_B = { tokenIdentifier: "direct-owner-b" };
const ATTACKER = { tokenIdentifier: "direct-attacker" };
const OWNER_MAILBOX = "owner-supplier@example.test";

// Strict RFQ authority (ADR-0007 / D-17): every communication grant and
// operation payload must carry an anchored purchasing-communication body on
// its own — validateWorkflowPayload rejects the shared helper's generic
// fixture body. Key shape, owner-roleplay profile, owner recipient, and
// empty CC/BCC come from the shared helper unchanged; only the body carries
// the RFQ anchor (same precedent as f1r20r22.test.ts). The body avoids the
// word "reply" so it never reads as a thread reply requiring a conversation.
function directCommsPayload(to: string): Record<string, unknown> {
  return {
    ...commsPayload(to),
    subject: "Controlled RFQ fixture",
    body: "Send the controlled RFQ to the owner playing supplier.",
  };
}

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
    payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
    costCeilingMicroUsd: 100_000,
    roundLimit: 2,
    expiresAt: Date.now() + 3_600_000,
    // Exact current authority: one project-scoped communication.send entry
    // bound to this project. No conversation ref exists yet at grant time.
    workflowAuthorities: [{ operationId: "communication.send", projectId: proj.projectId }],
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
    const payloadJson = JSON.stringify(directCommsPayload(OWNER_MAILBOX));
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
      payloadJson: JSON.stringify(directCommsPayload("other@example.test")),
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
    const payloadJson = JSON.stringify(directCommsPayload(OWNER_MAILBOX));
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
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
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
    expect(flags(reconciliation.reconcileActualCost).isInternal).toBe(true);
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

describe("direct F1-19 anonymous sign-in", () => {
  test("anonymous sign-in resolves against the declared auth tables", async () => {
    // Controlled ephemeral RS256 key for this test run only: generated in
    // memory, never persisted, never committed, never a deployment secret.
    const keypair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keypair.privateKey);
    const bytes = new Uint8Array(pkcs8);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 4096) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    }
    process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
    process.env.CONVEX_SITE_URL = "https://controlled-convex-test.test";
    const t = convexTest(schema, modules);
    const signIn: FunctionReference<"action", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("auth:signIn");
    const result = (await t.action(signIn, { provider: "anonymous", params: {} })) as {
      tokens?: { token: string; refreshToken: string };
    } | null;
    expect(result?.tokens?.token).toBeTypeOf("string");
    expect(result?.tokens?.refreshToken).toBeTypeOf("string");
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
        taxBasis: { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
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
});

describe("direct checkpoint-2 money, budgets, and reconciliation", () => {
  async function setupBudgetedProject(
    t: ReturnType<typeof convexTest>,
    owner: { tokenIdentifier: string },
  ) {
    const setup = await setupCommsProject(t, owner);
    await t.run(async (ctx) => {
      await ctx.db.insert("providerBudgets", {
        organizationId: setup.orgId,
        ceilingMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-direct",
        updatedAt: Date.now(),
      });
    });
    return setup;
  }

  function quoteArgs(
    orgId: Id<"organizations">,
    projectId: Id<"projects">,
    version: string,
    extra: {
      supersedes?: string;
      conversationId?: Id<"conversations">;
    } = {},
  ) {
    return {
      organizationId: orgId,
      projectId,
      version,
      currency: "EUR",
      lines: [{
        lineId: "machine",
        description: "machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      }],
      charges: [],
      taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
      comparisonScope: {
        requirementId: "req-direct",
        scopeId: "scope-direct",
        items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
      },
      evidenceRefs: [],
      ...extra,
    };
  }

  test("comparison is quantity-aware and refuses unequal scope", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const scoped = (quantity: string) => ({
      requirementId: "req-direct",
      scopeId: "scope-direct",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: quantity }],
    });
    const two = await asOwner.mutation(recordQuoteRef, {
      ...quoteArgs(setup.orgId, setup.projectId, "q-two"),
      lines: [{
        lineId: "machine",
        description: "machine",
        quantity: "2",
        unitPrice: { currency: "EUR", minorUnits: 100_00 },
        evidenceRefs: [],
      }],
      comparisonScope: scoped("2"),
    });
    if (!two.ok) throw new Error("quote setup failed");
    const one = await asOwner.mutation(recordQuoteRef, {
      ...quoteArgs(setup.orgId, setup.projectId, "q-one"),
      lines: [{
        lineId: "machine",
        description: "machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 100_00 },
        evidenceRefs: [],
      }],
      comparisonScope: scoped("1"),
    });
    if (!one.ok) throw new Error("quote setup failed");
    const compared = await asOwner.query(compareQuotesRef, {
      leftQuoteId: two.quoteId,
      rightQuoteId: one.quoteId,
    });
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.status).toBe("incompatible");
    expect(compared.reason).toContain("not compatible");
    expect(compared.differenceMinorUnits).toBeNull();
    expect(compared.cheaper).toBeNull();
  });

  test("record validates versions, supersedes, and conversation references", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const empty = await asOwner.mutation(recordQuoteRef, quoteArgs(setup.orgId, setup.projectId, "  "));
    expect(empty.ok).toBe(false);
    const dangling = await asOwner.mutation(recordQuoteRef, {
      ...quoteArgs(setup.orgId, setup.projectId, "v-dangle"),
      supersedes: "deadbeefdeadbeef",
    });
    expect(dangling.ok).toBe(false);
    const foreignConv = await t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Other", kind: "private", createdAt: Date.now() });
      const otherProj = await ctx.db.insert("projects", {
        organizationId: otherOrg,
        name: "Other project",
        visibility: "open",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("conversations", {
        organizationId: otherOrg,
        projectId: otherProj,
        grantId: setup.grantId,
        version: 1,
        state: "draft",
        recipientConfigVersion: 1,
        updatedAt: Date.now(),
      });
    });
    const foreign = await asOwner.mutation(recordQuoteRef, {
      ...quoteArgs(setup.orgId, setup.projectId, "v-foreign-conv"),
      conversationId: foreignConv,
    });
    expect(foreign.ok).toBe(false);
  });

  test("grant issue validates rounds, recipient version, and conversation", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const base = {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      expiresAt: Date.now() + 3_600_000,
    };
    const zeroRounds = await asOwner.mutation(issueGrantRef, { ...base, roundLimit: 0 });
    expect(zeroRounds.ok).toBe(false);
    const staleRecipient = await asOwner.mutation(issueGrantRef, {
      ...base,
      roundLimit: 2,
      recipientConfigVersion: 999,
    });
    expect(staleRecipient.ok).toBe(false);
    const foreignConv = await t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Other2", kind: "private", createdAt: Date.now() });
      const otherProj = await ctx.db.insert("projects", {
        organizationId: otherOrg,
        name: "Other project 2",
        visibility: "open",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("conversations", {
        organizationId: otherOrg,
        projectId: otherProj,
        grantId: setup.grantId,
        version: 1,
        state: "draft",
        recipientConfigVersion: 1,
        updatedAt: Date.now(),
      });
    });
    const foreign = await asOwner.mutation(issueGrantRef, {
      ...base,
      roundLimit: 2,
      conversationId: foreignConv,
    });
    expect(foreign.ok).toBe(false);
  });

  test("reservations and rounds bind to the grant ceiling", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const over = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 500_000,
      pricingBasis: "controlled-direct",
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("grant-ceiling-exceeded");

    const limited = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "rounds" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 500_000,
      roundLimit: 1,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!limited.ok) throw new Error("grant setup failed");
    const job2 = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: limited.grantId,
    });
    if (!job2.ok) throw new Error("job2 setup failed");
    const first = await asOwner.mutation(createOperationRef, {
      jobId: job2.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-round-1",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: limited.grantId,
    });
    expect(first.ok).toBe(true);
    const second = await asOwner.mutation(createOperationRef, {
      jobId: job2.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-round-2",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: limited.grantId,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("round-limit-exceeded");
  });

  test("F1-23 alternate grants cannot ride a job past revocation", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const grant2 = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      roundLimit: 3,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!grant2.ok) throw new Error("grant2 setup failed");
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-alt-grant",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: grant2.grantId,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("denied-capability");
  });

  test("F1-22 coordinated advancement stales prepared operations", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-versions",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    await t.run(async (ctx) => {
      const grantRow = await ctx.db.get(setup.grantId);
      const jobRow = await ctx.db.get(job.jobId);
      if (!grantRow || !jobRow) throw new Error("missing rows");
      await ctx.db.patch(setup.grantId, { inputVersions: { brief: "v2" } });
      await ctx.db.patch(job.jobId, { inputVersions: { brief: "v2" } });
    });
    const claim = await t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("stale-input-version");
  });

  test("F1-24 tampered reservation relationships deny the claim", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 50_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-resrel",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
      reservationId: reservation.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const foreignBudget = await t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Budget other", kind: "private", createdAt: Date.now() });
      return await ctx.db.insert("providerBudgets", {
        organizationId: otherOrg,
        ceilingMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-direct",
        updatedAt: Date.now(),
      });
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(reservation.reservationId, { budgetId: foreignBudget });
    });
    const claim = await t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("denied-membership");
  });

  test("late delivery records receipt; actual-cost reconciliation settles exactly once", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 50_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-late-direct",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
      reservationId: reservation.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const claim = await t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    if (!claim.ok || !("attemptToken" in claim)) throw new Error("claim failed");
    const outcome = await t.mutation(recordOutcomeRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      outcome: "unknown",
      providerEventId: "evt-direct-late-1",
    });
    expect(outcome.ok).toBe(true);
    const before = await asOwner.query(readLedgerRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      jobId: job.jobId,
    });
    if (!before.ok) throw new Error("ledger failed");
    expect(before.budget?.unresolvedMicroUsd).toBe(50_000);

    const late = await t.mutation(lateDeliveryRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      providerEventId: "evt-direct-late-2",
    });
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error("late delivery failed");
    expect(late.delivery).toBe("observedSuccess");
    expect(late.deduplicated).toBe(false);
    // The receipt is recorded but the undetermined charge stays reserved
    // until authoritative reconciliation.
    const after = await asOwner.query(readLedgerRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      jobId: job.jobId,
    });
    if (!after.ok) throw new Error("ledger failed");
    expect(after.budget?.unresolvedMicroUsd).toBe(50_000);
    expect(after.budget?.spentMicroUsd).toBe(0);
    const attempts = await asOwner.query(listAttemptsRef, { operationId: created.operationId });
    if (!attempts.ok) throw new Error("attempts failed");
    expect(attempts.attempts[0]?.state).toBe("observedSuccess");

    const repeat = await t.mutation(lateDeliveryRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      providerEventId: "evt-direct-late-3",
    });
    expect(repeat.ok).toBe(false);
    const overspend = await t.mutation(reconcileActualCostRef, {
      operationId: created.operationId,
      actualSpentMicroUsd: 60_000,
    });
    expect(overspend.ok).toBe(false);

    const settled = await t.mutation(reconcileActualCostRef, {
      operationId: created.operationId,
      actualSpentMicroUsd: 30_000,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error("reconciliation failed");
    expect(settled.spentMicroUsd).toBe(30_000);
    expect(settled.releasedMicroUsd).toBe(20_000);
    const ledger = await asOwner.query(readLedgerRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      jobId: job.jobId,
    });
    if (!ledger.ok) throw new Error("ledger failed");
    expect(ledger.budget?.unresolvedMicroUsd).toBe(0);
    expect(ledger.budget?.spentMicroUsd).toBe(30_000);

    const twice = await t.mutation(reconcileActualCostRef, {
      operationId: created.operationId,
      actualSpentMicroUsd: 30_000,
    });
    expect(twice.ok).toBe(false);
  });

  test("reviewed resends require fresh reservations under exposure", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 25_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-resend-direct",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
      reservationId: reservation.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const claim = await t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    if (!claim.ok || !("attemptToken" in claim)) throw new Error("claim failed");
    const outcome = await t.mutation(recordOutcomeRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      outcome: "unknown",
      providerEventId: "evt-direct-resend-1",
    });
    expect(outcome.ok).toBe(true);
    const denied = await t.mutation(reviewedResendRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
      newRequestId: "req-resend-direct-2",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unknown-charges-reserved");

    const fresh = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 25_000,
      pricingBasis: "controlled-direct",
    });
    if (!fresh.ok) throw new Error("fresh reserve failed");
    const resent = await t.mutation(reviewedResendRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
      newRequestId: "req-resend-direct-2",
      newReservationId: fresh.reservationId,
    });
    expect(resent.ok).toBe(true);
    if (!resent.ok) throw new Error("resend failed");
    expect(resent.warning).toContain("may duplicate");
  });

  test("F1R-12 keeps receipt facts separate from unknown-to-success application", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 10_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-direct-receipt-application",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
      reservationId: reservation.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const claim = await t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    if (!claim.ok || !("attemptToken" in claim)) throw new Error("claim failed");
    const event = {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      provider: "direct-provider",
      environment: "controlled",
      eventId: "evt-direct-receipt-application",
      processingVersion: 1,
      outcome: "unknown",
    } as const;
    const receipt = await t.mutation(ingestEventRef, event);
    expect(receipt).toEqual({ ok: true, deduplicated: false, outcome: "unknown" });
    const recorded = await t.mutation(recordOutcomeRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      provider: event.provider,
      environment: event.environment,
      providerEventId: event.eventId,
      outcome: "unknown",
    });
    expect(recorded).toMatchObject({ ok: true, state: "outcomeUnknown", deduplicated: false, outcome: "unknown" });
    const late = await t.mutation(lateDeliveryRef, {
      operationId: created.operationId,
      token: claim.attemptToken,
      provider: event.provider,
      environment: event.environment,
      providerEventId: event.eventId,
    });
    expect(late).toMatchObject({ ok: true, delivery: "observedSuccess", deduplicated: false });
    const saved = await t.run((ctx) =>
      ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_event", (q) =>
          q.eq("provider", event.provider).eq("environment", event.environment).eq("eventId", event.eventId),
        )
        .unique(),
    );
    expect(saved?.outcome).toBe("unknown");
    expect(saved?.applicationOutcome).toBe("success");
    expect(saved?.operationId).toBe(created.operationId);
  });

  test("F1-20 duplicate events across operations settle nothing twice", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgetedProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const mkOp = async (requestId: string) => {
      const job = await asOwner.mutation(startJobRef, {
        organizationId: setup.orgId,
        projectId: setup.projectId,
        text: "Send the RFQ to the demo supplier.",
        kind: "communication",
        grantId: setup.grantId,
      });
      if (!job.ok) throw new Error("job setup failed");
      const reservation = await asOwner.mutation(reserveBudgetRef, {
        jobId: job.jobId,
        organizationId: setup.orgId,
        projectId: setup.projectId,
        amountMicroUsd: 10_000,
        pricingBasis: "controlled-direct",
      });
      if (!reservation.ok) throw new Error("reserve failed");
      const created = await asOwner.mutation(createOperationRef, {
        jobId: job.jobId,
        organizationId: setup.orgId,
        projectId: setup.projectId,
        kind: "communication.send",
        requestId,
        payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
        grantId: setup.grantId,
        reservationId: reservation.reservationId,
      });
      if (!created.ok) throw new Error("operation setup failed");
      const claim = await t.mutation(claimOperationRef, {
        operationId: created.operationId,
        identity: OWNER_A.tokenIdentifier,
      });
      if (!claim.ok || !("attemptToken" in claim)) throw new Error("claim failed");
      return { op: created.operationId, token: claim.attemptToken };
    };
    const first = await mkOp("req-evt-direct-a");
    const second = await mkOp("req-evt-direct-b");
    const done = await t.mutation(recordOutcomeRef, {
      operationId: first.op,
      token: first.token,
      outcome: "success",
      providerEventId: "evt-direct-shared-1",
    });
    expect(done.ok).toBe(true);
    const duplicate = await t.mutation(recordOutcomeRef, {
      operationId: second.op,
      token: second.token,
      outcome: "success",
      providerEventId: "evt-direct-shared-1",
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("foreign operation unexpectedly applied the receipt");
    expect(duplicate.code).toBe("duplicate-conflict");
    const secondState = await asOwner.query(getOperationRef, { operationId: second.op });
    if (!secondState.ok) throw new Error("get failed");
    expect(secondState.state).toBe("dispatching");
  });

  test("F1-21 comma mailboxes fail even on the server path", async () => {
    const t = convexTest(schema, modules);
    const rejected = await t.mutation(configureRecipientInternalRef, {
      mailbox: "owner-supplier@example.test,other@example.test",
      authorizedBy: "deployment",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("invalid-payload");
  });

});

describe("direct checkpoint-A authority hardening", () => {
  async function setupBudgeted(
    t: ReturnType<typeof convexTest>,
    owner: { tokenIdentifier: string },
  ) {
    const setup = await setupCommsProject(t, owner);
    await t.run(async (ctx) => {
      await ctx.db.insert("providerBudgets", {
        organizationId: setup.orgId,
        ceilingMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-direct",
        updatedAt: Date.now(),
      });
    });
    return setup;
  }

  test("restricted project creation atomically grants the creator a project owner row", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "A1 org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "A1 restricted",
      visibility: "restricted",
    });
    if (!proj.ok) throw new Error("project setup failed");
    // No separate grant step: the creator already holds project ownership.
    const role = await asOwner.query(myProjectRoleRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
    });
    expect(role.ok).toBe(true);
    if (!role.ok) throw new Error("role read failed");
    expect(role.role).toBe("owner");
    // An outsider still cannot reach the restricted project.
    const stranger = await t.withIdentity(ATTACKER).query(myProjectRoleRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
    });
    expect(stranger.ok).toBe(false);
  });

  test("revocation is exact-project and role-capped", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "A2 org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "A2 project",
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
    const ownerMembershipId = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("memberships")
        .withIndex("by_organization_and_identity", (q) =>
          q.eq("organizationId", org.organizationId).eq("identity", OWNER_A.tokenIdentifier),
        )
        .collect();
      const scoped = rows.find((row) => row.projectId === proj.projectId);
      return scoped?._id ?? null;
    });
    if (ownerMembershipId === null) throw new Error("owner project membership missing");
    // An approver cannot revoke the project owner above their own role.
    const capped = await t.withIdentity(APPROVER_A).mutation(revokeProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      membershipId: ownerMembershipId,
    });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.code).toBe("denied-capability");
    // The owner can still revoke the approver in the same project.
    if (!elevated.ok) throw new Error("grant setup failed");
    const bound = await asOwner.mutation(revokeProjectAccessRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      membershipId: elevated.membershipId,
    });
    expect(bound.ok).toBe(true);
  });

  test("a supplied operationId never bypasses clearly unrelated text", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const refused = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Please do my homework on photosynthesis.",
      operationId: "research.collect",
      kind: "research",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("unrelated-refusal");
  });

  test("explicit job grants must match, stay active, and authorize the classified operation", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    // A research request under a communication-only grant starts nothing.
    const mismatched = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Research suppliers for the espresso machine.",
      kind: "research",
      grantId: setup.grantId,
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe("denied-capability");
    // A grant from another project cannot authorize this job.
    const other = await asOwner.mutation(createProjectRef, {
      organizationId: setup.orgId,
      name: "A4 other",
      visibility: "open",
    });
    if (!other.ok) throw new Error("other project setup failed");
    const foreignGrant = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: other.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      roundLimit: 2,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!foreignGrant.ok) throw new Error("foreign grant setup failed");
    const foreign = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: foreignGrant.grantId,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("denied-membership");
    // A revoked grant authorizes nothing further.
    const revoked = await asOwner.mutation(revokeGrantRef, { grantId: setup.grantId });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    expect(afterRevoke.ok).toBe(false);
    if (!afterRevoke.ok) expect(afterRevoke.code).toBe("revoked-grant");
  });

  test("cancel releases unclaimed prepared reservations to the org ledger", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgeted(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 25_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const created = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-cancel-release",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
      reservationId: reservation.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const cancelled = await asOwner.mutation(cancelJobRef, { jobId: job.jobId, reason: "takeover" });
    expect(cancelled.ok).toBe(true);
    const ledger = await asOwner.query(readLedgerRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      jobId: job.jobId,
    });
    if (!ledger.ok) throw new Error("ledger failed");
    expect(ledger.budget?.reservedMicroUsd).toBe(0);
    expect(ledger.reservations[0]?.state).toBe("closed");
    const state = await asOwner.query(getOperationRef, { operationId: created.operationId });
    if (!state.ok) throw new Error("get failed");
    expect(state.state).toBe("cancelled");
  });

  test("paid claims require a reservation bound one-to-one; dedupe precedes round limits", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupBudgeted(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: setup.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    // A provider-effectful claim without bound allowance is denied.
    const bare = await asOwner.mutation(createOperationRef, {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      requestId: "req-bare-claim",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: setup.grantId,
    });
    if (!bare.ok) throw new Error("bare create failed");
    const bareClaim = await t.mutation(claimOperationRef, {
      operationId: bare.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    expect(bareClaim.ok).toBe(false);
    if (!bareClaim.ok) expect(bareClaim.code).toBe("allowance-exhausted");
    // One reservation funds one operation: the second attach is denied.
    // A dedicated multi-round grant keeps the round limit out of the way.
    const roomy = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      roundLimit: 5,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!roomy.ok) throw new Error("roomy grant setup failed");
    const job2 = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: roomy.grantId,
    });
    if (!job2.ok) throw new Error("job2 setup failed");
    const reservation = await asOwner.mutation(reserveBudgetRef, {
      jobId: job2.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      amountMicroUsd: 20_000,
      pricingBasis: "controlled-direct",
    });
    if (!reservation.ok) throw new Error("reserve failed");
    const boundBase = {
      jobId: job2.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      grantId: roomy.grantId,
      reservationId: reservation.reservationId,
    };
    const first = await asOwner.mutation(createOperationRef, { ...boundBase, requestId: "req-bound-1" });
    expect(first.ok).toBe(true);
    const double = await asOwner.mutation(createOperationRef, { ...boundBase, requestId: "req-bound-2" });
    expect(double.ok).toBe(false);
    if (!double.ok) expect(double.code).toBe("allowance-exhausted");
    // A reservation whose job grant moved away from the operation grant
    // cannot fund the claim: the operation grant must still match the job
    // grant at claim time.
    const grant2 = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      roundLimit: 3,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!grant2.ok) throw new Error("grant2 setup failed");
    await t.run(async (ctx) => {
      await ctx.db.patch(job2.jobId, { grantId: grant2.grantId });
    });
    if (!first.ok) throw new Error("first create failed");
    const grantMismatch = await t.mutation(claimOperationRef, {
      operationId: first.operationId,
      identity: OWNER_A.tokenIdentifier,
    });
    expect(grantMismatch.ok).toBe(false);
    if (!grantMismatch.ok) expect(grantMismatch.code).toBe("denied-capability");
  });

  test("identical retries dedupe even when the grant round is exhausted", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const limited = await asOwner.mutation(issueGrantRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      operations: ["communication.send"],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: 1,
      inputVersions: { brief: "single-round" },
      payloadJson: JSON.stringify(directCommsPayload(OWNER_MAILBOX)),
      costCeilingMicroUsd: 100_000,
      roundLimit: 1,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!limited.ok) throw new Error("grant setup failed");
    const job = await asOwner.mutation(startJobRef, {
      organizationId: setup.orgId,
      projectId: setup.projectId,
      text: "Send the RFQ to the demo supplier.",
      kind: "communication",
      grantId: limited.grantId,
    });
    if (!job.ok) throw new Error("job setup failed");
    const payloadJson = JSON.stringify(directCommsPayload(OWNER_MAILBOX));
    const base = {
      jobId: job.jobId,
      organizationId: setup.orgId,
      projectId: setup.projectId,
      kind: "communication.send",
      payloadJson,
      grantId: limited.grantId,
    };
    const first = await asOwner.mutation(createOperationRef, { ...base, requestId: "req-single" });
    expect(first.ok).toBe(true);
    // The identical retry dedupes instead of hitting the round limit.
    const retry = await asOwner.mutation(createOperationRef, { ...base, requestId: "req-single" });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("dedupe failed");
    expect(retry.deduped).toBe(true);
    // A genuinely new request still exhausts the single round.
    const next = await asOwner.mutation(createOperationRef, { ...base, requestId: "req-next" });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.code).toBe("round-limit-exceeded");
  });

  test("auto research authority carries valid positive round semantics", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER_A);
    const org = await asOwner.mutation(createOrganizationRef, { name: "A7 org", kind: "private" });
    if (!org.ok) throw new Error("org setup failed");
    const proj = await asOwner.mutation(createProjectRef, {
      organizationId: org.organizationId,
      name: "A7 project",
      visibility: "open",
    });
    if (!proj.ok) throw new Error("project setup failed");
    const job = await asOwner.mutation(startJobRef, {
      organizationId: org.organizationId,
      projectId: proj.projectId,
      text: "Research suppliers for the espresso machine.",
      kind: "research",
    });
    expect(job.ok).toBe(true);
    if (!job.ok) throw new Error("auto job failed");
    const authority = await t.run(async (ctx) => {
      const jobRow = await ctx.db.get(job.jobId);
      if (!jobRow) return null;
      return await ctx.db.get(jobRow.grantId);
    });
    expect(authority?.roundLimit).toBeGreaterThanOrEqual(1);
    expect(authority?.status).toBe("active");
  });

  function quoteBArgs(
    orgId: Id<"organizations">,
    projectId: Id<"projects">,
    version: string,
    extra: {
      supersedes?: string;
      conversationId?: Id<"conversations">;
    } = {},
  ) {
    return {
      organizationId: orgId,
      projectId,
      version,
      currency: "EUR",
      lines: [{
        lineId: "machine",
        description: "machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      }],
      charges: [],
      taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
      comparisonScope: {
        requirementId: "req-direct-b",
        scopeId: "scope-direct-b",
        items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
      },
      evidenceRefs: [],
      ...extra,
    };
  }

  test("discriminated charge states require reasons or coveringIds", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const base = (version: string) => quoteBArgs(setup.orgId, setup.projectId, version);
    const bareUnknown = await asOwner.mutation(recordQuoteRef, {
      ...base("qb-bare-unknown"),
      charges: [{
        chargeId: "install",
        label: "install",
        state: { kind: "unknown", reason: "   " },
        evidenceRefs: [],
      }],
    });
    expect(bareUnknown.ok).toBe(false);
    const bareIncluded = await asOwner.mutation(recordQuoteRef, {
      ...base("qb-bare-included"),
      charges: [{
        chargeId: "freight",
        label: "freight",
        state: { kind: "included", coveringId: "  " },
        evidenceRefs: [],
      }],
    });
    expect(bareIncluded.ok).toBe(false);
    const stated = await asOwner.mutation(recordQuoteRef, {
      ...base("qb-stated"),
      charges: [
        {
          chargeId: "install",
          label: "install",
          state: { kind: "unknown", reason: "supplier did not state installation" },
          evidenceRefs: [],
        },
        { chargeId: "freight", label: "freight", state: { kind: "included", coveringId: "machine" }, evidenceRefs: [] },
        {
          chargeId: "warranty",
          label: "warranty",
          state: {
            kind: "estimated",
            estimate: {
              kind: "range",
              minimum: { currency: "EUR", minorUnits: 100_00 },
              maximum: { currency: "EUR", minorUnits: 200_00 },
            },
          },
          evidenceRefs: [],
        },
        { chargeId: "gift", label: "gift", state: { kind: "notApplicable", reason: "no gift wrap" }, evidenceRefs: [] },
      ],
    });
    expect(stated.ok).toBe(true);
  });

  test("duplicate lines and versions are rejected; reorder still compares", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const line = (lineId: string) => ({
      lineId,
      description: lineId,
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 100_00 },
      evidenceRefs: [],
    });
    const pairScope = {
      requirementId: "req-pairs",
      scopeId: "scope-pairs",
      items: [
        { itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" },
        { itemId: "freight-line", lineId: "freight-line", unit: "piece", requiredQuantity: "1" },
      ],
    };
    const duplicated = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-duplines"),
      lines: [line("machine"), line("machine")],
      comparisonScope: pairScope,
    });
    expect(duplicated.ok).toBe(false);
    const left = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-order-a"),
      lines: [line("machine"), line("freight-line")],
      comparisonScope: pairScope,
    });
    if (!left.ok) throw new Error("left setup failed");
    const versionAgain = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-order-a"),
      lines: [line("machine"), line("freight-line")],
      comparisonScope: pairScope,
    });
    expect(versionAgain.ok).toBe(false);
    const right = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-order-b"),
      lines: [line("freight-line"), line("machine")],
      comparisonScope: pairScope,
    });
    if (!right.ok) throw new Error("right setup failed");
    const compared = await asOwner.query(compareQuotesRef, {
      leftQuoteId: left.quoteId,
      rightQuoteId: right.quoteId,
    });
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.status).toBe("complete");
    expect(compared.cheaper).toBe("equal");
    expect(compared.differenceMinorUnits).toBe(0);
  });

  test("unrelated aggregate-equal lines never compare", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const left = await asOwner.mutation(recordQuoteRef, quoteBArgs(setup.orgId, setup.projectId, "qb-unrel-a"));
    if (!left.ok) throw new Error("left setup failed");
    const right = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-unrel-b"),
      comparisonScope: {
        requirementId: "req-other",
        scopeId: "scope-other",
        items: [{ itemId: "machine", lineId: "machine", unit: "hour", requiredQuantity: "1" }],
      },
    });
    if (!right.ok) throw new Error("right setup failed");
    const compared = await asOwner.query(compareQuotesRef, {
      leftQuoteId: left.quoteId,
      rightQuoteId: right.quoteId,
    });
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.status).toBe("incompatible");
    expect(compared.cheaper).toBeNull();
  });

  test("estimated comparisons expose the signed range with no singular cheaper side", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const left = await asOwner.mutation(recordQuoteRef, quoteBArgs(setup.orgId, setup.projectId, "qb-est-a"));
    if (!left.ok) throw new Error("left setup failed");
    const right = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-est-b"),
      charges: [{
        chargeId: "freight",
        label: "freight",
        state: {
          kind: "estimated",
          estimate: {
            kind: "range",
            minimum: { currency: "EUR", minorUnits: 100_00 },
            maximum: { currency: "EUR", minorUnits: 200_00 },
          },
        },
        evidenceRefs: [],
      }],
    });
    if (!right.ok) throw new Error("right setup failed");
    const compared = await asOwner.query(compareQuotesRef, {
      leftQuoteId: left.quoteId,
      rightQuoteId: right.quoteId,
    });
    expect(compared.ok).toBe(true);
    if (!compared.ok) throw new Error("compare failed");
    expect(compared.status).toBe("estimated");
    expect(compared.differenceMinorUnits).toBeNull();
    expect(compared.cheaper).toBeNull();
    expect(compared.estimatedDeltaRange).toEqual({ minimum: -200_00, maximum: -100_00 });
  });

  test("identical content in another project cannot break lineage", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const other = await asOwner.mutation(createProjectRef, {
      organizationId: setup.orgId,
      name: "Lineage other",
      visibility: "open",
    });
    if (!other.ok) throw new Error("other project setup failed");
    const home = await asOwner.mutation(recordQuoteRef, quoteBArgs(setup.orgId, setup.projectId, "qb-xproj-a"));
    if (!home.ok) throw new Error("home setup failed");
    // Same version and content, other project: records with its own hash.
    const awayArgs = quoteBArgs(setup.orgId, other.projectId, "qb-xproj-a");
    const away = await asOwner.mutation(recordQuoteRef, {
      ...awayArgs,
      comparisonScope: {
        requirementId: "req-direct-b",
        scopeId: "scope-direct-b",
        items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
      },
    });
    expect(away.ok).toBe(true);
    if (!away.ok) throw new Error("away setup failed");
    expect(away.contentHash).not.toBe(home.contentHash);
    // A supersedes pointer at the other project's hash resolves nothing here.
    const foreign = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, other.projectId, "qb-xproj-b"),
      supersedes: home.contentHash,
    });
    expect(foreign.ok).toBe(false);
  });

  test("supersedes binds counterparty lineage and hashes decision fields", async () => {
    const t = convexTest(schema, modules);
    const setup = await setupCommsProject(t, OWNER_A);
    const asOwner = t.withIdentity(OWNER_A);
    const first = await asOwner.mutation(recordQuoteRef, quoteBArgs(setup.orgId, setup.projectId, "qb-lineage-a"));
    if (!first.ok) throw new Error("first setup failed");
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const lineage = await t.run(async (ctx) => {
      const row = await ctx.db.get(first.quoteId);
      return row?.counterpartyRole ?? null;
    });
    expect(lineage).toBe("userImport");
    const second = await asOwner.mutation(recordQuoteRef, {
      ...quoteBArgs(setup.orgId, setup.projectId, "qb-lineage-b"),
      supersedes: first.contentHash,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("lineage revision failed");
    expect(second.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.contentHash).not.toBe(first.contentHash);
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
