// The owner rule's facts, read (2026-09-27). `resolveOwner` in
// `domain/workitem` decides who owns a piece of work: the client's SPOC for
// its Dept, then the client's Key Manager, then the person who signs for the
// firm. This file is the ONE place those three are read, so the task router
// (`PostgresClientAssignmentRepository.spocsFor`, `PostgresWorkOwnerDirectory`)
// and the job's step desk (`PostgresJobDeskResolver`) cannot read them two
// different ways.
//
// ACTIVE STAFF ONLY, on all three. An assignment row outlives the membership
// it names: a SPOC who left the firm last month is still the SPOC on paper
// until somebody ends the row, and routing work to them puts it on a desk
// nobody sits at. Filtered here, so the next rung is the honest answer.
//
// Every helper takes the transaction a caller opened with `withTenant`, so
// the reads share the caller's snapshot and the tenant wall.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { OwnerPerson, SpocCandidate } from "../../domain/workitem/model";
import type { WorkOwnerDirectory } from "../../usecase/workitem/ports";

/**
 * The SPOCs for one Dept or team on one client, in force on the day.
 *
 * `routed` is the turn-taking counter (2026-09-25): how many of this client's
 * tasks already sit, or sat, on each candidate's desk, counted over ALL of the
 * client's work items so the rotation is even over time. Ordered
 * longest-standing assignment first, which is the tie-break
 * `resolveAssignee` relies on.
 */
export async function spocCandidates(
  db: Db,
  clientPartyId: string,
  axisId: string,
  onDate: string,
): Promise<readonly SpocCandidate[]> {
  const rows = await db<
    { user_id: string; display_name: string | null; email: string; routed: number }[]
  >`
    SELECT a.user_id, u.display_name, u.email::text AS email,
           (SELECT count(*)::int FROM delivery.work_item w
             WHERE w.tenant_id = a.tenant_id
               AND w.client_party_id = a.client_party_id
               AND w.assignee_user_id = a.user_id) AS routed
    FROM crm.client_assignment a
    JOIN tenancy.user_account u ON u.id = a.user_id
    JOIN tenancy.membership m
      ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
     AND m.audience = 'STAFF' AND m.is_active
    WHERE a.client_party_id = ${clientPartyId}
      AND a.role = 'spoc'
      AND a.axis_id = ${axisId}
      AND a.valid_from <= ${onDate}::date
      AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
    ORDER BY a.valid_from, u.display_name, u.email
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    routed: r.routed,
  }));
}

/**
 * The client's Key Manager in force on the day. One at a time by an
 * exclusion constraint (0049), so `LIMIT 1` reads a guarantee rather than
 * picking from a set. In force means STARTED as well as not ended: a Key
 * Manager named from next Monday is not this morning's owner.
 */
export async function keyManagerOn(
  db: Db,
  clientPartyId: string,
  onDate: string,
): Promise<OwnerPerson | null> {
  const rows = await db<{ user_id: string; display_name: string | null }[]>`
    SELECT a.user_id, u.display_name
    FROM crm.client_assignment a
    JOIN tenancy.user_account u ON u.id = a.user_id
    JOIN tenancy.membership m
      ON m.tenant_id = a.tenant_id AND m.user_id = a.user_id
     AND m.audience = 'STAFF' AND m.is_active
    WHERE a.client_party_id = ${clientPartyId}
      AND a.role = 'key_manager'
      AND a.valid_from <= ${onDate}::date
      AND (a.valid_to IS NULL OR a.valid_to > ${onDate}::date)
    ORDER BY a.valid_from DESC
    LIMIT 1
  `;
  const r = rows[0];
  return r ? { userId: r.user_id, displayName: r.display_name } : null;
}

/**
 * The person who signs for the firm (`tenancy.tenant.firm_signatory_user_id`,
 * set on `/admin/firm`). One per firm and no day: it is a column, not an
 * effective-dated row.
 */
export async function signingPartnerOf(db: Db, tenantId: string): Promise<OwnerPerson | null> {
  const rows = await db<{ user_id: string; display_name: string | null }[]>`
    SELECT t.firm_signatory_user_id AS user_id, u.display_name
    FROM tenancy.tenant t
    JOIN tenancy.user_account u ON u.id = t.firm_signatory_user_id
    JOIN tenancy.membership m
      ON m.tenant_id = t.id AND m.user_id = t.firm_signatory_user_id
     AND m.audience = 'STAFF' AND m.is_active
    WHERE t.id = ${tenantId}
  `;
  const r = rows[0];
  return r ? { userId: r.user_id, displayName: r.display_name } : null;
}

/** The work item use case's `WorkOwnerDirectory`: the owner rule's later rungs. */
export class PostgresWorkOwnerDirectory implements WorkOwnerDirectory {
  constructor(private readonly app: Db) {}

  keyManagerFor(tenantId: string, clientPartyId: string, onDate: string): Promise<OwnerPerson | null> {
    return withTenant(this.app, tenantId, (db) => keyManagerOn(db, clientPartyId, onDate));
  }

  signingPartner(tenantId: string): Promise<OwnerPerson | null> {
    return withTenant(this.app, tenantId, (db) => signingPartnerOf(db, tenantId));
  }
}
