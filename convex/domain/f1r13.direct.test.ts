/// <reference types="vite/client" />
/**
 * F1R-13 durable line lineage (controlled contract, PRD P-06/P-08/P-10/P-14,
 * ADR-0003).
 *
 * Runs the ACTUAL exported domain handlers against the REAL schema with
 * authenticated identities via official convex-test. No provider calls.
 *
 * Positive journey (two machines + ten chairs on one multi-item quote):
 * - explicit selection lines with normalized quantities and units;
 * - a partial order with unequal ordered quantities per line;
 * - partial delivery/acceptance tracked per order line;
 * - a one-chair credit with exact immutable evidence and a linked refund;
 * - idempotent replay of every write after an authorized query reload,
 *   rebuilt from the lineage payload alone (no description parsing);
 * - stored ids, quantities, units, evidence hashes, and links sufficient
 *   for accepted-quantity calculation.
 *
 * Negative no-write cases: ambiguous legacy scalars on multi-line
 * quotes/selections/orders, missing or foreign lines, over-order and
 * per-line over-acceptance, foreign or hash-mismatched evidence, changed
 * replay fields, invalid cross-line/cross-order links, and actor/project
 * isolation.
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
import { canonicalJson } from "../shared/hashing.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as evidence from "../purchasing/contracts/evidence.js";
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
const createRfqRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.createRfq>,
  MutationReturn<typeof sourcing.createRfq>
>("domain/sourcing:createRfq");
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const recordEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof evidence.record>,
  MutationReturn<typeof evidence.record>
>("purchasing/contracts/evidence:record");
const recordSelectionRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.recordSelection>,
  MutationReturn<typeof decisions.recordSelection>
>("domain/decisions:recordSelection");
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
const recordCostEntryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordCostEntry>,
  MutationReturn<typeof fulfillment.recordCostEntry>
>("domain/fulfillment:recordCostEntry");
const getOrderLineageRef = makeFunctionReference<
  "query",
  QueryArgs<typeof fulfillment.getOrderLineage>,
  QueryReturn<typeof fulfillment.getOrderLineage>
>("domain/fulfillment:getOrderLineage");

const OWNER = { tokenIdentifier: "f1r13-owner" };
const OTHER_ACTOR = { tokenIdentifier: "f1r13-other-actor" };
const STRANGER = { tokenIdentifier: "f1r13-stranger" };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function setupProject(t: ReturnType<typeof convexTest>, name: string) {
  const asOwner = t.withIdentity(OWNER);
  const org = await asOwner.mutation(createOrganizationRef, { name: `${name} org`, kind: "private" });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asOwner.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!proj.ok) throw new Error("project setup failed");
  return { orgId: org.organizationId, projectId: proj.projectId };
}

type Project = { orgId: Id<"organizations">; projectId: Id<"projects"> };

/**
 * Two machines plus ten chairs on one multi-item quote with a
 * quote-level shared freight charge (never allocated to lines).
 */
async function setupTwoLineGraph(t: ReturnType<typeof convexTest>, project: Project, suffix: string) {
  const asOwner = t.withIdentity(OWNER);
  const req = await asOwner.mutation(createRequirementRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    key: `req-${suffix}`,
    title: `Cafe fit-out ${suffix}`,
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0",
  });
  if (!req.ok) throw new Error("requirement setup failed");
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.orgId,
    name: `Vendor ${suffix}`,
    regions: ["NL"],
  });
  if (!vendor.ok) throw new Error("vendor setup failed");
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: req.requirementId,
    vendorId: vendor.vendorId,
    productModel: `Fitout ${suffix}`,
    variant: "220V",
    conversationState: "draft",
  });
  if (!candidate.ok) throw new Error("candidate setup failed");
  const rfq = await asOwner.mutation(createRfqRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: req.requirementId,
    idempotencyKey: `rfq-${suffix}`,
    scenarioVendorIds: [vendor.vendorId],
    lineItems: [
      { itemId: "machine", description: "Espresso machine", quantity: "2", unit: "piece" },
      { itemId: "chair", description: "Cafe chair", quantity: "10", unit: "piece" },
    ],
    briefHash: "brief-f1r13",
    conversationState: "draft",
  });
  if (!rfq.ok) throw new Error("rfq setup failed");
  const quote = await asOwner.mutation(recordQuoteRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    version: `v-${suffix}`,
    currency: "EUR",
    lines: [
      {
        lineId: "machine",
        description: "Espresso machine",
        quantity: "2",
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      },
      {
        lineId: "chair",
        description: "Cafe chair",
        quantity: "10",
        unitPrice: { currency: "EUR", minorUnits: 5000 },
        evidenceRefs: [],
      },
    ],
    charges: [
      {
        chargeId: "freight",
        label: "Shared freight",
        scope: { kind: "quote" as const },
        state: { kind: "known" as const, amount: { currency: "EUR", minorUnits: 12000 } },
        evidenceRefs: [],
      },
    ],
    taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
    comparisonScope: {
      requirementId: `req-${suffix}`,
      scopeId: `scope-${suffix}`,
      items: [
        { itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "2" },
        { itemId: "chair", lineId: "chair", unit: "piece", requiredQuantity: "10" },
      ],
    },
    evidenceRefs: [],
    requirementId: req.requirementId,
    vendorId: vendor.vendorId,
    rfqId: rfq.rfqId,
  });
  if (!quote.ok) throw new Error(`quote setup failed: ${JSON.stringify(quote)}`);
  return {
    requirementId: req.requirementId,
    candidateId: candidate.candidateId,
    vendorId: vendor.vendorId,
    rfqId: rfq.rfqId,
    quoteId: quote.quoteId,
    contentHash: quote.contentHash,
  };
}

