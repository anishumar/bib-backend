// Billing early, when the work is done (Q071 b, 2026-10-05). No I/O.
//
// Ashish, 4 Oct 2026: "after a job/task is closed, offer to raise the
// invoice". A recurring period's bill is made on its bill date (the period's
// last day, Q042; a yearly filing's due date, Q071 a; or the letter's own
// day). When the work of a period is finished BEFORE that date, a person is
// offered "Raise invoice now": the period's bill is written today, onto To
// raise, and the invoice is raised from it the ordinary way.
//
// It is the sweep's own bill, written sooner, never a second one: a bill is
// keyed by its subject and period (0318's unique index), so the daily run that
// reaches the bill date later finds it there and writes nothing. And it is an
// OFFER: nothing is written until a person asks.
//
// Like the sweep and the final bill, it is automatic billing: a firm with the
// switch off raises every invoice by hand, so nothing is offered there.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { yearStartOfCompany, zoneOfCompany } from "../../domain/calendar/model";
import { monthsPerPeriod, periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import {
  billLabel,
  billingDues,
  serviceWindowOf,
  type BillingDuePlan,
  type ManagerHow,
} from "../../domain/billing/model";
import { AutoBillingOff, BillEarlyRefused, BillingEngagementNotFound } from "../../domain/billing/errors";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AutoBillingSetting,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSubject,
  DoneWork,
  DoneWorkFacts,
  FirmTimeZone,
  FiscalYearSource,
  NewBillingDue,
} from "./ports";

export interface EarlyBillerDeps {
  readonly dues: BillingDueWriter;
  readonly work: DoneWorkFacts;
  readonly managers: BillingManagerFacts;
  readonly setting: AutoBillingSetting;
  readonly fiscalYears: FiscalYearSource;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly events: EventSink;
}

/** How far back finished work is looked for. A period whose bill date is
 *  still ahead began at most a year ago (a yearly period), so a little over a
 *  year finds every piece of work that can still be billed early. */
const LOOK_BACK_DAYS = 400;

/** A period whose work is done and whose bill date has not come. */
export interface EarlyBillCandidate {
  /** `e:<engagement>` or `g:<fee group>`: the sweep's subject. */
  readonly subjectKey: string;
  readonly engagementId: string | null;
  readonly feeGroupId: string | null;
  readonly partyId: string;
  readonly clientName: string;
  readonly serviceName: string;
  readonly letterRef: string;
  readonly currency: string;
  /** The letter's price for one whole period, before tax; null = none named. */
  readonly fullAmount: string | null;
  readonly period: { readonly start: string; readonly end: string; readonly label: string };
  /** The day the bill would be made without this offer. */
  readonly plannedBillOn: string;
  /** The yearly filing that dates it (Q071 a), when one does. */
  readonly datedByFiling: { readonly id: string; readonly name: string; readonly dueOn: string } | null;
  /** The finished work that makes it billable: the latest, when several. */
  readonly work: {
    readonly kind: "job" | "filing";
    readonly id: string;
    readonly jobId: string | null;
    readonly name: string | null;
    readonly doneOn: string;
  };
  /** Whose kitty the bill would go in. */
  readonly manager: { readonly userId: string | null; readonly how: ManagerHow };
}

interface Planned {
  readonly subject: BillingSubject;
  readonly plan: BillingDuePlan;
  readonly work: DoneWork;
  readonly companyToday: string;
}

export class EarlyBiller {
  constructor(private readonly deps: EarlyBillerDeps) {}

