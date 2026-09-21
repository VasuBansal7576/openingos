import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import App from "../App";
import { WorkbenchIntakeView } from "../Workbench";
import {
  createConvexWorkbenchAdapter,
  type ConvexWorkbenchClient,
} from "../convex-workbench-adapter";
import type { WorkbenchIntakeInput } from "../workbench-state";

function intakeClient(
  calls: { reference: unknown; args: unknown }[],
  result: unknown,
): ConvexWorkbenchClient {
  return {
    query: async () => null,
    watchQuery: () => ({ localQueryResult: () => undefined, onUpdate: () => () => {} }) as never,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return result;
    },
  } as unknown as ConvexWorkbenchClient;
}

describe("P-01 intake adapter contract", () => {
  test("routes the real intake mutation with the normalized payload", async () => {
    const calls: { reference: unknown; args: unknown }[] = [];
    const adapter = createConvexWorkbenchAdapter(
      intakeClient(calls, { ok: true, projectId: "project-intake-1" }),
    );
    const result = await adapter.createIntake({
      idempotencyKey: "key-1",
      mode: "opening",
      projectName: "Northside café",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      needByAt: Date.UTC(2026, 9, 12),
      budgetMinorUnits: 4500000,
    });
    expect(result).toMatchObject({ ok: true, projectId: "project-intake-1" });
    expect(calls).toHaveLength(1);
    expect(getFunctionName(calls[0]?.reference as never)).toBe("domain/intake:createWorkspace");
    expect(calls[0]?.args).toMatchObject({
      idempotencyKey: "key-1",
      mode: "opening",
      projectName: "Northside café",
      region: "Netherlands",
      currency: "EUR",
    });
    adapter.dispose();
  });

  test("rejects empty names locally and guards duplicate submissions", async () => {
    const calls: { reference: unknown; args: unknown }[] = [];
    const releaser: { fn: (() => void) | null } = { fn: null };
    const gate = new Promise<unknown>((resolve) => {
      releaser.fn = () => resolve({ ok: true, projectId: "project-intake-2" });
    });
    const adapter = createConvexWorkbenchAdapter({
      query: async () => null,
      watchQuery: () => ({ localQueryResult: () => undefined, onUpdate: () => () => {} }) as never,
      mutation: async (reference: unknown, args: unknown) => {
        calls.push({ reference, args });
        return gate;
      },
    } as unknown as ConvexWorkbenchClient);
    const empty = await adapter.createIntake({
      idempotencyKey: "key-empty",
      mode: "opening",
      projectName: "   ",
      workspaceKind: "private",
      region: "Netherlands",
    });
    expect(empty.ok).toBe(false);
    expect(calls).toHaveLength(0);

    const input: WorkbenchIntakeInput = {
      idempotencyKey: "key-flight",
      mode: "equipment",
      projectName: "Bar service",
      workspaceKind: "private",
      detailTitle: "Atlas grinder",
      detailSummary: "Burrs need replacement.",
      urgency: "high",
    };
    const first = adapter.createIntake(input);
    const duplicate = await adapter.createIntake(input);
    expect(duplicate.ok).toBe(false);
    releaser.fn?.();
    const settled = await first;
    expect(settled.ok).toBe(true);
    expect(calls).toHaveLength(1);
    adapter.dispose();
  });

  test("surfaces a malformed server result without a project id", async () => {
    const calls: { reference: unknown; args: unknown }[] = [];
    const adapter = createConvexWorkbenchAdapter(intakeClient(calls, { ok: true }));
    const result = await adapter.createIntake({
      idempotencyKey: "key-bad",
      mode: "quoteComparison",
      projectName: "Quote review",
      workspaceKind: "private",
      detailTitle: "Two-group machine",
    });
    expect(result.ok).toBe(false);
    adapter.dispose();
  });
});

