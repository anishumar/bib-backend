// The advance and the final bill (auto-invoice, phase 2, 0320; 0322), against
// fakes: the advance bill a signed letter owes and its invoice drafted at once,
// the catch-up that starts work signed before 0322, where each advance stands
// and who is reminded, the weekly summary to the admins, the one-time service's
// final bill when its job is done, the advance taken off bills first come first
// served, and the leftover given back by a credit note. The SQL half is
// `advance.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { AdvanceBiller, AdvanceDesk, AdvanceDigest } from "../../src/usecase/billing/advance";
import { FinalBiller } from "../../src/usecase/billing/final";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import {
  FakeAdvanceBillFacts,
  FakeAdvanceDigestStore,
  FakeAdvanceDrafter,
  FakeAdvancePolicy,
  FakeAdvanceReminderFacts,
  FakeAutoBillingFirms,
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingDueWriter,
  FakeBillingMailer,
  FakeBillingManagerFacts,
  FakeBillingSchedules,
  FakeFinalBillFacts,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
  FakeIssuerTaxDefaults,
  FakeWorkRelease,
} from "../../src/testfakes/billing";
import { FakeFirmEntities } from "../../src/testfakes/invoice";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeIds } from "../../src/testfakes/ids";
import type { BillingDueRecord, FinalBillSubject, LetterAdvanceFacts, PersonRef } from "../../src/usecase/billing/ports";
import type { Actor } from "../../src/domain/ledger/model";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  AdvanceLinkNeedsAdmin,
  AdvanceNotSkippable,
  AutoBillingOff,
  BillBusy,
  BillNowRefused,
  InvalidBillingInput,
  InvoiceDoesNotFitDue,
  NothingToRefund,
  PriceNotVisible,
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
const PARTNER = "00000000-0000-4000-8000-00000000a00c";
const STRANGER = "00000000-0000-4000-8000-00000000a00d";
const ME: Actor = { type: "human", id: MANAGER };
const ADMIN_ACTOR: Actor = { type: "human", id: ADMIN };

const person = (userId: string, name: string): PersonRef => ({ userId, displayName: name, email: `${name.toLowerCase()}@example.test` });

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
    // Since 0322 every engagement a signature creates starts active.
    lines: [
      { engagementId: AUDIT, status: "active", advanceAmount: null, deptCode: "FRC" },
      { engagementId: BOOKS, status: "active", advanceAmount: null, deptCode: "TRC" },
    ],
    ...over,
  };
}

function advanceWorld() {
  const dues = new FakeBillingDueWriter();
  const facts = new FakeAdvanceBillFacts(dues);
  const events = new RecordingEventSink();
  const drafter = new FakeAdvanceDrafter(facts);
  const work = new FakeWorkRelease();
  const biller = new AdvanceBiller({ facts, dues, managers: managers(), ids: new FakeIds(), events, drafter, work });
  return { facts, dues, events, drafter, work, biller };
}

