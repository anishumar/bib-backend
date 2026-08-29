// A job's steps over HTTP (T2.7) — transport only. Each handler parses the
// validated input, calls exactly one use-case method, and maps the result field
// by field. Never forwards a domain object: zod-openapi documents a response
// without validating it, so a field on the wire but not in the schema is a field
// the generated frontend client cannot see.
//
// ── TWO ROUTES, AND THE SECOND IS THE PRODUCT ───────────────────────────────
//
// The read is what makes the engine visible: "where is this filing" stops being
// a phone call. The WRITE is what makes the product usable before a single agent
// exists — a person ticks a step and the job moves. A read-only engine is one a
// firm can watch and not use.
//
// The sweep is deliberately NOT a route. Advancing a job is the worker's, and a
// route that could mark work done without doing it is not a route. Completing a
// step is different: a person really did the work, and they are the only one who
// can say so.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { OrchestratorService } from "../../usecase/orchestrator/service";
import type { JobStep } from "../../domain/orchestrator/model";
import { scopeOf } from "../scope";

export interface OrchestratorDeps {
  readonly service: OrchestratorService;
}

const JobStepSchema = z
  .object({
    id: z.string().uuid(),
    stepKey: z.string().openapi({
      description:
        "The template's own key for this step. Stable across template edits, and what the " +
        "audit trail names — never the step's position, which shifts when a firm inserts one.",
    }),
    label: z.string(),
    executor: z.enum(["human", "agent", "agent_with_approval"]).openapi({
      description:
        "Who is expected to do it. A step may say 'agent' before any agent exists for it — " +
        "then it waits for a person like any other, and the firm's work carries on.",
    }),
    status: z
      .enum(["pending", "running", "blocked", "done", "skipped", "failed"])
      .openapi({
        description:
          "'blocked' means waiting for a person. 'skipped' is NOT 'done': the step will not " +
          "happen and `outcomeNote` says why, which is a different fact from having done it.",
      }),
    outcomeNote: z.string().nullable().openapi({
      description: "Why a step was skipped, or why it failed. Null on every other state.",
    }),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    performedBy: z.string().uuid().nullable().openapi({
      description:
        "The person who did it. Null for a step nobody has touched, for one an agent did, and " +
        "for a skip — nobody performs a skip.",
    }),
  })
  .openapi("JobStep");

const JobStepsResponse = z
  .object({ steps: z.array(JobStepSchema) })
  .openapi("JobStepsResponse");

function toWire(s: JobStep): z.infer<typeof JobStepSchema> {
  return {
    id: s.id,
    stepKey: s.stepKey,
    label: s.label,
    // The schema's enums are narrower than the domain's strings; the database
    // CHECKs guarantee both, so these state facts the storage already enforces.
    executor: s.executor as z.infer<typeof JobStepSchema>["executor"],
    status: s.status,
    outcomeNote: s.outcomeNote,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    performedBy: s.performedBy,
  };
}

const JobParam = z.object({ jobId: z.string().uuid() });
const StepParam = z.object({ jobId: z.string().uuid(), stepKey: z.string().min(1) });

const listStepsRoute = createRoute({
  method: "get",
  path: "/api/v1/jobs/{jobId}/steps",
  tags: ["delivery"],
  summary: "What this job's process is, and how far it has got",
  description:
    "Every step, in the order the template wrote them, including the ones that were skipped " +
    "and why. A skipped step is shown rather than hidden: 'we did not do this, and here is " +
    "why' is exactly what somebody asks a year later.",
  request: { params: JobParam },
  responses: {
    200: { description: "The steps", content: { "application/json": { schema: JobStepsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
    404: errorResponse("No such job at this firm"),
  },
});

const completeStepRoute = createRoute({
  method: "post",
  path: "/api/v1/jobs/{jobId}/steps/{stepKey}/complete",
  tags: ["delivery"],
  summary: "A person says this step is done",
  description:
    "Records WHO finished it and when, and advances the job immediately — the steps that were " +
    "waiting on this one open in the same call, rather than at the next sweep. Only a step " +
    "that is waiting for a person can be completed this way, and only once: a second " +
    "completion would overwrite the record of who did the work.",
  request: { params: StepParam },
  responses: {
    200: { description: "The completed step", content: { "application/json": { schema: JobStepSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such job or step at this firm"),
    409: errorResponse("The step is not waiting for anybody, or is not a person's to complete"),
  },
});

export function registerOrchestratorRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: OrchestratorDeps,
): void {
  app.openapi(listStepsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId } = c.req.valid("param");
    const steps = await deps.service.stepsOf(s.tenantId, jobId);
    return c.json({ steps: steps.map(toWire) }, 200);
  });

  app.openapi(completeStepRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId, stepKey } = c.req.valid("param");
    // The performer is the SESSION's user, never a field in the body. Who did the work is the one
    // fact this row exists to hold, and a caller that could name somebody else
    // would make it worthless, and would defeat T2.9's maker-checker rule
    // before it is even built.
    const step = await deps.service.completeStep(
      { tenantId: s.tenantId, jobId, stepKey },
      s.actor,
      s.userId,
    );
    return c.json(toWire(step), 200);
  });
}

export const orchestratorRoutes = {
  listSteps: listStepsRoute,
  completeStep: completeStepRoute,
} as const;
