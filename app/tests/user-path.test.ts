import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexReactClient, type Watch } from "convex/react";
import App from "../App";
import { statusFromConnection, type BackendStatus } from "../backend-state";
import { mountRootApplication, RootApplication } from "../main";

function renderPath(backendStatus: BackendStatus): string {
  return renderToStaticMarkup(createElement(App, { backendStatus }));
}

test("renders the unconfigured user path without runtime errors", () => {
  const html = renderToStaticMarkup(createElement(RootApplication, { configuredUrl: "" }));
  expect(html).toContain("BACKEND NOT CONFIGURED");
  expect(html).toContain("No provider calls or customer data are available in this state.");
  expect(html).not.toContain("ready for the next workflow package");
});

test("renders the configured foundation path as unverified before a connection", () => {
  const html = renderToStaticMarkup(createElement(RootApplication, { configuredUrl: "https://unreachable.convex.cloud" }));
  expect(html).toContain("BACKEND CONFIGURED / UNVERIFIED");
  expect(html).toContain("Application readiness is not claimed.");
});

test("renders configured-but-unverified state without claiming readiness", () => {
  const html = renderPath("configured-unverified");
  expect(html).toContain("BACKEND CONFIGURED / UNVERIFIED");
  expect(html).toContain("Application readiness is not claimed.");
  expect(html).not.toContain("BACKEND CONNECTED");
});

type SocketBehavior = "unavailable" | "reconnecting";

const controlledSockets: ControlledSocket[] = [];

class ControlledSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  bufferedAmount = 0;
  binaryType = "blob";
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = ControlledSocket.CONNECTING;

  private readonly openTimer: ReturnType<typeof setTimeout>;
  private readonly closeTimer: ReturnType<typeof setTimeout>;
  private closeCallCount = 0;

  constructor(url: string | URL, private readonly behavior: SocketBehavior) {
    super();
    this.url = String(url);
    controlledSockets.push(this);
    this.openTimer = setTimeout(() => {
      if (this.readyState !== ControlledSocket.CONNECTING) return;
      if (this.behavior === "reconnecting") {
        this.readyState = ControlledSocket.OPEN;
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.(event);
      }
    }, 5);
    this.closeTimer = setTimeout(() => this.close(), 25);
  }

  get closeCount() {
    return this.closeCallCount;
  }

  send(_body: unknown): void {}

  close(): void {
    this.closeCallCount += 1;
    if (this.readyState === ControlledSocket.CLOSED) return;
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.readyState = ControlledSocket.CLOSED;
    const event = new Event("close");
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

interface ClientRecord {
  client: ConvexReactClient;
  closeCalls: number;
}

function statusText(container: globalThis.Element): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

async function waitForStatus(container: Element, expected: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!statusText(container).includes(expected) && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(statusText(container)).toContain(expected);
}

test("drives mounted RootApplication recovery and disposes every replaced client", async () => {
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousWebSocket = globalThis.WebSocket;
  const previousFetch = globalThis.fetch;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const blockedRequests: string[] = [];
  const records: ClientRecord[] = [];
  let behavior: SocketBehavior = "unavailable";
  let unmounted = false;

  const clientFactory = (url: string): ConvexReactClient => {
    const client = new ConvexReactClient(url, { logger: false });
    const record: ClientRecord = { client, closeCalls: 0 };
    const close = client.close.bind(client);
    client.close = async () => {
      record.closeCalls += 1;
      await close();
    };
    records.push(record);
    return client;
  };

  class SocketForTest extends ControlledSocket {
    constructor(url: string | URL) {
      super(url, behavior);
    }
  }

  const browserGlobals = globalThis as unknown as {
    window: unknown;
    document: unknown;
    navigator: unknown;
  };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.WebSocket = SocketForTest as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    blockedRequests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    throw new Error("controlled external HTTP blocked");
  }) as unknown as typeof fetch;
  Object.defineProperty(dom.window, "WebSocket", { configurable: true, value: SocketForTest });

  const happyContainer = dom.document.createElement("div");
  dom.document.body.append(happyContainer);
  const container = happyContainer as unknown as globalThis.Element;
  let root: ReturnType<typeof mountRootApplication> | null = null;
  const mountedRoot = (): ReturnType<typeof mountRootApplication> => {
    if (root === null) throw new Error("RootApplication did not mount");
    return root;
  };

  try {
    await act(async () => {
      root = mountRootApplication(container, {
        clientFactory,
        configuredUrl: "https://controlled.convex.cloud",
      });
    });
    await waitForStatus(container, "BACKEND UNAVAILABLE");
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.filter(({ closeCalls }) => closeCalls === 0)).toHaveLength(1);

    const keydownOnlyButton = container.querySelector<HTMLButtonElement>(".retry-button");
    expect(keydownOnlyButton).not.toBeNull();
    const recordsBeforeKeydown = records.length;
    await act(async () => {
      keydownOnlyButton?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as globalThis.KeyboardEvent,
      );
    });
    expect(records).toHaveLength(recordsBeforeKeydown);
    expect(records.filter(({ closeCalls }) => closeCalls === 0)).toHaveLength(1);

    behavior = "reconnecting";
    const retryWithClick = async () => {
      const retryButton = container.querySelector<HTMLButtonElement>(".retry-button");
      expect(retryButton).not.toBeNull();
      const previousRecords = [...records];
      const replacedClient = previousRecords.find(({ closeCalls }) => closeCalls === 0);
      expect(replacedClient).not.toBeUndefined();
      await act(async () => {
        retryButton?.click();
      });
      await waitForStatus(container, "CONNECTION INTERRUPTED");
      expect(records).toHaveLength(previousRecords.length + 2);
      expect(replacedClient?.closeCalls).toBe(1);
      expect(previousRecords.every(({ closeCalls }) => closeCalls === 1)).toBe(true);
      expect(records.filter(({ closeCalls }) => closeCalls === 0)).toHaveLength(1);
    };
    await retryWithClick();
    await retryWithClick();
    await retryWithClick();
    await retryWithClick();

    await act(async () => {
      mountedRoot().unmount();
    });
    unmounted = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(records.every(({ closeCalls }) => closeCalls > 0)).toBe(true);
    expect(controlledSockets.every((socket) => socket.readyState === ControlledSocket.CLOSED)).toBe(true);
    expect(blockedRequests.every((request) => request.startsWith("https://controlled.convex.cloud"))).toBe(true);
  } finally {
    if (!unmounted && root !== null) mountedRoot().unmount();
    dom.close();
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) {
      delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    } else {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    globalThis.WebSocket = previousWebSocket;
    globalThis.fetch = previousFetch;
  }
});

test("maps live Convex connection signals to honest status states", () => {
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 0, authLoading: true })).toBe("configured-unverified");
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 1, authLoading: true })).toBe("unavailable");
  expect(statusFromConnection({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0, authLoading: true })).toBe("authenticating");
  expect(statusFromConnection({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0, authLoading: false })).toBe("connected");
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: true, connectionRetries: 2, authLoading: false })).toBe("reconnecting");
});

