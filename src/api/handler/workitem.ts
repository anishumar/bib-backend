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
  WorkItemDependencyRecord,
  WorkItemNote,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemState,
} from "../../domain/workitem/model";
import { scopeOf } from "../scope";
import type { LinkableFiling } from "../../usecase/workitem/ports";

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
    sentBack: z
      .object({
        notes: z.string().nullable(),
        decidedAt: z.string(),
        decidedByName: z.string().nullable(),
      })
      .nullable()
      .openapi({
        description:
          "Sent back and not yet sent again (CA#29): the latest decided review was a " +
          "send-back, none is open, and the task is not finished. The checker's note, when, " +
          "and by whom. Null otherwise. My day shows it on the maker's desk.",
      }),
  })
  .openapi("WorkItem");

/** The task, and how many of its job's steps went with it (2026-09-27). */
const AssignResponse = WorkItemSchema.extend({
  stepsHandedOver: z.number().int().nonnegative().openapi({
    description:
      "How many of the job's steps moved to the new owner with the task: the steps nobody " +
      "held, or that the task's previous owner held, which the process lets the new owner " +
      "do. Zero when the task has no job, when it was taken off a desk, or when another " +
      "open task of the same job is on somebody else's desk.",
  }),
}).openapi("AssignedWorkItem");

const ChecklistItemSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    sortOrder: z.number().int(),
    doneAt: z.string().nullable(),
    doneByUserId: z.string().uuid().nullable(),
  })
  .openapi("ChecklistItem");

/**
 * One dependency, with the item at the other end of it RESOLVED.
 *
 * It was three uuids until a screen tried to render it. `WorkItem.blockedByOpen`
 * already carried the titles of the UNFINISHED blockers, so the detail response
 * could name some of what an item waits on and not the rest — and carried no
 * `dependencyId` at all, which is the one value the DELETE route takes. A panel
 * built on that could show a task and not offer to lift it.
 */
