// Work items over HTTP (T3.1) — transport only. Each handler parses the
// validated input, calls exactly one use-case method, and maps the result field
// by field. Never forwards a domain object: zod-openapi documents a response
// without validating it, so a field on the wire but not in the schema is a
// field the generated frontend client cannot see.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type {
  WorkItemCheckOnDesk,
  WorkItemService,
  WorkVocabularyService,
} from "../../usecase/workitem/service";
import type {
  ChecklistItem,
  WorkItemCheck,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../../domain/workitem/model";
import { scopeOf } from "../scope";

export interface WorkItemDeps {
  readonly service: WorkItemService;
  readonly vocabulary: WorkVocabularyService;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const WorkItemStateSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    isInitial: z.boolean().openapi({
      description:
        "What a new work item starts in. At most one per firm — and the product refuses to " +
        "leave a firm with none, because nothing could then be created at all.",
    }),
    isTerminal: z.boolean().openapi({
      description:
        "Nothing further happens. Entering one stamps the completion time; leaving one clears " +
        "it again, because the row says what is true NOW and the history is in the ledger.",
    }),
    isBlocked: z.boolean().openapi({
      description:
        "The work is STUCK, and a reason becomes mandatory. This FLAG is what every rule " +
        "reads — never the code — so a firm may rename 'Blocked' to anything it likes and " +
        "keep the behaviour, or tick it on 'Waiting for Client' to start demanding a reason " +
        "there too.",
    }),
    isSuccess: z.boolean().openapi({
      description:
        "Reaching it means the work was actually DONE, not abandoned. Only a terminal state " +
        "may carry it. A firm starts with TWO terminal states — Completed and Cancelled — " +
        "and this is what tells them apart: the compliance calendar marks a filing filed " +
        "from this flag, and cancelling a task must never record that a statutory return " +
        "was filed.",
    }),
    isUnderReview: z.boolean().openapi({
      description:
        "Work in this state is WITH A CHECKER, and sending an item for review moves it here " +
        "automatically — so the board column and the open review cannot disagree. Before this " +
        "flag they routinely did: the buttons said Approve / Send back while the header still " +
        "read 'In Progress'. At most one state per firm may carry it, it cannot also be " +
        "blocked, terminal or the starting state, and FALSE EVERYWHERE is the shipped answer: " +
        "a firm that has not said which of its own states means this keeps the old behaviour, " +
        "because deciding that a state NAMED 'Under Review' means under review is this " +
        "product having an opinion about the firm's words.",
    }),
    sortOrder: z.number().int(),
    isActive: z.boolean().openapi({
      description:
        "Whether the firm still moves work into it. A retired state still renders everywhere " +
        "it is already held — retiring is not deleting.",
    }),
  })
  .openapi("WorkItemState");

const WorkItemPrioritySchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    rank: z.number().int().openapi({
      description:
        "1 = MOST urgent. What code compares; the name is display. Note this runs the " +
        "opposite way from a staff grade's rank, where 1 is the most junior — both read the " +
        "way a firm says them out loud.",
    }),
    isDefault: z.boolean().openapi({ description: "What ordinary work gets." }),
    isStatutoryDefault: z.boolean().openapi({
      description:
        "What STATUTORY work gets — the firm's rule 'statutory due dates are high priority " +
        "anyway', made mechanical. May be the same row as the ordinary default, which is a " +
        "real setting and not a mistake.",
    }),
    isActive: z.boolean(),
  })
  .openapi("WorkItemPriority");

const WorkItemPersonSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string(),
    displayName: z.string().nullable(),
  })
  .openapi("WorkItemPerson");

const WorkItemBlockerSchema = z
  .object({ workItemId: z.string().uuid(), title: z.string() })
  .openapi("WorkItemBlocker");

const WorkItemSchema = z
  .object({
    id: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    entityPartyId: z.string().uuid().nullable(),
    entityName: z.string().nullable().openapi({
      description:
        "WHICH of the client's companies owes this. Null for relationship-level work that " +
        "belongs to no single entity; a filing always has one.",
    }),
    engagementId: z.string().uuid().nullable(),
    jobId: z.string().uuid().nullable().openapi({
      description:
        "The process automating it, when there is one. Null for ad hoc work and for a firm " +
        "that has published no workflow — both real states, and the work is still owned, " +
        "still due and still reviewable.",
    }),
    title: z.string(),
    description: z.string().nullable(),
    state: WorkItemStateSchema,
    priority: WorkItemPrioritySchema,
    assignee: WorkItemPersonSchema.nullable(),
    assignmentNote: z.string().nullable().openapi({
      description:
        "Why NOBODY has this, set only while it is unassigned. The difference between 'not " +
        "got to yet' and 'the router found two SPOCs for FRC and would not guess'. It is " +
        "what makes an unassigned queue something a person can act on.",
    }),
    deptName: z.string().nullable(),
    dueOn: IsoDate.nullable().openapi({
      description:
        "The firm's own calendar day, never an instant. Computed once at creation as the " +
        "engagement's start date plus the service's SLA, and stored — a later catalogue " +
        "revision must not make finished work retroactively late.",
    }),
    isStatutoryDue: z.boolean().openapi({
      description:
        "True when the date comes from a STATUTE rather than from the firm. This is what " +
        "makes priority derivable. Work spawned from an engagement is NOT statutory — an " +
        "engagement's SLA is the firm's own promise.",
    }),
    slaDaysSnapshot: z.number().int().nullable(),
    isClientVisible: z.boolean(),
    blockedReason: z.string().nullable(),
    blockedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    checklistDone: z.number().int(),
    checklistTotal: z.number().int(),
    hasOpenReview: z.boolean(),
    blockedByOpen: z.array(WorkItemBlockerSchema).openapi({
      description:
        "Unfinished items this one is waiting on. Starting is refused while this is " +
        "non-empty — that is what a dependency SAYS. Moving straight to a terminal state is " +
        "still allowed, because cancelling something that never started is a real act.",
    }),
  })
  .openapi("WorkItem");

const ChecklistItemSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    sortOrder: z.number().int(),
    doneAt: z.string().nullable(),
    doneByUserId: z.string().uuid().nullable(),
  })
  .openapi("ChecklistItem");

const DependencySchema = z
  .object({
    id: z.string().uuid(),
    workItemId: z.string().uuid(),
    dependsOnWorkItemId: z.string().uuid(),
  })
  .openapi("WorkItemDependency");

const WorkItemReviewSchema = z
  .object({
    id: z.string().uuid(),
    workItemId: z.string().uuid(),
    workItemTitle: z.string(),
    clientName: z.string(),
    submittedBy: z.string().uuid().nullable(),
    submittedByName: z.string().nullable().openapi({
      description:
        "Who made the work. DERIVED by the database from the item's assignee and frozen — " +
        "the application cannot set it, because a maker a writer could choose is not a " +
        "maker-checker control. Null when the item was unassigned: then there is no self to " +
        "be, and the rule is vacuous rather than blocking.",
    }),
    submittedAt: z.string(),
    policyKey: z.string().nullable(),
    policyLabel: z.string().nullable().openapi({
      description:
        "The rule's own label as it was PINNED when the check opened — so a firm raising its " +
        "review bar in April never restates what was allowed in March.",
    }),
    decision: z.enum(["pending", "approved", "rejected"]),
    notes: z.string().nullable(),
    decidedBy: z.string().uuid().nullable(),
    decidedAt: z.string().nullable(),
  })
  .openapi("WorkItemReview");

const CheckerOptionSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string(),
    gradeName: z.string().nullable(),
    eligible: z.boolean(),
    reason: z.string().nullable().openapi({
      description:
        "What to SAY when they may not. A refusal with no reason is how a person concludes " +
        "the button is broken.",
    }),
  })
  .openapi("WorkItemCheckerOption");

const BoardResponse = z.object({ items: z.array(WorkItemSchema) }).openapi("WorkBoardResponse");

const WorkItemDetailResponse = z
  .object({
    item: WorkItemSchema,
    checklist: z.array(ChecklistItemSchema),
    dependencies: z.array(DependencySchema),
    reviews: z.array(WorkItemReviewSchema).openapi({
      description:
        "Every review this item has ever had, newest first. The REJECTIONS are the point: a " +
        "list of only open ones makes work that came back twice read as work that sailed " +
        "through.",
    }),
  })
  .openapi("WorkItemDetailResponse");

const VocabularyResponse = z
  .object({
    states: z.array(WorkItemStateSchema),
    priorities: z.array(WorkItemPrioritySchema),
  })
  .openapi("WorkVocabularyResponse");

/**
 * A queue row: the review, plus the VIEWER's own verdict on it.
 *
 * The verdict rides on the row rather than filtering the list, because a queue
 * narrowed to what you may act on hides that six tasks have waited a week
 * because nobody senior enough has looked. `StepCheck` carries the same field
 * for the same reason — this is the task half of the same desk.
 *
 * A separate schema rather than a field on `WorkItemReview`, because that one
 * is also an item's own history, where "may the viewer check this" is a
 * question about a decision already made.
 */
const WorkItemCheckRowSchema = WorkItemReviewSchema.extend({
  viewer: z
    .object({
      eligible: z.boolean(),
      reason: z.string().nullable().openapi({
        description:
          "What to SAY when they may not — the SENTENCE, not a code, and the same prose the " +
          "checkers endpoint returns, so one refusal is never phrased two ways. Null when " +
          "they may check it.",
      }),
    })
    .openapi("WorkItemCheckViewer"),
}).openapi("WorkItemCheckRow");

const ChecksResponse = z
  .object({ checks: z.array(WorkItemCheckRowSchema) })
  .openapi("WorkItemChecksResponse");

const CheckersResponse = z
  .object({ checkers: z.array(CheckerOptionSchema) })
  .openapi("WorkItemCheckersResponse");

