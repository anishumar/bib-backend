// Work vs Billing (Q041, 2026-10-04): the work, its bill, the invoice and the
// money on one row per client, service and period. A READ MODEL: nothing is
// stored, every row is put together from the facts on each request.
//
// Ashish (COO, 10x Global, 4 Oct 2026): "job done but bill not generated, hume
// kyun nahi mil sakta system mein yeh?" and "bill ho ke paise nahi aaye toh is
// something jo ki trackable hai". Every practice-management product answers
// the first with an UNBILLED WORK (WIP) report by client, service and person,
// aged in 30-day buckets (Karbon's WIP report, Xero Practice Manager's WIP
// ledger, Canopy's WIP aging), and the second with receivables ageing. This
// is both, on one row, for fixed-fee work.
//
// ── HOW A JOB MEETS ITS BILL ────────────────────────────────────────────────
//
// A bill (`crm.billing_due`) does not store its job. They meet by SUBJECT (the
// engagement, or the fee group whose one fee covers several) and PERIOD: a
// period job sits on the row of the bill whose period holds the job's first
// day. A job with no bill yet gets the row of the period the sweep WOULD bill
// it in, worked out with the sweep's own `billingDues`, so the expected bill
// date is the sweep's and never "the 1st of next month" written here (Q042
// moves that date; this follows it). One-time work is one row: its job and
// its final bill. A statutory filing has no bill of its own; its service's
// bill covers it, so it is listed under that row and never flagged unbilled.
//
// ── WHAT IS A PROBLEM ───────────────────────────────────────────────────────
//
// Flags carry codes and the screen writes the words (the readiness rule: the
// API ships codes). NOT a problem: a recurring bill raised while its job is
// still open (Ashish, 1 Oct 2026: the work on a retainer is not complete
// before the invoice is raised), a bill whose date has not come, and a period
// before the client's billing began (billed the old way).
import {
  addMonthsClamped,
  billLabel,
  billingDues,
  serviceWindowOf,
  type StatutoryFiling,
} from "../../domain/billing/model";
import { yearStartOfCompany } from "../../domain/calendar/model";
import type { CompanyCalendars } from "../../domain/calendar/model";
import { daysBetween } from "../../domain/obligation/model";
import { compareAmounts } from "../../domain/money/model";
import { dayInZone } from "../../domain/scheduler/zone";
import { monthsPerPeriod, periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import type { Clock } from "../../platform/clock";
import type {
  DueStatus,
  FirmTimeZone,
  FiscalYearSource,
  WbBill,
  WbFacts,
  WbFiling,
  WbInvoice,
  WbJob,
  WbPerson,
  WbSubject,
  WorkBillingFacts,
} from "./ports";

/** A draft invoice left this long after its bill date is a bill nobody sent:
 *  the same week the desk escalates an unraised bill after. */
export const DRAFT_STALE_DAYS = 7;

/** How far back the screen looks when no period is asked for: twelve months,
 *  the window a WIP or ageing report opens on. */
export const DEFAULT_MONTHS = 12;

/** The most rows one answer carries. */
export const MAX_ROWS = 2000;

export type WorkState = "none" | "not_started" | "in_progress" | "done" | "cancelled";
export type PaymentState = "paid" | "part_paid" | "unpaid";
export type RowKind = "period" | "one_time" | "advance";

export type FlagCode = "no_bill" | "no_final_bill" | "skipped" | "not_raised" | "not_issued" | "unpaid_overdue";
export type FlagCause =
  "no_schedule" | "auto_billing_off" | "no_fiscal_year" | "not_written" | "before_auto_billing" | "no_price";
export type NoteCode =
  | "raised_before_work_done"
  | "bill_due_on"
  | "billing_run_next"
  | "before_billing_start"
  | "billed_by_hand"
  | "not_served"
  | "covered_by_advance"
  | "work_in_progress";

export interface Flag {
  readonly code: FlagCode;
  readonly cause: FlagCause | null;
  /** How old the problem is: days since the period ended or the work was done
   *  (unbilled), since the bill date (not raised, not issued), or past the due
   *  date (unpaid). Never negative. */
  readonly days: number;
  /** The day it counts from. */
  readonly since: string;
  /** A skip's reason, who skipped it and the instant. */
  readonly reason: string | null;
  readonly by: WbPerson | null;
  readonly at: string | null;
}

export interface Note {
  readonly code: NoteCode;
  readonly date: string | null;
  readonly invoiceNumber: string | null;
}

export interface WorkBillingRow {
  readonly key: string;
  readonly kind: RowKind;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly serviceName: string;
  readonly entityName: string | null;
  readonly letter: { readonly id: string; readonly ref: string };
  readonly engagementIds: readonly string[];
  readonly feeGroupId: string | null;
  readonly frequency: string | null;
  readonly period: {
    readonly start: string;
    readonly end: string;
    readonly label: string;
  } | null;
  readonly work: WorkState;
  readonly workDoneOn: string | null;
  readonly jobs: readonly {
    readonly id: string;
    readonly status: string;
    readonly periodLabel: string | null;
    readonly doneOn: string | null;
  }[];
  readonly filings: readonly WbFiling[];
  readonly bill: {
    readonly id: string;
    readonly kind: string;
    readonly status: DueStatus;
    readonly billOn: string;
    readonly currency: string;
    readonly amount: string | null;
    readonly priced: boolean;
  } | null;
  /** When no bill is written yet: the day the sweep will write it. */
  readonly expectedBillOn: string | null;
  readonly invoice: WbInvoice | null;
  readonly payment: {
    readonly state: PaymentState;
    /** The invoice's due date, else its date: an invoice with no terms is due
     *  on receipt (the Xero and Zoho default). */
    readonly dueOn: string | null;
    /** Positive: overdue by; zero or negative: due in. Null when paid. */
    readonly daysOverdue: number | null;
  } | null;
  readonly manager: WbPerson | null;
  readonly managerFrom: "bill" | "invoice" | "key_manager" | "none";
  readonly handInvoices: WbSubject["handInvoices"] | null;
  readonly flags: readonly Flag[];
  readonly notes: readonly Note[];
}

export type AgeBucket = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

export interface WorkBillingSummary {
  readonly rows: number;
  readonly withProblems: number;
  readonly byFlag: Readonly<Record<FlagCode, number>>;
  /** Work done and not yet billed (no bill, no final bill, bill not raised,
   *  draft not issued), aged by `Flag.days`: the WIP ageing. */
  readonly unbilledAge: Readonly<Record<AgeBucket, number>>;
  /** Unpaid invoices past their due date, aged the same way. */
  readonly overdueAge: Readonly<Record<AgeBucket, number>>;
}

export interface WorkBillingQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly partyId?: string | undefined;
  readonly managerUserId?: string | undefined;
  readonly problemsOnly?: boolean | undefined;
}

