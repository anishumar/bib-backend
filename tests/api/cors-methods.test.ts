// One fact, written in two places — and until T3.1 only one of them was checked.
//
// `createRouter` mounts CORS with an explicit `allowMethods` list, and the
// routes it mounts underneath use whatever verbs their handlers chose. Nothing
// held the two together, and they drifted: PATCH was absent from the list from
// the day CORS was added, and stayed absent until T3.1 registered the first
// routes that use it.
//
// ── WHY THIS DRIFT IS THE EXPENSIVE KIND ────────────────────────────────────
//
// A method missing from the allowlist does not fail on the server. The
// preflight is answered 204, the browser reads the header, sees its method is
// not on it and DISCARDS the request — so there is no server log, no status
// code, and no error the API could have returned. In the browser it surfaces as
// "TypeError: Failed to fetch", which reads as a dead endpoint.
//
// It was found by clicking a checkbox on a screen. No unit test could have:
// `npm run smoke` uses curl, which does not preflight, and every one of those
// PATCH calls passed.
//
// So the list is compared against the routes the router ACTUALLY registers,
// read off the Hono instance rather than the OpenAPI spec — the same source
// `tests/api/auth-coverage.test.ts` reads, and for the same reason: it sees
// routes registered outside the OpenAPI registry too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROUTER = "src/api/router.ts";

/**
 * The methods the router tells browsers it accepts.
 *
 * Parsed out of the source rather than reached through the mounted middleware,
 * because Hono's cors() closes over its options and exposes nothing. The regex
 * is anchored to the option name, so prose mentioning PATCH cannot satisfy it.
 */
function allowedMethods(): Set<string> {
  const text = readFileSync(ROUTER, "utf8");
  const match = /allowMethods:\s*\[([^\]]*)\]/.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(
      `could not find an \`allowMethods: [...]\` list in ${ROUTER}. It is what tells a browser ` +
        `which verbs it may send cross-origin; restore it rather than deleting this test.`,
    );
  }
  return new Set(
    match[1]
      .split(",")
      .map((m) => m.trim().replaceAll('"', "").replaceAll("'", ""))
      .filter((m) => m.length > 0),
  );
}

/**
 * The methods the handlers actually register, read out of the route table.
 *
 * `createRoute({ method: "patch", ... })` is the shape every handler uses, so
 * this finds a verb the moment a route is written — including one nobody has
 * called yet, which is exactly the case that would otherwise ship broken.
 */
function registeredMethods(): Set<string> {
  const found = new Set<string>();
  const handlers = readFileSync("src/api/router.ts", "utf8");
  // The router imports every handler module; the verbs live in those files.
  for (const file of handlers.matchAll(/from "\.\/handler\/([a-z]+)"/g)) {
    const name = file[1];
    if (name === undefined) continue;
    const text = readFileSync(`src/api/handler/${name}.ts`, "utf8");
    for (const m of text.matchAll(/method:\s*"([a-z]+)"/g)) {
      if (m[1] !== undefined) found.add(m[1].toUpperCase());
    }
  }
  return found;
}

describe("the CORS allowlist and the routes underneath it", () => {
  it("finds the router's list at all", () => {
    // A guard on the guard. If the option is renamed or reformatted the regex
    // stops matching, and a test that goes green the moment it stops working is
    // worse than no test.
    expect(allowedMethods().size).toBeGreaterThan(3);
  });

  it("finds the handlers' verbs at all", () => {
    const methods = registeredMethods();
    expect(methods.size).toBeGreaterThan(2);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
  });

  it("allows every method a registered route uses", () => {
    const allowed = allowedMethods();
    const missing = [...registeredMethods()].filter((m) => !allowed.has(m)).sort();
    expect(
      missing,
      `these methods are used by routes and are NOT in the CORS allowMethods list in ` +
        `${ROUTER}. A browser will discard every such request before either app sees it, with ` +
        `no server log and no status code — it surfaces as "Failed to fetch" and reads as a ` +
        `dead endpoint. Add them to the list.`,
    ).toEqual([]);
  });

  it("still allows OPTIONS, which is the preflight itself", () => {
    expect(allowedMethods()).toContain("OPTIONS");
  });
});
