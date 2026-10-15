// The seams the dashboards need. Interfaces owned by this use case, stated in
// its vocabulary; the Postgres adapter implements them over the views migration
// 0038 creates.
//
// EVERY METHOD RETURNS AGGREGATES THE DATABASE COMPUTED. That is deliberate and
// it is the acceptance criterion: "figures reconcile to underlying rows, not
// cached columns". A port that returned rows for this service to sum in
// TypeScript would be a second implementation of arithmetic the database
// already does, and the two would eventually disagree.
import type { AgeingBand, MrrByCurrency, MrrGap, Slice } from "../../domain/dashboard/model";
import type { CompanyCalendars } from "../../domain/calendar/model";
import type { BillingSubject } from "../billing/ports";

export interface MrrTotals {
  /** Decimal string in the firm's reporting currency. "0" when nothing counts. */
  readonly monthly: string;
  readonly countedEngagements: number;
  readonly gaps: readonly MrrGap[];
}

export interface ReceivableTotals {
  readonly outstanding: string;
  readonly bands: readonly AgeingBand[];
}

export interface DashboardRepository {
  /** The firm's own currency — every figure here is struck in it. */
  reportingCurrency(tenantId: string): Promise<string>;

  mrr(tenantId: string): Promise<MrrTotals>;

  /** MRR split by an axis. `service` groups by the pinned service version's
   *  ENTRY, so a service the firm has since republished does not fragment into
   *  one slice per version. */
  mrrBy(tenantId: string, axis: "client" | "service"): Promise<readonly Slice[]>;

  /** The currencies the counted recurring fees are in (0345). */
  mrrCurrencies(tenantId: string): Promise<readonly string[]>;

  /** Recurring fees per currency and per client x currency, at the signed
   *  rates and at the latest rate held on or before `day` (0345). Summed in
   *  SQL. `asOf` in the answer is `day`. */
  mrrByCurrency(tenantId: string, day: string): Promise<MrrByCurrency>;

  /** Bucketed as of `day`, the FIRM's calendar day (audit 2026-10-03, B29):
   *  the database's own day is UTC, which is yesterday in India until 05:30. */
  receivables(tenantId: string, day: string): Promise<ReceivableTotals>;

  /** What each client owes as of `day`, the firm's day. */
  receivablesByClient(tenantId: string, day: string): Promise<readonly Slice[]>;

  /**
   * What the firm actually billed in a window — the denominator of DSO.
   *
   * Issued invoices only, net of credit notes, at the rate stored on each
   * invoice. Credit notes are subtracted rather than ignored because a sale that
   * was reversed was not a sale, and leaving it in would flatter DSO by
   * inflating the denominator.
   */
  creditSales(tenantId: string, sinceDays: number, day: string): Promise<string>;

  /**
   * The firm's own companies (`crm.is_firm_entity`, live and not archived),
   * the firm itself first, PLUS any other party that issued an invoice in the
   * window: a company put away since is still who billed that money, and a
   * chart that dropped it would under-report the month.
   */
  billingCompanies(tenantId: string, window: BillingWindowDays): Promise<readonly BillingCompany[]>;

  /**
   * Billing per company per month, and per month for the whole firm, in ONE
   * pass (grouping sets), summed in SQL on `numeric`. `owns` says which
   * currency each company's `billed` is struck in; see `CompanyMonthRow`.
   */
  billingByMonth(
    tenantId: string,
    window: BillingWindowDays,
    owns: readonly { readonly partyId: string; readonly currency: string }[],
    reportingCurrency: string,
  ): Promise<readonly CompanyMonthRow[]>;

  /**
   * Billed and collected per manager per month, and per month for the whole
   * firm, in ONE pass (grouping sets), summed in SQL on `numeric`. The
   * definitions are `ManagerMonth`'s.
   */
  billingByManager(tenantId: string, window: BillingWindowDays): Promise<readonly ManagerMonthRow[]>;

  /** What each manager's issued invoices are owed now, and the firm's total,
   *  from `crm.receivable_ageing` (the rows "Owed to the firm" sums). */
  owedByManager(tenantId: string, day: string): Promise<readonly ManagerOwedRow[]>;

  /** Names for these users, from this firm's own memberships only (a user
   *  account is global; the membership is behind the tenant wall). */
  managerNames(tenantId: string, userIds: readonly string[]): Promise<readonly ManagerName[]>;

