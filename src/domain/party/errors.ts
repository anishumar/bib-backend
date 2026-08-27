// Sentinel errors — the closed vocabulary of ways party operations fail. Owned
// here in the domain; the api layer maps them to HTTP status codes
// (domainerr.ts). Adapters translate their own failures INTO these, never the
// reverse. Match with `instanceof`, never by string.

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
  | "DUPLICATE_IDENTIFIER";

export class PartyNotFound extends PartyError {
  constructor(ref: string) {
    super("PARTY_NOT_FOUND", `no party for ${JSON.stringify(ref)}`);
  }
}
export class NotAnOrganization extends PartyError {
  constructor(ref: string) {
    super(
      "NOT_AN_ORGANIZATION",
      `party ${JSON.stringify(ref)} is not an organization; a legal entity can only register against one`,
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
    super("INVALID_IDENTIFIER_TYPE", `unknown identifier type ${JSON.stringify(type)}`);
  }
}
export class InvalidRelationshipType extends PartyError {
  constructor(type: string) {
    super("INVALID_RELATIONSHIP_TYPE", `unknown relationship type ${JSON.stringify(type)}`);
  }
}
export class InvalidDateRange extends PartyError {
  constructor(from: string, to: string | null) {
    super("INVALID_DATE_RANGE", `date range ${from}..${to ?? "open"} is invalid`);
  }
}
export class SelfRelationship extends PartyError {
  constructor() {
    super("SELF_RELATIONSHIP", "a party cannot hold a relationship to itself");
  }
}
export class DuplicateIdentifier extends PartyError {
  constructor(type: string, value: string) {
    super(
      "DUPLICATE_IDENTIFIER",
      `identifier ${type} ${JSON.stringify(value)} already exists for this tenant`,
    );
  }
}
