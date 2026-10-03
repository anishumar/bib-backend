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
  Payment,
} from "../../domain/invoice/model";
import {
  DEFAULT_CREDIT_NOTE_PREFIX,
  DEFAULT_SERIES_PREFIX,
  financialYearOf,
  formatInvoiceNumber,
  isCreditReason,
  isInvoiceStatus,
  isPaymentMethod,
} from "../../domain/invoice/model";
import type {
  EngagementBilling,
  InvoiceFilters,
  InvoiceLineRecord,
  InvoiceRecord,
  InvoiceRepository,
  InvoiceSeriesRecord,
  InvoiceSummary,
  NewCreditNote,
  ReceivableRecord,
  NewInvoice,
  NewInvoiceLine,
  NewPayment,
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
  };
}

const INVOICE_COLUMNS =
  "id, tenant_id, party_id, entity_party_id, number, financial_year, sequence_number, " +
  "status, currency, fx_rate, fx_rate_date, issued_on, due_on, irn, irn_registered_at, notes, " +
  "manager_user_id";

const LINE_COLUMNS =
  "id, tenant_id, invoice_id, engagement_id, description, position, quantity, unit_amount, " +
  "currency, discount_percent, tax_percent";

/** The company's invoice series for the year exists. ON CONFLICT DO NOTHING so
 *  two concurrent first invoices do not race to create it; the `FOR UPDATE`
 *  read in `issue` is what actually orders them. */
async function ensureInvoiceSeries(db: Db, tenantId: string, entityPartyId: string, financialYear: number): Promise<void> {
  await db`
    INSERT INTO crm.invoice_series
      (tenant_id, entity_party_id, financial_year, document_type, prefix)
    VALUES (${tenantId}, ${entityPartyId}, ${financialYear}, 'invoice', ${DEFAULT_SERIES_PREFIX})
    ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
  `;
}

export class PostgresInvoiceRepository implements InvoiceRepository {
  constructor(private readonly app: Db) {}

