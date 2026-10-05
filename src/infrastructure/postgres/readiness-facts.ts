// The facts setup readiness (V2.6) is computed from, for one firm on one day.
//
// Read-only, and every query runs inside ONE `withTenant`, so the eight lines
// describe the same moment and RLS scopes every table to the session's firm.
// Each query restates the rule the product ALREADY applies somewhere else, and
// says where, because a readiness line that disagreed with the behaviour it
// predicts would be worse than no line:
//
//   - a service's Dept is the LIVE published version's `module`, as routing
//     reads it (work items, "slaDays is PINNED and the Dept is LIVE");
//   - an assignment or a portal grant is in force on `day` when
//     `valid_from <= day < valid_to` (half-open, G3.2 and 0061);
//   - a rule generates when it is active, dated, not event-driven, CONFIRMED
//     and has a live link to a service (the generator's own predicate,
//     obligation-rule-repository.ts `generatingRules`);
//   - one of the firm's companies is `crm.is_firm_entity`'s two sources (the
//     firm itself, or a live member of 0313's list), not archived, as the
//     Our companies list reads them (firm-entity-repository.ts);
//   - a standard term is a `clause` entry with a published version, which is
//     what a letter is offered (the Standard terms screen).
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ReadinessFacts } from "../../domain/readiness/model";
import { DEFAULT_TIME_ZONE } from "../../domain/tenancy/model";
import type { ReadinessFactSource } from "../../usecase/readiness/ports";

interface ClientRow {
  party_id: string;
  name: string;
  has_key_manager: boolean;
  depts_without_spoc: string[] | null;
  has_portal_login: boolean;
}

export class PostgresReadinessFacts implements ReadinessFactSource {
  constructor(private readonly app: Db) {}

  async factsFor(tenantId: string, day: string): Promise<Omit<ReadinessFacts, "day">> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── Active clients, their account team and their portal logins ───────
      const clients = await db<ClientRow[]>`
        WITH active AS (
          SELECT DISTINCT e.party_id
            FROM crm.engagement e
            JOIN core.party p ON p.id = e.party_id AND p.tenant_id = e.tenant_id
           WHERE e.status = 'active' AND p.archived_at IS NULL
        ),
        -- The Depts each client's services name, read off the LIVE version
        -- (the pinned one when nothing is published any more).
        needs AS (
          SELECT DISTINCT e.party_id,
                 COALESCE(live.body ->> 'module', pinned.body ->> 'module') AS dept_code
            FROM crm.engagement e
            JOIN crm.engagement_letter_line ln
              ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
            JOIN config.version pinned
              ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
            LEFT JOIN config.version live
              ON live.entry_id = pinned.entry_id
             AND live.tenant_id = pinned.tenant_id
             AND live.status = 'published'
           WHERE e.status = 'active'
             AND COALESCE(live.body ->> 'module', pinned.body ->> 'module') IS NOT NULL
        ),
        in_force AS (
          SELECT a.client_party_id, a.role, x.code AS dept_code
            FROM crm.client_assignment a
            LEFT JOIN tenancy.service_axis x
              ON x.id = a.axis_id AND x.tenant_id = a.tenant_id AND x.axis = 'dept'
           WHERE a.valid_from <= ${day}::date
             AND (a.valid_to IS NULL OR a.valid_to > ${day}::date)
        )
        SELECT c.party_id,
               p.display_name AS name,
               EXISTS (SELECT 1 FROM in_force f
                        WHERE f.client_party_id = c.party_id AND f.role = 'key_manager') AS has_key_manager,
               (SELECT array_agg(n.dept_code ORDER BY n.dept_code)
                  FROM needs n
                 WHERE n.party_id = c.party_id
                   AND NOT EXISTS (SELECT 1 FROM in_force f
                                    WHERE f.client_party_id = c.party_id
                                      AND f.role = 'spoc'
                                      AND f.dept_code = n.dept_code)) AS depts_without_spoc,
               EXISTS (SELECT 1
                         FROM crm.portal_access pa
                         JOIN tenancy.membership m
                           ON m.id = pa.membership_id AND m.tenant_id = pa.tenant_id
                        WHERE pa.client_party_id = c.party_id
                          AND m.is_active
                          AND pa.valid_from <= ${day}::date
                          AND (pa.valid_to IS NULL OR pa.valid_to > ${day}::date)) AS has_portal_login
          FROM active c
          JOIN core.party p ON p.id = c.party_id AND p.tenant_id = ${tenantId}
         ORDER BY p.display_name
      `;

