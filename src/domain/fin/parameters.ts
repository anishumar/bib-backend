// The dated statutory values the rule checks read (docs/FIN_BUILD_PLAN.md
// F4.1): `fin.rule_parameter` (0387) as the checks see it. Pure.
//
// One reader for every value, and it reads them STRICTLY: a value that does
// not have the shape its key promises is refused when the set is built
// (`RuleParameterUnreadable`, naming the row), never half-read by the check
// that happens to need it. A key no check reads yet is carried and ignored, so
// a row a later phase adds cannot break today's checks.
//
// Lookup is by (key, DAY), half-open like the table: a row covers `validFrom`
// up to but not including `validTo`. A day no row covers answers null, and a
// check that gets null CHECKS NOTHING rather than guessing: an unseeded year
// is a gap to fill, not a rate to assume.
import { isCalendarDay } from "../day";
import { RuleParameterUnreadable } from "./errors";
import type { Day, PassType } from "./lines";
import { toCents, toRate } from "./checks-money";
import type { Cents, Rate } from "./checks-money";

/** One row of `fin.rule_parameter`, as the adapter reads it. */
export interface RuleParameterRow {
  readonly jurisdiction: string;
  readonly key: string;
  readonly validFrom: Day;
  /** The first day NOT in force; null while nothing has replaced it. */
  readonly validTo: Day | null;
  readonly value: unknown;
  /** The official citation. */
  readonly source: string;
}

/** The standard GST rate. */
export interface GstRateValue {
  readonly rate: Rate;
}

/** A ceiling in the jurisdiction's currency (S$ for Singapore). */
export interface CeilingValue {
  readonly amount: Cents;
}

/** One CPF age band: it applies once the employee is ABOVE `aboveAge` (0 for
 *  the first band, "55 and below"). */
export interface CpfBand {
  readonly aboveAge: number;
  readonly employer: Rate;
  readonly employee: Rate;
}

/** The CPF rate table for monthly wages above `aboveMonthlyWage`. */
export interface CpfRatesValue {
  readonly aboveMonthlyWage: Cents;
  /** Ascending by `aboveAge`, the first at 0. */
  readonly bands: readonly CpfBand[];
}

/** Which work passes contribute to CPF. */
export interface ContributingPassesValue {
  readonly passTypes: readonly PassType[];
}

/** The Skills Development Levy. */
export interface SdlValue {
  readonly rate: Rate;
  readonly minimum: Cents;
  readonly maximum: Cents;
}

/** Every key a check reads, and the shape it reads. */
export interface ParameterValues {
  readonly "gst.standard_rate": GstRateValue;
  readonly "cpf.ow_ceiling": CeilingValue;
  readonly "cpf.annual_salary_ceiling": CeilingValue;
  readonly "cpf.rates": CpfRatesValue;
  readonly "cpf.contributing_passes": ContributingPassesValue;
  readonly "sdl.levy": SdlValue;
}

export type ParameterKey = keyof ParameterValues;

export const PARAMETER_KEYS: readonly ParameterKey[] = [
  "gst.standard_rate",
  "cpf.ow_ceiling",
  "cpf.annual_salary_ceiling",
  "cpf.rates",
  "cpf.contributing_passes",
  "sdl.levy",
];

const PASS_TYPES: readonly PassType[] = ["citizen", "pr", "employment_pass", "s_pass", "work_permit"];

/** A value in force on a day, with where it came from. */
export interface InForce<K extends ParameterKey> {
  readonly value: ParameterValues[K];
  readonly validFrom: Day;
  readonly source: string;
}

interface Parsed {
  readonly key: ParameterKey;
  readonly validFrom: Day;
  readonly validTo: Day | null;
  readonly value: ParameterValues[ParameterKey];
  readonly source: string;
}

type Reader = (value: Record<string, unknown>, fail: (problem: string) => never) => ParameterValues[ParameterKey];

function text(v: Record<string, unknown>, field: string, fail: (p: string) => never): string {
  const x = v[field];
  if (typeof x !== "string") return fail(`"${field}" must be a decimal string`);
  return x;
}

function rateOf(v: Record<string, unknown>, field: string, fail: (p: string) => never): Rate {
  const rate = toRate(text(v, field, fail));
  if (rate === null) return fail(`"${field}" must be a non-negative percentage, such as "9" or "15.5"`);
  return rate;
}

function centsOf(v: Record<string, unknown>, field: string, fail: (p: string) => never): Cents {
  const cents = toCents(text(v, field, fail));
  if (cents === null || cents < 0n) return fail(`"${field}" must be a non-negative amount to the cent`);
  return cents;
}

