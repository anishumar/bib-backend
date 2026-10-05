// In-memory port fakes for invoicing. `implements` the port, so the rules can be
// tested with zero infrastructure.
//
// WHAT IS NOT FAKED, AND WHERE THE REAL ANSWER LIVES: THE GAPLESSNESS ITSELF.
// This fake allocates a number the obvious way — read the counter, add one —
// and under a single-threaded test that is indistinguishable from correct. The
// property that matters is what happens when a transaction ROLLS BACK and when
// two writers arrive at once, and both are properties of a Postgres row lock
// rather than of this code. A fake asserting them would be asserting its own
// behaviour, which is the most comfortable kind of green test and the least
// informative. `tests/invoice/numbering.integration.test.ts` proves them
// against a real database, the same division `FakeDocumentReferences` draws.
import type {
  CreditNote,
  Invoice,
  InvoiceBalance,
  InvoiceLine,
  InvoiceTaxSnapshot,
  Payment,
} from "../domain/invoice/model";
import { lineTax, tdsOn, netPayable } from "../domain/invoice/gst";
import {
  NO_TAX_SNAPSHOT,
  DEFAULT_CREDIT_NOTE_PREFIX,
  DEFAULT_SERIES_PREFIX,
  formatInvoiceNumber,
  INDIAN_FY_START_MONTH,
  preDrawnNumberOrder,
} from "../domain/invoice/model";
import type {
  EngagementBilling,
  InvoiceFilters,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceFirmSettings,
  InvoiceSummary,
  CancelOutcome,
  CreditNoteOutcome,
  PaymentOutcome,
  IssueOn,
  IssueOutcome,
  IssuedCopies,
  NewCreditNote,
  NewInvoice,
  NewInvoiceLine,
  NewPayment,
  ReceivableRecord,
  BankAccountView,
  ClientTds,
  InvoiceTaxFacts,
} from "../usecase/invoice/ports";
import type { Deps } from "../usecase/invoice/service";
import { CompanyInvoicingService } from "../usecase/invoice/company";
import type { CompanyInvoicing, CompanyInvoicingRepository, NewBankAccount } from "../usecase/invoice/company";
import { FakeIds } from "./ids";
import { FakeFirmTimeZone } from "./tenancy";
import { FakePartyStanding } from "./party";
import { FakeClock } from "./clock";
import { RecordingEventSink } from "./ledger";
import { FakeStaffDirectory } from "./lead";

interface SeriesKey {
  readonly tenantId: string;
  readonly entityPartyId: string;
  readonly financialYear: number;
}

function keyOf(k: SeriesKey): string {
  return `${k.tenantId}|${k.entityPartyId}|${String(k.financialYear)}`;
}

/**
 * The world an invoice's tax is decided from (Q056), as a test sets it. The
 * default is a company with no country: every invoice is `plain`, as before.
 */
export interface FakeTaxWorld {
  supplierCountry: string | null;
  supplierGstin: string | null;
  recipientCountry: string | null;
  recipientGstin: string | null;
  recipientRegion: string | null;
  recipientHasAddress: boolean;
  /** LUT ids by financial year. */
  luts: Map<number, string>;
  bankAccountId: string | null;
  /** The catalogue's tax per engagement's service. */
  serviceTax: Map<string, { sac: string | null; ratePercent: string | null }>;
}

export class FakeInvoiceRepo implements InvoiceRepository {
  readonly world: FakeTaxWorld = {
    supplierCountry: null,
    supplierGstin: null,
    recipientCountry: null,
    recipientGstin: null,
    recipientRegion: null,
    recipientHasAddress: false,
    luts: new Map(),
    bankAccountId: null,
    serviceTax: new Map(),
  };
  readonly clientTdsByParty = new Map<string, ClientTds>();

