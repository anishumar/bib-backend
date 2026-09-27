// Postgres adapter for `EngagementWorkSource` (T3.1) — what an engagement needs
// to become a work item on somebody's desk.
//
// ONE query for the whole batch, and that is not an optimisation: the caller is
// a sweep, and N round trips inside it would be N chances to read a different
// state than the first — a partner editing the catalogue halfway through would
// give two lines of one letter two different SLAs. Same argument
// `unspawnedActivations` makes about reading the grouping facts in one pass.
//
// ── ONE PINNED READ AND ONE LIVE READ, IN THE SAME ROW ─────────────────────
//
// `slaDays` comes off the PINNED version — the one the client actually signed.
// G2.3's whole argument: the item copies the value in force AT CREATION so a
// later catalogue revision cannot make finished work retroactively late.
//
// `module` — the Dept the SPOC lookup joins on — comes off the LIVE published
// version, which is the opposite and deliberately so. A client agreed to the
// service, its price and its scope; they did not agree to which of our
// departments delivers it. `unspawnedActivations` reads the grouping facts the
// same way, for the same reason, and the two must not drift: a job cut by one
// Dept and a work item routed by another would put the task on a desk that is
// not on the checklist.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type {
  EngagementWork,
  EngagementWorkSource,
  LetterWorkLine,
  LetterWorkSource,
} from "../../usecase/workitem/ports";

interface WorkRow {
  engagement_id: string;
  client_party_id: string;
  entity_party_id: string;
  effective_from: string;
  service_version_id: string | null;
  service_name: string | null;
  line_description: string | null;
  sla_days: string | null;
  dept_code: string | null;
}

export class PostgresEngagementWorkSource implements EngagementWorkSource {
  constructor(private readonly app: Db) {}

  async workFor(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<readonly EngagementWork[]> {
    if (engagementIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<WorkRow[]>`
        SELECT
          e.id                     AS engagement_id,
          -- The CLIENT is the LETTER's party — who is billed and who the SPOC
          -- is recorded against. The ENTITY is the engagement's own — which of
          -- the client's companies owes the work (G0.1). Both, because a group
          -- of four companies has one account team and four sets of filings.
          l.party_id               AS client_party_id,
          e.entity_party_id,
          -- A DATE column, cast to text. postgres.js parses a date column into
          -- a JS Date, which is an INSTANT and a different calendar day either
          -- side of midnight UTC — and this is the value the due date is
          -- computed FROM. Selected as text so the arithmetic stays a calendar
          -- calculation all the way through.
          e.effective_from::text   AS effective_from,
          ln.service_version_id,
          pinned.body ->> 'name'   AS service_name,
          ln.description           AS line_description,
          -- PINNED. See the note at the top of this file.
          pinned.body ->> 'slaDays' AS sla_days,
          -- LIVE. See the note at the top of this file.
          live.body ->> 'module'   AS dept_code
        FROM crm.engagement e
        JOIN crm.engagement_letter l
          ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        -- LEFT from here down, and this half matters more than it looks. A
        -- service that cannot be resolved — unpublished since, or a line that
        -- went missing — must still produce a work item: it lands with no SLA,
        -- no Dept and therefore no SPOC, visibly, in the unassigned queue.
        -- Losing the task because we could not decide who it belonged to is the
        -- worst failure available here, and it is the same call
        -- unspawnedActivations makes about spawning the job.
        LEFT JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        WHERE e.id = ANY(${db.array(engagementIds as string[])}::uuid[])
      `;
      return rows.map(toWork);
    });
  }
}

/**
 * An UNSIGNED letter's lines, for the routing preview on its Send (T6.17).
 *
 * The same two facts `workFor` hands the router once the letter is signed,
 * read the same way: the CLIENT is the letter's party, and the Dept is the
 * LIVE published version's `module` (the note at the top of this file). The
 * preview is only worth showing if it names the desk the work will really
 * land on, so the two joins must not drift apart.
 */
export class PostgresLetterWorkSource implements LetterWorkSource {
  constructor(private readonly app: Db) {}

  async linesOf(
    tenantId: string,
    letterId: string,
  ): Promise<{ readonly clientPartyId: string; readonly lines: readonly LetterWorkLine[] } | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const letters = await db<{ party_id: string }[]>`
        SELECT party_id FROM crm.engagement_letter WHERE id = ${letterId}
      `;
      const letter = letters[0];
      if (!letter) return null;
      const rows = await db<
        { line_id: string; service_name: string | null; description: string; dept_code: string | null }[]
      >`
        SELECT ln.id AS line_id,
               pinned.body ->> 'name' AS service_name,
               ln.description,
               live.body ->> 'module' AS dept_code
        FROM crm.engagement_letter_line ln
        LEFT JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        WHERE ln.engagement_letter_id = ${letterId}
        ORDER BY ln.position, ln.id
      `;
      return {
        clientPartyId: letter.party_id,
        lines: rows.map((r) => ({
          lineId: r.line_id,
          name: r.service_name ?? r.description,
          deptCode: r.dept_code,
        })),
      };
    });
  }
}

function toWork(r: WorkRow): EngagementWork {
  return {
    engagementId: r.engagement_id,
    clientPartyId: r.client_party_id,
    entityPartyId: r.entity_party_id,
    effectiveFrom: r.effective_from,
    serviceVersionId: r.service_version_id,
    // The service's own name, falling back to what the LETTER LINE said, and
    // then to a sentence. The line's description is what the client read and
    // signed, so it is a better second answer than a uuid or an empty cell —
    // and a service unpublished since is exactly when it is needed. The third
    // fallback exists because `title` is NOT NULL and both joins are LEFT: the
    // honest thing on a work board is a row that says it could not resolve its
    // own service, not no row at all.
    serviceName:
      r.service_name ?? r.line_description ?? "Engagement work (service not resolvable)",
    // A JSON number read out as text; a body that never stated one is null, and
    // null means NO DUE DATE rather than a deadline this product invented. Range
    // checked rather than bare-cast, because a body published before the
    // validator existed could legitimately carry a non-numeric value.
    slaDays: toWholeDays(r.sla_days),
    deptCode: r.dept_code,
  };
}

function toWholeDays(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
