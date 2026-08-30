-- 0051 · the row on somebody's desk — `work_item` and the three tables that
--        hang off it (T3.1)
--
-- ── WHAT WAS MISSING, AND WHY IT IS NOT `job_step` ─────────────────────────
--
-- T2.6–T2.9 built an ENGINE: a job walks a pinned template, its steps run, an
-- agent's output gets checked. Nothing in it has an assignee, a due date, a
-- priority or a client's name, and nothing in it is the firm's own vocabulary.
-- Open `/work` today and the board shows jobs that are on nobody's desk.
--
-- This table is the other half, and the two are deliberately not merged:
--
--   `delivery.job`  is HOW work gets done — which template, which steps, which
--                   agent. Its states are the engine's, identical at every
--                   firm, and a firm renaming `running` would be renaming
--                   something it does not own.
--
--   `work_item`     is WHAT is owed and WHOSE it is. Its states are the firm's
--                   own words (0050). It exists for ad hoc work that has no
--                   template at all — "prepare the board minutes" — which is
--                   real work somebody must still own, review and be late on.
--
-- Merging them would have cost both halves: ad hoc work would have no home, and
-- a firm would be renaming the engine's mechanics to get its own board to read
-- properly. `job_id` below is the link, and it is NULLABLE in both directions —
-- many work items may share one job (a merged job covers several engagements),
-- and a work item may have no job at all.
--
-- ── THE ACCEPTANCE LINE, AS A CHAIN OF COLUMNS ─────────────────────────────
--
--   "a filing arrives pre-assigned to the client's Dept SPOC"
--
--   engagement letter line
--     ├─ letter.party_id          → client_party_id   (the CLIENT; what
--     │                              crm.client_assignment is keyed on)
--     ├─ line.entity_party_id     → entity_party_id   (WHICH company owes it;
--     │                              G0.1 — a group of four files four sets)
--     └─ line.service_version_id  → service_version_id, PINNED
--            └─ body.module = "FRC" → tenancy.service_axis → dept_axis_id
--                   └─ crm.client_assignment (client, 'spoc', dept, on date)
--                          └─ assignee_user_id
--
-- Every link in that chain is a column here, which is what makes the routing a
-- QUERY rather than a rule somebody remembers. `dept_axis_id` is stored rather
-- than re-derived because the service body it came from is a pinned version
-- that a screen would otherwise have to open and JSON-parse per row.
--
-- ── WHAT HAPPENS WHEN THE CHAIN CANNOT ANSWER ──────────────────────────────
--
-- Two real cases, and both leave the item UNASSIGNED with `assignment_note`
-- saying which:
--
--   NO SPOC for that Dept — the firm has not recorded one. Falling back to the
--   Key Manager was considered and refused: it is a rule the firm never gave,
--   and it would hide the actual problem (missing data) behind a plausible
--   answer.
--
--   MORE THAN ONE SPOC — G3.2 deliberately allows it (leave cover, a joint
--   SPOC, a fortnight's parallel handover). Picking the first is also a rule
--   nobody gave. A WRONG assignee is worse than none: it sits on a desk whose
--   owner believes it is not theirs, whereas unassigned work is visible in a
--   queue that gets chased.
--
-- `assignment_note` is therefore not decoration — it is the difference between
-- "nobody has got to this yet" and "the router could not decide, and here is
-- what to fix".
--
-- ── `sla_days_snapshot` IS A COPY, ON PURPOSE ──────────────────────────────
--
-- G2.3 put `slaDays` on the service body. This copies the value in force AT
-- CREATION, for the same reason a job pins its template version: revising the
-- catalogue must never make finished work retroactively late. The firm's own
-- rule is *"task is due from signing of EL"* and *"SLA is per service"*, so
-- `due_on` is the signature date plus this number — computed once, stored, and
-- never recomputed.
--
-- ── THE CAPTURE-OR-LOSE PAIR, AND WHY A TRIGGER ────────────────────────────
--
-- `blocked_reason` + `blocked_at`. "Blocked" as a state records that work is
-- stuck and never WHY, and at the moment somebody blocks a task the reason is
-- obvious to everyone in the room and nobody writes it down. A year later "are
-- our delays ours or the client's" has no query that can answer it.
--
-- It cannot be a CHECK, and that is the price of states being rows: a CHECK
-- cannot see `is_blocked` in another table. So `enforce_work_item_state_facts`
-- below joins to the state and refuses the write. The rule reads the FLAG and
-- never the code, so a firm renaming "Blocked" to "Stuck" keeps it.

SET ROLE bib_owner;

-- ── what somebody must actually do ─────────────────────────────────────────
CREATE TABLE delivery.work_item (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- ── who it is for ────────────────────────────────────────────────────────

  -- The CLIENT. Always known, even for ad hoc work — this is what the SPOC and
  -- the Key Manager are recorded against, and what the client portal will scope
  -- by.
  client_party_id uuid NOT NULL,
  -- WHICH of the client's companies owes it. Nullable: relationship-level work
  -- ("agree next year's scope") is about the client and no single entity. A
  -- filing always has one, and T3.2's obligations are keyed on exactly this.
  entity_party_id uuid,

  -- ── where it came from ───────────────────────────────────────────────────

  -- The engagement that caused it, when one did. Null for ad hoc work, which is
  -- real work: the demo's own note — *"ad hoc work is real work"*.
  engagement_id      uuid,
  -- The job automating it, when there is one. Null for ad hoc work and for work
  -- whose firm has published no process. See the note at the top.
  job_id             uuid,
  -- The service as it was PINNED on the engagement letter line. What `slaDays`,
  -- the Dept and the title were read from — kept so "why is this due then" can
  -- be answered from the version the client actually signed.
  service_version_id uuid,
  -- The Dept (or delivery team) the SPOC lookup used. Stored rather than
  -- re-derived per row; see the chain above.
  dept_axis_id       uuid,

  title       text NOT NULL,
  description text,

  -- ── the firm's own vocabulary (0050) ─────────────────────────────────────
  state_id    uuid NOT NULL,
  priority_id uuid NOT NULL,

  -- ── whose desk ───────────────────────────────────────────────────────────

  -- By id alone, and this is the same one place in the schema where that is
  -- right: `tenancy.user_account` is GLOBAL (ADR-02, identity is above tenant)
  -- and has no `tenant_id` to carry. What refuses a stranger is the roster
  -- check in the service, exactly as it does for `client_assignment.user_id`.
  assignee_user_id uuid REFERENCES tenancy.user_account (id),
  -- Why nobody, when the router could not decide. See the note at the top: this
  -- is what separates "not got to yet" from "two SPOCs, pick one".
  assignment_note  text,

  -- ── when ─────────────────────────────────────────────────────────────────
  due_on            date,
  -- True when the date comes from a STATUTE rather than from the firm. This is
  -- what makes priority derivable, and T3.2 sets it when it materialises
  -- obligations.
  is_statutory_due  boolean NOT NULL DEFAULT false,
  -- The SLA in force when this was created. A copy; see the note at the top.
  sla_days_snapshot integer CHECK (sla_days_snapshot IS NULL OR sla_days_snapshot >= 0),

  -- *"Clients would be able to see their tasks."* Defaulted true because that
  -- is the client's answer, and the exceptions — an internal review note, a
  -- write-off discussion — are marked rather than the rule inverted. Its READER
  -- is the client portal (U1); its WRITER is the firm's own screen, today.
  is_client_visible boolean NOT NULL DEFAULT true,

  -- The capture-or-lose pair. Both or neither, and mandatory in a state whose
  -- `is_blocked` is set — see `enforce_work_item_state_facts`.
  blocked_reason text,
  blocked_at     timestamptz,

  started_at   timestamptz,
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The composite-key target for the three tables below.
  CONSTRAINT work_item_id_tenant_key UNIQUE (id, tenant_id),

  -- ── the tenant wall, one composite key per reference ─────────────────────
  --
  -- Every one of these points at BOTH columns. A foreign-key check runs as a
  -- system operation that RLS does not filter, so an id-only reference between
  -- two tenant-scoped tables would let one firm's work item hang off another
  -- firm's client, state or job with every policy satisfied. That leak is
  -- silent, which is why it is structural.
  CONSTRAINT work_item_client_tenant_fkey
    FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT work_item_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT work_item_engagement_tenant_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id),
  CONSTRAINT work_item_job_tenant_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  CONSTRAINT work_item_service_version_tenant_fkey
    FOREIGN KEY (service_version_id, tenant_id) REFERENCES config.version (id, tenant_id),
  CONSTRAINT work_item_dept_axis_tenant_fkey
    FOREIGN KEY (dept_axis_id, tenant_id) REFERENCES tenancy.service_axis (id, tenant_id),
  CONSTRAINT work_item_state_tenant_fkey
    FOREIGN KEY (state_id, tenant_id) REFERENCES delivery.work_item_state (id, tenant_id),
  CONSTRAINT work_item_priority_tenant_fkey
    FOREIGN KEY (priority_id, tenant_id) REFERENCES delivery.work_item_priority (id, tenant_id),

  -- Both or neither, always — the half of the capture-or-lose rule that does
  -- not need the state row and so can be a CHECK. A `blocked_at` with no reason
  -- is the exact failure this pair exists to prevent.
  CONSTRAINT work_item_blocked_pair CHECK (
    (blocked_reason IS NULL AND blocked_at IS NULL) OR
    (blocked_at IS NOT NULL AND length(btrim(blocked_reason)) > 0)
  ),

  -- An item cannot have finished before it started. Not a rule about which
  -- states set them — that is the trigger's — but arithmetic that is wrong
  -- however it got written.
  CONSTRAINT work_item_finished_after_started CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  ),

  -- An assignment note is what UNASSIGNED work says about itself. On an
  -- assigned row it would be a stale sentence contradicting the name beside it.
  CONSTRAINT work_item_note_only_when_unassigned CHECK (
    assignee_user_id IS NULL OR assignment_note IS NULL
  )
);

