// In-memory port fakes for the tenancy use case. One per port, `implements` the
// interface (compile-time assertion), so business rules can be tested with zero
// infrastructure. These live in src (not tests) so any module's tests can reuse
// them.
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";
import { FakeConfigRepo } from "./config";
import { FakeStaffGradeRepo } from "./staffgrade";
import type { RoleHolders } from "../usecase/config/ports";
import { NoAxesDefined } from "./serviceaxis";
import { ConfigService } from "../usecase/config/service";
import { StaffGradeService } from "../usecase/staffgrade/service";
import { WorkVocabularyService } from "../usecase/workitem/service";
import { FakeWorkVocabularyRepo } from "./workitem";
import { ObligationService } from "../usecase/obligation/service";
import {
  FakeCalendarSource,
  FakeRuleServiceLinks,
  FakeObligationExceptionRepo,
  FakeObligationInstanceRepo,
  FakeObligationServices,
  FakeCompliancePolicySource,
  FakeObligationStateRepo,
  FakeResolutionOptionRepo,
  FakeObligationTemplateRepo,
  FakeObligationTenants,
  FakeWorkItemRaiser,
} from "./obligation";
import type { CompanyCalendar, CompanyCalendars } from "../domain/calendar/model";
import type { FirmSignatoryEntry, Membership, Tenant, UserAccount } from "../domain/tenancy/model";
import type {
  ObligationRuleSeeder,
  ObligationVocabularySeeder,
  GradeDirectory,
  GradeLadderSeeder,
  WorkVocabularySeeder,
  MemberRecord,
  MembershipRepository,
  NewMembership,
  NewTenant,
  NewFirmSignatory,
  SignatoryRepository,
  IssuingEntitySeeder,
  NewUser,
  RoleDirectory,
  RoleRegistrySeeder,
  TenantRepository,
  UserRepository,
} from "../usecase/tenancy/ports";

