/// <reference types="vite/client" />
/**
 * E2 requirement revision and procurement-readiness contract tests.
 *
 * These tests execute the exported Convex handlers against convex-test's
 * in-memory database. They use controlled rows only, never provider calls,
 * supplier prices, or external evidence.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as requirements from "./requirements.js";
import * as sourcing from "./sourcing.js";
import * as decisions from "./decisions.js";
import * as fulfillment from "./fulfillment.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "./**/*.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../purchasing/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!./**/*.test.ts",
]);

const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./")
    ? `domain/${path.slice(2)}`
    : path.replace(/^(\.\.\/)+/, "");
  modules[relative] = loader as () => Promise<unknown>;
}

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
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
const updateRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.update>,
  MutationReturn<typeof requirements.update>
>("domain/requirements:update");
const getReadinessRef = makeFunctionReference<
  "query",
  QueryArgs<typeof requirements.getReadiness>,
  QueryReturn<typeof requirements.getReadiness>
>("domain/requirements:getReadiness");
const addDependencyRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.addDependency>,
  MutationReturn<typeof requirements.addDependency>
>("domain/requirements:addDependency");
const verifyDependencyRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.verifyDependency>,
  MutationReturn<typeof requirements.verifyDependency>
>("domain/requirements:verifyDependency");
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
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const recordSelectionRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.recordSelection>,
  MutationReturn<typeof decisions.recordSelection>
>("domain/decisions:recordSelection");
const recordApprovalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.recordApproval>,
  MutationReturn<typeof decisions.recordApproval>
>("domain/decisions:recordApproval");
const decideApprovalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.decideApproval>,
  MutationReturn<typeof decisions.decideApproval>
>("domain/decisions:decideApproval");
const recordOrderRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordOrder>,
  MutationReturn<typeof fulfillment.recordOrder>
>("domain/fulfillment:recordOrder");
const appendOrderEventRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.appendOrderEvent>,
  MutationReturn<typeof fulfillment.appendOrderEvent>
>("domain/fulfillment:appendOrderEvent");

const OWNER = { tokenIdentifier: "e2-requirement-owner" };
const VIEWER = { tokenIdentifier: "e2-requirement-viewer" };
const OTHER = { tokenIdentifier: "e2-requirement-other" };

async function setupProject(
  t: ReturnType<typeof convexTest>,
  owner: { tokenIdentifier: string } = OWNER,
  name = "e2",
) {
  const asOwner = t.withIdentity(owner);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: `${name} organization`,
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!project.ok) throw new Error("project setup failed");
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

function requirementArgs(
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  key: string,
  extra: Record<string, unknown> = {},
) {
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    key,
    title: `Requirement ${key}`,
    category: "equipment",
    quantity: "1",
    unit: "piece",
    priority: "P1" as const,
    ...extra,
  };
}

