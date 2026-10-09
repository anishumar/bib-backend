// The work-item use case's ports (T3.1). `StaffDirectory`, the policy source and the checker
// roster restate ports other use cases declare (two use cases never import each other); one
// adapter satisfies each.
import type { Actor } from "../../domain/ledger/model";
import type {
  ChecklistItem,
  OwnerPerson,
  SpocCandidate,
  WorkItem,
  WorkItemApproval,
  WorkItemCheck,
  WorkItemDependency,
  WorkItemDependencyRecord,
  WorkItemNote,
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
  readonly isUnderReview: boolean;
  readonly sortOrder: number;
}

/** A state as it will be after the edit: every field, never a partial. The service fills absent
 *  fields from the current row (as `StaffGradePatch`), so the SQL is one fixed statement. */
export interface WorkItemStatePatch {
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly isBlocked: boolean;
  readonly isSuccess: boolean;
  readonly isUnderReview: boolean;
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

/** A priority as it will be after the edit; whole, as `WorkItemStatePatch`. */
export interface WorkItemPriorityPatch {
  readonly name: string;
  readonly rank: number;
  readonly isDefault: boolean;
  readonly isStatutoryDefault: boolean;
  readonly isActive: boolean;
}

export interface WorkVocabularyRepository {
  /** The whole list, RETIRED rows included (an admin may bring one back). Ordering is the
   *  domain's (`stateOrder`). */
  listStates(tenantId: string): Promise<readonly WorkItemState[]>;
  findState(tenantId: string, stateId: string): Promise<WorkItemState | null>;
  findStateByCode(tenantId: string, code: string): Promise<WorkItemState | null>;
  createState(state: NewWorkItemState): Promise<WorkItemState>;
  /** Apply a patch, CLEARING the same flag on every other row when this one takes it, in one
   *  statement: the partial unique index ("at most one initial state") would otherwise conflict
   *  (as `ClientAssignmentRepository.create`). */
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

