// The billing desk's reads and writes (auto-invoice, phase 1, 0318): the dues
// as a screen shows them, the three ways a person settles one, an
// engagement's schedule, and the firm's switch.
//
// STATUS IS DERIVED, IN THE QUERY. A skip is final; a due on an invoice that
// was cancelled is OPEN again (the bill was never made); otherwise drafted or
// billed by the invoice's own status. A stored status would be a cache of the
// invoice's, and would drift the first time somebody cancelled one.
//
// EVERY SETTLING WRITE CARRIES "STILL OPEN" IN ITS WHERE, so two people
// working one list cannot both settle a due: the second write finds nothing
// and the use case says so. Under READ COMMITTED an UPDATE waiting on the
// first re-checks the row it waited for, which is the row this condition
// reads.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { MAX_LIST_ROWS } from "../../db/limits";
import type {
  AdvanceRecord,
  AutoBillingSetting,
  BillingDueDesk,
  BillingDueRecord,
  BillingSchedules,
  ClaimToken,
  RaisePlan,
  RaiseWritten,
  DueFilters,
  DueStatus,
  PersonRef,
  RefundCandidate,
  ScheduleRecord,
} from "../../usecase/billing/ports";
import { isoInstant } from "./instant";
import { insertDraftInvoice, insertInvoiceLine } from "./invoice-repository";
import type { Invoice } from "../../domain/invoice/model";
import { BILLING_TIMINGS, type BillingTiming } from "../../domain/billing/model";
import { BILL_KINDS, type BillKind } from "../../domain/billing/advance";

interface DueRow {
  id: string;
  kind: string;
  engagement_letter_id: string | null;
  party_id: string;
  party_name: string;
  issuer_id: string;
  issuer_name: string;
  currency: string;
  engagement_id: string | null;
  fee_group_id: string | null;
  engagement_ids: string[];
  service_name: string;
  dept_codes: string[];
  entity_name: string | null;
  letter_id: string;
  letter_ref: string;
  fx_rate: string;
  fx_rate_date: string;
  period_start: string;
  period_end: string;
  period_label: string;
  bill_on: string;
  full_amount: string | null;
  amount: string | null;
  served_days: number;
  period_days: number;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  manager_how: string;
  manager_note: string | null;
  boss_id: string | null;
  boss_name: string | null;
  boss_email: string | null;
  status: DueStatus;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  skipped_at: string | null;
  skipped_by_id: string | null;
  skipped_by_name: string | null;
  skipped_by_email: string | null;
  skip_reason: string | null;
  last_tax_percent: string | null;
  advance_invoice_id: string | null;
  advance_invoice_number: string | null;
  advance_applied: string | null;
  pool_advance_due_id: string | null;
  pool_invoice_id: string | null;
  pool_invoice_number: string | null;
  pool_remaining: string | null;
  advance_holds_work: boolean;
}

function person(id: string | null, name: string | null, email: string | null): PersonRef | null {
  return id === null || email === null ? null : { userId: id, displayName: name, email };
}

function toRecord(r: DueRow): BillingDueRecord {
  return {
    id: r.id,
    kind: BILL_KINDS.find((k) => k === r.kind) ?? ("period" satisfies BillKind),
    engagementLetterId: r.engagement_letter_id,
    party: { id: r.party_id, displayName: r.party_name },
    issuer: { id: r.issuer_id, displayName: r.issuer_name },
    currency: r.currency,
    engagementId: r.engagement_id,
    feeGroupId: r.fee_group_id,
    engagementIds: r.engagement_ids,
    serviceName: r.service_name,
    deptCodes: r.dept_codes,
    entityName: r.entity_name,
    letter: { id: r.letter_id, ref: r.letter_ref, fxRate: r.fx_rate, fxRateDate: r.fx_rate_date },
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    billOn: r.bill_on,
    fullAmount: r.full_amount,
    amount: r.amount,
    servedDays: r.served_days,
    periodDays: r.period_days,
    manager: person(r.manager_id, r.manager_name, r.manager_email),
    managerHow: r.manager_how,
    managerNote: r.manager_note,
    managerReportsTo: person(r.boss_id, r.boss_name, r.boss_email),
    status: r.status,
    invoice:
      r.invoice_id === null || r.invoice_status === null
        ? null
        : { id: r.invoice_id, number: r.invoice_number, status: r.invoice_status },
    skipped:
      r.skipped_at === null || r.skip_reason === null
        ? null
        : {
            at: r.skipped_at,
            by: person(r.skipped_by_id, r.skipped_by_name, r.skipped_by_email),
            reason: r.skip_reason,
          },
    lastTaxPercent: r.last_tax_percent,
    advancePool:
      r.pool_advance_due_id === null ||
      r.pool_invoice_id === null ||
      r.pool_invoice_number === null ||
      r.pool_remaining === null
        ? null
        : {
            advanceDueId: r.pool_advance_due_id,
            invoiceId: r.pool_invoice_id,
            invoiceNumber: r.pool_invoice_number,
            remaining: r.pool_remaining,
          },
    advanceApplied:
      r.advance_invoice_id === null || r.advance_applied === null
        ? null
        : { invoiceId: r.advance_invoice_id, invoiceNumber: r.advance_invoice_number ?? "", amount: r.advance_applied },
    advanceHoldsWork: r.advance_holds_work,
  };
}