  /**
   * The DRAFT, with no number (0322). Its series row exists from here, because
   * the draft names the series (and the year) its number will come from, and
   * the foreign key wants the row. Nothing is counted.
   */
  async create(i: NewInvoice): Promise<Invoice> {
    const financialYear = financialYearOf(i.seriesDate);
    return withTenant(this.app, i.tenantId, async (db) => {
      await ensureInvoiceSeries(db, i.tenantId, i.entityPartyId, financialYear);
      const [row] = await db<InvoiceRow[]>`
        INSERT INTO crm.invoice
          (id, tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
           currency, fx_rate, fx_rate_date, due_on, notes, manager_user_id)
        VALUES (${i.id}, ${i.tenantId}, ${i.partyId}, ${i.entityPartyId}, NULL,
                ${financialYear}, NULL, ${i.currency}, ${i.fxRate}, ${i.fxRateDate},
                ${i.dueOn}, ${i.notes}, ${i.managerUserId ?? null})
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `;
      if (!row) throw new Error("invoice insert returned no row");
      return toInvoice(row);
    });
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

      const lines = await db<(InvoiceLineRow & { net: string; tax: string })[]>`
        SELECT ${db.unsafe(LINE_COLUMNS.split(", ").map((c) => `l.${c}`).join(", "))},
               a.net, a.tax
        FROM crm.invoice_line l
        JOIN crm.invoice_line_amount a ON a.invoice_line_id = l.id
        WHERE l.invoice_id = ${invoiceId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      const [totals] = await db<
        { line_count: string; gross: string; discount: string; net: string; tax: string; total: string }[]
      >`
        SELECT line_count::text, gross::text, discount::text, net::text, tax::text, total::text
        FROM crm.invoice_totals WHERE invoice_id = ${invoiceId}
      `;

      return {
        invoice: toInvoice(head),
        party: { id: head.party_id, displayName: head.party_name },
        entity: { id: head.entity_party_id, displayName: head.entity_name },
        lines: lines.map((r): InvoiceLineRecord => ({ line: toLine(r), net: r.net, tax: r.tax })),
        // An invoice with no live lines has no row in the totals view at all —
        // `sum()` over nothing is NULL and `GROUP BY` emits no group. Zeroes are
        // the honest reading of "nothing on it yet", and the alternative is a
        // screen that renders "null" where a figure belongs.
        totals: {
          lineCount: Number(totals?.line_count ?? "0"),
          gross: totals?.gross ?? "0",
          discount: totals?.discount ?? "0",
          net: totals?.net ?? "0",
          tax: totals?.tax ?? "0",
          total: totals?.total ?? "0",
          currency: head.currency,
        },
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
          paid: string | null;
          credited: string | null;
          outstanding: string | null;
        })[]
      >`
        SELECT i.id, i.tenant_id, i.party_id, i.entity_party_id, i.number, i.financial_year,
               i.sequence_number, i.status, i.currency, i.fx_rate, i.fx_rate_date, i.issued_on,
               i.due_on, i.irn, i.irn_registered_at, i.notes,
               p.display_name AS party_name,
               t.line_count::text, t.gross::text, t.discount::text, t.net::text,
               t.tax::text, t.total::text,
               b.paid::text, b.credited::text, b.outstanding::text
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
        totals: {
          lineCount: Number(r.line_count ?? "0"),
          gross: r.gross ?? "0",
          discount: r.discount ?? "0",
          net: r.net ?? "0",
          tax: r.tax ?? "0",
          total: r.total ?? "0",
          currency: r.currency,
        },
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
              }
            : null,
      }));
    });
  }

  async addLine(l: NewInvoiceLine): Promise<InvoiceLine> {
    return withTenant(this.app, l.tenantId, async (db) => {
      // THE INVOICE ROW IS THE LOCK (B36). `MAX(position) + 1` inside the INSERT
      // still reads a snapshot under READ COMMITTED, so two lines added at once
      // both took the same position and one failed on the unique index as a
      // 500. Holding the invoice row first makes the second add wait for the
      // first to commit and then read its line.
      await db`SELECT 1 FROM crm.invoice WHERE id = ${l.invoiceId} FOR UPDATE`;
      const [row] = await db<InvoiceLineRow[]>`
        INSERT INTO crm.invoice_line
          (id, tenant_id, invoice_id, engagement_id, description, position, quantity,
           unit_amount, currency, discount_percent, tax_percent)
        SELECT ${l.id}, ${l.tenantId}, ${l.invoiceId}, ${l.engagementId}, ${l.description},
               -- The next position among LIVE lines: a struck-off line frees
               -- its position (0326).
               COALESCE(MAX(position), 0) + 1,
               ${l.quantity}, ${l.unitAmount}, ${l.currency}, ${l.discountPercent},
               ${l.taxPercent}
        FROM crm.invoice_line
        WHERE invoice_id = ${l.invoiceId} AND removed_at IS NULL
        RETURNING ${db.unsafe(LINE_COLUMNS)}
      `;
      if (!row) throw new Error("invoice line insert returned no row");
      return toLine(row);
    });
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
        SELECT e.party_id, l.issuing_entity_party_id, l.ref AS letter_ref, l.currency
          FROM crm.engagement e
          JOIN crm.engagement_letter l
            ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
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
   * made before 0322 already holds a number: it keeps it and counts nothing.
   */
  async issue(tenantId: string, invoiceId: string, issuedOn: string): Promise<Invoice> {
    return withTenant(this.app, tenantId, async (db) => {
      const [draft] = await db<{ entity_party_id: string; financial_year: number; number: string | null }[]>`
        SELECT entity_party_id, financial_year, number FROM crm.invoice
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
      if (number === null) {
        await ensureInvoiceSeries(db, tenantId, draft.entity_party_id, draft.financial_year);
        // THE LOCK. Everything this file exists for is this line. A second
        // writer waits here until the first transaction ends, and then reads
        // what is stored rather than a snapshot taken at its own BEGIN.
        const [series] = await db<{ last_number: number; prefix: string }[]>`
          SELECT last_number, prefix FROM crm.invoice_series
          WHERE tenant_id = ${tenantId}
            AND entity_party_id = ${draft.entity_party_id}
            AND financial_year = ${draft.financial_year}
            AND document_type = 'invoice'
          FOR UPDATE
        `;
        if (!series) {
          // Unreachable through the insert above unless RLS hid the row, which
          // would mean the tenant context is wrong — a fault worth naming
          // rather than a null to carry forward.
          throw new Error(
            `no invoice series for entity ${draft.entity_party_id} in FY ${String(draft.financial_year)} — ` +
              `the row was just inserted, so this means the tenant context is not this tenant.`,
          );
        }
        sequence = series.last_number + 1;
        number = formatInvoiceNumber({ prefix: series.prefix, financialYear: draft.financial_year, sequence });
        // The counter moves and the invoice takes the number below, in this
        // same transaction. Either both happen or neither does.
        await db`
          UPDATE crm.invoice_series SET last_number = ${sequence}
          WHERE tenant_id = ${tenantId}
            AND entity_party_id = ${draft.entity_party_id}
            AND financial_year = ${draft.financial_year}
            AND document_type = 'invoice'
        `;
      }

      const [row] = await db<InvoiceRow[]>`
        UPDATE crm.invoice
           SET status = 'issued', issued_on = ${issuedOn},
               number = ${number}, sequence_number = coalesce(sequence_number, ${sequence})
         WHERE id = ${invoiceId} AND status = 'draft'
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `;
      if (!row) throw new Error(`could not issue invoice ${invoiceId}: no draft matched.`);
      return toInvoice(row);
    });
  }

  async cancel(tenantId: string, invoiceId: string): Promise<Invoice> {
    return this.updateOne(
      tenantId,
      invoiceId,
      (db) => db`
        UPDATE crm.invoice SET status = 'cancelled'
        WHERE id = ${invoiceId} AND status IN ('draft', 'issued')
        RETURNING ${db.unsafe(INVOICE_COLUMNS)}
      `,
      "cancel",
    );
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
          document_type: string;
          prefix: string;
          last_number: number;
        }[]
      >`
        SELECT s.entity_party_id, e.display_name AS entity_name, s.financial_year,
               s.document_type, s.prefix, s.last_number
        FROM crm.invoice_series s
        JOIN core.party e ON e.id = s.entity_party_id
        ORDER BY e.display_name, s.financial_year DESC, s.document_type
      `;
      return rows.map((r) => ({
        entityPartyId: r.entity_party_id,
        entityName: r.entity_name,
        financialYear: r.financial_year,
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
  // ── Money against an invoice (T3.5) ──────────────────────────────────────

  async recordPayment(p: NewPayment): Promise<Payment> {
    return withTenant(this.app, p.tenantId, async (db) => {
      const [row] = await db<PaymentRow[]>`
        INSERT INTO crm.payment
          (id, tenant_id, invoice_id, amount, currency, received_on, method, reference, note)
        VALUES (${p.id}, ${p.tenantId}, ${p.invoiceId}, ${p.amount}, ${p.currency},
                ${p.receivedOn}, ${p.method}, ${p.reference}, ${p.note})
        RETURNING ${db.unsafe(PAYMENT_COLUMNS)}
      `;
      if (!row) throw new Error("payment insert returned no row");
      return toPayment(row);
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
  async issueCreditNote(c: NewCreditNote): Promise<CreditNote> {
    const financialYear = financialYearOf(c.seriesDate);
    return withTenant(this.app, c.tenantId, async (db) => {
      await db`
        INSERT INTO crm.invoice_series
          (tenant_id, entity_party_id, financial_year, document_type, prefix)
        VALUES (${c.tenantId}, ${c.entityPartyId}, ${financialYear}, 'credit_note',
                ${DEFAULT_CREDIT_NOTE_PREFIX})
        ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
      `;

      const [series] = await db<{ last_number: number; prefix: string }[]>`
        SELECT last_number, prefix FROM crm.invoice_series
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
      const number = formatInvoiceNumber({ prefix: series.prefix, financialYear, sequence });

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
      return toCreditNote(row);
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
}

const PAYMENT_COLUMNS =
  "id, tenant_id, invoice_id, amount, currency, received_on, method, reference, note";

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
}

const BALANCE_COLUMNS =
  "invoice_id, party_id, status, currency, due_on, invoiced, paid, credited, outstanding";

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
  };
}