CREATE TRIGGER trg_work_item_updated_at BEFORE UPDATE ON delivery.work_item
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ── the rules a CHECK cannot express, because the state is a row ───────────
--
-- Joins to `work_item_state` and reads its FLAGS. Never its `code`: the whole
-- promise of 0050 is that a firm may rename any of these, and a rule keyed on
-- the name would switch itself off the first time one did.
--
-- Three facts, and each is a thing somebody would otherwise have to remember:
--
--   is_blocked  ⇒ a reason and a time. The capture-or-lose pair, enforced at
--               the moment the information still exists.
--   NOT blocked ⇒ neither. Leaving a block CLEARS the pair rather than letting
--               a stale sentence sit on running work; the history of the block
--               is in the ledger, which is where history belongs.
--   is_terminal ⇔ completed_at. A finished item has a finish time and an
--               unfinished one does not — including on the way BACK, when work
--               is reopened and the old completion stops being true.
CREATE OR REPLACE FUNCTION delivery.enforce_work_item_state_facts() RETURNS trigger AS $fn$
DECLARE
  st_name     text;
  st_blocked  boolean;
  st_terminal boolean;
BEGIN
  SELECT name, is_blocked, is_terminal
    INTO st_name, st_blocked, st_terminal
    FROM delivery.work_item_state
   WHERE id = NEW.state_id AND tenant_id = NEW.tenant_id;

  IF st_blocked IS NULL THEN
    -- REACHED BEFORE THE FOREIGN KEY, and that was worth finding out. A BEFORE
    -- INSERT trigger runs ahead of constraint validation, so a work item naming
    -- ANOTHER FIRM'S state arrives here first: this lookup is scoped to
    -- `(id, tenant_id)` and finds nothing, and the caller is told which state
    -- and which firm rather than reading a constraint name.
    --
    -- The composite key is still what makes the wall structural — it holds for
    -- every write, including ones that never reach a trigger — but it is the
    -- SECOND line here, not the first. Proven both ways in
    -- tests/workitem/workitem.integration.test.ts.
    RAISE EXCEPTION
      'work_item % names work_item_state %, which does not belong to firm %. A state is one firm''s own vocabulary; another firm''s row is not a state this item can be in.',
      NEW.id, NEW.state_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF st_blocked AND (NEW.blocked_at IS NULL OR length(btrim(coalesce(NEW.blocked_reason, ''))) = 0) THEN
    RAISE EXCEPTION
      'work_item % is being put into %, a state this firm has marked as BLOCKED, and a blocked item owes a reason. "Blocked" records that work is stuck and never why; a year later "are our delays ours or the client''s" has no query that can answer it. Send blockedReason with the state change.',
      NEW.id, st_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT st_blocked AND (NEW.blocked_at IS NOT NULL OR NEW.blocked_reason IS NOT NULL) THEN
    RAISE EXCEPTION
      'work_item % is in %, which this firm has NOT marked as blocked, so it cannot carry a block reason. Leaving a block clears the pair — the history of it is in the ledger, which is the thing that cannot be edited.',
      NEW.id, st_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF st_terminal AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'work_item % is being put into %, a state this firm has marked as TERMINAL, and a finished item has a finish time. Without one, "how long did this take" and "what did we close last month" both answer with nothing.',
      NEW.id, st_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT st_terminal AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'work_item % is in %, which is not a terminal state, so it cannot carry a completion time. Reopening work clears it: the row says what is true now, and what used to be true is in the ledger.',
      NEW.id, st_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_work_item_state_facts
  BEFORE INSERT OR UPDATE ON delivery.work_item
  FOR EACH ROW EXECUTE FUNCTION delivery.enforce_work_item_state_facts();

