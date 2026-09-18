// The verification domain — who may check somebody else's work, and the one
// rule about it that is never the firm's to change. Pure nouns and pure rules;
// imports nothing internal and nothing beyond the standard library (enforced by
// the arch test).
//
// ── TWO RULES, AND ONLY ONE OF THEM IS CONFIGURABLE ─────────────────────────
//
// MAKER != CHECKER is the product's, and it is not a setting. Whoever produced
// an output can never be the person who approves it — at any firm, under any
// policy, in any process. It lives as a CHECK constraint in migration 0048 for
// `build2.md`'s stated reason ("a rule that lives in a form is a rule that a
// script, an import or an AI agent walks straight past"); `isEligible` below
// applies it too, so a person is TOLD rather than shown a constraint violation,
// and the wall underneath still holds for everything that never reaches this
// code.
//
// WHO ELSE may check is the firm's, and this file is why it is a setting rather
// than a decision we made. The client gave two different answers on two
// different days:
//
//   "Manager or above is fine."          -> a rank threshold
//   "manager means engagement manager."  -> a reporting line
//
// Those are not the same rule and neither is wrong. A threshold lets anyone
// senior enough check anyone's work; a reporting line lets only your own
// manager check yours, and stalls the morning they go on leave. Choosing for
// the firm would be choosing its maker-checker control.
//
// ── AND WHY IT IS PER STEP, NOT PER FIRM ────────────────────────────────────
//
// SQC 1 — ICAI's own quality-control standard, which is what a CA firm is
// actually audited against — requires an engagement quality control reviewer to
// be BOTH "suitably qualified" (a rank test) AND "independent of the engagement
// team". A reporting line is the opposite of independent: your manager is on
// your engagement. So an ordinary manager review and an EQCR sign-off are
// governed by different rules inside the SAME process, and a single firm-wide
// switch could not express a firm that does both — which every audit practice
// does.
//
// A firm therefore publishes as many `verification_policy` entries as it has
// kinds of review, and a workflow step names the one that governs it.

/**
 * How a firm decides who may check a step.
 *
 * A closed set, like `StepExecutor` and `StepStatus`, and for the same reason:
 * these are the shapes the engine can actually evaluate, and each one is a case
 * in `isEligible` below. A firm choosing among three named rules is
 * configuration; a firm writing an expression is a vocabulary nobody chose, no
 * partner can read and no test can cover — the same little language T2.7
 * refused for step conditions.
 */
export type VerificationRule = "rank_threshold" | "reporting_line" | "reporting_line_or_rank";

export const VERIFICATION_RULES: readonly VerificationRule[] = [
  "rank_threshold",
  "reporting_line",
  "reporting_line_or_rank",
];

export function isVerificationRule(v: string): v is VerificationRule {
  return (VERIFICATION_RULES as readonly string[]).includes(v);
}

/**
 * What each rule means, in a sentence the person choosing it can act on.
 *
 * Here rather than on the screen, for `PERMISSION_DESCRIPTIONS`' reason: the
 * meaning of a rule is a domain fact, and a description that lives in the UI
 * drifts from what the code actually checks. On this particular subject that
 * drift decides who may sign off a statutory filing.
 */
export const VERIFICATION_RULE_DESCRIPTIONS: Readonly<Record<VerificationRule, string>> = {
  rank_threshold:
    "Anybody at or above a grade you choose may check the work, for example " +
    '"Manager or above". Nobody waits on one particular person.',
  reporting_line:
    "Only the person the maker reports to may check the work. This is the strictest rule: " +
    "if that manager is on leave, nobody else can check it.",
  reporting_line_or_rank:
    "The maker's own manager, OR anybody at or above the grade you choose. The reporting " +
    "line is who normally checks it; the grade is who can when they are away.",
};

/**
 * A firm's published answer to "who may check this kind of work".
 *
 * `minGradeRank` is the rank from `tenancy.staff_grade`, resolved at PUBLISH
 * time and stored as the number rather than the code. That is deliberate and it
 * is the opposite of what `service` bodies do with an axis code, for a reason
 * that only applies here: a published body is FROZEN, and the whole point of
 * pinning the policy version on an approval is that "who was allowed to approve
 * this in March" survives the firm reorganising its ladder in April. A stored
 * code would be re-resolved against today's ladder every time it is read, and
 * would quietly answer the April question with March's row.
 *
 * `minGradeCode` rides along for display only — so a screen can say "Manager"
 * rather than "rank 7" — and nothing compares it.
 */
