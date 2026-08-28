// The ports this use case needs from the world — the seams. If you want to know
// what tenancy requires of infrastructure, this is the file. Interfaces are
// owned by the use case that needs them (never a shared top-level ports pkg),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { Membership, Tenant, UserAccount } from "../../domain/tenancy/model";
import type { Actor } from "../../domain/ledger/model";
import type { Permission } from "../../domain/authz/model";
import type { CurrencyCode } from "../../domain/money/model";

export interface NewTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Normalised and validated by the service; the adapter stores it as given.
   *  No default anywhere in the stack, the column included, so a firm cannot
   *  come into existence without somebody having said what its books are in. */
  readonly reportingCurrency: CurrencyCode;
}

// There is deliberately no updateReportingCurrency, here or anywhere above it.
// See the field's note on `Tenant`: changing it silently invalidates every rate
// already stored against it, so the absence is the design, not an omission.

export interface TenantRepository {
  create(t: NewTenant): Promise<Tenant>;
  findBySlug(slug: string): Promise<Tenant | null>;
  findById(id: string): Promise<Tenant | null>;
  /**
   * Name who binds the firm. Both fields together, because the schema will not
   * hold one without the other.
   *
   * There IS an update here, unlike `reportingCurrency` above, and the
   * difference is the point: a successor restates nothing, because every letter
   * already sent carries the signature block it went out with.
   */
  setFirmSignatory(tenantId: string, userId: string, title: string): Promise<Tenant>;
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

/**
 * A new firm's own entity, and the rule that names it as the issuer of the
 * firm's documents.
 *
 * The same shape as `RoleRegistrySeeder` and there for the same reason: a
 * proposal and an engagement letter each carry `issuing_entity_party_id NOT
 * NULL` (migration 0021), so a firm with no preference row could not draft
 * anything at all. "Configure this before you can write a proposal" is not a
 * state to hand a firm on its first day, so every tenant owns a fallback from
 * the moment it exists — and migration 0021 backfilled the firms that predate
 * it, exactly as 0005 did for roles.
 *
 * Returns the party id of the entity it created, so the caller can record that
 * a party came into existence rather than leaving it to appear from nowhere.
 */
export interface IssuingEntitySeeder {
  seedFirmEntity(tenantId: string, firmName: string): Promise<string>;
}
