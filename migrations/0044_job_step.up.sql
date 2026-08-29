-- 0044 · the steps a job actually walks, and `workflow_template` joining the
--        configuration registry (T2.7)
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- T2.6 gave a signed engagement a JOB — a row saying "this work is owed". It
-- says nothing about what the work IS. That knowledge lives in a partner's head
-- and in spreadsheets, which is what this task is here to end: get the process
-- into the product, standardised, so a new joiner reads it instead of being
-- taught it and so a skipped step is visible instead of silent.
--
-- ── THE TEMPLATE IS CONFIG; THE WALK IS THESE ROWS ──────────────────────────
--
-- `config.entry` gains its sixth kind, `workflow_template`, deferred at T2.5 on
-- the stated grounds that a body designed against no consumer ends up wrong.
-- The consumer is the orchestrator, and it exists now.
--
-- The template says what the firm DOES. `delivery.job_step` says what one job
-- actually did — one row per step, with its own state, its own timestamps and
-- its own actor. Rows rather than a JSON blob on the job, for three reasons and
-- the third is the one that decides it:
--
--   "How many jobs are stuck on Manager review, across every client?" is a
--   dashboard question, and over a blob it is a scan.
--
--   "What is on Priya's desk?" is how work is handed out, and it needs an
--   indexed column.
--
--   T2.9 requires MAKER != CHECKER as a DATABASE constraint. That is only
--   expressible if who did a step is a column. In a blob it can only ever be a
--   rule somebody remembers, and this is the rule that stops an audit failing.
--
-- ── STATES ARE THE ENGINE'S, NOT THE FIRM'S ─────────────────────────────────
--
-- A CHECK, not a table of rows, exactly as `delivery.job.status` argues. T3.1's
-- work-item states ARE the firm's vocabulary and are rows; these are the
-- engine's mechanics and are identical at every firm. A firm renaming `blocked`
-- would be renaming something it does not own.
--
--   pending   not ready, or ready and not started
--   running   an executor has it
--   blocked   waiting on a person, or on an output a person must accept
--   done      finished
--   skipped   its condition did not hold, or something it depends on was
--             skipped. NOT a failure and NOT the same as done: "we did not do
--             this, and here is why" is a different fact from "we did this",
--             and collapsing them is how a missing review looks like a
--             completed one a year later.
--   failed    the executor could not complete it. Terminal for the STEP; the
--             job blocks, because a machine giving up is a thing a person then
--             has to decide about.
--
-- ── WHY `executor` IS COPIED ONTO THE ROW ───────────────────────────────────
--
-- It is on the pinned template already, so this is redundant — deliberately.
-- The pin means the template is still readable, but reading it costs a join
-- through `config.version` and a JSON parse for every row on a work board. And
-- the one question this column answers — "is a person expected here?" — is asked
-- by every list, every dashboard and eventually every routing rule. The pin
-- remains the source of truth about the PROCESS; this is what the step turned
-- out to be.
--
-- ── AND WHY THERE IS NO `agent_id` HERE ─────────────────────────────────────
--
-- Agents are T2.8. `executor` says a step is an agent's; nothing yet says WHICH
-- agent, because no agent exists and a column with no writer is the "feature
-- that looks finished" this codebase keeps being caught by. It arrives with the
-- runtime that fills it.

SET ROLE bib_owner;

-- ── the registry's sixth kind ───────────────────────────────────────────────
--
-- Adding a kind is a code change as well as this one, and deliberately: each
-- kind needs a body validator in `domain/config/model.ts`, and a kind without
-- one accepts anything. `validateWorkflowTemplateBody` is that validator, and it
-- refuses a graph with a cycle, a dependency on a step that does not exist, or a
-- duplicate step key — all three of which produce a job that sits half-finished
-- with nothing saying why.
--
-- Nothing is seeded. A firm with no published template gets jobs that wait,
-- visibly, rather than a process this product invented on its behalf.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning', 'workflow_template'));

