-- 0054 · what "finished" means, on both sides of the join (T3.2's open half)
--
-- T3.2 shipped a calendar whose rows can never leave the state they were
-- generated in. `filed_on` was READ in four places and written in none, so every
-- row said "Pending" forever, `/calendar`'s "include filed and resolved"
-- checkbox could not change what it returned, and `obligation.filed` was a
-- registered verb with no writer. This migration adds the two facts that were
-- missing, and neither of them is the one that task's own note assumed.
--
-- ── WHY "TERMINAL" IS NOT THE ANSWER, ON EITHER SIDE ───────────────────────
--
-- The obvious rule is "the work item reached a terminal state, so the
-- obligation is filed". Both halves of that sentence are ambiguous, and both
-- resolve the wrong way if left alone.
--
-- 0050 seeds TWO terminal work item states: `completed` and `cancelled`. A task
-- is cancelled for ordinary reasons — the client left, the entity was
-- deregistered, somebody raised it twice. Reading `is_terminal` alone would
-- record that a statutory return was FILED because a person tidied up their
-- board. That is not a missing feature, it is a false statement about a filing,
-- and it is worse than the "Pending forever" it would have replaced.
--
-- 0052 seeds TWO terminal obligation states: `filed` and `resolved`. `resolved`
-- is T3.3's — where a partner decides what happens about a deadline already
-- missed. Landing a finished filing there would put work nobody has to decide
-- anything about into the decision queue.
--
-- So each side gains ONE flag naming the case it actually means:
--
--   work_item_state.is_success   reaching this state means the work was DONE,
--                                not abandoned
--   obligation_state.is_filed    an obligation whose work is done lands HERE
--
-- ── FLAGS, BECAUSE NOTHING IN THIS MODULE MAY COMPARE A `code` ─────────────
--
-- 0050 and 0052 both hold these vocabularies as ROWS so a firm can rename them
-- from a screen, and the rule that makes that promise real is that no rule ever
-- compares `code`. The demo looked states up by the literals 'pending' and
-- 'in_progress', which is why its first rename would have switched the rule off
-- in silence. `is_filed` survives a firm renaming Filed to "Submitted";
-- `code = 'filed'` would not.
--
-- ── BOTH DEFAULT TO FALSE, DELIBERATELY ────────────────────────────────────
--
-- A firm that adds its own terminal state gets `false` until somebody says
-- otherwise. That direction is chosen: the failure is an obligation that stays
-- open when it should have closed — visible, on the calendar, in front of the
-- person who can fix it. `true` would have failed the other way, marking
-- filings that never happened, silently, on the rows that matter most.
--
-- The CHECKs say the rest: a state that is not terminal can be neither, because
-- neither flag means anything about work that is still running.

SET ROLE bib_owner;

-- ── the work board's half ──────────────────────────────────────────────────

ALTER TABLE delivery.work_item_state
  ADD COLUMN is_success boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.work_item_state.is_success IS
  'Reaching this state means the work was actually done, not abandoned. Only meaningful on a terminal state, and what tells a completion from a cancellation without comparing the state code.';

ALTER TABLE delivery.work_item_state
  ADD CONSTRAINT work_item_state_success_chk CHECK (NOT (is_success AND NOT is_terminal));

-- ── the calendar's half ───────────────────────────────────────────────────

ALTER TABLE delivery.obligation_state
  ADD COLUMN is_filed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.obligation_state.is_filed IS
  'Where an obligation lands when the work that discharges it is finished. Distinct from the other terminal state, which is T3.3 resolving a deadline already missed.';

ALTER TABLE delivery.obligation_state
  ADD CONSTRAINT obligation_state_filed_chk CHECK (NOT (is_filed AND NOT is_terminal));

-- AT MOST ONE per firm, 0052's partial-unique trick again and for the same
-- reason: with two, "where does a finished filing go" is a coin toss. Postgres
-- cannot enforce at least one; the seeds below and the parity tests are what
-- guarantee the floor.
CREATE UNIQUE INDEX idx_obligation_state_one_filed
  ON delivery.obligation_state (tenant_id) WHERE is_filed;

-- ── bringing every firm that already exists forward ───────────────────────
--
-- `ON CONFLICT … DO UPDATE`, touching the NEW column only. Every firm already
-- has these rows from 0050 and 0052, so in practice this is an UPDATE that
-- matches on the stable handle; the INSERT half is what makes it correct for a
-- firm that somehow lacks one. `name` and `sort_order` are deliberately NOT
-- overwritten — a firm may already have renamed or reordered its own
-- vocabulary, and this migration has no business undoing that.
--
-- Matching by `code` HERE is not the thing the rest of the codebase forbids.
-- This is a one-time data migration reading the seed it wrote itself; the ban
-- is on RULES that compare a code at run time, and from here on the rules read
-- the flags.

INSERT INTO delivery.work_item_state
  (tenant_id, code, name, is_initial, is_terminal, is_blocked, is_success, sort_order)
SELECT t.id, s."code", s."name", s."isInitial", s."isTerminal", s."isBlocked", s."isSuccess", s."sortOrder"
FROM tenancy.tenant t
-- The literal stays on ONE line, opening with a quote and closing with '::jsonb —
-- that shape is what tests/workitem/seed-parity.test.ts parses, and it reads the
-- NEWEST migration carrying the marker, which is now this one.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"not_started","name":"Not Started","isInitial":true,"isTerminal":false,"isBlocked":false,"isSuccess":false,"sortOrder":10},{"code":"in_progress","name":"In Progress","isInitial":false,"isTerminal":false,"isBlocked":false,"isSuccess":false,"sortOrder":20},{"code":"waiting_client","name":"Waiting for Client","isInitial":false,"isTerminal":false,"isBlocked":false,"isSuccess":false,"sortOrder":30},{"code":"waiting_internal","name":"Waiting Internal","isInitial":false,"isTerminal":false,"isBlocked":false,"isSuccess":false,"sortOrder":40},{"code":"under_review","name":"Under Review","isInitial":false,"isTerminal":false,"isBlocked":false,"isSuccess":false,"sortOrder":50},{"code":"blocked","name":"Blocked","isInitial":false,"isTerminal":false,"isBlocked":true,"isSuccess":false,"sortOrder":60},{"code":"completed","name":"Completed","isInitial":false,"isTerminal":true,"isBlocked":false,"isSuccess":true,"sortOrder":70},{"code":"cancelled","name":"Cancelled","isInitial":false,"isTerminal":true,"isBlocked":false,"isSuccess":false,"sortOrder":80}]'::jsonb) -- @default-work-item-states-seed
  AS s("code" text, "name" text, "isInitial" boolean, "isTerminal" boolean,
       "isBlocked" boolean, "isSuccess" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO UPDATE SET is_success = EXCLUDED.is_success;

INSERT INTO delivery.obligation_state
  (tenant_id, code, name, is_initial, is_terminal, needs_decision, is_filed, sort_order)
SELECT t.id, s."code", s."name", s."isInitial", s."isTerminal", s."needsDecision", s."isFiled", s."sortOrder"
FROM tenancy.tenant t
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"pending","name":"Pending","isInitial":true,"isTerminal":false,"needsDecision":false,"isFiled":false,"sortOrder":10},{"code":"in_progress","name":"In Progress","isInitial":false,"isTerminal":false,"needsDecision":false,"isFiled":false,"sortOrder":20},{"code":"filed","name":"Filed","isInitial":false,"isTerminal":true,"needsDecision":false,"isFiled":true,"sortOrder":30},{"code":"missed","name":"Missed","isInitial":false,"isTerminal":false,"needsDecision":true,"isFiled":false,"sortOrder":40},{"code":"resolved","name":"Resolved","isInitial":false,"isTerminal":true,"needsDecision":false,"isFiled":false,"sortOrder":50}]'::jsonb) -- @default-obligation-states-seed
  AS s("code" text, "name" text, "isInitial" boolean, "isTerminal" boolean,
       "needsDecision" boolean, "isFiled" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO UPDATE SET is_filed = EXCLUDED.is_filed;

-- ── the obligations whose work was already finished ───────────────────────
--
-- Rows that reached a done work item BEFORE anything could write `filed_on`.
-- Left alone they would read "Pending" forever with nothing able to move them,
-- because the push path added by this change only ever fires on a FUTURE
-- transition. History is corrected here rather than by a sweep, so the running
-- system has exactly one writer.
--
-- No ledger event is written for these. A backfill is a data correction and did
-- not happen on the day it claims; `work_item.completed` already carries when
-- the work was actually finished, and inventing `obligation.filed` rows dated
-- today would put a fiction in the one log that cannot be edited.
UPDATE delivery.obligation_instance oi
SET filed_on = (wi.completed_at AT TIME ZONE 'UTC')::date,
    state_id = fs.id
FROM delivery.work_item wi
JOIN delivery.work_item_state ws ON ws.id = wi.state_id AND ws.tenant_id = wi.tenant_id
JOIN delivery.obligation_state fs ON fs.tenant_id = wi.tenant_id AND fs.is_filed
WHERE oi.work_item_id = wi.id
  AND oi.tenant_id = wi.tenant_id
  AND ws.is_terminal AND ws.is_success
  AND wi.completed_at IS NOT NULL
  AND oi.filed_on IS NULL;

RESET ROLE;
