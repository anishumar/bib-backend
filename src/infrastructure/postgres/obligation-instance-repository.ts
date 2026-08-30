// Postgres adapter for the calendar itself (T3.2) — the generated rows, and the
// join from a rule to the entities it reaches.
//
// ── THE TWO QUERIES THAT CARRY THE DESIGN ──────────────────────────────────
//
// `subjectsFor` is the whole generation scope in one statement: the right
// country, the right entity type when the rule names one, and an ENGAGEMENT for
// the service that makes it the firm's problem. Change the scope and it changes
// here, not in six places.
//
// `gaps` is its inverse and is the cure for the silent hole. An engagement the
// firm is delivering that the calendar produced nothing for is either perfectly
// ordinary advisory work or a hole in the rules, and the difference is a REASON
// this query computes rather than a guess a screen makes.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ObligationInstance } from "../../domain/obligation/model";
import type {
  CalendarQuery,
  CalendarRow,
  CalendarSource,
  CalendarSubject,
  CoverageGap,
  CoverageGapReason,
  NewObligationInstance,
  ObligationInstanceRepository,
  RaisableObligation,
  SpawnedInstance,
} from "../../usecase/obligation/ports";

/**
 * Only `active` engagements generate.
 *
 * `pending_advance` has not cleared the advance-fee gate, so no work is owed
 * yet; `paused` is the firm having stopped, and issuing filings against a
 * paused engagement would fill a partner's queue with work nobody is doing.
 * `completed` and `cancelled` are over. That leaves one status, and naming it
 * once here is why the scope is auditable.
 */
const GENERATING_STATUS = "active";

interface InstanceRow {
  id: string;
  tenant_id: string;
  template_id: string;
  entity_party_id: string;
  engagement_id: string | null;
  period_start: string;
  period_end: string;
  period_label: string;
  statutory_due_on: string;
  internal_target_on: string;
  state_id: string;
  work_item_id: string | null;
  filed_on: string | null;
}

const INSTANCE_COLUMNS =
  "id, tenant_id, template_id, entity_party_id, engagement_id, period_start::text, " +
  "period_end::text, period_label, statutory_due_on::text, internal_target_on::text, " +
  "state_id, work_item_id, filed_on::text";

function toInstance(r: InstanceRow): ObligationInstance {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    templateId: r.template_id,
    entityPartyId: r.entity_party_id,
    engagementId: r.engagement_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    statutoryDueOn: r.statutory_due_on,
    internalTargetOn: r.internal_target_on,
    stateId: r.state_id,
    workItemId: r.work_item_id,
    filedOn: r.filed_on,
  };
}

export class PostgresObligationInstanceRepository implements ObligationInstanceRepository {
  constructor(private readonly app: Db) {}

