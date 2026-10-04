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
  | "FIRM_ENTITY_NOT_FOUND"
  | "INVALID_BLOCK_KIND"
  | "LETTER_ONLY_BLOCK_KIND"
  | "BLANK_BLOCK_BODY"
  | "INVALID_SORT_ORDER"
  | "STANDARD_BLOCK_NOT_FOUND"
  | "DOCUMENT_BLOCK_NOT_FOUND"
  | "BLOCKS_ALREADY_SEEDED"
  | "DOCUMENT_BLOCK_FROZEN"
  | "DOCUMENT_DELETED"
  | "NOT_A_FIRM_ENTITY"
  | "INVALID_FIRM_ENTITY"
  | "COUNTRY_ALREADY_SERVED"
  | "JURISDICTION_FIXED"
  | "NOTHING_TO_CHANGE_ON_ENTITY"
  | "INVALID_TIME_ZONE"
  | "INVALID_FISCAL_YEAR_START"
  | "COMPANY_NOT_REGISTERED";

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
      `This firm has not said which of its own entities issues documents` +
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
      `No party ${JSON.stringify(partyId)} at this firm, so it cannot be named as the entity ` +
        `that issues documents. The firm's own entities are parties in its own book: create ` +
        `the organization first.`,
    );
  }
}

// ── The firm's own companies (T6.18) ───────────────────────────────────────

/** A party of this firm that is not one of the firm's OWN companies — a client,
 *  say. Answered as not found: from this route's side, it is not there. */
export class NotAFirmEntity extends DocumentError {
  constructor(displayName: string) {
    super(
      "NOT_A_FIRM_ENTITY",
      `${displayName} is not one of the firm's own companies. Our companies are the firm itself ` +
        `and each company the firm has said issues documents for a country.`,
    );
  }
}

/** A name, type, country or address the firm cannot store as typed. */
export class InvalidFirmEntity extends DocumentError {
  constructor(reason: string) {
    super("INVALID_FIRM_ENTITY", `This company cannot be saved: ${reason}.`);
  }
}

/**
 * A new company for a country another of the firm's companies already issues
 * for. Creating it would silently move every future client there to the new
 * one; that is a decision, and it has its own route.
 */
export class CountryAlreadyServed extends DocumentError {
  constructor(country: string, current: string) {
    super(
      "COUNTRY_ALREADY_SERVED",
      `${current} already issues the firm's documents for clients in ${country}, and each of ` +
        `the firm's companies here is the one for its own country: adding a second company ` +
        `registered in ${country} would take those clients from ${current} without anybody ` +
        `deciding it. If ${current} is being replaced, change its name and details instead.`,
    );
  }
}

/** A company does not move country: its registration is what its documents,
 *  its law and its currency follow from. */
export class JurisdictionFixed extends DocumentError {
  constructor(name: string, jurisdiction: string) {
    super(
      "JURISDICTION_FIXED",
      `${name} is registered in ${jurisdiction}, and a company does not move country. If the ` +
        `firm has a company registered somewhere else, add it as a new company.`,
    );
  }
}

export class NothingToChangeOnEntity extends DocumentError {
  constructor() {
    super(
      "NOTHING_TO_CHANGE_ON_ENTITY",
      "Nothing to change: send at least one of name, entityType, registeredAddress, jurisdiction, " +
        "a number, timeZone or fiscalYearStartMonth.",
    );
  }
}

// ── A company's own year and clock (0337) ──────────────────────────────────

/** The firm card's own refusal (serviceaxis), in this layer's vocabulary: the
 *  trigger on core.legal_entity is the real one, this is the sentence. */
export class InvalidCompanyTimeZone extends DocumentError {
  constructor(value: string) {
    super(
      "INVALID_TIME_ZONE",
      `${JSON.stringify(value)} is not a time zone this system knows. Use an IANA name: ` +
        `"Asia/Dubai", "Asia/Singapore", "America/New_York", or "Asia/Kolkata". It decides the ` +
        `date on this company's invoices and letters, and the day its bills fall due.`,
    );
  }
}

export class InvalidCompanyYearStart extends DocumentError {
  constructor(value: unknown) {
    super(
      "INVALID_FISCAL_YEAR_START",
      `A financial year starts in a month from 1 (January) to 12 (December), not ` +
        `${JSON.stringify(value)}. An Indian company's starts in 4 (April).`,
    );
  }
}

/** The firm's own seeded company has no registration until its country is
 *  recorded, and its year and clock are kept beside that registration. */
export class CompanyNotRegistered extends DocumentError {
  constructor(name: string) {
    super(
      "COMPANY_NOT_REGISTERED",
      `Record where ${name} is registered first. Until then it uses the firm's financial year ` +
        `and time zone.`,
    );
  }
}

// ── The prose blocks (G1.7) ────────────────────────────────────────────────