  taxFacts(
    tenantId: string,
    invoiceId: string,
    on: { readonly onDay: string; readonly financialYear: number },
  ): Promise<InvoiceTaxFacts> {
    const invoice = this.invoices.find((i) => i.tenantId === tenantId && i.id === invoiceId);
    if (invoice === undefined) return Promise.reject(new Error(`no invoice ${invoiceId}`));
    const w = this.world;
    return Promise.resolve({
      supplierCountry: w.supplierCountry,
      supplierGstin: w.supplierGstin,
      recipientName: this.nameOf(invoice.partyId),
      recipientCountry: w.recipientCountry,
      recipientGstin: w.recipientGstin,
      recipientRegion: w.recipientRegion,
      recipientHasAddress: w.recipientHasAddress,
      lutId: w.luts.get(on.financialYear) ?? null,
      bankAccountId: w.bankAccountId,
      clientTds: this.clientTdsByParty.get(invoice.partyId) ?? null,
      lines: this.liveLines(invoiceId).map((l) => ({
        id: l.id,
        description: l.description,
        sac: l.sac,
        serviceSac: l.engagementId === null ? null : (w.serviceTax.get(l.engagementId)?.sac ?? null),
      })),
    });
  }

  async setDraftTax(
    tenantId: string,
    invoiceId: string,
    tax: InvoiceTaxSnapshot,
    fillSacs: readonly { readonly lineId: string; readonly sac: string }[],
  ): Promise<Invoice> {
    for (const f of fillSacs) await this.setLineSac(tenantId, invoiceId, f.lineId, f.sac, true);
    return this.patch(tenantId, invoiceId, { tax });
  }

  setLineSac(_tenantId: string, invoiceId: string, lineId: string, sac: string | null, onlyIfEmpty = false): Promise<void> {
    const at = this.lines.findIndex((l) => l.id === lineId && l.invoiceId === invoiceId && !l.removed);
    const line = this.lines[at];
    if (line !== undefined && (!onlyIfEmpty || line.sac === null)) this.lines[at] = { ...line, sac };
    return Promise.resolve();
  }

  serviceTaxFor(
    _tenantId: string,
    engagementId: string,
  ): Promise<{ readonly sac: string | null; readonly ratePercent: string | null } | null> {
    return Promise.resolve(this.world.serviceTax.get(engagementId) ?? null);
  }

  clientTds(_tenantId: string, partyId: string): Promise<ClientTds | null> {
    return Promise.resolve(this.clientTdsByParty.get(partyId) ?? null);
  }

  setClientTds(_tenantId: string, partyId: string, tds: ClientTds | null): Promise<void> {
    if (tds === null) this.clientTdsByParty.delete(partyId);
    else this.clientTdsByParty.set(partyId, tds);
    return Promise.resolve();
  }

  readonly invoices: Invoice[] = [];
  readonly lines: (InvoiceLine & { removed: boolean })[] = [];
  /** Display names, so a joined read returns something a screen could render. */
  readonly partyNames = new Map<string, string>();
  /** Engagement id to the client it bills, the company that signed its
   *  letter and the currency it priced the work in; unknown ids are absent. */
  readonly engagements = new Map<string, EngagementBilling>();

  engagementOf(_tenantId: string, engagementId: string): Promise<EngagementBilling | null> {
    return Promise.resolve(this.engagements.get(engagementId) ?? null);
  }
  private readonly series = new Map<string, { last: number; prefix: string; startMonth: number }>();

  /** The company's series for the year, created as the adapter creates it
   *  (0337): fixed to the year's start month, with the company's latest
   *  prefix carried into a new year. */
  private seriesRow(k: string, entityPartyId: string, startMonth: number): { last: number; prefix: string; startMonth: number } {
    const found = this.series.get(k);
    if (found) return found;
    const prior = [...this.series.entries()]
      .filter(([key]) => key.split("|")[1] === entityPartyId)
      .sort(([a], [b]) => Number(b.split("|")[2]) - Number(a.split("|")[2]))[0];
    const row = { last: 0, prefix: prior?.[1].prefix ?? DEFAULT_SERIES_PREFIX, startMonth };
    this.series.set(k, row);
    return row;
  }

  /** A draft, unnumbered (0322), in its series for the year: the series row
   *  exists from here, as the adapter's does. */
  create(i: NewInvoice): Promise<Invoice> {
    const financialYear = i.financialYear;
    const k = keyOf({ tenantId: i.tenantId, entityPartyId: i.entityPartyId, financialYear });
    this.seriesRow(k, i.entityPartyId, i.fiscalYearStartMonth ?? INDIAN_FY_START_MONTH);

    const invoice: Invoice = {
      id: i.id,
      tenantId: i.tenantId,
      partyId: i.partyId,
      entityPartyId: i.entityPartyId,
      number: null,
      financialYear,
      sequenceNumber: null,
      status: "draft",
      currency: i.currency,
      fxRate: i.fxRate,
      fxRateDate: i.fxRateDate,
      issuedOn: null,
      dueOn: i.dueOn,
      irn: null,
      irnRegisteredAt: null,
      notes: i.notes,
      managerUserId: i.managerUserId ?? null,
      tax: NO_TAX_SNAPSHOT,
    };
    this.invoices.push(invoice);
    return Promise.resolve(invoice);
  }

