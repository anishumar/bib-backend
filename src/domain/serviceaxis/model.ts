// The service-axis domain — the firm's own Depts and delivery teams, and which
// of the two (if either) decides how a client's work is cut up. Pure nouns and
// pure rules; imports nothing internal and nothing beyond the standard library
// (enforced by the arch test).
//
// ── THE TWO AXES ARE NOT A HIERARCHY, AND THAT IS THE WHOLE POINT ──────────
//
// A **Dept** — FRC, TRC, RAA at the firm this was designed against — answers
// "whose revenue is this". The firm's dashboard splits income by it, and a
// client gets a SPOC per Dept: *"each client will defacto have two SPOC, one
// from TRC and one from FRC"*.
//
// A **delivery team** — FINCOMPLIANCE, VCFO CONSOLE, PAYROLL — answers "who
// actually does the work". It is the skill pool.
//
// They cross. FINCOMPLIANCE delivers under BOTH FRC and TRC, so nesting team
// under Dept would make that service unfileable and force a duplicate catalogue
// row per Dept — a second row somebody has to keep in step, and a revenue figure
// counted twice. `ServiceBody` has carried both as independent fields since
// G2.1 for exactly this reason; this module gives them rows.
//
// ── AND NEITHER IS UNIVERSAL ────────────────────────────────────────────────
//
// This product is sold to many firms and most of them do not have both layers.
// A fifteen-person practice has neither — everyone does everything. A firm with
// one P&L has delivery teams and no revenue split. A multi-partner firm has the
// opposite: each partner's book is a Dept, and the work comes from one pool.
//
// So `WorkSplitAxis` includes `none`, and `none` is the DEFAULT. A firm says how
// it is organised; the product does not assume it on the firm's behalf.

/** Which of the firm's two lists a row belongs to.
 *
 *  The ENGINE's vocabulary, not the firm's — the same at every firm, which is
 *  why it is a closed set here and a CHECK in the schema, exactly as
 *  `config.entry.kind` and `delivery.job.source_kind` are. What the firm owns is
 *  the ROWS: their codes, names, order, and which are still in use. */
export type ServiceAxisKind = "dept" | "team";

export const SERVICE_AXIS_KINDS: readonly ServiceAxisKind[] = ["dept", "team"];

export function isServiceAxisKind(v: string): v is ServiceAxisKind {
  return (SERVICE_AXIS_KINDS as readonly string[]).includes(v);
}

/** One entry on one of the firm's two lists. */
export interface ServiceAxis {
  readonly id: string;
  readonly tenantId: string;
  readonly axis: ServiceAxisKind;
  /**
   * The value a service body's `module` / `group` holds — the JOIN, and the one
   * field that never moves.
   *
   * It is stored in a service body that may already be PUBLISHED and therefore
   * frozen, so renaming this would orphan every version that named it. The
   * firm's readable label is `name`, which is freely editable for that reason.
   * Same argument `config.entry.key` makes about being the pin target.
   */
  readonly code: string;
  readonly name: string;
  /** The order the firm reads its own list in. Not unique, not contiguous. */
  readonly sortOrder: number;
  /** Whether the firm still files new work under this. NEVER a delete — a Dept
   *  that existed in 2026 is part of why a service was filed where it was
   *  filed, so it stays readable forever. */
  readonly isActive: boolean;
}

/**
 * How a firm cuts one client's work into separate jobs.
 *
 * `none` does not mean "not configured yet". It is a real answer, and the one
 * most firms will keep. It reproduces T2.6's behaviour exactly: one
 * engagement, one job, everything in it. `dept` and `team` are the two ways a
 * firm that IS structured says so.
 */
export type WorkSplitAxis = "none" | "dept" | "team";

export const WORK_SPLIT_AXES: readonly WorkSplitAxis[] = ["none", "dept", "team"];

export function isWorkSplitAxis(v: string): v is WorkSplitAxis {
  return (WORK_SPLIT_AXES as readonly string[]).includes(v);
}

// ── Pure rules ────────────────────────────────────────────────────────────

/**
 * The canonical form a code must be written in.
 *
 * Deliberately IDENTICAL to `isReportingAxis` in the config domain, because
 * these codes and the ones already inside published service bodies have to be
 * the same strings — this table is the list those bodies are checked against,
 * and two different notions of "valid" would let a row exist that no service
 * could ever name.
 *
 * Upper case with single separators. Spaces are allowed INSIDE because the
 * firm's own delivery teams have them — "VCFO CONSOLE" is a real one.
 *
 * The duplication is deliberate and the arch wall requires it: `domain/config`
 * and `domain/serviceaxis` are siblings and neither may import the other. The
 * agreement between them is held by a test rather than by a shared import.
 */
