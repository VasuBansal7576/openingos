/**
 * F1-J controlled tests: local stubbed fetch only, synthetic key only.
 * Never contacts https://api.typesafe.ai and never uses real credentials.
 * Each HTTP test asserts the observable outcome plus the exact request count
 * (one per attempt, zero for pre-dispatch rejections); tests do not mirror
 * implementation internals.
 */
import { describe, expect, test } from "bun:test";
import {
  JEV_ENDPOINT,
  JEV_PINNED_MODEL,
  applyIfCurrent,
  isStaleInput,
  jevAttemptOnce,
  type JevAttemptOptions,
  type JevAttemptResult,
  type JevQuestion,
} from "./jev-boundary.js";

const SYNTHETIC_KEY = "ts-test-synthetic-key-0000";

const QUESTIONS: Record<string, JevQuestion> = {
  is_urgent: {
    type: "noul",
    instructions: "Does this convey urgency?",
    criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
  },
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: { billing: "Payments, invoicing, refunds", technical: "Bugs, outages, integrations", sales: "Pricing, upgrades, new accounts" },
  },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["Calm", "Frustrated", "Very angry"],
  },
};

function validPayload(): Record<string, unknown> {
  return {
    model: JEV_PINNED_MODEL,
    answers: {
      is_urgent: { type: "noul", noul: 0.92 },
      department: {
        type: "choice",
        choice: "technical",
        probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
        confidence: 0.82,
      },
      frustration: {
        type: "score",
        score: 1.6,
        legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
        confidence: 0.78,
      },
    },
    usage: { input_tokens: 312, output_tokens: 48 },
  };
}

/** Copy an unknown object value into a mutable table; null when not an object. */
function asTable(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const table: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    table[key] = entry;
  }
  return table;
}

function answersOrThrow(payload: Record<string, unknown>): Record<string, unknown> {
  const table = asTable(payload["answers"]);
  if (table === null) throw new Error("fixture answers malformed");
  return table;
}

/** Fresh valid payload with one answer replaced (test fixture surgery only). */
function payloadWithAnswer(id: string, answer: unknown): Record<string, unknown> {
  const payload = validPayload();
  const table = answersOrThrow(payload);
  table[id] = answer;
  payload["answers"] = table;
  return payload;
}

/** Fresh valid payload with one answer removed (test fixture surgery only). */
function payloadWithoutAnswer(id: string): Record<string, unknown> {
  const payload = validPayload();
  const table = answersOrThrow(payload);
  delete table[id];
  payload["answers"] = table;
  return payload;
}

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (seen: SeenRequest) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: () => number; seen: () => SeenRequest[] } {
  let count = 0;
  const requests: SeenRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    count += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    return Promise.resolve(handler({ url, init }));
  };
  return { fetchImpl, calls: () => count, seen: () => requests };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function baseOptions(overrides: Partial<JevAttemptOptions> = {}): JevAttemptOptions {
  return {
    apiKey: SYNTHETIC_KEY,
    state: "Help! My payouts have been failing for 3 days.",
    questions: QUESTIONS,
    inputVersion: "v3",
    timeoutMs: 2000,
    ...overrides,
  };
}

describe("J-01 fixed origin, pinned model, one request", () => {
  test("success sends the fixed endpoint with pinned model and makes exactly one request", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("decided");
    const requests = stub.seen();
    expect(requests.length).toBe(1);
    const first = requests[0];
    expect(first?.url).toBe(JEV_ENDPOINT);
    expect(first?.init?.method).toBe("POST");
    expect(first?.init?.redirect).toBe("manual");
    const headers = new Headers(first?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SYNTHETIC_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    const rawBody = first?.init?.body;
    const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");
    const bodyTable = asTable(body);
    expect(bodyTable?.["model"]).toBe(JEV_PINNED_MODEL);
    if (result.outcome === "decided") {
      expect(result.model).toBe(JEV_PINNED_MODEL);
      expect(result.usage).toEqual({ input_tokens: 312, output_tokens: 48 });
      expect(result.inputVersion).toBe("v3");
    } else {
      throw new Error("expected decided");
    }
  });

  test("pre-aborted signal dispatches zero requests and returns stale", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const controller = new AbortController();
    controller.abort();
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, signal: controller.signal });
    expect(result.outcome).toBe("stale");
    expect(stub.calls()).toBe(0);
  });

  test("empty questions never reach the network", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, questions: {} });
    expect(result.outcome).toBe("needsReview");
    expect(stub.calls()).toBe(0);
  });
});

