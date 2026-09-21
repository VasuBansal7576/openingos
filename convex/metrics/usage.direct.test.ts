/// <reference types="vite/client" />
/**
 * E10 spend-separation contract tests (P-08, P-22; ADR-0003 financial
 * state).
 *
 * Paid cash (payments less cash refunds) and settled acquisition cost
 * (settled costs less price-reducing credits) are separate financial
 * states. A payment and its settled cost are never added into one
 * combined spend total, refunds reduce only net paid cash, credits reduce
 * only net settled cost, and a linked credit/refund pair is counted once
 * in each state — never subtracted twice from a single total.
 *
 * These tests execute the exported Convex query against convex-test's
 * in-memory database with controlled rows only. No provider calls, live
 * billing data, or invented savings are involved.
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
import * as usage from "./usage.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../shared/**/*.ts",
  "../domain/**/*.ts",
  "./**/*.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!../domain/**/*.test.ts",
  "!./**/*.test.ts",
]);

const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./")
    ? `metrics/${path.slice(2)}`
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
const projectUsageMetricsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof usage.projectUsageMetrics>,
  QueryReturn<typeof usage.projectUsageMetrics>
>("metrics/usage:projectUsageMetrics");

const OWNER = { tokenIdentifier: "spend-separation-owner" };

type Project = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function setupProject(t: ReturnType<typeof convexTest>): Promise<Project> {
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "spend separation org",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "spend separation project",
    visibility: "open",
  });
  if (!project.ok) throw new Error("project setup failed");
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

/** Test scaffolding only: requirement chain with one recorded order. */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  project: Project,
  key: string,
  currency = "EUR",
): Promise<{ orderId: Id<"orders"> }> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const vendorId = await ctx.db.insert("vendors", {
      organizationId: project.organizationId,
      name: `Spend vendor ${key}`,
      regions: [],
      createdAt: now,
    });
    const requirementId = await ctx.db.insert("requirements", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      key: `req-spend-${key}`,
      title: `Spend requirement ${key}`,
      category: "test",
      quantity: "1",
      unit: "piece",
      priority: "P0",
      state: "selected",
      fulfillment: "ordered",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const candidateId = await ctx.db.insert("candidates", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId,
      vendorId,
      productModel: "Model S1",
      variant: "base",
      variantKey: "s1-base",
      compatibility: "pass",
      conversationState: "draft",
      createdAt: now,
    });
    const quoteId = await ctx.db.insert("quotes", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      version: `q-spend-${key}`,
      contentHash: `hash-spend-${key}`,
      currency,
      lines: [],
      charges: [],
      taxBasis: { kind: "unknown" as const, reason: "controlled test", evidenceRefs: [] },
      evidenceRefs: [],
      counterpartyRole: "vendor",
      executionMode: "recorded" as const,
      requirementId,
      vendorId,
      createdAt: now,
    });
    const selectionId = await ctx.db.insert("selections", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: `sel-spend-${key}`,
      requirementId,
      candidateId,
      quoteId,
      quoteVersion: `q-spend-${key}`,
      requirementVersion: 1,
      actor: OWNER.tokenIdentifier,
      createdAt: now,
    });
    const orderId = await ctx.db.insert("orders", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      selectionId,
      requirementId,
      quoteId,
      quoteVersion: `q-spend-${key}`,
      requirementVersion: 1,
      idempotencyKey: `ord-spend-${key}`,
      state: "recorded",
      amendmentCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { orderId };
  });
}

async function insertEntry(
  t: ReturnType<typeof convexTest>,
  project: Project,
  orderId: Id<"orders">,
  kind: "payment" | "settledCost" | "refund" | "credit",
  currency: string,
  minorUnits: number,
  key: string,
  linkedEntryId?: Id<"costEntries">,
): Promise<Id<"costEntries">> {
  return t.run(async (ctx) =>
    ctx.db.insert("costEntries", {
      organizationId: project.organizationId,
      projectId: project.projectId,
      orderId,
      kind,
      amount: { currency, minorUnits },
      idempotencyKey: key,
      ...(linkedEntryId === undefined ? {} : { linkedEntryId }),
      recordedBy: OWNER.tokenIdentifier,
      createdAt: Date.now(),
    }),
  );
}

function eurBucket<T extends { currency: string }>(currencies: readonly T[]): T {
  const bucket = currencies.find((entry) => entry.currency === "EUR");
  if (!bucket) throw new Error("EUR bucket missing");
  return bucket;
}

