// In-memory port fakes for work items (T3.1). `implements` each port, so a
// drift between a fake and the real adapter is a compile error rather than a
// test that passes against a world the product does not have.
//
// Three behaviours these MUST reproduce, because a test that passes without
// them is testing nothing:
//
//   ONE work item per engagement. The spawn path is at-least-once, and a fake
//   that happily inserted twice would let every "a redelivered sweep does
//   nothing" test pass while the property was broken in production.
//
//   ONE open review per work item. Same argument, reached from the other side:
//   two open checks would let one person's approval and another's rejection
//   both stand.
//
//   `submittedBy` is DERIVED from the item's assignee and FROZEN. That is what
//   makes maker != checker worth anything — a maker the caller can set is not a
//   control — and a fake that took it as an argument would quietly test the
//   version of the rule that does not hold.
import type {
  ChecklistItem,
  SpocCandidate,
  WorkItem,
  WorkItemApproval,
  WorkItemBlocker,
  WorkItemCheck,
  WorkItemDependency,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../domain/workitem/model";
import type {
  ApprovalDecisionWrite,
  EngagementWork,
  EngagementWorkSource,
  NewWorkItem,
  NewWorkItemApproval,
  NewWorkItemPriority,
  NewWorkItemState,
  ResolvedReviewPolicy,
  ReviewPermissionSource,
  ReviewPolicySource,
  ReviewerDirectory,
  ReviewerRow,
  SpocDirectory,
  WorkAxisDirectory,
  WorkAxisRow,
  WorkItemApprovalRepository,
  WorkItemClientDirectory,
  WorkItemClientRow,
  WorkItemFilter,
  WorkItemPatch,
  WorkItemPriorityPatch,
  WorkItemRepository,
  WorkItemStaffDirectory,
  WorkItemStatePatch,
  WorkItemStateWrite,
  WorkVocabularyRepository,
} from "../usecase/workitem/ports";

export class FakeWorkVocabularyRepo implements WorkVocabularyRepository {
  readonly states: WorkItemState[] = [];
  readonly priorities: WorkItemPriority[] = [];

  listStates(tenantId: string): Promise<readonly WorkItemState[]> {
    return Promise.resolve(this.states.filter((s) => s.tenantId === tenantId));
  }

  findState(tenantId: string, stateId: string): Promise<WorkItemState | null> {
    return Promise.resolve(
      this.states.find((s) => s.tenantId === tenantId && s.id === stateId) ?? null,
    );
  }

  findStateByCode(tenantId: string, code: string): Promise<WorkItemState | null> {
    return Promise.resolve(
      this.states.find((s) => s.tenantId === tenantId && s.code === code) ?? null,
    );
  }

  createState(state: NewWorkItemState): Promise<WorkItemState> {
    // The partial unique index, reproduced: claiming the starting flag clears
    // it everywhere else in the same act. A fake that let two rows hold it
    // would make "the firm always has exactly one starting state" untestable.
    if (state.isInitial) this.clearInitial(state.tenantId, null);
    const row: WorkItemState = { ...state, isActive: true };
    this.states.push(row);
    return Promise.resolve(row);
  }

  updateState(
    tenantId: string,
    stateId: string,
    patch: WorkItemStatePatch,
  ): Promise<WorkItemState> {
    if (patch.isInitial) this.clearInitial(tenantId, stateId);
    const i = this.states.findIndex((s) => s.tenantId === tenantId && s.id === stateId);
    const current = this.states[i];
    if (i < 0 || !current) throw new Error(`no state ${stateId}`);
    const next: WorkItemState = { ...current, ...patch };
    this.states[i] = next;
    return Promise.resolve(next);
  }

  listPriorities(tenantId: string): Promise<readonly WorkItemPriority[]> {
    return Promise.resolve(this.priorities.filter((p) => p.tenantId === tenantId));
  }

  findPriority(tenantId: string, priorityId: string): Promise<WorkItemPriority | null> {
    return Promise.resolve(
      this.priorities.find((p) => p.tenantId === tenantId && p.id === priorityId) ?? null,
    );
  }

  findPriorityByCode(tenantId: string, code: string): Promise<WorkItemPriority | null> {
    return Promise.resolve(
      this.priorities.find((p) => p.tenantId === tenantId && p.code === code) ?? null,
    );
  }

  createPriority(priority: NewWorkItemPriority): Promise<WorkItemPriority> {
    if (priority.isDefault) this.clearFlag(priority.tenantId, "isDefault", null);
    if (priority.isStatutoryDefault) {
      this.clearFlag(priority.tenantId, "isStatutoryDefault", null);
    }
    const row: WorkItemPriority = { ...priority, isActive: true };
    this.priorities.push(row);
    return Promise.resolve(row);
  }

  updatePriority(
    tenantId: string,
    priorityId: string,
    patch: WorkItemPriorityPatch,
  ): Promise<WorkItemPriority> {
    if (patch.isDefault) this.clearFlag(tenantId, "isDefault", priorityId);
    if (patch.isStatutoryDefault) this.clearFlag(tenantId, "isStatutoryDefault", priorityId);
    const i = this.priorities.findIndex((p) => p.tenantId === tenantId && p.id === priorityId);
    const current = this.priorities[i];
    if (i < 0 || !current) throw new Error(`no priority ${priorityId}`);
    const next: WorkItemPriority = { ...current, ...patch };
    this.priorities[i] = next;
    return Promise.resolve(next);
  }

  async createStates(states: readonly NewWorkItemState[]): Promise<readonly WorkItemState[]> {
    const written: WorkItemState[] = [];
    for (const s of states) {
      // ON CONFLICT DO NOTHING, reproduced. The seeder is idempotent because
      // `createTenant` and it share no unit of work.
      if (this.states.some((r) => r.tenantId === s.tenantId && r.code === s.code)) continue;
      written.push(await this.createState(s));
    }
    return written;
  }

  async createPriorities(
    priorities: readonly NewWorkItemPriority[],
  ): Promise<readonly WorkItemPriority[]> {
    const written: WorkItemPriority[] = [];
    for (const p of priorities) {
      if (this.priorities.some((r) => r.tenantId === p.tenantId && r.code === p.code)) continue;
      written.push(await this.createPriority(p));
    }
    return written;
  }

  private clearInitial(tenantId: string, exceptId: string | null): void {
    for (let i = 0; i < this.states.length; i += 1) {
      const s = this.states[i];
      if (s && s.tenantId === tenantId && s.isInitial && s.id !== exceptId) {
        this.states[i] = { ...s, isInitial: false };
      }
    }
  }

  private clearFlag(
    tenantId: string,
    flag: "isDefault" | "isStatutoryDefault",
    exceptId: string | null,
  ): void {
    for (let i = 0; i < this.priorities.length; i += 1) {
      const p = this.priorities[i];
      if (p && p.tenantId === tenantId && p[flag] && p.id !== exceptId) {
        this.priorities[i] = { ...p, [flag]: false };
      }
    }
  }
}

export class FakeWorkItemRepo implements WorkItemRepository {
  readonly rows: WorkItem[] = [];
  readonly checklist: ChecklistItem[] = [];
  readonly dependencies: WorkItemDependency[] = [];
  /** Set by the test harness so the read model can resolve names and flags —
   *  the joins the real query does. */
  vocabulary: FakeWorkVocabularyRepo = new FakeWorkVocabularyRepo();
  clients = new Map<string, string>();
  people = new Map<string, { email: string; displayName: string | null }>();
  approvals: FakeWorkItemApprovalRepo | null = null;

  create(item: NewWorkItem): Promise<WorkItem> {
    const row = this.materialise(item);
    this.rows.push(row);
    return Promise.resolve(row);
  }

  createIfAbsentForEngagement(item: NewWorkItem): Promise<WorkItem | null> {
    // The partial unique index on (tenant_id, engagement_id), reproduced. This
    // is THE property the spawn path rests on; see the note at the top.
    const clash = this.rows.find(
      (r) =>
        r.tenantId === item.tenantId &&
        r.engagementId !== null &&
        r.engagementId === item.engagementId,
    );
    if (clash) return Promise.resolve(null);
    const row = this.materialise(item);
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findById(tenantId: string, workItemId: string): Promise<WorkItem | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === workItemId) ?? null,
    );
  }

  async list(tenantId: string, filter: WorkItemFilter): Promise<readonly WorkItemRecord[]> {
    const out: WorkItemRecord[] = [];
    for (const r of this.rows) {
      if (r.tenantId !== tenantId) continue;
      if (filter.assigneeUserId !== undefined && r.assigneeUserId !== filter.assigneeUserId) {
        continue;
      }
      if (filter.unassignedOnly === true && r.assigneeUserId !== null) continue;
      if (filter.clientPartyId !== undefined && r.clientPartyId !== filter.clientPartyId) continue;
      if (filter.jobId !== undefined && r.jobId !== filter.jobId) continue;
      const record = await this.toRecord(r);
      if (filter.openOnly === true && record.state.isTerminal) continue;
      out.push(record);
    }
    return out;
  }

  async findRecord(tenantId: string, workItemId: string): Promise<WorkItemRecord | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === workItemId);
    return row ? this.toRecord(row) : null;
  }

  update(tenantId: string, workItemId: string, patch: WorkItemPatch): Promise<WorkItem> {
    return Promise.resolve(this.replace(tenantId, workItemId, (r) => ({ ...r, ...patch })));
  }

  setState(
    tenantId: string,
    workItemId: string,
    write: WorkItemStateWrite,
  ): Promise<WorkItem> {
    return Promise.resolve(this.replace(tenantId, workItemId, (r) => ({ ...r, ...write })));
  }

  setAssignee(
    tenantId: string,
    workItemId: string,
    assigneeUserId: string | null,
    note: string | null,
  ): Promise<WorkItem> {
    return Promise.resolve(
      this.replace(tenantId, workItemId, (r) => ({
        ...r,
        assigneeUserId,
        // The CHECK, reproduced: a note only ever sits on an unassigned row.
        assignmentNote: assigneeUserId === null ? note : null,
      })),
    );
  }

  listChecklist(tenantId: string, workItemId: string): Promise<readonly ChecklistItem[]> {
    return Promise.resolve(
      this.checklist
        .filter((c) => c.tenantId === tenantId && c.workItemId === workItemId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
    );
  }

  addChecklistItem(item: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly label: string;
    readonly sortOrder: number;
  }): Promise<ChecklistItem> {
    const row: ChecklistItem = { ...item, doneAt: null, doneByUserId: null };
    this.checklist.push(row);
    return Promise.resolve(row);
  }

  findChecklistItem(tenantId: string, id: string): Promise<ChecklistItem | null> {
    return Promise.resolve(
      this.checklist.find((c) => c.tenantId === tenantId && c.id === id) ?? null,
    );
  }

  setChecklistDone(
    tenantId: string,
    id: string,
    doneAt: string | null,
    doneByUserId: string | null,
  ): Promise<ChecklistItem> {
    const i = this.checklist.findIndex((c) => c.tenantId === tenantId && c.id === id);
    const current = this.checklist[i];
    if (i < 0 || !current) throw new Error(`no checklist item ${id}`);
    const next: ChecklistItem = { ...current, doneAt, doneByUserId };
    this.checklist[i] = next;
    return Promise.resolve(next);
  }

  removeChecklistItem(tenantId: string, id: string): Promise<void> {
    const i = this.checklist.findIndex((c) => c.tenantId === tenantId && c.id === id);
    // The TRIGGER, reproduced: a ticked line cannot go. The service refuses it
    // first with a sentence, but a fake that allowed it would let a test prove
    // the wrong thing about what the database does.
    const row = this.checklist[i];
    if (row !== undefined && row.doneAt !== null) {
      throw new Error(`checklist item ${id} is ticked`);
    }
    if (i >= 0) this.checklist.splice(i, 1);
    return Promise.resolve();
  }

  listAllDependencies(tenantId: string): Promise<readonly WorkItemDependency[]> {
    return Promise.resolve(this.dependencies.filter((d) => d.tenantId === tenantId));
  }

  addDependency(dep: {
    readonly id: string;
    readonly tenantId: string;
    readonly workItemId: string;
    readonly dependsOnWorkItemId: string;
  }): Promise<WorkItemDependency> {
    this.dependencies.push(dep);
    return Promise.resolve(dep);
  }

  findDependency(tenantId: string, id: string): Promise<WorkItemDependency | null> {
    return Promise.resolve(
      this.dependencies.find((d) => d.tenantId === tenantId && d.id === id) ?? null,
    );
  }

  removeDependency(tenantId: string, id: string): Promise<void> {
    const i = this.dependencies.findIndex((d) => d.tenantId === tenantId && d.id === id);
    if (i >= 0) this.dependencies.splice(i, 1);
    return Promise.resolve();
  }

  async openBlockers(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly WorkItemBlocker[]> {
    const out: WorkItemBlocker[] = [];
    for (const d of this.dependencies) {
      if (d.tenantId !== tenantId || d.workItemId !== workItemId) continue;
      const blocker = this.rows.find((r) => r.id === d.dependsOnWorkItemId);
      if (!blocker) continue;
      const state = await this.vocabulary.findState(tenantId, blocker.stateId);
      // Unfinished is the blocker's FLAG, never its code — the real query
      // joins to `work_item_state` for exactly this.
      if (state?.isTerminal === true) continue;
      out.push({ workItemId: blocker.id, title: blocker.title });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private materialise(item: NewWorkItem): WorkItem {
    return {
      ...item,
      blockedReason: null,
      blockedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-30T00:00:00.000Z",
    };
  }

  private replace(
    tenantId: string,
    workItemId: string,
    f: (r: WorkItem) => WorkItem,
  ): WorkItem {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === workItemId);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`no work item ${workItemId}`);
    const next = f(current);
    this.rows[i] = next;
    return next;
  }

  private async toRecord(r: WorkItem): Promise<WorkItemRecord> {
    const state = await this.vocabulary.findState(r.tenantId, r.stateId);
    const priority = await this.vocabulary.findPriority(r.tenantId, r.priorityId);
    if (!state || !priority) throw new Error(`work item ${r.id} names a row this firm has not`);
    const person = r.assigneeUserId === null ? undefined : this.people.get(r.assigneeUserId);
    const lines = this.checklist.filter((c) => c.workItemId === r.id);
    return {
      item: r,
      clientName: this.clients.get(r.clientPartyId) ?? "Unknown client",
      entityName: r.entityPartyId === null ? null : (this.clients.get(r.entityPartyId) ?? null),
      state,
      priority,
      assignee:
        r.assigneeUserId === null
          ? null
          : {
              userId: r.assigneeUserId,
              email: person?.email ?? "unknown@example.test",
              displayName: person?.displayName ?? null,
            },
      deptName: null,
      checklistDone: lines.filter((c) => c.doneAt !== null).length,
      checklistTotal: lines.length,
      hasOpenReview:
        this.approvals?.rows.some((a) => a.workItemId === r.id && a.decision === "pending") ??
        false,
      blockedByOpen: await this.openBlockers(r.tenantId, r.id),
    };
  }
}