describe("P-01 connected intake view", () => {
  test("unconfigured and disconnected states never offer the mutation", () => {
    for (const status of ["unconfigured", "configured-unverified", "authenticating", "unavailable", "reconnecting"] as const) {
      const html = renderToStaticMarkup(createElement(App, { backendStatus: status }));
      expect(html).not.toContain("Open a workspace");
      expect(html).not.toContain("Create workspace");
    }
  });

  test("connected empty state offers the real intake form", () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        backendStatus: "connected",
        workbench: { state: "empty", message: "No authorized project projection is available yet." },
        onIntake: () => Promise.resolve({ ok: true, projectId: "project-1" }),
      }),
    );
    expect(html).toContain("Open a workspace");
    expect(html).toContain("Plan an opening");
    expect(html).toContain("Compare quotes");
    expect(html).toContain("Equipment case");
    expect(html).not.toContain("Harbor Equipment");
  });

  test("connected empty state without an adapter route stays a dead end", () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        backendStatus: "connected",
        workbench: { state: "empty", message: "No authorized project projection is available yet." },
      }),
    );
    expect(html).not.toContain("Open a workspace");
    expect(html).toContain("No authorized project projection is available yet.");
  });
});

interface MountedIntake {
  readonly container: Element;
  readonly dom: HappyWindow;
  readonly restore: () => Promise<void>;
  readonly field: (label: string) => HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  readonly submit: () => Promise<void>;
}

async function mountIntake(
  onIntake: (input: WorkbenchIntakeInput) => Promise<{ ok: boolean; projectId?: string; message?: string }>,
): Promise<MountedIntake> {
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
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as globalThis.Element);
  const restore = async () => {
    await act(async () => {
      root.unmount();
    });
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  };
  try {
    await act(async () => {
      root.render(createElement(WorkbenchIntakeView, { onIntake }));
    });
    const field = (label: string) => {
      const labels = Array.from(container.querySelectorAll("label"));
      const match = labels.find((candidate) => candidate.textContent === label);
      if (!match) throw new Error(`Label not found: ${label}`);
      const control = match.htmlFor.length > 0
        ? container.querySelector(`#${match.htmlFor}`)
        : match.querySelector("input,textarea,select");
      if (!(control instanceof dom.window.HTMLInputElement) && !(control instanceof dom.window.HTMLTextAreaElement) && !(control instanceof dom.window.HTMLSelectElement)) {
        throw new Error(`Control not found for label: ${label}`);
      }
      return control as unknown as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    };
    const submit = async () => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Create workspace"),
      );
      if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error("Submit button not found");
      const submitButton = button as unknown as HTMLButtonElement;
      await act(async () => {
        submitButton.click();
      });
    };
    return { container: container as unknown as Element, dom, restore, field, submit };
  } catch (error) {
    await restore();
    throw error;
  }
}

function setValue(
  _dom: HappyWindow,
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  // Intake fields are uncontrolled: assigning the DOM value directly is the
  // exact user-visible state the submit reads through FormData.
  control.value = value;
}

