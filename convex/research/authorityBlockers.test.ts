/// <reference types="vite/client" />

/**
 * Astra authority-blocker adversarial regressions (controlled).
 *
 * Every case runs against convex-test with a stubbed Firecrawl fetch: no
 * live key, no live allowance, no external call. The
 * `RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD` env value under test is a
 * controlled ledger ceiling, never a real balance.
 *
 * - Atomic cross-org allowance: two organizations share one 100,000
 *   micro-USD deployment aggregate; the sum of reservations never exceeds
 *   it and the loser pauses with zero provider effect. Pre-existing org
 *   spend seeds the first global row instead of being forgotten.
 * - Unrelated public intake: guest opening workspaces with quantum or
 *   vacation briefs refuse with zero writes.
 * - Unrelated dispatch refusal: quantum/vacation requirements refuse before
 *   any grant, job, reservation, operation, schedule, or provider effect.
 * - Stale requirement claim: a requirement edit after dispatch rejects the
 *   claim with zero provider transport; the late result stays stale
 *   evidence and creates no candidate.
 * - Punctuation/replay: the canonical coffee-shop objective preserves
 *   location, rental, sourcing, and budget across periods, semicolons, and
 *   newlines; an identical replay deduplicates instead of conflicting while
 *   refusing purchase execution.
 * - Source non-promotion: Reddit, civic, and article URLs with titles only
 *   are stored as source records and never become vendors/candidates.
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
import * as execJobs from "../execution/jobs.js";
import * as reservations from "../execution/reservations.js";
import * as operations from "../execution/operations.js";
import * as intake from "../domain/intake.js";
import * as research from "./collection.js";
import { canonicalJson } from "../shared/hashing.js";
import { RESEARCH_ALLOWANCE_ENV_VAR } from "../execution/allowance.js";
import type { Id } from "../_generated/dataModel.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../domain/intake.ts",
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
    ? `research/${path.slice(2)}`
    : path.replace(/^(\.\.\/)+/, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer A, infer R> ? R : never;
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
const createWorkspaceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof intake.createWorkspace>,
  MutationReturn<typeof intake.createWorkspace>
>("domain/intake:createWorkspace");
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
const cancelResearchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof research.cancelResearch>,
  MutationReturn<typeof research.cancelResearch>
>("research/collection:cancelResearch");
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");
const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof execJobs.start>,
  MutationReturn<typeof execJobs.start>
>("execution/jobs:start");
const cancelJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof execJobs.cancel>,
  MutationReturn<typeof execJobs.cancel>
>("execution/jobs:cancel");
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

const OWNER_A = { tokenIdentifier: "blockers-owner-a" };
const OWNER_B = { tokenIdentifier: "blockers-owner-b" };
const GUEST = { tokenIdentifier: "blockers-guest" };

const ORIGINAL_ALLOWANCE = process.env[RESEARCH_ALLOWANCE_ENV_VAR];

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_ALLOWANCE === undefined) delete process.env[RESEARCH_ALLOWANCE_ENV_VAR];
  else process.env[RESEARCH_ALLOWANCE_ENV_VAR] = ORIGINAL_ALLOWANCE;
});

function init(): TestConvex<typeof schema> {
  process.env.FIRECRAWL_API_KEY = "controlled-blockers-key";
  const t = convexTest(schema, modules);
  firecrawl.register(t);
  return t;
}

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

function stubSearchFetch(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(completeSearchResponse("https://supplier.example.test/machine"), {
        status: 200,
      });
    }),
  );
}

async function createOrgProjectRequirement(
  t: TestConvex<typeof schema>,
  identity: { tokenIdentifier: string },
  name: string,
): Promise<{
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  requirementId: Id<"requirements">;
}> {
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: `${name} org`,
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: `${name} project`,
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
    organizationId: organization.organizationId,
    projectId: project.projectId,
    requirementId,
  };
}

async function globalCommitted(t: TestConvex<typeof schema>): Promise<{
  ceiling: number | null;
  committed: number;
  reserved: number;
  spent: number;
  unresolved: number;
}> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("deploymentAllowances")
      .withIndex("by_key", (q) => q.eq("key", "firecrawl-shared-global-v1"))
      .unique();
    if (row === null) {
      return { ceiling: null, committed: 0, reserved: 0, spent: 0, unresolved: 0 };
    }
    return {
      ceiling: row.ceilingMicroUsd,
      committed: row.reservedMicroUsd + row.spentMicroUsd + row.unresolvedMicroUsd,
      reserved: row.reservedMicroUsd,
      spent: row.spentMicroUsd,
      unresolved: row.unresolvedMicroUsd,
    };
  });
}

describe("atomic cross-org deployment allowance", () => {
  test("two organizations share one 100k aggregate; the fifth reservation pauses with no provider call", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const first = await createOrgProjectRequirement(t, OWNER_A, "Cross-org A");
    const second = await createOrgProjectRequirement(t, OWNER_B, "Cross-org B");
    const calls: string[] = [];
    stubSearchFetch(calls);

    const admitted: { jobId: Id<"jobs">; operationId: Id<"operations"> | null }[] = [];
    const keys = ["xorg-dispatch-1", "xorg-dispatch-2", "xorg-dispatch-3", "xorg-dispatch-4"];
    const fixtures = [first, first, second, second];
    const identities = [OWNER_A, OWNER_A, OWNER_B, OWNER_B];
    for (let index = 0; index < keys.length; index += 1) {
      const fixture = fixtures[index];
      if (fixture === undefined) throw new Error("fixture missing");
      const result = await t.withIdentity(identities[index] as { tokenIdentifier: string }).mutation(
        requestBoundedResearchRef,
        {
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          requirementId: fixture.requirementId,
          requirementVersion: 1,
          idempotencyKey: keys[index] as string,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.operationId === null) throw new Error("admitted dispatch failed");
      admitted.push({ jobId: result.jobId, operationId: result.operationId });
    }
    const aggregate = await globalCommitted(t);
    expect(aggregate.ceiling).toBe(100000);
    expect(aggregate.committed).toBe(100000);

    // The deployment aggregate is exhausted: one more full reservation in
    // either organization pauses with no new grant effect on the provider.
    const paused = await t.withIdentity(OWNER_B).mutation(requestBoundedResearchRef, {
      organizationId: second.organizationId,
      projectId: second.projectId,
      requirementId: second.requirementId,
      requirementVersion: 1,
      idempotencyKey: "xorg-dispatch-5",
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error("paused dispatch failed");
    expect(paused.operationId).toBe(null);
    expect(paused.state).toBe("pausedBudget");

    await t.finishAllScheduledFunctions(() => {});
    // Exactly the four admitted calls reached the provider.
    expect(calls).toHaveLength(4);
    expect((await globalCommitted(t)).committed).toBeLessThanOrEqual(100000);
  });

  test("pre-existing org spend seeds the first global row instead of starting at zero", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Legacy spend");
    await t.run(async (ctx) => {
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique();
      if (budget === null) {
        await ctx.db.insert("providerBudgets", {
          organizationId: fixture.organizationId,
          ceilingMicroUsd: 100000,
          reservedMicroUsd: 10000,
          spentMicroUsd: 60000,
          unresolvedMicroUsd: 5000,
          pricingBasis: "controlled-legacy-spend",
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.patch(budget._id, {
          reservedMicroUsd: 10000,
          spentMicroUsd: 60000,
          unresolvedMicroUsd: 5000,
        });
      }
    });
    // No global row exists yet: the next admission must account for the
    // observed 75,000 legacy commitment instead of minting a fresh zero row.
    expect((await globalCommitted(t)).ceiling).toBeNull();
    const calls: string[] = [];
    stubSearchFetch(calls);
    const admitted = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: 1,
      idempotencyKey: "legacy-seed-1",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok || admitted.operationId === null) throw new Error("legacy admission failed");
    const aggregate = await globalCommitted(t);
    // 75,000 legacy + 25,000 new reservation = exactly the 100,000 cap.
    expect(aggregate.ceiling).toBe(100000);
    expect(aggregate.committed).toBe(100000);
    const paused = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: 1,
      idempotencyKey: "legacy-seed-2",
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error("legacy pause failed");
    expect(paused.operationId).toBe(null);
    expect(paused.state).toBe("pausedBudget");
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
  });
});

describe("unrelated brief refusal before any effect", () => {
  test("guest opening intake with quantum or vacation briefs refuses with zero writes", async () => {
    const t = init();
    const before = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("projects").take(32)).length,
      grants: (await ctx.db.query("grants").take(32)).length,
      jobs: (await ctx.db.query("jobs").take(32)).length,
    }));
    for (const [key, summary] of [
      ["quantum-guest-1", "Explain quantum entanglement"],
      ["vacation-guest-1", "Book a vacation in Hawaii"],
    ] as const) {
      const result = await t.withIdentity(GUEST).mutation(createWorkspaceRef, {
        idempotencyKey: key,
        mode: "opening",
        projectName: "Unrelated guest",
        workspaceKind: "guest",
        region: "Hawaii",
        currency: "USD",
        detailSummary: summary,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unrelated intake must refuse");
      expect(result.code).toBe("unrelated-refusal");
    }
    const after = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("projects").take(32)).length,
      grants: (await ctx.db.query("grants").take(32)).length,
      jobs: (await ctx.db.query("jobs").take(32)).length,
    }));
    expect(after).toEqual(before);
  });

  test("quantum and vacation requirements refuse dispatch with zero grant/job/operation effects", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Unrelated dispatch");
    const calls: string[] = [];
    stubSearchFetch(calls);
    for (const [suffix, title] of [
      ["quantum", "Explain quantum entanglement"],
      ["vacation", "Book a vacation in Hawaii"],
    ] as const) {
      const requirementId = await t.run(async (ctx) => {
        const now = Date.now();
        return await ctx.db.insert("requirements", {
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          key: `unrelated-${suffix}`,
          title,
          category: "general",
          quantity: "1",
          unit: "scope",
          priority: "P1",
          state: "approved",
          fulfillment: "notOrdered",
          version: 1,
          hardConstraints: title,
          createdAt: now,
          updatedAt: now,
        });
      });
      const before = await t.run(async (ctx) => ({
        grants: (await ctx.db.query("grants").take(64)).length,
        jobs: (
          await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(64)
        ).length,
        operations: (await ctx.db.query("operations").take(128)).filter((row) => row.projectId === fixture.projectId)
          .length,
      }));
      const result = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        requirementId,
        requirementVersion: 1,
        idempotencyKey: `unrelated-${suffix}-1`,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unrelated dispatch must refuse");
      expect(result.code).toBe("unrelated-refusal");
      const after = await t.run(async (ctx) => ({
        grants: (await ctx.db.query("grants").take(64)).length,
        jobs: (
          await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(64)
        ).length,
        operations: (await ctx.db.query("operations").take(128)).filter((row) => row.projectId === fixture.projectId)
          .length,
      }));
      expect(after).toEqual(before);
    }
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(0);
  });
});

describe("stale requirement claim and late obsolete results", () => {
  test("a requirement edit after dispatch rejects the claim with no provider transport", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Stale claim");
    const calls: string[] = [];
    stubSearchFetch(calls);
    const dispatched = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: 1,
      idempotencyKey: "stale-claim-1",
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok || dispatched.operationId === null) throw new Error("dispatch failed");
    // Requirement edit after preparation: the bound v1 authority is obsolete.
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.requirementId, { version: 2, updatedAt: Date.now() });
    });
    // Drain only the already-scheduled transport: its claim must deny as
    // stale before any provider call, so no new transport happens.
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(0);
    const rows = await t.run(async (ctx) => ({
      operation: await ctx.db.get(dispatched.operationId as Id<"operations">),
      job: await ctx.db.get(dispatched.jobId),
    }));
    expect(rows.operation?.state).toBe("prepared");
    expect(rows.job?.state).not.toBe("completed");
  });
});

describe("canonical punctuation objective and identical replay", () => {
  test("periods, semicolons, and newlines preserve constraints; identical replay deduplicates", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Punctuation");
    const briefWithPeriods =
      "Open a coffee shop in San Francisco. Rent a place and buy everything needed. Budget USD 250,000-500,000.";
    const requirementId = await t.run(async (ctx) => {
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
        state: "approved",
        fulfillment: "notOrdered",
        version: 1,
        currency: "USD",
        budgetMinorUnits: 50_000_000,
        hardConstraints: `Primary region: San Francisco, CA\nOpening brief: ${briefWithPeriods}`,
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
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), { status: 200 });
      }),
    );
    const first = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId,
      requirementVersion: 1,
      idempotencyKey: "punctuation-replay-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.operationId === null) throw new Error("punctuation dispatch failed");
    const stored = await t.run(async (ctx) => {
      const operation = await ctx.db.get(first.operationId as Id<"operations">);
      const grant = operation === null ? null : await ctx.db.get(operation.grantId);
      return {
        payload: operation?.normalizedPayload ?? null,
        grantPayload: grant?.canonicalPayload ?? null,
      };
    });
    for (const payload of [stored.payload, stored.grantPayload]) {
      expect(payload).not.toBeNull();
      const lowered = (payload ?? "").toLowerCase();
      for (const fragment of ["san francisco", "rent", "everything needed", "usd 250,000-500,000"]) {
        expect(lowered).toContain(fragment);
      }
      // Purchase execution verbs never enter the dispatched objective.
      expect(lowered).not.toMatch(/\bbuy\b/);
      expect(lowered).not.toMatch(/\bpurchase\b/);
    }
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
    expect(bodies.join(" ")).toContain("San Francisco");
    const replay = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId,
      requirementVersion: 1,
      idempotencyKey: "punctuation-replay-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.operationId === null) throw new Error("replay failed");
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.operationId).toBe(first.operationId);
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
  });
});

describe("research source non-promotion", () => {
  test("titled Reddit, civic, and article URLs stay source records with zero vendors/candidates", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Non-promotion");
    const calls: string[] = [];
    stubSearchFetch(calls);
    const dispatched = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId: fixture.requirementId,
      requirementVersion: 1,
      idempotencyKey: "non-promotion-1",
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok || dispatched.operationId === null) throw new Error("dispatch failed");
    const operationId = dispatched.operationId;
    // Drive the transport inline with title-only sources: no vendor, no
    // model, no price — only titles and URLs. The controlled search shape
    // carries a top-level `web` array (the provider component unwraps the
    // transport envelope; the controlled path feeds the normalizer directly).
    const applied = await t.action(executeRef, {
      operationId,
      identity: OWNER_A.tokenIdentifier,
      mode: "search",
      controlled: true,
      controlledResponseJson: JSON.stringify({
        web: [
          {
            url: "https://www.reddit.com/r/restaurantowners/comments/1bcfts9",
            title: "Buyer delivery comparisons thread",
            markdown: "Buyers discuss curbside versus inside delivery.",
          },
          {
            url: "https://sf.gov/example-permit-page",
            title: "City permit information page",
            markdown: "General civic guidance with no commercial offer.",
          },
          {
            url: "https://supplier.example.test/blog/espresso-guide",
            title: "How to choose an espresso machine",
            markdown: "An informational article with no price or variant.",
          },
        ],
      }),
    });
    expect(applied.ok).toBe(true);
    const rows = await t.run(async (ctx) => ({
      evidence: await ctx.db
        .query("evidence")
        .withIndex("by_project", (q) => q.eq("projectId", fixture.projectId))
        .take(16),
      vendors: await ctx.db
        .query("vendors")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .take(16),
      candidates: await ctx.db
        .query("candidates")
        .withIndex("by_project", (q) => q.eq("projectId", fixture.projectId))
        .take(16),
    }));
    // Sources are preserved as immutable evidence...
    expect(rows.evidence.length).toBeGreaterThan(0);
    // ...but never promoted into vendor/product candidates.
    expect(rows.vendors).toHaveLength(0);
    expect(rows.candidates).toHaveLength(0);
    // Drain the twin scheduled by the dispatch itself; its claim is denied
    // against the already-resolved operation with no second provider call.
    await t.finishAllScheduledFunctions(() => {});
  });
});

describe("brief-metadata bypass refusal (PR-33 blocker 1)", () => {
  test("quantum brief with allowlisted title/category/key metadata still refuses dispatch", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Metadata bypass");
    const calls: string[] = [];
    stubSearchFetch(calls);
    // The stored brief is unrelated even though every metadata field carries
    // an allowlisted word (title, category, key all read as equipment).
    const requirementId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("requirements", {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        key: "equipment-scope",
        title: "Two-group espresso machine",
        category: "equipment",
        quantity: "1",
        unit: "scope",
        priority: "P0",
        state: "approved",
        fulfillment: "notOrdered",
        version: 1,
        hardConstraints: "Explain quantum entanglement",
        createdAt: now,
        updatedAt: now,
      });
    });
    const before = await t.run(async (ctx) => ({
      grants: (await ctx.db.query("grants").take(64)).length,
      jobs: (
        await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(64)
      ).length,
      operations: (await ctx.db.query("operations").take(128)).filter((row) => row.projectId === fixture.projectId)
        .length,
    }));
    const result = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId,
      requirementVersion: 1,
      idempotencyKey: "metadata-bypass-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("metadata-laundered dispatch must refuse");
    expect(result.code).toBe("unrelated-refusal");
    const after = await t.run(async (ctx) => ({
      grants: (await ctx.db.query("grants").take(64)).length,
      jobs: (
        await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", fixture.projectId)).take(64)
      ).length,
      operations: (await ctx.db.query("operations").take(128)).filter((row) => row.projectId === fixture.projectId)
        .length,
    }));
    expect(after).toEqual(before);
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(0);
  });

  test("quantum brief with equipment category refuses guest intake", async () => {
    const t = init();
    const before = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("projects").take(32)).length,
    }));
    const result = await t.withIdentity(GUEST).mutation(createWorkspaceRef, {
      idempotencyKey: "metadata-bypass-guest-1",
      mode: "opening",
      projectName: "Equipment review",
      workspaceKind: "guest",
      region: "Netherlands",
      currency: "EUR",
      detailCategory: "equipment",
      detailSummary: "Explain quantum entanglement",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("metadata-laundered intake must refuse");
    expect(result.code).toBe("unrelated-refusal");
    const after = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("projects").take(32)).length,
    }));
    expect(after).toEqual(before);
  });
});

describe("exclamation-mark canonical objective (PR-33 blocker 2)", () => {
  test("bang-separated constraints are preserved and identical replay deduplicates", async () => {
    const t = init();
    process.env[RESEARCH_ALLOWANCE_ENV_VAR] = "100000";
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Bang punctuation");
    const briefWithBangs =
      "Open a coffee shop in San Francisco! Rent a place and buy everything needed! Budget USD 250,000-500,000!";
    const requirementId = await t.run(async (ctx) => {
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
        state: "approved",
        fulfillment: "notOrdered",
        version: 1,
        currency: "USD",
        budgetMinorUnits: 50_000_000,
        hardConstraints: `Primary region: San Francisco, CA\nOpening brief: ${briefWithBangs}`,
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
        return new Response(completeSearchResponse("https://supplier.example.test/machine"), { status: 200 });
      }),
    );
    const first = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId,
      requirementVersion: 1,
      idempotencyKey: "bang-replay-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.operationId === null) throw new Error("bang dispatch failed");
    const stored = await t.run(async (ctx) => {
      const operation = await ctx.db.get(first.operationId as Id<"operations">);
      const grant = operation === null ? null : await ctx.db.get(operation.grantId);
      return {
        payload: operation?.normalizedPayload ?? null,
        grantPayload: grant?.canonicalPayload ?? null,
      };
    });
    // No clause may be dropped: location, rental, sourcing, and budget all
    // survive the bang separators in both the grant and operation payloads.
    for (const payload of [stored.payload, stored.grantPayload]) {
      expect(payload).not.toBeNull();
      const lowered = (payload ?? "").toLowerCase();
      for (const fragment of ["san francisco", "rent", "everything needed", "usd 250,000-500,000"]) {
        expect(lowered).toContain(fragment);
      }
      expect(lowered).not.toMatch(/\bbuy\b/);
      expect(lowered).not.toMatch(/\bpurchase\b/);
    }
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
    expect(bodies.join(" ")).toContain("San Francisco");
    const replay = await t.withIdentity(OWNER_A).mutation(requestBoundedResearchRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      requirementId,
      requirementVersion: 1,
      idempotencyKey: "bang-replay-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || replay.operationId === null) throw new Error("bang replay failed");
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.operationId).toBe(first.operationId);
    await t.finishAllScheduledFunctions(() => {});
    expect(calls).toHaveLength(1);
  });
});

describe("cancellation releases the global allowance (PR-33 blocker 3)", () => {
  test("four pre-claim cancellations free the deployment aggregate for the fifth reservation", async () => {
    // Scheduler-free fixture (S-14 pattern): no transport is ever scheduled,
    // so cancellation provably precedes any claim and no provider effect is
    // possible. Four jobs each reserve the 25,000 maximum against one
    // 100,000 grant; cancelling all four must release both ledgers.
    const t = init();
    const fixture = await createOrgProjectRequirement(t, OWNER_A, "Cancel releases global");
    await t.run(async (ctx) => {
      await ctx.db.insert("providerBudgets", {
        organizationId: fixture.organizationId,
        ceilingMicroUsd: 100000,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: 0,
        pricingBasis: "controlled-cancel-release",
        updatedAt: Date.now(),
      });
    });
    const asOwner = t.withIdentity(OWNER_A);
    const query = "Research suppliers for the espresso machine";
    const grant = await asOwner.mutation(issueGrantRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      operations: ["research.collect"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 0,
      inputVersions: { brief: "cancel-v1" },
      payloadJson: canonicalJson({ query }),
      costCeilingMicroUsd: 100000,
      roundLimit: 8,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
    const jobIds: Id<"jobs">[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const started = await asOwner.mutation(startJobRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        text: query,
        operationId: "research.collect",
        kind: "research",
        grantId: grant.grantId,
      });
      if (!started.ok) throw new Error(`job start failed: ${started.message}`);
      const reserved = await asOwner.mutation(reserveRef, {
        jobId: started.jobId,
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        amountMicroUsd: 25000,
        pricingBasis: "controlled-cancel-release",
      });
      if (!reserved.ok) throw new Error(`reservation failed: ${reserved.message}`);
      const created = await asOwner.mutation(createOperationRef, {
        jobId: started.jobId,
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        kind: "research.collect",
        requestId: `cancel-release-${index}`,
        payloadJson: canonicalJson({ query }),
        grantId: grant.grantId,
        reservationId: reserved.reservationId,
      });
      if (!created.ok) throw new Error(`operation creation failed: ${created.message}`);
      jobIds.push(started.jobId);
    }
    expect((await globalCommitted(t)).committed).toBe(100000);
    for (const jobId of jobIds) {
      const cancelled = await asOwner.mutation(cancelJobRef, {
        jobId,
        reason: "controlled pre-claim cancellation",
      });
      expect(cancelled.ok).toBe(true);
    }
    // Both ledgers are whole again with no spend, no unknowns, no attempts.
    expect((await globalCommitted(t)).committed).toBe(0);
    const ledgers = await t.run(async (ctx) => ({
      budget: await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique()
        .then((b) => (b === null ? null : { reserved: b.reservedMicroUsd, spent: b.spentMicroUsd, unresolved: b.unresolvedMicroUsd })),
      attempts: (await ctx.db.query("attempts").take(16)).length,
    }));
    expect(ledgers.budget).toEqual({ reserved: 0, spent: 0, unresolved: 0 });
    expect(ledgers.attempts).toBe(0);
    // The freed deployment aggregate admits the fifth full reservation.
    const fifth = await asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: query,
      operationId: "research.collect",
      kind: "research",
      grantId: grant.grantId,
    });
    if (!fifth.ok) throw new Error(`fifth job start failed: ${fifth.message}`);
    const fifthReserved = await asOwner.mutation(reserveRef, {
      jobId: fifth.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      amountMicroUsd: 25000,
      pricingBasis: "controlled-cancel-release",
    });
    expect(fifthReserved.ok).toBe(true);
    expect((await globalCommitted(t)).committed).toBe(25000);
  });
});
