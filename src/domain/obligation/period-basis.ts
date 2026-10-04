// Whose YEAR a filing's period is cut on (Q070 Part B, B2; 0358).
//
// A rule says it (`periodBasis`): its own year (`rule_calendar`, every rule
// before 0358) or the client's (`client_year_end`, the client entity's
// `financial_year_end`). A client with no year end recorded falls back to the
// rule's own month, and the row says so (`rule_fallback`), never a guess.
//
// MONTHLY is a month in every country, so its periods do not depend on any
// year and its rows are `rule_calendar` whatever the rule asks.
//
// Separate from `model.ts`, which imports nothing internal: this reads the
// year-end convention the company calendar keeps (0337).
import { startMonthOfYearEnd } from "../calendar/model";
import type { InstancePeriodBasis, ObligationTemplate } from "./model";

/** The month a subject's year starts in, and the basis the row records. */
export function periodYearFor(
  template: Pick<ObligationTemplate, "recurrence" | "fiscalYearStartMonth" | "periodBasis">,
  clientYearEnd: string | null,
): { readonly startMonth: number; readonly basis: InstancePeriodBasis } {
  if (template.periodBasis === "rule_calendar" || template.recurrence === "monthly") {
    return { startMonth: template.fiscalYearStartMonth, basis: "rule_calendar" };
  }
  const own = startMonthOfYearEnd(clientYearEnd);
  return own === null
    ? { startMonth: template.fiscalYearStartMonth, basis: "rule_fallback" }
    : { startMonth: own, basis: "client_year_end" };
}
