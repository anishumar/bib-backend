-- 0307 · sub-steps on a process step, and review points for whoever checks it (T6.15)
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- The firm's first real process ("Monthly Accounting & Bookkeeping", ten steps,
-- 2026-09-17) has bullets under each step: "Collect/retrieve: bank statements,
-- sales data, purchase data ...", "Identify: unreconciled transactions, bank
-- charges ...", and on the manager's review "Check: P&L movements, balance
-- sheet movements ...". There was nowhere to put them, and the firm asked for a
-- checkbox per line and for the step to stay shut until every line is ticked.
--
-- The LINES are the firm's process, so they live in the `workflow_template`
-- body (`checklist` and `reviewPoints` on a step), versioned and pinned like
-- everything else in it. This table holds what people DID about them.
--
-- ── ONE ROW PER MARK, AND AN ABSENT ROW IS OPEN ────────────────────────────
--
-- The shape of 0051's `delivery.checklist_item` tick (who, when, both or
-- neither) with two differences, both decided with the firm on 2026-09-25:
--
--   1. A line may be marked NOT APPLICABLE, and then must say why. The firm's
--      own lists say "payroll information WHERE INCLUDED" and "accruals WHERE
--      APPLICABLE"; without the option an associate must tick something that
--      did not happen, and the record lies.
--   2. There are TWO lists. Sub-steps (`checklist`) are ticked by whoever does
--      the step. Review points (`review`) are ticked by whoever CHECKS it: on
--      the manager's review step the doer is the associate whose work is being
--      reviewed, and "P&L movements reviewed" on their list would record the
--      wrong person as having checked it.
--
-- A review mark is keyed on the CHECK (`step_approval_id`), not on the step,
-- so the second check after a send-back starts with every review point open,
-- and "this took two goes" keeps what each round's checker ticked. A sub-step
-- mark is keyed on the step and survives a send-back: the work behind it is
-- still the work, and the doer changes it if the reason touches it.
--
-- Unticking is `outcome = NULL`, never a DELETE, and `bib_app` holds no DELETE
-- grant here.
--
-- ── NO LEDGER EVENT PER TICK ───────────────────────────────────────────────
--
-- 0051's decision for the task checklist, for the same reason: the row already
-- says who and when, and ten events per step would bury the transitions. The
-- counts (never a label or a reason) ride on `job.step_advanced`,
-- `output.approved` and `output.rejected`.
--
-- ── NO PORTAL POLICY ───────────────────────────────────────────────────────
--
-- No portal route reads this table, and gate 2 contains it, the arrangement
-- 0065 stated for `crm.client_freeze`. Whether a client may see which of the
-- firm's internal checks were ticked is a question for a firm, not a guess; a
-- portal route whose subject is this table needs its own line in a migration
-- first.

SET ROLE bib_owner;

-- ── the pairing, made a wall ────────────────────────────────────────────────
--
-- A review mark names a check AND a step, and the step must be the one the
-- check is about. `step_approval` carried only `(id, tenant_id)`, so this adds
-- the three-column key the composite foreign key below needs: the same move
-- 0063 made for `client_ask` over `(work_item_id, client_party_id, tenant_id)`.
-- It is trivially unique (`id` is the primary key) and costs one index; what
-- it buys is that a review mark hanging off one step's check while naming
-- another step is unrepresentable rather than merely never written.
ALTER TABLE delivery.step_approval
  ADD CONSTRAINT step_approval_id_step_tenant_key UNIQUE (id, job_step_id, tenant_id);

