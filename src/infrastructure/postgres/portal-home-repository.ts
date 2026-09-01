// The client portal's status home, in Postgres (T6.5).
//
// ── THIS IS THE ONLY ADAPTER IN THE PRODUCT THAT USES `withPortal` ─────────
//
// Everything else reaches tenant-scoped data through `withTenant`. A portal
// request must not: `withTenant` sets the firm and nothing narrower, and gate
// 4's restrictive policies are armed by `app.portal`, which only `withPortal`
// sets. A portal read written against `withTenant` would return every client's
// rows with a 200 and nothing anywhere would say so.
//
// ── THE QUERIES BELOW LOOK LIKE QUERIES THAT FORGOT TO FILTER ─────────────
//
// They are, and that is the point. Neither statement mentions
// `client_party_id`, `entity_party_id` or `is_client_visible` in its WHERE
// clause, because the wall is UNDER the query rather than in it:
//
//   `work_item_portal_scope`      (0059) — only the granted companies' work
//   `work_item_portal_visible`    (0062) — only what the firm marked visible
//   `obligation_instance_portal_scope` (0062) — only the granted companies'
//                                                filings
//
// Repeating the filter here would make the SQL feel safer and would silently
// disarm the negative control — `tests/portal/portal-reads.integration.test.ts`
// drops a policy and expects these reads to start leaking. A test that passes
// with the wall removed proves only that the rows exist.
//
// ── ONE TRANSACTION, ONE SCOPE ────────────────────────────────────────────
//
// Both statements run inside a single `withPortal`, so the scope is set once
// with `SET LOCAL` semantics and cannot drift between them.
//
// ── EVERY DATE AS `::text`, AND EVERY WINDOW CAST ────────────────────────
//
// A `date` column comes back from postgres.js as a UTC instant, and reading its
// LOCAL fields names the day before west of Greenwich. No `Date` is constructed
// in this file, and the window arithmetic is done by Postgres on the caller's
// own day — `${asOf}::date + ${N}::int` is day arithmetic with no zone in it.
//
// BOTH CASTS ARE LOAD-BEARING AND THE SECOND ONE IS NOT OBVIOUS. postgres.js
// sends every parameter UNTYPED, so `date + $2` is ambiguous to Postgres —
// `date + integer`, `date + interval` and `date + time` all exist — and the
// statement dies with *"operator is not unique: date + unknown"*. It typechecks,
// it lints, and the unit tests use a fake repository, so nothing here goes red:
// it surfaced as a 500 on the first real request, which is the same lesson
// T3.2's `::text::jsonb` double cast already cost this codebase. IF YOU ADD SQL
// TO THIS FILE, RUN IT.
import type { Db } from "../../db/pool";
import { withPortal } from "../../db/tenant";
import type { PortalFilingRow, PortalWorkRow } from "../../domain/portalhome/model";
import {
  PORTAL_FILED_WINDOW_DAYS,
  PORTAL_HORIZON_DAYS,
} from "../../domain/portalhome/model";
import type { PortalHomeRepository, PortalHomeRows } from "../../usecase/portalhome/ports";

interface WorkRow {
  id: string;
  title: string;
  company_name: string | null;
  state_name: string;
  is_held_up: boolean;
  opened_on: string;
  statutory_due_on: string | null;
  held_up_since: string | null;
  held_up_reason: string | null;
  has_open_ask: boolean;
}

interface FilingRow {
  id: string;
  name: string;
  company_name: string;
  period_label: string;
  statutory_due_on: string;
  state_name: string;
  filed_on: string | null;
}

export class PostgresPortalHomeRepository implements PortalHomeRepository {
  constructor(private readonly app: Db) {}

