// In-memory port fakes for the tenancy use case. One per port, `implements` the
// interface (compile-time assertion), so business rules can be tested with zero
// infrastructure. These live in src (not tests) so any module's tests can reuse
// them.
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";
import { FakeConfigRepo } from "./config";
import type { RoleHolders } from "../usecase/config/ports";
import { ConfigService } from "../usecase/config/service";
import type { Membership, Tenant, UserAccount } from "../domain/tenancy/model";
import type {
  MemberRecord,
  MembershipRepository,
  NewMembership,
  NewTenant,
  IssuingEntitySeeder,
  NewUser,
  RoleDirectory,
  RoleRegistrySeeder,
  TenantRepository,
  UserRepository,
} from "../usecase/tenancy/ports";

export class FakeTenantRepo implements TenantRepository {
  readonly rows: Tenant[] = [];
  create(t: NewTenant): Promise<Tenant> {
    const row: Tenant = {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: "active",
      reportingCurrency: t.reportingCurrency,
      // A new firm has named nobody. What the product does about that is the
      // service's business, not the store's.
      firmSignatoryUserId: null,
      firmSignatoryTitle: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  findBySlug(slug: string): Promise<Tenant | null> {
    return Promise.resolve(this.rows.find((r) => r.slug === slug) ?? null);
  }
  findById(id: string): Promise<Tenant | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  setFirmSignatory(tenantId: string, userId: string, title: string): Promise<Tenant> {
    const index = this.rows.findIndex((r) => r.id === tenantId);
    const current = this.rows[index];
    if (index === -1 || current === undefined) throw new Error(`fake: no tenant ${tenantId}`);
    const updated: Tenant = {
      ...current,
      firmSignatoryUserId: userId,
      firmSignatoryTitle: title,
    };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
}

export class FakeUserRepo implements UserRepository {
  readonly rows: UserAccount[] = [];
  create(u: NewUser): Promise<UserAccount> {
    const row: UserAccount = {
      id: u.id,
      email: u.email,
      displayName: u.displayName ?? null,
      status: "active",
    };
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

// Two ports, exactly as the Postgres adapter carries them: tenancy owns the
// roster, and the config registry asks which roles anybody actually holds.
export class FakeMembershipRepo implements MembershipRepository, RoleHolders {
  readonly rows: Membership[] = [];
  /** The accounts behind the memberships, so the roster read can join. Set by
   *  makeFakes so the fake user repo and this one see the same people. */
  users: FakeUserRepo | null = null;

  create(m: NewMembership): Promise<Membership> {
    const row: Membership = { ...m, isActive: true };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  listByUser(userId: string): Promise<Membership[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId));
  }

  rolesInUse(tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...new Set(this.rows.filter((r) => r.tenantId === tenantId && r.isActive).map((r) => r.role))].sort(),
    );
  }

  listMembers(tenantId: string): Promise<readonly MemberRecord[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === tenantId)
      .map((membership) => {
        const user = this.users?.rows.find((u) => u.id === membership.userId);
        return {
          membership,
          email: user?.email ?? `${membership.userId}@unknown.invalid`,
          displayName: user?.displayName ?? null,
        };
      });
    return Promise.resolve(rows);
  }

  findById(tenantId: string, membershipId: string): Promise<Membership | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === membershipId) ?? null,
    );
  }

  updateRole(tenantId: string, membershipId: string, role: string): Promise<Membership> {
    return Promise.resolve(this.replace(tenantId, membershipId, (r) => ({ ...r, role })));
  }

  setActive(tenantId: string, membershipId: string, isActive: boolean): Promise<Membership> {
    return Promise.resolve(this.replace(tenantId, membershipId, (r) => ({ ...r, isActive })));
  }

  private replace(
    tenantId: string,
    membershipId: string,
    change: (m: Membership) => Membership,
  ): Membership {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === membershipId);
    const current = this.rows[index];
    if (!current) throw new Error(`fake roster: no membership ${membershipId}`);
    const next = change(current);
    this.rows[index] = next;
    return next;
  }
}

export function makeFakes(): {
  tenants: FakeTenantRepo;
  users: FakeUserRepo;
  memberships: FakeMembershipRepo;
  roleSeeder: RoleRegistrySeeder;
  issuingEntitySeeder: FakeIssuingEntitySeeder;
  roleDirectory: RoleDirectory;
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
  // set, which is the thing that would lock every one of its people out. The
  // same registry answers the role questions administration asks, so a test
  // that publishes a role sees it become assignable.
  const config = new FakeConfigRepo();
  const users = new FakeUserRepo();
  const memberships = new FakeMembershipRepo();
  memberships.users = users;
  return {
    tenants: new FakeTenantRepo(),
    users,
    memberships,
    // `holders: memberships` mirrors the composition root exactly, so a tenancy
    // test exercises the real coupling between the roster and the registry
    // rather than a stub that always answers "nobody holds anything".
    roleSeeder: new ConfigService({ registry: config, holders: memberships, ids, events }),
    // Every firm owns an issuing entity from the moment it exists, exactly as
    // it owns a role set. A tenancy test therefore fails if provisioning stops
    // giving a new firm one, which is the thing that would leave it unable to
    // draft a proposal at all.
    issuingEntitySeeder: new FakeIssuingEntitySeeder(ids),
    roleDirectory: config,
    config,
    ids,
    events,
  };
}

/** The firm's own entity, created with the firm. Records what it made so a
 *  test can assert the tenant got one rather than trusting that it did. */
export class FakeIssuingEntitySeeder implements IssuingEntitySeeder {
  readonly seeded: { tenantId: string; firmName: string; partyId: string }[] = [];

  constructor(private readonly ids: FakeIds) {}

  seedFirmEntity(tenantId: string, firmName: string): Promise<string> {
    const partyId = this.ids.newId();
    this.seeded.push({ tenantId, firmName, partyId });
    return Promise.resolve(partyId);
  }
}
