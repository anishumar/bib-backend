// The client portal's library, in Postgres (T6.7). The THIRD adapter in this
// product that uses `withPortal`, and CLAUDE.md's *"it should stay countable on
// one hand"* is now half spent — the next one needs an argument.
//
// ── EVERY QUERY BELOW LOOKS LIKE A QUERY THAT FORGOT TO FILTER ────────────
//
// None of them names `party_id`, `is_client_visible` or an invoice status in a
// WHERE clause. The wall is UNDER the query, not in it:
//
//   `document_portal_scope`         (0063, NARROWED by 0066) — this client's,
//                                     and only if the firm marked it visible
//   `document_version_portal_scope` (0063) — its bytes and its filename, by an
//                                     EXISTS on the parent, so it inherits both
//   `document_link_portal_scope`    (0063) — what it is attached to
//   `invoice_portal_scope`          (0066) — this client's, and never a DRAFT
//   `invoice_line_portal_scope`     (0066) — by an EXISTS on the invoice
//   `payment_portal_scope`          (0066) —          "
//   `credit_note_portal_scope`      (0066) —          "
//   `obligation_instance_portal_scope` (0062) — the filings in the digest
//   `obligation_instance_portal_live`  (0309) — never a withdrawn one (and a
//                                     withdrawn row is never filed anyway)
//   `client_ask_portal_scope`       (0063) — the asks in the digest
//
// Repeating any of them here would feel safer and would silently disarm the
// negative control. `tests/portal/library.integration.test.ts` drops a policy
// and expects these statements to start LEAKING; a test that still passes with
// the wall removed proves only that the rows exist.
//
// ── AND `crm.invoice_balance` NEEDS NOTHING WRITTEN FOR IT ───────────────
//
// It is `security_invoker = true`, like `invoice_totals` and
// `invoice_line_amount` under it, so it evaluates the policies of whoever is
// asking. That is exactly what that flag is for and it is why 0066 wrote four
// table policies and no view policy — a view with `security_definer` would have
// been a hole with a SELECT grant on it.
//
// ── MONEY IS `::text`, EVERY TIME ────────────────────────────────────────
//
// `numeric` cast to text in SQL and carried as a string all the way to the
// browser. postgres.js would otherwise hand back a JS number for some of these
// and a string for others depending on precision, and the failure mode is a
// rounding error on a client's own invoice.
import type { Db } from "../../db/pool";
import { withPortal } from "../../db/tenant";
import type { DocumentKind, DocumentVersion } from "../../domain/filestore/model";
import type {
  PortalDigest,
  PortalDigestRow,
  PortalDocumentRow,
  PortalInvoiceRow,
} from "../../domain/portallibrary/model";
import type { PortalLibraryRepository } from "../../usecase/portallibrary/ports";
import { isoInstant } from "./instant";

interface DocRow {
  id: string;
  title: string;
  kind: string;
  company_name: string;
  filename: string;
  byte_size: string | number;
  media_type: string;
  content_hash: string;
  added_on: string;
  about_what: string | null;
}

interface VersionRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version_no: number;
  content_hash: string;
  byte_size: string | number;
  media_type: string;
  filename: string;
  storage_key: string;
  created_by: string | null;
  created_at: string;
}

interface InvoiceRow {
  id: string;
  number: string;
  issued_by: string;
  billed_to: string;
  status: string;
  currency: string;
  total: string;
  paid: string;
  credited: string;
  outstanding: string;
  issued_on: string | null;
  due_on: string | null;
}

interface DigestRow {
  label: string;
  company_name: string | null;
  on_day: string;
}

export class PostgresPortalLibraryRepository implements PortalLibraryRepository {
  constructor(private readonly app: Db) {}

