import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY REFUSAL THIS PRODUCT SHOWS A PERSON STARTS WITH A CAPITAL LETTER.
 *
 * ## Why this is a test and not a rule somebody remembers
 *
 * The API's `message` is rendered RAW by every screen in the frontend, and
 * deliberately so — `bib-frontend/CLAUDE.md` forbids improving on it, because
 * several messages are vague on purpose and a friendlier local rewrite would
 * leak what the backend refused to say. So a message that opens in lower case
 * appears mid-sentence in a notice: *"an engagement letter with no clauses
 * commits the firm to nothing"*, in a red box, under a heading.
 *
 * Capitalising in the browser was considered and refused: a message that
 * legitimately opens on an interpolated CODE or a proper noun — `"FC-GPR" is
 * not…` — would be mangled by a blanket `toUpperCase` on the first character,
 * and the browser cannot tell the two apart. The source can.
 *
 * There were **251** of these when this was written, across 26 error families.
 * A list somebody checks by hand is a list that is wrong within a month, so the
 * rule is asserted over the SOURCE, which is where the sentences are.
 *
 * ## What is allowed to start lower case, and nothing else is
 *
 * A message whose first character is an interpolation — `${…}` — because that
 * is a value: a code, a reference number, an email address, a company's own
 * name. `"fc-gpr" is not a rule at this firm` is correct and
 * `"Fc-gpr" is not…` is a different code.
 *
 * ## Reading the source rather than constructing the errors
 *
 * Every one of these classes takes constructor arguments, several of them
 * arrays and objects it then maps over, so building 321 of them with plausible
 * values would be a fixture larger than the thing it checks — and one that goes
 * stale exactly when a constructor changes. The architecture test already
 * establishes the shape: a rule about the code, checked against the code.
 */
const DOMAIN = join(process.cwd(), "src", "domain");

/** `super("CODE", <message>` — the two-argument shape every error in this
 *  product uses. The first argument is the code, the second is what a person
 *  reads. */
const CONSTRUCTOR = /super\(\s*("(?:[A-Z0-9_]+)"|[A-Za-z_.]+)\s*,\s*/gs;

interface Refusal {
  readonly family: string;
  readonly code: string;
  readonly opening: string;
}

function refusalsIn(family: string, source: string): Refusal[] {
  const out: Refusal[] = [];
  for (const m of source.matchAll(CONSTRUCTOR)) {
    const at = m.index + m[0].length;
    const quote = source[at];
    // Not a literal — a variable or a call. Those are a handful of pass-through
    // wrappers and carry somebody else's already-checked sentence.
    if (quote !== "`" && quote !== '"' && quote !== "'") continue;
    out.push({
      family,
      code: m[1] ?? "?",
      opening: source.slice(at + 1, at + 60),
    });
  }
  return out;
}

function everyRefusal(): Refusal[] {
  const out: Refusal[] = [];
  for (const entry of readdirSync(DOMAIN, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(DOMAIN, entry.name, "errors.ts");
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // a domain module with no errors of its own
    }
    out.push(...refusalsIn(entry.name, source));
  }
  return out;
}

describe("the sentences this product refuses people with", () => {
  it("finds them — so a broken matcher fails loudly rather than passing on nothing", () => {
    // The failure mode this guards against is the one that matters: a regex
    // that stops matching turns the assertion below into a test over an empty
    // list, which passes forever and checks nothing.
    const all = everyRefusal();
    expect(all.length).toBeGreaterThan(250);
    expect(new Set(all.map((r) => r.family)).size).toBeGreaterThan(20);
  });

  it("starts every one with a capital letter, or with a value", () => {
    const bad = everyRefusal().filter((r) => {
      const first = r.opening[0] ?? "";
      // An interpolation is a VALUE — a code, a reference, an email, a
      // company's own name — and its case is not ours to change.
      if (first === "$") return false;
      return first.toLowerCase() === first && first.toUpperCase() !== first;
    });
    expect(
      bad.map((r) => `${r.family} ${r.code}: ${r.opening}`),
      "the frontend renders `message` raw, so a lower-case opening lands mid-sentence in a notice",
    ).toEqual([]);
  });
});
