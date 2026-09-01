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
