// The ports the document use case needs from the world — the seams. Interfaces
// are owned by the use case that needs them, stated in its own vocabulary;
// adapters in infrastructure/ implement them.
import type {
  BlockKind,
  DocumentBlock,
  DocumentType,
  FirmEntityPreference,
  RegisteredAddress,
  StandardBlock,
} from "../../domain/document/model";

export interface NewFirmEntityPreference {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 3166-1 alpha-2, or `*` for the fallback. Normalised by the service
   *  before it gets here. */
  readonly clientJurisdiction: string;
  readonly firmEntityPartyId: string;
  readonly note: string | null;
}

/**
 * A preference with the entity by NAME.
 *
 * The rule CLAUDE.md says has been learnt five times: a screen that would have
 * to fetch something per row to render it means the join belongs in the query.
 * This screen is a table of country → company, and a column of uuids is the one
 * thing it must not be.
 */
export interface FirmEntityPreferenceRecord {
  readonly preference: FirmEntityPreference;
  readonly entity: FirmEntity;
}

/**
 * One of the firm's OWN entities, as the two questions about it are asked
 * together: which company is contracting, and where it is registered.
 *
 * `jurisdiction` comes from `core.legal_entity` and is NULL when the party has
 * no registration recorded — which is the state of every firm's seeded default
 * entity, because `seedFirmEntity` writes an organization and nothing knows the
 * country at `createTenant`. Null is therefore an ordinary answer and not a
 * fault, but it is the answer G1.8's mismatch check cannot work with, so it is
 * carried here rather than looked up separately by whoever needs it.
 *
 * It also belongs on the preferences SCREEN. The rule that table states is "a
 * client in AE is served by this company" — and which country that company is
 * registered in is the fact that makes the row legible or obviously wrong.
 */
export interface FirmEntity {
  readonly id: string;
  readonly displayName: string;
  /** ISO 3166-1 alpha-2, upper case, or null when unregistered. */
  readonly jurisdiction: string | null;
}

export interface FirmEntityPreferenceRepository {
  /** Every row, entity names included. The table is one row per country the
   *  firm has an opinion about, so there is nothing to paginate. */
  list(tenantId: string): Promise<readonly FirmEntityPreferenceRecord[]>;
  /** The bare rows, for the resolution the document modules do at drafting.
   *  Same table, no join — drafting needs the ids and not the names. */
  preferences(tenantId: string): Promise<readonly FirmEntityPreference[]>;
  /** Upsert by (tenant, clientJurisdiction). One answer per country is a
   *  constraint in the schema, so "set" is the only honest verb. */
  set(p: NewFirmEntityPreference): Promise<FirmEntityPreference>;
  /** Confirm the party is this firm's before it is named as an issuer, so a bad
   *  id is a 404 naming the id rather than a foreign-key violation surfacing as
   *  a 500. */
  findEntity(tenantId: string, partyId: string): Promise<FirmEntity | null>;
  /**
   * Whether this party is one of the firm's OWN companies (F-10-1): the firm
   * itself, or a company some preference row names as the issuer for a
   * country. Answered by `crm.is_firm_entity` (0306), the same function the
   * invoice triggers call, so the invoice screen's "Charged by" list, the
   * refusal a service gives and the wall under both are one definition.
   */
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
}

/**
 * The document-number counter.
 *
 * Declared as "give me the next number in this series" rather than "read and
 * write this row", because the SEMANTICS are the point: the adapter advances
 * the counter in its own committed transaction, so a number handed out to a
 * draft that then fails is BURNT. Gaps are honest for a document reference —
 * and are exactly what an invoice number (T3.4) must not have, which is why
 * that one will not be built on this port.
 */
export interface DocumentReferences {
  next(tenantId: string, type: DocumentType, year: number): Promise<number>;
}

// ── The prose blocks (G1.7) ────────────────────────────────────────────────

export interface NewStandardBlock {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: BlockKind;
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
  readonly jurisdiction: string | null;
  /** One of the firm's companies (T6.18), or null for the default set. */
  readonly issuingEntityPartyId: string | null;
}

