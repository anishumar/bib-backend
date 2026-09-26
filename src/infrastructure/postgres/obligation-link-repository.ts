// Postgres adapter for WHICH SERVICES OWE WHICH FILING (T6.16, migration 0309)
// — `delivery.obligation_rule_service`, one row per link between a rule's CHAIN
// and a catalogue service, removed by `unlinked_at` and never deleted.
//
// ── THE ONE PLACE A CATALOGUE EDIT MOVES THE CALENDAR ─────────────────────
//
// Adding a filing to a service moves nothing here: the generator does that,
// through its own insert, which is where a withdrawn row is also restored. But
// REMOVING one withdraws filings, and it does it in the same transaction as the
// removal, because each half alone is a broken calendar (see the port). So
// `unlink` is the one method in the product where a person's edit on the
// catalogue writes `delivery.obligation_instance`, and every rule it applies is
// written out below rather than left to a reader to reconstruct.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { mayBeWithdrawn } from "../../domain/obligation/model";
import type {
  RuleServiceLinkRepository,
  UnlinkOutcome,
  UsedInService,
} from "../../usecase/obligation/ports";
import { isoInstant } from "./instant";

/** One element of the `used_in` aggregate, as the database hands it back. */
export interface RawUsedIn {
  service_entry_id: string;
  service_key: string;
  service_name: string | null;
  linked_at: string;
}

/**
 * The live links on a chain, NAMED, as one jsonb array — for a row aliased
 * `outer` carrying `tenant_id` and `lineage_id`.
 *
 * One definition, used by the library's list and by `usedIn` below, so the
 * two cannot disagree about which name a service is shown by. The name is the
 * PUBLISHED version's, else the newest version's: a link hangs off the entry,
 * and a service that has only ever had a draft can carry filings. It is a
 * constant fragment with no parameters, which is what makes `db.unsafe` safe
 * to put it in.
 */
export function usedInSql(outer: string): string {
  return `(
    SELECT coalesce(jsonb_agg(u ORDER BY u.linked_at, u.service_entry_id), '[]'::jsonb)
    FROM (
      SELECT l.service_entry_id,
             e.key AS service_key,
             coalesce(
               (SELECT pv.body->>'name' FROM config.version pv
                 WHERE pv.entry_id = e.id AND pv.tenant_id = e.tenant_id
                   AND pv.status = 'published'
                 ORDER BY pv.version DESC LIMIT 1),
               (SELECT nv.body->>'name' FROM config.version nv
                 WHERE nv.entry_id = e.id AND nv.tenant_id = e.tenant_id
                 ORDER BY nv.version DESC LIMIT 1)
             ) AS service_name,
             ${isoInstant("l.linked_at", "linked_at")}
      FROM delivery.obligation_rule_service l
      JOIN config.entry e ON e.id = l.service_entry_id AND e.tenant_id = l.tenant_id
      WHERE l.tenant_id = ${outer}.tenant_id
        AND l.lineage_id = ${outer}.lineage_id
        AND l.unlinked_at IS NULL
    ) u
  )`;
}

export function toUsedIn(raw: readonly RawUsedIn[] | null): readonly UsedInService[] {
  return (raw ?? []).map((u) => ({
    serviceEntryId: u.service_entry_id,
    serviceKey: u.service_key,
    serviceName: u.service_name,
    linkedAt: u.linked_at,
  }));
}

interface CandidateRow {
  id: string;
  engagement_id: string | null;
  work_item_id: string | null;
  filed_on: string | null;
  resolved_at: string | null;
  statutory_due_on: string;
  is_terminal: boolean;
  needs_decision: boolean;
  cover_engagement_id: string | null;
}

export class PostgresRuleServiceLinkRepository implements RuleServiceLinkRepository {
  constructor(private readonly app: Db) {}

