-- 0058 · the escalation ladder — who gets told when work goes quiet (T4.5)
--
-- T3.1 put tasks on desks and T3.2 gave every filing two dates: the statutory
-- one, which is the law's, and `internal_target_on`, which is the firm's own
-- T-X. 0052's own comment says out loud what was supposed to happen next —
-- "the escalation ladder fires on the internal target rather than the
-- statutory" — and nothing has ever fired. On the day this was written seven
-- work items were overdue, five of them on NOBODY's desk, and two filings had
-- passed their internal target with the statutory date still ahead. Every one
-- of those is a row this product already had and never looked at.
--
-- T3.3 is not this. That sweep fires the day a STATUTORY date passes, which is
-- the day the client's money is already gone; the whole point of a T-X target
-- is to be told before that. The two are deliberately separate ladders on
-- separate dates, and neither replaces the other.
--
-- ── WHY THE LADDER ITSELF IS NOT IN THIS TABLE ─────────────────────────────
--
-- The rungs — after how many days, and who gets told — are the FIRM's numbers,
-- they change, and a partner must be able to move them without a deploy. That
-- is the configuration registry's own test case, and `dunning` (0033) is the
-- precedent this follows exactly: one entry holds the whole ladder, a published
-- version is frozen, and "which ladder was in force when this fired" stays
-- answerable. Adding a kind is a code change as well as a migration —
-- `validateEscalationBody` in `domain/config/model.ts` is its validator, and a
-- kind without one accepts anything.
--
-- NOTHING IS SEEDED, and that is the decision rather than an omission. A firm
-- with no published ladder escalates nobody. The alternative is this product
-- inventing a number — "three days late and your partner hears about it" — that
-- no firm agreed to, and the wrong number here does not merely annoy: it
-- teaches everybody to ignore the one screen that exists to be believed.
--
-- ── WHAT THIS TABLE IS FOR, AND WHY IT CANNOT BE THE LEDGER ────────────────
--
-- `work_item.escalated` is an event, and the event is written. It is not enough
-- on its own: the sweep runs every morning and the item is still overdue, so
-- without a row to check the same rung fires again tomorrow, and the day after,
-- forever. T3.3 learned this exactly once — `resolved_at` exists for the same
-- reason — and the sentence is worth repeating because it is not obvious: THE
-- SWEEP'S `WHERE` CLAUSE CANNOT READ THE LEDGER. A notice row is what makes
-- "this rung has already been climbed on this item" a fact a query can use.
--
-- The unique index is what makes that structural rather than careful. The sweep
-- is at-least-once — pg-boss redelivers, a worker restarts mid-pass — and the
-- insert conflicting is how a duplicate is refused, exactly as
-- `UNIQUE (tenant, invoice, step)` does for dunning.
--
-- ── AND WHY THERE IS NO `cleared_at` ───────────────────────────────────────
--
-- The obvious extra column is one saying the notice is over. It would have no
-- writer that a JOIN does not already have: an escalation about a work item is
-- live exactly while that item is not in a terminal state, and one about an
-- unassigned item is live exactly while `assignee_user_id IS NULL`. A column
-- restating a fact two tables away is a column that can disagree with it, and
-- this repository has already paid for one of those. The queue reads the join.
--
-- ── WHO IT LANDS ON: THREE ANSWERS, AND THE THIRD IS A RANK ────────────────
--
--   assignee        the person holding it. A nudge, not an escalation yet.
--   manager         `membership.reports_to_user_id` — the firm's own chart,
--                   which G3.3 built and `usecase/verification` already walks.
--   grade_at_least  everybody at `staff_grade.rank` N or above.
--
-- The third is NOT resolved to a person, and that is the point of it. "Tell a
-- partner" means the queue is visible to every partner, not that one partner
-- was picked by the software and the others were told nothing — an escalation
-- routed to one desk is an escalation that dies when that desk is on leave.
-- So `min_grade_rank` is stored and the queue filters on the reader's own rank.
--
-- Every one of the three can resolve to NOBODY — an unassigned item has no
-- holder, a partner has nobody above them, a firm may have set no grades at
-- all. That is a real state and not a failure, so `note` says which, in a
-- sentence somebody reads, and the notice still fires. T3.1's `assignment_note`
-- is the same decision: an escalation nobody can be named for is exactly the
-- one somebody has to look at.

SET ROLE bib_owner;

