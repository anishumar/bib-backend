// Billing (auto-invoice, phase 1) — the business rules, against ports. No I/O,
// no SQL, no HTTP.
//
// The firm's problem: work arrives on the board every month by itself, a bill
// only when somebody remembers it, and a forgotten bill is a service delivered
// for free. This sweep writes down WHAT IS OWED — a bill due per recurring
// engagement (or fee group) per period whose bill date has come — so a manager
// sees it, raises it, links it or says why not. It never writes an invoice:
// see `domain/billing` for why a due is not one.
//
// ── WHAT A PASS DOES ────────────────────────────────────────────────────────
//
// For every firm that turned auto-billing on, and every subject whose billing
// is set up: cut the periods from `billingFrom` at the letter's frequency (the
// scheduler's own `periodsFrom`, aligned to the firm's financial year), keep
// the ones whose bill date has come and that were served at all, drop the
// ones that already have a due, name the manager, and write the rest.
//
// ── IDEMPOTENT TWICE OVER ───────────────────────────────────────────────────
//
// The subject's `duePeriodStarts` is the anti-join, so an ordinary second pass
// writes nothing; under it the unique indexes refuse a second due for the same
// subject and period, and an event is recorded only for a row actually
// created. Two workers, or a redelivery, leave one due and one event.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { monthsPerPeriod, periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import { billingDues, serviceWindowOf } from "../../domain/billing/model";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AutoBillingFirms,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSubject,
  FirmTimeZone,
  FiscalYearSource,
  NewBillingDue,
} from "./ports";

export interface Deps {
  readonly dues: BillingDueWriter;
  readonly managers: BillingManagerFacts;
  readonly firms: AutoBillingFirms;
  readonly fiscalYears: FiscalYearSource;
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface BillingSweepReport {
  readonly tenantId: string;
  /** Dues written this pass. */
  readonly created: number;
  /** Dues the unique key refused: a race with another writer. Normally zero
   *  (the anti-join already filtered them); non-zero is idempotency working. */
  readonly alreadyDue: number;
  /** Quarterly or yearly subjects skipped because the firm has not said when
   *  its financial year starts: a quarter cannot be cut without it. */
  readonly awaitingFiscalYear: number;
  /** Why this firm could not be visited. One firm's failure never stops the
   *  others, and it is REPORTED rather than swallowed (T3.1's lesson). */
  readonly failure?: string;
}

/** How far back one subject may reach in one pass. A schedule set years in
 *  the past is a typo far more often than a decade of unbilled work, and the
 *  bound keeps one bad date from writing thousands of rows. */
const MAX_PERIODS_PER_SUBJECT = 60;

export class BillingService {
  constructor(private readonly deps: Deps) {}

  /** One pass over every firm with auto-billing on. */
  async sweep(): Promise<readonly BillingSweepReport[]> {
    const reports: BillingSweepReport[] = [];
    for (const tenantId of await this.deps.firms.firmsWithAutoBilling()) {
      try {
        reports.push(await this.sweepTenant(tenantId));
      } catch (err) {
        reports.push({
          tenantId,
          created: 0,
          alreadyDue: 0,
          awaitingFiscalYear: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string): Promise<BillingSweepReport> {
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const fiscalYearStartMonth = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const managers: ManagerCache = new Map();

    const planned: NewBillingDue[] = [];
    let awaitingFiscalYear = 0;
    for (const subject of await this.deps.dues.subjectsFor(tenantId)) {
      const recurrence = recurrenceOfService(subject.billingFrequency);
      if (recurrence === null) continue;
      if (recurrence !== "monthly" && fiscalYearStartMonth === null) {
        awaitingFiscalYear += 1;
        continue;
      }
      if (subject.firstInvoiceOn > today) continue;

      const span = monthsPerPeriod(recurrence);
      const count = Math.min(MAX_PERIODS_PER_SUBJECT, Math.floor(monthsBetween(subject.firstInvoiceOn, today) / span) + 1);
      const periods = periodsFrom(subject.billingFrom, recurrence, count, fiscalYearStartMonth ?? 1);
      const dues = billingDues({
        periods,
        spanMonths: span,
        firstInvoiceOn: subject.firstInvoiceOn,
        today,
        windows: subject.engagements.map(serviceWindowOf),
      }).filter((d) => !subject.duePeriodStarts.includes(d.period.start));
      if (dues.length === 0) continue;

      const manager = await this.managerFor(tenantId, subject, today, managers);
      for (const due of dues) {
        planned.push({
          id: this.deps.ids.newId(),
          partyId: subject.partyId,
          issuingEntityPartyId: subject.issuingEntityPartyId,
          currency: subject.currency,
          engagementId: subject.engagementId,
          feeGroupId: subject.feeGroupId,
          periodStart: due.period.start,
          periodEnd: due.period.end,
          periodLabel: due.period.label,
          billOn: due.billOn,
          fullAmount: subject.fullAmount,
          servedDays: due.servedDays,
          periodDays: due.periodDays,
          managerUserId: manager.userId,
          managerHow: manager.how,
          managerNote: manager.note,
        });
      }
    }

    const created = new Set(planned.length === 0 ? [] : await this.deps.dues.insert(tenantId, planned));
    for (const due of planned) {
      if (!created.has(due.id)) continue;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "billing_due.created",
        objectId: due.id,
        actor: SYSTEM_ACTOR,
        payload: {
          partyId: due.partyId,
          engagementId: due.engagementId,
          feeGroupId: due.feeGroupId,
          periodStart: due.periodStart,
          billOn: due.billOn,
          managerHow: due.managerHow,
        },
      });
    }
    return { tenantId, created: created.size, alreadyDue: planned.length - created.size, awaitingFiscalYear };
  }

  /** Whose kitty, asked once per client and set of Depts per pass. */
  private managerFor(tenantId: string, subject: BillingSubject, today: string, cache: ManagerCache) {
    return billingManagerFor(
      this.deps.managers,
      { tenantId, partyId: subject.partyId, deptCodes: subject.engagements.map((e) => e.deptCode), today },
      cache,
    );
  }
}

/** Whole calendar months from one day to another, ignoring the day of month. */
function monthsBetween(from: string, to: string): number {
  const [fy = 0, fm = 1] = from.split("-").map(Number);
  const [ty = 0, tm = 1] = to.split("-").map(Number);
  return ty * 12 + tm - (fy * 12 + fm);
}
