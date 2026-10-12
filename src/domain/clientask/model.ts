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

import { isCalendarDay } from "../day";
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
 * A DUE DAY ONLY WHEN THE FIRM STATED ONE (0385, F1.3 — reversing T6.6's "no
 * due date, anywhere"). The portal's rule still holds: no deadline this product
 * INVENTED reaches a client. What changed is that a request template is the
 * firm writing its own day down ("the month's records by the 5th"), and a
 * person raising an ask by hand may type one. Null is still the ordinary
 * answer, and `raisedAt` is still what the chaser counts from.
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
  /** The person who raised it. NULL exactly when a request template did (0385):
   *  the sweep raises those on the firm's behalf, and naming the template's
   *  publisher or the task's holder would put a person on an act they did not
   *  perform. A CHECK holds "a person or a template". */
  readonly raisedBy: string | null;
  readonly raisedAt: string;
  readonly firstAnsweredAt: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  /**
   * The day the firm wants it by, as `YYYY-MM-DD`, or null when nobody stated
   * one. A DAY and never an instant: read with `::text` so no `Date` and no
   * zone is ever involved (CLAUDE.md, "A `date` column is a DAY").
   */
  readonly dueOn: string | null;
  /** The request template this ask was raised from, or null for one a person
   *  raised by hand. */
  readonly fromTemplate: AskTemplateRef | null;
}

/**
 * Which request template, and which item in it, an ask was raised from (0385).
 *
 * `versionId` PINS the config version, the way a job pins its process: what the
 * template said when this was asked stays answerable after a republish. The two
 * KEYS are what the sweep's idempotency is keyed on — the version moves on every
 * republish, the keys do not, so "October's bank statements for this task" is
 * one ask however often the template is edited.
 */
export interface AskTemplateRef {
  readonly versionId: string;
  readonly templateKey: string;
  readonly itemKey: string;
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
  /**
   * Somebody at the FIRM recorded this for the client (0390, F1.6): files the
   * client sent another way, by email, uploaded on the ask. The response is
   * then the colleague's act and `responded_by` names them, so the client's own
   * surface names nobody (T6.5's rule) and says the firm added it. False for
   * every response the client gave themselves.
   */
  readonly onBehalf: boolean;
}

/**
 * One rung of the chaser climbed on one ask (T4.4, migration 0065) — and the
 * READER that row waited for.
 *
 * ── IT SHIPPED WITH A WRITER AND NOBODY LOOKING AT IT ────────────────────
 *
 * `delivery.client_ask_chase` was written by the sweep, carried a portal policy,
 * emitted `client_ask.chased`, and NOTHING rendered any of it. That is the sixth
 * registered thing this codebase has found in that state, after
 * `membership.revoked`, `obligation.filed`, the escalation ladder's comment,
 * `is_client_visible` and `files.document.party_id`. A firm cannot say *"we
 * reminded you three times"* off a row no screen reads.
 *
 * `label` is deliberately NOT here. The rung's label lives in the firm's
 * published `chaser` config and a ladder edited in April must not restate what
 * March's chase was called — `rungKey` and `afterDays` are on the row precisely
 * so the row stays readable after the ladder moves under it (0065). The screen
 * shows the key, which is what the firm itself wrote.
 */
export interface AskChaseRecord {
  readonly rungKey: string;
  /** The threshold that fired, copied from the rung at the moment it did. */
  readonly afterDays: number;
  /** How long the ask had actually been open when it fired. */
  readonly daysOpen: number;
  readonly chasedAt: string;
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
  /**
   * Every reminder the chaser has sent about this, oldest first.
   *
   * THE FIRM'S HALF IS NOT A DECISION, unlike the client's (see
   * `PortalAskRow.lastRemindedAt`). A colleague opening this task has to be able
   * to see that it has been chased three times and is still open — otherwise the
   * next thing they do is chase it a fourth time by hand, which is the exact
   * work T4.4 exists to remove.
   */
  readonly chases: readonly AskChaseRecord[];
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
  /**
   * The day the firm wants it by (`YYYY-MM-DD`), or null when it stated none.
   *
   * On the client's row because it is the FIRM's stated day — a request
   * template's, or one a person typed — and never one this product worked out
   * (0385). Which template raised the ask is deliberately NOT on this row: it is
   * the firm's own bookkeeping and a client learns nothing from it.
   */
  readonly dueOn: string | null;
  /**
   * When the firm last reminded them about this, or null if it never has.
   *
   * ── A DATE AND NOT A COUNT, AND THAT IS THE DECISION ────────────────────
   *
   * 0065's own comment said this surface would show *"how many times it has been
   * reminded and when"*. Only half of that ships, and the half that does not is
   * a deliberate choice rather than an omission (Shrestha, 2026-09-01).
   *
   * *"We have reminded you 4 times"* is an accusation printed on somebody's own
   * page, and on a daily rung it reads *"9 times"* within a fortnight. What a
   * client can act on is WHEN — "you last heard from us on the 12th" tells them
   * whether they missed a message; the tally tells them only what the firm
   * thinks of them, and the predictable response to it is an email, which is
   * where all of this was before the portal.
   *
   * THE COUNT IS NOT LOST. `AskRecord.chases` carries every rung on the firm's
   * own screen, which is where *"we asked you four times"* is a sentence
   * somebody needs evidence for. The row is append-only by GRANT for exactly
   * that reason — a record the firm can edit is not evidence — and none of that
   * changes because the client's page is quieter about it.
   */
  readonly lastRemindedAt: string | null;
  readonly responses: readonly AskResponseRecord[];
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * How many files one upload may carry (F1.6). A month's records arrive as
 * several files at once (sales, purchases, two bank statements), and twenty is
 * more than any ask needs while keeping one request's work bounded. The SIZE is
 * bounded separately: each file by the firm's upload limit, and the whole
 * request by the same limit at the edge, so a large batch goes in more than one
 * request.
 */
export const MAX_FILES_PER_UPLOAD = 20;

/** Whether one upload may carry this many files: at least one, at most the cap. */
export function fileCountFits(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= MAX_FILES_PER_UPLOAD;
}

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

/** Why a due day cannot stand, or null when it can. */
export type DueDayRefusal = "not_a_day" | "before_today";

/**
 * Whether a due day a PERSON chose can stand (0385): a real calendar day, and
 * not before the firm's today.
 *
 * `firmToday` is the FIRM's day, resolved in its own zone by the caller — never
 * the server's and never the browser's, the rule every "today" in this product
 * follows (T6.14). A day already gone would arrive on the client's screen as
 * overdue the moment they read it, which is a mistake at the moment of asking,
 * not a decision.
 *
 * Comparing the two strings is comparing the days: both are `YYYY-MM-DD`, so
 * the lexical order IS the calendar order and no `Date` is constructed.
 *
 * A TEMPLATE's ask asks only the first half — see `ClientAskService.raiseFromTemplate`.
 */
export function dueDayRefusal(dueOn: string, firmToday: string): DueDayRefusal | null {
  if (!isCalendarDay(dueOn)) return "not_a_day";
  if (dueOn < firmToday) return "before_today";
  return null;
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
