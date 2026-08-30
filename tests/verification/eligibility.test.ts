// The rule that decides who may check somebody else's work (T2.9) — pure, so
// every case here is a table row rather than a fixture.
//
// What these tests are NOT: proof of the maker-checker CONSTRAINT. That is a
// CHECK in migration 0048 and is proven as the OWNER role in
// `maker-checker.integration.test.ts`, going round the application entirely.
// These prove what a PERSON is told, which is the other half — a rule enforced
// only in the database reaches a browser as "internal error".
import { describe, expect, it } from "vitest";
import type { CheckerCandidate, Maker, VerificationPolicy } from "../../src/domain/verification/model";
import {
  INELIGIBILITY_MESSAGES,
  VERIFICATION_RULES,
  VERIFICATION_RULE_DESCRIPTIONS,
  isEligible,
  rulePer,
  walkReportingLine,
} from "../../src/domain/verification/model";

const PRIYA = "priya";
const ANAND = "anand";
const SIDHARTH = "sidharth";

function candidate(over: Partial<CheckerCandidate> & { userId: string }): CheckerCandidate {
  return {
    displayName: over.userId,
    gradeRank: null,
    gradeName: null,
    canWrite: true,
    ...over,
  };
}

function maker(userId: string, reportsToUserId: string | null = null): Maker {
  return { userId, reportsToUserId };
}

const MANAGER_OR_ABOVE: VerificationPolicy = {
  label: "Manager review",
  rule: "rank_threshold",
  minGradeRank: 7,
  minGradeCode: "manager",
};

const OWN_MANAGER: VerificationPolicy = {
  label: "Engagement manager review",
  rule: "reporting_line",
  minGradeRank: null,
  minGradeCode: null,
};

const EITHER: VerificationPolicy = {
  label: "Manager review, or anybody senior",
  rule: "reporting_line_or_rank",
  minGradeRank: 7,
  minGradeCode: "manager",
};

describe("maker != checker — the rule no firm may configure away", () => {
  it("refuses the maker under every rule the product offers", () => {
    // Iterating the closed set rather than listing three cases: a fourth rule
    // added next year gets this test for free, and it is the one rule that must
    // hold under all of them.
    for (const rule of VERIFICATION_RULES) {
      const policy: VerificationPolicy = {
        label: rule,
        rule,
        minGradeRank: rule === "reporting_line" ? null : 1,
        minGradeCode: rule === "reporting_line" ? null : "analyst",
      };
      const verdict = isEligible(
        candidate({ userId: PRIYA, gradeRank: 10 }),
        maker(PRIYA, ANAND),
        policy,
      );
      expect(verdict, `rule ${rule} let the maker check their own work`).toEqual({
        eligible: false,
        reason: "IS_THE_MAKER",
      });
    }
  });

  it("refuses the maker even when the firm has published no policy at all", () => {
    // The path that matters most: a firm that has written no rule still gets
    // maker != checker, because it is tested BEFORE the policy branch. If it
    // were inside one, "no policy" would mean "no rule", which is the opposite
    // of what it means.
    expect(isEligible(candidate({ userId: PRIYA }), maker(PRIYA), null)).toEqual({
      eligible: false,
      reason: "IS_THE_MAKER",
    });
  });

  it("has nothing to refuse when a machine committed the work unattended", () => {
    // `performed_by` is null there — no person made it — so there is no self to
    // be. Anybody otherwise eligible may check it. The guardrail that decided
    // whether the machine could act at all is T2.8's and ran before this.
    expect(isEligible(candidate({ userId: PRIYA, gradeRank: 7 }), null, MANAGER_OR_ABOVE)).toEqual({
      eligible: true,
      reason: null,
    });
  });
});

