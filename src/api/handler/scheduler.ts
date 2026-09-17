// The delivery engine's read surface (T2.6) — transport only.
//
// One route, and it exists because of a rule this repo has already paid to
// learn: **a write with no read is not a stored fact.** The worker spawns jobs
// and records events about them; without this, nothing outside the database
// could confirm that a signed engagement actually produced work, and the first
// person to find out would be whoever built the work board.
//
// Read-only on purpose. A job's lifecycle belongs to the orchestrator (T2.7),
// which advances it from inside the engine — a route that let a browser set a
// job to `done` would be a way to mark work finished without doing it.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { SchedulerService } from "../../usecase/scheduler/service";
import type { Job } from "../../domain/scheduler/model";
import type { JobDetail } from "../../usecase/scheduler/ports";
import { scopeOf } from "../scope";

export interface SchedulerDeps {
  readonly service: SchedulerService;
}

const JobSchema = z
  .object({
    id: z.string().uuid(),
    sourceKind: z
      .enum(["engagement", "obligation", "engagement_group", "engagement_period"])
      .openapi({
        description:
          "What caused this job to exist. `engagement_group` is several of a letter's " +
          "engagements merged into one checklist, because the firm splits its work by Dept " +
          "or by delivery team. `engagement_period` is ONE PERIOD of a recurring " +
          "engagement's work — September's bookkeeping — and carries `periodStart`, " +
          "`periodEnd` and `periodLabel`; there is one per period for as long as the " +
          "engagement is active.",
      }),
    sourceRef: z.string().uuid().openapi({
      description:
        "The id of that cause — an engagement, later an obligation instance. For a merged " +
        "job it names NO row: it is the group key, derived, and it exists so a redelivered " +
        "trigger conflicts instead of building a second checklist. At most one OPEN job per " +
        "cause per firm. To list what a merged job actually delivers, read `engagementIds`.",
    }),
    entityName: z.string().nullable().openapi({
      description:
        "The legal entity the work is delivered TO. One per job, always — merging across " +
        "entities would break the firm's Per Company rule.",
    }),
    clientName: z.string().nullable().openapi({
      description: "Who is BILLED. Not the same question as the entity, and often not the same party.",
    }),
    services: z
      .array(
        z.object({
          engagementId: z.string().uuid(),
          serviceName: z.string(),
        }),
      )
      .openapi({
        description:
          "The services this job delivers, in the order their advances were recorded. One " +
          "for an unmerged job; several for a merged one. The name is off the version the " +
          "client's letter PINNED, so it reads as the letter wrote it.",
      }),
    splitAxis: z.enum(["none", "dept", "team"]).openapi({
      description:
        "How this job was cut, recorded at spawn. `none` is one job per engagement — the " +
        "firm has not said it splits its work, or has said it does not.",
    }),
    splitCode: z.string().nullable().openapi({
      description:
        "The Dept or delivery team this job's work is filed under. Null on `none`, and null " +
        "on a splitting firm whose service is filed under nothing — both real answers.",
    }),
    periodStart: z.string().nullable().openapi({
      description:
        "The first day of the period an `engagement_period` job is for, `YYYY-MM-DD`. Null " +
        "on every other kind.",
    }),
    periodEnd: z.string().nullable().openapi({
      description: "The last day of that period, `YYYY-MM-DD`. Null on every other kind.",
    }),
    periodLabel: z.string().nullable().openapi({
      description:
        "What a person calls the period — `Sep 2026`, `Q2 FY2026-27`. The board renders it " +
        "beside the services, because twelve identical bookkeeping cards are twelve cards " +
        "nobody can tell apart. Null on every other kind.",
    }),
    status: z.enum(["pending", "running", "blocked", "done", "cancelled"]).openapi({
      description:
        "The ENGINE's own mechanics, not the firm's vocabulary — identical at every firm, " +
        "unlike a work item's states, which a firm names for itself.",
    }),
    templateVersionId: z.string().uuid().nullable().openapi({
      description:
        "The pinned workflow version this job walks. Null until T2.7 exists — a job created " +
        "today records that work is owed and waits.",
    }),
    runnableAt: z.string().openapi({
      description:
        "When the work may begin. For an obligation this is T–X: the calendar is materialised " +
        "a year ahead so it can be seen, and each job opens only when its own window does.",
    }),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .openapi("Job");

const JobsResponse = z.object({ jobs: z.array(JobSchema) }).openapi("JobsResponse");

const JobParam = z.object({
  jobId: z.string().uuid().openapi({ param: { name: "jobId", in: "path" } }),
});

/** Field by field — never the domain object. `tenantId` is deliberately absent:
 *  the session already decided it, and echoing it back invites a client to
 *  imagine it could send a different one. */
function toWire(j: Job, detail: JobDetail | undefined): z.infer<typeof JobSchema> {
  return {
    id: j.id,
    sourceKind: j.sourceKind,
    sourceRef: j.sourceRef,
    // An empty list rather than an omitted field. A job with no link rows is a
    // real state — an obligation-sourced job, until T3.2 gives it something to
    // link to — and the screen renders "no services listed" for it instead of
    // deciding what `undefined` meant.
    entityName: detail?.entityName ?? null,
    clientName: detail?.clientName ?? null,
    services: detail === undefined ? [] : detail.services.map((sv) => ({ ...sv })),
    splitAxis: j.splitAxis,
    splitCode: j.splitCode,
    periodStart: j.periodStart,
    periodEnd: j.periodEnd,
    periodLabel: j.periodLabel,
    status: j.status,
    templateVersionId: j.templateVersionId,
    runnableAt: j.runnableAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

const listRunnableJobsRoute = createRoute({
  method: "get",
  path: "/api/v1/jobs",
  tags: ["delivery"],
  summary: "The firm's open jobs — in hand, and upcoming",
  description:
    "Every job that has not reached a terminal state, soonest window first. A job whose " +
    "`runnableAt` is still ahead is UPCOMING: a per-period job exists from the day its " +
    "period begins and opens the day after it ends, and the board shows it for the whole " +
    "month so the firm can plan from it. Nothing is materialised for a period that has not " +
    "begun, which is what keeps this from being a year of empty checklists.",
  responses: {
    200: { description: "Runnable jobs", content: { "application/json": { schema: JobsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
  },
});

const getJobRoute = createRoute({
  method: "get",
  path: "/api/v1/jobs/{jobId}",
  tags: ["delivery"],
  summary: "One job — what it is for, and how it was cut",
  description:
    "The header the job screen shows above its steps: the company the work is delivered to, " +
    "the services in it, and the Dept or delivery team it was cut under. Separate from the " +
    "list because the list is deliberately only what is RUNNABLE — a job that has finished " +
    "is absent from it, and its steps would otherwise be readable with nothing saying whose " +
    "work they were.",
  request: { params: JobParam },
  responses: {
    200: { description: "The job", content: { "application/json": { schema: JobSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
    404: errorResponse("No such job at this firm"),
  },
});

export function registerSchedulerRoutes(app: OpenAPIHono<AppEnv>, deps: SchedulerDeps): void {
  app.openapi(listRunnableJobsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const jobs = await deps.service.openJobs(s.tenantId);
    // ONE describe for the whole page, not one per row. The lookup-per-row is
    // the exact failure "lists return read models" exists to prevent.
    const details = await deps.service.describeJobs(
      s.tenantId,
      jobs.map((j) => j.id),
    );
    return c.json({ jobs: jobs.map((j) => toWire(j, details.get(j.id))) }, 200);
  });

  app.openapi(getJobRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId } = c.req.valid("param");
    const job = await deps.service.getJob(s.tenantId, jobId);
    const details = await deps.service.describeJobs(s.tenantId, [job.id]);
    return c.json(toWire(job, details.get(job.id)), 200);
  });
}

export const schedulerRoutes = {
  listRunnableJobs: listRunnableJobsRoute,
  getJob: getJobRoute,
} as const;
