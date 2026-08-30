// Which engagements the compliance calendar will produce work for (T3.2).
//
// One query, and it is deliberately the GENERATOR'S OWN PREDICATE rather than a
// convenient approximation of it: an ACTIVE rule, carrying a due formula, that
// is not event-driven, naming this engagement's catalogue service and the
// entity's own country. If the two ever drift, a recurring client gets either
// two tasks for one filing or none at all — so the predicate is written once
// here and the port that reads it says so.
//
// It answers at SPAWN time, when no obligation instance exists yet: the sweep
// generates later that night. That is why it asks about RULES and not about
// rows, and it is also why the answer is safe — a firm with no rules is not
// covered, so it gets exactly the behaviour it had before this existed.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ObligationCoverage } from "../../usecase/workitem/ports";

export class PostgresObligationCoverage implements ObligationCoverage {
  constructor(private readonly app: Db) {}

  async coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (engagementIds.length === 0) return new Set();
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ engagement_id: string }[]>`
        SELECT DISTINCT e.id AS engagement_id
        FROM crm.engagement e
        JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        JOIN core.legal_entity le
          ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
        JOIN delivery.obligation_template t
          ON t.tenant_id = e.tenant_id
         AND t.service_entry_id = pinned.entry_id
         AND t.jurisdiction = le.jurisdiction
         AND (t.entity_type IS NULL OR t.entity_type = le.entity_type)
         AND t.is_active
         AND t.due_rule IS NOT NULL
         AND t.recurrence <> 'event'
        WHERE e.id = ANY(${db.array(engagementIds as string[])}::uuid[])
      `;
      return new Set(rows.map((r) => r.engagement_id));
    });
  }
}
