// Postgres adapter for gate 4's grants (G3.4). Every read and write goes
// through withTenant — a grant is one firm's decision about one of its own
// clients, so there is no identity-mode path here at all.
//
// NOTE WHICH RESOLVER THIS USES. `withTenant`, never `withPortal`: this table
// is written and read by the FIRM's staff, deciding who may see what. A portal
// session never touches it — it is the thing being scoped, not the thing doing
// the scoping — and reading grants under a portal scope would be a table asking
// itself for permission.
//
// Dates are selected `::text`. postgres.js parses a `date` column into a JS
// `Date`, which is an INSTANT and moves the day for anybody east or west of
// UTC — and whether somebody could see a client on the 14th is a calendar fact.
// The whole domain compares these as ISO strings.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { PortalAccess, PortalAccessRecord } from "../../domain/portalaccess/model";
import type {
  NewPortalAccess,
  PortalAccessRepository,
  PortalClientDirectory,
  PortalClientRow,
  PortalMembershipDirectory,
  PortalMembershipRow,
} from "../../usecase/portalaccess/ports";

interface AccessRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  client_party_id: string;
  valid_from: string;
  valid_to: string | null;
  granted_by: string;
}

interface AccessRecordRow extends AccessRow {
  client_name: string;
  contact_email: string;
  contact_display_name: string | null;
  granted_by_email: string | null;
  granted_by_display_name: string | null;
}

function toAccess(r: AccessRow): PortalAccess {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    membershipId: r.membership_id,
    clientPartyId: r.client_party_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    grantedBy: r.granted_by,
  };
}

function toRecord(r: AccessRecordRow): PortalAccessRecord {
  return {
    access: toAccess(r),
    clientName: r.client_name,
    contactDisplayName: r.contact_display_name,
    contactEmail: r.contact_email,
    grantedByDisplayName: r.granted_by_display_name,
    grantedByEmail: r.granted_by_email,
  };
}

