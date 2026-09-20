# OpeningOS evidence matrix

This matrix keeps every stable requirement ID tied to its original meaning in [PRD.md](../../PRD.md) and every sponsor/Jev case tied to the [implementation plan](../implementation/sponsor-integration-plan.md).
It records evidence available at reviewed F1 checkpoint `92a49cd`, merged to `main` as `96f0f1f` on September 21, 2026.

Status meanings:

- `controlled-verified`: deterministic local or injected-boundary evidence passed and received independent review.
- `partial-controlled`: a meaningful subset passed under controlled conditions, but the complete requirement did not.
- `live-unverified`: the requirement needs hosted or external-provider evidence that has not run.
- `not-started`: no qualifying implementation evidence exists yet.
- `owner-blocked`: completion belongs to the owner or needs owner-supplied authority/input.

Passing controlled evidence never counts as a live provider, deployed application or genuine vendor result.

## Product requirements

| ID | Status | Current evidence and next gate |
| --- | --- | --- |
| P-01 | not-started | Full opening, comparison and equipment-case creation is not implemented. |
| P-02 | not-started | Requirements and assumptions are not yet editable application records. |
| P-03 | live-unverified | Research candidates need R1 plus real Firecrawl source evidence. |
| P-04 | not-started | Compatibility rules, conversion and changed-constraint invalidation need R1/E1. |
| P-05 | live-unverified | Requires the owner-only real AgentMail send/reply path and correct project update. |
| P-06 | partial-controlled | Immutable financial snapshots and shared-charge calculations pass controlled proofs; quote ingestion/version UI remains. |
| P-07 | controlled-verified | Reviewed money proofs reject missing charges as zero and compare complete offers, including €7,950 versus €8,500. |
| P-08 | controlled-verified | Reviewed money proofs keep selection, commitment, payment, partial quantities and adjustments distinct without double counting. |
| P-09 | not-started | Priority/dependency readiness behavior needs domain implementation. |
| P-10 | not-started | Quantity and commissioning readiness needs domain implementation. |
| P-11 | not-started | Stock-check failure and placed-order delay semantics need R1/E1. |
| P-12 | not-started | Disruption substitution and approval history need E1. |
| P-13 | partial-controlled | Browser jobs fence stale, revoked and expired authority in controlled tests; communication effects and product approvals remain. |
| P-14 | partial-controlled | Controlled browser callbacks/jobs and financial proofs cover replay/idempotency subsets; outgoing mail and equipment records remain. |
| P-15 | controlled-verified | F1 direct-handler tests deny cross-organization, forged-ID and restricted-project reads and writes. |
| P-16 | controlled-verified | F1 direct-handler tests keep private quotes and financial limits inaccessible from isolated guest sessions. |
| P-17 | partial-controlled | Controlled browser execution exposes bounded failure, cancellation and recovery states; provider outages/reconnect remain. |
| P-18 | partial-controlled | The bounded authorized backend projection now reads stored assets, safe document metadata and service cases with cross-project isolation and truncation tests; commissioning, UI consumption and service/replacement mutations remain open. |
| P-19 | not-started | Second-location reuse with fresh-fact checks needs E1. |
| P-20 | partial-controlled | F1 enforces contributor, approver and owner authority across project scopes; the due-decision workbench flow remains for U1/E1. |
| P-21 | partial-controlled | Foundation UI has reviewed desktop/narrow and keyboard retry evidence; the complete selected workflow and all state variants remain. |
| P-22 | not-started | Usage/outcome metric records and truthful reporting need F1 through V1. |
| P-23 | not-started | Negotiation mandate, disclosure, rounds and non-commitment need C1/E1. |
| P-24 | not-started | Document/CSV import, invalid input and review flow need R1/E1. |

## Hackathon delivery requirements