/** The read every desk query shares: one due per row, by name, status derived. */
const DUE_SELECT = `
  SELECT d.id, d.kind, d.engagement_letter_id, d.party_id, p.display_name AS party_name,
         d.issuing_entity_party_id AS issuer_id, ip.display_name AS issuer_name,
         d.currency, d.engagement_id, d.fee_group_id,
         subj.engagement_ids, subj.service_name, subj.dept_codes, subj.entity_name,
         subj.letter_id, subj.letter_ref, subj.fx_rate::text AS fx_rate, subj.fx_rate_date::text AS fx_rate_date,
         d.period_start::text AS period_start, d.period_end::text AS period_end, d.period_label,
         d.bill_on::text AS bill_on, d.full_amount::text AS full_amount, d.amount::text AS amount,
         d.served_days, d.period_days, d.created_at AS bill_created_at,
         d.manager_user_id AS manager_id, mu.display_name AS manager_name, mu.email::text AS manager_email,
         d.manager_how, d.manager_note,
         boss.user_id AS boss_id, bu.display_name AS boss_name, bu.email::text AS boss_email,
         CASE
           WHEN d.skipped_at IS NOT NULL THEN 'skipped'
           -- Paid in full by the advance (0320), while that advance stands.
           WHEN d.covered_at IS NOT NULL AND adv.status = 'issued' THEN 'covered'
           WHEN i.id IS NULL OR i.status = 'cancelled' THEN 'open'
           WHEN i.status = 'draft' THEN 'drafted'
           ELSE 'billed'
         END AS status,
         i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status,
         ${isoInstant("d.skipped_at", "skipped_at")},
         d.skipped_by_user_id AS skipped_by_id, su.display_name AS skipped_by_name,
         su.email::text AS skipped_by_email, d.skip_reason,
         tax.tax_percent::text AS last_tax_percent,
         d.advance_invoice_id, adv.number AS advance_invoice_number, d.advance_applied::text AS advance_applied,
         pool.advance_due_id AS pool_advance_due_id,
         pool.invoice_id AS pool_invoice_id, pool.invoice_number AS pool_invoice_number,
         pool.remaining::text AS pool_remaining,
         -- An advance some engagement still waits on (0321): it may not be
         -- skipped, or that work would never start.
         (d.kind = 'advance' AND EXISTS (
            SELECT 1 FROM crm.engagement we
             WHERE we.tenant_id = d.tenant_id AND we.status = 'pending_advance'
               AND ((d.engagement_id IS NOT NULL AND we.id = d.engagement_id)
                 OR (d.engagement_id IS NULL AND we.engagement_letter_id = d.engagement_letter_id))
         )) AS advance_holds_work
    FROM crm.billing_due d
    JOIN core.party p  ON p.id = d.party_id AND p.tenant_id = d.tenant_id
    JOIN core.party ip ON ip.id = d.issuing_entity_party_id AND ip.tenant_id = d.tenant_id
    LEFT JOIN crm.invoice i ON i.id = d.invoice_id AND i.tenant_id = d.tenant_id
    LEFT JOIN tenancy.user_account mu ON mu.id = d.manager_user_id
    LEFT JOIN tenancy.membership mm
      ON mm.tenant_id = d.tenant_id AND mm.user_id = d.manager_user_id AND mm.audience = 'STAFF'
    LEFT JOIN tenancy.membership boss
      ON boss.tenant_id = d.tenant_id AND boss.user_id = mm.reports_to_user_id
     AND boss.audience = 'STAFF' AND boss.is_active
    LEFT JOIN tenancy.user_account bu ON bu.id = boss.user_id
    LEFT JOIN tenancy.user_account su ON su.id = d.skipped_by_user_id
    LEFT JOIN crm.invoice adv ON adv.id = d.advance_invoice_id AND adv.tenant_id = d.tenant_id
    JOIN LATERAL (
      SELECT array_agg(e.id ORDER BY ll.position, e.id) AS engagement_ids,
             -- WHAT THE CLIENT SIGNED: the letter line's own wording, or the fee
             -- group's title, never the catalogue's name. It is the invoice
             -- line's text, read beside the letter ref the invoice prints. The
             -- letter's own advance covers every service on it (0320).
             CASE WHEN d.fee_group_id IS NOT NULL THEN max(g.title)
                  WHEN d.kind = 'advance' AND d.engagement_id IS NULL THEN 'All services'
                  ELSE max(ll.description) END AS service_name,
             -- The Dept of the work: the LIVE service's module, as the sweep and
             -- the router read it, so a bill with no price finds its SPOC.
             coalesce(array_agg(DISTINCT live.body ->> 'module')
                        FILTER (WHERE live.body ->> 'module' IS NOT NULL), '{}') AS dept_codes,
             CASE WHEN count(DISTINCT e.entity_party_id) = 1 THEN max(ep.display_name) END AS entity_name,
             (array_agg(l.id))[1] AS letter_id,
             max(l.ref) AS letter_ref,
             -- THE RATE OF THE BILL'S CURRENCY (0344): the letter's own for its
             -- main currency, else the letter's rate row for that currency.
             max(CASE WHEN d.currency = l.currency THEN l.fx_rate ELSE r.fx_rate END) AS fx_rate,
             max(CASE WHEN d.currency = l.currency THEN l.fx_rate_date ELSE r.fx_rate_date END) AS fx_rate_date
        FROM crm.engagement e
        JOIN crm.engagement_letter_line ll
          ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
        JOIN crm.engagement_letter l
          ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_fx_rate r
          ON r.engagement_letter_id = l.id AND r.tenant_id = l.tenant_id AND r.currency = d.currency
        JOIN core.party ep ON ep.id = e.entity_party_id AND ep.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_fee_group g
          ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
       WHERE e.tenant_id = d.tenant_id
         AND ((d.engagement_id IS NOT NULL AND e.id = d.engagement_id)
           OR (d.fee_group_id IS NOT NULL AND ll.fee_group_id = d.fee_group_id AND ll.removed_at IS NULL)
           OR (d.kind = 'advance' AND d.engagement_id IS NULL AND e.engagement_letter_id = d.engagement_letter_id))
    ) subj ON true
    -- THE ADVANCE THIS BILL WILL BE TAKEN OFF (0320): the service's own, else
    -- the letter's, in the bill's currency, while some of it is left.
    LEFT JOIN LATERAL (
      SELECT ap.advance_due_id, ap.invoice_id, ap.invoice_number, ap.remaining
        FROM crm.advance_pool ap
       WHERE ap.tenant_id = d.tenant_id
         AND d.kind <> 'advance'
         AND ap.currency = d.currency
         AND ap.remaining > 0
         AND ((ap.engagement_id IS NOT NULL AND ap.engagement_id = d.engagement_id)
           OR (ap.engagement_id IS NULL AND ap.engagement_letter_id = subj.letter_id))
       ORDER BY ap.engagement_id NULLS LAST, ap.invoice_number
       LIMIT 1
    ) pool ON true
    LEFT JOIN LATERAL (
      SELECT il.tax_percent
        FROM crm.invoice_line il
        JOIN crm.invoice ii ON ii.id = il.invoice_id AND ii.tenant_id = il.tenant_id
       WHERE il.tenant_id = d.tenant_id
         AND il.engagement_id = ANY(subj.engagement_ids)
         AND il.removed_at IS NULL
         AND ii.status <> 'cancelled'
       ORDER BY ii.created_at DESC, il.position DESC
       LIMIT 1
    ) tax ON true
`;