async function createRequirement(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  key: string,
  extra: Record<string, unknown> = {},
) {
  const result = await t.withIdentity(OWNER).mutation(
    createRequirementRef,
    requirementArgs(project, key, extra),
  );
  if (!result.ok) throw new Error(`requirement setup failed: ${JSON.stringify(result)}`);
  return result.requirementId;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function acceptRequirement(
  t: ReturnType<typeof convexTest>,
  project: { organizationId: Id<"organizations">; projectId: Id<"projects"> },
  requirementId: Id<"requirements">,
  key: string,
  acceptedQuantity = "1",
) {
  const asOwner = t.withIdentity(OWNER);
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.organizationId,
    name: `Controlled supplier ${key}`,
    regions: ["NL"],
  });
  if (!vendor.ok) throw new Error(`vendor setup failed for ${key}`);
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    requirementId,
    vendorId: vendor.vendorId,
    productModel: `Model ${key}`,
    variant: "220V",
    conversationState: "draft",
  });
  if (!candidate.ok) throw new Error(`candidate setup failed for ${key}`);
  const quote = await asOwner.mutation(recordQuoteRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    version: `quote-${key}`,
    currency: "EUR",
    lines: [{
      lineId: `line-${key}`,
      description: `Item ${key}`,
      quantity: acceptedQuantity,
      unitPrice: { currency: "EUR", minorUnits: 1_000 },
      evidenceRefs: [],
    }],
    charges: [],
    taxBasis: { kind: "inclusive", basisId: `controlled-${key}`, evidenceRefs: [] },
    comparisonScope: {
      requirementId: key,
      scopeId: `scope-${key}`,
      items: [{
        itemId: `item-${key}`,
        lineId: `line-${key}`,
        unit: "piece",
        requiredQuantity: acceptedQuantity,
      }],
    },
    evidenceRefs: [],
    requirementId,
    vendorId: vendor.vendorId,
  });
  if (!quote.ok) throw new Error(`quote setup failed for ${key}`);
  const selection = await asOwner.mutation(recordSelectionRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    requirementId,
    candidateId: candidate.candidateId,
    quoteId: quote.quoteId,
    quoteVersion: `quote-${key}`,
    selectionLines: [{ quoteLineId: `line-${key}`, quantity: acceptedQuantity, unit: "piece" }],
    idempotencyKey: `selection-${key}`,
    requirementVersion: 1,
  });
  if (!selection.ok) throw new Error(`selection setup failed for ${key}`);
  const order = await asOwner.mutation(recordOrderRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    selectionId: selection.selectionId,
    idempotencyKey: `order-${key}`,
    orderLines: [{ quoteLineId: `line-${key}`, quantity: acceptedQuantity, unit: "piece" }],
  });
  if (!order.ok) throw new Error(`order setup failed for ${key}`);
  const accepted = await asOwner.mutation(appendOrderEventRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    orderId: order.orderId,
    kind: "acceptance",
    acceptanceLines: [{
      quoteLineId: `line-${key}`,
      acceptedQuantity,
      unit: "piece",
    }],
    idempotencyKey: `acceptance-${key}`,
  });
  if (!accepted.ok) throw new Error(`acceptance setup failed for ${key}`);
}

