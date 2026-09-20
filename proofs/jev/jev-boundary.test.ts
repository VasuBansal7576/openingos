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
  type JevFetch,
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

/** Fresh question set per test so mid-flight mutation never leaks across cases. */
function freshQuestions(): Record<string, JevQuestion> {
  return {
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

function stubFetch(handler: (seen: SeenRequest) => Response | Promise<Response>): { fetchImpl: JevFetch; calls: () => number; seen: () => SeenRequest[] } {
  let count = 0;
  const requests: SeenRequest[] = [];
  const fetchImpl: JevFetch = (input, init) => {
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
    const stalled = new Response(new ReadableStream<Uint8Array>(), { status: 200 });
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
    const stalled = new Response(new ReadableStream<Uint8Array>(), { status: 200 });
    const stub = stubFetch(() => stalled);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 2000, signal: controller.signal });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("stale");
    if (result.outcome === "stale") expect(result.reason).toBe("aborted");
  });
});

describe("RJ1 mid-flight mutation cannot smuggle unsent options", () => {
  test("mutated criteria and version after dispatch still reject the unsent option", async () => {
    const qs = freshQuestions();
    let attempted: JevAttemptOptions | null = null;
    const stub = stubFetch(() => {
      const dept = qs["department"];
      if (dept !== undefined && dept.type === "choice") {
        dept.criteria["notSent"] = "Later option";
      }
      if (attempted !== null) attempted.inputVersion = "v2";
      return jsonResponse({
        model: JEV_PINNED_MODEL,
        answers: {
          is_urgent: { type: "noul", noul: 0.9 },
          department: {
            type: "choice",
            choice: "notSent",
            probabilities: { billing: 0.05, technical: 0.05, sales: 0.05, notSent: 0.85 },
            confidence: 0.8,
          },
          frustration: {
            type: "score",
            score: 1.6,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });
    attempted = baseOptions({ questions: qs, inputVersion: "v1", fetchImpl: stub.fetchImpl });
    const result = await jevAttemptOnce(attempted);
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.inputVersion).toBe("v1");
    const first = stub.seen()[0];
    const wire: unknown = JSON.parse(typeof first?.init?.body === "string" ? first.init.body : "{}");
    const wireCriteria = asTable(asTable(asTable(asTable(wire)?.["questions"])?.["department"])?.["criteria"]);
    expect(wireCriteria === null ? [] : Object.keys(wireCriteria).sort()).toEqual(["billing", "sales", "technical"]);
  });
});

describe("RJ2 absolute deadline and cancellation before acceptance", () => {
  test("abort delivered on EOF pull yields stale, not decided", async () => {
    const controller = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify(validPayload()));
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!delivered) {
          delivered = true;
          c.enqueue(bytes);
          return;
        }
        queueMicrotask(() => controller.abort());
        c.close();
      },
    });
    const stub = stubFetch(() => new Response(stream, { status: 200 }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, signal: controller.signal, timeoutMs: 2000 });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("stale");
    if (result.outcome === "stale") expect(result.reason).toBe("aborted");
  });

  test("fetch resolving after the deadline cannot decide", async () => {
    const stub = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse(validPayload())), 20);
        }),
    );
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 5 });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
  });

  test("body completing after the deadline cannot decide", async () => {
    const text = JSON.stringify(validPayload());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        timer = setTimeout(() => {
          timer = null;
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        }, 30);
      },
      cancel() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
    });
    const stub = stubFetch(() => new Response(stream, { status: 200 }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: 5 });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
  });
});

describe("RJ3 timeout and byte configuration is validated before dispatch", () => {
  test("NaN byte bound is rejected with zero requests", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, maxResponseBytes: NaN });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("invalid-max-bytes");
    expect(stub.calls()).toBe(0);
  });

  test("NaN timeout is rejected with zero requests", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: NaN });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("invalid-timeout");
    expect(stub.calls()).toBe(0);
  });

  test("zero byte bound is rejected with zero requests", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, maxResponseBytes: 0 });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("invalid-max-bytes");
    expect(stub.calls()).toBe(0);
  });
});