describe("rank_threshold — the firm's own answer", () => {
  it("lets anybody at or above the rung check anybody's work", () => {
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: 7 }), maker(PRIYA), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: true, reason: null });
    expect(
      isEligible(candidate({ userId: SIDHARTH, gradeRank: 10 }), maker(PRIYA), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: true, reason: null });
  });

  it("refuses somebody below the rung, and says which problem it is", () => {
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: 3 }), maker(PRIYA), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: false, reason: "BELOW_GRADE" });
  });

  it("tells an UNGRADED person apart from one who is merely junior", () => {
    // Not the same problem and not the same fix. Six real designations at the
    // client firm are unranked — Article, Intern, Trainee, Head, PRO, CEO — so
    // this is the ordinary case, and "nobody has put you on the ladder" is
    // something an administrator resolves in a minute. Collapsing it into
    // BELOW_GRADE would send them looking for a promotion instead.
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: null }), maker(PRIYA), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: false, reason: "UNGRADED" });
  });

  it("does not read a reporting line", () => {
    // Being the maker's manager buys nothing under a pure rank rule. A firm that
    // chose the threshold chose it over the reporting line, and quietly honouring
    // both would be us widening its control.
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: 3 }), maker(PRIYA, ANAND), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: false, reason: "BELOW_GRADE" });
  });
});

describe("reporting_line — the tighter reading the firm also gave", () => {
  it("lets the maker's own manager check, whatever their grade", () => {
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: null }), maker(PRIYA, ANAND), OWN_MANAGER),
    ).toEqual({ eligible: true, reason: null });
  });

  it("refuses a Partner who is not the maker's manager", () => {
    // The whole difference from a threshold, stated as a test: seniority is not
    // the rule here, and the most senior person at the firm is refused.
    expect(
      isEligible(candidate({ userId: SIDHARTH, gradeRank: 10 }), maker(PRIYA, ANAND), OWN_MANAGER),
    ).toEqual({ eligible: false, reason: "NOT_THE_MAKERS_MANAGER" });
  });

  it("refuses everybody when the maker reports to nobody", () => {
    // Every firm on the day migration 0048 applies, because nothing has filled
    // the column in. The queue shows the work and nobody is eligible, which is
    // the honest state — and the screen has to say so rather than looking broken.
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: 10 }), maker(PRIYA, null), OWN_MANAGER),
    ).toEqual({ eligible: false, reason: "NOT_THE_MAKERS_MANAGER" });
  });

  it("does NOT walk up the chain to the manager's manager", () => {
    // The firm said "manager means engagement manager" — one person. Widening it
    // because a leave day is inconvenient would be us editing the firm's
    // maker-checker control. `reporting_line_or_rank` is how a firm widens it
    // deliberately.
    const lines = new Map([
      [PRIYA, ANAND],
      [ANAND, SIDHARTH],
    ]);
    expect(lines.get(PRIYA)).toBe(ANAND);
    expect(
      isEligible(candidate({ userId: SIDHARTH, gradeRank: 10 }), maker(PRIYA, ANAND), OWN_MANAGER),
    ).toEqual({ eligible: false, reason: "NOT_THE_MAKERS_MANAGER" });
  });
});

describe("reporting_line_or_rank — the one that survives a leave day", () => {
  it("lets the maker's manager check even when they are below the rung", () => {
    expect(
      isEligible(candidate({ userId: ANAND, gradeRank: 3 }), maker(PRIYA, ANAND), EITHER),
    ).toEqual({ eligible: true, reason: null });
  });

  it("lets somebody senior enough check when the manager is away", () => {
    // The case the demo raised against `reporting_line` and left open: a rule
    // that stalls the morning one person goes on leave. Here it does not.
    expect(
      isEligible(candidate({ userId: SIDHARTH, gradeRank: 10 }), maker(PRIYA, ANAND), EITHER),
    ).toEqual({ eligible: true, reason: null });
  });

  it("still refuses somebody who is neither", () => {
    expect(
      isEligible(candidate({ userId: SIDHARTH, gradeRank: 2 }), maker(PRIYA, ANAND), EITHER),
    ).toEqual({ eligible: false, reason: "BELOW_GRADE" });
  });
});

