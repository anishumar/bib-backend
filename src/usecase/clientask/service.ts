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
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import { isCalendarDay } from "../../domain/day";
import { dayInZone } from "../../domain/scheduler/zone";
import type { EventSink } from "../ledger/ports";
import type {
  AskKind,
  AskRecord,
  AskResponseRecord,
  AskTemplateRef,
  PortalAskRow,
} from "../../domain/clientask/model";
import {
  acceptsClosure,
  acceptsResponse,
  ASK_KINDS,
  decisionFits,
  dueDayRefusal,
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
  InvalidAskDueDate,
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
  FirmTimeZone,
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
  /** The firm's zone, so "today" for a due day a person types is the FIRM's
   *  today (T6.14's rule) and never the server's or the browser's. */
  readonly timeZones: FirmTimeZone;
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
  /** The day the firm wants it by, `YYYY-MM-DD`, or absent/null for none. A real
   *  calendar day, not before the firm's today (0385). */
  readonly dueOn?: string | null;
  readonly actor: Actor;
}

/**
 * An ask a REQUEST TEMPLATE raises (F1.3/F1.4). The requests sweep's input.
 *
 * No actor: it is always the SYSTEM, because the sweep raises it on the firm's
 * behalf and no person pressed anything. No client party, for `raise`'s reason.
 * `dueOn` is required: every template item states a due offset (F1 contract),
 * so a template ask always has the firm's own day.
 */
export interface RaiseFromTemplateInput {
  readonly tenantId: string;
  readonly workItemId: string;
  /** What the client reads — the template item's label. */
  readonly prompt: string;
  readonly askKind: string;
  readonly documentKind: string | null;
  /** `YYYY-MM-DD`. A real day; one already past IS accepted (see the method). */
  readonly dueOn: string;
  readonly template: AskTemplateRef;
}

/**
 * What `raiseFromTemplate` did. `created: false` is the sweep's ordinary second
 * pass over an item it already raised, and carries no ask: nothing was written
 * and nothing was recorded, which is the whole answer the sweep needs.
 */
