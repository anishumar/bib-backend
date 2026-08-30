// The ports the work-item use case needs from the world — the seams (T3.1).
// Interfaces are owned by the use case that needs them (never a shared
// top-level ports package), stated in our vocabulary; adapters in
// infrastructure/ implement them.
//
// Several of these are the SAME shape another use case already declares —
// `StaffDirectory`, the policy source, the checker roster. They are restated
// here rather than imported, because two use cases never import each other in
// this codebase; the port is stated twice in each one's own words and satisfied
// ONCE by the adapter. `AxisDirectory` and `RoleDirectory` already work exactly
// this way.
import type { Actor } from "../../domain/ledger/model";
import type {
  ChecklistItem,
  SpocCandidate,
  WorkItem,
  WorkItemApproval,
  WorkItemCheck,
  WorkItemDependency,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../../domain/workitem/model";
import type { VerificationPolicy } from "../../domain/verification/model";

// ── the firm's own vocabulary ──────────────────────────────────────────────

export interface NewWorkItemState {
  readonly id: string;
  readonly tenantId: string;
  /** Normalised and validated by the service; the adapter stores it as given. */
  readonly code: string;
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly isBlocked: boolean;
  readonly isSuccess: boolean;
  readonly sortOrder: number;
}

/**
 * A state, as it will be after the edit — every field, never a partial.
 *
 * The service resolves absent fields to their current values before calling,
 * which is this codebase's convention (`StaffGradePatch`) and buys a real
 * thing: the SQL needs no dynamic assembly, so there is one statement to read
 * and no branch where a column is silently left out.
 */
export interface WorkItemStatePatch {
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly isBlocked: boolean;
  readonly isSuccess: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface NewWorkItemPriority {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly isDefault: boolean;
  readonly isStatutoryDefault: boolean;
}

/** A priority, as it will be after the edit. Whole, for `WorkItemStatePatch`'s
 *  reason. */
export interface WorkItemPriorityPatch {
  readonly name: string;
  readonly rank: number;
  readonly isDefault: boolean;
  readonly isStatutoryDefault: boolean;
  readonly isActive: boolean;
}

export interface WorkVocabularyRepository {
  /** The whole list, RETIRED rows included — an admin needs to see what the
   *  firm stopped using and be able to bring it back. Ordering is the domain's
   *  job (`stateOrder`), not the query's. */
  listStates(tenantId: string): Promise<readonly WorkItemState[]>;
  findState(tenantId: string, stateId: string): Promise<WorkItemState | null>;
  findStateByCode(tenantId: string, code: string): Promise<WorkItemState | null>;
  createState(state: NewWorkItemState): Promise<WorkItemState>;
  /**
   * Apply a patch, CLEARING the same flag on every other row when this one
   * takes it.
   *
   * One statement rather than two calls, and the partial unique index is why:
   * "at most one initial state" means marking a new one must un-mark the old
   * one in the SAME transaction, or the write conflicts with a row the caller
   * is about to change. `ClientAssignmentRepository.create` makes the identical
   * argument about a handover.
   */
  updateState(
    tenantId: string,
    stateId: string,
    patch: WorkItemStatePatch,
  ): Promise<WorkItemState>;

  listPriorities(tenantId: string): Promise<readonly WorkItemPriority[]>;
  findPriority(tenantId: string, priorityId: string): Promise<WorkItemPriority | null>;
  findPriorityByCode(tenantId: string, code: string): Promise<WorkItemPriority | null>;
  createPriority(priority: NewWorkItemPriority): Promise<WorkItemPriority>;
  updatePriority(
    tenantId: string,
    priorityId: string,
    patch: WorkItemPriorityPatch,
  ): Promise<WorkItemPriority>;

  /**
   * A brand-new firm's starting vocabulary, in ONE write each.
   *
   * Eight states and four priorities are one decision, not twelve, and
   * inserting them row by row would leave a half-built vocabulary behind any
   * failure. Returns what was written, for the caller's audit trail.
   */
  createStates(states: readonly NewWorkItemState[]): Promise<readonly WorkItemState[]>;
  createPriorities(
    priorities: readonly NewWorkItemPriority[],
  ): Promise<readonly WorkItemPriority[]>;
}

// ── the work item ──────────────────────────────────────────────────────────

/**
 * Which engagements the COMPLIANCE CALENDAR will produce work for.
 *
 * ── WHY THIS PORT EXISTS, AND WHY IT IS NOT A SETTING ──────────────────────
 *
 * T3.2 gives a recurring engagement one work item PER PERIOD — twelve GSTR-3B
 * tasks a year, each with its own statutory date. `spawnForEngagements` gives
 * every engagement ONE work item, once, at activation, due `effective_from +
 * slaDays`. Run both and a GST client's board carries a thirteenth row that can
 * never be completed (the engagement runs a year), whose due date means nothing,
 * and which is indistinguishable from a real task. Four hundred clients times
 * three recurring services is twelve hundred of them.
 *
 * So the engagement's own task is skipped where the calendar covers it — and the
 * discriminator is DERIVED here rather than configured, which is the whole point:
 *
 *   * A flag on the service could be wrong, and being wrong means SILENCE — no
 *     engagement task and no calendar rows either.
 *   * Derived, the failure inverts. A firm that has not written its GST rules
 *     is not covered, so it gets exactly today's behaviour and a task on
 *     somebody's desk. **The board can never end up empty.**
 *
 * The predicate is the generator's own: an ACTIVE rule, carrying a due formula,
 * that is not event-driven, naming this engagement's catalogue service and the
 * entity's own country. `ObligationService.coverage` reports the engagements
 * that fall on the other side of it, with a reason, so a partner sees the gap
 * rather than wondering.
 */
export interface ObligationCoverage {
  /** The subset of `engagementIds` the calendar will generate for. */
  coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/**
 * Telling the calendar that the task discharging an obligation has finished —
 * or has stopped being finished.
 *
 * ── THE OTHER DIRECTION, AND WHY IT IS A PORT AND NOT A CALL ───────────────
 *
 * `WorkItemRaiser` (in `usecase/obligation/ports.ts`) already runs the other
 * way: the calendar raises a task. This is the return leg, and without it
 * `obligation_instance.filed_on` had four readers and no writer — a calendar
 * whose every row said "Pending" forever, which is how T3.2 shipped.
 *
 * Two use cases now name each other, so the CYCLE is real and it is broken
 * where cycles belong: in the composition root, which is the only place that
 * knows both services exist. Neither file imports the other; each declares the
 * one method it needs of the other, and `setup/` satisfies both.
 *
 * ── IT TAKES A STATE, NOT AN EVENT ────────────────────────────────────────
 *
 * `discharged` is the CURRENT answer, so this is reconciliation rather than a
 * transition: calling it twice, out of order, or after a redelivery all reach
 * the same place, and a reopened item is the same call with a different answer
 * rather than a second path to keep in step.
 *
 * **And `discharged` is terminal AND successful, never terminal alone.** A firm
 * starts with two terminal states and one of them is Cancelled; reading
 * `isTerminal` here would record that a statutory return had been FILED because
 * somebody tidied their board.
 */
export interface ObligationFiling {
  reconcileFiling(
    tenantId: string,
    workItemId: string,
    discharged: boolean,
    actor: Actor,
  ): Promise<void>;
}

export interface NewWorkItem {
  readonly id: string;
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly entityPartyId: string | null;
  readonly engagementId: string | null;
  readonly jobId: string | null;
  readonly serviceVersionId: string | null;
  readonly deptAxisId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly stateId: string;
  readonly priorityId: string;
  readonly assigneeUserId: string | null;
  readonly assignmentNote: string | null;
  readonly dueOn: string | null;
  readonly isStatutoryDue: boolean;
  readonly slaDaysSnapshot: number | null;
  readonly isClientVisible: boolean;
}

/**
 * A state change, with everything the database will demand of it.
 *
 * The three timestamp fields travel WITH the state rather than being set by a
 * later update, because 0051's trigger refuses a row whose state and timestamps
 * disagree — a blocked item with no reason, a terminal one with no completion.
 * Two writes would mean the first is always the refused one.
 */
export interface WorkItemStateWrite {
  readonly stateId: string;
  readonly blockedReason: string | null;
  readonly blockedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * The editable half of a work item, whole.
 *
 * Assignment and state are deliberately NOT here — each is its own call writing
 * its own event, and folding them in would make one PATCH able to reassign work
 * silently. Whole rather than partial, for `WorkItemStatePatch`'s reason.
 */
export interface WorkItemPatch {
  readonly title: string;
  readonly description: string | null;
  readonly priorityId: string;
  readonly dueOn: string | null;
  readonly isClientVisible: boolean;
}

/** How a board is being asked to filter itself. Every field optional; the
 *  adapter builds one query, because "my open work due this week" as three
 *  round trips is three chances to read a different state. */
export interface WorkItemFilter {
  /** Only this person's. */
  readonly assigneeUserId?: string | undefined;
  /** Only work nobody has picked up — the queue the two SPOC cases land in. */
  readonly unassignedOnly?: boolean | undefined;
  readonly clientPartyId?: string | undefined;
  readonly jobId?: string | undefined;
  /** Hide anything in a terminal state. The board's default. */
  readonly openOnly?: boolean | undefined;
}

export interface WorkItemRepository {
  /**
   * Create — and the whole row, because 0051's trigger reads the state's flags
   * on INSERT as well as UPDATE. A two-phase create would be refused by the
   * database on the first phase.
   */
  create(item: NewWorkItem): Promise<WorkItem>;

  /**
   * Create only if this engagement has none yet, returning null when one
   * already exists.
   *
   * The spawn path is at-least-once — a redelivered sweep, a restarted worker,
   * a replayed activation — and a second work item is a second task on
   * somebody's desk for work already being done. The partial unique index on
   * `(tenant_id, engagement_id)` is what makes that structural rather than
   * careful; the adapter turns the conflict into null, which the caller reads
   * as "already done" and NOT as an error.
   */
  createIfAbsentForEngagement(item: NewWorkItem): Promise<WorkItem | null>;

  findById(tenantId: string, workItemId: string): Promise<WorkItem | null>;

  /** The board. Resolved names, checklist counts, open-review flag and open
   *  blockers, in ONE query — see `WorkItemRecord`. Ordering is the domain's
   *  (`boardOrder`), because "overdue" needs the caller's calendar day. */
  list(tenantId: string, filter: WorkItemFilter): Promise<readonly WorkItemRecord[]>;

  /** One item, as the task screen renders it. Same read model as the board, so
   *  a row and its page cannot disagree about what is on it. */
  findRecord(tenantId: string, workItemId: string): Promise<WorkItemRecord | null>;

  update(tenantId: string, workItemId: string, patch: WorkItemPatch): Promise<WorkItem>;

  /** The state move, with its timestamps. See `WorkItemStateWrite`. */
  setState(
    tenantId: string,
    workItemId: string,
    write: WorkItemStateWrite,
  ): Promise<WorkItem>;

  /** Put it on somebody's desk, or take it off. `note` is refused by a CHECK
   *  unless the assignee is null, which is what keeps a stale sentence off an
   *  assigned row. */
  setAssignee(
    tenantId: string,
    workItemId: string,
    assigneeUserId: string | null,
    note: string | null,
  ): Promise<WorkItem>;

  // ── the checklist ────────────────────────────────────────────────────────
  listChecklist(tenantId: string, workItemId: string): Promise<readonly ChecklistItem[]>;
  addChecklistItem(item: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly label: string;
    readonly sortOrder: number;
  }): Promise<ChecklistItem>;
  findChecklistItem(tenantId: string, checklistItemId: string): Promise<ChecklistItem | null>;
  /** Tick or untick. Both halves of the pair move together — a tick with nobody
   *  behind it is the fact this table exists to record, missing. */
  setChecklistDone(
    tenantId: string,
    checklistItemId: string,
    doneAt: string | null,
    doneByUserId: string | null,
  ): Promise<ChecklistItem>;
  /** Only an UNTICKED line. The database refuses the rest with a trigger, so
   *  this is the sentence rather than the guard. */
  removeChecklistItem(tenantId: string, checklistItemId: string): Promise<void>;

  // ── dependencies ─────────────────────────────────────────────────────────
  /** EVERY dependency edge at this firm. Read whole so `wouldCycle` can walk
   *  the graph in the domain: reachability is not expressible in SQL, and a
   *  firm's edge list is tens to low hundreds of rows. */
  listAllDependencies(tenantId: string): Promise<readonly WorkItemDependency[]>;
  addDependency(dep: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly dependsOnWorkItemId: string;
  }): Promise<WorkItemDependency>;
  findDependency(tenantId: string, dependencyId: string): Promise<WorkItemDependency | null>;
  removeDependency(tenantId: string, dependencyId: string): Promise<void>;
  /** The unfinished items this one waits on — asked before anything is allowed
   *  to complete. Titles included, because the refusal has to name them. */
  openBlockers(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly { readonly workItemId: string; readonly title: string }[]>;
}

// ── review ─────────────────────────────────────────────────────────────────

export interface NewWorkItemApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  /**
   * The rule in force when the check was opened, PINNED here. Null when the
   * caller named none — the check still happens, under maker != checker alone,
   * which is exactly what T2.9 does for a step whose firm has published no
   * rule.
   *
   * Note what is NOT in this interface: `submittedBy`. The database derives it
   * from `work_item.assignee_user_id` and freezes it (migration 0051), because
   * a maker a writer could choose is not a maker-checker control — the way past
   * the CHECK would be to name somebody else as the maker and approve it
   * yourself. This application cannot set it, and that is the point.
   */
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
}

export interface ApprovalDecisionWrite {
  readonly decision: "approved" | "rejected";
  readonly notes: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface WorkItemApprovalRepository {
  /**
   * Open a check, unless one is already open.
   *
   * The unique partial index (`decision = 'pending'`) is what makes this safe
   * against two requests arriving together; the adapter turns that conflict
   * into null, which the caller reads as "already open" rather than an error.
   */
  openIfAbsent(approval: NewWorkItemApproval): Promise<WorkItemApproval | null>;
  findById(tenantId: string, approvalId: string): Promise<WorkItemApproval | null>;
  findOpenFor(tenantId: string, workItemId: string): Promise<WorkItemApproval | null>;
  /** Decide, only if it is still pending. Conditional in SQL because two people
   *  can be looking at the same queue and both click; null means somebody else
   *  got there first, and their decision is the one that stands. */
  decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<WorkItemApproval | null>;
  /** Everything waiting to be checked at this firm, oldest first. */
  listPending(tenantId: string): Promise<readonly WorkItemCheck[]>;
  /** Every check this item has ever had, including the ones sent back. The
   *  rejections are the point. */
  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly WorkItemCheck[]>;
}

// ── the world outside ──────────────────────────────────────────────────────

/** The client, as this use case needs to see it: enough to refuse a party that
 *  is not there and one the firm has put away. Structurally what
 *  `PartyRepository.findParty` returns. */
export interface WorkItemClientRow {
  readonly id: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
}

export interface WorkItemClientDirectory {
  findParty(tenantId: string, partyId: string): Promise<WorkItemClientRow | null>;
}

/**
 * Who at the firm may be given work.
 *
 * It exists because the foreign key cannot answer it: `tenancy.user_account` is
 * GLOBAL (one login, many firms), so the database would accept a stranger with
 * every policy satisfied. The same port `usecase/lead` and
 * `usecase/clientassignment` declare, in the same words.
 */
export interface WorkItemStaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/**
 * Who the client talks to about one part of the work — G3.2's table, read.
 *
 * A LIST always, and never "the SPOC": G3.2 deliberately allows more than one
 * per Dept, and `resolveAssignee` is where that list becomes an assignment or
 * an honest refusal to guess.
 *
 * `onDate` is the CALLER's calendar day and never `CURRENT_DATE`. A server in
 * UTC and a firm in India disagree about what day it is for five and a half
 * hours every morning, and a SPOC whose term starts "today" would be invisible.
 */
export interface SpocDirectory {
  spocsFor(
    tenantId: string,
    clientPartyId: string,
    axisId: string,
    onDate: string,
  ): Promise<readonly SpocCandidate[]>;
}

/** A Dept or delivery team, as this use case needs it. */
export interface WorkAxisRow {
  readonly id: string;
  readonly axis: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

/**
 * The firm's own Dept list, looked up BY CODE.
 *
 * By code and not by id, because the code is what a pinned service body
 * carries: `body.module = "FRC"`. The uuid does not appear in the catalogue at
 * all, which is why the chain from a service to a SPOC has to pass through
 * here. A FOURTH port over `tenancy.service_axis`, satisfied by the one
 * adapter — two adapters would eventually disagree about which Depts a firm
 * has, and here that would mean a filing routed to a Dept the picker never
 * offered.
 */
export interface WorkAxisDirectory {
  findByCode(
    tenantId: string,
    // The literal union rather than `string`, so this port and
    // `ServiceAxisRepository.findByCode` agree at COMPILE time. A wider
    // parameter here would still satisfy the adapter under TypeScript's method
    // bivariance and would let a caller ask for an axis kind that cannot exist.
    axis: "dept" | "team",
    code: string,
  ): Promise<WorkAxisRow | null>;
  findById(tenantId: string, axisId: string): Promise<WorkAxisRow | null>;
}

/**
 * A firm's published answer to "who may check this kind of work".
 *
 * The same two reads `usecase/verification` declares, and the difference
 * between them is the whole of pinning: `published` is asked ONCE, when a check
 * is opened; `pinned` is asked every time afterwards, so a firm raising its
 * review bar in April never restates who was allowed to approve something in
 * March.
 */
export interface ResolvedReviewPolicy {
  readonly versionId: string;
  readonly key: string;
  readonly policy: VerificationPolicy;
}

export interface ReviewPolicySource {
  publishedPolicy(tenantId: string, key: string): Promise<ResolvedReviewPolicy | null>;
  pinnedPolicy(tenantId: string, versionId: string): Promise<ResolvedReviewPolicy | null>;
}

/**
 * Everybody at the firm who might check something, with the facts the rules
 * compare: their rung, who they report to, and whether they may write at all.
 *
 * Read WHOLE, deliberately: "who could check this" is asked for a screenful at
 * once, and the ungraded and unreported cases are the ones a screen has to
 * EXPLAIN, so they must come back rather than being filtered out in SQL.
 */
export interface ReviewerRow {
  readonly userId: string;
  readonly displayName: string;
  /** Their role AT THIS FIRM, so permissions can be resolved once per role
   *  rather than once per person — see `ReviewPermissionSource`. */
  readonly role: string;
  readonly gradeRank: number | null;
  readonly gradeName: string | null;
  readonly reportsToUserId: string | null;
}

export interface ReviewerDirectory {
  /** Active STAFF only. A deactivated membership cannot check anything, and a
   *  portal contact is a client. */
  activeStaff(tenantId: string): Promise<readonly ReviewerRow[]>;
}

/**
 * What a role carries here — asked ONCE PER ROLE and never per person.
 *
 * A hundred-person firm has five roles, and the alternative is a hundred config
 * reads to render one screen: the per-row lookup this codebase has now been
 * caught by five times. `canWrite` is therefore resolved in the use case rather
 * than by a repository, because whether somebody may write is an authorization
 * question and a repository answering one is a boundary crossed.
 */
export interface ReviewPermissionSource {
  permissionsFor(tenantId: string, role: string): Promise<readonly string[]>;
}

/**
 * What one engagement needs to become a work item.
 *
 * One row per engagement, resolved in ONE query across `crm.engagement`, its
 * letter line and the PINNED service version — because the spawn path runs
 * inside a sweep, and N round trips per engagement would be N chances to read a
 * different state than the first. Same argument `Activation` makes.
 */
export interface EngagementWork {
  readonly engagementId: string;
  /** The CLIENT — the letter's party. What the SPOC is recorded against. */
  readonly clientPartyId: string;
  /** WHICH of its companies. G0.1: a group of four files four sets. */
  readonly entityPartyId: string;
  /**
   * The day the work actually begins — `crm.engagement.effective_from`, a
   * `date` column resolved once at signature.
   *
   * Deliberately NOT `signed_at`, which is a timestamptz: turning an instant
   * into a calendar day is a day out for anybody east or west of UTC, and the
   * firm already has the calendar-native field. The firm's own rule is *"task
   * is due from signing of EL"*, and this is that day, resolved by the module
   * that owns it.
   */
  readonly effectiveFrom: string;
  /** The service version the client actually signed, pinned on the line. Null
   *  when the line or the version cannot be resolved — a service unpublished
   *  since, or a line that went missing. The item is still created; it simply
   *  has no SLA, no Dept and therefore no SPOC, visibly. */
  readonly serviceVersionId: string | null;
  readonly serviceName: string;
  /** `body.slaDays`, snapshotted onto the work item. Null when the firm has not
   *  stated a turnaround for the service — then the item has NO due date rather
   *  than one this product invented. */
  readonly slaDays: number | null;
  /** `body.module` — the Dept code the SPOC lookup joins on. Null when the firm
   *  has filed the service under none, which is a real state and not an error. */
  readonly deptCode: string | null;
}

export interface EngagementWorkSource {
  /** These engagements, resolved. Ones that do not exist at this firm are
   *  simply absent from the result — the caller is a sweep, and one bad id must
   *  not stop the rest. */
  workFor(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<readonly EngagementWork[]>;
}
