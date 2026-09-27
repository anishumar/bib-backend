// The closed, cross-service error-code set and the map from a domain error to
// an HTTP tuple. The MEANING of a failure lives in the domain (sentinel
// errors); the STATUS CODE lives here, where HTTP knowledge belongs. A gRPC
// edge would write the same map with different right-hand sides, and neither
// the domain nor the use case would know either edge exists.
//
// No service adds to this set — finer distinctions go in `reason`.
import { HTTPException } from "hono/http-exception";
import { TenancyError } from "../domain/tenancy/errors";
import { StaffGradeError } from "../domain/staffgrade/errors";
import { ServiceAxisError } from "../domain/serviceaxis/errors";
import { ClientAssignmentError } from "../domain/clientassignment/errors";
import { ClientImportError } from "../domain/clientimport/errors";
import { PortalAccessError } from "../domain/portalaccess/errors";
import { PortalInviteError } from "../domain/portalinvite/errors";
import { ClientAskError } from "../domain/clientask/errors";
import { ClientRequestError } from "../domain/clientrequest/errors";
import { ChaserError } from "../domain/chaser/errors";
import { PortalLibraryError } from "../domain/portallibrary/errors";
import { WorkItemError } from "../domain/workitem/errors";
import { ObligationError } from "../domain/obligation/errors";
import { OrchestratorError } from "../domain/orchestrator/errors";
import { VerificationError } from "../domain/verification/errors";
import { SchedulerError } from "../domain/scheduler/errors";
import { PartyError } from "../domain/party/errors";
import { LedgerError } from "../domain/ledger/errors";
import { IdentityError } from "../domain/identity/errors";
import { AuthzError } from "../domain/authz/errors";
import { ConfigError } from "../domain/config/errors";
import { LeadError } from "../domain/lead/errors";
import { ProposalError } from "../domain/proposal/errors";
import { EngagementError } from "../domain/engagement/errors";
import { InvoiceError } from "../domain/invoice/errors";
import { DocumentError } from "../domain/document/errors";
import { FileStoreError } from "../domain/filestore/errors";
import { RenderError } from "../domain/render/errors";

/** The closed set, as a runtime value so the OpenAPI error schema and the
 *  ErrorCode type derive from ONE source and cannot drift apart. */
