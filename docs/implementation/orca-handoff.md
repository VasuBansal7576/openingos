# Build OpeningOS with Orca

This is the coordinator handoff, not an active orchestration run.
It records the user's requested worker roles and the setup checks observed on September 19, 2026.
Use the installed Orca skill and its version-matched guide before running commands; this document does not replace that guide.

## Readiness and submission checklist

Start with foundation and contract proofs, then continue to the full PRD path.
An early working checkpoint is not the completed product.

| Item | Current evidence | Next owner/action |
| --- | --- | --- |
| Product and design | PRD revision 9, 52 acceptance requirements, selected standalone workbench | Coordinator preserves scope and maps every requirement to implementation evidence |
| Architecture | Accepted workbench/platform constraints; technical ADRs still proposed | F0/F1 test proposals before dependent features freeze shared contracts |
| Repository | Public OpeningOS repository, build log and delivery checks exist | Coordinator pushes checkpoints and owns current-head CI |
| Greptile | OpeningOS enabled; automatic reviews on all PR events; status checks on; 0 reviews observed; no OpeningOS PRs exist | Verify the first authorized ready-for-review PR and its exact head; account signup is not a completed review |
| Convex integration | Codex plugin installed/enabled at 1.10.0; MCP configured; no callable Convex tool in this chat | Fresh worker proves tool availability; foundation later proves hosted read/write/subscription |
| OpenCode integration | OpenCode Go credential entry and requested Muse model listed; no MCP servers configured | Prepare official Convex skills/MCP before backend work; do not copy credentials between workers |
| Local skills | Hackathon and Sites skills exist in the primary checkout, but `.agents/` is Git-ignored | Pass verified skill locations or install through the approved setup path; a new worktree does not inherit ignored files |
| Application access | No deployed app or live provider proof | Privately configure application keys, owner mailbox and spending allowance; coding subscriptions do not replace API access |
| Firecrawl | Connected research tool reported insufficient credits | Verify the application's own key and allowance; confirm participant credits without assuming the two accounts share a balance |
| Supplier market | Prototype uses Netherlands/EUR only as a fixture | Set the actual research country, currency and representative sites before region-specific work |
| Identity/browser/models | Published-origin isolation, hosted Jev browser path and model calibration pending | F0/F1 own these proofs, not individual feature workers making incompatible choices |
| Hosting | `chatgpt.site` selected; no publication | Return tested source to ChatGPT Sites for authorized publish and anonymous public-access check |
| Registration/submission | Registration and eligibility not verified; no live URL, video or announcement yet | User confirms registration/eligibility; coordinator prepares submission evidence and requests external publishing authority |

