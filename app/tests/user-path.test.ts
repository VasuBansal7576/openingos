import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import { statusFromConnection, type BackendStatus } from "../backend-state";
import { RootApplication } from "../main";

function renderPath(backendStatus: BackendStatus): string {
  return renderToStaticMarkup(createElement(App, { backendStatus, onRetry: () => undefined }));
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

test("renders unavailable recovery state with an executable retry control", () => {
  const html = renderPath("unavailable");
  expect(html).toContain("BACKEND UNAVAILABLE");
  expect(html).toContain("No provider action or live outcome is reported");
  expect(html).toContain('class="retry-button"');
  expect(html).toContain("Retry connection");
});

test("maps live Convex connection signals to honest status states", () => {
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 0, authLoading: true })).toBe("configured-unverified");
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 1, authLoading: true })).toBe("unavailable");
  expect(statusFromConnection({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0, authLoading: true })).toBe("authenticating");
  expect(statusFromConnection({ isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0, authLoading: false })).toBe("connected");
  expect(statusFromConnection({ isWebSocketConnected: false, hasEverConnected: true, connectionRetries: 2, authLoading: false })).toBe("reconnecting");
});
