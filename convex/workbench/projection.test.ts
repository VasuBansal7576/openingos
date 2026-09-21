/// <reference types="vite/client" />

import { makeFunctionReference, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel.js";
import type { Doc as SchemaDoc } from "../_generated/dataModel.js";
import * as memberships from "../access/memberships.js";
import * as requirements from "../domain/requirements.js";
import * as sourcing from "../domain/sourcing.js";
import * as projection from "./projection.js";
import schema from "../schema.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../domain/**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "./**/*.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!../domain/**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../purchasing/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!./**/*.test.ts",
]);
const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./")
    ? `workbench/${path.slice(2)}`
    : path.replace(/^\.\.\//, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;
type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;

const listProjectsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.listAccessibleProjects>,
  QueryReturn<typeof projection.listAccessibleProjects>
>("workbench/projection:listAccessibleProjects");
const getProjectionRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.getProjection>,
  QueryReturn<typeof projection.getProjection>
>("workbench/projection:getProjection");
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
const expireMembershipRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.expireMembership>,
  MutationReturn<typeof memberships.expireMembership>
>("access/memberships:expireMembership");
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
const recordVendorRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordVendor>,
  MutationReturn<typeof sourcing.recordVendor>
>("domain/sourcing:recordVendor");
const recordCandidateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordCandidate>,
  MutationReturn<typeof sourcing.recordCandidate>
>("domain/sourcing:recordCandidate");

const OWNER = { tokenIdentifier: "workbench-owner" };
const GUEST = { tokenIdentifier: "workbench-guest" };
const OTHER = { tokenIdentifier: "workbench-other" };

async function setupProject(
  t: ReturnType<typeof convexTest>,
  identity: { tokenIdentifier: string },
  suffix: string,
  visibility: "open" | "restricted" = "open",
) {
  const asUser = t.withIdentity(identity);
  const organization = await asUser.mutation(createOrganizationRef, {
    name: `${suffix} organization`,
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${JSON.stringify(organization)}`);
  const project = await asUser.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: `${suffix} project`,
    visibility,
  });
  if (!project.ok) throw new Error(`project setup failed: ${JSON.stringify(project)}`);
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

async function setupCandidate(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  suffix: string,
) {
  const asOwner = t.withIdentity(OWNER);
  const requirement = await asOwner.mutation(createRequirementRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    key: `machine-${suffix}`,
    title: `Machine ${suffix}`,
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0",
  });
  if (!requirement.ok) throw new Error(`requirement setup failed: ${JSON.stringify(requirement)}`);
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.organizationId,
    name: `Vendor ${suffix}`,
    regions: ["NL"],
    serviceCoverage: "Netherlands",
  });
  if (!vendor.ok) throw new Error(`vendor setup failed: ${JSON.stringify(vendor)}`);
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    requirementId: requirement.requirementId,
    vendorId: vendor.vendorId,
    productModel: `Model ${suffix}`,
    variant: "220V",
    conversationState: "quoteReceived",
  });
  if (!candidate.ok) throw new Error(`candidate setup failed: ${JSON.stringify(candidate)}`);
  return {
    requirementId: requirement.requirementId,
    vendorId: vendor.vendorId,
    candidateId: candidate.candidateId,
  };
}

async function insertOwnerQuote(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  graph: { requirementId: Id<"requirements">; vendorId: Id<"vendors"> },
  version: string,
  contentHash: string,
  supersedes: string | undefined,
  createdAt: number,
  sourceId = "private-message-id",
  comparisonScope?: {
    readonly requirementId: string;
    readonly scopeId: string;
    readonly items: readonly {
      readonly itemId: string;
      readonly lineId: string;
      readonly unit: string;
      readonly requiredQuantity: string;
    }[];
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("quotes", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      version,
      contentHash,
      currency: "EUR",
      lines: [{
        lineId: "machine",
        description: "Machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: version === "v1" ? 795000 : 750000 },
        evidenceRefs: [{ sourceId, version, locator: "raw headers" }],
      }],
      charges: [{
        chargeId: "freight",
        label: "Freight",
        scope: { kind: "quote" },
        state: { kind: "unknown", reason: "not confirmed" },
        evidenceRefs: [],
      }],
      taxBasis: { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
      ...(comparisonScope === undefined ? {} : { comparisonScope }),
      evidenceRefs: [{ sourceId, version, locator: "raw headers" }],
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
      ...(supersedes === undefined ? {} : { supersedes }),
      createdAt,
    }),
  );
}

async function insertUnrelatedQuotes(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let index = 0; index < 300; index += 1) {
      await ctx.db.insert("quotes", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        version: `unrelated-${index}`,
        contentHash: `unrelated-content-${index}`,
        currency: "EUR",
        lines: [{
          lineId: "unrelated-line",
          description: "Unrelated offer",
          quantity: "1",
          unitPrice: { currency: "EUR", minorUnits: 1 },
          evidenceRefs: [],
        }],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
        evidenceRefs: [],
        counterpartyRole: "userImport",
        executionMode: "recorded",
        createdAt: now + index,
      });
    }
  });
}

async function seedJobState(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  state: "queued" | "completed" | "partial" | "pausedBudget",
  operationState: "observedSuccess" | "outcomeUnknown" | undefined,
  withReply: boolean,
  suffix: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const grantId = await ctx.db.insert("grants", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operations: ["communication.send"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 1,
      inputVersions: {},
      canonicalPayload: `{"${suffix}":true}`,
      payloadHash: `hash-${suffix}`,
      costCeilingMicroUsd: 100,
      roundLimit: 1,
      expiresAt: now + 60_000,
      revocationVersion: 1,
      status: "active",
      createdAt: now,
    });
    const jobId = await ctx.db.insert("jobs", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      grantId,
      grantVersion: 1,
      kind: "communication",
      workflowPurpose: "purchasingCommunication",
      inputVersions: {},
      state,
      createdAt: now,
      updatedAt: now,
    });
    if (operationState !== undefined) {
      const operationId = await ctx.db.insert("operations", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        jobId,
        kind: "communication.send",
        requestId: `request-${suffix}`,
        requestKey: `request-key-${suffix}`,
        normalizedPayload: "{}",
        normalizedPayloadHash: `payload-${suffix}`,
        inputVersions: {},
        grantId,
        grantVersion: 1,
        state: operationState,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("attempts", {
        operationId,
        token: `secret-token-${suffix}`,
        state: operationState,
        createdAt: now,
        observedAt: operationState === "observedSuccess" ? now : undefined,
        providerEventId: `provider-event-${suffix}`,
      });
    }
    if (withReply) {
      await ctx.db.insert("conversations", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        grantId,
        version: 1,
        state: "replyReceived",
        recipientConfigVersion: 1,
        updatedAt: now,
      });
    }
    return jobId;
  });
}

describe("U1 workbench projection", () => {
  test("lists only authorized projects and returns stable private denial", async () => {
    const t = convexTest(schema, modules);
    const privateProject = await setupProject(t, OWNER, "private", "restricted");
    const guestProject = await setupProject(t, GUEST, "guest");
    const deletedProject = await setupProject(t, GUEST, "deleted");
    await t.run((ctx) => ctx.db.delete("projects", deletedProject.projectId));
    const guest = t.withIdentity(GUEST);

    const listed = await guest.query(listProjectsRef, { limit: 10 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("guest list denied");
    expect(listed.projects.map((item) => item.id)).toEqual([guestProject.projectId]);
    expect(listed.projects[0]?.access.role).toBe("owner");

    const denied = await guest.query(getProjectionRef, { projectId: privateProject.projectId, limit: 1 });
    expect(denied).toEqual({ ok: false, code: "denied-membership", message: "not authorized for this project" });

    const missing = await guest.query(getProjectionRef, { projectId: deletedProject.projectId, limit: 1 });
    expect(missing).toEqual({ ok: false, code: "denied-membership", message: "not authorized for this project" });
  });

  test("projects approval and service-case authority from the resolved role", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "role-flags");
    const grant = await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      targetIdentity: "workbench-contributor",
      role: "contributor",
    });
    if (!grant.ok) throw new Error(`contributor grant failed: ${JSON.stringify(grant)}`);
    const contributor = await t.withIdentity({ tokenIdentifier: "workbench-contributor" }).query(getProjectionRef, { projectId: project.projectId, limit: 1 });
    expect(contributor.ok).toBe(true);
    if (!contributor.ok) throw new Error("contributor projection denied");
    expect(contributor.access.role).toBe("contributor");
    expect(contributor.access.capabilities.canApprove).toBe(false);
    expect(contributor.access.capabilities.canOpenServiceCase).toBe(true);
    const owner = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId, limit: 1 });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error("owner projection denied");
    expect(owner.access.capabilities.canApprove).toBe(true);
    expect(owner.access.capabilities.canOpenServiceCase).toBe(true);
  });

  test("paginates project listing and excludes expired project memberships", async () => {
    const t = convexTest(schema, modules);
    const first = await setupProject(t, OWNER, "page-0");
    const projects = [first.projectId];
    for (let index = 1; index < 5; index += 1) {
      const next = await setupProject(t, OWNER, `page-${index}`);
      projects.push(next.projectId);
    }
    const expired = await setupProject(t, OTHER, "expired", "restricted");
    await t.run(async (ctx) => {
      const now = Date.now();
      const membershipId = await ctx.db.insert("memberships", {
        organizationId: expired.organizationId,
        projectId: expired.projectId,
        identity: OWNER.tokenIdentifier,
        role: "viewer",
        status: "active",
        version: 1,
        expiresAt: now - 1,
        updatedAt: now,
      });
      await ctx.db.insert("membershipAuthorities", {
        organizationId: expired.organizationId,
        projectId: expired.projectId,
        identity: OWNER.tokenIdentifier,
        scopeKey: `project:${expired.projectId}`,
        role: "viewer",
        membershipId,
        authorityUntil: now - 1,
        expiresAt: now - 1,
        updatedAt: now,
      });
    });

    const seen: Id<"projects">[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await t.withIdentity(OWNER).query(
        listProjectsRef,
        cursor === undefined ? { limit: 2 } : { cursor, limit: 2 },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error("owner list denied");
      seen.push(...page.projects.map((item) => item.id));
      if (page.isDone) break;
      cursor = page.continueCursor ?? undefined;
      if (cursor === undefined) throw new Error("missing opaque cursor");
    }
    expect(seen).toEqual(expect.arrayContaining(projects));
    expect(seen).not.toContain(expired.projectId);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("redacts owner evidence and selects only the latest non-superseded quote", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "quote");
    const graph = await setupCandidate(t, project, "redaction");
    const snapshotId = await t.run(async (ctx) => ctx.db.insert("evidence", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      sourceKind: "owner-email",
      sourceUrl: "https://private.example/owner-thread",
      providerIds: "provider-message-id",
      capturedAt: 99,
      contentHash: "owner-content",
      completeness: "complete",
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
      locator: "raw headers",
    }));
    await t.run(async (ctx) => {
      await ctx.db.insert("productEvidence", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        candidateId: graph.candidateId,
        field: "price",
        sourceKind: "owner-email",
        sourceUrl: "https://private.example/owner-thread",
        capturedAt: 100,
        originalValue: "owner@example.test To: private headers",
        normalizedValue: "750000 EUR",
        verification: "verified",
        freshness: "fresh",
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded",
        origin: "ownerImport",
        conflictEvidenceIds: [],
        idempotencyKey: "owner-evidence",
        version: "1",
        createdAt: 100,
      });
    });
    await insertOwnerQuote(t, project, graph, "v1", "hash-v1", undefined, 100, snapshotId);
    await insertOwnerQuote(t, project, graph, "v2", "hash-v2", "hash-v1", 200, snapshotId);
    await insertUnrelatedQuotes(t, project);

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId, limit: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.access.role).toBe("owner");
    const candidate = result.candidates[0];
    expect(candidate?.latestValidQuote?.version).toBe("v2");
    expect(candidate?.latestValidQuote?.lines[0]?.unitPrice.minorUnits).toBe(750000);
    expect(candidate?.latestValidQuote?.charges[0]?.state.kind).toBe("unknown");
    expect(candidate?.provenance).toMatchObject({ mode: "recorded", label: "Recorded demo exchange", ownerAuthoredTerms: true });
    expect(result.provenance.ownerAuthoredTerms).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("owner@example.test");
    expect(serialized).not.toContain("private headers");
    expect(serialized).not.toContain("provider-message-id");
    expect(serialized).not.toContain("provider-event");
    expect(serialized).not.toContain("private-message-id");
    expect(candidate?.evidence[0]).not.toHaveProperty("sourceUrl");
    expect(candidate?.evidence[0]).not.toHaveProperty("normalizedValue");
  });

  test("preserves truthful queued, sent, delivered, unknown, partial and paused states", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "jobs");
    await seedJobState(t, project, "completed", "observedSuccess", false, "sent");
    await seedJobState(t, project, "completed", "observedSuccess", true, "delivered");
    await seedJobState(t, project, "completed", "outcomeUnknown", false, "unknown");
    await seedJobState(t, project, "partial", "observedSuccess", false, "partial");
    await seedJobState(t, project, "pausedBudget", undefined, false, "paused");
    await seedJobState(t, project, "queued", undefined, false, "queued");
    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId, limit: 12 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.jobs.map((job) => job.status)).toEqual(expect.arrayContaining([
      "sent",
      "delivered",
      "unknown",
      "partial",
      "paused",
      "queued",
    ]));
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("provider-event");
    expect(result.jobs.every((job) => job.attempts.every((attempt) => !Object.prototype.hasOwnProperty.call(attempt, "token")))).toBe(true);
  });

  test("projects action authority fields and normalizes pending approvals", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "actions");
    const graph = await setupCandidate(t, project, "actions");
    await insertOwnerQuote(
      t,
      project,
      graph,
      "v1",
      "actions-quote",
      undefined,
      100,
      "actions-source",
      {
        requirementId: graph.requirementId,
        scopeId: "actions-scope",
        items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
      },
    );
    await seedJobState(t, project, "queued", undefined, false, "actions-queued");
    await seedJobState(t, project, "completed", "observedSuccess", false, "actions-completed");
    await t.run(async (ctx) => {
      await ctx.db.insert("approvals", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        scope: "selection",
        snapshotCanonical: "{}",
        snapshotHash: "actions-approval",
        state: "pending",
        approver: OWNER.tokenIdentifier,
        createdAt: 100,
      });
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId, limit: 12 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.candidates[0]?.latestValidQuote?.lines[0]?.unit).toBe("piece");
    expect(result.jobs.some((job) => job.state === "queued" && job.status === "queued" && job.cancellable)).toBe(true);
    expect(result.jobs.some((job) => job.state === "completed" && job.status === "sent" && !job.cancellable)).toBe(true);
    expect(result.decisions.some((decision) => decision.kind === "approval" && decision.state === "requested")).toBe(true);
    expect(result.access.capabilities.canApprove).toBe(true);
    expect(result.access.capabilities.canOpenServiceCase).toBe(true);
    const approval = result.decisions.find((decision) => decision.kind === "approval");
    expect(approval && "scope" in approval ? approval.scope : undefined).toBe("selection");
    expect(approval && "snapshotHash" in approval ? approval.snapshotHash : undefined).toBe("actions-approval");
  });

  test("caps every visible collection under high-volume data and paginates activity", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "volume");
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 80; index += 1) {
        await ctx.db.insert("requirements", {
          organizationId: project.organizationId,
          projectId: project.projectId,
          key: `volume-${index}`,
          title: `Volume requirement ${index}`,
          category: "coffee",
          quantity: "1",
          unit: "piece",
          priority: "P2",
          state: "draft",
          fulfillment: "notOrdered",
          version: 1,
          createdAt: now + index,
          updatedAt: now + index,
        });
        await ctx.db.insert("projectEvents", {
          organizationId: project.organizationId,
          projectId: project.projectId,
          kind: `requirement-${index}`,
          actor: OWNER.tokenIdentifier,
          createdAt: now + index,
        });
      }
    });
    const first = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId, limit: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("projection denied");
    expect(first.requirements.length).toBeLessThanOrEqual(3);
    expect(first.activity.page.length).toBeLessThanOrEqual(3);
    expect(first.requirementsTruncated).toBe(true);
    expect(first.activity.isDone).toBe(false);
    expect(first.activity.continueCursor).toEqual(expect.any(String));
    const second = await t.withIdentity(OWNER).query(
      getProjectionRef,
      first.activity.continueCursor === null
        ? { projectId: project.projectId, limit: 3 }
        : { projectId: project.projectId, limit: 3, cursor: first.activity.continueCursor },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("projection continuation denied");
    expect(second.activity.page[0]?.id).not.toBe(first.activity.page[0]?.id);
  });
});

describe("E1 equipment and service projection", () => {
  async function insertAsset(
    t: ReturnType<typeof convexTest>,
    project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
    suffix: string,
    createdAt: number,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("assets", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        label: `Espresso machine ${suffix}`,
        serial: `serial-${suffix}`,
        constraints: "220V clearance",
        purchaseProvenance: "recorded owner order",
        idempotencyKey: `asset-${suffix}`,
        createdAt,
      }),
    );
  }

  test("returns empty equipment state for a fresh project", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "bare");
    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.equipment.assets).toEqual([]);
    expect(result.equipment.assetsTruncated).toBe(false);
  });

  test("projects installed asset with purchase and warranty documents and open plus resolved cases without leaking storageRef", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "equipment");
    const assetId = await insertAsset(t, project, "e1", 100);
    await t.run(async (ctx) => {
      await ctx.db.insert("assetDocuments", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        assetId,
        kind: "purchase",
        storageRef: "secret-storage-ref-purchase",
        idempotencyKey: "document-purchase",
        createdAt: 110,
      });
      await ctx.db.insert("assetDocuments", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        assetId,
        kind: "warranty",
        storageRef: "secret-storage-ref-warranty",
        idempotencyKey: "document-warranty",
        createdAt: 120,
      });
      await ctx.db.insert("serviceCases", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        assetId,
        urgency: "high",
        summary: "Pressure fault on group head",
        state: "open",
        idempotencyKey: "case-open",
        createdAt: 130,
        updatedAt: 130,
      });
      await ctx.db.insert("serviceCases", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        assetId,
        urgency: "normal",
        summary: "Annual descaling visit",
        state: "resolved",
        outcome: "replaced heating element",
        idempotencyKey: "case-resolved",
        createdAt: 140,
        updatedAt: 150,
      });
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.equipment.assets.length).toBe(1);
    expect(result.equipment.assetsTruncated).toBe(false);
    const asset = result.equipment.assets[0];
    expect(asset?.label).toBe("Espresso machine e1");
    expect(asset?.serial).toBe("serial-e1");
    expect(asset?.constraints).toBe("220V clearance");
    expect(asset?.purchaseProvenance).toBe("recorded owner order");
    expect(asset?.createdAt).toBe(100);
    expect(asset?.documents.map((document) => document.kind)).toEqual(["purchase", "warranty"]);
    expect(asset?.documentsTruncated).toBe(false);
    expect(asset?.serviceCases.map((serviceCase) => serviceCase.state)).toEqual(["open", "resolved"]);
    expect(asset?.serviceCasesTruncated).toBe(false);
    expect(asset?.serviceCases[1]?.outcome).toBe("replaced heating element");
    expect(asset?.serviceCases[0]).not.toHaveProperty("outcome");
    for (const document of asset?.documents ?? []) {
      expect(Object.keys(document).sort()).toEqual(["createdAt", "kind"]);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-storage-ref-purchase");
    expect(serialized).not.toContain("secret-storage-ref-warranty");
    expect(serialized).not.toContain("storageRef");
  });

  test("bounds over-limit equipment with explicit truncation flags in stable order", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "crowded");
    const firstAssetId = await insertAsset(t, project, "asset-0", 1);
    for (let index = 1; index < projection.MAX_EQUIPMENT_ASSETS + 3; index += 1) {
      await insertAsset(t, project, `asset-${index}`, 1 + index);
    }
    await t.run(async (ctx) => {
      for (let index = 0; index < projection.MAX_ASSET_DOCUMENTS + 2; index += 1) {
        await ctx.db.insert("assetDocuments", {
          organizationId: project.organizationId,
          projectId: project.projectId,
          assetId: firstAssetId,
          kind: index % 2 === 0 ? "purchase" : "warranty",
          storageRef: `secret-overflow-ref-${index}`,
          idempotencyKey: `overflow-document-${index}`,
          createdAt: 100 + index,
        });
      }
      for (let index = 0; index < projection.MAX_ASSET_CASES + 1; index += 1) {
        await ctx.db.insert("serviceCases", {
          organizationId: project.organizationId,
          projectId: project.projectId,
          assetId: firstAssetId,
          urgency: "normal",
          summary: `Overflow case ${index}`,
          state: "open",
          idempotencyKey: `overflow-case-${index}`,
          createdAt: 200 + index,
          updatedAt: 200 + index,
        });
      }
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.equipment.assets.length).toBe(projection.MAX_EQUIPMENT_ASSETS);
    expect(result.equipment.assetsTruncated).toBe(true);
    expect(result.equipment.assets[0]?.label).toBe("Espresso machine asset-0");
    expect(result.equipment.assets[0]?.documents.length).toBe(projection.MAX_ASSET_DOCUMENTS);
    expect(result.equipment.assets[0]?.documentsTruncated).toBe(true);
    for (const asset of result.equipment.assets) {
      for (const document of asset.documents) {
        expect(Object.keys(document).sort()).toEqual(["createdAt", "kind"]);
      }
    }
    expect(result.equipment.assets[0]?.serviceCases.length).toBe(projection.MAX_ASSET_CASES);
    expect(result.equipment.assets[0]?.serviceCasesTruncated).toBe(true);
    const repeat = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("projection repeat denied");
    expect(repeat.equipment.assets.map((asset) => asset.id)).toEqual(
      result.equipment.assets.map((asset) => asset.id),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-overflow-ref");
    expect(serialized).not.toContain("storageRef");
  });

  test("denies cross-project equipment reads and never leaks foreign records", async () => {
    const t = convexTest(schema, modules);
    const home = await setupProject(t, OWNER, "home");
    const away = await setupProject(t, OWNER, "away", "restricted");
    await insertAsset(t, away, "foreign", 100);

    const denied = await t.withIdentity(OTHER).query(getProjectionRef, { projectId: away.projectId });
    expect(denied).toEqual({ ok: false, code: "denied-membership", message: "not authorized for this project" });

    const isolated = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: home.projectId });
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) throw new Error("projection denied");
    expect(isolated.equipment.assets).toEqual([]);
    expect(isolated.equipment.assetsTruncated).toBe(false);
  });

  test("never invents installed assets from selection or order state", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "selected");
    const graph = await setupCandidate(t, project, "no-asset");
    const quoteId = await insertOwnerQuote(t, project, graph, "v1", "hash-no-asset-1", undefined, 100);
    await t.run(async (ctx) => {
      const selectionId = await ctx.db.insert("selections", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        idempotencyKey: "selection-no-asset",
        requirementId: graph.requirementId,
        candidateId: graph.candidateId,
        quoteId,
        quoteVersion: "v1",
        selectionLines: [{ quoteLineId: "machine", quantity: "1", unit: "piece" }],
        requirementVersion: 1,
        actor: OWNER.tokenIdentifier,
        createdAt: 200,
      });
      await ctx.db.insert("orders", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        selectionId,
        requirementId: graph.requirementId,
        quoteId,
        quoteVersion: "v1",
        requirementVersion: 1,
        idempotencyKey: "order-no-asset",
        orderLines: [{ quoteLineId: "machine", quantity: "1", unit: "piece" }],
        state: "recorded",
        amendmentCount: 0,
        createdAt: 300,
        updatedAt: 300,
      });
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.equipment.assets).toEqual([]);
    expect(result.equipment.assetsTruncated).toBe(false);
  });
});

type QuoteLineRow = SchemaDoc["quotes"]["lines"][number];
type QuoteChargeRow = SchemaDoc["quotes"]["charges"][number];
type QuoteTaxBasisRow = SchemaDoc["quotes"]["taxBasis"];
type QuoteScopeRow = NonNullable<SchemaDoc["quotes"]["comparisonScope"]>;

async function insertQuote(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  graph: { requirementId: Id<"requirements">; vendorId: Id<"vendors"> },
  options: {
    readonly version: string;
    readonly contentHash: string;
    readonly supersedes?: string;
    readonly createdAt: number;
    readonly organizationId?: Id<"organizations">;
    readonly lines?: readonly QuoteLineRow[];
    readonly charges?: readonly QuoteChargeRow[];
    readonly taxBasis?: QuoteTaxBasisRow;
    readonly comparisonScope?: QuoteScopeRow;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("quotes", {
      organizationId: options.organizationId ?? project.organizationId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      version: options.version,
      contentHash: options.contentHash,
      currency: "EUR",
      lines: [...(options.lines ?? [{
        lineId: "machine",
        description: "Machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 750000 },
        evidenceRefs: [],
      }])],
      charges: [...(options.charges ?? [])],
      taxBasis: options.taxBasis ?? { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
      evidenceRefs: [],
      counterpartyRole: "vendor",
      executionMode: "recorded",
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
      ...(options.comparisonScope === undefined ? {} : { comparisonScope: options.comparisonScope }),
      createdAt: options.createdAt,
    }),
  );
}

describe("E4 quote currentness and authoritative comparable total", () => {
  const itemizedCharges = [
    { chargeId: "freight", label: "Freight", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 60000 } }, evidenceRefs: [] },
    { chargeId: "installation", label: "Installation", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 40000 } }, evidenceRefs: [] },
  ] as const;
  const machineScope = { requirementId: "", scopeId: "scope-e4", items: [{ itemId: "item-e4", lineId: "machine", unit: "piece", requiredQuantity: "1" }] };

  test("projects an exact total always and a comparable total only with an accepted comparison scope", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-total");
    const included = await setupCandidate(t, project, "included-a");
    const itemized = await setupCandidate(t, project, "itemized-b");
    const unscooped = await setupCandidate(t, project, "unscooped-c");
    await insertQuote(t, project, included, {
      version: "v1",
      contentHash: "e4-hash-a",
      createdAt: 100,
      lines: [{
        lineId: "machine",
        description: "Machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      }],
      charges: [{
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "included", coveringId: "machine" },
        evidenceRefs: [],
      }],
      comparisonScope: { ...machineScope, requirementId: included.requirementId },
    });
    await insertQuote(t, project, itemized, {
      version: "v1",
      contentHash: "e4-hash-b",
      createdAt: 110,
      charges: [...itemizedCharges],
      comparisonScope: { ...machineScope, requirementId: itemized.requirementId },
    });
    await insertQuote(t, project, unscooped, {
      version: "v1",
      contentHash: "e4-hash-c",
      createdAt: 120,
      charges: [...itemizedCharges],
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    const quoteIncluded = result.candidates.find((candidate) => candidate.id === included.candidateId)?.latestValidQuote;
    const quoteItemized = result.candidates.find((candidate) => candidate.id === itemized.candidateId)?.latestValidQuote;
    const quoteUnscooped = result.candidates.find((candidate) => candidate.id === unscooped.candidateId)?.latestValidQuote;
    expect(quoteIncluded?.currentness).toBe("current");
    expect(quoteIncluded?.superseded).toBe(false);
    expect(quoteIncluded?.totalMinorUnits).toBe(795000);
    expect(quoteIncluded?.comparableTotalMinorUnits).toBe(795000);
    expect(quoteItemized?.totalMinorUnits).toBe(850000);
    expect(quoteItemized?.comparableTotalMinorUnits).toBe(850000);
    expect(quoteItemized?.currency).toBe("EUR");
    // A complete quote without a recorded comparison scope keeps its own
    // exact total but is never presented as comparable.
    expect(quoteUnscooped?.totalMinorUnits).toBe(850000);
    expect(quoteUnscooped?.comparableTotalMinorUnits).toBeNull();
    expect(result.access.capabilities.canApprove).toBe(true);
  });

  test("estimated, unknown, unresolved-included, and malformed money never produce a total", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-closed");
    const unknownCandidate = await setupCandidate(t, project, "unknown");
    const estimatedCandidate = await setupCandidate(t, project, "estimated");
    const danglingCandidate = await setupCandidate(t, project, "dangling");
    const malformedCandidate = await setupCandidate(t, project, "malformed");
    await insertQuote(t, project, unknownCandidate, {
      version: "v1",
      contentHash: "e4-hash-unknown",
      createdAt: 100,
      charges: [{
        chargeId: "freight",
        label: "Freight",
        scope: { kind: "quote" },
        state: { kind: "unknown", reason: "not confirmed" },
        evidenceRefs: [],
      }],
    });
    await insertQuote(t, project, estimatedCandidate, {
      version: "v1",
      contentHash: "e4-hash-estimated",
      createdAt: 101,
      charges: [{
        chargeId: "installation",
        label: "Installation",
        scope: { kind: "quote" },
        state: { kind: "estimated", estimate: { kind: "point", amount: { currency: "EUR", minorUnits: 50000 } } },
        evidenceRefs: [],
      }],
    });
    await insertQuote(t, project, danglingCandidate, {
      version: "v1",
      contentHash: "e4-hash-dangling",
      createdAt: 102,
      charges: [{
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "included", coveringId: "ghost-line" },
        evidenceRefs: [],
      }],
    });
    await insertQuote(t, project, malformedCandidate, {
      version: "v1",
      contentHash: "e4-hash-malformed",
      createdAt: 103,
      lines: [{
        lineId: "machine",
        description: "Machine",
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 750000.5 },
        evidenceRefs: [],
      }],
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    const unknownQuote = result.candidates.find((candidate) => candidate.id === unknownCandidate.candidateId)?.latestValidQuote;
    const estimatedQuote = result.candidates.find((candidate) => candidate.id === estimatedCandidate.candidateId)?.latestValidQuote;
    const danglingQuote = result.candidates.find((candidate) => candidate.id === danglingCandidate.candidateId)?.latestValidQuote;
    const malformedQuote = result.candidates.find((candidate) => candidate.id === malformedCandidate.candidateId)?.latestValidQuote;
    expect(unknownQuote?.comparableTotalMinorUnits).toBeNull();
    expect(unknownQuote?.totalMinorUnits).toBeNull();
    expect(estimatedQuote?.comparableTotalMinorUnits).toBeNull();
    expect(estimatedQuote?.totalMinorUnits).toBeNull();
    // Unresolved included coverage is rendered with its state but fails
    // closed on the total, so selection can never be enabled.
    expect(danglingQuote?.comparableTotalMinorUnits).toBeNull();
    expect(danglingQuote?.totalMinorUnits).toBeNull();
    expect(danglingQuote?.charges[0]?.state.kind).toBe("included");
    // Malformed money cannot render a quote at all.
    expect(malformedQuote).toBeNull();
  });

  test("ambiguous current roots and quote-scan truncation never enable selection", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-ambiguous");
    const ambiguous = await setupCandidate(t, project, "ambiguous");
    const truncated = await setupCandidate(t, project, "truncated");
    await insertQuote(t, project, ambiguous, { version: "v1", contentHash: "e4-amb-1", createdAt: 100 });
    await insertQuote(t, project, ambiguous, { version: "v2", contentHash: "e4-amb-2", createdAt: 200 });
    for (let index = 0; index < projection.MAX_QUOTE_SCAN + 1; index += 1) {
      await insertQuote(t, project, truncated, {
        version: `v${index}`,
        contentHash: `e4-trunc-${index}`,
        createdAt: 300 + index,
      });
    }

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    expect(result.candidates.find((candidate) => candidate.id === ambiguous.candidateId)?.latestValidQuote).toBeNull();
    expect(result.candidates.find((candidate) => candidate.id === truncated.candidateId)?.latestValidQuote).toBeNull();
  });

  test("successor presence keeps only the proven current revision with explicit currentness", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-supersede");
    const graph = await setupCandidate(t, project, "chain");
    await insertQuote(t, project, graph, { version: "v1", contentHash: "e4-chain-1", createdAt: 100 });
    await insertQuote(t, project, graph, {
      version: "v2",
      contentHash: "e4-chain-2",
      supersedes: "e4-chain-1",
      createdAt: 200,
      comparisonScope: { ...machineScope, requirementId: graph.requirementId },
    });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    const quote = result.candidates[0]?.latestValidQuote;
    expect(quote?.version).toBe("v2");
    expect(quote?.currentness).toBe("current");
    expect(quote?.superseded).toBe(false);
    expect(quote?.totalMinorUnits).toBe(750000);
    expect(quote?.comparableTotalMinorUnits).toBe(750000);
  });

  test("cross-organization rows in the same index range are excluded and never enable selection", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-tenant");
    const away = await setupProject(t, OWNER, "e4-tenant-away", "restricted");
    const graph = await setupCandidate(t, project, "tenant");
    await insertQuote(t, project, graph, {
      version: "foreign",
      contentHash: "e4-foreign-hash",
      createdAt: 90,
      organizationId: away.organizationId,
    });
    await insertQuote(t, project, graph, { version: "local", contentHash: "e4-local-hash", createdAt: 100, comparisonScope: { ...machineScope, requirementId: graph.requirementId } });

    const result = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("projection denied");
    const quote = result.candidates[0]?.latestValidQuote;
    expect(quote?.version).toBe("local");
    expect(quote?.superseded).toBe(false);
    expect(quote?.comparableTotalMinorUnits).toBe(750000);
  });

  test("projects canApprove only for approver-or-stronger roles and never invents order aggregates", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "e4-authority");
    const viewerIdentity = "workbench-e4-viewer";
    const asOwner = t.withIdentity(OWNER);
    const grant = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      targetIdentity: viewerIdentity,
      role: "viewer",
    });
    if (!grant.ok) throw new Error(`viewer grant setup failed: ${JSON.stringify(grant)}`);

    const ownerView = await t.withIdentity(OWNER).query(getProjectionRef, { projectId: project.projectId });
    expect(ownerView.ok).toBe(true);
    if (!ownerView.ok) throw new Error("owner projection denied");
    expect(ownerView.access.capabilities.canApprove).toBe(true);

    const viewerView = await t.withIdentity({ tokenIdentifier: viewerIdentity }).query(getProjectionRef, { projectId: project.projectId });
    expect(viewerView.ok).toBe(true);
    if (!viewerView.ok) throw new Error("viewer projection denied");
    expect(viewerView.access.capabilities.canApprove).toBe(false);

    const serialized = JSON.stringify(ownerView);
    expect(serialized).not.toContain('"committed"');
    expect(serialized).not.toContain('"paid"');
    expect(Object.prototype.hasOwnProperty.call(ownerView, "committedMinorUnits")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ownerView, "paidMinorUnits")).toBe(false);
  });
});

describe("W1 scheduled membership expiry", () => {
  test("expiry transition denies project list and projection while stronger authority remains", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "expiry");
    const asOwner = t.withIdentity(OWNER);
    const grant = { organizationId: project.organizationId, projectId: project.projectId };
    const solo = "workbench-expiry-solo";
    const dual = "workbench-expiry-dual";
    const expiresAt = Date.now() + 200;

    const soloTemp = await asOwner.mutation(grantProjectAccessRef, {
      ...grant,
      targetIdentity: solo,
      role: "viewer",
      expiresAt,
    });
    if (!soloTemp.ok) throw new Error(`solo grant setup failed: ${JSON.stringify(soloTemp)}`);
    const dualPermanent = await asOwner.mutation(grantProjectAccessRef, {
      ...grant,
      targetIdentity: dual,
      role: "approver",
    });
    if (!dualPermanent.ok) throw new Error(`dual permanent setup failed: ${JSON.stringify(dualPermanent)}`);
    const dualTemp = await asOwner.mutation(grantProjectAccessRef, {
      ...grant,
      targetIdentity: dual,
      role: "viewer",
      expiresAt,
    });
    if (!dualTemp.ok) throw new Error(`dual temporary setup failed: ${JSON.stringify(dualTemp)}`);

    const soloListBefore = await t.withIdentity({ tokenIdentifier: solo }).query(listProjectsRef, { limit: 10 });
    expect(soloListBefore.ok).toBe(true);
    if (!soloListBefore.ok) throw new Error("solo list denied before expiry");
    expect(soloListBefore.projects.map((item) => item.id)).toContain(project.projectId);
    const soloProjectionBefore = await t.withIdentity({ tokenIdentifier: solo }).query(getProjectionRef, {
      projectId: project.projectId,
      limit: 1,
    });
    expect(soloProjectionBefore.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await t.finishInProgressScheduledFunctions();

    // The transition removes exactly the expired authorities.
    const remaining = await t.run(async (ctx) => {
      const countFor = async (membershipId: Id<"memberships">) =>
        (
          await ctx.db
            .query("membershipAuthorities")
            .withIndex("by_membership", (q) => q.eq("membershipId", membershipId))
            .take(2)
        ).length;
      return {
        solo: await countFor(soloTemp.membershipId),
        dualTemp: await countFor(dualTemp.membershipId),
        dualPermanent: await countFor(dualPermanent.membershipId),
      };
    });
    expect(remaining).toEqual({ solo: 0, dualTemp: 0, dualPermanent: 1 });

    // The temporary-only identity loses both surfaces.
    const soloListAfter = await t.withIdentity({ tokenIdentifier: solo }).query(listProjectsRef, { limit: 10 });
    expect(soloListAfter.ok).toBe(true);
    if (!soloListAfter.ok) throw new Error("solo list denied after expiry");
    expect(soloListAfter.projects.map((item) => item.id)).not.toContain(project.projectId);
    const soloProjectionAfter = await t.withIdentity({ tokenIdentifier: solo }).query(getProjectionRef, {
      projectId: project.projectId,
      limit: 1,
    });
    expect(soloProjectionAfter).toEqual({
      ok: false,
      code: "denied-membership",
      message: "not authorized for this project",
    });

    // The dual identity keeps both surfaces through its independent
    // permanent approver grant.
    const dualListAfter = await t.withIdentity({ tokenIdentifier: dual }).query(listProjectsRef, { limit: 10 });
    expect(dualListAfter.ok).toBe(true);
    if (!dualListAfter.ok) throw new Error("dual list denied after expiry");
    expect(dualListAfter.projects.map((item) => item.id)).toContain(project.projectId);
    const dualProjectionAfter = await t.withIdentity({ tokenIdentifier: dual }).query(getProjectionRef, {
      projectId: project.projectId,
      limit: 1,
    });
    expect(dualProjectionAfter.ok).toBe(true);
    if (!dualProjectionAfter.ok) throw new Error("dual projection denied after expiry");
    expect(dualProjectionAfter.access.role).toBe("approver");

    // Repeated expiry on the revoked row stays a safe no-op.
    expect(await t.mutation(expireMembershipRef, { membershipId: soloTemp.membershipId })).toEqual({
      ok: true,
      expired: false,
    });
  });
});