| ID | Status | Current evidence and next gate |
| --- | --- | --- |
| H-01 | owner-blocked | Registration and eligibility are owner responsibilities and are not verified. |
| H-02 | partial-controlled | Repository history records the project start, but official eligibility confirmation remains owner-controlled. |
| H-03 | live-unverified | Convex packages/config compile locally; hosted persistence, mutations and realtime behavior are unverified. |
| H-04 | live-unverified | Controlled Jev/provider boundaries exist, but all four sponsors have not performed observable deployed work. |
| H-05 | partial-controlled | Public source checkpoints and a factual redacted build log exist; delivered-source status remains open. |
| H-06 | live-unverified | No public `chatgpt.site` origin is deployed. |
| H-07 | live-unverified | No published-origin Convex read/write/reactive update has run. |
| H-08 | owner-blocked | The owner records the final sub-three-minute video after V1 evidence exists. |
| H-09 | owner-blocked | The owner publishes the sponsor-tagged announcement. |
| H-10 | owner-blocked | The owner supplies and submits the final event form. |
| H-11 | partial-controlled | `hackathon.md` is maintained at integrated checkpoints; live URL/demo and final implemented behavior remain absent. |

## Product-specific delivery requirements

| ID | Status | Current evidence and next gate |
| --- | --- | --- |
| D-01 | not-started | Source-backed vendor dashboard needs R1/U1. |
| D-02 | not-started | Authorized contextual answers and version invalidation need R1/U1. |
| D-03 | partial-controlled | Pinned Jev transport/validation passes controlled tests; deployed useful decisions and telemetry remain. |
| D-04 | live-unverified | The local controlled executor is not a deployed plugin-free interactive browser job. |
| D-05 | partial-controlled | Independently reviewed executor tests cover recovery, strategy changes, saved work and duplicate-effect fencing; deployed provider recovery remains. |
| D-06 | partial-controlled | Independently reviewed executor tests cover bounded non-progress, cancellation, expiry and unrecoverable states; live allowance failure remains. |
| D-07 | partial-controlled | F1 owner-transport tests enforce scoped covered clarification and changed-recipient review; C1 still owns the real transport flow. |
| D-08 | not-started | Delivery/service/return/receiving visibility needs R1/U1. |
| D-09 | partial-controlled | Controlled executor sessions bind organization/project/job and reject stale/wrong context; full app guest/private evidence isolation remains. |
| D-10 | partial-controlled | Controlled tests record deterministic execution outcomes; representative end-to-end timing/cost/intervention evidence remains. |
| D-11 | not-started | Jev research prioritization and deferred-supplier resumption need R1. |
| D-12 | not-started | Jev choice, OpenAI draft and owner-only AgentMail negotiation need C1/E1. |
| D-13 | not-started | Supplier-resolvable uncertainty and focused review routing need R1/C1/E1. |
| D-14 | controlled-verified | Reviewed F1 and browser tests enforce backend capability, grant, expiry, revocation, recipient and unknown-operation denial, including covered-action continuity. |
| D-15 | not-started | Changed-term re-evaluation without history overwrite needs E1/U1. |
| D-16 | controlled-verified | F1 concurrency tests prove organization-wide reservations prevent branches and retries from each consuming the full shared allowance. |
| D-17 | controlled-verified | Integrated handler and controlled-store tests derive one supported purchasing segment, persist only its canonical payload, expose refused clauses, and revalidate at operation claim while pure unrelated, unavailable purchase, prompt-injection and evidence-expansion probes create no unauthorized work; separate Astra review remains. |

## Sponsor integration cases

