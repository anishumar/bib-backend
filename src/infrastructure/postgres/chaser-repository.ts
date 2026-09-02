// The chaser (T4.4), in Postgres. `withTenant` throughout — this is the firm's
// own machinery and the firm's own decision, and neither is a portal read.
//
// ── THE CANDIDATES AND THE FREEZES COME OUT OF ONE TRANSACTION ───────────
//
// Two statements inside one `withTenant`, because the two answers have to be
// about the same instant: a freeze set while the sweep is running must stop this
// pass or not, never stop half of it. And the frozen list is returned rather
// than applied as a WHERE, because `frozen` in the report is what explains a
// quiet week — a number that only ever existed as a SQL predicate cannot be
// logged.
//
// ── AND THE DAY ARITHMETIC IS THE DATABASE'S ─────────────────────────────
//
// `${asOf}::date - (a.raised_at AT TIME ZONE tz)::date` is computed in Postgres
// on the FIRM's calendar (0071) and on the caller's
// own day, and NO `Date` is constructed in this file. A `date` column comes back
// from postgres.js as a UTC instant and reading its local fields names the day
// before west of Greenwich — which on a three-day rung is a whole rung early.
// Both casts are load-bearing: postgres.js sends every parameter UNTYPED, so
// `${asOf} - x` is ambiguous and dies with *"operator is not unique"*. IF YOU
// ADD SQL TO THIS FILE, RUN IT.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ChaseCandidate, ChaseRung, ChaseToSend } from "../../domain/chaser/model";
import { readChaserBody } from "../../domain/config/model";
import type {
  ChaseCandidateSource,
  ChaseRepository,
  ChaserLadderSource,
  ChaserTenantDirectory,
  ClientFreezeRecord,
  ClientFreezeRepository,
  IsoDate,
  NewFreeze,
} from "../../usecase/chaser/ports";
import { isoInstant } from "./instant";

/** The one entry key a firm's chaser ladder lives under. One entry holds the
 *  whole ladder rather than one per rung — the rungs are read together and
 *  their ORDER is the meaning. `escalation` and `dunning` both took this
 *  shape. */
export const CHASER_KEY = "default";

export class PostgresChaserLadder implements ChaserLadderSource {
  constructor(private readonly app: Db) {}

