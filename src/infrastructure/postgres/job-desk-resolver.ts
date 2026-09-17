// Postgres adapter for the orchestrator's `StepDeskResolver` port: whose desk
// a job's steps default to — the SPOC for the job's Dept on the job's client,
// in force on the day asked.
//
// The same answer the month's umbrella task gets (`routeToSpoc` in the work
// item use case), read here directly from the rows rather than through that
// service, because the two use cases must not import each other and because
// this question is narrower: ONE user id or nothing. "Two SPOCs on a Dept" is
// a real state (leave cover, a handover fortnight) and the answer to "whose
// desk by default" is then NOBODY'S — a person has to choose, which the job
// page lets them do — rather than the first row the planner returned.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { StepDeskResolver } from "../../usecase/orchestrator/ports";

export class PostgresJobDeskResolver implements StepDeskResolver {
  constructor(private readonly app: Db) {}

  async spocFor(tenantId: string, jobId: string, onDate: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // Half-open on the assignment's window, like every effective-dated row
      // in `crm`: `valid_to` is the first day NOT in force.
      const rows = await db<{ user_id: string }[]>`
        SELECT DISTINCT ca.user_id
        FROM delivery.job j
        JOIN delivery.job_engagement je
          ON je.job_id = j.id AND je.tenant_id = j.tenant_id
        JOIN crm.engagement e
          ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
        JOIN tenancy.service_axis ax
          ON ax.tenant_id = j.tenant_id
         AND ax.axis = j.split_axis
         AND ax.code = j.split_code
        JOIN crm.client_assignment ca
          ON ca.tenant_id = j.tenant_id
         AND ca.client_party_id = e.party_id
         AND ca.role = 'spoc'
         AND ca.axis_id = ax.id
         AND ca.valid_from <= ${onDate}::date
         AND (ca.valid_to IS NULL OR ca.valid_to > ${onDate}::date)
        WHERE j.id = ${jobId}
      `;
      return rows.length === 1 ? (rows[0]?.user_id ?? null) : null;
    });
  }
}