describe("J-02 malformed responses cannot decide", () => {
  async function needsReviewWithOneRequest(payload: unknown): Promise<JevAttemptResult> {
    const stub = stubFetch(() => jsonResponse(payload));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    return result;
  }

  test("missing answer for a question", async () => {
    const result = await needsReviewWithOneRequest(payloadWithoutAnswer("department"));
    if (result.outcome === "needsReview") expect(result.reason).toContain("answers-mismatch");
  });

  test("wrong answer type for a question id", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("is_urgent", {
        type: "choice",
        choice: "technical",
        probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
        confidence: 0.82,
      }),
    );
  });

  test("unknown choice option", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("department", {
        type: "choice",
        choice: "legal",
        probabilities: { billing: 0.05, legal: 0.9, sales: 0.05 },
        confidence: 0.9,
      }),
    );
  });

  test("unnormalized distribution", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("department", {
        type: "choice",
        choice: "technical",
        probabilities: { billing: 0.5, technical: 0.5, sales: 0.5 },
        confidence: 0.4,
      }),
    );
  });

  test("nonfinite noul value", async () => {
    await needsReviewWithOneRequest(payloadWithAnswer("is_urgent", { type: "noul", noul: "high" }));
  });

  test("noul answer carrying confidence is rejected", async () => {
    await needsReviewWithOneRequest(payloadWithAnswer("is_urgent", { type: "noul", noul: 0.92, confidence: 0.9 }));
  });

  test("unexpected model version", async () => {
    const payload = validPayload();
    payload["model"] = "jev-latest";
    await needsReviewWithOneRequest(payload);
  });

  test("choice that is not the maximum probability", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("department", {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
        confidence: 0.82,
      }),
    );
  });

  test("score legend that does not match criteria order", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("frustration", {
        type: "score",
        score: 1.6,
        legend: { "0": "Calm", "1": "Very angry", "2": "Frustrated" },
        probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
        confidence: 0.78,
      }),
    );
  });

  test("score that is not probability-weighted", async () => {
    await needsReviewWithOneRequest(
      payloadWithAnswer("frustration", {
        type: "score",
        score: 0.1,
        legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
        confidence: 0.78,
      }),
    );
  });

  test("negative usage count", async () => {
    const payload = validPayload();
    payload["usage"] = { input_tokens: -1, output_tokens: 48 };
    await needsReviewWithOneRequest(payload);
  });

  test("non-JSON body", async () => {
    const stub = stubFetch(() => new Response("not json", { status: 200 }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("response-not-json");
  });
});

describe("retry classification without hidden retry (partial J-03)", () => {
  test("429 is retryable and performs no second request", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.retry.kind).toBe("retryable");
      expect(result.retry.status).toBe(429);
      expect(result.retry.retryAfterMs).toBe(2000);
    } else {
      throw new Error("expected unavailable");
    }
  });

  test("529 is retryable", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "overloaded" }, 529));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.retry.kind).toBe("retryable");
  });

  test("401 is nonretryable", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "bad key" }, 401));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") {
      expect(result.retry.kind).toBe("nonretryable");
      expect(result.retry.status).toBe(401);
    } else {
      throw new Error("expected needsReview");
    }
  });

  test("422 is nonretryable", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "bad question" }, 422));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.retry.kind).toBe("nonretryable");
  });

  test("timeout is bounded and single-attempt", async () => {
    const stub = stubFetch(() => new Promise<Response>(() => undefined));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 20 });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
  });

  test("redirect is refused, never followed", async () => {
    const stub = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://example.invalid/other" } }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") {
      expect(result.reason).toBe("redirect-refused");
      expect(result.retry.kind).toBe("nonretryable");
    }
  });
});

describe("transport bounds and secrecy", () => {
  test("oversized response is rejected within one request", async () => {
    const big = `{"model":"${JEV_PINNED_MODEL}","padding":"${"x".repeat(300 * 1024)}"}`;
    const stub = stubFetch(() => new Response(big, { status: 200 }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("response-too-large");
  });

  test("error results never embed the raw body or the key", async () => {
    const marker = "MARKER-SECRET-XYZ-123";
    const payload = payloadWithAnswer("department", {
      type: "choice",
      choice: marker,
      probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
      confidence: 0.82,
    });
    const stub = stubFetch(() => jsonResponse(payload));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(result.outcome).toBe("needsReview");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(SYNTHETIC_KEY);
  });
});

describe("body-stream timeout, cancellation, and errors", () => {
  test("stalled body resolves to timeout within one request", async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>(() => undefined), { status: 200 });
    const stub = stubFetch(() => stalled);
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 30 });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toBe("timeout");
      expect(result.retry.kind).toBe("retryable");
    } else {
      throw new Error("expected unavailable");
    }
  });

  test("rejected body stream resolves to a typed error, never throws", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("boom")); } }),
      { status: 200 },
    );
    const stub = stubFetch(() => broken);
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.reason).toBe("body-error");
      expect(result.retry.kind).toBe("retryable");
    } else {
      throw new Error("expected unavailable");
    }
  });

  test("abort after headers cancels the body read and returns stale", async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>(() => undefined), { status: 200 });
    const stub = stubFetch(() => stalled);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 2000, signal: controller.signal });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("stale");
    if (result.outcome === "stale") expect(result.reason).toBe("aborted");
  });
});

describe("stale-input helper is pure and authority-free (partial J-04)", () => {
  test("same version is current, changed version is stale", () => {
    expect(isStaleInput("v3", "v3")).toBe(false);
    expect(isStaleInput("v3", "v4")).toBe(true);
  });

  test("applyIfCurrent keeps current decisions and stales changed ones without network", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(result.outcome).toBe("decided");
    expect(applyIfCurrent(result, "v3").outcome).toBe("decided");
    const staled = applyIfCurrent(result, "v4");
    expect(staled.outcome).toBe("stale");
    expect(stub.calls()).toBe(1);
  });
});
