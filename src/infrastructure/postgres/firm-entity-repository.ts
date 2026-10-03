// The firm's OWN companies, in Postgres (T6.18).
//
// "One of the firm's companies" is `crm.is_firm_entity`: the firm itself, or a
// live member of `crm.firm_entity` (0313; before it, any company a routing row
// named, which let a company vanish when its last country moved). The list
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
  FirmEntityNumberWrite,
  FirmEntityNumbersWritten,
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
  tax_registration: { type: string; value: string } | null;
  pan: string | null;
  phone: string | null;
  email: string | null;
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
    taxRegistration: r.tax_registration,
    pan: r.pan,
    phone: r.phone,
    email: r.email,
  };
}

/** Thrown inside a write to roll it back when another party at the firm
 *  already holds a number it sets; caught at the door and answered. */
class NumberTaken extends Error {
  constructor(readonly type: string) {
    super(`a ${type} is already held by another party`);
  }
}

/**
 * A company's numbers set or cleared, on one held connection (audit
 * 2026-10-03): refused (rolled back) when another party at the firm holds the
 * value; every number of the write's kinds in force on the company VOIDED;
 * the new one added, in force from the firm's today.
 */
async function writeNumbers(
  db: Db,
  tenantId: string,
  partyId: string,
  numbers: readonly FirmEntityNumberWrite[],
): Promise<FirmEntityNumbersWritten> {
  const added: { id: string; type: string }[] = [];
  const voided: { id: string; type: string }[] = [];
  for (const n of numbers) {
    if (n.set !== null) {
      const [held] = await db<{ one: number }[]>`
        SELECT 1 AS one FROM core.party_identifier
         WHERE type = ${n.set.type} AND value = ${n.set.value}
           AND voided_at IS NULL AND party_id <> ${partyId}
         LIMIT 1
      `;
      if (held !== undefined) throw new NumberTaken(n.set.type);
    }
    const gone = await db<{ id: string; type: string }[]>`
      UPDATE core.party_identifier SET voided_at = now()
       WHERE party_id = ${partyId} AND type = ANY(${[...n.types]}::text[]) AND voided_at IS NULL
      RETURNING id, type
    `;
    voided.push(...gone.map((g) => ({ id: g.id, type: g.type })));
    if (n.set !== null) {
      await db`
        INSERT INTO core.party_identifier (id, tenant_id, party_id, type, value, valid_from)
        SELECT ${n.set.id}, ${tenantId}, ${partyId}, ${n.set.type}, ${n.set.value},
               (now() AT TIME ZONE t.time_zone)::date
          FROM tenancy.tenant t WHERE t.id = ${tenantId}
      `;
      added.push({ id: n.set.id, type: n.set.type });
    }
  }
  return { added, voided };
}

/** Thrown inside the create transaction to roll it back when another company
 *  took the country first; caught at the door and answered as `false`. */
class CountryTaken extends Error {}

/** The jsonb the address is stored as: `{ "lines": [...] }`, with `region`
 *  and `postalCode` when the firm typed them (audit 2026-10-03). */
function addressJson(db: Db, address: RegisteredAddress | null) {
  return address === null ? null : db.json(addressBody(address));
}

function addressBody(address: RegisteredAddress): { lines: string[]; region?: string; postalCode?: string } {
  return {
    lines: [...address.lines],
    ...(address.region === undefined || address.region === null ? {} : { region: address.region }),
    ...(address.postalCode === undefined || address.postalCode === null ? {} : { postalCode: address.postalCode }),
  };
}

