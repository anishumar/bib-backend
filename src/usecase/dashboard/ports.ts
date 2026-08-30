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
}
