// Postgres adapter for an engagement's life after signature (V2.3, 0314):
// end, pause, resume.
//
// ── WHY ENDING WRITES THE CALENDAR TOO ─────────────────────────────────────
//
// Ending an engagement withdraws its untouched upcoming filings for periods
// after its last day, and it does that in the SAME transaction as the end,
// for T6.16's reason: each half alone is a broken calendar. An engagement
// ended with its October return still live would raise a task in October for
// a client who has left; a withdrawal without the end would be undone by the
// generator the next night. The withdrawal is T6.16's own code
// (`withdrawUncovered`), not a second one: the same untouched-and-upcoming rule
// from the domain, the same cover (another ACTIVE engagement of the same
// company whose service carries the filing, started by its due date), the same
// re-pointing, a different reason on the row.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { Engagement } from "../../domain/engagement/model";
import type { EndOutcome, EngagementLifecycle } from "../../usecase/engagement/ports";
import { ENGAGEMENT_COLUMNS, toEngagement } from "./engagement-repository";
import type { EngagementRow } from "./engagement-repository";
import { lockChainForRemoval } from "./obligation-chain-lock";
import { withdrawUncovered } from "./obligation-link-repository";

export class PostgresEngagementLifecycle implements EngagementLifecycle {
  constructor(private readonly app: Db) {}

  async find(tenantId: string, engagementId: string): Promise<Engagement | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<EngagementRow[]>`
        SELECT ${db.unsafe(ENGAGEMENT_COLUMNS)} FROM crm.engagement WHERE id = ${engagementId}
      `;
      return row ? toEngagement(row) : null;
    });
  }

  async end(
    tenantId: string,
    input: {
      readonly engagementId: string;
      readonly expect: Engagement["status"];
      readonly status: "completed" | "cancelled";
      readonly endsOn: string;
      readonly reason: string;
      readonly byUserId: string | null;
      readonly firmToday: string;
    },
  ): Promise<EndOutcome | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── 0. take the chains' turns, before anything is read ─────────────
      //
      // The rows may sit on several filings' chains. Each chain's root is
      // locked the way a removal locks it (`obligation-chain-lock.ts`), in id
      // order: the generator takes its shared locks in id order too, so the
      // two always meet the rows the same way round.
      const chains = await db<{ lineage_id: string }[]>`
        SELECT DISTINCT lineage_id FROM delivery.obligation_instance
        WHERE engagement_id = ${input.engagementId}
          AND period_start > ${input.endsOn}::date
          AND withdrawn_at IS NULL
        ORDER BY lineage_id
      `;
      for (const c of chains) await lockChainForRemoval(db, c.lineage_id);

      // ── 1. the end, guarded on the status it was read in ─────────────────
      const [row] = await db<EngagementRow[]>`
        UPDATE crm.engagement SET
          status            = ${input.status},
          ends_on           = ${input.endsOn}::date,
          end_reason        = ${input.reason},
          ended_at          = now(),
          ended_by_user_id  = ${input.byUserId},
          paused_at         = NULL,
          paused_by_user_id = NULL
        WHERE id = ${input.engagementId} AND status = ${input.expect}
        RETURNING ${db.unsafe(ENGAGEMENT_COLUMNS)}
      `;
      if (!row) return null;

      // ── 2. its filings after the end, through T6.16's one withdrawal ─────
      const filings = await withdrawUncovered(
        db,
        { kind: "engagement", engagementId: input.engagementId, after: input.endsOn },
        { byUserId: input.byUserId, firmToday: input.firmToday, reason: "engagement_ended" },
      );

      // ── 3. work already on the board for after the end: said, not touched
      const jobs = await db<{ id: string; period_label: string | null }[]>`
        SELECT DISTINCT j.id, j.period_label, j.period_start
        FROM delivery.job j
        JOIN delivery.job_engagement je ON je.job_id = j.id AND je.tenant_id = j.tenant_id
        WHERE je.engagement_id = ${input.engagementId}
          AND j.status NOT IN ('done', 'cancelled')
          AND j.period_start > ${input.endsOn}::date
        ORDER BY j.period_start
      `;

      return {
        engagement: toEngagement(row),
        filings,
        openJobsAfterEnd: jobs.map((j) => ({ jobId: j.id, periodLabel: j.period_label })),
      };
    });
  }

  async pause(
    tenantId: string,
    input: { readonly engagementId: string; readonly byUserId: string | null },
  ): Promise<Engagement | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<EngagementRow[]>`
        UPDATE crm.engagement SET
          status            = 'paused',
          paused_at         = now(),
          paused_by_user_id = ${input.byUserId}
        WHERE id = ${input.engagementId} AND status = 'active'
        RETURNING ${db.unsafe(ENGAGEMENT_COLUMNS)}
      `;
      return row ? toEngagement(row) : null;
    });
  }

  async resume(
    tenantId: string,
    input: { readonly engagementId: string; readonly resumedOn: string },
  ): Promise<Engagement | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<EngagementRow[]>`
        UPDATE crm.engagement SET
          status            = 'active',
          paused_at         = NULL,
          paused_by_user_id = NULL,
          resumed_on        = ${input.resumedOn}::date
        WHERE id = ${input.engagementId} AND status = 'paused'
        RETURNING ${db.unsafe(ENGAGEMENT_COLUMNS)}
      `;
      return row ? toEngagement(row) : null;
    });
  }
}
