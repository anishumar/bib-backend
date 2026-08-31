// The escalation queue over HTTP (T4.5) — transport only. Parses the validated
// input, calls exactly one use-case method, and maps the result field by field.
// Never forwards a domain object: zod-openapi documents a response without
// validating it, so a field on the wire but not in the schema is a field the
// generated frontend client cannot see.
//
// ── THERE IS ONE ROUTE, AND IT IS A READ ───────────────────────────────────
//
// No acknowledge, no dismiss, no snooze. A notice ends when the WORK ends —
// the task is finished or somebody picks it up, the filing is filed or a
// partner decides about it — which migration 0058 explains is a join rather
// than a column. A dismiss button would let the one queue whose entire value is
// being believed be emptied without anything actually happening, which is how
// an escalation ladder becomes decoration.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { EscalationService } from "../../usecase/escalation/service";
import type { EscalationRecord } from "../../usecase/escalation/ports";
import { scopeOf } from "../scope";

export interface EscalationDeps {
  readonly service: EscalationService;
}

const Watch = z.enum(["work_item_due", "work_item_unassigned", "obligation_target"]).openapi({
  description:
    "What the rung was watching. 'work_item_due' is the SLA the client was promised; " +
    "'work_item_unassigned' is a task nobody has picked up, counted from its creation because " +
    "it has no other clock; 'obligation_target' is the firm's own T-X on a filing, with the " +
    "statutory date still ahead — the one this ladder exists for.",
});

const Target = z.enum(["assignee", "manager", "grade_at_least"]).openapi({
  description:
    "Who the firm's ladder said to tell. 'grade_at_least' is not resolved to a person: the " +
    "notice is addressed to a RANK, so everybody senior enough sees it and it does not die " +
    "while one partner is on leave.",
});

/** A person on the queue. The shape `EventRecord.actor` already has, and the
 *  EMAIL is why: a display name is optional on an account and is genuinely
 *  empty at real firms, so a row would otherwise say somebody was told and not
 *  say who. */
const Person = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string(),
  })
  .openapi("EscalationPerson");

const EscalationRowSchema = z
  .object({
    id: z.string().uuid(),
    workItemId: z.string().uuid().nullable(),
    obligationInstanceId: z.string().uuid().nullable(),
    rungKey: z.string().openapi({
      description:
        "The rung's own key from the firm's published ladder. A key and never an index, so a " +
        "row stays readable after the ladder moves under it.",
    }),
    rungLabel: z.string().openapi({
      description:
        "What the firm called this rung, resolved from the ladder in force NOW. Falls back to " +
        "the key when the rung has since been removed — the notice is still a fact, and the " +
        "label is only its name.",
    }),
    watch: Watch,
    afterDays: z.number().int().openapi({
      description:
        "The rung's threshold AS IT WAS when this fired, snapshotted on the row. A later edit " +
        "to the ladder cannot make a notice that went out on time look early.",
    }),
    daysPast: z.number().int().openapi({
      description: "How far past the watched date it was on the day this fired.",
    }),
    target: Target,
    raisedToUserId: z.string().uuid().nullable(),
    raisedTo: Person.nullable().openapi({
      description:
        "Who was told. Null has TWO meanings and `note` tells them apart: a notice that reached " +
        "nobody always carries one, and a notice whose account no longer resolves carries none. " +
        "The audit trail's `actor` makes the same distinction the same way.",
    }),
    minGradeRank: z.number().int().nullable().openapi({
      description: "Set instead of a person when the rung addresses a grade and above.",
    }),
    note: z.string().nullable().openapi({
      description:
        "Why nobody could be named — nobody holds the work, nobody is recorded above them, or " +
        "no active member holds the rank the rung asks for. A real state and not an error, and " +
        "it is exactly the row somebody has to look at.",
    }),
    raisedOn: z.string().openapi({ description: "The calendar day it fired, YYYY-MM-DD." }),
    subjectTitle: z.string(),
    clientName: z.string().nullable().openapi({
      description:
        "Who is billed. Null on a filing — an obligation is owed by the ENTITY and carries no " +
        "client.",
    }),
    entityName: z.string().nullable().openapi({
      description:
        "WHICH of the client's companies. A group of four files four sets of returns (G0.1), so " +
        "a row naming only the client is four identical rows.",
    }),
    holder: Person.nullable().openapi({
      description:
        "Who holds the work TODAY, which may not be who was told — somebody may have picked it " +
        "up since. The gap between the two is how a reader sees the escalation worked.",
    }),
    dueOn: z.string().nullable(),
    stateName: z.string().nullable(),
  })
  .openapi("EscalationRow");