  find(tenantId: string, invoiceId: string): Promise<Invoice | null> {
    return Promise.resolve(
      this.invoices.find((i) => i.tenantId === tenantId && i.id === invoiceId) ?? null,
    );
  }

  async describe(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const invoice = await this.find(tenantId, invoiceId);
    if (invoice === null) return null;
    const lines = this.liveLines(invoiceId);
    return {
      invoice,
      party: { id: invoice.partyId, displayName: this.nameOf(invoice.partyId) },
      entity: { id: invoice.entityPartyId, displayName: this.nameOf(invoice.entityPartyId) },
      lines: lines.map((line) => this.lineRecord(line, invoice)),
      totals: this.totalsOf(invoice),
      lut: invoice.tax.lutId === null ? null : { id: invoice.tax.lutId, reference: "AD2704260000001", financialYear: invoice.financialYear },
      bankAccount: null,
      manager:
        invoice.managerUserId === null
          ? null
          : { userId: invoice.managerUserId, displayName: null, email: "manager@example.test" },
      letters: [],
      taxSuggestions: { companyDefault: this.companyTaxDefault, byEngagement: [] },
    };
  }

  /** The issuing company's default tax rate, as a test sets it (CA#5). */
  companyTaxDefault: string | null = null;

  list(tenantId: string, filters: InvoiceFilters): Promise<readonly InvoiceSummary[]> {
    return Promise.resolve(
      this.invoices
        // NEWEST FIRST, matching the adapter's `ORDER BY created_at DESC`.
        // Insertion order here is chronological, so reversing it is the same
        // answer — and a fake that listed the other way round would let a test
        // assert an order the database does not produce.
        .slice()
        .reverse()
        .filter(
          (i) =>
            i.tenantId === tenantId &&
            (filters.status === undefined || i.status === filters.status) &&
            (filters.partyId === undefined || i.partyId === filters.partyId),
        )
        .map((invoice) => {
          const b = this.balance(invoice);
          return {
            invoice,
            party: { id: invoice.partyId, displayName: this.nameOf(invoice.partyId) },
            totals: this.totalsOf(invoice),
            // ONLY AN ISSUED INVOICE OWES ANYTHING, mirroring the adapter: a
            // draft has not been asked for and a cancelled one was withdrawn.
            // `/receivables` has always read it this way.
            balance:
              invoice.status === "issued"
                ? { paid: b.paid, credited: b.credited, outstanding: b.outstanding, tds: b.tds }
                : null,
          };
        }),
    );
  }

  addLine(l: NewInvoiceLine): Promise<InvoiceLine> {
    const position = this.liveLines(l.invoiceId).length + 1;
    const line: InvoiceLine & { removed: boolean } = { ...l, position, removed: false };
    this.lines.push(line);
    return Promise.resolve(line);
  }

  removeLine(_tenantId: string, invoiceId: string, lineId: string): Promise<void> {
    const at = this.lines.findIndex((l) => l.id === lineId && l.invoiceId === invoiceId);
    const existing = this.lines[at];
    if (existing !== undefined) this.lines[at] = { ...existing, removed: true };
    return Promise.resolve();
  }

  listLines(_tenantId: string, invoiceId: string): Promise<readonly InvoiceLine[]> {
    return Promise.resolve(this.liveLines(invoiceId));
  }

