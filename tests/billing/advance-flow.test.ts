// The advance and the final bill (auto-invoice, phase 2, 0320), against fakes:
// the advance bill a signed letter owes, the work starting when its invoice is
// paid (or an admin approves a part payment), the one-time service's final bill
// when its job is done, the advance taken off bills first come first served,
// and the leftover given back by a credit note. The SQL half is
// `advance.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { AdvanceBiller, AdvanceGate } from "../../src/usecase/billing/advance";
import { FinalBiller } from "../../src/usecase/billing/final";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import {
  FakeAdvanceBillFacts,
  FakeAutoBillingFirms,
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeBillingSchedules,
  FakeFinalBillFacts,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
  FakeWorkRelease,
} from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeIds } from "../../src/testfakes/ids";
import type { BillingDueRecord, FinalBillSubject, LetterAdvanceFacts } from "../../src/usecase/billing/ports";
import type { Actor } from "../../src/domain/ledger/model";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  AdvanceNotSkippable,
  AutoBillingOff,
  BillNowRefused,
  InvalidBillingInput,
  NothingToRefund,
  StartNotApprovable,
} from "../../src/domain/billing/errors";

const FIRM = "00000000-0000-4000-8000-00000000a001";
const CLIENT = "00000000-0000-4000-8000-00000000a002";
const ISSUER = "00000000-0000-4000-8000-00000000a003";
const LETTER = "00000000-0000-4000-8000-00000000a004";
const AUDIT = "00000000-0000-4000-8000-00000000a005";
const BOOKS = "00000000-0000-4000-8000-00000000a006";
const MANAGER = "00000000-0000-4000-8000-00000000a007";
const KEY_MANAGER = "00000000-0000-4000-8000-00000000a008";
const ADMIN = "00000000-0000-4000-8000-00000000a009";
const SPOC = "00000000-0000-4000-8000-00000000a00a";
const ADV_INVOICE = "00000000-0000-4000-8000-00000000a00b";
const ME: Actor = { type: "human", id: MANAGER };
const ADMIN_ACTOR: Actor = { type: "human", id: ADMIN };

function managers(): FakeBillingManagerFacts {
  const m = new FakeBillingManagerFacts();
  m.spocs.set(`${CLIENT}|FRC`, [{ userId: SPOC, managerUserId: MANAGER, managerName: "Meera" }]);
  m.keyManagers.set(CLIENT, { userId: KEY_MANAGER, displayName: "Kiran" });
  return m;
}

function letterFacts(over: Partial<LetterAdvanceFacts> = {}): LetterAdvanceFacts {
  return {
    letterId: LETTER,
    partyId: CLIENT,
    issuingEntityPartyId: ISSUER,
    currency: "INR",
    signedOn: "2026-10-05",
    advanceRequired: true,
    advanceAmount: "50000.0000",
    advanceRecorded: false,
    lines: [
      { engagementId: AUDIT, status: "pending_advance", advanceAmount: null, deptCode: "FRC" },
      { engagementId: BOOKS, status: "pending_advance", advanceAmount: null, deptCode: "TRC" },
    ],
    ...over,
  };
}

function advanceWorld() {
  const facts = new FakeAdvanceBillFacts();
  const dues = new FakeBillingDueWriter();
  const events = new RecordingEventSink();
  const biller = new AdvanceBiller({ facts, dues, managers: managers(), ids: new FakeIds(), events });
  return { facts, dues, events, biller };
}

