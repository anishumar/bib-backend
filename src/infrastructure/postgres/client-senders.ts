// Who a client email is from, read off the account team (Q059).
//
// THE RULE (Shrestha, 2026-10-05, on Sid's "preferably from the email of
// SPOC"): a client has a SPOC per Dept, so a letter about one Dept's work is
// from THAT Dept's SPOC; a letter spanning Depts, or about the client as a
// whole (the portal invitation), is from the client's Key Manager. Nobody in
// that seat: null, and the letter goes as it always did, from the firm.
//
// Each role is read the way the routing and the billing manager read it: in
// force on the FIRM's day, held by somebody still active on the staff. Several
// SPOCs for one Dept (a handover, leave cover) answer with the longest-serving,
// so the same letter always names the same person.
//
// Both reads also bring the firm's list of domains it may send from, so
// `ownAddress` is decided here in one round trip by the pure rule.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { mayUseOwnAddress } from "../../domain/mail/model";
import type { ClientSender } from "../../domain/mail/model";

interface PersonRow {
  display_name: string | null;
  email: string;
}

export class PostgresClientSenders {
  constructor(private readonly app: Db) {}

  /** The client's Key Manager: a letter about the client as a whole. */
  async senderForClient(tenantId: string, clientPartyId: string): Promise<ClientSender | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const firm = await this.firm(db, tenantId);
      if (firm === null) return null;
      const km = await this.keyManager(db, tenantId, clientPartyId, firm.day);
      return km === null ? null : this.toSender(km, firm.domains);
    });
  }

  /**
   * A portal contact's letter sent AGAIN: the Key Manager of the first client
   * the login may see today (one grant per client; a group contact's grants
   * name the same account team as often as not, and the earliest is stable).
   */
  async senderForContact(tenantId: string, membershipId: string): Promise<ClientSender | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const firm = await this.firm(db, tenantId);
      if (firm === null) return null;
      const [grant] = await db<{ client_party_id: string }[]>`
        SELECT client_party_id
          FROM crm.portal_access
         WHERE tenant_id = ${tenantId} AND membership_id = ${membershipId}
           AND valid_from <= ${firm.day}::date
           AND (valid_to IS NULL OR valid_to > ${firm.day}::date)
         ORDER BY valid_from, id
         LIMIT 1
      `;
      if (grant === undefined) return null;
      const km = await this.keyManager(db, tenantId, grant.client_party_id, firm.day);
      return km === null ? null : this.toSender(km, firm.domains);
    });
  }

  /** A proposal: its one Dept's SPOC, else the client's Key Manager. */
  async senderForProposal(tenantId: string, proposalId: string): Promise<ClientSender | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const firm = await this.firm(db, tenantId);
      if (firm === null) return null;
      const [proposal] = await db<{ party_id: string }[]>`
        SELECT party_id FROM crm.proposal WHERE id = ${proposalId} AND tenant_id = ${tenantId}
      `;
      if (proposal === undefined) return null;
      // A line's Dept is its service's LIVE published version's `module`, the
      // router's read; a service with none has no Dept and is left out.
      const depts = await db<{ code: string }[]>`
        SELECT DISTINCT live.body ->> 'module' AS code
          FROM crm.proposal_line pl
          JOIN config.version pinned
            ON pinned.id = pl.service_version_id AND pinned.tenant_id = pl.tenant_id
          JOIN config.version live
            ON live.entry_id = pinned.entry_id AND live.tenant_id = pinned.tenant_id
           AND live.status = 'published'
         WHERE pl.proposal_id = ${proposalId} AND pl.tenant_id = ${tenantId}
           AND live.body ->> 'module' IS NOT NULL
      `;
      const only = depts.length === 1 ? depts[0]?.code : undefined;
      if (only !== undefined) {
        const [spoc] = await db<PersonRow[]>`
          SELECT u.display_name, u.email::text AS email
            FROM crm.client_assignment a
            JOIN tenancy.service_axis x
              ON x.id = a.axis_id AND x.tenant_id = a.tenant_id AND x.axis = 'dept'
            JOIN tenancy.membership m
              ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
             AND m.audience = 'STAFF' AND m.is_active
            JOIN tenancy.user_account u ON u.id = a.user_id
           WHERE a.tenant_id = ${tenantId}
             AND a.client_party_id = ${proposal.party_id}
             AND a.role = 'spoc'
             AND x.code = ${only}
             AND a.valid_from <= ${firm.day}::date
             AND (a.valid_to IS NULL OR a.valid_to > ${firm.day}::date)
           ORDER BY a.valid_from, a.user_id
           LIMIT 1
        `;
        if (spoc !== undefined) return this.toSender(spoc, firm.domains);
      }
      const km = await this.keyManager(db, tenantId, proposal.party_id, firm.day);
      return km === null ? null : this.toSender(km, firm.domains);
    });
  }

  /** The domains the firm may send from (0350). */
  async sendFromDomains(tenantId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const firm = await this.firm(db, tenantId);
      return firm?.domains ?? [];
    });
  }

  async setSendFromDomains(tenantId: string, domains: readonly string[]): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE tenancy.tenant SET send_from_domains = ${db.array(domains as string[])}::text[] WHERE id = ${tenantId}
      `;
    });
  }

  private async firm(db: Db, tenantId: string): Promise<{ day: string; domains: string[] } | null> {
    const [row] = await db<{ day: string; domains: string[] }[]>`
      SELECT (now() AT TIME ZONE time_zone)::date::text AS day, send_from_domains AS domains
        FROM tenancy.tenant WHERE id = ${tenantId}
    `;
    return row ?? null;
  }

  private async keyManager(db: Db, tenantId: string, clientPartyId: string, day: string): Promise<PersonRow | null> {
    const [km] = await db<PersonRow[]>`
      SELECT u.display_name, u.email::text AS email
        FROM crm.client_assignment a
        JOIN tenancy.membership m
          ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
         AND m.audience = 'STAFF' AND m.is_active
        JOIN tenancy.user_account u ON u.id = a.user_id
       WHERE a.tenant_id = ${tenantId}
         AND a.client_party_id = ${clientPartyId}
         AND a.role = 'key_manager'
         AND a.valid_from <= ${day}::date
         AND (a.valid_to IS NULL OR a.valid_to > ${day}::date)
       ORDER BY a.valid_from DESC
       LIMIT 1
    `;
    return km ?? null;
  }

  private toSender(p: PersonRow, domains: readonly string[]): ClientSender {
    return { name: p.display_name, email: p.email, ownAddress: mayUseOwnAddress(p.email, domains) };
  }
}