export class FakeTenantRepo implements TenantRepository {
  readonly rows: Tenant[] = [];
  /** Each firm's zone as created, by tenant id. */
  readonly timeZones = new Map<string, string>();
  create(t: NewTenant): Promise<Tenant> {
    this.timeZones.set(t.id, t.timeZone);
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
  /** `TenantStanding`. A firm nobody seeded answers TRUE here, deliberately:
   *  most tests never create a tenant row and every one of them would otherwise
   *  start failing on a check that is not what they are about. A test that
   *  cares about suspension seeds the row and sets the status. */
  isOpen(tenantId: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === tenantId);
    return Promise.resolve(row === undefined ? true : row.status === "active");
  }
  setStatus(tenantId: string, status: "active" | "suspended"): Promise<Tenant | null> {
    const index = this.rows.findIndex((r) => r.id === tenantId);
    const current = this.rows[index];
    if (current === undefined) return Promise.resolve(null);
    const updated: Tenant = { ...current, status };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
  /** FinCompliance's switch, by tenant id (0381). Absent means off. */
  readonly finSince = new Map<string, string>();
  finEnabledSince(tenantId: string): Promise<string | null | undefined> {
    if (!this.rows.some((r) => r.id === tenantId)) return Promise.resolve(undefined);
    return Promise.resolve(this.finSince.get(tenantId) ?? null);
  }
  setFinEnabled(tenantId: string, enabled: boolean): Promise<string | null> {
    if (!enabled) {
      this.finSince.delete(tenantId);
      return Promise.resolve(null);
    }
    const since = this.finSince.get(tenantId) ?? "2026-10-10T12:00:00.000Z";
    this.finSince.set(tenantId, since);
    return Promise.resolve(since);
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

/**
 * The firm's list of signatories (0343), over the SAME tenant rows the fake
 * tenant store holds: `makeDefault` writes the tenant's pair, and renaming the
 * default's title moves the tenant's copy, as the real key's ON UPDATE CASCADE
 * does.
 */
export class FakeSignatoryRepo implements SignatoryRepository {
  readonly rows: FirmSignatoryEntry[] = [];
  /** Media types of document versions a test has "uploaded", by version id. */
  readonly versions = new Map<string, string>();
  constructor(private readonly tenants: FakeTenantRepo) {}
  list(tenantId: string): Promise<readonly FirmSignatoryEntry[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId));
  }
  find(tenantId: string, signatoryId: string): Promise<FirmSignatoryEntry | null> {
    return Promise.resolve(this.rows.find((r) => r.tenantId === tenantId && r.id === signatoryId) ?? null);
  }
  findByUser(tenantId: string, userId: string): Promise<FirmSignatoryEntry | null> {
    return Promise.resolve(this.rows.find((r) => r.tenantId === tenantId && r.userId === userId) ?? null);
  }
  add(s: NewFirmSignatory): Promise<FirmSignatoryEntry> {
    if (this.rows.some((r) => r.tenantId === s.tenantId && r.userId === s.userId)) {
      throw new Error("fake: firm_signatory_one_per_person");
    }
    const row: FirmSignatoryEntry = {
      id: s.id,
      tenantId: s.tenantId,
      userId: s.userId,
      title: s.title,
      signatureVersionId: null,
      isActive: true,
      createdAt: "2026-10-04T00:00:00.000Z",
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  update(
    tenantId: string,
    signatoryId: string,
    change: { readonly title?: string | undefined; readonly signatureVersionId?: string | null | undefined },
  ): Promise<FirmSignatoryEntry> {
    const i = this.indexOf(tenantId, signatoryId);
    const current = this.rows[i] as FirmSignatoryEntry;
    const next: FirmSignatoryEntry = {
      ...current,
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.signatureVersionId === undefined ? {} : { signatureVersionId: change.signatureVersionId }),
    };
    this.rows[i] = next;
    const tenant = this.tenants.rows.find((t) => t.id === tenantId);
    if (tenant && tenant.firmSignatoryUserId === current.userId && change.title !== undefined) {
      void this.tenants.setFirmSignatory(tenantId, current.userId, change.title);
    }
    return Promise.resolve(next);
  }
  setActive(tenantId: string, signatoryId: string, isActive: boolean): Promise<FirmSignatoryEntry> {
    const i = this.indexOf(tenantId, signatoryId);
    const next: FirmSignatoryEntry = { ...(this.rows[i] as FirmSignatoryEntry), isActive };
    this.rows[i] = next;
    return Promise.resolve(next);
  }
  async makeDefault(tenantId: string, signatoryId: string): Promise<void> {
    const row = this.rows[this.indexOf(tenantId, signatoryId)] as FirmSignatoryEntry;
    await this.tenants.setFirmSignatory(tenantId, row.userId, row.title);
  }
  versionMediaType(_tenantId: string, versionId: string): Promise<string | null> {
    return Promise.resolve(this.versions.get(versionId) ?? null);
  }
  private indexOf(tenantId: string, signatoryId: string): number {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === signatoryId);
    if (i === -1) throw new Error(`fake: no signatory ${signatoryId}`);
    return i;
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
  setDisplayName(id: string, displayName: string): Promise<UserAccount | null> {
    const index = this.rows.findIndex((r) => r.id === id);
    const current = this.rows[index];
    if (current === undefined) return Promise.resolve(null);
    const updated: UserAccount = { ...current, displayName };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }

  setStatus(id: string, status: "active" | "disabled"): Promise<UserAccount | null> {
    const index = this.rows.findIndex((r) => r.id === id);
    const current = this.rows[index];
    if (current === undefined) return Promise.resolve(null);
    const updated: UserAccount = { ...current, status };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
}

// Two ports, exactly as the Postgres adapter carries them: tenancy owns the
// roster, and the config registry asks which roles anybody actually holds.
export class FakeMembershipRepo implements MembershipRepository, RoleHolders {
  readonly rows: Membership[] = [];
  /** The accounts behind the memberships, so the roster read can join. Set by
   *  makeFakes so the fake user repo and this one see the same people. */
  users: FakeUserRepo | null = null;

  /** The ladder behind the roster join, so a member record can carry the rung's
   *  NAME rather than its id — the read model rule, held by the fake too. */
  grades: FakeStaffGradeRepo | null = null;

  create(m: NewMembership): Promise<Membership> {
    // Ungraded on arrival, like the column: a grade is a separate decision from
    // granting access, and inventing one here would hide that from every test.
    const row: Membership = { ...m, gradeId: null, reportsToUserId: null, isActive: true };
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
        const grade =
          membership.gradeId === null
            ? null
            : (this.grades?.rows.find((g) => g.id === membership.gradeId) ?? null);
        return {
          membership,
          email: user?.email ?? `${membership.userId}@unknown.invalid`,
          displayName: user?.displayName ?? null,
          grade:
            grade === null
              ? null
              : {
                  id: grade.id,
                  code: grade.code,
                  name: grade.name,
                  rank: grade.rank,
                  isActive: grade.isActive,
                },
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

  updateGrade(
    tenantId: string,
    membershipId: string,
    gradeId: string | null,
  ): Promise<Membership> {
    return Promise.resolve(this.replace(tenantId, membershipId, (r) => ({ ...r, gradeId })));
  }

  updateReportsTo(
    tenantId: string,
    membershipId: string,
    reportsToUserId: string | null,
  ): Promise<Membership> {
    return Promise.resolve(
      this.replace(tenantId, membershipId, (r) => ({ ...r, reportsToUserId })),
    );
  }

  reportingLines(tenantId: string): Promise<ReadonlyMap<string, string>> {
    // STAFF and active only, exactly as the adapter filters — a fake that is
    // laxer than the adapter is a test that passes on a rule the product does
    // not have.
    const pairs = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.audience === "STAFF" &&
          r.isActive &&
          r.reportsToUserId !== null,
      )
      .map((r): [string, string] => [r.userId, r.reportsToUserId as string]);
    return Promise.resolve(new Map(pairs));
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
  signatories: FakeSignatoryRepo;
  users: FakeUserRepo;
  memberships: FakeMembershipRepo;
  roleSeeder: RoleRegistrySeeder;
  issuingEntitySeeder: FakeIssuingEntitySeeder;
  roleDirectory: RoleDirectory;
  gradeSeeder: GradeLadderSeeder;
  gradeDirectory: GradeDirectory;
  workVocabularySeeder: WorkVocabularySeeder;
  obligationVocabularySeeder: ObligationVocabularySeeder;
  obligationRuleSeeder: ObligationRuleSeeder;
  /** The rows the seeder wrote, so a test can look at what a new firm got. */
  config: FakeConfigRepo;
  /** The rungs a new firm got, for the same reason. */
  grades: FakeStaffGradeRepo;
  /** The states and priorities a new firm got — same reason again. */
  workVocabulary: FakeWorkVocabularyRepo;
  /** The compliance rules a new firm got, so a test can assert the pack landed
   *  rather than trusting that it did. */
  obligationTemplates: FakeObligationTemplateRepo;
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
  const grades = new FakeStaffGradeRepo();
  const workVocabulary = new FakeWorkVocabularyRepo();
  const obligationTemplates = new FakeObligationTemplateRepo();
  const obligationExceptions = new FakeObligationExceptionRepo();
  obligationTemplates.exceptions = obligationExceptions;
  // ONE WORLD, as one database is (the obligation harness's own wiring): the
  // rule store writes its links through the link store in the same act, the
  // generator reaches engagements through it, and removing a link withdraws
  // calendar rows. Handing the service a link store the rule store could not
  // see made a rule written for a service answer success and link nothing.
  const obligationStates = new FakeObligationStateRepo();
  const obligationInstances = new FakeObligationInstanceRepo();
  const obligationCalendar = new FakeCalendarSource();
  const obligationServices = new FakeObligationServices();
  const obligationLinks = new FakeRuleServiceLinks();
  obligationInstances.states = obligationStates.rows;
  obligationInstances.templates = obligationTemplates;
  obligationInstances.links = obligationLinks;
  obligationInstances.engagements = obligationCalendar;
  obligationTemplates.instances = obligationInstances;
  obligationTemplates.links = obligationLinks;
  obligationCalendar.links = obligationLinks;
  obligationLinks.services = obligationServices;
  obligationLinks.calendar = obligationCalendar;
  obligationLinks.instances = obligationInstances;
  obligationLinks.templates = obligationTemplates;
  const obligations = new ObligationService({
    timeZones: new FakeFirmTimeZone(),
    templates: obligationTemplates,
    exceptions: obligationExceptions,
    states: obligationStates,
    resolutionOptions: new FakeResolutionOptionRepo(),
    instances: obligationInstances,
    compliancePolicy: new FakeCompliancePolicySource(),
    calendarSource: obligationCalendar,
    links: obligationLinks,
    services: obligationServices,
    workItems: new FakeWorkItemRaiser(),
    tenants: new FakeObligationTenants(),
    ids,
    clock: { now: () => new Date("2026-08-30T00:00:00Z") },
    events,
  });
  memberships.users = users;
  memberships.grades = grades;
  const tenants = new FakeTenantRepo();
  return {
    tenants,
    signatories: new FakeSignatoryRepo(tenants),
    users,
    memberships,
    // The REAL StaffGradeService over the in-memory ladder, on the same
    // reasoning as the config service above: a tenancy test then fails if
    // provisioning stops giving a new firm a ladder, which is the thing that
    // would leave nobody meeting the review threshold. And `gradeDirectory` is
    // the SAME store the seeder wrote to, so assigning a seeded rung works in a
    // test exactly as it does in production.
    gradeSeeder: new StaffGradeService({ grades, ids, events }),
    gradeDirectory: grades,
    grades,
    // The REAL WorkVocabularyService over an in-memory store, on the same
    // reasoning as the two above: a tenancy test then fails if provisioning
    // stops giving a new firm its work-item states, which is the thing that
    // would leave it unable to record a single task.
    workVocabularySeeder: new WorkVocabularyService({
      vocabulary: workVocabulary,
      ids,
      events,
    }),
    workVocabulary,
    // And the compliance calendar's two halves (T3.2), the REAL service over
    // in-memory stores for the third time and the same reason: a tenancy test
    // fails if provisioning stops giving a firm its obligation states (nothing
    // can be generated) or its rule pack (an empty calendar with no explanation,
    // which is the exact silence this module exists to prevent).
    obligationVocabularySeeder: obligations,
    obligationRuleSeeder: obligations,
    obligationTemplates,
    // `holders: memberships` mirrors the composition root exactly, so a tenancy
    // test exercises the real coupling between the roster and the registry
    // rather than a stub that always answers "nobody holds anything".
    roleSeeder: new ConfigService({
      registry: config,
      holders: memberships,
      axes: new NoAxesDefined(),
      ids,
      events,
    }),
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

/**
 * The firm's timezone, as a fake.
 *
 * Satisfies both `usecase/chaser`'s `FirmTimeZone` and
 * `usecase/portallibrary`'s — one fake for one answer, mirroring
 * `PostgresFirmTimeZone`, which implements both for the reason written there:
 * two answers to "which day is this instant on for this firm" would let the
 * chaser and the digest disagree.
 *
 * Defaults to UTC, which is what every firm gets before it chooses, so a test
 * that does not care about zones behaves exactly as it did before 0071.
 */
export class FakeFirmTimeZone {
  /** The companies that keep their own zone or year (0337); none by default,
   *  so every company is on the firm's exactly as before. */
  private readonly companies = new Map<string, CompanyCalendar>();

  constructor(private zone = "UTC") {}

  set(zone: string): void {
    this.zone = zone;
  }

  /** Give one company its own zone and/or year; null fields are the firm's. */
  setCompany(partyId: string, calendar: Partial<CompanyCalendar>): void {
    this.companies.set(partyId, { timeZone: null, fiscalYearStartMonth: null, ...calendar });
  }

  timeZoneFor(): Promise<string> {
    return Promise.resolve(this.zone);
  }

  companyCalendars(): Promise<CompanyCalendars> {
    return Promise.resolve(new Map(this.companies));
  }
}
