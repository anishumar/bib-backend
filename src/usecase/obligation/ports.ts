// The ports the compliance calendar needs from the world — the seams (T3.2).
//
// Two of them carry the design rather than merely the plumbing.
//
// `CalendarSource` is the join from a RULE to the ENTITIES it reaches, and it
// lives behind a port because that join spans three schemas the obligation use
// case must not import: `core.legal_entity` for jurisdiction and entity type,
// `crm.engagement` for what the client actually bought, and `config.version`
// for which catalogue entry that engagement pins. A service reaching into any
// of them directly would tie the calendar to the commercial lane's tables.
//
// `WorkItemRaiser` is the ONE place an obligation becomes somebody's job. It is
// deliberately a port with one method rather than a call into `WorkItemService`,
// so the boundary between "what the law asks of the entity" and "what a person
// must do about it" is visible in the type system and not only in a comment.
import type { Actor } from "../../domain/ledger/model.js";
import type {
  DueRuleException,
  IsoDate,
  ObligationInstance,
  ObligationState,
  ObligationTemplate,
  ResolutionOption,
} from "../../domain/obligation/model.js";

// ── rules ──────────────────────────────────────────────────────────────────

export interface NewObligationTemplate {
  readonly id: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType: string | null;
  readonly serviceEntryId: string | null;
  readonly module: string | null;
  readonly name: string;
  readonly authority: string | null;
  readonly recurrence: ObligationTemplate["recurrence"];
  readonly fiscalYearStartMonth: number;
  readonly dueRule: ObligationTemplate["dueRule"];
  readonly unresolvedReason: string | null;
  readonly leadTimeDays: number;
  readonly rulePack: string;
  readonly supersedesId: string | null;
}

/** What a partner may change on a rule after it exists. Deliberately short: the
 *  IDENTITY of a rule (jurisdiction, name, pack) is not editable, because
 *  changing it would silently re-point every instance that pinned it. A revised
 *  rule is a new row under a new pack. */
export interface TemplateEdit {
  readonly entityType?: string | null | undefined;
  readonly serviceEntryId?: string | null | undefined;
  readonly module?: string | null | undefined;
  readonly authority?: string | null | undefined;
  readonly recurrence?: ObligationTemplate["recurrence"] | undefined;
  readonly fiscalYearStartMonth?: number | undefined;
  readonly dueRule?: ObligationTemplate["dueRule"] | undefined;
  readonly unresolvedReason?: string | null | undefined;
  readonly leadTimeDays?: number | undefined;
  readonly status?: ObligationTemplate["status"] | undefined;
  readonly isActive?: boolean | undefined;
}

/** A rule as a screen needs it: the rule, its exceptions, and the two things a
 *  reader would otherwise fetch per row — what the service is called, and
 *  whether this rule has ever produced anything. */
export interface TemplateRecord {
  readonly template: ObligationTemplate;
  readonly exceptions: readonly DueRuleException[];
  /** The catalogue service's name, joined. Null when the rule names no service
   *  — a rule that reaches an entity regardless of what it bought. */
  readonly serviceName: string | null;
  /** How many calendar rows this rule has produced, ever. The number a partner
   *  looks at before changing a lead time, and the number that makes an
   *  unresolved rule's zero self-explanatory. */
  readonly instanceCount: number;
}

/**
 * A rule's mutable columns, ALL of them, already resolved.
 *
 * The service reads the current row and fills every field before calling, so
 * the UPDATE needs no dynamic assembly and no COALESCE — `updateState`'s
 * arrangement in T3.1, and it exists because clearing a due formula to null is
 * a real edit that COALESCE cannot express.
 */
export interface TemplatePatch {
  readonly entityType: string | null;
  readonly serviceEntryId: string | null;
  readonly module: string | null;
  readonly authority: string | null;
  readonly recurrence: ObligationTemplate["recurrence"];
  readonly fiscalYearStartMonth: number;
  readonly dueRule: ObligationTemplate["dueRule"];
  readonly unresolvedReason: string | null;
  readonly leadTimeDays: number;
  readonly status: ObligationTemplate["status"];
  readonly isActive: boolean;
}

