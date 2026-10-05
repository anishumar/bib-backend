// In-memory doubles for the compliance calendar's ports (T3.2).
//
// They are STORES rather than spies: a test builds the real `ObligationService`
// over these and then asserts on what is in them, exactly as the tenancy and
// work-item fakes do. A stub that recorded "createIfAbsent was called twice"
// could not have proved the acceptance line, because the whole claim is that
// the SECOND call changes nothing — and only a store can show that.
import {
  mayBeWithdrawn,
  type DueRuleException,
  type ObligationInstance,
  type ObligationState,
  type ObligationTemplate,
  type ResolutionOption,
} from "../domain/obligation/model";
import type { Actor } from "../domain/ledger/model";
import { filingDay } from "../domain/obligation/filing-zone";
import { dayInZone } from "../domain/scheduler/zone";
import type {
  CalendarQuery,
  CalendarRow,
  CalendarSource,
  CalendarSubject,
  CompliancePolicySource,
  CoverageGap,
  DecisionRow,
  MissableObligation,
  NewException,
  NewLinkOnCreate,
  NewObligationInstance,
  NewObligationState,
  NewObligationTemplate,
  NewResolutionOption,
  ObligationExceptionRepository,
  ObligationInstanceRepository,
  ObligationStatePatch,
  ObligationStateRepository,
  ObligationTemplateRepository,
  ProposalOutcome,
  RaisableObligation,
  ResolutionOptionPatch,
  ResolutionOptionRepository,
  RestatedInstance,
  RestoredInstance,
  RuleServiceLinkRepository,
  ServiceDirectory,
  ServiceRef,
  SpawnedInstance,
  SupersedeResult,
  TemplatePatch,
  TemplateRecord,
  TenantDirectory,
  UnlinkOutcome,
  UnstartedInstance,
  UsedInService,
  WorkItemRaiser,
} from "../usecase/obligation/ports";

export class FakeObligationTemplateRepo implements ObligationTemplateRepository {
  readonly rows: ObligationTemplate[] = [];
  /** The exception store, shared with `FakeObligationExceptionRepo` so the two
   *  see one world — as the real adapters do, sharing one database. */
  exceptions?: FakeObligationExceptionRepo;
  /** The calendar, for the handover `supersede` makes in the same transaction
   *  (0303). Unset, a supersession hands nothing over. */
  instances?: FakeObligationInstanceRepo;
  /** The catalogue links (0309), for `usedIn`, for `listGenerating`'s link
   *  test and for links written in the same act as the rule. Unset, every rule
   *  is on no service, which is decision 1's reading of "nothing linked", and
   *  a create HANDED links refuses rather than dropping them unseen. */
  links?: FakeRuleServiceLinks;

  create(t: NewObligationTemplate): Promise<ObligationTemplate> {
    return this.createIfAbsent(t).then((r) => {
      if (!r) throw new Error("conflict");
      return r;
    });
  }

  createIfAbsent(
    t: NewObligationTemplate,
    links: readonly NewLinkOnCreate[] = [],
  ): Promise<ObligationTemplate | null> {
    // The rule's own identity, exactly as the unique key defines it.
    const held = this.rows.find(
      (r) =>
        r.tenantId === t.tenantId &&
        r.jurisdiction === t.jurisdiction &&
        r.name === t.name &&
        r.rulePack === t.rulePack,
    );
    if (held) return Promise.resolve(null);
    // 0303's trigger, modelled: a rule that replaces nothing is its own chain,
    // and a successor inherits its predecessor's.
    const lineageId =
      t.supersedesId === null ? t.id : (this.rows.find((r) => r.id === t.supersedesId)?.lineageId ?? t.id);
    // A harness with no link store cannot write the links it is handed, and
    // answering success anyway is a rule that reads as linked and is on no
    // service. Refused before anything is written, as the adapter's one
    // transaction would leave nothing behind.
    const store = this.links;
    if (links.length > 0 && !store) {
      return Promise.reject(
        new Error("FakeObligationTemplateRepo was handed links but has no link store: wire `links`"),
      );
    }
    const row: ObligationTemplate = { ...t, periodBasis: t.periodBasis ?? "rule_calendar", lineageId, isActive: true };
    this.rows.push(row);
    // The links in the SAME act, as the adapter writes them in one transaction.
    for (const link of links) {
      store?.write(t.tenantId, {
        id: link.id,
        lineageId,
        serviceEntryId: link.serviceEntryId,
        byUserId: link.byUserId,
      });
    }
    return Promise.resolve(row);
  }

