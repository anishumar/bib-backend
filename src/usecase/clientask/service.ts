// The client-directed ask (T6.6) — the firm asks, the client answers, the firm
// says that was it.
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
//      default, and it learnt `{param}` templates for exactly these.
//   2. `portal:respond` (gate 3) decides which CONTACT may act — the first
//      permission in this product a portal session can hold, and the reason a
//      role now declares its audience.
//   3. `withPortal` in the adapter sets the granted parties, and the RESTRICTIVE
//      policies in 0063 do the filtering — on the WRITE as well as the read. So
//      the SQL under `PortalAskRepository` reads like SQL that forgot to filter
//      and still cannot leak.
//
// What this file does is resolve whose session it is, once, and refuse the
// things the database cannot refuse: an ask that is already finished, a decision
// on something nobody asked a yes/no about, an answer with no words in it.
//
// ── AN EMPTY SCOPE IS NOT A SHORTCUT ─────────────────────────────────────
//
// A contact granted nothing gets an empty list, and the read still goes all the
// way to the database with an empty scope. There is no `if (companies.length ===
// 0) return []` here and there must never be: it is indistinguishable from the
// version that works right up until somebody moves the check one layer down,
// where skipping the call leaves the session looking like STAFF.
import type { Clock } from "../../platform/clock";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  AskKind,
  AskRecord,
  AskResponseRecord,
  PortalAskRow,
} from "../../domain/clientask/model";
import {
  acceptsClosure,
  acceptsResponse,
  ASK_KINDS,
  decisionFits,
  isAskKind,
  splitByAwaiting,
} from "../../domain/clientask/model";
import {
  AskAlreadySettled,
  AskAnswerEmpty,
  AskDecisionNotWanted,
  AskDocumentKindMismatch,
  AskNotFound,
  AskWorkItemNotFound,
  InvalidAskKind,
  InvalidAskPrompt,
} from "../../domain/clientask/errors";
import {
  ContentTooLarge,
  EmptyContent,
  InvalidFilename,
  UnsupportedMediaType,
} from "../../domain/filestore/errors";
import type { DocumentKind } from "../../domain/filestore/model";
import {
  DOCUMENT_KINDS,
  isDocumentKind,
  normaliseMediaType,
  safeFilename,
} from "../../domain/filestore/model";
import type { BlobStore, ContentDigest } from "../filestore/ports";
import type {
  AskRepository,
  PortalAskRepository,
  PortalScopeSource,
} from "./ports";

export interface Deps {
  readonly asks: AskRepository;
  readonly portal: PortalAskRepository;
  readonly scope: PortalScopeSource;
  /**
   * The bytes, and the hash over them.
   *
   * Reused from the document store rather than re-declared, because they are the
   * same seams answering the same question — where do bytes live, and what is
   * their sha256. They are the two ports in `usecase/filestore/ports.ts` that
   * carry no tenant scoping at all, which is why this use case can hold them
   * without holding the staff document repository as well.
   *
   * THE STAFF `FileStoreService` IS DELIBERATELY NOT A DEPENDENCY. Its
   * repository writes through `withTenant`, so a portal upload routed through it
   * would put the one row that names the client OUTSIDE gate 4 — the wall would
   * then be the correctness of this file rather than a policy, which is the
   * trade 0059 exists to refuse. The cost is that filename and media-type
   * validation are called from two places; they are pure functions in
   * `domain/filestore/model.ts` and there is one copy of each.
   */
  readonly blobs: BlobStore;
  readonly digest: ContentDigest;
  readonly ids: IdGen;
  readonly events: EventSink;
  readonly clock: Clock;
  /** The largest file this store accepts, in bytes — the same config value the
   *  staff upload uses, and the same reason: the whole file is held in memory to
   *  be hashed, so this is what one request can cost the process. */
  readonly maxUploadBytes: number;
}

export interface RaiseAskInput {
  readonly tenantId: string;
  readonly workItemId: string;
  readonly askKind: string;
  readonly prompt: string;
  readonly documentKind: string | null;
  readonly actor: Actor;
}

export interface SettleAskInput {
  readonly tenantId: string;
  readonly askId: string;
  readonly actor: Actor;
}

export interface AnswerInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly askId: string;
  readonly answerText: string;
  readonly actor: Actor;
}

export interface DecideInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly askId: string;
  readonly decision: "approved" | "declined";
  /** The client's reason, if they gave one. A declined approval nearly always
   *  comes with one and refusing to carry it would send the firm back to email. */
  readonly note: string | null;
  readonly actor: Actor;
}

export interface UploadInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly askId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly note: string | null;
  readonly actor: Actor;
}

/** What the action centre renders. Split here rather than in the query, so the
 *  two lists cannot disagree about which rows they contain. */
