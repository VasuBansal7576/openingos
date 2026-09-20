/**
 * F1 exported-handler audit (controlled, repair gate).
 *
 * Independently inspects every owned Convex handler module — not only
 * files named in review findings — and enforces the production boundaries:
 * no caller-controlled time, no unsafe assertions, typed `v.id` table
 * references, indexed reads, internal executor transitions, an explicit
 * public-surface allowlist, and a function-free fixtures module.
 */

import { describe, expect, test } from "bun:test";

const HANDLERS = [
  "access/capabilities.ts",
  "access/checks.ts",
  "access/grants.ts",
  "access/memberships.ts",
  "access/recipients.ts",
  "execution/attempts.ts",
  "execution/communication.ts",
  "execution/dispatch.ts",
  "execution/jobs.ts",
  "execution/operations.ts",
  "execution/reconciliation.ts",
  "execution/reservations.ts",
  "purchasing/contracts/evidence.ts",
  "purchasing/contracts/fixtures.ts",
  "purchasing/contracts/quotes.ts",
] as const;

const FUNCTION_MODULES = HANDLERS.filter((file) => file !== "access/checks.ts");

async function readOwned(relative: string): Promise<string> {
  return await Bun.file(new URL(`../${relative}`, import.meta.url)).text();
}

type Visibility = "query" | "mutation" | "action" | "internalMutation" | "internalQuery";

const BUILDER_KIND: Record<string, Visibility> = {
  f1Query: "query",
  f1Mutation: "mutation",
  f1Action: "action",
  f1InternalMutation: "internalMutation",
  f1InternalQuery: "internalQuery",
};

function exportedFunctions(source: string): { name: string; visibility: Visibility }[] {
  const found: { name: string; visibility: Visibility }[] = [];
  const pattern = /export const (\w+) = (f1Query|f1Mutation|f1Action|f1InternalMutation|f1InternalQuery)\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    const builder = match[2];
    if (name === undefined || builder === undefined) continue;
    const visibility = BUILDER_KIND[builder];
    if (visibility === undefined) continue;
    found.push({ name, visibility });
  }
  return found;
}

const ALLOWLIST: Record<string, Record<string, Visibility>> = {
  "access/capabilities.ts": { catalog: "query", describe: "query" },
  "access/memberships.ts": {
    myProjectRole: "query",
    createOrganization: "mutation",
    createProject: "mutation",
    grantProjectAccess: "mutation",
    revokeProjectAccess: "mutation",
  },
  "access/grants.ts": { get: "query", issue: "mutation", revoke: "mutation" },
  "access/recipients.ts": { describe: "query", configure: "mutation" },
  "execution/jobs.ts": { get: "query", start: "mutation", cancel: "mutation" },
  "execution/operations.ts": { get: "query", create: "mutation", claim: "internalMutation" },
  "execution/reservations.ts": { ledger: "query", reserve: "mutation" },
  "execution/attempts.ts": {
    attemptsForOperation: "query",
    recordOutcome: "internalMutation",
    reconcileAfterCrash: "internalMutation",
    reviewedResend: "internalMutation",
  },
  "execution/reconciliation.ts": {
    ingestEvent: "internalMutation",
    recordLateDelivery: "internalMutation",
  },
  "execution/communication.ts": { recordControlledSend: "internalMutation" },
  "execution/dispatch.ts": { dispatchCommunication: "action", requestResend: "action" },
  "purchasing/contracts/evidence.ts": {
    list: "query",
    record: "mutation",
    recordFile: "mutation",
    ingestProviderEvidence: "internalMutation",
    ingestProviderFile: "internalMutation",
  },
  "purchasing/contracts/quotes.ts": {
    compare: "query",
    record: "mutation",
    ingestProviderQuote: "internalMutation",
  },
  "purchasing/contracts/fixtures.ts": {},
};