export class InvalidBlockKind extends DocumentError {
  constructor(given: string, valid: readonly string[]) {
    super(
      "INVALID_BLOCK_KIND",
      `${JSON.stringify(given)} is not a block kind. Valid: ${valid.join(", ")}.`,
    );
  }
}

/** A cover-letter or acceptance line, written onto a proposal (0083). A
 *  proposal has neither, and the database refuses the row too. */
export class LetterOnlyBlockKind extends DocumentError {
  constructor(kind: string) {
    super(
      "LETTER_ONLY_BLOCK_KIND",
      `A proposal has no ${kind === "cover" ? "cover letter" : "acceptance"}: "${kind}" lines ` +
        `belong to an engagement letter, which opens with the firm's cover paragraphs and is ` +
        `accepted by the client's signature. Use an exclusion, a commercial note or a team line ` +
        `on a proposal.`,
    );
  }
}

/**
 * A blank line is refused rather than stored.
 *
 * The database CHECKs `btrim(body) <> ''` too, and both are wanted: an empty
 * line in a printed exclusions list is a gap a reader takes for a missing term,
 * and a whitespace-only one is indistinguishable from it while satisfying any
 * `NOT NULL`.
 */
export class BlankBlockBody extends DocumentError {
  constructor() {
    super(
      "BLANK_BLOCK_BODY",
      "A block's body cannot be blank. An empty line in an exclusions list prints as a gap, " +
        "which a reader takes for a term somebody forgot to write.",
    );
  }
}

export class InvalidSortOrder extends DocumentError {
  constructor(given: number) {
    super(
      "INVALID_SORT_ORDER",
      `A sortOrder must be a positive integer, and this is ${String(given)}. It is the order the line ` +
        `prints in, counted from 1 within its kind.`,
    );
  }
}

export class StandardBlockNotFound extends DocumentError {
  constructor(id: string) {
    super("STANDARD_BLOCK_NOT_FOUND", `No standard block ${JSON.stringify(id)} in this firm.`);
  }
}

export class DocumentBlockNotFound extends DocumentError {
  constructor(id: string) {
    super("DOCUMENT_BLOCK_NOT_FOUND", `No block ${JSON.stringify(id)} on this document.`);
  }
}

/**
 * The seed is once per document, and a second call is refused rather than
 * ignored or repeated.
 *
 * Repeating it would print the firm's exclusions twice. Ignoring it would make
 * "seed this document" mean two different things depending on what happened
 * before, and hide a caller that has lost track of its own state — the same
 * argument the scheduler's derived job id makes, reached from the other end.
 */
/**
 * A block on a letter that has been SIGNED.
 *
 * `crm.refuse_signed_child_change()` is what actually refuses it — the same
 * trigger that freezes the letter's lines and its clauses, firing on this table
 * because it carries `engagement_letter_id`. This class only puts our own
 * sentence round it, exactly as `PartyHasReferences` does for the archive
 * guard, so the rule holds for an import, an agent and a psql session too.
 *
 * IT EXISTED AS A DOCUMENTED 409 AND ANSWERED 500. All three block routes
 * promise "The letter is signed — its prose is frozen with its terms"; nothing
 * threw it, because the service never asks the owning letter's status and the
 * trigger's `restrict_violation` reached the edge untranslated. Nobody found
 * it, because until now the routes had no caller at all.
 */
export class DocumentBlockFrozen extends DocumentError {
  constructor() {
    super(
      "DOCUMENT_BLOCK_FROZEN",
      `This letter is signed, so its prose is frozen with its terms: the database refuses ` +
        `the change, not just this code. The exclusions a client agreed to are part of what ` +
        `they agreed to. Draft a new letter that supersedes it; the old one stays readable ` +
        `as what was actually signed.`,
    );
  }
}

/**
 * A block on a proposal or letter that was DELETED as made by mistake (0086).
 *
 * `crm.refuse_change_under_deleted_document()` (0087) is what refuses it, with
 * its own SQLSTATE so the adapter can tell it from the signed freeze above —
 * which would otherwise have sent somebody to supersede a letter nobody ever
 * sent. Like that one, this class only puts our sentence round the wall.
 */
export class DocumentDeleted extends DocumentError {
  constructor() {
    super(
      "DOCUMENT_DELETED",
      `This draft was deleted as made by mistake, so its wording no longer changes: a deleted ` +
        `draft is final. If the work is real after all, draft a new one.`,
    );
  }
}

export class BlocksAlreadySeeded extends DocumentError {
  constructor(documentId: string, count: number) {
    super(
      "BLOCKS_ALREADY_SEEDED",
      `Document ${JSON.stringify(documentId)} already carries ${String(count)} block(s). The ` +
        `standard set is copied ONCE, at creation; edit the document's own blocks from here.`,
    );
  }
}
