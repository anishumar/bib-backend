// In-memory port fakes for the orchestrator (T2.7). Each `implements` the port
// its Postgres counterpart does, so a compile error here is the same compile
// error production would get.
import type { JobStep, StepCheckMark, StepStatus } from "../domain/orchestrator/model";
import type { StepApproval } from "../domain/verification/model";
import type { ConfidenceTiers } from "../domain/agent/model";
import type {
  StepDeskResolver,
  AgentOutcome,
  AgentRun,
  AgentRunRepository,
  AgentRuntime,
  JobStepRepository,
  NewAgentRun,
  PublishedTiers,
  RunDecision,
  TierSource,
  JobSubject,
  JobSubjectSource,
  NewJobStep,
  ResolvedTemplate,
  StepTransition,
  TemplateSource,
  NewStepCheckMark,
  StepCheckLineRef,
  StepCheckRepository,
} from "../usecase/orchestrator/ports";

/**
 * A job's steps in memory.
 *
 * The compare-and-set in `transition` is modelled faithfully, and that is not
 * pedantry: it is the only guard against two workers both starting the same
 * step, and a fake that ignored `expect` would make every concurrency test pass
 * by construction.
 *
 * So is the sub-step guard (T6.15): a move given `subStepKeys` is made only if
 * every one is marked in `marks` at the moment of the move, which is what the
 * adapter's lock-then-read amounts to in a world with one thread. `marks` is
 * wired by `FakeStepCheckRepo`'s constructor; unwired, every line reads as open,
 * which refuses the move rather than letting it through.
 */
export class FakeJobStepRepo implements JobStepRepository {
  readonly rows: JobStep[] = [];
  marks: { readonly rows: readonly StepCheckMark[] } | null = null;

  createAllIfAbsent(
    steps: readonly NewJobStep[],
  ): Promise<{ readonly steps: readonly JobStep[]; readonly created: boolean }> {
    if (steps.length === 0) return Promise.resolve({ steps: [], created: false });
    const [first] = steps;
    if (!first) throw new Error("createAllIfAbsent called with no steps after a length check");
    const existing = this.rows.filter((r) => r.jobId === first.jobId);
    // Whole set or nothing, exactly as the single INSERT ... ON CONFLICT does.
    if (existing.length > 0) return Promise.resolve({ steps: existing, created: false });

    const created = steps.map(
      (s): JobStep => ({
        id: s.id,
        tenantId: s.tenantId,
        jobId: s.jobId,
        stepKey: s.stepKey,
        label: s.label,
        executor: s.executor,
        status: "pending",
        outcomeNote: null,
        startedAt: null,
        finishedAt: null,
        performedBy: null,
        assigneeUserId: s.assigneeUserId,
      }),
    );
    this.rows.push(...created);
    return Promise.resolve({ steps: created, created: true });
  }

  assign(_tenantId: string, stepId: string, assigneeUserId: string | null): Promise<JobStep | null> {
    const i = this.rows.findIndex((r) => r.id === stepId);
    const row = this.rows[i];
    if (!row || row.status === "done" || row.status === "skipped" || row.status === "failed") {
      return Promise.resolve(null);
    }
    const moved: JobStep = { ...row, assigneeUserId };
    this.rows[i] = moved;
    return Promise.resolve(moved);
  }

