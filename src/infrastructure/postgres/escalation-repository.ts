// The escalation ladder, in Postgres (T4.5).
//
// Four things live here and nowhere else:
//
//   THE IDEMPOTENT RAISE. `ON CONFLICT DO NOTHING` on the notice table's two
//   partial unique indexes, returning null when the rung was already climbed on
//   that subject. That null is what stops the service writing a second
//   `work_item.escalated` event — so a redelivered queue message, a re-run
//   sweep and a restarted worker all leave one row and one event. Telling a
//   partner the same thing every morning is how a queue stops being read.
//
//   THE TWO FEEDS, filtered by FLAGS and never by a state code. A firm renames
//   its vocabulary and any rule comparing `code = 'completed'` switches off in
//   silence — 0050's argument, and T3.3 proved the alternative works by
//   renaming a state and watching the sweep keep going.
//
//   WHAT IS STILL LIVE, as a JOIN. Migration 0058 says why there is no
//   `cleared_at` column: an escalation about a task is over exactly when that
//   task reaches a terminal state, and a column restating that would be free to
//   disagree with it.
//
//   EVERY DATE AS `::text`. A `date` column comes back from postgres.js as a
//   UTC instant, and this module is entirely about being a day early rather
//   than a day late. No `Date` is constructed anywhere below.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { EscalationBody } from "../../domain/config/model";
import { ESCALATION_KEY, readEscalationBody } from "../../domain/config/model";
import type {
  ClimbedRung,
  EscalatableObligation,
  EscalatableWorkItem,
  EscalationLadderSource,
  EscalationNoticeRepository,
  EscalationNoticeRow,
  EscalationRecord,
  EscalationSubjectSource,
  EscalationViewer,
  NewEscalationNotice,
} from "../../usecase/escalation/ports";
import { MAX_LIST_ROWS } from "../../db/limits";

/**
 * The firm's published ladder.
 *
 * LIVE, never pinned — a firm that shortens its ladder this afternoon expects
 * tonight's sweep to use the new one, and nothing is retrospective because a
 * notice already raised snapshotted the `after_days` it fired with. The same
 * shape `PostgresDunningLadder` has, for the same reasons.
 */
export class PostgresEscalationLadder implements EscalationLadderSource {
  constructor(private readonly app: Db) {}

  async ladderFor(tenantId: string): Promise<EscalationBody | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ body: Record<string, unknown> }[]>`
        SELECT v.body
        FROM config.entry e
        JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
        WHERE e.kind = 'escalation' AND e.key = ${ESCALATION_KEY}
      `;
      return row ? readEscalationBody(row.body) : null;
    });
  }
}

interface OpenWorkItemRow {
  id: string;
  assignee_user_id: string | null;
  due_on: string | null;
  created_on: string;
}

interface OpenObligationRow {
  id: string;
  internal_target_on: string;
  statutory_due_on: string;
  work_item_id: string | null;
  assignee_user_id: string | null;
}

export class PostgresEscalationSubjects implements EscalationSubjectSource {
  constructor(private readonly app: Db) {}

  async openWorkItems(tenantId: string): Promise<readonly EscalatableWorkItem[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<OpenWorkItemRow[]>`
        SELECT wi.id,
               wi.assignee_user_id,
               wi.due_on::text                AS due_on,
               (wi.created_at AT TIME ZONE 'UTC')::date::text AS created_on
        FROM delivery.work_item wi
        JOIN delivery.work_item_state s
          ON s.id = wi.state_id AND s.tenant_id = wi.tenant_id
        -- The FLAG, never the code. is_terminal is what 0050 put there so a
        -- firm can rename "Completed" without switching this sweep off.
        WHERE s.is_terminal = false
      `;
      return rows.map((r) => ({
        workItemId: r.id,
        assigneeUserId: r.assignee_user_id,
        dueOn: r.due_on,
        createdOn: r.created_on,
      }));
    });
  }

  async openObligations(tenantId: string): Promise<readonly EscalatableObligation[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<OpenObligationRow[]>`
        SELECT oi.id,
               oi.internal_target_on::text AS internal_target_on,
               oi.statutory_due_on::text   AS statutory_due_on,
               oi.work_item_id,
               wi.assignee_user_id
        FROM delivery.obligation_instance oi
        JOIN delivery.obligation_state os
          ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
        LEFT JOIN delivery.work_item wi
          ON wi.id = oi.work_item_id AND wi.tenant_id = oi.tenant_id
        -- Filed, decided about, or already ended: three different ways a filing
        -- stops being anybody's problem, and each is read from the fact rather
        -- than from a name. resolved_at is T3.3's — an obligation a partner
        -- has already answered for must not be escalated as though nobody had.
        WHERE oi.filed_on IS NULL
          AND oi.resolved_at IS NULL
          AND os.is_terminal = false
          -- WITHDRAWN (0309): the firm stopped doing this filing, so nobody is
          -- late on it. The window this watch fires in (past the internal
          -- target, before the statutory date) is exactly where an untouched
          -- upcoming row sits when its service stops including it.
          AND oi.withdrawn_at IS NULL
      `;
      return rows.map((r) => ({
        obligationId: r.id,
        internalTargetOn: r.internal_target_on,
        statutoryDueOn: r.statutory_due_on,
        workItemId: r.work_item_id,
        assigneeUserId: r.assignee_user_id,
      }));
    });
  }
}