export interface VerificationPolicy {
  readonly label: string;
  readonly rule: VerificationRule;
  /** Null exactly when `rule` is `reporting_line`, which tests no rank at all. */
  readonly minGradeRank: number | null;
  /** Display only. Null with `minGradeRank`, and never used in a comparison. */
  readonly minGradeCode: string | null;
}

/** Whether a rule consults the grade ladder. `reporting_line` alone does not,
 *  which is why its two grade fields are null rather than ignored — a body
 *  carrying a threshold nothing reads is a knob that looks live. */
export function rulePer(rule: VerificationRule): {
  readonly usesRank: boolean;
  readonly usesReportingLine: boolean;
} {
  switch (rule) {
    case "rank_threshold":
      return { usesRank: true, usesReportingLine: false };
    case "reporting_line":
      return { usesRank: false, usesReportingLine: true };
    case "reporting_line_or_rank":
      return { usesRank: true, usesReportingLine: true };
  }
}

/**
 * The little this domain needs to know about a person who might check a step.
 *
 * Structural, so a roster read model from `usecase/tenancy` satisfies it
 * without either side importing the other — the same arrangement
 * `orchestrator.ReadyInput` has with `config.WorkflowStep`.
 */
export interface CheckerCandidate {
  readonly userId: string;
  readonly displayName: string;
  /** Null for somebody the firm has not placed on its ladder. Six real
   *  designations at the client firm are unplaced, so this is the ordinary case
   *  rather than the exceptional one. */
  readonly gradeRank: number | null;
  readonly gradeName: string | null;
  /** Whether they hold `work:write`. Checking somebody's work is writing to the
   *  record of who did it, so it is the same permission — resolved by the
   *  caller, because permissions are `usecase/authz`'s and this is the domain. */
  readonly canWrite: boolean;
}

/**
 * The person whose work is being checked.
 *
 * Their own reporting line travels WITH them rather than being looked up per
 * candidate, and that is the whole reason this is an interface rather than a
 * bare `string`. The reporting-line rule asks "is this candidate the person the
 * MAKER reports to" — a fact about the maker. An earlier draft of this file
 * compared the candidate against the maker instead, which is not the reporting
 * rule at all; it is the maker-checker rule inverted, and it would have made
 * exactly one person eligible: the one person who is always forbidden.
 */
export interface Maker {
  readonly userId: string;
  /** Null for a partner, and null for everybody at a firm that has not filled
   *  its reporting line in — which is every firm the day 0048 applies. Then a
   *  `reporting_line` policy matches nobody, and the screen says so. */
  readonly reportsToUserId: string | null;
}

/** Why one particular person may not check one particular step. A closed set,
 *  because every one of them is a sentence a screen has to say out loud — "you
 *  cannot check this" with no reason is how a person concludes the button is
 *  broken. */
export type IneligibilityReason =
  | "IS_THE_MAKER"
  | "NO_WORK_PERMISSION"
  | "BELOW_GRADE"
  | "UNGRADED"
  | "NOT_THE_MAKERS_MANAGER";

export interface Eligibility {
  readonly eligible: boolean;
  readonly reason: IneligibilityReason | null;
}

const ELIGIBLE: Eligibility = { eligible: true, reason: null };

function no(reason: IneligibilityReason): Eligibility {
  return { eligible: false, reason };
}

/**
 * May this person check work made by that person?
 *
 * The whole rule, in one function, and the order of the tests is load-bearing:
 *
 * 1. MAKER != CHECKER first, always, and regardless of policy. It is the one
 *    rule no firm may configure away, so it must not be reachable only through
 *    a branch some policy takes. A step with NO policy still gets it.
 *
 * 2. `work:write` next, because checking a step writes to the record of who did
 *    the work. A read-only Management membership carrying a Senior Manager
 *    grade would otherwise pass a rank threshold — which is the client question
 *    the demo raised as Q41 and never got an answer to. The firm's stated rule
 *    names a GRADE and says nothing about role, so this does not invent a role
 *    floor; it applies the permission that already gates every other write to a
 *    step. Recorded in the board and in CLAUDE.md so it is visible rather than
 *    discovered.
 *
 * 3. Then the firm's rule.
 *
 * `maker` is null for a step an agent COMMITTED unattended: no person made it,
 * so there is no self to be. Anybody otherwise eligible may check it.
 *
 * `policy` is null for a step whose firm has published no rule about who checks
 * it. Then the answer is anybody with `work:write` who is not the maker — which
 * is strictly more than the nobody who could check anything before T2.9, and is
 * the honest reading of "the firm has not said".
 */
