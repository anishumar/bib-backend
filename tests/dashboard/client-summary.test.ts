// The client summary: the period it reads, the account team on each row, and
// the order. The sums are SQL's and are proven in client-summary.integration.test.ts.
import { describe, expect, it } from "vitest";
import { DashboardService } from "../../src/usecase/dashboard/service";
import type { ClientSummaryRow } from "../../src/usecase/dashboard/ports";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";

const KAVERI = "00000000-0000-4000-8000-00000000c001";
const TAPTI = "00000000-0000-4000-8000-00000000c002";
const MONA = "00000000-0000-4000-8000-00000000e001";
const RAVI = "00000000-0000-4000-8000-00000000e002";
const NEHA = "00000000-0000-4000-8000-00000000e003";

function world() {
  const repo = new FakeDashboardRepo();
  const service = new DashboardService({
    dashboards: repo,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    fiscalYears: new FakeFiscalYearSource(4),
    // 00:30 IST on 1 October is still 30 September in UTC.
    clock: new FakeClock(new Date("2026-09-30T19:00:00.000Z")),
  });
  return { repo, service };
}

const row = (r: Partial<ClientSummaryRow>): ClientSummaryRow => ({
  scope: "subject",
  partyId: KAVERI,
  partyName: "Kaveri Foods",
  kind: "service",
  subjectKey: "acc",
  name: "Accounting",
  services: [],
  deptCodes: [],
  currency: "INR",
  billed: "100.0000",
  received: "0.0000",
  tds: "0.0000",
  pending: "100.0000",
  overdue: "0.0000",
  invoices: 1,
  ...r,
});

describe("the client summary", () => {
  it("reads this financial year to date on the firm's day, and today's account team", async () => {
    const w = world();
    const r = await w.service.clientSummary("t1", {});
    expect([r.from, r.to, r.asOf]).toEqual(["2026-04-01", "2026-10-01", "2026-10-01"]);
    expect(w.repo.summaryAsked[0]).toMatchObject({ from: "2026-04-01", to: "2026-10-01", today: "2026-10-01" });
    const past = await w.service.clientSummary("t1", { from: "2026-04-01", to: "2026-06-30", spocUserId: RAVI });
    expect(w.repo.summaryAsked[1]).toMatchObject({ asOf: "2026-06-30", today: "2026-10-01", spocUserId: RAVI });
    expect(past.asOf).toBe("2026-06-30");
  });

  it("puts the Key Manager on the client and the SPOCs of its Depts on each line", async () => {
    const w = world();
    w.repo.summaryRows = [
      row({ deptCodes: ["FRC"] }),
      row({ kind: "section", subjectKey: "g1", name: "Retainer", services: ["Accounting", "Payroll"], deptCodes: ["TRC", "FRC"] }),
      row({ kind: "other", subjectKey: "", name: null }),
      row({ scope: "client", kind: null, subjectKey: null, name: null, billed: "300.0000" }),
      row({ scope: "currency", partyId: null, partyName: null, kind: null, subjectKey: null, name: null, billed: "300.0000" }),
    ];
    w.repo.teams = {
      people: [
        { clientPartyId: KAVERI, role: "key_manager", userId: MONA, name: "Mona", deptCode: null },
        { clientPartyId: KAVERI, role: "key_manager", userId: RAVI, name: "Ravi", deptCode: null },
        { clientPartyId: KAVERI, role: "spoc", userId: RAVI, name: "Ravi", deptCode: "FRC" },
        { clientPartyId: KAVERI, role: "spoc", userId: NEHA, name: "Neha", deptCode: "TRC" },
        { clientPartyId: TAPTI, role: "spoc", userId: MONA, name: "Mona", deptCode: "FRC" },
      ],
      depts: [{ code: "FRC", name: "Financial Reporting" }],
    };
    const r = await w.service.clientSummary("t1", {});
    expect(r.currencies.map((c) => c.billed)).toEqual(["300.0000"]);
    const [kaveri] = r.clients;
    expect(kaveri?.keyManager).toEqual({ userId: MONA, name: "Mona" });
    expect(kaveri?.totals.map((t) => t.billed)).toEqual(["300.0000"]);
    const [acc, section, other] = kaveri?.lines ?? [];
    expect(acc?.spocs.map((s) => s.name)).toEqual(["Ravi"]);
    expect(acc?.depts).toEqual([{ code: "FRC", name: "Financial Reporting" }]);
    expect(section?.spocs.map((s) => `${s.name}:${s.deptCode}`)).toEqual(["Ravi:FRC", "Neha:TRC"]);
    // A Dept the firm has no name for keeps its code.
    expect(section?.depts.map((d) => d.name)).toEqual(["Financial Reporting", "TRC"]);
    expect(other?.spocs).toEqual([]);
  });

  it("orders clients by name, and services before sections, advances and other", async () => {
    const w = world();
    w.repo.summaryRows = [
      row({ partyId: TAPTI, partyName: "tapti Mills", kind: "other", subjectKey: "", name: null }),
      row({ kind: "advance", subjectKey: "", name: null }),
      row({ kind: "section", subjectKey: "g1", name: "A section" }),
      row({ name: "Payroll", subjectKey: "pay", currency: "USD" }),
      row({ name: "Payroll", subjectKey: "pay" }),
      row({ name: "GST", subjectKey: "gst" }),
    ];
    const r = await w.service.clientSummary("t1", {});
    expect(r.clients.map((c) => c.name)).toEqual(["Kaveri Foods", "tapti Mills"]);
    expect(r.clients[0]?.lines.map((l) => `${l.kind}:${l.name ?? ""}:${l.currency}`)).toEqual([
      "service:GST:INR",
      "service:Payroll:INR",
      "service:Payroll:USD",
      "section:A section:INR",
      "advance::INR",
    ]);
    expect(r.clients[1]?.keyManager).toBeNull();
  });
});