describe("E10 spend separation (P-08)", () => {
  test("a €7,950 payment plus a €7,950 settled cost never reports €15,900 as one spend total", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const { orderId } = await seedOrder(t, project, "no-combine");
    await insertEntry(t, project, orderId, "payment", "EUR", 7950_00, "ce-no-combine-pay");
    await insertEntry(t, project, orderId, "settledCost", "EUR", 7950_00, "ce-no-combine-settled");
    const result = await t.withIdentity(OWNER).query(projectUsageMetricsRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("metrics query failed");
    expect(result.spend.entriesScanned).toBe(2);
    const bucket = eurBucket(result.spend.currencies);
    expect(bucket.entries).toBe(2);
    expect(bucket.byKind).toEqual({ payment: 1, settledCost: 1, refund: 0, credit: 0 });
    // Separate financial states: paid cash and settled acquisition cost.
    expect(bucket.paymentsMinorUnits).toBe(7950_00);
    expect(bucket.refundsMinorUnits).toBe(0);
    expect(bucket.netPaidMinorUnits).toBe(7950_00);
    expect(bucket.settledCostsMinorUnits).toBe(7950_00);
    expect(bucket.creditsMinorUnits).toBe(0);
    expect(bucket.netSettledMinorUnits).toBe(7950_00);
    expect(bucket.linkedPairs).toBe(0);
    // The old combined metric is gone: no single spend field may equal
    // the double-counted €15,900 total.
    expect(bucket).not.toHaveProperty("paymentsAndSettledMinorUnits");
    expect(bucket).not.toHaveProperty("refundsAndCreditsMinorUnits");
    expect(bucket).not.toHaveProperty("netMinorUnits");
    for (const value of Object.values(bucket)) {
      expect(value).not.toBe(15900_00);
    }
    expect(result.completeness.complete).toBe(true);
  });

  test("a linked €50 credit and €50 refund reduce each state once, never twice in one total", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const { orderId } = await seedOrder(t, project, "linked");
    await insertEntry(t, project, orderId, "payment", "EUR", 2000_00, "ce-linked-pay");
    const creditId = await insertEntry(t, project, orderId, "credit", "EUR", 50_00, "ce-linked-credit");
    await insertEntry(t, project, orderId, "refund", "EUR", 50_00, "ce-linked-refund", creditId);
    const result = await t.withIdentity(OWNER).query(projectUsageMetricsRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("metrics query failed");
    const bucket = eurBucket(result.spend.currencies);
    expect(bucket.byKind).toEqual({ payment: 1, settledCost: 0, refund: 1, credit: 1 });
    // The cash refund reduces only paid cash; the price-reducing credit
    // reduces only settled cost. A single €50 event linked across two
    // states is never subtracted twice from one total: net paid cash is
    // €1,950, not €1,900.
    expect(bucket.paymentsMinorUnits).toBe(2000_00);
    expect(bucket.refundsMinorUnits).toBe(50_00);
    expect(bucket.netPaidMinorUnits).toBe(1950_00);
    expect(bucket.settledCostsMinorUnits).toBe(0);
    expect(bucket.creditsMinorUnits).toBe(50_00);
    expect(bucket.netSettledMinorUnits).toBe(-50_00);
    expect(bucket.linkedPairs).toBe(1);
  });

  test("standalone adjustments stay in their own state across currencies", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const eur = await seedOrder(t, project, "standalone-eur", "EUR");
    await insertEntry(t, project, eur.orderId, "payment", "EUR", 100_00, "ce-standalone-pay");
    await insertEntry(t, project, eur.orderId, "refund", "EUR", 20_00, "ce-standalone-refund");
    const usd = await seedOrder(t, project, "standalone-usd", "USD");
    await insertEntry(t, project, usd.orderId, "settledCost", "USD", 25_00, "ce-standalone-settled");
    await insertEntry(t, project, usd.orderId, "credit", "USD", 5_00, "ce-standalone-credit");
    const result = await t.withIdentity(OWNER).query(projectUsageMetricsRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("metrics query failed");
    expect(result.spend.currencies).toEqual([
      {
        currency: "EUR",
        entries: 2,
        byKind: { payment: 1, settledCost: 0, refund: 1, credit: 0 },
        paymentsMinorUnits: 100_00,
        refundsMinorUnits: 20_00,
        netPaidMinorUnits: 80_00,
        settledCostsMinorUnits: 0,
        creditsMinorUnits: 0,
        netSettledMinorUnits: 0,
        linkedPairs: 0,
      },
      {
        currency: "USD",
        entries: 2,
        byKind: { payment: 0, settledCost: 1, refund: 0, credit: 1 },
        paymentsMinorUnits: 0,
        refundsMinorUnits: 0,
        netPaidMinorUnits: 0,
        settledCostsMinorUnits: 25_00,
        creditsMinorUnits: 5_00,
        netSettledMinorUnits: 20_00,
        linkedPairs: 0,
      },
    ]);
  });

  test("an overflowing paid-cash total is unavailable while settled cost stays exact", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const { orderId } = await seedOrder(t, project, "overflow");
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;
    await insertEntry(t, project, orderId, "payment", "EUR", MAX_SAFE, "ce-overflow-pay-1");
    await insertEntry(t, project, orderId, "payment", "EUR", 1, "ce-overflow-pay-2");
    await insertEntry(t, project, orderId, "settledCost", "EUR", 7950_00, "ce-overflow-settled");
    const result = await t.withIdentity(OWNER).query(projectUsageMetricsRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("metrics query failed");
    const bucket = eurBucket(result.spend.currencies);
    expect(bucket.paymentsMinorUnits).toEqual({
      unavailable: "overflow",
      reason: expect.stringContaining("overflow"),
    });
    expect(bucket.netPaidMinorUnits).toEqual({
      unavailable: "overflow",
      reason: expect.stringContaining("overflow"),
    });
    // The settled-cost state is unaffected by the paid-cash overflow.
    expect(bucket.settledCostsMinorUnits).toBe(7950_00);
    expect(bucket.creditsMinorUnits).toBe(0);
    expect(bucket.netSettledMinorUnits).toBe(7950_00);
    expect(result.completeness.overflowedSections).toContain("spend.currencies.EUR");
    expect(result.completeness.complete).toBe(false);
  });
});