test("automatically wires the default adapter and discovers the first authorized project", async () => {
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const queryArgs: unknown[] = [];
  const eventLog: string[] = [];
  let unmounted = false;

  const projectProjection: Record<string, unknown> = {
    ok: true,
    project: {
      id: "project-1",
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      budgetMinorUnits: null,
      needByAt: null,
      createdAt: 1,
    },
    access: {
      role: "viewer",
      capabilities: {
        canResearch: false,
        canRecordEvidence: false,
        canRecordQuote: false,
        canCompare: true,
        canCommunicate: false,
        canClarify: false,
        canApprove: false,
        canOpenServiceCase: false,
      },
    },
    requirements: [],
    requirementsTruncated: false,
    candidates: [],
    candidatesTruncated: false,
    jobs: [],
    jobsTruncated: false,
    decisions: [],
    decisionsTruncated: false,
    equipment: { assets: [], assetsTruncated: false },
    activity: { page: [], continueCursor: null, isDone: true },
    provenance: { mode: "unknown", label: "No supplier terms", ownerAuthoredTerms: false },
  };
  const projectList: Record<string, unknown> = {
    ok: true,
    projects: [{
      id: "project-1",
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      createdAt: 1,
      access: {
        role: "viewer",
        capabilities: {
          canResearch: false,
          canRecordEvidence: false,
          canRecordQuote: false,
          canCompare: true,
          canCommunicate: false,
          canClarify: false,
          canApprove: false,
          canOpenServiceCase: false,
        },
      },
    }],
    continueCursor: null,
    isDone: true,
  };

  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const createControlledClient = (): ConvexReactClient => {
    const watch = {
      localQueryResult: () => projectProjection,
      onUpdate: (_callback: () => void) => () => {},
    } as unknown as Watch<unknown>;
    return {
      address: "https://controlled.convex.cloud",
      logger: false,
      setAuth: (_fetchToken: unknown, onChange: (authenticated: boolean) => void) => onChange(false),
      clearAuth: () => {},
      connectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0 }),
      subscribeToConnectionState: (_callback: unknown) => () => {},
      action: async (_name: unknown, args: unknown) => {
        const provider = typeof args === "object" && args !== null && "provider" in args
          ? String((args as { provider: unknown }).provider)
          : "unknown";
        eventLog.push(`signIn:${provider}`);
        return { tokens: { token: "controlled-anonymous-token", refreshToken: "controlled-anonymous-refresh" } };
      },
      query: async (_reference: unknown, args: unknown) => {
        queryArgs.push(args);
        if (typeof args === "object" && args !== null && "projectId" in args) {
          eventLog.push("query:projection");
          return projectProjection;
        }
        eventLog.push("query:listAccessibleProjects");
        return projectList;
      },
      watchQuery: (_reference: unknown, _args: unknown) => watch,
      close: async () => {},
    } as unknown as ConvexReactClient;
  };

  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root: ReturnType<typeof mountRootApplication> | null = null;
  const unmountRoot = () => {
    if (root !== null) root.unmount();
  };
  try {
    await act(async () => {
      root = mountRootApplication(container as unknown as globalThis.Element, {
        clientFactory: () => createControlledClient(),
        configuredUrl: "https://controlled.convex.cloud",
      });
    });
    const deadline = Date.now() + 1_500;
    while (!container.textContent?.includes("Northside café") && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("Northside café");
    expect(queryArgs[0]).toEqual({ limit: 1 });
    expect(queryArgs.some((args) => typeof args === "object" && args !== null && "projectId" in args)).toBe(true);
    // E18 finding 2: a fresh visitor must establish the real anonymous
    // Convex Auth session before any discovery query runs.
    expect(eventLog).toContain("signIn:anonymous");
    expect(eventLog.indexOf("signIn:anonymous")).toBeLessThan(eventLog.indexOf("query:listAccessibleProjects"));
    await act(async () => {
      root?.unmount();
    });
    unmounted = true;
  } finally {
    if (!unmounted) unmountRoot();
    dom.close();
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("anonymous sign-in failure stays honest without forged-identity discovery", async () => {
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const queryArgs: unknown[] = [];
  const actionArgs: unknown[] = [];
  let unmounted = false;

  const failingClient = {
    address: "https://controlled.convex.cloud",
    logger: false,
    setAuth: (_fetchToken: unknown, onChange: (authenticated: boolean) => void) => onChange(false),
    clearAuth: () => {},
    connectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0 }),
    subscribeToConnectionState: (_callback: unknown) => () => {},
    action: async (_name: unknown, args: unknown) => {
      actionArgs.push(args);
      throw new Error("controlled anonymous denial");
    },
    query: async (_reference: unknown, args: unknown) => {
      queryArgs.push(args);
      return null;
    },
    watchQuery: () => ({
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
    }) as unknown as Watch<unknown>,
    close: async () => {},
  } as unknown as ConvexReactClient;

  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root: ReturnType<typeof mountRootApplication> | null = null;
  const unmountRoot = () => {
    if (root !== null) root.unmount();
  };
  try {
    await act(async () => {
      root = mountRootApplication(container as unknown as globalThis.Element, {
        clientFactory: () => failingClient,
        configuredUrl: "https://controlled.convex.cloud",
      });
    });
    const deadline = Date.now() + 1_500;
    while (!container.textContent?.includes("PROJECT STATE UNAVAILABLE") && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("PROJECT STATE UNAVAILABLE");
    expect(container.textContent).toContain("Anonymous sign-in failed");
    // Exactly one anonymous sign-in attempt was made through Convex Auth,
    // and the denial is not retried into a loop or disguised as a query.
    expect(actionArgs).toHaveLength(1);
    expect((actionArgs[0] as { provider?: string }).provider).toBe("anonymous");
    // No discovery or projection query ran with a forged identity.
    expect(queryArgs).toHaveLength(0);
    // The honest failure keeps a retry action available.
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Retry project state"),
      ),
    ).toBe(true);
    await act(async () => {
      root?.unmount();
    });
    unmounted = true;
  } finally {
    if (!unmounted) unmountRoot();
    dom.close();
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

async function mountLanding(
  props: Parameters<typeof App>[0],
): Promise<{
  readonly container: Element;
  readonly dom: HappyWindow;
  readonly cleanup: () => Promise<void>;
  readonly clickButton: (label: string) => Promise<void>;
  readonly pressEscape: () => Promise<void>;
}> {
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const happyContainer = dom.document.createElement("div");
  dom.document.body.append(happyContainer);
  const container = happyContainer as unknown as globalThis.Element;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(App, props));
  });
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  return {
    container: container as unknown as Element,
    dom,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      dom.close();
      browserGlobals.window = previousWindow;
      browserGlobals.document = previousDocument;
      browserGlobals.navigator = previousNavigator;
      if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
    clickButton: async (label: string) => {
      await act(async () => {
        findButton(label).click();
      });
    },
    pressEscape: async () => {
      await act(async () => {
        container.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as globalThis.KeyboardEvent,
        );
      });
    },
  };
}