  /** A new firm's starting vocabulary, ONE write each, so a failure leaves no half-built
   *  vocabulary. Returns what was written, for the audit trail. */
  createStates(states: readonly NewWorkItemState[]): Promise<readonly WorkItemState[]>;
  createPriorities(
    priorities: readonly NewWorkItemPriority[],
  ): Promise<readonly WorkItemPriority[]>;
}

// ── the work item ──────────────────────────────────────────────────────────

/**
 * Which engagements the COMPLIANCE CALENDAR will produce work for. T3.2 gives a recurring
 * engagement one task PER PERIOD; `spawnForEngagements` gives each engagement ONE at activation.
 * Both would leave a never-completable extra task per recurring service, so the engagement's own
 * task is skipped where the calendar covers it.
 *
 * DERIVED, not a service flag: a wrong flag means silence, whereas a firm that has not written its
 * rules is simply not covered and keeps the task, so the board can never end up empty. The
 * predicate is the generator's own: an ACTIVE, confirmed, non-event-driven rule with a due
 * formula, whose chain has a live catalogue LINK to this engagement's service (T6.16), for the
 * entity's country. `ObligationService.coverage` reports the uncovered ones with a reason.
 */
export interface ObligationCoverage {
  /** The subset of `engagementIds` the calendar will generate for. */
  coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /**
   * The subset whose service IS its filings: calendar-dated (`coveredEngagements`) AND the
   * service names no process of its own. A per-period task (T6.13) is skipped on a yes. (T6.16
   * decision 1 removed the "Any service" rule case that made this narrower.)
   *
   * A SERVICE WITH ITS OWN PROCESS KEEPS ITS TASK (firm's rule, 2026-09-26): a monthly
   * bookkeeping close that also carries TDS keeps "Monthly Accounting · Sep 2026" (its period
   * job's steps hang under it) and its filings get their own tasks. A service whose live
   * published body names a `workflowTemplateKey` is never in this set. The process is read LIVE,
   * as the orchestrator reads it, never from the version the client signed.
   */
  filingEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /** The earliest legal due day of an UNFILED filing this engagement's work covers in a period
   *  (audit 2026-10-03, CA#11): same company, a rule on its service or generated for it, period
   *  overlapping `[start, end]`, not withdrawn, filed or closed. A period's task is never due
   *  after it. */
  earliestFilingDue(
    tenantId: string,
    engagementId: string,
    period: { readonly start: string; readonly end: string },
  ): Promise<string | null>;
}

/** The period a per-period umbrella task is for (T6.13): its label and last day (the turnaround
 *  counts from it). */
export interface SpawnPeriod {
  readonly label: string;
  readonly end: string;
  /** The period's first day. When given, the task is never due after the
   *  legal date of a filing in the period (CA#11). */
  readonly start?: string;
}

/**
 * Telling the calendar a task discharging an obligation has finished, or stopped being finished:
 * the return leg of `WorkItemRaiser` (`usecase/obligation/ports.ts`), the writer of
 * `obligation_instance.filed_on`. The two use cases name each other, so the cycle is broken in
 * `setup/`: each declares the one method it needs.
 *
 * `discharged` is the CURRENT answer (reconciliation, so repeats, reorders and redeliveries
 * converge; a reopen is the same call). It means terminal AND successful, never terminal alone:
 * Cancelled is terminal, and must not record a return as FILED.
 */
export interface ObligationFiling {
  reconcileFiling(
    tenantId: string,
    workItemId: string,
    discharged: boolean,
    actor: Actor,
    /** Q084: the portal day of each return this close files, by obligation id; none = today. */
    portalDays?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Q084: refuse a bad portal day BEFORE the task moves, so the task (and a checker's decision)
   *  stays where it was. */
  assertPortalDays(tenantId: string, workItemId: string, portalDays: Readonly<Record<string, string>>): Promise<void>;
  /** The filing this task files, if any, and the company's open filings with no task yet (audit
   *  2026-10-03, CA#36): what the task page offers to link. */
  filingsForTask(
    tenantId: string,
    workItemId: string,
    entityPartyId: string,
  ): Promise<{
    readonly linked: LinkableFiling | null;
    readonly open: readonly LinkableFiling[];
    /** The filings this task filed besides its own: a period job's task files its period's
     *  returns (Q063). */
    readonly filedHere: readonly LinkableFiling[];
    /** What finishing it now would file (Q084): the returns the close asks a portal day for. */
    readonly filesOnDone: readonly LinkableFiling[];
  }>;
  /** Make this task the one that files that filing; filed at once if the task is done. The
   *  calendar's rules refuse, in words. */
  linkTask(
    tenantId: string,
    obligationId: string,
    task: { readonly id: string; readonly entityPartyId: string; readonly discharged: boolean },
    actor: Actor,
  ): Promise<void>;
  /** Take this task off the filing it files, while that is not filed. */
  unlinkTask(tenantId: string, workItemId: string, actor: Actor): Promise<void>;
}

/** One filing as the task page shows it (CA#36), in this module's words. */
export interface LinkableFiling {
  readonly obligationId: string;
  readonly name: string;
  readonly periodLabel: string;
  readonly statutoryDueOn: string;
  readonly entityName: string | null;
  readonly stateName: string;
  readonly filedOn: string | null;
  /** The task that filed it, and its title (Q063, 0357). */
  readonly filedByWorkItemId: string | null;
  readonly filedByTitle: string | null;
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

/** A state change. The timestamps travel WITH the state: 0051's trigger refuses a row whose state
 *  and timestamps disagree, so a later second write would always be refused first. */
export interface WorkItemStateWrite {
  readonly stateId: string;
  readonly blockedReason: string | null;
  readonly blockedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** The editable half of a work item, whole. Assignment and state are separate calls with their
 *  own events, so one PATCH cannot silently reassign work. */
export interface WorkItemPatch {
  readonly title: string;
  readonly description: string | null;
  readonly priorityId: string;
  readonly dueOn: string | null;
  readonly isClientVisible: boolean;
}

/** A board's filter; every field optional. The adapter builds ONE query, so the filters read one
 *  state. */
export interface WorkItemFilter {
  /** Only this person's. */
  readonly assigneeUserId?: string | undefined;
  /** Only work nobody has picked up. */
  readonly unassignedOnly?: boolean | undefined;
  readonly clientPartyId?: string | undefined;
  readonly jobId?: string | undefined;
  /** Hide anything in a terminal state (the board's default). */
  readonly openOnly?: boolean | undefined;
}

export interface WorkItemRepository {
  /** Create the whole row: 0051's trigger reads the state's flags on INSERT too, so a two-phase
   *  create is refused. */
  create(item: NewWorkItem): Promise<WorkItem>;

  /**
   * Create only if this engagement has none yet; null when one exists. The spawn path is
   * at-least-once, and the partial unique index on `(tenant_id, engagement_id)` makes a second
   * task impossible; the adapter turns the conflict into null ("already done", not an error).
   */
  createIfAbsentForEngagement(item: NewWorkItem): Promise<WorkItem | null>;

  findById(tenantId: string, workItemId: string): Promise<WorkItem | null>;

  /** The board: names, checklist counts, open-review flag and open blockers in ONE query.
   *  Ordering is the domain's (`boardOrder`), since "overdue" needs the caller's day. */
  list(tenantId: string, filter: WorkItemFilter): Promise<readonly WorkItemRecord[]>;

  /** One item for the task screen; the board's read model, so row and page agree. */
  findRecord(tenantId: string, workItemId: string): Promise<WorkItemRecord | null>;

  update(tenantId: string, workItemId: string, patch: WorkItemPatch): Promise<WorkItem>;

  /** The state move, with its timestamps. See `WorkItemStateWrite`. */
  setState(
    tenantId: string,
    workItemId: string,
    write: WorkItemStateWrite,
  ): Promise<WorkItem>;

  /** Put it on somebody's desk, or take it off. A CHECK refuses `note` unless the assignee is
   *  null. */
  setAssignee(
    tenantId: string,
    workItemId: string,
    assigneeUserId: string | null,
    note: string | null,
  ): Promise<WorkItem>;

  /**
   * The CATCH-UP's candidates (T6.17): this client's engine tasks (an engagement's or a filing's)
   * the router placed and nobody has decided on since: unfinished, in the starting state, with a
   * note other than `exceptNote` (the sentence a PERSON leaves taking a task off a desk). A note
   * on an assigned row is the router's fallback note (0311); on an unassigned row, its "nobody
   * could be given this". A task the SPOC holds has no note and is not here: nothing tells it
   * apart from one a person handed over.
   */
  listCatchUpCandidates(
    tenantId: string,
    clientPartyId: string,
    exceptNote: string,
  ): Promise<readonly CatchUpCandidate[]>;

  /** Move a task the catch-up re-decided ONLY if untouched since read (same holder, same note,
   *  still starting). Null means somebody else decided first, not an error. */
  reroute(
    tenantId: string,
    workItemId: string,
    expected: { readonly assigneeUserId: string | null; readonly note: string | null },
    next: { readonly assigneeUserId: string; readonly note: string | null },
  ): Promise<WorkItem | null>;

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
  /** Tick or untick; `doneAt` and `doneByUserId` move together. */
  setChecklistDone(
    tenantId: string,
    checklistItemId: string,
    doneAt: string | null,
    doneByUserId: string | null,
  ): Promise<ChecklistItem>;
  /** Only an UNTICKED line; a trigger refuses the rest, so this is the sentence, not the guard. */
  removeChecklistItem(tenantId: string, checklistItemId: string): Promise<void>;

  // ── dependencies ─────────────────────────────────────────────────────────
  /** EVERY dependency edge at this firm, so `wouldCycle` walks the graph in the domain
   *  (reachability is not SQL; tens to low hundreds of rows). */
  listAllDependencies(tenantId: string): Promise<readonly WorkItemDependency[]>;
  /** One item's dependencies with the item each waits on joined in (no per-row lookup). */
  listDependenciesFor(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly WorkItemDependencyRecord[]>;
  addDependency(dep: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly dependsOnWorkItemId: string;
  }): Promise<WorkItemDependency>;
  findDependency(tenantId: string, dependencyId: string): Promise<WorkItemDependency | null>;
  removeDependency(tenantId: string, dependencyId: string): Promise<void>;
  /** The unfinished items this one waits on, asked before completing; titles for the refusal. */
  openBlockers(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly { readonly workItemId: string; readonly title: string }[]>;

  // ── notes (0330, CA#30) ──────────────────────────────────────────────────
  /** Append one note; no update or delete, here or in the grant. */
  addNote(note: NewWorkItemNote): Promise<WorkItemNote>;
  /** One task's notes, oldest first, each with its author's name joined. */
  listNotes(tenantId: string, workItemId: string): Promise<readonly WorkItemNote[]>;
}

export interface NewWorkItemNote {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly authorUserId: string;
  /** Already trimmed and bounded by the service. */
  readonly body: string;
  /** The service's clock. */
  readonly createdAt: string;
}

// ── review ─────────────────────────────────────────────────────────────────

export interface NewWorkItemApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  /**
   * The rule in force when the check was opened, PINNED. Null when the caller named none: the
   * check runs under maker != checker alone, as T2.9 does.
   *
   * `submittedBy` is deliberately absent: the DB derives it from `work_item.assignee_user_id`
   * and freezes it (0051). A maker a writer could choose would let one person name another as
   * maker and approve it themselves.
   */
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
  /** What the maker says on sending it (0330), trimmed; null for nothing. */
  readonly requestNote: string | null;
}

export interface ApprovalDecisionWrite {
  readonly decision: "approved" | "rejected";
  readonly notes: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface WorkItemApprovalRepository {
  /** Open a check unless one is open. The unique partial index (`decision = 'pending'`) makes
   *  concurrent requests safe; the adapter turns the conflict into null ("already open"). */
  openIfAbsent(approval: NewWorkItemApproval): Promise<WorkItemApproval | null>;
  findById(tenantId: string, approvalId: string): Promise<WorkItemApproval | null>;
  findOpenFor(tenantId: string, workItemId: string): Promise<WorkItemApproval | null>;
  /** Decide only if still pending (conditional SQL); null means somebody else decided first,
   *  and theirs stands. */
  decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<WorkItemApproval | null>;
  /** Everything waiting to be checked at this firm, oldest first. */
  listPending(tenantId: string): Promise<readonly WorkItemCheck[]>;
  /** Every check this item has had, sent-back ones included. */
  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly WorkItemCheck[]>;
}

// ── the world outside ──────────────────────────────────────────────────────

/** The client as this use case needs it: enough to refuse a missing or archived party. The shape
 *  of `PartyRepository.findParty`. */
export interface WorkItemClientRow {
  readonly id: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
}

export interface WorkItemClientDirectory {
  findParty(tenantId: string, partyId: string): Promise<WorkItemClientRow | null>;
}

/** Who at the firm may be given work. The FK cannot answer it: `tenancy.user_account` is GLOBAL.
 *  Same port as `usecase/lead` and `usecase/clientassignment`. */
export interface WorkItemStaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/**
 * The client's SPOCs for one Dept (G3.2's table). Always a LIST: G3.2 allows several, and
 * `resolveAssignee` decides. `onDate` is the CALLER's day, never `CURRENT_DATE` (UTC and India
 * disagree for 5.5 hours every morning; a SPOC starting "today" would be invisible).
 */
export interface SpocDirectory {
  spocsFor(
    tenantId: string,
    clientPartyId: string,
    axisId: string,
    onDate: string,
  ): Promise<readonly SpocCandidate[]>;
}

/**
 * The owner rule's rungs after the SPOC (2026-09-27): the Key Manager and the person who signs
 * for the firm. Each answers with an ACTIVE staff member or null (then the next rung). The Key
 * Manager is looked up on the SPOC's `onDate`; the signatory is a firm column with no day.
 */
export interface WorkOwnerDirectory {
  keyManagerFor(tenantId: string, clientPartyId: string, onDate: string): Promise<OwnerPerson | null>;
  /** The partner who signed this client's latest signed letter, still on staff; else the firm's
   *  default signatory. */
  signingPartner(tenantId: string, clientPartyId?: string | null): Promise<OwnerPerson | null>;
}

/** The firm's timezone (0071): the firm's day when the engine creates work, which is the day
 *  the owner is looked up on (2026-09-27); the job's steps ask on the same day. */
export interface WorkItemTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * A task's steps follow the task (2026-09-27): when a fallback owner hands a job's task on, the
 * steps nobody holds go too. A port because this use case and the orchestrator must not import
 * each other (same arrangement as `ObligationFiling`). Returns how many steps moved.
 */
export interface JobStepHandover {
  adoptUnheldSteps(
    tenantId: string,
    jobId: string,
    fromUserId: string | null,
    toUserId: string,
    actor: Actor,
  ): Promise<number>;
  /** The job's unsettled steps (not done, skipped or failed), in order (Q063): what holds the
   *  job's task open. Empty with no steps laid out, e.g. a period job before its period ends. */
  openStepLabels(tenantId: string, jobId: string): Promise<readonly string[]>;
  /** The last day of a period job's period (0300), else null (S7): its task is not finished
   *  before that. */
  periodEndOf(tenantId: string, jobId: string): Promise<string | null>;
}

/** One task the catch-up may re-decide. See `listCatchUpCandidates`. */
export interface CatchUpCandidate {
  readonly workItemId: string;
  readonly jobId: string | null;
  readonly assigneeUserId: string | null;
  readonly assignmentNote: string;
  /** The engagement whose service names the Dept: the task's own, or for a filing's task the
   *  one its obligation is owed under (never linked directly, 0053). Null when neither. */
  readonly engagementId: string | null;
  /** A filing's task (T3.2): its owner is asked on its DUE date, as when it was raised. */
  readonly isFiling: boolean;
  readonly dueOn: string | null;
}

/** One line of an engagement letter, as the routing preview needs it. */
export interface LetterWorkLine {
  readonly lineId: string;
  /** The service's name as signed, else what the line says. */
  readonly name: string;
  /** The LIVE service's Dept code, read as `EngagementWorkSource` reads it. Null when none. */
  readonly deptCode: string | null;
}

/** What a letter will become work for before it is signed (T6.17's Send warning): the letter's
 *  party and the live service's `module`, read exactly as `EngagementWorkSource` reads them so
 *  the preview cannot promise one desk and deliver another. */
export interface LetterWorkSource {
  /** Null when there is no such letter at this firm. */
  linesOf(
    tenantId: string,
    letterId: string,
  ): Promise<{ readonly clientPartyId: string; readonly lines: readonly LetterWorkLine[] } | null>;
}

/** A Dept or delivery team, as this use case needs it. */
export interface WorkAxisRow {
  readonly id: string;
  readonly axis: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

/** The firm's Dept list BY CODE: a pinned service body carries the code (`body.module = "FRC"`),
 *  never the uuid. One adapter over `tenancy.service_axis` serves every such port, so the router
 *  and the picker cannot disagree about which Depts exist. */
export interface WorkAxisDirectory {
  findByCode(
    tenantId: string,
    // A literal union, so this port and `ServiceAxisRepository.findByCode` agree at compile time
    // (method bivariance would let a wider `string` through).
    axis: "dept" | "team",
    code: string,
  ): Promise<WorkAxisRow | null>;
  findById(tenantId: string, axisId: string): Promise<WorkAxisRow | null>;
}

/** A firm's published review rule. `published` is asked ONCE when a check opens; `pinned` every
 *  time after, so raising the bar in April never restates who could approve in March. */
export interface ResolvedReviewPolicy {
  readonly versionId: string;
  readonly key: string;
  readonly policy: VerificationPolicy;
}

export interface ReviewPolicySource {
  publishedPolicy(tenantId: string, key: string): Promise<ResolvedReviewPolicy | null>;
  pinnedPolicy(tenantId: string, versionId: string): Promise<ResolvedReviewPolicy | null>;
  /** Every rule in force, by key (audit 2026-10-03, CA#27). A task names no rule, so when the
   *  sender names none the firm's one applies, or the sender picks among several. A version
   *  that no longer reads as a policy is left out. */
  publishedPolicies(tenantId: string): Promise<readonly ResolvedReviewPolicy[]>;
}

/** Everybody who might check something, with their rung, manager and write access. Read WHOLE:
 *  the ungraded and unreported are what a screen must EXPLAIN, so SQL must not drop them. */
export interface ReviewerRow {
  readonly userId: string;
  readonly displayName: string;
  /** Their role AT THIS FIRM, so permissions resolve once per role (`ReviewPermissionSource`). */
  readonly role: string;
  readonly gradeRank: number | null;
  readonly gradeName: string | null;
  readonly reportsToUserId: string | null;
}

export interface ReviewerDirectory {
  /** Active STAFF only: a deactivated membership checks nothing; a portal contact is a client. */
  activeStaff(tenantId: string): Promise<readonly ReviewerRow[]>;
}

/** A role's permissions, asked ONCE PER ROLE, never per person. `canWrite` is resolved in the use
 *  case: it is an authorization question, not a repository's. */
export interface ReviewPermissionSource {
  permissionsFor(tenantId: string, role: string): Promise<readonly string[]>;
}

/** What one engagement needs to become a work item, in ONE query across `crm.engagement`, its
 *  letter line and the PINNED service version (the sweep must read one state). */
export interface EngagementWork {
  readonly engagementId: string;
  /** The CLIENT, the letter's party; what the SPOC is recorded against. */
  readonly clientPartyId: string;
  /** WHICH of its companies (G0.1: a group of four files four sets). */
  readonly entityPartyId: string;
  /** The day work begins: `crm.engagement.effective_from`, a `date` fixed at signature. Not the
   *  `signed_at` instant (a day out east or west of UTC). The firm's rule: "task is due from
   *  signing of EL". */
  readonly effectiveFrom: string;
  /** The service version signed, pinned on the line. Null when unresolvable (unpublished since,
   *  or a missing line): the item is still created, visibly with no SLA, Dept or SPOC. */
  readonly serviceVersionId: string | null;
  readonly serviceName: string;
  /** `body.slaDays`, snapshotted. Null (no turnaround stated) means NO due date. */
  readonly slaDays: number | null;
  /** `body.module`, the Dept code the SPOC lookup joins on. Null is a real state, not an error. */
  readonly deptCode: string | null;
}

export interface EngagementWorkSource {
  /** These engagements, resolved. Unknown ids are absent: one bad id must not stop a sweep. */
  workFor(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<readonly EngagementWork[]>;
}