describe("RJ4 reserved IDs cannot become own question keys", () => {
  test("__proto__ question id is rejected before dispatch", async () => {
    // JSON.parse preserves an own __proto__ data property; literals and
    // assignments would invoke the prototype setter instead.
    const qs: Record<string, JevQuestion> = JSON.parse('{"__proto__":{"type":"noul","instructions":"x"}}');
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, questions: qs });
    expect(result.outcome).toBe("needsReview");
    expect(stub.calls()).toBe(0);
  });

  test("__proto__ choice option is rejected before dispatch", async () => {
    const qs: Record<string, JevQuestion> = JSON.parse(
      '{"pick":{"type":"choice","instructions":"x","criteria":{"__proto__":"evil","ok":"fine"}}}',
    );
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, questions: qs });
    expect(result.outcome).toBe("needsReview");
    expect(stub.calls()).toBe(0);
  });

  test("__proto__ answer key in the response cannot decide", async () => {
    const table = answersOrThrow(validPayload());
    const parts: string[] = ['"__proto__":{"type":"noul","noul":0.5}'];
    for (const key of Object.keys(table)) {
      parts.push(`${JSON.stringify(key)}:${JSON.stringify(table[key])}`);
    }
    const text = `{"model":"${JEV_PINNED_MODEL}","answers":{${parts.join(",")}},"usage":{"input_tokens":1,"output_tokens":1}}`;
    const stub = stubFetch(() => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("needsReview");
  });
});

describe("RJ5 server backoff minimum is never shortened", () => {
  test("Retry-After 120 keeps 120000ms with an exceeds-policy reason and one attempt", async () => {
    const stub = stubFetch(() => jsonResponse({ error: "slow down" }, 429, { "retry-after": "120" }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") {
      expect(result.retry.kind).toBe("retryable");
      expect(result.retry.status).toBe(429);
      expect(result.retry.retryAfterMs).toBe(120000);
      expect(result.reason).toBe("http-429-retry-after-exceeds-policy");
    } else {
      throw new Error("expected unavailable");
    }
  });
});

describe("RJ6 ignored error bodies are cancelled", () => {
  test("never-closing 429 body is cancelled without changing the result", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const stub = stubFetch(() => new Response(stream, { status: 429 }));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.retry.kind).toBe("retryable");
    expect(cancelled).toBe(true);
  });
});

describe("RJ7 non-JSON evidence is rejected before dispatch", () => {
  test("state toJSON returning a number is rejected with zero requests", async () => {
    class ToJsonNumber {
      kind = "evidence";
      toJSON(): number {
        return 123;
      }
    }
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: new ToJsonNumber() });
    expect(result.outcome).toBe("needsReview");
    expect(stub.calls()).toBe(0);
  });

  test("NaN state value is rejected with zero requests", async () => {
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: { price: NaN } });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("throwing toJSON is a typed boundary failure with zero requests", async () => {
    class ToJsonBoom {
      kind = "evidence";
      toJSON(): unknown {
        throw new Error("boom");
      }
    }
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: new ToJsonBoom() });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });
});

describe("RJ7 defensive copy rejects unsupported structures", () => {
  test("inherited toJSON cannot rewrite the sent state", async () => {
    const hooks = {
      toJSON() {
        return { price: 0 };
      },
    };
    const state: Record<string, unknown> = Object.create(hooks);
    state["price"] = 100;
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("sparse array state is rejected", async () => {
    const sparse: unknown[] = new Array(1);
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: sparse });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("cyclic state fails closed without throwing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: cyclic });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("over-deep state is rejected", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i += 1) deep = [deep];
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: deep });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("throwing getter is rejected without invocation or leakage", async () => {
    const marker = "PRIVATE_GETTER_MARKER_456";
    const booby: Record<string, unknown> = {};
    Object.defineProperty(booby, "price", {
      enumerable: true,
      get() {
        throw new Error(marker);
      },
    });
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: { item: booby } });
    expect(result.outcome).toBe("needsReview");
    expect(stub.calls()).toBe(0);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test("non-enumerable toJSON cannot rewrite the sent state", async () => {
    const state: Record<string, unknown> = { price: 100 };
    Object.defineProperty(state, "toJSON", {
      enumerable: false,
      value: () => ({ price: 0 }),
    });
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("decided");
    const first = stub.seen()[0];
    const wire: unknown = JSON.parse(typeof first?.init?.body === "string" ? first.init.body : "{}");
    const wireState = asTable(asTable(wire)?.["state"]);
    expect(wireState?.["price"]).toBe(100);
  });

  test("valid dense snapshots pass through unchanged", async () => {
    const state = { brief: "Compare three offers", tags: ["a", "b"], nested: { n: 1, flag: true, nothing: null } };
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state });
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("decided");
    const first = stub.seen()[0];
    const wire: unknown = JSON.parse(typeof first?.init?.body === "string" ? first.init.body : "{}");
    expect(asTable(wire)?.["state"]).toEqual(state);
  });
});

