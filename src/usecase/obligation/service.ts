// The compliance calendar — materialising what the law asks, and turning it
// into work at T–X (T3.2).
//
// ── NOTHING HERE DECIDES ANYTHING ──────────────────────────────────────────
//
// It takes rules the firm supplied, entities that exist, and engagements those
// entities bought, and computes the cross product. That is the entire job, and
// it is why the calendar can be trusted: there is no create endpoint for an
// instance and there will not be one. A human who could add a calendar entry
// could make the calendar disagree with the statute, and then it is Excel again
// with extra steps.
//
// ── THE SWEEP CATCHES PER FIRM, AND THAT IS T3.1'S LESSON, NOT A HABIT ─────
//
// `sweepActivations` carried a comment promising per-tenant isolation and did
// not do it: one firm with no work vocabulary stopped the calendar for every
// client of every firm on the box, silently. So every firm is caught here and
// the failure is REPORTED rather than swallowed. A firm quietly skipped forever
// is worse than a sweep that stops, because a stopped sweep gets noticed.
import {
  addDays,
  coverageOf,
  daysBetween,
  DEFAULT_OBLIGATION_STATES,
  DEFAULT_RESOLUTION_OPTIONS,
  filedState,
  generatesDates,
  governsPeriod,
  initialState,
  isDueRuleKind,
  isIsoDate,
  isObligationRecurrence,
  isRuleStatus,
  missedState,
  periodsBetween,
  resolutionState,
  scheduleFor,
  type DueRule,
  type DueRuleException,
  type IsoDate,
  type ObligationState,
  type ObligationTemplate,
} from "../../domain/obligation/model.js";
import {
  ExceptionMonthTaken,
  ExceptionNotFound,
  ExceptionNoteRequired,
  ExceptionOnEventRule,
  IncompleteDueRule,
  InvalidFiscalYearStart,
  InvalidJurisdiction,
  InvalidLeadTime,
  InvalidPeriodEndMonth,
  InvalidRecurrence,
  InvalidRulePack,
  InvalidRuleStatus,
  InvalidWindow,
  AlreadyDecided,
  NoFiledState,
  NoInitialState,
  NoMissedState,
  NoResolutionState,
  NotAwaitingDecision,
  AlreadySuperseded,
  CutoverBeforeStart,
  InvalidCutover,
  ObligationNotFound,
  PeriodShapeLocked,
  SuccessorNeedsItsOwnPack,
  ResolutionOptionNotFound,
  ResolutionOptionRetired,
  ResolutionReasonRequired,
  ServiceNotFound,
  TemplateKeyTaken,
  TemplateNameRequired,
  TemplateNotFound,
  UnresolvedReasonNotAllowed,
  UnresolvedReasonRequired,
} from "../../domain/obligation/errors.js";
import {
  INDIA_RULE_PACK,
  INDIA_SEED_RULES,
  type SeedRule,
} from "../../domain/obligation/rulepack-in.js";
import type { Actor } from "../../domain/ledger/model.js";
import type { Clock } from "../../platform/clock.js";
import type { IdGen } from "../../platform/ids.js";
import type { EventSink } from "../ledger/ports.js";
import type {
  CalendarQuery,
  CalendarRow,
  CalendarSource,
  CompliancePolicySource,
  CoverageGap,
  DecisionRow,
  NewObligationInstance,
  NewObligationTemplate,
  ObligationExceptionRepository,
  ObligationInstanceRepository,
  ObligationStateRepository,
  ObligationTemplateRepository,
  ResolutionOptionRepository,
  RestatedInstance,
  RuleServiceLinkRepository,
  ServiceDirectory,
  TemplateEdit,
  TemplateRecord,
  TenantDirectory,
  WorkItemRaiser,
} from "./ports.js";
import type { FirmTimeZone } from "./ports.js";
import { dayInZone } from "../../domain/scheduler/zone.js";

const SYSTEM_ACTOR: Actor = { type: "system", id: null };

/**
 * How far back and forward one sweep materialises.
 *
 * A YEAR FORWARD is enough for any annual filing, and the point of doing it at
 * all is that `delivery.job.runnable_at` lets a job be created as soon as it is
 * KNOWN and wait until it is DUE — so a year of calendar is a year of certainty
 * rather than a year of noise.
 *
 * NINETY DAYS BACK is not symmetry. A client who signed last month owes filings
 * for periods that have already begun, and a window starting today would skip
 * them silently. `CalendarSubject.effectiveFrom` is the floor that stops the
 * same reach-back inventing missed deadlines — see the port.
 */
const HORIZON_DAYS = 365;
export const REACH_BACK_DAYS = 90;

/**
 * How many instances one firm may gain in one sweep.
 *
 * `SPAWN_BATCH`'s argument in the scheduler: a first run for four hundred
 * clients proposes tens of thousands of rows and an equal number of events, and
 * a sweep that takes an hour is one nobody can reason about. The cap spreads
 * that over nights, and because generation is idempotent, spreading it costs
 * nothing but time.
 */
const GENERATE_BATCH = 500;
const RAISE_BATCH = 500;
/**
 * How many obligations one sweep may flag missed for one firm.
 *
 * Capped like the other two and for the same reason, with one extra: this is
 * the batch a newly onboarded firm meets first. Four hundred clients with
 * historic engagements and no published floor date produce thousands of
 * candidates on the first night, and each one is a row in a partner's queue.
 * The cap spreads it, and because flagging is idempotent — the missed state
 * cannot still be missed — spreading it costs only nights.
 */
const MISS_BATCH = 500;

/** How many rows the decision queue returns at once. A partner works the
 *  oldest first; a page bigger than this is a list nobody reads to the end. */
const DECISION_QUEUE_LIMIT = 200;

export interface GenerateReport {
  readonly tenantId: string;
  readonly created: number;
  /** Withdrawn filings a linked service proposed again, and which came back
   *  (0309). Counted apart from `created`: they are not new, and the ledger
   *  records them under their own verb. */
  readonly restored: number;
  readonly raised: number;
  /** Deadlines that passed undischarged on this pass. Counted into the worker's
   *  own log, because a queue nobody is told about is the silence this module
   *  exists to break. */
  readonly missed: number;
  /** Rules that reached no entity — usually a country with no clients yet, and
   *  a normal state rather than a misconfiguration. */
  readonly rulesWithNoSubjects: readonly string[];
  /** Engagements the calendar produced nothing for. THE SILENCE CURE — see
   *  `CoverageGap`. Counted here so the worker's own log carries it. */
  readonly uncoveredEngagements: number;
  /** Set when this firm's pass threw. The other firms still ran. */
  readonly failure?: string;
}

export interface Deps {
  readonly templates: ObligationTemplateRepository;
  readonly exceptions: ObligationExceptionRepository;
  readonly states: ObligationStateRepository;
  readonly resolutionOptions: ResolutionOptionRepository;
  readonly instances: ObligationInstanceRepository;
  /** Which catalogue services owe which filing (T6.16). The catalogue is the
   *  one place a link is made, through `linkRule`, `unlinkRule` and a
   *  `createRule` that names services. */
  readonly links: RuleServiceLinkRepository;
  /** The firm's published go-live date, behind a port so this module does not
   *  import the config registry's use case to read one date. */
  readonly compliancePolicy: CompliancePolicySource;
  readonly calendarSource: CalendarSource;
  readonly services: ServiceDirectory;
  readonly workItems: WorkItemRaiser;
  readonly tenants: TenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly clock: Clock;
}

export interface CreateRuleInput {
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType?: string | null | undefined;
  /**
   * The catalogue services this new filing is added to, in the same act
   * (T6.16): the catalogue's "Write a new filing" sends the one it was written
   * on. Empty or absent is the library writing a rule on no service, which
   * generates nothing until a service carries it (decision 1).
   */
  readonly serviceEntryIds?: readonly string[] | undefined;
  readonly module?: string | null | undefined;
  readonly name: string;
  readonly authority?: string | null | undefined;
  readonly recurrence: string;
  readonly fiscalYearStartMonth: number;
  readonly dueRule: {
    readonly kind: string;
    readonly dueMonthOffset?: number | null | undefined;
    readonly dueDayOfMonth?: number | null | undefined;
    readonly dueDaysAfter?: number | null | undefined;
  } | null;
  readonly unresolvedReason?: string | null | undefined;
  readonly leadTimeDays: number;
  readonly rulePack: string;
  readonly supersedesId?: string | null | undefined;
}

/**
 * What a rule write did to the calendar that already exists.
 *
 * Every rule write returns one, and the screen shows it, because the failure
 * mode this whole mechanism guards against is SILENCE: a partner edits a
 * formula, the response says "saved", and whether that moved fourteen filings
 * or none is invisible until somebody misses one.
 *
 * `locked` is the half nobody would think to ask for, and the half that matters
 * most: the filings this could not touch because somebody has already picked
 * them up. A partial change reported as a whole one is how a deadline moves
 * without anybody being told.
 */
export interface RuleEffect {
  /** Un-started filings whose dates this moved. */
  readonly restated: number;
  /** Filings already raised or filed, left exactly as they were. */
  readonly locked: number;
  /** Filings this rule newly put on the calendar. */
  readonly spawned: number;
}

const NO_EFFECT: RuleEffect = { restated: 0, locked: 0, spawned: 0 };

/** What generating for one chain did, as the screen tells it: "12 filings
 *  added to the calendar for 4 companies". `companies` is distinct entities
 *  across both lists. */
interface SpawnOutcome {
  readonly spawned: number;
  readonly restored: number;
  readonly companies: number;
}

const NOTHING_SPAWNED: SpawnOutcome = { spawned: 0, restored: 0, companies: 0 };

/**
 * What adding a filing to a service did (T6.16).
 *
 * `linked` false is the idempotent answer: it was already on the service, so
 * nothing was written and nothing recorded. `confirmed` says adding it also
 * CONFIRMED a rule nobody at the firm had checked, which the screen showed in
 * words before the person pressed Add. `spawned` and `restored` are the
 * filings it put on the calendar and the withdrawn ones it brought back;
 * `companies` is how many companies those are for.
 */
export interface LinkEffect {
  readonly linked: boolean;
  readonly confirmed: boolean;
  readonly spawned: number;
  readonly restored: number;
  readonly companies: number;
}

/**
 * What removing a filing from a service did (T6.16). `unlinked` false is the
 * idempotent answer: it was not on the service. The rest is `UnlinkOutcome`,
 * whose doc says what each count means.
 */
export interface UnlinkEffect {
  readonly unlinked: boolean;
  readonly withdrawn: number;
  readonly kept: number;
  readonly keptStarted: number;
  readonly keptPastDue: number;
  readonly keptCoveredElsewhere: number;
}

