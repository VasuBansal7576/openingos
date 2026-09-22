#!/usr/bin/env node
/**
 * codex-subscription-proxy.mjs — LOCAL DEMO TRANSPORT ONLY. NOT PRODUCT CODE.
 *
 * This script emulates the OpenAI Responses API envelope that
 * convex/models/openai.ts posts to (see prepareOpenAIRequest /
 * parseResponsesPayload) so hackathon demo runs can exercise the real
 * provider-boundary code path without an OpenAI API key. Underneath it does
 * NOT call OpenAI: it wraps the machine owner's personal Codex/ChatGPT
 * subscription by shelling out to `codex exec` and repacking the model's last
 * message into a Responses-shaped payload.
 *
 * Honest scope: this is a local development/demo shim. It is not deployed, is
 * not part of the application backend, and must never be presented as real
 * provider output or realized savings. Token usage fields are UTF-8 byte
 * counts, not provider-metered tokens. It requires the `codex` CLI to be
 * installed and authenticated (`codex login`, ChatGPT subscription).
 *
 * Usage:
 *   CODEX_PROXY_SHARED_SECRET=<secret> [PORT=8787] node scripts/codex-subscription-proxy.mjs
 *
 * Endpoints:
 *   GET  /health         -> 200 {"ok":true} (unauthenticated liveness)
 *   POST /v1/responses   -> OpenAI Responses-shaped envelope; requires
 *                           `Authorization: Bearer <CODEX_PROXY_SHARED_SECRET>`
 *
 * Requests are serialized through an in-process FIFO queue because `codex
 * exec` is a heavyweight CLI spawn. Each call is capped at 300s.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = "127.0.0.1";
const SHARED_SECRET = process.env.CODEX_PROXY_SHARED_SECRET;
const CODEX_TIMEOUT_MS = 300_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const SCHEMA_INSTRUCTION =
  "\n\nRespond with ONLY a JSON object matching this JSON Schema. No prose, no markdown fences.\n";

if (typeof SHARED_SECRET !== "string" || SHARED_SECRET.length === 0) {
  console.error("codex-subscription-proxy: CODEX_PROXY_SHARED_SECRET env var is required");
  process.exit(1);
}
if (!Number.isSafeInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error("codex-subscription-proxy: PORT must be a valid TCP port");
  process.exit(1);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}

function bearerOk(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(SHARED_SECRET, "utf8");
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error("request-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Pull a JSON object out of codex's last message. Tolerates markdown fences
 * and surrounding prose; returns null when nothing parses as a JSON object.
 */
function extractJsonObject(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === "object") return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Run one `codex exec` call inside a fresh temp working directory.
 * Resolves to { kind: "ok", json } | { kind: "timeout" } |
 * { kind: "not-json" } | { kind: "failed", detail }.
 */
function runCodexExec(prompt) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-sub-proxy-"));
    const outFile = path.join(dir, "last-message.txt");
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best-effort
      }
      resolve(result);
    };
    let child;
    try {
      child = spawn(
        "codex",
        ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outFile, prompt],
        { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );
    } catch (error) {
      finish({ kind: "failed", detail: String(error) });
      return;
    }
    let stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CODEX_TIMEOUT_MS);
    child.on("error", (error) => finish({ kind: "failed", detail: String(error) }));
    child.on("close", (code) => {
      if (timedOut) {
        finish({ kind: "timeout" });
        return;
      }
      if (code !== 0) {
        finish({ kind: "failed", detail: `exit ${String(code)}: ${stderrTail.trim().slice(-500)}` });
        return;
      }
      let raw;
      try {
        raw = readFileSync(outFile, "utf8");
      } catch {
        finish({ kind: "not-json" });
        return;
      }
      const json = extractJsonObject(raw);
      finish(json === null ? { kind: "not-json" } : { kind: "ok", json });
    });
  });
}

// In-process FIFO queue: `codex exec` calls run one at a time.
let queueTail = Promise.resolve();
function enqueue(job) {
  const result = queueTail.then(() => job());
  queueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function handleResponses(req, res) {
  let rawBody;
  try {
    rawBody = await readRequestBody(req);
  } catch {
    sendError(res, 413, "request-too-large");
    return;
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    sendError(res, 400, "request-not-json");
    return;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    typeof body.input !== "string" ||
    body.input.length === 0
  ) {
    sendError(res, 400, "invalid-request: input must be a non-empty string");
    return;
  }
  const schema = body.text?.format?.schema;
  if (schema === undefined || schema === null || typeof schema !== "object") {
    sendError(res, 400, "invalid-request: text.format.schema is required");
    return;
  }
  const schemaJson = JSON.stringify(schema);
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "codex-exec";
  const prompt = body.input + SCHEMA_INSTRUCTION + schemaJson;

  const result = await enqueue(() => runCodexExec(prompt));
  if (result.kind === "timeout") {
    sendError(res, 504, "codex-timeout");
    return;
  }
  if (result.kind === "not-json") {
    sendError(res, 502, "codex-output-not-json");
    return;
  }
  if (result.kind === "failed") {
    console.error(`codex-subscription-proxy: codex exec failed — ${result.detail}`);
    sendError(res, 502, "codex-exec-failed");
    return;
  }

  const outputText = JSON.stringify(result.json);
  const inputTokens = Buffer.byteLength(body.input, "utf8") + Buffer.byteLength(schemaJson, "utf8");
  const outputTokens = Buffer.byteLength(outputText, "utf8");
  sendJson(res, 200, {
    id: `resp_${crypto.randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: `msg_${crypto.randomBytes(12).toString("hex")}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    if (!bearerOk(req)) {
      sendError(res, 401, "missing or invalid bearer token");
      return;
    }
    void handleResponses(req, res).catch((error) => {
      console.error("codex-subscription-proxy: handler error", error);
      if (!res.headersSent) sendError(res, 500, "internal-error");
      else res.end();
    });
    return;
  }
  sendError(res, 404, "not-found");
});

server.listen(PORT, HOST, () => {
  console.log(`codex-subscription-proxy listening on http://${HOST}:${PORT} (demo transport, not product code)`);
});
