/**
 * E6 controlled negotiation-loop direct tests (P-05 / P-23, controlled D-12,
 * controlled J-06 extension; supports P-13 / P-17).
 *
 * Pure vitest boundary tests only: every provider/model outcome is an
 * injected controlled value, the sender is an in-memory controlled stub, and
 * no live transport, model call, or email send is ever invoked. `fetch` is
 * left unstubbed so any attempted live call would throw instead of succeeding.
 */

import { describe, expect, test } from "vitest";
import { JEV_PINNED_MODEL } from "../../proofs/jev/jev-boundary.js";
import {
  applyNegotiationSendOutcome,
  checkNegotiationFences,
  deduplicateNegotiationRetry,
  E6_NEGOTIATION_CORPUS,
  E6_NEGOTIATION_CORPUS_VERSION,
  NEGOTIATION_LOOP_VERSION,
  NEGOTIATION_MOVES,
  NEGOTIATION_OPENAI_MODEL,
  NEGOTIATION_OPERATION_KIND,
  redactForProjection,
  runNegotiationStep,
  scoreE6NegotiationCorpus,
  selectNegotiationMove,
  validateInjectedSendResult,
  validateNegotiationDraft,
  type ControlledNegotiationSender,
  type InjectedDraftResult,
  type InjectedJevResult,
  type MandateSnapshot,
  type NegotiationCurrentSnapshot,
  type NegotiationStepInput,
} from "./negotiationLoop.js";

const OWNER_MAILBOX = "owner-demo@example.invalid";

function mandate(overrides: Partial<MandateSnapshot> = {}): MandateSnapshot {
  return {
    negotiationId: "neg-e6-1",
    organizationId: "org-e6",
    projectId: "proj-e6",
    quoteId: "quote-e6",
    state: "active",
    quoteVersion: "qv-3",
    quoteContentHash: "hash-qv-3",
    conversationId: "conv-e6",
    conversationVersion: 4,
    roundsUsed: 1,
    roundLimit: 3,
    targetMinorUnits: 750000,
    ceilingMinorUnits: 795000,
    expiresAt: 2_000_000,
    ...overrides,
  };
}

function current(overrides: Partial<NegotiationCurrentSnapshot> = {}): NegotiationCurrentSnapshot {
  return {
    now: 1_000_000,
    quoteVersion: "qv-3",
    quoteContentHash: "hash-qv-3",
    quoteSuperseded: false,
    conversationVersion: 4,
    jobState: "running",
    jobCancelled: false,
    grantStatus: "active",
    grantExpiresAt: 2_000_000,
    grantRevocationVersion: 1,
    operationGrantVersion: 1,
    recipientConfigured: true,
    recipientConfigVersion: 7,
    currentRecipientConfigVersion: 7,
    recipientMailboxNormalized: OWNER_MAILBOX,
    allowanceExhausted: false,
    userTakeover: false,
    finalOfferReceived: false,
    ...overrides,
  };
}

function jev(overrides: Partial<InjectedJevResult> = {}): InjectedJevResult {
  return {
    outcome: "decided",
    choice: "clarify",
    model: JEV_PINNED_MODEL,
    inputVersion: "e6-input-v1",
    currentInputVersion: "e6-input-v1",
    ...overrides,
  };
}

function draft(overrides: Partial<InjectedDraftResult> = {}): InjectedDraftResult {
  return {
    outcome: "completed",
    draftKind: "clarify",
    content: "Could you confirm whether freight and installation are included in EUR 7,950?",
    sourceQuoteVersion: "qv-3",
    sourceConversationVersion: 4,
    model: NEGOTIATION_OPENAI_MODEL,
    inputVersion: "e6-input-v1",
    currentInputVersion: "e6-input-v1",
    ...overrides,
  };
}

function stubSender(outcome: "success" | "failure" | "unknown" = "success"): {
  sender: ControlledNegotiationSender;
  calls: number;
} {
  const record = { calls: 0 };
  return {
    calls: record.calls,
    sender: {
      executionMode: "controlled",
      send: () => {
        record.calls += 1;
        return outcome === "success"
          ? { outcome, providerMessageId: "msg-controlled-1" }
          : { outcome, reason: `controlled ${outcome}` };
      },
    },
  };
}