  /**
   * A draft as one made before 0322 was: numbered when it was drafted, the
   * series' counter moved for it then (B51). Only a test makes one; the
   * product has not since 0322.
   */
  preDrawnDraft(d: {
    readonly id: string;
    readonly tenantId: string;
    readonly partyId: string;
    readonly entityPartyId: string;
    readonly financialYear: number;
  }): Invoice {
    const k = keyOf(d);
    const existing = this.series.get(k) ?? { last: 0, prefix: DEFAULT_SERIES_PREFIX, startMonth: INDIAN_FY_START_MONTH };
    const sequence = existing.last + 1;
    this.series.set(k, { ...existing, last: sequence });
    const invoice: Invoice = {
      id: d.id,
      tenantId: d.tenantId,
      partyId: d.partyId,
      entityPartyId: d.entityPartyId,
      number: formatInvoiceNumber({ prefix: existing.prefix, financialYear: d.financialYear, sequence }),
      financialYear: d.financialYear,
      sequenceNumber: sequence,
      status: "draft",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-04-01",
      issuedOn: null,
      dueOn: null,
      irn: null,
      irnRegisteredAt: null,
      notes: null,
      managerUserId: null,
      tax: NO_TAX_SNAPSHOT,
    };
    this.invoices.push(invoice);
    return invoice;
  }

  /** Issue and number in one step (0322): the next in the draft's series, or
   *  the number a pre-0322 draft already holds while it is in order (B51). */
  async issue(tenantId: string, invoiceId: string, on: IssueOn): Promise<IssueOutcome> {
    const draft = await this.find(tenantId, invoiceId);
    if (draft === null || draft.status !== "draft") throw new Error(`could not issue invoice ${invoiceId}`);
    const issuedOn = on.issuedOn;
    const dueOn = draft.dueOn ?? on.dueOnIfUnset;
    for (const f of on.fillSacs) await this.setLineSac(tenantId, invoiceId, f.lineId, f.sac, true);
    const tax = on.tax;
    if (draft.number !== null && draft.sequenceNumber !== null) {
      const order = preDrawnNumberOrder({
        draft: { financialYear: draft.financialYear, sequenceNumber: draft.sequenceNumber },
        issueFinancialYear: on.financialYear,
        latestIssued: await this.latestIssuedInSeries(tenantId, draft, invoiceId),
      });
      if (!order.inOrder) return { outOfOrder: { number: draft.number, order } };
      return { issued: await this.patch(tenantId, invoiceId, { status: "issued", issuedOn, dueOn, tax }) };
    }
    // The issue date's year (B03), as the adapter moves an unnumbered draft.
    const financialYear = on.financialYear;
    const k = keyOf({ tenantId, entityPartyId: draft.entityPartyId, financialYear });
    const existing = this.seriesRow(k, draft.entityPartyId, on.fiscalYearStartMonth);
    const sequence = existing.last + 1;
    this.series.set(k, { ...existing, last: sequence });
    return {
      issued: await this.patch(tenantId, invoiceId, {
        status: "issued",
        issuedOn,
        dueOn,
        tax,
        financialYear,
        number: formatInvoiceNumber({ prefix: existing.prefix, financialYear, sequence, startMonth: existing.startMonth }),
        sequenceNumber: sequence,
      }),
    };
  }

  latestIssuedInSeries(
    tenantId: string,
    series: { readonly entityPartyId: string; readonly financialYear: number },
    exceptInvoiceId: string,
  ): Promise<{ readonly number: string; readonly sequenceNumber: number } | null> {
    let latest: { number: string; sequenceNumber: number } | null = null;
    for (const i of this.invoices) {
      if (
        i.tenantId !== tenantId ||
        i.id === exceptInvoiceId ||
        i.entityPartyId !== series.entityPartyId ||
        i.financialYear !== series.financialYear ||
        i.issuedOn === null ||
        i.number === null ||
        i.sequenceNumber === null
      ) {
        continue;
      }
      if (latest === null || i.sequenceNumber > latest.sequenceNumber) {
        latest = { number: i.number, sequenceNumber: i.sequenceNumber };
      }
    }
    return Promise.resolve(latest);
  }

  async cancel(tenantId: string, invoiceId: string): Promise<CancelOutcome> {
    // As the adapter: an issued invoice with money on it stays (B05).
    const invoice = await this.find(tenantId, invoiceId);
    if (invoice?.status === "issued") {
      const mine = this.payments.filter((p) => p.invoiceId === invoiceId);
      const paid = mine.reduce((acc, p) => acc + scaled(p.amount), 0n);
      const tds = mine.reduce((acc, p) => acc + scaled(p.tdsAmount), 0n);
      if (paid !== 0n || tds !== 0n) return { paid: unscaled(paid) };
    }
    return { cancelled: await this.patch(tenantId, invoiceId, { status: "cancelled" }) };
  }

