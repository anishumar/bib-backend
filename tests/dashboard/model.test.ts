// The dashboards' pure rules, and the two closed sets written in two places.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGEING_BUCKETS,
  MRR_EXCLUSIONS,
  daysSalesOutstanding,
} from "../../src/domain/dashboard/model";

const MIGRATION = "migrations/0038_dashboard_views.up.sql";

describe("the closed sets agree with the views that produce them", () => {
  // Same instinct as tests/ledger/contract-parity.test.ts: SQL cannot import
  // TypeScript, so the duplication is unavoidable — the DRIFT is not. A bucket
  // the view emits and the type does not know is a row a screen renders as
  // undefined; the reverse is a band that is always empty and looks like good
  // news.
  const sql = readFileSync(MIGRATION, "utf8");

  it("every ageing bucket the view can emit is a known bucket", () => {
    const emitted = [...sql.matchAll(/THEN '([a-z0-9_]+)'\s*$/gm)]
      .map((m) => m[1] as string)
      .filter((v) => v.startsWith("d") || v === "current" || v === "no_due_date");
    expect(emitted.length).toBeGreaterThan(0);
    for (const bucket of emitted) expect(AGEING_BUCKETS).toContain(bucket);
  });

  it("every exclusion reason the view can emit is a known reason", () => {
    for (const reason of MRR_EXCLUSIONS) {
      expect(sql).toContain(`'${reason}'`);
    }
  });
});

describe("days sales outstanding", () => {
  it("is receivables over sales, scaled to the window", () => {
    // 90,000 owed against 180,000 billed in 90 days = 45 days.
    expect(
      daysSalesOutstanding({ receivables: "90000", creditSales: "180000", periodDays: 90 }),
    ).toBe(45);
  });

  it("is NULL when the firm billed nothing — never zero", () => {
    // The whole care in this function. "0 days" reads as excellent collections;
    // the truth is there is not enough billing to say, and a screen has to be
    // able to tell those apart.
    expect(daysSalesOutstanding({ receivables: "5000", creditSales: "0", periodDays: 90 })).toBeNull();
    expect(daysSalesOutstanding({ receivables: "5000", creditSales: "-10", periodDays: 90 })).toBeNull();
  });

  it("is zero when nothing is owed, which is a real answer", () => {
    // Distinct from the case above: the firm billed and collected everything.
    expect(daysSalesOutstanding({ receivables: "0", creditSales: "180000", periodDays: 90 })).toBe(0);
  });

  it("refuses a window that is not a window", () => {
    expect(daysSalesOutstanding({ receivables: "1", creditSales: "1", periodDays: 0 })).toBeNull();
  });

  it("keeps one decimal, because a fraction of a day is noise", () => {
    expect(
      daysSalesOutstanding({ receivables: "12345", creditSales: "54321", periodDays: 90 }),
    ).toBe(20.5);
  });
});
