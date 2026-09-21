/// <reference types="vite/client" />
/**
 * E11 commissioning-to-asset and service-outcome completion (controlled,
 * PRD P-18 remainder and P-14 composite idempotency, ADR-0003).
 *
 * Runs the ACTUAL exported domain handlers against the REAL schema with
 * authenticated identities via official convex-test. No provider calls.
 *
 * Commissioning journey (one espresso machine on a single-line quote):
 * - a commissioning order event with an explicit asset payload records
 *   the installed asset with exact order/selection/requirement/quote and
 *   event provenance and no inferred serial, location, or warranty facts;
 * - duplicate callbacks and event replays resolve to the same event and
 *   asset rows (composite idempotency), while changed replays conflict;
 * - a commissioning milestone without the payload records honest
 *   incomplete state (no asset invented); a non-commissioning kind
 *   carrying the payload is denied;
 * - cross-organization and cross-project references fail closed with no
 *   writes; prior orders, events, and cost entries stay immutable.
 *
 * Service-outcome journey on the commissioned asset:
 * - terminal outcomes are explicit when recorded, bounded, idempotent on
 *   replay, and stable (a stored terminal outcome can never be silently
 *   overwritten); terminal cases never reopen; invalid transitions fail
 *   with stable denials.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as requirements from "./requirements.js";
import * as sourcing from "./sourcing.js";
import * as decisions from "./decisions.js";
import * as fulfillment from "./fulfillment.js";
import * as locations from "./locations.js";

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
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer A, infer R> ? R : never;

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
const recordAssetRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordAsset>,
  MutationReturn<typeof fulfillment.recordAsset>
>("domain/fulfillment:recordAsset");
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
const createLocationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof locations.create>,
  MutationReturn<typeof locations.create>
>("domain/locations:create");

const OWNER = { tokenIdentifier: "e11-owner" };

type Project = { orgId: Id<"organizations">; projectId: Id<"projects"> };

async function setupProject(t: ReturnType<typeof convexTest>, name: string): Promise<Project> {
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

/** Single espresso machine on a single-line quote, selected and ordered. */
async function setupOrderedMachine(t: ReturnType<typeof convexTest>, project: Project, suffix: string) {
  const asOwner = t.withIdentity(OWNER);
  const req = await asOwner.mutation(createRequirementRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    key: `req-${suffix}`,
    title: `Espresso ${suffix}`,
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
    productModel: `Linea ${suffix}`,
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
    lineItems: [{ itemId: "machine", description: "Espresso machine", quantity: "1", unit: "piece" }],
    briefHash: "brief-e11",
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
        quantity: "1",
        unitPrice: { currency: "EUR", minorUnits: 795000 },
        evidenceRefs: [],
      },
    ],
    charges: [],
    taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
    comparisonScope: {
      requirementId: `req-${suffix}`,
      scopeId: `scope-${suffix}`,
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    requirementId: req.requirementId,
    vendorId: vendor.vendorId,
    rfqId: rfq.rfqId,
  });
  if (!quote.ok) throw new Error(`quote setup failed: ${JSON.stringify(quote)}`);
  const selection = await asOwner.mutation(recordSelectionRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: req.requirementId,
    candidateId: candidate.candidateId,
    quoteId: quote.quoteId,
    quoteVersion: `v-${suffix}`,
    quantity: "1",
    requirementVersion: 1,
    idempotencyKey: `sel-${suffix}`,
  });
  if (!selection.ok) throw new Error(`selection failed: ${JSON.stringify(selection)}`);
  const order = await asOwner.mutation(recordOrderRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    selectionId: selection.selectionId,
    idempotencyKey: `ord-${suffix}`,
    orderedQuantity: "1",
  });
  if (!order.ok) throw new Error(`order failed: ${JSON.stringify(order)}`);
  return {
    requirementId: req.requirementId,
    selectionId: selection.selectionId,
    quoteId: quote.quoteId,
    orderId: order.orderId,
  };
}

async function counts(t: ReturnType<typeof convexTest>, project: Project) {
  const [events, assets, entries, orders] = await Promise.all([
    t.run((ctx) => ctx.db.query("orderEvents").collect()),
    t.run((ctx) => ctx.db.query("assets").collect()),
    t.run((ctx) => ctx.db.query("costEntries").collect()),
    t.run((ctx) => ctx.db.query("orders").collect()),
  ]);
  const inProject = <T extends { projectId: unknown }>(rows: T[]) =>
    rows.filter((row) => row.projectId === project.projectId).length;
  return {
    events: inProject(events),
    assets: inProject(assets),
    entries: inProject(entries),
    orders: inProject(orders),
  };
}

