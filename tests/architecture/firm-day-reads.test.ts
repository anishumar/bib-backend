// The dashboard's ageing reads the FIRM's day (audit 2026-10-03, B29).
//
// `crm.receivable_ageing` buckets on CURRENT_DATE, the database session's day,
// which is UTC here and yesterday in India until 05:30. 0328 added
// `crm.receivable_ageing_on(day)`, and this keeps every adapter on it: a read
// of the old view, or a CURRENT_DATE in the dashboard's own SQL, would bring
// the bug back silently, because both answer correctly for eighteen and a half
// hours a day. A grep, for `instant-format.test.ts`'s reason: no behavioural
// test run in the afternoon can see it.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ADAPTERS = "src/infrastructure/postgres";

/** The file with its comments removed: the ban is on code, not on the
 *  sentence explaining it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("ageing is read on the firm's day", () => {
  it("no adapter reads crm.receivable_ageing; they call crm.receivable_ageing_on(day)", () => {
    const offenders = readdirSync(ADAPTERS)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /crm\.receivable_ageing(?!_on)\b/.test(code(`${ADAPTERS}/${f}`)));
    expect(offenders).toEqual([]);
  });

  it("the dashboard's SQL never asks the database what day it is", () => {
    expect(code(`${ADAPTERS}/dashboard-repository.ts`)).not.toMatch(/current_date/i);
  });
});
