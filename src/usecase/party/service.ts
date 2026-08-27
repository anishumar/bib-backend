// The party use case — orchestration + business rules against ports. No I/O, no
// SQL, no HTTP: every outside thing is an injected port, so this reads like a
// description of what the business does and is testable with in-memory fakes.
import type { IdGen } from "../../platform/ids";
import type {
  IdentifierType,
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
} from "../../domain/party/model";
import {
  isInForceOn,
  isValidDateRange,
  isValidIdentifier,
  normalizeIdentifier,
} from "../../domain/party/model";
import {
  DuplicateIdentifier,
  InvalidDateRange,
  InvalidIdentifier,
  InvalidRelationshipType,
  NotAnOrganization,
  PartyNotFound,
  SelfRelationship,
} from "../../domain/party/errors";
import type {
  IdentifierRepository,
  PartyRepository,
  RelationshipRepository,
} from "./ports";

export interface Deps {
  readonly parties: PartyRepository;
  readonly identifiers: IdentifierRepository;
  readonly relationships: RelationshipRepository;
  readonly ids: IdGen;
}

// Optional fields are written `?: T | undefined` on purpose: the project runs
// exactOptionalPropertyTypes, and these inputs are spread straight from
// zod-parsed request bodies where an absent field IS `undefined`.
export interface CreateOrganizationInput {
  readonly tenantId: string;
  readonly legalName: string;
  readonly tradeName?: string | undefined;
  readonly industry?: string | undefined;
  readonly website?: string | undefined;
}

export interface CreatePersonInput {
  readonly tenantId: string;
  readonly fullName: string;
  readonly nationality?: string | undefined;
  readonly dateOfBirth?: string | undefined;
}

export interface RegisterLegalEntityInput {
  readonly tenantId: string;
  readonly organizationPartyId: string;
  readonly jurisdiction: string;
  readonly entityType: string;
  readonly incorporatedOn?: string | undefined;
  readonly financialYearEnd?: string | undefined;
  readonly registeredAddress?: Record<string, unknown> | undefined;
}

export interface AddIdentifierInput {
  readonly tenantId: string;
  readonly partyId: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly jurisdiction?: string | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
}

export interface AddRelationshipInput {
  readonly tenantId: string;
  readonly fromPartyId: string;
  readonly toPartyId: string;
  readonly type: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly attributes?: Record<string, unknown> | undefined;
}

export interface PartyProfile {
  readonly party: Party;
  readonly identifiers: readonly PartyIdentifier[];
  readonly relationships: readonly PartyRelationship[];
}

export class PartyService {
  constructor(private readonly deps: Deps) {}

  /** Create an organization party. Display name prefers the trade name, falling
   *  back to the legal name. */
  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    return this.deps.parties.createOrganization({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      industry: input.industry ?? null,
      website: input.website ?? null,
      displayName: input.tradeName?.trim() || input.legalName,
    });
  }

  /** Create a person party. */
  async createPerson(input: CreatePersonInput): Promise<Person> {
    return this.deps.parties.createPerson({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fullName: input.fullName,
      nationality: input.nationality ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      displayName: input.fullName,
    });
  }

  /** Register a legal entity against an existing organization party. Enforced
   *  here and by the DB FK to organization — a person can never be one. */
  async registerLegalEntity(input: RegisterLegalEntityInput): Promise<LegalEntity> {
    const org = await this.deps.parties.findOrganization(input.tenantId, input.organizationPartyId);
    if (!org) throw new NotAnOrganization(input.organizationPartyId);
    return this.deps.parties.addLegalEntity({
      partyId: input.organizationPartyId,
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction.trim().toUpperCase(),
      entityType: input.entityType,
      incorporatedOn: input.incorporatedOn ?? null,
      financialYearEnd: input.financialYearEnd ?? null,
      registeredAddress: input.registeredAddress ?? null,
    });
  }

  /** Attach an identifier (PAN, GSTIN, email…) to a party. Normalises and
   *  shape-validates the value, and rejects a duplicate within the tenant so
   *  the dedup key stays trustworthy. */
  async addIdentifier(input: AddIdentifierInput): Promise<PartyIdentifier> {
    const party = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (!party) throw new PartyNotFound(input.partyId);

    const value = normalizeIdentifier(input.type, input.value);
    if (!isValidIdentifier(input.type, value)) throw new InvalidIdentifier(input.type, input.value);
    if (!isValidDateRange(input.validFrom, input.validTo ?? null)) {
      throw new InvalidDateRange(input.validFrom, input.validTo ?? null);
    }

    const existing = await this.deps.identifiers.findByValue(input.tenantId, input.type, value);
    if (existing) throw new DuplicateIdentifier(input.type, value);

    return this.deps.identifiers.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      partyId: input.partyId,
      type: input.type,
      value,
      jurisdiction: input.jurisdiction ?? null,
      isPrimary: input.isPrimary ?? false,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    });
  }

  /** Record an effective-dated relationship between two parties. */
  async addRelationship(input: AddRelationshipInput): Promise<PartyRelationship> {
    if (input.fromPartyId === input.toPartyId) throw new SelfRelationship();
    if (!isValidDateRange(input.validFrom, input.validTo ?? null)) {
      throw new InvalidDateRange(input.validFrom, input.validTo ?? null);
    }

    const [from, to, typeOk] = await Promise.all([
      this.deps.parties.findParty(input.tenantId, input.fromPartyId),
      this.deps.parties.findParty(input.tenantId, input.toPartyId),
      this.deps.relationships.relationshipTypeExists(input.type),
    ]);
    if (!from) throw new PartyNotFound(input.fromPartyId);
    if (!to) throw new PartyNotFound(input.toPartyId);
    if (!typeOk) throw new InvalidRelationshipType(input.type);

    return this.deps.relationships.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fromPartyId: input.fromPartyId,
      toPartyId: input.toPartyId,
      type: input.type,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      attributes: input.attributes ?? {},
    });
  }

  /** A small Party 360: the party, its identifiers, and its relationships —
   *  optionally filtered to those in force on `asOf` (the compliance question,
   *  "who was a director on 31 March"). */
  async partyProfile(tenantId: string, partyId: string, asOf?: string): Promise<PartyProfile> {
    const party = await this.deps.parties.findParty(tenantId, partyId);
    if (!party) throw new PartyNotFound(partyId);
    const [identifiers, relationships] = await Promise.all([
      this.deps.identifiers.listForParty(tenantId, partyId),
      this.deps.relationships.listForParty(tenantId, partyId),
    ]);
    return {
      party,
      identifiers,
      relationships: asOf ? relationships.filter((r) => isInForceOn(r, asOf)) : relationships,
    };
  }

  async listParties(tenantId: string): Promise<readonly Party[]> {
    return this.deps.parties.listParties(tenantId);
  }

  /** The dedup entry point (phone + PAN + email): find the party holding an
   *  identifier, matching on its normalised value. */
  async findByIdentifier(
    tenantId: string,
    type: IdentifierType,
    value: string,
  ): Promise<PartyIdentifier | null> {
    return this.deps.identifiers.findByValue(tenantId, type, normalizeIdentifier(type, value));
  }
}