describe("E11 commissioning event records the installed asset with exact lineage", () => {
  test("explicit payload creates one asset with provenance and no inferred facts", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "lineage");
    const graph = await setupOrderedMachine(t, project, "lineage");
    const asOwner = t.withIdentity(OWNER);

    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-1",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    if (!event.ok) throw new Error(`commissioning failed: ${JSON.stringify(event)}`);
    expect(event.deduplicated).toBe(false);
    expect(event.assetId).toBeDefined();
    expect(event.assetDeduplicated).toBe(false);

    const stored = await t.run((ctx) => ctx.db.get(event.assetId!));
    expect(stored?.organizationId).toBe(project.orgId);
    expect(stored?.projectId).toBe(project.projectId);
    expect(stored?.orderId).toBe(graph.orderId);
    expect(stored?.label).toBe("Linea Mini #1");
    // Nothing is inferred when the event lacks it.
    expect(stored).not.toHaveProperty("serial");
    expect(stored).not.toHaveProperty("locationId");
    expect(stored?.idempotencyKey).toBe("commissioning:evt-commission-1");
    // Exact lineage travels on the stored provenance.
    expect(stored?.purchaseProvenance).toContain(graph.orderId);
    expect(stored?.purchaseProvenance).toContain(graph.selectionId);
    expect(stored?.purchaseProvenance).toContain(graph.requirementId);
    expect(stored?.purchaseProvenance).toContain(graph.quoteId);
    expect(stored?.purchaseProvenance).toContain("evt-commission-1");

    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 1, entries: 0, orders: 1 });
  });

  test("explicit serial and location store verbatim; caller provenance is preserved", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "verbatim");
    const graph = await setupOrderedMachine(t, project, "verbatim");
    const asOwner = t.withIdentity(OWNER);
    const location = await asOwner.mutation(createLocationRef, {
      organizationId: project.orgId,
      name: "Canal store",
      region: "NL",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    });
    if (!location.ok) throw new Error("location setup failed");

    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-verbatim",
      commissioningAsset: {
        label: "Linea Mini #2",
        serial: "SN-1882",
        locationId: location.locationId,
        purchaseProvenance: "installer handover 2026-09-20",
      },
    });
    if (!event.ok) throw new Error(`commissioning failed: ${JSON.stringify(event)}`);
    const stored = await t.run((ctx) => ctx.db.get(event.assetId!));
    expect(stored?.serial).toBe("SN-1882");
    expect(stored?.locationId).toBe(location.locationId);
    expect(stored?.purchaseProvenance).toBe("installer handover 2026-09-20");
  });
});

describe("E11 duplicate callbacks and replays never duplicate assets (P-14)", () => {
  test("same event key plus same payload replays to the same rows", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay");
    const graph = await setupOrderedMachine(t, project, "replay");
    const asOwner = t.withIdentity(OWNER);
    const payload = {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning" as const,
      idempotencyKey: "evt-commission-replay",
      commissioningAsset: { label: "Linea Mini #1" },
    };
    const first = await asOwner.mutation(appendOrderEventRef, payload);
    if (!first.ok) throw new Error(`first failed: ${JSON.stringify(first)}`);
    const second = await asOwner.mutation(appendOrderEventRef, payload);
    if (!second.ok) throw new Error(`replay failed: ${JSON.stringify(second)}`);
    expect(second.eventId).toBe(first.eventId);
    expect(second.deduplicated).toBe(true);
    expect(second.assetId).toBe(first.assetId);
    expect(second.assetDeduplicated).toBe(true);
    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 1, entries: 0, orders: 1 });
  });

  test("same event key with a changed asset label conflicts with no new rows", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "conflict");
    const graph = await setupOrderedMachine(t, project, "conflict");
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-conflict",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    if (!first.ok) throw new Error("first failed");
    const changed = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-conflict",
      commissioningAsset: { label: "Different machine" },
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.code).toBe("duplicate-conflict");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 1, entries: 0, orders: 1 });
  });

  test("an event recorded without the payload cannot gain one on replay", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "late-payload");
    const graph = await setupOrderedMachine(t, project, "late-payload");
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-late",
    });
    if (!first.ok) throw new Error("first failed");
    expect(first.assetId).toBeUndefined();
    const late = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-late",
      commissioningAsset: { label: "Linea Mini #9" },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe("duplicate-conflict");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 0, entries: 0, orders: 1 });
  });
});