export class FakeWorkItemApprovalRepo implements WorkItemApprovalRepository {
  readonly rows: WorkItemApproval[] = [];
  /** Set by the harness. The maker is READ from the work item, never supplied —
   *  see the note at the top of this file. */
  items: FakeWorkItemRepo | null = null;

  openIfAbsent(approval: NewWorkItemApproval): Promise<WorkItemApproval | null> {
    const open = this.rows.find(
      (a) => a.workItemId === approval.workItemId && a.decision === "pending",
    );
    if (open) return Promise.resolve(null);
    const item = this.items?.rows.find((r) => r.id === approval.workItemId);
    const row: WorkItemApproval = {
      id: approval.id,
      tenantId: approval.tenantId,
      workItemId: approval.workItemId,
      // The BEFORE INSERT trigger, reproduced. Never taken from the argument:
      // `NewWorkItemApproval` deliberately has no such field.
      submittedBy: item?.assigneeUserId ?? null,
      submittedAt: "2026-08-30T00:00:00.000Z",
      policyVersionId: approval.policyVersionId,
      policyKey: approval.policyKey,
      decision: "pending",
      notes: null,
      decidedBy: null,
      decidedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findById(tenantId: string, approvalId: string): Promise<WorkItemApproval | null> {
    return Promise.resolve(
      this.rows.find((a) => a.tenantId === tenantId && a.id === approvalId) ?? null,
    );
  }

  findOpenFor(tenantId: string, workItemId: string): Promise<WorkItemApproval | null> {
    return Promise.resolve(
      this.rows.find(
        (a) => a.tenantId === tenantId && a.workItemId === workItemId && a.decision === "pending",
      ) ?? null,
    );
  }

  decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<WorkItemApproval | null> {
    const i = this.rows.findIndex((a) => a.tenantId === tenantId && a.id === approvalId);
    const current = this.rows[i];
    // Conditional, exactly as the SQL is: two people can both click, and the
    // second gets null rather than overwriting the first one's decision.
    if (i < 0 || !current || current.decision !== "pending") return Promise.resolve(null);
    const next: WorkItemApproval = { ...current, ...write };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  listPending(tenantId: string): Promise<readonly WorkItemCheck[]> {
    return Promise.resolve(
      this.rows.filter((a) => a.tenantId === tenantId && a.decision === "pending").map(this.check),
    );
  }

  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly WorkItemCheck[]> {
    return Promise.resolve(
      this.rows
        .filter((a) => a.tenantId === tenantId && a.workItemId === workItemId)
        .map(this.check)
        .reverse(),
    );
  }

  private readonly check = (a: WorkItemApproval): WorkItemCheck => ({
    approval: a,
    workItemId: a.workItemId,
    workItemTitle: this.items?.rows.find((r) => r.id === a.workItemId)?.title ?? "",
    clientName: "",
    submittedByName: null,
    policyLabel: null,
  });
}

export class FakeWorkItemClients implements WorkItemClientDirectory {
  readonly rows: WorkItemClientRow[] = [];

  add(id: string, displayName: string, archivedAt: string | null = null): void {
    this.rows.push({ id, displayName, archivedAt });
  }

  findParty(_tenantId: string, partyId: string): Promise<WorkItemClientRow | null> {
    return Promise.resolve(this.rows.find((r) => r.id === partyId) ?? null);
  }
}

export class FakeWorkItemStaff implements WorkItemStaffDirectory {
  readonly active = new Set<string>();

  isActiveStaff(_tenantId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.active.has(userId));
  }
}

/** G3.2's table, as the router reads it: a LIST, keyed by (client, axis), and
 *  the effective dating applied. Two SPOCs on one axis is a state the fake must
 *  be able to produce, because it is the interesting half of the rule. */
export class FakeSpocDirectory implements SpocDirectory {
  readonly rows: {
    clientPartyId: string;
    axisId: string;
    validFrom: string;
    validTo: string | null;
    spoc: SpocCandidate;
  }[] = [];

  add(
    clientPartyId: string,
    axisId: string,
    spoc: SpocCandidate,
    validFrom = "2000-01-01",
    validTo: string | null = null,
  ): void {
    this.rows.push({ clientPartyId, axisId, validFrom, validTo, spoc });
  }

  spocsFor(
    _tenantId: string,
    clientPartyId: string,
    axisId: string,
    onDate: string,
  ): Promise<readonly SpocCandidate[]> {
    return Promise.resolve(
      this.rows
        // Half-open, `[validFrom, validTo)`, exactly as the SQL is — so a
        // handover that closes at D and opens at D returns ONE person on D.
        .filter(
          (r) =>
            r.clientPartyId === clientPartyId &&
            r.axisId === axisId &&
            r.validFrom <= onDate &&
            (r.validTo === null || onDate < r.validTo),
        )
        .map((r) => r.spoc),
    );
  }
}

export class FakeWorkAxes implements WorkAxisDirectory {
  readonly rows: WorkAxisRow[] = [];

  add(id: string, code: string, name: string, isActive = true): void {
    this.rows.push({ id, axis: "dept", code, name, isActive });
  }

  findByCode(
    _tenantId: string,
    axis: "dept" | "team",
    code: string,
  ): Promise<WorkAxisRow | null> {
    return Promise.resolve(this.rows.find((r) => r.axis === axis && r.code === code) ?? null);
  }

  findById(_tenantId: string, axisId: string): Promise<WorkAxisRow | null> {
    return Promise.resolve(this.rows.find((r) => r.id === axisId) ?? null);
  }
}

export class FakeReviewPolicies implements ReviewPolicySource {
  readonly published = new Map<string, ResolvedReviewPolicy>();

  publishedPolicy(_tenantId: string, key: string): Promise<ResolvedReviewPolicy | null> {
    return Promise.resolve(this.published.get(key) ?? null);
  }

  pinnedPolicy(_tenantId: string, versionId: string): Promise<ResolvedReviewPolicy | null> {
    return Promise.resolve(
      [...this.published.values()].find((p) => p.versionId === versionId) ?? null,
    );
  }
}

export class FakeReviewers implements ReviewerDirectory {
  readonly rows: ReviewerRow[] = [];

  activeStaff(_tenantId: string): Promise<readonly ReviewerRow[]> {
    return Promise.resolve(this.rows);
  }
}

export class FakeReviewPermissions implements ReviewPermissionSource {
  readonly byRole = new Map<string, readonly string[]>();

  permissionsFor(_tenantId: string, role: string): Promise<readonly string[]> {
    return Promise.resolve(this.byRole.get(role) ?? []);
  }
}

export class FakeEngagementWork implements EngagementWorkSource {
  readonly rows: EngagementWork[] = [];

  workFor(
    _tenantId: string,
    engagementIds: readonly string[],
  ): Promise<readonly EngagementWork[]> {
    return Promise.resolve(this.rows.filter((r) => engagementIds.includes(r.engagementId)));
  }
}
