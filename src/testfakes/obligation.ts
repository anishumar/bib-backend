// In-memory doubles for the compliance calendar's ports (T3.2).
//
// They are STORES rather than spies: a test builds the real `ObligationService`
// over these and then asserts on what is in them, exactly as the tenancy and
// work-item fakes do. A stub that recorded "createIfAbsent was called twice"
// could not have proved the acceptance line, because the whole claim is that
// the SECOND call changes nothing — and only a store can show that.
import { internalTargetDate } from "../domain/obligation/model";
import type {
  DueRuleException,
  ObligationInstance,
  ObligationState,
  ObligationTemplate,
} from "../domain/obligation/model";
import type { Actor } from "../domain/ledger/model";
import type {
  CalendarQuery,
  CalendarRow,
  CalendarSource,
  CalendarSubject,
  CoverageGap,
  NewException,
  NewObligationInstance,
  NewObligationState,
  NewObligationTemplate,
  ObligationExceptionRepository,
  ObligationInstanceRepository,
  ObligationStateRepository,
  ObligationTemplateRepository,
  RaisableObligation,
  ServiceDirectory,
  SpawnedInstance,
  TemplatePatch,
  TemplateRecord,
  TenantDirectory,
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
      this.rows.push({ ...r, workItemId: null, filedOn: null });
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
            stateCode: "pending",
            stateName: "Pending",
            isTerminal: false,
            needsDecision: false,
            workItemId: r.workItemId,
            filedOn: r.filedOn,
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

  redateUnstarted(tenantId: string, templateId: string, leadTimeDays: number): Promise<number> {
    let moved = 0;
    this.rows.forEach((r, i) => {
      if (r.tenantId !== tenantId || r.templateId !== templateId) return;
      // Only what nobody has started — a task on a desk keeps the date its
      // owner is working to.
      if (r.workItemId !== null || r.filedOn !== null) return;
      const target = internalTargetDate(r.statutoryDueOn, leadTimeDays);
      if (target === r.internalTargetOn) return;
      this.rows[i] = { ...r, internalTargetOn: target };
      moved += 1;
    });
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