describe("the advance bill a signed letter owes, and its draft (0322)", () => {
  it("is one bill for the whole letter, due the day it was signed, with the Key Manager across Depts", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 1, drafted: 1 });
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

  it("drafts the advance invoice at once, as whoever signed it (Ashish: created as a draft invoice)", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, ME);
    expect(w.drafter.asked).toEqual([{ dueId: w.dues.dues[0]?.id, actor: ME }]);
  });

  it("is one bill per service with its own advance, each with its own Dept's manager, on work already started", async () => {
    const w = advanceWorld();
    w.facts.letters.set(
      `${FIRM}|${LETTER}`,
      letterFacts({
        advanceRequired: false,
        advanceAmount: null,
        lines: [
          { engagementId: AUDIT, status: "active", advanceAmount: "40000.0000", deptCode: "FRC" },
          { engagementId: BOOKS, status: "active", advanceAmount: null, deptCode: "TRC" },
        ],
      }),
    );
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    expect(w.dues.dues.map((d) => [d.engagementId, d.fullAmount, d.managerUserId])).toEqual([
      [AUDIT, "40000.0000", MANAGER],
    ]);
  });

  it("is written and drafted once, however often it is asked", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0, drafted: 0 });
    expect(w.events.verbs()).toEqual(["billing_due.created"]);
    expect(w.drafter.asked).toHaveLength(1);
  });

  it("is not written for an advance recorded by hand before 0320, nor for work called off", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts({ advanceRecorded: true }));
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0, drafted: 0 });
    w.facts.letters.set(
      `${FIRM}|${LETTER}`,
      letterFacts({
        advanceRequired: false,
        advanceAmount: null,
        lines: [{ engagementId: AUDIT, status: "cancelled", advanceAmount: "40000.0000", deptCode: "FRC" }],
      }),
    );
    expect(await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).toEqual({ created: 0, drafted: 0 });
  });

  it("keeps the bill when the draft cannot be made, and never fails for it", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    // No tax rate to draft it with: the bill waits on To raise.
    w.drafter.blocks.set("00000000-0000-4000-8000-000000000001", "no_tax_rate");
    const first = await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    expect(first.created).toBe(1);
    // The fake ids are deterministic; whichever id it got, a failing raise is
    // swallowed too.
    const id = w.dues.dues[0]?.id ?? "";
    w.drafter.blocks.delete("00000000-0000-4000-8000-000000000001");
    w.drafter.failing.add(id);
    w.facts.drafted.delete(id);
    await expect(w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR)).resolves.toMatchObject({ drafted: 0 });
  });

  it("catches up every firm: starts work signed before 0322, writes the bill and drafts it", async () => {
    const w = advanceWorld();
    w.facts.letters.set(
      `${FIRM}|${LETTER}`,
      letterFacts({
        lines: [
          { engagementId: AUDIT, status: "pending_advance", advanceAmount: null, deptCode: "FRC" },
          { engagementId: BOOKS, status: "pending_advance", advanceAmount: null, deptCode: "TRC" },
        ],
      }),
    );
    w.facts.owing.set(FIRM, [LETTER]);
    w.work.waiting.set(LETTER, 2);
    expect(await w.biller.catchUp()).toEqual([{ tenantId: FIRM, created: 1, drafted: 1, started: 2 }]);
    expect(w.work.letters).toEqual([LETTER]);
    // The work was started first, by the system.
    expect(w.drafter.asked[0]?.actor).toEqual(SYSTEM_ACTOR);
  });

  it("drafts on the catch-up a bill that could not be drafted before (a tax rate set since)", async () => {
    const w = advanceWorld();
    w.facts.letters.set(`${FIRM}|${LETTER}`, letterFacts());
    const id = "00000000-0000-4000-8000-000000000001";
    w.drafter.blocks.set(id, "no_tax_rate");
    await w.biller.billAdvances({ tenantId: FIRM, letterId: LETTER }, SYSTEM_ACTOR);
    w.drafter.blocks.clear();
    w.facts.owing.set(FIRM, [LETTER]);
    expect(await w.biller.catchUp()).toEqual([{ tenantId: FIRM, created: 0, drafted: 1, started: 0 }]);
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
    advanceHoldsWork: false,
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
    deptCodes: ["FRC"],
    ...over,
  });
}

/** A firm on 14 October 2026 (Kolkata), nine days after the letter was signed. */
function reminderWorld(now = "2026-10-14T06:00:00.000Z") {
  const desk = new FakeBillingDueDesk();
  const policy = new FakeAdvancePolicy();
  const people = new FakeAdvanceReminderFacts();
  people.spocs.set(`${CLIENT}|FRC`, [person(SPOC, "Sonal")]);
  people.keyManagers.set(CLIENT, person(KEY_MANAGER, "Kiran"));
  people.partners.set(CLIENT, person(PARTNER, "Pooja"));
  people.adminList.push({ ...person(ADMIN, "Ashish"), seesFees: true }, { ...person(STRANGER, "Sam"), seesFees: false });
  const taxDefaults = new FakeIssuerTaxDefaults();
  const clock = new FakeClock(new Date(now));
  const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
  const advances = new AdvanceDesk({ desk, policy, people, taxDefaults, timeZones, clock });
  return { desk, policy, people, taxDefaults, clock, timeZones, advances };
}

