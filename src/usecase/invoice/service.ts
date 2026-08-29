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
import type { Invoice, InvoiceStatus } from "../../domain/invoice/model";
import {
  canTransition,
  financialYearOf,
  isSeriesPrefix,
} from "../../domain/invoice/model";
import { isAmount, isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
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
  IrnAlreadyRegistered,
} from "../../domain/invoice/errors";
import type {
  InvoiceFilters,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
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
