// The billing sweep's reads and its one write (auto-invoice, phase 1, 0318).
//
// WHAT IS BILLED is read the way the rest of the product reads it, so the
// sweep cannot disagree with the invoice screen:
//   - the CLIENT is the engagement's party (the one an invoice's engagement
//     must belong to, F-10-1), the ISSUER is the company that signed the
//     letter (ENGAGEMENT_OF_ANOTHER_ISSUER), and the CURRENCY is the LETTER
//     LINE's (ENGAGEMENT_IN_ANOTHER_CURRENCY; and the line's, not the
//     letter's, because multi-currency will let lines differ);
//   - a fee group is billed ONCE at the group's frequency and amount (0083),
//     never per engagement;
//   - one period's amount is `crm.engagement_mrr.line_amount`'s expression
//     (quantity x unit x (1 - discount)), in numeric, cast to text;
//   - the Dept is the LIVE published service's `module`, the router's read.
//
// WHO IS OFFERED: billing set up, a recurring frequency, and a commercial life
// that has begun — active, paused (a period half served before the pause is
// still owed) or ended with its last day. One waiting for its advance has not
// started.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { SpocWithManager } from "../../domain/billing/model";
import type {
  AutoBillingFirms,
  BilledEngagement,
  BillingDueWriter,
  BillingManagerFacts,
  BillingSubject,
  NewBillingDue,
} from "../../usecase/billing/ports";
import { keyManagerOn } from "./work-owner";

interface SubjectRow {
  engagement_id: string;
  fee_group_id: string | null;
  party_id: string;
  issuing_entity_party_id: string;
  currency: string;
  billing_frequency: string;
  billing_from: string;
  first_invoice_on: string;
  full_amount: string | null;
  status: string;
  effective_from: string;
  ends_on: string | null;
  paused_on: string | null;
  resumed_on: string | null;
  dept_code: string | null;
}

export class PostgresBillingDueWriter implements BillingDueWriter {
  constructor(private readonly app: Db) {}