The [event page](https://www.convex.dev/hackathons/all-gas) and [Luma listing](https://luma.com/convex-allgas-hackathon) require a new eligible app, a public repository, root `hackathon.md`, supported public live URL, real sponsor work and a video under three minutes.
They also require a social announcement tagging Convex, OpenAI, Firecrawl and AgentMail, and submission through the exact event form.
Luma allows solo participation or teams of up to four, with one registration per team.
Verify the participant's eligibility rather than guessing from account details.
The deadline is September 22, 2026 at 12:00 Pacific, or September 23 at 00:30 India Standard Time.
The exact submission page could not be read in this review, so its additional authenticated fields remain unverified.
Recheck them before the deadline at [the event submission form](https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit).

The current [Convex setup instructions](https://www.convex.dev/agent-setup.md) add a later foundation step: once `package.json` includes Convex and its source/config exists, run `npx convex ai-files status` and install missing/stale managed AI files.
Read the generated Convex guidelines completely before backend implementation.
Do not manually reproduce generated sections or run this project step against the current documentation-only repository.
The original setup prompt also requires the Sites skill and a public "Anyone on the internet" site setting before judging.
Native mobile delivery, billing, Convex Auth v2 and the paid AI Gateway are not extra hackathon obligations.

## Requested worker roles

| Role | Tool and exact model | Assignment |
| --- | --- | --- |
| Implementation worker | OpenCode Go, `opencode-go/muse-spark-1.3-contributor` | Independent UI or feature package with owned files and accepted inputs |
| Implementation worker | Codex CLI, `gpt-5.6-luna` | Foundation, backend, integration or test package, depending on dependencies |
| Independent reviewer | Codex CLI, `gpt-6-astra` | Read the actual combined diff and evidence; return findings against a fixed commit |
| Coordinator | The user's chosen Orca coordinator agent | Own dependencies, permissions within scope, integration, CI, log and recovery |

The model IDs were found in the installed OpenCode and Codex catalogs.
That does not prove a billable inference succeeded or that Orca launched either model.
Do not substitute the free Muse provider, another model or a different provider when a requested model is unavailable.
Report the failed lane and continue independent permitted work.
These are development-worker models, not the deployed product's OpenAI/TypeSafe API configuration.

## Preflight before dispatch

1. Read `AGENTS.md`, the delivery skill, PRD, ADR register, sponsor plan and [Jev contract](../integrations/jev-contract.md).
2. Resolve the Orca executable using the installed orchestration skill and read `orca skills get orchestration` from that exact binary.
3. Verify `orca status --json`; a ready graph is necessary, but not proof of worker execution.
4. Inspect the installed worker/model catalogs and relevant auth status without printing keys.
5. Verify the repository, base commit, isolated data/session plan and project-local skills for every worker checkout.
6. Assign F0/F1 ownership and record expected checks, authority, cost limits and pending decisions before feature fan-out.
7. Prove the worker's actual model and an innocuous coordinator question/response round trip before assigning mutating work.

Useful read-only discovery commands are `opencode models`, `codex debug models`, `codex plugin list`, `codex mcp list` and `opencode mcp list`.
Never dump full environment files, auth files or an unfiltered runtime configuration to establish readiness.

The inspected Orca 1.4.205 `worker-start --model` supports Claude, Codex and Cursor, not OpenCode.
For Codex workers, pass the exact requested model and verify `launch.requested` against `launch.effective`.
For Muse, load Orca's `references/low-level-topology.md` and create an explicit OpenCode terminal in its isolated worktree with `opencode --model opencode-go/muse-spark-1.3-contributor`.
After readiness, attach it using `worker-start --terminal <runtime-issued-handle>` so the attempt has supervised lifecycle accounting.
Verify the actual provider/model in that session rather than relying on the terminal title or launch string.
If the installed build cannot supervise the selected terminal, report the incompatibility instead of using an untracked editor or claiming equivalent orchestration.

Do not use `dispatch --inject` as if it provided supervised resource ownership; the inspected guide explicitly says it does not.
No global agent defaults need changing just to select a model for this project.

## Permission ownership

The coordinator handles workers' routine questions and approval requests within the user's authorized task.
Delegation is not authority to approve everything or bypass a tool's own security policy.
Maintain one run-scoped permission record identifying operation, exact target, environment, permitted role and any spending limit.
Redact private values from worker-visible and public evidence.

| Requested action | Coordinator behavior |
| --- | --- |
| Read assigned project files, edit owned files, run local tests, make scoped commits and non-force pushes | Proceed within the task and repository rules |
| Install declared project dependencies or execute project scripts | Inspect the command and scope; permit when part of the authorized build, not arbitrary remote scripts |
| Shared-schema change or another worker's files | Route to the named owner and update the shared contract before dependent edits |
| Provider call or owner email | Require configured credentials, an explicit allowance and the existing application grant; no real-vendor recipients |
| Login, secret entry, new paid service, repository-access grant, public deployment, merge or submission | Obtain user authority unless that exact operation is already explicitly authorized |
| Force push, unpreserved deletion, secret disclosure, vendor outreach or permission bypass | Reject; do not solve a blocked worker by widening its access |

Use the worker's supported native approval mechanism for an actual pending request, scoped to that request.
An Orca `ask`/`reply` answers a worker question; it does not itself approve a Codex sandbox request or an OpenCode permission prompt.
The inspected Orca command schema exposes no verified universal cross-agent approval API, so native permission routing remains a startup proof.
If exact pending requests cannot be inspected and safely answered through the supported mechanism, ask the user once for the missing setup and continue independent work.
Do not send blind "yes" keystrokes, install a wildcard command allowlist, or use dangerous bypass flags.
Codex's inspected CLI offers `--approve-for-me` with a workspace-write sandbox, but this is Codex automatic review, not evidence that Orca is deciding every request.
OpenCode supports scoped `allow`, `ask` and `deny` rules; inspect effective rules because its default permissions are permissive.
Keep high-impact actions gated instead of using OpenCode `--auto`.
Sources: [OpenCode permissions](https://opencode.ai/docs/permissions/), [Codex permissions](https://learn.chatgpt.com/docs/permissions).

## Progress, recovery and review

Follow the existing F0/F1 → R1/C1/U1 → E1/V1 dependency structure, splitting only genuinely independent work.
Keep one owner for shared schemas, dependencies and configuration.
The Astra reviewer does not edit alongside an active implementation worker; the coordinator routes findings back to the owning worker.

Process Orca questions, escalations and `worker_done` messages before acknowledging their delivery.
Use bounded waits and inspect fleet liveness when progress becomes unclear.
No output or a timeout alone is not proof of a dead worker.
For a proven failed or exited attempt, preserve its edits, read the failure evidence and use the documented retry/recovery path.
Do not launch a duplicate editor against an uncertain active attempt.
Correct tests, missing dependencies and ordinary code failures within scope; escalate missing authority, external outage or an unresolved product choice.
Respect Orca's three-failure circuit breaker rather than creating another run to bypass it.

After each push, inspect all expected checks for that exact remote commit and repair failures before declaring delivery complete.
The current checks are `delivery-guard-tests` and `workbench-artifact-tests`; F0 adds actual application checks before feature work depends on them.
Greptile currently reviews on all PR events, with status checks enabled and no confidence threshold failure.
A green Greptile check is therefore not proof that findings were resolved.
Read its current-head summary, edited PR description, review comments and inline threads, then fix or explain each actionable finding.
Do not request a duplicate review while one is already running, and do not enable paid overages.
The first authorized ready-for-review PR is the end-to-end Greptile test, not a throwaway PR opened just to claim setup.

After verified handoff, settle and release worker terminals through Orca.
Terminal release is not worktree removal.
Apply `AGENTS.md`'s clean, remotely preserved, no-active-owner checks before Orca worktree cleanup.
Keep the main checkout, active worktrees and unpreserved files.

## Keep the build log current

The coordinator is the only writer of root `hackathon.md` during a multi-worker run.
Workers return their pushed commit, changed behavior, exact tests, real-versus-controlled evidence and blockers through Orca; they do not append competing log entries.

At each verified integrated checkpoint, the coordinator:

1. Inspects the combined commit and test evidence, including actual provider or deployment evidence where claimed.
2. Loads the installed `convex-hackathon-skill` and its `references/log-format.md` completely.
3. Runs `/hackathon` if available, or follows the skill directly when the slash command is unavailable.
4. Appends only new verified progress, updates header facts supported by code, and scans the entire public log for private data.
5. Updates README setup/status only when those facts changed, commits and pushes the documentation checkpoint, and verifies its CI.

Repeat after a meaningful integration, a verified deployment, and before pausing or submission; do not log every worker keystroke.
No evidence change means no duplicate entry or artificial timestamp refresh.
The coordinator cannot mark an integration checkpoint delivered while its factual log update is missing.
This is an active coordinator responsibility, not a scheduled automation already running in the background.
If the coordinator stops, preserve the run ID, latest pushed checkpoint, pending checks and repair owner for resumption.

## Sites publication handoff

OpenCode and Codex CLI workers build and test local source.
For `chatgpt.site`, the coordinator hands the final pushed commit and verification evidence to the same project in ChatGPT desktop/web with the Sites integration.
Use the installed `codex-sites-convex` skill and current Sites build workflow there.
Do not invent a Sites CLI deploy command or switch hosting to avoid this handoff.
Ask before public publication under the original setup instruction.
Verify anonymous access, the hosted Convex read/write/reactive update, the controlled email path and the exact public URL after publication.
Then update the build log and prepare the video, social post and event submission for the user's authorization.

## Prompt to give the Orca coordinator

Paste the following after opening this repository in Orca.
It starts implementation when the user sends it; writing this document has not started workers.

```text
Build OpeningOS to the complete hackathon requirements in PRD.md using the selected purchasing-workbench design.
Read AGENTS.md, skills/openingos-factory/SKILL.md, docs/adr/README.md, docs/implementation/orca-handoff.md, docs/implementation/sponsor-integration-plan.md and docs/integrations/jev-contract.md first.

Use real supervised Orca orchestration with isolated worktrees and explicit dependencies.
Use OpenCode Go muse-spark-1.3-contributor and Codex CLI gpt-5.6-luna as implementation workers, and Codex CLI gpt-6-astra as the independent reviewer.
Verify effective models and permission routing; do not silently substitute models or use untracked workers.

Start with F0/F1 proofs, resolve routine technical choices with evidence and record the resulting ADR decisions, then continue through all dependent packages and the complete evaluator path.
Keep the ambition and all requirement IDs intact; a prototype or first working slice is not completion.
Handle routine worker permissions, questions, failures and CI repairs within my authorized scope, while asking me for essential product choices, credentials, spending limits, public publishing or other new authority.
Do not bypass security controls or approve blanket access.

Use real application integrations, including the documented TypeSafe Jev endpoint.
All hackathon email must go only to my privately configured mailbox, with me replying as the supplier; never contact real vendors or fake a live response.
Make the coordinator the sole hackathon.md writer and update it from verified worker evidence after each integrated checkpoint.
Commit and push meaningful checkpoints, own all current-head CI and Greptile findings, and clean completed worktrees safely after handoff.
Continue independent work when one lane is blocked, and report the exact blocker rather than inventing success.
Return the tested source to ChatGPT Sites for authorized chatgpt.site publication and final live verification.
```
