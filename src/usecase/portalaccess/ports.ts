// The ports this use case needs from the world — the seams. Interfaces are
// owned by the use case that needs them (never a shared top-level ports
// package), stated in our vocabulary. Adapters in infrastructure/ implement
// them.
import type { PortalAccess, PortalAccessRecord } from "../../domain/portalaccess/model";

export interface NewPortalAccess {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly clientPartyId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly grantedBy: string;
}

export interface PortalAccessRepository {
  /**
   * Every grant this login has ever held, live and historic, with the names
   * resolved.
   *
   * Not filtered by date: "could this person see this company in March" is a
   * filter over rows already in hand, and a screen with a date box would
   * otherwise round-trip on every keystroke. A portal contact accumulates a
   * handful of these over the life of the relationship.
   */
  listForMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<readonly PortalAccessRecord[]>;

  /**
   * Everybody who can see one client, live and historic.
   *
   * The question a firm asks when a client rings up about somebody who should
   * no longer have access — and the reason ending a grant is never a delete.
   */
  listForClient(tenantId: string, clientPartyId: string): Promise<readonly PortalAccessRecord[]>;

  /**
   * The grants this login holds, for resolving a session's scope.
   *
   * Returns the ROWS rather than a list of party ids, so the caller applies the
   * day itself — the same reason `listOpenForClient` takes `onDate` in G3.2. A
   * server in UTC and a firm in India disagree about what day it is for five
   * and a half hours every morning, and this value decides what a client can
   * see.
   */
  listGrants(tenantId: string, membershipId: string): Promise<readonly PortalAccess[]>;

  findById(tenantId: string, grantId: string): Promise<PortalAccess | null>;

  create(row: NewPortalAccess): Promise<PortalAccess>;

  /** Close a grant. Never a delete and never an edit of which client it names:
   *  overwriting either destroys the only record of what somebody could see,
   *  and `bib_app` holds no DELETE grant on the table anyway. */
  end(tenantId: string, grantId: string, validTo: string): Promise<PortalAccess>;
}

/**
 * The login being granted, as this use case needs to see it.
 *
 * A THIRD seam over `tenancy.membership`, beside the tenancy use case's own
 * repository and `usecase/lead`'s `StaffDirectory` — one adapter, three seams,
 * the arrangement `PostgresConfigRepository` already has. What it asks is
 * exactly what the database cannot: `crm.portal_access` has a composite foreign
 * key to the membership, so the row is guaranteed to be this firm's, and
 * nothing in SQL says it is a CLIENT_PORTAL login that still works.
 */
export interface PortalMembershipRow {
  readonly id: string;
  readonly audience: string;
  readonly isActive: boolean;
}

export interface PortalMembershipDirectory {
  findMembership(tenantId: string, membershipId: string): Promise<PortalMembershipRow | null>;
}

/** The client, as this use case needs to see it: enough to refuse a party that
 *  is not there and one the firm has put away. Structurally what
 *  `PartyRepository.findParty` returns, declared here so neither use case
 *  imports the other — G3.2's `ClientDirectory` in the same words. */
export interface PortalClientRow {
  readonly id: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
}

export interface PortalClientDirectory {
  findParty(tenantId: string, partyId: string): Promise<PortalClientRow | null>;
}
