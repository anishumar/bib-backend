// One fact, written in two places — and until now, only one of them was checked.
//
// `EVENT_VERBS` (src/domain/ledger/model.ts) says of itself that adding a verb
// is "a one-line change here plus a line in docs/EVENT-CONTRACT.md", and the
// contract document is what the other developer's lane, the frontend and any
// future consumer read to know what the ledger can say. Nothing enforced the
// second half, so the two drifted: `proposal.expired` was registered as its own
// verb while the document still described expiry as a flavour of
// `proposal.rejected`, and the row a reader would have gone looking for was
// simply not there.
//
// That drift is quiet in the worst way. A verb missing from the contract is not
// a broken build or a failing request — it is a fact the system records that
// nobody downstream has been told to expect, discovered months later by someone
// reading a timeline that contains a word their code has no branch for.
//
// So the document is parsed and compared, both ways. The same instinct as
// tests/config/seed-parity.test.ts: SQL cannot import TypeScript and Markdown
// cannot either, so the duplication is unavoidable — the DRIFT is not.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_VERBS } from "../../src/domain/ledger/model";

const CONTRACT = "docs/EVENT-CONTRACT.md";

/**
 * The verbs the contract document publishes.
 *
 * It reads the leading cell of every table row that looks like `` | `x.y` | `` —
 * which is the shape every verb row in that file has, and which prose can never
 * accidentally match because prose is not a table row. Anchored to the start of
 * the line so a verb MENTIONED in a description is not mistaken for one
 * DECLARED in the registry table.
 */
function documentedVerbs(): Set<string> {
  const text = readFileSync(CONTRACT, "utf8");
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|/.exec(line);
    if (match?.[1] !== undefined) found.add(match[1]);
  }
  return found;
}

describe("the event contract and the verb registry", () => {
  const documented = documentedVerbs();
  const registered = new Set(Object.keys(EVENT_VERBS));

  it("the document is parseable at all", () => {
    // A guard on the guard. If the table's formatting ever changes, the regex
    // above stops matching and every other assertion in this file passes
    // vacuously by finding nothing on both sides — a test that goes green the
    // moment it stops working is worse than no test.
    expect(documented.size).toBeGreaterThan(40);
  });

  it("documents every verb the system may record", () => {
    const undocumented = [...registered].filter((v) => !documented.has(v)).sort();
    expect(
      undocumented,
      `${String(undocumented.length)} verb(s) are in EVENT_VERBS but missing from ${CONTRACT}: ` +
        `${undocumented.join(", ")}. The contract is what the delivery lane and the frontend ` +
        `read to know what a timeline can contain, so a verb absent from it is a fact this ` +
        `system records that nobody downstream was told to expect. Add a row to the table.`,
    ).toEqual([]);
  });

  it("does not promise a verb the system cannot record", () => {
    const phantom = [...documented].filter((v) => !registered.has(v)).sort();
    expect(
      phantom,
      `${String(phantom.length)} verb(s) are documented in ${CONTRACT} but are not in ` +
        `EVENT_VERBS: ${phantom.join(", ")}. Either the verb was renamed and the document was ` +
        `not, or it was removed. A consumer writing a branch for a verb that can never arrive ` +
        `is dead code they cannot know is dead.`,
    ).toEqual([]);
  });
});