  listOpenForUser(_tenantId: string, userId: string): Promise<readonly JobStep[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.assigneeUserId === userId && (r.status === "pending" || r.status === "running" || r.status === "blocked"),
      ),
    );
  }

  listForJob(tenantId: string, jobId: string): Promise<readonly JobStep[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.jobId === jobId)
        .sort((a, b) => a.stepKey.localeCompare(b.stepKey)),
    );
  }

  findByKey(tenantId: string, jobId: string, stepKey: string): Promise<JobStep | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => r.tenantId === tenantId && r.jobId === jobId && r.stepKey === stepKey,
      ) ?? null,
    );
  }

  findById(tenantId: string, stepId: string): Promise<JobStep | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === stepId) ?? null,
    );
  }

  transition(
    tenantId: string,
    stepId: string,
    expect: StepStatus,
    to: StepTransition,
    subStepKeys: readonly string[] = [],
  ): Promise<JobStep | null> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === stepId);
    const current = this.rows[i];
    if (i < 0 || !current) return Promise.resolve(null);
    // The guard. Somebody else moved it first; the caller reads null as "lost
    // the race", which is ordinary rather than an error.
    if (current.status !== expect) return Promise.resolve(null);
    if (!allMarked(this.marks?.rows ?? [], "checklist", stepId, subStepKeys)) return Promise.resolve(null);

    const starts = to.status === "running" || to.status === "blocked";
    const finishes = to.status === "done" || to.status === "failed";
    const next: JobStep = {
      ...current,
      status: to.status,
      outcomeNote: to.outcomeNote ?? null,
      performedBy: to.performedBy ?? null,
      startedAt:
        starts || finishes
          ? (current.startedAt ?? to.at)
          : to.status === "skipped"
            ? current.startedAt
            : null,
      finishedAt: finishes ? to.at : null,
    };
    this.rows[i] = next;
    return Promise.resolve(next);
  }
}

/** Templates by key and by version id, both in one store — one adapter serves
 *  both reads in production and two fakes would eventually disagree about what
 *  a version said. */
export class FakeTemplateSource implements TemplateSource {
  private readonly published = new Map<string, ResolvedTemplate>();
  private readonly byVersion = new Map<string, ResolvedTemplate>();

  /** Publish a template under a key. Publishing again REPLACES what is in force
   *  while leaving the old version resolvable by id — which is what makes a
   *  pinning test mean anything. */
  publish(tenantId: string, key: string, template: ResolvedTemplate): void {
    this.published.set(`${tenantId}:${key}`, template);
    this.byVersion.set(template.versionId, template);
  }

  publishedTemplate(tenantId: string, key: string): Promise<ResolvedTemplate | null> {
    return Promise.resolve(this.published.get(`${tenantId}:${key}`) ?? null);
  }

  pinnedTemplate(_tenantId: string, versionId: string): Promise<ResolvedTemplate | null> {
    return Promise.resolve(this.byVersion.get(versionId) ?? null);
  }
}

export class FakeJobSubjectSource implements JobSubjectSource {
  private readonly subjects = new Map<string, JobSubject>();

  set(jobId: string, subject: JobSubject): void {
    this.subjects.set(jobId, subject);
  }

  subjectOf(_tenantId: string, jobId: string): Promise<JobSubject | null> {
    return Promise.resolve(this.subjects.get(jobId) ?? null);
  }
}

/**
 * An agent runtime a test can arm.
 *
 * The default is NO agents, because that is production's default and a test
 * that forgot to say so should get the honest answer rather than a machine that
 * silently does everything.
 */
/** The firm's thresholds, as a value a test sets directly.
 *
 *  `null` by default and that is the product's real starting state — no firm has
 *  published any — so a test that never mentions tiers is asserting against a
 *  world where nothing commits unattended. Which is the whole safety property. */
export class FakeTierSource implements TierSource {
  published: PublishedTiers | null = null;

  /** Publish thresholds, as a partner would. */
  publish(tiers: ConfidenceTiers, versionId = "00000000-0000-4000-8000-0000000000ab"): this {
    this.published = { tiers, versionId };
    return this;
  }

  publishedTiers(): Promise<PublishedTiers | null> {
    return Promise.resolve(this.published);
  }
}

/**
 * The run book, in memory — and it reproduces the CHECKs, not just the shape.
 *
 * A fake that accepted a `committed` run below the bar would let every guardrail
 * test pass while the property was broken in production, which is the opposite
 * of what the test is for. The real enforcement is a CHECK in migration 0047;
 * this raises for the same three cases so that the service is exercised against
 * a world that behaves like the real one.
 */
export class FakeAgentRunRepo implements AgentRunRepository {
  readonly rows: AgentRun[] = [];