  registerIrn(tenantId: string, invoiceId: string, irn: string, at: string): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { irn, irnRegisteredAt: at });
  }

  setDueOn(tenantId: string, invoiceId: string, dueOn: string | null): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { dueOn });
  }

  setManager(tenantId: string, invoiceId: string, managerUserId: string | null): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { managerUserId });
  }

  listSeries(tenantId: string): Promise<readonly InvoiceSeriesRecord[]> {
    const out: InvoiceSeriesRecord[] = [];
    for (const [k, v] of this.series) {
      const [t, entityPartyId, fy] = k.split("|");
      if (t !== tenantId || entityPartyId === undefined || fy === undefined) continue;
      out.push({
        entityPartyId,
        entityName: this.nameOf(entityPartyId),
        financialYear: Number(fy),
        startMonth: v.startMonth,
        documentType: "invoice",
        prefix: v.prefix,
        lastNumber: v.last,
      });
    }
    return Promise.resolve(out);
  }

  setSeriesPrefix(tenantId: string, entityPartyId: string, prefix: string): Promise<void> {
    for (const [k, v] of this.series) {
      if (k.startsWith(`${tenantId}|${entityPartyId}|`)) this.series.set(k, { ...v, prefix });
    }
    return Promise.resolve();
  }

  // ── Money against an invoice (T3.5) ──────────────────────────────────────

  readonly payments: Payment[] = [];
  readonly creditNotes: CreditNote[] = [];

  async recordPayment(p: NewPayment): Promise<PaymentOutcome> {
    // The adapter's rule (audit 2026-10-03): a reversal takes back no more
    // than was paid. More than is owed is recorded (a credit).
    const invoice = await this.find(p.tenantId, p.invoiceId);
    if (invoice !== null) {
      const amount = scaled(p.amount);
      const { paid, tds } = this.balance(invoice);
      if (amount < 0n && -amount > scaled(paid)) return { paid };
      const tdsAmount = scaled(p.tdsAmount);
      if (tdsAmount < 0n && -tdsAmount > scaled(tds)) return { tds };
    }
    this.payments.push(p);
    return { payment: p };
  }

  listPayments(_tenantId: string, invoiceId: string): Promise<readonly Payment[]> {
    return Promise.resolve(this.payments.filter((p) => p.invoiceId === invoiceId));
  }

  async issueCreditNote(c: NewCreditNote): Promise<CreditNoteOutcome> {
    // The adapter's cap without the advance half (bills are not faked here):
    // no more than has not been credited. The advance half is proven against
    // Postgres in advance.integration.test.ts.
    const invoice = await this.find(c.tenantId, c.invoiceId);
    if (invoice !== null) {
      const b = this.balance(invoice);
      const left = scaled(b.invoiced) - scaled(b.credited);
      if (scaled(c.amount) > left) return { maxCredit: unscaled(left), takenByBills: null };
    }
    const financialYear = c.financialYear;
    // A SEPARATE key from the invoice series — the correction 0028 made after
    // 0027 shipped without a document type. A fake that shared the counter
    // would let a test pass on interleaved numbering the database refuses.
    const k = `${keyOf({ tenantId: c.tenantId, entityPartyId: c.entityPartyId, financialYear })}|credit_note`;
    // Fixed to the year's start month when the series is made, as the
    // adapter's row is (0337).
    const existing = this.creditSeries.get(k) ?? {
      last: 0,
      prefix: DEFAULT_CREDIT_NOTE_PREFIX,
      startMonth: c.fiscalYearStartMonth,
    };
    const sequence = existing.last + 1;
    this.creditSeries.set(k, { ...existing, last: sequence });

    const note: CreditNote = {
      id: c.id,
      tenantId: c.tenantId,
      invoiceId: c.invoiceId,
      entityPartyId: c.entityPartyId,
      number: formatInvoiceNumber({ prefix: existing.prefix, financialYear, sequence, startMonth: existing.startMonth }),
      financialYear,
      sequenceNumber: sequence,
      amount: c.amount,
      currency: c.currency,
      issuedOn: c.issuedOn,
      reason: c.reason,
      note: c.note,
    };
    this.creditNotes.push(note);
    return { credit: note };
  }

  listCreditNotes(_tenantId: string, invoiceId: string): Promise<readonly CreditNote[]> {
    return Promise.resolve(this.creditNotes.filter((c) => c.invoiceId === invoiceId));
  }

  async balanceOf(tenantId: string, invoiceId: string): Promise<InvoiceBalance | null> {
    const invoice = await this.find(tenantId, invoiceId);
    if (invoice === null) return null;
    return this.balance(invoice);
  }

  async outstanding(tenantId: string): Promise<readonly ReceivableRecord[]> {
    const owing = this.invoices
      .filter((i) => i.tenantId === tenantId && i.status === "issued")
      .map((invoice) => ({ invoice, balance: this.balance(invoice) }))
      .filter((r) => scaled(r.balance.outstanding) > 0n);
    return Promise.resolve(
      owing.map((r) => ({
        balance: r.balance,
        number: r.invoice.number ?? "",
        party: { id: r.invoice.partyId, displayName: this.nameOf(r.invoice.partyId) },
      })),
    );
  }

  private balance(invoice: Invoice): InvoiceBalance {
    const totals = this.totalsOf(invoice);
    const paid = this.payments
      .filter((p) => p.invoiceId === invoice.id)
      .reduce((acc, p) => acc + scaled(p.amount), 0n);
    const credited = this.creditNotes
      .filter((c) => c.invoiceId === invoice.id)
      .reduce((acc, c) => acc + scaled(c.amount), 0n);
    const tds = this.payments
      .filter((p) => p.invoiceId === invoice.id)
      .reduce((acc, p) => acc + scaled(p.tdsAmount), 0n);
    return {
      invoiceId: invoice.id,
      partyId: invoice.partyId,
      status: invoice.status,
      currency: invoice.currency,
      dueOn: invoice.dueOn,
      invoiced: totals.total,
      paid: unscaled(paid),
      credited: unscaled(credited),
      // Only an ISSUED invoice owes anything, as the view says since 0326 (B22);
      // TDS the client deducted settles like money (Q057, 0371).
      outstanding: invoice.status === "issued" ? unscaled(scaled(totals.total) - paid - tds - credited) : "0.0000",
      tds: unscaled(tds),
    };
  }

  private readonly creditSeries = new Map<string, { last: number; prefix: string; startMonth: number }>();

  newestNumberedYear(
    tenantId: string,
    entityPartyId: string,
    documentType: "invoice" | "credit_note",
  ): Promise<number | null> {
    const rows = documentType === "invoice" ? this.series : this.creditSeries;
    const years = [...rows.entries()]
      .filter(([k, v]) => k.startsWith(`${tenantId}|${entityPartyId}|`) && v.last > 0)
      .map(([k]) => Number(k.split("|")[2]));
    return Promise.resolve(years.length === 0 ? null : Math.max(...years));
  }

  private patch(tenantId: string, invoiceId: string, over: Partial<Invoice>): Promise<Invoice> {
    const at = this.invoices.findIndex((i) => i.tenantId === tenantId && i.id === invoiceId);
    const existing = this.invoices[at];
    if (existing === undefined) throw new Error(`no invoice ${invoiceId}`);
    const next = { ...existing, ...over };
    this.invoices[at] = next;
    return Promise.resolve(next);
  }

  private liveLines(invoiceId: string): (InvoiceLine & { removed: boolean })[] {
    return this.lines.filter((l) => l.invoiceId === invoiceId && !l.removed);
  }

  private nameOf(partyId: string): string {
    return this.partyNames.get(partyId) ?? partyId;
  }

  /**
   * A line's figures. On a GST invoice (Q056) the domain's `lineTax`, the rule
   * `crm.invoice_line_amount` holds (0370); on a plain or pre-0370 one this
   * fake's own four-place arithmetic, as before.
   */
  private lineRecord(line: InvoiceLine & { removed: boolean }, invoice: Invoice) {
    const t = invoice.tax.treatment;
    if (t === null || t === "plain") {
      return { line, net: net(line), tax: tax(line), cgst: "0.0000", sgst: "0.0000", utgst: "0.0000", igst: "0.0000" };
    }
    const r = lineTax({
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      discountPercent: line.discountPercent,
      taxPercent: line.taxPercent,
      currency: invoice.currency,
      treatment: t,
    });
    return { line, net: r.net, tax: r.tax, cgst: r.cgst, sgst: r.sgst, utgst: r.utgst, igst: r.igst };
  }

  private totalsOf(invoice: Invoice): InvoiceRecord["totals"] {
    const lines = this.liveLines(invoice.id);
    const records = lines.map((l) => this.lineRecord(l, invoice));
    const sum = (f: (r: (typeof records)[number]) => string): bigint =>
      records.reduce((acc, r) => acc + scaled(f(r)), 0n);
    const gross = lines.reduce((acc, l) => acc + (scaled(l.quantity) * scaled(l.unitAmount)) / UNIT, 0n);
    const netTotal = sum((r) => r.net);
    const taxTotal = sum((r) => r.tax);
    const total = unscaled(netTotal + taxTotal);
    const tds =
      invoice.tax.tdsPercent === null
        ? "0.0000"
        : tdsOn({ taxable: unscaled(netTotal), percent: invoice.tax.tdsPercent, currency: invoice.currency });
    return {
      lineCount: lines.length,
      gross: unscaled(gross),
      discount: unscaled(gross - netTotal),
      net: unscaled(netTotal),
      tax: unscaled(taxTotal),
      total,
      currency: invoice.currency,
      cgst: unscaled(sum((r) => r.cgst)),
      sgst: unscaled(sum((r) => r.sgst)),
      utgst: unscaled(sum((r) => r.utgst)),
      igst: unscaled(sum((r) => r.igst)),
      tds,
      netPayable: netPayable(total, tds),
      // The fake does not round totals (Q087); the view's rounding is proven
      // in `tests/invoice/round-off.integration.test.ts`.
      roundOff: "0.0000",
    };
  }
}

