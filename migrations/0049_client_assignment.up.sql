-- 0049 · who at the firm owns a client — the Key Manager, and the SPOCs
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
--
-- Today nothing in this schema answers "who at the firm looks after this
-- client". An engagement letter is signed, jobs are created, steps are walked —
-- and the relationship itself has no owner written down anywhere.
--
-- Three things are broken by that absence, and all three are already visible:
--
--   · There is no "my clients" — a partner cannot see their own book.
--   · T3.1's acceptance line is *"a filing arrives pre-assigned to the client's
--     Dept SPOC"*, and there is nothing to read. T3.1 is blocked on this row.
--   · An escalation has no target. A step is stuck and the SLA has gone; there
--     is no query that says who to tell.
--
-- The demo this product is designed against carried this table from phase 2,
-- and its own comment records what happened while nothing read it: two places
-- INVENTED their own answer instead. An email from a five-year-old client was
-- routed by the same generic rules as a stranger's, and a GSTR-3B task the
-- calendar generated was created with NO ASSIGNEE AT ALL. Both are the same
-- failure — a fact the firm gave us at signature, asked for again later because
-- nowhere held it.
--
-- ── THE TWO ROLES ARE AT DIFFERENT LEVELS ───────────────────────────────────
--
-- Confirmed firm practice, not a guess:
--
--   · **Key Manager** — one per client. Owns the relationship: pricing,
--     renewals, escalation. No axis.
--   · **SPOC** — the day-to-day contact, per axis. The firm's own words:
--     *"each client will defacto have two SPOC, one from TRC and one from FRC"*.
--     A client buying RAA work as well has three.
--
-- That is why this is a ROW PER ASSIGNMENT and not two columns on the client. A
-- pair of columns fixes the count at two and the firm already has clients with
-- three.
--
-- The SPOC is a COORDINATION point, not the person doing the work. A job carries
-- its own assignee; this table says who the client talks to.
--
-- ── WHY `axis_id` AND NOT `module_id` — A DELIBERATE WIDENING ───────────────
--
-- The board's G3.2 line says `module_id`, "the Dept for a SPOC, enforced by
-- CHECK". This column is wider on purpose and the board has been corrected with
-- the reason.
--
-- 0043 made a firm's Depts and delivery teams ONE list with an `axis`
-- discriminator, precisely because neither layer is universal: a fifteen-person
-- practice has neither, a single-P&L firm has delivery teams and no revenue
-- split, a multi-partner firm has the opposite. Pinning a SPOC to `dept` would
-- mean the second kind of firm has nowhere to put one — and the product is sold
-- to other firms from day one.
--
-- It costs nothing at 10x Global. They point their SPOCs at their Depts and get
-- exactly the behaviour the board asked for; it is a picker on a screen rather
-- than a migration. And it matters more than usual here, because 10x's OWN
-- Dept-versus-team question is open: the firm's services master says
-- FINCOMPLIANCE delivers under both TRC (19) and FRC (14), and the owner has
-- since said "Fincompliance is only FRC". Building a constraint on the axis
-- nobody has settled would be answering that question in DDL.
--
-- What is still enforced, because it is structural rather than a policy: a SPOC
-- has an axis and a Key Manager never does.
--
-- ── WHY `crm` AND NOT `tenancy` ─────────────────────────────────────────────
--
-- 0040's ladder and 0043's Depts are in `tenancy` because they are the firm
-- describing ITSELF. This is the firm describing a RELATIONSHIP with a client:
-- it is keyed on `client_party_id`, it is meaningless without one, and it is
-- read from both lanes — the commercial one routing an enquiry, the delivery one
-- routing a filing. `crm` is where facts about a client's dealings with the firm
-- live.
--
-- ── EFFECTIVE-DATED, HALF-OPEN, AND WHY THAT IS NOT THE DEMO'S SHAPE ────────
--
-- `[valid_from, valid_to)` — `valid_to` is the first day NOT in force. The demo
-- used an INCLUSIVE upper bound (`valid_to >= on`), and copying it here would
-- have been a bug: every effective-dated thing in BiB is half-open —
-- `core.party_relationship`, `core.party_identifier`, and `isInForceOn` in the
-- party domain, which is the one predicate the whole codebase asks this question
-- through. Two conventions in one schema is an off-by-one waiting for a
-- handover, and it shows up as TWO SPOCs on the changeover day, which is exactly
-- the answer this table exists to make singular.
--
-- A handover is therefore: close the old row at date D, open the new one at date
-- D. Contiguous, no gap, no overlap — and the ranges below express it directly.
--
-- Never an UPDATE of `user_id`. Overwriting who the SPOC is destroys the only
-- record of who it WAS, and "who was the SPOC when this went wrong" is the
-- question this column exists for.
--
-- ── THE TWO EXCLUSION CONSTRAINTS, AND THE ONE THAT IS DELIBERATELY ABSENT ──
--
-- A partial unique index over open rows (`WHERE valid_to IS NULL`) is the
-- obvious move and it is not enough: it constrains only TODAY. Two CLOSED rows
-- overlapping in March slip past it, and then "who was the SPOC in March" comes
-- back with two names — the acceptance criterion, failed, by a constraint that
-- looked like it covered this. So the ranges are compared as ranges, with
-- `btree_gist` letting the scalar columns join the same index.
--
--   · ONE KEY MANAGER at a time per client. The firm's own statement, and a
--     contradiction in terms otherwise — the Key Manager IS the single owner.
--
--   · NO DUPLICATE assignment: the same person, in the same role, on the same
--     axis, cannot hold two overlapping rows for one client. This is
--     de-duplication, not policy — a double-click, a re-import, a handover
--     recorded twice.
--
-- **There is deliberately NO "one SPOC per axis" constraint, and this is a
-- decision, not an omission.** The board's acceptance line says one SPOC per
-- Dept; Shrestha's instruction (2026-08-30) is that in general a Dept may have
-- more than one — leave cover, a joint SPOC on a large group, a handover period
-- run in parallel. Encoding "exactly one" would make those unrecordable, and a
-- firm hitting it has no screen that can help them.
--
-- The consequence is stated rather than discovered: "who was the SPOC in March"
-- can answer with a LIST. That is the honest answer when the firm really had
-- two, and every reader is built to take a list. What T3.1 does when a Dept has
-- two SPOCs is T3.1's decision, made with its screen in hand — not pre-empted
-- here by a constraint that would simply have refused the data.
--
-- The direction of that choice is also the cheap one to reverse. Dropping a
-- constraint later is one line. ADDING one later fails against whatever overlap
-- the firm has already recorded, and then somebody has to decide which of two
-- real assignments to delete.

