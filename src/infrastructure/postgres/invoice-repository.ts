// Invoicing, in Postgres (T3.4).
//
// ## The whole point of this file: `issue` is ONE transaction
//
// (Until 0322 it was `create`: a draft drew its number when it was made, and a
// cancelled draft left a cancelled number in the series. Since 0322 the draft
// has no number and ISSUING draws it, so an automatic draft a firm withdraws
// spends nothing. What follows is the same argument, about the issue.)
//
// A gapless series cannot be allocated by a method that hands a number back to
// a caller. Between `nextNumber()` returning 41 and `issue()` writing it, the
// caller may throw, the process may die, or a validation may fail — and 41 is
// gone. Under Indian GST a missing invoice number is something an auditor is
// entitled to read as a suppressed sale, and "our software burnt it" is not a
// defence.
//
// So the allocation and the insert are one transaction, and the mechanism is a
// COUNTER ROW TAKEN UNDER `SELECT … FOR UPDATE`:
//
//   1. `INSERT … ON CONFLICT DO NOTHING` creates the series row if this is the
//      entity's first invoice of the year. Idempotent, so two concurrent first
//      invoices do not race to create it.
//   2. `SELECT last_number … FOR UPDATE` takes a row lock. A second writer
//      BLOCKS here until the first COMMITS OR ROLLS BACK — and then reads what
//      is actually stored, not a snapshot from its own BEGIN.
//   3. `UPDATE … last_number + 1` and the invoice INSERT follow, inside the
//      same transaction. A failure anywhere rolls the counter back with the
//      row, because the counter never independently moved.
//
// WHY NOT A SEQUENCE: `nextval` deliberately survives rollback — that is what
// makes sequences fast and lock-free — so an aborted transaction burns its
// number permanently. This is the single most common way gapless numbering is
// got wrong and it cannot be repaired afterwards.
//
// WHY NOT `max(number) + 1`: it reads a snapshot. Two concurrent invoices both
// see 40 and both write 41; the UNIQUE constraint turns a numbering bug into a
// failed insert. Better than a duplicate, still wrong.
//
// The lock is per (tenant, entity, financial year), so two firms and two of one
// firm's entities never wait on each other. WITHIN one series the writes are
// serialised, and that is not a cost to engineer away: a consecutive series is
// by definition a total order.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { toDayOrNull } from "./day";
import type {
  CreditNote,
  Invoice,
  InvoiceBalance,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTaxSnapshot,
  Payment,
} from "../../domain/invoice/model";
import { isTaxTreatment } from "../../domain/invoice/gst";
import {
  DEFAULT_CREDIT_NOTE_PREFIX,
  DEFAULT_SERIES_PREFIX,
  formatInvoiceNumber,
  INDIAN_FY_START_MONTH,
  isCreditReason,
  isInvoiceStatus,
  isPaymentMethod,
  preDrawnNumberOrder,
} from "../../domain/invoice/model";
import type {
  EngagementBilling,
  InvoiceFilters,
  InvoiceLineRecord,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
  CancelOutcome,
  CreditNoteOutcome,
  PaymentOutcome,
  IssueOn,
  IssueOutcome,
  NewCreditNote,
  ReceivableRecord,
  NewInvoice,
  NewInvoiceLine,
  NewPayment,
  BankAccountView,
  ClientTds,
  InvoiceTaxFacts,
} from "../../usecase/invoice/ports";
import { MAX_LIST_ROWS } from "../../db/limits";

interface InvoiceRow {
  id: string;
  tenant_id: string;
  party_id: string;
  entity_party_id: string;
  number: string | null;
  financial_year: number;
  sequence_number: number | null;
  status: string;
  currency: string;
  fx_rate: string;
  fx_rate_date: Date;
  issued_on: Date | null;
  due_on: Date | null;
  irn: string | null;
  irn_registered_at: Date | null;
  notes: string | null;
  manager_user_id: string | null;
  tax_treatment: string | null;
  supplier_gstin: string | null;
  supplier_state_code: string | null;
  recipient_gstin: string | null;
  place_of_supply_state_code: string | null;
  place_of_supply_country: string | null;
  chosen_place_of_supply: string | null;
  lut_id: string | null;
  bank_account_id: string | null;
  tds_section: string | null;
  tds_percent: string | null;
}

function toTaxSnapshot(r: InvoiceRow): InvoiceTaxSnapshot {
  const treatment = r.tax_treatment;
  if (treatment !== null && !isTaxTreatment(treatment)) {
    throw new Error(
      `crm.invoice holds tax_treatment ${JSON.stringify(treatment)}, which is not a TaxTreatment. The ` +
        `CHECK constraint and domain/invoice/gst.ts have drifted apart.`,
    );
  }
  return {
    treatment,
    supplierGstin: r.supplier_gstin,
    supplierStateCode: r.supplier_state_code,
    recipientGstin: r.recipient_gstin,
    placeOfSupplyStateCode: r.place_of_supply_state_code,
    placeOfSupplyCountry: r.place_of_supply_country,
    chosenPlaceOfSupply: r.chosen_place_of_supply,
    lutId: r.lut_id,
    bankAccountId: r.bank_account_id,
    tdsSection: r.tds_section,
    tdsPercent: r.tds_percent,
  };
}

/**
 * A date column as this product speaks about dates: an ISO DAY, never an
 * instant. An invoice date is a calendar fact in a jurisdiction.
 *
 * Was `toISOString().slice(0, 10)` inline, which was correct — postgres.js
 * hands back a `date` at UTC midnight. It is the shared helper now so that
 * "which fields do I read" has one answer with the measurement behind it;
 * `engagement` and `proposal` reached the opposite conclusion in their own
 * private copies and were wrong. See `day.ts`.
 */
const day = toDayOrNull;

function toStatus(raw: string): InvoiceStatus {
  if (!isInvoiceStatus(raw)) {
    throw new Error(
      `crm.invoice holds status ${JSON.stringify(raw)}, which is not an InvoiceStatus. The ` +
        `CHECK constraint and domain/invoice/model.ts have drifted apart.`,
    );
  }
  return raw;
}

function toInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    partyId: r.party_id,
    entityPartyId: r.entity_party_id,
    number: r.number,
    financialYear: r.financial_year,
    sequenceNumber: r.sequence_number,
    status: toStatus(r.status),
    currency: r.currency,
    fxRate: r.fx_rate,
    fxRateDate: day(r.fx_rate_date) ?? "",
    issuedOn: day(r.issued_on),
    dueOn: day(r.due_on),
    irn: r.irn,
    irnRegisteredAt: r.irn_registered_at === null ? null : r.irn_registered_at.toISOString(),
    notes: r.notes,
    managerUserId: r.manager_user_id,
    tax: toTaxSnapshot(r),
  };
}

interface InvoiceLineRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  engagement_id: string | null;
  description: string;
  position: number;
  quantity: string;
  unit_amount: string;
  currency: string;
  discount_percent: string;
  tax_percent: string;
  sac: string | null;
}

function toLine(r: InvoiceLineRow): InvoiceLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    engagementId: r.engagement_id,
    description: r.description,
    position: r.position,
    quantity: r.quantity,
    unitAmount: r.unit_amount,
    currency: r.currency,
    discountPercent: r.discount_percent,
    taxPercent: r.tax_percent,
    sac: r.sac,
  };
}

/** The tax snapshot (0370), as `crm.invoice` columns. */
const TAX_COLUMNS =
  "tax_treatment, supplier_gstin, supplier_state_code, recipient_gstin, place_of_supply_state_code, " +
  "place_of_supply_country, chosen_place_of_supply, lut_id, bank_account_id, tds_section, tds_percent";

