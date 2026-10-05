// The ad-hoc advance (0363, Q044-Q048): raised before the engagement letter,
// on "Advances to be adjusted" until a person maps it to the work it pays for,
// or a letter that names it is signed. No I/O, no SQL. The firm's rules are in
// `domain/billing/adhoc-advance.ts`'s header.
//
// THE INVOICE IS AN ORDINARY TAX INVOICE. It is drafted through invoicing's
// own rules (`InvoiceDrafter.prepareDraft` / `prepareLine`: the issuer is one
// of the firm's companies, the client is not, the rate rule, the manager),
// numbered when it is issued (0322), filed as the copy of record at issue. How
// it is laid out and taxed is invoicing's; nothing here changes it.
//
// A MAP IS CHECKED HERE AND HELD BY THE DATABASE. The use case refuses with a
// sentence (another client's work, another company's, another currency, a job
// not of that service, more than is left); the repository re-reads what is
// left under the advance's lock and writes nothing when it no longer fits; a
// trigger refuses a target of another client, company or currency for every
// writer.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { Invoice } from "../../domain/invoice/model";
import { dayInZone } from "../../domain/scheduler/zone";
import { compareAmounts, isAmount, normalizeCurrency } from "../../domain/money/model";
import {
  adhocAdvanceLineText,
  allocationProblem,
  letterMapAmount,
} from "../../domain/billing/adhoc-advance";
import {
  AdvanceFeesNotVisible,
  AdvanceInAnotherCurrency,
  AdvanceJobNotOfService,
  AdvanceNotFound,
  AdvanceNotIssued,
  AdvanceOfAnotherClient,
  AdvanceOfAnotherIssuer,
  AdvanceOverMapped,
  AdvanceTargetNotLive,
  AllocationEnded,
  AllocationNotFound,
  AllocationUsedUp,
  BillingEngagementNotFound,
  InvalidBillingInput,
  NothingToRefund,
} from "../../domain/billing/errors";
import { billingManagerFor, type ManagerCache } from "./manager";
import type {
  AdhocAdvanceFilters,
  AdhocAdvanceRecord,
  AdhocAdvanceStore,
  AllocationTargetFacts,
  BillingManagerFacts,
  ClientServiceForAdvance,
  FirmTimeZone,
  InvoiceDrafter,
  IssuerTaxDefaults,
  NewAllocation,
} from "./ports";

export interface AdhocAdvanceDeps {
  readonly store: AdhocAdvanceStore;
  readonly invoices: InvoiceDrafter;
  readonly taxDefaults: IssuerTaxDefaults;
  readonly managers: BillingManagerFacts;
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** Engagements an advance may still come off: the work is on, or may be. */
const LIVE_STATUSES = ["active", "paused", "pending_advance", "completed"];

/** One request maps at most this many targets. */
export const MAX_TARGETS_PER_MAP = 20;

export interface RaiseAdhocAdvanceInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  /** Before tax. */
  readonly amount: string;
  /** The issuing company's default when absent (0322's field). */
  readonly taxPercent?: string | undefined;
  readonly fxRate?: string | undefined;
  readonly fxRateDate?: string | undefined;
  readonly dueOn?: string | undefined;
  /** Whose revenue the unmapped part is. Absent: the client's Key Manager,
   *  else the person raising it. */
  readonly managerUserId?: string | undefined;
  readonly note?: string | undefined;
  readonly asOf?: string | undefined;
  readonly callerSeesFees: boolean;
}

export interface MapAdhocAdvanceInput {
  readonly tenantId: string;
  readonly advanceId: string;
  readonly targets: readonly { readonly engagementId: string; readonly jobId?: string | undefined; readonly amount: string }[];
  readonly reason: string;
  readonly callerSeesFees: boolean;
}

export class AdhocAdvanceService {
  constructor(private readonly deps: AdhocAdvanceDeps) {}

  // ── Raise ────────────────────────────────────────────────────────────────