/** The row IN FORCE of a chain: the one with no end, else the latest. The
 *  catalogue judges a link by it, because it is what the filing now is. */
function currentOf(chain: readonly ObligationTemplate[]): ObligationTemplate | undefined {
  const open = chain.filter((t) => t.effectiveTo === null);
  const pool = open.length > 0 ? open : chain;
  return pool[pool.length - 1];
}

/** Who did it, for a column that names a person. System and agent actors have
 *  no account, which is the null. */
function userOf(actor: Actor): string | null {
  return actor.type === "human" ? actor.id : null;
}

export class ObligationService {
  constructor(private readonly deps: Deps) {}

  // ── the firm's starting vocabulary ───────────────────────────────────────

  /**
   * Give a brand-new firm its obligation states — the `ObligationVocabularySeeder`
   * port `createTenant` calls.
   *
   * Idempotent, and not defensively: `createTenant` and this share no unit of
   * work, so a retry after a partial failure must not produce a second
   * "Pending". Rows that already exist are left alone, because by then they may
   * be the firm's own edits.
   */
  async seedDefaultStates(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<number> {
    const held = new Set((await this.deps.states.list(tenantId)).map((s) => s.code));
    const missing = DEFAULT_OBLIGATION_STATES.filter((s) => !held.has(s.code)).map((s) => ({
      id: this.deps.ids.newId(),
      tenantId,
      code: s.code,
      name: s.name,
      isInitial: s.isInitial,
      isTerminal: s.isTerminal,
      needsDecision: s.needsDecision,
      isFiled: s.isFiled,
      isMissed: s.isMissed,
      isResolution: s.isResolution,
      sortOrder: s.sortOrder,
    }));

    // The options are seeded on the same call rather than a second port,
    // because they are half of one vocabulary: a firm with a missed state and
    // no options has a queue nobody can clear. Independently idempotent, since
    // a firm that already has states may still be missing these.
    const heldOptions = new Set(
      (await this.deps.resolutionOptions.list(tenantId)).map((o) => o.code),
    );
    const missingOptions = DEFAULT_RESOLUTION_OPTIONS.filter((o) => !heldOptions.has(o.code)).map(
      (o) => ({
        id: this.deps.ids.newId(),
        tenantId,
        code: o.code,
        name: o.name,
        closesWithoutFiling: o.closesWithoutFiling,
        sortOrder: o.sortOrder,
      }),
    );
    if (missingOptions.length > 0) {
      await this.deps.resolutionOptions.createMany(missingOptions);
    }

    if (missing.length === 0) {
      return missingOptions.length === 0 ? 0 : missingOptions.length;
    }

    await this.deps.states.createMany(missing);
    // ONE event, not five — a firm receiving its starting vocabulary is one
    // fact. `work_vocabulary.seeded`'s argument.
    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_vocabulary.seeded",
      objectId: tenantId,
      actor,
      payload: {
        states: missing.map((s) => s.code),
        resolutionOptions: missingOptions.map((o) => o.code),
      },
    });
    return missing.length;
  }

  async listStates(tenantId: string): Promise<readonly ObligationState[]> {
    return this.deps.states.list(tenantId);
  }

  /**
   * Load the shipped India rule pack — all fifty-seven rows, ten of which
   * produce dates.
   *
   * Called from `createTenant` so a new firm is never looking at an empty
   * rules screen, and exposed as an action so a firm that predates the pack can
   * take it deliberately. Idempotent on `(jurisdiction, name, rulePack)`, which
   * is the rule's own identity, so running it twice adds nothing and — this is
   * the part that matters — never overwrites a rule a partner has since
   * CONFIRMED or given a lead time to.
   */
  async seedIndiaRulePack(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<number> {
    let created = 0;
    for (const seed of INDIA_SEED_RULES) {
      const template = await this.deps.templates.createIfAbsent({
        id: this.deps.ids.newId(),
        tenantId,
        jurisdiction: "IN",
        entityType: null,
        module: seed.module,
        name: seed.name,
        authority: seed.authority,
        recurrence: seed.recurrence,
        // India. On the rule rather than in code, because an Indian quarter is
        // Apr–Jun and computing it on the calendar is the mistake that looks
        // right three times out of four.
        fiscalYearStartMonth: 4,
        dueRule: seedDueRule(seed),
        unresolvedReason: seed.unresolvedReason,
        // ZERO for every rule, deliberately. T–X is the firm's own working
        // practice and appears nowhere in its sheet; a guessed lead time is a
        // commitment the firm never made.
        leadTimeDays: 0,
        rulePack: INDIA_RULE_PACK,
        effectiveFrom: null,
        effectiveTo: null,
        supersedesId: null,
        // UNCONFIRMED, and on NO service. A pack cannot know a firm's
        // catalogue, and on 2026-09-18 a pack row that named no service reached
        // every live engagement at every company in its country the moment it
        // generated, including a bookkeeping client whose service excludes the
        // filing, whose portal then called it "missed". Since T6.16 a row
        // generates only once it is BOTH confirmed and added to a service in
        // the catalogue, and adding an unconfirmed one there confirms it in the
        // same act, with its dates shown in words first.
        status: "unconfirmed",
      });
      if (!template) continue;
      created += 1;
      for (const e of seed.exceptions ?? []) {
        await this.deps.exceptions.createIfAbsent({
          id: this.deps.ids.newId(),
          tenantId,
          templateId: template.id,
          periodEndMonth: e.periodEndMonth,
          dueRule: {
            kind: e.dueRule,
            dueMonthOffset: e.dueMonthOffset,
            dueDayOfMonth: e.dueDayOfMonth,
            dueDaysAfter: e.dueDaysAfter,
            periodEndMonth: e.periodEndMonth,
            note: e.note,
          },
        });
      }
    }
    if (created === 0) return 0;

    const generating = INDIA_SEED_RULES.filter(
      (r) => r.dueRule !== null && r.recurrence !== "event",
    ).length;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rules.seeded",
      objectId: tenantId,
      actor,
      // BOTH numbers, and the second is the one worth having. "Forty-seven of
      // your rules are waiting on a fact you have not given us" is the honest
      // state of the firm's own specification.
      payload: {
        rulePack: INDIA_RULE_PACK,
        created,
        generating,
        awaitingAFact: INDIA_SEED_RULES.length - generating,
      },
    });
    return created;
  }

  /**
   * Re-derive the dates of everything this rule has produced that nobody has
   * started, from the rule as it NOW stands.
   *
   * ── WHY `scheduleFor` AND NOT SQL ───────────────────────────────────────
   *
   * Because it is the function the generator itself uses. Doing the arithmetic
   * in an UPDATE would be a second implementation of the due-date rules, and
   * the two would part company the first time an exception was involved —
   * which is exactly the case a partner is most likely to be editing.
   *
   * ── WHY THE STATUTORY DATE MOVES HERE ───────────────────────────────────
   *
   * The lead-time-only version of this deliberately never touched it: a lead
   * time is the firm's own practice and the law's date was not in question.
   * When the FORMULA changes it is the other way round. The old statutory date
   * was this system's guess from a vendor's document; the new one is the firm's
   * answer. Leaving a date we now know to be wrong, because "the law's date is
   * not ours to change", would keep a wrong legal deadline on the grounds of
   * respecting the law.
   */
  private async restateUnstarted(
    tenantId: string,
    template: ObligationTemplate,
    exceptions: readonly DueRuleException[],
  ): Promise<{ readonly restated: number; readonly locked: number }> {
    const unstarted = await this.deps.instances.listUnstarted(tenantId, template.id);
    // The rows ON THE CALENDAR, not every row ever: a withdrawn one (0309) is
    // not "locked because somebody started it", nobody did. See the port.
    const total = await this.deps.instances.countLiveFor(tenantId, template.id);
    const locked = total - unstarted.length;

    const moved: RestatedInstance[] = [];
    for (const row of unstarted) {
      const schedule = scheduleFor(template, exceptions, {
        start: row.periodStart,
        end: row.periodEnd,
        label: row.periodLabel,
      });
      // OUTSIDE THIS RULE'S WINDOW, so it is not this rule's to restate — its
      // successor governs that period now. Leaving the row alone is right:
      // deleting it would erase a filing that is genuinely owed, and moving it
      // to the successor's formula is the successor's job on its own next
      // sweep.
      if (!governsPeriod(template, row.periodStart)) continue;
      // The formula was REMOVED — the rule now says it is waiting on a fact.
      // The rows it already produced keep the dates they were generated with,
      // because "we no longer know when this is due" is not the same statement
      // as "this is no longer due", and blanking a date a client is working to
      // would be the second of those.
      if (!schedule) continue;
      if (
        schedule.statutoryDueOn === row.statutoryDueOn &&
        schedule.internalTargetOn === row.internalTargetOn
      ) {
        continue;
      }
      moved.push({
        id: row.id,
        statutoryDueOn: schedule.statutoryDueOn,
        internalTargetOn: schedule.internalTargetOn,
      });
    }

    return { restated: await this.deps.instances.restate(tenantId, moved), locked };
  }

  /**
   * Materialise what a rule implies, right now, for that rule alone.
   *
   * ── THE CONTROL THAT LOOKS LIVE AND IS INERT ────────────────────────────
   *
   * Forty-seven of the fifty-seven shipped rules have no formula. The whole
   * point of the rules screen is that a partner can supply one. Without this
   * they would supply it, the row would say "producing dates", and the calendar
   * would stay empty until the worker's next pass — up to a day, and on a
   * developer's machine where no worker runs, forever. Nothing would look
   * broken, which is the worst version.
   *
   * It generates only; it does NOT raise tasks or flag anything missed. Those
   * are the sweep's, and having them fall out of a config edit would mean a
   * partner correcting a typo could put work on somebody's desk.
   *
   * ── FOR THE WHOLE CHAIN, NOT ONE ROW (T6.16) ─────────────────────────────
   *
   * It was one template. A chain whose predecessor still governs periods the
   * ninety-day reach-back has not produced yet would then lose those periods
   * the day its service was added, so it generates every row of the lineage:
   * each still proposes only the periods it governs (`governsPeriod`), and the
   * lineage key keeps it to one filing per period. It is also what brings a
   * withdrawn filing back, through the generator's own insert.
   */
  private async spawnFor(
    tenantId: string,
    lineageId: string,
    actor: Actor,
  ): Promise<SpawnOutcome> {
    const today = await this.firmDay(tenantId);
    const floor = await this.deps.compliancePolicy.missedFromOn(tenantId);
    const report = await this.generateReport(
      tenantId,
      { from: addDays(today, -REACH_BACK_DAYS), to: addDays(today, HORIZON_DAYS) },
      actor,
      lineageId,
      floor,
    );
    return {
      spawned: report.created,
      restored: report.restored,
      companies: report.companies,
    };
  }

  // ── writing rules ────────────────────────────────────────────────────────

  /** The library: every rule row, predecessors and retired ones included, each
   *  with the services its chain is used in. */
  async listRules(tenantId: string): Promise<readonly TemplateRecord[]> {
    return this.deps.templates.list(tenantId);
  }

  /**
   * One row per FILING: the rule in force of every chain at the firm, retired
   * ones included, each with where it is used (T6.16).
   *
   * What the catalogue reads. Its picker offers the active ones grouped by
   * `module`, each saying how many services already carry it, and every
   * service card finds its own filings in the same list by `usedIn`, so a page
   * of twenty services is ONE read rather than twenty (the local rate limit is
   * three hundred a minute, and the catalogue has been caught fetching per row
   * once already). Retired chains are in it because a service that still
   * carries one must be able to show it, marked, and offer to remove it.
   *
   * Derived from the library's own query rather than a second statement, so
   * the two screens cannot disagree about a rule.
   */
  async filings(tenantId: string): Promise<readonly TemplateRecord[]> {
    const rows = await this.deps.templates.list(tenantId);
    const byChain = new Map<string, TemplateRecord[]>();
    for (const r of rows) {
      const list = byChain.get(r.template.lineageId) ?? [];
      list.push(r);
      byChain.set(r.template.lineageId, list);
    }
    const out: TemplateRecord[] = [];
    for (const chain of byChain.values()) {
      const inForce = currentOf(
        [...chain].sort((a, b) =>
          (a.template.effectiveFrom ?? "").localeCompare(b.template.effectiveFrom ?? ""),
        ).map((r) => r.template),
      );
      const record = chain.find((r) => r.template.id === inForce?.id);
      if (record) out.push(record);
    }
    return out;
  }

  /** The filings one service carries, as its card in the catalogue shows
   *  them. A service that does not exist is refused by name rather than
   *  answered with an empty list that reads as "carries nothing". */
  async filingsForService(
    tenantId: string,
    serviceEntryId: string,
  ): Promise<readonly TemplateRecord[]> {
    const key = await this.deps.services.serviceKey(tenantId, serviceEntryId);
    if (key === null) throw new ServiceNotFound(serviceEntryId);
    return (await this.filings(tenantId)).filter((r) =>
      r.usedIn.some((u) => u.serviceEntryId === serviceEntryId),
    );
  }

  /** How many live services a rule's chain is on: `coverageOf`'s second
   *  argument. */
  private async linkCount(tenantId: string, lineageId: string): Promise<number> {
    return (await this.deps.links.usedIn(tenantId, lineageId)).length;
  }

  async createRule(
    input: CreateRuleInput,
    actor: Actor,
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: RuleEffect }> {
    const name = input.name.trim();
    if (name.length === 0) throw new TemplateNameRequired();
    if (!/^[A-Z]{2}$/.test(input.jurisdiction)) throw new InvalidJurisdiction(input.jurisdiction);
    if (!isObligationRecurrence(input.recurrence)) throw new InvalidRecurrence(input.recurrence);
    if (!Number.isInteger(input.fiscalYearStartMonth) ||
        input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12) {
      throw new InvalidFiscalYearStart(input.fiscalYearStartMonth);
    }
    if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0) {
      throw new InvalidLeadTime(input.leadTimeDays);
    }
    const rulePack = input.rulePack.trim();
    if (rulePack.length === 0) throw new InvalidRulePack(input.rulePack);

    const dueRule = readDueRule(input.dueRule);
    const unresolvedReason = (input.unresolvedReason ?? "").trim() || null;
    // The two halves of `obligation_due_rule_chk`, refused HERE so the caller
    // gets a sentence rather than a constraint name.
    if (dueRule === null && unresolvedReason === null) throw new UnresolvedReasonRequired();
    if (dueRule !== null && unresolvedReason !== null) throw new UnresolvedReasonNotAllowed();

    // THE SERVICES IT IS WRITTEN FOR (T6.16). Each must be a service this firm
    // has, refused here by name so the caller gets a sentence; 0309's
    // composite key refuses the same thing as a wall. Asked for twice is
    // asked for once.
    const serviceEntryIds = [...new Set(input.serviceEntryIds ?? [])];
    const serviceKeys = new Map<string, string>();
    for (const serviceEntryId of serviceEntryIds) {
      const key = await this.deps.services.serviceKey(input.tenantId, serviceEntryId);
      if (key === null) throw new ServiceNotFound(serviceEntryId);
      serviceKeys.set(serviceEntryId, key);
    }
    const byUserId = userOf(actor);

    const created = await this.deps.templates.createIfAbsent({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction,
      entityType: (input.entityType ?? "").trim() || null,
      module: (input.module ?? "").trim() || null,
      name,
      authority: (input.authority ?? "").trim() || null,
      recurrence: input.recurrence,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      dueRule,
      unresolvedReason,
      leadTimeDays: input.leadTimeDays,
      rulePack,
      supersedesId: input.supersedesId ?? null,
      // A rule written from scratch governs every period. Superseding is a
      // different operation with its own method — see `supersedeRule`.
      effectiveFrom: null,
      effectiveTo: null,
      // The firm wrote it, so the firm has said what the law is: confirmed.
      // "Checked against the statute" is a question asked of a PACK's rows.
      status: "confirmed",
    }, serviceEntryIds.map((serviceEntryId) => ({
      id: this.deps.ids.newId(),
      serviceEntryId,
      byUserId,
    })));
    if (!created) throw new TemplateKeyTaken(input.jurisdiction, name, rulePack);

    // ── WRITTEN FOR A SERVICE, IT FILLS THE CALENDAR NOW (T6.16) ───────────
    //
    // Until T6.16 a written rule deliberately generated nothing: a partner
    // types the formula first and the March carve-out second, and the nightly
    // sweep was what a brand-new rule was FOR. Two things changed. Under
    // decision 1 a rule written in the LIBRARY is on no service and could not
    // generate anyway, so that path still produces nothing and says so. And a
    // rule written in the CATALOGUE is written FOR a service, which is the same
    // act as adding an existing filing to it, and adding one fills the calendar
    // at once because the partner has just said "this service's clients owe
    // this". The half-written worry is answered by T6.4: adding the March
    // exception afterwards RESTATES the rows already generated, so an early
    // spawn costs a restate, never a wrong date left standing.
    const spawn =
      serviceEntryIds.length > 0 && generatesDates(created, serviceEntryIds.length)
        ? await this.spawnFor(input.tenantId, created.lineageId, actor)
        : NOTHING_SPAWNED;

    // After the spawn, as `updateRule` records its crossing: the count goes on
    // the rule's own event.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "obligation_rule.created",
      objectId: created.id,
      actor,
      payload: {
        jurisdiction: created.jurisdiction,
        name: created.name,
        rulePack: created.rulePack,
        recurrence: created.recurrence,
        coverage: coverageOf(created, serviceEntryIds.length),
        leadTimeDays: created.leadTimeDays,
        ...(serviceEntryIds.length === 0
          ? {}
          : { services: serviceEntryIds.length, spawned: spawn.spawned }),
      },
    });
    // One link event per service, like a link made from the picker, so "when
    // did this service start carrying GSTR-3B" has one answer whichever way it
    // was added. `onCreate` says the counts are on the event above.
    for (const serviceEntryId of serviceEntryIds) {
      await this.deps.events.recordEvent({
        tenantId: input.tenantId,
        verb: "obligation_rule.linked",
        objectId: created.lineageId,
        actor,
        payload: {
          lineageId: created.lineageId,
          ruleId: created.id,
          serviceEntryId,
          serviceKey: serviceKeys.get(serviceEntryId) ?? null,
          name: created.name,
          confirmed: false,
          onCreate: true,
        },
      });
    }

    return { rule: created, effect: { ...NO_EFFECT, spawned: spawn.spawned } };
  }

  /**
   * Edit a rule.
   *
   * What may NOT change is as much of the design as what may: jurisdiction,
   * name and rule pack are a rule's identity, and every instance already
   * generated pins this row. Moving the identity would silently restate why
   * those filings were due when they were.
   */
  /**
   * Edit a rule.
   *
   * What may NOT change is as much of the design as what may: jurisdiction,
   * name and rule pack are a rule's IDENTITY, and every instance already
   * generated pins this row. Moving the identity would silently restate why
   * those filings were due when they were — so a revised rule is a new row
   * under a new pack, and `supersedes_id` is the chain between them.
   */
  /**
   * The law changed, from a day. Close this rule there and open its successor.
   *
   * ── WHY THIS IS NOT `updateRule` ──────────────────────────────────────────
   *
   * `updateRule` is a CORRECTION: the India pack's dates came from a previous
   * vendor's document, everything ships `unconfirmed`, and a partner supplying
   * the real formula is recording the law properly for the first time rather
   * than changing it. So it edits in place and restates the filings already
   * generated, which is right — those dates were this system's guess.
   *
   * This is an AMENDMENT. The old formula was CORRECT for every period before
   * the cutover, and a filing made under it has to go on explaining its own
   * date forever. Editing in place would silently restate why those filings
   * were due when they were, which is the exact thing this table's immutable
   * identity and its `supersedes_id` chain exist to prevent.
   *
   * ── WHY IT IS NOT "RETIRE THE OLD ONE AND WRITE A NEW ONE" EITHER ────────
   *
   * That was already possible and it is wrong in both directions, silently:
   * a new rule with no window regenerates every period the old one produced
   * (a different `template_id`, so the re-run key cannot deduplicate, and every
   * return appears twice), while retiring the old one stops it generating for
   * periods BEFORE the cutover that the ninety-day reach-back has not reached
   * yet. The window says WHICH PERIODS each row governs, which is the actual
   * question.
   *
   * The predecessor is deliberately NOT retired. It still governs its own
   * periods, it still generates them if the reach-back finds one, and it stays
   * `generating` on the screen — with an end date beside it, which is a
   * different and truer thing to show than "retired".
   */
  async supersedeRule(
    tenantId: string,
    predecessorId: string,
    input: {
      readonly effectiveFrom: string;
      readonly dueRule: DueRule | null;
      readonly unresolvedReason?: string | null | undefined;
      readonly leadTimeDays?: number | undefined;
      readonly rulePack: string;
      readonly authority?: string | null | undefined;
      readonly module?: string | null | undefined;
      readonly entityType?: string | null | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: RuleEffect }> {
    const current = await this.deps.templates.findById(tenantId, predecessorId);
    if (!current) throw new TemplateNotFound(predecessorId);

    if (!isIsoDate(input.effectiveFrom)) throw new InvalidCutover(input.effectiveFrom);
    // A cutover at or before the predecessor's own start leaves it governing
    // nothing, which the CHECK refuses anyway — refused here so the caller gets
    // a sentence rather than a constraint name.
    if (current.effectiveFrom !== null && input.effectiveFrom <= current.effectiveFrom) {
      throw new CutoverBeforeStart(input.effectiveFrom, current.effectiveFrom);
    }
    // Superseding a rule that has ALREADY been superseded would leave two
    // successors for one period, which is the duplicate this whole mechanism
    // exists to prevent. Amend the one actually in force.
    if (current.effectiveTo !== null) {
      throw new AlreadySuperseded(current.name, current.effectiveTo);
    }

    const rulePack = input.rulePack.trim();
    if (rulePack.length === 0) throw new InvalidRulePack(input.rulePack);
    // The pack is part of the identity, so a successor sharing its
    // predecessor's pack collides on `(tenant, jurisdiction, name, rule_pack)`.
    // Refused here with the reason rather than as a unique violation.
    if (rulePack === current.rulePack) throw new SuccessorNeedsItsOwnPack(current.rulePack);

    const dueRule = readDueRule(input.dueRule);
    const unresolvedReason = (input.unresolvedReason ?? "").trim() || null;
    if (dueRule === null && unresolvedReason === null) throw new UnresolvedReasonRequired();
    if (dueRule !== null && unresolvedReason !== null) throw new UnresolvedReasonNotAllowed();

    const leadTimeDays = input.leadTimeDays ?? current.leadTimeDays;
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
      throw new InvalidLeadTime(leadTimeDays);
    }

    // The IDENTITY carries over: same jurisdiction, same name, same period
    // shape. A successor that changed the name would be a different obligation,
    // and one that changed the recurrence would orphan the predecessor's rows
    // the same way editing it in place would.
    //
    // AND ITS SERVICES CARRY OVER WITH NOTHING COPIED (T6.16). A link is on
    // the chain (`lineageId`), and the successor inherits the chain through
    // `supersedes_id`, so the day the law changes every service that carried
    // the filing still does. Re-pointing a filing to a different service is
    // not an amendment of the law; it is the catalogue's to do.
    const next: NewObligationTemplate = {
      id: this.deps.ids.newId(),
      tenantId,
      jurisdiction: current.jurisdiction,
      entityType: input.entityType === undefined ? current.entityType : trimToNull(input.entityType),
      module: input.module === undefined ? current.module : trimToNull(input.module),
      name: current.name,
      authority: input.authority === undefined ? current.authority : trimToNull(input.authority),
      recurrence: current.recurrence,
      fiscalYearStartMonth: current.fiscalYearStartMonth,
      dueRule,
      unresolvedReason,
      leadTimeDays,
      rulePack,
      supersedesId: predecessorId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      // An amendment is the firm's own act, like a rule it writes.
      status: "confirmed",
    };

    // ── WHAT THE PREDECESSOR ALREADY PRODUCED PAST THE CUTOVER ─────────────
    //
    // The reach-back materialises a year ahead, so the old rule has usually
    // put every period from the cutover on the calendar already — and those
    // are the successor's periods now. Leaving them where they were and letting
    // the successor generate its own was the gap 0303 closes: every return
    // from the cutover on appeared twice. So they move, in the same
    // transaction as the handover itself: same row, same id, the successor's
    // rule and the successor's date. Only rows nobody has started, by the same
    // test a correction uses; a filing on somebody's desk keeps the date its
    // owner is working to, stays on the rule it was raised under, and is
    // counted and reported.
    //
    // A successor still WAITING ON A FACT (no formula) takes the rows over
    // with the dates they already carry — the same thing `restateUnstarted`
    // does when a formula is removed, because "we do not know the new date yet"
    // is not "this is no longer due". The day the formula is answered,
    // `updateRule` restates them as the successor's own.
    const future = (await this.deps.instances.listUnstarted(tenantId, predecessorId)).filter(
      (r) => r.periodStart >= input.effectiveFrom,
    );
    const asTemplate: ObligationTemplate = { ...next, lineageId: current.lineageId, isActive: true };
    const redated = new Set<string>();
    const handover: RestatedInstance[] = future.map((row) => {
      const schedule = scheduleFor(asTemplate, [], {
        start: row.periodStart,
        end: row.periodEnd,
        label: row.periodLabel,
      });
      const statutoryDueOn = schedule?.statutoryDueOn ?? row.statutoryDueOn;
      const internalTargetOn = schedule?.internalTargetOn ?? row.internalTargetOn;
      if (statutoryDueOn !== row.statutoryDueOn || internalTargetOn !== row.internalTargetOn) {
        redated.add(row.id);
      }
      return { id: row.id, statutoryDueOn, internalTargetOn };
    });

    const { rule: successor, handedOver, kept } = await this.deps.templates.supersede(
      tenantId,
      predecessorId,
      next,
      handover,
    );
    const restated = handedOver.filter((id) => redated.has(id)).length;

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.superseded",
      objectId: successor.id,
      actor,
      payload: {
        name: successor.name,
        supersedesId: predecessorId,
        effectiveFrom: input.effectiveFrom,
        rulePackFrom: current.rulePack,
        rulePackTo: successor.rulePack,
        dueRuleFrom: current.dueRule,
        dueRuleTo: successor.dueRule,
        // Counts only — which filings moved is on each row, and a list of ids
        // in a log nobody can erase would outlive the rows it names.
        handedOver: handedOver.length,
        restated,
        kept,
      },
    });

    // Whatever the predecessor never reached — a later period, an entity it
    // had no row for. The lineage key refuses any period a row it KEPT still
    // holds, so a started filing is never generated a second time beside it.
    // Asked of the chain's links, which the successor already has.
    const spawned = generatesDates(successor, await this.linkCount(tenantId, successor.lineageId))
      ? (await this.spawnFor(tenantId, successor.lineageId, actor)).spawned
      : 0;

    return { rule: successor, effect: { restated, locked: kept, spawned } };
  }

  async updateRule(
    tenantId: string,
    templateId: string,
    edit: TemplateEdit & { readonly status?: string | undefined },
    actor: Actor,
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: RuleEffect }> {
    const { rule, effect } = await this.applyUpdate(tenantId, templateId, edit, actor, {
      spawnOnCrossing: true,
    });
    return { rule, effect };
  }

  /**
   * THE EDIT PATH, shared by the library's PATCH and by the catalogue's "add
   * it and confirm it" (`linkRule`), so confirming a rule is one code path and
   * one `obligation_rule.updated` event whichever screen it came from.
   *
   * `spawnOnCrossing` is off for `linkRule` only, and not to skip the spawn:
   * `linkRule` spawns itself right after, and records what it produced on
   * `obligation_rule.linked`. Two events carrying the same count would make a
   * report summing them count every filing twice.
   */
  private async applyUpdate(
    tenantId: string,
    templateId: string,
    edit: TemplateEdit & { readonly status?: string | undefined },
    actor: Actor,
    options: { readonly spawnOnCrossing: boolean },
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: RuleEffect }> {
    const current = await this.deps.templates.findById(tenantId, templateId);
    if (!current) throw new TemplateNotFound(templateId);
    // The chain's services, which an edit cannot change: the same number on
    // both sides of the crossing below.
    const linked = await this.linkCount(tenantId, current.lineageId);

    const recurrence = edit.recurrence ?? current.recurrence;
    if (!isObligationRecurrence(String(recurrence))) {
      throw new InvalidRecurrence(String(recurrence));
    }
    const fiscalYearStartMonth = edit.fiscalYearStartMonth ?? current.fiscalYearStartMonth;
    if (!Number.isInteger(fiscalYearStartMonth) ||
        fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
      throw new InvalidFiscalYearStart(fiscalYearStartMonth);
    }
    const leadTimeDays = edit.leadTimeDays ?? current.leadTimeDays;
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
      throw new InvalidLeadTime(leadTimeDays);
    }
    const status = edit.status ?? current.status;
    if (!isRuleStatus(String(status))) throw new InvalidRuleStatus(String(status));

    // ── THE PERIOD SHAPE IS PART OF THE IDENTITY ONCE ROWS EXIST ───────────
    //
    // `recurrence` and the fiscal year start are not ordinary fields: between
    // them they decide where a period BEGINS, and `period_start` is the key
    // every generated filing is deduplicated on. Moving either under existing
    // rows would orphan all of them — last quarter's return would match no
    // quarter, the next sweep would generate a second copy of work already
    // done, and nothing would report an error.
    //
    // So they are editable exactly while the rule has produced nothing, which
    // is the state of all forty-seven rules a partner actually has to answer
    // for. A rule that IS generating and needs a different shape is a new rule;
    // the old one retires and goes on explaining the filings it made.
    const shapeChanged =
      recurrence !== current.recurrence || fiscalYearStartMonth !== current.fiscalYearStartMonth;
    if (shapeChanged) {
      const produced = await this.deps.instances.countFor(tenantId, templateId);
      if (produced > 0) {
        throw new PeriodShapeLocked(
          recurrence !== current.recurrence ? "How often the filing comes round" : "The financial year start",
          produced,
        );
      }
    }

    // The formula and its reason are ONE decision, and the table says so
    // (`obligation_due_rule_chk`). Resolved together here so the caller gets a
    // sentence rather than a constraint name.
    const dueRule = edit.dueRule === undefined ? current.dueRule : edit.dueRule;
    const unresolvedReason =
      edit.unresolvedReason === undefined
        ? current.unresolvedReason
        : (edit.unresolvedReason ?? "").trim() || null;
    if (dueRule === null && unresolvedReason === null) throw new UnresolvedReasonRequired();
    if (dueRule !== null && unresolvedReason !== null) throw new UnresolvedReasonNotAllowed();

    // EVERY column, resolved. The repository does a plain UPDATE with no
    // dynamic assembly — see `TemplatePatch`.
    const updated = await this.deps.templates.update(tenantId, templateId, {
      entityType: edit.entityType === undefined ? current.entityType : trimToNull(edit.entityType),
      module: edit.module === undefined ? current.module : trimToNull(edit.module),
      authority: edit.authority === undefined ? current.authority : trimToNull(edit.authority),
      recurrence,
      fiscalYearStartMonth,
      dueRule,
      unresolvedReason,
      leadTimeDays,
      status,
      isActive: edit.isActive ?? current.isActive,
    });

    // AN EDIT MOVES THE CALENDAR THAT IS ALREADY THERE.
    //
    // Found by using the rules screen. The sweep materialises a year ahead and
    // generation is idempotent, so without this a partner could change a rule
    // and watch nothing happen for twelve months — a control that looks live
    // and is inert, which is the trap this codebase keeps naming.
    //
    // Only the fields that DECIDE A DATE trigger it. Renaming the authority
    // changes nothing about when anything is due, and a response claiming it
    // moved 162 filings would be a lie a partner would act on.
    const datesChanged =
      updated.leadTimeDays !== current.leadTimeDays ||
      !sameDueRule(current.dueRule, updated.dueRule);
    const exceptions = await this.deps.exceptions.listFor(tenantId, templateId);
    const moved = datesChanged
      ? await this.restateUnstarted(tenantId, updated, exceptions)
      : { restated: 0, locked: 0 };

    // AND IT MAY NOW PRODUCE FILINGS IT NEVER HAS.
    //
    // The CROSSING, not any formula change. Forty-seven of the fifty-seven
    // shipped rules say "waiting on a fact"; a rule that has sat on that screen
    // for six weeks and is now answered must fill the calendar there and then,
    // because the partner has just been asked a question and is owed the result
    // of their answer. A correction to a rule that was ALREADY generating
    // spawns nothing — the periods exist, and restating them is the whole of
    // it, since the period shape is locked once rows exist.
    //
    // A rule on no service never crosses (decision 1): confirming it in the
    // library fills nothing, because it reaches nobody until the catalogue
    // adds it to a service, and THAT is when its filings arrive.
    const crossed = !generatesDates(current, linked) && generatesDates(updated, linked);
    const spawned =
      crossed && options.spawnOnCrossing
        ? (await this.spawnFor(tenantId, updated.lineageId, actor)).spawned
        : 0;

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.updated",
      objectId: templateId,
      actor,
      // What CHANGED, field by field — a payload restating every value would
      // make "who confirmed this date" a diff somebody has to compute.
      payload: {
        name: updated.name,
        ...(updated.status === current.status
          ? {}
          : { statusFrom: current.status, statusTo: updated.status }),
        ...(updated.leadTimeDays === current.leadTimeDays
          ? {}
          : { leadTimeFrom: current.leadTimeDays, leadTimeTo: updated.leadTimeDays }),
        ...(sameDueRule(current.dueRule, updated.dueRule)
          ? {}
          : {
              // The formula itself, both sides. NOT prose — this is data, it
              // groups, and "which rules did this firm restate in March" is a
              // question the ledger should be able to answer without a join.
              dueRuleFrom: current.dueRule,
              dueRuleTo: updated.dueRule,
            }),
        // WHAT IT DID TO THE CALENDAR, always, even when it is zero. A change
        // that moved nothing and a change that moved fourteen filings are
        // different events, and eighteen months later the difference is the
        // only thing anybody wants from this row.
        ...(moved.restated === 0 && moved.locked === 0 && spawned === 0
          ? {}
          : { restated: moved.restated, locked: moved.locked, spawned }),
        ...(updated.isActive === current.isActive ? {} : { isActive: updated.isActive }),
        ...(coverageOf(updated, linked) === coverageOf(current, linked)
          ? {}
          : { coverageFrom: coverageOf(current, linked), coverageTo: coverageOf(updated, linked) }),
      },
    });
    return { rule: updated, effect: { ...moved, spawned } };
  }

  // ── which services owe which filing (T6.16) ──────────────────────────────

  /**
   * Add a filing to a catalogue service: the catalogue's "Add a filing".
   *
   * ── THE CHAIN IS LINKED, THE CURRENT ROW IS JUDGED ────────────────────────
   *
   * Any rule id in a chain is accepted; the link names the chain (0309), and
   * what the filing now IS (its formula, whether anybody has confirmed it) is
   * the chain's row in force. Adding it twice is not an error and records
   * nothing: `linked` comes back false.
   *
   * ── ADDING AN UNCONFIRMED RULE CONFIRMS IT, IN THE SAME ACT ───────────────
   *
   * The screen shows the dates in words ("due on the 20th of the month after
   * each month ends") before the person presses Add, which is exactly what
   * confirming a shipped date is: a partner checking it against the statute
   * and taking responsibility for it. So it goes through the library's own
   * confirm path (`applyUpdate`, one `obligation_rule.updated` with
   * `statusFrom`/`statusTo`), not a second writer of `status`. Only a rule
   * that COULD then generate is confirmed: one still waiting on a formula has
   * no dates to confirm, and stays as it is on the service, saying what it
   * needs.
   *
   * ── AND THE SERVICE'S CLIENTS GET THE FILINGS NOW ─────────────────────────
   *
   * The link is written FIRST, so the generation that follows finds the
   * service's engagements through it (`spawnFor` runs in its own transaction
   * and reads what has committed). It generates for the whole chain and
   * restores withdrawn rows it proposes, which is how removing a filing and
   * adding it back returns the same rows rather than new ones. A client who
   * holds another service that already carries this filing gets nothing new:
   * the lineage key holds one filing per period, whichever service reached it.
   */
  async linkRule(
    input: { readonly tenantId: string; readonly serviceEntryId: string; readonly ruleId: string },
    actor: Actor,
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: LinkEffect }> {
    const { tenantId, serviceEntryId } = input;
    const given = await this.deps.templates.findById(tenantId, input.ruleId);
    if (!given) throw new TemplateNotFound(input.ruleId);
    const serviceKey = await this.deps.services.serviceKey(tenantId, serviceEntryId);
    if (serviceKey === null) throw new ServiceNotFound(serviceEntryId);

    const lineageId = given.lineageId;
    let current = currentOf(await this.deps.templates.chain(tenantId, lineageId)) ?? given;

    const linked = await this.deps.links.link(tenantId, {
      id: this.deps.ids.newId(),
      lineageId,
      serviceEntryId,
      byUserId: userOf(actor),
    });
    if (!linked) {
      return {
        rule: current,
        effect: { linked: false, confirmed: false, spawned: 0, restored: 0, companies: 0 },
      };
    }

    const services = await this.linkCount(tenantId, lineageId);
    let confirmed = false;
    if (coverageOf(current, services) === "unconfirmed") {
      current = (
        await this.applyUpdate(tenantId, current.id, { status: "confirmed" }, actor, {
          spawnOnCrossing: false,
        })
      ).rule;
      confirmed = true;
    }

    const spawn = generatesDates(current, services)
      ? await this.spawnFor(tenantId, lineageId, actor)
      : NOTHING_SPAWNED;

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.linked",
      objectId: lineageId,
      actor,
      payload: {
        lineageId,
        ruleId: current.id,
        serviceEntryId,
        serviceKey,
        name: current.name,
        confirmed,
        // Counts only, like every rule write's effect: which filings arrived
        // is on the calendar and in their own `obligation.spawned` /
        // `obligation.restored` events.
        spawned: spawn.spawned,
        restored: spawn.restored,
      },
    });

    return {
      rule: current,
      effect: {
        linked: true,
        confirmed,
        spawned: spawn.spawned,
        restored: spawn.restored,
        companies: spawn.companies,
      },
    };
  }

  /**
   * Remove a filing from a catalogue service: the catalogue's "Remove from
   * this service" (T6.16, decision 2).
   *
   * The link is removed and, IN THE SAME TRANSACTION, the service's
   * untouched upcoming filings on this chain are WITHDRAWN for every client no
   * other linked service still covers: kept on the row and marked, never
   * deleted. Everything else is KEPT and counted by reason, because a partial
   * change reported as a whole one is how a deadline moves without anybody
   * being told. Which rows qualify is `mayBeWithdrawn` in the domain and
   * `RuleServiceLinkRepository.unlink`'s SQL, and "upcoming" is on the FIRM's
   * calendar (`dayInZone`), never the server's.
   *
   * Any rule id in the chain is accepted, as for `linkRule`. Removing a filing
   * that is not on the service records nothing: `unlinked` comes back false.
   */
  async unlinkRule(
    input: { readonly tenantId: string; readonly serviceEntryId: string; readonly ruleId: string },
    actor: Actor,
  ): Promise<{ readonly rule: ObligationTemplate; readonly effect: UnlinkEffect }> {
    const { tenantId, serviceEntryId } = input;
    const given = await this.deps.templates.findById(tenantId, input.ruleId);
    if (!given) throw new TemplateNotFound(input.ruleId);
    const serviceKey = await this.deps.services.serviceKey(tenantId, serviceEntryId);
    if (serviceKey === null) throw new ServiceNotFound(serviceEntryId);

    const lineageId = given.lineageId;
    const current = currentOf(await this.deps.templates.chain(tenantId, lineageId)) ?? given;
    const outcome = await this.deps.links.unlink(tenantId, {
      lineageId,
      serviceEntryId,
      byUserId: userOf(actor),
      firmToday: await this.firmDay(tenantId),
    });
    if (outcome === null) {
      return {
        rule: current,
        effect: {
          unlinked: false,
          withdrawn: 0,
          kept: 0,
          keptStarted: 0,
          keptPastDue: 0,
          keptCoveredElsewhere: 0,
        },
      };
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.unlinked",
      objectId: lineageId,
      actor,
      payload: {
        lineageId,
        ruleId: current.id,
        serviceEntryId,
        serviceKey,
        name: current.name,
        // COUNTS, not a verb per row: see `obligation_rule.unlinked` in the
        // registry. Which filings came off is on each row.
        withdrawn: outcome.withdrawn,
        kept: outcome.kept,
        keptStarted: outcome.keptStarted,
        keptPastDue: outcome.keptPastDue,
        keptCoveredElsewhere: outcome.keptCoveredElsewhere,
        repointed: outcome.repointed,
      },
    });

    return {
      rule: current,
      effect: {
        unlinked: true,
        withdrawn: outcome.withdrawn,
        kept: outcome.kept,
        keptStarted: outcome.keptStarted,
        keptPastDue: outcome.keptPastDue,
        keptCoveredElsewhere: outcome.keptCoveredElsewhere,
      },
    };
  }

  async addException(
    tenantId: string,
    templateId: string,
    input: {
      readonly periodEndMonth: number;
      readonly kind: string;
      readonly dueMonthOffset?: number | null;
      readonly dueDayOfMonth?: number | null;
      readonly dueDaysAfter?: number | null;
      readonly note: string;
    },
    actor: Actor,
  ): Promise<{ readonly exception: DueRuleException; readonly effect: RuleEffect }> {
    const template = await this.deps.templates.findById(tenantId, templateId);
    if (!template) throw new TemplateNotFound(templateId);
    if (template.recurrence === "event") throw new ExceptionOnEventRule();

    if (!Number.isInteger(input.periodEndMonth) ||
        input.periodEndMonth < 1 || input.periodEndMonth > 12) {
      throw new InvalidPeriodEndMonth(input.periodEndMonth);
    }
    const note = input.note.trim();
    if (note.length === 0) throw new ExceptionNoteRequired();

    const dueRule = readDueRule({
      kind: input.kind,
      dueMonthOffset: input.dueMonthOffset ?? null,
      dueDayOfMonth: input.dueDayOfMonth ?? null,
      dueDaysAfter: input.dueDaysAfter ?? null,
    });
    // An exception exists only to state a DIFFERENT date. One that cannot
    // compute a date says nothing, and a row that says nothing is worse than no
    // row because the screen renders it as a carve-out.
    if (dueRule === null) throw new IncompleteDueRule(input.kind, "a complete due formula");

    const created = await this.deps.exceptions.createIfAbsent({
      id: this.deps.ids.newId(),
      tenantId,
      templateId,
      periodEndMonth: input.periodEndMonth,
      dueRule: { ...dueRule, periodEndMonth: input.periodEndMonth, note },
    });
    if (!created) throw new ExceptionMonthTaken(input.periodEndMonth);

    // AN EXCEPTION IS A DATE CHANGE, and the calendar already holds the period
    // it applies to. March's TDS is generated eleven months before anybody adds
    // the carve-out saying March is due on the 30th of April — so without this
    // the exception would be right on paper and absent from every row it was
    // written for. Nothing new is spawned: an exception restates a period, it
    // does not create one.
    //
    // BEFORE the event, so the count can go ON it. `obligation_rule.updated`
    // has carried what an edit did to the calendar since T3.2 and this verb did
    // not — found by reading the ledger after using the screen, which is the
    // only place the asymmetry shows.
    const moved = await this.restateUnstarted(
      tenantId,
      template,
      await this.deps.exceptions.listFor(tenantId, templateId),
    );

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.exception_added",
      objectId: templateId,
      actor,
      // The month and the replacement rule. NOT the note: prose does not GROUP
      // BY, and this log cannot be erased.
      payload: {
        periodEndMonth: created.periodEndMonth,
        kind: created.kind,
        dueMonthOffset: created.dueMonthOffset,
        dueDayOfMonth: created.dueDayOfMonth,
        dueDaysAfter: created.dueDaysAfter,
        restated: moved.restated,
        locked: moved.locked,
      },
    });
    return { exception: created, effect: { ...moved, spawned: 0 } };
  }

  async removeException(
    tenantId: string,
    templateId: string,
    periodEndMonth: number,
    actor: Actor,
  ): Promise<RuleEffect> {
    const template = await this.deps.templates.findById(tenantId, templateId);
    if (!template) throw new TemplateNotFound(templateId);
    const held = await this.deps.exceptions.listFor(tenantId, templateId);
    if (!held.some((e) => e.periodEndMonth === periodEndMonth)) {
      throw new ExceptionNotFound(String(periodEndMonth));
    }
    await this.deps.exceptions.withdraw(tenantId, templateId, periodEndMonth);
    // Withdrawing one puts the period back under the rule's own formula, which
    // is a date change in exactly the same way adding it was — and the count
    // goes on the event for the same reason it does there.
    const moved = await this.restateUnstarted(
      tenantId,
      template,
      await this.deps.exceptions.listFor(tenantId, templateId),
    );

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.exception_removed",
      objectId: templateId,
      actor,
      payload: { periodEndMonth, restated: moved.restated, locked: moved.locked },
    });
    return { ...moved, spawned: 0 };
  }

  // ── generating ───────────────────────────────────────────────────────────

  /**
   * One pass over every firm.
   *
   * The outer loop is the tenant list because a worker has no session, and
   * everything below it is tenant-scoped by RLS. Each firm is caught — see the
   * note at the top of the file.
   */
  async sweep(actor: Actor = SYSTEM_ACTOR): Promise<readonly GenerateReport[]> {
    const tenantIds = await this.deps.tenants.activeTenantIds();
    const reports: GenerateReport[] = [];
    for (const tenantId of tenantIds) {
      try {
        reports.push(await this.sweepTenant(tenantId, actor));
      } catch (err: unknown) {
        reports.push({
          tenantId,
          created: 0,
          restored: 0,
          raised: 0,
          missed: 0,
          rulesWithNoSubjects: [],
          uncoveredEngagements: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<GenerateReport> {
    // THE FIRM'S DAY (0071). This one line decides when a T-X task appears
    // and when a filing turns MISSED; on the UTC day both happened five and
    // a half hours late for an Indian firm, every night.
    const today = await this.firmDay(tenantId);
    const floor = await this.deps.compliancePolicy.missedFromOn(tenantId);
    const generated = await this.generate(
      tenantId,
      { from: addDays(today, -REACH_BACK_DAYS), to: addDays(today, HORIZON_DAYS) },
      actor,
      undefined,
      floor,
    );
    const raised = await this.raise(tenantId, today, actor);
    // AFTER `raise`, deliberately. An obligation that reaches its internal
    // target and its statutory date in the same sweep — a rule with no lead
    // time, or a firm whose worker has been down a week — should still get the
    // task raised for it before it is flagged, because "file it late" is the
    // commonest decision and a partner choosing it wants somebody already on it.
    const missed = await this.markMissed(tenantId, today, actor);
    // Counted every sweep rather than on request, so the number reaches the
    // worker log as well as the screen. A gap nobody looks at is the silence
    // this whole mechanism exists to break.
    const gaps = await this.deps.calendarSource.gaps(tenantId);
    return { ...generated, raised, missed, uncoveredEngagements: gaps.length };
  }

  /**
   * Create every obligation falling due in a window, for one firm.
   *
   * Idempotent — the unique key on (tenant, lineage, entity, period start)
   * means running it twice a day for a year changes nothing after the first
   * time. That is T3.2's acceptance line and it holds structurally rather than
   * by care.
   */
  async generate(
    tenantId: string,
    window: { readonly from: IsoDate; readonly to: IsoDate },
    actor: Actor = SYSTEM_ACTOR,
    onlyLineageId?: string,
    floor: IsoDate | null = null,
  ): Promise<Omit<GenerateReport, "raised" | "missed" | "uncoveredEngagements">> {
    const r = await this.generateReport(tenantId, window, actor, onlyLineageId, floor);
    return {
      tenantId: r.tenantId,
      created: r.created,
      restored: r.restored,
      rulesWithNoSubjects: r.rulesWithNoSubjects,
    };
  }

  private async generateReport(
    tenantId: string,
    window: { readonly from: IsoDate; readonly to: IsoDate },
    actor: Actor,
    /**
     * One CHAIN only, for the write path (T6.16: it was one template).
     *
     * A partner who has just given a rule its formula, or added a filing to a
     * service, is told how many filings that produced, in the same response.
     * Without the filter the reply would be the whole firm's sweep and the
     * number would answer a question nobody asked; with it, the work is
     * bounded by the one filing they touched. Every row of the chain, because
     * a predecessor still governs the periods before its successor's cutover.
     */
    onlyLineageId: string | undefined,
    /**
     * The firm's compliance floor (`compliance_policy.missedFromOn`), or null
     * for none. A filing that fell due BEFORE the floor is never generated —
     * the firm was not keeping this calendar then — which is the same rule
     * the per-period spawn applies to months (T6.13). Until 2026-09-18 the
     * floor governed only the MISSED decision, so the ninety-day reach-back
     * still put June's and July's returns on the calendar and their tasks on
     * a desk for a firm that went live in September.
     */
    floor: IsoDate | null,
  ): Promise<{
    readonly tenantId: string;
    readonly created: number;
    readonly restored: number;
    readonly companies: number;
    readonly rulesWithNoSubjects: readonly string[];
  }> {
    if (!isIsoDate(window.from) || !isIsoDate(window.to) || window.from > window.to) {
      throw new InvalidWindow(window.from, window.to);
    }

    const rules = await this.deps.templates.listGenerating(tenantId);
    // A firm with no rules is not using the compliance calendar. A NORMAL
    // state, not a misconfiguration — and the sweep runs across every firm, so
    // throwing here would take the worker down for one of them.
    if (rules.length === 0) {
      return { tenantId, created: 0, restored: 0, companies: 0, rulesWithNoSubjects: [] };
    }

    const states = await this.deps.states.list(tenantId);
    const start = initialState(states);
    if (!start) throw new NoInitialState();

    const pending: NewObligationInstance[] = [];
    const barren: string[] = [];
    // ONE PROPOSAL PER (chain, entity, period), and which one is a rule
    // (T6.16). A client holding two services that both carry a filing is two
    // subjects for one entity, and the calendar holds ONE row per period.
    // Leaving the choice to whichever proposal the insert met first made the
    // row's `engagement_id` whatever order the database returned; the
    // restore is an UPDATE and would let the database choose as well.
    const proposed = new Set<string>();
    // The cap is checked in three places rather than one because a `break`
    // only leaves the loop it is in, and this is three deep. A flag reads worse
    // than a labelled break and survives somebody adding a fourth level.
    let full = false;

    for (const { template, exceptions, linkedServices } of rules) {
      if (full) break;
      // The generator's own filter, named once in the domain so the rules
      // screen and this loop cannot disagree about what "generating" means.
      if (!generatesDates(template, linkedServices)) continue;
      if (onlyLineageId !== undefined && template.lineageId !== onlyLineageId) continue;

      // WHO THIS CHAIN REACHES: only the engagements whose service carries it
      // (decision 1). Sorted HERE as well as by the adapter, earliest
      // engagement first and then by id, because the choice of engagement is
      // this loop's promise and must not depend on an adapter's ORDER BY.
      const subjects = [
        ...(await this.deps.calendarSource.subjectsFor(tenantId, {
          lineageId: template.lineageId,
          jurisdiction: template.jurisdiction,
          entityType: template.entityType,
        })),
      ].sort(
        (a, b) =>
          a.effectiveFrom.localeCompare(b.effectiveFrom) ||
          a.engagementId.localeCompare(b.engagementId),
      );
      if (subjects.length === 0) {
        barren.push(`${template.jurisdiction} · ${template.name}`);
        continue;
      }

      const periods = periodsBetween(
        template.recurrence,
        template.fiscalYearStartMonth,
        window.from,
        window.to,
      );

      for (const period of periods) {
        if (full) break;
        // THE RULE THAT GOVERNS A PERIOD IS THE ONE IN FORCE FOR IT (0057).
        // Without this a superseding rule regenerates every period its
        // predecessor already produced — a different `template_id`, so the
        // re-run key cannot catch it, and the calendar shows each filing twice
        // with nothing reporting an error.
        if (!governsPeriod(template, period.start)) continue;
        const schedule = scheduleFor(template, exceptions, period);
        if (!schedule) continue;

        for (const subject of subjects) {
          // THE FLOOR. A filing that fell due before the firm was engaged is
          // not the firm's — see `CalendarSubject.effectiveFrom`. The test is
          // the STATUTORY DATE and not the period: a firm engaged on 1 August
          // still files July's return, which falls due on the 20th while it is
          // engaged; it cannot have filed June's, which fell due before it was
          // appointed. Arithmetic rather than judgement — the firm was not
          // there.
          //
          // What is still a QUESTION, and is the firm's rather than ours: the
          // period that straddles the start. An engagement beginning 26 August
          // produces August's return, covering three weeks before the firm was
          // appointed. It is generated here because somebody has to file it.
          if (schedule.statutoryDueOn < subject.effectiveFrom) continue;
          // THE FIRM'S OWN FLOOR, the same test: a filing due before the day
          // the firm started keeping this calendar is not the firm's either.
          if (floor !== null && schedule.statutoryDueOn < floor) continue;
          // The FIRST subject for this entity that passes the floors is the
          // one: subjects are in order, and the earliest engagement is also
          // the one whose floor lets the most periods through.
          const key = `${template.lineageId}|${subject.entityPartyId}|${period.start}`;
          if (proposed.has(key)) continue;
          if (pending.length >= GENERATE_BATCH) {
            full = true;
            break;
          }
          proposed.add(key);

          pending.push({
            id: this.deps.ids.newId(),
            tenantId,
            templateId: template.id,
            entityPartyId: subject.entityPartyId,
            engagementId: subject.engagementId,
            periodStart: period.start,
            periodEnd: period.end,
            periodLabel: period.label,
            statutoryDueOn: schedule.statutoryDueOn,
            internalTargetOn: schedule.internalTargetOn,
            stateId: start.id,
          });
        }
      }
    }

    if (pending.length === 0) {
      return { tenantId, created: 0, restored: 0, companies: 0, rulesWithNoSubjects: barren };
    }

    const { created, restored } = await this.deps.instances.createIfAbsent(pending);

    // ONE EVENT PER INSTANCE, and the batch cap above is what makes that
    // affordable. "When did we first know this client owed this filing?" is
    // asked about ONE filing, and a batch count cannot answer it — which is why
    // the registered verb is `obligation.spawned` and not `obligations.generated`.
    for (const row of created) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.spawned",
        objectId: row.id,
        actor,
        payload: {
          templateId: row.templateId,
          entityPartyId: row.entityPartyId,
          periodLabel: row.periodLabel,
          statutoryDueOn: row.statutoryDueOn,
          internalTargetOn: row.internalTargetOn,
        },
      });
    }
    // And one per row BROUGHT BACK (0309), for the same reason and with the
    // instant it had been withdrawn, which restoring cleared from the row.
    for (const row of restored) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.restored",
        objectId: row.id,
        actor,
        payload: {
          templateId: row.templateId,
          entityPartyId: row.entityPartyId,
          periodLabel: row.periodLabel,
          statutoryDueOn: row.statutoryDueOn,
          internalTargetOn: row.internalTargetOn,
          withdrawnAt: row.withdrawnAt,
        },
      });
    }

    return {
      tenantId,
      created: created.length,
      restored: restored.length,
      companies: new Set([...created, ...restored].map((r) => r.entityPartyId)).size,
      rulesWithNoSubjects: barren,
    };
  }

  /**
   * Raise a task for every obligation that has reached its internal target.
   *
   * T–X, and X is the firm's own practice rather than the law. THE OBLIGATION
   * IS NOT THE TASK — this is where one produces the other, and it is the only
   * place they are joined.
   *
   * The obligation's own state is deliberately NOT moved here. `work_item_id`
   * being set IS the fact that work has started, and moving the state would
   * mean looking a state up by its code — which hardcodes a name the firm was
   * promised it could change, and is exactly the bug the demo shipped.
   */
  async raise(tenantId: string, asOf: IsoDate, actor: Actor = SYSTEM_ACTOR): Promise<number> {
    const due = await this.deps.instances.listRaisable(tenantId, asOf, RAISE_BATCH);
    let raised = 0;
    for (const o of due) {
      // ASKED AGAIN, per row, right before the task is made (T6.16). The list
      // is a snapshot and a whole batch may be worked through after it; a
      // filing removed from its service in the meantime must not land on a
      // desk. The window that is left is one `raiseForObligation` call wide:
      // a withdrawal inside it leaves the task on the desk as ordinary work,
      // unattached (`attachWorkItem` answers false and no `work_raised` is
      // written), which is the same shape two concurrent sweeps have always
      // had and the work board shows plainly.
      const fresh = await this.deps.instances.findById(tenantId, o.id);
      if (fresh === null || fresh.withdrawnAt !== null || fresh.workItemId !== null) continue;
      const workItemId = await this.deps.workItems.raiseForObligation(
        tenantId,
        {
          entityPartyId: o.entityPartyId,
          engagementId: o.engagementId,
          title: `${o.templateName} · ${o.entityName ?? "entity"} · ${o.periodLabel}`,
          description: o.authority ? `Filed with ${o.authority}.` : null,
          // The STATUTORY date on the task, never the internal one: the task is
          // due when the law says, and the internal target is only what caused
          // it to appear this early.
          dueOn: o.statutoryDueOn,
        },
        actor,
      );
      if (!(await this.deps.instances.attachWorkItem(tenantId, o.id, workItemId))) continue;
      raised += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.work_raised",
        objectId: o.id,
        actor,
        payload: { workItemId, statutoryDueOn: o.statutoryDueOn, asOf },
      });
    }
    return raised;
  }

  /**
   * Flag every deadline that has passed with nothing filed — the writer
   * `obligation.missed` has been waiting for since T3.2.
   *
   * ── A MISSED DEADLINE IS A STATE, NOT AN ERROR ────────────────────────────
   *
   * That is the acceptance line and it is also the implementation. Nothing here
   * throws, retries, alerts or hides: the row moves to a state the firm marked
   * as needing a decision, and a partner is then asked. A system that treated a
   * passed statutory date as a fault would have to decide what to do about it,
   * and deciding is the one thing this module must not do — it is where the
   * client money and the firm liability are settled, and that belongs to a
   * person.
   *
   * ── WHY THE STATUTORY DATE AND NOT THE INTERNAL TARGET ────────────────────
   *
   * T–X is the firm own working practice. Missing it means the firm is behind,
   * which the work board already shows as an overdue task with somebody name on
   * it. Missing the STATUTORY date means the client pays a penalty, and that is
   * a different question needing a different person. Two escalations, and this
   * is only the second one.
   *
   * ── AND WHY IT NEEDS NO IDEMPOTENCY MACHINERY ─────────────────────────────
   *
   * The missed state itself is the guard. It carries `needsDecision`, so
   * `canStillBeMissed` is false for it, so the next sweep does not see the row
   * at all — the same shape 0054 used, where the repository WHERE clause is
   * what decides whether an event is written. Two sweeps racing produce one
   * move and one event, arbitrated by the database rather than by care.
   *
   * ── THE FLOOR ────────────────────────────────────────────────────────────
   *
   * `compliance_policy` is the firm own answer to "do we want to be asked about
   * periods that closed before we started using this?". Unset means no floor
   * and everything is asked about, which is the behaviour this system already
   * had. It is read ONCE per sweep rather than per row: it is one date, and a
   * read per row over a first-night batch of five hundred is five hundred round
   * trips for an answer that cannot change between them.
   */
  async markMissed(
    tenantId: string,
    asOf: IsoDate,
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<number> {
    const floor = await this.deps.compliancePolicy.missedFromOn(tenantId);
    const candidates = await this.deps.instances.listMissable(tenantId, asOf, floor, MISS_BATCH);
    // Asked AFTER the candidates, so a firm with nothing overdue never pays for
    // the state list — which is every firm on most nights.
    if (candidates.length === 0) return 0;

    const missed = missedState(await this.deps.states.list(tenantId));
    if (missed === null) throw new NoMissedState();

    let flagged = 0;
    for (const o of candidates) {
      if (!(await this.deps.instances.markMissed(tenantId, o.id, missed.id))) {
        continue; // somebody filed it, or another sweep got there first
      }
      flagged += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.missed",
        objectId: o.id,
        actor,
        payload: {
          statutoryDueOn: o.statutoryDueOn,
          asOf,
          // Positive, always: this only ever runs after the date has passed.
          // Computed once here rather than by whoever reads the log, the same
          // arrangement `obligation.filed` makes with the same number.
          daysLate: daysBetween(o.statutoryDueOn, asOf),
          workItemId: o.workItemId,
        },
      });
    }
    return flagged;
  }

  /**
   * Everything waiting on a partner — the queue itself.
   *
   * NOT a window, and that is the difference from `calendar()`. An obligation
   * missed in April is still owed in September, and a date filter would drop
   * the oldest rows off the bottom of the list — which are exactly the ones
   * that have been costing money longest.
   */
  async decisionQueue(tenantId: string): Promise<readonly DecisionRow[]> {
    return this.deps.instances.decisionQueue(tenantId, DECISION_QUEUE_LIMIT);
  }

  /**
   * Record what a partner decided about a deadline already missed.
   *
   * ── THE REASON IS THE HALF THIS EXISTS FOR ────────────────────────────────
   *
   * The option can be counted — "how many late fees did we accept this quarter"
   * is a GROUP BY over a column. The reason cannot, and it is still the more
   * valuable of the two: in eighteen months nobody remembers why a late fee was
   * accepted rather than a provisional filing made, and that is the question a
   * client actually asks. So it is mandatory, refused here AND by a CHECK in
   * 0055, because this is the one field somebody in a hurry will try to skip.
   *
   * ── WHERE THE OBLIGATION GOES IS THE OPTION TO SAY, NOT THIS CODE ─────────
   *
   * `closesWithoutFiling` is a column on the firm own option row, so the fork
   * is data rather than a branch on a code:
   *
   *   false — the filing still has to happen. Back to the firm INITIAL state,
   *           where `raise` picks it up again and puts a task on somebody desk;
   *           when that task finishes, 0054 records it filed, late, with
   *           `daysLate` on the event. Nothing here has to know how it ends.
   *   true  — it never will. Into the firm RESOLUTION state, and over.
   *
   * A firm adding "client deregistered mid-year" says which of the two it means
   * on a screen, and this code does not change.
   *
   * ── AND WHY GOING BACK TO WORK DOES NOT LOOP ──────────────────────────────
   *
   * An obligation sent back to the initial state still has a statutory date in
   * the past, forever. Without a second fact it would be re-flagged the very
   * next night and the decision asked for again every morning until the filing
   * was made. `resolved_at` is that fact — and it is why this is a column
   * rather than only a ledger event, because the sweep WHERE clause cannot read
   * the ledger.
   *
   * A decision is never overwritten. Somebody who changes their mind records
   * the outcome against the filing it produces, rather than rewriting what was
   * first chosen and why — this row is the only copy of that.
   */
  async resolve(
    tenantId: string,
    obligationId: string,
    decision: { readonly optionId: string; readonly reason: string },
    actor: Actor,
  ): Promise<void> {
    const reason = decision.reason.trim();
    if (reason === "") throw new ResolutionReasonRequired();

    const obligation = await this.deps.instances.findById(tenantId, obligationId);
    if (obligation === null) throw new ObligationNotFound(obligationId);
    if (obligation.resolvedAt !== null) throw new AlreadyDecided();

    const states = await this.deps.states.list(tenantId);
    const current = states.find((st) => st.id === obligation.stateId);
    // Only a state the firm marked as needing a decision may be decided about,
    // and it is a FLAG rather than a code. This is the refusal that keeps the
    // queue meaningful: without it any row at all could be resolved from a
    // stale screen, including one somebody is actively working on.
    if (current === undefined || !current.needsDecision) {
      throw new NotAwaitingDecision(current?.name ?? "in an unknown state");
    }

    const option = await this.deps.resolutionOptions.findById(tenantId, decision.optionId);
    if (option === null) throw new ResolutionOptionNotFound(decision.optionId);
    // A retired option still EXPLAINS decisions already recorded against it —
    // the row is never deleted — but a firm that retired one has said it no
    // longer chooses it.
    if (!option.isActive) throw new ResolutionOptionRetired(option.name);

    const destination = option.closesWithoutFiling
      ? resolutionState(states)
      : initialState(states);
    if (destination === null) {
      throw option.closesWithoutFiling ? new NoResolutionState() : new NoInitialState();
    }

    if (
      !(await this.deps.instances.recordResolution(tenantId, obligationId, {
        optionId: option.id,
        reason,
        stateId: destination.id,
      }))
    ) {
      // A double-submitted form. The first one is the decision that counts and
      // its event is the one in the log.
      throw new AlreadyDecided();
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation.resolved",
      objectId: obligationId,
      actor,
      payload: {
        // The option and NEVER the reason. The reason is a partner free text
        // about a client and may name a person; section 3.4 of the event
        // contract keeps personal data out of a log that cannot be erased, so
        // it lives in the erasable row and only there.
        resolutionOptionId: option.id,
        resolutionCode: option.code,
        closesWithoutFiling: option.closesWithoutFiling,
        statutoryDueOn: obligation.statutoryDueOn,
        daysLate: daysBetween(obligation.statutoryDueOn, await this.firmDay(tenantId)),
        movedToStateId: destination.id,
      },
    });
  }

  /**
   * Bring an obligation into line with the work item that discharges it.
   *
   * ── THE OTHER END OF `raise`, AND WHY IT IS RECONCILIATION ────────────────
   *
   * `raise` puts a task on somebody's desk. This is what happens when that task
   * is finished — the only writer `filed_on` has, and the only thing that ever
   * moves an obligation out of the state it was generated in.
   *
   * It takes the work item's CURRENT answer to "is this discharged" rather than
   * a transition, and makes the obligation agree. That shape is chosen over an
   * `onCompleted` / `onReopened` pair for three reasons:
   *
   *   · **Idempotent by construction.** A double-click, a retried request or a
   *     redelivered call reaches the same end state, and the repository's own
   *     WHERE clause is what decides whether an EVENT is written — so the
   *     ledger gains one `obligation.filed`, not two.
   *   · **Reopening is not a special case.** It is the same call with a
   *     different answer, so there is no second path to keep in step with this
   *     one.
   *   · **It cannot be called in the wrong order**, because there is no order.
   *
   * ── WHAT `discharged` MEANS, AND WHY IT IS NOT `isTerminal` ───────────────
   *
   * Terminal AND successful. A firm starts with two terminal work item states
   * and one of them is Cancelled — raised twice, client gone, entity
   * deregistered. Reading `isTerminal` alone would record that a statutory
   * return had been FILED because somebody tidied their board: not a missing
   * feature but a false statement about a filing, which is worse than the
   * "Pending forever" it replaces. 0054 is where that flag comes from.
   *
   * ── AND WHY A REOPENED ITEM UN-FILES ──────────────────────────────────────
   *
   * `WorkItemService.moveToState` already clears `completedAt` on the way back
   * out; a calendar that kept saying "Filed" while somebody was actively
   * working the same thing would be a second rule about the same fact. It also
   * matters downstream: filed is terminal, and `canStillBeMissed` is false for
   * a terminal state, so an obligation wrongly left filed could never afterwards
   * be flagged missed. Un-filing lets T3.3's sweep pick it up again and correct
   * itself. The withdrawal is a REGISTERED verb rather than a quiet UPDATE,
   * because `filed_on` is a claim about a statutory date.
   *
   * The obligation returns to the firm's INITIAL state — where `raise` left it,
   * since raising deliberately does not move it either.
   */
  async reconcileFiling(
    tenantId: string,
    workItemId: string,
    discharged: boolean,
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<void> {
    // Most work items are not a filing. This is the ordinary answer, and it
    // costs one indexed lookup rather than a state list nobody needs.
    const obligation = await this.deps.instances.findByWorkItem(tenantId, workItemId);
    if (obligation === null) return;

    // Already in the shape being asked for. Checked before the state list so a
    // repeated call is a single read.
    if (discharged === (obligation.filedOn !== null)) return;

    const states = await this.deps.states.list(tenantId);

    if (discharged) {
      const filed = filedState(states);
      if (filed === null) throw new NoFiledState();
      const filedOn = this.today();
      if (!(await this.deps.instances.markFiled(tenantId, obligation.id, filedOn, filed.id))) {
        return; // somebody else got there first; their event is the one that counts
      }
      await this.deps.events.recordEvent({
        tenantId,
        verb: "obligation.filed",
        objectId: obligation.id,
        actor,
        payload: {
          workItemId,
          filedOn,
          statutoryDueOn: obligation.statutoryDueOn,
          // The one number a partner asks for afterwards, computed once here
          // rather than by whoever reads the log. Negative is early.
          daysLate: daysBetween(obligation.statutoryDueOn, filedOn),
        },
      });
      return;
    }

    const initial = initialState(states);
    if (initial === null) throw new NoInitialState();
    if (!(await this.deps.instances.clearFiled(tenantId, obligation.id, initial.id))) return;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation.filing_reversed",
      objectId: obligation.id,
      actor,
      payload: { workItemId, filedOn: obligation.filedOn, statutoryDueOn: obligation.statutoryDueOn },
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async calendar(tenantId: string, query: CalendarQuery): Promise<readonly CalendarRow[]> {
    if (query.from !== undefined && !isIsoDate(query.from)) {
      throw new InvalidWindow(query.from, query.to ?? "");
    }
    if (query.to !== undefined && !isIsoDate(query.to)) {
      throw new InvalidWindow(query.from ?? "", query.to);
    }
    return this.deps.instances.calendar(tenantId, query);
  }

  async obligation(tenantId: string, obligationId: string) {
    const found = await this.deps.instances.findById(tenantId, obligationId);
    if (!found) throw new ObligationNotFound(obligationId);
    return found;
  }

  /**
   * THE SILENCE CURE, as a read a screen renders.
   *
   * An engagement the firm is delivering that the calendar has produced nothing
   * for is either a perfectly ordinary advisory engagement or a hole. The
   * difference is a REASON, and every reason names something a partner can do
   * next. Nothing here is an error, and the screen must not render it as one —
   * `no_rule_names_this_service` is the normal state of most advisory work.
   */
  async coverage(tenantId: string): Promise<readonly CoverageGap[]> {
    return this.deps.calendarSource.gaps(tenantId);
  }

  /** Whether this firm has any rules at all — what the rules screen asks before
   *  offering to load the shipped pack. */
  async ruleCount(tenantId: string): Promise<number> {
    return this.deps.templates.countAll(tenantId);
  }

  /** Today for THIS firm (0071) — what the sweep, the spawn and a decision's
   *  `daysLate` are cut on. A sweep has no caller to send its day, and the UTC
   *  day is yesterday in India until 05:30. */
  private async firmDay(tenantId: string): Promise<IsoDate> {
    return dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
  }

  /** The SERVER's UTC day — kept for ONE thing: `filed_on`, which is the UTC
   *  day BY DECISION (Shrestha, 2026-08-30, board T3.3) with the cost stated;
   *  the work item's `completed_at` keeps the exact instant. Nothing else
   *  should call this. */
  private today(): IsoDate {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}

// ── reading a due rule off the wire ────────────────────────────────────────

/**
 * Turn the loose shape a handler parsed into the domain's, or refuse.
 *
 * Each kind names exactly its own fields and leaves the others null, so a rule
 * can never half-describe itself — the same shape `obligation_due_rule_chk`
 * enforces, checked here so the caller gets a sentence.
 */
function readDueRule(
  input: CreateRuleInput["dueRule"],
): DueRule | null {
  if (input === null || input === undefined) return null;
  if (!isDueRuleKind(input.kind)) throw new IncompleteDueRule(input.kind, "a known kind");

  if (input.kind === "day_of_month") {
    const offset = input.dueMonthOffset ?? null;
    const day = input.dueDayOfMonth ?? null;
    if (offset === null || day === null) {
      throw new IncompleteDueRule("day_of_month", "both a month offset and a day of the month");
    }
    return { kind: "day_of_month", dueMonthOffset: offset, dueDayOfMonth: day, dueDaysAfter: null };
  }

  const after = input.dueDaysAfter ?? null;
  if (after === null) throw new IncompleteDueRule("days_after", "a number of days");
  return { kind: "days_after", dueMonthOffset: null, dueDayOfMonth: null, dueDaysAfter: after };
}

/** Empty string and whitespace mean "cleared", not "a blank value". Every
 *  optional text column on a rule takes the same reading. */
/**
 * Whether two formulas say the same thing.
 *
 * Field by field rather than by reference, because `updateRule` resolves an
 * absent `dueRule` to the CURRENT one — so the two are frequently different
 * objects holding identical values, and a reference test would restate the
 * whole calendar every time somebody ticked "confirmed".
 */
function sameDueRule(a: DueRule | null, b: DueRule | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.dueMonthOffset === b.dueMonthOffset &&
    a.dueDayOfMonth === b.dueDayOfMonth &&
    a.dueDaysAfter === b.dueDaysAfter
  );
}

function trimToNull(v: string | null | undefined): string | null {
  return (v ?? "").trim() || null;
}

function seedDueRule(seed: SeedRule): DueRule | null {
  if (seed.dueRule === null) return null;
  return {
    kind: seed.dueRule,
    dueMonthOffset: seed.dueMonthOffset,
    dueDayOfMonth: seed.dueDayOfMonth,
    dueDaysAfter: seed.dueDaysAfter,
  };
}
