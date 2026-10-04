// The seams invoicing needs from the world. Interfaces owned by this use case,
// stated in its vocabulary; adapters in infrastructure/ implement them.
import type { CompanyCalendars } from "../../domain/calendar/model";
import type { DunningBody } from "../../domain/config/model";
import type { Actor } from "../../domain/ledger/model";
import type {
  CreditNote,
  CreditReason,
  Invoice,
  InvoiceBalance,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTotals,
  NumberOutOfOrder,
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
  /** Whose revenue (0318). Absent: nobody named. */
  readonly managerUserId?: string | null | undefined;
  /**
   * The financial year the draft is filed under until it is issued. PROVISIONAL
   * since the audit of 2026-10-03 (B03): issuing re-derives it from the issue
   * date, in the same transaction that draws the number, so a March draft
   * issued in April is numbered in April's year.
   */
  readonly financialYear: number;
  /** The month the issuing COMPANY's year starts in (0337): a series row the
   *  draft creates is fixed to it, and its label is formatted from it. The
   *  service always sends it; absent (a fixture writing straight to the
   *  repository) is 1 April, as every series was before 0337. */
  readonly fiscalYearStartMonth?: number | undefined;
}

/**
 * A credit note, or why its amount is more than may be credited (B06, B15):
 * checked inside the transaction that writes it, under the invoice's row lock
 * and the advance's lock, so two credits cannot both take the last of it.
 * `maxCredit` is what may still be credited; `takenByBills` (with its tax) is
 * set when the invoice is an advance part of which later bills already took.
 */
export type CreditNoteOutcome =
  | { readonly credit: CreditNote }
  | { readonly maxCredit: string; readonly takenByBills: string | null };

/**
 * A payment, or what stopped it (audit 2026-10-03): `paid` when a reversal
 * would take back more than was received. Decided under the invoice's row
 * lock. A payment above what is owed is recorded (a credit; see the error).
 */
export type PaymentOutcome = { readonly payment: Payment } | { readonly paid: string };

/** A cancellation, or the money that stopped it (B05). */
/** `mapped`: an ad-hoc advance with part of it mapped to work (0363): ending
 *  those mappings comes first, or bills of that work lose what they took. */
export type CancelOutcome =
  | { readonly cancelled: Invoice }
  | { readonly paid: string }
  | { readonly mapped: string };

/**
 * An issue, or why a draft numbered before 0322 was not issued (B51): its
 * number would go out of order, decided under the series' row lock so nothing
 * can be issued between the check and the write. Nothing is written then.
 */
export type IssueOutcome =
  | { readonly issued: Invoice }
  | { readonly outOfOrder: { readonly number: string; readonly order: NumberOutOfOrder } };

/** Why Issue would be refused now, when the record alone can say so (B51). The
 *  message is the refusal's own, so the screen can show it where Issue is
 *  offered; the API still decides at issue. */
export interface IssueBlocked {
  readonly reason: "INVOICE_NUMBER_OUT_OF_ORDER";
  readonly message: string;
}

/** What `issue` writes besides the status: the day, the year that day falls
 *  in (and the month that year starts in, for the number's label), and the due
 *  date to fill in when the draft has none (the firm's terms, or null). */
export interface IssueOn {
  readonly issuedOn: string;
  readonly financialYear: number;
  readonly fiscalYearStartMonth: number;
  readonly dueOnIfUnset: string | null;
}

/**
 * What invoicing needs to know about the firm itself (audit 2026-10-03).
 * `fiscalYearStartMonth` is the compliance policy's (null when the firm has not
 * said, which numbers on 1 April as before); `dueInDays` is the firm's own
 * payment terms (null: no default, never a guessed number).
 */