describe("where an advance stands, and who is reminded (0322)", () => {
  const drafted = (over: Partial<BillingDueRecord> = {}) =>
    advanceDue({ invoice: { id: ADV_INVOICE, number: null, status: "draft" }, ...over });
  const issued = (over: Partial<BillingDueRecord> = {}) =>
    advanceDue({ invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003", status: "issued" }, ...over });

  it("a draft: waiting for an admin to issue it since signing, overdue after the firm's 3 days", async () => {
    const w = reminderWorld();
    w.desk.rows.push(drafted());
    const [a] = (await w.advances.list(FIRM)).advances;
    expect(a).toMatchObject({
      stage: "on_draft",
      reminder: { pending: true, pendingSince: "2026-10-05", daysPending: 9, overdue: true, escalated: true },
      people: { spocs: [{ userId: SPOC }], keyManager: { userId: KEY_MANAGER }, partner: { userId: PARTNER } },
      draftBlocked: null,
    });
    // The partner is found at the firm's own grade.
    expect(w.people.askedRanks).toEqual([9]);
  });

  it("unpaid counts from the issue: not overdue until the firm's 15 days", async () => {
    const w = reminderWorld();
    w.desk.rows.push(issued());
    w.desk.issuedOn.set(ADV_INVOICE, "2026-10-07");
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    const [a] = (await w.advances.list(FIRM)).advances;
    expect(a).toMatchObject({ stage: "unpaid", reminder: { pendingSince: "2026-10-07", daysPending: 7, overdue: false } });
  });

  it("paid, or skipped, is not chased", async () => {
    const w = reminderWorld();
    w.desk.rows.push(
      issued(),
      advanceDue({ engagementLetterId: "00000000-0000-4000-8000-00000000a0ee", skipped: { at: "2026-10-06T00:00:00.000Z", by: null, reason: "Waived" } }),
    );
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "59000.00", outstanding: "0.00" });
    expect((await w.advances.list(FIRM)).advances.map((a) => [a.stage, a.reminder.pending])).toEqual([
      ["paid", false],
      ["not_raised", false],
    ]);
  });

  it("says why there is no invoice: no tax rate, or an invoice raised by hand already bills it", async () => {
    const w = reminderWorld();
    const noRate = advanceDue({ lastTaxPercent: null });
    const byHand = advanceDue({ engagementLetterId: "00000000-0000-4000-8000-00000000a0ee", lastTaxPercent: null });
    w.desk.rows.push(noRate, byHand);
    w.desk.handRaised.set(byHand.id, { invoiceId: "00000000-0000-4000-8000-00000000a0f1", number: "INV/2026-27/0001" });
    expect((await w.advances.list(FIRM)).advances.map((a) => a.draftBlocked)).toEqual(["no_tax_rate", "billed_by_hand"]);
    // A default tax rate for the company is enough to draft it.
    w.taxDefaults.rates.set(ISSUER, "18");
    expect((await w.advances.list(FIRM)).advances.map((a) => a.draftBlocked)).toEqual([null, "billed_by_hand"]);
  });

  it("is on My day for the SPOC, the Key Manager and the partner, each with why", async () => {
    const w = reminderWorld();
    w.desk.rows.push(drafted());
    for (const [who, duty] of [
      [SPOC, "spoc"],
      [KEY_MANAGER, "key_manager"],
      [PARTNER, "partner"],
    ] as const) {
      expect((await w.advances.mine(FIRM, who, false)).advances.map((a) => a.duties)).toEqual([[duty]]);
    }
    expect((await w.advances.mine(FIRM, STRANGER, false)).advances).toEqual([]);
  });

  it("is an admin's while it waits to be raised or issued, and once a week old whatever its step", async () => {
    const w = reminderWorld("2026-10-06T06:00:00.000Z");
    w.desk.rows.push(issued());
    w.desk.issuedOn.set(ADV_INVOICE, "2026-10-05");
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    // Issued, unpaid, one day old: not the admin's yet.
    expect((await w.advances.mine(FIRM, ADMIN, true)).advances).toEqual([]);
    // A week after signing: escalated to the admins.
    w.clock.set(new Date("2026-10-12T06:00:00.000Z"));
    expect((await w.advances.mine(FIRM, ADMIN, true)).advances.map((a) => a.duties)).toEqual([["admin"]]);
    // A draft is the admin's at once: only an admin issues.
    const v = reminderWorld("2026-10-05T06:00:00.000Z");
    v.desk.rows.push(drafted());
    expect((await v.advances.mine(FIRM, ADMIN, true)).advances.map((a) => a.duties)).toEqual([["admin"]]);
  });
});

