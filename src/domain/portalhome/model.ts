// The client portal's status home (T6.5) — the nouns a client's own contact
// reads, and the two pure rules that shape them. Imports nothing internal and
// nothing beyond the standard library.
//
// ── WHOSE SCREEN THIS IS ───────────────────────────────────────────────────
//
// Every other read model in this product is written for somebody INSIDE the
// firm. This one is not, and three things follow from that alone:
//
//   · NO DUE DATE THIS PRODUCT INVENTED. The firm has not given its turnaround
//     times (client ask 3.4) or its escalation matrix (3.3), so a task's own
//     `due_on` is a promise nobody made to this reader unless the LAW made it.
//     `statutoryDueOn` is therefore carried only where `is_statutory_due` is
//     set, and everything else is answered with the day the work OPENED —
//     elapsed time is a fact, a deadline is a commitment. T2.9's verification
//     queue reached the same conclusion for a reader inside the firm; it is
//     sharper here, where the reader could quote the date back at the firm.
//   · `internal_target_on` NEVER LEAVES. T3.2 built two dates and the difference
//     is the point: the statutory one is the law's and missing it costs the
//     client money; T–X is the firm's own working margin. Showing a client the
//     margin turns it into the deadline and destroys what it was for.
//   · THE FIRM'S OWN WORDS TRAVEL, NOT THE ENGINE'S. A state arrives as its
//     `name` — the row the firm edits on /admin/work-vocabulary — and nothing
//     here compares a `code`. 0050's rule, and the portal is the surface where
//     breaking it would be least visible.
//
// ── "HELD UP" IS NOT "WAITING ON YOU", AND THE NAME IS HONEST ON PURPOSE ───
//
// The board asked for "what is waiting on THEM". Nothing in this schema records
// that: `work_item_state.is_blocked` means the firm cannot proceed, and
// `blocked_reason` is a sentence somebody typed, which at this firm reads *"The
// client has not shared the Maharashtra purchase register"* and could as easily
// read *"the GST portal is down"*. So the section says HELD UP and shows the
// reason, which is true of both. A row that says "we are waiting on YOU" needs
// a client-directed ask with its own row and its own answer — that is T6.6, and
// naming this one as though it were already built is how a screen tells a
// confident lie.

/**
 * One of the companies this login was granted — resolved once per request from
 * `crm.portal_access` and never derived from a relationship.
 *
 * `clientPartyId` / `clientName` and not `partyId` / `name`, because that is
 * what this codebase calls a client party everywhere else (`WorkItemRecord`,
 * `EscalationRecord`, `PortalAccessRecord`, and `/auth/me`'s own `portalScope`).
 * Two names for one fact is how a screen ends up mapping between them, and the
 * mapping is what drifts. Structurally identical to what
 * `PortalAccessService.scopedClientsForUser` already answers, so the
 * composition root satisfies the port with a pass-through rather than a rename.
 */
export interface PortalCompany {
  readonly clientPartyId: string;
  readonly clientName: string;
}

/**
 * A piece of the firm's work, as its client reads it.
 *
 * Deliberately NOT the staff `WorkItemRecord`: no assignee (whose desk it is on
 * is the firm's business, and a name here invites a client to chase a junior
 * directly), no priority (the firm's own triage), no checklist, no internal
 * `description`, and no `due_on` unless a statute set it.
 */
export interface PortalWorkRow {
  readonly workItemId: string;
  readonly title: string;
  /** WHICH of the client's companies, when the work is about one. Null is a
   *  real answer — relationship-level work ("agree next year's scope") is about
   *  the client and no single company (0051). */
  readonly companyName: string | null;
  /** The firm's own word for where this has got to. */
  readonly stateName: string;
  readonly isHeldUp: boolean;
  /** YYYY-MM-DD. The honest answer to "how long has this been going on". */
  readonly openedOn: string;
  /** YYYY-MM-DD, and ONLY when the date came from a statute. Null everywhere
   *  else — see the note at the top. */
  readonly statutoryDueOn: string | null;
  /** Since when it has been held up, and what for. Both or neither: 0051's
   *  capture-or-lose pair, and a trigger insists a blocked state carries a
   *  reason, so a held-up row with nothing to say cannot exist. */
  readonly heldUpSince: string | null;
  readonly heldUpReason: string | null;
  /**
   * Whether the firm has an OPEN ask on this task (T6.6).
   *
   * FOUND BY OPENING THE PAGE, and it is T6.5's own duplication bug in a new
   * costume. The action centre now shows *"Please send the Maharashtra purchase
   * register"* with a file picker under it; two sections lower, "Held up" showed
   * the identical sentence out of `blocked_reason` with nothing to do about it.
   * To the firm those are two rows — one is a note to itself, the other is a
   * request it addressed to the client — and to the client they are the same
   * sentence twice, which is the exact fault the filings/tasks dedupe fixed.
   *
   * The row is NOT removed. The task really is held up and belongs in that
   * section; what changes is that the reason is not repeated under it, because
   * the ask above already says it and has somewhere to answer it.
   */
  readonly hasOpenAsk: boolean;
}

