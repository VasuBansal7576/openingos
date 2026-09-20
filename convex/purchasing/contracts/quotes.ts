/**
 * F1 immutable quote versions and equivalent-scope comparison
 * (controlled contract, ADR-0003).
 *
 * Quote versions are immutable: revisions create new versions that
 * supersede, never overwrite. Money is integer minor units; unknown
 * charges carry no amount and block any "cheaper" claim. Owner-authored
 * terms keep `counterpartyRole: ownerStandIn` and never overwrite
 * researched vendor facts.
 */

import { mutation, query } from "../../_generated/server";
import { v } from "convex/values";
import { payloadHash } from "../../shared/hashing.js";
import { checkMoney } from "../../shared/money.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../../access/checks.js";

const moneyInputValidator = v.object({ currency: v.string(), minorUnits: v.number() });

const lineValidator = v.object({
  lineId: v.string(),
  description: v.string(),
  quantity: v.string(),
  unitPrice: moneyInputValidator,
  evidenceRefs: v.array(v.object({ sourceId: v.string(), version: v.string(), locator: v.string() })),
});

const chargeValidator = v.object({
  chargeId: v.string(),
  label: v.string(),
  state: v.string(),
  amount: v.optional(moneyInputValidator),
});

/** Record an immutable quote version from bound evidence. */
export const record = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    version: v.string(),
    currency: v.string(),
    lines: v.array(lineValidator),
    charges: v.array(chargeValidator),
    taxBasis: v.string(),
    evidenceRefs: v.array(v.object({ sourceId: v.string(), version: v.string(), locator: v.string() })),
    counterpartyRole: v.string(),
    executionMode: v.union(v.literal("live"), v.literal("recorded"), v.literal("fixture")),
    conversationId: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), quoteId: v.string(), contentHash: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability("quote.record", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    if (!/^[A-Z]{3}$/.test(args.currency)) {
      return { ok: false as const, code: "invalid-payload", message: "currency must be ISO 4217" };
    }
    for (const line of args.lines) {
      try {
        checkMoney(line.unitPrice, `line ${line.lineId}`);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: `line ${line.lineId} is not valid minor-unit money` };
      }
      if (line.unitPrice.currency !== args.currency) {
        return { ok: false as const, code: "invalid-payload", message: `line ${line.lineId} mixes currency` };
      }
    }
    for (const charge of args.charges) {
      if (charge.amount !== undefined) {
        try {
          checkMoney(charge.amount, `charge ${charge.chargeId}`);
        } catch {
          return { ok: false as const, code: "invalid-payload", message: `charge ${charge.chargeId} is not valid minor-unit money` };
        }
      }
      if (charge.state === "unknown" && charge.amount !== undefined) {
        return { ok: false as const, code: "invalid-payload", message: `unknown charge ${charge.chargeId} must not carry an amount` };
      }
    }
    const contentHash = payloadHash({
      version: args.version,
      currency: args.currency,
      lines: args.lines,
      charges: args.charges,
      taxBasis: args.taxBasis,
    });
    const quoteId = await ctx.db.insert("quotes", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      version: args.version,
      contentHash,
      currency: args.currency,
      lines: args.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
      charges: args.charges.map((charge) => ({ ...charge })),
      taxBasis: args.taxBasis,
      evidenceRefs: [...args.evidenceRefs],
      counterpartyRole: args.counterpartyRole,
      executionMode: args.executionMode,
      ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
      createdAt: args.now,
    });
    return { ok: true as const, quoteId: quoteId as unknown as string, contentHash };
  },
});

const compareResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    verdict: v.string(),
    differenceMinorUnits: v.union(v.number(), v.null()),
    cheaper: v.union(v.string(), v.null()),
    reason: v.string(),
  }),
  denialValidator,
);

/** Equivalent-scope comparison; unknown charges block complete claims. */
export const compare = query({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    leftQuoteId: v.string(),
    rightQuoteId: v.string(),
    now: v.number(),
  },
  returns: compareResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const left = (await ctx.db.get(args.leftQuoteId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      currency?: string;
      taxBasis?: string;
      lines?: { unitPrice?: { minorUnits?: number } }[];
      charges?: { state?: string; amount?: { minorUnits?: number } }[];
    } | null;
    const right = (await ctx.db.get(args.rightQuoteId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      currency?: string;
      taxBasis?: string;
      lines?: { unitPrice?: { minorUnits?: number } }[];
      charges?: { state?: string; amount?: { minorUnits?: number } }[];
    } | null;
    if (
      !left || !right ||
      left.organizationId !== args.organizationId || left.projectId !== args.projectId ||
      right.organizationId !== args.organizationId || right.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quotes are not in this project" };
    }
    if (left.currency !== right.currency) {
      return {
        ok: true as const,
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "mixed-currency-requires-accepted-conversion-basis",
      };
    }
    if (left.taxBasis !== right.taxBasis) {
      return {
        ok: true as const,
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "mixed-tax-basis",
      };
    }
    const total = (quote: { lines?: { unitPrice?: { minorUnits?: number } }[]; charges?: { state?: string; amount?: { minorUnits?: number } }[] }): number | null => {
      let sum = 0;
      for (const line of quote.lines ?? []) sum += line.unitPrice?.minorUnits ?? 0;
      for (const charge of quote.charges ?? []) {
        if (charge.state === "unknown") return null;
        if (charge.state === "known" || charge.state === "estimated") {
          if (charge.amount?.minorUnits === undefined) return null;
          sum += charge.amount.minorUnits;
        }
      }
      return sum;
    };
    const leftTotal = total(left);
    const rightTotal = total(right);
    if (leftTotal === null || rightTotal === null) {
      return {
        ok: true as const,
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "unknown-charge-prevents-complete-claim",
      };
    }
    const difference = leftTotal - rightTotal;
    return {
      ok: true as const,
      verdict: "complete",
      differenceMinorUnits: Math.abs(difference),
      cheaper: difference === 0 ? "equal" : difference < 0 ? "left" : "right",
      reason: "equivalent-scope",
    };
  },
});