interface NoticeRow {
  id: string;
  work_item_id: string | null;
  obligation_instance_id: string | null;
  rung_key: string;
  watch: string;
  after_days: number;
  target: string;
  raised_to_user_id: string | null;
  min_grade_rank: number | null;
  note: string | null;
  raised_on: string;
  days_past: number;
}

interface RecordRow extends NoticeRow {
  subject_title: string;
  client_name: string | null;
  client_party_id: string | null;
  entity_name: string | null;
  raised_to_name: string | null;
  raised_to_email: string | null;
  holder_user_id: string | null;
  holder_name: string | null;
  holder_email: string | null;
  subject_due_on: string | null;
  state_name: string | null;
}

const NOTICE_COLUMNS =
  "id, work_item_id, obligation_instance_id, rung_key, watch, after_days, target, " +
  "raised_to_user_id, min_grade_rank, note, raised_on::text AS raised_on, days_past";

function toRow(r: NoticeRow): EscalationNoticeRow {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    obligationInstanceId: r.obligation_instance_id,
    rungKey: r.rung_key,
    watch: r.watch,
    afterDays: r.after_days,
    target: r.target,
    raisedToUserId: r.raised_to_user_id,
    minGradeRank: r.min_grade_rank,
    note: r.note,
    raisedOn: r.raised_on,
    daysPast: r.days_past,
  };
}

export class PostgresEscalationNoticeRepository implements EscalationNoticeRepository {
  constructor(private readonly app: Db) {}

