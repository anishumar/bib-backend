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
import type { Actor } from "../domain/ledger/model";
import type {
  ChecklistItem,
  OwnerPerson,
  SpocCandidate,
  WorkItem,
  WorkItemApproval,
  WorkItemBlocker,
  WorkItemCheck,
  WorkItemDependency,
  WorkItemDependencyRecord,
  WorkItemNote,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../domain/workitem/model";
import type {
  ApprovalDecisionWrite,
  EngagementWork,
  EngagementWorkSource,
  JobStepHandover,
  LinkableFiling,
  NewWorkItem,
  NewWorkItemApproval,
  NewWorkItemNote,
  NewWorkItemPriority,
  NewWorkItemState,
  ObligationCoverage,
  ObligationFiling,
  ResolvedReviewPolicy,
  ReviewPermissionSource,
  ReviewPolicySource,
  ReviewerDirectory,
  ReviewerRow,
  SpocDirectory,
  WorkAxisDirectory,
  WorkAxisRow,
  WorkOwnerDirectory,
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
  CatchUpCandidate,
  LetterWorkLine,
  LetterWorkSource,
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
    if (state.isUnderReview) this.clearUnderReview(state.tenantId, null);
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
    if (patch.isUnderReview) this.clearUnderReview(tenantId, stateId);
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

  /** 0073's partial unique index, reproduced for the same reason as the one
   *  above: a fake that let two rows mean "with a checker" would make "work
   *  sent for review lands in ONE place" untestable. */
  private clearUnderReview(tenantId: string, exceptId: string | null): void {
    for (let i = 0; i < this.states.length; i += 1) {
      const s = this.states[i];
      if (s && s.tenantId === tenantId && s.isUnderReview && s.id !== exceptId) {
        this.states[i] = { ...s, isUnderReview: false };
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
  readonly notes: WorkItemNote[] = [];
  readonly dependencies: WorkItemDependency[] = [];
  /** Set by the test harness so the read model can resolve names and flags —
   *  the joins the real query does. */
  vocabulary: FakeWorkVocabularyRepo = new FakeWorkVocabularyRepo();
  clients = new Map<string, string>();
  people = new Map<string, { email: string; displayName: string | null }>();
  approvals: FakeWorkItemApprovalRepo | null = null;
  /** Tasks an OBLIGATION points at, and the engagement it is owed under: the
   *  `delivery.obligation_instance.work_item_id` link, which the real
   *  catch-up read joins and a filing's own row does not carry. */
  readonly filings = new Map<string, { engagementId: string | null }>();

  create(item: NewWorkItem): Promise<WorkItem> {
    const row = this.materialise(item);
    this.rows.push(row);
    return Promise.resolve(row);
  }

  createIfAbsentForEngagement(item: NewWorkItem): Promise<WorkItem | null> {
    // The partial unique index on (tenant_id, engagement_id, job_id),
    // reproduced (0300). This is THE property the spawn path rests on; see the
    // note at the top. Per JOB since T6.13, because a monthly engagement has
    // one job — and one umbrella task — per month.
    const clash = this.rows.find(
      (r) =>
        r.tenantId === item.tenantId &&
        r.engagementId !== null &&
        r.engagementId === item.engagementId &&
        r.jobId === item.jobId,
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

  /** The join the real adapter does in SQL, over the rows this fake already
   *  holds — so a test cannot pass against a title the database would never
   *  produce. An edge pointing at an item this fake does not hold resolves to
   *  nothing and is dropped, which is what the INNER JOIN does too. */
  listDependenciesFor(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly WorkItemDependencyRecord[]> {
    const out: WorkItemDependencyRecord[] = [];
    for (const d of this.dependencies) {
      if (d.tenantId !== tenantId || d.workItemId !== workItemId) continue;
      const blocker = this.rows.find((i) => i.id === d.dependsOnWorkItemId);
      if (blocker === undefined) continue;
      const state = this.vocabulary.states.find((v) => v.id === blocker.stateId);
      if (state === undefined) continue;
      out.push({
        dependency: d,
        dependsOnTitle: blocker.title,
        dependsOnStateName: state.name,
        dependsOnIsTerminal: state.isTerminal,
      });
    }
    return Promise.resolve(
      out.sort(
        (a, b) =>
          Number(a.dependsOnIsTerminal) - Number(b.dependsOnIsTerminal) ||
          a.dependsOnTitle.localeCompare(b.dependsOnTitle),
      ),
    );
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

  // ── the catch-up (T6.17) ─────────────────────────────────────────────────

  async listCatchUpCandidates(
    tenantId: string,
    clientPartyId: string,
    exceptNote: string,
  ): Promise<readonly CatchUpCandidate[]> {
    const out: CatchUpCandidate[] = [];
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || r.clientPartyId !== clientPartyId) continue;
      if (r.assignmentNote === null || r.assignmentNote === exceptNote) continue;
      const filing = this.filings.get(r.id);
      if (r.engagementId === null && filing === undefined) continue;
      const state = await this.vocabulary.findState(tenantId, r.stateId);
      if (state?.isInitial !== true || state.isTerminal) continue;
      out.push({
        workItemId: r.id,
        jobId: r.jobId,
        assigneeUserId: r.assigneeUserId,
        assignmentNote: r.assignmentNote,
        engagementId: r.engagementId ?? filing?.engagementId ?? null,
        isFiling: filing !== undefined,
        dueOn: r.dueOn,
      });
    }
    return out;
  }

  async reroute(
    tenantId: string,
    workItemId: string,
    expected: { readonly assigneeUserId: string | null; readonly note: string | null },
    next: { readonly assigneeUserId: string; readonly note: string | null },
  ): Promise<WorkItem | null> {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === workItemId);
    if (!r) return null;
    // The WHERE clause, reproduced: the same holder, the same note, and still
    // in a starting state, or nothing is written.
    if (r.assigneeUserId !== expected.assigneeUserId || r.assignmentNote !== expected.note) return null;
    const state = await this.vocabulary.findState(tenantId, r.stateId);
    if (state?.isInitial !== true) return null;
    return this.replace(tenantId, workItemId, (x) => ({
      ...x,
      assigneeUserId: next.assigneeUserId,
      assignmentNote: next.note,
    }));
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

  addNote(note: NewWorkItemNote): Promise<WorkItemNote> {
    // The composite foreign key, reproduced: a note hangs off a task of THIS firm.
    if (!this.rows.some((r) => r.tenantId === note.tenantId && r.id === note.workItemId)) {
      throw new Error(`no work item ${note.workItemId} at this firm`);
    }
    const row: WorkItemNote = {
      ...note,
      authorName: this.people.get(note.authorUserId)?.displayName ?? null,
    };
    this.notes.push(row);
    return Promise.resolve(row);
  }

  listNotes(tenantId: string, workItemId: string): Promise<readonly WorkItemNote[]> {
    return Promise.resolve(
      this.notes
        .filter((n) => n.tenantId === tenantId && n.workItemId === workItemId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
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
      sentBack: this.sentBackOf(r, state.isTerminal),
    };
  }

  /** The SQL's rule (CA#29), reproduced: the latest decided review was a
   *  send-back, none is open, and the task is not finished. */
  private sentBackOf(r: WorkItem, finished: boolean): WorkItemRecord["sentBack"] {
    const reviews = (this.approvals?.rows ?? []).filter((a) => a.workItemId === r.id);
    if (finished || reviews.some((a) => a.decision === "pending")) return null;
    const decided = reviews.filter((a) => a.decision !== "pending" && a.decidedAt !== null);
    const latest = decided.at(-1);
    if (latest?.decision !== "rejected" || latest.decidedAt === null) return null;
    return {
      notes: latest.notes,
      decidedAt: latest.decidedAt,
      decidedByName:
        latest.decidedBy === null ? null : (this.people.get(latest.decidedBy)?.displayName ?? null),
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
      requestNote: approval.requestNote,
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
    clientPartyId: this.items?.rows.find((r) => r.id === a.workItemId)?.clientPartyId ?? "",
    entityPartyId: this.items?.rows.find((r) => r.id === a.workItemId)?.entityPartyId ?? null,
    entityName: null,
    dueOn: this.items?.rows.find((r) => r.id === a.workItemId)?.dueOn ?? null,
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

  /** Tasks the fake has seen routed, per (client, user): the turn-taking
   *  counter the real adapter reads off `delivery.work_item`. A test that
   *  wants a desk to look busy bumps it directly. */
  readonly routed = new Map<string, number>();

  add(
    clientPartyId: string,
    axisId: string,
    spoc: Omit<SpocCandidate, "routed">,
    validFrom = "2000-01-01",
    validTo: string | null = null,
  ): void {
    this.rows.push({ clientPartyId, axisId, validFrom, validTo, spoc: { ...spoc, routed: 0 } });
  }

  /** Record that a task landed on somebody's desk, as the real table would. */
  bump(clientPartyId: string, userId: string): void {
    const key = `${clientPartyId}:${userId}`;
    this.routed.set(key, (this.routed.get(key) ?? 0) + 1);
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
        .map((r) => ({
          ...r.spoc,
          routed: this.routed.get(`${clientPartyId}:${r.spoc.userId}`) ?? 0,
        })),
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

  publishedPolicies(_tenantId: string): Promise<readonly ResolvedReviewPolicy[]> {
    return Promise.resolve([...this.published.values()].sort((a, b) => a.key.localeCompare(b.key)));
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

/**
 * The compliance calendar's coverage, faked.
 *
 * EMPTY BY DEFAULT, and that default is the one the tests should have: a firm
 * with no compliance rules gets the engagement's own task, exactly as it did
 * before T3.2 existed. Every existing spawn test therefore stays honest without
 * being touched. A test that wants the other branch adds an id to `covered`.
 *
 * THE SECOND SET IS A FACT ABOUT THE SERVICE, NOT A SECOND ANSWER. T6.13 kept
 * a free-standing `filing` set for an entity whose GST rule named "any
 * service"; decision 1 removed that case, and a fake that could say "covered
 * but not a filing" for no reason let a work-item test pass against a state
 * Postgres could not produce, so it went. The adapter now says it for exactly
 * one reason (the T6.16 follow-up, 2026-09-26): the engagement's service names
 * a PROCESS of its own, read live, and keeps its month's task. So the fake says
 * it for that reason alone: `ownProcess` holds the engagements whose service
 * has one, and `filingEngagements` is `covered` without them, never more than
 * `covered`, as the adapter's filter over its own rows can never be. Coverage is
 * per ENGAGEMENT: an entity with a covered GST engagement and an uncovered
 * bookkeeping one is two ids.
 */
export class FakeObligationCoverage implements ObligationCoverage {
  readonly covered = new Set<string>();
  /** Engagements whose service's LIVE body names a `workflowTemplateKey`. */
  readonly ownProcess = new Set<string>();

  coveredEngagements(
    _tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(engagementIds.filter((id) => this.covered.has(id))));
  }

  async filingEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const covered = await this.coveredEngagements(tenantId, engagementIds);
    return new Set([...covered].filter((id) => !this.ownProcess.has(id)));
  }

  /** The earliest unfiled filing's legal date per engagement, as a test sets it. */
  readonly filingDue = new Map<string, string>();
  readonly filingDueAsked: { engagementId: string; start: string; end: string }[] = [];

  earliestFilingDue(
    _tenantId: string,
    engagementId: string,
    period: { readonly start: string; readonly end: string },
  ): Promise<string | null> {
    this.filingDueAsked.push({ engagementId, start: period.start, end: period.end });
    return Promise.resolve(this.filingDue.get(engagementId) ?? null);
  }
}

/**
 * The calendar being TOLD a filing's task has settled, faked (0054).
 *
 * It records rather than acts, because what the work-item side owes the
 * calendar is one sentence and the interesting assertion is whether it said it
 * — with the right answer to "is this discharged". The reconciliation itself is
 * `ObligationService`'s and is tested there over a store.
 */
export class FakeObligationFiling implements ObligationFiling {
  readonly calls: { workItemId: string; discharged: boolean; portalDays?: Readonly<Record<string, string>> }[] = [];
  /** Q084: what `assertPortalDays` was asked, and a refusal a test can arm. */
  readonly portalChecks: { workItemId: string; portalDays: Readonly<Record<string, string>> }[] = [];
  refusePortalDays: Error | null = null;

  assertPortalDays(_tenantId: string, workItemId: string, portalDays: Readonly<Record<string, string>>): Promise<void> {
    this.portalChecks.push({ workItemId, portalDays });
    return this.refusePortalDays === null ? Promise.resolve() : Promise.reject(this.refusePortalDays);
  }
  /** What `filingsForTask` answers, and what `linkTask` was told (CA#36). */
  readonly filings: LinkableFiling[] = [];
  readonly links: {
    obligationId: string;
    task: { id: string; entityPartyId: string; discharged: boolean };
  }[] = [];
  readonly unlinked: string[] = [];

  filingsForTask(
    _tenantId: string,
    workItemId: string,
    _entityPartyId: string,
  ): Promise<{
    readonly linked: LinkableFiling | null;
    readonly open: readonly LinkableFiling[];
    readonly filedHere: readonly LinkableFiling[];
    readonly filesOnDone: readonly LinkableFiling[];
  }> {
    const link = this.links.find((l) => l.task.id === workItemId);
    return Promise.resolve({
      linked: link === undefined ? null : (this.filings.find((f) => f.obligationId === link.obligationId) ?? null),
      open: this.filings.filter((f) => !this.links.some((l) => l.obligationId === f.obligationId)),
      filedHere: this.filings.filter(
        (f) => f.filedByWorkItemId === workItemId && f.obligationId !== link?.obligationId,
      ),
      filesOnDone: this.filings.filter((f) => f.filedOn === null && link?.obligationId === f.obligationId),
    });
  }

  linkTask(
    _tenantId: string,
    obligationId: string,
    task: { readonly id: string; readonly entityPartyId: string; readonly discharged: boolean },
    _actor: Actor,
  ): Promise<void> {
    this.links.push({ obligationId, task: { ...task } });
    return Promise.resolve();
  }

  unlinkTask(_tenantId: string, workItemId: string, _actor: Actor): Promise<void> {
    this.unlinked.push(workItemId);
    return Promise.resolve();
  }

  reconcileFiling(
    _tenantId: string,
    workItemId: string,
    discharged: boolean,
    _actor: Actor,
    portalDays?: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.calls.push({ workItemId, discharged, ...(portalDays === undefined ? {} : { portalDays }) });
    return Promise.resolve();
  }
}

/**
 * The owner rule's later rungs (2026-09-27). A test names a Key Manager per
 * client, in force from a day, and the firm's signatory; both default to
 * nobody, which reproduces the routing every test before this was written for.
 */
export class FakeWorkOwnerDirectory implements WorkOwnerDirectory {
  private readonly keyManagers: {
    clientPartyId: string;
    person: OwnerPerson;
    validFrom: string;
    validTo: string | null;
  }[] = [];
  partner: OwnerPerson | null = null;

  setKeyManager(
    clientPartyId: string,
    person: OwnerPerson,
    validFrom = "2000-01-01",
    validTo: string | null = null,
  ): this {
    this.keyManagers.push({ clientPartyId, person, validFrom, validTo });
    return this;
  }

  keyManagerFor(_tenantId: string, clientPartyId: string, onDate: string): Promise<OwnerPerson | null> {
    const hit = this.keyManagers.find(
      (k) =>
        k.clientPartyId === clientPartyId &&
        k.validFrom <= onDate &&
        (k.validTo === null || onDate < k.validTo),
    );
    return Promise.resolve(hit?.person ?? null);
  }

  signingPartner(_tenantId: string): Promise<OwnerPerson | null> {
    return Promise.resolve(this.partner);
  }
}

/** An engagement letter's lines, for the routing preview (T6.17). A test sets
 *  a letter's client and lines; an unknown letter is null, as the adapter's
 *  is. */
export class FakeLetterWork implements LetterWorkSource {
  readonly letters = new Map<string, { clientPartyId: string; lines: LetterWorkLine[] }>();

  linesOf(
    _tenantId: string,
    letterId: string,
  ): Promise<{ readonly clientPartyId: string; readonly lines: readonly LetterWorkLine[] } | null> {
    return Promise.resolve(this.letters.get(letterId) ?? null);
  }
}

/** Records what a task's hand-over asked of its job's steps, and moves
 *  `moves` of them, so a test can say what the orchestrator would answer. */
export class FakeJobStepHandover implements JobStepHandover {
  readonly calls: {
    jobId: string;
    fromUserId: string | null;
    toUserId: string;
  }[] = [];
  moves = 0;

  adoptUnheldSteps(
    _tenantId: string,
    jobId: string,
    fromUserId: string | null,
    toUserId: string,
    _actor: Actor,
  ): Promise<number> {
    this.calls.push({ jobId, fromUserId, toUserId });
    return Promise.resolve(this.moves);
  }

  /** Open step labels by job id; a job not named has none (Q063). */
  readonly open = new Map<string, readonly string[]>();

  openStepLabels(_tenantId: string, jobId: string): Promise<readonly string[]> {
    return Promise.resolve(this.open.get(jobId) ?? []);
  }

  /** A period job's last day by job id; a job not named is no period job. */
  readonly periodEnds = new Map<string, string>();

  periodEndOf(_tenantId: string, jobId: string): Promise<string | null> {
    return Promise.resolve(this.periodEnds.get(jobId) ?? null);
  }
}