function stepInput(overrides: Partial<NegotiationStepInput> = {}): NegotiationStepInput {
  const stub = stubSender("success");
  return {
    mandate: mandate(),
    current: current(),
    jev: jev(),
    draft: draft(),
    requestId: "req-e6-1",
    prior: null,
    sender: stub.sender,
    ...overrides,
  };
}

describe("E6 permitted move selection", () => {
  test("selects each permitted clarify/counter/hold/stop move from a current decided Jev result", () => {
    for (const move of NEGOTIATION_MOVES) {
      const selected = selectNegotiationMove(jev({ choice: move }));
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.move).toBe(move);
    }
  });

  test("clarify move with a valid draft sends once through the controlled sender and increments rounds", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("sent");
    expect(result.sends).toBe(1);
    expect(stub.sender.executionMode).toBe("controlled");
    if (result.kind === "sent") {
      expect(result.move).toBe("clarify");
      expect(result.roundsUsedAfter).toBe(2);
      expect(result.requestKey).toContain("org-e6");
      expect(result.payloadHash).toMatch(/^[0-9a-f]{16}$/);
      expect(result.lineage.executionMode).toBe("controlled");
      expect(result.lineage.counterpartyRole).toBe("ownerStandIn");
      expect(result.lineage.quoteVersion).toBe("qv-3");
      expect(result.lineage.conversationVersion).toBe(4);
      expect(result.lineage.operationKind).toBe(NEGOTIATION_OPERATION_KIND);
      expect(result.lineage.sendState).toBe("observedSuccess");
      expect(result.lineage.evidenceLabel).toContain("never realized savings");
    }
  });

  test("counter move sends with the same honest lineage", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, jev: jev({ choice: "counter" }), draft: draft({ draftKind: "counter" }) }),
    );
    expect(result.kind).toBe("sent");
    if (result.kind === "sent") {
      expect(result.move).toBe("counter");
      expect(result.roundsUsedAfter).toBe(2);
    }
  });
});

describe("E6 malformed and disallowed Jev answers", () => {
  test("missing choice denies with zero sends", () => {
    const stub = stubSender("success");
    const noChoice: InjectedJevResult = {
      outcome: "decided",
      model: JEV_PINNED_MODEL,
      inputVersion: "e6-input-v1",
      currentInputVersion: "e6-input-v1",
    };
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: noChoice }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
  });

  test("disallowed choice denies with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "accept" }) }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
  });

  test("wrong model version denies with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ model: "jev-latest" }) }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
  });

  test("stale Jev input version waits with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, jev: jev({ inputVersion: "e6-input-v0" }) }),
    );
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("jev-stale");
    expect(result.sends).toBe(0);
  });

  test("needsReview and unavailable Jev outcomes wait with zero sends", () => {
    for (const outcome of ["needsReview", "unavailable"] as const) {
      const stub = stubSender("success");
      const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ outcome }) }));
      expect(result.kind).toBe("waiting");
      expect(result.sends).toBe(0);
    }
  });
});

describe("E6 disclosure redaction", () => {
  test("draft leaking the confidential target figure is denied with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({
        sender: stub.sender,
        draft: draft({ content: "Our walk-away target is 750000 internally." }),
      }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("draft-disclosure-leak");
    expect(result.sends).toBe(0);
  });

  test("draft leaking the ceiling as a major-units amount is denied", () => {
    const checked = validateNegotiationDraft("We can stretch to 7950.00 if needed.", {
      ceilingMinorUnits: 795000,
    });
    expect(checked.ok).toBe(false);
  });

  test("draft leaking the private owner mailbox is denied", () => {
    const checked = validateNegotiationDraft(`Please reply to ${OWNER_MAILBOX} soon.`, {
      ownerMailboxNormalized: OWNER_MAILBOX,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.code).toBe("draft-disclosure-leak");
  });

  test("public projections never carry the mailbox or confidential figures", () => {
    const preview = redactForProjection(`Contact ${OWNER_MAILBOX} about freight.`);
    expect(preview).not.toContain(OWNER_MAILBOX);
    expect(preview).toContain("[redacted-mailbox]");
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    if (result.kind === "sent") {
      expect(result.lineage.redactedPreview).not.toContain(OWNER_MAILBOX);
      expect(JSON.stringify(result.lineage)).not.toContain(OWNER_MAILBOX);
      expect(JSON.stringify(result.lineage)).not.toContain("750000");
      expect(JSON.stringify(result.lineage)).not.toContain("795000");
    } else {
      throw new Error("expected sent lineage for redaction probe");
    }
  });
});