export interface StandardBlockEdit {
  readonly body?: string | undefined;
  readonly isHeading?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  readonly jurisdiction?: string | null | undefined;
  /** `null` moves it to the default set — a real edit, like `jurisdiction`. */
  readonly issuingEntityPartyId?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

/**
 * Which document a block belongs to. Exactly one of the two, mirroring the
 * CHECK on `crm.document_block` — the type makes the same statement the
 * constraint does, so a caller cannot assemble the row the database refuses.
 */
export type BlockOwner =
  | { readonly kind: "proposal"; readonly id: string }
  | { readonly kind: "engagement_letter"; readonly id: string };

export interface NewDocumentBlock {
  readonly id: string;
  readonly tenantId: string;
  readonly owner: BlockOwner;
  readonly kind: BlockKind;
  readonly body: string;
  readonly isHeading: boolean;
  readonly sortOrder: number;
  readonly sourceId: string | null;
}

export interface DocumentBlockEdit {
  readonly body?: string | undefined;
  readonly isHeading?: boolean | undefined;
  readonly sortOrder?: number | undefined;
}

export interface StandardBlockRepository {
  /** Every row, retired ones included — the firm's own screen has to show what
   *  it stopped printing, or "where did this line come from" has no answer. */
  list(tenantId: string): Promise<readonly StandardBlock[]>;
  find(tenantId: string, id: string): Promise<StandardBlock | null>;
  add(b: NewStandardBlock): Promise<StandardBlock>;
  edit(tenantId: string, id: string, edit: StandardBlockEdit): Promise<StandardBlock>;
}

export interface DocumentBlockRepository {
  list(tenantId: string, owner: BlockOwner): Promise<readonly DocumentBlock[]>;
  find(tenantId: string, id: string): Promise<DocumentBlock | null>;
  /**
   * The COPY, in one statement.
   *
   * One call rather than one per line, because a document that carries half the
   * firm's exclusions is worse than one that carries none: the second is
   * obviously unfinished and the first reads as a deliberate list. The adapter
   * writes them in a single INSERT, so the transaction is the guarantee.
   */
  addMany(blocks: readonly NewDocumentBlock[]): Promise<readonly DocumentBlock[]>;
  add(b: NewDocumentBlock): Promise<DocumentBlock>;
  edit(tenantId: string, id: string, edit: DocumentBlockEdit): Promise<DocumentBlock>;
  /** A line struck off a document before it went out. `bib_app` holds no DELETE
   *  grant, so this is the repository's own concern to express honestly — see
   *  the adapter. */
  remove(tenantId: string, id: string): Promise<void>;
}

// ── The firm's own companies (T6.18) ────────────────────────────────────────

/**
 * One of the firm's OWN companies, as the "Our companies" screen and the
 * builder's issuer picker show it — `crm.is_firm_entity`'s list (the firm
 * itself, and every company a preference row names), with where each is
 * registered and which client countries it issues for.
 */
export interface FirmEntityRecord {
  readonly partyId: string;
  readonly name: string;
  /** Where it is registered — null for a company with no legal-entity row. */
  readonly jurisdiction: string | null;
  readonly entityType: string | null;
  readonly registeredAddress: RegisteredAddress | null;
  /** The organization the firm itself is (`is_firm_self`). */
  readonly isFirmSelf: boolean;
  /** The client countries the firm's rule sends to it, `*` left out. */
  readonly routedCountries: readonly string[];
  /** Whether it answers for every country the firm has no company in (`*`). */
  readonly isFallback: boolean;
  /**
   * What prints under its name on an invoice and a letter (audit 2026-10-03,
   * B12 / CA#18), each the identifier IN FORCE today, or null: its tax
   * registration (a GSTIN in India, a TRN in the UAE, an EIN in the US, a VAT
   * number elsewhere), its PAN (India), and how to reach it.
   */
  readonly taxRegistration: FirmEntityNumber | null;
  readonly pan: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

/** One of a company's numbers: which kind, and its value. */
export interface FirmEntityNumber {
  readonly type: string;
  readonly value: string;
}

/**
 * One of a company's numbers set or cleared. Every identifier of `types` in
 * force on the company is VOIDED (the company form holds the current number,
 * and the documents already out froze theirs, 0334), then `set` is added, in
 * force from today. A tax registration's `types` are all four kinds, so a
 * company changing country's kind of number cannot keep two.
 */
export interface FirmEntityNumberWrite {
  readonly types: readonly string[];
  readonly set: { readonly id: string; readonly type: string; readonly value: string } | null;
}

/** What a write of numbers did, for the events: never the values. */
export interface FirmEntityNumbersWritten {
  readonly added: readonly { readonly id: string; readonly type: string }[];
  readonly voided: readonly { readonly id: string; readonly type: string }[];
}

/** A new company of the firm's, with the preference row that makes it the
 *  issuer for its own country — written in ONE transaction. */
export interface NewFirmEntity {
  readonly partyId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly registeredAddress: RegisteredAddress | null;
  readonly preferenceId: string;
  /** Its numbers, written in the same transaction (audit 2026-10-03). */
  readonly numbers: readonly FirmEntityNumberWrite[];
}

/** A change to one of the firm's companies. `register` records the country of
 *  a company that has none yet — a company does not move country after. */
export interface FirmEntityChange {
  readonly name?: string | undefined;
  readonly entityType?: string | undefined;
  readonly registeredAddress?: RegisteredAddress | null | undefined;
  readonly register?: { readonly jurisdiction: string; readonly entityType: string } | undefined;
  /** Numbers set or cleared, in the same transaction (audit 2026-10-03). */
  readonly numbers?: readonly FirmEntityNumberWrite[] | undefined;
}

export interface FirmEntityRepository {
  list(tenantId: string): Promise<readonly FirmEntityRecord[]>;
  /** One of the firm's companies, or null for any other party or none. */
  find(tenantId: string, partyId: string): Promise<FirmEntityRecord | null>;
  /** Any party's name, for the refusal that says it is not one of ours. */
  partyName(tenantId: string, partyId: string): Promise<string | null>;
  /** The firm's reporting currency (`tenancy.tenant`), for `defaultCurrency`. */
  reportingCurrency(tenantId: string): Promise<string>;
  /** The company the firm's rule sends a client country to, if one does. */
  issuerForCountry(
    tenantId: string,
    country: string,
  ): Promise<{ readonly partyId: string; readonly name: string } | null>;
  /**
   * The party, the organization, the legal entity and the preference row, in
   * ONE transaction — a company half-created would be an organization with no
   * country, or one no rule names, and would sit in the client list. Answers
   * `{ created: false }`, having written nothing, when another company took
   * the country first, and `{ taken }` when another party at the firm already
   * holds one of its numbers (the kind), writing nothing either.
   */
  create(
    e: NewFirmEntity,
  ): Promise<
    | { readonly created: true; readonly numbers: FirmEntityNumbersWritten }
    | { readonly created: false }
    | { readonly taken: string }
  >;
  /** One transaction; `{ taken }` (the kind) and nothing written when another
   *  party at the firm already holds a number it sets. */
  edit(
    tenantId: string,
    partyId: string,
    change: FirmEntityChange,
  ): Promise<{ readonly numbers: FirmEntityNumbersWritten } | { readonly taken: string }>;
}