  async usedIn(tenantId: string, lineageId: string): Promise<readonly UsedInService[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The chain's root row stands in for `outer`: a lineage IS its root's id
      // (0303), so this is the same aggregate the library reads, for one chain.
      const [row] = await db<{ used_in: RawUsedIn[] }[]>`
        SELECT ${db.unsafe(usedInSql("root"))} AS used_in
        FROM delivery.obligation_template root
        WHERE root.id = ${lineageId}
      `;
      return toUsedIn(row?.used_in ?? []);
    });
  }

  async link(
    tenantId: string,
    input: {
      readonly id: string;
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
    },
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // The partial unique index over LIVE links is the arbiter, so a
      // double-click writes one row and the caller records one event. A
      // lineage that is not a root, or an entry that is not a service, is
      // refused by 0309's composite keys under their own names.
      const rows = await db<{ id: string }[]>`
        INSERT INTO delivery.obligation_rule_service
          (id, tenant_id, lineage_id, service_entry_id, linked_by_user_id)
        VALUES (${input.id}, ${tenantId}, ${input.lineageId}, ${input.serviceEntryId},
                ${input.byUserId})
        ON CONFLICT (tenant_id, lineage_id, service_entry_id) WHERE unlinked_at IS NULL
        DO NOTHING
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async unlink(
    tenantId: string,
    input: {
      readonly lineageId: string;
      readonly serviceEntryId: string;
      readonly byUserId: string | null;
      readonly firmToday: string;
    },
  ): Promise<UnlinkOutcome | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── 1. the removal ─────────────────────────────────────────────────
      const removed = await db<{ id: string }[]>`
        UPDATE delivery.obligation_rule_service
        SET unlinked_at = now(), unlinked_by_user_id = ${input.byUserId}
        WHERE lineage_id = ${input.lineageId}
          AND service_entry_id = ${input.serviceEntryId}
          AND unlinked_at IS NULL
        RETURNING id
      `;
      if (removed.length === 0) return null;

      // ── 2. this service's rows on this chain, and what still covers them ─
      //
      // "This service's" is the row's own ENGAGEMENT: the engagement whose
      // pinned letter-line version belongs to the service being removed. A row
      // a different service's engagement holds is that service's, and is not
      // touched or counted.
      //
      // "What still covers it" is the question the generator would ask
      // tomorrow: another ACTIVE engagement of the same entity whose service
      // still has a LIVE link to this chain. The removal above is visible to
      // this statement (same transaction), so the service being removed can
      // never be its own cover. When there are several, the one chosen is the
      // earliest to start, then the lowest id: `subjectsFor`'s order, so the
      // row carries the engagement the generator would have given it.
      //
      // Settled history (a terminal state, already past) is left out entirely:
      // years of filed returns were never going to move, and counting them as
      // "kept" would drown the number a partner reads.
      const rows = await db<CandidateRow[]>`
        SELECT oi.id,
               oi.engagement_id,
               oi.work_item_id,
               oi.filed_on::text,
               ${db.unsafe(isoInstant("oi.resolved_at", "resolved_at"))},
               oi.statutory_due_on::text,
               s.is_terminal,
               s.needs_decision,
               cover.engagement_id AS cover_engagement_id
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_state s
          ON s.id = oi.state_id AND s.tenant_id = oi.tenant_id
        JOIN crm.engagement e
          ON e.id = oi.engagement_id AND e.tenant_id = oi.tenant_id
        JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        LEFT JOIN LATERAL (
          SELECT e2.id AS engagement_id
          FROM crm.engagement e2
          JOIN crm.engagement_letter_line ln2
            ON ln2.id = e2.engagement_letter_line_id AND ln2.tenant_id = e2.tenant_id
          JOIN config.version p2
            ON p2.id = ln2.service_version_id AND p2.tenant_id = ln2.tenant_id
          JOIN delivery.obligation_rule_service l2
            ON l2.tenant_id = e2.tenant_id
           AND l2.lineage_id = oi.lineage_id
           AND l2.service_entry_id = p2.entry_id
           AND l2.unlinked_at IS NULL
          WHERE e2.tenant_id = oi.tenant_id
            AND e2.entity_party_id = oi.entity_party_id
            AND e2.status = 'active'
          ORDER BY e2.effective_from, e2.id
          LIMIT 1
        ) cover ON true
        WHERE oi.lineage_id = ${input.lineageId}
          AND pinned.entry_id = ${input.serviceEntryId}
          AND oi.withdrawn_at IS NULL
          AND (NOT s.is_terminal OR oi.statutory_due_on >= ${input.firmToday}::date)
      `;

      // ── 3. classify, with the domain's own rule ─────────────────────────
      const withdrawIds: string[] = [];
      const repoint: { id: string; engagementId: string }[] = [];
      let keptStarted = 0;
      let keptPastDue = 0;
      let keptCoveredElsewhere = 0;
      for (const r of rows) {
        const touched = r.work_item_id !== null || r.filed_on !== null || r.resolved_at !== null;
        const eligible = mayBeWithdrawn(
          {
            workItemId: r.work_item_id,
            filedOn: r.filed_on,
            resolvedAt: r.resolved_at,
            statutoryDueOn: r.statutory_due_on,
            withdrawnAt: null,
          },
          { isTerminal: r.is_terminal, needsDecision: r.needs_decision },
          input.firmToday,
        );
        if (eligible && r.cover_engagement_id === null) withdrawIds.push(r.id);
        else if (eligible) keptCoveredElsewhere += 1;
        else if (touched) keptStarted += 1;
        else keptPastDue += 1;

        // RE-POINTED, so the task it may yet raise is routed by the service
        // that owes it now. Only rows nobody has started: a started or filed
        // row keeps the engagement its work was done under, which is history.
        if (
          !touched &&
          !r.is_terminal &&
          r.cover_engagement_id !== null &&
          r.cover_engagement_id !== r.engagement_id
        ) {
          repoint.push({ id: r.id, engagementId: r.cover_engagement_id });
        }
      }

      // ── 4. the withdrawal, with the guard said again ────────────────────
      //
      // The read above is a snapshot. The UPDATE repeats every condition on
      // the row itself, so a task raised in between keeps its filing, and that
      // filing is then counted as started rather than as withdrawn.
      const withdrawn =
        withdrawIds.length === 0
          ? []
          : await db<{ id: string }[]>`
              UPDATE delivery.obligation_instance AS oi
              SET withdrawn_at = now(),
                  withdrawn_by_user_id = ${input.byUserId},
                  withdrawn_reason = 'service_unlinked'
              FROM delivery.obligation_state s
              WHERE oi.id = ANY(${db.array(withdrawIds)}::uuid[])
                AND s.id = oi.state_id AND s.tenant_id = oi.tenant_id
                AND oi.withdrawn_at IS NULL
                AND oi.work_item_id IS NULL
                AND oi.filed_on IS NULL
                AND oi.resolved_at IS NULL
                AND oi.statutory_due_on >= ${input.firmToday}::date
                AND NOT s.is_terminal
                AND NOT s.needs_decision
              RETURNING oi.id
            `;
      keptStarted += withdrawIds.length - withdrawn.length;

      // ── 5. the re-pointing, same guard ──────────────────────────────────
      const repointed =
        repoint.length === 0
          ? []
          : await db<{ id: string }[]>`
              UPDATE delivery.obligation_instance AS o
              SET engagement_id = r."engagementId"
              FROM jsonb_to_recordset(${JSON.stringify(repoint)}::text::jsonb)
                AS r(id uuid, "engagementId" uuid)
              WHERE o.id = r.id
                AND o.withdrawn_at IS NULL
                AND o.work_item_id IS NULL
                AND o.filed_on IS NULL
                AND o.resolved_at IS NULL
              RETURNING o.id
            `;

      return {
        withdrawn: withdrawn.length,
        kept: keptStarted + keptPastDue + keptCoveredElsewhere,
        keptStarted,
        keptPastDue,
        keptCoveredElsewhere,
        repointed: repointed.length,
      };
    });
  }
}
