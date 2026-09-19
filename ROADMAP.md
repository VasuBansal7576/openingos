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
3. [ ] **F1, shared contracts.** Prove schemas, money, authority, owner-only recipients, deduplication and shared provider budgets.
   Independent controlled contract tests may run alongside F0; freeze affected interfaces only after their prerequisites pass.
   Assign one owner to schema, dependency and lockfile changes.
4. [ ] **R1 / C1 / U1, parallel features.** After accepted F1 contracts land, dispatch research, communication and workbench packages with exclusive file ownership.
   Use the Netherlands/EUR source set in PRD section 52; preserve all required categories and the full evaluator journey.
5. [ ] **E1, integrated behavior.** Build recovery, change impact and equipment/service flows against the integrated research and communication modules.
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
- [x] Verify a restarted OpenCode worker sees the twelve Convex MCP tools before backend work; none were invoked.
- [x] Verify the restarted OpenCode session retains the requested model/high variant and runs its 28 controlled tests without a native approval prompt.
- [x] Push reviewed proof checkpoint `595d30c`; pass 77 controlled contract tests with 305 assertions, 23 repository checks, strict TypeScript and all four expected CI jobs.
- [x] Have the independent Astra session review fixed commits, route findings to their owners and verify all M1–M7/RJ1–RJ7 repairs at `595d30c`.
- [ ] Verify hosted environment, application credentials, provider allowances and owner recipient.
- [x] Integrate and review the independent financial and Jev contract proofs.
- [x] Integrate browser-executor controlled contract proof `714155f`; its 51 nominal controlled tests passed before independent review.
- [ ] Close the ten actionable browser-executor findings reported by the separate Astra review of `78e2694`, integrate the Spark-owned repairs and have Astra re-review the fixed combined commit before crediting the affected D-cases.
- [ ] Integrate and review the Luna-owned application foundation, including strict app and browser-executor CI coverage, official component registration, identity foundation, controlled Jev and AgentMail boundaries and an honest unconfigured-backend state.
- [x] Shut down settled worker/reviewer sessions and remove both completed worker worktrees through Orca after verifying clean status and remote preservation.

The completed money and Jev proof wave contains controlled proofs only, reviewed at `595d30c` with no actionable findings remaining.
Luna owned `proofs/money/**`; Muse Spark owned `proofs/jev/**`; Astra owned shared tooling, integration and progress files.
The separate Astra reviewer also passed 1,144 exact allocation/changed-price cases and 1,760 settlement split/reordering checks.
The worker branches remain on GitHub; their completed worktrees have been removed, and the coordinator checkout remains available.
Neither this proof wave nor its green CI accepts the proposed architecture, passes full F0/F1 gates or authorizes dependent product features.
Browser-executor review repairs and the application foundation remain active and do not require live credentials.
Hosted provider cases still need a hosted environment, application credentials, provider allowances and the private owner recipient; those facts remain unverified and block only the affected live evidence.

## Duties throughout

- Own worker questions, scoped approvals and stuck-worker recovery; never use blind approvals or disable security to unblock work.
- Check native worker approval prompts before and after coordinator work batches while workers are active; Orca inbox messages do not replace terminal checks.
  Approve inspected requests within the assigned package directly, and verify execution resumes.
  Validate scoped OpenCode permissions before launch; configuration changes require a verified session restart before claiming they affect a running worker.
- Preserve an uncertain worker's ownership; use Orca's documented recovery only after proving its state.
- Push meaningful checkpoints, inspect every expected check on the latest remote commit, and fix failures.
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