-- Lets `uuid = uuid` and `text = text` sit in a gist index beside a range
-- overlap. Without it the two constraints below can only be written as a trigger
-- with a SELECT in it, which is a race under concurrency — two handovers landing
-- together both read "no overlap" and both insert.
--
-- BEFORE `SET ROLE`, like `pgcrypto` and `citext` in 0001 and `pg_trgm` in 0002:
-- installing an extension needs CREATE on the DATABASE, which `bib_owner`
-- deliberately does not hold. The migrator connects as `BIB_DATABASE_URL`, which
-- does — that is the whole difference between the migration role and the app
-- role.
CREATE EXTENSION IF NOT EXISTS btree_gist;

SET ROLE bib_owner;

CREATE TABLE crm.client_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- The CLIENT, not the entity. A group with four companies has one Key Manager
  -- and one set of SPOCs; `crm.engagement` is where per-entity work lives.
  client_party_id uuid NOT NULL,

  role            text NOT NULL CHECK (role IN ('key_manager', 'spoc')),

  -- The Dept or delivery team a SPOC covers. Null for a Key Manager, who covers
  -- the whole relationship. See the note above on why this is not Dept-only.
  axis_id         uuid,

  -- BY ID ALONE, for `job_step.performed_by`'s and `step_approval.decided_by`'s
  -- reason: `tenancy.user_account` is deliberately NOT tenant-scoped (one login,
  -- many firms), so there is no `(id, tenant_id)` to point at. That the user
  -- actually works at THIS firm is checked at the write, against the roster.
  user_id         uuid NOT NULL REFERENCES tenancy.user_account(id),

  -- Half-open: valid_to is the FIRST DAY NOT IN FORCE. Null = still in force.
  valid_from      date NOT NULL,
  valid_to        date,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- ── the tenant wall ──────────────────────────────────────────────────────
  --
  -- Composite, both of them. A foreign-key check runs as a SYSTEM operation
  -- that RLS does not filter, so an id-only reference would let one firm's
  -- assignment hang off another firm's client or another firm's Dept with every
  -- policy on this table satisfied. See 0015 for the full argument.
  CONSTRAINT client_assignment_client_fkey
    FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT client_assignment_axis_fkey
    FOREIGN KEY (axis_id, tenant_id) REFERENCES tenancy.service_axis (id, tenant_id),

  CONSTRAINT client_assignment_id_tenant_key UNIQUE (id, tenant_id),

  -- ── the shape rules ──────────────────────────────────────────────────────

  -- A SPOC covers something; a Key Manager covers the client. Both halves, so
  -- neither "a Key Manager for TRC" nor "a SPOC for nothing in particular" is
  -- representable — the second is the one that would quietly become a second
  -- key manager under a different name.
  CONSTRAINT client_assignment_axis_matches_role CHECK (
    (role = 'spoc'        AND axis_id IS NOT NULL) OR
    (role = 'key_manager' AND axis_id IS NULL)
  ),

  -- Half-open, so an empty range is a row that is in force on no day at all.
  CONSTRAINT client_assignment_dates_ordered CHECK (
    valid_to IS NULL OR valid_to > valid_from
  ),

  -- ── one Key Manager at a time ────────────────────────────────────────────
  --
  -- Ranges compared as ranges: a partial index over open rows would let two
  -- CLOSED rows overlap in March and leave the history ambiguous.
  CONSTRAINT client_assignment_one_key_manager EXCLUDE USING gist (
    tenant_id       WITH =,
    client_party_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (role = 'key_manager'),

  -- ── the same person twice is a duplicate, not a second SPOC ──────────────
  --
  -- De-duplication, not policy. A Dept may have two SPOCs; it may not have the
  -- same one twice. `axis_id` is null on key-manager rows, and `=` over a null
  -- never conflicts — which is correct, because the constraint above already
  -- covers those completely.
  CONSTRAINT client_assignment_no_duplicate EXCLUDE USING gist (
    tenant_id       WITH =,
    client_party_id WITH =,
    role            WITH =,
    axis_id         WITH =,
    user_id         WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE TRIGGER trg_client_assignment_updated_at BEFORE UPDATE ON crm.client_assignment
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The client screen's read: one client, every assignment, live and historic. The
-- "as of" filter is applied on top of this rather than indexed for — a client
-- has a handful of these rows over its whole life.
CREATE INDEX idx_client_assignment_client
  ON crm.client_assignment (tenant_id, client_party_id);

-- "My clients". Partial, because the question is almost always about today, and
-- the open rows are a small fraction of a mature table.
CREATE INDEX idx_client_assignment_user_open
  ON crm.client_assignment (tenant_id, user_id)
  WHERE valid_to IS NULL;

ALTER TABLE crm.client_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_assignment_isolation ON crm.client_assignment
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Grants are not repeated: ALTER DEFAULT PRIVILEGES in 0007 already gives
-- bib_app SELECT, INSERT, UPDATE on tables bib_owner creates in `crm`. RLS still
-- applies — bib_app is NOBYPASSRLS and owns nothing. No DELETE, which is the
-- right shape for this table: an assignment is ended, never removed.

RESET ROLE;