CREATE TABLE delivery.job_step_check (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  job_step_id uuid NOT NULL,
  -- The check a REVIEW mark was made under. Null on a sub-step mark, and the
  -- CHECK below holds the two to each other.
  step_approval_id uuid,

  list     text NOT NULL,
  -- The line's key in the pinned template, never its position (a firm inserting
  -- a line would silently move every tick) and never its wording (a renamed
  -- line in a later version must not re-label a tick made against the old one).
  item_key text NOT NULL,
  -- COPIED from the pinned template at the moment of marking, so the row reads
  -- on its own: "ticked 'bank statements'" is legible to somebody reading this
  -- table without resolving a config version.
  label    text NOT NULL,

  -- NULL = open: never ticked, or ticked and taken back.
  outcome  text,
  -- The reason, on `not_applicable` and nowhere else.
  note     text,

  -- By id alone: `tenancy.user_account` is GLOBAL (ADR-02) and carries no
  -- tenant, the reason `job_step.performed_by` gives.
  marked_by_user_id uuid REFERENCES tenancy.user_account (id),
  marked_at         timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- UNIQUE (id, tenant_id): the composite-key target, for whatever later hangs
  -- off a mark. Scoped to the tenant because every reference between
  -- tenant-scoped tables carries the tenant with it.
  CONSTRAINT job_step_check_id_tenant_key UNIQUE (id, tenant_id),

  CONSTRAINT job_step_check_step_tenant_fkey
    FOREIGN KEY (job_step_id, tenant_id) REFERENCES delivery.job_step (id, tenant_id),
  -- The check, its step and the firm, together. MATCH SIMPLE, the default, so a
  -- sub-step mark (no check) is not tested against it at all, and a review mark
  -- must name a check of THIS step at THIS firm.
  CONSTRAINT job_step_check_approval_step_tenant_fkey
    FOREIGN KEY (step_approval_id, job_step_id, tenant_id)
    REFERENCES delivery.step_approval (id, job_step_id, tenant_id),

  CONSTRAINT job_step_check_list_check
    CHECK (list IN ('checklist', 'review')),
  CONSTRAINT job_step_check_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('done', 'not_applicable')),
  CONSTRAINT job_step_check_label_is_text
    CHECK (length(btrim(label)) > 0),

  -- A review mark names the check it was made under; a sub-step mark names
  -- none. Without the second half a sub-step tick could be keyed on a check and
  -- vanish from the doer's list at the next round.
  CONSTRAINT job_step_check_review_rows_name_their_check
    CHECK ((list = 'review') = (step_approval_id IS NOT NULL)),

  -- A tick names somebody and a moment, or nothing at all: 0051's rule. "Done
  -- by nobody at no time" is the shape a half-written import leaves behind.
  CONSTRAINT job_step_check_mark_names_somebody CHECK (
    (outcome IS NULL     AND marked_by_user_id IS NULL     AND marked_at IS NULL) OR
    (outcome IS NOT NULL AND marked_by_user_id IS NOT NULL AND marked_at IS NOT NULL)
  ),

  -- "Not applicable" says why, in a sentence or two, and nothing else carries a
  -- reason. A CASE rather than an equality, because `outcome` is nullable and
  -- `NULL = 'not_applicable'` would make the whole CHECK NULL, which passes: an
  -- open line would then be free to carry a stale reason.
  CONSTRAINT job_step_check_not_applicable_says_why CHECK (
    CASE WHEN outcome = 'not_applicable'
         THEN note IS NOT NULL AND length(btrim(note)) > 0 AND length(note) <= 500
         ELSE note IS NULL
    END
  )
);

CREATE TRIGGER trg_job_step_check_updated_at BEFORE UPDATE ON delivery.job_step_check
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ONE MARK PER SUB-STEP PER STEP: `(tenant, step, line)` among sub-step rows.
-- Scoped to the STEP, so each job's step has its own list, and to the tenant,
-- like every key here. It is also the conflict target the adapter's upsert
-- names, which is what makes a second click an update rather than a second row.
CREATE UNIQUE INDEX job_step_check_one_per_sub_step
  ON delivery.job_step_check (tenant_id, job_step_id, item_key)
  WHERE list = 'checklist';

-- ONE MARK PER REVIEW POINT PER CHECK: `(tenant, check, line)` among review
-- rows. Scoped to the CHECK and not the step, deliberately: a step sent back
-- and resubmitted has a second check, and its review points are a second set of
-- rows, so the first round's ticks are kept and the second starts empty.
CREATE UNIQUE INDEX job_step_check_one_per_review_point
  ON delivery.job_step_check (tenant_id, step_approval_id, item_key)
  WHERE list = 'review';

-- The job page's read reaches marks through their step, both lists at once.
CREATE INDEX idx_job_step_check_step
  ON delivery.job_step_check (tenant_id, job_step_id);

ALTER TABLE delivery.job_step_check ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_step_check_isolation ON delivery.job_step_check
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- SELECT, INSERT, UPDATE and never DELETE. 0041's default privileges on this
-- schema already say so; stated here as well, because "a tick cannot be
-- deleted" is a property of this table somebody will look for in this file.
GRANT SELECT, INSERT, UPDATE ON delivery.job_step_check TO bib_app;

RESET ROLE;
