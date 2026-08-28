// In-memory fake for the ledger's driven port. `implements EventStore` is the
// compile-time assertion that it stays in step with the real adapter.
//
// It reproduces the two behaviours business rules depend on — append-only, and
// idempotent on the primary key — and nothing else. It does NOT enforce RLS or
// the append-only GRANT: those are database properties, proven against real
// Postgres in tests/ledger/immutability.integration.test.ts, not simulated here.
import type { DomainEvent } from "../domain/ledger/model";
import type { EventRecord, EventStore, NewEvent } from "../usecase/ledger/ports";
import type { Deps } from "../usecase/ledger/service";
import { LedgerService } from "../usecase/ledger/service";
import type { EventSink, RecordEventInput } from "../usecase/ledger/ports";
import { FakeIds } from "./ids";

/** A fixed clock, so a test can assert on timestamps. Real time comes from the
 *  database; the fake needs only to be ordered and deterministic. */
const EPOCH = Date.parse("2026-01-01T00:00:00Z");

export class FakeEventStore implements EventStore {
  readonly rows: DomainEvent[] = [];
  private tick = 0;

  append(e: NewEvent): Promise<DomainEvent> {
    const existing = this.rows.find((r) => r.id === e.id);
    if (existing) return Promise.resolve(existing); // replayed derived id
    const at = new Date(EPOCH + this.tick * 1000).toISOString();
    this.tick += 1;
    const row: DomainEvent = {
      id: e.id,
      tenantId: e.tenantId,
      actorType: e.actorType,
      actorId: e.actorId,
      verb: e.verb as DomainEvent["verb"],
      objectType: e.objectType,
      objectId: e.objectId,
      payload: e.payload,
      occurredAt: e.occurredAt ?? at,
      recordedAt: at,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  /** Accounts the fake can resolve an actor to, keyed by user id — the join the
   *  real adapter does in SQL. Empty by default: an unresolved actor is a real
   *  state (system, agent, an erased account) and the read model says so. */
  readonly accounts = new Map<string, { displayName: string | null; email: string }>();

  private record(e: DomainEvent): EventRecord {
    const account = e.actorId === null ? undefined : this.accounts.get(e.actorId);
    return {
      event: e,
      actor:
        e.actorId === null || account === undefined
          ? null
          : { userId: e.actorId, displayName: account.displayName, email: account.email },
    };
  }

  recent(tenantId: string, limit: number): Promise<EventRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .slice(0, limit)
        .map((e) => this.record(e)),
    );
  }

  forObject(tenantId: string, objectType: string, objectId: string): Promise<EventRecord[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.tenantId === tenantId && r.objectType === objectType && r.objectId === objectId,
        )
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .map((e) => this.record(e)),
    );
  }
}

/** A ready-made dependency set for LedgerService, matching makePartyFakes(). */
export function makeLedgerFakes(): Deps {
  return { events: new FakeEventStore(), ids: new FakeIds() };
}

/**
 * The EventSink other modules' tests inject.
 *
 * It is the REAL LedgerService over an in-memory store, not a stub that records
 * whatever it is handed — so a party or tenancy test fails if its event breaks
 * the contract (an unregistered verb, a payload carrying personal data). The
 * contract is enforced for every consumer, in every suite, not just its own.
 */
export class RecordingEventSink implements EventSink {
  readonly store = new FakeEventStore();
  private readonly service = new LedgerService({ events: this.store, ids: new FakeIds() });

  recordEvent(input: RecordEventInput): Promise<DomainEvent> {
    return this.service.recordEvent(input);
  }

  /** Everything recorded, oldest first. */
  get recorded(): readonly DomainEvent[] {
    return this.store.rows;
  }

  verbs(): readonly string[] {
    return this.store.rows.map((e) => e.verb);
  }
}
