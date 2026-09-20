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

  test("wraps the workbench header before intermediate widths can overflow", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    const responsiveStart = css.indexOf("@media (max-width: 900px)");
    const narrowStart = css.indexOf("@media (max-width: 480px)", responsiveStart);

    expect(responsiveStart).toBeGreaterThanOrEqual(0);
    expect(narrowStart).toBeGreaterThan(responsiveStart);

    const responsiveCss = css.slice(responsiveStart, narrowStart);
    expect(responsiveCss).toContain(".wb-header { min-height: 6.8rem; flex-wrap: wrap;");
    expect(responsiveCss).toContain(".wb-nav { order: 5; width: 100%; height: 2.8rem; overflow-x: auto;");
    expect(responsiveCss).toContain(".wb-nav button { height: 2.8rem; flex: 1 0 auto;");
  });

  test("application CI includes the focused workbench and Jev suites with native runners", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    const workflow = await Bun.file(new URL("../../.github/workflows/application-ci.yml", import.meta.url)).text();

    expect(packageJson).toContain('"test:app": "bun test app/tests/application.test.ts app/tests/workbench.test.ts app/tests/convex-workbench-adapter.test.ts && bunx vitest run convex/models/jev.test.ts --environment edge-runtime"');
    expect(workflow).toContain("- run: bun run test:app");
    expect(workflow).not.toContain("- run: bun run test\n");
  });
});
