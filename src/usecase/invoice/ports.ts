// The seams invoicing needs from the world. Interfaces owned by this use case,
// stated in its vocabulary; adapters in infrastructure/ implement them.
import type { DunningBody } from "../../domain/config/model";
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

// ── The dunning ladder (T3.5) ──────────────────────────────────────────────

export interface DunningActionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly step: string;
  readonly afterDays: number;
  readonly action: string;
  readonly state: "taken" | "pending_approval" | "approved" | "rejected";
  readonly approvedBy: string | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
}

export interface NewDunningAction {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly step: string;
  readonly afterDays: number;
  readonly action: string;
  /** `taken` for a rung a machine may climb; `pending_approval` for the two it
   *  may reach and may not apply. */
  readonly state: "taken" | "pending_approval";
}

export interface DunningRepository {
  /**
   * Take a rung, ONCE.
   *
   * Returns null when the rung was already taken — an ON CONFLICT DO NOTHING,
   * not an error, because the sweep re-reads invoices it has seen and pg-boss
   * redelivers on a crash. A second reminder to a client who has already paid
   * is the kind of mistake a firm hears about, so it is made impossible by the
   * unique key rather than avoided by careful callers.
   *
   * The null is what tells the service NOT to write an event, which is the same
   * arrangement the scheduler's derived job id has.
   */
  take(a: NewDunningAction): Promise<DunningActionRecord | null>;
  /** Which rungs an invoice has already had — the sweep's own memory. */
  taken(tenantId: string, invoiceId: string): Promise<readonly string[]>;
  /** Terminal rungs waiting for a partner. */
  pending(tenantId: string): Promise<readonly DunningActionRecord[]>;
  decide(
    tenantId: string,
    actionId: string,
    state: "approved" | "rejected",
    approvedBy: string,
    at: string,
    note: string | null,
  ): Promise<DunningActionRecord | null>;
  find(tenantId: string, actionId: string): Promise<DunningActionRecord | null>;
  listFor(tenantId: string, invoiceId: string): Promise<readonly DunningActionRecord[]>;
}

/**
 * The ladder in force at a firm, read LIVE from the configuration registry.
 *
 * Live rather than pinned: a firm that softens its ladder expects the next
 * sweep to use the new one, the same reading roles get. What a rung MEANT when
 * it fired is already recorded on the action row (`afterDays` is snapshotted),
 * so nothing historical depends on this read.
 */
export interface DunningLadderSource {
  ladderFor(tenantId: string): Promise<DunningBody | null>;
}

/**
 * Which firms exist — the sweep's outer loop.
 *
 * DECLARED HERE AND AGAIN in `usecase/scheduler/ports.ts`, deliberately: a port
 * is owned by the use case that needs it, and the two are free to diverge. What
 * they must not do is share a type through a package neither owns. The ADAPTER
 * is one — `PostgresTenantDirectory` in `job-repository.ts` — because two
 * pieces of SQL answering "which firms exist" would eventually disagree.
 */
export interface TenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}
