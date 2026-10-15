// The leadership dashboards (T3.7) — no I/O, no SQL, no HTTP. Everything
// outside arrives as an injected port.
//
// This service is thinner than most in this codebase, and that is correct
// rather than lazy. Its acceptance is "figures reconcile to underlying rows,
// not cached columns", so the arithmetic lives in the views (migration 0038)
// where the rows are. What is left here is the two things a view cannot do:
// assemble the figures into one answer, and apply the DSO definition.
import type {
  CompanyBilling,
  ManagerMonth,
  ManagerRevenue,
  MonthBilling,
  MrrByCurrency,
  Slice,
} from "../../domain/dashboard/model";
import { billingWindow, daysSalesOutstanding } from "../../domain/dashboard/model";
import { assignedQuarterStart, billingDues, serviceWindowOf } from "../../domain/billing/model";
import { yearStartOfCompany } from "../../domain/calendar/model";
import { addAmounts, proratedAmount } from "../../domain/money/model";
import { monthsPerPeriod, recurrenceOfService } from "../../domain/scheduler/model";
import { billingPeriods } from "../billing/periods";
import type { BillingSubject } from "../billing/ports";
import { defaultCurrencyFor } from "../../domain/document/model";
import { dayInZone } from "../../domain/scheduler/zone";
import type { Clock } from "../../platform/clock";
import type {
  BillingScheduleSource,
  ClientSummaryRow,
  CompanyCalendarSource,
  DashboardRepository,
  FirmTimeZone,
  FiscalYearSource,
  ManagerMonthRow,
  PersonCurrencyRow,
  RateWarmer,
  SummaryKind,
} from "./ports";