-- ── the queries the screens actually run ───────────────────────────────────
--
-- "What is on my desk" — the first thing anybody opens, and the reason
-- assignment is a column at all. Partial on unfinished work, because a finished
-- item is almost the whole table within a year and never the answer.
CREATE INDEX idx_work_item_assignee_open
  ON delivery.work_item (tenant_id, assignee_user_id)
  WHERE completed_at IS NULL;
-- "What has nobody picked up" — the queue the two SPOC cases above land in. It
-- only works as a chased queue if it is one cheap query.
CREATE INDEX idx_work_item_unassigned
  ON delivery.work_item (tenant_id, due_on)
  WHERE assignee_user_id IS NULL AND completed_at IS NULL;
-- "What is due, and what is late" — ordered by the date, which is how a
-- delivery meeting reads it.
CREATE INDEX idx_work_item_due
  ON delivery.work_item (tenant_id, due_on)
  WHERE completed_at IS NULL;
-- The client page's panel, and the portal's whole scope later.
CREATE INDEX idx_work_item_client ON delivery.work_item (tenant_id, client_party_id);
-- The job screen's "what did this process actually put on people's desks".
CREATE INDEX idx_work_item_job ON delivery.work_item (tenant_id, job_id)
  WHERE job_id IS NOT NULL;

