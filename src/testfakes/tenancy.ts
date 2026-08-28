// In-memory port fakes for the tenancy use case. One per port, `implements` the
// interface (compile-time assertion), so business rules can be tested with zero
// infrastructure. These live in src (not tests) so any module's tests can reuse
// them.
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";
import { FakeConfigRepo } from "./config";
import { ConfigService } from "../usecase/config/service";
import type { Membership, Tenant, UserAccount } from "../domain/tenancy/model";
import type {
  MembershipRepository,
  NewMembership,
  NewTenant,
  NewUser,
  RoleRegistrySeeder,
  TenantRepository,
  UserRepository,
} from "../usecase/tenancy/ports";

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
  roles: RoleRegistrySeeder;
  /** The rows the seeder wrote, so a test can look at what a new firm got. */
  config: FakeConfigRepo;
  ids: FakeIds;
  events: RecordingEventSink;
} {
  const ids = new FakeIds();
  const events = new RecordingEventSink();
  // The REAL ConfigService over an in-memory registry, not a stub that records
  // that it was asked — the same choice RecordingEventSink makes. A tenancy
  // test therefore fails if provisioning stops giving a new firm a usable role
  // set, which is the thing that would lock every one of its people out.
  const config = new FakeConfigRepo();
  return {
    tenants: new FakeTenantRepo(),
    users: new FakeUserRepo(),
    memberships: new FakeMembershipRepo(),
    roles: new ConfigService({ registry: config, ids, events }),
    config,
    ids,
    events,
  };
}