      // ── Reporting lines, where a published check rule reads them alone ───
      const policies = await db<{ label: string | null; key: string }[]>`
        SELECT en.key, v.body ->> 'label' AS label
          FROM config.entry en
          JOIN config.version v
            ON v.entry_id = en.id AND v.tenant_id = en.tenant_id AND v.status = 'published'
         WHERE en.kind = 'verification_policy'
           AND v.body ->> 'rule' = 'reporting_line'
         ORDER BY en.key
      `;
      // Nobody is above the firm's TOP rung, so its holders are not asked for
      // a manager. An ungraded person is: nothing says they are at the top.
      const unmanaged = await db<{ user_id: string; display_name: string | null; email: string }[]>`
        SELECT m.user_id, u.display_name, u.email
          FROM tenancy.membership m
          JOIN tenancy.user_account u ON u.id = m.user_id
          LEFT JOIN tenancy.staff_grade g ON g.id = m.grade_id AND g.tenant_id = m.tenant_id
         WHERE m.audience = 'STAFF'
           AND m.is_active
           AND m.reports_to_user_id IS NULL
           AND (g.rank IS NULL
                OR g.rank < (SELECT max(t.rank) FROM tenancy.staff_grade t WHERE t.is_active))
         ORDER BY COALESCE(u.display_name, u.email)
      `;

      // ── Ladders and the compliance policy: published at all ─────────────
      const published = await db<{ kind: string; key: string; body: Record<string, unknown> }[]>`
        SELECT en.kind, en.key, v.body
          FROM config.entry en
          JOIN config.version v
            ON v.entry_id = en.id AND v.tenant_id = en.tenant_id AND v.status = 'published'
         WHERE en.kind IN ('escalation', 'chaser', 'nudge', 'compliance_policy')
      `;
      const kinds = new Set(published.map((r) => r.kind));
      const policy = published.find((r) => r.kind === "compliance_policy" && r.key === "default")?.body ?? {};
      const floor = policy["missedFromOn"];
      const fy = policy["fiscalYearStartMonth"];

      // ── Compliance rules ─────────────────────────────────────────────────
      const [rules] = await db<{ generating: number }[]>`
        SELECT count(*)::int AS generating
          FROM delivery.obligation_template t
         WHERE t.is_active AND t.due_rule IS NOT NULL AND t.recurrence <> 'event'
           AND t.status = 'confirmed'
           AND EXISTS (SELECT 1 FROM delivery.obligation_rule_service l
                        WHERE l.tenant_id = t.tenant_id AND l.lineage_id = t.lineage_id
                          AND l.unlinked_at IS NULL)
      `;
      const unconfirmed = await db<{ id: string; name: string }[]>`
        SELECT t.id, t.name
          FROM delivery.obligation_template t
         WHERE t.is_active AND t.status <> 'confirmed'
           AND EXISTS (SELECT 1 FROM delivery.obligation_rule_service l
                        WHERE l.tenant_id = t.tenant_id AND l.lineage_id = t.lineage_id
                          AND l.unlinked_at IS NULL)
         ORDER BY t.name
      `;

