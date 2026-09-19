# F1-J controlled Jev proof

Bounded proof only under proposed ADR-0005 / ADR-0004 and sponsor plan
J-01 through J-04. No live calls, no real credentials, no Convex schema, no
claim of application access or of integrated J-03/J-04 completion.

## Files

- `jev-boundary.ts` — fixed-origin, pinned-model, single-attempt fetch
  boundary with `unknown` response validation for `noul`, `choice`, `score`.
- `jev-boundary.test.ts` — Bun tests using only local stubbed fetch
  responses and the synthetic key `ts-test-synthetic-key-0000`.

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
  256 KiB response cap, 10 s default timeout) and leaves allowance
  enforcement to the coordinator-owned execution module.

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

Controlled only. Run `bun test proofs/jev` plus
`node --test scripts/check-pr.test.mjs scripts/check-workbench.test.mjs`.
