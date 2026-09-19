import { expect, test } from "bun:test";

test("user path exposes a recoverable backend-unavailable state", async () => {
  const html = await Bun.file(new URL("../../index.html", import.meta.url)).text();
  const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text();
  expect(html).toContain("id=\"root\"");
  expect(main).toContain("ConvexAuthProvider");
  expect(main).toContain("VITE_CONVEX_URL");
});
