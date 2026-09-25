-- Down for 0082.
--
-- ── WHAT CAN BE REFUSED GOES FIRST ─────────────────────────────────────────
--
-- The same order 0072's down uses, for the same reason: this NARROWS a
-- vocabulary, so the rows that the narrower CHECK would refuse go before the
-- constraint is touched. If that fails, nothing has been altered.
--
-- ── AND THE ROWS ARE DELETED, NOT RETYPED ──────────────────────────────────
--
-- A `reset` row is a CREDENTIAL, not a record. Rolling this back removes the
-- code that accepts one, so every unconsumed row here is already dead — and a
-- consumed one is a spent token whose meaning ("this person replaced their
-- password, then") is carried by the ledger's `session.started` for the session
-- that came out of it, which is untouched by any of this.
--
-- Retyping them to `login` would be worse than losing them: it would put a
-- password-setting link into the data as if it had been a sign-in one, and
-- nobody reading the table afterwards could tell.
SET ROLE bib_owner;

DELETE FROM tenancy.magic_link WHERE purpose = 'reset';

ALTER TABLE tenancy.magic_link
  DROP CONSTRAINT magic_link_purpose_check;

ALTER TABLE tenancy.magic_link
  ADD CONSTRAINT magic_link_purpose_check
  CHECK (purpose IN ('login', 'invite', 'welcome'));

COMMENT ON COLUMN tenancy.magic_link.purpose IS
  'Which door this link opens. `login` is pulled by the account holder and lives minutes; `welcome` is pushed to a new colleague and lives 72 hours, and both redeem into a session. `invite` is the client portal''s, redeems ONLY by setting a password, and never opens a session on its own.';

RESET ROLE;