describe("the advance bill a signed letter owes", () => {
  it("is one bill for the whole letter, due the day it was signed, with the Key Manager across Depts", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 1 });
    expect(w.dues.dues).toHaveLength(1);
    expect(w.dues.dues[0]).toMatchObject({
      kind: "advance",
      engagementLetterId: LETTER,
      engagementId: null,
      billOn: "2026-10-05",
      fullAmount: "50000.0000",
      servedDays: 1,
      periodDays: 1,
      managerUserId: KEY_MANAGER,
      managerHow: "key_manager",
    });
    expect(w.events.verbs()).toEqual(["billing_due.created"]);
    expect(w.events.recorded[0]?.payload).toMatchObject({ kind: "advance", engagementLetterId: LETTER });
  });

  it("is one bill per service with its own advance, each with its own Dept's manager", async () => {
    const w = advanceWorld();
    w.facts.letters.set(
      `${FIRM}|${LETTER}`,
      letterFacts({
        advanceRequired: false,
        advanceAmount: null,
        lines: [
          { engagementId: AUDIT, status: "pending_advance", advanceAmount: "40000.0000", deptCode: "FRC" },
          { engagementId: BOOKS, status: "active", advanceAmount: null, deptCode: "TRC" },
        ],
      }),
    );
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    expect(w.dues.dues.map((d) => [d.engagementId, d.fullAmount, d.managerUserId])).toEqual([
      [AUDIT, "40000.0000", MANAGER],
    ]);
  });

  it("is written once, however often it is asked", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0 });
    expect(w.events.verbs()).toEqual(["billing_due.created"]);
  });

  it("is not written for an advance recorded by hand before 0320, nor once the work started", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts({ advanceRecorded: true }));
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0 });
    w.facts.letters.set(
      `${FIRM}|${LETTER}`,
      letterFacts({ lines: [{ engagementId: AUDIT, status: "active", advanceAmount: null, deptCode: "FRC" }] }),
    );
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0 });
  });

  it("catches up every firm's letters still owing one, whatever the billing switch says", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    w.facts.owing.set(FIRM, [LETTER]);
    const reports = await w.biller.catchUp();
    expect(reports).toEqual([{ tenantId: FIRM, created: 1 }]);
  });
});

let dueN = 0;
function due(over: Partial<BillingDueRecord> = {}): BillingDueRecord {
  dueN += 1;
  return {
    id: `00000000-0000-4000-8000-0000000e${String(dueN).padStart(4, "0")}`,
    kind: "period",
    engagementLetterId: null,
    party: { id: CLIENT, displayName: "Kaveri Foods" },
    issuer: { id: ISSUER, displayName: "10x Global" },
    currency: "INR",
    engagementId: BOOKS,
    feeGroupId: null,
    engagementIds: [BOOKS],
    serviceName: "Bookkeeping",
    entityName: "Kaveri Foods",
    deptCodes: ["FRC"],
    letter: { id: LETTER, ref: "EL-2026-0007", fxRate: "1.0000000000", fxRateDate: "2026-07-01" },
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    periodLabel: "Oct 2026",
    billOn: "2026-11-01",
    fullAmount: "30000.0000",
    amount: "30000.00",
    servedDays: 31,
    periodDays: 31,
    manager: { userId: MANAGER, displayName: "Meera", email: "meera@example.test" },
    managerHow: "spoc_manager",
    managerNote: null,
    managerReportsTo: null,
    status: "open",
    invoice: null,
    skipped: null,
    lastTaxPercent: "18.00",
    advancePool: null,
    advanceApplied: null,
    released: null,
    ...over,
  };
}

function advanceDue(over: Partial<BillingDueRecord> = {}): BillingDueRecord {
  return due({
    kind: "advance",
    engagementLetterId: LETTER,
    engagementId: null,
    engagementIds: [AUDIT, BOOKS],
    serviceName: "All services",
    periodLabel: "Advance",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-05",
    billOn: "2026-10-05",
    fullAmount: "50000.0000",
    amount: "50000.00",
    servedDays: 1,
    periodDays: 1,
    ...over,
  });
}

function gateWorld() {
  const desk = new FakeBillingDueDesk();
  const work = new FakeWorkRelease();
  const events = new RecordingEventSink();
  const gate = new AdvanceGate({ desk, work, events });
  return { desk, work, events, gate };
}

