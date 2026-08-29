// Postgres adapter for the two facts every document carries: its reference and
// which of the firm's own entities issued it. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement.
//
// ── THE ONE THING TO UNDERSTAND ABOUT THIS FILE ─────────────────────────────
//
// `next` advances the counter in its OWN transaction and returns. The document
// it was drawn for is written in a LATER transaction, by a different adapter,
// and if that write fails the number is never reissued — it is burnt, and the
// firm's series has a gap.
//
// That is deliberate and it is the whole design. A document reference wants
// exactly what a Postgres SEQUENCE gives: no two drafters wait on each other,
// and a rolled-back draft keeps its number rather than handing it to the next
// document. A real sequence could not be used, because this series is keyed by
// tenant and year — a sequence OBJECT per firm per year would mean DDL inside a
// request, and one sequence shared across the installation would print a
// cross-tenant volume counter on documents that clients read. So the counter is
// a row and the semantics are restored by the transaction boundary.
//
// T3.4's invoice number needs the OPPOSITE discipline: allocated inside the
// invoice's own transaction, under the row lock, so that a number is never
// burnt and the series is gapless. Same table shape, opposite boundary,
// opposite guarantee. Do not reuse this method for it.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DocumentType, FirmEntityPreference } from "../../domain/document/model";
import type {
  DocumentReferences,
  FirmEntity,
  FirmEntityPreferenceRecord,
  FirmEntityPreferenceRepository,
  NewFirmEntityPreference,
} from "../../usecase/document/ports";

interface PreferenceRow {
  id: string;
  tenant_id: string;
  client_jurisdiction: string;
  firm_entity_party_id: string;
  note: string | null;
}

function toPreference(r: PreferenceRow): FirmEntityPreference {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    clientJurisdiction: r.client_jurisdiction,
    firmEntityPartyId: r.firm_entity_party_id,
    note: r.note,
  };
}

