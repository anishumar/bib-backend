// Work vs Billing's facts (Q041, 2026-10-04): the subjects, their bills with
// invoice and balance, their jobs and the filings under them, in ONE
// `withTenant`, so every fact describes the same moment.
//
// Each read restates a rule the product already applies, so this screen never
// disagrees with the one that acts:
//   - a bill's STATUS is the billing desk's CASE (skipped, covered while its
//     advance invoice stands, open when its invoice was cancelled, drafted,
//     billed), and what is owed is `crm.invoice_balance` (0 unless issued);
//   - a SUBJECT is the sweep's: an engagement priced on its own, or the fee
//     group whose one fee covers several (`billing-repository.ts`);
//   - a FILING belongs to an engagement it was generated for, or to any
//     engagement of the same company whose service the rule is linked to
//     (CA#11's predicate in `job-repository.ts` `describeJobs`);
//   - a job's DONE DAY is the firm's: `finished_at` in `tenancy.tenant.time_zone`.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  DueStatus,
  WbBill,
  WbEngagement,
  WbFacts,
  WbFiling,
  WbJob,
  WbPerson,
  WbSubject,
  WorkBillingFacts,
} from "../../usecase/billing/ports";
import { isoInstant } from "./instant";

/** A ceiling per fact list. Far past a year of any firm's book; a ceiling, not
 *  pagination (see `db/limits.ts`). */
const FACT_LIMIT = 20_000;

interface EngagementRow {
  id: string;
  party_id: string;
  party_name: string;
  entity_name: string;
  line_description: string;
  fee_group_id: string | null;
  group_title: string | null;
  frequency: string | null;
  billing_from: string | null;
  first_invoice_on: string | null;
  issuing_entity_party_id: string;
  year_start_month: number | null;
  status: string;
  effective_from: string;
  ends_on: string | null;
  paused_on: string | null;
  resumed_on: string | null;
  letter_id: string;
  letter_ref: string;
}

interface BillRow {
  id: string;
  kind: string;
  engagement_id: string | null;
  fee_group_id: string | null;
  engagement_letter_id: string | null;
  party_id: string;
  party_name: string;
  engagement_ids: string[] | null;
  service_name: string | null;
  entity_name: string | null;
  letter_id: string | null;
  letter_ref: string | null;
  period_start: string;
  period_end: string;
  period_label: string;
  bill_on: string;
  dated_by_filing_id: string | null;
  currency: string;
  amount: string | null;
  full_amount: string | null;
  status: DueStatus;
  manager_id: string | null;
  manager_name: string | null;
  skipped_at: string | null;
  skip_reason: string | null;
  skipped_by_id: string | null;
  skipped_by_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  issued_on: string | null;
  due_on: string | null;
  invoiced: string | null;
  paid: string | null;
  outstanding: string | null;
  invoice_manager_id: string | null;
  invoice_manager_name: string | null;
  covered_invoice_id: string | null;
  covered_number: string | null;
}

interface JobRow {
  job_id: string;
  engagement_id: string;
  fee_group_id: string | null;
  source_kind: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  done_on: string | null;
}

interface FilingRow {
  id: string;
  name: string;
  period_start: string;
  period_end: string;
  period_label: string;
  due_on: string;
  filed_on: string | null;
  state_name: string;
  is_filed: boolean;
  is_terminal: boolean;
  job_status: string | null;
  engagement_ids: string[];
}

function person(id: string | null, name: string | null): WbPerson | null {
  return id === null ? null : { userId: id, displayName: name };
}

function subjectKeyOf(engagementId: string, feeGroupId: string | null): string {
  return feeGroupId === null ? `e:${engagementId}` : `g:${feeGroupId}`;
}

export class PostgresWorkBillingFacts implements WorkBillingFacts {
  constructor(private readonly app: Db) {}