describe("exported-handler audit", () => {
  test("public surface matches the allowlist exactly (no hidden endpoints)", async () => {
    for (const file of FUNCTION_MODULES) {
      const source = await readOwned(file);
      const actual: Record<string, Visibility> = {};
      for (const entry of exportedFunctions(source)) actual[entry.name] = entry.visibility;
      expect({ file, actual }).toEqual({ file, actual: ALLOWLIST[file] ?? {} });
    }
  });

  test("no caller-controlled production time (server Date.now only)", async () => {
    for (const file of FUNCTION_MODULES) {
      const source = await readOwned(file);
      expect({ file, hasNowArg: /now:\s*v\./.test(source) }).toEqual({ file, hasNowArg: false });
      expect({ file, usesArgsNow: /args\.now/.test(source) }).toEqual({ file, usesArgsNow: false });
    }
  });

  test("executor transitions are internal; browsers cannot invoke them", async () => {
    const internalOnly: Record<string, string[]> = {
      "execution/operations.ts": ["claim"],
      "execution/attempts.ts": ["recordOutcome", "reconcileAfterCrash", "reviewedResend"],
      "execution/reconciliation.ts": ["ingestEvent", "recordLateDelivery"],
      "execution/communication.ts": ["recordControlledSend"],
    };
    for (const [file, names] of Object.entries(internalOnly)) {
      const source = await readOwned(file);
      for (const name of names) {
        expect(source).toContain(`export const ${name} = f1InternalMutation(`);
      }
      expect(new RegExp(`export const (${names.join("|")}) = f1Mutation\\(`).test(source)).toBe(false);
    }
  });

  test("no unsafe assertions in production handlers", async () => {
    for (const file of [...HANDLERS, "server.ts", "internalRefs.ts", "f1api.ts"]) {
      const source = await readOwned(file);
      expect({ file, asNever: source.includes("as never") }).toEqual({ file, asNever: false });
      expect({ file, asUnknown: source.includes("as unknown") }).toEqual({ file, asUnknown: false });
    }
  });

  test("ID arguments use typed v.id table references", async () => {
    const expectedTables: Record<string, string[]> = {
      "access/memberships.ts": ['v.id("organizations")', 'v.id("projects")', 'v.id("memberships")'],
      "access/grants.ts": ['v.id("organizations")', 'v.id("projects")', 'v.id("grants")'],
      "execution/jobs.ts": ['v.id("organizations")', 'v.id("projects")', 'v.id("jobs")'],
      "execution/operations.ts": ['v.id("operations")', 'v.id("jobs")', 'v.id("grants")'],
      "execution/reservations.ts": ['v.id("jobs")', 'v.id("organizations")'],
      "execution/dispatch.ts": ['v.id("operations")'],
      "purchasing/contracts/evidence.ts": ['v.id("organizations")', 'v.id("projects")', 'v.id("evidence")'],
      "purchasing/contracts/quotes.ts": ['v.id("quotes")'],
    };
    for (const [file, tables] of Object.entries(expectedTables)) {
      const source = await readOwned(file);
      for (const table of tables) {
        expect({ file, table, present: source.includes(table) }).toEqual({ file, table, present: true });
      }
    }
  });

  test("indexed reads declared in schema (no full collect/filter scans)", async () => {
    for (const file of FUNCTION_MODULES) {
      const source = await readOwned(file);
      expect({ file, filterScan: source.includes(".filter((q)") }).toEqual({ file, filterScan: false });
    }
    const indexed = [
      "access/checks.ts",
      "execution/operations.ts",
      "execution/attempts.ts",
      "execution/reservations.ts",
      "purchasing/contracts/evidence.ts",
    ];
    for (const file of indexed) {
      const source = await readOwned(file);
      expect(source).toContain(".withIndex(");
    }
  });

  test("fixtures module exports no Convex functions", async () => {
    const source = await readOwned("purchasing/contracts/fixtures.ts");
    expect(exportedFunctions(source)).toEqual([]);
    expect(source).toContain("FIXTURE_MODULE_HAS_NO_CONVEX_FUNCTIONS");
    expect(source.includes("f1Mutation(")).toBe(false);
    expect(source.includes("f1Action(")).toBe(false);
  });

  test("server time drives production writes", async () => {
    const timed = [
      "access/memberships.ts",
      "access/grants.ts",
      "access/recipients.ts",
      "execution/jobs.ts",
      "execution/operations.ts",
      "execution/reservations.ts",
      "execution/attempts.ts",
      "execution/reconciliation.ts",
      "execution/communication.ts",
      "purchasing/contracts/evidence.ts",
      "purchasing/contracts/quotes.ts",
    ];
    for (const file of timed) {
      const source = await readOwned(file);
      expect({ file, serverClock: source.includes("Date.now()") }).toEqual({ file, serverClock: true });
    }
  });

  test("only the owned typing helpers touch the stale generated api proxy", async () => {
    for (const file of FUNCTION_MODULES) {
      const source = await readOwned(file);
      expect(source.includes("_generated/api")).toBe(false);
    }
    for (const helper of ["server.ts", "internalRefs.ts", "f1api.ts"]) {
      const source = await readOwned(helper);
      expect(source.includes("hand-written")).toBe(true);
    }
  });
});
