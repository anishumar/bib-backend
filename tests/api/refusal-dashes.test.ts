import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * NO EM DASH IN A SENTENCE THIS PRODUCT REFUSES SOMEBODY WITH (audit
 * 2026-10-03, B55).
 *
 * The screens render the API's `message` raw (see refusal-sentences.test.ts),
 * and a firm's staff read them as the product talking. The plain-words rule for
 * copy a person reads is full stops, commas and colons; about 230 refusals said
 * " — " instead. They were rewritten once, and this keeps them that way.
 *
 * WHAT IS CHECKED: every string a domain error passes to `super` (every
 * `src/domain/<area>/errors.ts`), and every problem a configuration validator
 * returns (`validate*` in `src/domain/config/model.ts`, which the API answers
 * with). Read from the source, like the capital-letter rule beside it.
 *
 * WHAT IS NOT: comments, OpenAPI descriptions (developers read those), and the
 * ledger's own refusals, which are the product's bug rather than the caller's
 * and answer "internal error" (see `api/domainerr.ts`).
 */
const DOMAIN = join(process.cwd(), "src", "domain");
const DASH = "—";

interface Literal {
  readonly where: string;
  readonly text: string;
}

function literalsIn(file: string, keep: (node: ts.Node) => boolean): Literal[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Literal[] = [];
  const visit = (node: ts.Node): void => {
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text
          : null;
    if (text !== null && keep(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ where: `${file.slice(process.cwd().length + 1)}:${String(line)}`, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Inside a function whose name starts with `validate`. */
function inValidator(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name?.text.startsWith("validate") === true) return true;
  }
  return false;
}

function refusalLiterals(): Literal[] {
  const out: Literal[] = [];
  for (const entry of readdirSync(DOMAIN, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "ledger") continue;
    const file = join(DOMAIN, entry.name, "errors.ts");
    try {
      readFileSync(file);
    } catch {
      continue; // a domain module with no errors of its own
    }
    out.push(...literalsIn(file, () => true));
  }
  out.push(...literalsIn(join(DOMAIN, "config", "model.ts"), inValidator));
  return out;
}

describe("the sentences this product refuses people with, B55", () => {
  it("finds them, so a broken reader fails loudly rather than passing on nothing", () => {
    expect(refusalLiterals().length).toBeGreaterThan(400);
  });

  it("carry no em dash: a full stop, a comma or a colon says it plainly", () => {
    const bad = refusalLiterals()
      .filter((l) => l.text.includes(DASH))
      .map((l) => `${l.where}: ${l.text.slice(0, 80)}`);
    expect(bad).toEqual([]);
  });
});
