// Invoicing (T3.4) — the business rules, against ports. No I/O, no SQL, no HTTP.
//
// The shape of it, and why each part is where it is:
//
//   THE NUMBER IS NOT THIS SERVICE'S TO GIVE. It asks the repository to issue
//   an invoice and gets one back already numbered, because a gapless series can
//   only be allocated inside the transaction that writes the row (see
//   `InvoiceRepository.issue`). A service that called `nextNumber()` and then
//   `issue()` would be gapless only while nothing ever failed between the two.
//   Since 0322 the number is drawn at ISSUE, not when the draft is made: a
//   draft (the advance at signing is drafted by the system) that is cancelled
//   spends nothing.
//
//   AN ISSUED INVOICE IS NOT EDITED. Every write path checks the status first
//   and refuses, and the database refuses again in a trigger. Both are wanted:
//   the trigger is what an import or a psql session meets; this is what gives a
//   screen an answer it can render.
//
//   THE TOTAL IS NEVER COMPUTED HERE. It comes from `crm.invoice_totals`, in
//   Postgres `numeric`. Summing money in TypeScript is how the figure on the
//   screen stops matching the figure in the database.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  CreditNote,
  Invoice,
  InvoiceBalance,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTaxSnapshot,
  Payment,
} from "../../domain/invoice/model";
import {
  decideTreatment,
  isSac,
  isTdsPercent,
  isTdsSection,
  placeOfSupplyOf,
  stateByCode,
  stateCodeOfGstin,
} from "../../domain/invoice/gst";
import {
  CREDIT_REASONS,
  PAYMENT_METHODS,
  canTransition,
  INDIAN_FY_START_MONTH,
  financialYearLabel,
  financialYearOf,
  seriesYearFor,
  preDrawnNumberOrder,
  isCreditReason,
  isPaymentMethod,
  isSeriesPrefix,
} from "../../domain/invoice/model";
import {
  compareAmounts,
  isAmount, isExchangeRate,
  isCurrencyCode,
  isSignedAmount,
  normalizeCurrency,
} from "../../domain/money/model";
import {
  EmptyInvoice,
  InvalidInvoiceAmount,
  InvalidInvoiceCurrency,
  InvalidInvoiceDate,
  InvalidInvoiceTransition,
  InvalidSeriesPrefix,
  InvoiceLineNotFound,
  InvoiceNotEditable,
  InvoiceNotFound,
  InvoiceNotIssued,
  InvalidCreditReason,
  InvalidPaymentMethod,
  CreditExceedsInvoice,
  ReversalExceedsPaid,
  IrnAlreadyRegistered,
  NotCallersToday,
  EngagementOfAnotherClient,
  EngagementOfAnotherIssuer,
  EngagementInAnotherCurrency,
  InvoiceBillsTheFirm,
  InvoiceEngagementNotFound,
  InvoiceIssuerNotAFirmEntity,
  InvoicePartyArchived,
  InvoiceManagerFrozen,
  ManagerNotStaff,
  CreditNoteDateOutOfRange,
  InvoiceHasPayments,
  InvoiceAdvanceMapped,
  CreditExceedsUnusedAdvance,
  InvalidPlaceOfSupply,
  InvalidSac,
  InvoiceClientNotFound,
  InvalidTds,
  InvoiceLineNeedsSac,
  PlaceOfSupplyUnknown,
  FxRateNotOne,
  FxRateRequired,
  DueBeforeIssue,
  DueDateInThePast,
  InvoiceNumberOutOfOrder,
} from "../../domain/invoice/errors";
import { addDays } from "../../domain/scheduler/model";
import { dayInZone, isCallersToday } from "../../domain/scheduler/zone";
import { yearStartOfCompany, zoneOfCompany } from "../../domain/calendar/model";
import type {
  ClientTds,
  FirmEntities,
  FirmTimeZone,
  InvoiceTaxFacts,
  InvoiceFilters,
  InvoiceFirmSettings,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
  InvoiceView,
  IssuedCopies,
  NewInvoice,
  NewInvoiceLine,
  PartyStanding,
  ReceivableRecord,
  StaffDirectory,
} from "./ports";

export interface Deps {
  readonly invoices: InvoiceRepository;
  /** The firm's zone, for "today" when the caller does not send its own. */
  readonly timeZones: FirmTimeZone;
  /** Which parties are the firm's own companies (F-10-1). */
  readonly firmEntities: FirmEntities;
  /** Names for refusals, and whether a client was archived (0305). */
  readonly parties: PartyStanding;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
  /** Files the invoice's PDF as it is issued (2026-09-29). */
  readonly issuedCopies: IssuedCopies;
  /** The roster, for a manager a person names (auto-invoice T4). */
  readonly staff: StaffDirectory;
  /** The firm's reporting currency, financial year start and payment terms
   *  (audit 2026-10-03). */
  readonly settings: InvoiceFirmSettings;
}

export interface RaiseInvoiceInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  /** Required when the currency is not the firm's reporting one (B07); in the
   *  reporting currency it is 1, and may be left out. */
  readonly fxRate?: string | undefined;
  /** The day the rate is from; defaults to today. */
  readonly fxRateDate?: string | undefined;
  readonly dueOn?: string | undefined;
  readonly notes?: string | undefined;
  /** The draft's PROVISIONAL year (defaults to today). Since B03 the number's
   *  year is the ISSUE date's, whatever this says. */
  readonly seriesDate?: string | undefined;
  /** The caller's today (see `isCallersToday`); the firm's day when absent. */
  readonly asOf?: string | undefined;
  /** Whose revenue this invoice is (0318). Absent: nobody named. */
  readonly managerUserId?: string | undefined;
  /**
   * The manager came from the bills being raised (the billing desk), not from
   * a person's pick. Those were resolved from the firm's own SPOCs and Key
   * Manager when the bill was written, and a manager who has left since still
   * earned that period: refusing the raise would leave the bill stuck. A
   * person's pick is checked against today's roster.
   */
  readonly managerFromBills?: boolean | undefined;
}

export interface AddInvoiceLineInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly engagementId?: string | undefined;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly discountPercent?: string | undefined;
  readonly taxPercent?: string | undefined;
  /** The service's SAC (Q056). Absent: the catalogue's, for a line billing a
   *  catalogued service; else none. */
  readonly sac?: string | undefined;
}

/** What a GST invoice's tax comes to from its facts (Q056), before it is
 *  written: the snapshot, the line SACs the catalogue fills, and what would
 *  stop it being issued. */