  async subjectsFor(tenantId: string): Promise<readonly BillingSubject[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<SubjectRow[]>`
        SELECT e.id AS engagement_id,
               g.id AS fee_group_id,
               e.party_id,
               l.issuing_entity_party_id,
               ll.currency,
               coalesce(g.billing_frequency, ll.billing_frequency) AS billing_frequency,
               e.billing_from::text     AS billing_from,
               e.first_invoice_on::text AS first_invoice_on,
               CASE
                 WHEN g.id IS NOT NULL THEN g.amount::text
                 WHEN ll.unit_amount IS NULL THEN NULL
                 ELSE round(ll.quantity * ll.unit_amount * (1 - ll.discount_percent / 100), 4)::text
               END AS full_amount,
               e.status,
               e.effective_from::text AS effective_from,
               e.ends_on::text        AS ends_on,
               e.paused_on::text      AS paused_on,
               e.resumed_on::text     AS resumed_on,
               live.body ->> 'module' AS dept_code
          FROM crm.engagement e
          JOIN crm.engagement_letter l
            ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          LEFT JOIN crm.engagement_letter_fee_group g
            ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
          LEFT JOIN config.version pinned
            ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
          LEFT JOIN config.version live
            ON live.entry_id = pinned.entry_id
           AND live.tenant_id = pinned.tenant_id
           AND live.status = 'published'
         WHERE e.first_invoice_on IS NOT NULL
           AND (e.status IN ('active', 'paused')
                OR (e.status IN ('completed', 'cancelled') AND e.ends_on IS NOT NULL))
           AND coalesce(g.billing_frequency, ll.billing_frequency) IN ('monthly', 'quarterly', 'annually')
         ORDER BY e.effective_from, e.id
      `;
      if (rows.length === 0) return [];

      const engagementIds = rows.filter((r) => r.fee_group_id === null).map((r) => r.engagement_id);
      const groupIds = [...new Set(rows.flatMap((r) => (r.fee_group_id === null ? [] : [r.fee_group_id])))];
      const due = await db<{ engagement_id: string | null; fee_group_id: string | null; period_start: string }[]>`
        SELECT engagement_id, fee_group_id, period_start::text AS period_start
          FROM crm.billing_due
         WHERE engagement_id = ANY(${db.array(engagementIds)}::uuid[])
            OR fee_group_id = ANY(${db.array(groupIds)}::uuid[])
      `;
      const starts = new Map<string, string[]>();
      for (const d of due) {
        const key = d.fee_group_id ?? d.engagement_id ?? "";
        starts.set(key, [...(starts.get(key) ?? []), d.period_start]);
      }

      // One subject per engagement priced on its own, one per fee group.
      const subjects = new Map<string, BillingSubject>();
      for (const r of rows) {
        const key = r.fee_group_id ?? r.engagement_id;
        const engagement: BilledEngagement = {
          engagementId: r.engagement_id,
          status: r.status,
          effectiveFrom: r.effective_from,
          endsOn: r.ends_on,
          pausedOn: r.paused_on,
          resumedOn: r.resumed_on,
          deptCode: r.dept_code,
        };
        const seen = subjects.get(key);
        if (seen !== undefined) {
          // A group's engagements carry one schedule (the service sets them
          // together); the earliest is taken should they ever disagree, so a
          // period is never skipped by the group's later member.
          subjects.set(key, {
            ...seen,
            billingFrom: r.billing_from < seen.billingFrom ? r.billing_from : seen.billingFrom,
            firstInvoiceOn: r.first_invoice_on < seen.firstInvoiceOn ? r.first_invoice_on : seen.firstInvoiceOn,
            engagements: [...seen.engagements, engagement],
          });
          continue;
        }
        subjects.set(key, {
          engagementId: r.fee_group_id === null ? r.engagement_id : null,
          feeGroupId: r.fee_group_id,
          partyId: r.party_id,
          issuingEntityPartyId: r.issuing_entity_party_id,
          currency: r.currency,
          billingFrequency: r.billing_frequency,
          billingFrom: r.billing_from,
          firstInvoiceOn: r.first_invoice_on,
          fullAmount: r.full_amount,
          engagements: [engagement],
          duePeriodStarts: starts.get(key) ?? [],
        });
      }
      return [...subjects.values()];
    });
  }

  async insert(tenantId: string, dues: readonly NewBillingDue[]): Promise<readonly string[]> {
    if (dues.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const payload = dues.map((d) => ({
        id: d.id,
        party_id: d.partyId,
        issuing_entity_party_id: d.issuingEntityPartyId,
        currency: d.currency,
        engagement_id: d.engagementId,
        fee_group_id: d.feeGroupId,
        period_start: d.periodStart,
        period_end: d.periodEnd,
        period_label: d.periodLabel,
        bill_on: d.billOn,
        full_amount: d.fullAmount,
        served_days: d.servedDays,
        period_days: d.periodDays,
        manager_user_id: d.managerUserId,
        manager_how: d.managerHow,
        manager_note: d.managerNote,
      }));
      // `::text::jsonb`: postgres.js encodes a string parameter as JSON again,
      // and a bare `::jsonb` would be a jsonb STRING (T3.2's lesson).
      const created = await db<{ id: string }[]>`
        INSERT INTO crm.billing_due
          (id, tenant_id, party_id, issuing_entity_party_id, currency, engagement_id, fee_group_id,
           period_start, period_end, period_label, bill_on, full_amount, served_days, period_days,
           manager_user_id, manager_how, manager_note)
        SELECT r.id, ${tenantId}, r.party_id, r.issuing_entity_party_id, r.currency, r.engagement_id,
               r.fee_group_id, r.period_start, r.period_end, r.period_label, r.bill_on, r.full_amount,
               r.served_days, r.period_days, r.manager_user_id, r.manager_how, r.manager_note
          FROM jsonb_to_recordset(${JSON.stringify(payload)}::text::jsonb) AS r(
            id uuid, party_id uuid, issuing_entity_party_id uuid, currency text, engagement_id uuid,
            fee_group_id uuid, period_start date, period_end date, period_label text, bill_on date,
            full_amount numeric, served_days integer, period_days integer, manager_user_id uuid,
            manager_how text, manager_note text)
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      return created.map((r) => r.id);
    });
  }
}

/**
 * Whose kitty, read. A SPOC for the Dept in force on the day, active staff,
 * with the person they report to — only when that person is active staff at
 * this firm too: somebody who has left is nobody to credit revenue to.
 */
export class PostgresBillingManagerFacts implements BillingManagerFacts {
  constructor(private readonly app: Db) {}

  spocsFor(
    tenantId: string,
    clientPartyId: string,
    deptCode: string,
    onDate: string,
  ): Promise<readonly SpocWithManager[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ user_id: string; manager_user_id: string | null; manager_name: string | null }[]>`
        SELECT a.user_id,
               boss.user_id     AS manager_user_id,
               bu.display_name  AS manager_name
          FROM crm.client_assignment a
          JOIN tenancy.service_axis x
            ON x.id = a.axis_id AND x.tenant_id = a.tenant_id
           AND x.axis = 'dept' AND x.code = ${deptCode}
          JOIN tenancy.membership m
            ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
           AND m.audience = 'STAFF' AND m.is_active
          LEFT JOIN tenancy.membership boss
            ON boss.tenant_id = a.tenant_id AND boss.user_id = m.reports_to_user_id
           AND boss.audience = 'STAFF' AND boss.is_active
          LEFT JOIN tenancy.user_account bu ON bu.id = boss.user_id
         WHERE a.client_party_id = ${clientPartyId}
           AND a.role = 'spoc'
           AND a.valid_from <= ${onDate}::date
           AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
         ORDER BY a.valid_from, a.user_id
      `;
      return rows.map((r) => ({
        userId: r.user_id,
        managerUserId: r.manager_user_id,
        managerName: r.manager_name,
      }));
    });
  }

  keyManagerFor(
    tenantId: string,
    clientPartyId: string,
    onDate: string,
  ): Promise<{ readonly userId: string; readonly displayName: string | null } | null> {
    return withTenant(this.app, tenantId, (db) => keyManagerOn(db, clientPartyId, onDate));
  }
}

/**
 * The firms with auto-billing on. Like `PostgresTenantDirectory`, the one read
 * not inside a tenant context, and it returns nothing but ids.
 */
export class PostgresAutoBillingFirms implements AutoBillingFirms {
  constructor(private readonly app: Db) {}

  async firmsWithAutoBilling(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' AND auto_billing ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }
}
