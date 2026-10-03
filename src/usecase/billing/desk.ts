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
// priced in the same currency, and the number comes from the gapless series
// when the draft is issued (0322). Nothing here re-implements any of it. What
// this adds is the checks a SET of dues needs before a draft is made — one
// client, one company, one currency, one manager, an amount and a tax rate for
// each — because a refusal after the draft exists would leave a draft nobody
// asked for.
//
// Since 0322 the desk also drafts a signed letter's ADVANCE invoice by itself
// (`draftAdvance`), and holds the firm's advance settings: how the reminders
// run, and each company's default tax rate.
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { addDays, periodsFrom, recurrenceOfService } from "../../domain/scheduler/model";
import { isCalendarDay } from "../../domain/engagement/model";
import { scheduleNotice } from "../../domain/billing/model";
import { compareAmounts, isAmount, isExchangeRate } from "../../domain/money/model";
import {
  advancePolicyProblem,
  billLineText,
  shouldRefund,
  takeFromAdvance,
  type AdvancePolicy,
} from "../../domain/billing/advance";
import {
  AdvanceLinkNeedsAdmin,
  AdvanceNotSkippable,
  BillBusy,
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
  PriceNotVisible,
} from "../../domain/billing/errors";
import type {
  AdvanceDraftBlock,
  AdvancePolicySource,
  AutoBillingSetting,
  BillingDueDesk,
  BillingDueRecord,
  BillingSchedules,
  DueFilters,
  FirmTimeZone,
  FiscalYearSource,
  InvoiceDrafter,
  IssuerTaxDefaults,
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
  /** The companies' default tax rates (0322): what an automatic advance draft
   *  carries when the work was never invoiced. */
  readonly taxDefaults: IssuerTaxDefaults;
  /** The firm's advance reminder policy (0322). */
  readonly policy: AdvancePolicySource;
  /** Which parties are the firm's own companies: a default tax rate is set
   *  for one of them only. */
  readonly firmEntities: { isFirmEntity(tenantId: string, partyId: string): Promise<boolean> };
}

/** The firm's billing settings, as one screen shows them. */
export interface BillingSettings {
  readonly autoBilling: boolean;
  readonly advancePolicy: AdvancePolicy;
  readonly taxDefaults: readonly { readonly entityPartyId: string; readonly taxPercent: string }[];
  /** The firm's own payment terms in days (0327); null: none, never a guess. */
  readonly invoiceDueDays: number | null;
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
  /** The caller sees fees (the fee axis). Without it, a bill the letter priced
   *  is billed at the letter's price only (0321). Absent counts as not. */
  readonly callerSeesFees?: boolean | undefined;
}

/** The earliest and latest day a billing schedule may name (0321): a typo of a
 *  year (1900, 9999) is refused rather than silently stopping a client's bills. */
const EARLIEST_SCHEDULE_DAY = "2000-01-01";
const LATEST_SCHEDULE_DAY = "2099-12-31";

export class BillingDeskService {
  constructor(private readonly deps: DeskDeps) {}

  // ── Reading ──────────────────────────────────────────────────────────────

