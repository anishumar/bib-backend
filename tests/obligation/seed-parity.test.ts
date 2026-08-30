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
import {
  DEFAULT_OBLIGATION_STATES,
  DEFAULT_RESOLUTION_OPTIONS,
} from "../../src/domain/obligation/model";

const MIGRATIONS = "migrations";
const STATES_MARKER = "@default-obligation-states-seed";
const OPTIONS_MARKER = "@default-resolution-options-seed";

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

  it("gives a FINISHED filing exactly one place to land", () => {
    // 0054, and the partial unique index enforces at most one. "At least one"
    // it cannot enforce, so the floor is here: a firm with none has a completed
    // task and an obligation the calendar keeps showing as open, which is the
    // silent failure this module is built against. Exactly one, because with
    // two, where a finished filing goes is a coin toss.
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.isFiled)).toHaveLength(1);
  });

  it("never marks a state filed unless it is also terminal", () => {
    // The database CHECK, restated. A filing that landed somewhere still
    // running would be neither finished nor open.
    for (const s of DEFAULT_OBLIGATION_STATES) {
      expect(s.isFiled && !s.isTerminal, `${s.code} claims filed but not terminal`).toBe(false);
    }
  });

  it("gives a PASSED deadline exactly one place to go", () => {
    // 0055, and the same argument `isFiled` makes one flag earlier. With none,
    // the nightly sweep throws `NoMissedState` and no missed deadline ever
    // reaches a partner — the silence this whole feature exists to break. With
    // two, where an overdue filing goes is a coin toss.
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.isMissed)).toHaveLength(1);
  });

  it("sends it somewhere that actually ASKS somebody", () => {
    // The refusal that makes the flag worth having. A firm could otherwise mark
    // an ordinary working state as the missed one, and every overdue filing
    // would move there silently and be asked about by nobody — indistinguishable
    // from the product not working.
    for (const s of DEFAULT_OBLIGATION_STATES) {
      expect(s.isMissed && !s.needsDecision, `${s.code} is missed but asks nobody`).toBe(false);
    }
  });

  it("gives a partner's DECISION exactly one place to end", () => {
    expect(DEFAULT_OBLIGATION_STATES.filter((s) => s.isResolution)).toHaveLength(1);
  });

  it("never marks a state a resolution unless it is also terminal", () => {
    for (const s of DEFAULT_OBLIGATION_STATES) {
      expect(
        s.isResolution && !s.isTerminal,
        `${s.code} claims resolution but not terminal`,
      ).toBe(false);
    }
  });

  it("never gives one state two destinations", () => {
    // The four are answers to four different questions — where filings start,
    // where a finished one lands, where an overdue one goes, where a decision
    // ends one. A row claiming two makes every rule that reads them disagree
    // about what it is.
    for (const s of DEFAULT_OBLIGATION_STATES) {
      const held = [s.isInitial, s.isFiled, s.isMissed, s.isResolution].filter(Boolean).length;
      expect(held, `${s.code} claims ${held} destinations`).toBeLessThanOrEqual(1);
    }
  });

  it("keeps FILED and RESOLVED apart — they are different endings", () => {
    // The distinction 0054 could not express and 0055 finally names. One is a
    // filing that was made; the other is a filing a partner decided would never
    // be made. Collapsing them would record a statutory return as filed because
    // somebody accepted that it never applied.
    const filed = DEFAULT_OBLIGATION_STATES.find((s) => s.isFiled);
    const resolved = DEFAULT_OBLIGATION_STATES.find((s) => s.isResolution);
    expect(filed?.code).not.toBe(resolved?.code);
  });

  it("keeps the OTHER terminal state clear of it — that one is T3.3's", () => {
    // `resolved` is the end of a deadline already missed, which a partner
    // chose. Reading `isTerminal` to find where a filing lands would have been
    // a coin toss between the two, which is exactly why the flag exists.
    const terminal = DEFAULT_OBLIGATION_STATES.filter((s) => s.isTerminal);
    expect(terminal.length).toBeGreaterThan(1);
    expect(terminal.filter((s) => !s.isFiled).length).toBeGreaterThan(0);
  });
});

describe("the seeded resolution options and the product defaults agree", () => {
  it("seeds exactly the options the code would", () => {
    const { file, rows } = newestSeed(OPTIONS_MARKER);
    expect(rows, `${file} seeds different options from DEFAULT_RESOLUTION_OPTIONS`).toEqual(
      DEFAULT_RESOLUTION_OPTIONS.map((o) => ({ ...o })),
    );
  });

  it("has one option per code", () => {
    const codes = DEFAULT_RESOLUTION_OPTIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("offers BOTH forks, or the fork is not a fork", () => {
    // `closesWithoutFiling` is the only branch this feature has. A seeded list
    // where every option means the same thing would leave a firm unable to
    // express one of the two real answers on the day it needed to, and the
    // failure would look like the product simply not having the option.
    expect(DEFAULT_RESOLUTION_OPTIONS.some((o) => o.closesWithoutFiling)).toBe(true);
    expect(DEFAULT_RESOLUTION_OPTIONS.some((o) => !o.closesWithoutFiling)).toBe(true);
  });

  it("has no option meaning 'ignore'", () => {
    // Carried across from the demo deliberately, and worth a test because it is
    // the kind of convenience somebody adds later without noticing what it
    // costs. A passed statutory date is a fork with consequences either way; an
    // option that let one be dismissed would hide the thing this queue exists
    // to surface, and it would be the option everybody clicked.
    for (const o of DEFAULT_RESOLUTION_OPTIONS) {
      expect(o.code).not.toMatch(/ignore|dismiss|skip/);
    }
  });
});
