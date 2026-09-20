import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";

describe("application foundation", () => {
  test("keeps a truthful pending state when no deployment URL is configured", async () => {
    const html = renderToStaticMarkup(createElement(App, { backendStatus: "unconfigured" }));
    expect(html).toContain("BACKEND NOT CONFIGURED");
    expect(html).toContain("No provider calls or customer data are available in this state.");
    expect(html).not.toContain("fixture");
  });

  test("does not create a hosting binding", async () => {
    const vite = await Bun.file(new URL("../../vite.config.ts", import.meta.url)).text();
    expect(vite).toContain("defineConfig");
    expect(vite).not.toContain("host:");
    expect(vite).not.toContain("server:");
  });
});
