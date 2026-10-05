// The ports the party use case needs from the world. Interfaces are owned by
// the use case that needs them, stated in our vocabulary; adapters in
// infrastructure/ implement them. Every tenant-scoped write/read is expected to
// run under the RLS context (withTenant) inside the adapter.
import type { ReturnPeriod } from "../../domain/obligation/period-basis";
import type { PostalAddress } from "../../domain/party/address";
import type {
  ClientStructure,
  IdentifierType,
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
} from "../../domain/party/model";

export interface NewOrganization {
  readonly partyId: string;
  readonly tenantId: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly industry: string | null;
  readonly website: string | null;
  readonly displayName: string;
}

export interface NewPerson {
  readonly partyId: string;
  readonly tenantId: string;
  readonly fullName: string;
  readonly nationality: string | null;
  readonly dateOfBirth: string | null;
  readonly displayName: string;
}

export interface NewLegalEntity {
  /** An existing organization's partyId — the FK enforces it is an org. */
  readonly partyId: string;
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly incorporatedOn: string | null;
  readonly financialYearEnd: string | null;
  readonly registeredAddress: Record<string, unknown> | null;
}

/** What a client's master data may be corrected to (V2.5). Absent means
 *  unchanged; null clears an optional field. */
export interface PartyDetailsPatch {
  readonly displayName?: string | undefined;
  readonly tradeName?: string | null | undefined;
  readonly industry?: string | null | undefined;
  readonly website?: string | null | undefined;
  /** Where the party is billed (0334); null clears it. */
  readonly billingAddress?: PostalAddress | null | undefined;
}

export interface PartyRepository {
  /** Correct the display name and, for an organization, its trade name,
   *  industry and website, in one transaction. Null when there is no party. */
  updateDetails(tenantId: string, partyId: string, patch: PartyDetailsPatch): Promise<Party | null>;
  /** Correct a registered company's country and kind. Null when it has no
   *  registration. */
  correctLegalEntity(
    tenantId: string,
    partyId: string,
    patch: { readonly jurisdiction?: string | undefined; readonly entityType?: string | undefined },
  ): Promise<LegalEntity | null>;
  /** A company's return periods as its tax authorities assigned them (0359),
   *  by tax. */
  listReturnPeriods(tenantId: string, partyId: string): Promise<readonly ReturnPeriod[]>;
  /** Record or change one tax's assigned period (one row per tax). */
  setReturnPeriod(tenantId: string, partyId: string, period: ReturnPeriod): Promise<void>;
  /** Take one tax's period off. False when there was none. */
  removeReturnPeriod(tenantId: string, partyId: string, tax: string): Promise<boolean>;
  /** Set a registered company's own zone, or null for its country's (Q070
   *  Part B). Null when it has no registration. */
  setLegalEntityTimeZone(
    tenantId: string,
    partyId: string,
    timeZone: string | null,
  ): Promise<LegalEntity | null>;
  /** Creates the party row and its organization subtype in one transaction. */
  createOrganization(o: NewOrganization): Promise<Organization>;
  /** Creates the party row and its person subtype in one transaction. */
  createPerson(p: NewPerson): Promise<Person>;
  addLegalEntity(e: NewLegalEntity): Promise<LegalEntity>;
  findParty(tenantId: string, partyId: string): Promise<Party | null>;
  findOrganization(tenantId: string, partyId: string): Promise<Organization | null>;
  findPerson(tenantId: string, partyId: string): Promise<Person | null>;
  /**
   * The legal entities registered against an organization.
   *
   * Added because `addLegalEntity` had no counterpart: a jurisdiction, an
   * incorporation date and a financial-year end could be written and then never
   * read back through any route. A write with no read is not a stored fact, it
   * is a discarded one — and the screen that had to render it is what made that
   * obvious.
   */
  listLegalEntities(tenantId: string, partyId: string): Promise<LegalEntity[]>;
  /**
   * The tenant's parties, in display order.
   *
   * ARCHIVED PARTIES ARE ABSENT unless `includeArchived` asks for them. The
   * parameter is required, here AND on `PartyService.listParties`, so that
   * every call site states which list it wants — a default is exactly how "the
   * archive is hidden" quietly stops being true, and a rule stated in a comment
   * that the code next door does not follow is the failure G0.3 was about.
   */
  listParties(tenantId: string, includeArchived: boolean): Promise<Party[]>;

  /**
   * Put a party away, stamping `archived_at` from the database clock, and
   * return it as it now stands.
   *
   * THE REFUSAL IS THE DATABASE'S. `trg_party_archive_guard` (migration 0035,
   * body replaced by 0036) refuses the UPDATE while a lead, proposal, proposal
   * line's entity, engagement letter, letter line's entity or engagement still
   * points at the party — so an import, an agent or a psql session is refused
   * exactly as this call is. An implementation's only job is to translate that
   * refusal into `PartyHasReferences`, carrying the names the database gave it.
   *
   * IT IS ALSO THE TRANSITION, NOT JUST THE WRITE. The caller has already
   * checked the party exists and is live, but a check and a write are two
   * statements with room between them, so an implementation must make the
   * NULL → NOT NULL transition itself atomic and raise `PartyAlreadyArchived`
   * for the loser. The alternative is two `party.archived` events for one
   * archive, in a log that cannot be corrected. `PartyNotFound` if the party is
   * not there at all.
   */
  archive(tenantId: string, partyId: string): Promise<Party>;