export interface PortalActionCentre {
  readonly awaitingYou: readonly PortalAskRow[];
  readonly withTheFirm: readonly PortalAskRow[];
}

export class ClientAskService {
  constructor(private readonly deps: Deps) {}

  // ── the firm's side ────────────────────────────────────────────────────────

  /**
   * Ask a client for something, on a task.
   *
   * The client is NOT an argument: it is read from the work item inside the
   * insert. A caller naming the client would be a caller choosing what gate 4
   * filters this row on.
   */
  async raise(input: RaiseAskInput): Promise<AskRecord> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new InvalidAskPrompt();
    if (!isAskKind(input.askKind)) throw new InvalidAskKind(input.askKind, ASK_KINDS);

    // Refused here rather than left to 0063's CHECK, because the CHECK's message
    // names a constraint and this one names the decision. A document kind on an
    // approval is a field somebody filled in without meaning to; a document ask
    // without one leaves the filing decision to whatever the upload happens to
    // default to.
    const wantsDocument = input.askKind === "document";
    if (wantsDocument === (input.documentKind === null)) {
      throw new AskDocumentKindMismatch(input.askKind);
    }
    // CHECKED HERE, so a kind outside the closed set is a 400 with a sentence
    // rather than a 500 from 0063's CHECK. The route's zod enum already refuses
    // one over HTTP; this is the same rule for every other caller, and it is
    // what lets the port carry `DocumentKind` instead of `string` — one cast at
    // the edge instead of one in each adapter.
    if (input.documentKind !== null && !isDocumentKind(input.documentKind)) {
      throw new InvalidAskKind(input.documentKind, DOCUMENT_KINDS);
    }
    const documentKind: DocumentKind | null = input.documentKind;

    const raisedBy = this.humanOrNull(input.actor);
    if (raisedBy === null) {
      // The column is NOT NULL and it should be: an ask is a request from a
      // person to a person, and "the system would like your purchase register"
      // is not something a client can reply to.
      throw new InvalidAskPrompt();
    }