describe("the permission floor, which is Q41 and is still open with the client", () => {
  it("refuses a read-only membership holding a senior grade", () => {
    // The demo's Q41, never answered: the firm's rule names a GRADE and says
    // nothing about role, so a Management membership that only reads data but
    // carries a Senior Manager designation would pass a rank threshold and be
    // able to sign off a statutory filing.
    //
    // This does not invent a role floor. It applies `work:write` — the same
    // permission already required to say a step is DONE — on the ground that
    // approving somebody's filing is the same kind of act. The firm can still
    // widen it by granting that role `work:write`, which is a decision it makes
    // on the roles screen and can see.
    expect(
      isEligible(
        candidate({ userId: ANAND, gradeRank: 8, canWrite: false }),
        maker(PRIYA),
        MANAGER_OR_ABOVE,
      ),
    ).toEqual({ eligible: false, reason: "NO_WORK_PERMISSION" });
  });

  it("is checked after maker != checker, so the maker is told the real reason", () => {
    // Order matters for what a person READS. Somebody who did the work and also
    // lacks the permission should be told they cannot check their own work —
    // the fact that will still be true after an administrator fixes their role.
    expect(
      isEligible(candidate({ userId: PRIYA, canWrite: false }), maker(PRIYA), MANAGER_OR_ABOVE),
    ).toEqual({ eligible: false, reason: "IS_THE_MAKER" });
  });
});

describe("a firm that has published no rule", () => {
  it("still gets a check, by anybody who is not the maker", () => {
    // Strictly more than the nobody who could check anything before T2.9, and
    // the honest reading of "the firm has not said who".
    expect(isEligible(candidate({ userId: ANAND }), maker(PRIYA), null)).toEqual({
      eligible: true,
      reason: null,
    });
  });
});

describe("the reporting line cannot be made into a loop", () => {
  it("catches the two-person loop a CHECK cannot see", () => {
    // `membership_reports_to_is_not_self` refuses a -> a, because a constraint
    // sees one row. a -> b -> a needs the walk, and it is what two people
    // picking each other out of a dropdown produces.
    const lines = new Map([[ANAND, PRIYA]]);
    expect(walkReportingLine(lines, PRIYA, ANAND)).toEqual([PRIYA, ANAND, PRIYA]);
  });

  it("catches a longer one", () => {
    const lines = new Map([
      [ANAND, SIDHARTH],
      [SIDHARTH, PRIYA],
    ]);
    expect(walkReportingLine(lines, PRIYA, ANAND)).toEqual([PRIYA, ANAND, SIDHARTH, PRIYA]);
  });

  it("allows an ordinary chain", () => {
    const lines = new Map([[ANAND, SIDHARTH]]);
    expect(walkReportingLine(lines, PRIYA, ANAND)).toBeNull();
  });

  it("allows a manager who reports to nobody", () => {
    expect(walkReportingLine(new Map(), PRIYA, ANAND)).toBeNull();
  });
});

describe("the closed sets stay honest", () => {
  it("every rule has a description and an answer about what it reads", () => {
    // A rule added without a description would ship a radio button on the
    // founder's screen with no label saying what it does — which on this subject
    // is a firm choosing its maker-checker control by guessing.
    for (const rule of VERIFICATION_RULES) {
      expect(VERIFICATION_RULE_DESCRIPTIONS[rule], rule).toBeTruthy();
      const reads = rulePer(rule);
      expect(reads.usesRank || reads.usesReportingLine, `${rule} reads nothing`).toBe(true);
    }
  });

  it("every refusal has a sentence a person can act on", () => {
    for (const [reason, message] of Object.entries(INELIGIBILITY_MESSAGES)) {
      expect(message.length, reason).toBeGreaterThan(20);
    }
  });
});
