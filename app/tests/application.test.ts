import { describe, expect, test } from "bun:test";

describe("application foundation", () => {
  test("keeps a truthful pending state when no deployment URL is configured", async () => {
    const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
    expect(app).toContain("Backend connection pending");
    expect(app).toContain("VITE_CONVEX_URL");
    expect(app).not.toContain("fixture");
  });

  test("does not create a hosting binding", async () => {
    const vite = await Bun.file(new URL("../../vite.config.ts", import.meta.url)).text();
    expect(vite).toContain("defineConfig");
    expect(vite).not.toContain("host:");
    expect(vite).not.toContain("server:");
  });
});
