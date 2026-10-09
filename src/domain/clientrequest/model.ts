// The CLIENT's own request to the firm, attached to nothing (T6.8, migration 0068).
// Mirrors `domain/clientask` (the firm asking a client on a work item) but is kept
// apart rather than one "ask" with a direction flag: who may end it, who may attach
// a file and where the client comes from all differ, as do the 0063 and 0068
// policies, and a table that means two things eventually gets filtered wrong.

/**
 * `closed` is the FIRM's ending, `withdrawn` the CLIENT's. Enforced by which
 * repository the act goes through, not here (a pure function has no session).
 */
export type RequestStatus = "open" | "answered" | "closed" | "withdrawn";

export const REQUEST_STATUSES: readonly RequestStatus[] = [
  "open",
  "answered",
  "closed",
  "withdrawn",
];

/**
 * Which side wrote a message. Stored on the row, not derived from the account
 * (0068: a membership change would switch sides in an old thread); the portal
 * policy refuses a portal session any value but `client`.
 */
export type AuthorSide = "firm" | "client";

/**
 * How a firm routes a new request (0070). `none` is the default and a real answer
 * (what T6.8 shipped). No SPOC option: a request names no service, so there is no
 * axis to pick a Dept by, and choosing one is the arbitrary answer 0068 refused.
 */
export type RequestRouting = "none" | "key_manager";

export const REQUEST_ROUTINGS: readonly RequestRouting[] = ["none", "key_manager"];

export function isRequestRouting(v: string): v is RequestRouting {
  return (REQUEST_ROUTINGS as readonly string[]).includes(v);
}

/** A request, as the row holds it. Names are resolved by the records below. */
export interface ClientRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly subject: string;
  readonly body: string;
  readonly status: RequestStatus;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly firstRepliedAt: string | null;
  readonly settledBy: string | null;
  readonly settledAt: string | null;
  /** Whose desk it is on. Null is ordinary — see `routeRequest`. */
  readonly assigneeUserId: string | null;
  /** Why nobody, when the rule ran and found nobody. Null whenever there is an
   *  assignee (0070 refuses the pair) or the firm routes nothing. */
  readonly assignmentNote: string | null;
}

/** One message in the thread. */
export interface RequestReply {
  readonly id: string;
  readonly requestId: string;
  readonly authorSide: AuthorSide;
  readonly body: string;
  readonly writtenAt: string;
}

/** A reply with author and attachment resolved; `authorName` is null when the account was erased. */
export interface RequestReplyRecord {
  readonly reply: RequestReply;
  readonly authorName: string | null;
  /** A document already filed against this client (0068's composite FK), made
   *  visible to them by the same act — see `RequestRepository.reply`. */
  readonly document: {
    readonly documentId: string;
    readonly title: string;
    readonly filename: string;
    readonly byteSize: number;
    readonly mediaType: string;
  } | null;
}

/** A request as the FIRM reads it in the inbox: names, never ids, with its replies. */
export interface ClientRequestRecord {
  readonly request: ClientRequest;
  /** What tells rows apart in the unrouted firm-wide inbox (0068). */
  readonly clientName: string;
  /** Who at the client wrote it: two directors asking are two conversations. */
  readonly raisedByName: string | null;
  readonly settledByName: string | null;
  /** Who at the firm holds it. Kept off `PortalRequestRow`: whose desk it is on is
   *  the firm's business (T6.5), and a name invites a client to chase a junior. */
  readonly assigneeName: string | null;
  readonly assigneeEmail: string | null;
  readonly replies: readonly RequestReplyRecord[];
}

/**
 * A request as the CLIENT reads it in the action centre: no name of anybody at
 * the firm (T6.5). `authorName` is kept for the client's own people and dropped
 * by the handler on the firm's replies.
 */
export interface PortalRequestRow {
  readonly requestId: string;
  readonly companyName: string | null;
  readonly subject: string;
  readonly body: string;
  readonly status: RequestStatus;
  readonly raisedAt: string;
  /** When the firm last replied, or null. A date, not a count (unlike
   *  `PortalAskRow.lastRemindedAt`): the whole thread is on both screens. */
  readonly lastRepliedAt: string | null;
  readonly replies: readonly RequestReplyRecord[];
}

/**
 * Whether anybody may still add to the thread. `answered` stays open to both
 * sides: a client sent the wrong year's balance sheet must be able to say so
 * without a second request. A settled request takes no more messages, so nothing
 * reopens without somebody deciding to; raise a new one instead.
 */
export function acceptsReply(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/** Whether the FIRM may still close it; a second close would move the settled date. */
export function acceptsClosure(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * Whether the CLIENT may still withdraw it. The same states as `acceptsClosure` by
 * coincidence, not rule; kept separate so changing one cannot change the other.
 */
export function acceptsWithdrawal(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * "Not finished", for both the firm's inbox and the client's list so they cannot
 * disagree. 0068's partial index uses the same pair: change both together.
 */
export function isLive(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * Null assignee with a note: the rule ran and found nobody. With no note: the firm
 * routes nothing. 0070's CHECK refuses a note beside a name.
 */
export interface RoutingOutcome {
  readonly assigneeUserId: string | null;
  readonly note: string | null;
}

/**
 * Whose desk a new request lands on: the right person or NOBODY, never a fallback.
 * A wrong assignee is worse than none (0051): it sits unowned, while unassigned
 * work is visible and gets chased. `none` writes no note, which would only repeat
 * the empty Assigned column on every row; the note marks "the rule could not decide".
 * Pure, so raise and any re-route agree and the sentence is testable.
 */
export function routeRequest(
  routing: RequestRouting,
  keyManagerUserId: string | null,
): RoutingOutcome {
  if (routing === "none") return { assigneeUserId: null, note: null };
  if (keyManagerUserId !== null) return { assigneeUserId: keyManagerUserId, note: null };
  return {
    assigneeUserId: null,
    // Names the fix, not the failure: T3.1's `assignment_note` keeps an
    // unassigned queue clearable only when it says what to do.
    note:
      "This firm routes a client's request to that client's Key Manager, and this client " +
      "has none on the day it arrived. Name one on the client's page, or take this request " +
      "yourself.",
  };
}

/**
 * Which side spoke last, or null if nobody has replied. This, not the status, says
 * who holds the conversation: a client follow-up does not send `answered` back to
 * `open`, because `answered` is `first_replied_at IS NOT NULL` (0068's CHECK) and
 * a status walking backwards would break or loosen that constraint.
 */
export function lastWordWith(replies: readonly RequestReplyRecord[]): AuthorSide | null {
  return replies.length === 0 ? null : (replies[replies.length - 1]?.reply.authorSide ?? null);
}

/** The firm's court: live, and nobody has replied or the client spoke last. The inbox sorts on it. */
export function awaitsFirm(record: {
  readonly request: ClientRequest;
  readonly replies: readonly RequestReplyRecord[];
}): boolean {
  return isLive(record.request.status) && lastWordWith(record.replies) !== "firm";
}

/**
 * The client's live requests, split by whether the firm has replied (one read, one
 * predicate, as `splitByAwaiting`). The ask splits on "wants something from YOU";
 * a request never wants anything from the client.
 */
export function splitByReplied(rows: readonly PortalRequestRow[]): {
  readonly awaitingFirm: readonly PortalRequestRow[];
  readonly replied: readonly PortalRequestRow[];
} {
  const live = rows.filter((r) => isLive(r.status));
  return {
    awaitingFirm: live.filter((r) => r.status === "open"),
    replied: live.filter((r) => r.status === "answered"),
  };
}