  /**
   * A DRAFT advance invoice for a client with no letter yet, and its row on
   * the list. Somebody with `invoice:issue` issues it; then it can be mapped.
   */
  async raise(input: RaiseAdhocAdvanceInput, actor: Actor): Promise<{ readonly advanceId: string; readonly invoice: Invoice }> {
    if (!input.callerSeesFees) throw new AdvanceFeesNotVisible();
    const raiser = humanOf(actor, "raises an advance");
    const amount = input.amount.trim();
    if (!isAmount(amount) || compareAmounts(amount, "0") <= 0) {
      throw new InvalidBillingInput("The advance must be an amount above zero, with at most four decimals.");
    }
    const note = input.note?.trim() ?? "";
    if (note.length > 500) throw new InvalidBillingInput("Keep the note to 500 characters.");
    const tax = (input.taxPercent?.trim() ?? "") || (await this.defaultTax(input.tenantId, input.entityPartyId));
    if (tax === null) {
      throw new InvalidBillingInput(
        "Give the advance a tax rate (0 if none): this company has no default tax rate. " +
          "Set one in Your firm, Billing, to have it filled in.",
      );
    }
    if (!isAmount(tax) || Number(tax) > 100) {
      throw new InvalidBillingInput("The tax rate must be a percentage from 0 to 100.");
    }

    // Whose revenue: the person's pick (checked against the roster), else the
    // client's Key Manager (the firm's own record), else the raiser.
    const picked = input.managerUserId?.trim() || undefined;
    const keyManager =
      picked === undefined
        ? await this.deps.managers.keyManagerFor(input.tenantId, input.partyId, await this.firmDay(input.tenantId))
        : null;
    const draft = await this.deps.invoices.prepareDraft({
      tenantId: input.tenantId,
      partyId: input.partyId,
      entityPartyId: input.entityPartyId,
      currency: input.currency,
      fxRate: input.fxRate ?? "",
      fxRateDate: input.fxRateDate ?? "",
      dueOn: input.dueOn,
      asOf: input.asOf,
      managerUserId: picked ?? keyManager?.userId ?? raiser,
      managerFromBills: picked === undefined,
    });
    const line = await this.deps.invoices.prepareLine(draft, {
      tenantId: input.tenantId,
      description: adhocAdvanceLineText(note === "" ? null : note),
      quantity: "1",
      unitAmount: amount,
      taxPercent: tax,
    });
    const advanceId = this.deps.ids.newId();
    const invoice = await this.deps.store.raiseAtomically(input.tenantId, {
      draft,
      line,
      advance: {
        id: advanceId,
        tenantId: input.tenantId,
        invoiceId: draft.id,
        currency: normalizeCurrency(input.currency),
        note: note === "" ? null : note,
        raisedByUserId: raiser,
      },
    });

    await this.deps.invoices.recordRaised(invoice, actor);
    // The draft's GST split and TDS (Q056), as the billing desk does after it
    // writes one: an advance is a tax invoice like any other.
    await this.deps.invoices.refreshTax(input.tenantId, invoice.id);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "adhoc_advance.raised",
      objectId: advanceId,
      actor,
      // Ids and machine facts; the note is a person's words and stays on the row.
      payload: {
        invoiceId: invoice.id,
        partyId: invoice.partyId,
        entityPartyId: invoice.entityPartyId,
        currency: invoice.currency,
        managerUserId: invoice.managerUserId,
      },
    });
    return { advanceId, invoice };
  }

  list(tenantId: string, filters: AdhocAdvanceFilters): Promise<readonly AdhocAdvanceRecord[]> {
    return this.deps.store.list(tenantId, filters);
  }

  async get(tenantId: string, advanceId: string): Promise<AdhocAdvanceRecord> {
    const [found] = await this.deps.store.list(tenantId, { status: "all", advanceId });
    if (found === undefined) throw new AdvanceNotFound(advanceId);
    return found;
  }

  /**
   * The client's services, each saying whether this advance may be mapped to
   * it and, when not, why (in the refusal's own words): what the map dialog
   * offers. Another currency or company is listed, not hidden, so the person
   * sees why it cannot be picked.
   */
  async targetsFor(
    tenantId: string,
    advanceId: string,
  ): Promise<readonly (ClientServiceForAdvance & { readonly refusal: string | null })[]> {
    const advance = await this.get(tenantId, advanceId);
    const services = await this.deps.store.servicesOf(tenantId, advance.party.id);
    return services.map((s) => {
      try {
        this.checkTarget(advance, s);
        return { ...s, refusal: null };
      } catch (err) {
        return { ...s, refusal: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  // ── Map, and end a mapping ───────────────────────────────────────────────

  /**
   * Split what is left of an advance across services (and optionally one job
   * of each). Each part then comes off that work's earliest bills, before tax,
   * as the letter's own advance does; each is in its service's manager's
   * revenue (Q045). Always through a service (the user, 2026-10-05).
   */
  async map(input: MapAdhocAdvanceInput, actor: Actor): Promise<AdhocAdvanceRecord> {
    if (!input.callerSeesFees) throw new AdvanceFeesNotVisible();
    const by = humanOf(actor, "maps an advance");
    const reason = input.reason.trim();
    if (reason === "") throw new InvalidBillingInput("Say why it is mapped this way: it stays on the record.");
    if (reason.length > 500) throw new InvalidBillingInput("Keep the reason to 500 characters.");
    if (input.targets.length === 0) throw new InvalidBillingInput("Pick at least one service to map it to.");
    if (input.targets.length > MAX_TARGETS_PER_MAP) {
      throw new InvalidBillingInput(`Map it to at most ${String(MAX_TARGETS_PER_MAP)} services at a time.`);
    }

    const advance = await this.get(input.tenantId, input.advanceId);
    if (advance.invoice.status !== "issued" || advance.unmapped === null) {
      throw new AdvanceNotIssued(advance.invoice.status);
    }
    const targets = input.targets.map((t) => ({
      engagementId: t.engagementId,
      jobId: t.jobId?.trim() || null,
      amount: t.amount.trim(),
    }));
    const problem = allocationProblem({
      unmapped: advance.unmapped,
      targets: targets.map((t) => ({ key: `${t.engagementId}|${t.jobId ?? ""}`, amount: t.amount })),
    });
    switch (problem.kind) {
      case "not_an_amount":
        throw new InvalidBillingInput(`"${problem.amount}" is not an amount: use digits, with at most four decimals.`);
      case "not_above_zero":
        throw new InvalidBillingInput("Each amount must be above zero.");
      case "same_target_twice":
        throw new InvalidBillingInput("Each service (or job) appears once: put its whole amount on one row.");
      case "over":
        throw new AdvanceOverMapped(problem.asked, problem.unmapped, advance.currency);
      case "none":
        break;
    }

    const facts = await this.deps.store.targets(
      input.tenantId,
      [...new Set(targets.map((t) => t.engagementId))],
    );
    const jobIds = targets.flatMap((t) => (t.jobId === null ? [] : [t.jobId]));
    const jobs = jobIds.length === 0 ? [] : await this.deps.store.jobs(input.tenantId, jobIds);
    const today = await this.firmDay(input.tenantId);
    const cache: ManagerCache = new Map();
    const rows: NewAllocation[] = [];
    for (const t of targets) {
      const f = facts.find((x) => x.engagementId === t.engagementId);
      if (f === undefined) throw new BillingEngagementNotFound(t.engagementId);
      this.checkTarget(advance, f);
      if (t.jobId !== null && jobs.find((j) => j.jobId === t.jobId)?.engagementId !== t.engagementId) {
        throw new AdvanceJobNotOfService();
      }
      const manager = await billingManagerFor(
        this.deps.managers,
        { tenantId: input.tenantId, partyId: f.partyId, deptCodes: [f.deptCode], today },
        cache,
      );
      rows.push({
        id: this.deps.ids.newId(),
        engagementId: t.engagementId,
        jobId: t.jobId,
        engagementLetterId: null,
        amount: t.amount,
        managerUserId: manager.userId,
        how: "by_hand",
        reason,
        createdByUserId: by,
      });
    }

    const outcome = await this.deps.store.map(input.tenantId, advance.id, rows);
    if ("notIssued" in outcome) throw new AdvanceNotIssued(outcome.notIssued);
    if ("over" in outcome) throw new AdvanceOverMapped(outcome.over.asked, outcome.over.unmapped, advance.currency);
    for (const w of outcome.written) {
      const row = rows.find((r) => r.id === w.id);
      if (row === undefined) continue;
      await this.recordMapped(input.tenantId, advance, row, w.amount, actor);
    }
    return this.get(input.tenantId, advance.id);
  }

  /**
   * End a mapping, to map it elsewhere or give it back: what that work's bills
   * already took stays mapped, the rest is unmapped again.
   */
  async end(
    input: { readonly tenantId: string; readonly advanceId: string; readonly allocationId: string; readonly reason: string },
    actor: Actor,
  ): Promise<AdhocAdvanceRecord> {
    const by = humanOf(actor, "ends a mapping");
    const reason = input.reason.trim();
    if (reason === "") throw new InvalidBillingInput("Say why this mapping is ended: it stays on the record.");
    if (reason.length > 500) throw new InvalidBillingInput("Keep the reason to 500 characters.");
    const advance = await this.get(input.tenantId, input.advanceId);
    if (!advance.allocations.some((a) => a.id === input.allocationId)) throw new AllocationNotFound(input.allocationId);
    const outcome = await this.deps.store.end(input.tenantId, advance.id, input.allocationId, { byUserId: by, reason });
    if (outcome === null) throw new AllocationNotFound(input.allocationId);
    if ("usedUp" in outcome) throw new AllocationUsedUp();
    if ("alreadyEnded" in outcome) throw new AllocationEnded();
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "advance_allocation.ended",
      objectId: input.allocationId,
      actor,
      payload: {
        adhocAdvanceId: advance.id,
        invoiceId: advance.invoice.id,
        kept: outcome.ended.kept,
        freed: outcome.ended.freed,
        currency: advance.currency,
      },
    });
    return this.get(input.tenantId, advance.id);
  }

  // ── The letter never came: give it back ──────────────────────────────────

  /**
   * A credit note on the advance invoice for what is mapped nowhere, with its
   * share of the tax (reason `advance_refund`). The money then goes back as a
   * negative payment, as every refund does. Mapped parts are ended first.
   */
  async giveBack(
    input: { readonly tenantId: string; readonly advanceId: string; readonly asOf?: string | undefined },
    actor: Actor,
  ): Promise<{ readonly creditNoteId: string; readonly number: string }> {
    const advance = await this.get(input.tenantId, input.advanceId);
    if (advance.invoice.status !== "issued") throw new AdvanceNotIssued(advance.invoice.status);
    if (advance.refundAmount === null || compareAmounts(advance.refundAmount, "0") <= 0) {
      throw new NothingToRefund("all of it is mapped to services. End a mapping first to give that part back.");
    }
    const credit = await this.deps.invoices.issueCreditNote(
      {
        tenantId: input.tenantId,
        invoiceId: advance.invoice.id,
        amount: advance.refundAmount,
        reason: "advance_refund",
        note: "Advance taken before an engagement letter, given back.",
        asOf: input.asOf,
      },
      actor,
    );
    return { creditNoteId: credit.id, number: credit.number };
  }

  // ── Scenario 1 (Q048): the letter names it ───────────────────────────────

  /**
   * The advances a DRAFT letter names as received, replacing what it named
   * before. Each is this client's, from the letter's company, in its currency,
   * issued, and the amount is at most what is unmapped today (signing maps the
   * smaller of the two then, in case it moved meanwhile).
   */
  async setNamed(
    input: {
      readonly tenantId: string;
      readonly letterId: string;
      readonly advances: readonly { readonly adhocAdvanceId: string; readonly amount: string }[];
      readonly callerSeesFees: boolean;
    },
  ): Promise<readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[]> {
    if (!input.callerSeesFees) throw new AdvanceFeesNotVisible();
    const letter = await this.deps.store.letterFacts(input.tenantId, input.letterId);
    if (letter === null) throw new InvalidBillingInput("No such engagement letter at this firm.");
    if (letter.status !== "draft") {
      throw new InvalidBillingInput(`${letter.ref} is ${letter.status}: what it says is fixed once it is sent.`);
    }
    if (new Set(input.advances.map((a) => a.adhocAdvanceId)).size !== input.advances.length) {
      throw new InvalidBillingInput("Name each advance once.");
    }
    const rows: { adhocAdvanceId: string; amount: string; currency: string }[] = [];
    for (const named of input.advances) {
      const amount = named.amount.trim();
      if (!isAmount(amount) || compareAmounts(amount, "0") <= 0) {
        throw new InvalidBillingInput("Each advance named must have an amount above zero.");
      }
      const advance = await this.get(input.tenantId, named.adhocAdvanceId);
      if (advance.party.id !== letter.partyId) {
        throw new InvalidBillingInput(`${advance.invoice.number ?? "That advance"} is another client's.`);
      }
      if (advance.issuer.id !== letter.issuerId) {
        throw new InvalidBillingInput(
          `${advance.invoice.number ?? "That advance"} was invoiced by ${advance.issuer.displayName}, not by this letter's company.`,
        );
      }
      if (normalizeCurrency(advance.currency) !== normalizeCurrency(letter.currency)) {
        throw new InvalidBillingInput(
          `${advance.invoice.number ?? "That advance"} is in ${advance.currency} and this letter in ${letter.currency}. ` +
            "A letter names an advance in its own currency.",
        );
      }
      if (advance.invoice.status !== "issued" || advance.unmapped === null) throw new AdvanceNotIssued(advance.invoice.status);
      if (compareAmounts(amount, advance.unmapped) > 0) {
        throw new AdvanceOverMapped(amount, advance.unmapped, advance.currency);
      }
      rows.push({ adhocAdvanceId: advance.id, amount, currency: advance.currency });
    }
    await this.deps.store.setNamed(input.tenantId, input.letterId, rows);
    return rows;
  }

  /** What a letter names as received: its content hash reads this. */
  namedOn(
    tenantId: string,
    letterId: string,
  ): Promise<readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[]> {
    return this.deps.store.namedOn(tenantId, letterId);
  }

  /**
   * What a letter's builder shows (Q048): the advances it names, and the ones
   * it could name, this client's, issued by the letter's company in its
   * currency, with something left unmapped.
   */
  async forLetter(
    tenantId: string,
    letterId: string,
  ): Promise<{
    readonly letterStatus: string;
    readonly named: readonly { readonly advance: AdhocAdvanceRecord; readonly amount: string }[];
    readonly candidates: readonly AdhocAdvanceRecord[];
  }> {
    const letter = await this.deps.store.letterFacts(tenantId, letterId);
    if (letter === null) throw new InvalidBillingInput("No such engagement letter at this firm.");
    const [named, all] = await Promise.all([
      this.deps.store.namedOn(tenantId, letterId),
      this.deps.store.list(tenantId, { status: "all", partyId: letter.partyId }),
    ]);
    const fits = (a: AdhocAdvanceRecord): boolean =>
      a.issuer.id === letter.issuerId && normalizeCurrency(a.currency) === normalizeCurrency(letter.currency);
    return {
      letterStatus: letter.status,
      named: named.flatMap((n) => {
        const advance = all.find((a) => a.id === n.adhocAdvanceId);
        return advance === undefined ? [] : [{ advance, amount: n.amount }];
      }),
      candidates: all.filter(
        (a) =>
          fits(a) &&
          a.invoice.status === "issued" &&
          a.unmapped !== null &&
          compareAmounts(a.unmapped, "0") > 0 &&
          !named.some((n) => n.adhocAdvanceId === a.id),
      ),
    };
  }

  /**
   * A signed letter maps each advance it named to ITSELF: it then comes off
   * the letter's earliest bills, FIFO, before tax, exactly as the letter's own
   * advance does. At most what is left unmapped now (somebody may have mapped
   * part elsewhere since the letter was drafted). Never refused: the client
   * signed in DocuSign and nobody can be asked then. Whose revenue: the
   * client's Key Manager on the day it was signed.
   */
  async mapNamedOnSigning(
    input: { readonly tenantId: string; readonly letterId?: string | undefined },
    actor: Actor,
  ): Promise<{ readonly mapped: number }> {
    let mapped = 0;
    for (const letter of await this.deps.store.lettersOwingMaps(input.tenantId, input.letterId)) {
      const keyManager = await this.deps.managers.keyManagerFor(input.tenantId, letter.partyId, letter.signedOn);
      for (const named of letter.named) {
        const [advance] = await this.deps.store.list(input.tenantId, { status: "all", advanceId: named.adhocAdvanceId });
        if (advance === undefined || advance.unmapped === null) continue;
        if (letterMapAmount({ named: named.amount, unmapped: advance.unmapped }) === null) continue;
        const row: NewAllocation = {
          id: this.deps.ids.newId(),
          engagementId: null,
          jobId: null,
          engagementLetterId: letter.letterId,
          amount: named.amount,
          managerUserId: keyManager?.userId ?? null,
          how: "letter_signed",
          reason: `Named in ${letter.letterRef}, signed ${letter.signedOn}.`,
          createdByUserId: null,
        };
        const outcome = await this.deps.store.map(input.tenantId, advance.id, [row], { clip: true });
        if (!("written" in outcome)) continue;
        for (const w of outcome.written) {
          await this.recordMapped(input.tenantId, advance, row, w.amount, actor);
          mapped += 1;
        }
      }
    }
    return { mapped };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private checkTarget(advance: AdhocAdvanceRecord, f: AllocationTargetFacts): void {
    const service = `${f.serviceName} (${f.letterRef})`;
    if (f.partyId !== advance.party.id) throw new AdvanceOfAnotherClient(service);
    if (f.issuerId !== advance.issuer.id) throw new AdvanceOfAnotherIssuer(service, f.issuerName, advance.issuer.displayName);
    if (normalizeCurrency(f.currency) !== normalizeCurrency(advance.currency)) {
      throw new AdvanceInAnotherCurrency(service, f.currency, advance.currency);
    }
    if (!LIVE_STATUSES.includes(f.status)) throw new AdvanceTargetNotLive(service, f.status);
  }

  private async recordMapped(
    tenantId: string,
    advance: AdhocAdvanceRecord,
    row: NewAllocation,
    amount: string,
    actor: Actor,
  ): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId,
      verb: "advance_allocation.mapped",
      objectId: row.id,
      actor,
      payload: {
        adhocAdvanceId: advance.id,
        invoiceId: advance.invoice.id,
        ...(row.engagementId === null ? {} : { engagementId: row.engagementId }),
        ...(row.engagementLetterId === null ? {} : { engagementLetterId: row.engagementLetterId }),
        jobId: row.jobId,
        amount,
        currency: advance.currency,
        managerUserId: row.managerUserId,
        how: row.how,
      },
    });
  }

  private async defaultTax(tenantId: string, entityPartyId: string): Promise<string | null> {
    const rates = await this.deps.taxDefaults.list(tenantId);
    return rates.find((r) => r.entityPartyId === entityPartyId)?.taxPercent ?? null;
  }

  private async firmDay(tenantId: string): Promise<string> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }
}

/** The person acting: an advance is raised, mapped and ended by somebody. */
function humanOf(actor: Actor, what: string): string {
  if (actor.type !== "human" || actor.id === null) throw new InvalidBillingInput(`A person ${what}.`);
  return actor.id;
}