  async ladderFor(tenantId: string): Promise<readonly ChaseRung[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'chaser' AND e.key = ${CHASER_KEY}
      `;
      // No row and an empty ladder are the same answer — chase nobody — and
      // that is the shipped state. Only a PUBLISHED version counts: a draft is
      // a cadence somebody is still thinking about, and chasing to it would be
      // acting on a decision nobody has taken.
      return row ? readChaserBody(row.body).rungs : [];
    });
  }
}

interface CandidateRow {
  ask_id: string;
  client_party_id: string;
  work_item_id: string;
  days_open: number;
  chased_rungs: string[] | null;
}

export class PostgresChaseCandidates implements ChaseCandidateSource {
  constructor(private readonly app: Db) {}

  async openAsks(
    tenantId: string,
    asOf: IsoDate,
    timeZone: string,
  ): Promise<{
    readonly candidates: readonly ChaseCandidate[];
    readonly frozenClients: readonly string[];
  }> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── the asks still waiting on a client ────────────────────────────────
      //
      // `status = 'open'` alone, and NOT `IN ('open','answered')`. An answered
      // ask is back with the firm: reminding somebody about something they have
      // already sent is the single most annoying thing a chaser can do, and it
      // is what a spreadsheet-driven human chaser gets wrong every week. If the
      // firm decides what arrived was wrong, it closes the ask and raises a new
      // one, which starts a new ladder — correctly.
      //
      // The JOIN to `work_item` is not decoration: an ask whose task the firm
      // marked invisible to the client is an ask the client cannot see, and
      // chasing somebody about something that is not on their page would be the
      // product contradicting itself.
      const candidates = await db<CandidateRow[]>`
        SELECT a.id           AS ask_id,
               a.client_party_id,
               a.work_item_id,
               (${asOf}::date - (a.raised_at AT TIME ZONE ${timeZone}::text)::date)::int
                 AS days_open,
               coalesce(
                 (SELECT array_agg(c.rung_key)
                    FROM delivery.client_ask_chase c
                   WHERE c.ask_id = a.id AND c.tenant_id = a.tenant_id),
                 ARRAY[]::text[]
               ) AS chased_rungs
          FROM delivery.client_ask a
          JOIN delivery.work_item wi
            ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
         WHERE a.tenant_id = ${tenantId}
           AND a.status = 'open'
           AND wi.is_client_visible
         ORDER BY a.raised_at ASC
      `;

      // ── and the clients this firm has said not to chase ──────────────────
      //
      // Half-open, in SQL, on the CALLER's day: `valid_from <= asOf < valid_to`.
      // The `daterange @>` idiom would read better and is not used, because the
      // exclusion constraint already owns that expression and a second copy is
      // how the two come to disagree about a boundary day.
      const frozen = await db<{ client_party_id: string }[]>`
        SELECT DISTINCT client_party_id
          FROM crm.client_freeze
         WHERE tenant_id = ${tenantId}
           AND valid_from <= ${asOf}::date
           AND (valid_to IS NULL OR valid_to > ${asOf}::date)
      `;

      return {
        candidates: candidates.map((r) => ({
          askId: r.ask_id,
          clientPartyId: r.client_party_id,
          workItemId: r.work_item_id,
          daysOpen: r.days_open,
          chasedRungs: r.chased_rungs ?? [],
        })),
        frozenClients: frozen.map((r) => r.client_party_id),
      };
    });
  }
}

export class PostgresChaseRepository implements ChaseRepository {
  constructor(private readonly app: Db) {}

  async record(
    tenantId: string,
    chases: readonly ChaseToSend[],
  ): Promise<readonly ChaseToSend[]> {
    if (chases.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const created: ChaseToSend[] = [];
      for (const chase of chases) {
        // ── AT-LEAST-ONCE, TAKEN BY THE INDEX ──────────────────────────────
        //
        // `ON CONFLICT DO NOTHING` against `client_ask_chase_once`, and the
        // RETURNING is what tells the caller which rungs were genuinely new.
        // pg-boss redelivers and the ask is still open tomorrow; neither may
        // remind a client twice, and the ledger event is written only for what
        // comes back from here.
        //
        // `client_party_id` is taken from the ask in the statement, never from
        // the caller — 0063's arrangement, and the composite foreign key would
        // refuse a mismatch anyway. A value nothing can supply is one fewer
        // thing that has to hold.
        const [row] = await db<{ id: string }[]>`
          INSERT INTO delivery.client_ask_chase
            (tenant_id, ask_id, client_party_id, rung_key, after_days, days_open)
          SELECT ${tenantId}, a.id, a.client_party_id,
                 ${chase.rungKey}, ${chase.afterDays}::int, ${chase.daysOpen}::int
            FROM delivery.client_ask a
           WHERE a.id = ${chase.askId}
             AND a.tenant_id = ${tenantId}
             AND a.status = 'open'
          ON CONFLICT (tenant_id, ask_id, rung_key) DO NOTHING
          RETURNING id
        `;
        if (row) created.push(chase);
      }
      return created;
    });
  }
}

interface FreezeRow {
  id: string;
  client_party_id: string;
  client_name: string;
  valid_from: string;
  valid_to: string | null;
  reason: string;
  set_by_name: string | null;
  lifted_by_name: string | null;
  created_at: string;
}

export class PostgresClientFreezeRepository implements ClientFreezeRepository {
  constructor(private readonly app: Db) {}

  async set(freeze: NewFreeze): Promise<ClientFreezeRecord | null> {
    return withTenant(this.app, freeze.tenantId, async (db) => {
      // The client comes from a SELECT rather than a literal, so "no such client
      // at this firm" is zero rows rather than a foreign-key violation the
      // service would have to parse a message out of.
      const [row] = await db<{ id: string }[]>`
        INSERT INTO crm.client_freeze
          (id, tenant_id, client_party_id, valid_from, valid_to, reason, set_by)
        SELECT ${freeze.id}, ${freeze.tenantId}, p.id,
               ${freeze.validFrom}::date, ${freeze.validTo}::date, ${freeze.reason},
               ${freeze.setBy}
          FROM core.party p
         WHERE p.id = ${freeze.clientPartyId} AND p.tenant_id = ${freeze.tenantId}
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, freeze.tenantId, freeze.id);
    });
  }

  async listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly ClientFreezeRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await this.select(db, tenantId, { clientPartyId });
      return rows.map(toRecord);
    });
  }

  findById(tenantId: string, freezeId: string): Promise<ClientFreezeRecord | null> {
    return withTenant(this.app, tenantId, (db) => this.read(db, tenantId, freezeId));
  }

  async lift(input: {
    readonly tenantId: string;
    readonly freezeId: string;
    readonly on: IsoDate;
    readonly liftedBy: string;
  }): Promise<ClientFreezeRecord | null> {
    return withTenant(this.app, input.tenantId, async (db) => {
      // `valid_to IS NULL` in the WHERE is what makes a double-click a no-op
      // rather than a second lift over the first — which would move the day
      // chasing resumed, and that is the date somebody is answering questions
      // about. The date and the lifter move together; 0065's CHECK says the
      // same thing, which is the database agreeing rather than a second rule.
      const [row] = await db<{ id: string }[]>`
        UPDATE crm.client_freeze
           SET valid_to = ${input.on}::date,
               lifted_by = ${input.liftedBy}
         WHERE id = ${input.freezeId}
           AND tenant_id = ${input.tenantId}
           AND valid_to IS NULL
        RETURNING id
      `;
      if (!row) return null;
      return this.read(db, input.tenantId, input.freezeId);
    });
  }

  private async read(db: Db, tenantId: string, id: string): Promise<ClientFreezeRecord | null> {
    const rows = await this.select(db, tenantId, { id });
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  private select(
    db: Db,
    tenantId: string,
    filter: { id?: string; clientPartyId?: string },
  ): Promise<FreezeRow[]> {
    return db<FreezeRow[]>`
      SELECT f.id,
             f.client_party_id,
             p.display_name AS client_name,
             f.valid_from::text AS valid_from,
             f.valid_to::text   AS valid_to,
             f.reason,
             -- LEFT joins, and null is a real answer: an erased account stops
             -- resolving and the freeze survives, exactly as the ledger's actor
             -- join does.
             setter.display_name AS set_by_name,
             lifter.display_name AS lifted_by_name,
             ${db.unsafe(isoInstant("f.created_at", "created_at"))}
        FROM crm.client_freeze f
        JOIN core.party p ON p.id = f.client_party_id AND p.tenant_id = f.tenant_id
        LEFT JOIN tenancy.user_account setter ON setter.id = f.set_by
        LEFT JOIN tenancy.user_account lifter ON lifter.id = f.lifted_by
       WHERE f.tenant_id = ${tenantId}
         AND (${filter.id ?? null}::uuid IS NULL OR f.id = ${filter.id ?? null}::uuid)
         AND (${filter.clientPartyId ?? null}::uuid IS NULL
              OR f.client_party_id = ${filter.clientPartyId ?? null}::uuid)
       ORDER BY f.valid_from DESC, f.created_at DESC
    `;
  }
}

export class PostgresChaserTenants implements ChaserTenantDirectory {
  constructor(private readonly app: Db) {}

  async activeTenantIds(): Promise<readonly string[]> {
    // Above RLS, and the only read in this module that is: a worker holds no
    // session, so the tenant list has to come from somewhere. Everything under
    // it is `withTenant`.
    const rows = await this.app<{ id: string }[]>`SELECT id FROM tenancy.tenant ORDER BY created_at`;
    return rows.map((r) => r.id);
  }
}

function toRecord(r: FreezeRow): ClientFreezeRecord {
  return {
    id: r.id,
    clientPartyId: r.client_party_id,
    clientName: r.client_name,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    reason: r.reason,
    setByName: r.set_by_name,
    liftedByName: r.lifted_by_name,
    createdAt: r.created_at,
  };
}