const QueryParams = z.object({
  mine: z
    .enum(["true", "false"])
    .optional()
    // NEVER `z.coerce.boolean()`. A query string carries text and
    // `Boolean("false")` is true, which is how `?includeSettled=false` shipped
    // inert in T3.2 — every layer behaved and the wrong branch ran.
    .transform((v) => v === "true")
    .openapi({
      description:
        "Narrow to what THIS reader was addressed by — their own name, or a rank they actually " +
        "hold. Off by default, and that default is the decision: a queue filtered to what you " +
        "personally may act on hides that six tasks have been escalated for a week because " +
        "nobody senior enough looked, which is the failure the ladder exists to surface.",
    }),
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/escalations",
  tags: ["escalations"],
  summary: "Work the firm's own ladder has escalated",
  description:
    "Notices whose underlying work is still open, worst first. A row leaves this list when the " +
    "WORK moves — the task is finished, somebody picks up an unassigned one, the filing is " +
    "filed or decided about — and there is deliberately no way to dismiss one by hand.",
  request: { query: QueryParams },
  responses: {
    200: {
      description: "The queue",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(EscalationRowSchema),
            ladderPublished: z.boolean().openapi({
              description:
                "Whether this firm has published an escalation ladder at all. FALSE is why an " +
                "empty queue is empty, and without it a firm that has never set one cannot " +
                "tell that apart from everything being on time — which is the difference " +
                "between working software and silent software.",
            }),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read work"),
  },
});

export function registerEscalationRoutes(app: OpenAPIHono<AppEnv>, deps: EscalationDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { mine } = c.req.valid("query");

    // The viewer is resolved from the caller's OWN membership, never from the
    // wire — otherwise a reader could name a rank they do not hold and read a
    // queue meant for partners.
    const viewer = mine ? await deps.service.viewerFor(s.tenantId, s.userId) : null;
    const rows = await deps.service.queue(s.tenantId, viewer);
    const ladder = await deps.service.ladderFor(s.tenantId);

    // Labels come from the ladder in force NOW, and the key is the fallback.
    // Storing the label on the notice would have frozen a word the firm is
    // allowed to change; re-resolving it means a renamed rung reads correctly
    // everywhere, and a REMOVED one still names itself.
    const labels = new Map((ladder?.rungs ?? []).map((r) => [r.key, r.label]));

    return c.json(
      {
        rows: rows.map((r) => toWire(r, labels)),
        ladderPublished: ladder !== null && ladder.rungs.length > 0,
      },
      200,
    );
  });
}

function toWire(
  r: EscalationRecord,
  labels: ReadonlyMap<string, string>,
): z.infer<typeof EscalationRowSchema> {
  return {
    id: r.id,
    workItemId: r.workItemId,
    obligationInstanceId: r.obligationInstanceId,
    rungKey: r.rungKey,
    rungLabel: labels.get(r.rungKey) ?? r.rungKey,
    // The CHECK in migration 0058 is what makes these narrowings safe: the
    // column holds one of three words, and a row that did not would be a schema
    // and a handler that have drifted apart.
    watch: r.watch as "work_item_due" | "work_item_unassigned" | "obligation_target",
    afterDays: r.afterDays,
    daysPast: r.daysPast,
    target: r.target as "assignee" | "manager" | "grade_at_least",
    raisedToUserId: r.raisedToUserId,
    raisedTo: r.raisedTo,
    minGradeRank: r.minGradeRank,
    note: r.note,
    raisedOn: r.raisedOn,
    subjectTitle: r.subjectTitle,
    clientName: r.clientName,
    entityName: r.entityName,
    holder: r.holder,
    dueOn: r.dueOn,
    stateName: r.stateName,
  };
}