test("unconfigured demo entry stays an unavailable state without obsolete route wording", async () => {
  const mounted = await mountLanding({ backendStatus: "unconfigured" });
  try {
    expect(mounted.container.textContent).toContain("Less chasing.");
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("The sample demo is not available in this build.");
    expect(mounted.container.textContent).toContain("nothing was created");
    expect(mounted.container.textContent).not.toContain("This backend does not provide a sample-project route");
    expect(mounted.container.textContent).not.toContain("Missing backend contract");
    expect(mounted.container.textContent).not.toContain("Harbor Equipment");
    await mounted.pressEscape();
    expect(mounted.container.textContent).not.toContain("The sample demo is not available in this build.");
  } finally {
    await mounted.cleanup();
  }
});

test("unconfigured brief entry explains the backend requirement without creating anything", async () => {
  const mounted = await mountLanding({ backendStatus: "unconfigured" });
  try {
    await mounted.clickButton("Start your own brief");
    expect(mounted.container.textContent).toContain("Connect a backend to open a real workspace.");
    expect(mounted.container.textContent).toContain("No Convex deployment URL is configured");
    expect(mounted.container.textContent).not.toContain("Create workspace");
  } finally {
    await mounted.cleanup();
  }
});

test("connected landing embeds the real intake flow while the demo stays unavailable", async () => {
  const seen: unknown[] = [];
  const mounted = await mountLanding({
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
    onIntake: async (input) => {
      seen.push(input);
      return { ok: true, projectId: "project-landing" };
    },
  });
  try {
    expect(mounted.container.textContent).toContain("Less chasing.");
    expect(mounted.container.textContent).toContain("Open a workspace");
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("The sample demo is not available in this build.");
    expect(seen).toHaveLength(0);
    await mounted.clickButton("Start your own brief instead");
    expect(mounted.container.textContent).toContain("Open a workspace");
  } finally {
    await mounted.cleanup();
  }
});

