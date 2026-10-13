// The property this whole task exists to restore, proven against real Postgres
// and a real session: **a firm can stop somebody's access, and it takes effect
// on their next request.**
//
// Not on their next login, and not at token expiry. `resolveSession`
// (usecase/identity/service.ts) re-reads the membership on EVERY request
// precisely so that revocation is immediate — a cost this codebase has been
// paying per request since T1.7 for a switch nothing could flip until now. A
// unit test can show the service calls setActive; only a real session against a
// real database can show that the next request is actually refused.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresTenantRepository } from "../../src/infrastructure/postgres/tenant-repository";
import { PostgresSignatoryRepository } from "../../src/infrastructure/postgres/signatory-repository";
import { PostgresUserRepository } from "../../src/infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import {
  PostgresCredentialRepository,
  PostgresMagicLinkRepository,
  PostgresSessionRepository,
} from "../../src/infrastructure/postgres/identity-repository";
import { ScryptPasswordHasher } from "../../src/infrastructure/crypto/scrypt-hasher";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { StaffGradeService } from "../../src/usecase/staffgrade/service";
import { WorkVocabularyService } from "../../src/usecase/workitem/service";
import { PostgresWorkVocabularyRepository } from "../../src/infrastructure/postgres/work-vocabulary-repository";
import { PostgresStaffGradeRepository } from "../../src/infrastructure/postgres/staff-grade-repository";
import { IdentityService } from "../../src/usecase/identity/service";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { withTenant } from "../../src/db/tenant";
import { LastAdministrator } from "../../src/domain/tenancy/errors";
import {
  PostgresObligationExceptionRepository,
  PostgresObligationStateRepository,
  PostgresResolutionOptionRepository,
  PostgresObligationTemplateRepository,
} from "../../src/infrastructure/postgres/obligation-rule-repository";
import {
  PostgresCalendarSource,
  PostgresObligationInstanceRepository,
} from "../../src/infrastructure/postgres/obligation-instance-repository";
import { PostgresRuleServiceLinkRepository } from "../../src/infrastructure/postgres/obligation-link-repository";
import { ObligationService } from "../../src/usecase/obligation/service";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const staffGradeRepository = new PostgresStaffGradeRepository(app);
const users = new PostgresUserRepository(app);
const memberships = new PostgresMembershipRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: memberships,
  axes: new PostgresServiceAxisRepository(app),
  ids: systemIds,
  events: ledger,
});

const staffGrades = new StaffGradeService({
  grades: staffGradeRepository,
  ids: systemIds,
  events: ledger,
});