/**
 * A statutory filing, as the company that owes it reads it.
 *
 * The obligation, never the task — 0053's distinction, and it is the one the
 * client actually cares about: "does my company still owe GSTR-3B for August"
 * is a question about the law, not about whose desk the work sits on.
 */
export interface PortalFilingRow {
  readonly obligationId: string;
  /** What the filing is called — the rule's own name, joined rather than looked
   *  up per row. */
  readonly name: string;
  /** The company that owes it. Never null: `entity_party_id` is NOT NULL. */
  readonly companyName: string;
  /** "Aug 2026", "Q2 FY2026-27" — stored at generation, so a rule retired since
   *  does not change how a filing already made is described. */
  readonly periodLabel: string;
  /** The LAW's date. YYYY-MM-DD. */
  readonly statutoryDueOn: string;
  readonly stateName: string;
  /** YYYY-MM-DD once it is done, null while it is not. */
  readonly filedOn: string | null;
  /**
   * When the firm last told this client the filing was coming up, or null if it
   * never has (T6.7, `delivery.obligation_nudge`).
   *
   * A DATE AND NOT A COUNT, the same decision `PortalAskRow.lastRemindedAt`
   * makes and for the same reason — a tally on somebody's own page is about
   * them rather than about the work. On this row it matters slightly
   * differently: what a client does with it is decide whether they MISSED a
   * message, and *"we told you three times"* about a filing that has not gone
   * late yet is the firm being defensive before there is anything to be
   * defensive about.
   *
   * NULL IS A REAL AND ORDINARY ANSWER and the screen must not treat it as a
   * fault: a firm that has published no `nudge` ladder tells nobody, which is
   * the shipped state.
   */
  readonly lastNudgedAt: string | null;
}

/** Everything the status home renders, in one response. */
export interface PortalStatusHome {
  /**
   * EMPTY IS A REAL ANSWER AND THE SCREEN MUST SAY SO. A contact who has been
   * invited and granted nothing gets an empty list here and empty lists below,
   * and that is "nothing yet, ask the firm" — not "nothing is happening". The
   * two are different sentences and only one of them is true.
   */
  readonly companies: readonly PortalCompany[];
  readonly inProgress: readonly PortalWorkRow[];
  readonly heldUp: readonly PortalWorkRow[];
  readonly upcomingFilings: readonly PortalFilingRow[];
  readonly recentlyFiled: readonly PortalFilingRow[];
  /** The day the answer was computed for — the CALLER's calendar day when they
   *  sent one. Echoed back because every window below is measured from it, and
   *  a client east of Greenwich reading a home computed for yesterday would see
   *  a filing due today sitting under "upcoming" with no explanation. */
  readonly asOf: string;
}

/**
 * How far ahead the home looks, and how far back.
 *
 * The calendar materialises a year ahead (T3.2), so an unfiltered list is twelve
 * GSTR-3Bs per company and the one due in nine days is the tenth row. Ninety
 * days is a window and not a rule about the business: nothing is hidden, because
 * anything already overdue is included whatever its date — a passed deadline is
 * the thing this reader most needs to see, and dropping it out of a forward
 * window is how it would disappear.
 */
export const PORTAL_HORIZON_DAYS = 90;

/** How far back "recently filed" reaches. The same ninety days, for symmetry
 *  rather than for a reason of its own: this is the "what has arrived" half and
 *  a client checking in monthly should find the last one they were told about. */
export const PORTAL_FILED_WINDOW_DAYS = 90;

/**
 * Split the firm's open work into what is moving and what is stuck.
 *
 * Pure, and here rather than in the query, so the two lists cannot disagree
 * about which rows they contain: one read, one predicate, both sides of it.
 */
export function splitByHeldUp(rows: readonly PortalWorkRow[]): {
  readonly inProgress: readonly PortalWorkRow[];
  readonly heldUp: readonly PortalWorkRow[];
} {
  return {
    inProgress: rows.filter((r) => !r.isHeldUp),
    heldUp: rows.filter((r) => r.isHeldUp),
  };
}

/**
 * Split filings into what is still owed and what has been done.
 *
 * `filedOn` and not the state's terminal flag, deliberately. 0052 seeds TWO
 * terminal obligation states — `filed` and `resolved` — and `resolved` is T3.3's
 * end of a deadline already missed, which a partner decided about. Telling a
 * client that a filing they never made has "arrived" is the false statement
 * 0054 was written to stop, reached from the reading side.
 */
export function splitByFiled(rows: readonly PortalFilingRow[]): {
  readonly upcoming: readonly PortalFilingRow[];
  readonly filed: readonly PortalFilingRow[];
} {
  return {
    upcoming: rows.filter((r) => r.filedOn === null),
    filed: rows.filter((r) => r.filedOn !== null),
  };
}