  record(run: NewAgentRun): Promise<AgentRun> {
    if (
      run.decision === "committed" &&
      !(!run.approvalRequired && run.confidence > run.autoCommitAt)
    ) {
      throw new Error(
        `agent_run_commit_needs_confidence: ${String(run.confidence)} is not above ` +
          `${String(run.autoCommitAt)}, or the firm asked for a person on this step`,
      );
    }
    if (
      run.decision === "queued" &&
      !run.approvalRequired &&
      !(run.confidence >= run.reviewAt && run.confidence <= run.autoCommitAt)
    ) {
      throw new Error(`agent_run_queue_band: ${String(run.confidence)} is outside the band`);
    }
    if (run.decision === "escalated" && !(run.confidence < run.reviewAt)) {
      throw new Error(`agent_run_escalate_band: ${String(run.confidence)} is not below the bar`);
    }
    const row: AgentRun = {
      ...run,
      outcome: null,
      rejectedReason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  openForStep(tenantId: string, jobStepId: string): Promise<AgentRun | null> {
    const open = this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.jobStepId === jobStepId &&
        r.outcome === null &&
        r.decision !== "committed",
    );
    return Promise.resolve(open[open.length - 1] ?? null);
  }

  openForJob(tenantId: string, jobId: string): Promise<ReadonlyMap<string, AgentRun>> {
    const out = new Map<string, AgentRun>();
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || r.jobId !== jobId) continue;
      if (r.outcome !== null || r.decision === "committed") continue;
      out.set(r.jobStepId, r);
    }
    return Promise.resolve(out);
  }

  decide(tenantId: string, runId: string, decision: RunDecision): Promise<AgentRun | null> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === runId);
    const current = this.rows[i];
    // Already answered — the second clicker loses, as the SQL guard makes them.
    if (!current || current.outcome !== null) return Promise.resolve(null);
    // The two CHECKs that keep the accuracy signal honest.
    const same = JSON.stringify(current.proposed) === JSON.stringify(decision.applied);
    if (decision.outcome === "corrected" && same) {
      throw new Error("agent_run_corrected_actually_differs: nothing changed");
    }
    if (decision.outcome === "accepted" && !same) {
      throw new Error("agent_run_accepted_does_not_differ: the value changed");
    }
    const next: AgentRun = {
      ...current,
      outcome: decision.outcome,
      applied: decision.applied,
      rejectedReason: decision.rejectedReason,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    };
    this.rows[i] = next;
    return Promise.resolve(next);
  }
}

/**
 * An agent that produces whatever a test told it to, at whatever confidence.
 *
 * The deterministic fake T2.8's acceptance is written against — "commits >0.95,
 * queues 0.70–0.95, escalates <0.70" — and the only executor this product has.
 * No network, no model, no cost: the guardrail is what is being proven, and a
 * real model would make the test about the model.
 */
export class FakeAgentRuntime implements AgentRuntime {
  private readonly able = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly results = new Map<
    string,
    { confidence: number; proposed: Record<string, unknown> }
  >();
  readonly ran: string[] = [];
  model = "fake";
  promptVersion = "v1";

  /** Give this step an agent. Certain, and producing nothing in particular —
   *  for the tests that are about the graph rather than about confidence. */
  arm(stepKey: string): this {
    this.able.add(stepKey);
    return this;
  }

  /** Give this step an agent that produces a specific answer at a specific
   *  confidence. This is the one the tier tests use. */
  armWith(
    stepKey: string,
    confidence: number,
    proposed: Record<string, unknown> = { value: stepKey },
  ): this {
    this.able.add(stepKey);
    this.results.set(stepKey, { confidence, proposed });
    return this;
  }

  /** Give this step an agent that cannot finish the work. A failure records no
   *  run: this seam is about what a machine PRODUCED, and it produced nothing. */
  armFailing(stepKey: string, note: string): this {
    this.able.add(stepKey);
    this.failures.set(stepKey, note);
    return this;
  }

  canRun(stepKey: string): boolean {
    return this.able.has(stepKey);
  }

  provenance(): { model: string; promptVersion: string } {
    return { model: this.model, promptVersion: this.promptVersion };
  }