describe("E11 derived-key preemption can never attach a wrong asset", () => {
  test("same visible label but wrong order conflicts with no event written", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "preempt-order");
    const graph = await setupOrderedMachine(t, project, "preempt-order");
    const asOwner = t.withIdentity(OWNER);
    // The derived key is public-shaped: anyone can pre-write it through
    // the manual asset path with the same visible label but no order.
    const planted = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      label: "Linea Mini #1",
      idempotencyKey: "commissioning:evt-preempt-order",
    });
    if (!planted.ok) throw new Error("plant setup failed");
    const collision = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-preempt-order",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.code).toBe("duplicate-conflict");
    // No partial write: the event never lands and the planted row keeps
    // its shape (no order attached, no provenance invented).
    const after = await counts(t, project);
    expect(after).toEqual({ events: 0, assets: 1, entries: 0, orders: 1 });
    const kept = await t.run((ctx) => ctx.db.get(planted.assetId));
    expect(kept).not.toHaveProperty("orderId");
    expect(kept).not.toHaveProperty("purchaseProvenance");
  });

  test("same order and label but forged provenance conflicts with no event written", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "preempt-prov");
    const graph = await setupOrderedMachine(t, project, "preempt-prov");
    const asOwner = t.withIdentity(OWNER);
    const planted = await asOwner.mutation(recordAssetRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      label: "Linea Mini #1",
      purchaseProvenance: "forged handover",
      idempotencyKey: "commissioning:evt-preempt-prov",
    });
    if (!planted.ok) throw new Error("plant setup failed");
    const collision = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-preempt-prov",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.code).toBe("duplicate-conflict");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 0, assets: 1, entries: 0, orders: 1 });
    const kept = await t.run((ctx) => ctx.db.get(planted.assetId));
    expect(kept?.purchaseProvenance).toBe("forged handover");
  });

  test("original with payload then replay without payload fails closed", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "omit-replay");
    const graph = await setupOrderedMachine(t, project, "omit-replay");
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-omit-replay",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    if (!first.ok) throw new Error("first failed");
    // The event row cannot prove the omitted payload, so the derived
    // asset is neither exposed nor attached: stable conflict, no writes.
    const omitted = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-omit-replay",
    });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.code).toBe("duplicate-conflict");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 1, entries: 0, orders: 1 });
    // The exact replay still resolves to both rows.
    const exact = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-omit-replay",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    if (!exact.ok) throw new Error(`exact replay failed: ${JSON.stringify(exact)}`);
    expect(exact.eventId).toBe(first.eventId);
    expect(exact.assetId).toBe(first.assetId);
    expect(exact.assetDeduplicated).toBe(true);
  });
});