  chain(tenantId: string, lineageId: string): Promise<readonly ObligationTemplate[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.lineageId === lineageId)
        .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? "")),
    );
  }

  supersede(
    tenantId: string,
    predecessorId: string,
    t: NewObligationTemplate,
    handover: readonly RestatedInstance[],
  ): Promise<SupersedeResult> {
    // BOTH HALVES OR NEITHER, the same as the SQL. The fake models the
    // atomicity rather than only the happy path: a test that could observe a
    // closed predecessor with no successor would be exercising a state the real
    // repository cannot produce.
    const i = this.rows.findIndex((r) => r.id === predecessorId && r.tenantId === tenantId);
    const predecessor = this.rows[i];
    if (i < 0 || !predecessor) throw new Error("obligation_template predecessor vanished");
    const taken = this.rows.some(
      (r) =>
        r.tenantId === t.tenantId &&
        r.jurisdiction === t.jurisdiction &&
        r.name === t.name &&
        r.rulePack === t.rulePack,
    );
    if (taken) throw new Error("obligation_template successor conflicted");

    const successor: ObligationTemplate = {
      ...t,
      periodBasis: t.periodBasis ?? "rule_calendar",
      supersedesId: predecessorId,
      // The chain carries over, and with it every service link (0309).
      lineageId: predecessor.lineageId,
      isActive: true,
    };
    this.rows[i] = { ...predecessor, effectiveTo: t.effectiveFrom };
    this.rows.push(successor);

    // The handover, with the SQL's guard: only rows still on the predecessor,
    // past the cutover, and untouched by anybody.
    const calendar = this.instances?.rows ?? [];
    const cutover = t.effectiveFrom ?? "";
    const handedOver: string[] = [];
    for (const next of handover) {
      const at = calendar.findIndex((r) => r.id === next.id && r.tenantId === tenantId);
      const held = calendar[at];
      if (at < 0 || !held) continue;
      if (held.templateId !== predecessorId || held.periodStart < cutover) continue;
      if (held.workItemId !== null || held.filedOn !== null || held.resolvedAt !== null) continue;
      // A withdrawn row stays where it is (0309); the generator re-pins it if
      // it is ever restored.
      if (held.withdrawnAt !== null) continue;
      calendar[at] = {
        ...held,
        templateId: t.id,
        statutoryDueOn: next.statutoryDueOn,
        internalTargetOn: next.internalTargetOn,
      };
      handedOver.push(held.id);
    }
    const kept = calendar.filter(
      (r) => r.templateId === predecessorId && r.periodStart >= cutover && r.withdrawnAt === null,
    ).length;
    return Promise.resolve({ rule: successor, handedOver, kept });
  }

  /** The chain a rule belongs to, as 0303's trigger derived it on insert. */
  lineageOf(templateId: string): string {
    return this.rows.find((r) => r.id === templateId)?.lineageId ?? templateId;
  }

  findById(tenantId: string, templateId: string): Promise<ObligationTemplate | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === templateId) ?? null,
    );
  }

  update(tenantId: string, templateId: string, patch: TemplatePatch): Promise<ObligationTemplate> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === templateId);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`no template ${templateId}`);
    const next: ObligationTemplate = { ...current, ...patch };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  list(tenantId: string): Promise<readonly TemplateRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
        .map((template) => ({
          template,
          exceptions: this.exceptions?.forTemplate(template.id) ?? [],
          usedIn: this.links?.namedFor(tenantId, template.lineageId) ?? [],
          // Every row ever, withdrawn ones included — the adapter's count.
          instanceCount:
            this.instances?.rows.filter((i) => i.tenantId === tenantId && i.templateId === template.id)
              .length ?? 0,
        })),
    );
  }

  listGenerating(
    tenantId: string,
  ): Promise<
    readonly {
      template: ObligationTemplate;
      exceptions: readonly DueRuleException[];
      linkedServices: number;
    }[]
  > {
    // The adapter's WHERE, modelled: active, a formula, confirmed, and a chain
    // on at least one service. The event test stays with `generatesDates`.
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.tenantId === tenantId && r.isActive && r.dueRule !== null && r.status === "confirmed",
        )
        .map((template) => ({
          template,
          exceptions: this.exceptions?.forTemplate(template.id) ?? [],
          linkedServices: this.links?.namedFor(tenantId, template.lineageId).length ?? 0,
        }))
        .filter((r) => r.linkedServices > 0),
    );
  }

  countAll(tenantId: string): Promise<number> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId).length);
  }
}

export class FakeObligationExceptionRepo implements ObligationExceptionRepository {
  /** `templateId -> live exceptions`. Withdrawn ones are dropped from the map
   *  and kept in `withdrawn`, so a test can assert the row was not destroyed. */
  readonly byTemplate = new Map<string, DueRuleException[]>();
  readonly withdrawn: { templateId: string; periodEndMonth: number }[] = [];

  forTemplate(templateId: string): readonly DueRuleException[] {
    return this.byTemplate.get(templateId) ?? [];
  }

  create(e: NewException): Promise<DueRuleException> {
    return this.createIfAbsent(e).then((r) => {
      if (!r) throw new Error("conflict");
      return r;
    });
  }

  createIfAbsent(e: NewException): Promise<DueRuleException | null> {
    const held = this.byTemplate.get(e.templateId) ?? [];
    if (held.some((x) => x.periodEndMonth === e.periodEndMonth)) return Promise.resolve(null);
    held.push(e.dueRule);
    this.byTemplate.set(e.templateId, held);
    return Promise.resolve(e.dueRule);
  }

  listFor(_tenantId: string, templateId: string): Promise<readonly DueRuleException[]> {
    return Promise.resolve(this.forTemplate(templateId));
  }