export class PostgresDocumentRepository
  implements FirmEntityPreferenceRepository, DocumentReferences
{
  constructor(private readonly app: Db) {}

  /**
   * The next number in this firm's series, in its own committed transaction.
   *
   * One statement, so two drafters cannot both read `last_number` and both
   * write the same successor: the ON CONFLICT arm takes the row lock and
   * increments from what is actually stored. The `RETURNING` is the allocation.
   */
  async next(tenantId: string, type: DocumentType, year: number): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ last_number: number }[]>`
        INSERT INTO crm.document_ref_series AS s
          (tenant_id, document_type, year, last_number)
        VALUES (${tenantId}, ${type}, ${year}, 1)
        ON CONFLICT (tenant_id, document_type, year)
        DO UPDATE SET last_number = s.last_number + 1
        RETURNING last_number
      `;
      if (!row) throw new Error("document reference series returned no number");
      return row.last_number;
    });
  }

  async preferences(tenantId: string): Promise<readonly FirmEntityPreference[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<PreferenceRow[]>`
        SELECT id, tenant_id, client_jurisdiction, firm_entity_party_id, note
        FROM crm.firm_entity_preference
        ORDER BY client_jurisdiction
      `;
      return rows.map(toPreference);
    });
  }

  async list(tenantId: string): Promise<readonly FirmEntityPreferenceRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        (PreferenceRow & { entity_display_name: string; entity_jurisdiction: string | null })[]
      >`
        SELECT p.id, p.tenant_id, p.client_jurisdiction, p.firm_entity_party_id, p.note,
               entity.display_name AS entity_display_name,
               le.jurisdiction     AS entity_jurisdiction
        FROM crm.firm_entity_preference p
        -- The entity by NAME, in the query. This screen is a table of country
        -- to company, and a column of uuids is the one thing it must not be.
        JOIN core.party entity ON entity.id = p.firm_entity_party_id
        -- And where that company is REGISTERED, which is what makes the row
        -- legible: "a client in AE is served by this company" reads very
        -- differently once you can see the company is registered in IN. LEFT,
        -- because the seeded default entity has no legal_entity row at all and
        -- an unregistered issuer is a real state, not a broken join.
        LEFT JOIN core.legal_entity le ON le.party_id = entity.id
        -- The fallback last: '*' sorts before letters in C collation and after
        -- them in most others, and a screen that puts "everywhere else" in a
        -- different place depending on the database's locale is not a screen.
        ORDER BY (p.client_jurisdiction = '*'), p.client_jurisdiction
      `;
      return rows.map((r) => ({
        preference: toPreference(r),
        entity: {
          id: r.firm_entity_party_id,
          displayName: r.entity_display_name,
          jurisdiction: r.entity_jurisdiction,
        },
      }));
    });
  }

  async set(p: NewFirmEntityPreference): Promise<FirmEntityPreference> {
    return withTenant(this.app, p.tenantId, async (db) => {
      // Upsert on the country, because the schema allows exactly one answer per
      // country. The id supplied is used only when the row is NEW — an existing
      // row keeps its identity, so anything that ever referenced it still can.
      const [row] = await db<PreferenceRow[]>`
        INSERT INTO crm.firm_entity_preference
          (id, tenant_id, client_jurisdiction, firm_entity_party_id, note)
        VALUES (${p.id}, ${p.tenantId}, ${p.clientJurisdiction}, ${p.firmEntityPartyId}, ${p.note})
        ON CONFLICT (tenant_id, client_jurisdiction)
        DO UPDATE SET firm_entity_party_id = EXCLUDED.firm_entity_party_id,
                      note = EXCLUDED.note
        RETURNING id, tenant_id, client_jurisdiction, firm_entity_party_id, note
      `;
      if (!row) throw new Error("firm entity preference upsert returned no row");
      return toPreference(row);
    });
  }

  async findEntity(tenantId: string, partyId: string): Promise<FirmEntity | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        { id: string; display_name: string; jurisdiction: string | null }[]
      >`
        SELECT p.id, p.display_name, le.jurisdiction
        FROM core.party p
        -- LEFT: an entity with no registration is the ordinary state, not a
        -- missing row. G1.8's mismatch check is what cares, and it says so
        -- itself rather than reading a null here as "not this firm's party".
        LEFT JOIN core.legal_entity le ON le.party_id = p.id
        WHERE p.id = ${partyId}
      `;
      return row
        ? { id: row.id, displayName: row.display_name, jurisdiction: row.jurisdiction }
        : null;
    });
  }

  /**
   * A new firm's own entity, and the fallback row naming it — in one
   * transaction, because a firm with one and not the other is worse than a firm
   * with neither.
   *
   * Called from `createTenant` through a port on tenancy, exactly as the role
   * registry is seeded there. `issuing_entity_party_id` is NOT NULL on both
   * documents, so a firm with no preference row could not draft anything at
   * all; every tenant therefore owns a fallback from the moment it exists, and
   * migration 0021 backfilled the firms that predate this.
   *
   * The entity is the FIRM ITSELF — `core.organization.is_firm_self`, the flag
   * this schema has carried since 0002 with nothing ever writing it. A firm
   * that operates one company is correct with no configuration; a firm that
   * operates several adds its entities and a row per country, and the note here
   * says plainly that nobody chose this one.
   */
  async seedFirmEntity(tenantId: string, firmName: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      const [party] = await db<{ id: string }[]>`
        INSERT INTO core.party (tenant_id, kind, display_name)
        VALUES (${tenantId}, 'organization', ${firmName})
        RETURNING id
      `;
      if (!party) throw new Error("the firm's own party insert returned no row");

      await db`
        INSERT INTO core.organization (party_id, tenant_id, legal_name, is_firm_self)
        VALUES (${party.id}, ${tenantId}, ${firmName}, true)
      `;
      await db`
        INSERT INTO crm.firm_entity_preference
          (tenant_id, client_jurisdiction, firm_entity_party_id, note)
        VALUES (${tenantId}, '*', ${party.id},
                'Seeded when the firm was created: the firm itself issues its own documents until it says otherwise.')
      `;
      return party.id;
    });
  }
}