  async documents(
    tenantId: string,
    clientPartyIds: readonly string[],
    filter: { readonly kind?: string | undefined; readonly limit: number },
  ): Promise<readonly PortalDocumentRow[]> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await db<DocRow[]>`
        SELECT d.id,
               d.title,
               d.kind,
               p.display_name AS company_name,
               v.filename,
               v.byte_size,
               v.media_type,
               v.content_hash,
               ${db.unsafe(isoInstant("d.created_at", "added_on"))},
               -- ── WHAT IT IS ABOUT, IN WORDS ────────────────────────────
               --
               -- One link, resolved to a sentence a person recognises. A
               -- client hunting for "last year's challan" is looking for the
               -- PERIOD, not for a title somebody at the firm typed.
               --
               -- ONLY THE TWO SUBJECT KINDS A CLIENT CAN BE SHOWN: the task
               -- it was filed against, and the invoice it belongs to. There is
               -- deliberately no obligation branch, because there is no such
               -- SUBJECT KIND — 0037's vocabulary is party, lead, proposal,
               -- engagement_letter, engagement, invoice, job and work_item, and
               -- a filing reaches a document through the WORK ITEM the calendar
               -- raised for it. The work item's title already carries the
               -- period ("GSTR-3B — Cobalt Foods — Jul 2026"), which is exactly
               -- what somebody hunting for last year's challan is reading.
               --
               -- The other kinds in that list (proposal, engagement, job, lead)
               -- are the firm's own machinery, and a name for one of those on
               -- this surface would be a label a client cannot act on.
               --
               -- Both joins inherit their own tables' portal policies, so a
               -- document linked to a work item this session cannot see resolves
               -- to NULL rather than to a title — which is the asymmetry falling
               -- out of RLS again, and the right answer.
               coalesce(
                 (SELECT wi.title
                    FROM files.document_link dl
                    JOIN delivery.work_item wi
                      ON wi.id = dl.subject_ref AND wi.tenant_id = dl.tenant_id
                   WHERE dl.document_id = d.id
                     AND dl.tenant_id = d.tenant_id
                     AND dl.subject_kind = 'work_item'
                   LIMIT 1),
                 (SELECT 'Invoice ' || inv.number
                    FROM files.document_link dl
                    JOIN crm.invoice inv
                      ON inv.id = dl.subject_ref AND inv.tenant_id = dl.tenant_id
                   WHERE dl.document_id = d.id
                     AND dl.tenant_id = d.tenant_id
                     AND dl.subject_kind = 'invoice'
                   LIMIT 1)
               ) AS about_what
          FROM files.document d
          -- NOT a LEFT join. A document with no party is the FIRM's own, which
          -- 0063's policy already denies by arithmetic; joining inner says the
          -- same thing a second time in the shape of a query, and it is what
          -- lets companyName be non-null on the row type.
          JOIN core.party p
            ON p.id = d.party_id AND p.tenant_id = d.tenant_id
          -- The LATEST version, and not version 1. On the firm's side a
          -- superseded document is a history; here it is the copy in force, and
          -- handing a client last year's superseded challan because it happened
          -- to be first would be worse than showing them nothing.
          JOIN LATERAL (
            SELECT dv.*
              FROM files.document_version dv
             WHERE dv.document_id = d.id AND dv.tenant_id = d.tenant_id
             ORDER BY dv.version_no DESC
             LIMIT 1
          ) v ON true
         WHERE d.tenant_id = ${tenantId}
           AND (${filter.kind ?? null}::text IS NULL OR d.kind = ${filter.kind ?? null}::text)
         ORDER BY d.created_at DESC
         LIMIT ${filter.limit}
      `;
      return rows.map(toDocumentRow);
    });
  }

  async findVersion(
    tenantId: string,
    clientPartyIds: readonly string[],
    documentId: string,
  ): Promise<DocumentVersion | null> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      // THE LATEST version's row, which NAMES the storage key. The bytes are
      // fetched afterwards by the service, from a blob store that knows nothing
      // about RLS — so this SELECT is the only thing standing between a client
      // and a key, and it is enough precisely because it is a row read under two
      // RESTRICTIVE policies rather than a token handed out.
      const [row] = await db<VersionRow[]>`
        SELECT v.id, v.tenant_id, v.document_id, v.version_no, v.content_hash,
               v.byte_size, v.media_type, v.filename, v.storage_key,
               v.created_by, ${db.unsafe(isoInstant("v.created_at", "created_at"))}
          FROM files.document_version v
          -- The join to the parent is NOT decoration and not for a column: it is
          -- what makes document_portal_scope apply. The version's own policy
          -- is an EXISTS on this row, so both are asked either way — this makes
          -- it visible to somebody reading the query.
          JOIN files.document d
            ON d.id = v.document_id AND d.tenant_id = v.tenant_id
         WHERE v.document_id = ${documentId}
           AND v.tenant_id = ${tenantId}
         ORDER BY v.version_no DESC
         LIMIT 1
      `;
      return row ? toVersion(row) : null;
    });
  }

  async invoices(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalInvoiceRow[]> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      const rows = await db<InvoiceRow[]>`
        SELECT i.id,
               i.number,
               issuer.display_name AS issued_by,
               billed.display_name AS billed_to,
               i.status,
               i.currency,
               -- coalesce because an invoice with no lines has no row in
               -- invoice_totals at all, and "no lines" must read as zero
               -- rather than as null on a client's screen.
               coalesce(b.invoiced, 0)::text    AS total,
               coalesce(b.paid, 0)::text        AS paid,
               coalesce(b.credited, 0)::text    AS credited,
               coalesce(b.outstanding, 0)::text AS outstanding,
               i.issued_on::text AS issued_on,
               i.due_on::text    AS due_on
          FROM crm.invoice i
          JOIN crm.invoice_balance b
            ON b.invoice_id = i.id AND b.tenant_id = i.tenant_id
          -- NAME TABLES ARE NOT SCOPED BY WHAT THEY NAME (0059's rule): neither
          -- of these joins gets a policy. crm.portal_sees on core.party
          -- would blank the company on a row the reader is already allowed to
          -- see — T4.5's blank-space bug, on purpose.
          JOIN core.party issuer
            ON issuer.id = i.entity_party_id AND issuer.tenant_id = i.tenant_id
          JOIN core.party billed
            ON billed.id = i.party_id AND billed.tenant_id = i.tenant_id
         WHERE i.tenant_id = ${tenantId}
         ORDER BY i.issued_on DESC NULLS LAST, i.number DESC
      `;
      return rows.map(toInvoiceRow);
    });
  }

  async digest(
    tenantId: string,
    clientPartyIds: readonly string[],
    range: { readonly from: string; readonly to: string },
    timeZone: string,
  ): Promise<Omit<PortalDigest, "month">> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      // HALF-OPEN, `[from, to)`, in four places. `>= from AND < to` and never
      // `BETWEEN`: `BETWEEN` is inclusive at both ends, so the 1st of the next
      // month would appear in this month's digest and again in the next one's.
      const filed = await db<DigestRow[]>`
        SELECT t.name || ' · ' || oi.period_label AS label,
               ent.display_name AS company_name,
               oi.filed_on::text AS on_day
          FROM delivery.obligation_instance oi
          JOIN delivery.obligation_template t
            ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
          JOIN core.party ent
            ON ent.id = oi.entity_party_id AND ent.tenant_id = oi.tenant_id
         WHERE oi.tenant_id = ${tenantId}
           -- KEYED ON filed_on, NEVER ON THE STATE BEING TERMINAL. 0052 seeds
           -- two terminal states and T3.3's resolved is the end of a deadline
           -- already MISSED — calling that "filed" is a false statement about a
           -- statutory return, which 0054 made once and T6.5 caught again.
           AND oi.filed_on >= ${range.from}::date
           AND oi.filed_on <  ${range.to}::date
         ORDER BY oi.filed_on ASC
      `;

      const documentsAdded = await db<DigestRow[]>`
        SELECT d.title AS label,
               p.display_name AS company_name,
               -- The firm's day, not the server's. Written inline rather than
               -- through instant.ts helpers because the zone is a PARAMETER
               -- here, and those build static SQL.
               (d.created_at AT TIME ZONE ${timeZone}::text)::date::text AS on_day
          FROM files.document d
          JOIN core.party p ON p.id = d.party_id AND p.tenant_id = d.tenant_id
         WHERE d.tenant_id = ${tenantId}
           AND d.created_at >= ${range.from}::date::timestamp AT TIME ZONE ${timeZone}::text
           AND d.created_at <  ${range.to}::date::timestamp AT TIME ZONE ${timeZone}::text
         ORDER BY d.created_at ASC
      `;

      const invoiced = await db<DigestRow[]>`
        SELECT i.number AS label,
               billed.display_name AS company_name,
               i.issued_on::text AS on_day
          FROM crm.invoice i
          JOIN core.party billed
            ON billed.id = i.party_id AND billed.tenant_id = i.tenant_id
         WHERE i.tenant_id = ${tenantId}
           AND i.issued_on >= ${range.from}::date
           AND i.issued_on <  ${range.to}::date
         ORDER BY i.issued_on ASC
      `;

      // WHAT THE CLIENT THEMSELVES DID, and it is here deliberately: a digest
      // that only listed the firm's own output would read as an invoice for
      // attention. `first_answered_at` and not the response date, because this
      // line is "you replied in March" and a second file sent in April does not
      // move that.
      const asksAnswered = await db<DigestRow[]>`
        SELECT a.prompt AS label,
               ent.display_name AS company_name,
               (a.first_answered_at AT TIME ZONE ${timeZone}::text)::date::text AS on_day
          FROM delivery.client_ask a
          JOIN delivery.work_item wi
            ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
          LEFT JOIN core.party ent
            ON ent.id = wi.entity_party_id AND ent.tenant_id = wi.tenant_id
         WHERE a.tenant_id = ${tenantId}
           AND a.first_answered_at IS NOT NULL
           AND a.first_answered_at >= ${range.from}::date::timestamp AT TIME ZONE ${timeZone}::text
           AND a.first_answered_at <  ${range.to}::date::timestamp AT TIME ZONE ${timeZone}::text
         ORDER BY a.first_answered_at ASC
      `;

      return {
        filed: filed.map(toDigestRow),
        documentsAdded: documentsAdded.map(toDigestRow),
        invoiced: invoiced.map(toDigestRow),
        asksAnswered: asksAnswered.map(toDigestRow),
      };
    });
  }
}

