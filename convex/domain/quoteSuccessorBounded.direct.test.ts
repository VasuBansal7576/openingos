/// <reference types="vite/client" />
/**
 * P2 F1 bounded quote-successor read (PRD 30 finite indexed reads; P-06/P-13).
 *
 * Controlled contract only: runs the ACTUAL recordSelection and
 * decideApproval handlers against the REAL schema via official convex-test.
 * No provider calls, mail, or external writes occur.
 *
 * Regression: successor detection used `by_project.collect()` plus an
 * in-memory `.some(supersedes === hash)`, so one existence question read
 * every quote row in the project (302 rows with 300 unrelated quotes).
 * It now uses the narrow `by_project_and_supersedes` index with `.first()`
 * (at most one row read), with identical deny/allow behavior.
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

const OWNER = { tokenIdentifier: "successor-bounded-owner" };
const UNRELATED_COUNT = 300;

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

async function setupGraph(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  suffix: string,
) {
  const asOwner = t.withIdentity(OWNER);
  const requirement = await asOwner.mutation(createRequirementRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    key: `req-${suffix}`,
    title: `Machine ${suffix}`,
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0",
  });
  if (!requirement.ok) throw new Error("requirement setup failed");
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.orgId,
    name: `Vendor ${suffix}`,
    regions: ["NL"],
  });
  if (!vendor.ok) throw new Error("vendor setup failed");
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: requirement.requirementId,
    vendorId: vendor.vendorId,
    productModel: `Model ${suffix}`,
    variant: "220V",
    conversationState: "draft",
  });
  if (!candidate.ok) throw new Error("candidate setup failed");
  return { requirementId: requirement.requirementId, vendorId: vendor.vendorId, candidateId: candidate.candidateId };
}

function quoteArgs(
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  version: string,
  refs: { supersedes?: string } = {},
) {
  return {
    organizationId: project.orgId,
    projectId: project.projectId,
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
      requirementId: "req-successor-bounded",
      scopeId: "scope-bounded",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    ...(refs.supersedes === undefined ? {} : { supersedes: refs.supersedes }),
  };
}

async function seedUnrelatedQuotes(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  count: number,
) {
  const asOwner = t.withIdentity(OWNER);
  for (let i = 0; i < count; i++) {
    const r = await asOwner.mutation(recordQuoteRef, quoteArgs(project, `unrelated-${i}`));
    if (!r.ok) throw new Error(`unrelated quote ${i} failed: ${JSON.stringify(r)}`);
  }
}

describe("bounded quote-successor reads", () => {
  test("recordSelection still rejects a real successor amid 300 unrelated quotes via the narrow index", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "successor-bounded-select");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1-target"));
    if (!v1.ok) throw new Error("v1 failed");
    await seedUnrelatedQuotes(t, project, UNRELATED_COUNT);
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2-successor", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");

    // The project history scales with unrelated rows...
    const historySize = await t.run((ctx) =>
      ctx.db.query("quotes").withIndex("by_project", (q) => q.eq("projectId", project.projectId)).collect()
        .then((rows) => rows.length),
    );
    expect(historySize).toBe(UNRELATED_COUNT + 2);

    // ...but the indexed existence probe answers with a single row.
    const indexedHit = await t.run((ctx) =>
      ctx.db.query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", project.projectId).eq("supersedes", v1.contentHash),
        )
        .first(),
    );
    expect(indexedHit?._id).toBe(v2.quoteId);
    const indexedMiss = await t.run((ctx) =>
      ctx.db.query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", project.projectId).eq("supersedes", v2.contentHash),
        )
        .first(),
    );
    expect(indexedMiss).toBeNull();

    // The actual handler still rejects the superseded terms on a new key...
    const fresh = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v1.quoteId,
      quoteVersion: "v1-target",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "bounded-new-key",
    });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.code).toBe("stale-quote-version");

    // ...while the current revision stays selectable amid the same history.
    const current = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v2.quoteId,
      quoteVersion: "v2-successor",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "bounded-current-key",
    });
    expect(current.ok).toBe(true);
  });

  test("recordSelection succeeds amid 300 unrelated quotes when nothing was superseded", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "successor-bounded-no-false-positive");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1-target"));
    if (!v1.ok) throw new Error("v1 failed");
    await seedUnrelatedQuotes(t, project, UNRELATED_COUNT);
    const selected = await asOwner.mutation(recordSelectionRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      quoteId: v1.quoteId,
      quoteVersion: "v1-target",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "bounded-first-key",
    });
    expect(selected.ok).toBe(true);
  });

  test("decideApproval still fences a real successor amid 300 unrelated quotes and decides current terms", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "successor-bounded-approve");
    const asOwner = t.withIdentity(OWNER);
    await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1-target"));
    if (!v1.ok) throw new Error("v1 failed");
    const staleCanonical = JSON.stringify({ quoteId: v1.quoteId, contentHash: v1.contentHash });
    const staleApproval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      quoteId: v1.quoteId,
      snapshotCanonical: staleCanonical,
      snapshotHash: await sha256Hex(staleCanonical),
    });
    if (!staleApproval.ok) throw new Error("stale approval setup failed");
    await seedUnrelatedQuotes(t, project, UNRELATED_COUNT);
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2-successor", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");

    const fenced = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: staleApproval.approvalId,
      decision: "approved",
    });
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.code).toBe("stale-approval-basis");

    const currentCanonical = JSON.stringify({ quoteId: v2.quoteId, contentHash: v2.contentHash });
    const currentApproval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      quoteId: v2.quoteId,
      snapshotCanonical: currentCanonical,
      snapshotHash: await sha256Hex(currentCanonical),
    });
    if (!currentApproval.ok) throw new Error("current approval setup failed");
    const decided = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: currentApproval.approvalId,
      decision: "approved",
    });
    expect(decided.ok).toBe(true);
  });
});
