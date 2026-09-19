# Coordinator roadmap

Build the full hackathon scope in `PRD.md`, using the selected purchasing workbench.
`AGENTS.md` owns roles and permissions; the [factory skill](skills/openingos-factory/SKILL.md) owns delivery; [ADR-0008](docs/adr/0008-verification-and-worker-handoffs.md) and the [package plan](docs/implementation/sponsor-integration-plan.md) own dependencies and tests.
This file supplies order, not duplicate contracts or a running automation.

## Build order

1. [ ] **Preflight.** Astra coordinates and verifies effective worker models, isolated worktrees, credentials and scoped native permission handling.
   Load Orca's installed, version-matched orchestration guide.
   Its inspected OpenCode route requires an explicit `opencode --model opencode-go/muse-spark-1.3-contributor` terminal, then supervised `worker-start --terminal` attachment after readiness.
   Verify current support rather than using an unsupported OpenCode `--model` flag or unsupervised injection.
   Test an innocuous worker question and an actual native approval path; Orca `ask/reply` alone is not sandbox approval.
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
- [x] Verify coordinator and separate reviewer sessions use OpenAI `gpt-6-astra`; both report `xhigh` effort.
- [x] Verify Codex worker session metadata reports OpenAI `gpt-5.6-luna` with requested `max` effort.
- [x] Verify OpenCode session messages report `opencode-go/muse-spark-1.3-contributor` with `high` variant.
- [x] Create isolated Luna and Muse Spark worktrees from `987b4ab`; both can read the tracked factory skill.
- [x] Exercise native scoped approvals: Codex's harmless print command and OpenCode's one-time shell approval.
- [x] Exercise OpenCode's Orca question/reply round trip.
- [x] Finish Codex's Orca question/reply and lifecycle round trip under scoped IPC approval.
- [x] Install official Convex skills for OpenCode and verify its configured MCP connects.
- [x] Verify a restarted OpenCode worker sees the twelve Convex MCP tools before backend work; none were invoked.
- [x] Verify the restarted OpenCode session retains the requested model/high variant and runs its 28 controlled tests without a native approval prompt.
- [x] Push combined proof checkpoint `897eea7`; pass 41 controlled contract tests, 23 repository checks, strict TypeScript and all four expected CI jobs.
- [x] Have the independent Astra session review fixed `897eea7` and route its 13 correctness findings plus one fixture-scale gap to the implementation owners.
- [ ] Verify hosted environment, application credentials, provider allowances and owner recipient.
- [ ] Integrate and review the independent financial and Jev contract proofs.

The current implementation wave contains controlled proofs only.
Luna owns `proofs/money/**`; Muse Spark owns `proofs/jev/**`.
Astra owns shared tooling, dependencies, ADR amendments and progress files, and a separate Astra session reviews fixed commits.
Neither proof authorizes dependent production features or passes the hosted F0 gates.
The first independent review of `897eea7` found financial M1–M7 and adapter RJ1–RJ7 issues.
The review of `85d8105` closed M3/M4/M5/M7 and all adapter behavior findings, while reproducing M1 selected-scope, M2 included-charge coverage and M6 rounding defects.
All four CI jobs passed on `85d8105`; that result did not close those review findings.
Luna’s pushed `a1972fb` and Muse Spark’s pushed `36d5ba9` are now integrated with 77 passing controlled proof tests, 23 repository checks and strict TypeScript.
Independent verification of this new combined revision and its remote CI remain pending.

## Duties throughout

- Own worker questions, scoped approvals and stuck-worker recovery; never use blind approvals or disable security to unblock work.
- Check native worker approval prompts before and after coordinator work batches while workers are active; Orca inbox messages do not replace terminal checks.
  Approve inspected requests within the assigned package directly, and verify execution resumes.
  Validate scoped OpenCode permissions before launch; configuration changes require a verified session restart before claiming they affect a running worker.
- Preserve an uncertain worker's ownership; use Orca's documented recovery only after proving its state.
- Push meaningful checkpoints, inspect every expected check on the latest remote commit, and fix failures.
- Verify Greptile on the first authorized real PR and address its findings; its current green check does not enforce a confidence threshold.
- Be the sole `hackathon.md` writer after verified integrated checkpoints and before pausing; workers supply evidence.
- Settle workers before safe worktree cleanup under `AGENTS.md`; preserve the active/main checkout and anything not backed up remotely.
- On a genuine external blocker, continue independent work and report the exact missing authority or input once.

## Owner-supplied dependencies

The owner handles the new Firecrawl account/credits, registration/eligibility, video, announcement and final submission.
Astra handles integration setup and proof, but cannot invent a receiving mailbox, API credentials, paid-spend authority or publication approval.
Use privately configured values; default to no paid overages and no live operation without a defensible authorized cost bound.