describe("E6 quote and conversation change stops", () => {
  test("changed quote version stops with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ quoteVersion: "qv-4", quoteContentHash: "hash-qv-4" }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-changed");
    expect(result.sends).toBe(0);
  });

  test("superseded quote stops with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ quoteSuperseded: true }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-superseded");
    expect(result.sends).toBe(0);
  });

  test("changed conversation version stops with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ conversationVersion: 5 }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("conversation-changed");
    expect(result.sends).toBe(0);
  });

  test("stale draft basis waits instead of sending against new terms", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, draft: draft({ sourceQuoteVersion: "qv-2" }) }),
    );
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("draft-stale");
    expect(result.sends).toBe(0);
  });
});

describe("E6 mandate expiry, revocation, and terminal stops", () => {
  test("expired mandate stops with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ now: 3_000_000 }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("mandate-expired");
    expect(result.sends).toBe(0);
  });

  test("revoked and concluded mandates stop with zero sends", () => {
    for (const [state, reason] of [
      ["revoked", "mandate-revoked"],
      ["concluded", "mandate-concluded"],
    ] as const) {
      const stub = stubSender("success");
      const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: mandate({ state }) }));
      expect(result.kind).toBe("stopped");
      if (result.kind === "stopped") expect(result.reason).toBe(reason);
      expect(result.sends).toBe(0);
    }
  });

  test("paused mandate waits honestly with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: mandate({ state: "paused" }) }));
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("mandate-paused");
    expect(result.sends).toBe(0);
  });

  test("round limit, final offer, and user takeover stop with zero sends", () => {
    const stoppedCases: Array<{ name: string; input: Partial<NegotiationStepInput> }> = [
      { name: "round-limit", input: { mandate: mandate({ roundsUsed: 3 }) } },
      { name: "final-offer", input: { current: current({ finalOfferReceived: true }) } },
      { name: "user-takeover", input: { current: current({ userTakeover: true }) } },
    ];
    for (const probe of stoppedCases) {
      const stub = stubSender("success");
      const result = runNegotiationStep(stepInput({ sender: stub.sender, ...probe.input }));
      expect(result.kind).toBe("stopped");
      expect(result.sends).toBe(0);
    }
    const limit = runNegotiationStep(stepInput({ mandate: mandate({ roundsUsed: 3 }) }));
    if (limit.kind === "stopped") expect(limit.reason).toBe("round-limit-reached");
    else throw new Error("expected round-limit stop");
  });

  test("Jev stop move stops with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "stop" }) }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("stop-move");
    expect(result.sends).toBe(0);
  });

  test("hold move waits for the owner with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "hold" }) }));
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("waiting-for-owner");
    expect(result.sends).toBe(0);
  });
});