export interface InvoiceFirmSettings {
  invoiceSettingsFor(tenantId: string): Promise<{
    readonly reportingCurrency: string;
    readonly fiscalYearStartMonth: number | null;
    readonly dueInDays: number | null;
  }>;
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
  /** Whose revenue (0318), by name. Null when nobody was named. */
  readonly manager: {
    readonly userId: string;
    readonly displayName: string | null;
    readonly email: string;
  } | null;
  /** The engagement letters its lines bill, by reference (0318): an invoice
   *  can always be traced back to what the client signed. */
  readonly letters: readonly { readonly id: string; readonly ref: string }[];
  /**
   * The tax rate a line typed by hand starts at (CA#5), by 0322's own rule for
   * the automatic advance: the rate last invoiced on that work, else the
   * issuing company's default (Your firm), else nothing (the person types it).
   */
  readonly taxSuggestions: {
    readonly companyDefault: string | null;
    readonly byEngagement: readonly { readonly engagementId: string; readonly taxPercent: string }[];
  };
}

/** The invoice as the screen reads it: the record, and whether Issue would be
 *  refused right now (B51). Null when nothing on the record stops it. */
export interface InvoiceView extends InvoiceRecord {
  readonly issueBlocked: IssueBlocked | null;
  /** The day Issue would date a draft today: its company's day (0337). Null
   *  once it is out of draft. */
  readonly issuesOn: string | null;
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
  /**
   * What is still owed on THIS invoice, and what has come off it.
   *
   * ── WHY THE LIST CANNOT DO WITHOUT IT ──────────────────────────────────
   *
   * Walked: a fully-settled invoice sat beside one seventy-five days overdue,
   * both reading `issued` and both showing their full value, because `status`
   * is about the DOCUMENT — drafted, issued, cancelled — and says nothing about
   * money. `/receivables` correctly dropped the settled one, so the data
   * existed; the list simply never asked for it.
   *
   * From `crm.invoice_balance`, the same view the collections screen reads, so
   * the two cannot disagree. NOT a stored column and never a badge: "paid" is
   * arithmetic over invoices, payments and credit notes, and a cached answer
   * drifts the first time a payment is corrected.
   *
   * Null on a DRAFT, which owes nothing because nobody has been asked yet —
   * and null is not zero: a zero outstanding on a draft would read as settled.
   */
  readonly balance: {
    readonly paid: string;
    readonly credited: string;
    readonly outstanding: string;
  } | null;
}

export interface InvoiceFilters {
  readonly status?: InvoiceStatus | undefined;
  readonly partyId?: string | undefined;
}

/**
 * Which zone the firm keeps its calendar in (0071) — "today" for an invoice
 * nobody dated, when the caller did not say — and, since 0337, the companies
 * that keep their own zone and year: an invoice is dated and numbered on its
 * COMPANY's. Structural: satisfied by `PostgresFirmTimeZone` and
 * `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
  companyCalendars(tenantId: string): Promise<CompanyCalendars>;
}

/**
 * Which parties are the firm's OWN companies (F-10-1): the issuer must be one,
 * the billed party must not. Satisfied structurally by `DocumentService`, which
 * owns the issuing-entity rule, so the "Charged by" list and this check are one
 * definition (`crm.is_firm_entity`, 0306).
 */
export interface FirmEntities {
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
}

/**
 * A party's name, and whether the firm put it away (0305). Satisfied by the
 * party repository's read-one-by-id, which never hides an archived party.
 */
/**
 * Who is on the firm's staff today (auto-invoice T4), for a manager a PERSON
 * names. Structural: `PostgresMembershipRepository` satisfies it, as it does
 * the lead use case's port of the same shape.
 */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

export interface PartyStanding {
  findParty(
    tenantId: string,
    partyId: string,
  ): Promise<{ readonly displayName: string; readonly archivedAt: string | null } | null>;
}

/** What an invoice line needs to know about the engagement it bills. */
export interface EngagementBilling {
  /** The client it bills (F-10-1). */
  readonly partyId: string;
  /** The firm's company that signed its letter, and so the one that charges
   *  for it: its series is where the invoice's number comes from. */
  readonly issuingEntityPartyId: string;
  /** That letter, so a refusal can name it. */
  readonly letterRef: string;
  /** The currency the letter priced the work in. A line takes the invoice's
   *  currency, so billing this engagement on an invoice in another one would
   *  restate its agreed figure in the wrong money (USD 3,000 as ₹3,000). */
  readonly currency: string;
}