/** Extra single-line machine quote in the same offer lineage. */
async function recordMachineQuote(
  t: ReturnType<typeof convexTest>,
  project: Project,
  refs: { requirementId: Id<"requirements">; vendorId: Id<"vendors">; rfqId: Id<"rfqs"> },
  version: string,
  machineQty: string,
  suffix: string,
  supersedes?: string,
) {
  return t.withIdentity(OWNER).mutation(recordQuoteRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    version,
    currency: "EUR",
    lines: [
      {
        lineId: "machine",
        description: "Espresso machine",
        quantity: machineQty,
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      },
    ],
    charges: [],
    taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
    comparisonScope: {
      requirementId: `req-${suffix}`,
      scopeId: `scope-${suffix}-single`,
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: machineQty }],
    },
    evidenceRefs: [],
    requirementId: refs.requirementId,
    vendorId: refs.vendorId,
    rfqId: refs.rfqId,
    ...(supersedes === undefined ? {} : { supersedes }),
  });
}

async function tableCounts(t: ReturnType<typeof convexTest>, project: Project) {
  const [selections, orders, events, entries] = await Promise.all([
    t.run((ctx) => ctx.db.query("selections").collect()),
    t.run((ctx) => ctx.db.query("orders").collect()),
    t.run((ctx) => ctx.db.query("orderEvents").collect()),
    t.run((ctx) => ctx.db.query("costEntries").collect()),
  ]);
  const inProject = <T extends { projectId: unknown }>(rows: T[]) =>
    rows.filter((row) => row.projectId === project.projectId).length;
  return {
    selections: inProject(selections),
    orders: inProject(orders),
    events: inProject(events),
    entries: inProject(entries),
  };
}

