-- 0059 · Gate 4 — which records a CLIENT PORTAL session may see
--
-- ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
--
-- CLAUDE.md names four scoping gates every read answers to: (1) tenant [RLS],
-- (2) audience [STAFF | CLIENT_PORTAL], (3) role, (4) record-scope. One to three
-- have been built since Phase 1. THIS IS GATE 4, and until now the only reason
-- no client could read another client's records is that a portal session can
-- reach exactly four routes (`PORTAL_PATHS` in `api/guards.ts`) and none of them
-- returns a business record. That is a gate made of "there is nothing here yet",
-- which stops being true the first time U1 adds a read.
--
-- So the wall goes in BEFORE the screens, and this is the whole reason G3.4 is
-- the first task of Phase 6 rather than a step inside T6.5: a portal read
-- written against no gate has to be written twice, and the second version is
-- the one nobody reviews.
--
-- ── TWO THINGS, AND THEY ANSWER DIFFERENT QUESTIONS ─────────────────────────
--
--   · `membership.party_id`  — WHICH PERSON this login is.
--   · `crm.portal_access`    — WHICH COMPANIES that login may read.
--
-- They are not the same fact and must not be collapsed into one. A person is
-- one party; the companies they act for are none, one, or several — a director
-- of four group companies, an outsourced CFO acting for two unrelated clients,
-- a founder who is also a person the firm holds records about. Deriving the
-- second from the first is the mistake the next section is about.
--
-- `party_id` is also the half that has nothing to do with the portal: most of a
-- firm has a place in its org chart and NO LOGIN AT ALL, and until this column
-- exists the chart can only contain the people who happen to sign in. It is
-- nullable in both directions for exactly that reason — a portal user is not
-- staff, and a colleague need not be a party.
--
-- ── ACCESS IS GRANTED, NEVER DERIVED. THIS IS THE DECISION. ─────────────────
--
-- `core.party_relationship` already records that one company is a subsidiary of
-- another, that a person is a director of a company, that four companies are one
-- group. Reading portal access out of that graph is one join and it is wrong:
--
--   · The screen that writes relationships is the CRM screen. Somebody
--     recording "Cobalt Foods is part of the Kaveri group" is describing the
--     world, not granting access — and under a derived rule that keystroke
--     silently hands a Cobalt contact the Kaveri group's filings. Nobody
--     reviews a CRM edit as an access-control change, because it is not one.
--   · A relationship has no reviewer, no effective date the firm chose for THIS
--     purpose, and no audit event that says "we let this person in".
--   · G0.1 is on record that a group of four companies files four sets of
--     returns. Whether one contact should see all four is a fact about the
--     ENGAGEMENT the firm has, and the firm has never been asked. Deriving it
--     would answer that question in a join.
--
-- So access is a ROW somebody wrote, per company, and a group's contact who
-- should see four companies gets four rows. Shrestha's call (2026-09-01): there
-- is deliberately NO default and no widening — the same shape as the escalation
-- ladder, where a firm that has published nothing escalates to nobody. Widening
-- later is an INSERT; narrowing later takes access away from somebody who has
-- been using it, and somebody then has to decide who.
--
-- ── EFFECTIVE-DATED, HALF-OPEN — 0049's SHAPE, DELIBERATELY ────────────────
--
-- `[valid_from, valid_to)`, `valid_to` the first day NOT in force, exactly as
-- `crm.client_assignment`, `core.party_relationship` and `core.party_identifier`
-- have it. Two date conventions in one schema is an off-by-one waiting for a
-- handover. A CFO who left in March must stop seeing the books in March, and
-- "could this person see this company on 14 March" has to be answerable a year
-- later — access revoked by DELETE answers it with silence.
--
-- ── THE ENFORCEMENT IS RLS, NOT A `WHERE` IN A HANDLER ──────────────────────
--
-- Gate 1's argument applies unchanged and is the reason this is not application
-- code: a leak here is SILENT. A handler that forgets the filter returns another
-- client's filings with a 200 and nothing anywhere says so. So the predicate is
-- one function used by RESTRICTIVE policies, and a restrictive policy ANDs with
-- the tenant policy already on the table — it can only ever narrow.
--
-- `crm.portal_sees()` is written so a STAFF session is unaffected: `app.portal`
-- is unset for every staff request, the first clause is true, and the policy
-- costs nothing. A portal session sets it, and then only the granted parties
-- pass. A portal session with no grants sets an EMPTY list and sees nothing,
-- which is the correct answer and is why "unset" and "empty" must not be the
-- same value — that distinction is the whole safety of this function.

SET ROLE bib_owner;

-- ── the login → person link ────────────────────────────────────────────────

ALTER TABLE tenancy.membership
  ADD COLUMN party_id uuid;

-- Composite, like every tenant-scoped reference in this schema. A foreign-key
-- check runs as a SYSTEM operation that RLS does not filter, so an id-only
-- reference would let one firm's membership point at another firm's party with
-- every policy satisfied. See 0015 for the full argument.
ALTER TABLE tenancy.membership
  ADD CONSTRAINT membership_party_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- So `crm.portal_access` below can point at a membership the same composite
-- way. `membership` has carried only a bare PRIMARY KEY until now because
-- nothing tenant-scoped referenced it.
ALTER TABLE tenancy.membership
  ADD CONSTRAINT membership_id_tenant_key UNIQUE (id, tenant_id);