interface TaxOutcome {
  readonly snapshot: InvoiceTaxSnapshot;
  readonly fillSacs: readonly { readonly lineId: string; readonly sac: string }[];
  readonly placeUnknown: boolean;
  /** Lines of a GST invoice with no SAC, from the line or the catalogue. */
  readonly missingSac: readonly string[];
}

/** Two snapshots say the same. */
function sameTax(a: InvoiceTaxSnapshot, b: InvoiceTaxSnapshot): boolean {
  return (Object.keys(a) as (keyof InvoiceTaxSnapshot)[]).every((k) => {
    const x = a[k];
    const y = b[k];
    // A rate read back from `numeric(5,2)` reads "10.00"; typed, "10".
    if (k === "tdsPercent" && x !== null && y !== null) return Number(x) === Number(y);
    return x === y;
  });
}

/**
 * The tax an invoice comes to (Q056), from what `taxFacts` read. Pure.
 *
 * The place of supply follows a state a person chose on the draft, else the
 * client (its GSTIN's state, its address's); `decideTreatment` takes it from
 * there. A plain invoice keeps only the bank account and the TDS: those print
 * on any invoice.
 */
function taxFrom(facts: InvoiceTaxFacts, chosenPlaceOfSupply: string | null): TaxOutcome {
  const base: InvoiceTaxSnapshot = {
    treatment: null,
    supplierGstin: null,
    supplierStateCode: null,
    recipientGstin: null,
    placeOfSupplyStateCode: null,
    placeOfSupplyCountry: null,
    chosenPlaceOfSupply,
    lutId: null,
    bankAccountId: facts.bankAccountId,
    tdsSection: facts.clientTds?.section ?? null,
    tdsPercent: facts.clientTds?.percent ?? null,
  };
  const fillSacs = facts.lines.flatMap((l) =>
    l.sac === null && l.serviceSac !== null ? [{ lineId: l.id, sac: l.serviceSac }] : [],
  );
  const placeOfSupply = placeOfSupplyOf({
    recipientCountry: facts.recipientCountry,
    recipientGstin: facts.recipientGstin,
    addressRegion: facts.recipientRegion,
    hasAddress: facts.recipientHasAddress,
    chosenStateCode: chosenPlaceOfSupply,
  });
  const decided = decideTreatment({
    supplierCountry: facts.supplierCountry ?? "",
    supplierGstin: facts.supplierGstin,
    placeOfSupply,
    lutInForce: facts.lutId !== null,
  });
  if (!decided.ok) return { snapshot: base, fillSacs, placeUnknown: true, missingSac: [] };
  if (decided.treatment === "plain") {
    return { snapshot: { ...base, treatment: "plain" }, fillSacs, placeUnknown: false, missingSac: [] };
  }
  const pos = decided.placeOfSupply;
  const snapshot: InvoiceTaxSnapshot = {
    ...base,
    treatment: decided.treatment,
    supplierGstin: facts.supplierGstin,
    supplierStateCode: decided.supplierStateCode,
    // An Indian recipient's GSTIN only: a client abroad has none to print.
    recipientGstin: pos.kind === "state" && stateCodeOfGstin(facts.recipientGstin) !== null ? facts.recipientGstin : null,
    placeOfSupplyStateCode: pos.kind === "state" ? pos.stateCode : null,
    placeOfSupplyCountry: pos.kind === "outside_india" ? pos.country : null,
    lutId: decided.treatment === "gst_export_lut" ? facts.lutId : null,
  };
  const missingSac = facts.lines.filter((l) => (l.sac ?? l.serviceSac) === null).map((l) => l.description);
  return { snapshot, fillSacs, placeUnknown: false, missingSac };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvoiceService {
  constructor(private readonly deps: Deps) {}

  /**
   * Start an invoice: a DRAFT, with no number yet (0322). Its financial year is
   * provisional: the issue takes the year of the issue date (B03).
   *
   * The currency and the FX rate are fixed HERE, at the top of the document,
   * and the lines are held to the currency by a composite foreign key — a
   * mixed-currency invoice is unrepresentable rather than discouraged, exactly
   * as on a proposal. The rate is stored even when the currencies match.
   */
  async raise(input: RaiseInvoiceInput, actor: Actor): Promise<Invoice> {
    const created = await this.deps.invoices.create(await this.prepareDraft(input));
    await this.recordRaised(created, actor);
    return this.refreshTax(input.tenantId, created.id);
  }

  /**
   * A DRAFT's tax, decided again from today's facts (Q056): the client's GSTIN
   * and state, the company's LUT and bank account, the client's TDS, and SACs
   * the catalogue now gives its lines. Written only when something changed.
   * Called when a draft is made, a line added, its place of supply chosen, it
   * is read, and by the billing desk after it writes one; Issue decides once
   * more for the issue date and freezes the answer.
   */
  async refreshTax(tenantId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (invoice.status !== "draft") return invoice;
    const onDay = await this.today(tenantId, invoice.entityPartyId);
    const outcome = await this.taxOn(tenantId, invoice, onDay);
    if (sameTax(outcome.snapshot, invoice.tax) && outcome.fillSacs.length === 0) return invoice;
    return this.deps.invoices.setDraftTax(tenantId, invoiceId, outcome.snapshot, outcome.fillSacs);
  }

  /** The tax an invoice comes to on `onDay`, with the LUT of that day's year
   *  on its company's calendar. */
  private async taxOn(tenantId: string, invoice: Invoice, onDay: string): Promise<TaxOutcome> {
    const settings = await this.deps.settings.invoiceSettingsFor(tenantId);
    const startMonth = await this.startMonthOf(tenantId, invoice.entityPartyId, settings.fiscalYearStartMonth);
    const facts = await this.deps.invoices.taxFacts(tenantId, invoice.id, {
      onDay,
      financialYear: financialYearOf(onDay, startMonth),
    });
    return taxFrom(facts, invoice.tax.chosenPlaceOfSupply);
  }

  /**
   * Choose a DRAFT's place of supply (Q056): a GST state code, over the one the
   * client's GSTIN or address gives (a client registered in several states, or
   * an address whose state cannot be read). Null goes back to the client's.
   */
  async setPlaceOfSupply(
    tenantId: string,
    invoiceId: string,
    stateCode: string | null,
    actor: Actor,
  ): Promise<Invoice> {
    const invoice = await this.editableOrThrow(tenantId, invoiceId);
    if (stateCode !== null && stateByCode(stateCode) === null) throw new InvalidPlaceOfSupply(stateCode);
    const onDay = await this.today(tenantId, invoice.entityPartyId);
    const outcome = await this.taxOn(tenantId, { ...invoice, tax: { ...invoice.tax, chosenPlaceOfSupply: stateCode } }, onDay);
    const saved = await this.deps.invoices.setDraftTax(tenantId, invoiceId, outcome.snapshot, outcome.fillSacs);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.place_of_supply_set",
      objectId: invoiceId,
      actor,
      payload: {
        chosenPlaceOfSupply: stateCode,
        previousChosenPlaceOfSupply: invoice.tax.chosenPlaceOfSupply,
        taxTreatment: saved.tax.treatment,
      },
    });
    return saved;
  }

  /** A DRAFT line's SAC (Q056); null clears it. */
  async setLineSac(
    tenantId: string,
    invoiceId: string,
    lineId: string,
    sac: string | null,
    actor: Actor,
  ): Promise<void> {
    await this.editableOrThrow(tenantId, invoiceId);
    if (sac !== null && !isSac(sac)) throw new InvalidSac(sac);
    const lines = await this.deps.invoices.listLines(tenantId, invoiceId);
    const line = lines.find((l) => l.id === lineId);
    if (line === undefined) throw new InvoiceLineNotFound(lineId);
    if (line.sac === sac) return;
    await this.deps.invoices.setLineSac(tenantId, invoiceId, lineId, sac);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.line_sac_set",
      objectId: invoiceId,
      actor,
      payload: { lineId, sac, previousSac: line.sac },
    });
  }

  // ── Q057: the TDS a client deducts ───────────────────────────────────────

  clientTds(tenantId: string, partyId: string): Promise<ClientTds | null> {
    return this.deps.invoices.clientTds(tenantId, partyId);
  }

  /**
   * Set, change or stop (null) the TDS a client deducts on the firm's fees.
   * Drafts take it the next time they are read or issued; an issued invoice
   * keeps the rate it went out with.
   */
  async setClientTds(
    tenantId: string,
    partyId: string,
    tds: { readonly section: string; readonly percent: string } | null,
    actor: Actor,
  ): Promise<ClientTds | null> {
    // Never one of the firm's own companies: it does not deduct from itself.
    if (await this.deps.firmEntities.isFirmEntity(tenantId, partyId)) {
      throw new InvoiceBillsTheFirm(await this.nameOf(tenantId, partyId));
    }
    if ((await this.deps.parties.findParty(tenantId, partyId)) === null) throw new InvoiceClientNotFound(partyId);
    let next: ClientTds | null = null;
    if (tds !== null) {
      const section = tds.section.trim().toUpperCase().replace(/\((.*)\)$/, (m) => m.toLowerCase());
      const percent = tds.percent.trim();
      if (!isTdsSection(section)) {
        throw new InvalidTds(
          `${JSON.stringify(tds.section)} is not a TDS section. Write it as the Act does: 194J, 194JB, 194C, 195.`,
        );
      }
      if (!isTdsPercent(percent)) {
        throw new InvalidTds(
          `${JSON.stringify(tds.percent)} is not a TDS rate. A rate is above 0 and at most 100, with at most two ` +
            `decimal places, like 10 or 2.`,
        );
      }
      next = { section, percent };
    }
    const previous = await this.deps.invoices.clientTds(tenantId, partyId);
    await this.deps.invoices.setClientTds(tenantId, partyId, next);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "client.tds_set",
      objectId: partyId,
      actor,
      payload: {
        section: next?.section ?? null,
        percent: next?.percent ?? null,
        previousSection: previous?.section ?? null,
        previousPercent: previous?.percent ?? null,
      },
    });
    return next;
  }

  /**
   * Every rule a new draft answers to, and the row it would be, WITHOUT
   * writing it (B34). `raise` writes it at once; the billing desk writes it in
   * the same transaction as its lines and the bills they settle, so a request
   * that fails half-way leaves neither a partial draft nor a bill marked
   * raised on nothing.
   */
  async prepareDraft(input: RaiseInvoiceInput): Promise<NewInvoice> {
    const currency = normalizeCurrency(input.currency);
    if (!isCurrencyCode(currency)) throw new InvalidInvoiceCurrency(input.currency);
    const today = await this.today(input.tenantId, input.entityPartyId, input.asOf);
    const seriesDate = input.seriesDate ?? today;
    this.dateOrThrow("seriesDate", seriesDate);
    const settings = await this.deps.settings.invoiceSettingsFor(input.tenantId);
    const startMonth = await this.startMonthOf(input.tenantId, input.entityPartyId, settings.fiscalYearStartMonth);
    // THE RATE IS A PERSON'S, NEVER A DEFAULT (B07). In another currency than
    // the firm's reporting one it is required: a default of 1 counted USD
    // 10,000 as INR 10,000 everywhere money is added up. In the firm's own
    // currency it is exactly 1, stored and dated as the rule above says.
    const ownCurrency = currency === normalizeCurrency(settings.reportingCurrency);
    const typedRate = input.fxRate?.trim() ?? "";
    if (!ownCurrency && typedRate === "") throw new FxRateRequired(currency, settings.reportingCurrency);
    const fxRate = typedRate === "" ? "1" : typedRate;
    // Positive, not merely non-negative: a rate of zero would make every
    // converted total zero and nothing would look wrong until a report did.
    // A RATE, not a price: `numeric(20,10)` on this column, so a stored
    // rate read back at full scale ("1.0000000000") has to be acceptable
    // input. `isAmount` allows four places and refused it — see
    // `isExchangeRate`.
    if (!isExchangeRate(fxRate) || compareAmounts(fxRate, "0") <= 0) {
      throw new InvalidInvoiceAmount("fxRate", fxRate);
    }
    if (ownCurrency && compareAmounts(fxRate, "1") !== 0) throw new FxRateNotOne(currency, fxRate);
    const fxRateDate = input.fxRateDate?.trim() || today;
    this.dateOrThrow("fxRateDate", fxRateDate);
    if (input.dueOn !== undefined) {
      this.dateOrThrow("dueOn", input.dueOn);
      // B21 at the API too: the raise dialog bounded the day, the route did
      // not, and such a draft was refused only later, at issue.
      if (input.dueOn < today) throw new DueDateInThePast(input.dueOn, today);
    }

    // WHO issues it and WHO it bills, before anything is written (F-10-1). The
    // number is allocated in the issuer's own gapless series, so a client named
    // as the issuer would open a GST series in that client's name for good.
    await this.requireIssuer(input.tenantId, input.entityPartyId);
    const billed = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (billed !== null && billed.archivedAt !== null) {
      throw new InvoicePartyArchived(billed.displayName);
    }
    if (await this.deps.firmEntities.isFirmEntity(input.tenantId, input.partyId)) {
      throw new InvoiceBillsTheFirm(billed?.displayName ?? input.partyId);
    }
    // Before the draft too: a refusal after it would leave a draft nobody
    // asked for.
    if (input.managerUserId !== undefined && input.managerFromBills !== true) {
      await this.requireStaff(input.tenantId, input.managerUserId);
    }

    return {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId: input.partyId,
      entityPartyId: input.entityPartyId,
      currency,
      fxRate,
      fxRateDate,
      dueOn: input.dueOn ?? null,
      notes: input.notes ?? null,
      managerUserId: input.managerUserId ?? null,
      financialYear: financialYearOf(seriesDate, startMonth),
      fiscalYearStartMonth: startMonth,
    };
  }

  /** The ledger's line for a draft that now exists, after its write committed. */
  async recordRaised(invoice: Invoice, actor: Actor): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId: invoice.tenantId,
      verb: "invoice.raised",
      objectId: invoice.id,
      actor,
      // Ids and machine facts. `notes` is free text a person wrote and stays
      // out of a log that cannot be erased. No number: a draft has none (0322);
      // `invoice.issued` carries it, with its place in the series.
      payload: {
        partyId: invoice.partyId,
        entityPartyId: invoice.entityPartyId,
        financialYear: invoice.financialYear,
        currency: invoice.currency,
        fxRate: invoice.fxRate,
        fxRateDate: invoice.fxRateDate,
        managerUserId: invoice.managerUserId,
      },
    });
  }

  /**
   * Put a DRAFT in somebody's revenue, or in nobody's (auto-invoice T4). Once
   * issued, the manager is fixed (here, and by 0318's trigger).
   */
  async setManager(
    tenantId: string,
    invoiceId: string,
    managerUserId: string | null,
    actor: Actor,
  ): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (invoice.status !== "draft") throw new InvoiceManagerFrozen(invoiceId, invoice.status);
    if (managerUserId !== null) await this.requireStaff(tenantId, managerUserId);
    if (invoice.managerUserId === managerUserId) return invoice;
    const saved = await this.deps.invoices.setManager(tenantId, invoiceId, managerUserId);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.manager_set",
      objectId: saved.id,
      actor,
      payload: {
        number: saved.number,
        managerUserId: saved.managerUserId,
        previousManagerUserId: invoice.managerUserId,
      },
    });
    return saved;
  }

  /**
   * Set or clear a DRAFT's due date (B20). Bills drafted by the billing desk
   * carried none and nothing could give them one, so client reminders never
   * chased them. Today or later; an issued invoice's due date is what was
   * sent, and does not change.
   */
  async setDueDate(
    tenantId: string,
    invoiceId: string,
    dueOn: string | null,
    actor: Actor,
    asOf?: string,
  ): Promise<Invoice> {
    const invoice = await this.editableOrThrow(tenantId, invoiceId);
    if (dueOn !== null) {
      this.dateOrThrow("dueOn", dueOn);
      const today = await this.today(tenantId, invoice.entityPartyId, asOf);
      if (dueOn < today) throw new DueDateInThePast(dueOn, today);
    }
    if (invoice.dueOn === dueOn) return invoice;
    const saved = await this.deps.invoices.setDueOn(tenantId, invoiceId, dueOn);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.due_date_set",
      objectId: saved.id,
      actor,
      payload: { dueOn: saved.dueOn, previousDueOn: invoice.dueOn },
    });
    return saved;
  }

  async addLine(input: AddInvoiceLineInput): Promise<InvoiceLine> {
    const invoice = await this.editableOrThrow(input.tenantId, input.invoiceId);
    const line = await this.deps.invoices.addLine(await this.prepareLine(invoice, input));
    await this.refreshTax(input.tenantId, input.invoiceId);
    return line;
  }

  /**
   * Every rule a line answers to, for an invoice that may not be written yet
   * (B34: the billing desk writes the draft, its lines and its bills in one
   * transaction), and the row it would be.
   */
  async prepareLine(
    invoice: { readonly id: string; readonly partyId: string; readonly entityPartyId: string; readonly currency: string },
    input: Omit<AddInvoiceLineInput, "invoiceId">,
  ): Promise<NewInvoiceLine> {
    if (!isAmount(input.quantity) || Number(input.quantity) <= 0) {
      throw new InvalidInvoiceAmount("quantity", input.quantity);
    }
    if (!isAmount(input.unitAmount) || Number(input.unitAmount) < 0) {
      throw new InvalidInvoiceAmount("unitAmount", input.unitAmount);
    }
    const discount = input.discountPercent ?? "0";
    if (!isAmount(discount) || Number(discount) < 0 || Number(discount) > 100) {
      throw new InvalidInvoiceAmount("discountPercent", discount);
    }
    const sac = input.sac?.trim() === "" ? undefined : input.sac?.trim();
    if (sac !== undefined && !isSac(sac)) throw new InvalidSac(sac);

    // The engagement is the BILLED client's (F-10-1). The invoice PDF goes to
    // that client's portal, and a line billing another client's engagement
    // would carry somebody else's scope of work into it.
    if (input.engagementId !== undefined) {
      const engagement = await this.deps.invoices.engagementOf(input.tenantId, input.engagementId);
      if (engagement === null) throw new InvoiceEngagementNotFound(input.engagementId);
      if (engagement.partyId !== invoice.partyId) {
        throw new EngagementOfAnotherClient(
          await this.nameOf(input.tenantId, engagement.partyId),
          await this.nameOf(input.tenantId, invoice.partyId),
        );
      }
      // And the company that signed its letter charges for it. The invoice's
      // number is already drawn from ITS issuer's series, so billing another
      // company's contract here would book that sale in the wrong company.
      if (engagement.issuingEntityPartyId !== invoice.entityPartyId) {
        throw new EngagementOfAnotherIssuer(
          engagement.letterRef,
          await this.nameOf(input.tenantId, engagement.issuingEntityPartyId),
          await this.nameOf(input.tenantId, invoice.entityPartyId),
        );
      }
      // And in the currency the letter priced it in. The line below takes the
      // INVOICE's currency, so a USD 3,000 engagement on an INR invoice became
      // ₹3,000. One company signs letters in several currencies, so the issuer
      // check above does not cover this.
      const letterCurrency = normalizeCurrency(engagement.currency);
      if (letterCurrency !== invoice.currency) {
        throw new EngagementInAnotherCurrency(
          engagement.letterRef,
          letterCurrency,
          invoice.currency,
        );
      }
    }

    // HOW THE CATALOGUE TAXES IT (Q056): the service's SAC, and its rate when
    // the person did not type one. Read for the ISSUING company's country.
    const catalogue =
      input.engagementId === undefined
        ? null
        : await this.deps.invoices.serviceTaxFor(input.tenantId, input.engagementId, invoice.entityPartyId);
    const tax = input.taxPercent ?? catalogue?.ratePercent ?? "0";
    if (!isAmount(tax) || Number(tax) < 0 || Number(tax) > 100) {
      throw new InvalidInvoiceAmount("taxPercent", tax);
    }

    return {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      invoiceId: invoice.id,
      engagementId: input.engagementId ?? null,
      description: input.description.trim(),
      quantity: input.quantity,
      unitAmount: input.unitAmount,
      // The invoice's currency, never the caller's. A line cannot disagree with
      // the document it is on, and the composite key would refuse it anyway —
      // this is the same answer arrived at before the database has to give it.
      currency: invoice.currency,
      discountPercent: discount,
      taxPercent: tax,
      sac: sac ?? catalogue?.sac ?? null,
    };
  }

  async removeLine(tenantId: string, invoiceId: string, lineId: string): Promise<void> {
    await this.editableOrThrow(tenantId, invoiceId);
    const lines = await this.deps.invoices.listLines(tenantId, invoiceId);
    if (!lines.some((l) => l.id === lineId)) throw new InvoiceLineNotFound(lineId);
    await this.deps.invoices.removeLine(tenantId, invoiceId, lineId);
  }

  /**
   * Send it. An invoice with no lines is refused — it asks the client for
   * nothing, and a document that does that is a mistake somebody will chase.
   */
  async issue(tenantId: string, invoiceId: string, actor: Actor, asOf?: string): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (!canTransition(invoice.status, "issued")) {
      throw new InvalidInvoiceTransition(invoice.status, "issued");
    }
    const lines = await this.deps.invoices.listLines(tenantId, invoiceId);
    if (lines.length === 0) throw new EmptyInvoice(invoiceId);

    // The DATE ON THE TAX INVOICE. The caller's today, or the firm's: never
    // Greenwich's, which dated an invoice issued at 02:00 in Delhi the day
    // before it was issued.
    const issuedOn = await this.today(tenantId, invoice.entityPartyId, asOf);
    // AND ITS YEAR IS THAT DAY'S (B03). It was the draft's, so a March draft
    // issued in April took last year's series with an April date on it. The
    // COMPANY's own year when it keeps one (0337), else the firm's when it has
    // said when that starts, else 1 April.
    const settings = await this.deps.settings.invoiceSettingsFor(tenantId);
    const startMonth = await this.startMonthOf(tenantId, invoice.entityPartyId, settings.fiscalYearStartMonth);
    // NOT ALREADY OVERDUE (B21): a draft that lingered past its due date would
    // go out late, and the next sweep fire every reminder at once. The person
    // changes the date on the draft; nothing guesses a new one.
    if (invoice.dueOn !== null && invoice.dueOn < issuedOn) throw new DueBeforeIssue(invoice.dueOn, issuedOn);
    // THE FIRM'S OWN TERMS (B20, 0327): an invoice issued with no due date is
    // due N days after its date when the firm has said N; never a guessed N.
    const dueOnIfUnset = settings.dueInDays === null ? null : addDays(issuedOn, settings.dueInDays);
    // THE NUMBER IS DRAWN HERE (0322), in the same transaction as the status.
    // A draft numbered before 0322 keeps its number, and is refused when that
    // number would now go out of order (B51): never renumbered.
    // Never an older series than the company last drew in (final review: a
    // later year start reopened the one that had closed).
    const financialYear = seriesYearFor(
      financialYearOf(issuedOn, startMonth),
      await this.deps.invoices.newestNumberedYear(tenantId, invoice.entityPartyId, "invoice"),
    );
    // WHAT IT SAYS ABOUT TAX (Q056), for the issue date: frozen by the same
    // write. A GST invoice names its place of supply and each line's SAC
    // (Rule 46), and is refused without them.
    const tax = await this.taxOn(tenantId, invoice, issuedOn);
    if (tax.placeUnknown) {
      throw new PlaceOfSupplyUnknown((await this.deps.parties.findParty(tenantId, invoice.partyId))?.displayName ?? "the client");
    }
    if (tax.missingSac.length > 0) throw new InvoiceLineNeedsSac(tax.missingSac);
    const outcome = await this.deps.invoices.issue(tenantId, invoiceId, {
      issuedOn,
      financialYear,
      fiscalYearStartMonth: startMonth,
      dueOnIfUnset,
      tax: tax.snapshot,
      fillSacs: tax.fillSacs,
    });
    if ("outOfOrder" in outcome) {
      throw new InvoiceNumberOutOfOrder(
        outcome.outOfOrder.number,
        outcome.outOfOrder.order,
        financialYearLabel(financialYear, startMonth),
      );
    }
    const issued = outcome.issued;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.issued",
      objectId: issued.id,
      actor,
      // The NUMBER is in, because it is the machine fact this event is about: a
      // consecutive series is evidence, and "which number went to which client,
      // when, by whom" is the whole audit question.
      payload: {
        number: issued.number,
        financialYear: issued.financialYear,
        sequenceNumber: issued.sequenceNumber,
        partyId: issued.partyId,
        entityPartyId: issued.entityPartyId,
        issuedOn: issued.issuedOn,
        dueOn: issued.dueOn,
        lineCount: lines.length,
        // Q056: which taxes it charges and where it was supplied; machine facts.
        taxTreatment: issued.tax.treatment,
        placeOfSupplyStateCode: issued.tax.placeOfSupplyStateCode,
        placeOfSupplyCountry: issued.tax.placeOfSupplyCountry,
        lutId: issued.tax.lutId,
        tdsSection: issued.tax.tdsSection,
        tdsPercent: issued.tax.tdsPercent,
      },
    });
    // Its paper, drawn now and never again: the copy of record. After the
    // status is written, so the copy is the issued one, dated.
    await this.deps.issuedCopies.file(tenantId, issued.id, actor);
    return issued;
  }

  /**
   * Withdraw it.
   *
   * An issued invoice's number is NOT released and the row is not removed —
   * that is what makes the series consecutive. A cancelled invoice stays in the
   * sequence, readable, saying it was cancelled, which is exactly what an
   * auditor needs to see where a number went. A draft has no number yet
   * (0322), so cancelling one spends nothing.
   */
  async cancel(tenantId: string, invoiceId: string, actor: Actor): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (!canTransition(invoice.status, "cancelled")) {
      throw new InvalidInvoiceTransition(invoice.status, "cancelled");
    }
    // NOT WITH MONEY ON IT (B05). A paid invoice cancelled orphaned the
    // payment and re-opened the bill behind it to be raised again. The money
    // is taken off with a credit note, or a mistaken payment is reversed first.
    const outcome = await this.deps.invoices.cancel(tenantId, invoiceId);
    if ("paid" in outcome) throw new InvoiceHasPayments(invoice.number, outcome.paid, invoice.currency);
    if ("mapped" in outcome) throw new InvoiceAdvanceMapped(invoice.number, outcome.mapped, invoice.currency);
    const cancelled = outcome.cancelled;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.cancelled",
      objectId: cancelled.id,
      actor,
      payload: { number: cancelled.number, previousStatus: invoice.status },
    });
    return cancelled;
  }

  /**
   * Record the government registry's identifier for this document.
   *
   * A WRITE FROM OUTSIDE, and the honest limit is worth stating: nothing here
   * talks to the IRP. Whoever calls this has registered the invoice by some
   * other means and is recording the answer, exactly as the advance-fee gate is
   * a person attesting that money arrived. The real connector is T7.1.
   */
  async registerIrn(
    tenantId: string,
    invoiceId: string,
    irn: string,
    actor: Actor,
  ): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (invoice.irn !== null) throw new IrnAlreadyRegistered(invoiceId, invoice.irn);
    const saved = await this.deps.invoices.registerIrn(
      tenantId,
      invoiceId,
      irn.trim(),
      this.deps.clock.now().toISOString(),
    );
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.registered",
      objectId: saved.id,
      actor,
      payload: { number: saved.number, irn: saved.irn },
    });
    return saved;
  }

  async describe(tenantId: string, invoiceId: string): Promise<InvoiceView> {
    // A draft is read as it would go out today (Q056): its tax follows the
    // client, the company and the catalogue until it is issued.
    const found = await this.deps.invoices.find(tenantId, invoiceId);
    if (found?.status === "draft") await this.refreshTax(tenantId, invoiceId);
    const record = await this.deps.invoices.describe(tenantId, invoiceId);
    if (record === null) throw new InvoiceNotFound(invoiceId);
    const draft = record.invoice.status === "draft";
    return {
      ...record,
      issueBlocked: (await this.issueBlocked(tenantId, record.invoice)) ?? (draft ? await this.taxBlocked(tenantId, record.invoice) : null),
      issuesOn: draft ? await this.today(tenantId, record.invoice.entityPartyId) : null,
    };
  }

  /** Whether Issue would be refused for its tax today (Q056), in the refusal's
   *  own words. */
  private async taxBlocked(tenantId: string, invoice: Invoice): Promise<InvoiceView["issueBlocked"]> {
    const onDay = await this.today(tenantId, invoice.entityPartyId);
    const tax = await this.taxOn(tenantId, invoice, onDay);
    if (tax.placeUnknown) {
      const name = (await this.deps.parties.findParty(tenantId, invoice.partyId))?.displayName ?? "the client";
      return { reason: "PLACE_OF_SUPPLY_UNKNOWN", message: new PlaceOfSupplyUnknown(name).message };
    }
    if (tax.missingSac.length > 0) {
      return { reason: "INVOICE_LINE_NEEDS_SAC", message: new InvoiceLineNeedsSac(tax.missingSac).message };
    }
    return null;
  }

  /**
   * Whether Issue would be refused today for what the record alone shows (B51):
   * a draft numbered before 0322 whose number is out of order now. The screen
   * shows the same sentence the refusal would carry, where Issue is offered.
   * Issue decides again under the series' lock; this is what to offer.
   */
  private async issueBlocked(tenantId: string, invoice: Invoice): Promise<InvoiceView["issueBlocked"]> {
    if (invoice.status !== "draft" || invoice.number === null || invoice.sequenceNumber === null) return null;
    const settings = await this.deps.settings.invoiceSettingsFor(tenantId);
    const startMonth = await this.startMonthOf(tenantId, invoice.entityPartyId, settings.fiscalYearStartMonth);
    const issueFinancialYear = financialYearOf(await this.today(tenantId, invoice.entityPartyId), startMonth);
    const order = preDrawnNumberOrder({
      draft: { financialYear: invoice.financialYear, sequenceNumber: invoice.sequenceNumber },
      issueFinancialYear,
      latestIssued: await this.deps.invoices.latestIssuedInSeries(
        tenantId,
        { entityPartyId: invoice.entityPartyId, financialYear: invoice.financialYear },
        invoice.id,
      ),
    });
    if (order.inOrder) return null;
    const refusal = new InvoiceNumberOutOfOrder(
      invoice.number,
      order,
      financialYearLabel(issueFinancialYear, startMonth),
    );
    return { reason: "INVOICE_NUMBER_OUT_OF_ORDER", message: refusal.message };
  }

  list(tenantId: string, filters: InvoiceFilters): Promise<readonly InvoiceSummary[]> {
    return this.deps.invoices.list(tenantId, filters);
  }

  listSeries(tenantId: string): Promise<readonly InvoiceSeriesRecord[]> {
    return this.deps.invoices.listSeries(tenantId);
  }

  /**
   * Name what this entity's invoices READ as.
   *
   * It changes future numbers only — every issued invoice keeps the number it
   * was issued with, because the trigger refuses to move one. So a firm that
   * changes its mind gets a series that reads differently from a point in time,
   * which is what actually happens at a real firm and is why the prefix lives
   * on the SERIES row rather than being derived from anything.
   */
  async setSeriesPrefix(
    tenantId: string,
    entityPartyId: string,
    prefix: string,
    actor: Actor,
  ): Promise<void> {
    if (!isSeriesPrefix(prefix)) throw new InvalidSeriesPrefix(prefix);
    // A series belongs to a company that issues invoices (F-10-1).
    await this.requireIssuer(tenantId, entityPartyId);
    await this.deps.invoices.setSeriesPrefix(tenantId, entityPartyId, prefix);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice_series.set",
      objectId: entityPartyId,
      actor,
      payload: { entityPartyId, prefix },
    });
  }

  /** The issuer is one of the firm's own companies (F-10-1). */
  private async requireIssuer(tenantId: string, entityPartyId: string): Promise<void> {
    if (await this.deps.firmEntities.isFirmEntity(tenantId, entityPartyId)) return;
    throw new InvoiceIssuerNotAFirmEntity(await this.nameOf(tenantId, entityPartyId));
  }

  /** A party's name for a refusal, or its id when it has none on file. */
  private async nameOf(tenantId: string, partyId: string): Promise<string> {
    return (await this.deps.parties.findParty(tenantId, partyId))?.displayName ?? partyId;
  }

  /** Which financial year a date belongs to — exposed so a caller can show the
   *  series an invoice would land in before raising it. */
  financialYearOf(isoDate: string): number {
    return financialYearOf(isoDate);
  }

  // ── Money against an invoice (T3.5) ──────────────────────────────────────

  /**
   * Record that money arrived.
   *
   * Only against an ISSUED invoice: a draft has asked the client for nothing,
   * and a cancelled one is a refund or a reallocation rather than a settlement.
   * The database refuses both again in a trigger, because a payment applied to
   * a withdrawn document quietly reduces a balance nobody owes.
   *
   * THE AMOUNT IS SIGNED and a negative one is deliberate: a bounced cheque is
   * a NEGATIVE payment with its own date and note — two rows that tell the
   * story — not the original row edited into something that never happened.
   * `bib_app` holds no DELETE grant, so this is the only way to express it.
   *
   * NOT REFUSED: paying more than the invoice asks for. Overpayment happens —
   * a client settles two invoices with one transfer, or rounds up — and a firm
   * needs to record what actually arrived rather than what the schema found
   * tidy. The balance simply goes negative, which is what a credit on account
   * looks like before there is a feature for it.
   */
  async recordPayment(
    input: {
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly amount: string;
      readonly receivedOn: string;
      readonly method: string;
      readonly reference?: string | undefined;
      readonly note?: string | undefined;
      /** Q057: the TDS the client deducted from this remittance; "0" or absent
       *  for none. Signed like the amount. */
      readonly tdsAmount?: string | undefined;
    },
    actor: Actor,
  ): Promise<Payment> {
    const invoice = await this.issuedOrThrow(input.tenantId, input.invoiceId);
    // SIGNED, unlike every other amount in this product. A negative payment is
    // a reversal — see `isSignedAmount`. Zero is refused either way: it records
    // nothing and would sit in the ledger claiming something happened. With TDS
    // (Q057) the money may be zero: the client's deduction recorded on its own.
    const tdsAmount = input.tdsAmount?.trim() || "0";
    if (!isSignedAmount(tdsAmount)) throw new InvalidInvoiceAmount("tdsAmount", tdsAmount);
    if (!isSignedAmount(input.amount) || (Number(input.amount) === 0 && Number(tdsAmount) === 0)) {
      throw new InvalidInvoiceAmount("amount", input.amount);
    }
    if (!isPaymentMethod(input.method)) {
      throw new InvalidPaymentMethod(input.method, PAYMENT_METHODS);
    }
    this.dateOrThrow("receivedOn", input.receivedOn);

    const outcome = await this.deps.invoices.recordPayment({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      amount: input.amount,
      // The invoice's currency, never the caller's. A payment in another
      // currency would need a rate struck at payment time, which is a different
      // fact from the one on the invoice — a feature, not a default.
      currency: invoice.currency,
      receivedOn: input.receivedOn,
      method: input.method,
      reference: input.reference ?? null,
      note: input.note ?? null,
      tdsAmount,
    });
    if ("paid" in outcome) {
      throw new ReversalExceedsPaid(invoice.number, input.amount.replace(/^-/, ""), outcome.paid, invoice.currency);
    }
    if ("tds" in outcome) {
      throw new ReversalExceedsPaid(invoice.number, tdsAmount.replace(/^-/, ""), outcome.tds, invoice.currency);
    }
    const payment = outcome.payment;

    // The payload is ids and machine facts. NOT the reference (B26, audit
    // 2026-10-03): it is free text up to 200 characters, and a UPI reference is
    // very often a phone number ("98…@ybl"); the PII guard checks key names, not
    // values, and this log cannot be erased. It stays on the payment row, which
    // can be; the event says only whether there was one. Nor the note.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "payment.recorded",
      objectId: payment.id,
      actor,
      payload: {
        invoiceId: payment.invoiceId,
        invoiceNumber: invoice.number,
        amount: payment.amount,
        currency: payment.currency,
        receivedOn: payment.receivedOn,
        method: payment.method,
        hasReference: payment.reference !== null && payment.reference.trim() !== "",
        tdsAmount: payment.tdsAmount,
      },
    });
    return payment;
  }

  /**
   * Take money off an invoice, with a reason.
   *
   * A CREDIT NOTE IS ITS OWN DOCUMENT with its own consecutive series — not an
   * invoice with a minus sign — so its number comes from the same gapless
   * mechanism, keyed on `document_type = 'credit_note'`.
   *
   * THE REASON IS MANDATORY AND CLOSED, and that is the whole value of the
   * field: without it the numbers always reconcile and WHY forty thousand came
   * off does not, which is how revenue leakage becomes invisible. It is a
   * closed set rather than free text because "how much did we write off to
   * service failures last year" is a GROUP BY, and prose does not group.
   */
  async issueCreditNote(
    input: {
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly amount: string;
      readonly reason: string;
      readonly note?: string | undefined;
      readonly issuedOn?: string | undefined;
      readonly asOf?: string | undefined;
    },
    actor: Actor,
  ): Promise<CreditNote> {
    const invoice = await this.issuedOrThrow(input.tenantId, input.invoiceId);
    if (!isAmount(input.amount) || Number(input.amount) <= 0) {
      throw new InvalidInvoiceAmount("amount", input.amount);
    }
    if (!isCreditReason(input.reason)) {
      throw new InvalidCreditReason(input.reason, CREDIT_REASONS);
    }
    const today = await this.today(input.tenantId, invoice.entityPartyId, input.asOf);
    const issuedOn = input.issuedOn ?? today;
    this.dateOrThrow("issuedOn", issuedOn);
    // INSIDE THE INVOICE'S LIFE (B45). A caller-chosen date could predate the
    // invoice it credits, or land in any year's series; a credit note is dated
    // between the invoice's issue and today.
    if ((invoice.issuedOn !== null && issuedOn < invoice.issuedOn) || issuedOn > today) {
      throw new CreditNoteDateOutOfRange(issuedOn, invoice.issuedOn, today);
    }
    const settings = await this.deps.settings.invoiceSettingsFor(input.tenantId);
    const startMonth = await this.startMonthOf(input.tenantId, invoice.entityPartyId, settings.fiscalYearStartMonth);

    // A firm cannot credit more than it billed, nor give back an advance that
    // later bills already took (B06). Checked by the repository INSIDE the
    // transaction that writes the credit note, under the invoice's row lock
    // and the advance's lock (B15): read here and written there, two credits
    // at once both passed the same cap. Not a CHECK constraint, because the
    // limit is a sum over sibling rows.
    const outcome = await this.deps.invoices.issueCreditNote({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      entityPartyId: invoice.entityPartyId,
      amount: input.amount,
      currency: invoice.currency,
      issuedOn,
      reason: input.reason,
      note: input.note ?? null,
      // Its own date's series, never the invoice's (B45), and never an older
      // one than the company last drew a credit note in (0337).
      financialYear: seriesYearFor(
        financialYearOf(issuedOn, startMonth),
        await this.deps.invoices.newestNumberedYear(input.tenantId, invoice.entityPartyId, "credit_note"),
      ),
      fiscalYearStartMonth: startMonth,
    });
    if (!("credit" in outcome)) {
      if (outcome.takenByBills !== null) {
        throw new CreditExceedsUnusedAdvance(invoice.number, outcome.takenByBills, outcome.maxCredit, invoice.currency);
      }
      throw new CreditExceedsInvoice(invoice.number ?? input.invoiceId, input.amount, outcome.maxCredit);
    }
    const credit = outcome.credit;

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "credit_note.issued",
      objectId: credit.id,
      actor,
      // The REASON is the point of this event. A log that recorded the amount
      // and not the category would reproduce exactly the blindness the column
      // exists to remove.
      payload: {
        number: credit.number,
        invoiceId: credit.invoiceId,
        invoiceNumber: invoice.number,
        amount: credit.amount,
        currency: credit.currency,
        reason: credit.reason,
      },
    });
    return credit;
  }

  /** What one invoice still owes — invoiced less paid less credited, computed
   *  by Postgres. Never a stored column. */
  async balanceOf(tenantId: string, invoiceId: string): Promise<InvoiceBalance> {
    const balance = await this.deps.invoices.balanceOf(tenantId, invoiceId);
    if (balance === null) throw new InvoiceNotFound(invoiceId);
    return balance;
  }

  /** Who owes the firm money — the question every collections screen and the
   *  dunning ladder ask. */
  outstanding(tenantId: string): Promise<readonly ReceivableRecord[]> {
    return this.deps.invoices.outstanding(tenantId);
  }

  listPayments(tenantId: string, invoiceId: string): Promise<readonly Payment[]> {
    return this.deps.invoices.listPayments(tenantId, invoiceId);
  }

  listCreditNotes(tenantId: string, invoiceId: string): Promise<readonly CreditNote[]> {
    return this.deps.invoices.listCreditNotes(tenantId, invoiceId);
  }

  /** Money only attaches to a document that has actually been sent. */
  private async issuedOrThrow(tenantId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (invoice.status !== ("issued" satisfies InvoiceStatus)) {
      throw new InvoiceNotIssued(invoiceId, invoice.status);
    }
    return invoice;
  }

  private async requireStaff(tenantId: string, userId: string): Promise<void> {
    if (!(await this.deps.staff.isActiveStaff(tenantId, userId))) throw new ManagerNotStaff(userId);
  }

  private async mustFind(tenantId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.deps.invoices.find(tenantId, invoiceId);
    if (invoice === null) throw new InvoiceNotFound(invoiceId);
    return invoice;
  }

  /** Every write path goes through here. `draft` is the only editable state,
   *  and the database says so again in a trigger. */
  private async editableOrThrow(tenantId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (invoice.status !== ("draft" satisfies InvoiceStatus)) {
      throw new InvoiceNotEditable(invoiceId, invoice.status);
    }
    return invoice;
  }

  private dateOrThrow(field: string, value: string): void {
    if (!ISO_DATE.test(value)) throw new InvalidInvoiceDate(field, value);
  }

  /**
   * Today as an ISO DATE, not an instant. An invoice date is a calendar fact
   * in a jurisdiction — the same rule the scheduler's arithmetic follows.
   *
   * WHOSE today: the caller's, when it says (`asOf`, the browser's local day),
   * and otherwise the FIRM's (0071) — never the server's. It was
   * `toISOString().slice(0, 10)`, the UTC day, which is yesterday in India
   * until 05:30. A caller's `asOf` is held to the firm's day or one either
   * side (`isCallersToday`): it says what day it is, it does not choose one.
   */
  private async today(tenantId: string, entityPartyId: string, asOf?: string): Promise<string> {
    // THE ISSUING COMPANY'S DAY (0337): its own zone when it keeps one, else
    // the firm's. A US company's invoice raised at 01:00 in India is dated on
    // New York's 31 October, as a document of that company is (the ERP
    // standard: a document date is a plain date in the issuer's zone).
    const [firmZone, calendars] = await Promise.all([
      this.deps.timeZones.timeZoneFor(tenantId),
      this.deps.timeZones.companyCalendars(tenantId),
    ]);
    const zone = zoneOfCompany(calendars, entityPartyId, firmZone);
    const companyDay = dayInZone(this.deps.clock.now().toISOString(), zone);
    if (asOf === undefined) return companyDay;
    if (!isCallersToday(asOf, companyDay)) throw new NotCallersToday(asOf, companyDay);
    return asOf;
  }

  /** The month the issuing company's year starts in (0337): its own, else the
   *  firm's when it has said, else 1 April as every series did before. */
  private async startMonthOf(tenantId: string, entityPartyId: string, firmStart: number | null): Promise<number> {
    const calendars = await this.deps.timeZones.companyCalendars(tenantId);
    return yearStartOfCompany(calendars, entityPartyId, firmStart) ?? INDIAN_FY_START_MONTH;
  }
}
