// The ports the party use case needs from the world. Interfaces are owned by
// the use case that needs them, stated in our vocabulary; adapters in
// infrastructure/ implement them. Every tenant-scoped write/read is expected to
// run under the RLS context (withTenant) inside the adapter.
import type {
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

export interface PartyRepository {
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
  listParties(tenantId: string): Promise<Party[]>;
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
  /** The dedup lookup: matches on (type, normalised value) within the tenant. */
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

export interface RelationshipRepository {
  add(r: NewRelationship): Promise<PartyRelationship>;
  /** relationship_type is a GLOBAL product lookup — a non-tenant read. */
  relationshipTypeExists(code: string): Promise<boolean>;
  /** Every relationship the party is on either side of, each with the party at
   *  the other end — one query, not one per row. */
  listForParty(tenantId: string, partyId: string): Promise<RelationshipRecord[]>;
}