export class PostgresPortalAccessRepository
  implements PortalAccessRepository, PortalMembershipDirectory, PortalClientDirectory
{
  constructor(private readonly app: Db) {}

  /**
   * The joined read, written once.
   *
   * BOTH halves of every person — display name AND email — because
   * `display_name` is nullable and genuinely empty at real firms, so a name
   * alone collapses "we hold no name for this person" into "there is no
   * person". That is the seventh time this codebase has been caught by it.
   *
   * The granter is a LEFT join: `tenancy.user_account` is global and an account
   * that has since been erased stops resolving, which must not take the grant
   * off the screen. The audit trail's rule, applied to a row rather than an
   * event.
   */
  private async records(
    tenantId: string,
    where: (db: Db) => Promise<AccessRecordRow[]>,
  ): Promise<readonly PortalAccessRecord[]> {
    const rows = await withTenant(this.app, tenantId, where);
    return rows.map(toRecord);
  }

  async listForMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<readonly PortalAccessRecord[]> {
    return this.records(
      tenantId,
      async (db) => db<AccessRecordRow[]>`
        SELECT pa.id, pa.tenant_id, pa.membership_id, pa.client_party_id,
               pa.valid_from::text AS valid_from, pa.valid_to::text AS valid_to, pa.granted_by,
               p.display_name AS client_name,
               contact.email AS contact_email, contact.display_name AS contact_display_name,
               granter.email AS granted_by_email, granter.display_name AS granted_by_display_name
          FROM crm.portal_access pa
          JOIN core.party p          ON p.id = pa.client_party_id AND p.tenant_id = pa.tenant_id
          JOIN tenancy.membership m  ON m.id = pa.membership_id   AND m.tenant_id = pa.tenant_id
          JOIN tenancy.user_account contact ON contact.id = m.user_id
          LEFT JOIN tenancy.user_account granter ON granter.id = pa.granted_by
         WHERE pa.membership_id = ${membershipId}
         ORDER BY pa.valid_from DESC, p.display_name ASC
      `,
    );
  }

  async listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly PortalAccessRecord[]> {
    return this.records(
      tenantId,
      async (db) => db<AccessRecordRow[]>`
        SELECT pa.id, pa.tenant_id, pa.membership_id, pa.client_party_id,
               pa.valid_from::text AS valid_from, pa.valid_to::text AS valid_to, pa.granted_by,
               p.display_name AS client_name,
               contact.email AS contact_email, contact.display_name AS contact_display_name,
               granter.email AS granted_by_email, granter.display_name AS granted_by_display_name
          FROM crm.portal_access pa
          JOIN core.party p          ON p.id = pa.client_party_id AND p.tenant_id = pa.tenant_id
          JOIN tenancy.membership m  ON m.id = pa.membership_id   AND m.tenant_id = pa.tenant_id
          JOIN tenancy.user_account contact ON contact.id = m.user_id
          LEFT JOIN tenancy.user_account granter ON granter.id = pa.granted_by
         WHERE pa.client_party_id = ${clientPartyId}
         ORDER BY pa.valid_from DESC, contact.email ASC
      `,
    );
  }

  /** The scope read, and the one on the hot path: it runs for every portal
   *  request once T6.5 exists. No joins — the caller wants ids, and the index
   *  is `(tenant_id, membership_id)`. */
  async listGrants(tenantId: string, membershipId: string): Promise<readonly PortalAccess[]> {
    const rows = await withTenant(
      this.app,
      tenantId,
      async (db) => db<AccessRow[]>`
        SELECT id, tenant_id, membership_id, client_party_id,
               valid_from::text AS valid_from, valid_to::text AS valid_to, granted_by
          FROM crm.portal_access
         WHERE membership_id = ${membershipId}
      `,
    );
    return rows.map(toAccess);
  }

  async findById(tenantId: string, grantId: string): Promise<PortalAccess | null> {
    const rows = await withTenant(
      this.app,
      tenantId,
      async (db) => db<AccessRow[]>`
        SELECT id, tenant_id, membership_id, client_party_id,
               valid_from::text AS valid_from, valid_to::text AS valid_to, granted_by
          FROM crm.portal_access
         WHERE id = ${grantId}
      `,
    );
    const row = rows[0];
    return row === undefined ? null : toAccess(row);
  }

  async create(row: NewPortalAccess): Promise<PortalAccess> {
    const rows = await withTenant(
      this.app,
      row.tenantId,
      async (db) => db<AccessRow[]>`
        INSERT INTO crm.portal_access
          (id, tenant_id, membership_id, client_party_id, valid_from, valid_to, granted_by)
        VALUES (${row.id}, ${row.tenantId}, ${row.membershipId}, ${row.clientPartyId},
                ${row.validFrom}, ${row.validTo}, ${row.grantedBy})
        RETURNING id, tenant_id, membership_id, client_party_id,
                  valid_from::text AS valid_from, valid_to::text AS valid_to, granted_by
      `,
    );
    const created = rows[0];
    if (created === undefined) throw new Error(`portal grant ${row.id} was not written`);
    return toAccess(created);
  }

  /**
   * Close a grant.
   *
   * `WHERE valid_to IS NULL` is not decoration: it makes a second close a
   * no-row result rather than a silent re-dating, so two administrators
   * clicking together leave the FIRST date standing. The service refuses it in
   * words; this is what holds when two requests race.
   */
  async end(tenantId: string, grantId: string, validTo: string): Promise<PortalAccess> {
    const rows = await withTenant(
      this.app,
      tenantId,
      async (db) => db<AccessRow[]>`
        UPDATE crm.portal_access
           SET valid_to = ${validTo}
         WHERE id = ${grantId} AND valid_to IS NULL
        RETURNING id, tenant_id, membership_id, client_party_id,
                  valid_from::text AS valid_from, valid_to::text AS valid_to, granted_by
      `,
    );
    const ended = rows[0];
    if (ended === undefined) {
      throw new Error(`portal grant ${grantId} was already closed by somebody else`);
    }
    return toAccess(ended);
  }

  // ── the two directories, satisfied by the same adapter ───────────────────
  //
  // One adapter, three seams — `PostgresConfigRepository` and the staff-grade
  // repository already have this shape. Two adapters over one table eventually
  // disagree, and here that would mean granting a client to a login the roster
  // says was revoked.

  async findMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<PortalMembershipRow | null> {
    const rows = await withTenant(
      this.app,
      tenantId,
      async (db) => db<{ id: string; audience: string; is_active: boolean }[]>`
        SELECT id, audience, is_active FROM tenancy.membership WHERE id = ${membershipId}
      `,
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, audience: row.audience, isActive: row.is_active };
  }

  async findParty(tenantId: string, partyId: string): Promise<PortalClientRow | null> {
    const rows = await withTenant(
      this.app,
      tenantId,
      async (db) => db<{ id: string; display_name: string; archived_at: string | null }[]>`
        SELECT id, display_name, archived_at::text AS archived_at
          FROM core.party WHERE id = ${partyId}
      `,
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, displayName: row.display_name, archivedAt: row.archived_at };
  }
}
