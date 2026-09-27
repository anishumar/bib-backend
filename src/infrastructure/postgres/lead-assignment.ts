// Round-robin lead assignment (T2.1b), in Postgres — the first implementation
// of the AssignmentStrategy port.
//
// ## Where the rotation state lives: NOWHERE. It is derived.
//
// The obvious design is a pointer — `next_owner_index` on the tenant, or a
// `last_assigned_user_id` — bumped on each assignment. It was rejected, and not
// on taste:
//
//   • A pointer goes STALE the moment the roster changes. The person it points
//     at leaves the firm and the rotation stalls or skips; somebody joins on
//     Monday and the pointer has no idea they exist, so they wait a full lap
//     for work while everybody else keeps taking it. Every one of those is a
//     bug that only shows up as "assignment feels wrong", weeks later.
//   • It is a second source of truth about a fact the pipeline ALREADY HOLDS.
//     Who is carrying what is answerable from crm.lead, exactly, at any moment.
//     Storing a summary of a table beside the table is how the two disagree.
//
// So the rotation is a QUERY, not a column: give the lead to the active staff
// member with the fewest OPEN leads, ties broken by user id so the choice is
// total and deterministic rather than whatever the planner returned first. It
// self-heals by construction — a leaver stops being a candidate the instant
// their membership goes inactive, and a joiner starts at zero and is picked
// first. There is no migration in this task, and that is the result, not an
// omission.
//
// **What that means, stated honestly**: this routes by CURRENT DESK LOAD, not
// by lifetime turn. On a level pipeline the two are the same thing and N
// captures land evenly, which is the acceptance. Where they differ is when
// somebody closes faster than their colleagues — their desk empties and they
// receive more. That is capacity routing and it is the behaviour a firm
// generally wants, but it is a decision: strict lifetime rotation is a
// different strategy behind this same port, and the board carries the question.
//
// ## Fairness under concurrency
//
// Two leads captured in the same instant must not both land on the emptiest
// desk — they would both read the same counts and pick the same person, and the
// rotation would be quietly wrong exactly when the firm is busiest. Two things
// close that:
//
//   1. A per-tenant TRANSACTION-SCOPED ADVISORY LOCK, taken before the counts
//      are read and released by the commit that writes the answer. The second
//      capture waits, then counts a world that already contains the first.
//      Postgres runs us at READ COMMITTED, so its UPDATE takes a fresh snapshot
//      after the wait — which is what makes the count current rather than the
//      one it would have seen at BEGIN.
//   2. `AND owner_user_id IS NULL` in the UPDATE. A manual assignment that
//      landed in between wins: a person's decision is never overwritten by a
//      rotation, whatever the ordering was.
//
// The lock is per tenant, so one firm's captures never queue behind another's.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { AssignmentPolicy, Lead, TerritoryRule } from "../../domain/lead/model";
import type {
  AssignmentOutcome,
  AssignmentStrategy,
  NewTerritoryRule,
  TerritoryRules,
} from "../../usecase/lead/ports";
import { toLead } from "./lead-repository";
import type { LeadRow } from "./lead-repository";

/**
 * The advisory-lock namespace for lead assignment.
 *
 * Advisory locks are cluster-wide and share one key space with every other use
 * of them, so the two-argument form is used and this constant claims a class of
 * our own. Without it, an unrelated feature hashing a tenant id the same way
 * would serialise against us for no reason anybody could find.
 */
const ASSIGNMENT_LOCK_CLASS = 0x1ead;

/**
 * 31 bits of the tenant's own uuid, as the lock's object id.
 *
 * A hash, so distinct firms can collide — two firms sharing a lock occasionally
 * queue behind each other. That costs a few milliseconds and can never produce
 * a wrong answer, which is the right side to be wrong on: the alternative is a
 * lock table to allocate dense ids, which is the stored state this whole file
 * exists to avoid. The sign bit is masked off so the key reads as a positive
 * integer in `pg_locks` when somebody is debugging one.
 */
export function assignmentLockKey(tenantId: string): number {
  const head = tenantId.replace(/-/g, "").slice(0, 8);
  const parsed = Number.parseInt(head, 16);
  return Number.isNaN(parsed) ? 0 : parsed & 0x7fffffff;
}