  async read(
    tenantId: string,
    clientPartyIds: readonly string[],
    asOf: string,
  ): Promise<PortalHomeRows> {
    return withPortal(this.app, tenantId, clientPartyIds, async (db) => {
      /**
       * Which filings the FILINGS section is showing — written once and used
       * twice, because the work query has to know it.
       *
       * A function rather than a shared fragment so each query gets its own,
       * and the same text either way: two copies of a window predicate part
       * company the first time somebody widens one of them, and the symptom
       * would be a task appearing in both sections again.
       */
      const shownFilings = () => db`
        ((oi.filed_on IS NULL
            AND oi.statutory_due_on <= ${asOf}::date + ${PORTAL_HORIZON_DAYS}::int)
         OR (oi.filed_on IS NOT NULL
            AND oi.filed_on >= ${asOf}::date - ${PORTAL_FILED_WINDOW_DAYS}::int))
      `;

      // ── the firm's open work on this client's behalf ──────────────────────
      //
      // Terminal work is excluded and that is a BUSINESS filter, not a security
      // one: a finished task belongs under what has been done, and 0054 already
      // established that "terminal" spans both completed and cancelled, so it is
      // not a statement that anything was achieved. What HAS been achieved is
      // answered by the filings below, which say so from the law's side.
      //
      // `due_on` survives only when a statute set it — see the domain note. A
      // date the firm derived from its own SLA is a promise this reader was
      // never given.
      const work = await db<WorkRow[]>`
        SELECT wi.id,
               wi.title,
               ent.display_name AS company_name,
               ws.name          AS state_name,
               ws.is_blocked    AS is_held_up,
               (wi.created_at AT TIME ZONE 'UTC')::date::text AS opened_on,
               CASE WHEN wi.is_statutory_due THEN wi.due_on::text END AS statutory_due_on,
               (wi.blocked_at AT TIME ZONE 'UTC')::date::text AS held_up_since,
               wi.blocked_reason AS held_up_reason,
               -- Does an ask already say this, with somewhere to answer it?
               --
               -- Under gate 4 like everything else here, and the asymmetry that
               -- buys is the same one the filings subquery relies on: an ask the
               -- reader was not granted is invisible to this EXISTS, so it
               -- answers false and the blocked reason is shown. Which is right —
               -- if the client cannot see the ask, the reason is the only thing
               -- on the page that says what is wanted.
               EXISTS (
                 SELECT 1
                   FROM delivery.client_ask ca
                  WHERE ca.work_item_id = wi.id
                    AND ca.tenant_id = wi.tenant_id
                    AND ca.status IN ('open', 'answered')
               ) AS has_open_ask
          FROM delivery.work_item wi
          JOIN delivery.work_item_state ws
            ON ws.id = wi.state_id AND ws.tenant_id = wi.tenant_id
          LEFT JOIN core.party ent
            ON ent.id = wi.entity_party_id AND ent.tenant_id = wi.tenant_id
         WHERE wi.tenant_id = ${tenantId}
           AND NOT ws.is_terminal
           -- ── AND NOT A FILING THIS PAGE IS ALREADY SHOWING ────────────────
           --
           -- FOUND BY LOOKING AT IT, not by a test. The compliance calendar
           -- raises a task per obligation, so the first real response carried
           -- "GSTR-3B — Cobalt Foods — Jul 2026" TWICE: once as a filing the
           -- law wants and once as a task the firm holds. To the firm those
           -- are two different things (0053's whole distinction); to the
           -- client reading this page they are one thing listed twice, and a
           -- page that says everything twice is one nobody finishes reading.
           --
           -- The obligation is the better of the two here: it is the LAW's
           -- statement, it carries the statutory date, and its state is the
           -- one a client can act on.
           --
           -- AND THE ASYMMETRY IS THE CLEVER HALF, and it falls out of RLS
           -- rather than being coded: this subquery runs under gate 4 too, so
           -- an obligation belonging to a company that was NOT granted is
           -- invisible here, the NOT EXISTS below is true, and its task stays on
           -- the page. Which is right — that task is then the only trace of the
           -- work the client can see, and hiding it would hide work.
           AND NOT EXISTS (
             SELECT 1
               FROM delivery.obligation_instance oi
              WHERE oi.work_item_id = wi.id
                AND oi.tenant_id = wi.tenant_id
                AND ${shownFilings()}
           )
         ORDER BY ws.is_blocked DESC, wi.created_at ASC
      `;

      // ── what the law asks of this client's companies ──────────────────────
      //
      // Two windows in one statement, split in the domain: still owed (any
      // overdue one included whatever its date, because a passed deadline is the
      // row this reader most needs) and filed inside the recent window.
      //
      // `internal_target_on` is NOT selected. It is the firm's own working
      // margin and showing it to a client turns it into the deadline.
      const filings = await db<FilingRow[]>`
        SELECT oi.id,
               t.name           AS name,
               ent.display_name AS company_name,
               oi.period_label,
               oi.statutory_due_on::text AS statutory_due_on,
               os.name          AS state_name,
               oi.filed_on::text AS filed_on
          FROM delivery.obligation_instance oi
          JOIN delivery.obligation_template t
            ON t.id = oi.template_id AND t.tenant_id = oi.tenant_id
          JOIN delivery.obligation_state os
            ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
          JOIN core.party ent
            ON ent.id = oi.entity_party_id AND ent.tenant_id = oi.tenant_id
         WHERE oi.tenant_id = ${tenantId}
           AND ${shownFilings()}
         ORDER BY oi.filed_on DESC NULLS LAST, oi.statutory_due_on ASC
      `;

      return {
        work: work.map(toWorkRow),
        filings: filings.map(toFilingRow),
      };
    });
  }
}

function toWorkRow(r: WorkRow): PortalWorkRow {
  return {
    workItemId: r.id,
    title: r.title,
    companyName: r.company_name,
    stateName: r.state_name,
    isHeldUp: r.is_held_up,
    openedOn: r.opened_on,
    statutoryDueOn: r.statutory_due_on,
    heldUpSince: r.held_up_since,
    heldUpReason: r.held_up_reason,
    hasOpenAsk: r.has_open_ask,
  };
}

function toFilingRow(r: FilingRow): PortalFilingRow {
  return {
    obligationId: r.id,
    name: r.name,
    companyName: r.company_name,
    periodLabel: r.period_label,
    statutoryDueOn: r.statutory_due_on,
    stateName: r.state_name,
    filedOn: r.filed_on,
  };
}
