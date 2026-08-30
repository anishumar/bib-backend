-- 0048 · who may check somebody else's work, and the wall that says it can
--        never be themselves (T2.9)
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- T2.7 gave a job its steps and recorded WHO performed each one. T2.8 gave a
-- machine's output a person to decide on it. Neither asked the question this
-- migration exists for: is that person ALLOWED to be the one checking?
--
-- Today they always are. `job_step.performed_by` has been written since T2.7
-- and `agent_run.decided_by` since T2.8, and nothing anywhere compares either
-- against who approves the result. An associate can perform a step and sign it
-- off in the same minute, and the database is perfectly happy.
--
-- ── THE ONE RULE THAT IS NOT CONFIGURABLE ───────────────────────────────────
--
-- Maker != checker. `build2.md` names it as one of the demo's hardest-won rules
-- with no home in the rebuild, and quotes the reason it is a CHECK rather than
-- a form rule:
--
--   "a rule that lives in a form is a rule that a script, an import or an AI
--    agent walks straight past."
--
-- So it is `step_approval_maker_is_not_checker` below, and an integration test
-- proves it as the OWNER role, going around the application entirely. That is
-- the only way a claim like this is worth anything.
--
-- ── AND THE ONE THAT IS ─────────────────────────────────────────────────────
--
-- WHO ELSE may check is a different question, and it is the firm's. The client
-- gave two answers on two different days and they are not the same rule:
--
--   "Manager or above is fine."          -> a RANK THRESHOLD
--   "manager means engagement manager."  -> a REPORTING LINE
--
-- A threshold lets anyone senior enough check anyone's work. A reporting line
-- lets only your own manager check yours, and stalls the morning they go on
-- leave. Picking one on the firm's behalf would be us deciding the firm's
-- maker-checker control, which is exactly the kind of decision this project has
-- already been caught making from a plausible-looking document.
--
-- It is not even one answer per firm. SQC 1 — ICAI's own quality-control
-- standard, which is what a CA firm is actually audited against — requires an
-- engagement quality control reviewer to be BOTH "suitably qualified" (a rank
-- test) AND "independent of the engagement team" (which a reporting line is the
-- opposite of: your manager is on your engagement). So an ordinary manager
-- review and an EQCR sign-off are different rules, and a firm needs both inside
-- one process.
--
-- Therefore: `verification_policy` is the registry's EIGHTH kind, a firm
-- publishes as many as it has kinds of review, and a workflow step names the
-- one that governs it. Nothing is seeded — a firm that has published none gets
-- steps that are checked by nobody, visibly, which is what it had before this
-- migration.
--
-- ── WHY `reports_to_user_id` IS PART OF THIS MIGRATION ──────────────────────
--
-- Because without it the `reporting_line` rule cannot be OFFERED. There is no
-- staff reporting relationship anywhere in this schema today —
-- `core.party_relationship` is between PARTIES, and a member of staff is a
-- `user_account` plus a `membership`, never a party. Shipping a policy screen
-- with a mode that silently matches nobody would be the "feature that looks
-- finished" shape this codebase keeps catching.

SET ROLE bib_owner;

-- ── the registry's eighth kind ──────────────────────────────────────────────
--
-- Adding a kind is a code change too: `validateVerificationPolicyBody` in
-- `domain/config/model.ts` is its validator, and a kind without one accepts
-- anything.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier', 'verification_policy'));

-- ── the firm's reporting line ───────────────────────────────────────────────
--
-- On `membership` rather than a table of its own, because that is what a
-- reporting line is a fact ABOUT: this person, at this firm, in this audience.
-- The same shape `grade_id` took in 0040 and for the same reason.
--
-- NULLABLE, and unreported is a real answer rather than missing data. A partner
-- reports to nobody. Neither does a portal contact, and neither does anybody at
-- a firm that has not filled this in — which is every firm the day this
-- migration applies. A `reporting_line` policy simply matches nobody for them,
-- and the screen says so rather than pretending.
--
-- NOT EFFECTIVE-DATED, and that is a stated limit rather than an oversight. The
-- firm's own staff sheet carries birth dates and no joining dates, and nothing
-- anywhere records when a reporting line STARTED. An effective-dated table
-- whose every row began on the day it was imported answers "who was my manager
-- in March" with a confident lie, which is worse than this column answering
-- only "now" and saying so. `client_assignment` (G3.2) is effective-dated
-- because the firm keeps those dates; this is not because it does not.
ALTER TABLE tenancy.membership
  ADD COLUMN reports_to_user_id uuid;

