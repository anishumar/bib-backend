// One fact, written in two places that cannot import each other.
//
// A firm's work-item states and priorities come from
// `DEFAULT_WORK_ITEM_STATES` / `DEFAULT_WORK_ITEM_PRIORITIES`
// (src/domain/workitem/model.ts) when the tenant is created, and from a jsonb
// literal in a migration for the firms that already existed. SQL cannot import
// TypeScript, so the duplication is unavoidable — the DRIFT is not.
//
// Drift here is quiet in a specific way. Add a state in the code and every firm
// created before that change simply never gets it, and nothing fails. The
// symptom is not an error: it is a board at one firm that cannot express
// something a board at another firm can, and — worse, because the FLAGS carry
// the meaning — a firm whose `blocked` state is not flagged blocking, so nobody
// is ever asked why work is stuck.
//
// The same arrangement `tests/staffgrade/seed-parity.test.ts` makes for the
// grade ladder, for the same reason. Read that file's note on why this is
// pinned to the NEWEST carrier rather than to 0050.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORK_ITEM_PRIORITIES,
  DEFAULT_WORK_ITEM_STATES,
} from "../../src/domain/workitem/model";

const MIGRATIONS = "migrations";
const STATES_MARKER = "@default-work-item-states-seed";
const PRIORITIES_MARKER = "@default-work-item-priorities-seed";

/**
 * The seed from the NEWEST migration that carries one.
 *
 * Newest, not 0050: bringing existing firms forward after a change to the
 * defaults means a NEW migration, because an applied one is immutable. A test
 * pinned to 0050 would make that correct fix look like a regression, and the
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
        `seeded vocabulary to the product defaults; restore the marker rather than deleting ` +
        `this test.`,
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

describe("the seeded work vocabulary and the product defaults agree", () => {
  it("seeds exactly the states the code would", () => {
    const { file, rows } = newestSeed(STATES_MARKER);
    expect(rows, `${file} seeds different states from DEFAULT_WORK_ITEM_STATES`).toEqual(
      DEFAULT_WORK_ITEM_STATES.map((s) => ({ ...s })),
    );
  });

  it("seeds exactly the priorities the code would", () => {
    const { file, rows } = newestSeed(PRIORITIES_MARKER);
    expect(
      rows,
      `${file} seeds different priorities from DEFAULT_WORK_ITEM_PRIORITIES`,
    ).toEqual(DEFAULT_WORK_ITEM_PRIORITIES.map((p) => ({ ...p })));
  });

  it("has one state per code, and one priority per code", () => {
    const stateCodes = DEFAULT_WORK_ITEM_STATES.map((s) => s.code);
    expect(new Set(stateCodes).size).toBe(stateCodes.length);
    const priorityCodes = DEFAULT_WORK_ITEM_PRIORITIES.map((p) => p.code);
    expect(new Set(priorityCodes).size).toBe(priorityCodes.length);
  });

  it("gives a new firm EXACTLY ONE starting state", () => {
    // A firm with none cannot create a single work item; a firm with two makes
    // "what state is a new filing in" a coin toss. The database enforces at
    // most one and cannot enforce at least one, so the seed is what guarantees
    // the floor — which makes this assertion the floor's only proof.
    expect(DEFAULT_WORK_ITEM_STATES.filter((s) => s.isInitial)).toHaveLength(1);
  });

  it("gives a new firm exactly one default and one statutory-default priority", () => {
    expect(DEFAULT_WORK_ITEM_PRIORITIES.filter((p) => p.isDefault)).toHaveLength(1);
    expect(DEFAULT_WORK_ITEM_PRIORITIES.filter((p) => p.isStatutoryDefault)).toHaveLength(1);
  });

  it("flags at least one state as BLOCKED, or nothing ever asks why work is stuck", () => {
    // The capture-or-lose pair only fires on a state whose `isBlocked` is set.
    // A seed with none would ship a firm that can put work into "Blocked" and
    // never record a reason — which is the exact failure the pair exists for,
    // arrived at through the seed instead of through the code.
    expect(DEFAULT_WORK_ITEM_STATES.some((s) => s.isBlocked)).toBe(true);
  });

  it("ships TWO terminal states and marks only ONE of them a success", () => {
    // 0054, and the reason it exists. Completed and Cancelled are both
    // terminal, and a rule reading `isTerminal` alone treats them alike — which
    // is how the compliance calendar would have recorded a statutory return as
    // FILED because somebody tidied their board, and how `work_item.completed`
    // came to count cancellations as work the firm finished.
    const terminal = DEFAULT_WORK_ITEM_STATES.filter((s) => s.isTerminal);
    expect(terminal.length).toBeGreaterThan(1);
    expect(terminal.filter((s) => s.isSuccess)).toHaveLength(1);
  });

  it("never calls a state a success unless it is terminal", () => {
    // The database CHECK, restated: work that is still running has not
    // succeeded yet, so the flag means nothing on it.
    for (const s of DEFAULT_WORK_ITEM_STATES) {
      expect(s.isSuccess && !s.isTerminal, `${s.code} claims success but is not terminal`).toBe(
        false,
      );
    }
  });

  it("never flags one state two ways — each pair is a contradiction", () => {
    for (const s of DEFAULT_WORK_ITEM_STATES) {
      expect(s.isTerminal && s.isBlocked, `${s.code} is terminal AND blocked`).toBe(false);
      expect(s.isInitial && s.isTerminal, `${s.code} is initial AND terminal`).toBe(false);
      expect(s.isInitial && s.isBlocked, `${s.code} is initial AND blocked`).toBe(false);
    }
  });

  it("ranks every priority as a whole number above zero", () => {
    for (const p of DEFAULT_WORK_ITEM_PRIORITIES) {
      expect(Number.isInteger(p.rank), `${p.code} has a non-integer rank`).toBe(true);
      expect(p.rank, `${p.code} is ranked at or below zero`).toBeGreaterThan(0);
    }
  });
});
