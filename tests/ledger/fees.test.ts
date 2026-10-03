// B08 (audit 2026-10-03): which fields of the audit trail are money, and the
// tripwire that keeps the list honest as verbs are added.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MONEY_IN_PAYLOAD, payloadWithoutFees } from "../../src/domain/ledger/fees";
import { EVENT_VERBS } from "../../src/domain/ledger/model";

describe("a payload as a login that cannot see fees reads it", () => {
  it("nulls the verb's money and keeps everything else", () => {
    const seen = payloadWithoutFees("payment.recorded", {
      invoiceId: "i-1",
      invoiceNumber: "INV/2026-27/0001",
      amount: "50000.00",
      currency: "INR",
      method: "bank_transfer",
    });
    expect(seen).toEqual({
      invoiceId: "i-1",
      invoiceNumber: "INV/2026-27/0001",
      amount: null,
      currency: "INR",
      method: "bank_transfer",
    });
  });

  it("nulls rather than drops, and only what the payload has", () => {
    const seen = payloadWithoutFees("billing_due.invoiced", { invoiceId: "i-1", how: "raised", advanceApplied: "500.00" });
    expect("advanceApplied" in seen).toBe(true);
    expect(seen["advanceApplied"]).toBeNull();
    expect("letterAmount" in seen).toBe(false);
  });

  it("leaves a verb with no money, and one it has never heard of, alone", () => {
    const p = { stepKey: "review", from: "ready", to: "done" };
    expect(payloadWithoutFees("job.step_advanced", p)).toEqual(p);
    expect(payloadWithoutFees("not.a_verb", p)).toEqual(p);
  });

  it("does not touch the payload it was given", () => {
    const p = { amount: "1.00" };
    payloadWithoutFees("credit_note.issued", p);
    expect(p.amount).toBe("1.00");
  });

  it("names only verbs the registry has", () => {
    for (const verb of Object.keys(MONEY_IN_PAYLOAD)) {
      expect(Object.keys(EVENT_VERBS), verb).toContain(verb);
    }
  });
});

// ── The tripwire ───────────────────────────────────────────────────────────
//
// Every `recordEvent` in src/ with a literal verb and an inline payload, its
// keys read off the source (the conditional spreads included). A key shaped
// like money must be named for its verb above, or listed here as not money
// with the reason. A new verb carrying an amount fails this until somebody
// decides whether a login without fees may read it.

const MONEY_SHAPED = /amount|value|total|outstanding|remaining|applied|fxrate|price|fee|discount|paid|balance|billed|credited|refund/i;

/** Keys that match the shape and are not money. */
const NOT_MONEY: Readonly<Record<string, string>> = {
  feeGroupId: "an id",
  feeGroupsCopied: "a count",
  discountApproved: "a yes or no: whether a sign-off was given",
  approvedByUserId: "an id",
  previouslyApprovedByUserId: "an id",
  advanceInvoiceId: "an id",
  limitPercent: "the firm's published discount limit, readable on the catalogue",
  fxRateDate: "a date: the day a rate was struck, which the invoice shows to the same login",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "testfakes") sourceFiles(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function payloadKeys(): { verb: string; keys: string[]; where: string }[] {
  const found: { verb: string; keys: string[]; where: string }[] = [];
  for (const file of sourceFiles(join(process.cwd(), "src"))) {
    const s = readFileSync(file, "utf8");
    for (const m of s.matchAll(/verb:\s*"([a-z_]+\.[a-z_]+)"/g)) {
      const at = s.indexOf("payload:", m.index);
      if (at === -1 || at - m.index > 400) continue;
      const open = s.indexOf("{", at);
      if (s.slice(at + "payload:".length, open).trim() !== "") continue;
      let depth = 0;
      let end = open;
      for (; end < s.length; end++) {
        if (s[end] === "{") depth++;
        else if (s[end] === "}" && --depth === 0) break;
      }
      const body = s.slice(open, end + 1);
      const keys = new Set<string>();
      for (const k of body.matchAll(/\b([A-Za-z_]\w*)\s*:/g)) if (k[1] !== undefined) keys.add(k[1]);
      for (const k of body.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*(?=[,}])/g)) if (k[1] !== undefined) keys.add(k[1]);
      found.push({ verb: m[1] ?? "", keys: [...keys], where: file });
    }
  }
  return found;
}

describe("every money-shaped key in a recorded payload is decided", () => {
  const found = payloadKeys();

  it("reads the source at all", () => {
    // A guard on the guard: a regex that stopped matching would pass vacuously.
    expect(found.length).toBeGreaterThan(100);
    expect(found.some((f) => f.verb === "payment.recorded" && f.keys.includes("amount"))).toBe(true);
  });

  it("has no key shaped like money that is neither redacted nor named as not money", () => {
    const named = MONEY_IN_PAYLOAD as Readonly<Record<string, readonly string[] | undefined>>;
    const undecided: string[] = [];
    for (const f of found) {
      for (const key of f.keys) {
        if (!MONEY_SHAPED.test(key) || key in NOT_MONEY) continue;
        if (named[f.verb]?.includes(key) === true) continue;
        undecided.push(`${f.verb}.${key} (${f.where.replace(process.cwd(), "")})`);
      }
    }
    expect(undecided).toEqual([]);
  });
});
