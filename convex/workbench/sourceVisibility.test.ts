/// <reference types="vite/client" />

/**
 * Astra F4 source-only research visibility (integrated controlled test).
 *
 * A controlled collection record that carries a URL, title, and page text
 * but no extracted price persists one `evidence` row plus source-scoped
 * `productEvidence` while correctly creating zero vendors, zero candidates,
 * and zero quotes. The authorized workbench projection must still expose
 * that source — URL, capture/completeness, provenance, and the explicit
 * missing commercial facts — without representing it as a supplier,
 * product, quote, offer, or realized saving. A separately recorded
 * supplier with an unpublished price stays visible as an offer with no
 * quote and no comparison verdict.
 *
 * Collection runs through the controlled `execute` path: no provider key,
 * no live allowance, and every written row carries `executionMode:
 * "fixture"`.
 */

import { makeFunctionReference, type RegisteredAction, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel.js";
import { parseWorkbenchSnapshot } from "../../app/workbench-state.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "../execution/jobs.js";
import * as reservations from "../execution/reservations.js";
import * as operations from "../execution/operations.js";
import * as requirements from "../domain/requirements.js";
import * as sourcing from "../domain/sourcing.js";
import * as research from "../research/collection.js";
import * as projection from "./projection.js";
import { canonicalJson } from "../shared/hashing.js";
import schema from "../schema.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../domain/**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../research/**/*.ts",
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
  "!../research/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!./**/*.test.ts",
]);
const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./")
    ? `workbench/${path.slice(2)}`
    : path.replace(/^(\.\.\/)+/, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type ActionArgs<T> = T extends RegisteredAction<infer _V, infer A, infer _R> ? A : never;
type ActionReturn<T> = T extends RegisteredAction<infer _V, infer _A, infer R> ? R : never;
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
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
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
const reserveRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.reserve>,
  MutationReturn<typeof reservations.reserve>
>("execution/reservations:reserve");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const executeRef = makeFunctionReference<
  "action",
  ActionArgs<typeof research.execute>,
  ActionReturn<typeof research.execute>
>("research/collection:execute");
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
const getProjectionRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.getProjection>,
  QueryReturn<typeof projection.getProjection>
>("workbench/projection:getProjection");

const OWNER = { tokenIdentifier: "source-visibility-owner" };

const SOURCE_URL = "https://supplier.example.test/espresso-atlas-2g";

function init(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  firecrawl.register(t);
  return t;
}

describe("source-only research visibility", () => {
  test("a sourceless-price collection stays visible without inventing vendor, candidate, or quote", async () => {
    const t = init();
    const asOwner = t.withIdentity(OWNER);
    const organization = await asOwner.mutation(createOrganizationRef, {
      name: "Source visibility controlled org",
      kind: "private",
    });
    if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
    const project = await asOwner.mutation(createProjectRef, {
      organizationId: organization.organizationId,
      name: "Source visibility controlled project",
      visibility: "open",
    });
    if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
    const requirement = await asOwner.mutation(createRequirementRef, {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      key: "ESP-01",
      title: "Two-group espresso machine",
      category: "coffee",
      quantity: "1",
      unit: "piece",
      priority: "P0",
    });
    if (!requirement.ok) throw new Error(`requirement setup failed: ${JSON.stringify(requirement)}`);

    const query = "Research suppliers for the espresso machine";
    const grant = await asOwner.mutation(issueGrantRef, {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      operations: ["research.collect"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 0,
      inputVersions: { brief: "source-visibility-v1" },
      payloadJson: canonicalJson({ query }),
      costCeilingMicroUsd: 250_000,
      roundLimit: 8,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
    await t.run(async (ctx) => {
      await ctx.db.insert("providerBudgets", {
        organizationId: organization.organizationId,
        ceilingMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-source-visibility-firecrawl",
        updatedAt: Date.now(),
      });
    });
    const started = await asOwner.mutation(startJobRef, {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      text: query,
      operationId: "research.collect",
      kind: "research",
      grantId: grant.grantId,
    });
    if (!started.ok) throw new Error(`job setup failed: ${started.message}`);
    const reservation = await asOwner.mutation(reserveRef, {
      jobId: started.jobId,
      organizationId: organization.organizationId,
      projectId: project.projectId,
      amountMicroUsd: 25_000,
      pricingBasis: "controlled-source-visibility-firecrawl",
    });
    if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
    const operation = await asOwner.mutation(createOperationRef, {
      jobId: started.jobId,
      organizationId: organization.organizationId,
      projectId: project.projectId,
      kind: "research.collect",
      requestId: "source-visibility-request-1",
      payloadJson: canonicalJson({ query }),
      grantId: grant.grantId,
      reservationId: reservation.reservationId,
    });
    if (!operation.ok) throw new Error(`operation setup failed: ${operation.message}`);

    // Controlled scrape: URL, title, and page text with structured
    // model/vendor facts but no price. No live provider is contacted.
    const result = await t.action(executeRef, {
      operationId: operation.operationId,
      identity: OWNER.tokenIdentifier,
      mode: "scrape",
      sourceUrl: SOURCE_URL,
      controlled: true,
      controlledResponseJson: JSON.stringify({
        url: SOURCE_URL,
        title: "Atlas 2G two-group espresso machine",
        markdown: "The Atlas 2G two-group espresso machine. Call for current pricing and delivery options.",
        json: {
          productModel: "Atlas 2G",
          variant: "two-group · 220V",
          vendor: "Harbor Equipment",
          currency: "EUR",
          availability: "in stock",
          delivery: "2-3 weeks",
          serviceCoverage: "Netherlands on-site",
        },
      }),
    });
    expect(result.ok).toBe(true);

    // Collection persists evidence but creates no commercial identity:
    // zero vendors, zero candidates, zero quotes.
    const stored = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect(),
      claims: await ctx.db.query("productEvidence").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect(),
      vendors: await ctx.db.query("vendors").collect(),
      candidates: await ctx.db.query("candidates").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect(),
      quotes: await ctx.db.query("quotes").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect(),
    }));
    expect(stored.evidence).toHaveLength(1);
    expect(stored.evidence[0]?.sourceUrl).toBe(SOURCE_URL);
    expect(stored.claims.some((claim) => claim.field === "missing:price")).toBe(true);
    expect(stored.vendors).toHaveLength(0);
    expect(stored.candidates).toHaveLength(0);
    expect(stored.quotes).toHaveLength(0);

    // A suitable supplier with an unpublished price: vendor plus
    // candidate, but deliberately no quote row.
    const vendor = await asOwner.mutation(recordVendorRef, {
      organizationId: organization.organizationId,
      name: "Harbor Equipment",
      regions: ["NL"],
      serviceCoverage: "Netherlands on-site",
    });
    if (!vendor.ok) throw new Error(`vendor setup failed: ${JSON.stringify(vendor)}`);
    const candidate = await asOwner.mutation(recordCandidateRef, {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      requirementId: requirement.requirementId,
      vendorId: vendor.vendorId,
      productModel: "Atlas 2G",
      variant: "two-group · 220V",
      conversationState: "draft",
    });
    if (!candidate.ok) throw new Error(`candidate setup failed: ${JSON.stringify(candidate)}`);

    const view = await asOwner.query(getProjectionRef, { projectId: project.projectId });
    expect(view.ok).toBe(true);
    if (!view.ok) throw new Error(`projection failed: ${view.code}`);
    expect(view.candidatesTruncated).toBe(false);
    expect(view.researchSourcesTruncated).toBe(false);

    // The source stays visible with URL, capture/completeness,
    // provenance, and the explicit missing price fact.
    expect(view.researchSources).toHaveLength(1);
    const source = view.researchSources[0];
    expect(source?.id).toBe(stored.evidence[0]?._id);
    expect(source?.sourceUrl).toBe(SOURCE_URL);
    expect(source?.sourceKind).toBe(stored.evidence[0]?.sourceKind);
    expect(source?.capturedAt).toBe(stored.evidence[0]?.capturedAt);
    expect(source?.completeness).toBe(stored.evidence[0]?.completeness);
    expect(source?.missingFacts).toContain("price");
    expect(source?.provenance.mode).toBe(stored.evidence[0]?.executionMode);
    expect(source).not.toHaveProperty("vendor");
    expect(source).not.toHaveProperty("productModel");
    expect(source).not.toHaveProperty("totalMinorUnits");
    expect(source).not.toHaveProperty("comparisons");

    // The unpublished-price supplier is one offer with no quote and no
    // comparison verdict: nothing is ranked and no total is invented.
    expect(view.candidates).toHaveLength(1);
    const offer = view.candidates[0];
    expect(offer?.vendor?.name).toBe("Harbor Equipment");
    expect(offer?.productModel).toBe("Atlas 2G");
    expect(offer?.latestValidQuote).toBeNull();
    expect(offer?.comparisons).toHaveLength(0);

    // No quote row exists anywhere in the project.
    const quotes = await t.run(async (ctx) =>
      ctx.db.query("quotes").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect(),
    );
    expect(quotes).toHaveLength(0);

    // The exact wire result parses into the browser view model with the
    // source intact, one quoteless offer, and no invented aggregates.
    const snapshot = parseWorkbenchSnapshot(view, project.projectId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.researchSources).toHaveLength(1);
    expect(snapshot?.researchSources[0]?.sourceUrl).toBe(SOURCE_URL);
    expect(snapshot?.researchSources[0]?.missingFacts).toContain("price");
    expect(snapshot?.offers).toHaveLength(1);
    expect(snapshot?.offers[0]?.quote).toBeNull();
    expect(snapshot?.offers[0]?.comparisons).toHaveLength(0);
    expect(snapshot?.truncation.sources).toBe(false);
  }, 30_000);
});
