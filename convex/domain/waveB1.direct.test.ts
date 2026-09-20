/// <reference types="vite/client" />
/**
 * Wave B1 regression tests for Astra review 2cd59ec (F1R-03, F1R-04, F1R-05).
 *
 * Controlled contract only: these tests run the ACTUAL exported domain
 * handlers against the REAL schema with authenticated identities via
 * official convex-test. No provider calls, mail, or external writes occur.
 *
 * - F1R-03: same-project graph contradictions are rejected at each
 *   insertion boundary with zero partial writes.
 * - F1R-04: superseded quote terms cannot authorize new selections or
 *   decisions; history stays intact.
 * - F1R-05: approval replay identity covers scope, links, and canonical
 *   text; divergence conflicts instead of returning the old row.
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
const recordProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordProductEvidence>,
  MutationReturn<typeof sourcing.recordProductEvidence>
>("domain/sourcing:recordProductEvidence");
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

const OWNER = { tokenIdentifier: "wave-b1-owner" };

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
  refs: {
    requirementId?: Id<"requirements">;
    vendorId?: Id<"vendors">;
    rfqId?: Id<"rfqs">;
    scopeRequirementId?: string;
    supersedes?: string;
  } = {},
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
      requirementId: refs.scopeRequirementId ?? "req-wave-b1",
      scopeId: "scope-b1",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    ...(refs.requirementId === undefined ? {} : { requirementId: refs.requirementId }),
    ...(refs.vendorId === undefined ? {} : { vendorId: refs.vendorId }),
    ...(refs.rfqId === undefined ? {} : { rfqId: refs.rfqId }),
    ...(refs.supersedes === undefined ? {} : { supersedes: refs.supersedes }),
  };
}

async function select(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  graph: { requirementId: Id<"requirements">; candidateId: Id<"candidates"> },
  quote: { quoteId: Id<"quotes"> },
  version: string,
) {
  return t.withIdentity(OWNER).mutation(recordSelectionRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: graph.requirementId,
    candidateId: graph.candidateId,
    quoteId: quote.quoteId,
    quoteVersion: version,
    quantity: "1",
    requirementVersion: 1,
  });
}

describe("F1R-03 same-project graph contradictions are rejected", () => {
  test("selection rejects a quote bound to another requirement and vendor", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-mismatch");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const quote = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: right.requirementId,
        vendorId: right.vendorId,
        scopeRequirementId: right.requirementId,
      }),
    );
    if (!quote.ok) throw new Error("quote setup failed");
    const selection = await select(t, project, left, quote, "v1");
    expect(selection.ok).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(rows).toHaveLength(0);
  });

  test("selection rejects a legacy quote whose RFQ belongs to another requirement", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-rfq-scope");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: right.requirementId,
      idempotencyKey: "rfq-right",
      scenarioVendorIds: [right.vendorId],
      lineItems: [{ itemId: "machine", description: "Right machine", quantity: "1", unit: "piece" }],
      briefHash: "right-scope",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq setup failed");
    // Legacy row shape: RFQ-bound but no requirement/vendor lineage.
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1", { rfqId: rfq.rfqId }));
    if (!quote.ok) throw new Error("quote setup failed");
    const selection = await select(t, project, left, quote, "v1");
    expect(selection.ok).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(rows).toHaveLength(0);
  });

  test("quote record rejects an RFQ bound to another requirement", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-quote-rfq");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: right.requirementId,
      idempotencyKey: "rfq-right-2",
      scenarioVendorIds: [right.vendorId],
      lineItems: [{ itemId: "machine", description: "Right machine", quantity: "1", unit: "piece" }],
      briefHash: "right-scope",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq setup failed");
    const before = await t.run((ctx) => ctx.db.query("quotes").collect());
    const quote = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: left.requirementId,
        vendorId: left.vendorId,
        rfqId: rfq.rfqId,
        scopeRequirementId: left.requirementId,
      }),
    );
    expect(quote.ok).toBe(false);
    const after = await t.run((ctx) => ctx.db.query("quotes").collect());
    expect(after).toHaveLength(before.length);
  });

  test("quote record rejects a vendor outside the RFQ scenario vendors", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-quote-vendor");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: right.requirementId,
      idempotencyKey: "rfq-right-3",
      scenarioVendorIds: [right.vendorId],
      lineItems: [{ itemId: "machine", description: "Right machine", quantity: "1", unit: "piece" }],
      briefHash: "right-scope",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq setup failed");
    const quote = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: right.requirementId,
        vendorId: left.vendorId,
        rfqId: rfq.rfqId,
        scopeRequirementId: right.requirementId,
      }),
    );
    expect(quote.ok).toBe(false);
  });

  test("opaque comparison scope labels pass through with requirement lineage", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-scope-label");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    // Established contract: comparisonScope.requirementId is an opaque
    // commercial scope label, not a row reference. Lineage agreement is
    // carried by requirementId/vendorId/RFQ bindings.
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1", {
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
    }));
    expect(quote.ok).toBe(true);
  });

  test("product evidence rejects a candidate/requirement mismatch", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-evidence");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const evidence = await asOwner.mutation(recordProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: left.requirementId,
      candidateId: right.candidateId,
      field: "power",
      sourceKind: "manual",
      sourceUrl: "https://example.test/x",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh",
      counterpartyRole: "vendor",
      idempotencyKey: "evidence-mismatch",
    });
    expect(evidence.ok).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("productEvidence").collect());
    expect(rows).toHaveLength(0);
  });

  test("matching lineage across quote, RFQ, selection, and evidence is accepted", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "graph-match");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-main",
      scenarioVendorIds: [graph.vendorId],
      lineItems: [{ itemId: "machine", description: "Main machine", quantity: "1", unit: "piece" }],
      briefHash: "main-scope",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq setup failed");
    const quote = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        rfqId: rfq.rfqId,
        scopeRequirementId: graph.requirementId,
      }),
    );
    if (!quote.ok) throw new Error("matching quote failed");
    const selection = await select(t, project, graph, quote, "v1");
    if (!selection.ok) throw new Error("matching selection failed");
    const evidence = await asOwner.mutation(recordProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      candidateId: graph.candidateId,
      field: "power",
      sourceKind: "manual",
      sourceUrl: "https://example.test/main",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh",
      counterpartyRole: "vendor",
      idempotencyKey: "evidence-match",
    });
    expect(evidence.ok).toBe(true);
  });
});

describe("F1R-04 superseded terms authorize nothing new", () => {
  test("a superseded quote cannot be newly selected; history stays", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "stale-select");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1"));
    if (!v1.ok) throw new Error("v1 failed");
    const first = await select(t, project, graph, v1, "v1");
    if (!first.ok) throw new Error("historical selection failed");
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");
    const retry = await select(t, project, graph, v1, "v1");
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe("stale-quote-version");
    const rows = await t.run((ctx) => ctx.db.query("selections").collect());
    expect(rows).toHaveLength(1);
  });

  test("a revision invalidates approval of obsolete quote-linked terms", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "stale-approve");
    const asOwner = t.withIdentity(OWNER);
    await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1"));
    if (!v1.ok) throw new Error("v1 failed");
    const snapshotCanonical = JSON.stringify({ quoteId: v1.quoteId, contentHash: v1.contentHash });
    const approval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      quoteId: v1.quoteId,
      snapshotCanonical,
      snapshotHash: await sha256Hex(snapshotCanonical),
    });
    if (!approval.ok) throw new Error("approval failed");
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");
    const decided = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.code).toBe("stale-approval-basis");
  });

  test("a selection-linked approval is fenced after the quoted basis changes", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "stale-select-link");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1"));
    if (!v1.ok) throw new Error("v1 failed");
    const selection = await select(t, project, graph, v1, "v1");
    if (!selection.ok) throw new Error("selection failed");
    const snapshotCanonical = JSON.stringify({ selection: selection.selectionId });
    const approval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      selectionId: selection.selectionId,
      snapshotCanonical,
      snapshotHash: await sha256Hex(snapshotCanonical),
    });
    if (!approval.ok) throw new Error("approval failed");
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");
    const decided = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decided.ok).toBe(false);
  });

  test("approvals on current terms still decide", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "current-terms");
    const asOwner = t.withIdentity(OWNER);
    await setupGraph(t, project, "main");
    const v1 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1"));
    if (!v1.ok) throw new Error("v1 failed");
    const v2 = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2", { supersedes: v1.contentHash }));
    if (!v2.ok) throw new Error("v2 failed");
    const snapshotCanonical = JSON.stringify({ quoteId: v2.quoteId, contentHash: v2.contentHash });
    const approval = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      quoteId: v2.quoteId,
      snapshotCanonical,
      snapshotHash: await sha256Hex(snapshotCanonical),
    });
    if (!approval.ok) throw new Error("approval failed");
    const decided = await asOwner.mutation(decideApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: "approved",
    });
    expect(decided.ok).toBe(true);
  });
});

describe("F1R-05 approval replay identity covers every material field", () => {
  test("changed scope conflicts even with an identical client snapshot", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-scope");
    const asOwner = t.withIdentity(OWNER);
    await setupGraph(t, project, "main");
    const snapshotCanonical = '{"decision":"quote"}';
    const snapshotHash = await sha256Hex(snapshotCanonical);
    const first = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      snapshotCanonical,
      snapshotHash,
    });
    if (!first.ok) throw new Error("approval failed");
    const second = await asOwner.mutation(recordApprovalRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "outbound-disclosure",
      snapshotCanonical,
      snapshotHash,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("duplicate-conflict");
  });

  test("changed selection and quote links conflict; identical replays dedupe", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-links");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const quote = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v1"));
    if (!quote.ok) throw new Error("quote failed");
    const quoteB = await asOwner.mutation(recordQuoteRef, quoteArgs(project, "v2"));
    if (!quoteB.ok) throw new Error("quote B failed");
    const selection = await select(t, project, graph, quote, "v1");
    if (!selection.ok) throw new Error("selection failed");
    const selectionB = await select(t, project, graph, quoteB, "v2");
    if (!selectionB.ok) throw new Error("selection B failed");
    const snapshotCanonical = '{"decision":"linked"}';
    const snapshotHash = await sha256Hex(snapshotCanonical);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      scope: "selection",
      snapshotCanonical,
      snapshotHash,
    };
    const first = await asOwner.mutation(recordApprovalRef, {
      ...base,
      selectionId: selection.selectionId,
      quoteId: quote.quoteId,
    });
    if (!first.ok) throw new Error("approval failed");
    const changedSelection = await asOwner.mutation(recordApprovalRef, {
      ...base,
      selectionId: selectionB.selectionId,
      quoteId: quote.quoteId,
    });
    expect(changedSelection.ok).toBe(false);
    const changedQuote = await asOwner.mutation(recordApprovalRef, {
      ...base,
      selectionId: selection.selectionId,
      quoteId: quoteB.quoteId,
    });
    expect(changedQuote.ok).toBe(false);
    const replay = await asOwner.mutation(recordApprovalRef, {
      ...base,
      selectionId: selection.selectionId,
      quoteId: quote.quoteId,
    });
    if (!replay.ok) throw new Error("identical replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.approvalId).toBe(first.approvalId);
  });

  test("a foreign link reusing an existing hash is denied", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, "replay-foreign-a");
    const asOwner = t.withIdentity(OWNER);
    const graphA = await setupGraph(t, projectA, "a");
    const projectB = await setupProject(t, "replay-foreign-b");
    const graphB = await setupGraph(t, projectB, "b");
    const quoteA = await asOwner.mutation(recordQuoteRef, quoteArgs(projectA, "v1"));
    if (!quoteA.ok) throw new Error("quote A failed");
    const selectionA = await select(t, projectA, graphA, quoteA, "v1");
    if (!selectionA.ok) throw new Error("selection A failed");
    const quoteB = await asOwner.mutation(recordQuoteRef, quoteArgs(projectB, "v1"));
    if (!quoteB.ok) throw new Error("quote B failed");
    const selectionB = await select(t, projectB, graphB, quoteB, "v1");
    if (!selectionB.ok) throw new Error("selection B failed");
    const snapshotCanonical = '{"decision":"foreign"}';
    const snapshotHash = await sha256Hex(snapshotCanonical);
    const first = await asOwner.mutation(recordApprovalRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      scope: "selection",
      selectionId: selectionA.selectionId,
      snapshotCanonical,
      snapshotHash,
    });
    if (!first.ok) throw new Error("approval failed");
    const foreign = await asOwner.mutation(recordApprovalRef, {
      organizationId: projectA.orgId,
      projectId: projectA.projectId,
      scope: "selection",
      selectionId: selectionB.selectionId,
      snapshotCanonical,
      snapshotHash,
    });
    expect(foreign.ok).toBe(false);
  });
});
