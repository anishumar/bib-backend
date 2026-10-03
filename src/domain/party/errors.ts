// Sentinel errors — the closed vocabulary of ways party operations fail. Owned
// here in the domain; the api layer maps them to HTTP status codes
// (domainerr.ts). Adapters translate their own failures INTO these, never the
// reverse. Match with `instanceof`, never by string.

import { longDay } from "../day";

export class PartyError extends Error {
  constructor(
    readonly code: PartyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type PartyErrorCode =
  | "PARTY_NOT_FOUND"
  | "NOT_AN_ORGANIZATION"
  | "INVALID_IDENTIFIER"
  | "INVALID_IDENTIFIER_TYPE"
  | "INVALID_RELATIONSHIP_TYPE"
  | "RELATIONSHIP_DOES_NOT_FIT"
  | "INVALID_DATE_RANGE"
  | "SELF_RELATIONSHIP"
  | "DUPLICATE_IDENTIFIER"
  | "PARTY_ALREADY_ARCHIVED"
  | "PARTY_NOT_ARCHIVED"
  | "PARTY_HAS_REFERENCES"
  | "RELATIONSHIP_NOT_FOUND"
  | "RELATIONSHIP_ALREADY_ENDED"
  | "RELATIONSHIP_ENDS_BEFORE_IT_BEGAN"
  | "IDENTIFIER_NOT_FOUND"
  | "IDENTIFIER_CLOSED"
  | "INVALID_PARTY_DETAILS"
  | "NOTHING_TO_CHANGE"
  | "NOT_A_LEGAL_ENTITY";

export class PartyNotFound extends PartyError {
  constructor(ref: string) {
    super("PARTY_NOT_FOUND", `No party for ${JSON.stringify(ref)}`);
  }
}
export class NotAnOrganization extends PartyError {
  constructor(ref: string) {
    super(
      "NOT_AN_ORGANIZATION",
      `Party ${JSON.stringify(ref)} is not an organization; a legal entity can only register against one`,
    );
  }
}
/** What a well-formed value of each checked type looks like, said in the
 *  refusal so the person can fix it without asking. */
const IDENTIFIER_EXAMPLE: Readonly<Record<string, string>> = {
  phone: "Write it with the country code, for example +91 98200 12345",
  pan: "A PAN is five letters, four digits and a letter, for example ABCDE1234F",
  gstin: "A GSTIN is 15 characters, for example 27ABCDE1234F1Z5",
  email: "For example name@firm.com",
};
export class InvalidIdentifier extends PartyError {
  constructor(type: string, value: string) {
    const example = IDENTIFIER_EXAMPLE[type];
    const label = type === "phone" || type === "email" ? type : type.toUpperCase();
    super(
      "INVALID_IDENTIFIER",
      `${JSON.stringify(value)} is not a valid ${label}.${example === undefined ? "" : ` ${example}.`}`,
    );
  }
}
export class InvalidIdentifierType extends PartyError {
  constructor(type: string) {
    super("INVALID_IDENTIFIER_TYPE", `Unknown identifier type ${JSON.stringify(type)}`);
  }
}
export class InvalidRelationshipType extends PartyError {
  constructor(type: string) {
    super("INVALID_RELATIONSHIP_TYPE", `Unknown relationship type ${JSON.stringify(type)}`);
  }
}
/**
 * A relationship that cannot be true of these two kinds of party (CA#53): a
 * company as somebody's director, a person as a company's parent. Names the
 * two parties so the reader sees which way round they had it.
 */
export class RelationshipDoesNotFit extends PartyError {
  constructor(
    fromName: string,
    fromKind: "organization" | "person",
    label: string,
    toName: string,
    toKind: "organization" | "person",
  ) {
    const kind = (k: "organization" | "person"): string => (k === "organization" ? "company" : "person");
    super(
      "RELATIONSHIP_DOES_NOT_FIT",
      `"${fromName} is ${label} ${toName}" cannot be true: a ${kind(fromKind)} cannot be ${label} ` +
        `a ${kind(toKind)}. Choose the sentence that is true.`,
    );
  }
}

export class InvalidDateRange extends PartyError {
  constructor(from: string, to: string | null) {
    super(
      "INVALID_DATE_RANGE",
      `Date range ${longDay(from)}..${to === null ? "open" : longDay(to)} is invalid`,
    );
  }
}
export class RelationshipNotFound extends PartyError {
  constructor(ref: string) {
    super("RELATIONSHIP_NOT_FOUND", `No relationship for ${JSON.stringify(ref)}`);
  }
}
/**
 * Closing a relationship that is already closed.
 *
 * A 409 and not a 400: the request is well formed and the firm's own record is
 * what refuses it. It is also NOT a way to correct a wrong end date — that
 * would be a different act with a different event, and this product does not
 * rewrite a date somebody has already been told about. Two clicks on the same
 * button land here, which is the point: the port makes the transition itself
 * atomic, so the loser of a race is refused rather than writing a second
 * `party_relationship.ended` into a log that can never be corrected.
 */
export class RelationshipAlreadyEnded extends PartyError {
  constructor(ref: string, endedOn: string) {
    super(
      "RELATIONSHIP_ALREADY_ENDED",
      `Relationship ${JSON.stringify(ref)} already ended on ${longDay(endedOn)}`,
    );
  }
}
/**
 * The end date is not after the day the relationship began.
 *
 * ── WHY THIS IS NOT `InvalidDateRange` ──────────────────────────────────────
 *
 * It is the same underlying rule and a different SENTENCE, and the sentence is
 * the whole point. `InvalidDateRange` is written for the form that supplies
 * BOTH dates — "Date range 2019-06-11..2019-06-11 is invalid" tells that caller
 * exactly what it did. Somebody CLOSING a relationship supplied one date, and
 * reading their own date back to them twice, joined by dots, says neither what
 * is wrong nor what to type instead. Measured on the screen, which is where a
 * refusal is actually read.
 */
export class RelationshipEndsBeforeItBegan extends PartyError {
  constructor(validFrom: string, validTo: string) {
    super(
      "RELATIONSHIP_ENDS_BEFORE_IT_BEGAN",
      `A relationship cannot end before it began. This one began on ${longDay(validFrom)}, and ` +
        `${longDay(validTo)} is not after that — the end date is the first day it is NO LONGER ` +
        `in force, so the earliest it can be is the day after it began.`,
    );
  }
}
export class SelfRelationship extends PartyError {
  constructor() {
    super("SELF_RELATIONSHIP", "A party cannot hold a relationship to itself");
  }
}
/** What each identifier is called on a screen. */
const IDENTIFIER_WORDS: Readonly<Record<string, string>> = {
  email: "email",
  phone: "phone number",
  pan: "PAN",
  gstin: "GSTIN",
  cin: "CIN",
  llpin: "LLPIN",
  tan: "TAN",
  din: "DIN",
  uen: "UEN",
  trn: "TRN",
  ein: "EIN",
  crn: "CRN",
  vat: "VAT number",
  passport: "passport number",
};

/**
 * The same contact detail is already on another party (CA#20, CA#39).
 *
 * It said "Identifier email ... already exists for this tenant", which names a
 * word no CA firm uses and gives no clue where the email went. It now says who
 * holds it, so the reader can find it and move it (end it there, add it here).
 */
export class DuplicateIdentifier extends PartyError {
  constructor(type: string, value: string, holder?: string | null) {
    const what = IDENTIFIER_WORDS[type] ?? type;
    super(
      "DUPLICATE_IDENTIFIER",
      `The ${what} ${value} is already recorded on ${holder ?? "another client"}. An email, ` +
        `phone or registration number can be on one client or contact at a time.`,
    );
  }
}
export class PartyAlreadyArchived extends PartyError {
  constructor(ref: string) {
    super("PARTY_ALREADY_ARCHIVED", `Party ${JSON.stringify(ref)} is already archived`);
  }
}
export class PartyNotArchived extends PartyError {
  constructor(ref: string) {
    super(
      "PARTY_NOT_ARCHIVED",
      `Party ${JSON.stringify(ref)} is not archived, so there is nothing to restore`,
    );
  }
}
/**
 * Archiving was refused because something still points at the party.
 *
 * The refusal itself is the DATABASE's (migration 0035,
 * `trg_party_archive_guard`) — this is what the adapter translates it into, so
 * the API can name what refers to the party instead of surfacing a raw driver
 * error. Nothing here is a delete: the party stays, and un-archiving is always
 * available.
 */
export class PartyHasReferences extends PartyError {
  constructor(
    ref: string,
    readonly referrers: readonly string[],
  ) {
    super(
      "PARTY_HAS_REFERENCES",
      // Only LIVE references refuse since 0314, and each is named for what it
      // is ("a live engagement"), so the sentence says what to finish first.
      `This client cannot be archived yet: it still has ${referrers.join(", ")}. End its ` +
        `engagements and close or withdraw what is in progress, then archive it.`,
    );
  }
}

// ── Correcting a client's master data (V2.5) ───────────────────────────────

export class IdentifierNotFound extends PartyError {
  constructor(id: string) {
    super("IDENTIFIER_NOT_FOUND", `No identifier ${JSON.stringify(id)} on this client`);
  }
}

/** Already ended or voided: nothing more can happen to it. */
export class IdentifierClosed extends PartyError {
  constructor(how: "ended" | "voided") {
    super(
      "IDENTIFIER_CLOSED",
      how === "voided"
        ? "This identifier was voided as a mistake and cannot change."
        : "This identifier has already ended. Add the correct one instead.",
    );
  }
}

export class InvalidPartyDetails extends PartyError {
  constructor(what: string) {
    super("INVALID_PARTY_DETAILS", what);
  }
}

export class NothingToChange extends PartyError {
  constructor() {
    super("NOTHING_TO_CHANGE", "Nothing changed: every field already says that.");
  }
}

export class NotALegalEntity extends PartyError {
  constructor() {
    super(
      "NOT_A_LEGAL_ENTITY",
      "This client is not registered as a company yet. Register it first, then correct it.",
    );
  }
}