      // ── Live services and the process each names ─────────────────────────
      const services = await db<{ key: string; name: string | null; process_key: string | null; process_published: boolean }[]>`
        SELECT en.key,
               v.body ->> 'name' AS name,
               NULLIF(btrim(v.body ->> 'workflowTemplateKey'), '') AS process_key,
               EXISTS (SELECT 1
                         FROM config.entry we
                         JOIN config.version wv
                           ON wv.entry_id = we.id AND wv.tenant_id = we.tenant_id
                          AND wv.status = 'published'
                        WHERE we.kind = 'workflow_template'
                          AND we.key = v.body ->> 'workflowTemplateKey') AS process_published
          FROM config.entry en
          JOIN config.version v
            ON v.entry_id = en.id AND v.tenant_id = en.tenant_id AND v.status = 'published'
         WHERE en.kind = 'service'
         ORDER BY v.body ->> 'name'
      `;

      const [tenant] = await db<{ client_request_routing: string; time_zone: string }[]>`
        SELECT client_request_routing, time_zone FROM tenancy.tenant WHERE id = ${tenantId}
      `;

      // ── The firm's own companies (2026-10-03) ────────────────────────────
      const companies = await db<{ party_id: string; name: string; country: string | null; has_address: boolean }[]>`
        SELECT p.id AS party_id, p.display_name AS name, le.jurisdiction AS country,
               COALESCE(jsonb_array_length(
                 CASE WHEN jsonb_typeof(le.registered_address -> 'lines') = 'array'
                      THEN le.registered_address -> 'lines' END) > 0, false) AS has_address
          FROM core.party p
          JOIN core.organization o ON o.party_id = p.id AND o.tenant_id = p.tenant_id
          LEFT JOIN core.legal_entity le ON le.party_id = p.id AND le.tenant_id = p.tenant_id
         WHERE p.archived_at IS NULL
           AND (o.is_firm_self
                OR EXISTS (SELECT 1 FROM crm.firm_entity m
                            WHERE m.party_id = p.id AND m.tenant_id = p.tenant_id
                              AND m.retired_at IS NULL))
         ORDER BY o.is_firm_self DESC, p.display_name
      `;
      // ── Client companies quoted or engaged (Q076) ──────────────────────
      const clientCompanies = await db<{ party_id: string; name: string; country: string | null; year_end: string | null }[]>`
        SELECT p.id AS party_id, p.display_name AS name, le.jurisdiction AS country,
               le.financial_year_end AS year_end
          FROM core.party p
          LEFT JOIN core.organization o ON o.party_id = p.id AND o.tenant_id = p.tenant_id
          LEFT JOIN core.legal_entity le ON le.party_id = p.id AND le.tenant_id = p.tenant_id
         WHERE p.archived_at IS NULL
           AND p.kind = 'organization'
           AND NOT COALESCE(o.is_firm_self, false)
           AND NOT EXISTS (SELECT 1 FROM crm.firm_entity m WHERE m.party_id = p.id AND m.tenant_id = p.tenant_id)
           AND (EXISTS (SELECT 1 FROM crm.proposal q WHERE q.party_id = p.id AND q.tenant_id = p.tenant_id AND q.deleted_at IS NULL)
                OR EXISTS (SELECT 1 FROM crm.engagement_letter l WHERE l.party_id = p.id AND l.tenant_id = p.tenant_id AND l.deleted_at IS NULL)
                OR EXISTS (SELECT 1 FROM crm.engagement_letter_line ll WHERE ll.entity_party_id = p.id AND ll.tenant_id = p.tenant_id)
                OR EXISTS (SELECT 1 FROM crm.engagement e
                            WHERE (e.party_id = p.id OR e.entity_party_id = p.id) AND e.tenant_id = p.tenant_id))
         ORDER BY p.display_name, p.id
      `;
      const [people] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM tenancy.membership
         WHERE audience = 'STAFF' AND is_active
      `;
      const [terms] = await db<{ n: number }[]>`
        SELECT count(DISTINCT en.id)::int AS n
          FROM config.entry en
          JOIN config.version v
            ON v.entry_id = en.id AND v.tenant_id = en.tenant_id AND v.status = 'published'
         WHERE en.kind = 'clause'
      `;

      // ── Authority-assigned periods (Q073, 0359) ──────────────────────────
      // The rules that cut on them, and every client company such a rule
      // reaches (its country, a live engagement whose service carries the
      // rule) with no period recorded for the rule's tax.
      const [assigned] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM delivery.obligation_template t
         WHERE t.is_active AND t.status = 'confirmed' AND t.period_basis = 'authority_assigned'
           AND EXISTS (SELECT 1 FROM delivery.obligation_rule_service l
                        WHERE l.tenant_id = t.tenant_id AND l.lineage_id = t.lineage_id
                          AND l.unlinked_at IS NULL)
      `;
      const unassigned = await db<{ party_id: string; name: string; taxes: string[] }[]>`
        SELECT le.party_id, p.display_name AS name,
               array_agg(DISTINCT upper(btrim(t.module)) ORDER BY upper(btrim(t.module))) AS taxes
          FROM delivery.obligation_template t
          JOIN delivery.obligation_rule_service l
            ON l.tenant_id = t.tenant_id AND l.lineage_id = t.lineage_id AND l.unlinked_at IS NULL
          JOIN config.version pinned
            ON pinned.entry_id = l.service_entry_id AND pinned.tenant_id = l.tenant_id
          JOIN crm.engagement_letter_line ln
            ON ln.service_version_id = pinned.id AND ln.tenant_id = pinned.tenant_id
          JOIN crm.engagement e
            ON e.engagement_letter_line_id = ln.id AND e.tenant_id = ln.tenant_id AND e.status = 'active'
          JOIN core.legal_entity le
            ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
           AND le.jurisdiction = t.jurisdiction
          JOIN core.party p
            ON p.id = le.party_id AND p.tenant_id = le.tenant_id AND p.archived_at IS NULL
         WHERE t.is_active AND t.status = 'confirmed' AND t.period_basis = 'authority_assigned'
           AND NOT EXISTS (SELECT 1 FROM core.legal_entity_return_period rp
                            WHERE rp.tenant_id = le.tenant_id AND rp.entity_party_id = le.party_id
                              AND rp.tax = upper(btrim(t.module)) AND rp.cleared_at IS NULL)
         GROUP BY le.party_id, p.display_name
         ORDER BY p.display_name
      `;

