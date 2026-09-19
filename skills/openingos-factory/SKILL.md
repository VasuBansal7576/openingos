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
Use separate test data, controlled mail recipients, browser profiles, and ports where concurrent runs could interfere.
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
The initial repository check is `delivery-guard-tests`; it is not an application test suite.
The application foundation must add and name its actual type, build, unit, integration, and user-path checks as applicable before feature workers rely on CI.

1. Inspect the PR's current head and every reported CI check, not only Greptile.
2. Run `node scripts/check-pr.mjs --repo VasuBansal7576/openingos --pr NUMBER --expect delivery-guard-tests`, adding each agreed application check with another `--expect`.
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

Greptile is optional until the user enables the GitHub integration for this repository.
Its absence must be reported, not replaced with a fabricated review or score.
As checked on September 19, 2026, Starter provides one active developer with 50 monthly credits; standard reviews cost one credit and TREX reviews cost three.
Recheck pricing before activation; public commercial source does not establish eligibility for the separate free open-source offering.
Do not enable paid overages or spend beyond the user's plan allowance.
Before requesting a review, check whether the current head already has one running or completed.
Prefer the existing automatic review over duplicate requests.
Limit an automatic repair session to three review rounds by default, then report remaining findings and allowance needs.
Treat confidence scores as review signals, not proof of correctness.
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

## Provenance

This is an original, project-specific adaptation of Ras Mic's isolate/build/prove/ship workflow.
The source files were inspected at [michaelshimeles/skills, commit 4b72f46](https://github.com/michaelshimeles/skills/tree/4b72f46b045e6fef52e6a98d4c162dd309826aed): `AGENTS.md`, `new-feature`, `code-structure`, `evidence-driven-testing`, `before-and-after`, and `greploop`.
The two linked creator video pages point to that repository; full captions were unavailable during this review.
This adaptation adds latest-head and all-check CI verification, bounded review spending, Orca ownership, Convex-specific boundaries, and explicit evidence privacy.
It does not copy public-upload defaults, destructive cleanup, or unrestricted autonomous shipping from the source workflow.
See [Greptile pricing](https://www.greptile.com/pricing) and [official Greptile skills](https://github.com/greptileai/skills) for current provider behavior.