// ── Exact decimal arithmetic, for the fake only ────────────────────────────
// Same reasoning as the proposal and engagement fakes: a float would make this
// disagree with Postgres on precisely the numbers worth testing, and the
// migration is the authority either way.

const UNIT = 10000n;

// SIGNED, both ways: a reversal is a negative payment, and "-3000.01" read as
// -3000 + 0.01 summed the paid amount wrong.
function scaled(v: string): bigint {
  const negative = v.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? v.slice(1) : v).split(".");
  const magnitude = BigInt(whole) * UNIT + BigInt((fraction + "0000").slice(0, 4));
  return negative ? -magnitude : magnitude;
}

function unscaled(v: bigint): string {
  const magnitude = v < 0n ? -v : v;
  const text = `${(magnitude / UNIT).toString()}.${(magnitude % UNIT).toString().padStart(4, "0")}`;
  return v < 0n ? `-${text}` : text;
}

function scaledNet(l: InvoiceLine): bigint {
  const gross = (scaled(l.quantity) * scaled(l.unitAmount)) / UNIT;
  return (gross * (100n * UNIT - scaled(l.discountPercent))) / (100n * UNIT);
}

function scaledTax(l: InvoiceLine): bigint {
  return (scaledNet(l) * scaled(l.taxPercent)) / (100n * UNIT);
}