const DependencySchema = z
  .object({
    id: z.string().uuid(),
    workItemId: z.string().uuid(),
    dependsOnWorkItemId: z.string().uuid(),
    dependsOnTitle: z.string(),
    dependsOnStateName: z.string().openapi({
      description: "The FIRM's own word for the state that item is in, never a code.",
    }),
    dependsOnIsTerminal: z.boolean().openapi({
      description:
        "Whether the item this one waits on is FINISHED. The flag, never a state code — a " +
        "firm owns the names of its states. An unfinished blocker refuses this item's start; " +
        "a finished one is a record of what it used to wait on and refuses nothing, and a " +
        "screen drawing them the same offers somebody a reason to lift a dependency that is " +
        "not costing anything.",
    }),
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
    requestNote: z.string().nullable().openapi({
      description:
        "What the MAKER said when sending it to be checked (0330). Null when nothing was " +
        "said. Prose: on the row, never in the ledger.",
    }),
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

const WorkItemNoteSchema = z
  .object({
    id: z.string().uuid(),
    workItemId: z.string().uuid(),
    authorUserId: z.string().uuid(),
    authorName: z.string().nullable(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi("WorkItemNote");

// A FACTORY, for `viewerVerdict`'s reason: `.nullable()` on a schema that has
// been `.openapi(name)`d mutates the registered component, and `linked` is
// nullable where `open`'s rows are not.
const linkableFiling = () =>
  z.object({
    obligationId: z.string().uuid(),
    name: z.string().openapi({ description: "The filing, e.g. GSTR-3B." }),
    periodLabel: z.string(),
    statutoryDueOn: IsoDate,
    entityName: z.string().nullable(),
    stateName: z.string().openapi({ description: "The firm's own word for where the filing stands." }),
    filedOn: IsoDate.nullable(),
    filedByWorkItemId: z.string().uuid().nullable().openapi({
      description: "The task that filed it (Q063): this one, or a period job's task. Null while unfiled.",
    }),
    filedByTitle: z.string().nullable(),
  });
const LinkableFilingSchema = linkableFiling().openapi("LinkableFiling");

const TaskFilingResponse = z
  .object({
    linked: linkableFiling().nullable().openapi({
      description:
        "The filing this task files (CA#36): completing the task marks it filed, as completing " +
        "the calendar's own task does. Null when it files none.",
    }),
    open: z.array(LinkableFilingSchema).openapi({
      description:
        "The company's open filings with no task yet, by due date: what this task could file. " +
        "The company is the task's entity, or else its client.",
    }),
    filedHere: z.array(LinkableFilingSchema).openapi({
      description:
        "The filings this task filed besides its own (Q063): finishing a period job's task " +
        "files every open filing of its company inside the job's period on a rule its service " +
        "carries, and reopening it un-files exactly these.",
    }),
  })
  .openapi("TaskFilingResponse");

const LinkFilingRequest = z
  .object({ obligationId: z.string().uuid() })
  .openapi("LinkTaskFilingRequest");

const BoardResponse = z.object({ items: z.array(WorkItemSchema) }).openapi("WorkBoardResponse");

/**
 * MAY THE VIEWER DECIDE THIS CHECK — one SHAPE, and deliberately not one
 * registered schema.
 *
 * A FACTORY, because `.nullable()` on a schema that has been `.openapi(name)`d
 * mutates the registered COMPONENT. Sharing one object between the queue (where
 * a verdict is always present) and an item's page (where it is null once the
 * review is decided) marked `WorkItemCheckViewer` nullable for both — so the
 * generated client made the queue's own verdict optional and every reader of it
 * a compile error. Found by regenerating and reading the spec, which is the
 * only place it shows.
 */
const viewerVerdict = () =>
  z.object({
    eligible: z.boolean(),
    reason: z.string().nullable().openapi({
      description:
        "What to SAY when they may not — the SENTENCE, not a code, and the same prose the " +
        "checkers endpoint returns, so one refusal is never phrased two ways. Null when " +
        "they may check it.",
    }),
  });

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
    notes: z.array(WorkItemNoteSchema).openapi({
      description:
        "The task's own notes, oldest first (0330). Append-only: a correction is a second " +
        "note. Staff only; the client portal never reads them.",
    }),
    openReviewViewer: viewerVerdict().nullable().openapi({
      description:
        "May the CALLER decide the open review — the same verdict `/work-item-checks` puts on " +
        "every one of its rows, and null when there is no open review. One field rather than " +
        "one per row, because the question only exists for the open one: 'may you check this' " +
        "is not asked of a review already approved or sent back. Before this the item's page " +
        "could derive only maker != checker from `submittedBy` — one third of the rule — so " +
        "the ladder and the grade threshold were found by pressing Approve and reading a 403, " +
        "while the queue screen had been showing the same person the full answer since T2.9.",
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
  // NEVER NULL HERE: every row of the queue is an OPEN check, so the question
  // always applies.
  viewer: viewerVerdict().openapi("WorkItemCheckViewer"),
  // On the QUEUE's row, not the review's: a list of checks links the client and
  // says when the work is due (V2.1's My day); a task's own page has both.
  clientPartyId: z.string().uuid(),
  entityPartyId: z.string().uuid().nullable().openapi({
    description: "The company the work is for, when the task names one (F32).",
  }),
  entityName: z.string().nullable(),
  dueOn: IsoDate.nullable().openapi({
    description: "The task's own due day, or null when it has none.",
  }),
}).openapi("WorkItemCheckRow");

const ChecksResponse = z
  .object({ checks: z.array(WorkItemCheckRowSchema) })
  .openapi("WorkItemChecksResponse");

const ReviewRulesResponse = z
  .object({
    rules: z.array(z.object({ key: z.string(), label: z.string() })).openapi({
      description:
        "The firm's review rules in force, by key. One is applied to a task sent with no rule " +
        "named; with several the sender picks.",
    }),
  })
  .openapi("ReviewRulesResponse");

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
    isClientVisible: z.boolean().optional().openapi({
      description:
        "Show this task on the client's portal. Absent means FALSE (V1.4): a task raised by hand is often an internal note, and the portal is the client's screen. Work spawned from an engagement or a statutory filing is shown regardless.",
    }),
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
        "Absent means the FIRM'S OWN: its one published rule, applied; with several, a 400 " +
        "(REVIEW_RULE_NEEDED) naming them so the sender picks; with none, maker != checker " +
        "alone. `GET /api/v1/review-rules` lists them.",
    }),
    note: z.string().nullable().optional().openapi({
      description:
        "What the maker says to the checker (0330), at most 2,000 characters. Blank means none.",
    }),
  })
  .openapi("RequestWorkItemReviewRequest");

const AddNoteRequest = z
  .object({
    body: z.string().openapi({
      description:
        "The note, at most 2,000 characters once trimmed. Who wrote it is the session's user.",
    }),
  })
  .openapi("AddWorkItemNoteRequest");

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
    sentBack:
      r.sentBack === null
        ? null
        : { notes: r.sentBack.notes, decidedAt: r.sentBack.decidedAt, decidedByName: r.sentBack.decidedByName },
  };
}

