# Implement the sponsor integrations

Use this plan when application implementation is authorized.
This document does not authorize deployment, provider spending, external mail or account changes.
No package below has been implemented or verified yet.

## Read the contracts before taking a package

1. Read `AGENTS.md` and `skills/openingos-factory/SKILL.md` from the repository root.
2. Read the [ADR register](../adr/README.md) and the PRD requirements assigned to the package.
3. Read [ADR-0004](../adr/0004-durable-jobs-and-provider-effects.md) and the [sponsor contracts](../integrations/sponsor-contracts.md).
4. Confirm the assigned base commit, file ownership, environment, expected CI checks and permitted external actions.
5. Report a conflict before coding against it; do not silently choose a different send path, retry policy or ownership model.

The PRD owns product requirements.
Accepted ADRs own architecture choices; their linked contracts define the selected interfaces.
Proposed ADRs permit only explicitly authorized proof work, not independent feature implementation.
Keep requirement identifiers unchanged and record contrary evidence before amending a decision.

## Follow the package order

The existing F0, F1, R1, C1, U1 and V1 package identifiers retain their meaning from ADR-0008.
The entries here specify their sponsor-integration work, not a replacement for the rest of the product.
All file paths in the ownership column are planned paths until the application foundation exists.
The foundation owner may map them to the starter's layout once and record that mapping before dispatch.

| Package | Work and owned files | Prerequisites | Return before handoff |
| --- | --- | --- | --- |
| F0 sponsor proof | Inspect installed packages; register components; configure verified HTTP routes and test helpers. Own `convex/convex.config.ts`, `convex/http.ts`, manifest, lockfile and shared test configuration | Reviewed ADR-0002/0004; explicit authority for hosted tests; identity decision for protected access | Exact versions and integrity hashes, compatibility results, route proof, S-01/S-02/S-03 results, remaining cost assumptions |
| F1 contracts | Implement validated ownership bindings, operation claims, reservations, evidence states and idempotency keys. Own `convex/schema.ts`, `convex/access/**`, `convex/execution/**` and shared validators | Reviewed ADR-0003 through 0007; F0 findings relevant to each contract | Committed interfaces, callable test fixtures, S-04 through S-10 results; no provider writes required for controlled tests |
| R1 research | Implement bounded Firecrawl operations, evidence preservation and partial-result UI data. Own `convex/research/**` and its tests | Accepted F1 interfaces; F0 package compatibility and permitted collection allowance | S-11 through S-14 results, actual request-count evidence, source-backed normalized records |
| C1 communication | Implement one-shot REST sends, component callbacks, reconciliation, evidence snapshots and quote ingestion. Own `convex/communication/**` and its tests | Accepted F1 interfaces; F0 webhook route; controlled inbox and recipient authority for live checks | S-05/S-06/S-07 plus S-15 through S-19 results; provider IDs and redacted test evidence |
| U1 workbench | Connect the accepted design to authorized paginated queries and explicit job/evidence/delivery states. Own the starter's UI directory and UI tests | Accepted F1 result contracts; controlled R1/C1 fixtures | S-20 UI results, keyboard/narrow-screen checks, no invented live outcomes |
| V1 integrated path | Exercise real sponsor work through the published app and collect submission evidence. Own integrated user-path tests and their evidence manifest | Combined R1/C1/U1 result; approved OpenAI/Jev contracts; separate browser proof | S-21 result, original PRD evaluator checks, latest-head CI and explicit unmet requirements |

F0 and F1 are proof work that helps accept or revise the ADR proposals.
Do not require completed feature work to approve the contracts it needs.
R1, C1 and U1 may run in parallel only after F1's shared contracts are committed and accepted.
Only the foundation owner changes registration, routes, schema, shared validators or the lockfile.
Feature workers request those changes with the required signature and test, rather than editing shared files concurrently.

## Complete F0 without inventing API support

1. Use the repository's configured package manager, or Bun when the selected starter has no preference.
2. Inspect the actual npm package contents against the source baseline in the sponsor contracts.
3. Pin exact tested versions and run Convex code generation through the documented starter workflow.
4. Register the official Firecrawl, AgentMail and Workflow components with their exported names.
5. Configure secrets through the approved backend mechanism without displaying their values.
6. Wire the AgentMail route with both internal callbacks and verify the actual hosted backend origin.
7. Register component test helpers in `convex-test`; use controlled provider responses for failure cases.
8. Record a pricing basis and a defensible maximum charge for each enabled operation, including hidden transport retries.
9. Keep live sends and live paid operations disabled when their authority or cost bound is absent.
10. Report package drift and amend the contract before adopting different behavior.

Do not copy unauthenticated README example endpoints into the product.
Do not enable AgentMail component send methods or Firecrawl bulk-crawl creation as shortcuts around the chosen contracts.
Do not patch installed `node_modules`, manually change generated references or fork a component without an explicit architectural amendment.

## Acceptance cases

These are new integration-test identifiers, separate from the unchanged P-, H- and D- requirements.
Each case is pending until its result is attached to the implementation commit.
Controlled fault injection proves local behavior, not actual provider delivery.

