// Postgres adapter for the party object graph. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement — creating an
// organization inserts the party row and its subtype in ONE transaction under
// one tenant context. Date columns are cast to ::text so they return as ISO
// YYYY-MM-DD strings (postgres.js would otherwise hand back Date objects),
// keeping effective-dating a lexicographic string compare end to end.
import { postalAddressJson, readPostalAddress } from "../../domain/party/address";
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
  PartyDetailsPatch,
} from "../../usecase/party/ports";
import type { ClientDirectory } from "../../usecase/clientassignment/ports";
import {
  PartyAlreadyArchived,
  PartyHasReferences,
  PartyNotArchived,
  PartyNotFound,
} from "../../domain/party/errors";
import { MAX_LIST_ROWS } from "../../db/limits";

interface PartyRow {
  id: string;
  tenant_id: string;
  kind: PartyKind;
  display_name: string;
  archived_at: Date | null;
  is_own_company: boolean;
  billing_address: unknown;
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

/**
 * The party and its organization row, on a connection the caller holds.
 *
 * Exported for the one writer that must create an organization in the same
 * transaction as other rows — one of the firm's own companies with its
 * registration and the rule that names it (T6.18) — so the statements still
 * live in this file.
 */
export async function insertOrganization(db: Db, o: NewOrganization): Promise<Organization> {
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
}

/** The legal-entity row, on a connection the caller holds — see above. */
export async function insertLegalEntity(db: Db, e: NewLegalEntity): Promise<LegalEntity> {
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
}

function toParty(r: PartyRow): Party {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    displayName: r.display_name,
    // timestamptz arrives as a Date; the domain carries ISO 8601 with an
    // offset, like every other timestamp that crosses this door.
    archivedAt: r.archived_at === null ? null : r.archived_at.toISOString(),
    isOwnCompany: r.is_own_company,
    billingAddress: readPostalAddress(r.billing_address),
  };
}

/**
 * A party's columns plus whether it is one of the firm's own companies, for a
 * read of ONE party: the migration's own function (`crm.is_firm_entity`), so
 * there is one definition. The list restates it as two joins instead, for the
 * reason `listParties` gives.
 */
const PARTY_COLUMNS =
  "id, tenant_id, kind, display_name, archived_at, crm.is_firm_entity(tenant_id, id) AS is_own_company, " +
  "billing_address";

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

/**
 * Two ports over the party tables. `PartyRepository` is the party use case's
 * own; `ClientDirectory` is G3.2's, which needs one question answered before it
 * puts somebody in charge of a client — is this party the firm's, and has the
 * firm archived it? One adapter, because a second notion of "archived" would
 * eventually let an assignment be made against a client that is out of every
 * picker.
 */
export class PostgresPartyRepository implements PartyRepository, ClientDirectory {
  constructor(private readonly app: Db) {}

  async createOrganization(o: NewOrganization): Promise<Organization> {
    return withTenant(this.app, o.tenantId, (db) => insertOrganization(db, o));
  }