| ID | Status | Current evidence and next gate |
| --- | --- | --- |
| S-01 | controlled-verified | Exact locked component exports, generated references, typecheck and build pass at `6432e98`. |
| S-02 | live-unverified | Requires an authorized signed AgentMail callback to a hosted backend. |
| S-03 | controlled-verified | Controlled HTTP-boundary tests reject missing/invalid/tampered AgentMail webhook input without product updates. |
| S-04 | controlled-verified | F1 direct-API tests isolate guest and private organizations, projects, provider IDs, evidence, quotes and budgets. |
| S-05 | partial-controlled | F1 request idempotency and one-effect concurrency pass; C1 still must prove one actual HTTP send. |
| S-06 | partial-controlled | F1 pre-claim revocation, expiry, changed-input and cancellation races create no effect; C1 still owns transport-level proof. |
| S-07 | not-started | C1 late-send versus cancellation state separation. |
| S-08 | controlled-verified | F1 shared-ledger concurrency prevents branch oversubscription and preserves unknown charges as reserved. |
| S-09 | controlled-verified | F1 crash-point and replay tests reconcile claimed, unknown and late outcomes without authorizing an automatic resend. |
| S-10 | controlled-verified | F1 backend tests refuse unrelated and unavailable work while a legitimate parallel research job continues. |
| S-11 | not-started | R1 bounded Firecrawl retry-count proof. |
| S-12 | live-unverified | R1 controlled response plus real allowance-exhaustion behavior. |
| S-13 | not-started | R1 incomplete/truncated source recovery. |
| S-14 | not-started | R1 stale/cancelled paid-operation and overwrite fencing. |
| S-15 | not-started | C1 callback deduplication and bounded repair read. |
| S-16 | not-started | C1 event-before-send-response reordering. |
| S-17 | not-started | C1 ambiguous reconciliation remains unknown. |
| S-18 | not-started | C1 component cleanup versus durable project evidence. |
| S-19 | not-started | C1 malicious HTML/header/attachment boundary. |
| S-20 | partial-controlled | Foundation UI has truthful configured/unconfigured/retry states and reviewed responsive behavior; full server-state vocabulary/reconnect remains. |
| S-21 | live-unverified | Full published Firecrawl/Jev/OpenAI/AgentMail/Convex path has not run. |
| S-22 | partial-controlled | F1 and browser tests enforce owner-only recipient versions and block alternate channels across API, model, retry and browser boundaries; C1 still owns the real transport integration. |
| S-23 | live-unverified | Requires the owner mailbox, hosted route, provider credentials and an unscripted real reply. |
| S-24 | partial-controlled | C1 callback and quote tests plus W1 projection tests enforce project-thread isolation, controlled/recorded counterparty provenance and public redaction; complete browser and export coverage remains. |

## Jev cases

| ID | Status | Current evidence and next gate |
| --- | --- | --- |
| J-01 | controlled-verified | Reviewed injected HTTP tests prove endpoint, pinned `jev-1.13.0`, body, authorization boundary and one request per reserved attempt. |
| J-02 | controlled-verified | Reviewed parser tests reject missing/wrong/unknown/malformed/nonfinite/model-drift responses. |
| J-03 | controlled-verified | The actual Jev action now rejects missing, invalid, overflowing or stale configured pricing before provider dispatch, requires one full three-attempt shared reservation, preserves ambiguous exposure and passes 15 focused controlled tests including concurrent action admission; live pricing and provider access remain unverified. |
| J-04 | controlled-verified | F1 validation, stale-result, grant, recipient and late-authority tests prevent changed, revoked or cross-recipient decisions from authorizing effects. |
| J-05 | live-unverified | No authorized hosted Jev call has run. |
| J-06 | not-started | Domain evaluation set, thresholds, latency and intervention report remain. |
| J-07 | live-unverified | No published useful Jev effect or owner-reply negotiation has run. |

## Current reviewed artifacts

- Money/Jev controlled checkpoint: `595d30c`, with 77 proof tests, 305 assertions and separate Astra review.
- Foundation/browser checkpoint: `6432e98`, with application typecheck/build/tests, provider/user-path contracts and 155 browser tests green locally and in CI.
- Shared-contract checkpoint: `92a49cd`, with 244 F1 tests, 180 direct-handler tests, exact-head Actions and Greptile green, and a separate Astra ACCEPT after 22 fresh actual-handler probes; merged as `96f0f1f` with an identical tree.
- Fixed-commit browser re-review artifacts are private temporary evidence and contain no live-provider result.
- The selected design reference remains `design/purchasing-workbench.html`; it is not counted as application behavior.