export interface ObligationTemplateRepository {
  create(template: NewObligationTemplate): Promise<ObligationTemplate>;
  /** Null when a rule with this identity already exists — the caller decides
   *  whether that is a conflict to report or a seed row to skip. */
  createIfAbsent(template: NewObligationTemplate): Promise<ObligationTemplate | null>;
  findById(tenantId: string, templateId: string): Promise<ObligationTemplate | null>;
  update(tenantId: string, templateId: string, patch: TemplatePatch): Promise<ObligationTemplate>;
  /** Every rule at the firm, retired ones included — the rules screen shows
   *  them, because a retired rule still explains an old filing's date. */
  list(tenantId: string): Promise<readonly TemplateRecord[]>;
  /** The generator's own read: active rules with their exceptions, in one pass.
   *  Exceptions come back attached because the generator needs them per period
   *  and a query per rule would be a query per rule per firm per night. */
  listGenerating(
    tenantId: string,
  ): Promise<readonly { readonly template: ObligationTemplate; readonly exceptions: readonly DueRuleException[] }[]>;
  countAll(tenantId: string): Promise<number>;
}

export interface NewException {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly periodEndMonth: number;
  readonly dueRule: DueRuleException;
}

export interface ObligationExceptionRepository {
  create(exception: NewException): Promise<DueRuleException>;
  createIfAbsent(exception: NewException): Promise<DueRuleException | null>;
  listFor(tenantId: string, templateId: string): Promise<readonly DueRuleException[]>;
  /** Withdraw one — `is_active = false`, never a DELETE. `bib_app` holds no
   *  DELETE grant on a single table in this database, and an exception is WHY a
   *  filing was due on the day it was: withdrawing it in June must not erase
   *  the reason April's return was dated as it was. */
  withdraw(tenantId: string, templateId: string, periodEndMonth: number): Promise<void>;
}

// ── the firm's words for where an obligation has got to ────────────────────

export interface NewObligationState {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly needsDecision: boolean;
  readonly isFiled: boolean;
  readonly isMissed: boolean;
  readonly isResolution: boolean;
  readonly sortOrder: number;
}

/** What an admin may change on a state. Every field independently optional:
 *  absent means unchanged, which is what lets one screen control rename,
 *  re-flag, reorder and retire without four endpoints. */