/** The same, read through the alias `i`, the rate as text. */
const I_TAX_COLUMNS = TAX_COLUMNS.split(", ")
  .map((c) => (c === "tds_percent" ? "i.tds_percent::text AS tds_percent" : `i.${c}`))
  .join(", ");

const INVOICE_COLUMNS =
  "id, tenant_id, party_id, entity_party_id, number, financial_year, sequence_number, " +
  "status, currency, fx_rate, fx_rate_date, issued_on, due_on, irn, irn_registered_at, notes, " +
  "manager_user_id, " +
  TAX_COLUMNS.replace("tds_percent", "tds_percent::text AS tds_percent");

const LINE_COLUMNS =
  "id, tenant_id, invoice_id, engagement_id, description, position, quantity, unit_amount, " +
  "currency, discount_percent, tax_percent, sac";

/**
 * The company's invoice series for the year exists. ON CONFLICT DO NOTHING so
 * two concurrent first invoices do not race to create it; the `FOR UPDATE`
 * read in `issue` is what actually orders them.
 *
 * A NEW YEAR'S ROW (0337) is fixed to the month the company's year starts in,
 * so its label never moves when the setting changes mid-series, and takes the
 * prefix of the company's latest series of the kind: a custom prefix used to
 * fall back to `INV` every 1 April. A row that exists is left exactly as it is.
 */
async function ensureSeries(
  db: Db,
  tenantId: string,
  entityPartyId: string,
  financialYear: number,
  documentType: "invoice" | "credit_note",
  startMonth: number,
): Promise<void> {
  const defaultPrefix = documentType === "invoice" ? DEFAULT_SERIES_PREFIX : DEFAULT_CREDIT_NOTE_PREFIX;
  await db`
    INSERT INTO crm.invoice_series
      (tenant_id, entity_party_id, financial_year, document_type, prefix, start_month)
    VALUES (${tenantId}, ${entityPartyId}, ${financialYear}, ${documentType},
            coalesce((SELECT s.prefix FROM crm.invoice_series s
                       WHERE s.tenant_id = ${tenantId} AND s.entity_party_id = ${entityPartyId}
                         AND s.document_type = ${documentType}
                       ORDER BY s.financial_year DESC LIMIT 1), ${defaultPrefix}),
            ${startMonth})
    ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
  `;
}

async function ensureInvoiceSeries(
  db: Db,
  tenantId: string,
  entityPartyId: string,
  financialYear: number,
  startMonth: number,
): Promise<void> {
  await ensureSeries(db, tenantId, entityPartyId, financialYear, "invoice", startMonth);
}

/**
 * The highest-numbered invoice of one series that carries an issue date (B51):
 * issued, or issued and cancelled since (it went out with that number). A draft
 * cancelled before issue never went out and is not counted. The series is the
 * company and the year; `sequence_number` orders it whatever the prefix was.
 */
async function latestIssued(
  db: Db,
  tenantId: string,
  entityPartyId: string,
  financialYear: number,
  exceptInvoiceId: string,
): Promise<{ readonly number: string; readonly sequenceNumber: number } | null> {
  const [row] = await db<{ number: string; sequence_number: number }[]>`
    SELECT number, sequence_number FROM crm.invoice
     WHERE tenant_id = ${tenantId}
       AND entity_party_id = ${entityPartyId}
       AND financial_year = ${financialYear}
       AND issued_on IS NOT NULL
       AND number IS NOT NULL
       AND id <> ${exceptInvoiceId}
     ORDER BY sequence_number DESC
     LIMIT 1
  `;
  return row === undefined ? null : { number: row.number, sequenceNumber: row.sequence_number };
}

/**
 * A draft invoice row, unnumbered (0322), in a transaction the caller holds:
 * `create`'s, or the billing desk's, which writes the draft, its lines and the
 * bills they settle as one (B34).
 */
export async function insertDraftInvoice(db: Db, i: NewInvoice): Promise<Invoice> {
  await ensureInvoiceSeries(
    db,
    i.tenantId,
    i.entityPartyId,
    i.financialYear,
    i.fiscalYearStartMonth ?? INDIAN_FY_START_MONTH,
  );
  const [row] = await db<InvoiceRow[]>`
    INSERT INTO crm.invoice
      (id, tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       currency, fx_rate, fx_rate_date, due_on, notes, manager_user_id)
    VALUES (${i.id}, ${i.tenantId}, ${i.partyId}, ${i.entityPartyId}, NULL,
            ${i.financialYear}, NULL, ${i.currency}, ${i.fxRate}, ${i.fxRateDate},
            ${i.dueOn}, ${i.notes}, ${i.managerUserId ?? null})
    RETURNING ${db.unsafe(INVOICE_COLUMNS)}
  `;
  if (!row) throw new Error("invoice insert returned no row");
  return toInvoice(row);
}

/** A line on an invoice, in a transaction the caller holds (B34, B36). */
export async function insertInvoiceLine(db: Db, l: NewInvoiceLine): Promise<InvoiceLine> {
  // THE INVOICE ROW IS THE LOCK (B36). `MAX(position) + 1` inside the INSERT
  // still reads a snapshot under READ COMMITTED, so two lines added at once
  // both took the same position and one failed on the unique index as a
  // 500. Holding the invoice row first makes the second add wait for the
  // first to commit and then read its line.
  await db`SELECT 1 FROM crm.invoice WHERE id = ${l.invoiceId} FOR UPDATE`;
  const [row] = await db<InvoiceLineRow[]>`
    INSERT INTO crm.invoice_line
      (id, tenant_id, invoice_id, engagement_id, description, position, quantity,
       unit_amount, currency, discount_percent, tax_percent, sac)
    SELECT ${l.id}, ${l.tenantId}, ${l.invoiceId}, ${l.engagementId}, ${l.description},
           -- The next position among LIVE lines: a struck-off line frees
           -- its position (0326).
           COALESCE(MAX(position), 0) + 1,
           ${l.quantity}, ${l.unitAmount}, ${l.currency}, ${l.discountPercent},
           ${l.taxPercent}, ${l.sac}
    FROM crm.invoice_line
    WHERE invoice_id = ${l.invoiceId} AND removed_at IS NULL
    RETURNING ${db.unsafe(LINE_COLUMNS)}
  `;
  if (!row) throw new Error("invoice line insert returned no row");
  return toLine(row);
}

export class PostgresInvoiceRepository implements InvoiceRepository {
  constructor(private readonly app: Db) {}

  /**
   * The DRAFT, with no number (0322). Its series row exists from here, because
   * the draft names the series (and the year) its number will come from, and
   * the foreign key wants the row. Nothing is counted.
   */
  async create(i: NewInvoice): Promise<Invoice> {
    return withTenant(this.app, i.tenantId, (db) => insertDraftInvoice(db, i));
  }