const CreateWorkItemRequest = z
  .object({
    clientPartyId: z.string().uuid(),
    entityPartyId: z.string().uuid().nullable().optional(),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    priorityId: z.string().uuid().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    dueOn: IsoDate.nullable().optional(),
    isStatutoryDue: z.boolean().optional(),
    isClientVisible: z.boolean().optional(),
  })
  .openapi("CreateWorkItemRequest");

const UpdateWorkItemRequest = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priorityId: z.string().uuid().optional(),
    dueOn: IsoDate.nullable().optional(),
    isClientVisible: z.boolean().optional(),
  })
  .openapi("UpdateWorkItemRequest");

const MoveStateRequest = z
  .object({
    stateId: z.string().uuid(),
    blockedReason: z.string().nullable().optional().openapi({
      description:
        "Required when the target state is one the firm has marked as BLOCKED, and refused " +
        "otherwise. 'Blocked' on its own records that work is stuck and never why — and a " +
        "year later 'are our delays ours or the client's' has no query that can answer it.",
    }),
  })
  .openapi("MoveWorkItemStateRequest");

const AssignRequest = z
  .object({ assigneeUserId: z.string().uuid().nullable() })
  .openapi("AssignWorkItemRequest");

const AddChecklistRequest = z
  .object({ label: z.string().min(1), sortOrder: z.number().int().optional() })
  .openapi("AddChecklistItemRequest");

const TickChecklistRequest = z
  .object({ done: z.boolean() })
  .openapi("TickChecklistItemRequest");

const AddDependencyRequest = z
  .object({ dependsOnWorkItemId: z.string().uuid() })
  .openapi("AddWorkItemDependencyRequest");

const RequestReviewRequest = z
  .object({
    policyKey: z.string().nullable().optional().openapi({
      description:
        "Which of the firm's published verification policies decides who may check this. " +
        "OPTIONAL, and no default is invented: there is no template step here to name one, " +
        "and picking a rule on the firm's behalf would be this product deciding who signs " +
        "off its work. Absent means maker != checker alone.",
    }),
  })
  .openapi("RequestWorkItemReviewRequest");

const DecideReviewRequest = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().nullable().optional().openapi({
      description:
        "Mandatory on a rejection. WHY work came back is the only signal that ever explains " +
        "rework — marking the task Completed later erases the fact that it was rejected.",
    }),
  })
  .openapi("DecideWorkItemReviewRequest");

