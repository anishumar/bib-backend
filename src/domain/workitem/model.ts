// The work-item domain (T3.1) — the row on somebody's desk, and the rules that
// decide whose. Pure nouns and pure rules; imports nothing internal and nothing
// beyond the standard library (enforced by the arch test).
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
//
// A work item is WHAT is owed and WHOSE it is: a client, a due date, a state in
// the firm's own words, a person. `delivery.job` and `job_step` are the other
// half — HOW it gets done, in the engine's vocabulary, and only when the firm
// has published a process at all. Migration 0051 argues the split at length.
//
// The consequence worth stating here: ad hoc work — "prepare the board
// minutes" — is a work item with no job, no template and no steps, and it is
// still owned, still due, still reviewable and still late. That is why this
// module exists rather than a column on `job_step`.
//
// ── MEANING IS A FLAG; NAMES ARE THE FIRM'S ────────────────────────────────
//
// States and priorities are ROWS (migration 0050), so the firm may rename
// "Blocked" or add a ninth state without a deploy. Nothing in this file ever
// compares a `code`. Every rule reads `isInitial`, `isTerminal`, `isBlocked`,
// `isDefault`, `isStatutoryDefault` or `rank` — because a rule keyed on a name
// switches itself off the first time somebody exercises the freedom the rows
// were there to give them.
//
// The codes exist for one thing: a seeder and an importer looking a row up.

/** A state a work item can be in — one row of the firm's own vocabulary. */
export interface WorkItemState {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle. Never compared by any rule here. */
  readonly code: string;
  readonly name: string;
  /** What a new work item starts in. At most one per firm (partial unique
   *  index); "at least one" is this module's `initialState` returning null and
   *  the service refusing to create without one. */
  readonly isInitial: boolean;
  /** Nothing further happens. `completedAt` is set on entry and cleared on the
   *  way back out — the row says what is true now. */
  readonly isTerminal: boolean;
  /** The work is STUCK, and a reason becomes mandatory. See `blockedReason`. */
  readonly isBlocked: boolean;
  /**
   * The work was DONE, not abandoned (0054).
   *
   * Only meaningful on a terminal state, and the database says so. A firm
   * starts with TWO terminal states — Completed and Cancelled — and everything
   * that asks "did this actually happen" has to tell them apart: the compliance
   * calendar marks an obligation filed from this flag, and `work_item.completed`
   * fires from it, because a cancelled task is not something the firm finished.
   *
   * A flag rather than the code, for the reason at the top of this interface.
   */
  readonly isSuccess: boolean;
  /**
   * The work is WITH A CHECKER (0073).
   *
   * Sending an item for review moves it here, so the board column and the open
   * `work_item_approval` cannot disagree — before this they routinely did: the
   * buttons said Approve / Send back while the header still read "In Progress",
   * and the firm's own "Under Review" state sat in the state dropdown as a
   * second answer to the same question. Found by using the product.
   *
   * A flag rather than the code, for the reason at the top of this interface,
   * and FALSE EVERYWHERE until a firm says which of its states means this. None
   * is a real answer: a firm that never says gets exactly the old behaviour,
   * because deciding that a state called "Under Review" means under review is
   * this product having an opinion about the firm's own words.
   *
   * At most one per firm, and it can be neither blocked (0051's trigger would
   * demand a reason nobody typed), terminal, nor initial.
   */
  readonly isUnderReview: boolean;
  readonly sortOrder: number;
  /** Whether the firm still moves work into it. Retired states still READ —
   *  items sitting in one are not orphaned — they are simply not offered. */
  readonly isActive: boolean;
}