  run(input: { readonly stepKey: string }): Promise<AgentOutcome> {
    this.ran.push(input.stepKey);
    const note = this.failures.get(input.stepKey);
    if (note !== undefined) return Promise.resolve({ done: false, note });
    const result = this.results.get(input.stepKey);
    return Promise.resolve({
      done: true,
      // Certain by default, so a test that never mentions confidence keeps
      // meaning what it meant before T2.8 — with no tier published that still
      // queues rather than commits, which is the safe direction.
      confidence: result?.confidence ?? 1,
      proposed: result?.proposed ?? { value: input.stepKey },
    });
  }
}

/** Whose desk a job's steps default to. A test sets `spoc`; null is "nobody". */
export class FakeStepDeskResolver implements StepDeskResolver {
  spoc: string | null = null;

  spocFor(_tenantId: string, _jobId: string, _onDate: string): Promise<string | null> {
    return Promise.resolve(this.spoc);
  }
}

/**
 * Whether every one of these lines of one list is marked (done or not
 * applicable) in `rows`: the adapter's `openSubSteps` / `openReviewPoints`, for
 * the fakes that guard a move on a list. `ownerId` is the STEP for a sub-step
 * and the CHECK for a review point.
 */
export function allMarked(
  rows: readonly StepCheckMark[],
  list: "checklist" | "review",
  ownerId: string,
  keys: readonly string[],
): boolean {
  return keys.every((k) =>
    rows.some(
      (r) =>
        r.list === list &&
        r.itemKey === k &&
        r.outcome !== null &&
        (list === "checklist" ? r.jobStepId === ownerId : r.stepApprovalId === ownerId),
    ),
  );
}

/**
 * The marks on a step's sub-steps and a check's review points (T6.15), in
 * memory.
 *
 * It reproduces what 0307 and 0308 enforce rather than only their shape, for
 * `FakeAgentRunRepo`'s reason: the two partial unique keys (one mark per line
 * per step, one per line per CHECK, which is what makes a second round start
 * empty), the pairing (a review mark names its check, a sub-step mark names
 * none, and the check is one of the SAME step), a tick names somebody, a label
 * is text, and a "not applicable" says why in at most 500 characters. A fake
 * that accepted a reasonless N/A would let the service's own refusal go
 * untested against a world that refuses it too.
 *
 * And the adapter's precondition: a mark is written only while its list is
 * open to marks (`mayMark` there). A sub-step's step must be `blocked` with no
 * check pending or approved on it; a review point's check must be pending.
 * Null, or false, and nothing written, otherwise.
 *
 * `listForJob` finds the job through the STEP, as the adapter's join does, so
 * the step repository is required; the constructor also hands it these marks,
 * so a guarded step move reads the same rows. The checks are `approvals`, set
 * by a test that wires both. Unwired, a sub-step reads as having no check and
 * a review point's check as pending, and the same-step key is not tested:
 * that is the divergence, stated, of every test that has no checks in it.
 * Names come from the roster when one is wired, standing in for the adapter's
 * join on the account.
 */
export class FakeStepCheckRepo implements StepCheckRepository {
  readonly rows: StepCheckMark[] = [];
  /** The roster names are read from: a `FakeCheckerDirectory`, stated
   *  structurally because the verification fakes already import this file. */
  directory: { readonly rows: readonly { readonly userId: string; readonly displayName: string }[] } | null = null;
  /** The checks: a `FakeStepApprovalRepo`, stated structurally for the same
   *  reason. */
  approvals: { readonly rows: readonly StepApproval[] } | null = null;

  constructor(private readonly steps: FakeJobStepRepo) {
    steps.marks = this;
  }

  private nameOf(userId: string | null): string | null {
    if (userId === null) return null;
    return this.directory?.rows.find((r) => r.userId === userId)?.displayName ?? userId;
  }

  private sameLine(r: StepCheckMark, ref: StepCheckLineRef): boolean {
    if (r.tenantId !== ref.tenantId || r.list !== ref.list || r.itemKey !== ref.itemKey) return false;
    return ref.list === "checklist" ? r.jobStepId === ref.jobStepId : r.stepApprovalId === ref.stepApprovalId;
  }