  withdraw(_tenantId: string, templateId: string, periodEndMonth: number): Promise<void> {
    const held = this.byTemplate.get(templateId) ?? [];
    this.byTemplate.set(
      templateId,
      held.filter((x) => x.periodEndMonth !== periodEndMonth),
    );
    this.withdrawn.push({ templateId, periodEndMonth });
    return Promise.resolve();
  }
}

export class FakeObligationStateRepo implements ObligationStateRepository {
  readonly rows: ObligationState[] = [];

  list(tenantId: string): Promise<readonly ObligationState[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId));
  }

  createMany(states: readonly NewObligationState[]): Promise<readonly ObligationState[]> {
    const made = states.map((s): ObligationState => ({ ...s, isActive: true }));
    this.rows.push(...made);
    return Promise.resolve(made);
  }

  create(state: NewObligationState): Promise<ObligationState> {
    this.clearDestinations(state, null);
    const made: ObligationState = { ...state, isActive: true };
    this.rows.push(made);
    return Promise.resolve(made);
  }

  findById(tenantId: string, stateId: string): Promise<ObligationState | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === stateId) ?? null,
    );
  }

  findByCode(tenantId: string, code: string): Promise<ObligationState | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.code === code) ?? null,
    );
  }

  update(
    tenantId: string,
    stateId: string,
    patch: ObligationStatePatch,
  ): Promise<ObligationState> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === stateId);
    const held = this.rows[i];
    if (i < 0 || held === undefined) {
      return Promise.reject(new Error(`no state ${stateId}`));
    }
    this.clearDestinations(patch, stateId);
    const next: ObligationState = { ...held, ...patch };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  /**
   * The same release-then-claim the Postgres adapter does in one transaction.
   *
   * MODELLED rather than skipped, because a fake that lets two rows hold
   * `is_missed` would let a unit test pass on a vocabulary the database refuses
   * — and `missedState()` would then be answering with whichever row happened to
   * be first in the array.
   */
  private clearDestinations(
    flags: {
      readonly isInitial: boolean;
      readonly isFiled: boolean;
      readonly isMissed: boolean;
      readonly isResolution: boolean;
    },
    exceptId: string | null,
  ): void {
    for (let i = 0; i < this.rows.length; i += 1) {
      const r = this.rows[i];
      if (r === undefined || r.id === exceptId) continue;
      this.rows[i] = {
        ...r,
        isInitial: flags.isInitial ? false : r.isInitial,
        isFiled: flags.isFiled ? false : r.isFiled,
        isMissed: flags.isMissed ? false : r.isMissed,
        isResolution: flags.isResolution ? false : r.isResolution,
      };
    }
  }
}

export class FakeResolutionOptionRepo implements ResolutionOptionRepository {
  readonly rows: ResolutionOption[] = [];

  list(tenantId: string): Promise<readonly ResolutionOption[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId));
  }

  createMany(options: readonly NewResolutionOption[]): Promise<readonly ResolutionOption[]> {
    const made = options
      .filter((o) => !this.rows.some((r) => r.tenantId === o.tenantId && r.code === o.code))
      .map((o): ResolutionOption => ({ ...o, status: "unconfirmed", isActive: true }));
    this.rows.push(...made);
    return Promise.resolve(made);
  }

  create(option: NewResolutionOption): Promise<ResolutionOption> {
    const made: ResolutionOption = { ...option, status: "unconfirmed", isActive: true };
    this.rows.push(made);
    return Promise.resolve(made);
  }

  findById(tenantId: string, optionId: string): Promise<ResolutionOption | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === optionId) ?? null,
    );
  }

  findByCode(tenantId: string, code: string): Promise<ResolutionOption | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.code === code) ?? null,
    );
  }

  update(
    tenantId: string,
    optionId: string,
    patch: ResolutionOptionPatch,
  ): Promise<ResolutionOption> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === optionId);
    const held = this.rows[i];
    if (i < 0 || held === undefined) {
      return Promise.reject(new Error(`no resolution option ${optionId}`));
    }
    const next: ResolutionOption = { ...held, ...patch };
    this.rows[i] = next;
    return Promise.resolve(next);
  }
}

/**
 * The firm's go-live floor, settable by a test.
 *
 * Null by default, which is what an unpublished policy means and therefore the
 * behaviour every existing test already assumes: no floor, everything is asked
 * about.
 */
export class FakeCompliancePolicySource implements CompliancePolicySource {
  floor: string | null = null;

  missedFromOn(_tenantId: string): Promise<string | null> {
    return Promise.resolve(this.floor);
  }
}

export class FakeObligationInstanceRepo implements ObligationInstanceRepository {
  readonly rows: ObligationInstance[] = [];
  /** The rules, so this store can key on the LINEAGE as 0303 does. Unset, a
   *  rule is its own lineage — true of every rule nobody superseded. */
  templates?: FakeObligationTemplateRepo;

  private lineage(templateId: string): string {
    return this.templates?.lineageOf(templateId) ?? templateId;
  }

  /** The chain a calendar row's rule belongs to — what the link store keys
   *  its withdrawal on. */
  lineageFor(templateId: string): string {
    return this.lineage(templateId);
  }

  /** The links and the engagements, for the write's own link test (0309).
   *  Either unset, the test is skipped: an unwired harness proposes only what
   *  it means to write. */
  links?: FakeRuleServiceLinks;
  engagements?: FakeCalendarSource;