function digestWorld(now: string) {
  const r = reminderWorld(now);
  const store = new FakeAdvanceDigestStore();
  store.firms.push(FIRM);
  store.names.set(FIRM, "10x Global");
  const mailer = new FakeBillingMailer();
  const events = new RecordingEventSink();
  const digest = new AdvanceDigest({
    store,
    advances: r.advances,
    people: r.people,
    policy: r.policy,
    mailer,
    timeZones: r.timeZones,
    clock: r.clock,
    events,
    advancesUrl: "https://app.example.test/invoices?tab=advances",
  });
  return { ...r, store, mailer, events, digest };
}

describe("the weekly summary to the admins (0322)", () => {
  // Monday 12 October 2026, 10:00 in Kolkata, is 04:30 UTC. The advance was
  // signed on the 5th, so it is a week old.
  const MONDAY_TEN = "2026-10-12T04:30:00.000Z";
  const pendingAdvance = () => advanceDue({ invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003", status: "issued" } });

  it("waits for the firm's own weekday and hour", async () => {
    const w = digestWorld("2026-10-12T04:00:00.000Z");
    w.desk.rows.push(pendingAdvance());
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    // 09:30 on Monday there: not yet. Nothing claimed, nothing sent.
    expect(await w.digest.sweep()).toEqual([]);
    expect(w.store.weeks.size).toBe(0);
    // Tuesday: not the firm's day.
    w.clock.set(new Date("2026-10-13T06:00:00.000Z"));
    expect(await w.digest.sweep()).toEqual([]);
  });

  it("emails each admin once, the advances a week old, amounts only for one who sees fees", async () => {
    const w = digestWorld(MONDAY_TEN);
    w.desk.rows.push(pendingAdvance());
    w.desk.issuedOn.set(ADV_INVOICE, "2026-10-06");
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    expect(await w.digest.sweep()).toEqual([
      { tenantId: FIRM, weekOf: "2026-10-12", sent: true, advances: 1, recipients: 2 },
    ]);
    expect(w.mailer.sent.map((l) => [l.to, l.rows[0]?.amount])).toEqual([
      ["ashish@example.test", "59000.00"],
      ["sam@example.test", null],
    ]);
    expect(w.mailer.sent[0]).toMatchObject({
      firmName: "10x Global",
      weekOf: "2026-10-12",
      advancesUrl: "https://app.example.test/invoices?tab=advances",
      rows: [{ clientName: "Kaveri Foods", letterRef: "EL-2026-0007", stage: "unpaid", invoiceNumber: "INV/2026-27/0003", daysSinceSigned: 7 }],
    });
    expect(w.events.verbs()).toEqual(["tenant.advance_digest_sent"]);
    expect(w.events.recorded[0]?.payload).toEqual({ weekOf: "2026-10-12", advances: 1, recipients: 2 });
    // The same week again: nothing more.
    expect(await w.digest.sweep()).toEqual([]);
    expect(w.mailer.sent).toHaveLength(2);
  });

  it("claims a week with nothing a week old and sends nothing", async () => {
    const w = digestWorld(MONDAY_TEN);
    w.desk.rows.push(advanceDue({ billOn: "2026-10-10", periodStart: "2026-10-10", periodEnd: "2026-10-10" }));
    expect(await w.digest.sweep()).toEqual([{ tenantId: FIRM, weekOf: "2026-10-12", sent: false, advances: 0, recipients: 0 }]);
    expect(w.mailer.sent).toEqual([]);
  });

  it("does not let one refused address stop the others", async () => {
    const w = digestWorld(MONDAY_TEN);
    w.desk.rows.push(pendingAdvance());
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    w.mailer.refusing.add("ashish@example.test");
    expect((await w.digest.sweep())[0]).toMatchObject({ sent: true, recipients: 1 });
    expect(w.mailer.sent.map((l) => l.to)).toEqual(["sam@example.test"]);
  });

  it("follows the day and hour the firm chose, and never twice inside six days", async () => {
    const w = digestWorld(MONDAY_TEN);
    w.desk.rows.push(pendingAdvance());
    w.desk.balances.set(ADV_INVOICE, { invoiced: "59000.00", paid: "0.00", outstanding: "59000.00" });
    expect((await w.digest.sweep())[0]?.weekOf).toBe("2026-10-12");
    // The firm moves its summary to Friday 17:00 that same week: Friday the
    // 16th is four days after Monday's, so it waits for the next Friday.
    w.policy.policy = { ...w.policy.policy, digestWeekday: 5, digestHour: 17 };
    w.clock.set(new Date("2026-10-16T11:30:00.000Z"));
    expect(await w.digest.sweep()).toEqual([]);
    w.clock.set(new Date("2026-10-23T11:30:00.000Z"));
    expect((await w.digest.sweep())[0]?.weekOf).toBe("2026-10-23");
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
    billedByHand: false,
    autoBillingSince: null,
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

  it("is not written for work billed by hand, nor finished before the switch went on (0321)", async () => {
    // Switching on used to bill every audit the firm had ever finished.
    const w = finalWorld();
    w.facts.subjects.push(oneTime({ autoBillingSince: "2026-12-01" }));
    expect(await w.biller.sweepTenant(FIRM)).toBe(0);
    w.facts.subjects.splice(0, 1, oneTime({ autoBillingSince: "2026-11-20" }));
    expect(await w.biller.sweepTenant(FIRM)).toBe(1);

    const byHand = finalWorld();
    byHand.facts.subjects.push(oneTime({ billedByHand: true }));
    expect(await byHand.biller.jobDone({ tenantId: FIRM, jobId: "job-1" }, SYSTEM_ACTOR)).toEqual({ created: 0 });
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
  const taxDefaults = new FakeIssuerTaxDefaults();
  const service = new BillingDeskService({
    desk,
    invoices,
    schedules: new FakeBillingSchedules(),
    setting: new FakeAutoBillingSetting(),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
    taxDefaults,
    policy: new FakeAdvancePolicy(),
    firmEntities: new FakeFirmEntities(),
  });
  return { desk, invoices, events, taxDefaults, service };
}

const ADV_DUE = "00000000-0000-4000-8000-00000000adde";
const pool = (remaining: string) => ({ advanceDueId: ADV_DUE, invoiceId: ADV_INVOICE, invoiceNumber: "INV/2026-27/0003", remaining });

describe("raising a bill the advance comes off (FIFO, before tax)", () => {
  it("bills the balance and says what came off, in the invoice line", async () => {
    const w = deskWorld();
    const audit = due({ kind: "final", engagementId: AUDIT, engagementIds: [AUDIT], serviceName: "Statutory audit", periodLabel: "Final", fullAmount: "100000.0000", amount: "100000.00", advancePool: pool("50000.00") });
    w.desk.rows.push(audit);
    const out = await w.service.raise({ tenantId: FIRM, dueIds: [audit.id], lines: [{ dueId: audit.id, taxPercent: "18" }] }, ME);
    expect(out.covered).toEqual([]);
    expect(w.invoices.invoices[0]?.lines[0]).toMatchObject({
      unitAmount: "50000.00",
      description: "Statutory audit, final bill, less advance (INV/2026-27/0003)",
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

  it("refuses to skip an advance work still waits on, and skips one nothing waits on (0321)", async () => {
    const w = deskWorld();
    const waiting = advanceDue({ advanceHoldsWork: true });
    w.desk.rows.push(waiting);
    await expect(w.service.skip({ tenantId: FIRM, dueId: waiting.id, reason: "client paid cash" }, ME)).rejects.toBeInstanceOf(
      AdvanceNotSkippable,
    );
    // The engagement was ended before the work started: nothing waits now.
    const ended = advanceDue({ engagementLetterId: "00000000-0000-4000-8000-00000000a0ee", advanceHoldsWork: false });
    w.desk.rows.push(ended);
    await w.service.skip({ tenantId: FIRM, dueId: ended.id, reason: "Client did not go ahead" }, ME);
    expect(w.desk.rows.find((r) => r.id === ended.id)?.skipped?.reason).toBe("Client did not go ahead");
    expect(w.desk.holding).toEqual([]);
  });

  it("links an advance only for an admin, to an invoice no other bill is on (0321)", async () => {
    const w = deskWorld();
    const adv = advanceDue();
    w.desk.rows.push(adv);
    const { id } = await w.invoices.raise(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      ME,
    );
    // A non-admin linking a paid invoice would start the work with no advance.
    await expect(w.service.link({ tenantId: FIRM, dueId: adv.id, invoiceId: id }, ME)).rejects.toBeInstanceOf(
      AdvanceLinkNeedsAdmin,
    );
    // An invoice another bill is already on is not this advance's.
    const other = due({ invoice: { id, number: "INV/2026-27/0009", status: "issued" } });
    w.desk.rows.push(other);
    await expect(
      w.service.link({ tenantId: FIRM, dueId: adv.id, invoiceId: id, mayLinkAdvance: true }, ADMIN_ACTOR),
    ).rejects.toBeInstanceOf(InvoiceDoesNotFitDue);
    w.desk.rows.splice(w.desk.rows.indexOf(other), 1);
    await w.service.link({ tenantId: FIRM, dueId: adv.id, invoiceId: id, mayLinkAdvance: true }, ADMIN_ACTOR);
    expect(w.desk.rows.find((r) => r.id === adv.id)?.invoice?.id).toBe(id);
    expect(w.desk.holding).toEqual([]);
  });

  it("never links a period to another bill's advance invoice: that money is the advance (0321)", async () => {
    const w = deskWorld();
    const adv = advanceDue({ invoice: { id: ADV_INVOICE, number: "INV/2026-27/0003", status: "issued" } });
    const oct = due();
    w.desk.rows.push(adv, oct);
    w.invoices.invoices.push({
      id: ADV_INVOICE, number: "INV/2026-27/0003", partyId: CLIENT, entityPartyId: ISSUER, currency: "INR",
      fxRate: "1", fxRateDate: "2026-07-01", dueOn: undefined, managerUserId: undefined, status: "issued", lines: [],
    });
    await expect(w.service.link({ tenantId: FIRM, dueId: oct.id, invoiceId: ADV_INVOICE }, ME)).rejects.toBeInstanceOf(
      InvoiceDoesNotFitDue,
    );
  });
});

describe("one person at a time on a bill (0321)", () => {
  it("claims the bills and the advance they take from, and lets them go", async () => {
    const w = deskWorld();
    const oct = due({ advancePool: pool("10000.00") });
    w.desk.rows.push(oct);
    await w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, taxPercent: "18" }] }, ME);
    expect(w.desk.claims[0]).toEqual({ op: "claim", ids: [oct.id, ADV_DUE] });
    expect(w.desk.holding).toEqual([]);
  });

  it("refuses a raise while somebody else holds the bill, and draws no number", async () => {
    const w = deskWorld();
    const oct = due();
    w.desk.rows.push(oct);
    w.desk.heldElsewhere.add(oct.id);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, taxPercent: "18" }] }, ME),
    ).rejects.toBeInstanceOf(BillBusy);
    expect(w.invoices.invoices).toEqual([]);
  });

  it("refuses a raise while somebody else spends the same advance", async () => {
    const w = deskWorld();
    const nov = due({ advancePool: pool("10000.00") });
    w.desk.rows.push(nov);
    w.desk.heldElsewhere.add(ADV_DUE);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [nov.id], lines: [{ dueId: nov.id, taxPercent: "18" }] }, ME),
    ).rejects.toBeInstanceOf(BillBusy);
    expect(w.invoices.invoices).toEqual([]);
  });

  it("lets the bills go even when the raise is refused", async () => {
    const w = deskWorld();
    const oct = due();
    w.desk.rows.push(oct);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, taxPercent: "500" }] }, ME),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
    expect(w.desk.holding).toEqual([]);
  });
});

