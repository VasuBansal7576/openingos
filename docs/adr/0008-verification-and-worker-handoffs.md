# ADR-0008: Verification and worker handoffs

Status: Proposed production workflow; existing delivery instructions remain in force.
Requirements: H-03 through H-08, P-14 through P-21, D-01 through D-17 as applicable to each package.

## Decision

Use small end-to-end checkpoints to reach the complete agreed hackathon path.
Do not call a fixture, a worker's isolated success or a green documentation check product completion.
Keep local/controlled, recorded-provider and live-provider evidence distinct.
The accepted design file is never a substitute for the production demo.

The current checks are `delivery-guard-tests` and `workbench-artifact-tests`.
They validate the helper and saved artifact only.
The production foundation adds `app-typecheck`, `app-build`, `app-tests`, `app-provider-contracts` and `app-user-path` before feature workers depend on it.
Name the fixed expected checks in every implementation package and inspect the latest remote commit, not a previous green run.

## Package map

| Package | Deliverable | Dependencies | Exclusive ownership |
| --- | --- | --- | --- |
| F0 | Sites/Convex, identity and remote-browser proof tasks | Reviewed ADR-0002, 0006, 0007; explicit deployment/provider authority | Foundation and proof configuration |
| F1 | Contract proof: validated domain schemas, financial tests, grants and execution contracts | Reviewed ADR-0003 through 0007; F0 findings for affected contracts | Shared schemas, generated contract inputs, package lock |
| R1 | Discovery, evidence and exact-variant comparison | F1; accepted provider/model contracts | Research and extraction modules |
| C1 | Approved communication, reply ingestion and quote revisions | F1; controlled mail access | Mail integration and supplier conversation modules |
| U1 | Workbench UI against the agreed Convex contracts | F1; ADR-0001 | UI and design tokens, not schema changes |
| E1 | Recovery, change impact and equipment/service path | R1 and C1 outputs integrated | Recovery and equipment modules |
| V1 | Combined evaluator path and submission evidence | All preceding packages | Integration tests, evidence manifest and demo preparation |

R1, C1 and U1 can run in parallel once F1's contracts are committed and accepted.
F0 and F1 are bounded experiments used to accept or revise the proposals; they do not require the feature implementation to exist first.
Independent financial/schema contract tests may proceed while F0 resolves hosting, but unresolved hosting and identity contracts must not be frozen by assumption.
One coordinator owns shared schemas, dependencies and integration.
Workers receive packages, not one ADR each, and may need several ADRs for one package.
Do not dispatch dependent feature workers while their shared contracts are merely proposed.
Use the [sponsor worker plan](../implementation/sponsor-integration-plan.md) for F0/F1/R1/C1/U1/V1 ownership, exact acceptance cases, command contracts and stop conditions.
The plan adds detail to these packages without authorizing their execution or replacing unrelated PRD requirements.
The [Orca handoff](../implementation/orca-handoff.md) records the user's requested implementation workers, independent reviewer, permission handling and startup checks.
Use OpenCode Go Muse Spark 1.3 and Codex CLI GPT-5.6 Luna for implementation, with Codex CLI GPT-6 Astra for independent review.
Resolve and verify the exact model IDs from that handoff rather than changing global defaults or accepting a silent fallback.

## Environments and realistic tests

Use separate namespaces or deployments for workers, separate AgentMail project inboxes and separate browser sessions.
Every live outbound test targets the same approved owner recipient; worker isolation does not authorize new external mailboxes.
A Git worktree does not isolate Convex data or a provider balance.
Keep a labeled source set with compatible, incompatible, unpublished-price, stale, conflicting and incomplete candidates from the agreed market.
Add scanned/text documents, multi-item quotes, changed grants, delayed replies and injected transient failures.

The combined path proves real Firecrawl collection, a real OpenAI extraction, useful Jev decisions, a deployed browser operation and a real AgentMail round trip with the owner playing the supplier.
The owner receives an RFQ in their email client, supplies a counteroffer, and receives a model-generated follow-up based on that actual reply.
Verify with an unscripted term change that the agent uses the new input within its mandate and that Convex updates the correct project.
Record a live transport separately from the controlled counterparty, and label a replay of the exchange as recorded.
No reply means waiting; no model/provider access means unavailable, not a hidden mock fallback.
It then proves comparison, exact-version selection, unchanged committed/paid totals, bounded recovery, an equipment case and persistence after reload.
Keep the original PRD's additional acceptance cases as explicit tests or unimplemented requirements; never redefine them to match the demo.

Record input set, model/question versions, commit, environment, start/finish times, outcome quality, interventions, total provider cost, retries and failure reasons.
Report browser and model timings separately.
Acceptance is based on observable outcomes and critical invariants, not a confidence score or a dramatic recording.

## Delivery and cleanup

Follow `AGENTS.md` and `skills/openingos-factory/SKILL.md` for frequent pushed checkpoints, current-head CI repair and safe worktree cleanup.
Use Orca's documented lifecycle when developer workers are authorized.
Greptile is enabled for OpeningOS as observed September 19, but the first actual PR review remains unverified.
Its absence or lack of a current-head result cannot be represented as a review pass.
Markdown instructions do not wake a stopped agent, so unattended CI repair requires a separately authorized runner.
No such runner is claimed to exist.
The active coordinator handles routine permissions within the approved scope and owns stuck-worker recovery under Orca's liveness rules.
Native approval routing must be tested; an Orca question reply does not itself satisfy a worker's sandbox approval.
The coordinator alone updates `hackathon.md` from verified integrated evidence and pushes it after meaningful checkpoints.
Workers return evidence instead of concurrently editing the log.

After integration, exercise the workbench at desktop and narrow widths, with keyboard-only navigation and all affected failure states.
Deployment, production writes, access-policy changes, external outreach and submission retain their separate authorization gates.
