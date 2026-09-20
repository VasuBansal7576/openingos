import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexReactClient } from "convex/react";
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
  const previousKeyboardEvent = globalThis.KeyboardEvent;
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
  globalThis.KeyboardEvent = dom.window.KeyboardEvent as unknown as typeof KeyboardEvent;
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

    behavior = "reconnecting";
    const retryWithKeyboard = async () => {
      const retryButton = container.querySelector<HTMLButtonElement>(".retry-button");
      expect(retryButton).not.toBeNull();
      const previousRecordCount = records.length;
      retryButton?.focus();
      await act(async () => {
        retryButton?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as KeyboardEvent);
      });
      await waitForStatus(container, "CONNECTION INTERRUPTED");
      expect(records.length).toBeGreaterThan(previousRecordCount);
      expect(records.filter(({ closeCalls }) => closeCalls === 0)).toHaveLength(1);
    };
    const retryWithClick = async () => {
      const retryButton = container.querySelector<HTMLButtonElement>(".retry-button");
      expect(retryButton).not.toBeNull();
      const previousRecordCount = records.length;
      await act(async () => {
        retryButton?.click();
      });
      await waitForStatus(container, "CONNECTION INTERRUPTED");
      expect(records.length).toBeGreaterThan(previousRecordCount);
      expect(records.filter(({ closeCalls }) => closeCalls === 0)).toHaveLength(1);
    };
    await retryWithKeyboard();
    await retryWithKeyboard();
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
    globalThis.KeyboardEvent = previousKeyboardEvent;
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
