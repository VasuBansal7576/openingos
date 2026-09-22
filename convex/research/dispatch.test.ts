/// <reference types="vite/client" />

/**
 * Bounded Firecrawl dispatch tests (one-click `requestBoundedResearch`).
 *
 * All provider transport runs through the installed Firecrawl component with
 * a stubbed fetch: no live key, no live allowance, no external call. The
 * `RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD` env value under test is a
 * controlled ledger ceiling, never a real balance.
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
import * as research from "./collection.js";
import { RESEARCH_ALLOWANCE_ENV_VAR } from "../execution/allowance.js";
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
const grantProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.grantProjectAccess>,
  MutationReturn<typeof memberships.grantProjectAccess>
>("access/memberships:grantProjectAccess");
const requestBoundedResearchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof research.requestBoundedResearch>,
  MutationReturn<typeof research.requestBoundedResearch>
>("research/collection:requestBoundedResearch");
const executeRef = makeFunctionReference<
  "action",
  ActionArgs<typeof research.execute>,
  ActionReturn<typeof research.execute>
>("research/collection:execute");
const projectResearchRef = makeFunctionReference<
  "query",
  QueryArgs<typeof research.projectResearch>,
  Awaited<QueryReturn<typeof research.projectResearch>>
>("research/collection:projectResearch");

const OWNER = { tokenIdentifier: "dispatch-owner" };
const VIEWER = { tokenIdentifier: "dispatch-viewer" };
const ALLOWANCE = "100000";

interface DispatchFixture {
  readonly t: TestConvex<typeof schema>;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
  readonly requirementVersion: number;
}

async function createDispatchFixture(t: TestConvex<typeof schema>): Promise<DispatchFixture> {
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Dispatch controlled org",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Dispatch controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const requirementId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("requirements", {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      key: "REQ-1",
      title: "Two-group espresso machine",
      category: "equipment",
      quantity: "2",
      unit: "piece",
      priority: "P0",
      state: "approved",
      fulfillment: "notOrdered",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
  return {
    t,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    requirementId,
    requirementVersion: 1,
  };
}

async function countDispatchEffects(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
): Promise<{
  jobs: number;
  operations: number;
  reservations: number;
  grants: number;
  evidence: number;
  budgetCeiling: number | null;
  budgetReserved: number | null;
}> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(64);
    const operations = (await ctx.db.query("operations").take(128)).filter(
      (row) => row.projectId === projectId,
    );
    const reservations = (
      await Promise.all(
        jobs.map((job) =>
          ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", job._id)).take(64),
        ),
      )
    ).flat();
    const grants = (await ctx.db.query("grants").take(128)).filter(
      (row) => row.organizationId === organizationId && row.projectId === projectId,
    );
    const evidence = await ctx.db
      .query("evidence")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(64);
    const budget = await ctx.db
      .query("providerBudgets")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .unique();
    return {
      jobs: jobs.length,
      operations: operations.length,
      reservations: reservations.length,
      grants: grants.length,
      evidence: evidence.length,
      budgetCeiling: budget?.ceilingMicroUsd ?? null,
      budgetReserved: budget?.reservedMicroUsd ?? null,
    };
  });
}

function init(): TestConvex<typeof schema> {
  process.env.FIRECRAWL_API_KEY = "controlled-dispatch-key";
  const t = convexTest(schema, modules);
  firecrawl.register(t);
  return t;
}

const ORIGINAL_ALLOWANCE = process.env[RESEARCH_ALLOWANCE_ENV_VAR];

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_ALLOWANCE === undefined) delete process.env[RESEARCH_ALLOWANCE_ENV_VAR];
  else process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ORIGINAL_ALLOWANCE;
});

function completeSearchResponse(url: string): string {
  return JSON.stringify({
    success: true,
    data: {
      web: [
        {
          url,
          title: "Two-group espresso machine",
          markdown: "A complete controlled source",
          json: {
            vendorName: "Harbor Equipment",
            productModel: "Atlas 2G",
            variant: "220V",
            price: 7950,
            currency: "EUR",
            availability: "in stock",
            delivery: "5 days",
            serviceCoverage: "NL",
          },
        },
      ],
    },
  });
}

describe("requestBoundedResearch one-click dispatch", () => {
  test("missing allowance performs zero grant/job/operation/provider effects", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    delete process.env[RESEARCH_ALLOWANCE_ENV_VAR];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(result).toMatchObject({ ok: false, code: "allowance-exhausted" });
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(0);
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toEqual({
      jobs: 0,
      operations: 0,
      reservations: 0,
      grants: 0,
      evidence: 0,
      budgetCeiling: null,
      budgetReserved: null,
    });
  });

  test("invalid allowance values fail before any provider effect", async () => {
    for (const allowance of ["", "not-a-number", "0", "24999", "10000001", "12.5"]) {
      const t = init();
      const fixture = await createDispatchFixture(t);
      process.env[RESEARCH_ALLOWANCE_ENV_VAR] = allowance;
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          calls.push(String(url));
          return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
            status: 200,
          });
        }),
      );
      const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        requirementId: fixture.requirementId,
        requirementVersion: fixture.requirementVersion,
        idempotencyKey: "bounded-dispatch-1",
      });
      expect(result).toMatchObject({ ok: false, code: "allowance-exhausted" });
      await t.finishAllScheduledFunctions(() => {});
      expect(calls).toHaveLength(0);
      expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toEqual({
        jobs: 0,
        operations: 0,
        reservations: 0,
        grants: 0,
        evidence: 0,
        budgetCeiling: null,
        budgetReserved: null,
      });
    }
  });

  test("first dispatch schedules exactly one bounded Firecrawl call with one reservation", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.operationId === null) throw new Error("bounded dispatch failed");
    expect(result.state).toBe("queued");
    const before = await countDispatchEffects(t, fixture.organizationId, fixture.projectId);
    expect(before).toMatchObject({
      jobs: 1,
      operations: 1,
      reservations: 1,
      grants: 1,
      evidence: 0,
      budgetCeiling: 100000,
      budgetReserved: 25000,
    });
    const grant = await t.run(async (ctx) => {
      const rows = (await ctx.db.query("grants").take(8)).filter(
        (row) => row.projectId === fixture.projectId,
      );
      return rows[0];
    });
    expect(grant?.operations).toEqual(["research.collect"]);
    expect(grant?.costCeilingMicroUsd).toBe(25000);
    await t.finishAllScheduledFunctions(() => {});
    // Exactly one provider transport batch for the one scheduled action.
    expect(calls).toHaveLength(1);
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(result.jobId),
      operation: await ctx.db.get(result.operationId as Id<"operations">),
    }));
    expect(rows.job?.state).toBe("completed");
    expect(rows.operation?.state).toBe("observedSuccess");
    const after = await countDispatchEffects(t, fixture.organizationId, fixture.projectId);
    expect(after.evidence).toBeGreaterThan(0);
    // Provider records surface through the existing projection.
    const projected = await t.withIdentity(OWNER).query(projectResearchRef, {
      projectId: fixture.projectId,
      paginationOpts: { numItems: 16, cursor: null },
    });
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(projected.evidence.length).toBeGreaterThan(0);
      expect(
        projected.evidence.every((row) => row.projectId === fixture.projectId),
      ).toBe(true);
    }
  });

  test("exact replay returns the original job with no second effect", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const dispatch = {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    };
    const first = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, dispatch);
    expect(first.ok).toBe(true);
    if (!first.ok || first.operationId === null) throw new Error("first dispatch failed");
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
    const second = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, dispatch);
    expect(second.ok).toBe(true);
    if (!second.ok || second.operationId === null) throw new Error("replay failed");
    expect(second.jobId).toBe(first.jobId);
    expect(second.operationId).toBe(first.operationId);
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toMatchObject({
      jobs: 1,
      operations: 1,
      reservations: 1,
      grants: 1,
    });
  });

  test("cross-project and changed requirements are denied with no new effect", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const asOwner = t.withIdentity(OWNER);
    const otherProject = await asOwner.mutation(createProjectRef, {
      organizationId: fixture.organizationId,
      name: "Dispatch other project",
      visibility: "open",
    });
    if (!otherProject.ok) throw new Error(`other project setup failed: ${otherProject.message}`);
    const otherRequirementId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("requirements", {
        organizationId: fixture.organizationId,
        projectId: otherProject.projectId,
        key: "REQ-9",
        title: "Undercounter refrigerator",
        category: "equipment",
        quantity: "1",
        unit: "piece",
        priority: "P1",
        state: "approved",
        fulfillment: "notOrdered",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const before = await countDispatchEffects(t, fixture.organizationId, fixture.projectId);
    // A requirement from another project cannot ride this project's dispatch.
    const crossProject = await asOwner.mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: otherRequirementId,
      requirementVersion: 1,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(crossProject).toMatchObject({ ok: false, code: "denied-project" });
    // An edited requirement version no longer matches the prepared dispatch.
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.requirementId, { version: 2, updatedAt: Date.now() });
    });
    const changed = await asOwner.mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(changed).toMatchObject({ ok: false, code: "changed-requirement" });
    // A decided requirement is no longer current research work.
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.requirementId, {
        version: fixture.requirementVersion,
        state: "selected",
        updatedAt: Date.now(),
      });
    });
    const stale = await asOwner.mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(stale).toMatchObject({ ok: false, code: "stale-requirement" });
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toEqual(before);
  });

  test("provider failure stays honest with no fabricated evidence", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ success: false, error: "temporary" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }),
    );
    const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.operationId === null) throw new Error("bounded dispatch failed");
    // Drive the scheduled transport inline (S-11 pattern): the component's
    // bounded retry batch runs inside this awaited action, so no background
    // provider work can leak into later tests.
    const executed = await t.action(executeRef, {
      operationId: result.operationId,
      identity: OWNER.tokenIdentifier,
      mode: "search",
    });
    expect(executed.ok).toBe(false);
    // Bounded transport only: the component's own retry batch, no multiplier.
    expect(calls).toHaveLength(4);
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(result.jobId),
      operation: await ctx.db.get(result.operationId as Id<"operations">),
      reservation: (
        await ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", result.jobId)).take(4)
      )[0],
    }));
    expect(rows.operation?.state).toBe("outcomeUnknown");
    expect(rows.job?.state).not.toBe("completed");
    // Unknown charges are retained, never released as free.
    expect(rows.reservation?.unresolvedMicroUsd).toBe(25000);
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toMatchObject({
      evidence: 0,
    });
    // Drain the twin scheduled by the dispatch itself. Its claim is denied
    // against the already-resolved operation, so it performs no second
    // provider call and leaves no background work for later tests.
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(4);
  });

  test("an existing ledger is never refilled by a new allowance value", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("providerBudgets", {
        organizationId: fixture.organizationId,
        ceilingMicroUsd: 50000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-existing-ledger",
        updatedAt: Date.now(),
      });
    });
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "90000";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(result.ok).toBe(true);
    const budget = await t.run(async (ctx) =>
      ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique(),
    );
    expect(budget?.ceilingMicroUsd).toBe(50000);
    expect(budget?.pricingBasis).toBe("controlled-existing-ledger");
    expect(budget?.reservedMicroUsd).toBe(25000);
    // The admitted dispatch still executes exactly once; draining here also
    // leaves no background provider work for later tests.
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
  });

  test("viewer role and missing identity cannot dispatch", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const granted = await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      targetIdentity: VIEWER.tokenIdentifier,
      role: "viewer",
    });
    if (!granted.ok) throw new Error(`viewer grant failed: ${granted.message}`);
    const dispatch = {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    };
    const viewerResult = await t.withIdentity(VIEWER).mutation(requestBoundedResearchRef, dispatch);
    expect(viewerResult.ok).toBe(false);
    const unauthenticated = await t.mutation(requestBoundedResearchRef, dispatch);
    expect(unauthenticated).toMatchObject({ ok: false, code: "forged-identity" });
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toEqual({
      jobs: 0,
      operations: 0,
      reservations: 0,
      grants: 0,
      evidence: 0,
      budgetCeiling: null,
      budgetReserved: null,
    });
  });

  test("a second bounded call pauses honestly when the shared ledger is exhausted", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    // One full reservation fits; a second full reservation cannot.
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "30000";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const first = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-1",
    });
    expect(first.ok).toBe(true);
    const second = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-dispatch-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("paused dispatch failed");
    expect(second.operationId).toBe(null);
    expect(second.state).toBe("pausedBudget");
    await t.finishAllScheduledFunctions(() => {});
    // Only the first admitted call reached the provider.
    expect(calls).toHaveLength(1);
  });

  test("opening research intent carries the exact region and brief from the requirement", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    // The authoritative requirement as the fixed intake now persists it for
    // the live browser case: exact title, category, region, and brief.
    const brief =
      "Open a coffee shop in San Francisco; rent a place and buy everything needed for the coffee shop; budget USD 250,000-500,000.";
    const openingRequirementId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("requirements", {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        key: "opening-scope",
        title: "San Francisco coffee shop real estate and equipment",
        category: "coffee shop opening",
        quantity: "1",
        unit: "scope",
        priority: "P0",
        state: "draft",
        fulfillment: "notOrdered",
        version: 1,
        currency: "USD",
        budgetMinorUnits: 50_000_000,
        hardConstraints: `Primary region: San Francisco, CA\nOpening brief: ${brief}`,
        createdAt: now,
        updatedAt: now,
      });
    });
    const calls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        calls.push(String(url));
        bodies.push(typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? null));
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
          status: 200,
        });
      }),
    );
    const result = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: openingRequirementId,
      requirementVersion: 1,
      idempotencyKey: "bounded-opening-brief-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.operationId === null) throw new Error("opening dispatch failed");
    // The bound intent (idempotency/canonical payload) carries the exact
    // region and brief rather than a generic scope sentence.
    const stored = await t.run(async (ctx) => {
      const operation = await ctx.db.get(result.operationId as Id<"operations">);
      const grant = operation === null ? null : await ctx.db.get(operation.grantId);
      return { payload: operation?.normalizedPayload ?? null, grantPayload: grant?.canonicalPayload ?? null };
    });
    for (const payload of [stored.payload, stored.grantPayload]) {
      expect(payload).not.toBeNull();
      for (const fragment of [
        "San Francisco",
        "rent",
        "everything needed",
        "USD 250,000-500,000",
        "coffee shop opening",
      ]) {
        expect(payload).toContain(fragment);
      }
    }
    await t.finishAllScheduledFunctions(() => {});
    // Exactly one provider call for the one scheduled action.
    expect(calls).toHaveLength(1);
    expect(bodies.join(" ")).toContain("San Francisco");
    const rows = await t.run(async (ctx) => ({
      job: await ctx.db.get(result.jobId),
      operation: await ctx.db.get(result.operationId as Id<"operations">),
    }));
    expect(rows.job?.state).toBe("completed");
    expect(rows.operation?.state).toBe("observedSuccess");
    // Exact replay reuses the original job and operation: still one call.
    const replay = await t.withIdentity(OWNER).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: openingRequirementId,
      requirementVersion: 1,
      idempotencyKey: "bounded-opening-brief-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.operationId === null) throw new Error("opening replay failed");
    expect(replay.jobId).toBe(result.jobId);
    expect(replay.operationId).toBe(result.operationId);
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
  });

  test("opening dispatch keeps the denial fences with zero new effect", async () => {
    const t = init();
    const fixture = await createDispatchFixture(t);
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ALLOWANCE;
    const granted = await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      targetIdentity: VIEWER.tokenIdentifier,
      role: "viewer",
    });
    if (!granted.ok) throw new Error(`viewer grant failed: ${granted.message}`);
    const dispatch = {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: fixture.requirementVersion,
      idempotencyKey: "bounded-opening-brief-1",
    };
    const viewerResult = await t.withIdentity(VIEWER).mutation(requestBoundedResearchRef, dispatch);
    expect(viewerResult.ok).toBe(false);
    const unauthenticated = await t.mutation(requestBoundedResearchRef, dispatch);
    expect(unauthenticated).toMatchObject({ ok: false, code: "forged-identity" });
    expect(await countDispatchEffects(t, fixture.organizationId, fixture.projectId)).toEqual({
      jobs: 0,
      operations: 0,
      reservations: 0,
      grants: 0,
      evidence: 0,
      budgetCeiling: null,
      budgetReserved: null,
    });
  });
});