export interface ObligationStatePatch {
  readonly name: string;
  readonly isInitial: boolean;
  readonly isTerminal: boolean;
  readonly needsDecision: boolean;
  readonly isFiled: boolean;
  readonly isMissed: boolean;
  readonly isResolution: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface ObligationStateRepository {
  list(tenantId: string): Promise<readonly ObligationState[]>;
  createMany(states: readonly NewObligationState[]): Promise<readonly ObligationState[]>;
  create(state: NewObligationState): Promise<ObligationState>;
  findById(tenantId: string, stateId: string): Promise<ObligationState | null>;
  findByCode(tenantId: string, code: string): Promise<ObligationState | null>;
  /**
   * Apply the whole patch, clearing any DESTINATION flag this row is taking
   * from another in the SAME statement.
   *
   * The clear cannot be a separate call: `is_initial`, `is_filed`, `is_missed`
   * and `is_resolution` each carry a per-tenant partial unique index, so
   * writing the new holder before releasing the old one conflicts with a row
   * the caller is on its way to changing. 0050 learnt this for the work board;
   * this is the same shape with four flags instead of one.
   */
  update(
    tenantId: string,
    stateId: string,
    patch: ObligationStatePatch,
  ): Promise<ObligationState>;
}

// ── the firm's answers to "the date passed — now what?" ────────────────────

export interface NewResolutionOption {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly closesWithoutFiling: boolean;
  readonly sortOrder: number;
}

export interface ResolutionOptionPatch {
  readonly name: string;
  readonly closesWithoutFiling: boolean;
  readonly status: ResolutionOption["status"];
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface ResolutionOptionRepository {
  list(tenantId: string): Promise<readonly ResolutionOption[]>;
  createMany(options: readonly NewResolutionOption[]): Promise<readonly ResolutionOption[]>;
  create(option: NewResolutionOption): Promise<ResolutionOption>;
  findById(tenantId: string, optionId: string): Promise<ResolutionOption | null>;
  findByCode(tenantId: string, code: string): Promise<ResolutionOption | null>;
  update(
    tenantId: string,
    optionId: string,
    patch: ResolutionOptionPatch,
  ): Promise<ResolutionOption>;
}

/**
 * How far back the missed-deadline sweep is allowed to ask.
 *
 * A PORT rather than a call into `ConfigService`, for the reason
 * `CalendarSource` is one: the compliance module must not import the registry's
 * use case to read one date. It returns null when the firm has published no
 * `compliance_policy`, and null means NO FLOOR — see `CompliancePolicyBody`.
 */
export interface CompliancePolicySource {
  missedFromOn(tenantId: string): Promise<IsoDate | null>;
}

// ── from a rule to the entities it reaches ─────────────────────────────────

/** One entity a rule reaches, and the engagement that makes it the firm's work. */
export interface CalendarSubject {
  readonly entityPartyId: string;
  readonly engagementId: string;
  /**
   * The day the firm's work on this engagement began — `crm.engagement.
   * effective_from`, a `date` column and never `signed_at`.
   *
   * THE FLOOR, and it is why this field is on the port at all. Generation
   * reaches ninety days back so that a client who signed last month still gets
   * the period already under way; without a floor that same reach-back issues a
   * firm onboarded today three months of filings, every one past its statutory
   * date and therefore MISSED. Four hundred clients onboarded and the partner's
   * decision queue fills with thousands of deadlines nobody ever had — and the
   * one screen whose entire value is being trusted stops being trusted.
   */
  readonly effectiveFrom: IsoDate;
}

/**
 * An engagement the calendar has produced nothing for, and why.
 *
 * THE CURE FOR THE SILENT HOLE, and it is the reason this port has a second
 * method at all. A firm looking for a client's GST filings and finding an empty
 * calendar must be told which rule is missing what — never left to decide
 * whether the software is broken.
 *
 * The reason is computed from what the query can SEE rather than guessed:
 * whether any rule names the service at all, whether one does but not for this
 * entity's country, and whether the rules that match are all unresolved or
 * retired. Each of those is a different thing for a partner to do next.
 */
export interface CoverageGap {
  readonly engagementId: string;
  readonly entityPartyId: string;
  readonly entityName: string | null;
  readonly clientName: string | null;
  readonly serviceName: string | null;
  readonly jurisdiction: string | null;
  readonly reason: CoverageGapReason;
  /** How many rules name this service but could not be used, and the shape of
   *  why — so the screen can link straight to them. */
  readonly blockedRuleIds: readonly string[];
}

export type CoverageGapReason =
  /**
   * The company has no registered country, so no rule can reach it.
   *
   * Found by opening the screen: three engagements were being reported as
   * "no rule names this service" when the firm had just loaded fifty-seven
   * rules, and the real answer was that nobody had registered the companies as
   * legal entities. A rule matches an entity's jurisdiction EXACTLY, and an
   * entity with none matches nothing — which is a one-field fix somebody can
   * actually make, and was invisible under the other reason.
   */
  | "entity_not_registered"
  /** No rule at this firm names this service. The ordinary case for advisory
   *  work, and the reason this list is not an error list. */
  | "no_rule_names_this_service"
  /** Rules name it, but none for the entity's own country. */
  | "no_rule_for_jurisdiction"
  /** Rules match, and every one of them is waiting on a fact the firm has not
   *  given — the forty-six in the shipped India pack. */
  | "rules_need_a_formula"
  /** Rules match and every one has been retired. */
  | "rules_retired"
  /** Rules match and generate, but this engagement started after every period
   *  they would have produced. Resolves itself next period. */
  | "nothing_due_yet";

export interface CalendarSource {
  /** The entities one rule reaches: right country, right entity type when the
   *  rule names one, and an engagement for the service that makes it ours. */
  subjectsFor(
    tenantId: string,
    rule: {
      readonly jurisdiction: string;
      readonly entityType: string | null;
      readonly serviceEntryId: string | null;
    },
  ): Promise<readonly CalendarSubject[]>;

