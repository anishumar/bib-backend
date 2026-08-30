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
  DashboardRepository,
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

  receivables(): Promise<ReceivableTotals> {
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

  creditSales(): Promise<string> {
    return Promise.resolve(this.sales);
  }
}
