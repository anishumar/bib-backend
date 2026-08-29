// The seams invoicing needs from the world. Interfaces owned by this use case,
// stated in its vocabulary; adapters in infrastructure/ implement them.
import type {
  CreditNote,
  CreditReason,
  Invoice,
  InvoiceBalance,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTotals,
  Payment,
  PaymentMethod,
} from "../../domain/invoice/model";

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

  // ── Money against an invoice (T3.5) ───────────────────────────────────────

  recordPayment(p: NewPayment): Promise<Payment>;
  listPayments(tenantId: string, invoiceId: string): Promise<readonly Payment[]>;

  /**
   * Issue a credit note AND take its number, in one transaction — the same
   * arrangement `create` makes, for the same reason. A credit note is its own
   * legal document with its own consecutive series, so it cannot borrow the
   * invoice counter and cannot be numbered by a caller.
   */
  issueCreditNote(c: NewCreditNote): Promise<CreditNote>;
  listCreditNotes(tenantId: string, invoiceId: string): Promise<readonly CreditNote[]>;

  /** What one invoice still owes, computed by Postgres. */
  balanceOf(tenantId: string, invoiceId: string): Promise<InvoiceBalance | null>;
  /** Every invoice with something still owing — "who owes us money", which is
   *  the question the dunning ladder and every collections screen ask. */
  outstanding(tenantId: string): Promise<readonly InvoiceBalance[]>;
}

export interface NewPayment {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly currency: string;
  readonly receivedOn: string;
  readonly method: PaymentMethod;
  readonly reference: string | null;
  readonly note: string | null;
}

export interface NewCreditNote {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly entityPartyId: string;
  readonly amount: string;
  readonly currency: string;
  readonly issuedOn: string;
  readonly reason: CreditReason;
  readonly note: string | null;
  /** Which financial year's credit-note series this belongs to. */
  readonly seriesDate: string;
}

export interface InvoiceSeriesRecord {
  readonly entityPartyId: string;
  readonly entityName: string;
  readonly financialYear: number;
  /** `invoice` or `credit_note` — two legal series that must not interleave.
   *  0028 widened the key after 0027 shipped without it. */
  readonly documentType: string;
  readonly prefix: string;
  readonly lastNumber: number;
}