test("landing keeps keyboard entry points, skip link, and status retry", async () => {
  const mounted = await mountLanding({ backendStatus: "unavailable", onRetry: () => undefined });
  try {
    const buttons = Array.from(mounted.container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
    }
    expect(mounted.container.querySelector(".wb-skip-link")?.textContent).toContain("Skip to content");
    expect(mounted.container.querySelector("main#workbench-main")).not.toBeNull();
    expect(mounted.container.querySelector("nav[aria-label]")).not.toBeNull();
    const retry = Array.from(mounted.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Retry connection"),
    );
    expect(retry).not.toBeUndefined();
    const demo = Array.from(mounted.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Try the Northside"),
    );
    if (demo === undefined) throw new Error("Demo button not found");
    demo.focus();
    expect((mounted.dom.document.activeElement as unknown) === (demo as unknown)).toBe(true);
  } finally {
    await mounted.cleanup();
  }
});

test("connected sample entry starts on the first CTA click with pending and one mutation", async () => {
  const seen: { idempotencyKey: string }[] = [];
  let resolveSample: ((value: { ok: boolean; projectId?: string; message?: string }) => void) | undefined;
  const pendingSample = new Promise<{ ok: boolean; projectId?: string; message?: string }>((resolve) => {
    resolveSample = resolve;
  });
  const mounted = await mountLanding({
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
    onSample: async (input) => {
      seen.push(input);
      return pendingSample;
    },
  });
  try {
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("Open a controlled sample project.");
    expect(mounted.container.textContent).toContain("Creating sample project.");
    const createButton = Array.from(mounted.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Creating sample project"),
    ) as unknown as HTMLButtonElement | undefined;
    expect(createButton?.disabled).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.idempotencyKey.trim().length).toBeGreaterThan(0);
    await mounted.clickButton("Open demo");
    expect(seen).toHaveLength(1);
    expect(mounted.container.textContent).toContain("Open a controlled sample project.");
    await mounted.pressEscape();
    expect(mounted.container.textContent).toContain("Open a controlled sample project.");
    expect(seen).toHaveLength(1);
    resolveSample?.({ ok: true, projectId: "project-sample-1", message: "Sample project created by the server." });
    await act(async () => {
      await pendingSample;
    });
    expect(mounted.container.textContent).toContain("Sample project created. Loading the persisted project.");
    expect(seen).toHaveLength(1);
    const submitButton = Array.from(mounted.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Sample project created"),
    ) as unknown as HTMLButtonElement | undefined;
    expect(submitButton?.disabled).toBe(true);
  } finally {
    await mounted.cleanup();
  }
});

test("connected sample failure shows truthful error and retries with the same key", async () => {
  const keys: string[] = [];
  let calls = 0;
  const mounted = await mountLanding({
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
    onSample: async (input) => {
      calls += 1;
      keys.push(input.idempotencyKey);
      if (calls === 1) return { ok: false, message: "Controlled sample denial." };
      return { ok: true, projectId: "project-sample-retry" };
    },
  });
  try {
    await mounted.clickButton("Try the Northside");
    expect(keys).toHaveLength(1);
    expect(mounted.container.textContent).toContain("Controlled sample denial.");
    const focused = mounted.dom.document.activeElement as unknown as { tagName?: string; textContent?: string | null } | null;
    expect(focused?.tagName).toBe("BUTTON");
    expect(focused?.textContent ?? "").toContain("Retry sample creation");
    await mounted.clickButton("Retry sample creation");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(mounted.container.textContent).toContain("Sample project created. Loading the persisted project.");
  } finally {
    await mounted.cleanup();
  }
});

test("non-connected states never offer the sample mutation", async () => {
  for (const status of ["unconfigured", "configured-unverified", "authenticating", "unavailable", "reconnecting"] as const) {
    const seen: unknown[] = [];
    const mounted = await mountLanding({
      backendStatus: status,
      onSample: async (input) => {
        seen.push(input);
        return { ok: true, projectId: "project-sample-never" };
      },
    });
    try {
      await mounted.clickButton("Try the Northside");
      expect(mounted.container.textContent).toContain("The sample demo is not available in this build.");
      expect(mounted.container.textContent).not.toContain("Create controlled sample project");
      expect(seen).toHaveLength(0);
      await mounted.pressEscape();
    } finally {
      await mounted.cleanup();
    }
  }
});