  /** Clear `archived_at` and return the party. Nothing refuses this — bringing a
   *  party back can never orphan anything — but it is the same atomic
   *  transition in the other direction, raising `PartyNotArchived` for a caller
   *  that lost the race. */
  unarchive(tenantId: string, partyId: string): Promise<Party>;
}

export interface NewIdentifier {
  readonly id: string;
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  /** Already normalised by the service. */
  readonly value: string;
  readonly jurisdiction: string | null;
  readonly isPrimary: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface IdentifierRepository {
  add(i: NewIdentifier): Promise<PartyIdentifier>;
  listForParty(tenantId: string, partyId: string): Promise<PartyIdentifier[]>;
  findById(tenantId: string, identifierId: string): Promise<PartyIdentifier | null>;
  /** Set the day it stopped being in force; null when it was not open. */
  end(tenantId: string, identifierId: string, validTo: string): Promise<PartyIdentifier | null>;
  /** Void it as a mistake; null when it was already voided. */
  void(tenantId: string, identifierId: string, byUserId: string | null): Promise<PartyIdentifier | null>;
  /** The dedup lookup: matches on (type, normalised value) within the tenant,
   *  among OPEN identifiers only (V2.5): an ended or voided one frees its value. */
  findByValue(tenantId: string, type: IdentifierType, value: string): Promise<PartyIdentifier | null>;
}

export interface NewRelationship {
  readonly id: string;
  readonly tenantId: string;
  readonly fromPartyId: string;
  readonly toPartyId: string;
  readonly type: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly attributes: Record<string, unknown>;
}

/**
 * A relationship with the party at the OTHER end of it.
 *
 * A bare `PartyRelationship` carries `fromPartyId` and `toPartyId`, which is
 * right for the aggregate and useless for anything that has to show it: a
 * screen renders "director_of → 2b9d5209-…". The same joined-read-model shape as
 * `MemberRecord` and `LeadRecord`, for the same reason, and the fifth time this
 * codebase has learnt it.
 *
 * `direction` says which end the party asked about is on, because "Priya is a
 * director of Meridian" and "Meridian has Priya as a director" are the same row
 * read from two sides and a screen has to know which it is looking at.
 */
export interface RelationshipRecord {
  readonly relationship: PartyRelationship;
  readonly counterparty: {
    readonly id: string;
    readonly kind: Party["kind"];
    readonly displayName: string;
  };
  readonly direction: "outgoing" | "incoming";
}

/**
 * One code from `core.relationship_type` — a GLOBAL, product-owned lookup.
 *
 * `label` and `inverseLabel` are the whole reason this is READ and not just
 * validated. The table stores the sentence both ways round because a
 * relationship is one row read from two ends: "Priya is a director of Cobalt
 * Foods" and "Cobalt Foods has director Priya". A screen that only had the
 * code renders `director_of →`, which is what the client page did until this
 * read existed — a raw column name and an arrow, shown to a partner.
 *
 * Not tenant-scoped, so no `tenantId`: the set belongs to the product. A
 * firm-editable set is a later feature and would be a different table.
 */
export interface RelationshipType {
  readonly code: string;
  /** Reads as "{from} is {label} {to}" — "a director of", "the parent of". */
  readonly label: string;
  /** The same row from the other end: "has director", "a subsidiary of". */
  readonly inverseLabel: string;
  /** governance · ownership · employment · commercial. Groups the choices on a
   *  picker without the screen inventing its own grouping. */
  readonly category: string;
}

export interface RelationshipRepository {
  add(r: NewRelationship): Promise<PartyRelationship>;
  /** One relationship by id, tenant-scoped. Read before ending one so the
   *  refusal can name WHY — no such row, already closed, or a date before the
   *  day it began — rather than surfacing a check-constraint violation. */
  find(tenantId: string, relationshipId: string): Promise<PartyRelationship | null>;
  /**
   * Close an OPEN relationship, atomically.
   *
   * `valid_to IS NULL` belongs in the WHERE and not in a check the caller makes
   * first: the read and the write are two statements, so two clicks would
   * otherwise put two `party_relationship.ended` rows in a ledger that can
   * never be corrected. Null means nothing was open to close — the service
   * turns that into the same refusal the pre-read gives, so a race and a repeat
   * read identically.
   */
  endIfOpen(
    tenantId: string,
    relationshipId: string,
    validTo: string,
  ): Promise<PartyRelationship | null>;
  /** relationship_type is a GLOBAL product lookup — a non-tenant read. */
  relationshipTypeExists(code: string): Promise<boolean>;
  /** The whole lookup, for a picker. Also a non-tenant read, and the reason a
   *  screen can say "is the parent of" instead of `parent_of`. */
  listRelationshipTypes(): Promise<RelationshipType[]>;
  /** Every relationship the party is on either side of, each with the party at
   *  the other end — one query, not one per row. */
  listForParty(tenantId: string, partyId: string): Promise<RelationshipRecord[]>;
  /**
   * The client's structure on `onDay` (F-10-1) — see `ClientStructure`. One
   * SQL definition, read both by the letter's pickers and by the refusal a
   * letter gets, so the two cannot disagree.
   */
  structureOf(tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure>;
}
