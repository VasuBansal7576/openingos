import { describe, expect, test } from "bun:test";
import { AgentMail, type AgentMailComponent } from "@agentmail/convex";
import {
  JEV_ENDPOINT,
  JEV_PINNED_MODEL,
  type JevFetch,
  type JevQuestion,
} from "../../proofs/jev/jev-boundary.js";
import { hasGitHubOAuthCredentials } from "../../convex/auth";
import { runJevClassification } from "../../convex/models/jev";

const SYNTHETIC_KEY = "f0-controlled-synthetic-key";
const questions: Record<string, JevQuestion> = {
  urgency: {
    type: "noul",
    instructions: "Is this request urgent?",
    criteria: { true: "Time-sensitive", false: "Not time-sensitive" },
  },
};

function successPayload(): Record<string, unknown> {
  return {
    model: JEV_PINNED_MODEL,
    answers: { urgency: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): {
  fetchImpl: JevFetch;
  calls: string[];
  requests: RequestInit[];
} {
  const calls: string[] = [];
  const requests: RequestInit[] = [];
  const fetchImpl: JevFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    requests.push(init ?? {});
    return Promise.resolve(handler(url, init));
  };
  return { fetchImpl, calls, requests };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("controlled test condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

describe("S-01 registered provider components", () => {
  test("config registers the actual official component entry points", async () => {
    const config = await Bun.file(new URL("../../convex/convex.config.ts", import.meta.url)).text();
    expect(config).toContain('"@firecrawl/firecrawl-convex/convex.config"');
    expect(config).toContain('"@agentmail/convex/convex.config"');
    expect(config).toContain('"@convex-dev/workflow/convex.config.js"');
    expect(config).toContain("app.use(firecrawl");
    expect(config).toContain("app.use(agentmail)");
    expect(config).toContain("app.use(workflow)");
  });

  test("installed manifests expose the registered config exports", async () => {
    const firecrawl = JSON.parse(await Bun.file(new URL("../../node_modules/@firecrawl/firecrawl-convex/package.json", import.meta.url)).text()) as { exports?: Record<string, unknown> };
    const agentmail = JSON.parse(await Bun.file(new URL("../../node_modules/@agentmail/convex/package.json", import.meta.url)).text()) as { exports?: Record<string, unknown> };
    const workflow = JSON.parse(await Bun.file(new URL("../../node_modules/@convex-dev/workflow/package.json", import.meta.url)).text()) as { exports?: Record<string, unknown> };
    expect(firecrawl.exports?.["./convex.config"]).toBeDefined();
    expect(agentmail.exports?.["./convex.config"]).toBeDefined();
    expect(workflow.exports?.["./convex.config.js"]).toBeDefined();
  });

  test("Convex Auth registration stays configuration-only without hosted claims", async () => {
    const auth = await Bun.file(new URL("../../convex/auth.ts", import.meta.url)).text();
    const authConfig = await Bun.file(new URL("../../convex/auth.config.ts", import.meta.url)).text();
    expect(auth).toContain('@convex-dev/auth/providers/Anonymous');
    expect(auth).toContain('@auth/core/providers/github');
    expect(auth).toContain("convexAuth");
    expect(authConfig).toContain('applicationID: "convex"');
    expect(authConfig).toContain("CONVEX_SITE_URL");
  });

  test("GitHub OAuth is optional while Anonymous remains available", () => {
    expect(hasGitHubOAuthCredentials(undefined, undefined)).toBe(false);
    expect(hasGitHubOAuthCredentials("client-id", undefined)).toBe(false);
    expect(hasGitHubOAuthCredentials(undefined, "client-secret")).toBe(false);
    expect(hasGitHubOAuthCredentials(" ", "client-secret")).toBe(false);
    expect(hasGitHubOAuthCredentials("client-id", "client-secret")).toBe(true);
  });
});

describe("J-01 fixed Jev transport", () => {
  test("uses the fixed endpoint and pinned model", async () => {
    const stub = stubFetch(() => jsonResponse(successPayload()));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "The delivery date moved.",
      questions,
      inputVersion: "input-1",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.outcome).toBe("decided");
    expect(result.attempts).toBe(1);
    expect(stub.calls).toEqual([JEV_ENDPOINT]);
    const body = JSON.parse(String(stub.requests[0]?.body)) as { model?: string };
    expect(body.model).toBe(JEV_PINNED_MODEL);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_KEY);
  });
});

describe("J-03 bounded retry and cancellation", () => {
  test("does not retry a non-retryable 401", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-2",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });
    expect(result.outcome).toBe("needsReview");
    expect(result.attempts).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  test("retries 429 at most three times and can recover", async () => {
    let count = 0;
    const stub = stubFetch(() => {
      count += 1;
      return count < 3 ? jsonResponse({ error: "busy" }, 429, { "retry-after": "0" }) : jsonResponse(successPayload());
    });
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-3",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });
    expect(result.outcome).toBe("decided");
    expect(result.attempts).toBe(3);
    expect(stub.calls).toHaveLength(3);
  });

  test("stops after the third retryable failure", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "overloaded" }, 529));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-4",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });
    expect(result.outcome).toBe("unavailable");
    expect(result.attempts).toBe(3);
    expect(stub.calls).toHaveLength(3);
  });

  test("pauses for over-policy Retry-After instead of sleeping it", async () => {
    const delays: number[] = [];
    const stub = stubFetch(() => jsonResponse({ error: "overloaded" }, 529, { "retry-after": "120" }));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-4b",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome !== "needsReview") throw new Error("expected manual review");
    expect(result.reason).toContain("retry-after-exceeds-policy");
    expect(result.retry.retryAfterMs).toBe(120_000);
    expect(delays).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  test("never sleeps a huge untrusted Retry-After header", async () => {
    const delays: number[] = [];
    const stub = stubFetch(() => jsonResponse({ error: "overloaded" }, 529, { "retry-after": "2147483647" }));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-4c",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome !== "needsReview") throw new Error("expected manual review");
    expect(result.reason).toContain("manual-review-required");
    expect(result.retry.retryAfterMs).toBe(2_147_483_647_000);
    expect(delays).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  test("pre-cancelled classification makes no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubFetch(() => jsonResponse(successPayload()));
    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-5",
      fetchImpl: stub.fetchImpl,
      signal: controller.signal,
      sleepImpl: async () => undefined,
    });
    expect(result.outcome).toBe("stale");
    expect(stub.calls).toHaveLength(0);
  });

  test("freezes one request snapshot across retry attempts", async () => {
    const state = { message: "before" };
    const mutableQuestions: Record<string, JevQuestion> = {
      urgency: {
        type: "noul",
        instructions: "Is this request urgent?",
        criteria: { true: "Time-sensitive", false: "Not time-sensitive" },
      },
    };
    const bodies: string[] = [];
    let call = 0;
    const stub = stubFetch((_url, init) => {
      bodies.push(String(init?.body));
      call += 1;
      if (call === 1) {
        state.message = "changed during backoff";
        mutableQuestions.urgency = {
          type: "choice",
          instructions: "What changed?",
          criteria: { changed: "Changed", same: "Same" },
        };
        return jsonResponse({ error: "busy" }, 429, { "retry-after": "0" });
      }
      return jsonResponse(successPayload());
    });

    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state,
      questions: mutableQuestions,
      inputVersion: "input-snapshot",
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.outcome).toBe("decided");
    expect(stub.calls).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1] ?? "{}")).toMatchObject({
      state: { message: "before" },
      questions: { urgency: { type: "noul" } },
    });
  });

  test("stops before another request when the input version changes", async () => {
    let currentInputVersion = "input-current";
    const stub = stubFetch(() => {
      currentInputVersion = "input-new";
      return jsonResponse({ error: "busy" }, 429, { "retry-after": "0" });
    });

    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-current",
      currentInputVersion: () => currentInputVersion,
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.outcome).toBe("stale");
    if (result.outcome !== "stale") throw new Error("expected stale result");
    expect(result.reason).toBe("input-version-changed");
    expect(result.attempts).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  test("stops before another request when current authority is revoked", async () => {
    let currentAuthority = true;
    const stub = stubFetch(() => {
      currentAuthority = false;
      return jsonResponse({ error: "busy" }, 429, { "retry-after": "0" });
    });

    const result = await runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-authority",
      isCurrentAuthority: () => currentAuthority,
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.outcome).toBe("stale");
    if (result.outcome !== "stale") throw new Error("expected stale result");
    expect(result.reason).toBe("authority-invalidated");
    expect(result.attempts).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  test("aborts the default backoff timer promptly", async () => {
    const controller = new AbortController();
    const stub = stubFetch(() => jsonResponse({ error: "busy" }, 529));
    const pending = runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-default-backoff",
      signal: controller.signal,
      fetchImpl: stub.fetchImpl,
    });

    await waitFor(() => stub.calls.length === 1);
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not prompt")), 100)),
    ]);

    expect(result.outcome).toBe("stale");
    expect(stub.calls).toHaveLength(1);
  });

  test("aborts a pending Retry-After wait promptly", async () => {
    const controller = new AbortController();
    let releaseSleep: () => void = () => undefined;
    const sleepPending = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const stub = stubFetch(() => jsonResponse({ error: "busy" }, 529, { "retry-after": "30" }));
    const pending = runJevClassification({
      apiKey: SYNTHETIC_KEY,
      state: "state",
      questions,
      inputVersion: "input-retry-after",
      signal: controller.signal,
      fetchImpl: stub.fetchImpl,
      sleepImpl: async () => sleepPending,
    });

    await waitFor(() => stub.calls.length === 1);
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not prompt")), 100)),
    ]);
    releaseSleep();

    expect(result.outcome).toBe("stale");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("S-03 AgentMail signature boundary", () => {
  const secret = "whsec_c2VjcmV0";
  const payload = JSON.stringify({ type: "event", event_type: "message.received", event_id: "evt-1" });
  const invalidHeaders = {
    "svix-id": "msg-1",
    "svix-timestamp": String(Math.floor(Date.now() / 1_000)),
    "svix-signature": "v1,invalid",
  };

  async function signedHeaders(body: string): Promise<Record<string, string>> {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`msg-1.${timestamp}.${body}`),
    );
    return {
      "svix-id": "msg-1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${Buffer.from(signature).toString("base64")}`,
    };
  }

  function testContext(counters: { productCallbacks: number; purchasingUpdates: number }): Parameters<AgentMail["handleWebhook"]>[0] {
    return {
      runMutation: async () => {
        counters.productCallbacks += 1;
        counters.purchasingUpdates += 1;
        return null;
      },
    } as unknown as Parameters<AgentMail["handleWebhook"]>[0];
  }

  const component = {} as unknown as AgentMailComponent;

  test("missing webhook secret rejects before product callback or purchasing update", async () => {
    const counters = { productCallbacks: 0, purchasingUpdates: 0 };
    const agentmail = new AgentMail(component, { webhookSecret: "" });
    let error: unknown;
    try {
      await agentmail.handleWebhook(
        testContext(counters),
        new Request("https://example.test/agentmail/webhook", { method: "POST", body: payload }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("AGENTMAIL_WEBHOOK_SECRET");
    expect(counters).toEqual({ productCallbacks: 0, purchasingUpdates: 0 });
  });

  test("invalid signature rejects before product callback or purchasing update", async () => {
    const counters = { productCallbacks: 0, purchasingUpdates: 0 };
    const agentmail = new AgentMail(component, { webhookSecret: secret });
    const response = await agentmail.handleWebhook(
      testContext(counters),
      new Request("https://example.test/agentmail/webhook", {
        method: "POST",
        headers: invalidHeaders,
        body: payload,
      }),
    );
    expect(response.status).toBe(401);
    expect(counters).toEqual({ productCallbacks: 0, purchasingUpdates: 0 });
  });

  test("tampered body after signing the original rejects before product callback or purchasing update", async () => {
    const counters = { productCallbacks: 0, purchasingUpdates: 0 };
    const headers = await signedHeaders(payload);
    const agentmail = new AgentMail(component, { webhookSecret: secret });
    const response = await agentmail.handleWebhook(
      testContext(counters),
      new Request("https://example.test/agentmail/webhook", {
        method: "POST",
        headers,
        body: `${payload}tampered`,
      }),
    );
    expect(response.status).toBe(401);
    expect(counters).toEqual({ productCallbacks: 0, purchasingUpdates: 0 });
  });
});
