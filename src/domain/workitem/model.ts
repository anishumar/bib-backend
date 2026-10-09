// The work-item domain (T3.1): the row on somebody's desk and the rules that decide whose.
// Pure; imports nothing internal (arch test).
//
// A work item is WHAT is owed and WHOSE (client, due date, state, person); `delivery.job` and
// `job_step` are HOW, and exist only when the firm has published a process (split argued in
// 0051). Ad hoc work is a work item with no job, still owned, due, reviewable and late.
//
// States and priorities are ROWS (0050) the firm may rename, so no rule here compares a `code`:
// rules read `isInitial`, `isTerminal`, `isBlocked`, `isDefault`, `isStatutoryDefault` or `rank`.
// Codes exist only for a seeder or importer to look a row up.

import { isCalendarDay } from "../day";

/** A state a work item can be in — one row of the firm's own vocabulary. */
export interface WorkItemState {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle. Never compared by any rule here. */
  readonly code: string;
  readonly name: string;
  /** What a new item starts in. At most one per firm (partial unique index); with none,
   *  `initialState` returns null and the service refuses to create. */
  readonly isInitial: boolean;
  /** Nothing further happens. `completedAt` is set on entry and cleared on the way out. */
  readonly isTerminal: boolean;
  /** The work is STUCK, and a reason becomes mandatory. See `blockedReason`. */
  readonly isBlocked: boolean;
  /** The work was DONE, not abandoned (0054); terminal states only (DB-enforced). Tells
   *  Completed from Cancelled: the compliance calendar marks a filing filed, and
   *  `work_item.completed` fires, from this flag. */
  readonly isSuccess: boolean;
  /**
   * The work is WITH A CHECKER (0073). Sending for review moves the item here, so the board
   * column and the open `work_item_approval` cannot disagree. False everywhere until the firm
   * says which state means this; with none, the review opens and the state stays put (never
   * inferred from a state named "Under Review"). At most one per firm, and never blocked
   * (0051's trigger would demand a reason), terminal or initial.
   */
  readonly isUnderReview: boolean;
  readonly sortOrder: number;
  /** Whether the firm still moves work into it. Retired states still read; they are not offered. */
  readonly isActive: boolean;
}

/** How urgent, as a row. `rank` is what code compares; the name is display. */
export interface WorkItemPriority {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  /** 1 = MOST urgent: the opposite of `staff_grade.rank`, where 1 is the most junior. */
  readonly rank: number;
  /** What ordinary work gets. */
  readonly isDefault: boolean;
  /** What STATUTORY work gets: "statutory due dates should anyway be high priority". A flag so a
   *  firm can move it (e.g. to Critical) without a deploy; may be the same row as `isDefault`. */
  readonly isStatutoryDefault: boolean;
  readonly isActive: boolean;
}

/** What somebody must actually do. */
export interface WorkItem {
  readonly id: string;
  readonly tenantId: string;

  /** The CLIENT — what the SPOC and the Key Manager are recorded against. */
  readonly clientPartyId: string;
  /** WHICH of the client's companies owes it. Null for relationship-level work
   *  that belongs to no single entity. A filing always has one. */
  readonly entityPartyId: string | null;

  readonly engagementId: string | null;
  readonly jobId: string | null;
  /** The service as PINNED on the letter line — where `slaDays`, the Dept and
   *  the title were read from. */
  readonly serviceVersionId: string | null;
  /** The Dept (or delivery team) the SPOC lookup used. */
  readonly deptAxisId: string | null;

  readonly title: string;
  readonly description: string | null;

  readonly stateId: string;
  readonly priorityId: string;

  readonly assigneeUserId: string | null;
  /** Why nobody — set only while unassigned (a CHECK enforces that). The
   *  difference between "not got to yet" and "the router could not decide". */
  readonly assignmentNote: string | null;

  /** ISO YYYY-MM-DD, or null for work with no deadline. */
  readonly dueOn: string | null;
  /** The date comes from a STATUTE, not the firm; makes priority derivable. Set by T3.2. */
  readonly isStatutoryDue: boolean;
  /** The SLA AT CREATION, copied so a catalogue revision cannot make finished work late. */
  readonly slaDaysSnapshot: number | null;

  /** Whether the client may see this on their portal (U1). Defaulted true —
   *  *"Clients would be able to see their tasks."* */
  readonly isClientVisible: boolean;

