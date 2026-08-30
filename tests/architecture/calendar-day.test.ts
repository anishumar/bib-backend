// A `date` column is a DAY, and reading its LOCAL fields loses one.
//
// ── THE MEASURED FACT ──────────────────────────────────────────────────────
//
// postgres.js materialises a `date` column at **UTC midnight** — asked for
// `'2026-08-20'::date` it returns `2026-08-20T00:00:00.000Z` in every zone.
// That was checked against the real database, not reasoned about, and this
// whole file exists because reasoning about it went wrong twice already.
//
// So the UTC fields give the stored day everywhere, and the LOCAL fields give
// the day that instant falls on wherever the process runs — the day BEFORE,
// west of Greenwich.
//
// ── WHY THE TRAP IS THE ONE THAT LOOKS SAFER ───────────────────────────────
//
// `getFullYear()/getMonth()/getDate()` reads like the careful choice: no string
// slicing, and no `UTC`, which in this codebase is usually the thing to be
// suspicious of. `engagement-repository.ts` used it and carried a comment
// saying the UTC read "would be wrong east of UTC". The comment and the code
// were both backwards, `proposal-repository.ts` copied both, and nothing went
// red — because the failure only appears WEST of Greenwich and nothing here
// runs there. An invoice dated the 20th would read as the 19th on a laptop in
// New York or in a pod in `us-east-1`.
//
// ── WHICH IS WHY THIS TEST IS STRUCTURAL AS WELL AS BEHAVIOURAL ────────────
//
// A behavioural test alone proves nothing on the machines this is developed on:
// east of Greenwich BOTH implementations pass. So the guard is also a GREP over
// the adapters, in the spirit of `tests/api/query-booleans.test.ts` — that one
// bans `z.coerce.boolean()` because `Boolean("false")` is true; this one bans
// the local getters because a `date` from Postgres is a UTC instant. Both are a
// whole CLASS of bug that a unit test of the layer above cannot see.
//
// The behavioural half below does not need a particular TZ either: it asks
// `Intl` what each zone WOULD say about the same instant, so the difference is
// visible on a UTC runner.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toDay, toDayOrNull } from "../../src/infrastructure/postgres/day";

const ADAPTERS = "src/infrastructure/postgres";

/** Exactly what postgres.js hands back for `'2026-08-20'::date`. Measured. */
const FROM_POSTGRES = new Date("2026-08-20T00:00:00.000Z");
const STORED = "2026-08-20";

/** What the LOCAL getters would return for that instant, in a given zone —
 *  i.e. what the old `toDay` did, without needing to run under that zone. */
function localFieldsIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * The file with its COMMENTS removed.
 *
 * Lifted from `tests/api/query-booleans.test.ts`, and needed for the same
 * reason — `day.ts` names the banned expression in order to explain it, and a
 * naive grep reads the explanation as the offence. That would push somebody to
 * delete the sentence saying why the rule exists. THE BAN IS ON CODE.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("a date column is read by its UTC fields, never its local ones", () => {
  it("no Postgres adapter reads the local date fields of a row value", () => {
    const offenders = readdirSync(ADAPTERS)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\.getFullYear\(\)|\.getMonth\(\)|\.getDate\(\)/.test(code(`${ADAPTERS}/${f}`)));

    expect(
      offenders,
      `${offenders.join(", ")} read the LOCAL date fields of a value that came out of ` +
        `Postgres. postgres.js builds a \`date\` column at UTC midnight, so the local fields ` +
        `give the day BEFORE anywhere west of Greenwich — an invoice issued on the 20th reads ` +
        `as the 19th, and a payment received on 1 April reads as 31 March, in the previous ` +
        `financial year. Use toDay / toDayOrNull from ./day, or cast the column in SQL ` +
        `(\`some_date::text\`), which is better still because no Date is constructed at all.`,
    ).toEqual([]);
  });

  it("returns the stored day, and would in every zone", () => {
    expect(toDay(FROM_POSTGRES)).toBe(STORED);
    expect(toDayOrNull(FROM_POSTGRES)).toBe(STORED);
    expect(toDayOrNull(null)).toBeNull();
  });

  it("SHOWS the local fields losing a day west of Greenwich", () => {
    // The point of the whole exercise, visible on a UTC runner: same instant,
    // four zones, and the ones behind UTC name the previous day. `toDay` does
    // not move, because it never asks a zone anything.
    expect(localFieldsIn(FROM_POSTGRES, "Asia/Kolkata")).toBe(STORED);
    expect(localFieldsIn(FROM_POSTGRES, "Europe/London")).toBe(STORED);
    expect(localFieldsIn(FROM_POSTGRES, "America/New_York")).toBe("2026-08-19");
    expect(localFieldsIn(FROM_POSTGRES, "Pacific/Honolulu")).toBe("2026-08-19");
    expect(toDay(FROM_POSTGRES)).toBe(STORED);
  });

  it("holds across the boundaries that cost a financial year", () => {
    // 1 April is the day an Indian financial year turns, and it is the one a
    // payment must not slip across.
    expect(toDay(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-01");
    expect(localFieldsIn(new Date("2026-04-01T00:00:00.000Z"), "America/New_York")).toBe(
      "2026-03-31",
    );
    expect(toDay(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
  });
});