    const record = await this.deps.asks.raise({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      workItemId: input.workItemId,
      askKind: input.askKind,
      prompt,
      documentKind,
      raisedBy,
    });
    if (record === null) throw new AskWorkItemNotFound(input.workItemId);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "client_ask.raised",
      objectId: record.ask.id,
      actor: input.actor,
      // Ids and machine facts only. THE PROMPT IS NOT HERE: it is prose about a
      // client's own business ("send the Kaveri purchase register"), it names
      // the client as readily as a filename does, and this log cannot be erased.
      payload: {
        askKind: record.ask.askKind,
        workItemId: record.ask.workItemId,
        clientPartyId: record.ask.clientPartyId,
        ...(record.ask.documentKind === null ? {} : { documentKind: record.ask.documentKind }),
      },
    });
    return record;
  }

  listForWorkItem(tenantId: string, workItemId: string): Promise<readonly AskRecord[]> {
    return this.deps.asks.listForWorkItem(tenantId, workItemId);
  }

  /** The firm got what it needed. */
  close(input: SettleAskInput): Promise<AskRecord> {
    return this.settle(input, "closed", "client_ask.closed");
  }

  /** The firm no longer needs it — a different fact from `close`, and kept apart
   *  because "you sent it" and "never mind" are different answers to a client
   *  wondering whether they actually had to. */
  withdraw(input: SettleAskInput): Promise<AskRecord> {
    return this.settle(input, "withdrawn", "client_ask.withdrawn");
  }

  private async settle(
    input: SettleAskInput,
    status: "closed" | "withdrawn",
    verb: "client_ask.closed" | "client_ask.withdrawn",
  ): Promise<AskRecord> {
    const existing = await this.deps.asks.findById(input.tenantId, input.askId);
    if (existing === null) throw new AskNotFound(input.askId);
    if (!acceptsClosure(existing.ask.status)) {
      throw new AskAlreadySettled(input.askId, existing.ask.status);
    }
    const closedBy = this.humanOrNull(input.actor);
    if (closedBy === null) throw new AskAlreadySettled(input.askId, existing.ask.status);

    const record = await this.deps.asks.settle({
      tenantId: input.tenantId,
      askId: input.askId,
      status,
      closedBy,
    });
    // Null here means the row moved between the read and the write — somebody
    // else closed it. The refusal is the same one, because the answer to the
    // caller is the same: it is finished and you did not finish it.
    if (record === null) throw new AskAlreadySettled(input.askId, existing.ask.status);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb,
      objectId: record.ask.id,
      actor: input.actor,
      payload: {
        askKind: record.ask.askKind,
        workItemId: record.ask.workItemId,
        clientPartyId: record.ask.clientPartyId,
        responseCount: record.responses.length,
      },
    });
    return record;
  }

  // ── the client's side ─────────────────────────────────────────────────────

  /** Everything waiting on this login, split into what still wants something
   *  and what is back with the firm. */
  async actionCentre(tenantId: string, userId: string): Promise<PortalActionCentre> {
    const parties = await this.scopedParties(tenantId, userId);
    const rows = await this.deps.portal.list(tenantId, parties);
    return splitByAwaiting(rows);
  }

  /** An answer in words — to a question, or to a request for a document the
   *  client cannot produce. */
  async answer(input: AnswerInput): Promise<PortalAskRow> {
    const text = input.answerText.trim();
    if (text.length === 0) throw new AskAnswerEmpty();
    const { parties, ask } = await this.reachableAsk(input.tenantId, input.userId, input.askId);

    const row = await this.deps.portal.respond(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      askId: ask.askId,
      responseKind: "answer",
      answerText: text,
      decision: null,
      respondedBy: this.requireHuman(input.actor),
    });
    return this.recordAnswered(input.tenantId, ask, row, input.actor, { responseKind: "answer" });
  }

  /** A yes or a no. Its own row and never `work_item_approval` — 0063 has the
   *  argument: the firm's maker-checker is a statement about the quality of the
   *  work, and this is an instruction from the client. */
  async decide(input: DecideInput): Promise<PortalAskRow> {
    const { parties, ask } = await this.reachableAsk(input.tenantId, input.userId, input.askId);
    if (!decisionFits(ask.askKind)) throw new AskDecisionNotWanted(ask.askKind);

    const note = input.note?.trim() ?? "";
    const row = await this.deps.portal.respond(input.tenantId, parties, {
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      askId: ask.askId,
      responseKind: "decision",
      answerText: note.length === 0 ? null : note,
      decision: input.decision,
      respondedBy: this.requireHuman(input.actor),
    });
    return this.recordAnswered(input.tenantId, ask, row, input.actor, {
      responseKind: "decision",
      decision: input.decision,
    });
  }

  /**
   * A file, against the ask that wanted it.
   *
   * ── ORDER: BYTES FIRST, ROWS SECOND ─────────────────────────────────────
   *
   * The document store's rule, unchanged (T3.6). A blob with no row is invisible
   * and costs storage; a row with no blob is a document the product offers and
   * cannot open. The first is waste, the second is a lie, and if this is
   * interrupted it should be the waste that happens.
   *
   * ── THERE IS NO VIRUS SCAN, NO OCR AND NO AUTO-FILING, AND NO PORT FOR ONE ─
   *
   * The board names all three. There is no scanner in this product and no agent
   * runtime either — `NoAgentsBuiltYet` is still what `setup/` wires — so every
   * one of them would be a contract written against nothing. This codebase has
   * a rule about that and paid for it: T3.6 wrote a `DocumentRenderer` port and
   * DELETED IT BEFORE COMMIT, because a contract designed against no consumer
   * ends up wrong, and T2.5 deferred `workflow_template` for the same reason.
   * A `scan()` that returned "clean" would be worse than absent — it is a lie
   * with a function signature — and one that threw would make uploads
   * impossible, which is not a feature either.
   *
   * So what is true is said instead of stubbed: a client-supplied file is stored
   * UNSCANNED, the firm's screen says so beside it, and the one protection that
   * does exist is the download route's `content-disposition: attachment`, which
   * has never been `inline` precisely because this store holds files supplied by
   * clients. When a scanner arrives it arrives with a consumer.
   */
  async upload(input: UploadInput): Promise<PortalAskRow> {
    const filename = safeFilename(input.filename);
    if (filename === null) throw new InvalidFilename(input.filename);

    const mediaType = normaliseMediaType(input.mediaType);
    if (mediaType === null) throw new UnsupportedMediaType(input.mediaType);

    if (input.bytes.byteLength === 0) throw new EmptyContent(filename);
    if (input.bytes.byteLength > this.deps.maxUploadBytes) {
      throw new ContentTooLarge(input.bytes.byteLength, this.deps.maxUploadBytes);
    }

    const { parties, ask } = await this.reachableAsk(input.tenantId, input.userId, input.askId);

    // What the file gets FILED as comes from the ask, never from the upload. A
    // client choosing the kind would be a client choosing where in the firm's
    // document store their file lands, and the firm already said when it asked.
    // An ask that is not a document ask still accepts a file — "here is the
    // letter you asked about" is a real answer to a question — and its
    // `documentKind` is null by 0063's CHECK, so `correspondence` is the honest
    // filing for a file nobody asked for by kind.
    const documentKind = ask.documentKind ?? "correspondence";

    const contentHash = this.deps.digest.ofBytes(input.bytes);
    const { storageKey } = await this.deps.blobs.put({
      tenantId: input.tenantId,
      contentHash,
      bytes: input.bytes,
    });

    const note = input.note?.trim() ?? "";
    const documentId = this.deps.ids.newId();
    const row = await this.deps.portal.respondWithDocument(
      input.tenantId,
      parties,
      {
        id: this.deps.ids.newId(),
        tenantId: input.tenantId,
        askId: ask.askId,
        responseKind: "document",
        answerText: note.length === 0 ? null : note,
        decision: null,
        respondedBy: this.requireHuman(input.actor),
      },
      {
        documentId,
        versionId: this.deps.ids.newId(),
        linkId: this.deps.ids.newId(),
        // The TITLE is the filename the client sent. A title the product
        // invented ("Response to ask 9f8b…") would be the one thing on the
        // firm's document list that nobody can search for.
        title: filename,
        documentKind,
        contentHash,
        byteSize: input.bytes.byteLength,
        mediaType,
        filename,
        storageKey,
      },
    );

    const record = await this.recordAnswered(input.tenantId, ask, row, input.actor, {
      responseKind: "document",
      documentId,
      contentHash,
      byteSize: input.bytes.byteLength,
      mediaType,
      documentKind,
    });

    // A second event, because a document being STORED is a fact about the
    // document store and is asked about there — "what has this firm taken in,
    // and how big was it" is answered from `document.stored` across every
    // origin, and an upload that only wrote `client_ask.answered` would be
    // missing from it.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.stored",
      objectId: documentId,
      actor: input.actor,
      payload: {
        kind: documentKind,
        origin: "uploaded",
        versionNo: 1,
        contentHash,
        byteSize: input.bytes.byteLength,
        mediaType,
      },
    });
    return record;
  }

  // ── shared ────────────────────────────────────────────────────────────────

  /**
   * The ask this session may act on, and the scope that admitted it.
   *
   * Resolved ONCE per request, here, rather than per query — two resolutions
   * could disagree across a day boundary and the second one is the wall. The
   * parties come back with it because every write below needs the same scope,
   * and looking it up again would be the second resolution this exists to avoid.
   */
  private async reachableAsk(
    tenantId: string,
    userId: string,
    askId: string,
  ): Promise<{ parties: readonly string[]; ask: PortalAskRow }> {
    const parties = await this.scopedParties(tenantId, userId);
    const ask = await this.deps.portal.findById(tenantId, parties, askId);
    // "No such ask" and "an ask belonging to a company you were not granted" are
    // the same answer, and there is nothing here that could tell them apart —
    // the row was filtered by the policy. A 403 would confirm it exists.
    if (ask === null) throw new AskNotFound(askId);
    if (!acceptsResponse(ask.status)) throw new AskAlreadySettled(askId, ask.status);
    return { parties, ask };
  }

  /** The grants, resolved by the grant module on the FIRM's day — never on a
   *  day the portal caller sends (F-07-1). */
  private scopedParties(tenantId: string, userId: string): Promise<string[]> {
    return this.deps.scope
      .scopedCompanies(tenantId, userId)
      .then((companies) => companies.map((c) => c.clientPartyId));
  }

  private async recordAnswered(
    tenantId: string,
    ask: PortalAskRow,
    row: PortalAskRow | null,
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<PortalAskRow> {
    // Null means the ask stopped being reachable or answerable between the read
    // and the write — the firm closed it in the meantime. Refused with the same
    // sentence, because the caller's situation is the same.
    if (row === null) throw new AskAlreadySettled(ask.askId, ask.status);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "client_ask.answered",
      objectId: ask.askId,
      // THE ACTOR IS A CLIENT CONTACT — the first verb in this registry whose
      // human actor is routinely somebody outside the firm. Nothing about the
      // sink changes; it is worth saying because a reader of this trail will
      // otherwise assume every `human` in it works at the firm.
      actor,
      // Never `answerText` and never the note. Both are the client's own words
      // about their own affairs, and this log cannot be erased (§3.4).
      payload: { ...payload, askKind: ask.askKind },
    });
    return row;
  }

  private humanOrNull(actor: Actor): string | null {
    return actor.type === "human" ? actor.id : null;
  }

  private requireHuman(actor: Actor): string {
    const id = this.humanOrNull(actor);
    // Unreachable behind the session guard, which is what produces the actor.
    // Refusing rather than writing null is the safe reading: `responded_by` is
    // NOT NULL because "somebody answered" with no somebody is not a record.
    if (id === null) throw new AskAnswerEmpty();
    return id;
  }

}

export type { AskKind, AskRecord, AskResponseRecord, PortalAskRow };
