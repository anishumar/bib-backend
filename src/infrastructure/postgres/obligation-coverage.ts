// Which engagements the compliance calendar will produce work for (T3.2), and
// which of them BOUGHT a filing (T6.13).
//
// One query, and it is deliberately the GENERATOR'S OWN PREDICATE rather than a
// convenient approximation of it: an ACTIVE rule, carrying a due formula, that
// is not event-driven, confirmed by the firm, whose CHAIN has a live catalogue
// LINK to this engagement's service (T6.16, 0309), for the entity's own
// country. If the two ever drift, a recurring client gets either two tasks for
// one filing or none at all — so the predicate is written once here and the
// port that reads it says so.
//
// It answers at SPAWN time, when no obligation instance exists yet: the sweep
// generates later that night. That is why it asks about RULES and not about
// rows, and it is also why the answer is safe — a firm with no rules is not
// covered, so it gets exactly the behaviour it had before this existed.
//
// ── TWO QUESTIONS, AND SINCE T6.16 ONE ANSWER ──────────────────────────────
//
// T6.13 split `coveredEngagements` from `filingEngagements` because a rule
// owed by "Any service" (a NULL service, the shipped pack's every row) reached
// every engagement at the entity while naming none of them: bookkeeping was
// COVERED by the entity's GST rule, and was not a filing. That is the one case
// the two differed on, and decision 1 removed it: a rule linked to no service
// generates nothing, and a rule reaches an engagement only through a link to
// the service that engagement bought. So "will the calendar produce rows for
// this engagement" and "did this engagement buy a filing" are now the same
// question, and both methods run this one statement with no switch.
//
// The PORT keeps both methods, and that is deliberate. The use case asks two
// different questions for two different tasks, and if the firm decides that a
// per-period task should survive a link (a bookkeeping service that also
// carries TDS still owes its own monthly checklist), `filingEngagements` is the
// one place that rule would go.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ObligationCoverage } from "../../usecase/workitem/ports";

export class PostgresObligationCoverage implements ObligationCoverage {
  constructor(private readonly app: Db) {}

  coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.reached(tenantId, engagementIds);
  }

  filingEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.reached(tenantId, engagementIds);
  }

  private async reached(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (engagementIds.length === 0) return new Set();
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ engagement_id: string }[]>`
        SELECT DISTINCT e.id AS engagement_id
        FROM crm.engagement e
        -- INNER, as subjectsFor has it since T6.16. These were LEFT joins so a
        -- rule naming NO service could still reach an engagement whose version
        -- could not be resolved; that reading is gone, and an engagement is
        -- reached only through the service its letter line pinned.
        JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        JOIN core.legal_entity le
          ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
        JOIN delivery.obligation_template t
          ON t.tenant_id = e.tenant_id
         -- THE LINK: a live one between the rule's CHAIN and this engagement's
         -- service. The bug this file's header warns about happened here once
         -- already, as one operator (a bare = against a NULL that meant
         -- "every service"), which is why coverage.integration.test.ts runs
         -- this, subjectsFor and gaps against one database.
         AND EXISTS (
           SELECT 1 FROM delivery.obligation_rule_service l
           WHERE l.tenant_id = t.tenant_id
             AND l.lineage_id = t.lineage_id
             AND l.service_entry_id = pinned.entry_id
             AND l.unlinked_at IS NULL
         )
         AND t.jurisdiction = le.jurisdiction
         AND (t.entity_type IS NULL OR t.entity_type = le.entity_type)
         AND t.is_active
         AND t.due_rule IS NOT NULL
         AND t.recurrence <> 'event'
         -- Confirmed by the firm — coverageOf() again. An unconfirmed rule
         -- covers nothing, so an engagement it would reach still gets its own
         -- task from the spawn rather than a filing the calendar never dated.
         AND t.status = 'confirmed'
        WHERE e.id = ANY(${db.array(engagementIds as string[])}::uuid[])
      `;
      return new Set(rows.map((r) => r.engagement_id));
    });
  }
}