  /** `STILL_LINKED` in the adapter: the proposal's chain still has a live link
   *  to its engagement's service at the moment of the write. */
  private stillLinked(r: NewObligationInstance): boolean {
    if (r.engagementId === null || !this.links || !this.engagements) return true;
    const subject = this.engagements.subjects.find((s) => s.engagementId === r.engagementId);
    if (!subject) return false;
    return this.links.isLive(r.tenantId, this.lineage(r.templateId), subject.serviceEntryId);
  }

  createIfAbsent(rows: readonly NewObligationInstance[]): Promise<ProposalOutcome> {
    const made: SpawnedInstance[] = [];
    const restored: RestoredInstance[] = [];
    for (const r of rows) {
      if (!this.stillLinked(r)) continue;
      // THE RE-RUN KEY, and the whole point of this fake being a store: the
      // second proposal of the same (lineage, entity, period) must produce
      // nothing at all — including a period an earlier rule in the chain
      // already holds.
      const lineage = this.lineage(r.templateId);
      const at = this.rows.findIndex(
        (x) =>
          x.tenantId === r.tenantId &&
          this.lineage(x.templateId) === lineage &&
          x.entityPartyId === r.entityPartyId &&
          x.periodStart === r.periodStart,
      );
      const held = this.rows[at];
      if (held) {
        // A WITHDRAWN untouched row comes back in place (0309): same id, the
        // proposal's rule, engagement and dates.
        if (
          held.withdrawnAt !== null &&
          held.workItemId === null &&
          held.filedOn === null &&
          held.resolvedAt === null
        ) {
          const wasWithdrawnAt = held.withdrawnAt;
          this.rows[at] = {
            ...held,
            templateId: r.templateId,
            engagementId: r.engagementId,
            statutoryDueOn: r.statutoryDueOn,
            internalTargetOn: r.internalTargetOn,
            stateId: r.stateId,
            withdrawnAt: null,
            withdrawnByUserId: null,
            withdrawnReason: null,
          };
          restored.push({
            id: held.id,
            templateId: r.templateId,
            entityPartyId: held.entityPartyId,
            engagementId: r.engagementId,
            periodLabel: held.periodLabel,
            statutoryDueOn: r.statutoryDueOn,
            internalTargetOn: r.internalTargetOn,
            withdrawnAt: wasWithdrawnAt,
          });
        }
        continue;
      }
      // A period cut on the client's year never overlaps one already held
      // (0358), the adapter's NOT EXISTS, modelled.
      if (
        (r.periodBasis ?? "rule_calendar") !== "rule_calendar" &&
        this.rows.some(
          (x) =>
            x.tenantId === r.tenantId &&
            this.lineage(x.templateId) === lineage &&
            x.entityPartyId === r.entityPartyId &&
            x.periodStart !== r.periodStart &&
            x.periodStart <= r.periodEnd &&
            x.periodEnd >= r.periodStart &&
            x.withdrawnAt === null,
        )
      ) {
        continue;
      }
      this.rows.push({
        ...r,
        periodBasis: r.periodBasis ?? "rule_calendar",
        workItemId: null,
        filedOn: null,
        filedByWorkItemId: null,
        resolutionOptionId: null,
        resolutionReason: null,
        resolvedAt: null,
        withdrawnAt: null,
        withdrawnByUserId: null,
        withdrawnReason: null,
      });
      made.push({
        id: r.id,
        templateId: r.templateId,
        entityPartyId: r.entityPartyId,
        engagementId: r.engagementId,
        periodLabel: r.periodLabel,
        statutoryDueOn: r.statutoryDueOn,
        internalTargetOn: r.internalTargetOn,
      });
    }
    return Promise.resolve({ created: made, restored });
  }

