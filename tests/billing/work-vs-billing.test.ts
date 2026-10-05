// Work vs Billing (Q041): how a job meets its bill, and what is a problem.
// The facts are literal; the clock is 4 Oct 2026, 11:30 in Kolkata.
import { describe, expect, it } from "vitest";
import { WorkBillingService, expectedBill } from "../../src/usecase/billing/work-vs-billing";
import type { WbBill, WbFacts, WbFiling, WbJob, WbSubject } from "../../src/usecase/billing/ports";
import { FakeFiscalYearSource, FakeWorkBillingFacts } from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeClock } from "../../src/testfakes/clock";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const KM = {
  userId: "00000000-0000-4000-8000-0000000000c1",
  displayName: "Kiran",
};
const MGR = {
  userId: "00000000-0000-4000-8000-0000000000c2",
  displayName: "Meera",
};

function subject(over: Partial<WbSubject> = {}): WbSubject {
  return {
    key: `e:${A}`,
    engagementId: A,
    feeGroupId: null,
    party: { id: "p1", displayName: "Acme Pvt Ltd" },
    serviceName: "Monthly bookkeeping",
    entityName: "Acme Pvt Ltd",
    letter: { id: "l1", ref: "EL-2026-0001" },
    frequency: "monthly",
    billingFrom: "2026-07-01",
    firstInvoiceOn: "2026-08-01",
    issuingEntityPartyId: "co-in",
    yearStartMonth: null,
    engagements: [
      {
        engagementId: A,
        status: "active",
        effectiveFrom: "2026-07-01",
        endsOn: null,
        pausedOn: null,
        resumedOn: null,
      },
    ],
    keyManager: KM,
    handInvoices: { count: 0, last: null },
    ...over,
  };
}

function job(over: Partial<WbJob> = {}): WbJob {
  return {
    jobId: "j-sep",
    subjectKey: `e:${A}`,
    sourceKind: "engagement_period",
    status: "done",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    periodLabel: "Sep 2026",
    doneOn: "2026-09-28",
    ...over,
  };
}

function bill(over: Partial<WbBill> = {}): WbBill {
  return {
    id: "b-sep",
    kind: "period",
    subjectKey: `e:${A}`,
    party: { id: "p1", displayName: "Acme Pvt Ltd" },
    serviceName: "Monthly bookkeeping",
    entityName: "Acme Pvt Ltd",
    letter: { id: "l1", ref: "EL-2026-0001" },
    engagementIds: [A],
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    periodLabel: "Sep 2026",
    billOn: "2026-10-01",
    status: "open",
    currency: "INR",
    amount: "25000.00",
    fullAmount: "25000.0000",
    manager: MGR,
    skipped: null,
    invoice: null,
    coveredBy: null,
    ...over,
  };
}

function invoice(over: Partial<NonNullable<WbBill["invoice"]>> = {}): NonNullable<WbBill["invoice"]> {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    number: "INV/2026-27/0001",
    status: "issued",
    issuedOn: "2026-09-05",
    dueOn: "2026-09-20",
    invoiced: "29500.0000",
    paid: "0",
    outstanding: "29500.0000",
    manager: MGR,
    ...over,
  };
}

function filing(over: Partial<WbFiling> = {}): WbFiling {
  return {
    id: "f1",
    subjectKeys: [`e:${A}`],
    name: "GSTR-3B",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    periodLabel: "Sep 2026",
    dueOn: "2026-10-20",
    filedOn: null,
    stateName: "Open",
    filed: false,
    closed: false,
    jobStatus: null,
    ...over,
  };
}

function facts(over: Partial<WbFacts> = {}): WbFacts {
  return {
    autoBilling: true,
    autoBillingSince: "2026-07-01",
    subjects: [subject()],
    bills: [],
    jobs: [],
    filings: [],
    ...over,
  };
}

function service(f: WbFacts, fiscalYear: number | null = 4) {
  const fake = new FakeWorkBillingFacts(f);
  const svc = new WorkBillingService({
    facts: fake,
    fiscalYears: new FakeFiscalYearSource(fiscalYear),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-10-04T06:00:00Z")),
  });
  return { svc, fake };
}

async function rows(f: WbFacts, query = {}, fiscalYear: number | null = 4) {
  return (await service(f, fiscalYear).svc.list("t1", query)).rows;
}