/** How urgent, as a row. `rank` is what code compares; the name is display. */
export interface WorkItemPriority {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  /** 1 = MOST urgent — the opposite direction from `staff_grade.rank`, where 1
   *  is the most junior. Both read the way the firm says them out loud, and the
   *  disagreement is called out here because the two are compared in one
   *  codebase and the next person will assume they agree. */
  readonly rank: number;
  /** What ordinary work gets. */
  readonly isDefault: boolean;
  /**
   * What STATUTORY work gets — the firm's own rule made mechanical:
   * *"due dates that are statutory should anyway be high priority"*.
   *
   * A flag rather than the constant `'high'`, so a firm that decides statutory
   * work is Critical moves a tick instead of asking for a deploy. It may be the
   * SAME row as `isDefault`, which is a real setting: a firm that does not want
   * statutory work treated differently ticks both on one priority.
   */
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
  /** True when the date comes from a STATUTE rather than from the firm. What
   *  makes priority derivable; T3.2 sets it when it materialises obligations. */
  readonly isStatutoryDue: boolean;
  /** The SLA in force AT CREATION. A copy, so a catalogue revision cannot make
   *  finished work retroactively late. */
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
 * One review of one work item.
 *
 * The same shape as `StepApproval` (T2.9) and deliberately a SEPARATE row type:
 * the two hang off different tables, and migration 0051 argues why work that
 * has no process step must still be reviewable. What is NOT duplicated is the
 * rule about who may check — `VerificationPolicy` and `eligibility()` are
 * T2.9's, are pure, and are reused unchanged.
 */
export interface WorkItemApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  /** WHO MADE THE WORK. Derived by the database from the item's assignee and
   *  frozen — the application cannot set it. Null when the item was unassigned,
   *  which makes maker != checker vacuous rather than blocking, and the screen
   *  says so. */
  readonly submittedBy: string | null;
  readonly submittedAt: string;
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
  readonly decision: ApprovalDecision;
  readonly notes: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

// ── Read models ────────────────────────────────────────────────────────────
//
// Carrying NAMES, not just ids. This codebase's rule, learnt six times over
// (`MemberRecord`, `LeadRecord`, `ProposalRecord`, party 360, the ledger's
// actor, `ClientAssignmentRecord`): a list that returns uuids makes the screen
// fetch a row per line to render itself.

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
  /** The Dept's own words, so a board can group by it without resolving a
   *  pinned config version per row. */
  readonly deptName: string | null;
  /** How much of the checklist is done — two numbers rather than the rows,
   *  because a board shows "3/7" and a task screen shows the list. */
  readonly checklistDone: number;
  readonly checklistTotal: number;
  /** Whether a review is open right now. A board marks it; the task screen
   *  loads the approval itself. */
  readonly hasOpenReview: boolean;
  /** The items this one is still waiting on — ids and titles only, because the
   *  question a screen asks is "what is in the way", not "tell me about it". */
  readonly blockedByOpen: readonly WorkItemBlocker[];
}

/** An unfinished item that another one waits on. */
export interface WorkItemBlocker {
  readonly workItemId: string;
  readonly title: string;
}