// T3.2's seeder, built once and passed as both ports — they are two methods on
// one service, and constructing it twice would give a firm two rule packs.
const obligationServiceForSeeding = new ObligationService({
  timeZones: new FakeFirmTimeZone(),
  templates: new PostgresObligationTemplateRepository(app),
  exceptions: new PostgresObligationExceptionRepository(app),
  states: new PostgresObligationStateRepository(app),
  resolutionOptions: new PostgresResolutionOptionRepository(app),
  instances: new PostgresObligationInstanceRepository(app),
  links: new PostgresRuleServiceLinkRepository(app),
  compliancePolicy: configRepository,
  calendarSource: new PostgresCalendarSource(app),
  services: configRepository,
  // Nothing in a provisioning test raises a task, so the raiser refuses rather
  // than pretending — a fake that silently returned an id would let a broken
  // wiring pass.
  workItems: {
    raiseForObligation: () => Promise.reject(new Error("not used in this test")),
  },
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const tenancy = new TenancyService({
  tenants: new PostgresTenantRepository(app),
  users,
  memberships,
  roleSeeder: { seedDefaultRoles: (t, a) => config.seedDefaultRoles(t, a) },
  // Every firm gets its own entity and the fallback naming it as the issuer of
  // its documents, in the same call — the real adapter, because what this test
  // provisions has to be a firm that could actually draft a proposal.
  issuingEntitySeeder: new PostgresDocumentRepository(app),
  roleDirectory: configRepository,
  gradeSeeder: { seedDefaultGrades: (t, a) => staffGrades.seedDefaultGrades(t, a) },
  gradeDirectory: staffGradeRepository,
  signatories: new PostgresSignatoryRepository(app),
  // T3.1. The real service over the real table, like the two seeders above:
  // provisioning that stopped giving a firm its work-item states would leave it
  // unable to record a single task, and this test is what would catch it.
  // T3.2. The real service over the real tables, on the same reasoning: a firm
  // provisioned without obligation STATES cannot have a filing generated at
  // all, and one without RULES gets an empty calendar with nothing explaining
  // why — which is the exact silence the coverage screen exists to break.
  obligationVocabularySeeder: obligationServiceForSeeding,
  obligationRuleSeeder: obligationServiceForSeeding,
  workVocabularySeeder: new WorkVocabularyService({
    vocabulary: new PostgresWorkVocabularyRepository(app),
    ids: systemIds,
    events: ledger,
  }),
  ids: systemIds,
  events: ledger,
});

const identity = new IdentityService({
  users,
  memberships,
  tenants: new PostgresTenantRepository(app),
  credentials: new PostgresCredentialRepository(app),
  sessions: new PostgresSessionRepository(app),
  magicLinks: new PostgresMagicLinkRepository(app),
  passwords: new ScryptPasswordHasher(),
  tokens: new RandomTokenFactory(),
  mailer: {
    sendMagicLink: () => Promise.resolve(),
    sendPortalInvite: () => Promise.resolve(),
    sendStaffWelcome: () => Promise.resolve(),
    sendPortalWelcome: () => Promise.resolve(),
    sendPasswordReset: () => Promise.resolve(),
  },
  ids: systemIds,
  clock: systemClock,
  events: ledger,
  attempts: new InMemoryRateLimiter(systemClock),
  magicLinkBaseUrl: "http://localhost:3000",
});

const stamp = String(Date.now());
const PASSWORD = "correct horse battery staple";
const adminEmail = `admin-${stamp}@harbour.example`;
const colleagueEmail = `colleague-${stamp}@harbour.example`;

let tenantId = "";
let adminMembershipId = "";
let colleagueMembershipId = "";
/** The colleague's live session token — the thing revocation has to kill. */
let colleagueToken = "";

beforeAll(async () => {
  const tenant = await tenancy.createTenant({
    name: "Harbour Point",
    slug: `admin-test-${stamp}`,
    reportingCurrency: "INR",
  });
  tenantId = tenant.id;

  const admin = await tenancy.ensureUser(adminEmail, "Anita Rao");
  const adminMembership = await tenancy.addMember({
    tenantId,
    userId: admin.id,
    audience: "STAFF",
    role: "partner",
    commercialVisibility: true,
  });
  adminMembershipId = adminMembership.id;

  const colleague = await tenancy.inviteMember(
    {
      tenantId,
      email: colleagueEmail,
      audience: "STAFF",
      role: "associate",
      commercialVisibility: false,
      displayName: "Rahul Iyer",
    },
    SYSTEM_ACTOR,
  );
  colleagueMembershipId = colleague.id;

  await identity.setPassword(colleague.userId, PASSWORD);
  const session = await identity.login(colleagueEmail, PASSWORD);
  colleagueToken = session.token;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the roster, against real rows", () => {
  it("joins each membership to the account behind it", async () => {
    const roster = await tenancy.listMembers(tenantId);
    const rahul = roster.find((r) => r.email === colleagueEmail);
    expect(rahul?.displayName).toBe("Rahul Iyer");
    expect(rahul?.membership.role).toBe("associate");
  });

  it("is one firm's roster and nobody else's", async () => {
    // RLS, on the membership side of the join. user_account is global and has
    // none of its own — the join is safe only because the membership side is
    // filtered, which is exactly what this asserts.
    const other = await tenancy.createTenant({
      name: "Somebody Else",
      slug: `admin-test-other-${stamp}`,
      reportingCurrency: "INR",
    });
    expect(await tenancy.listMembers(other.id)).toEqual([]);
  });
});

describe("a new firm's calendar (audit 2026-10-03, F07)", () => {
  it("is stored as its country settled it, and UTC when nothing did", async () => {
    const india = await tenancy.createTenant({
      name: "Sharma Mehta",
      slug: `admin-test-in-${stamp}`,
      reportingCurrency: "INR",
      country: "IN",
    });
    const usa = await tenancy.createTenant({
      name: "Hudson",
      slug: `admin-test-us-${stamp}`,
      reportingCurrency: "USD",
      country: "US",
    });
    const rows = await owner<{ id: string; time_zone: string }[]>`
      SELECT id, time_zone FROM tenancy.tenant WHERE id IN (${india.id}, ${usa.id})
    `;
    expect(new Map(rows.map((r) => [r.id, r.time_zone]))).toEqual(
      new Map([
        [india.id, "Asia/Kolkata"],
        [usa.id, "UTC"],
      ]),
    );
  });
});

describe("revocation reaches a live session", () => {
  it("the colleague's session works before anything is revoked", async () => {
    const principal = await identity.resolveSession(colleagueToken);
    expect(principal?.role).toBe("associate");
    expect(principal?.tenantId).toBe(tenantId);
  });

  it("a role change is visible to the very next request", async () => {
    // Gate 3 reads the role out of the same membership read that checks
    // revocation, so a promotion lands immediately too.
    await tenancy.changeMemberRole(
      { tenantId, membershipId: colleagueMembershipId, role: "manager" },
      SYSTEM_ACTOR,
    );
    const principal = await identity.resolveSession(colleagueToken);
    expect(principal?.role).toBe("manager");
  });

  it("a fee change is visible to the very next request, and leaves the role alone", async () => {
    await tenancy.setMemberFees(
      { tenantId, membershipId: colleagueMembershipId, commercialVisibility: true },
      SYSTEM_ACTOR,
    );
    let principal = await identity.resolveSession(colleagueToken);
    expect(principal?.commercialVisibility).toBe(true);
    expect(principal?.role).toBe("manager");
    await tenancy.setMemberFees(
      { tenantId, membershipId: colleagueMembershipId, commercialVisibility: false },
      SYSTEM_ACTOR,
    );
    principal = await identity.resolveSession(colleagueToken);
    expect(principal?.commercialVisibility).toBe(false);
  });

  it("REVOKING ACCESS STOPS THE NEXT REQUEST", async () => {
    // The whole point. The token is unchanged and unexpired; the session row is
    // untouched. What changed is one boolean on the membership, and the session
    // resolver re-reads it every time.
    await tenancy.setMemberActive(
      { tenantId, membershipId: colleagueMembershipId, isActive: false },
      SYSTEM_ACTOR,
    );

    const principal = await identity.resolveSession(colleagueToken);
    // Still a valid session for a real person — they simply have no access to
    // this firm any more. tenantId and role fall away, which is what every
    // business route checks with scopeOf().
    expect(principal?.tenantId).toBeNull();
    expect(principal?.role).toBeNull();
  });

  it("and restoring it brings them back, on the next request again", async () => {
    await tenancy.setMemberActive(
      { tenantId, membershipId: colleagueMembershipId, isActive: true },
      SYSTEM_ACTOR,
    );
    const principal = await identity.resolveSession(colleagueToken);
    expect(principal?.tenantId).toBe(tenantId);
    expect(principal?.role).toBe("manager");
  });
});

describe("the firm keeps an administrator, against real rows", () => {
  it("refuses to revoke the last one", async () => {
    await expect(
      tenancy.setMemberActive(
        { tenantId, membershipId: adminMembershipId, isActive: false },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(LastAdministrator);
  });

  it("reads 'who can administer' from the firm's own published roles", async () => {
    // Not from a hardcoded list of role names: the check asks the config
    // registry which roles carry tenant:admin, so a firm that renames or
    // reshapes its roles gets an answer about ITS roles.
    expect(await configRepository.rolesWith(tenantId, "tenant:admin")).toEqual(["partner"]);

    await config.define(
      {
        tenantId,
        kind: "role",
        key: "office-admin",
        body: { label: "Office administrator", permissions: ["tenant:admin", "config:read"] },
      },
      SYSTEM_ACTOR,
    );
    await config.publish({ tenantId, kind: "role", key: "office-admin", version: 1 }, SYSTEM_ACTOR);
    expect(await configRepository.rolesWith(tenantId, "tenant:admin")).toEqual([
      "office-admin",
      "partner",
    ]);
  });

  it("still refuses while the new admin role is on nobody's membership", async () => {
    // The gap the registry's own guard cannot see: the permission exists, but
    // no active member holds a role carrying it. Phase 2 closes the other half
    // of this — for now, the roster refuses its side.
    await expect(
      tenancy.setMemberActive(
        { tenantId, membershipId: adminMembershipId, isActive: false },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBeInstanceOf(LastAdministrator);
  });

  it("allows it once somebody actually holds the new role", async () => {
    await tenancy.changeMemberRole(
      { tenantId, membershipId: colleagueMembershipId, role: "office-admin" },
      SYSTEM_ACTOR,
    );
    await expect(
      tenancy.setMemberActive(
        { tenantId, membershipId: adminMembershipId, isActive: false },
        SYSTEM_ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it("the DATABASE refuses it too, with the service guard bypassed entirely", async () => {
    // The service's guard is a check-then-act: it reads the roster, decides,
    // and writes in a second statement. Two administrators deactivating each
    // other at the same instant both read a roster with two in it, both decide
    // one would survive, and both writes land — leaving a firm nobody can
    // administer, which is unrecoverable from inside the product because
    // configuration writes need the permission that just disappeared.
    //
    // Migration 0078 puts the same rule inside the transaction that writes.
    // This proves it by going round the service altogether — an UPDATE straight
    // at the row, which is what a concurrent writer effectively is once the
    // guard's read is stale.
    //
    // The last remaining administrator here is the colleague, who holds
    // `office-admin` after the test above.
    const err = await withTenant(app, tenantId, (db) =>
      db`UPDATE tenancy.membership SET is_active = false WHERE id = ${colleagueMembershipId}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514");

    // And the row is untouched, because the refusal happened BEFORE the write.
    const [row] = await withTenant(app, tenantId, (db) =>
      db<{ is_active: boolean }[]>`
        SELECT is_active FROM tenancy.membership WHERE id = ${colleagueMembershipId}
      `,
    );
    expect(row?.is_active).toBe(true);
  });

  it("lets through a change that takes nothing away", async () => {
    // The trigger fires only when a row STOPS being an active staff
    // administrator. Everything else has to pass untouched, or every ordinary
    // membership write would pay for a lock and a count it does not need.
    await expect(
      tenancy.changeMemberRole(
        { tenantId, membershipId: colleagueMembershipId, role: "partner" },
        SYSTEM_ACTOR,
      ),
    ).resolves.toBeDefined();
  });
});

// ── G1.4 · the firm's standing signatory, as a real row ────────────────────
//
// Its own firm, because the block above deactivates its administrator on the
// way out and this one needs a roster that still works.

describe("who binds the firm", () => {
  let firmId = "";
  let partnerId = "";

  beforeAll(async () => {
    const tenant = await tenancy.createTenant({
      name: "Lakeview Advisors",
      slug: `signatory-test-${stamp}`,
      reportingCurrency: "INR",
    });
    firmId = tenant.id;
    const partner = await tenancy.ensureUser(
      `signatory-${stamp}@lakeview.example`,
      "Siddharth Jain",
    );
    partnerId = partner.id;
    await tenancy.addMember({
      tenantId: firmId,
      userId: partnerId,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
  });

  it("starts empty and survives a round trip", async () => {
    expect(await tenancy.firmSignatory(firmId)).toBeNull();
    await tenancy.setFirmSignatory(
      { tenantId: firmId, userId: partnerId, title: "Director" },
      SYSTEM_ACTOR,
    );
    const named = await tenancy.firmSignatory(firmId);
    expect(named).toMatchObject({ userId: partnerId, displayName: "Siddharth Jain", title: "Director" });
    // And the default is an entry on the list (0343), not a bare pair.
    const list = await tenancy.listSignatories(firmId);
    expect(list.map((s) => [s.userId, s.title, s.isDefault])).toEqual([[partnerId, "Director", true]]);
    expect(named?.signatoryId).toBe(list[0]?.id);
  });

  it("refuses half a signatory, as the OWNER role", async () => {
    // The same all-or-nothing property the letter's own block has. A name with
    // no capacity cannot be printed under "Yours sincerely", and a capacity
    // with no name is nobody — so neither is representable, whichever role is
    // writing.
    for (const statement of [
      owner`
        UPDATE tenancy.tenant SET firm_signatory_user_id = ${partnerId}, firm_signatory_title = NULL
        WHERE id = ${firmId}
      `,
      owner`
        UPDATE tenancy.tenant SET firm_signatory_user_id = NULL, firm_signatory_title = 'Director'
        WHERE id = ${firmId}
      `,
      owner`UPDATE tenancy.tenant SET firm_signatory_title = '   ' WHERE id = ${firmId}`,
    ]) {
      const err = await statement.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23514"); // check_violation
    }
  });

  it("refuses a signatory who is not a real account", async () => {
    // The foreign key is all a GLOBAL table can offer here; that the person
    // actually works at this firm is the service's check, proven in the unit
    // tests. Both are needed and neither substitutes for the other.
    const err = await owner`
      UPDATE tenancy.tenant
         SET firm_signatory_user_id = '11111111-1111-4111-8111-111111111111',
             firm_signatory_title = 'Director'
       WHERE id = ${firmId}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  // ── 0343: the list, and the key that holds the default onto it ─────────────

  it("refuses, in the schema, a default who is not on the list", async () => {
    // Two places, one fact: the tenant's pair is a key onto the list, so even
    // the OWNER role cannot name a default the list does not hold.
    const stranger = await tenancy.ensureUser(`unlisted-${stamp}@lakeview.example`, "Not Listed");
    const err = await owner`
      UPDATE tenancy.tenant SET firm_signatory_user_id = ${stranger.id}, firm_signatory_title = 'Director'
       WHERE id = ${firmId}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("moves the tenant's copy when the default's title changes on the list", async () => {
    const [entry] = await tenancy.listSignatories(firmId);
    if (!entry) throw new Error("the round trip above should have listed the partner");
    await tenancy.changeSignatory({ tenantId: firmId, signatoryId: entry.id, title: "Managing Director" }, SYSTEM_ACTOR);
    const [row] = await owner<{ firm_signatory_title: string }[]>`
      SELECT firm_signatory_title FROM tenancy.tenant WHERE id = ${firmId}
    `;
    expect(row?.firm_signatory_title).toBe("Managing Director");
  });

  it("is one firm's list and nobody else's", async () => {
    // tenantId is the firm the roster block above provisioned: under ITS wall,
    // this firm's signatories do not exist.
    const theirs = await withTenant(app, tenantId, (db) =>
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM tenancy.firm_signatory WHERE tenant_id = ${firmId}`,
    );
    expect(theirs[0]?.n).toBe(0);
    const ours = await withTenant(app, firmId, (db) =>
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM tenancy.firm_signatory`,
    );
    expect(ours[0]?.n).toBeGreaterThan(0);
  });
});