describe("E2 requirement revisions", () => {
  test("viewer and cross-project calls are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "auth");
    const second = await t.withIdentity(OWNER).mutation(createProjectRef, {
      organizationId: project.organizationId,
      name: "second project",
      visibility: "open",
    });
    if (!second.ok) throw new Error("second project setup failed");
    const requirementId = await createRequirement(t, project, "auth-req");
    const grant = await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      targetIdentity: VIEWER.tokenIdentifier,
      role: "viewer",
    });
    expect(grant.ok).toBe(true);
    const viewerDenied = await t.withIdentity(VIEWER).mutation(updateRequirementRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      expectedVersion: 1,
      idempotencyKey: "viewer-edit",
      title: "Not allowed",
    });
    expect(viewerDenied).toMatchObject({ ok: false, code: "denied-capability" });
    const crossProjectDenied = await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      organizationId: project.organizationId,
      projectId: second.projectId,
      requirementId,
      expectedVersion: 1,
      idempotencyKey: "cross-project-edit",
      title: "Not allowed",
    });
    expect(crossProjectDenied).toMatchObject({ ok: false, code: "denied-project" });
  });

  test("normalizes bounded fields, keeps the key immutable, and records one before/after revision event", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "normalize");
    const overlong = await t.withIdentity(OWNER).mutation(createRequirementRef, requirementArgs(project, "overlong", {
      title: "x".repeat(257),
    }));
    expect(overlong).toMatchObject({ ok: false, code: "invalid-payload" });
    const missingBudgetCurrency = await t.withIdentity(OWNER).mutation(createRequirementRef, requirementArgs(project, "missing-budget-currency", {
      budgetMinorUnits: 100,
    }));
    expect(missingBudgetCurrency).toMatchObject({ ok: false, code: "invalid-payload" });
    const requirementId = await createRequirement(t, project, "  espresso-key  ", {
      title: "  Espresso machine  ",
      category: "  coffee  ",
      quantity: "2.50",
      unit: "  piece ",
      priority: "P0",
      currency: "EUR",
      budgetMinorUnits: 795000,
      needByAt: 1_760_000_000_000,
      hardConstraints: "  220V only  ",
      responsible: "  owner  ",
      requiredMilestone: "commissioned",
    });
    const before = await t.run((ctx) => ctx.db.get(requirementId));
    expect(before?.key).toBe("espresso-key");
    expect(before?.quantity).toBe("2.5");
    expect(before?.hardConstraints).toBe("220V only");
    const edited = await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      expectedVersion: 1,
      idempotencyKey: "normalize-edit-1",
      title: "  New title  ",
      quantity: "3.0",
      responsible: "  buyer  ",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("edit failed");
    const after = await t.run((ctx) => ctx.db.get(requirementId));
    expect(after?.key).toBe("espresso-key");
    expect(after?.title).toBe("New title");
    expect(after?.quantity).toBe("3");
    expect(after?.responsible).toBe("buyer");
    expect(after?.version).toBe(2);
    const revisions = await t.run((ctx) => ctx.db.query("requirementRevisions").collect());
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0]!.before).version).toBe(1);
    expect(JSON.parse(revisions[0]!.after).version).toBe(2);
    const events = await t.run((ctx) => ctx.db.query("projectEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("requirement.revised");
  });

  test("exact idempotent replay returns the prior revision, changed reuse conflicts, and concurrent versions have one winner", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "replay");
    const requirementId = await createRequirement(t, project, "replay-req");
    const command = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      expectedVersion: 1,
      idempotencyKey: "replay-edit-1",
      title: "Updated",
    };
    const first = await t.withIdentity(OWNER).mutation(updateRequirementRef, command);
    if (!first.ok) throw new Error("first edit failed");
    const replay = await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      ...command,
      title: "  Updated  ",
    });
    expect(replay).toMatchObject({ ok: true, revisionId: first.revisionId, deduplicated: true, version: 2 });
    const conflict = await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      ...command,
      title: "Different",
    });
    expect(conflict).toMatchObject({ ok: false, code: "duplicate-conflict" });

    const concurrentRequirementId = await createRequirement(t, project, "race-req");
    const [left, right] = await Promise.all([
      t.withIdentity(OWNER).mutation(updateRequirementRef, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        requirementId: concurrentRequirementId,
        expectedVersion: 1,
        idempotencyKey: "race-left",
        title: "Left",
      }),
      t.withIdentity(OWNER).mutation(updateRequirementRef, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        requirementId: concurrentRequirementId,
        expectedVersion: 1,
        idempotencyKey: "race-right",
        title: "Right",
      }),
    ]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok && result.code === "invalid-payload")).toHaveLength(1);
    const raced = await t.run((ctx) => ctx.db.get(concurrentRequirementId));
    expect(raced?.version).toBe(2);
    const raceRevisions = await t.run((ctx) =>
      ctx.db.query("requirementRevisions").withIndex("by_requirement", (q) => q.eq("requirementId", concurrentRequirementId)).collect(),
    );
    expect(raceRevisions).toHaveLength(1);
  });

  test("requirement version changes leave compatibility pinned to the old version and fence pending approval", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "stale");
    const requirementId = await createRequirement(t, project, "stale-req");
    const vendor = await t.withIdentity(OWNER).mutation(recordVendorRef, {
      organizationId: project.organizationId,
      name: "Controlled supplier",
      regions: ["NL"],
    });
    if (!vendor.ok) throw new Error("vendor setup failed");
    const candidate = await t.withIdentity(OWNER).mutation(recordCandidateRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      vendorId: vendor.vendorId,
      productModel: "Machine",
      variant: "220V",
      conversationState: "draft",
    });
    if (!candidate.ok) throw new Error("candidate setup failed");
    const quote = await t.withIdentity(OWNER).mutation(recordQuoteRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      version: "quote-stale-1",
      currency: "EUR",
      lines: [{ lineId: "machine", description: "Machine", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 1000 }, evidenceRefs: [] }],
      charges: [],
      taxBasis: { kind: "inclusive", basisId: "controlled", evidenceRefs: [] },
      comparisonScope: { requirementId: "stale-req", scopeId: "scope", items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }] },
      evidenceRefs: [],
      requirementId,
      vendorId: vendor.vendorId,
    });
    if (!quote.ok) throw new Error("quote setup failed");
    const selection = await t.withIdentity(OWNER).mutation(recordSelectionRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      candidateId: candidate.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "quote-stale-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "stale-selection",
    });
    if (!selection.ok) throw new Error("selection setup failed");
    const snapshotCanonical = "{\"requirementVersion\":1,\"quoteVersion\":\"quote-stale-1\"}";
    const approval = await t.withIdentity(OWNER).mutation(recordApprovalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      scope: "selection",
      snapshotCanonical,
      snapshotHash: await sha256Hex(snapshotCanonical),
      selectionId: selection.selectionId,
      quoteId: quote.quoteId,
    });
    if (!approval.ok) throw new Error("approval setup failed");
    const seededCandidate = await t.run((ctx) => ctx.db.get(candidate.candidateId));
    await t.run(async (ctx) => {
      await ctx.db.patch(candidate.candidateId, {
        compatibility: "pass",
        compatibilityRequirementVersion: 1,
        compatibilityRuleVersion: "1",
        compatibilityEvidenceIndexComplete: true,
      });
    });
    const edited = await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      expectedVersion: 1,
      idempotencyKey: "stale-requirement-edit",
      quantity: "2",
    });
    expect(edited.ok).toBe(true);
    const currentCandidate = await t.run((ctx) => ctx.db.get(candidate.candidateId));
    expect(seededCandidate?.compatibilityRequirementVersion).toBeUndefined();
    expect(currentCandidate?.compatibility).toBe("pass");
    expect(currentCandidate?.compatibilityRequirementVersion).toBe(1);
    const decided = await t.withIdentity(OWNER).mutation(decideApprovalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decided).toMatchObject({ ok: false, code: "stale-approval-basis" });
    const storedApproval = await t.run((ctx) => ctx.db.get(approval.approvalId));
    expect(storedApproval?.state).toBe("pending");
    const storedSelection = await t.run((ctx) => ctx.db.get(selection.selectionId));
    expect(storedSelection?.requirementVersion).toBe(1);
  });
});

