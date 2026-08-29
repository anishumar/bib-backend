// The seams invoicing needs from the world. Interfaces owned by this use case,
// stated in its vocabulary; adapters in infrastructure/ implement them.
import type { Invoice, InvoiceLine, InvoiceStatus, InvoiceTotals } from "../../domain/invoice/model";

export interface NewInvoice {
  readonly id: string;
  readonly tenantId: string;
  readonly partyId: string;
  readonly entityPartyId: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly dueOn: string | null;
  readonly notes: string | null;
  /**
   * The date whose FINANCIAL YEAR decides which series this invoice belongs to.
   *
   * Passed in rather than read from a clock inside the adapter, because it is a
   * business fact — "which year's books does this belong to" — and a firm
   * raising an invoice on 2 April for March's work is deciding it, not
   * discovering it.
   */
  readonly seriesDate: string;
}

export interface NewInvoiceLine {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly engagementId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly currency: string;
  readonly discountPercent: string;
  readonly taxPercent: string;
}

/** An invoice with everything a screen renders it from — the joined read model
 *  CLAUDE.md's rule asks for. `party` and `entity` by NAME, because a letterhead
 *  and an address block print names and a uuid prints as nothing. */
export interface InvoiceRecord {
  readonly invoice: Invoice;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly entity: { readonly id: string; readonly displayName: string };
  readonly lines: readonly InvoiceLineRecord[];
  readonly totals: InvoiceTotals;
}

export interface InvoiceLineRecord {
  readonly line: InvoiceLine;
  /** Net of discount, and the tax on it — both computed by Postgres. Null is
   *  impossible here: an invoice line always has an amount. */
  readonly net: string;
  readonly tax: string;
}

export interface InvoiceSummary {
  readonly invoice: Invoice;
  readonly party: { readonly id: string; readonly displayName: string };
  readonly totals: InvoiceTotals;
}

export interface InvoiceFilters {
  readonly status?: InvoiceStatus | undefined;
  readonly partyId?: string | undefined;
}

export interface InvoiceRepository {
  /**
   * Create the invoice AND take its number, in ONE transaction.
   *
   * The signature is the guarantee. The obvious split — `nextNumber()` then
   * `create()` — cannot be gapless however carefully it is called: between the
   * two the caller may fail, and the number is spent. So the adapter locks the
   * series row with `SELECT … FOR UPDATE`, reads what is actually stored,
   * increments and inserts, all inside one transaction. A rollback anywhere
   * releases the number because the counter never moved.
   *
   * The same reasoning `AssignmentStrategy.assign` gives for choosing and
   * recording being one method, reached from money instead of from fairness.
   */
  create(i: NewInvoice): Promise<Invoice>;
  find(tenantId: string, invoiceId: string): Promise<Invoice | null>;
  describe(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  list(tenantId: string, filters: InvoiceFilters): Promise<readonly InvoiceSummary[]>;

  addLine(l: NewInvoiceLine): Promise<InvoiceLine>;
  removeLine(tenantId: string, invoiceId: string, lineId: string): Promise<void>;
  listLines(tenantId: string, invoiceId: string): Promise<readonly InvoiceLine[]>;

  /** Issue it: the status and the date it carries, in one statement. */
  issue(tenantId: string, invoiceId: string, issuedOn: string): Promise<Invoice>;
  cancel(tenantId: string, invoiceId: string): Promise<Invoice>;
  registerIrn(tenantId: string, invoiceId: string, irn: string, at: string): Promise<Invoice>;

  /** The firm's series, for the screen that names them. */
  listSeries(tenantId: string): Promise<readonly InvoiceSeriesRecord[]>;
  setSeriesPrefix(tenantId: string, entityPartyId: string, prefix: string): Promise<void>;
}

export interface InvoiceSeriesRecord {
  readonly entityPartyId: string;
  readonly entityName: string;
  readonly financialYear: number;
  readonly prefix: string;
  readonly lastNumber: number;
}
