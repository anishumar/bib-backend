// The control figures: whether a read's lines agree with what its file says
// about itself (docs/FIN_BUILD_PLAN.md F2.6, F2.9). Pure.
//
// Checked for EVERY read with lines, whoever read it: the sheet reader, the PDF
// statement reader and the AI reader all hand the sweep a `ReadDraft`, and the
// sweep asks this before it writes anything. A read whose figures disagree
// keeps its lines (a person needs to see them) and goes to that person as
// `control_mismatch` instead of to staging.
//
// ── WHAT IS CHECKED, AND ONLY WHAT THE FILE PRINTED ─────────────────────────
//
//   opening_closing   the opening balance plus every statement line makes the
//                     closing balance, when the file prints both
//   running_balance   each printed running balance is the one before it plus
//                     the line's amount (or, for a statement listed newest
//                     first, the one after it), and the first and last agree
//                     with a printed opening and closing
//   line_count        the number of lines the file says it holds
//   declared_total    a total the file prints for its lines: a statement's
//                     net movement, a payroll sheet's gross pay, a POS file's
//                     takings
//
// A check the file gives nothing for is not run, and is not counted as passed
// either: `checked` says which ran. Nothing here invents a figure.
//
// ── EXACT ARITHMETIC ─────────────────────────────────────────────────────────
//
// Money is a decimal string (CLAUDE.md, "Domain non-negotiables") and only the
// database adds money up — except here, where the answer is needed BEFORE the
// row is written so that it is written once. So the digits are scaled to one
// precision and added as BigInt, `compareAmounts`' method in `domain/money`:
// exact for any value, and no intermediate is ever a JS number.
import type {
  LineDraft,
  ReadControl,
  ReadDraft,
  SignedDecimal,
  StatementLineDraft,
} from "./lines";

// ── Decimal strings ─────────────────────────────────────────────────────────

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Whether a string is a signed decimal this module can add. */
export function isDecimal(v: string): boolean {
  return DECIMAL.test(v);
}

function scaleOf(v: string): number {
  const dot = v.indexOf(".");
  return dot === -1 ? 0 : v.length - dot - 1;
}

function toScaled(v: string, scale: number): bigint {
  const negative = v.startsWith("-");
  const body = negative ? v.slice(1) : v;
  const [whole = "0", fraction = ""] = body.split(".");
  const n = BigInt(whole + fraction.padEnd(scale, "0"));
  return negative ? -n : n;
}

function fromScaled(n: bigint, scale: number): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** The sum of decimal strings, exactly, at the widest scale among them. An
 *  empty list sums to "0". */
export function sumDecimals(values: readonly SignedDecimal[]): SignedDecimal {
  const scale = Math.max(0, ...values.map(scaleOf));
  return fromScaled(
    values.reduce((n, v) => n + toScaled(v, scale), 0n),
    scale,
  );
}

/** `a - b`, exactly. */
export function subtractDecimals(a: SignedDecimal, b: SignedDecimal): SignedDecimal {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale);
}

/** Whether two decimal strings are the same number ("12.5" and "12.50" are). */
export function sameDecimal(a: SignedDecimal, b: SignedDecimal): boolean {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return toScaled(a, scale) === toScaled(b, scale);
}

/** Whether a decimal string is zero, whatever its scale or sign. */
export function isZeroDecimal(v: SignedDecimal): boolean {
  return toScaled(v, scaleOf(v)) === 0n;
}

/** The value with its sign removed. */
export function absDecimal(v: SignedDecimal): SignedDecimal {
  return v.startsWith("-") ? v.slice(1) : v;
}

/** The value with its sign turned over; zero stays unsigned. */
export function negateDecimal(v: SignedDecimal): SignedDecimal {
  if (isZeroDecimal(v)) return absDecimal(v);
  return v.startsWith("-") ? v.slice(1) : `-${v}`;
}

// ── The check ────────────────────────────────────────────────────────────────

export type ControlCheck = "opening_closing" | "running_balance" | "line_count" | "declared_total";

export const CONTROL_CHECKS: readonly ControlCheck[] = [
  "opening_closing",
  "running_balance",
  "line_count",
  "declared_total",
];

/** One figure that did not agree. Machine facts only: the screen writes the
 *  words. */
export interface ControlProblem {
  readonly check: ControlCheck;
  /** The 1-based position of the line where a running balance broke; null
   *  for a check about the whole file. */
  readonly position: number | null;
  /** What the file printed. */
  readonly expected: string | null;
  /** What the lines make of it; null when a line needed for it has no value. */
  readonly actual: string | null;
}

export interface ControlResult {
  readonly ok: boolean;
  /** The checks the file gave something to run, in `CONTROL_CHECKS` order. */
  readonly checked: readonly ControlCheck[];
  readonly problems: readonly ControlProblem[];
}

function statementLines(lines: readonly LineDraft[]): readonly StatementLineDraft[] {
  return lines.filter((l): l is StatementLineDraft => l.kind === "statement");
}