describe("Work vs Billing: a done job with no bill", () => {
  it("names billing not set up, and offers the invoices raised by hand", async () => {
    const [r] = await rows(
      facts({
        subjects: [
          subject({
            billingFrom: null,
            firstInvoiceOn: null,
            handInvoices: {
              count: 2,
              last: {
                invoiceId: "i9",
                number: "INV/2026-27/0007",
                issuedOn: "2026-09-02",
              },
            },
          }),
        ],
        jobs: [job()],
      }),
    );
    expect(r?.flags).toEqual([
      expect.objectContaining({
        code: "no_bill",
        cause: "no_schedule",
        since: "2026-09-30",
        days: 4,
      }),
    ]);
    expect(r?.handInvoices?.last?.number).toBe("INV/2026-27/0007");
    expect(r?.manager).toEqual(KM);
    expect(r?.managerFrom).toBe("key_manager");
  });

  it("names automatic billing off", async () => {
    const [r] = await rows(facts({ autoBilling: false, jobs: [job()] }));
    expect(r?.flags.map((f) => [f.code, f.cause])).toEqual([["no_bill", "auto_billing_off"]]);
  });

  it("says nothing is written when the bill date has passed and the run wrote nothing", async () => {
    const [r] = await rows(
      facts({
        jobs: [
          job({
            jobId: "j-aug",
            periodStart: "2026-08-01",
            periodEnd: "2026-08-31",
            periodLabel: "Aug 2026",
          }),
        ],
      }),
    );
    expect(r?.period?.label).toBe("Aug 2026");
    expect(r?.expectedBillOn).toBe("2026-09-01");
    expect(r?.flags.map((f) => [f.code, f.cause])).toEqual([["no_bill", "not_written"]]);
  });

  it("waits a day for the billing run rather than flagging it", async () => {
    // Sep's bill falls on 1 Oct by the schedule; a day later is the run's.
    const f = facts({
      subjects: [subject({ firstInvoiceOn: "2026-08-03" })],
      jobs: [job()],
    });
    const [r] = await rows(f);
    expect(r?.expectedBillOn).toBe("2026-10-03");
    expect(r?.flags).toEqual([]);
    expect(r?.notes.map((n) => n.code)).toEqual(["billing_run_next"]);
  });

  it("reads the expected bill date from the schedule, never the 1st of next month", () => {
    // A schedule billing on the period's LAST day (Q042) is followed as it is.
    const e = expectedBill(subject({ firstInvoiceOn: "2026-07-31" }), "2026-09-14", 4);
    expect(e).toEqual({
      period: { start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" },
      billOn: "2026-09-30",
    });
  });

  it("shows a job finished mid-period as a bill due, not a problem", async () => {
    const [r] = await rows(
      facts({
        jobs: [
          job({
            jobId: "j-oct",
            periodStart: "2026-10-01",
            periodEnd: "2026-10-31",
            periodLabel: "Oct 2026",
            doneOn: "2026-10-03",
          }),
        ],
      }),
    );
    expect(r?.flags).toEqual([]);
    expect(r?.notes).toEqual([{ code: "bill_due_on", date: "2026-11-01", invoiceNumber: null }]);
  });

  it("does not flag a period before the client's billing began", async () => {
    const [r] = await rows(
      facts({
        jobs: [
          job({
            jobId: "j-jun",
            periodStart: "2026-06-01",
            periodEnd: "2026-06-30",
            periodLabel: "Jun 2026",
          }),
        ],
      }),
    );
    expect(r?.flags).toEqual([]);
    expect(r?.notes.map((n) => [n.code, n.date])).toEqual([["before_billing_start", "2026-07-01"]]);
  });

  it("never flags a period that ended before the go-live month as missed (Q027)", async () => {
    const aug = job({ jobId: "j-aug", periodStart: "2026-08-01", periodEnd: "2026-08-31", periodLabel: "Aug 2026" });
    const [r] = await rows(facts({ autoBillingSince: "2026-09-01", jobs: [aug] }));
    expect(r?.flags).toEqual([]);
    expect(r?.notes.map((x) => [x.code, x.date])).toEqual([["before_auto_billing", "2026-09-01"]]);
    // The same period with go-live in August is billable, and missing.
    const [after] = await rows(facts({ autoBillingSince: "2026-08-01", jobs: [aug] }));
    expect(after?.flags.map((f) => [f.code, f.cause])).toEqual([["no_bill", "not_written"]]);
  });

  it("cannot cut a quarter with no financial year, and says so", async () => {
    const [r] = await rows(
      facts({
        subjects: [subject({ frequency: "quarterly" })],
        jobs: [
          job({
            periodStart: "2026-07-01",
            periodEnd: "2026-09-30",
            periodLabel: "Q2 FY2026-27",
          }),
        ],
      }),
      {},
      null,
    );
    expect(r?.flags.map((f) => [f.code, f.cause])).toEqual([["no_bill", "no_fiscal_year"]]);
  });

  // The sweep cuts a subject's periods on its company's own year, or on the
  // year pinned on the engagement (0337, 0338). Work vs Billing must cut the
  // same periods, or its expected bill is a period the sweep never bills.
  it("cuts a quarter on the issuing company's own year, as the sweep does", async () => {
    const zones = new FakeFirmTimeZone("Asia/Kolkata");
    zones.setCompany("co-in", { fiscalYearStartMonth: 2 });
    const svc = new WorkBillingService({
      facts: new FakeWorkBillingFacts(
        facts({
          subjects: [subject({ frequency: "quarterly" })],
          jobs: [job({ periodStart: "2026-08-01", periodEnd: "2026-10-31", periodLabel: "Q3" })],
        }),
      ),
      fiscalYears: new FakeFiscalYearSource(4),
      timeZones: zones,
      clock: new FakeClock(new Date("2026-10-04T06:00:00Z")),
    });
    const [r] = (await svc.list("t1", {})).rows;
    expect(r?.period).toEqual(expect.objectContaining({ start: "2026-08-01", end: "2026-10-31" }));
  });

  it("keeps the year pinned on the engagement over the company's current one", async () => {
    const [r] = await rows(
      facts({
        subjects: [subject({ frequency: "quarterly", yearStartMonth: 2 })],
        jobs: [job({ periodStart: "2026-08-01", periodEnd: "2026-10-31", periodLabel: "Q3" })],
      }),
    );
    expect(r?.period).toEqual(expect.objectContaining({ start: "2026-08-01", end: "2026-10-31" }));
  });

  it("raises nothing while the work is still going", async () => {
    const [r] = await rows(facts({ jobs: [job({ status: "running", doneOn: null })] }));
    expect(r?.flags).toEqual([]);
    expect(r?.work).toBe("in_progress");
  });
});

describe("Work vs Billing: the bill and its invoice", () => {
  it("shows a skipped bill with its reason and who skipped it", async () => {
    const [r] = await rows(
      facts({
        jobs: [job()],
        bills: [
          bill({
            status: "skipped",
            skipped: {
              at: "2026-10-02T05:00:00.000Z",
              by: MGR,
              reason: "Waived this month",
            },
          }),
        ],
      }),
    );
    expect(r?.flags).toEqual([
      expect.objectContaining({
        code: "skipped",
        reason: "Waived this month",
        by: MGR,
        at: "2026-10-02T05:00:00.000Z",
      }),
    ]);
  });

  it("flags an issued invoice unpaid past its due date, with the days", async () => {
    const [r] = await rows(
      facts({
        jobs: [job()],
        bills: [bill({ status: "billed", invoice: invoice() })],
      }),
    );
    expect(r?.payment).toEqual({
      state: "unpaid",
      dueOn: "2026-09-20",
      daysOverdue: 14,
    });
    expect(r?.flags).toEqual([
      expect.objectContaining({
        code: "unpaid_overdue",
        days: 14,
        since: "2026-09-20",
      }),
    ]);
  });

  it("counts a part payment, and takes an invoice with no terms as due on its date", async () => {
    const [r] = await rows(
      facts({
        jobs: [job()],
        bills: [
          bill({
            status: "billed",
            invoice: invoice({
              dueOn: null,
              paid: "10000.0000",
              outstanding: "19500.0000",
            }),
          }),
        ],
      }),
    );
    expect(r?.payment).toEqual({
      state: "part_paid",
      dueOn: "2026-09-05",
      daysOverdue: 29,
    });
  });

  it("does not flag an unpaid invoice that is not yet due", async () => {
    const [r] = await rows(
      facts({
        jobs: [job()],
        bills: [bill({ status: "billed", invoice: invoice({ dueOn: "2026-10-15" }) })],
      }),
    );
    expect(r?.payment?.daysOverdue).toBe(-11);
    expect(r?.flags).toEqual([]);
  });

  it("NEVER flags a retainer's bill raised while its month's work is open", async () => {
    const [r] = await rows(
      facts({
        jobs: [job({ status: "running", doneOn: null })],
        bills: [
          bill({
            status: "billed",
            invoice: invoice({ paid: "29500.0000", outstanding: "0" }),
          }),
        ],
      }),
    );
    expect(r?.flags).toEqual([]);
    expect(r?.payment?.state).toBe("paid");
    expect(r?.notes.map((n) => n.code)).toEqual(["raised_before_work_done"]);
    expect(r?.jobs.map((j) => j.id)).toEqual(["j-sep"]);
  });

  it("flags a bill past its date that nobody raised, and a missing price", async () => {
    const [r] = await rows(facts({ bills: [bill({ fullAmount: null, amount: null })] }));
    expect(r?.flags.map((f) => [f.code, f.cause, f.days])).toEqual([["not_raised", "no_price", 3]]);
    expect(r?.bill?.priced).toBe(false);
  });

  it("flags a draft left unissued for more than a week, not before", async () => {
    const draft = invoice({ status: "draft", number: null, issuedOn: null });
    const [old] = await rows(
      facts({
        bills: [
          bill({
            status: "drafted",
            billOn: "2026-09-01",
            periodStart: "2026-08-01",
            periodEnd: "2026-08-31",
            periodLabel: "Aug 2026",
            invoice: draft,
          }),
        ],
      }),
    );
    expect(old?.flags.map((f) => f.code)).toEqual(["not_issued"]);
    const [fresh] = await rows(facts({ bills: [bill({ status: "drafted", invoice: draft })] }));
    expect(fresh?.flags).toEqual([]);
  });

  it("names the bill's manager over the Key Manager", async () => {
    const [r] = await rows(facts({ bills: [bill()] }));
    expect(r?.manager).toEqual(MGR);
    expect(r?.managerFrom).toBe("bill");
  });
});

describe("Work vs Billing: one-time work", () => {
  const audit = subject({
    key: `e:${B}`,
    engagementId: B,
    serviceName: "Statutory audit",
    frequency: "one_time",
    billingFrom: null,
    firstInvoiceOn: null,
  });
  const auditJob = job({
    jobId: "j-audit",
    subjectKey: `e:${B}`,
    sourceKind: "engagement",
    periodStart: null,
    periodEnd: null,
    periodLabel: null,
    doneOn: "2026-09-15",
  });

  it("is one row: its job and its final bill, settled", async () => {
    const [r] = await rows(
      facts({
        subjects: [audit],
        jobs: [auditJob],
        bills: [
          bill({
            id: "b-final",
            kind: "final",
            subjectKey: `e:${B}`,
            billOn: "2026-09-15",
            status: "billed",
            invoice: invoice({ paid: "29500.0000", outstanding: "0" }),
          }),
        ],
      }),
    );
    expect(r?.kind).toBe("one_time");
    expect(r?.jobs.map((j) => j.id)).toEqual(["j-audit"]);
    expect(r?.flags).toEqual([]);
    expect(r?.payment?.state).toBe("paid");
  });

  it("flags work done with no final bill, naming why", async () => {
    const [off] = await rows(facts({ autoBilling: false, subjects: [audit], jobs: [auditJob] }));
    expect(off?.flags.map((f) => [f.code, f.cause, f.days])).toEqual([["no_final_bill", "auto_billing_off", 19]]);
    const [before] = await rows(
      facts({
        autoBillingSince: "2026-10-01",
        subjects: [audit],
        jobs: [auditJob],
      }),
    );
    // Finished before the go-live month (Q027): history, a note, never missed.
    expect(before?.flags).toEqual([]);
    expect(before?.notes.map((x) => [x.code, x.date])).toEqual([["before_auto_billing", "2026-10-01"]]);
    const [missing] = await rows(facts({ subjects: [audit], jobs: [auditJob] }));
    expect(missing?.flags.map((f) => f.cause)).toEqual(["not_written"]);
  });

  it("takes an invoice raised by hand as billed", async () => {
    const [r] = await rows(
      facts({
        subjects: [
          {
            ...audit,
            handInvoices: {
              count: 1,
              last: {
                invoiceId: "i1",
                number: "INV/2026-27/0003",
                issuedOn: "2026-09-16",
              },
            },
          },
        ],
        jobs: [auditJob],
      }),
    );
    expect(r?.flags).toEqual([]);
    expect(r?.notes).toEqual([
      {
        code: "billed_by_hand",
        date: "2026-09-16",
        invoiceNumber: "INV/2026-27/0003",
      },
    ]);
  });
});

describe("Work vs Billing: filings, fee groups and the window", () => {
  it("puts a statutory filing under its service's row and never flags it", async () => {
    const [r, ...rest] = await rows(
      facts({
        jobs: [job({ status: "running", doneOn: null })],
        bills: [bill({ status: "billed", invoice: invoice({ dueOn: "2026-10-20" }) })],
        filings: [filing()],
      }),
    );
    expect(rest).toEqual([]);
    expect(r?.filings.map((f) => f.name)).toEqual(["GSTR-3B"]);
    expect(r?.flags).toEqual([]);
  });

  it("puts a quarterly filing under the month its quarter ends in", async () => {
    const out = await rows(
      facts({
        bills: [
          bill({ status: "billed", invoice: invoice({ dueOn: "2026-10-20" }) }),
          bill({
            id: "b-aug",
            periodStart: "2026-08-01",
            periodEnd: "2026-08-31",
            periodLabel: "Aug 2026",
            billOn: "2026-09-01",
            status: "covered",
          }),
        ],
        filings: [
          filing({
            name: "TDS return",
            periodStart: "2026-07-01",
            periodEnd: "2026-09-30",
            periodLabel: "Q2",
          }),
        ],
      }),
    );
    expect(out.find((r) => r.period?.label === "Sep 2026")?.filings.map((f) => f.name)).toEqual(["TDS return"]);
    expect(out.find((r) => r.period?.label === "Aug 2026")?.filings).toEqual([]);
  });

  it("gives a fee group ONE row, with every service's job", async () => {
    const group = subject({
      key: "g:g1",
      engagementId: null,
      feeGroupId: "g1",
      serviceName: "Compliance retainer",
      engagements: [
        {
          engagementId: A,
          status: "active",
          effectiveFrom: "2026-07-01",
          endsOn: null,
          pausedOn: null,
          resumedOn: null,
        },
        {
          engagementId: B,
          status: "active",
          effectiveFrom: "2026-07-01",
          endsOn: null,
          pausedOn: null,
          resumedOn: null,
        },
      ],
    });
    const out = await rows(
      facts({
        subjects: [group],
        bills: [
          bill({
            subjectKey: "g:g1",
            status: "billed",
            invoice: invoice({ dueOn: "2026-10-20" }),
          }),
        ],
        jobs: [
          job({ jobId: "j1", subjectKey: "g:g1" }),
          job({
            jobId: "j2",
            subjectKey: "g:g1",
            status: "running",
            doneOn: null,
          }),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.jobs.map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(out[0]?.serviceName).toBe("Compliance retainer");
  });

  it("opens on twelve months ending today, and drops what is outside", async () => {
    const { svc, fake } = service(
      facts({
        jobs: [
          job({
            jobId: "old",
            periodStart: "2025-09-01",
            periodEnd: "2025-09-30",
            periodLabel: "Sep 2025",
          }),
          job(),
        ],
      }),
    );
    const out = await svc.list("t1", {});
    expect(fake.lastQuery).toEqual({
      from: "2025-11-01",
      to: "2026-10-04",
      partyId: undefined,
      today: "2026-10-04",
    });
    expect(out.rows.map((r) => r.period?.label)).toEqual(["Sep 2026"]);
  });

  it("filters to problems and to one manager, and counts the problems by age", async () => {
    const f = facts({
      jobs: [
        job(),
        job({
          jobId: "j-aug",
          periodStart: "2026-08-01",
          periodEnd: "2026-08-31",
          periodLabel: "Aug 2026",
        }),
      ],
      bills: [
        bill({
          status: "billed",
          invoice: invoice({ paid: "29500.0000", outstanding: "0" }),
        }),
      ],
    });
    const { svc } = service(f);
    const all = await svc.list("t1", {});
    expect(all.rows).toHaveLength(2);
    const problems = await svc.list("t1", { problemsOnly: true });
    expect(problems.rows.map((r) => r.period?.label)).toEqual(["Aug 2026"]);
    expect(problems.summary.byFlag.no_bill).toBe(1);
    expect(problems.summary.unbilledAge).toEqual({
      d0_30: 0,
      d31_60: 1,
      d61_90: 0,
      d90_plus: 0,
    });
    expect(problems.summary.rows).toBe(2);
    const meera = await svc.list("t1", { managerUserId: MGR.userId });
    expect(meera.rows.map((r) => r.period?.label)).toEqual(["Sep 2026"]);
  });
});
