/// <reference types="vite/client" />

/**
 * R1 controlled acceptance tests.
 *
 * Firecrawl transport is exercised through the installed component with a
 * stubbed fetch.  No provider key or live allowance is used.  All records
 * written by the fixture path carry `executionMode: "fixture"` and all
 * provider-mode calls in these tests are explicitly marked controlled.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import {
  makeFunctionReference,
  type RegisteredAction,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "../execution/jobs.js";
import * as reservations from "../execution/reservations.js";
import * as operations from "../execution/operations.js";
import * as research from "./collection.js";
import { isSafePublicSourceUrl, normalizeProviderResponse } from "./contracts.js";
import { canonicalJson } from "../shared/hashing.js";
import type { Id } from "../_generated/dataModel.js";

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
  const relative = path.startsWith("./") ? `research/${path.slice(2)}` : path.replace(/^(\.\.\/)+/, "");
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
const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const executeRef = makeFunctionReference<
  "action",
  ActionArgs<typeof research.execute>,
  ActionReturn<typeof research.execute>
>("research/collection:execute");
const applyOutcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof research.applyOutcome>,
  MutationReturn<typeof research.applyOutcome>
>("research/collection:applyOutcome");
const requestGrantedResearchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof research.requestGrantedResearch>,
  MutationReturn<typeof research.requestGrantedResearch>
>("research/collection:requestGrantedResearch");
const recoverResearchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof research.recoverResearch>,
  MutationReturn<typeof research.recoverResearch>
>("research/collection:recoverResearch");
const projectResearchRef = makeFunctionReference<
  "query",
  QueryArgs<typeof research.projectResearch>,
  Awaited<QueryReturn<typeof research.projectResearch>>
>("research/collection:projectResearch");

const OWNER = { tokenIdentifier: "r1-owner" };

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly identity: string;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly operationId: Id<"operations">;
}

async function createFixture(t: TestConvex<typeof schema>, requestId = "r1-request-1"): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, { name: "R1 controlled org", kind: "private" });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "R1 controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const query = "Research suppliers for the espresso machine";
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "r1-v1" },
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
      pricingBasis: "controlled-r1-firecrawl",
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
    pricingBasis: "controlled-r1-firecrawl",
  });
  if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
  const operation = await asOwner.mutation(createOperationRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    kind: "research.collect",
    requestId,
    payloadJson: canonicalJson({ query }),
    grantId: grant.grantId,
    reservationId: reservation.reservationId,
  });
  if (!operation.ok) throw new Error(`operation setup failed: ${operation.message}`);
  return {
    t,
    identity: OWNER.tokenIdentifier,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    grantId: grant.grantId,
    jobId: started.jobId,
    operationId: operation.operationId,
  };
}

function init(): TestConvex<typeof schema> {
  process.env.FIRECRAWL_API_KEY = "controlled-r1-key";
  const t = convexTest(schema, modules);
  firecrawl.register(t);
  return t;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("R1 Firecrawl bounded transport and incomplete evidence", () => {
  test("S-11 retries transient responses at most four times with no workflow multiplier", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-transient");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: false, error: "temporary" }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }));
    const result = await t.action(executeRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      mode: "search",
      controlled: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(4);
    const rows = await t.run(async (ctx) => ({
      operation: await ctx.db.get(fixture.operationId),
      reservation: (await ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", fixture.jobId)).unique()),
    }));
    expect(rows.operation?.state).toBe("outcomeUnknown");
    expect(rows.reservation?.unresolvedMicroUsd).toBe(25_000);
  }, 20_000);

  test("S-12 credit exhaustion pauses new work while no evidence is fabricated", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-credits");
    await t.run(async (ctx) => {
      await ctx.db.insert("evidence", {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        sourceKind: "controlled.prior-research",
        sourceUrl: "https://supplier.example.test/prior",
        capturedAt: Date.now() - 1_000,
        contentHash: "controlled-prior-hash",
        completeness: "complete",
        counterpartyRole: "vendor",
        executionMode: "fixture",
      });
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: false, error: "insufficient credits" }), {
        status: 402,
      });
    }));
    const result = await t.action(executeRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      mode: "search",
      controlled: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(fixture.jobId),
      evidence: await ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(10),
    }));
    expect(rows.job?.state).toBe("pausedBudget");
    expect(rows.evidence).toHaveLength(1);
    const newWork = await t.withIdentity(OWNER).mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: "Research suppliers for the espresso machine",
      requestId: "r1-after-credit-exhaustion",
      grantId: fixture.grantId,
      mode: "search",
    });
    expect(newWork.ok).toBe(false);
    if (!newWork.ok) expect(newWork.code).toBe("allowance-exhausted");
    expect(calls).toHaveLength(1);
  });

  test("S-13 truncation and missing extracted JSON remain partial with explicit unknown fields", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-incomplete");
    const result = await t.action(executeRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/product",
      controlled: true,
      controlledResponseJson: JSON.stringify({
        url: "https://supplier.example.test/product",
        title: "Two group espresso machine",
        markdown: "A truncated source",
        truncated: true,
        unstoredPages: 2,
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("partial");
      expect(result.incompleteCount).toBe(1);
      expect(result.controlled).toBe(true);
    }
    const rows = await t.run(async (ctx) => ({
      evidence: await ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(10),
      claims: await ctx.db.query("productEvidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(32),
    }));
    expect(rows.evidence[0]?.completeness).toBe("partial");
    expect(rows.claims.some((claim) => claim.field === "missing:extracted-json")).toBe(true);
    expect(rows.claims.some((claim) => claim.field === "missing:price")).toBe(true);
    expect(rows.claims.some((claim) => claim.field === "missing:unstored-pages")).toBe(true);
    expect(rows.claims.some((claim) => claim.field === "request-count" && claim.normalizedValue === "1")).toBe(true);

    const recovery = await t.withIdentity(OWNER).mutation(recoverResearchRef, {
      jobId: fixture.jobId,
      operationId: fixture.operationId,
      requestId: "r1-recovery-1",
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/product",
    });
    expect(recovery.ok).toBe(true);
    if (recovery.ok) expect(recovery.operationId).not.toBe(fixture.operationId);
  });

  test("S-13 oversized controlled payload is marked truncated without retaining the payload", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-oversized");
    const oversizedResponse = JSON.stringify({
      url: "https://supplier.example.test/oversized",
      markdown: "x".repeat(260_000),
    });
    const result = await t.action(executeRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/oversized",
      controlled: true,
      controlledResponseJson: oversizedResponse,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("partial");
      expect(result.incompleteCount).toBe(1);
      expect(result.controlled).toBe(true);
    }
    const evidence = await t.run(async (ctx) =>
      ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(10),
    );
    expect(evidence[0]?.completeness).toBe("partial");
  });

  test("S-14 cancellation fences a queued operation before any paid provider call", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-cancel");
    const asOwner = t.withIdentity(OWNER);
    const cancellation = await asOwner.mutation(
      makeFunctionReference<"mutation", MutationArgs<typeof jobs.cancel>, MutationReturn<typeof jobs.cancel>>("execution/jobs:cancel"),
      { jobId: fixture.jobId, reason: "controlled cancellation" },
    );
    expect(cancellation.ok).toBe(true);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
    }));
    const result = await t.action(executeRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      mode: "search",
      controlled: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const operation = await t.run(async (ctx) => await ctx.db.get(fixture.operationId));
    expect(operation?.state).toBe("cancelled");
  });

  test("S-14 preserves a claimed late result as attributed evidence without reopening a cancelled job", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-late-cancel");
    const asOwner = t.withIdentity(OWNER);
    const claim = await asOwner.mutation(claimRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.message}`);
    const cancellation = await asOwner.mutation(
      makeFunctionReference<"mutation", MutationArgs<typeof jobs.cancel>, MutationReturn<typeof jobs.cancel>>(
        "execution/jobs:cancel",
      ),
      { jobId: fixture.jobId, reason: "cancel while provider call is in flight" },
    );
    expect(cancellation.ok).toBe(true);
    const outcome = normalizeProviderResponse({
      mode: "scrape",
      response: {
        url: "https://supplier.example.test/late",
        json: {
          vendorName: "Supplier Example",
          productModel: "Model-Late",
          variant: "220V",
          price: 7950,
          currency: "EUR",
          availability: "in stock",
          delivery: "5 days",
          serviceCoverage: "NL",
        },
      },
      capturedAt: Date.now(),
      sourceUrl: "https://supplier.example.test/late",
      executionMode: "fixture",
    });
    const applied = await asOwner.mutation(applyOutcomeRef, {
      operationId: fixture.operationId,
      token: claim.attemptToken,
      identity: fixture.identity,
      outcome,
    });
    expect(applied.ok).toBe(true);
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(fixture.jobId),
      operation: await ctx.db.get(fixture.operationId),
      evidence: await ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(10),
    }));
    expect(rows.job?.state).toBe("cancelled");
    expect(rows.operation?.state).toBe("observedSuccess");
    expect(rows.evidence[0]?.sourceUrl).toBe("https://supplier.example.test/late");
  });

  test("S-14 stale input preserves collected evidence and leaves the current job partial", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-stale");
    const asOwner = t.withIdentity(OWNER);
    const claim = await asOwner.mutation(claimRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.message}`);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.grantId, { inputVersions: { brief: "r1-v2" } });
    });
    const outcome = normalizeProviderResponse({
      mode: "scrape",
      response: {
        url: "https://supplier.example.test/current",
        json: { productModel: "Model-A", variant: "220V", currency: "EUR", price: 7950 },
      },
      capturedAt: Date.now(),
      sourceUrl: "https://supplier.example.test/current",
      executionMode: "fixture",
    });
    const applied = await t.mutation(applyOutcomeRef, {
      operationId: fixture.operationId,
      token: claim.attemptToken,
      identity: fixture.identity,
      outcome,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.stale).toBe(true);
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(fixture.jobId),
      evidence: await ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(10),
    }));
    expect(rows.job?.state).toBe("partial");
    expect(rows.evidence[0]?.executionMode).toBe("fixture");
    expect(rows.evidence[0]?.sourceUrl).toBe("https://supplier.example.test/current");
    const recovery = await asOwner.mutation(recoverResearchRef, {
      jobId: fixture.jobId,
      operationId: fixture.operationId,
      requestId: "r1-stale-recovery",
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/current",
    });
    expect(recovery.ok).toBe(false);
    if (!recovery.ok) expect(recovery.code).toBe("stale-grant-version");
  });
});

describe("R1 project research pagination", () => {
  test("pages every evidence, claim, and candidate row independently without duplicates", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-independent-pagination");
    const expected = await t.run(async (ctx) => {
      const now = Date.now();
      const requirementId = await ctx.db.insert("requirements", {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        key: "pagination-requirement",
        title: "Pagination requirement",
        category: "equipment",
        quantity: "1",
        unit: "unit",
        priority: "P1",
        state: "approved",
        fulfillment: "notOrdered",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const vendorId = await ctx.db.insert("vendors", {
        organizationId: fixture.organizationId,
        name: "Pagination Vendor",
        regions: ["NL"],
        createdAt: now,
      });
      const candidateIds: Id<"candidates">[] = [];
      const claimIds: Id<"productEvidence">[] = [];
      for (let index = 0; index < 130; index += 1) {
        const candidateId = await ctx.db.insert("candidates", {
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          requirementId,
          vendorId,
          productModel: `Pagination Model ${index}`,
          variant: "220V",
          variantKey: `pagination-model-${index}`,
          compatibility: "unknown",
          conversationState: "draft",
          createdAt: now + index,
        });
        candidateIds.push(candidateId);
        const claimId = await ctx.db.insert("productEvidence", {
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          requirementId,
          candidateId,
          field: `pagination-field-${index}`,
          sourceKind: "controlled.pagination",
          capturedAt: now + index,
          originalValue: `source-${index}`,
          normalizedValue: `normalized-${index}`,
          verification: "unverified",
          freshness: "fresh",
          counterpartyRole: "vendor",
          executionMode: "fixture",
          origin: "internal",
          conflictEvidenceIds: [],
          idempotencyKey: `controlled-pagination-${index}`,
          version: "v1",
          createdAt: now + index,
        });
        claimIds.push(claimId);
      }
      const evidenceIds = await Promise.all(
        (["complete", "partial", "unavailable"] as const).map((completeness, index) =>
          ctx.db.insert("evidence", {
            organizationId: fixture.organizationId,
            projectId: fixture.projectId,
            sourceKind: `controlled.pagination.${completeness}`,
            sourceUrl: `https://supplier.example.test/pagination/${completeness}`,
            capturedAt: now + 200 + index,
            contentHash: `controlled-pagination-${completeness}`,
            completeness,
            counterpartyRole: "vendor",
            executionMode: "fixture",
          }),
        ),
      );
      return { candidateIds, claimIds, evidenceIds };
    });

    const asOwner = t.withIdentity(OWNER);
    let evidenceCursor: string | null = null;
    let claimsCursor: string | null = null;
    let candidatesCursor: string | null = null;
    const evidenceIds: Id<"evidence">[] = [];
    const claimIds: Id<"productEvidence">[] = [];
    const candidateIds: Id<"candidates">[] = [];
    const evidenceCompleteness = { complete: 0, partial: 0, unavailable: 0 };
    let lastPage: Awaited<QueryReturn<typeof research.projectResearch>> | undefined;

    for (let pageNumber = 0; pageNumber < 12; pageNumber += 1) {
      const page: Awaited<QueryReturn<typeof research.projectResearch>> = await asOwner.query(projectResearchRef, {
        projectId: fixture.projectId,
        paginationOpts: { numItems: 32, cursor: evidenceCursor },
        claimsPaginationOpts: { numItems: 32, cursor: claimsCursor },
        candidatesPaginationOpts: { numItems: 32, cursor: candidatesCursor },
      });
      if (!page.ok) throw new Error(`pagination query failed: ${page.message}`);
      lastPage = page;
      evidenceIds.push(...page.evidence.map((row) => row.id));
      claimIds.push(...page.claims.map((row) => row.id));
      candidateIds.push(...page.candidates.map((row) => row.id));
      expect(page.streamProgress.evidence.returned).toBe(page.evidence.length);
      expect(page.streamProgress.claims.returned).toBe(page.claims.length);
      expect(page.streamProgress.candidates.returned).toBe(page.candidates.length);
      expect(page.streamProgress.evidence.complete + page.streamProgress.evidence.partial + page.streamProgress.evidence.unavailable).toBe(page.evidence.length);
      evidenceCompleteness.complete += page.streamProgress.evidence.complete;
      evidenceCompleteness.partial += page.streamProgress.evidence.partial;
      evidenceCompleteness.unavailable += page.streamProgress.evidence.unavailable;
      expect(page.continueCursor).toBe(page.pagination.evidence.continueCursor);
      expect(page.isDone).toBe(page.pagination.evidence.isDone);
      evidenceCursor = page.pagination.evidence.continueCursor;
      claimsCursor = page.pagination.claims.continueCursor;
      candidatesCursor = page.pagination.candidates.continueCursor;
      if (page.pagination.evidence.isDone && page.pagination.claims.isDone && page.pagination.candidates.isDone) break;
      if (pageNumber === 11) throw new Error("pagination did not finish within the bounded test loop");
    }

    expect(lastPage).toBeDefined();
    expect(evidenceIds).toEqual(expect.arrayContaining(expected.evidenceIds));
    expect(claimIds).toEqual(expect.arrayContaining(expected.claimIds));
    expect(candidateIds).toEqual(expect.arrayContaining(expected.candidateIds));
    expect(evidenceIds).toHaveLength(expected.evidenceIds.length);
    expect(claimIds).toHaveLength(expected.claimIds.length);
    expect(candidateIds).toHaveLength(expected.candidateIds.length);
    expect(new Set(evidenceIds).size).toBe(expected.evidenceIds.length);
    expect(new Set(claimIds).size).toBe(expected.claimIds.length);
    expect(new Set(candidateIds).size).toBe(expected.candidateIds.length);
    expect(evidenceCompleteness).toEqual({ complete: 1, partial: 1, unavailable: 1 });
    expect(lastPage?.ok && lastPage.pagination.evidence.isDone).toBe(true);
    expect(lastPage?.ok && lastPage.pagination.claims.isDone).toBe(true);
    expect(lastPage?.ok && lastPage.pagination.candidates.isDone).toBe(true);
  });

  test("F17 blocks non-public literal source addresses", async () => {
    // Controlled regression for the public-source guard: literal loopback,
    // mapped loopback, ULA, unspecified, CGNAT, and related non-public ranges
    // are rejected while public DNS names and public literals still pass.
    const blocked = [
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/product",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::]/",
      "http://0.0.0.0/",
      "http://100.64.0.1/",
      "http://10.0.0.2/",
      "http://127.0.0.1/",
      "http://192.168.0.10/",
      "http://172.20.0.10/",
      "http://169.254.10.20/",
      "http://localhost/",
      "http://service.localhost/",
    ];
    for (const url of blocked) {
      expect(isSafePublicSourceUrl(url)).toBe(false);
    }
    const allowed = [
      "https://supplier.example.test/product",
      "http://example.nl/catalog",
      "https://8.8.8.8/",
      "http://[2001:4860:4860::8888]/",
    ];
    for (const url of allowed) {
      expect(isSafePublicSourceUrl(url)).toBe(true);
    }
  });

  test("rejects invalid stream cursors and denies a foreign project", async () => {
    const t = init();
    const fixture = await createFixture(t, "r1-pagination-denial");
    const asOwner = t.withIdentity(OWNER);
    const invalidCursor = await asOwner.query(projectResearchRef, {
      projectId: fixture.projectId,
      paginationOpts: { numItems: 16, cursor: "not-a-convex-cursor" },
    });
    expect(invalidCursor).toMatchObject({ ok: false, code: "invalid-pagination" });

    const foreignProjectId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        name: "Foreign research organization",
        kind: "private",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("projects", {
        organizationId,
        name: "Foreign research project",
        visibility: "restricted",
        createdAt: Date.now(),
      });
    });
    const denied = await asOwner.query(projectResearchRef, {
      projectId: foreignProjectId,
      paginationOpts: { numItems: 16, cursor: null },
    });
    expect(denied).toMatchObject({ ok: false, code: "denied-membership" });
  });
});

describe("R1 collection-target binding (F03)", () => {
  const INTENT = "Research suppliers for the espresso machine";

  test("F03 rejects a private IPv6 source URL before any dispatch or accounting", async () => {
    const t = init();
    const fixture = await createFixture(t, "f03-ipv6-fixture");
    const asOwner = t.withIdentity(OWNER);
    const before = await t.run(async (ctx) => ({
      jobs: (
        await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(16)
      ).length,
      operations: (await ctx.db.query("operations").withIndex("by_grant", (q) => q.eq("grantId", fixture.grantId)).take(65)).length,
      reservations: (await ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", fixture.jobId)).take(8)).length,
    }));
    const ula = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-private-ipv6",
      grantId: fixture.grantId,
      mode: "scrape",
      sourceUrl: "http://[fc00::1]/product",
    });
    expect(ula).toMatchObject({ ok: false, code: "invalid-payload" });
    const loopback = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-loopback-ipv6",
      grantId: fixture.grantId,
      mode: "map",
      sourceUrl: "http://[::1]/sitemap.xml",
    });
    expect(loopback).toMatchObject({ ok: false, code: "invalid-payload" });
    const after = await t.run(async (ctx) => ({
      jobs: (
        await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(16)
      ).length,
      operations: (await ctx.db.query("operations").withIndex("by_grant", (q) => q.eq("grantId", fixture.grantId)).take(65)).length,
      reservations: (await ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", fixture.jobId)).take(8)).length,
    }));
    expect(after).toEqual(before);
  });

  test("F03 same-requestId changed mode/sourceUrl conflicts while an identical retry succeeds", async () => {
    const t = init();
    const fixture = await createFixture(t, "f03-retry-fixture");
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-retry",
      grantId: fixture.grantId,
      mode: "search",
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.operationId === null) throw new Error("bound search request failed");
    const changed = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-retry",
      grantId: fixture.grantId,
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/other",
    });
    expect(changed).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const identical = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-retry",
      grantId: fixture.grantId,
      mode: "search",
    });
    expect(identical.ok).toBe(true);
    if (identical.ok && identical.operationId !== null) {
      expect(identical.operationId).toBe(first.operationId);
    } else {
      throw new Error("identical retry did not return the existing operation");
    }
    const rows = await t.run(async (ctx) => ({
      jobs: (await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(16)).length,
      operations: (await ctx.db.query("operations").withIndex("by_grant", (q) => q.eq("grantId", fixture.grantId)).take(65)).length,
    }));
    // Fixture operation plus the one bound search operation; the changed
    // retry created no job, reservation, or operation.
    expect(rows).toEqual({ jobs: 2, operations: 2 });
  });

  test("F03 recovery and transport bind the original collection target", async () => {
    const t = init();
    const fixture = await createFixture(t, "f03-recovery-fixture");
    const asOwner = t.withIdentity(OWNER);
    const sourceUrl = "https://supplier.example.test/product";
    const requested = await asOwner.mutation(requestGrantedResearchRef, {
      projectId: fixture.projectId,
      researchIntent: INTENT,
      requestId: "f03-bound",
      grantId: fixture.grantId,
      mode: "scrape",
      sourceUrl,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok || requested.operationId === null) throw new Error("bound scrape request failed");
    const operationId = requested.operationId;
    const jobId = requested.jobId;
    const partial = await t.action(executeRef, {
      operationId,
      identity: fixture.identity,
      mode: "scrape",
      sourceUrl,
      controlled: true,
      controlledResponseJson: JSON.stringify({
        url: sourceUrl,
        title: "Two group espresso machine",
        markdown: "A truncated source",
        truncated: true,
      }),
    });
    expect(partial.ok).toBe(true);
    const changedRecovery = await asOwner.mutation(recoverResearchRef, {
      jobId,
      operationId,
      requestId: "f03-recovery-changed",
      mode: "search",
    });
    expect(changedRecovery).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const changedSourceRecovery = await asOwner.mutation(recoverResearchRef, {
      jobId,
      operationId,
      requestId: "f03-recovery-changed-source",
      mode: "scrape",
      sourceUrl: "https://supplier.example.test/other",
    });
    expect(changedSourceRecovery).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const opsBefore = await t.run(async (ctx) =>
      (await ctx.db.query("operations").withIndex("by_job", (q) => q.eq("jobId", jobId)).take(65)).length,
    );
    expect(opsBefore).toBe(1);
    const recovered = await asOwner.mutation(recoverResearchRef, {
      jobId,
      operationId,
      requestId: "f03-recovery-same",
      mode: "scrape",
      sourceUrl,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("same-target recovery failed");
    expect(recovered.operationId).not.toBe(operationId);
    // The transport rejects scheduler arguments that disagree with the
    // stored binding before claiming, leaving the operation prepared.
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
    }));
    const mismatched = await t.action(executeRef, {
      operationId: recovered.operationId,
      identity: fixture.identity,
      mode: "search",
      controlled: true,
    });
    expect(mismatched).toMatchObject({ ok: false, code: "duplicate-conflict" });
    expect(calls).toHaveLength(0);
    const stored = await t.run(async (ctx) => await ctx.db.get(recovered.operationId));
    expect(stored?.state).toBe("prepared");
    // The bound target still executes honestly through the controlled path.
    const matched = await t.action(executeRef, {
      operationId: recovered.operationId,
      identity: fixture.identity,
      mode: "scrape",
      sourceUrl,
      controlled: true,
      controlledResponseJson: JSON.stringify({
        url: sourceUrl,
        title: "Two group espresso machine",
        markdown: "Recovered source",
      }),
    });
    expect(matched.ok).toBe(true);
  });
});
