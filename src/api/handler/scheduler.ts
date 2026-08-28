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
import { scopeOf } from "../scope";

export interface SchedulerDeps {
  readonly service: SchedulerService;
}

const JobSchema = z
  .object({
    id: z.string().uuid(),
    sourceKind: z.enum(["engagement", "obligation"]).openapi({
      description: "What caused this job to exist.",
    }),
    sourceRef: z.string().uuid().openapi({
      description:
        "The id of that cause — an engagement, later an obligation instance. One job per " +
        "cause per firm, so this is what makes a redelivered trigger a no-op.",
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

/** Field by field — never the domain object. `tenantId` is deliberately absent:
 *  the session already decided it, and echoing it back invites a client to
 *  imagine it could send a different one. */
function toWire(j: Job): z.infer<typeof JobSchema> {
  return {
    id: j.id,
    sourceKind: j.sourceKind,
    sourceRef: j.sourceRef,
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
  summary: "The firm's jobs that are ready to run",
  description:
    "What the engine currently has in hand: jobs whose window has opened and that have not " +
    "reached a terminal state. A job waiting on a future date is deliberately absent — the " +
    "calendar is materialised ahead of time, and showing a year of it as 'ready' would bury " +
    "the work that actually is.",
  responses: {
    200: { description: "Runnable jobs", content: { "application/json": { schema: JobsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
  },
});

export function registerSchedulerRoutes(app: OpenAPIHono<AppEnv>, deps: SchedulerDeps): void {
  app.openapi(listRunnableJobsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const jobs = await deps.service.runnableJobs(s.tenantId);
    return c.json({ jobs: jobs.map(toWire) }, 200);
  });
}

export const schedulerRoutes = {
  listRunnableJobs: listRunnableJobsRoute,
} as const;
