-- 0050 · the firm's own words for work — states and priorities as ROWS (T3.1)
--
-- The first half of T3.1. `delivery.work_item` (0051) hangs off these two, and
-- they arrive first because a work item cannot be created before there is a
-- state to create it in.
--
-- ── WHY ROWS AND NOT A CHECK, WHEN EVERY OTHER STATE IN THIS SCHEMA IS ONE ──
--
-- `delivery.job.status` and `delivery.job_step.status` are CHECK constraints,
-- and both files argue at length that they should be: they are the ENGINE's
-- mechanics, identical at every firm, and a firm renaming `running` would be
-- renaming something it does not own.
--
-- These are the opposite. "Waiting Internal" is the firm's OWN vocabulary, it
-- came from a previous vendor's list of seven, and asked about it the client
-- said to get the system working and settle the naming later. That answer costs
-- nothing precisely because this is a table: renaming a state, adding a ninth,
-- or dropping one the firm never uses is an UPDATE and no board, filter or
-- report changes.
--
-- ── THE FLAGS ARE THE WHOLE DESIGN, AND THEY EXIST FOR ONE REASON ──────────
--
-- Rows buy the firm its vocabulary and immediately take something away: a
-- CHECK constraint cannot say "a blocked item owes a reason", because the
-- constraint cannot see a word in another table. The naive fix is for code to
-- compare `code = 'blocked'` — and that hardcodes the very name the firm was
-- promised it could change. The first rename would silently turn the rule off.
--
-- So MEANING lives in booleans and NAMES live in text. Code reads the flags and
-- never the codes; the firm owns every name and every flag, from the screen,
-- with no deploy:
--
--   is_initial   what a new work item starts in            (at most one)
--   is_terminal  nothing further happens; `completed_at` is set
--   is_blocked   the work is STUCK, and `blocked_reason` + `blocked_at`
--                become mandatory (enforced by trigger in 0051)
--
-- The seed flags only `blocked` as blocking. `waiting_client` and
-- `waiting_internal` are arguably stuck too — but "Waiting for Client" already
-- says whose fault the delay is, which is most of what the reason field is for,
-- and a firm that wants the prose as well ticks the box itself. That is the
-- configurability being real rather than advertised.
--
-- Priority carries the same idea:
--
--   rank                  1 = most urgent. What code COMPARES. Never displayed.
--   is_default            what ordinary work gets                (at most one)
--   is_statutory_default  what statutory work gets               (at most one)
--
-- `is_statutory_default` is the firm's own rule made mechanical — *"due dates
-- that are statutory should anyway be high priority"*. Deriving it is the
-- point: a priority field a human sets on every task is a field that is wrong
-- on most of them. And it is a FLAG rather than the constant `'high'` for the
-- reason above — a firm that decides statutory work is Critical moves a tick.
--
-- ── "AT MOST ONE", NOT "EXACTLY ONE", AND THE GAP IS STATED ────────────────
--
-- The partial unique indexes below enforce at most one initial state, one
-- default priority and one statutory-default priority per firm. They cannot
-- enforce AT LEAST one: that is a constraint over the absence of rows, which
-- needs either a deferred assertion Postgres does not have or a trigger that
-- fires on every delete of every row. So the service refuses to clear the last
-- one (`WorkVocabularyService`), and the seed guarantees a firm starts with
-- all three. A firm that reaches zero through SQL gets a refusal from the
-- service at creation time, naming which flag is missing — not a 500.
--
-- ── RETIRED, NEVER DELETED ─────────────────────────────────────────────────
--
-- `is_active`, exactly as `staff_grade` and `service_axis` have it, and for the
-- same reason: `deleted_at` says the row was a MISTAKE, `is_active` says the
-- firm has MOVED ON. Work items sitting in a retired state still read; the
-- state simply stops being offered. A DELETE would take a hundred work items'
-- state with it, so there is no DELETE grant on either table.

SET ROLE bib_owner;