  /**
   * The dues, with how long each has waited: pending ones unless the filter
   * asks for others. `mineFor` narrows to what a person should act on: their
   * own open or drafted dues, and those of the people who report to them once
   * a week has passed.
   *
   * A BILL WITH NO PRICE is also the SPOC's (for that client and Dept, on the
   * firm's day) and every administrator's, from the day it falls due until an
   * amount is on a draft (Ashish, 2026-10-01: the SPOC, the manager and the
   * admin, in the app, every week). The weekly reminder is the screen counting
   * weeks from `daysSinceBillOn`; nothing is stored or sent.
   *
   * ALL OF IT IS DECIDED IN THE QUERY (review item 14), before the list's
   * ceiling: filtered here afterwards, a large firm's newest bills fell off
   * My day without a word. Advance bills are not in `mine`: since 0322 they
   * have reminders of their own (`AdvanceDesk.mine`).
   */
  async list(input: {
    readonly tenantId: string;
    readonly filters?: Omit<DueFilters, "mine">;
    readonly mineFor?: string | undefined;
    /** The caller holds `tenant:admin`; meaningful with `mineFor` only. */
    readonly mineIsAdmin?: boolean | undefined;
  }): Promise<{ readonly today: string; readonly dues: readonly DueOnDesk[] }> {
    const today = await this.today(input.tenantId);
    const rows = await this.deps.desk.list(input.tenantId, {
      ...input.filters,
      mine:
        input.mineFor === undefined
          ? undefined
          : {
              userId: input.mineFor,
              isAdmin: input.mineIsAdmin === true,
              today,
              escalateAfterDays: ESCALATE_AFTER_DAYS,
            },
    });
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
    return { today, dues };
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
   *
   * CLAIMED FIRST (0321): the bills, and the advance bills they take from, are
   * claimed before anything is read for the plan or a number is drawn, and let
   * go at the end. A second raise of the same bill, or of another bill spending
   * the same advance, is refused (`BILL_BUSY`) with nothing numbered; without it
   * two clicks made two invoices for one bill, and two raises both spent the last
   * of one advance.
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
    const seen = await this.deps.desk.findMany(input.tenantId, ids);
    for (const id of ids) {
      if (!seen.some((d) => d.id === id)) throw new BillingDueNotFound(id);
    }
    const first = [...ids, ...poolsOf(seen)];
    const token = await this.deps.desk.claim(input.tenantId, first);
    if (token === null) throw new BillBusy("one of these bills, or the advance it is taken off,");
    // Every claim this raise makes, each let go with its own token (B35).
    const claims: { ids: string[]; token: string }[] = [{ ids: first, token }];
    try {
      return await this.raiseClaimed(input, ids, claims, actor);
    } finally {
      for (const c of claims) await this.deps.desk.release(input.tenantId, c.ids, c.token);
    }
  }

  /** The raise itself, on bills (and advances) this request holds. Read again
   *  now that they are held: the plan is made from what is true, not from what
   *  was true before somebody else finished. */
  private async raiseClaimed(
    input: RaiseFromDuesInput,
    ids: readonly string[],
    claims: { ids: string[]; token: string }[],
    actor: Actor,
  ): Promise<{
    readonly invoiceId: string | null;
    readonly number: string | null;
    readonly covered: readonly string[];
    readonly conflicts: readonly string[];
  }> {
    const found = await this.deps.desk.findMany(input.tenantId, ids);
    for (const id of ids) {
      if (!found.some((d) => d.id === id)) throw new BillingDueNotFound(id);
    }
    // An advance a bill now takes from that was not held (another advance ran
    // out meanwhile): hold it too, or refuse.
    const extra = poolsOf(found).filter((id) => !claims.some((c) => c.ids.includes(id)));
    if (extra.length > 0) {
      const token = await this.deps.desk.claim(input.tenantId, extra);
      if (token === null) throw new BillBusy("the advance these bills are taken off");
      claims.push({ ids: extra, token });
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
      const typed = line.amount?.trim() ?? "";
      const amount = typed === "" ? d.amount : typed;
      if (amount === null || amount === "") throw new DueNeedsAnAmount(describeDue(d));
      if (!isAmount(amount)) {
        throw new InvalidBillingInput(`The amount for ${describeDue(d)} must be a number with at most four decimals.`);
      }
      // A bill is for something (0321): a zero invoice line is not a tax
      // invoice anybody should send. A bill that will not be billed is skipped.
      if (compareAmounts(amount, "0") <= 0) {
        throw new InvalidBillingInput(`The amount for ${describeDue(d)} must be more than zero. Skip the bill if it will not be billed.`);
      }
      // Changing a price the letter fixed is for somebody who can SEE it.
      const changed = d.amount !== null && compareAmounts(amount, d.amount) !== 0;
      if (changed && input.callerSeesFees !== true) throw new PriceNotVisible(describeDue(d));
      return { due: d, amount, tax, changedFrom: changed ? d.amount : null };
    });
    // Before anything is written: a refusal here leaves no bill covered and no
    // number drawn.
    const rate = this.rateFor(dues, input);

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

