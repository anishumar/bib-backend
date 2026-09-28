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

/**
 * A rule about to be written. No `lineageId` (0303's trigger derives it from
 * `supersedesId`) and no service: which services owe a filing is a LINK on the
 * rule's chain (0309), written through `RuleServiceLinkRepository` or in the
 * same transaction as the rule by `createIfAbsent`'s second argument.
 */
export interface NewObligationTemplate {
  readonly id: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType: string | null;
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
  /** `confirmed` for a rule the FIRM writes — it is the firm's own statement of
   *  the law — and `unconfirmed` for one a pack seeds, which nobody at the firm
   *  has checked yet. Only a confirmed rule generates (`coverageOf`). */
  readonly status: ObligationTemplate["status"];
  /** The first period start this rule governs, half-open with `effectiveTo`.
   *  Null on both is the ordinary case and means "always" — a rule nobody has
   *  had to amend, which is all of them until somebody supersedes one. */
  readonly effectiveFrom: IsoDate | null;
  readonly effectiveTo: IsoDate | null;
}

/** What a partner may change on a rule after it exists. Deliberately short: the
 *  IDENTITY of a rule (jurisdiction, name, pack) is not editable, because
 *  changing it would silently re-point every instance that pinned it. A revised
 *  rule is a new row under a new pack.
 *
 *  Which SERVICE owes it is not here either, and that is T6.16's decision 3:
 *  the catalogue is the one place a rule is linked to a service. Two places to
 *  say it would be two answers to one question. */
