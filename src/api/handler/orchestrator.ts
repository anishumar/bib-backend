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
import type {
  CheckLineView,
  CheckOnDesk,
  DescribedStep,
  OrchestratorService,
} from "../../usecase/orchestrator/service";
import type { JobStep } from "../../domain/orchestrator/model";
import type { AgentRun } from "../../usecase/orchestrator/ports";
import { scopeOf } from "../scope";

export interface OrchestratorDeps {
  readonly service: OrchestratorService;
  /** The firm's grade ladder, for the band's NAMES on the wire. An associate
   *  may not read `/tenancy/grades` (that is the admin surface), and a job
   *  page that said "for analyst to senior_associate" to Kavya was the result. */
  readonly grades: { listGrades(tenantId: string): Promise<readonly { code: string; name: string }[]> };
}

// `AgentProposal`, not `Proposal`. This product already has proposals — the
// priced document a firm sends a prospect — and a second meaning of the word on
// the wire is a readability trap for whoever reads the generated client next.
const ProposalSchema = z
  .object({
    runId: z.string().uuid(),
    confidence: z.number().openapi({
      description: "How sure the machine said it was, 0 to 1.",
    }),
    decision: z.enum(["queued", "escalated"]).openapi({
      description:
        "`queued` — the machine proposed an answer and wants it checked. `escalated` — it " +
        "was not sure enough to propose, and what it found is offered as material rather " +
        "than as an answer.",
    }),
    approvalRequired: z.boolean().openapi({
      description:
        "Whether the firm asked for a person on this step whatever the numbers said. " +
        "\"Unsure\" and \"always checked\" are different reasons for the same queue, and only " +
        "one of them is an argument for more training.",
    }),
    autoCommitAt: z.number(),
    reviewAt: z.number(),
    proposed: z.record(z.unknown()).openapi({
      description: "What the machine produced, verbatim, in whatever shape its work has.",
    }),
    model: z.string(),
    promptVersion: z.string(),
  })
  .openapi("AgentProposal");

const PerformerSchema = z
  .object({
    minGradeRank: z.number().int().nullable(),
    minGradeCode: z.string().nullable(),
    maxGradeRank: z.number().int().nullable(),
    maxGradeCode: z.string().nullable(),
    minGradeName: z.string().nullable().openapi({
      description:
        "What the firm calls the lowest grade — \"Analyst\" — or null for an open end or a rung " +
        "the ladder no longer has. Read this, not the code.",
    }),
    maxGradeName: z.string().nullable().openapi({
      description: "What the firm calls the highest grade, likewise.",
    }),
  })
  .openapi("StepPerformer");

// ── a step's own lists (T6.15) ──────────────────────────────────────────────

const CheckLineSchema = z
  .object({
    key: z.string().openapi({
      description:
        "The line's own key in the process, stable across edits of its wording. What a mark is " +
        "stored against, and what the PUT routes take in their path.",
    }),
    label: z.string().openapi({
      description: "What the line says, from the version of the process this job follows.",
    }),
    outcome: z.enum(["done", "not_applicable"]).nullable().openapi({
      description:
        "`done`: ticked. `not_applicable`: it did not apply here, and `note` says why. Null: " +
        "open, whether nobody has touched it or somebody ticked it and took the tick back.",
    }),
    note: z.string().nullable().openapi({
      description: "Why it did not apply. Present on `not_applicable` and on nothing else.",
    }),
    markedBy: z
      .object({ userId: z.string().uuid(), displayName: z.string() })
      .nullable()
      .openapi({
        description:
          "Who settled it, by the name the account carries now. Null while the line is open.",
      }),
    markedAt: z.string().datetime().nullable().openapi({
      description: "When it was settled, as an instant. Null while the line is open.",
    }),
  })
  .openapi("CheckLine");

/** One line on the wire, field by field. */
function lineWire(l: CheckLineView): z.infer<typeof CheckLineSchema> {
  return {
    key: l.key,
    label: l.label,
    outcome: l.outcome,
    note: l.note,
    markedBy: l.markedBy === null ? null : { userId: l.markedBy.userId, displayName: l.markedBy.displayName },
    markedAt: l.markedAt,
  };
}

