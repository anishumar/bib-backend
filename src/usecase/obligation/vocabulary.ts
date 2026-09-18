// The firm's own words for its compliance calendar (T3.3).
//
// ── WHY THIS EXISTS, AND WHY IT DID NOT UNTIL NOW ──────────────────────────
//
// 0050 held the work board's states as rows so a firm could rename them, and
// `/admin/work-vocabulary` is where it does. 0052 held the OBLIGATION states as
// rows for the same reason and no screen was ever built, so the promise was
// only ever half kept: a firm could not rename "Missed", could not move a flag,
// and could not see what the flags meant. Every error message in this module
// that says "mark another state as the X one" was, until this file, describing
// a control nobody could reach.
//
// T3.3 is what forced it. It adds two flags and a whole new list, and shipping
// three more things a firm cannot edit would have made the gap worse rather
// than leaving it where it was.
//
// ── IT IS ITS OWN SERVICE, NOT PART OF `ObligationService` ─────────────────
//
// The work board keeps both in one file, and this deviates on size alone:
// `ObligationService` is already the generator, the raiser, the sweep and the
// decision queue. What is NOT duplicated is the meaning — the flags are read
// through the same `initialState` / `filedState` / `missedState` /
// `resolutionState` functions the rest of the module uses, so a rule and this
// screen cannot disagree about what a flag is.
//
// ── AND NOTHING HERE COMPARES A `code` EITHER ──────────────────────────────
//
// The temptation is strongest in this file, because it is the one place codes
// are handled at all. They are an identity to look a row up by and to keep
// unique; every decision below is made on a FLAG.
import {
  destinationOf,
  isValidVocabularyCode,
  normalizeVocabularyCode,
  type ObligationState,
  type ResolutionOption,
  type StateDestination,
} from "../../domain/obligation/model.js";
import {
  ConflictingStateFlags,
  InvalidRuleStatus,
  InvalidSortOrder,
  InvalidVocabularyCode,
  LastDestinationState,
  LastInitialState,
  ResolutionOptionNotFound,
  StateNotFound,
  VocabularyCodeTaken,
} from "../../domain/obligation/errors.js";
import type { Actor } from "../../domain/ledger/model.js";
import type { IdGen } from "../../platform/ids.js";
import type { EventSink } from "../ledger/ports.js";
import type {
  ObligationStateRepository,
  ResolutionOptionRepository,
} from "./ports.js";

export interface VocabularyDeps {
  readonly states: ObligationStateRepository;
  readonly resolutionOptions: ResolutionOptionRepository;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface CreateObligationStateInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly isInitial?: boolean | undefined;
  readonly isTerminal?: boolean | undefined;
  readonly needsDecision?: boolean | undefined;
  readonly isFiled?: boolean | undefined;
  readonly isMissed?: boolean | undefined;
  readonly isResolution?: boolean | undefined;
  readonly sortOrder?: number | undefined;
}

export interface UpdateObligationStateInput {
  readonly tenantId: string;
  readonly stateId: string;
  /** Absent means unchanged, for each independently. */
  readonly name?: string | undefined;
  readonly isInitial?: boolean | undefined;
  readonly isTerminal?: boolean | undefined;
  readonly needsDecision?: boolean | undefined;
  readonly isFiled?: boolean | undefined;
  readonly isMissed?: boolean | undefined;
  readonly isResolution?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export interface CreateResolutionOptionInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly closesWithoutFiling?: boolean | undefined;
  readonly sortOrder?: number | undefined;
}