-- One person, one login, per firm and audience. A second membership pointing at
-- the same party in the same audience is two logins for one human, which is the
-- shape an attacker gets by being invited twice and the shape support gets when
-- somebody's email changes. STAFF and CLIENT_PORTAL are deliberately separate
-- rows, so the audience is in the key: a founder who is both a colleague and a
-- portal contact of their own company is real.
CREATE UNIQUE INDEX membership_party_audience_key
  ON tenancy.membership (tenant_id, party_id, audience)
  WHERE party_id IS NOT NULL;

-- ── which companies a portal login may read ────────────────────────────────

CREATE TABLE crm.portal_access (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- The MEMBERSHIP, not the user account. Access is granted at one firm, to one
  -- audience: the same human may hold a portal login at two firms (ADR-02 —
  -- identity is above tenant) and what they may see at each is a separate
  -- decision by a separate firm. Keying on `user_id` would make one firm's
  -- grant readable as another's.
  membership_id   uuid NOT NULL,

  -- The CLIENT, not the entity. A group's contact who should see four companies
  -- gets four rows — see the note above on why that is not derived.
  client_party_id uuid NOT NULL,

  -- Half-open: valid_to is the FIRST DAY NOT IN FORCE. Null = still in force.
  valid_from      date NOT NULL,
  valid_to        date,

  -- WHO let them in. Access granted by "the system" cannot be reviewed, and
  -- this is the one table in the schema where that question is asked after
  -- something has gone wrong. By id alone, like every actor reference here:
  -- `tenancy.user_account` is not tenant-scoped, so there is no composite to
  -- point at.
  granted_by      uuid NOT NULL REFERENCES tenancy.user_account(id),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- ── the tenant wall ──────────────────────────────────────────────────────
  CONSTRAINT portal_access_membership_fkey
    FOREIGN KEY (membership_id, tenant_id) REFERENCES tenancy.membership (id, tenant_id),
  CONSTRAINT portal_access_client_fkey
    FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id),

  CONSTRAINT portal_access_id_tenant_key UNIQUE (id, tenant_id),

  -- Half-open, so an empty range is a grant that is in force on no day at all.
  CONSTRAINT portal_access_dates_ordered CHECK (
    valid_to IS NULL OR valid_to > valid_from
  ),

  -- The same login granted the same company twice over the same days is a
  -- duplicate — a double-click, a re-invite, a handover recorded twice — and it
  -- would make "who could see this in March" answer with the same person twice.
  -- Ranges compared AS RANGES, not a partial index over open rows: two CLOSED
  -- grants overlapping in March slip past that, and March is exactly when
  -- somebody asks.
  CONSTRAINT portal_access_no_duplicate EXCLUDE USING gist (
    tenant_id       WITH =,
    membership_id   WITH =,
    client_party_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE TRIGGER trg_portal_access_updated_at BEFORE UPDATE ON crm.portal_access
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The session's own read: "what may I see today", asked once per portal
-- request. Partial, because that question is always about today.
CREATE INDEX idx_portal_access_membership_open
  ON crm.portal_access (tenant_id, membership_id)
  WHERE valid_to IS NULL;

-- The firm's read: "who can see this client", which is the question asked when
-- a client rings up about somebody who should no longer have access.
CREATE INDEX idx_portal_access_client
  ON crm.portal_access (tenant_id, client_party_id);

ALTER TABLE crm.portal_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_access_isolation ON crm.portal_access
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── the predicate, written once ────────────────────────────────────────────
--
-- `app.portal` is 'on' only inside `withPortal` (src/db/tenant.ts), which is the
-- only way a portal request reaches the database. Unset — every staff request —
-- and this is true, so the restrictive policies below cost a staff session
-- nothing and can never narrow it by accident.
--
-- `NULLIF(..., '')` is load-bearing for 0001's reason, restated because it bites
-- differently here: under pooling a custom GUC that has been touched once leaves
-- an EMPTY STRING placeholder rather than NULL on that connection. Without the
-- NULLIF, `''::uuid[]` raises rather than denying — and an error is not a
-- refusal, it is a 500 that somebody will "fix" by loosening the policy.
--
-- A portal session holding no grants therefore produces `= ANY(NULL)`, which is
-- NULL, which is not true, which is zero rows. Denied by default, exactly like
-- the tenant wall above it.
CREATE FUNCTION crm.portal_sees(client_party uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$
    SELECT current_setting('app.portal', true) IS DISTINCT FROM 'on'
        OR client_party = ANY (
             string_to_array(NULLIF(current_setting('app.portal_parties', true), ''), ',')::uuid[]
           );
  $$;

-- ── the first table it guards ──────────────────────────────────────────────
--
-- RESTRICTIVE, so it ANDs with `work_item_isolation` rather than replacing it:
-- a permissive policy would have OR'd, and OR is how a second policy WIDENS a
-- table somebody meant to narrow.
--
-- `delivery.work_item` is first because it is the one business table that
-- carries `client_party_id` directly, so the predicate needs no join — and
-- because "what is being done for me" is the first thing a portal shows.
-- Every further portal read (invoices, documents, filings) adds its own line
-- here as it lands, and that is deliberate rather than a sweep: the column that
-- names the client differs per table, and a guessed join is a wall with a hole
-- in it. Until then those tables are unreachable by gate 2 — a portal session
-- reaches only PORTAL_PATHS — which is a real defence and not a permanent one.
CREATE POLICY work_item_portal_scope ON delivery.work_item AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (crm.portal_sees(client_party_id));

RESET ROLE;