export interface WorkBillingAnswer {
  readonly today: string;
  readonly from: string;
  readonly to: string;
  readonly autoBilling: boolean;
  readonly rows: readonly WorkBillingRow[];
  readonly truncated: boolean;
  readonly summary: WorkBillingSummary;
}

export interface Deps {
  readonly facts: WorkBillingFacts;
  readonly fiscalYears: FiscalYearSource;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
}

export class WorkBillingService {
  constructor(private readonly deps: Deps) {}

  async list(tenantId: string, query: WorkBillingQuery): Promise<WorkBillingAnswer> {
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const to = query.to ?? today;
    const from = query.from ?? firstOfMonth(addMonthsClamped(today, -(DEFAULT_MONTHS - 1)));
    const [facts, firmYearStart, calendars] = await Promise.all([
      this.deps.facts.read(tenantId, {
        from,
        to,
        partyId: query.partyId,
        today,
      }),
      this.deps.fiscalYears.fiscalYearStartMonth(tenantId),
      this.deps.timeZones.companyCalendars(tenantId),
    ]);
    const all = assembleRows(facts, { today, from, to, firmYearStart, calendars });
    const forManager =
      query.managerUserId === undefined ? all : all.filter((r) => r.manager?.userId === query.managerUserId);
    const summary = summarise(forManager);
    const shown = query.problemsOnly === true ? forManager.filter((r) => r.flags.length > 0) : forManager;
    return {
      today,
      from,
      to,
      autoBilling: facts.autoBilling,
      rows: shown.slice(0, MAX_ROWS),
      truncated: shown.length > MAX_ROWS,
      summary,
    };
  }
}

// ── Assembly: pure ──────────────────────────────────────────────────────────

interface Ctx {
  readonly today: string;
  readonly from: string;
  readonly to: string;
  /** The firm's year start; a company with its own year overrides it. */
  readonly firmYearStart: number | null;
  readonly calendars: CompanyCalendars;
}