-- ── one row per step of one job ─────────────────────────────────────────────
CREATE TABLE delivery.job_step (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  job_id     uuid NOT NULL,

  -- The template's own key for this step — `reconcile`, `manager_review`.
  -- Never the index: an index shifts when a firm inserts a step, silently
  -- renaming the history of every job that ever ran. Same argument
  -- `dunning_action.step` makes.
  step_key   text NOT NULL,
  -- What a person reads. COPIED from the template at creation rather than
  -- joined at read time, because a work board renders it on every row and
  -- because a label edited later must not restate what a finished step said.
  label      text NOT NULL,

  -- Who is expected to do it. See the note above on why this is copied.
  executor   text NOT NULL CHECK (executor IN ('human', 'agent', 'agent_with_approval')),

  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'running', 'blocked', 'done', 'skipped', 'failed')),

  -- Why a step is not going to happen, or did not. Prose, and nullable: set on
  -- `skipped` and on `failed`, null otherwise.
  --
  -- The capture-or-lose field of this table. At the moment a step is skipped the
  -- reason is obvious to everyone, and nobody writes it down; a year later "why
  -- did this filing have no review" has no query that can answer it. `blocked`
  -- deliberately does NOT use this: blocked is a state with a step_key and an
  -- executor already saying what it waits for.
  outcome_note text,

  -- Set when an executor takes the step, and when it leaves it. A step that has
  -- started has a start time; one that is finished has both — asserted below
  -- rather than trusted to the orchestrator, because "who forgot to set it" is
  -- not a question anybody should have to answer.
  started_at  timestamptz,
  finished_at timestamptz,

  -- WHO did it. Null for a step nobody has touched, for one an agent did (an
  -- agent is not a `user_account`, and T2.8 is what gives it an identity), and
  -- for a skip, which nobody performs.
  --
  -- THIS IS THE COLUMN T2.9 NEEDS. Maker != checker cannot be a database rule
  -- unless who performed a step is a column, and it is the rule an audit turns
  -- on. It exists now, unused, because adding it later means backfilling a fact
  -- nobody recorded.
  performed_by uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- ONE row per step per job. The orchestrator's step-creation is at-least-once
  -- like everything else the engine does — a redelivered message, a restarted
  -- worker — and the second attempt must CONFLICT rather than insert a second
  -- copy of the same step.
  CONSTRAINT job_step_one_per_key UNIQUE (job_id, step_key),
  -- The composite-key target, for whatever T2.9 hangs off a step.
  CONSTRAINT job_step_id_tenant_key UNIQUE (id, tenant_id),

  CONSTRAINT job_step_job_tenant_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  -- BY ID ALONE, and this is the one place in the schema where that is right:
  -- `tenancy.user_account` is a GLOBAL table (ADR-02, identity is above tenant)
  -- and has no `tenant_id` to carry. The composite-key rule exists because a
  -- foreign-key check runs as a system operation RLS does not filter, so an
  -- id-only reference between two TENANT-SCOPED tables lets one firm's row hang
  -- off another firm's; there is no other firm's account to point at here.
  -- `ledger.event.actor_id` names an account the same way, for the same reason.
  CONSTRAINT job_step_performer_fkey
    FOREIGN KEY (performed_by) REFERENCES tenancy.user_account (id),

  -- Timestamps follow the state. `skipped` has NEITHER: a step that was never
  -- going to happen did not start and did not finish, and writing a finish time
  -- on it would make "when did this job's work actually end" answer with the
  -- moment somebody skipped something.
  CONSTRAINT job_step_timestamps_follow_status CHECK (
    (status IN ('pending', 'skipped') AND started_at IS NULL  AND finished_at IS NULL) OR
    (status IN ('running', 'blocked')  AND started_at IS NOT NULL AND finished_at IS NULL) OR
    (status IN ('done', 'failed')      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  ),

  -- A skip and a failure both owe an explanation, and nothing else may carry
  -- one. Enforced rather than asked for, because the note is only ever written
  -- by whoever is already in a hurry.
  CONSTRAINT job_step_note_when_not_done CHECK (
    (status IN ('skipped', 'failed') AND outcome_note IS NOT NULL) OR
    (status NOT IN ('skipped', 'failed') AND outcome_note IS NULL)
  ),

  -- Nobody performs a skip. Without this, a skipped step could name an actor,
  -- and "who did this" would have an answer where the honest one is "nobody".
  CONSTRAINT job_step_skipped_has_no_performer CHECK (
    status <> 'skipped' OR performed_by IS NULL
  )
);

CREATE TRIGGER trg_job_step_updated_at BEFORE UPDATE ON delivery.job_step
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- THE query the orchestrator runs on every tick: this job's steps, so it can
-- decide which are ready. Always read whole, per job.
CREATE INDEX idx_job_step_job ON delivery.job_step (tenant_id, job_id);

-- "What is on this person's desk", and "what is waiting on a human at all" —
-- the work board's two queries. Partial on the states that can still move,
-- because a finished step is almost the whole table within a year and never the
-- answer to either.
CREATE INDEX idx_job_step_open ON delivery.job_step (tenant_id, status, executor)
  WHERE status IN ('pending', 'running', 'blocked');

-- Tenant-scoped, so the wall applies. No identity-mode clause: a step belongs to
-- the firm that owes the work, and nothing asks "this user's steps across firms".
ALTER TABLE delivery.job_step ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_step_isolation ON delivery.job_step
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- SELECT, INSERT, UPDATE — never DELETE, and inherited from 0041's ALTER
-- DEFAULT PRIVILEGES on this schema. A step that was skipped is the record that
-- it was skipped; removing it would take the reason with it.

RESET ROLE;
