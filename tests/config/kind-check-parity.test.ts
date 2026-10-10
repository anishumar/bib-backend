// The registry's closed set of kinds is written in two places: `CONFIG_KINDS`
// in the domain and `entry_kind_check` in SQL. SQL cannot import TypeScript, so
// the duplication is unavoidable and the DRIFT is not: a kind in the code and
// not in the CHECK is a body the validator accepts and the database refuses on
// the first publish; a kind in the CHECK and not in the code is a row nothing
// can validate or read.
//
// Read out of the NEWEST migration that states the CHECK, never a pinned one,
// for `tests/filestore/model.test.ts`'s reason: every widening (0010, 0016,
// 0033, 0044, 0047, 0048, 0055, 0058, 0065, 0067, 0384) drops the constraint
// and adds it back, so a test pinned to one file goes on reading a list the
// database no longer has.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KINDS } from "../../src/domain/config/model";

const NEEDLE = "ADD CONSTRAINT entry_kind_check CHECK";

function newestCarrier(): string {
  const carriers = readdirSync("migrations")
    .filter((f) => f.endsWith(".up.sql"))
    .filter((f) => readFileSync(`migrations/${f}`, "utf8").includes(NEEDLE))
    .sort(); // NNNN_ prefixes are zero-padded, so lexicographic IS numeric
  const file = carriers.at(-1);
  if (file === undefined) throw new Error(`no migration in migrations/ states ${NEEDLE} any more`);
  return file;
}

function checkMembers(file: string): string[] {
  const sql = readFileSync(`migrations/${file}`, "utf8");
  const at = sql.lastIndexOf(NEEDLE);
  // From the needle to the end of the statement: the members are the quoted
  // words in between, whichever of the two spellings (`IN (...)` or
  // `= ANY (ARRAY[...])`) the migration used.
  const end = sql.indexOf(";", at);
  return [...sql.slice(at, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

describe("the config kinds agree with the database", () => {
  it("CONFIG_KINDS is exactly the newest entry_kind_check", () => {
    expect(checkMembers(newestCarrier())).toEqual([...CONFIG_KINDS].sort());
  });

  it("and that migration is 0384 or later, the one that added request_template", () => {
    expect(newestCarrier() >= "0384").toBe(true);
    expect(checkMembers(newestCarrier())).toContain("request_template");
  });
});
