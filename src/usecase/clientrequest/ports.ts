// The seams the client's own request needs. Interfaces owned by this use case,
// stated in its vocabulary; the Postgres adapters implement them.
//
// ── TWO REPOSITORIES, ONE USE CASE — `usecase/clientask`'s split, mirrored ─
//
// A request has two sides and they are scoped differently. The firm reads,
// replies and closes under `withTenant`; the client raises, reads, follows up
// and withdraws under `withPortal`. That difference is the whole safety of gate
// 4 and it is an INFRASTRUCTURE fact — which transaction settings the adapter
// sets — so it belongs in two adapters and not in two use cases.
//
// Keeping the rules in one service is the other half. "A settled request takes
// no more messages", "a reply needs words in it", "only the firm attaches" are
// facts about a request, not about who is looking at it, and two services would
// state each of them twice and eventually differ.
import type {
  ClientRequestRecord,
  PortalRequestRow,
} from "../../domain/clientrequest/model";

/** What raising one writes. */
export interface NewRequest {
  readonly id: string;
  readonly tenantId: string;
  /**
   * WHICH of the client's companies this is about.
   *
   * ── THE FIRST WALL COLUMN IN THIS PRODUCT THAT A CALLER SUPPLIES ───────
   *
   * `NewAsk` deliberately has no such field — 0063 reads the client from the
   * work item inside the insert, so the column gate 4 filters on cannot be set
   * to a party the caller chose. There is no parent row here to read it from: a
   * contact granted three companies has to say which one they are writing
   * about.
   *
   * What refuses a wrong one is 0068's `WITH CHECK (crm.portal_sees(...))`, in
   * the database, under `withPortal`. The service also checks it against the
   * scope it already holds — see `ClientRequestService.raise` — and that check
   * exists to turn a Postgres RLS violation into a sentence, NOT to be the
   * wall. Deleting it leaves the write refused; deleting the policy does not.
   */
  readonly clientPartyId: string;
  readonly subject: string;
  readonly body: string;
  readonly raisedBy: string;
}

/** What one message writes. The client party is NOT here: it is read from the
 *  request inside the insert, `NewResponse`'s arrangement and its reason. */
export interface NewReply {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly body: string;
  readonly writtenBy: string;
}

/** A firm reply, which may carry a document the firm has already filed against
 *  this client. */
export interface NewFirmReply extends NewReply {
  readonly documentId: string | null;
}

/**
 * Why a firm reply was refused, when it was.
 *
 * A union rather than `null`, because this write has TWO refusals and they are
 * different sentences to the person who hit one: the request is gone or
 * finished, or the document named is not this client's. 0063's writes each had
 * exactly one refusal and could say it with a null.
 */
export type FirmReplyOutcome =
  | { readonly ok: true; readonly record: ClientRequestRecord }
  | { readonly ok: false; readonly reason: "request" | "document" };

/**
 * The FIRM's side. Every method is `withTenant`.
 *
 * There is no `listForClient(partyId)` and that is not an oversight: the inbox
 * has NO ROUTING (0068, Shrestha 2026-09-02), so the firm's screen is one list.
 * A per-client read belongs with the client 360 screen when somebody builds it
 * there, and adding it here first would make the shape of the firm's own screen
 * look decided when it is not.
 */
export interface RequestRepository {
  /** Everything not finished, newest first — the whole inbox. */
  listLive(tenantId: string): Promise<readonly ClientRequestRecord[]>;

  findById(tenantId: string, requestId: string): Promise<ClientRequestRecord | null>;

  /**
   * The firm replies, and where a document is named, MAKES IT VISIBLE in the
   * same transaction.
   *
   * The two writes are one act: attaching a document to a message addressed to
   * a client IS the decision to show it to them, and a reply that named a file
   * the client cannot open would be the library's `is_client_visible` (0066)
   * silently swallowing the answer. One transaction, so a reply never ships
   * pointing at something invisible.
   */
  reply(input: NewFirmReply): Promise<FirmReplyOutcome>;

  /**
   * The firm is done with it — `closed`, never `withdrawn`. Withdrawing is the
   * CLIENT's ending and is not reachable from this side at all; "we decided you
   * did not need this" is a refusal, and a refusal is a close with a reply
   * saying so.
   */
  close(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly settledBy: string;
  }): Promise<ClientRequestRecord | null>;
}

/**
 * Which companies this SESSION may read, today.
 *
 * Structurally identical to the port of the same name in `usecase/clientask`
 * and `usecase/portalhome`, and satisfied by the same object in `setup/` —
 * `PortalAccessService`'s own `scopedClientsForUser`. Declared here rather than
 * imported, because "what may this session read" is a question this use case
 * has to ask on its own and reaching into another's ports for a shape is how
 * two modules end up in one blast radius. TypeScript is structural; one
 * implementation satisfies all three without any of them knowing.
 */
export interface PortalScopeSource {
  scopedCompanies(
    tenantId: string,
    userId: string,
    on: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]>;
}

/**
 * The CLIENT's side. EVERY method is `withPortal`, never `withTenant`.
 *
 * ── IT TAKES THE PARTY IDS AND HAS NO VARIANT THAT DOES NOT ──────────────
 *
 * `PortalAskRepository` and `PortalHomeRepository`'s shape, for their reason:
 * an EMPTY list is a real answer that must reach the database as one, and "I
 * did not ask the grant table" is not a scope. An implementation that skipped
 * `withPortal` when the list was empty would leave the session looking like
 * STAFF — which is the one shape of this bug that leaks rather than hides.
 */
export interface PortalRequestRepository {
  list(
    tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalRequestRow[]>;

  findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    requestId: string,
  ): Promise<PortalRequestRow | null>;

  raise(
    tenantId: string,
    clientPartyIds: readonly string[],
    request: NewRequest,
  ): Promise<PortalRequestRow | null>;

  /** A follow-up. It does NOT move the status — see `lastWordWith` for why the
   *  conversation and the status are two different facts. */
  reply(
    tenantId: string,
    clientPartyIds: readonly string[],
    reply: NewReply,
  ): Promise<PortalRequestRow | null>;

  /** The client no longer wants it. The client's ending, and the only one
   *  reachable from this side. */
  withdraw(
    tenantId: string,
    clientPartyIds: readonly string[],
    input: { readonly requestId: string; readonly settledBy: string },
  ): Promise<PortalRequestRow | null>;
}