export type RaiseFromTemplateResult =
  | { readonly created: true; readonly ask: AskRecord }
  | { readonly created: false; readonly ask: null };

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
    const { prompt, askKind, documentKind } = this.validAsk(input);

    // A DUE DAY IS OPTIONAL, AND ONE IS CHECKED AGAINST THE FIRM'S TODAY (0385).
    // Absent stays the ordinary answer — T6.6's rule that no deadline this
    // product invents reaches a client still holds; a day here is one a person
    // TYPED. Refused before anything is written, so a typo costs nothing.
    const dueOn = input.dueOn ?? null;
    if (dueOn !== null) {
      const today = await this.firmToday(input.tenantId);
      const refusal = dueDayRefusal(dueOn, today);
      if (refusal !== null) throw new InvalidAskDueDate(dueOn, refusal, today);
    }

    const raisedBy = this.humanOrNull(input.actor);
    if (raisedBy === null) {
      // The column may be null since 0385, and ONLY for a template's ask — the
      // CHECK says "a person or a template". An ask raised through this method
      // is a request from a person to a person, and "the system would like your
      // purchase register" is not something a client can reply to; the system's
      // own asks go through `raiseFromTemplate`, which names the template.
      throw new InvalidAskPrompt();
    }

    const record = await this.deps.asks.raise({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      workItemId: input.workItemId,
      askKind,
      prompt,
      documentKind,
      raisedBy,
      dueOn,
    });
    if (record === null) throw new AskWorkItemNotFound(input.workItemId);

    await this.recordRaised(input.tenantId, record, input.actor);
    return record;
  }

  /**
   * Raise one item of a request template on one task — at most ONCE (F1.3).
   *
   * THE REQUESTS SWEEP'S DOOR, and it is at-least-once like everything the
   * engine touches (T2.6): pg-boss redelivers, a pass re-reads what it has seen.
   * So the INSERT is `ON CONFLICT DO NOTHING` against 0385's partial unique
   * index on (firm, task, template key, item key) and `client_ask.raised` is
   * recorded ONLY when a row was created — a second call writes nothing, records
   * nothing, and answers `created: false`. The database decides, never a read
   * before the write, so two sweeps racing still leave one ask.
   *
   * THE ACTOR IS THE SYSTEM, honestly: nobody pressed anything, a cron did, and
   * the row says so with a null `raised_by` beside the template it names.
   *
   * A DUE DAY ALREADY PAST IS ACCEPTED HERE, and that is the difference from
   * `raise`. The day was not chosen now by somebody who could choose another: it
   * is the template's offset from the period's end, fixed when the firm
   * published it. A sweep that runs late — a worker down over a weekend, a firm
   * switched on mid-month, a template published after its send day — must still
   * ask for October's records, and asking with the day the firm actually stated
   * is the truth; refusing would mean the client is never asked at all, and
   * moving the day would be this product inventing a deadline, which is the one
   * thing 0385 does not allow. The day must still be a real one.
   *
   * Prompt, kind and document kind are validated exactly as `raise` does, and
   * the client is read from the work item inside the INSERT, never passed in.
   */
  async raiseFromTemplate(input: RaiseFromTemplateInput): Promise<RaiseFromTemplateResult> {
    const { prompt, askKind, documentKind } = this.validAsk(input);
    if (!isCalendarDay(input.dueOn)) {
      throw new InvalidAskDueDate(input.dueOn, "not_a_day", null);
    }

    const result = await this.deps.asks.raiseFromTemplate({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      workItemId: input.workItemId,
      askKind,
      prompt,
      documentKind,
      dueOn: input.dueOn,
      template: {
        versionId: input.template.versionId,
        templateKey: input.template.templateKey,
        itemKey: input.template.itemKey,
      },
    });
    switch (result.outcome) {
      case "no_work_item":
        throw new AskWorkItemNotFound(input.workItemId);
      case "already_raised":
        return { created: false, ask: null };
      case "created":
        await this.recordRaised(input.tenantId, result.record, SYSTEM_ACTOR);
        return { created: true, ask: result.record };
    }
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

  /**
   * The checks every ask meets, however it is raised — a person's or a
   * template's. One copy, so the two doors cannot come to disagree about what
   * an ask is.
   */
  private validAsk(input: {
    readonly prompt: string;
    readonly askKind: string;
    readonly documentKind: string | null;
  }): { prompt: string; askKind: AskKind; documentKind: DocumentKind | null } {
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
    return { prompt, askKind: input.askKind, documentKind: input.documentKind };
  }

  /** `client_ask.raised`, written once the row has committed. */
  private async recordRaised(tenantId: string, record: AskRecord, actor: Actor): Promise<void> {
    const { ask } = record;
    await this.deps.events.recordEvent({
      tenantId,
      verb: "client_ask.raised",
      objectId: ask.id,
      actor,
      // Ids and machine facts only. THE PROMPT IS NOT HERE: it is prose about a
      // client's own business ("send the Kaveri purchase register"), it names
      // the client as readily as a filename does, and this log cannot be erased.
      // `dueOn` is a day the firm stated (null when none); the template's two
      // KEYS are the firm's own config handles, never the item's label, which is
      // the prompt by another name.
      payload: {
        askKind: ask.askKind,
        workItemId: ask.workItemId,
        clientPartyId: ask.clientPartyId,
        dueOn: ask.dueOn,
        ...(ask.documentKind === null ? {} : { documentKind: ask.documentKind }),
        ...(ask.fromTemplate === null
          ? {}
          : { templateKey: ask.fromTemplate.templateKey, itemKey: ask.fromTemplate.itemKey }),
      },
    });
  }

  /** The FIRM's today, in its own zone — T6.14's rule for every "today". */
  private async firmToday(tenantId: string): Promise<string> {
    return dayInZone(
      this.deps.clock.now().toISOString(),
      await this.deps.timeZones.timeZoneFor(tenantId),
    );
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
