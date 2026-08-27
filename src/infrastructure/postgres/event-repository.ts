// Postgres adapter for the audit ledger. It persists an already-validated row
// and reads timelines back — no rules, no vocabulary, no defaults it could get
// out of step with the contract (usecase/ledger/service.ts owns all of that).
//
// Everything runs under withTenant, so RLS scopes each statement. The table has
// no UPDATE or DELETE grant and an immutability trigger besides (migration
// 0003), which is why this file has an append and two reads and nothing else:
// there is no method to write, because there is no such operation.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ActorType, DomainEvent, EventVerb } from "../../domain/ledger/model";
import type { EventStore, NewEvent } from "../../usecase/ledger/ports";

interface EventRow {
  id: string;
  tenant_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  verb: string;
  object_type: string;
  object_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}

// The door where Postgres types become ours: timestamptz arrives as a Date and
// leaves as an ISO 8601 string with an offset, which is what the contract says
// the field is. `verb` is a text column and is re-asserted to the registry type
// here because the value was validated on the way in.
function toEvent(r: EventRow): DomainEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    verb: r.verb as EventVerb,
    objectType: r.object_type,
    objectId: r.object_id,
    payload: r.payload,
    occurredAt: r.occurred_at.toISOString(),
    recordedAt: r.recorded_at.toISOString(),
  };
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly app: Db) {}

  /**
   * Append one event.
   *
   * ON CONFLICT DO NOTHING is the idempotency mechanism: an id derived from an
   * idempotency key collides on replay, nothing is written, and the SELECT that
   * follows returns the row the first delivery created. A retried webhook
   * therefore observes exactly the same event it did the first time.
   *
   * The event is written in its OWN transaction, not the caller's — the ports
   * are per-aggregate and none of them share a unit of work yet. That is a
   * conscious limit, recorded in docs/EVENT-CONTRACT.md: record the event
   * AFTER the change it describes has committed, so a rolled-back change can
   * never leave an event claiming it happened.
   */
  async append(e: NewEvent): Promise<DomainEvent> {
    return withTenant(this.app, e.tenantId, async (db) => {
      const payload = db.json(e.payload as Parameters<typeof db.json>[0]);
      const [inserted] = await db<EventRow[]>`
        INSERT INTO ledger.event
          (id, tenant_id, actor_type, actor_id, verb, object_type, object_id, payload, occurred_at)
        VALUES
          (${e.id}, ${e.tenantId}, ${e.actorType}, ${e.actorId}, ${e.verb},
           ${e.objectType}, ${e.objectId}, ${payload},
           COALESCE(${e.occurredAt}::timestamptz, now()))
        ON CONFLICT (id) DO NOTHING
        RETURNING id, tenant_id, actor_type, actor_id, verb, object_type, object_id,
                  payload, occurred_at, recorded_at
      `;
      if (inserted) return toEvent(inserted);

      const [existing] = await db<EventRow[]>`
        SELECT id, tenant_id, actor_type, actor_id, verb, object_type, object_id,
               payload, occurred_at, recorded_at
        FROM ledger.event WHERE id = ${e.id}
      `;
      if (!existing) {
        // The insert was skipped but the row is not visible: the id collided
        // with an event belonging to ANOTHER tenant, which RLS then hid.
        throw new Error(
          `ledger append for ${e.verb} produced no row: event id ${e.id} already exists outside ` +
            `tenant ${e.tenantId}. The idempotency key is not tenant-unique — include the tenant id in it.`,
        );
      }
      return toEvent(existing);
    });
  }

  async recent(tenantId: string, limit: number): Promise<DomainEvent[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<EventRow[]>`
        SELECT id, tenant_id, actor_type, actor_id, verb, object_type, object_id,
               payload, occurred_at, recorded_at
        FROM ledger.event
        ORDER BY occurred_at DESC, recorded_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toEvent);
    });
  }

  async forObject(
    tenantId: string,
    objectType: string,
    objectId: string,
  ): Promise<DomainEvent[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<EventRow[]>`
        SELECT id, tenant_id, actor_type, actor_id, verb, object_type, object_id,
               payload, occurred_at, recorded_at
        FROM ledger.event
        WHERE object_type = ${objectType} AND object_id = ${objectId}
        ORDER BY occurred_at DESC, recorded_at DESC
      `;
      return rows.map(toEvent);
    });
  }
}
