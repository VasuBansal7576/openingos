# OpeningOS agent instructions

**Commit meaningful checkpoints frequently and push them to GitHub; do not leave assigned work only in local commits, and clean up completed task worktrees after verified handoff.**

Read `PRD.md` before changing product behavior.
Read `docs/adr/README.md` and the relevant decision records before production implementation; proposed records do not authorize dependent feature work.
For provider integration work, read `docs/integrations/sponsor-contracts.md` and take an assigned package from `docs/implementation/sponsor-integration-plan.md`.
For Jev work, read ADR-0005's API contract; a coding-agent Jev model listing is not deployed application access.
For Orca coordination, follow `ROADMAP.md` for setup and build order.
Do not infer application API behavior from a coding-agent plugin or copy provider example endpoints without the required access checks.
For implementation or delivery work, read and follow `skills/openingos-factory/SKILL.md`.
That is a tracked project skill, loaded through this file rather than a global installation.

## Current state

The user selected the purchasing workbench and rejected the opening-scene and price-route designs.
The complete selected fixture prototype is preserved in `design/purchasing-workbench.html`, including its images, fonts and runtime.
It is a design reference, not production application code or an approved architecture.
The production application must match the selected prototype's design quality, interaction smoothness and user flow while using real backend state and authorized provider integrations underneath it.
Fixtures may support controlled tests, but they must never masquerade as live data or external success.
Do not reintroduce rejected designs, a design switcher, or prototype build infrastructure.
Keep future design explorations as lightweight clickable screens unless the user asks for application engineering.
Do not treat proposed ADRs, a green tooling check, or demonstration fixtures as completed product behavior.

## Work boundaries

- Draft and resolve cross-cutting ADRs before their dependent workers implement them.
- Give workers implementation packages with acceptance criteria and file ownership, not one ADR each.
- Use the sponsor plan's named retry owners, outbound send path and evidence rules; report incompatible package behavior before changing a shared contract.
- All hackathon outreach goes only to the owner's privately configured mailbox, with the owner playing the supplier; block real-vendor email, contact forms and alternate channels in every workspace.
- Use real providers for live runs and preserve honest waiting/failure states; label owner-authored terms as controlled demo evidence, never genuine vendor quotes or realized savings.
- Use Orca for developer orchestration when authorized; it is not the customer application's runtime.
- Use the active OpeningOS orchestrator as coordinator and a separate Codex CLI `gpt-6-astra` session as independent reviewer.
- Use OpenCode Go `opencode-go/muse-spark-1.3-contributor` and Codex CLI `gpt-5.6-luna` as implementation workers; verify effective models before assigning work.
- The coordinator owns setup, proof tasks and routine technical decisions; accept or amend proposed ADRs from evidence before dependent workers start.
- The coordinator handles routine worker permissions and recovery within existing authority, not blanket approvals, security bypasses or new spending.
- Inspect each worker permission request, approve only a narrowly scoped command within its assigned package, and verify that the worker resumes after the decision.
- Keep `ROADMAP.md` checkboxes factual and current after each verified wave; mark an item complete only from observed evidence.
- Preserve existing uncommitted work and stable P-, H-, and D- requirement meanings.
- Keep the customer assistant limited to shipped, enabled OpeningOS workflows; see the PRD's product capability boundary and D-17.
- A clearly out-of-scope customer request receives a brief refusal and stops; do not answer it, launch tools for it, or retry it as an agent failure.
- Enforce capability and job authority in backend code, not only prompts or model classification.
- Do not mistake roadmap capabilities, general-purpose provider tools, or a recovery attempt for permission to add unrelated customer workflows.
- Keep launch-only planning outside the hackathon implementation unless requested.
- Keep secrets, private supplier records, and unredacted evidence out of Git and public uploads.
- Do not install paid services, grant repository access, merge, or force-push without separate user authorization.

## GitHub checkpoints and worktree cleanup

The user authorizes normal commits and non-force pushes of assigned project work, plus safe cleanup of its completed task worktrees under the conditions below.
Honor an explicit local-only or do-not-push instruction when one is given for a task.
Commit small, coherent checkpoints during work and push before handoffs and completion, not only at the end of a long implementation.
Stage only inspected in-scope files, exclude secrets and unrelated changes, and verify that the pushed commit is present on the intended GitHub branch.
Workers push their assigned branches; publishing a checkpoint does not authorize merging into the integration branch or deploying.
Run relevant local checks, then own the latest pushed commit's CI and review follow-through; a pushed checkpoint is not automatically a completed task.
If a push fails or access is unavailable, preserve the work and report the exact blocker instead of claiming it is backed up remotely.

After the assigned work is verified, pushed, and handed off, the coordinator must clean up its task worktree when no worker or pending repair still needs it.
Confirm the exact worktree, settled worker ownership, clean status, and remote preservation of every needed commit; inspect untracked and ignored files for anything that needs keeping.
For Orca-managed worktrees, use Orca's documented lifecycle and cleanup path and verify the result rather than deleting the directory directly.
For an ordinary Git worktree, use non-forced `git worktree remove` on the verified task path.
Never remove the main checkout, the currently active worktree, another task's worktree, or unpreserved work.
Do not use recursive deletion, forced removal, or forced branch deletion to make cleanup succeed.
Keep the pushed branch available for review or recovery; remote branch deletion is a separate action.
If safe cleanup is blocked, name the retained worktree, reason, and owner in the handoff.

## Completion

Every implementation handoff states the commit, changed behavior, exact tests and results, live versus controlled evidence, and unresolved blockers.
An authorized PR delivery task remains owned until its latest commit passes its agreed checks and actionable review findings are addressed.
Missing, pending, skipped expected, stale, or inaccessible checks are not success.
Run `node --test scripts/check-pr.test.mjs` after modifying the CI inspection helper.
The `delivery-guard-tests` workflow tests this helper only; application CI must be added with the application foundation.
Use the project-local hackathon skill to update `hackathon.md` after meaningful work, without claiming unobserved outcomes.
During multi-worker runs, the coordinator is the sole build-log writer; workers return commit/test evidence instead of editing the same log concurrently.
Update and push the factual log after verified integrated checkpoints and before a pause or submission.
Update README setup and status when those facts change; do not claim that instructions are a running background automation.
Before UI handoff, test the complete integrated flow with Playwright or Computer Use at desktop and narrow widths, including keyboard navigation and loading, empty, error and recovery states.
Compare the result against `design/purchasing-workbench.html` and any supplied prototype recording for visual polish, interaction smoothness and user-flow fidelity while verifying that all displayed outcomes come from real application state.
