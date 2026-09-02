-- Down for 0071.
--
-- One column and its trigger go, and every firm returns to the behaviour it had
-- before this was applied: the month boundary and the chaser's day arithmetic
-- fall back to the SERVER's zone. That is not a broken state — it is the state
-- the product shipped in from T6.7 to T6.10 — which is what makes this safe to
-- roll back rather than merely possible.
--
-- WHAT IS LOST IS THE FIRM'S ANSWER. A firm that had set `Asia/Kolkata` loses
-- it and gets the server's zone back, silently, and its next digest may re-cut
-- a month by a few hours at the boundary. There is nothing to preserve it into,
-- and inventing a side table to carry one column through a rollback would leave
-- a second home for that fact for ever after — 0070's position on its own
-- assignments, and the same reasoning.
--
-- ── NOTHING HERE CAN FAIL HALFWAY ─────────────────────────────────────────
--
-- 0067's first down dropped its table and only then tried to narrow a CHECK
-- that a published row refused, so the refusal landed AFTER the drops and left
-- the schema in a state neither migration described. The rule that came out of
-- it: anything that can be REFUSED goes FIRST, while nothing has been
-- destroyed.
--
-- This file has nothing that can be refused. It narrows no vocabulary, adds no
-- constraint to existing rows, and drops only objects 0071 created. The trigger
-- goes before the function it calls, and the column last.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_tenant_time_zone_known ON tenancy.tenant;
DROP FUNCTION IF EXISTS tenancy.assert_known_time_zone();

ALTER TABLE tenancy.tenant
  DROP COLUMN IF EXISTS time_zone;

RESET ROLE;