describe("F1R-13 multi-line selection, order, acceptance, and adjustment journey", () => {
  test("two machines and ten chairs flow per line with exact evidence", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "journey");
    const graph = await setupTwoLineGraph(t, project, "journey");
    const asOwner = t.withIdentity(OWNER);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-journey",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2.0", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-journey",
    });
    if (!selection.ok) throw new Error(`selection failed: ${JSON.stringify(selection)}`);
    expect(selection.deduplicated).toBe(false);

    // Partial order with unequal quantities per line: 1 of 2 machines,
    // 8 of 10 chairs.
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-journey",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8.00", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error(`order failed: ${JSON.stringify(order)}`);

    // Partial delivery/acceptance per line: the machine fully accepted,
    // five of eight chairs accepted.
    const deliveredMachine = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "partialDelivery",
      acceptanceLines: [{ quoteLineId: "machine", acceptedQuantity: "1", unit: "piece" }],
      idempotencyKey: "evt-machine",
    });
    if (!deliveredMachine.ok) throw new Error(`machine event failed: ${JSON.stringify(deliveredMachine)}`);
    const acceptedChairs = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "5", unit: "piece" }],
      idempotencyKey: "evt-chairs",
    });
    if (!acceptedChairs.ok) throw new Error(`chair event failed: ${JSON.stringify(acceptedChairs)}`);

    // A one-chair credit with exact immutable evidence and a linked refund.
    const creditHash = await sha256Hex("credit-note-one-chair");
    const creditEvidence = await asOwner.mutation(recordEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      sourceKind: "supplier-credit-note",
      contentHash: creditHash,
      completeness: "complete",
    });
    if (!creditEvidence.ok) throw new Error("credit evidence setup failed");
    const credit = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "credit-chair-1",
      quoteLineId: "chair",
      affectedQuantity: "1.0",
      affectedUnit: "piece",
      evidenceRefs: [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }],
    });
    if (!credit.ok) throw new Error(`credit failed: ${JSON.stringify(credit)}`);
    const refund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-chair-1",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }],
    });
    if (!refund.ok) throw new Error(`refund failed: ${JSON.stringify(refund)}`);

    // An order-level payment stays order-level with no line fields.
    const payment = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-journey",
    });
    if (!payment.ok) throw new Error(`payment failed: ${JSON.stringify(payment)}`);

    // Authorized reload exposes every stored id, quantity, unit, hash,
    // and link needed for accepted calculation.
    const lineage = await asOwner.query(getOrderLineageRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
    });
    if (!lineage.ok) throw new Error(`lineage failed: ${JSON.stringify(lineage)}`);
    expect(lineage.selection.selectionLines).toEqual([
      { quoteLineId: "chair", quantity: "10", unit: "piece" },
      { quoteLineId: "machine", quantity: "2", unit: "piece" },
    ]);
    expect(lineage.orderLines).toEqual([
      { quoteLineId: "chair", quantity: "8", unit: "piece" },
      { quoteLineId: "machine", quantity: "1", unit: "piece" },
    ]);
    expect(lineage.acceptedByLine).toEqual([
      { quoteLineId: "machine", acceptedQuantity: "1", unit: "piece" },
      { quoteLineId: "chair", acceptedQuantity: "5", unit: "piece" },
    ]);
    expect(lineage.quote.lines).toEqual([
      { lineId: "machine", description: "Espresso machine", quantity: "2", unitPrice: { currency: "EUR", minorUnits: 795000 } },
      { lineId: "chair", description: "Cafe chair", quantity: "10", unitPrice: { currency: "EUR", minorUnits: 5000 } },
    ]);
    // Shared freight stays quote-level; nothing allocates it to a line.
    expect(lineage.quote.charges).toEqual([
      { chargeId: "freight", label: "Shared freight", scope: { kind: "quote" } },
    ]);
    const creditRow = lineage.costEntries.find((entry) => entry.id === credit.entryId);
    expect(creditRow).toMatchObject({
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }],
    });
    const refundRow = lineage.costEntries.find((entry) => entry.id === refund.entryId);
    expect(refundRow).toMatchObject({
      kind: "refund",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
    });
    const paymentRow = lineage.costEntries.find((entry) => entry.id === payment.entryId);
    expect(paymentRow?.quoteLineId).toBeUndefined();
    expect(lineage.events).toHaveLength(2);

    // Per-line accepted math from stored lineage alone: 1 of 1 machines
    // and 5 of 8 chairs accepted, with one chair credited.
    const byLine = new Map(lineage.acceptedByLine.map((line) => [line.quoteLineId, line.acceptedQuantity]));
    expect(byLine.get("machine")).toBe("1");
    expect(byLine.get("chair")).toBe("5");

    // Idempotent replay after the authorized reload: payloads rebuilt
    // from the lineage response return the same rows.
    const replaySelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-journey",
      selectionLines: lineage.selection.selectionLines.map((line) => ({ ...line })),
      requirementVersion: 1,
      idempotencyKey: "sel-journey",
    });
    if (!replaySelection.ok) throw new Error("selection replay failed");
    expect(replaySelection.deduplicated).toBe(true);
    expect(replaySelection.selectionId).toBe(selection.selectionId);
    const replayOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-journey",
      orderLines: lineage.orderLines.map((line) => ({ ...line })),
    });
    if (!replayOrder.ok) throw new Error("order replay failed");
    expect(replayOrder.deduplicated).toBe(true);
    expect(replayOrder.orderId).toBe(order.orderId);
    const replayEvent = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "5.0", unit: "piece" }],
      idempotencyKey: "evt-chairs",
    });
    if (!replayEvent.ok) throw new Error("event replay failed");
    expect(replayEvent.deduplicated).toBe(true);
    expect(replayEvent.eventId).toBe(acceptedChairs.eventId);
    const replayCredit = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "credit-chair-1",
      quoteLineId: "chair",
      affectedQuantity: "1.00",
      affectedUnit: "piece",
      evidenceRefs: [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }],
    });
    if (!replayCredit.ok) throw new Error("credit replay failed");
    expect(replayCredit.deduplicated).toBe(true);
    expect(replayCredit.entryId).toBe(credit.entryId);
    const replayRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-chair-1",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }],
    });
    if (!replayRefund.ok) throw new Error("refund replay failed");
    expect(replayRefund.deduplicated).toBe(true);
    expect(replayRefund.entryId).toBe(refund.entryId);

    const counts = await tableCounts(t, project);
    expect(counts).toEqual({ selections: 1, orders: 1, events: 2, entries: 3 });
  });
});

