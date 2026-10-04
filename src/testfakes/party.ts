// In-memory port fakes for the party use case. Each `implements` its port (a
// compile-time assertion) so business rules can be tested with zero
// infrastructure. They do NOT enforce RLS — tenant isolation is a database
// property, proven separately against real Postgres, not here.
import type {
  ClientStructure,
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
  StructureMember,
} from "../domain/party/model";
import { CONTACT_ROLES, STRUCTURE_HOLDINGS, isInForceOn } from "../domain/party/model";
import {
  PartyAlreadyArchived,
  PartyHasReferences,
  PartyNotArchived,
  PartyNotFound,
} from "../domain/party/errors";
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
  RelationshipType,
} from "../usecase/party/ports";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";

// The seeded relationship_type rows (migration 0002), labels and all — the
// fake answers `listRelationshipTypes` from the same place it answers
// `relationshipTypeExists`, so a test cannot pass against a code the picker
// would never offer.
const RELATIONSHIP_TYPE_ROWS: readonly RelationshipType[] = [
  { code: "client_of", label: "a client of", inverseLabel: "serves", category: "commercial" },
  { code: "employee_of", label: "an employee of", inverseLabel: "employs", category: "employment" },
  {
    code: "authorised_signatory_of",
    label: "an authorised signatory of",
    inverseLabel: "has authorised signatory",
    category: "governance",
  },
  {
    code: "director_of",
    label: "a director of",
    inverseLabel: "has director",
    category: "governance",
  },
  { code: "parent_of", label: "the parent of", inverseLabel: "a subsidiary of", category: "ownership" },
  {
    code: "shareholder_of",
    label: "a shareholder of",
    inverseLabel: "has shareholder",
    category: "ownership",
  },
];
const RELATIONSHIP_TYPES = new Set(RELATIONSHIP_TYPE_ROWS.map((r) => r.code));

export class FakePartyRepo implements PartyRepository {
  parties: Party[] = [];
  readonly organizations: Organization[] = [];
  readonly persons: Person[] = [];
  readonly legalEntities: LegalEntity[] = [];

  updateDetails(
    tenantId: string,
    partyId: string,
    patch: Parameters<PartyRepository["updateDetails"]>[2],
  ): Promise<Party | null> {
    const i = this.parties.findIndex((p) => p.tenantId === tenantId && p.id === partyId);
    const party = this.parties[i];
    if (party === undefined) return Promise.resolve(null);
    const next = {
      ...party,
      displayName: patch.displayName ?? party.displayName,
      billingAddress: patch.billingAddress === undefined ? party.billingAddress : patch.billingAddress,
    };
    this.parties[i] = next;
    const o = this.organizations.findIndex((x) => x.partyId === partyId);
    const org = this.organizations[o];
    if (org !== undefined) {
      this.organizations[o] = {
        ...org,
        tradeName: patch.tradeName === undefined ? org.tradeName : patch.tradeName,
        industry: patch.industry === undefined ? org.industry : patch.industry,
        website: patch.website === undefined ? org.website : patch.website,
      };
    }
    return Promise.resolve(next);
  }

  correctLegalEntity(
    tenantId: string,
    partyId: string,
    patch: { readonly jurisdiction?: string | undefined; readonly entityType?: string | undefined },
  ): Promise<LegalEntity | null> {
    const i = this.legalEntities.findIndex((e) => e.tenantId === tenantId && e.partyId === partyId);
    const entity = this.legalEntities[i];
    if (entity === undefined) return Promise.resolve(null);
    const next = {
      ...entity,
      jurisdiction: patch.jurisdiction ?? entity.jurisdiction,
      entityType: patch.entityType ?? entity.entityType,
    };
    this.legalEntities[i] = next;
    return Promise.resolve(next);
  }

  setLegalEntityTimeZone(tenantId: string, partyId: string, timeZone: string | null): Promise<LegalEntity | null> {
    const i = this.legalEntities.findIndex((e) => e.tenantId === tenantId && e.partyId === partyId);
    const entity = this.legalEntities[i];
    if (entity === undefined) return Promise.resolve(null);
    const next = { ...entity, timeZone };
    this.legalEntities[i] = next;
    return Promise.resolve(next);
  }

  /**
   * What refers to a party, by party id — the thing migration 0035's trigger
   * knows and no in-memory fake can: the crm tables are a different module and
   * this repo does not have them.
   *
   * So the fake models the PORT's contract rather than pretending to reimplement
   * the rule: put names in here and `archive` refuses exactly as the database
   * does. The rule itself is proved where it actually lives, against real
   * Postgres and with raw SQL that never touches this code
   * (`tests/party/archive.integration.test.ts`).
   */
  readonly referrers = new Map<string, readonly string[]>();