describe("the work starts when the advance invoice is paid", () => {
  const raised = (over: Partial<BillingDueRecord> = {}) =>
    advanceDue({ invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003", status: "issued" }, ...over });

  it("by itself once the invoice is paid in full, releasing the whole letter's work", async () => {
    const w = gateWorld();
    const adv = raised();
    w.desk.rows.push(adv);
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "59000.00", outstanding: "0.00" });
    expect(await w.gate.moneyMoved(FIRM, ADV_INVOICE, ME)).toEqual({ released: [adv.id] });
    expect(w.work.letters).toEqual([{ letterId: LETTER, byUserId: MANAGER }]);
    expect(w.desk.rows[0]?.released).toMatchObject({ how: "paid" });
    expect(w.events.verbs()).toEqual(["billing_due.advance_released"]);
    expect(w.events.recorded[0]?.payload).toMatchObject({ how: "paid", invoiceId: ADV_INVOICE, engagementLetterId: LETTER });
  });

  it("releases only its own service for a service's advance", async () => {
    const w = gateWorld();
    w.desk.rows.push(raised({ engagementLetterId: LETTER, engagementId: AUDIT, engagementIds: [AUDIT] }));
    w.desk.balances.set(ADV_INVOICE, { invoiced: "47200.00", paid: "47200.00", outstanding: "0.00" });
    await w.gate.moneyMoved(FIRM, ADV_INVOICE, ME);
    expect(w.work.engagements).toEqual([AUDIT]);
    expect(w.work.letters).toEqual([]);
  });

  it("not on a part payment, which waits for an admin", async () => {
    const w = gateWorld();
    w.desk.rows.push(raised());
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "20000.00", outstanding: "39000.00" });
    expect(await w.gate.moneyMoved(FIRM, ADV_INVOICE, ME)).toEqual({ released: [] });
    expect(w.work.letters).toEqual([]);
  });

  it("only once, and only for a person's act", async () => {
    const w = gateWorld();
    w.desk.rows.push(raised());
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "59000.00", outstanding: "0.00" });
    expect(await w.gate.moneyMoved(FIRM, ADV_INVOICE, SYSTEM_ACTOR)).toEqual({ released: [] });
    await w.gate.moneyMoved(FIRM, ADV_INVOICE, ME);
    expect(await w.gate.moneyMoved(FIRM, ADV_INVOICE, ME)).toEqual({ released: [] });
    expect(w.work.letters).toHaveLength(1);
  });

  it("on a part payment when an admin approves the start", async () => {
    const w = gateWorld();
    const adv = raised();
    w.desk.rows.push(adv);
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "20000.00", outstanding: "39000.00" });
    const after = await w.gate.approveStart({ tenantId: FIRM, dueId: adv.id }, ADMIN_ACTOR);
    expect(after.state).toBe("started");
    expect(w.work.letters).toEqual([{ letterId: LETTER, byUserId: ADMIN }]);
    expect(w.desk.rows[0]?.released).toMatchObject({ how: "approved", by: { userId: ADMIN } });
  });

  it("refuses to approve an advance nobody has paid any of, or one already started", async () => {
    const w = gateWorld();
    const adv = raised();
    w.desk.rows.push(adv);
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    await expect(w.gate.approveStart({ tenantId: FIRM, dueId: adv.id }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      StartNotApprovable,
    );
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "20000.00", outstanding: "39000.00" });
    await w.gate.approveStart({ tenantId: FIRM, dueId: adv.id }, ADMIN_ACTOR);
    await expect(w.gate.approveStart({ tenantId: FIRM, dueId: adv.id }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      StartNotApprovable,
    );
  });

  it("lists every advance with where it stands", async () => {
    const w = gateWorld();
    w.desk.rows.push(raised(), advanceDue({ engagementLetterId: "00000000-0000-4000-8000-00000000a0ff" }));
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "20000.00", outstanding: "39000.00" });
    expect((await w.gate.list(FIRM)).map((a) => a.state)).toEqual(["part_paid", "not_raised"]);
  });
});

