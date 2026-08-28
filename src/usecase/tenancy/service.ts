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
  isAudience,
  isValidSlug,
  normalizeEmail,
} from "../../domain/tenancy/model";
import {
  EmailTaken,
  InvalidAudience,
  InvalidSlug,
  SlugTaken,
  TenantNotFound,
  UserNotFound,
} from "../../domain/tenancy/errors";
import type {
  MembershipRepository,
  TenantRepository,
  UserRepository,
} from "./ports";

export interface Deps {
  readonly tenants: TenantRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
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

  /** Register a firm as a tenant. Slug is validated and must be unique. */
  async createTenant(
    input: { name: string; slug: string; provisionedBy?: string | undefined },
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<Tenant> {
    if (!isValidSlug(input.slug)) throw new InvalidSlug(input.slug);
    const existing = await this.deps.tenants.findBySlug(input.slug);
    if (existing) throw new SlugTaken(input.slug);
    const tenant = await this.deps.tenants.create({
      id: this.deps.ids.newId(),
      slug: input.slug,
      name: input.name,
    });
    // A tenant's own creation is the first row in its own timeline.
    await this.deps.events.recordEvent({
      tenantId: tenant.id,
      verb: "tenant.created",
      objectId: tenant.id,
      actor,
      payload: { slug: tenant.slug, ...byline(input.provisionedBy) },
    });
    return tenant;
  }

  /**
   * Get the global user for an email, creating it if absent. Idempotent by
   * design (ADR-02): inviting an email that already has an account LINKS to the
   * existing person — it never creates a duplicate identity.
   */
  async ensureUser(email: string): Promise<UserAccount> {
    const normalized = normalizeEmail(email);
    const existing = await this.deps.users.findByEmail(normalized);
    if (existing) return existing;
    return this.deps.users.create({ id: this.deps.ids.newId(), email: normalized });
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
}

/** The provisioning caller's name, when there is one. A machine fact — the
 *  name of an integration, never a person — so it is safe in the ledger. */
function byline(provisionedBy: string | undefined): Record<string, string> {
  return provisionedBy === undefined ? {} : { provisionedBy };
}