describe("F1R-13 legacy derived-key migration and quote-quantity caps", () => {
  test("a seeded pre-F1R-13 over-quote row still replays after supersession", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "legacy-key");
    const graph = await setupTwoLineGraph(t, project, "legacy-key");
    const asOwner = t.withIdentity(OWNER);

    const v1 = await recordMachineQuote(t, project, graph, "v-single", "2", "legacy-key");
    if (!v1.ok) throw new Error(`single-line quote failed: ${JSON.stringify(v1)}`);

    // A genuine pre-F1R-13 row: scalar quantity only, no selectionLines,
    // keyed by the exact old derived canonical payload. It deliberately
    // exceeds the quoted quantity (3 of 2): the new cap must not break
    // its exact historical replay.
    const legacyKey = `legacy:${canonicalJson({
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v1.quoteId,
      quoteVersion: "v-single",
      quantity: "3",
      requirementVersion: 1,
      actor: OWNER.tokenIdentifier,
    })}`;
    const seededId = await t.run((ctx) =>
      ctx.db.insert("selections", {
        organizationId: project.orgId,
        projectId: project.projectId,
        idempotencyKey: legacyKey,
        requirementId: graph.requirementId,
        candidateId: graph.candidateId,
        quoteId: v1.quoteId,
        quoteVersion: "v-single",
        quantity: "3",
        requirementVersion: 1,
        actor: OWNER.tokenIdentifier,
        createdAt: Date.now(),
      }),
    );

    const v2 = await recordMachineQuote(t, project, graph, "v-single-2", "2", "legacy-key", v1.contentHash);
    if (!v2.ok) throw new Error(`superseding quote failed: ${JSON.stringify(v2)}`);

    // The same no-key scalar retry resolves the identical derived key
    // and returns the seeded row despite supersession and the new cap.
    const replay = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v1.quoteId,
      quoteVersion: "v-single",
      quantity: "3.0",
      requirementVersion: 1,
    });
    if (!replay.ok) throw new Error(`legacy replay failed: ${JSON.stringify(replay)}`);
    expect(replay.deduplicated).toBe(true);
    expect(replay.selectionId).toBe(seededId);

    // A new key with the same over-selection is rejected with no write:
    // the cap governs new authority, never historical replay.
    const freshOver = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v1.quoteId,
      quoteVersion: "v-single",
      quantity: "3",
      requirementVersion: 1,
      idempotencyKey: "sel-fresh-over",
    });
    expect(freshOver.ok).toBe(false);

    const rows = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(1);
  });

  test("over-selection is rejected per line while partial selection is preserved", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "caps");
    const graph = await setupTwoLineGraph(t, project, "caps");
    const asOwner = t.withIdentity(OWNER);

    const single = await recordMachineQuote(t, project, graph, "v-cap-single", "2", "caps");
    if (!single.ok) throw new Error("single-line quote setup failed");

    // Legacy scalar over-selection on a single-line quote writes nothing.
    const legacyOver = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: single.quoteId,
      quoteVersion: "v-cap-single",
      quantity: "3",
      requirementVersion: 1,
      idempotencyKey: "sel-cap-legacy-over",
    });
    expect(legacyOver.ok).toBe(false);

    // Explicit over-selection on one line writes nothing even though the
    // other line is a preserved partial quantity.
    const explicitOver = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-caps",
      selectionLines: [
        { quoteLineId: "machine", quantity: "3", unit: "piece" },
        { quoteLineId: "chair", quantity: "5", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-cap-explicit-over",
    });
    expect(explicitOver.ok).toBe(false);

    // Partial selection on both lines is preserved.
    const partial = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-caps",
      selectionLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "5", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-cap-partial",
    });
    if (!partial.ok) throw new Error(`partial selection failed: ${JSON.stringify(partial)}`);

    const rows = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(1);
  });
});

