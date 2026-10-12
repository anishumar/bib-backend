// The shapes the fixed-rule checks take, and the helpers every check file
// shares (docs/FIN_BUILD_PLAN.md F4.3, F4.5). Pure. `checks.ts` runs them.
import { isCalendarDay } from "../day";
import { CheckInputInvalid } from "./errors";
import type { FindingDraft } from "./finding";
import type { Day, DocumentLineDraft, PayrollLineDraft } from "./lines";
import type { RuleParameters } from "./parameters";

/** A committed document line: the draft's shape plus its id and client. */
export type CheckedDocumentLine = DocumentLineDraft & {
  readonly id: string;
  readonly clientPartyId: string;
};

/** A committed payroll line: the draft's shape plus its id and client. */
export type CheckedPayrollLine = PayrollLineDraft & {
  readonly id: string;
  readonly clientPartyId: string;
};

/** What a check needs to know about the client. */
export interface ClientFacts {
  readonly clientPartyId: string;
  /**
   * The day the client was registered for GST, or null when it is not. GST on
   * a purchase dated before this day (or on any day, when null) is not the
   * client's to recover. Dated rather than a yes or no, because a company that
   * crosses the threshold registers part-way through a year (F6.6).
   */
  readonly gstRegisteredFrom: Day | null;
  /** 1 to 12: the month the client's financial year starts in (1 for a
   *  calendar year). */
  readonly fiscalYearStartMonth: number;
}

/** The period being checked, both days inclusive. */
export interface CheckPeriod {
  readonly start: Day;
  readonly end: Day;
}

export interface DocumentCheckInput {
  readonly client: ClientFacts;
  readonly period: CheckPeriod;
  readonly lines: readonly CheckedDocumentLine[];
  readonly history: readonly CheckedDocumentLine[];
  readonly parameters: RuleParameters;
}

export interface PayrollCheckInput {
  readonly client: ClientFacts;
  readonly period: CheckPeriod;
  readonly lines: readonly CheckedPayrollLine[];
  readonly history: readonly CheckedPayrollLine[];
  readonly parameters: RuleParameters;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Refuses input no check could read sensibly: a caller's bug, said loudly. */
export function assertCheckable(
  client: ClientFacts,
  period: CheckPeriod,
  lines: readonly { readonly id: string; readonly clientPartyId: string }[],
): void {
  if (!isCalendarDay(period.start) || !isCalendarDay(period.end)) {
    throw new CheckInputInvalid(`the period ${period.start} to ${period.end} is not two calendar days`);
  }
  if (period.end < period.start) {
    throw new CheckInputInvalid(`the period ends (${period.end}) before it starts (${period.start})`);
  }
  if (!Number.isInteger(client.fiscalYearStartMonth) || client.fiscalYearStartMonth < 1 || client.fiscalYearStartMonth > 12) {
    throw new CheckInputInvalid(`the financial year cannot start in month ${String(client.fiscalYearStartMonth)}`);
  }
  if (client.gstRegisteredFrom !== null && !isCalendarDay(client.gstRegisteredFrom)) {
    throw new CheckInputInvalid(`the GST registration day ${client.gstRegisteredFrom} is not a calendar day`);
  }
  const other = lines.find((l) => l.clientPartyId !== client.clientPartyId);
  if (other !== undefined) {
    throw new CheckInputInvalid(`line ${other.id} belongs to another client`);
  }
}

/** The first day of the financial year that `day` falls in. */
export function financialYearStart(day: Day, startMonth: number): Day {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`;
}

/** A `YYYY-MM` month as its first and last days, or null when it is not one. */
export function monthBounds(month: string): CheckPeriod | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return null;
  const year = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return { start: `${month}-01`, end: `${month}-${String(lengths[mo - 1] ?? 31)}` };
}

/** Findings in one order whatever order the lines came in, so a run's output
 *  can be compared with another's. */
export function inStableOrder(findings: readonly FindingDraft[]): FindingDraft[] {
  return [...findings].sort((a, b) =>
    a.checkKey === b.checkKey ? (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0) : a.checkKey < b.checkKey ? -1 : 1,
  );
}
