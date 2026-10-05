// Whose clock a FILING is judged on (Q070 Part B, B1; SPEC §5).
//
// 10x (Ashish, 2026-10-04): MISSED is judged "respective country time zone
// basis". A filing's statutory date is a plain day, and "has it passed" is
// asked of TODAY IN THE FILING'S ZONE, never the firm's: an Indian firm's
// midnight made a UAE return Missed an hour and a half early and a US return
// Missed at 14:30 New York time on its own due day.
//
// The zone, in this order:
//   1. the client entity's own zone (`core.legal_entity.time_zone`), which is
//      the US taxpayer's-zone rule (26 CFR 301.7502-1) and the only way to say
//      Los Angeles for a Californian company;
//   2. the filing country's one zone (India, the UAE, Singapore ...), and for
//      the United States, which has six, New York: the zone the question to
//      10x named, and the IRS's own;
//   3. the zone of the firm's own company registered in that country;
//   4. the firm's zone.
//
// Reminders, T-X task raising and every other date a PERSON works to stay on
// the firm's day: staff work, not the regulator's clock.
//
// Separate from `model.ts`, which imports nothing internal: this reads the
// country table the tenancy domain keeps.
import { dayInZone } from "../scheduler/zone";
import { singleZoneCountries, zoneForCountry } from "../tenancy/model";
import { addDays, daysBetween, type IsoDate } from "./model";

/** A country with several zones whose FILINGS are judged on one by default. */
export const FILING_ZONE_FALLBACKS: Readonly<Record<string, string>> = {
  US: "America/New_York",
};

/** The zone a filing in this country is judged on when the client entity
 *  names none, or null when the country does not settle it. */
export function filingCountryZone(country: string): string | null {
  return zoneForCountry(country) ?? FILING_ZONE_FALLBACKS[country.trim().toUpperCase()] ?? null;
}

/** The whole table, for SQL: every single-zone country plus the fallbacks. */
export function filingCountryZones(): Readonly<Record<string, string>> {
  return { ...singleZoneCountries(), ...FILING_ZONE_FALLBACKS };
}

export interface FilingZoneFacts {
  /** The client entity's own zone, or null. */
  readonly entityZone: string | null;
  /** The filing rule's country, ISO 3166-1 alpha-2. */
  readonly jurisdiction: string;
  /** The zone of the firm's company registered in that country, or null. */
  readonly firmCompanyZone: string | null;
  readonly firmZone: string;
}

/** The zone a filing's day is read in, by the order above. */
export function filingZone(f: FilingZoneFacts): string {
  return f.entityZone ?? filingCountryZone(f.jurisdiction) ?? f.firmCompanyZone ?? f.firmZone;
}

/**
 * The filing's day when it is `asOf` on the FIRM's calendar at instant `now`.
 *
 * The sweep is handed the firm's day and runs at one instant; a filing's day
 * is that day moved by however many days its zone is ahead of or behind the
 * firm's at that instant (never more than one each way). Expressed as a shift
 * of `asOf` rather than as `dayInZone(now, zone)` so a caller that names the
 * day it is sweeping (a replay, a test) still sweeps that day, and a filing
 * on the firm's own zone is judged exactly as before.
 */
export function filingDay(asOf: IsoDate, now: string, zone: string, firmZone: string): IsoDate {
  if (zone === firmZone) return asOf;
  return addDays(asOf, daysBetween(dayInZone(now, firmZone), dayInZone(now, zone)));
}