/** The year a subject's periods are cut on: the sweep's own choice (0337,
 *  0338), so an expected bill date is the date the sweep will use. */
function yearStartOf(s: WbSubject, ctx: Ctx): number | null {
  return s.yearStartMonth ?? yearStartOfCompany(ctx.calendars, s.issuingEntityPartyId, ctx.firmYearStart);
}

interface Draft {
  key: string;
  kind: RowKind;
  subject: WbSubject | null;
  party: { id: string; displayName: string };
  serviceName: string;
  entityName: string | null;
  letter: { id: string; ref: string };
  engagementIds: readonly string[];
  feeGroupId: string | null;
  frequency: string | null;
  period: { start: string; end: string; label: string } | null;
  bill: WbBill | null;
  expected: { billOn: string } | "not_served" | null;
  jobs: Map<string, WbJob>;
  filings: Map<string, WbFiling>;
}

function isRecurring(frequency: string | null): boolean {
  return recurrenceOfService(frequency) !== null;
}

/** Puts every row together and decides its flags. Exported for the tests. */
export function assembleRows(facts: WbFacts, ctx: Ctx): WorkBillingRow[] {
  const subjects = new Map(facts.subjects.map((s) => [s.key, s]));
  // A subject's filings, as the sweep reads them to date a yearly bill (Q071).
  const filingsOf = (key: string): readonly StatutoryFiling[] =>
    facts.filings
      .filter((f) => f.subjectKeys.includes(key))
      .map((f) => ({
        id: f.id,
        name: f.name,
        dueOn: f.dueOn,
        periodStart: f.periodStart,
        periodEnd: f.periodEnd,
        periodLabel: f.periodLabel,
      }));
  const rows = new Map<string, Draft>();
  // The rows of each subject, so a job or a filing finds its own in one look.
  const bySubject = new Map<string, Draft[]>();
  const put = (draft: Draft): void => {
    rows.set(draft.key, draft);
    const sk = draft.subject?.key;
    if (sk !== undefined) bySubject.set(sk, [...(bySubject.get(sk) ?? []), draft]);
  };

  const fromSubject = (key: string, kind: RowKind, s: WbSubject): Draft => ({
    key,
    kind,
    subject: s,
    party: s.party,
    serviceName: s.serviceName,
    entityName: s.entityName,
    letter: s.letter,
    engagementIds: s.engagements.map((e) => e.engagementId),
    feeGroupId: s.feeGroupId,
    frequency: s.frequency,
    period: null,
    bill: null,
    expected: null,
    jobs: new Map(),
    filings: new Map(),
  });

  // 1. Bills make rows first, so jobs find them.
  for (const b of facts.bills) {
    const s = subjects.get(b.subjectKey) ?? null;
    const key =
      b.kind === "period"
        ? `p:${b.subjectKey}:${b.periodStart}`
        : b.kind === "final"
          ? `o:${b.subjectKey}`
          : `a:${b.id}`;
    const kind: RowKind = b.kind === "period" ? "period" : b.kind === "final" ? "one_time" : "advance";
    const draft: Draft =
      s !== null
        ? fromSubject(key, kind, s)
        : {
            key,
            kind,
            subject: null,
            party: b.party,
            serviceName: b.serviceName,
            entityName: b.entityName,
            letter: b.letter,
            engagementIds: b.engagementIds,
            feeGroupId: null,
            frequency: null,
            period: null,
            bill: null,
            expected: null,
            jobs: new Map(),
            filings: new Map(),
          };
    draft.bill = b;
    draft.period =
      kind === "period"
        ? { start: b.periodStart, end: b.periodEnd, label: b.periodLabel }
        : kind === "advance"
          ? { start: b.billOn, end: b.billOn, label: "Advance" }
          : null;
    put(draft);
  }

  // 2. Jobs join the row of their period, or make the row the sweep would bill.
  for (const j of facts.jobs) {
    const s = subjects.get(j.subjectKey);
    if (s === undefined) continue;
    let draft: Draft | undefined;
    if (j.periodStart !== null && isRecurring(s.frequency)) {
      const start = j.periodStart;
      draft = (bySubject.get(s.key) ?? []).find(
        (r) => r.kind === "period" && r.period !== null && r.period.start <= start && start <= r.period.end,
      );
      if (draft === undefined) {
        const expected = expectedBill(s, start, yearStartOf(s, ctx), filingsOf(s.key));
        const period =
          expected !== null && expected !== "not_served"
            ? expected.period
            : {
                start,
                end: j.periodEnd ?? start,
                label: j.periodLabel ?? start,
              };
        const key = `p:${s.key}:${period.start}`;
        draft = rows.get(key);
        if (draft === undefined) {
          draft = fromSubject(key, "period", s);
          draft.period = period;
          draft.expected =
            expected === null ? null : expected === "not_served" ? "not_served" : { billOn: expected.billOn };
          put(draft);
        }
      }
    } else {
      const key = `o:${s.key}`;
      draft = rows.get(key);
      if (draft === undefined) {
        draft = fromSubject(key, "one_time", s);
        put(draft);
      }
    }
    draft.jobs.set(j.jobId, j);
  }

  // 3. Filings sit under their service's row: the bill the filing dated
  //    (Q071: the audit due 30 September 2026 dates the bill of the year it
  //    falls in), else the one whose period holds the filing's last day, else
  //    any it overlaps, else the one-time row.
  for (const f of facts.filings) {
    for (const sk of f.subjectKeys) {
      const own = (bySubject.get(sk) ?? []).filter((r) => r.kind !== "advance");
      const target =
        own.find((r) => r.bill?.datedByFilingId === f.id) ??
        own.find((r) => r.period !== null && r.period.start <= f.periodEnd && f.periodEnd <= r.period.end) ??
        own.find((r) => r.period !== null && r.period.start <= f.periodEnd && f.periodStart <= r.period.end) ??
        own.find((r) => r.kind === "one_time");
      target?.filings.set(f.id, f);
    }
  }

  const out: WorkBillingRow[] = [];
  for (const d of rows.values()) {
    const row = finish(d, facts, ctx);
    if (inWindow(row, ctx)) out.push(row);
  }
  out.sort(
    (a, b) =>
      a.party.displayName.localeCompare(b.party.displayName) ||
      a.serviceName.localeCompare(b.serviceName) ||
      (b.period?.start ?? "9999").localeCompare(a.period?.start ?? "9999") ||
      a.key.localeCompare(b.key),
  );
  return out;
}