/**
 * One dependency edge with the item at the OTHER end of it resolved.
 *
 * A bare `WorkItemDependency` is three uuids, which is right for the aggregate
 * and renders as three uuids — and that is exactly what a screen showing "this
 * waits on 8f0e1c5f-…" would say. The same joined-read-model shape as
 * `WorkItemCheck`, `RelationshipRecord`, `MemberRecord` and `LeadRecord`, for
 * the same reason, and the sixth time this codebase has learnt it.
 *
 * `dependsOnIsTerminal` is the FLAG, never a state code: a firm owns the names
 * of its states and may call the finished one anything. It is what separates a
 * dependency that is still holding this item back from one that is a record of
 * what it used to wait on — the first refuses a start, the second does not, and
 * a screen that drew them the same would be offering somebody a reason to
 * remove a dependency that costs nothing.
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
  /** The task's own due day, `YYYY-MM-DD`, or null when it has none. */
  readonly dueOn: string | null;
  /** Who made it, by name. Null when the item was unassigned — "—" is the
   *  honest cell, and it is also what tells a checker there is no maker to
   *  compare against. */
  readonly submittedByName: string | null;
  /** The policy's own label, pinned with it, so a queue can say "Manager
   *  review" without resolving a config version per row. */
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
 * The eight states a firm STARTS with — seed data, not the runtime answer.
 *
 * These names are the previous vendor's vocabulary, carried across the rebuild,
 * and they are STILL UNCONFIRMED including for 10x itself. Asked about it the
 * client said to get the system working and settle the naming later — which
 * costs nothing precisely because this is a table: confirming one is an UPDATE
 * on a screen, not a migration somebody asks an engineer for.
 *
 * Same contract as `DEFAULT_GRADES` and `DEFAULT_ROLES`: written into a new
 * tenant's rows at creation and consulted by nothing afterwards. The firm owns
 * its vocabulary from that moment.
 *
 * `migrations/0050` backfills the same eight for firms that existed before it,
 * and `tests/workitem/seed-parity.test.ts` fails the build if the two drift.
 *
 * **Only `blocked` is flagged blocking**, and that is a judgement worth stating.
 * "Waiting for Client" and "Waiting Internal" are arguably stuck too — but
 * "Waiting for Client" already says whose fault the delay is, which is most of
 * what a reason field is for. A firm that wants the prose as well ticks the box
 * itself, which is the configurability being real rather than advertised.
 *
 * **Exactly one of the two terminal states is a SUCCESS** (0054), and that is
 * the whole reason the flag exists. Cancelled is terminal and is not a firm
 * finishing anything — reading `isTerminal` alone would have the compliance
 * calendar record a statutory return as FILED because somebody tidied their
 * board.
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

/** The four priorities a firm starts with. `rank` is what code compares; the
 *  names are display and may change. Statutory work lands on High by default —
 *  one tick from Critical the day the firm decides otherwise. */
export const DEFAULT_WORK_ITEM_PRIORITIES: readonly PriorityDefinition[] = [
  { code: "critical", name: "Critical", rank: 1, isDefault: false, isStatutoryDefault: false },
  { code: "high", name: "High", rank: 2, isDefault: false, isStatutoryDefault: true },
  { code: "medium", name: "Medium", rank: 3, isDefault: true, isStatutoryDefault: false },
  { code: "low", name: "Low", rank: 4, isDefault: false, isStatutoryDefault: false },
];

// ── Pure rules ─────────────────────────────────────────────────────────────

/**
 * A code is a lowercase handle, 2–40 chars.
 *
 * Duplicated from `domain/staffgrade/model.ts` rather than imported, and the
 * arch wall requires it: the two domains are siblings and neither may import
 * the other. The agreement between them is held by a test, not by a shared
 * import — the same duplication `isIsoDate` already carries.
 */
export function isValidVocabularyCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(code);
}

export function normalizeVocabularyCode(code: string): string {
  return code.trim().toLowerCase();
}

/** A well-formed ISO date, YYYY-MM-DD. Duplicated for the arch wall's reason;
 *  see `isValidVocabularyCode`. */
export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Ranks are positive integers. Not unique and not contiguous — nothing
 *  compares within a rank, only across, so uniqueness would turn "insert a
 *  priority between two others" into a renumbering. */
export function isValidRank(rank: number): boolean {
  return Number.isInteger(rank) && rank > 0;
}

/** What a new work item starts in, or null when the firm has none. Null is a
 *  refusal the service turns into a sentence, never a crash — see the note on
 *  `isInitial`. */
export function initialState(states: readonly WorkItemState[]): WorkItemState | null {
  return states.find((s) => s.isInitial) ?? null;
}

/**
 * Where a task goes when the job it belongs to is cancelled (V2.4): the firm's
 * own state that is TERMINAL and NOT a success, active, first in the firm's
 * order. Read by its flags, never its code, like every rule here; the product
 * seeds "Cancelled" at every firm. Null when the firm has none, and the
 * caller refuses rather than calling a cancellation a completion.
 */