-- BY ID ALONE, for `job_step.performed_by`'s reason: `tenancy.user_account` is
-- a GLOBAL table (ADR-02, identity is above tenant) and carries no tenant_id.
-- The composite-key rule guards references between two TENANT-SCOPED tables;
-- there is no other firm's account to point at here.
--
-- That the manager is a member of the SAME firm is not expressible as a foreign
-- key against a global table, and it is checked at the write instead — the
-- roster only ever offers this firm's own people.
ALTER TABLE tenancy.membership
  ADD CONSTRAINT membership_reports_to_fkey
    FOREIGN KEY (reports_to_user_id) REFERENCES tenancy.user_account (id);

-- Nobody reports to themselves. A one-person cycle is the only one a single
-- column can express, and it is also the only one somebody actually creates —
-- by picking their own name out of a dropdown. Longer cycles are refused by
-- the service, which can walk the chain; a CHECK cannot.
ALTER TABLE tenancy.membership
  ADD CONSTRAINT membership_reports_to_is_not_self
    CHECK (reports_to_user_id IS NULL OR reports_to_user_id <> user_id);

-- "Who reports to this person" — the roster's org read, and the resolver's when
-- a `reporting_line` policy asks whether a candidate is above the maker.
CREATE INDEX idx_membership_reports_to
  ON tenancy.membership (tenant_id, reports_to_user_id)
  WHERE reports_to_user_id IS NOT NULL;

-- ── one row per check of one step ───────────────────────────────────────────
CREATE TABLE delivery.step_approval (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  job_id      uuid NOT NULL,
  job_step_id uuid NOT NULL,

  -- WHO MADE THE THING BEING CHECKED.
  --
  -- Never set by the caller. The trigger below DERIVES it from
  -- `job_step.performed_by`, because a `submitted_by` a writer could choose is
  -- not a maker-checker control at all — the way past the CHECK would be to
  -- name somebody else as the maker and then approve it yourself, which is the
  -- import-or-script-or-agent case the rule exists for.
  --
  -- Nullable for exactly one case: a step an agent COMMITTED unattended, where
  -- `performed_by` is null because no person made it. A machine has no self to
  -- approve, so maker != checker has nothing to compare and anybody eligible
  -- may check it. That is the correct reading, not a hole: the guardrail that
  -- decides whether a machine may act unattended at all is 0047's, and it ran
  -- before this row existed.
  submitted_by uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),

  -- The `verification_policy` VERSION that was in force when this check was
  -- asked for. Pinned, not joined — the registry's whole point, and the same
  -- move `agent_run.tier_version_id` and `job.template_version_id` make. A firm
  -- raising its review bar next quarter must not restate who was allowed to
  -- approve a filing last quarter.
  --
  -- Nullable, because a step may name no policy: the firm wants it checked but
  -- has published no rule about by whom. Then anybody with `work:write` who is
  -- not the maker may check it, which is strictly more than the nobody who
  -- could before.
  policy_version_id uuid,
  policy_key        text,

  decision   text NOT NULL DEFAULT 'pending'
             CHECK (decision IN ('pending', 'approved', 'rejected')),

  -- What the checker changed or objected to.
  --
  -- The capture-or-lose field of this table, and the demo names it as such:
  -- when work is sent back, WHY it was sent back is the only signal that ever
  -- explains rework. Marking the step done afterwards erases the fact that it
  -- was rejected twice.
  notes      text,

  decided_by uuid,
  decided_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT step_approval_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT step_approval_job_tenant_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  -- The composite key 0044 created for exactly this, in a comment that said so:
  -- "the composite-key target, for whatever T2.9 hangs off a step."
  CONSTRAINT step_approval_step_tenant_fkey
    FOREIGN KEY (job_step_id, tenant_id) REFERENCES delivery.job_step (id, tenant_id),
  -- Both by id alone, for the reason `job_step.performed_by` is: `user_account`
  -- is global.
  CONSTRAINT step_approval_submitter_fkey
    FOREIGN KEY (submitted_by) REFERENCES tenancy.user_account (id),
  CONSTRAINT step_approval_decider_fkey
    FOREIGN KEY (decided_by) REFERENCES tenancy.user_account (id),
  -- COMPOSITE, because `config.version` IS tenant-scoped. An id-only reference
  -- here would let one firm's approval pin another firm's review rule — a
  -- foreign-key check runs as a system operation RLS does not filter, so it
  -- would violate no policy anywhere and leak nothing, and the wall is still
  -- supposed to forbid it.
  --
  -- Found by `tenant-keys.integration.test.ts`, which asks the catalogue rather
  -- than a list, on the first run after this table existed. That is the test
  -- working: the two foreign keys above it point at `user_account`, which is
  -- GLOBAL and has no tenant to carry, and this one looked the same and is not.
  CONSTRAINT step_approval_policy_version_tenant_fkey
    FOREIGN KEY (policy_version_id, tenant_id) REFERENCES config.version (id, tenant_id),

  -- ── THE RULE THIS WHOLE TASK IS FOR ──────────────────────────────────────
  --
  -- The actor who produced an output can never be its approver. A CHECK, so it
  -- holds against a script, an import, an agent and a psql session, not only
  -- against the service that happens to call it today.
  --
  -- `submitted_by IS NULL` is the unattended-machine case above — there is no
  -- person to be the same as.
  CONSTRAINT step_approval_maker_is_not_checker CHECK (
    decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
  ),

  -- A decision has a decider and a time; a pending one has neither. Without
  -- this, "approved by nobody at no time" is representable, and it is the shape
  -- a half-written migration or a partial update leaves behind.
  CONSTRAINT step_approval_decided_evidence CHECK (
    (decision = 'pending'  AND decided_by IS NULL     AND decided_at IS NULL) OR
    (decision <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),

  -- Sending work back without saying why destroys the only signal that explains
  -- rework. Approving needs no note; rejecting does. The demo's rule, kept
  -- verbatim, and the same argument `job_step.outcome_note` makes about a note
  -- only ever written by somebody already in a hurry.
  CONSTRAINT step_approval_rejection_says_why CHECK (
    decision <> 'rejected' OR length(btrim(coalesce(notes, ''))) > 0
  )
);