function toDocumentRow(r: DocRow): PortalDocumentRow {
  return {
    documentId: r.id,
    title: r.title,
    // The CHECK in 0037 (widened by 0063) is what guarantees this, so it is a
    // widening cast at a door the database already guards.
    kind: r.kind as DocumentKind,
    companyName: r.company_name,
    filename: r.filename,
    // `bigint` arrives as a string from postgres.js. Number() here and not on
    // the wire, because a byte size is a count and not money.
    byteSize: Number(r.byte_size),
    mediaType: r.media_type,
    contentHash: r.content_hash,
    addedOn: r.added_on,
    aboutWhat: r.about_what,
  };
}

function toVersion(r: VersionRow): DocumentVersion {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    documentId: r.document_id,
    versionNo: r.version_no,
    contentHash: r.content_hash,
    byteSize: Number(r.byte_size),
    mediaType: r.media_type,
    filename: r.filename,
    storageKey: r.storage_key,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toInvoiceRow(r: InvoiceRow): PortalInvoiceRow {
  return {
    invoiceId: r.id,
    number: r.number,
    issuedBy: r.issued_by,
    billedTo: r.billed_to,
    // `invoice_portal_scope` (0066) is what narrows this to two members — a
    // draft cannot reach this reader. The cast is at a door the policy guards.
    status: r.status as "issued" | "cancelled",
    currency: r.currency,
    total: r.total,
    paid: r.paid,
    credited: r.credited,
    outstanding: r.outstanding,
    issuedOn: r.issued_on,
    dueOn: r.due_on,
  };
}

function toDigestRow(r: DigestRow): PortalDigestRow {
  return { label: r.label, companyName: r.company_name, on: r.on_day };
}
