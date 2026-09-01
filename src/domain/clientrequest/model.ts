// The CLIENT's own request — what a client asks the firm for, unprompted
// (T6.8, migration 0068).
//
// ── THE MIRROR OF `domain/clientask`, AND NOT A COPY OF IT ────────────────
//
// `client_ask` is the firm asking a client for something on a named work item.
// This is the client asking the FIRM, attached to nothing. The shapes rhyme —
// four states, an append-only thread, two views of one row — and the
// differences are all in the same place: who may end it, who may attach a file,
// and the fact that this one has no parent to take its client from.
//
// Kept apart rather than generalised into an "ask" with a direction flag. Every
// rule below would have grown an `if (direction === ...)`, the two policies in
// 0063 and 0068 differ, and a table that means two things is one somebody
// eventually filters wrong.

/**
 * The four states, and the two endings belong to different people.
 *
 * `closed` is the FIRM's ending, `withdrawn` is the CLIENT's. That is not
 * enforced here — a pure function has no session — it is enforced by which
 * repository the act goes through, and stated on every function below that
 * cares.
 */
export type RequestStatus = "open" | "answered" | "closed" | "withdrawn";

export const REQUEST_STATUSES: readonly RequestStatus[] = [
  "open",
  "answered",
  "closed",
  "withdrawn",
];

/**
 * Which side of the wall wrote a message.
 *
 * On the row rather than derived from the author's account (0068 says why: an
 * account whose membership changes would silently switch sides in an old
 * conversation), and unforgeable from the portal because the policy refuses a
 * portal session any value but `client`.
 */
export type AuthorSide = "firm" | "client";

/**
 * How a firm routes a request that has just arrived (migration 0070).
 *
 * `none` is the DEFAULT and a real answer, not "unconfigured" — it reproduces
 * exactly what T6.8 shipped, so the setting changed no firm's behaviour on the
 * day it existed. A SPOC is deliberately not a member of this union and cannot
 * become one without an axis: a request names no service, so there is nothing
 * to pick a Dept by, and choosing one would be the arbitrary answer 0068 spent
 * a header refusing to give.
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
  /** Whose desk it is on. NULL IS ORDINARY — see `routeRequest`. */
  readonly assigneeUserId: string | null;
  /** Why nobody, when the rule ran and could not name somebody. Null whenever
   *  there IS an assignee (0070 refuses the pair) and also whenever the firm
   *  routes nothing at all. */
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

/**
 * A reply with its author and its attachment resolved to something a person can
 * read.
 *
 * `authorName` is null when the account has been erased — a real answer, the
 * shape `EventRecord.actor`, `DocumentRecord` and `AskResponseRecord` all use.
 */
export interface RequestReplyRecord {
  readonly reply: RequestReply;
  readonly authorName: string | null;
  /**
   * What the firm attached, if anything. A document already filed against this
   * client (0068's composite FK refuses any other), made visible to them by the
   * same act — see `PortalRequestRow.replies` for why that is one decision and
   * not two.
   */
  readonly document: {
    readonly documentId: string;
    readonly title: string;
    readonly filename: string;
    readonly byteSize: number;
    readonly mediaType: string;
  } | null;
}

/**
 * A request as the FIRM reads it, in the inbox.
 *
 * Names, never ids — the rule this codebase has now learnt seven times. The
 * replies come with the read rather than per row: an inbox that showed the
 * opening message and not what anybody said back is a list somebody has to
 * click through to know whether it has been dealt with.
 */
export interface ClientRequestRecord {
  readonly request: ClientRequest;
  /** WHICH of the firm's clients this is from. The firm-wide inbox has no
   *  routing (0068), so the company name is the only thing telling one row from
   *  another at a glance. */
  readonly clientName: string;
  /** WHO at the client wrote it. The firm needs this — a company with two
   *  directors asking for different things is two conversations — and it is the
   *  half of the thread the client's own screen does not need. */
  readonly raisedByName: string | null;
  readonly settledByName: string | null;
  /** WHO AT THE FIRM holds it, resolved. Deliberately absent from
   *  `PortalRequestRow`: whose desk the work is on is the firm's business
   *  (T6.5), and a name there invites a client to chase a junior directly. */
  readonly assigneeName: string | null;
  readonly assigneeEmail: string | null;
  readonly replies: readonly RequestReplyRecord[];
}

/**
 * A request as the CLIENT reads it, in the action centre.
 *
 * Narrower than `ClientRequestRecord`, and narrower in the direction T6.5 set:
 * no name of anybody at the firm. `RequestReplyRecord.authorName` carries the
 * client's OWN people (a company with two directors needs to know which of them
 * asked), and the handler drops it on the firm's side of the thread — which is
 * where "the firm replied" is the whole fact, and naming a junior invites a
 * client to chase them directly.
 */
