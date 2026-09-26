// The proactive nudge (T6.7), in Postgres. `withTenant` throughout — this is the
// firm's own machinery, and a sweep is not a portal read.
//
// ── THE DAY ARITHMETIC IS THE DATABASE'S, AND BOTH CASTS ARE LOAD-BEARING ──
//
// `o.statutory_due_on - ${asOf}::date` is computed in Postgres, on the caller's
// own day, and NO `Date` is constructed in this file. A `date` column comes back
// from postgres.js as a UTC instant and reading its local fields names the day
// before west of Greenwich — which on a one-day rung is the whole rung.
//
// And postgres.js sends every parameter UNTYPED, so `${asOf} + ${n}` dies with
// *"operator is not unique: date + unknown"*: it typechecks, it lints, the unit
// tests use fakes, and it surfaces as a 500 on the first real request. That is
// what cost T6.5 its first walk. `::date` on the day and `::int` on the window
// are why this file has been run rather than only compiled. IF YOU ADD SQL HERE,
// RUN IT.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { NudgeCandidate, NudgeRung, NudgeToSend } from "../../domain/nudge/model";
import { readNudgeBody } from "../../domain/config/model";
import type {
  IsoDate,
  NudgeCandidateSource,
  NudgeLadderSource,
  NudgeRepository,
  NudgeTenantDirectory,
} from "../../usecase/nudge/ports";

/** The one entry key a firm's nudge ladder lives under. One entry holds the
 *  whole ladder rather than one per rung — the rungs are read together and
 *  their ORDER is the meaning. `dunning`, `escalation` and `chaser` all took
 *  this shape. */
export const NUDGE_KEY = "default";

export class PostgresNudgeLadder implements NudgeLadderSource {
  constructor(private readonly app: Db) {}

  async ladderFor(tenantId: string): Promise<readonly NudgeRung[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'nudge' AND e.key = ${NUDGE_KEY}
      `;
      // No row and an empty ladder are the same answer — tell nobody — and that
      // is the shipped state. Only a PUBLISHED version counts: a draft is a
      // cadence somebody is still thinking about, and acting on it would be
      // acting on a decision nobody has taken.
      return row ? readNudgeBody(row.body).rungs : [];
    });
  }
}

interface CandidateRow {
  obligation_id: string;
  entity_party_id: string;
  due_on: string;
  days_until: number;
  nudged_rungs: string[] | null;
}

export class PostgresNudgeCandidates implements NudgeCandidateSource {
  constructor(private readonly app: Db) {}

  async upcomingFilings(
    tenantId: string,
    asOf: IsoDate,
    horizonDays: number,
  ): Promise<readonly NudgeCandidate[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── the filings that are coming up and are not done ───────────────────
      //
      // `filed_on IS NULL` is the whole of "not done", and deliberately NOT a
      // test on the state being terminal. 0052 seeds two terminal states and
      // T3.3's `resolved` is the end of a deadline already MISSED — telling a
      // client a filing they never made is "coming up" would be the same false
      // statement 0054 made from the other side, and T6.5 hit it again reading
      // "recently filed".
      //
      // `statutory_due_on >= asOf` is the second half, and it is what keeps
      // `days_until` non-negative — the CHECK in 0067 says the same thing, which
      // is the database agreeing rather than a second rule. A filing already
      // past its date is a MISSED deadline with its own state and its own
      // screen; "due in -5 days" is not a sentence and this query never
      // produces one.
      const rows = await db<CandidateRow[]>`
        SELECT o.id                                    AS obligation_id,
               o.entity_party_id,
               o.statutory_due_on::text                AS due_on,
               (o.statutory_due_on - ${asOf}::date)::int AS days_until,
               coalesce(
                 (SELECT array_agg(n.rung_key)
                    FROM delivery.obligation_nudge n
                   WHERE n.obligation_id = o.id AND n.tenant_id = o.tenant_id),
                 ARRAY[]::text[]
               ) AS nudged_rungs
          FROM delivery.obligation_instance o
         WHERE o.tenant_id = ${tenantId}
           AND o.filed_on IS NULL
           -- WITHDRAWN (0309): the client would be told about a filing the
           -- firm took off the calendar. Never.
           AND o.withdrawn_at IS NULL
           AND o.statutory_due_on >= ${asOf}::date
           AND o.statutory_due_on <= ${asOf}::date + ${horizonDays}::int
         ORDER BY o.statutory_due_on ASC
      `;
      return rows.map((r) => ({
        obligationId: r.obligation_id,
        entityPartyId: r.entity_party_id,
        dueOn: r.due_on,
        daysUntil: r.days_until,
        nudgedRungs: r.nudged_rungs ?? [],
      }));
    });
  }
}

export class PostgresNudgeRepository implements NudgeRepository {
  constructor(private readonly app: Db) {}

  async record(tenantId: string, nudges: readonly NudgeToSend[]): Promise<readonly NudgeToSend[]> {
    if (nudges.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const created: NudgeToSend[] = [];
      for (const nudge of nudges) {
        // ── AT-LEAST-ONCE, TAKEN BY THE INDEX ──────────────────────────────
        //
        // `ON CONFLICT DO NOTHING` against `obligation_nudge_once`, and the
        // RETURNING is what tells the caller which rungs were genuinely new.
        // The ledger event is written only for what comes back from here.
        //
        // `entity_party_id` and `due_on` are taken from the OBLIGATION in the
        // statement, never from the caller — 0063's arrangement, and the
        // composite foreign key would refuse a mismatched party anyway. A value
        // nothing can supply is one fewer thing that has to hold, and it means
        // the date the nudge names is the date the calendar holds rather than
        // one that travelled through three objects to get here.
        const [row] = await db<{ id: string }[]>`
          INSERT INTO delivery.obligation_nudge
            (tenant_id, obligation_id, entity_party_id, rung_key, before_days, days_until, due_on)
          SELECT ${tenantId}, o.id, o.entity_party_id,
                 ${nudge.rungKey}, ${nudge.beforeDays}::int, ${nudge.daysUntil}::int,
                 o.statutory_due_on
            FROM delivery.obligation_instance o
           WHERE o.id = ${nudge.obligationId}
             AND o.tenant_id = ${tenantId}
             AND o.filed_on IS NULL
             -- Re-derived at the write, as filed_on is: a filing withdrawn
             -- between the candidates and this insert writes no nudge and no
             -- event. A restored filing keeps the rungs it already had
             -- (obligation_nudge_once), so it is never told twice.
             AND o.withdrawn_at IS NULL
          ON CONFLICT (tenant_id, obligation_id, rung_key) DO NOTHING
          RETURNING id
        `;
        if (row) created.push(nudge);
      }
      return created;
    });
  }
}

export class PostgresNudgeTenants implements NudgeTenantDirectory {
  constructor(private readonly app: Db) {}

  async activeTenantIds(): Promise<readonly string[]> {
    // Above RLS, and the only read in this module that is: a worker holds no
    // session, so the tenant list has to come from somewhere. Everything under
    // it is `withTenant`.
    const rows = await this.app<{ id: string }[]>`SELECT id FROM tenancy.tenant ORDER BY created_at`;
    return rows.map((r) => r.id);
  }
}