describe("E11 honest incomplete state and closed cross-tenant references", () => {
  test("commissioning without the payload records the milestone and no asset", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "incomplete");
    const graph = await setupOrderedMachine(t, project, "incomplete");
    const asOwner = t.withIdentity(OWNER);
    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-bare",
    });
    if (!event.ok) throw new Error(`bare commissioning failed: ${JSON.stringify(event)}`);
    expect(event.assetId).toBeUndefined();
    const after = await counts(t, project);
    expect(after).toEqual({ events: 1, assets: 0, entries: 0, orders: 1 });
  });

  test("a non-commissioning kind carrying the payload is denied with no writes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "wrong-kind");
    const graph = await setupOrderedMachine(t, project, "wrong-kind");
    const asOwner = t.withIdentity(OWNER);
    const denied = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "installation",
      idempotencyKey: "evt-install-payload",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 0, assets: 0, entries: 0, orders: 1 });
  });

  test("a payload without a label is denied with no writes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "no-label");
    const graph = await setupOrderedMachine(t, project, "no-label");
    const asOwner = t.withIdentity(OWNER);
    const denied = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-nolabel",
      commissioningAsset: { serial: "SN-1" },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    const after = await counts(t, project);
    expect(after).toEqual({ events: 0, assets: 0, entries: 0, orders: 1 });
  });

  test("foreign order and foreign location fail closed with no writes", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, "tenant-a");
    const projectB = await setupProject(t, "tenant-b");
    const graphA = await setupOrderedMachine(t, projectA, "tenant-a");
    const asOwner = t.withIdentity(OWNER);
    const foreignLocation = await asOwner.mutation(createLocationRef, {
      organizationId: projectB.orgId,
      name: "Foreign store",
      region: "NL",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    });
    if (!foreignLocation.ok) throw new Error("foreign location setup failed");

    const foreignOrder = await asOwner.mutation(appendOrderEventRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      orderId: graphA.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-foreign-order",
      commissioningAsset: { label: "Linea Mini #X" },
    });
    expect(foreignOrder.ok).toBe(false);

    const foreignPlace = await asOwner.mutation(appendOrderEventRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      orderId: graphA.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-foreign-place",
      commissioningAsset: { label: "Linea Mini #X", locationId: foreignLocation.locationId },
    });
    expect(foreignPlace.ok).toBe(false);
    if (!foreignPlace.ok) expect(foreignPlace.code).toBe("denied-project");

    expect(await counts(t, projectA)).toEqual({ events: 0, assets: 0, entries: 0, orders: 1 });
    expect(await counts(t, projectB)).toEqual({ events: 0, assets: 0, entries: 0, orders: 0 });
  });

  test("commissioning leaves prior financial history immutable", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "immutable");
    const graph = await setupOrderedMachine(t, project, "immutable");
    const asOwner = t.withIdentity(OWNER);
    const payment = await asOwner.mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-e11-1",
    });
    expect(payment.ok).toBe(true);
    const before = await t.run(async (ctx) => ({
      entries: await ctx.db.query("costEntries").collect(),
      orders: await ctx.db.query("orders").collect(),
    }));
    const commissioned = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: "evt-commission-immutable",
      commissioningAsset: { label: "Linea Mini #1" },
    });
    if (!commissioned.ok) throw new Error("commissioning failed");
    const after = await t.run(async (ctx) => ({
      entries: await ctx.db.query("costEntries").collect(),
      orders: await ctx.db.query("orders").collect(),
    }));
    expect(after.entries).toEqual(before.entries);
    expect(after.orders).toEqual(before.orders);
  });
});

