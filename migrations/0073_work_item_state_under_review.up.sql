-- 0073 · the state that means "somebody else is checking this" (T3.1 / T2.9)
--
-- ── THE DEFECT THIS CLOSES, AND IT WAS FOUND BY USING THE PRODUCT ──────────
--
-- Press "Send for review" on a work item and the buttons become Approve / Send
-- back — while the header goes on reading **In Progress**. The firm's own
-- vocabulary already had a state called "Under Review", sitting in the state
-- dropdown, so the same fact had two answers: an open `work_item_approval` row,
-- and whatever a person had last set the state to. Nothing kept them in step,
-- and on a board organised BY STATE the task sat in the wrong column while
-- somebody's queue said it was theirs.
--
-- ── WHY THE FIX IS A FLAG AND NOT A LOOKUP ────────────────────────────────
--
-- `requestReview` says out loud why it did not move the state: *"There is no
-- flag saying which of the firm's states means that, and comparing the code is
-- the one thing this module never does."* That reasoning is right and this
-- migration answers it rather than working around it. States are ROWS the firm
-- owns (0050) — it may call this one "With the reviewer", "QC" or nothing at
-- all — so the only thing code may read is a flag, exactly as it reads
-- `is_blocked`, `is_terminal`, `is_initial` and `is_success`.
--
-- ── THE THREE CHECKS ARE LOAD-BEARING, NOT TIDINESS ───────────────────────
--
-- `NOT blocked` is the sharp one. 0051's trigger demands a `blocked_reason` on
-- every row in a blocked state, and sending work for review has no reason to
-- give — a firm that ticked both would make every review request fail on a
-- field the admin never saw. `NOT terminal` and `NOT initial` are the same
-- argument as 0050's own pairs: finished work is not waiting to be checked, and
-- neither is work nobody has picked up.
--
-- ── AND NOTHING CHANGES FOR A FIRM THAT NAMES NO STATE ────────────────────
--
-- The default is false everywhere and no seed sets it, deliberately. A firm
-- that has not said which of its states means "being checked" gets exactly
-- today's behaviour: the review opens, the state stays where it is, and the
-- screen says so. This product does not get to decide that "Under Review" means
-- under review — that is the whole reason these are rows.

SET ROLE bib_owner;

ALTER TABLE delivery.work_item_state
  ADD COLUMN is_under_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.work_item_state.is_under_review IS
  'Work in this state is with a checker. Sending an item for review MOVES it here, so the board column and the open approval cannot disagree. At most one per firm; false everywhere until the firm says which of its own states means this, and a firm that never says keeps the old behaviour.';

ALTER TABLE delivery.work_item_state
  ADD CONSTRAINT work_item_state_review_is_not_blocked
    CHECK (NOT (is_under_review AND is_blocked)),
  ADD CONSTRAINT work_item_state_review_is_not_terminal
    CHECK (NOT (is_under_review AND is_terminal)),
  ADD CONSTRAINT work_item_state_review_is_not_initial
    CHECK (NOT (is_under_review AND is_initial)),
  -- Retiring the state work is automatically moved into would leave every
  -- review request refused by `StateRetired`. Refused here rather than
  -- discovered the next time somebody presses the button — 0050's own
  -- `work_item_state_initial_is_active`, for the same reason.
  ADD CONSTRAINT work_item_state_review_is_active
    CHECK (is_active OR NOT is_under_review);

-- AT MOST ONE per firm — 0052's partial-unique trick, and the same argument
-- 0050 makes about the starting state: with two, "where does work go when it is
-- sent to be checked" is a coin toss decided by whatever the query returned
-- first. Postgres cannot enforce "at least one" and nothing here wants it to:
-- none is a real and supported answer.
CREATE UNIQUE INDEX idx_work_item_state_one_under_review
  ON delivery.work_item_state (tenant_id) WHERE is_under_review;

RESET ROLE;