function oneTime(over: Partial<FinalBillSubject> = {}): FinalBillSubject & { tenantId: string; jobIds: string[] } {
  return {
    tenantId: FIRM,
    jobIds: ["job-1"],
    engagementId: AUDIT,
    feeGroupId: null,
    partyId: CLIENT,
    issuingEntityPartyId: ISSUER,
    currency: "INR",
    billingFrequency: "one_time",
    fullAmount: "100000.0000",
    effectiveFrom: "2026-10-05",
    engagements: [
      { engagementId: AUDIT, status: "active", deptCode: "FRC", job: { status: "done", hasProcess: true, doneOn: "2026-11-20" } },
    ],
    hasFinalBill: false,
    ...over,
  };
}

function finalWorld(on = true) {
  const dues = new FakeBillingDueWriter();
  const facts = new FakeFinalBillFacts(dues);
  const setting = new FakeAutoBillingSetting();
  if (on) void setting.set(FIRM, true);
  const events = new RecordingEventSink();
  const biller = new FinalBiller({
    facts,
    dues,
    managers: managers(),
    setting,
    firms: new FakeAutoBillingFirms(on ? [FIRM] : []),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    ids: new FakeIds(),
    events,
  });
  return { facts, dues, events, biller };
}

describe("a one-time service's final bill", () => {
  it("is written when its job is done, dated the day it finished, for the letter's price", async () => {
    const w = finalWorld();
    w.facts.subjects.push(oneTime());
    expect(await w.biller.jobDone({ tenantId: FIRM, jobId: "job-1" }, SYSTEM_ACTOR)).toEqual({ created: 1 });
    expect(w.dues.dues[0]).toMatchObject({
      kind: "final",
      engagementId: AUDIT,
      billOn: "2026-11-20",
      periodStart: "2026-10-05",
      periodEnd: "2026-11-20",
      periodLabel: "Final",
      fullAmount: "100000.0000",
      managerUserId: MANAGER,
    });
    expect(w.events.recorded[0]?.payload).toMatchObject({ kind: "final" });
  });

  it("is not written while the switch is off, before the job is done, or twice", async () => {
    const off = finalWorld(false);
    off.facts.subjects.push(oneTime());
    expect(await off.biller.jobDone({ tenantId: FIRM, jobId: "job-1" }, SYSTEM_ACTOR)).toEqual({ created: 0 });

    const w = finalWorld();
    w.facts.subjects.push(
      oneTime({
        engagements: [
          { engagementId: AUDIT, status: "active", deptCode: "FRC", job: { status: "running", hasProcess: true, doneOn: null } },
        ],
      }),
    );
    expect(await w.biller.jobDone({ tenantId: FIRM, jobId: "job-1" }, SYSTEM_ACTOR)).toEqual({ created: 0 });
    w.facts.subjects.splice(0, 1, oneTime({ hasFinalBill: true }));
    expect(await w.biller.jobDone({ tenantId: FIRM, jobId: "job-1" }, SYSTEM_ACTOR)).toEqual({ created: 0 });
  });

  it("is caught up by the sweep for a job that finished while nobody listened", async () => {
    const w = finalWorld();
    w.facts.subjects.push(oneTime());
    expect(await w.biller.sweepTenant(FIRM)).toBe(1);
    expect(await w.biller.sweepTenant(FIRM)).toBe(0);
  });

  it("can be asked for now, dated today, where the service has no process", async () => {
    const w = finalWorld();
    w.facts.subjects.push(
      oneTime({ engagements: [{ engagementId: AUDIT, status: "active", deptCode: "FRC", job: { status: "pending", hasProcess: false, doneOn: null } }] }),
    );
    await w.biller.billNow({ tenantId: FIRM, engagementId: AUDIT }, ME);
    expect(w.dues.dues[0]).toMatchObject({ kind: "final", billOn: "2026-12-05", periodEnd: "2026-12-05" });
    expect(await w.biller.candidates(FIRM)).toEqual([]);
  });

  it("refuses Bill it now where a process will bill it, or the switch is off", async () => {
    const w = finalWorld();
    w.facts.subjects.push(
      oneTime({ engagements: [{ engagementId: AUDIT, status: "active", deptCode: "FRC", job: { status: "running", hasProcess: true, doneOn: null } }] }),
    );
    await expect(w.biller.billNow({ tenantId: FIRM, engagementId: AUDIT }, ME)).rejects.toBeInstanceOf(BillNowRefused);
    const off = finalWorld(false);
    off.facts.subjects.push(oneTime({ engagements: [{ engagementId: AUDIT, status: "active", deptCode: "FRC", job: null }] }));
    await expect(off.biller.billNow({ tenantId: FIRM, engagementId: AUDIT }, ME)).rejects.toBeInstanceOf(AutoBillingOff);
  });

  it("offers Bill it now only for one-time work with no process and no final bill", async () => {
    const w = finalWorld();
    w.facts.subjects.push(
      oneTime({ engagements: [{ engagementId: AUDIT, status: "active", deptCode: "FRC", job: null }] }),
      oneTime({ engagementId: BOOKS, engagements: [{ engagementId: BOOKS, status: "active", deptCode: "FRC", job: { status: "running", hasProcess: true, doneOn: null } }] }),
    );
    expect((await w.biller.candidates(FIRM)).map((c) => c.engagementId)).toEqual([AUDIT]);
  });
});

