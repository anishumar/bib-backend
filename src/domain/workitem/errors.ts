// Sentinel errors — the closed vocabulary of ways a work-item operation fails.
// They live in the domain so the meaning is owned here; the api layer maps them
// to HTTP status codes (domainerr.ts). Match with `instanceof`, never a string
// search.
//
// A new error FAMILY needs a line in `api/domainerr.ts` on the same commit.
// G3.3 shipped `StaffGradeError` without one and every refusal answered 500
// instead of 400/404/409 — unit tests assert on the thrown sentinel and are
// perfectly happy; only an end-to-end request sees the status code.

export class WorkItemError extends Error {
  constructor(
    readonly code: WorkItemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type WorkItemErrorCode =
  | "INVALID_VOCABULARY_CODE"
  | "INVALID_RANK"
  | "INVALID_SORT_ORDER"
  | "VOCABULARY_CODE_TAKEN"
  | "STATE_NOT_FOUND"
  | "PRIORITY_NOT_FOUND"
  | "STATE_RETIRED"
  | "PRIORITY_RETIRED"
  | "NO_INITIAL_STATE"
  | "NO_DEFAULT_PRIORITY"
  | "LAST_INITIAL_STATE"
  | "LAST_DEFAULT_PRIORITY"
  | "CONFLICTING_STATE_FLAGS"
  | "WORK_ITEM_NOT_FOUND"
  | "ROUTING_LETTER_NOT_FOUND"
  | "WORK_ITEM_CLIENT_NOT_FOUND"
  | "WORK_ITEM_CLIENT_ARCHIVED"
  | "WORK_ITEM_TITLE_REQUIRED"
  | "INVALID_DUE_DATE"
  | "ASSIGNEE_NOT_STAFF"
  | "BLOCK_REASON_REQUIRED"
  | "WORK_ITEM_ALREADY_IN_STATE"
  | "WORK_ITEM_BLOCKED_BY_DEPENDENCY"
  | "CHECKLIST_ITEM_NOT_FOUND"
  | "CHECKLIST_ITEM_DONE"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_EXISTS"
  | "DEPENDENCY_NOT_FOUND"
  | "REVIEW_ALREADY_OPEN"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_ALREADY_DECIDED"
  | "REVIEW_SELF_APPROVAL"
  | "REVIEW_REJECTION_NEEDS_NOTE"
  | "REVIEWER_NOT_ELIGIBLE";

// ── the firm's vocabulary ──────────────────────────────────────────────────

export class InvalidVocabularyCode extends WorkItemError {
  constructor(code: string) {
    super(
      "INVALID_VOCABULARY_CODE",
      `Code ${JSON.stringify(code)} is not a lowercase handle (2-40 chars, letters, digits, ` +
        `"-" or "_") — like "waiting_client". It is the firm's stable name for the row and ` +
        `nothing in the product compares it; the label people read is the name, which has no ` +
        `such restriction.`,
    );
  }
}

export class InvalidRank extends WorkItemError {
  constructor(rank: number) {
    super(
      "INVALID_RANK",
      `Rank ${JSON.stringify(rank)} must be a whole number above zero, where 1 is the MOST ` +
        `urgent. Ranks need not be unique or consecutive — two priorities may share one, and ` +
        `gaps are how a firm leaves room to insert one later.`,
    );
  }
}

export class InvalidSortOrder extends WorkItemError {
  constructor(sortOrder: number) {
    super(
      "INVALID_SORT_ORDER",
      `A sortOrder of ${JSON.stringify(sortOrder)} is not a whole number. It decides the order a ` +
        `board renders its columns in and nothing else.`,
    );
  }
}

export class VocabularyCodeTaken extends WorkItemError {
  constructor(kind: "state" | "priority", code: string) {
    super(
      "VOCABULARY_CODE_TAKEN",
      `This firm already has a work-item ${kind} with code ${JSON.stringify(code)}`,
    );
  }
}

export class StateNotFound extends WorkItemError {
  constructor(ref: string) {
    super("STATE_NOT_FOUND", `No work-item state ${JSON.stringify(ref)} at this firm`);
  }
}

export class PriorityNotFound extends WorkItemError {
  constructor(ref: string) {
    super("PRIORITY_NOT_FOUND", `No work-item priority ${JSON.stringify(ref)} at this firm`);
  }
}

export class StateRetired extends WorkItemError {
  constructor(name: string) {
    // Deliberately not silent, on `GradeNotAssignable`'s reasoning: items
    // already sitting in the state keep it and still read, but moving something
    // NEW into it is almost always a stale picker, and quietly allowing it
    // would spread a state the firm has stopped using.
    super(
      "STATE_RETIRED",
      `${JSON.stringify(name)} is a state this firm no longer uses, so nothing new can be ` +
        `moved into it. Work already sitting in it keeps it. Reactivate the state first if ` +
        `the firm is using it again.`,
    );
  }
}

export class PriorityRetired extends WorkItemError {
  constructor(name: string) {
    super(
      "PRIORITY_RETIRED",
      `${JSON.stringify(name)} is a priority this firm no longer uses, so nothing new can be ` +
        `given it. Work already carrying it keeps it.`,
    );
  }
}

export class NoInitialState extends WorkItemError {
  constructor() {
    super(
      "NO_INITIAL_STATE",
      `This firm has no starting state for work items, so nothing can be created. Exactly one ` +
        `state must be marked as the one new work begins in — the product seeds "Not Started" ` +
        `at every firm, so reaching this means it was un-marked and nothing was marked in its ` +
        `place. Set it on the work-vocabulary screen.`,
    );
  }
}

export class NoDefaultPriority extends WorkItemError {
  constructor() {
    super(
      "NO_DEFAULT_PRIORITY",
      `This firm has no default priority for work items, so nothing can be created. One ` +
        `priority must be marked as what ordinary work gets — the product seeds "Medium" at ` +
        `every firm. Set it on the work-vocabulary screen.`,
    );
  }
}

export class LastInitialState extends WorkItemError {
  constructor() {
    // The gap migration 0050 names: a partial unique index can enforce AT MOST
    // one and never AT LEAST one, so the floor lives here.
    super(
      "LAST_INITIAL_STATE",
      `This would leave the firm with no starting state, and no work item could then be ` +
        `created at all. Mark another state as the starting one first — the change is then ` +
        `two ticks and never a moment with none.`,
    );
  }
}

export class LastDefaultPriority extends WorkItemError {
  constructor(which: "default" | "statutory default") {
    super(
      "LAST_DEFAULT_PRIORITY",
      `This would leave the firm with no ${which} priority, and new work would have nothing ` +
        `to be created with. Mark another priority as the ${which} first.`,
    );
  }
}

export class ConflictingStateFlags extends WorkItemError {
  constructor(detail: string) {
    super(
      "CONFLICTING_STATE_FLAGS",
      `${detail} Each flag turns a rule on somewhere else, and two of them together would ` +
        `demand contradictory things of every work item in the state.`,
    );
  }
}

// ── the work item itself ───────────────────────────────────────────────────

export class WorkItemNotFound extends WorkItemError {
  constructor(ref: string) {
    super("WORK_ITEM_NOT_FOUND", `No work item ${JSON.stringify(ref)} at this firm`);
  }
}

/** The letter whose routing was asked about is not at this firm (T6.17). */
export class RoutingLetterNotFound extends WorkItemError {
  constructor(ref: string) {
    super("ROUTING_LETTER_NOT_FOUND", `No engagement letter ${JSON.stringify(ref)} at this firm`);
  }
}

export class WorkItemClientNotFound extends WorkItemError {
  constructor(ref: string) {
    super("WORK_ITEM_CLIENT_NOT_FOUND", `No party ${JSON.stringify(ref)} at this firm`);
  }
}

export class WorkItemClientArchived extends WorkItemError {
  constructor(name: string) {
    super(
      "WORK_ITEM_CLIENT_ARCHIVED",
      `${JSON.stringify(name)} has been archived, so new work cannot be raised against it. ` +
        `Un-archive the client first if the firm is acting for it again.`,
    );
  }
}

export class WorkItemTitleRequired extends WorkItemError {
  constructor() {
    super(
      "WORK_ITEM_TITLE_REQUIRED",
      `A work item needs a title — it is the whole of what a board row says, and an untitled ` +
        `task is one nobody can pick up`,
    );
  }
}

export class InvalidDueDate extends WorkItemError {
  constructor(value: string) {
    super(
      "INVALID_DUE_DATE",
      `${JSON.stringify(value)} is not a calendar date (YYYY-MM-DD). Dates here are the ` +
        `firm's own calendar days, never instants — an instant is a different day either ` +
        `side of midnight UTC.`,
    );
  }
}

export class AssigneeNotStaff extends WorkItemError {
  constructor(userId: string) {
    // The foreign key cannot answer this: `tenancy.user_account` is GLOBAL (one
    // login, many firms), so the database would accept a stranger with every
    // policy satisfied.
    super(
      "ASSIGNEE_NOT_STAFF",
      `User ${JSON.stringify(userId)} is not active staff at this firm, so work cannot be ` +
        `put on their desk`,
    );
  }
}

export class BlockReasonRequired extends WorkItemError {
  constructor(stateName: string) {
    super(
      "BLOCK_REASON_REQUIRED",
      `${JSON.stringify(stateName)} is a state this firm has marked as BLOCKED, and a blocked ` +
        `item owes a reason. "Blocked" on its own records that work is stuck and never why — ` +
        `and a year later "are our delays ours or the client's" has no query that can answer ` +
        `it. Send blockedReason with the move.`,
    );
  }
}

export class WorkItemAlreadyInState extends WorkItemError {
  constructor(stateName: string) {
    super(
      "WORK_ITEM_ALREADY_IN_STATE",
      `This work item is already in ${JSON.stringify(stateName)}`,
    );
  }
}

export class WorkItemBlockedByDependency extends WorkItemError {
  constructor(titles: readonly string[]) {
    // Refused on STARTING and not on finishing, because that is what a
    // dependency says: "this cannot start until that is finished". Moving
    // straight to a terminal state stays allowed — cancelling something that
    // never started is a real act, and refusing it would trap the item.
    super(
      "WORK_ITEM_BLOCKED_BY_DEPENDENCY",
      `This cannot be started while it is still waiting on ${titles.length} unfinished ` +
        `item(s): ${titles.map((t) => JSON.stringify(t)).join(", ")}. Finish or cancel those ` +
        `first, or remove the dependency if it no longer holds.`,
    );
  }
}

// ── checklist and dependencies ─────────────────────────────────────────────

export class ChecklistItemNotFound extends WorkItemError {
  constructor(ref: string) {
    super("CHECKLIST_ITEM_NOT_FOUND", `No checklist item ${JSON.stringify(ref)} on this task`);
  }
}

export class ChecklistItemDone extends WorkItemError {
  constructor() {
    super(
      "CHECKLIST_ITEM_DONE",
      `This line is ticked and cannot be removed — the tick is the record that somebody did ` +
        `it, and it lives nowhere else. Untick it first if it was ticked by mistake.`,
    );
  }
}

export class DependencyCycle extends WorkItemError {
  constructor() {
    super(
      "DEPENDENCY_CYCLE",
      `This dependency would make two items wait on each other, directly or through a chain, ` +
        `and neither could ever start`,
    );
  }
}

export class DependencyExists extends WorkItemError {
  constructor() {
    super("DEPENDENCY_EXISTS", `This item already waits on that one`);
  }
}

export class DependencyNotFound extends WorkItemError {
  constructor(ref: string) {
    super("DEPENDENCY_NOT_FOUND", `No dependency ${JSON.stringify(ref)} on this task`);
  }
}

// ── review ─────────────────────────────────────────────────────────────────

export class ReviewAlreadyOpen extends WorkItemError {
  constructor() {
    super(
      "REVIEW_ALREADY_OPEN",
      `This work item is already waiting to be checked. Two open reviews would let one ` +
        `person's approval and another's rejection both stand.`,
    );
  }
}

export class ReviewNotFound extends WorkItemError {
  constructor(ref: string) {
    super("REVIEW_NOT_FOUND", `No review ${JSON.stringify(ref)} at this firm`);
  }
}

export class ReviewAlreadyDecided extends WorkItemError {
  constructor(decision: string) {
    super(
      "REVIEW_ALREADY_DECIDED",
      `This review was already ${decision} — somebody else got there first, and their ` +
        `decision is the one that stands`,
    );
  }
}

export class ReviewSelfApproval extends WorkItemError {
  constructor() {
    // Also a CHECK constraint. Refused here so the answer is a sentence rather
    // than a constraint violation surfacing as a 500 — but the constraint is
    // what makes it true for a script, an import or an agent that never reaches
    // this code.
    super(
      "REVIEW_SELF_APPROVAL",
      `The person who did the work can never be the person who checks it. This is a database ` +
        `constraint as well as a rule here, because a rule that lives only in a form is one ` +
        `a script or an agent walks straight past.`,
    );
  }
}

export class ReviewRejectionNeedsNote extends WorkItemError {
  constructor() {
    super(
      "REVIEW_REJECTION_NEEDS_NOTE",
      `Sending work back needs a note saying what for. It is the only signal that ever ` +
        `explains why rework happens — marking the task Completed later erases the fact that ` +
        `it was rejected at all.`,
    );
  }
}

export class ReviewerNotEligible extends WorkItemError {
  constructor(reason: string) {
    super("REVIEWER_NOT_ELIGIBLE", reason);
  }
}
