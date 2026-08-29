-- 0047 · what a machine produced, how sure it was, and what it was allowed to
--        do about it (T2.8) — plus `confidence_tier`, the registry's seventh kind
--
-- ── THIS IS A GUARDRAIL BUILT BEFORE THE THING IT GUARDS ────────────────────
--
-- There are no agents. That is not a gap in this migration, it is the plan: get
-- what firms do manually into the product first, standardised and visible, then
-- replace some of it with machines. T2.7 finished the first half — every step
-- runs today with a person doing it.
--
-- The board says it plainly above Phase 4: **guardrails first, then
-- capabilities**. A rule written after the thing it restrains gets written by
-- whoever is already shipping that thing, and this rule decides whether a
-- machine may file a statutory return with the firm's name on it.
--
-- ── THE GUARDRAIL IS A CHECK, NOT A SERVICE RULE, AND THAT IS THE POINT ─────
--
-- `build2.md` puts it in the firm's own terms: *"a rule that lives in a form is
-- a rule that a script, an import or an AI agent walks straight past."* Here the
-- rule is ABOUT agents, so an agent stepping past it is not a hypothetical — it
-- is the literal failure mode. It has to hold against a psql session, a
-- backfill, and code nobody has written yet.
--
-- A CHECK cannot read the configuration registry, so the thresholds that applied
-- are COPIED onto the run at the moment of judgement. That is the same move
-- `delivery.job.split_code` and `job_step.executor` make, and it buys the same
-- two things: the constraint becomes expressible, and "why was this allowed"
-- survives the firm raising its bar next quarter.
--
-- ── `proposed` AND `applied` BOTH SURVIVE, FOREVER ──────────────────────────
--
-- Named in `build2.md` §5.2 as one of the demo's hardest-won rules with no home
-- yet: *"keeping only the corrected value is the obvious thing to do and throws
-- away the entire accuracy signal."* Keep only what a person ended up with and
-- "how often is this agent right" stops having an answer — which is the only
-- number that can ever justify moving a threshold.
--
-- Two CHECKs keep that number honest rather than merely collected: a
-- `corrected` outcome must ACTUALLY differ from the proposal, and an `accepted`
-- one must not. Without them the accuracy figure quietly becomes a lie told by
-- whoever was in a hurry.
--
-- ── AND NOTHING HERE IS SEEDED ──────────────────────────────────────────────
--
-- No tenant gets default thresholds. Roles and the grade ladder are seeded
-- because a firm without them is BROKEN — nobody can sign in, nobody meets a
-- review threshold. A firm without these is not broken, it is cautious: with no
-- published tier every agent output waits for a person, which is the discount
-- policy's rule reached from the same direction (*no published policy means
-- ZERO, not "no limit"*). So turning T2.8 on changes no firm's behaviour, which
-- is the property G2.4 established and this keeps.

SET ROLE bib_owner;

-- ── the registry's seventh kind ─────────────────────────────────────────────
--
-- In the registry rather than a table of its own because of the question it has
-- to answer: "why did this commit unattended?" is asked a year later, and the
-- only true answer is "the bar was 0.95 that day". A published version is frozen
-- and a run PINS the one it was judged under, so that answer survives. The grade
-- ladder went the other way for the opposite reason — nobody asks what a rung
-- meant last March.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier'));