  async createIfAbsent(rows: readonly NewObligationInstance[]): Promise<readonly SpawnedInstance[]> {
    if (rows.length === 0) return [];
    const tenantId = rows[0]?.tenantId;
    if (!tenantId) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // ONE multi-row INSERT rather than a statement per row: the generator
      // proposes hundreds and every one of them is a network round trip
      // otherwise. `ON CONFLICT DO NOTHING` against the re-run key is what makes
      // the second sweep a no-op, and `RETURNING` names exactly the rows that
      // were new — which is what the caller records an event for.
      const created = await db<
        { id: string; template_id: string; entity_party_id: string; period_label: string;
          statutory_due_on: string; internal_target_on: string }[]
      >`
        INSERT INTO delivery.obligation_instance
          (id, tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end,
           period_label, statutory_due_on, internal_target_on, state_id)
        SELECT r.id, r."tenantId", r."templateId", r."entityPartyId", r."engagementId",
               r."periodStart"::date, r."periodEnd"::date, r."periodLabel",
               r."statutoryDueOn"::date, r."internalTargetOn"::date, r."stateId"
        -- The DOUBLE CAST is load-bearing. postgres.js
        -- infers a JSON type for a string parameter and encodes it AGAIN, so a
        -- plain ::jsonb produced a jsonb STRING rather than an array and every
        -- sweep died with "cannot call jsonb_to_recordset on a non-array".
        -- Casting to text first tells the driver this is a text parameter and
        -- Postgres parses it once. Found by RUNNING the worker: the unit tests
        -- use a fake repository and the integration test inserted rows by hand,
        -- so neither ever executed this statement.
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
          AS r(id uuid, "tenantId" uuid, "templateId" uuid, "entityPartyId" uuid,
               "engagementId" uuid, "periodStart" text, "periodEnd" text, "periodLabel" text,
               "statutoryDueOn" text, "internalTargetOn" text, "stateId" uuid)
        ON CONFLICT (tenant_id, template_id, entity_party_id, period_start) DO NOTHING
        RETURNING id, template_id, entity_party_id, period_label,
                  statutory_due_on::text, internal_target_on::text
      `;
      return created.map((r) => ({
        id: r.id,
        templateId: r.template_id,
        entityPartyId: r.entity_party_id,
        periodLabel: r.period_label,
        statutoryDueOn: r.statutory_due_on,
        internalTargetOn: r.internal_target_on,
      }));
    });
  }

  async findById(tenantId: string, obligationId: string): Promise<ObligationInstance | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<InstanceRow[]>`
        SELECT ${db.unsafe(INSTANCE_COLUMNS)} FROM delivery.obligation_instance
        WHERE id = ${obligationId}
      `;
      return row ? toInstance(row) : null;
    });
  }

  async calendar(tenantId: string, query: CalendarQuery): Promise<readonly CalendarRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
      // Ordered on the INTERNAL target, not the statutory date: that is the
      // actionable one. A list sorted by the legal deadline tells you when you
      // are already too late.
      const rows = await db<
        {
          id: string; name: string; authority: string | null; module: string | null;
          entity_party_id: string; entity_name: string | null; client_name: string | null;
          period_label: string; statutory_due_on: string; internal_target_on: string;
          state_code: string; state_name: string; is_terminal: boolean; needs_decision: boolean;
          work_item_id: string | null; filed_on: string | null; rule_status: string;
          rule_pack: string;
        }[]
      >`
        SELECT oi.id,
               t.name, t.authority, t.module,
               oi.entity_party_id,
               ep.display_name AS entity_name,
               cp.display_name AS client_name,
               oi.period_label,
               oi.statutory_due_on::text,
               oi.internal_target_on::text,
               s.code AS state_code, s.name AS state_name,
               s.is_terminal, s.needs_decision,
               oi.work_item_id, oi.filed_on::text,
               t.status AS rule_status, t.rule_pack
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_template t
          ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
        JOIN delivery.obligation_state s
          ON s.id = oi.state_id AND s.tenant_id = oi.tenant_id
        LEFT JOIN core.party ep
          ON ep.id = oi.entity_party_id AND ep.tenant_id = oi.tenant_id
        LEFT JOIN crm.engagement e
          ON e.id = oi.engagement_id AND e.tenant_id = oi.tenant_id
        LEFT JOIN core.party cp
          ON cp.id = e.party_id AND cp.tenant_id = oi.tenant_id
        WHERE (${query.from ?? null}::date IS NULL OR oi.internal_target_on >= ${query.from ?? null}::date)
          AND (${query.to ?? null}::date IS NULL OR oi.internal_target_on <= ${query.to ?? null}::date)
          AND (${query.entityPartyId ?? null}::uuid IS NULL OR oi.entity_party_id = ${query.entityPartyId ?? null}::uuid)
          AND (${query.module ?? null}::text IS NULL OR t.module = ${query.module ?? null}::text)
          AND (${query.includeSettled ?? false} OR NOT s.is_terminal)
        ORDER BY oi.internal_target_on, t.name
        LIMIT ${limit}
      `;
      return rows.map(
        (r): CalendarRow => ({
          id: r.id,
          name: r.name,
          authority: r.authority,
          module: r.module,
          entityPartyId: r.entity_party_id,
          entityName: r.entity_name,
          clientName: r.client_name,
          periodLabel: r.period_label,
          statutoryDueOn: r.statutory_due_on,
          internalTargetOn: r.internal_target_on,
          stateCode: r.state_code,
          stateName: r.state_name,
          isTerminal: r.is_terminal,
          needsDecision: r.needs_decision,
          workItemId: r.work_item_id,
          filedOn: r.filed_on,
          // SHOWN, never hidden. The date came from a document rather than from
          // a partner, and a plausible-looking wrong rule is the dangerous kind.
          ruleUnconfirmed: r.rule_status !== "confirmed",
          rulePack: r.rule_pack,
        }),
      );
    });
  }

  async listRaisable(
    tenantId: string,
    asOf: string,
    limit: number,
  ): Promise<readonly RaisableObligation[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        {
          id: string; entity_party_id: string; engagement_id: string | null; period_label: string;
          statutory_due_on: string; template_name: string; authority: string | null;
          service_entry_id: string | null; entity_name: string | null;
        }[]
      >`
        SELECT oi.id, oi.entity_party_id, oi.engagement_id, oi.period_label,
               oi.statutory_due_on::text,
               t.name AS template_name, t.authority, t.service_entry_id,
               ep.display_name AS entity_name
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_template t
          ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
        LEFT JOIN core.party ep
          ON ep.id = oi.entity_party_id AND ep.tenant_id = oi.tenant_id
        WHERE oi.work_item_id IS NULL
          AND oi.filed_on IS NULL
          AND oi.internal_target_on <= ${asOf}::date
        ORDER BY oi.internal_target_on
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        id: r.id,
        entityPartyId: r.entity_party_id,
        engagementId: r.engagement_id,
        periodLabel: r.period_label,
        statutoryDueOn: r.statutory_due_on,
        templateName: r.template_name,
        authority: r.authority,
        serviceEntryId: r.service_entry_id,
        entityName: r.entity_name,
      }));
    });
  }

  async attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      // `WHERE work_item_id IS NULL` makes a redelivered raise a no-op rather
      // than a second task pointing at the same filing — the sweep is
      // at-least-once like everything else the engine touches.
      await db`
        UPDATE delivery.obligation_instance SET work_item_id = ${workItemId}
        WHERE id = ${obligationId} AND work_item_id IS NULL
      `;
    });
  }

  async redateUnstarted(
    tenantId: string,
    templateId: string,
    leadTimeDays: number,
  ): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      // The statutory date is untouched — the law's, not the firm's — and the
      // clamp lives in the arithmetic: GREATEST is what stops a long lead time
      // pushing the target past the deadline, which the CHECK would refuse
      // anyway. Only rows nobody has started; see the port.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance
        SET internal_target_on = LEAST(
              statutory_due_on,
              statutory_due_on - (${leadTimeDays}::integer * INTERVAL '1 day')
            )::date
        WHERE template_id = ${templateId}
          AND work_item_id IS NULL
          AND filed_on IS NULL
        RETURNING id
      `;
      return rows.length;
    });
  }

  async countFor(tenantId: string, templateId: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.obligation_instance
        WHERE template_id = ${templateId}
      `;
      return Number(row?.n ?? 0);
    });
  }
}

export class PostgresCalendarSource implements CalendarSource {
  constructor(private readonly app: Db) {}

  async subjectsFor(
    tenantId: string,
    rule: {
      readonly jurisdiction: string;
      readonly entityType: string | null;
      readonly serviceEntryId: string | null;
    },
  ): Promise<readonly CalendarSubject[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        { entity_party_id: string; engagement_id: string; effective_from: string }[]
      >`
        SELECT DISTINCT le.party_id AS entity_party_id, e.id AS engagement_id,
               e.effective_from::text
        FROM core.legal_entity le
        JOIN crm.engagement e
          ON e.entity_party_id = le.party_id AND e.tenant_id = le.tenant_id
         AND e.status = ${GENERATING_STATUS}
        -- LEFT from here down. A rule that names NO service reaches every live
        -- engagement, including one whose catalogue version has since been
        -- unpublished — losing an obligation because we could not resolve what
        -- the client bought is the worst failure available here, and it is the
        -- same call unspawnedActivations makes about spawning the job.
        LEFT JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        WHERE le.jurisdiction = ${rule.jurisdiction}
          AND (${rule.entityType}::text IS NULL OR le.entity_type = ${rule.entityType}::text)
          AND (${rule.serviceEntryId}::uuid IS NULL
               OR pinned.entry_id = ${rule.serviceEntryId}::uuid)
      `;
      return rows.map((r) => ({
        entityPartyId: r.entity_party_id,
        engagementId: r.engagement_id,
        effectiveFrom: r.effective_from,
      }));
    });
  }

  async gaps(tenantId: string): Promise<readonly CoverageGap[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // THE ANTI-JOIN, plus the reason. Every branch of the CASE names something
      // a partner can do next, and NONE of them is an error: most advisory work
      // legitimately has no compliance rule at all, which is why
      // `no_rule_names_this_service` is first and is the ordinary answer.
      const rows = await db<
        {
          engagement_id: string; entity_party_id: string; entity_name: string | null;
          client_name: string | null; service_name: string | null; jurisdiction: string | null;
          reason: string; blocked_rule_ids: string[] | null;
        }[]
      >`
        WITH live AS (
          SELECT e.id                     AS engagement_id,
                 e.tenant_id,
                 e.entity_party_id,
                 le.jurisdiction,
                 pinned.entry_id          AS service_entry_id,
                 published.body->>'name'  AS service_name,
                 ep.display_name          AS entity_name,
                 cp.display_name          AS client_name
          FROM crm.engagement e
          LEFT JOIN core.legal_entity le
            ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
          LEFT JOIN crm.engagement_letter_line ln
            ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
          LEFT JOIN config.version pinned
            ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
          LEFT JOIN config.version published
            ON published.entry_id = pinned.entry_id AND published.tenant_id = pinned.tenant_id
           AND published.status = 'published'
          LEFT JOIN core.party ep
            ON ep.id = e.entity_party_id AND ep.tenant_id = e.tenant_id
          LEFT JOIN core.party cp
            ON cp.id = e.party_id AND cp.tenant_id = e.tenant_id
          WHERE e.status = ${GENERATING_STATUS}
            AND NOT EXISTS (
              SELECT 1 FROM delivery.obligation_instance oi
              WHERE oi.engagement_id = e.id AND oi.tenant_id = e.tenant_id
            )
        ),
        matched AS (
          SELECT l.engagement_id,
                 count(*) FILTER (WHERE t.id IS NOT NULL)                       AS named,
                 count(*) FILTER (WHERE t.jurisdiction = l.jurisdiction)        AS in_country,
                 count(*) FILTER (WHERE t.jurisdiction = l.jurisdiction
                                    AND t.is_active)                            AS live_rules,
                 count(*) FILTER (WHERE t.jurisdiction = l.jurisdiction
                                    AND t.is_active
                                    AND t.due_rule IS NOT NULL
                                    AND t.recurrence <> 'event')                AS generating,
                 array_remove(array_agg(t.id) FILTER (
                   WHERE t.jurisdiction = l.jurisdiction
                     AND (NOT t.is_active OR t.due_rule IS NULL OR t.recurrence = 'event')
                 ), NULL)                                                       AS blocked_rule_ids
          FROM live l
          LEFT JOIN delivery.obligation_template t
            -- THE GENERATOR'S OWN PREDICATE, and the first version of this
            -- query got it wrong: it compared t.service_entry_id to
            -- l.service_entry_id, which is never true for a rule that names NO
            -- service — and every rule in the shipped India pack names none,
            -- because the pack cannot know a firm's own catalogue keys. So a
            -- firm that had just loaded fifty-seven rules was told none of them
            -- named its services. A NULL here means "every service", exactly as
            -- subjectsFor reads it.
            ON t.tenant_id = l.tenant_id
           AND (t.service_entry_id IS NULL OR t.service_entry_id = l.service_entry_id)
          GROUP BY l.engagement_id
        )
        SELECT l.engagement_id, l.entity_party_id, l.entity_name, l.client_name,
               l.service_name, l.jurisdiction,
               CASE
                 -- FIRST, because it is the most actionable and because every
                 -- other branch would be misleading here: a rule matches an
                 -- entity's jurisdiction exactly, so a company nobody has
                 -- registered as a legal entity matches nothing at all,
                 -- whatever rules the firm holds.
                 WHEN l.jurisdiction IS NULL THEN 'entity_not_registered'
                 WHEN m.named = 0        THEN 'no_rule_names_this_service'
                 WHEN m.in_country = 0   THEN 'no_rule_for_jurisdiction'
                 WHEN m.live_rules = 0   THEN 'rules_retired'
                 WHEN m.generating = 0   THEN 'rules_need_a_formula'
                 ELSE 'nothing_due_yet'
               END AS reason,
               m.blocked_rule_ids
        FROM live l
        JOIN matched m ON m.engagement_id = l.engagement_id
        ORDER BY l.client_name NULLS LAST, l.entity_name NULLS LAST
      `;
      return rows.map(
        (r): CoverageGap => ({
          engagementId: r.engagement_id,
          entityPartyId: r.entity_party_id,
          entityName: r.entity_name,
          clientName: r.client_name,
          serviceName: r.service_name,
          jurisdiction: r.jurisdiction,
          reason: r.reason as CoverageGapReason,
          blockedRuleIds: r.blocked_rule_ids ?? [],
        }),
      );
    });
  }
}
