-- Two things a session table needs and this one did not have: a way to go stale,
-- and a way to be swept.
--
-- ── 1. IDLE TIMEOUT (`last_seen_at`) ────────────────────────────────────────
--
-- A session had one clock: a fourteen-day absolute TTL from the moment it was
-- opened. Nothing else ended it but signing out or an administrator revoking
-- it. So a laptop left open in a co-working space, a browser on a phone that
-- was sold, a session opened on a client's machine to show them something —
-- all of them stayed valid for a fortnight of NOT BEING USED, and nothing in
-- the product could tell the difference between that and somebody who signed in
-- this morning.
--
-- The absolute TTL stays; it answers a different question ("how long may one
-- sign-in last at most"). This adds the second clock — how long a session may
-- sit UNUSED — and the resolver ends the session when the gap is too big.
--
-- It is a column and not a computation because there is nothing to compute
-- from: `issued_at` is when the session began and says nothing about whether
-- anybody has touched it since.
--
-- ── AND WHY IT IS NOT WRITTEN ON EVERY REQUEST ─────────────────────────────
--
-- It would turn every authenticated read into a write, on the hottest row in
-- the system, and the answer would be no more useful for it. The resolver
-- touches it only when the stored value is more than a few minutes old, so the
-- cost is one UPDATE per session per few minutes rather than one per request,
-- and the recorded value is never more stale than that window.
--
-- Existing rows are backfilled from `issued_at`, which is the most recent
-- moment we can honestly claim the session was used — it is when it was
-- created. That means a session already sitting idle for longer than the
-- timeout is ended by this migration, which is the correct answer for it.
--
-- ── 2. THE SWEEP (a DELETE grant) ──────────────────────────────────────────
--
-- `bib_app` held SELECT, INSERT and UPDATE on every table in `tenancy` and no
-- DELETE anywhere, so nothing could ever remove a session or a magic link. They
-- accumulate forever: a spent fifteen-minute token from a year ago is still a
-- row, and so is every expired session of everybody who has ever signed in.
-- Locally, 13 of 32 session rows were already dead.
--
-- This is the ONE place in the schema where a DELETE grant is right, and it is
-- worth saying why, because "append-only, no deletes" is a rule this codebase
-- keeps hard elsewhere. These two tables hold CREDENTIALS, not records. A
-- session row is a live capability; when it expires or is revoked it stops
-- being anything at all. The audit trail of who signed in and when is
-- `ledger.event`'s `session.started`, which has no DELETE grant and never will.
-- So deleting here destroys no history — it destroys spent keys.
--
-- The grant is deliberately narrow: these two tables, not the schema, and no
-- `ALTER DEFAULT PRIVILEGES`, so a table added to `tenancy` tomorrow does not
-- inherit it.
SET ROLE bib_owner;

ALTER TABLE tenancy.session
  ADD COLUMN last_seen_at timestamptz;

UPDATE tenancy.session SET last_seen_at = issued_at WHERE last_seen_at IS NULL;

ALTER TABLE tenancy.session
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN last_seen_at SET DEFAULT now();

COMMENT ON COLUMN tenancy.session.last_seen_at IS
  'When this session was last used, to within a few minutes — the resolver touches it only when the stored value is stale, so an authenticated read is not a write. The IDLE clock; expires_at is the ABSOLUTE one, and a session dies on whichever comes first.';

-- The sweep reads "everything already dead", so it wants the two dead-making
-- columns together. Partial on `revoked_at IS NULL` would be wrong here: a
-- revoked row is exactly one of the things being swept.
CREATE INDEX session_expiry_idx ON tenancy.session (expires_at);

GRANT DELETE ON tenancy.session TO bib_app;
GRANT DELETE ON tenancy.magic_link TO bib_app;

RESET ROLE;
