// The work-item use case (T3.1) — the row on somebody's desk, and the rules
// that decide whose. No I/O, no SQL, no HTTP: everything outside arrives as an
// injected port, so this reads as a description of what the business does and
// is testable with in-memory fakes and zero infrastructure.
//
// Two services, because they are two different things with two different
// audiences and two different permissions:
//
//   WorkVocabularyService  the firm's own words — states and priorities. An
//                          ADMIN screen, `tenant:admin`, changed rarely.
//   WorkItemService        the work itself. Everybody's screen, all day.
//
// ── THE ONE THING TO READ BEFORE CHANGING ANYTHING HERE ────────────────────
//
// Nothing in this file compares a state's or a priority's `code`. Every rule
// reads a FLAG — `isInitial`, `isTerminal`, `isBlocked`, `isDefault`,
// `isStatutoryDefault`, `rank`. That is not a style preference: migration 0050
// made these rows so the firm could rename "Blocked" or add a ninth state
// without a deploy, and a rule keyed on a name switches itself off the first
// time somebody exercises exactly the freedom the rows were there to give.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  ChecklistItem,
  WorkItem,
  WorkItemApproval,
  WorkItemCheck,
  WorkItemDependency,
  WorkItemDependencyRecord,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../../domain/workitem/model";
import {
  DEFAULT_WORK_ITEM_PRIORITIES,
  DEFAULT_WORK_ITEM_STATES,
  TAKEN_OFF_BY_HAND_NOTE,
  boardOrder,
  catchUpMove,
  defaultPriorityFor,
  dueOnFrom,
  initialState,
  underReviewState,
  isIsoDate,
  isValidRank,
  isValidVocabularyCode,
  normalizeVocabularyCode,
  priorityOrder,
  resolveOwner,
  stateOrder,
  wouldCycle,
} from "../../domain/workitem/model";
import type { NoSpocLookup, OwnerOutcome, OwnerSource } from "../../domain/workitem/model";
import { dayInZone } from "../../domain/scheduler/zone";
import {
  AssigneeNotStaff,
  BlockReasonRequired,
  ChecklistItemDone,
  ChecklistItemNotFound,
  ConflictingStateFlags,
  DependencyCycle,
  DependencyExists,
  DependencyNotFound,
  InvalidDueDate,
  InvalidRank,
  InvalidSortOrder,
  InvalidVocabularyCode,
  LastDefaultPriority,
  LastInitialState,
  NoDefaultPriority,
  NoInitialState,
  PriorityNotFound,
  PriorityRetired,
  ReviewAlreadyDecided,
  ReviewAlreadyOpen,
  ReviewNotFound,
  ReviewRejectionNeedsNote,
  ReviewSelfApproval,
  ReviewerNotEligible,
  StateNotFound,
  StateRetired,
  VocabularyCodeTaken,
  WorkItemAlreadyInState,
  WorkItemBlockedByDependency,
  WorkItemClientArchived,
  WorkItemClientNotFound,
  WorkItemNotFound,
  WorkItemTitleRequired,
  RoutingLetterNotFound,
} from "../../domain/workitem/errors";
// T2.9's rule about who may check whose work, reused UNCHANGED. A second
// implementation of maker != checker plus a grade threshold is a second answer
// to the same question, and the two would drift the first time a firm changed
// its policy. `usecase/scheduler` imports `domain/serviceaxis` the same way and
// for the same reason: a use case may reach a sibling DOMAIN, never a sibling
// use case.
import type { CheckerCandidate, Maker, VerificationPolicy } from "../../domain/verification/model";
import { INELIGIBILITY_MESSAGES, isEligible } from "../../domain/verification/model";
import type {
  EngagementWorkSource,
  JobStepHandover,
  LetterWorkSource,
  ObligationCoverage,
  ObligationFiling,
  NewWorkItem,
  NewWorkItemPriority,
  NewWorkItemState,
  ReviewPermissionSource,
  ReviewPolicySource,
  ReviewerDirectory,
  ReviewerRow,
  SpawnPeriod,
  SpocDirectory,
  WorkAxisDirectory,
  WorkOwnerDirectory,
  WorkItemTimeZone,
  WorkItemApprovalRepository,
  WorkItemClientDirectory,
  WorkItemFilter,
  WorkItemRepository,
  WorkItemStaffDirectory,
  WorkVocabularyRepository,
} from "./ports";

// ═══════════════════════════════════════════════════════════════════════════
//  The firm's own words
// ═══════════════════════════════════════════════════════════════════════════

export interface VocabularyDeps {
  readonly vocabulary: WorkVocabularyRepository;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface CreateStateInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly isInitial?: boolean | undefined;
  readonly isTerminal?: boolean | undefined;
  readonly isBlocked?: boolean | undefined;
  /** Reaching it means the work was DONE rather than abandoned. Only a terminal
   *  state may carry it — see `refuseConflictingFlags`. */
  readonly isSuccess?: boolean | undefined;
  /** Whether work sent for review lands here (0073). At most one state per
   *  firm; ticking it un-ticks whichever held it. */
  readonly isUnderReview?: boolean | undefined;
  readonly sortOrder?: number | undefined;
}

export interface UpdateStateInput {
  readonly tenantId: string;
  readonly stateId: string;
  /** Absent means unchanged, for each independently. */
  readonly name?: string | undefined;
  readonly isInitial?: boolean | undefined;
  readonly isTerminal?: boolean | undefined;
  readonly isBlocked?: boolean | undefined;
  readonly isSuccess?: boolean | undefined;
  /** Whether work sent for review lands here (0073). At most one state per
   *  firm; ticking it un-ticks whichever held it. */
  readonly isUnderReview?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export interface CreatePriorityInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly isDefault?: boolean | undefined;
  readonly isStatutoryDefault?: boolean | undefined;
}

export interface UpdatePriorityInput {
  readonly tenantId: string;
  readonly priorityId: string;
  readonly name?: string | undefined;
  readonly rank?: number | undefined;
  readonly isDefault?: boolean | undefined;
  readonly isStatutoryDefault?: boolean | undefined;
  readonly isActive?: boolean | undefined;
}

export class WorkVocabularyService {
  constructor(private readonly deps: VocabularyDeps) {}

  /** The states, in the order the firm arranged them, retired ones included —
   *  an admin needs to see what was stopped and bring it back. */
  async listStates(tenantId: string): Promise<readonly WorkItemState[]> {
    return stateOrder(await this.deps.vocabulary.listStates(tenantId));
  }

  /** Most urgent first. */
  async listPriorities(tenantId: string): Promise<readonly WorkItemPriority[]> {
    return priorityOrder(await this.deps.vocabulary.listPriorities(tenantId));
  }

