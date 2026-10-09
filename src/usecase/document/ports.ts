// The document use case's ports; adapters in infrastructure/ implement them.
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
  /** ISO 3166-1 alpha-2, or `*` for the fallback; normalised by the service. */
  readonly clientJurisdiction: string;
  readonly firmEntityPartyId: string;
  readonly note: string | null;
}

/** A preference with the entity by NAME: the screen is country → company, never a column of uuids. */
export interface FirmEntityPreferenceRecord {
  readonly preference: FirmEntityPreference;
  readonly entity: FirmEntity;
}

/**
 * One of the firm's OWN entities: who contracts and where it is registered. `jurisdiction` (from
 * `core.legal_entity`) is NULL for every firm's seeded default entity, since `seedFirmEntity` knows
 * no country at `createTenant`: ordinary, but G1.8's mismatch check needs it, and the preferences
 * screen shows it so a row reads as right or obviously wrong.
 */
export interface FirmEntity {
  readonly id: string;
  readonly displayName: string;
  /** ISO 3166-1 alpha-2, upper case, or null when unregistered. */
  readonly jurisdiction: string | null;
}

export interface FirmEntityPreferenceRepository {
  /** Every row with entity names; one row per country, so no paging. */
  list(tenantId: string): Promise<readonly FirmEntityPreferenceRecord[]>;
  /** The bare rows, for resolving the issuer at drafting. */
  preferences(tenantId: string): Promise<readonly FirmEntityPreference[]>;
  /** Upsert by (tenant, clientJurisdiction): one answer per country is a schema constraint. */
  set(p: NewFirmEntityPreference): Promise<FirmEntityPreference>;
  /** Confirms the party is this firm's, so a bad id is a 404 naming it, not an FK 500. */
  findEntity(tenantId: string, partyId: string): Promise<FirmEntity | null>;
  /**
   * One of the firm's OWN companies (F-10-1): the firm itself, or an issuer some preference row
   * names. Answered by `crm.is_firm_entity` (0306), as the invoice triggers are, so "Charged by",
   * the service refusal and the wall share one definition.
   */
  isFirmEntity(tenantId: string, partyId: string): Promise<boolean>;
}

/**
 * The document-number counter. The adapter advances it in its own committed transaction, so a
 * number given to a draft that then fails is BURNT. Gaps are fine for a reference, never for an
 * invoice number (T3.4), which is therefore not built on this port.
 */
export interface DocumentReferences {
  next(tenantId: string, type: DocumentType, year: number): Promise<number>;
}

// The prose blocks (G1.7)

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

/** Which document a block belongs to: exactly one, mirroring the CHECK on `crm.document_block`. */
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
  /** Every row, retired included, so "where did this line come from" has an answer. */
  list(tenantId: string): Promise<readonly StandardBlock[]>;
  find(tenantId: string, id: string): Promise<StandardBlock | null>;
  add(b: NewStandardBlock): Promise<StandardBlock>;
  edit(tenantId: string, id: string, edit: StandardBlockEdit): Promise<StandardBlock>;
}

export interface DocumentBlockRepository {
  list(tenantId: string, owner: BlockOwner): Promise<readonly DocumentBlock[]>;
  find(tenantId: string, id: string): Promise<DocumentBlock | null>;
  /** The copy, in one INSERT: half the firm's exclusions reads as a deliberate list, worse than none. */
  addMany(blocks: readonly NewDocumentBlock[]): Promise<readonly DocumentBlock[]>;
  add(b: NewDocumentBlock): Promise<DocumentBlock>;
  edit(tenantId: string, id: string, edit: DocumentBlockEdit): Promise<DocumentBlock>;
  /** A line struck off a document before it went out; `bib_app` has no DELETE grant (see the adapter). */
  remove(tenantId: string, id: string): Promise<void>;
}

// The firm's own companies (T6.18)

/**
 * One of the firm's OWN companies for "Our companies" and the issuer picker: `crm.is_firm_entity`'s
 * list (the firm itself and every company a preference row names), with registration and countries.
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
  /** Printed under its name on invoices and letters (audit 2026-10-03, B12 / CA#18), each in force
   *  today or null: tax registration (GSTIN IN, TRN AE, EIN US, VAT elsewhere), PAN (IN), contact. */
  readonly taxRegistration: FirmEntityNumber | null;
  readonly pan: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  /** Its OWN time zone (0337), or null: its documents are dated on the firm's. */
  readonly timeZone: string | null;
  /** Its OWN financial-year start month (0337), or null for the firm's. Stored as
   *  core.legal_entity.financial_year_end (its last day). */
  readonly fiscalYearStartMonth: number | null;
}

/** One of a company's numbers: which kind, and its value. */
export interface FirmEntityNumber {
  readonly type: string;
  readonly value: string;
}

/**
 * A number set or cleared: every in-force identifier of `types` is VOIDED (issued documents froze
 * theirs, 0334), then `set` is added from today. A tax registration's `types` are all four kinds,
 * so a company switching kind cannot keep two.
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

/** A new firm company plus the preference row making it its country's issuer, in ONE transaction. */
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
  /** Its own zone and year end (MM-DD) (0337); null = the firm's. */
  readonly timeZone: string | null;
  readonly fiscalYearEnd: string | null;
}

/** `register` records the country of a company that has none yet; a company never moves country. */
export interface FirmEntityChange {
  readonly name?: string | undefined;
  readonly entityType?: string | undefined;
  readonly registeredAddress?: RegisteredAddress | null | undefined;
  readonly register?: { readonly jurisdiction: string; readonly entityType: string } | undefined;
  /** Numbers set or cleared, in the same transaction (audit 2026-10-03). */
  readonly numbers?: readonly FirmEntityNumberWrite[] | undefined;
  /** Own zone and year end (MM-DD) (0337): an absent key keeps, null reverts to the firm's. */
  readonly calendar?:
    | { readonly timeZone?: string | null | undefined; readonly fiscalYearEnd?: string | null | undefined }
    | undefined;
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
   * Party, organization, legal entity and preference row in ONE transaction (a half-made company
   * would sit in the client list). Writes nothing and answers `{ created: false }` when another
   * company took the country, or `{ taken }` (the kind) when another party holds one of its numbers.
   */
  create(
    e: NewFirmEntity,
  ): Promise<
    | { readonly created: true; readonly numbers: FirmEntityNumbersWritten }
    | { readonly created: false }
    | { readonly taken: string }
  >;
  /** One transaction; `{ taken }` (the kind), nothing written, if another party holds a number it sets. */
  edit(
    tenantId: string,
    partyId: string,
    change: FirmEntityChange,
  ): Promise<{ readonly numbers: FirmEntityNumbersWritten } | { readonly taken: string }>;
}