export class PostgresBillingDueDesk implements BillingDueDesk {
  constructor(private readonly app: Db) {}

  /**
   * The bills, every filter IN THE QUERY, before the ceiling (review item 14).
   * Pending (open or drafted) unless asked otherwise, oldest first; `all` is
   * history too, NEWEST first, so a ceiling drops the oldest and never today's.
   */
  async list(tenantId: string, filters: DueFilters): Promise<readonly BillingDueRecord[]> {
    const status = filters.status ?? "pending";
    const mine = filters.mine;
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DueRow[]>`
        SELECT * FROM (${db.unsafe(DUE_SELECT)}) due
         WHERE true
           ${
             status === "all"
               ? db``
               : status === "pending"
                 ? db`AND due.status IN ('open', 'drafted')`
                 : db`AND due.status = ${status}`
           }
           ${filters.partyId === undefined ? db`` : db`AND due.party_id = ${filters.partyId}`}
           ${
             mine === undefined
               ? db``
               : db`
           AND due.status IN ('open', 'drafted')
           -- An advance is chased by its own reminders (0322), not as a bill.
           AND due.kind <> 'advance'
           AND (due.manager_id = ${mine.userId}
                OR (due.boss_id = ${mine.userId}
                    AND due.bill_on::date <= ${mine.today}::date - ${mine.escalateAfterDays}::int)
                OR (due.full_amount IS NULL AND due.status = 'open'
                    AND (${mine.isAdmin}::boolean OR EXISTS (
                      SELECT 1
                        FROM crm.client_assignment a
                        JOIN tenancy.service_axis x
                          ON x.id = a.axis_id AND x.tenant_id = a.tenant_id AND x.axis = 'dept'
                        JOIN tenancy.membership m
                          ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
                         AND m.audience = 'STAFF' AND m.is_active
                       WHERE a.user_id = ${mine.userId}
                         AND a.role = 'spoc'
                         AND a.client_party_id = due.party_id
                         AND x.code = ANY(due.dept_codes)
                         AND a.valid_from <= ${mine.today}::date
                         AND (a.valid_to IS NULL OR a.valid_to > ${mine.today}::date)))))`
           }
         ORDER BY ${status === "all" ? db`due.bill_on DESC` : db`due.bill_on`}, due.party_name, due.period_start, due.id
         LIMIT ${MAX_LIST_ROWS}
      `;
      return rows.map(toRecord);
    });
  }

  async findMany(tenantId: string, ids: readonly string[]): Promise<readonly BillingDueRecord[]> {
    if (ids.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<DueRow[]>`
        SELECT * FROM (${db.unsafe(DUE_SELECT)}) due
         WHERE due.id = ANY(${db.array(ids as string[])}::uuid[])
      `;
      return rows.map(toRecord);
    });
  }


  async skip(tenantId: string, dueId: string, byUserId: string | null, reason: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        UPDATE crm.billing_due d
           SET skipped_at = now(), skipped_by_user_id = ${byUserId}, skip_reason = ${reason}
         WHERE d.id = ${dueId}
           AND ${db.unsafe(OPEN_DUE_SQL)}
        RETURNING d.id
      `;
      return rows.length === 1;
    });
  }

  async markInvoiced(
    tenantId: string,
    dueId: string,
    invoiceId: string,
    invoiceLineId: string | null,
    applied: { readonly invoiceId: string; readonly amount: string } | null = null,
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      if (applied !== null && !(await takeFromPool(db, applied))) return false;
      // What the bill was on before, for an advance raised again (below).
      const [before] = await db<{ kind: string; invoice_id: string | null }[]>`
        SELECT kind, invoice_id FROM crm.billing_due WHERE id = ${dueId} FOR UPDATE
      `;
      const rows = await db<{ id: string }[]>`
        UPDATE crm.billing_due d
           SET invoice_id = ${invoiceId}, invoice_line_id = ${invoiceLineId},
               advance_invoice_id = ${applied?.invoiceId ?? null},
               advance_applied = ${applied?.amount ?? null}::numeric,
               covered_at = NULL
         WHERE d.id = ${dueId}
           AND ${db.unsafe(OPEN_DUE_SQL)}
        RETURNING d.id
      `;
      if (rows.length !== 1) return false;
      // AN ADVANCE RAISED AGAIN after its invoice was cancelled (0321): the
      // bills that already took from it move onto the new invoice, in the same
      // transaction. Otherwise the reissued advance started with all of its
      // money again and the same advance came off later bills twice. The old
      // invoice was cancelled (the open check above says so), and the new one
      // is in the same currency (the bill's), which the key checks.
      if (before?.kind === "advance" && before.invoice_id !== null) {
        await db`
          UPDATE crm.billing_due
             SET advance_invoice_id = ${invoiceId}
           WHERE advance_invoice_id = ${before.invoice_id}
        `;
      }
      return true;
    });
  }

  async raiseAtomically(tenantId: string, plan: RaisePlan): Promise<RaiseWritten> {
    return withTenant(this.app, tenantId, async (db) => {
      const covered: string[] = [];
      const conflicts: string[] = [];
      const invoiced: { dueId: string; lineId: string }[] = [];
      for (const c of plan.covered) {
        if (!(await takeFromPool(db, c.applied))) {
          conflicts.push(c.dueId);
          continue;
        }
        const rows = await db<{ id: string }[]>`
          UPDATE crm.billing_due d
             SET covered_at = now(), invoice_id = NULL, invoice_line_id = NULL,
                 advance_invoice_id = ${c.applied.invoiceId}, advance_applied = ${c.applied.amount}::numeric
           WHERE d.id = ${c.dueId}
             AND ${db.unsafe(OPEN_DUE_SQL)}
          RETURNING d.id
        `;
        if (rows.length === 1) covered.push(c.dueId);
        else conflicts.push(c.dueId);
      }

      let invoice: Invoice | null = null;
      for (const item of plan.invoiced) {
        // Checked BEFORE anything is written for it, so a bill that cannot go
        // on the invoice leaves no line behind: its advance still covers what
        // it takes, and it is still open (held, so nobody settles it now).
        if (item.applied !== null && !(await takeFromPool(db, item.applied))) {
          conflicts.push(item.dueId);
          continue;
        }
        const [open] = await db<{ kind: string; invoice_id: string | null }[]>`
          SELECT d.kind, d.invoice_id FROM crm.billing_due d
           WHERE d.id = ${item.dueId} AND ${db.unsafe(OPEN_DUE_SQL)}
             FOR UPDATE OF d
        `;
        if (!open) {
          conflicts.push(item.dueId);
          continue;
        }
        if (invoice === null) {
          if (plan.draft === null) throw new Error("a raise with bills to invoice came with no draft");
          invoice = await insertDraftInvoice(db, plan.draft);
        }
        const line = await insertInvoiceLine(db, item.line);
        await db`
          UPDATE crm.billing_due d
             SET invoice_id = ${invoice.id}, invoice_line_id = ${line.id},
                 advance_invoice_id = ${item.applied?.invoiceId ?? null},
                 advance_applied = ${item.applied?.amount ?? null}::numeric,
                 covered_at = NULL
           WHERE d.id = ${item.dueId}
        `;
        // AN ADVANCE RAISED AGAIN after its invoice was cancelled (0321): the
        // bills that took from it move onto the new invoice, as `markInvoiced`.
        if (open.kind === "advance" && open.invoice_id !== null) {
          await db`
            UPDATE crm.billing_due SET advance_invoice_id = ${invoice.id}
             WHERE advance_invoice_id = ${open.invoice_id}
          `;
        }
        invoiced.push({ dueId: item.dueId, lineId: line.id });
      }
      return { invoice, covered, invoiced, conflicts };
    });
  }

  async markCovered(
    tenantId: string,
    dueId: string,
    applied: { readonly invoiceId: string; readonly amount: string },
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      if (!(await takeFromPool(db, applied))) return false;
      const rows = await db<{ id: string }[]>`
        UPDATE crm.billing_due d
           SET covered_at = now(), invoice_id = NULL, invoice_line_id = NULL,
               advance_invoice_id = ${applied.invoiceId}, advance_applied = ${applied.amount}::numeric
         WHERE d.id = ${dueId}
           AND ${db.unsafe(OPEN_DUE_SQL)}
        RETURNING d.id
      `;
      return rows.length === 1;
    });
  }

  async advances(
    tenantId: string,
    filter: { readonly invoiceId?: string | undefined; readonly dueId?: string | undefined },
  ): Promise<readonly AdvanceRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        (DueRow & {
          invoiced: string | null;
          paid: string | null;
          outstanding: string | null;
          invoice_issued_on: string | null;
          hand_invoice_id: string | null;
          hand_invoice_number: string | null;
        })[]
      >`
        SELECT due.*, b.invoiced::text AS invoiced, b.paid::text AS paid, b.outstanding::text AS outstanding,
               inv.issued_on::text AS invoice_issued_on,
               hand.id AS hand_invoice_id, hand.number AS hand_invoice_number
          FROM (${db.unsafe(DUE_SELECT)}) due
          LEFT JOIN crm.invoice_balance b ON b.invoice_id = due.invoice_id
          LEFT JOIN crm.invoice inv ON inv.id = due.invoice_id
          -- RAISED BY HAND (0322, review item 12): an issued invoice, not
          -- cancelled, with a line on this advance's work, made before this
          -- bill was written (two instants, no day cut), that no bill is on and that is
          -- no bill's advance invoice. Very likely the advance a firm invoiced
          -- itself before 0322: no automatic draft is made for it, and the
          -- screen offers to Link it instead. A month billed by hand AFTER the
          -- bill was written is not mistaken for it.
          LEFT JOIN LATERAL (
            SELECT hi.id, hi.number
              FROM crm.invoice_line hl
              JOIN crm.invoice hi ON hi.id = hl.invoice_id AND hi.tenant_id = hl.tenant_id
             WHERE hl.engagement_id = ANY(due.engagement_ids)
               AND hl.removed_at IS NULL
               AND hi.status = 'issued'
               AND hi.created_at <= due.bill_created_at
               AND NOT EXISTS (SELECT 1 FROM crm.billing_due x
                                WHERE x.invoice_id = hi.id OR x.advance_invoice_id = hi.id)
             ORDER BY hi.issued_on DESC, hi.id
             LIMIT 1
          ) hand ON due.status = 'open'
         WHERE due.kind = 'advance'
           ${filter.invoiceId === undefined ? db`` : db`AND due.invoice_id = ${filter.invoiceId}`}
           ${filter.dueId === undefined ? db`` : db`AND due.id = ${filter.dueId}`}
         ORDER BY due.bill_on, due.party_name, due.id
         LIMIT ${MAX_LIST_ROWS}
      `;
      return rows.map((r) => ({
        ...toRecord(r),
        balance:
          r.invoiced === null || r.paid === null || r.outstanding === null
            ? null
            : { invoiced: r.invoiced, paid: r.paid, outstanding: r.outstanding },
        invoiceIssuedOn: r.invoice_issued_on,
        handRaised:
          r.hand_invoice_id === null || r.hand_invoice_number === null
            ? null
            : { invoiceId: r.hand_invoice_id, number: r.hand_invoice_number },
      }));
    });
  }

  async refundCandidates(
    tenantId: string,
    filter: { readonly dueId?: string | undefined } = {},
  ): Promise<readonly RefundCandidate[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<RefundRow[]>`
        SELECT due.*,
               ap.invoice_id AS r_invoice_id, ap.invoice_number AS r_invoice_number,
               round(ap.advance_net, 2)::text AS advance_net,
               round(ap.applied, 2)::text AS applied,
               ap.remaining::text AS remaining,
               -- What gives the remainder back: its share of the tax added, as a
               -- credit note reverses tax in proportion, never more than the
               -- invoice still carries.
               round(least(ap.remaining * ap.invoice_total / nullif(ap.invoice_net, 0),
                           ap.invoice_total - ap.credited), 2)::text AS refund_amount,
               (coalesce(fin.all_finished, false) AND NOT coalesce(fin.any_open, false)) AS finished,
               coalesce(bal.paid, 0)::text AS paid,
               ${isoInstant("w.refund_waived_at", "waived_at")},
               w.refund_waived_by_user_id AS waived_by_id, wu.display_name AS waived_by_name,
               wu.email::text AS waived_by_email, w.refund_waive_reason AS waive_reason
          FROM crm.advance_pool ap
          JOIN crm.billing_due w ON w.id = ap.advance_due_id AND w.tenant_id = ap.tenant_id
          JOIN (${db.unsafe(DUE_SELECT)}) due ON due.id = ap.advance_due_id
          LEFT JOIN tenancy.user_account wu ON wu.id = w.refund_waived_by_user_id
          LEFT JOIN crm.invoice_balance bal ON bal.invoice_id = ap.invoice_id AND bal.tenant_id = ap.tenant_id
          -- FINISHED: every engagement it covered has ended (and its last period
          -- was billed), or is one-time with its final bill raised, covered or
          -- skipped; and no bill of them is still open, since an open one may
          -- still take from the advance.
          LEFT JOIN LATERAL (
            SELECT bool_and(
                     (e.status IN ('completed', 'cancelled') AND (
                        e.first_invoice_on IS NULL OR e.ends_on IS NULL OR e.ends_on < e.billing_from
                        OR EXISTS (SELECT 1 FROM crm.billing_due x
                                    WHERE x.tenant_id = e.tenant_id AND x.kind = 'period'
                                      AND (x.engagement_id = e.id OR x.fee_group_id = ll.fee_group_id)
                                      AND x.period_end >= e.ends_on)))
                     OR (coalesce(g.billing_frequency, ll.billing_frequency) = 'one_time' AND EXISTS (
                           SELECT 1 FROM crm.billing_due x
                             LEFT JOIN crm.invoice xi ON xi.id = x.invoice_id AND xi.tenant_id = x.tenant_id
                            WHERE x.tenant_id = e.tenant_id AND x.kind = 'final'
                              AND (x.engagement_id = e.id OR x.fee_group_id = ll.fee_group_id)
                              AND (x.skipped_at IS NOT NULL OR x.covered_at IS NOT NULL
                                   OR xi.status IN ('draft', 'issued'))))
                   ) AS all_finished,
                   bool_or(EXISTS (
                     SELECT 1 FROM crm.billing_due x
                       LEFT JOIN crm.invoice xi ON xi.id = x.invoice_id AND xi.tenant_id = x.tenant_id
                      WHERE x.tenant_id = e.tenant_id AND x.kind <> 'advance'
                        AND (x.engagement_id = e.id OR x.fee_group_id = ll.fee_group_id)
                        AND x.skipped_at IS NULL AND x.covered_at IS NULL
                        AND (x.invoice_id IS NULL OR xi.status = 'cancelled'))) AS any_open
              FROM crm.engagement e
              JOIN crm.engagement_letter_line ll
                ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
              LEFT JOIN crm.engagement_letter_fee_group g
                ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
             WHERE e.tenant_id = w.tenant_id
               AND ((w.engagement_id IS NOT NULL AND e.id = w.engagement_id)
                 OR (w.engagement_id IS NULL AND e.engagement_letter_id = w.engagement_letter_id))
          ) fin ON true
         WHERE ${filter.dueId === undefined ? db`ap.remaining > 0` : db`ap.advance_due_id = ${filter.dueId}`}
         ORDER BY due.bill_on, due.party_name, due.id
         LIMIT ${MAX_LIST_ROWS}
      `;
      return rows.map((r) => ({
        advance: toRecord(r),
        invoice: { id: r.r_invoice_id, number: r.r_invoice_number },
        advanceNet: r.advance_net,
        applied: r.applied,
        remaining: r.remaining,
        refundAmount: r.refund_amount,
        finished: r.finished,
        paid: r.paid,
        waived:
          r.waived_at === null || r.waive_reason === null
            ? null
            : { at: r.waived_at, by: person(r.waived_by_id, r.waived_by_name, r.waived_by_email), reason: r.waive_reason },
      }));
    });
  }

  async waiveRefund(tenantId: string, dueId: string, byUserId: string, reason: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        UPDATE crm.billing_due
           SET refund_waived_at = now(), refund_waived_by_user_id = ${byUserId}, refund_waive_reason = ${reason}
         WHERE id = ${dueId} AND kind = 'advance' AND refund_waived_at IS NULL
        RETURNING id
      `;
      return rows.length === 1;
    });
  }

  async claim(tenantId: string, dueIds: readonly string[]): Promise<ClaimToken | null> {
    const ids = [...new Set(dueIds)].sort();
    if (ids.length === 0) return "nothing-claimed";
    return withTenant(this.app, tenantId, async (db) => {
      // Locked in id order, so two claims over overlapping bills cannot
      // deadlock; then all free or none claimed. An id that is no bill here is
      // not "busy": it is left for the caller's read to say it is not found.
      const rows = await db<{ id: string; free: boolean }[]>`
        SELECT id, (claimed_at IS NULL OR claimed_at < now() - ${CLAIM_LIFETIME}::interval) AS free
          FROM crm.billing_due
         WHERE id = ANY(${db.array(ids)}::uuid[])
         ORDER BY id
           FOR UPDATE
      `;
      if (rows.some((r) => !r.free)) return null;
      // THE CLAIM'S OWN INSTANT IS ITS TOKEN (B35): `now()` is this
      // transaction's, held to the microsecond, and a later claim of the same
      // bill can only come after this one lapsed, so it differs.
      // An id that is no bill here still gets a token: the caller's read says
      // "not found", not "busy".
      // In whole microseconds since the epoch, as text: exact, and never a
      // timestamp on the wire (postgres.js would round one to milliseconds).
      const [stamp] = await db<{ at: string }[]>`SELECT (extract(epoch FROM now()) * 1000000)::bigint::text AS at`;
      await db`UPDATE crm.billing_due SET claimed_at = now() WHERE id = ANY(${db.array(ids)}::uuid[])`;
      if (!stamp) throw new Error("now() returned no row");
      return stamp.at;
    });
  }

  async release(tenantId: string, dueIds: readonly string[], token: ClaimToken): Promise<void> {
    if (dueIds.length === 0) return;
    await withTenant(this.app, tenantId, async (db) => {
      // Only this request's claim: a newer one on the same bills stays.
      // Compared in microseconds: a parameter typed timestamptz goes through
      // a JS Date in postgres.js and loses them, so it never matched.
      await db`
        UPDATE crm.billing_due SET claimed_at = NULL
         WHERE id = ANY(${db.array([...dueIds])}::uuid[])
           AND (extract(epoch FROM claimed_at) * 1000000)::bigint = ${token}::bigint
      `;
    });
  }

  async invoiceUse(tenantId: string, invoiceId: string): Promise<{ readonly asAdvance: boolean; readonly byBills: number }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ as_advance: boolean; by_bills: number }[]>`
        SELECT EXISTS (SELECT 1 FROM crm.billing_due WHERE kind = 'advance' AND invoice_id = ${invoiceId}) AS as_advance,
               (SELECT count(*) FROM crm.billing_due WHERE invoice_id = ${invoiceId} AND skipped_at IS NULL)::int AS by_bills
      `;
      return { asAdvance: row?.as_advance ?? false, byBills: row?.by_bills ?? 0 };
    });
  }
}