  /** The database stamps `archived_at` from its own clock; this stands in for
   *  it, fixed so assertions can name the value. */
  archiveStamp = "2026-08-28T10:00:00.000Z";

  createOrganization(o: NewOrganization): Promise<Organization> {
    this.parties.push({
      id: o.partyId,
      tenantId: o.tenantId,
      kind: "organization",
      displayName: o.displayName,
      archivedAt: null,
      isOwnCompany: false,
      billingAddress: null,
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
      archivedAt: null,
      isOwnCompany: false,
      billingAddress: null,
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
      timeZone: null,
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

  /** Make a party one of the firm's own companies, as a `crm.firm_entity`
   *  row does (0313). */
  markOwnCompany(partyId: string): this {
    this.parties = this.parties.map((p) => (p.id === partyId ? { ...p, isOwnCompany: true } : p));
    return this;
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

  listParties(tenantId: string, includeArchived: boolean): Promise<Party[]> {
    const mine = this.parties.filter((p) => p.tenantId === tenantId);
    return Promise.resolve(includeArchived ? mine : mine.filter((p) => p.archivedAt === null));
  }

  archive(tenantId: string, partyId: string): Promise<Party> {
    const refs = this.referrers.get(partyId);
    if (refs && refs.length > 0) {
      return Promise.reject(new PartyHasReferences(partyId, refs));
    }
    // The port requires the TRANSITION to be atomic, not merely the write: the
    // real adapter gets that from `AND archived_at IS NULL` on the UPDATE, and
    // this refuses on the same condition so the contract reads the same from
    // both sides.
    return this.setArchivedAt(tenantId, partyId, this.archiveStamp);
  }

  unarchive(tenantId: string, partyId: string): Promise<Party> {
    return this.setArchivedAt(tenantId, partyId, null);
  }

  private setArchivedAt(
    tenantId: string,
    partyId: string,
    archivedAt: string | null,
  ): Promise<Party> {
    const party = this.parties.find((p) => p.tenantId === tenantId && p.id === partyId);
    if (!party) return Promise.reject(new PartyNotFound(partyId));
    if (archivedAt !== null && party.archivedAt !== null) {
      return Promise.reject(new PartyAlreadyArchived(partyId));
    }
    if (archivedAt === null && party.archivedAt === null) {
      return Promise.reject(new PartyNotArchived(partyId));
    }
    const updated: Party = { ...party, archivedAt };
    this.parties = this.parties.map((p) => (p === party ? updated : p));
    return Promise.resolve(updated);
  }
}

/** Which parties are archived, for the use cases that refuse to name one on a
 *  new document (0305). A party it has not been told about is not archived —
 *  and a real read would find it live, which is the ordinary case. */
export class FakePartyStanding {
  readonly archived = new Map<string, string>();
  /** Live parties a test has named, with what they are (F-10-1: a letter is
   *  addressed to a PERSON, and refusals name the party). */
  readonly known = new Map<string, { displayName: string; kind: Party["kind"] }>();

  archive(partyId: string, displayName: string): this {
    this.archived.set(partyId, displayName);
    return this;
  }

  know(partyId: string, displayName: string, kind: Party["kind"] = "organization"): this {
    this.known.set(partyId, { displayName, kind });
    return this;
  }

  findParty(
    _tenantId: string,
    partyId: string,
  ): Promise<{
    readonly displayName: string;
    readonly archivedAt: string | null;
    readonly kind: Party["kind"];
  } | null> {
    const name = this.archived.get(partyId);
    if (name !== undefined) {
      return Promise.resolve({
        displayName: name,
        archivedAt: "2026-09-01T00:00:00.000Z",
        kind: this.known.get(partyId)?.kind ?? "organization",
      });
    }
    const live = this.known.get(partyId);
    return Promise.resolve(live === undefined ? null : { ...live, archivedAt: null });
  }
}

/**
 * A client's structure, for the use cases that check a letter against it
 * (F-10-1).
 *
 * A client nobody recorded has the structure a real client with no
 * relationships has: itself, and nobody to address. A test gives a client its
 * companies and people with `record()`. `days` keeps every day it was asked
 * about, so a test can prove the FIRM's day was the one used.
 */
export class FakeClientStructure {
  private readonly recorded = new Map<
    string,
    { entities: readonly string[]; people: readonly string[] }
  >();
  readonly names = new Map<string, string>();
  readonly days: string[] = [];

  record(
    clientPartyId: string,
    structure: { entities?: readonly string[]; people?: readonly string[] },
  ): this {
    this.recorded.set(clientPartyId, {
      entities: structure.entities ?? [],
      people: structure.people ?? [],
    });
    return this;
  }

  structureOf(_tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure> {
    this.days.push(onDay);
    const r = this.recorded.get(clientPartyId);
    const member = (id: string): StructureMember => ({ id, displayName: this.names.get(id) ?? id });
    const entities = [clientPartyId, ...(r?.entities ?? []).filter((e) => e !== clientPartyId)];
    return Promise.resolve({
      entities: entities.map(member),
      people: (r?.people ?? []).map(member),
    });
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
      voidedAt: null,
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
    // OPEN only, as the adapter reads (0315).
    return Promise.resolve(
      this.rows.find(
        (r) =>
          r.tenantId === tenantId && r.type === type && r.value === value &&
          r.voidedAt === null && r.validTo === null,
      ) ?? null,
    );
  }

  findById(tenantId: string, identifierId: string): Promise<PartyIdentifier | null> {
    return Promise.resolve(this.rows.find((r) => r.tenantId === tenantId && r.id === identifierId) ?? null);
  }

  end(tenantId: string, identifierId: string, validTo: string): Promise<PartyIdentifier | null> {
    const i = this.rows.findIndex(
      (r) => r.tenantId === tenantId && r.id === identifierId && r.voidedAt === null && r.validTo === null,
    );
    const row = this.rows[i];
    if (row === undefined) return Promise.resolve(null);
    const next = { ...row, validTo };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  void(tenantId: string, identifierId: string): Promise<PartyIdentifier | null> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === identifierId && r.voidedAt === null);
    const row = this.rows[i];
    if (row === undefined) return Promise.resolve(null);
    const next = { ...row, voidedAt: "2026-09-29T09:00:00.000Z" };
    this.rows[i] = next;
    return Promise.resolve(next);
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

  find(tenantId: string, relationshipId: string): Promise<PartyRelationship | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === relationshipId) ?? null,
    );
  }

  /** The real adapter's guard is `AND valid_to IS NULL` in the WHERE, so the
   *  fake carries it too: a fake that closed an already-closed row would let a
   *  test pass on a race the database refuses. */
  endIfOpen(
    tenantId: string,
    relationshipId: string,
    validTo: string,
  ): Promise<PartyRelationship | null> {
    const i = this.rows.findIndex(
      (r) => r.tenantId === tenantId && r.id === relationshipId && r.validTo === null,
    );
    if (i === -1) return Promise.resolve(null);
    const row = this.rows[i];
    if (!row) return Promise.resolve(null);
    const ended: PartyRelationship = { ...row, validTo };
    this.rows[i] = ended;
    return Promise.resolve(ended);
  }

  relationshipTypeExists(code: string): Promise<boolean> {
    return Promise.resolve(RELATIONSHIP_TYPES.has(code));
  }

  listRelationshipTypes(): Promise<RelationshipType[]> {
    return Promise.resolve([...RELATIONSHIP_TYPE_ROWS]);
  }

  /** The counterparty join the real adapter does in SQL. Set `parties` so the
   *  fake resolves the same names the database would; without it a test would
   *  pass on a read model the product cannot actually produce. */
  parties: FakePartyRepo | null = null;

  /**
   * The same walk the adapter's recursive CTE makes, over the rows in memory:
   * the client, what it holds a stake or a seat in, and everything under those
   * by `parent_of`; then the people with a contact role in any of them. Names,
   * kinds and archiving come from `parties` when set.
   */
  structureOf(tenantId: string, clientPartyId: string, onDay: string): Promise<ClientStructure> {
    const live = this.rows.filter((r) => r.tenantId === tenantId && isInForceOn(r, onDay));
    const party = (id: string): Party | undefined => this.parties?.parties.find((p) => p.id === id);
    const holdings: readonly string[] = STRUCTURE_HOLDINGS;
    const roles: readonly string[] = CONTACT_ROLES;

    const held = new Set<string>([clientPartyId]);
    for (const r of live) {
      if (r.fromPartyId === clientPartyId && holdings.includes(r.type)) held.add(r.toPartyId);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of live) {
        if (r.type === "parent_of" && held.has(r.fromPartyId) && !held.has(r.toPartyId)) {
          held.add(r.toPartyId);
          grew = true;
        }
      }
    }
    const isLive = (id: string): boolean => (party(id)?.archivedAt ?? null) === null;
    const member = (id: string): StructureMember => ({
      id,
      displayName: party(id)?.displayName ?? id,
    });
    const entities = [...held].filter(isLive);
    const people = new Set<string>();
    if (party(clientPartyId)?.kind === "person" && isLive(clientPartyId)) people.add(clientPartyId);
    for (const r of live) {
      if (
        roles.includes(r.type) &&
        held.has(r.toPartyId) &&
        party(r.fromPartyId)?.kind === "person" &&
        isLive(r.fromPartyId)
      ) {
        people.add(r.fromPartyId);
      }
    }
    return Promise.resolve({
      entities: entities.map(member),
      people: [...people].map(member),
    });
  }

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
