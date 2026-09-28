// The leadership dashboards (T3.7) — no I/O, no SQL, no HTTP. Everything
// outside arrives as an injected port.
//
// This service is thinner than most in this codebase, and that is correct
// rather than lazy. Its acceptance is "figures reconcile to underlying rows,
// not cached columns", so the arithmetic lives in the views (migration 0038)
// where the rows are. What is left here is the two things a view cannot do:
// assemble the figures into one answer, and apply the DSO definition.
import type { CompanyBilling, MonthBilling, Slice } from "../../domain/dashboard/model";
import { billingWindow, daysSalesOutstanding } from "../../domain/dashboard/model";
import { defaultCurrencyFor } from "../../domain/document/model";
import { dayInZone } from "../../domain/scheduler/zone";
import type { Clock } from "../../platform/clock";
import type { DashboardRepository, FirmTimeZone } from "./ports";

export interface Deps {
  readonly dashboards: DashboardRepository;
  /** For the one figure cut by month: which month the FIRM is in (T6.14). */
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
}

/** What `revenueByCompany` answers. */
export interface RevenueByCompany {
  readonly reportingCurrency: string;
  /** Oldest first, `YYYY-MM`, the last one the month the firm is in now. */
  readonly months: readonly string[];
  /** The whole firm, month by month, in the reporting currency. */
  readonly total: readonly {
    readonly month: string;
    readonly billedReporting: string;
    readonly invoiceCount: number;
  }[];
  readonly companies: readonly CompanyBilling[];
}

/**
 * The window DSO is measured over.
 *
 * 90 days rather than 365, because a compliance firm's billing is seasonal —
 * statutory deadlines cluster — and a year-long window smears a collections
 * problem that started last month into invisibility. Rather than 30, because a
 * single month can contain no billing at all for a firm whose work is
 * quarterly, and DSO over an empty month is not a number.
 *
 * Stated as a constant and not a parameter because it is a DEFINITION: two
 * screens computing DSO over different windows would produce two numbers that
 * are both called DSO and cannot be compared.
 */
export const DSO_WINDOW_DAYS = 90;

export interface Overview {
  readonly currency: string;
  readonly mrr: {
    readonly monthly: string;
    readonly countedEngagements: number;
    readonly gaps: readonly { readonly reason: string; readonly engagementCount: number }[];
  };
  readonly receivables: {
    readonly outstanding: string;
    readonly bands: readonly {
      readonly bucket: string;
      readonly amount: string;
      readonly invoiceCount: number;
    }[];
  };
  /**
   * Null when the firm has billed nothing in the window.
   *
   * Not zero. "0 days" reads as excellent collections; the truth is that there
   * is not enough billing to say, and a screen has to render those differently.
   */
  readonly dsoDays: number | null;
  readonly dsoWindowDays: number;
}

export class DashboardService {
  constructor(private readonly deps: Deps) {}

  async overview(tenantId: string): Promise<Overview> {
    // Fetched together: this is one screen, and five sequential round trips to
    // render one page is the shape that makes a dashboard feel slow.
    const [currency, mrr, receivables, sales] = await Promise.all([
      this.deps.dashboards.reportingCurrency(tenantId),
      this.deps.dashboards.mrr(tenantId),
      this.deps.dashboards.receivables(tenantId),
      this.deps.dashboards.creditSales(tenantId, DSO_WINDOW_DAYS),
    ]);

    return {
      currency,
      mrr: {
        monthly: mrr.monthly,
        countedEngagements: mrr.countedEngagements,
        // Sorted biggest first: a firm looking at what its MRR could not count
        // wants the largest hole named at the top.
        gaps: [...mrr.gaps]
          .sort((a, b) => b.engagementCount - a.engagementCount)
          .map((g) => ({ reason: g.reason, engagementCount: g.engagementCount })),
      },
      receivables: {
        outstanding: receivables.outstanding,
        bands: receivables.bands.map((b) => ({
          bucket: b.bucket,
          amount: b.amount,
          invoiceCount: b.invoiceCount,
        })),
      },
      dsoDays: daysSalesOutstanding({
        receivables: receivables.outstanding,
        creditSales: sales,
        periodDays: DSO_WINDOW_DAYS,
      }),
      dsoWindowDays: DSO_WINDOW_DAYS,
    };
  }

  /** The firm's own currency, on its own — so a route that needs only the
   *  label to put beside a table does not run the whole overview to get it. */
  async reportingCurrency(tenantId: string): Promise<string> {
    return this.deps.dashboards.reportingCurrency(tenantId);
  }

  /** MRR split by client or by service, biggest first. */
  async mrrBy(tenantId: string, axis: "client" | "service"): Promise<readonly Slice[]> {
    return this.deps.dashboards.mrrBy(tenantId, axis);
  }

  /** Who owes the firm money, biggest first. */
  async receivablesByClient(tenantId: string): Promise<readonly Slice[]> {
    return this.deps.dashboards.receivablesByClient(tenantId);
  }

  /**
   * What each of the firm's companies billed, month by month, over the last
   * `months` months (Wave 5): issued invoices, before tax, less credit notes
   * (the definition is on `MonthBilling`), each company in its own currency,
   * and the whole firm in the reporting currency.
   *
   * The months are cut on the FIRM's calendar, like every daily sweep since
   * T6.14. The adding up is SQL's; what is left here is assembly: which
   * currency a company bills in (D1's one table), and a month with no row
   * being a month of nothing, written "0" rather than left out, so every
   * company's series has every month.
   */
  async revenueByCompany(tenantId: string, months: number): Promise<RevenueByCompany> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    const window = billingWindow(dayInZone(this.deps.clock.now().toISOString(), zone), months);
    const [reportingCurrency, companies] = await Promise.all([
      this.deps.dashboards.reportingCurrency(tenantId),
      this.deps.dashboards.billingCompanies(tenantId, window),
    ]);
    const owns = companies.map((c) => ({
      partyId: c.partyId,
      currency: defaultCurrencyFor(c.jurisdiction, reportingCurrency),
    }));
    const rows = await this.deps.dashboards.billingByMonth(tenantId, window, owns, reportingCurrency);

    const cell = (partyId: string | null, month: string) =>
      rows.find((r) => r.partyId === partyId && r.month === month);

    return {
      reportingCurrency,
      months: window.months,
      total: window.months.map((month) => {
        const row = cell(null, month);
        return {
          month,
          billedReporting: row?.billedReporting ?? "0",
          invoiceCount: (row?.invoices ?? 0) + (row?.otherCurrencyInvoices ?? 0),
        };
      }),
      companies: companies.map((c, i) => ({
        partyId: c.partyId,
        name: c.name,
        jurisdiction: c.jurisdiction,
        currency: owns[i]?.currency ?? reportingCurrency,
        months: window.months.map((month): MonthBilling => {
          const row = cell(c.partyId, month);
          return {
            month,
            billed: row?.billed ?? "0",
            billedReporting: row?.billedReporting ?? "0",
            invoiceCount: row?.invoices ?? 0,
          };
        }),
        otherCurrencyInvoices: rows
          .filter((r) => r.partyId === c.partyId)
          .reduce((n, r) => n + r.otherCurrencyInvoices, 0),
      })),
    };
  }
}
