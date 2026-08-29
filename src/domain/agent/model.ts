// The agent domain (T2.8) — how sure a machine was, and what it is therefore
// allowed to do by itself. Pure nouns and pure rules; imports nothing internal
// and nothing beyond the standard library.
//
// ── WHY THIS EXISTS BEFORE ANY AGENT DOES ───────────────────────────────────
//
// This product's order is deliberate: get the work firms do manually into the
// product first, standardised and visible, and only then replace some of it
// with machines. T2.7 finished the first half — a firm runs its entire process
// today with every step a person's, and `NoAgentsBuiltYet` is the honest
// implementation of that.
//
// So nothing here has an agent to govern yet. That is the point. The board puts
// it plainly above Phase 4: **guardrails first, then capabilities.** A rule
// written after the thing it restrains is a rule written by whoever is already
// shipping the thing, and this particular rule decides whether a machine may
// file a return with the firm's name on it.
//
// ── THE THREE ANSWERS, AND WHY THERE ARE THREE ──────────────────────────────
//
//   committed  the machine was sure enough to act unattended.
//   queued     the machine produced an answer and a PERSON says whether it
//              stands. The output exists; the decision does not.
//   escalated  the machine was not sure enough to propose. A person decides,
//              with whatever the machine found offered as material rather than
//              as an answer.
//
// The middle one is the whole reason this is not a boolean. "Commit or don't"
// throws away a usable draft every time it is not certain, which is most of the
// time, and a firm that has to redo the work by hand anyway has bought nothing.

/** What a machine was allowed to do with what it produced. A closed set,
 *  mirrored by the CHECK in migration 0047. */
export type AgentDecision = "committed" | "queued" | "escalated";

export const AGENT_DECISIONS: readonly AgentDecision[] = ["committed", "queued", "escalated"];

export function isAgentDecision(v: string): v is AgentDecision {
  return (AGENT_DECISIONS as readonly string[]).includes(v);
}

/**
 * What a PERSON did with a proposal — recorded, never inferred.
 *
 * `accepted` and `corrected` are kept apart even though both end with a value
 * in place, because the difference between them IS the accuracy signal. Collapse
 * them and "how often is this agent right" stops having an answer.
 */
export type ProposalOutcome = "accepted" | "corrected" | "rejected";

export const PROPOSAL_OUTCOMES: readonly ProposalOutcome[] = [
  "accepted",
  "corrected",
  "rejected",
];

export function isProposalOutcome(v: string): v is ProposalOutcome {
  return (PROPOSAL_OUTCOMES as readonly string[]).includes(v);
}

/**
 * The firm's two thresholds.
 *
 * Held together rather than as two loose numbers, because they are only
 * meaningful as a pair: a review bar above the commit bar is not a stricter
 * setting, it is an incoherent one, and the type is where that is caught.
 */
export interface ConfidenceTiers {
  /**
   * A machine may act unattended only STRICTLY ABOVE this.
   *
   * Strictly, and it matters: it makes **1.0 a real off switch**. No confidence
   * can exceed 1.0, so a firm that sets this to 1 has stopped every unattended
   * commit with one edit and no deploy — which is exactly the lever somebody
   * will want on the morning an agent gets something wrong. With `>=` there
   * would be no value that means "never".
   */
  readonly autoCommitAt: number;
  /** At or above this (and not above `autoCommitAt`) the machine proposes and a
   *  person decides. Below it, the machine is not sure enough to propose. */
  readonly reviewAt: number;
}

/**
 * What a firm gets before it has published any tiers of its own.
 *
 * NOT a set of default thresholds — those would be a decision taken on the
 * firm's behalf about when a machine may act alone. It is the pair that means
 * **"never commit unattended; always ask"**, expressed in the same two numbers
 * so that nothing downstream needs a special case:
 *
 *   autoCommitAt = 1 — nothing can be strictly above it, so nothing commits.
 *   reviewAt     = 0 — everything is at or above it, so everything proposes.
 *
 * The same shape the discount policy already takes: **no published policy means
 * ZERO, not "no limit"**. A firm that has never set a limit has not decided that
 * anything goes. Here it has not decided that a machine may file on its own.
 *
 * The practical consequence is the one that makes this safe to ship: turning
 * T2.8 on changes no firm's behaviour. Every agent output waits for a person
 * until somebody publishes a tier saying otherwise.
 */
