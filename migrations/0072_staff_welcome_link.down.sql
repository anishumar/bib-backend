-- Down for 0072.
--
-- ── WHAT CAN BE REFUSED GOES FIRST ─────────────────────────────────────────
--
-- This down NARROWS a vocabulary, which is the shape 0067 got wrong: it dropped
-- first and only then tried to tighten a CHECK that existing rows refused, so
-- the failure landed after the destruction. Here the rows go first, and if that
-- fails nothing has been altered.
--
-- ── AND THE ROWS ARE DELETED, NOT RETYPED ──────────────────────────────────
--
-- A `welcome` row is a CREDENTIAL, not a record. Rolling this back removes the
-- code that accepts one, so every unconsumed row here is already dead — and a
-- consumed one is a spent token whose meaning ("we let this person in, then")
-- is carried by the ledger's `session.started`, which is the audit trail and is
-- untouched by any of this.
--
-- The alternative was rewriting them to `login`, and that is worse than losing
-- them: it would put a 72-hour link into the data as if it had been a 15-minute
-- one, and anybody reading the table afterwards would have no way to tell.
SET ROLE bib_owner;

DELETE FROM tenancy.magic_link WHERE purpose = 'welcome';

ALTER TABLE tenancy.magic_link
  DROP CONSTRAINT magic_link_purpose_check;

ALTER TABLE tenancy.magic_link
  ADD CONSTRAINT magic_link_purpose_check
  CHECK (purpose IN ('login', 'invite'));

COMMENT ON COLUMN tenancy.magic_link.purpose IS NULL;

RESET ROLE;
