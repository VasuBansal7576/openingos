import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";

describe("public landing fidelity", () => {
  test("unconfigured landing matches the accepted prototype without a backend error page", async () => {
    const html = renderToStaticMarkup(createElement(App, { backendStatus: "unconfigured" }));
    expect(html).toContain("Less chasing.");
    expect(html).toContain("More choosing.");
    expect(html).toContain("Try the Northside");
    expect(html).toContain("Start your own brief");
    expect(html).toContain("Everything");
    expect(html).toContain("on the table.");
    expect(html).toContain("Unbranded two-group espresso machine");
    expect(html).toContain("espresso-machine");
    expect(html).toContain("FOR THE PEOPLE OPENING SOMETHING GOOD");
    expect(html).toContain("AN OPENING, IN GOOD HANDS");
    expect(html).toContain("A clearer way");
    expect(html).toContain("Skip to content");
    expect(html).not.toContain("OpeningOS is ready to connect");
    expect(html).not.toContain("Harbor Equipment");
    expect(html).not.toContain("fixture");
    expect(html).not.toContain("foundation-shell");
  });

  test("unconfigured status stays a compact notice that never implies a live connection", async () => {
    const html = renderToStaticMarkup(createElement(App, { backendStatus: "unconfigured" }));
    expect(html).toContain("BACKEND NOT CONFIGURED");
    expect(html).toContain("No provider calls or customer data are available in this state.");
    expect(html).toContain("wb-landing-status");
    expect(html).not.toContain("BACKEND CONNECTED");
    expect(html).not.toContain("Live provider result");
    expect(html).not.toContain("Open a workspace");
    expect(html).not.toContain("Create workspace");
  });

  test("every non-ready backend state keeps the landing composition with its honest notice", async () => {
    const expectations = {
      "configured-unverified": "BACKEND CONFIGURED / UNVERIFIED",
      authenticating: "AUTHENTICATING",
      unavailable: "BACKEND UNAVAILABLE",
      reconnecting: "CONNECTION INTERRUPTED",
    } as const;
    for (const [status, eyebrow] of Object.entries(expectations)) {
      const html = renderToStaticMarkup(createElement(App, { backendStatus: status as keyof typeof expectations }));
      expect(html).toContain("Less chasing.");
      expect(html).toContain("Try the Northside");
      expect(html).toContain("Start your own brief");
      expect(html).toContain(eyebrow);
      expect(html).not.toContain("OpeningOS is ready to connect");
      expect(html).not.toContain("Harbor Equipment");
      expect(html).not.toContain("Open a workspace");
    }
  });

  test("connected empty state without an intake route stays honest with no mutation offered", async () => {
    const html = renderToStaticMarkup(createElement(App, {
      backendStatus: "connected",
      workbench: { state: "empty", message: "No authorized project projection is available yet." },
    }));
    expect(html).toContain("NO AUTHORIZED PROJECT");
    expect(html).toContain("No authorized project projection is available yet.");
    expect(html).toContain("No vendors, quotes or provider outcomes are shown");
    expect(html).toContain("Less chasing.");
    expect(html).not.toContain("Open a workspace");
    expect(html).not.toContain("Create workspace");
    expect(html).not.toContain("Harbor Equipment");
  });

  test("connected empty state with an intake route embeds the real brief flow", async () => {
    const html = renderToStaticMarkup(createElement(App, {
      backendStatus: "connected",
      workbench: { state: "empty", message: "No authorized project projection is available yet." },
      onIntake: () => Promise.resolve({ ok: true, projectId: "project-1" }),
    }));
    expect(html).toContain("Less chasing.");
    expect(html).toContain("Open a workspace");
    expect(html).toContain("Plan an opening");
    expect(html).toContain("Compare quotes");
    expect(html).toContain("Equipment case");
    expect(html).not.toContain("Harbor Equipment");
  });

  test("connected empty state keeps sample and intake routes distinct", async () => {
    const html = renderToStaticMarkup(createElement(App, {
      backendStatus: "connected",
      workbench: { state: "empty", message: "No authorized project projection is available yet." },
      onIntake: () => Promise.resolve({ ok: true, projectId: "project-1" }),
      onSample: () => Promise.resolve({ ok: true, projectId: "project-sample-1" }),
    }));
    expect(html).toContain("Open a workspace");
    expect(html).toContain("Try the Northside");
    expect(html).not.toContain("Harbor Equipment");
  });

  test("connected sample entry without a sample route stays unavailable without obsolete wording", async () => {
    const html = renderToStaticMarkup(createElement(App, {
      backendStatus: "connected",
      workbench: { state: "empty", message: "No authorized project projection is available yet." },
      onIntake: () => Promise.resolve({ ok: true, projectId: "project-1" }),
    }));
    expect(html).toContain("Less chasing.");
    expect(html).not.toContain("This backend does not provide a sample-project route");
    expect(html).not.toContain("Missing backend contract");
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

  test("landing stacks its hero and workbench preview without fixed overflow widths", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    expect(css).toContain(".wb-landing-hero { position: relative; display: grid;");
    expect(css).toContain("grid-template-columns: 47% 53%;");
    const midStart = css.indexOf("@media (max-width: 800px)");
    expect(midStart).toBeGreaterThanOrEqual(0);
    const midCss = css.slice(midStart);
    expect(midCss).toContain(".wb-landing-hero { grid-template-columns: 1fr;");
    expect(midCss).toContain(".wb-landing-nav nav { display: none;");
    expect(midCss).toContain(".wb-landing-bottom { grid-template-columns: 1fr 1fr;");
    const narrowCss = css.slice(css.indexOf("@media (max-width: 540px)", midStart));
    expect(narrowCss).toContain(".wb-hero-workbench { display: grid; grid-template-columns: .9fr 1.1fr;");
    expect(narrowCss).toContain(".wb-hero-primary { width: 100%; max-width: 21.5625rem;");
    expect(narrowCss).toContain(".wb-landing-bottom { grid-template-columns: 1fr;");
    expect(css).toContain(".wb-hero-copy h1 { margin: 1.75rem 0;");
    expect(css).toContain("overflow-wrap: break-word");
  });

  test("landing keeps visible keyboard focus and reduced-motion handling", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    expect(css).toContain("button:focus-visible");
    expect(css).toContain(".wb-skip-link");
    expect(css).toContain(".wb-skip-link:focus");
    expect(css).toContain(".wb-landing-paper, .wb-yellow-note { transform: none !important;");
  });

  test("small desk text and key actions keep at least 4.5:1 contrast", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    expect(css).toContain(".wb-hero-description,");
    expect(css).toContain("color: #1e3a2c;");
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5].map((at) => {
        const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const ratio = (foreground: string, background: string): number => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    // Small pine ink over the sage desk canvas (F9).
    expect(ratio("#1e3a2c", "#abbda7")).toBeGreaterThanOrEqual(4.5);
    // Landing brief link over the sage desk canvas (F9).
    expect(ratio("#16402c", "#abbda7")).toBeGreaterThanOrEqual(4.5);
    // Warm yellow hero action with dark ink.
    expect(ratio("#23382d", "#ffe576")).toBeGreaterThanOrEqual(4.5);
    // Body ink over cream paper.
    expect(ratio("#18362d", "#f7f2e7")).toBeGreaterThanOrEqual(4.5);
  });

  test("application CI includes the focused workbench, intake, and Jev suites with native runners", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    const workflow = await Bun.file(new URL("../../.github/workflows/application-ci.yml", import.meta.url)).text();

    expect(packageJson).toContain("app/tests/workbench.test.ts");
    expect(packageJson).toContain("app/tests/convex-workbench-adapter.test.ts");
    expect(packageJson).toContain("app/tests/intake.test.ts");
    expect(packageJson).toContain("convex/domain/intake.direct.test.ts");
    expect(packageJson).toContain("bunx vitest run convex/models/jev.test.ts --environment edge-runtime");
    expect(packageJson).toContain('"test": "bun run test:repository && bun run test:proofs && bun run test:evals && bun run test:f1 && bun run test:browser && bun run test:app && bun test convex/communication/contracts.test.ts && bun run test:direct"');
    expect(workflow).toContain("- run: bun run test\n");
  });

  test("production compare keeps bench density with honest states at desktop and narrow widths", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    expect(css).toContain(".wb-compare");
    expect(css).toContain(".wb-bench-heading { display: flex;");
    expect(css).toContain(".wb-desk-layout { display: grid; grid-template-columns: .83fr 1.2fr 1.2fr .85fr;");
    expect(css).toContain(".wb-paper-ready");
    expect(css).toContain(".wb-paper-bottom");
    expect(css).toContain(".wb-comparison-tape");
    expect(css).toContain(".wb-bench-action { display: grid; grid-column: 1 / -1;");
    const narrow = css.slice(css.indexOf("@media (max-width: 540px)"));
    expect(narrow).toContain(".wb-desk-layout { grid-template-columns: minmax(0, 1fr);");
    expect(narrow).toContain(".wb-bench-action { grid-template-columns: minmax(0, 1fr);");
    expect(narrow).toContain("transform: none;");
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(phone).toContain(".wb-bench-heading h1");
    expect(phone).toContain("overflow-wrap: break-word");
  });
});