  findById(tenantId: string, obligationId: string): Promise<ObligationInstance | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === obligationId) ?? null,
    );
  }

  calendar(tenantId: string, query: CalendarQuery): Promise<readonly CalendarRow[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.withdrawnAt === null)
        .filter((r) => query.filedByWorkItemId === undefined || r.filedByWorkItemId === query.filedByWorkItemId)
        .map(
          (r): CalendarRow => ({
            id: r.id,
            name: r.templateId,
            authority: null,
            module: null,
            entityPartyId: r.entityPartyId,
            entityName: null,
            clientName: null,
            periodLabel: r.periodLabel,
            statutoryDueOn: r.statutoryDueOn,
            internalTargetOn: r.internalTargetOn,
            stateCode: r.filedOn === null ? "pending" : "filed",
            stateName: r.filedOn === null ? "Pending" : "Filed",
            isTerminal: r.filedOn !== null,
            needsDecision: false,
            workItemId: r.workItemId,
            filedOn: r.filedOn,
            filedByWorkItemId: r.filedByWorkItemId,
            filedByTitle: null,
            periodBasis: r.periodBasis,
            ruleYearStartMonth: this.templates?.rows.find((t) => t.id === r.templateId)?.fiscalYearStartMonth ?? 4,
            filingZone: this.filingZones.get(r.id) ?? this.firmZone,
            filingToday: dayInZone(query.now ?? new Date().toISOString(), this.filingZones.get(r.id) ?? this.firmZone),
            resolutionOptionId: r.resolutionOptionId,
            resolutionName: null,
            resolutionReason: r.resolutionReason,
            resolvedAt: r.resolvedAt,
            ruleUnconfirmed: true,
            rulePack: "test",
          }),
        ),
    );
  }

  listRaisable(
    tenantId: string,
    asOf: string,
    limit: number,
  ): Promise<readonly RaisableObligation[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            r.workItemId === null &&
            r.filedOn === null &&
            r.withdrawnAt === null &&
            r.internalTargetOn <= asOf,
        )
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          entityPartyId: r.entityPartyId,
          engagementId: r.engagementId,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          templateName: "Filing",
          authority: null,
          entityName: null,
        })),
    );
  }

  attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `WHERE work_item_id IS NULL AND withdrawn_at IS NULL`, modelled — a
    // redelivered raise is a no-op rather than a second task pointing at the
    // same filing, and a withdrawn filing gets no task.
    if (!row || row.workItemId !== null || row.withdrawnAt !== null) return Promise.resolve(false);
    this.rows[i] = { ...row, workItemId };
    return Promise.resolve(true);
  }

  detachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `WHERE work_item_id = $task AND filed_on IS NULL`, modelled.
    if (!row || row.workItemId !== workItemId || row.filedOn !== null) return Promise.resolve(false);
    this.rows[i] = { ...row, workItemId: null };
    return Promise.resolve(true);
  }

  findByWorkItem(tenantId: string, workItemId: string): Promise<ObligationInstance | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.workItemId === workItemId) ?? null,
    );
  }

  /** The zone the fake reads a filing's day in (the SQL's FILING_ZONE). */
  filingZone = "UTC";

  markFiled(
    tenantId: string,
    obligationId: string,
    filedAt: string,
    stateId: string,
    filedByWorkItemId: string,
    portalDay: string | null = null,
  ): Promise<string | null> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `AND filed_on IS NULL`, modelled — the guard that makes a second
    // completion of the same task write no second event.
    if (!row || row.filedOn !== null) return Promise.resolve(null);
    const filedOn = portalDay ?? dayInZone(filedAt, this.filingZone);
    this.rows[i] = { ...row, filedOn, stateId, filedByWorkItemId };
    return Promise.resolve(filedOn);
  }

  clearFiled(
    tenantId: string,
    obligationId: string,
    stateId: string,
    filedByWorkItemId: string,
  ): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `AND filed_by_work_item_id = $task`, modelled (0357).
    if (!row || row.filedOn === null || row.filedByWorkItemId !== filedByWorkItemId) {
      return Promise.resolve(false);
    }
    this.rows[i] = { ...row, filedOn: null, stateId, filedByWorkItemId: null };
    return Promise.resolve(true);
  }

  listFiledBy(tenantId: string, workItemId: string): Promise<readonly ObligationInstance[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.filedByWorkItemId === workItemId),
    );
  }

  /**
   * A period job's task, as the adapter reads it from `delivery.job` and the
   * task's engagement (Q063): the company, the job's period, and the rules its
   * service carries. Set by a test; an unknown task is not a period job's.
   */
  jobTasks = new Map<
    string,
    {
      readonly entityPartyId: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly templateIds: ReadonlySet<string>;
    }
  >();
  /** States the adapter reads as finished off `obligation_state`. */
  terminalStateIds = new Set<string>();

  listJobFilingsForTask(tenantId: string, workItemId: string): Promise<readonly ObligationInstance[]> {
    const t = this.jobTasks.get(workItemId);
    if (t === undefined) return Promise.resolve([]);
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.tenantId === tenantId &&
          r.entityPartyId === t.entityPartyId &&
          r.periodStart >= t.periodStart &&
          r.periodEnd <= t.periodEnd &&
          t.templateIds.has(r.templateId) &&
          r.filedOn === null &&
          r.withdrawnAt === null &&
          !this.terminalStateIds.has(r.stateId),
      ),
    );
  }

  /**
   * The sweep's candidates.
   *
   * `states` is injected rather than looked up, because this fake holds
   * instances and not vocabulary — the service passes the same list it read.
   * The conditions mirror `shouldBeFlaggedMissed` exactly, and the FLAGS are
   * what decide, never a code.
   */
  states: ObligationState[] = [];
  /** A filing's zone, by row id, as the adapter resolves it (Q070 Part B);
   *  a row not named is on the firm's zone. */
  readonly filingZones = new Map<string, string>();
  firmZone = "UTC";

  listMissable(
    tenantId: string,
    asOf: string,
    floor: string | null,
    limit: number,
    now: string,
  ): Promise<readonly MissableObligation[]> {
    const dayOf = (id: string) => filingDay(asOf, now, this.filingZones.get(id) ?? this.firmZone, this.firmZone);
    const out = this.rows
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        if (r.statutoryDueOn >= dayOf(r.id)) return false;
        if (r.filedOn !== null) return false;
        if (r.resolvedAt !== null) return false;
        if (r.withdrawnAt !== null) return false;
        if (floor !== null && r.statutoryDueOn < floor) return false;
        const st = this.states.find((x) => x.id === r.stateId);
        return st !== undefined && !st.isTerminal && !st.needsDecision;
      })
      .sort((a, b) => a.statutoryDueOn.localeCompare(b.statutoryDueOn))
      .slice(0, limit)
      .map(
        (r): MissableObligation => ({
          id: r.id,
          statutoryDueOn: r.statutoryDueOn,
          entityPartyId: r.entityPartyId,
          templateName: r.templateId,
          periodLabel: r.periodLabel,
          workItemId: r.workItemId,
          filingDay: dayOf(r.id),
          filingZone: this.filingZones.get(r.id) ?? this.firmZone,
        }),
      );
    return Promise.resolve(out);
  }

  markMissed(tenantId: string, obligationId: string, stateId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const held = this.rows[i];
    if (i < 0 || held === undefined) return Promise.resolve(false);
    // The guard is re-checked here and not only in `listMissable`, because that
    // is what the adapter's WHERE clause does — and it is what makes a second
    // sweep over the same row write no second event.
    const st = this.states.find((x) => x.id === held.stateId);
    if (held.filedOn !== null || held.resolvedAt !== null) return Promise.resolve(false);
    if (held.withdrawnAt !== null) return Promise.resolve(false);
    if (st === undefined || st.isTerminal || st.needsDecision) return Promise.resolve(false);
    this.rows[i] = { ...held, stateId };
    return Promise.resolve(true);
  }

  decisionQueue(tenantId: string, limit: number): Promise<readonly DecisionRow[]> {
    const out = this.rows
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        if (r.resolvedAt !== null || r.filedOn !== null) return false;
        if (r.withdrawnAt !== null) return false;
        const st = this.states.find((x) => x.id === r.stateId);
        return st !== undefined && st.needsDecision;
      })
      .sort((a, b) => a.statutoryDueOn.localeCompare(b.statutoryDueOn))
      .slice(0, limit)
      .map((r): DecisionRow => {
        const st = this.states.find((x) => x.id === r.stateId);
        return {
          id: r.id,
          name: r.templateId,
          authority: null,
          module: null,
          entityPartyId: r.entityPartyId,
          entityName: null,
          clientName: null,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          internalTargetOn: r.internalTargetOn,
          stateId: r.stateId,
          stateCode: st?.code ?? "",
          stateName: st?.name ?? "",
          workItemId: r.workItemId,
          ruleUnconfirmed: true,
        };
      });
    return Promise.resolve(out);
  }

  recordResolution(
    tenantId: string,
    obligationId: string,
    decision: { readonly optionId: string; readonly reason: string; readonly stateId: string },
  ): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const held = this.rows[i];
    if (i < 0 || held === undefined) return Promise.resolve(false);
    // `resolved_at IS NULL` — the double-submit guard, modelled.
    if (held.resolvedAt !== null) return Promise.resolve(false);
    this.rows[i] = {
      ...held,
      resolutionOptionId: decision.optionId,
      resolutionReason: decision.reason,
      resolvedAt: "2026-01-01T00:00:00.000Z",
      stateId: decision.stateId,
    };
    return Promise.resolve(true);
  }

  listUnstarted(tenantId: string, templateId: string): Promise<readonly UnstartedInstance[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            r.templateId === templateId &&
            // Only what nobody has started — a task on a desk keeps the date
            // its owner is working to — and never a withdrawn row.
            r.workItemId === null &&
            r.filedOn === null &&
            r.withdrawnAt === null,
        )
        .map((r) => ({
          id: r.id,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          internalTargetOn: r.internalTargetOn,
        })),
    );
  }

  restate(tenantId: string, rows: readonly RestatedInstance[]): Promise<number> {
    let moved = 0;
    for (const next of rows) {
      const i = this.rows.findIndex((r) => r.id === next.id && r.tenantId === tenantId);
      const held = this.rows[i];
      if (i < 0 || !held) continue;
      // The same guard the SQL carries: the ids came from a snapshot, and
      // between that read and this write somebody may have picked the task up.
      if (held.workItemId !== null || held.filedOn !== null || held.withdrawnAt !== null) continue;
      this.rows[i] = {
        ...held,
        statutoryDueOn: next.statutoryDueOn,
        internalTargetOn: next.internalTargetOn,
      };
      moved += 1;
    }
    return Promise.resolve(moved);
  }

  countFor(tenantId: string, templateId: string): Promise<number> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.templateId === templateId).length,
    );
  }

  countLiveFor(tenantId: string, templateId: string): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.tenantId === tenantId && r.templateId === templateId && r.withdrawnAt === null,
      ).length,
    );
  }
}