  /** Every live engagement with no obligation row, with the reason. See
   *  `CoverageGap`. */
  gaps(tenantId: string): Promise<readonly CoverageGap[]>;
}

// ── the calendar ───────────────────────────────────────────────────────────

export interface NewObligationInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly entityPartyId: string;
  readonly engagementId: string | null;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
  readonly stateId: string;
}

/** One calendar row as a screen needs it — every name joined, because a list
 *  that returns uuids is one somebody has to fetch per row. The rule this
 *  codebase has now learnt five times. */
export interface CalendarRow {
  readonly id: string;
  readonly name: string;
  readonly authority: string | null;
  readonly module: string | null;
  readonly entityPartyId: string;
  readonly entityName: string | null;
  readonly clientName: string | null;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
  readonly stateCode: string;
  readonly stateName: string;
  readonly isTerminal: boolean;
  readonly needsDecision: boolean;
  readonly workItemId: string | null;
  readonly filedOn: IsoDate | null;
  /** What was decided about it, once somebody has. `resolutionName` is joined
   *  rather than left as an id for the reason every read model in this codebase
   *  joins its names: a list returning uuids is one somebody fetches per row. */
  readonly resolutionOptionId: string | null;
  readonly resolutionName: string | null;
  readonly resolutionReason: string | null;
  readonly resolvedAt: string | null;
  /** The rule behind this row is not confirmed by the firm. SHOWN, never
   *  hidden: the date came from a document rather than from a partner. */
  readonly ruleUnconfirmed: boolean;
  readonly rulePack: string;
}

/**
 * One row of the partner's decision queue — a deadline that has passed with
 * nothing filed and nobody having decided anything.
 *
 * Separate from `CalendarRow` rather than a filter over it, because the two are
 * read for different reasons and carry different things. The calendar is a
 * WINDOW over dates and this is a WORKLIST with no window at all: an obligation
 * missed in April is still owed in September, and a date filter would quietly
 * drop the oldest and most expensive rows off the bottom of the queue.
 */
export interface DecisionRow {
  readonly id: string;
  readonly name: string;
  readonly authority: string | null;
  readonly module: string | null;
  readonly entityPartyId: string;
  readonly entityName: string | null;
  readonly clientName: string | null;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
  readonly stateId: string;
  readonly stateCode: string;
  readonly stateName: string;
  /** The task raised for it, if one was — a partner deciding "file it late"
   *  wants to see whether anybody is already on it. */
  readonly workItemId: string | null;
  readonly ruleUnconfirmed: boolean;
}

/** A row the generator actually created — enough to record the event that says
 *  so, and nothing more. */
export interface SpawnedInstance {
  readonly id: string;
  readonly templateId: string;
  readonly entityPartyId: string;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
}

/** An obligation that has reached its internal target with no task raised. */
export interface RaisableObligation {
  readonly id: string;
  readonly entityPartyId: string;
  readonly engagementId: string | null;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly templateName: string;
  readonly authority: string | null;
  readonly serviceEntryId: string | null;
  readonly entityName: string | null;
}

/** An obligation the sweep is about to flag. Enough to write the event that
 *  says so, and nothing more — the same contract `SpawnedInstance` has. */
export interface MissableObligation {
  readonly id: string;
  readonly statutoryDueOn: IsoDate;
  readonly entityPartyId: string;
  readonly templateName: string;
  readonly periodLabel: string;
  readonly workItemId: string | null;
}

export interface CalendarQuery {
  readonly from?: IsoDate | undefined;
  readonly to?: IsoDate | undefined;
  readonly entityPartyId?: string | undefined;
  readonly module?: string | undefined;
  /** Whether to include rows that have reached a terminal state. Off by
   *  default: within a year the filed ones are almost the whole table. */
  readonly includeSettled?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface ObligationInstanceRepository {
  /**
   * Propose a batch and return the rows that were actually NEW.
   *
   * `ON CONFLICT DO NOTHING` against `(tenant, template, entity, period_start)`,
   * never a read-then-write: this runs every night forever and can run
   * concurrently with itself after a redelivery, and only the database can
   * arbitrate that correctly. This is the acceptance line "re-running the
   * generator changes nothing", and it holds structurally.
   *
   * It returns the ROWS rather than a count because the caller records one
   * `obligation.spawned` per instance, and an event has to name the row it
   * happened to. A count would make the second run of a redelivered sweep
   * indistinguishable from the first.
   */
  createIfAbsent(rows: readonly NewObligationInstance[]): Promise<readonly SpawnedInstance[]>;
  calendar(tenantId: string, query: CalendarQuery): Promise<readonly CalendarRow[]>;
  findById(tenantId: string, obligationId: string): Promise<ObligationInstance | null>;
  /** Everything at or past its internal target with no task yet. */
  listRaisable(tenantId: string, asOf: IsoDate, limit: number): Promise<readonly RaisableObligation[]>;
  attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<void>;
  /**
   * The obligation a work item was raised for, if it was raised for one.
   *
   * The reverse of `attachWorkItem`, and the only lookup the closing path
   * needs. Most work items are not a filing at all — a firm's board is mostly
   * ordinary work — so this returns null far more often than not, and that is
   * the ordinary case rather than a miss.
   */
  findByWorkItem(tenantId: string, workItemId: string): Promise<ObligationInstance | null>;
  /**
   * Record that this obligation was discharged, and move it to the firm's filed
   * state. Returns false if it was ALREADY filed.
   *
   * The guard is in the WHERE clause rather than in the caller, because the
   * caller records `obligation.filed` from the answer: two concurrent moves
   * into a terminal state — a double-click, a retried request — must produce
   * one event, not two, and only the database can arbitrate that. The same
   * argument `createIfAbsent` makes about the generator.
   */
  markFiled(
    tenantId: string,
    obligationId: string,
    filedOn: IsoDate,
    stateId: string,
  ): Promise<boolean>;
  /**
   * Take a recorded filing back and return the obligation to `stateId`.
   * Returns false if it was not filed to begin with.
   *
   * Same shape and same reason as `markFiled`: the caller writes
   * `obligation.filing_reversed` only when a filing really was withdrawn.
   */
  clearFiled(tenantId: string, obligationId: string, stateId: string): Promise<boolean>;
  /**
   * Everything whose statutory date has passed with nothing filed, nobody
   * having decided, and whose state can still be missed.
   *
   * `floor` is the firm's published go-live date, or null for no floor. It is a
   * PARAMETER rather than a filter the caller applies afterwards, because the
   * rows excluded by it are the bulk of what a newly onboarded firm has and
   * fetching them to drop them is the expensive half.
   */
  listMissable(
    tenantId: string,
    asOf: IsoDate,
    floor: IsoDate | null,
    limit: number,
  ): Promise<readonly MissableObligation[]>;
  /**
   * Move one obligation into the firm's missed state. Returns false if it had
   * already moved — somebody filed it, or another sweep got there first.
   *
   * The guard is in the WHERE clause and not in the caller, `markFiled`'s
   * arrangement and its reason: the caller writes `obligation.missed` from the
   * answer, so two concurrent sweeps produce one event rather than two, and
   * only the database can arbitrate that.
   */
  markMissed(tenantId: string, obligationId: string, stateId: string): Promise<boolean>;
  /** Everything waiting on a partner, oldest statutory date first — the ones
   *  that have been late longest are the ones costing money. */
  decisionQueue(tenantId: string, limit: number): Promise<readonly DecisionRow[]>;
  /**
   * Record what a partner decided, and move the obligation where that decision
   * sends it. Returns false if somebody had already decided.
   *
   * One statement for the same reason `markFiled` is one: the caller writes
   * `obligation.resolved` from the answer, and a double-clicked form must leave
   * one decision and one event rather than two of each.
   */
  recordResolution(
    tenantId: string,
    obligationId: string,
    decision: {
      readonly optionId: string;
      readonly reason: string;
      readonly stateId: string;
    },
  ): Promise<boolean>;
  /**
   * Move the INTERNAL target of everything this rule has produced that nobody
   * has started, by a new lead time.
   *
   * ── WHY THIS EXISTS, AND WHY IT TOUCHES ONLY THE UNSTARTED ─────────────────
   *
   * Found by using the screen. A partner sets a lead time and expects the
   * calendar to move — but generation is idempotent, and the sweep materialises
   * a YEAR ahead, so without this the change would touch nothing at all until
   * next year's periods came round. A control that appears to work and quietly
   * does nothing for twelve months is worse than one that is missing.
   *
   * It moves the internal target and NEVER the statutory date: one is the
   * firm's own working practice and is theirs to change, the other is the law's
   * and is not.
   *
   * And it stops at anything already RAISED or FILED. A task on somebody's desk
   * has a date they are working to; re-dating it underneath them is how a
   * deadline moves without anybody being told.
   */
  redateUnstarted(tenantId: string, templateId: string, leadTimeDays: number): Promise<number>;
  countFor(tenantId: string, templateId: string): Promise<number>;
}

// ── the seams into other modules ───────────────────────────────────────────

/**
 * Raising the task an obligation is owed.
 *
 * Satisfied by `WorkItemService.raiseForObligation` in the composition root, so
 * neither use case imports the other — the same arrangement `WorkItemSpawner`
 * has for the scheduler.
 */
export interface WorkItemRaiser {
  raiseForObligation(
    tenantId: string,
    input: {
      readonly entityPartyId: string;
      readonly engagementId: string | null;
      readonly serviceEntryId: string | null;
      readonly title: string;
      readonly description: string | null;
      /** The STATUTORY date, not the internal one. The task is due when the law
       *  says; the internal target is only what made it appear this early. */
      readonly dueOn: IsoDate;
    },
    actor: Actor,
  ): Promise<string>;
}

/** Checking that a rule names a service the firm actually has. The catalogue
 *  lives in the config registry and this use case must not import it. */
export interface ServiceDirectory {
  /** The entry's key, or null if there is no service entry with that id. */
  serviceKey(tenantId: string, entryId: string): Promise<string | null>;
}

export interface TenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}
