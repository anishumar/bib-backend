// In-memory port fakes for the orchestrator (T2.7). Each `implements` the port
// its Postgres counterpart does, so a compile error here is the same compile
// error production would get.
import type { JobStep, StepStatus } from "../domain/orchestrator/model";
import type {
  AgentOutcome,
  AgentRuntime,
  JobStepRepository,
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
      }),
    );
    this.rows.push(...created);
    return Promise.resolve({ steps: created, created: true });
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
export class FakeAgentRuntime implements AgentRuntime {
  private readonly able = new Set<string>();
  private readonly failures = new Map<string, string>();
  readonly ran: string[] = [];

  /** Give this step an agent. */
  arm(stepKey: string): this {
    this.able.add(stepKey);
    return this;
  }

  /** Give this step an agent that cannot finish the work. */
  armFailing(stepKey: string, note: string): this {
    this.able.add(stepKey);
    this.failures.set(stepKey, note);
    return this;
  }

  canRun(stepKey: string): boolean {
    return this.able.has(stepKey);
  }

  run(input: { readonly stepKey: string }): Promise<AgentOutcome> {
    this.ran.push(input.stepKey);
    const note = this.failures.get(input.stepKey);
    return Promise.resolve(note === undefined ? { done: true } : { done: false, note });
  }
}