describe("F1R-13 ambiguous, unknown, and over-limit line inputs write nothing", () => {
  test("legacy scalars and mixed forms are rejected on multi-line quotes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "ambiguous");
    const graph = await setupTwoLineGraph(t, project, "ambiguous");
    const asOwner = t.withIdentity(OWNER);
    const before = await tableCounts(t, project);

    const scalarSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-ambiguous",
      quantity: "12",
      requirementVersion: 1,
      idempotencyKey: "sel-ambiguous",
    });
    expect(scalarSelection.ok).toBe(false);

    const mixedSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-ambiguous",
      quantity: "2",
      selectionLines: [{ quoteLineId: "machine", quantity: "2", unit: "piece" }],
      requirementVersion: 1,
      idempotencyKey: "sel-mixed",
    });
    expect(mixedSelection.ok).toBe(false);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-ambiguous",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-ambiguous-ok",
    });
    if (!selection.ok) throw new Error("selection setup failed");

    const scalarOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-ambiguous",
      orderedQuantity: "9",
    });
    expect(scalarOrder.ok).toBe(false);

    const mixedOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-mixed",
      orderedQuantity: "1",
      orderLines: [{ quoteLineId: "machine", quantity: "1", unit: "piece" }],
    });
    expect(mixedOrder.ok).toBe(false);

    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-ambiguous-ok",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error("order setup failed");

    const scalarEvent = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptedQuantity: "3",
      idempotencyKey: "evt-ambiguous",
    });
    expect(scalarEvent.ok).toBe(false);

    const mixedEvent = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptedQuantity: "3",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "3", unit: "piece" }],
      idempotencyKey: "evt-mixed",
    });
    expect(mixedEvent.ok).toBe(false);

    const after = await tableCounts(t, project);
    expect(after).toEqual({ selections: 1, orders: 1, events: 0, entries: 0 });
    expect(before.selections).toBe(0);
  });

  test("missing lines, over-order, and per-line over-acceptance are rejected", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "limits");
    const graph = await setupTwoLineGraph(t, project, "limits");
    const asOwner = t.withIdentity(OWNER);

    const ghostSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-limits",
      selectionLines: [{ quoteLineId: "ghost", quantity: "1", unit: "piece" }],
      requirementVersion: 1,
      idempotencyKey: "sel-ghost",
    });
    expect(ghostSelection.ok).toBe(false);

    const duplicateSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-limits",
      selectionLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-duplicate",
    });
    expect(duplicateSelection.ok).toBe(false);

    const unitMismatch = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-limits",
      selectionLines: [{ quoteLineId: "machine", quantity: "1", unit: "box" }],
      requirementVersion: 1,
      idempotencyKey: "sel-unit",
    });
    expect(unitMismatch.ok).toBe(false);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-limits",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-limits",
    });
    if (!selection.ok) throw new Error("selection setup failed");

    const overOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-over",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "11", unit: "piece" },
      ],
    });
    expect(overOrder.ok).toBe(false);

    const foreignOrderLine = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-foreign-line",
      orderLines: [{ quoteLineId: "ghost", quantity: "1", unit: "piece" }],
    });
    expect(foreignOrderLine.ok).toBe(false);

    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-limits",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error("order setup failed");

    // Nine chairs exceed the chair line (8) even though the order total
    // (9) still fits: caps apply per line, never across the order.
    const overAcceptChairs = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "9", unit: "piece" }],
      idempotencyKey: "evt-over-chairs",
    });
    expect(overAcceptChairs.ok).toBe(false);

    const overAcceptMachine = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "machine", acceptedQuantity: "2", unit: "piece" }],
      idempotencyKey: "evt-over-machine",
    });
    expect(overAcceptMachine.ok).toBe(false);

    const ghostEvent = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "ghost", acceptedQuantity: "1", unit: "piece" }],
      idempotencyKey: "evt-ghost",
    });
    expect(ghostEvent.ok).toBe(false);

    const partial = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "8", unit: "piece" }],
      idempotencyKey: "evt-full-chairs",
    });
    if (!partial.ok) throw new Error("chair acceptance setup failed");

    // The chair line is now fully accepted: one more chair over-accepts
    // per line even though it is a separate event.
    const secondOverAccept = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "1", unit: "piece" }],
      idempotencyKey: "evt-second-over",
    });
    expect(secondOverAccept.ok).toBe(false);

    const after = await tableCounts(t, project);
    expect(after).toEqual({ selections: 1, orders: 1, events: 1, entries: 0 });
  });
});