  async createState(input: CreateStateInput, actor: Actor): Promise<WorkItemState> {
    const code = normalizeVocabularyCode(input.code);
    if (!isValidVocabularyCode(code)) throw new InvalidVocabularyCode(input.code);
    const sortOrder = input.sortOrder ?? 0;
    if (!Number.isInteger(sortOrder)) throw new InvalidSortOrder(sortOrder);

    const isInitial = input.isInitial ?? false;
    const isTerminal = input.isTerminal ?? false;
    const isBlocked = input.isBlocked ?? false;
    const isSuccess = input.isSuccess ?? false;
    const isUnderReview = input.isUnderReview ?? false;
    this.refuseConflictingFlags(isInitial, isTerminal, isBlocked, isSuccess, isUnderReview);

    // Checked rather than left to the unique constraint, which would surface as
    // an unexplained 500 on a screen where the fix is obvious.
    if (await this.deps.vocabulary.findStateByCode(input.tenantId, code)) {
      throw new VocabularyCodeTaken("state", code);
    }

    const state = await this.deps.vocabulary.createState({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      code,
      name: input.name,
      isInitial,
      isTerminal,
      isBlocked,
      isSuccess,
      isUnderReview,
      sortOrder,
    } satisfies NewWorkItemState);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item_state.created",
      objectId: state.id,
      actor,
      payload: { code: state.code, isInitial, isTerminal, isBlocked, isSuccess, isUnderReview },
    });
    return state;
  }

  /**
   * Rename a state, re-flag it, reorder it, retire it, or any combination.
   *
   * Two rules live here that the database cannot express, and both are about
   * the ABSENCE of a row:
   *
   *   The firm may never end up with NO starting state. A partial unique index
   *   enforces at most one and cannot enforce at least one, so the floor is
   *   here — and un-marking the only one is refused with a sentence saying to
   *   mark another first, which is two ticks and never a moment with none.
   *
   *   Marking a state as the starting one CLEARS the flag on the previous
   *   holder, in the same statement. Otherwise the write would conflict with a
   *   row the caller is on their way to changing.
   *
   * Idempotent: a patch that changes nothing records nothing, because nothing
   * happened to record.
   */
  async updateState(input: UpdateStateInput, actor: Actor): Promise<WorkItemState> {
    const state = await this.requireState(input.tenantId, input.stateId);
    if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
      throw new InvalidSortOrder(input.sortOrder);
    }

    const next = {
      name: input.name ?? state.name,
      isInitial: input.isInitial ?? state.isInitial,
      isTerminal: input.isTerminal ?? state.isTerminal,
      isBlocked: input.isBlocked ?? state.isBlocked,
      isSuccess: input.isSuccess ?? state.isSuccess,
      isUnderReview: input.isUnderReview ?? state.isUnderReview,
      sortOrder: input.sortOrder ?? state.sortOrder,
      isActive: input.isActive ?? state.isActive,
    };
    this.refuseConflictingFlags(
      next.isInitial,
      next.isTerminal,
      next.isBlocked,
      next.isSuccess,
      next.isUnderReview,
    );

    // Losing the starting flag, or retiring the row that holds it, both leave
    // the firm unable to create any work at all. The same refusal, because they
    // are the same hole.
    const losesInitial = state.isInitial && (!next.isInitial || !next.isActive);
    if (losesInitial) throw new LastInitialState();

    const changed =
      next.name !== state.name ||
      next.isInitial !== state.isInitial ||
      next.isTerminal !== state.isTerminal ||
      next.isBlocked !== state.isBlocked ||
      next.isSuccess !== state.isSuccess ||
      next.isUnderReview !== state.isUnderReview ||
      next.sortOrder !== state.sortOrder ||
      next.isActive !== state.isActive;
    if (!changed) return state;

    const updated = await this.deps.vocabulary.updateState(input.tenantId, state.id, next);

    // BOTH sides of whatever changed. "The flag moved" is not the useful fact a
    // year later; "it stopped being terminal on the 4th, which is why these
    // items lost their completion date" is.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item_state.updated",
      objectId: state.id,
      actor,
      payload: {
        code: state.code,
        ...(next.name === state.name ? {} : { nameFrom: state.name, nameTo: next.name }),
        ...(next.isInitial === state.isInitial ? {} : { isInitial: next.isInitial }),
        ...(next.isTerminal === state.isTerminal ? {} : { isTerminal: next.isTerminal }),
        ...(next.isBlocked === state.isBlocked ? {} : { isBlocked: next.isBlocked }),
        ...(next.isSuccess === state.isSuccess ? {} : { isSuccess: next.isSuccess }),
        ...(next.isUnderReview === state.isUnderReview
          ? {}
          : { isUnderReview: next.isUnderReview }),
        ...(next.sortOrder === state.sortOrder ? {} : { sortOrder: next.sortOrder }),
        ...(next.isActive === state.isActive ? {} : { isActive: next.isActive }),
      },
    });
    return updated;
  }

  async createPriority(input: CreatePriorityInput, actor: Actor): Promise<WorkItemPriority> {
    const code = normalizeVocabularyCode(input.code);
    if (!isValidVocabularyCode(code)) throw new InvalidVocabularyCode(input.code);
    if (!isValidRank(input.rank)) throw new InvalidRank(input.rank);

    if (await this.deps.vocabulary.findPriorityByCode(input.tenantId, code)) {
      throw new VocabularyCodeTaken("priority", code);
    }

    const priority = await this.deps.vocabulary.createPriority({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      code,
      name: input.name,
      rank: input.rank,
      isDefault: input.isDefault ?? false,
      isStatutoryDefault: input.isStatutoryDefault ?? false,
    } satisfies NewWorkItemPriority);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item_priority.created",
      objectId: priority.id,
      actor,
      payload: {
        code: priority.code,
        rank: priority.rank,
        isDefault: priority.isDefault,
        isStatutoryDefault: priority.isStatutoryDefault,
      },
    });
    return priority;
  }

  /** The same shape as `updateState`, and the same two absence rules: a firm
   *  may end up with no CRITICAL priority, but never with no default and never
   *  with no statutory default — new work would have nothing to be created
   *  with. */
  async updatePriority(input: UpdatePriorityInput, actor: Actor): Promise<WorkItemPriority> {
    const priority = await this.requirePriority(input.tenantId, input.priorityId);
    if (input.rank !== undefined && !isValidRank(input.rank)) throw new InvalidRank(input.rank);

    const next = {
      name: input.name ?? priority.name,
      rank: input.rank ?? priority.rank,
      isDefault: input.isDefault ?? priority.isDefault,
      isStatutoryDefault: input.isStatutoryDefault ?? priority.isStatutoryDefault,
      isActive: input.isActive ?? priority.isActive,
    };

    if (priority.isDefault && (!next.isDefault || !next.isActive)) {
      throw new LastDefaultPriority("default");
    }
    if (priority.isStatutoryDefault && (!next.isStatutoryDefault || !next.isActive)) {
      throw new LastDefaultPriority("statutory default");
    }

    const changed =
      next.name !== priority.name ||
      next.rank !== priority.rank ||
      next.isDefault !== priority.isDefault ||
      next.isStatutoryDefault !== priority.isStatutoryDefault ||
      next.isActive !== priority.isActive;
    if (!changed) return priority;

    const updated = await this.deps.vocabulary.updatePriority(
      input.tenantId,
      priority.id,
      next,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item_priority.updated",
      objectId: priority.id,
      actor,
      payload: {
        code: priority.code,
        ...(next.name === priority.name ? {} : { nameFrom: priority.name, nameTo: next.name }),
        ...(next.rank === priority.rank ? {} : { rankFrom: priority.rank, rankTo: next.rank }),
        ...(next.isDefault === priority.isDefault ? {} : { isDefault: next.isDefault }),
        ...(next.isStatutoryDefault === priority.isStatutoryDefault
          ? {}
          : { isStatutoryDefault: next.isStatutoryDefault }),
        ...(next.isActive === priority.isActive ? {} : { isActive: next.isActive }),
      },
    });
    return updated;
  }

  /**
   * Give a brand-new firm its starting vocabulary — the `WorkVocabularySeeder`
   * port tenancy calls from `createTenant`.
   *
   * Idempotent, and that is not defensive coding: `createTenant` and this share
   * no unit of work, so a retry after a partial failure must not produce a
   * second "In Progress". Rows that already exist are left exactly as they are,
   * because by then they may be the firm's own edits.
   *
   * ONE event, not twelve — a firm receiving its starting vocabulary is one
   * fact.
   */
  async seedDefaultVocabulary(tenantId: string, actor: Actor): Promise<readonly string[]> {
    const heldStates = new Set((await this.deps.vocabulary.listStates(tenantId)).map((s) => s.code));
    const missingStates: NewWorkItemState[] = DEFAULT_WORK_ITEM_STATES.filter(
      (s) => !heldStates.has(s.code),
    ).map((s) => ({
      id: this.deps.ids.newId(),
      tenantId,
      code: s.code,
      name: s.name,
      isInitial: s.isInitial,
      isTerminal: s.isTerminal,
      isBlocked: s.isBlocked,
      isSuccess: s.isSuccess,
      // NEVER seeded, and this literal is the promise. The firm's eight
      // starting states came from a previous vendor and one of them is called
      // "Under Review" — ticking it here would be this product deciding that a
      // name means a mechanism, which is the whole thing 0050 made these rows
      // to avoid. A firm says so on its own vocabulary screen, or never does.
      isUnderReview: false,
      sortOrder: s.sortOrder,
    }));

    const heldPriorities = new Set(
      (await this.deps.vocabulary.listPriorities(tenantId)).map((p) => p.code),
    );
    const missingPriorities: NewWorkItemPriority[] = DEFAULT_WORK_ITEM_PRIORITIES.filter(
      (p) => !heldPriorities.has(p.code),
    ).map((p) => ({
      id: this.deps.ids.newId(),
      tenantId,
      code: p.code,
      name: p.name,
      rank: p.rank,
      isDefault: p.isDefault,
      isStatutoryDefault: p.isStatutoryDefault,
    }));

    if (missingStates.length === 0 && missingPriorities.length === 0) return [];

    const states =
      missingStates.length > 0 ? await this.deps.vocabulary.createStates(missingStates) : [];
    const priorities =
      missingPriorities.length > 0
        ? await this.deps.vocabulary.createPriorities(missingPriorities)
        : [];

    await this.deps.events.recordEvent({
      tenantId,
      verb: "work_vocabulary.seeded",
      objectId: tenantId,
      actor,
      payload: { states: states.length, priorities: priorities.length },
    });
    return [...states.map((s) => s.code), ...priorities.map((p) => p.code)];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async requireState(tenantId: string, stateId: string): Promise<WorkItemState> {
    const state = await this.deps.vocabulary.findState(tenantId, stateId);
    if (!state) throw new StateNotFound(stateId);
    return state;
  }

  private async requirePriority(
    tenantId: string,
    priorityId: string,
  ): Promise<WorkItemPriority> {
    const priority = await this.deps.vocabulary.findPriority(tenantId, priorityId);
    if (!priority) throw new PriorityNotFound(priorityId);
    return priority;
  }

  /**
   * The three flag pairs that cannot both be true.
   *
   * Also CHECK constraints, and refused here so the answer is a sentence rather
   * than a constraint violation on a screen where the fix is a tick. Each pair
   * would demand contradictory things of every item in the state: a terminal
   * blocked state wants a completion time and a block reason at once, and
   * 0051's trigger would refuse every write into it with a message about a
   * field the admin never saw.
   */
  private refuseConflictingFlags(
    isInitial: boolean,
    isTerminal: boolean,
    isBlocked: boolean,
    isSuccess: boolean,
    isUnderReview: boolean,
  ): void {
    // 0073's three CHECKs, said as sentences. The blocked one is the sharp
    // one and its reason is not symmetry: 0051's trigger demands a
    // `blocked_reason` on every row in a blocked state, and sending work to be
    // checked has no reason to give — so a firm that ticked both would make
    // every review request fail on a field the admin never saw.
    if (isUnderReview && isBlocked) {
      throw new ConflictingStateFlags(
        "A state cannot mean both 'with a checker' and 'blocked': work is moved here " +
          "automatically when somebody sends it for review, and a blocked state demands a " +
          "written reason that nobody would have typed.",
      );
    }
    if (isUnderReview && isTerminal) {
      throw new ConflictingStateFlags(
        "A state cannot mean both 'with a checker' and finished: work waiting to be checked " +
          "is not work that is done.",
      );
    }
    if (isUnderReview && isInitial) {
      throw new ConflictingStateFlags(
        "A state cannot be both the starting state and 'with a checker': every new task would " +
          "be created as though somebody had already sent it to be reviewed.",
      );
    }
    if (isSuccess && !isTerminal) {
      throw new ConflictingStateFlags(
        "Only a state the firm treats as finished can mean the work was done: mark it " +
          "terminal, or leave it unticked. Work that is still running has not succeeded yet.",
      );
    }
    if (isTerminal && isBlocked) {
      throw new ConflictingStateFlags(
        "A state cannot be both terminal and blocked: finished work is not stuck.",
      );
    }
    if (isInitial && isTerminal) {
      throw new ConflictingStateFlags(
        "A state cannot be both the starting state and a terminal one: new work would be " +
          "created already finished.",
      );
    }
    if (isInitial && isBlocked) {
      throw new ConflictingStateFlags(
        "A state cannot be both the starting state and a blocked one: every new work item " +
          "would need a block reason before it could exist.",
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  The work itself
// ═══════════════════════════════════════════════════════════════════════════

export interface Deps {
  readonly items: WorkItemRepository;
  readonly approvals: WorkItemApprovalRepository;
  readonly vocabulary: WorkVocabularyRepository;
  readonly clients: WorkItemClientDirectory;
  readonly staff: WorkItemStaffDirectory;
  readonly spocs: SpocDirectory;
  /** The Key Manager and the signing partner: the owner rule's later rungs. */
  readonly owners: WorkOwnerDirectory;
  /** A task's unheld steps go with it when it is handed on. */
  readonly jobSteps: JobStepHandover;
  /** The firm's zone, for the day a spawned task's owner is looked up on. */
  readonly timeZones: WorkItemTimeZone;
  readonly axes: WorkAxisDirectory;
  readonly policies: ReviewPolicySource;
  readonly reviewers: ReviewerDirectory;
  readonly permissions: ReviewPermissionSource;
  readonly engagements: EngagementWorkSource;
  /** An unsigned letter's lines, for the routing preview on its Send (T6.17). */
  readonly letters: LetterWorkSource;
  readonly obligations: ObligationCoverage;
  /**
   * The compliance calendar, told when a filing's task settles (0054).
   *
   * The return leg of `ObligationRaiser`, and the one writer
   * `obligation_instance.filed_on` has. Injected rather than called, so this
   * service still knows nothing about obligations beyond the one sentence it
   * has to say to them — and so the cycle between the two use cases is broken
   * in `setup/`, which is the only place that knows both exist.
   */
  readonly filings: ObligationFiling;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

export interface CreateWorkItemInput {
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly entityPartyId?: string | null | undefined;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly priorityId?: string | undefined;
  readonly assigneeUserId?: string | null | undefined;
  readonly dueOn?: string | null | undefined;
  readonly isStatutoryDue?: boolean | undefined;
  readonly isClientVisible?: boolean | undefined;
  /** The caller's calendar day, used for the SPOC lookup. Defaults to the
   *  server's, which is the only honest fallback for an API caller that did not
   *  say — see `today()`. */
  readonly asOf?: string | undefined;
}

export interface UpdateWorkItemInput {
  readonly tenantId: string;
  readonly workItemId: string;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly priorityId?: string | undefined;
  readonly dueOn?: string | null | undefined;
  readonly isClientVisible?: boolean | undefined;
}

export interface MoveStateInput {
  readonly tenantId: string;
  readonly workItemId: string;
  readonly stateId: string;
  /** Required when the target state is one the firm has marked as BLOCKED, and
   *  refused otherwise. */
  readonly blockedReason?: string | null | undefined;
}

export interface AssignWorkItemInput {
  readonly tenantId: string;
  readonly workItemId: string;
  /** Null takes it off the desk it is on. */
  readonly assigneeUserId: string | null;
}

export interface RequestReviewInput {
  readonly tenantId: string;
  readonly workItemId: string;
  /**
   * Which of the firm's published rules decides who may check this.
   *
   * OPTIONAL, and a default was deliberately not invented. There is no template
   * step here to name one (that is where T2.9 gets its key), and picking a rule
   * on the firm's behalf would be this product deciding who signs off its work.
   * Absent means maker != checker alone — exactly what T2.9 does for a step
   * whose firm has published no rule, and strictly more than the nothing that
   * existed before.
   */
  readonly policyKey?: string | null | undefined;
}

export interface DecideReviewInput {
  readonly tenantId: string;
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
  readonly notes?: string | null | undefined;
  readonly decidedBy: string;
}

/** One person who might check a work item, with the answer and its reason. */
export interface CheckerOption {
  readonly userId: string;
  readonly displayName: string;
  readonly gradeName: string | null;
  readonly eligible: boolean;
  /** What to SAY when they are not. A refusal with no reason is how somebody
   *  concludes the button is broken. */
  readonly reason: string | null;
}

/**
 * One row of the firm's check queue, with the viewer's own verdict on it.
 *
 * The verdict is on the ROW rather than deciding whether the row is there:
 * a queue that hides what you cannot take also hides that nobody senior enough
 * has looked at it. `/work`'s step queue carries the same field for the same
 * reason — this is the task half of the same desk.
 */
export interface WorkItemCheckOnDesk extends WorkItemCheck {
  readonly viewer: {
    readonly eligible: boolean;
    /** The SENTENCE, not the code — the same prose `eligibleCheckers` returns,
     *  so the queue and the "who may check this?" list never phrase one
     *  refusal two ways. Null when they may check it. */
    readonly reason: string | null;
  };
}

/**
 * What the catch-up moved (T6.17), per person it moved work to. Ids and
 * counts only: the screen that asked already holds the firm's roster and
 * names them from it.
 */
export interface CaughtUpWork {
  readonly moves: readonly {
    readonly userId: string;
    readonly tasks: number;
    readonly steps: number;
  }[];
}

/**
 * Whose desk an unsigned letter's work will land on, one row per Dept its
 * lines are filed under (T6.17's Send warning). The owner rule answered for
 * TODAY, the day the account team can still be changed; the router asks again
 * when the signed letter becomes work, so this is a forecast and says so.
 */
export interface LetterRouting {
  readonly letterId: string;
  readonly clientPartyId: string;
  readonly onDate: string;
  readonly depts: readonly LetterDeptRouting[];
}

export interface LetterDeptRouting {
  /** The service's Dept code, or null for lines filed under no Dept. */
  readonly deptCode: string | null;
  /** The firm's name for it; null when the code is not one of its Depts. */
  readonly deptName: string | null;
  readonly lines: readonly { readonly lineId: string; readonly name: string }[];
  /** Which rung answered; null when nobody could be named. */
  readonly how: OwnerSource | null;
  readonly userId: string | null;
  readonly ownerName: string | null;
  /**
   * Why the SPOC rung was passed, when it was: the Dept has no SPOC on this
   * client (`no_spoc`), the service is filed under no Dept (`no_dept`), or it
   * names a Dept code the firm does not have (`unknown_dept`). Null when a
   * SPOC takes it.
   */
  readonly reason: "no_spoc" | "no_dept" | "unknown_dept" | null;
}

/** One work item and everything its own screen shows. */
export interface WorkItemDetail {
  readonly record: WorkItemRecord;
  readonly checklist: readonly ChecklistItem[];
  /**
   * What this item waits on, each RESOLVED.
   *
   * It was the bare edge — three uuids — for as long as it existed, and no
   * screen ever rendered it, which is how it stayed that way. `record.blockedByOpen`
   * carried the titles of the UNFINISHED blockers all along, so a screen could
   * name half of these and had no way to name the other half, and no way to
   * reach the `dependencyId` that the DELETE route takes.
   */
  readonly dependencies: readonly WorkItemDependencyRecord[];
  /** Every review it has ever had, newest first — the rejections are the
   *  point. */
  readonly reviews: readonly WorkItemCheck[];
  /**
   * MAY THE CALLER DECIDE THE OPEN REVIEW — the same verdict the queue puts on
   * every one of its rows, and null when there is no open review.
   *
   * ONE FIELD RATHER THAN ONE PER ROW, because the question only exists for the
   * open one: "may you check this" is not asked of a review already approved or
   * sent back, and a verdict on a decided row would be a sentence nobody should
   * act on.
   *
   * It exists because the item's own page could derive only maker != checker,
   * from `submittedBy` — one third of the rule. The comment on that screen said
   * so and named this as the fix. The ladder rule and the grade threshold were
   * found by pressing Approve and reading a 403, while the QUEUE screen had
   * been showing the same person the full answer since T2.9. Two screens, one
   * question, two answers.
   */
  readonly openReviewViewer: {
    readonly eligible: boolean;
    /** The SENTENCE, not the code — `INELIGIBILITY_MESSAGES`, the same prose
     *  the queue and `/checkers` return. One refusal, one wording. */
    readonly reason: string | null;
  } | null;
}

export class WorkItemService {
  constructor(private readonly deps: Deps) {}

  // ── reading ──────────────────────────────────────────────────────────────

  /**
   * The board.
   *
   * `today` is the CALLER's calendar day, because "overdue" is the first thing
   * the ordering asks and the server's day is not the firm's — a server in UTC
   * is a day behind a firm in India every morning. A browser sends its own.
   */
  async board(
    tenantId: string,
    filter: WorkItemFilter,
    asOf?: string,
  ): Promise<readonly WorkItemRecord[]> {
    const today = asOf ?? this.today();
    if (!isIsoDate(today)) throw new InvalidDueDate(today);
    return boardOrder(await this.deps.items.list(tenantId, filter), today);
  }

  /**
   * One item and everything its own screen shows.
   *
   * `viewer` is the caller, and it is OPTIONAL for the same reason
   * `pendingChecks` takes it that way: a caller who is not a person — a test,
   * an import — gets the honest "not on the roster" answer rather than a crash.
   */
  async detail(
    tenantId: string,
    workItemId: string,
    viewer?: string | null,
  ): Promise<WorkItemDetail> {
    const record = await this.deps.items.findRecord(tenantId, workItemId);
    if (!record) throw new WorkItemNotFound(workItemId);
    const reviews = await this.deps.approvals.listForWorkItem(tenantId, workItemId);
    return {
      record,
      checklist: await this.deps.items.listChecklist(tenantId, workItemId),
      // ONE QUERY FOR THIS ITEM, not the firm's whole edge list filtered in
      // memory. `listAllDependencies` exists for the cycle walk, which genuinely
      // needs every edge; a detail read that borrowed it grew with the firm.
      dependencies: await this.deps.items.listDependenciesFor(tenantId, workItemId),
      reviews,
      openReviewViewer: await this.verdictOnOpenReview(tenantId, reviews, viewer ?? null),
    };
  }

  /**
   * The queue's verdict, about this item's open review.
   *
   * IT IS THE QUEUE'S OWN CODE and not a second copy of it — `isEligible`, the
   * PINNED policy and `INELIGIBILITY_MESSAGES` are exactly what `pendingChecks`
   * uses. A second implementation of "who may check whose work" is the thing
   * this module has already refused twice (T2.9's rule is imported rather than
   * rewritten), and it would drift the first time a firm changed its policy.
   */
  private async verdictOnOpenReview(
    tenantId: string,
    reviews: readonly WorkItemCheck[],
    viewer: string | null,
  ): Promise<WorkItemDetail["openReviewViewer"]> {
    const open = reviews.find((r) => r.approval.decision === "pending");
    if (open === undefined) return null;

    const staff = await this.deps.reviewers.activeStaff(tenantId);
    const me =
      viewer === null
        ? undefined
        : (await this.candidates(tenantId, staff)).find((c) => c.userId === viewer);
    const policy = await this.pinnedPolicyOf(tenantId, open.approval);
    // Not on the active roster at all. Their session resolved, so they hold a
    // membership; this is the deactivated-between-requests case, and the honest
    // answer is the one `decideReview` would give them.
    const verdict =
      me === undefined
        ? { eligible: false, reason: "NO_WORK_PERMISSION" as const }
        : isEligible(me, this.makerOf(open.approval, staff), policy);
    return {
      eligible: verdict.eligible,
      reason: verdict.reason === null ? null : INELIGIBILITY_MESSAGES[verdict.reason],
    };
  }

  /**
   * Everything waiting to be checked at this firm, oldest first — with the
   * VIEWER's own verdict on every row.
   *
   * THE WHOLE FIRM'S, and the verdict rides on the row rather than filtering
   * the list. Under a rank threshold there is no "mine" — any Manager may take
   * any of it — and a queue narrowed to what you personally may act on hides
   * the one fact it exists to show: that six tasks have waited a week because
   * nobody senior enough has looked.
   *
   * The verdict is here rather than left to the screen for the reason every
   * other read model in this file is: a queue of thirty rows asking
   * `/checkers` thirty times is the per-row join this codebase has been caught
   * by five times, and it would also ask a question the screen does not need —
   * `/checkers` answers it for the whole roster, and a row needs one person.
   *
   * The REASON is the sentence, not the code, because that is what this
   * module's `/checkers` already returns and the two must not say the same
   * refusal in two different sets of words.
   */
  async pendingChecks(
    tenantId: string,
    viewer: string | null,
  ): Promise<readonly WorkItemCheckOnDesk[]> {
    const pending = await this.deps.approvals.listPending(tenantId);
    if (pending.length === 0) return [];

    // The roster and every role's permissions resolve ONCE for the whole
    // queue. The policy still resolves per row, because each row pins its own
    // version and two rows can honestly have been opened under different ones
    // — which is exactly what a firm that revised its rule this week produces.
    const staff = await this.deps.reviewers.activeStaff(tenantId);
    const me =
      viewer === null
        ? undefined
        : (await this.candidates(tenantId, staff)).find((c) => c.userId === viewer);

    const out: WorkItemCheckOnDesk[] = [];
    for (const row of pending) {
      const policy = await this.pinnedPolicyOf(tenantId, row.approval);
      // Not on the active roster at all. Their session resolved, so they hold
      // a membership; this is the deactivated-between-requests case, and the
      // honest answer is the same one `decideReview` gives them.
      const verdict =
        me === undefined
          ? { eligible: false, reason: "NO_WORK_PERMISSION" as const }
          : isEligible(me, this.makerOf(row.approval, staff), policy);
      out.push({
        ...row,
        viewer: {
          eligible: verdict.eligible,
          reason: verdict.reason === null ? null : INELIGIBILITY_MESSAGES[verdict.reason],
        },
      });
    }
    return out;
  }

  // ── creating ─────────────────────────────────────────────────────────────

  /**
   * Raise a work item by hand — ad hoc work, which is real work.
   *
   * The assignee is either named by the caller or ROUTED: with no name given,
   * the client's Dept SPOC is looked up the same way a spawned filing's is,
   * except that a hand-raised item has no service and therefore no Dept, so the
   * lookup has nothing to join on and the item is created unassigned with a
   * note saying so. That is honest rather than clever: routing needs a Dept,
   * and ad hoc work does not have one until somebody says which.
   */
  async create(input: CreateWorkItemInput, actor: Actor): Promise<WorkItem> {
    const title = input.title.trim();
    if (title.length === 0) throw new WorkItemTitleRequired();

    const client = await this.deps.clients.findParty(input.tenantId, input.clientPartyId);
    if (!client) throw new WorkItemClientNotFound(input.clientPartyId);
    if (client.archivedAt !== null) throw new WorkItemClientArchived(client.displayName);

    if (input.entityPartyId !== undefined && input.entityPartyId !== null) {
      const entity = await this.deps.clients.findParty(input.tenantId, input.entityPartyId);
      if (!entity) throw new WorkItemClientNotFound(input.entityPartyId);
    }

    const dueOn = input.dueOn ?? null;
    if (dueOn !== null && !isIsoDate(dueOn)) throw new InvalidDueDate(dueOn);

    const isStatutoryDue = input.isStatutoryDue ?? false;
    const state = await this.requireInitialState(input.tenantId);
    const priority =
      input.priorityId !== undefined
        ? await this.requireAssignablePriority(input.tenantId, input.priorityId)
        : await this.requireDefaultPriority(input.tenantId, isStatutoryDue);

    let assigneeUserId: string | null = null;
    let assignmentNote: string | null = null;
    if (input.assigneeUserId !== undefined && input.assigneeUserId !== null) {
      await this.requireStaff(input.tenantId, input.assigneeUserId);
      assigneeUserId = input.assigneeUserId;
    } else {
      assignmentNote =
        `Raised by hand with no Dept, so there was nothing to route on. Pick somebody, or ` +
        `raise it from an engagement and the client's Dept SPOC gets it automatically.`;
    }

    const item = await this.deps.items.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      clientPartyId: input.clientPartyId,
      entityPartyId: input.entityPartyId ?? null,
      engagementId: null,
      jobId: null,
      serviceVersionId: null,
      deptAxisId: null,
      title,
      description: input.description ?? null,
      stateId: state.id,
      priorityId: priority.id,
      assigneeUserId,
      assignmentNote,
      dueOn,
      isStatutoryDue,
      slaDaysSnapshot: null,
      // HIDDEN FROM THE CLIENT UNLESS SOMEBODY SAYS OTHERWISE (V1.4). A task
      // raised by hand is as often an internal note ("chase Ravi for the
      // ledger") as client work, and the portal is somebody else's screen: a
      // default of `true` put every such note in front of the client unless the
      // person raising it remembered to untick a box. Spawned monthly work and
      // statutory tasks set `true` themselves, below, and are unaffected.
      isClientVisible: input.isClientVisible ?? false,
    } satisfies NewWorkItem);

    await this.recordCreated(item, actor, "manual");
    return item;
  }

  /**
   * THE ACCEPTANCE LINE: turn engagements into work that arrives pre-assigned
   * to the client's Dept SPOC.
   *
   * Called by the scheduler as it spawns or extends a job — one trigger, one
   * pass, with the engagement already in hand. Satisfies the
   * `WorkItemSpawner` port that use case declares in its own vocabulary, so
   * neither imports the other.
   *
   * IDEMPOTENT, structurally. Every route into the sweep is at-least-once — a
   * redelivered pg-boss message, a restarted worker, a replayed activation —
   * and `createIfAbsentForEngagement` turns the second attempt into a null the
   * loop skips. A second work item would be a second task on somebody's desk
   * for work already being done, and nothing on the screen could tell them
   * apart.
   *
   * Returns how many were actually created, for the sweep's log.
   *
   * ── WITH A PERIOD, IT IS ONE MONTH'S TASK (T6.13) ─────────────────────────
   *
   * A per-period job hands over the period it is for, and three things change
   * and nothing else: the title names the period ("Bookkeeping — Sep 2026"),
   * the turnaround counts from the period's END rather than from signing —
   * which for a month-aligned period is exactly "by the Nth of the following
   * month", the firm's own words — and the calendar-coverage question becomes
   * the narrower one `filingEngagements` documents. Routing, priority, the
   * statutory flag and the SLA snapshot are the same fact either way.
   */
  async spawnForEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    actor: Actor,
    period?: SpawnPeriod,
  ): Promise<number> {
    if (engagementIds.length === 0) return 0;

    // Read once, outside the loop. A partner editing the vocabulary halfway
    // through a sweep must not give two filings from one letter two different
    // starting states.
    const state = await this.requireInitialState(tenantId);
    const priorities = await this.deps.vocabulary.listPriorities(tenantId);
    const work = await this.deps.engagements.workFor(tenantId, engagementIds);

    // WHERE THE COMPLIANCE CALENDAR OWNS THE DESK, THIS DOES NOT (T3.2).
    //
    // A recurring engagement gets one task PER PERIOD from the calendar, each
    // with its own statutory date. One more here, due `effective_from +
    // slaDays` and never completable, would be a thirteenth row on the board
    // that nobody can tell from a real one. See `ObligationCoverage` for why
    // this is derived rather than a flag — the short version is that a wrong
    // flag means silence, and a derived miss means today's behaviour.
    //
    // A PERIOD task asks the narrower question. Its row is completable and
    // dated, so the thirteenth-row argument does not apply; what would be
    // wrong is skipping September's bookkeeping because the company files GST,
    // or because the bookkeeping service itself carries TDS: a service with a
    // process of its own keeps its month's task, and only a service that IS
    // its filings is skipped (`filingEngagements`, the T6.16 follow-up).
    const covered = period
      ? await this.deps.obligations.filingEngagements(tenantId, engagementIds)
      : await this.deps.obligations.coveredEngagements(tenantId, engagementIds);

    // WHO OWNS IT IS ASKED ON THE FIRM'S TODAY, the day the work is created,
    // and the day the job's steps ask on (2026-09-27). Asking on the
    // engagement's first day instead put a task and its steps on different
    // desks whenever the account team was named after that day, which the
    // book import does every time (the team from today, the engagement from
    // the paper letter's date), and handed November's task to September's SPOC
    // after a handover. A SPOC named from a later day is still not today's.
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));

    let created = 0;
    for (const w of work) {
      if (covered.has(w.engagementId)) continue;
      // Statutory work is what a STATUTE dates, and an engagement's SLA is the
      // firm's own promise. So a work item spawned from an engagement is NOT
      // statutory — T3.2's obligations are what set that flag, from the law.
      // Defaulting it true here would put every piece of advisory work on the
      // statutory priority and make the flag meaningless the day it matters.
      const priority = defaultPriorityFor(priorities, false);
      if (!priority) throw new NoDefaultPriority();

      const routing = await this.routeOwner(tenantId, w.clientPartyId, w.deptCode, today);

      const item = await this.deps.items.createIfAbsentForEngagement({
        id: this.deps.ids.newId(),
        tenantId,
        clientPartyId: w.clientPartyId,
        entityPartyId: w.entityPartyId,
        engagementId: w.engagementId,
        jobId,
        serviceVersionId: w.serviceVersionId,
        deptAxisId: routing.axisId,
        // The period in the title, because "Bookkeeping" twelve times on one
        // desk is twelve rows nobody can tell apart. The title is prose the
        // moment somebody edits it and stays off the ledger either way.
        title: period ? `${w.serviceName} · ${period.label}` : w.serviceName,
        description: null,
        stateId: state.id,
        priorityId: priority.id,
        assigneeUserId: routing.outcome.userId,
        assignmentNote: routing.outcome.note,
        // From the END of the period for a month's task, from SIGNING for a
        // one-time one. Same field, same snapshot; the clock starts at the
        // event that makes sense for the work.
        dueOn: dueOnFrom(period ? period.end : w.effectiveFrom, w.slaDays),
        isStatutoryDue: false,
        // The SLA in force AT CREATION, copied. A later catalogue revision must
        // not make finished work retroactively late — G2.3's whole argument.
        slaDaysSnapshot: w.slaDays,
        isClientVisible: true,
      } satisfies NewWorkItem);

      // Null means one already exists for this engagement on this job: a
      // redelivery, and the correct answer is to do nothing and record nothing.
      if (!item) continue;
      created += 1;
      await this.recordCreated(item, actor, "engagement");
      if (item.assigneeUserId !== null) await this.recordAssigned(item, actor, routing.outcome.how ?? "spoc");
    }
    return created;
  }

  /**
   * Raise the task an OBLIGATION is owed — the `WorkItemRaiser` port T3.2 calls
   * at T–X.
   *
   * THE ONE PLACE THE CALENDAR AND THE WORK BOARD MEET. The obligation is what
   * the law asks of the entity; this is what somebody at the firm must do about
   * it, and keeping them two tables is what lets the calendar be generated at
   * all (migration 0052 argues it).
   *
   * `isStatutoryDue` is TRUE here and false on `spawnForEngagements`, and that
   * asymmetry is the flag's whole purpose: a statute set this date, so the
   * firm's own rule — *"due dates that are statutory should anyway be high
   * priority"* — applies, mechanically, without anybody remembering to set it.
   *
   * The due date is the STATUTORY one, never the internal target. The target is
   * only what caused the task to appear this early; the law is what it is due
   * by, and showing the earlier date as the deadline would make every filing
   * look late a fortnight before it was.
   *
   * Routing reuses the engagement's own account team, so an obligation lands on
   * the same desk the engagement would have — and refuses to guess in exactly
   * the same way, with the same sentence, because a wrong assignee is worse
   * than none.
   */
  async raiseForObligation(
    tenantId: string,
    input: {
      readonly entityPartyId: string;
      readonly engagementId: string | null;
      readonly title: string;
      readonly description: string | null;
      readonly dueOn: string;
    },
    actor: Actor,
  ): Promise<string> {
    const state = await this.requireInitialState(tenantId);
    const priority = await this.requireDefaultPriority(tenantId, true);

    // The engagement carries the client, the Dept and the pinned service. An
    // obligation with no engagement is representable (0053 keeps the column
    // nullable for the compliance-engine reading) and lands on the entity with
    // no Dept to route on — visibly unassigned rather than guessed at.
    const work =
      input.engagementId === null
        ? []
        : await this.deps.engagements.workFor(tenantId, [input.engagementId]);
    const w = work[0];

    const clientPartyId = w?.clientPartyId ?? input.entityPartyId;
    const routing = await this.routeOwner(
      tenantId,
      clientPartyId,
      w?.deptCode ?? null,
      input.dueOn,
    );

    const item = await this.deps.items.create({
      id: this.deps.ids.newId(),
      tenantId,
      clientPartyId,
      entityPartyId: input.entityPartyId,
      // NOT linked to the engagement, and this is load-bearing:
      // `idx_work_item_one_per_engagement` allows ONE work item per engagement,
      // which is exactly right for the engagement's own task and exactly wrong
      // for twelve monthly filings under one engagement. The obligation row is
      // what ties this task to its engagement — `obligation_instance` carries
      // both — so nothing is lost and the unique index stays meaningful.
      engagementId: null,
      jobId: null,
      serviceVersionId: w?.serviceVersionId ?? null,
      deptAxisId: routing.axisId,
      title: input.title,
      description: input.description,
      stateId: state.id,
      priorityId: priority.id,
      assigneeUserId: routing.outcome.userId,
      assignmentNote: routing.outcome.note,
      dueOn: input.dueOn,
      isStatutoryDue: true,
      // No SLA snapshot. The firm's turnaround promise is about work it agreed
      // to do; this date came from a statute, and copying an SLA onto it would
      // make a filing look late against a commitment nobody made about it.
      slaDaysSnapshot: null,
      isClientVisible: true,
    } satisfies NewWorkItem);

    await this.recordCreated(item, actor, "obligation");
    if (item.assigneeUserId !== null) await this.recordAssigned(item, actor, routing.outcome.how ?? "spoc");
    return item.id;
  }

  // ── changing ─────────────────────────────────────────────────────────────

  async update(input: UpdateWorkItemInput, actor: Actor): Promise<WorkItem> {
    const item = await this.requireItem(input.tenantId, input.workItemId);

    if (input.title !== undefined && input.title.trim().length === 0) {
      throw new WorkItemTitleRequired();
    }
    if (input.dueOn !== undefined && input.dueOn !== null && !isIsoDate(input.dueOn)) {
      throw new InvalidDueDate(input.dueOn);
    }
    if (input.priorityId !== undefined) {
      await this.requireAssignablePriority(input.tenantId, input.priorityId);
    }

    // Absent fields are resolved to their current values HERE rather than in
    // the adapter, which is this codebase's convention (`StaffGradeService`):
    // the SQL is then one statement with no branch per column.
    const patch = {
      title: input.title === undefined ? item.title : input.title.trim(),
      description: input.description === undefined ? item.description : input.description,
      priorityId: input.priorityId ?? item.priorityId,
      dueOn: input.dueOn === undefined ? item.dueOn : input.dueOn,
      isClientVisible: input.isClientVisible ?? item.isClientVisible,
    };
    const changed =
      patch.title !== item.title ||
      patch.description !== item.description ||
      patch.priorityId !== item.priorityId ||
      patch.dueOn !== item.dueOn ||
      patch.isClientVisible !== item.isClientVisible;
    if (!changed) return item;

    const updated = await this.deps.items.update(input.tenantId, item.id, patch);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item.updated",
      objectId: item.id,
      actor,
      // Machine facts, and both sides of each. A moved DUE DATE is the one that
      // matters: "why was this late" is answered by somebody having moved it,
      // and a payload that only said "it was edited" could not answer it. The
      // TITLE and DESCRIPTION are prose a person wrote about a client's work
      // and stay off this log, which cannot be erased — that a title changed is
      // recorded, what it changed to is not.
      payload: {
        ...(patch.title === item.title ? {} : { titleChanged: true }),
        ...(patch.description === item.description ? {} : { descriptionChanged: true }),
        ...(patch.priorityId === item.priorityId
          ? {}
          : { priorityFrom: item.priorityId, priorityTo: patch.priorityId }),
        ...(patch.dueOn === item.dueOn ? {} : { dueOnFrom: item.dueOn, dueOnTo: patch.dueOn }),
        ...(patch.isClientVisible === item.isClientVisible
          ? {}
          : { isClientVisible: patch.isClientVisible }),
      },
    });
    return updated;
  }

  /**
   * Move a work item to another of the firm's states.
   *
   * Everything the database will demand of the row is computed HERE and written
   * in one statement, because 0051's trigger refuses a row whose state and
   * timestamps disagree. Three facts follow from the target state's FLAGS and
   * never from its name:
   *
   *   isBlocked   a reason is mandatory, and `blockedAt` is stamped. The
   *               capture-or-lose pair, taken at the one moment the answer is
   *               still obvious to everybody.
   *   not blocked the pair is CLEARED. Leaving a block must not leave a stale
   *               sentence on running work; the history is in the ledger, which
   *               is the thing that cannot be edited.
   *   isTerminal  `completedAt` is stamped, and cleared again on the way back
   *               when work is reopened.
   *
   * And one rule that is not about timestamps: STARTING is refused while the
   * item is still waiting on unfinished work. That is what a dependency SAYS —
   * "this cannot start until that is finished" — so it is enforced rather than
   * displayed. Moving straight to a terminal state is allowed: cancelling
   * something that never started is a real act, and refusing it would trap the
   * item.
   */
  async moveToState(input: MoveStateInput, actor: Actor): Promise<WorkItem> {
    const item = await this.requireItem(input.tenantId, input.workItemId);
    const from = await this.requireStateRow(input.tenantId, item.stateId);
    const to = await this.requireStateRow(input.tenantId, input.stateId);

    if (to.id === from.id) throw new WorkItemAlreadyInState(to.name);
    if (!to.isActive) throw new StateRetired(to.name);

    const reason = (input.blockedReason ?? "").trim();
    if (to.isBlocked && reason.length === 0) throw new BlockReasonRequired(to.name);

    if (from.isInitial && !to.isTerminal) {
      const blockers = await this.deps.items.openBlockers(input.tenantId, item.id);
      if (blockers.length > 0) {
        throw new WorkItemBlockedByDependency(blockers.map((b) => b.title));
      }
    }

    const now = this.deps.clock.now().toISOString();
    const updated = await this.deps.items.setState(input.tenantId, item.id, {
      stateId: to.id,
      blockedReason: to.isBlocked ? reason : null,
      blockedAt: to.isBlocked ? now : null,
      // Set once, on the first move out of the starting state, and never
      // cleared afterwards: "when did somebody first pick this up" is a fact
      // that stays true even if the work is later reopened.
      startedAt: item.startedAt ?? (from.isInitial ? now : null),
      completedAt: to.isTerminal ? (item.completedAt ?? now) : null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item.state_changed",
      objectId: item.id,
      actor,
      // Ids and machine facts. The block REASON is deliberately absent: it is
      // prose a person wrote, it routinely names a client or a colleague, and
      // this log cannot be erased. The row keeps it where it can be.
      payload: {
        fromStateId: from.id,
        toStateId: to.id,
        isBlocked: to.isBlocked,
        isTerminal: to.isTerminal,
        // What tells a completion from a cancellation, which `isTerminal` alone
        // cannot. Carried here so the log answers "what did we abandon" as well
        // as "what did we finish", without a verb of its own.
        isSuccess: to.isSuccess,
      },
    });

    // A separate, registered verb, because "what did we finish last month" is a
    // question somebody asks of the log and a generic state change cannot
    // answer it without knowing which states were terminal at the time.
    //
    // TERMINAL AND SUCCESSFUL (0054). This fired on any terminal state until
    // the flag existed, so cancelling a task counted as finishing it — and the
    // verb's own description is "what did we finish last month", which a
    // cancellation is not an answer to. The state change is still recorded
    // above, carrying `isSuccess`, so "what did we abandon" is answerable too.
    if (to.isTerminal && to.isSuccess && !(from.isTerminal && from.isSuccess)) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "work_item.completed",
        objectId: item.id,
        actor,
        payload: { stateId: to.id, clientPartyId: item.clientPartyId },
      });
    }

    // AND THE CALENDAR. If this item was raised for an obligation, the
    // obligation is filed — or, moving the other way, un-filed. Called on EVERY
    // move rather than only on the interesting ones, because the port
    // reconciles rather than transitions and the current answer is all it
    // needs; see `ObligationFiling`.
    //
    // After the move has been written, deliberately. The two are not in one
    // transaction, so the order decides which way a failure between them falls:
    // this way the task is done and the calendar has not caught up, which is
    // visible and recoverable. The reverse would record a filing for work the
    // board still shows as running.
    await this.deps.filings.reconcileFiling(
      input.tenantId,
      item.id,
      to.isTerminal && to.isSuccess,
      actor,
    );
    return updated;
  }

  /** Put it on somebody's desk, or take it off. Taking it off records WHY as a
   *  note, so the unassigned queue stays readable rather than becoming a pile
   *  of rows with no explanation. */
  /**
   * Put a task on somebody's desk, or take it off.
   *
   * AND THE JOB'S STEPS GO WITH IT (2026-09-27). A fallback owner (the Key
   * Manager, the signing partner) receives a job's task to hand out, and the
   * firm's rule is that handing out the TASK hands out the job: its steps
   * nobody holds, or that the task's previous owner held, move to the new
   * owner wherever the process lets that person do them. Only when every open
   * task of the job is now on that one desk, so a job whose tasks sit with two
   * people (a client keeping FRC and TRC work together) keeps its steps where
   * they are for somebody to hand out one by one. `stepsHandedOver` says how
   * many moved, so the screen can say so.
   */
  async assign(
    input: AssignWorkItemInput,
    actor: Actor,
  ): Promise<{ readonly item: WorkItem; readonly stepsHandedOver: number }> {
    const item = await this.requireItem(input.tenantId, input.workItemId);
    if (input.assigneeUserId !== null) {
      await this.requireStaff(input.tenantId, input.assigneeUserId);
    }
    if (item.assigneeUserId === input.assigneeUserId) return { item, stepsHandedOver: 0 };

    const updated = await this.deps.items.setAssignee(
      input.tenantId,
      item.id,
      input.assigneeUserId,
      input.assigneeUserId === null ? TAKEN_OFF_BY_HAND_NOTE : null,
    );
    await this.recordAssigned(updated, actor, "manual");

    let stepsHandedOver = 0;
    const to = input.assigneeUserId;
    if (to !== null && updated.jobId !== null) {
      const open = await this.deps.items.list(input.tenantId, { jobId: updated.jobId, openOnly: true });
      if (open.every((t) => t.item.assigneeUserId === to)) {
        stepsHandedOver = await this.deps.jobSteps.adoptUnheldSteps(
          input.tenantId,
          updated.jobId,
          item.assigneeUserId,
          to,
          actor,
        );
      }
    }
    return { item: updated, stepsHandedOver };
  }

  /**
   * THE CATCH-UP (T6.17, Shrestha 2026-09-27): a client's account team was
   * named after its work was created, so the work the router could only put on
   * a fallback desk, or on nobody's, goes where the owner rule now says.
   *
   * The engine asks who owns a task ONCE, when it creates it. A letter signed
   * before anybody was named SPOC (the book import does this every time: the
   * paper letter first, the team afterwards) left its work with the Key
   * Manager to hand out, or with nobody, and naming the SPOC afterwards moved
   * none of it. This runs when somebody is named on the client's account team
   * (`ClientAssignmentService.assign`, through a port wired in `setup/`).
   *
   * WHAT MOVES is only what nobody has decided about: engine work, not
   * started, still carrying the router's note (`listCatchUpCandidates`). A
   * task a person handed on, took off a desk, or started stays where it is;
   * so does anything a SPOC already holds, which is why naming a new SPOC
   * beside an old one moves none of the old one's work. A new Key Manager
   * DOES take over the tasks the outgoing one was holding to hand out: they
   * carry the router's note, the outgoing Key Manager no longer holds the
   * client, and the owner rule now names the new one (Shrestha, 2026-09-27).
   * Each task is asked the owner rule's own question again (`routeOwner`, on
   * the day its creator asked: the firm's today, or a filing's due date while
   * it is still ahead), and `catchUpMove` says what the new answer means.
   *
   * THE STEPS GO WITH THE TASK exactly as they do when a person hands it on
   * (`assign`): once every open task of the job sits on the new desk, the
   * steps nobody holds, or the previous holder held, move within the band.
   *
   * Each move is its own conditional write (`reroute`), so a colleague who
   * handed the task out a moment ago keeps it. Recorded as
   * `work_item.assigned` with the rung that answered and `catchUp: true`.
   */
  async catchUpClient(tenantId: string, clientPartyId: string, actor: Actor): Promise<CaughtUpWork> {
    const candidates = await this.deps.items.listCatchUpCandidates(
      tenantId,
      clientPartyId,
      TAKEN_OFF_BY_HAND_NOTE,
    );
    if (candidates.length === 0) return { moves: [] };

    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const engagementIds = [
      ...new Set(candidates.map((c) => c.engagementId).filter((id): id is string => id !== null)),
    ];
    const work = new Map(
      (await this.deps.engagements.workFor(tenantId, engagementIds)).map((w) => [w.engagementId, w]),
    );

    const tally = new Map<string, { tasks: number; steps: number }>();
    const count = (userId: string): { tasks: number; steps: number } => {
      const hit = tally.get(userId) ?? { tasks: 0, steps: 0 };
      tally.set(userId, hit);
      return hit;
    };
    // The jobs a moved task belongs to, and whose desk it came off: the steps
    // are asked about once per job, after all of its tasks have moved.
    const jobs = new Map<string, { to: string; from: Set<string | null> }>();

    for (const c of candidates) {
      const w = c.engagementId === null ? undefined : work.get(c.engagementId);
      const onDate = c.isFiling && c.dueOn !== null && c.dueOn > today ? c.dueOn : today;
      const routing = await this.routeOwner(tenantId, clientPartyId, w?.deptCode ?? null, onDate);
      const decision = catchUpMove(c, routing.outcome);
      if (decision === null) continue;
      const holder = decision.kind === "move" ? decision.userId : c.assigneeUserId;
      // `renote` only ever keeps a desk somebody holds (`catchUpMove`).
      if (holder === null) continue;
      const moved = await this.deps.items.reroute(
        tenantId,
        c.workItemId,
        { assigneeUserId: c.assigneeUserId, note: c.assignmentNote },
        { assigneeUserId: holder, note: decision.note },
      );
      if (moved === null || decision.kind === "renote") continue;
      await this.recordAssigned(moved, actor, decision.how, {
        catchUp: true,
        fromUserId: c.assigneeUserId,
      });
      count(decision.userId).tasks += 1;
      if (moved.jobId !== null) {
        const job = jobs.get(moved.jobId) ?? { to: decision.userId, from: new Set<string | null>() };
        job.to = decision.userId;
        job.from.add(c.assigneeUserId);
        jobs.set(moved.jobId, job);
      }
    }

    for (const [jobId, job] of jobs) {
      const open = await this.deps.items.list(tenantId, { jobId, openOnly: true });
      if (!open.every((t) => t.item.assigneeUserId === job.to)) continue;
      // One previous desk is the one whose steps may follow; tasks that came
      // off two desks leave both people's steps where they are.
      const from = job.from.size === 1 ? ([...job.from][0] ?? null) : null;
      count(job.to).steps += await this.deps.jobSteps.adoptUnheldSteps(tenantId, jobId, from, job.to, actor);
    }

    return {
      moves: [...tally].map(([userId, n]) => ({ userId, tasks: n.tasks, steps: n.steps })),
    };
  }

  /**
   * WHOSE DESK A LETTER'S WORK WILL LAND ON, before it is signed (T6.17).
   *
   * The warning on an unsigned letter's Send: a Dept with no SPOC on this
   * client sends its work to the Key Manager, or to the person who signs for
   * the firm, to hand out, and the person sending should know that while the
   * account team can still be set. A warning, never a refusal (2026-09-27).
   *
   * The SAME question the router asks when the signed letter becomes work
   * (`routeOwner`, with the facts `LetterWorkSource` reads the way
   * `EngagementWorkSource` does), asked for today. One row per Dept, in the
   * order its first line appears on the letter.
   */
  async routingForLetter(tenantId: string, letterId: string): Promise<LetterRouting> {
    const letter = await this.deps.letters.linesOf(tenantId, letterId);
    if (letter === null) throw new RoutingLetterNotFound(letterId);
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));

    const byDept = new Map<string | null, { lineId: string; name: string }[]>();
    for (const line of letter.lines) {
      const group = byDept.get(line.deptCode) ?? [];
      group.push({ lineId: line.lineId, name: line.name });
      byDept.set(line.deptCode, group);
    }

    const depts: LetterDeptRouting[] = [];
    for (const [deptCode, lines] of byDept) {
      const routing = await this.routeOwner(tenantId, letter.clientPartyId, deptCode, today);
      const lookup = routing.noLookup;
      depts.push({
        deptCode,
        deptName: routing.deptName,
        lines,
        how: routing.outcome.how,
        userId: routing.outcome.userId,
        ownerName: routing.ownerName,
        reason:
          routing.outcome.how === "spoc"
            ? null
            : lookup === null
              ? "no_spoc"
              : lookup.kind === "unknown_dept"
                ? "unknown_dept"
                : "no_dept",
      });
    }
    return { letterId, clientPartyId: letter.clientPartyId, onDate: today, depts };
  }

  // ── the checklist ────────────────────────────────────────────────────────

  async addChecklistItem(
    tenantId: string,
    workItemId: string,
    label: string,
    sortOrder?: number,
  ): Promise<ChecklistItem> {
    await this.requireItem(tenantId, workItemId);
    if (label.trim().length === 0) throw new WorkItemTitleRequired();
    const existing = await this.deps.items.listChecklist(tenantId, workItemId);
    return this.deps.items.addChecklistItem({
      id: this.deps.ids.newId(),
      tenantId,
      workItemId,
      label: label.trim(),
      // Appended by default, in tens so a firm can slot one between two later
      // without renumbering — the same reason `sort_order` is not contiguous.
      sortOrder: sortOrder ?? (existing.length + 1) * 10,
    });
  }

  /**
   * Tick or untick a line.
   *
   * No ledger event, deliberately. A checklist tick is not a state transition
   * of the business — it is somebody's working note on their own task, and the
   * row already carries who and when. Recording twelve events per filing would
   * bury the transitions that matter in a log that cannot be pruned.
   */
  async setChecklistDone(
    tenantId: string,
    checklistItemId: string,
    done: boolean,
    userId: string,
  ): Promise<ChecklistItem> {
    const line = await this.deps.items.findChecklistItem(tenantId, checklistItemId);
    if (!line) throw new ChecklistItemNotFound(checklistItemId);
    if (done === (line.doneAt !== null)) return line;
    return this.deps.items.setChecklistDone(
      tenantId,
      checklistItemId,
      done ? this.deps.clock.now().toISOString() : null,
      done ? userId : null,
    );
  }

  /** Remove an UNTICKED line. A ticked one is refused here and by a trigger:
   *  the tick is the record that somebody did it, and it lives nowhere else. */
  async removeChecklistItem(tenantId: string, checklistItemId: string): Promise<void> {
    const line = await this.deps.items.findChecklistItem(tenantId, checklistItemId);
    if (!line) throw new ChecklistItemNotFound(checklistItemId);
    if (line.doneAt !== null) throw new ChecklistItemDone();
    await this.deps.items.removeChecklistItem(tenantId, checklistItemId);
  }

  // ── dependencies ─────────────────────────────────────────────────────────

  /**
   * "This cannot start until that is finished."
   *
   * The cycle check walks the whole edge list in the DOMAIN, because
   * reachability is not expressible in a CHECK constraint — the database
   * catches only the self-edge. A cycle that got in would produce work nothing
   * can ever start, with nothing on the screen saying why.
   */
  async addDependency(
    tenantId: string,
    workItemId: string,
    dependsOnWorkItemId: string,
    actor: Actor,
  ): Promise<WorkItemDependency> {
    await this.requireItem(tenantId, workItemId);
    await this.requireItem(tenantId, dependsOnWorkItemId);

    const edges = await this.deps.items.listAllDependencies(tenantId);
    if (
      edges.some(
        (e) => e.workItemId === workItemId && e.dependsOnWorkItemId === dependsOnWorkItemId,
      )
    ) {
      throw new DependencyExists();
    }
    if (wouldCycle(edges, workItemId, dependsOnWorkItemId)) throw new DependencyCycle();

    const dep = await this.deps.items.addDependency({
      id: this.deps.ids.newId(),
      tenantId,
      workItemId,
      dependsOnWorkItemId,
    });
    await this.deps.events.recordEvent({
      tenantId,
      verb: "work_item.dependency_added",
      objectId: workItemId,
      actor,
      payload: { dependencyId: dep.id, dependsOnWorkItemId },
    });
    return dep;
  }

  /** Removing one is a normal act and the row carries no history of its own —
   *  but WHO removed the thing that was holding work back is worth keeping, so
   *  the event is recorded even though the row is not. */
  async removeDependency(
    tenantId: string,
    dependencyId: string,
    actor: Actor,
  ): Promise<void> {
    const dep = await this.deps.items.findDependency(tenantId, dependencyId);
    if (!dep) throw new DependencyNotFound(dependencyId);
    await this.deps.items.removeDependency(tenantId, dependencyId);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "work_item.dependency_removed",
      objectId: dep.workItemId,
      actor,
      payload: { dependencyId, dependsOnWorkItemId: dep.dependsOnWorkItemId },
    });
  }

  // ── review ───────────────────────────────────────────────────────────────

  /**
   * Send work to be checked.
   *
   * The MAKER is not a parameter and cannot be: the database derives it from
   * the item's assignee and freezes it. A maker the caller could choose is not
   * a maker-checker control, because the way past the constraint would be to
   * name somebody else as the maker and approve it yourself.
   *
   * ── AND IT MOVES THE STATE NOW, IF THE FIRM HAS SAID WHERE (0073) ───────
   *
   * It did not, and the reason written here was right: there was no flag saying
   * which of the firm's states means "with a checker", and comparing the code
   * is the one thing this module never does. The cost was found by using the
   * product — press this and the buttons become Approve / Send back while the
   * header goes on reading "In Progress", with the firm's own "Under Review"
   * sitting in the state dropdown as a second answer to the same question. On a
   * board organised BY STATE the task sat in the wrong column while somebody's
   * queue said it was theirs.
   *
   * So 0073 added the flag rather than this method reading a name.
   * `underReviewState` returns null for a firm that has not said, and null
   * keeps exactly the old behaviour — that is a supported answer, not a gap.
   *
   * THE MOVE IS AFTER THE APPROVAL, and the order is deliberate. Opening the
   * check is the act; the state is how the board renders it. A failed move
   * leaves an open review on work that still reads "In Progress", which is
   * where every firm was before this — survivable, and visible. The reverse
   * would move the task into a column meaning "somebody is checking this" with
   * nobody checking it.
   *
   * Three states are left alone, and each for its own reason: work already
   * THERE (nothing to do), work in a TERMINAL state (moving it out would clear
   * `completedAt` and reopen finished work as a side effect of asking for a
   * check), and the dependency rule, which is NOT applied — sending work to be
   * checked says the work has been done, and refusing to record that because a
   * dependency is open would be refusing a fact that has already happened.
   */
  async requestReview(input: RequestReviewInput, actor: Actor): Promise<WorkItemApproval> {
    const item = await this.requireItem(input.tenantId, input.workItemId);

    let policyVersionId: string | null = null;
    let policyKey: string | null = null;
    if (input.policyKey !== undefined && input.policyKey !== null && input.policyKey.length > 0) {
      const resolved = await this.deps.policies.publishedPolicy(
        input.tenantId,
        input.policyKey,
      );
      // A named rule the firm has not published is a refusal and not a silent
      // fall-through to "no rule": the caller asked for a particular bar, and
      // quietly opening the check without it would be this product lowering it.
      if (!resolved) throw new ReviewerNotEligible(
        `This firm has published no verification policy called ${JSON.stringify(input.policyKey)}. ` +
          `Publish it on the verification screen, or send the work for review with no ` +
          `particular rule — the maker still cannot be the checker.`,
      );
      policyVersionId = resolved.versionId;
      policyKey = resolved.key;
    }

    const approval = await this.deps.approvals.openIfAbsent({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      workItemId: item.id,
      policyVersionId,
      policyKey,
    });
    // Null means the unique partial index refused a second open check —
    // somebody clicked twice, or two people clicked together.
    if (!approval) throw new ReviewAlreadyOpen();

    const movedTo = await this.moveIntoReview(input.tenantId, item, actor);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "work_item.review_requested",
      objectId: approval.id,
      actor,
      payload: {
        workItemId: item.id,
        policyKey,
        policyVersionId,
        // Whether there is a maker AT ALL is the fact that decides whether
        // maker != checker can bite; the id itself is already on the row.
        hasMaker: approval.submittedBy !== null,
        // Null when the firm has named no "with a checker" state, or the item
        // was already in it, or it is finished. Recorded because "why did this
        // task not move" is asked of this trail, and the answer is a decision
        // the firm has or has not taken on its own vocabulary screen.
        movedToStateId: movedTo,
      },
    });
    return approval;
  }

  /**
   * Put the item in the firm's "with a checker" state, if it has one.
   *
   * Returns the state it moved to, or null when nothing moved — see
   * `requestReview` for which three cases those are and why each is left alone.
   *
   * It writes through the same `setState` the manual move uses rather than
   * calling `moveToState`, because that method refuses a move to the state the
   * item is already in (`WorkItemAlreadyInState`) — correct for somebody
   * pressing a dropdown, wrong for a side effect, where "it is already there"
   * is success. The timestamp rules are simpler here than there and 0073 is why:
   * the target can be neither blocked nor terminal nor initial, so the only one
   * that applies is `startedAt`, and only on the way out of the starting state.
   */
  private async moveIntoReview(
    tenantId: string,
    item: WorkItem,
    actor: Actor,
  ): Promise<string | null> {
    const to = underReviewState(await this.deps.vocabulary.listStates(tenantId));
    if (!to || to.id === item.stateId) return null;

    const from = await this.requireStateRow(tenantId, item.stateId);
    if (from.isTerminal) return null;

    const now = this.deps.clock.now().toISOString();
    await this.deps.items.setState(tenantId, item.id, {
      stateId: to.id,
      // Leaving a block is leaving a block, whichever door it goes out of: a
      // stale sentence on work that is now with a checker would be read as the
      // reason it is stuck. The ledger keeps what it said.
      blockedReason: null,
      blockedAt: null,
      startedAt: item.startedAt ?? (from.isInitial ? now : null),
      completedAt: null,
    });

    await this.deps.events.recordEvent({
      tenantId,
      verb: "work_item.state_changed",
      objectId: item.id,
      actor,
      payload: {
        fromStateId: from.id,
        toStateId: to.id,
        isBlocked: false,
        isTerminal: false,
        isSuccess: false,
        // What separates this row from a person choosing the state by hand.
        // The two are the same write and are not the same fact — "who moved
        // this and why" is exactly what an audit trail is read for.
        byReviewRequest: true,
      },
    });
    return to.id;
  }

  /**
   * Who may check this, and what to say to everybody who may not.
   *
   * The rule is T2.9's `isEligible`, unchanged — maker != checker first and
   * regardless of policy, then `work:write`, then the firm's own published
   * rule. One answer to "who checks whose work" at this firm, whether the work
   * is a process step or a task.
   */
  async eligibleCheckers(
    tenantId: string,
    approvalId: string,
  ): Promise<readonly CheckerOption[]> {
    const approval = await this.requireApproval(tenantId, approvalId);
    const policy = await this.pinnedPolicyOf(tenantId, approval);
    const staff = await this.deps.reviewers.activeStaff(tenantId);
    const maker = this.makerOf(approval, staff);
    const candidates = await this.candidates(tenantId, staff);

    return candidates.map((candidate) => {
      const verdict = isEligible(candidate, maker, policy);
      return {
        userId: candidate.userId,
        displayName: candidate.displayName,
        gradeName: candidate.gradeName,
        eligible: verdict.eligible,
        reason: verdict.reason === null ? null : INELIGIBILITY_MESSAGES[verdict.reason],
      };
    });
  }

  /**
   * Approve the work, or send it back.
   *
   * Two refusals before the write and both matter. Self-approval is refused
   * here so the answer is a sentence — but the CHECK constraint is what makes
   * it true for a script, an import or an agent that never reaches this code.
   * And a rejection with no note is refused because WHY work came back is the
   * only signal that ever explains rework; marking the task Completed later
   * erases the fact that it was rejected at all.
   */
  async decideReview(input: DecideReviewInput, actor: Actor): Promise<WorkItemApproval> {
    const approval = await this.requireApproval(input.tenantId, input.approvalId);
    if (approval.decision !== "pending") throw new ReviewAlreadyDecided(approval.decision);

    const notes = (input.notes ?? "").trim();
    if (input.decision === "rejected" && notes.length === 0) {
      throw new ReviewRejectionNeedsNote();
    }
    if (approval.submittedBy !== null && approval.submittedBy === input.decidedBy) {
      throw new ReviewSelfApproval();
    }

    const policy = await this.pinnedPolicyOf(input.tenantId, approval);
    const staff = await this.deps.reviewers.activeStaff(input.tenantId);
    const me = (await this.candidates(input.tenantId, staff)).find(
      (c) => c.userId === input.decidedBy,
    );
    // Not on the active roster at all. Their session resolved, so they hold a
    // membership; this is the deactivated-between-requests case, and it is a
    // refusal rather than a crash.
    if (!me) throw new AssigneeNotStaff(input.decidedBy);
    const verdict = isEligible(me, this.makerOf(approval, staff), policy);
    if (!verdict.eligible) {
      throw new ReviewerNotEligible(
        verdict.reason === null ? "You may not check this." : INELIGIBILITY_MESSAGES[verdict.reason],
      );
    }

    const decided = await this.deps.approvals.decide(input.tenantId, input.approvalId, {
      decision: input.decision,
      notes: notes.length > 0 ? notes : null,
      decidedBy: input.decidedBy,
      decidedAt: this.deps.clock.now().toISOString(),
    });
    // Null means somebody else decided it between the read and the write, and
    // their decision is the one that stands.
    if (!decided) throw new ReviewAlreadyDecided("decided by somebody else");

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb:
        input.decision === "approved" ? "work_item.review_approved" : "work_item.review_rejected",
      objectId: decided.id,
      actor,
      // The NOTE is not in the payload: it is prose a reviewer wrote about a
      // colleague's work, and this log cannot be erased. The row keeps it.
      payload: {
        workItemId: decided.workItemId,
        policyKey: decided.policyKey,
        hasMaker: decided.submittedBy !== null,
      },
    });
    return decided;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The server's calendar day — the fallback, never the answer when a caller
   * has one.
   *
   * THE SERVER'S "TODAY" IS NOT THE FIRM'S. The clock here is the process's,
   * which in production is UTC, and a firm in India is a day ahead of it every
   * morning until half past five. This product has already been bitten: a
   * client handed over at 04:11 was absent from its holder's own book because
   * the row started "tomorrow" as far as the server was concerned. Every path
   * a screen uses sends its own date; this is the honest fallback for an API
   * caller that did not say.
   */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }

  private async requireItem(tenantId: string, workItemId: string): Promise<WorkItem> {
    const item = await this.deps.items.findById(tenantId, workItemId);
    if (!item) throw new WorkItemNotFound(workItemId);
    return item;
  }

  private async requireStateRow(tenantId: string, stateId: string): Promise<WorkItemState> {
    const state = await this.deps.vocabulary.findState(tenantId, stateId);
    if (!state) throw new StateNotFound(stateId);
    return state;
  }

  private async requireInitialState(tenantId: string): Promise<WorkItemState> {
    const state = initialState(await this.deps.vocabulary.listStates(tenantId));
    if (!state) throw new NoInitialState();
    return state;
  }

  private async requireDefaultPriority(
    tenantId: string,
    isStatutoryDue: boolean,
  ): Promise<WorkItemPriority> {
    const priority = defaultPriorityFor(
      await this.deps.vocabulary.listPriorities(tenantId),
      isStatutoryDue,
    );
    if (!priority) throw new NoDefaultPriority();
    return priority;
  }

  private async requireAssignablePriority(
    tenantId: string,
    priorityId: string,
  ): Promise<WorkItemPriority> {
    const priority = await this.deps.vocabulary.findPriority(tenantId, priorityId);
    if (!priority) throw new PriorityNotFound(priorityId);
    if (!priority.isActive) throw new PriorityRetired(priority.name);
    return priority;
  }

  private async requireStaff(tenantId: string, userId: string): Promise<void> {
    if (!(await this.deps.staff.isActiveStaff(tenantId, userId))) {
      throw new AssigneeNotStaff(userId);
    }
  }

  /**
   * A service's Dept code, turned into the work's owner (2026-09-27).
   *
   * The facts are gathered here and the ladder is `resolveOwner`'s, the one
   * the job's step desk also calls: SPOC, then Key Manager, then the person
   * who signs for the firm, then nobody. Every rung past the first leaves a
   * sentence on the row saying why the work came to that desk and what would
   * send it straight to a SPOC next time.
   */
  private async routeOwner(
    tenantId: string,
    clientPartyId: string,
    deptCode: string | null,
    onDate: string,
  ): Promise<{
    readonly axisId: string | null;
    readonly deptName: string | null;
    readonly noLookup: NoSpocLookup | null;
    readonly outcome: OwnerOutcome;
    /** The person `outcome` names, as the directory has them. */
    readonly ownerName: string | null;
  }> {
    let axisId: string | null = null;
    let deptName: string | null = null;
    let noLookup: NoSpocLookup | null = null;
    let spocs: Awaited<ReturnType<SpocDirectory["spocsFor"]>> = [];
    if (deptCode === null) {
      noLookup = { kind: "no_dept" };
    } else {
      const axis = await this.deps.axes.findByCode(tenantId, "dept", deptCode);
      if (!axis) {
        noLookup = { kind: "unknown_dept", code: deptCode };
      } else {
        axisId = axis.id;
        deptName = axis.name;
        spocs = await this.deps.spocs.spocsFor(tenantId, clientPartyId, axis.id, onDate);
      }
    }
    // The later rungs are read only when the first one is empty: the common
    // case costs what it cost before.
    const needFallback = noLookup !== null || spocs.length === 0;
    const keyManager = needFallback
      ? await this.deps.owners.keyManagerFor(tenantId, clientPartyId, onDate)
      : null;
    const partner =
      needFallback && keyManager === null ? await this.deps.owners.signingPartner(tenantId) : null;
    const outcome = resolveOwner({ deptName, noLookup, spocs, keyManager, partner });
    const spoc = outcome.how === "spoc" ? spocs.find((p) => p.userId === outcome.userId) : undefined;
    const ownerName =
      spoc !== undefined
        ? (spoc.displayName ?? spoc.email)
        : outcome.how === "key_manager"
          ? (keyManager?.displayName ?? null)
          : outcome.how === "partner"
            ? (partner?.displayName ?? null)
            : null;
    return { axisId, deptName, noLookup, outcome, ownerName };
  }

  private async requireApproval(
    tenantId: string,
    approvalId: string,
  ): Promise<WorkItemApproval> {
    const approval = await this.deps.approvals.findById(tenantId, approvalId);
    if (!approval) throw new ReviewNotFound(approvalId);
    return approval;
  }

  /** What the check was OPENED under, whatever is in force now. Null when the
   *  row no longer parses as a policy — history that fails to read is a fact
   *  about the past, not today's rule applied retroactively. */
  private async pinnedPolicyOf(
    tenantId: string,
    approval: WorkItemApproval,
  ): Promise<VerificationPolicy | null> {
    if (approval.policyVersionId === null) return null;
    const resolved = await this.deps.policies.pinnedPolicy(tenantId, approval.policyVersionId);
    return resolved?.policy ?? null;
  }

  /**
   * The firm's staff as candidates, with `work:write` already resolved.
   *
   * Permissions are looked up ONCE PER ROLE rather than once per person: a
   * hundred-person firm has five roles, and the alternative is a hundred config
   * reads to render one screen — the per-row lookup this codebase has been
   * caught by five times. Identical in shape to the orchestrator's own
   * `candidates`, because it is the same question about the same people.
   */
  private async candidates(
    tenantId: string,
    staff: readonly ReviewerRow[],
  ): Promise<readonly CheckerCandidate[]> {
    const byRole = new Map<string, readonly string[]>();
    for (const role of new Set(staff.map((s) => s.role))) {
      byRole.set(role, await this.deps.permissions.permissionsFor(tenantId, role));
    }
    return staff.map((s) => ({
      userId: s.userId,
      displayName: s.displayName,
      gradeRank: s.gradeRank,
      gradeName: s.gradeName,
      // Checking somebody's work writes to the record of who did it, so it is
      // the same permission as doing it. This is the FLOOR the firm's own rule
      // then sits on top of — it closes the demo's Q41, where a read-only
      // Management membership carrying a Senior Manager grade would otherwise
      // pass a rank threshold and sign off a statutory filing.
      canWrite: (byRole.get(s.role) ?? []).includes("work:write"),
    }));
  }

  /**
   * The maker, with their own reporting line attached.
   *
   * The line travels WITH the maker rather than being looked up per candidate,
   * because the reporting-line rule asks "is this candidate the person the
   * MAKER reports to" — a fact about the maker. Comparing the other way round
   * is the maker-checker rule inverted, and would make exactly one person
   * eligible: the one who is always forbidden.
   *
   * Null when the item was unassigned when the check was opened. Then maker !=
   * checker is vacuous — there is no self to be — and a `reporting_line` policy
   * matches nobody, which the screen says out loud.
   */
  private makerOf(
    approval: WorkItemApproval,
    staff: readonly { readonly userId: string; readonly reportsToUserId: string | null }[],
  ): Maker | null {
    if (approval.submittedBy === null) return null;
    const row = staff.find((s) => s.userId === approval.submittedBy);
    return {
      userId: approval.submittedBy,
      // A maker who has since left the firm is off the active roster; their
      // reporting line is then unknown rather than absent, and null is the
      // honest value — a `reporting_line` policy matches nobody and says so.
      reportsToUserId: row?.reportsToUserId ?? null,
    };
  }

  private async recordCreated(
    item: WorkItem,
    actor: Actor,
    // `obligation` is T3.2's: a task the LAW caused, not the firm's own promise
    // or somebody typing. The three are genuinely different provenance and the
    // dashboards will want to tell them apart.
    origin: "manual" | "engagement" | "obligation",
  ): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId: item.tenantId,
      verb: "work_item.created",
      objectId: item.id,
      actor,
      // Ids and machine facts. The TITLE is absent: it is copied from a service
      // name today but is prose the moment somebody edits it, and it routinely
      // names a client ("Kaveri Foods — GST"). The assignment NOTE is absent
      // for the stronger reason that it names people.
      payload: {
        origin,
        clientPartyId: item.clientPartyId,
        entityPartyId: item.entityPartyId,
        engagementId: item.engagementId,
        jobId: item.jobId,
        stateId: item.stateId,
        priorityId: item.priorityId,
        dueOn: item.dueOn,
        isStatutoryDue: item.isStatutoryDue,
        slaDays: item.slaDaysSnapshot,
        assigned: item.assigneeUserId !== null,
      },
    });
  }

  private async recordAssigned(
    item: WorkItem,
    actor: Actor,
    how: OwnerSource | "manual",
    // The catch-up's two facts (T6.17): the router re-decided it after the
    // account team was named, and whose desk it came off.
    catchUp?: { readonly catchUp: true; readonly fromUserId: string | null },
  ): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId: item.tenantId,
      verb: "work_item.assigned",
      objectId: item.id,
      actor,
      // `how` is the fact worth keeping: "the router did this" and "a partner
      // overrode it" are different answers to the same later question, and
      // nothing else in the row distinguishes them.
      payload: {
        how,
        userId: item.assigneeUserId,
        deptAxisId: item.deptAxisId,
        clientPartyId: item.clientPartyId,
        ...(catchUp ?? {}),
      },
    });
  }
}