export interface InvoiceRepository {
  /**
   * Create the DRAFT, filed under a provisional financial year, with NO
   * number (0322): the number is drawn by `issue`. A
   * draft cancelled before issue therefore spends nothing, which is what lets a
   * draft be made by the system (the advance at signing) without a cancelled
   * number ever sitting in the series.
   */
  create(i: NewInvoice): Promise<Invoice>;
  find(tenantId: string, invoiceId: string): Promise<Invoice | null>;
  describe(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  list(tenantId: string, filters: InvoiceFilters): Promise<readonly InvoiceSummary[]>;

  addLine(l: NewInvoiceLine): Promise<InvoiceLine>;
  removeLine(tenantId: string, invoiceId: string, lineId: string): Promise<void>;
  listLines(tenantId: string, invoiceId: string): Promise<readonly InvoiceLine[]>;
  /** Whose engagement this is and who signed for it. Null when there is no
   *  such engagement at this firm. */
  engagementOf(tenantId: string, engagementId: string): Promise<EngagementBilling | null>;

  /**
   * Issue it AND take its number, in ONE transaction (0322; the number was
   * taken at `create` until then).
   *
   * The signature is the guarantee. The obvious split — `nextNumber()` then
   * `issue()` — cannot be gapless however carefully it is called: between the
   * two the caller may fail, and the number is spent. So the adapter locks the
   * series row with `SELECT … FOR UPDATE`, reads what is actually stored,
   * increments and writes the number, the status and the date, all inside one
   * transaction. A rollback anywhere releases the number because the counter
   * never moved. A draft made before 0322 already holds its number and keeps it.
   *
   * The same reasoning `AssignmentStrategy.assign` gives for choosing and
   * recording being one method, reached from money instead of from fairness.
   */
  issue(tenantId: string, invoiceId: string, on: IssueOn): Promise<IssueOutcome>;
  /**
   * The highest-numbered invoice of one series (a company's invoices for one
   * financial year) that carries an issue date, other than `exceptInvoiceId`:
   * issued, or issued and cancelled since. Null when none has (B51).
   */
  latestIssuedInSeries(
    tenantId: string,
    series: { readonly entityPartyId: string; readonly financialYear: number },
    exceptInvoiceId: string,
  ): Promise<{ readonly number: string; readonly sequenceNumber: number } | null>;
  /** The newest year this company has drawn a number of this kind in (0337);
   *  null when it has drawn none. `seriesYearFor` keeps a year change from
   *  reopening an older series. */
  newestNumberedYear(
    tenantId: string,
    entityPartyId: string,
    documentType: "invoice" | "credit_note",
  ): Promise<number | null>;
  /**
   * Cancel it, unless it is ISSUED and money was received against it (B05):
   * then nothing changes and the net paid comes back. Checked under the
   * invoice's row lock, so a payment recorded at the same moment cannot slip
   * between the check and the write (a trigger refuses it too).
   */
  cancel(tenantId: string, invoiceId: string): Promise<CancelOutcome>;
  registerIrn(tenantId: string, invoiceId: string, irn: string, at: string): Promise<Invoice>;
  /** A DRAFT's due date (null: none). `status = 'draft'` in the write (B20). */
  setDueOn(tenantId: string, invoiceId: string, dueOn: string | null): Promise<Invoice>;
  /** A DRAFT's manager (null: nobody). `status = 'draft'` in the write. */
  setManager(tenantId: string, invoiceId: string, managerUserId: string | null): Promise<Invoice>;

  /** The firm's series, for the screen that names them. */
  listSeries(tenantId: string): Promise<readonly InvoiceSeriesRecord[]>;
  setSeriesPrefix(tenantId: string, entityPartyId: string, prefix: string): Promise<void>;

  // ── Money against an invoice (T3.5) ───────────────────────────────────────

  /** Records it, unless it is a reversal of more than was paid (read under
   *  the invoice's row lock). More than is owed is recorded: a credit. */
  recordPayment(p: NewPayment): Promise<PaymentOutcome>;
  listPayments(tenantId: string, invoiceId: string): Promise<readonly Payment[]>;

  /**
   * Issue a credit note AND take its number, in one transaction — the same
   * arrangement `create` makes, for the same reason. A credit note is its own
   * legal document with its own consecutive series, so it cannot borrow the
   * invoice counter and cannot be numbered by a caller.
   */
  issueCreditNote(c: NewCreditNote): Promise<CreditNoteOutcome>;
  listCreditNotes(tenantId: string, invoiceId: string): Promise<readonly CreditNote[]>;

  /** What one invoice still owes, computed by Postgres. */
  balanceOf(tenantId: string, invoiceId: string): Promise<InvoiceBalance | null>;
  /**
   * Every invoice with something still owing — "who owes us money".
   *
   * A JOINED read model, not a bare balance. A collections screen renders one
   * row per debt and has to say WHOSE and WHICH; a list of invoice ids with
   * amounts beside them is the per-row-lookup CLAUDE.md names as the sign that
   * the join belongs in the query. Found by building the screen, which is the
   * only thing that asks — the sweep that also calls this ignores the names.
   */
  outstanding(tenantId: string): Promise<readonly ReceivableRecord[]>;
}

/** A debt, with the two facts a person needs to act on it. */
export interface ReceivableRecord {
  readonly balance: InvoiceBalance;
  /** The number a client quotes back and an audit cites. */
  readonly number: string;
  readonly party: { readonly id: string; readonly displayName: string };
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
  /** Which financial year's credit-note series this belongs to: its OWN
   *  date's (B45), and the month that year starts in, for the label. */
  readonly financialYear: number;
  readonly fiscalYearStartMonth: number;
}

export interface InvoiceSeriesRecord {
  readonly entityPartyId: string;
  readonly entityName: string;
  readonly financialYear: number;
  /** The month the series' year starts in, fixed when it started (0337). */
  readonly startMonth: number;
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

/** A terminal rung, and what a partner needs in order to decide it. */
export interface PendingDunningRecord {
  readonly action: DunningActionRecord;
  readonly invoiceNumber: string;
  readonly party: { readonly id: string; readonly displayName: string };
  /** What is actually still owed — the number the decision turns on. A rung
   *  that fired at D+15 on a debt since settled is one a partner rejects. */
  readonly outstanding: string;
  readonly currency: string;
  readonly dueOn: string | null;
  /** The invoice as it stands now: a step on an invoice cancelled since is one
   *  to reject (B22), and the screen says why. */
  readonly invoiceStatus: InvoiceStatus;
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
  /**
   * Terminal rungs waiting for a partner — JOINED to what they are about.
   *
   * The decision is "put THIS CLIENT on credit hold", and a queue that showed a
   * rung, a step key and an invoice uuid would be asking somebody to approve
   * something they cannot see. The client, the invoice number and what is
   * actually outstanding are the decision, so they come back with it.
   */
  pending(tenantId: string): Promise<readonly PendingDunningRecord[]>;
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
 * THE ISSUED COPY (2026-09-29): the invoice's PDF, filed once as it is issued,
 * with the client's name, the lines and the firm's brand as they stand at that
 * moment. It is the copy of record (`hasCopyOfRecord`): nothing draws it
 * again, so a client renamed next month does not change what INV/0004 says.
 * Filed where every rendered document is, and shown to the client in their
 * portal like any invoice.
 *
 * A closure over the document store in `setup/`, as a proposal's PDF is, so
 * this use case never learns what a PDF is. It NEVER THROWS: the invoice is
 * issued whatever happens to its paper. A failure is logged, and the invoice
 * page then offers to make the copy, which shows the renderer's own refusal.
 */
export interface IssuedCopies {
  file(tenantId: string, invoiceId: string, actor: Actor): Promise<void>;
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
