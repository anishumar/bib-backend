// A date the API accepts must be a day that exists (audit 2026-10-03, B43).
//
// `isDay` took 2026-02-31 because V8 parses it and rolls it into March, and
// three more modules checked only the SHAPE (`\d{4}-\d{2}-\d{2}`), so
// 2026-13-45 got through. Postgres then refused the cast with SQLSTATE 22008,
// which nothing mapped, and the caller got a 500 for a typo. Every validator
// now asks for a real calendar day, and the error map answers 22008/22007 as
// a 400 anyway, as the floor for any path that still reaches the database.
import { describe, expect, it } from "vitest";
import { isCalendarDay } from "../../src/domain/day";
import { isDay } from "../../src/domain/engagement/model";
import { isIsoDate as assignmentDay } from "../../src/domain/clientassignment/model";
import { isIsoDate as partyDay } from "../../src/domain/party/model";
import { isIsoDate as workItemDay } from "../../src/domain/workitem/model";
import { mapError } from "../../src/api/domainerr";

const validators = { isCalendarDay, isDay, assignmentDay, partyDay, workItemDay };

describe.each(Object.entries(validators))("%s", (_name, check) => {
  it.each([["2026-02-28"], ["2024-02-29"], ["2026-12-31"], ["2000-02-29"]])("takes %s", (day) => {
    expect(check(day)).toBe(true);
  });

  it.each([["2026-02-31"], ["2026-02-29"], ["1900-02-29"], ["2026-04-31"], ["2026-13-01"], ["2026-00-10"], ["2026-10-00"], ["2026-10-1"], ["2026-10-01T00:00:00Z"], [""]])(
    "refuses %s",
    (day) => {
      expect(check(day)).toBe(false);
    },
  );
});

describe("the database's own refusal of a date", () => {
  it.each([["22008"], ["22007"]])("answers SQLSTATE %s as a 400, in plain words", (code) => {
    const mapped = mapError(Object.assign(new Error('date/time field value out of range: "2026-02-31"'), { code }));
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe("VALIDATION");
    expect(mapped.message).toMatch(/real date/i);
    expect(mapped.message).not.toMatch(/22008|SQLSTATE|field value/);
  });
});
