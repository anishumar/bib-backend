// Revenue by manager (auto-invoice T4): what TypeScript decides. The sums are
// SQL's and are proven against a real database in
// `revenue-by-manager.integration.test.ts`; this file proves the window, the
// names, the zeros and the order.
import { describe, expect, it } from "vitest";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { dashboardRoutes } from "../../src/api/handler/dashboard";

const MONA = "00000000-0000-0000-0000-0000000000a1";
const ARJUN = "00000000-0000-0000-0000-0000000000a2";
const GONE = "00000000-0000-0000-0000-0000000000a3";
const STRANGER = "00000000-0000-0000-0000-0000000000a4";

function service(fyStart: number | null = 4) {
  const repo = new FakeDashboardRepo();
  const svc = new DashboardService({
    dashboards: repo,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    fiscalYears: new FakeFiscalYearSource(fyStart),
    // 1 October 00:30 in Kolkata, still 30 September in Greenwich.
    clock: new FakeClock(new Date("2026-09-30T19:00:00Z")),
  });
  return { repo, svc };
}

describe("revenue by manager", () => {
  it("cuts the months on the firm's calendar and says when its financial year starts", async () => {
    const { repo, svc } = service(4);
    const out = await svc.revenueByManager("t1", 3);
    expect(out.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(repo.billingWindows).toEqual([{ from: "2026-08-01", until: "2026-11-01" }]);
    expect(out.financialYearStartMonth).toBe(4);
    expect((await service(null).svc.revenueByManager("t1", 3)).financialYearStartMonth).toBeNull();
  });

  it("names each manager, fills empty months with zero, and keeps a leaver's revenue", async () => {
    const { repo, svc } = service();
    repo.managerRows = [
      { scope: "manager", managerUserId: MONA, month: "2026-09", billed: "50000.0000", collected: "29500.0000", invoices: 2 },
      { scope: "manager", managerUserId: GONE, month: "2026-08", billed: "10000.0000", collected: "0", invoices: 1 },
      { scope: "manager", managerUserId: null, month: "2026-09", billed: "7000.0000", collected: "0", invoices: 1 },
      { scope: "firm", managerUserId: null, month: "2026-08", billed: "10000.0000", collected: "0", invoices: 1 },
      { scope: "firm", managerUserId: null, month: "2026-09", billed: "57000.0000", collected: "29500.0000", invoices: 3 },
    ];
    repo.owedRows = [
      { scope: "manager", managerUserId: MONA, outstanding: "29500.0000", invoices: 1 },
      // Owed now, but nothing in the window: still a row.
      { scope: "manager", managerUserId: ARJUN, outstanding: "11800.0000", invoices: 1 },
      { scope: "firm", managerUserId: null, outstanding: "41300.0000", invoices: 2 },
    ];
    repo.names = [
      { userId: MONA, name: "mona Iyer", activeStaff: true },
      { userId: ARJUN, name: "Arjun Rao", activeStaff: true },
      { userId: GONE, name: "Zubin Shah", activeStaff: false },
    ];
    const out = await svc.revenueByManager("t1", 3);

    // By name, case-blind; the invoices naming nobody last.
    expect(out.managers.map((m) => m.name)).toEqual(["Arjun Rao", "mona Iyer", "Zubin Shah", null]);
    const mona = out.managers.find((m) => m.userId === MONA);
    expect(mona?.months).toEqual([
      { month: "2026-08", billed: "0", collected: "0", invoiceCount: 0 },
      { month: "2026-09", billed: "50000.0000", collected: "29500.0000", invoiceCount: 2 },
      { month: "2026-10", billed: "0", collected: "0", invoiceCount: 0 },
    ]);
    expect(mona).toMatchObject({ outstanding: "29500.0000", outstandingInvoices: 1, activeStaff: true });
    expect(out.managers.find((m) => m.userId === ARJUN)?.months.every((m) => m.billed === "0")).toBe(true);
    expect(out.managers.find((m) => m.userId === GONE)?.activeStaff).toBe(false);
    const nobody = out.managers.at(-1);
    expect(nobody).toMatchObject({ userId: null, name: null, outstanding: "0", outstandingInvoices: 0 });
    expect(nobody?.months[1]?.billed).toBe("7000.0000");

    expect(out.total.months.map((m) => m.billed)).toEqual(["10000.0000", "57000.0000", "0"]);
    expect(out.total).toMatchObject({ outstanding: "41300.0000", outstandingInvoices: 2 });
    // Names asked for the people only, never for "nobody".
    expect(repo.namesAsked[0]?.sort()).toEqual([ARJUN, GONE, MONA].sort());
  });

  it("puts an id the roster cannot name just before the no-manager row", async () => {
    const { repo, svc } = service();
    repo.managerRows = [
      { scope: "manager", managerUserId: STRANGER, month: "2026-10", billed: "1.0000", collected: "0", invoices: 1 },
      { scope: "manager", managerUserId: null, month: "2026-10", billed: "1.0000", collected: "0", invoices: 1 },
      { scope: "manager", managerUserId: MONA, month: "2026-10", billed: "1.0000", collected: "0", invoices: 1 },
    ];
    repo.names = [{ userId: MONA, name: "Mona Iyer", activeStaff: true }];
    const out = await svc.revenueByManager("t1", 1);
    expect(out.managers.map((m) => m.userId)).toEqual([MONA, STRANGER, null]);
    expect(out.managers[1]).toMatchObject({ name: null, activeStaff: false });
  });

  it("answers a firm with nothing billed and nothing owed with zeros, not gaps", async () => {
    const { svc } = service();
    const out = await svc.revenueByManager("t1", 2);
    expect(out.managers).toEqual([]);
    expect(out.total).toEqual({
      months: [
        { month: "2026-09", billed: "0", collected: "0", invoiceCount: 0 },
        { month: "2026-10", billed: "0", collected: "0", invoiceCount: 0 },
      ],
      outstanding: "0",
      outstandingInvoices: 0,
    });
  });

  it("states both definitions where a caller reads them", () => {
    const text = JSON.stringify(dashboardRoutes.revenueByManager);
    for (const phrase of ["ISSUED invoices only", "BEFORE TAX", "credit notes", "COLLECTED", "WITH tax", "negative"]) {
      expect(text).toContain(phrase);
    }
  });
});