/** How long a claim holds (0321): long enough for one raise, short enough that
 *  a request that died mid-way does not lock a bill for good. */
const CLAIM_LIFETIME = "2 minutes";

interface RefundRow extends DueRow {
  r_invoice_id: string;
  r_invoice_number: string;
  advance_net: string;
  applied: string;
  remaining: string;
  refund_amount: string;
  finished: boolean;
  paid: string;
  waived_at: string | null;
  waived_by_id: string | null;
  waived_by_name: string | null;
  waived_by_email: string | null;
  waive_reason: string | null;
}

/**
 * "Still open", in a settling write's own WHERE (0318), as a fragment. The SAME
 * definition the read's status uses (0321): a bill the advance covered is open
 * again once that advance invoice is no longer issued. Before, the read said
 * open and every write refused, so pressing Raise drew a number for a draft the
 * bill could never be put on.
 */
const OPEN_DUE_SQL = `d.skipped_at IS NULL
           AND (d.covered_at IS NULL OR NOT EXISTS (
                 SELECT 1 FROM crm.invoice a WHERE a.id = d.advance_invoice_id AND a.status = 'issued'))
           AND (d.invoice_id IS NULL OR EXISTS (
                 SELECT 1 FROM crm.invoice i WHERE i.id = d.invoice_id AND i.status = 'cancelled'))`;

