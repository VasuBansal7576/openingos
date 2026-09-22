import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkbenchView from "../Workbench";
import { parseWorkbenchSnapshot, type WorkbenchActionResult } from "../workbench-state";

/**
 * Focused Recovery-copy test (Astra finding 4): a mounted Recovery tab for
 * a partial job whose only attempt is observedSuccess must describe the
 * observed partial/incomplete evidence without inventing a missing branch,
 * transport, retry, or schedule.
 */
const partialProjection = {
  ok: true,
  project: {
    id: "project-recovery-1",
    organizationId: "organization-recovery-1",
    name: "Northside café",
    visibility: "open",
    location: {
      id: "location-recovery-1",
      name: "Northside",
      region: "Netherlands",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    },
    currency: "EUR",
    budgetMinorUnits: 900000,
    needByAt: Date.UTC(2026, 9, 12),
    createdAt: Date.UTC(2026, 8, 1),
  },
  access: {
    role: "approver",
    capabilities: {
      canResearch: true,
      canRecordEvidence: true,
      canRecordQuote: true,
      canCompare: true,
      canCommunicate: true,
      canClarify: true,
      canApprove: true,
      canOpenServiceCase: true,
    },
  },
  requirements: [{
    id: "requirement-recovery-1",
    key: "ESP-01",
    title: "Two-group espresso machine",
    category: "equipment",
    quantity: "1",
    unit: "unit",
    priority: "P0",
    state: "readyForDecision",
    fulfillment: "notOrdered",
    version: 3,
    budgetMinorUnits: 900000,
    currency: "EUR",
    needByAt: Date.UTC(2026, 9, 12),
  }],
  candidates: [{
    id: "candidate-recovery-1",
    requirementId: "requirement-recovery-1",
    productModel: "Atlas 2G",
    variant: "new · two-group",
    compatibility: "pass",
    conversationState: "quoteReceived",
    vendor: { id: "vendor-recovery-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
    latestValidQuote: null,
    evidence: [{
      id: "product-evidence-recovery-1",
      field: "installation",
      sourceKind: "owner mailbox exchange",
      capturedAt: Date.UTC(2026, 8, 20),
      completeness: "complete",
      verification: "verified",
      freshness: "fresh",
      lastCheckedAt: Date.UTC(2026, 8, 20),
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
    }],
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
  }],
  jobs: [
    { id: "job-partial", kind: "recovery", state: "partial", status: "partial", cancellable: true, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
  ],
  decisions: [],
  activity: { page: [{ id: "event-recovery-1", kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }], continueCursor: null, isDone: true },
  equipment: { assets: [], assetsTruncated: false },
  requirementsTruncated: false,
  candidatesTruncated: false,
  jobsTruncated: false,
  decisionsTruncated: false,
  provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
};

async function mountRecoveryTab(loadState: Parameters<typeof WorkbenchView>[0]["loadState"]): Promise<{
  readonly container: HTMLElement;
  readonly clickTab: (label: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}> {
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const happyElement = dom.document.createElement("div");
  dom.document.body.append(happyElement);
  const container = happyElement as unknown as HTMLElement;
  const root = createRoot(container as unknown as globalThis.Element);
  const onAction = (): WorkbenchActionResult => ({ ok: false, message: "controlled test refusal" });
  await act(async () => {
    root.render(createElement(WorkbenchView, { loadState, onAction }));
  });
  return {
    container,
    clickTab: async (label: string) => {
      await act(async () => {
        const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.includes(label),
        );
        if (button === undefined) throw new Error(`Button not found: ${label}`);
        (button as unknown as HTMLButtonElement).click();
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      browserGlobals.window = previousWindow;
      browserGlobals.document = previousDocument;
      browserGlobals.navigator = previousNavigator;
      if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

test("recovery renders observed partial evidence with no invented branch, transport, or retry", async () => {
  const snapshot = parseWorkbenchSnapshot(partialProjection, partialProjection.project.id);
  if (snapshot === null) throw new Error("Partial projection should parse");
  const partial = snapshot.jobs.find((job) => job.state === "partial");
  if (partial === undefined) throw new Error("Partial job should parse");
  expect(partial.attempts).toBe(1);
  const mounted = await mountRecoveryTab({ state: "ready", snapshot });
  try {
    await mounted.clickTab("Recovery");
    const text = mounted.container.textContent ?? "";
    // Observed partial evidence is described honestly.
    expect(text).toContain("Partial provider outcome");
    expect(text).toContain("recorded evidence is retained");
    expect(text).toContain("no recorded outcome in this projection");
    expect(text).toContain("Retained in this projection: 1 of 1 visible results carry recorded evidence.");
    expect(text).toContain("none is scheduled here");
    // No invented missing branch, transport, retry, or re-drive.
    expect(text).not.toContain("remaining branch");
    expect(text).not.toContain("did not report");
    expect(text).not.toContain("Retry bounded branch");
    expect(text).not.toContain("re-drives");
    expect(text).not.toContain("re-drive");
    expect(text).not.toContain("in flight");
  } finally {
    await mounted.cleanup();
  }
});
