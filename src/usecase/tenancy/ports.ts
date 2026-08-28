// The ports this use case needs from the world — the seams. If you want to know
// what tenancy requires of infrastructure, this is the file. Interfaces are
// owned by the use case that needs them (never a shared top-level ports pkg),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { Membership, Tenant, UserAccount } from "../../domain/tenancy/model";
import type { Actor } from "../../domain/ledger/model";

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

export interface MembershipRepository {
  /** Inserts under the tenant's RLS context (WITH CHECK tenant_id). */
  create(m: NewMembership): Promise<Membership>;
  /** Reads a user's memberships ACROSS tenants — the org-switch, run under the
   *  identity RLS context, never a tenant bypass. */
  listByUser(userId: string): Promise<Membership[]>;
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