/**
 * THE ADVANCE'S LOCK (0320). Two bills raised at once must not both take the
 * last of one advance: the transaction takes an advisory lock on the advance
 * invoice, then re-reads what is left, and the caller writes only when it
 * still covers what this bill takes. The lock is held to the transaction's
 * end, so the second writer re-reads after the first has committed.
 */
async function takeFromPool(
  db: Db,
  applied: { readonly invoiceId: string; readonly amount: string },
): Promise<boolean> {
  await db`SELECT pg_advisory_xact_lock(hashtext(${`advance:${applied.invoiceId}`}))`;
  const [row] = await db<{ ok: boolean }[]>`
    SELECT ap.remaining >= ${applied.amount}::numeric AS ok
      FROM crm.advance_pool ap
     WHERE ap.invoice_id = ${applied.invoiceId}
  `;
  return row?.ok === true;
}

interface ScheduleRow {
  engagement_id: string;
  issuing_entity_party_id: string;
  party_id: string;
  party_name: string;
  entity_name: string;
  service_name: string;
  letter_ref: string;
  status: string;
  effective_from: string;
  ends_on: string | null;
  billing_frequency: string | null;
  fee_group_id: string | null;
  fee_group_title: string | null;
  billing_from: string | null;
  first_invoice_on: string | null;
  billing_timing: string | null;
  billing_on: string | null;
  year_start_month: number | null;
}