  async climbed(tenantId: string): Promise<readonly ClimbedRung[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        { work_item_id: string | null; obligation_instance_id: string | null; rung_key: string }[]
      >`
        SELECT work_item_id, obligation_instance_id, rung_key
        FROM delivery.escalation_notice
      `;
      return rows.map((r) => ({
        workItemId: r.work_item_id,
        obligationInstanceId: r.obligation_instance_id,
        rungKey: r.rung_key,
      }));
    });
  }

  async raise(n: NewEscalationNotice): Promise<EscalationNoticeRow | null> {
    return withTenant(this.app, n.tenantId, async (db) => {
      // ON CONFLICT DO NOTHING against BOTH partial unique indexes. No
      // `ON CONSTRAINT` target is named because there are two of them and only
      // one applies per row — the bare form covers whichever the row lands on,
      // which is exactly the behaviour wanted here.
      const [row] = await db<NoticeRow[]>`
        INSERT INTO delivery.escalation_notice
          (id, tenant_id, work_item_id, obligation_instance_id, rung_key, watch, after_days,
           target, raised_to_user_id, min_grade_rank, note, raised_on, days_past)
        VALUES (${n.id}, ${n.tenantId}, ${n.workItemId}, ${n.obligationInstanceId}, ${n.rungKey},
                ${n.watch}, ${n.afterDays}, ${n.target}, ${n.raisedToUserId}, ${n.minGradeRank},
                ${n.note}, ${n.raisedOn}::date, ${n.daysPast})
        ON CONFLICT DO NOTHING
        RETURNING ${db.unsafe(NOTICE_COLUMNS)}
      `;
      return row ? toRow(row) : null;
    });
  }

  async listFor(
    tenantId: string,
    viewer: EscalationViewer | null,
  ): Promise<readonly EscalationRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The reader's own rung, as a value the SQL can compare. Null is not "no
      // rank matches" — it is "this reader holds none", so no rank-addressed
      // notice can be theirs, which the comparison below expresses by leaving
      // the whole branch false.
      const viewerId = viewer?.userId ?? null;
      const viewerRank = viewer?.gradeRank ?? null;

      const rows = await db<RecordRow[]>`
        SELECT n.id, n.work_item_id, n.obligation_instance_id, n.rung_key, n.watch,
               n.after_days, n.target, n.raised_to_user_id, n.min_grade_rank, n.note,
               n.raised_on::text AS raised_on, n.days_past,
               -- The title a person reads. A task's own, or the filing's rule
               -- name with its period — "GSTR-3B · Aug 2026" — because an
               -- obligation has no title of its own and a uuid is not a row
               -- anybody can act on.
               COALESCE(wi.title, ot.name || ' · ' || oi.period_label, 'Untitled') AS subject_title,
               -- WHO PAYS and WHICH COMPANY, kept apart. A filing has no
               -- client at all, so client_name is null there and the entity
               -- carries the row; a task has both, and G0.1 is why the second
               -- one matters.
               cp.display_name                                                     AS client_name,
               cp.id                                                               AS client_party_id,
               COALESCE(wep.display_name, ep.display_name)                         AS entity_name,
               -- THE EMAIL COMES TOO, and it is not belt-and-braces. A display
               -- name is optional on tenancy.user_account and is genuinely
               -- empty at real firms: running this sweep produced fourteen
               -- notices, three of them addressed to a partner by name, and the
               -- queue rendered a blank space beside "told". The audit trail
               -- learnt the same thing and states the rule -- the email is the
               -- discriminator, not the id.
               ru.display_name                                                     AS raised_to_name,
               ru.email                                                            AS raised_to_email,
               wi.assignee_user_id                                                 AS holder_user_id,
               hu.display_name                                                     AS holder_name,
               hu.email                                                            AS holder_email,
               COALESCE(wi.due_on, oi.internal_target_on)::text                    AS subject_due_on,
               COALESCE(ws.name, os.name)                                          AS state_name
        FROM delivery.escalation_notice n
        LEFT JOIN delivery.work_item wi
          ON wi.id = n.work_item_id AND wi.tenant_id = n.tenant_id
        LEFT JOIN delivery.work_item_state ws
          ON ws.id = wi.state_id AND ws.tenant_id = wi.tenant_id
        LEFT JOIN core.party cp
          ON cp.id = wi.client_party_id AND cp.tenant_id = wi.tenant_id
        LEFT JOIN core.party wep
          ON wep.id = wi.entity_party_id AND wep.tenant_id = wi.tenant_id
        LEFT JOIN delivery.obligation_instance oi
          ON oi.id = n.obligation_instance_id AND oi.tenant_id = n.tenant_id
        LEFT JOIN delivery.obligation_state os
          ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
        LEFT JOIN delivery.obligation_template ot
          ON ot.id = oi.template_id AND ot.tenant_id = oi.tenant_id
        LEFT JOIN core.party ep
          ON ep.id = oi.entity_party_id AND ep.tenant_id = oi.tenant_id
        -- Who was told, and who holds the work now. Two joins to the same
        -- table because they are two different questions, and the gap between
        -- them is how a reader sees the escalation actually worked.
        LEFT JOIN tenancy.user_account ru ON ru.id = n.raised_to_user_id
        LEFT JOIN tenancy.user_account hu ON hu.id = wi.assignee_user_id
        WHERE
          -- STILL LIVE. Migration 0058's join, written once: a task escalation
          -- ends when the task leaves the board, an unassigned one ends the
          -- moment somebody picks it up, and a filing's ends when it is filed,
          -- decided or closed.
          (
            n.work_item_id IS NOT NULL
            AND ws.is_terminal = false
            AND (n.watch <> 'work_item_unassigned' OR wi.assignee_user_id IS NULL)
          )
          OR (
            n.obligation_instance_id IS NOT NULL
            AND oi.filed_on IS NULL
            AND oi.resolved_at IS NULL
            AND os.is_terminal = false
            -- A notice about a filing since WITHDRAWN (0309) is no longer
            -- live: the work it was about stopped. Restoring the filing
            -- brings the notice back, the way reopening a task does, and the
            -- once-per-rung index (0058) stops a restored filing re-firing a
            -- rung it already climbed.
            AND oi.withdrawn_at IS NULL
          )
        -- A CEILING, not pagination — see MAX_LIST_ROWS. Notices accumulate for
        -- as long as the ladder keeps firing, and this list is filtered and
        -- ordered in TypeScript, so the cap has to be on what SQL hands over.
        LIMIT ${MAX_LIST_ROWS}
      `;

      const mine = (r: RecordRow): boolean => {
        if (viewer === null) return true;
        if (r.raised_to_user_id !== null) return r.raised_to_user_id === viewerId;
        if (r.min_grade_rank !== null) return viewerRank !== null && viewerRank >= r.min_grade_rank;
        // Addressed to nobody. It belongs in the whole firm's queue and in
        // nobody's personal one — which is the honest answer rather than
        // hiding it or pinning it on whoever happened to look.
        return false;
      };

      // Ordered here rather than in SQL: `days_past` is the number a reader
      // works down, and the tie-break is the older notice first. One `ORDER BY`
      // would do it, and this keeps the filter and the order in one place where
      // the Mine branch cannot silently reorder the list.
      return rows
        .filter(mine)
        .sort((a, b) => b.days_past - a.days_past || a.raised_on.localeCompare(b.raised_on))
        .map((r) => ({
          ...toRow(r),
          subjectTitle: r.subject_title,
          clientName: r.client_name,
          clientPartyId: r.client_party_id,
          entityName: r.entity_name,
          raisedTo:
            r.raised_to_user_id !== null && r.raised_to_email !== null
              ? {
                  userId: r.raised_to_user_id,
                  displayName: r.raised_to_name,
                  email: r.raised_to_email,
                }
              : null,
          holder:
            r.holder_user_id !== null && r.holder_email !== null
              ? {
                  userId: r.holder_user_id,
                  displayName: r.holder_name,
                  email: r.holder_email,
                }
              : null,
          dueOn: r.subject_due_on,
          stateName: r.state_name,
        }));
    });
  }
}