-- ── one row per attempt a machine made at one step ──────────────────────────
CREATE TABLE delivery.agent_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  job_id       uuid NOT NULL,
  job_step_id  uuid NOT NULL,

  -- How sure the machine said it was. `numeric`, never a float: this value
  -- decides whether work goes out unattended, and a comparison that is right
  -- to within a rounding error is not right.
  confidence   numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- THE THRESHOLDS THAT APPLIED, copied at the moment of judgement. See the
  -- note above: a CHECK cannot read config, and the firm's bar moves.
  auto_commit_at numeric(4,3) NOT NULL CHECK (auto_commit_at >= 0 AND auto_commit_at <= 1),
  review_at      numeric(4,3) NOT NULL CHECK (review_at >= 0 AND review_at <= 1),
  -- The `config.version` those two came from. NULL is a real answer and the
  -- commonest one today: the firm has published no tier, so the run was judged
  -- by "never commit, always ask" — which is stored as (1, 0) above, needing no
  -- special case anywhere.
  tier_version_id uuid,

  decision     text NOT NULL CHECK (decision IN ('committed', 'queued', 'escalated')),

  -- WHETHER THE FIRM ASKED FOR A PERSON, whatever the numbers said — copied from
  -- the step's executor, which is where the firm actually expressed it.
  --
  -- Without this the band CHECKs below are wrong, and the fake that reproduces
  -- them is what found it: a step marked `agent_with_approval` queues at 0.99,
  -- and a `queued` row above the commit bar violated a constraint written as
  -- though the numbers were the only input. They are not. The template is the
  -- firm's own instruction and it outranks them.
  --
  -- It also answers a question somebody will ask: was this queued because the
  -- machine was unsure, or because we always want a person on this step? Those
  -- are different facts and only one of them is an argument for more training.
  approval_required boolean NOT NULL,

  -- What the machine produced, verbatim. jsonb because the shape belongs to
  -- whichever agent produced it and this table must not learn them all.
  proposed     jsonb NOT NULL,
  -- What actually stands. Equal to `proposed` on a commit or an acceptance,
  -- different on a correction, NULL while nobody has decided and on a rejection.
  applied      jsonb,

  -- What a PERSON did with it. NULL until somebody does.
  outcome      text CHECK (outcome IN ('accepted', 'corrected', 'rejected')),
  -- Why it was rejected, in words. Demanded by the schema for a rejection and
  -- forbidden otherwise, for `job_step.outcome_note`'s reason: the explanation
  -- is only ever written by somebody already in a hurry.
  rejected_reason text,
  decided_by   uuid REFERENCES tenancy.user_account(id),
  decided_at   timestamptz,

  -- WHAT PRODUCED IT. Not decoration: "extraction got worse in March" needs
  -- something to blame and something to revert, and a model or prompt swapped
  -- without a record is a regression nobody can attribute. NOT NULL from the
  -- start rather than added later, because adding it later means backfilling a
  -- fact nobody wrote down — the mistake `job_step.performed_by` avoided.
  model          text NOT NULL CHECK (btrim(model) <> ''),
  prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_run_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT agent_run_job_tenant_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  CONSTRAINT agent_run_step_tenant_fkey
    FOREIGN KEY (job_step_id, tenant_id) REFERENCES delivery.job_step (id, tenant_id),

  -- ── THE GUARDRAIL ────────────────────────────────────────────────────────
  --
  -- Unattended action requires the machine to have been STRICTLY above the bar
  -- that was in force. Strictly, and it is what makes 1.0 a real off switch: no
  -- confidence can exceed 1, so a firm that publishes `autoCommitAt: 1` has
  -- stopped every unattended commit with one edit and no deploy. With `>=`
  -- there would be no value meaning "never".
  CONSTRAINT agent_run_commit_needs_confidence CHECK (
    decision <> 'committed' OR (NOT approval_required AND confidence > auto_commit_at)
  ),
  -- And the other two bands, so a decision cannot disagree with the numbers it
  -- claims to have been made under. Without these the guardrail is only half
  -- expressed: a run could say `escalated` while sitting above the commit bar,
  -- and the accuracy record would describe a routing that never happened.
  CONSTRAINT agent_run_queue_band CHECK (
    decision <> 'queued' OR approval_required OR
    (confidence >= review_at AND confidence <= auto_commit_at)
  ),
  CONSTRAINT agent_run_escalate_band CHECK (
    decision <> 'escalated' OR confidence < review_at
  ),
  -- The pair has to describe a possible routing. Equal is allowed and means the
  -- machine either commits or escalates, with nothing merely proposed.
  CONSTRAINT agent_run_tiers_are_coherent CHECK (review_at <= auto_commit_at),

  -- ── THE ACCURACY SIGNAL, kept honest ─────────────────────────────────────
  --
  -- A correction that did not change anything is an acceptance somebody
  -- mis-clicked, and counting it as a correction understates the agent. An
  -- acceptance that changed something is a correction nobody recorded, and
  -- overstates it. Both directions are closed, because a number nobody can
  -- trust is worse than no number.
  CONSTRAINT agent_run_corrected_actually_differs CHECK (
    outcome IS DISTINCT FROM 'corrected' OR applied IS DISTINCT FROM proposed
  ),
  CONSTRAINT agent_run_accepted_does_not_differ CHECK (
    outcome IS DISTINCT FROM 'accepted' OR applied IS NOT DISTINCT FROM proposed
  ),
  CONSTRAINT agent_run_rejected_says_why CHECK (
    (outcome = 'rejected' AND rejected_reason IS NOT NULL AND applied IS NULL) OR
    (outcome IS DISTINCT FROM 'rejected' AND rejected_reason IS NULL)
  ),

  -- ── A DECISION IS WHOLE, OR IT HAS NOT HAPPENED ──────────────────────────
  --
  -- A committed run has no decider — nobody decided, that is what unattended
  -- means — and its `applied` is its own proposal, written at the same moment.
  -- A queued or escalated run has nothing until a person acts, and then has all
  -- of it at once.
  CONSTRAINT agent_run_commit_is_its_own_outcome CHECK (
    decision <> 'committed' OR
    (outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL
     AND applied IS NOT DISTINCT FROM proposed)
  ),
  CONSTRAINT agent_run_human_decision_is_whole CHECK (
    decision = 'committed' OR
    (outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL AND applied IS NULL) OR
    (outcome IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE TRIGGER trg_agent_run_updated_at BEFORE UPDATE ON delivery.agent_run
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ── WHAT THE MACHINE SAID CAN NEVER BE REWRITTEN ────────────────────────────
--
-- A trigger rather than trust, because the whole value of this table is that it
-- is EVIDENCE. If `proposed` or `confidence` can be edited after the fact then
-- an accuracy figure means nothing and neither does "we were allowed to commit
-- this". The demo enforced exactly this and proved it by bypassing the
-- application entirely, which is the only way such a claim is worth anything.
--
-- A person's decision is left mutable in the columns it owns — that is the half
-- that legitimately happens later.
CREATE OR REPLACE FUNCTION delivery.refuse_agent_run_rewrite() RETURNS trigger AS $$
BEGIN
  IF NEW.proposed       IS DISTINCT FROM OLD.proposed
  OR NEW.confidence     IS DISTINCT FROM OLD.confidence
  OR NEW.auto_commit_at IS DISTINCT FROM OLD.auto_commit_at
  OR NEW.review_at      IS DISTINCT FROM OLD.review_at
  OR NEW.tier_version_id IS DISTINCT FROM OLD.tier_version_id
  OR NEW.decision       IS DISTINCT FROM OLD.decision
  OR NEW.approval_required IS DISTINCT FROM OLD.approval_required
  OR NEW.model          IS DISTINCT FROM OLD.model
  OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
  THEN
    RAISE EXCEPTION
      'agent_run % records what a machine actually proposed, how sure it was and what it was allowed to do. Those cannot be rewritten — an accuracy figure and an audit of unattended action are only worth anything if they cannot be edited afterwards. Record a new run.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_run_no_rewrite BEFORE UPDATE ON delivery.agent_run
  FOR EACH ROW EXECUTE FUNCTION delivery.refuse_agent_run_rewrite();

-- One run per step is the ordinary case; a retry is a second row, deliberately,
-- because "it got it right the second time" is part of the accuracy record.
CREATE INDEX idx_agent_run_step ON delivery.agent_run (tenant_id, job_step_id, created_at);

-- "What is waiting on a person to check it" — the verification queue's read
-- (T2.9) and the job screen's. Partial, because a decided run is almost the
-- whole table within a year and never the answer.
CREATE INDEX idx_agent_run_undecided ON delivery.agent_run (tenant_id, decision, created_at)
  WHERE outcome IS NULL AND decision <> 'committed';

ALTER TABLE delivery.agent_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_run_isolation ON delivery.agent_run
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- SELECT, INSERT, UPDATE — never DELETE, inherited from 0041's ALTER DEFAULT
-- PRIVILEGES on this schema. A run that was deleted is an unattended action with
-- no record of having happened.

RESET ROLE;
