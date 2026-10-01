// The seams the dashboards need. Interfaces owned by this use case, stated in
// its vocabulary; the Postgres adapter implements them over the views migration
// 0038 creates.
//
// EVERY METHOD RETURNS AGGREGATES THE DATABASE COMPUTED. That is deliberate and
// it is the acceptance criterion: "figures reconcile to underlying rows, not
// cached columns". A port that returned rows for this service to sum in
// TypeScript would be a second implementation of arithmetic the database
// already does, and the two would eventually disagree.
import type { AgeingBand, MrrGap, Slice } from "../../domain/dashboard/model";

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

  receivables(tenantId: string): Promise<ReceivableTotals>;

  receivablesByClient(tenantId: string): Promise<readonly Slice[]>;

  /**
   * What the firm actually billed in a window — the denominator of DSO.
   *
   * Issued invoices only, net of credit notes, at the rate stored on each
   * invoice. Credit notes are subtracted rather than ignored because a sale that
   * was reversed was not a sale, and leaving it in would flatter DSO by
   * inflating the denominator.
   */
  creditSales(tenantId: string, sinceDays: number): Promise<string>;

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
  owedByManager(tenantId: string): Promise<readonly ManagerOwedRow[]>;

  /** Names for these users, from this firm's own memberships only (a user
   *  account is global; the membership is behind the tenant wall). */
  managerNames(tenantId: string, userIds: readonly string[]): Promise<readonly ManagerName[]>;
}

/** A billing window as two days: `from` inclusive, `until` exclusive. */
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
