// Whose YEAR, or whose assigned PERIOD, a filing is cut on (Q070 Part B 0358;
// Q073 0359).
//
// A rule says it (`periodBasis`):
//   rule_calendar       its own year (every rule before 0358);
//   client_year_end     the client entity's `financial_year_end`; a client with
//                       none recorded falls back to the rule's own month and
//                       the row says so (`rule_fallback`), never a guess;
//   authority_assigned  the client's return period for the rule's MODULE as
//                       the tax authority assigned it (the UAE VAT stagger):
//                       monthly, or quarterly from its first month. A client
//                       with none recorded gets NO filing, and Setup lists it.
//
// MONTHLY on the first two is a month in every country, so its periods do not
// depend on any year and its rows are `rule_calendar` whatever the rule asks.
//
// Separate from `model.ts`, which imports nothing internal: this reads the
// year-end convention the company calendar keeps (0337).
import { startMonthOfYearEnd } from "../calendar/model";
import type { InstancePeriodBasis, ObligationRecurrence, ObligationTemplate, Period } from "./model";

/** How a client company files one tax, as its authority assigned (0359). */
export type ReturnFrequency = "monthly" | "quarterly";

export interface ReturnPeriod {
  /** The tax, as a rule's `module` names it, upper-case: "VAT". */
  readonly tax: string;
  readonly frequency: ReturnFrequency;
  /** Quarterly only: 1, 2 or 3, the first month of its first calendar-year
   *  quarter (Jan/Apr/Jul/Oct, Feb/May/Aug/Nov, Mar/Jun/Sep/Dec). */
  readonly firstMonth: number | null;
}

export function isReturnFrequency(v: string): v is ReturnFrequency {
  return v === "monthly" || v === "quarterly";
}

/** A tax as rows and rules hold it: trimmed, upper-case. */
export function normalizeTax(tax: string): string {
  return tax.trim().toUpperCase();
}

/** The shape 0359's CHECK holds a tax to. */
export function isTaxCode(tax: string): boolean {
  return /^[A-Z0-9][A-Z0-9 _-]{0,39}$/.test(tax);
}

/** Why a return period cannot be recorded, in words, or null when it can. */
export function returnPeriodProblem(p: ReturnPeriod): string | null {
  if (!isTaxCode(p.tax)) return "Name the tax as your filing rules do, e.g. VAT.";
  if (p.frequency === "monthly") {
    return p.firstMonth === null ? null : "A monthly period has no quarter months.";
  }
  return p.firstMonth !== null && [1, 2, 3].includes(p.firstMonth)
    ? null
    : "Pick which months the quarters start in: Jan, Feb or Mar.";
}

/** How one subject's periods are cut for one rule, or null for none at all. */
export interface PeriodCut {
  readonly recurrence: Exclude<ObligationRecurrence, "event">;
  readonly startMonth: number;
  readonly basis: InstancePeriodBasis;
}

/**
 * The cut for one subject, or null when the rule follows an authority-assigned
 * period and this client has none for the rule's module (no filing, Setup
 * lists it).
 */
export function periodCutFor(
  template: Pick<ObligationTemplate, "recurrence" | "fiscalYearStartMonth" | "periodBasis" | "module">,
  subject: { readonly financialYearEnd: string | null; readonly returnPeriods: readonly ReturnPeriod[] },
): PeriodCut | null {
  if (template.recurrence === "event") return null;
  if (template.periodBasis === "authority_assigned") {
    const tax = normalizeTax(template.module ?? "");
    const assigned = subject.returnPeriods.find((p) => normalizeTax(p.tax) === tax);
    if (assigned === undefined) return null;
    return assigned.frequency === "monthly"
      ? { recurrence: "monthly", startMonth: 1, basis: "authority_assigned" }
      : { recurrence: "quarterly", startMonth: assigned.firstMonth ?? 1, basis: "authority_assigned" };
  }
  const y = periodYearFor(template, subject.financialYearEnd);
  return { recurrence: template.recurrence, startMonth: y.startMonth, basis: y.basis };
}

/** The month a subject's year starts in, and the basis the row records. */
export function periodYearFor(
  template: Pick<ObligationTemplate, "recurrence" | "fiscalYearStartMonth" | "periodBasis">,
  clientYearEnd: string | null,
): { readonly startMonth: number; readonly basis: InstancePeriodBasis } {
  if (template.periodBasis !== "client_year_end" || template.recurrence === "monthly") {
    return { startMonth: template.fiscalYearStartMonth, basis: "rule_calendar" };
  }
  const own = startMonthOfYearEnd(clientYearEnd);
  return own === null
    ? { startMonth: template.fiscalYearStartMonth, basis: "rule_fallback" }
    : { startMonth: own, basis: "client_year_end" };
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * An assigned quarter as a person reads it: "Feb-Apr 2026", and across a
 * year "Nov 2026-Jan 2027". A stagger's quarters are not a financial year's,
 * so "Q1 FY2026-27" would name a period nobody files under.
 */
export function assignedQuarterLabel(period: Period): string {
  const [sy, sm] = [Number(period.start.slice(0, 4)), Number(period.start.slice(5, 7))];
  const [ey, em] = [Number(period.end.slice(0, 4)), Number(period.end.slice(5, 7))];
  const s = SHORT[sm - 1] ?? "";
  const e = SHORT[em - 1] ?? "";
  return sy === ey ? `${s}-${e} ${String(sy)}` : `${s} ${String(sy)}-${e} ${String(ey)}`;
}
