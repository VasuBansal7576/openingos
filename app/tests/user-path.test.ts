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
      query: async (_reference: unknown, args: unknown) => {
        queryArgs.push(args);
        if (typeof args === "object" && args !== null && "projectId" in args) return projectProjection;
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

test("unconfigured demo entry stays an unavailable state naming the missing backend contract", async () => {
  const mounted = await mountLanding({ backendStatus: "unconfigured" });
  try {
    expect(mounted.container.textContent).toContain("Less chasing.");
    await mounted.clickButton("Try the Northside");
    expect(mounted.container.textContent).toContain("The sample demo is not available in this build.");
    expect(mounted.container.textContent).toContain("Missing backend contract");
    expect(mounted.container.textContent).toContain("domain/intake:createWorkspace");
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
