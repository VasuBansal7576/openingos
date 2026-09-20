/// <reference types="vite/client" />
/**
 * F1 shared-domain direct handler tests (controlled, PRD section 30).
 *
 * These tests run the ACTUAL exported domain handlers against the REAL
 * extended schema with authenticated identities via official convex-test:
 * no mocks, no source-text assertions. Proofs below come from handler
 * execution: every named core record resolves through its required
 * compound index, cross-project references are rejected where handlers
 * resolve them, dependency cycles are refused, exact variant identity
 * holds, immutable versions and idempotency keys behave, ownerStandIn
 * provenance is preserved and server-derived, and template reuse copies
 * requirements/constraints without historical orders or payments.
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
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as locations from "./locations.js";
import * as requirements from "./requirements.js";
import * as sourcing from "./sourcing.js";
import * as decisions from "./decisions.js";
import * as fulfillment from "./fulfillment.js";
import * as workspace from "./workspace.js";

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

/**
 * convex-test derives its module root from the `_generated` key and
 * resolves every function relative to the convex/ directory, while Vite
 * emits glob keys relative to this file. Remap `./` (domain) and `../`
 * (convex root) prefixes to convex-root-relative keys so both resolve.
 */
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
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const createLocationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof locations.create>,
  MutationReturn<typeof locations.create>
>("domain/locations:create");
const getLocationRef = makeFunctionReference<
  "query",
  QueryArgs<typeof locations.get>,
  QueryReturn<typeof locations.get>
>("domain/locations:get");
const attachProjectRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof locations.attachProject>,
  MutationReturn<typeof locations.attachProject>
>("domain/locations:attachProject");
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
const getRequirementRef = makeFunctionReference<
  "query",
  QueryArgs<typeof requirements.get>,
  QueryReturn<typeof requirements.get>
>("domain/requirements:get");
const listRequirementsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof requirements.list>,
  QueryReturn<typeof requirements.list>
>("domain/requirements:list");
const addDependencyRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.addDependency>,
  MutationReturn<typeof requirements.addDependency>
>("domain/requirements:addDependency");
const listDependenciesRef = makeFunctionReference<
  "query",
  QueryArgs<typeof requirements.listDependencies>,
  QueryReturn<typeof requirements.listDependencies>
>("domain/requirements:listDependencies");
const recordVendorRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordVendor>,
  MutationReturn<typeof sourcing.recordVendor>
>("domain/sourcing:recordVendor");
const getVendorRef = makeFunctionReference<
  "query",
  QueryArgs<typeof sourcing.getVendor>,
  QueryReturn<typeof sourcing.getVendor>
>("domain/sourcing:getVendor");
const verifyCompatibilityRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.verifyCompatibility>,
  MutationReturn<typeof sourcing.verifyCompatibility>
>("domain/sourcing:verifyCompatibility");
const recordVendorContactRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordVendorContact>,
  MutationReturn<typeof sourcing.recordVendorContact>
>("domain/sourcing:recordVendorContact");
const recordCandidateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordCandidate>,
  MutationReturn<typeof sourcing.recordCandidate>
>("domain/sourcing:recordCandidate");
const listCandidatesRef = makeFunctionReference<
  "query",
  QueryArgs<typeof sourcing.listCandidates>,
  QueryReturn<typeof sourcing.listCandidates>
>("domain/sourcing:listCandidates");
const recordProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordProductEvidence>,
  MutationReturn<typeof sourcing.recordProductEvidence>
>("domain/sourcing:recordProductEvidence");
const ingestProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.ingestProductEvidence>,
  MutationReturn<typeof sourcing.ingestProductEvidence>
>("domain/sourcing:ingestProductEvidence");
const linkEvidenceConflictRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.linkEvidenceConflict>,
  MutationReturn<typeof sourcing.linkEvidenceConflict>
>("domain/sourcing:linkEvidenceConflict");
const verifyProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.verifyProductEvidence>,
  MutationReturn<typeof sourcing.verifyProductEvidence>
>("domain/sourcing:verifyProductEvidence");
const createRfqRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.createRfq>,
  MutationReturn<typeof sourcing.createRfq>
>("domain/sourcing:createRfq");
const openNegotiationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.openNegotiation>,
  MutationReturn<typeof sourcing.openNegotiation>
>("domain/sourcing:openNegotiation");
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
const invalidateApprovalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.invalidateApproval>,
  MutationReturn<typeof decisions.invalidateApproval>
>("domain/decisions:invalidateApproval");
const getApprovalRef = makeFunctionReference<
  "query",
  QueryArgs<typeof decisions.getApproval>,
  QueryReturn<typeof decisions.getApproval>
>("domain/decisions:getApproval");
const recordOrderRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordOrder>,
  MutationReturn<typeof fulfillment.recordOrder>
>("domain/fulfillment:recordOrder");
const listOrdersRef = makeFunctionReference<
  "query",
  QueryArgs<typeof fulfillment.listOrders>,
  QueryReturn<typeof fulfillment.listOrders>
>("domain/fulfillment:listOrders");
const appendOrderEventRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.appendOrderEvent>,
  MutationReturn<typeof fulfillment.appendOrderEvent>
>("domain/fulfillment:appendOrderEvent");
const recordCostEntryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordCostEntry>,
  MutationReturn<typeof fulfillment.recordCostEntry>
>("domain/fulfillment:recordCostEntry");
const recordAssetRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordAsset>,
  MutationReturn<typeof fulfillment.recordAsset>
>("domain/fulfillment:recordAsset");
const recordAssetDocumentRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordAssetDocument>,
  MutationReturn<typeof fulfillment.recordAssetDocument>
>("domain/fulfillment:recordAssetDocument");
const openServiceCaseRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.openServiceCase>,
  MutationReturn<typeof fulfillment.openServiceCase>
>("domain/fulfillment:openServiceCase");
const updateServiceCaseRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.updateServiceCase>,
  MutationReturn<typeof fulfillment.updateServiceCase>
>("domain/fulfillment:updateServiceCase");
const createWatchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.createWatch>,
  MutationReturn<typeof workspace.createWatch>
>("domain/workspace:createWatch");
const checkWatchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.checkWatch>,
  MutationReturn<typeof workspace.checkWatch>
>("domain/workspace:checkWatch");
const ingestWatchCheckRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.ingestWatchCheck>,
  MutationReturn<typeof workspace.ingestWatchCheck>
>("domain/workspace:ingestWatchCheck");
const appendProjectEventRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.appendProjectEvent>,
  MutationReturn<typeof workspace.appendProjectEvent>
>("domain/workspace:appendProjectEvent");
const listProjectEventsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof workspace.listProjectEvents>,
  QueryReturn<typeof workspace.listProjectEvents>
>("domain/workspace:listProjectEvents");
const raiseRiskRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.raiseRisk>,
  MutationReturn<typeof workspace.raiseRisk>
>("domain/workspace:raiseRisk");
const resolveRiskRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.resolveRisk>,
  MutationReturn<typeof workspace.resolveRisk>
>("domain/workspace:resolveRisk");
const saveTemplateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.saveTemplate>,
  MutationReturn<typeof workspace.saveTemplate>
>("domain/workspace:saveTemplate");
const instantiateTemplateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.instantiateTemplate>,
  MutationReturn<typeof workspace.instantiateTemplate>
>("domain/workspace:instantiateTemplate");

const OWNER_A = { tokenIdentifier: "domain-owner-a" };
const OWNER_B = { tokenIdentifier: "domain-owner-b" };