  /**
   * The revenue report (Q049): invoiced, collected and outstanding per person
   * and CURRENCY, never converted and never added across currencies. Summed in
   * SQL on `numeric`. See `RevenueQuery` for the person and the definitions.
   */
  revenueByPerson(tenantId: string, q: RevenueQuery): Promise<readonly PersonCurrencyRow[]>;

  /** The client summary: billed, received and owed per client and per what the
   *  money was for, per currency, with each client's and each currency's total
   *  (grouping sets). See `ClientSummaryQuery` for the definitions. */
  clientSummary(tenantId: string, q: ClientSummaryQuery): Promise<readonly ClientSummaryRow[]>;

  /** Who is on each client's account team on `day` (active staff only), and
   *  the names of the firm's Depts. */
  accountTeams(tenantId: string, clientIds: readonly string[], day: string): Promise<AccountTeams>;

  /** What each billing subject is called, for the projection's rows: a
   *  service under its live catalogue name, a section with its services. */
  subjectNames(
    tenantId: string,
    engagementIds: readonly string[],
    feeGroupIds: readonly string[],
  ): Promise<SubjectNames>;
}

export interface SubjectNames {
  readonly engagements: readonly {
    readonly engagementId: string;
    readonly partyName: string;
    /** The catalogue entry, as the client summary keys a service. */
    readonly entryKey: string;
    readonly name: string;
    readonly deptCode: string | null;
  }[];
  readonly feeGroups: readonly {
    readonly feeGroupId: string;
    readonly partyName: string;
    readonly title: string;
    readonly services: readonly string[];
    readonly deptCodes: readonly string[];
  }[];
}

/** The billing schedules (0318) as the sweep reads them; the projection runs
 *  the sweep's own rule forward (structural: the billing adapter). */
export interface BillingScheduleSource {
  subjectsFor(tenantId: string): Promise<readonly BillingSubject[]>;
}

/** Each of the firm's companies' year and zone (0337). */
export interface CompanyCalendarSource {
  companyCalendars(tenantId: string): Promise<CompanyCalendars>;
}

/**
 * Billed, received and owed per CLIENT and per what each invoice line was for:
 * a service (its catalogue entry, so a renewed letter stays one row), a section
 * (one fee for several services), an advance, or nothing. A line's share of its
 * invoice's credit notes, money and balance is its share of the invoice total
 * (pro rata, to four places), as the revenue report's originator view splits it.
 *
 * BILLED is issued in [from, to] with tax, less credit notes issued in the
 * window. RECEIVED is money received in the window (the revenue report's
 * COLLECTED), and TDS beside it. PENDING is owed at the close
 * of `asOf`, and OVERDUE the part of it past its due date. Drafts and cancelled
 * invoices count nowhere. Key Manager and SPOC are the ones in force on `today`.
 */
export interface ClientSummaryQuery {
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  readonly today: string;
  readonly partyId?: string | undefined;
  readonly issuerPartyId?: string | undefined;
  readonly currency?: string | undefined;
  /** Only clients this person is the Key Manager of. */
  readonly keyManagerUserId?: string | undefined;
  /** Only the rows this person is a SPOC for: the client, and the Dept of the work. */
  readonly spocUserId?: string | undefined;
}

export type SummaryKind = "service" | "section" | "advance" | "other";

export interface ClientSummaryRow {
  /** `subject`: one client's one service (or section...) in one currency;
   *  `client`: that client's total in the currency; `currency`: the firm's. */
  readonly scope: "subject" | "client" | "currency";
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly kind: SummaryKind | null;
  /** The catalogue entry or the section's id; empty for an advance or other. */
  readonly subjectKey: string | null;
  /** The live service's name, or the section's title. */
  readonly name: string | null;
  /** A section's services, by name. */
  readonly services: readonly string[];
  /** The Dept codes of the work (the live service's module). */
  readonly deptCodes: readonly string[];
  readonly currency: string;
  readonly billed: string;
  readonly received: string;
  /** Tax the client deducted on those payments (Q057): settled, not received. */
  readonly tds: string;
  readonly pending: string;
  readonly overdue: string;
  /** Invoices issued in the window that count here. */
  readonly invoices: number;
}