-- ── the states a work item moves through ───────────────────────────────────
CREATE TABLE delivery.work_item_state (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- The firm's stable handle, scoped to the firm. Two firms may both have a
  -- `blocked` meaning different things. Code never reads it — see the flags.
  code        text NOT NULL,
  -- What a person reads. The half the firm is expected to change.
  name        text NOT NULL,

  is_initial  boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  is_blocked  boolean NOT NULL DEFAULT false,

  -- The order a board renders its columns in. Not unique and not contiguous,
  -- for `staff_grade.rank`'s reason: nothing compares within it, so uniqueness
  -- would turn "insert a state between two others" into a renumbering.
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_state_code_key UNIQUE (tenant_id, code),
  -- The composite-key target. `work_item.state_id` points at BOTH columns, so
  -- one firm's work item cannot hang off another firm's state — a foreign-key
  -- check runs as a system operation RLS does not filter.
  CONSTRAINT work_item_state_id_tenant_key UNIQUE (id, tenant_id),

  -- The three flag pairs that cannot both be true. Written as constraints
  -- rather than trusted to the admin screen, because each one turns a rule off
  -- somewhere else: a terminal state that is also blocked would demand a
  -- `blocked_reason` on finished work and set `completed_at` on stuck work at
  -- the same time, and 0051's trigger would refuse every write in that state
  -- with a message about a field the admin never saw.
  CONSTRAINT work_item_state_terminal_is_not_blocked CHECK (NOT (is_terminal AND is_blocked)),
  CONSTRAINT work_item_state_initial_is_not_terminal CHECK (NOT (is_initial AND is_terminal)),
  CONSTRAINT work_item_state_initial_is_not_blocked  CHECK (NOT (is_initial AND is_blocked)),

  -- A state nothing may be created in and nothing may sit in is a row with no
  -- purpose, and retiring the initial state would leave new work with nowhere
  -- to start. Refused here rather than discovered at the next creation.
  CONSTRAINT work_item_state_initial_is_active CHECK (is_active OR NOT is_initial)
);

CREATE TRIGGER trg_work_item_state_updated_at BEFORE UPDATE ON delivery.work_item_state
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- AT MOST ONE starting state per firm. Two would make "what state is a new
-- filing in" a coin toss decided by whatever the query returned first.
CREATE UNIQUE INDEX idx_work_item_state_one_initial
  ON delivery.work_item_state (tenant_id) WHERE is_initial;

-- The board's own read: this firm's states, in the order it arranged them.
CREATE INDEX idx_work_item_state_order
  ON delivery.work_item_state (tenant_id, sort_order);

ALTER TABLE delivery.work_item_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_state_isolation ON delivery.work_item_state
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── how urgent it is ───────────────────────────────────────────────────────
CREATE TABLE delivery.work_item_priority (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),

  code       text NOT NULL,
  name       text NOT NULL,

  -- 1 = MOST urgent. The opposite direction from `staff_grade.rank`, where 1 is
  -- the most junior, and that is not an inconsistency to tidy: both read the
  -- way the firm says them out loud — "P1" is the urgent one and "Analyst" is
  -- the first rung. Stated here because the two are compared in the same
  -- codebase and the next person will assume they agree.
  rank       integer NOT NULL CHECK (rank > 0),

  is_default           boolean NOT NULL DEFAULT false,
  is_statutory_default boolean NOT NULL DEFAULT false,

  is_active  boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_priority_code_key UNIQUE (tenant_id, code),
  CONSTRAINT work_item_priority_id_tenant_key UNIQUE (id, tenant_id),

  -- A priority that new work is defaulted to cannot be one the firm has
  -- retired: the next work item created would be refused by the FK's own
  -- referent being unusable, with nothing on screen saying why.
  CONSTRAINT work_item_priority_default_is_active
    CHECK (is_active OR NOT (is_default OR is_statutory_default))
);

CREATE TRIGGER trg_work_item_priority_updated_at BEFORE UPDATE ON delivery.work_item_priority
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- One answer each to "what does ordinary work get" and "what does statutory
-- work get". They may be the SAME row — a firm that does not want statutory
-- work treated differently ticks both on one priority, which is a real setting
-- and not a mistake, so this is two partial indexes and not one.
CREATE UNIQUE INDEX idx_work_item_priority_one_default
  ON delivery.work_item_priority (tenant_id) WHERE is_default;
