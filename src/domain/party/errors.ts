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
  | "INVALID_DATE_RANGE"
  | "SELF_RELATIONSHIP"
  | "DUPLICATE_IDENTIFIER"
  | "PARTY_ALREADY_ARCHIVED"
  | "PARTY_NOT_ARCHIVED"
  | "PARTY_HAS_REFERENCES"
  | "RELATIONSHIP_NOT_FOUND"
  | "RELATIONSHIP_ALREADY_ENDED"
  | "RELATIONSHIP_ENDS_BEFORE_IT_BEGAN";

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
export class InvalidIdentifier extends PartyError {
  constructor(type: string, value: string) {
    super("INVALID_IDENTIFIER", `${JSON.stringify(value)} is not a valid ${type}`);
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
export class DuplicateIdentifier extends PartyError {
  constructor(type: string, value: string) {
    super(
      "DUPLICATE_IDENTIFIER",
      `Identifier ${type} ${JSON.stringify(value)} already exists for this tenant`,
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
      `Party ${JSON.stringify(ref)} cannot be archived: it is still referenced by ${referrers.join(", ")}`,
    );
  }
}