export interface AccountTeams {
  readonly people: readonly {
    readonly clientPartyId: string;
    readonly role: "key_manager" | "spoc";
    readonly userId: string;
    readonly name: string;
    /** A SPOC's Dept; null for a Key Manager. */
    readonly deptCode: string | null;
  }[];
  readonly depts: readonly { readonly code: string; readonly name: string }[];
}

/**
 * Who a row is, and the window.
 *
 *   - `manager`: the invoice's manager (0318, frozen at issue);
 *   - `originator`: the originator of the letter each invoice LINE bills
 *     (0355), so one invoice carrying two letters' work credits two people,
 *     each line's share of the invoice's credit notes, money and balance
 *     allocated by its share of the invoice (pro rata, to four places).
 *
 * INVOICED is issued in [from, to], before tax, less credit notes issued in
 * the window at their pre-tax share (the dashboard's BILLED, in the document's
 * own currency). COLLECTED is cash received in the window, with tax. OUTSTANDING
 * is what is owed at the close of `asOf` (`crm.receivable_ageing_on`). A draft
 * or a cancelled invoice counts nowhere.
 */
export interface RevenueQuery {
  readonly by: "manager" | "originator";
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  /** One of the firm's companies (the invoice's issuer), or all. */
  readonly issuerPartyId?: string | undefined;
  /** One currency, or all (each still its own row). */
  readonly currency?: string | undefined;
}

export interface PersonCurrencyRow {
  /** `currency`: the whole firm's row for that currency (GROUPING SETS), which
   *  every person's row of the currency adds up to. */
  readonly scope: "person" | "currency";
  /** Null: invoices (or lines) naming nobody, or the currency's total. */
  readonly userId: string | null;
  readonly currency: string;
  readonly invoiced: string;
  readonly collected: string;
  readonly outstanding: string;
  /** Invoices issued in the window that count here. */
  readonly invoices: number;
}

/** A billing window as two days: `from` inclusive, `until` exclusive. */
/** Makes sure today's rate for a currency is held before a report reads it:
 *  the exchange-rate service's read-through (0345), structurally. */
export interface RateWarmer {
  quotePair(currency: string, reporting: string, on: string): Promise<unknown>;
}

export interface BillingWindowDays {
  readonly from: string;
  readonly until: string;
}

export interface BillingCompany {
  readonly partyId: string;
  readonly name: string;
  readonly jurisdiction: string | null;
}

/**
 * One row of `billingByMonth`. `partyId` null is the WHOLE FIRM's month.
 *
 * `billed` is in the company's own currency: its invoices in that currency,
 * or, when that currency IS the reporting currency, all of its invoices at
 * their stored rates. Null on a whole-firm row (the companies' currencies
 * differ). `billedReporting` is every document at its own stored rate.
 */
export interface CompanyMonthRow {
  readonly partyId: string | null;
  readonly month: string;
  readonly billed: string | null;
  readonly billedReporting: string;
  readonly invoices: number;
  readonly otherCurrencyInvoices: number;
}

/** The firm's timezone, for the month the firm is in. Structural: satisfied
 *  by `PostgresFirmTimeZone`, like every other use case's (T6.14). */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * One row of `billingByManager`. `scope: "firm"` is the whole firm's month;
 * on a `"manager"` row `managerUserId` null is the invoices naming nobody.
 * Every amount is in the reporting currency, each document at its own rate.
 */
export interface ManagerMonthRow {
  readonly scope: "manager" | "firm";
  readonly managerUserId: string | null;
  readonly month: string;
  readonly billed: string;
  readonly collected: string;
  readonly invoices: number;
}

/** One row of `owedByManager`, scoped the same way. */
export interface ManagerOwedRow {
  readonly scope: "manager" | "firm";
  readonly managerUserId: string | null;
  readonly outstanding: string;
  readonly invoices: number;
}

/** A manager by name, as THIS firm's roster has them. */
export interface ManagerName {
  readonly userId: string;
  readonly name: string;
  readonly activeStaff: boolean;
}

/** The firm's financial year, so a screen can offer "this financial year"
 *  (structural: the config repository satisfies it, as it does billing's). */
export interface FiscalYearSource {
  fiscalYearStartMonth(tenantId: string): Promise<number | null>;
}
