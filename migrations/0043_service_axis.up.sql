-- 0043 · the firm's own delivery structure — Depts, delivery teams, and which
--        of the two (if either) splits a client's work into separate jobs
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
--
-- G2.1 gave `ServiceBody` two reporting axes, `module` (the Dept — FRC / TRC /
-- RAA) and `group` (the delivery team — FINCOMPLIANCE, VCFO CONSOLE, PAYROLL).
-- Both are FREE TEXT in a stored body, demanded in canonical form at the write
-- so `frc` and `FRC` cannot become two Depts.
--
-- That was enough while the fields were only ever GROUPED BY on a dashboard: a
-- split revenue figure is wrong in a way somebody notices at month end.
--
-- It stops being enough at T2.7. The orchestrator groups an engagement's
-- service lines and gives each group its own job and its own step graph, and the
-- axis it groups on is one of these two fields. Canonical form does not save us
-- there: `FINCOMPLIANCE` and `FIN COMPLIANCE` are both canonical, they are one
-- team to a person, and they would silently become TWO jobs — one client's work
-- split across two checklists with nobody told. That is not a report to correct
-- at month end; it is work nobody is looking at.
--
-- So the two axes become the firm's own LISTS, and the service body's value has
-- to be one of them.
--
-- ── WHY ONE TABLE AND NOT TWO ───────────────────────────────────────────────
--
-- The demo this product is designed against used two tables, `service_module`
-- and `service_group`. They were structurally identical, and two identical
-- tables here would mean two repositories, two services, two sets of routes and
-- two fakes — all answering the same question in the same shape, and all free to
-- drift apart. T3.5 caught exactly that at the composition root (a second
-- `TenantDirectory` and a second fake) and collapsed it before it shipped.
--
-- One table with an `axis` discriminator, CHECKed to a closed set. The CHECK is
-- doing what it does on `config.entry.kind` and `delivery.job.source_kind`:
-- these are the ENGINE's own vocabulary, the same at every firm, so a firm
-- renaming `dept` would be renaming something it does not own. What the firm
-- DOES own is the rows — the codes, the names, the order and which are still in
-- use — and that is the whole point of the table.
--
-- ── WHY `tenancy` AND NOT `config` ──────────────────────────────────────────
--
-- These read like catalogue metadata and they are not. A Dept is the firm's own
-- org structure: G3.2 assigns a SPOC PER DEPT ("each client will defacto have
-- two SPOC, one from TRC and one from FRC"), so `client_assignment.module_id`
-- needs a real row to point at — which today it cannot have, because a Dept is a
-- string inside a frozen JSON body. `tenancy` is where the firm's own structure
-- lives; `tenancy.staff_grade` (0040) is the same shape for the same reason, and
-- this table deliberately copies it.
--
-- ── WHY THE SERVICE BODY STILL STORES A STRING ──────────────────────────────
--
-- The obvious move is to replace `body->>'module'` with a foreign key, and it is
-- the wrong one. A PUBLISHED config version is FROZEN — that freeze is what lets
-- a proposal sent nine months ago still show the price it was sent at — so a
-- migration that rewrote published bodies would break the one guarantee the
-- registry exists to make.
--
-- So the body keeps the CODE it always held, and this table is the list of codes
-- that code must be one of. The check happens at the WRITE, in the config use
-- case, against the rows below. Two consequences, both correct:
--
--   A firm renaming a Dept changes `name` here; every already-published service
--   version keeps the code it named, and reads back with the new name. The code
--   is the join and it does not move — the same argument `config.entry.key`
--   makes about being the pin target.
--
--   A body that names a code no longer in this table still READS. It is history,
--   and history is not corrected by hiding it. It simply cannot be written
--   again, which is what `is_active` is for.
--
-- ── `is_active`, NOT `deleted_at` ───────────────────────────────────────────
--
-- Copied from 0040's ladder, and the distinction is the same one: `deleted_at`
-- means the row was a MISTAKE, `is_active` means the firm has MOVED ON. A Dept
-- that existed in 2026 is part of why a service was filed where it was filed and
-- why a client had the SPOC they had, so it stays readable forever. It is simply
-- not offered for anything new.
--
-- ── AND WHY THE SPLIT AXIS IS A TENANT COLUMN ───────────────────────────────
--
-- `tenancy.tenant.work_split_axis` answers "how does this firm cut a client's
-- work up". It is a COLUMN, beside `firm_signatory_user_id` (0022) and for that
-- entry's stated reason: it is freely changeable and changing it RESTATES
-- NOTHING. Jobs already created keep the rows they have; the next engagement is
-- split the new way. There is nothing here to pin and nothing to version, which
-- is what would have argued for the configuration registry instead.
--
-- **The default is `none`, and that is the honest value rather than a cautious
-- one.** Not every firm has these layers at all — a fifteen-person practice has
-- neither, a single-P&L firm has only delivery teams, a multi-partner firm has
-- only Depts. `none` means "this firm has not said", it reproduces T2.6's
-- current behaviour EXACTLY (one job per engagement), and it means merging this
-- migration changes no firm's behaviour until somebody chooses. A default of
-- `dept` would have silently re-cut every future engagement at every firm on the
-- installation, to save one click.

SET ROLE bib_owner;

-- ── the two lists ───────────────────────────────────────────────────────────
CREATE TABLE tenancy.service_axis (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- WHICH list this row belongs to. The engine's vocabulary, not the firm's —
  -- see the note above. A firm's own word for its Depts is what `name` is for.
  axis       text NOT NULL CHECK (axis IN ('dept', 'team')),

  -- The value that appears in a service body's `module` / `group`, in the
  -- canonical form `isReportingAxis` already demands: upper case, single
  -- separators, "VCFO CONSOLE" allowed because the firm's own team is named
  -- that. This column is the JOIN, and it is why a rename does not touch it.
  code       text NOT NULL,
  -- What a person reads. Freely editable; the code is not.
  name       text NOT NULL,

  -- The order the firm reads its own list in. Not unique and not contiguous,
  -- for 0040's reason: inserting a Dept between two others should not be a
  -- renumbering transaction over every row.
  sort_order integer NOT NULL DEFAULT 0,

  -- The firm has moved on, not the row was a mistake. See the note above.
  is_active  boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A code identifies a row WITHIN a firm and WITHIN an axis. Two firms sharing
  -- `FRC` is normal; so is one firm having a Dept and a team that share a code,
  -- because they are independent dimensions and nothing cross-validates them.
  UNIQUE (tenant_id, axis, code),

  -- The composite-key target. Redundant with the primary key on id alone, which
  -- is exactly why it is safe to add: it constrains no data, it gives a foreign
  -- key something to point at that carries the tenant with it. G3.2's
  -- `client_assignment.module_id` is the first taker. See 0015 for the full
  -- argument — an id-only reference lets one firm's row hang off another firm's,
  -- because a foreign-key check runs as a system operation RLS does not filter.
  UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_service_axis_updated_at BEFORE UPDATE ON tenancy.service_axis
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- A list is always read WHOLE, per axis, in order — a picker, an admin screen,
-- the orchestrator resolving a service's Dept. One index serves all three.
CREATE INDEX idx_service_axis_tenant_axis_order
  ON tenancy.service_axis (tenant_id, axis, sort_order);

-- Tenant-scoped, so the wall applies. Only the tenant clause: there is no
-- identity-mode read of a firm's org structure — nothing asks "this user's Depts
-- across firms", because a Dept is meaningless outside the firm that named it.
ALTER TABLE tenancy.service_axis ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_axis_isolation ON tenancy.service_axis
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- Grants are not repeated: ALTER DEFAULT PRIVILEGES in 0001 already gives
-- bib_app SELECT, INSERT, UPDATE on tables bib_owner creates in this schema. RLS
-- still applies — bib_app is NOBYPASSRLS and owns nothing.

-- ── how this firm cuts a client's work up ───────────────────────────────────
ALTER TABLE tenancy.tenant
  ADD COLUMN work_split_axis text NOT NULL DEFAULT 'none';

ALTER TABLE tenancy.tenant
  ADD CONSTRAINT tenant_work_split_axis_chk
    CHECK (work_split_axis IN ('none', 'dept', 'team'));

-- ── backfill: the codes the catalogue is ALREADY using ──────────────────────
--
-- Every distinct `module` and `group` any service version at this firm has ever
-- named becomes a row. Drafts included, deliberately: a draft naming a Dept is a
-- Dept somebody at the firm typed on purpose, and leaving it out would make the
-- next publish of that draft fail against a list that should have held it.
--
-- `name` starts equal to `code` because that is the only honest value — nobody
-- has written a display name yet, and inventing "Financial Reporting &
-- Compliance" from "FRC" would be a guess presented as the firm's own words. The
-- admin screen is where it gets filled in, exactly as 0040 left grading to it.
--
-- ON CONFLICT DO NOTHING covers the one real case: the same code appearing on
-- both a published version and its draft, which is normal and is one row.
INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
SELECT DISTINCT
  v.tenant_id,
  a.axis,
  v.body ->> a.field AS code,
  v.body ->> a.field AS name
FROM config.version v
JOIN config.entry e ON e.id = v.entry_id
CROSS JOIN (VALUES ('dept', 'module'), ('team', 'group')) AS a(axis, field)
WHERE e.kind = 'service'
  AND v.body ->> a.field IS NOT NULL
  AND btrim(v.body ->> a.field) <> ''
ON CONFLICT (tenant_id, axis, code) DO NOTHING;

RESET ROLE;
