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
  | "INVALID_AUDIENCE"
  | "SLUG_TAKEN"
  | "EMAIL_TAKEN"
  | "TENANT_NOT_FOUND"
  | "USER_NOT_FOUND";

export class InvalidSlug extends TenancyError {
  constructor(slug: string) {
    super("INVALID_SLUG", `tenant slug ${JSON.stringify(slug)} is not url-safe lowercase (2-40 chars)`);
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