describe("E6 grant and recipient revocation before send", () => {
  test("revoked or expired grant stops with zero sends", () => {
    for (const [grant, reason] of [
      [current({ grantStatus: "revoked" }), "grant-revoked"],
      [current({ grantStatus: "expired" }), "grant-expired"],
    ] as const) {
      const stub = stubSender("success");
      const result = runNegotiationStep(stepInput({ sender: stub.sender, current: grant }));
      expect(result.kind).toBe("stopped");
      if (result.kind === "stopped") expect(result.reason).toBe(reason);
      expect(result.sends).toBe(0);
    }
  });

  test("grant re-issue and recipient change deny with zero sends", () => {
    const versioned = runNegotiationStep(
      stepInput({ current: current({ grantRevocationVersion: 2 }) }),
    );
    expect(versioned.kind).toBe("denied");
    if (versioned.kind === "denied") expect(versioned.code).toBe("grant-version-changed");
    expect(versioned.sends).toBe(0);

    const recipient = runNegotiationStep(
      stepInput({ current: current({ currentRecipientConfigVersion: 8 }) }),
    );
    expect(recipient.kind).toBe("denied");
    if (recipient.kind === "denied") expect(recipient.code).toBe("recipient-changed");
    expect(recipient.sends).toBe(0);

    const missing = runNegotiationStep(stepInput({ current: current({ recipientConfigured: false }) }));
    expect(missing.kind).toBe("denied");
    if (missing.kind === "denied") expect(missing.code).toBe("recipient-missing");
    expect(missing.sends).toBe(0);
  });

  test("cancelled job and exhausted allowance deny with zero sends", () => {
    const cancelled = runNegotiationStep(stepInput({ current: current({ jobCancelled: true }) }));
    expect(cancelled.kind).toBe("denied");
    if (cancelled.kind === "denied") expect(cancelled.code).toBe("job-cancelled");
    expect(cancelled.sends).toBe(0);

    const exhausted = runNegotiationStep(stepInput({ current: current({ allowanceExhausted: true }) }));
    expect(exhausted.kind).toBe("denied");
    if (exhausted.kind === "denied") expect(exhausted.code).toBe("allowance-exhausted");
    expect(exhausted.sends).toBe(0);
  });

  test("fence helper re-checks authority immediately before transition", () => {
    expect(checkNegotiationFences(mandate(), current())).toBe(null);
    const fence = checkNegotiationFences(mandate(), current({ grantStatus: "revoked" }));
    expect(fence?.kind).toBe("stopped");
  });
});

