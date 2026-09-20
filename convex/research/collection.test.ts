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
} from "convex/server";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "../execution/jobs.js";
import * as reservations from "../execution/reservations.js";
import * as operations from "../execution/operations.js";
import * as research from "./collection.js";
import { normalizeProviderResponse } from "./contracts.js";
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
