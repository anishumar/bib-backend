// Invoicing (T3.4) — the business rules, against ports. No I/O, no SQL, no HTTP.
//
// The shape of it, and why each part is where it is:
//
//   THE NUMBER IS NOT THIS SERVICE'S TO GIVE. It asks the repository to create
//   an invoice and gets one back already numbered, because a gapless series can
//   only be allocated inside the transaction that writes the row (see
//   `InvoiceRepository.create`). A service that called `nextNumber()` and then
//   `create()` would be gapless only while nothing ever failed between the two.
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
  InvoiceStatus,
  Payment,
} from "../../domain/invoice/model";
import {
  CREDIT_REASONS,
  PAYMENT_METHODS,
  canTransition,
  financialYearOf,
  isCreditReason,
  isPaymentMethod,
  isSeriesPrefix,
} from "../../domain/invoice/model";
import {
  isAmount,
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
  IrnAlreadyRegistered,
} from "../../domain/invoice/errors";
import type {
  InvoiceFilters,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
  ReceivableRecord,
} from "./ports";

export interface Deps {
  readonly invoices: InvoiceRepository;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface RaiseInvoiceInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly dueOn?: string | undefined;
  readonly notes?: string | undefined;
  /** Which year's books this belongs to. Defaults to today, and a firm raising
   *  an invoice on 2 April for March's work overrides it. */
  readonly seriesDate?: string | undefined;
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
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvoiceService {
  constructor(private readonly deps: Deps) {}

  /**
   * Start an invoice. The number is allocated by the write itself.
   *
   * The currency and the FX rate are fixed HERE, at the top of the document,
   * and the lines are held to the currency by a composite foreign key — a
   * mixed-currency invoice is unrepresentable rather than discouraged, exactly
   * as on a proposal. The rate is stored even when the currencies match.
   */
  async raise(input: RaiseInvoiceInput, actor: Actor): Promise<Invoice> {
    const currency = normalizeCurrency(input.currency);
    if (!isCurrencyCode(currency)) throw new InvalidInvoiceCurrency(input.currency);
    // Positive, not merely non-negative: a rate of zero would make every
    // converted total zero and nothing would look wrong until a report did.
    if (!isAmount(input.fxRate) || Number(input.fxRate) <= 0) {
      throw new InvalidInvoiceAmount("fxRate", input.fxRate);
    }
    this.dateOrThrow("fxRateDate", input.fxRateDate);
    const seriesDate = input.seriesDate ?? this.today();
    this.dateOrThrow("seriesDate", seriesDate);
    if (input.dueOn !== undefined) this.dateOrThrow("dueOn", input.dueOn);

    const invoice = await this.deps.invoices.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId: input.partyId,
      entityPartyId: input.entityPartyId,
      currency,
      fxRate: input.fxRate,
      fxRateDate: input.fxRateDate,
      dueOn: input.dueOn ?? null,
      notes: input.notes ?? null,
      seriesDate,
    });