function toDependencyWire(
  d: WorkItemDependencyRecord,
): z.infer<typeof DependencySchema> {
  return {
    id: d.dependency.id,
    workItemId: d.dependency.workItemId,
    dependsOnWorkItemId: d.dependency.dependsOnWorkItemId,
    dependsOnTitle: d.dependsOnTitle,
    dependsOnStateName: d.dependsOnStateName,
    dependsOnIsTerminal: d.dependsOnIsTerminal,
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
    requestNote: c.approval.requestNote,
    policyLabel: c.policyLabel,
    decision: c.approval.decision,
    notes: c.approval.notes,
    decidedBy: c.approval.decidedBy,
    decidedAt: c.approval.decidedAt,
  };
}

function toNoteWire(n: WorkItemNote): z.infer<typeof WorkItemNoteSchema> {
  return {
    id: n.id,
    workItemId: n.workItemId,
    authorUserId: n.authorUserId,
    authorName: n.authorName,
    body: n.body,
    createdAt: n.createdAt,
  };
}

function toLinkableWire(f: LinkableFiling): z.infer<typeof LinkableFilingSchema> {
  return {
    obligationId: f.obligationId,
    name: f.name,
    periodLabel: f.periodLabel,
    statutoryDueOn: f.statutoryDueOn,
    entityName: f.entityName,
    stateName: f.stateName,
    filedOn: f.filedOn,
    filedByWorkItemId: f.filedByWorkItemId,
    filedByTitle: f.filedByTitle,
  };
}

function filingWire(r: {
  readonly linked: LinkableFiling | null;
  readonly open: readonly LinkableFiling[];
  readonly filedHere: readonly LinkableFiling[];
}): z.infer<typeof TaskFilingResponse> {
  return {
    linked: r.linked === null ? null : toLinkableWire(r.linked),
    open: r.open.map(toLinkableWire),
    filedHere: r.filedHere.map(toLinkableWire),
  };
}

function toCheckRowWire(c: WorkItemCheckOnDesk): z.infer<typeof WorkItemCheckRowSchema> {
  return {
    ...toReviewWire(c),
    viewer: { eligible: c.viewer.eligible, reason: c.viewer.reason },
    clientPartyId: c.clientPartyId,
    entityPartyId: c.entityPartyId,
    entityName: c.entityName,
    dueOn: c.dueOn,
  };
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
      "It is already in that state, the state has been retired, it is still waiting on " +
        "unfinished work, or (into a finished-and-done state) a checklist line is unticked",
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
    200: { description: "Assigned", content: { "application/json": { schema: AssignResponse } } },
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

const addNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/notes",
  tags: ["work"],
  summary: "Write a note on a task",
  description:
    "Append-only (0330): a correction is a second note. The ledger records that a note was " +
    "written and never what it says.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: AddNoteRequest } }, required: true },
  },
  responses: {
    201: { description: "Written", content: { "application/json": { schema: WorkItemNoteSchema } } },
    400: errorResponse("A blank note, or one over 2,000 characters"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
  },
});

