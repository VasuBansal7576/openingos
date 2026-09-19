# F1-J controlled Jev proof

Bounded proof only under proposed ADR-0005 / ADR-0004 and sponsor plan
J-01 through J-04. No live calls, no real credentials, no Convex schema, no
claim of application access or of integrated J-03/J-04 completion.

## Files

- `jev-boundary.ts` — fixed-origin, pinned-model, single-attempt fetch
  boundary with `unknown` response validation for `noul`, `choice`, `score`.
- `jev-boundary.test.ts` — Bun tests using only local stubbed fetch
  responses and the synthetic key `ts-test-synthetic-key-0000`.

## Request snapshot and freshness

- Timeout and byte configuration (finite positive timeout, safe-integer
  byte bound) is validated before any dispatch; NaN/zero bounds are
  rejected with zero requests and the tested hard bounds are unchanged.
- A normalized immutable JSON snapshot of the exact sent bytes is built
  before dispatch. Only plain JSON data (Object/null prototypes for
  objects, exactly Array.prototype with own data entries per index for
  arrays) is defensively copied; inherited or non-enumerable serialization
  hooks are never consulted, accessors are rejected without invocation, and
  cycles, sparse arrays, or over-deep graphs fail closed with a generic
  typed no-dispatch failure. Non-JSON evidence is rejected before dispatch,
  and the response validates only against the sent snapshot with the
  snapshotted input version echoed, so mid-flight caller mutation cannot
  smuggle an unsent option or version past validation.
- One absolute deadline is enforced after every await, immediately before
  dispatch (preparation counts against it), and before acceptance, covering
  headers and body alike; exhaustion is inclusive, so arriving exactly at
  the deadline dispatches nothing further, and header waits use only the
  remaining budget.
- One absolute deadline is enforced after every await, immediately before
  dispatch (preparation counts against it), and before acceptance, covering
  headers and body alike; header waits use only the remaining budget.
  The snapshotted abort signal drives registration, cleanup, body reads,
  and final checks, so swapping `options.signal` mid-flight cannot escape
  the original cancellation.
- One absolute deadline is enforced after every await and before
  acceptance, covering headers and body alike; aborts during or after the
  body report `stale`.
- `__proto__`/`constructor`/`prototype` IDs are rejected in request and
  response keys, so no decided result can omit an own question key.
- Ignored non-2xx/redirect bodies are cancelled without awaiting an
  unbounded close; error results are unchanged.
- A Retry-After above the 60 s policy horizon keeps its exact server
  minimum with an exceeds-policy reason, never an earlier retry advice.

## Official schema verification (2026-09-19)

Checked `https://docs.typesafe.ai/api` and `https://docs.typesafe.ai/models`:

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, bearer auth,
  `{ model, state, questions }` request, `{ model, answers, usage }`
  response with `usage.input_tokens` / `usage.output_tokens`. Matches ADR-0005.
- Pinned `jev-1.13.0` is listed as Jev 1.13; aliases `jev-latest` and
  `jev-preview` both currently resolve to `jev-1.13.0`. No drift against the
  pin. Drift risk recorded: the API examples send `jev-latest`, which moves
  between releases, so this boundary sends only the pinned ID and requires
  the versioned response model to match.
- `noul` answer is `{ type, noul }` with NO confidence field. Enforced:
  extra keys (including `confidence`) on a noul answer are rejected.
- `choice` answer is `{ type, choice, probabilities, confidence }` with a
  full distribution summing to 1. Enforced with exact key match, finite
  unit values, sum tolerance 1e-3, and `choice` at maximum probability.
- `score` answer is `{ type, score, legend, probabilities, confidence }`
  with string level keys, legend text per level, and a probability-weighted
  score. Enforced with legend keys `"0".."n-1"` matching criteria order,
  exact distribution keys, and weighted-score tolerance 1e-3.
- Errors are 401 / 422 / 429 / 529 with backoff guidance for 429/529 and a
  `retry-after` header convention. Enforced as typed retry classification
  with no internal retry.
- Limits are 64k tokens per request and 32k for state plus the longest
  question. Token accounting needs the backend reservation path, so this
  proof enforces only byte-level transport bounds (1 MiB request cap,
  256 KiB response cap, 10 s default timeout covering headers AND the body
  stream) and leaves allowance enforcement to the coordinator-owned
  execution module.
- Body-stream hardening: a stalled body reports `unavailable/timeout`, a
  rejected stream reports `unavailable/body-error` (never a raw throw), and
  an abort during the body cancels the reader and reports `stale`. Covered
  by three regression tests.

## J-case coverage (this proof)

- J-01: fixed endpoint, pinned model, correct body, one request per
  attempt, secrets only in the Authorization header — covered.
- J-02: missing/wrong-typed/unknown-option/malformed/nonfinite/model-drift
  responses cannot decide — covered (all return `needsReview`).
- J-03: 401/422 nonretryable vs 429/529 retryable classification with no
  hidden retry — partially covered (typed advice only; shared allowance,
  backoff execution, and the three-attempt budget belong to the
  coordinator-owned module and are NOT claimed here).
- J-04: pure `isStaleInput` / `applyIfCurrent` helpers with explicitly no
  backend authority — partially covered (late-response application,
  refusal/recipient/grant enforcement belong to backend code and are NOT
  claimed here).
- J-05 through J-07: not attempted in this proof (need authorized live
  action, domain evaluation, and published user path).

## Evidence mode

Controlled only. Run the shared strict compiler command, then
`bun test proofs/jev` (55 tests) plus
`node --test scripts/check-pr.test.mjs scripts/check-workbench.test.mjs`
(23 tests). Delayed-stream fixtures clear their timers on cancel so
bounded-timeout tests leave no asynchronous work behind for later suites.
