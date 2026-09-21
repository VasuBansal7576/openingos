/// <reference types="vite/client" />
/**
 * P-01 intake boundary regressions (controlled, PRD 10 / P-01).
 *
 * One atomic, idempotent Convex boundary derives identity from auth,
 * validates bounded normalized inputs, reuses or creates the
 * caller-owned organization, creates a project with current owner
 * authority plus minimal initial records and material history, and
 * returns the exact project id. No research, grants, spend, provider
 * contact, or supplier evidence is involved.
 */

import { makeFunctionReference, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema.js";
import * as intake from "./intake.js";
import * as memberships from "../access/memberships.js";
import * as projection from "../workbench/projection.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "./**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "../workbench/**/*.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!./**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../purchasing/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!../workbench/**/*.test.ts",
]);
const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./") ? `domain/${path.slice(2)}` : path.replace(/^\.\.\//, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;

const createWorkspaceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof intake.createWorkspace>,
  MutationReturn<typeof intake.createWorkspace>
>("domain/intake:createWorkspace");
const myProjectRoleRef = makeFunctionReference<
  "query",
  QueryArgs<typeof memberships.myProjectRole>,
  QueryReturn<typeof memberships.myProjectRole>
>("access/memberships:myProjectRole");
const getProjectionRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.getProjection>,
  QueryReturn<typeof projection.getProjection>
>("workbench/projection:getProjection");
const listProjectsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.listAccessibleProjects>,
  QueryReturn<typeof projection.listAccessibleProjects>
>("workbench/projection:listAccessibleProjects");

const OWNER = { tokenIdentifier: "intake-owner" };
const OTHER = { tokenIdentifier: "intake-other" };

function openingArgs(key: string) {
  return {
    idempotencyKey: key,
    mode: "opening" as const,
    projectName: "Northside café",
    workspaceKind: "private" as const,
    region: "Netherlands",
    currency: "EUR",
  };
}

