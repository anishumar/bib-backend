// `z.coerce.boolean()` may never parse a query parameter.
//
// ── THE BUG THIS EXISTS BECAUSE OF ─────────────────────────────────────────
//
// `/api/v1/calendar` took `includeSettled: z.coerce.boolean().optional()`.
// Coercion is `Boolean(value)`, and a query string carries STRINGS, so
// `?includeSettled=false` arrived as the string "false" and coerced to TRUE.
// The filter was therefore permanently on: every caller unticking the box on
// `/calendar` was ignored, and the screen showed the opposite of what it said.
//
// Nothing caught it. The parameter parsed, the route answered 200, the SQL ran,
// and the two branches are indistinguishable until a row is actually terminal —
// which nothing in the product could make one until 0054 gave `filed_on` a
// writer. It was found by walking the chain against a running server, which is
// the only place it was ever visible.
//
// ── WHY A BAN RATHER THAN A TEST OF THAT ONE ROUTE ────────────────────────
//
// The instance is fixed and has its own coverage. This is about the CLASS: the
// next boolean query parameter somebody adds will reach for the same coercion,
// it will be wrong the same way, and it will be just as invisible. A grep held
// in the build is what stops that, the same shape as `cors-methods.test.ts`
// reading every verb the handlers register.
//
// JSON BODIES ARE NOT AFFECTED and are not searched — `z.boolean()` over a
// parsed body receives a real boolean and is correct. This is only about values
// that arrive as text.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const HANDLERS = "src/api/handler";

function handlerFiles(): string[] {
  return readdirSync(HANDLERS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${HANDLERS}/${f}`);
}

/**
 * The file with its COMMENTS removed.
 *
 * Found by this test failing on itself: the fix to `/api/v1/calendar` carries a
 * comment explaining the trap, and that comment names the coercion. A naive
 * grep reads the explanation as the offence and would push somebody to delete
 * the sentence that says why the rule exists — the exact opposite of the point.
 * The ban is on CODE.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("no query parameter is parsed with z.coerce.boolean()", () => {
  it("is the trap, demonstrated", () => {
    // The whole reason for the rule, in two lines. If this ever stops holding,
    // zod changed its coercion and the ban can be reconsidered — until then it
    // is exactly as true as `Boolean("false")`.
    expect(z.coerce.boolean().parse("false")).toBe(true);
    expect(z.coerce.boolean().parse("0")).toBe(true);
  });

  it("appears in no handler, comments aside", () => {
    const offenders = handlerFiles().filter((f) => code(f).includes("coerce.boolean"));
    expect(
      offenders,
      `these handlers coerce a boolean. A query string carries text, and ` +
        `Boolean("false") is true — so "?flag=false" turns the flag ON. Take ` +
        `z.enum(["true", "false"]).transform((v) => v === "true") instead, which ` +
        `also documents the accepted values in the spec.`,
    ).toEqual([]);
  });

  it("leaves z.coerce.number() alone, which is a different question", () => {
    // Numbers coerce correctly from a query string, and every list endpoint's
    // `limit` depends on it. The ban is about booleans, not about coercion.
    expect(z.coerce.number().parse("500")).toBe(500);
    expect(handlerFiles().some((f) => code(f).includes("coerce.number"))).toBe(true);
  });
});
