// Client portal status home (T6.5): the one read model written for a reader OUTSIDE the firm.
//   · No due date the product invented. The firm has not given turnaround times (client ask
//     3.4) or an escalation matrix (3.3), so `statutoryDueOn` is carried only where
//     `is_statutory_due` is set; everything else shows the day the work OPENED (elapsed time is
//     a fact, a deadline a commitment; T2.9 concluded the same for staff).
//   · `internal_target_on` NEVER leaves (T3.2): T-X is the firm's working margin, and showing
//     it to a client makes it the deadline.
//   · The firm's own words travel: a state arrives as its `name` (/admin/work-vocabulary);
//     nothing compares a `code` (0050).
// "Held up" is not "waiting on you": `is_blocked` means the firm cannot proceed and
// `blocked_reason` is typed text ("The client has not shared the Maharashtra purchase
// register", or "the GST portal is down"). A client-directed ask is T6.6.

/**
 * A company this login was granted, resolved per request from `crm.portal_access`, never derived
 * from a relationship. Named as everywhere else (`WorkItemRecord`, `EscalationRecord`,
 * `PortalAccessRecord`, `/auth/me` `portalScope`) and structurally identical to
 * `PortalAccessService.scopedClientsForUser`, so the port is a pass-through.
 */
export interface PortalCompany {
  readonly clientPartyId: string;
  readonly clientName: string;
}

/** Work as its client reads it. Not the staff `WorkItemRecord`: no assignee (invites chasing
 *  a junior), no priority, checklist or internal `description`, no non-statutory `due_on`. */
export interface PortalWorkRow {
  readonly workItemId: string;
  readonly title: string;
  /** Which of the client's companies; null for relationship-level work ("agree next year's
   *  scope", 0051). */
  readonly companyName: string | null;
  /** The firm's own word for where this has got to. */
  readonly stateName: string;
  readonly isHeldUp: boolean;
  /** YYYY-MM-DD: "how long has this been going on". */
  readonly openedOn: string;
  /** YYYY-MM-DD, ONLY when a statute set it; see the file header. */
  readonly statutoryDueOn: string | null;
  /** Both or neither (0051's capture-or-lose pair); a trigger insists a blocked state
   *  carries a reason. */
  readonly heldUpSince: string | null;
  readonly heldUpReason: string | null;
  /**
   * The firm has an OPEN ask on this task (T6.6). Found by opening the page: the ask "Please
   * send the Maharashtra purchase register" and the held-up reason showed one sentence twice.
   * The row stays under "Held up" (it is); only its reason is not repeated.
   */
  readonly hasOpenAsk: boolean;
}

/** A statutory filing as the company that owes it reads it: the obligation, never the task
 *  (0053). */
export interface PortalFilingRow {
  readonly obligationId: string;
  /** The rule's own name, joined rather than looked up per row. */
  readonly name: string;
  /** The company that owes it. Never null: `entity_party_id` is NOT NULL. */
  readonly companyName: string;
  /** "Aug 2026", "Q2 FY2026-27": stored at generation, so a rule retired since does not
   *  change it. */
  readonly periodLabel: string;
  /** The LAW's date. YYYY-MM-DD. */
  readonly statutoryDueOn: string;
  readonly stateName: string;
  /** YYYY-MM-DD once it is done, null while it is not. */
  readonly filedOn: string | null;
  /**
   * When the firm last told this client the filing was coming up, or null (T6.7,
   * `delivery.obligation_nudge`). A date, not a count, as `PortalAskRow.lastRemindedAt`: "we
   * told you three times" before anything is late is defensive. NULL is ordinary: a firm with
   * no published `nudge` ladder (the shipped state) tells nobody.
   */
  readonly lastNudgedAt: string | null;
}

/** Everything the status home renders, in one response. */
export interface PortalStatusHome {
  /** Empty is a real answer the screen must say: invited and granted nothing means "nothing
   *  yet, ask the firm", not "nothing is happening". */
  readonly companies: readonly PortalCompany[];
  readonly inProgress: readonly PortalWorkRow[];
  readonly heldUp: readonly PortalWorkRow[];
  readonly upcomingFilings: readonly PortalFilingRow[];
  readonly recentlyFiled: readonly PortalFilingRow[];
  /** The day computed for (the CALLER's day when sent), echoed because every window is
   *  measured from it: east of Greenwich, yesterday's home shows today's filing as upcoming. */
  readonly asOf: string;
}

/**
 * How far ahead the home looks. The calendar materialises a year ahead (T3.2), twelve GSTR-3Bs
 * per company; 90 days is a window, not a business rule. Anything overdue is included whatever
 * its date.
 */
export const PORTAL_HORIZON_DAYS = 90;

/** How far back "recently filed" reaches: 90 days for symmetry, so a client checking in
 *  monthly finds the last one. */
export const PORTAL_FILED_WINDOW_DAYS = 90;

/** Moving vs stuck. One predicate here, so the two lists cannot disagree. */
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
 * Owed vs done, by `filedOn`, not the terminal flag: 0052 seeds two terminal states, and
 * `resolved` is T3.3's end of a MISSED deadline. Calling that filed is the false statement 0054
 * was written to stop.
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
