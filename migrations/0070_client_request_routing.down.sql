-- Down for 0070.
--
-- Two columns go and the requests stay. That is the honest shape of rolling
-- this one back: 0068's inbox works without any of it — `none` is what every
-- firm is on by default and it reproduces exactly the behaviour this migration
-- was added on top of — so dropping these leaves a working, unrouted inbox
-- rather than a broken one.
--
-- WHAT IS LOST IS WHO WAS HOLDING WHAT, and it is worth naming rather than
-- discovering: every assignment made while this was applied disappears, and so
-- does every note explaining why the rule could not place a request. There is
-- nothing to preserve them into — a column that no longer exists cannot be
-- archived somewhere else — and inventing a side table to hold them through a
-- rollback would be a second place for that fact to live for ever after.
--
-- ── NOTHING HERE CAN FAIL HALFWAY ─────────────────────────────────────────
--
-- 0067's first down dropped its table and only then tried to narrow a CHECK a
-- published row refused, so the refusal landed AFTER the drops and left the
-- schema in a state neither migration described. The rule that came out of it:
-- anything that can be REFUSED goes first, while nothing has been destroyed.
--
-- This file has nothing that can be refused. It narrows no vocabulary, adds no
-- constraint to existing rows, and drops only objects it created — the indexes
-- and constraints go with their columns, and `ALTER TABLE ... DROP COLUMN`
-- cannot be refused by data. The `tenancy.tenant` column carries a DEFAULT, so
-- there is no NOT NULL to backfill on the way back up either.

SET ROLE bib_owner;

-- The trigger first: it reads the columns below and would be left naming ones
-- that no longer exist. Dropping the function too, because it is this
-- migration's and nothing else calls it.
DROP TRIGGER IF EXISTS trg_client_request_portal_assignee ON delivery.client_request;
DROP FUNCTION IF EXISTS delivery.refuse_portal_assignee_change();

ALTER TABLE tenancy.tenant
  DROP CONSTRAINT IF EXISTS tenant_client_request_routing_chk;
ALTER TABLE tenancy.tenant
  DROP COLUMN IF EXISTS client_request_routing;

-- The indexes and the two CHECKs are dropped by the columns going.
ALTER TABLE delivery.client_request
  DROP COLUMN IF EXISTS assignment_note;
ALTER TABLE delivery.client_request
  DROP COLUMN IF EXISTS assignee_user_id;

RESET ROLE;
