// Postgres adapter for the calendar itself (T3.2) — the generated rows, and the
// join from a rule to the entities it reaches.
//
// ── THE TWO QUERIES THAT CARRY THE DESIGN ──────────────────────────────────
//
// `subjectsFor` is the whole generation scope in one statement: the right
// country, the right entity type when the rule names one, and an ENGAGEMENT
// whose service has a live catalogue LINK to the rule's chain (T6.16, 0309).
// Change the scope and it changes here, not in six places.
//
// ── A WITHDRAWN ROW IS IN NONE OF THESE READS ─────────────────────────────
//
// Removing a filing from a service withdraws its untouched upcoming rows
// (`obligation-link-repository.ts`). Every reader here that shows, raises,
// misses or decides a filing says `withdrawn_at IS NULL`, and `findById` is
// the one that does not, because restoring a row has to be able to see it.
//
// `gaps` is its inverse and is the cure for the silent hole. An engagement the
// firm is delivering that the calendar produced nothing for is either perfectly
// ordinary advisory work or a hole in the rules, and the difference is a REASON
// this query computes rather than a guess a screen makes.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { IsoDate, ObligationInstance, WithdrawnReason } from "../../domain/obligation/model";
import type {
  CalendarQuery,
  CalendarRow,
  CalendarSource,
  CalendarSubject,
  CoverageGap,
  CoverageGapReason,
  DecisionRow,
  MissableObligation,
  NewObligationInstance,
  ObligationInstanceRepository,
  ProposalOutcome,
  RaisableObligation,
  RestatedInstance,
  RestoredInstance,
  SpawnedInstance,
  UnstartedInstance,
} from "../../usecase/obligation/ports";
import { filingCountryZones } from "../../domain/obligation/filing-zone";
import { isoInstant } from "./instant";
import { lockChainsForWrite } from "./obligation-chain-lock";

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

/**
 * THE LINK, ASKED AGAIN AT THE WRITE (0309), of a proposal row aliased `r`.
 *
 * The generator reads its subjects (who a rule reaches, through which
 * service) in one transaction and writes the rows in another, a whole sweep
 * later for a large firm. A filing removed from a service in between must not
 * be written for that service's clients anyway, and a withdrawn row must not
 * be restored under a link that no longer exists. So the proposal's rule's
 * CHAIN must still have a live link to its engagement's pinned service at the
 * moment of the write. A proposal naming no engagement is not a link's to
 * judge; nothing proposes one today (0053 keeps the column nullable for the
 * compliance-engine reading nobody has chosen).
 *
 * "At the moment of the write" holds only because `createIfAbsent` takes each
 * chain's lock before this is asked (`obligation-chain-lock.ts`). This test
 * reads the link from its statement's snapshot, so on its own a removal that
 * committed while the statement ran was invisible to it, and the removal could
 * not see the rows being written either: they committed live under no link.
 *
 * A constant fragment with no parameters, which is what makes `db.unsafe`
 * safe to put it in.
 */
const STILL_LINKED = `(
  r."engagementId" IS NULL OR EXISTS (
    SELECT 1
    FROM delivery.obligation_template gt
    JOIN crm.engagement ge
      ON ge.id = r."engagementId" AND ge.tenant_id = gt.tenant_id
    JOIN crm.engagement_letter_line gl
      ON gl.id = ge.engagement_letter_line_id AND gl.tenant_id = ge.tenant_id
    JOIN config.version gv
      ON gv.id = gl.service_version_id AND gv.tenant_id = gl.tenant_id
    JOIN delivery.obligation_rule_service gk
      ON gk.tenant_id = gt.tenant_id AND gk.lineage_id = gt.lineage_id
     AND gk.service_entry_id = gv.entry_id AND gk.unlinked_at IS NULL
    WHERE gt.id = r."templateId" AND gt.tenant_id = r."tenantId"
  )
)`;

/**
 * THE ZONE A FILING'S DAY IS READ IN (Q070 Part B, B1): `filingZone` in the
 * domain, in SQL, over a row aliased `oi` with its rule `t`, its entity's
 * registration `le` (LEFT) and its firm `ten`. The client entity's own zone;
 * else the filing country's one zone (the domain's table, with New York for
 * the United States); else the firm's own company registered in that country;
 * else the firm's.
 *
 * The country table is the domain's and is inlined as a literal: zone names
 * and country codes only (`[A-Za-z0-9/_+-]`), so a constant fragment with no
 * parameters, which is what makes `db.unsafe` safe to put it in.
 */