/**
 * The bill the sweep WOULD write for the period holding `day`: the sweep's own
 * arithmetic (`periodsFrom` + `billingDues`), asked as if every bill date had
 * come. Null when billing is not set up or the frequency is not recurring;
 * `not_served` when nothing of that period was served (a pause).
 */
export function expectedBill(
  s: WbSubject,
  day: string,
  fiscalYearStartMonth: number | null,
  filings: readonly StatutoryFiling[] = [],
):
  | {
      readonly period: { start: string; end: string; label: string };
      readonly billOn: string;
    }
  | "not_served"
  | null {
  const recurrence = recurrenceOfService(s.frequency);
  if (recurrence === null || s.billingFrom === null || s.firstInvoiceOn === null) return null;
  if (recurrence !== "monthly" && fiscalYearStartMonth === null) return null;
  if (day < s.billingFrom) return null;
  const span = monthsPerPeriod(recurrence);
  const count = Math.floor(monthsBetween(s.billingFrom, day) / span) + 2;
  const periods = periodsFrom(s.billingFrom, recurrence, count, fiscalYearStartMonth ?? 1);
  const k = periods.findIndex((p) => p.start <= day && day <= p.end);
  const period = periods[k];
  if (period === undefined) return null;
  const planned = billingDues({
    periods,
    spanMonths: span,
    firstInvoiceOn: s.firstInvoiceOn,
    today: "9999-12-31",
    windows: s.engagements.map(serviceWindowOf),
    filings,
  }).find((p) => p.period.start === period.start);
  if (planned === undefined) return "not_served";
  return {
    period: { start: period.start, end: period.end, label: billLabel(planned) },
    billOn: planned.billOn,
  };
}

