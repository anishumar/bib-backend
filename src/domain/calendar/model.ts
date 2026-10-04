// A firm company's own financial year and time zone (0337). Pure: no Date.
//
// Sid, 2026-10-04: "region wise financial year selection and time zone to be
// considered". The firm keeps ONE zone and ONE year start (0071, the
// compliance policy); each of its companies may keep its own, and a company
// that says nothing is on the firm's. The DATES on a company's documents and
// the PERIODS it bills and works in follow the company. Reminders to people
// stay on the firm's day: no vendor the research found models a zone on a
// reminder (bib/reports/Per company fiscal year and timezone.md).
//
// STORED BY ITS LAST DAY, READ BY ITS FIRST MONTH. The year lives in
// core.legal_entity.financial_year_end (MM-DD) because that column is an
// entity's year for clients too, and the client side reads it for filings. The
// product cuts years by their START month everywhere, so these two convert.

/** A company's OWN settings; null means the firm's. */
export interface CompanyCalendar {
  /** Its IANA zone, or null for the firm's. */
  readonly timeZone: string | null;
  /** The month its financial year starts in (1-12), or null for the firm's. */
  readonly fiscalYearStartMonth: number | null;
}

/** Keyed by the company's party id; a company absent is on the firm's. */
export type CompanyCalendars = ReadonlyMap<string, CompanyCalendar>;

// February as 28: a year stored for a firm company is a month's last day, and a
// leap year's 29th is still "February", which is all the month cut reads.
const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isYearStartMonth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12;
}

/** "03-31" -> 4, "12-31" -> 1. Null for anything that is not MM-DD with a real
 *  month, so a stored value nobody can read falls back to the firm's. */
export function startMonthOfYearEnd(yearEnd: string | null): number | null {
  if (yearEnd === null) return null;
  const match = /^(\d{2})-(\d{2})$/.exec(yearEnd);
  if (!match) return null;
  const month = Number(match[1]);
  if (!isYearStartMonth(month)) return null;
  return (month % 12) + 1;
}

/** 4 -> "03-31": the last day of the month before the year starts. */
export function yearEndOfStartMonth(startMonth: number): string {
  if (!isYearStartMonth(startMonth)) {
    throw new RangeError(`a financial year starts in month 1 to 12, not ${String(startMonth)}`);
  }
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const lastDay = LAST_DAY[endMonth - 1] ?? 31;
  return `${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** The zone a company's documents are dated in: its own, else the firm's.
 *  Null for "no company" (a firm-wide read) is the firm's too. */
export function zoneOfCompany(calendars: CompanyCalendars, entityPartyId: string | null, firmZone: string): string {
  if (entityPartyId === null) return firmZone;
  return calendars.get(entityPartyId)?.timeZone ?? firmZone;
}

/** The month a company's year starts in: its own, else the firm's, else null
 *  (nobody has said, and quarterly or yearly work waits, as before 0337). */
export function yearStartOfCompany(
  calendars: CompanyCalendars,
  entityPartyId: string | null,
  firmStart: number | null,
): number | null {
  if (entityPartyId === null) return firmStart;
  return calendars.get(entityPartyId)?.fiscalYearStartMonth ?? firmStart;
}
