// The leadership dashboards (T3.7) — no I/O, no SQL, no HTTP. Everything
// outside arrives as an injected port.
//
// This service is thinner than most in this codebase, and that is correct
// rather than lazy. Its acceptance is "figures reconcile to underlying rows,
// not cached columns", so the arithmetic lives in the views (migration 0038)
// where the rows are. What is left here is the two things a view cannot do:
// assemble the figures into one answer, and apply the DSO definition.
import type { Slice } from "../../domain/dashboard/model";
import { daysSalesOutstanding } from "../../domain/dashboard/model";
import type { DashboardRepository } from "./ports";

export interface Deps {
  readonly dashboards: DashboardRepository;
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
}