  async read(
    tenantId: string,
    q: {
      readonly from: string;
      readonly to: string;
      readonly partyId?: string | undefined;
      readonly today: string;
    },
  ): Promise<WbFacts> {
    return withTenant(this.app, tenantId, async (db) => {
      const party = q.partyId;

      const firm = await db<{ auto_billing: boolean; auto_billing_since: string | null }[]>`
        SELECT auto_billing, auto_billing_since::text AS auto_billing_since
          FROM tenancy.tenant WHERE id = ${tenantId}
      `;

      // ── The subjects ────────────────────────────────────────────────────
      const engagements = await db<EngagementRow[]>`
        SELECT e.id, e.party_id, p.display_name AS party_name, ent.display_name AS entity_name,
               ll.description AS line_description,
               g.id AS fee_group_id, g.title AS group_title,
               coalesce(g.billing_frequency, ll.billing_frequency) AS frequency,
               e.billing_from::text AS billing_from, e.first_invoice_on::text AS first_invoice_on,
               l.issuing_entity_party_id, e.year_start_month,
               e.status, e.effective_from::text AS effective_from, e.ends_on::text AS ends_on,
               e.paused_on::text AS paused_on, e.resumed_on::text AS resumed_on,
               l.id AS letter_id, l.ref AS letter_ref
          FROM crm.engagement e
          JOIN core.party p ON p.id = e.party_id AND p.tenant_id = e.tenant_id
          JOIN core.party ent ON ent.id = e.entity_party_id AND ent.tenant_id = e.tenant_id
          JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          LEFT JOIN crm.engagement_letter_fee_group g
            ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
         WHERE e.effective_from <= ${q.to}::date
           ${party === undefined ? db`` : db`AND e.party_id = ${party}`}
         ORDER BY e.effective_from, e.id
         LIMIT ${FACT_LIMIT}
      `;
      const engagementIds = engagements.map((e) => e.id);
      const partyIds = [...new Set(engagements.map((e) => e.party_id))];

      const keyManagers = await db<
        {
          client_party_id: string;
          user_id: string;
          display_name: string | null;
        }[]
      >`
        SELECT DISTINCT ON (a.client_party_id) a.client_party_id, a.user_id, u.display_name
          FROM crm.client_assignment a
          JOIN tenancy.user_account u ON u.id = a.user_id
          JOIN tenancy.membership m
            ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
           AND m.audience = 'STAFF' AND m.is_active
         WHERE a.client_party_id = ANY(${db.array(partyIds)}::uuid[])
           AND a.role = 'key_manager'
           AND a.valid_from <= ${q.today}::date
           AND (a.valid_to IS NULL OR a.valid_to > ${q.today}::date)
         ORDER BY a.client_party_id, a.valid_from DESC
      `;

      // Invoices raised BY HAND for this work: a line on it, not cancelled,
      // and the invoice on no bill (a bill's invoice was raised from the desk).
      const hand = await db<
        {
          engagement_id: string;
          invoice_id: string;
          number: string | null;
          issued_on: string | null;
        }[]
      >`
        SELECT DISTINCT il.engagement_id, i.id AS invoice_id, i.number, i.issued_on::text AS issued_on
          FROM crm.invoice_line il
          JOIN crm.invoice i ON i.id = il.invoice_id AND i.tenant_id = il.tenant_id
         WHERE il.engagement_id = ANY(${db.array(engagementIds)}::uuid[])
           AND il.removed_at IS NULL
           AND i.status <> 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM crm.billing_due d
              WHERE d.tenant_id = i.tenant_id AND (d.invoice_id = i.id OR d.advance_invoice_id = i.id))
      `;

      // ── The bills ───────────────────────────────────────────────────────
      const bills = await db<BillRow[]>`
        SELECT d.id, d.kind, d.engagement_id, d.fee_group_id, d.engagement_letter_id,
               d.party_id, p.display_name AS party_name,
               subj.engagement_ids, subj.service_name, subj.entity_name, subj.letter_id, subj.letter_ref,
               d.period_start::text AS period_start, d.period_end::text AS period_end, d.period_label,
               d.bill_on::text AS bill_on, d.dated_by_filing_id, d.currency, d.amount::text AS amount,
               d.full_amount::text AS full_amount,
               CASE
                 WHEN d.skipped_at IS NOT NULL THEN 'skipped'
                 WHEN d.covered_at IS NOT NULL AND adv.status = 'issued' THEN 'covered'
                 WHEN i.id IS NULL OR i.status = 'cancelled' THEN 'open'
                 WHEN i.status = 'draft' THEN 'drafted'
                 ELSE 'billed'
               END AS status,
               d.manager_user_id AS manager_id, mu.display_name AS manager_name,
               ${db.unsafe(isoInstant("d.skipped_at", "skipped_at"))},
               d.skip_reason, d.skipped_by_user_id AS skipped_by_id, su.display_name AS skipped_by_name,
               CASE WHEN i.status = 'cancelled' THEN NULL ELSE i.id END AS invoice_id,
               i.number AS invoice_number, i.status AS invoice_status,
               i.issued_on::text AS issued_on, i.due_on::text AS due_on,
               ib.invoiced::text AS invoiced, ib.paid::text AS paid, ib.outstanding::text AS outstanding,
               i.manager_user_id AS invoice_manager_id, imu.display_name AS invoice_manager_name,
               CASE WHEN d.covered_at IS NOT NULL THEN adv.id END AS covered_invoice_id,
               CASE WHEN d.covered_at IS NOT NULL THEN adv.number END AS covered_number
          FROM crm.billing_due d
          JOIN core.party p ON p.id = d.party_id AND p.tenant_id = d.tenant_id
          LEFT JOIN crm.invoice i ON i.id = d.invoice_id AND i.tenant_id = d.tenant_id
          LEFT JOIN crm.invoice_balance ib ON ib.invoice_id = i.id AND ib.tenant_id = i.tenant_id
          LEFT JOIN crm.invoice adv ON adv.id = d.advance_invoice_id AND adv.tenant_id = d.tenant_id
          LEFT JOIN tenancy.user_account mu ON mu.id = d.manager_user_id
          LEFT JOIN tenancy.user_account su ON su.id = d.skipped_by_user_id
          LEFT JOIN tenancy.user_account imu ON imu.id = i.manager_user_id
          JOIN LATERAL (
            SELECT array_agg(e.id ORDER BY ll.position, e.id) AS engagement_ids,
                   CASE WHEN d.fee_group_id IS NOT NULL THEN max(g.title)
                        WHEN d.kind = 'advance' AND d.engagement_id IS NULL THEN 'All services'
                        ELSE max(ll.description) END AS service_name,
                   CASE WHEN count(DISTINCT e.entity_party_id) = 1 THEN max(ep.display_name) END AS entity_name,
                   (array_agg(l.id))[1] AS letter_id,
                   max(l.ref) AS letter_ref
              FROM crm.engagement e
              JOIN crm.engagement_letter_line ll
                ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
              JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
              JOIN core.party ep ON ep.id = e.entity_party_id AND ep.tenant_id = e.tenant_id
              LEFT JOIN crm.engagement_letter_fee_group g
                ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
             WHERE e.tenant_id = d.tenant_id
               AND ((d.engagement_id IS NOT NULL AND e.id = d.engagement_id)
                 OR (d.fee_group_id IS NOT NULL AND ll.fee_group_id = d.fee_group_id AND ll.removed_at IS NULL)
                 OR (d.kind = 'advance' AND d.engagement_id IS NULL AND e.engagement_letter_id = d.engagement_letter_id))
          ) subj ON true
         WHERE ((d.kind = 'period' AND d.period_start <= ${q.to}::date AND d.period_end >= ${q.from}::date)
             OR (d.kind <> 'period' AND d.bill_on BETWEEN ${q.from}::date AND ${q.to}::date))
           ${party === undefined ? db`` : db`AND d.party_id = ${party}`}
         ORDER BY d.bill_on, d.id
         LIMIT ${FACT_LIMIT}
      `;

      // ── The jobs: period jobs touching the window; one-time jobs still
      //    open or finished inside it ─────────────────────────────────────
      const jobs = await db<JobRow[]>`
        SELECT j.id AS job_id, je.engagement_id, ll.fee_group_id, j.source_kind, j.status,
               j.period_start::text AS period_start, j.period_end::text AS period_end, j.period_label,
               CASE WHEN j.status = 'done'
                    THEN (j.finished_at AT TIME ZONE t.time_zone)::date::text END AS done_on
          FROM delivery.job_engagement je
          JOIN delivery.job j ON j.id = je.job_id AND j.tenant_id = je.tenant_id
          JOIN crm.engagement e ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          JOIN tenancy.tenant t ON t.id = j.tenant_id
         WHERE j.source_kind IN ('engagement', 'engagement_group', 'engagement_period')
           AND ((j.period_start IS NOT NULL
                 AND j.period_start <= ${q.to}::date AND j.period_end >= ${q.from}::date)
             OR (j.period_start IS NULL
                 AND (j.finished_at IS NULL
                      OR (j.finished_at AT TIME ZONE t.time_zone)::date >= ${q.from}::date)))
           ${party === undefined ? db`` : db`AND e.party_id = ${party}`}
         ORDER BY j.period_start NULLS LAST, j.id
         LIMIT ${FACT_LIMIT}
      `;

      // ── The filings, with the engagements whose service they belong to ──
      const filings = await db<FilingRow[]>`
        SELECT oi.id, ot.name, oi.period_start::text AS period_start, oi.period_end::text AS period_end,
               oi.period_label, oi.statutory_due_on::text AS due_on, oi.filed_on::text AS filed_on,
               os.name AS state_name, os.is_filed, os.is_terminal, oj.status AS job_status,
               ARRAY(
                 SELECT e.id
                   FROM crm.engagement e
                   JOIN crm.engagement_letter_line ll
                     ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
                   LEFT JOIN config.version pinned
                     ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
                  WHERE e.tenant_id = oi.tenant_id
                    AND e.entity_party_id = oi.entity_party_id
                    ${party === undefined ? db`` : db`AND e.party_id = ${party}`}
                    AND (oi.engagement_id = e.id
                         OR EXISTS (SELECT 1 FROM delivery.obligation_rule_service k
                                     WHERE k.tenant_id = oi.tenant_id
                                       AND k.lineage_id = oi.lineage_id
                                       AND k.service_entry_id = pinned.entry_id
                                       AND k.unlinked_at IS NULL))
               ) AS engagement_ids
          FROM delivery.obligation_instance oi
          JOIN delivery.obligation_template ot ON ot.id = oi.template_id AND ot.tenant_id = oi.tenant_id
          JOIN delivery.obligation_state os ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
          LEFT JOIN delivery.job oj
            ON oj.tenant_id = oi.tenant_id AND oj.source_kind = 'obligation' AND oj.source_ref = oi.id
         WHERE oi.withdrawn_at IS NULL
           AND oi.period_start <= ${q.to}::date AND oi.period_end >= ${q.from}::date
         ORDER BY oi.statutory_due_on, oi.id
         LIMIT ${FACT_LIMIT}
      `;

      return assemble(firm[0], engagements, keyManagers, hand, bills, jobs, filings);
    });
  }
}

