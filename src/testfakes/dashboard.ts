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
import type { MrrByCurrency } from "../domain/dashboard/model";
import type { MrrGap, Slice } from "../domain/dashboard/model";
import { AGEING_BUCKETS } from "../domain/dashboard/model";
import type {
  AccountTeams,
  BillingCompany,
  ClientSummaryQuery,
  ClientSummaryRow,
  SubjectNames,
  CompanyMonthRow,
  DashboardRepository,
  ManagerMonthRow,
  ManagerName,
  ManagerOwedRow,
  MrrTotals,
  PersonCurrencyRow,
  ReceivableTotals,
  RevenueQuery,
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
  /** The by-currency report as a test sets it (0345), and the days asked. */
  byCurrency: MrrByCurrency | null = null;
  byCurrencyDays: string[] = [];
  mrrCurrencyList: string[] = [];

  mrrCurrencies(): Promise<readonly string[]> {
    return Promise.resolve(this.mrrCurrencyList);
  }

  mrrByCurrency(_tenantId: string, day: string): Promise<MrrByCurrency> {
    this.byCurrencyDays.push(day);
    return Promise.resolve(
      this.byCurrency ?? {
        reportingCurrency: this.currency,
        asOf: day,
        currencies: [],
        clients: [],
        totalAtSignedRates: "0",
        totalAtTodaysRate: "0",
      },
    );
  }
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

  /** The revenue report's rows (Q049) as a test sets them, per `by`, and
   *  every query asked. */
  personRows: { manager: PersonCurrencyRow[]; originator: PersonCurrencyRow[] } = { manager: [], originator: [] };
  revenueAsked: RevenueQuery[] = [];

  revenueByPerson(_tenantId: string, q: RevenueQuery): Promise<readonly PersonCurrencyRow[]> {
    this.revenueAsked.push(q);
    return Promise.resolve(this.personRows[q.by].filter((r) => q.currency === undefined || r.currency === q.currency));
  }

  /** The client summary's rows as SQL would have summed them, and the asks. */
  summaryRows: ClientSummaryRow[] = [];
  summaryAsked: ClientSummaryQuery[] = [];
  teams: AccountTeams = { people: [], depts: [] };

  clientSummary(_tenantId: string, q: ClientSummaryQuery): Promise<readonly ClientSummaryRow[]> {
    this.summaryAsked.push(q);
    return Promise.resolve(this.summaryRows);
  }

  subjects: SubjectNames = { engagements: [], feeGroups: [] };

  subjectNames(): Promise<SubjectNames> {
    return Promise.resolve(this.subjects);
  }

  accountTeams(_tenantId: string, clientIds: readonly string[]): Promise<AccountTeams> {
    return Promise.resolve({
      people: this.teams.people.filter((p) => clientIds.includes(p.clientPartyId)),
      depts: this.teams.depts,
    });
  }
}
