// Postgres adapter for the party object graph. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement — creating an
// organization inserts the party row and its subtype in ONE transaction under
// one tenant context. Date columns are cast to ::text so they return as ISO
// YYYY-MM-DD strings (postgres.js would otherwise hand back Date objects),
// keeping effective-dating a lexicographic string compare end to end.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  LegalEntity,
  LegalEntityStatus,
  Organization,
  Party,
  PartyKind,
  Person,
} from "../../domain/party/model";
import type {
  NewLegalEntity,
  NewOrganization,
  NewPerson,
  PartyRepository,
} from "../../usecase/party/ports";

interface PartyRow {
  id: string;
  tenant_id: string;
  kind: PartyKind;
  display_name: string;
}
interface OrgRow {
  party_id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  industry: string | null;
  website: string | null;
  is_firm_self: boolean;
}
interface PersonRow {
  party_id: string;
  tenant_id: string;
  full_name: string;
  nationality: string | null;
  date_of_birth: string | null;
}
interface LegalEntityRow {
  party_id: string;
  tenant_id: string;
  jurisdiction: string;
  entity_type: string;
  incorporated_on: string | null;
  financial_year_end: string | null;
  registered_address: Record<string, unknown> | null;
  status: LegalEntityStatus;
}

function toParty(r: PartyRow): Party {
  return { id: r.id, tenantId: r.tenant_id, kind: r.kind, displayName: r.display_name };
}
function toOrg(r: OrgRow): Organization {
  return {
    partyId: r.party_id,
    tenantId: r.tenant_id,
    legalName: r.legal_name,
    tradeName: r.trade_name,
    industry: r.industry,
    website: r.website,
    isFirmSelf: r.is_firm_self,
  };
}
function toPerson(r: PersonRow): Person {
  return {
    partyId: r.party_id,
    tenantId: r.tenant_id,
    fullName: r.full_name,
    nationality: r.nationality,
    dateOfBirth: r.date_of_birth,
  };
}
function toLegalEntity(r: LegalEntityRow): LegalEntity {
  return {
    partyId: r.party_id,
    tenantId: r.tenant_id,
    jurisdiction: r.jurisdiction,
    entityType: r.entity_type,
    incorporatedOn: r.incorporated_on,
    financialYearEnd: r.financial_year_end,
    registeredAddress: r.registered_address,
    status: r.status,
  };
}

export class PostgresPartyRepository implements PartyRepository {
  constructor(private readonly app: Db) {}

  async createOrganization(o: NewOrganization): Promise<Organization> {
    return withTenant(this.app, o.tenantId, async (db) => {
      await db`
        INSERT INTO core.party (id, tenant_id, kind, display_name)
        VALUES (${o.partyId}, ${o.tenantId}, 'organization', ${o.displayName})
      `;
      const [row] = await db<OrgRow[]>`
        INSERT INTO core.organization (party_id, tenant_id, legal_name, trade_name, industry, website)
        VALUES (${o.partyId}, ${o.tenantId}, ${o.legalName}, ${o.tradeName}, ${o.industry}, ${o.website})
        RETURNING party_id, tenant_id, legal_name, trade_name, industry, website, is_firm_self
      `;
      if (!row) throw new Error("organization insert returned no row");
      return toOrg(row);
    });
  }

  async createPerson(p: NewPerson): Promise<Person> {
    return withTenant(this.app, p.tenantId, async (db) => {
      await db`
        INSERT INTO core.party (id, tenant_id, kind, display_name)
        VALUES (${p.partyId}, ${p.tenantId}, 'person', ${p.displayName})
      `;
      const [row] = await db<PersonRow[]>`
        INSERT INTO core.person (party_id, tenant_id, full_name, nationality, date_of_birth)
        VALUES (${p.partyId}, ${p.tenantId}, ${p.fullName}, ${p.nationality}, ${p.dateOfBirth})
        RETURNING party_id, tenant_id, full_name, nationality, date_of_birth::text AS date_of_birth
      `;
      if (!row) throw new Error("person insert returned no row");
      return toPerson(row);
    });
  }

  async addLegalEntity(e: NewLegalEntity): Promise<LegalEntity> {
    return withTenant(this.app, e.tenantId, async (db) => {
      // Hand postgres.js the raw object via db.json so it serialises ONCE — a
      // pre-stringified value plus a ::jsonb cast double-encodes into a JSON
      // string scalar. null stays a SQL NULL.
      const address =
        e.registeredAddress === null
          ? null
          : db.json(e.registeredAddress as Parameters<typeof db.json>[0]);
      const [row] = await db<LegalEntityRow[]>`
        INSERT INTO core.legal_entity
          (party_id, tenant_id, jurisdiction, entity_type, incorporated_on, financial_year_end, registered_address)
        VALUES
          (${e.partyId}, ${e.tenantId}, ${e.jurisdiction}, ${e.entityType},
           ${e.incorporatedOn}, ${e.financialYearEnd}, ${address})
        RETURNING party_id, tenant_id, jurisdiction, entity_type,
                  incorporated_on::text AS incorporated_on, financial_year_end,
                  registered_address, status
      `;
      if (!row) throw new Error("legal_entity insert returned no row");
      return toLegalEntity(row);
    });
  }

  async findParty(tenantId: string, partyId: string): Promise<Party | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PartyRow[]>`
        SELECT id, tenant_id, kind, display_name FROM core.party WHERE id = ${partyId}
      `;
      return row ? toParty(row) : null;
    });
  }

  async findOrganization(tenantId: string, partyId: string): Promise<Organization | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<OrgRow[]>`
        SELECT party_id, tenant_id, legal_name, trade_name, industry, website, is_firm_self
        FROM core.organization WHERE party_id = ${partyId}
      `;
      return row ? toOrg(row) : null;
    });
  }

  async findPerson(tenantId: string, partyId: string): Promise<Person | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PersonRow[]>`
        SELECT party_id, tenant_id, full_name, nationality,
               date_of_birth::text AS date_of_birth
        FROM core.person WHERE party_id = ${partyId}
      `;
      return row ? toPerson(row) : null;
    });
  }

  /** The counterpart `addLegalEntity` never had. Ordered by jurisdiction so an
   *  organization registered in three places reads the same way every time. */
  async listLegalEntities(tenantId: string, partyId: string): Promise<LegalEntity[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<LegalEntityRow[]>`
        SELECT party_id, tenant_id, jurisdiction, entity_type,
               incorporated_on::text AS incorporated_on,
               financial_year_end, registered_address, status
        FROM core.legal_entity
        WHERE party_id = ${partyId}
        ORDER BY jurisdiction
      `;
      return rows.map(toLegalEntity);
    });
  }

  async listParties(tenantId: string): Promise<Party[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<PartyRow[]>`
        SELECT id, tenant_id, kind, display_name FROM core.party ORDER BY display_name
      `;
      return rows.map(toParty);
    });
  }
}