/** Server-side SHA-256 hex, mirroring the approval hash contract. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function setupProject(
  t: ReturnType<typeof convexTest>,
  owner: { tokenIdentifier: string },
  name: string,
) {
  const asOwner = t.withIdentity(owner);
  const org = await asOwner.mutation(createOrganizationRef, {
    name: `${name} org`,
    kind: "private",
  });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asOwner.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!proj.ok) throw new Error("project setup failed");
  return { orgId: org.organizationId, projectId: proj.projectId };
}

function quoteArgs(
  orgId: Id<"organizations">,
  projectId: Id<"projects">,
  version: string,
  refs: {
    requirementId?: Id<"requirements">;
    vendorId?: Id<"vendors">;
    rfqId?: Id<"rfqs">;
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
      requirementId: "req-domain",
      scopeId: "scope-domain",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    ...refs,
  };
}

async function setupSourcingGraph(
  t: ReturnType<typeof convexTest>,
  owner: { tokenIdentifier: string },
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
) {
  const asOwner = t.withIdentity(owner);
  const requirement = await asOwner.mutation(createRequirementRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    key: "req-espresso",
    title: "Espresso machine",
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0",
  });
  if (!requirement.ok) throw new Error("requirement setup failed");
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.orgId,
    name: "Demo Supplier",
    regions: ["NL"],
  });
  if (!vendor.ok) throw new Error("vendor setup failed");
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: requirement.requirementId,
    vendorId: vendor.vendorId,
    productModel: "Linea Mini",
    variant: "Black 220V",
    conversationState: "draft",
  });
  if (!candidate.ok) throw new Error("candidate setup failed");
  // Every graph vendor holds an organization-owned contact channel, so
  // scenario references resolve without implying delivery authority.
  const contact = await asOwner.mutation(recordVendorContactRef, {
    organizationId: project.orgId,
    vendorId: vendor.vendorId,
    channel: "email",
    detailHash: "hash-graph-contact",
    idempotencyKey: "contact-graph-1",
  });
  if (!contact.ok) throw new Error("contact setup failed");
  return { requirementId: requirement.requirementId, vendorId: vendor.vendorId, candidateId: candidate.candidateId };
}

describe("direct full graph journey through required indexes", () => {
  test("every named core record resolves", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "journey");
    const asOwner = t.withIdentity(OWNER_A);

    const location = await asOwner.mutation(createLocationRef, {
      organizationId: project.orgId,
      name: "Amsterdam Centraal",
      region: "NL",
      reportingCurrency: "EUR",
      operatingStatus: "opening",
    });
    if (!location.ok) throw new Error("location failed");
    const located = await asOwner.query(getLocationRef, {
      organizationId: project.orgId,
      locationId: location.locationId,
    });
    if (!located.ok) throw new Error("location get failed");
    expect(located.name).toBe("Amsterdam Centraal");
    const attached = await asOwner.mutation(attachProjectRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      locationId: location.locationId,
    });
    expect(attached.ok).toBe(true);

    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const vendorRow = await asOwner.query(getVendorRef, {
      organizationId: project.orgId,
      vendorId: graph.vendorId,
    });
    if (!vendorRow.ok) throw new Error("vendor get failed");
    expect(vendorRow.name).toBe("Demo Supplier");

    const power = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-power",
      title: "Power supply",
      category: "utilities",
      quantity: "1",
      unit: "piece",
      priority: "P0",
    });
    if (!power.ok) throw new Error("power requirement failed");
    const edge = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: graph.requirementId,
      toRequirementId: power.requirementId,
      kind: "technical",
    });
    expect(edge.ok).toBe(true);
    const edges = await asOwner.query(listDependenciesRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      limit: 10,
    });
    if (!edges.ok) throw new Error("dependency list failed");
    expect(edges.dependencies).toHaveLength(1);

    const contact = await asOwner.mutation(recordVendorContactRef, {
      organizationId: project.orgId,
      vendorId: graph.vendorId,
      channel: "phone",
      detailHash: "hash-contact-1",
      idempotencyKey: "contact-journey-1",
    });
    expect(contact.ok).toBe(true);
    if (!contact.ok) throw new Error("contact failed");
    expect(contact.deduplicated).toBe(false);
    const contactReplay = await asOwner.mutation(recordVendorContactRef, {
      organizationId: project.orgId,
      vendorId: graph.vendorId,
      channel: "phone",
      detailHash: "hash-contact-1",
      idempotencyKey: "contact-journey-1",
    });
    if (!contactReplay.ok) throw new Error("contact replay failed");
    expect(contactReplay.deduplicated).toBe(true);
    expect(contactReplay.contactId).toBe(contact.contactId);

    const got = await asOwner.query(getRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
    });
    if (!got.ok) throw new Error("requirement get failed");
    expect(got.state).toBe("draft");
    const listed = await asOwner.query(listRequirementsRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      limit: 10,
    });
    if (!listed.ok) throw new Error("requirement list failed");
    expect(listed.requirements).toHaveLength(2);

    const candidates = await asOwner.query(listCandidatesRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      limit: 10,
    });
    if (!candidates.ok) throw new Error("candidate list failed");
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]?.compatibility).toBe("unknown");
    // F1R-06: compatibility passes are verified-evidence-backed. The
    // supporting field evidence is recorded, resolved to verified, and
    // then bound at its bumped exact revision.
    const evidence = await asOwner.mutation(recordProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      field: "power.watts",
      sourceKind: "supplier-page",
      capturedAt: Date.now(),
      originalValue: "1600 W",
      normalizedValue: "1600",
      freshness: "fresh",
      counterpartyRole: "vendor",
      idempotencyKey: "pev-journey-1",
    });
    if (!evidence.ok) throw new Error("evidence failed");
    expect(evidence.deduplicated).toBe(false);
    const storedEvidence = await t.run(async (ctx) => ctx.db.get(evidence.evidenceId));
    expect(storedEvidence?.counterpartyRole).toBe("vendor");
    expect(storedEvidence?.origin).toBe("ownerImport");
    expect(storedEvidence?.executionMode).toBe("recorded");
    const resolved = await asOwner.mutation(verifyProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: evidence.evidenceId,
      verdict: "verified",
    });
    if (!resolved.ok) throw new Error("evidence verification failed");
    const verified = await asOwner.mutation(verifyCompatibilityRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      candidateId: graph.candidateId,
      result: "pass",
      evidenceRefs: [{ sourceId: evidence.evidenceId, version: "2" }],
    });
    expect(verified.ok).toBe(true);

    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-journey-1",
      scenarioVendorIds: [graph.vendorId],
      lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
      briefHash: "brief-1",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq failed");

    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(
      project.orgId,
      project.projectId,
      "q-journey-1",
      { requirementId: graph.requirementId, vendorId: graph.vendorId, rfqId: rfq.rfqId },
    ));
    if (!quote.ok) throw new Error("quote failed");

    const negotiation = await asOwner.mutation(openNegotiationRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      quoteId: quote.quoteId,
      mandateHash: "mandate-1",
      roundLimit: 3,
      expiresAt: Date.now() + 3_600_000,
    });
    expect(negotiation.ok).toBe(true);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-journey-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-journey",
    });
    if (!selection.ok) throw new Error("selection failed");

    const journeyCanonical = '{"decision":"select","version":"q-journey-1"}';
    const approval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "select espresso offer",
      snapshotCanonical: journeyCanonical,
      snapshotHash: await sha256Hex(journeyCanonical),
      selectionId: selection.selectionId,
      quoteId: quote.quoteId,
    });
    if (!approval.ok) throw new Error("approval failed");
    expect(approval.deduplicated).toBe(false);
    const decided = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decided.ok).toBe(true);
    const approvalState = await asOwner.query(getApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
    });
    if (!approvalState.ok) throw new Error("approval get failed");
    expect(approvalState.state).toBe("approved");

    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-journey-1",
      orderedQuantity: "1",
    });
    if (!order.ok) throw new Error("order failed");
    const orders = await asOwner.query(listOrdersRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      limit: 10,
    });
    if (!orders.ok) throw new Error("order list failed");
    expect(orders.orders).toHaveLength(1);
    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "confirmation",
      idempotencyKey: "evt-journey-1",
    });
    if (!event.ok) throw new Error("event failed");
    expect(event.deduplicated).toBe(false);
    const payment = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-journey-1",
    });
    expect(payment.ok).toBe(true);

    const asset = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      locationId: location.locationId,
      orderId: order.orderId,
      label: "Linea Mini #1",
      idempotencyKey: "asset-journey-1",
    });
    if (!asset.ok) throw new Error("asset failed");
    expect(asset.deduplicated).toBe(false);
    const document = await asOwner.mutation(recordAssetDocumentRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      assetId: asset.assetId,
      kind: "manual",
      idempotencyKey: "doc-journey-1",
    });
    if (!document.ok) throw new Error("document failed");
    expect(document.deduplicated).toBe(false);
    const serviceCase = await asOwner.mutation(openServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      assetId: asset.assetId,
      urgency: "normal",
      summary: "Annual descale",
      idempotencyKey: "case-journey-1",
    });
    if (!serviceCase.ok) throw new Error("service case failed");
    expect(serviceCase.deduplicated).toBe(false);
    const advanced = await asOwner.mutation(updateServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId: serviceCase.caseId,
      state: "inProgress",
    });
    expect(advanced.ok).toBe(true);

    const watch = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: graph.candidateId,
      cadenceMs: 86_400_000,
      counterpartyRole: "vendor",
      idempotencyKey: "watch-journey-1",
    });
    if (!watch.ok) throw new Error("watch failed");
    expect(watch.deduplicated).toBe(false);
    const storedWatch = await t.run(async (ctx) => ctx.db.get(watch.watchId));
    expect(storedWatch?.source).toBe("ownerImport");
    expect(storedWatch?.counterpartyRole).toBe("vendor");
    expect(storedWatch?.nextCheckAt).toBeGreaterThan(0);
    const checked = await asOwner.mutation(checkWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      watchId: watch.watchId,
      result: "ok",
    });
    expect(checked.ok).toBe(true);

    const projectEvent = await asOwner.mutation(appendProjectEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      kind: "selection.recorded",
    });
    expect(projectEvent.ok).toBe(true);
    const events = await asOwner.query(listProjectEventsRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      limit: 10,
    });
    if (!events.ok) throw new Error("event list failed");
    expect(events.events).toHaveLength(1);

    const risk = await asOwner.mutation(raiseRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "req-espresso",
      severity: "high",
      source: "lead-time",
    });
    if (!risk.ok) throw new Error("risk failed");
    const mitigated = await asOwner.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "mitigating",
    });
    expect(mitigated.ok).toBe(true);

    const template = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "cafe-starter",
      version: "v1",
      requirementSnapshot: JSON.stringify([
        { key: "req-espresso", title: "Espresso machine", category: "coffee", quantity: "1", unit: "piece" },
      ]),
      constraintSnapshot: JSON.stringify([]),
    });
    if (!template.ok) throw new Error("template failed");
    const target = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "second site",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target project failed");
    const instantiated = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: template.templateId,
    });
    if (!instantiated.ok) throw new Error("instantiate failed");
    expect(instantiated.requirementIds).toHaveLength(1);
    expect(instantiated.collections).toEqual(["requirements", "constraints"]);
  });
});

describe("direct cross-project reference rejection", () => {
  test("foreign graph references deny where handlers resolve them", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, OWNER_A, "xproj-a");
    const projectB = await setupProject(t, OWNER_B, "xproj-b");
    const asA = t.withIdentity(OWNER_A);
    const asB = t.withIdentity(OWNER_B);
    const graphA = await setupSourcingGraph(t, OWNER_A, projectA);
    const graphB = await setupSourcingGraph(t, OWNER_B, projectB);

    const foreignCandidate = await asB.mutation(recordCandidateRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphA.requirementId,
      vendorId: graphB.vendorId,
      productModel: "Linea Mini",
      variant: "Black 220V",
      conversationState: "draft",
    });
    expect(foreignCandidate.ok).toBe(false);
    if (!foreignCandidate.ok) expect(foreignCandidate.code).toBe("denied-project");

    // Vendors are organization-scoped: another organization's vendor
    // never resolves, even when the requirement and project are local.
    const foreignVendorCandidate = await asB.mutation(recordCandidateRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphB.requirementId,
      vendorId: graphA.vendorId,
      productModel: "Linea Mini",
      variant: "Black 220V",
      conversationState: "draft",
    });
    expect(foreignVendorCandidate.ok).toBe(false);
    if (!foreignVendorCandidate.ok) expect(foreignVendorCandidate.code).toBe("denied-project");

    const foreignDependency = await asB.mutation(addDependencyRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      fromRequirementId: graphB.requirementId,
      toRequirementId: graphA.requirementId,
      kind: "scheduling",
    });
    expect(foreignDependency.ok).toBe(false);
    if (!foreignDependency.ok) expect(foreignDependency.code).toBe("denied-project");

    const foreignRfq = await asB.mutation(createRfqRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphB.requirementId,
      idempotencyKey: "rfq-foreign-1",
      scenarioVendorIds: [graphA.vendorId],
      lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
      briefHash: "brief-x",
      conversationState: "draft",
    });
    expect(foreignRfq.ok).toBe(false);
    if (!foreignRfq.ok) expect(foreignRfq.code).toBe("denied-project");

    // Scenario vendors are context, not authority: an in-organization
    // vendor without any contact channel is a valid scenario reference,
    // and the record authorizes no delivery on its own.
    const contactless = await asB.mutation(recordVendorRef, {
      organizationId: projectB.orgId,
      name: "Contactless Supplier",
      regions: ["NL"],
    });
    if (!contactless.ok) throw new Error("contactless vendor failed");
    const scenarioRfq = await asB.mutation(createRfqRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphB.requirementId,
      idempotencyKey: "rfq-foreign-2",
      scenarioVendorIds: [contactless.vendorId],
      lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
      briefHash: "brief-x",
      conversationState: "draft",
    });
    expect(scenarioRfq.ok).toBe(true);

    const foreignQuote = await asB.mutation(recordQuoteRef, quoteArgs(
      projectB.orgId,
      projectB.projectId,
      "q-foreign-1",
      { requirementId: graphA.requirementId },
    ));
    expect(foreignQuote.ok).toBe(false);
    if (!foreignQuote.ok) expect(foreignQuote.code).toBe("denied-project");

    const quoteA = await asA.mutation(recordQuoteRef, quoteArgs(projectA.orgId, projectA.projectId, "q-a-1"));
    if (!quoteA.ok) throw new Error("quote A failed");
    const quoteB = await asB.mutation(recordQuoteRef, quoteArgs(projectB.orgId, projectB.projectId, "q-b-1"));
    if (!quoteB.ok) throw new Error("quote B failed");

    const foreignSelection = await asB.mutation(recordSelectionRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphB.requirementId,
      candidateId: graphB.candidateId,
      quoteId: quoteA.quoteId,
      quoteVersion: "q-a-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-foreign-reference",
    });
    expect(foreignSelection.ok).toBe(false);
    if (!foreignSelection.ok) expect(foreignSelection.code).toBe("denied-project");

    const selectionB = await asB.mutation(recordSelectionRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      requirementId: graphB.requirementId,
      candidateId: graphB.candidateId,
      quoteId: quoteB.quoteId,
      quoteVersion: "q-b-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-project-b",
    });
    if (!selectionB.ok) throw new Error("selection B failed");

    const crossCanonical = '{"decision":"cross"}';
    const foreignApproval = await asA.mutation(recordApprovalRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      scope: "cross",
      snapshotCanonical: crossCanonical,
      snapshotHash: await sha256Hex(crossCanonical),
      selectionId: selectionB.selectionId,
    });
    expect(foreignApproval.ok).toBe(false);
    if (!foreignApproval.ok) expect(foreignApproval.code).toBe("denied-project");

    const foreignOrder = await asA.mutation(recordOrderRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      selectionId: selectionB.selectionId,
      idempotencyKey: "ord-cross-1",
      orderedQuantity: "1",
    });
    expect(foreignOrder.ok).toBe(false);
    if (!foreignOrder.ok) expect(foreignOrder.code).toBe("denied-project");

    const orderB = await asB.mutation(recordOrderRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      selectionId: selectionB.selectionId,
      idempotencyKey: "ord-b-1",
      orderedQuantity: "1",
    });
    if (!orderB.ok) throw new Error("order B failed");

    const foreignEvent = await asA.mutation(appendOrderEventRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      orderId: orderB.orderId,
      kind: "shipment",
      idempotencyKey: "evt-cross-1",
    });
    expect(foreignEvent.ok).toBe(false);
    if (!foreignEvent.ok) expect(foreignEvent.code).toBe("denied-project");

    const foreignCost = await asA.mutation(recordCostEntryRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      orderId: orderB.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 100 },
      idempotencyKey: "pay-cross-1",
    });
    expect(foreignCost.ok).toBe(false);
    if (!foreignCost.ok) expect(foreignCost.code).toBe("denied-project");

    const assetB = await asB.mutation(recordAssetRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      orderId: orderB.orderId,
      label: "Machine B",
      idempotencyKey: "asset-b-1",
    });
    if (!assetB.ok) throw new Error("asset B failed");
    const foreignCase = await asA.mutation(openServiceCaseRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      assetId: assetB.assetId,
      urgency: "high",
      summary: "Cross-project probe",
      idempotencyKey: "case-cross-1",
    });
    expect(foreignCase.ok).toBe(false);
    if (!foreignCase.ok) expect(foreignCase.code).toBe("denied-project");

    const watchB = await asB.mutation(createWatchRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      targetKind: "candidate",
      targetId: graphB.candidateId,
      cadenceMs: 86_400_000,
      counterpartyRole: "vendor",
      idempotencyKey: "watch-foreign-b",
    });
    if (!watchB.ok) throw new Error("watch B failed");
    const foreignWatchRead = await asA.mutation(checkWatchRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      watchId: watchB.watchId,
      result: "ok",
    });
    expect(foreignWatchRead.ok).toBe(false);
    if (!foreignWatchRead.ok) expect(foreignWatchRead.code).toBe("denied-project");
  });

  test("foreign templates and locations never bind", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, OWNER_A, "bind-a");
    const projectB = await setupProject(t, OWNER_B, "bind-b");
    const asA = t.withIdentity(OWNER_A);
    const asB = t.withIdentity(OWNER_B);

    const locationB = await asB.mutation(createLocationRef, {
      organizationId: projectB.orgId,
      name: "Rotterdam",
      region: "NL",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    });
    if (!locationB.ok) throw new Error("location B failed");
    const bound = await asA.mutation(attachProjectRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      locationId: locationB.locationId,
    });
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.code).toBe("denied-project");

    const templateB = await asB.mutation(saveTemplateRef, {
      organizationId: projectB.orgId,
      sourceProjectId: projectB.projectId,
      name: "starter",
      version: "v1",
      requirementSnapshot: JSON.stringify([]),
      constraintSnapshot: JSON.stringify([]),
    });
    if (!templateB.ok) throw new Error("template B failed");
    const stolen = await asA.mutation(instantiateTemplateRef, {
      organizationId: projectA.orgId,
      targetProjectId: projectA.projectId,
      templateId: templateB.templateId,
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.code).toBe("denied-project");
  });
});

describe("direct dependency cycles, variant identity, and version keys", () => {
  test("scheduling cycles and self-edges are refused", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "cycles");
    const asOwner = t.withIdentity(OWNER_A);
    const first = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-a",
      title: "A",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P1",
    });
    if (!first.ok) throw new Error("req A failed");
    const second = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-b",
      title: "B",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P1",
    });
    if (!second.ok) throw new Error("req B failed");
    const forward = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: first.requirementId,
      toRequirementId: second.requirementId,
      kind: "scheduling",
    });
    expect(forward.ok).toBe(true);
    const back = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: second.requirementId,
      toRequirementId: first.requirementId,
      kind: "scheduling",
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.code).toBe("invalid-payload");
    const self = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: first.requirementId,
      toRequirementId: first.requirementId,
      kind: "technical",
    });
    expect(self.ok).toBe(false);
  });

  test("exact variant identity is byte-exact, never fuzzy", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "variants");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    // Near-duplicates stay visible as separate candidates: no case or
    // whitespace folding collapses them.
    const nearDuplicate = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      productModel: "linea mini",
      variant: "  black 220v ",
      conversationState: "draft",
    });
    expect(nearDuplicate.ok).toBe(true);
    // The byte-identical triple still conflicts instead of duplicating.
    const exactDuplicate = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      productModel: "Linea Mini",
      variant: "Black 220V",
      conversationState: "draft",
    });
    expect(exactDuplicate.ok).toBe(false);
    if (!exactDuplicate.ok) expect(exactDuplicate.code).toBe("duplicate-conflict");
    const otherVariant = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      productModel: "Linea Mini",
      variant: "White 220V",
      conversationState: "draft",
    });
    expect(otherVariant.ok).toBe(true);
    const otherVendor = await asOwner.mutation(recordVendorRef, {
      organizationId: project.orgId,
      name: "Second Supplier",
      regions: ["NL"],
    });
    if (!otherVendor.ok) throw new Error("second vendor failed");
    const sameVariantOtherSeller = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: otherVendor.vendorId,
      productModel: "Linea Mini",
      variant: "Black 220V",
      conversationState: "draft",
    });
    expect(sameVariantOtherSeller.ok).toBe(true);
  });

  test("immutable versions conflict while idempotency keys replay", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "idempotent");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);

    const duplicateKey = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-espresso",
      title: "Duplicate",
      category: "coffee",
      quantity: "1",
      unit: "piece",
      priority: "P1",
    });
    expect(duplicateKey.ok).toBe(false);
    if (!duplicateKey.ok) expect(duplicateKey.code).toBe("duplicate-conflict");

    const rfqArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-replay-1",
      scenarioVendorIds: [graph.vendorId],
      lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
      briefHash: "brief-r",
      conversationState: "draft" as const,
    };
    const rfqFirst = await asOwner.mutation(createRfqRef, rfqArgs);
    if (!rfqFirst.ok || rfqFirst.deduplicated) throw new Error("rfq first failed");
    const rfqReplay = await asOwner.mutation(createRfqRef, rfqArgs);
    if (!rfqReplay.ok) throw new Error("rfq replay failed");
    expect(rfqReplay.deduplicated).toBe(true);
    expect(rfqReplay.rfqId).toBe(rfqFirst.rfqId);
    // A replay with different material fields is a conflict, never a
    // silent swap of recipients or scope.
    const rfqCollision = await asOwner.mutation(createRfqRef, {
      ...rfqArgs,
      briefHash: "brief-changed",
    });
    expect(rfqCollision.ok).toBe(false);
    if (!rfqCollision.ok) expect(rfqCollision.code).toBe("duplicate-conflict");
  });

  test("order and cost-entry idempotency collisions conflict", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "collisions");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project.orgId, project.projectId, "q-col-1"));
    if (!quote.ok) throw new Error("quote failed");
    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-col-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-column-lineage",
    });
    if (!selection.ok) throw new Error("selection failed");
    const orderArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-col-1",
      orderedQuantity: "1",
    };
    const orderFirst = await asOwner.mutation(recordOrderRef, orderArgs);
    if (!orderFirst.ok || orderFirst.deduplicated) throw new Error("order first failed");
    const orderReplay = await asOwner.mutation(recordOrderRef, orderArgs);
    if (!orderReplay.ok) throw new Error("order replay failed");
    expect(orderReplay.deduplicated).toBe(true);
    expect(orderReplay.orderId).toBe(orderFirst.orderId);
    const orderCollision = await asOwner.mutation(recordOrderRef, {
      ...orderArgs,
      orderedQuantity: "2",
    });
    expect(orderCollision.ok).toBe(false);
    if (!orderCollision.ok) expect(orderCollision.code).toBe("duplicate-conflict");

    const entryArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: orderFirst.orderId,
      kind: "payment" as const,
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-col-1",
    };
    const entryFirst = await asOwner.mutation(recordCostEntryRef, entryArgs);
    if (!entryFirst.ok || entryFirst.deduplicated) throw new Error("entry first failed");
    const entryReplay = await asOwner.mutation(recordCostEntryRef, entryArgs);
    if (!entryReplay.ok) throw new Error("entry replay failed");
    expect(entryReplay.deduplicated).toBe(true);
    const entryCollision = await asOwner.mutation(recordCostEntryRef, {
      ...entryArgs,
      amount: { currency: "EUR", minorUnits: 250000 },
    });
    expect(entryCollision.ok).toBe(false);
    if (!entryCollision.ok) expect(entryCollision.code).toBe("duplicate-conflict");
  });
});

describe("direct provenance and reuse boundaries", () => {
  test("public evidence imports cannot self-assert transport", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "provenance");
    const asOwner = t.withIdentity(OWNER_A);
    const loose: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("domain/sourcing:recordProductEvidence");
    await expect(
      asOwner.mutation(loose, {
        organizationId: project.orgId,
        projectId: project.projectId,
        field: "power.watts",
        sourceKind: "supplier-page",
        capturedAt: Date.now(),
        originalValue: "1600 W",
        normalizedValue: "1600",
        freshness: "fresh",
        counterpartyRole: "vendor",
        executionMode: "live",
        providerIds: "inbox-1/message-1",
        idempotencyKey: "pev-prov-0",
      }),
    ).rejects.toThrow(/Unexpected field/);
  });

  test("public candidate imports cannot self-assert compatibility", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "candidate-prov");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const loose: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("domain/sourcing:recordCandidate");
    await expect(
      asOwner.mutation(loose, {
        organizationId: project.orgId,
        projectId: project.projectId,
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        productModel: "Linea Mini",
        variant: "Black 220V",
        compatibility: "pass",
        conversationState: "draft",
      }),
    ).rejects.toThrow(/Unexpected field/);
    const row = await t.run(async (ctx) => ctx.db.get(graph.candidateId));
    expect(row?.compatibility).toBe("unknown");
  });

  test("explicit owner-import evidence carries the closed union and origin", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "provenance-rows");
    const asOwner = t.withIdentity(OWNER_A);
    const recorded = await asOwner.mutation(recordProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      field: "power.watts",
      sourceKind: "user-document",
      capturedAt: Date.now(),
      originalValue: "1600 W",
      normalizedValue: "1600",
      freshness: "fresh",
      counterpartyRole: "ownerStandIn",
      idempotencyKey: "pev-prov-1",
    });
    if (!recorded.ok) throw new Error("evidence record failed");
    expect(recorded.deduplicated).toBe(false);
    const row = await t.run(async (ctx) => ctx.db.get(recorded.evidenceId));
    expect(row?.counterpartyRole).toBe("ownerStandIn");
    expect(row?.executionMode).toBe("recorded");
    expect(row?.origin).toBe("ownerImport");
    expect(row?.verification).toBe("unverified");
    // Closed union: userImport, live, and fixture labels are rejected
    // by the validator, never stored.
    const loose: FunctionReference<"mutation", "public", Record<string, unknown>, unknown> =
      makeFunctionReference("domain/sourcing:recordProductEvidence");
    await expect(
      asOwner.mutation(loose, {
        organizationId: project.orgId,
        projectId: project.projectId,
        field: "power.watts",
        sourceKind: "user-document",
        capturedAt: Date.now(),
        originalValue: "1600 W",
        normalizedValue: "1600",
        freshness: "fresh",
        counterpartyRole: "userImport",
        executionMode: "live",
        providerIds: "inbox-1/message-1",
        idempotencyKey: "pev-prov-2",
      }),
    ).rejects.toThrow(/Validator error/);
  });

  test("evidence conflicts link and resolve through authority", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "evidence-links");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      field: "power.watts",
      sourceKind: "supplier-page",
      capturedAt: Date.now(),
      freshness: "fresh" as const,
      counterpartyRole: "vendor" as const,
    };
    const first = await asOwner.mutation(recordProductEvidenceRef, {
      ...base,
      originalValue: "1600 W",
      normalizedValue: "1600",
      idempotencyKey: "pev-link-1",
    });
    if (!first.ok) throw new Error("first evidence failed");
    const second = await asOwner.mutation(recordProductEvidenceRef, {
      ...base,
      originalValue: "2200 W",
      normalizedValue: "2200",
      idempotencyKey: "pev-link-2",
    });
    if (!second.ok) throw new Error("second evidence failed");
    // Identical replay deduplicates; divergent replay conflicts.
    const replay = await asOwner.mutation(recordProductEvidenceRef, {
      ...base,
      originalValue: "1600 W",
      normalizedValue: "1600",
      idempotencyKey: "pev-link-1",
    });
    if (!replay.ok) throw new Error("evidence replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.evidenceId).toBe(first.evidenceId);
    const collision = await asOwner.mutation(recordProductEvidenceRef, {
      ...base,
      originalValue: "9999 W",
      normalizedValue: "9999",
      idempotencyKey: "pev-link-1",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.code).toBe("duplicate-conflict");
    const linked = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: first.evidenceId,
      conflictingIds: [second.evidenceId],
    });
    expect(linked.ok).toBe(true);
    const conflicted = await t.run(async (ctx) => ctx.db.get(first.evidenceId));
    expect(conflicted?.verification).toBe("conflicted");
    expect(conflicted?.conflictEvidenceIds).toEqual([second.evidenceId]);
    const selfLink = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: first.evidenceId,
      conflictingIds: [first.evidenceId],
    });
    expect(selfLink.ok).toBe(false);
    const resolved = await asOwner.mutation(verifyProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: first.evidenceId,
      verdict: "verified",
    });
    expect(resolved.ok).toBe(true);
    const twice = await asOwner.mutation(verifyProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: first.evidenceId,
      verdict: "superseded",
    });
    expect(twice.ok).toBe(false);
  });

  test("template reuse copies requirements without orders or payments", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "reuse");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project.orgId, project.projectId, "q-reuse-1"));
    if (!quote.ok) throw new Error("quote failed");
    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-reuse-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-reuse",
    });
    if (!selection.ok) throw new Error("selection failed");
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-reuse-1",
      orderedQuantity: "1",
    });
    if (!order.ok) throw new Error("order failed");
    const payment = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-reuse-1",
    });
    if (!payment.ok) throw new Error("payment failed");

    const template = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "reuse-starter",
      version: "v1",
      requirementSnapshot: JSON.stringify([
        { key: "req-espresso", title: "Espresso machine", category: "coffee", quantity: "1", unit: "piece" },
      ]),
      constraintSnapshot: JSON.stringify([]),
    });
    if (!template.ok) throw new Error("template failed");
    const target = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "reuse target",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target failed");
    const instantiated = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: template.templateId,
    });
    if (!instantiated.ok) throw new Error("instantiate failed");
    expect(instantiated.collections).toEqual(["requirements", "constraints"]);

    const counts = await t.run(async (ctx) => {
      let requirements = 0;
      for await (const row of ctx.db
        .query("requirements")
        .withIndex("by_project", (q) => q.eq("projectId", target.projectId))) {
        requirements += 1;
        void row;
      }
      let orders = 0;
      for await (const row of ctx.db
        .query("orders")
        .withIndex("by_project", (q) => q.eq("projectId", target.projectId))) {
        orders += 1;
        void row;
      }
      // orderEvents carries its project on every row; the controlled
      // seed holds a handful of rows, so a bounded scan filtered by
      // project proves no event leaked into the reused project.
      const orderEventRows = await ctx.db.query("orderEvents").take(100);
      const orderEvents = orderEventRows.filter(
        (row) => row.projectId === target.projectId,
      ).length;
      let costEntries = 0;
      for await (const row of ctx.db
        .query("costEntries")
        .withIndex("by_project", (q) => q.eq("projectId", target.projectId))) {
        costEntries += 1;
        void row;
      }
      return { requirements, orders, orderEvents, costEntries };
    });
    expect(counts.requirements).toBe(1);
    expect(counts.orders).toBe(0);
    expect(counts.orderEvents).toBe(0);
    expect(counts.costEntries).toBe(0);
  });

  test("selections bind exact versions and terminal service states hold", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "versions");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project.orgId, project.projectId, "q-ver-1"));
    if (!quote.ok) throw new Error("quote failed");

    const wrongQuoteVersion = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-ver-2",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-wrong-quote-version",
    });
    expect(wrongQuoteVersion.ok).toBe(false);

    const staleRequirement = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-ver-1",
      quantity: "1",
      requirementVersion: 2,
      idempotencyKey: "selection-stale-requirement",
    });
    expect(staleRequirement.ok).toBe(false);

    const asset = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      label: "Spare grinder",
      idempotencyKey: "asset-ver-1",
    });
    if (!asset.ok) throw new Error("asset failed");
    const assetReplay = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      label: "Spare grinder",
      idempotencyKey: "asset-ver-1",
    });
    if (!assetReplay.ok) throw new Error("asset replay failed");
    expect(assetReplay.deduplicated).toBe(true);
    expect(assetReplay.assetId).toBe(asset.assetId);
    const assetCollision = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      label: "Different grinder",
      idempotencyKey: "asset-ver-1",
    });
    expect(assetCollision.ok).toBe(false);
    if (!assetCollision.ok) expect(assetCollision.code).toBe("duplicate-conflict");
    const serviceCase = await asOwner.mutation(openServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      assetId: asset.assetId,
      urgency: "low",
      summary: "Check burrs",
      idempotencyKey: "case-ver-1",
    });
    if (!serviceCase.ok) throw new Error("case failed");
    const closed = await asOwner.mutation(updateServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId: serviceCase.caseId,
      state: "closed",
    });
    expect(closed.ok).toBe(true);
    const reopened = await asOwner.mutation(updateServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId: serviceCase.caseId,
      state: "open",
    });
    expect(reopened.ok).toBe(false);

    const risk = await asOwner.mutation(raiseRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "delivery",
      severity: "medium",
      source: "supplier",
    });
    if (!risk.ok) throw new Error("risk failed");
    const resolved = await asOwner.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "resolved",
    });
    expect(resolved.ok).toBe(true);
    const backward = await asOwner.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "open",
    });
    expect(backward.ok).toBe(false);

    const invCanonical = '{"v":1}';
    const approval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "invalidate me",
      snapshotCanonical: invCanonical,
      snapshotHash: await sha256Hex(invCanonical),
    });
    if (!approval.ok) throw new Error("approval failed");
    const invalidated = await asOwner.mutation(invalidateApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
    });
    expect(invalidated.ok).toBe(true);
    const decidedAfter = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decidedAfter.ok).toBe(false);
  });
});

describe("direct audit repairs: authority, hashes, bounds, lineage", () => {
  test("project-scoped-only membership grants no org-wide authority", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "scope-leak");
    const SCOPED = { tokenIdentifier: "domain-scoped-only" };
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        organizationId: project.orgId,
        projectId: project.projectId,
        identity: SCOPED.tokenIdentifier,
        role: "contributor",
        status: "active",
        version: 1,
        updatedAt: Date.now(),
      });
    });
    const asScoped = t.withIdentity(SCOPED);
    // The row works inside its project...
    const requirement = await asScoped.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-scoped",
      title: "Scoped work",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P2",
    });
    expect(requirement.ok).toBe(true);
    // ...but never leaks into organization-level records.
    const location = await asScoped.mutation(createLocationRef, {
      organizationId: project.orgId,
      name: "Leaked site",
      region: "NL",
      reportingCurrency: "EUR",
      operatingStatus: "opening",
    });
    expect(location.ok).toBe(false);
    if (!location.ok) expect(location.code).toBe("denied-membership");
    const vendor = await asScoped.mutation(recordVendorRef, {
      organizationId: project.orgId,
      name: "Leaked vendor",
      regions: ["NL"],
    });
    expect(vendor.ok).toBe(false);
    if (!vendor.ok) expect(vendor.code).toBe("denied-membership");
  });

  test("approval hashes are server-verified, never client-trusted", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "hash-trust");
    const asOwner = t.withIdentity(OWNER_A);
    const canonical = '{"decision":"pay","amount":200000}';
    const forged = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "forged terms",
      snapshotCanonical: canonical,
      snapshotHash: "deadbeef",
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("invalid-payload");
    const honest = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "honest terms",
      snapshotCanonical: canonical,
      snapshotHash: await sha256Hex(canonical),
    });
    if (!honest.ok || honest.deduplicated) throw new Error("honest approval failed");
    const replay = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "honest terms",
      snapshotCanonical: canonical,
      snapshotHash: await sha256Hex(canonical),
    });
    if (!replay.ok) throw new Error("approval replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.approvalId).toBe(honest.approvalId);
  });

  test("accepted quantities can never exceed ordered quantities", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "acceptance");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project.orgId, project.projectId, "q-acc-1"));
    if (!quote.ok) throw new Error("quote failed");
    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-acc-1",
      quantity: "2",
      requirementVersion: 1,
      idempotencyKey: "selection-acceptance",
    });
    if (!selection.ok) throw new Error("selection failed");
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-acc-1",
      orderedQuantity: "2",
    });
    if (!order.ok) throw new Error("order failed");
    // The order pins the decision lineage it executes.
    const stored = await t.run(async (ctx) => ctx.db.get(order.orderId));
    expect(stored?.requirementId).toBe(graph.requirementId);
    expect(stored?.quoteId).toBe(quote.quoteId);
    expect(stored?.quoteVersion).toBe("q-acc-1");
    expect(stored?.requirementVersion).toBe(1);

    const first = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "partialDelivery",
      acceptedQuantity: "1.5",
      idempotencyKey: "evt-acc-1",
    });
    if (!first.ok) throw new Error("first event failed");
    expect(first.deduplicated).toBe(false);
    const firstReplay = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "partialDelivery",
      acceptedQuantity: "1.5",
      idempotencyKey: "evt-acc-1",
    });
    if (!firstReplay.ok) throw new Error("event replay failed");
    expect(firstReplay.deduplicated).toBe(true);
    expect(firstReplay.eventId).toBe(first.eventId);
    const overCumulative = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "partialDelivery",
      acceptedQuantity: "1",
      idempotencyKey: "evt-acc-2",
    });
    expect(overCumulative.ok).toBe(false);
    if (!overCumulative.ok) expect(overCumulative.code).toBe("invalid-payload");
    const overSingle = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptedQuantity: "3",
      idempotencyKey: "evt-acc-3",
    });
    expect(overSingle.ok).toBe(false);
    const malformed = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptedQuantity: "many",
      idempotencyKey: "evt-acc-4",
    });
    expect(malformed.ok).toBe(false);
    const exact = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptedQuantity: "0.5",
      idempotencyKey: "evt-acc-5",
    });
    expect(exact.ok).toBe(true);
  });

  test("dependency verification denies past its explicit bound", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "dep-bound");
    const asOwner = t.withIdentity(OWNER_A);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const made: Id<"requirements">[] = [];
      for (let i = 0; i < 502; i += 1) {
        made.push(
          await ctx.db.insert("requirements", {
            organizationId: project.orgId,
            projectId: project.projectId,
            key: `req-${i}`,
            title: `Requirement ${i}`,
            category: "cat",
            quantity: "1",
            unit: "piece",
            priority: "P2",
            state: "draft",
            fulfillment: "notOrdered",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      for (let i = 0; i < 501; i += 1) {
        const from = made[i];
        const to = made[i + 1];
        if (from === undefined || to === undefined) throw new Error("chain setup failed");
        await ctx.db.insert("dependencies", {
          organizationId: project.orgId,
          projectId: project.projectId,
          fromRequirementId: from,
          toRequirementId: to,
          kind: "scheduling",
          verification: "pending",
          createdAt: now,
        });
      }
      const first = made[0];
      const last = made[501];
      if (first === undefined || last === undefined) throw new Error("chain setup failed");
      return { first, last };
    });
    // 501 existing edges exceed the verification bound: denied whole,
    // never checked against a truncated graph.
    const denied = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: ids.last,
      toRequirementId: ids.first,
      kind: "scheduling",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
  });

  test("oversized template snapshots deny whole with zero writes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "template-bound");
    const asOwner = t.withIdentity(OWNER_A);
    const items = [];
    for (let i = 0; i < 51; i += 1) {
      items.push({ key: `req-${i}`, title: `Item ${i}`, category: "cat", quantity: "1", unit: "piece" });
    }
    const template = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "oversized",
      version: "v1",
      requirementSnapshot: JSON.stringify(items),
      constraintSnapshot: JSON.stringify([]),
    });
    if (!template.ok) throw new Error("template save failed");
    const target = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "bound target",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target failed");
    const denied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: template.templateId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("requirements")
        .withIndex("by_project", (q) => q.eq("projectId", target.projectId))
        .take(100),
    );
    expect(rows).toHaveLength(0);
  });

  test("quote graph references are hash-bound, not merely stored", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "quote-hash");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const rfqArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      scenarioVendorIds: [graph.vendorId],
      lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
      briefHash: "brief-h",
      conversationState: "draft" as const,
    };
    const rfqOne = await asOwner.mutation(createRfqRef, { ...rfqArgs, idempotencyKey: "rfq-h-1" });
    if (!rfqOne.ok) throw new Error("rfq one failed");
    const rfqTwo = await asOwner.mutation(createRfqRef, { ...rfqArgs, idempotencyKey: "rfq-h-2" });
    if (!rfqTwo.ok) throw new Error("rfq two failed");
    const base = quoteArgs(project.orgId, project.projectId, "q-h");
    const first = await asOwner.mutation(recordQuoteRef, {
      ...base,
      version: "q-h-1",
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      rfqId: rfqOne.rfqId,
    });
    if (!first.ok) throw new Error("first quote failed");
    const second = await asOwner.mutation(recordQuoteRef, {
      ...base,
      version: "q-h-2",
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      rfqId: rfqTwo.rfqId,
    });
    if (!second.ok) throw new Error("second quote failed");
    // Identical commercial terms bound to different RFQs hash apart.
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  test("internal pipeline evidence writes carry internal origin", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "pipeline-prov");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const ingested = await t.mutation(ingestProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      field: "power.watts",
      sourceKind: "collector",
      capturedAt: Date.now(),
      originalValue: "1600 W",
      normalizedValue: "1600",
      freshness: "fresh",
      counterpartyRole: "vendor",
      executionMode: "live",
      idempotencyKey: "pev-pipe-1",
    });
    if (!ingested.ok) throw new Error("ingest failed");
    const row = await t.run(async (ctx) => ctx.db.get(ingested.evidenceId));
    expect(row?.origin).toBe("internal");
    expect(row?.executionMode).toBe("live");
    expect(row?.verification).toBe("unverified");
  });

  test("compatibility verification needs evidence and approver authority", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "compat-auth");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const CONTRIB = { tokenIdentifier: "domain-contrib-compat" };
    const granted = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetIdentity: CONTRIB.tokenIdentifier,
      role: "contributor",
    });
    expect(granted.ok).toBe(true);
    const asContrib = t.withIdentity(CONTRIB);
    const weakRole = await asContrib.mutation(verifyCompatibilityRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      candidateId: graph.candidateId,
      result: "pass",
      evidenceRefs: [{ sourceId: "s", version: "v1" }],
    });
    expect(weakRole.ok).toBe(false);
    if (!weakRole.ok) expect(weakRole.code).toBe("denied-capability");
    const noEvidence = await asOwner.mutation(verifyCompatibilityRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      candidateId: graph.candidateId,
      result: "pass",
      evidenceRefs: [],
    });
    expect(noEvidence.ok).toBe(false);
    if (!noEvidence.ok) expect(noEvidence.code).toBe("invalid-payload");
  });
});

describe("direct second-round repairs: bindings, pins, replay, lineage", () => {
  async function setupGrantAndConversation(
    t: ReturnType<typeof convexTest>,
    orgId: Id<"organizations">,
    projectId: Id<"projects">,
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const grantId = await ctx.db.insert("grants", {
        organizationId: orgId,
        projectId,
        operations: ["communication.send"],
        communicationProfile: "ownerRoleplay",
        recipientConfigVersion: 1,
        inputVersions: {},
        canonicalPayload: "{}",
        payloadHash: "hash-conv",
        costCeilingMicroUsd: 100_000,
        roundLimit: 2,
        expiresAt: now + 3_600_000,
        revocationVersion: 1,
        status: "active",
        createdAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: orgId,
        projectId,
        grantId,
        version: 1,
        state: "draft",
        recipientConfigVersion: 1,
        updatedAt: now,
      });
      return { grantId, conversationId };
    });
  }

  function rfqLine(id: string) {
    return { itemId: id, description: `Item ${id}`, quantity: "1", unit: "piece" };
  }

  test("rfqs carry line items and an in-project conversation binding", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "rfq-bind");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-bind-1",
      scenarioVendorIds: [graph.vendorId],
      briefHash: "brief-bind",
      conversationState: "draft" as const,
    };
    const emptyLines = await asOwner.mutation(createRfqRef, {
      ...base,
      lineItems: [],
    });
    expect(emptyLines.ok).toBe(false);
    const badQuantity = await asOwner.mutation(createRfqRef, {
      ...base,
      lineItems: [{ itemId: "m", description: "Machine", quantity: "lots", unit: "piece" }],
    });
    expect(badQuantity.ok).toBe(false);
    const { conversationId } = await setupGrantAndConversation(t, project.orgId, project.projectId);
    const bound = await asOwner.mutation(createRfqRef, {
      ...base,
      lineItems: [rfqLine("machine")],
      conversationId,
    });
    if (!bound.ok) throw new Error("bound rfq failed");
    const stored = await t.run(async (ctx) => ctx.db.get(bound.rfqId));
    expect(stored?.conversationId).toBe(conversationId);
    expect(stored?.lineItems).toHaveLength(1);
    // A conversation from another project never binds.
    const projectB = await setupProject(t, OWNER_B, "rfq-bind-b");
    const foreign = await setupGrantAndConversation(t, projectB.orgId, projectB.projectId);
    const crossBound = await asOwner.mutation(createRfqRef, {
      ...base,
      idempotencyKey: "rfq-bind-2",
      lineItems: [rfqLine("machine")],
      conversationId: foreign.conversationId,
    });
    expect(crossBound.ok).toBe(false);
    if (!crossBound.ok) expect(crossBound.code).toBe("denied-project");
    // Divergent line items under one key collide instead of merging.
    const collision = await asOwner.mutation(createRfqRef, {
      ...base,
      lineItems: [rfqLine("machine"), rfqLine("grinder")],
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.code).toBe("duplicate-conflict");
  });

  test("negotiations pin exact quote version, currency, and conversation", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "neg-pin");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const { conversationId } = await setupGrantAndConversation(t, project.orgId, project.projectId);
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(
      project.orgId,
      project.projectId,
      "q-pin-1",
      { requirementId: graph.requirementId, vendorId: graph.vendorId, conversationId },
    ));
    if (!quote.ok) throw new Error("quote failed");
    const negotiation = await asOwner.mutation(openNegotiationRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      quoteId: quote.quoteId,
      mandateHash: "mandate-pin",
      roundLimit: 3,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!negotiation.ok) throw new Error("negotiation failed");
    const stored = await t.run(async (ctx) => ctx.db.get(negotiation.negotiationId));
    expect(stored?.quoteVersion).toBe("q-pin-1");
    expect(stored?.currency).toBe("EUR");
    expect(stored?.conversationId).toBe(conversationId);
  });

  test("watches link allowance, advance next checks, and separate sources", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "watch-src");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const { grantId } = await setupGrantAndConversation(t, project.orgId, project.projectId);
    const jobId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jobs", {
        organizationId: project.orgId,
        projectId: project.projectId,
        grantId,
        grantVersion: 1,
        kind: "research",
        state: "running",
        inputVersions: {},
        createdAt: now,
        updatedAt: now,
      });
    });
    const watch = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      jobId,
      targetKind: "candidate",
      targetId: graph.candidateId,
      cadenceMs: 3_600_000,
      counterpartyRole: "ownerStandIn",
      idempotencyKey: "watch-src-1",
    });
    if (!watch.ok) throw new Error("watch failed");
    const created = await t.run(async (ctx) => ctx.db.get(watch.watchId));
    expect(created?.jobId).toBe(jobId);
    expect(created?.source).toBe("ownerImport");
    const firstCheck = created?.nextCheckAt ?? 0;
    const checked = await asOwner.mutation(checkWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      watchId: watch.watchId,
      result: "stale",
    });
    expect(checked.ok).toBe(true);
    const after = await t.run(async (ctx) => ctx.db.get(watch.watchId));
    expect((after?.nextCheckAt ?? 0) >= firstCheck).toBe(true);
    // A job from another project never links.
    const projectB = await setupProject(t, OWNER_B, "watch-src-b");
    const foreign = await setupGrantAndConversation(t, projectB.orgId, projectB.projectId);
    const foreignJob = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("jobs", {
        organizationId: projectB.orgId,
        projectId: projectB.projectId,
        grantId: foreign.grantId,
        grantVersion: 1,
        kind: "research",
        state: "running",
        inputVersions: {},
        createdAt: now,
        updatedAt: now,
      });
    });
    const crossLinked = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      jobId: foreignJob,
      targetKind: "candidate",
      targetId: graph.candidateId,
      cadenceMs: 3_600_000,
      counterpartyRole: "vendor",
      idempotencyKey: "watch-src-2",
    });
    expect(crossLinked.ok).toBe(false);
    if (!crossLinked.ok) expect(crossLinked.code).toBe("denied-project");
    // The internal pipeline stamps internal source; owner checks on an
    // internal watch are refused.
    const ingested = await t.mutation(ingestWatchCheckRef, {
      watchId: watch.watchId,
      result: "ok",
    });
    expect(ingested.ok).toBe(true);
    const internal = await t.run(async (ctx) => ctx.db.get(watch.watchId));
    expect(internal?.source).toBe("internal");
    const ownerRecheck = await asOwner.mutation(checkWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      watchId: watch.watchId,
      result: "ok",
    });
    expect(ownerRecheck.ok).toBe(false);
  });

  test("risks reference dependencies and only approvers accept", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "risk-gate");
    const asOwner = t.withIdentity(OWNER_A);
    const first = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-r1",
      title: "R1",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P1",
    });
    if (!first.ok) throw new Error("req failed");
    const second = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-r2",
      title: "R2",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P1",
    });
    if (!second.ok) throw new Error("req failed");
    const edge = await asOwner.mutation(addDependencyRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      fromRequirementId: first.requirementId,
      toRequirementId: second.requirementId,
      kind: "scheduling",
    });
    if (!edge.ok) throw new Error("edge failed");
    const risk = await asOwner.mutation(raiseRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "req-r1",
      severity: "critical",
      source: "dependency",
      dependencyIds: [edge.dependencyId],
    });
    if (!risk.ok) throw new Error("risk failed");
    const stored = await t.run(async (ctx) => ctx.db.get(risk.riskId));
    expect(stored?.dependencyIds).toEqual([edge.dependencyId]);
    // A dependency from another project never attaches.
    const projectB = await setupProject(t, OWNER_B, "risk-gate-b");
    const foreignDep = await t.run(async (ctx) =>
      ctx.db.insert("dependencies", {
        organizationId: projectB.orgId,
        projectId: projectB.projectId,
        fromRequirementId: first.requirementId,
        toRequirementId: second.requirementId,
        kind: "technical",
        verification: "pending",
        createdAt: Date.now(),
      }),
    );
    const crossRisk = await asOwner.mutation(raiseRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "cross",
      severity: "high",
      source: "dependency",
      dependencyIds: [foreignDep],
    });
    expect(crossRisk.ok).toBe(false);
    if (!crossRisk.ok) expect(crossRisk.code).toBe("denied-project");
    // Contributors mitigate but never terminally accept.
    const CONTRIB = { tokenIdentifier: "domain-contrib-risk" };
    const granted = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetIdentity: CONTRIB.tokenIdentifier,
      role: "contributor",
    });
    expect(granted.ok).toBe(true);
    const asContrib = t.withIdentity(CONTRIB);
    const mitigating = await asContrib.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "mitigating",
    });
    expect(mitigating.ok).toBe(true);
    const accepted = await asContrib.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "accepted",
    });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.code).toBe("denied-capability");
    const approved = await asOwner.mutation(resolveRiskRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      riskId: risk.riskId,
      state: "accepted",
    });
    expect(approved.ok).toBe(true);
    const settled = await t.run(async (ctx) => ctx.db.get(risk.riskId));
    expect(settled?.acceptedBy).toBe(OWNER_A.tokenIdentifier);
    expect(settled?.decidedAt).toBeGreaterThan(0);
  });

  test("templates replay exactly and reject bad graphs before writes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "template-exact");
    const asOwner = t.withIdentity(OWNER_A);
    const item = (key: string) => ({
      key,
      title: `Item ${key}`,
      category: "cat",
      quantity: "1",
      unit: "piece",
    });
    const save = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "exact",
      version: "v1",
      requirementSnapshot: JSON.stringify([item("a"), item("b")]),
      constraintSnapshot: JSON.stringify([{ fromKey: "a", toKey: "b", kind: "technical" }]),
    });
    if (!save.ok || save.deduplicated) throw new Error("save failed");
    const saveReplay = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "exact",
      version: "v1",
      requirementSnapshot: JSON.stringify([item("a"), item("b")]),
      constraintSnapshot: JSON.stringify([{ fromKey: "a", toKey: "b", kind: "technical" }]),
    });
    if (!saveReplay.ok) throw new Error("save replay failed");
    expect(saveReplay.deduplicated).toBe(true);
    expect(saveReplay.templateId).toBe(save.templateId);
    const saveCollision = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "renamed",
      version: "v1",
      requirementSnapshot: JSON.stringify([item("a")]),
      constraintSnapshot: JSON.stringify([]),
    });
    expect(saveCollision.ok).toBe(false);
    if (!saveCollision.ok) expect(saveCollision.code).toBe("duplicate-conflict");
    const target = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "exact target",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target failed");
    const first = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: save.templateId,
    });
    if (!first.ok || first.deduplicated) throw new Error("instantiate failed");
    expect(first.requirementIds).toHaveLength(2);
    const replay = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: save.templateId,
    });
    if (!replay.ok) throw new Error("instantiate replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.requirementIds).toEqual(first.requirementIds);
    // Bad graphs deny whole with zero writes: duplicate keys, unknown
    // endpoints, self edges, and cycles.
    const badGraphs: [string, unknown[], unknown[]][] = [
      ["dup-keys", [item("x"), item("x")], []],
      ["unknown-endpoint", [item("x")], [{ fromKey: "x", toKey: "ghost", kind: "technical" }]],
      ["self-edge", [item("x")], [{ fromKey: "x", toKey: "x", kind: "scheduling" }]],
      ["cycle", [item("x"), item("y")], [
        { fromKey: "x", toKey: "y", kind: "technical" },
        { fromKey: "y", toKey: "x", kind: "technical" },
      ]],
    ];
    for (const [name, reqs, cons] of badGraphs) {
      const bad = await asOwner.mutation(saveTemplateRef, {
        organizationId: project.orgId,
        sourceProjectId: project.projectId,
        name: `bad-${name}`,
        version: `bad-${name}`,
        requirementSnapshot: JSON.stringify(reqs),
        constraintSnapshot: JSON.stringify(cons),
      });
      if (!bad.ok) throw new Error(`bad template ${name} failed to save`);
      const fresh = await asOwner.mutation(createProjectRef, {
        organizationId: project.orgId,
        name: `bad target ${name}`,
        visibility: "open",
      });
      if (!fresh.ok) throw new Error("fresh target failed");
      const denied = await asOwner.mutation(instantiateTemplateRef, {
        organizationId: project.orgId,
        targetProjectId: fresh.projectId,
        templateId: bad.templateId,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("invalid-payload");
      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("requirements")
          .withIndex("by_project", (q) => q.eq("projectId", fresh.projectId))
          .take(100),
      );
      expect(rows).toHaveLength(0);
    }
  });

  test("selection and cost lineage refuse mixed currency and zero cash", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, OWNER_A, "money-line");
    const asOwner = t.withIdentity(OWNER_A);
    const graph = await setupSourcingGraph(t, OWNER_A, project);
    const usd = await asOwner.mutation(createRequirementRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      key: "req-usd",
      title: "USD scope",
      category: "cat",
      quantity: "1",
      unit: "piece",
      priority: "P1",
      currency: "USD",
    });
    if (!usd.ok) throw new Error("usd requirement failed");
    const usdCandidate = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: usd.requirementId,
      vendorId: graph.vendorId,
      productModel: "Linea Mini",
      variant: "Black 220V",
      conversationState: "draft",
    });
    if (!usdCandidate.ok) throw new Error("usd candidate failed");
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project.orgId, project.projectId, "q-ml-1"));
    if (!quote.ok) throw new Error("quote failed");
    const mixed = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: usd.requirementId,
      candidateId: usdCandidate.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-ml-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-mixed-currency",
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.code).toBe("invalid-payload");
    const zeroQuantity = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-ml-1",
      quantity: "0",
      requirementVersion: 1,
      idempotencyKey: "selection-zero-quantity",
    });
    expect(zeroQuantity.ok).toBe(false);
    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: quote.quoteId,
      quoteVersion: "q-ml-1",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "selection-cost-lineage",
    });
    if (!selection.ok) throw new Error("selection failed");
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-ml-1",
      orderedQuantity: "1",
    });
    if (!order.ok) throw new Error("order failed");
    const foreignCash = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "USD", minorUnits: 100 },
      idempotencyKey: "pay-ml-1",
    });
    expect(foreignCash.ok).toBe(false);
    if (!foreignCash.ok) expect(foreignCash.code).toBe("invalid-payload");
    const zeroCash = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 0 },
      idempotencyKey: "pay-ml-2",
    });
    expect(zeroCash.ok).toBe(false);
  });
});
