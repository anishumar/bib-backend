// The client's own request (T6.8) — the client asks, the firm replies, the firm
// closes; and the client may take it back.
//
// No I/O, no SQL, no HTTP: everything outside arrives as an injected port, so
// this reads as a description of what the business does and is testable with
// in-memory fakes and zero infrastructure.
//
// ── WHAT MAKES THE PORTAL HALF GATE-4 SAFE, AND WHERE IT LIVES ────────────
//
// Deliberately none of it is in this file:
//
//   1. `PORTAL_PATHS` (api/guards.ts) admits the routes. Gate 2 is denied by
//      default.
//   2. `portal:request` (gate 3) decides which CONTACT may raise one — the
//      SECOND permission a portal session can hold, and the first that lets
//      somebody outside the firm start a sentence rather than answer one.
//   3. `withPortal` in the adapter sets the granted parties, and the
//      RESTRICTIVE policies in 0068 do the filtering — on the WRITE as well as
//      the read, which on this table matters more than it ever has: the client
//      NAMES the company, and `WITH CHECK (crm.portal_sees(...))` is what
//      refuses a wrong one.
//
// What this file does is resolve whose session it is, once, and refuse the
// things the database cannot refuse with a sentence: a request that is already
// finished, a reply with no words in it, a document that is not this client's.
//
// ── AN EMPTY SCOPE IS NOT A SHORTCUT ─────────────────────────────────────
//
// A contact granted nothing gets an empty list, and the read still goes all the
// way to the database with an empty scope. There is no `if (companies.length
// === 0) return []` here and there must never be: it is indistinguishable from
// the version that works right up until somebody moves the check one layer
// down, where skipping the call leaves the session looking like STAFF.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  ClientRequestRecord,
  PortalRequestRow,
  RequestStatus,
} from "../../domain/clientrequest/model";
import { acceptsReply, splitByReplied } from "../../domain/clientrequest/model";
import {
  RequestAlreadySettled,
  RequestBodyEmpty,
  RequestCompanyNotYours,
  RequestDocumentNotFound,
  RequestNotFound,
  RequestReplyEmpty,
  RequestSubjectEmpty,
} from "../../domain/clientrequest/errors";
import type {
  PortalRequestRepository,
  PortalScopeSource,
  RequestRepository,
} from "./ports";

export interface Deps {
  readonly requests: RequestRepository;
  readonly portal: PortalRequestRepository;
  readonly scope: PortalScopeSource;
  readonly ids: IdGen;
  readonly events: EventSink;
  readonly clock: Clock;
}

/**
 * NOTE WHAT IS NOT IN `Deps`, and that the absence is asserted structurally.
 *
 * NO MAILER. Transport is P10 (Phase 7): nothing leaves this building, so a
 * client raising a request raises a row and the firm sees it when it opens the
 * inbox. `ChaserService` and `NudgeService` both hold the same absence for the
 * same reason, and `tests/clientrequest/service.test.ts` asserts this
 * dependency list the way theirs do — a transport appearing here turns the
 * build red on purpose, so the decision to add one is taken on the board rather
 * than in a constructor.
 *
 * A LOGGING STUB WOULD BE WORSE THAN NOTHING. A line in an operator's log
 * saying the firm was emailed about a client's request is the same class of lie
 * as a scan() that returns clean.
 */
export interface RaiseRequestInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly clientPartyId: string;
  readonly subject: string;
  readonly body: string;
  readonly actor: Actor;
  readonly asOf?: string | undefined;
}

export interface PortalReplyInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly body: string;
  readonly actor: Actor;
  readonly asOf?: string | undefined;
}

export interface WithdrawInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly actor: Actor;
  readonly asOf?: string | undefined;
}

export interface FirmReplyInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly body: string;
  readonly documentId: string | null;
  readonly actor: Actor;
}

export interface CloseRequestInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly actor: Actor;
}

export interface PortalRequestList {
  readonly awaitingFirm: readonly PortalRequestRow[];
  readonly replied: readonly PortalRequestRow[];
  readonly settled: readonly PortalRequestRow[];
  readonly asOf: string;
}

export class ClientRequestService {
  constructor(private readonly deps: Deps) {}

  // ── the firm's side ───────────────────────────────────────────────────────

  /**
   * The whole inbox, newest first.
   *
   * ONE LIST, NO ROUTING (0068). Nobody is assigned a client's request, because
   * the firm has never said who should be — and this codebase already carries
   * one arbitrary answer to a question of that shape, on the board as open. The
   * screen shows which company each is from and who spoke last, which is what
   * makes an unrouted list workable while it is short.
   */
  inbox(tenantId: string): Promise<readonly ClientRequestRecord[]> {
    return this.deps.requests.listLive(tenantId);
  }

  async find(tenantId: string, requestId: string): Promise<ClientRequestRecord> {
    const record = await this.deps.requests.findById(tenantId, requestId);
    if (record === null) throw new RequestNotFound(requestId);
    return record;
  }

