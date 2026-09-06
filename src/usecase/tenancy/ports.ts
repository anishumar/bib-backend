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
  /**
   * Suspend a firm, or let it back in. Null when there is no such firm.
   *
   * The writer `status` did not have. The column shipped in 0001 and nothing
   * ever set it, so an operator could believe a firm was suspended while every
   * one of its sessions kept working. `IdentityService` is the reader — see
   * `TenantStanding`.
   */
  setStatus(tenantId: string, status: "active" | "suspended"): Promise<Tenant | null>;
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
  /**
   * Disable an account across the platform, or let it back in. Null when there
   * is no such account.
   *
   * NOT `setMemberActive`, which ends access to ONE firm. Identity is above
   * tenant: this says the person may not sign in anywhere. `status` was checked
   * at login from the day it existed and had no writer, which made it a comment
   * rather than a control.
   */
  setStatus(id: string, status: "active" | "disabled"): Promise<UserAccount | null>;
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
  /**
   * The rung, resolved — not the `gradeId` the membership carries.
   *
   * The read model carries NAMES, not just ids: a roster that returned a uuid
   * would leave the screen fetching a grade per row to render a column, which
   * is the exact mistake this codebase has now made and fixed five times
   * (MemberRecord's own email, LeadRecord, ProposalRecord, party 360's
   * relationships, the ledger's actor). `rank` rides along because the screen
   * that shows seniority is also the one that sorts by it.
   *
   * Null when the person has no grade — a portal contact, or somebody whose
   * designation the firm's hierarchy has never ranked.
   */
  readonly grade: MemberGrade | null;
}

/** A rung as a roster row shows it. A projection of the staff-grade aggregate,
 *  named in tenancy's own vocabulary so neither module imports the other. */
export interface MemberGrade {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  /** Whether the firm still promotes through it. A roster shows a retired rung
   *  as retired rather than hiding it — the person really is on it. */
  readonly isActive: boolean;
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
  /** Put somebody on a rung, or take them off it (`null`). The third axis
   *  (G3.3) — independent of role and of fee visibility. */
  updateGrade(
    tenantId: string,
    membershipId: string,
    gradeId: string | null,
  ): Promise<Membership>;
  /**
   * Set who somebody reports to, or clear it (`null`). The FOURTH axis (T2.9),
   * and like the grade it grants nothing — it is read by one thing, a
   * `reporting_line` verification policy deciding who may check this person's
   * work.
   */
  updateReportsTo(
    tenantId: string,
    membershipId: string,
    reportsToUserId: string | null,
  ): Promise<Membership>;
  /**
   * The reporting line as a set of `(userId -> managerUserId)` pairs, for the
   * whole firm.
   *
   * Read whole rather than one at a time, because the two callers both need it
   * that way: the cycle check walks a chain, and the queue asks "who may check
   * this" for a screenful of steps at once. A lookup per row is the mistake this
   * codebase has now made and fixed five times.
   */
  reportingLines(tenantId: string): Promise<ReadonlyMap<string, string>>;
}

/**
 * The firm's seniority ladder, as tenancy needs to see it.
 *
 * Tenancy owns `membership` and therefore owns who is on which rung, but it
 * must not own what a rung IS. Two things it has to refuse: assigning a grade
 * this firm has never defined, and assigning one the firm has stopped promoting
 * through. Declared here in tenancy's vocabulary; the staff-grade adapter
 * satisfies it, so neither module imports the other — the same seam, for the
 * same reason, as `RoleDirectory` above.
 */
export interface GradeDirectory {
  /** The rung, or null when this firm has no such grade. */
  find(tenantId: string, gradeId: string): Promise<MemberGrade | null>;
}

/**
 * Giving a brand-new firm its own seniority ladder.
 *
 * The same shape and the same argument as `RoleRegistrySeeder` below: it is part
 * of CREATING a tenant rather than a follow-up step, because a firm with an
 * empty ladder is a firm where nobody meets the review threshold — the rule the
 * ladder exists for ("Manager or above") has nothing to compare against.
 * Satisfied by StaffGradeService.seedDefaultGrades in the composition root.
 */
export interface GradeLadderSeeder {
  /** Returns the grade codes written, for the caller's audit trail. */
  seedDefaultGrades(tenantId: string, actor: Actor): Promise<readonly string[]>;
}

/**
 * Giving a brand-new firm its own words for work (T3.1).
 *
 * The same shape and the same argument as the two seeders around it: work-item
 * STATES and PRIORITIES are rows, so the firm can rename "Blocked" or decide
 * that statutory work is Critical without a deploy — and a firm with none of
 * them cannot create a single work item, because there is no state to create it
 * in and no priority to give it.
 *
 * Ordered LAST of the three, deliberately. A firm that ends up with roles, a
 * ladder and no work vocabulary can still be administered and can fix it from
 * the screen; the reverse cannot be fixed from inside the product.
 *
 * Satisfied by `WorkVocabularyService.seedDefaultVocabulary` in the composition
 * root, so neither module imports the other.
 */
export interface WorkVocabularySeeder {
  /** Returns the state and priority codes written, for the caller's audit
   *  trail. Empty when the firm already had them — the seeder is idempotent,
   *  because `createTenant` and it share no unit of work. */
  seedDefaultVocabulary(tenantId: string, actor: Actor): Promise<readonly string[]>;
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
/**
 * A new firm's obligation STATES — the `ObligationService.seedDefaultStates`
 * seam, and it is here for `WorkVocabularySeeder`'s reason.
 *
 * A firm with no state marked as the starting one cannot have a single filing
 * generated. Telling it to go and configure that before the compliance calendar
 * will do anything would be a worse first day than the roles problem, and the
 * firm has not been asked what to call these anyway.
 */
export interface ObligationVocabularySeeder {
  seedDefaultStates(tenantId: string, actor: Actor): Promise<number>;
}

/**
 * A new firm's compliance RULES — the shipped India pack.
 *
 * THE OTHER HALF OF THE SILENCE CURE. A firm with no rules has an empty
 * calendar and nothing on any screen explaining why, which is indistinguishable
 * from broken software. Fifty-seven rules arrive at creation: ten produce dates
 * and the rest say, by name, what they are still waiting on from the firm.
 *
 * Idempotent on a rule's identity, so it never overwrites one a partner has
 * since confirmed or given a lead time to.
 */
export interface ObligationRuleSeeder {
  seedIndiaRulePack(tenantId: string, actor: Actor): Promise<number>;
}

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