export class PostgresRoundRobinAssignment implements AssignmentStrategy {
  constructor(private readonly app: Db) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    return withTenant(this.app, lead.tenantId, async (db) => {
      // Held until this transaction commits, which is also when the answer
      // becomes visible. Taking it as its own statement is deliberate: the
      // UPDATE below then plans and snapshots AFTER the wait.
      await db`
        SELECT pg_advisory_xact_lock(
          ${ASSIGNMENT_LOCK_CLASS}::int, ${assignmentLockKey(lead.tenantId)}::int)
      `;

      const [row] = await db<LeadRow[]>`
        WITH desk AS (
          -- Every active STAFF membership at this firm, and what is on that
          -- desk right now. RLS filters BOTH tables to the tenant (the policy
          -- on tenancy.membership and on crm.lead), which is why neither
          -- carries a tenant_id predicate here — the same reason isActiveStaff
          -- has none.
          --
          -- THE PREDICATE audience = 'STAFF' AND is_active IS THE SAME NOTION
          -- PostgresMembershipRepository.isActiveStaff ASKS ABOUT, and the two
          -- must stay identical: T2.1 refuses a manually proposed owner who
          -- fails it, and a rotation that could pick somebody that refusal
          -- would reject is a back door into the same bad state. An integration
          -- test asserts the two agree about one deactivated colleague.
          --
          -- The LEFT JOIN is load-bearing: an INNER one would drop anybody
          -- holding no leads, which is precisely the person the next lead
          -- should go to.
          SELECT m.user_id AS user_id, count(l.id) AS open_leads
          FROM tenancy.membership m
          LEFT JOIN crm.lead l
            ON l.owner_user_id = m.user_id
           AND l.stage NOT IN ('converted', 'lost', 'abandoned')
           -- A deleted lead was never a prospect (0086), so it is on nobody's
           -- desk: counting it would starve whoever deleted the most mistakes.
           AND l.deleted_at IS NULL
          WHERE m.audience = 'STAFF' AND m.is_active
          GROUP BY m.user_id
        ),
        pick AS (
          -- Fewest open leads wins; user_id breaks the tie. The tiebreak is not
          -- cosmetic — without a total order, three colleagues on zero would be
          -- separated by whatever the plan happened to emit first, and the
          -- rotation would be unpredictable in exactly the case it matters.
          SELECT user_id FROM desk ORDER BY open_leads ASC, user_id ASC LIMIT 1
        )
        UPDATE crm.lead AS t
        SET owner_user_id = pick.user_id
        FROM pick
        WHERE t.id = ${lead.id} AND t.owner_user_id IS NULL
        RETURNING t.id, t.tenant_id, t.title, t.party_id, t.source, t.stage,
                  t.owner_user_id, t.notes, t.lost_reason, t.jurisdiction,
                  t.estimated_value, t.estimated_value_currency,
                  t.captured_at, t.closed_at, t.deleted_at, t.deleted_by_user_id
      `;

      // No row means the strategy DECLINED, and both ways of getting here are
      // ordinary rather than faults: `pick` was empty because the firm has
      // nobody active to give it to, or the lead acquired an owner between the
      // insert and this statement and a person's decision stands. Either way
      // the lead is returned exactly as it came in, and it stays in the
      // unassigned queue — which is a supported state, not a failure.
      return row ? { lead: toLead(row), policy: ROUND_ROBIN } : { lead, policy: null };
    });
  }
}

const ROUND_ROBIN: AssignmentPolicy = "round_robin";
const TERRITORY: AssignmentPolicy = "territory";

/**
 * TERRITORY: whose desk covers the country the prospect is in (T2.1b).
 *
 * The half of T2.1b's acceptance that was never built — "a territory rule
 * OVERRIDES the rotation" — and the reason it could not be is that a lead had
 * no axis on it at all. Migration 0026 adds `crm.lead.jurisdiction`, and this
 * is the rule that reads it.
 *
 * ONE STATEMENT, and it is the same three-part discipline the rotation uses,
 * for the same reasons:
 *
 *   1. `AND t.owner_user_id IS NULL` — a manual assignment that landed in
 *      between wins. A rule never overrules a person.
 *   2. The rule's owner must be ACTIVE STAFF, joined here rather than trusted
 *      from the row. A membership is revoked without anybody remembering the
 *      territory table, and a foreign key cannot express "active" — so a rule
 *      naming somebody who left DECLINES and the lead falls through to the
 *      rotation, instead of parking on a dead desk where nobody sees it. This
 *      is the same `audience = 'STAFF' AND is_active` predicate
 *      `isActiveStaff` and the rotation both ask.
 *   3. No advisory lock, and that is the difference from the rotation. This
 *      strategy decides against NO SHARED STATE — the answer for a country is
 *      the same whoever else is being assigned at that instant — so there is
 *      nothing for two concurrent captures to race over. Taking the lock anyway
 *      would serialise every capture in the firm behind a query that does not
 *      need it.
 *
 * A lead with no jurisdiction declines immediately, without a query: an unknown
 * country matches no rule, and that is what the rotation is the fallback for.
 */
