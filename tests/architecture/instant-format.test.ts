// A `timestamptz` leaves an adapter as an ISO 8601 instant, or it leaves as a
// string one browser refuses to read.
//
// ── THE BUG THIS CLASS OF TEST EXISTS FOR ──────────────────────────────────
//
// `SELECT now()::text` renders `2026-09-01 19:54:05.712839+00`. ECMAScript
// requires `Date` to accept exactly one shape — `YYYY-MM-DDTHH:mm:ss.sssZ`, a
// literal `T` and three fractional digits — and everything else is left to the
// engine. V8 takes the Postgres form (the first case below MEASURES that, and
// it is why every gate in this repo was green with it); JavaScriptCore
// historically does not. So a client on an iPhone read
// `2026-09-01 19:54:05.712839+00` on their own portal where the firm meant
// "1 Sep 2026", and nothing on a developer's machine could see it.
//
// ── WHICH IS WHY THE GUARD IS A GREP AS WELL AS AN ASSERTION ───────────────
//
// Same reasoning as `calendar-day.test.ts` next door: a behavioural test of the
// layer above proves nothing, because BOTH formats pass everywhere this is
// developed. The failure is in a browser nobody here runs. So the ban is on the
// CAST, structurally, across every adapter — the whole class, not the sites
// that happen to have a screen today.
//
// The companion `instant-format.integration.test.ts` measures what Postgres
// actually emits, in two different server timezones. This half needs no
// database and runs in `npm run check`.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isoInstant, utcDayOf } from "../../src/infrastructure/postgres/instant";

const ADAPTERS = "src/infrastructure/postgres";

/** The ECMAScript Date Time String Format — the one string every engine is
 *  REQUIRED to parse, and exactly what `toISOString()` produces. */
const ES_DATE_TIME_STRING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** What `timestamptz::text` gives, copied from a real row. */
const FROM_POSTGRES_TEXT = "2026-09-01 19:54:05.712839+00";

/** The same instant, as this codebase now puts it on the wire. */
const ISO = "2026-09-01T19:54:05.712Z";

/**
 * The file with its COMMENTS removed.
 *
 * `instant.ts` prints the banned cast in order to explain it, and a naive grep
 * reads the explanation as the offence — which would push somebody to delete
 * the sentence saying why the rule exists. THE BAN IS ON CODE.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function adapters(): readonly string[] {
  return readdirSync(ADAPTERS).filter((f) => f.endsWith(".ts"));
}

describe("a timestamptz crosses the wire as ISO 8601", () => {
  it("no Postgres adapter casts a timestamptz straight to text", () => {
    // `_at::date::text` is deliberately NOT matched. Asking SQL for the day is
    // the right answer when a day is what is wanted, and `utcDayOf` writes it.
    const offenders = adapters().filter((f) => /[a-z_]*_at\s*\)?::text/.test(code(`${ADAPTERS}/${f}`)));

    expect(
      offenders,
      `${offenders.join(", ")} render a \`timestamptz\` with \`::text\`, which gives ` +
        `"${FROM_POSTGRES_TEXT}" — a SPACE where ECMAScript requires a T, six fractional ` +
        `digits where it allows three, and rendered in whatever TimeZone the SERVER is set ` +
        `to rather than in UTC. Safari returns Invalid Date for it and the portal then prints ` +
        `the raw string to a client. Use isoInstant() from ./instant, or utcDayOf() when what ` +
        `is wanted is the calendar day.`,
    ).toEqual([]);
  });

  it("no adapter turns a timestamptz into a DAY without naming the zone", () => {
    // ── THE SAME RULE AS ABOVE, ON THE OTHER CAST (0071) ──────────────────
    //
    // `x_at::text` gives a string in the session's zone; `x_at::date` gives a
    // DAY in it, which is the same dependency with a worse failure — a day is
    // what a month is made of, so an unqualified cast put a document filed at
    // 02:00 IST on 1 October into SEPTEMBER's digest on a client's own page.
    //
    // The zone must be said out loud, either as UTC (`utcDayOf`) or as the
    // firm's own (a parameter, which is what the digest and the chaser take).
    // Both spell `AT TIME ZONE`, which is exactly what this grep looks for.
    const offenders = adapters().filter((f) => {
      const lines = code(`${ADAPTERS}/${f}`).split(/[\r\n]+/);
      return lines.some(
        (line) => /[a-z_]+_at\s*::\s*date/.test(line) && !line.includes("AT TIME ZONE"),
      );
    });

    expect(
      offenders,
      `${offenders.join(", ")} cast a \`timestamptz\` to a \`date\` without saying in which ` +
        `zone. That is the SESSION's, which is the database server's, which nobody chose — and ` +
        `it decides which MONTH a client sees a document in and which DAY the chaser counts ` +
        `from. Convert explicitly: \`(x AT TIME ZONE 'UTC')::date\` via utcDayOf, or ` +
        `\`(x AT TIME ZONE \${timeZone}::text)::date\` for the firm's own calendar (0071).`,
    ).toEqual([]);
  });

  it("the format string lives in exactly one place", () => {
    // One helper, one format, one thing for the integration test to measure.
    // A second copy is a second thing that can drift.
    const offenders = adapters().filter(
      (f) => f !== "instant.ts" && code(`${ADAPTERS}/${f}`).includes(`YYYY-MM-DD"T"`),
    );

    expect(
      offenders,
      `${offenders.join(", ")} spell the ISO format out inline. It belongs in instant.ts, ` +
        `which is the expression the integration test actually measures against Postgres.`,
    ).toEqual([]);
  });

  it("SHOWS why nothing here caught it: V8 accepts what Safari refuses", () => {
    // The measured fact the whole file rests on. Node parses the Postgres form
    // happily and lands on the right instant — so every test, every smoke run
    // and every browser walk on this machine was green while an iPhone was
    // rendering the raw string.
    expect(Number.isNaN(new Date(FROM_POSTGRES_TEXT).getTime())).toBe(false);
    // And yet it is not the format the specification pins.
    expect(ES_DATE_TIME_STRING.test(FROM_POSTGRES_TEXT)).toBe(false);
    // The new one is, and survives a round trip unchanged.
    expect(ES_DATE_TIME_STRING.test(ISO)).toBe(true);
    expect(new Date(ISO).toISOString()).toBe(ISO);
    // Same moment, both ways round — the change is the STRING, not the value.
    expect(new Date(FROM_POSTGRES_TEXT).toISOString()).toBe(ISO);
  });

  it("writes the expression, with and without an alias", () => {
    expect(isoInstant("a.raised_at", "raised_at")).toBe(
      `to_char(a.raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS raised_at`,
    );
    // Inside a scalar subquery the alias belongs outside it.
    expect(isoInstant("max(c.chased_at)")).toBe(
      `to_char(max(c.chased_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
  });

  it("asks SQL for a day rather than slicing one off an instant", () => {
    expect(utcDayOf("i.created_at", "created_on")).toBe(
      `(i.created_at AT TIME ZONE 'UTC')::date::text AS created_on`,
    );
  });

  it("names the zone in both, so no server setting can move a day", () => {
    // The second half of the bug, and the worse one. `timestamptz::text` renders
    // in the session's TimeZone; an invoice with no issued_on took its printed
    // date from `created_at.slice(0, 10)`, so the date on a numbered tax
    // document depended on postgresql.conf. Both helpers pin UTC.
    expect(isoInstant("x")).toContain("AT TIME ZONE 'UTC'");
    expect(utcDayOf("x", "y")).toContain("AT TIME ZONE 'UTC'");
  });
});
