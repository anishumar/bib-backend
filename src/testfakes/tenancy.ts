// In-memory port fakes for the tenancy use case. One per port, `implements` the
// interface (compile-time assertion), so business rules can be tested with zero
// infrastructure. These live in src (not tests) so any module's tests can reuse
// them.
import type { IdGen } from "../platform/ids";
import type { Membership, Tenant, UserAccount } from "../domain/tenancy/model";
import type {
  MembershipRepository,
  NewMembership,
  NewTenant,
  NewUser,
  TenantRepository,
  UserRepository,
} from "../usecase/tenancy/ports";

export class FakeIds implements IdGen {
  private n = 0;
  newId(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
  derivedId(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }
}

export class FakeTenantRepo implements TenantRepository {
  readonly rows: Tenant[] = [];
  create(t: NewTenant): Promise<Tenant> {
    const row: Tenant = { id: t.id, slug: t.slug, name: t.name, status: "active" };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  findBySlug(slug: string): Promise<Tenant | null> {
    return Promise.resolve(this.rows.find((r) => r.slug === slug) ?? null);
  }
  findById(id: string): Promise<Tenant | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
}

export class FakeUserRepo implements UserRepository {
  readonly rows: UserAccount[] = [];
  create(u: NewUser): Promise<UserAccount> {
    const row: UserAccount = { id: u.id, email: u.email, status: "active" };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  findByEmail(email: string): Promise<UserAccount | null> {
    return Promise.resolve(this.rows.find((r) => r.email === email) ?? null);
  }
  findById(id: string): Promise<UserAccount | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
}

export class FakeMembershipRepo implements MembershipRepository {
  readonly rows: Membership[] = [];
  create(m: NewMembership): Promise<Membership> {
    const row: Membership = { ...m, isActive: true };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  listByUser(userId: string): Promise<Membership[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId));
  }
}

export function makeFakes(): {
  tenants: FakeTenantRepo;
  users: FakeUserRepo;
  memberships: FakeMembershipRepo;
  ids: FakeIds;
} {
  return {
    tenants: new FakeTenantRepo(),
    users: new FakeUserRepo(),
    memberships: new FakeMembershipRepo(),
    ids: new FakeIds(),
  };
}