-- ONE work item per engagement, per firm — and the reason is the same one that
-- makes `delivery.job` idempotent. The spawn path is at-least-once: a
-- redelivered sweep, a restarted worker, a replayed activation. A second work
-- item is a second task on somebody's desk for work already being done, and it
-- would be indistinguishable from a real one. Partial on the rows that have an
-- engagement, so ad hoc work is unconstrained.
CREATE UNIQUE INDEX idx_work_item_one_per_engagement
  ON delivery.work_item (tenant_id, engagement_id)
  WHERE engagement_id IS NOT NULL;

ALTER TABLE delivery.work_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_isolation ON delivery.work_item
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── one tick on a task ─────────────────────────────────────────────────────
--
-- The steps a filing actually takes, in the firm's own order. Distinct from
-- `job_step`, which is a TEMPLATE's step with its own state machine and its own
-- executor: this is a list a person writes on a task, including one that has no
-- template at all.
CREATE TABLE delivery.checklist_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  work_item_id uuid NOT NULL,

  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,

  done_at      timestamptz,
  -- By id alone; `tenancy.user_account` is global. See `work_item.assignee_user_id`.
  done_by_user_id uuid REFERENCES tenancy.user_account (id),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checklist_item_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT checklist_item_work_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id),

  -- Both or neither. A tick with nobody behind it is the fact this table exists
  -- to record, missing. When an agent can tick one — it cannot today, and a
  -- column with no writer is the "feature that looks finished" this codebase
  -- keeps being caught by — this pair is what has to be relaxed, deliberately.
  CONSTRAINT checklist_item_tick_names_somebody CHECK (
    (done_at IS NULL AND done_by_user_id IS NULL) OR
    (done_at IS NOT NULL AND done_by_user_id IS NOT NULL)
  )
);

CREATE TRIGGER trg_checklist_item_updated_at BEFORE UPDATE ON delivery.checklist_item
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

CREATE INDEX idx_checklist_item_work ON delivery.checklist_item (tenant_id, work_item_id);