    // EVERY RULE FIRST, NOTHING WRITTEN (B34): the draft and each line are
    // checked and built here, then written with the bills they settle in ONE
    // transaction. It was several, so a crash or a refusal half-way left a
    // draft with some lines, or a "less advance" line on no bill.
    const draft =
      toInvoice.length === 0
        ? null
        : await this.deps.invoices.prepareDraft({
            tenantId: input.tenantId,
            partyId: first.party.id,
            entityPartyId: first.issuer.id,
            currency: first.currency,
            fxRate: rate.fxRate,
            fxRateDate: rate.fxRateDate,
            dueOn: input.dueOn,
            asOf: input.asOf,
            managerUserId: manager ?? undefined,
            managerFromBills: true,
          });
    const lines: { p: (typeof toInvoice)[number]; line: Awaited<ReturnType<InvoiceDrafter["prepareLine"]>> }[] = [];
    if (draft !== null) {
      for (const p of toInvoice) {
        const line = await this.deps.invoices.prepareLine(draft, {
          tenantId: input.tenantId,
          engagementId: p.due.engagementIds[0],
          description: lineDescription(p.due, p.applied === null ? null : { invoiceNumber: p.applied.invoiceNumber }),
          quantity: "1",
          unitAmount: p.balance,
          taxPercent: p.tax,
        });
        lines.push({ p, line });
      }
    }
    // Settled in the write's own WHERE: somebody who raised or skipped a due
    // in the same minute keeps their answer, and it is reported. The advance
    // each takes is re-checked there too, under a lock.
    const written = await this.deps.desk.raiseAtomically(input.tenantId, {
      draft,
      covered: coveredInFull.flatMap((p) => (p.applied === null ? [] : [{ dueId: p.due.id, applied: p.applied }])),
      invoiced: lines.map(({ p, line }) => ({
        dueId: p.due.id,
        line,
        applied: p.applied === null ? null : { invoiceId: p.applied.invoiceId, amount: p.applied.amount },
      })),
    });