  readonly blockedReason: string | null;
  readonly blockedAt: string | null;

  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/** One tick on a task. */
export interface ChecklistItem {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly doneAt: string | null;
  readonly doneByUserId: string | null;
}

/** "This cannot start until that is finished." */
export interface WorkItemDependency {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
}

export type ApprovalDecision = "pending" | "approved" | "rejected";

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "pending",
  "approved",
  "rejected",
];

export function isApprovalDecision(v: string): v is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(v);
}

/**
 * One review of one work item. Same shape as `StepApproval` (T2.9) but a separate row type (0051:
 * work with no process step must still be reviewable); `VerificationPolicy` and `eligibility()`
 * are reused unchanged.
 */
export interface WorkItemApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  /** WHO MADE THE WORK: derived by the DB from the assignee and frozen. Null when unassigned,
   *  which makes maker != checker vacuous rather than blocking. */
  readonly submittedBy: string | null;
  readonly submittedAt: string;
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
  /** What the MAKER said when sending it (0330, CA#30). Null when nothing. */
  readonly requestNote: string | null;
  readonly decision: ApprovalDecision;
  /** What the CHECKER said: required on a send-back, optional on approval. */
  readonly notes: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

/** One note on a task (0330, CA#30). Append-only (a correction is a second note); the ledger
 *  records only that one was written. */
export interface WorkItemNote {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly authorUserId: string;
  /** The author's name, joined in the read; null for an account with none. */
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
}

/** A note, trimmed, is at most this long: the database's bound too. */
export const MAX_NOTE_LENGTH = 2000;

// Read models carry NAMES, not just ids: a list of uuids makes the screen fetch a row per line.

/** A person, as a row shows them. */
export interface WorkItemPerson {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
}

/** One work item as a board renders it. */
export interface WorkItemRecord {
  readonly item: WorkItem;
  readonly clientName: string;
  /** Null when the item is not about one company. */
  readonly entityName: string | null;
  readonly state: WorkItemState;
  readonly priority: WorkItemPriority;
  readonly assignee: WorkItemPerson | null;
  /** The Dept's own words, so a board groups without resolving a config version per row. */
  readonly deptName: string | null;
  /** Checklist progress as two numbers: a board shows "3/7". */
  readonly checklistDone: number;
  readonly checklistTotal: number;
  /** A review is open now (the task screen loads the approval itself). */
  readonly hasOpenReview: boolean;
  /** The unfinished items this one waits on: ids and titles only. */
  readonly blockedByOpen: readonly WorkItemBlocker[];
  /** SENT BACK AND NOT YET SENT AGAIN (audit 2026-10-03, CA#29): the latest decided review was a
   *  send-back, none is open, the task is unfinished. My day shows it as "Sent back to you". */
  readonly sentBack: WorkItemSentBack | null;
}

/** What a send-back said, as the maker's desk shows it (CA#29). */
export interface WorkItemSentBack {
  readonly notes: string | null;
  readonly decidedAt: string;
  readonly decidedByName: string | null;
}

/** An unfinished item that another one waits on. */
export interface WorkItemBlocker {
  readonly workItemId: string;
  readonly title: string;
}

/**
 * A dependency edge with the item at the other end resolved (a bare edge renders as uuids).
 * `dependsOnIsTerminal` is the FLAG, never a state code: it separates a dependency still holding
 * this item back (refuses a start) from a record of what it used to wait on (does not).
 */
export interface WorkItemDependencyRecord {
  readonly dependency: WorkItemDependency;
  readonly dependsOnTitle: string;
  readonly dependsOnStateName: string;
  readonly dependsOnIsTerminal: boolean;
}

/** One review as a queue renders it. */
export interface WorkItemCheck {
  readonly approval: WorkItemApproval;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly clientName: string;
  /** The client by id, so a list can LINK it (V2.1's My day). */
  readonly clientPartyId: string;
  /** Which of the client's companies the work is for, if one (audit 2026-10-03, F32): My day
   *  printed the group on a task titled for one company. */
  readonly entityPartyId: string | null;
  readonly entityName: string | null;
  /** The task's own due day, `YYYY-MM-DD`, or null when it has none. */
  readonly dueOn: string | null;
  /** Who made it, by name. Null when unassigned: no maker to compare against. */
  readonly submittedByName: string | null;
  /** The policy's label, pinned with it, so a queue need not resolve a config version per row. */
  readonly policyLabel: string | null;
}

// ── The starting vocabulary ────────────────────────────────────────────────

export interface StateDefinition {
  readonly code: string;
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly isBlocked: boolean;
  readonly isSuccess: boolean;
  readonly sortOrder: number;
}