describe("the amount a bill is raised at (0321)", () => {
  it("is never zero", async () => {
    const w = deskWorld();
    const oct = due({ fullAmount: null, amount: null });
    w.desk.rows.push(oct);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, amount: "0", taxPercent: "18" }] }, ME),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
    expect(w.invoices.invoices).toEqual([]);
  });

  it("keeps the letter's price for a login that does not see fees", async () => {
    const w = deskWorld();
    const oct = due();
    w.desk.rows.push(oct);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, amount: "1.00", taxPercent: "18" }] }, ME),
    ).rejects.toBeInstanceOf(PriceNotVisible);
    // The same figure as the letter is no change, and an unpriced bill is typed by anybody.
    await w.service.raise(
      { tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, amount: "30000", taxPercent: "18" }] },
      ME,
    );
    expect(w.invoices.invoices[0]?.lines[0]?.unitAmount).toBe("30000");
  });

  it("lets somebody who sees fees bill another figure, and records both in the ledger", async () => {
    const w = deskWorld();
    const oct = due();
    w.desk.rows.push(oct);
    await w.service.raise(
      { tenantId: FIRM, dueIds: [oct.id], lines: [{ dueId: oct.id, amount: "27500", taxPercent: "18" }], callerSeesFees: true },
      ME,
    );
    expect(w.invoices.invoices[0]?.lines[0]?.unitAmount).toBe("27500");
    expect(w.events.recorded.at(-1)?.payload).toMatchObject({ letterAmount: "30000.00", billedAmount: "27500" });
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
      paid: "23600.00",
      waived: null,
    };
  }

  it("lists an advance with some left once the work it covered is finished", async () => {
    const w = deskWorld();
    w.desk.refunds.push(candidate(), candidate({ finished: false }), candidate({ remaining: "0.00" }));
    expect(await w.service.refunds(FIRM)).toHaveLength(1);
  });

  it("refuses a second refund while the first is being written (0321)", async () => {
    const w = deskWorld();
    const c = candidate();
    w.desk.refunds.push(c);
    w.desk.heldElsewhere.add(c.advance.id);
    await expect(w.service.refund({ tenantId: FIRM, dueId: c.advance.id }, ME)).rejects.toBeInstanceOf(BillBusy);
    expect(w.invoices.creditNotes).toEqual([]);
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

describe("the advance's automatic draft (0322)", () => {
  it("is raised alone at the last rate used on the work, as whoever asked", async () => {
    const w = deskWorld();
    const adv = advanceDue();
    w.desk.rows.push(adv);
    const out = await w.service.draftAdvance(FIRM, adv.id, SYSTEM_ACTOR);
    expect(out).toEqual({ invoiceId: w.invoices.invoices[0]?.id });
    expect(w.invoices.invoices[0]).toMatchObject({ number: null, status: "draft", managerUserId: MANAGER });
    expect(w.invoices.invoices[0]?.lines[0]).toMatchObject({ unitAmount: "50000.00", taxPercent: "18.00", description: "Advance under EL-2026-0007" });
    expect(w.invoices.actors).toEqual([SYSTEM_ACTOR]);
  });

  it("takes the issuing company's default rate when the work was never invoiced", async () => {
    const w = deskWorld();
    const adv = advanceDue({ lastTaxPercent: null });
    w.desk.rows.push(adv);
    expect(await w.service.draftAdvance(FIRM, adv.id, SYSTEM_ACTOR)).toEqual({ blocked: "no_tax_rate" });
    expect(w.invoices.invoices).toEqual([]);
    w.taxDefaults.rates.set(ISSUER, "18");
    await w.service.draftAdvance(FIRM, adv.id, SYSTEM_ACTOR);
    expect(w.invoices.invoices[0]?.lines[0]?.taxPercent).toBe("18");
  });

  it("is not made over an invoice raised by hand, nor a second time, nor after a person cancelled it", async () => {
    const w = deskWorld();
    const byHand = advanceDue();
    w.desk.rows.push(byHand);
    w.desk.handRaised.set(byHand.id, { invoiceId: "00000000-0000-4000-8000-00000000a0f1", number: "INV/2026-27/0001" });
    expect(await w.service.draftAdvance(FIRM, byHand.id, SYSTEM_ACTOR)).toEqual({ blocked: "billed_by_hand" });

    const once = advanceDue({ engagementLetterId: "00000000-0000-4000-8000-00000000a0ee" });
    w.desk.rows.push(once);
    await w.service.draftAdvance(FIRM, once.id, SYSTEM_ACTOR);
    expect(await w.service.draftAdvance(FIRM, once.id, SYSTEM_ACTOR)).toEqual({ blocked: "not_open" });

    const id = w.invoices.invoices[0]?.id ?? "";
    w.desk.invoiceStatus.set(id, "cancelled");
    // Open again, but the person who cancelled it raises it again if they want.
    expect(await w.service.draftAdvance(FIRM, once.id, SYSTEM_ACTOR)).toEqual({ blocked: "not_open" });
    expect(w.invoices.invoices).toHaveLength(1);
  });
});

describe("the firm's advance settings (0322)", () => {
  it("are read whole, and a policy out of range is refused", async () => {
    const w = deskWorld();
    expect(await w.service.settings(FIRM)).toMatchObject({
      autoBilling: false,
      advancePolicy: { draftOverdueDays: 3, unpaidOverdueDays: 15, partnerMinRank: 9, digestWeekday: 1, digestHour: 10 },
      taxDefaults: [],
    });
    await expect(
      w.service.setAdvancePolicy(FIRM, { draftOverdueDays: 0, unpaidOverdueDays: 15, partnerMinRank: 9, digestWeekday: 1, digestHour: 10 }, ADMIN_ACTOR),
    ).rejects.toBeInstanceOf(InvalidBillingInput);
    await w.service.setAdvancePolicy(FIRM, { draftOverdueDays: 2, unpaidOverdueDays: 10, partnerMinRank: 10, digestWeekday: 5, digestHour: 17 }, ADMIN_ACTOR);
    expect(w.events.recorded.at(-1)).toMatchObject({ verb: "tenant.advance_policy_set" });
    expect((await w.service.settings(FIRM)).advancePolicy.digestWeekday).toBe(5);
  });

  it("set a default tax rate for one of the firm's own companies only, 0 to 100", async () => {
    const w = deskWorld();
    await expect(w.service.setTaxDefault({ tenantId: FIRM, entityPartyId: ISSUER, taxPercent: "18" }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      InvalidBillingInput,
    );
    const firm = new FakeFirmEntities();
    firm.add(ISSUER);
    const v = deskWorldWith(firm);
    await expect(v.service.setTaxDefault({ tenantId: FIRM, entityPartyId: ISSUER, taxPercent: "180" }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
      InvalidBillingInput,
    );
    await v.service.setTaxDefault({ tenantId: FIRM, entityPartyId: ISSUER, taxPercent: "18" }, ADMIN_ACTOR);
    expect(v.events.recorded.at(-1)).toMatchObject({ verb: "tenant.tax_default_set", payload: { entityPartyId: ISSUER, from: null, to: "18" } });
    expect((await v.service.settings(FIRM)).taxDefaults).toEqual([{ entityPartyId: ISSUER, taxPercent: "18" }]);
  });
});

function deskWorldWith(firmEntities: FakeFirmEntities) {
  const desk = new FakeBillingDueDesk();
  const events = new RecordingEventSink();
  const service = new BillingDeskService({
    desk,
    invoices: new FakeInvoiceDrafter(),
    schedules: new FakeBillingSchedules(),
    setting: new FakeAutoBillingSetting(),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
    taxDefaults: new FakeIssuerTaxDefaults(),
    policy: new FakeAdvancePolicy(),
    firmEntities,
  });
  return { desk, events, service };
}
