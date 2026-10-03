// The overview's ageing and DSO are asked on the FIRM's day (audit 2026-10-03,
// B29). 20:00 UTC on 2 October is 01:30 on the 3rd in Kolkata.
import { describe, expect, it } from "vitest";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";

const FIRM = "00000000-0000-4000-8000-0000000000a1";

describe("the dashboard overview", () => {
  it("asks for ageing and credit sales on the firm's day, not the server's", async () => {
    const repo = new FakeDashboardRepo();
    const svc = new DashboardService({
      dashboards: repo,
      timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
      fiscalYears: new FakeFiscalYearSource(),
      clock: new FakeClock(new Date("2026-10-02T20:00:00.000Z")),
    });
    await svc.overview(FIRM);
    expect(repo.askedOn).toEqual(["2026-10-03", "2026-10-03"]);
  });
});
