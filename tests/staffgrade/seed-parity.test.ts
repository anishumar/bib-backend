// One fact, written in two places that cannot import each other.
//
// A firm's rungs come from DEFAULT_GRADES (src/domain/staffgrade/model.ts) when
// the tenant is created, and from a jsonb literal in a migration for the firms
// that already existed. SQL cannot import TypeScript, so the duplication is
// unavoidable — but the DRIFT is not.
//
// Drift here is quiet and it is expensive in a specific way: add a rung in the
// code and every firm created before that change simply never gets it, and
// nothing fails. Since `rank` is what a review threshold compares, the symptom
// is not an error — it is somebody at one firm being unable to approve work
// their counterpart at another firm can, with no message anywhere saying why.
//
// The same arrangement `tests/config/seed-parity.test.ts` makes for roles, for
// the same reason. Read that file's note on why this is pinned to the NEWEST
// carrier rather than to 0040.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_GRADES } from "../../src/domain/staffgrade/model";

const MIGRATIONS = "migrations";
const MARKER = "@default-grades-seed";

interface SeededGrade {
  code: string;
  name: string;
  rank: number;
}

/**
 * The grade seed from the NEWEST migration that carries one.
 *
 * Newest, not 0040: bringing existing firms forward after a change to
 * DEFAULT_GRADES means a NEW migration, because an applied one is immutable. A
 * test pinned to 0040 would make that correct fix look like a regression, and
 * the tempting way out of a red build would be to edit an applied migration.
 */
function newestSeed(): { file: string; grades: SeededGrade[] } {
  const carriers = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".up.sql"))
    .filter((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8").includes(MARKER))
    .sort(); // NNNN_ prefixes are zero-padded, so lexicographic IS numeric

  const file = carriers.at(-1);
  if (file === undefined) {
    throw new Error(
      `no migration in ${MIGRATIONS}/ carries a line marked ${MARKER}. It is what binds the ` +
        `seeded ladder to DEFAULT_GRADES; restore the marker rather than deleting this test.`,
    );
  }

  const line = readFileSync(`${MIGRATIONS}/${file}`, "utf8")
    .split("\n")
    .find((l) => l.includes(MARKER));
  if (line === undefined) throw new Error(`${file} lost its ${MARKER} line mid-read`);
  const start = line.indexOf("'");
  const end = line.indexOf("'::jsonb");
  if (start === -1 || end <= start) {
    throw new Error(
      `could not find the jsonb literal on the ${MARKER} line of ${file}. Keep the literal on ` +
        `ONE line, opening with a quote and closing with '::jsonb — that shape is what this ` +
        `test parses.`,
    );
  }
  const literal = line.slice(start + 1, end);
  return { file, grades: JSON.parse(literal) as SeededGrade[] };
}

describe("the seeded ladder and DEFAULT_GRADES agree", () => {
  it("seeds exactly the rungs the code would", () => {
    const { file, grades } = newestSeed();
    expect(grades, `${file} seeds a different ladder from DEFAULT_GRADES`).toEqual(
      DEFAULT_GRADES.map((g) => ({ code: g.code, name: g.name, rank: g.rank })),
    );
  });

  it("has one rung per code — a duplicate would make the threshold ambiguous", () => {
    const codes = DEFAULT_GRADES.map((g) => g.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("keeps a rung coded `manager`, which the firm's review rule names", () => {
    // "Manager or above is fine" is the firm's stated rule and the only reason
    // `rank` exists. A ladder with no rung coded `manager` leaves that rule with
    // nothing to resolve against — the demo hit exactly this and recorded it.
    expect(DEFAULT_GRADES.map((g) => g.code)).toContain("manager");
  });

  it("ranks every rung as a whole number above zero", () => {
    for (const grade of DEFAULT_GRADES) {
      expect(Number.isInteger(grade.rank), `${grade.code} has a non-integer rank`).toBe(true);
      expect(grade.rank, `${grade.code} is ranked at or below zero`).toBeGreaterThan(0);
    }
  });
});