export const ERROR_CODES = [
  "VALIDATION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
  // Two codes added with the document store (T3.6), because uploads are the
  // first thing in this product where the existing vocabulary would have
  // flattened two genuinely different answers into one.
  //
  // PAYLOAD_TOO_LARGE is not VALIDATION. The request is well formed and the
  // caller did nothing wrong in shape — it is the SIZE that is refused — and a
  // client that can tell them apart offers "compress this and try again"
  // instead of "invalid file".
  //
  // UPSTREAM_FAILURE is not INTERNAL. It means a system BEHIND this one failed
  // while this one is healthy: the metadata is intact and the storage backend
  // has lost the bytes. Collapsing it into INTERNAL would make a storage outage
  // indistinguishable from a bug in this process, which is the first thing
  // anybody woken up at night needs to know.
  "PAYLOAD_TOO_LARGE",
  "UPSTREAM_FAILURE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP statuses this system emits — a closed set, so it is assignable to
 *  the transport's status type without a cast. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 502;

export interface MappedError {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly reason?: string;
}

/**
 * The status a family's switch falls through to when a code is UNMAPPED — and
 * the compile error that stops it happening.
 *
 * Every family below is a `switch` with no `default`, so an error code nobody
 * mapped used to fall out of its `if` and land on the final `return 500`. That
 * is not hypothetical: G3.3 shipped `StaffGradeError` with no entry here at
 * all, and every refusal it raised answered 500 instead of 400/404/409. Unit
 * tests were perfectly happy — they assert on the thrown sentinel — and only an
 * end-to-end request could see it.
 *
 * `code: never` is the whole mechanism. Reaching this line means the switch
 * above did not cover its union, and TypeScript refuses to compile the call.
 * The build breaks on the DAY a code is added, in the file that has to answer
 * for it, instead of on the day somebody walks the API by hand.
 *
 * It still returns 500 at runtime rather than throwing, because a mapper that
 * crashes turns a mislabelled error into no response at all.
 */
function unmapped(code: never): MappedError {
  return { status: 500, code: "INTERNAL", message: "internal error", reason: String(code) };
}

export function mapError(err: unknown): MappedError {
  // The transport's own faults, raised before any handler runs — a malformed
  // JSON body is the everyday one. Without this branch they fell through to
  // INTERNAL, so a client sending bad JSON got a 500 blaming the server, and
  // every such request was logged as an unhandled error. That is worse than
  // the wrong status code: routine client mistakes drown the log that real
  // 500s have to be found in.
  if (err instanceof HTTPException) return fromHttpException(err);

  if (err instanceof TenancyError) {
    switch (err.code) {
      case "INVALID_SLUG":
      case "INVALID_CURRENCY":
      case "INVALID_AUDIENCE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "SLUG_TAKEN":
      case "EMAIL_TAKEN":
      case "MEMBERSHIP_EXISTS":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "TENANT_NOT_FOUND":
      case "USER_NOT_FOUND":
      case "MEMBERSHIP_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Both are "the firm is not in the state this call assumed", and neither
      // is a malformed request. ROLE_NOT_DEFINED is a conflict between the
      // roster and the role registry; LAST_ADMINISTRATOR is refused by the
      // rest of the roster, so the caller fixes it by changing SOMEBODY ELSE.
      case "ROLE_NOT_DEFINED":
      case "LAST_ADMINISTRATOR":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // 404 rather than 403: the caller is not being refused permission, they
      // named somebody who is not on this firm's roster. Same answer as
      // MEMBERSHIP_NOT_FOUND above, because it is the same fact.
      case "SIGNATORY_NOT_A_MEMBER":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof StaffGradeError) {
    switch (err.code) {
      case "INVALID_GRADE_CODE":
      case "INVALID_RANK":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "GRADE_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "GRADE_CODE_TAKEN":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // A conflict rather than a validation failure, on the same reasoning as
      // LAST_ADMINISTRATOR above: the request is perfectly well formed, and what
      // refuses it is the state of the LADDER — the caller fixes it by
      // reactivating the rung or choosing another, not by resending this.
      case "GRADE_NOT_ASSIGNABLE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof OrchestratorError) {
    switch (err.code) {
      case "JOB_NOT_FOUND":
      case "STEP_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // A firm that has not written its process yet, or a job pinned to a
      // version that no longer reads. Both are 409 rather than 404: the request
      // is well formed and what refuses it is the STATE of the firm's config,
      // which is fixed on the workflow screen and not by resending this. Same
      // reasoning as ROLE_NOT_DEFINED and AXIS_NOT_ASSIGNABLE.
      case "NO_TEMPLATE_PUBLISHED":
      case "TEMPLATE_UNREADABLE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // The step moved under the caller, or was never theirs to move. Both are
      // conflicts for the same reason: the request said something true a moment
      // ago, and the fix is to look at the job again rather than to retry.
      case "STEP_NOT_WAITING":
      case "STEP_NO_LONGER_NEEDED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // Whose desk a step is on (0301). All conflicts: the request is well
      // formed and what refuses it is the state of the step or the firm's own
      // process, fixed on the job page or the process editor.
      case "NOT_YOUR_STEP":
      case "PERFORMER_OUT_OF_BAND":
      case "STEP_SETTLED":
      case "NOT_STAFF_HERE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // A machine has answered this step and nobody has said whether the answer
      // stands. A conflict, not a 400: the request is well formed and what
      // refuses it is the state of the step, fixed by deciding the proposal
      // rather than by resending this.
      case "PROPOSAL_UNDECIDED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // Nothing produced an answer here, so there is nothing to accept. A 409
      // rather than a 404: the step exists and is perfectly real, it is just
      // finished a different way — with the Done button.
      case "NOTHING_PROPOSED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // A correction identical to the proposal. 409 rather than 400: the body is
      // well formed and what refuses it is the state of the run it is about.
      case "CORRECTION_CHANGED_NOTHING":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // The work is done and waiting for somebody ELSE to look at it (T2.9).
      // 409 for STEP_NOT_WAITING's reason: the request was true a moment ago
      // and the fix is to reload the job, not to resend.
      case "AWAITING_CHECK":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // A step's own list (T6.15). A line the pinned process does not have is
      // a 404, like a step it does not have. Sub-steps still open is the STATE
      // of the step, not the shape of the request: 409, and the message names
      // what is left. A "not applicable" with no reason IS the shape of the
      // request: 400, and the message says what to send.
      case "SUB_STEP_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "SUB_STEPS_OPEN":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "NOT_APPLICABLE_NEEDS_A_REASON":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  // T2.9. The 403 below is the one that matters, and it is why this family has
  // a mapping the day it exists rather than the day somebody opens the page:
  // NOT_ELIGIBLE_TO_CHECK reaching a browser as "internal error" is exactly the
  // fifth bug T2.8 found, and this is the refusal a person meets most often.
  if (err instanceof VerificationError) {
    switch (err.code) {
      case "APPROVAL_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // FORBIDDEN, not CONFLICT. The caller is authenticated and their request
      // is well formed; what refuses it is who they are — they did the work, or
      // they are not senior enough, or they are not the maker's manager. The
      // message says which, because "you cannot check this" with no reason is
      // how somebody concludes the button is broken.
      case "NOT_ELIGIBLE_TO_CHECK":
        return { status: 403, code: "FORBIDDEN", message: err.message, reason: err.code };
      // Somebody else answered first, or the step is not finished yet. Both are
      // the state of the thing, not the shape of the request.
      case "APPROVAL_ALREADY_DECIDED":
      case "CHECK_ALREADY_OPEN":
      case "STEP_NOT_CHECKABLE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // These two ARE the shape of the request: a rejection with no note, and a
      // manager who is not a colleague. 400, and the message names what to send
      // instead.
      case "REJECTION_NEEDS_A_REASON":
      case "REPORTS_TO_NOT_A_COLLEAGUE":
      case "REPORTS_TO_CYCLE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // Review points (T6.15), on the same reasoning as their sub-step twins
      // in the orchestrator family: a line the pinned step does not have is a
      // 404, and points still open when somebody presses Approve is a 409.
      case "REVIEW_POINT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "REVIEW_POINTS_OPEN":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  // FOUND BY RUNNING IT, and it is the third time on this project. The family
  // has existed since T2.6 and had no mapping, because until `GET
  // /api/v1/jobs/{jobId}` there was no route that could raise it — the list
  // never looks a job up. Its first surface answered 500 to an unknown job
  // while its own OpenAPI description promised a 404. Unit tests assert on the
  // thrown sentinel and are perfectly happy; only a real request sees a status
  // code.
  if (err instanceof SchedulerError) {
    switch (err.code) {
      case "JOB_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // The job moved under the caller, or the value is not one the engine
      // knows. Conflicts rather than 400s for the reason the orchestrator's own
      // pair gives: the request said something that was true a moment ago, and
      // the fix is to look at the job again rather than to resend this.
      case "INVALID_TRANSITION":
      case "INVALID_RECURRENCE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  // ── the compliance calendar (T3.2, mapped at T3.3) ───────────────────────
  //
  // THIS FAMILY SHIPPED WITH NO ENTRY HERE, and every refusal it makes has been
  // answering 500 "internal error" since T3.2 — a rule not found, a jurisdiction
  // typed wrong, an exception month already taken. Exactly the failure this
  // file's own header describes `StaffGradeError` having, made a second time,
  // and invisible for the same reason: unit tests assert on the thrown sentinel
  // and are perfectly happy with it.
  //
  // It surfaced while wiring T3.3, whose refusals a partner reads on a screen —
  // "say why" answering 500 with no message would have been the third time.
  if (err instanceof ObligationError) {
    switch (err.code) {
      // Malformed or incoherent on its face: the caller fixes the request.
      //
      // `RESOLUTION_REASON_REQUIRED` is the one a partner meets most, and the
      // one that decides this whole block is worth writing: a decision with no
      // reason is refused, and the sentence saying why has to reach the form
      // rather than a 500 page.
      case "TEMPLATE_NAME_REQUIRED":
      case "INVALID_JURISDICTION":
      case "INVALID_RECURRENCE":
      case "INVALID_FISCAL_YEAR_START":
      case "INVALID_DUE_RULE":
      case "INCOMPLETE_DUE_RULE":
      case "UNRESOLVED_REASON_REQUIRED":
      case "UNRESOLVED_REASON_NOT_ALLOWED":
      case "INVALID_LEAD_TIME":
      case "INVALID_RULE_PACK":
      case "INVALID_RULE_STATUS":
      case "INVALID_CUTOVER":
      case "CUTOVER_BEFORE_START":
      case "SUCCESSOR_NEEDS_ITS_OWN_PACK":
      case "INVALID_PERIOD_END_MONTH":
      case "EXCEPTION_NOTE_REQUIRED":
      case "EXCEPTION_ON_EVENT_RULE":
      case "INVALID_WINDOW":
      case "INVALID_VOCABULARY_CODE":
      case "INVALID_SORT_ORDER":
      case "RESOLUTION_REASON_REQUIRED":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };

      case "TEMPLATE_NOT_FOUND":
      case "EXCEPTION_NOT_FOUND":
      case "SERVICE_NOT_FOUND":
      case "OBLIGATION_NOT_FOUND":
      case "STATE_NOT_FOUND":
      case "RESOLUTION_OPTION_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };

      // Conflicts, on `AXIS_NOT_ASSIGNABLE`'s reasoning: every one of these is
      // a well-formed request refused by the state of the firm's own rows, and
      // the caller fixes it somewhere else rather than by resending this.
      //
      // The four "no X state" cases are here and not 500 deliberately. They
      // ARE a misconfiguration — but one a firm can now cause and now fix from
      // `/admin/obligation-vocabulary`, so the message naming which flag to
      // move has to reach the person who can move it. Before T3.3 there was no
      // screen and no honest answer; a 500 would have been closer to the truth
      // then and is the wrong answer now.
      // `PERIOD_SHAPE_LOCKED` is a 409 and not a 400 on the same reasoning: the
      // request is well formed, and what refuses it is the filings this rule
      // has already produced. The caller fixes it by superseding the rule,
      // which is somewhere else entirely. `ALREADY_SUPERSEDED` is a 409 for the
      // same shape of reason — what refuses it is a handover the firm has
      // already recorded.
      case "TEMPLATE_KEY_TAKEN":
      case "TEMPLATE_RETIRED":
      case "PERIOD_SHAPE_LOCKED":
      case "ALREADY_SUPERSEDED":
      case "EXCEPTION_MONTH_TAKEN":
      case "VOCABULARY_CODE_TAKEN":
      case "NO_INITIAL_STATE":
      case "NO_FILED_STATE":
      case "NO_MISSED_STATE":
      case "NO_RESOLUTION_STATE":
      case "RESOLUTION_OPTION_RETIRED":
      case "ALREADY_DECIDED":
      case "NOT_AWAITING_DECISION":
      case "CONFLICTING_STATE_FLAGS":
      case "LAST_INITIAL_STATE":
      case "LAST_DESTINATION_STATE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof ServiceAxisError) {
    switch (err.code) {
      case "INVALID_AXIS_KIND":
      case "INVALID_AXIS_CODE":
      case "INVALID_AXIS_NAME":
      case "INVALID_WORK_SPLIT_AXIS":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // Both the "no such row" case and the "your service names a Dept this firm
      // never defined" one. The second is a 404 rather than a 400 for the same
      // reason ROLE_NOT_DEFINED is: the request is well formed and what is
      // missing is the firm's own row, which is fixed on another screen.
      case "AXIS_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "AXIS_CODE_TAKEN":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // Conflicts rather than validation failures, on GRADE_NOT_ASSIGNABLE's
      // reasoning: the request is well formed and what refuses it is the state
      // of the firm's LIST. The caller fixes it by reactivating a row or
      // choosing another, not by resending this.
      case "AXIS_NOT_ASSIGNABLE":
      case "WORK_SPLIT_AXIS_EMPTY":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // A VALIDATION failure and not a conflict: nothing about the firm's
      // state refuses this, the value is simply not a zone. Resending a
      // corrected one is the whole fix.
      case "INVALID_TIME_ZONE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof ChaserError) {
    switch (err.code) {
      case "FREEZE_REASON_REQUIRED":
      case "FREEZE_INVALID_DATES":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "FREEZE_CLIENT_NOT_FOUND":
      case "FREEZE_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "FREEZE_ALREADY_IN_FORCE":
      case "FREEZE_ALREADY_LIFTED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof PortalLibraryError) {
    switch (err.code) {
      case "INVALID_MONTH":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof ClientAskError) {
    switch (err.code) {
      case "INVALID_ASK_PROMPT":
      case "INVALID_ASK_KIND":
      case "ASK_DOCUMENT_KIND_MISMATCH":
      case "ASK_DECISION_NOT_WANTED":
      case "ASK_ANSWER_EMPTY":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // 404 AND NOT 403 FOR AN ASK THIS SESSION MAY NOT REACH. The row was
      // filtered by gate 4 in the database, so the service genuinely cannot tell
      // "no such ask" from "another client's ask" — and a 403 would confirm one
      // exists, which is the enumeration the policy was written to prevent.
      case "ASK_NOT_FOUND":
      case "ASK_WORK_ITEM_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "ASK_ALREADY_SETTLED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof ClientRequestError) {
    switch (err.code) {
      case "REQUEST_SUBJECT_EMPTY":
      case "REQUEST_BODY_EMPTY":
      case "REQUEST_REPLY_EMPTY":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // 404 AND NOT 403, twice over and for two different reasons.
      //
      // REQUEST_NOT_FOUND is gate 4 in the database: the service genuinely
      // cannot tell "no such request" from "another client's request", and a
      // 403 would confirm one exists.
      //
      // REQUEST_COMPANY_NOT_YOURS is the same answer for the WRITE that names a
      // company. A 403 there would let a contact enumerate the firm's client
      // list by posting uuids and reading which refusal came back.
      //
      // REQUEST_DOCUMENT_NOT_FOUND is a staff-side refusal and 404 for the
      // ordinary reason: from the firm's side there is no such document filed
      // against this client, and whether it exists elsewhere is not what was
      // asked.
      case "REQUEST_NOT_FOUND":
      case "REQUEST_COMPANY_NOT_YOURS":
      case "REQUEST_DOCUMENT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "REQUEST_ALREADY_SETTLED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // 409 AND NOT 404, matching `ASSIGNMENT_HOLDER_NOT_STAFF` and
      // `ASSIGNEE_NOT_STAFF` — the same refusal, twice already in this codebase,
      // answered the same way. The person EXISTS; saying "no such user" would
      // send somebody hunting a typo in an id that is perfectly good. What is
      // wrong is that they do not work here, which is the firm's roster and is
      // where the fix is.
      case "REQUEST_ASSIGNEE_NOT_STAFF":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "REQUEST_ROUTING_UNKNOWN":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof PortalAccessError) {
    switch (err.code) {
      // Incoherent on its face — a range in force on no day at all. The caller
      // fixes the request, whatever state the firm is in.
      case "INVALID_PORTAL_DATES":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "PORTAL_MEMBERSHIP_NOT_FOUND":
      case "PORTAL_CLIENT_NOT_FOUND":
      case "PORTAL_GRANT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // The request is well formed and the STATE refuses it: a staff login, a
      // revoked one, an archived client, a grant already closed, a duplicate.
      // 409 rather than 400 because nothing about the body is wrong — the
      // caller changes the world, not the request.
      case "PORTAL_MEMBERSHIP_NOT_A_CLIENT_LOGIN":
      case "PORTAL_MEMBERSHIP_INACTIVE":
      case "PORTAL_CLIENT_ARCHIVED":
      case "PORTAL_GRANT_ALREADY_ENDED":
      case "PORTAL_GRANT_DUPLICATE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  // Re-sending a client's invitation. Three states, and every one of them is a
  // well-formed request refused by the firm's own records — the caller fixes it
  // on the contacts list or by picking a different person, never by resending
  // this. The FOURTH refusal on that route ("they already set a password") is
  // an IdentityError, because the password is identity's fact.
  if (err instanceof PortalInviteError) {
    switch (err.code) {
      case "PORTAL_CONTACT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "PORTAL_CONTACT_NOT_A_CLIENT_LOGIN":
      case "PORTAL_CONTACT_INACTIVE":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof ClientImportError) {
    switch (err.code) {
      // The upload itself is wrong — not a spreadsheet, no header row, nothing
      // under it, or no client sheet at all. The caller fixes the file.
      case "SHEET_UNREADABLE":
      case "SHEET_HEADER_MISSING":
      case "SHEET_EMPTY":
      case "CLIENT_SHEET_REQUIRED":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "CLIENT_IMPORT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Confirming what is already loaded, or what the report still refuses.
      case "CLIENT_IMPORT_ALREADY_CONFIRMED":
      case "CLIENT_IMPORT_BLOCKED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }

  if (err instanceof ClientAssignmentError) {
    switch (err.code) {
      // Malformed in shape or incoherent on its face — the caller fixes the
      // request. The two axis rules are here rather than with the conflicts
      // because a SPOC with no Dept and a Key Manager with one are wrong
      // whatever state the firm is in.
      case "INVALID_ASSIGNMENT_ROLE":
      case "INVALID_ASSIGNMENT_DATES":
      case "AXIS_REQUIRED_FOR_SPOC":
      case "AXIS_NOT_ALLOWED_FOR_KEY_MANAGER":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "ASSIGNMENT_CLIENT_NOT_FOUND":
      case "ASSIGNMENT_AXIS_NOT_FOUND":
      case "ASSIGNMENT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Conflicts, on `AXIS_NOT_ASSIGNABLE`'s reasoning: every one of these is
      // a well-formed request refused by the state of the firm's own records —
      // a client it has put away, a Dept it has retired, an assignment that
      // already exists or already ended, a start date the incumbent's own
      // period is in the way of. The caller fixes each on another screen or
      // with another date, never by resending this.
      case "ASSIGNMENT_CLIENT_ARCHIVED":
      case "ASSIGNMENT_AXIS_RETIRED":
      case "ASSIGNMENT_HOLDER_NOT_STAFF":
      case "ASSIGNMENT_ALREADY_ENDED":
      case "ASSIGNMENT_DUPLICATE":
      case "ASSIGNMENT_PREDATES_INCUMBENT":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof WorkItemError) {
    switch (err.code) {
      // Malformed in shape or incoherent on its face — the caller fixes the
      // request. The two flag rules are here rather than with the conflicts
      // because a state that is both terminal and blocked is wrong whatever
      // state the firm is in.
      case "INVALID_VOCABULARY_CODE":
      case "INVALID_RANK":
      case "INVALID_SORT_ORDER":
      case "INVALID_DUE_DATE":
      case "WORK_ITEM_TITLE_REQUIRED":
      case "CONFLICTING_STATE_FLAGS":
      case "BLOCK_REASON_REQUIRED":
      case "REVIEW_REJECTION_NEEDS_NOTE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "WORK_ITEM_NOT_FOUND":
      case "ROUTING_LETTER_NOT_FOUND":
      case "WORK_ITEM_CLIENT_NOT_FOUND":
      case "STATE_NOT_FOUND":
      case "PRIORITY_NOT_FOUND":
      case "CHECKLIST_ITEM_NOT_FOUND":
      case "DEPENDENCY_NOT_FOUND":
      case "REVIEW_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // 403, and these two are the only ones here. Both are a refusal about WHO
      // the caller is rather than about the state of the firm's records — you
      // may not check this work, and you may not check your own — so a caller
      // that retried with a different body would be told the same thing. That
      // is what separates them from the conflicts below.
      case "REVIEW_SELF_APPROVAL":
      case "REVIEWER_NOT_ELIGIBLE":
        return { status: 403, code: "FORBIDDEN", message: err.message, reason: err.code };
      // Conflicts, on `AssignmentDuplicate`'s reasoning: every one is a
      // well-formed request refused by the state of the firm's own records — a
      // client it has put away, a state it has retired, a review somebody else
      // already decided, a dependency that would close a loop, a vocabulary row
      // that is the last of its kind. The caller fixes each on another screen
      // or with another value, never by resending this.
      case "VOCABULARY_CODE_TAKEN":
      case "STATE_RETIRED":
      case "PRIORITY_RETIRED":
      case "NO_INITIAL_STATE":
      case "NO_DEFAULT_PRIORITY":
      case "LAST_INITIAL_STATE":
      case "LAST_DEFAULT_PRIORITY":
      case "WORK_ITEM_CLIENT_ARCHIVED":
      case "ASSIGNEE_NOT_STAFF":
      case "WORK_ITEM_ALREADY_IN_STATE":
      case "WORK_ITEM_BLOCKED_BY_DEPENDENCY":
      case "CHECKLIST_ITEM_DONE":
      case "DEPENDENCY_CYCLE":
      case "DEPENDENCY_EXISTS":
      case "REVIEW_ALREADY_OPEN":
      case "REVIEW_ALREADY_DECIDED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof PartyError) {
    switch (err.code) {
      case "PARTY_NOT_FOUND":
      case "RELATIONSHIP_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Each of these is "the party is not in the state this call assumed", and
      // none is a malformed request. PARTY_HAS_REFERENCES in particular is the
      // firm's own records disagreeing with the request — the caller fixes it
      // by closing what points at the party, not by resending.
      case "DUPLICATE_IDENTIFIER":
      case "PARTY_ALREADY_ARCHIVED":
      case "PARTY_NOT_ARCHIVED":
      case "PARTY_HAS_REFERENCES":
      case "RELATIONSHIP_ALREADY_ENDED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "NOT_AN_ORGANIZATION":
      case "INVALID_IDENTIFIER":
      case "INVALID_IDENTIFIER_TYPE":
      case "INVALID_RELATIONSHIP_TYPE":
      case "INVALID_DATE_RANGE":
      case "RELATIONSHIP_ENDS_BEFORE_IT_BEGAN":
      case "SELF_RELATIONSHIP":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof LeadError) {
    switch (err.code) {
      // Malformed input, all of it: a source or a stage that does not exist, no
      // way to reach the prospect, no name, a close with no explanation, and an
      // explanation attached to a stage that has nothing to explain. None is a
      // statement about the pipeline's current state, so none is a 409.
      case "INVALID_SOURCE":
      case "INVALID_STAGE":
      case "NO_CONTACT_DETAIL":
      case "BLANK_TITLE":
      case "INVALID_LEAD_JURISDICTION":
      case "INVALID_ESTIMATED_VALUE":
      case "NOT_CALLERS_TODAY":
      case "LOST_REASON_REQUIRED":
      case "LOST_REASON_NOT_APPLICABLE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "LEAD_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Each of these is "the pipeline is not in the state this call assumed",
      // and none is a malformed request. AMBIGUOUS_MATCH in particular is a
      // conflict in the firm's own data — the same counterparty stored twice —
      // which the caller resolves by merging those parties, not by resending.
      // PARTY_ARCHIVED (0305) joins them: the party is there and the request
      // is well formed; what refuses it is that the firm put this client away,
      // and it is answered by restoring them.
      //
      // 0086's three join them: a lead already deleted, one that was converted,
      // and one a live proposal was drafted from. Each is where the lead has
      // got to, answered by capturing afresh or by deleting the proposal first.
      case "AMBIGUOUS_MATCH":
      case "LEAD_CLOSED":
      case "SAME_STAGE":
      case "OWNER_NOT_STAFF":
      case "PARTY_ARCHIVED":
      case "LEAD_DELETED":
      case "LEAD_CONVERTED":
      case "LEAD_HAS_PROPOSALS":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // FORBIDDEN, on maker != checker's reasoning: the request is well formed
      // and the lead may be deleted — by an administrator. What refuses it is
      // who the caller is, and retrying with a different body changes nothing.
      case "CLOSED_LEAD_NEEDS_ADMIN":
        return { status: 403, code: "FORBIDDEN", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof ProposalError) {
    switch (err.code) {
      // Malformed input: a number where a decimal string belongs, a currency
      // that is not one, a discount outside 0–100.
      //
      // G1.6's line detail joins them, the two about an unpriced line included:
      // "no price and no reason" and "a discount off no price" are both things
      // the caller SENT, not states the proposal is in, and both are fixed by
      // sending something different. So do 0084's: the wrong KIND of party or
      // account for the cover — a company where a person belongs, somebody who
      // does not work here — each fixed by naming another, and a revision that
      // names nothing to change. And 0085's three: an address that is not one,
      // and — on the client's own page — an answer with no name typed or an
      // acceptance with the statement left unticked. T6.18's line edit adds two
      // more the caller sent: a change naming nothing, and a description emptied —
      // and a currency sent without its rate and the rate's day.
      case "INVALID_QUANTITY":
      case "INVALID_UNIT_AMOUNT":
      case "UNPRICED_LINE_NEEDS_REASON":
      case "UNPRICED_LINE_HAS_DISCOUNT":
      case "INVALID_BILLING_FREQUENCY":
      case "INVALID_LINE_JURISDICTION":
      case "INVALID_OOP_ESTIMATE":
      case "INVALID_DISCOUNT":
      case "INVALID_FX_RATE":
      case "INVALID_CURRENCY":
      case "INVALID_DECISION":
      case "NOT_A_SERVICE":
      case "SERVICE_NOT_PUBLISHED":
      case "ISSUER_NOT_A_FIRM_ENTITY":
      case "ADDRESSEE_NOT_A_PERSON":
      case "PREPARER_NOT_STAFF":
      case "NOTHING_TO_REVISE":
      case "NOTHING_TO_CHANGE_ON_LINE":
      case "INVALID_CURRENCY_CHANGE":
      case "INVALID_LINE_DESCRIPTION":
      case "INVALID_RECIPIENT":
      case "SIGNER_NAME_REQUIRED":
      case "ACCEPTANCE_NOT_CONFIRMED":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // SHARE_LINK_UNKNOWN sits with these on purpose: a link that is
      // malformed, one that is unknown, and one whose proposal has gone all
      // answer the same way. A different status for each would let somebody
      // probing learn which firms exist and which links used to.
      case "PROPOSAL_NOT_FOUND":
      case "LINE_NOT_FOUND":
      case "SERVICE_NOT_FOUND":
      case "SHARE_LINK_UNKNOWN":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // "The proposal is not in the state this call assumed." None is a
      // malformed request and resending changes nothing — DISCOUNT_NEEDS_APPROVAL
      // in particular is answered by a person, not by a retry. ADDRESSEE_NOT_LINKED
      // (0084) is the letter's reading: nothing about the request is wrong — the
      // person's role at the client is missing from the firm's own records.
      // NOT_OUT_FOR_ANSWER and ALREADY_ANSWERED (0085) read the same way:
      // emailing a proposal nobody can answer any more, and a second answer to
      // one already answered, are both about where the proposal has got to.
      // 0086's four read the same way: a draft already deleted, a proposal that
      // went out and so cannot be, one a live letter still cites, and a lead
      // deleted as a mistake that a new proposal named — answered by drafting
      // afresh, answering the client, deleting the letter first, or capturing
      // a real lead. T6.18's two read the same way: a currency change under live
      // lines (answered by removing them) and an issuer change that would
      // replace prose edited for this client (answered by saying so).
      case "NOT_A_DRAFT":
      case "EMPTY_PROPOSAL":
      case "INVALID_TRANSITION":
      case "PROPOSAL_EXPIRED":
      case "DISCOUNT_NEEDS_APPROVAL":
      case "APPROVAL_NOT_NEEDED":
      case "ALREADY_APPROVED":
      case "PARTY_ARCHIVED":
      case "ADDRESSEE_NOT_LINKED":
      case "NOT_OUT_FOR_ANSWER":
      case "ALREADY_ANSWERED":
      case "PROPOSAL_DELETED":
      case "PROPOSAL_NOT_DELETABLE":
      case "PROPOSAL_CITED_BY_LETTER":
      case "LEAD_DELETED":
      case "CURRENCY_LOCKED_BY_LINES":
      case "PROSE_EDITED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // Reachable only from a process composed with no mailer — the worker,
      // which never sends. Said plainly rather than as a 500, the render
      // module's NOT_RENDERABLE habit.
      case "EMAIL_UNAVAILABLE":
        return { status: 501, code: "NOT_IMPLEMENTED", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof EngagementError) {
    switch (err.code) {
      // ADVANCE_AMOUNT_REQUIRED belongs with these rather than with the other
      // advance errors below: "advanceRequired with no amount" is a malformed
      // REQUEST, not a state the letter is in — there is no letter yet. It sat
      // in the wrong group until the end-to-end walk asked for a 400.
      // G1.6's line detail joins these, same reasoning as on a proposal.
      // CLAUSE_LAW_NOT_ISSUERS (G1.8) sits beside CLAUSE_WRONG_JURISDICTION
      // because it is the same kind of answer — this clause, on this letter,
      // no — and the caller fixes it by naming a different clause.
      // QUOTE_JURISDICTION_UNCLEAR (T3.5b) is a FIELD the caller did not send,
      // and the message names the choice. F-10-1's three 400s named the wrong
      // KIND of party and are fixed by naming another: an issuer that is the
      // firm's, a quote to this client, a person rather than a company. Its sibling QUOTE_NAMES_NO_ENTITY is
      // deliberately NOT here: nothing about that request is wrong — the quote
      // is for a prospect holding no entity, which is a fact in the firm's own
      // records and is fixed there. 0083's three are the same kind of answer: a
      // fee group with no title, a grouped line sent with a price of its own,
      // and a line priced on its own sent with none — each fixed by sending a
      // different body.
      case "INVALID_JURISDICTION":
      case "INVALID_AMOUNT":
      case "UNPRICED_LINE_NEEDS_REASON":
      case "UNPRICED_LINE_HAS_DISCOUNT":
      case "INVALID_BILLING_FREQUENCY":
      case "INVALID_OOP_ESTIMATE":
      case "NOT_A_CLAUSE":
      case "CLAUSE_NOT_PUBLISHED":
      case "CLAUSE_WRONG_JURISDICTION":
      case "CLAUSE_LAW_NOT_ISSUERS":
      case "SERVICE_NOT_QUOTABLE":
      case "SIGNATURE_INCOMPLETE":
      case "ADVANCE_AMOUNT_REQUIRED":
      case "INVALID_DATE":
      case "QUOTE_JURISDICTION_UNCLEAR":
      case "ISSUER_NOT_A_FIRM_ENTITY":
      case "QUOTE_OF_ANOTHER_CLIENT":
      case "ADDRESSEE_NOT_A_PERSON":
      case "FEE_GROUP_TITLE_REQUIRED":
      case "GROUPED_LINE_PRICED":
      case "LINE_NOT_PRICED":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // The e-signature provider itself failed (token refused, account not
      // discoverable, malformed answer). This server is healthy and the letter
      // is fine, so it is neither VALIDATION nor INTERNAL — it is the same
      // answer the document store gives when its bucket is unreachable.
      case "SIGNER_UNAVAILABLE":
        return { status: 502, code: "UPSTREAM_FAILURE", message: err.message, reason: err.code };
      case "LETTER_NOT_FOUND":
      case "LETTER_LINE_NOT_FOUND":
      case "CLAUSE_NOT_FOUND":
      case "ENGAGEMENT_NOT_FOUND":
      case "QUOTE_NOT_FOUND":
      case "FEE_GROUP_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // "The letter is not in the state this call assumed." None is a malformed
      // request and resending changes nothing — LETTER_NOT_EDITABLE on a SIGNED
      // letter in particular is answered by drafting a new one, not by retrying.
      // The two supersession refusals belong here for the same reason: one is
      // answered by signing the letter being replaced (or by editing the draft
      // instead), the other by withdrawing the replacement already in place.
      // ISSUER_JURISDICTION_UNKNOWN (G1.8) is here rather than with the 400s
      // for the same reason NO_ISSUING_ENTITY is below: the request is well
      // formed and resending it changes nothing. What is missing is a row in
      // the firm's own records — the issuing entity's registration — and the
      // message names what to add. The three QUOTE_ refusals (T3.5b) are the
      // same shape: a quote in the wrong state, with nothing on it, or naming
      // no company to deliver to. Each is answered somewhere else — by
      // recording the acceptance, by adding lines, or by naming the entity.
      // F-10-1's two here are answered in the firm's OWN RECORDS the same way:
      // the company or the person may really be the client's, and what is
      // missing is the relationship on the client's page that says so. 0083's
      // two — a fee group still covering services, a letter sent with a group
      // covering none — are the letter's STATE, answered by moving services.
      // 0086's three too: a draft already deleted, a letter that went out and
      // so is withdrawn or superseded instead, and a quote deleted as a mistake
      // that a letter tried to cite.
      case "LETTER_NOT_EDITABLE":
      case "LETTER_NOT_SIGNABLE":
      case "EMPTY_LETTER":
      case "NO_CLAUSES":
      case "INVALID_LETTER_TRANSITION":
      case "ADVANCE_NOT_REQUIRED":
      case "ADVANCE_ALREADY_RECORDED":
      case "ENGAGEMENT_NOT_ACTIVE":
      case "ENVELOPE_ALREADY_SIGNED":
      case "SIGNATURE_REQUEST_NOT_PENDING":
      case "LETTER_NOT_SUPERSEDABLE":
      case "ALREADY_SUPERSEDED":
      case "ISSUER_JURISDICTION_UNKNOWN":
      case "QUOTE_NOT_ACCEPTED":
      case "QUOTE_HAS_NO_LINES":
      case "QUOTE_NAMES_NO_ENTITY":
      case "PARTY_ARCHIVED":
      case "ADDRESSEE_NOT_LINKED":
      case "ENTITY_OUTSIDE_CLIENT":
      case "FEE_GROUP_NOT_EMPTY":
      case "FEE_GROUP_EMPTY":
      case "LETTER_DELETED":
      case "LETTER_NOT_DELETABLE":
      case "QUOTE_DELETED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof InvoiceError) {
    switch (err.code) {
      case "INVALID_INVOICE_CURRENCY":
      case "INVALID_INVOICE_AMOUNT":
      case "INVALID_SERIES_PREFIX":
      case "INVALID_INVOICE_DATE":
      case "NOT_CALLERS_TODAY":
      case "INVALID_PAYMENT_METHOD":
      case "INVALID_CREDIT_REASON":
      case "ISSUER_NOT_A_FIRM_ENTITY":
      case "BILLS_THE_FIRM":
      case "ENGAGEMENT_OF_ANOTHER_CLIENT":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "INVOICE_NOT_FOUND":
      case "INVOICE_LINE_NOT_FOUND":
      case "DUNNING_ACTION_NOT_FOUND":
      case "ENGAGEMENT_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // "The invoice is not in the state this call assumed", and none of them is
      // a malformed request. INVOICE_NOT_EDITABLE in particular is answered by
      // cancelling and reissuing, never by retrying — a copy has left the
      // building and, in India, a copy is registered with the government.
      case "INVOICE_NOT_EDITABLE":
      case "EMPTY_INVOICE":
      case "INVALID_INVOICE_TRANSITION":
      case "IRN_ALREADY_REGISTERED":
      case "INVOICE_NOT_ISSUED":
      case "CREDIT_EXCEEDS_INVOICE":
      case "DUNNING_NOT_AWAITING_APPROVAL":
      case "DUNNING_ALREADY_DECIDED":
      case "PARTY_ARCHIVED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof DocumentError) {
    switch (err.code) {
      case "INVALID_JURISDICTION":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "INVALID_BLOCK_KIND":
      case "LETTER_ONLY_BLOCK_KIND":
      case "BLANK_BLOCK_BODY":
      case "INVALID_SORT_ORDER":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "FIRM_ENTITY_NOT_FOUND":
      case "STANDARD_BLOCK_NOT_FOUND":
      case "DOCUMENT_BLOCK_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // NO_ISSUING_ENTITY is a CONFLICT rather than a validation failure: the
      // request is well formed and resending it changes nothing. What is
      // missing is a row in the firm's own configuration, and the message names
      // the call that adds it.
      // DOCUMENT_BLOCK_FROZEN is a CONFLICT and not a FORBIDDEN: the caller is
      // permitted, the request is well formed, and it is the STATE of the
      // document that refuses — resending it changes nothing. DOCUMENT_DELETED
      // (0087) is the same answer about a draft deleted as a mistake.
      case "NO_ISSUING_ENTITY":
      case "BLOCKS_ALREADY_SEEDED":
      case "DOCUMENT_BLOCK_FROZEN":
      case "DOCUMENT_DELETED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof FileStoreError) {
    switch (err.code) {
      case "EMPTY_CONTENT":
      case "UNSUPPORTED_MEDIA_TYPE":
      case "BRAND_ASSET_NOT_DRAWABLE":
      case "INVALID_FILENAME":
      case "INVALID_TITLE":
      case "UNKNOWN_SUBJECT_KIND":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // 413 and not 400. The request is well formed and the caller did nothing
      // wrong in shape — it is the SIZE that is refused, and a client that can
      // tell the two apart can offer "compress this and try again" instead of
      // "invalid file".
      case "CONTENT_TOO_LARGE":
        return { status: 413, code: "PAYLOAD_TOO_LARGE", message: err.message, reason: err.code };
      case "DOCUMENT_NOT_FOUND":
      case "VERSION_NOT_FOUND":
      case "BRAND_ASSET_NOT_FOUND":
      case "LINK_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "ALREADY_ATTACHED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // 502, and this is the one mapping here worth arguing. The metadata is
      // intact and the bytes are gone, so the caller asked for something that
      // SHOULD exist and a system behind us failed to produce it. Answering 404
      // would send whoever reads the log looking for a deleted document; this
      // says plainly that storage lost it.
      case "BYTES_MISSING":
        return { status: 502, code: "UPSTREAM_FAILURE", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof RenderError) {
    switch (err.code) {
      // 422 would be the pedantic answer for UNRENDERABLE_TEXT and this project
      // does not emit it; 400 with the character named is more use than a
      // status nobody's client branches on. The MESSAGE is the actionable part.
      case "UNRENDERABLE_TEXT":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // NOT_IMPLEMENTED, not VALIDATION: the caller asked for something
      // reasonable that this product cannot do YET, and saying so plainly is
      // the honest-registry habit applied to a response.
      case "NOT_RENDERABLE":
        return { status: 501, code: "NOT_IMPLEMENTED", message: err.message, reason: err.code };
      case "SOURCE_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  if (err instanceof ConfigError) {
    switch (err.code) {
      case "INVALID_KIND":
      case "INVALID_KEY":
      case "INVALID_BODY":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "ENTRY_NOT_FOUND":
      case "VERSION_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // All three are "the registry is not in the state this call assumed".
      // WOULD_LOCK_OUT_ADMINISTRATION is a conflict rather than a validation
      // failure on purpose: the body is perfectly valid, and what refuses it is
      // the rest of the firm's role set — the caller fixes it by changing
      // ANOTHER role, not this request.
      case "ENTRY_EXISTS":
      case "VERSION_NOT_DRAFT":
      case "WOULD_LOCK_OUT_ADMINISTRATION":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  // Both authorization failures are 403: the caller is who they say they are
  // and may not do this. `reason` separates a policy decision (NOT_PERMITTED)
  // from a misconfigured membership (UNKNOWN_ROLE) — the second is a firm whose
  // staff are locked out by a typo, and it must not read as normal.
  if (err instanceof AuthzError) {
    return { status: 403, code: "FORBIDDEN", message: err.message, reason: err.code };
  }
  if (err instanceof IdentityError) {
    switch (err.code) {
      // 401: the caller has not proved who they are. Both of these are
      // deliberately vague to the client — the precise reason is server-side.
      case "INVALID_CREDENTIALS":
      case "INVALID_MAGIC_LINK":
      case "SESSION_INVALID":
        return { status: 401, code: "UNAUTHORIZED", message: err.message, reason: err.code };
      // 403: identity is established, the access is not. Saying so is safe —
      // the caller has already proved who they are.
      case "NO_ACTIVE_MEMBERSHIP":
      case "NOT_A_MEMBER":
      case "USER_DISABLED":
        return { status: 403, code: "FORBIDDEN", message: err.message, reason: err.code };
      case "WEAK_PASSWORD":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "TOO_MANY_ATTEMPTS":
        return { status: 429, code: "RATE_LIMITED", message: err.message, reason: err.code };
      // 409: the request is well formed and the STATE refuses it — the contact
      // has already accepted, so there is no invitation left to send again.
      // Not a 403: nothing about the caller's access is wrong.
      case "INVITATION_ALREADY_ACCEPTED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // 400 rather than the 409 above it, and the two are worth telling apart:
      // the invitation case is the STATE refusing a well-formed request, while
      // this one is the request itself — the value in the field is the wrong
      // value, and the fix is to type a different one into the same form.
      case "PASSWORD_UNCHANGED":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      // 409 and not 400: the body is perfectly well formed, and nothing the
      // caller could type into it would make this route work. It is the account
      // that is in the wrong state — no credential to swap — and the fix is a
      // different flow, which the message names.
      case "NO_PASSWORD_SET":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      // 404, and it only ever reaches a provisioning caller — see the error's
      // own note for why naming it is safe there. It answered 500 before, from
      // an unmapped foreign-key violation two layers down.
      case "USER_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      default:
        return unmapped(err.code);
    }
  }
  // A UNIQUE VIOLATION that no check-then-insert caught in time.
  //
  // -- WHY THE CHECKS ARE NOT ENOUGH ON THEIR OWN --------------------------
  //
  // Several writes ask "is there one already?" and then insert, and every one
  // of them is a race: two requests read the same empty answer and both go on
  // to insert. The database is the thing that actually decides, and when it
  // refuses, the caller was getting a 500 — for a duplicate they can see and
  // understand, on a button they most likely double-clicked.
  //
  // `inviteMember` (duplicate membership) and `attach` (duplicate document
  // link) are the two the audit found; the internal `addMember` has no
  // pre-check at all, so for it a duplicate grant was ALWAYS a 500. This maps
  // the class rather than the three cases, because the next check-then-insert
  // will have the same race and nobody will remember to come back here.
  //
  // Deliberately last, after every domain family: a service that has its own
  // word for this conflict (`MembershipExists`, `AlreadyAttached`) has already
  // been matched above and says something far more useful. This is the floor.
  const violation = uniqueViolationOf(err);
  if (violation !== null) {
    return {
      status: 409,
      code: "CONFLICT",
      message:
        "that already exists — something else created it between this request being " +
        "checked and being written",
      reason: violation,
    };
  }

  // A refused event is OUR bug, never the caller's: services build events from
  // their own vocabulary, so an unknown verb or a personal-data payload means
  // this codebase got it wrong. Reporting it as a 400 would blame the client
  // for a defect they cannot fix. It maps to INTERNAL — which the router logs
  // with the full error — and `reason` carries which rule was broken.
  if (err instanceof LedgerError) {
    return { status: 500, code: "INTERNAL", message: "internal error", reason: err.code };
  }
  return { status: 500, code: "INTERNAL", message: "internal error" };
}

/** Hono raises HTTPException with a numeric status; this narrows it into the
 *  closed set the rest of the system speaks. A 4xx we do not name is the
 *  client's fault and reported as VALIDATION; anything else is ours. */
/**
 * The constraint name, when this error is Postgres refusing a duplicate row.
 *
 * Duck-typed rather than `instanceof PostgresError`, and that is on purpose:
 * this module maps MEANINGS to statuses and should not acquire a dependency on
 * which driver is underneath. SQLSTATE 23505 is the standard's code for a
 * unique violation and every driver surfaces it under `.code`.
 *
 * The constraint name goes in `reason` and never in `message` — it is a schema
 * detail, useful in a log and not the caller's business.
 */
function uniqueViolationOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { code?: unknown; constraint_name?: unknown };
  if (candidate.code !== "23505") return null;
  return typeof candidate.constraint_name === "string"
    ? `UNIQUE_VIOLATION:${candidate.constraint_name}`
    : "UNIQUE_VIOLATION";
}

function fromHttpException(err: HTTPException): MappedError {
  switch (err.status) {
    case 400:
      return { status: 400, code: "VALIDATION", message: err.message };
    case 401:
      return { status: 401, code: "UNAUTHORIZED", message: err.message };
    case 403:
      return { status: 403, code: "FORBIDDEN", message: err.message };
    case 404:
      return { status: 404, code: "NOT_FOUND", message: err.message };
    case 409:
      return { status: 409, code: "CONFLICT", message: err.message };
    case 413:
      // The body limit's own refusal, when something throws it rather than
      // answering directly. PAYLOAD_TOO_LARGE and not VALIDATION: the request
      // is well formed and it is the SIZE that is refused, which is the
      // distinction the code was added for.
      return { status: 413, code: "PAYLOAD_TOO_LARGE", message: err.message };
    case 429:
      return { status: 429, code: "RATE_LIMITED", message: err.message };
    default:
      return err.status >= 400 && err.status < 500
        ? { status: 400, code: "VALIDATION", message: err.message }
        : { status: 500, code: "INTERNAL", message: "internal error" };
  }
}