  /** The adapter's `mayMark`, at the moment of the write. */
  private mayMark(ref: StepCheckLineRef): boolean {
    if (ref.list === "checklist") {
      const step = this.steps.rows.find((s) => s.id === ref.jobStepId);
      if (step?.status !== "blocked") return false;
      return !(this.approvals?.rows ?? []).some(
        (a) => a.jobStepId === ref.jobStepId && (a.decision === "pending" || a.decision === "approved"),
      );
    }
    if (this.approvals === null) return true;
    const check = this.approvals.rows.find((a) => a.id === ref.stepApprovalId);
    return check?.decision === "pending";
  }

  listForJob(tenantId: string, jobId: string): Promise<readonly StepCheckMark[]> {
    const onJob = new Set(this.steps.rows.filter((s) => s.tenantId === tenantId && s.jobId === jobId).map((s) => s.id));
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId && onJob.has(r.jobStepId)));
  }

  listForApprovals(tenantId: string, approvalIds: readonly string[]): Promise<readonly StepCheckMark[]> {
    const ids = new Set(approvalIds);
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.list === "review" && r.stepApprovalId !== null && ids.has(r.stepApprovalId)),
    );
  }

  upsert(mark: NewStepCheckMark): Promise<StepCheckMark | null> {
    // The CHECKs in 0307 and 0308, reproduced. `trim()` strips the same
    // whitespace 0308's pattern names, so "blank" means one thing on both sides.
    if ((mark.list === "review") !== (mark.stepApprovalId !== null)) {
      throw new Error("job_step_check_review_rows_name_their_check: a review mark names its check, a sub-step mark none");
    }
    if (mark.label.trim() === "") {
      throw new Error("job_step_check_label_is_text: a line's label is words");
    }
    const reasoned = mark.note !== null && mark.note.trim() !== "" && mark.note.length <= 500;
    if ((mark.outcome === "not_applicable") !== reasoned) {
      throw new Error("job_step_check_not_applicable_says_why: a reason of at most 500 on not_applicable and nowhere else");
    }
    // The composite foreign key: a review mark's check is a check of THIS step.
    if (mark.stepApprovalId !== null && this.approvals !== null) {
      const check = this.approvals.rows.find((a) => a.id === mark.stepApprovalId);
      if (check?.jobStepId !== mark.jobStepId) {
        throw new Error("job_step_check_approval_step_tenant_fkey: the check is not one of this step's");
      }
    }
    const ref: StepCheckLineRef = {
      tenantId: mark.tenantId,
      list: mark.list,
      jobStepId: mark.jobStepId,
      stepApprovalId: mark.stepApprovalId,
      itemKey: mark.itemKey,
    };
    if (!this.mayMark(ref)) return Promise.resolve(null);
    const i = this.rows.findIndex((r) => this.sameLine(r, ref));
    const current = this.rows[i];
    // The same answer again changes nothing, including who and when: the
    // adapter's `WHERE ... IS DISTINCT FROM`.
    if (current && current.outcome === mark.outcome && current.note === mark.note) {
      return Promise.resolve(current);
    }
    const row: StepCheckMark = {
      id: current?.id ?? mark.id,
      tenantId: mark.tenantId,
      jobStepId: mark.jobStepId,
      stepApprovalId: mark.stepApprovalId,
      list: mark.list,
      itemKey: mark.itemKey,
      label: mark.label,
      outcome: mark.outcome,
      note: mark.note,
      markedByUserId: mark.markedByUserId,
      markedByName: this.nameOf(mark.markedByUserId),
      markedAt: mark.markedAt,
    };
    if (current) this.rows[i] = row;
    else this.rows.push(row);
    return Promise.resolve(row);
  }

  clear(ref: StepCheckLineRef): Promise<boolean> {
    if (!this.mayMark(ref)) return Promise.resolve(false);
    const i = this.rows.findIndex((r) => this.sameLine(r, ref));
    const current = this.rows[i];
    if (current) {
      this.rows[i] = { ...current, outcome: null, note: null, markedByUserId: null, markedByName: null, markedAt: null };
    }
    return Promise.resolve(true);
  }
}