function deskWorld() {
  const desk = new FakeBillingDueDesk();
  const invoices = new FakeInvoiceDrafter();
  const events = new RecordingEventSink();
  const moved: string[] = [];
  const service = new BillingDeskService({
    desk,
    invoices,
    schedules: new FakeBillingSchedules(),
    setting: new FakeAutoBillingSetting(),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
    gate: {
      moneyMoved: (_t, invoiceId) => {
        moved.push(invoiceId);
        return Promise.resolve({ released: [] });
      },
    },
  });
  return { desk, invoices, events, moved, service };
}

const pool = (remaining: string) => ({ invoiceId: ADV_INVOICE, invoiceNumber: "INV/2026-27/0003", remaining });

describe("raising a bill the advance comes off (FIFO, before tax)", () => {
  it("bills the balance and says what came off, in the invoice line", async () => {
    const w = deskWorld();
    const audit = due({ kind: "final", engagementId: AUDIT, engagementIds: [AUDIT], serviceName: "Statutory audit", periodLabel: "Final", fullAmount: "100000.0000", amount: "100000.00", advancePool: pool("50000.00") });
    w.desk.rows.push(audit);
    const out = await w.service.raise({ tenantId: FIRM, dueIds: [audit.id], lines: [{ dueId: audit.id, taxPercent: "18" }] }, ME);
    expect(out.covered).toEqual([]);
    expect(w.invoices.invoices[0]?.lines[0]).toMatchObject({
      unitAmount: "50000.00",
      description: "Statutory audit, final bill: fee INR 1,00,000.00 less advance INR 50,000.00 (INV/2026-27/0003)",
    });
    expect(w.desk.rows[0]?.advanceApplied).toMatchObject({ invoiceId: ADV_INVOICE, amount: "50000.00" });
    expect(w.events.recorded[0]?.payload).toMatchObject({ how: "raised", advanceInvoiceId: ADV_INVOICE, advanceApplied: "50000.00" });
  });

  it("takes the earliest bill first when one raise carries several", async () => {
    const w = deskWorld();
    const oct = due({ advancePool: pool("40000.00") });
    const nov = due({ periodStart: "2026-11-01", periodEnd: "2026-11-30", periodLabel: "Nov 2026", billOn: "2026-12-01", advancePool: pool("40000.00") });
    w.desk.rows.push(oct, nov);
    await w.service.raise({ tenantId: FIRM, dueIds: [nov.id, oct.id], lines: [{ dueId: oct.id, taxPercent: "18" }, { dueId: nov.id, taxPercent: "18" }] }, ME);
    // October is covered in full (no line); November carries the 10,000 balance.
    expect(w.invoices.invoices[0]?.lines.map((l) => l.unitAmount)).toEqual(["20000.00"]);
    expect(w.desk.covered.has(oct.id)).toBe(true);
  });

  it("raises no invoice at all when the advance covers every bill: no number is drawn", async () => {
    const w = deskWorld();
    const oct = due({ advancePool: pool("50000.00") });
    w.desk.rows.push(oct);
    const out = await w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, taxPercent: "18" }] }, ME);
    expect(out).toEqual({ invoiceId: null, number: null, covered: [oct.id], conflicts: [] });
    expect(w.invoices.invoices).toHaveLength(0);
    expect(w.events.verbs()).toEqual(["billing_due.covered"]);
  });

  it("raises an advance on an invoice of its own", async () => {
    const w = deskWorld();
    const adv = advanceDue();
    const oct = due();
    w.desk.rows.push(adv, oct);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [adv.id, oct.id], lines: [{ dueId: adv.id, taxPercent: "18" }, { dueId: oct.id, taxPercent: "18" }] }, ME),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
    await w.service.raise({ tenantId: FIRM, dueIds: [adv.id], lines: [{ dueId: adv.id, taxPercent: "18" }] }, ME);
    expect(w.invoices.invoices[0]?.lines[0]).toMatchObject({ unitAmount: "50000.00", description: "Advance under EL-2026-0007" });
  });

  it("refuses to skip an advance bill, and asks the gate when one is linked", async () => {
    const w = deskWorld();
    const adv = advanceDue();
    w.desk.rows.push(adv);
    await expect(w.service.skip({ tenantId: FIRM, dueId: adv.id, reason: "client paid cash" }, ME)).rejects.toBeInstanceOf(
      AdvanceNotSkippable,
    );
    const { id } = await w.invoices.raise(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      ME,
    );
    await w.service.link({ tenantId: FIRM, dueId: adv.id, invoiceId: id }, ME);
    expect(w.moved).toEqual([id]);
  });
});