const CreateStateRequest = z
  .object({
    code: z.string().min(2),
    name: z.string().min(1),
    isInitial: z.boolean().optional(),
    isTerminal: z.boolean().optional(),
    isBlocked: z.boolean().optional(),
    isSuccess: z.boolean().optional(),
    isUnderReview: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateWorkItemStateRequest");

const UpdateStateRequest = z
  .object({
    name: z.string().min(1).optional(),
    isInitial: z.boolean().optional(),
    isTerminal: z.boolean().optional(),
    isBlocked: z.boolean().optional(),
    isSuccess: z.boolean().optional(),
    isUnderReview: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateWorkItemStateRequest");

const CreatePriorityRequest = z
  .object({
    code: z.string().min(2),
    name: z.string().min(1),
    rank: z.number().int().positive(),
    isDefault: z.boolean().optional(),
    isStatutoryDefault: z.boolean().optional(),
  })
  .openapi("CreateWorkItemPriorityRequest");

const UpdatePriorityRequest = z
  .object({
    name: z.string().min(1).optional(),
    rank: z.number().int().positive().optional(),
    isDefault: z.boolean().optional(),
    isStatutoryDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateWorkItemPriorityRequest");

const BoardQuery = z.object({
  mine: z.enum(["true", "false"]).optional().openapi({
    description: "Only work on the signed-in person's desk.",
  }),
  unassigned: z.enum(["true", "false"]).optional().openapi({
    description:
      "Only work nobody has picked up — where the router lands a filing it would not guess " +
      "an owner for. The queue that has to be chased.",
  }),
  clientPartyId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  includeDone: z.enum(["true", "false"]).optional().openapi({
    description: "Include work in a terminal state. Off by default.",
  }),
  asOf: IsoDate.optional().openapi({
    description:
      "The CALLER's calendar day, used to decide what is overdue and therefore what sorts " +
      "first. Defaults to the server's own day — which is not the firm's: a server in UTC " +
      "is a day behind a firm in India every morning. A browser sends its local date.",
  }),
});

const WorkItemParam = z.object({ workItemId: z.string().uuid() });
const ChecklistParam = z.object({
  workItemId: z.string().uuid(),
  checklistItemId: z.string().uuid(),
});
const DependencyParam = z.object({
  workItemId: z.string().uuid(),
  dependencyId: z.string().uuid(),
});
const StateParam = z.object({ stateId: z.string().uuid() });
const PriorityParam = z.object({ priorityId: z.string().uuid() });
const ReviewParam = z.object({ approvalId: z.string().uuid() });

// ── Wire mapping ────────────────────────────────────────────────────────────

function toStateWire(s: WorkItemState): z.infer<typeof WorkItemStateSchema> {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    isInitial: s.isInitial,
    isTerminal: s.isTerminal,
    isBlocked: s.isBlocked,
    isSuccess: s.isSuccess,
    isUnderReview: s.isUnderReview,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
  };
}

function toPriorityWire(p: WorkItemPriority): z.infer<typeof WorkItemPrioritySchema> {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    rank: p.rank,
    isDefault: p.isDefault,
    isStatutoryDefault: p.isStatutoryDefault,
    isActive: p.isActive,
  };
}

function toWire(r: WorkItemRecord): z.infer<typeof WorkItemSchema> {
  return {
    id: r.item.id,
    clientPartyId: r.item.clientPartyId,
    clientName: r.clientName,
    entityPartyId: r.item.entityPartyId,
    entityName: r.entityName,
    engagementId: r.item.engagementId,
    jobId: r.item.jobId,
    title: r.item.title,
    description: r.item.description,
    state: toStateWire(r.state),
    priority: toPriorityWire(r.priority),
    assignee: r.assignee
      ? {
          userId: r.assignee.userId,
          email: r.assignee.email,
          displayName: r.assignee.displayName,
        }
      : null,
    assignmentNote: r.item.assignmentNote,
    deptName: r.deptName,
    dueOn: r.item.dueOn,
    isStatutoryDue: r.item.isStatutoryDue,
    slaDaysSnapshot: r.item.slaDaysSnapshot,
    isClientVisible: r.item.isClientVisible,
    blockedReason: r.item.blockedReason,
    blockedAt: r.item.blockedAt,
    startedAt: r.item.startedAt,
    completedAt: r.item.completedAt,
    createdAt: r.item.createdAt,
    checklistDone: r.checklistDone,
    checklistTotal: r.checklistTotal,
    hasOpenReview: r.hasOpenReview,
    blockedByOpen: r.blockedByOpen.map((b) => ({ workItemId: b.workItemId, title: b.title })),
  };
}

function toChecklistWire(c: ChecklistItem): z.infer<typeof ChecklistItemSchema> {
  return {
    id: c.id,
    label: c.label,
    sortOrder: c.sortOrder,
    doneAt: c.doneAt,
    doneByUserId: c.doneByUserId,
  };
}

function toReviewWire(c: WorkItemCheck): z.infer<typeof WorkItemReviewSchema> {
  return {
    id: c.approval.id,
    workItemId: c.workItemId,
    workItemTitle: c.workItemTitle,
    clientName: c.clientName,
    submittedBy: c.approval.submittedBy,
    submittedByName: c.submittedByName,
    submittedAt: c.approval.submittedAt,
    policyKey: c.approval.policyKey,
    policyLabel: c.policyLabel,
    decision: c.approval.decision,
    notes: c.approval.notes,
    decidedBy: c.approval.decidedBy,
    decidedAt: c.approval.decidedAt,
  };
}

function toCheckRowWire(c: WorkItemCheckOnDesk): z.infer<typeof WorkItemCheckRowSchema> {
  return { ...toReviewWire(c), viewer: { eligible: c.viewer.eligible, reason: c.viewer.reason } };
}

// ── Routes ──────────────────────────────────────────────────────────────────
//
// The tenant comes from the SESSION on every one of these, never from the path.

const boardRoute = createRoute({
  method: "get",
  path: "/api/v1/work-items",
  tags: ["work"],
  summary: "The work board",
  description:
    "What is owed, whose it is, and what is late. Overdue first, then by urgency, then by " +
    "due date — because overdue is the only thing anybody is actually looking for. Every row " +
    "carries the client, the state and the assignee BY NAME, so nothing has to be fetched " +
    "per line to render it.",
  request: { query: BoardQuery },
  responses: {
    200: { description: "The board", content: { "application/json": { schema: BoardResponse } } },
    400: errorResponse("asOf is not an ISO date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/api/v1/work-items/{workItemId}",
  tags: ["work"],
  summary: "One work item, its checklist, its dependencies and every review it has had",
  request: { params: WorkItemParam },
  responses: {
    200: {
      description: "The work item",
      content: { "application/json": { schema: WorkItemDetailResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
    404: errorResponse("No such work item at this firm"),
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/api/v1/work-items",
  tags: ["work"],
  summary: "Raise a work item by hand",
  description:
    "Ad hoc work, which is real work — 'prepare the board minutes' has no engagement, no " +
    "process and no template, and is still owned, due and reviewable. It is created " +
    "UNASSIGNED unless somebody is named: routing needs a Dept, and a hand-raised item has " +
    "none until the firm says which.",
  request: {
    body: { content: { "application/json": { schema: CreateWorkItemRequest } }, required: true },
  },
  responses: {
    201: { description: "Raised", content: { "application/json": { schema: WorkItemSchema } } },
    400: errorResponse("No title, or a due date that is not a calendar day"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such client, or no such priority at this firm"),
    409: errorResponse(
      "The client is archived, the named person is not active staff, or the firm has no " +
        "starting state or default priority",
    ),
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/api/v1/work-items/{workItemId}",
  tags: ["work"],
  summary: "Edit a work item's title, description, priority, due date or client visibility",
  description:
    "Assignment and state are deliberately NOT here — each is its own call writing its own " +
    "event, and folding them in would make one PATCH able to reassign work silently.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: UpdateWorkItemRequest } }, required: true },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: WorkItemSchema } } },
    400: errorResponse("An empty title, or a due date that is not a calendar day"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item, or no such priority at this firm"),
    409: errorResponse("The priority has been retired"),
  },
});

const moveStateRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/state",
  tags: ["work"],
  summary: "Move a work item to another of the firm's states",
  description:
    "The timestamps follow the state's FLAGS, not its name: a state marked BLOCKED demands a " +
    "reason and stamps the time; a TERMINAL one stamps the completion, and leaving it clears " +
    "that again. Starting is refused while the item is still waiting on unfinished work — " +
    "which is what a dependency says — but moving straight to a terminal state is allowed, " +
    "because cancelling something that never started is a real act.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: MoveStateRequest } }, required: true },
  },
  responses: {
    200: { description: "Moved", content: { "application/json": { schema: WorkItemSchema } } },
    400: errorResponse("Moving into a blocked state with no reason"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item, or no such state at this firm"),
    409: errorResponse(
      "It is already in that state, the state has been retired, or it is still waiting on " +
        "unfinished work",
    ),
  },
});

const assignRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/assignee",
  tags: ["work"],
  summary: "Put a work item on somebody's desk, or take it off",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: AssignRequest } }, required: true },
  },
  responses: {
    200: { description: "Assigned", content: { "application/json": { schema: WorkItemSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
    409: errorResponse("The named person is not active staff at this firm"),
  },
});

const addChecklistRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/checklist",
  tags: ["work"],
  summary: "Add a line to a work item's checklist",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: AddChecklistRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: ChecklistItemSchema } } },
    400: errorResponse("An empty label"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
  },
});

const tickChecklistRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/checklist/{checklistItemId}",
  tags: ["work"],
  summary: "Tick or untick a checklist line",
  description:
    "No ledger event, deliberately: a tick is somebody's working note on their own task, the " +
    "row already carries who and when, and twelve events per filing would bury the " +
    "transitions that matter in a log that cannot be pruned.",
  request: {
    params: ChecklistParam,
    body: { content: { "application/json": { schema: TickChecklistRequest } }, required: true },
  },
  responses: {
    200: { description: "Ticked", content: { "application/json": { schema: ChecklistItemSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such checklist line on this task"),
  },
});

const removeChecklistRoute = createRoute({
  method: "delete",
  path: "/api/v1/work-items/{workItemId}/checklist/{checklistItemId}",
  tags: ["work"],
  summary: "Remove an unticked checklist line",
  description:
    "A TICKED line cannot be removed — the tick is the record that somebody did it and it " +
    "lives nowhere else. Untick it first if it was ticked by mistake. A trigger refuses it " +
    "too, so a script cannot walk past this.",
  request: { params: ChecklistParam },
  responses: {
    204: { description: "Removed" },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such checklist line on this task"),
    409: errorResponse("The line is ticked"),
  },
});

const addDependencyRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/dependencies",
  tags: ["work"],
  summary: "Make this work item wait on another",
  description:
    "'This cannot start until that is finished' — the annual filing waits on twelve monthly " +
    "ones. A dependency that would close a loop, directly or through a chain, is refused: " +
    "neither item could ever start, and nothing on the screen would say why.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: AddDependencyRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: DependencySchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
    409: errorResponse("It already waits on that one, or the dependency would close a loop"),
  },
});