export interface UpdateResolutionOptionInput {
  readonly tenantId: string;
  readonly optionId: string;
  readonly name?: string | undefined;
  readonly closesWithoutFiling?: boolean | undefined;
  readonly status?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export class ObligationVocabularyService {
  constructor(private readonly deps: VocabularyDeps) {}

  /** In the order the firm arranged them, retired rows included — an admin
   *  needs to see what was stopped in order to bring it back. */
  async listStates(tenantId: string): Promise<readonly ObligationState[]> {
    return [...(await this.deps.states.list(tenantId))].sort(byOrder);
  }

  async listResolutionOptions(tenantId: string): Promise<readonly ResolutionOption[]> {
    return [...(await this.deps.resolutionOptions.list(tenantId))].sort(byOrder);
  }

  async createState(
    input: CreateObligationStateInput,
    actor: Actor,
  ): Promise<ObligationState> {
    const code = normalizeVocabularyCode(input.code);
    if (!isValidVocabularyCode(code)) throw new InvalidVocabularyCode(input.code);
    const sortOrder = input.sortOrder ?? 0;
    if (!Number.isInteger(sortOrder)) throw new InvalidSortOrder(sortOrder);

    const flags = {
      isInitial: input.isInitial ?? false,
      isTerminal: input.isTerminal ?? false,
      needsDecision: input.needsDecision ?? false,
      isFiled: input.isFiled ?? false,
      isMissed: input.isMissed ?? false,
      isResolution: input.isResolution ?? false,
    };
    refuseConflictingFlags(flags);

    // Checked rather than left to the unique constraint, which would surface as
    // an unexplained 500 on a screen where the fix is obvious.
    if (await this.deps.states.findByCode(input.tenantId, code)) {
      throw new VocabularyCodeTaken("state", code);
    }

    const state = await this.deps.states.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      code,
      name: input.name,
      ...flags,
      sortOrder,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "obligation_state.created",
      objectId: state.id,
      actor,
      payload: { code: state.code, ...flags },
    });
    return state;
  }

  /**
   * Rename a state, re-flag it, reorder it, retire it, or any combination.
   *
   * Two rules live here that the database cannot express, and both are about
   * the ABSENCE of a row rather than the presence of one:
   *
   *   A partial unique index enforces AT MOST ONE holder of each destination
   *   flag and cannot enforce AT LEAST ONE. So the floor is here, and each
   *   refusal names what would stop working — see `LastDestinationState`.
   *
   *   Marking a state as a destination CLEARS the previous holder, in the same
   *   statement (`ObligationStateRepository.update`). Otherwise the write would
   *   conflict with a row the caller is on its way to changing, and there would
   *   be an instant with none.
   *
   * Idempotent: a patch that changes nothing records nothing, because nothing
   * happened to record.
   */
  async updateState(
    input: UpdateObligationStateInput,
    actor: Actor,
  ): Promise<ObligationState> {
    const state = await this.requireState(input.tenantId, input.stateId);
    if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
      throw new InvalidSortOrder(input.sortOrder);
    }

    const next = {
      name: input.name ?? state.name,
      isInitial: input.isInitial ?? state.isInitial,
      isTerminal: input.isTerminal ?? state.isTerminal,
      needsDecision: input.needsDecision ?? state.needsDecision,
      isFiled: input.isFiled ?? state.isFiled,
      isMissed: input.isMissed ?? state.isMissed,
      isResolution: input.isResolution ?? state.isResolution,
      sortOrder: input.sortOrder ?? state.sortOrder,
      isActive: input.isActive ?? state.isActive,
    };
    refuseConflictingFlags(next);

    // Losing a destination flag and RETIRING the row that holds it are the same
    // hole reached two ways, so they get the same refusal. `filedState` and its
    // siblings all skip inactive rows, so a retired holder is a firm with none.
    const held = destinationOf(state);
    if (held !== null) {
      const keeps = destinationOf(next) === held && next.isActive;
      if (!keeps) {
        throw held === "initial" ? new LastInitialState() : new LastDestinationState(held);
      }
    }

    const changed =
      next.name !== state.name ||
      next.isInitial !== state.isInitial ||
      next.isTerminal !== state.isTerminal ||
      next.needsDecision !== state.needsDecision ||
      next.isFiled !== state.isFiled ||
      next.isMissed !== state.isMissed ||
      next.isResolution !== state.isResolution ||
      next.sortOrder !== state.sortOrder ||
      next.isActive !== state.isActive;
    if (!changed) return state;

    const updated = await this.deps.states.update(input.tenantId, state.id, next);

    // BOTH sides of whatever changed. "The flag moved" is not the useful fact a
    // year later; "it stopped being the missed state on the 4th, which is why
    // nothing reached the queue after that" is.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "obligation_state.updated",
      objectId: state.id,
      actor,
      payload: {
        code: state.code,
        ...(next.name === state.name ? {} : { nameFrom: state.name, nameTo: next.name }),
        ...(next.isInitial === state.isInitial ? {} : { isInitial: next.isInitial }),
        ...(next.isTerminal === state.isTerminal ? {} : { isTerminal: next.isTerminal }),
        ...(next.needsDecision === state.needsDecision
          ? {}
          : { needsDecision: next.needsDecision }),
        ...(next.isFiled === state.isFiled ? {} : { isFiled: next.isFiled }),
        ...(next.isMissed === state.isMissed ? {} : { isMissed: next.isMissed }),
        ...(next.isResolution === state.isResolution
          ? {}
          : { isResolution: next.isResolution }),
        ...(next.sortOrder === state.sortOrder ? {} : { sortOrder: next.sortOrder }),
        ...(next.isActive === state.isActive ? {} : { isActive: next.isActive }),
      },
    });
    return updated;
  }

  async createResolutionOption(
    input: CreateResolutionOptionInput,
    actor: Actor,
  ): Promise<ResolutionOption> {
    const code = normalizeVocabularyCode(input.code);
    if (!isValidVocabularyCode(code)) throw new InvalidVocabularyCode(input.code);
    const sortOrder = input.sortOrder ?? 0;
    if (!Number.isInteger(sortOrder)) throw new InvalidSortOrder(sortOrder);

    if (await this.deps.resolutionOptions.findByCode(input.tenantId, code)) {
      throw new VocabularyCodeTaken("option", code);
    }

    const closesWithoutFiling = input.closesWithoutFiling ?? false;
    const option = await this.deps.resolutionOptions.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      code,
      name: input.name,
      closesWithoutFiling,
      sortOrder,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "obligation_resolution_option.created",
      objectId: option.id,
      actor,
      payload: { code: option.code, closesWithoutFiling },
    });
    return option;
  }

  /**
   * Rename an option, change what it means, confirm it, reorder it, retire it.
   *
   * There is deliberately NO floor here, unlike the states. A firm may retire
   * every option it was seeded with — the four shipped ones are a previous
   * vendor's list and this firm's own answer may be none of them. What it
   * cannot do is resolve anything until it has written one, and `resolve`
   * refuses by name rather than this screen refusing in advance.
   *
   * `closesWithoutFiling` is editable and that is deliberate too: a firm that
   * ticked it wrongly has an option that ENDS filings it meant to keep open.
   * Changing it affects only decisions taken from then on — the obligations
   * already resolved under it keep the state they were moved to, because that
   * is where a partner actually sent them.
   */
  async updateResolutionOption(
    input: UpdateResolutionOptionInput,
    actor: Actor,
  ): Promise<ResolutionOption> {
    const option = await this.deps.resolutionOptions.findById(input.tenantId, input.optionId);
    if (option === null) throw new ResolutionOptionNotFound(input.optionId);
    if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
      throw new InvalidSortOrder(input.sortOrder);
    }
    // Narrowed here rather than at the type, so the refusal is a SENTENCE
    // naming both accepted values — a partner confirming their own list should
    // not meet a schema error. After this the union is proven, which is why the
    // assignment below needs no assertion.
    const status = input.status;
    if (status !== undefined && status !== "unconfirmed" && status !== "confirmed") {
      throw new InvalidRuleStatus(status);
    }

    const next = {
      name: input.name ?? option.name,
      closesWithoutFiling: input.closesWithoutFiling ?? option.closesWithoutFiling,
      status: status ?? option.status,
      sortOrder: input.sortOrder ?? option.sortOrder,
      isActive: input.isActive ?? option.isActive,
    };

    const changed =
      next.name !== option.name ||
      next.closesWithoutFiling !== option.closesWithoutFiling ||
      next.status !== option.status ||
      next.sortOrder !== option.sortOrder ||
      next.isActive !== option.isActive;
    if (!changed) return option;

    const updated = await this.deps.resolutionOptions.update(
      input.tenantId,
      option.id,
      next,
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "obligation_resolution_option.updated",
      objectId: option.id,
      actor,
      payload: {
        code: option.code,
        ...(next.name === option.name ? {} : { nameFrom: option.name, nameTo: next.name }),
        ...(next.closesWithoutFiling === option.closesWithoutFiling
          ? {}
          : { closesWithoutFiling: next.closesWithoutFiling }),
        ...(next.status === option.status ? {} : { status: next.status }),
        ...(next.sortOrder === option.sortOrder ? {} : { sortOrder: next.sortOrder }),
        ...(next.isActive === option.isActive ? {} : { isActive: next.isActive }),
      },
    });
    return updated;
  }

  private async requireState(tenantId: string, stateId: string): Promise<ObligationState> {
    const state = await this.deps.states.findById(tenantId, stateId);
    if (state === null) throw new StateNotFound(stateId);
    return state;
  }
}

