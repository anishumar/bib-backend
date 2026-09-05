// Sentinel errors — the closed vocabulary of ways the chaser and the freeze
// fail. Owned here in the domain; `api/domainerr.ts` maps them to HTTP status
// codes. Match with `instanceof`, never by string.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`.

export class ChaserError extends Error {
  constructor(
    readonly code: ChaserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ChaserErrorCode =
  | "FREEZE_CLIENT_NOT_FOUND"
  | "FREEZE_REASON_REQUIRED"
  | "FREEZE_INVALID_DATES"
  | "FREEZE_ALREADY_IN_FORCE"
  | "FREEZE_NOT_FOUND"
  | "FREEZE_ALREADY_LIFTED";

export class FreezeClientNotFound extends ChaserError {
  constructor(clientPartyId: string) {
    super(
      "FREEZE_CLIENT_NOT_FOUND",
      `No client ${JSON.stringify(clientPartyId)} at this firm. A freeze is on a CLIENT — the ` +
        `board's own case is a client in a dispute, not one task that has gone quiet.`,
    );
  }
}

export class FreezeReasonRequired extends ChaserError {
  constructor() {
    super(
      "FREEZE_REASON_REQUIRED",
      `A freeze needs a reason. "Why is this client not being chased" is asked months later by ` +
        `somebody who did not set it, and a freeze with no reason cannot be told apart from one ` +
        `nobody remembered to lift.`,
    );
  }
}

export class FreezeInvalidDates extends ChaserError {
  constructor(validFrom: string, validTo: string | null) {
    super(
      "FREEZE_INVALID_DATES",
      `The dates ${JSON.stringify(validFrom)} and ${JSON.stringify(validTo)} do not ` +
        `describe a freeze. validTo is the FIRST DAY NOT IN FORCE, so freezing needs it LATER ` +
        `than validFrom — a freeze in force on no day reads as "frozen" and stops nothing. ` +
        `Lifting is different: the same day is allowed there, and is how chasing stops the ` +
        `moment somebody decides it should.`,
    );
  }
}

export class FreezeAlreadyInForce extends ChaserError {
  constructor(clientName: string) {
    super(
      "FREEZE_ALREADY_IN_FORCE",
      `${clientName} is already frozen over those days. Two overlapping freezes would make "was ` +
        `this client being chased in March" answer twice, with two different reasons. Lift the ` +
        `one in force and set a new one, so the record says what actually happened.`,
    );
  }
}

export class FreezeNotFound extends ChaserError {
  constructor(freezeId: string) {
    super("FREEZE_NOT_FOUND", `No freeze ${JSON.stringify(freezeId)} at this firm`);
  }
}

export class FreezeAlreadyLifted extends ChaserError {
  constructor(freezeId: string) {
    super(
      "FREEZE_ALREADY_LIFTED",
      `Freeze ${JSON.stringify(freezeId)} has already been lifted. Lifting it again would move ` +
        `the day chasing resumed, which is the date somebody is answering questions about.`,
    );
  }
}
