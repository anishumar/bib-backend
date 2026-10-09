// Postgres adapter for the leadership figures (T3.7), over 0038's views. Every query runs under
// `withTenant` so the views' `security_invoker = true` applies the row policies (a view without
// it runs as its owner, straight through the tenant wall). Sums come back from postgres.js as
// `numeric` strings and STAY strings: never coerce one to a JS number.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { AgeingBucket, MrrByCurrency, MrrExclusion, Slice } from "../../domain/dashboard/model";
import { AGEING_BUCKETS } from "../../domain/dashboard/model";
import type {
  BillingCompany,
  BillingWindowDays,
  CompanyMonthRow,
  DashboardRepository,
  ManagerMonthRow,
  ManagerName,
  ManagerOwedRow,
  MrrTotals,
  PersonCurrencyRow,
  ReceivableTotals,
  RevenueQuery,
} from "../../usecase/dashboard/ports";

export class PostgresDashboardRepository implements DashboardRepository {
  constructor(private readonly app: Db) {}

  async reportingCurrency(tenantId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ reporting_currency: string }[]>`
        SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (!row) {
        // Required at creation, no default anywhere (0009): a tenant without one cannot exist.
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
      // One pass, splitting counted from excluded; two queries could disagree mid-activation.
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
        // "0", not null: no recurring revenue is an MRR of zero; null would mean "unknown".
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
      // Two queries, not a CASE, because the JOIN differs; postgres.js sends a `${}` in a
      // table/column position as a value, so branch in TypeScript.
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

      // Grouped by config ENTRY, not version, so a republished service is not split per version.
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

  async mrrCurrencies(tenantId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ currency: string }[]>`
        SELECT DISTINCT currency FROM crm.engagement_mrr
         WHERE status = 'active' AND excluded_because IS NULL
      `;
      return rows.map((r) => r.currency);
    });
  }

  async mrrByCurrency(tenantId: string, day: string): Promise<MrrByCurrency> {
    return withTenant(this.app, tenantId, async (db) => {
      const [firm] = await db<{ code: string }[]>`
        SELECT reporting_currency AS code FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      const reporting = firm?.code ?? "INR";
      // ONE pass, three groupings: per currency, per client x currency, the firm. Same rows as
      // MRR (active, priced, recurring), so the signed-rate total IS the MRR card's figure.
      // Today's value: monthly amount at the latest rate on or before the firm's day
      // (`fx.rate_on`, 0345), rounded like the view.
      const rows = await db<
        {
          g_party: number;
          g_currency: number;
          party_id: string | null;
          name: string | null;
          currency: string | null;
          monthly: string | null;
          at_signed: string | null;
          at_today: string | null;
          n: number;
          fx_rate: string | null;
          rate_day: string | null;
          source: string | null;
        }[]
      >`
        WITH m AS (
          SELECT party_id, currency, monthly_amount, monthly_reporting
            FROM crm.engagement_mrr
           WHERE status = 'active' AND excluded_because IS NULL
        ),
        r AS (
          SELECT c.currency,
                 CASE WHEN c.currency = ${reporting} THEN 1::numeric ELSE q.fx_rate END AS fx_rate,
                 CASE WHEN c.currency = ${reporting} THEN ${day}::date ELSE q.rate_day END AS rate_day,
                 CASE WHEN c.currency = ${reporting} THEN 'Same currency' ELSE q.source END AS source
            FROM (SELECT DISTINCT currency FROM m) c
            LEFT JOIN LATERAL fx.rate_on(c.currency, ${reporting}, ${day}::date) q ON true
        )
        SELECT GROUPING(m.party_id)::int AS g_party, GROUPING(m.currency)::int AS g_currency,
               m.party_id, max(p.display_name) AS name, m.currency,
               sum(m.monthly_amount)::text AS monthly,
               sum(m.monthly_reporting)::text AS at_signed,
               CASE WHEN bool_and(r.fx_rate IS NOT NULL)
                    THEN sum(round(m.monthly_amount * r.fx_rate, 4))::text END AS at_today,
               count(*)::int AS n,
               max(r.fx_rate)::text AS fx_rate, max(r.rate_day)::text AS rate_day, max(r.source) AS source
          FROM m
          JOIN core.party p ON p.id = m.party_id
          JOIN r ON r.currency = m.currency
         GROUP BY GROUPING SETS ((m.currency), (m.party_id, m.currency), ())
         ORDER BY sum(m.monthly_reporting) DESC NULLS LAST, m.currency
      `;
      const total = rows.find((x) => x.g_party === 1 && x.g_currency === 1);
      const trim = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
      return {
        reportingCurrency: reporting,
        asOf: day,
        currencies: rows
          .filter((x) => x.g_party === 1 && x.g_currency === 0 && x.currency !== null)
          .sort((a, b) =>
            a.currency === reporting ? -1 : b.currency === reporting ? 1 : (a.currency ?? "").localeCompare(b.currency ?? ""),
          )
          .map((x) => ({
            currency: x.currency ?? "",
            monthly: x.monthly ?? "0",
            atSignedRates: x.at_signed ?? "0",
            atTodaysRate: x.at_today,
            todaysRate:
              x.fx_rate === null || x.rate_day === null || x.source === null
                ? null
                : { fxRate: trim(x.fx_rate), fxRateDate: x.rate_day, source: x.source },
            engagements: x.n,
          })),
        clients: rows
          .filter((x) => x.g_party === 0 && x.party_id !== null && x.currency !== null)
          .map((x) => ({
            partyId: x.party_id ?? "",
            name: x.name ?? "",
            currency: x.currency ?? "",
            monthly: x.monthly ?? "0",
            atSignedRates: x.at_signed ?? "0",
            atTodaysRate: x.at_today,
          })),
        totalAtSignedRates: total?.at_signed ?? "0",
        // No engagement at all: nothing is unvalued, so zero at any rate.
        totalAtTodaysRate: total === undefined || total.n === 0 ? "0" : total.at_today,
      };
    });
  }

  async receivables(tenantId: string, day: string): Promise<ReceivableTotals> {
    return withTenant(this.app, tenantId, async (db) => {
      // GROUPING SETS: buckets AND grand total in ONE pass (only the database adds money up).
      // `bucket IS NULL` is the total row.
      const rows = await db<{ bucket: string | null; total: string; n: string }[]>`
        SELECT bucket,
               COALESCE(sum(outstanding_reporting), 0)::text AS total,
               count(*)::text                                AS n
        FROM crm.receivable_ageing_on(${day}::date)
        GROUP BY GROUPING SETS ((bucket), ())
      `;
      const byBucket = new Map(
        rows.filter((r) => r.bucket !== null).map((r) => [r.bucket as string, r]),
      );
      const grand = rows.find((r) => r.bucket === null);

      return {
        outstanding: grand?.total ?? "0",
        // EVERY bucket in order, empty ones too: "nothing is 90+ days overdue" must show.
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

  async receivablesByClient(tenantId: string, day: string): Promise<readonly Slice[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ key: string; label: string; total: string; n: string }[]>`
        SELECT a.party_id       AS key,
               p.display_name   AS label,
               sum(a.outstanding_reporting)::text AS total,
               count(*)::text   AS n
        FROM crm.receivable_ageing_on(${day}::date) a
        JOIN core.party p ON p.id = a.party_id
        GROUP BY 1, 2
        ORDER BY sum(a.outstanding_reporting) DESC
      `;
      return rows.map((r) => this.toSlice(r));
    });
  }

  async creditSales(tenantId: string, sinceDays: number, day: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      // ONE query, subtraction in SQL. By `issued_on`, not `created_at` (raised in March, issued
      // in April is April's sale). Credit notes are netted off, or a reversed sale flatters DSO;
      // a scalar subquery, since a JOIN would multiply the invoice total per credit note.
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
          AND i.issued_on >= ${day}::date - ${sinceDays}::int
          AND i.issued_on <= ${day}::date
      `;
      return row?.total ?? "0";
    });
  }

  async billingCompanies(
    tenantId: string,
    window: BillingWindowDays,
  ): Promise<readonly BillingCompany[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The firm's companies per `crm.is_firm_entity` (the firm, or a live member of 0313's list),
      // not archived, plus any other issuer in the window, so no billed money is dropped.
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
      // BILLED (`MonthBilling`): issued invoices by `issued_on` month, pre-tax
      // (`invoice_totals.net`, after discount), less credit notes issued in the window by THEIR
      // month at their pre-tax share; a credit note on a since-cancelled invoice leaves with it.
      // `issued_on` is a `date` (no zone); the WINDOW is the firm's. Each document is rounded to
      // four places after conversion, as `crm.receivable_ageing` does, then summed.
      // Grouping sets (company, month) and (month). A company's `billed` takes its own-currency
      // documents, or all at stored rates when its currency is the reporting one; the rest are
      // counted and left out, never converted at a rate nothing stores.
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

  async billingByManager(
    tenantId: string,
    window: BillingWindowDays,
  ): Promise<readonly ManagerMonthRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // BILLED is `billingByMonth`'s, rounded the same way, so a month's managers add up to
      // "All companies" to the paisa. COLLECTED is cash by `received_on`, with tax, at the
      // invoice's stored rate (payments are in its currency, 0028). ISSUED only: a cancelled one
      // leaves every figure, payments too. Grouping sets (manager, month) and (month);
      // `GROUPING(manager)` tells the firm row from invoices naming no manager.
      const rows = await db<
        {
          manager: string | null;
          whole: number;
          month: string;
          billed: string;
          collected: string;
          invoices: number;
        }[]
      >`
        -- WHOSE each part is (0376, Q085): invoice_manager_share gives an
        -- ordinary invoice to its manager, and an advance to nobody until a
        -- bill takes some of it; that part is then the bill's manager's, in
        -- the month the bill counts (counts_on). An invoice is counted once.
        WITH docs AS (
          SELECT s.manager_user_id AS manager,
                 to_char(coalesce(s.counts_on, i.issued_on), 'YYYY-MM') AS month,
                 round(coalesce(s.net_share, 0) * i.fx_rate, 4) AS billed,
                 0::numeric AS collected,
                 CASE WHEN s.basis IN ('invoice', 'advance') THEN 1 ELSE 0 END AS invoices
          FROM crm.invoice i
          JOIN crm.invoice_manager_share s ON s.invoice_id = i.id AND s.tenant_id = i.tenant_id
          WHERE i.status = 'issued'
            AND coalesce(s.counts_on, i.issued_on) >= ${window.from}::date
            AND coalesce(s.counts_on, i.issued_on) <  ${window.until}::date
          UNION ALL
          SELECT CASE WHEN ai.invoice_id IS NULL THEN i.manager_user_id END,
                 to_char(c.issued_on, 'YYYY-MM'),
                 round(-round(CASE WHEN coalesce(t.total, 0) = 0 THEN c.amount
                                   ELSE c.amount * t.net / t.total END, 4) * i.fx_rate, 4),
                 0,
                 0
          FROM crm.credit_note c
          JOIN crm.invoice i ON i.id = c.invoice_id AND i.tenant_id = c.tenant_id
          LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
          LEFT JOIN crm.advance_invoice ai ON ai.invoice_id = i.id AND ai.tenant_id = i.tenant_id
          WHERE i.status = 'issued'
            AND c.issued_on >= ${window.from}::date
            AND c.issued_on <  ${window.until}::date
          UNION ALL
          SELECT CASE WHEN ai.invoice_id IS NULL THEN i.manager_user_id END,
                 to_char(p.received_on, 'YYYY-MM'),
                 0,
                 round(p.amount * i.fx_rate, 4),
                 0
          FROM crm.payment p
          JOIN crm.invoice i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
          LEFT JOIN crm.advance_invoice ai ON ai.invoice_id = i.id AND ai.tenant_id = i.tenant_id
          WHERE i.status = 'issued'
            AND p.received_on >= ${window.from}::date
            AND p.received_on <  ${window.until}::date
        )
        SELECT manager,
               GROUPING(manager)::int        AS whole,
               month,
               coalesce(sum(billed), 0)::text    AS billed,
               coalesce(sum(collected), 0)::text AS collected,
               sum(invoices)::int            AS invoices
        FROM docs
        GROUP BY GROUPING SETS ((manager, month), (month))
      `;
      return rows.map((r) => ({
        scope: r.whole === 1 ? ("firm" as const) : ("manager" as const),
        managerUserId: r.manager,
        month: r.month,
        billed: r.billed,
        collected: r.collected,
        invoices: r.invoices,
      }));
    });
  }

  async owedByManager(tenantId: string, day: string): Promise<readonly ManagerOwedRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // "Owed to the firm" (`receivables`) by manager: issued and owed, overpayments left out, at
      // stored rates. The empty grouping set always answers, so owed nothing is "0", not no row.
      const rows = await db<{ manager: string | null; whole: number; total: string; n: number }[]>`
        -- An advance's balance is nobody's (0376, Q085), as its revenue is.
        SELECT o.manager,
               GROUPING(o.manager)::int AS whole,
               coalesce(sum(o.outstanding_reporting), 0)::text AS total,
               count(o.invoice_id)::int AS n
        FROM (
          SELECT CASE WHEN ai.invoice_id IS NULL THEN i.manager_user_id END AS manager,
                 a.outstanding_reporting, a.invoice_id
            FROM crm.receivable_ageing_on(${day}::date) a
            JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id
            LEFT JOIN crm.advance_invoice ai ON ai.invoice_id = i.id AND ai.tenant_id = i.tenant_id
        ) o
        GROUP BY GROUPING SETS ((o.manager), ())
      `;
      return rows.map((r) => ({
        scope: r.whole === 1 ? ("firm" as const) : ("manager" as const),
        managerUserId: r.manager,
        outstanding: r.total,
        invoices: r.n,
      }));
    });
  }

  async managerNames(tenantId: string, userIds: readonly string[]): Promise<readonly ManagerName[]> {
    if (userIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // FROM membership (tenant-walled): `user_account` is global (ADR-02), so only THIS firm's
      // roster is named. No display name falls back to the email, as the invoice page shows.
      const rows = await db<{ user_id: string; name: string; active: boolean }[]>`
        SELECT m.user_id,
               coalesce(nullif(btrim(u.display_name), ''), u.email::text) AS name,
               bool_or(m.is_active) AS active
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        WHERE m.user_id = ANY(${userIds as string[]}::uuid[])
          AND m.audience = 'STAFF'
        GROUP BY m.user_id, u.display_name, u.email
      `;
      return rows.map((r) => ({ userId: r.user_id, name: r.name, activeStaff: r.active }));
    });
  }

  async revenueByPerson(tenantId: string, q: RevenueQuery): Promise<readonly PersonCurrencyRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Issued only, in their OWN currency: the GROUP BY carries currency, nothing is converted.
      const issuer = q.issuerPartyId === undefined ? db`` : db`AND i.entity_party_id = ${q.issuerPartyId}`;
      const currency = q.currency === undefined ? db`` : db`AND i.currency = ${q.currency}`;
      if (q.by === "manager") {
        const rows = await db<RevenueRow[]>`
          WITH inv AS (
            -- An advance's money and balance are nobody's (0376, Q085).
            SELECT i.id, CASE WHEN ai.invoice_id IS NULL THEN i.manager_user_id END AS who,
                   i.currency, i.issued_on
              FROM crm.invoice i
              LEFT JOIN crm.advance_invoice ai ON ai.invoice_id = i.id AND ai.tenant_id = i.tenant_id
             WHERE i.status = 'issued' ${issuer} ${currency}
          ), docs AS (
            -- WHOSE each part is (0376, Q085), as billingByManager reads it:
            -- an ordinary invoice to its manager; an advance to nobody until a
            -- bill takes some of it, then that part to the bill's manager on
            -- the day the bill counts. A moved part is revenue, not a second
            -- invoice, so only an invoice's own row is counted as one.
            SELECT s.manager_user_id AS who, inv.currency, inv.id AS invoice_id,
                   CASE WHEN s.basis IN ('invoice', 'advance') THEN 'invoiced' ELSE 'shared' END AS kind,
                   coalesce(s.net_share, 0) AS invoiced, 0::numeric AS collected, 0::numeric AS outstanding
              FROM inv
              JOIN crm.invoice_manager_share s ON s.invoice_id = inv.id
             WHERE coalesce(s.counts_on, inv.issued_on) BETWEEN ${q.from}::date AND ${q.to}::date
            UNION ALL
            SELECT inv.who, inv.currency, inv.id, 'credited',
                   -round(CASE WHEN coalesce(t.total, 0) = 0 THEN c.amount ELSE c.amount * t.net / t.total END, 4),
                   0, 0
              FROM crm.credit_note c
              JOIN inv ON inv.id = c.invoice_id
              LEFT JOIN crm.invoice_totals t ON t.invoice_id = inv.id
             WHERE c.issued_on BETWEEN ${q.from}::date AND ${q.to}::date
            UNION ALL
            SELECT inv.who, inv.currency, inv.id, 'paid', 0, p.amount, 0
              FROM crm.payment p
              JOIN inv ON inv.id = p.invoice_id
             WHERE p.received_on BETWEEN ${q.from}::date AND ${q.to}::date
            UNION ALL
            SELECT inv.who, inv.currency, inv.id, 'owed', 0, 0, a.outstanding
              FROM crm.receivable_ageing_on(${q.asOf}::date) a
              JOIN inv ON inv.id = a.invoice_id
          )
          SELECT who, GROUPING(who)::int AS whole, currency,
                 sum(invoiced)::text AS invoiced, sum(collected)::text AS collected,
                 sum(outstanding)::text AS outstanding,
                 (count(DISTINCT invoice_id) FILTER (WHERE kind = 'invoiced'))::int AS invoices
            FROM docs
           GROUP BY GROUPING SETS ((who, currency), (currency))
        `;
        return rows.map(toPersonRow);
      }
      // ORIGINATOR, line by line: a line's letter is its engagement's, else (fee group, letter-wide
      // advance) found via the bill it was raised from. Each line takes its share of credit notes
      // (of net), money and balance (of total), to four places. An advance before the letter
      // (0363) has one line on no engagement or bill: each mapping to a service or signed letter
      // is that letter's originator's at its effective amount, tax in the invoice's proportion;
      // unmapped stays with nobody.
      const rows = await db<RevenueRow[]>`
        WITH inv AS (
          SELECT i.id, i.currency, i.issued_on
            FROM crm.invoice i
           WHERE i.status = 'issued' ${issuer} ${currency}
        ), lines AS (
          SELECT la.invoice_id, inv.currency, inv.issued_on, la.net, la.net + la.tax AS gross,
                 t.total AS invoice_total, o.originator_user_id AS who
            FROM crm.invoice_line_amount la
            JOIN inv ON inv.id = la.invoice_id
            JOIN crm.invoice_totals t ON t.invoice_id = la.invoice_id
            JOIN crm.invoice_line il ON il.id = la.invoice_line_id
            LEFT JOIN crm.engagement e ON e.id = il.engagement_id AND e.tenant_id = il.tenant_id
            LEFT JOIN LATERAL (
              SELECT coalesce(d.engagement_letter_id, g.engagement_letter_id, de.engagement_letter_id) AS letter_id
                FROM crm.billing_due d
                LEFT JOIN crm.engagement_letter_fee_group g ON g.id = d.fee_group_id AND g.tenant_id = d.tenant_id
                LEFT JOIN crm.engagement de ON de.id = d.engagement_id AND de.tenant_id = d.tenant_id
               WHERE d.invoice_line_id = il.id AND d.tenant_id = il.tenant_id
               LIMIT 1
            ) bill ON true
            LEFT JOIN crm.letter_originator_in_force o
              ON o.engagement_letter_id = coalesce(e.engagement_letter_id, bill.letter_id)
             AND o.tenant_id = il.tenant_id
           WHERE NOT EXISTS (SELECT 1 FROM crm.adhoc_advance aa WHERE aa.invoice_id = la.invoice_id)
          UNION ALL
          SELECT part.invoice_id, inv.currency, inv.issued_on, part.net,
                 round(part.net * t.total / t.net, 4), t.total, o.originator_user_id
            FROM (
              SELECT al.invoice_id, al.tenant_id,
                     coalesce(al.engagement_letter_id, e.engagement_letter_id) AS letter_id,
                     sum(coalesce(al.kept_amount, al.amount)) AS net
                FROM crm.advance_allocation al
                LEFT JOIN crm.engagement e ON e.id = al.engagement_id AND e.tenant_id = al.tenant_id
               GROUP BY 1, 2, 3
              UNION ALL
              SELECT aa.invoice_id, aa.tenant_id, NULL::uuid,
                     t.net - coalesce((SELECT sum(coalesce(al.kept_amount, al.amount))
                                         FROM crm.advance_allocation al
                                        WHERE al.adhoc_advance_id = aa.id AND al.tenant_id = aa.tenant_id), 0)
                FROM crm.adhoc_advance aa
                JOIN crm.invoice_totals t ON t.invoice_id = aa.invoice_id AND t.tenant_id = aa.tenant_id
            ) part
            JOIN inv ON inv.id = part.invoice_id
            JOIN crm.invoice_totals t ON t.invoice_id = part.invoice_id
            LEFT JOIN crm.letter_originator_in_force o
              ON o.engagement_letter_id = part.letter_id AND o.tenant_id = part.tenant_id
           WHERE t.net > 0 AND part.net <> 0
        ), docs AS (
          SELECT l.who, l.currency, l.invoice_id, 'invoiced' AS kind,
                 l.net AS invoiced, 0::numeric AS collected, 0::numeric AS outstanding
            FROM lines l
           WHERE l.issued_on BETWEEN ${q.from}::date AND ${q.to}::date
          UNION ALL
          SELECT l.who, l.currency, l.invoice_id, 'credited',
                 -round(c.amount * l.net / l.invoice_total, 4), 0, 0
            FROM crm.credit_note c
            JOIN lines l ON l.invoice_id = c.invoice_id
           WHERE c.issued_on BETWEEN ${q.from}::date AND ${q.to}::date
             AND l.invoice_total > 0
          UNION ALL
          SELECT l.who, l.currency, l.invoice_id, 'paid', 0, round(p.amount * l.gross / l.invoice_total, 4), 0
            FROM crm.payment p
            JOIN lines l ON l.invoice_id = p.invoice_id
           WHERE p.received_on BETWEEN ${q.from}::date AND ${q.to}::date
             AND l.invoice_total > 0
          UNION ALL
          SELECT l.who, l.currency, l.invoice_id, 'owed', 0, 0, round(a.outstanding * l.gross / l.invoice_total, 4)
            FROM crm.receivable_ageing_on(${q.asOf}::date) a
            JOIN lines l ON l.invoice_id = a.invoice_id
           WHERE l.invoice_total > 0
        )
        SELECT who, GROUPING(who)::int AS whole, currency,
               sum(invoiced)::text AS invoiced, sum(collected)::text AS collected,
               sum(outstanding)::text AS outstanding,
               (count(DISTINCT invoice_id) FILTER (WHERE kind = 'invoiced'))::int AS invoices
          FROM docs
         GROUP BY GROUPING SETS ((who, currency), (currency))
      `;
      return rows.map(toPersonRow);
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

interface RevenueRow {
  who: string | null;
  whole: number;
  currency: string;
  invoiced: string;
  collected: string;
  outstanding: string;
  invoices: number;
}

function toPersonRow(r: RevenueRow): PersonCurrencyRow {
  return {
    scope: r.whole === 1 ? "currency" : "person",
    userId: r.who,
    currency: r.currency,
    invoiced: r.invoiced,
    collected: r.collected,
    outstanding: r.outstanding,
    invoices: r.invoices,
  };
}
