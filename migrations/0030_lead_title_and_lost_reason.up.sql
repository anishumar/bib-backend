-- 0030 · G3.1 — a lead has a name, and a closed one says why (build2 §4.4)
--
-- Three gaps on crm.lead, all of them found by looking at a LIST rather than at
-- a test, which is the lesson CLAUDE.md already records twice.
--
--   1. A lead has NO NAME. Every list renders the party instead, so a firm with
--      two opportunities for one client shows the same row twice and neither
--      says which is which.
--   2. A lost deal records THAT it was lost and never WHY. That is the one fact
--      that is obvious the day it closes and unrecoverable a month later, and
--      without it "what fee actually closes deals like this" has no GROUP BY.
--   3. `abandoned` was collapsed into `lost`. A client who went quiet is not a
--      client who chose a competitor: the first is a FOLLOW-UP problem and the
--      second is a PRICING problem, and one stage cannot tell a firm which of
--      its two fixable problems it has.

SET ROLE bib_owner;

-- ── title ── add nullable, backfill, SET NOT NULL. NO DEFAULT, deliberately.
--
-- The choice matters and it is not a formality:
--
--   A DEFAULT would be a standing invitation. It makes the column NOT NULL and
--   meaningless at the same time — every future insert that omits a title gets
--   the same constant, which is exactly the state this migration exists to end,
--   with a NOT NULL badge on it. The backfill below is a ONE-TIME statement for
--   rows written before the column existed; a default applies forever, to rows
--   written by callers who could perfectly well have said something.
--
--   The backfill value is the PARTY'S DISPLAY NAME because that is literally
--   what every list rendered for these rows already. Nothing is invented and no
--   row is given a name it never had — the migration writes down the name the
--   screen was showing. 'Untitled' would have been an invention that helps
--   nobody, and refusing to run (0018's answer) is wrong here: unlike a signed
--   letter there IS an honest value, and leads are not frozen.
--
--   It is a SNAPSHOT, not a view. A title that tracked display_name would be
--   the same column we already have; the point is that it can now diverge, so
--   the second opportunity can be called "FY27 statutory audit" while the first
--   stays "GST registration".
ALTER TABLE crm.lead ADD COLUMN title text;

UPDATE crm.lead l
   SET title = p.display_name
  FROM core.party p
 WHERE p.id = l.party_id
   AND l.title IS NULL;

ALTER TABLE crm.lead ALTER COLUMN title SET NOT NULL;

-- NOT NULL alone buys nothing here: "   " satisfies it and renders as the same
-- blank row. The rule the screen depends on is that a title is PRESENT.
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_title_present_chk CHECK (btrim(title) <> '');

-- ── lost_reason ── free text, and that is the decision, not laziness.
--
-- A dropdown of five reasons produces five reasons and the useful one is always
-- the sixth: "they went with the incumbent's audit partner", "our GST quote was
-- fine but they wanted one firm for both", "the CFO left". Those are what a
-- partner reads before repricing, and no enum anybody drafts today contains
-- them. Reporting on free text is a harder query and a better answer.
--
-- Nullable at the database level even though the SERVICE requires one on every
-- close: rows that closed BEFORE this migration have no honest value to write,
-- and inventing 'unknown' for them would put a reason in the column that nobody
-- ever gave. NULL here means "nobody was asked", which is true.
ALTER TABLE crm.lead ADD COLUMN lost_reason text;

-- ── abandoned ── a new terminal stage, and everything that follows from it.
--
-- Four objects mention the stage set, and all four move together. Missing any
-- one of them is how a constraint drifts from the vocabulary it constrains.

-- (1) The stage vocabulary itself.
ALTER TABLE crm.lead DROP CONSTRAINT lead_stage_check;
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_stage_check CHECK (
    stage IN ('new', 'contacted', 'qualified', 'converted', 'lost', 'abandoned')
  );

-- (2) A closed lead has a closing date and an open one does not. `abandoned` is
--     TERMINAL — a prospect who went quiet and later came back is a second
--     opportunity, counted as two attempts, exactly like a lost one.
ALTER TABLE crm.lead DROP CONSTRAINT lead_closed_when_terminal_chk;
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_closed_when_terminal_chk CHECK (
    (stage IN ('converted', 'lost', 'abandoned')     AND closed_at IS NOT NULL) OR
    (stage NOT IN ('converted', 'lost', 'abandoned') AND closed_at IS NULL)
  );

-- (3) THE MERGE RULE. This is the one that would have been silently wrong: an
--     abandoned lead left inside the index's WHERE clause still counts as OPEN,
--     so the party it belongs to could never be captured again — a prospect who
--     went quiet would be blocked from the pipeline forever, by the index that
--     exists to stop DUPLICATES.
DROP INDEX crm.lead_one_open_per_party;
CREATE UNIQUE INDEX lead_one_open_per_party ON crm.lead (party_id)
  WHERE stage NOT IN ('converted', 'lost', 'abandoned');

-- (4) A reason belongs to a lead that did not close WON.
--
--     `converted` is excluded on purpose: a won deal has no lost reason, and a
--     column that accepts one would collect notes nothing ever reads. In the
--     database rather than the service because the point of a database rule is
--     that it holds when the service is bypassed — an import, a backfill or a
--     psql session at 2 a.m. all go straight past a check in TypeScript.
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_lost_reason_scope_chk CHECK (
    lost_reason IS NULL OR stage IN ('lost', 'abandoned')
  ),
  ADD CONSTRAINT lead_lost_reason_present_chk CHECK (
    lost_reason IS NULL OR btrim(lost_reason) <> ''
  );

RESET ROLE;

-- No new grants: crm.lead's privileges are unchanged, and columns inherit the
-- table's. Still no DELETE — a lead that went nowhere is `lost` or `abandoned`,
-- and now it says which.