export const ASK_A_PERSON: ConfidenceTiers = { autoCommitAt: 1, reviewAt: 0 };

/**
 * The numbers the board's acceptance names — 0.95 and 0.70.
 *
 * **Not the firm's numbers, and this is written down rather than assumed.** The
 * pre-rebuild demo says so in its own words: they *"come from another vendor's
 * document and the firm has never been asked whether it wants a machine
 * creating records with nobody watching"*. What the firm HAS confirmed (Q47,
 * closed 2026-08-21) is that unattended creation is wanted at all — *"Yes of
 * course it should be created through AI, and there should be a manual option
 * too"* — which settles whether, not where.
 *
 * So this is exported as a starting point a firm publishes deliberately, and
 * NOT seeded at `createTenant` the way roles and the grade ladder are. Those are
 * seeded because a firm without them is broken — nobody can sign in, nobody
 * meets a review threshold. A firm without these is not broken; it is cautious,
 * and that is the correct default for a permission granted to a machine.
 */
export const SUGGESTED_TIERS: ConfidenceTiers = { autoCommitAt: 0.95, reviewAt: 0.7 };

/** Confidence is a probability, and the schema stores it as `numeric(4,3)`. */
export function isConfidence(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Whether a pair of thresholds means anything.
 *
 * `reviewAt === autoCommitAt` is allowed and is not a mistake: it collapses the
 * middle band, so a machine either commits or escalates and nothing is ever
 * merely proposed. A firm might genuinely want that. `reviewAt > autoCommitAt`
 * is refused, because it describes no possible routing.
 */
export function tiersAreCoherent(t: ConfidenceTiers): boolean {
  return (
    isConfidence(t.autoCommitAt) && isConfidence(t.reviewAt) && t.reviewAt <= t.autoCommitAt
  );
}

/**
 * THE RULE. What a machine may do with what it just produced.
 *
 * Pure, and takes the thresholds as an argument rather than reading them,
 * because "was this commit allowed" has to be answerable a year later against
 * the numbers that were in force THEN — which is why the run row stores the
 * pair it was judged by rather than a reference to whatever is published now.
 */
export function decide(confidence: number, tiers: ConfidenceTiers): AgentDecision {
  if (confidence > tiers.autoCommitAt) return "committed";
  if (confidence >= tiers.reviewAt) return "queued";
  return "escalated";
}

/**
 * The decision, with the FIRM'S OWN INSTRUCTION taking precedence over the
 * numbers.
 *
 * A template says who does each step: `human`, `agent`, or `agent_with_approval`.
 * That third kind is the firm saying "a machine may do this, and a person signs
 * it off" — and it must win however confident the machine turns out to be. A
 * 0.99 result on a step the firm marked for approval commits nothing.
 *
 * This ordering is the reason the thresholds are not a load-bearing client
 * decision. The real control is per step, on the template, chosen by whoever
 * knows what the step does; the tiers are a second net under it. A firm that
 * never wants unattended action gets it by marking steps, without touching a
 * number — and a firm that changes its mind about one step changes one field.
 */
export function decideFor(
  confidence: number,
  tiers: ConfidenceTiers,
  approvalRequired: boolean,
): AgentDecision {
  const byConfidence = decide(confidence, tiers);
  if (!approvalRequired) return byConfidence;
  // Downgraded, never upgraded: an escalation stays an escalation, because "the
  // machine was not sure enough to propose" is a different message to the
  // person than "check this over", and flattening them would put a guess in
  // front of somebody as a draft.
  return byConfidence === "committed" ? "queued" : byConfidence;
}

/** Whether a decision leaves the step waiting for somebody. Both of the
 *  non-committing answers do, and they differ in what the person is being asked
 *  — to check an answer, or to produce one. */
export function needsAPerson(decision: AgentDecision): boolean {
  return decision !== "committed";
}