function net(l: InvoiceLine): string {
  return unscaled(scaledNet(l));
}

function tax(l: InvoiceLine): string {
  return unscaled(scaledTax(l));
}

/**
 * Which parties are the firm's own companies (F-10-1). EMPTY until a test names
 * them: a firm's companies are configuration, and a fake that assumed some
 * would let a test raise an invoice from a party the real check refuses.
 */
export class FakeFirmEntities {
  readonly ids = new Set<string>();

  add(...partyIds: string[]): this {
    for (const id of partyIds) this.ids.add(id);
    return this;
  }

  isFirmEntity(_tenantId: string, partyId: string): Promise<boolean> {
    return Promise.resolve(this.ids.has(partyId));
  }
}

/** The firm's own settings for invoicing; a test sets the ones it is about.
 *  INR, no year start said (1 April), no payment terms. */
export class FakeInvoiceFirmSettings implements InvoiceFirmSettings {
  reportingCurrency = "INR";
  fiscalYearStartMonth: number | null = null;
  dueInDays: number | null = null;

  invoiceSettingsFor(): Promise<{
    readonly reportingCurrency: string;
    readonly fiscalYearStartMonth: number | null;
    readonly dueInDays: number | null;
  }> {
    return Promise.resolve({
      reportingCurrency: this.reportingCurrency,
      fiscalYearStartMonth: this.fiscalYearStartMonth,
      dueInDays: this.dueInDays,
    });
  }
}

