// Sentinel errors: the closed vocabulary of ways a notification act fails (0323).
// Owned in the domain; `api/domainerr.ts` maps them to HTTP status codes.
// Match with `instanceof`, never by string. Every sentence says what to do.

export class NotifyError extends Error {
  constructor(
    readonly code: NotifyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type NotifyErrorCode = "NOTIFICATION_NOT_FOUND" | "NOTIFICATION_LOCKED" | "NOTIFICATION_SETTINGS_EMPTY";

/**
 * Not yours, not this firm's, or not there. One answer for all three on
 * purpose: telling them apart would tell a caller that an id they guessed
 * belongs to somebody else.
 */
export class NotificationNotFound extends NotifyError {
  constructor() {
    super("NOTIFICATION_NOT_FOUND", "That notification was not found.");
  }
}

/** The bell for a mandatory category cannot be switched off. */
export class NotificationLocked extends NotifyError {
  constructor(label: string) {
    super(
      "NOTIFICATION_LOCKED",
      `"${label}" always shows in the bell and cannot be switched off. You can still switch off its email.`,
    );
  }
}

/** A settings change that names nothing to change. */
export class NotificationSettingsEmpty extends NotifyError {
  constructor() {
    super("NOTIFICATION_SETTINGS_EMPTY", "Choose at least one setting to change.");
  }
}
