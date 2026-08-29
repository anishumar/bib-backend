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
import { PartyError } from "../domain/party/errors";
import { LedgerError } from "../domain/ledger/errors";
import { IdentityError } from "../domain/identity/errors";
import { AuthzError } from "../domain/authz/errors";
import { ConfigError } from "../domain/config/errors";
import { LeadError } from "../domain/lead/errors";
import { ProposalError } from "../domain/proposal/errors";
import { EngagementError } from "../domain/engagement/errors";
import { DocumentError } from "../domain/document/errors";

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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP statuses this system emits — a closed set, so it is assignable to
 *  the transport's status type without a cast. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501;

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
  if (err instanceof PartyError) {
    switch (err.code) {
      case "PARTY_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Each of these is "the party is not in the state this call assumed", and
      // none is a malformed request. PARTY_HAS_REFERENCES in particular is the
      // firm's own records disagreeing with the request — the caller fixes it
      // by closing what points at the party, not by resending.
      case "DUPLICATE_IDENTIFIER":
      case "PARTY_ALREADY_ARCHIVED":
      case "PARTY_NOT_ARCHIVED":
      case "PARTY_HAS_REFERENCES":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "NOT_AN_ORGANIZATION":
      case "INVALID_IDENTIFIER":
      case "INVALID_IDENTIFIER_TYPE":
      case "INVALID_RELATIONSHIP_TYPE":
      case "INVALID_DATE_RANGE":
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
      case "LOST_REASON_REQUIRED":
      case "LOST_REASON_NOT_APPLICABLE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "LEAD_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      // Each of these is "the pipeline is not in the state this call assumed",
      // and none is a malformed request. AMBIGUOUS_MATCH in particular is a
      // conflict in the firm's own data — the same counterparty stored twice —
      // which the caller resolves by merging those parties, not by resending.
      case "AMBIGUOUS_MATCH":
      case "LEAD_CLOSED":
      case "SAME_STAGE":
      case "OWNER_NOT_STAFF":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
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
      // sending something different.
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
      // in particular is answered by a person, not by a retry.
      case "NOT_A_DRAFT":
      case "EMPTY_PROPOSAL":
      case "INVALID_TRANSITION":
      case "PROPOSAL_EXPIRED":
      case "DISCOUNT_NEEDS_APPROVAL":
      case "APPROVAL_NOT_NEEDED":
      case "ALREADY_APPROVED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
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
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "LETTER_NOT_FOUND":
      case "LETTER_LINE_NOT_FOUND":
      case "CLAUSE_NOT_FOUND":
      case "ENGAGEMENT_NOT_FOUND":
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
      // message names what to add.
      case "LETTER_NOT_EDITABLE":
      case "LETTER_NOT_SIGNABLE":
      case "EMPTY_LETTER":
      case "NO_CLAUSES":
      case "INVALID_LETTER_TRANSITION":
      case "ADVANCE_NOT_REQUIRED":
      case "ADVANCE_ALREADY_RECORDED":
      case "ENGAGEMENT_NOT_ACTIVE":
      case "LETTER_NOT_SUPERSEDABLE":
      case "ALREADY_SUPERSEDED":
      case "ISSUER_JURISDICTION_UNKNOWN":
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
      case "NO_ISSUING_ENTITY":
      case "BLOCKS_ALREADY_SEEDED":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
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
      default:
        return unmapped(err.code);
    }
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
    case 429:
      return { status: 429, code: "RATE_LIMITED", message: err.message };
    default:
      return err.status >= 400 && err.status < 500
        ? { status: 400, code: "VALIDATION", message: err.message }
        : { status: 500, code: "INTERNAL", message: "internal error" };
  }
}
