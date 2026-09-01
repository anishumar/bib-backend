// In-memory fakes for gate 4's grants (G3.4). They model the SCHEMA's rules,
// not just the happy path, because a fake that is more permissive than the
// database turns a green test into a false statement about production.
//
// What is modelled deliberately:
//   · `end` refuses a grant that is already closed — the repository's own
//     `WHERE valid_to IS NULL`, which is what makes a double close leave the
//     FIRST date standing.
//   · the joined reads resolve names from the directories, so a test can catch
//     a read model that came back with ids.
import type { PortalAccess, PortalAccessRecord } from "../domain/portalaccess/model";
import type {
  NewPortalAccess,
  PortalAccessRepository,
  PortalClientDirectory,
  PortalClientRow,
  PortalMembershipDirectory,
  PortalMembershipRow,
} from "../usecase/portalaccess/ports";

export class FakePortalAccessRepo implements PortalAccessRepository {
  readonly rows: PortalAccess[] = [];
  /** membershipId → the contact behind it, for the joined reads. */
  readonly contacts = new Map<string, { email: string; displayName: string | null }>();
  /** partyId → client name. */
  readonly clientNames = new Map<string, string>();
  /** userId → the granter, LEFT-join style: an id with no entry resolves to
   *  nulls rather than dropping the row, which is what the erased-account case
   *  does in Postgres. */
  readonly people = new Map<string, { email: string; displayName: string | null }>();

  private record(row: PortalAccess): PortalAccessRecord {
    const contact = this.contacts.get(row.membershipId);
    const granter = this.people.get(row.grantedBy);
    return {
      access: row,
      clientName: this.clientNames.get(row.clientPartyId) ?? "unnamed client",
      contactDisplayName: contact?.displayName ?? null,
      contactEmail: contact?.email ?? "unknown@example.test",
      grantedByDisplayName: granter?.displayName ?? null,
      grantedByEmail: granter?.email ?? null,
    };
  }

  listForMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<readonly PortalAccessRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.membershipId === membershipId)
        .map((r) => this.record(r)),
    );
  }

  listForClient(tenantId: string, clientPartyId: string): Promise<readonly PortalAccessRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.clientPartyId === clientPartyId)
        .map((r) => this.record(r)),
    );
  }

  listGrants(tenantId: string, membershipId: string): Promise<readonly PortalAccess[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.tenantId === tenantId && r.membershipId === membershipId),
    );
  }

  findById(tenantId: string, grantId: string): Promise<PortalAccess | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === grantId) ?? null,
    );
  }

  create(row: NewPortalAccess): Promise<PortalAccess> {
    const created: PortalAccess = {
      id: row.id,
      tenantId: row.tenantId,
      membershipId: row.membershipId,
      clientPartyId: row.clientPartyId,
      validFrom: row.validFrom,
      validTo: row.validTo,
      grantedBy: row.grantedBy,
    };
    this.rows.push(created);
    return Promise.resolve(created);
  }

  end(tenantId: string, grantId: string, validTo: string): Promise<PortalAccess> {
    const index = this.rows.findIndex(
      (r) => r.tenantId === tenantId && r.id === grantId && r.validTo === null,
    );
    const found = this.rows[index];
    if (found === undefined) {
      // The repository's `WHERE valid_to IS NULL` returning no row — two
      // administrators clicking together, and the first date is the one that
      // stands.
      return Promise.reject(new Error(`portal grant ${grantId} was already closed by somebody else`));
    }
    const ended: PortalAccess = { ...found, validTo };
    this.rows[index] = ended;
    return Promise.resolve(ended);
  }
}

export class FakePortalMemberships implements PortalMembershipDirectory {
  readonly rows = new Map<string, PortalMembershipRow>();

  findMembership(_tenantId: string, membershipId: string): Promise<PortalMembershipRow | null> {
    return Promise.resolve(this.rows.get(membershipId) ?? null);
  }
}

export class FakePortalClients implements PortalClientDirectory {
  readonly rows = new Map<string, PortalClientRow>();

  findParty(_tenantId: string, partyId: string): Promise<PortalClientRow | null> {
    return Promise.resolve(this.rows.get(partyId) ?? null);
  }
}
