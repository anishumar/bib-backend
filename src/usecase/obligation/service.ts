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
  filedState,
  generatesDates,
  initialState,
  isDueRuleKind,
  isIsoDate,
  isObligationRecurrence,
  isRuleStatus,
  periodsBetween,
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
  NoFiledState,
  NoInitialState,
  ObligationNotFound,
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
  CoverageGap,
  NewObligationInstance,
  ObligationExceptionRepository,
  ObligationInstanceRepository,
  ObligationStateRepository,
  ObligationTemplateRepository,
  ServiceDirectory,
  TemplateEdit,
  TemplateRecord,
  TenantDirectory,
  WorkItemRaiser,
} from "./ports.js";

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
const REACH_BACK_DAYS = 90;

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

export interface GenerateReport {
  readonly tenantId: string;
  readonly created: number;
  readonly raised: number;
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
  readonly instances: ObligationInstanceRepository;
  readonly calendarSource: CalendarSource;
  readonly services: ServiceDirectory;
  readonly workItems: WorkItemRaiser;
  readonly tenants: TenantDirectory;
  readonly events: EventSink;
  readonly ids: IdGen;
  readonly clock: Clock;
}

export interface CreateRuleInput {
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType?: string | null | undefined;
  readonly serviceEntryId?: string | null | undefined;
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
      sortOrder: s.sortOrder,
    }));
    if (missing.length === 0) return 0;

    await this.deps.states.createMany(missing);
    // ONE event, not five — a firm receiving its starting vocabulary is one
    // fact. `work_vocabulary.seeded`'s argument.
    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_vocabulary.seeded",
      objectId: tenantId,
      actor,
      payload: { states: missing.map((s) => s.code) },
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
        serviceEntryId: null,
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
        supersedesId: null,
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

  // ── writing rules ────────────────────────────────────────────────────────

  async listRules(tenantId: string): Promise<readonly TemplateRecord[]> {
    return this.deps.templates.list(tenantId);
  }

  async createRule(input: CreateRuleInput, actor: Actor): Promise<ObligationTemplate> {
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

    const serviceEntryId = input.serviceEntryId ?? null;
    if (serviceEntryId !== null) {
      const key = await this.deps.services.serviceKey(input.tenantId, serviceEntryId);
      if (key === null) throw new ServiceNotFound(serviceEntryId);
    }

    const created = await this.deps.templates.createIfAbsent({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction,
      entityType: (input.entityType ?? "").trim() || null,
      serviceEntryId,
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
    });
    if (!created) throw new TemplateKeyTaken(input.jurisdiction, name, rulePack);

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
        coverage: coverageOf(created),
        leadTimeDays: created.leadTimeDays,
      },
    });
    return created;
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
  async updateRule(
    tenantId: string,
    templateId: string,
    edit: TemplateEdit & { readonly status?: string | undefined },
    actor: Actor,
  ): Promise<ObligationTemplate> {
    const current = await this.deps.templates.findById(tenantId, templateId);
    if (!current) throw new TemplateNotFound(templateId);

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

    const serviceEntryId =
      edit.serviceEntryId === undefined ? current.serviceEntryId : edit.serviceEntryId;
    if (serviceEntryId !== null && serviceEntryId !== current.serviceEntryId) {
      const key = await this.deps.services.serviceKey(tenantId, serviceEntryId);
      if (key === null) throw new ServiceNotFound(serviceEntryId);
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
      serviceEntryId,
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

    // A NEW LEAD TIME MOVES THE CALENDAR THAT IS ALREADY THERE.
    //
    // Found by using the rules screen. The sweep materialises a year ahead and
    // generation is idempotent, so without this a partner could set T-X and
    // watch nothing happen for twelve months — a control that looks live and is
    // inert, which is the trap this codebase keeps naming. It moves only rows
    // nobody has started, and never the statutory date.
    const redated =
      updated.leadTimeDays === current.leadTimeDays
        ? 0
        : await this.deps.instances.redateUnstarted(tenantId, templateId, updated.leadTimeDays);

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
          : {
              leadTimeFrom: current.leadTimeDays,
              leadTimeTo: updated.leadTimeDays,
              // How many filings this actually moved. The number a partner
              // wants back, and the one that makes the change auditable.
              redated,
            }),
        ...(updated.isActive === current.isActive ? {} : { isActive: updated.isActive }),
        ...(coverageOf(updated) === coverageOf(current)
          ? {}
          : { coverageFrom: coverageOf(current), coverageTo: coverageOf(updated) }),
      },
    });
    return updated;
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
  ): Promise<DueRuleException> {
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
      },
    });
    return created;
  }

  async removeException(
    tenantId: string,
    templateId: string,
    periodEndMonth: number,
    actor: Actor,
  ): Promise<void> {
    const template = await this.deps.templates.findById(tenantId, templateId);
    if (!template) throw new TemplateNotFound(templateId);
    const held = await this.deps.exceptions.listFor(tenantId, templateId);
    if (!held.some((e) => e.periodEndMonth === periodEndMonth)) {
      throw new ExceptionNotFound(String(periodEndMonth));
    }
    await this.deps.exceptions.withdraw(tenantId, templateId, periodEndMonth);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "obligation_rule.exception_removed",
      objectId: templateId,
      actor,
      payload: { periodEndMonth },
    });
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
          raised: 0,
          rulesWithNoSubjects: [],
          uncoveredEngagements: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reports;
  }

  async sweepTenant(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<GenerateReport> {
    const today = this.today();
    const generated = await this.generate(
      tenantId,
      { from: addDays(today, -REACH_BACK_DAYS), to: addDays(today, HORIZON_DAYS) },
      actor,
    );
    const raised = await this.raise(tenantId, today, actor);
    // Counted every sweep rather than on request, so the number reaches the
    // worker log as well as the screen. A gap nobody looks at is the silence
    // this whole mechanism exists to break.
    const gaps = await this.deps.calendarSource.gaps(tenantId);
    return { ...generated, raised, uncoveredEngagements: gaps.length };
  }

  /**
   * Create every obligation falling due in a window, for one firm.
   *
   * Idempotent — the unique key on (tenant, template, entity, period start)
   * means running it twice a day for a year changes nothing after the first
   * time. That is T3.2's acceptance line and it holds structurally rather than
   * by care.
   */
  async generate(
    tenantId: string,
    window: { readonly from: IsoDate; readonly to: IsoDate },
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<Omit<GenerateReport, "raised" | "uncoveredEngagements">> {
    if (!isIsoDate(window.from) || !isIsoDate(window.to) || window.from > window.to) {
      throw new InvalidWindow(window.from, window.to);
    }

    const rules = await this.deps.templates.listGenerating(tenantId);
    // A firm with no rules is not using the compliance calendar. A NORMAL
    // state, not a misconfiguration — and the sweep runs across every firm, so
    // throwing here would take the worker down for one of them.
    if (rules.length === 0) {
      return { tenantId, created: 0, rulesWithNoSubjects: [] };
    }

    const states = await this.deps.states.list(tenantId);
    const start = initialState(states);
    if (!start) throw new NoInitialState();

    const pending: NewObligationInstance[] = [];
    const barren: string[] = [];
    // The cap is checked in three places rather than one because a `break`
    // only leaves the loop it is in, and this is three deep. A flag reads worse
    // than a labelled break and survives somebody adding a fourth level.
    let full = false;

    for (const { template, exceptions } of rules) {
      if (full) break;
      // The generator's own filter, named once in the domain so the rules
      // screen and this loop cannot disagree about what "generating" means.
      if (!generatesDates(template)) continue;

      const subjects = await this.deps.calendarSource.subjectsFor(tenantId, {
        jurisdiction: template.jurisdiction,
        entityType: template.entityType,
        serviceEntryId: template.serviceEntryId,
      });
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
          if (pending.length >= GENERATE_BATCH) {
            full = true;
            break;
          }

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
      return { tenantId, created: 0, rulesWithNoSubjects: barren };
    }

    const created = await this.deps.instances.createIfAbsent(pending);

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

    return { tenantId, created: created.length, rulesWithNoSubjects: barren };
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
      const workItemId = await this.deps.workItems.raiseForObligation(
        tenantId,
        {
          entityPartyId: o.entityPartyId,
          engagementId: o.engagementId,
          serviceEntryId: o.serviceEntryId,
          title: `${o.templateName} — ${o.entityName ?? "entity"} — ${o.periodLabel}`,
          description: o.authority ? `Filed with ${o.authority}.` : null,
          // The STATUTORY date on the task, never the internal one: the task is
          // due when the law says, and the internal target is only what caused
          // it to appear this early.
          dueOn: o.statutoryDueOn,
        },
        actor,
      );
      await this.deps.instances.attachWorkItem(tenantId, o.id, workItemId);
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

  /** The caller's day is the caller's, and this default is the honest fallback
   *  for one that did not say. `slice(0, 10)` on a UTC instant is yesterday in
   *  India before 05:30 — every route that takes a date takes it from the
   *  browser for exactly that reason. */
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