const SCHEDULE_SELECT = `
  SELECT e.id AS engagement_id, l.issuing_entity_party_id, e.party_id, p.display_name AS party_name,
         ep.display_name AS entity_name,
         ll.description AS service_name,
         l.ref AS letter_ref, e.status,
         e.effective_from::text AS effective_from, e.ends_on::text AS ends_on,
         coalesce(g.billing_frequency, ll.billing_frequency) AS billing_frequency,
         g.id AS fee_group_id, g.title AS fee_group_title,
         e.billing_from::text AS billing_from, e.first_invoice_on::text AS first_invoice_on,
         -- What the LETTER says about when it is billed (0319): a grouped line
         -- is billed with its group, so the group's word is the one.
         CASE WHEN g.id IS NOT NULL THEN g.billing_timing ELSE ll.billing_timing END AS billing_timing,
         (CASE WHEN g.id IS NOT NULL THEN g.billing_on ELSE ll.billing_on END)::text AS billing_on,
         e.year_start_month
    FROM crm.engagement e
    JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
    JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
    JOIN core.party p  ON p.id = e.party_id AND p.tenant_id = e.tenant_id
    JOIN core.party ep ON ep.id = e.entity_party_id AND ep.tenant_id = e.tenant_id
    LEFT JOIN crm.engagement_letter_fee_group g ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
`;