const taskFilingRoute = createRoute({
  method: "get",
  path: "/api/v1/work-items/{workItemId}/filing",
  tags: ["work"],
  summary: "The filing this task files, and the ones it could",
  request: { params: WorkItemParam },
  responses: {
    200: { description: "The filing link", content: { "application/json": { schema: TaskFilingResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
    404: errorResponse("No such work item at this firm"),
  },
});

const linkFilingRoute = createRoute({
  method: "put",
  path: "/api/v1/work-items/{workItemId}/filing",
  tags: ["work"],
  summary: "Make this task the one that files a filing",
  description:
    "Audit 2026-10-03, CA#36. Writes the task into the column the calendar's own raised task " +
    "uses, so completing it marks the filing filed and the calendar raises no second task. A " +
    "task already finished files it at once. Refused (409) for another company's filing, one " +
    "already filed, taken off the calendar, decided after a missed deadline, or with a task of " +
    "its own, and when the task already files a different filing.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: LinkFilingRequest } }, required: true },
  },
  responses: {
    200: { description: "Linked", content: { "application/json": { schema: TaskFilingResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item or filing at this firm"),
    409: errorResponse("The filing cannot be linked to this task; the message says why"),
  },
});

const unlinkFilingRoute = createRoute({
  method: "delete",
  path: "/api/v1/work-items/{workItemId}/filing",
  tags: ["work"],
  summary: "Take this task off the filing it files",
  description: "Only while the filing is not filed. The calendar raises its own task when it is due.",
  request: { params: WorkItemParam },
  responses: {
    200: { description: "Unlinked", content: { "application/json": { schema: TaskFilingResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
    409: errorResponse("The filing is already filed by this task"),
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
    "control. The item moves into the firm's 'with a checker' state when the firm has " +
    "flagged one (0073); without one, a task still in its starting state moves to the firm's " +
    "working state (F28). Refused while a checklist line is unticked (CHECKLIST_OPEN): " +
    "sending work to be checked says it is done, as a process step's Done waits for its " +
    "sub-steps.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: RequestReviewRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Waiting to be checked",
      content: { "application/json": { schema: WorkItemReviewSchema } },
    },
    400: errorResponse("No rule named, and the firm has more than one in force (REVIEW_RULE_NEEDED)"),
    401: errorResponse("No authenticated session"),
    403: errorResponse(
      "The session has not selected an org, the role may not write work, or the rule named is not in force",
    ),
    404: errorResponse("No such work item at this firm"),
    409: errorResponse("A review is already open on it, or a checklist line is unticked"),
  },
});

const reviewRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/review-rules",
  tags: ["work"],
  summary: "The firm's rules for who checks work, as a task's sender picks from them",
  description:
    "Labels and keys only, on `party:read`: whoever sends a task to be checked sees which " +
    "rule it will be checked under. The rules themselves are written on Who checks work.",
  responses: {
    200: { description: "The rules", content: { "application/json": { schema: ReviewRulesResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
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
  description:
    "Approving FINISHES the task: it moves to the firm's finished-and-done state (terminal " +
    "and a success), which stamps the completion and tells the compliance calendar, exactly " +
    "as moving it there by hand does. Sending it back puts a task that is in the firm's " +
    "'with a checker' state back into its working state. A task already finished or " +
    "cancelled is left where it is. Approve is refused while a checklist line is unticked.",
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
    409: errorResponse("Somebody else already decided it, or (Approve) a checklist line is unticked"),
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

// ── where an unsigned letter's work will land (T6.17) ─────────────────────────

const LetterRoutingSchema = z
  .object({
    letterId: z.string().uuid(),
    clientPartyId: z.string().uuid().openapi({
      description: "The letter's client: whose account team decides the answer.",
    }),
    onDate: IsoDate.openapi({
      description:
        "The firm's day the owner rule was asked on. A forecast: the work is routed again, " +
        "on its own day, when the signed letter becomes work.",
    }),
    depts: z.array(
      z.object({
        deptCode: z.string().nullable().openapi({
          description: "The Dept the lines' services are filed under; null for none.",
        }),
        deptName: z.string().nullable().openapi({
          description: "The firm's name for it; null when the code is not one of its Depts.",
        }),
        lines: z.array(z.object({ lineId: z.string().uuid(), name: z.string() })),
        how: z.enum(["spoc", "key_manager", "partner"]).nullable().openapi({
          description:
            "Which rung of the owner rule takes the work: the client's SPOC for the Dept, " +
            "else the client's Key Manager, else the person who signs for the firm, to hand " +
            "out. Null when nobody could be named.",
        }),
        userId: z.string().uuid().nullable(),
        ownerName: z.string().nullable(),
        reason: z.enum(["no_spoc", "no_dept", "unknown_dept"]).nullable().openapi({
          description:
            "Why the SPOC rung was passed: no SPOC for the Dept on this client, the service " +
            "is filed under no Dept, or it names a Dept the firm does not have. Null when a " +
            "SPOC takes it.",
        }),
      }),
    ),
  })
  .openapi("LetterRouting");

const letterRoutingRoute = createRoute({
  method: "get",
  path: "/api/v1/engagement-letters/{letterId}/routing",
  tags: ["work"],
  summary: "Whose desk an engagement letter's work will land on",
  description:
    "The owner rule asked for each Dept the letter's lines are filed under, as it will be " +
    "asked when the signed letter becomes work: the client's SPOC for the Dept, else the " +
    "client's Key Manager, else the person who signs for the firm, to hand out. For the " +
    "warning above Send (T6.17): a WARNING, never a refusal, so the sender can name a SPOC " +
    "on the client's page while it still changes where the work goes.",
  request: { params: z.object({ letterId: z.string().uuid() }) },
  responses: {
    200: {
      description: "The routing, one row per Dept",
      content: { "application/json": { schema: LetterRoutingSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
    404: errorResponse("No such engagement letter at this firm"),
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
  app.openapi(letterRoutingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { letterId } = c.req.valid("param");
    const r = await deps.service.routingForLetter(s.tenantId, letterId);
    return c.json(
      {
        letterId: r.letterId,
        clientPartyId: r.clientPartyId,
        onDate: r.onDate,
        depts: r.depts.map((d) => ({
          deptCode: d.deptCode,
          deptName: d.deptName,
          lines: d.lines.map((l) => ({ lineId: l.lineId, name: l.name })),
          how: d.how,
          userId: d.userId,
          ownerName: d.ownerName,
          reason: d.reason,
        })),
      },
      200,
    );
  });

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
    // THE CALLER, so the verdict is about them. `pendingChecks` takes the same
    // argument from the same place.
    const detail = await deps.service.detail(s.tenantId, workItemId, s.userId);
    return c.json(
      {
        item: toWire(detail.record),
        checklist: detail.checklist.map(toChecklistWire),
        dependencies: detail.dependencies.map(toDependencyWire),
        reviews: detail.reviews.map(toReviewWire),
        notes: detail.notes.map(toNoteWire),
        openReviewViewer:
          detail.openReviewViewer === null ? null : { ...detail.openReviewViewer },
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
    const { stepsHandedOver } = await deps.service.assign(
      { tenantId: s.tenantId, workItemId, assigneeUserId },
      s.actor,
    );
    return c.json({ ...toWire(await readBack(deps, s.tenantId, workItemId)), stepsHandedOver }, 200);
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
    // READ BACK THROUGH THE JOINED LIST, like every other create in this
    // codebase that answers with names. A 201 carrying three uuids while the
    // list carries titles leaves the screen re-fetching to render what it just
    // made — and this one would then have to guess the state name.
    const created = (await deps.service.detail(s.tenantId, workItemId)).dependencies.find(
      (d) => d.dependency.id === dep.id,
    );
    if (created === undefined) {
      throw new Error(`work item dependency ${dep.id} was not readable after creation`);
    }
    return c.json(toDependencyWire(created), 201);
  });

  app.openapi(removeDependencyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { dependencyId } = c.req.valid("param");
    await deps.service.removeDependency(s.tenantId, dependencyId, s.actor);
    return c.body(null, 204);
  });

  app.openapi(taskFilingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    return c.json(filingWire(await deps.service.filingFor(s.tenantId, workItemId)), 200);
  });

  app.openapi(linkFilingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { obligationId } = c.req.valid("json");
    await deps.service.linkFiling(s.tenantId, workItemId, obligationId, s.actor);
    return c.json(filingWire(await deps.service.filingFor(s.tenantId, workItemId)), 200);
  });

  app.openapi(unlinkFilingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    await deps.service.unlinkFiling(s.tenantId, workItemId, s.actor);
    return c.json(filingWire(await deps.service.filingFor(s.tenantId, workItemId)), 200);
  });

  app.openapi(addNoteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const note = await deps.service.addNote(
      { tenantId: s.tenantId, workItemId, body, authorUserId: s.userId },
      s.actor,
    );
    return c.json(toNoteWire(note), 201);
  });

  app.openapi(requestReviewRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const { policyKey, note } = c.req.valid("json");
    const approval = await deps.service.requestReview(
      { tenantId: s.tenantId, workItemId, policyKey, note },
      s.actor,
    );
    const reviews = await deps.service.detail(s.tenantId, workItemId);
    const check = reviews.reviews.find((r) => r.approval.id === approval.id);
    if (!check) throw new Error(`review ${approval.id} was not readable after opening`);
    return c.json(toReviewWire(check), 201);
  });

  app.openapi(reviewRulesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rules = await deps.service.reviewRules(s.tenantId);
    return c.json({ rules: rules.map((r) => ({ key: r.key, label: r.label })) }, 200);
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
  addNote: addNoteRoute,
  taskFiling: taskFilingRoute,
  linkFiling: linkFilingRoute,
  unlinkFiling: unlinkFilingRoute,
  checkers: checkersRoute,
  reviewRules: reviewRulesRoute,
  decideReview: decideReviewRoute,
  pendingChecks: pendingChecksRoute,
  vocabulary: vocabularyRoute,
  createState: createStateRoute,
  updateState: updateStateRoute,
  createPriority: createPriorityRoute,
  updatePriority: updatePriorityRoute,
  letterRouting: letterRoutingRoute,
} as const;
