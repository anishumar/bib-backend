// Billing by company (Wave 5): the month cut, the assembly, and the
// definition the API states. The SUMS are SQL's and are proven against a real
// database in `revenue.integration.test.ts`; this file proves what TypeScript
// decides: which months, in whose calendar, in which currency, and that a
// month with nothing in it is a zero rather than a gap.
import { describe, expect, it } from "vitest";
import { billingWindow } from "../../src/domain/dashboard/model";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { dashboardRoutes } from "../../src/api/handler/dashboard";

describe("the billing window", () => {
  it("is the last N calendar months, oldest first, ending with today's", () => {
    const w = billingWindow("2026-09-29", 12);
    expect(w.months).toEqual([
      "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    expect(w.from).toBe("2025-10-01");
    // Exclusive: the first day AFTER the window, so no month length is needed.
    expect(w.until).toBe("2026-10-01");
  });

  it("steps back over a year boundary and forward over December", () => {
    expect(billingWindow("2026-02-10", 3)).toEqual({
      months: ["2025-12", "2026-01", "2026-02"],
      from: "2025-12-01",
      until: "2026-03-01",
    });
    expect(billingWindow("2026-12-31", 1)).toEqual({
      months: ["2026-12"],
      from: "2026-12-01",
      until: "2027-01-01",
    });
  });

  it("refuses a day that is not one, and a window of no months", () => {
    expect(() => billingWindow("2026-9-1", 12)).toThrow(RangeError);
    expect(() => billingWindow("2026-09-01", 0)).toThrow(RangeError);
  });
});

function service(zone: string, instant: string) {
  const repo = new FakeDashboardRepo();
  const svc = new DashboardService({
    dashboards: repo,
    timeZones: new FakeFirmTimeZone(zone),
    clock: new FakeClock(new Date(instant)),
  });
  return { repo, svc };
}

describe("the month is the FIRM's, not the server's", () => {
  // 30 September 19:00 UTC is 1 October 00:30 in Kolkata. A firm in India
  // opening its numbers then is in OCTOBER; the server's UTC day says
  // September, and a window cut on it would end a month early.
  const instant = "2026-09-30T19:00:00Z";

  it("ends the window in October for a firm in India", async () => {
    const { repo, svc } = service("Asia/Kolkata", instant);
    const out = await svc.revenueByCompany("t1", 3);
    expect(out.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(repo.billingWindows).toEqual([{ from: "2026-08-01", until: "2026-11-01" }]);
  });

  it("ends it in September for a firm on UTC", async () => {
    const { svc } = service("UTC", instant);
    const out = await svc.revenueByCompany("t1", 3);
    expect(out.months).toEqual(["2026-07", "2026-08", "2026-09"]);
  });
});

describe("assembling the answer", () => {
  it("bills each company in its own currency and fills an empty month with zero", async () => {
    const { repo, svc } = service("Asia/Kolkata", "2026-09-29T06:00:00Z");
    repo.currency = "INR";
    repo.companies = [
      { partyId: "in", name: "India Co", jurisdiction: "IN" },
      { partyId: "ae", name: "Gulf Co", jurisdiction: "AE" },
      { partyId: "xx", name: "Nowhere Co", jurisdiction: null },
    ];
    repo.billingRows = [
      { partyId: "in", month: "2026-09", billed: "15000.0000", billedReporting: "15000.0000", invoices: 1, otherCurrencyInvoices: 0 },
      { partyId: "ae", month: "2026-09", billed: "1000.0000", billedReporting: "30800.0000", invoices: 1, otherCurrencyInvoices: 1 },
      { partyId: null, month: "2026-09", billed: null, billedReporting: "45800.0000", invoices: 2, otherCurrencyInvoices: 1 },
    ];
    const out = await svc.revenueByCompany("t1", 2);

    // D1's table decides the currency; no registration is the firm's own.
    expect(repo.billingOwns[0]).toEqual([
      { partyId: "in", currency: "INR" },
      { partyId: "ae", currency: "AED" },
      { partyId: "xx", currency: "INR" },
    ]);
    expect(out.companies.map((c) => c.currency)).toEqual(["INR", "AED", "INR"]);

    const india = out.companies[0];
    expect(india?.months).toEqual([
      // August had nothing: a zero, not a missing month.
      { month: "2026-08", billed: "0", billedReporting: "0", invoiceCount: 0 },
      { month: "2026-09", billed: "15000.0000", billedReporting: "15000.0000", invoiceCount: 1 },
    ]);
    expect(out.companies[1]?.otherCurrencyInvoices).toBe(1);
    expect(out.companies[2]?.months.every((m) => m.billed === "0")).toBe(true);

    // The whole firm: every document, counted whatever its currency.
    expect(out.total).toEqual([
      { month: "2026-08", billedReporting: "0", invoiceCount: 0 },
      { month: "2026-09", billedReporting: "45800.0000", invoiceCount: 3 },
    ]);
    expect(out.reportingCurrency).toBe("INR");
  });
});

describe("the definition is stated where a caller reads it", () => {
  it("says issued only, by issue month, before tax, less credit notes", () => {
    const text = JSON.stringify(dashboardRoutes.revenueByCompany);
    for (const phrase of ["ISSUED invoices only", "issue date", "BEFORE TAX", "credit notes"]) {
      expect(text).toContain(phrase);
    }
  });
});