export function cancelledState(states: readonly WorkItemState[]): WorkItemState | null {
  return (
    [...states]
      .filter((s) => s.isActive && s.isTerminal && !s.isSuccess)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null
  );
}

/**
 * Where work goes when somebody sends it to be checked, or null (0073).
 *
 * NULL IS A SUPPORTED ANSWER AND NOT A GAP. A firm that has not said which of
 * its own states means "with a checker" gets the behaviour that shipped before
 * this flag existed: the review opens and the state stays where it is. There is
 * no fallback to a state called "Under Review" and there must not be — the
 * whole reason these are rows is that the firm owns the words, and a product
 * that reads a name is a product that breaks the moment a firm renames it.
 */
export function underReviewState(states: readonly WorkItemState[]): WorkItemState | null {
  return states.find((s) => s.isUnderReview) ?? null;
}

/**
 * The priority this work gets by default.
 *
 * The whole of *"statutory due dates should anyway be high priority"*, and the
 * reason priority is not a field a human sets on every task: a field somebody
 * has to fill in on every row is a field that is wrong on most of them.
 *
 * Falls through to the ordinary default when the firm has flagged no statutory
 * one, rather than picking the most urgent row — inventing an urgency the firm
 * never set is exactly what this function exists to avoid.
 */
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
 * The due date: a calendar date plus whole days.
 *
 * ISO strings in and out, and the arithmetic runs in explicit UTC — never
 * through the process's local clock. A `Date` is an INSTANT, and an instant
 * moves the day for anybody east or west of UTC; this product has already been
 * bitten by exactly that (a client assigned at 04:11 IST was absent from its
 * holder's own book, because the row started "tomorrow" as far as the server
 * was concerned). Constructing and reading the date in UTC on both sides means
 * the calendar arithmetic is the same wherever this runs.
 *
 * The BASE is `engagement.effective_from`, which is a `date` column resolved
 * once at signature — the day the work actually begins. Deliberately not
 * `signed_at`, which is a timestamptz: converting an instant to a day is the
 * bug above, and the firm already has the calendar-native field.
 *
 * Null `slaDays` means the firm has not stated a turnaround for that service,
 * and the answer is NO DUE DATE rather than a deadline this product invented.
 */
export function dueOnFrom(startDate: string, slaDays: number | null): string | null {
  if (slaDays === null || !isIsoDate(startDate)) return null;
  const [y, m, d] = startDate.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const due = new Date(base + slaDays * 86_400_000);
  return due.toISOString().slice(0, 10);
}

/**
 * The result of routing a filing to a Dept SPOC.
 *
 * Two fields and never both set: either somebody owns it, or nobody does and
 * the row says which of the two ways the lookup failed. `note` is what makes an
 * unassigned queue actionable instead of a pile.
 */
export interface AssignmentOutcome {
  readonly userId: string | null;
  readonly note: string | null;
}

/** A SPOC as the router sees one — narrow on purpose, so this rule can be
 *  tested against two names and no database. */
export interface SpocCandidate {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
  /** How many of THIS client's tasks the router has already put on this
   *  desk, ever. The turn-taking counter: with several SPOCs on a Dept the
   *  next task goes to whoever has had the fewest, so two SPOCs alternate and
   *  three rotate, with no state beyond the rows themselves. */
  readonly routed: number;
}