const READERS: Readonly<Record<ParameterKey, Reader>> = {
  "gst.standard_rate": (v, fail) => ({ rate: rateOf(v, "percent", fail) }),
  "cpf.ow_ceiling": (v, fail) => ({ amount: centsOf(v, "amount", fail) }),
  "cpf.annual_salary_ceiling": (v, fail) => ({ amount: centsOf(v, "amount", fail) }),
  "cpf.rates": (v, fail) => {
    const raw = v["bands"];
    if (!Array.isArray(raw) || raw.length === 0) return fail(`"bands" must be a non-empty list`);
    const bands = raw.map((b: unknown, i): CpfBand => {
      if (typeof b !== "object" || b === null) return fail(`band ${String(i)} is not an object`);
      const band = b as Record<string, unknown>;
      const aboveAge = band["aboveAge"];
      if (typeof aboveAge !== "number" || !Number.isInteger(aboveAge) || aboveAge < 0) {
        return fail(`band ${String(i)}'s "aboveAge" must be a whole number of years`);
      }
      return { aboveAge, employer: rateOf(band, "employer", fail), employee: rateOf(band, "employee", fail) };
    });
    if (bands[0]?.aboveAge !== 0) return fail(`the first band must start at "aboveAge": 0`);
    for (let i = 1; i < bands.length; i += 1) {
      if ((bands[i]?.aboveAge ?? 0) <= (bands[i - 1]?.aboveAge ?? 0)) {
        return fail(`the bands must be in ascending "aboveAge" order`);
      }
    }
    return { aboveMonthlyWage: centsOf(v, "aboveMonthlyWage", fail), bands };
  },
  "cpf.contributing_passes": (v, fail) => {
    const raw = v["passTypes"];
    if (!Array.isArray(raw)) return fail(`"passTypes" must be a list`);
    const passTypes = raw.map((p: unknown): PassType => {
      if (typeof p !== "string" || !(PASS_TYPES as readonly string[]).includes(p)) {
        return fail(`"${String(p)}" is not a pass type (${PASS_TYPES.join(", ")})`);
      }
      return p as PassType;
    });
    return { passTypes };
  },
  "sdl.levy": (v, fail) => {
    const minimum = centsOf(v, "minimum", fail);
    const maximum = centsOf(v, "maximum", fail);
    if (maximum < minimum) return fail(`"maximum" is below "minimum"`);
    return { rate: rateOf(v, "percent", fail), minimum, maximum };
  },
};

function isKey(key: string): key is ParameterKey {
  return (PARAMETER_KEYS as readonly string[]).includes(key);
}

/**
 * The values of ONE jurisdiction, read once and looked up by day. Built from
 * every row the adapter returned; rows of another jurisdiction are refused, so
 * a Singapore check can never read an Indian rate.
 */
export class RuleParameters {
  private constructor(
    readonly jurisdiction: string,
    private readonly rows: readonly Parsed[],
  ) {}

  static from(jurisdiction: string, rows: readonly RuleParameterRow[]): RuleParameters {
    const parsed: Parsed[] = [];
    for (const row of rows) {
      const fail = (problem: string): never => {
        throw new RuleParameterUnreadable(row.key, row.validFrom, problem);
      };
      if (row.jurisdiction !== jurisdiction) {
        fail(`it is ${row.jurisdiction}'s, and this set is ${jurisdiction}'s`);
      }
      if (!isCalendarDay(row.validFrom) || (row.validTo !== null && !isCalendarDay(row.validTo))) {
        fail("its dates are not calendar days");
      }
      if (row.validTo !== null && row.validTo <= row.validFrom) fail("it ends before it starts");
      if (!isKey(row.key)) continue;
      if (typeof row.value !== "object" || row.value === null || Array.isArray(row.value)) {
        fail("its value is not an object");
      }
      const value = READERS[row.key](row.value as Record<string, unknown>, fail);
      parsed.push({ key: row.key, validFrom: row.validFrom, validTo: row.validTo, value, source: row.source });
    }
    // Two rows of one key on one day would make a lookup an arbitrary pick.
    // The table's exclusion constraint already refuses it; a hand-built set
    // (a test, a fake) is held to the same rule here.
    for (const a of parsed) {
      for (const b of parsed) {
        if (a === b || a.key !== b.key) continue;
        const aEnd = a.validTo ?? "9999-12-31";
        const bEnd = b.validTo ?? "9999-12-31";
        if (a.validFrom < bEnd && b.validFrom < aEnd) {
          throw new RuleParameterUnreadable(a.key, a.validFrom, `it overlaps the row from ${b.validFrom}`);
        }
      }
    }
    return new RuleParameters(jurisdiction, parsed);
  }

  /** The value of `key` in force on `day`, or null when no row covers it. */
  inForce<K extends ParameterKey>(key: K, day: Day): InForce<K> | null {
    const row = this.rows.find(
      (r) => r.key === key && r.validFrom <= day && (r.validTo === null || day < r.validTo),
    );
    if (row === undefined) return null;
    return { value: row.value as ParameterValues[K], validFrom: row.validFrom, source: row.source };
  }

  /** Just the value, for a check that does not report where it came from. */
  value<K extends ParameterKey>(key: K, day: Day): ParameterValues[K] | null {
    return this.inForce(key, day)?.value ?? null;
  }
}

/** The CPF band for an employee of `age`: the last band whose `aboveAge` the
 *  employee has reached. See `checks-payroll.ts` for which age that is. */
export function cpfBandFor(rates: CpfRatesValue, age: number): CpfBand {
  let chosen = rates.bands[0];
  for (const band of rates.bands) {
    if (band.aboveAge === 0 || age >= band.aboveAge) chosen = band;
  }
  if (chosen === undefined) throw new RangeError("a CPF rate table with no bands was read");
  return chosen;
}
