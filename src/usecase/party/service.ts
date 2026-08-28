// The party use case — orchestration + business rules against ports. No I/O, no
// SQL, no HTTP: every outside thing is an injected port, so this reads like a
// description of what the business does and is testable with in-memory fakes.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
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
  RelationshipRecord,
  RelationshipRepository,
} from "./ports";

export interface Deps {
  readonly parties: PartyRepository;
  readonly identifiers: IdentifierRepository;
  readonly relationships: RelationshipRepository;
  readonly ids: IdGen;
  /** The audit trail. Every write below records one event naming its actor —
   *  the port, never the ledger service or an adapter (docs/EVENT-CONTRACT.md). */
  readonly events: EventSink;
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

/**
 * Party 360 — everything the firm knows about one counterparty.
 *
 * `organization` and `person` are the subtype detail, and exactly one is set,
 * by kind. They were absent until a screen had to render this: the legal name,
 * the trade name, the industry, the date of birth were all captured at creation
 * and then unreachable through any read, so the detail page could show a
 * display name and nothing else.
 *
 * `legalEntities` is the same story with a sharper edge — `registerLegalEntity`
 * had no counterpart at all, so a jurisdiction and a financial-year end could be
 * written and never read back. A write with no read is not a stored fact.
 */
export interface PartyProfile {
  readonly party: Party;
  readonly organization: Organization | null;
  readonly person: Person | null;
  readonly legalEntities: readonly LegalEntity[];
  readonly identifiers: readonly PartyIdentifier[];
  /** Joined to the party at the other end — see RelationshipRecord. */
  readonly relationships: readonly RelationshipRecord[];
}

export class PartyService {
  constructor(private readonly deps: Deps) {}

  // Every mutating method takes the actor as a second argument rather than
  // folding it into the input DTO: WHO is doing this is orthogonal to WHAT is
  // being done, and keeping it separate means the request shapes stay the
  // shapes the API documents.
  //
  // The event is recorded AFTER the change commits, per the contract — an event
  // must never claim something that was rolled back. If the ledger write then
  // fails the call fails with it, deliberately: a silent gap in an audit trail
  // is the kind of thing discovered in a regulator's meeting, so it is louder
  // to break here than to quietly stop recording.

  /** Create an organization party. Display name prefers the trade name, falling
   *  back to the legal name. */
  async createOrganization(input: CreateOrganizationInput, actor: Actor): Promise<Organization> {
    const org = await this.deps.parties.createOrganization({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      industry: input.industry ?? null,
      website: input.website ?? null,
      displayName: input.tradeName?.trim() || input.legalName,
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.created",
      objectId: org.partyId,
      actor,
      payload: { kind: "organization" },
    });
    return org;
  }

  /** Create a person party. */
  async createPerson(input: CreatePersonInput, actor: Actor): Promise<Person> {
    const person = await this.deps.parties.createPerson({
      partyId: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fullName: input.fullName,
      nationality: input.nationality ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      displayName: input.fullName,
    });
    // The payload names the KIND, never the person. A name is personal data and
    // the ledger cannot be erased; the row it points at can.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party.created",
      objectId: person.partyId,
      actor,
      payload: { kind: "person" },
    });
    return person;
  }

  /** Register a legal entity against an existing organization party. Enforced
   *  here and by the DB FK to organization — a person can never be one. */
  async registerLegalEntity(
    input: RegisterLegalEntityInput,
    actor: Actor,
  ): Promise<LegalEntity> {
    const org = await this.deps.parties.findOrganization(input.tenantId, input.organizationPartyId);
    if (!org) throw new NotAnOrganization(input.organizationPartyId);
    const entity = await this.deps.parties.addLegalEntity({
      partyId: input.organizationPartyId,
      tenantId: input.tenantId,
      jurisdiction: input.jurisdiction.trim().toUpperCase(),
      entityType: input.entityType,
      incorporatedOn: input.incorporatedOn ?? null,
      financialYearEnd: input.financialYearEnd ?? null,
      registeredAddress: input.registeredAddress ?? null,
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "legal_entity.registered",
      objectId: entity.partyId,
      actor,
      payload: { jurisdiction: entity.jurisdiction, entityType: entity.entityType },
    });
    return entity;
  }

  /** Attach an identifier (PAN, GSTIN, email…) to a party. Normalises and
   *  shape-validates the value, and rejects a duplicate within the tenant so
   *  the dedup key stays trustworthy. */
  async addIdentifier(input: AddIdentifierInput, actor: Actor): Promise<PartyIdentifier> {
    const party = await this.deps.parties.findParty(input.tenantId, input.partyId);
    if (!party) throw new PartyNotFound(input.partyId);

    const value = normalizeIdentifier(input.type, input.value);
    if (!isValidIdentifier(input.type, value)) throw new InvalidIdentifier(input.type, input.value);
    if (!isValidDateRange(input.validFrom, input.validTo ?? null)) {
      throw new InvalidDateRange(input.validFrom, input.validTo ?? null);
    }

    const existing = await this.deps.identifiers.findByValue(input.tenantId, input.type, value);
    if (existing) throw new DuplicateIdentifier(input.type, value);

    const identifier = await this.deps.identifiers.add({
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
    // The TYPE of identifier, never the value. A PAN or a passport number in an
    // un-erasable log is precisely what the contract's no-PII rule is about —
    // and note the denylist would not have caught it under the key "value".
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party_identifier.added",
      objectId: identifier.id,
      actor,
      payload: { partyId: input.partyId, identifierType: input.type },
    });
    return identifier;
  }

  /** Record an effective-dated relationship between two parties. */
  async addRelationship(input: AddRelationshipInput, actor: Actor): Promise<PartyRelationship> {
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

    const relationship = await this.deps.relationships.add({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      fromPartyId: input.fromPartyId,
      toPartyId: input.toPartyId,
      type: input.type,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      attributes: input.attributes ?? {},
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "party_relationship.recorded",
      objectId: relationship.id,
      actor,
      payload: {
        fromPartyId: relationship.fromPartyId,
        toPartyId: relationship.toPartyId,
        relationshipType: relationship.type,
        validFrom: relationship.validFrom,
      },
    });
    return relationship;
  }

  /** A small Party 360: the party, its identifiers, and its relationships —
   *  optionally filtered to those in force on `asOf` (the compliance question,
   *  "who was a director on 31 March"). */
  async partyProfile(tenantId: string, partyId: string, asOf?: string): Promise<PartyProfile> {
    const party = await this.deps.parties.findParty(tenantId, partyId);
    if (!party) throw new PartyNotFound(partyId);

    // The subtype is fetched by KIND rather than both-and-discard: a person has
    // no organization row and asking for one is a query that can only ever
    // return nothing.
    const [organization, person, legalEntities, identifiers, relationships] = await Promise.all([
      party.kind === "organization"
        ? this.deps.parties.findOrganization(tenantId, partyId)
        : Promise.resolve(null),
      party.kind === "person"
        ? this.deps.parties.findPerson(tenantId, partyId)
        : Promise.resolve(null),
      party.kind === "organization"
        ? this.deps.parties.listLegalEntities(tenantId, partyId)
        : Promise.resolve([]),
      this.deps.identifiers.listForParty(tenantId, partyId),
      this.deps.relationships.listForParty(tenantId, partyId),
    ]);

    return {
      party,
      organization,
      person,
      legalEntities,
      identifiers,
      relationships: asOf
        ? relationships.filter((r) => isInForceOn(r.relationship, asOf))
        : relationships,
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
