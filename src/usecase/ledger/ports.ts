// The ledger's seams. Two interfaces that face opposite directions, and the
// distinction is the whole point:
//
//   EventSink   — what EVERY OTHER USE CASE depends on (the driving contract).
//                 `recordEvent()` is the one call both lanes make. Its
//                 implementation is LedgerService, which validates against the
//                 event contract before anything is written.
//   EventStore  — what INFRASTRUCTURE implements (the driven port). It receives
//                 an already-validated row and does nothing but persist and
//                 read. No adapter may be handed to a service directly, so no
//                 event can reach the table without passing the contract.
//
// A module that only writes events declares `readonly events: EventSink` in its
// own Deps and never learns that Postgres exists.
import type { ActorType, DomainEvent, EventVerb } from "../../domain/ledger/model";

/** What a caller states. Everything else about the row — object_type, the id,
 *  recorded_at — is derived, so a caller cannot get it inconsistent. */
export interface RecordEventInput {
  readonly tenantId: string;
  readonly verb: EventVerb;
  /** The row the verb happened to. */
  readonly objectId: string;
  readonly actor: { readonly type: ActorType; readonly id: string | null };
  /** Ids and machine facts only. Personal data is rejected — see the contract. */
  readonly payload?: Record<string, unknown> | undefined;
  /** Business time, when it differs from now (an external callback reporting a
   *  past moment). ISO 8601 with an offset. Defaults to the database clock. */
  readonly occurredAt?: string | undefined;
  /** Makes the write idempotent: the same key derives the same event id, so a
   *  retried callback re-lands on the existing row instead of double-recording.
   *  Required on anything an external system can deliver twice. */
  readonly idempotencyKey?: string | undefined;
}

/**
 * The contract both lanes import (T1.1). Depend on THIS, never on a ledger
 * adapter or on LedgerService's concrete type.
 */
export interface EventSink {
  recordEvent(input: RecordEventInput): Promise<DomainEvent>;
}

/** A validated row, ready to persist. Built only by LedgerService. */
export interface NewEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly payload: Record<string, unknown>;
  /** Null means "use the database clock" — the common case. */
  readonly occurredAt: string | null;
}

export interface EventStore {
  /**
   * Append one event. Idempotent on the primary key: if the id already exists
   * (a derived id, replayed), the EXISTING row is returned unchanged and
   * nothing is written. The table has no UPDATE or DELETE grant, so this is the
   * only way rows ever get there.
   */
  append(e: NewEvent): Promise<DomainEvent>;
  /** The tenant timeline, newest first. */
  recent(tenantId: string, limit: number): Promise<DomainEvent[]>;
  /** Everything that ever happened to one object, newest first. */
  forObject(tenantId: string, objectType: string, objectId: string): Promise<DomainEvent[]>;
}