export class PostgresFirmEntityRepository implements FirmEntityRepository {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly FirmEntityRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<FirmEntityRow[]>`${this.select(db)}
        -- A picker, so a company the firm put away is not offered.
        WHERE p.archived_at IS NULL
        GROUP BY p.id, p.display_name, o.is_firm_self, le.jurisdiction, le.entity_type,
                 le.registered_address, m.id
        HAVING o.is_firm_self OR m.id IS NOT NULL
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
                 le.registered_address, m.id
        HAVING o.is_firm_self OR m.id IS NOT NULL
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

  async create(
    e: NewFirmEntity,
  ): Promise<
    | { readonly created: true; readonly numbers: FirmEntityNumbersWritten }
    | { readonly created: false }
    | { readonly taken: string }
  > {
    try {
      const numbers = await withTenant(this.app, e.tenantId, async (db) => {
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
          registeredAddress: e.registeredAddress === null ? null : addressBody(e.registeredAddress),
        });
        // MEMBERSHIP FIRST (0313): the company is the firm's whatever the
        // routing says afterwards, so moving its country away later cannot
        // make it vanish.
        await db`
          INSERT INTO crm.firm_entity (tenant_id, party_id)
          VALUES (${e.tenantId}, ${e.partyId})
          ON CONFLICT (tenant_id, party_id) DO NOTHING
        `;
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
        return writeNumbers(db, e.tenantId, e.partyId, e.numbers);
      });
      return { created: true, numbers };
    } catch (err) {
      if (err instanceof CountryTaken) return { created: false };
      if (err instanceof NumberTaken) return { taken: err.type };
      throw err;
    }
  }

  async edit(
    tenantId: string,
    partyId: string,
    change: FirmEntityChange,
  ): Promise<{ readonly numbers: FirmEntityNumbersWritten } | { readonly taken: string }> {
    try {
      return await withTenant(this.app, tenantId, async (db) => {
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
      return { numbers: await writeNumbers(db, tenantId, partyId, change.numbers ?? []) };
      });
    } catch (err) {
      if (err instanceof NumberTaken) return { taken: err.type };
      throw err;
    }
  }

  /** The shared head of both reads: `crm.is_firm_entity`'s two sources (the
   *  firm itself, and a live membership row), with the registration and the
   *  countries the routing rule sends to each company, which may be none. */
  private select(db: Db) {
    return db`
      SELECT p.id AS party_id, p.display_name AS name, o.is_firm_self,
             le.jurisdiction, le.entity_type, le.registered_address,
             coalesce(array_agg(fp.client_jurisdiction ORDER BY fp.client_jurisdiction)
                        FILTER (WHERE fp.client_jurisdiction <> '*'), '{}') AS routed,
             coalesce(bool_or(fp.client_jurisdiction = '*'), false) AS is_fallback,
             -- What prints under its name (audit 2026-10-03): each number in
             -- force, the company form's own (never ended, only voided).
             (SELECT jsonb_build_object('type', i.type, 'value', i.value::text)
                FROM core.party_identifier i
               WHERE i.party_id = p.id AND i.type IN ('gstin', 'trn', 'vat', 'ein')
                 AND i.voided_at IS NULL AND i.valid_to IS NULL
               ORDER BY i.valid_from DESC, i.created_at DESC LIMIT 1) AS tax_registration,
             (SELECT i.value::text FROM core.party_identifier i
               WHERE i.party_id = p.id AND i.type = 'pan' AND i.voided_at IS NULL AND i.valid_to IS NULL
               ORDER BY i.valid_from DESC, i.created_at DESC LIMIT 1) AS pan,
             (SELECT i.value::text FROM core.party_identifier i
               WHERE i.party_id = p.id AND i.type = 'phone' AND i.voided_at IS NULL AND i.valid_to IS NULL
               ORDER BY i.valid_from DESC, i.created_at DESC LIMIT 1) AS phone,
             (SELECT i.value::text FROM core.party_identifier i
               WHERE i.party_id = p.id AND i.type = 'email' AND i.voided_at IS NULL AND i.valid_to IS NULL
               ORDER BY i.valid_from DESC, i.created_at DESC LIMIT 1) AS email
      FROM core.party p
      JOIN core.organization o ON o.party_id = p.id
      LEFT JOIN core.legal_entity le ON le.party_id = p.id
      LEFT JOIN crm.firm_entity m ON m.party_id = p.id AND m.retired_at IS NULL
      LEFT JOIN crm.firm_entity_preference fp ON fp.firm_entity_party_id = p.id
    `;
  }
}