const COUNTRY_ZONES = JSON.stringify(filingCountryZones()).replace(/'/g, "''");
const FILING_ZONE = `COALESCE(
  le.time_zone,
  ('${COUNTRY_ZONES}'::jsonb ->> t.jurisdiction),
  (SELECT fle.time_zone FROM core.legal_entity fle
    WHERE fle.tenant_id = oi.tenant_id AND fle.jurisdiction = t.jurisdiction
      AND fle.time_zone IS NOT NULL
      AND crm.is_firm_entity(fle.tenant_id, fle.party_id)
    ORDER BY fle.party_id LIMIT 1),
  ten.time_zone)`;

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
  filed_by_work_item_id: string | null;
  resolution_option_id: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
  withdrawn_at: string | null;
  withdrawn_by_user_id: string | null;
  withdrawn_reason: string | null;
  period_basis: string;
}

const INSTANCE_COLUMNS =
  "id, tenant_id, template_id, entity_party_id, engagement_id, period_start::text, " +
  "period_end::text, period_label, statutory_due_on::text, internal_target_on::text, " +
  "state_id, work_item_id, filed_on::text, filed_by_work_item_id, resolution_option_id, " +
  "resolution_reason, " +
  isoInstant("resolved_at", "resolved_at") + ", " +
  isoInstant("withdrawn_at", "withdrawn_at") + ", withdrawn_by_user_id, withdrawn_reason, period_basis";

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
    filedByWorkItemId: r.filed_by_work_item_id,
    resolutionOptionId: r.resolution_option_id,
    resolutionReason: r.resolution_reason,
    resolvedAt: r.resolved_at,
    withdrawnAt: r.withdrawn_at,
    withdrawnByUserId: r.withdrawn_by_user_id,
    withdrawnReason: r.withdrawn_reason === null ? null : (r.withdrawn_reason as WithdrawnReason),
    periodBasis: r.period_basis as ObligationInstance["periodBasis"],
  };
}

export class PostgresObligationInstanceRepository implements ObligationInstanceRepository {
  constructor(private readonly app: Db) {}