describe("P-01 intake boundary", () => {
  test("opening creates an owned workspace with minimal records and history", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const result = await asOwner.mutation(createWorkspaceRef, openingArgs("opening-1"));
    if (!result.ok) throw new Error(`intake failed: ${JSON.stringify(result)}`);
    expect(result.deduplicated).toBe(false);

    const role = await asOwner.query(myProjectRoleRef, {
      organizationId: result.organizationId,
      projectId: result.projectId,
    });
    expect(role).toMatchObject({ ok: true, role: "owner" });

    const view = await asOwner.query(getProjectionRef, { projectId: result.projectId, limit: 12 });
    if (!view.ok) throw new Error(`projection failed: ${JSON.stringify(view)}`);
    expect(view.project.name).toBe("Northside café");
    expect(view.project.location?.region).toBe("Netherlands");
    expect(view.requirements).toHaveLength(1);
    expect(view.requirements[0]?.key).toBe("opening-scope");
    expect(view.activity.page.map((entry) => entry.kind)).toContain("intake.created");
    expect(view.activity.page.map((entry) => entry.kind)).toContain("requirement.created");
  });

  test("quote comparison and equipment modes create their minimal records", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const quote = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "quote-1",
      mode: "quoteComparison",
      projectName: "Quote review",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Two-group espresso machine",
      detailCategory: "espresso",
    });
    if (!quote.ok) throw new Error(`quote intake failed: ${JSON.stringify(quote)}`);
    const quoteView = await asOwner.query(getProjectionRef, { projectId: quote.projectId, limit: 12 });
    if (!quoteView.ok) throw new Error(`quote projection failed: ${JSON.stringify(quoteView)}`);
    expect(quoteView.requirements[0]?.key).toBe("quote-comparison");
    expect(quoteView.requirements[0]?.title).toBe("Two-group espresso machine");

    const equipment = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "equipment-1",
      mode: "equipment",
      projectName: "Bar service",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Atlas grinder",
      detailSummary: "Grinder burrs need replacement.",
      urgency: "high",
    });
    if (!equipment.ok) throw new Error(`equipment intake failed: ${JSON.stringify(equipment)}`);
    const equipmentView = await asOwner.query(getProjectionRef, {
      projectId: equipment.projectId,
      limit: 12,
    });
    if (!equipmentView.ok) throw new Error(`equipment projection failed: ${JSON.stringify(equipmentView)}`);
    expect(equipmentView.requirements[0]?.key).toBe("equipment-case");
    expect(equipmentView.equipment.assets).toHaveLength(1);
    expect(equipmentView.equipment.assets[0]?.label).toBe("Atlas grinder");
    expect(equipmentView.equipment.assets[0]?.serviceCases).toHaveLength(1);
  });

  test("exact replay succeeds while a changed reuse of the key conflicts", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(createWorkspaceRef, openingArgs("replay-1"));
    if (!first.ok) throw new Error(`first intake failed: ${JSON.stringify(first)}`);
    const replay = await asOwner.mutation(createWorkspaceRef, openingArgs("replay-1"));
    if (!replay.ok) throw new Error(`replay failed: ${JSON.stringify(replay)}`);
    expect(replay.deduplicated).toBe(true);
    expect(replay.projectId).toBe(first.projectId);
    expect(replay.organizationId).toBe(first.organizationId);

    const conflict = await asOwner.mutation(createWorkspaceRef, {
      ...openingArgs("replay-1"),
      projectName: "Different café",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("changed key reuse must conflict");
    expect(conflict.code).toBe("duplicate-conflict");

    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects.filter((entry) => entry.name === "Different café")).toHaveLength(0);
  });

  test("same-key resubmission creates one workspace and reuses the organization", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(createWorkspaceRef, openingArgs("shared-1"));
    if (!first.ok) throw new Error(`first intake failed: ${JSON.stringify(first)}`);
    const second = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "shared-2",
      mode: "opening",
      projectName: "Second counter",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
    });
    if (!second.ok) throw new Error(`second intake failed: ${JSON.stringify(second)}`);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.projectId).not.toBe(first.projectId);

    const replay = await asOwner.mutation(createWorkspaceRef, openingArgs("shared-1"));
    if (!replay.ok) throw new Error(`replay failed: ${JSON.stringify(replay)}`);
    expect(replay.projectId).toBe(first.projectId);
    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects).toHaveLength(2);
  });

  test("guest and private kinds use separate organizations", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const guest = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "kind-guest",
      mode: "opening",
      projectName: "Guest counter",
      workspaceKind: "guest",
      region: "Netherlands",
      currency: "EUR",
    });
    if (!guest.ok) throw new Error(`guest intake failed: ${JSON.stringify(guest)}`);
    const guestView = await asOwner.query(getProjectionRef, { projectId: guest.projectId, limit: 1 });
    if (!guestView.ok) throw new Error(`guest projection failed: ${JSON.stringify(guestView)}`);
    expect(guestView.project.visibility).toBe("open");

    const secondGuest = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "kind-guest-2",
      mode: "opening",
      projectName: "Guest counter two",
      workspaceKind: "guest",
      region: "Netherlands",
      currency: "EUR",
    });
    if (!secondGuest.ok) throw new Error(`second guest intake failed: ${JSON.stringify(secondGuest)}`);
    expect(secondGuest.organizationId).toBe(guest.organizationId);

    const privateResult = await asOwner.mutation(createWorkspaceRef, openingArgs("kind-private"));
    if (!privateResult.ok) throw new Error(`private intake failed: ${JSON.stringify(privateResult)}`);
    expect(privateResult.organizationId).not.toBe(guest.organizationId);
  });

  test("validation failure writes nothing", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(OWNER);
    const before = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!before.ok) throw new Error(`listing failed: ${JSON.stringify(before)}`);
    const denied = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "invalid-1",
      mode: "opening",
      projectName: "Broken café",
      workspaceKind: "private",
      currency: "EUR",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("opening without a region must fail");
    expect(denied.code).toBe("invalid-payload");
    const after = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!after.ok) throw new Error(`listing failed: ${JSON.stringify(after)}`);
    expect(after.projects).toHaveLength(before.projects.length);

    const equipmentDenied = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "invalid-2",
      mode: "equipment",
      projectName: "Broken service",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Atlas grinder",
    });
    expect(equipmentDenied.ok).toBe(false);
    const afterEquipment = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!afterEquipment.ok) throw new Error(`listing failed: ${JSON.stringify(afterEquipment)}`);
    expect(afterEquipment.projects).toHaveLength(before.projects.length);
  });

  test("unauthenticated and cross-tenant calls deny without an existence oracle", async () => {
    const t = convexTest(schema, modules);
    const anonymous = await t.mutation(createWorkspaceRef, openingArgs("anonymous-1"));
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) throw new Error("anonymous intake must fail");
    expect(anonymous.code).toBe("forged-identity");

    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createWorkspaceRef, openingArgs("tenant-1"));
    if (!created.ok) throw new Error(`intake failed: ${JSON.stringify(created)}`);

    const asOther = t.withIdentity(OTHER);
    const foreignRole = await asOther.query(myProjectRoleRef, {
      organizationId: created.organizationId,
      projectId: created.projectId,
    });
    expect(foreignRole.ok).toBe(false);
    if (foreignRole.ok) throw new Error("cross-tenant role must deny");
    expect(foreignRole.code).toBe("denied-membership");

    const foreignView = await asOther.query(getProjectionRef, { projectId: created.projectId, limit: 1 });
    expect(foreignView.ok).toBe(false);
    if (foreignView.ok) throw new Error("cross-tenant projection must deny");
    expect(foreignView.code).toBe("denied-membership");
  });
});
