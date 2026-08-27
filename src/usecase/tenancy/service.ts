// The tenancy use case — orchestration + business rules against ports. No I/O,
// no SQL, no HTTP: every outside thing arrives as an injected port, so this
// reads like a description of what the business does and is testable with
// in-memory fakes and zero infrastructure.
import type { IdGen } from "../../platform/ids";
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
}

export interface AddMemberInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly audience: string;
  readonly role: string;
  readonly commercialVisibility: boolean;
}

export class TenancyService {
  constructor(private readonly deps: Deps) {}

  /** Register a firm as a tenant. Slug is validated and must be unique. */
  async createTenant(input: { name: string; slug: string }): Promise<Tenant> {
    if (!isValidSlug(input.slug)) throw new InvalidSlug(input.slug);
    const existing = await this.deps.tenants.findBySlug(input.slug);
    if (existing) throw new SlugTaken(input.slug);
    return this.deps.tenants.create({
      id: this.deps.ids.newId(),
      slug: input.slug,
      name: input.name,
    });
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
  async addMember(input: AddMemberInput): Promise<Membership> {
    if (!isAudience(input.audience)) throw new InvalidAudience(input.audience);
    const tenant = await this.deps.tenants.findById(input.tenantId);
    if (!tenant) throw new TenantNotFound(input.tenantId);
    const user = await this.deps.users.findById(input.userId);
    if (!user) throw new UserNotFound(input.userId);
    return this.deps.memberships.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      userId: input.userId,
      audience: input.audience,
      role: input.role,
      commercialVisibility: input.commercialVisibility,
    });
  }

  /** The org-switcher: every active membership this user holds, across tenants. */
  async resolveAccess(userId: string): Promise<readonly Membership[]> {
    const all = await this.deps.memberships.listByUser(userId);
    return activeMemberships(all);
  }
}
