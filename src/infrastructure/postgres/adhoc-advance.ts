// The ad-hoc advance's reads and writes (0363, Q044-Q048). The money is the
// pool's (`crm.advance_pool`): an advance's net, credits, what its allocations
// hold and what bills took from them are DERIVED there, never stored here.
//
// EVERY WRITE THAT MOVES MONEY TAKES THE ADVANCE'S LOCK, the one the raise of a
// bill takes (`pg_advisory_xact_lock(hashtext('advance:<invoice id>'))`), and
// re-reads what is left under it. So a map and a raise of a bill spending the
// same money queue; the second reads what the first left.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { MAX_LIST_ROWS } from "../../db/limits";
import type { Invoice } from "../../domain/invoice/model";
import type { NewInvoice, NewInvoiceLine } from "../../usecase/invoice/ports";
import type {
  AdhocAdvanceFilters,
  AdhocAdvanceRecord,
  AdhocAdvanceStore,
  AdhocAllocationRecord,
  AllocationTargetFacts,
  ClientServiceForAdvance,
  EndOutcome,
  LetterOwingMaps,
  MapOutcome,
  NewAdhocAdvance,
  NewAllocation,
  PersonRef,
} from "../../usecase/billing/ports";
import { isoInstant } from "./instant";
import { insertDraftInvoice, insertInvoiceLine } from "./invoice-repository";

function person(id: string | null, name: string | null, email: string | null): PersonRef | null {
  return id === null || email === null ? null : { userId: id, displayName: name, email };
}

async function lockAdvance(db: Db, invoiceId: string): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtext(${`advance:${invoiceId}`}))`;
}

interface AdvanceRow {
  id: string;
  currency: string;
  note: string | null;
  raised_at: string;
  raised_by_id: string | null;
  raised_by_name: string | null;
  raised_by_email: string | null;
  invoice_id: string;
  invoice_number: string | null;
  invoice_status: "draft" | "issued" | "cancelled";
  issued_on: string | null;
  party_id: string;
  party_name: string;
  issuer_id: string;
  issuer_name: string;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  net: string;
  total: string;
  credited: string;
  mapped: string;
  unmapped: string | null;
  refund_amount: string | null;
  paid: string;
  outstanding: string;
}

interface AllocationRow {
  id: string;
  adhoc_advance_id: string;
  engagement_id: string | null;
  job_id: string | null;
  job_label: string | null;
  engagement_letter_id: string | null;
  service_name: string | null;
  service_letter_ref: string | null;
  engagement_status: string | null;
  target_letter_ref: string | null;
  amount: string;
  effective: string;
  taken: string;
  left_amount: string;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  how: "by_hand" | "letter_signed";
  reason: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: string;
  ended_at: string | null;
  ended_by_id: string | null;
  ended_by_name: string | null;
  ended_by_email: string | null;
  end_reason: string | null;
  kept_amount: string | null;
}

/** What bills took from each allocation, counted as the pool counts it. */
const TAKEN_SQL = `
  SELECT b.advance_allocation_id, b.tenant_id, sum(b.advance_applied) AS taken
    FROM crm.billing_due b
    LEFT JOIN crm.invoice bi ON bi.id = b.invoice_id AND bi.tenant_id = b.tenant_id
   WHERE b.advance_allocation_id IS NOT NULL
     AND b.skipped_at IS NULL
     AND (b.covered_at IS NOT NULL OR bi.status IN ('draft', 'issued'))
   GROUP BY b.advance_allocation_id, b.tenant_id