const MarkLineRequest = z
  .object({
    outcome: z.enum(["done", "not_applicable"]).nullable().openapi({
      description:
        "`done` ticks it, `not_applicable` says it did not apply (and needs `note`), and null " +
        "takes a tick back. Sending what the line already says changes nothing, including who " +
        "marked it and when.",
    }),
    note: z.string().nullable().optional().openapi({
      description:
        "The reason, for `not_applicable`: required, trimmed, at most 500 characters. Ignored " +
        "on `done` and on null.",
    }),
  })
  .openapi("MarkCheckLineRequest");

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
    proposal: ProposalSchema.nullable().openapi({
      description:
        "What a machine produced for this step, if it did and nobody has decided yet. Null " +
        "for a human step, for a machine step nobody built an agent for, and for one that " +
        "committed on its own — in that last case the work is simply done.",
    }),
    performer: PerformerSchema.nullable().openapi({
      description:
        "The grade band the process names for this step, or null for anybody (0301). Ranks are " +
        "compared; codes are what a person reads.",
    }),
    assignee: z
      .object({ userId: z.string().uuid(), displayName: z.string() })
      .nullable()
      .openapi({
        description:
          "Whose desk it sits on — expected to do it, as distinct from performedBy, who did. " +
          "Null: nobody in particular; anybody inside the band may take it.",
      }),
    viewer: z
      .object({
        mayComplete: z.boolean(),
        reason: z.enum(["ON_ANOTHER_DESK", "OUTSIDE_BAND"]).nullable(),
      })
      .openapi({
        description:
          "Whether the SESSION's user may tick this step, computed where the refusal is, so the " +
          "button and the 409 cannot disagree.",
      }),
    subSteps: z.array(CheckLineSchema).openapi({
      description:
        "The step's sub-steps, in the process's own order (T6.15). Ticked, or marked not " +
        "applicable with a reason, by whoever does the step, and all of them before it can be " +
        "marked done. Locked while the step waits to be checked and once it is done. Empty " +
        "when the process names none, which is every job pinned to an earlier version.",
    }),
    subStepsOpen: z.number().int().openapi({
      description:
        "How many sub-steps are still open: the same count the complete route refuses on, so " +
        "the Done button can be disabled from the data the 409 uses. `viewer.mayComplete` says " +
        "WHO may tick the step; this says whether it is READY to be ticked.",
    }),
  })
  .openapi("JobStep");

const MyStepSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    stepKey: z.string(),
    label: z.string(),
    status: z.enum(["pending", "running", "blocked", "done", "skipped", "failed"]),
  })
  .openapi("MyStep");

const MyStepsResponse = z.object({ steps: z.array(MyStepSchema) }).openapi("MyStepsResponse");

const PerformersResponse = z
  .object({
    performers: z.array(
      z.object({ userId: z.string().uuid(), displayName: z.string(), gradeName: z.string().nullable() }),
    ),
  })
  .openapi("StepPerformersResponse");

const AssignStepRequest = z
  .object({
    userId: z.string().uuid().nullable().openapi({
      description: "Whose desk to put it on. Your own id takes it; null releases it.",
    }),
  })
  .openapi("AssignStepRequest");

const JobStepsResponse = z
  .object({ steps: z.array(JobStepSchema) })
  .openapi("JobStepsResponse");

type Ladder = ReadonlyMap<string, string>;