export interface PortalRequestRow {
  readonly requestId: string;
  readonly companyName: string | null;
  readonly subject: string;
  readonly body: string;
  readonly status: RequestStatus;
  readonly raisedAt: string;
  /**
   * When the firm last came back, or null if it never has.
   *
   * A DATE AND NOT A COUNT, for `PortalAskRow.lastRemindedAt`'s reason pointed
   * the other way: the tally belongs on the screen of the side that needs
   * evidence, and here neither side does — the whole thread is on both screens.
   * This is a convenience for sorting and for the one line the list shows.
   */
  readonly lastRepliedAt: string | null;
  readonly replies: readonly RequestReplyRecord[];
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Whether anybody may still add to the thread.
 *
 * `answered` stays open to both sides on purpose: the firm replying does not
 * finish a client's request, and a client who was sent the wrong year's balance
 * sheet has to be able to say so without opening a second request that reads as
 * a fresh demand.
 *
 * A settled request takes no more messages. Reopening by replying would let a
 * request the firm has closed come back to life without anybody deciding to
 * reopen it, and "raise a new one" keeps the record honest about what was asked
 * when.
 */
export function acceptsReply(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * Whether the FIRM may still close it. Closing a settled request is refused
 * rather than written over the first closure, which would move the date
 * somebody is answering questions about.
 */
export function acceptsClosure(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * Whether the CLIENT may still withdraw it.
 *
 * The same two states, and a separate function rather than an alias of
 * `acceptsClosure`. They are the same today by coincidence, not by rule: the
 * first firm to ask for "a client may not withdraw once we have started work"
 * changes this one and must not change the other, and an alias is how one
 * rule's edit silently becomes two.
 */
export function acceptsWithdrawal(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * Whether a request is still live — the predicate the firm's inbox and the
 * client's own list both mean by "not finished".
 *
 * Here rather than in the two queries, so the screens cannot disagree about
 * which rows they contain. 0068's partial index is written on the same pair and
 * a change here is a change there.
 */
export function isLive(status: RequestStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * What the routing rule decides for a request that has just arrived.
 *
 * `assigneeUserId` null with a `note` means the rule RAN and could not name
 * somebody; null with NO note means the firm routes nothing. 0070's CHECK
 * refuses a note beside a name, so the third combination cannot be written.
 */
export interface RoutingOutcome {
  readonly assigneeUserId: string | null;
  readonly note: string | null;
}

/**
 * Whose desk a new request lands on.
 *
 * ── A WRONG ASSIGNEE IS WORSE THAN NONE ─────────────────────────────────
 *
 * 0051's rule, and the reason this function never falls back to anybody: work
 * on the wrong desk sits there while its owner believes it is not theirs, and
 * unassigned work is visible in a queue that gets chased. So the only two
 * answers are the right person and NOBODY — there is no "and otherwise the
 * partner", and adding one would be this product deciding what the firm never
 * said.
 *
 * ── AND `none` PRODUCES NO NOTE, WHICH IS THE SUBTLE HALF ───────────────
 *
 * A firm that routes nothing has not failed to route anything. Writing "the
 * firm routes nothing" onto every row would put a permanent sentence on an
 * inbox where every row is equally unassigned — noise that says the same thing
 * as the empty Assigned column beside it, on every row, for ever. The note
 * exists to separate *"nobody has got to it"* from *"the rule ran and could not
 * decide"*, and under `none` there is no second case.
 *
 * Pure, so both the raise path and any later re-route give the same answer, and
 * so the sentence a firm reads can be tested without a database.
 */
export function routeRequest(
  routing: RequestRouting,
  keyManagerUserId: string | null,
): RoutingOutcome {
  if (routing === "none") return { assigneeUserId: null, note: null };
  if (keyManagerUserId !== null) return { assigneeUserId: keyManagerUserId, note: null };
  return {
    assigneeUserId: null,
    // NAMES THE FIX, not the failure. T3.1's `assignment_note` is what makes an
    // unassigned queue clearable rather than a pile, and it manages that only
    // when the sentence says what somebody has to go and do.
    note:
      "This firm routes a client's request to that client's Key Manager, and this client " +
      "has none on the day it arrived. Name one on the client's page, or take this request " +
      "yourself.",
  };
}

/**
 * Which side spoke last, or null on a request nobody has replied to yet.
 *
 * ── THIS IS WHY A CLIENT'S FOLLOW-UP DOES NOT CHANGE THE STATUS ──────────
 *
 * The obvious alternative was to send `answered` back to `open` when the client
 * writes again — "that is the wrong year's balance sheet" plainly needs the
 * firm's attention. It is refused because `answered` means exactly
 * `first_replied_at IS NOT NULL`, which 0068's CHECK enforces as one fact in
 * two representations; a status that walked backwards would either break that
 * constraint or force it to be loosened, and a loosened one is how a list
 * filtered on `status` and a report joined on `settled_at` come to disagree.
 *
 * So the status records whether the firm has ever come back, and THIS records
 * who is holding the conversation. The firm's inbox shows both, which is more
 * information than a status that tried to carry both.
 */
export function lastWordWith(replies: readonly RequestReplyRecord[]): AuthorSide | null {
  return replies.length === 0 ? null : (replies[replies.length - 1]?.reply.authorSide ?? null);
}

/**
 * Whether the ball is in the firm's court: nobody has replied, or the client
 * spoke last. The label the firm's inbox sorts and colours on.
 */
export function awaitsFirm(record: {
  readonly request: ClientRequest;
  readonly replies: readonly RequestReplyRecord[];
}): boolean {
  return isLive(record.request.status) && lastWordWith(record.replies) !== "firm";
}

/**
 * Split what the client sees into what the firm has not answered yet and what
 * it has.
 *
 * Pure and here rather than in the query for `splitByAwaiting`'s reason — one
 * read, one predicate, both lists — and note which way round it is. The ask
 * splits on "does this want something from YOU"; a request the client raised
 * never wants anything from them, so it splits on whether the firm has come
 * back.
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
