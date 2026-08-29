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

export class PostgresJobSubjectRepository implements JobSubjectSource {
  constructor(private readonly app: Db) {}

  async subjectOf(tenantId: string, jobId: string): Promise<JobSubject | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<SubjectRow[]>`
        SELECT
          live.body AS body,
          le.jurisdiction AS jurisdiction
        FROM delivery.job j
        -- source_ref is not a foreign key (it names different tables for
        -- different source_kinds, which one column cannot express), so the kind
        -- is checked here rather than assumed. An obligation-sourced job joins
        -- nothing yet — T3.2 is what gives it something to join to — and comes
        -- back with every fact null, which the orchestrator reads as "not
        -- stated" and therefore keeps every conditional step.
        JOIN crm.engagement e
          ON j.source_kind = 'engagement' AND e.id = j.source_ref AND e.tenant_id = j.tenant_id
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
      `;
      // No row: a job whose cause cannot be resolved. It should not happen, and
      // it is not a reason to crash a sweep over every other firm's work — the
      // orchestrator refuses that one job and says why.
      if (!row) return null;

      const service = row.body === null ? null : readServiceBody(row.body);
      return {
        workflowTemplateKey: service?.workflowTemplateKey ?? null,
        recurrence: service?.recurrence ?? null,
        jurisdiction: row.jurisdiction,
      };
    });
  }
}