function finish(d: Draft, facts: WbFacts, ctx: Ctx): WorkBillingRow {
  const { today } = ctx;
  const jobs = [...d.jobs.values()];
  const live = jobs.filter((j) => j.status !== "cancelled");
  const work: WorkState =
    jobs.length === 0
      ? "none"
      : live.length === 0
        ? "cancelled"
        : live.every((j) => j.status === "done")
          ? "done"
          : live.every((j) => j.status === "pending")
            ? "not_started"
            : "in_progress";
  const doneDays = live.flatMap((j) => (j.doneOn === null ? [] : [j.doneOn])).sort();
  const workDoneOn = work === "done" ? (doneDays[doneDays.length - 1] ?? null) : null;

  const flags: Flag[] = [];
  const notes: Note[] = [];
  const flag = (code: FlagCode, cause: FlagCause | null, since: string, extra?: Partial<Flag>): void => {
    flags.push({
      code,
      cause,
      since,
      days: Math.max(0, daysBetween(since, today)),
      reason: null,
      by: null,
      at: null,
      ...extra,
    });
  };
  const note = (code: NoteCode, date: string | null = null, invoiceNumber: string | null = null): void => {
    notes.push({ code, date, invoiceNumber });
  };

  const b = d.bill;
  const s = d.subject;
  const recurring = isRecurring(d.frequency);
  let payment: WorkBillingRow["payment"] = null;
  let expectedBillOn: string | null = null;

  if (b !== null) {
    if (b.status === "skipped" && b.skipped !== null) {
      flag("skipped", null, b.billOn, {
        reason: b.skipped.reason,
        by: b.skipped.by,
        at: b.skipped.at,
        days: 0,
      });
    } else if (b.status === "open") {
      if (b.billOn < today) flag("not_raised", b.fullAmount === null ? "no_price" : null, b.billOn);
      else note("bill_due_on", b.billOn);
    } else if (b.status === "drafted") {
      if (daysBetween(b.billOn, today) > DRAFT_STALE_DAYS) flag("not_issued", null, b.billOn);
    } else if (b.status === "covered") {
      payment = { state: "paid", dueOn: null, daysOverdue: null };
      note("covered_by_advance", null, b.coveredBy?.number ?? null);
    } else if (b.status === "billed" && b.invoice !== null) {
      payment = paymentOf(b.invoice, today);
      if (payment.daysOverdue !== null && payment.daysOverdue > 0 && payment.dueOn !== null) {
        flag("unpaid_overdue", null, payment.dueOn);
      }
    }
    // A retainer's bill goes out before its month's work is finished.
    if (
      d.kind === "period" &&
      (b.status === "drafted" || b.status === "billed" || b.status === "covered") &&
      (work === "in_progress" || work === "not_started")
    ) {
      note("raised_before_work_done");
    }
  } else if (d.kind === "period" && d.period !== null) {
    const p = d.period;
    if (d.expected !== null && d.expected !== "not_served") expectedBillOn = d.expected.billOn;
    if (work === "done") {
      const over = p.end < today;
      if (s === null) {
        note("work_in_progress");
      } else if (s.billingFrom === null || s.firstInvoiceOn === null) {
        if (over) flag("no_bill", "no_schedule", p.end);
      } else if (p.start < s.billingFrom) {
        note("before_billing_start", s.billingFrom);
      } else if (d.expected === "not_served") {
        note("not_served");
      } else if (!facts.autoBilling) {
        if (over) flag("no_bill", "auto_billing_off", p.end);
        else if (expectedBillOn !== null) note("bill_due_on", expectedBillOn);
      } else if (d.expected === null) {
        // Set up, recurring, but no period could be cut: the year is not known.
        if (over) flag("no_bill", "no_fiscal_year", p.end);
      } else if (d.expected.billOn > today) {
        note("bill_due_on", d.expected.billOn);
      } else if (daysBetween(d.expected.billOn, today) <= 1) {
        note("billing_run_next", d.expected.billOn);
      } else {
        flag("no_bill", "not_written", d.expected.billOn);
      }
    } else if (work === "in_progress" || work === "not_started") {
      note("work_in_progress");
      if (expectedBillOn !== null) note("bill_due_on", expectedBillOn);
    }
  } else if (d.kind === "one_time" && s !== null && !recurring) {
    if (work === "done" && workDoneOn !== null) {
      if (s.handInvoices.count > 0) {
        note("billed_by_hand", s.handInvoices.last?.issuedOn ?? null, s.handInvoices.last?.number ?? null);
      } else if (!facts.autoBilling) {
        flag("no_final_bill", "auto_billing_off", workDoneOn);
      } else if (facts.autoBillingSince !== null && workDoneOn < facts.autoBillingSince) {
        flag("no_final_bill", "before_auto_billing", workDoneOn);
      } else if (daysBetween(workDoneOn, today) <= 1) {
        note("billing_run_next", workDoneOn);
      } else {
        flag("no_final_bill", "not_written", workDoneOn);
      }
    } else if (work === "in_progress" || work === "not_started") {
      note("work_in_progress");
    }
  }

  const invoice = b?.invoice ?? null;
  const manager = b?.manager ?? invoice?.manager ?? s?.keyManager ?? null;
  const managerFrom: WorkBillingRow["managerFrom"] =
    b !== null && b.manager !== null
      ? "bill"
      : invoice !== null && invoice.manager !== null
        ? "invoice"
        : s !== null && s.keyManager !== null
          ? "key_manager"
          : "none";
  const noBillYet = flags.some((f) => f.code === "no_bill" && f.cause === "no_schedule");

  return {
    key: d.key,
    kind: d.kind,
    party: d.party,
    serviceName: d.serviceName,
    entityName: d.entityName,
    letter: d.letter,
    engagementIds: d.engagementIds,
    feeGroupId: d.feeGroupId,
    frequency: d.frequency,
    period: d.period,
    work,
    workDoneOn,
    jobs: jobs.map((j) => ({
      id: j.jobId,
      status: j.status,
      periodLabel: j.periodLabel,
      doneOn: j.doneOn,
    })),
    filings: [...d.filings.values()].sort((x, y) => x.dueOn.localeCompare(y.dueOn) || x.name.localeCompare(y.name)),
    bill:
      b === null
        ? null
        : {
            id: b.id,
            kind: b.kind,
            status: b.status,
            billOn: b.billOn,
            currency: b.currency,
            amount: b.amount,
            priced: b.fullAmount !== null,
          },
    expectedBillOn,
    invoice,
    payment,
    manager,
    managerFrom,
    handInvoices: noBillYet && s !== null && s.handInvoices.count > 0 ? s.handInvoices : null,
    flags,
    notes,
  };
}