    await this.deps.events.recordEvent({
      tenantId: invoice.tenantId,
      verb: "invoice.raised",
      objectId: invoice.id,
      actor,
      // Ids and machine facts. `notes` is free text a person wrote and stays
      // out of a log that cannot be erased; the NUMBER is in, because it is the
      // machine fact this event is actually about — a consecutive series is
      // evidence, and "which number was allocated, when, by whom" is the whole
      // audit question.
      payload: {
        number: invoice.number,
        partyId: invoice.partyId,
        entityPartyId: invoice.entityPartyId,
        financialYear: invoice.financialYear,
        sequenceNumber: invoice.sequenceNumber,
        currency: invoice.currency,
        fxRate: invoice.fxRate,
        fxRateDate: invoice.fxRateDate,
      },
    });
    return invoice;
  }

  async addLine(input: AddInvoiceLineInput): Promise<void> {
    const invoice = await this.editableOrThrow(input.tenantId, input.invoiceId);
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
    const tax = input.taxPercent ?? "0";
    if (!isAmount(tax) || Number(tax) < 0 || Number(tax) > 100) {
      throw new InvalidInvoiceAmount("taxPercent", tax);
    }

    await this.deps.invoices.addLine({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
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
    });
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
  async issue(tenantId: string, invoiceId: string, actor: Actor): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (!canTransition(invoice.status, "issued")) {
      throw new InvalidInvoiceTransition(invoice.status, "issued");
    }
    const lines = await this.deps.invoices.listLines(tenantId, invoiceId);
    if (lines.length === 0) throw new EmptyInvoice(invoiceId);

    const issued = await this.deps.invoices.issue(tenantId, invoiceId, this.today());
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice.issued",
      objectId: issued.id,
      actor,
      payload: {
        number: issued.number,
        partyId: issued.partyId,
        entityPartyId: issued.entityPartyId,
        issuedOn: issued.issuedOn,
        lineCount: lines.length,
      },
    });
    return issued;
  }

  /**
   * Withdraw it.
   *
   * The number is NOT released and the row is not removed — that is what makes
   * the series consecutive. A cancelled invoice stays in the sequence, readable,
   * saying it was cancelled, which is exactly what an auditor needs to see where
   * a number went.
   */
  async cancel(tenantId: string, invoiceId: string, actor: Actor): Promise<Invoice> {
    const invoice = await this.mustFind(tenantId, invoiceId);
    if (!canTransition(invoice.status, "cancelled")) {
      throw new InvalidInvoiceTransition(invoice.status, "cancelled");
    }
    const cancelled = await this.deps.invoices.cancel(tenantId, invoiceId);
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

  async describe(tenantId: string, invoiceId: string): Promise<InvoiceRecord> {
    const record = await this.deps.invoices.describe(tenantId, invoiceId);
    if (record === null) throw new InvoiceNotFound(invoiceId);
    return record;
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
    await this.deps.invoices.setSeriesPrefix(tenantId, entityPartyId, prefix);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "invoice_series.set",
      objectId: entityPartyId,
      actor,
      payload: { entityPartyId, prefix },
    });
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
    },
    actor: Actor,
  ): Promise<Payment> {
    const invoice = await this.issuedOrThrow(input.tenantId, input.invoiceId);
    // SIGNED, unlike every other amount in this product. A negative payment is
    // a reversal — see `isSignedAmount`. Zero is refused either way: it records
    // nothing and would sit in the ledger claiming something happened.
    if (!isSignedAmount(input.amount) || Number(input.amount) === 0) {
      throw new InvalidInvoiceAmount("amount", input.amount);
    }
    if (!isPaymentMethod(input.method)) {
      throw new InvalidPaymentMethod(input.method, PAYMENT_METHODS);
    }
    this.dateOrThrow("receivedOn", input.receivedOn);

    const payment = await this.deps.invoices.recordPayment({
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
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "payment.recorded",
      objectId: payment.id,
      actor,
      // Ids and machine facts. The bank REFERENCE is in, because it is the
      // counterparty's own machine identifier and is what a reconciliation
      // dispute turns on; the free-text note is not.
      payload: {
        invoiceId: payment.invoiceId,
        invoiceNumber: invoice.number,
        amount: payment.amount,
        currency: payment.currency,
        receivedOn: payment.receivedOn,
        method: payment.method,
        reference: payment.reference,
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
    const issuedOn = input.issuedOn ?? this.today();
    this.dateOrThrow("issuedOn", issuedOn);

    // A firm cannot credit more than it billed. Checked here rather than in a
    // CHECK constraint because the limit depends on the SUM of every OTHER
    // credit note against this invoice, which a row-level constraint cannot
    // see — the honest place for it is the one that can read the siblings.
    const balance = await this.deps.invoices.balanceOf(input.tenantId, input.invoiceId);
    if (balance !== null) {
      const remaining = Number(balance.invoiced) - Number(balance.credited);
      if (Number(input.amount) > remaining) {
        throw new CreditExceedsInvoice(input.invoiceId, input.amount, remaining.toFixed(4));
      }
    }

    const credit = await this.deps.invoices.issueCreditNote({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      entityPartyId: invoice.entityPartyId,
      amount: input.amount,
      currency: invoice.currency,
      issuedOn,
      reason: input.reason,
      note: input.note ?? null,
      seriesDate: issuedOn,
    });

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

  /** Today as an ISO DATE, not an instant. An invoice date is a calendar fact
   *  in a jurisdiction — the same rule the scheduler's arithmetic follows. */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}