  /**
   * The firm answers, optionally attaching a document it has already filed
   * against this client.
   *
   * The attachment is not an upload. "Send me last year's balance sheet" is
   * answered by a document that already exists in the firm's store, filed
   * against that client — and what makes it reach them is 0066's
   * `is_client_visible`, which the adapter flips in the same transaction
   * because attaching it to a message addressed to a client IS the decision to
   * show it. A firm sending something not yet filed files it first, against the
   * client, which is the ordinary act and leaves the document where the rest of
   * that client's papers are.
   */
  async replyAsFirm(input: FirmReplyInput): Promise<ClientRequestRecord> {
    const body = input.body.trim();
    if (body.length === 0) throw new RequestReplyEmpty();

    // Read first so a settled request refuses with its own sentence rather than
    // as a write that matched no rows. The adapter refuses it too — its UPDATE
    // and INSERT both carry the live-status predicate — and that is the one
    // that holds under a race.
    const current = await this.find(input.tenantId, input.requestId);
    if (!acceptsReply(current.request.status)) {
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    const outcome = await this.deps.requests.reply({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      requestId: input.requestId,
      body,
      documentId: input.documentId,
      writtenBy: this.requireHuman(input.actor),
    });
    if (!outcome.ok) {
      if (outcome.reason === "document") {
        throw new RequestDocumentNotFound(input.documentId ?? "");
      }
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.replied",
      objectId: input.requestId,
      actor: input.actor,
      // Ids and machine facts only. NEITHER THE REPLY NOR THE REQUEST'S OWN
      // WORDS: both are prose about a client's business, and this log cannot be
      // erased (§3.4). `documentAttached` is a fact about what the firm DID,
      // which is exactly what an audit trail is for.
      payload: {
        authorSide: "firm",
        clientPartyId: outcome.record.request.clientPartyId,
        documentAttached: input.documentId !== null,
      },
    });
    return outcome.record;
  }