-- A TICKED line may never be deleted. Unlike everything else in this schema,
-- checklist lines CAN be removed — a person building a list mistypes one, and a
-- firm that cannot fix its own checklist from the screen will keep the list in
-- Excel. But a tick is a record that somebody did something, and deleting the
-- line takes that record with it. So: remove the line, or untick it first and
-- say so.
CREATE OR REPLACE FUNCTION delivery.refuse_ticked_checklist_delete() RETURNS trigger AS $fn$
BEGIN
  IF OLD.done_at IS NOT NULL THEN
    RAISE EXCEPTION
      'checklist item % is ticked and cannot be deleted — the tick is the record that somebody did it, and it lives nowhere else. Untick it first if it was ticked by mistake.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checklist_item_no_ticked_delete
  BEFORE DELETE ON delivery.checklist_item
  FOR EACH ROW EXECUTE FUNCTION delivery.refuse_ticked_checklist_delete();

ALTER TABLE delivery.checklist_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY checklist_item_isolation ON delivery.checklist_item
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── "this cannot start until that is finished" ─────────────────────────────
--
-- A row rather than a column, because a task can wait on several others — the
-- annual filing waits on twelve monthly ones.
CREATE TABLE delivery.work_item_dependency (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  work_item_id uuid NOT NULL,
  depends_on_work_item_id uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_dependency_key UNIQUE (work_item_id, depends_on_work_item_id),
  CONSTRAINT work_item_dependency_work_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id),
  CONSTRAINT work_item_dependency_blocker_tenant_fkey
    FOREIGN KEY (depends_on_work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id),

  -- The one cycle a constraint can see. Longer ones (A→B→A) are refused by the
  -- service walking the graph, exactly as `validateWorkflowTemplateBody` does
  -- for a workflow, because SQL cannot express reachability in a CHECK. Stated
  -- rather than implied: the database catches the trivial case and the service
  -- catches the rest, and a cycle that got in would produce work nothing can
  -- ever start with nothing saying why.
  CONSTRAINT work_item_dependency_not_itself CHECK (work_item_id <> depends_on_work_item_id)
);

-- "What is this waiting on" and "what is waiting on this" — both directions are
-- read: the first by the task screen, the second before anybody completes
-- something.
CREATE INDEX idx_work_item_dependency_work
  ON delivery.work_item_dependency (tenant_id, work_item_id);
CREATE INDEX idx_work_item_dependency_blocker
  ON delivery.work_item_dependency (tenant_id, depends_on_work_item_id);