describe("RJ2 signal swap and spent preparation budget", () => {
  test("swapping options.signal after dispatch still honors the original abort", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify(validPayload()));
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!delivered) {
          delivered = true;
          c.enqueue(bytes);
          return;
        }
        controllerA.abort();
        c.close();
      },
    });
    const stub = stubFetch(() => new Response(stream, { status: 200 }));
    const opts = baseOptions({ fetchImpl: stub.fetchImpl, signal: controllerA.signal, timeoutMs: 2000 });
    const pending = jevAttemptOnce(opts);
    opts.signal = controllerB.signal;
    const result = await pending;
    expect(stub.calls()).toBe(1);
    expect(result.outcome).toBe("stale");
    if (result.outcome === "stale") expect(result.reason).toBe("aborted");
  });

  test("preparation consuming the deadline dispatches zero requests", async () => {
    const realNow = Date.now;
    const target: Record<string, unknown> = { brief: "x".repeat(900_000) };
    const slow = new Proxy(target, {
      ownKeys(t) {
        const end = realNow() + 30;
        while (realNow() < end) {
          // Burn preparation time deterministically: 30ms always exceeds the 5ms budget.
        }
        return Reflect.ownKeys(t);
      },
    });
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: slow, timeoutMs: 5 });
    expect(result.outcome).toBe("unavailable");
    if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
    expect(stub.calls()).toBe(0);
  });
});

describe("array own-data and deadline-equality regressions", () => {
  test("indexed accessor getter never runs and dispatches nothing", async () => {
    const marker = "PRIVATE_INDEX_MARKER_789";
    let invocations = 0;
    const rigged: unknown[] = ["ok"];
    Object.defineProperty(rigged, "0", {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        throw new Error(marker);
      },
    });
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: { items: rigged } });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
    expect(invocations).toBe(0);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test("inherited array element is rejected as a hole", async () => {
    const arr: unknown[] = new Array(1);
    Object.setPrototypeOf(arr, { 0: "evil" });
    const stub = stubFetch(() => jsonResponse(validPayload()));
    const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, state: { items: arr } });
    expect(result.outcome).toBe("needsReview");
    if (result.outcome === "needsReview") expect(result.reason).toBe("non-json-state");
    expect(stub.calls()).toBe(0);
  });

  test("deadline equality is exhausted budget, not a dispatch window", async () => {
    const realNow = Date.now;
    const frozen = 1_000_000;
    const timeout = 50;
    let now = frozen;
    Date.now = () => now;
    try {
      const stub = stubFetch(() => {
        now = frozen + timeout;
        return jsonResponse(validPayload());
      });
      const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: timeout });
      expect(stub.calls()).toBe(1);
      expect(result.outcome).toBe("unavailable");
      if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
    } finally {
      Date.now = realNow;
    }
  });

  test("deadline equality at the pre-dispatch gate dispatches zero requests", async () => {
    const realNow = Date.now;
    const start = 2_000_000;
    const timeout = 40;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? start : start + timeout);
    try {
      const stub = stubFetch(() => jsonResponse(validPayload()));
      const result = await jevAttemptOnce({ ...baseOptions(), fetchImpl: stub.fetchImpl, timeoutMs: timeout });
      expect(stub.calls()).toBe(0);
      expect(result.outcome).toBe("unavailable");
      if (result.outcome === "unavailable") expect(result.reason).toBe("timeout");
    } finally {
      Date.now = realNow;
    }
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
