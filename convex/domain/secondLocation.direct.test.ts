/// <reference types="vite/client" />
/**
 * P-19 second-location reuse domain tests (controlled contract).
 *
 * Runs the ACTUAL exported domain handlers against the REAL schema with
 * authenticated identities via official convex-test. No provider calls,
 * mail, browser, or external writes occur. Every displayed outcome below
 * comes from real application state.
 *
 * - A multi-requirement template instantiated into a distinct target
 *   project keeps exact template/source/target lineage, copies only the
 *   reusable specification fields, leaves the rows draft/notOrdered, and
 *   derives a truthful revalidation summary: the five current commercial
 *   or operational facts (price, availability or lead time, warranty or
 *   service coverage, installation or site compatibility, supplier terms)
 *   are explicitly revalidation-required and never marked checked.
 * - Identical instantiation replays return the same requirement rows and
 *   the same summary without any write; occupied or changed targets and
 *   malformed/bound-overrun graphs deny whole with zero rows.
 * - Foreign template, foreign project, and cross-organization probes deny
 *   generically with no existence oracle.
 * - Zero rows exist in every historical financial/order/equipment
 *   collection in the target after reuse while the source seed rows
 *   remain; outputs never include a price, savings, supplier reply,
 *   availability claim, or service outcome.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import type { TestConvexForDataModel } from "convex-test";
import type { F1DataModel } from "../server.js";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as requirements from "./requirements.js";
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
const listTemplateReuseRevalidationRef = makeFunctionReference<
  "query",
  QueryArgs<typeof workspace.listTemplateReuseRevalidation>,
  QueryReturn<typeof workspace.listTemplateReuseRevalidation>
>("domain/workspace:listTemplateReuseRevalidation");

const OWNER = { tokenIdentifier: "second-location-owner" };
const OTHER = { tokenIdentifier: "second-location-other" };

/** Test instance bound to the real schema so direct `run` reads stay typed. */
type TestInstance = TestConvexForDataModel<F1DataModel>;

const COPIED_FIELDS = ["key", "title", "category", "quantity", "unit"];
const CURRENT_FACTS = [
  "price",
  "availabilityOrLeadTime",
  "warrantyOrServiceCoverage",
  "installationOrSiteCompatibility",
  "supplierTerms",
];

const REUSE_ITEMS = [
  { key: "hoist", title: "Chain hoist", category: "lifting", quantity: "2.500", unit: "pcs" },
  { key: "beam", title: "Support beam", category: "structure", quantity: "4", unit: "m" },
  { key: "install", title: "Certified installation", category: "service", quantity: "1", unit: "job" },
];

const REUSE_EDGES = [
  { fromKey: "beam", toKey: "hoist", kind: "technical" },
  { fromKey: "hoist", toKey: "install", kind: "scheduling" },
];

type Project = { orgId: Id<"organizations">; projectId: Id<"projects"> };

async function setupProject(
  t: ReturnType<typeof convexTest>,
  name: string,
  identity: { tokenIdentifier: string } = OWNER,
): Promise<Project> {
  const asCaller = t.withIdentity(identity);
  const org = await asCaller.mutation(createOrganizationRef, {
    name: `${name} org`,
    kind: "private",
  });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asCaller.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!proj.ok) throw new Error("project setup failed");
  return { orgId: org.organizationId, projectId: proj.projectId };
}