describe("F1R-13 financial evidence and linked adjustments", () => {
  test("foreign, mismatched, and missing evidence write nothing", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "evidence");
    const other = await setupProject(t, "evidence-other");
    const graph = await setupTwoLineGraph(t, project, "evidence");
    const asOwner = t.withIdentity(OWNER);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-evidence",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-evidence",
    });
    if (!selection.ok) throw new Error("selection setup failed");
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-evidence",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error("order setup failed");

    const localHash = await sha256Hex("local-credit-note");
    const localEvidence = await asOwner.mutation(recordEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      sourceKind: "supplier-credit-note",
      contentHash: localHash,
      completeness: "complete",
    });
    if (!localEvidence.ok) throw new Error("local evidence setup failed");
    const foreignEvidence = await asOwner.mutation(recordEvidenceRef, {
      organizationId: other.orgId,
      projectId: other.projectId,
      sourceKind: "supplier-credit-note",
      contentHash: await sha256Hex("foreign-credit-note"),
      completeness: "complete",
    });
    if (!foreignEvidence.ok) throw new Error("foreign evidence setup failed");

    const lineArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit" as const,
      amount: { currency: "EUR", minorUnits: 5000 },
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
    };
    const foreign = await asOwner.mutation(recordCostEntryRef, {
      ...lineArgs,
      idempotencyKey: "credit-foreign",
      evidenceRefs: [{
        evidenceId: foreignEvidence.evidenceId,
        contentHash: await sha256Hex("foreign-credit-note"),
      }],
    });
    expect(foreign.ok).toBe(false);

    const mismatched = await asOwner.mutation(recordCostEntryRef, {
      ...lineArgs,
      idempotencyKey: "credit-mismatch",
      evidenceRefs: [{ evidenceId: localEvidence.evidenceId, contentHash: await sha256Hex("wrong-hash") }],
    });
    expect(mismatched.ok).toBe(false);

    const missingLine = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "credit-no-line",
      evidenceRefs: [{ evidenceId: localEvidence.evidenceId, contentHash: localHash }],
    });
    expect(missingLine.ok).toBe(false);

    const missingEvidence = await asOwner.mutation(recordCostEntryRef, {
      ...lineArgs,
      idempotencyKey: "credit-no-evidence",
    });
    expect(missingEvidence.ok).toBe(false);

    const partialTriple = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 1000 },
      idempotencyKey: "pay-partial",
      quoteLineId: "chair",
    });
    expect(partialTriple.ok).toBe(false);

    const after = await tableCounts(t, project);
    expect(after.entries).toBe(0);
  });

  test("changed replays conflict and invalid links are rejected", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "links");
    const graph = await setupTwoLineGraph(t, project, "links");
    const asOwner = t.withIdentity(OWNER);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-links",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-links",
    });
    if (!selection.ok) throw new Error("selection setup failed");

    const changedSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-links",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "9", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-links",
    });
    expect(changedSelection).toMatchObject({ ok: false, code: "duplicate-conflict" });

    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-links",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error("order setup failed");

    const changedOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-links",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "7", unit: "piece" },
      ],
    });
    expect(changedOrder).toMatchObject({ ok: false, code: "duplicate-conflict" });

    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "2", unit: "piece" }],
      idempotencyKey: "evt-links",
    });
    if (!event.ok) throw new Error("event setup failed");

    const changedEvent = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "acceptance",
      acceptanceLines: [{ quoteLineId: "chair", acceptedQuantity: "3", unit: "piece" }],
      idempotencyKey: "evt-links",
    });
    expect(changedEvent).toMatchObject({ ok: false, code: "duplicate-conflict" });

    const creditHash = await sha256Hex("links-credit-note");
    const creditEvidence = await asOwner.mutation(recordEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      sourceKind: "supplier-credit-note",
      contentHash: creditHash,
      completeness: "complete",
    });
    if (!creditEvidence.ok) throw new Error("evidence setup failed");
    const refs = [{ evidenceId: creditEvidence.evidenceId, contentHash: creditHash }];
    const creditArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit" as const,
      amount: { currency: "EUR", minorUnits: 5000 },
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    };
    const credit = await asOwner.mutation(recordCostEntryRef, { ...creditArgs, idempotencyKey: "credit-links" });
    if (!credit.ok) throw new Error(`credit setup failed: ${JSON.stringify(credit)}`);

    const changedCredit = await asOwner.mutation(recordCostEntryRef, {
      ...creditArgs,
      idempotencyKey: "credit-links",
      affectedQuantity: "2",
    });
    expect(changedCredit).toMatchObject({ ok: false, code: "duplicate-conflict" });

    // A refund on another line cannot link this chair credit.
    const crossLineRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-cross-line",
      linkedEntryId: credit.entryId,
      quoteLineId: "machine",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    expect(crossLineRefund.ok).toBe(false);

    const refund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-links",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!refund.ok) throw new Error(`refund setup failed: ${JSON.stringify(refund)}`);

    // Neither side pairs twice: a second refund on the same credit
    // would double-count the one-chair adjustment.
    const doubleRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-double",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    expect(doubleRefund.ok).toBe(false);

    // Same-kind links are not a valid credit/refund relationship.
    const secondCredit = await asOwner.mutation(recordCostEntryRef, {
      ...creditArgs,
      idempotencyKey: "credit-second",
    });
    if (!secondCredit.ok) throw new Error("second credit setup failed");
    const sameKindLink = await asOwner.mutation(recordCostEntryRef, {
      ...creditArgs,
      idempotencyKey: "credit-same-kind",
      linkedEntryId: secondCredit.entryId,
    });
    expect(sameKindLink.ok).toBe(false);

    // A link cannot cross orders: the chair credit lives on this order.
    const otherOrder = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-links-other",
      orderLines: [{ quoteLineId: "machine", quantity: "1", unit: "piece" }],
    });
    if (!otherOrder.ok) throw new Error("other order setup failed");
    const crossOrderRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: otherOrder.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-cross-order",
      linkedEntryId: credit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    expect(crossOrderRefund.ok).toBe(false);

    const after = await tableCounts(t, project);
    expect(after).toEqual({ selections: 1, orders: 2, events: 1, entries: 3 });
  });

  test("actor and project isolation hold on every line write and read", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "isolation");
    const strangerProject = await setupProject(t, "isolation-stranger");
    const graph = await setupTwoLineGraph(t, project, "isolation");
    const strangerGraph = await setupTwoLineGraph(t, strangerProject, "isolation-stranger");
    const asOwner = t.withIdentity(OWNER);

    const grant = await asOwner.mutation(grantProjectAccessRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetIdentity: OTHER_ACTOR.tokenIdentifier,
      role: "approver",
    });
    if (!grant.ok) throw new Error("actor access setup failed");

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-isolation",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-isolation",
    });
    if (!selection.ok) throw new Error("selection setup failed");

    // Another actor replaying the same key with identical lines still
    // conflicts: selection idempotency binds the actor.
    const actorReplay = await t.withIdentity(OTHER_ACTOR).mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-isolation",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-isolation",
    });
    expect(actorReplay).toMatchObject({ ok: false, code: "duplicate-conflict" });

    // Foreign graph references never resolve across projects.
    const foreignSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: strangerGraph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-isolation",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-foreign",
    });
    expect(foreignSelection.ok).toBe(false);

    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-isolation",
      orderLines: [{ quoteLineId: "machine", quantity: "1", unit: "piece" }],
    });
    if (!order.ok) throw new Error("order setup failed");

    const foreignLineage = await t.withIdentity(STRANGER).query(getOrderLineageRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
    });
    expect(foreignLineage.ok).toBe(false);

    const crossProjectLineage = await asOwner.query(getOrderLineageRef, {
      organizationId: strangerProject.orgId,
      projectId: strangerProject.projectId,
      orderId: order.orderId,
    });
    expect(crossProjectLineage.ok).toBe(false);

    const strangerSelection = await asOwner.mutation(recordSelectionRef, {
      organizationId: strangerProject.orgId,
      projectId: strangerProject.projectId,
      requirementId: strangerGraph.requirementId,
      candidateId: strangerGraph.candidateId,
      quoteId: strangerGraph.quoteId,
      quoteVersion: "v-isolation-stranger",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      // Project-local keys stay independent across projects.
      idempotencyKey: "sel-isolation",
    });
    expect(strangerSelection.ok).toBe(true);
    if (strangerSelection.ok) expect(strangerSelection.deduplicated).toBe(false);

    const counts = await tableCounts(t, project);
    expect(counts).toEqual({ selections: 1, orders: 1, events: 0, entries: 0 });
  });
});

