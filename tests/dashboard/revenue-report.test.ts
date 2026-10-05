// The revenue report (Q049): the period it reads, the names, the order, and
// one total per currency. The sums are SQL's and are proven in
// revenue-report.integration.test.ts.
import { describe, expect, it } from "vitest";
import { DashboardService, yearToDateFrom } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";

const MONA = "00000000-0000-4000-8000-00000000e001";
const RAVI = "00000000-0000-4000-8000-00000000e002";
const GONE = "00000000-0000-4000-8000-00000000e003";

function world(fiscalYear: number | null = 4) {
  const repo = new FakeDashboardRepo();
  repo.names = [
    { userId: MONA, name: "Mona Manager", activeStaff: true },
    { userId: RAVI, name: "ravi Rao", activeStaff: false },
  ];
  const service = new DashboardService({
    dashboards: repo,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    fiscalYears: new FakeFiscalYearSource(fiscalYear),
    // 00:30 IST on 1 October is still 30 September in UTC.
    clock: new FakeClock(new Date("2026-09-30T19:00:00.000Z")),
  });
  return { repo, service };
}

const row = (userId: string | null, currency: string, invoiced: string) => ({
  scope: "person" as const,
  userId,
  currency,
  invoiced,
  collected: "0",
  outstanding: "0",
  invoices: 1,
});

describe("the revenue report (Q049)", () => {
  it("reads this financial year to date by default, on the firm's day", async () => {
    const w = world(4);
    const r = await w.service.revenueReport("t1", { by: "manager" });
    expect([r.from, r.to, r.asOf]).toEqual(["2026-04-01", "2026-10-01", "2026-10-01"]);
    expect(w.repo.revenueAsked[0]).toMatchObject({ by: "manager", from: "2026-04-01", to: "2026-10-01" });
  });

  it("with no financial year set, the last twelve months", () => {
    expect(yearToDateFrom("2026-10-01", null)).toBe("2025-11-01");
    expect(yearToDateFrom("2026-02-14", 4)).toBe("2025-04-01");
    expect(yearToDateFrom("2026-02-14", 1)).toBe("2026-01-01");
  });

  it("owes at the period's close, never at a day still to come", async () => {
    const w = world();
    const past = await w.service.revenueReport("t1", { by: "manager", from: "2026-04-01", to: "2026-06-30" });
    expect(past.asOf).toBe("2026-06-30");
    const ahead = await w.service.revenueReport("t1", { by: "manager", from: "2026-04-01", to: "2027-03-31" });
    expect(ahead.asOf).toBe("2026-10-01");
  });

  it("names people from the roster, by name, nobody last; one row per currency, never added", async () => {
    const w = world();
    w.repo.personRows.originator = [
      row(null, "INR", "5000.0000"),
      row(MONA, "INR", "100000.0000"),
      row(MONA, "AED", "2000.0000"),
      row(RAVI, "INR", "40000.0000"),
      row(GONE, "INR", "1.0000"),
      { ...row(null, "INR", "145001.0000"), scope: "currency" },
      { ...row(null, "AED", "2000.0000"), scope: "currency" },
    ];
    const r = await w.service.revenueReport("t1", { by: "originator" });
    expect(r.rows.map((x) => [x.name, x.currency])).toEqual([
      ["Mona Manager", "AED"],
      ["Mona Manager", "INR"],
      ["ravi Rao", "INR"],
      [null, "INR"],
      [null, "INR"],
    ]);
    expect(r.rows[2]?.activeStaff).toBe(false);
    expect(r.rows[3]?.userId).toBe(GONE);
    expect(r.rows[4]?.userId).toBeNull();
    expect(r.currencies.map((c) => [c.currency, c.invoiced])).toEqual([
      ["AED", "2000.0000"],
      ["INR", "145001.0000"],
    ]);
  });

  it("passes the company and the currency through", async () => {
    const w = world();
    await w.service.revenueReport("t1", { by: "manager", issuerPartyId: "co-ae", currency: "AED" });
    expect(w.repo.revenueAsked[0]).toMatchObject({ issuerPartyId: "co-ae", currency: "AED" });
  });
});