  /** The firm is done with it. Never `withdrawn` — that ending is the
   *  client's, and it is not reachable from this side. */
  async close(input: CloseRequestInput): Promise<ClientRequestRecord> {
    const current = await this.find(input.tenantId, input.requestId);
    const record = await this.deps.requests.close({
      tenantId: input.tenantId,
      requestId: input.requestId,
      settledBy: this.requireHuman(input.actor),
    });
    // Null here means the row moved between the read and the write, and the
    // only move that produces it is somebody else settling it first.
    if (record === null) {
      throw new RequestAlreadySettled(input.requestId, current.request.status);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.closed",
      objectId: input.requestId,
      actor: input.actor,
      payload: {
        clientPartyId: record.request.clientPartyId,
        replyCount: record.replies.length,
      },
    });
    return record;
  }

  // ── the client's side ─────────────────────────────────────────────────────

  /**
   * Everything this login has ever asked the firm for.
   *
   * Including the finished ones, unlike the action centre's asks — their own
   * history is theirs to read and it is short, and "did I already ask for this"
   * is the question that stops the second phone call.
   */
  async mine(tenantId: string, userId: string, asOf?: string): Promise<PortalRequestList> {
    const day = asOf ?? this.today();
    const parties = await this.scopedParties(tenantId, userId, day);
    const rows = await this.deps.portal.list(tenantId, parties);
    const live = splitByReplied(rows);
    return {
      awaitingFirm: live.awaitingFirm,
      replied: live.replied,
      settled: rows.filter((r) => r.status === "closed" || r.status === "withdrawn"),
      asOf: day,
    };
  }

  /**
   * A client asks the firm for something. The first row in this product a
   * client creates.
   */
  async raise(input: RaiseRequestInput): Promise<PortalRequestRow> {
    const subject = input.subject.trim();
    if (subject.length === 0) throw new RequestSubjectEmpty();
    const body = input.body.trim();
    if (body.length === 0) throw new RequestBodyEmpty();

    const day = input.asOf ?? this.today();
    const parties = await this.scopedParties(input.tenantId, input.userId, day);

    // ── THIS CHECK IS A SENTENCE, NOT THE WALL ──────────────────────────
    //
    // 0068's `WITH CHECK (crm.portal_sees(client_party_id))` refuses a party
    // this session was not granted, in the database, under `withPortal`. What
    // it refuses WITH is a Postgres RLS violation, which reaches a client as a
    // 500 and tells them nothing. This turns that into a 404 that says what
    // happened.
    //
    // Delete it and the write is still refused — the integration suite proves
    // exactly that, by removing it and watching the INSERT throw. Delete the
    // POLICY and it is not. Keep them in that order in your head; they are not
    // two halves of one guard.
    if (!parties.includes(input.clientPartyId)) {
      throw new RequestCompanyNotYours(input.clientPartyId);
    }

    const row = await this.deps.portal.raise(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      clientPartyId: input.clientPartyId,
      subject,
      body,
      raisedBy: this.requireHuman(input.actor),
    });
    if (row === null) throw new RequestCompanyNotYours(input.clientPartyId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.raised",
      objectId: row.requestId,
      // THE ACTOR IS A CLIENT CONTACT. `client_ask.answered` was the first verb
      // in this registry whose human is routinely somebody outside the firm;
      // this is the first whose human is outside the firm and is STARTING
      // something rather than replying to it.
      actor: input.actor,
      // NEVER the subject and never the body. Both are the client's own words
      // about their own affairs — "we are being assessed for FY23, send the
      // returns" names the client's business as readily as a filename does —
      // and this log cannot be erased.
      payload: { clientPartyId: input.clientPartyId },
    });
    return row;
  }

  /** The client adds to the thread — most often "that is not what I meant". */
  async replyAsClient(input: PortalReplyInput): Promise<PortalRequestRow> {
    const body = input.body.trim();
    if (body.length === 0) throw new RequestReplyEmpty();

    const { parties, row } = await this.reachable(
      input.tenantId,
      input.userId,
      input.requestId,
      input.asOf,
    );
    if (!acceptsReply(row.status)) {
      throw new RequestAlreadySettled(input.requestId, row.status);
    }

    const next = await this.deps.portal.reply(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      requestId: input.requestId,
      body,
      writtenBy: this.requireHuman(input.actor),
    });
    if (next === null) throw new RequestAlreadySettled(input.requestId, row.status);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.replied",
      objectId: input.requestId,
      actor: input.actor,
      payload: {
        authorSide: "client",
        clientPartyId: this.partyOf(parties, next),
        documentAttached: false,
      },
    });
    return next;
  }

  /**
   * The client no longer wants it.
   *
   * Its own verb rather than a flavour of the firm's close, for
   * `client_ask.withdrawn`'s reason pointed the other way: "we sorted it
   * ourselves" and "the firm dealt with it" are different answers to a partner
   * asking whether the firm is actually responding to its clients — and a firm
   * whose requests are mostly withdrawn is being told something real.
   */
  async withdraw(input: WithdrawInput): Promise<PortalRequestRow> {
    const { parties, row } = await this.reachable(
      input.tenantId,
      input.userId,
      input.requestId,
      input.asOf,
    );

    const next = await this.deps.portal.withdraw(input.tenantId, parties, {
      requestId: input.requestId,
      settledBy: this.requireHuman(input.actor),
    });
    if (next === null) throw new RequestAlreadySettled(input.requestId, row.status);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_request.withdrawn",
      objectId: input.requestId,
      actor: input.actor,
      payload: { clientPartyId: this.partyOf(parties, next) },
    });
    return next;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * The request this session can actually reach, and the scope that reached it.
   *
   * Both come back together because every write below needs the party list a
   * second time and re-deriving it would be a second answer to "what may this
   * session see" — taken a moment later, against a grant that may have ended in
   * between.
   */
  private async reachable(
    tenantId: string,
    userId: string,
    requestId: string,
    asOf?: string,
  ): Promise<{ parties: readonly string[]; row: PortalRequestRow }> {
    const day = asOf ?? this.today();
    const parties = await this.scopedParties(tenantId, userId, day);
    const row = await this.deps.portal.findById(tenantId, parties, requestId);
    if (row === null) throw new RequestNotFound(requestId);
    return { parties, row };
  }

  private async scopedParties(
    tenantId: string,
    userId: string,
    on: string,
  ): Promise<readonly string[]> {
    const companies = await this.deps.scope.scopedCompanies(tenantId, userId, on);
    return companies.map((c) => c.clientPartyId);
  }

  /**
   * The client party a portal row belongs to, for the ledger payload.
   *
   * The portal row does not carry the id — a client reading their own screen
   * has no use for it, and `PortalRequestRow` is narrow on purpose. With one
   * granted company it is that one; with several the event would otherwise have
   * to name none, and an audit row that cannot say WHICH company a request was
   * about is most of the reason to have the row at all.
   *
   * Null rather than a guess when the session holds several. The firm's own
   * screen carries the company on every row, and `objectId` resolves to the
   * request, which knows.
   */
  private partyOf(parties: readonly string[], _row: PortalRequestRow): string | null {
    return parties.length === 1 ? (parties[0] ?? null) : null;
  }

  private requireHuman(actor: Actor): string {
    // Unreachable behind the session guard, which is what produces the actor.
    // Refusing rather than writing null is the safe reading: `raised_by` and
    // `written_by` are NOT NULL because "somebody asked" with no somebody is
    // not a record — and on this table the somebody is the whole point, since
    // nothing in this product raises a request on a client's behalf.
    const id = actor.type === "human" ? actor.id : null;
    if (id === null) throw new RequestReplyEmpty();
    return id;
  }

  /** The server's calendar day — the honest fallback for a caller that did not
   *  say which day it is on, and never the answer when one did. */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}

export type { ClientRequestRecord, PortalRequestRow, RequestStatus };
