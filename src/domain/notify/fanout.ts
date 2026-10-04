// The outbox's map: which ledger event tells whom what, and what it closes
// (0323).
//
// PURE. An event goes in, a plan comes out: notifications to write, addressed
// by RELATIONSHIP (the task's holder, the client's Key Manager, whoever may
// decide a missed filing), and notifications the event makes moot. Turning a
// relationship into people is the use case's job, through ports, because it
// reads the firm's roster as it stands when the event is read.
//
// ── WHY THE CATALOGUE IS HERE AND NOT IN THE PRODUCERS ─────────────────────
//
// Every producer already writes its event (EVENT-CONTRACT §4: after the change
// committed). Reading those is the one place a forgotten notification cannot
// happen: a module cannot skip the ledger, and this map is the whole list of
// what the bell says, reviewable on one screen.
//
// ── RESOLVING ──────────────────────────────────────────────────────────────
//
// A notification about work ends when the work does: the task finishes, the
// check is decided, the request is closed. The event that ends it says so here,
// and the adapter resolves only rows CAUSED BEFORE that event, so a later
// re-read of an old event never closes a newer notification.
import type { NotifyCategory } from "./model";

/** One ledger event, as the outbox reads it. */
export interface LedgerFact {
  readonly id: string;
  readonly verb: string;
  readonly objectId: string;
  /** The person who acted, or null for the system. Never told about their own act. */
  readonly actorUserId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Who a notification is for, by relationship. */
export type Audience =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "key_manager"; readonly clientPartyId: string }
  | { readonly kind: "permission"; readonly permission: string }
  | { readonly kind: "grade_at_least"; readonly rank: number }
  | { readonly kind: "work_item_assignee"; readonly workItemId: string }
  | { readonly kind: "work_item_checkers"; readonly approvalId: string }
  | { readonly kind: "step_checkers"; readonly jobId: string; readonly stepKey: string }
  | { readonly kind: "proposal_preparer"; readonly proposalId: string }
  | { readonly kind: "letter_sender"; readonly letterId: string }
  /** The invoice's manager (whose revenue it is), else the client's Key Manager. */
  | { readonly kind: "invoice_manager"; readonly invoiceId: string }
  /** The bill's manager, else the client's Key Manager. */
  | { readonly kind: "due_manager"; readonly dueId: string }
  /** The request's assignee, else the client's Key Manager. With
   *  `onlyUnplaced`, nobody when it has an assignee: its `assigned` event
   *  already told them. */
  | { readonly kind: "request_owner"; readonly requestId: string; readonly onlyUnplaced: boolean }
  | { readonly kind: "ask_owner"; readonly askId: string };

export interface Announce {
  readonly category: NotifyCategory;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly to: readonly Audience[];
  /** People this announcement skips because another one in the same plan
   *  already tells them (a lead's owner hears "a lead is given to you", not
   *  also "a new lead comes in"). */
  readonly except?: readonly string[];
}

export interface Resolve {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly categories: readonly NotifyCategory[];
  /** Only the notifications about this step of the job. */
  readonly stepKey?: string;
  /** Leave this person's open notifications alone (the new holder's). */
  readonly exceptRecipient?: string | null;
}

export interface Plan {
  readonly announce: readonly Announce[];
  readonly resolve: readonly Resolve[];
}

const NOTHING: Plan = { announce: [], resolve: [] };

/** Everything about a task that a finished task makes moot. */
const WORK_ITEM_OPEN: readonly NotifyCategory[] = ["task_assigned", "check_requested", "escalation", "client_answered"];
const JOB_STEP_OPEN: readonly NotifyCategory[] = ["step_assigned", "check_requested"];

/** The verbs the outbox reads. Anything else is never fetched. */
export const FANOUT_VERBS = [
  "work_item.created",
  "work_item.assigned",
  "work_item.review_requested",
  "work_item.review_approved",
  "work_item.review_rejected",
  "work_item.completed",
  "work_item.state_changed",
  "work_item.escalated",
  "job.step_assigned",
  "job.step_advanced",
  "job.step_skipped",
  "job.completed",
  "job.cancelled",
  "output.approved",
  "output.rejected",
  "obligation.escalated",
  "obligation.missed",
  "obligation.filed",
  "obligation.resolved",
  "lead.captured",
  "lead.owner_assigned",
  "lead.stage_changed",
  "client_request.raised",
  "client_request.assigned",
  "client_request.replied",
  "client_request.closed",
  "client_request.withdrawn",
  "client_ask.answered",
  "client_ask.closed",
  "client_ask.withdrawn",
  "proposal.accepted",
  "proposal.rejected",
  "engagement_letter.signed",
  "payment.recorded",
  "billing_due.created",
  "billing_due.invoiced",
  "billing_due.skipped",
  "billing_due.covered",
  "dunning.escalated",
  "dunning.decided",
  "tenant.advance_digest_sent",
] as const;