function toSchedule(r: ScheduleRow): ScheduleRecord {
  return {
    engagementId: r.engagement_id,
    issuingEntityPartyId: r.issuing_entity_party_id,
    party: { id: r.party_id, displayName: r.party_name },
    entityName: r.entity_name,
    serviceName: r.service_name,
    letterRef: r.letter_ref,
    status: r.status,
    effectiveFrom: r.effective_from,
    endsOn: r.ends_on,
    billingFrequency: r.billing_frequency,
    feeGroup:
      r.fee_group_id === null || r.fee_group_title === null ? null : { id: r.fee_group_id, title: r.fee_group_title },
    billingFrom: r.billing_from,
    firstInvoiceOn: r.first_invoice_on,
    billingTiming: timingOf(r.billing_timing),
    billingOn: r.billing_on,
    yearStartMonth: r.year_start_month,
  };
}

/** The column's word, narrowed: the CHECK (0319) admits only these. */
function timingOf(value: string | null): BillingTiming | null {
  return BILLING_TIMINGS.find((t) => t === value) ?? null;
}

export class PostgresBillingSchedules implements BillingSchedules {
  constructor(private readonly app: Db) {}

  async unscheduled(tenantId: string): Promise<readonly ScheduleRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ScheduleRow[]>`
        SELECT * FROM (${db.unsafe(SCHEDULE_SELECT)}
         WHERE e.billing_from IS NULL
           AND e.status IN ('pending_advance', 'active', 'paused')) s
         WHERE s.billing_frequency IN ('monthly', 'quarterly', 'annually')
         ORDER BY s.party_name, s.letter_ref, s.service_name, s.engagement_id
         LIMIT ${MAX_LIST_ROWS}
      `;
      return rows.map(toSchedule);
    });
  }

  async find(tenantId: string, engagementId: string): Promise<ScheduleRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ScheduleRow[]>`
        ${db.unsafe(SCHEDULE_SELECT)} WHERE e.id = ${engagementId}
      `;
      return row === undefined ? null : toSchedule(row);
    });
  }

  async groupMembers(tenantId: string, feeGroupId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        SELECT e.id
          FROM crm.engagement e
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
         WHERE ll.fee_group_id = ${feeGroupId}
         ORDER BY ll.position, e.id
      `;
      return rows.map((r) => r.id);
    });
  }

  async set(
    tenantId: string,
    engagementIds: readonly string[],
    billingFrom: string | null,
    firstInvoiceOn: string | null,
    yearStartMonth: number | null,
  ): Promise<void> {
    if (engagementIds.length === 0) return;
    await withTenant(this.app, tenantId, async (db) => {
      // The year is pinned once, never moved (0338).
      await db`
        UPDATE crm.engagement
           SET billing_from = ${billingFrom}::date, first_invoice_on = ${firstInvoiceOn}::date,
               year_start_month = coalesce(year_start_month, ${yearStartMonth}::smallint)
         WHERE id = ANY(${db.array(engagementIds as string[])}::uuid[])
      `;
    });
  }
}

export class PostgresAutoBillingSetting implements AutoBillingSetting {
  constructor(private readonly app: Db) {}

  async isOn(tenantId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ auto_billing: boolean }[]>`
        SELECT auto_billing FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      return row?.auto_billing ?? false;
    });
  }

  async set(tenantId: string, on: boolean, since: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE tenancy.tenant
           SET auto_billing = ${on},
               auto_billing_since = CASE WHEN ${on} THEN ${since}::date ELSE auto_billing_since END
         WHERE id = ${tenantId}
      `;
    });
  }

  async since(tenantId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ since: string | null }[]>`
        SELECT auto_billing_since::text AS since FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      return row?.since ?? null;
    });
  }

  async setSince(tenantId: string, since: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`UPDATE tenancy.tenant SET auto_billing_since = ${since}::date WHERE id = ${tenantId}`;
    });
  }

  async dueInDays(tenantId: string): Promise<number | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ invoice_due_days: number | null }[]>`
        SELECT invoice_due_days FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      return row?.invoice_due_days ?? null;
    });
  }

  async setDueInDays(tenantId: string, days: number | null): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`UPDATE tenancy.tenant SET invoice_due_days = ${days} WHERE id = ${tenantId}`;
    });
  }
}
