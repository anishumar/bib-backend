// The seams the client-directed ask needs. Interfaces owned by this use case,
// stated in its vocabulary; the Postgres adapters implement them.
//
// ── TWO REPOSITORIES, ONE USE CASE, AND WHY THAT SPLIT ────────────────────
//
// An ask has two sides and they are scoped differently. The firm raises, reads
// and closes one under `withTenant`; the client reads and answers one under
// `withPortal`. That difference is the whole safety of gate 4, and it is an
// INFRASTRUCTURE fact — which transaction settings the adapter sets — so it
// belongs in two adapters and not in two use cases.
//
// Keeping the rules in one service is the other half. "A decision only answers
// an approval", "an answered ask still accepts another answer", "closing a
// closed ask is refused" are facts about an ask, not about who is looking at it,
// and two services would state each of them twice and eventually differ.
import type { DocumentKind } from "../../domain/filestore/model";
import type {
  AskKind,
  AskRecord,
  AskStatus,
  AskTemplateRef,
  PortalAskRow,
  ResponseKind,
} from "../../domain/clientask/model";

/** An ask a PERSON raised. */
export interface NewAsk {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly askKind: AskKind;
  readonly prompt: string;
  readonly documentKind: DocumentKind | null;
  readonly raisedBy: string;
  /** Already checked by the service: a real day, not before the firm's today. */
  readonly dueOn: string | null;
}

/**
 * An ask a REQUEST TEMPLATE raised (0385). No `raisedBy`: the sweep raises it on
 * the firm's behalf and the row says so with a null, held by 0385's CHECK to
 * "a person or a template". No client party either, for `NewAsk`'s reason.
 */
export interface NewTemplateAsk {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly askKind: AskKind;
  readonly prompt: string;
  readonly documentKind: DocumentKind | null;
  readonly dueOn: string;
  readonly template: AskTemplateRef;
}

/**
 * What a template's INSERT did. Three outcomes and not a nullable record,
 * because "already raised" and "no such work item" are different answers that
 * both write nothing: the first is the sweep's ordinary second pass, the second
 * is a refusal.
 */
export type TemplateAskInsert =
  | { readonly outcome: "created"; readonly record: AskRecord }
  | { readonly outcome: "already_raised" }
  | { readonly outcome: "no_work_item" };

/** Which zone the firm keeps its calendar in (0071). Structural: satisfied by
 *  `PostgresFirmTimeZone` and `FakeFirmTimeZone`. A due day a person types is
 *  held to the FIRM's today, never the server's. */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * The firm's side. Every method is `withTenant`.
 *
 * NOTE WHAT `raise` DOES NOT TAKE: a client party. The ask's `client_party_id`
 * is READ from the work item inside the insert, never supplied by the caller —
 * so the column gate 4 filters on cannot be set to a party the caller chose.
 * The composite foreign key in 0063 would refuse a mismatch anyway; this makes
 * the mismatch unwritable rather than refused, which is one fewer thing that has
 * to hold.
 */
export interface AskRepository {
  /** Raises the ask, resolving its client from the work item. Null when there
   *  is no such work item at this firm — the one refusal this write can make. */
  raise(ask: NewAsk): Promise<AskRecord | null>;

  /**
   * Raises a template's ask ONCE per (work item, template key, item key).
   *
   * The INSERT is `ON CONFLICT DO NOTHING` against 0385's partial unique index,
   * so a redelivered sweep, or two sweeps racing, leaves one row — the database
   * decides, not a read-then-write. The client is read from the work item inside
   * the INSERT, exactly as `raise` does.
   */
  raiseFromTemplate(ask: NewTemplateAsk): Promise<TemplateAskInsert>;

  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly AskRecord[]>;

  findById(tenantId: string, askId: string): Promise<AskRecord | null>;

  /**
   * Close or withdraw. ONE method because it is one act with two meanings, and
   * because the status, the closer and the instant have to move together — an
   * UPDATE that set two of the three would fail 0063's own CHECK, which is the
   * database saying the same thing.
   */
  settle(input: {
    readonly tenantId: string;
    readonly askId: string;
    readonly status: Extract<AskStatus, "closed" | "withdrawn">;
    readonly closedBy: string;
  }): Promise<AskRecord | null>;
}