/**
 * The eight states a firm STARTS with: seed data written into a new tenant's rows and read by
 * nothing afterwards (same contract as `DEFAULT_GRADES`, `DEFAULT_ROLES`). The names are the
 * previous vendor's and still UNCONFIRMED, 10x included; renaming is a screen edit, not a
 * migration. `migrations/0050` backfills the same eight; `tests/workitem/seed-parity.test.ts`
 * fails the build if they drift.
 *
 * Only `blocked` is flagged blocking ("Waiting for Client" already says whose the delay is; a
 * firm can tick more). Exactly one terminal state is a SUCCESS (0054): reading `isTerminal`
 * alone would have the compliance calendar record a cancelled return as FILED.
 */
export const DEFAULT_WORK_ITEM_STATES: readonly StateDefinition[] = [
  { code: "not_started", name: "Not Started", isInitial: true, isTerminal: false, isBlocked: false, isSuccess: false, sortOrder: 10 },
  { code: "in_progress", name: "In Progress", isInitial: false, isTerminal: false, isBlocked: false, isSuccess: false, sortOrder: 20 },
  { code: "waiting_client", name: "Waiting for Client", isInitial: false, isTerminal: false, isBlocked: false, isSuccess: false, sortOrder: 30 },
  { code: "waiting_internal", name: "Waiting Internal", isInitial: false, isTerminal: false, isBlocked: false, isSuccess: false, sortOrder: 40 },
  { code: "under_review", name: "Under Review", isInitial: false, isTerminal: false, isBlocked: false, isSuccess: false, sortOrder: 50 },
  { code: "blocked", name: "Blocked", isInitial: false, isTerminal: false, isBlocked: true, isSuccess: false, sortOrder: 60 },
  { code: "completed", name: "Completed", isInitial: false, isTerminal: true, isBlocked: false, isSuccess: true, sortOrder: 70 },
  { code: "cancelled", name: "Cancelled", isInitial: false, isTerminal: true, isBlocked: false, isSuccess: false, sortOrder: 80 },
];

export interface PriorityDefinition {
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly isDefault: boolean;
  readonly isStatutoryDefault: boolean;
}

/** The four priorities a firm starts with. Statutory work lands on High by default. */
export const DEFAULT_WORK_ITEM_PRIORITIES: readonly PriorityDefinition[] = [
  { code: "critical", name: "Critical", rank: 1, isDefault: false, isStatutoryDefault: false },
  { code: "high", name: "High", rank: 2, isDefault: false, isStatutoryDefault: true },
  { code: "medium", name: "Medium", rank: 3, isDefault: true, isStatutoryDefault: false },
  { code: "low", name: "Low", rank: 4, isDefault: false, isStatutoryDefault: false },
];

// ── Pure rules ─────────────────────────────────────────────────────────────

/** A code is a lowercase handle, 2–40 chars. Duplicated from `domain/staffgrade/model.ts`
 *  (sibling domains may not import each other); a test holds them in agreement. */
export function isValidVocabularyCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(code);
}

export function normalizeVocabularyCode(code: string): string {
  return code.trim().toLowerCase();
}

/** A well-formed ISO date, YYYY-MM-DD. Duplicated for the arch wall's reason. */
export function isIsoDate(s: string): boolean {
  // A day that EXISTS (audit 2026-10-03, B43): 2026-13-45 reached Postgres as 22008, a 500.
  return isCalendarDay(s);
}

/** Positive integers; neither unique nor contiguous, so a priority can be inserted between two
 *  others without renumbering. */
export function isValidRank(rank: number): boolean {
  return Number.isInteger(rank) && rank > 0;
}

/** What a new item starts in, or null when the firm has none (the service refuses in words). */
export function initialState(states: readonly WorkItemState[]): WorkItemState | null {
  return states.find((s) => s.isInitial) ?? null;
}

/** Where a task goes when its job is cancelled (V2.4): the first active terminal non-success
 *  state in the firm's order. Null when none; the caller refuses rather than complete it. */
export function cancelledState(states: readonly WorkItemState[]): WorkItemState | null {
  return (
    [...states]
      .filter((s) => s.isActive && s.isTerminal && !s.isSuccess)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null
  );
}

/** Where work goes when sent to be checked (0073), or null. Null is supported: the review opens
 *  and the state stays put. Never fall back to a state NAMED "Under Review". */
export function underReviewState(states: readonly WorkItemState[]): WorkItemState | null {
  return states.find((s) => s.isUnderReview) ?? null;
}

