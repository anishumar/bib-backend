// In-memory port fakes for the orchestrator (T2.7). Each `implements` the port
// its Postgres counterpart does, so a compile error here is the same compile
// error production would get.
import type { JobStep, StepStatus } from "../domain/orchestrator/model";
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
} from "../usecase/orchestrator/ports";

/**
 * A job's steps in memory.
 *
 * The compare-and-set in `transition` is modelled faithfully, and that is not
 * pedantry: it is the only guard against two workers both starting the same
 * step, and a fake that ignored `expect` would make every concurrency test pass
 * by construction.
 */
export class FakeJobStepRepo implements JobStepRepository {
  readonly rows: JobStep[] = [];

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
  ): Promise<JobStep | null> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === stepId);
    const current = this.rows[i];
    if (i < 0 || !current) return Promise.resolve(null);
    // The guard. Somebody else moved it first; the caller reads null as "lost
    // the race", which is ordinary rather than an error.
    if (current.status !== expect) return Promise.resolve(null);

    const starts = to.status === "running" || to.status === "blocked";
    const finishes = to.status === "done" || to.status === "failed";
    const next: JobStep = {
      ...current,
      status: to.status,
      outcomeNote: to.outcomeNote ?? null,
      performedBy: to.performedBy ?? null,
      startedAt: starts || finishes ? (current.startedAt ?? to.at) : null,
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
