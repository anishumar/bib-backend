// In-memory port fakes for the party use case. Each `implements` its port (a
// compile-time assertion) so business rules can be tested with zero
// infrastructure. They do NOT enforce RLS — tenant isolation is a database
// property, proven separately against real Postgres, not here.
import type {
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
} from "../domain/party/model";
import type { Deps } from "../usecase/party/service";
import type {
  IdentifierRepository,
  NewIdentifier,
  NewLegalEntity,
  NewOrganization,
  NewPerson,
  NewRelationship,
  PartyRepository,
  RelationshipRecord,
  RelationshipRepository,
} from "../usecase/party/ports";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

// The seeded relationship_type codes (migration 0002).
const RELATIONSHIP_TYPES = new Set([
  "director_of",
  "authorised_signatory_of",
  "shareholder_of",
  "parent_of",
  "employee_of",
  "client_of",
]);

export class FakePartyRepo implements PartyRepository {
  readonly parties: Party[] = [];
  readonly organizations: Organization[] = [];
  readonly persons: Person[] = [];
  readonly legalEntities: LegalEntity[] = [];

  createOrganization(o: NewOrganization): Promise<Organization> {
    this.parties.push({
      id: o.partyId,
      tenantId: o.tenantId,
      kind: "organization",
      displayName: o.displayName,
    });
    const org: Organization = {
      partyId: o.partyId,
      tenantId: o.tenantId,
      legalName: o.legalName,
      tradeName: o.tradeName,
      industry: o.industry,
      website: o.website,
      isFirmSelf: false,
    };
    this.organizations.push(org);
    return Promise.resolve(org);
  }

  createPerson(p: NewPerson): Promise<Person> {
    this.parties.push({
      id: p.partyId,
      tenantId: p.tenantId,
      kind: "person",
      displayName: p.displayName,
    });
    const person: Person = {
      partyId: p.partyId,
      tenantId: p.tenantId,
      fullName: p.fullName,
      nationality: p.nationality,
      dateOfBirth: p.dateOfBirth,
    };
    this.persons.push(person);
    return Promise.resolve(person);
  }

  addLegalEntity(e: NewLegalEntity): Promise<LegalEntity> {
    const entity: LegalEntity = {
      partyId: e.partyId,
      tenantId: e.tenantId,
      jurisdiction: e.jurisdiction,
      entityType: e.entityType,
      incorporatedOn: e.incorporatedOn,
      financialYearEnd: e.financialYearEnd,
      registeredAddress: e.registeredAddress,
      status: "active",
    };
    this.legalEntities.push(entity);
    return Promise.resolve(entity);
  }

  findParty(tenantId: string, partyId: string): Promise<Party | null> {
    return Promise.resolve(
      this.parties.find((p) => p.tenantId === tenantId && p.id === partyId) ?? null,
    );
  }

  findOrganization(tenantId: string, partyId: string): Promise<Organization | null> {
    return Promise.resolve(
      this.organizations.find((o) => o.tenantId === tenantId && o.partyId === partyId) ?? null,
    );
  }

  findPerson(tenantId: string, partyId: string): Promise<Person | null> {
    return Promise.resolve(
      this.persons.find((p) => p.tenantId === tenantId && p.partyId === partyId) ?? null,
    );
  }

  listLegalEntities(tenantId: string, partyId: string): Promise<LegalEntity[]> {
    return Promise.resolve(
      this.legalEntities.filter((e) => e.tenantId === tenantId && e.partyId === partyId),
    );
  }

  listParties(tenantId: string): Promise<Party[]> {
    return Promise.resolve(this.parties.filter((p) => p.tenantId === tenantId));
  }
}

export class FakeIdentifierRepo implements IdentifierRepository {
  readonly rows: PartyIdentifier[] = [];

  add(i: NewIdentifier): Promise<PartyIdentifier> {
    const row: PartyIdentifier = {
      id: i.id,
      tenantId: i.tenantId,
      partyId: i.partyId,
      type: i.type,
      value: i.value,
      jurisdiction: i.jurisdiction,
      isPrimary: i.isPrimary,
      validFrom: i.validFrom,
      validTo: i.validTo,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listForParty(tenantId: string, partyId: string): Promise<PartyIdentifier[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.partyId === partyId),
    );
  }

  findByValue(
    tenantId: string,
    type: PartyIdentifier["type"],
    value: string,
  ): Promise<PartyIdentifier | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.type === type && r.value === value) ?? null,
    );
  }
}

export class FakeRelationshipRepo implements RelationshipRepository {
  readonly rows: PartyRelationship[] = [];

  add(r: NewRelationship): Promise<PartyRelationship> {
    const row: PartyRelationship = {
      id: r.id,
      tenantId: r.tenantId,
      fromPartyId: r.fromPartyId,
      toPartyId: r.toPartyId,
      type: r.type,
      validFrom: r.validFrom,
      validTo: r.validTo,
      attributes: r.attributes,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  relationshipTypeExists(code: string): Promise<boolean> {
    return Promise.resolve(RELATIONSHIP_TYPES.has(code));
  }

  /** The counterparty join the real adapter does in SQL. Set `parties` so the
   *  fake resolves the same names the database would; without it a test would
   *  pass on a read model the product cannot actually produce. */
  parties: FakePartyRepo | null = null;

  listForParty(tenantId: string, partyId: string): Promise<RelationshipRecord[]> {
    const mine = this.rows.filter(
      (r) => r.tenantId === tenantId && (r.fromPartyId === partyId || r.toPartyId === partyId),
    );
    return Promise.resolve(
      mine.map((r) => {
        const otherId = r.fromPartyId === partyId ? r.toPartyId : r.fromPartyId;
        const other = this.parties?.parties.find((p) => p.id === otherId);
        return {
          relationship: r,
          counterparty: {
            id: otherId,
            kind: other?.kind ?? ("organization" as const),
            displayName: other?.displayName ?? otherId,
          },
          direction: r.fromPartyId === partyId ? ("outgoing" as const) : ("incoming" as const),
        };
      }),
    );
  }
}

export function makePartyFakes(): Deps {
  const parties = new FakePartyRepo();
  const relationships = new FakeRelationshipRepo();
  // The relationship fake resolves counterparty names out of the same in-memory
  // party repo they were created in, so a joined read returns what the database
  // would rather than what this fake invented.
  relationships.parties = parties;
  return {
    parties,
    identifiers: new FakeIdentifierRepo(),
    relationships,
    ids: new FakeIds(),
    events: new RecordingEventSink(),
  };
}
