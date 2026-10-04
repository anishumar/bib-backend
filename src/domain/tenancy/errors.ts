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
  | "INVALID_DISPLAY_NAME"
  | "INVALID_SLUG"
  | "INVALID_CURRENCY"
  | "INVALID_AUDIENCE"
  | "INVALID_TIME_ZONE"
  | "INVALID_COUNTRY"
  | "SLUG_TAKEN"
  | "EMAIL_TAKEN"
  | "TENANT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_EXISTS"
  | "ROLE_NOT_DEFINED"
  | "LAST_ADMINISTRATOR"
  | "SIGNATORY_NOT_A_MEMBER"
  | "SIGNATORY_NOT_FOUND"
  | "SIGNATORY_ALREADY_LISTED"
  | "SIGNATORY_RETIRED"
  | "DEFAULT_SIGNATORY_CANNOT_RETIRE"
  | "INVALID_SIGNATORY_TITLE"
  | "SIGNATURE_NOT_DRAWABLE";

export class InvalidSlug extends TenancyError {
  constructor(slug: string) {
    super("INVALID_SLUG", `Tenant slug ${JSON.stringify(slug)} is not url-safe lowercase (2-40 chars)`);
  }
}
export class InvalidCurrency extends TenancyError {
  constructor(currency: string) {
    // The valid set here is "any ISO 4217 alphabetic code", which is not a list
    // worth printing — so the message names the SHAPE and two real examples
    // rather than 180 codes nobody will read.
    super(
      "INVALID_CURRENCY",
      `Reporting currency ${JSON.stringify(currency)} is not an ISO 4217 code: three letters, ` +
        `like "INR" or "AED". It is what this firm's books are kept in, and it cannot be changed ` +
        `afterwards, because every exchange rate stored later is struck against it.`,
    );
  }
}
/** A zone named at provisioning that this runtime does not know, or an
 *  offset (`+05:30`), which cannot follow daylight saving (`isTimeZone`). */
export class InvalidTimeZone extends TenancyError {
  constructor(timeZone: string) {
    super(
      "INVALID_TIME_ZONE",
      `Time zone ${JSON.stringify(timeZone)} is not a zone name this server knows, like ` +
        `"Asia/Kolkata" or "Europe/London". An offset such as "+05:30" is refused: it cannot ` +
        `follow daylight saving.`,
    );
  }
}

/** A country named at provisioning that is not an ISO 3166-1 alpha-2 code. */
export class InvalidCountry extends TenancyError {
  constructor(country: string) {
    super(
      "INVALID_COUNTRY",
      `Country ${JSON.stringify(country)} is not a two-letter ISO 3166-1 code, like "IN" or "AE".`,
    );
  }
}

export class InvalidAudience extends TenancyError {
  constructor(audience: string) {
    super("INVALID_AUDIENCE", `Audience ${JSON.stringify(audience)} must be STAFF or CLIENT_PORTAL`);
  }
}
export class SlugTaken extends TenancyError {
  constructor(slug: string) {
    super("SLUG_TAKEN", `A tenant with slug ${JSON.stringify(slug)} already exists`);
  }
}
export class EmailTaken extends TenancyError {
  constructor(email: string) {
    super("EMAIL_TAKEN", `A user with email ${JSON.stringify(email)} already exists`);
  }
}
export class TenantNotFound extends TenancyError {
  constructor(ref: string) {
    super("TENANT_NOT_FOUND", `No tenant for ${JSON.stringify(ref)}`);
  }
}
export class UserNotFound extends TenancyError {
  constructor(ref: string) {
    super("USER_NOT_FOUND", `No user for ${JSON.stringify(ref)}`);
  }
}
export class MembershipNotFound extends TenancyError {
  constructor(ref: string) {
    super("MEMBERSHIP_NOT_FOUND", `No membership ${JSON.stringify(ref)} at this firm`);
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
          `registry was never seeded: every member is locked out until it is.`
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
      `User ${JSON.stringify(userId)} has no active staff membership at this firm, so they ` +
        `cannot be named as the person who binds it. Whoever signs the firm's engagement ` +
        `letters has to work here: add them to the roster first, or reinstate their access.`,
    );
  }
}

/** No signatory with this id on this firm's list (0343). */
export class SignatoryNotFound extends TenancyError {
  constructor(signatoryId: string) {
    super("SIGNATORY_NOT_FOUND", `No signatory ${JSON.stringify(signatoryId)} on this firm's list.`);
  }
}

/** The person is already on the list. One entry per person, so the dropdown
 *  on a letter never offers the same partner twice. */
export class SignatoryAlreadyListed extends TenancyError {
  constructor(displayName: string) {
    super(
      "SIGNATORY_ALREADY_LISTED",
      `${displayName} is already on the list of signatories. Change their title there instead.`,
    );
  }
}

/** A retired signatory cannot be chosen for a new letter, and a draft that
 *  chose one cannot be sent until somebody else is chosen. */
export class SignatoryRetired extends TenancyError {
  constructor(displayName: string) {
    super(
      "SIGNATORY_RETIRED",
      `${displayName} no longer signs for the firm. Choose another signatory, or reinstate ` +
        `them on Your firm.`,
    );
  }
}

/** The default is who signs every letter nobody chose for, and who the owner
 *  rule falls back to; retiring them would leave both pointing at a person who
 *  no longer signs. Name another default first. */
export class DefaultSignatoryCannotRetire extends TenancyError {
  constructor(displayName: string) {
    super(
      "DEFAULT_SIGNATORY_CANNOT_RETIRE",
      `${displayName} is the firm's default signatory. Make someone else the default first, ` +
        `then retire them.`,
    );
  }
}

export class InvalidSignatoryTitle extends TenancyError {
  constructor() {
    super(
      "INVALID_SIGNATORY_TITLE",
      `Say what they sign as, for example "Director" or "Managing Partner". It is printed ` +
        `under their name on the letter.`,
    );
  }
}

/** The renderer draws PNG and JPEG only; anything else would store fine and
 *  then vanish from every letter with nothing saying so. */
export class SignatureNotDrawable extends TenancyError {
  constructor(mediaType: string) {
    super(
      "SIGNATURE_NOT_DRAWABLE",
      `A signature has to be a PNG or JPEG image to print on a letter, and this file is ` +
        `${JSON.stringify(mediaType)}.`,
    );
  }
}

export class LastAdministrator extends TenancyError {
  constructor(adminPermission: string) {
    super(
      "LAST_ADMINISTRATOR",
      `This would leave the firm with nobody who can administer it: no active member holding a ` +
        `role that carries ${JSON.stringify(adminPermission)}. That permission is what lets anyone ` +
        `change roles or memberships at all, including undoing this, so nobody could put it back ` +
        `from inside the product. Give somebody else an administrator role first.`,
    );
  }
}

/** Your own name, blank or too long (V2.5). */
export class InvalidDisplayName extends TenancyError {
  constructor(max: number) {
    super("INVALID_DISPLAY_NAME", `Give your name, up to ${String(max)} characters.`);
  }
}
