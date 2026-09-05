// The tenancy use case — orchestration + business rules against ports. No I/O,
// no SQL, no HTTP: every outside thing arrives as an injected port, so this
// reads like a description of what the business does and is testable with
// in-memory fakes and zero infrastructure.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { Membership, Tenant, UserAccount } from "../../domain/tenancy/model";
import {
  activeMemberships,
  hasActiveAdministrator,
  isAudience,
  isValidSlug,
  normalizeEmail,
  rosterAfter,
} from "../../domain/tenancy/model";
import { ADMIN_PERMISSION } from "../../domain/authz/model";
import { isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import {
  EmailTaken,
  InvalidAudience,
  InvalidCurrency,
  InvalidSlug,
  LastAdministrator,
  MembershipExists,
  MembershipNotFound,
  RoleNotDefined,
  SignatoryNotAMember,
  SlugTaken,
  TenantNotFound,
  UserNotFound,
} from "../../domain/tenancy/errors";
// The two refusals a grade assignment owes. Tenancy owns WHO is on a rung; the
// staff-grade domain owns what a rung is and what it means to have retired one,
// so the vocabulary for refusing comes from there.
import { GradeNotAssignable, GradeNotFound } from "../../domain/staffgrade/errors";
// The reporting line exists for exactly one consumer — a `reporting_line`
// verification policy — so its rule and its refusals are owned there. Reaching
// ACROSS the domain is what the wall permits; reaching out of it is not.
import { walkReportingLine } from "../../domain/verification/model";
import { ReportsToCycle, ReportsToNotAColleague } from "../../domain/verification/errors";
import type {
  GradeDirectory,
  GradeLadderSeeder,
  WorkVocabularySeeder,
  ObligationVocabularySeeder,
  ObligationRuleSeeder,
  MemberGrade,
  IssuingEntitySeeder,
  MemberRecord,
  MembershipRepository,
  RoleDirectory,
  RoleRegistrySeeder,
  TenantRepository,
  UserRepository,
} from "./ports";

export interface Deps {
  readonly tenants: TenantRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
  /** A new firm's role definitions, written as its own config rows. */
  readonly roleSeeder: RoleRegistrySeeder;
  /** A new firm's own entity, and the fallback rule naming it as the issuer of
   *  its documents. Without it the firm cannot draft anything at all. */
  readonly issuingEntitySeeder: IssuingEntitySeeder;
  /** What this firm's roles ARE, for the two things administration must refuse:
   *  assigning a role nobody published, and removing the last administrator. */
  readonly roleDirectory: RoleDirectory;
  /** A new firm's seniority ladder, written as its own rows (G3.3). */
  readonly gradeSeeder: GradeLadderSeeder;
  readonly workVocabularySeeder: WorkVocabularySeeder;
  readonly obligationVocabularySeeder: ObligationVocabularySeeder;
  readonly obligationRuleSeeder: ObligationRuleSeeder;
  /** What this firm's rungs ARE, for the two things a grade assignment must
   *  refuse: a grade this firm never defined, and one it has retired. */
  readonly gradeDirectory: GradeDirectory;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface AddMemberInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly audience: string;
  readonly role: string;
  readonly commercialVisibility: boolean;
  /** Which platform caller granted this. See the note on the class. */
  readonly provisionedBy?: string | undefined;
}

/** Adding somebody to a firm from inside the product, by the address an admin
 *  actually knows. */
export interface InviteMemberInput {
  readonly tenantId: string;
  readonly email: string;
  readonly audience: string;
  readonly role: string;
  readonly commercialVisibility: boolean;
  /** Applied only when the account is NEW — see ensureUser. */
  readonly displayName?: string | undefined;
}

export interface ChangeMemberRoleInput {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly role: string;
}

export interface SetMemberActiveInput {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly isActive: boolean;
}

export interface ChangeMemberGradeInput {
  readonly tenantId: string;
  readonly membershipId: string;
  /** `null` takes them off the ladder — a real answer, not an omission. */
  readonly gradeId: string | null;
}

export interface SetReportsToInput {
  readonly tenantId: string;
  readonly membershipId: string;
  /** `null` clears it — a partner reports to nobody, and so does everybody at a
   *  firm that has not filled this in. */
  readonly reportsToUserId: string | null;
}

export interface SetFirmSignatoryInput {
  readonly tenantId: string;
  /** Whoever binds the firm. Must have an active STAFF membership here. */
  readonly userId: string;
  /** The capacity they sign in — "Director", "Managing Partner". Printed under
   *  their name on every letter the firm sends from now on. */
  readonly title: string;
}

/** The firm's standing signatory, with the name a letterhead prints. */
export interface FirmSignatoryRecord {
  readonly userId: string;
  readonly displayName: string | null;
  readonly title: string;
}

export class TenancyService {
  constructor(private readonly deps: Deps) {}

  // Two of these writes are recorded and one is not, and the exception is worth
  // stating: creating a global user_account (ensureUser / registerUser) has NO
  // TENANT, and every event is tenant-scoped. The fact a firm actually cares
  // about — that this person gained access to it — is membership.granted, which
  // does have one. See docs/EVENT-CONTRACT.md § "identity and the tenant".
  //
  // Provisioning runs on the platform's S2S surface with no end user behind it,
  // so these events name the system as actor rather than inventing a human.
  // `provisionedBy` carries WHICH platform caller did it: "system" alone cannot
  // be traced back to anything, and once more than one integration holds a key
  // that is the only way to answer who created a firm.

  /**
   * Register a firm as a tenant. Slug is validated and must be unique.
   *
   * The reporting currency is REQUIRED and has no default at any layer — not on
   * the wire, not here, not on the column. It is the one fact about a firm's
   * money that cannot be corrected later without silently invalidating
   * everything stored against it, so the only safe moment to insist on it is
   * the one before the firm exists.
   */
  async createTenant(
    input: {
      name: string;
      slug: string;
      reportingCurrency: string;
      provisionedBy?: string | undefined;
    },
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<Tenant> {
    if (!isValidSlug(input.slug)) throw new InvalidSlug(input.slug);
    // Normalised before it is validated, and stored normalised: "inr" and "INR"
    // are one currency to a person and two strings to Postgres.
    const reportingCurrency = normalizeCurrency(input.reportingCurrency);
    if (!isCurrencyCode(reportingCurrency)) throw new InvalidCurrency(input.reportingCurrency);
    const existing = await this.deps.tenants.findBySlug(input.slug);
    if (existing) throw new SlugTaken(input.slug);
    const tenant = await this.deps.tenants.create({
      id: this.deps.ids.newId(),
      slug: input.slug,
      name: input.name,
      reportingCurrency,
    });
    // A tenant's own creation is the first row in its own timeline. The currency
    // rides along because it is a machine fact that can never be restated: when
    // a total looks wrong years from now, this event is the record of what the
    // firm's books were denominated in on the first day.
    await this.deps.events.recordEvent({
      tenantId: tenant.id,
      verb: "tenant.created",
      objectId: tenant.id,
      actor,
      payload: {
        slug: tenant.slug,
        reportingCurrency: tenant.reportingCurrency,
        ...byline(input.provisionedBy),
      },
    });

    // Then its roles, in the same call. Gate 3 reads the firm's own role rows
    // and has no built-in table to fall back on (T2.5), so a tenant without
    // them is a tenant nobody can sign in to. Doing it here rather than in a
    // provisioning script means the two facts cannot get separated.
    //
    // The honest limit, same shape as the event ordering above: these are two
    // ports with no shared unit of work, so a failure here leaves a created,
    // audited tenant with no roles. That state is loud rather than silent —
    // every request to it answers UNKNOWN_ROLE naming exactly this cause — and
    // it is preferable to the alternative, which is a firm that appears to work
    // because gate 3 quietly fell back to permissions nobody chose.
    await this.deps.roleSeeder.seedDefaultRoles(tenant.id, actor);

    // And its seniority ladder, for the same reason and with the same honest
    // limit. A firm with no rungs is a firm where the review rule the ladder
    // exists for — "Manager or above" — has nothing to compare against, so
    // nobody meets a threshold and nothing can be signed off. Seeding it here
    // rather than in a provisioning script keeps that requirement attached to
    // the moment the firm comes into existence.
    //
    // Ordered after the roles deliberately: a firm that ends up with roles and
    // no ladder can still be administered, and an admin can add the rungs from
    // the screen. The reverse — a ladder nobody can reach because gate 3
    // refuses every request — cannot be fixed from inside the product.
    await this.deps.gradeSeeder.seedDefaultGrades(tenant.id, actor);

    // And its own words for work — the states a task moves through and the
    // priorities it can carry (T3.1). Rows rather than an enum, because the
    // vocabulary is the firm's: renaming "Waiting Internal" or deciding that
    // statutory work is Critical must be an UPDATE on a screen, not a deploy.
    // A firm with none of them cannot create a single work item, so it belongs
    // at creation for the two seeders above's reason.
    //
    // Last of the three, and the ordering is the same argument again: a firm
    // with roles, a ladder and no work vocabulary can be administered and can
    // fix it from `/admin/work-vocabulary`. The reverse cannot be fixed from
    // inside the product at all.
    await this.deps.workVocabularySeeder.seedDefaultVocabulary(tenant.id, actor);

    // The compliance calendar's two halves (T3.2), in this order: the states a
    // filing can be in, then the rules that produce filings. A rule pack loaded
    // before there is a state to generate into would be rules that cannot run.
    await this.deps.obligationVocabularySeeder.seedDefaultStates(tenant.id, actor);
    await this.deps.obligationRuleSeeder.seedIndiaRulePack(tenant.id, actor);
    // And its own entity, with the fallback rule naming it as the issuer of the
    // firm's documents — for the same reason, one step further on. Both
    // documents carry `issuing_entity_party_id NOT NULL` (0021), so a firm with
    // no preference row cannot draft a proposal, and telling a firm to
    // configure that before it can quote anybody would be a worse first day
    // than the roles problem above.
    //
    // The entity seeded is the firm ITSELF, which is right for the firm that
    // operates one company and is a starting point for the firm that operates
    // several — the note on the row says nobody chose it. The same honest limit
    // as the role seeding applies: two ports with no shared unit of work, so a
    // failure here leaves an audited tenant with roles and no issuer. That
    // state is loud (drafting refuses, naming the row that is missing) rather
    // than silent.
    const firmEntityPartyId = await this.deps.issuingEntitySeeder.seedFirmEntity(
      tenant.id,
      tenant.name,
    );
    // A party came into existence, so the ledger says so. The party module
    // records the same verb for every other party; this one is created by
    // provisioning rather than by a person, which is exactly why leaving it
    // unrecorded would make the firm's own entity the one party with no origin.
    await this.deps.events.recordEvent({
      tenantId: tenant.id,
      verb: "party.created",
      objectId: firmEntityPartyId,
      actor,
      payload: { kind: "organization", isFirmSelf: true, ...byline(input.provisionedBy) },
    });
    return tenant;
  }

  /**
   * Get the global user for an email, creating it if absent. Idempotent by
   * design (ADR-02): inviting an email that already has an account LINKS to the
   * existing person — it never creates a duplicate identity.
   */
  async ensureUser(email: string, displayName?: string): Promise<UserAccount> {
    const normalized = normalizeEmail(email);
    const existing = await this.deps.users.findByEmail(normalized);
    // A name supplied here is NOT applied to an account that already exists: the
    // person already has one, and one firm inviting them is not grounds for
    // renaming them everywhere else.
    if (existing) return existing;
    return this.deps.users.create({ id: this.deps.ids.newId(), email: normalized, displayName });
  }

  /** Register a user, failing loudly if the email is already taken. Use when a
   *  fresh identity is expected; use ensureUser when linking is intended. */
  async registerUser(email: string): Promise<UserAccount> {
    const normalized = normalizeEmail(email);
    const existing = await this.deps.users.findByEmail(normalized);
    if (existing) throw new EmailTaken(normalized);
    return this.deps.users.create({ id: this.deps.ids.newId(), email: normalized });
  }

  /** Grant a user access to a tenant, in an audience, with a role. */
  async addMember(input: AddMemberInput, actor: Actor = SYSTEM_ACTOR): Promise<Membership> {
    if (!isAudience(input.audience)) throw new InvalidAudience(input.audience);
    const tenant = await this.deps.tenants.findById(input.tenantId);
    if (!tenant) throw new TenantNotFound(input.tenantId);
    const user = await this.deps.users.findById(input.userId);
    if (!user) throw new UserNotFound(input.userId);
    // The role must be one the firm publishes — checked on THIS path too, not
    // only on the administration path below, because the provisioning surface
    // can lock somebody out exactly as easily. Every tenant has its four
    // defaults from the moment createTenant returns, so there is no window in
    // which a legitimate grant has no role to name.
    //
    // Ordered AFTER the tenant and user lookups on purpose: for a tenant that
    // does not exist, "this firm has published no roles" is a true sentence and
    // a useless one. The caller's actual mistake is the tenant id.
    await this.requireDefinedRole(input.tenantId, input.role);
    const membership = await this.deps.memberships.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      userId: input.userId,
      audience: input.audience,
      role: input.role,
      commercialVisibility: input.commercialVisibility,
    });
    // userId, not email: the address is personal data and the ledger cannot be
    // erased. Role and audience are the firm's own configuration, not personal.
    await this.deps.events.recordEvent({
      tenantId: membership.tenantId,
      verb: "membership.granted",
      objectId: membership.id,
      actor,
      payload: {
        userId: membership.userId,
        audience: membership.audience,
        role: membership.role,
        commercialVisibility: membership.commercialVisibility,
        ...byline(input.provisionedBy),
      },
    });
    return membership;
  }

  /** The org-switcher: every active membership this user holds, across tenants. */
  async resolveAccess(userId: string): Promise<readonly Membership[]> {
    const all = await this.deps.memberships.listByUser(userId);
    return activeMemberships(all);
  }

  /**
   * The account behind a user id — what a colleague calls them, and the address
   * that identifies them when nobody has said.
   *
   * BOTH HALVES, ALWAYS. `display_name` is nullable and is genuinely empty at
   * real firms, so a caller given only the name cannot tell "we hold no name for
   * this person" from "there is no person" — which is the exact collapse
   * `createdByName` and `raisedToName` were each caught making. The email is the
   * discriminator.
   */
  async account(userId: string): Promise<UserAccount | null> {
    return this.deps.users.findById(userId);
  }

  /**
   * What the firms behind these ids are CALLED.
   *
   * Every screen that names the caller's firm had only its uuid to name it
   * with — the topbar read "BiB · b35c4196", the org switcher offered "partner ·
   * b35c4196", and the session card printed two full uuids at somebody who has
   * never seen one. A uuid identifies a firm to the database; it identifies
   * nothing to the person using the product. This is what lets those screens
   * say "Kaveri & Co" instead.
   *
   * A MAP rather than a list, so a caller with three memberships resolves them
   * in one call and reads each back by id. An id with no row is simply absent —
   * the caller decides what an unnamed firm looks like, because "missing" and
   * "blank" are different answers and this is not the layer that renders them.
   *
   * `tenancy.tenant` is a GLOBAL table with no RLS on it, so this needs no
   * tenant context and works on the session that has not chosen a firm yet —
   * which is exactly the session that has to be shown a list of firm names to
   * choose from.
   */
  async tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(ids)];
    const found = await Promise.all(wanted.map(async (id) => this.deps.tenants.findById(id)));
    const names = new Map<string, string>();
    for (const tenant of found) {
      if (tenant !== null) names.set(tenant.id, tenant.name);
    }
    return names;
  }

  // ── Firm administration ─────────────────────────────────────────────────────
  //
  // Everything above is PROVISIONING: the platform creating firms and granting
  // the first access, with no end user behind it. Everything below is a firm
  // ADMINISTERING ITSELF — a real person, in a session, holding tenant:admin,
  // changing who works there. That is the half that did not exist, which is why
  // a firm could define a role and give it to nobody, and why nothing in the
  // product could stop a dismissed colleague from signing in.
  //
  // Two guards run before every write here, and both refuse states that cannot
  // be undone from inside the product:
  //
  //   the role must be PUBLISHED   — assigning one the registry does not define
  //                                  hands somebody a login that carries nothing
  //   an administrator must remain — see requireAdministratorSurvives

  /** The roster: everyone with a membership here, deactivated people included. */
  async listMembers(tenantId: string): Promise<readonly MemberRecord[]> {
    return this.deps.memberships.listMembers(tenantId);
  }

  /**
   * One membership at this firm, or null.
   *
   * Public because a second use case needs it — `PortalInviteService.resend`
   * starts from an id off a screen and has to know whose account it is, what
   * audience it is for and whether it still works before it mails anybody. The
   * tenant id is the first argument and not a convenience: `findById` filters
   * on it, which is the tenant wall stated in code as well as in RLS.
   *
   * Null rather than a throw, because the callers disagree about what a miss
   * MEANS — this service's own writes raise `MembershipNotFound`, and the
   * invite path has its own sentence to say about it.
   */
  async findMembership(tenantId: string, membershipId: string): Promise<Membership | null> {
    return this.deps.memberships.findById(tenantId, membershipId);
  }

  /**
   * Give somebody access to this firm, by email.
   *
   * By EMAIL rather than by user id, because an admin knows an address and not
   * a uuid — and because `ensureUser` makes that idempotent in the way ADR-02
   * requires: an email that already has an account LINKS to that person rather
   * than creating a second identity for them.
   */
  async inviteMember(input: InviteMemberInput, actor: Actor): Promise<Membership> {
    if (!isAudience(input.audience)) throw new InvalidAudience(input.audience);
    await this.requireDefinedRole(input.tenantId, input.role);

    const user = await this.ensureUser(input.email, input.displayName);
    // Checked rather than left to the unique constraint, which would surface as
    // an unexplained 500. Someone who is already here — even deactivated —
    // should be reinstated or have their role changed, deliberately, rather than
    // silently rewritten by an "add".
    const existing = (await this.deps.memberships.listMembers(input.tenantId)).find(
      (m) => m.membership.userId === user.id && m.membership.audience === input.audience,
    );
    if (existing) throw new MembershipExists(normalizeEmail(input.email), input.audience);

    return this.addMember(
      {
        tenantId: input.tenantId,
        userId: user.id,
        audience: input.audience,
        role: input.role,
        commercialVisibility: input.commercialVisibility,
      },
      actor,
    );
  }

  /** Change what somebody may do here. Idempotent: setting the role they already
   *  hold records nothing, because no change happened to record. */
  async changeMemberRole(input: ChangeMemberRoleInput, actor: Actor): Promise<Membership> {
    const membership = await this.memberOrThrow(input.tenantId, input.membershipId);
    await this.requireDefinedRole(input.tenantId, input.role);
    if (membership.role === input.role) return membership;
    await this.requireAdministratorSurvives(input.tenantId, membership.id, (m) => ({
      ...m,
      role: input.role,
    }));

    const updated = await this.deps.memberships.updateRole(
      input.tenantId,
      membership.id,
      input.role,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "membership.role_changed",
      objectId: membership.id,
      actor,
      payload: {
        userId: membership.userId,
        audience: membership.audience,
        from: membership.role,
        to: input.role,
      },
    });
    return updated;
  }

  /**
   * Revoke somebody's access, or give it back.
   *
   * This is the write that has been missing. `is_active` and its grant have
   * existed since migration 0001, and `resolveSession` has re-read the
   * membership on EVERY request since T1.7 so that revocation takes effect on
   * the next one rather than at token expiry — a real cost, paid per request,
   * for a switch nothing could flip. A firm that dismisses somebody this
   * afternoon can now stop their access this afternoon.
   */
  async setMemberActive(input: SetMemberActiveInput, actor: Actor): Promise<Membership> {
    const membership = await this.memberOrThrow(input.tenantId, input.membershipId);
    if (membership.isActive === input.isActive) return membership;
    // Only deactivation can strand a firm. Reinstating somebody adds an
    // administrator or is neutral; it can never remove the last one.
    if (!input.isActive) {
      await this.requireAdministratorSurvives(input.tenantId, membership.id, (m) => ({
        ...m,
        isActive: false,
      }));
    }

    const updated = await this.deps.memberships.setActive(
      input.tenantId,
      membership.id,
      input.isActive,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: input.isActive ? "membership.restored" : "membership.revoked",
      objectId: membership.id,
      actor,
      // userId and role, never the email — the address is personal data and this
      // log cannot be erased. The row it points at can.
      payload: {
        userId: membership.userId,
        audience: membership.audience,
        role: membership.role,
      },
    });
    return updated;
  }

  /**
   * Put somebody on a rung of the firm's hierarchy, or take them off it.
   *
   * The THIRD axis, and it deliberately has no interaction with the other two.
   * It does not run `requireAdministratorSurvives`: a grade grants nothing and
   * removing one strands nobody — a firm whose every member is ungraded is
   * merely a firm where nobody meets the review threshold, which is a state it
   * can see and fix. Role is what can lock a firm out, and role has its own
   * guard.
   *
   * `null` clears the grade, and that is a first-class answer rather than an
   * absence: a portal contact has no rung, and neither does somebody whose
   * designation the firm's hierarchy has never ranked. Both are more honest than
   * a grade invented to fill the column.
   *
   * Idempotent: setting the rung somebody is already on records nothing.
   */
  async changeMemberGrade(input: ChangeMemberGradeInput, actor: Actor): Promise<Membership> {
    const membership = await this.memberOrThrow(input.tenantId, input.membershipId);
    if (membership.gradeId === input.gradeId) return membership;

    let to: MemberGrade | null = null;
    if (input.gradeId !== null) {
      to = await this.deps.gradeDirectory.find(input.tenantId, input.gradeId);
      // A grade from another firm resolves to nothing here, because the
      // directory reads under this tenant's RLS context. The composite foreign
      // key in migration 0040 refuses it a second time, at the database.
      if (!to) throw new GradeNotFound(input.gradeId);
      if (!to.isActive) throw new GradeNotAssignable(to.name);
    }
    // Resolved only to name the OLD rung in the event. A retired rung still
    // resolves — that is the whole point of retiring rather than deleting one.
    const from =
      membership.gradeId === null
        ? null
        : await this.deps.gradeDirectory.find(input.tenantId, membership.gradeId);

    const updated = await this.deps.memberships.updateGrade(
      input.tenantId,
      membership.id,
      input.gradeId,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "membership.grade_changed",
      objectId: membership.id,
      actor,
      // Codes and ranks, never the person's email — the address is personal data
      // and this log cannot be erased. Codes rather than uuids because the
      // question asked of this row later is "when did they become a Manager",
      // and two uuids cannot answer it without two more lookups.
      payload: {
        userId: membership.userId,
        from: from?.code ?? null,
        to: to?.code ?? null,
        ...(to === null ? {} : { rank: to.rank }),
      },
    });
    return updated;
  }

  // ── Who binds the firm ──────────────────────────────────────────────────────
  //
  // "Unki ek hi signature rahegi" — one signatory for the whole firm, whichever
  // of its entities issues the document. It lives on the tenant row rather than
  // in the configuration registry because there is exactly one current answer
  // and no version history worth keeping: the history that matters is on the
  // LETTERS, each of which snapshots the block it went out with.
  //
  // This is deliberately NOT the same fact as who operated the system. The
  // ledger records the operator as an event's actor and always will; authority
  // to bind is an audit question about the firm, and a firm where the person
  // who presses send is the person who signs is a coincidence, not a rule.

  /** Who signs this firm's letters, with the name a letterhead prints. Null
   *  when the firm has not named anyone — a state it operates in perfectly
   *  well, with the signature block simply not printing. */
  async firmSignatory(tenantId: string): Promise<FirmSignatoryRecord | null> {
    const tenant = await this.deps.tenants.findById(tenantId);
    if (!tenant) throw new TenantNotFound(tenantId);
    if (tenant.firmSignatoryUserId === null || tenant.firmSignatoryTitle === null) return null;
    // The NAME is a read-time join, like the ledger's actor: an erased account
    // stops resolving and the letters that named it survive.
    const user = await this.deps.users.findById(tenant.firmSignatoryUserId);
    return {
      userId: tenant.firmSignatoryUserId,
      displayName: user?.displayName ?? null,
      title: tenant.firmSignatoryTitle,
    };
  }

  /**
   * Name the person who binds the firm.
   *
   * Checked against the ROSTER, not just against `user_account`: that table is
   * global, so the foreign key would happily accept a login at another firm.
   * Authority to bind is the strongest thing a person holds in this product and
   * the one requirement worth stating is that they work here.
   *
   * STAFF only, and active only. A client-portal membership is a client, and a
   * revoked one is somebody who used to work here.
   *
   * There is no way to CLEAR it, deliberately: a firm that has named a
   * signatory and then unnames one has letters going out with a blank block
   * again, which is the defect this exists to fix. A successor is an UPDATE,
   * which is the whole reason it is a row.
   */
  async setFirmSignatory(input: SetFirmSignatoryInput, actor: Actor): Promise<FirmSignatoryRecord> {
    const tenant = await this.deps.tenants.findById(input.tenantId);
    if (!tenant) throw new TenantNotFound(input.tenantId);

    const title = input.title.trim();
    if (title === "") throw new SignatoryNotAMember(input.userId);

    const roster = await this.deps.memberships.listMembers(input.tenantId);
    const member = roster.find(
      (m) =>
        m.membership.userId === input.userId &&
        m.membership.audience === "STAFF" &&
        m.membership.isActive,
    );
    if (!member) throw new SignatoryNotAMember(input.userId);

    await this.deps.tenants.setFirmSignatory(input.tenantId, input.userId, title);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "firm_signatory.set",
      objectId: input.tenantId,
      actor,
      // userId and the CAPACITY, never the name or the address: the first two
      // are machine facts about the firm's own configuration and the last two
      // are personal data in a log that cannot be erased.
      payload: { userId: input.userId, title },
    });
    // The name comes back with the write — the roster read above is already
    // holding it, and the caller is a screen that has to render what it just
    // changed.
    return { userId: input.userId, displayName: member.displayName, title };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Say who somebody reports to, or clear it (T2.9).
   *
   * A FOURTH axis, and like the grade it grants nothing — one thing reads it, a
   * `reporting_line` verification policy deciding who may check this person's
   * work. It runs no `requireAdministratorSurvives` for the same reason the
   * grade does not: clearing a reporting line locks nobody out, it merely means
   * a firm on that rule has one fewer eligible checker, which is a state it can
   * see on the queue and fix.
   *
   * Two things ARE refused, and both are refusals a database cannot make:
   *
   *   A MANAGER WHO IS NOT A COLLEAGUE. The foreign key points at
   *   `tenancy.user_account`, which is GLOBAL — identity is above tenant
   *   (ADR-02) — so the database will happily accept a stranger's id. Checked
   *   against this firm's own active staff instead.
   *
   *   A LOOP. `a -> b -> a` leaves nobody in it with a manager who could check
   *   their work, and it is silent: the queue simply never offers anybody. The
   *   database refuses only the one-person case (`membership_reports_to_is_not_self`),
   *   because a CHECK sees one row.
   *
   * Idempotent: setting the manager somebody already has records nothing.
   */
  async setReportsTo(input: SetReportsToInput, actor: Actor): Promise<Membership> {
    const membership = await this.memberOrThrow(input.tenantId, input.membershipId);
    if (membership.reportsToUserId === input.reportsToUserId) return membership;

    if (input.reportsToUserId !== null) {
      const roster = await this.deps.memberships.listMembers(input.tenantId);
      const manager = roster.find(
        (m) =>
          m.membership.userId === input.reportsToUserId &&
          m.membership.audience === "STAFF" &&
          m.membership.isActive,
      );
      // A client-portal contact is deliberately not a candidate. Putting one in
      // the firm's reporting line would make a client eligible to check the
      // firm's work under a `reporting_line` policy.
      if (!manager) throw new ReportsToNotAColleague(input.reportsToUserId);

      const lines = await this.deps.memberships.reportingLines(input.tenantId);
      const cycle = walkReportingLine(lines, membership.userId, input.reportsToUserId);
      if (cycle !== null) throw new ReportsToCycle(cycle);
    }

    const updated = await this.deps.memberships.updateReportsTo(
      input.tenantId,
      membership.id,
      input.reportsToUserId,
    );
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "membership.reports_to_changed",
      objectId: membership.id,
      actor,
      // Ids, never an email address — the address is personal data and this log
      // cannot be erased. Both sides, because "when did Priya move under Anand"
      // is the question this row is asked later.
      payload: {
        userId: membership.userId,
        from: membership.reportsToUserId,
        to: input.reportsToUserId,
      },
    });
    return updated;
  }

  private async memberOrThrow(tenantId: string, membershipId: string): Promise<Membership> {
    const membership = await this.deps.memberships.findById(tenantId, membershipId);
    if (!membership) throw new MembershipNotFound(membershipId);
    return membership;
  }

  private async requireDefinedRole(tenantId: string, role: string): Promise<void> {
    const defined = await this.deps.roleDirectory.knownRoles(tenantId);
    if (!defined.includes(role)) throw new RoleNotDefined(role, defined);
  }

  /**
   * Refuse a change that would leave the firm with nobody able to administer it.
   *
   * Asked about the roster the firm WOULD have, not the one it has, so the same
   * check serves a role change and a deactivation — including an administrator
   * acting on themselves, which is the ordinary way this happens.
   *
   * The registry has its own version of this guard (a role set where no role
   * carries the permission). These are two routes to one unrecoverable state:
   * there, the permission stops existing; here, the last person holding it does.
   */
  private async requireAdministratorSurvives(
    tenantId: string,
    membershipId: string,
    change: (m: Membership) => Membership,
  ): Promise<void> {
    const [roster, adminRoles] = await Promise.all([
      this.deps.memberships.listMembers(tenantId),
      this.deps.roleDirectory.rolesWith(tenantId, ADMIN_PERMISSION),
    ]);
    const after = rosterAfter(
      roster.map((r) => r.membership),
      membershipId,
      change,
    );
    if (!hasActiveAdministrator(after, new Set(adminRoles))) {
      throw new LastAdministrator(ADMIN_PERMISSION);
    }
  }
}

/** The provisioning caller's name, when there is one. A machine fact — the
 *  name of an integration, never a person — so it is safe in the ledger. */
function byline(provisionedBy: string | undefined): Record<string, string> {
  return provisionedBy === undefined ? {} : { provisionedBy };
}
