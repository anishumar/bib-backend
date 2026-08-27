// The ledger use case — the one implementation of the event contract. Every
// event in the system passes through recordEvent(), so this is where the
// contract stops being documentation and becomes enforcement.
//
// It is deliberately the only thing that can build a NewEvent: the store port
// takes a validated row, and the store adapter is never injected into another
// service. So there is no path from a caller to the table that skips these
// checks — the same shape as the tenant wall, applied to the audit trail.
import type { IdGen } from "../../platform/ids";
import type { DomainEvent } from "../../domain/ledger/model";
import {
  EVENT_ID_NAMESPACE,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_DEPTH,
  findPiiKey,
  isEventVerb,
  isIdentifiedActor,
  isIsoTimestamp,
  isPayloadTooDeep,
  isUuid,
  objectTypeFor,
  payloadByteLength,
  verbsWithPrefix,
} from "../../domain/ledger/model";
import {
  InvalidActor,
  InvalidObjectId,
  InvalidOccurredAt,
  InvalidTenantId,
  PayloadContainsPii,
  PayloadNotSerialisable,
  PayloadTooDeep,
  PayloadTooLarge,
  UnknownVerb,
} from "../../domain/ledger/errors";
import type { EventSink, EventStore, NewEvent, RecordEventInput } from "./ports";

export interface Deps {
  readonly events: EventStore;
  readonly ids: IdGen;
}

/** How many events a single timeline read returns unless asked otherwise, and
 *  the ceiling it is clamped to. A timeline is for reading, not for export;
 *  bulk extraction is a separate, deliberate feature. */
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 500;

export class LedgerService implements EventSink {
  constructor(private readonly deps: Deps) {}

  /**
   * Append one event. Validates the whole contract first — an event that would
   * be wrong is refused rather than written, because the row can never be
   * corrected afterwards.
   *
   * Callers pass `idempotencyKey` whenever the trigger can be delivered twice
   * (a webhook, a retried job): the id is then derived from it, and the replay
   * re-lands on the same row instead of double-recording.
   */
  async recordEvent(input: RecordEventInput): Promise<DomainEvent> {
    // `verb` is typed to the registry, but types are erased at runtime and this
    // value routinely originates in parsed JSON — so it is checked, not trusted.
    const verb: string = input.verb;
    if (!isEventVerb(verb)) {
      throw new UnknownVerb(verb, verbsWithPrefix(verb.split(".")[0] ?? ""));
    }
    if (!isUuid(input.tenantId)) throw new InvalidTenantId(input.tenantId);
    if (!isUuid(input.objectId)) throw new InvalidObjectId(verb, input.objectId);
    if (!isIdentifiedActor(input.actor)) {
      throw new InvalidActor(input.actor.type, input.actor.id);
    }
    if (input.occurredAt !== undefined && !isIsoTimestamp(input.occurredAt)) {
      throw new InvalidOccurredAt(input.occurredAt);
    }

    const payload = input.payload ?? {};
    // Depth first: below MAX_PAYLOAD_DEPTH the personal-data scan stops looking,
    // so a payload that deep could hide a leak from the check that follows.
    if (isPayloadTooDeep(payload)) throw new PayloadTooDeep(verb, MAX_PAYLOAD_DEPTH);
    const piiKey = findPiiKey(payload);
    if (piiKey !== null) throw new PayloadContainsPii(verb, piiKey);
    const bytes = payloadByteLength(payload);
    if (bytes === null) throw new PayloadNotSerialisable(verb);
    if (bytes > MAX_PAYLOAD_BYTES) throw new PayloadTooLarge(verb, bytes, MAX_PAYLOAD_BYTES);

    const row: NewEvent = {
      id:
        input.idempotencyKey === undefined
          ? this.deps.ids.newId()
          : this.deps.ids.derivedId(EVENT_ID_NAMESPACE, input.idempotencyKey),
      tenantId: input.tenantId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      verb,
      objectType: objectTypeFor(input.verb),
      objectId: input.objectId,
      payload,
      occurredAt: input.occurredAt ?? null,
    };
    return this.deps.events.append(row);
  }

  /** The tenant timeline, newest first. */
  async recent(tenantId: string, limit?: number): Promise<readonly DomainEvent[]> {
    if (!isUuid(tenantId)) throw new InvalidTenantId(tenantId);
    return this.deps.events.recent(tenantId, clampLimit(limit));
  }

  /** Everything that ever happened to one object, newest first. An unknown
   *  object simply has an empty history — a read never fails for absence. */
  async forObject(
    tenantId: string,
    objectType: string,
    objectId: string,
  ): Promise<readonly DomainEvent[]> {
    if (!isUuid(tenantId)) throw new InvalidTenantId(tenantId);
    if (!isUuid(objectId)) throw new InvalidObjectId(objectType, objectId);
    return this.deps.events.forObject(tenantId, objectType, objectId);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TIMELINE_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_TIMELINE_LIMIT;
  return Math.min(Math.floor(limit), MAX_TIMELINE_LIMIT);
}
