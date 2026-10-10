// Sentinel errors — the closed vocabulary of ways a client-directed ask fails.
// Owned here in the domain; `api/domainerr.ts` maps them to HTTP status codes.
// Match with `instanceof`, never by string.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`. `StaffGradeError` shipped without an entry and every
// one of its refusals answered 500, because unit tests assert on the thrown
// sentinel and only a real HTTP request ever sees a status code.
import { longDay } from "../day";
import type { DueDayRefusal } from "./model";

export class ClientAskError extends Error {
  constructor(
    readonly code: ClientAskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ClientAskErrorCode =
  | "ASK_NOT_FOUND"
  | "ASK_WORK_ITEM_NOT_FOUND"
  | "INVALID_ASK_PROMPT"
  | "INVALID_ASK_KIND"
  | "ASK_DOCUMENT_KIND_MISMATCH"
  | "ASK_ALREADY_SETTLED"
  | "ASK_DECISION_NOT_WANTED"
  | "ASK_ANSWER_EMPTY"
  | "INVALID_DUE_DATE";

export class AskNotFound extends ClientAskError {
  readonly askId: string;

  constructor(askId: string) {
    super(
      "ASK_NOT_FOUND",
      // One sentence for "none" and "another company's": gate 4 filters the row
      // in the database, and a different answer would confirm it exists. In
      // words (F21, audit 2026-10-03); the id is on the log.
      "This request could not be found, or you do not have access to it.",
    );
    this.askId = askId;
  }
}

export class AskWorkItemNotFound extends ClientAskError {
  constructor(workItemId: string) {
    super(
      "ASK_WORK_ITEM_NOT_FOUND",
      `No work item ${JSON.stringify(workItemId)} at this firm. An ask hangs off a work item ` +
        `and cannot be raised without one: that is what gives it a client to be addressed to ` +
        `and a job for the answer to be filed against.`,
    );
  }
}

export class InvalidAskPrompt extends ClientAskError {
  constructor() {
    super(
      "INVALID_ASK_PROMPT",
      `An ask needs to say what is wanted. The prompt is the only field the client reads as a ` +
        `request: an ask with a blank one arrives on their screen as a row with a button and ` +
        `no question.`,
    );
  }
}

export class InvalidAskKind extends ClientAskError {
  constructor(kind: string, valid: readonly string[]) {
    super(
      "INVALID_ASK_KIND",
      `${JSON.stringify(kind)} is not a kind of ask this product can draw a control for. ` +
        `Valid: ${valid.join(", ")}.`,
    );
  }
}

export class AskDocumentKindMismatch extends ClientAskError {
  constructor(askKind: string) {
    super(
      "ASK_DOCUMENT_KIND_MISMATCH",
      `A documentKind belongs to a ${JSON.stringify("document")} ask and nothing else: it ` +
        `says what the uploaded file gets FILED as. This one is ${JSON.stringify(askKind)}: ` +
        `either it wants a document, or it does not need to say how to file one.`,
    );
  }
}

export class AskAlreadySettled extends ClientAskError {
  constructor(askId: string, status: string) {
    super(
      "ASK_ALREADY_SETTLED",
      `Ask ${JSON.stringify(askId)} is already ${JSON.stringify(status)}. Closing it again ` +
        `would move the date somebody is answering questions about, and answering it again ` +
        `would append to something the firm has finished with: raise a new one instead, so ` +
        `it reads as a fresh request rather than an edit of an old one.`,
    );
  }
}

export class AskDecisionNotWanted extends ClientAskError {
  constructor(askKind: string) {
    super(
      "ASK_DECISION_NOT_WANTED",
      `This ask is ${JSON.stringify(askKind)}, and a yes or no does not answer it. An approval ` +
        `is a decision the firm may act on; recording one against a request for a document ` +
        `would leave a record saying the client agreed to something nobody asked them about.`,
    );
  }
}

/**
 * A due day that cannot stand (0385): not a real calendar day, or a day already
 * gone on the firm's calendar. The two are one code because the answer to the
 * caller is the same — choose another day, or leave it out — and the sentence
 * says which it was.
 */
export class InvalidAskDueDate extends ClientAskError {
  readonly dueOn: string;

  constructor(dueOn: string, why: DueDayRefusal, firmToday: string | null) {
    super(
      "INVALID_DUE_DATE",
      why === "not_a_day"
        ? `dueOn ${JSON.stringify(dueOn)} is not a day. Send a calendar day that exists, as ` +
            `YYYY-MM-DD, or leave it out: an ask with no due day is still an ask.`
        : `dueOn ${longDay(dueOn)} is before today${firmToday === null ? "" : ` (${longDay(firmToday)})`} ` +
            `on the firm's calendar. A day already gone would reach the client as overdue the ` +
            `moment they read it: choose today or later, or leave it out.`,
    );
    this.dueOn = dueOn;
  }
}

export class AskAnswerEmpty extends ClientAskError {
  constructor() {
    super(
      "ASK_ANSWER_EMPTY",
      `An answer with no words in it is not an answer. It would turn the ask "answered" and ` +
        `tell the firm nothing, which is worse than leaving it open.`,
    );
  }
}