const CODE_PATTERN = /^[A-Z0-9]+(?:[ _-][A-Z0-9]+)*$/;

export const MAX_AXIS_CODE_LENGTH = 48;
export const MAX_AXIS_NAME_LENGTH = 120;

export function isValidAxisCode(code: string): boolean {
  return code.length <= MAX_AXIS_CODE_LENGTH && CODE_PATTERN.test(code);
}

/**
 * Bring a typed code to canonical form — trim, collapse runs of whitespace,
 * upper case.
 *
 * Normalising at the WRITE rather than the read, for the reason `module` already
 * states: the whole job of this value is to be grouped and compared, a body is
 * stored verbatim once published, and a read-time fix would come too late for
 * the `GROUP BY body->>'module'` that runs in SQL.
 *
 * Note what this does NOT do: `FIN COMPLIANCE` and `FINCOMPLIANCE` stay two
 * different codes. No normaliser can decide that a space belongs there, which is
 * exactly why the firm needs a LIST and not a text box — that pair is the bug
 * this whole task exists to make unrepresentable.
 */
export function normalizeAxisCode(code: string): string {
  return code.trim().replace(/\s+/g, " ").toUpperCase();
}

/** A name is anything a person would read, but not nothing and not a paragraph.
 *  The cap is a fat-finger guard, not a policy. */
export function isValidAxisName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_AXIS_NAME_LENGTH;
}

/**
 * The list in the order the firm reads it.
 *
 * `sortOrder` ascending, then name, so a list where two rows share an order
 * still has ONE stable order rather than whatever the database returned. A
 * picker that reorders itself between two loads looks broken even when it is
 * not — the argument `ladderOrder` makes for the grade ladder.
 */
export function axisOrder(rows: readonly ServiceAxis[]): readonly ServiceAxis[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** What a picker offers. Deactivated rows stay readable everywhere they are
 *  already named; they are just not offered for anything new. */
export function assignableAxes(rows: readonly ServiceAxis[]): readonly ServiceAxis[] {
  return rows.filter((r) => r.isActive);
}

/**
 * Group things by the axis code a firm splits work on — the rule T2.7 walks.
 *
 * Returns one bucket per distinct code, in first-seen order, so a caller that
 * fed the lines in the order the client bought them gets its jobs back in that
 * order rather than in a hash order that changes between runs.
 *
 * Three cases, and all three are ordinary:
 *
 *   `none` — NO MERGING. One bucket per item, each keyed `null`, so a caller
 *   that does not special-case it gets exactly what it had before grouping
 *   existed: one job per engagement.
 *
 *   That is a CORRECTION, and wiring T2.7's caller is what found it. This
 *   branch used to return one bucket holding everything, on the stated grounds
 *   that it "reproduces T2.6's behaviour" — and it does not. T2.6 gives one job
 *   per ENGAGEMENT, `crm.engagement` carries `UNIQUE
 *   (engagement_letter_line_id)`, so a three-line letter is already three jobs.
 *   One bucket would have merged all three, which is a behaviour change for
 *   every firm on the default setting — the exact thing G2.4 promised would not
 *   happen until a firm chooses. `none` is a real answer meaning "we do not cut
 *   our work up", and the honest reading of that is that nothing merges.
 *
 *   The pure function was green on eleven tests while saying the wrong thing,
 *   because nothing consumed it yet. Third time on this project that the
 *   consumer, not the unit test, found the bug.
 *
 *   A line whose service names no code on the chosen axis joins the `null`
 *   bucket alongside anything else unfiled. It is not dropped. A service the
 *   firm has not filed is a real state — the catalogue screen says "filed under
 *   no Dept" rather than hiding the row — and silently discarding its work would
 *   be the worst failure available here.
 *
 *   Every line naming the same code is one bucket, which is the answer to the
 *   question the firm actually asked: three services from one delivery team are
 *   one checklist, three from three teams are three.
 */
export function groupByAxis<T>(
  items: readonly T[],
  axis: WorkSplitAxis,
  codeOf: (item: T) => string | null,
): readonly { readonly code: string | null; readonly items: readonly T[] }[] {
  if (axis === "none") {
    return items.map((item) => ({ code: null, items: [item] }));
  }

  const buckets = new Map<string | null, T[]>();
  for (const item of items) {
    const code = codeOf(item);
    const key = code === null || code.trim() === "" ? null : code;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets].map(([code, items]) => ({ code, items }));
}
