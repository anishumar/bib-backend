// The client-directed ask (T6.6) — the row that says WE ARE WAITING ON YOU, and
// the pure rules about it. Imports nothing internal and nothing beyond the
// standard library.
//
// ── WHY IT IS NOT `blocked_reason` ─────────────────────────────────────────
//
// T6.5 shipped a "Held up" section built from `delivery.work_item`'s
// `blocked_reason`, shown verbatim under a line saying whose words they are, and
// named it honestly: nothing in that schema records who a task is WAITING ON.
// `is_blocked` means the firm cannot proceed, and the sentence beside it reads
// *"the client has not sent the purchase register"* as readily as *"the GST
// portal is down"*. A portal that put an answer box under both would be asking a
// client to fix somebody else's servers.
//
// So an ask is raised deliberately, addressed to one client, and carries
// somewhere to answer it. Raising one does NOT block the work item — a task can
// be waiting on the client for one thing and moving on three others, and a firm
// that wants the two coupled sets the state itself (migration 0063).

import type { DocumentKind } from "../filestore/model";

/**
 * What kind of answer an ask wants — and therefore what the action centre draws
 * under it.
 *
 * A closed set in the code and a CHECK in the database (0063), not a
 * configuration kind. These three are the three controls the portal can RENDER;
 * a fourth invented by a firm would be a row no screen knows how to answer.
 */
export type AskKind = "document" | "question" | "approval";

export const ASK_KINDS: readonly AskKind[] = ["document", "question", "approval"];

export function isAskKind(v: string): v is AskKind {
  return (ASK_KINDS as readonly string[]).includes(v);
}

/**
 * Where an ask has got to.
 *
 * `answered` IS NOT `closed`, and that is the decision this type exists to make
 * un-forgettable (Shrestha, 2026-09-01). The client responding turns an ask
 * `answered`; the FIRM decides whether what arrived was what it needed. A client
 * who sent last quarter's register would otherwise see the ask marked done, and
 * the firm would have to raise a second one that reads as a fresh request rather
 * than "that was not it".
 *
 * `withdrawn` is kept apart from `closed` for the client's sake: "we found it
 * ourselves" and "thank you, that was it" are different answers to "did I
 * actually need to do that".
 */
export type AskStatus = "open" | "answered" | "closed" | "withdrawn";

export const ASK_STATUSES: readonly AskStatus[] = ["open", "answered", "closed", "withdrawn"];

/** What the client actually did. Deliberately not a copy of `AskKind`: a client
 *  answering a DOCUMENT ask in words — *"we hold none, the shop closed in
 *  2019"* — is a real and useful response, and forcing it to be a file would
 *  make the honest answer unsayable. */
export type ResponseKind = "document" | "answer" | "decision";

export const RESPONSE_KINDS: readonly ResponseKind[] = ["document", "answer", "decision"];

/** A client's yes or no. Its own row and never `delivery.work_item_approval` —
 *  see the argument in 0063: the firm's maker-checker is a statement about the
 *  QUALITY of the work, and a client's approval is an instruction. Counting
 *  them together would make a client's "yes" look like a checker's sign-off. */
export type AskDecision = "approved" | "declined";

export const ASK_DECISIONS: readonly AskDecision[] = ["approved", "declined"];

export function isAskDecision(v: string): v is AskDecision {
  return (ASK_DECISIONS as readonly string[]).includes(v);
}

/**
 * One thing the firm has asked one client for.
 *
 * `clientPartyId` is on the row rather than reached through the work item, and
 * that is the wall's own column (0063): gate 4 filters each table on the column
 * that table carries. It cannot disagree with the work item — the composite
 * foreign key checks the pair — so the denormalisation is a guarantee rather
 * than a hope.
 *
 * THERE IS NO DUE DATE AND THERE MUST NOT BE ONE. The portal's rule: no deadline
 * this product invented reaches a client. The firm has never given its
 * turnaround times, so "by Friday" would be a promise nobody made, quoted back
 * at the firm. `raisedAt` is here and elapsed time is a fact.
 */
export interface ClientAsk {
  readonly id: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly clientPartyId: string;
  readonly askKind: AskKind;
  /** The firm's own words for what it wants. The only field that says what is
   *  actually wanted — without it the action centre is a list of blanks. Shown
   *  to the client verbatim, under a line saying whose words they are. */
  readonly prompt: string;
  /**
   * What an uploaded answer gets filed as. Present exactly when `askKind` is
   * `document` — a CHECK in 0063 holds the pair.
   *
   * `DocumentKind` and not `string`, and it costs an import from
   * `domain/filestore` that is worth making: the vocabulary is already written
   * three times (here, 0037's CHECK and 0063's), and typing it as a string here
   * would let a fourth spelling reach the API's response schema, where the
   * generated client would carry it as `string` and the firm's screen would
   * offer a kind the store cannot file.
   */
  readonly documentKind: DocumentKind | null;
  readonly status: AskStatus;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly firstAnsweredAt: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
}