export class FakeCalendarSource implements CalendarSource {
  /** Every LIVE engagement the fake knows about, with the facts a subject is
   *  matched on: the entity's country and type, and the SERVICE the
   *  engagement's letter line pinned. A test adds these rather than a
   *  database. */
  readonly subjects: (Omit<CalendarSubject, "endsOn"> & {
    /** Absent reads as not ended. */
    readonly endsOn?: string | null;
    readonly jurisdiction: string;
    readonly entityType: string | null;
  })[] = [];
  readonly gapRows: CoverageGap[] = [];
  /** The catalogue links (0309). Unset, nothing is linked, so nothing is
   *  reached: decision 1, exactly as the SQL answers it. */
  links?: FakeRuleServiceLinks;

  subjectsFor(
    tenantId: string,
    rule: {
      readonly lineageId: string;
      readonly jurisdiction: string;
      readonly entityType: string | null;
    },
  ): Promise<readonly CalendarSubject[]> {
    return Promise.resolve(
      this.subjects
        .filter((s) => s.jurisdiction === rule.jurisdiction)
        .filter((s) => rule.entityType === null || s.entityType === rule.entityType)
        // THE LINK: the chain is on the service this engagement bought.
        .filter((s) => this.links?.isLive(tenantId, rule.lineageId, s.serviceEntryId) ?? false)
        // The adapter's promised order, so the fake keeps the same first one.
        .sort(
          (a, b) =>
            a.effectiveFrom.localeCompare(b.effectiveFrom) ||
            a.engagementId.localeCompare(b.engagementId),
        )
        .map((s) => ({
          entityPartyId: s.entityPartyId,
          engagementId: s.engagementId,
          effectiveFrom: s.effectiveFrom,
          serviceEntryId: s.serviceEntryId,
          endsOn: s.endsOn ?? null,
          financialYearEnd: s.financialYearEnd ?? null,
          returnPeriods: s.returnPeriods ?? [],
        })),
    );
  }

