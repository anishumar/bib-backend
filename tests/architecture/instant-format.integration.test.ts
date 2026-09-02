// What Postgres ACTUALLY emits — measured, in two server timezones.
//
// `instant-format.test.ts` next door bans `timestamptz::text` across every
// adapter and proves the one helper is the only place the format is written.
// That chain has a link this file supplies: what the helper's expression
// evaluates to when a real Postgres runs it. Everything above rests on the
// string it produces, and until now that string had only ever been reasoned
// about.
//
// Two facts are established here, and the second is the one that was invisible:
//
//   1. THE FORMAT. `to_char(… , 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` gives
//      `2026-09-01T19:54:05.712Z` — byte for byte what JS `toISOString()`
//      produces, which is the one shape every engine must accept. The old
//      `::text` is measured beside it, so the constant the unit test quotes is
//      a reading rather than a memory.
//
//   2. THE ZONE. `timestamptz::text` renders in the SESSION's TimeZone.
//      `src/db/pool.ts` sets none, so it is the SERVER's — UTC in the compose
//      container, which is why every string anyone here has looked at ended
//      `+00`. Run the same query with `TimeZone = Asia/Kolkata` and the same
//      row renders a different DAY. `render-source.ts` sliced its invoice date
//      off that string, so the date printed on a numbered tax document depended
//      on `postgresql.conf`. The helpers pin UTC and do not move.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { isoInstant, utcDayOf } from "../../src/infrastructure/postgres/instant";

const cfg = load();
// The owner pool, deliberately: nothing here reads a tenant's rows. The subject
// is a literal, so no seed, no RLS and no fixture is involved.
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

/** One instant, chosen so that UTC and IST fall on DIFFERENT calendar days —
 *  19:54 UTC is 01:24 the next morning in Kolkata. */
const SUBJECT = "2026-09-01T19:54:05.712839Z";
const ISO = "2026-09-01T19:54:05.712Z";

interface Reading {
  iso: string | null;
  day: string | null;
  raw: string;
}

/**
 * The three renderings of the same instant, on one connection, in one zone.
 *
 * ── THE SUBJECT IS A SQL LITERAL, AND HAD TO BECOME ONE ────────────────────
 *
 * It was a bound parameter first, and the reading came back `…05.712+00` —
 * three digits where the server stores six. postgres.js turns a parameter that
 * looks like a timestamp into a JS `Date` on the way OUT, and a `Date` holds
 * milliseconds. So the driver had quietly rounded the very precision this test
 * exists to observe. Written as a literal, Postgres parses it itself and the
 * microseconds survive — which is what `now()` puts in a real row, and
 * therefore what the old `::text` really rendered to a client.
 */
async function readIn(timeZone: string, subject: string | null = SUBJECT): Promise<Reading> {
  const literal = subject === null ? "NULL::timestamptz" : `'${subject}'::timestamptz`;
  return owner.begin(async (tx) => {
    // SET LOCAL, so the zone belongs to this transaction and cannot leak into
    // another test through a pooled connection.
    await tx.unsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
    const [row] = await tx<Reading[]>`
      SELECT ${tx.unsafe(isoInstant("s.t", "iso"))},
             ${tx.unsafe(utcDayOf("s.t", "day"))},
             coalesce(s.t::text, '<null>') AS raw
        FROM (SELECT ${tx.unsafe(literal)} AS t) s
    `;
    if (!row) throw new Error("no row");
    return row;
  });
}

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("the instant a timestamptz becomes on the wire", () => {
  it("is the ECMAScript Date Time String Format, exactly", async () => {
    const utc = await readIn("UTC");
    expect(utc.iso).toBe(ISO);
    // The round trip is the whole point: this is a string `Date` is REQUIRED to
    // parse, and parsing it returns the same string.
    expect(new Date(utc.iso ?? "").toISOString()).toBe(ISO);
  });

  it("MEASURES the old `::text` the unit test quotes", async () => {
    const utc = await readIn("UTC");
    // The constant in instant-format.test.ts, read off a real server rather
    // than remembered. A space, six fractional digits, and a bare `+00`.
    expect(utc.raw).toBe("2026-09-01 19:54:05.712839+00");
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(utc.raw)).toBe(false);
  });

  it("does not move when the SERVER's timezone does", async () => {
    const utc = await readIn("UTC");
    const ist = await readIn("Asia/Kolkata");
    const west = await readIn("America/New_York");
    expect(ist.iso).toBe(ISO);
    expect(west.iso).toBe(ISO);
    expect(ist.iso).toBe(utc.iso);
  });

  it("SHOWS the old cast moving a DAY when the server's timezone changes", async () => {
    // The invoice-date bug, measured. Same row, same query, two servers — and
    // `slice(0, 10)` of the raw text names two different days, one of which is
    // the wrong date on a tax document an auditor reads.
    const utc = await readIn("UTC");
    const ist = await readIn("Asia/Kolkata");
    expect(utc.raw.slice(0, 10)).toBe("2026-09-01");
    expect(ist.raw.slice(0, 10)).toBe("2026-09-02");
    expect(ist.raw.slice(0, 10)).not.toBe(utc.raw.slice(0, 10));

    // `utcDayOf` is the fix, and it names the same day on both.
    expect(utc.day).toBe("2026-09-01");
    expect(ist.day).toBe("2026-09-01");
  });

  it("keeps NULL a real answer", async () => {
    // An unanswered ask has no reply date and an unsigned letter has no signing
    // moment. `to_char(NULL, …)` is NULL, and nothing fabricates a time.
    const none = await readIn("UTC", null);
    expect(none.iso).toBeNull();
    expect(none.day).toBeNull();
  });
});