describe("E2 procurement readiness", () => {
  test("empty scope is explicitly not assessed", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "empty");
    const result = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result).toMatchObject({ ok: true, assessed: false, status: "notAssessed", readinessPercent: null, numerator: 0, denominator: 0 });
  });

  test("weights present priority groups, reports numerator/denominator, and keeps unresolved P0 visible", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "weighted");
    const p0 = await createRequirement(t, project, "p0", { priority: "P0", requiredMilestone: "delivered" });
    const p1 = await createRequirement(t, project, "p1", { priority: "P1", requiredMilestone: "delivered" });
    const p2 = await createRequirement(t, project, "p2", { priority: "P2", requiredMilestone: "delivered" });
    await acceptRequirement(t, project, p1, "weighted-p1");
    await acceptRequirement(t, project, p2, "weighted-p2");
    const result = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    if (!result.ok) throw new Error("readiness query denied");
    expect(result.status).toBe("notReady");
    expect(result.unresolvedP0Count).toBe(1);
    expect(result.denominator).toBe(100);
    expect(result.numerator).toBeCloseTo(40, 8);
    expect(result.readinessPercent).toBeCloseTo(40, 8);
    expect(result.requirements.find((item) => item.id === p0)?.ready).toBe(false);
  });

  test("partial accepted quantity is not ready until the required milestone and quantity are complete", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "partial");
    const requirementId = await createRequirement(t, project, "partial-req", {
      quantity: "2",
      priority: "P0",
      requiredMilestone: "commissioned",
    });
    const vendor = await t.withIdentity(OWNER).mutation(recordVendorRef, {
      organizationId: project.organizationId,
      name: "Controlled supplier",
      regions: ["NL"],
    });
    if (!vendor.ok) throw new Error("vendor setup failed");
    const candidate = await t.withIdentity(OWNER).mutation(recordCandidateRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      vendorId: vendor.vendorId,
      productModel: "Machine",
      variant: "220V",
      conversationState: "draft",
    });
    if (!candidate.ok) throw new Error("candidate setup failed");
    const quote = await t.withIdentity(OWNER).mutation(recordQuoteRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      version: "quote-partial-1",
      currency: "EUR",
      lines: [{ lineId: "machine", description: "Machine", quantity: "2", unitPrice: { currency: "EUR", minorUnits: 1000 }, evidenceRefs: [] }],
      charges: [],
      taxBasis: { kind: "inclusive", basisId: "controlled", evidenceRefs: [] },
      comparisonScope: { requirementId: "partial-req", scopeId: "scope", items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "2" }] },
      evidenceRefs: [],
      requirementId,
      vendorId: vendor.vendorId,
    });
    if (!quote.ok) throw new Error("quote setup failed");
    const selection = await t.withIdentity(OWNER).mutation(recordSelectionRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      candidateId: candidate.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "quote-partial-1",
      selectionLines: [{ quoteLineId: "machine", quantity: "2", unit: "piece" }],
      idempotencyKey: "partial-selection",
      requirementVersion: 1,
    });
    if (!selection.ok) throw new Error("selection setup failed");
    const order = await t.withIdentity(OWNER).mutation(recordOrderRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "partial-order",
      orderLines: [{ quoteLineId: "machine", quantity: "2", unit: "piece" }],
    });
    if (!order.ok) throw new Error("order setup failed");
    const first = await t.withIdentity(OWNER).mutation(appendOrderEventRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "partialDelivery",
      acceptanceLines: [{ quoteLineId: "machine", acceptedQuantity: "1", unit: "piece" }],
      idempotencyKey: "partial-event-1",
    });
    expect(first.ok).toBe(true);
    const partial = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    if (!partial.ok) throw new Error("partial readiness query denied");
    expect(partial.status).toBe("notReady");
    expect(partial.requirements[0]?.fulfilledQuantity).toBe("1");
    const second = await t.withIdentity(OWNER).mutation(appendOrderEventRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "machine", acceptedQuantity: "1", unit: "piece" }],
      idempotencyKey: "partial-event-2",
    });
    expect(second.ok).toBe(true);
    const commissioned = await t.withIdentity(OWNER).mutation(appendOrderEventRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "commissioning",
      idempotencyKey: "partial-event-3",
    });
    expect(commissioned.ok).toBe(true);
    const complete = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    if (!complete.ok) throw new Error("complete readiness query denied");
    expect(complete.status).toBe("ready");
    expect(complete.requirements[0]?.fulfilledQuantity).toBe("2");
  });

  test("pending dependencies block readiness and verified dependencies clear the blocker with immutable history", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "dependency");
    const target = await createRequirement(t, project, "target", { priority: "P0", requiredMilestone: "delivered" });
    const prerequisite = await createRequirement(t, project, "prerequisite", { priority: "P1", requiredMilestone: "delivered" });
    await acceptRequirement(t, project, target, "dependency-target");
    await acceptRequirement(t, project, prerequisite, "dependency-prerequisite");
    const dependency = await t.withIdentity(OWNER).mutation(addDependencyRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      fromRequirementId: target,
      toRequirementId: prerequisite,
      kind: "technical",
    });
    if (!dependency.ok) throw new Error("dependency setup failed");
    const blocked = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    if (!blocked.ok) throw new Error("blocked readiness query denied");
    expect(blocked.status).toBe("notReady");
    expect(blocked.requirements.find((item) => item.id === target)?.dependencyBlocked).toBe(true);
    const verified = await t.withIdentity(OWNER).mutation(verifyDependencyRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      dependencyId: dependency.dependencyId,
      verification: "verified",
      evidenceRefs: [{ sourceId: "controlled-evidence", version: "1" }],
    });
    expect(verified.ok).toBe(true);
    const clear = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    if (!clear.ok) throw new Error("verified readiness query denied");
    expect(clear.status).toBe("ready");
    const history = await t.run((ctx) => ctx.db.query("dependencyRevisions").collect());
    expect(history).toHaveLength(1);
    expect(history[0]?.beforeVerification).toBe("pending");
    expect(history[0]?.afterVerification).toBe("verified");
  });

  test("readiness reports explicit incompleteness when scope exceeds its bound", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER, "scale");
    await t.run(async (ctx) => {
      for (let index = 0; index <= requirements.READINESS_REQUIREMENT_BOUND; index += 1) {
        await ctx.db.insert("requirements", {
          organizationId: project.organizationId,
          projectId: project.projectId,
          key: `scale-${index}`,
          title: `Scale ${index}`,
          category: "equipment",
          quantity: "1",
          unit: "piece",
          priority: "P2",
          state: "draft",
          fulfillment: "notOrdered",
          version: 1,
          requiredMilestone: "delivered",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const result = await t.withIdentity(OWNER).query(getReadinessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result).toMatchObject({ ok: true, assessed: false, status: "incomplete", readinessPercent: null });
    if (result.ok && result.status === "incomplete") expect(result.incompleteReason).toContain("bound");
  });
});