/** Sort order first, then name, so two rows sharing an order still render in a
 *  stable sequence rather than whatever the database returned. */
function byOrder(
  a: { readonly sortOrder: number; readonly name: string },
  b: { readonly sortOrder: number; readonly name: string },
): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/**
 * The flag combinations that cannot be true of one state.
 *
 * Every one of these is refused by a CHECK in 0052 or 0055 as well. They are
 * repeated here for the reason the work board repeats its own: a partner
 * rearranging their vocabulary gets a SENTENCE saying which tick to move,
 * instead of a constraint name. The database is the wall an import or a script
 * meets; this is the wall a person meets.
 */
function refuseConflictingFlags(flags: {
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly needsDecision: boolean;
  readonly isFiled: boolean;
  readonly isMissed: boolean;
  readonly isResolution: boolean;
}): void {
  if (flags.isTerminal && flags.needsDecision) {
    throw new ConflictingStateFlags(
      "A state cannot both be the end of the matter and be waiting on a decision. That is why " +
        "Missed is not terminal: a missed deadline is a state a partner resolves, not an ending.",
    );
  }
  if (flags.isFiled && !flags.isTerminal) {
    throw new ConflictingStateFlags(
      "Only a state the firm treats as the end can be where a completed filing lands: mark it " +
        "terminal, or untick the filed one. A filing that is done is not still running.",
    );
  }
  if (flags.isResolution && !flags.isTerminal) {
    throw new ConflictingStateFlags(
      "A resolution is an ending: it is where a filing goes when a partner has decided it " +
        "will never be made. Mark it terminal, or untick the resolution one.",
    );
  }
  if (flags.isMissed && !flags.needsDecision) {
    throw new ConflictingStateFlags(
      "The state a passed deadline moves to has to be one that needs a decision, or the " +
        "filing would move there and nobody would ever be asked about it. " +
        "Tick 'needs a decision', or untick the missed one.",
    );
  }
  if (flags.isInitial && flags.isTerminal) {
    throw new ConflictingStateFlags(
      "A state cannot be both where filings start and where they end: every obligation the " +
        "calendar generated would be created already finished.",
    );
  }
  if (flags.isInitial && flags.needsDecision) {
    throw new ConflictingStateFlags(
      "A state cannot be both where filings start and one that needs a decision: every " +
        "obligation the calendar generated would arrive in a partner's queue on the day it " +
        "was created, months before it was due.",
    );
  }

  const destinations: readonly StateDestination[] = [
    ...(flags.isInitial ? (["initial"] as const) : []),
    ...(flags.isFiled ? (["filed"] as const) : []),
    ...(flags.isMissed ? (["missed"] as const) : []),
    ...(flags.isResolution ? (["resolution"] as const) : []),
  ];
  if (destinations.length > 1) {
    throw new ConflictingStateFlags(
      `A state can only be one of these: where filings start, where a completed one lands, ` +
        `where a passed deadline goes, or where a partner's decision ends it. This one is ` +
        `marked as ${destinations.join(" and ")}. Pick one, and put the other on its own state.`,
    );
  }
}