  async createRegisteredOrganization(
    o: NewOrganization,
    registration: Omit<NewLegalEntity, "partyId" | "tenantId">,
  ): Promise<{ readonly organization: Organization; readonly entity: LegalEntity }> {
    return withTenant(this.app, o.tenantId, async (db) => {
      const organization = await insertOrganization(db, o);
      const entity = await insertLegalEntity(db, { ...registration, partyId: o.partyId, tenantId: o.tenantId });
      return { organization, entity };
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
    return withTenant(this.app, e.tenantId, (db) => insertLegalEntity(db, e));
  }

  /**
   * One party by id — AND IT NEVER FILTERS ON archived_at.
   *
   * Half of the archive design, and the half that is easy to break by adding
   * "the obvious" WHERE clause. A proposal, an engagement letter or an
   * engagement pointing at this id has to render its counterparty, and it has
   * to keep rendering it after somebody tidies the picker. Archiving hides a
   * party from LISTS; it never makes one stop existing.
   */
  /** The country of its registration (Q076), or null when it has none. */
  async registeredCountry(tenantId: string, partyId: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ jurisdiction: string }[]>`
        SELECT jurisdiction FROM core.legal_entity WHERE party_id = ${partyId} AND tenant_id = ${tenantId}
      `;
      return row?.jurisdiction ?? null;
    });
  }

  async findParty(tenantId: string, partyId: string): Promise<Party | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PartyRow[]>`
        SELECT ${db.unsafe(PARTY_COLUMNS)}
        FROM core.party WHERE id = ${partyId}
      `;
      return row ? toParty(row) : null;
    });
  }

  /**
   * Correct a client's master data (V2.5), both rows in ONE transaction: the
   * party's display name (what every list, picker and new PDF reads) and the
   * organization's trade name, industry and website. A person has only the
   * first. Nothing here touches a document already issued: a signed letter is
   * frozen and a filed PDF is stored bytes.
   */
  async updateDetails(
    tenantId: string,
    partyId: string,
    patch: PartyDetailsPatch,
  ): Promise<Party | null> {
    return withTenant(this.app, tenantId, async (db) => {
      if (patch.displayName !== undefined) {
        await db`UPDATE core.party SET display_name = ${patch.displayName} WHERE id = ${partyId}`;
      }
      if (patch.billingAddress !== undefined) {
        await db`
          UPDATE core.party
             SET billing_address = ${patch.billingAddress === null ? null : db.json(postalAddressJson(patch.billingAddress))}
           WHERE id = ${partyId}
        `;
      }
      if (patch.tradeName !== undefined || patch.industry !== undefined || patch.website !== undefined) {
        await db`
          UPDATE core.organization SET
            trade_name = ${patch.tradeName === undefined ? db`trade_name` : patch.tradeName},
            industry   = ${patch.industry === undefined ? db`industry` : patch.industry},
            website    = ${patch.website === undefined ? db`website` : patch.website}
          WHERE party_id = ${partyId}
        `;
      }
      const [row] = await db<PartyRow[]>`
        SELECT ${db.unsafe(PARTY_COLUMNS)}
        FROM core.party WHERE id = ${partyId}
      `;
      return row ? toParty(row) : null;
    });
  }

  /** Correct a registered company's country and kind (V2.5). */
  async correctLegalEntity(
    tenantId: string,
    partyId: string,
    patch: {
      readonly jurisdiction?: string | undefined;
      readonly entityType?: string | undefined;
      readonly financialYearEnd?: string | null | undefined;
    },
  ): Promise<LegalEntity | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LegalEntityRow[]>`
        UPDATE core.legal_entity SET
          jurisdiction = ${patch.jurisdiction ?? db`jurisdiction`},
          entity_type  = ${patch.entityType ?? db`entity_type`},
          financial_year_end = ${patch.financialYearEnd === undefined ? db`financial_year_end` : patch.financialYearEnd}
        WHERE party_id = ${partyId}
        RETURNING party_id, tenant_id, jurisdiction, entity_type,
                  incorporated_on::text AS incorporated_on,
                  financial_year_end, registered_address, status
      `;
      return row ? toLegalEntity(row) : null;
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

  /**
   * The tenant's parties — the other half of the asymmetry. This one DOES
   * filter: an archived party is out of the picker until somebody asks for it.
   *
   * Two whole statements rather than one with a parameterised predicate,
   * because `WHERE ($1 OR archived_at IS NULL)` cannot be matched against
   * `idx_party_tenant_live` (migration 0035) — a partial index over exactly
   * this predicate and this ordering — once the plan is generic. The default
   * read is the one that has to stay cheap.
   */
  async listParties(tenantId: string, includeArchived: boolean): Promise<Party[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // WHICH ARE OURS, in the same pass: `crm.is_firm_entity` (0313) spelled
      // as two joins, the firm's own organization row and a live
      // `crm.firm_entity` member (one per party, by its unique key), so the
      // list stays one scan however many companies the firm has. The
      // integration test holds this to the function row for row.
      const parties = db`
        SELECT p.id, p.tenant_id, p.kind, p.display_name, p.archived_at,
               (COALESCE(o.is_firm_self, false) OR fe.party_id IS NOT NULL) AS is_own_company
        FROM core.party p
        LEFT JOIN core.organization o
          ON o.party_id = p.id AND o.tenant_id = p.tenant_id
        LEFT JOIN crm.firm_entity fe
          ON fe.party_id = p.id AND fe.tenant_id = p.tenant_id AND fe.retired_at IS NULL
      `;
      const rows = includeArchived
        ? await db<PartyRow[]>`
            ${parties}
            ORDER BY p.display_name
            -- A CEILING, not pagination — see MAX_LIST_ROWS.
            LIMIT ${MAX_LIST_ROWS}
          `
        : await db<PartyRow[]>`
            ${parties}
            WHERE p.archived_at IS NULL
            ORDER BY p.display_name
            LIMIT ${MAX_LIST_ROWS}
          `;
      return rows.map(toParty);
    });
  }

  /**
   * Archive, or be refused by the database.
   *
   * `now()` rather than a clock injected from the application: the timestamp
   * belongs to the transaction that made the change, and every other stamp on
   * this table (`created_at`, `updated_at`) is struck the same way.
   *
   * THE REFUSAL IS NOT WRITTEN HERE. `trg_party_archive_guard` (0035, body
   * replaced by 0036) raises `restrict_violation` when a lead, proposal,
   * proposal line, engagement letter, letter line or engagement still points at
   * the party, and names them in DETAIL. All this method does is put our own
   * error round it — so the same rule holds for an import, an agent or a psql
   * session, none of which pass through this file.
   *
   * `AND archived_at IS NULL` MAKES THE TRANSITION ITSELF THE LOCK, the way
   * `signAndFanOut` uses `AND status = 'sent'` and `recordAdvance` uses `AND
   * advance_recorded_at IS NULL`. The service checks first, but a check and an
   * UPDATE are two statements and two callers fit between them; the trigger
   * cannot close that gap because it deliberately does not fire on NOT NULL →
   * NOT NULL. Without the predicate both writers win, the timestamp moves, and
   * a SECOND `party.archived` lands in a log that can never be corrected. With
   * it the loser gets no row.
   */
  async archive(tenantId: string, partyId: string): Promise<Party> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<PartyRow[]>`
        UPDATE core.party SET archived_at = now()
        WHERE id = ${partyId} AND archived_at IS NULL
        RETURNING ${db.unsafe(PARTY_COLUMNS)}
      `.catch((err: unknown) => {
        throw isArchiveRefusal(err) ? new PartyHasReferences(partyId, referrersOf(err)) : err;
      });
      const row = rows[0];
      if (!row) throw await this.explainMissedUpdate(db, partyId, "archive");
      return toParty(row);
    });
  }

  /** The same lock in the other direction: `AND archived_at IS NOT NULL`, so two
   *  concurrent restores produce one event rather than two. */
  async unarchive(tenantId: string, partyId: string): Promise<Party> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<PartyRow[]>`
        UPDATE core.party SET archived_at = NULL
        WHERE id = ${partyId} AND archived_at IS NOT NULL
        RETURNING ${db.unsafe(PARTY_COLUMNS)}
      `;
      if (!row) throw await this.explainMissedUpdate(db, partyId, "unarchive");
      return toParty(row);
    });
  }

  /**
   * Why a guarded UPDATE matched nothing: the party is not there, or somebody
   * else got there first. Both are the caller's answer and neither is a 500 —
   * losing the race means the party is already in the state that was asked for,
   * which is the same 409 the service's own pre-check gives.
   *
   * One extra read, on the failure path only.
   */
  private async explainMissedUpdate(
    db: Db,
    partyId: string,
    action: "archive" | "unarchive",
  ): Promise<Error> {
    const [row] = await db<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM core.party WHERE id = ${partyId}
    `;
    if (!row) return new PartyNotFound(partyId);
    return action === "archive"
      ? new PartyAlreadyArchived(partyId)
      : new PartyNotArchived(partyId);
  }
}

/** SQLSTATE 23001, `restrict_violation` — what 0035's guard raises and nothing
 *  else on this statement can. Matching the code rather than the message keeps
 *  the translation independent of the wording. */
function isArchiveRefusal(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23001";
}

/** The guard puts the referring objects in DETAIL, comma separated, so the
 *  names come from the one place that enumerates them. An empty DETAIL is not
 *  worth failing over — the caller still learns the archive was refused. */
function referrersOf(err: unknown): readonly string[] {
  const detail = (err as { detail?: unknown }).detail;
  if (typeof detail !== "string" || detail.trim() === "") return ["something in the firm's records"];
  return detail.split(",").map((s) => s.trim());
}