/**
 * The plan for one event. An event the map does not know, or one whose payload
 * lacks what the plan needs, plans nothing: a missing notification is a gap,
 * a wrong one is a lie.
 */
export function planFor(e: LedgerFact): Plan {
  const p = e.payload;
  switch (e.verb) {
    // ── work ──────────────────────────────────────────────────────────────
    // A task raised BY HAND with somebody named writes `created` and no
    // `assigned` (the walk found it). One the engine spawns or the calendar
    // raises writes both, so only the hand-raised one is read here: telling
    // the same person twice would be the bell's first lie.
    case "work_item.created":
      return p["origin"] === "manual" && p["assigned"] === true
        ? {
            resolve: [],
            announce: [
              {
                category: "task_assigned",
                sourceType: "work_item",
                sourceId: e.objectId,
                payload: {},
                to: [{ kind: "work_item_assignee", workItemId: e.objectId }],
              },
            ],
          }
        : NOTHING;

    case "work_item.assigned": {
      const userId = str(p, "userId");
      return {
        resolve: [{ sourceType: "work_item", sourceId: e.objectId, categories: ["task_assigned"], exceptRecipient: userId }],
        announce:
          userId === null
            ? []
            : [{ category: "task_assigned", sourceType: "work_item", sourceId: e.objectId, payload: {}, to: [user(userId)] }],
      };
    }

    case "work_item.review_requested": {
      const workItemId = str(p, "workItemId");
      if (workItemId === null) return NOTHING;
      return {
        resolve: [],
        announce: [
          {
            category: "check_requested",
            sourceType: "work_item",
            sourceId: workItemId,
            payload: {},
            to: [{ kind: "work_item_checkers", approvalId: e.objectId }],
          },
        ],
      };
    }

    case "work_item.review_approved":
    case "work_item.review_rejected": {
      const workItemId = str(p, "workItemId");
      return workItemId === null
        ? NOTHING
        : { announce: [], resolve: [{ sourceType: "work_item", sourceId: workItemId, categories: ["check_requested"] }] };
    }

    case "work_item.completed":
      return { announce: [], resolve: [{ sourceType: "work_item", sourceId: e.objectId, categories: WORK_ITEM_OPEN }] };

    case "work_item.state_changed":
      // A cancelled task reaches a terminal state too; that ends it as surely.
      return p["isTerminal"] === true
        ? { announce: [], resolve: [{ sourceType: "work_item", sourceId: e.objectId, categories: WORK_ITEM_OPEN }] }
        : NOTHING;

    case "work_item.escalated":
    case "obligation.escalated": {
      const to = escalationAudience(p);
      if (to === null) return NOTHING;
      return {
        resolve: [],
        announce: [
          {
            category: "escalation",
            sourceType: e.verb === "work_item.escalated" ? "work_item" : "obligation_instance",
            sourceId: e.objectId,
            payload: pick(p, ["watch", "daysPast", "rungKey"]),
            to: [to],
          },
        ],
      };
    }

    case "job.step_assigned": {
      const stepKey = str(p, "stepKey");
      const userId = str(p, "assigneeUserId");
      if (stepKey === null) return NOTHING;
      return {
        resolve: [{ sourceType: "job", sourceId: e.objectId, categories: ["step_assigned"], stepKey, exceptRecipient: userId }],
        announce:
          userId === null
            ? []
            : [{ category: "step_assigned", sourceType: "job", sourceId: e.objectId, payload: { stepKey }, to: [user(userId)] }],
      };
    }

    case "job.step_advanced": {
      const stepKey = str(p, "stepKey");
      if (stepKey === null) return NOTHING;
      if (p["awaitingCheck"] === true) {
        return {
          resolve: [{ sourceType: "job", sourceId: e.objectId, categories: ["step_assigned"], stepKey }],
          announce: [
            {
              category: "check_requested",
              sourceType: "job",
              sourceId: e.objectId,
              payload: { stepKey },
              to: [{ kind: "step_checkers", jobId: e.objectId, stepKey }],
            },
          ],
        };
      }
      return p["to"] === "done"
        ? { announce: [], resolve: [{ sourceType: "job", sourceId: e.objectId, categories: JOB_STEP_OPEN, stepKey }] }
        : NOTHING;
    }

    case "job.step_skipped": {
      const stepKey = str(p, "stepKey");
      return stepKey === null
        ? NOTHING
        : { announce: [], resolve: [{ sourceType: "job", sourceId: e.objectId, categories: JOB_STEP_OPEN, stepKey }] };
    }

    case "job.completed":
    case "job.cancelled":
      return { announce: [], resolve: [{ sourceType: "job", sourceId: e.objectId, categories: JOB_STEP_OPEN }] };

    case "output.approved":
    case "output.rejected": {
      const jobId = str(p, "jobId");
      const stepKey = str(p, "stepKey");
      return jobId === null || stepKey === null
        ? NOTHING
        : { announce: [], resolve: [{ sourceType: "job", sourceId: jobId, categories: ["check_requested"], stepKey }] };
    }

    // ── deadlines ─────────────────────────────────────────────────────────
    case "obligation.missed": {
      const workItemId = str(p, "workItemId");
      return {
        resolve: [],
        announce: [
          {
            category: "filing_missed",
            sourceType: "obligation_instance",
            sourceId: e.objectId,
            payload: pick(p, ["daysLate"]),
            to: [
              { kind: "permission", permission: "obligation:resolve" },
              ...(workItemId === null ? [] : [{ kind: "work_item_assignee" as const, workItemId }]),
            ],
          },
        ],
      };
    }

    case "obligation.filed":
    case "obligation.resolved":
      return {
        announce: [],
        resolve: [{ sourceType: "obligation_instance", sourceId: e.objectId, categories: ["filing_missed", "escalation"] }],
      };

    // ── clients ───────────────────────────────────────────────────────────
    // A NEW LEAD (Q066, Sid 2026-10-04: "to the one selected while mentioning
    // in the input of new leads and admin to have notification of all"). The
    // owner named at capture, or chosen by the firm's rule, hears it is theirs;
    // every admin hears a lead came in. The creator is dropped as always, so an
    // admin who types a lead in is not told of it, and the owner is not told
    // twice. A merge into an open lead is not a new lead and writes no event
    // read here.
    case "lead.captured": {
      const owner = str(p, "ownerUserId");
      const byRule = owner !== null && str(p, "ownerAssignedBy") !== "requested";
      return {
        resolve: [],
        announce: [
          ...(owner === null
            ? []
            : [{ category: "lead_assigned" as const, sourceType: "lead", sourceId: e.objectId, payload: byRule ? { byRule: true } : {}, to: [user(owner)] }]),
          {
            category: "lead_new",
            sourceType: "lead",
            sourceId: e.objectId,
            payload: owner === null ? { unassigned: true } : {},
            to: [{ kind: "permission", permission: "tenant:admin" }],
            except: owner === null ? [] : [owner],
          },
        ],
      };
    }

    case "lead.owner_assigned": {
      const owner = str(p, "ownerUserId");
      return {
        resolve: [{ sourceType: "lead", sourceId: e.objectId, categories: ["lead_assigned"], exceptRecipient: owner }],
        announce:
          owner === null
            ? []
            : [{ category: "lead_assigned", sourceType: "lead", sourceId: e.objectId, payload: {}, to: [user(owner)] }],
      };
    }

    case "lead.stage_changed":
      return p["closed"] === true
        ? { announce: [], resolve: [{ sourceType: "lead", sourceId: e.objectId, categories: ["lead_assigned", "lead_new"] }] }
        : NOTHING;

    // A request the routing rule placed is announced by its `assigned` event,
    // which the rule writes in the same act. One it did NOT place reaches the
    // client's Key Manager (`request_owner`), so a request is never silent.
    case "client_request.raised":
      return {
        resolve: [],
        announce: [
          {
            category: "client_request",
            sourceType: "client_request",
            sourceId: e.objectId,
            payload: { stage: "new" },
            to: [{ kind: "request_owner", requestId: e.objectId, onlyUnplaced: true }],
          },
        ],
      };

    case "client_request.assigned": {
      const assignee = str(p, "assigneeUserId");
      return {
        resolve: [{ sourceType: "client_request", sourceId: e.objectId, categories: ["client_request"], exceptRecipient: assignee }],
        announce:
          assignee === null
            ? []
            : [
                {
                  category: "client_request",
                  sourceType: "client_request",
                  sourceId: e.objectId,
                  payload: { stage: "new" },
                  to: [user(assignee)],
                },
              ],
      };
    }

    case "client_request.replied":
      return p["authorSide"] === "client"
        ? {
            resolve: [],
            announce: [
              {
                category: "client_request",
                sourceType: "client_request",
                sourceId: e.objectId,
                payload: { stage: "replied" },
                to: [{ kind: "request_owner", requestId: e.objectId, onlyUnplaced: false }],
              },
            ],
          }
        : NOTHING;

    case "client_request.closed":
    case "client_request.withdrawn":
      return { announce: [], resolve: [{ sourceType: "client_request", sourceId: e.objectId, categories: ["client_request"] }] };

    case "client_ask.answered":
      return {
        resolve: [],
        announce: [
          {
            category: "client_answered",
            sourceType: "client_ask",
            sourceId: e.objectId,
            payload: {},
            to: [{ kind: "ask_owner", askId: e.objectId }],
          },
        ],
      };

    case "client_ask.closed":
    case "client_ask.withdrawn":
      return { announce: [], resolve: [{ sourceType: "client_ask", sourceId: e.objectId, categories: ["client_answered"] }] };

    case "proposal.accepted":
    case "proposal.rejected": {
      const partyId = str(p, "partyId");
      return {
        resolve: [],
        announce: [
          {
            category: "proposal_decided",
            sourceType: "proposal",
            sourceId: e.objectId,
            payload: { decision: e.verb === "proposal.accepted" ? "accepted" : "rejected" },
            to: [
              { kind: "proposal_preparer", proposalId: e.objectId },
              ...(partyId === null ? [] : [{ kind: "key_manager" as const, clientPartyId: partyId }]),
            ],
          },
        ],
      };
    }

    case "engagement_letter.signed": {
      const partyId = str(p, "partyId");
      return {
        resolve: [],
        announce: [
          {
            category: "letter_signed",
            sourceType: "engagement_letter",
            sourceId: e.objectId,
            payload: {},
            to: [
              { kind: "letter_sender", letterId: e.objectId },
              ...(partyId === null ? [] : [{ kind: "key_manager" as const, clientPartyId: partyId }]),
            ],
          },
        ],
      };
    }

    // ── billing ───────────────────────────────────────────────────────────
    case "payment.recorded": {
      const invoiceId = str(p, "invoiceId");
      if (invoiceId === null) return NOTHING;
      return {
        resolve: [],
        announce: [
          {
            category: "payment_received",
            sourceType: "invoice",
            sourceId: invoiceId,
            payload: pick(p, ["amount", "currency"]),
            to: [{ kind: "invoice_manager", invoiceId }],
          },
        ],
      };
    }

    // An advance is chased by its own reminders (0322), never as a bill.
    case "billing_due.created":
      return p["kind"] === "advance"
        ? NOTHING
        : {
            resolve: [],
            announce: [
              {
                category: "bill_to_raise",
                sourceType: "billing_due",
                sourceId: e.objectId,
                payload: {},
                to: [{ kind: "due_manager", dueId: e.objectId }],
              },
            ],
          };

    case "billing_due.invoiced":
    case "billing_due.skipped":
    case "billing_due.covered":
      return {
        announce: [],
        resolve: [{ sourceType: "billing_due", sourceId: e.objectId, categories: ["bill_to_raise", "advance_reminder"] }],
      };

    // Only the rung a machine may not climb: a partner has to decide it.
    case "dunning.escalated":
      return p["awaitingApproval"] === true
        ? {
            resolve: [],
            announce: [
              {
                category: "dunning_decision",
                sourceType: "invoice",
                sourceId: e.objectId,
                payload: pick(p, ["step", "action"]),
                to: [{ kind: "permission", permission: "tenant:admin" }],
              },
            ],
          }
        : NOTHING;

    case "dunning.decided":
      return { announce: [], resolve: [{ sourceType: "invoice", sourceId: e.objectId, categories: ["dunning_decision"] }] };

    case "tenant.advance_digest_sent": {
      const advances = typeof p["advances"] === "number" ? p["advances"] : 0;
      return advances === 0
        ? NOTHING
        : {
            // Last week's summary is superseded by this one.
            resolve: [{ sourceType: "tenant", sourceId: e.objectId, categories: ["advance_summary"] }],
            announce: [
              {
                category: "advance_summary",
                sourceType: "tenant",
                sourceId: e.objectId,
                payload: { advances, weekOf: str(p, "weekOf") },
                to: [{ kind: "permission", permission: "tenant:admin" }],
              },
            ],
          };
    }

    default:
      return NOTHING;
  }
}

/** Where the firm's ladder landed: a person, everybody at a rank, or nobody. */
function escalationAudience(p: Readonly<Record<string, unknown>>): Audience | null {
  const landed = str(p, "landedOn");
  if (landed === "person") {
    const userId = str(p, "raisedToUserId");
    return userId === null ? null : user(userId);
  }
  if (landed === "rank" && typeof p["minGradeRank"] === "number") {
    return { kind: "grade_at_least", rank: p["minGradeRank"] };
  }
  // NOBODY: the ladder could name nobody, and the queue already shows it to
  // whoever reads it. Inventing a recipient here would contradict the ladder.
  return null;
}

function user(userId: string): Audience {
  return { kind: "user", userId };
}

function str(p: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function pick(p: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