`;

export class PostgresAdhocAdvanceStore implements AdhocAdvanceStore {
  constructor(private readonly app: Db) {}

  async raiseAtomically(
    tenantId: string,
    plan: { readonly draft: NewInvoice; readonly line: NewInvoiceLine; readonly advance: NewAdhocAdvance },
  ): Promise<Invoice> {
    return withTenant(this.app, tenantId, async (db) => {
      const invoice = await insertDraftInvoice(db, plan.draft);
      await insertInvoiceLine(db, plan.line);
      const a = plan.advance;
      await db`
        INSERT INTO crm.adhoc_advance (id, tenant_id, invoice_id, currency, note, raised_by_user_id)
        VALUES (${a.id}, ${a.tenantId}, ${invoice.id}, ${invoice.currency}, ${a.note}, ${a.raisedByUserId})
      `;
      return invoice;
    });
  }

  async list(tenantId: string, filters: AdhocAdvanceFilters): Promise<readonly AdhocAdvanceRecord[]> {
    const status = filters.status ?? "open";
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<AdvanceRow[]>`
        SELECT aa.id, aa.currency, aa.note,
               ${db.unsafe(isoInstant("aa.raised_at", "raised_at"))},
               aa.raised_by_user_id AS raised_by_id, ru.display_name AS raised_by_name, ru.email::text AS raised_by_email,
               i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status,
               i.issued_on::text AS issued_on,
               i.party_id, p.display_name AS party_name,
               i.entity_party_id AS issuer_id, ep.display_name AS issuer_name,
               i.manager_user_id AS manager_id, mu.display_name AS manager_name, mu.email::text AS manager_email,
               round(t.net, 2)::text AS net, round(t.total, 2)::text AS total,
               round(coalesce(cr.credited, 0), 2)::text AS credited,
               round(coalesce(m.mapped, 0), 2)::text AS mapped,
               CASE WHEN i.status = 'issued' THEN un.remaining::text END AS unmapped,
               CASE WHEN i.status = 'issued' AND un.remaining > 0
                    THEN round(least(un.remaining * t.total / nullif(t.net, 0), t.total - coalesce(cr.credited, 0)), 2)::text
               END AS refund_amount,
               round(coalesce(b.paid, 0), 2)::text AS paid,
               round(coalesce(b.outstanding, 0), 2)::text AS outstanding
          FROM crm.adhoc_advance aa
          JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id
          JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
          JOIN core.party p  ON p.id = i.party_id AND p.tenant_id = i.tenant_id
          JOIN core.party ep ON ep.id = i.entity_party_id AND ep.tenant_id = i.tenant_id
          LEFT JOIN tenancy.user_account ru ON ru.id = aa.raised_by_user_id
          LEFT JOIN tenancy.user_account mu ON mu.id = i.manager_user_id
          LEFT JOIN crm.advance_pool un
            ON un.adhoc_advance_id = aa.id AND un.tenant_id = aa.tenant_id AND un.source = 'unmapped'
          LEFT JOIN (
            SELECT al.adhoc_advance_id, al.tenant_id, sum(coalesce(al.kept_amount, al.amount)) AS mapped
              FROM crm.advance_allocation al
             GROUP BY al.adhoc_advance_id, al.tenant_id
          ) m ON m.adhoc_advance_id = aa.id AND m.tenant_id = aa.tenant_id
          LEFT JOIN (
            SELECT cn.invoice_id, cn.tenant_id, sum(cn.amount) AS credited
              FROM crm.credit_note cn GROUP BY cn.invoice_id, cn.tenant_id
          ) cr ON cr.invoice_id = i.id AND cr.tenant_id = i.tenant_id
          LEFT JOIN crm.invoice_balance b ON b.invoice_id = i.id AND b.tenant_id = i.tenant_id
         WHERE true
           ${filters.advanceId === undefined ? db`` : db`AND aa.id = ${filters.advanceId}`}
           ${filters.partyId === undefined ? db`` : db`AND i.party_id = ${filters.partyId}`}
           ${status === "open" ? db`AND (i.status = 'draft' OR (i.status = 'issued' AND un.remaining > 0))` : db``}
         ORDER BY aa.raised_at DESC, aa.id
         LIMIT ${MAX_LIST_ROWS}
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const allocations = await db<AllocationRow[]>`
        SELECT al.id, al.adhoc_advance_id, al.engagement_id, al.job_id, j.period_label AS job_label,
               al.engagement_letter_id,
               ll.description AS service_name, sl.ref AS service_letter_ref, e.status AS engagement_status,
               tl.ref AS target_letter_ref,
               al.amount::text AS amount,
               coalesce(al.kept_amount, al.amount)::text AS effective,
               round(coalesce(tk.taken, 0), 2)::text AS taken,
               round(coalesce(al.kept_amount, al.amount) - coalesce(tk.taken, 0), 2)::text AS left_amount,
               al.manager_user_id AS manager_id, mu.display_name AS manager_name, mu.email::text AS manager_email,
               al.how, al.reason,
               al.created_by_user_id AS created_by_id, cu.display_name AS created_by_name,
               cu.email::text AS created_by_email,
               ${db.unsafe(isoInstant("al.created_at", "created_at"))},
               ${db.unsafe(isoInstant("al.ended_at", "ended_at"))},
               al.ended_by_user_id AS ended_by_id, eu.display_name AS ended_by_name, eu.email::text AS ended_by_email,
               al.end_reason, al.kept_amount::text AS kept_amount
          FROM crm.advance_allocation al
          LEFT JOIN crm.engagement e ON e.id = al.engagement_id AND e.tenant_id = al.tenant_id
          LEFT JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          LEFT JOIN crm.engagement_letter sl ON sl.id = e.engagement_letter_id AND sl.tenant_id = e.tenant_id
          LEFT JOIN crm.engagement_letter tl ON tl.id = al.engagement_letter_id AND tl.tenant_id = al.tenant_id
          LEFT JOIN delivery.job j ON j.id = al.job_id AND j.tenant_id = al.tenant_id
          LEFT JOIN (${db.unsafe(TAKEN_SQL)}) tk ON tk.advance_allocation_id = al.id AND tk.tenant_id = al.tenant_id
          LEFT JOIN tenancy.user_account mu ON mu.id = al.manager_user_id
          LEFT JOIN tenancy.user_account cu ON cu.id = al.created_by_user_id
          LEFT JOIN tenancy.user_account eu ON eu.id = al.ended_by_user_id
         WHERE al.adhoc_advance_id = ANY(${ids}::uuid[])
         ORDER BY al.created_at, al.id
      `;
      const named = await db<{ adhoc_advance_id: string; letter_id: string; ref: string; status: string; amount: string }[]>`
        SELECT na.adhoc_advance_id, l.id AS letter_id, l.ref, l.status, na.amount::text AS amount
          FROM crm.engagement_letter_advance na
          JOIN crm.engagement_letter l ON l.id = na.engagement_letter_id AND l.tenant_id = na.tenant_id
         WHERE na.adhoc_advance_id = ANY(${ids}::uuid[])
           AND l.deleted_at IS NULL
         ORDER BY l.created_at
      `;
      return rows.map((r) => ({
        id: r.id,
        party: { id: r.party_id, displayName: r.party_name },
        issuer: { id: r.issuer_id, displayName: r.issuer_name },
        currency: r.currency,
        note: r.note,
        raisedBy: person(r.raised_by_id, r.raised_by_name, r.raised_by_email),
        raisedAt: r.raised_at,
        manager: person(r.manager_id, r.manager_name, r.manager_email),
        invoice: { id: r.invoice_id, number: r.invoice_number, status: r.invoice_status, issuedOn: r.issued_on },
        net: r.net,
        total: r.total,
        credited: r.credited,
        mapped: r.mapped,
        unmapped: r.unmapped,
        refundAmount: r.refund_amount,
        paid: r.paid,
        outstanding: r.outstanding,
        allocations: allocations.filter((a) => a.adhoc_advance_id === r.id).map(toAllocation),
        namedOn: named
          .filter((n) => n.adhoc_advance_id === r.id)
          .map((n) => ({ letterId: n.letter_id, ref: n.ref, status: n.status, amount: n.amount })),
      }));
    });
  }

  async targets(tenantId: string, engagementIds: readonly string[]): Promise<readonly AllocationTargetFacts[]> {
    if (engagementIds.length === 0) return [];
    return this.serviceFacts(tenantId, { engagementIds });
  }

  async servicesOf(tenantId: string, partyId: string): Promise<readonly ClientServiceForAdvance[]> {
    const services = await this.serviceFacts(tenantId, { partyId });
    if (services.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const jobs = await db<{ id: string; engagement_id: string; label: string | null; status: string }[]>`
        SELECT j.id, j.source_ref AS engagement_id, j.period_label AS label, j.status
          FROM delivery.job j
         WHERE j.source_kind IN ('engagement', 'engagement_period')
           AND j.source_ref = ANY(${services.map((s) => s.engagementId)}::uuid[])
         ORDER BY j.period_start NULLS FIRST, j.created_at
      `;
      return services.map((s) => ({
        ...s,
        jobs: jobs
          .filter((j) => j.engagement_id === s.engagementId)
          .map((j) => ({ id: j.id, label: j.label, status: j.status })),
      }));
    });
  }

  private async serviceFacts(
    tenantId: string,
    by: { readonly engagementIds?: readonly string[]; readonly partyId?: string },
  ): Promise<readonly AllocationTargetFacts[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{
        engagement_id: string;
        party_id: string;
        issuer_id: string;
        issuer_name: string;
        currency: string;
        status: string;
        letter_id: string;
        letter_ref: string;
        service_name: string;
        dept_code: string | null;
      }[]>`
        SELECT e.id AS engagement_id, e.party_id, l.issuing_entity_party_id AS issuer_id,
               ip.display_name AS issuer_name, upper(ll.currency) AS currency, e.status,
               l.id AS letter_id, l.ref AS letter_ref, ll.description AS service_name,
               live.body ->> 'module' AS dept_code
          FROM crm.engagement e
          JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
          JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          JOIN core.party ip ON ip.id = l.issuing_entity_party_id AND ip.tenant_id = l.tenant_id
          LEFT JOIN config.version pinned ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
          LEFT JOIN config.version live
            ON live.entry_id = pinned.entry_id AND live.tenant_id = pinned.tenant_id AND live.status = 'published'
         WHERE ${
           by.engagementIds !== undefined
             ? db`e.id = ANY(${[...by.engagementIds]}::uuid[])`
             : db`e.party_id = ${by.partyId ?? null}`
         }
         ORDER BY l.ref, ll.position
      `;
      return rows.map((r) => ({
        engagementId: r.engagement_id,
        partyId: r.party_id,
        issuerId: r.issuer_id,
        issuerName: r.issuer_name,
        currency: r.currency,
        status: r.status,
        letterId: r.letter_id,
        letterRef: r.letter_ref,
        serviceName: r.service_name,
        deptCode: r.dept_code,
      }));
    });
  }

  async jobs(
    tenantId: string,
    jobIds: readonly string[],
  ): Promise<readonly { readonly jobId: string; readonly engagementId: string | null; readonly label: string | null }[]> {
    if (jobIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string; engagement_id: string | null; label: string | null }[]>`
        SELECT j.id,
               CASE WHEN j.source_kind IN ('engagement', 'engagement_period') THEN j.source_ref END AS engagement_id,
               j.period_label AS label
          FROM delivery.job j
         WHERE j.id = ANY(${[...jobIds]}::uuid[])
      `;
      return rows.map((r) => ({ jobId: r.id, engagementId: r.engagement_id, label: r.label }));
    });
  }

  async map(
    tenantId: string,
    advanceId: string,
    rows: readonly NewAllocation[],
    options: { readonly clip?: boolean | undefined } = {},
  ): Promise<MapOutcome> {
    return withTenant(this.app, tenantId, async (db) => {
      const [adv] = await db<{ invoice_id: string; currency: string; status: string }[]>`
        SELECT aa.invoice_id, aa.currency, i.status
          FROM crm.adhoc_advance aa
          JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id
         WHERE aa.id = ${advanceId}
      `;
      if (adv === undefined) return { notIssued: "missing" };
      await lockAdvance(db, adv.invoice_id);
      // Read again under the lock: the status, and what is left.
      const [now] = await db<{ status: string; unmapped: string | null }[]>`
        SELECT i.status, un.remaining::text AS unmapped
          FROM crm.invoice i
          LEFT JOIN crm.advance_pool un ON un.adhoc_advance_id = ${advanceId} AND un.source = 'unmapped'
         WHERE i.id = ${adv.invoice_id}
      `;
      if (now === undefined || now.status !== "issued" || now.unmapped === null) {
        return { notIssued: now?.status ?? adv.status };
      }
      const [fit] = await db<{ asked: string; fits: boolean }[]>`
        SELECT sum(x.amount)::text AS asked, sum(x.amount) <= ${now.unmapped}::numeric AS fits
          FROM unnest(${rows.map((r) => r.amount)}::numeric[]) AS x(amount)
      `;
      const written: { id: string; amount: string }[] = [];
      if (options.clip === true) {
        // A letter's own mapping: one row, at most what is left.
        const [row] = rows;
        if (row === undefined) return { written };
        const [clipped] = await db<{ amount: string | null }[]>`
          SELECT CASE WHEN ${now.unmapped}::numeric > 0
                      THEN least(${row.amount}::numeric, ${now.unmapped}::numeric)::text END AS amount
        `;
        const clippedAmount = clipped?.amount ?? null;
        if (clippedAmount === null) return { written };
        const inserted = await insertAllocation(db, tenantId, advanceId, adv.invoice_id, adv.currency, row, clippedAmount);
        if (inserted) written.push({ id: row.id, amount: clippedAmount });
        return { written };
      }
      if (fit === undefined || !fit.fits) return { over: { asked: fit?.asked ?? "0", unmapped: now.unmapped } };
      for (const row of rows) {
        await insertAllocation(db, tenantId, advanceId, adv.invoice_id, adv.currency, row, row.amount);
        written.push({ id: row.id, amount: row.amount });
      }
      return { written };
    });
  }

  async end(
    tenantId: string,
    advanceId: string,
    allocationId: string,
    input: { readonly byUserId: string | null; readonly reason: string },
  ): Promise<EndOutcome | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [al] = await db<{ invoice_id: string }[]>`
        SELECT invoice_id FROM crm.advance_allocation WHERE id = ${allocationId} AND adhoc_advance_id = ${advanceId}
      `;
      if (al === undefined) return null;
      await lockAdvance(db, al.invoice_id);
      const [row] = await db<{ ended: boolean; amount: string; taken: string }[]>`
        SELECT al.ended_at IS NOT NULL AS ended, al.amount::text AS amount,
               least(coalesce(tk.taken, 0), al.amount)::text AS taken
          FROM crm.advance_allocation al
          LEFT JOIN (${db.unsafe(TAKEN_SQL)}) tk ON tk.advance_allocation_id = al.id AND tk.tenant_id = al.tenant_id
         WHERE al.id = ${allocationId}
           FOR UPDATE OF al
      `;
      if (row === undefined) return null;
      if (row.ended) return { alreadyEnded: true };
      const [freed] = await db<{ freed: string; any: boolean }[]>`
        SELECT (${row.amount}::numeric - ${row.taken}::numeric)::text AS freed,
               ${row.amount}::numeric - ${row.taken}::numeric > 0 AS any
      `;
      if (freed === undefined || !freed.any) return { usedUp: true };
      await db`
        UPDATE crm.advance_allocation
           SET ended_at = now(), ended_by_user_id = ${input.byUserId},
               end_reason = ${input.reason}, kept_amount = ${row.taken}::numeric
         WHERE id = ${allocationId} AND ended_at IS NULL
      `;
      return { ended: { kept: row.taken, freed: freed.freed } };
    });
  }

  async namedOn(
    tenantId: string,
    letterId: string,
  ): Promise<readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ adhoc_advance_id: string; amount: string; currency: string }[]>`
        SELECT adhoc_advance_id, amount::text AS amount, currency
          FROM crm.engagement_letter_advance
         WHERE engagement_letter_id = ${letterId}
         ORDER BY created_at, adhoc_advance_id
      `;
      return rows.map((r) => ({ adhocAdvanceId: r.adhoc_advance_id, amount: r.amount, currency: r.currency }));
    });
  }

  async setNamed(
    tenantId: string,
    letterId: string,
    rows: readonly { readonly adhocAdvanceId: string; readonly amount: string; readonly currency: string }[],
  ): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`DELETE FROM crm.engagement_letter_advance WHERE engagement_letter_id = ${letterId}`;
      for (const r of rows) {
        await db`
          INSERT INTO crm.engagement_letter_advance (tenant_id, engagement_letter_id, adhoc_advance_id, currency, amount)
          VALUES (${tenantId}, ${letterId}, ${r.adhocAdvanceId}, ${r.currency}, ${r.amount}::numeric)
        `;
      }
    });
  }

  async letterFacts(
    tenantId: string,
    letterId: string,
  ): Promise<{ readonly partyId: string; readonly issuerId: string; readonly currency: string; readonly status: string; readonly ref: string } | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [r] = await db<{ party_id: string; issuer_id: string; currency: string; status: string; ref: string }[]>`
        SELECT party_id, issuing_entity_party_id AS issuer_id, currency, status, ref
          FROM crm.engagement_letter
         WHERE id = ${letterId} AND deleted_at IS NULL
      `;
      return r === undefined
        ? null
        : { partyId: r.party_id, issuerId: r.issuer_id, currency: r.currency, status: r.status, ref: r.ref };
    });
  }

  async lettersOwingMaps(tenantId: string, letterId?: string): Promise<readonly LetterOwingMaps[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{
        letter_id: string;
        ref: string;
        party_id: string;
        signed_on: string;
        adhoc_advance_id: string;
        amount: string;
      }[]>`
        SELECT l.id AS letter_id, l.ref, l.party_id,
               (l.signed_at AT TIME ZONE crm.issuer_zone(l.tenant_id, l.issuing_entity_party_id))::date::text AS signed_on,
               na.adhoc_advance_id, na.amount::text AS amount
          FROM crm.engagement_letter_advance na
          JOIN crm.engagement_letter l ON l.id = na.engagement_letter_id AND l.tenant_id = na.tenant_id
         WHERE l.status = 'signed'
           ${letterId === undefined ? db`` : db`AND l.id = ${letterId}`}
           AND NOT EXISTS (
             SELECT 1 FROM crm.advance_allocation al
              WHERE al.tenant_id = na.tenant_id AND al.how = 'letter_signed'
                AND al.adhoc_advance_id = na.adhoc_advance_id AND al.engagement_letter_id = l.id)
         ORDER BY l.signed_at, l.id, na.created_at
         LIMIT ${MAX_LIST_ROWS}
      `;
      const out = new Map<string, { letterId: string; letterRef: string; partyId: string; signedOn: string; named: { adhocAdvanceId: string; amount: string }[] }>();
      for (const r of rows) {
        const hit = out.get(r.letter_id) ?? {
          letterId: r.letter_id,
          letterRef: r.ref,
          partyId: r.party_id,
          signedOn: r.signed_on,
          named: [],
        };
        hit.named.push({ adhocAdvanceId: r.adhoc_advance_id, amount: r.amount });
        out.set(r.letter_id, hit);
      }
      return [...out.values()];
    });
  }
}

