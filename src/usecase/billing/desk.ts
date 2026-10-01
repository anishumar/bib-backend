// The billing desk (auto-invoice, phase 1): what a PERSON does with a bill
// due. The sweep (`service.ts`) writes what is owed; this is where a manager
// turns dues into an invoice, links one raised by hand, or says why not, and
// where an engagement's schedule is set. No I/O, no SQL, no HTTP.
//
// ── EVERY INVOICE RULE STILL APPLIES ───────────────────────────────────────
//
// Raising goes through `InvoiceDrafter`, which `setup/` satisfies with the
// InvoiceService itself: the issuer must be the firm's, the client must not be,
// each line's engagement must be the client's, signed by the same company and
// priced in the same currency, and the number comes from the gapless series.
// Nothing here re-implements any of it. What this adds is the checks a SET of
// dues needs before a number is drawn — one client, one company, one currency,
// one manager, an amount and a tax rate for each — because a refusal after the
// draft exists would leave a numbered invoice behind.
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { addDays, periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import { isCalendarDay } from "../../domain/engagement/model";
import { compareAmounts, isAmount, isExchangeRate } from "../../domain/money/model";
import { billLineText, shouldRefund, takeFromAdvance } from "../../domain/billing/advance";
import {
  AdvanceNotSkippable,
  BillingDueNotFound,
  BillingDueNotOpen,
  BillingEngagementNotFound,
  BillingInvoiceNotFound,
  DueNeedsAnAmount,
  DuesDoNotShareAnInvoice,
  DuesOfDifferentManagers,
  FiscalYearNeeded,
  FxRateNeeded,
  InvalidBillingInput,
  InvoiceDoesNotFitDue,
  NotBilledOnASchedule,
  NothingToRefund,
} from "../../domain/billing/errors";
import type {
  AutoBillingSetting,
  BillingDueDesk,
  BillingDueRecord,
  BillingSchedules,
  DueFilters,
  FirmTimeZone,
  FiscalYearSource,
  InvoiceDrafter,
  RefundCandidate,
  ScheduleRecord,
} from "./ports";

export interface DeskDeps {
  readonly desk: BillingDueDesk;
  readonly invoices: InvoiceDrafter;
  readonly schedules: BillingSchedules;
  readonly setting: AutoBillingSetting;
  readonly fiscalYears: FiscalYearSource;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
  readonly events: EventSink;
  /** The advance gate (0320), told when an advance bill is linked to an
   *  invoice that may already be paid. Optional: absent, nothing is told. */
  readonly gate?: {
    moneyMoved(tenantId: string, invoiceId: string, actor: Actor): Promise<unknown>;
  } | null;
}

/** A week: an untouched bill then shows to the manager's own manager too
 *  (Ashish, 2026-10-01: "7 days is fine"). Computed on read, never stored. */
export const ESCALATE_AFTER_DAYS = 7;

/** At most this many dues on one invoice: one client's quarter of several
 *  services fits easily, and a slip of the hand that selected a whole list
 *  does not. */
const MAX_DUES_PER_INVOICE = 50;

const SCHEDULED_FREQUENCIES = ["monthly", "quarterly", "annually"];

export interface DueOnDesk extends BillingDueRecord {
  /** Whether the letter fixed a price. Not an amount, so never redacted: a
   *  bill with none must have its amount typed when raised. */
  readonly priced: boolean;
  /** Days since the bill date, on the firm's calendar. */
  readonly daysSinceBillOn: number;
  /** Still to be issued (open or drafted) a week or more after its date: it
   *  shows to the manager's own manager as well. */
  readonly escalated: boolean;
}

export interface UnscheduledRecord extends ScheduleRecord {
  /** The current period billed after it ends — the firm's default (arrears,
   *  Ashish 2026-10-01). Null when the period cannot be cut (a quarter with no
   *  financial year set). */
  readonly suggestion: {
    readonly billingFrom: string;
    readonly firstInvoiceOn: string;
    readonly periodLabel: string;
  } | null;
}

export interface RaiseFromDuesInput {
  readonly tenantId: string;
  readonly dueIds: readonly string[];
  /** One per due: the tax rate, and the amount when the letter fixed none or
   *  the manager bills a different one. */
  readonly lines: readonly {
    readonly dueId: string;
    readonly amount?: string | undefined;
    readonly taxPercent: string;
  }[];
  readonly fxRate?: string | undefined;
  readonly fxRateDate?: string | undefined;
  readonly dueOn?: string | undefined;
  readonly asOf?: string | undefined;
}

export class BillingDeskService {
  constructor(private readonly deps: DeskDeps) {}

  // ── Reading ──────────────────────────────────────────────────────────────

  /**
   * The dues, with how long each has waited. `mineFor` narrows to what a
   * person should act on: their own open or drafted dues, and those of the
   * people who report to them once a week has passed.
   *
   * A BILL WITH NO PRICE is also the SPOC's (for that client and Dept, on the
   * firm's day) and every administrator's, from the day it falls due until an
   * amount is on a draft (Ashish, 2026-10-01: the SPOC, the manager and the
   * admin, in the app, every week). The weekly reminder is the screen counting
   * weeks from `daysSinceBillOn`; nothing is stored or sent.
   */
  async list(input: {
    readonly tenantId: string;
    readonly filters?: DueFilters;
    readonly mineFor?: string | undefined;
    /** The caller holds `tenant:admin`; meaningful with `mineFor` only. */
    readonly mineIsAdmin?: boolean | undefined;
  }): Promise<{ readonly today: string; readonly dues: readonly DueOnDesk[] }> {
    const today = await this.today(input.tenantId);
    const rows = await this.deps.desk.list(input.tenantId, input.filters ?? {});
    const dues = rows.map((r): DueOnDesk => {
      const daysSinceBillOn = daysBetween(r.billOn, today);
      const pending = r.status === "open" || r.status === "drafted";
      return {
        ...r,
        priced: r.fullAmount !== null,
        daysSinceBillOn,
        escalated: pending && daysSinceBillOn >= ESCALATE_AFTER_DAYS,
      };
    });
    const mine = input.mineFor;
    if (mine === undefined) return { today, dues };

    const admin = input.mineIsAdmin === true;
    const unpriced = dues.some((d) => !d.priced && d.status === "open");
    const duties = unpriced && !admin ? await this.deps.desk.spocDutiesOf(input.tenantId, mine, today) : [];
    const spocFor = (d: DueOnDesk): boolean =>
      duties.some((s) => s.clientPartyId === d.party.id && d.deptCodes.includes(s.deptCode));
    return {
      today,
      dues: dues.filter(
        (d) =>
          (d.status === "open" || d.status === "drafted") &&
          (d.manager?.userId === mine ||
            (d.escalated && d.managerReportsTo?.userId === mine) ||
            (!d.priced && d.status === "open" && (admin || spocFor(d)))),
      ),
    };
  }

  /** Recurring engagements with no schedule, each with the default to offer. */
  async unscheduled(tenantId: string): Promise<readonly UnscheduledRecord[]> {
    const today = await this.today(tenantId);
    const fiscalYear = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const rows = await this.deps.schedules.unscheduled(tenantId);
    return rows
      .filter((r) => SCHEDULED_FREQUENCIES.includes(r.billingFrequency ?? ""))
      .map((r) => {
        const recurrence = recurrenceOfService(r.billingFrequency);
        if (recurrence === null || (recurrence !== "monthly" && fiscalYear === null)) {
          return { ...r, suggestion: null };
        }
        const from = r.effectiveFrom > today ? r.effectiveFrom : today;
        const [period] = periodsFrom(from, recurrence, 1, fiscalYear ?? 1);
        if (period === undefined) return { ...r, suggestion: null };
        return {
          ...r,
          suggestion: {
            billingFrom: period.start,
            firstInvoiceOn: addDays(period.end, 1),
            periodLabel: period.label,
          },
        };
      });
  }

  // ── Raising, linking, skipping ───────────────────────────────────────────

  /**
   * Raise one invoice from bills of one client, company, currency and manager.
   *
   * THE ADVANCE COMES OFF FIRST (0320): each bill is reduced by what is left of
   * its advance (the service's own, else the letter's), before tax, earliest
   * bill first; the line then bills the BALANCE and says what came off and from
   * which advance invoice. A bill the advance pays in full gets no line, and
   * when every bill is paid that way no invoice is raised at all, because even
   * a zero invoice draws a number from the gapless series. An ADVANCE bill is
   * raised on an invoice of its own: that invoice's money is the advance.
   */
  async raise(
    input: RaiseFromDuesInput,
    actor: Actor,
  ): Promise<{
    readonly invoiceId: string | null;
    readonly number: string | null;
    readonly covered: readonly string[];
    readonly conflicts: readonly string[];
  }> {
    const ids = [...new Set(input.dueIds)];
    if (ids.length === 0) throw new InvalidBillingInput("Pick at least one bill to raise.");
    if (ids.length > MAX_DUES_PER_INVOICE) {
      throw new InvalidBillingInput(`One invoice can carry at most ${String(MAX_DUES_PER_INVOICE)} bills.`);
    }
    const found = await this.deps.desk.findMany(input.tenantId, ids);
    for (const id of ids) {
      if (!found.some((d) => d.id === id)) throw new BillingDueNotFound(id);
    }
    const dues = [...found].sort(
      (a, b) =>
        a.billOn.localeCompare(b.billOn) ||
        a.periodStart.localeCompare(b.periodStart) ||
        a.serviceName.localeCompare(b.serviceName),
    );
    if (dues.length > 1 && dues.some((d) => d.kind === "advance")) {
      throw new InvalidBillingInput("An advance is raised on an invoice of its own: raise it alone.");
    }

    for (const d of dues) {
      if (d.status !== "open") throw new BillingDueNotOpen(describeDue(d), d.status);
    }
    const [first] = dues;
    if (first === undefined) throw new InvalidBillingInput("Pick at least one bill to raise.");
    if (dues.some((d) => d.party.id !== first.party.id)) throw new DuesDoNotShareAnInvoice("client");
    if (dues.some((d) => d.issuer.id !== first.issuer.id)) throw new DuesDoNotShareAnInvoice("company");
    if (dues.some((d) => d.currency !== first.currency)) throw new DuesDoNotShareAnInvoice("currency");
    const manager = first.manager?.userId ?? null;
    if (dues.some((d) => (d.manager?.userId ?? null) !== manager)) throw new DuesOfDifferentManagers();

    // An amount and a tax rate for every due, checked before a number is drawn.
    const priced = dues.map((d) => {
      const line = input.lines.find((l) => l.dueId === d.id);
      if (line === undefined) throw new InvalidBillingInput(`Give a tax rate for ${describeDue(d)} (0 if none).`);
      const tax = line.taxPercent.trim();
      if (!isAmount(tax) || Number(tax) > 100) {
        throw new InvalidBillingInput(`The tax rate for ${describeDue(d)} must be a percentage from 0 to 100.`);
      }
      const amount = line.amount?.trim() ?? d.amount;
      if (amount === null || amount === "") throw new DueNeedsAnAmount(describeDue(d));
      if (!isAmount(amount)) {
        throw new InvalidBillingInput(`The amount for ${describeDue(d)} must be a number with at most four decimals.`);
      }
      return { due: d, amount, tax };
    });

    // FIFO, before tax, on the digits: what each bill takes from its advance.
    const left = new Map<string, string>();
    const planned = priced.map((p) => {
      const pool = p.due.kind === "advance" ? null : p.due.advancePool;
      if (pool === null) return { ...p, applied: null, balance: p.amount };
      const taken = takeFromAdvance(left.get(pool.invoiceId) ?? pool.remaining, p.amount);
      left.set(pool.invoiceId, taken.remaining);
      return {
        ...p,
        applied:
          compareAmounts(taken.applied, "0") > 0
            ? { invoiceId: pool.invoiceId, invoiceNumber: pool.invoiceNumber, amount: taken.applied }
            : null,
        balance: taken.balance,
      };
    });
    const coveredInFull = planned.filter((p) => p.applied !== null && compareAmounts(p.balance, "0") === 0);
    const toInvoice = planned.filter((p) => !coveredInFull.includes(p));

    const conflicts: string[] = [];
    const covered: string[] = [];
    for (const p of coveredInFull) {
      if (p.applied === null) continue;
      if (!(await this.deps.desk.markCovered(input.tenantId, p.due.id, p.applied))) {
        conflicts.push(p.due.id);
        continue;
      }
      covered.push(p.due.id);
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.covered",
        objectId: p.due.id,
        actor,
        payload: { advanceInvoiceId: p.applied.invoiceId, advanceApplied: p.applied.amount },
      });
    }
    if (toInvoice.length === 0) return { invoiceId: null, number: null, covered, conflicts };

    const rate = this.rateFor(dues, input);

    const invoice = await this.deps.invoices.raise(
      {
        tenantId: input.tenantId,
        partyId: first.party.id,
        entityPartyId: first.issuer.id,
        currency: first.currency,
        fxRate: rate.fxRate,
        fxRateDate: rate.fxRateDate,
        dueOn: input.dueOn,
        asOf: input.asOf,
        managerUserId: manager ?? undefined,
      },
      actor,
    );

    for (const p of toInvoice) {
      const line = await this.deps.invoices.addLine({
        tenantId: input.tenantId,
        invoiceId: invoice.id,
        engagementId: p.due.engagementIds[0],
        description: lineDescription(
          p.due,
          p.applied === null ? null : { fee: p.amount, applied: p.applied.amount, invoiceNumber: p.applied.invoiceNumber },
        ),
        quantity: "1",
        unitAmount: p.balance,
        taxPercent: p.tax,
      });
      // Settled in the write's own WHERE: somebody who raised or skipped this
      // due in the same minute keeps their answer, and it is reported. The
      // advance it took is re-checked there too, under a lock.
      const applied = p.applied === null ? null : { invoiceId: p.applied.invoiceId, amount: p.applied.amount };
      if (!(await this.deps.desk.markInvoiced(input.tenantId, p.due.id, invoice.id, line.id, applied))) {
        conflicts.push(p.due.id);
        continue;
      }
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.invoiced",
        objectId: p.due.id,
        actor,
        payload: {
          invoiceId: invoice.id,
          invoiceLineId: line.id,
          how: "raised",
          ...(applied === null ? {} : { advanceInvoiceId: applied.invoiceId, advanceApplied: applied.amount }),
        },
      });
    }
    return { invoiceId: invoice.id, number: invoice.number, covered, conflicts };
  }

  /** The bill was raised by hand: say which invoice it is on. */
  async link(
    input: { readonly tenantId: string; readonly dueId: string; readonly invoiceId: string },
    actor: Actor,
  ): Promise<void> {
    const due = await this.openDue(input.tenantId, input.dueId);
    const invoice = await this.deps.invoices.find(input.tenantId, input.invoiceId);
    if (invoice === null) throw new BillingInvoiceNotFound(input.invoiceId);
    if (invoice.status === "cancelled") throw new InvoiceDoesNotFitDue("it was cancelled.");
    if (invoice.partyId !== due.party.id) throw new InvoiceDoesNotFitDue(`it bills another client, not ${due.party.displayName}.`);
    if (invoice.entityPartyId !== due.issuer.id) {
      throw new InvoiceDoesNotFitDue(`it is charged by another company, not ${due.issuer.displayName}.`);
    }
    if (invoice.currency !== due.currency) {
      throw new InvoiceDoesNotFitDue(`it is in ${invoice.currency}, and this bill is in ${due.currency}.`);
    }
    if (!(await this.deps.desk.markInvoiced(input.tenantId, due.id, invoice.id, null))) {
      throw new BillingDueNotOpen(describeDue(due), "drafted");
    }
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "billing_due.invoiced",
      objectId: due.id,
      actor,
      payload: { invoiceId: invoice.id, invoiceLineId: null, how: "linked" },
    });
    // An advance linked to an invoice already paid starts its work now (0320).
    // After the link is committed, and never undoing it.
    if (due.kind === "advance" && this.deps.gate) {
      try {
        await this.deps.gate.moneyMoved(input.tenantId, invoice.id, actor);
      } catch {
        // The admin's Approve start is the way on from here.
      }
    }
  }

  /** The firm decided this will not be billed. The reason is mandatory and
   *  lives on the row only: it is prose about a client. */
  async skip(
    input: { readonly tenantId: string; readonly dueId: string; readonly reason: string },
    actor: Actor,
  ): Promise<void> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new InvalidBillingInput("Say why this bill is being skipped.");
    if (reason.length > 500) throw new InvalidBillingInput("Keep the reason to 500 characters.");
    const due = await this.openDue(input.tenantId, input.dueId);
    if (due.kind === "advance") throw new AdvanceNotSkippable();
    const by = actor.type === "human" ? actor.id : null;
    if (!(await this.deps.desk.skip(input.tenantId, due.id, by, reason))) {
      throw new BillingDueNotOpen(describeDue(due), "skipped");
    }
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "billing_due.skipped",
      objectId: due.id,
      actor,
      payload: { partyId: due.party.id, periodStart: due.periodStart },
    });
  }

  // ── Giving an unused advance back (0320) ─────────────────────────────────

  /** Advances with some left once the work they covered is finished, and not
   *  kept by the firm: the "To refund" list. */
  async refunds(tenantId: string): Promise<readonly RefundCandidate[]> {
    return (await this.deps.desk.refundCandidates(tenantId)).filter((c) =>
      shouldRefund({ remaining: c.remaining, finished: c.finished, waived: c.waived !== null }),
    );
  }

  /** Give it back: a credit note on the advance invoice, reason
   *  `advance_refund`, for what is left with its share of the tax. The money
   *  itself goes back as a negative payment, as any refund does. */
  async refund(
    input: { readonly tenantId: string; readonly dueId: string; readonly asOf?: string | undefined },
    actor: Actor,
  ): Promise<{ readonly id: string; readonly number: string }> {
    const c = await this.refundCandidate(input.tenantId, input.dueId);
    return this.deps.invoices.issueCreditNote(
      {
        tenantId: input.tenantId,
        invoiceId: c.invoice.id,
        amount: c.refundAmount,
        reason: "advance_refund",
        note: `Advance not used under ${c.advance.letter.ref}.`,
        asOf: input.asOf,
      },
      actor,
    );
  }

  /** The firm keeps the advance (a cancellation fee, say): the reason is on
   *  the bill, and it leaves the list. */
  async keepAdvance(
    input: { readonly tenantId: string; readonly dueId: string; readonly reason: string },
    actor: Actor,
  ): Promise<void> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new InvalidBillingInput("Say why the firm is keeping this advance.");
    if (reason.length > 500) throw new InvalidBillingInput("Keep the reason to 500 characters.");
    if (actor.type !== "human" || actor.id === null) throw new InvalidBillingInput("A person decides to keep an advance.");
    const c = await this.refundCandidate(input.tenantId, input.dueId);
    if (!(await this.deps.desk.waiveRefund(input.tenantId, c.advance.id, actor.id, reason))) {
      throw new NothingToRefund("the firm has already decided to keep it.");
    }
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "billing_due.refund_kept",
      objectId: c.advance.id,
      actor,
      payload: { partyId: c.advance.party.id, invoiceId: c.invoice.id, remaining: c.remaining },
    });
  }

  private async refundCandidate(tenantId: string, dueId: string): Promise<RefundCandidate> {
    const [c] = await this.deps.desk.refundCandidates(tenantId, { dueId });
    if (c === undefined) throw new BillingDueNotFound(dueId);
    if (c.waived !== null) throw new NothingToRefund("the firm decided to keep it.");
    if (!c.finished) throw new NothingToRefund("the work it covered is not finished, so a later bill may still use it.");
    if (!shouldRefund({ remaining: c.remaining, finished: c.finished, waived: false })) {
      throw new NothingToRefund("all of it has been used by bills.");
    }
    return c;
  }

  // ── The schedule ─────────────────────────────────────────────────────────

  /**
   * Set (or clear, with both null) an engagement's schedule: the first period
   * billed and the date its invoice falls due. Snapped to the first day of
   * that period, and applied to every engagement of a fee group together,
   * because a group is billed once.
   */
  async setSchedule(
    input: {
      readonly tenantId: string;
      readonly engagementId: string;
      readonly billingFrom: string | null;
      readonly firstInvoiceOn: string | null;
    },
    actor: Actor,
  ): Promise<ScheduleRecord> {
    const current = await this.deps.schedules.find(input.tenantId, input.engagementId);
    if (current === null) throw new BillingEngagementNotFound(input.engagementId);

    let billingFrom: string | null = null;
    let firstInvoiceOn: string | null = null;
    if (input.billingFrom !== null || input.firstInvoiceOn !== null) {
      if (input.billingFrom === null || input.firstInvoiceOn === null) {
        throw new InvalidBillingInput("Give both the first period billed and the date its invoice falls due, or neither.");
      }
      for (const [name, value] of [["first period", input.billingFrom], ["first invoice date", input.firstInvoiceOn]] as const) {
        if (!isCalendarDay(value)) throw new InvalidBillingInput(`The ${name} must be a real date (YYYY-MM-DD), not ${value}.`);
      }
      const recurrence = recurrenceOfService(current.billingFrequency);
      if (recurrence === null) throw new NotBilledOnASchedule(current.billingFrequency ?? "unset");
      const fiscalYear = await this.deps.fiscalYears.fiscalYearStartMonth(input.tenantId);
      if (recurrence !== "monthly" && fiscalYear === null) throw new FiscalYearNeeded();
      const [period] = periodsFrom(input.billingFrom, recurrence, 1, fiscalYear ?? 1);
      billingFrom = period?.start ?? input.billingFrom;
      firstInvoiceOn = input.firstInvoiceOn;
    }

    const ids =
      current.feeGroup === null
        ? [current.engagementId]
        : await this.deps.schedules.groupMembers(input.tenantId, current.feeGroup.id);
    const before = await Promise.all(ids.map((id) => this.deps.schedules.find(input.tenantId, id)));
    await this.deps.schedules.set(input.tenantId, ids, billingFrom, firstInvoiceOn);
    for (const [i, id] of ids.entries()) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "engagement.billing_scheduled",
        objectId: id,
        actor,
        payload: {
          billingFrom,
          firstInvoiceOn,
          previousBillingFrom: before[i]?.billingFrom ?? null,
          previousFirstInvoiceOn: before[i]?.firstInvoiceOn ?? null,
          how: "by_hand",
        },
      });
    }
    const after = await this.deps.schedules.find(input.tenantId, input.engagementId);
    if (after === null) throw new BillingEngagementNotFound(input.engagementId);
    return after;
  }

  // ── The switch ───────────────────────────────────────────────────────────

  autoBilling(tenantId: string): Promise<boolean> {
    return this.deps.setting.isOn(tenantId);
  }

  async setAutoBilling(tenantId: string, on: boolean, actor: Actor): Promise<boolean> {
    const from = await this.deps.setting.isOn(tenantId);
    if (from === on) return on;
    await this.deps.setting.set(tenantId, on);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "tenant.auto_billing_set",
      objectId: tenantId,
      actor,
      payload: { from, to: on },
    });
    return on;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async openDue(tenantId: string, dueId: string): Promise<BillingDueRecord> {
    const [due] = await this.deps.desk.findMany(tenantId, [dueId]);
    if (due === undefined) throw new BillingDueNotFound(dueId);
    if (due.status !== "open") throw new BillingDueNotOpen(describeDue(due), due.status);
    return due;
  }

  /** The caller's rate, or the one rate every due's letter was struck at. */
  private rateFor(
    dues: readonly BillingDueRecord[],
    input: RaiseFromDuesInput,
  ): { readonly fxRate: string; readonly fxRateDate: string } {
    if (input.fxRate !== undefined || input.fxRateDate !== undefined) {
      const fxRate = input.fxRate?.trim() ?? "";
      const fxRateDate = input.fxRateDate?.trim() ?? "";
      if (!isExchangeRate(fxRate) || Number(fxRate) <= 0) {
        throw new InvalidBillingInput("The exchange rate must be a number above zero.");
      }
      if (!isCalendarDay(fxRateDate)) throw new InvalidBillingInput("Give the date of the exchange rate (YYYY-MM-DD).");
      return { fxRate, fxRateDate };
    }
    const rates = new Map(dues.map((d) => [`${d.letter.fxRate}|${d.letter.fxRateDate}`, d.letter]));
    const [only, ...more] = [...rates.values()];
    if (only === undefined || more.length > 0) throw new FxRateNeeded();
    return { fxRate: only.fxRate, fxRateDate: only.fxRateDate };
  }

  private async today(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/** "Bookkeeping, Oct 2026", the days when the period was cut short, and the
 *  advance it was reduced by (0320). */
export function lineDescription(
  d: BillingDueRecord,
  advance: { readonly fee: string; readonly applied: string; readonly invoiceNumber: string } | null = null,
): string {
  return billLineText({
    kind: d.kind,
    serviceName: d.serviceName,
    periodLabel: d.periodLabel,
    servedDays: d.servedDays,
    periodDays: d.periodDays,
    letterRef: d.letter.ref,
    currency: d.currency,
    perService: d.engagementId !== null,
    advance,
  });
}

function describeDue(d: BillingDueRecord): string {
  return `${d.serviceName} for ${d.periodLabel}`;
}

function daysBetween(from: string, to: string): number {
  const ms = (s: string): number => {
    const [y = 0, m = 1, day = 1] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}
