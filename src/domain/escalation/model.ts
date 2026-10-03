// The escalation domain (T4.5) — who gets told, and what it means when the
// answer is nobody. Pure nouns and pure rules; imports nothing internal and
// nothing beyond the standard library.
//
// ── WHY THIS IS A DOMAIN FILE AND NOT A QUERY ───────────────────────────────
//
// "Escalate to the assignee's manager" looks like a join, and writing it as one
// is how it becomes untestable: the interesting half of this rule is every case
// where it CANNOT be done. Nobody holds the item. The holder has nobody above
// them. The firm has never set a grade. Each of those is a real state of a real
// firm, none of them is an error, and a SQL join answers all three with the same
// empty row.
//
// So the rule is here, it returns WHY when it cannot name somebody, and the
// notice fires either way. T3.1 made the same decision one table over: a work
// item with no resolvable SPOC lands unassigned WITH a sentence, because a queue
// somebody can clear is worth more than a wrong desk.
//
// ── THE THIRD ANSWER IS NOT A PERSON, ON PURPOSE ────────────────────────────
//
// `grade_at_least` resolves to a RANK, never to one of the people holding it.
// Picking one would mean the software chose which partner is responsible and
// told the others nothing — and that escalation is silently dead the week that
// partner is on leave. A rank is stored and the queue filters on the reader's
// own, so everybody senior enough sees the same list.

/** Everybody who might be told, with the two facts these rules compare. The
 *  shape `ReviewerRow` already has, minus what this module has no business
 *  reading — a name is for a screen and a role is for a permission check. */
export interface EscalationStaff {
  readonly userId: string;
  readonly gradeRank: number | null;
  readonly reportsToUserId: string | null;
}

/**
 * Where a climbed rung lands.
 *
 * Three cases and never an exception, because all three happen in the ordinary
 * running of a firm and only one of them is interesting to a reader.
 */
export type EscalationLanding =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "rank"; readonly minGradeRank: number }
  /** Nobody could be named. `note` says which of the three reasons, in a
   *  sentence a person reads on the queue — never prose about a colleague, so
   *  it is safe on the ledger (§3.4). */
  | { readonly kind: "nobody"; readonly note: string };

export interface EscalationSubjectContext {
  /** Who holds the work today, or null. An obligation's holder is the assignee
   *  of the task raised for it; before T3.2's `raise` runs there is none. */
  readonly assigneeUserId: string | null;
  /** Active staff at this firm. Read WHOLE rather than filtered in SQL: the
   *  ungraded and unmanaged cases are exactly the ones this file has to
   *  EXPLAIN, and a query that filtered them out would return the same empty
   *  result for three different situations. */
  readonly staff: readonly EscalationStaff[];
}

/**
 * Where one rung lands on one piece of work.
 *
 * Total: every input has an answer, and the answer is never "throw". A sweep
 * that could fail on a firm's own org chart is a sweep that stops telling every
 * OTHER firm about its deadlines — T3.1's lesson, where one firm with no work
 * states stopped the calendar for every firm after it in the list.
 */
export function landingFor(
  rung: { readonly notify: "assignee" | "manager" | "grade_at_least"; readonly minGradeRank: number | null },
  ctx: EscalationSubjectContext,
): EscalationLanding {
  switch (rung.notify) {
    case "assignee": {
      if (ctx.assigneeUserId === null) {
        return {
          kind: "nobody",
          note: "Nobody holds this yet, so there was no desk to nudge.",
        };
      }
      // A holder who has left is still on the row — T3.1 does not unassign work
      // when a membership is deactivated, deliberately, because silently
      // clearing an assignee loses the record of who had it. But telling a
      // former colleague is telling nobody, so it is said out loud.
      if (!ctx.staff.some((s) => s.userId === ctx.assigneeUserId)) {
        return {
          kind: "nobody",
          note: "The person holding this no longer works here. It needs a new owner.",
        };
      }
      return { kind: "person", userId: ctx.assigneeUserId };
    }

    case "manager": {
      if (ctx.assigneeUserId === null) {
        return {
          kind: "nobody",
          note: "Nobody holds this, so there is no manager to escalate to.",
        };
      }
      const holder = ctx.staff.find((s) => s.userId === ctx.assigneeUserId);
      if (holder === undefined) {
        return {
          kind: "nobody",
          note: "The person holding this no longer works here, so there is no manager above them.",
        };
      }
      if (holder.reportsToUserId === null) {
        return {
          kind: "nobody",
          note: "Nobody is recorded above the person holding this in the firm's reporting line.",
        };
      }
      // The chart can point at somebody who has since left. The row survives
      // because `reports_to_user_id` is not cleared on deactivation, so the
      // check is against the ACTIVE list rather than against null.
      if (!ctx.staff.some((s) => s.userId === holder.reportsToUserId)) {
        return {
          kind: "nobody",
          note: "The manager recorded above the person holding this no longer works here.",
        };
      }
      return { kind: "person", userId: holder.reportsToUserId };
    }

    case "grade_at_least": {
      // A rung the reader could never satisfy is worse than no rung: the notice
      // would sit in a queue nobody is senior enough to open. `readEscalationBody`
      // has already dropped any rung whose rank is unusable, so a null here
      // means the ladder itself is malformed rather than the firm ungraded.
      if (rung.minGradeRank === null) {
        return {
          kind: "nobody",
          note: "This rung escalates to a grade but names no rank, so nobody could be reached.",
        };
      }
      const rank = rung.minGradeRank;
      if (!ctx.staff.some((s) => s.gradeRank !== null && s.gradeRank >= rank)) {
        return {
          kind: "nobody",
          note:
            `Nobody active at this firm holds grade rank ${String(rank)} or above. ` +
            `Set the firm's grades, or lower the step.`,
        };
      }
      return { kind: "rank", minGradeRank: rank };
    }
  }
}

/**
 * Whole days from `from` to `to`, both ISO dates, negative when `to` is earlier.
 *
 * NO `Date` ARITHMETIC ACROSS A TIMEZONE: both are parsed as UTC midnights and
 * subtracted, so the answer counts calendar days rather than 2.77 of them
 * because one side was in IST. The fifth copy of this function in `domain/`,
 * and the duplication is deliberate — a schema-less layer pays it instead of
 * importing sideways between domain modules.
 *
 * It matters more here than almost anywhere: a rung that fires a day early
 * tells a partner about work that is not late yet, and a rung that fires a day
 * late is the exact failure the whole ladder exists to prevent.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * How far past the watched date a notice's work is on `today` (audit
 * 2026-10-03, F11).
 *
 * `daysPast` is snapshotted on the day the rung fired and stays the record of
 * what was true then; the queue showed it as "Days late" and so read 18 for a
 * filing the calendar said was 26 days late. The watched date does not move
 * under a notice, so the count today is the snapshot plus the days since it
 * fired.
 */
export function daysPastOn(notice: { readonly daysPast: number; readonly raisedOn: string }, today: string): number {
  return notice.daysPast + daysBetween(notice.raisedOn, today);
}