  async createIfAbsent(rows: readonly NewObligationInstance[]): Promise<ProposalOutcome> {
    if (rows.length === 0) return { created: [], restored: [] };
    const tenantId = rows[0]?.tenantId;
    if (!tenantId) return { created: [], restored: [] };
    const proposals = JSON.stringify(rows);
    return withTenant(this.app, tenantId, async (db) => {
      // ── 0. TAKE EACH CHAIN'S TURN, SHARED ─────────────────────────────────
      //
      // Before either statement below starts, so `STILL_LINKED` is asked
      // after any removal of these filings has committed, and a removal that
      // arrives now waits for this write and then sees what it wrote. See
      // `obligation-chain-lock.ts`.
      await lockChainsForWrite(db, rows.map((r) => r.templateId));

      // ── 1. A WITHDRAWN ROW THE PROPOSAL HOLDS THE KEY OF COMES BACK (0309) ─
      //
      // Same row, same id, in place: the withdrawal cleared, the dates the
      // proposal carries (computed by `scheduleFor`, never here), and the rule
      // and engagement re-pinned to the proposal's, which are the rule that
      // governs the period and the engagement that reaches it now. Re-pinning
      // the template fires 0303's lineage trigger, which recomputes the same
      // chain. The guard is on the row being updated, so a row that somehow
      // gained a task since stays exactly as it is (0309's CHECK says a
      // withdrawn row cannot have one anyway).
      //
      // The FROM reads the pre-update row, which is how `was_withdrawn_at`
      // survives into RETURNING: restoring clears the column, and the ledger's
      // `obligation.restored` is then the only place the withdrawal is kept.
      const restored = await db<
        { id: string; template_id: string; entity_party_id: string; engagement_id: string | null;
          period_label: string; statutory_due_on: string; internal_target_on: string;
          was_withdrawn_at: string }[]
      >`
        UPDATE delivery.obligation_instance AS o
        SET withdrawn_at         = NULL,
            withdrawn_by_user_id = NULL,
            withdrawn_reason     = NULL,
            template_id          = p."templateId",
            engagement_id        = p."engagementId",
            statutory_due_on     = p."statutoryDueOn"::date,
            internal_target_on   = p."internalTargetOn"::date,
            state_id             = p."stateId"
        FROM (
          SELECT r.*, held.id AS held_id,
                 ${db.unsafe(isoInstant("held.withdrawn_at", "was_withdrawn_at"))}
          FROM jsonb_to_recordset(${proposals}::text::jsonb)
            AS r(id uuid, "tenantId" uuid, "templateId" uuid, "entityPartyId" uuid,
                 "engagementId" uuid, "periodStart" text, "periodEnd" text, "periodLabel" text,
                 "statutoryDueOn" text, "internalTargetOn" text, "stateId" uuid)
          JOIN delivery.obligation_template t
            ON t.id = r."templateId" AND t.tenant_id = r."tenantId"
          JOIN delivery.obligation_instance held
            ON held.tenant_id = r."tenantId"
           AND held.lineage_id = t.lineage_id
           AND held.entity_party_id = r."entityPartyId"
           AND held.period_start = r."periodStart"::date
          WHERE held.withdrawn_at IS NOT NULL
            AND ${db.unsafe(STILL_LINKED)}
        ) AS p
        WHERE o.id = p.held_id
          AND o.withdrawn_at IS NOT NULL
          AND o.work_item_id IS NULL
          AND o.filed_on IS NULL
          AND o.resolved_at IS NULL
        RETURNING o.id, o.template_id, o.entity_party_id, o.engagement_id, o.period_label,
                  o.statutory_due_on::text, o.internal_target_on::text, p.was_withdrawn_at
      `;

      // ── 2. EVERYTHING ELSE IS NEW, OR ALREADY THERE ─────────────────────
      //
      // ONE multi-row INSERT rather than a statement per row: the generator
      // proposes hundreds and every one of them is a network round trip
      // otherwise. `ON CONFLICT DO NOTHING` against the re-run key is what makes
      // the second sweep a no-op, and `RETURNING` names exactly the rows that
      // were new — which is what the caller records an event for. A row the
      // step above restored holds its key, so it is skipped here.
      const created = await db<
        { id: string; template_id: string; entity_party_id: string; engagement_id: string | null;
          period_label: string; statutory_due_on: string; internal_target_on: string }[]
      >`
        INSERT INTO delivery.obligation_instance
          (id, tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end,
           period_label, statutory_due_on, internal_target_on, state_id, period_basis)
        SELECT r.id, r."tenantId", r."templateId", r."entityPartyId", r."engagementId",
               r."periodStart"::date, r."periodEnd"::date, r."periodLabel",
               r."statutoryDueOn"::date, r."internalTargetOn"::date, r."stateId",
               COALESCE(r."periodBasis", 'rule_calendar')
        -- The DOUBLE CAST is load-bearing. postgres.js
        -- infers a JSON type for a string parameter and encodes it AGAIN, so a
        -- plain ::jsonb produced a jsonb STRING rather than an array and every
        -- sweep died with "cannot call jsonb_to_recordset on a non-array".
        -- Casting to text first tells the driver this is a text parameter and
        -- Postgres parses it once. Found by RUNNING the worker: the unit tests
        -- use a fake repository and the integration test inserted rows by hand,
        -- so neither ever executed this statement.
        FROM jsonb_to_recordset(${proposals}::text::jsonb)
          AS r(id uuid, "tenantId" uuid, "templateId" uuid, "entityPartyId" uuid,
               "engagementId" uuid, "periodStart" text, "periodEnd" text, "periodLabel" text,
               "statutoryDueOn" text, "internalTargetOn" text, "stateId" uuid,
               "periodBasis" text)
        WHERE ${db.unsafe(STILL_LINKED)}
          -- A PERIOD CUT ON THE CLIENT'S YEAR NEVER OVERLAPS ONE ALREADY HELD
          -- (0358, Q078's default). A client whose year end changed would
          -- otherwise get the new cut's period beside the old one's for the
          -- same months: two returns for one stretch. The rows already
          -- generated stay; the new cut starts where they leave off. A rule
          -- on its own year cannot produce an overlap (its shape is locked
          -- once rows exist), so it is not asked.
          AND (COALESCE(r."periodBasis", 'rule_calendar') = 'rule_calendar'
               OR NOT EXISTS (
                 SELECT 1
                   FROM delivery.obligation_template ot
                   JOIN delivery.obligation_instance x
                     ON x.tenant_id = ot.tenant_id AND x.lineage_id = ot.lineage_id
                  WHERE ot.id = r."templateId" AND ot.tenant_id = r."tenantId"
                    AND x.entity_party_id = r."entityPartyId"
                    AND x.period_start <> r."periodStart"::date
                    AND x.period_start <= r."periodEnd"::date
                    AND x.period_end >= r."periodStart"::date
                    AND x.withdrawn_at IS NULL))
        -- THE LINEAGE, not the template (0303). The template key is implied by
        -- it, and it also refuses a period an EARLIER rule in the chain already
        -- holds — the row a supersession could not hand over because somebody
        -- had started it.
        ON CONFLICT (tenant_id, lineage_id, entity_party_id, period_start) DO NOTHING
        RETURNING id, template_id, entity_party_id, engagement_id, period_label,
                  statutory_due_on::text, internal_target_on::text
      `;
      const spawned = (r: {
        id: string; template_id: string; entity_party_id: string; engagement_id: string | null;
        period_label: string; statutory_due_on: string; internal_target_on: string;
      }): SpawnedInstance => ({
        id: r.id,
        templateId: r.template_id,
        entityPartyId: r.entity_party_id,
        engagementId: r.engagement_id,
        periodLabel: r.period_label,
        statutoryDueOn: r.statutory_due_on,
        internalTargetOn: r.internal_target_on,
      });
      return {
        created: created.map(spawned),
        restored: restored.map((r): RestoredInstance => ({ ...spawned(r), withdrawnAt: r.was_withdrawn_at })),
      };
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
          rule_pack: string; resolution_option_id: string | null;
          resolution_name: string | null; resolution_reason: string | null;
          resolved_at: string | null;
          filed_by_work_item_id: string | null; filed_by_title: string | null;
          filing_zone: string; filing_today: string;
          period_basis: string; rule_year_start_month: number;
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
               oi.resolution_option_id, ro.name AS resolution_name,
               oi.resolution_reason, ${db.unsafe(isoInstant("oi.resolved_at", "resolved_at"))},
               t.status AS rule_status, t.rule_pack,
               oi.filed_by_work_item_id, fb.title AS filed_by_title,
               z.zone AS filing_zone,
               oi.period_basis, t.fiscal_year_start_month AS rule_year_start_month,
               (COALESCE(${query.now ?? null}::timestamptz, now()) AT TIME ZONE z.zone)::date::text
                 AS filing_today
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_template t
          ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
        JOIN delivery.obligation_state s
          ON s.id = oi.state_id AND s.tenant_id = oi.tenant_id
        JOIN tenancy.tenant ten
          ON ten.id = oi.tenant_id
        LEFT JOIN core.legal_entity le
          ON le.party_id = oi.entity_party_id AND le.tenant_id = oi.tenant_id
        CROSS JOIN LATERAL (SELECT ${db.unsafe(FILING_ZONE)} AS zone) z
        LEFT JOIN delivery.work_item fb
          ON fb.id = oi.filed_by_work_item_id AND fb.tenant_id = oi.tenant_id
        LEFT JOIN core.party ep
          ON ep.id = oi.entity_party_id AND ep.tenant_id = oi.tenant_id
        LEFT JOIN crm.engagement e
          ON e.id = oi.engagement_id AND e.tenant_id = oi.tenant_id
        LEFT JOIN core.party cp
          ON cp.id = e.party_id AND cp.tenant_id = oi.tenant_id
        LEFT JOIN delivery.obligation_resolution_option ro
          ON ro.id = oi.resolution_option_id AND ro.tenant_id = oi.tenant_id
        WHERE (${query.from ?? null}::date IS NULL OR oi.internal_target_on >= ${query.from ?? null}::date)
          AND (${query.to ?? null}::date IS NULL OR oi.internal_target_on <= ${query.to ?? null}::date)
          AND (${query.entityPartyId ?? null}::uuid IS NULL OR oi.entity_party_id = ${query.entityPartyId ?? null}::uuid)
          AND (${query.module ?? null}::text IS NULL OR t.module = ${query.module ?? null}::text)
          AND (${query.includeSettled ?? false} OR NOT s.is_terminal)
          AND (${query.filedByWorkItemId ?? null}::uuid IS NULL
               OR oi.filed_by_work_item_id = ${query.filedByWorkItemId ?? null}::uuid)
          -- A WITHDRAWN filing is off the calendar whatever else is asked
          -- (0309). It is not a flavour of "settled": it was never filed or
          -- decided, and includeSettled must not bring it back.
          AND oi.withdrawn_at IS NULL
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
          filedByWorkItemId: r.filed_by_work_item_id,
          filedByTitle: r.filed_by_title,
          filingZone: r.filing_zone,
          filingToday: r.filing_today,
          periodBasis: r.period_basis as CalendarRow["periodBasis"],
          ruleYearStartMonth: r.rule_year_start_month,
          resolutionOptionId: r.resolution_option_id,
          resolutionName: r.resolution_name,
          resolutionReason: r.resolution_reason,
          resolvedAt: r.resolved_at,
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
          entity_name: string | null;
        }[]
      >`
        SELECT oi.id, oi.entity_party_id, oi.engagement_id, oi.period_label,
               oi.statutory_due_on::text,
               t.name AS template_name, t.authority,
               ep.display_name AS entity_name
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_template t
          ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
        LEFT JOIN core.party ep
          ON ep.id = oi.entity_party_id AND ep.tenant_id = oi.tenant_id
        WHERE oi.work_item_id IS NULL
          AND oi.filed_on IS NULL
          -- A withdrawn filing never gets a task (0309).
          AND oi.withdrawn_at IS NULL
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
        entityName: r.entity_name,
      }));
    });
  }

  async attachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // `WHERE work_item_id IS NULL` makes a redelivered raise a no-op rather
      // than a second task pointing at the same filing — the sweep is
      // at-least-once like everything else the engine touches. And
      // `withdrawn_at IS NULL`: a filing taken off since it was read gets no
      // task (0309's CHECK would refuse one anyway, as a wall under this).
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance SET work_item_id = ${workItemId}
        WHERE id = ${obligationId} AND work_item_id IS NULL AND withdrawn_at IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async detachWorkItem(tenantId: string, obligationId: string, workItemId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // Guarded in the WHERE (CA#36): a filed filing keeps the task that filed
      // it, and a task that no longer files this one detaches nothing.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance SET work_item_id = NULL
        WHERE id = ${obligationId} AND work_item_id = ${workItemId} AND filed_on IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async findByWorkItem(tenantId: string, workItemId: string): Promise<ObligationInstance | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<InstanceRow[]>`
        SELECT ${db.unsafe(INSTANCE_COLUMNS)} FROM delivery.obligation_instance
        WHERE work_item_id = ${workItemId}
      `;
      const row = rows[0];
      return row ? toInstance(row) : null;
    });
  }

  async markFiled(
    tenantId: string,
    obligationId: string,
    filedOn: IsoDate,
    stateId: string,
    filedByWorkItemId: string,
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // `AND filed_on IS NULL` is what makes this safe to call twice. Two
      // concurrent completions of the same task both reach here; exactly one
      // updates a row, and only that one's caller writes `obligation.filed`.
      // The check cannot live in the caller — between its read and its write
      // the other request has already committed.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance
        SET filed_on = ${filedOn}::date, state_id = ${stateId},
            filed_by_work_item_id = ${filedByWorkItemId}
        WHERE id = ${obligationId} AND filed_on IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async clearFiled(
    tenantId: string,
    obligationId: string,
    stateId: string,
    filedByWorkItemId: string,
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // The task in the WHERE (0357): a reopened task un-files only what it
      // filed, decided by the database between the read and the write.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance
        SET filed_on = NULL, state_id = ${stateId}, filed_by_work_item_id = NULL
        WHERE id = ${obligationId} AND filed_on IS NOT NULL
          AND filed_by_work_item_id = ${filedByWorkItemId}
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async listFiledBy(tenantId: string, workItemId: string): Promise<readonly ObligationInstance[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<InstanceRow[]>`
        SELECT ${db.unsafe(INSTANCE_COLUMNS)} FROM delivery.obligation_instance
        WHERE filed_by_work_item_id = ${workItemId}
        ORDER BY statutory_due_on, id
      `;
      return rows.map(toInstance);
    });
  }

  async listJobFilingsForTask(
    tenantId: string,
    workItemId: string,
  ): Promise<readonly ObligationInstance[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // THE JOB'S PERIOD, THE TASK'S COMPANY, THE TASK'S SERVICE (Q063). The
      // service half is `earliestFilingDue`'s (obligation-coverage.ts), the
      // rule CA#11 already applies to the same task's due date: a live link
      // from the row's chain to the entry the task's letter line pinned, or
      // the row owed under this very engagement. CONTAINED in the period, so
      // a month's task never files the quarter it falls in.
      const rows = await db<InstanceRow[]>`
        SELECT ${db.unsafe(INSTANCE_COLUMNS)} FROM delivery.obligation_instance
        WHERE id IN (
          SELECT oi.id
            FROM delivery.work_item wi
            JOIN delivery.job j
              ON j.id = wi.job_id AND j.tenant_id = wi.tenant_id
            JOIN crm.engagement e
              ON e.id = wi.engagement_id AND e.tenant_id = wi.tenant_id
            JOIN crm.engagement_letter_line ln
              ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
            JOIN config.version pinned
              ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
            JOIN delivery.obligation_instance oi
              ON oi.tenant_id = wi.tenant_id AND oi.entity_party_id = e.entity_party_id
            JOIN delivery.obligation_state os
              ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
           WHERE wi.id = ${workItemId}
             AND j.period_start IS NOT NULL
             AND oi.period_start >= j.period_start
             AND oi.period_end <= j.period_end
             AND oi.filed_on IS NULL
             AND oi.withdrawn_at IS NULL
             AND NOT os.is_terminal
             AND (oi.engagement_id = e.id
                  OR EXISTS (SELECT 1 FROM delivery.obligation_rule_service k
                              WHERE k.tenant_id = oi.tenant_id
                                AND k.lineage_id = oi.lineage_id
                                AND k.service_entry_id = pinned.entry_id
                                AND k.unlinked_at IS NULL))
        )
        ORDER BY statutory_due_on, id
      `;
      return rows.map(toInstance);
    });
  }

  async listMissable(
    tenantId: string,
    asOf: string,
    floor: string | null,
    limit: number,
    now: string,
  ): Promise<readonly MissableObligation[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Every condition `shouldBeFlaggedMissed` names, in SQL, because the sweep
      // must not fetch rows in order to drop them: on a newly onboarded firm the
      // rows excluded by `floor` are the bulk of the table.
      //
      // `can still be missed` is the two FLAGS and never a code — the same rule
      // the whole module keeps. A row already in the missed state carries
      // `needs_decision`, so it does not come back on the next sweep, and that
      // is the entire idempotency story.
      //
      // THE FILING'S DAY, NOT THE FIRM'S (Q070 Part B): the firm's day moved
      // by however many days the filing's zone is ahead of or behind the
      // firm's at this instant (`filingDay` in the domain).
      const rows = await db<
        {
          id: string; statutory_due_on: string; entity_party_id: string;
          template_name: string; period_label: string; work_item_id: string | null;
          filing_day: string; filing_zone: string;
        }[]
      >`
        SELECT oi.id, oi.statutory_due_on::text, oi.entity_party_id,
               t.name AS template_name, oi.period_label, oi.work_item_id,
               fd.filing_day::text, z.zone AS filing_zone
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_template t
          ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
        JOIN delivery.obligation_state s
          ON s.id = oi.state_id AND s.tenant_id = oi.tenant_id
        JOIN tenancy.tenant ten
          ON ten.id = oi.tenant_id
        LEFT JOIN core.legal_entity le
          ON le.party_id = oi.entity_party_id AND le.tenant_id = oi.tenant_id
        CROSS JOIN LATERAL (SELECT ${db.unsafe(FILING_ZONE)} AS zone) z
        CROSS JOIN LATERAL (
          SELECT ${asOf}::date
                 + ((${now}::timestamptz AT TIME ZONE z.zone)::date
                    - (${now}::timestamptz AT TIME ZONE ten.time_zone)::date) AS filing_day
        ) fd
        WHERE oi.statutory_due_on < fd.filing_day
          AND oi.filed_on IS NULL
          AND oi.resolved_at IS NULL
          -- A withdrawn filing is never MISSED (0309). It was upcoming when it
          -- came off and crosses its date later; without this it would turn
          -- missed and fill the decision queue with returns the firm stopped
          -- doing, which is 2026-09-18 again.
          AND oi.withdrawn_at IS NULL
          AND NOT s.is_terminal
          AND NOT s.needs_decision
          AND (${floor}::date IS NULL OR oi.statutory_due_on >= ${floor}::date)
        ORDER BY oi.statutory_due_on
        LIMIT ${limit}
      `;
      return rows.map(
        (r): MissableObligation => ({
          id: r.id,
          statutoryDueOn: r.statutory_due_on,
          entityPartyId: r.entity_party_id,
          templateName: r.template_name,
          periodLabel: r.period_label,
          workItemId: r.work_item_id,
          filingDay: r.filing_day,
          filingZone: r.filing_zone,
        }),
      );
    });
  }

  async markMissed(tenantId: string, obligationId: string, stateId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // The WHERE clause re-states the guard rather than trusting the list that
      // produced this id, and that is `markFiled`'s argument: between the read
      // and this write somebody may have filed it or another sweep may have
      // moved it. Exactly one caller updates a row, and only that one writes
      // `obligation.missed`.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance oi
        SET state_id = ${stateId}
        FROM delivery.obligation_state s
        WHERE oi.id = ${obligationId}
          AND s.id = oi.state_id AND s.tenant_id = oi.tenant_id
          AND oi.filed_on IS NULL
          AND oi.resolved_at IS NULL
          AND oi.withdrawn_at IS NULL
          AND NOT s.is_terminal
          AND NOT s.needs_decision
        RETURNING oi.id
      `;
      return rows.length > 0;
    });
  }

  async decisionQueue(tenantId: string, limit: number): Promise<readonly DecisionRow[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Ordered on the STATUTORY date and oldest first — the opposite end from
      // `calendar`, and deliberately. The calendar is about what is coming and
      // sorts on the internal target; this is about what has already gone
      // wrong, and the row that has been late longest is the one costing money.
      //
      // No date window at all. An obligation missed in April is still owed in
      // September, and a window would drop exactly those rows off the bottom.
      const rows = await db<
        {
          id: string; name: string; authority: string | null; module: string | null;
          entity_party_id: string; entity_name: string | null; client_name: string | null;
          period_label: string; statutory_due_on: string; internal_target_on: string;
          state_id: string; state_code: string; state_name: string;
          work_item_id: string | null; rule_status: string;
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
               s.id AS state_id, s.code AS state_code, s.name AS state_name,
               oi.work_item_id,
               t.status AS rule_status
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
        WHERE s.needs_decision
          AND oi.resolved_at IS NULL
          AND oi.filed_on IS NULL
          -- Unreachable by construction (an undecided filing is never
          -- withdrawn and a withdrawn one is never missed), and said anyway so
          -- a test can pin it.
          AND oi.withdrawn_at IS NULL
        ORDER BY oi.statutory_due_on, t.name
        LIMIT ${limit}
      `;
      return rows.map(
        (r): DecisionRow => ({
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
          stateId: r.state_id,
          stateCode: r.state_code,
          stateName: r.state_name,
          workItemId: r.work_item_id,
          ruleUnconfirmed: r.rule_status !== "confirmed",
        }),
      );
    });
  }

  async recordResolution(
    tenantId: string,
    obligationId: string,
    decision: { readonly optionId: string; readonly reason: string; readonly stateId: string },
  ): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // `AND resolved_at IS NULL` is what makes a double-submitted form leave
      // ONE decision. It cannot live in the caller: between its read and its
      // write the other request has already committed, and the second write
      // would silently replace a partner's recorded reason with another.
      //
      // `now()` rather than a value passed in, unlike `filed_on`. This is an
      // INSTANT — when somebody clicked — and not a claim about a statutory
      // date, so it has no calendar-day question to get wrong.
      const rows = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance
        SET resolution_option_id = ${decision.optionId},
            resolution_reason    = ${decision.reason},
            resolved_at          = now(),
            state_id             = ${decision.stateId}
        WHERE id = ${obligationId} AND resolved_at IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    });
  }

  async listUnstarted(
    tenantId: string,
    templateId: string,
  ): Promise<readonly UnstartedInstance[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // `::text` on every date, which is the pattern `day.ts` names as the
      // better answer where a query is being written anyway: Postgres renders
      // the day, no `Date` is constructed, and no zone is involved at any
      // point. Only rows nobody has started — see the port.
      const rows = await db<
        {
          id: string;
          period_start: string;
          period_end: string;
          period_label: string;
          statutory_due_on: string;
          internal_target_on: string;
        }[]
      >`
        SELECT id, period_start::text, period_end::text, period_label,
               statutory_due_on::text, internal_target_on::text
        FROM delivery.obligation_instance
        WHERE template_id = ${templateId}
          AND work_item_id IS NULL
          AND filed_on IS NULL
          AND withdrawn_at IS NULL
        ORDER BY period_start
      `;
      return rows.map((r) => ({
        id: r.id,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        periodLabel: r.period_label,
        statutoryDueOn: r.statutory_due_on,
        internalTargetOn: r.internal_target_on,
      }));
    });
  }

  async restate(tenantId: string, rows: readonly RestatedInstance[]): Promise<number> {
    if (rows.length === 0) return 0;
    return withTenant(this.app, tenantId, async (db) => {
      // ONE statement for the batch, same `jsonb_to_recordset` shape as the
      // insert above and the same DOUBLE CAST for the same reason.
      //
      // The WHERE clause repeats the unstarted test rather than trusting the
      // ids handed in. Between the read and this write somebody may have picked
      // a task up, and a rule edit must not move a date out from under them —
      // the read is a snapshot, this guard is the truth. The count returned is
      // therefore what was ACTUALLY moved, which is the number the screen
      // shows.
      const updated = await db<{ id: string }[]>`
        UPDATE delivery.obligation_instance AS o
        SET statutory_due_on   = r."statutoryDueOn"::date,
            internal_target_on = r."internalTargetOn"::date
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
          AS r(id uuid, "statutoryDueOn" text, "internalTargetOn" text)
        WHERE o.id = r.id
          AND o.work_item_id IS NULL
          AND o.filed_on IS NULL
          AND o.withdrawn_at IS NULL
        RETURNING o.id
      `;
      return updated.length;
    });
  }


  async countFor(tenantId: string, templateId: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      // EVERY row, withdrawn ones included: the period-shape lock reads this,
      // and a withdrawn row is keyed on its period start as firmly as a live
      // one. The port says why there are two counts.
      const [row] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.obligation_instance
        WHERE template_id = ${templateId}
      `;
      return Number(row?.n ?? 0);
    });
  }

  async countLiveFor(tenantId: string, templateId: string): Promise<number> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.obligation_instance
        WHERE template_id = ${templateId} AND withdrawn_at IS NULL
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
      readonly lineageId: string;
      readonly jurisdiction: string;
      readonly entityType: string | null;
    },
  ): Promise<readonly CalendarSubject[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        {
          entity_party_id: string; engagement_id: string; effective_from: string;
          service_entry_id: string; ends_on: string | null; financial_year_end: string | null;
          return_periods: { tax: string; frequency: string; firstMonth: number | null }[];
        }[]
      >`
        SELECT DISTINCT le.party_id AS entity_party_id, e.id AS engagement_id,
               e.effective_from::text AS effective_from,
               pinned.entry_id AS service_entry_id,
               e.ends_on::text AS ends_on,
               le.financial_year_end,
               -- What its authorities assigned it (0359), for an
               -- authority_assigned rule. Ordered so DISTINCT sees one value.
               (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                         'tax', rp.tax, 'frequency', rp.frequency, 'firstMonth', rp.first_month)
                         ORDER BY rp.tax), '[]'::jsonb)
                  FROM core.legal_entity_return_period rp
                 WHERE rp.tenant_id = le.tenant_id AND rp.entity_party_id = le.party_id) AS return_periods
        FROM core.legal_entity le
        JOIN crm.engagement e
          ON e.entity_party_id = le.party_id AND e.tenant_id = le.tenant_id
         -- ACTIVE, and ENDED ones up to their last day (V2.3): the generator
         -- stops each at ends_on, the floor's other end. A PAUSED one
         -- generates nothing new until it resumes.
         AND (e.status = ${GENERATING_STATUS}
              OR (e.status IN ('completed', 'cancelled') AND e.ends_on IS NOT NULL))
        -- INNER from here down (T6.16). These were LEFT joins while a rule
        -- naming NO service reached every live engagement whatever it pinned;
        -- decision 1 ended that reading, so an engagement reaches a rule only
        -- through the service it bought. The letter line and its version are
        -- NOT NULL on an engagement (0017), and the version stays readable
        -- after it is archived, so nothing a client really bought is lost.
        JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        -- THE LINK. A live one, between this rule's CHAIN and the service the
        -- engagement's letter line pinned: the entry, never the version, so a
        -- firm publishing v4 of the service has not stopped owing the filing.
        JOIN delivery.obligation_rule_service l
          ON l.tenant_id = e.tenant_id
         AND l.lineage_id = ${rule.lineageId}
         AND l.service_entry_id = pinned.entry_id
         AND l.unlinked_at IS NULL
        WHERE le.jurisdiction = ${rule.jurisdiction}
          AND (${rule.entityType}::text IS NULL OR le.entity_type = ${rule.entityType}::text)
        -- The order is a PROMISE (see the port): earliest engagement first,
        -- then id, so a client holding two services that share this filing
        -- gets its one row per period on a predictable engagement.
        ORDER BY effective_from, engagement_id
      `;
      return rows.map((r) => ({
        entityPartyId: r.entity_party_id,
        engagementId: r.engagement_id,
        effectiveFrom: r.effective_from,
        serviceEntryId: r.service_entry_id,
        endsOn: r.ends_on,
        financialYearEnd: r.financial_year_end,
        returnPeriods: r.return_periods.map((p) => ({
          tax: p.tax,
          frequency: p.frequency === "monthly" ? ("monthly" as const) : ("quarterly" as const),
          firstMonth: p.firstMonth,
        })),
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
            -- COVERED means a LIVE row this engagement's work is on (T6.16):
            -- one carrying its own id, or one for its entity on a chain its
            -- service carries. The second arm is what a client on two
            -- services that share a filing needs: ONE row per period exists,
            -- carrying the other engagement's id, and asking only for this
            -- engagement's id read this one as a gap forever. A WITHDRAWN row
            -- is not coverage: it is off the calendar.
            AND NOT EXISTS (
              SELECT 1 FROM delivery.obligation_instance oi
              WHERE oi.tenant_id = e.tenant_id
                AND oi.withdrawn_at IS NULL
                AND (
                  oi.engagement_id = e.id
                  OR (
                    oi.entity_party_id = e.entity_party_id
                    AND EXISTS (
                      SELECT 1 FROM delivery.obligation_rule_service k
                      WHERE k.tenant_id = oi.tenant_id
                        AND k.lineage_id = oi.lineage_id
                        AND k.service_entry_id = pinned.entry_id
                        AND k.unlinked_at IS NULL
                    )
                  )
                )
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
                                    AND t.recurrence <> 'event')                AS with_formula,
                 -- coverageOf() in the domain, restated: a formula the firm has
                 -- CONFIRMED. A pack row nobody has checked is not generating.
                 count(*) FILTER (WHERE t.jurisdiction = l.jurisdiction
                                    AND t.is_active
                                    AND t.due_rule IS NOT NULL
                                    AND t.recurrence <> 'event'
                                    AND t.status = 'confirmed')                 AS generating,
                 array_remove(array_agg(t.id) FILTER (
                   WHERE t.jurisdiction = l.jurisdiction
                     AND (NOT t.is_active OR t.due_rule IS NULL OR t.recurrence = 'event'
                          OR t.status <> 'confirmed')
                 ), NULL)                                                       AS blocked_rule_ids
          FROM live l
          LEFT JOIN delivery.obligation_template t
            -- THE GENERATOR'S OWN PREDICATE (T6.16): every row of a chain with
            -- a LIVE link to this engagement's service, the same join
            -- subjectsFor makes. Before the catalogue link this read a rule's
            -- one nullable service column with NULL meaning "every service",
            -- which is how a firm that loaded the shipped pack was told its
            -- rules reached a bookkeeping client they did not. No link, no
            -- match: named = 0 below is 'no_rule_names_this_service', which
            -- now means "no filing is linked to this service", and its fix is
            -- in the Catalogue.
            ON t.tenant_id = l.tenant_id
           AND EXISTS (
             SELECT 1 FROM delivery.obligation_rule_service k
             WHERE k.tenant_id = t.tenant_id
               AND k.lineage_id = t.lineage_id
               AND k.service_entry_id = l.service_entry_id
               AND k.unlinked_at IS NULL
           )
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
                 WHEN m.with_formula = 0 THEN 'rules_need_a_formula'
                 WHEN m.generating = 0   THEN 'rules_unconfirmed'
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
