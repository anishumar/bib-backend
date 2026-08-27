// The ports this use case needs from the world — the seams. If you want to know
// what tenancy requires of infrastructure, this is the file. Interfaces are
// owned by the use case that needs them (never a shared top-level ports pkg),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { Membership, Tenant, UserAccount } from "../../domain/tenancy/model";

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
