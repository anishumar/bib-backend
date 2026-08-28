// The ports this use case needs from the world — the seams. If you want to know
// what tenancy requires of infrastructure, this is the file. Interfaces are
// owned by the use case that needs them (never a shared top-level ports pkg),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { Membership, Tenant, UserAccount } from "../../domain/tenancy/model";
import type { Actor } from "../../domain/ledger/model";
import type { Permission } from "../../domain/authz/model";

export interface NewTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface TenantRepository {
  create(t: NewTenant): Promise<Tenant>;
  findBySlug(slug: string): Promise<Tenant | null>;
  findById(id: string): Promise<Tenant | null>;
}

export interface NewUser {
  readonly id: string;
  readonly email: string;
  /** Optional: an account is perfectly usable without one, and the roster falls
   *  back to the email rather than inventing a name. */
  readonly displayName?: string | undefined;
}

export interface UserRepository {
  create(u: NewUser): Promise<UserAccount>;
  findByEmail(email: string): Promise<UserAccount | null>;
  findById(id: string): Promise<UserAccount | null>;
}

export interface NewMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly audience: Membership["audience"];
  readonly role: string;
  readonly commercialVisibility: boolean;
}

/**
 * One row of the roster: the membership, plus who it belongs to.
 *
 * A joined read model rather than a bare membership, because a roster that
 * returned `userId` would leave every screen fetching the account behind each
 * row — N+1 lookups for a list whose whole purpose is to show people. Same shape
 * as `PublishedEntry` in the config registry, for the same reason.
 */
export interface MemberRecord {
  readonly membership: Membership;
  readonly email: string;
  readonly displayName: string | null;
}

export interface MembershipRepository {
  /** Inserts under the tenant's RLS context (WITH CHECK tenant_id). */
  create(m: NewMembership): Promise<Membership>;
  /** Reads a user's memberships ACROSS tenants — the org-switch, run under the
   *  identity RLS context, never a tenant bypass. */
  listByUser(userId: string): Promise<Membership[]>;

  /** The roster, including DEACTIVATED members: an admin needs to see who was
   *  removed, and be able to put them back. */
  listMembers(tenantId: string): Promise<readonly MemberRecord[]>;
  findById(tenantId: string, membershipId: string): Promise<Membership | null>;
  updateRole(tenantId: string, membershipId: string, role: string): Promise<Membership>;
  /**
   * The switch that has been missing since T1.7.
   *
   * `resolveSession` re-reads `is_active` on EVERY request precisely so that
   * revoking access takes effect on the next one rather than at token expiry.
   * The column and the grant have existed since 0001; nothing ever wrote them.
   */
  setActive(tenantId: string, membershipId: string, isActive: boolean): Promise<Membership>;
}

/**
 * What the firm's roles are, and what they carry.
 *
 * Tenancy needs this to refuse two things it could otherwise do quietly: assign
 * a role the registry has never published (the person signs in carrying
 * nothing), and remove the last member who can administer the firm. Declared
 * here in tenancy's own vocabulary; the config adapter satisfies it, so neither
 * module imports the other.
 */
export interface RoleDirectory {
  /** The roles this firm has PUBLISHED. A draft is not yet a role. */
  knownRoles(tenantId: string): Promise<readonly string[]>;
  /**
   * The roles carrying one permission — one query, rather than one per role.
   * Used to ask "which roles here can administer the firm" without the service
   * having to know how a role stores its permissions.
   */
  rolesWith(tenantId: string, permission: Permission): Promise<readonly string[]>;
}

/**
 * Giving a brand-new firm its own role definitions.
 *
 * Tenancy needs this and does not want to know what a config row is, so the
 * seam is here rather than a direct call into the configuration registry. The
 * composition root satisfies it with ConfigService.seedDefaultRoles.
 *
 * It is part of CREATING a tenant, not a follow-up step, because gate 3 reads
 * the firm's own role rows and nothing else: a firm without them is a firm
 * nobody can sign in to. Making it a port keeps that requirement visible here
 * instead of buried in provisioning scripts.
 */
export interface RoleRegistrySeeder {
  /** Returns the role keys written, for the caller's audit trail. */
  seedDefaultRoles(tenantId: string, actor: Actor): Promise<readonly string[]>;
}
