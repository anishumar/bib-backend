// Sentinel errors — the closed vocabulary of ways a configuration change fails.
// Owned here in the domain; the api layer maps them to HTTP status codes
// (domainerr.ts). Match with `instanceof`, never by string.
//
// Every message names the thing, the bad value and the valid set, because these
// are read by a partner editing their own firm's setup, not by an engineer with
// the schema open.

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ConfigErrorCode =
  | "INVALID_KIND"
  | "INVALID_KEY"
  | "INVALID_BODY"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_EXISTS"
  | "VERSION_NOT_FOUND"
  | "VERSION_NOT_DRAFT"
  | "WOULD_LOCK_OUT_ADMINISTRATION";

export class InvalidKind extends ConfigError {
  constructor(kind: string, valid: readonly string[]) {
    super(
      "INVALID_KIND",
      `${JSON.stringify(kind)} is not a kind of configuration this product has. ` +
        `Valid: ${valid.join(", ")}. A new kind needs a body validator, so it is a code change.`,
    );
  }
}

export class InvalidKey extends ConfigError {
  constructor(key: string) {
    super(
      "INVALID_KEY",
      `${JSON.stringify(key)} is not a usable key. A key is a stable, url-safe handle — ` +
        `lowercase letters, digits, and single - or _ between them, like "gst-filing". ` +
        `The name people read goes in the body, where it can be changed freely.`,
    );
  }
}

export class InvalidBody extends ConfigError {
  constructor(kind: string, problem: string) {
    super("INVALID_BODY", `this ${kind} configuration is not valid: ${problem}`);
  }
}

export class EntryNotFound extends ConfigError {
  constructor(kind: string, key: string) {
    super("ENTRY_NOT_FOUND", `this firm has no ${kind} configuration called ${JSON.stringify(key)}`);
  }
}

export class EntryExists extends ConfigError {
  constructor(kind: string, key: string) {
    super(
      "ENTRY_EXISTS",
      `this firm already has a ${kind} called ${JSON.stringify(key)}. ` +
        `To change it, add a version to it rather than defining it again.`,
    );
  }
}

export class VersionNotFound extends ConfigError {
  constructor(ref: string) {
    super("VERSION_NOT_FOUND", `no configuration version ${ref}`);
  }
}

export class VersionNotDraft extends ConfigError {
  constructor(ref: string, status: string) {
    super(
      "VERSION_NOT_DRAFT",
      `${ref} is ${status}, and only a draft can be published. A published version is frozen ` +
        `because running work may be pinned to it — add a new version instead.`,
    );
  }
}

export class WouldLockOutAdministration extends ConfigError {
  constructor(role: string, adminPermission: string) {
    super(
      "WOULD_LOCK_OUT_ADMINISTRATION",
      `publishing this would leave no role in the firm carrying ${JSON.stringify(adminPermission)}, ` +
        `and that permission is what lets anyone change configuration at all — including this. ` +
        `Nobody could undo it from inside the product. Give another role ${JSON.stringify(adminPermission)} ` +
        `first, or keep it on ${JSON.stringify(role)}.`,
    );
  }
}