ALTER TABLE delivery.work_item_dependency ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_dependency_isolation ON delivery.work_item_dependency
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── review, with maker != checker enforced by the database ─────────────────
--
-- A SECOND approval table beside `delivery.step_approval` (0048), and that is a
-- decision rather than an oversight. `step_approval` hangs off a `job_step`, so
-- work with no template — ad hoc work, and work at a firm that has published no
-- process — could never be reviewed at all. The client's own words are *"every
-- task is mostly reviewed"*, which is about the task and not about a step of a
-- process it may not have.
--
-- What is NOT duplicated is the rule about who may check: `VerificationPolicy`,
-- `eligibility()` and the grade/reporting-line comparison are T2.9's, are pure,
-- and are reused unchanged. One answer to "who checks whose work" at this firm,
-- two tables recording the answers.
CREATE TABLE delivery.work_item_approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  work_item_id uuid NOT NULL,

  -- WHO MADE THE WORK. Derived by trigger from `work_item.assignee_user_id` and
  -- frozen, exactly as `step_approval.submitted_by` is derived from
  -- `job_step.performed_by`, and for the identical reason: a maker the writer
  -- could CHOOSE is not a maker-checker control. The way past the constraint
  -- would be to name somebody else as the maker and approve it yourself. The
  -- application cannot set this column, and that is the point.
  --
  -- Nullable because an unassigned item can still be sent for review — somebody
  -- did the work off the record — and null makes the maker!=checker CHECK
  -- vacuous rather than blocking. That is the honest state: with no maker
  -- recorded there is no self-approval to detect, and the screen says so.
  submitted_by uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),

  -- The firm's published rule, PINNED at the moment the check was opened. Null
  -- when the firm has published none, or has since withdrawn it — both real
  -- states, and the check still happens under maker != checker alone.
  policy_version_id uuid,
  policy_key        text,

  decision text NOT NULL DEFAULT 'pending'
           CHECK (decision IN ('pending', 'approved', 'rejected')),
  -- What the reviewer objected to. The other half of this table's
  -- capture-or-lose: when work is sent back, WHY is the only signal that ever
  -- explains rework, and marking the task Completed erases the fact that it was
  -- rejected twice.
  notes      text,
  decided_by uuid,
  decided_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_approval_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT work_item_approval_work_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id),
  CONSTRAINT work_item_approval_submitter_fkey
    FOREIGN KEY (submitted_by) REFERENCES tenancy.user_account (id),
  CONSTRAINT work_item_approval_decider_fkey
    FOREIGN KEY (decided_by) REFERENCES tenancy.user_account (id),
  CONSTRAINT work_item_approval_policy_version_tenant_fkey
    FOREIGN KEY (policy_version_id, tenant_id) REFERENCES config.version (id, tenant_id),

  -- THE rule. A CHECK and not a UI guard, because a rule that lives in a form
  -- is one that a script, an import or an AI agent walks straight past.
  CONSTRAINT work_item_approval_maker_is_not_checker CHECK (
    decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
  ),
  CONSTRAINT work_item_approval_decided_evidence CHECK (
    (decision =  'pending' AND decided_by IS NULL     AND decided_at IS NULL) OR
    (decision <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT work_item_approval_rejection_says_why CHECK (
    decision <> 'rejected' OR length(btrim(coalesce(notes, ''))) > 0
  )
);

CREATE TRIGGER trg_work_item_approval_updated_at BEFORE UPDATE ON delivery.work_item_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- The maker is READ from the work item, never supplied. See the column note.
CREATE OR REPLACE FUNCTION delivery.derive_work_item_approval_maker() RETURNS trigger AS $fn$
DECLARE assignee uuid;
BEGIN
  SELECT assignee_user_id INTO assignee
    FROM delivery.work_item
   WHERE id = NEW.work_item_id AND tenant_id = NEW.tenant_id;
  NEW.submitted_by := assignee;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_work_item_approval_derive_maker
  BEFORE INSERT ON delivery.work_item_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.derive_work_item_approval_maker();

-- And FROZEN afterwards. A rule whose left-hand side can be edited after the
-- fact is not a rule: reassigning the work item must not rewrite who made the
-- version that was checked.
CREATE OR REPLACE FUNCTION delivery.freeze_work_item_approval_maker() RETURNS trigger AS $fn$
BEGIN
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
  OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
  THEN
    RAISE EXCEPTION
      'work_item_approval % cannot change who made the work it checks. Maker != checker is a comparison between two columns, and a rule whose left-hand side can be edited after the fact is not a rule.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_work_item_approval_maker_frozen
  BEFORE UPDATE ON delivery.work_item_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.freeze_work_item_approval_maker();

-- ONE open check per work item. Two people clicking "send for review" together
-- must not open two, or one reviewer's approval and another's rejection would
-- both stand.
CREATE UNIQUE INDEX idx_work_item_approval_one_open
  ON delivery.work_item_approval (work_item_id)
  WHERE decision = 'pending';
-- The queue, oldest first — the same shape `step_approval` has, because the two
-- appear side by side on one screen.
CREATE INDEX idx_work_item_approval_pending
  ON delivery.work_item_approval (tenant_id, submitted_at)
  WHERE decision = 'pending';
CREATE INDEX idx_work_item_approval_work
  ON delivery.work_item_approval (tenant_id, work_item_id);

ALTER TABLE delivery.work_item_approval ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_approval_isolation ON delivery.work_item_approval
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 0041's ALTER DEFAULT PRIVILEGES gives bib_app SELECT, INSERT, UPDATE on
-- everything created in this schema. DELETE is granted to exactly two tables
-- and nowhere else:
--
--   checklist_item          — a person fixing their own list. Guarded by the
--                             trigger above: a ticked line cannot go.
--   work_item_dependency    — removing a dependency is a normal act, and the
--                             row carries no history of its own.
--
-- Never `work_item` (it is the record that work was owed; cancelling is a
-- state) and never `work_item_approval` (a rejection that vanished would leave
-- the task looking as though it was approved first time).
GRANT DELETE ON delivery.checklist_item TO bib_app;
GRANT DELETE ON delivery.work_item_dependency TO bib_app;

RESET ROLE;
