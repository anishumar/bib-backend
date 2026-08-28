// Sentinel errors — the closed vocabulary of ways an event can be refused.
// Every one of them means the CALLING SERVICE built a bad event, not that a
// user sent a bad request: the api layer therefore maps them to 500/INTERNAL
// (see api/domainerr.ts), where they are logged with the offending verb rather
// than blamed on the client.
//
// Messages name the variable, the bad value, and the valid set — an operator
// reading one at 3 a.m. should not need this file open.

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type LedgerErrorCode =
  | "UNKNOWN_VERB"
  | "INVALID_ACTOR"
  | "INVALID_OBJECT_ID"
  | "INVALID_TENANT_ID"
  | "INVALID_OCCURRED_AT"
  | "PAYLOAD_CONTAINS_PII"
  | "PAYLOAD_TOO_LARGE"
  | "PAYLOAD_TOO_DEEP"
  | "PAYLOAD_NOT_SERIALISABLE";

export class UnknownVerb extends LedgerError {
  constructor(verb: string, nearMisses: readonly string[]) {
    const hint =
      nearMisses.length > 0
        ? `registered verbs on "${verb.split(".")[0] ?? verb}" are: ${nearMisses.join(", ")}`
        : "no registered verb shares that subject";
    super(
      "UNKNOWN_VERB",
      `verb ${JSON.stringify(verb)} is not in the event registry; ${hint}. ` +
        `Add it to EVENT_VERBS in domain/ledger/model.ts and to docs/EVENT-CONTRACT.md.`,
    );
  }
}

export class InvalidActor extends LedgerError {
  constructor(type: string, id: string | null) {
    super(
      "INVALID_ACTOR",
      `actor {type: ${JSON.stringify(type)}, id: ${id === null ? "null" : JSON.stringify(id)}} is not usable: ` +
        `'human' and 'agent' must carry a uuid id, and only 'system' may have a null id.`,
    );
  }
}

export class InvalidObjectId extends LedgerError {
  /** `context` is the verb being recorded, or the object type being read. */
  constructor(context: string, objectId: string) {
    super(
      "INVALID_OBJECT_ID",
      `objectId ${JSON.stringify(objectId)} for ${JSON.stringify(context)} is not a uuid; ` +
        `every event names the row it happened to.`,
    );
  }
}

export class InvalidTenantId extends LedgerError {
  constructor(tenantId: string) {
    super("INVALID_TENANT_ID", `tenantId ${JSON.stringify(tenantId)} is not a uuid`);
  }
}

export class InvalidOccurredAt extends LedgerError {
  constructor(value: string) {
    super(
      "INVALID_OCCURRED_AT",
      `occurredAt ${JSON.stringify(value)} is not an ISO 8601 timestamp with an offset ` +
        `(e.g. 2026-03-31T18:30:00Z); a local time without an offset is ambiguous across jurisdictions.`,
    );
  }
}

export class PayloadContainsPii extends LedgerError {
  constructor(verb: string, keyPath: string) {
    super(
      "PAYLOAD_CONTAINS_PII",
      `payload for ${JSON.stringify(verb)} carries personal data at ${JSON.stringify(keyPath)}. ` +
        `The ledger is append-only and cannot be erased: store the value in its own row and ` +
        `reference it by id here instead.`,
    );
  }
}

export class PayloadTooLarge extends LedgerError {
  constructor(verb: string, bytes: number, max: number) {
    super(
      "PAYLOAD_TOO_LARGE",
      `payload for ${JSON.stringify(verb)} is ${String(bytes)} bytes; the limit is ${String(max)}. ` +
        `An event summarises what happened — put the artefact in documents (P8) and reference it by id.`,
    );
  }
}

export class PayloadTooDeep extends LedgerError {
  constructor(verb: string, maxDepth: number) {
    super(
      "PAYLOAD_TOO_DEEP",
      `payload for ${JSON.stringify(verb)} nests deeper than ${String(maxDepth)} levels. ` +
        `Below that the personal-data scan stops looking, so a deep payload could hide one — ` +
        `flatten it to the machine facts the event is about.`,
    );
  }
}

export class PayloadNotSerialisable extends LedgerError {
  constructor(verb: string) {
    super(
      "PAYLOAD_NOT_SERIALISABLE",
      `payload for ${JSON.stringify(verb)} cannot be encoded as JSON — it holds a cycle, a BigInt, ` +
        `or a class instance. Pass plain data.`,
    );
  }
}