CREATE UNIQUE INDEX idx_work_item_priority_one_statutory_default
  ON delivery.work_item_priority (tenant_id) WHERE is_statutory_default;

CREATE INDEX idx_work_item_priority_rank
  ON delivery.work_item_priority (tenant_id, rank);

ALTER TABLE delivery.work_item_priority ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_priority_isolation ON delivery.work_item_priority
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- SELECT, INSERT, UPDATE — never DELETE, inherited from 0041's ALTER DEFAULT
-- PRIVILEGES on this schema. Retiring is `is_active`; see the note at the top.

-- ── the firms that existed before this migration ───────────────────────────
--
-- Exactly what `createTenant` will write for a new firm from now on, backfilled
-- for the ones already here — the same arrangement 0040 has for the grade
-- ladder, and `tests/workitem/seed-parity.test.ts` fails the build if this list
-- and `DEFAULT_WORK_ITEM_STATES` ever drift.
--
-- The names are the previous vendor's vocabulary carried across the rebuild and
-- are STILL UNCONFIRMED, including for 10x itself. That is recorded rather than
-- hidden, and it is the reason these are rows: confirming them is an UPDATE
-- somebody makes on a screen, not a migration somebody asks an engineer for.
INSERT INTO delivery.work_item_state
  (tenant_id, code, name, is_initial, is_terminal, is_blocked, sort_order)
SELECT t.id, s."code", s."name", s."isInitial", s."isTerminal", s."isBlocked", s."sortOrder"
FROM tenancy.tenant t
-- The literal stays on ONE line, opening with a quote and closing with '::jsonb.
-- That shape is what tests/workitem/seed-parity.test.ts parses, and the marker
-- is what binds it to DEFAULT_WORK_ITEM_STATES — the same arrangement 0040 has
-- for the grade ladder, and for the same reason: SQL cannot import TypeScript,
-- so the duplication is unavoidable and the DRIFT is what the test prevents.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"not_started","name":"Not Started","isInitial":true,"isTerminal":false,"isBlocked":false,"sortOrder":10},{"code":"in_progress","name":"In Progress","isInitial":false,"isTerminal":false,"isBlocked":false,"sortOrder":20},{"code":"waiting_client","name":"Waiting for Client","isInitial":false,"isTerminal":false,"isBlocked":false,"sortOrder":30},{"code":"waiting_internal","name":"Waiting Internal","isInitial":false,"isTerminal":false,"isBlocked":false,"sortOrder":40},{"code":"under_review","name":"Under Review","isInitial":false,"isTerminal":false,"isBlocked":false,"sortOrder":50},{"code":"blocked","name":"Blocked","isInitial":false,"isTerminal":false,"isBlocked":true,"sortOrder":60},{"code":"completed","name":"Completed","isInitial":false,"isTerminal":true,"isBlocked":false,"sortOrder":70},{"code":"cancelled","name":"Cancelled","isInitial":false,"isTerminal":true,"isBlocked":false,"sortOrder":80}]'::jsonb) -- @default-work-item-states-seed
  AS s("code" text, "name" text, "isInitial" boolean, "isTerminal" boolean,
       "isBlocked" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO delivery.work_item_priority
  (tenant_id, code, name, rank, is_default, is_statutory_default)
SELECT t.id, p."code", p."name", p."rank", p."isDefault", p."isStatutoryDefault"
FROM tenancy.tenant t
-- Statutory work lands on High by default. The firm's own rule, and one tick
-- away from Critical the day it decides otherwise.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"critical","name":"Critical","rank":1,"isDefault":false,"isStatutoryDefault":false},{"code":"high","name":"High","rank":2,"isDefault":false,"isStatutoryDefault":true},{"code":"medium","name":"Medium","rank":3,"isDefault":true,"isStatutoryDefault":false},{"code":"low","name":"Low","rank":4,"isDefault":false,"isStatutoryDefault":false}]'::jsonb) -- @default-work-item-priorities-seed
  AS p("code" text, "name" text, "rank" integer, "isDefault" boolean,
       "isStatutoryDefault" boolean)
ON CONFLICT (tenant_id, code) DO NOTHING;

RESET ROLE;
