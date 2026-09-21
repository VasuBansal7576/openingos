# Coordinator roadmap

Build the full hackathon scope in `PRD.md`, using the selected purchasing workbench.
`AGENTS.md` owns roles and permissions; the [factory skill](skills/openingos-factory/SKILL.md) owns delivery; [ADR-0008](docs/adr/0008-verification-and-worker-handoffs.md) and the [package plan](docs/implementation/sponsor-integration-plan.md) own dependencies and tests.
This file supplies order, not duplicate contracts or a running automation.

## Build order

1. [x] **Preflight.** The active OpeningOS orchestrator verifies effective worker models, isolated worktrees, credential presence and scoped native permission handling.
   Load Orca's installed, version-matched orchestration guide.
   The verified OpenCode route supplies an `openingos-worker` agent through `OPENCODE_CONFIG_CONTENT`, starts `opencode --agent openingos-worker`, confirms `opencode-go/muse-spark-1.3-contributor` with the `high` variant in the TUI, then attaches it through supervised `worker-start --terminal`.
   Codex workers and reviewers start in explicit normally sandboxed terminals before supervised attachment; do not use launch paths that add security-bypass flags.
   Test an innocuous worker question and an actual native approval path; Orca `ask/reply` alone is not sandbox approval.
   A checked preflight records missing application credentials as blockers for affected live operations; it does not claim that those credentials exist.
2. [ ] **F0, foundation proofs.** Configure OpenCode's official Convex skills/MCP and verify both workers can access the project skills.
   Once the app contains Convex, run `npx convex ai-files status`, install missing/stale managed AI files, and read the generated guidelines.
   Establish app CI, hosted Convex access, identity isolation, the Jev adapter and isolated remote browser execution.
   Resolve ordinary technical choices with test evidence and amend the relevant ADR before dependent implementation.
   The controlled application, Jev and browser foundations are accepted at `6432e98`; hosted Convex, live credentials, identity isolation on the published origin and D-04 remain open.
3. [x] **F1, shared contracts.** Prove schemas, money, authority, owner-only recipients, deduplication and shared provider budgets.
   Independent controlled contract tests may run alongside F0; freeze affected interfaces only after their prerequisites pass.
   Assign one owner to schema, dependency and lockfile changes.
4. [ ] **R1 / C1 / U1, parallel features.** After accepted F1 contracts land, dispatch research, communication and workbench packages with exclusive file ownership.
   Use the Netherlands/EUR source set in PRD section 52; preserve all required categories and the full evaluator journey.
   - [x] R1 bounded Firecrawl collection and controlled S-11 through S-14 coverage include independently paginated evidence, claims and candidate streams at exact PR head `099d016`.
   - [x] C1 owner-only transport, callbacks, reconciliation and quote ingestion use indexed provider binding lookup at exact PR head `099d016`.
   - [x] U1 production-state adapter and live Convex wiring are implemented at pushed PR #3 head `284e528`; the complete local suite passes on that exact commit.
   - [ ] U1 desktop/narrow browser proof, authoritative quote-selection projection and final exact-head review remain open.
5. [ ] **E1, integrated behavior.** Build recovery, change impact and equipment/service flows against the integrated research and communication modules.
   - [x] Project-authorized, bounded equipment projection reads real asset, safe document and service-case records at local integration commit `436dc61`.
   - [x] The workbench consumes that exact equipment shape at local integration commit `8ac84de`, renders honest empty and truncation states, and keeps service creation disabled because no backend command route exists.
   - [ ] Equipment/service mutations, commissioning, recovery and change-impact flows remain open.
6. [ ] **V1, proof and review.** A separate Astra session reviews a fixed combined commit; implementation owners repair its findings.
   Prove all 52 P/H/D requirements, 24 S-cases and 7 J-cases, recording live versus controlled evidence and any unmet case.
   Exercise the real owner-email negotiation, Jev decisions, browser recovery, guest isolation and responsive UI; an early working path is not completion.
