// In-memory doubles for the compliance calendar's ports (T3.2).
//
// They are STORES rather than spies: a test builds the real `ObligationService`
// over these and then asserts on what is in them, exactly as the tenancy and
// work-item fakes do. A stub that recorded "createIfAbsent was called twice"
// could not have proved the acceptance line, because the whole claim is that
// the SECOND call changes nothing — and only a store can show that.
import type {
  DueRuleException,
  ObligationInstance,
  ObligationState,
  ObligationTemplate,
  ResolutionOption,
} from "../domain/obligation/model";
import type { Actor } from "../domain/ledger/model";
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
  NewObligationInstance,
  NewObligationState,
  NewObligationTemplate,
  NewResolutionOption,
  ObligationExceptionRepository,
  ObligationInstanceRepository,
  ObligationStatePatch,
  ObligationStateRepository,
  ObligationTemplateRepository,
  RaisableObligation,
  ResolutionOptionPatch,
  ResolutionOptionRepository,
  RestatedInstance,
  ServiceDirectory,
  SpawnedInstance,
  TemplatePatch,
  TemplateRecord,
  TenantDirectory,
  UnstartedInstance,
  WorkItemRaiser,
} from "../usecase/obligation/ports";

export class FakeObligationTemplateRepo implements ObligationTemplateRepository {
  readonly rows: ObligationTemplate[] = [];
  /** The exception store, shared with `FakeObligationExceptionRepo` so the two
   *  see one world — as the real adapters do, sharing one database. */
  exceptions?: FakeObligationExceptionRepo;

  create(t: NewObligationTemplate): Promise<ObligationTemplate> {
    return this.createIfAbsent(t).then((r) => {
      if (!r) throw new Error("conflict");
      return r;
    });
  }