async function insertAllocation(
  db: Db,
  tenantId: string,
  advanceId: string,
  invoiceId: string,
  currency: string,
  row: NewAllocation,
  amount: string,
): Promise<boolean> {
  const inserted = await db<{ id: string }[]>`
    INSERT INTO crm.advance_allocation
      (id, tenant_id, adhoc_advance_id, invoice_id, currency, engagement_id, job_id, engagement_letter_id,
       amount, manager_user_id, how, reason, created_by_user_id)
    VALUES (${row.id}, ${tenantId}, ${advanceId}, ${invoiceId}, ${currency}, ${row.engagementId}, ${row.jobId},
            ${row.engagementLetterId}, ${amount}::numeric, ${row.managerUserId}, ${row.how}, ${row.reason},
            ${row.createdByUserId})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return inserted.length === 1;
}

function toAllocation(a: AllocationRow): AdhocAllocationRecord {
  return {
    id: a.id,
    target:
      a.engagement_id !== null
        ? {
            kind: "service",
            engagementId: a.engagement_id,
            serviceName: a.service_name ?? "",
            letterRef: a.service_letter_ref ?? "",
            engagementStatus: a.engagement_status ?? "",
            job: a.job_id === null ? null : { id: a.job_id, label: a.job_label },
          }
        : { kind: "letter", letterId: a.engagement_letter_id ?? "", letterRef: a.target_letter_ref ?? "" },
    amount: a.amount,
    effective: a.effective,
    taken: a.taken,
    left: a.left_amount,
    manager: person(a.manager_id, a.manager_name, a.manager_email),
    how: a.how,
    reason: a.reason,
    createdBy: person(a.created_by_id, a.created_by_name, a.created_by_email),
    createdAt: a.created_at,
    ended:
      a.ended_at === null || a.end_reason === null || a.kept_amount === null
        ? null
        : {
            at: a.ended_at,
            by: person(a.ended_by_id, a.ended_by_name, a.ended_by_email),
            reason: a.end_reason,
            kept: a.kept_amount,
          },
  };
}
