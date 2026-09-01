// Sentinel errors — the closed vocabulary of ways a client's own request fails.
// Owned here in the domain; `api/domainerr.ts` maps them to HTTP status codes.
// Match with `instanceof`, never by string.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`. `StaffGradeError` shipped without an entry and every
// one of its refusals answered 500, because unit tests assert on the thrown
// sentinel and only a real HTTP request ever sees a status code.

export class ClientRequestError extends Error {
  constructor(
    readonly code: ClientRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ClientRequestErrorCode =
  | "REQUEST_NOT_FOUND"
  | "REQUEST_COMPANY_NOT_YOURS"
  | "REQUEST_SUBJECT_EMPTY"
  | "REQUEST_BODY_EMPTY"
  | "REQUEST_ALREADY_SETTLED"
  | "REQUEST_REPLY_EMPTY"
  | "REQUEST_DOCUMENT_NOT_FOUND"
  | "REQUEST_ASSIGNEE_NOT_STAFF"
  | "REQUEST_ROUTING_UNKNOWN";

export class RequestNotFound extends ClientRequestError {
  constructor(requestId: string) {
    super(
      "REQUEST_NOT_FOUND",
      `no request ${JSON.stringify(requestId)} you can reach. On the client portal this is ` +
        `also the answer for a request belonging to a company you were not granted — the row ` +
        `is filtered in the database (gate 4), so there is nothing here to tell the two ` +
        `apart, and that is the point: a 403 would confirm it exists.`,
    );
  }
}

export class RequestCompanyNotYours extends ClientRequestError {
  constructor(clientPartyId: string) {
    super(
      "REQUEST_COMPANY_NOT_YOURS",
      `you have not been granted company ${JSON.stringify(clientPartyId)}, so a request ` +
        `about it cannot be raised from this session. This is the FIRST write in this ` +
        `product where the company is named by the caller rather than read from a parent row ` +
        `— the database refuses it through the policy's WITH CHECK (0068), and this sentence ` +
        `is what that refusal reads as.`,
    );
  }
}

export class RequestSubjectEmpty extends ClientRequestError {
  constructor() {
    super(
      "REQUEST_SUBJECT_EMPTY",
      `a request needs a subject. It is the single line the firm's inbox shows, and a blank ` +
        `one arrives there as a row nobody can tell from the row above it.`,
    );
  }
}

export class RequestBodyEmpty extends ClientRequestError {
  constructor() {
    super(
      "REQUEST_BODY_EMPTY",
      `a request needs to say what is wanted. A subject with nothing under it would have ` +
        `somebody at the firm ringing to ask what it meant, which is the call this whole ` +
        `surface exists to remove.`,
    );
  }
}

export class RequestAlreadySettled extends ClientRequestError {
  constructor(requestId: string, status: string) {
    super(
      "REQUEST_ALREADY_SETTLED",
      `request ${JSON.stringify(requestId)} is already ${JSON.stringify(status)}. Adding to ` +
        `it would reopen something one side has finished with without anybody deciding to ` +
        `reopen it, and settling it again would move the date somebody is answering ` +
        `questions about — raise a new one instead, so it reads as a fresh request rather ` +
        `than an edit of an old one.`,
    );
  }
}

export class RequestReplyEmpty extends ClientRequestError {
  constructor() {
    super(
      "REQUEST_REPLY_EMPTY",
      `a reply with no words in it is not a reply. That holds even when a document is ` +
        `attached: a file arriving on somebody's screen with no sentence beside it makes ` +
        `them guess which of the things they asked for it is.`,
    );
  }
}

export class RequestDocumentNotFound extends ClientRequestError {
  constructor(documentId: string) {
    super(
      "REQUEST_DOCUMENT_NOT_FOUND",
      `no document ${JSON.stringify(documentId)} filed against this client. A reply may only ` +
        `attach a document already filed against the company that asked — never another ` +
        `client's, and never one of the firm's own working papers, whose party is null. File ` +
        `it against the client first; that is the ordinary act, and it is what makes the ` +
        `document theirs to be sent.`,
    );
  }
}

export class RequestAssigneeNotStaff extends ClientRequestError {
  constructor(userId: string) {
    super(
      "REQUEST_ASSIGNEE_NOT_STAFF",
      `${JSON.stringify(userId)} is not an active member of this firm, so a request cannot be ` +
        `put on their desk. A foreign key cannot refuse this — tenancy.user_account is a ` +
        `GLOBAL table, and nothing in SQL can say "still works here" — which is why it is ` +
        `checked here, exactly as it is for a client assignment and a work item.`,
    );
  }
}

export class RequestRoutingUnknown extends ClientRequestError {
  constructor(routing: string, valid: readonly string[]) {
    super(
      "REQUEST_ROUTING_UNKNOWN",
      `${JSON.stringify(routing)} is not a way this product can route a client's request. ` +
        `Valid: ${valid.join(", ")}. A SPOC is deliberately absent and cannot be added ` +
        `without an axis: a request names no service, so there is nothing to pick a Dept by.`,
    );
  }
}