describe("cost-entry exclusive pairing over the link index", () => {
  test("pairing holds beside many unrelated entries; conflicting siblings write nothing", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "link-index");
    const graph = await setupTwoLineGraph(t, project, "link-index");
    const asOwner = t.withIdentity(OWNER);

    const selection = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: graph.quoteId,
      quoteVersion: "v-link-index",
      selectionLines: [
        { quoteLineId: "machine", quantity: "2", unit: "piece" },
        { quoteLineId: "chair", quantity: "10", unit: "piece" },
      ],
      requirementVersion: 1,
      idempotencyKey: "sel-link-index",
    });
    if (!selection.ok) throw new Error("selection setup failed");
    const order = await asOwner.mutation(recordOrderRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      selectionId: selection.selectionId,
      idempotencyKey: "ord-link-index",
      orderLines: [
        { quoteLineId: "machine", quantity: "1", unit: "piece" },
        { quoteLineId: "chair", quantity: "8", unit: "piece" },
      ],
    });
    if (!order.ok) throw new Error("order setup failed");

    // Twelve unrelated order-level payments: the pairing probe must
    // resolve through the link index, never by scanning this history.
    for (let i = 0; i < 12; i += 1) {
      const payment = await asOwner.mutation(recordCostEntryRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        orderId: order.orderId,
        kind: "payment",
        amount: { currency: "EUR", minorUnits: 1000 + i },
        idempotencyKey: `pay-link-index-${i}`,
      });
      if (!payment.ok) throw new Error(`payment ${i} setup failed`);
    }

    const noteHash = await sha256Hex("link-index-credit-note");
    const note = await asOwner.mutation(recordEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      sourceKind: "supplier-credit-note",
      contentHash: noteHash,
      completeness: "complete",
    });
    if (!note.ok) throw new Error("evidence setup failed");
    const refs = [{ evidenceId: note.evidenceId, contentHash: noteHash }];

    const chairCredit = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "credit-link-index",
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!chairCredit.ok) throw new Error(`chair credit failed: ${JSON.stringify(chairCredit)}`);
    const chairRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-link-index",
      linkedEntryId: chairCredit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!chairRefund.ok) throw new Error(`chair refund failed: ${JSON.stringify(chairRefund)}`);

    // A second pair on another line coexists: the probe finds the exact
    // sibling, never a neighboring link.
    const machineCredit = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 10000 },
      idempotencyKey: "credit-link-index-machine",
      quoteLineId: "machine",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!machineCredit.ok) throw new Error("machine credit setup failed");
    const machineRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 10000 },
      idempotencyKey: "refund-link-index-machine",
      linkedEntryId: machineCredit.entryId,
      quoteLineId: "machine",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!machineRefund.ok) throw new Error("machine refund failed");

    // A conflicting sibling reusing the chair credit's link is rejected
    // with no write: one credit absorbs exactly one refund.
    const conflictingSibling = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-link-index-conflict",
      linkedEntryId: chairCredit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    expect(conflictingSibling.ok).toBe(false);

    // The reverse direction conflicts too: the chair refund is already
    // paired, so no new credit may claim it.
    const reverseSibling = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "credit",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "credit-link-index-reverse",
      linkedEntryId: chairRefund.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    expect(reverseSibling.ok).toBe(false);

    // Exact replay of the paired refund still deduplicates.
    const replayRefund = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: order.orderId,
      kind: "refund",
      amount: { currency: "EUR", minorUnits: 5000 },
      idempotencyKey: "refund-link-index",
      linkedEntryId: chairCredit.entryId,
      quoteLineId: "chair",
      affectedQuantity: "1",
      affectedUnit: "piece",
      evidenceRefs: refs,
    });
    if (!replayRefund.ok) throw new Error("refund replay failed");
    expect(replayRefund.deduplicated).toBe(true);
    expect(replayRefund.entryId).toBe(chairRefund.entryId);

    const counts = await tableCounts(t, project);
    expect(counts.entries).toBe(16);
  });
});