7. [ ] **Publication and closeout.** Hand the tested pushed revision to ChatGPT Sites for owner-authorized publication with public access.
   Verify the final public origin, hosted integrations and anonymous evaluator path; then update README and the build log.
   Give the owner the exact URL, commit and redacted evidence for their video, announcement and submission.

## Verified progress

- [x] Read the project instructions, package plan, ADR register and installed Orca orchestration guide.
- [x] Verify the active coordinator is GPT-5.6 Sol and a separate normally sandboxed reviewer terminal reports OpenAI `gpt-6-astra` with `xhigh` effort.
- [x] Verify the normally sandboxed Codex worker session metadata reports OpenAI `gpt-5.6-luna` with requested `max` effort and no security-bypass launch flag.
- [x] Verify OpenCode session messages report `opencode-go/muse-spark-1.3-contributor` with `high` variant.
- [x] Create isolated Luna and Muse Spark worktrees from reviewed checkpoint `3bbb1b7`; both can read the tracked factory skill.
- [x] Exercise native scoped approvals: Codex's harmless print command and OpenCode's one-time shell approval.
- [x] Exercise OpenCode's Orca question/reply round trip.
- [x] Finish Codex's Orca question/reply and lifecycle round trip under scoped IPC approval.
- [x] Install official Convex skills for OpenCode and verify its configured MCP connects.
- [x] Install the official project-managed Convex AI files, verify `convex ai-files status` reports enabled, and read the generated guideline; this is tooling guidance, not hosted deployment evidence.
- [x] Verify a restarted OpenCode worker sees the twelve Convex MCP tools before backend work; none were invoked.
- [x] Verify the restarted OpenCode session retains the requested model/high variant and runs its 28 controlled tests without a native approval prompt.
- [x] Push reviewed proof checkpoint `595d30c`; pass 77 controlled contract tests with 305 assertions, 23 repository checks, strict TypeScript and all four expected CI jobs.
- [x] Have the independent Astra session review fixed commits, route findings to their owners and verify all M1–M7/RJ1–RJ7 repairs at `595d30c`.
- [ ] Verify hosted environment, application credentials, provider allowances and owner recipient.
- [x] Integrate and review the independent financial and Jev contract proofs.
- [x] Integrate browser-executor controlled contract proof `714155f`; its 51 nominal controlled tests passed before independent review.
- [x] Close all FR01 through FR08 browser-executor findings reported by the separate Astra reviews, integrate the Spark-owned repairs through `6432e98`, and obtain an ACCEPT verdict on that exact fixed commit.
- [x] Integrate and review the Luna-owned application foundation, including strict app and browser-executor CI coverage, official component registration, identity foundation, controlled Jev and AgentMail boundaries and an honest unconfigured-backend state.
- [x] Pass the full local matrix at `6432e98`: typechecks, production build, 23 repository tests, 77 proof tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 mounted user-path tests.
- [x] Pass both exact-head GitHub workflows at `6432e98`: application CI run `35479908327` and repository checks run `35479908303`.
- [x] Have the separate Astra reviewer pass 66 fresh FR03 boundary/isolation tests, the prior 64-probe suite and 20 additional complete browser-suite runs; all evidence remains controlled.
- [x] Resolve ADR-0003 through ADR-0008 for controlled implementation and record every P/H/D, S and J case in the [evidence matrix](docs/verification/evidence-matrix.md).
- [x] Integrate F1R-01 through F1R-12 repairs at `8abd7c1`, including grant-wide exposure, orphan-reservation cleanup, early/late event application, graph and revision lineage, resolvable evidence, numeric validation, watch-target isolation and project-scoped selection idempotency.
- [x] Pass the full local matrix at `8abd7c1`: both typechecks, production build, 23 repository tests, 77 money/Jev proofs, 186 F1 tests, 117 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Complete and integrate F1R-13 durable line and adjustment lineage at `02209d6`, including multi-line selection, order and acceptance state, typed immutable financial evidence, linked credit/refund isolation, bounded authorized reload state, exact pre-upgrade replay compatibility and quote-quantity caps.
- [x] Pass the full local matrix at `02209d6`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 190 F1 tests, 125 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Integrate F1R-06, F1R-07 and F1R-12 repairs at `540d4a5`, plus F1R-14 through F1R-17 at `ae52e39`, addressing the seven actionable defects from Astra's `8fedeb7` review in the combined implementation.
- [x] Pass the full local matrix at `540d4a5`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 191 F1 tests, 148 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests; all 48 unchanged Astra rejection probes also pass against this combined head.
- [x] Integrate the Greptile and Astra F1 follow-up repairs through `1f17c00`: sparse bounded evidence bindings, strict legacy evidence replay, bounded commitment and history reads, paginated lineage, unresolved-unit adjustment denial and preserved legacy scalar order/acceptance mirrors.
- [x] Pass the full local matrix at `1f17c00`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 191 F1 tests, 161 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests; the 48 unchanged rejection probes and 7 historical bridge probes pass together 55/55.
- [x] Pass the full local matrix at `c7637ba`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 226 F1 tests, 174 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Repair and resolve Greptile's stale paginated reconciliation-summary finding at `5b5b0bd`, with a regression covering an earlier-page operation becoming terminal during a later-page pass.
- [x] Pass the full local matrix at `5b5b0bd`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 227 F1 tests, 174 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Repair Greptile's exact-head automatic-authority and unsampled-reconciliation findings at `497636d`: omitted-grant record-changing operations create no effect, while bounded current-state probes keep oversized reconciliation explicitly incomplete and resumable until an exact snapshot fits.
- [x] Pass the full local matrix at `497636d`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 229 F1 tests, 174 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Integrate the separate Astra review repairs through `e21950e`: both read routes now refuse unrelated and generic-commercial requests before durable rows or operation binding, and a bounded indexed current-state snapshot corrects late unsampled reconciliation counts.
- [x] Pass the full local matrix at `e21950e`: TypeScript, production build, 23 repository tests, 77 money/Jev proofs, 234 F1 tests, 174 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Have the separate Astra reviewer reject exact PR head `ba07217` with controlled reproductions for three remaining defects: lone record nouns still authorizing read jobs, temporary approvers extending their own authority, and unbounded quote-successor scans.
- [x] Integrate the owner-routed P1 and P2 repairs through `e78844f`: read authority now requires an explicit purchasing-read cue, delegated membership expiry cannot outlive the issuing authority, and selection and approval use a bounded indexed successor probe.
- [x] Pass the full local matrix at `e78844f`: TypeScript, production build, 23 repository tests, 77 money/Jev proofs, 236 F1 tests, 179 direct Convex tests including actual-handler read budgets, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Have the separate Astra reviewer reject exact PR head `bad0c12` with controlled reproductions for mixed-role membership expiry precedence, unbounded membership-history reads and a cross-project revocation existence oracle.
- [x] Integrate the coordinator-reviewed membership repairs through `fc3ff7b`: exact indexed authority reads preserve permanent and temporary grants across legacy and projected rows, grant and access handlers remain bounded with 300 unrelated rows, and inaccessible existing memberships deny identically to absent IDs before role comparison.
- [x] Pass the full local matrix at `fc3ff7b`: TypeScript, production build, 23 repository tests, 77 money/Jev proofs, 241 F1 tests, 179 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Have the separate Astra reviewer reject exact PR head `e9068fc` after proving that a temporary approver plus a permanent lower role could delegate that lower role permanently, temporary organization ownership could become permanent project ownership, and 25 earlier membership rows could hide valid organization authority.
- [x] Integrate the Luna-owned authority repair as `52df491`: delegation horizons now use only rows that independently satisfy both delegation and target-role authority, project-owner grants inherit temporary organization-owner expiry, and organization guards use bounded exact authority ranges.
- [x] Pass the full local matrix at `52df491`: both TypeScript checks, production build, 23 repository tests, 77 money/Jev proofs, 244 F1 tests, 180 direct Convex tests, 155 browser tests, 2 application tests, 19 provider-contract tests and 5 user-path tests.
- [x] Confirm exact PR head `92a49cd` has no new actionable Greptile findings, obtain a fresh ACCEPT verdict from the separate Astra reviewer on that same fixed commit, and verify GitHub reports no conflicts.
- [x] Merge ready PR #1 as `96f0f1f` after all exact-head gates pass, then verify the merged `main` tree is identical to the tested and reviewed `92a49cd` tree.
- [x] Shut down settled worker/reviewer sessions and remove both completed worker worktrees through Orca after verifying clean status and remote preservation.
- [x] Integrate the initial R1 research and C1 communication packages plus the bounded W1 backend projection through `d53c2ef`; pass TypeScript, production build, 23 repository tests, 77 proof tests, 244 F1 tests, 155 browser tests, 21 application/communication tests and 199 direct Convex tests.
- [x] Repair Greptile's PR #2 unbounded S1 negative controls with explicit 65-row reads in `1db56b5`, while retaining the production identity-first and quote-tuple index assertions.
- [x] Close Greptile P1 discussions `4058028201` and `4058028206` with indexed C1 binding lookup and independently paginated R1 evidence, claims and candidate streams; exact PR head `099d016` passes every expected GitHub check and Greptile.
- [x] Integrate D-17 mixed-scope admission, the real Convex U1 adapter and the J-03 actual-action allowance fence through local commit `c6c60fb`; focused controlled tests, TypeScript and production build pass.
- [x] Integrate the repaired E1 equipment backend projection through local commit `436dc61`; 10 focused projection tests, strict TypeScript and the production build pass, with asset documents restricted to exactly `kind` and `createdAt`.
- [x] Integrate the U1 activity-pagination and reconnect-action repairs through local commit `6c63609`; the full local test matrix, strict TypeScript and production build pass.
- [x] Close U1 Greptile P1 discussions `4058112415` and `4058112420` at exact PR head `df30e5f` with append-only activity pagination and connected-only mutation controls; factual test evidence is posted to both discussions.
- [x] Integrate the controlled J-06 versioned Jev evaluation corpus and runner through local commit `1f98a60`; 12 focused tests and strict TypeScript pass, and the suite is now part of `bun run test`.
- [x] Integrate the controlled server-only OpenAI Responses boundary through local commit `a0ec63f`; the dated model, strict extraction/draft schemas, source and token bounds, shared reservation fence, one-attempt transport and ambiguous accounting pass 17 focused tests and the combined full matrix.
- [x] Integrate the real E1 equipment projection into the workbench UI through local commit `8ac84de`; the independent rerun passes 47 app tests, strict TypeScript and the production build, with no live backend or service mutation claimed.
- [x] Repair Greptile P1 discussion `4058171616` through integrated commit `d734bba`: exact owner-only short drafts pass only under current grant, recipient, workflow and conversation authority, while D-17 supported-segment canonicalization remains intact for mixed communication.
- [x] Repair Greptile P1 discussion `4058206836` through integrated commit `b7c4002`: monotonic request generations discard stale head responses and failures, preserve live head state and prevent older activity pages from regressing the cursor.
- [x] Repair Greptile P2 discussion `4058227807` through integrated commit `b7c4002`: duplicate J-06 case IDs are rejected before metric access, grouping or scoring.
- [x] Repair Greptile P1 discussions `4058238262` and `4058238267` through integrated commit `de46ec6`: every post-fetch non-success retains unresolved exposure, and a digest of the complete parsed workload is bound through the grant, job and operation input-version snapshots before claim and fetch.
- [x] Repair Greptile E1 P1 discussion `4058268105` through integrated commit `3a73e65`: backend-valid empty optional equipment strings become absent display metadata without dropping the authorized projection, while defined non-string values still fail closed.
- [x] Repair Greptile W1 P2 discussion `4058268108` through integrated commit `3a73e65`: temporary membership creation schedules an idempotent membership-scoped expiry mutation whose database write invalidates reactive project and workbench queries.
- [x] Repair Greptile C1 P1 discussion `4058329243` through integrated commit `c13f1b8`: a changed fully supported supplier draft is rejected before an operation row, request key or grant allowance is consumed, while corrected same-key retries and D-17 mixed-segment canonicalization remain valid.
- [x] Repair the three separate Astra C1 findings at pushed PR #2 head `0fb855f`: reconciliation slots are charged per provider read, retained replies continue through bounded autonomous batches, and complete inbound source bodies remain protected while public excerpts stay bounded. Focused communication suites, TypeScript and every expected GitHub check pass on that head.
- [x] Repair the four separate Astra workbench findings at pushed PR #3 head `284e528`: mutation completion preserves newer reactive projections, decimals and coordinated objects remain intact during scope classification, readiness stays explicitly unassessed without authoritative data, and every overlay uses a shared modal keyboard/focus contract. The complete local `bun run test` suite passes with 293 direct handler tests; exact-head GitHub checks are still being observed.
- [x] Repair PR #4 readiness lineage, quantity aggregation and evidence bounds at pushed head `947561c`; the complete local suite and every expected GitHub check pass on that exact commit.
- [ ] Fresh Greptile reviews are unavailable because the connected trial reports its 50-credit limit exhausted; prior actionable threads are resolved with exact commit evidence, but a skipped review is not treated as acceptance.
- [ ] Finish server-side cross-client research-start idempotency and authoritative quote total/currentness projection, integrate the latest PR #2 base into PRs #3 and #4, inspect the selected flow at desktop and narrow widths, then obtain exact-head CI and separate Astra review.