  gaps(_tenantId: string): Promise<readonly CoverageGap[]> {
    return Promise.resolve(this.gapRows);
  }
}

export class FakeObligationServices implements ServiceDirectory {
  readonly keys = new Map<string, string>();
  /** A service's display name, for `usedIn`. Absent falls back to null, as a
   *  service with no version reads. */
  readonly names = new Map<string, string>();

  findService(_tenantId: string, entryId: string): Promise<ServiceRef | null> {
    const key = this.keys.get(entryId);
    return Promise.resolve(key === undefined ? null : { key, name: this.names.get(entryId) ?? null });
  }
}

interface FakeLinkRow {
  readonly id: string;
  readonly tenantId: string;
  readonly lineageId: string;
  readonly serviceEntryId: string;
  readonly linkedAt: string;
  readonly linkedByUserId: string | null;
  unlinkedAt: string | null;
  unlinkedByUserId: string | null;
}

/**
 * Which catalogue services owe which filing (0309), as a STORE.
 *
 * Its `unlink` re-implements the adapter's withdrawal rule in TypeScript,
 * using the domain's `mayBeWithdrawn` for the first half and the calendar's
 * subjects for "another linked service still covers it", so a unit test over
 * it is exactly as honest as the mirror is. The integration test runs the SQL.
 */
export class FakeRuleServiceLinks implements RuleServiceLinkRepository {
  readonly rows: FakeLinkRow[] = [];
  /** Service keys and names, for `usedIn`, and the catalogue 0309's service
   *  key is checked against: an entry it does not know is not a service. */
  services?: FakeObligationServices;
  /** The live engagements (which entity, which service), for the cover test. */
  calendar?: FakeCalendarSource;
  /** The calendar rows and their states, which `unlink` withdraws from. */
  instances?: FakeObligationInstanceRepo;
  /** The rules, for 0309's root-lineage key. Unset, that key is not modelled:
   *  every harness that writes links wires it. */
  templates?: FakeObligationTemplateRepo;
  private n = 0;

