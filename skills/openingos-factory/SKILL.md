---
name: openingos-factory
description: Deliver OpeningOS changes through isolated Orca work, evidence-based verification, and an owned CI and review repair loop. Use for implementation packages, worker handoffs, or authorized pull request delivery in this repository.
---

# OpeningOS delivery workflow

Apply isolate, build, prove, and ship to the user's authorized task.
This skill does not authorize commits, pushes, service installation, publication, or merging by itself.
The user's standing authorization for normal scoped commits, GitHub pushes, and safe completed-worktree cleanup is recorded in `AGENTS.md`.
Apply that authorization without asking for each routine checkpoint, unless a task explicitly overrides it.
For a local-only task, complete local verification and explicitly report that remote CI was not exercised.

## Prepare the work

Read the PRD requirements relevant to the task and the accepted ADRs it depends on.
If an unresolved choice changes shared contracts, resolve it before dependent implementation starts.
An ADR records a decision and its consequences; it is not a standalone worker ticket.
One implementation package can depend on several ADRs, and one ADR can constrain several packages.
For sponsor work, use `docs/integrations/sponsor-contracts.md` and the package details in `docs/implementation/sponsor-integration-plan.md`.
For Jev work, use ADR-0005's API contract and the package plan's J-cases.
For coordinated builds, use `ROADMAP.md` for order and `AGENTS.md` for model roles and permission boundaries.
The coordinator assigns the relevant S-cases and records their evidence mode before dispatch.
Use proof packages to resolve proposed contracts; do not send feature workers to guess around them.

Each package must name:

- The user-visible behavior and stable requirement identifiers it implements.
- Accepted decisions, input and output contracts, and prerequisite packages.
- Owned files, shared-file owner, and files it must not edit.
- Observable success and failure cases, required commands, and evidence to return.
- Its permitted external actions, provider allowance, and isolated test environment.
- The worker and coordinator responsible for CI and review follow-through.

## Isolate

Use the installed Orca orchestration skill and its current coordinator guide when dispatching workers.
Let Orca own managed worktrees; do not create a second worktree inside a managed worker.
Confirm the worker base actually contains its prerequisites, including contracts that may still be uncommitted in the coordinator's checkout.
Do not copy credentials or unrelated changes into a worker.
Assign one owner to shared schemas, contract files, and the lockfile until changes are integrated.
Parallelize packages only when their inputs and file ownership are stable.
Use separate test data, AgentMail project inboxes, browser profiles, and ports where concurrent runs could interfere.
All live hackathon mail still targets the single owner-designated recipient; isolation does not authorize another external address.
Worktrees do not isolate a shared Convex deployment or provider allowance.

## Build

Keep business decisions, durable state changes, and provider mechanics distinguishable.
Convex mutations enforce atomic invariants and authorization; provider adapters perform external calls under the accepted execution contract.
Do not introduce a generic service framework, wrappers, or a queue merely to match a tutorial.
Extract shared code when it removes real duplication or makes a required boundary testable.
Preserve quote versions, source evidence, task authority, and idempotency across retries.
Jev decisions do not replace deterministic permission checks or verification of external effects.

## Prove

Use the PRD's evaluator path and the task's acceptance cases.
For a bug, reproduce the failure before the fix when practical, then demonstrate the changed result.
Run relevant automated checks and inspect the actual UI or runtime boundary.
Include loading, empty, partial, failure, cancellation, and recovery states affected by the task.
Record the commit, environment, inputs, commands, and results.
Label fixture data, injected faults, recorded exchanges, and live provider work separately.
Never present a successful mock as a completed external action.
Capture only the necessary application content and redact secrets or private records.
Do not upload evidence to public hosts, record the whole desktop, or disable a browser sandbox by default.

## Ship and repair within authorized scope

Commit small, coherent checkpoints frequently, push them to the assigned GitHub branch, and verify the remote commit before handoff or completion.
Do not accumulate assigned work only in local commits or wait until an entire large feature is finished before its first push.
Inspect and stage only in-scope files, and preserve unrelated edits and secrets.
When PR creation is authorized, create a ready-for-review PR, not a draft.
List the task's fixed expected check names in the PR and handoff before inspecting results.
Do not remove a check from that set to get a pass.
The current expected checks are `delivery-guard-tests`, `workbench-artifact-tests`, `foundation-typecheck` and `foundation-contract-tests`.
The foundation jobs verify controlled contract proofs; these four jobs do not establish a running application or live integrations.
The application foundation must add and name its actual type, build, unit, integration, and user-path checks as applicable before feature workers rely on CI.