export interface TemplateEdit {
  readonly entityType?: string | null | undefined;
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

/** One catalogue service a rule's chain is linked to, NAMED — the reader would
 *  otherwise look every service up per row (T6.16). */
export interface UsedInService {
  readonly serviceEntryId: string;
  /** The catalogue key, which is also what `/catalogue` anchors a service on. */
  readonly serviceKey: string;
  /** The published version's name, else the newest version's, else null. A
   *  service that has only a draft can carry filings: a link is on the ENTRY,
   *  not on a frozen version. */
  readonly serviceName: string | null;
  readonly linkedAt: string;
}

/** A rule as a screen needs it: the rule, its exceptions, and the two things a
 *  reader would otherwise fetch per row — which services it is used in, and
 *  whether this rule has ever produced anything. */
export interface TemplateRecord {
  readonly template: ObligationTemplate;
  readonly exceptions: readonly DueRuleException[];
  /**
   * The live links on this rule's CHAIN, named, in one query. Every row of a
   * chain shows the same list: a predecessor still governing its own periods
   * is on the same services as its successor, because the link is the chain's.
   * Empty means the rule adds nothing to the calendar (decision 1).
   */
  readonly usedIn: readonly UsedInService[];
  /**
   * How many calendar rows this rule has produced, ever, WITHDRAWN ONES
   * INCLUDED. The number a partner looks at before changing a lead time, and
   * the one that decides whether the period shape is still editable
   * (`PERIOD_SHAPE_LOCKED` counts withdrawn rows, because they are keyed on
   * `period_start` and a relink restores them), so the screen and the refusal
   * cannot disagree.
   */
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

/** A link written together with the rule it links (the catalogue's "Write a
 *  new filing"). The chain is the new rule's own, so only the service and the
 *  person are named. */
export interface NewLinkOnCreate {
  readonly id: string;
  readonly serviceEntryId: string;
  readonly byUserId: string | null;
}

export interface ObligationTemplateRepository {
  create(template: NewObligationTemplate): Promise<ObligationTemplate>;
  /**
   * Null when a rule with this identity already exists — the caller decides
   * whether that is a conflict to report or a seed row to skip.
   *
   * `links` are written in the SAME transaction as the rule (T6.16): a rule
   * the catalogue wrote for a service and a link to that service are one act,
   * and a crash between two calls would leave a rule on no service, which
   * generates nothing and says so only in the library. No link is written
   * when the rule's identity is taken.
   */
  createIfAbsent(
    template: NewObligationTemplate,
    links?: readonly NewLinkOnCreate[],
  ): Promise<ObligationTemplate | null>;
  findById(tenantId: string, templateId: string): Promise<ObligationTemplate | null>;
  /**
   * Every row of one chain, oldest period first (0303's `lineage_id`). The
   * row IN FORCE is the one with no `effectiveTo`: `supersedeRule` refuses to
   * supersede a rule that already hands over, so a chain has exactly one.
   * This is how "the rule linked to this service" is judged: the link names
   * the chain, and it is the chain's current row that says what the filing
   * now is.
   */
  chain(tenantId: string, lineageId: string): Promise<readonly ObligationTemplate[]>;
  update(tenantId: string, templateId: string, patch: TemplatePatch): Promise<ObligationTemplate>;
  /**
   * Close one rule at a day and open its successor on the same day, ATOMICALLY.
   *
   * ── WHY IT IS ONE METHOD AND NOT TWO CALLS ────────────────────────────────
   *
   * Because each half alone is a broken calendar, in opposite directions, and
   * both are silent:
   *
   *   · predecessor closed, successor missing → the firm's clients stop being
   *     told about a filing they still owe. Nothing errors; the calendar is
   *     simply short from that day on.
   *   · successor written, predecessor still open → BOTH govern every period
   *     after the cutover, under different template ids that the re-run key
   *     `(tenant, template, entity, period_start)` cannot deduplicate. Every
   *     return appears twice, and the second one is indistinguishable from real
   *     work.
   *
   * A service that made two calls would leave one of those states behind on
   * every crash, redelivery and dropped connection. One transaction, or the
   * amendment did not happen.
   *
   * The successor carries `supersedes_id`, which is the chain that lets a
   * filing made in 2026 still explain its own date after the law changed in
   * 2027.
   *
   * ── AND THE PERIODS IT NO LONGER GOVERNS GO WITH IT (0303) ────────────────
   *
   * The reach-back has already put a year of the predecessor's periods on the
   * calendar, and every one from the cutover on now belongs to the successor.
   * `handover` names those rows (nobody has started them) with the dates the
   * SUCCESSOR gives them, and the same transaction re-pins them: same row,
   * same id, new rule, new date. The WHERE clause repeats the unstarted test,
   * so a row somebody picked up since the read stays on the rule its owner is
   * working to — and `kept` counts every row past the cutover still on the
   * predecessor afterwards, which is the number the partner is told.
   *
   * Nothing is created twice either way: `obligation_instance_lineage_key` is
   * one filing per entity, per period, per chain of rules.
   *
   * A WITHDRAWN row (0309) is neither handed over nor counted as kept. It
   * stays on the rule it was withdrawn under; if a linked service ever
   * proposes its period again, the generator restores it and re-pins it to
   * the rule that governs the period, which after the cutover is the
   * successor. And the successor needs no links of its own: links are on the
   * chain, so it is on every service its predecessor was.
   */
  supersede(
    tenantId: string,
    predecessorId: string,
    successor: NewObligationTemplate,
    handover: readonly RestatedInstance[],
  ): Promise<SupersedeResult>;
  /** Every rule at the firm, retired ones included — the rules screen shows
   *  them, because a retired rule still explains an old filing's date. Each
   *  carries where its chain is used, named, from the same query. */
  list(tenantId: string): Promise<readonly TemplateRecord[]>;
  /**
   * The generator's own read: active, confirmed rules with a formula whose
   * CHAIN has at least one live link (0309), with their exceptions and how
   * many services they are linked to, in one pass. Exceptions come back
   * attached because the generator needs them per period and a query per rule
   * would be a query per rule per firm per night.
   *
   * The link test here is the cheap half: without it every confirmed but
   * unlinked rule would be reported as reaching nobody, every night. WHICH
   * engagements a rule reaches is still `CalendarSource.subjectsFor`'s, which
   * joins the links to each engagement's own service.
   */
  listGenerating(
    tenantId: string,
  ): Promise<
    readonly {
      readonly template: ObligationTemplate;
      readonly exceptions: readonly DueRuleException[];
      readonly linkedServices: number;
    }[]
  >;
  countAll(tenantId: string): Promise<number>;
}

export interface NewException {
  readonly id: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly periodEndMonth: number;
  readonly dueRule: DueRuleException;
}

/** What one supersession did: the new rule, which calendar rows it took over
 *  (ids, so the caller can tell a re-dated row from one that only changed
 *  hands), and how many rows past the cutover stayed with the old rule because
 *  somebody had already started them. */
export interface SupersedeResult {
  readonly rule: ObligationTemplate;
  readonly handedOver: readonly string[];
  readonly kept: number;
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

// ── which services owe which filing (T6.16, 0309) ─────────────────────────

/**
 * What removing a filing from a service did to the calendar.
 *
 * `withdrawn` is the rows taken off. The three `kept*` counts are the rows of
 * THAT SERVICE's engagements on this chain that stayed, by reason, and they
 * partition `kept`:
 *
 *   `keptStarted`          a task is on a desk, or it was filed or decided.
 *   `keptPastDue`          untouched, but its statutory date has passed on the
 *                          firm's calendar or a partner's decision is waiting.
 *                          Removing it would hide a deadline the client may
 *                          have missed.
 *   `keptCoveredElsewhere` untouched and upcoming, and another service the
 *                          same client holds still carries this filing. Its
 *                          `engagement_id` is re-pointed to that service's
 *                          engagement (earliest start, then id), so the task it
 *                          raises is routed by the service that owes it now.
 *
 * Settled history (terminal and already past) is not counted at all: years of
 * filed returns were never going to be affected, and a number that included
 * them would drown the one a partner reads.
 */
export interface UnlinkOutcome {
  readonly withdrawn: number;
  readonly kept: number;
  readonly keptStarted: number;
  readonly keptPastDue: number;
  readonly keptCoveredElsewhere: number;
  /** Rows whose `engagement_id` moved to the engagement that still covers
   *  them. Includes untouched past-due rows as well as the covered upcoming
   *  ones, because either may yet raise a task and the task is routed by it. */
  readonly repointed: number;
}

/**
 * The links between a rule's CHAIN and the catalogue services that owe it.
 *
 * Its own port rather than methods on the rule repository, because the link
 * is its own fact with its own history (added, removed, added back) and the
 * removal reaches into the calendar: `unlink` withdraws filings in the same
 * transaction, which is the one place in the product a person's catalogue
 * edit moves rows on `delivery.obligation_instance`.
 */
export interface RuleServiceLinkRepository {
  /** The live links on one chain, named. What the rule's `usedIn` shows and
   *  what `coverageOf` is given as the link count. */
  usedIn(tenantId: string, lineageId: string): Promise<readonly UsedInService[]>;
  /**
   * Write a live link. False when one is already live for this chain and
   * service: the partial unique index arbitrates, so a double-click writes
   * one row and the caller one event.
   */
  link(
    tenantId: string,
    input: {
      readonly id: string;
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
    },
  ): Promise<boolean>;
  /**
   * Remove the live link AND withdraw what it no longer owes, in ONE
   * transaction. Null when there was no live link to remove.
   *
   * ONE METHOD, supersede's argument (0303) in a new place: each half alone
   * is a broken calendar. A removed link with its filings still live leaves
   * the client owing work the firm stopped doing; filings withdrawn under a
   * link that is still live are a gap the next sweep does not fill, because
   * the generator restores only what it proposes and it has no reason to.
   *
   * WHICH ROWS: this chain's rows whose engagement bought THIS service, that
   * `mayBeWithdrawn` (untouched, upcoming on `firmToday`, not waiting on a
   * decision, not settled), for an entity no OTHER live link reaches through a
   * live engagement. `firmToday` is the firm's day from `dayInZone`, passed in
   * as a date and never `CURRENT_DATE`, which is the database's UTC day.
   * The guard is repeated in the UPDATE, so a task raised between the read and
   * the write keeps its filing (counted as started).
   */
  unlink(
    tenantId: string,
    input: {
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
      readonly firmToday: IsoDate;
    },
  ): Promise<UnlinkOutcome | null>;
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
  /**
   * The catalogue service this engagement bought, through whose link the rule
   * reached it (the letter line's pinned version's ENTRY). One per
   * engagement, because a letter line pins one version.
   *
   * On the port so that adding a filing to a service can say what THAT
   * service's clients got (T6.16 review): the generator fills the whole chain,
   * and a count over every subject credited this link with filings owed
   * through a different service.
   */
  readonly serviceEntryId: string;
  /**
   * THE CEILING (V2.3), the floor's other end: an ENDED engagement's last day
   * of service. It is still a subject, for the periods that begin on or
   * before this day (the firm served them, so it files them); a period that
   * begins after it is not the firm's. Null while it has not been ended.
   */
  readonly endsOn: IsoDate | null;
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
 * whether any filing is linked to the service at all, whether one is but not
 * for this entity's country, and whether the rules that match are all
 * unresolved or retired. Each of those is a different thing for a partner to
 * do next.
 *
 * COVERED MEANS A LIVE ROW FOR THIS ENTITY ON A CHAIN THIS SERVICE CARRIES,
 * not a row naming this engagement's id (T6.16). A client on two services that
 * share a filing gets ONE row per period, carrying one engagement's id; asking
 * only for this engagement's id read the second service as a gap forever. A
 * withdrawn row is not coverage.
 */
export interface CoverageGap {
  readonly engagementId: string;
  readonly entityPartyId: string;
  readonly entityName: string | null;
  readonly clientName: string | null;
  readonly serviceName: string | null;
  readonly jurisdiction: string | null;
  readonly reason: CoverageGapReason;
  /** Rules linked to this service that could not be used, so the screen can
   *  link straight to them. */
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
  /** No compliance filing is linked to this service in the catalogue. The
   *  ordinary case for advisory work, and the reason this list is not an error
   *  list. The code predates the catalogue link (T6.16) and keeps its name:
   *  "names" now means "is linked to", and the fix is in the Catalogue. */
  | "no_rule_names_this_service"
  /** Filings are linked to it, but none for the entity's own country. */
  | "no_rule_for_jurisdiction"
  /** Rules match, and every one of them is waiting on a fact the firm has not
   *  given — the forty-six in the shipped India pack. */
  | "rules_need_a_formula"
  /** Rules match and every one has been retired. */
  | "rules_retired"
  /** Rules match, carry a formula, and not one has been confirmed by the firm
   *  — the shipped pack's every row until a partner answers it. */
  | "rules_unconfirmed"
  /** Rules match and generate, but this engagement started after every period
   *  they would have produced. Resolves itself next period. */
  | "nothing_due_yet";

export interface CalendarSource {
  /**
   * The entities one rule reaches: right country, right entity type when the
   * rule names one, and a live ENGAGEMENT whose pinned service has a LIVE LINK
   * to this rule's chain (0309). No link, no subjects: decision 1, a rule on
   * no service generates nothing.
   *
   * ORDERED by the engagement's `effective_from`, then its id, and that order
   * is a promise. A client holding two services that both carry the filing is
   * two subjects for one entity, and the calendar holds ONE row per (chain,
   * entity, period); the generator keeps the first subject for each, so the
   * row's `engagement_id` is chosen by rule rather than by whichever the
   * database returned first. Earliest start first is also the floor-friendly
   * choice: the earliest engagement is the one whose `effectiveFrom` floor
   * lets the most periods through.
   */
  subjectsFor(
    tenantId: string,
    rule: {
      readonly lineageId: string;
      readonly jurisdiction: string;
      readonly entityType: string | null;
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
  /** The engagement the row carries after the write: the proposal's, for a
   *  new row and for a restored one alike. What a link's count is taken by. */
  readonly engagementId: string | null;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
}

/** A withdrawn row the generator brought back (0309), and the instant it had
 *  been withdrawn, which the restore clears from the row. */
export interface RestoredInstance extends SpawnedInstance {
  readonly withdrawnAt: string;
}

/** What one proposal did: rows that were new, and withdrawn rows it restored.
 *  Separate lists because they are separate events and separate counts. */
export interface ProposalOutcome {
  readonly created: readonly SpawnedInstance[];
  readonly restored: readonly RestoredInstance[];
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

/**
 * An un-started obligation, as the restater reads it: the period it covers and
 * the dates it currently holds — everything needed to decide whether the rule
 * as it now stands would have produced something different.
 */
export interface UnstartedInstance {
  readonly id: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly periodLabel: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
}

/** One row's new dates. Only rows that actually MOVED are sent — a restate
 *  that rewrote every row to the value it already held would report a number a
 *  partner reads as "this changed 162 filings". */
export interface RestatedInstance {
  readonly id: string;
  readonly statutoryDueOn: IsoDate;
  readonly internalTargetOn: IsoDate;
}

export interface ObligationInstanceRepository {
  /**
   * Propose a batch and return the rows that were actually NEW.
   *
   * `ON CONFLICT DO NOTHING` against `(tenant, lineage, entity, period_start)`
   * (0303) — the lineage being the rule and every successor it has, so a
   * period an earlier rule in the chain already holds is not proposed twice
   * under a later one. Never a read-then-write: this runs every night forever and can run
   * concurrently with itself after a redelivery, and only the database can
   * arbitrate that correctly. This is the acceptance line "re-running the
   * generator changes nothing", and it holds structurally.
   *
   * It returns the ROWS rather than a count because the caller records one
   * `obligation.spawned` per instance, and an event has to name the row it
   * happened to. A count would make the second run of a redelivered sweep
   * indistinguishable from the first.
   *
   * ── AND A WITHDRAWN ROW IT PROPOSES COMES BACK (0309) ─────────────────────
   *
   * A withdrawn row still holds its key, so `DO NOTHING` alone would skip its
   * period forever. In the SAME transaction, before the insert, a proposal
   * whose (chain, entity, period) is held by a WITHDRAWN, untouched row
   * RESTORES that row: the withdrawal is cleared, the dates are the
   * proposal's (from `scheduleFor`), and it is re-pinned to the proposal's
   * rule and engagement. Same row, same id. The generator is what restores,
   * not only the link route, because a client taking a second linked service
   * proposes the same period through this same call.
   *
   * THE WRITE CHECKS THE LINK AGAIN. The subjects were read in an earlier
   * transaction; a proposal whose rule's chain no longer has a live link to
   * its engagement's service (somebody removed it mid-sweep) is neither
   * inserted nor restored. A proposal naming no engagement is not a link's to
   * judge, and nothing proposes one today.
   *
   * THE CALLER DE-DUPLICATES, one proposal per (chain, entity, period): the
   * restore is an UPDATE, and two proposals for one row would let the
   * database choose between them.
   */
  createIfAbsent(rows: readonly NewObligationInstance[]): Promise<ProposalOutcome>;
  /** The calendar a person reads. WITHDRAWN rows are never in it. */
  calendar(tenantId: string, query: CalendarQuery): Promise<readonly CalendarRow[]>;
  /** ONE row, whatever it holds, withdrawn included: a caller deciding what to
   *  do about a row has to be able to see that it was taken off. */
  findById(tenantId: string, obligationId: string): Promise<ObligationInstance | null>;
  /** Everything at or past its internal target with no task yet. A WITHDRAWN
   *  filing never gets a task, so it is never in this list. */
  listRaisable(tenantId: string, asOf: IsoDate, limit: number): Promise<readonly RaisableObligation[]>;
  /**
   * Record the task raised for a filing. False when nothing was written:
   * another raise got there first, or the filing was withdrawn since it was
   * read. The caller then writes no `obligation.work_raised`; the task it
   * made stays on the desk as ordinary work, which is the window stated in
   * `ObligationService.raise`.
   */
  attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<boolean>;
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
   * Everything this rule has produced that nobody has started, with the period
   * each row covers and the dates it currently holds. WITHDRAWN rows are not
   * in it: a filing off the calendar is not re-dated in place, it is re-dated
   * by `scheduleFor` if and when the generator restores it.
   *
   * ── WHY THE PERIOD COMES BACK TOO ─────────────────────────────────────
   *
   * Because the caller re-derives the dates with `scheduleFor`, which is the
   * SAME function the generator uses. An UPDATE doing the arithmetic in SQL
   * would be a second implementation of the due-date rules, and the two would
   * disagree the first time an exception was involved — which is exactly the
   * case a partner is most likely to be editing.
   */
  listUnstarted(tenantId: string, templateId: string): Promise<readonly UnstartedInstance[]>;
  /**
   * Write back dates recomputed from the rule as it now stands.
   *
   * ── WHY THIS EXISTS, AND WHY IT TOUCHES ONLY THE UNSTARTED ─────────────────
   *
   * Found by using the screen. A partner edits a rule and expects the calendar
   * to move — but generation is idempotent on
   * `(tenant, template, entity, period_start)`, and the sweep materialises a
   * YEAR ahead, so without this the change would touch nothing at all until
   * next year's periods came round. A control that appears to work and quietly
   * does nothing for twelve months is worse than one that is missing.
   *
   * It restates the STATUTORY date as well as the internal one, and that is a
   * deliberate reversal of what the lead-time-only version of this did. A lead
   * time is the firm's own practice and the statutory date is not in question
   * there; but when the FORMULA changes, the old statutory date was this
   * system's guess from a vendor's document and the new one is the firm's own
   * answer. Leaving a date we now know to be wrong, on the grounds that "the
   * law's date is not ours to change", would be the wrong way round — nobody
   * is changing the law, somebody is finally recording it.
   *
   * It stops at anything already RAISED or FILED, which is what `listUnstarted`
   * excludes. A task on somebody's desk has a date they are working to;
   * re-dating it underneath them is how a deadline moves without anybody being
   * told. The caller reports how many it therefore could NOT touch, because a
   * silent partial change is the failure mode here.
   */
  restate(tenantId: string, rows: readonly RestatedInstance[]): Promise<number>;
  /**
   * Every row this rule has EVER produced, withdrawn ones included. The
   * period-shape lock reads this: a withdrawn row is still keyed on
   * `period_start`, and a relink restores it, so moving the shape under it
   * would orphan it exactly as it would a live one.
   */
  countFor(tenantId: string, templateId: string): Promise<number>;
  /**
   * The rows this rule has on the calendar now: withdrawn ones excluded. The
   * restater's `locked` is this minus the unstarted rows, and counting a
   * withdrawn row there would report it as "kept because somebody started
   * it", which nobody did. Two counts because the two callers need two
   * different answers.
   */
  countLiveFor(tenantId: string, templateId: string): Promise<number>;
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
      /** The engagement that reaches this filing. It is what routes the task:
       *  its client, its Dept, its pinned service. */
      readonly engagementId: string | null;
      readonly title: string;
      readonly description: string | null;
      /** The STATUTORY date, not the internal one. The task is due when the law
       *  says; the internal target is only what made it appear this early. */
      readonly dueOn: IsoDate;
    },
    actor: Actor,
  ): Promise<string>;
}

/** A catalogue SERVICE as this module names it: the entry's key, and the name
 *  a person reads. The name is the PUBLISHED version's, else the newest
 *  version's, the same derivation `usedIn` shows, so an event and the library
 *  cannot name one service two ways; null only for an entry with no version at
 *  all, which then reads by its key. */
export interface ServiceRef {
  readonly key: string;
  readonly name: string | null;
}

/** Checking that a filing is being added to a service the firm actually has,
 *  and what to call it. The catalogue lives in the config registry and this
 *  use case must not import it. */
export interface ServiceDirectory {
  /** The entry's key and name, or null if there is no SERVICE entry with that
   *  id. The kind is checked here as a sentence and by 0309's composite key
   *  as a wall. */
  findService(tenantId: string, entryId: string): Promise<ServiceRef | null>;
}

export interface TenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}

/**
 * Which calendar this firm's days are cut on (0071).
 *
 * A sweep has no caller to send its day, and the server's UTC day is
 * yesterday in India until 05:30 — a T-X task raised five and a half hours
 * late, a rung fired a day late. "Today" for a firm's own sweep is the day in
 * the firm's zone, the same answer the per-period spawn and the chaser give.
 * Structural: satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
