// The firm's OWN companies, in Postgres (T6.18).
//
// "One of the firm's companies" is `crm.is_firm_entity` (0306): the firm
// itself, or a company some `crm.firm_entity_preference` row names. The list
// below reads exactly those two sources, so the Our companies screen, the
// issuer picker and every refusal that asks the function agree about who is in.
//
// CREATE IS ONE TRANSACTION, and the reason is the client list: a party and an
// organization written without the preference row that names it are not a
// company of the firm's — they are an organization with no role, and they show
// up among the CLIENTS. The statements are the party and document adapters'
// own (`insertOrganization`, `insertLegalEntity`), run on one held connection.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { readRegisteredAddress } from "../../domain/document/model";
import type { RegisteredAddress } from "../../domain/document/model";
import type {
  FirmEntityChange,
  FirmEntityRecord,
  FirmEntityRepository,
  NewFirmEntity,
} from "../../usecase/document/ports";
import { insertLegalEntity, insertOrganization } from "./party-repository";

interface FirmEntityRow {
  party_id: string;
  name: string;
  is_firm_self: boolean;
  jurisdiction: string | null;
  entity_type: string | null;
  registered_address: unknown;
  routed: string[];
  is_fallback: boolean;
}

function toRecord(r: FirmEntityRow): FirmEntityRecord {
  return {
    partyId: r.party_id,
    name: r.name,
    jurisdiction: r.jurisdiction,
    entityType: r.entity_type,
    registeredAddress: readRegisteredAddress(r.registered_address),
    isFirmSelf: r.is_firm_self,
    routedCountries: r.routed,
    isFallback: r.is_fallback,
  };
}

/** Thrown inside the create transaction to roll it back when another company
 *  took the country first; caught at the door and answered as `false`. */
class CountryTaken extends Error {}

/** The jsonb the address is stored as — `{ "lines": [...] }`. */
function addressJson(db: Db, address: RegisteredAddress | null) {
  return address === null ? null : db.json({ lines: [...address.lines] });
}

export class PostgresFirmEntityRepository implements FirmEntityRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly FirmEntityRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<FirmEntityRow[]>`${this.select(db)}
        -- A picker, so a company the firm put away is not offered.
        WHERE p.archived_at IS NULL
        GROUP BY p.id, p.display_name, o.is_firm_self, le.jurisdiction, le.entity_type,
                 le.registered_address
        HAVING o.is_firm_self OR count(fp.id) > 0
        ORDER BY o.is_firm_self DESC, p.display_name
      `;
      return rows.map(toRecord);
    });
  }

  async find(tenantId: string, partyId: string): Promise<FirmEntityRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<FirmEntityRow[]>`${this.select(db)}
        WHERE p.id = ${partyId}
        GROUP BY p.id, p.display_name, o.is_firm_self, le.jurisdiction, le.entity_type,
                 le.registered_address
        HAVING o.is_firm_self OR count(fp.id) > 0
      `;
      return row ? toRecord(row) : null;
    });
  }

  async partyName(tenantId: string, partyId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ display_name: string }[]>`
        SELECT display_name FROM core.party WHERE id = ${partyId}
      `;
      return row?.display_name ?? null;
    });
  }

  async reportingCurrency(tenantId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ reporting_currency: string }[]>`
        SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
      `;
      if (!row) throw new Error(`tenant ${tenantId} has no row`);
      return row.reporting_currency;
    });
  }

  async issuerForCountry(
    tenantId: string,
    country: string,
  ): Promise<{ readonly partyId: string; readonly name: string } | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ party_id: string; name: string }[]>`
        SELECT fp.firm_entity_party_id AS party_id, p.display_name AS name
        FROM crm.firm_entity_preference fp
        JOIN core.party p ON p.id = fp.firm_entity_party_id
        WHERE fp.client_jurisdiction = ${country}
      `;
      return row ? { partyId: row.party_id, name: row.name } : null;
    });
  }

  async create(e: NewFirmEntity): Promise<boolean> {
    try {
      await withTenant(this.app, e.tenantId, async (db) => {
        await insertOrganization(db, {
          partyId: e.partyId,
          tenantId: e.tenantId,
          legalName: e.name,
          tradeName: null,
          industry: null,
          website: null,
          displayName: e.name,
        });
        await insertLegalEntity(db, {
          partyId: e.partyId,
          tenantId: e.tenantId,
          jurisdiction: e.jurisdiction,
          entityType: e.entityType,
          incorporatedOn: null,
          financialYearEnd: null,
          registeredAddress:
            e.registeredAddress === null ? null : { lines: [...e.registeredAddress.lines] },
        });
        // NOT the preference upsert: this must never move a country another
        // company already issues for. A clash rolls the company back with it.
        const [pref] = await db<{ id: string }[]>`
          INSERT INTO crm.firm_entity_preference
            (id, tenant_id, client_jurisdiction, firm_entity_party_id, note)
          VALUES (${e.preferenceId}, ${e.tenantId}, ${e.jurisdiction}, ${e.partyId}, NULL)
          ON CONFLICT (tenant_id, client_jurisdiction) DO NOTHING
          RETURNING id
        `;
        if (!pref) throw new CountryTaken();
      });
      return true;
    } catch (err) {
      if (err instanceof CountryTaken) return false;
      throw err;
    }
  }

  async edit(tenantId: string, partyId: string, change: FirmEntityChange): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      if (change.name !== undefined) {
        // The name the firm types is its LEGAL name and what every screen shows.
        await db`UPDATE core.party SET display_name = ${change.name} WHERE id = ${partyId}`;
        await db`UPDATE core.organization SET legal_name = ${change.name} WHERE party_id = ${partyId}`;
      }
      if (change.register !== undefined) {
        await insertLegalEntity(db, {
          partyId,
          tenantId,
          jurisdiction: change.register.jurisdiction,
          entityType: change.register.entityType,
          incorporatedOn: null,
          financialYearEnd: null,
          registeredAddress: null,
        });
      }
      if (change.entityType !== undefined) {
        await db`
          UPDATE core.legal_entity SET entity_type = ${change.entityType} WHERE party_id = ${partyId}
        `;
      }
      if (change.registeredAddress !== undefined) {
        await db`
          UPDATE core.legal_entity
             SET registered_address = ${addressJson(db, change.registeredAddress)}
           WHERE party_id = ${partyId}
        `;
      }
    });
  }

  /** The shared head of both reads: `crm.is_firm_entity`'s two sources, with
   *  the registration and the countries the rule sends to each company. */
  private select(db: Db) {
    return db`
      SELECT p.id AS party_id, p.display_name AS name, o.is_firm_self,
             le.jurisdiction, le.entity_type, le.registered_address,
             coalesce(array_agg(fp.client_jurisdiction ORDER BY fp.client_jurisdiction)
                        FILTER (WHERE fp.client_jurisdiction <> '*'), '{}') AS routed,
             coalesce(bool_or(fp.client_jurisdiction = '*'), false) AS is_fallback
      FROM core.party p
      JOIN core.organization o ON o.party_id = p.id
      LEFT JOIN core.legal_entity le ON le.party_id = p.id
      LEFT JOIN crm.firm_entity_preference fp ON fp.firm_entity_party_id = p.id
    `;
  }
}
