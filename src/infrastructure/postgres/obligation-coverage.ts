// Which engagements the compliance calendar will produce work for (T3.2), and
// which of them BOUGHT a filing (T6.13).
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
//
// ── TWO QUESTIONS, ONE PREDICATE, ONE SWITCH ───────────────────────────────
//
// `coveredEngagements` counts a rule owed by "Any service" — the shipped
// pack's default — as reaching every engagement at the entity. `filingEngagements`
// does not: it counts only a rule that NAMES the engagement's service. The
// second exists for the per-period umbrella task, and the port documents why
// the wide reading is right for a one-time task and wrong for September's
// bookkeeping. The switch is a boolean bound into the SAME statement, so the
// two can never disagree about anything except the one clause they differ on.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ObligationCoverage } from "../../usecase/workitem/ports";

export class PostgresObligationCoverage implements ObligationCoverage {
  constructor(private readonly app: Db) {}

  coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.reached(tenantId, engagementIds, false);
  }

  filingEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.reached(tenantId, engagementIds, true);
  }

  private async reached(
    tenantId: string,
    engagementIds: readonly string[],
    namedServiceOnly: boolean,
  ): Promise<ReadonlySet<string>> {
    if (engagementIds.length === 0) return new Set();
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ engagement_id: string }[]>`
        SELECT DISTINCT e.id AS engagement_id
        FROM crm.engagement e
        -- LEFT from here down, exactly as subjectsFor has it: a rule that
        -- names NO service reaches every live engagement, INCLUDING one whose
        -- catalogue version has since been unpublished. An inner join here
        -- would drop those and report them uncovered — losing an obligation
        -- because we could not resolve what the client bought is the worst
        -- failure available in this module.
        LEFT JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        JOIN core.legal_entity le
          ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
        JOIN delivery.obligation_template t
          ON t.tenant_id = e.tenant_id
         -- A NULL service_entry_id MEANS "every service" — the screen writes
         -- it as *"Owed by clients who bought: Any service"* and it is the
         -- DEFAULT, so this is the ordinary case rather than an edge one.
         --
         -- This file's own header promised to be the generator's predicate and
         -- not an approximation of it, and then drifted from it anyway: a bare
         -- equality is never true against NULL, so every rule in the shipped
         -- India pack — all 57, none of which names a service, because a pack
         -- cannot know a firm's catalogue keys — reported every engagement
         -- UNCOVERED while the calendar generated for it. spawnForEngagements
         -- then raised its own engagement task ON TOP of the per-period ones:
         -- **two tasks for one filing**, which is the exact failure the header
         -- names. subjectsFor and gaps both read it correctly and only this
         -- one did not, which is why the integration test below now runs all
         -- three against one database rather than trusting three comments.
         --
         -- The NULL branch is switched OFF for the filing question (T6.13):
         -- "did the client buy a filing" is only answered by a rule that names
         -- the service. Bound as a parameter so both questions are this one
         -- statement.
         AND (
           t.service_entry_id = pinned.entry_id
           OR (${namedServiceOnly}::boolean IS FALSE AND t.service_entry_id IS NULL)
         )
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
