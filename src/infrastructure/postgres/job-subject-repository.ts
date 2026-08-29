// What a job is FOR — the read that gives the orchestrator its template key and
// the facts a step's condition is judged against (T2.7).
//
// ── WHY THIS IS ITS OWN ADAPTER ─────────────────────────────────────────────
//
// It spans four schemas: `delivery.job` names its cause, `crm.engagement` and
// `crm.engagement_letter_line` say which service and which entity, `config` holds
// the service body the process key and the recurrence live in, and `core` holds
// the entity's jurisdiction. No existing repository owns that join, and putting
// it inside one of them would make that repository know about the engine.
//
// ── AND WHY IT IS ONE QUERY ─────────────────────────────────────────────────
//
// A job resolves all of this at once, when it starts. Four round trips would be
// four chances to read a different state than the first — and the answer decides
// which process a job is PINNED to, which is the one decision about a job that
// can never be taken again.
//
// ── THE SERVICE IS READ LIVE, NOT AT THE VERSION THE CLIENT SIGNED ──────────
//
// The letter line pins a `service_version_id` and everything commercial resolves
// through it: the price, the scope, the exclusions. This deliberately does NOT.
// It walks through the pinned version to the ENTRY and back out to whatever is
// published now, and the reason is that a workflow key is not a term of the
// contract.
//
//   A client agreed to the service, its price and its scope. They did not agree
//   to our internal steps, and they would not recognise them.
//
//   Pinning already happens, one level down and where it belongs: the JOB pins
//   the workflow VERSION when it starts, so a process edited mid-flight still
//   does not move a job already walking it. Pinning the service version as well
//   would pin the same thing twice, at the wrong altitude.
//
//   And the cost of getting it wrong is not theoretical — it was found by
//   running this. Every engagement signed before a firm writes its first process
//   pins a service version that names no template, so those jobs could NEVER
//   pick one up. A firm that adopts this product with work already in flight
//   would watch its existing engagements wait forever while only new ones moved.
//
// `recurrence` comes off the same live row for the same reason: it is the firm's
// description of the service, and what a particular client is BILLED is
// `billing_frequency` on the letter line, which is the letter's own field.

import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { readServiceBody } from "../../domain/config/model";
import type { JobSubject, JobSubjectSource } from "../../usecase/orchestrator/ports";

interface SubjectRow {
  body: Record<string, unknown> | null;
  jurisdiction: string | null;
}

/** Everything in a group agrees on a fact, or the fact is UNRESOLVED.
 *
 *  A merged job delivers several services, and two of them can state different
 *  recurrences. There is no honest way to pick one — and the rule this project
 *  already settled says what to do with a fact that is not stated: keep the
 *  step. An extra review costs an hour and a missing one costs a filing, so
 *  disagreement resolves the same way silence does. */
function agreed(values: readonly (string | null)[]): string | null {
  const distinct = new Set(values.filter((v): v is string => v !== null));
  return distinct.size === 1 ? [...distinct][0] ?? null : null;
}

export class PostgresJobSubjectRepository implements JobSubjectSource {
  constructor(private readonly app: Db) {}

  async subjectOf(tenantId: string, jobId: string): Promise<JobSubject | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<SubjectRow[]>`
        SELECT
          live.body AS body,
          le.jurisdiction AS jurisdiction
        FROM delivery.job j
        -- THROUGH THE LINK TABLE (0046), not through source_ref. A merged job
        -- delivers several engagements and its source_ref is a derived group
        -- key naming no row, so joining on it would return nothing for exactly
        -- the jobs this task exists to create. Every job has link rows,
        -- including unmerged ones, which is why there is one join here and not
        -- a branch on source_kind.
        --
        -- An obligation-sourced job has none yet — T3.2 is what gives it
        -- something to link to — and comes back with every fact null, which the
        -- orchestrator reads as "not stated" and therefore keeps every
        -- conditional step.
        JOIN delivery.job_engagement je
          ON je.job_id = j.id AND je.tenant_id = j.tenant_id
        JOIN crm.engagement e
          ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
        JOIN crm.engagement_letter_line l
          ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
        -- Through the PINNED version to the ENTRY, and then back out to what is
        -- published NOW. Two hops rather than one, and the reason is the whole
        -- decision below.
        JOIN config.version pinned
          ON pinned.id = l.service_version_id AND pinned.tenant_id = l.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        -- The entity the work is DELIVERED TO, not the client who is billed —
        -- an entity owes a filing, a client does not. LEFT because an entity may
        -- have no registration recorded, which is a real state and not an error.
        LEFT JOIN core.legal_entity le
          ON le.party_id = l.entity_party_id AND le.tenant_id = l.tenant_id
        WHERE j.id = ${jobId}
        ORDER BY je.created_at, je.engagement_id
      `;
      // No row: a job whose cause cannot be resolved. It should not happen, and
      // it is not a reason to crash a sweep over every other firm's work — the
      // orchestrator refuses that one job and says why.
      if (rows.length === 0) return null;

      const services = rows.map((r) => (r.body === null ? null : readServiceBody(r.body)));
      return {
        // The workflow key is part of the GROUP KEY, so every engagement in a
        // merged job names the same one by construction — `agreed` is the
        // assertion of that rather than a guess, and if the invariant ever
        // breaks the job waits visibly instead of pinning one service's process
        // to another service's work.
        workflowTemplateKey: agreed(services.map((s) => s?.workflowTemplateKey ?? null)),
        // Recurrence is NOT in the key and genuinely can differ — a monthly GST
        // filing merged with an annual return. Disagreement is unresolved, and
        // unresolved keeps the step.
        recurrence: agreed(services.map((s) => s?.recurrence ?? null)),
        // One entity per job, guaranteed by the group key, for the firm's own
        // Per Company rule.
        jurisdiction: agreed(rows.map((r) => r.jurisdiction)),
      };
    });
  }
}