  async find(tenantId: string, invoiceId: string): Promise<Invoice | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<InvoiceRow[]>`
        SELECT ${db.unsafe(INVOICE_COLUMNS)} FROM crm.invoice WHERE id = ${invoiceId}
      `;
      return row ? toInvoice(row) : null;
    });
  }

  async describe(tenantId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        (InvoiceRow & {
          party_name: string;
          entity_name: string;
          manager_name: string | null;
          manager_email: string | null;
        })[]
      >`
        SELECT i.id, i.tenant_id, i.party_id, i.entity_party_id, i.number, i.financial_year,
               i.sequence_number, i.status, i.currency, i.fx_rate, i.fx_rate_date, i.issued_on,
               i.due_on, i.irn, i.irn_registered_at, i.notes, i.manager_user_id,
               ${db.unsafe(I_TAX_COLUMNS)},
               -- Both by NAME, in the query. An invoice prints an address block
               -- and a letterhead, and a uuid prints as nothing.
               p.display_name AS party_name,
               e.display_name AS entity_name,
               mu.display_name AS manager_name,
               mu.email::text  AS manager_email
        FROM crm.invoice i
        JOIN core.party p ON p.id = i.party_id
        JOIN core.party e ON e.id = i.entity_party_id
        LEFT JOIN tenancy.user_account mu ON mu.id = i.manager_user_id
        WHERE i.id = ${invoiceId}
      `;
      if (!head) return null;

      // The letters the lines bill (0318), so the invoice traces to what the
      // client signed. Ordered by reference for a stable read.
      const letters = await db<{ id: string; ref: string }[]>`
        SELECT DISTINCT l.id, l.ref
          FROM crm.invoice_line il
          JOIN crm.engagement eg ON eg.id = il.engagement_id AND eg.tenant_id = il.tenant_id
          JOIN crm.engagement_letter l ON l.id = eg.engagement_letter_id AND l.tenant_id = eg.tenant_id
         WHERE il.invoice_id = ${invoiceId} AND il.removed_at IS NULL
         ORDER BY l.ref
      `;

      const lines = await db<
        (InvoiceLineRow & { net: string; tax: string; cgst: string; sgst: string; utgst: string; igst: string })[]
      >`
        SELECT ${db.unsafe(LINE_COLUMNS.split(", ").map((c) => `l.${c}`).join(", "))},
               a.net, a.tax, a.cgst::text, a.sgst::text, a.utgst::text, a.igst::text
        FROM crm.invoice_line l
        JOIN crm.invoice_line_amount a ON a.invoice_line_id = l.id
        WHERE l.invoice_id = ${invoiceId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      const [totals] = await db<TotalsRow[]>`
        SELECT ${db.unsafe(TOTALS_COLUMNS)}
        FROM crm.invoice_totals WHERE invoice_id = ${invoiceId}
      `;

      // What it prints for the LUT and the bank (0369), by the ids frozen on it.
      const [lut] =
        head.lut_id === null
          ? []
          : await db<{ id: string; reference: string; financial_year: number }[]>`
              SELECT id, reference, financial_year FROM crm.firm_entity_lut WHERE id = ${head.lut_id}
            `;
      const [bank] =
        head.bank_account_id === null
          ? []
          : await db<BankAccountRow[]>`
              SELECT ${db.unsafe(BANK_COLUMNS)} FROM crm.firm_entity_bank_account
               WHERE id = ${head.bank_account_id}
            `;

      // THE RATE A LINE TYPED BY HAND STARTS AT (CA#5): 0322's rule for the
      // automatic advance, offered to a person. The last rate on each of this
      // client's engagements billed before, and the issuing company's default.
      const lastRates = await db<{ engagement_id: string; tax_percent: string }[]>`
        SELECT DISTINCT ON (il.engagement_id) il.engagement_id, il.tax_percent::text
          FROM crm.invoice_line il
          JOIN crm.invoice ii ON ii.id = il.invoice_id AND ii.tenant_id = il.tenant_id
         WHERE ii.party_id = ${head.party_id}
           AND il.engagement_id IS NOT NULL
           AND il.removed_at IS NULL
           AND ii.status <> 'cancelled'
         ORDER BY il.engagement_id, ii.created_at DESC, il.position DESC
      `;
      const [companyRate] = await db<{ tax_percent: string }[]>`
        SELECT tax_percent::text FROM crm.issuer_tax_default WHERE entity_party_id = ${head.entity_party_id}
      `;

      return {
        invoice: toInvoice(head),
        party: { id: head.party_id, displayName: head.party_name },
        entity: { id: head.entity_party_id, displayName: head.entity_name },
        taxSuggestions: {
          companyDefault: companyRate?.tax_percent ?? null,
          byEngagement: lastRates.map((r) => ({ engagementId: r.engagement_id, taxPercent: r.tax_percent })),
        },
        lines: lines.map(
          (r): InvoiceLineRecord => ({
            line: toLine(r),
            net: r.net,
            tax: r.tax,
            cgst: r.cgst,
            sgst: r.sgst,
            utgst: r.utgst,
            igst: r.igst,
          }),
        ),
        // An invoice with no live lines has no row in the totals view at all —
        // `sum()` over nothing is NULL and `GROUP BY` emits no group. Zeroes are
        // the honest reading of "nothing on it yet", and the alternative is a
        // screen that renders "null" where a figure belongs.
        totals: toTotals(totals, head.currency),
        lut: lut === undefined ? null : { id: lut.id, reference: lut.reference, financialYear: lut.financial_year },
        bankAccount: bank === undefined ? null : toBankAccount(bank),
        manager:
          head.manager_user_id === null || head.manager_email === null
            ? null
            : { userId: head.manager_user_id, displayName: head.manager_name, email: head.manager_email },
        letters: letters.map((l) => ({ id: l.id, ref: l.ref })),
      };
    });
  }

  async list(tenantId: string, filters: InvoiceFilters): Promise<readonly InvoiceSummary[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        (InvoiceRow & {
          party_name: string;
          line_count: string | null;
          gross: string | null;
          discount: string | null;
          net: string | null;
          tax: string | null;
          total: string | null;
          cgst: string | null;
          sgst: string | null;
          utgst: string | null;
          igst: string | null;
          tds: string | null;
          net_payable: string | null;
          paid: string | null;
          credited: string | null;
          outstanding: string | null;
          tds_paid: string | null;
        })[]
      >`
        SELECT i.id, i.tenant_id, i.party_id, i.entity_party_id, i.number, i.financial_year,
               i.sequence_number, i.status, i.currency, i.fx_rate, i.fx_rate_date, i.issued_on,
               i.due_on, i.irn, i.irn_registered_at, i.notes, i.manager_user_id,
               ${db.unsafe(I_TAX_COLUMNS)},
               p.display_name AS party_name,
               t.line_count::text, t.gross::text, t.discount::text, t.net::text,
               t.tax::text, t.total::text, t.cgst::text, t.sgst::text, t.utgst::text, t.igst::text,
               t.tds::text, t.net_payable::text,
               b.paid::text, b.credited::text, b.outstanding::text, b.tds::text AS tds_paid
        FROM crm.invoice i
        JOIN core.party p ON p.id = i.party_id
        -- LEFT, because a draft with no lines yet has no totals row and must
        -- still appear in the list — that is precisely the invoice somebody is
        -- looking for when they open this screen.
        LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
        -- WHAT IS STILL OWED, from the SAME view /receivables reads, so the
        -- list and the collections screen cannot disagree about a settled
        -- invoice. The view holds a row for EVERY invoice, drafts included, so
        -- this join never misses — which is why the draft rule lives in the
        -- mapping below rather than here, where a LEFT JOIN would look like it
        -- was doing something it is not.
        JOIN crm.invoice_balance b ON b.invoice_id = i.id
        WHERE (${filters.status ?? null}::text IS NULL OR i.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR i.party_id = ${filters.partyId ?? null})
        ORDER BY i.created_at DESC
        -- A CEILING, not pagination — see MAX_LIST_ROWS. A firm invoices every
        -- month forever, so this list is one of the few that genuinely has no
        -- upper bound of its own.
        LIMIT ${MAX_LIST_ROWS}
      `;
      return rows.map((r) => ({
        invoice: toInvoice(r),
        party: { id: r.party_id, displayName: r.party_name },
        totals: toTotals(
          r.line_count === null
            ? undefined
            : {
                line_count: r.line_count,
                gross: r.gross ?? "0",
                discount: r.discount ?? "0",
                net: r.net ?? "0",
                tax: r.tax ?? "0",
                total: r.total ?? "0",
                cgst: r.cgst ?? "0",
                sgst: r.sgst ?? "0",
                utgst: r.utgst ?? "0",
                igst: r.igst ?? "0",
                tds: r.tds ?? "0",
                net_payable: r.net_payable ?? "0",
              },
          r.currency,
        ),
        // ONLY AN ISSUED INVOICE OWES ANYTHING, and the rule is here rather
        // than in the query because `crm.invoice_balance` holds a row for every
        // invoice whatever its status.
        //
        // A DRAFT's "outstanding" is its own total and nobody has been asked
        // for it. A CANCELLED one's is the total of a document that was
        // WITHDRAWN — walked, and it read as ₹7,080 owed on an invoice the firm
        // had already pulled. `/receivables` has always filtered
        // `status = 'issued'`; this is the same rule, so the list and the
        // collections screen cannot disagree about who owes what. The fake
        // mirrors it exactly.
        balance:
          r.status === "issued"
            ? {
                paid: r.paid ?? "0",
                credited: r.credited ?? "0",
                outstanding: r.outstanding ?? "0",
                tds: r.tds_paid ?? "0",
              }
            : null,
      }));
    });
  }

  async addLine(l: NewInvoiceLine): Promise<InvoiceLine> {
    return withTenant(this.app, l.tenantId, (db) => insertInvoiceLine(db, l));
  }

  async removeLine(tenantId: string, invoiceId: string, lineId: string): Promise<void> {
    await withTenant(
      this.app,
      tenantId,
      (db) => db`
        UPDATE crm.invoice_line SET removed_at = now()
        WHERE id = ${lineId} AND invoice_id = ${invoiceId} AND removed_at IS NULL
      `,
    );
  }

  async engagementOf(
    tenantId: string,
    engagementId: string,
  ): Promise<EngagementBilling | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        {
          party_id: string;
          issuing_entity_party_id: string;
          letter_ref: string;
          currency: string;
        }[]
      >`
        -- The LINE's currency (0344): what this engagement was priced in, which
        -- on a letter in several currencies need not be the letter's main one.
        SELECT e.party_id, l.issuing_entity_party_id, l.ref AS letter_ref, ll.currency
          FROM crm.engagement e
          JOIN crm.engagement_letter l
            ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
         WHERE e.id = ${engagementId}
      `;
      return row
        ? {
            partyId: row.party_id,
            issuingEntityPartyId: row.issuing_entity_party_id,
            letterRef: row.letter_ref,
            currency: row.currency,
          }
        : null;
    });
  }

  async listLines(tenantId: string, invoiceId: string): Promise<readonly InvoiceLine[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<InvoiceLineRow[]>`
        SELECT ${db.unsafe(LINE_COLUMNS)} FROM crm.invoice_line
        WHERE invoice_id = ${invoiceId} AND removed_at IS NULL
        ORDER BY position
      `;
      return rows.map(toLine);
    });
  }

  /**
   * Issue AND number, in one transaction (0322). The draft is locked first, so
   * two issues of it serialise and the second finds it issued; then the
   * series' counter row under `FOR UPDATE`, then the counter moves and the
   * draft takes the number, the status and the date in one UPDATE. A draft
   * made before 0322 already holds a number: it keeps it (and its year) and
   * counts nothing, unless that number is now OUT OF ORDER (B51): then nothing
   * is written and the outcome says why. That is decided under the series'
   * row lock, the one an unnumbered issue takes to draw the next number, so a
   * later number cannot be issued between the check and the write.
   *
   * THE YEAR IS THE ISSUE DATE'S (B03, 0326): an unnumbered draft moves to the
   * series of `on.financialYear` in the same write that numbers it. It was the
   * draft's year, so a March draft issued in April took last year's series.
   */
  async issue(tenantId: string, invoiceId: string, on: IssueOn): Promise<IssueOutcome> {
    const issuedOn = on.issuedOn;
    return withTenant(this.app, tenantId, async (db): Promise<IssueOutcome> => {
      const [draft] = await db<
        { entity_party_id: string; financial_year: number; number: string | null; sequence_number: number | null }[]
      >`
        SELECT entity_party_id, financial_year, number, sequence_number FROM crm.invoice
        WHERE id = ${invoiceId} AND status = 'draft'
        FOR UPDATE
      `;
      if (!draft) {
        throw new Error(
          `could not issue invoice ${invoiceId}: no draft matched. It has moved on since it was ` +
            `read — another request got there first.`,
        );
      }

      let number = draft.number;
      let sequence: number | null = null;
      let financialYear = draft.financial_year;
      if (number !== null && draft.sequence_number !== null) {
        // NUMBERED BEFORE 0322 (B51). Its series' counter row, under the same
        // lock an unnumbered issue takes, so nothing in this series is issued
        // between the question and the answer.
        await ensureInvoiceSeries(db, tenantId, draft.entity_party_id, draft.financial_year, on.fiscalYearStartMonth);
        await db`
          SELECT 1 FROM crm.invoice_series
          WHERE tenant_id = ${tenantId}
            AND entity_party_id = ${draft.entity_party_id}
            AND financial_year = ${draft.financial_year}
            AND document_type = 'invoice'
          FOR UPDATE
        `;
        const order = preDrawnNumberOrder({
          draft: { financialYear: draft.financial_year, sequenceNumber: draft.sequence_number },
          issueFinancialYear: on.financialYear,
          latestIssued: await latestIssued(db, tenantId, draft.entity_party_id, draft.financial_year, invoiceId),
        });
        if (!order.inOrder) return { outOfOrder: { number, order } };
      }
      if (number === null) {
        financialYear = on.financialYear;
        await ensureInvoiceSeries(db, tenantId, draft.entity_party_id, financialYear, on.fiscalYearStartMonth);
        // THE LOCK. Everything this file exists for is this line. A second
        // writer waits here until the first transaction ends, and then reads
        // what is stored rather than a snapshot taken at its own BEGIN.
        const [series] = await db<{ last_number: number; prefix: string; start_month: number }[]>`
          SELECT last_number, prefix, start_month FROM crm.invoice_series
          WHERE tenant_id = ${tenantId}
            AND entity_party_id = ${draft.entity_party_id}
            AND financial_year = ${financialYear}
            AND document_type = 'invoice'
          FOR UPDATE
        `;
        if (!series) {
          // Unreachable through the insert above unless RLS hid the row, which
          // would mean the tenant context is wrong — a fault worth naming
          // rather than a null to carry forward.
          throw new Error(
            `no invoice series for entity ${draft.entity_party_id} in FY ${String(financialYear)} — ` +
              `the row was just inserted, so this means the tenant context is not this tenant.`,
          );
        }
        sequence = series.last_number + 1;
        // THE SERIES' OWN YEAR (0337), fixed when it started: a company that
        // changes its year mid-series keeps this series' label until the new
        // year begins, as a statutory transition period does.
        number = formatInvoiceNumber({
          prefix: series.prefix,
          financialYear,
          sequence,
          startMonth: series.start_month,
        });
        // The counter moves and the invoice takes the number below, in this
        // same transaction. Either both happen or neither does.
        await db`
          UPDATE crm.invoice_series SET last_number = ${sequence}
          WHERE tenant_id = ${tenantId}
            AND entity_party_id = ${draft.entity_party_id}
            AND financial_year = ${financialYear}
            AND document_type = 'invoice'
        `;
      }

      // Lines the catalogue gives a SAC since they were drafted, before the
      // status moves: an issued invoice's lines do not change (0027).
      for (const f of on.fillSacs) {
        await db`
          UPDATE crm.invoice_line SET sac = ${f.sac}
           WHERE id = ${f.lineId} AND invoice_id = ${invoiceId} AND sac IS NULL AND removed_at IS NULL
        `;
      }
      const [row] = await db<InvoiceRow[]>`
        UPDATE crm.invoice
           SET status = 'issued', issued_on = ${issuedOn},
               number = ${number}, sequence_number = coalesce(sequence_number, ${sequence}),
               financial_year = ${financialYear},
               due_on = coalesce(due_on, ${on.dueOnIfUnset}::date),
               -- WHAT IT SAYS ABOUT TAX (Q056, 0370), decided for the issue
               -- date and frozen from this write on (the trigger admits only
               -- the draft -> issued write).
               tax_treatment = ${on.tax.treatment},
               supplier_gstin = ${on.tax.supplierGstin},
               supplier_state_code = ${on.tax.supplierStateCode},
               recipient_gstin = ${on.tax.recipientGstin},
               place_of_supply_state_code = ${on.tax.placeOfSupplyStateCode},
               place_of_supply_country = ${on.tax.placeOfSupplyCountry},
               chosen_place_of_supply = ${on.tax.chosenPlaceOfSupply},
               lut_id = ${on.tax.lutId}::uuid,
               bank_account_id = ${on.tax.bankAccountId}::uuid,
               tds_section = ${on.tax.tdsSection},
               tds_percent = ${on.tax.tdsPercent}::numeric,
               -- WHO IT IS FROM AND TO, FROZEN (0334): the supplier and the
               -- client as they stand today on the issuing company's calendar
               -- (0337), in this same write (the only one the trigger lets set
               -- it). A correction made tomorrow does not reach an issued
               -- invoice's paper.
               printed_parties = jsonb_build_object(
                 'issuer', crm.print_identity(entity_party_id,
                   (now() AT TIME ZONE crm.issuer_zone(tenant_id, entity_party_id))::date),
                 'recipient', crm.print_identity(party_id,
                   (now() AT TIME ZONE crm.issuer_zone(tenant_id, entity_party_id))::date))
         WHERE id = ${invoiceId} AND status = 'draft'
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `;
      if (!row) throw new Error(`could not issue invoice ${invoiceId}: no draft matched.`);
      return { issued: toInvoice(row) };
    });
  }

  async latestIssuedInSeries(
    tenantId: string,
    series: { readonly entityPartyId: string; readonly financialYear: number },
    exceptInvoiceId: string,
  ): Promise<{ readonly number: string; readonly sequenceNumber: number } | null> {
    return withTenant(this.app, tenantId, (db) =>
      latestIssued(db, tenantId, series.entityPartyId, series.financialYear, exceptInvoiceId),
    );
  }

  async newestNumberedYear(
    tenantId: string,
    entityPartyId: string,
    documentType: "invoice" | "credit_note",
  ): Promise<number | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ year: number | null }[]>`
        SELECT max(financial_year) AS year FROM crm.invoice_series
         WHERE entity_party_id = ${entityPartyId} AND document_type = ${documentType} AND last_number > 0
      `;
      return row?.year ?? null;
    });
  }

  async cancel(tenantId: string, invoiceId: string): Promise<CancelOutcome> {
    return withTenant(this.app, tenantId, async (db) => {
      // The row first, so a payment recorded at this moment waits for us (its
      // trigger reads the status FOR SHARE, 0326) or we wait for it.
      const [current] = await db<{ status: string }[]>`
        SELECT status FROM crm.invoice WHERE id = ${invoiceId} FOR UPDATE
      `;
      if (current?.status === "issued") {
        // Money, or TDS the client deducted (Q057): either is attached to it.
        const [money] = await db<{ paid: string; any: boolean }[]>`
          SELECT coalesce(sum(amount), 0)::text AS paid,
                 (coalesce(sum(amount), 0) <> 0 OR coalesce(sum(tds_amount), 0) <> 0) AS any
            FROM crm.payment WHERE invoice_id = ${invoiceId}
        `;
        if (money?.any === true) return { paid: money.paid };
        // AN AD-HOC ADVANCE STILL MAPPED (0363): under the advance's own lock,
        // so a mapping written at this moment waits for us or we for it.
        await db`SELECT pg_advisory_xact_lock(hashtext(${`advance:${invoiceId}`}))`;
        const [mapped] = await db<{ mapped: string | null }[]>`
          SELECT sum(coalesce(al.kept_amount, al.amount))::text AS mapped
            FROM crm.advance_allocation al
           WHERE al.invoice_id = ${invoiceId}
          HAVING sum(coalesce(al.kept_amount, al.amount)) > 0
        `;
        const mappedAmount = mapped?.mapped ?? null;
        if (mappedAmount !== null) return { mapped: mappedAmount };
      }
      const [row] = await db<InvoiceRow[]>`
        UPDATE crm.invoice SET status = 'cancelled'
        WHERE id = ${invoiceId} AND status IN ('draft', 'issued')
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `;
      if (!row) {
        throw new Error(
          `could not cancel invoice ${invoiceId}: no row matched. It has moved on since it was ` +
            `read — another request got there first.`,
        );
      }
      return { cancelled: toInvoice(row) };
    });
  }

  async registerIrn(
    tenantId: string,
    invoiceId: string,
    irn: string,
    at: string,
  ): Promise<Invoice> {
    return this.updateOne(
      tenantId,
      invoiceId,
      (db) => db`
        UPDATE crm.invoice SET irn = ${irn}, irn_registered_at = ${at}
        WHERE id = ${invoiceId} AND irn IS NULL
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `,
      "register an IRN against",
    );
  }

  async setDueOn(tenantId: string, invoiceId: string, dueOn: string | null): Promise<Invoice> {
    return this.updateOne(
      tenantId,
      invoiceId,
      (db) => db`
        UPDATE crm.invoice SET due_on = ${dueOn}::date
        WHERE id = ${invoiceId} AND status = 'draft'
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `,
      "set the due date of",
    );
  }

  async setManager(tenantId: string, invoiceId: string, managerUserId: string | null): Promise<Invoice> {
    // A draft only: 0318's trigger refuses the same change on anything else.
    return this.updateOne(
      tenantId,
      invoiceId,
      (db) => db`
        UPDATE crm.invoice SET manager_user_id = ${managerUserId}
        WHERE id = ${invoiceId} AND status = 'draft'
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `,
      "set the manager of",
    );
  }

  async listSeries(tenantId: string): Promise<readonly InvoiceSeriesRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        {
          entity_party_id: string;
          entity_name: string;
          financial_year: number;
          start_month: number;
          document_type: string;
          prefix: string;
          last_number: number;
        }[]
      >`
        SELECT s.entity_party_id, e.display_name AS entity_name, s.financial_year, s.start_month,
               s.document_type, s.prefix, s.last_number
        FROM crm.invoice_series s
        JOIN core.party e ON e.id = s.entity_party_id
        ORDER BY e.display_name, s.financial_year DESC, s.document_type
      `;
      return rows.map((r) => ({
        entityPartyId: r.entity_party_id,
        entityName: r.entity_name,
        financialYear: r.financial_year,
        startMonth: r.start_month,
        documentType: r.document_type,
        prefix: r.prefix,
        lastNumber: r.last_number,
      }));
    });
  }

  async setSeriesPrefix(tenantId: string, entityPartyId: string, prefix: string): Promise<void> {
    await withTenant(
      this.app,
      tenantId,
      (db) => db`
        UPDATE crm.invoice_series SET prefix = ${prefix}
        WHERE entity_party_id = ${entityPartyId} AND document_type = 'invoice'
      `,
    );
  }

  /**
   * One guarded UPDATE, and a NO ROW is a state change somebody else already
   * made — never a missing invoice.
   *
   * Each predicate above (`status = 'draft'`, `irn IS NULL`) is the transition
   * itself acting as the lock, the same arrangement `signAndFanOut` and
   * `recordAdvance` use: two concurrent issues cannot both succeed, so two
   * `invoice.issued` events cannot both be written into a log that has no way
   * to take one back.
   */
  private async updateOne(
    tenantId: string,
    invoiceId: string,
    run: (db: Db) => Promise<InvoiceRow[]>,
    verb: string,
  ): Promise<Invoice> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await run(db);
      const row = rows[0];
      if (!row) {
        throw new Error(
          `could not ${verb} invoice ${invoiceId}: no row matched. It has moved on since it was ` +
            `read — another request got there first.`,
        );
      }
      return toInvoice(row);
    });
  }
  // ── The GST tax invoice (Q056, Q057) ──────────────────────────────────────

  /**
   * What decides the invoice's tax, as it stands on `onDay`. Both parties are
   * read through `crm.print_identity`, the function Issue freezes into the
   * paper (0334), so the GSTIN the tax is decided on is the GSTIN printed.
   */
  async taxFacts(
    tenantId: string,
    invoiceId: string,
    on: { readonly onDay: string; readonly financialYear: number },
  ): Promise<InvoiceTaxFacts> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        {
          entity_party_id: string;
          party_id: string;
          currency: string;
          supplier: { country?: string; taxId?: { type: string; value: string } } | null;
          recipient: {
            name?: string;
            country?: string;
            taxId?: { type: string; value: string };
            address?: { lines?: unknown; region?: string };
          } | null;
        }[]
      >`
        SELECT i.entity_party_id, i.party_id, i.currency,
               crm.print_identity(i.entity_party_id, ${on.onDay}::date) AS supplier,
               crm.print_identity(i.party_id, ${on.onDay}::date) AS recipient
          FROM crm.invoice i
         WHERE i.id = ${invoiceId}
      `;
      if (!head) throw new Error(`invoice ${invoiceId} is not at this firm`);
      const [lut] = await db<{ id: string }[]>`
        SELECT id FROM crm.firm_entity_lut
         WHERE entity_party_id = ${head.entity_party_id}
           AND financial_year = ${on.financialYear}
           AND retired_at IS NULL
      `;
      // The account FOR this currency, else the company's general one.
      const [bank] = await db<{ id: string }[]>`
        SELECT id FROM crm.firm_entity_bank_account
         WHERE entity_party_id = ${head.entity_party_id}
           AND retired_at IS NULL
           AND (currency = ${head.currency} OR currency IS NULL)
         ORDER BY (currency IS NULL), created_at DESC
         LIMIT 1
      `;
      const [tds] = await db<{ section: string; percent: string }[]>`
        SELECT section, percent::text AS percent FROM crm.client_tds
         WHERE party_id = ${head.party_id} AND section IS NOT NULL
      `;
      const supplierCountry = head.supplier?.country ?? null;
      const lines = await db<{ id: string; description: string; sac: string | null; service_sac: string | null }[]>`
        -- The SAC the catalogue gives each line's service NOW (its published
        -- version), for the issuing company's country.
        SELECT l.id, l.description, l.sac,
               st.body -> 'tax' -> ${supplierCountry ?? ""}::text ->> 'sac' AS service_sac
          FROM crm.invoice_line l
          LEFT JOIN crm.engagement e ON e.id = l.engagement_id AND e.tenant_id = l.tenant_id
          LEFT JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          LEFT JOIN config.version sv ON sv.id = ll.service_version_id AND sv.tenant_id = ll.tenant_id
          LEFT JOIN config.version st
            ON st.entry_id = sv.entry_id AND st.tenant_id = sv.tenant_id AND st.status = 'published'
         WHERE l.invoice_id = ${invoiceId} AND l.removed_at IS NULL
         ORDER BY l.position
      `;
      const taxId = (who: typeof head.supplier) =>
        who?.taxId !== undefined && who.taxId.type === "gstin" ? who.taxId.value : null;
      const address = head.recipient?.address;
      const lineCount = Array.isArray(address?.lines) ? address.lines.length : 0;
      return {
        supplierCountry,
        supplierGstin: taxId(head.supplier),
        recipientName: head.recipient?.name ?? head.party_id,
        recipientCountry: head.recipient?.country ?? null,
        recipientGstin: taxId(head.recipient),
        recipientRegion: address?.region ?? null,
        recipientHasAddress: lineCount > 0 || (address?.region ?? "") !== "",
        lutId: lut?.id ?? null,
        bankAccountId: bank?.id ?? null,
        clientTds: tds === undefined ? null : { section: tds.section, percent: tds.percent },
        lines: lines.map((l) => ({ id: l.id, description: l.description, sac: l.sac, serviceSac: l.service_sac })),
      };
    });
  }

  async setDraftTax(
    tenantId: string,
    invoiceId: string,
    tax: InvoiceTaxSnapshot,
    fillSacs: readonly { readonly lineId: string; readonly sac: string }[],
  ): Promise<Invoice> {
    return withTenant(this.app, tenantId, async (db) => {
      for (const f of fillSacs) {
        await db`
          UPDATE crm.invoice_line SET sac = ${f.sac}
           WHERE id = ${f.lineId} AND invoice_id = ${invoiceId} AND sac IS NULL AND removed_at IS NULL
        `;
      }
      const [row] = await db<InvoiceRow[]>`
        UPDATE crm.invoice
           SET tax_treatment = ${tax.treatment},
               supplier_gstin = ${tax.supplierGstin},
               supplier_state_code = ${tax.supplierStateCode},
               recipient_gstin = ${tax.recipientGstin},
               place_of_supply_state_code = ${tax.placeOfSupplyStateCode},
               place_of_supply_country = ${tax.placeOfSupplyCountry},
               chosen_place_of_supply = ${tax.chosenPlaceOfSupply},
               lut_id = ${tax.lutId}::uuid,
               bank_account_id = ${tax.bankAccountId}::uuid,
               tds_section = ${tax.tdsSection},
               tds_percent = ${tax.tdsPercent}::numeric
         WHERE id = ${invoiceId} AND status = 'draft'
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `;
      if (!row) {
        throw new Error(
          `could not set the tax of invoice ${invoiceId}: no draft matched. It has moved on since it ` +
            `was read — another request got there first.`,
        );
      }
      return toInvoice(row);
    });
  }

  async setLineSac(tenantId: string, invoiceId: string, lineId: string, sac: string | null): Promise<void> {
    await withTenant(
      this.app,
      tenantId,
      (db) => db`
        UPDATE crm.invoice_line SET sac = ${sac}
         WHERE id = ${lineId} AND invoice_id = ${invoiceId} AND removed_at IS NULL
      `,
    );
  }

  async serviceTaxFor(
    tenantId: string,
    engagementId: string,
    issuerPartyId: string,
  ): Promise<{ readonly sac: string | null; readonly ratePercent: string | null } | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [found] = await db<{ entry: Record<string, unknown> | null }[]>`
        SELECT v.body -> 'tax' -> le.jurisdiction AS entry
          FROM crm.engagement e
          JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          JOIN config.version sv ON sv.id = ll.service_version_id AND sv.tenant_id = ll.tenant_id
          JOIN config.version v ON v.entry_id = sv.entry_id AND v.tenant_id = sv.tenant_id AND v.status = 'published'
          LEFT JOIN core.legal_entity le ON le.party_id = ${issuerPartyId} AND le.tenant_id = e.tenant_id
         WHERE e.id = ${engagementId}
      `;
      if (found === undefined) return null;
      const entry = found.entry;
      const sac = typeof entry?.["sac"] === "string" ? entry["sac"] : null;
      const ratePercent = typeof entry?.["ratePercent"] === "string" ? entry["ratePercent"] : null;
      return { sac, ratePercent };
    });
  }

  async clientTds(tenantId: string, partyId: string): Promise<ClientTds | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ section: string; percent: string }[]>`
        SELECT section, percent::text AS percent FROM crm.client_tds
         WHERE party_id = ${partyId} AND section IS NOT NULL
      `;
      return row === undefined ? null : { section: row.section, percent: row.percent };
    });
  }

  async setClientTds(tenantId: string, partyId: string, tds: ClientTds | null): Promise<void> {
    await withTenant(
      this.app,
      tenantId,
      (db) => db`
        INSERT INTO crm.client_tds (tenant_id, party_id, section, percent)
        VALUES (${tenantId}, ${partyId}, ${tds?.section ?? null}, ${tds?.percent ?? null}::numeric)
        ON CONFLICT (tenant_id, party_id)
        DO UPDATE SET section = EXCLUDED.section, percent = EXCLUDED.percent
      `,
    );
  }

  // ── Money against an invoice (T3.5) ──────────────────────────────────────

  async recordPayment(p: NewPayment): Promise<PaymentOutcome> {
    return withTenant(this.app, p.tenantId, async (db): Promise<PaymentOutcome> => {
      // A REVERSAL NO LARGER THAN WHAT WAS PAID (audit 2026-10-03), decided in
      // this transaction: the invoice row first, so a second payment on it
      // waits for this one and reads the balance this one leaves. More than is
      // owed is recorded on purpose (a credit).
      await db`SELECT 1 FROM crm.invoice WHERE id = ${p.invoiceId} FOR UPDATE`;
      const [b] = await db<{ paid: string; tds: string; reversesTooMuch: boolean; reversesTdsTooMuch: boolean }[]>`
        SELECT paid::text AS paid, tds::text AS tds,
               (${p.amount}::numeric < 0 AND -${p.amount}::numeric > paid) AS "reversesTooMuch",
               (${p.tdsAmount}::numeric < 0 AND -${p.tdsAmount}::numeric > tds) AS "reversesTdsTooMuch"
          FROM crm.invoice_balance WHERE invoice_id = ${p.invoiceId}
      `;
      if (b?.reversesTooMuch === true) return { paid: b.paid };
      // The same for TDS (Q057): a TDS reversal no larger than the TDS recorded.
      if (b?.reversesTdsTooMuch === true) return { tds: b.tds };
      const [row] = await db<PaymentRow[]>`
        INSERT INTO crm.payment
          (id, tenant_id, invoice_id, amount, currency, received_on, method, reference, note, tds_amount)
        VALUES (${p.id}, ${p.tenantId}, ${p.invoiceId}, ${p.amount}, ${p.currency},
                ${p.receivedOn}, ${p.method}, ${p.reference}, ${p.note}, ${p.tdsAmount})
        RETURNING ${db.unsafe(PAYMENT_COLUMNS)}
      `;
      if (!row) throw new Error("payment insert returned no row");
      return { payment: toPayment(row) };
    });
  }

  async listPayments(tenantId: string, invoiceId: string): Promise<readonly Payment[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<PaymentRow[]>`
        SELECT ${db.unsafe(PAYMENT_COLUMNS)} FROM crm.payment
        WHERE invoice_id = ${invoiceId}
        ORDER BY received_on, created_at
      `;
      return rows.map(toPayment);
    });
  }

  /**
   * A credit note takes its number the same way an invoice does — and from a
   * SEPARATE series, keyed on `document_type = 'credit_note'`.
   *
   * 0027 shipped a series key without a document type and 0028 corrected it.
   * Borrowing the invoice counter would interleave two legal series into one
   * sequence, which is worse than a gap: an invoice number missing because it
   * went to a credit note is a number an auditor cannot account for.
   */
  async issueCreditNote(c: NewCreditNote): Promise<CreditNoteOutcome> {
    const financialYear = c.financialYear;
    return withTenant(this.app, c.tenantId, async (db): Promise<CreditNoteOutcome> => {
      // THE CAP, IN THIS TRANSACTION (B15). The invoice row first, so a second
      // credit note on it waits for this one; then the advance's lock, the one
      // a bill taking from this advance holds (`takeFromPool`), so a raise and
      // a credit cannot both spend the last of it.
      await db`SELECT 1 FROM crm.invoice WHERE id = ${c.invoiceId} FOR UPDATE`;
      await db`SELECT pg_advisory_xact_lock(hashtext(${`advance:${c.invoiceId}`}))`;
      // What may still be credited: what has not been credited, and on an
      // advance only what later bills have not taken (B06), with its share of
      // the tax: exactly the refund's own figure (`refundCandidates`), so
      // "Give it back" is never refused by a paisa.
      const [cap] = await db<{ max_credit: string; taken: string | null; ok: boolean }[]>`
        WITH m AS (
          SELECT CASE WHEN ap.invoice_id IS NULL THEN b.invoiced - b.credited
                      ELSE least(round(ap.remaining * t.total / nullif(t.net, 0), 2), b.invoiced - b.credited)
                 END AS max_credit,
                 CASE WHEN coalesce(ap.applied, 0) > 0
                      THEN round(ap.applied * t.total / nullif(t.net, 0), 2) END AS taken
            FROM crm.invoice_balance b
            JOIN crm.invoice_totals t ON t.invoice_id = b.invoice_id AND t.tenant_id = b.tenant_id
            -- An ad-hoc advance (0363) gives back only what is MAPPED NOWHERE:
            -- a mapped part belongs to that work until the mapping is ended.
            LEFT JOIN (
              SELECT invoice_id,
                     sum(remaining) FILTER (WHERE source <> 'allocation') AS remaining,
                     sum(applied) AS applied
                FROM crm.advance_pool GROUP BY invoice_id
            ) ap ON ap.invoice_id = b.invoice_id
           WHERE b.invoice_id = ${c.invoiceId}
        )
        SELECT greatest(m.max_credit, 0)::text AS max_credit, m.taken::text AS taken,
               ${c.amount}::numeric <= m.max_credit AS ok
          FROM m
      `;
      if (cap !== undefined && !cap.ok) return { maxCredit: cap.max_credit, takenByBills: cap.taken };

      await ensureSeries(db, c.tenantId, c.entityPartyId, financialYear, "credit_note", c.fiscalYearStartMonth);

      const [series] = await db<{ last_number: number; prefix: string; start_month: number }[]>`
        SELECT last_number, prefix, start_month FROM crm.invoice_series
        WHERE tenant_id = ${c.tenantId}
          AND entity_party_id = ${c.entityPartyId}
          AND financial_year = ${financialYear}
          AND document_type = 'credit_note'
        FOR UPDATE
      `;
      if (!series) {
        throw new Error(
          `no credit-note series for entity ${c.entityPartyId} in FY ${String(financialYear)} — ` +
            `the row was just inserted, so this means the tenant context is not this tenant.`,
        );
      }

      const sequence = series.last_number + 1;
      const number = formatInvoiceNumber({
        prefix: series.prefix,
        financialYear,
        sequence,
        // The series' own year (0337), as for an invoice.
        startMonth: series.start_month,
      });

      await db`
        UPDATE crm.invoice_series SET last_number = ${sequence}
        WHERE tenant_id = ${c.tenantId}
          AND entity_party_id = ${c.entityPartyId}
          AND financial_year = ${financialYear}
          AND document_type = 'credit_note'
      `;

      const [row] = await db<CreditNoteRow[]>`
        INSERT INTO crm.credit_note
          (id, tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number,
           amount, currency, issued_on, reason, note)
        VALUES (${c.id}, ${c.tenantId}, ${c.invoiceId}, ${c.entityPartyId}, ${number},
                ${financialYear}, ${sequence}, ${c.amount}, ${c.currency}, ${c.issuedOn},
                ${c.reason}, ${c.note})
        RETURNING ${db.unsafe(CREDIT_NOTE_COLUMNS)}
      `;
      if (!row) throw new Error("credit note insert returned no row");
      return { credit: toCreditNote(row) };
    });
  }

  async listCreditNotes(tenantId: string, invoiceId: string): Promise<readonly CreditNote[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<CreditNoteRow[]>`
        SELECT ${db.unsafe(CREDIT_NOTE_COLUMNS)} FROM crm.credit_note
        WHERE invoice_id = ${invoiceId}
        ORDER BY sequence_number
      `;
      return rows.map(toCreditNote);
    });
  }

  async balanceOf(tenantId: string, invoiceId: string): Promise<InvoiceBalance | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<BalanceRow[]>`
        SELECT ${db.unsafe(BALANCE_COLUMNS)} FROM crm.invoice_balance
        WHERE invoice_id = ${invoiceId}
      `;
      return row ? toBalance(row) : null;
    });
  }

  async outstanding(tenantId: string): Promise<readonly ReceivableRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<(BalanceRow & { number: string; party_name: string })[]>`
        SELECT ${db.unsafe(BALANCE_COLUMNS.split(", ").map((c) => `b.${c}`).join(", "))},
               i.number, p.display_name AS party_name
        FROM crm.invoice_balance b
        -- The number and the client, IN THE QUERY. A collections screen renders
        -- one row per debt and has to say whose and which; without this it is a
        -- column of uuids, which is the per-row lookup this codebase has now
        -- learnt about six times.
        JOIN crm.invoice i ON i.id = b.invoice_id
        JOIN core.party p ON p.id = b.party_id
        -- ISSUED only, and outstanding only. A draft owes nothing because
        -- nobody has been asked; a cancelled invoice owes nothing because it
        -- was withdrawn. Both would otherwise appear in "who owes us money"
        -- with their full total, which is the report a partner acts on.
        WHERE b.status = 'issued' AND b.outstanding > 0
        ORDER BY b.due_on NULLS LAST, b.invoice_id
      `;
      return rows.map((r) => ({
        balance: toBalance(r),
        number: r.number,
        party: { id: r.party_id, displayName: r.party_name },
      }));
    });
  }
}

interface PaymentRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  amount: string;
  currency: string;
  received_on: Date;
  method: string;
  reference: string | null;
  note: string | null;
  tds_amount: string;
}

const PAYMENT_COLUMNS =
  "id, tenant_id, invoice_id, amount, currency, received_on, method, reference, note, tds_amount";

function toPayment(r: PaymentRow): Payment {
  if (!isPaymentMethod(r.method)) {
    throw new Error(
      `crm.payment holds method ${JSON.stringify(r.method)}, which is not a PaymentMethod. The ` +
        `CHECK constraint and domain/invoice/model.ts have drifted apart.`,
    );
  }
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    amount: r.amount,
    currency: r.currency,
    receivedOn: day(r.received_on) ?? "",
    method: r.method,
    reference: r.reference,
    note: r.note,
    tdsAmount: r.tds_amount,
  };
}

interface CreditNoteRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  entity_party_id: string;
  number: string;
  financial_year: number;
  sequence_number: number;
  amount: string;
  currency: string;
  issued_on: Date;
  reason: string;
  note: string | null;
}

const CREDIT_NOTE_COLUMNS =
  "id, tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number, " +
  "amount, currency, issued_on, reason, note";

function toCreditNote(r: CreditNoteRow): CreditNote {
  if (!isCreditReason(r.reason)) {
    throw new Error(
      `crm.credit_note holds reason ${JSON.stringify(r.reason)}, which is not a CreditReason. ` +
        `The CHECK constraint and domain/invoice/model.ts have drifted apart.`,
    );
  }
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoiceId: r.invoice_id,
    entityPartyId: r.entity_party_id,
    number: r.number,
    financialYear: r.financial_year,
    sequenceNumber: r.sequence_number,
    amount: r.amount,
    currency: r.currency,
    issuedOn: day(r.issued_on) ?? "",
    reason: r.reason,
    note: r.note,
  };
}

interface BalanceRow {
  invoice_id: string;
  party_id: string;
  status: string;
  currency: string;
  due_on: Date | null;
  invoiced: string;
  paid: string;
  credited: string;
  outstanding: string;
  tds: string;
}

const BALANCE_COLUMNS =
  "invoice_id, party_id, status, currency, due_on, invoiced, paid, credited, outstanding, tds";

function toBalance(r: BalanceRow): InvoiceBalance {
  return {
    invoiceId: r.invoice_id,
    partyId: r.party_id,
    status: toStatus(r.status),
    currency: r.currency,
    dueOn: day(r.due_on),
    invoiced: r.invoiced,
    paid: r.paid,
    credited: r.credited,
    outstanding: r.outstanding,
    tds: r.tds,
  };
}

interface TotalsRow {
  line_count: string;
  gross: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  tds: string;
  net_payable: string;
}

const TOTALS_COLUMNS =
  "line_count::text, gross::text, discount::text, net::text, tax::text, total::text, cgst::text, " +
  "sgst::text, utgst::text, igst::text, tds::text, net_payable::text";

/**
 * An invoice with no live lines has no row in the totals view at all: `sum()`
 * over nothing is NULL and `GROUP BY` emits no group. Zeroes are the honest
 * reading of "nothing on it yet", and the alternative is a screen that renders
 * "null" where a figure belongs.
 */
function toTotals(t: TotalsRow | undefined, currency: string): InvoiceRecord["totals"] {
  return {
    lineCount: Number(t?.line_count ?? "0"),
    gross: t?.gross ?? "0",
    discount: t?.discount ?? "0",
    net: t?.net ?? "0",
    tax: t?.tax ?? "0",
    total: t?.total ?? "0",
    currency,
    cgst: t?.cgst ?? "0",
    sgst: t?.sgst ?? "0",
    utgst: t?.utgst ?? "0",
    igst: t?.igst ?? "0",
    tds: t?.tds ?? "0",
    netPayable: t?.net_payable ?? "0",
  };
}

interface BankAccountRow {
  id: string;
  account_name: string;
  account_number: string;
  bank_name: string;
  branch: string | null;
  ifsc: string | null;
  swift: string | null;
  iban: string | null;
  currency: string | null;
}

const BANK_COLUMNS = "id, account_name, account_number, bank_name, branch, ifsc, swift, iban, currency";

function toBankAccount(r: BankAccountRow): BankAccountView {
  return {
    id: r.id,
    accountName: r.account_name,
    accountNumber: r.account_number,
    bankName: r.bank_name,
    branch: r.branch,
    ifsc: r.ifsc,
    swift: r.swift,
    iban: r.iban,
    currency: r.currency,
  };
}
