// In-memory fake for the leadership figures (T3.7). `implements` the port the
// Postgres adapter carries, so a compile error here is the same compile error
// production would get.
//
// IT HOLDS ANSWERS, NOT ROWS, and that is deliberate rather than lazy. The real
// adapter's whole job is aggregation in SQL — the arithmetic lives in the views
// (migration 0038) precisely so it is not duplicated in TypeScript. A fake that
// re-summed rows would be a second implementation of that arithmetic, and a
// service test passing against it would prove nothing about the figures a
// partner actually reads. Those are proven in
// `tests/dashboard/figures.integration.test.ts`, against real Postgres, which
// is the only place they CAN be proven.
import type { MrrGap, Slice } from "../domain/dashboard/model";
import { AGEING_BUCKETS } from "../domain/dashboard/model";
import type {
  BillingCompany,
  CompanyMonthRow,
  DashboardRepository,
  ManagerMonthRow,
  ManagerName,
  ManagerOwedRow,
  MrrTotals,
  ReceivableTotals,
} from "../usecase/dashboard/ports";

export class FakeDashboardRepo implements DashboardRepository {
  currency = "INR";
  monthly = "0";
  countedEngagements = 0;
  gaps: MrrGap[] = [];
  outstanding = "0";
  bandAmounts = new Map<string, { amount: string; invoiceCount: number }>();
  slices: Slice[] = [];
  sales = "0";
  /** Billing by company: the companies, and the rows SQL would have summed.
   *  `billingWindows` records every window asked for, so a test can see
   *  which months the service cut. */
  companies: BillingCompany[] = [];
  billingRows: CompanyMonthRow[] = [];
  billingWindows: { from: string; until: string }[] = [];
  billingOwns: { partyId: string; currency: string }[][] = [];
  /** Revenue by manager: the rows SQL would have summed, and the roster. */
  managerRows: ManagerMonthRow[] = [];
  owedRows: ManagerOwedRow[] = [];
  names: ManagerName[] = [];
  namesAsked: string[][] = [];

  reportingCurrency(): Promise<string> {
    return Promise.resolve(this.currency);
  }

  mrr(): Promise<MrrTotals> {
    return Promise.resolve({
      monthly: this.monthly,
      countedEngagements: this.countedEngagements,
      gaps: this.gaps,
    });
  }

  mrrBy(): Promise<readonly Slice[]> {
    return Promise.resolve(this.slices);
  }

  /** The day each ageing and credit-sales read was asked on. */
  readonly askedOn: string[] = [];

  receivables(_tenantId: string, day: string): Promise<ReceivableTotals> {
    this.askedOn.push(day);
    return Promise.resolve({
      outstanding: this.outstanding,
      // Every bucket, always — the real adapter guarantees it and a fake that
      // omitted the empty ones would let a screen test pass against a shape
      // production never produces.
      bands: AGEING_BUCKETS.map((bucket) => ({
        bucket,
        amount: this.bandAmounts.get(bucket)?.amount ?? "0",
        invoiceCount: this.bandAmounts.get(bucket)?.invoiceCount ?? 0,
      })),
    });
  }

  receivablesByClient(): Promise<readonly Slice[]> {
    return Promise.resolve(this.slices);
  }

  creditSales(_tenantId: string, _sinceDays: number, day: string): Promise<string> {
    this.askedOn.push(day);
    return Promise.resolve(this.sales);
  }

  billingCompanies(
    _tenantId: string,
    window: { from: string; until: string },
  ): Promise<readonly BillingCompany[]> {
    this.billingWindows.push({ from: window.from, until: window.until });
    return Promise.resolve(this.companies);
  }

  billingByMonth(
    _tenantId: string,
    _window: { from: string; until: string },
    owns: readonly { readonly partyId: string; readonly currency: string }[],
  ): Promise<readonly CompanyMonthRow[]> {
    this.billingOwns.push(owns.map((o) => ({ partyId: o.partyId, currency: o.currency })));
    return Promise.resolve(this.billingRows);
  }

  billingByManager(
    _tenantId: string,
    window: { from: string; until: string },
  ): Promise<readonly ManagerMonthRow[]> {
    this.billingWindows.push({ from: window.from, until: window.until });
    return Promise.resolve(this.managerRows);
  }

  owedByManager(): Promise<readonly ManagerOwedRow[]> {
    return Promise.resolve(this.owedRows);
  }

  managerNames(_tenantId: string, userIds: readonly string[]): Promise<readonly ManagerName[]> {
    this.namesAsked.push([...userIds]);
    return Promise.resolve(this.names.filter((n) => userIds.includes(n.userId)));
  }
}
