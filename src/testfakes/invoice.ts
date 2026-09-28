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
  Payment,
} from "../domain/invoice/model";
import {
  DEFAULT_CREDIT_NOTE_PREFIX,
  DEFAULT_SERIES_PREFIX,
  financialYearOf,
  formatInvoiceNumber,
} from "../domain/invoice/model";
import type {
  EngagementBilling,
  InvoiceFilters,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
  NewCreditNote,
  NewInvoice,
  NewInvoiceLine,
  NewPayment,
  ReceivableRecord,
} from "../usecase/invoice/ports";
import type { Deps } from "../usecase/invoice/service";
import { FakeIds } from "./ids";
import { FakeFirmTimeZone } from "./tenancy";
import { FakePartyStanding } from "./party";
import { FakeClock } from "./clock";
import { RecordingEventSink } from "./ledger";

interface SeriesKey {
  readonly tenantId: string;
  readonly entityPartyId: string;
  readonly financialYear: number;
}

function keyOf(k: SeriesKey): string {
  return `${k.tenantId}|${k.entityPartyId}|${String(k.financialYear)}`;
}

export class FakeInvoiceRepo implements InvoiceRepository {
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
  private readonly series = new Map<string, { last: number; prefix: string }>();

  create(i: NewInvoice): Promise<Invoice> {
    const financialYear = financialYearOf(i.seriesDate);
    const k = keyOf({ tenantId: i.tenantId, entityPartyId: i.entityPartyId, financialYear });
    const existing = this.series.get(k) ?? { last: 0, prefix: DEFAULT_SERIES_PREFIX };
    const sequence = existing.last + 1;
    this.series.set(k, { ...existing, last: sequence });

    const invoice: Invoice = {
      id: i.id,
      tenantId: i.tenantId,
      partyId: i.partyId,
      entityPartyId: i.entityPartyId,
      number: formatInvoiceNumber({ prefix: existing.prefix, financialYear, sequence }),
      financialYear,
      sequenceNumber: sequence,
      status: "draft",
      currency: i.currency,
      fxRate: i.fxRate,
      fxRateDate: i.fxRateDate,
      issuedOn: null,
      dueOn: i.dueOn,
      irn: null,
      irnRegisteredAt: null,
      notes: i.notes,
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
      lines: lines.map((line) => ({ line, net: net(line), tax: tax(line) })),
      totals: this.totalsOf(invoice),
    };
  }

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
                ? { paid: b.paid, credited: b.credited, outstanding: b.outstanding }
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

  issue(tenantId: string, invoiceId: string, issuedOn: string): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { status: "issued", issuedOn });
  }

  cancel(tenantId: string, invoiceId: string): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { status: "cancelled" });
  }

  registerIrn(tenantId: string, invoiceId: string, irn: string, at: string): Promise<Invoice> {
    return this.patch(tenantId, invoiceId, { irn, irnRegisteredAt: at });
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

  recordPayment(p: NewPayment): Promise<Payment> {
    this.payments.push(p);
    return Promise.resolve(p);
  }

  listPayments(_tenantId: string, invoiceId: string): Promise<readonly Payment[]> {
    return Promise.resolve(this.payments.filter((p) => p.invoiceId === invoiceId));
  }

  issueCreditNote(c: NewCreditNote): Promise<CreditNote> {
    const financialYear = financialYearOf(c.seriesDate);
    // A SEPARATE key from the invoice series — the correction 0028 made after
    // 0027 shipped without a document type. A fake that shared the counter
    // would let a test pass on interleaved numbering the database refuses.
    const k = `${keyOf({ tenantId: c.tenantId, entityPartyId: c.entityPartyId, financialYear })}|credit_note`;
    const existing = this.creditSeries.get(k) ?? { last: 0, prefix: DEFAULT_CREDIT_NOTE_PREFIX };
    const sequence = existing.last + 1;
    this.creditSeries.set(k, { ...existing, last: sequence });

    const note: CreditNote = {
      id: c.id,
      tenantId: c.tenantId,
      invoiceId: c.invoiceId,
      entityPartyId: c.entityPartyId,
      number: formatInvoiceNumber({ prefix: existing.prefix, financialYear, sequence }),
      financialYear,
      sequenceNumber: sequence,
      amount: c.amount,
      currency: c.currency,
      issuedOn: c.issuedOn,
      reason: c.reason,
      note: c.note,
    };
    this.creditNotes.push(note);
    return Promise.resolve(note);
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
        number: r.invoice.number,
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
    return {
      invoiceId: invoice.id,
      partyId: invoice.partyId,
      status: invoice.status,
      currency: invoice.currency,
      dueOn: invoice.dueOn,
      invoiced: totals.total,
      paid: unscaled(paid),
      credited: unscaled(credited),
      outstanding: unscaled(scaled(totals.total) - paid - credited),
    };
  }

  private readonly creditSeries = new Map<string, { last: number; prefix: string }>();

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

  private totalsOf(invoice: Invoice): InvoiceRecord["totals"] {
    const lines = this.liveLines(invoice.id);
    const sum = (f: (l: InvoiceLine) => bigint): bigint =>
      lines.reduce((acc, l) => acc + f(l), 0n);
    const gross = sum((l) => scaled(l.quantity) * scaled(l.unitAmount) / UNIT);
    const netTotal = sum((l) => scaledNet(l));
    const taxTotal = sum((l) => scaledTax(l));
    return {
      lineCount: lines.length,
      gross: unscaled(gross),
      discount: unscaled(gross - netTotal),
      net: unscaled(netTotal),
      tax: unscaled(taxTotal),
      total: unscaled(netTotal + taxTotal),
      currency: invoice.currency,
    };
  }
}

// ── Exact decimal arithmetic, for the fake only ────────────────────────────
// Same reasoning as the proposal and engagement fakes: a float would make this
// disagree with Postgres on precisely the numbers worth testing, and the
// migration is the authority either way.

const UNIT = 10000n;

function scaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  return BigInt(whole) * UNIT + BigInt((fraction + "0000").slice(0, 4));
}

function unscaled(v: bigint): string {
  return `${(v / UNIT).toString()}.${(v % UNIT).toString().padStart(4, "0")}`;
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

export function makeInvoiceFakes(): Deps & {
  invoices: FakeInvoiceRepo;
  /** UTC unless a test sets the firm's zone. */
  timeZones: FakeFirmTimeZone;
  firmEntities: FakeFirmEntities;
  parties: FakePartyStanding;
  clock: FakeClock;
  events: RecordingEventSink;
} {
  return {
    invoices: new FakeInvoiceRepo(),
    timeZones: new FakeFirmTimeZone(),
    firmEntities: new FakeFirmEntities(),
    parties: new FakePartyStanding(),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
    events: new RecordingEventSink(),
  };
}