describe("giving an unused advance back", () => {
  function candidate(over: { finished?: boolean; remaining?: string } = {}) {
    return {
      advance: advanceDue({ invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003", status: "issued" } }),
      invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003" },
      advanceNet: "50000.00",
      applied: "30000.00",
      remaining: over.remaining ?? "20000.00",
      refundAmount: "23600.00",
      finished: over.finished ?? true,
      waived: null,
    };
  }

  it("lists an advance with some left once the work it covered is finished", async () => {
    const w = deskWorld();
    w.desk.refunds.push(candidate(), candidate({ finished: false }), candidate({ remaining: "0.00" }));
    expect(await w.service.refunds(FIRM)).toHaveLength(1);
  });

  it("gives it back as a credit note with the reason advance_refund, tax included", async () => {
    const w = deskWorld();
    const c = candidate();
    w.desk.refunds.push(c);
    const note = await w.service.refund({ tenantId: FIRM, dueId: c.advance.id }, ME);
    expect(note.number).toBe("CN/2026-27/0001");
    expect(w.invoices.creditNotes).toEqual([
      { invoiceId: ADV_INVOICE, amount: "23600.00", reason: "advance_refund", note: "Advance not used under EL-2026-0007." },
    ]);
  });

  it("refuses while the work goes on, and lets the firm keep it with a reason", async () => {
    const w = deskWorld();
    const going = candidate({ finished: false });
    w.desk.refunds.push(going);
    await expect(w.service.refund({ tenantId: FIRM, dueId: going.advance.id }, ME)).rejects.toBeInstanceOf(NothingToRefund);

    const done = candidate();
    w.desk.refunds.splice(0, 1, done);
    await w.service.keepAdvance({ tenantId: FIRM, dueId: done.advance.id, reason: "Cancellation fee per the letter" }, ME);
    expect(await w.service.refunds(FIRM)).toEqual([]);
    expect(w.events.verbs()).toEqual(["billing_due.refund_kept"]);
  });
});