/**
 * THE acceptance line's rule: a filing arrives pre-assigned to the client's
 * Dept SPOC.
 *
 * Three outcomes, and the two failures are as deliberate as the success:
 *
 *   ONE SPOC — assigned. The case the firm described, and the common one.
 *
 *   NONE — no SPOC, with a note naming the Dept. From 2026-08-30 that left the
 *   work on nobody's desk, because falling back to the Key Manager was a rule
 *   the firm never gave. The firm has now given one (Shrestha, 2026-09-27):
 *   work always has an owner. So this function still answers "none", and
 *   `resolveOwner` below is what takes that answer to the Key Manager and then
 *   to the partner who signs for the firm.
 *
 *   MORE THAN ONE — TURN-TAKING (Shrestha, 2026-09-25). G3.2 deliberately
 *   allows several per Dept (leave cover, a joint SPOC on a group, a
 *   fortnight's parallel handover). From 2026-08-30 to 2026-09-25 this case
 *   was left unassigned with a note, on the ground that "take the first" is
 *   a rule nobody gave. The firm has now given one: share the work. So the
 *   task goes to whichever of them has had the FEWEST of this client's tasks
 *   so far (`routed`), ties broken by the order the directory returns (the
 *   longer-standing assignment first). Two SPOCs alternate; three rotate. No
 *   state is kept: the count is read off the rows every time, so a SPOC who
 *   returns from leave simply catches up.
 *
 * The note names PEOPLE, which is why it is prose on an erasable row and never
 * in a ledger payload.
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
  // Whoever has had the fewest of this client's tasks. `reduce` keeps the
  // EARLIER candidate on a tie, so the directory's order is the tie-break.
  const next = spocs.reduce((best, s) => (s.routed < best.routed ? s : best), first);
  return { userId: next.userId, note: null };
}

/** Which rung of the owner rule named the person. `null` on an outcome means
 *  nobody could be named at all. Goes on the ledger as `how`, so it is a
 *  closed vocabulary and never a name. */
export type OwnerSource = "spoc" | "key_manager" | "partner";

/** Somebody the owner rule may hand work to: an ACTIVE member of the firm's
 *  staff. The adapters filter; this type is what they hand over. */
export interface OwnerPerson {
  readonly userId: string;
  readonly displayName: string | null;
}

/**
 * Why the SPOC lookup could not even be asked. Distinct from "asked, and the
 * client has nobody for that Dept", which is `noLookup: null` with no SPOCs:
 * each has its own fix, and the note says which.
 */
export type NoSpocLookup =
  /** The service is filed under no Dept. */
  | { readonly kind: "no_dept" }
  /** The service names a Dept code the firm does not have. */
  | { readonly kind: "unknown_dept"; readonly code: string }
  /** A JOB holding work for several Depts (possible when the firm keeps a
   *  client's work together): no one Dept's SPOC can take all of it. */
  | { readonly kind: "several_depts"; readonly names: readonly string[] };

/** Everything the owner rule reads, gathered by whoever is asking. The task
 *  router and the job's step desk gather it differently (a task has one
 *  service, a job may have several) and decide it with the SAME function. */
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
 * WHO OWNS A PIECE OF WORK WHEN IT IS CREATED (Shrestha, 2026-09-27).
 *
 * Work always has an owner. Unassigned work is work nobody looks at, and the
 * firm's rule is a ladder with one answer at each rung:
 *
 *   1. The client's SPOC for the work's Dept (`resolveAssignee`, turn-taking
 *      and all). The ordinary case, and the only one with no note.
 *   2. No SPOC: the client's Key Manager, who owns the whole relationship.
 *   3. No Key Manager either: the person who signs for the firm.
 *   4. Nobody at all: unassigned, and the note says which three things are
 *      missing.
 *
 * A fallback owner is there to HAND THE WORK OUT, not to do it, and the note
 * says so. That is what answers this codebase's old objection to a fallback,
 * that a wrong assignee is worse than none because it sits on a desk whose
 * owner believes it is not theirs: the owner is told, on the row, why it came
 * to them and what to do with it. Handing the task on takes the job's steps
 * with it (`OrchestratorService.adoptUnheldSteps`), so handing it out is one
 * act and not eleven.
 *
 * Pure, and the ONE statement of the ladder. The task router and the job's
 * step desk both call it, so a task and its steps can no longer land on
 * different desks because they asked two different questions, which is the
 * bug that made this function (2026-09-27: with the firm keeping a client's
 * work together, every job's steps went to nobody while its task went to the
 * SPOC).
 *
 * The note names PEOPLE, so it is prose on an erasable row and never in a
 * ledger payload; `how` is what the ledger keeps.
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