/** Records every invoice whose issued copy was asked for, in order. */
export class FakeIssuedCopies implements IssuedCopies {
  readonly filed: { tenantId: string; invoiceId: string }[] = [];
  file(tenantId: string, invoiceId: string): Promise<void> {
    this.filed.push({ tenantId, invoiceId });
    return Promise.resolve();
  }
}

export function makeInvoiceFakes(): Deps & {
  invoices: FakeInvoiceRepo;
  /** UTC unless a test sets the firm's zone. */
  timeZones: FakeFirmTimeZone;
  firmEntities: FakeFirmEntities;
  parties: FakePartyStanding;
  clock: FakeClock;
  events: RecordingEventSink;
  issuedCopies: FakeIssuedCopies;
  staff: FakeStaffDirectory;
  settings: FakeInvoiceFirmSettings;
} {
  return {
    invoices: new FakeInvoiceRepo(),
    timeZones: new FakeFirmTimeZone(),
    firmEntities: new FakeFirmEntities(),
    parties: new FakePartyStanding(),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
    events: new RecordingEventSink(),
    issuedCopies: new FakeIssuedCopies(),
    staff: new FakeStaffDirectory(),
    settings: new FakeInvoiceFirmSettings(),
  };
}

/** A company's bank accounts and LUTs in memory (Q056, 0369). */
export class FakeCompanyInvoicingRepo implements CompanyInvoicingRepository {
  readonly accounts: (BankAccountView & { entityPartyId: string; retired: boolean })[] = [];
  readonly luts: { id: string; entityPartyId: string; financialYear: number; reference: string; filedOn: string | null; retired: boolean }[] = [];

  list(): Promise<readonly CompanyInvoicing[]> {
    return Promise.resolve([]);
  }

  addBankAccount(_t: string, entityPartyId: string, id: string, a: NewBankAccount): Promise<{ readonly replaced: string | null }> {
    const old = this.accounts.find((x) => x.entityPartyId === entityPartyId && !x.retired && x.currency === a.currency);
    if (old !== undefined) old.retired = true;
    this.accounts.push({ ...a, id, entityPartyId, retired: false });
    return Promise.resolve({ replaced: old?.id ?? null });
  }

  retireBankAccount(_t: string, entityPartyId: string, accountId: string): Promise<boolean> {
    const a = this.accounts.find((x) => x.id === accountId && x.entityPartyId === entityPartyId && !x.retired);
    if (a === undefined) return Promise.resolve(false);
    a.retired = true;
    return Promise.resolve(true);
  }

  addLut(
    _t: string,
    entityPartyId: string,
    lut: { readonly id: string; readonly financialYear: number; readonly reference: string; readonly filedOn: string | null },
  ): Promise<{ readonly replaced: string | null }> {
    const old = this.luts.find((x) => x.entityPartyId === entityPartyId && !x.retired && x.financialYear === lut.financialYear);
    if (old !== undefined) old.retired = true;
    this.luts.push({ ...lut, entityPartyId, retired: false });
    return Promise.resolve({ replaced: old?.id ?? null });
  }

  retireLut(_t: string, entityPartyId: string, lutId: string): Promise<number | null> {
    const l = this.luts.find((x) => x.id === lutId && x.entityPartyId === entityPartyId && !x.retired);
    if (l === undefined) return Promise.resolve(null);
    l.retired = true;
    return Promise.resolve(l.financialYear);
  }

  /** Q087: each company's setting; a company not in the map is not listed. */
  readonly roundOff = new Map<string, boolean>();

  setRoundOff(_t: string, entityPartyId: string, on: boolean): Promise<boolean | null> {
    const before = this.roundOff.get(entityPartyId);
    if (before === undefined) return Promise.resolve(null);
    this.roundOff.set(entityPartyId, on);
    return Promise.resolve(before);
  }
}

/** The company-invoicing use case over fakes, for route tests. */
export function makeCompanyInvoicing(): CompanyInvoicingService {
  return new CompanyInvoicingService({
    companies: new FakeCompanyInvoicingRepo(),
    firmEntities: new FakeFirmEntities(),
    parties: new FakePartyStanding(),
    ids: new FakeIds(),
    events: new RecordingEventSink(),
  });
}
