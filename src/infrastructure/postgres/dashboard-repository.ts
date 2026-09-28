// Postgres adapter for the leadership figures (T3.7), over the views migration
// 0038 creates.
//
// Every query goes through `withTenant`, so the views' `security_invoker = true`
// does its job: the row policies apply to the underlying tables and one firm's
// dashboard cannot see another's engagements. A view without that setting would
// run as its owner and be a hole straight through the tenant wall — which is
// why the migration says so twice.
//
// SUMS COME BACK AS STRINGS AND STAY STRINGS. `numeric` is returned as text by
// postgres.js precisely because it does not fit a JS number, and these are the
// figures a partner takes to a client. Coercing one to a number here would undo
// the whole arrangement at the last possible moment.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { AgeingBucket, MrrExclusion, Slice } from "../../domain/dashboard/model";
import { AGEING_BUCKETS } from "../../domain/dashboard/model";
import type {
  BillingCompany,
  BillingWindowDays,
  CompanyMonthRow,
  DashboardRepository,
  MrrTotals,
  ReceivableTotals,
} from "../../usecase/dashboard/ports";

export class PostgresDashboardRepository implements DashboardRepository {
  constructor(private readonly app: Db) {}

  async reportingCurrency(tenantId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ reporting_currency: string }[]>`
        SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (!row) {
        // Required at creation with no default anywhere in the stack (0009), so
        // a tenant without one is not a state this product can produce.
        throw new Error(
          `tenant ${tenantId} has no reporting currency, which migration 0009 makes NOT NULL — ` +
            `this row cannot be read under the policy that should match it`,
        );
      }
      return row.reporting_currency;
    });
  }

  async mrr(tenantId: string): Promise<MrrTotals> {
    return withTenant(this.app, tenantId, async (db) => {
      // One pass over the view, splitting counted from excluded. Two queries
      // would be two scans and could disagree if an engagement activated
      // between them.
      const rows = await db<
        { excluded_because: string | null; n: string; total: string | null }[]
      >`
        SELECT excluded_because,
               count(*)::text            AS n,
               sum(monthly_reporting)::text AS total
        FROM crm.engagement_mrr
        WHERE status = 'active'
        GROUP BY excluded_because
      `;

      const counted = rows.find((r) => r.excluded_because === null);
      return {
        // "0" and not null: a firm with no recurring revenue has an MRR of zero,
        // which is a fact. Null would mean "we could not work it out".
        monthly: counted?.total ?? "0",
        countedEngagements: Number(counted?.n ?? "0"),
        gaps: rows
          .filter((r): r is typeof r & { excluded_because: string } => r.excluded_because !== null)
          .map((r) => ({
            reason: r.excluded_because as MrrExclusion,
            engagementCount: Number(r.n),
          })),
      };
    });
  }

  async mrrBy(tenantId: string, axis: "client" | "service"): Promise<readonly Slice[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Two shapes rather than one query with a CASE, because the JOIN differs.
      // A `${}` in a table or column position would not be parameterised anyway
      // — postgres.js would send it as a value — so branching in TypeScript is
      // both the safe way and the readable one.
      if (axis === "client") {
        const rows = await db<{ key: string; label: string; total: string; n: string }[]>`
          SELECT m.party_id            AS key,
                 p.display_name        AS label,
                 sum(m.monthly_reporting)::text AS total,
                 count(*)::text        AS n
          FROM crm.engagement_mrr m
          JOIN core.party p ON p.id = m.party_id
          WHERE m.status = 'active' AND m.excluded_because IS NULL
          GROUP BY 1, 2
          ORDER BY sum(m.monthly_reporting) DESC
        `;
        return rows.map((r) => this.toSlice(r));
      }

      // Grouped by the config ENTRY, not the version: a firm that republished a
      // service would otherwise see it split into one slice per version, which
      // is an artefact of our versioning and not a fact about its revenue.
      const rows = await db<{ key: string; label: string; total: string; n: string }[]>`
        SELECT e.id                    AS key,
               e.key                   AS label,
               sum(m.monthly_reporting)::text AS total,
               count(*)::text          AS n
        FROM crm.engagement_mrr m
        JOIN config.version v ON v.id = m.service_version_id
        JOIN config.entry   e ON e.id = v.entry_id
        WHERE m.status = 'active' AND m.excluded_because IS NULL
        GROUP BY 1, 2
        ORDER BY sum(m.monthly_reporting) DESC
      `;
      return rows.map((r) => this.toSlice(r));
    });
  }

  async receivables(tenantId: string): Promise<ReceivableTotals> {
    return withTenant(this.app, tenantId, async (db) => {
      // GROUPING SETS, so the per-bucket rows AND the grand total come from ONE
      // pass over the view. Two queries could disagree if a payment landed
      // between them, and summing the buckets in TypeScript would break the
      // rule this product keeps everywhere else: only the database adds money
      // up. `bucket IS NULL` is the total row.
      const rows = await db<{ bucket: string | null; total: string; n: string }[]>`
        SELECT bucket,
               COALESCE(sum(outstanding_reporting), 0)::text AS total,
               count(*)::text                                AS n
        FROM crm.receivable_ageing
        GROUP BY GROUPING SETS ((bucket), ())
      `;
      const byBucket = new Map(
        rows.filter((r) => r.bucket !== null).map((r) => [r.bucket as string, r]),
      );
      const grand = rows.find((r) => r.bucket === null);

      return {
        outstanding: grand?.total ?? "0",
        // EVERY bucket, in order, including the empty ones. A screen showing
        // only non-empty bands would silently change shape as debt moves, and
        // "nothing is 90+ days overdue" is the single most reassuring row on
        // this table — it has to be visible, not absent.
        bands: AGEING_BUCKETS.map((bucket: AgeingBucket) => {
          const row = byBucket.get(bucket);
          return {
            bucket,
            amount: row?.total ?? "0",
            invoiceCount: Number(row?.n ?? "0"),
          };
        }),
      };
    });
  }

  async receivablesByClient(tenantId: string): Promise<readonly Slice[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ key: string; label: string; total: string; n: string }[]>`
        SELECT a.party_id       AS key,
               p.display_name   AS label,
               sum(a.outstanding_reporting)::text AS total,
               count(*)::text   AS n
        FROM crm.receivable_ageing a
        JOIN core.party p ON p.id = a.party_id
        GROUP BY 1, 2
        ORDER BY sum(a.outstanding_reporting) DESC
      `;
      return rows.map((r) => this.toSlice(r));
    });
  }

  async creditSales(tenantId: string, sinceDays: number): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      // ONE query, and the subtraction happens in SQL. Fetching gross and
      // credits separately and subtracting in TypeScript would be the same
      // mistake the ageing total nearly shipped with: only the database adds
      // money up, because a float cannot hold what these values are.
      //
      // `issued_on` and not `created_at` — a draft raised in March and issued in
      // April is April's sale. Credit notes are netted off rather than ignored:
      // a sale that was reversed was not a sale, and leaving it in the
      // denominator would flatter DSO.
      //
      // The credit-note total is a scalar subquery rather than a JOIN, because
      // joining an invoice to its many credit notes would multiply the invoice
      // total by the number of them.
      const [row] = await db<{ total: string }[]>`
        SELECT COALESCE(sum(
                 (t.total - COALESCE(
                    (SELECT sum(c.amount)
                     FROM crm.credit_note c
                     WHERE c.invoice_id = i.id AND c.tenant_id = i.tenant_id), 0)
                 ) * i.fx_rate
               ), 0)::text AS total
        FROM crm.invoice i
        JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
        WHERE i.status NOT IN ('draft', 'cancelled')
          AND i.issued_on IS NOT NULL
          AND i.issued_on >= CURRENT_DATE - ${sinceDays}::int
      `;
      return row?.total ?? "0";
    });
  }

  async billingCompanies(
    tenantId: string,
    window: BillingWindowDays,
  ): Promise<readonly BillingCompany[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The firm's companies as `crm.is_firm_entity` defines them (the firm
      // itself, or a live member of 0313's list), not archived; and whoever
      // else issued an invoice in the window, so no billed money is dropped
      // because its company was put away since.
      const rows = await db<{ party_id: string; name: string; jurisdiction: string | null }[]>`
        SELECT p.id AS party_id, p.display_name AS name, le.jurisdiction
        FROM core.party p
        LEFT JOIN core.organization o ON o.party_id = p.id
        LEFT JOIN core.legal_entity le ON le.party_id = p.id
        WHERE (crm.is_firm_entity(${tenantId}, p.id) AND p.archived_at IS NULL)
           OR p.id IN (SELECT i.entity_party_id FROM crm.invoice i
                        WHERE i.status = 'issued'
                          AND i.issued_on >= ${window.from}::date
                          AND i.issued_on <  ${window.until}::date)
        ORDER BY coalesce(o.is_firm_self, false) DESC, p.display_name
      `;
      return rows.map((r) => ({ partyId: r.party_id, name: r.name, jurisdiction: r.jurisdiction }));
    });
  }

  async billingByMonth(
    tenantId: string,
    window: BillingWindowDays,
    owns: readonly { readonly partyId: string; readonly currency: string }[],
    reportingCurrency: string,
  ): Promise<readonly CompanyMonthRow[]> {
    if (owns.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // BILLED, as the domain defines it (`MonthBilling`): issued invoices by
      // the month of `issued_on`, before tax (`invoice_totals.net`, after
      // discount), less the credit notes issued in the window by THEIR month,
      // each at its pre-tax share of the invoice it credits. A credit note on
      // an invoice cancelled since is left out with the invoice: the whole
      // sale is already gone. `issued_on` is a `date`, so its month is the
      // same for everybody and needs no zone; the WINDOW is the firm's.
      //
      // Every document is rounded to four places after its conversion, as
      // `crm.receivable_ageing` does, then summed: the month is the sum of
      // the documents a person could list, not a rounding of a longer sum.
      //
      // ONE pass, two grouping sets: (company, month) and (month) for the
      // whole firm. A company's `billed` takes its own-currency documents,
      // or all of them at their stored rates when its currency is the
      // reporting currency (the rate IS the conversion); the rest are counted
      // and left out of `billed`, never converted at a rate nothing stores.
      const rows = await db<
        {
          party_id: string | null;
          month: string;
          billed: string | null;
          billed_reporting: string;
          invoices: number;
          other_invoices: number;
        }[]
      >`
        WITH own AS (
          SELECT * FROM unnest(${owns.map((o) => o.partyId)}::uuid[],
                               ${owns.map((o) => o.currency)}::text[]) AS o(party_id, currency)
        ),
        docs AS (
          SELECT i.entity_party_id AS party_id, i.currency, i.fx_rate,
                 to_char(i.issued_on, 'YYYY-MM') AS month,
                 coalesce(t.net, 0) AS net,
                 1 AS invoices
          FROM crm.invoice i
          LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
          WHERE i.status = 'issued'
            AND i.issued_on >= ${window.from}::date
            AND i.issued_on <  ${window.until}::date
          UNION ALL
          SELECT i.entity_party_id, i.currency, i.fx_rate,
                 to_char(c.issued_on, 'YYYY-MM'),
                 -round(CASE WHEN coalesce(t.total, 0) = 0 THEN c.amount
                             ELSE c.amount * t.net / t.total END, 4),
                 0
          FROM crm.credit_note c
          JOIN crm.invoice i ON i.id = c.invoice_id AND i.tenant_id = c.tenant_id
          LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
          WHERE i.status = 'issued'
            AND c.issued_on >= ${window.from}::date
            AND c.issued_on <  ${window.until}::date
        ),
        placed AS (
          SELECT d.party_id AS company, d.month, d.net, d.fx_rate, d.invoices,
                 (o.currency = ${reportingCurrency} OR d.currency = o.currency) AS counts,
                 CASE WHEN d.currency = o.currency THEN d.net
                      ELSE round(d.net * d.fx_rate, 4) END AS in_own
          FROM docs d
          JOIN own o ON o.party_id = d.party_id
        )
        SELECT company AS party_id,
               month,
               CASE WHEN GROUPING(company) = 0
                    THEN coalesce(sum(in_own) FILTER (WHERE counts), 0)::text END AS billed,
               coalesce(sum(round(net * fx_rate, 4)), 0)::text AS billed_reporting,
               (count(*) FILTER (WHERE counts AND invoices = 1))::int AS invoices,
               (count(*) FILTER (WHERE NOT counts AND invoices = 1))::int AS other_invoices
        FROM placed
        GROUP BY GROUPING SETS ((company, month), (month))
      `;
      return rows.map((r) => ({
        partyId: r.party_id,
        month: r.month,
        billed: r.billed,
        billedReporting: r.billed_reporting,
        invoices: r.invoices,
        otherCurrencyInvoices: r.other_invoices,
      }));
    });
  }

  private toSlice(r: { key: string; label: string; total: string; n: string }): Slice {
    return {
      key: r.key,
      label: r.label,
      amount: r.total,
      count: Number(r.n),
    };
  }
}