  createIfAbsent(t: NewObligationTemplate): Promise<ObligationTemplate | null> {
    // The rule's own identity, exactly as the unique key defines it.
    const held = this.rows.find(
      (r) =>
        r.tenantId === t.tenantId &&
        r.jurisdiction === t.jurisdiction &&
        r.name === t.name &&
        r.rulePack === t.rulePack,
    );
    if (held) return Promise.resolve(null);
    const row: ObligationTemplate = { ...t, status: "unconfirmed", isActive: true };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  supersede(
    tenantId: string,
    predecessorId: string,
    t: NewObligationTemplate,
  ): Promise<ObligationTemplate> {
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
      supersedesId: predecessorId,
      status: "unconfirmed",
      isActive: true,
    };
    this.rows[i] = { ...predecessor, effectiveTo: t.effectiveFrom };
    this.rows.push(successor);
    return Promise.resolve(successor);
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
          serviceName: null,
          instanceCount: 0,
        })),
    );
  }

  listGenerating(
    tenantId: string,
  ): Promise<
    readonly { template: ObligationTemplate; exceptions: readonly DueRuleException[] }[]
  > {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.isActive && r.dueRule !== null)
        .map((template) => ({
          template,
          exceptions: this.exceptions?.forTemplate(template.id) ?? [],
        })),
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

  createIfAbsent(rows: readonly NewObligationInstance[]): Promise<readonly SpawnedInstance[]> {
    const made: SpawnedInstance[] = [];
    for (const r of rows) {
      // THE RE-RUN KEY, and the whole point of this fake being a store: the
      // second proposal of the same (template, entity, period) must produce
      // nothing at all.
      const held = this.rows.some(
        (x) =>
          x.tenantId === r.tenantId &&
          x.templateId === r.templateId &&
          x.entityPartyId === r.entityPartyId &&
          x.periodStart === r.periodStart,
      );
      if (held) continue;
      this.rows.push({
        ...r,
        workItemId: null,
        filedOn: null,
        resolutionOptionId: null,
        resolutionReason: null,
        resolvedAt: null,
      });
      made.push({
        id: r.id,
        templateId: r.templateId,
        entityPartyId: r.entityPartyId,
        periodLabel: r.periodLabel,
        statutoryDueOn: r.statutoryDueOn,
        internalTargetOn: r.internalTargetOn,
      });
    }
    return Promise.resolve(made);
  }

  findById(tenantId: string, obligationId: string): Promise<ObligationInstance | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === obligationId) ?? null,
    );
  }

  calendar(tenantId: string, _query: CalendarQuery): Promise<readonly CalendarRow[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
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
          serviceEntryId: null,
          entityName: null,
        })),
    );
  }

  attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<void> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `WHERE work_item_id IS NULL`, modelled — a redelivered raise is a no-op
    // rather than a second task pointing at the same filing.
    if (row && row.workItemId === null) this.rows[i] = { ...row, workItemId };
    return Promise.resolve();
  }

  findByWorkItem(tenantId: string, workItemId: string): Promise<ObligationInstance | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.workItemId === workItemId) ?? null,
    );
  }

  markFiled(
    tenantId: string,
    obligationId: string,
    filedOn: string,
    stateId: string,
  ): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    // `AND filed_on IS NULL`, modelled — the guard that makes a second
    // completion of the same task write no second event.
    if (!row || row.filedOn !== null) return Promise.resolve(false);
    this.rows[i] = { ...row, filedOn, stateId };
    return Promise.resolve(true);
  }

  clearFiled(tenantId: string, obligationId: string, stateId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === obligationId);
    const row = this.rows[i];
    if (!row || row.filedOn === null) return Promise.resolve(false);
    this.rows[i] = { ...row, filedOn: null, stateId };
    return Promise.resolve(true);
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

  listMissable(
    tenantId: string,
    asOf: string,
    floor: string | null,
    limit: number,
  ): Promise<readonly MissableObligation[]> {
    const out = this.rows
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        if (r.statutoryDueOn >= asOf) return false;
        if (r.filedOn !== null) return false;
        if (r.resolvedAt !== null) return false;
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
    if (st === undefined || st.isTerminal || st.needsDecision) return Promise.resolve(false);
    this.rows[i] = { ...held, stateId };
    return Promise.resolve(true);
  }

  decisionQueue(tenantId: string, limit: number): Promise<readonly DecisionRow[]> {
    const out = this.rows
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        if (r.resolvedAt !== null || r.filedOn !== null) return false;
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
            // its owner is working to.
            r.workItemId === null &&
            r.filedOn === null,
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
      if (held.workItemId !== null || held.filedOn !== null) continue;
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
}

export class FakeCalendarSource implements CalendarSource {
  /** Every entity the fake knows about, with the rule facts a subject is
   *  matched on. A test adds these rather than a database. */
  readonly subjects: (CalendarSubject & {
    readonly jurisdiction: string;
    readonly entityType: string | null;
    readonly serviceEntryId: string | null;
  })[] = [];
  readonly gapRows: CoverageGap[] = [];

  subjectsFor(
    _tenantId: string,
    rule: {
      readonly jurisdiction: string;
      readonly entityType: string | null;
      readonly serviceEntryId: string | null;
    },
  ): Promise<readonly CalendarSubject[]> {
    return Promise.resolve(
      this.subjects
        .filter((s) => s.jurisdiction === rule.jurisdiction)
        .filter((s) => rule.entityType === null || s.entityType === rule.entityType)
        .filter((s) => rule.serviceEntryId === null || s.serviceEntryId === rule.serviceEntryId)
        .map((s) => ({
          entityPartyId: s.entityPartyId,
          engagementId: s.engagementId,
          effectiveFrom: s.effectiveFrom,
        })),
    );
  }

  gaps(_tenantId: string): Promise<readonly CoverageGap[]> {
    return Promise.resolve(this.gapRows);
  }
}

export class FakeObligationServices implements ServiceDirectory {
  readonly keys = new Map<string, string>();

  serviceKey(_tenantId: string, entryId: string): Promise<string | null> {
    return Promise.resolve(this.keys.get(entryId) ?? null);
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
      readonly serviceEntryId: string | null;
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