describe("E6 retry idempotency and send outcomes", () => {
  test("identical retry deduplicates without a second send or round", () => {
    const first = runNegotiationStep(stepInput({ requestId: "req-dedup" }));
    expect(first.kind).toBe("sent");
    if (first.kind !== "sent") throw new Error("expected first send");
    let secondCalls = 0;
    const second = runNegotiationStep(
      stepInput({
        requestId: "req-dedup",
        prior: { requestKey: first.requestKey, payloadHash: first.payloadHash },
        sender: {
          executionMode: "controlled",
          send: () => {
            secondCalls += 1;
            return { outcome: "success", providerMessageId: "msg-should-not-send" };
          },
        },
      }),
    );
    expect(second.kind).toBe("deduplicated");
    expect(second.sends).toBe(0);
    expect(secondCalls).toBe(0);
    expect(second.roundsUsedAfter).toBe(1);
    if (second.kind === "deduplicated") expect(second.lineage.sendState).toBe("deduplicated");
  });

  test("changed payload on a reused key conflicts with zero sends", () => {
    const stub = stubSender("success");
    const result = runNegotiationStep(
      stepInput({
        sender: stub.sender,
        requestId: "req-conflict",
        prior: { requestKey: "org-e6|communication.send|req-conflict", payloadHash: "deadbeefdeadbeef" },
      }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("retry-conflict");
    expect(result.sends).toBe(0);
  });

  test("deduplication gate semantics", () => {
    expect(deduplicateNegotiationRetry("k", "h", null).outcome).toBe("proceed");
    expect(deduplicateNegotiationRetry("k", "h", { requestKey: "k", payloadHash: "h" }).outcome).toBe("deduplicated");
    expect(deduplicateNegotiationRetry("k", "h2", { requestKey: "k", payloadHash: "h" }).outcome).toBe("conflict");
  });

  test("unknown transport outcome stays waiting without incrementing rounds", () => {
    const stub = stubSender("unknown");
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("waiting");
    expect(result.sends).toBe(0);
    expect(result.roundsUsedAfter).toBe(1);
    if (result.kind === "waiting") {
      expect(result.reason).toBe("outcome-unknown");
      expect(result.lineage.sendState).toBe("outcomeUnknown");
    }
  });

  test("failed transport stays honest without incrementing rounds", () => {
    const stub = stubSender("failure");
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("waiting");
    expect(result.sends).toBe(0);
    expect(result.roundsUsedAfter).toBe(1);
    if (result.kind === "waiting") {
      expect(result.reason).toBe("send-failure");
      expect(result.lineage.sendState).toBe("observedFailure");
    }
  });

  test("round accounting increments only on observed success", () => {
    expect(applyNegotiationSendOutcome(2, "success")).toMatchObject({
      sendState: "observedSuccess",
      roundsUsedAfter: 3,
      waiting: false,
    });
    expect(applyNegotiationSendOutcome(2, "unknown").roundsUsedAfter).toBe(2);
    expect(applyNegotiationSendOutcome(2, "failure").roundsUsedAfter).toBe(2);
  });

  test("malformed injected provider result denies with zero sends", () => {
    expect(validateInjectedSendResult(null).ok).toBe(false);
    expect(validateInjectedSendResult({ outcome: "delivered" }).ok).toBe(false);
    const stub = stubSender("success");
    void stub;
    const parsed = validateInjectedSendResult({ outcome: "success", providerMessageId: "  " });
    expect(parsed.ok).toBe(false);
  });

  test("non-controlled sender is refused before any invocation", () => {
    let calls = 0;
    const liveLike = {
      executionMode: "live",
      send: () => {
        calls += 1;
        return { outcome: "success" as const, providerMessageId: "msg-live" };
      },
    };
    const result = runNegotiationStep(
      stepInput({ sender: liveLike as unknown as ControlledNegotiationSender }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("live-transport-refused");
    expect(calls).toBe(0);
    expect(result.sends).toBe(0);
  });
});

describe("E6 versioned J-06 corpus extension", () => {
  test("corpus version is pinned and every J-06 category is extended", () => {
    expect(E6_NEGOTIATION_CORPUS_VERSION).toBe("e6-negotiation-corpus-v1");
    const categories = new Set(E6_NEGOTIATION_CORPUS.map((item) => item.j06Category));
    for (const required of ["incomplete-offer", "short-followup", "unrelated", "adversarial", "changed-reply"] as const) {
      expect(categories.has(required)).toBe(true);
    }
    for (const item of E6_NEGOTIATION_CORPUS) {
      expect(item.id).toMatch(/^e6-neg-/);
      expect(item.permittedMoves.length).toBeGreaterThan(0);
    }
  });

  test("in-policy selections score cleanly and out-of-policy selections are reported", () => {
    const clean = scoreE6NegotiationCorpus((choice) => {
      const found = E6_NEGOTIATION_CORPUS.find((item) => item.jevChoice === choice);
      const first = found?.permittedMoves[0];
      return first ?? null;
    });
    expect(clean.evaluated).toBe(E6_NEGOTIATION_CORPUS.length);
    expect(clean.inPolicy).toBe(clean.evaluated);
    expect(clean.outOfPolicy).toEqual([]);

    const rigged = scoreE6NegotiationCorpus(() => "counter");
    expect(rigged.outOfPolicy.length).toBeGreaterThan(0);
    expect(rigged.outOfPolicy).toContain("e6-neg-04");
  });
});

describe("E6 loop metadata and zero-live-transport proof", () => {
  test("loop version is pinned and the operation kind reuses the C1 send path", () => {
    expect(NEGOTIATION_LOOP_VERSION).toBe("e6-negotiation-loop-v1");
    expect(NEGOTIATION_OPERATION_KIND).toBe("communication.send");
    expect(NEGOTIATION_OPENAI_MODEL).toBe("gpt-5.4-mini-2026-03-17");
    expect(JEV_PINNED_MODEL).toBe("jev-1.13.0");
  });

  test("no live fetch exists: every denial and wait in this suite performed zero sends", () => {
    const denials: NegotiationStepInput[] = [
      stepInput({ jev: jev({ choice: "accept" }) }),
      stepInput({ current: current({ grantStatus: "revoked" }) }),
      stepInput({ current: current({ quoteSuperseded: true }) }),
      stepInput({ mandate: mandate({ roundsUsed: 3 }) }),
      stepInput({ draft: draft({ content: `write to ${OWNER_MAILBOX}` }) }),
    ];
    for (const probe of denials) {
      const result = runNegotiationStep(probe);
      expect(result.kind).not.toBe("sent");
      expect(result.sends).toBe(0);
      expect(result.lineage.executionMode).toBe("controlled");
      expect(result.lineage.loopVersion).toBe("e6-negotiation-loop-v1");
    }
  });
});