The completed money and Jev proof wave contains controlled proofs only, reviewed at `595d30c` with no actionable findings remaining.
Luna owned `proofs/money/**`; Muse Spark owned `proofs/jev/**`; Astra owned shared tooling, integration and progress files.
The separate Astra reviewer also passed 1,144 exact allocation/changed-price cases and 1,760 settlement split/reordering checks.
The application/browser foundation is accepted at `6432e98` for controlled implementation, with FR01 through FR08 closed and NR03 assigned to F1.
This accepts the documented contracts as implementation inputs; it does not pass the full F0/F1 gates or authorize live provider effects.
Hosted provider cases still need a hosted environment, application credentials, provider allowances and the private owner recipient; those facts remain unverified and block only the affected live evidence.

## Duties throughout

- Own worker questions, scoped approvals and stuck-worker recovery; never use blind approvals or disable security to unblock work.
- Check native worker approval prompts before and after coordinator work batches while workers are active; Orca inbox messages do not replace terminal checks.
  Approve inspected requests within the assigned package directly, and verify execution resumes.
  Validate scoped OpenCode permissions before launch; configuration changes require a verified session restart before claiming they affect a running worker.
- Preserve an uncertain worker's ownership; use Orca's documented recovery only after proving its state.
- Push meaningful checkpoints, inspect every expected check on the latest remote commit, and fix failures.
- Keep each integrated delivery wave visible in a ready-for-review GitHub PR; do not leave reviewable progress only in local commits or worker branches.
- The owner has authorized merging a ready PR only after its exact latest head passes the agreed application and repository CI, all actionable Greptile findings on that head are resolved, a separate Astra session accepts the same code revision, and GitHub reports the PR conflict-free.
  After each merge, verify the remote main tree matches the locally tested integration tree before starting the next wave; local and GitHub output must come from equivalent source.
- Verify Greptile on the first authorized real PR and address its findings; its current green check does not enforce a confidence threshold.
- Be the sole `hackathon.md` writer after verified integrated checkpoints and before pausing; workers supply evidence.
- Keep these checkboxes current after each verified wave, and never convert controlled evidence into a live-provider or deployment claim.
- Match the selected workbench prototype's visual polish, smoothness and user flow while sourcing every displayed outcome from real application state; inspect any later supplied recording and finish with Playwright or Computer Use at desktop and narrow widths.
- Settle workers before safe worktree cleanup under `AGENTS.md`; preserve the active/main checkout and anything not backed up remotely.
- On a genuine external blocker, continue independent work and report the exact missing authority or input once.

## Owner-supplied dependencies

The owner handles the new Firecrawl account/credits, registration/eligibility, video, announcement and final submission.
The coordinator handles integration setup and proof, but cannot invent a receiving mailbox, API credentials, paid-spend authority or publication approval.
Use privately configured values; default to no paid overages and no live operation without a defensible authorized cost bound.