  /**
   * The periods that may be billed early: work done, no bill yet, bill date
   * still ahead. Narrowed to one job, one task or one client when asked, and
   * to the bills whose manager is `managerUserId` (My day).
   */
  async candidates(
    tenantId: string,
    filter: {
      readonly jobId?: string | undefined;
      readonly workItemId?: string | undefined;
      readonly partyId?: string | undefined;
      readonly managerUserId?: string | undefined;
    } = {},
  ): Promise<readonly EarlyBillCandidate[]> {
    if (!(await this.deps.setting.isOn(tenantId))) return [];
    const planned = await this.plan(tenantId, filter);
    if (planned.length === 0) return [];
    const firmToday = await this.firmToday(tenantId);
    const cache: ManagerCache = new Map();
    const names = await this.deps.work.describe(
      tenantId,
      [...new Set(planned.flatMap((p) => p.subject.engagements.map((e) => e.engagementId)))],
    );
    const out: EarlyBillCandidate[] = [];
    for (const p of planned) {
      const manager = await billingManagerFor(
        this.deps.managers,
        {
          tenantId,
          partyId: p.subject.partyId,
          deptCodes: p.subject.engagements.map((e) => e.deptCode),
          today: firmToday,
        },
        cache,
      );
      if (filter.managerUserId !== undefined && manager.userId !== filter.managerUserId) continue;
      const key = subjectKey(p.subject);
      const name = names.get(key);
      out.push({
        subjectKey: key,
        engagementId: p.subject.engagementId,
        feeGroupId: p.subject.feeGroupId,
        partyId: p.subject.partyId,
        clientName: name?.clientName ?? "",
        serviceName: name?.serviceName ?? "",
        letterRef: name?.letterRef ?? "",
        currency: p.subject.currency,
        fullAmount: p.subject.fullAmount,
        period: { start: p.plan.period.start, end: p.plan.period.end, label: billLabel(p.plan) },
        plannedBillOn: p.plan.billOn,
        datedByFiling:
          p.plan.datedBy === null
            ? null
            : { id: p.plan.datedBy.id, name: p.plan.datedBy.name, dueOn: p.plan.datedBy.dueOn },
        work: {
          kind: p.work.kind,
          id: p.work.id,
          jobId: p.work.jobId,
          name: p.work.name,
          doneOn: p.work.doneOn,
        },
        manager: { userId: manager.userId, how: manager.how },
      });
    }
    return out.sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.serviceName.localeCompare(b.serviceName) ||
        a.period.start.localeCompare(b.period.start),
    );
  }

  /**
   * "Raise invoice now": the period's bill, written today onto To raise.
   * Refused when the period has its bill already, its work is not done, or
   * the switch is off; never a second bill for the same period.
   */
  async billEarly(
    input: { readonly tenantId: string; readonly subjectKey: string; readonly periodStart: string },
    actor: Actor,
  ): Promise<{ readonly dueId: string }> {
    const { tenantId } = input;
    if (!(await this.deps.setting.isOn(tenantId))) throw new AutoBillingOff();
    const subject = (await this.deps.dues.subjectsFor(tenantId)).find((s) => subjectKey(s) === input.subjectKey);
    if (subject === undefined) throw new BillingEngagementNotFound(input.subjectKey.slice(2));
    if (subject.duePeriodStarts.includes(input.periodStart)) {
      throw new BillEarlyRefused("This period's bill is already on the list. Raise it from To raise.");
    }
    const planned = (await this.plan(tenantId, {}, subject)).find((p) => p.plan.period.start === input.periodStart);
    if (planned === undefined) {
      throw new BillEarlyRefused(
        "There is nothing to bill early for this period: its work is not done yet, or it is not a period of this service.",
      );
    }
    const manager = await billingManagerFor(this.deps.managers, {
      tenantId,
      partyId: subject.partyId,
      deptCodes: subject.engagements.map((e) => e.deptCode),
      today: await this.firmToday(tenantId),
    });
    const due: NewBillingDue = {
      id: this.deps.ids.newId(),
      partyId: subject.partyId,
      issuingEntityPartyId: subject.issuingEntityPartyId,
      currency: subject.currency,
      engagementId: subject.engagementId,
      feeGroupId: subject.feeGroupId,
      periodStart: planned.plan.period.start,
      periodEnd: planned.plan.period.end,
      periodLabel: billLabel(planned.plan),
      // Dated on the issuing company's day (0337), as the sweep dates it.
      billOn: planned.companyToday,
      datedByFilingId: planned.plan.datedBy?.id ?? null,
      fullAmount: subject.fullAmount,
      servedDays: planned.plan.servedDays,
      periodDays: planned.plan.periodDays,
      managerUserId: manager.userId,
      managerHow: manager.how,
      managerNote: manager.note,
    };
    const [created] = await this.deps.dues.insert(tenantId, [due]);
    if (created === undefined) {
      throw new BillEarlyRefused("This period's bill is already on the list. Raise it from To raise.");
    }
    await this.deps.events.recordEvent({
      tenantId,
      verb: "billing_due.created",
      objectId: due.id,
      actor,
      payload: {
        kind: "period",
        partyId: due.partyId,
        engagementId: due.engagementId,
        feeGroupId: due.feeGroupId,
        periodStart: due.periodStart,
        billOn: due.billOn,
        managerHow: due.managerHow,
        how: "billed_early",
        plannedBillOn: planned.plan.billOn,
        workKind: planned.work.kind,
        workId: planned.work.id,
        ...(due.datedByFilingId ? { datedByFilingId: due.datedByFilingId } : {}),
      },
    });
    return { dueId: due.id };
  }

  /**
   * Each subject's periods that have begun, have no bill, have a bill date
   * still ahead, and whose work is done; one entry per period, with the
   * latest work that finished it.
   */
  private async plan(
    tenantId: string,
    filter: { readonly jobId?: string | undefined; readonly workItemId?: string | undefined; readonly partyId?: string | undefined },
    only?: BillingSubject,
  ): Promise<readonly Planned[]> {
    const now = this.deps.clock.now().toISOString();
    const firmZone = await this.deps.timeZones.timeZoneFor(tenantId);
    const firmToday = dayInZone(now, firmZone);
    const firmYearStart = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const calendars = await this.deps.timeZones.companyCalendars(tenantId);
    const subjects =
      only !== undefined
        ? [only]
        : (await this.deps.dues.subjectsFor(tenantId)).filter(
            (s) => filter.partyId === undefined || s.partyId === filter.partyId,
          );
    if (subjects.length === 0) return [];
    const work = await this.deps.work.doneWork(tenantId, {
      since: addDays(firmToday, -LOOK_BACK_DAYS),
      jobId: filter.jobId,
      workItemId: filter.workItemId,
      partyId: only?.partyId ?? filter.partyId,
    });
    if (work.length === 0) return [];

    const out: Planned[] = [];
    for (const subject of subjects) {
      const recurrence = recurrenceOfService(subject.billingFrequency);
      if (recurrence === null) continue;
      const fiscalYear =
        subject.yearStartMonth ?? yearStartOfCompany(calendars, subject.issuingEntityPartyId, firmYearStart);
      if (recurrence !== "monthly" && fiscalYear === null) continue;
      const companyToday = dayInZone(now, zoneOfCompany(calendars, subject.issuingEntityPartyId, firmZone));
      const ids = new Set(subject.engagements.map((e) => e.engagementId));
      const mine = work.filter((w) => w.engagementIds.some((id) => ids.has(id)));
      if (mine.length === 0) continue;

      const span = monthsPerPeriod(recurrence);
      const count = Math.max(1, Math.floor(monthsBetween(subject.billingFrom, companyToday) / span) + 1);
      const periods = periodsFrom(subject.billingFrom, recurrence, count, fiscalYear ?? 1).filter(
        (p) => p.start <= companyToday,
      );
      // Every period's planned bill, as if every date had come: the sweep's
      // own arithmetic, so the date offered is the date it would have used.
      const plans = billingDues({
        periods,
        spanMonths: span,
        firstInvoiceOn: subject.firstInvoiceOn,
        today: "9999-12-31",
        windows: subject.engagements.map(serviceWindowOf),
        filings: subject.statutoryFilings ?? [],
      });
      const billed = new Set(subject.duePeriodStarts);
      for (const plan of plans) {
        if (billed.has(plan.period.start) || plan.billOn <= companyToday) continue;
        const done = mine
          .filter((w) => finishes(w, plan))
          .sort((a, b) => b.doneOn.localeCompare(a.doneOn) || a.id.localeCompare(b.id));
        const latest = done[0];
        if (latest !== undefined) out.push({ subject, plan, work: latest, companyToday });
      }
    }
    return out;
  }

  private async firmToday(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/** Whether this finished work is the work of this period: a job whose period
 *  begins inside it, the filing that dates its bill, or a filing whose own
 *  period ends inside it. */
function finishes(w: DoneWork, plan: BillingDuePlan): boolean {
  const { start, end } = plan.period;
  if (w.kind === "job") return start <= w.periodStart && w.periodStart <= end;
  if (plan.datedBy !== null) return plan.datedBy.id === w.id;
  return start <= w.periodEnd && w.periodEnd <= end;
}

export function subjectKey(s: Pick<BillingSubject, "engagementId" | "feeGroupId">): string {
  return s.feeGroupId !== null ? `g:${s.feeGroupId}` : `e:${s.engagementId ?? ""}`;
}

/** Whole calendar months from one day to another, ignoring the day of month. */
function monthsBetween(from: string, to: string): number {
  const [fy = 0, fm = 1] = from.split("-").map(Number);
  const [ty = 0, tm = 1] = to.split("-").map(Number);
  return ty * 12 + tm - (fy * 12 + fm);
}

function addDays(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