describe("E11 service outcomes are explicit, bounded, idempotent, and stable", () => {
  async function setupCase(t: ReturnType<typeof convexTest>, project: Project, suffix: string) {
    const graph = await setupOrderedMachine(t, project, suffix);
    const asOwner = t.withIdentity(OWNER);
    const event = await asOwner.mutation(appendOrderEventRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId: graph.orderId,
      kind: "commissioning",
      idempotencyKey: `evt-case-${suffix}`,
      commissioningAsset: { label: `Linea ${suffix}` },
    });
    if (!event.ok || event.assetId === undefined) throw new Error("case asset setup failed");
    const serviceCase = await asOwner.mutation(openServiceCaseRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      assetId: event.assetId,
      urgency: "normal",
      summary: `Descale ${suffix}`,
      idempotencyKey: `case-${suffix}`,
    });
    if (!serviceCase.ok) throw new Error("case setup failed");
    return serviceCase.caseId;
  }

  test("non-terminal progress stays outcome-free; outcomes record only on terminal states", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "progress");
    const caseId = await setupCase(t, project, "progress");
    const asOwner = t.withIdentity(OWNER);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId,
    };
    expect(await asOwner.mutation(updateServiceCaseRef, { ...base, state: "inProgress" })).toEqual({
      ok: true,
    });
    const withOutcome = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "waitingForSupplier",
      outcome: "called supplier",
    });
    expect(withOutcome.ok).toBe(false);
    if (!withOutcome.ok) expect(withOutcome.code).toBe("invalid-payload");
    const resolved = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "resolved",
      outcome: "replaced heating element",
    });
    expect(resolved).toEqual({ ok: true });
    const stored = await t.run((ctx) => ctx.db.get(caseId));
    expect(stored?.state).toBe("resolved");
    expect(stored?.outcome).toBe("replaced heating element");
  });

  test("terminal outcomes replay idempotently but never overwrite or reopen", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "stable");
    const caseId = await setupCase(t, project, "stable");
    const asOwner = t.withIdentity(OWNER);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId,
    };
    expect(
      await asOwner.mutation(updateServiceCaseRef, {
        ...base,
        state: "resolved",
        outcome: "replaced heating element",
      }),
    ).toEqual({ ok: true });
    // Same state plus same outcome replays as success.
    expect(
      await asOwner.mutation(updateServiceCaseRef, {
        ...base,
        state: "resolved",
        outcome: "replaced heating element",
      }),
    ).toEqual({ ok: true });
    // A different outcome never silently overwrites.
    const overwrite = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "resolved",
      outcome: "replaced the whole machine",
    });
    expect(overwrite.ok).toBe(false);
    if (!overwrite.ok) {
      expect(overwrite.code).toBe("invalid-payload");
      expect(overwrite.message).toContain("cannot be changed");
    }
    // A resolved case never reopens to progress.
    for (const state of ["open", "inProgress", "waitingForSupplier"] as const) {
      const reopened = await asOwner.mutation(updateServiceCaseRef, { ...base, state });
      expect(reopened.ok).toBe(false);
    }
    // Resolved closes with its recorded outcome carried over.
    expect(await asOwner.mutation(updateServiceCaseRef, { ...base, state: "closed" })).toEqual({
      ok: true,
    });
    const closedRow = await t.run((ctx) => ctx.db.get(caseId));
    expect(closedRow?.state).toBe("closed");
    expect(closedRow?.outcome).toBe("replaced heating element");
    // Closed cases never reopen and never accept a new outcome.
    const reopened = await asOwner.mutation(updateServiceCaseRef, { ...base, state: "open" });
    expect(reopened.ok).toBe(false);
    const changed = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "closed",
      outcome: "something else",
    });
    expect(changed.ok).toBe(false);
    expect(await asOwner.mutation(updateServiceCaseRef, { ...base, state: "closed" })).toEqual({
      ok: true,
    });
  });

  test("terminal targets without any outcome fail closed with no writes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "required");
    const caseId = await setupCase(t, project, "required");
    const asOwner = t.withIdentity(OWNER);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId,
    };
    // Neither resolution nor closure may land outcome-less: the defect
    // is denied before the no-op return or patch, and nothing writes.
    for (const state of ["resolved", "closed"] as const) {
      const denied = await asOwner.mutation(updateServiceCaseRef, { ...base, state });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe("invalid-payload");
        expect(denied.message).toContain("outcome required");
      }
    }
    const untouched = await t.run((ctx) => ctx.db.get(caseId));
    expect(untouched?.state).toBe("open");
    expect(untouched).not.toHaveProperty("outcome");
    // An explicit outcome resolves; closing carries the immutable
    // stored outcome forward; identical terminal replays stay idempotent
    // with or without restating it.
    expect(
      await asOwner.mutation(updateServiceCaseRef, {
        ...base,
        state: "resolved",
        outcome: "replaced heating element",
      }),
    ).toEqual({ ok: true });
    expect(await asOwner.mutation(updateServiceCaseRef, { ...base, state: "closed" })).toEqual({
      ok: true,
    });
    expect(await asOwner.mutation(updateServiceCaseRef, { ...base, state: "closed" })).toEqual({
      ok: true,
    });
    expect(
      await asOwner.mutation(updateServiceCaseRef, {
        ...base,
        state: "closed",
        outcome: "replaced heating element",
      }),
    ).toEqual({ ok: true });
    const stored = await t.run((ctx) => ctx.db.get(caseId));
    expect(stored?.state).toBe("closed");
    expect(stored?.outcome).toBe("replaced heating element");
  });

  test("blank and overlong outcomes fail with stable denials", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "bounds");
    const caseId = await setupCase(t, project, "bounds");
    const asOwner = t.withIdentity(OWNER);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      caseId,
    };
    const blank = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "resolved",
      outcome: "   ",
    });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.code).toBe("invalid-payload");
    const overlong = await asOwner.mutation(updateServiceCaseRef, {
      ...base,
      state: "closed",
      outcome: "x".repeat(2001),
    });
    expect(overlong.ok).toBe(false);
    if (!overlong.ok) expect(overlong.code).toBe("invalid-payload");
    const stored = await t.run((ctx) => ctx.db.get(caseId));
    expect(stored?.state).toBe("open");
    expect(stored).not.toHaveProperty("outcome");
  });

  test("cross-project service updates fail closed", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, "case-a");
    const projectB = await setupProject(t, "case-b");
    const caseId = await setupCase(t, projectA, "case-a");
    const asOwner = t.withIdentity(OWNER);
    const denied = await asOwner.mutation(updateServiceCaseRef, {
      organizationId: projectB.orgId,
      projectId: projectB.projectId,
      caseId,
      state: "inProgress",
    });
    expect(denied.ok).toBe(false);
    const stored = await t.run((ctx) => ctx.db.get(caseId));
    expect(stored?.state).toBe("open");
  });
});