1. Inspect the PR's current head and every reported CI check, not only Greptile.
2. Run `node scripts/check-pr.mjs --repo VasuBansal7576/openingos --pr NUMBER --expect delivery-guard-tests --expect workbench-artifact-tests --expect foundation-typecheck --expect foundation-contract-tests`, adding each agreed application check with another `--expect`.
3. If checks are pending or absent, retain ownership and wait with bounded polling or the available wait mechanism.
4. For a failed check, read its job logs, reproduce at the closest practical boundary, fix the cause within scope, and run the relevant regression test.
5. Push the repair under the standing task authorization, then inspect the new head again; an earlier green commit is not evidence for the new one.
6. Read review bodies, edited bot summaries, inline threads, and ordinary comments with pagination, tied to the current head.
7. Address actionable findings and explain disagreements with evidence; never hide failures or resolve valid findings merely to obtain a score.
8. Re-run the CI inspection after review fixes and immediately before handoff.

A passing helper result means only that the observed CI snapshot passed.
It does not approve the architecture, inspect review threads, prevent a later push, or authorize merging.
If CI cannot be queried, checks never arrive, credentials are absent, or a repair needs broader authority, report the exact blocker instead of marking delivery complete.
Separate pre-existing failures from regressions without treating either as green.

## Greptile

On September 19, 2026, the user's Greptile dashboard showed OpeningOS enabled, automatic reviews on all PR events and status checks enabled.
It showed no completed reviews, and the repository had no PRs, so end-to-end review remains unverified.
Recheck current repository settings and plan allowance at the first authorized PR rather than assuming signup proves review execution.
If the integration is unavailable, report it rather than fabricating a review or score.
Do not enable paid overages or spend beyond the user's plan allowance.
Before requesting a review, check whether the current head already has one running or completed.
Prefer the existing automatic review over duplicate requests.
Limit an automatic repair session to three review rounds by default, then report remaining findings and allowance needs.
Treat confidence scores as review signals, not proof of correctness.
The observed configuration never fails its status check on confidence, so green CI does not replace reading and resolving findings.
When enabled for the task, both the agreed CI checks and the current review findings must be settled before PR delivery is reported complete.

## Keep an owner until the work is settled

The worker owns its implementation and evidence; the coordinator owns the integrated result and latest-head CI follow-through.
If the worker returns before remote checks finish, hand off explicit pending checks and repair ownership.
Follow Orca's inbox, `worker_done`, and terminal lifecycle rules rather than leaving detached workers unaccounted for.
After independent packages are integrated, run the coherent purchasing path against the combined result.
Markdown instructions and a GitHub test workflow do not wake a stopped agent.
An active coordinator can own the loop; unattended repair after it stops requires a separately authorized persistent runner or automation with appropriate credentials and permissions.
Do not claim that background repair is active until its failure-triggered execution has been tested.
After verified delivery and handoff, clean up the assigned task worktree under the checks in `AGENTS.md`.
For Orca-managed resources, settle and release the worker through the documented lifecycle, then use its documented worktree cleanup path and verify removal.
Never assume that releasing a terminal also removed its worktree.
Retain a worktree only when an active owner, pending repair, unpreserved data, or a user instruction requires it, and report the reason and owner.
Do not automatically merge, force-push, remove an active or main checkout, or discard unpreserved work as cleanup.

## Update public progress from verified evidence

In a multi-worker run, the coordinator alone edits root `hackathon.md`.
Workers return the pushed commit, behavior, exact test results, live versus controlled evidence and blockers with their handoff.
After each verified integrated checkpoint, the coordinator loads the hackathon skill and log-format reference, updates the log, scans the whole file for private data and pushes the update.
If `/hackathon` is unavailable, follow the installed skill directly; never run slash-command text as a shell command.
Update README status and setup instructions when those facts change, and repeat the log check before pausing or submission.
An unchanged checkpoint does not need a duplicate entry or timestamp refresh.
Local ignored skill installations are not automatically present in worker worktrees; verify the read path before relying on one.
These instructions define the active coordinator's duties, not a background runner that already exists.

## Provenance

This is an original, project-specific adaptation of Ras Mic's isolate/build/prove/ship workflow.
The source files were inspected at [michaelshimeles/skills, commit 4b72f46](https://github.com/michaelshimeles/skills/tree/4b72f46b045e6fef52e6a98d4c162dd309826aed): `AGENTS.md`, `new-feature`, `code-structure`, `evidence-driven-testing`, `before-and-after`, and `greploop`.
The two linked creator video pages point to that repository; full captions were unavailable during this review.
This adaptation adds latest-head and all-check CI verification, bounded review spending, Orca ownership, Convex-specific boundaries, and explicit evidence privacy.
It does not copy public-upload defaults, destructive cleanup, or unrestricted autonomous shipping from the source workflow.
See [Greptile pricing](https://www.greptile.com/pricing) and [official Greptile skills](https://github.com/greptileai/skills) for current provider behavior.