export class PostgresTerritoryAssignment implements AssignmentStrategy {
  constructor(private readonly app: Db) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    if (lead.jurisdiction === null) return { lead, policy: null };
    return withTenant(this.app, lead.tenantId, async (db) => {
      const [row] = await db<LeadRow[]>`
        WITH covering AS (
          -- RLS filters all three tables to the tenant, which is why none of
          -- them carries a tenant_id predicate — the same reason the rotation's
          -- query has none.
          SELECT r.owner_user_id
          FROM crm.territory_rule r
          JOIN tenancy.membership m
            ON m.user_id = r.owner_user_id
           AND m.audience = 'STAFF'
           AND m.is_active
          WHERE r.jurisdiction = ${lead.jurisdiction}
        )
        UPDATE crm.lead AS t
        SET owner_user_id = covering.owner_user_id
        FROM covering
        WHERE t.id = ${lead.id} AND t.owner_user_id IS NULL
        RETURNING t.id, t.tenant_id, t.title, t.party_id, t.source, t.stage,
                  t.owner_user_id, t.notes, t.lost_reason, t.jurisdiction,
                  t.estimated_value, t.estimated_value_currency,
                  t.captured_at, t.closed_at, t.deleted_at, t.deleted_by_user_id
      `;
      return row ? { lead: toLead(row), policy: TERRITORY } : { lead, policy: null };
    });
  }
}

/**
 * Territory first, rotation second — which is what "a territory rule OVERRIDES
 * the rotation" means as code.
 *
 * The composite is the reason `AssignmentOutcome` carries the policy rather
 * than the strategy declaring one: which rule chose is a fact about THIS lead,
 * not about the wiring, and a field would have made the timeline say
 * `round_robin` for captures the UK desk rule decided.
 *
 * It is a general first-match, not a hardcoded pair, because a third rule is
 * then a line in `setup/` — and the ORDER is the policy. Whoever wires it is
 * stating the firm's precedence, in one place, visibly.
 */
export class FirstMatchAssignment implements AssignmentStrategy {
  constructor(private readonly strategies: readonly AssignmentStrategy[]) {}

  async assign(lead: Lead): Promise<AssignmentOutcome> {
    for (const strategy of this.strategies) {
      const outcome = await strategy.assign(lead);
      // A policy means it CHOSE. Declining is ordinary — no rule covers this
      // country, or the desk it names is gone — so the next strategy gets its
      // turn with the lead exactly as it came in.
      if (outcome.policy !== null) return outcome;
    }
    return { lead, policy: null };
  }
}

/**
 * The firm's territory rules, in Postgres.
 *
 * A separate class from the strategies above and from the lead repository,
 * because it answers a different question: those DECIDE, this is the firm
 * MAINTAINING the rules. The strategy reads the table directly inside its own
 * single UPDATE — it must, since choosing and recording have to be one
 * statement — so this exists for the screen, not for assignment.
 */
export class PostgresTerritoryRules implements TerritoryRules {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly TerritoryRule[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<TerritoryRuleRow[]>`
        SELECT id, tenant_id, jurisdiction, owner_user_id, note
        FROM crm.territory_rule ORDER BY jurisdiction
      `;
      return rows.map(toTerritoryRule);
    });
  }

  async set(r: NewTerritoryRule): Promise<TerritoryRule> {
    return withTenant(this.app, r.tenantId, async (db) => {
      // Upsert on the country, because the schema allows exactly one desk per
      // country. The supplied id is used only when the row is NEW — an existing
      // row keeps its identity, the same way a firm-entity preference does.
      const [row] = await db<TerritoryRuleRow[]>`
        INSERT INTO crm.territory_rule (id, tenant_id, jurisdiction, owner_user_id, note)
        VALUES (${r.id}, ${r.tenantId}, ${r.jurisdiction}, ${r.ownerUserId}, ${r.note})
        ON CONFLICT (tenant_id, jurisdiction)
        DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, note = EXCLUDED.note
        RETURNING id, tenant_id, jurisdiction, owner_user_id, note
      `;
      if (!row) throw new Error("territory rule upsert returned no row");
      return toTerritoryRule(row);
    });
  }
}

interface TerritoryRuleRow {
  id: string;
  tenant_id: string;
  jurisdiction: string;
  owner_user_id: string;
  note: string | null;
}

function toTerritoryRule(r: TerritoryRuleRow): TerritoryRule {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jurisdiction: r.jurisdiction,
    ownerUserId: r.owner_user_id,
    note: r.note,
  };
}