CREATE TRIGGER trg_step_approval_updated_at BEFORE UPDATE ON delivery.step_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ── `submitted_by` IS DERIVED, NEVER SUPPLIED ───────────────────────────────
--
-- The CHECK above compares two columns. If a writer could choose both, the rule
-- is decorative: name somebody else as the maker, approve as yourself, and the
-- constraint is satisfied by a row that is a lie. So the maker is read from the
-- step at INSERT, and any value the caller passed is overwritten rather than
-- rejected — the caller has no business having an opinion, and an error here
-- would only be reachable by code that was already wrong.
--
-- It is also frozen on UPDATE. A decision is written later, by a different
-- request; nothing about that request may move the maker out from under the
-- comparison.
CREATE OR REPLACE FUNCTION delivery.derive_step_approval_maker() RETURNS trigger AS $fn$
DECLARE performer uuid;
BEGIN
  SELECT performed_by INTO performer
    FROM delivery.job_step
   WHERE id = NEW.job_step_id AND tenant_id = NEW.tenant_id;
  NEW.submitted_by := performer;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_step_approval_derive_maker BEFORE INSERT ON delivery.step_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.derive_step_approval_maker();

CREATE OR REPLACE FUNCTION delivery.freeze_step_approval_maker() RETURNS trigger AS $fn$
BEGIN
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
  OR NEW.job_step_id  IS DISTINCT FROM OLD.job_step_id
  THEN
    RAISE EXCEPTION
      'step_approval % cannot change who made the work it checks. Maker != checker is a comparison between two columns, and a rule whose left-hand side can be edited after the fact is not a rule.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_step_approval_maker_frozen BEFORE UPDATE ON delivery.step_approval
  FOR EACH ROW EXECUTE FUNCTION delivery.freeze_step_approval_maker();

-- ONE open check per step. A rejected step is re-done and re-submitted, and
-- that second attempt is a SECOND row — "it was sent back once" is part of the
-- record, exactly as a retried agent run is a second row in 0047. What must not
-- happen is two people opening a check on the same step at once and each
-- approving the other's.
CREATE UNIQUE INDEX idx_step_approval_one_open
  ON delivery.step_approval (job_step_id)
  WHERE decision = 'pending';

-- THE QUEUE'S READ: what is waiting to be checked, oldest first. Partial,
-- because a decided approval is almost the whole table within a year and never
-- the answer to "what is on my desk".
CREATE INDEX idx_step_approval_pending
  ON delivery.step_approval (tenant_id, submitted_at)
  WHERE decision = 'pending';

-- The job screen's read: every check this job has ever had, including the ones
-- that were sent back.
CREATE INDEX idx_step_approval_job ON delivery.step_approval (tenant_id, job_id);

ALTER TABLE delivery.step_approval ENABLE ROW LEVEL SECURITY;
CREATE POLICY step_approval_isolation ON delivery.step_approval
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- SELECT, INSERT, UPDATE — never DELETE, inherited from 0041's ALTER DEFAULT
-- PRIVILEGES on this schema. A rejection that was deleted is rework with no
-- record of why it happened.

RESET ROLE;