      return {
        assignedPeriodRules: assigned?.n ?? 0,
        companiesWithoutReturnPeriod: unassigned.map((c) => ({ partyId: c.party_id, name: c.name, taxes: c.taxes })),
        companies: companies.map((c) => ({
          partyId: c.party_id,
          name: c.name,
          country: c.country,
          hasAddress: c.has_address,
        })),
        clientCompanies: clientCompanies.map((c) => ({
          partyId: c.party_id,
          name: c.name,
          country: c.country,
          yearEnd: c.year_end,
        })),
        timeZone: tenant?.time_zone ?? DEFAULT_TIME_ZONE,
        activeStaff: people?.n ?? 0,
        publishedTerms: terms?.n ?? 0,
        activeClients: clients.map((c) => ({
          partyId: c.party_id,
          name: c.name,
          hasKeyManager: c.has_key_manager,
          deptsWithoutSpoc: c.depts_without_spoc ?? [],
          hasPortalLogin: c.has_portal_login,
        })),
        reportingLinePolicies: policies.map((p) => p.label ?? p.key),
        staffWithoutManager: unmanaged.map((u) => ({ userId: u.user_id, name: u.display_name ?? u.email })),
        ladders: { escalation: kinds.has("escalation"), chaser: kinds.has("chaser"), nudge: kinds.has("nudge") },
        missedFromOn: typeof floor === "string" ? floor : null,
        fiscalYearStartMonth: typeof fy === "number" ? fy : null,
        generatingRules: rules?.generating ?? 0,
        linkedUnconfirmedRules: unconfirmed.map((r) => ({ id: r.id, name: r.name })),
        services: services.map((s) => ({
          key: s.key,
          name: s.name ?? s.key,
          processKey: s.process_key,
          processPublished: s.process_key !== null && s.process_published,
        })),
        requestRouting: tenant?.client_request_routing ?? "none",
      };
    });
  }
}