function assemble(
  firm: { auto_billing: boolean; auto_billing_since: string | null } | undefined,
  engagements: readonly EngagementRow[],
  keyManagers: readonly {
    client_party_id: string;
    user_id: string;
    display_name: string | null;
  }[],
  hand: readonly {
    engagement_id: string;
    invoice_id: string;
    number: string | null;
    issued_on: string | null;
  }[],
  bills: readonly BillRow[],
  jobs: readonly JobRow[],
  filings: readonly FilingRow[],
): WbFacts {
  const km = new Map(keyManagers.map((k) => [k.client_party_id, person(k.user_id, k.display_name)]));
  const keyOfEngagement = new Map(engagements.map((e) => [e.id, subjectKeyOf(e.id, e.fee_group_id)]));

  const handBy = new Map<string, Map<string, { invoiceId: string; number: string | null; issuedOn: string | null }>>();
  for (const h of hand) {
    const key = keyOfEngagement.get(h.engagement_id);
    if (key === undefined) continue;
    const seen =
      handBy.get(key) ?? new Map<string, { invoiceId: string; number: string | null; issuedOn: string | null }>();
    seen.set(h.invoice_id, {
      invoiceId: h.invoice_id,
      number: h.number,
      issuedOn: h.issued_on,
    });
    handBy.set(key, seen);
  }

  const subjects = new Map<string, WbSubject>();
  for (const e of engagements) {
    const key = subjectKeyOf(e.id, e.fee_group_id);
    const engagement: WbEngagement = {
      engagementId: e.id,
      status: e.status,
      effectiveFrom: e.effective_from,
      endsOn: e.ends_on,
      pausedOn: e.paused_on,
      resumedOn: e.resumed_on,
    };
    const seen = subjects.get(key);
    if (seen !== undefined) {
      // A group's engagements carry one schedule; the earliest is taken, as
      // the sweep does.
      subjects.set(key, {
        ...seen,
        entityName: seen.entityName === e.entity_name ? seen.entityName : null,
        billingFrom: earliest(seen.billingFrom, e.billing_from),
        firstInvoiceOn: earliest(seen.firstInvoiceOn, e.first_invoice_on),
        yearStartMonth: seen.yearStartMonth ?? e.year_start_month,
        engagements: [...seen.engagements, engagement],
      });
      continue;
    }
    const invoices = [...(handBy.get(key)?.values() ?? [])].sort((a, b) =>
      (b.issuedOn ?? "9999").localeCompare(a.issuedOn ?? "9999"),
    );
    subjects.set(key, {
      key,
      engagementId: e.fee_group_id === null ? e.id : null,
      feeGroupId: e.fee_group_id,
      party: { id: e.party_id, displayName: e.party_name },
      serviceName: e.group_title ?? e.line_description,
      entityName: e.entity_name,
      letter: { id: e.letter_id, ref: e.letter_ref },
      frequency: e.frequency,
      billingFrom: e.billing_from,
      firstInvoiceOn: e.first_invoice_on,
      issuingEntityPartyId: e.issuing_entity_party_id,
      yearStartMonth: e.year_start_month,
      engagements: [engagement],
      keyManager: km.get(e.party_id) ?? null,
      handInvoices: { count: invoices.length, last: invoices[0] ?? null },
    });
  }

  const wbBills: WbBill[] = bills.map((b) => ({
    id: b.id,
    kind: b.kind,
    subjectKey:
      b.fee_group_id !== null
        ? `g:${b.fee_group_id}`
        : b.engagement_id !== null
          ? `e:${b.engagement_id}`
          : `l:${b.engagement_letter_id ?? b.id}`,
    party: { id: b.party_id, displayName: b.party_name },
    serviceName: b.service_name ?? "",
    entityName: b.entity_name,
    letter: {
      id: b.letter_id ?? b.engagement_letter_id ?? "",
      ref: b.letter_ref ?? "",
    },
    engagementIds: b.engagement_ids ?? [],
    periodStart: b.period_start,
    periodEnd: b.period_end,
    periodLabel: b.period_label,
    billOn: b.bill_on,
    datedByFilingId: b.dated_by_filing_id,
    status: b.status,
    currency: b.currency,
    amount: b.amount,
    fullAmount: b.full_amount,
    manager: person(b.manager_id, b.manager_name),
    skipped:
      b.skipped_at === null || b.skip_reason === null
        ? null
        : {
            at: b.skipped_at,
            by: person(b.skipped_by_id, b.skipped_by_name),
            reason: b.skip_reason,
          },
    invoice:
      b.invoice_id === null || b.invoice_status === null
        ? null
        : {
            id: b.invoice_id,
            number: b.invoice_number,
            status: b.invoice_status,
            issuedOn: b.issued_on,
            dueOn: b.due_on,
            invoiced: b.invoiced ?? "0",
            paid: b.paid ?? "0",
            outstanding: b.outstanding ?? "0",
            manager: person(b.invoice_manager_id, b.invoice_manager_name),
          },
    coveredBy: b.covered_invoice_id === null ? null : { invoiceId: b.covered_invoice_id, number: b.covered_number },
  }));

  const wbJobs: WbJob[] = jobs.map((j) => ({
    jobId: j.job_id,
    subjectKey: subjectKeyOf(j.engagement_id, j.fee_group_id),
    sourceKind: j.source_kind,
    status: j.status,
    periodStart: j.period_start,
    periodEnd: j.period_end,
    periodLabel: j.period_label,
    doneOn: j.done_on,
  }));

  const wbFilings: WbFiling[] = filings.flatMap((f) => {
    const keys = [...new Set(f.engagement_ids.flatMap((id) => keyOfEngagement.get(id) ?? []))];
    if (keys.length === 0) return [];
    return [
      {
        id: f.id,
        subjectKeys: keys,
        name: f.name,
        periodStart: f.period_start,
        periodEnd: f.period_end,
        periodLabel: f.period_label,
        dueOn: f.due_on,
        filedOn: f.filed_on,
        stateName: f.state_name,
        filed: f.is_filed,
        closed: f.is_terminal,
        jobStatus: f.job_status,
      },
    ];
  });

  return {
    autoBilling: firm?.auto_billing ?? false,
    autoBillingSince: firm?.auto_billing_since ?? null,
    subjects: [...subjects.values()],
    bills: wbBills,
    jobs: wbJobs,
    filings: wbFilings,
  };
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
