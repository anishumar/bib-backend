// Sentinel errors — the closed vocabulary of ways tenancy operations fail.
// They live in the domain so the meaning is owned here; the api layer maps them
// to HTTP status codes (domainerr.ts). Adapters translate their own failures
// INTO these; never the reverse. Match with `instanceof`, never string search.

export class TenancyError extends Error {
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type TenancyErrorCode =
  | "INVALID_SLUG"
  | "INVALID_CURRENCY"
  | "INVALID_AUDIENCE"
  | "SLUG_TAKEN"
  | "EMAIL_TAKEN"
  | "TENANT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_EXISTS"
  | "ROLE_NOT_DEFINED"
  | "LAST_ADMINISTRATOR"
  | "SIGNATORY_NOT_A_MEMBER";

export class InvalidSlug extends TenancyError {
  constructor(slug: string) {
    super("INVALID_SLUG", `tenant slug ${JSON.stringify(slug)} is not url-safe lowercase (2-40 chars)`);
  }
}
export class InvalidCurrency extends TenancyError {
  constructor(currency: string) {
    // The valid set here is "any ISO 4217 alphabetic code", which is not a list
    // worth printing — so the message names the SHAPE and two real examples
    // rather than 180 codes nobody will read.
    super(
      "INVALID_CURRENCY",
      `reporting currency ${JSON.stringify(currency)} is not an ISO 4217 code — three letters, ` +
        `like "INR" or "AED". It is what this firm's books are kept in, and it cannot be changed ` +
        `afterwards, because every exchange rate stored later is struck against it.`,
    );
  }
}
export class InvalidAudience extends TenancyError {
  constructor(audience: string) {
    super("INVALID_AUDIENCE", `audience ${JSON.stringify(audience)} must be STAFF or CLIENT_PORTAL`);
  }
}
export class SlugTaken extends TenancyError {
  constructor(slug: string) {
    super("SLUG_TAKEN", `a tenant with slug ${JSON.stringify(slug)} already exists`);
  }
}
export class EmailTaken extends TenancyError {
  constructor(email: string) {
    super("EMAIL_TAKEN", `a user with email ${JSON.stringify(email)} already exists`);
  }
}
export class TenantNotFound extends TenancyError {
  constructor(ref: string) {
    super("TENANT_NOT_FOUND", `no tenant for ${JSON.stringify(ref)}`);
  }
}
export class UserNotFound extends TenancyError {
  constructor(ref: string) {
    super("USER_NOT_FOUND", `no user for ${JSON.stringify(ref)}`);
  }
}
export class MembershipNotFound extends TenancyError {
  constructor(ref: string) {
    super("MEMBERSHIP_NOT_FOUND", `no membership ${JSON.stringify(ref)} at this firm`);
  }
}
export class MembershipExists extends TenancyError {
  constructor(email: string, audience: string) {
    // Deliberately not "add" doubling as "reinstate". Somebody who is already
    // here — even deactivated — should be reinstated or have their role changed
    // as a decision, not have it happen as a side effect of being re-added.
    super(
      "MEMBERSHIP_EXISTS",
      `${JSON.stringify(email)} already has ${audience} access to this firm. To change what they ` +
        `may do, change their role; if their access was revoked, reinstate it.`,
    );
  }
}
export class RoleNotDefined extends TenancyError {
  constructor(role: string, defined: readonly string[]) {
    // Assigning a role the registry does not publish would recreate the
    // UNKNOWN_ROLE lockout by hand: the person signs in, carries nothing, and
    // the firm reads it as the product being broken.
    super(
      "ROLE_NOT_DEFINED",
      defined.length === 0
        ? `this firm has published no roles, so there is none to assign. Its configuration ` +
          `registry was never seeded — every member is locked out until it is.`
        : `${JSON.stringify(role)} is not a role this firm has published, so assigning it would ` +
          `leave the person able to sign in and do nothing. This firm's roles: ${defined.join(", ")}. ` +
          `Define it in the configuration registry first, or pick one of these.`,
    );
  }
}
export class SignatoryNotAMember extends TenancyError {
  constructor(userId: string) {
    // A foreign key cannot say this: tenancy.user_account is GLOBAL, so the
    // column can point at any login on the installation. Authority to bind the
    // firm is the strongest thing a person can hold here, and the one check
    // that matters is that they actually work here.
    super(
      "SIGNATORY_NOT_A_MEMBER",
      `user ${JSON.stringify(userId)} has no active staff membership at this firm, so they ` +
        `cannot be named as the person who binds it. Whoever signs the firm's engagement ` +
        `letters has to work here — add them to the roster first, or reinstate their access.`,
    );
  }
}

export class LastAdministrator extends TenancyError {
  constructor(adminPermission: string) {
    super(
      "LAST_ADMINISTRATOR",
      `this would leave the firm with nobody who can administer it — no active member holding a ` +
        `role that carries ${JSON.stringify(adminPermission)}. That permission is what lets anyone ` +
        `change roles or memberships at all, including undoing this, so nobody could put it back ` +
        `from inside the product. Give somebody else an administrator role first.`,
    );
  }
}
