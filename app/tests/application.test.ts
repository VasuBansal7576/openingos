import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";

describe("application foundation", () => {
  test("keeps a truthful pending state when no deployment URL is configured", async () => {
    const html = renderToStaticMarkup(createElement(App, { backendStatus: "unconfigured" }));
    expect(html).toContain("BACKEND NOT CONFIGURED");
    expect(html).toContain("No provider calls or customer data are available in this state.");
    expect(html).toContain("Everything on the table.");
    expect(html).toContain("No project connected");
    expect(html).toContain("wb-connection-paper");
    expect(html).not.toContain("foundation-shell");
    expect(html).not.toContain("Harbor Equipment");
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

    const narrowCss = css.slice(narrowStart);
    expect(narrowCss).toContain(".wb-header { display: grid;");
    expect(narrowCss).toContain(".wb-demo-banner .wb-banner-lock { display: none;");
    expect(narrowCss).toContain(".wb-nav button { min-width: 0; flex: 1 1 20%;");
  });

  test("application CI includes the focused workbench and Jev suites with native runners", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    const workflow = await Bun.file(new URL("../../.github/workflows/application-ci.yml", import.meta.url)).text();

    expect(packageJson).toContain('"test:app": "bun test app/tests/application.test.ts app/tests/workbench.test.ts app/tests/convex-workbench-adapter.test.ts && bunx vitest run convex/models/jev.test.ts --environment edge-runtime"');
    expect(packageJson).toContain('"test": "bun run test:repository && bun run test:proofs && bun run test:evals && bun run test:f1 && bun run test:browser && bun run test:app && bun test convex/communication/contracts.test.ts && bun run test:direct"');
    expect(workflow).toContain("- run: bun run test\n");
  });
});
