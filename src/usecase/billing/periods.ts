// The periods a recurring service is billed in: the one cut the sweep, the
// bill-early offer and Work vs Billing all make, so an expected bill is the
// bill the sweep writes.
import { quarterRangeLabel, type BillingPeriod } from "../../domain/billing/model";
import { periodsFrom, type Recurrence } from "../../domain/scheduler/model";

/**
 * `count` periods from the one holding `from`, on the year that starts in
 * `yearStartMonth` (the engagement's pinned year, else its company's, else
 * the firm's, 0337/0338), unless `quarterStartMonth` names the client's own
 * quarter (Q071 d, `assignedQuarterStart`): then on that quarter, called by
 * its months.
 */
export function billingPeriods(
  from: string,
  recurrence: Recurrence,
  count: number,
  yearStartMonth: number | null,
  quarterStartMonth: number | null,
): readonly BillingPeriod[] {
  if (quarterStartMonth === null) return periodsFrom(from, recurrence, count, yearStartMonth ?? 1);
  return periodsFrom(from, recurrence, count, quarterStartMonth).map((p) => ({ ...p, label: quarterRangeLabel(p) }));
}
