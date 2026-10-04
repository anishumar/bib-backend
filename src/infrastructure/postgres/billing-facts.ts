// What the advance and the final bill need to know (auto-invoice, phase 2,
// 0320; 0322): a signed letter's advance terms, the letters whose advance still
// needs the catch-up, and the one-time services whose final bill may be due.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  AdvanceBillFacts,
  FinalBillFacts,
  FinalBillSubject,
  LetterAdvanceFacts,
} from "../../usecase/billing/ports";

export class PostgresAdvanceBillFacts implements AdvanceBillFacts {
  constructor(private readonly app: Db) {}

  async advanceFactsOf(tenantId: string, letterId: string): Promise<LetterAdvanceFacts | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [letter] = await db<
        {
          id: string;
          party_id: string;
          issuing_entity_party_id: string;
          currency: string;
          signed_on: string;
          advance_required: boolean;
          advance_amount: string | null;
          advance_recorded: boolean;
        }[]
      >`
        SELECT l.id, l.party_id, l.issuing_entity_party_id, l.currency,
               -- The FIRM's day it was signed: a calendar day is the caller's.
               (l.signed_at AT TIME ZONE t.time_zone)::date::text AS signed_on,
               l.advance_required, l.advance_amount::text AS advance_amount,
               l.advance_recorded_at IS NOT NULL AS advance_recorded
          FROM crm.engagement_letter l
          JOIN tenancy.tenant t ON t.id = l.tenant_id
         WHERE l.id = ${letterId} AND l.status = 'signed'
      `;
      if (letter === undefined) return null;
      const lines = await db<
        { engagement_id: string; status: string; advance_amount: string | null; dept_code: string | null }[]
      >`
        SELECT e.id AS engagement_id, e.status, ll.advance_amount::text AS advance_amount,
               live.body ->> 'module' AS dept_code
          FROM crm.engagement e
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          LEFT JOIN config.version pinned
            ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
          LEFT JOIN config.version live
            ON live.entry_id = pinned.entry_id AND live.tenant_id = pinned.tenant_id
           AND live.status = 'published'
         WHERE e.engagement_letter_id = ${letterId}
         ORDER BY ll.position, e.id
      `;
      return {
        letterId: letter.id,
        partyId: letter.party_id,
        issuingEntityPartyId: letter.issuing_entity_party_id,
        currency: letter.currency,
        signedOn: letter.signed_on,
        advanceRequired: letter.advance_required,
        advanceAmount: letter.advance_amount,
        advanceRecorded: letter.advance_recorded,
        lines: lines.map((l) => ({
          engagementId: l.engagement_id,
          status: l.status,
          advanceAmount: l.advance_amount,
          deptCode: l.dept_code,
        })),
      };
    });
  }

  /**
   * The letters the daily catch-up visits (0322): work still waiting on an
   * advance from before 0322, an advance asked for with no bill written
   * (for work not called off), or an advance bill never put on an invoice and
   * not skipped. A letter whose advance was recorded by hand before 0320 is
   * left alone: its work started long ago.
   */
  async lettersOwingAdvance(tenantId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        SELECT l.id
          FROM crm.engagement_letter l
         WHERE l.status = 'signed'
           AND NOT (l.advance_required AND l.advance_recorded_at IS NOT NULL)
           AND (
             EXISTS (SELECT 1 FROM crm.engagement e
                      WHERE e.engagement_letter_id = l.id AND e.tenant_id = l.tenant_id
                        AND e.status = 'pending_advance')
             OR (l.advance_required
                 AND EXISTS (SELECT 1 FROM crm.engagement e
                              WHERE e.engagement_letter_id = l.id AND e.tenant_id = l.tenant_id
                                AND e.status <> 'cancelled')
                 AND NOT EXISTS (SELECT 1 FROM crm.billing_due d
                                  WHERE d.tenant_id = l.tenant_id AND d.kind = 'advance'
                                    AND d.engagement_letter_id = l.id AND d.engagement_id IS NULL))
             OR EXISTS (SELECT 1
                          FROM crm.engagement e
                          JOIN crm.engagement_letter_line ll
                            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
                         WHERE e.engagement_letter_id = l.id AND e.tenant_id = l.tenant_id
                           AND e.status <> 'cancelled'
                           AND ll.advance_amount IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM crm.billing_due d
                                            WHERE d.tenant_id = e.tenant_id AND d.kind = 'advance'
                                              AND d.engagement_id = e.id))
             OR EXISTS (SELECT 1 FROM crm.billing_due d
                         WHERE d.tenant_id = l.tenant_id AND d.kind = 'advance'
                           AND d.engagement_letter_id = l.id
                           AND d.invoice_id IS NULL AND d.skipped_at IS NULL)
           )
         ORDER BY l.signed_at, l.id
      `;
      return rows.map((r) => r.id);
    });
  }

  async undraftedAdvanceBills(tenantId: string, letterId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ id: string }[]>`
        SELECT id FROM crm.billing_due
         WHERE kind = 'advance' AND engagement_letter_id = ${letterId}
           AND invoice_id IS NULL AND skipped_at IS NULL
         ORDER BY created_at, id
      `;
      return rows.map((r) => r.id);
    });
  }

  /** Every active firm: which of them owe something is only answerable inside
   *  each one's wall, so the GLOBAL read is ids and nothing else, as
   *  `PostgresAutoBillingFirms`'s is. */
  async firmsOwingAdvance(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }
}

interface OneTimeRow {
  engagement_id: string;
  fee_group_id: string | null;
  party_id: string;
  issuing_entity_party_id: string;
  currency: string;
  billing_frequency: string | null;
  full_amount: string | null;
  effective_from: string;
  status: string;
  dept_code: string | null;
  job_id: string | null;
  job_status: string | null;
  has_process: boolean | null;
  done_on: string | null;
  has_final_bill: boolean;
  billed_by_hand: boolean;
  auto_billing_since: string | null;
}

export class PostgresFinalBillFacts implements FinalBillFacts {
  constructor(private readonly app: Db) {}

  async oneTimeSubjects(
    tenantId: string,
    filter: {
      readonly jobId?: string | undefined;
      readonly engagementId?: string | undefined;
      readonly partyId?: string | undefined;
    },
  ): Promise<readonly FinalBillSubject[]> {
    const rows = await withTenant(this.app, tenantId, (db) => db<OneTimeRow[]>`
      SELECT e.id AS engagement_id, g.id AS fee_group_id, e.party_id, l.issuing_entity_party_id,
             ll.currency,
             coalesce(g.billing_frequency, ll.billing_frequency) AS billing_frequency,
             CASE
               WHEN g.id IS NOT NULL THEN g.amount::text
               WHEN ll.unit_amount IS NULL THEN NULL
               ELSE round(ll.quantity * ll.unit_amount * (1 - ll.discount_percent / 100), 4)::text
             END AS full_amount,
             e.effective_from::text AS effective_from, e.status,
             live.body ->> 'module' AS dept_code,
             j.id AS job_id, j.status AS job_status,
             -- A job with no process written has no template: it waits for
             -- good and is never "done" (0046), which is what Bill it now is for.
             CASE WHEN j.id IS NULL THEN NULL ELSE j.template_version_id IS NOT NULL END AS has_process,
             CASE WHEN j.status = 'done' THEN (j.finished_at AT TIME ZONE t.time_zone)::date::text END AS done_on,
             EXISTS (SELECT 1 FROM crm.billing_due d
                      WHERE d.tenant_id = e.tenant_id AND d.kind = 'final'
                        AND (d.engagement_id = e.id OR (g.id IS NOT NULL AND d.fee_group_id = g.id))) AS has_final_bill,
             -- BILLED BY HAND (0321): a line not cancelled already bills this
             -- engagement and was not written from a bill (an advance's own
             -- line is). A final bill for the full price would bill it twice.
             EXISTS (SELECT 1 FROM crm.invoice_line il
                       JOIN crm.invoice ii ON ii.id = il.invoice_id AND ii.tenant_id = il.tenant_id
                      WHERE il.tenant_id = e.tenant_id AND il.engagement_id = e.id
                        AND il.removed_at IS NULL AND ii.status <> 'cancelled'
                        AND NOT EXISTS (SELECT 1 FROM crm.billing_due bd
                                         WHERE bd.tenant_id = il.tenant_id AND bd.invoice_line_id = il.id)) AS billed_by_hand,
             t.auto_billing_since::text AS auto_billing_since
        FROM crm.engagement e
        JOIN tenancy.tenant t ON t.id = e.tenant_id
        JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_fee_group g ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
        LEFT JOIN config.version pinned ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id AND live.tenant_id = pinned.tenant_id AND live.status = 'published'
        LEFT JOIN delivery.job_engagement je ON je.engagement_id = e.id AND je.tenant_id = e.tenant_id
        LEFT JOIN delivery.job j ON j.id = je.job_id AND j.tenant_id = je.tenant_id
       WHERE coalesce(g.billing_frequency, ll.billing_frequency) = 'one_time'
         AND e.status IN ('pending_advance', 'active', 'paused', 'completed')
         ${filter.partyId === undefined ? db`` : db`AND e.party_id = ${filter.partyId}`}
       ORDER BY e.effective_from, e.id
    `);

    const subjects = new Map<string, FinalBillSubject & { jobIds: string[] }>();
    for (const r of rows) {
      const key = r.fee_group_id ?? r.engagement_id;
      const engagement = {
        engagementId: r.engagement_id,
        status: r.status,
        deptCode: r.dept_code,
        job:
          r.job_status === null
            ? null
            : { status: r.job_status, hasProcess: r.has_process === true, doneOn: r.done_on },
      };
      const seen = subjects.get(key);
      if (seen !== undefined) {
        subjects.set(key, {
          ...seen,
          effectiveFrom: r.effective_from < seen.effectiveFrom ? r.effective_from : seen.effectiveFrom,
          engagements: [...seen.engagements, engagement],
          jobIds: r.job_id === null ? seen.jobIds : [...seen.jobIds, r.job_id],
          hasFinalBill: seen.hasFinalBill || r.has_final_bill,
          billedByHand: seen.billedByHand || r.billed_by_hand,
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
        fullAmount: r.full_amount,
        effectiveFrom: r.effective_from,
        engagements: [engagement],
        jobIds: r.job_id === null ? [] : [r.job_id],
        hasFinalBill: r.has_final_bill,
        billedByHand: r.billed_by_hand,
        autoBillingSince: r.auto_billing_since,
      });
    }
    return [...subjects.values()]
      .filter((s) => filter.jobId === undefined || s.jobIds.includes(filter.jobId))
      .filter((s) => filter.engagementId === undefined || s.engagements.some((e) => e.engagementId === filter.engagementId))
      .map(({ jobIds: _jobIds, ...s }) => s);
  }

  async describe(
    tenantId: string,
    subjects: readonly FinalBillSubject[],
  ): Promise<ReadonlyMap<string, { readonly clientName: string; readonly serviceName: string; readonly letterRef: string }>> {
    const ids = subjects.flatMap((s) => s.engagements.map((e) => e.engagementId));
    if (ids.length === 0) return new Map();
    const rows = await withTenant(this.app, tenantId, (db) => db<
      { engagement_id: string; fee_group_id: string | null; client_name: string; service_name: string; letter_ref: string }[]
    >`
      SELECT e.id AS engagement_id, g.id AS fee_group_id, p.display_name AS client_name,
             coalesce(g.title, ll.description) AS service_name, l.ref AS letter_ref
        FROM crm.engagement e
        JOIN core.party p ON p.id = e.party_id AND p.tenant_id = e.tenant_id
        JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_fee_group g ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
       WHERE e.id = ANY(${db.array(ids)}::uuid[])
    `);
    return new Map(
      rows.map((r) => [
        r.fee_group_id ?? r.engagement_id,
        { clientName: r.client_name, serviceName: r.service_name, letterRef: r.letter_ref },
      ]),
    );
  }
}
