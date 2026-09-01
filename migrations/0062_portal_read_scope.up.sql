-- 0062 · The first portal READ — the two things a status home is scoped by
--
-- ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
--
-- 0059 built gate 4 and guarded ONE table: `delivery.work_item`, because it is
-- the only business table carrying `client_party_id` directly and because "what
-- is being done for me" is the first thing a portal shows. Its own comment set
-- the rule this migration follows:
--
--   *Every further portal read (invoices, documents, filings) adds its own line
--    here as it lands, and that is deliberate rather than a sweep: the column
--    that names the client differs per table, and a guessed join is a wall with
--    a hole in it.*
--
-- T6.5's status home is the first portal read there has ever been. It answers
-- three questions — what is being done for you, what is waiting on YOU, and
-- what has been filed — over exactly two tables. This migration is the wall
-- under both of them, and it does not touch a third.
--
-- ── ONE: A FILING IS SCOPED BY THE ENTITY, BECAUSE THAT IS WHAT THE ROW SAYS ─
--
-- `delivery.obligation_instance` has NO `client_party_id`. 0053 is explicit
-- about it — *"Whose obligation it is. The ENTITY, never the client."* — because
-- an obligation is what the LAW requires of a company, and the law does not know
-- who pays the firm's bill.
--
-- So the policy is `crm.portal_sees(entity_party_id)`, and the consequence is
-- stated rather than discovered: a contact granted "Cobalt Foods" sees Cobalt
-- Foods' filings and NOT its subsidiary's, even though the subsidiary's TASK is
-- visible to them (that row names Cobalt Foods as its client). Two tables, two
-- columns, two answers — and the alternative was to reach the client by joining
-- `crm.engagement`, which is the exact derivation 0059 refused:
--
--   · `engagement_id` is NULLABLE on this table by design (0053: generation
--     scope is a decision the firm has not been asked), so a join-based rule
--     would silently admit or deny depending on a column that is allowed to be
--     empty. A wall whose answer depends on a nullable join is not a wall.
--   · widening what a contact sees by walking a relationship is what
--     `ACCESS IS GRANTED, NEVER DERIVED` forbids. A group's contact who should
--     see four companies gets four grants — including grants naming the
--     subsidiaries, which `crm.portal_access.client_party_id` points at
--     `core.party` and therefore already permits.
--
-- Confirmed with Shrestha, 2026-09-01: strict, no join.
--
-- ── TWO: `is_client_visible` HAS HAD A WRITER AND NO READER SINCE 0051 ──────
--
-- 0051 created the column with the client's own words on it — *"Clients would be
-- able to see their tasks."* — and said in the same breath: *"Its READER is the
-- client portal (U1); its WRITER is the firm's own screen, today."* The writer
-- shipped (create and patch both take it). Nothing has ever read it. That is
-- the fourth time this codebase has found a registered thing with no reader
-- (`membership.revoked`, `obligation.filed`, the escalation ladder's own
-- comment), and the portal is where it stops.
--
-- IT GOES IN THE POLICY AND NOT ONLY IN THE QUERY, for gate 4's own reason: a
-- portal read that forgets the filter returns an internal review note with a
-- 200 and nothing anywhere says so. It is a SECOND restrictive policy rather
-- than an edit of 0059's, because an applied migration is immutable and because
-- they are genuinely two rules: one says WHOSE records, the other says which of
-- those records the firm meant the client to read. Restrictive policies AND
-- together, so the pair can only ever narrow.
--
-- ── WHAT THIS DELIBERATELY DOES NOT GUARD, AND WHY ─────────────────────────
--
-- The status home JOINS three more tables for NAMES: `core.party` (which
-- company a row is about), `delivery.work_item_state` and
-- `delivery.obligation_state` (the firm's own words for where a row has got
-- to), and `delivery.obligation_template` (what the filing is called). None of
-- them gets a policy here, and both halves of that are deliberate:
--
--   · A NAME TABLE IS NOT SCOPED BY THE THING IT NAMES. A restrictive policy on
--     `core.party` written as `crm.portal_sees(id)` would blank the ENTITY on a
--     row the reader is already allowed to see — the Cobalt Logistics task is
--     admitted by its client, and its entity is a party nobody granted. T4.5
--     shipped exactly that shape (a notice addressed to somebody, rendering a
--     blank space) and this file is not going to reproduce it on purpose.
--   · WHAT CONTAINS THEM IS GATE 2, and 0059 already accepted that as a real
--     defence: a portal session reaches only `PORTAL_PATHS`, and the one portal
--     route that exists selects these tables only as joins hanging off rows the
--     two policies below have already admitted. **A portal route whose SUBJECT
--     is one of them — a party picker, a document library — needs its own line
--     here first**, and that is the whole point of adding them one at a time.
--
-- Documents and invoices are NOT here either. They are T6.6/T6.7's reads and
-- their bytes leave by a route with a path parameter, which gate 2 cannot
-- express today (`PORTAL_PATHS` is an exact-path set). A policy written months
-- before its reader is a policy nobody can check against a query.

SET ROLE bib_owner;

-- ── is this request a portal one? ──────────────────────────────────────────
--
-- `crm.portal_sees()` (0059) asks the same question inline, and the expression
-- is repeated here rather than shared because that function is frozen in an
-- applied migration. Both read `app.portal`, which is set to 'on' ONLY inside
-- `withPortal` (src/db/tenant.ts) — so every staff request answers false, takes
-- the first arm of the policies below, and pays nothing.
--
-- `NULLIF`-free on purpose, unlike the parties list: this compares against a
-- literal and an empty string is simply not 'on'. It is the ARRAY cast that
-- raises on an empty-string GUC, which is why 0059 needed the NULLIF and this
-- does not.
CREATE FUNCTION crm.is_portal_session() RETURNS boolean
  LANGUAGE sql
  STABLE
  AS $$
    SELECT current_setting('app.portal', true) IS NOT DISTINCT FROM 'on';
  $$;

COMMENT ON FUNCTION crm.is_portal_session() IS
  'True inside withPortal only. Set by src/db/tenant.ts; unset for every staff request.';

-- ── the firm decides which tasks a client reads ────────────────────────────
--
-- RESTRICTIVE, so it ANDs with `work_item_isolation` (gate 1) and
-- `work_item_portal_scope` (0059, gate 4). A permissive policy would have OR'd,
-- and OR is how a second policy widens a table somebody meant to narrow.
--
-- WITH CHECK as well as USING, matching 0059: a portal write path does not
-- exist, and this is why it will not have to be built with the rule inside it.
CREATE POLICY work_item_portal_visible ON delivery.work_item AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR is_client_visible)
  WITH CHECK (NOT crm.is_portal_session() OR is_client_visible);

-- ── a client reads the filings of the companies it was granted ─────────────
--
-- The ENTITY, per the argument at the top. `entity_party_id` is NOT NULL on this
-- table (0053), so there is no third state to reason about here — unlike
-- `files.document.party_id`, whose NULL means "the firm's own", and which is a
-- decision waiting for the document library rather than one taken now.
CREATE POLICY obligation_instance_portal_scope ON delivery.obligation_instance AS RESTRICTIVE
  USING      (crm.portal_sees(entity_party_id))
  WITH CHECK (crm.portal_sees(entity_party_id));

RESET ROLE;