/** One act by the client, appended. `client_ask_response` is append-only by
 *  GRANT (0063) for the reason `document_version` and the ledger are: a client's
 *  answer is evidence, and "they sent the wrong file, then the right one" is a
 *  history rather than an overwrite. */
export interface AskResponse {
  readonly id: string;
  readonly askId: string;
  readonly responseKind: ResponseKind;
  /** The client's own words. Present on an `answer`, optional beside a document
   *  or a decision — a declined approval nearly always comes with a reason. */
  readonly answerText: string | null;
  readonly documentId: string | null;
  readonly decision: AskDecision | null;
  readonly respondedAt: string;
}

/**
 * An ask as the FIRM reads it, on the work item it was raised from.
 *
 * Names, never ids — the rule this codebase has now learnt six times. The
 * responses come with the read rather than per row, because an ask with no
 * answers rendered beside it is a list of questions nobody can tell apart.
 */
export interface AskRecord {
  readonly ask: ClientAsk;
  readonly clientName: string;
  /** Who raised it, and who closed it. Null when the account has been erased —
   *  a real answer, the same shape `EventRecord.actor` and `DocumentRecord`
   *  use. */
  readonly raisedByName: string | null;
  readonly closedByName: string | null;
  readonly responses: readonly AskResponseRecord[];
}

/** A response with the file resolved to something a person can read. */
export interface AskResponseRecord {
  readonly response: AskResponse;
  readonly respondedByName: string | null;
  /**
   * What the uploaded file is called and how big it is — joined, never looked up
   * per row.
   *
   * This is what gives `files.document_version`'s new portal policy (0063) a
   * READER on the day it ships, rather than the fifth registered thing in this
   * codebase with a writer and nobody looking at it. A portal contact reads the
   * filename of what they sent; they do not read the bytes back, because a
   * download route is more surface than the acceptance line needs.
   */
  readonly document: {
    readonly documentId: string;
    readonly filename: string;
    readonly byteSize: number;
    readonly mediaType: string;
  } | null;
}

/**
 * An ask as the CLIENT reads it, in the action centre.
 *
 * Deliberately narrower than `AskRecord`: no `raisedByName` (whose desk it is on
 * is the firm's business — T6.5's rule, and a name here invites a client to
 * chase a junior directly), no ids of the firm's own people, and the work item
 * carried by TITLE so the ask has something to sit under.
 */
export interface PortalAskRow {
  readonly askId: string;
  readonly askKind: AskKind;
  readonly prompt: string;
  readonly status: AskStatus;
  /**
   * What an uploaded answer gets FILED as — the firm's decision, taken when it
   * asked.
   *
   * On the row and NOT on the wire. The upload route needs it (a client does not
   * choose where in the firm's document store their file lands), and a client
   * reading `"working_paper"` learns nothing they can act on. The handler maps
   * field by field, which is what keeps that true.
   */
  readonly documentKind: DocumentKind | null;
  /** Which of the client's companies this is about, when the work names one.
   *  Null is a real answer — relationship-level work has no entity (0051). */
  readonly companyName: string | null;
  /** What the firm is doing that this ask is part of. */
  readonly workItemTitle: string;
  readonly raisedAt: string;
  readonly responses: readonly AskResponseRecord[];
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** Whether a client may still act on this ask. `answered` stays actionable: a
 *  client who sent the wrong file should be able to send the right one without
 *  waiting for the firm to say so. */
export function acceptsResponse(status: AskStatus): boolean {
  return status === "open" || status === "answered";
}

/** Whether the firm may still close or withdraw it. Closing a closed ask is a
 *  double-click; the service refuses it rather than writing a second closure
 *  over the first, which would move the date somebody is answering questions
 *  about. */
export function acceptsClosure(status: AskStatus): boolean {
  return status === "open" || status === "answered";
}

/**
 * The response kind an act produces, given what the ask wanted.
 *
 * A `decision` may only answer an `approval`, because a yes on a request for a
 * document means nothing — and because the decision is a record the firm may act
 * on. Everything else is open: a document ask may be answered in words (the shop
 * closed in 2019), and a question may be answered with a file (here is the
 * letter you asked about). Narrowing those would make the honest answer
 * unsayable, which is a worse failure than a loose record.
 */
export function decisionFits(askKind: AskKind): boolean {
  return askKind === "approval";
}

/** Split what the client sees into what still wants something from them and what
 *  does not. Pure and here rather than in the query, so the two lists cannot
 *  disagree about which rows they contain — one read, one predicate, both
 *  sides. */
export function splitByAwaiting(rows: readonly PortalAskRow[]): {
  readonly awaitingYou: readonly PortalAskRow[];
  readonly withTheFirm: readonly PortalAskRow[];
} {
  return {
    awaitingYou: rows.filter((r) => r.status === "open"),
    withTheFirm: rows.filter((r) => r.status === "answered"),
  };
}
