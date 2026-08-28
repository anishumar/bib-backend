// Sentinel errors — the closed vocabulary of ways the document layer fails.
// Owned here in the domain; the api layer maps them to HTTP status codes
// (domainerr.ts). Match with `instanceof`, never by string.

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type DocumentErrorCode =
  | "NO_ISSUING_ENTITY"
  | "INVALID_JURISDICTION"
  | "FIRM_ENTITY_NOT_FOUND";

/**
 * The firm has published no entity that could issue this document.
 *
 * A CONFLICT rather than a validation failure: the request is fine and
 * resending it changes nothing. What is missing is a row in the firm's own
 * configuration, and the message says which one and what it does — because
 * whoever hits this is one POST away from fixing it and should not have to
 * read a migration to find that out.
 */
export class NoIssuingEntity extends DocumentError {
  constructor(clientJurisdiction: string | null) {
    super(
      "NO_ISSUING_ENTITY",
      `this firm has not said which of its own entities issues documents` +
        (clientJurisdiction === null ? "" : ` to clients in ${clientJurisdiction}`) +
        `, and it has no fallback either. A document must name who is contracting: the ` +
        `governing law, the courts and who the client's counterparty actually is all follow ` +
        `from it. Set the fallback with POST /api/v1/firm-entities/preferences ` +
        `{"clientJurisdiction":"*","firmEntityPartyId":"…"}, or name the entity on this ` +
        `document with issuingEntityPartyId.`,
    );
  }
}

export class InvalidJurisdictionKey extends DocumentError {
  constructor(raw: string) {
    super(
      "INVALID_JURISDICTION",
      `${JSON.stringify(raw)} is not a jurisdiction this rule can be keyed on. Use an ISO ` +
        `3166-1 alpha-2 country code (IN, AE, US, SG, GB) or "*" for the fallback that answers ` +
        `for every country the firm has no entity in.`,
    );
  }
}

export class FirmEntityNotFound extends DocumentError {
  constructor(partyId: string) {
    super(
      "FIRM_ENTITY_NOT_FOUND",
      `no party ${JSON.stringify(partyId)} at this firm, so it cannot be named as the entity ` +
        `that issues documents. The firm's own entities are parties in its own book — create ` +
        `the organization first.`,
    );
  }
}