export interface Deps {
  readonly dashboards: DashboardRepository;
  /** For the figures cut by month: which month the FIRM is in (T6.14). */
  readonly timeZones: FirmTimeZone;
  /** The firm's own financial year, so revenue can be read "this financial
   *  year" in any country (India April, the UK April, the US January). */
  readonly fiscalYears: FiscalYearSource;
  readonly clock: Clock;
  /** Today's rates, asked before the by-currency report reads them (0345).
   *  Absent: the report reads whatever rates are held. */
  readonly rates?: RateWarmer | undefined;
  /** The billing schedules and the companies' calendars, for the projection.
   *  Absent: the projection is not offered (a service built without it). */
  readonly billing?: { readonly schedules: BillingScheduleSource; readonly calendars: CompanyCalendarSource } | undefined;
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

/** What `revenueByManager` answers. Every amount in `reportingCurrency`. */
export interface RevenueByManager {
  readonly reportingCurrency: string;
  /** Oldest first, `YYYY-MM`, the last one the month the firm is in now. */
  readonly months: readonly string[];
  /** The month (1-12) the firm's financial year starts, from its compliance
   *  policy; null when the firm has not said. */
  readonly financialYearStartMonth: number | null;
  /** The whole firm: what every manager's row (and the no-manager row) adds up to. */
  readonly total: {
    readonly months: readonly ManagerMonth[];
    readonly outstanding: string;
    readonly outstandingInvoices: number;
  };
  /** By name, the invoices naming nobody last. Only people with something in
   *  the window or something owed now: a firm's ladder is its own, so who
   *  counts as "a manager" is whoever invoices name. */
  readonly managers: readonly ManagerRevenue[];
}

/** One person's figures in one currency (Q049). Amounts are decimal strings in
 *  `currency`, never converted. */
export interface RevenueRow {
  /** Null: invoices (or lines) naming nobody. */
  readonly userId: string | null;
  /** This firm's roster's name; null for nobody, or an id it cannot name. */
  readonly name: string | null;
  readonly activeStaff: boolean;
  readonly currency: string;
  readonly invoiced: string;
  readonly collected: string;
  readonly outstanding: string;
  readonly invoices: number;
}

/** What `revenueReport` answers. */
export interface RevenueReport {
  readonly by: "manager" | "originator";
  readonly from: string;
  readonly to: string;
  /** The day OUTSTANDING is owed at the close of: `to`, or today if sooner. */
  readonly asOf: string;
  readonly financialYearStartMonth: number | null;
  /** One per currency, the firm's whole: each person's rows of the currency
   *  add up to it. Never one figure across currencies. */
  readonly currencies: readonly Omit<RevenueRow, "userId" | "name" | "activeStaff">[];
  /** By name, nobody last, then by currency. */
  readonly rows: readonly RevenueRow[];
}

/** One currency's figures (`ClientSummaryQuery` defines them), as decimal strings. */
export interface SummaryFigures {
  readonly currency: string;
  readonly billed: string;
  readonly received: string;
  readonly tds: string;
  readonly pending: string;
  readonly overdue: string;
  readonly invoices: number;
}

export interface SummaryPerson {
  readonly userId: string;
  readonly name: string;
}

/** One client's one service (or section, advance, other) in one currency. */
export interface ClientSummaryLine extends SummaryFigures {
  readonly kind: SummaryKind;
  /** The catalogue entry or the section's id; empty for an advance or other. */
  readonly key: string;
  readonly name: string | null;
  /** A section's services. */
  readonly services: readonly string[];
  readonly depts: readonly { readonly code: string; readonly name: string }[];
  /** The client's SPOCs for the Depts of this work. */
  readonly spocs: readonly (SummaryPerson & { readonly deptCode: string })[];
}

export interface ClientSummaryClient {
  readonly partyId: string;
  readonly name: string;
  readonly keyManager: SummaryPerson | null;
  /** One per currency the client's lines are in. */
  readonly totals: readonly SummaryFigures[];
  readonly lines: readonly ClientSummaryLine[];
}

/** What `clientSummary` answers. */
export interface ClientSummary {
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  readonly financialYearStartMonth: number | null;
  /** The firm's whole, one per currency: every client's totals add up to it. */
  readonly currencies: readonly SummaryFigures[];
  /** By name. */
  readonly clients: readonly ClientSummaryClient[];
}

const KIND_ORDER: Readonly<Record<SummaryKind, number>> = { service: 0, section: 1, advance: 2, other: 3 };

/** A month of the projection; the first starts today and runs to its end. */
export interface ProjectionMonth {
  /** `YYYY-MM`. */
  readonly key: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** Fees to be billed, before tax, one amount per projection month. */
export interface ProjectedFigures {
  readonly currency: string;
  readonly months: readonly string[];
  readonly total: string;
}

export interface ProjectionLine extends ProjectedFigures {
  readonly kind: "service" | "section";
  readonly key: string;
  readonly name: string;
  readonly services: readonly string[];
  readonly depts: readonly { readonly code: string; readonly name: string }[];
  readonly spocs: readonly (SummaryPerson & { readonly deptCode: string })[];
  /** Bills in the window whose letter named no price ("as mutually agreed"). */
  readonly unpriced: number;
}

export interface ProjectionClient {
  readonly partyId: string;
  readonly name: string;
  readonly keyManager: SummaryPerson | null;
  readonly totals: readonly ProjectedFigures[];
  readonly lines: readonly ProjectionLine[];
}

/** What `projection` answers. */
export interface ClientProjection {
  readonly today: string;
  readonly months: readonly ProjectionMonth[];
  readonly currencies: readonly ProjectedFigures[];
  /** By name. */
  readonly clients: readonly ProjectionClient[];
  /** Quarterly or yearly services left out: no financial year to cut them on. */
  readonly awaitingFiscalYear: number;
}

/** How far ahead a projection may look, in whole months after this one. */
export const PROJECTION_MAX_MONTHS = 12;

type ProjectionDraft = {
  partyId: string;
  partyName: string;
  kind: "service" | "section";
  key: string;
  name: string;
  services: readonly string[];
  codes: readonly string[];
  currency: string;
  months: string[];
  unpriced: number;
};

/** How far back a report may reach in one read: three years. */
export const REVENUE_REPORT_MAX_DAYS = 3 * 366;

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
    // ONE day for both, the firm's (B29): ageing and the DSO window used
    // CURRENT_DATE, the database's day, which is not the firm's.
    const today = await this.firmDay(tenantId);
    const [currency, mrr, receivables, sales] = await Promise.all([
      this.deps.dashboards.reportingCurrency(tenantId),
      this.deps.dashboards.mrr(tenantId),
      this.deps.dashboards.receivables(tenantId, today),
      this.deps.dashboards.creditSales(tenantId, DSO_WINDOW_DAYS, today),
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

  /**
   * Recurring fees by currency (0345, Q009): each currency in itself, at the
   * rates the letters were signed at (what MRR counts, unchanged), and at
   * today's rate, with that rate's date and source. Today's rate is asked of
   * the exchange-rate service first, so a feed day not yet fetched is.
   */
  async mrrByCurrency(tenantId: string): Promise<MrrByCurrency> {
    const today = await this.firmDay(tenantId);
    const rates = this.deps.rates;
    if (rates !== undefined) {
      const [reporting, currencies] = await Promise.all([
        this.deps.dashboards.reportingCurrency(tenantId),
        this.deps.dashboards.mrrCurrencies(tenantId),
      ]);
      await Promise.all(
        currencies.filter((c) => c !== reporting).map((c) => rates.quotePair(c, reporting, today)),
      );
    }
    return this.deps.dashboards.mrrByCurrency(tenantId, today);
  }

  /** Who owes the firm money, biggest first. */
  async receivablesByClient(tenantId: string): Promise<readonly Slice[]> {
    return this.deps.dashboards.receivablesByClient(tenantId, await this.firmDay(tenantId));
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
  /**
   * Revenue by manager (auto-invoice T4): what each manager's invoices billed
   * and collected, month by month over the last `months` months, and what they
   * are owed now. Grouped on `crm.invoice.manager_user_id`, the manager frozen
   * on the invoice at issue. The definitions are `ManagerMonth`'s and
   * `ManagerRevenue`'s; the adding up is SQL's, and this assembles: names,
   * zeros for empty months, and the order.
   */
  async revenueByManager(tenantId: string, months: number): Promise<RevenueByManager> {
    const window = await this.window(tenantId, months);
    const [reportingCurrency, rows, owed, financialYearStartMonth] = await Promise.all([
      this.deps.dashboards.reportingCurrency(tenantId),
      this.deps.dashboards.billingByManager(tenantId, window),
      this.deps.dashboards.owedByManager(tenantId, await this.firmDay(tenantId)),
      this.deps.fiscalYears.fiscalYearStartMonth(tenantId),
    ]);

    const managerRows = rows.filter((r) => r.scope === "manager");
    const owedRows = owed.filter((r) => r.scope === "manager");
    const ids = new Set<string | null>([
      ...managerRows.map((r) => r.managerUserId),
      ...owedRows.map((r) => r.managerUserId),
    ]);
    const named = [...ids].filter((id): id is string => id !== null);
    const names = new Map(
      (await this.deps.dashboards.managerNames(tenantId, named)).map((n) => [n.userId, n]),
    );

    const series = (pick: (r: ManagerMonthRow) => boolean): ManagerMonth[] =>
      window.months.map((month) => {
        const row = rows.find((r) => r.month === month && pick(r));
        return {
          month,
          billed: row?.billed ?? "0",
          collected: row?.collected ?? "0",
          invoiceCount: row?.invoices ?? 0,
        };
      });

    const managers: ManagerRevenue[] = [...ids].map((userId) => {
      const person = userId === null ? undefined : names.get(userId);
      const due = owedRows.find((r) => r.managerUserId === userId);
      return {
        userId,
        name: person?.name ?? null,
        activeStaff: person?.activeStaff ?? false,
        months: series((r) => r.scope === "manager" && r.managerUserId === userId),
        outstanding: due?.outstanding ?? "0",
        outstandingInvoices: due?.invoices ?? 0,
      };
    });
    // By name, case-blind; the row naming nobody last, and an id the roster
    // cannot name just before it.
    const rank = (m: ManagerRevenue): number => (m.userId === null ? 2 : m.name === null ? 1 : 0);
    managers.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" }),
    );

    const firmOwed = owed.find((r) => r.scope === "firm");
    return {
      reportingCurrency,
      months: window.months,
      financialYearStartMonth,
      total: {
        months: series((r) => r.scope === "firm"),
        outstanding: firmOwed?.outstanding ?? "0",
        outstandingInvoices: firmOwed?.invoices ?? 0,
      },
      managers,
    };
  }

  /**
   * THE REVENUE REPORT (Q049; Ashish: "revenue is captured manager-wise and
   * salesperson-wise"): invoiced, collected and outstanding per manager (the
   * invoice's) or per originator (the letter's, 0355), per CURRENCY. The
   * definitions are `RevenueQuery`'s; the adding up is SQL's. A period not
   * given is this financial year to date (the firm's own year), else the last
   * twelve months.
   */
  async revenueReport(
    tenantId: string,
    q: {
      readonly by: "manager" | "originator";
      readonly from?: string | undefined;
      readonly to?: string | undefined;
      readonly issuerPartyId?: string | undefined;
      readonly currency?: string | undefined;
    },
  ): Promise<RevenueReport> {
    const today = await this.firmDay(tenantId);
    const financialYearStartMonth = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const to = q.to ?? today;
    const from = q.from ?? yearToDateFrom(to, financialYearStartMonth);
    const asOf = to < today ? to : today;
    const rows = await this.deps.dashboards.revenueByPerson(tenantId, {
      by: q.by,
      from,
      to,
      asOf,
      issuerPartyId: q.issuerPartyId,
      currency: q.currency,
    });
    const people = rows.filter((r) => r.scope === "person");
    const named = [...new Set(people.map((r) => r.userId))].filter((id): id is string => id !== null);
    const names = new Map((await this.deps.dashboards.managerNames(tenantId, named)).map((n) => [n.userId, n]));
    const out: RevenueRow[] = people.map((r) => {
      const person = r.userId === null ? undefined : names.get(r.userId);
      return {
        userId: r.userId,
        name: person?.name ?? null,
        activeStaff: person?.activeStaff ?? false,
        currency: r.currency,
        invoiced: r.invoiced,
        collected: r.collected,
        outstanding: r.outstanding,
        invoices: r.invoices,
      };
    });
    const rank = (r: RevenueRow): number => (r.userId === null ? 2 : r.name === null ? 1 : 0);
    out.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" }) ||
        a.currency.localeCompare(b.currency),
    );
    const currencies = rows
      .filter((r) => r.scope === "currency")
      .map(({ currency, invoiced, collected, outstanding, invoices }: PersonCurrencyRow) => ({
        currency,
        invoiced,
        collected,
        outstanding,
        invoices,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
    return { by: q.by, from, to, asOf, financialYearStartMonth, currencies, rows: out };
  }

  /**
   * THE CLIENT SUMMARY: per client and per service, what was billed, what came
   * in and what is still owed, beside who looks after the client (its Key
   * Manager) and who the client rings for that work (the SPOC of its Dept).
   * The period is the revenue report's: this financial year to date unless
   * given. The adding up is SQL's; this puts names on it and orders it.
   */
  async clientSummary(
    tenantId: string,
    q: {
      readonly from?: string | undefined;
      readonly to?: string | undefined;
      readonly partyId?: string | undefined;
      readonly issuerPartyId?: string | undefined;
      readonly currency?: string | undefined;
      readonly keyManagerUserId?: string | undefined;
      readonly spocUserId?: string | undefined;
    },
  ): Promise<ClientSummary> {
    const today = await this.firmDay(tenantId);
    const financialYearStartMonth = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const to = q.to ?? today;
    const from = q.from ?? yearToDateFrom(to, financialYearStartMonth);
    const asOf = to < today ? to : today;
    const rows = await this.deps.dashboards.clientSummary(tenantId, {
      from,
      to,
      asOf,
      today,
      partyId: q.partyId,
      issuerPartyId: q.issuerPartyId,
      currency: q.currency,
      keyManagerUserId: q.keyManagerUserId,
      spocUserId: q.spocUserId,
    });
    const clientIds = [...new Set(rows.flatMap((r) => (r.partyId === null ? [] : [r.partyId])))];
    const teams = await this.deps.dashboards.accountTeams(tenantId, clientIds, today);
    const deptName = new Map(teams.depts.map((d) => [d.code, d.name]));
    const keyManagers = new Map<string, SummaryPerson>();
    for (const p of teams.people) {
      // Newest first per client: the one in force if two overlap a changeover.
      if (p.role === "key_manager" && !keyManagers.has(p.clientPartyId)) {
        keyManagers.set(p.clientPartyId, { userId: p.userId, name: p.name });
      }
    }

    const clients = new Map<string, { name: string; totals: SummaryFigures[]; lines: ClientSummaryLine[] }>();
    const clientOf = (r: ClientSummaryRow) => {
      const id = r.partyId ?? "";
      let c = clients.get(id);
      if (c === undefined) {
        c = { name: r.partyName ?? "", totals: [], lines: [] };
        clients.set(id, c);
      }
      return c;
    };
    const currencies: SummaryFigures[] = [];
    for (const r of rows) {
      if (r.scope === "currency") currencies.push(figuresOf(r));
      else if (r.scope === "client") clientOf(r).totals.push(figuresOf(r));
      else if (r.kind !== null) {
        const codes = [...r.deptCodes].sort();
        clientOf(r).lines.push({
          ...figuresOf(r),
          kind: r.kind,
          key: r.subjectKey ?? "",
          name: r.name,
          services: r.services,
          depts: codes.map((code) => ({ code, name: deptName.get(code) ?? code })),
          spocs: teams.people
            .filter(
              (p) =>
                p.role === "spoc" && p.clientPartyId === r.partyId && p.deptCode !== null && codes.includes(p.deptCode),
            )
            .map((p) => ({ userId: p.userId, name: p.name, deptCode: p.deptCode ?? "" })),
        });
      }
    }
    const byName = (a: string | null, b: string | null) =>
      (a ?? "").localeCompare(b ?? "", "en", { sensitivity: "base" });
    const byCurrency = (a: SummaryFigures, b: SummaryFigures) => a.currency.localeCompare(b.currency);
    return {
      from,
      to,
      asOf,
      financialYearStartMonth,
      currencies: currencies.sort(byCurrency),
      clients: [...clients.entries()]
        .map(([partyId, c]) => ({
          partyId,
          name: c.name,
          keyManager: keyManagers.get(partyId) ?? null,
          totals: c.totals.sort(byCurrency),
          lines: c.lines.sort(
            (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a.name, b.name) || byCurrency(a, b),
          ),
        }))
        .sort((a, b) => byName(a.name, b.name)),
    };
  }

  /**
   * THE PROJECTION (Ashish, 15 Oct 2026: "projected revenue for upcoming
   * month services"): what each client's services will be billed, before tax,
   * in the rest of this month and the `ahead` months after it, by the month the
   * bill falls due. It is the billing sweep's own rule run forward: the same
   * periods, bill dates and part-period amounts, so a month's figure is the
   * bills the sweep will write. A service runs on until it is ended (a letter
   * carries no end date; 10x's own letters run "until completion"): an
   * engagement ended or paused bills nothing past it. Bills already written
   * are the client summary's, not this.
   */
  async projection(
    tenantId: string,
    q: {
      readonly ahead?: number | undefined;
      readonly partyId?: string | undefined;
      readonly keyManagerUserId?: string | undefined;
      readonly spocUserId?: string | undefined;
    },
  ): Promise<ClientProjection> {
    const billing = this.deps.billing;
    if (billing === undefined) throw new Error("projection: billing schedules are not wired");
    const today = await this.firmDay(tenantId);
    const months = projectionMonths(today, q.ahead ?? 3);
    const horizon = months[months.length - 1]?.to ?? today;
    const firmYear = await this.deps.fiscalYears.fiscalYearStartMonth(tenantId);
    const calendars = await billing.calendars.companyCalendars(tenantId);

    const plans: { readonly subject: BillingSubject; readonly month: number; readonly amount: string | null }[] = [];
    let awaitingFiscalYear = 0;
    for (const subject of await billing.schedules.subjectsFor(tenantId)) {
      if (q.partyId !== undefined && subject.partyId !== q.partyId) continue;
      const recurrence = recurrenceOfService(subject.billingFrequency);
      if (recurrence === null) continue;
      const fiscalYear =
        subject.yearStartMonth ?? yearStartOfCompany(calendars, subject.issuingEntityPartyId, firmYear);
      const quarter = assignedQuarterStart(recurrence, subject.assignedQuarterMonth, subject.duePeriodStarts);
      if (recurrence !== "monthly" && fiscalYear === null && quarter === null) {
        awaitingFiscalYear += 1;
        continue;
      }
      const span = monthsPerPeriod(recurrence);
      const count = Math.max(1, Math.floor(wholeMonths(subject.billingFrom, horizon) / span) + 1);
      const written = new Set(subject.duePeriodStarts);
      const dues = billingDues({
        periods: billingPeriods(subject.billingFrom, recurrence, count, fiscalYear, quarter),
        spanMonths: span,
        firstInvoiceOn: subject.firstInvoiceOn,
        today: horizon,
        windows: subject.engagements.map(serviceWindowOf),
        filings: subject.statutoryFilings ?? [],
        onClientQuarter: quarter !== null,
      });
      for (const due of dues) {
        if (written.has(due.period.start) || due.billOn < today) continue;
        const month = months.findIndex((m) => due.billOn >= m.from && due.billOn <= m.to);
        if (month === -1) continue;
        const amount =
          subject.fullAmount === null ? null : proratedAmount(subject.fullAmount, due.servedDays, due.periodDays);
        plans.push({ subject, month, amount });
      }
    }

    const engagementIds = [
      ...new Set(
        plans.flatMap((p) =>
          p.subject.feeGroupId === null && p.subject.engagementId !== null ? [p.subject.engagementId] : [],
        ),
      ),
    ];
    const groupIds = [...new Set(plans.flatMap((p) => (p.subject.feeGroupId === null ? [] : [p.subject.feeGroupId])))];
    const names = await this.deps.dashboards.subjectNames(tenantId, engagementIds, groupIds);
    const engagementNames = new Map(names.engagements.map((e) => [e.engagementId, e]));
    const groupNames = new Map(names.feeGroups.map((g) => [g.feeGroupId, g]));
    const clientIds = [...new Set(plans.map((p) => p.subject.partyId))];
    const teams = await this.deps.dashboards.accountTeams(tenantId, clientIds, today);
    const deptName = new Map(teams.depts.map((d) => [d.code, d.name]));
    const keyManagers = new Map<string, SummaryPerson>();
    for (const p of teams.people) {
      if (p.role === "key_manager" && !keyManagers.has(p.clientPartyId)) {
        keyManagers.set(p.clientPartyId, { userId: p.userId, name: p.name });
      }
    }
    const spocsOf = (clientId: string, codes: readonly string[]) =>
      teams.people.filter(
        (p) => p.role === "spoc" && p.clientPartyId === clientId && p.deptCode !== null && codes.includes(p.deptCode),
      );

    const zero = months.map(() => "0");
    const rows = new Map<string, ProjectionDraft>();
    for (const plan of plans) {
      const s = plan.subject;
      const group = s.feeGroupId === null ? undefined : groupNames.get(s.feeGroupId);
      const service = s.engagementId === null ? undefined : engagementNames.get(s.engagementId);
      const what =
        group !== undefined
          ? {
              kind: "section" as const,
              key: group.feeGroupId,
              name: group.title,
              services: group.services,
              codes: group.deptCodes,
              partyName: group.partyName,
            }
          : service !== undefined
            ? {
                kind: "service" as const,
                key: service.entryKey,
                name: service.name,
                services: [],
                codes: service.deptCode === null ? [] : [service.deptCode],
                partyName: service.partyName,
              }
            : null;
      if (what === null) continue;
      if (q.keyManagerUserId !== undefined && keyManagers.get(s.partyId)?.userId !== q.keyManagerUserId) continue;
      if (q.spocUserId !== undefined && !spocsOf(s.partyId, what.codes).some((p) => p.userId === q.spocUserId)) {
        continue;
      }
      const id = `${s.partyId}|${what.kind}|${what.key}|${s.currency}`;
      let row = rows.get(id);
      if (row === undefined) {
        row = { partyId: s.partyId, ...what, codes: [...what.codes].sort(), currency: s.currency, months: [...zero], unpriced: 0 };
        rows.set(id, row);
      }
      if (plan.amount === null) row.unpriced += 1;
      else row.months[plan.month] = addAmounts(row.months[plan.month] ?? "0", plan.amount);
    }

    const figures = (currency: string, ms: readonly string[]): ProjectedFigures => ({
      currency,
      months: ms,
      total: ms.reduce((a, m) => addAmounts(a, m), "0"),
    });
    const totalsOf = (drafts: readonly ProjectionDraft[]) =>
      [...new Set(drafts.map((d) => d.currency))].sort().map((cur) => {
        const mine = drafts.filter((d) => d.currency === cur);
        return figures(
          cur,
          zero.map((_, i) => mine.reduce((a, d) => addAmounts(a, d.months[i] ?? "0"), "0")),
        );
      });
    const byClient = new Map<string, ProjectionDraft[]>();
    for (const row of rows.values()) byClient.set(row.partyId, [...(byClient.get(row.partyId) ?? []), row]);
    const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
    const clients: ProjectionClient[] = [...byClient.entries()]
      .map(([partyId, drafts]) => ({
        partyId,
        name: drafts[0]?.partyName ?? "",
        keyManager: keyManagers.get(partyId) ?? null,
        totals: totalsOf(drafts),
        lines: drafts
          .map((d) => ({
            ...figures(d.currency, d.months),
            kind: d.kind,
            key: d.key,
            name: d.name,
            services: d.services,
            depts: d.codes.map((code) => ({ code, name: deptName.get(code) ?? code })),
            spocs: spocsOf(partyId, d.codes).map((p) => ({ userId: p.userId, name: p.name, deptCode: p.deptCode ?? "" })),
            unpriced: d.unpriced,
          }))
          .sort(
            (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a.name, b.name) || a.currency.localeCompare(b.currency),
          ),
      }))
      .sort((a, b) => byName(a.name, b.name));
    return { today, months, currencies: totalsOf([...rows.values()]), clients, awaitingFiscalYear };
  }

  /** The last `months` months on the FIRM's calendar (T6.14). */
  private async window(tenantId: string, months: number) {
    return billingWindow(await this.firmDay(tenantId), months);
  }

  /** Today on the firm's calendar (0071). */
  private async firmDay(tenantId: string): Promise<string> {
    const zone = await this.deps.timeZones.timeZoneFor(tenantId);
    return dayInZone(this.deps.clock.now().toISOString(), zone);
  }

  async revenueByCompany(tenantId: string, months: number): Promise<RevenueByCompany> {
    const window = await this.window(tenantId, months);
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

/** The first day of the financial year `day` falls in (the firm's own start
 *  month), or, with none set, the first of the month eleven months before. */
function figuresOf(r: ClientSummaryRow): SummaryFigures {
  return {
    currency: r.currency,
    billed: r.billed,
    received: r.received,
    tds: r.tds,
    pending: r.pending,
    overdue: r.overdue,
    invoices: r.invoices,
  };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** This month from `today`, then `ahead` whole months, each to its last day. */
export function projectionMonths(today: string, ahead: number): ProjectionMonth[] {
  const [y = 2026, m = 1] = today.split("-").map(Number);
  const out: ProjectionMonth[] = [];
  for (let i = 0; i <= ahead; i += 1) {
    const at = y * 12 + (m - 1) + i;
    const year = Math.floor(at / 12);
    const month = (at % 12) + 1;
    const key = `${String(year)}-${String(month).padStart(2, "0")}`;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    out.push({
      key,
      label: `${MONTH_NAMES[month - 1] ?? ""} ${String(year)}`,
      from: i === 0 ? today : `${key}-01`,
      to: `${key}-${String(last).padStart(2, "0")}`,
    });
  }
  return out;
}

/** Whole calendar months from one day to another, ignoring the day of month. */
function wholeMonths(from: string, to: string): number {
  const [fy = 0, fm = 1] = from.split("-").map(Number);
  const [ty = 0, tm = 1] = to.split("-").map(Number);
  return ty * 12 + tm - (fy * 12 + fm);
}

export function yearToDateFrom(day: string, startMonth: number | null): string {
  const [y = 0, m = 1] = day.split("-").map(Number);
  if (startMonth === null) {
    const index = y * 12 + (m - 1) - 11;
    return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  }
  const year = m >= startMonth ? y : y - 1;
  return `${String(year).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`;
}
