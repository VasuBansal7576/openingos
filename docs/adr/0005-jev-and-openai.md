# ADR-0005: Jev-first decisions and OpenAI generation

Status: Proposed; live API access, task thresholds and the OpenAI snapshot remain unverified.
Requirements: H-04, D-02, D-03, D-10, D-11, D-12, D-13, D-17.

## Decision

Use one server-side HTTP adapter in an internal Convex action, shared by research and communication.
Neither this decision nor a coding-agent subscription supplies TypeSafe application API access.

Make Jev the first route for bounded decisions over observed options.
Use it during collection, not merely after extraction.
Start evaluation with pinned `jev-1.13.0`, which the official model page currently lists, and record the actual returned version.
Do not silently use a moving latest alias after calibrating a policy.
The current model consumes text or structured text, so images and scanned documents need a text or vision-extraction stage first.
Source checked September 19, 2026: [TypeSafe models](https://docs.typesafe.ai/models).

| Work | First owner |
| --- | --- |
| Source relevance, tool choice and research priority | Jev choosing among observed permitted options |
| Browser operation and target | Jev plus freshness and target checks in the executor |
| Message class, missing terms, uncertain variant match | Jev; proposed claims still require evidence checks |
| Clarification/negotiation move and recovery choice | Jev within a current grant and explicit action catalog |
| Commercial extraction, document interpretation, drafting and explanation | OpenAI with schema-validated outputs and source locators |
| Arithmetic, identity checks, mandatory approvals and state transitions | Deterministic application code |

Jev does not fetch a page; the selected tool does.
An LLM does not determine whether a payment, binding acceptance or unrestricted action is allowed.

## API contract

F0 owns the transport proof; F1 owns shared validators and the decision policy; R1/C1 consume the same adapter, planned at `convex/models/jev.ts`.
Use `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <TYPESAFE_API_KEY>` and `Content-Type: application/json`.
Keep the key in protected backend configuration, never browser code, Git, logs or worker messages.
Local setup on September 19 created `OpeningOS hackathon` in TypeSafe and saved it in the macOS login Keychain as `OpeningOS TypeSafe`, account `openingos-hackathon`.
This records the credential's location, not its value; configure `TYPESAFE_API_KEY` privately during F0 and prove live access without printing it.
Send `{ model: "jev-1.13.0", state, questions }`; the backend supplies the evidence state and permitted questions, not arbitrary visitor instructions.
Each `questions[id]` uses `type`, `instructions` and its documented schema; a `choice` question maps permitted option IDs to descriptions in `criteria`.
Question IDs correlate answers but do not supply model instructions.
The response contains `model`, `answers` and token counts in `usage.input_tokens` and `usage.output_tokens`.
Choice answers contain `type`, `choice`, `probabilities` and `confidence`; Noul supplies yes-probability in `noul`; Score supplies a rubric score and distribution, not exact arithmetic.

Parse responses from `unknown`; require matching question IDs/types, the pinned model, allowed choices, finite in-range probabilities, complete distributions within tested rounding tolerance and nonnegative integer usage.
Return `decided`, `needsReview`, `unavailable` or `stale`; only a validated, current `decided` result can supply a choice.
Reject missing answers, malformed responses or model drift instead of guessing.
Reserve each attempt through ADR-0004's execution module; use an initial 10-second timeout and at most three total attempts with no workflow or SDK retry multiplier.
For 429/529, use bounded backoff and a valid server retry delay within the deadline; do not retry unchanged authentication, permission or schema failures.
Retain uncertain charges after timeouts and discard cancelled or stale results before applying them through an internal mutation.
Bound input and cost before live calls; the documented request limit is 64k tokens total and 32k for state plus the longest question.
Do not silently truncate decision-critical evidence or enable private-body debug logs.

Source-checked September 19, 2026: [HTTP schema](https://docs.typesafe.ai/api), [model limits](https://docs.typesafe.ai/models), [known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
The optional SDK is not required for this adapter; adopting it needs a tested ADR amendment and disabled hidden retries.
The [package plan's J-01 through J-07](../implementation/sponsor-integration-plan.md#jev-acceptance-cases) prove this contract; all remain pending.
The hosted browser controller still needs ADR-0006's separate compatibility and isolation proof.

## Decision contract

Each request includes decision type, question/policy version, job ID, input version, evidence references, observed candidate IDs and permitted option IDs.
Each result records returned model version, the answer-specific decision fields, latency, actual provider token usage and the original input version.
Record question/policy version and downstream verification; unknown charges stay unknown rather than becoming invented billed usage.
Application code validates the output schema, allowed choice and freshness before applying it.
The independent check records what actually happened after execution.
Do not store private chain-of-thought or treat generated rationales as source evidence.

Batch independent questions about the same snapshot.
Keep dependent decisions sequential and discard stale speculative answers.
An unpublished price or sparse website may trigger inquiry or deferral, not permanent rejection.
Deferred suppliers stay visible and can be reconsidered after a fact changes or the user requests more work.

## Thresholds and fallback

Use a policy keyed by decision type, model version, question version and evaluation set.
Confidence is derived from the returned distribution; it is not proof of correctness.
The vendor explicitly recommends risk-dependent thresholds tested on the application domain.
Source: [TypeSafe confidence](https://docs.typesafe.ai/confidence).

Before calibration, run risky classifications in shadow mode and allow only independently checked, reversible read-only choices.
No model confidence permits an unapproved external effect.
Ambiguous scope classification first uses authorized conversation context and a bounded OpenAI classification fallback; unresolved intent gets one focused question or no action.
Clearly unrelated requests stop, without another model trying to fulfill them.
Relevant unknown supplier facts trigger permitted research or clarification before interrupting the user.

Accept numerical thresholds only after measuring false rejections, unauthorized-operation proposals, wrong model matches and incorrectly deferred suitable suppliers.
Do not insert an arbitrary universal 0.9 threshold into worker contracts.
The active OpeningOS coordinator owns the threshold evaluation and tested OpenAI model selection before dependent execution work; workers do not choose incompatible policies independently.

## Documents and answers

Initially support text PDFs, scanned PDFs/images through the selected OpenAI vision route, and the PRD's structured equipment CSV import.
Retain originals, reject unsupported or oversized input with an explanation, and limit pages/bytes by configured allowance.
Never execute macros or document instructions.
An extracted fact is a proposal until its evidence and required review are satisfied.
Answers receive only authorized current records and cached results keyed by their exact versions.
For the live hackathon negotiation, these records include the owner's actual email replies, labeled as controlled counterparty evidence.
Jev chooses from permitted moves and OpenAI extracts or drafts using the latest reply, not a predetermined demonstration transcript.
A provider outage or unreadable reply produces the documented failure or review state, never a fixture presented as a successful model call.
Neither model may invent the owner's next reply or describe an owner-provided price as a confirmed vendor offer.

## Alternatives and acceptance

One general LLM for every choice adds avoidable latency and generative output where a typed choice suffices.
Jev for every task cannot replace text generation, fetching, arithmetic or verified authority.
The chosen division uses each where it removes work.
Measure matched live tasks, including failures, and report Jev decision latency separately from website and supplier wait time.
No speed claim is accepted solely from an upstream demo.