/** The amount a declared total is a total OF, per kind of line: a statement's
 *  movement, an employee's gross pay, a document's total. */
function primaryAmount(line: LineDraft): SignedDecimal | null {
  switch (line.kind) {
    case "statement":
      return line.amount;
    case "payroll":
      return line.grossPay;
    case "document":
      return line.total;
  }
}

interface BalanceStep {
  readonly position: number;
  readonly expected: SignedDecimal;
  readonly actual: SignedDecimal;
}

/**
 * Every comparison of printed running balances, oldest-first: line i's balance
 * is line i-1's plus line i's amount. Newest-first is the mirror: line i's is
 * line i+1's plus line i's amount. A pair where either balance is missing is
 * not a comparison.
 */
function balanceSteps(lines: readonly StatementLineDraft[], newestFirst: boolean): BalanceStep[] {
  const steps: BalanceStep[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const earlier = newestFirst ? lines[i] : lines[i - 1];
    const later = newestFirst ? lines[i - 1] : lines[i];
    const before = earlier?.balance ?? null;
    const after = later?.balance ?? null;
    if (later === undefined || before === null || after === null) continue;
    steps.push({
      position: newestFirst ? i : i + 1,
      expected: after,
      actual: sumDecimals([before, later.amount]),
    });
  }
  return steps;
}

function runningBalance(
  lines: readonly StatementLineDraft[],
  control: ReadControl | null,
): { ran: boolean; problems: ControlProblem[] } {
  if (lines.length === 0 || lines.every((l) => l.balance === null)) return { ran: false, problems: [] };

  // Which way the file is listed: the direction every pair agrees with. A
  // statement that agrees with neither is read oldest-first, so the problems
  // name positions the way a person reads the file.
  const forward = balanceSteps(lines, false);
  const backward = balanceSteps(lines, true);
  const agrees = (steps: BalanceStep[]): boolean => steps.every((s) => sameDecimal(s.expected, s.actual));
  const newestFirst = !agrees(forward) && backward.length > 0 && agrees(backward);
  const steps = newestFirst ? backward : forward;

  const problems: ControlProblem[] = steps
    .filter((s) => !sameDecimal(s.expected, s.actual))
    .map((s) => ({ check: "running_balance", position: s.position, expected: s.expected, actual: s.actual }));
  let ran = steps.length > 0;

  // The ends: the oldest line's balance follows the printed opening, the
  // newest line's balance IS the printed closing.
  const oldestAt = newestFirst ? lines.length - 1 : 0;
  const newestAt = newestFirst ? 0 : lines.length - 1;
  const oldest = lines[oldestAt];
  const newest = lines[newestAt];
  const opening = control?.opening ?? null;
  const closing = control?.closing ?? null;
  if (opening !== null && oldest !== undefined && oldest.balance !== null) {
    ran = true;
    const actual = sumDecimals([opening, oldest.amount]);
    if (!sameDecimal(oldest.balance, actual)) {
      problems.push({ check: "running_balance", position: oldestAt + 1, expected: oldest.balance, actual });
    }
  }
  if (closing !== null && newest !== undefined && newest.balance !== null) {
    ran = true;
    if (!sameDecimal(closing, newest.balance)) {
      problems.push({ check: "running_balance", position: newestAt + 1, expected: closing, actual: newest.balance });
    }
  }
  return { ran, problems };
}

/** Whether a draft's lines agree with the figures its file printed. */
export function checkControl(draft: Pick<ReadDraft, "lines" | "control">): ControlResult {
  const control = draft.control;
  const statements = statementLines(draft.lines);
  const checked: ControlCheck[] = [];
  const problems: ControlProblem[] = [];

  const opening = control?.opening ?? null;
  const closing = control?.closing ?? null;
  if (opening !== null && closing !== null) {
    checked.push("opening_closing");
    const actual = sumDecimals([opening, ...statements.map((l) => l.amount)]);
    if (!sameDecimal(closing, actual)) {
      problems.push({ check: "opening_closing", position: null, expected: closing, actual });
    }
  }

  const running = runningBalance(statements, control);
  if (running.ran) {
    checked.push("running_balance");
    problems.push(...running.problems);
  }

  const lineCount = control?.lineCount ?? null;
  if (lineCount !== null) {
    checked.push("line_count");
    if (lineCount !== draft.lines.length) {
      problems.push({
        check: "line_count",
        position: null,
        expected: String(lineCount),
        actual: String(draft.lines.length),
      });
    }
  }

  const declared = control?.declaredTotal ?? null;
  if (declared !== null) {
    checked.push("declared_total");
    const amounts = draft.lines.map(primaryAmount);
    const actual = amounts.every((a): a is SignedDecimal => a !== null) ? sumDecimals(amounts) : null;
    if (actual === null || !sameDecimal(declared, actual)) {
      problems.push({ check: "declared_total", position: null, expected: declared, actual });
    }
  }

  return { ok: problems.length === 0, checked, problems };
}