    // The ledger, after the commit.
    for (const p of coveredInFull) {
      if (p.applied === null || !written.covered.includes(p.due.id)) continue;
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.covered",
        objectId: p.due.id,
        actor,
        payload: { advanceInvoiceId: p.applied.invoiceId, advanceApplied: p.applied.amount },
      });
    }
    const invoice = written.invoice;
    if (invoice !== null) await this.deps.invoices.recordRaised(invoice, actor);
    for (const { p } of lines) {
      const on = written.invoiced.find((w) => w.dueId === p.due.id);
      if (on === undefined || invoice === null) continue;
      const applied = p.applied === null ? null : { invoiceId: p.applied.invoiceId, amount: p.applied.amount };
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.invoiced",
        objectId: p.due.id,
        actor,
        payload: {
          invoiceId: invoice.id,
          invoiceLineId: on.lineId,
          how: "raised",
          ...(applied === null ? {} : { advanceInvoiceId: applied.invoiceId, advanceApplied: applied.amount }),
          // A price the letter fixed, billed at another figure (0321): both, so
          // "who changed it and from what" is answerable later.
          ...(p.changedFrom === null ? {} : { letterAmount: p.changedFrom, billedAmount: p.amount }),
        },
      });
    }
    return {
      invoiceId: invoice?.id ?? null,
      number: invoice?.number ?? null,
      covered: written.covered,
      conflicts: written.conflicts,
    };
  }

  /**
   * The bill was raised by hand: say which invoice it is on.
   *
   * THE INVOICE MUST BE THIS BILL'S (0321). Not another bill's advance invoice:
   * that money is the advance, taken off bills as they are raised, and linking
   * a period to it billed the period with it while it was still being taken off
   * later bills. And an ADVANCE bill is linked only by an admin, to an invoice
   * no other bill is on: the invoice it names becomes the advance every later
   * bill is taken off, so an old invoice for other work must not become one.
   */
  async link(
    input: {
      readonly tenantId: string;
      readonly dueId: string;
      readonly invoiceId: string;
      /** The caller holds `tenant:admin`: may link an advance bill. */
      readonly mayLinkAdvance?: boolean | undefined;
    },
    actor: Actor,
  ): Promise<void> {
    const token = await this.deps.desk.claim(input.tenantId, [input.dueId]);
    if (token === null) throw new BillBusy("this bill");
    try {
      await this.linkClaimed(input, actor);
    } finally {
      await this.deps.desk.release(input.tenantId, [input.dueId], token);
    }
  }

  private async linkClaimed(
    input: {
      readonly tenantId: string;
      readonly dueId: string;
      readonly invoiceId: string;
      readonly mayLinkAdvance?: boolean | undefined;
    },
    actor: Actor,
  ): Promise<void> {
    const due = await this.openDue(input.tenantId, input.dueId);
    if (due.kind === "advance" && input.mayLinkAdvance !== true) throw new AdvanceLinkNeedsAdmin();
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
    const use = await this.deps.desk.invoiceUse(input.tenantId, invoice.id);
    if (use.asAdvance) {
      throw new InvoiceDoesNotFitDue(
        "it is the advance invoice of another bill. That money is the advance, and it comes off bills as they are raised.",
      );
    }
    if (due.kind === "advance" && use.byBills > 0) {
      throw new InvoiceDoesNotFitDue("other bills are already on it, so it is not this advance's invoice.");
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
  }

  /**
   * The advance invoice, drafted the moment its bill exists (0322, Ashish:
   * "the invoice for advance should be created as draft invoice"). Through
   * `raise` like any other, so every invoice rule and the claim apply, and a
   * draft draws no number until an admin issues it (0322).
   *
   * Only a bill never on an invoice: one whose draft a person cancelled is
   * theirs to raise again. Not when an invoice raised by hand already bills
   * the work (very likely this advance, invoiced before 0322: Link it). The tax
   * rate is the last one on that work, else the issuing company's default;
   * with neither, nothing is drafted and the bill waits on To raise, never on
   * a guessed 0%.
   */
  async draftAdvance(
    tenantId: string,
    dueId: string,
    actor: Actor,
  ): Promise<{ readonly invoiceId: string } | { readonly blocked: AdvanceDraftBlock }> {
    const [due] = await this.deps.desk.advances(tenantId, { dueId });
    if (due === undefined) throw new BillingDueNotFound(dueId);
    if (due.kind !== "advance" || due.status !== "open" || due.invoice !== null) return { blocked: "not_open" };
    if (due.handRaised !== null) return { blocked: "billed_by_hand" };
    const tax =
      due.lastTaxPercent ??
      (await this.deps.taxDefaults.list(tenantId)).find((d) => d.entityPartyId === due.issuer.id)?.taxPercent ??
      null;
    if (tax === null) return { blocked: "no_tax_rate" };
    const raised = await this.raise({ tenantId, dueIds: [dueId], lines: [{ dueId, taxPercent: tax }] }, actor);
    return raised.invoiceId === null ? { blocked: "not_open" } : { invoiceId: raised.invoiceId };
  }

  /**
   * The firm decided this will not be billed. The reason is mandatory and
   * lives on the row only: it is prose about a client. Who may is the firm's
   * `billing:skip` permission (0321, checked at the route).
   *
   * An ADVANCE may be skipped once no work waits on it (0321): an engagement
   * ended before it started left its advance bill on the desk for good,
   * escalating, with no way to clear it.
   */
  async skip(
    input: { readonly tenantId: string; readonly dueId: string; readonly reason: string },
    actor: Actor,
  ): Promise<void> {
    const reason = input.reason.trim();
    if (reason.length === 0) throw new InvalidBillingInput("Say why this bill is being skipped.");
    if (reason.length > 500) throw new InvalidBillingInput("Keep the reason to 500 characters.");
    const token = await this.deps.desk.claim(input.tenantId, [input.dueId]);
    if (token === null) throw new BillBusy("this bill");
    try {
      const due = await this.openDue(input.tenantId, input.dueId);
      if (due.kind === "advance" && due.advanceHoldsWork) throw new AdvanceNotSkippable();
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
    } finally {
      await this.deps.desk.release(input.tenantId, [input.dueId], token);
    }
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
    // Held while the credit note is written (0321): a double click credited
    // the same remainder twice. The second waits out the claim, then finds
    // nothing left.
    const token = await this.deps.desk.claim(input.tenantId, [input.dueId]);
    if (token === null) throw new BillBusy("this advance");
    try {
      const c = await this.refundCandidate(input.tenantId, input.dueId);
      return await this.deps.invoices.issueCreditNote(
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
    } finally {
      await this.deps.desk.release(input.tenantId, [input.dueId], token);
    }
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
    const by = actor.id;
    const token = await this.deps.desk.claim(input.tenantId, [input.dueId]);
    if (token === null) throw new BillBusy("this advance");
    try {
      const c = await this.refundCandidate(input.tenantId, input.dueId);
      if (!(await this.deps.desk.waiveRefund(input.tenantId, c.advance.id, by, reason))) {
        throw new NothingToRefund("the firm has already decided to keep it.");
      }
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "billing_due.refund_kept",
        objectId: c.advance.id,
        actor,
        payload: { partyId: c.advance.party.id, invoiceId: c.invoice.id, remaining: c.remaining },
      });
    } finally {
      await this.deps.desk.release(input.tenantId, [input.dueId], token);
    }
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
  ): Promise<ScheduleRecord & { readonly notice: string | null }> {
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
        if (value < EARLIEST_SCHEDULE_DAY || value > LATEST_SCHEDULE_DAY) {
          throw new InvalidBillingInput(`The ${name} must be between ${EARLIEST_SCHEDULE_DAY} and ${LATEST_SCHEDULE_DAY}, not ${value}.`);
        }
      }
      const recurrence = recurrenceOfService(current.billingFrequency);
      if (recurrence === null) throw new NotBilledOnASchedule(current.billingFrequency ?? "unset");
      const fiscalYear = await this.deps.fiscalYears.fiscalYearStartMonth(input.tenantId);
      if (recurrence !== "monthly" && fiscalYear === null) throw new FiscalYearNeeded();
      const [period] = periodsFrom(input.billingFrom, recurrence, 1, fiscalYear ?? 1);
      billingFrom = period?.start ?? input.billingFrom;
      // An invoice dated before the period it bills has begun makes every
      // later bill fall due early, so one sweep bills months not yet begun (0321).
      if (input.firstInvoiceOn < billingFrom) {
        throw new InvalidBillingInput(
          `The first invoice cannot be dated before the first period it bills begins (${billingFrom}).`,
        );
      }
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
    // SAID, NOT HIDDEN (CA#35): a "Bill from" before the work started bills
    // nothing for those days, and the sweep used to just write no bill.
    return { ...after, notice: billingFrom === null ? null : scheduleNotice(billingFrom, after.effectiveFrom) };
  }

  // ── The switch, and the advance's settings ───────────────────────────────

  autoBilling(tenantId: string): Promise<boolean> {
    return this.deps.setting.isOn(tenantId);
  }

  async settings(tenantId: string): Promise<BillingSettings> {
    const [autoBilling, advancePolicy, taxDefaults, invoiceDueDays] = await Promise.all([
      this.deps.setting.isOn(tenantId),
      this.deps.policy.policyFor(tenantId),
      this.deps.taxDefaults.list(tenantId),
      this.deps.setting.dueInDays(tenantId),
    ]);
    return { autoBilling, advancePolicy, taxDefaults, invoiceDueDays };
  }

  /**
   * The firm's own payment terms (B20, 0327): an invoice issued with no due
   * date is due this many days after its date. Null clears it. No default:
   * 7, 15 or 30 days is the firm's commercial fact, not ours.
   */
  async setInvoiceDueDays(tenantId: string, days: number | null, actor: Actor): Promise<number | null> {
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) {
      throw new InvalidBillingInput("Payment terms are a whole number of days from 0 (due on receipt) to 365.");
    }
    const from = await this.deps.setting.dueInDays(tenantId);
    if (from === days) return days;
    await this.deps.setting.setDueInDays(tenantId, days);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "tenant.invoice_due_days_set",
      objectId: tenantId,
      actor,
      payload: { from, to: days },
    });
    return days;
  }

  /** How the firm's advances are chased (0322): its own numbers, checked. */
  async setAdvancePolicy(tenantId: string, policy: AdvancePolicy, actor: Actor): Promise<AdvancePolicy> {
    const problem = advancePolicyProblem(policy);
    if (problem !== null) throw new InvalidBillingInput(problem);
    const from = await this.deps.policy.policyFor(tenantId);
    const same =
      from.draftOverdueDays === policy.draftOverdueDays &&
      from.unpaidOverdueDays === policy.unpaidOverdueDays &&
      from.partnerMinRank === policy.partnerMinRank &&
      from.digestWeekday === policy.digestWeekday &&
      from.digestHour === policy.digestHour;
    if (same) return from;
    await this.deps.policy.setPolicy(tenantId, policy);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "tenant.advance_policy_set",
      objectId: tenantId,
      actor,
      payload: { from: { ...from }, to: { ...policy } },
    });
    return policy;
  }

  /** One of the firm's companies' default tax rate (0322): 0 to 100. */
  async setTaxDefault(
    input: { readonly tenantId: string; readonly entityPartyId: string; readonly taxPercent: string },
    actor: Actor,
  ): Promise<void> {
    const tax = input.taxPercent.trim();
    if (!isAmount(tax) || Number(tax) > 100) {
      throw new InvalidBillingInput("A default tax rate must be a percentage from 0 to 100.");
    }
    if (!(await this.deps.firmEntities.isFirmEntity(input.tenantId, input.entityPartyId))) {
      throw new InvalidBillingInput("A default tax rate is set for one of the firm's own companies.");
    }
    const from =
      (await this.deps.taxDefaults.list(input.tenantId)).find((d) => d.entityPartyId === input.entityPartyId)?.taxPercent ??
      null;
    if (from !== null && compareAmounts(from, tax) === 0) return;
    await this.deps.taxDefaults.set(input.tenantId, input.entityPartyId, tax);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "tenant.tax_default_set",
      objectId: input.tenantId,
      actor,
      payload: { entityPartyId: input.entityPartyId, from, to: tax },
    });
  }

  async setAutoBilling(tenantId: string, on: boolean, actor: Actor): Promise<boolean> {
    const from = await this.deps.setting.isOn(tenantId);
    if (from === on) return on;
    // The day it goes on (0321): final bills are written for work finished from it.
    await this.deps.setting.set(tenantId, on, await this.today(tenantId));
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
  advance: { readonly invoiceNumber: string } | null = null,
): string {
  return billLineText({
    kind: d.kind,
    serviceName: d.serviceName,
    periodLabel: d.periodLabel,
    servedDays: d.servedDays,
    periodDays: d.periodDays,
    letterRef: d.letter.ref,
    perService: d.engagementId !== null,
    advance,
  });
}

/** The advance bills these bills would be taken off, which a raise holds too. */
function poolsOf(dues: readonly BillingDueRecord[]): string[] {
  return [
    ...new Set(
      dues.flatMap((d) => (d.kind !== "advance" && d.advancePool !== null ? [d.advancePool.advanceDueId] : [])),
    ),
  ];
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