/**
 * The note a task carries when a PERSON took it off a desk and left it with
 * nobody (`WorkItemService.assign` with no assignee). One constant, because
 * the catch-up below must tell it apart from the router's own "nobody could
 * be given this": a person deciding a task should sit unassigned is a
 * decision, and the router re-deciding it would overrule them. Worded as it
 * has been since T3.1, so rows written before this constant match it.
 */
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
 * THE CATCH-UP (T6.17, Shrestha 2026-09-27): the account team was named after
 * the work was created, so ask the owner rule again and say what changes.
 *
 * Called only on a task the ROUTER placed and nobody has decided on since (on
 * a fallback desk with its note, or on nobody's with the router's note), and
 * only while it has not been started: the caller's read guarantees that, and
 * this is the rule about what the new answer means.
 *
 *   - The rule names nobody: nothing. Work is never taken OFF a desk by this;
 *     a Key Manager who has left leaves the task where it is for somebody to
 *     hand out, which is what the note on it already says.
 *   - The rule names somebody else: the task MOVES to them, with the new
 *     rung's note (none, when it is the SPOC).
 *   - The rule names the person who already holds it, by another rung (the
 *     Key Manager is now also the Dept's SPOC): the desk stays and only the
 *     sentence changes, because "no SPOC is recorded" would now be false.
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

/**
 * Would adding `workItemId → dependsOn` close a cycle?
 *
 * A depth-first walk from the proposed blocker: if it can already reach the
 * item that would wait on it, the edge closes a loop and neither would ever be
 * startable. The database catches only the trivial self-edge — reachability is
 * not expressible in a CHECK — so this is the rest of the rule, and it is the
 * same argument `validateWorkflowTemplateBody` makes about a workflow graph.
 *
 * Takes the whole edge list rather than a repository, so the rule is testable
 * against a drawing on paper.
 */
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
 * The order a board reads in.
 *
 * Overdue first — the only thing anybody is actually looking for — then by
 * urgency, then by the date it is due, then by title so two identical rows do
 * not swap places between two loads. A list that reorders itself looks broken
 * even when it is not; `ladderOrder`, `axisOrder` and `accountTeamOrder` all
 * make the same argument.
 *
 * `today` is the CALLER's calendar day, passed in. The server's own day is not
 * the firm's — a server in UTC is a day behind a firm in India every morning —
 * and "is this overdue" is exactly the kind of question that gets that wrong.
 */
export function boardOrder(
  records: readonly WorkItemRecord[],
  today: string,
): readonly WorkItemRecord[] {
  const overdue = (r: WorkItemRecord): number =>
    r.item.dueOn !== null && r.item.dueOn < today && !r.state.isTerminal ? 0 : 1;
  // Undated work sorts after dated work rather than before it: a task with no
  // deadline is not the most urgent thing on the board, and an empty string
  // would sort it to the top.
  const due = (r: WorkItemRecord): string => r.item.dueOn ?? "9999-12-31";
  return [...records].sort(
    (a, b) =>
      overdue(a) - overdue(b) ||
      a.priority.rank - b.priority.rank ||
      due(a).localeCompare(due(b)) ||
      a.item.title.localeCompare(b.item.title),
  );
}

/** The states a picker offers. Retired ones still render everywhere they are
 *  already held; they are simply not offered for a move. */
export function assignableStates(states: readonly WorkItemState[]): readonly WorkItemState[] {
  return states.filter((s) => s.isActive);
}

/** The vocabulary in the order the firm arranged it, then by name so two rows
 *  sharing a sort order still have ONE stable order. */
export function stateOrder(states: readonly WorkItemState[]): readonly WorkItemState[] {
  return [...states].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Most urgent first. */
export function priorityOrder(
  priorities: readonly WorkItemPriority[],
): readonly WorkItemPriority[] {
  return [...priorities].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}