const removeDependencyRoute = createRoute({
  method: "delete",
  path: "/api/v1/work-items/{workItemId}/dependencies/{dependencyId}",
  tags: ["work"],
  summary: "Lift a dependency",
  request: { params: DependencyParam },
  responses: {
    204: { description: "Lifted" },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such dependency on this task"),
  },
});

const requestReviewRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/review",
  tags: ["work"],
  summary: "Send a work item to be checked",
  description:
    "The MAKER is not a parameter and cannot be: the database derives it from the item's " +
    "assignee and freezes it, because a maker the caller could choose is not a maker-checker " +
    "control. The state is deliberately not moved to 'Under Review' — there is no flag " +
    "saying which of the firm's states means that, and comparing the name is the one thing " +
    "this module never does.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: RequestReviewRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Waiting to be checked",
      content: { "application/json": { schema: WorkItemReviewSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
    409: errorResponse("A review is already open on it"),
  },
});

const checkersRoute = createRoute({
  method: "get",
  path: "/api/v1/work-item-checks/{approvalId}/checkers",
  tags: ["work"],
  summary: "Who may check this, and what to say to everybody who may not",
  description:
    "The same rule a process step's check uses — maker != checker first and regardless of " +
    "policy, then `work:write`, then the firm's own published rule. One answer to 'who " +
    "checks whose work' at this firm, whether the work is a step or a task.",
  request: { params: ReviewParam },
  responses: {
    200: {
      description: "The candidates",
      content: { "application/json": { schema: CheckersResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
    404: errorResponse("No such review at this firm"),
  },
});

const decideReviewRoute = createRoute({
  method: "post",
  path: "/api/v1/work-item-checks/{approvalId}/decide",
  tags: ["work"],
  summary: "Approve a work item, or send it back",
  request: {
    params: ReviewParam,
    body: { content: { "application/json": { schema: DecideReviewRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Decided",
      content: { "application/json": { schema: WorkItemReviewSchema } },
    },
    400: errorResponse("A rejection with no note saying what for"),
    401: errorResponse("No authenticated session"),
    403: errorResponse(
      "You did the work, or the firm's published rule says somebody else checks this",
    ),
    404: errorResponse("No such review at this firm"),
    409: errorResponse("Somebody else already decided it"),
  },
});

const pendingChecksRoute = createRoute({
  method: "get",
  path: "/api/v1/work-item-checks",
  tags: ["work"],
  summary: "Every work item waiting to be checked at this firm",
  description:
    "The WHOLE firm's, oldest first — not filtered to what the viewer can act on. Under a " +
    "rank threshold there is no 'mine', and a filtered list hides that six tasks have waited " +
    "a week because nobody senior enough has looked. Every row carries the VIEWER's own " +
    "verdict instead, with the sentence to say when they may not check it. " +
    "Ordered by when the work was submitted and by nothing else: the firm has not given its " +
    "internal turnaround times, and a deadline this product invented is a priority the firm " +
    "never set.",
  responses: {
    200: { description: "The queue", content: { "application/json": { schema: ChecksResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
  },
});

// ── the firm's own vocabulary ───────────────────────────────────────────────

const vocabularyRoute = createRoute({
  method: "get",
  path: "/api/v1/work-vocabulary",
  tags: ["work"],
  summary: "The firm's own work-item states and priorities",
  description:
    "ROWS, not an enum — so a firm may rename 'Waiting Internal', add a ninth state, or " +
    "decide that statutory work is Critical, all without a deploy. Every rule in the product " +
    "reads the FLAGS on these rows and never their codes, which is what makes that promise " +
    "real rather than advertised. Retired rows are included: an admin needs to see what the " +
    "firm stopped using and be able to bring it back.",
  responses: {
    200: {
      description: "The vocabulary",
      content: { "application/json": { schema: VocabularyResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
  },
});

const createStateRoute = createRoute({
  method: "post",
  path: "/api/v1/work-vocabulary/states",
  tags: ["work"],
  summary: "Add a work-item state",
  request: {
    body: { content: { "application/json": { schema: CreateStateRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Added",
      content: { "application/json": { schema: WorkItemStateSchema } },
    },
    400: errorResponse("Not a valid code, or two flags that contradict each other"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer"),
    409: errorResponse("A state with that code already exists here"),
  },
});

const updateStateRoute = createRoute({
  method: "patch",
  path: "/api/v1/work-vocabulary/states/{stateId}",
  tags: ["work"],
  summary: "Rename, re-flag, reorder or retire a work-item state",
  description:
    "Marking one as the STARTING state un-marks the previous holder in the same statement. " +
    "Un-marking the only one is refused: the firm would be unable to create any work at all, " +
    "and a partial unique index can enforce at most one but never at least one.",
  request: {
    params: StateParam,
    body: { content: { "application/json": { schema: UpdateStateRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: WorkItemStateSchema } },
    },
    400: errorResponse("Two flags that contradict each other"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer"),
    404: errorResponse("No such state at this firm"),
    409: errorResponse("It would leave the firm with no starting state"),
  },
});

const createPriorityRoute = createRoute({
  method: "post",
  path: "/api/v1/work-vocabulary/priorities",
  tags: ["work"],
  summary: "Add a work-item priority",
  request: {
    body: { content: { "application/json": { schema: CreatePriorityRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Added",
      content: { "application/json": { schema: WorkItemPrioritySchema } },
    },
    400: errorResponse("Not a valid code or rank"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer"),
    409: errorResponse("A priority with that code already exists here"),
  },
});

const updatePriorityRoute = createRoute({
  method: "patch",
  path: "/api/v1/work-vocabulary/priorities/{priorityId}",
  tags: ["work"],
  summary: "Rename, re-rank, re-default or retire a work-item priority",
  description:
    "Moving the STATUTORY default changes the urgency of every filing created afterwards, " +
    "which is exactly why who moved it is recorded. Leaving the firm with no default or no " +
    "statutory default is refused — new work would have nothing to be created with.",
  request: {
    params: PriorityParam,
    body: { content: { "application/json": { schema: UpdatePriorityRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: WorkItemPrioritySchema } },
    },
    400: errorResponse("Not a valid rank"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer"),
    404: errorResponse("No such priority at this firm"),
    409: errorResponse("It would leave the firm with no default or no statutory default"),
  },
});

export function registerWorkItemRoutes(app: OpenAPIHono<AppEnv>, deps: WorkItemDeps): void {
  app.openapi(boardRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const items = await deps.service.board(
      s.tenantId,
      {
        // `mine` resolves to the SIGNED-IN person here rather than taking a
        // user id: "whose desk" is a question about the session, and accepting
        // an id would make it a way to read a colleague's board through a
        // filter nobody thought of as a permission.
        ...(q.mine === "true" ? { assigneeUserId: s.userId } : {}),
        ...(q.unassigned === "true" ? { unassignedOnly: true } : {}),
        ...(q.clientPartyId === undefined ? {} : { clientPartyId: q.clientPartyId }),
        ...(q.jobId === undefined ? {} : { jobId: q.jobId }),
        openOnly: q.includeDone !== "true",
      },
      q.asOf,
    );
    return c.json({ items: items.map(toWire) }, 200);
  });

  app.openapi(detailRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const detail = await deps.service.detail(s.tenantId, workItemId);
    return c.json(
      {
        item: toWire(detail.record),
        checklist: detail.checklist.map(toChecklistWire),
        dependencies: detail.dependencies.map((d) => ({
          id: d.id,
          workItemId: d.workItemId,
          dependsOnWorkItemId: d.dependsOnWorkItemId,
        })),
        reviews: detail.reviews.map(toReviewWire),
      },
      200,
    );
  });

  app.openapi(createRoute_, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const created = await deps.service.create(
      {
        tenantId: s.tenantId,
        clientPartyId: body.clientPartyId,
        entityPartyId: body.entityPartyId,
        title: body.title,
        description: body.description,
        priorityId: body.priorityId,
        assigneeUserId: body.assigneeUserId,
        dueOn: body.dueOn,
        isStatutoryDue: body.isStatutoryDue,
        isClientVisible: body.isClientVisible,
      },
      s.actor,
    );
    // Read back through the board's own read model so the response carries the
    // client's name, the state and the assignee — like every other row this
    // module returns. A create that answered with ids while the list answered
    // with names would leave the screen re-fetching to render what it just made.
    return c.json(toWire(await readBack(deps, s.tenantId, created.id)), 201);
  });

  app.openapi(updateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.update(
      {
        tenantId: s.tenantId,
        workItemId,
        title: body.title,
        description: body.description,
        priorityId: body.priorityId,
        dueOn: body.dueOn,
        isClientVisible: body.isClientVisible,
      },
      s.actor,
    );
    return c.json(toWire(await readBack(deps, s.tenantId, workItemId)), 200);
  });

  app.openapi(moveStateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.service.moveToState(
      {
        tenantId: s.tenantId,
        workItemId,
        stateId: body.stateId,
        blockedReason: body.blockedReason,
      },
      s.actor,
    );
    return c.json(toWire(await readBack(deps, s.tenantId, workItemId)), 200);
  });

  app.openapi(assignRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { assigneeUserId } = c.req.valid("json");
    await deps.service.assign({ tenantId: s.tenantId, workItemId, assigneeUserId }, s.actor);
    return c.json(toWire(await readBack(deps, s.tenantId, workItemId)), 200);
  });

  app.openapi(addChecklistRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const body = c.req.valid("json");
    const line = await deps.service.addChecklistItem(
      s.tenantId,
      workItemId,
      body.label,
      body.sortOrder,
    );
    return c.json(toChecklistWire(line), 201);
  });

  app.openapi(tickChecklistRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { checklistItemId } = c.req.valid("param");
    const { done } = c.req.valid("json");
    const line = await deps.service.setChecklistDone(
      s.tenantId,
      checklistItemId,
      done,
      s.userId,
    );
    return c.json(toChecklistWire(line), 200);
  });

  app.openapi(removeChecklistRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { checklistItemId } = c.req.valid("param");
    await deps.service.removeChecklistItem(s.tenantId, checklistItemId);
    return c.body(null, 204);
  });

  app.openapi(addDependencyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { dependsOnWorkItemId } = c.req.valid("json");
    const dep = await deps.service.addDependency(
      s.tenantId,
      workItemId,
      dependsOnWorkItemId,
      s.actor,
    );
    return c.json(
      { id: dep.id, workItemId: dep.workItemId, dependsOnWorkItemId: dep.dependsOnWorkItemId },
      201,
    );
  });

  app.openapi(removeDependencyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { dependencyId } = c.req.valid("param");
    await deps.service.removeDependency(s.tenantId, dependencyId, s.actor);
    return c.body(null, 204);
  });

  app.openapi(requestReviewRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { policyKey } = c.req.valid("json");
    const approval = await deps.service.requestReview(
      { tenantId: s.tenantId, workItemId, policyKey },
      s.actor,
    );
    const reviews = await deps.service.detail(s.tenantId, workItemId);
    const check = reviews.reviews.find((r) => r.approval.id === approval.id);
    if (!check) throw new Error(`review ${approval.id} was not readable after opening`);
    return c.json(toReviewWire(check), 201);
  });

  app.openapi(checkersRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { approvalId } = c.req.valid("param");
    const checkers = await deps.service.eligibleCheckers(s.tenantId, approvalId);
    return c.json(
      {
        checkers: checkers.map((k) => ({
          userId: k.userId,
          displayName: k.displayName,
          gradeName: k.gradeName,
          eligible: k.eligible,
          reason: k.reason,
        })),
      },
      200,
    );
  });

  app.openapi(decideReviewRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { approvalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const decided = await deps.service.decideReview(
      {
        tenantId: s.tenantId,
        approvalId,
        decision: body.decision,
        notes: body.notes,
        decidedBy: s.userId,
      },
      s.actor,
    );
    const detail = await deps.service.detail(s.tenantId, decided.workItemId);
    const check = detail.reviews.find((r) => r.approval.id === decided.id);
    if (!check) throw new Error(`review ${decided.id} was not readable after deciding`);
    return c.json(toReviewWire(check), 200);
  });

  app.openapi(pendingChecksRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const checks = await deps.service.pendingChecks(s.tenantId, s.userId);
    return c.json({ checks: checks.map(toCheckRowWire) }, 200);
  });

  app.openapi(vocabularyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const [states, priorities] = await Promise.all([
      deps.vocabulary.listStates(s.tenantId),
      deps.vocabulary.listPriorities(s.tenantId),
    ]);
    return c.json(
      { states: states.map(toStateWire), priorities: priorities.map(toPriorityWire) },
      200,
    );
  });

  app.openapi(createStateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const state = await deps.vocabulary.createState(
      {
        tenantId: s.tenantId,
        code: body.code,
        name: body.name,
        isInitial: body.isInitial,
        isTerminal: body.isTerminal,
        isBlocked: body.isBlocked,
        isSuccess: body.isSuccess,
        isUnderReview: body.isUnderReview,
        sortOrder: body.sortOrder,
      },
      s.actor,
    );
    return c.json(toStateWire(state), 201);
  });

  app.openapi(updateStateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { stateId } = c.req.valid("param");
    const body = c.req.valid("json");
    const state = await deps.vocabulary.updateState(
      {
        tenantId: s.tenantId,
        stateId,
        name: body.name,
        isInitial: body.isInitial,
        isTerminal: body.isTerminal,
        isBlocked: body.isBlocked,
        isSuccess: body.isSuccess,
        isUnderReview: body.isUnderReview,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
      s.actor,
    );
    return c.json(toStateWire(state), 200);
  });

  app.openapi(createPriorityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const priority = await deps.vocabulary.createPriority(
      {
        tenantId: s.tenantId,
        code: body.code,
        name: body.name,
        rank: body.rank,
        isDefault: body.isDefault,
        isStatutoryDefault: body.isStatutoryDefault,
      },
      s.actor,
    );
    return c.json(toPriorityWire(priority), 201);
  });

  app.openapi(updatePriorityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { priorityId } = c.req.valid("param");
    const body = c.req.valid("json");
    const priority = await deps.vocabulary.updatePriority(
      {
        tenantId: s.tenantId,
        priorityId,
        name: body.name,
        rank: body.rank,
        isDefault: body.isDefault,
        isStatutoryDefault: body.isStatutoryDefault,
        isActive: body.isActive,
      },
      s.actor,
    );
    return c.json(toPriorityWire(priority), 200);
  });
}

/** The row as the board renders it, after a write. Throws rather than 404s: the
 *  item was created or updated one line ago, so an absence here is a fault and
 *  not a missing resource. */
async function readBack(
  deps: WorkItemDeps,
  tenantId: string,
  workItemId: string,
): Promise<WorkItemRecord> {
  const detail = await deps.service.detail(tenantId, workItemId);
  return detail.record;
}

export const workItemRoutes = {
  board: boardRoute,
  detail: detailRoute,
  create: createRoute_,
  update: updateRoute,
  moveState: moveStateRoute,
  assign: assignRoute,
  addChecklist: addChecklistRoute,
  tickChecklist: tickChecklistRoute,
  removeChecklist: removeChecklistRoute,
  addDependency: addDependencyRoute,
  removeDependency: removeDependencyRoute,
  requestReview: requestReviewRoute,
  checkers: checkersRoute,
  decideReview: decideReviewRoute,
  pendingChecks: pendingChecksRoute,
  vocabulary: vocabularyRoute,
  createState: createStateRoute,
  updateState: updateStateRoute,
  createPriority: createPriorityRoute,
  updatePriority: updatePriorityRoute,
} as const;
