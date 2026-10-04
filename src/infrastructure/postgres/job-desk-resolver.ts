// Postgres adapter for the orchestrator's `StepDeskResolver` port: the facts
// the owner rule needs to decide whose desk a job's steps default to (0301,
// then 2026-09-27). The RULE is `resolveOwner` in the domain, which the job's
// task is routed by too; this reads the job's Dept, its client's SPOCs for it,
// the Key Manager and the person who signs for the firm (`work-owner.ts`).
//
// ── THE JOB'S DEPT, AND THE BUG THAT REWROTE THIS FILE ─────────────────────
//
// Until 2026-09-27 this read the SPOC through the job's SPLIT CODE only. A
// firm that keeps a client's work together (`work_split_axis = 'none'`, the
// default) has no split code, the join matched nothing, and every job's steps
// started on nobody's desk while the job's task, routed by the SERVICE's Dept,
// went straight to the SPOC. Measured on a local database: 30 of 30 steps
// assigned on jobs split by Dept, 0 of 619 on jobs kept together. Nothing
// tested this file.
//
// So the Dept is now, in order:
//   - the split code, when the firm splits by Dept (or by team: a SPOC can
//     cover a delivery team, and the split code then names one);
//   - otherwise the Dept of the job's services, read LIVE the way the task's
//     is (`engagement-work-source.ts`): one Dept is that Dept, several is a job
//     no single SPOC can take, none is a service filed under no Dept.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { NoSpocLookup, OwnerPerson, SpocCandidate } from "../../domain/workitem/model";
import type { StepDeskResolver, StepOwnerFacts } from "../../usecase/orchestrator/ports";
import { keyManagerOn, signingPartnerOf, spocCandidates } from "./work-owner";

interface JobServiceRow {
  split_axis: string;
  split_code: string | null;
  client_party_id: string;
  dept_code: string | null;
}

export class PostgresJobDeskResolver implements StepDeskResolver {
  constructor(private readonly app: Db) {}

  async ownerFactsFor(tenantId: string, jobId: string, onDate: string): Promise<StepOwnerFacts> {
    return withTenant(this.app, tenantId, async (db) => {
      const taskHolder = await taskHolderOf(db, jobId);
      // One row per engagement in the job. The CLIENT is the letter's party,
      // who the SPOCs and the Key Manager are recorded against; every
      // engagement in one job comes from one letter, so it is one client.
      const rows = await db<JobServiceRow[]>`
        SELECT j.split_axis, j.split_code, l.party_id AS client_party_id,
               live.body ->> 'module' AS dept_code
        FROM delivery.job j
        JOIN delivery.job_engagement je
          ON je.job_id = j.id AND je.tenant_id = j.tenant_id
        JOIN crm.engagement e
          ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
        JOIN crm.engagement_letter l
          ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        WHERE j.id = ${jobId}
      `;
      const first = rows[0];
      if (!first) {
        // A job with no engagement names no client, so no SPOC and no Key
        // Manager; the firm's signatory is still somebody to hand it to.
        return {
          deptName: null,
          noLookup: { kind: "no_dept" },
          spocs: [],
          keyManager: null,
          partner: await signingPartnerOf(db, tenantId),
          taskHolder,
        };
      }
      const clientPartyId = first.client_party_id;

      let axis: { id: string; name: string } | null = null;
      let noLookup: NoSpocLookup | null = null;
      if ((first.split_axis === "dept" || first.split_axis === "team") && first.split_code !== null) {
        axis = await axisByCode(db, first.split_axis, first.split_code);
        if (!axis) noLookup = { kind: "unknown_dept", code: first.split_code };
      } else {
        const codes = [...new Set(rows.map((r) => r.dept_code).filter((c): c is string => c !== null))];
        const only = codes[0];
        if (only === undefined) {
          noLookup = { kind: "no_dept" };
        } else if (codes.length === 1) {
          axis = await axisByCode(db, "dept", only);
          if (!axis) noLookup = { kind: "unknown_dept", code: only };
        } else {
          const named = await db<{ code: string; name: string }[]>`
            SELECT code, name FROM tenancy.service_axis
            WHERE axis = 'dept' AND code = ANY(${db.array(codes)}::text[])
            ORDER BY sort_order, code
          `;
          // In the firm's own order of its Depts, then any code it does not
          // have, so the sentence reads the same whichever line came first.
          const known = new Set(named.map((n) => n.code));
          noLookup = {
            kind: "several_depts",
            names: [...named.map((n) => n.name), ...codes.filter((c) => !known.has(c)).sort()],
          };
        }
      }

      const spocs: readonly SpocCandidate[] =
        axis === null ? [] : await spocCandidates(db, clientPartyId, axis.id, onDate);
      // The later rungs only when the first is empty, as the task router does.
      const needFallback = noLookup !== null || spocs.length === 0;
      const keyManager = needFallback ? await keyManagerOn(db, clientPartyId, onDate) : null;
      const partner = needFallback && keyManager === null ? await signingPartnerOf(db, tenantId, clientPartyId) : null;
      return { deptName: axis?.name ?? null, noLookup, spocs, keyManager, partner, taskHolder };
    });
  }
}

/** A Dept or team by its code, retired or not, the way the task router's
 *  `findByCode` reads it, so the two cannot disagree about a retired Dept. */
async function axisByCode(
  db: Db,
  axis: string,
  code: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db<{ id: string; name: string }[]>`
    SELECT id, name FROM tenancy.service_axis WHERE axis = ${axis} AND code = ${code}
  `;
  return rows[0] ?? null;
}

/**
 * Who holds the job's TASK now: the one active member of staff every open
 * (not terminal) task of the job is on. Null when the job has no open task,
 * when one is on nobody's desk, when two are on different desks, or when the
 * one holder has left the firm. `StepOwnerFacts` says why this comes first.
 */
async function taskHolderOf(db: Db, jobId: string): Promise<OwnerPerson | null> {
  const rows = await db<{ assignee_user_id: string | null; active_user: string | null; display_name: string | null }[]>`
    SELECT w.assignee_user_id, m.user_id AS active_user, u.display_name
    FROM delivery.work_item w
    JOIN delivery.work_item_state s
      ON s.id = w.state_id AND s.tenant_id = w.tenant_id
    LEFT JOIN tenancy.membership m
      ON m.tenant_id = w.tenant_id AND m.user_id = w.assignee_user_id
     AND m.audience = 'STAFF' AND m.is_active
    LEFT JOIN tenancy.user_account u ON u.id = w.assignee_user_id
    WHERE w.job_id = ${jobId} AND NOT s.is_terminal
  `;
  const first = rows[0];
  if (!first || first.assignee_user_id === null || first.active_user === null) return null;
  const one = rows.every((r) => r.assignee_user_id === first.assignee_user_id);
  return one ? { userId: first.assignee_user_id, displayName: first.display_name } : null;
}