| ID | Scenario and required result | Evidence mode |
| --- | --- | --- |
| S-01 | Registered component exports and generated references compile against the exact locked packages | Local build |
| S-02 | A real controlled AgentMail callback reaches the correct hosted backend route and its product callback | Live, after authority |
| S-03 | Invalid signature, missing secret or tampered webhook body produces no purchasing update | Controlled HTTP boundary |
| S-04 | Two guests and two private organizations cannot read or act on another project's provider IDs, messages, evidence or files | Controlled direct API |
| S-05 | Duplicate `requestId` with identical payload returns one operation; changed payload conflicts; only one HTTP send is observed | Controlled concurrency |
| S-06 | Revocation, expiry, changed draft, relevant reply or cancelled job before claim produces zero sends | Controlled race |
| S-07 | Cancellation after claim cannot erase a confirmed late send; cancellation and delivery appear separately | Controlled race |
| S-08 | Two branches cannot reserve the full shared allowance; unknown charges remain reserved after failure | Controlled concurrency |
| S-09 | Process loss after claim, response loss and workflow replay cause reconciliation, not an automatic second send | Controlled crash points |
| S-10 | Clearly unrelated or unavailable requests launch no unsupported job; a legitimate parallel research job continues | Controlled direct API and UI |
| S-11 | Firecrawl transient faults produce no more than four transport attempts per reserved call and no workflow retry multiplier | Controlled HTTP count |
| S-12 | Firecrawl credit exhaustion pauses new work while completed evidence remains visible | Controlled provider response |
| S-13 | Truncated source content, missing extracted JSON and unstored pages remain explicitly incomplete and trigger a permitted recovery | Controlled oversized input |
| S-14 | Cancelled or stale research cannot start another paid operation or overwrite a current quote; already collected evidence remains attributed | Controlled race |
| S-15 | Duplicate callbacks and two event IDs for one message create one extraction per source/version; a missing callback is repaired from a bounded provider read without a duplicate quote | Controlled replay and callback failure |
| S-16 | A signed event arriving before the send response is retained, then linked by verified binding without another send | Controlled reordering |
| S-17 | Missing provider message, empty reconciliation search or several possible matches stays unknown; it does not become safe-to-resend | Controlled reconciliation |
| S-18 | Seed a finalized component outbound row, advance beyond seven days and verify cleanup removes it while the separate project timeline, approval and quote evidence remain readable | Controlled clock and cleanup |
| S-19 | Supplier HTML/instructions, new CC recipients and expiring attachment URLs cannot leak information or silently create approved evidence | Controlled malicious/incomplete input |
| S-20 | Workbench distinguishes queued, sent, delivered, unknown, partial and paused states; reload and reconnect preserve server truth | Browser, controlled backend |
| S-21 | Real Firecrawl research, useful Jev decisions, OpenAI extraction/drafting, authorized AgentMail send and reply, versioned quote and reactive UI work in one published project | Live controlled recipients |

Map S-01/S-02/S-21 to H-03, H-04 and H-07.
Map S-04/S-10/S-19 to P-16, D-09, D-14 and D-17.
Map S-05 through S-09 and S-11 through S-18 to the relevant P-05, P-17 and D-05 through D-16 checks in each package.
These tests supplement the PRD, including document, financial, browser, recovery and equipment cases; they do not replace it.

## Establish commands and CI before feature work

F0 creates the actual scripts and checks rather than reporting the current documentation tests as application verification.
With Bun, the required command contract is `bun run typecheck`, `bun run build`, `bun run test`, `bun run test:provider-contracts` and `bun run test:user-path`.
If the starter selects another package manager, record the equivalent commands once in `AGENTS.md` and the handoff.
Do not report an uncreated script as passing.

Name the corresponding checks `app-typecheck`, `app-build`, `app-tests`, `app-provider-contracts` and `app-user-path`.
Run provider-contract tests with controlled responses in ordinary CI.
Run the separately authorized live checks in a restricted environment and report their evidence separately.
Never expose live secrets to an untrusted pull request or make CI contact arbitrary supplier addresses.
Treat missing, skipped, stale, inaccessible and pending expected checks as incomplete.

The current repository checks remain `delivery-guard-tests` and `workbench-artifact-tests` only.
Run `node --test scripts/check-pr.test.mjs scripts/check-workbench.test.mjs` for changes to the existing delivery documents and artifact tooling.
Those 23 tests do not execute the planned sponsor integrations.

## Stop only the affected work

| Condition | Required action |
| --- | --- |
| Missing credentials, provider allowance, test recipients or deployment authority | Report the exact missing item to the coordinator; continue controlled tests without real calls |
| Published Sites cannot reach Convex or identity isolation fails | Stop dependent live work; retain the failure evidence and repair F0 |
| Package lacks the documented interface or behavior | Stop the affected integration; return the inspected version, source location and failing contract test |
| Firecrawl bulk-start idempotency or cost remains unproven | Keep bulk start disabled; continue the selected bounded one-shot research path |
| Provider result is ambiguous | Reconcile within the allowed read budget; expose unknown outcome and never invent success |
| Shared schema needs a change | Ask the foundation owner for the contract amendment; continue independent owned work |

Country/currency, identity selection, browser hosting and model calibration remain listed in the ADR register.
This plan does not silently settle those choices or shrink the agreed product to avoid them.

## Return a complete handoff

Include the package ID, base commit, final pushed commit, owned files and requirement IDs.
List exact commands, results, expected CI checks and the GitHub run for that same commit.
List each assigned S-case as passed, failed or unverified, with controlled versus live evidence clearly labeled.
Include dependency versions, actual provider request counts, spend assumptions and remaining blockers.
Do not include credentials, message bodies, private documents or session links in public evidence.
The coordinator verifies the combined result, owns remaining CI repairs and cleans completed worktrees under `AGENTS.md`.
