// One fact, written in two places that cannot import each other (T3.2).
//
// A firm's obligation states come from `DEFAULT_OBLIGATION_STATES`
// (src/domain/obligation/model.ts) when the tenant is created, and from a jsonb
// literal in a migration for the firms that already existed. SQL cannot import
// TypeScript, so the duplication is unavoidable — the DRIFT is not.
//
// Drift here is quiet in the way T3.1's is, only worse. Add a state in the code
// and every firm created before that change never gets it, and nothing fails.
// The symptom is a partner's decision queue at one firm that cannot express
// something another firm's can — and because the FLAGS carry the meaning, a
// firm whose `missed` state is not flagged `needs_decision` has a missed
// statutory deadline that reaches nobody at all.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_OBLIGATION_STATES } from "../../src/domain/obligation/model";

const MIGRATIONS = "migrations";
const STATES_MARKER = "@default-obligation-states-seed";

/**
 * The seed from the NEWEST migration that carries one.
 *
 * Newest, not 0052: bringing existing firms forward after a change to the
 * defaults means a NEW migration, because an applied one is immutable. A test
 * pinned to 0052 would make that correct fix look like a regression, and the
 * tempting way out of a red build would be to edit an applied migration.
 */
function newestSeed(marker: string): { file: string; rows: unknown[] } {
  const carriers = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".up.sql"))
    .filter((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8").includes(marker))
    .sort(); // NNNN_ prefixes are zero-padded, so lexicographic IS numeric

  const file = carriers.at(-1);
  if (file === undefined) {
    throw new Error(
      `no migration in ${MIGRATIONS}/ carries a line marked ${marker}. It is what binds the ` +
        `seeded obligation states to the product defaults; restore the marker rather than ` +
        `deleting this test.`,
    );
  }

  const line = readFileSync(`${MIGRATIONS}/${file}`, "utf8")
    .split("\n")
    .find((l) => l.includes(marker));
  if (line === undefined) throw new Error(`${file} lost its ${marker} line mid-read`);
  const start = line.indexOf("'");
  const end = line.indexOf("'::jsonb");
  if (start === -1 || end <= start) {
    throw new Error(
      `could not find the jsonb literal on the ${marker} line of ${file}. Keep the literal on ` +
        `ONE line, opening with a quote and closing with '::jsonb — that shape is what this ` +
        `test parses.`,
    );
  }
  return { file, rows: JSON.parse(line.slice(start + 1, end)) as unknown[] };
}

describe("the seeded obligation states and the product defaults agree", () => {
  it("seeds exactly the states the code would", () => {
    const { file, rows } = newestSeed(STATES_MARKER);
    expect(rows, `${file} seeds different states from DEFAULT_OBLIGATION_STATES`).toEqual(
      DEFAULT_OBLIGATION_STATES.map((s) => ({ ...s })),
    );
  });

  it("has one state per code", () => {
    const codes = DEFAULT_OBLIGATION_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives a new firm EXACTLY ONE starting state", () => {
    // A firm with none cannot have a single filing generated; a firm with two
    // makes "what state is a new obligation in" a coin toss. The database
    // enforces at most one (a partial unique index) and cannot enforce at least
    // one, so the seed is what guarantees the floor.
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.isInitial)).toHaveLength(1);
  });

  it("gives a new firm somewhere for a MISSED deadline to land", () => {
    // The most consequential row in the set. A missed statutory date is a state
    // a partner resolves, not an error the system hides — and if no seeded
    // state carries `needsDecision`, T3.3's queue is empty by construction and
    // the moment where money and liability are decided reaches nobody.
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.needsDecision).length).toBeGreaterThan(0);
  });

  it("never marks a state both terminal and needing a decision", () => {
    // The database CHECK, restated: a state cannot be over AND waiting on
    // somebody. `missed` is deliberately NOT terminal, which is the entire
    // point of T3.3.
    for (const s of DEFAULT_OBLIGATION_STATES) {
      expect(s.isTerminal && s.needsDecision, `${s.code} claims both`).toBe(false);
    }
  });

  it("gives a generated obligation somewhere to FINISH", () => {
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.isTerminal).length).toBeGreaterThan(0);
  });
});