/** A second-location target is a distinct project inside the same organization. */
async function createTargetProject(
  t: ReturnType<typeof convexTest>,
  source: Project,
  name: string,
): Promise<Project> {
  const proj = await t.withIdentity(OWNER).mutation(createProjectRef, {
    organizationId: source.orgId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!proj.ok) throw new Error("target project setup failed");
  return { orgId: source.orgId, projectId: proj.projectId };
}

async function saveReuseTemplate(
  t: ReturnType<typeof convexTest>,
  source: Project,
  version: string,
  items: readonly { key: string; title: string; category: string; quantity: string; unit: string }[] = REUSE_ITEMS,
  edges: readonly { fromKey: string; toKey: string; kind: string }[] = REUSE_EDGES,
  identity: { tokenIdentifier: string } = OWNER,
) {
  const saved = await t.withIdentity(identity).mutation(saveTemplateRef, {
    organizationId: source.orgId,
    sourceProjectId: source.projectId,
    name: `second location template ${version}`,
    version,
    requirementSnapshot: JSON.stringify(items),
    constraintSnapshot: JSON.stringify(edges),
  });
  if (!saved.ok) throw new Error(`template save failed: ${saved.message}`);
  return saved;
}

async function countProject(
  t: TestInstance,
  table:
    | "requirements"
    | "dependencies"
    | "quotes"
    | "selections"
    | "approvals"
    | "orders"
    | "orderEvents"
    | "costEntries"
    | "assets"
    | "assetDocuments"
    | "serviceCases"
    | "watches"
    | "productEvidence"
    | "evidence"
    | "rfqs",
  projectId: Id<"projects">,
): Promise<number> {
  return t.run(async (ctx) => {
    // Every counted table carries the same `by_project` index; the switch
    // keeps each query on its concrete typed table.
    const count = async (rows: AsyncIterable<unknown>): Promise<number> => {
      let total = 0;
      for await (const row of rows) {
        void row;
        total += 1;
      }
      return total;
    };
    switch (table) {
      case "requirements":
        return count(
          ctx.db.query("requirements").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "dependencies":
        return count(
          ctx.db.query("dependencies").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "quotes":
        return count(
          ctx.db.query("quotes").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "selections":
        return count(
          ctx.db.query("selections").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "approvals":
        return count(
          ctx.db.query("approvals").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "orders":
        return count(
          ctx.db.query("orders").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "orderEvents":
        return count(
          ctx.db.query("orderEvents").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "costEntries":
        return count(
          ctx.db.query("costEntries").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "assets":
        return count(
          ctx.db.query("assets").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "assetDocuments":
        return count(
          ctx.db
            .query("assetDocuments")
            // assetDocuments has no by_project index; a leading-column
            // prefix range on by_project_and_key is the bounded equivalent.
            .withIndex("by_project_and_key", (q) => q.eq("projectId", projectId)),
        );
      case "serviceCases":
        return count(
          ctx.db
            .query("serviceCases")
            .withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "watches":
        return count(
          ctx.db.query("watches").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "productEvidence":
        return count(
          ctx.db
            .query("productEvidence")
            .withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "evidence":
        return count(
          ctx.db.query("evidence").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
      case "rfqs":
        return count(
          ctx.db.query("rfqs").withIndex("by_project", (q) => q.eq("projectId", projectId)),
        );
    }
  });
}

function expectTruthfulSummary(
  reuse: {
    templateId: Id<"templates">;
    templateVersion: string;
    targetProjectId: Id<"projects">;
    copiedSpecificationFields: string[];
    currentFactChecks: {
      fact: string;
      state: string;
      checked: boolean;
      reason: string;
    }[];
  },
  expected: { templateId: Id<"templates">; version: string; targetProjectId: Id<"projects"> },
) {
  expect(reuse.templateId).toBe(expected.templateId);
  expect(reuse.templateVersion).toBe(expected.version);
  expect(reuse.targetProjectId).toBe(expected.targetProjectId);
  expect(reuse.copiedSpecificationFields).toEqual(COPIED_FIELDS);
  expect(reuse.currentFactChecks.map((check) => check.fact)).toEqual(CURRENT_FACTS);
  for (const check of reuse.currentFactChecks) {
    expect(check.state).toBe("revalidationRequired");
    expect(check.checked).toBe(false);
    expect(check.reason).toContain(expected.version);
    expect(check.reason).toContain(expected.targetProjectId);
    expect(check.reason).toContain("requires a fresh check");
  }
}

function expectNoCommercialLeak(serialized: string) {
  expect(serialized).not.toMatch(/minorUnits|"price"\s*:\s*"\s*[€$]|savings|counterpartyRole|supplierReply|serviceOutcome|"executionMode"/);
}

describe("P-19 second-location template reuse", () => {
  test("multi-requirement template instantiates a distinct target with lineage, draft rows and truthful revalidation summary", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "reuse-source");
    const saved = await saveReuseTemplate(t, source, "v1");

    const target = await createTargetProject(t, source, "reuse-target");
    const instantiated = await t.withIdentity(OWNER).mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!instantiated.ok) throw new Error(`instantiate failed: ${instantiated.message}`);

    expect(instantiated.deduplicated).toBe(false);
    expect(instantiated.collections).toEqual(["requirements", "constraints"]);
    expect(instantiated.requirementIds).toHaveLength(3);
    expectTruthfulSummary(instantiated.reuse, {
      templateId: saved.templateId,
      version: "v1",
      targetProjectId: target.projectId,
    });

    const rows = await t.run(async (ctx) => {
      const out = [];
      for (const id of instantiated.requirementIds) {
        out.push(await ctx.db.get(id));
      }
      return out;
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toBeNull();
      expect(row?.organizationId).toBe(source.orgId);
      expect(row?.projectId).toBe(target.projectId);
      expect(row?.state).toBe("draft");
      expect(row?.fulfillment).toBe("notOrdered");
      expect(row?.templateId).toBe(saved.templateId);
      expect(row?.templateVersion).toBe("v1");
    }
    expect(rows.map((row) => row?.key)).toEqual(["hoist", "beam", "install"]);
    expect(rows.map((row) => row?.quantity)).toEqual(["2.5", "4", "1"]);
    expect(rows.map((row) => row?.title)).toEqual(["Chain hoist", "Support beam", "Certified installation"]);
    expect(rows.map((row) => row?.category)).toEqual(["lifting", "structure", "service"]);
    expect(rows.map((row) => row?.unit)).toEqual(["pcs", "m", "job"]);

    const dependencyCount = await countProject(t, "dependencies", target.projectId);
    expect(dependencyCount).toBe(2);
    const edges = await t.run(async (ctx) => {
      const out = [];
      for await (const row of ctx.db
        .query("dependencies")
        .withIndex("by_project", (q) => q.eq("projectId", target.projectId))) {
        out.push(row);
      }
      return out;
    });
    for (const edge of edges) {
      expect(edge.verification).toBe("pending");
      expect(edge.organizationId).toBe(source.orgId);
    }

    // Source template/project lineage is preserved on the durable rows.
    const template = await t.run((ctx) => ctx.db.get(saved.templateId));
    expect(template?.sourceProjectId).toBe(source.projectId);
    expect(template?.organizationId).toBe(source.orgId);

    expectNoCommercialLeak(JSON.stringify(instantiated));
  });

  test("identical instantiation replays with the same rows and the same summary and no writes", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "replay-source");
    const saved = await saveReuseTemplate(t, source, "v1");
    const target = await createTargetProject(t, source, "replay-target");
    const asOwner = t.withIdentity(OWNER);

    const first = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!first.ok) throw new Error(`first instantiate failed: ${first.message}`);

    const queryBefore = await asOwner.query(listTemplateReuseRevalidationRef, {
      organizationId: source.orgId,
      projectId: target.projectId,
      limit: 50,
    });
    if (!queryBefore.ok) throw new Error("query before replay failed");

    const second = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!second.ok) throw new Error(`replay instantiate failed: ${second.message}`);

    expect(second.deduplicated).toBe(true);
    expect(second.requirementIds).toEqual(first.requirementIds);
    expect(second.reuse).toEqual(first.reuse);
    expect(second.collections).toEqual(first.collections);

    expect(await countProject(t, "requirements", target.projectId)).toBe(3);
    expect(await countProject(t, "dependencies", target.projectId)).toBe(2);

    const queryAfter = await asOwner.query(listTemplateReuseRevalidationRef, {
      organizationId: source.orgId,
      projectId: target.projectId,
      limit: 50,
    });
    if (!queryAfter.ok) throw new Error("query after replay failed");
    expect(queryAfter).toEqual(queryBefore);
    expect(queryAfter.requirements).toHaveLength(3);
  });

  test("occupied and changed target projects conflict whole with zero partial rows", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "conflict-source");
    const saved = await saveReuseTemplate(t, source, "v1");
    const target = await createTargetProject(t, source, "conflict-target");
    const asOwner = t.withIdentity(OWNER);

    // Occupied: a same-key requirement already exists in the target from
    // ordinary authoring, so instantiation denies whole.
    const manual = await asOwner.mutation(createRequirementRef, {
      organizationId: source.orgId,
      projectId: target.projectId,
      key: "hoist",
      title: "Manual hoist",
      category: "lifting",
      quantity: "1",
      unit: "pcs",
      priority: "P1",
    });
    if (!manual.ok) throw new Error("manual requirement setup failed");

    const denied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("duplicate-conflict");
    }
    expect(await countProject(t, "requirements", target.projectId)).toBe(1);
    expect(await countProject(t, "dependencies", target.projectId)).toBe(0);

    // Changed: replaying through a different template version over rows
    // instantiated from the first template conflicts instead of mixing
    // lineage. Partial occupancy also denies the whole snapshot.
    const secondSource = await saveReuseTemplate(t, source, "v2", [
      { key: "hoist2", title: "Hoist two", category: "lifting", quantity: "1", unit: "pcs" },
      { key: "beam2", title: "Beam two", category: "structure", quantity: "1", unit: "m" },
    ], []);
    const target2 = await createTargetProject(t, source, "conflict-target-2");
    const seededKey = await asOwner.mutation(createRequirementRef, {
      organizationId: source.orgId,
      projectId: target2.projectId,
      key: "hoist2",
      title: "Hoist two manual",
      category: "lifting",
      quantity: "1",
      unit: "pcs",
      priority: "P1",
    });
    if (!seededKey.ok) throw new Error("seeded key setup failed");
    const deniedPartial = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target2.projectId,
      templateId: secondSource.templateId,
    });
    expect(deniedPartial.ok).toBe(false);
    if (!deniedPartial.ok) {
      expect(deniedPartial.code).toBe("duplicate-conflict");
    }
    expect(await countProject(t, "requirements", target2.projectId)).toBe(1);

    const firstTarget = await createTargetProject(t, source, "conflict-target-3");
    const firstRun = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: firstTarget.projectId,
      templateId: saved.templateId,
    });
    if (!firstRun.ok) throw new Error("first template instantiate failed");
    const changedVersion = await saveReuseTemplate(t, source, "v3", REUSE_ITEMS, REUSE_EDGES);
    const deniedChanged = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: firstTarget.projectId,
      templateId: changedVersion.templateId,
    });
    expect(deniedChanged.ok).toBe(false);
    if (!deniedChanged.ok) {
      expect(deniedChanged.code).toBe("duplicate-conflict");
    }
    expect(await countProject(t, "requirements", firstTarget.projectId)).toBe(3);
    expect(await countProject(t, "dependencies", firstTarget.projectId)).toBe(2);
    const lineage = await t.run((ctx) =>
      ctx.db.get(firstRun.requirementIds[0] as Id<"requirements">),
    );
    expect(lineage?.templateId).toBe(saved.templateId);
    expect(lineage?.templateVersion).toBe("v1");
  });

  test("foreign templates and foreign projects deny generically with no existence oracle", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "tenancy-source");
    const foreignSource = await setupProject(t, "tenancy-foreign", OTHER);
    const foreignTemplate = await saveReuseTemplate(t, foreignSource, "v1", REUSE_ITEMS, REUSE_EDGES, OTHER);
    const target = await createTargetProject(t, source, "tenancy-target");
    const asOwner = t.withIdentity(OWNER);

    // A template owned by another organization denies exactly like a
    // template that does not exist at all.
    const absentTemplateId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("templates", {
        organizationId: foreignSource.orgId,
        sourceProjectId: foreignSource.projectId,
        name: "scratch",
        version: "scratch-absent",
        requirementSnapshot: JSON.stringify(REUSE_ITEMS),
        constraintSnapshot: JSON.stringify([]),
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const foreignDenial = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: foreignTemplate.templateId,
    });
    const absentDenial = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: absentTemplateId,
    });
    expect(foreignDenial.ok).toBe(false);
    expect(absentDenial.ok).toBe(false);
    expect(foreignDenial).toEqual(absentDenial);
    if (!foreignDenial.ok) {
      expect(foreignDenial.code).toBe("denied-project");
      expect(foreignDenial.message).toBe("template is not in this organization");
    }
    expect(await countProject(t, "requirements", target.projectId)).toBe(0);

    // An unauthorized caller probing a real project they cannot access
    // receives exactly the denial of an absent project.
    const absentProjectId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", {
        organizationId: foreignSource.orgId,
        name: "scratch absent",
        visibility: "open",
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const realProbe = await t.withIdentity(OTHER).mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: foreignTemplate.templateId,
    });
    const absentProbe = await t.withIdentity(OTHER).mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: absentProjectId,
      templateId: foreignTemplate.templateId,
    });
    expect(realProbe.ok).toBe(false);
    expect(absentProbe.ok).toBe(false);
    expect(realProbe).toEqual(absentProbe);

    // Cross-organization targets deny for the owning identity too: an
    // org A owner cannot instantiate into an org B project.
    const crossOrg = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: foreignSource.orgId,
      targetProjectId: foreignSource.projectId,
      templateId: foreignTemplate.templateId,
    });
    expect(crossOrg.ok).toBe(false);

    const revalidationProbe = await t.withIdentity(OTHER).query(listTemplateReuseRevalidationRef, {
      organizationId: source.orgId,
      projectId: target.projectId,
      limit: 10,
    });
    expect(revalidationProbe.ok).toBe(false);
  });

  test("bound overrun and malformed graphs deny whole with zero rows", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "bound-source");
    const target = await createTargetProject(t, source, "bound-target");
    const asOwner = t.withIdentity(OWNER);

    const boundItems = Array.from({ length: 51 }, (_, index) => ({
      key: `k${index}`,
      title: `Item ${index}`,
      category: "c",
      quantity: "1",
      unit: "pcs",
    }));
    const overBound = await saveReuseTemplate(t, source, "over", boundItems, []);
    const boundDenied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: overBound.templateId,
    });
    expect(boundDenied.ok).toBe(false);
    if (!boundDenied.ok) {
      expect(boundDenied.code).toBe("invalid-payload");
      expect(boundDenied.message).toBe("template requirement snapshot outside instantiation bound");
    }

    const cycle = await saveReuseTemplate(t, source, "cycle", [
      { key: "a", title: "A", category: "c", quantity: "1", unit: "pcs" },
      { key: "b", title: "B", category: "c", quantity: "1", unit: "pcs" },
      { key: "c", title: "C", category: "c", quantity: "1", unit: "pcs" },
    ], [
      { fromKey: "a", toKey: "b", kind: "technical" },
      { fromKey: "b", toKey: "c", kind: "technical" },
      { fromKey: "c", toKey: "a", kind: "scheduling" },
    ]);
    const cycleDenied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: cycle.templateId,
    });
    expect(cycleDenied.ok).toBe(false);
    if (!cycleDenied.ok) {
      expect(cycleDenied.code).toBe("invalid-payload");
      expect(cycleDenied.message).toBe("dependency would create a cycle");
    }

    const duplicateKeys = await saveReuseTemplate(t, source, "dupes", [
      { key: "same", title: "One", category: "c", quantity: "1", unit: "pcs" },
      { key: "same", title: "Two", category: "c", quantity: "1", unit: "pcs" },
    ], []);
    const duplicateDenied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: duplicateKeys.templateId,
    });
    expect(duplicateDenied.ok).toBe(false);
    if (!duplicateDenied.ok) {
      expect(duplicateDenied.code).toBe("invalid-payload");
    }

    expect(await countProject(t, "requirements", target.projectId)).toBe(0);
    expect(await countProject(t, "dependencies", target.projectId)).toBe(0);
  });

  test("reuse copies zero historical financial, order, equipment and sourcing rows", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "history-source");
    const target = await createTargetProject(t, source, "history-target");
    const asOwner = t.withIdentity(OWNER);

    const sourceRequirement = await asOwner.mutation(createRequirementRef, {
      organizationId: source.orgId,
      projectId: source.projectId,
      key: "source-req",
      title: "Source requirement",
      category: "lifting",
      quantity: "1",
      unit: "pcs",
      priority: "P1",
    });
    if (!sourceRequirement.ok) throw new Error("source requirement setup failed");

    // Seed the source project with one row in every historical
    // financial/order/equipment/sourcing collection so non-copying is
    // proven against real source data rather than an empty table.
    await t.run(async (ctx) => {
      const now = Date.now();
      const vendorId = await ctx.db.insert("vendors", {
        organizationId: source.orgId,
        name: "Seed vendor",
        regions: ["NL"],
        createdAt: now,
      });
      const candidateId = await ctx.db.insert("candidates", {
        organizationId: source.orgId,
        projectId: source.projectId,
        requirementId: sourceRequirement.requirementId,
        vendorId,
        productModel: "Model 1",
        variant: "Variant 1",
        variantKey: `Model 1|Variant 1|${vendorId}`,
        compatibility: "unknown",
        conversationState: "draft",
        createdAt: now,
      });
      const quoteId = await ctx.db.insert("quotes", {
        organizationId: source.orgId,
        projectId: source.projectId,
        version: "seed-1",
        contentHash: "seed-quote-hash",
        currency: "EUR",
        lines: [
          {
            lineId: "l1",
            description: "Seed line",
            quantity: "1",
            unitPrice: { currency: "EUR", minorUnits: 100 },
            evidenceRefs: [],
          },
        ],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "b1", evidenceRefs: [] },
        evidenceRefs: [],
        counterpartyRole: "ownerStandIn",
        executionMode: "fixture",
        createdAt: now,
      });
      const selectionId = await ctx.db.insert("selections", {
        organizationId: source.orgId,
        projectId: source.projectId,
        idempotencyKey: "seed-selection",
        requirementId: sourceRequirement.requirementId,
        candidateId,
        quoteId,
        quoteVersion: "seed-1",
        selectionLines: [{ quoteLineId: "l1", quantity: "1", unit: "pcs" }],
        requirementVersion: 1,
        actor: "seed",
        createdAt: now,
      });
      await ctx.db.insert("approvals", {
        organizationId: source.orgId,
        projectId: source.projectId,
        scope: "seed",
        snapshotCanonical: "{}",
        snapshotHash: "seed-approval-hash",
        state: "approved",
        approver: "seed",
        createdAt: now,
      });
      const orderId = await ctx.db.insert("orders", {
        organizationId: source.orgId,
        projectId: source.projectId,
        selectionId,
        requirementId: sourceRequirement.requirementId,
        quoteId,
        quoteVersion: "seed-1",
        requirementVersion: 1,
        idempotencyKey: "seed-order",
        orderLines: [{ quoteLineId: "l1", quantity: "1", unit: "pcs" }],
        state: "recorded",
        amendmentCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("orderEvents", {
        organizationId: source.orgId,
        projectId: source.projectId,
        orderId,
        kind: "confirmation",
        acceptanceLines: [{ quoteLineId: "l1", acceptedQuantity: "1", unit: "pcs" }],
        recordedBy: "seed",
        idempotencyKey: "seed-order-event",
        createdAt: now,
      });
      await ctx.db.insert("costEntries", {
        organizationId: source.orgId,
        projectId: source.projectId,
        orderId,
        kind: "payment",
        amount: { currency: "EUR", minorUnits: 100 },
        idempotencyKey: "seed-cost-entry",
        recordedBy: "seed",
        createdAt: now,
      });
      const assetId = await ctx.db.insert("assets", {
        organizationId: source.orgId,
        projectId: source.projectId,
        orderId,
        label: "Seed asset",
        idempotencyKey: "seed-asset",
        createdAt: now,
      });
      await ctx.db.insert("assetDocuments", {
        organizationId: source.orgId,
        projectId: source.projectId,
        assetId,
        kind: "manual",
        idempotencyKey: "seed-asset-document",
        createdAt: now,
      });
      await ctx.db.insert("serviceCases", {
        organizationId: source.orgId,
        projectId: source.projectId,
        assetId,
        urgency: "normal",
        summary: "seed case",
        state: "open",
        idempotencyKey: "seed-service-case",
        createdAt: now,
        updatedAt: now,
      });
      const evidenceId = await ctx.db.insert("evidence", {
        organizationId: source.orgId,
        projectId: source.projectId,
        sourceKind: "seed",
        capturedAt: now,
        contentHash: "seed-evidence-hash",
        completeness: "complete",
        counterpartyRole: "ownerStandIn",
        executionMode: "fixture",
      });
      await ctx.db.insert("productEvidence", {
        organizationId: source.orgId,
        projectId: source.projectId,
        requirementId: sourceRequirement.requirementId,
        field: "seed",
        sourceKind: "seed",
        capturedAt: now,
        originalValue: "seed",
        normalizedValue: "seed",
        verification: "unverified",
        freshness: "unknown",
        counterpartyRole: "ownerStandIn",
        executionMode: "fixture",
        origin: "ownerImport",
        conflictEvidenceIds: [],
        idempotencyKey: "seed-product-evidence",
        version: "1",
        createdAt: now,
      });
      await ctx.db.insert("rfqs", {
        organizationId: source.orgId,
        projectId: source.projectId,
        requirementId: sourceRequirement.requirementId,
        idempotencyKey: "seed-rfq",
        scenarioVendorIds: [],
        lineItems: [],
        briefHash: "seed-rfq-hash",
        conversationState: "draft",
        createdAt: now,
      });
      await ctx.db.insert("watches", {
        organizationId: source.orgId,
        projectId: source.projectId,
        targetKind: "candidate",
        targetId: candidateId,
        cadenceMs: 60_000,
        nextCheckAt: now + 60_000,
        state: "active",
        lastResult: "unknown",
        source: "ownerImport",
        counterpartyRole: "ownerStandIn",
        idempotencyKey: "seed-watch",
        createdAt: now,
      });
      void evidenceId;
      void vendorId;
    });

    const saved = await saveReuseTemplate(t, source, "v1");
    const instantiated = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!instantiated.ok) throw new Error(`instantiate failed: ${instantiated.message}`);
    expect(instantiated.requirementIds).toHaveLength(3);
    expect(instantiated.collections).toEqual(["requirements", "constraints"]);

    const historicalTables = [
      "quotes",
      "selections",
      "approvals",
      "orders",
      "orderEvents",
      "costEntries",
      "assets",
      "assetDocuments",
      "serviceCases",
      "watches",
      "productEvidence",
      "evidence",
      "rfqs",
    ] as const;
    for (const table of historicalTables) {
      expect(await countProject(t, table, target.projectId)).toBe(0);
    }

    // The same seed rows remain in the source project: nothing was moved
    // or mirrored, only requirements and constraints were reused.
    expect(await countProject(t, "quotes", source.projectId)).toBe(1);
    expect(await countProject(t, "selections", source.projectId)).toBe(1);
    expect(await countProject(t, "approvals", source.projectId)).toBe(1);
    expect(await countProject(t, "orders", source.projectId)).toBe(1);
    expect(await countProject(t, "orderEvents", source.projectId)).toBe(1);
    expect(await countProject(t, "costEntries", source.projectId)).toBe(1);
    expect(await countProject(t, "assets", source.projectId)).toBe(1);
    expect(await countProject(t, "assetDocuments", source.projectId)).toBe(1);
    expect(await countProject(t, "serviceCases", source.projectId)).toBe(1);
    expect(await countProject(t, "watches", source.projectId)).toBe(1);
    expect(await countProject(t, "productEvidence", source.projectId)).toBe(1);
    expect(await countProject(t, "evidence", source.projectId)).toBe(1);
    expect(await countProject(t, "rfqs", source.projectId)).toBe(1);
  });

  test("bounded revalidation query returns per-requirement summaries with no source-project exposure", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "query-source");
    const saved = await saveReuseTemplate(t, source, "v1");
    const target = await createTargetProject(t, source, "query-target");
    const asOwner = t.withIdentity(OWNER);

    // A non-reused authored requirement must not appear in the reuse view.
    for (const [key, title] of [
      ["authored-a", "Authored A"],
      ["authored-b", "Authored B"],
      ["authored-c", "Authored C"],
    ] as const) {
      const manual = await asOwner.mutation(createRequirementRef, {
        organizationId: source.orgId,
        projectId: target.projectId,
        key,
        title,
        category: "other",
        quantity: "1",
        unit: "pcs",
        priority: "P2",
      });
      if (!manual.ok) throw new Error("authored requirement setup failed");
    }

    const instantiated = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: target.projectId,
      templateId: saved.templateId,
    });
    if (!instantiated.ok) throw new Error(`instantiate failed: ${instantiated.message}`);

    const listing = await asOwner.query(listTemplateReuseRevalidationRef, {
      organizationId: source.orgId,
      projectId: target.projectId,
      limit: 50,
    });
    if (!listing.ok) throw new Error(`revalidation query failed: ${listing.message}`);
    expect(listing.complete).toBe(true);
    expect(listing.requirements).toHaveLength(3);
    expect(new Set(listing.requirements.map((entry) => entry.requirementId))).toEqual(
      new Set(instantiated.requirementIds),
    );
    // Index scan order is not insertion order; compare as a set.
    expect([...listing.requirements].map((entry) => entry.key).sort()).toEqual(
      ["beam", "hoist", "install"],
    );

    const templateRow = await t.run((ctx) => ctx.db.get(saved.templateId));
    for (const entry of listing.requirements) {
      expect(entry.requirementId).toBeDefined();
      expect(entry.templateId).toBe(saved.templateId);
      expect(entry.templateVersion).toBe("v1");
      expect(entry.copiedSpecificationFields).toEqual(COPIED_FIELDS);
      expect(entry.currentFactChecks.map((check) => check.fact)).toEqual(CURRENT_FACTS);
      for (const check of entry.currentFactChecks) {
        expect(check.state).toBe("revalidationRequired");
        expect(check.checked).toBe(false);
        expect(check.reason).toContain("v1");
        expect(check.reason).toContain(target.projectId);
      }
      expect(templateRow?.sourceProjectId).toBe(source.projectId);
    }

    // The query exposes template lineage only: no source-project identity
    // or data appears anywhere in the authorized read.
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("sourceProjectId");
    expect(serialized).not.toContain(source.projectId);
    expectNoCommercialLeak(serialized);

    // Malformed limits fail closed with the agreed denial shape: NaN,
    // Infinity, fractions, zero, negative, and over-max are all denied,
    // never clamped into a valid scan.
    for (const malformedLimit of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2.5,
      0,
      -3,
      201,
    ]) {
      const denied = await asOwner.query(listTemplateReuseRevalidationRef, {
        organizationId: source.orgId,
        projectId: target.projectId,
        limit: malformedLimit,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe("invalid-payload");
        expect(denied.message).toBe(
          "limit must be a positive safe integer within the supported scan bound of 200",
        );
      }
    }

    // Cursor paging reaches reused rows behind manually authored rows and
    // no page is mistaken for the exhaustive set: pages accumulate until
    // `complete`, and their union is exactly the instantiated set.
    let cursor: string | undefined;
    const collected: Id<"requirements">[] = [];
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await asOwner.query(listTemplateReuseRevalidationRef, {
          organizationId: source.orgId,
          projectId: target.projectId,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
      if (!page.ok) throw new Error(`paged revalidation query failed: ${page.message}`);
      collected.push(...page.requirements.map((entry) => entry.requirementId));
      if (page.complete) {
        expect(page.continueCursor).toBeUndefined();
        break;
      }
      expect(page.continueCursor).toBeDefined();
      cursor = page.continueCursor;
    }
    expect(collected).toHaveLength(instantiated.requirementIds.length);
    expect(new Set(collected)).toEqual(new Set(instantiated.requirementIds));
  });
});

describe("P-19 source-project instantiation guard", () => {
  test("instantiating a template into its own source project is denied with zero writes", async () => {
    const t = convexTest(schema, modules);
    const source = await setupProject(t, "self-source");
    const saved = await saveReuseTemplate(t, source, "v1");
    const asOwner = t.withIdentity(OWNER);

    const denied = await asOwner.mutation(instantiateTemplateRef, {
      organizationId: source.orgId,
      targetProjectId: source.projectId,
      templateId: saved.templateId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("invalid-payload");
      expect(denied.message).toBe("template cannot instantiate into its own source project");
    }
    expect(await countProject(t, "requirements", source.projectId)).toBe(0);
    expect(await countProject(t, "dependencies", source.projectId)).toBe(0);
  });
});