test("demo and brief entries keep Escape and focus return behavior", async () => {
  const mounted = await mountLanding({
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
    onSample: async () => ({ ok: true, projectId: "project-sample-focus" }),
    onIntake: async () => ({ ok: true, projectId: "project-intake-focus" }),
  });
  try {
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("Open a controlled sample project.");
    const deadline = Date.now() + 1500;
    while (!mounted.container.textContent?.includes("Sample project created. Loading the persisted project.") && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(mounted.container.textContent).toContain("Sample project created. Loading the persisted project.");
    await mounted.pressEscape();
    expect(mounted.container.textContent).not.toContain("Open a controlled sample project.");
    await mounted.clickButton("Start your own brief");
    expect(mounted.container.textContent).toContain("Open a workspace");
  } finally {
    await mounted.cleanup();
  }
});

test("demo and brief entries keep Escape and focus return behavior", async () => {
  const mounted = await mountLanding({
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
    onSample: async () => ({ ok: true, projectId: "project-sample-focus" }),
    onIntake: async () => ({ ok: true, projectId: "project-intake-focus" }),
  });
  try {
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("Open a controlled sample project.");
    const deadline = Date.now() + 1500;
    while (!mounted.container.textContent?.includes("Sample project created. Loading the persisted project.") && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(mounted.container.textContent).toContain("Sample project created. Loading the persisted project.");
    await mounted.pressEscape();
    expect(mounted.container.textContent).not.toContain("Open a controlled sample project.");
    await mounted.clickButton("Start your own brief");
    expect(mounted.container.textContent).toContain("Open a workspace");
  } finally {
    await mounted.cleanup();
  }
});

function confirmedProjectProjection(): Record<string, unknown> {
  return {
    ok: true,
    project: {
      id: "project-1",
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      budgetMinorUnits: null,
      needByAt: null,
      createdAt: 1,
    },
    access: {
      role: "viewer",
      capabilities: {
        canResearch: false,
        canRecordEvidence: false,
        canRecordQuote: false,
        canCompare: true,
        canCommunicate: false,
        canClarify: false,
        canApprove: false,
        canOpenServiceCase: false,
      },
    },
    requirements: [],
    requirementsTruncated: false,
    candidates: [],
    candidatesTruncated: false,
    jobs: [],
    jobsTruncated: false,
    decisions: [],
    decisionsTruncated: false,
    equipment: { assets: [], assetsTruncated: false },
    activity: { page: [], continueCursor: null, isDone: true },
    provenance: { mode: "unknown", label: "No supplier terms", ownerAuthoredTerms: false },
  };
}

function confirmedProjectList(): Record<string, unknown> {
  return {
    ok: true,
    projects: [{
      id: "project-1",
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      createdAt: 1,
      access: {
        role: "viewer",
        capabilities: {
          canResearch: false,
          canRecordEvidence: false,
          canRecordQuote: false,
          canCompare: true,
          canCommunicate: false,
          canClarify: false,
          canApprove: false,
          canOpenServiceCase: false,
        },
      },
    }],
    continueCursor: null,
    isDone: true,
  };
}

async function waitForText(container: Element, text: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!container.textContent?.includes(text) && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(container.textContent).toContain(text);
}

interface MountedHarness {
  readonly container: Element;
  readonly cleanup: () => Promise<void>;
  readonly eventLog: string[];
  readonly queryArgs: unknown[];
  readonly mutationCalls: unknown[];
  readonly releaseSignIn: (result: { tokens: { token: string; refreshToken: string } | null }) => void;
}

async function mountServerConfirmationHarness(options: {
  readonly signInGate: Promise<{ tokens: { token: string; refreshToken: string } | null }>;
  readonly listBehavior: (attempt: number) => unknown;
}): Promise<MountedHarness> {
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

  const eventLog: string[] = [];
  const queryArgs: unknown[] = [];
  const mutationCalls: unknown[] = [];
  let clientAttempts = 0;
  let releaseSignIn: (result: { tokens: { token: string; refreshToken: string } | null }) => void = () => {};
  const signInGate = new Promise<{ tokens: { token: string; refreshToken: string } | null }>((resolve) => {
    releaseSignIn = resolve;
  });
  // The outer gate models a delayed provider round-trip; tests release it to
  // simulate the server confirming the anonymous identity.
  void options.signInGate.then(releaseSignIn);

  const createClient = (): ConvexReactClient => {
    clientAttempts += 1;
    const attempt = clientAttempts;
    const watch = {
      localQueryResult: () => confirmedProjectProjection(),
      onUpdate: (_callback: () => void) => () => {},
    } as unknown as Watch<unknown>;
    return {
      address: "https://controlled.convex.cloud",
      logger: false,
      setAuth: (_fetchToken: unknown, onChange: (authenticated: boolean) => void) => onChange(false),
      clearAuth: () => {},
      connectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0 }),
      subscribeToConnectionState: (_callback: unknown) => () => {},
      action: async (_name: unknown, args: unknown) => {
        const provider = typeof args === "object" && args !== null && "provider" in args
          ? String((args as { provider: unknown }).provider)
          : "unknown";
        eventLog.push(`action:${provider}`);
        if (provider === "anonymous") return signInGate;
        return {};
      },
      query: async (_reference: unknown, args: unknown) => {
        queryArgs.push(args);
        if (typeof args === "object" && args !== null && "projectId" in args) {
          eventLog.push("query:projection");
          return confirmedProjectProjection();
        }
        eventLog.push("query:listAccessibleProjects");
        return options.listBehavior(attempt);
      },
      mutation: async (_reference: unknown, args: unknown) => {
        mutationCalls.push(args);
        return { ok: true, projectId: "project-should-not-exist" };
      },
      watchQuery: (_reference: unknown, _args: unknown) => watch,
      close: async () => {},
    } as unknown as ConvexReactClient;
  };

  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root: ReturnType<typeof mountRootApplication> | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await act(async () => {
      root?.unmount();
    });
    dom.close();
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  };
  try {
    await act(async () => {
      root = mountRootApplication(container as unknown as globalThis.Element, {
        clientFactory: () => createClient(),
        configuredUrl: "https://controlled.convex.cloud",
      });
    });
    return { container: container as unknown as Element, cleanup, eventLog, queryArgs, mutationCalls, releaseSignIn };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function neverResolveSignIn(): Promise<{ tokens: { token: string; refreshToken: string } | null }> {
  return new Promise(() => {});
}

test("delayed server confirmation runs no discovery or mutation before sign-in resolves", async () => {
  const harness = await mountServerConfirmationHarness({
    signInGate: neverResolveSignIn(),
    listBehavior: () => confirmedProjectList(),
  });
  try {
    await waitForText(harness.container, "AUTHENTICATING");
    // The anonymous sign-in was attempted through Convex Auth, but the
    // server has not confirmed the identity yet: no discovery query, no
    // projection query and no mutation may run on the local-only state.
    const signInDeadline = Date.now() + 1_500;
    while (!harness.eventLog.includes("action:anonymous") && Date.now() < signInDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(harness.eventLog).toContain("action:anonymous");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(harness.eventLog).not.toContain("query:listAccessibleProjects");
    expect(harness.eventLog).not.toContain("query:projection");
    expect(harness.queryArgs).toHaveLength(0);
    expect(harness.mutationCalls).toHaveLength(0);
    expect(harness.container.textContent).toContain("AUTHENTICATING");
    // The landing marketing copy names the demo café; the authorized
    // project workbench ("YOUR DECISION DESK") must not render yet.
    expect(harness.container.textContent).not.toContain("YOUR DECISION DESK");
    expect(harness.container.textContent).not.toContain("NO AUTHORIZED PROJECT");

    // The server confirms the identity: discovery runs only after the
    // confirmation and the authorized project proceeds.
    await act(async () => {
      harness.releaseSignIn({ tokens: { token: "controlled-anonymous-token", refreshToken: "controlled-anonymous-refresh" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitForText(harness.container, "YOUR DECISION DESK");
    expect(harness.eventLog.indexOf("action:anonymous")).toBeLessThan(harness.eventLog.indexOf("query:listAccessibleProjects"));
    expect(harness.mutationCalls).toHaveLength(0);
  } finally {
    await harness.cleanup();
  }
});

test("server rejection after token issuance shows a recovery error with no creation flow", async () => {
  const harness = await mountServerConfirmationHarness({
    signInGate: (async () => ({ tokens: { token: "controlled-anonymous-token", refreshToken: "controlled-anonymous-refresh" } }))(),
    listBehavior: () => ({ ok: false, code: "forged-identity", message: "unauthenticated" }),
  });
  try {
    await waitForText(harness.container, "PROJECT STATE UNAVAILABLE");
    expect(harness.container.textContent).toContain("could not be discovered");
    expect(harness.container.textContent).toContain("forged-identity");
    // The denial is recoverable and explicit: a retry action is offered,
    // while the empty-workspace creation flows stay disabled.
    const buttons = Array.from(harness.container.querySelectorAll("button")).map((button) => button.textContent ?? "");
    expect(buttons.some((text) => text.includes("Retry project state"))).toBe(true);
    expect(harness.container.textContent).not.toContain("NO AUTHORIZED PROJECT");
    expect(harness.container.textContent).not.toContain("Open a workspace");
    expect(harness.container.textContent).not.toContain("Create controlled sample project");
    // Only denied discoveries ran (StrictMode may mount the boundary
    // twice, so accept one denial per mounted client): no projection load
    // and no mutation was sent on the rejected identity.
    expect(harness.queryArgs.length).toBeGreaterThanOrEqual(1);
    for (const args of harness.queryArgs) {
      expect(args).not.toMatchObject({ projectId: expect.anything() });
    }
    expect(harness.eventLog).not.toContain("query:projection");
    expect(harness.mutationCalls).toHaveLength(0);

    // The demo entry stays an explicit unavailable state without sending.
    const demoButton = Array.from(harness.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Try the Northside"),
    );
    expect(demoButton).not.toBeUndefined();
    await act(async () => {
      (demoButton as unknown as HTMLButtonElement).click();
    });
    expect(harness.container.textContent).toContain("The sample demo is not available in this build.");
    expect(harness.mutationCalls).toHaveLength(0);
  } finally {
    await harness.cleanup();
  }
});

test("retry after a discovery denial clears the rejected session and recovers", async () => {
  const harness = await mountServerConfirmationHarness({
    signInGate: (async () => ({ tokens: { token: "controlled-anonymous-token", refreshToken: "controlled-anonymous-refresh" } }))(),
    // Deny every discovery on the first mount (StrictMode may mount the
    // boundary twice) and confirm every discovery after the retry remount.
    listBehavior: (attempt) =>
      attempt <= 2
        ? { ok: false, code: "forged-identity", message: "unauthenticated" }
        : confirmedProjectList(),
  });
  try {
    await waitForText(harness.container, "PROJECT STATE UNAVAILABLE");
    const deniedAttempts = harness.queryArgs.length;
    expect(deniedAttempts).toBeGreaterThanOrEqual(1);
    const retryButton = Array.from(harness.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry project state"),
    );
    expect(retryButton).not.toBeUndefined();
    await act(async () => {
      (retryButton as unknown as HTMLButtonElement).click();
    });
    // Retry re-establishes the session and re-runs discovery: the
    // authorized project loads and the denial does not stick.
    await waitForText(harness.container, "YOUR DECISION DESK");
    expect(harness.queryArgs.length).toBeGreaterThan(deniedAttempts);
    expect(harness.mutationCalls).toHaveLength(0);
    expect(harness.container.textContent).not.toContain("PROJECT STATE UNAVAILABLE");
  } finally {
    await harness.cleanup();
  }
});