function paymentOf(i: WbInvoice, today: string): NonNullable<WorkBillingRow["payment"]> {
  const dueOn = i.dueOn ?? i.issuedOn;
  if (compareAmounts(i.outstanding, "0") <= 0) return { state: "paid", dueOn, daysOverdue: null };
  const state: PaymentState = compareAmounts(i.paid, "0") > 0 ? "part_paid" : "unpaid";
  return {
    state,
    dueOn,
    daysOverdue: dueOn === null ? null : daysBetween(dueOn, today),
  };
}

/** A period row whose period touches the window; one-time work finished in it
 *  or still going; an advance dated in it. */
function inWindow(r: WorkBillingRow, ctx: Ctx): boolean {
  if (r.kind === "one_time") {
    const anchor = r.bill?.billOn ?? r.workDoneOn;
    return anchor === null ? r.work !== "cancelled" : anchor >= ctx.from && anchor <= ctx.to;
  }
  if (r.period === null) return false;
  return r.period.start <= ctx.to && r.period.end >= ctx.from;
}

const UNBILLED: readonly FlagCode[] = ["no_bill", "no_final_bill", "not_raised", "not_issued"];

function bucketOf(days: number): AgeBucket {
  return days <= 30 ? "d0_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90_plus";
}

export function summarise(rows: readonly WorkBillingRow[]): WorkBillingSummary {
  const byFlag: Record<FlagCode, number> = {
    no_bill: 0,
    no_final_bill: 0,
    skipped: 0,
    not_raised: 0,
    not_issued: 0,
    unpaid_overdue: 0,
  };
  const unbilledAge: Record<AgeBucket, number> = {
    d0_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };
  const overdueAge: Record<AgeBucket, number> = {
    d0_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };
  let withProblems = 0;
  for (const r of rows) {
    if (r.flags.length > 0) withProblems += 1;
    for (const f of r.flags) {
      byFlag[f.code] += 1;
      if (UNBILLED.includes(f.code)) unbilledAge[bucketOf(f.days)] += 1;
      if (f.code === "unpaid_overdue") overdueAge[bucketOf(f.days)] += 1;
    }
  }
  return { rows: rows.length, withProblems, byFlag, unbilledAge, overdueAge };
}

function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthsBetween(from: string, to: string): number {
  const [fy = 0, fm = 1] = from.split("-").map(Number);
  const [ty = 0, tm = 1] = to.split("-").map(Number);
  return ty * 12 + tm - (fy * 12 + fm);
}