CREATE TABLE delivery.escalation_notice (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- TWO NULLABLE COLUMNS AND A CHECK, not one `subject_id` with a type beside
  -- it. A polymorphic id cannot carry a foreign key, and a foreign key here is
  -- not decoration: it is half of the tenant wall. `(id, tenant_id)` composite,
  -- like every child row in this schema, so a notice in one firm can never
  -- point at another firm's work.
  work_item_id           uuid,
  obligation_instance_id uuid,

  -- The rung's own key from the published ladder — never an index. An index
  -- shifts when a firm inserts a rung, silently renaming history and re-firing
  -- every notice already sent.
  rung_key   text NOT NULL CHECK (btrim(rung_key) <> ''),

  -- Which of the three things the rung was watching. Stored because the same
  -- work item can be escalated for two different reasons — nobody holds it, and
  -- it is late — and a queue that could not tell them apart would read as one
  -- problem twice.
  watch text NOT NULL
    CHECK (watch IN ('work_item_due', 'work_item_unassigned', 'obligation_target')),

  -- SNAPSHOTTED from the ladder in force when it fired, so a later edit cannot
  -- make a notice that went out on time look early. `dunning_action.after_days`
  -- is the same decision.
  after_days integer NOT NULL CHECK (after_days >= 0),

  target text NOT NULL CHECK (target IN ('assignee', 'manager', 'grade_at_least')),

  -- Exactly one of these, or neither with a note — see the CHECK below.
  raised_to_user_id uuid REFERENCES tenancy.user_account(id),
  min_grade_rank    integer,
  note              text,

  -- The CALLER's calendar day, never `CURRENT_DATE`. A server in UTC and a firm
  -- in India disagree about what day it is for five and a half hours every
  -- morning, and this whole module is about being a day early rather than a day
  -- late. G3.2 and T3.3 both paid for this one.
  raised_on  date NOT NULL,
  -- Days past the date the rung watched, positive. Stored so the queue reads
  -- without recomputing it — `obligation.missed` carries `daysLate` for the
  -- same reason.
  days_past  integer NOT NULL CHECK (days_past >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT escalation_notice_subject_chk
    CHECK ((work_item_id IS NULL) <> (obligation_instance_id IS NULL)),

  -- A notice lands on ONE person, or on a RANK, or on nobody with a reason.
  -- Never on a person and a rank at once: "who is this for" would have two
  -- answers and the queue would show it twice.
  CONSTRAINT escalation_notice_landed_chk
    CHECK (
      (raised_to_user_id IS NOT NULL AND min_grade_rank IS NULL)
      OR (raised_to_user_id IS NULL AND min_grade_rank IS NOT NULL)
      OR (raised_to_user_id IS NULL AND min_grade_rank IS NULL
          AND note IS NOT NULL AND btrim(note) <> '')
    ),

  CONSTRAINT escalation_notice_work_item_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id)
    REFERENCES delivery.work_item (id, tenant_id),
  CONSTRAINT escalation_notice_obligation_tenant_fkey
    FOREIGN KEY (obligation_instance_id, tenant_id)
    REFERENCES delivery.obligation_instance (id, tenant_id)
);

COMMENT ON TABLE delivery.escalation_notice IS
  'One rung, climbed once, on one piece of work. The row exists so the nightly sweep can ask "has this already fired" in SQL — the ledger holds the same fact and a WHERE clause cannot read it.';

COMMENT ON COLUMN delivery.escalation_notice.min_grade_rank IS
  'Set when the rung escalates to a RANK rather than a person: the queue is visible to everybody at this rank or above. Not resolved to one desk on purpose — an escalation sent to a single partner dies while that partner is on leave.';

COMMENT ON COLUMN delivery.escalation_notice.note IS
  'Why nobody could be named — no holder, nobody above them, no grades set. The notice still fires: an escalation with no owner is precisely the one somebody has to look at.';

-- IDEMPOTENCE. Two partial indexes rather than one, because the subject is two
-- columns. Without these a redelivered sweep raises a second notice for a rung
-- already climbed, and the queue grows a row a day for as long as the work
-- stays open.
CREATE UNIQUE INDEX idx_escalation_notice_work_rung
  ON delivery.escalation_notice (tenant_id, work_item_id, rung_key)
  WHERE work_item_id IS NOT NULL;

CREATE UNIQUE INDEX idx_escalation_notice_obligation_rung
  ON delivery.escalation_notice (tenant_id, obligation_instance_id, rung_key)
  WHERE obligation_instance_id IS NOT NULL;

-- The queue's own read: what landed on one person, newest first.
CREATE INDEX idx_escalation_notice_recipient
  ON delivery.escalation_notice (tenant_id, raised_to_user_id, raised_on DESC);

-- And the rank-addressed half, which no recipient index can serve.
CREATE INDEX idx_escalation_notice_rank
  ON delivery.escalation_notice (tenant_id, min_grade_rank)
  WHERE min_grade_rank IS NOT NULL;

ALTER TABLE delivery.escalation_notice ENABLE ROW LEVEL SECURITY;
CREATE POLICY escalation_notice_isolation ON delivery.escalation_notice
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── the registry's tenth kind ──────────────────────────────────────────────

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier', 'verification_policy',
                    'compliance_policy', 'escalation'));

RESET ROLE;