  /** Monotonic instants, so `linkedAt` orders the way the database's would. */
  private instant(): string {
    this.n += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.n)).toISOString();
  }

  isLive(tenantId: string, lineageId: string, serviceEntryId: string): boolean {
    return this.rows.some(
      (l) =>
        l.tenantId === tenantId &&
        l.lineageId === lineageId &&
        l.serviceEntryId === serviceEntryId &&
        l.unlinkedAt === null,
    );
  }

  namedFor(tenantId: string, lineageId: string): readonly UsedInService[] {
    return this.rows
      .filter((l) => l.tenantId === tenantId && l.lineageId === lineageId && l.unlinkedAt === null)
      .map((l) => ({
        serviceEntryId: l.serviceEntryId,
        serviceKey: this.services?.keys.get(l.serviceEntryId) ?? l.serviceEntryId,
        serviceName: this.services?.names.get(l.serviceEntryId) ?? null,
        linkedAt: l.linkedAt,
      }));
  }

  /**
   * 0309's keys, modelled, and then the partial unique index: one LIVE link
   * per (chain, service).
   *
   * The two composite keys refuse by their own names, as the adapter's
   * insert does, so a caller that passes a rule's own id where the CHAIN's
   * belongs (a successor's id is not a lineage) or links something the
   * catalogue does not hold as a service fails here and not only against
   * Postgres, where it surfaces as a 500.
   */
  write(
    tenantId: string,
    input: { id: string; lineageId: string; serviceEntryId: string; byUserId: string | null },
  ): boolean {
    if (
      this.templates &&
      !this.templates.rows.some(
        (t) => t.tenantId === tenantId && t.id === input.lineageId && t.lineageId === input.lineageId,
      )
    ) {
      throw new Error("obligation_rule_service_lineage_root_fkey");
    }
    if (this.services && !this.services.keys.has(input.serviceEntryId)) {
      throw new Error("obligation_rule_service_service_fkey");
    }
    if (this.isLive(tenantId, input.lineageId, input.serviceEntryId)) return false;
    this.rows.push({
      id: input.id,
      tenantId,
      lineageId: input.lineageId,
      serviceEntryId: input.serviceEntryId,
      linkedAt: this.instant(),
      linkedByUserId: input.byUserId,
      unlinkedAt: null,
      unlinkedByUserId: null,
    });
    return true;
  }

  usedIn(tenantId: string, lineageId: string): Promise<readonly UsedInService[]> {
    return Promise.resolve(this.namedFor(tenantId, lineageId));
  }

  link(
    tenantId: string,
    input: {
      readonly id: string;
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
    },
  ): Promise<boolean> {
    try {
      return Promise.resolve(this.write(tenantId, { ...input }));
    } catch (e: unknown) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  unlink(
    tenantId: string,
    input: {
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
      readonly firmToday: string;
    },
  ): Promise<UnlinkOutcome | null> {
    const live = this.rows.find(
      (l) =>
        l.tenantId === tenantId &&
        l.lineageId === input.lineageId &&
        l.serviceEntryId === input.serviceEntryId &&
        l.unlinkedAt === null,
    );
    if (!live) return Promise.resolve(null);
    // 0309's both-or-neither CHECK: an unlink is a person's act.
    if (input.byUserId === null) {
      return Promise.reject(new Error("obligation_rule_service_unlinked_chk"));
    }
    live.unlinkedAt = this.instant();
    live.unlinkedByUserId = input.byUserId;

    const subjects = this.calendar?.subjects ?? [];
    const serviceOf = (engagementId: string | null) =>
      subjects.find((s) => s.engagementId === engagementId)?.serviceEntryId ?? null;
    const instances = this.instances;
    const out = {
      withdrawn: 0,
      kept: 0,
      keptStarted: 0,
      keptPastDue: 0,
      keptCoveredElsewhere: 0,
      repointed: 0,
    };
    if (!instances) return Promise.resolve(out);

    for (let i = 0; i < instances.rows.length; i += 1) {
      const row = instances.rows[i];
      if (!row || row.tenantId !== tenantId || row.withdrawnAt !== null) continue;
      if (instances.lineageFor(row.templateId) !== input.lineageId) continue;
      if (serviceOf(row.engagementId) !== input.serviceEntryId) continue;
      const state = instances.states.find((s) => s.id === row.stateId);
      if (!state) continue;
      // Settled history is not counted, as the SQL leaves it out.
      if (state.isTerminal && row.statutoryDueOn < input.firmToday) continue;

      // Another ACTIVE engagement of the same entity whose service still
      // carries this chain, AND which had started by the row's statutory
      // date (the generator's own floor), earliest first, then by id.
      const cover = subjects
        .filter(
          (s) =>
            s.entityPartyId === row.entityPartyId &&
            s.effectiveFrom <= row.statutoryDueOn &&
            this.isLive(tenantId, input.lineageId, s.serviceEntryId),
        )
        .sort(
          (a, b) =>
            a.effectiveFrom.localeCompare(b.effectiveFrom) ||
            a.engagementId.localeCompare(b.engagementId),
        )[0];
      const touched = row.workItemId !== null || row.filedOn !== null || row.resolvedAt !== null;
      const eligible = mayBeWithdrawn(row, state, input.firmToday);

      if (eligible && !cover) {
        instances.rows[i] = {
          ...row,
          withdrawnAt: this.instant(),
          withdrawnByUserId: input.byUserId,
          withdrawnReason: "service_unlinked",
        };
        out.withdrawn += 1;
        continue;
      }
      if (eligible) out.keptCoveredElsewhere += 1;
      else if (touched) out.keptStarted += 1;
      else out.keptPastDue += 1;
      if (!touched && !state.isTerminal && cover && cover.engagementId !== row.engagementId) {
        instances.rows[i] = { ...row, engagementId: cover.engagementId };
        out.repointed += 1;
      }
    }
    out.kept = out.keptStarted + out.keptPastDue + out.keptCoveredElsewhere;
    return Promise.resolve(out);
  }
}

/** Records the tasks the calendar raised, so a test can assert on the ONE place
 *  an obligation becomes somebody's job. */
export class FakeWorkItemRaiser implements WorkItemRaiser {
  readonly raised: {
    entityPartyId: string;
    engagementId: string | null;
    title: string;
    dueOn: string;
  }[] = [];
  private n = 0;

  raiseForObligation(
    _tenantId: string,
    input: {
      readonly entityPartyId: string;
      readonly engagementId: string | null;
      readonly title: string;
      readonly description: string | null;
      readonly dueOn: string;
    },
    _actor: Actor,
  ): Promise<string> {
    this.raised.push({
      entityPartyId: input.entityPartyId,
      engagementId: input.engagementId,
      title: input.title,
      dueOn: input.dueOn,
    });
    this.n += 1;
    return Promise.resolve(`00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`);
  }
}

export class FakeObligationTenants implements TenantDirectory {
  readonly ids: string[] = [];

  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}