/**
 * Which companies this SESSION may read, today.
 *
 * Structurally identical to `usecase/portalhome`'s port of the same name, and
 * satisfied by the same object in `setup/` — `PortalAccessService`'s own
 * `scopedClientsForUser`. Declared here rather than imported from that use case
 * because "what may this session read" is a question this one has to ask on its
 * own, and a use case reaching into another's ports for a shape is how two
 * modules end up in one blast radius. TypeScript is structural; one
 * implementation satisfies both without either knowing about the other.
 */
export interface PortalScopeSource {
  /** Resolved on the FIRM's day by the grant module itself — no caller's day
   *  reaches it (F-07-1). */
  scopedCompanies(
    tenantId: string,
    userId: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]>;
}

/** What one response writes. The client party is NOT here for the same reason it
 *  is absent from `NewAsk`: it is read from the ask inside the write. */
export interface NewResponse {
  readonly id: string;
  readonly tenantId: string;
  readonly askId: string;
  readonly responseKind: ResponseKind;
  readonly answerText: string | null;
  readonly decision: string | null;
  readonly respondedBy: string;
}

/** An uploaded file, already hashed and already in the blob store. */
export interface UploadedBytes {
  readonly documentId: string;
  readonly versionId: string;
  readonly linkId: string;
  readonly title: string;
  readonly documentKind: DocumentKind;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly filename: string;
  readonly storageKey: string;
}

/**
 * The client's side. EVERY method is `withPortal`, never `withTenant`.
 *
 * ── IT TAKES THE PARTY IDS AND HAS NO VARIANT THAT DOES NOT ──────────────
 *
 * The same shape `PortalHomeRepository` has, for the same reason: an EMPTY list
 * is a real answer that must reach the database as one, and "I did not ask the
 * grant table" is not a scope. An implementation that skipped `withPortal`
 * because the list was empty would leave `app.portal` unset, which means STAFF,
 * and every read would succeed.
 *
 * ── AND THE WRITES GO THROUGH IT TOO, WHICH IS NEW ───────────────────────
 *
 * 0059 and 0062 wrote `WITH CHECK` on their restrictive policies when no portal
 * write path existed, saying so at the time: *"this is why it will not have to
 * be built with the rule inside it"*. This is that write path. A contact
 * answering an ask that belongs to another of the firm's clients is refused by
 * the database, not by a handler remembering to check — which is what lets the
 * SQL below read like SQL that forgot to filter.
 */
export interface PortalAskRepository {
  /** Everything waiting on this login, and everything it has already answered.
   *  Rows carry NAMES: the company and the task title, joined here rather than
   *  looked up per row. */
  list(tenantId: string, clientPartyIds: readonly string[]): Promise<readonly PortalAskRow[]>;

  /**
   * One ask, if this session may reach it.
   *
   * Null is the answer for "no such ask" AND for "an ask belonging to a company
   * you were not granted", and the two are indistinguishable ON PURPOSE: the row
   * is filtered by the policy, so there is nothing here that could tell them
   * apart, and a 403 would confirm the ask exists.
   */
  findById(
    tenantId: string,
    clientPartyIds: readonly string[],
    askId: string,
  ): Promise<PortalAskRow | null>;

  /**
   * Append a response and move the ask, in ONE transaction.
   *
   * Not two calls. `open → answered` and the response row are one fact, and an
   * interrupted pair leaves either an ask that says nobody replied with a reply
   * under it, or an ask marked answered with nothing to show.
   *
   * The status update is written idempotently — `first_answered_at` is only ever
   * set if it is null — so a second response never restates when the client
   * first replied. "They sent the wrong register on the 3rd and the right one on
   * the 9th" must keep the 3rd.
   */
  respond(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
  ): Promise<PortalAskRow | null>;

  /**
   * The same, plus the document the response points at.
   *
   * The document, its first version, its link to the work item and the response
   * are one transaction for the reason `DocumentStoreRepository.create` gives: a
   * document row with no version is a file that appears in a list and cannot be
   * opened. Here there is a fourth row and the same argument covers all of them.
   *
   * The BYTES are already stored when this is called — bytes first, row second,
   * so an interruption costs an orphaned blob rather than a document the product
   * offers and cannot open.
   */
  respondWithDocument(
    tenantId: string,
    clientPartyIds: readonly string[],
    response: NewResponse,
    upload: UploadedBytes,
  ): Promise<PortalAskRow | null>;
}