describe("P-01 intake user path", () => {
  test("opening mode requires only its minimum facts and submits once", async () => {
    const seen: WorkbenchIntakeInput[] = [];
    const mounted = await mountIntake(async (input) => {
      seen.push(input);
      return { ok: true, projectId: "project-opening" };
    });
    try {
      setValue(mounted.dom, mounted.field("Project name"), "Northside café");
      await mounted.submit();
      expect(mounted.container.textContent).toContain("Add the city or region");
      expect(seen).toHaveLength(0);

      setValue(mounted.dom, mounted.field("City or region"), "Amsterdam, Netherlands");
      await mounted.submit();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        mode: "opening",
        projectName: "Northside café",
        region: "Amsterdam, Netherlands",
      });
      expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
    } finally {
      await mounted.restore();
    }
  });

  test("quote comparison and equipment modes expose their own minimum fields", async () => {
    const seen: WorkbenchIntakeInput[] = [];
    const mounted = await mountIntake(async (input) => {
      seen.push(input);
      return { ok: true, projectId: "project-case" };
    });
    try {
      const radios = Array.from(mounted.container.querySelectorAll('input[type="radio"]'));
      const quoteRadio = radios.find((radio) => (radio as HTMLInputElement).value === "quoteComparison");
      if (!(quoteRadio instanceof mounted.dom.window.HTMLInputElement)) throw new Error("quote mode radio missing");
      const quoteRadioButton = quoteRadio as unknown as HTMLInputElement;
      await act(async () => {
        quoteRadioButton.click();
      });
      expect(mounted.container.textContent).toContain("Requirement subject");
      setValue(mounted.dom, mounted.field("Project name"), "Quote review");
      setValue(mounted.dom, mounted.field("Requirement subject"), "Two-group machine");
      await mounted.submit();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ mode: "quoteComparison", detailTitle: "Two-group machine" });

      const equipmentRadio = Array.from(mounted.container.querySelectorAll('input[type="radio"]')).find(
        (radio) => (radio as HTMLInputElement).value === "equipment",
      );
      if (!(equipmentRadio instanceof mounted.dom.window.HTMLInputElement)) throw new Error("equipment mode radio missing");
      const equipmentRadioButton = equipmentRadio as unknown as HTMLInputElement;
      await act(async () => {
        equipmentRadioButton.click();
      });
      expect(mounted.container.textContent).toContain("Equipment label");
      expect(mounted.container.textContent).toContain("What needs attention?");
    } finally {
      await mounted.restore();
    }
  });

  test("recoverable failure preserves entered values and disables duplicate submit", async () => {
    let calls = 0;
    const keys: (string | undefined)[] = [];
    const releaser: { fn: (() => void) | null } = { fn: null };
    const gate = new Promise<{ ok: boolean; message?: string }>((resolve) => {
      releaser.fn = () => resolve({ ok: false, message: "Controlled intake failure." });
    });
    const mounted = await mountIntake(async (input) => {
      calls += 1;
      keys.push(input.idempotencyKey);
      if (calls === 1) return gate;
      return { ok: true, projectId: "project-retry" };
    });
    try {
      setValue(mounted.dom, mounted.field("Project name"), "Northside café");
      setValue(mounted.dom, mounted.field("City or region"), "Amsterdam");
      const button = Array.from(mounted.container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Create workspace"),
      );
      if (!(button instanceof mounted.dom.window.HTMLButtonElement)) throw new Error("Submit button not found");
      const submitButton = button as unknown as HTMLButtonElement;
      let first: Promise<void> | null = null;
      await act(async () => {
        first = (async () => {
          submitButton.click();
          submitButton.click();
        })();
        await Promise.resolve();
      });
      expect(submitButton.disabled).toBe(true);
      expect(mounted.container.textContent).toContain("Creating workspace");
      releaser.fn?.();
      await act(async () => {
        await first;
      });
      expect(calls).toBe(1);
      expect(mounted.container.textContent).toContain("Controlled intake failure.");
      expect((mounted.field("Project name") as HTMLInputElement).value).toBe("Northside café");
      expect((mounted.field("City or region") as HTMLInputElement).value).toBe("Amsterdam");

      await mounted.submit();
      // The unchanged retry reuses the same idempotency key, so the server
      // replays the original submission instead of creating a second
      // workspace.
      expect(calls).toBe(2);
      expect(keys[0]).toBe(keys[1]);
      expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
    } finally {
      await mounted.restore();
    }
  });

  test("keyboard submission through the form reaches the intake route", async () => {
    const seen: WorkbenchIntakeInput[] = [];
    const mounted = await mountIntake(async (input) => {
      seen.push(input);
      return { ok: true, projectId: "project-keyboard" };
    });
    try {
      setValue(mounted.dom, mounted.field("Project name"), "Keyboard café");
      setValue(mounted.dom, mounted.field("City or region"), "Utrecht");
      const form = mounted.container.querySelector("form");
      if (!(form instanceof mounted.dom.window.HTMLFormElement)) throw new Error("Intake form not found");
      const intakeForm = form as unknown as HTMLFormElement;
      await act(async () => {
        if (typeof intakeForm.requestSubmit === "function") intakeForm.requestSubmit();
        else intakeForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.projectName).toBe("Keyboard café");
    } finally {
      await mounted.restore();
    }
  });
});