export function isEligible(
  candidate: CheckerCandidate,
  maker: Maker | null,
  policy: VerificationPolicy | null,
): Eligibility {
  if (maker !== null && candidate.userId === maker.userId) return no("IS_THE_MAKER");
  if (!candidate.canWrite) return no("NO_WORK_PERMISSION");
  if (policy === null) return ELIGIBLE;

  const { usesRank, usesReportingLine } = rulePer(policy.rule);

  // The reporting-line half: is this candidate the person the MAKER reports to?
  // Deliberately not a walk up the chain — the firm said "manager means
  // engagement manager", one person, and letting a manager's manager check it
  // too would be us widening the firm's own control because it seemed more
  // convenient. A firm that wants the wider rule picks
  // `reporting_line_or_rank`, which widens it in a direction the firm chose and
  // can see on the screen.
  if (usesReportingLine && maker !== null && maker.reportsToUserId === candidate.userId) {
    return ELIGIBLE;
  }

  if (!usesRank) return no("NOT_THE_MAKERS_MANAGER");
  if (candidate.gradeRank === null) return no("UNGRADED");
  // `minGradeRank` is non-null whenever the rule uses rank — the body validator
  // refuses a `rank_threshold` policy without one — but a body read back from a
  // version published before a validator change could still lack it, and a
  // missing threshold must not read as "everybody qualifies".
  if (policy.minGradeRank === null) return no("BELOW_GRADE");
  return candidate.gradeRank >= policy.minGradeRank ? ELIGIBLE : no("BELOW_GRADE");
}

/** What each refusal SAYS, to the person refused. Prose, in the domain, for
 *  `VERIFICATION_RULE_DESCRIPTIONS`' reason. */
export const INELIGIBILITY_MESSAGES: Readonly<Record<IneligibilityReason, string>> = {
  IS_THE_MAKER:
    "You did this work, so you cannot be the one who checks it. Somebody else has to. " +
    "This rule can never be switched off.",
  NO_WORK_PERMISSION:
    "Checking a step writes to the record of who did the work, so it needs the same " +
    "permission as doing it.",
  BELOW_GRADE: "This step is checked at a grade above yours.",
  UNGRADED:
    "This step is checked at a particular grade, and the firm has not placed you on its " +
    "ladder yet. An administrator can set your grade from the roster.",
  NOT_THE_MAKERS_MANAGER:
    "This step is checked by the maker's own manager, and that is not you.",
};

/** A check waiting on somebody, or one that has been decided. Mirrors
 *  `delivery.step_approval`. */
export type ApprovalDecision = "pending" | "approved" | "rejected";

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["pending", "approved", "rejected"];

export function isApprovalDecision(v: string): v is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(v);
}

export interface StepApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly jobStepId: string;
  /** Derived by the database from `job_step.performed_by` and frozen there —
   *  never written by this application. See migration 0048. */
  readonly submittedBy: string | null;
  readonly submittedAt: string;
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
  readonly decision: ApprovalDecision;
  readonly notes: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

/**
 * Would making `manager` the manager of `user` close a loop?
 *
 * Returns the loop as the PATH that closes it, or null. A path rather than a
 * boolean for `findStepCycle`'s reason: "Priya reports to Anand reports to
 * Priya" is fixable and "invalid" is not, and every refusal in this codebase
 * names the value.
 *
 * It has to be here rather than in a CHECK because a constraint sees one row. A
 * one-person loop is the only one a single column can express, and 0048 does
 * refuse that; `a -> b -> a` needs the walk, and it is not a hypothetical — it
 * is what two people picking each other out of a dropdown produces.
 *
 * A loop is SILENT if it lands: under a `reporting_line` policy nobody in it
 * has a manager who could check their work, so the queue simply never offers
 * anybody, and the firm reads that as the feature not working.
 *
 * `lines` is the firm's existing `user -> manager` map, WITHOUT the proposed
 * edge; the edge under consideration is the two arguments. That keeps this
 * function pure and lets the caller ask before writing.
 */
export function walkReportingLine(
  lines: ReadonlyMap<string, string>,
  user: string,
  manager: string,
): readonly string[] | null {
  const path = [user, manager];
  const seen = new Set([user]);
  let at = manager;
  // Bounded by the map's size: every hop consumes a distinct key, so a chain
  // longer than that has already revisited one and returned.
  for (let hop = 0; hop <= lines.size; hop += 1) {
    if (seen.has(at)) return path;
    seen.add(at);
    const next = lines.get(at);
    if (next === undefined) return null;
    path.push(next);
    at = next;
  }
  return path;
}