function toWire(d: DescribedStep, ladder: Ladder, proposal?: AgentRun): z.infer<typeof JobStepSchema> {
  const s: JobStep = d.step;
  const name = (code: string | null): string | null => (code === null ? null : (ladder.get(code) ?? null));
  return {
    performer:
      d.performer === null
        ? null
        : {
            ...d.performer,
            minGradeName: name(d.performer.minGradeCode),
            maxGradeName: name(d.performer.maxGradeCode),
          },
    assignee: d.assignee,
    viewer: d.viewer,
    subSteps: d.subSteps.map(lineWire),
    subStepsOpen: d.subStepsOpen,
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
    proposal:
      proposal === undefined || proposal.decision === "committed"
        ? null
        : {
            runId: proposal.id,
            confidence: proposal.confidence,
            decision: proposal.decision,
            approvalRequired: proposal.approvalRequired,
            autoCommitAt: proposal.autoCommitAt,
            reviewAt: proposal.reviewAt,
            proposed: proposal.proposed,
            model: proposal.model,
            promptVersion: proposal.promptVersion,
          },
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

const DecideBody = z
  .object({
    outcome: z.enum(["accepted", "corrected", "rejected"]).openapi({
      description:
        "Accepted and corrected are kept apart because the difference between them IS the " +
        "accuracy signal — the only evidence that could ever justify moving a threshold.",
    }),
    applied: z
      .record(z.unknown())
      .nullable()
      .openapi({
        description:
          "What actually stands, for a correction. Ignored on an acceptance (the proposal " +
          "itself is applied, taken from the run so it cannot quietly differ) and refused " +
          "on a rejection. A correction that changed nothing is refused by the schema.",
      }),
    rejectedReason: z
      .string()
      .min(1)
      .nullable()
      .openapi({ description: "Required on a rejection, forbidden otherwise." }),
  })
  .openapi("DecideProposalRequest");

const decideProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/jobs/{jobId}/steps/{stepKey}/decide",
  tags: ["delivery"],
  summary: "A person says whether what a machine proposed stands",
  description:
    "Records the verdict and, unless it is a rejection, finishes the step. A REJECTION " +
    "leaves the step waiting: throwing away an answer is not doing the work, and whoever " +
    "rejected it still has to do it and mark it done the ordinary way. " +
    "What the machine proposed is kept forever alongside what a person applied. Keeping " +
    "only the corrected value would throw away the entire accuracy record.",
  request: { params: StepParam, body: { content: { "application/json": { schema: DecideBody } } } },
  responses: {
    200: { description: "The step", content: { "application/json": { schema: JobStepSchema } } },
    400: errorResponse("The body is not a coherent decision"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such job or step at this firm"),
    409: errorResponse(
      "The step is not waiting, nothing proposed an answer to decide about, or somebody " +
        "already decided it",
    ),
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

const assignStepRoute = createRoute({
  method: "put",
  path: "/api/v1/jobs/{jobId}/steps/{stepKey}/assignee",
  tags: ["delivery"],
  summary: "Put a step on somebody's desk — take it, hand it over, or release it",
  description:
    "The process names a grade band per step; only somebody inside it may hold the step. " +
    "Every move is a ledger row saying which of the three it was.",
  request: { params: StepParam, body: { content: { "application/json": { schema: AssignStepRequest } } } },
  responses: {
    200: { description: "The step, on its new desk", content: { "application/json": { schema: JobStepSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such job or step at this firm"),
    409: errorResponse("The step is finished, the person is not staff here, or is outside the step's band"),
  },
});

const performersRoute = createRoute({
  method: "get",
  path: "/api/v1/jobs/{jobId}/steps/{stepKey}/performers",
  tags: ["delivery"],
  summary: "Who may do this step — active staff inside its grade band",
  request: { params: StepParam },
  responses: {
    200: { description: "The people", content: { "application/json": { schema: PerformersResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such job at this firm"),
  },
});

const myStepsRoute = createRoute({
  method: "get",
  path: "/api/v1/my-steps",
  tags: ["delivery"],
  summary: "Every open process step on the session user's desk, across jobs",
  responses: {
    200: { description: "The steps", content: { "application/json": { schema: MyStepsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
  },
});

// ── the verification queue (T2.9) ───────────────────────────────────────────

const EligibilitySchema = z
  .object({
    eligible: z.boolean(),
    reason: z
      .enum([
        "IS_THE_MAKER",
        "NO_WORK_PERMISSION",
        "BELOW_GRADE",
        "UNGRADED",
        "NOT_THE_MAKERS_MANAGER",
      ])
      .nullable()
      .openapi({
        description:
          "Why not, when not. Sent so a screen can SAY it rather than greying a button out: " +
          '"you did this work" and "nobody has put you on the ladder" are different problems ' +
          "and only one of them is the viewer's to fix.",
      }),
  })
  .openapi("CheckEligibility");

const CheckSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    stepKey: z.string(),
    stepLabel: z.string(),
    submittedBy: z.string().uuid().nullable(),
    submittedByName: z.string().nullable().openapi({
      description:
        "Who made the work. Null for a step a machine committed unattended — no person did, " +
        "and maker-checker has nothing to compare, so anybody eligible may check it.",
    }),
    submittedAt: z.string().datetime(),
    policyKey: z.string().nullable(),
    rule: z
      .enum(["rank_threshold", "reporting_line", "reporting_line_or_rank"])
      .nullable()
      .openapi({
        description:
          "Which rule the firm had in force when this check opened, PINNED. Null when the " +
          "step names no policy, or names one the firm has withdrawn — then maker != checker " +
          "is the whole rule.",
      }),
    decision: z.enum(["pending", "approved", "rejected"]),
    notes: z.string().nullable().openapi({
      description: "What the checker objected to. The only thing that ever explains rework.",
    }),
    decidedBy: z.string().uuid().nullable(),
    decidedAt: z.string().datetime().nullable(),
    viewer: EligibilitySchema,
    reviewPoints: z.array(CheckLineSchema).openapi({
      description:
        "THIS check's review points, in the process's own order (T6.15): ticked, or marked not " +
        "applicable with a reason, by whoever may check the step, and all of them before it can " +
        "be approved. Sending it back is never held up by them. A second check after a send-back " +
        "starts with every point open; a decided check shows what its checker ticked. Empty when " +
        "the step names none.",
    }),
    reviewPointsOpen: z.number().int().openapi({
      description:
        "How many review points are still open: the same count the decide route refuses " +
        "Approve on.",
    }),
  })
  .openapi("StepCheck");

const ChecksResponse = z.object({ checks: z.array(CheckSchema) }).openapi("StepChecksResponse");

const CheckerSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string(),
    gradeName: z.string().nullable(),
    eligible: z.boolean(),
    reason: EligibilitySchema.shape.reason,
  })
  .openapi("PossibleChecker");

const CheckersResponse = z
  .object({ checkers: z.array(CheckerSchema) })
  .openapi("PossibleCheckersResponse");

function toCheckWire(c: CheckOnDesk): z.infer<typeof CheckSchema> {
  return {
    id: c.approval.id,
    jobId: c.jobId,
    stepKey: c.stepKey,
    stepLabel: c.stepLabel,
    submittedBy: c.approval.submittedBy,
    submittedByName: c.submittedByName,
    submittedAt: c.approval.submittedAt,
    policyKey: c.approval.policyKey,
    rule: c.rule as z.infer<typeof CheckSchema>["rule"],
    decision: c.approval.decision,
    notes: c.approval.notes,
    decidedBy: c.approval.decidedBy,
    decidedAt: c.approval.decidedAt,
    viewer: { eligible: c.viewer.eligible, reason: c.viewer.reason },
    reviewPoints: c.reviewPoints.map(lineWire),
    reviewPointsOpen: c.reviewPointsOpen,
  };
}

const listChecksRoute = createRoute({
  method: "get",
  path: "/api/v1/checks",
  tags: ["delivery"],
  summary: "Everything at this firm waiting to be checked",
  description:
    "The whole firm's queue, oldest first, with the VIEWER's own verdict on each row. Not " +
    "filtered to what you may take: under a rank threshold there is no 'mine', and a queue " +
    "that hides what you cannot act on also hides that six filings have been waiting a week " +
    "because nobody senior enough has looked. " +
    "Ordered by when the work was submitted, not by a due date — the firm has not given its " +
    "internal turnaround times, and a deadline this product invented is a priority the firm " +
    "never set.",
  responses: {
    200: { description: "The queue", content: { "application/json": { schema: ChecksResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
  },
});

const listJobChecksRoute = createRoute({
  method: "get",
  path: "/api/v1/jobs/{jobId}/checks",
  tags: ["delivery"],
  summary: "Every check this job has had, the ones sent back included",
  description:
    "Including decided ones, and that is the point: a step that was rejected twice and then " +
    "approved reads as a step that sailed through if only open checks are shown.",
  request: { params: JobParam },
  responses: {
    200: { description: "The checks", content: { "application/json": { schema: ChecksResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
    404: errorResponse("No such job at this firm"),
  },
});

const listCheckersRoute = createRoute({
  method: "get",
  path: "/api/v1/checks/{approvalId}/checkers",
  tags: ["delivery"],
  summary: "Who at this firm may check this, and why the others may not",
  description:
    "The whole staff list with a verdict on each, not a filtered one. 'Why can Priya not " +
    "approve this' is the question somebody actually asks, and the answer — she is ungraded, " +
    "or she is the one who did it — is the thing that then gets fixed.",
  request: { params: z.object({ approvalId: z.string().uuid() }) },
  responses: {
    200: {
      description: "The firm's staff, each with a verdict",
      content: { "application/json": { schema: CheckersResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read this"),
    404: errorResponse("No such check at this firm"),
  },
});

const DecideCheckBody = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    notes: z
      .string()
      .nullable()
      .openapi({
        description:
          "Required on a rejection and optional on an approval. Sending work back without " +
          "saying why destroys the only signal that ever explains rework — enforced by the " +
          "database as well as here.",
      }),
  })
  .openapi("DecideCheckRequest");

const decideCheckRoute = createRoute({
  method: "post",
  path: "/api/v1/checks/{approvalId}/decide",
  tags: ["delivery"],
  summary: "Approve somebody else's work, or send it back",
  description:
    "Approving finishes the step and advances the job in the same call. Rejecting leaves the " +
    "step waiting with the reason recorded — sending work back is not doing it, and whoever " +
    "redoes it opens a SECOND check, because 'this took two goes' is part of the record. " +
    "THE ACTOR WHO PRODUCED THE OUTPUT CANNOT BE ITS APPROVER: refused here in words, and " +
    "refused underneath by a CHECK constraint that also holds against an import, a script " +
    "or an agent.",
  request: {
    params: z.object({ approvalId: z.string().uuid() }),
    body: { content: { "application/json": { schema: DecideCheckBody } } },
  },
  responses: {
    200: { description: "The step", content: { "application/json": { schema: JobStepSchema } } },
    400: errorResponse("A rejection with no reason"),
    401: errorResponse("No authenticated session"),
    403: errorResponse(
      "You did this work, or the firm's rule does not put this check in your hands",
    ),
    404: errorResponse("No such check at this firm"),
    409: errorResponse("Somebody already decided it"),
  },
});

// ── ticking a line (T6.15) ──────────────────────────────────────────────────

const markSubStepRoute = createRoute({
  method: "put",
  path: "/api/v1/jobs/{jobId}/steps/{stepKey}/sub-steps/{itemKey}",
  tags: ["delivery"],
  summary: "Tick one of a step's sub-steps, mark it not applicable, or take the tick back",
  description:
    "Only while the step is waiting for a person and is not waiting to be checked: submitted " +
    "work is locked until the checker decides, and a finished step is settled. The same desk " +
    "and grade rules as marking the step done, and the marker is the SESSION's user. Marking " +
    "it not applicable needs a reason. No ledger event per tick: the row says who and when, " +
    "and the counts ride on the step's own transition.",
  request: {
    params: z.object({ jobId: z.string().uuid(), stepKey: z.string().min(1), itemKey: z.string().min(1) }),
    body: { content: { "application/json": { schema: MarkLineRequest } } },
  },
  responses: {
    200: { description: "The step, with its sub-steps", content: { "application/json": { schema: JobStepSchema } } },
    400: errorResponse("Not applicable with no reason, or a reason over 500 characters"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such job, step or sub-step in the process this job follows"),
    409: errorResponse(
      "The step is not waiting for a person, is waiting to be checked, is on somebody else's " +
        "desk, or is outside the person's grade band",
    ),
  },
});

const markReviewPointRoute = createRoute({
  method: "put",
  path: "/api/v1/checks/{approvalId}/review-points/{itemKey}",
  tags: ["delivery"],
  summary: "Tick one of a check's review points, mark it not applicable, or take the tick back",
  description:
    "Only by somebody the firm's rule lets check this work, which by the rule that can never " +
    "be switched off is never the person who did it. Only while the check is undecided. The " +
    "ticks belong to THIS check: after a send-back the next check starts with every point open. " +
    "Marking it not applicable needs a reason.",
  request: {
    params: z.object({ approvalId: z.string().uuid(), itemKey: z.string().min(1) }),
    body: { content: { "application/json": { schema: MarkLineRequest } } },
  },
  responses: {
    200: { description: "The check, with its review points", content: { "application/json": { schema: CheckSchema } } },
    400: errorResponse("Not applicable with no reason, or a reason over 500 characters"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("You did this work, or the firm's rule does not put this check in your hands"),
    404: errorResponse("No such check, or no such review point on its step"),
    409: errorResponse("Somebody already decided it"),
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
    const [steps, proposals, ladder] = await Promise.all([
      deps.service.describeSteps(s.tenantId, jobId, s.userId),
      // ONE read for the page, not one per step.
      deps.service.proposalsFor(s.tenantId, jobId),
      ladderOf(s.tenantId),
    ]);
    return c.json({ steps: steps.map((d) => toWire(d, ladder, proposals.get(d.step.id))) }, 200);
  });

  /** Grade code → name, once per request. */
  async function ladderOf(tenantId: string): Promise<Ladder> {
    return new Map((await deps.grades.listGrades(tenantId)).map((g) => [g.code, g.name]));
  }

  /**
   * One step, described for the session's viewer, after a write moved it — on the wire.
   *
   * WITH ITS UNDECIDED PROPOSAL, read the way the list route reads it. This
   * answered `proposal: null` for every step until T6.15's review, and the job
   * page swaps the whole step for this answer: ticking a sub-step (or handing
   * the step to somebody) on a step holding a machine's answer took the answer,
   * and Accept, Correct and Reject with it, off the screen, and offered a Done
   * the API then refused as PROPOSAL_UNDECIDED. The answer is the described
   * step, whole, or it is not the described step.
   */
  async function describeOne(tenantId: string, jobId: string, stepId: string, viewer: string) {
    const [all, proposals, ladder] = await Promise.all([
      deps.service.describeSteps(tenantId, jobId, viewer),
      deps.service.proposalsFor(tenantId, jobId),
      ladderOf(tenantId),
    ]);
    const d = all.find((x) => x.step.id === stepId);
    if (!d) throw new Error(`step ${stepId} vanished after the write`);
    return toWire(d, ladder, proposals.get(stepId));
  }

  app.openapi(assignStepRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId, stepKey } = c.req.valid("param");
    const body = c.req.valid("json");
    const step = await deps.service.assignStep(
      { tenantId: s.tenantId, jobId, stepKey, assigneeUserId: body.userId },
      s.actor,
      s.userId,
    );
    return c.json(await describeOne(s.tenantId, jobId, step.id, s.userId), 200);
  });

  app.openapi(performersRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId, stepKey } = c.req.valid("param");
    const performers = await deps.service.performersFor(s.tenantId, jobId, stepKey);
    return c.json({ performers: [...performers] }, 200);
  });

  app.openapi(myStepsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const steps = await deps.service.myOpenSteps(s.tenantId, s.userId);
    return c.json(
      { steps: steps.map((st) => ({ id: st.id, jobId: st.jobId, stepKey: st.stepKey, label: st.label, status: st.status })) },
      200,
    );
  });

  app.openapi(decideProposalRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId, stepKey } = c.req.valid("param");
    const body = c.req.valid("json");
    // The decider is the SESSION's user, never a field in the body — the same
    // rule completing a step follows, and for the same reason: who checked the
    // machine's work is the fact this row exists to hold, and it is what T2.9's
    // maker-checker rule compares.
    const step = await deps.service.decideProposal(
      {
        tenantId: s.tenantId,
        jobId,
        stepKey,
        outcome: body.outcome,
        applied: body.applied,
        rejectedReason: body.rejectedReason,
      },
      s.actor,
      s.userId,
    );
    return c.json(await describeOne(s.tenantId, jobId, step.id, s.userId), 200);
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
    return c.json(await describeOne(s.tenantId, jobId, step.id, s.userId), 200);
  });

  app.openapi(listChecksRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const checks = await deps.service.pendingChecks(s.tenantId, s.userId);
    return c.json({ checks: checks.map(toCheckWire) }, 200);
  });

  app.openapi(listJobChecksRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId } = c.req.valid("param");
    const checks = await deps.service.checksForJob(s.tenantId, jobId, s.userId);
    return c.json({ checks: checks.map(toCheckWire) }, 200);
  });

  app.openapi(listCheckersRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { approvalId } = c.req.valid("param");
    const checkers = await deps.service.eligibleCheckers(s.tenantId, approvalId);
    return c.json(
      {
        checkers: checkers.map((v) => ({
          userId: v.userId,
          displayName: v.displayName,
          gradeName: v.gradeName,
          eligible: v.eligible,
          reason: v.reason,
        })),
      },
      200,
    );
  });

  app.openapi(markSubStepRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { jobId, stepKey, itemKey } = c.req.valid("param");
    const body = c.req.valid("json");
    // The marker is the SESSION's user, never a field in the body, for the
    // reason the step's own performer is: a tick is a record of who did part of
    // the work, and a caller who could name somebody else would make it a
    // record of who they said did.
    const step = await deps.service.markSubStep(
      { tenantId: s.tenantId, jobId, stepKey, itemKey, outcome: body.outcome, note: body.note ?? null },
      s.actor,
      s.userId,
    );
    return c.json(await describeOne(s.tenantId, jobId, step.id, s.userId), 200);
  });

  app.openapi(markReviewPointRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { approvalId, itemKey } = c.req.valid("param");
    const body = c.req.valid("json");
    // The checker is the SESSION's user: the right-hand side of maker != checker
    // is exactly who may tick these, and it must not be a body field.
    const check = await deps.service.markReviewPoint(
      { tenantId: s.tenantId, approvalId, itemKey, outcome: body.outcome, note: body.note ?? null },
      s.actor,
      s.userId,
    );
    return c.json(toCheckWire(check), 200);
  });

  app.openapi(decideCheckRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { approvalId } = c.req.valid("param");
    const body = c.req.valid("json");
    // The checker is the SESSION's user, never a field in the body. This is the
    // right-hand side of maker != checker: a caller who could name somebody else
    // as the approver would make the whole rule decorative, which is precisely
    // what the demo's own note warns about ("a rule that lives in a form is a
    // rule that a script, an import or an AI agent walks straight past").
    const step = await deps.service.decideCheck(
      {
        tenantId: s.tenantId,
        approvalId,
        decision: body.decision,
        notes: body.notes,
      },
      s.actor,
      s.userId,
    );
    return c.json(await describeOne(s.tenantId, step.jobId, step.id, s.userId), 200);
  });
}

export const orchestratorRoutes = {
  decideProposal: decideProposalRoute,
  listSteps: listStepsRoute,
  completeStep: completeStepRoute,
  listChecks: listChecksRoute,
  listJobChecks: listJobChecksRoute,
  listCheckers: listCheckersRoute,
  decideCheck: decideCheckRoute,
  markSubStep: markSubStepRoute,
  markReviewPoint: markReviewPointRoute,
} as const;
