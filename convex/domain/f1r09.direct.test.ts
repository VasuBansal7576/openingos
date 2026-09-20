/// <reference types="vite/client" />
/**
 * F1R-09 money/quantity validation (controlled contract).
 *
 * Runs the ACTUAL exported domain handlers against the REAL schema with
 * authenticated identities via official convex-test. No provider calls.
 *
 * - requirements.create reuses proofs/money quantity/currency/money:
 *   zero/negative, malformed, and unsupported-precision quantities are
 *   denied before any write; nonfinite/fractional/unsafe budget units
 *   and invalid currency are denied; valid normalized decimals persist
 *   in canonical form.
 * - workspace template parsing/instantiation validates snapshot
 *   quantities through the same contract: an invalid template creates
 *   zero requirements and zero dependencies.
 * - fulfillment.recordCostEntry validates through proofs/money:
 *   nonfinite/fractional/unsafe minor units and invalid currency are
 *   denied before any write; zero/negative are forbidden.
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
import * as workspace from "./workspace.js";

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
const recordCostEntryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordCostEntry>,
  MutationReturn<typeof fulfillment.recordCostEntry>
>("domain/fulfillment:recordCostEntry");
const saveTemplateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.saveTemplate>,
  MutationReturn<typeof workspace.saveTemplate>
>("domain/workspace:saveTemplate");
const instantiateTemplateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.instantiateTemplate>,
  MutationReturn<typeof workspace.instantiateTemplate>
>("domain/workspace:instantiateTemplate");

const OWNER = { tokenIdentifier: "f1r09-owner" };

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

function requirementArgs(
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  key: string,
  extra: Record<string, unknown> = {},
) {
  return {
    organizationId: project.orgId,
    projectId: project.projectId,
    key,
    title: `Title ${key}`,
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0" as const,
    ...extra,
  };
}

async function setupOrderChain(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  suffix: string,
) {
  const asOwner = t.withIdentity(OWNER);
  const req = await asOwner.mutation(createRequirementRef, requirementArgs(project, `req-${suffix}`));
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
    productModel: `Model ${suffix}`,
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
    lineItems: [{ itemId: "machine", description: "Machine", quantity: "1", unit: "piece" }],
    briefHash: "brief-f1r09",
    conversationState: "draft",
  });
  if (!rfq.ok) throw new Error("rfq setup failed");
  const quote = await asOwner.mutation(recordQuoteRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    version: `v-${suffix}`,
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
  });
  if (!selection.ok) throw new Error(`selection setup failed: ${JSON.stringify(selection)}`);
  const order = await asOwner.mutation(recordOrderRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    selectionId: selection.selectionId,
    idempotencyKey: `ord-${suffix}`,
    orderedQuantity: "1",
  });
  if (!order.ok) throw new Error("order setup failed");
  return { orderId: order.orderId };
}

describe("F1R-09 requirement quantity validation", () => {
  test("zero and negative quantities are denied with zero rows", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-sign");
    const asOwner = t.withIdentity(OWNER);
    for (const [index, bad] of ["0", "0.0", "-1", "-2.5"].entries()) {
      const denied = await asOwner.mutation(
        createRequirementRef,
        requirementArgs(project, `bad-sign-${index}`, { quantity: bad }),
      );
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("requirements").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("malformed quantities are denied with zero rows", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-malformed");
    const asOwner = t.withIdentity(OWNER);
    for (const [index, bad] of ["", "abc", "1.2.3", "1e3", "--2", "  "].entries()) {
      const denied = await asOwner.mutation(
        createRequirementRef,
        requirementArgs(project, `bad-mal-${index}`, { quantity: bad }),
      );
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("requirements").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("unsupported-precision quantities are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-precision");
    const asOwner = t.withIdentity(OWNER);
    const tooManyDecimals = `1.${"0".repeat(18)}1`;
    const tooManyDigits = "9".repeat(37);
    for (const [index, bad] of [tooManyDecimals, tooManyDigits].entries()) {
      const denied = await asOwner.mutation(
        createRequirementRef,
        requirementArgs(project, `bad-prec-${index}`, { quantity: bad }),
      );
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("requirements").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("valid normalized decimals persist in canonical form", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-normalized");
    const asOwner = t.withIdentity(OWNER);
    const cases: [string, string, string][] = [
      ["norm-a", "1.0", "1"],
      ["norm-b", "2.50", "2.5"],
      ["norm-c", "0.50", "0.5"],
    ];
    for (const [key, input, expected] of cases) {
      const created = await asOwner.mutation(
        createRequirementRef,
        requirementArgs(project, key, { quantity: input }),
      );
      if (!created.ok) throw new Error(`valid quantity ${input} denied`);
      const row = await t.run((ctx) => ctx.db.get(created.requirementId));
      expect(row?.quantity).toBe(expected);
    }
  });
});

describe("F1R-09 requirement budget and currency validation", () => {
  test("invalid currency is denied with zero rows", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-currency");
    const asOwner = t.withIdentity(OWNER);
    for (const [index, bad] of ["eur", "EURO", "", "US", "Eur"].entries()) {
      const denied = await asOwner.mutation(
        createRequirementRef,
        requirementArgs(project, `bad-cur-${index}`, { currency: bad }),
      );
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("requirements").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("nonfinite, fractional, unsafe, and negative budget units are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-budget");
    const asOwner = t.withIdentity(OWNER);
    const badUnits: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10.5,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
    ];
    for (const [index, minorUnits] of badUnits.entries()) {
      let denied: { ok: boolean };
      try {
        denied = await asOwner.mutation(
          createRequirementRef,
          requirementArgs(project, `bad-bud-${index}`, {
            currency: "EUR",
            budgetMinorUnits: minorUnits,
          }),
        );
      } catch {
        // Convex validator rejection counts as a denial before any write.
        continue;
      }
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("requirements").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("valid budget money is accepted", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "req-budget-ok");
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(
      createRequirementRef,
      requirementArgs(project, "good-budget", { currency: "EUR", budgetMinorUnits: 795000 }),
    );
    expect(created.ok).toBe(true);
  });
});

describe("F1R-09 template quantity validation", () => {
  test("saveTemplate rejects an invalid quantity snapshot with zero templates", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "tpl-save-bad");
    const asOwner = t.withIdentity(OWNER);
    const denied = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "bad template",
      version: "v1",
      requirementSnapshot: JSON.stringify([
        { key: "a", title: "A", category: "coffee", quantity: "not-a-number", unit: "piece" },
      ]),
      constraintSnapshot: JSON.stringify([]),
    });
    expect(denied.ok).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("templates").collect());
    expect(rows.filter((row) => row.organizationId === project.orgId)).toHaveLength(0);
  });

  test("an invalid stored template instantiates zero requirements and zero dependencies", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "tpl-inst-bad");
    const target = await t.withIdentity(OWNER).mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "tpl target project",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target setup failed");
    const templateId = await t.run((ctx) =>
      ctx.db.insert("templates", {
        organizationId: project.orgId,
        sourceProjectId: project.projectId,
        name: "legacy bad template",
        version: "legacy-1",
        requirementSnapshot: JSON.stringify([
          { key: "a", title: "A", category: "coffee", quantity: "0", unit: "piece" },
          { key: "b", title: "B", category: "coffee", quantity: "1", unit: "piece" },
        ]),
        constraintSnapshot: JSON.stringify([{ fromKey: "a", toKey: "b", kind: "technical" }]),
        createdAt: Date.now(),
      }),
    );
    const denied = await t.withIdentity(OWNER).mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId,
    });
    expect(denied.ok).toBe(false);
    const reqs = await t.run((ctx) => ctx.db.query("requirements").collect());
    const deps = await t.run((ctx) => ctx.db.query("dependencies").collect());
    expect(reqs.filter((row) => row.projectId === target.projectId)).toHaveLength(0);
    expect(deps.filter((row) => row.projectId === target.projectId)).toHaveLength(0);
  });

  test("a valid template normalizes decimals on instantiation", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "tpl-inst-ok");
    const asOwner = t.withIdentity(OWNER);
    const saved = await asOwner.mutation(saveTemplateRef, {
      organizationId: project.orgId,
      sourceProjectId: project.projectId,
      name: "good template",
      version: "v1",
      requirementSnapshot: JSON.stringify([
        { key: "a", title: "A", category: "coffee", quantity: "3.00", unit: "piece" },
      ]),
      constraintSnapshot: JSON.stringify([]),
    });
    if (!saved.ok) throw new Error("valid template save failed");
    const target = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "tpl target ok",
      visibility: "open",
    });
    if (!target.ok) throw new Error("target setup failed");
    const instantiated = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: project.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!instantiated.ok) throw new Error("valid instantiation failed");
    const row = await t.run((ctx) => ctx.db.get(instantiated.requirementIds[0] as Id<"requirements">));
    expect(row?.quantity).toBe("3");
  });
});

describe("F1R-09 cost entry money validation", () => {
  test("zero, negative, fractional, unsafe, and nonfinite minor units are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "cost-units");
    const { orderId } = await setupOrderChain(t, project, "units");
    const asOwner = t.withIdentity(OWNER);
    const badUnits: unknown[] = [0, -100, 10.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const [index, minorUnits] of badUnits.entries()) {
      let denied: { ok: boolean };
      try {
        denied = await asOwner.mutation(recordCostEntryRef, {
          organizationId: project.orgId,
          projectId: project.projectId,
          orderId,
          kind: "payment",
          amount: { currency: "EUR", minorUnits: minorUnits as number },
          idempotencyKey: `bad-unit-${index}`,
        });
      } catch {
        continue;
      }
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("costEntries").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("invalid currency is denied with zero entries", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "cost-currency");
    const { orderId } = await setupOrderChain(t, project, "currency");
    const asOwner = t.withIdentity(OWNER);
    for (const [index, bad] of ["eur", "EURO", "", "US"].entries()) {
      const denied = await asOwner.mutation(recordCostEntryRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        orderId,
        kind: "payment",
        amount: { currency: bad, minorUnits: 1000 },
        idempotencyKey: `bad-cur-${index}`,
      });
      expect(denied.ok).toBe(false);
    }
    const rows = await t.run((ctx) => ctx.db.query("costEntries").collect());
    expect(rows.filter((row) => row.projectId === project.projectId)).toHaveLength(0);
  });

  test("a valid positive entry is accepted", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "cost-ok");
    const { orderId } = await setupOrderChain(t, project, "ok");
    const accepted = await t.withIdentity(OWNER).mutation(recordCostEntryRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      orderId,
      kind: "payment",
      amount: { currency: "EUR", minorUnits: 200000 },
      idempotencyKey: "pay-ok-1",
    });
    expect(accepted.ok).toBe(true);
  });
});