/**
 * Where APPROVED work goes (audit 2026-10-03, CA#28): the first active terminal SUCCESS state in
 * the firm's order; the mirror of `cancelledState`. `isSuccess` (0054) is what lets an approval
 * pick a terminal state without it reading as a cancellation. Null when none: the approval
 * stands and the task stays put.
 */
export function completedState(states: readonly WorkItemState[]): WorkItemState | null {
  return (
    [...states]
      .filter((s) => s.isActive && s.isTerminal && s.isSuccess)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null
  );
}

/** Where SENT-BACK work in the "with a checker" state goes (CA#28): the first active state that
 *  is not initial, blocked (a send-back has no block reason), terminal or under review. The seed
 *  has "In Progress" there. Null when none; the task stays put. */
export function reworkState(states: readonly WorkItemState[]): WorkItemState | null {
  return (
    [...states]
      .filter(
        (s) => s.isActive && !s.isInitial && !s.isTerminal && !s.isBlocked && !s.isUnderReview,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null
  );
}

/** The labels of a task's checklist lines nobody has ticked, in the list's
 *  own order: what holds Send for review and completion shut (CA#30). */
export function openChecklistLines(lines: readonly ChecklistItem[]): readonly string[] {
  return [...lines]
    .filter((l) => l.doneAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((l) => l.label);
}

/** The default priority: the statutory default for statutory work, else the ordinary default.
 *  Never the most urgent row as a fallback; that would invent an urgency the firm never set. */
export function defaultPriorityFor(
  priorities: readonly WorkItemPriority[],
  isStatutoryDue: boolean,
): WorkItemPriority | null {
  if (isStatutoryDue) {
    const statutory = priorities.find((p) => p.isStatutoryDefault);
    if (statutory) return statutory;
  }
  return priorities.find((p) => p.isDefault) ?? null;
}

/**
 * The due date: a calendar day plus whole days, computed in explicit UTC so the result does not
 * depend on the server's zone (a `Date` is an instant; local arithmetic moves the day). The base
 * is `engagement.effective_from` (a `date`, the day work begins), not the `signed_at` instant.
 * Null `slaDays` (no turnaround stated) means NO due date, never an invented one.
 */
export function dueOnFrom(startDate: string, slaDays: number | null): string | null {
  if (slaDays === null || !isIsoDate(startDate)) return null;
  const [y, m, d] = startDate.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const due = new Date(base + slaDays * 86_400_000);
  return due.toISOString().slice(0, 10);
}

/** The result of routing a filing. Never both set: an owner, or a note saying why none, which
 *  makes an unassigned queue actionable. */
export interface AssignmentOutcome {
  readonly userId: string | null;
  readonly note: string | null;
}

/** A SPOC as the router sees one: narrow, so the rule is testable without a database. */
export interface SpocCandidate {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
  /** How many of THIS client's tasks the router has put on this desk, ever. The fewest gets the
   *  next, so two SPOCs alternate and three rotate, with no state beyond the rows. */
  readonly routed: number;
}

/**
 * The acceptance line's rule: a filing arrives pre-assigned to the client's Dept SPOC.
 *   - ONE SPOC: assigned.
 *   - NONE: unassigned with a note naming the Dept; `resolveOwner` then falls back to the Key
 *     Manager and the signing partner (Shrestha, 2026-09-27).
 *   - SEVERAL (G3.2 allows them: leave cover, joint SPOC, handover): TURN-TAKING (Shrestha,
 *     2026-09-25). Fewest `routed` wins, ties to the directory's order (longer-standing
 *     assignment first). Counts are read off the rows, so a SPOC back from leave catches up.
 * The note names PEOPLE: prose on an erasable row, never in a ledger payload.
 */
export function resolveAssignee(
  spocs: readonly SpocCandidate[],
  deptName: string | null,
): AssignmentOutcome {
  const where = deptName === null ? "this service's Dept" : deptName;
  const first = spocs[0];
  if (first === undefined) {
    return {
      userId: null,
      note:
        `No SPOC is recorded for ${where}, so this could not be routed. Naming one on the ` +
        `client's page assigns work like this automatically from then on.`,
    };
  }
  if (spocs.length === 1) return { userId: first.userId, note: null };
  // Fewest wins; `reduce` keeps the EARLIER candidate on a tie (directory order).
  const next = spocs.reduce((best, s) => (s.routed < best.routed ? s : best), first);
  return { userId: next.userId, note: null };
}

/** Which rung of the owner rule named the person; null on an outcome means nobody. Goes on the
 *  ledger as `how`, so it is a closed vocabulary, never a name. */
export type OwnerSource = "spoc" | "key_manager" | "partner";

/** Somebody the owner rule may hand work to: an ACTIVE staff member (the adapters filter). */
export interface OwnerPerson {
  readonly userId: string;
  readonly displayName: string | null;
}

/** Why the SPOC lookup could not be asked; distinct from "asked, nobody for that Dept"
 *  (`noLookup: null`, no SPOCs). Each has its own fix, and the note says which. */
export type NoSpocLookup =
  /** The service is filed under no Dept. */
  | { readonly kind: "no_dept" }
  /** The service names a Dept code the firm does not have. */
  | { readonly kind: "unknown_dept"; readonly code: string }
  /** A JOB with work for several Depts (client's work kept together): no one SPOC takes it all. */
  | { readonly kind: "several_depts"; readonly names: readonly string[] };

/** Everything the owner rule reads. The task router and the job's step desk gather it
 *  differently (one service vs several) and decide with the SAME function. */
export interface OwnerFacts {
  /** The Dept or team the work belongs to, as a person reads it. */
  readonly deptName: string | null;
  readonly noLookup: NoSpocLookup | null;
  /** The SPOCs in force for that Dept on this client, active staff only. */
  readonly spocs: readonly SpocCandidate[];
  /** The client's Key Manager in force that day, if an active member of staff. */
  readonly keyManager: OwnerPerson | null;
  /** The person who signs for the firm (`/admin/firm`), if an active member of staff. */
  readonly partner: OwnerPerson | null;
}

export interface OwnerOutcome extends AssignmentOutcome {
  readonly how: OwnerSource | null;
}

/**
 * WHO OWNS WORK WHEN IT IS CREATED (Shrestha, 2026-09-27): 1. the client's SPOC for the Dept (no
 * note); 2. else the Key Manager; 3. else the person who signs for the firm; 4. else nobody,
 * with a note naming what is missing. A fallback owner HANDS THE WORK OUT, and the note says why
 * it came to them; handing the task on takes the job's steps with it
 * (`OrchestratorService.adoptUnheldSteps`). The ONE statement of the ladder: the task router and
 * the step desk both call it, so a task and its steps cannot land on different desks. Notes name
 * PEOPLE (erasable row only); `how` is what the ledger keeps.
 */
export function resolveOwner(facts: OwnerFacts): OwnerOutcome {
  if (facts.noLookup === null && facts.spocs.length > 0) {
    const picked = resolveAssignee(facts.spocs, facts.deptName);
    return { userId: picked.userId, note: picked.note, how: "spoc" };
  }
  const why = whyNoSpoc(facts);
  const fix = howToRouteIt(facts);
  if (facts.keyManager !== null) {
    return {
      userId: facts.keyManager.userId,
      how: "key_manager",
      note: `${why}, so it came to the client's Key Manager to hand out.${fix}`,
    };
  }
  if (facts.partner !== null) {
    const who = facts.partner.displayName ?? "the person who signs for the firm";
    return {
      userId: facts.partner.userId,
      how: "partner",
      note:
        `${why} and the client has no Key Manager, so it came to ${who}, who signs for ` +
        `the firm, to hand out.${fix}`,
    };
  }
  return {
    userId: null,
    how: null,
    note:
      `${why}, the client has no Key Manager, and the firm has not named who signs for it, ` +
      `so nobody could be given this. Name a SPOC or a Key Manager on the client's page, ` +
      `or hand it to somebody here.`,
  };
}

/** The note on a task a PERSON left with nobody (`WorkItemService.assign`, no assignee). One
 *  constant so the catch-up can tell this decision from the router's "nobody could be given
 *  this" and not overrule it. Worded as since T3.1, so older rows match. */
export const TAKEN_OFF_BY_HAND_NOTE = "Taken off a desk by hand; nobody has it now.";

/** Where a task the owner rule placed sits now, as the catch-up reads it. */
export interface PlacedTask {
  readonly assigneeUserId: string | null;
  readonly assignmentNote: string | null;
}

/** What the catch-up does to one task: nothing, move it, or keep the desk and
 *  correct the sentence on it. */
export type CatchUpDecision =
  | { readonly kind: "move"; readonly userId: string; readonly how: OwnerSource; readonly note: string | null }
  | { readonly kind: "renote"; readonly note: string | null };

/**
 * THE CATCH-UP (T6.17, Shrestha 2026-09-27): the account team was named after the work was
 * created, so ask the owner rule again. Called only on an unstarted task the ROUTER placed and
 * nobody has decided on since (the caller's read guarantees it).
 *   - Names nobody: nothing; work is never taken OFF a desk by this.
 *   - Names somebody else: MOVE, with the new rung's note (none for a SPOC).
 *   - Names the current holder by another rung: keep the desk, correct only the note.
 */
export function catchUpMove(task: PlacedTask, now: OwnerOutcome): CatchUpDecision | null {
  if (now.userId === null || now.how === null) return null;
  if (now.userId !== task.assigneeUserId) {
    return { kind: "move", userId: now.userId, how: now.how, note: now.note };
  }
  return now.note === task.assignmentNote ? null : { kind: "renote", note: now.note };
}

function whyNoSpoc(facts: OwnerFacts): string {
  const lookup = facts.noLookup;
  if (lookup === null) {
    return `No SPOC is recorded for ${facts.deptName ?? "this service's Dept"} on this client`;
  }
  switch (lookup.kind) {
    case "no_dept":
      return "This service is not filed under a Dept, so it has no SPOC";
    case "unknown_dept":
      return `The service names Dept ${JSON.stringify(lookup.code)}, which is not one of this firm's Depts, so it has no SPOC`;
    case "several_depts":
      return `This job holds work for ${joinNames(lookup.names)}, so no one Dept's SPOC can take all of it`;
  }
}

/** The sentence that stops it happening again, where there is one. A job
 *  spanning several Depts has none: handing it out IS the answer. */
function howToRouteIt(facts: OwnerFacts): string {
  const lookup = facts.noLookup;
  if (lookup === null) {
    return ` Naming a SPOC for ${facts.deptName ?? "that Dept"} on the client's page sends work like this straight to them.`;
  }
  switch (lookup.kind) {
    case "no_dept":
      return " Setting a Dept on the service in the catalogue sends work like this to its SPOC.";
    case "unknown_dept":
      return " Add that Dept on the structure screen or correct the service.";
    case "several_depts":
      return "";
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "several Depts";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** Would adding `workItemId → dependsOn` close a cycle? DFS from the proposed blocker. The DB
 *  catches only the self-edge (reachability is not a CHECK); same argument as
 *  `validateWorkflowTemplateBody`. */
export function wouldCycle(
  edges: readonly Pick<WorkItemDependency, "workItemId" | "dependsOnWorkItemId">[],
  workItemId: string,
  dependsOnWorkItemId: string,
): boolean {
  if (workItemId === dependsOnWorkItemId) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.workItemId);
    if (list) list.push(e.dependsOnWorkItemId);
    else out.set(e.workItemId, [e.dependsOnWorkItemId]);
  }
  const seen = new Set<string>();
  const stack = [dependsOnWorkItemId];
  while (stack.length > 0) {
    const at = stack.pop() as string;
    if (at === workItemId) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of out.get(at) ?? []) stack.push(next);
  }
  return false;
}

/**
 * The board's order: overdue first, then urgency, due date, title (stable: a list that reorders
 * itself looks broken). `today` is the CALLER's day: a server in UTC is a day behind a firm in
 * India every morning.
 */
export function boardOrder(
  records: readonly WorkItemRecord[],
  today: string,
): readonly WorkItemRecord[] {
  const overdue = (r: WorkItemRecord): number =>
    r.item.dueOn !== null && r.item.dueOn < today && !r.state.isTerminal ? 0 : 1;
  // Undated work sorts after dated work (an empty string would sort it to the top).
  const due = (r: WorkItemRecord): string => r.item.dueOn ?? "9999-12-31";
  return [...records].sort(
    (a, b) =>
      overdue(a) - overdue(b) ||
      a.priority.rank - b.priority.rank ||
      due(a).localeCompare(due(b)) ||
      a.item.title.localeCompare(b.item.title),
  );
}

/** The states a picker offers; retired ones still render where held. */
export function assignableStates(states: readonly WorkItemState[]): readonly WorkItemState[] {
  return states.filter((s) => s.isActive);
}

/** The firm's order, then name, so equal sort orders still have ONE stable order. */
export function stateOrder(states: readonly WorkItemState[]): readonly WorkItemState[] {
  return [...states].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Most urgent first. */
export function priorityOrder(
  priorities: readonly WorkItemPriority[],
): readonly WorkItemPriority[] {
  return [...priorities].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}
