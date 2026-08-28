-- 0024 · The signed letter's children could be MOVED OFF it
--
-- THE BUG, found by the sweep G1.6 added to
-- tests/architecture/signed-letter-freeze.integration.test.ts — the same
-- forcing function 0019 built for the head, pointed at the line table for the
-- first time.
--
-- `crm.refuse_signed_child_change()` (0017) resolves the parent letter like
-- this:
--
--   parent_id := CASE TG_OP WHEN 'DELETE' THEN OLD.engagement_letter_id
--                           ELSE NEW.engagement_letter_id END;
--
-- On an UPDATE it therefore asks about the letter the row is moving TO, and
-- never about the one it is moving FROM. So:
--
--   UPDATE crm.engagement_letter_line
--      SET engagement_letter_id = <some draft letter>
--    WHERE id = <a line of a SIGNED letter>;
--
-- succeeds. A term is removed from a signed agreement, the letter's totals
-- change, its clause set is unaffected, and nothing anywhere raises. Verified
-- against the real schema before this migration was written: the composite key
-- `(engagement_letter_id, tenant_id, currency)` is satisfied by any draft letter
-- of the same firm in the same currency, which is exactly the letter somebody
-- would be drafting.
--
-- It is the same SHAPE of bug as the one 0019 fixed on the head: the trigger
-- was asking a narrower question than the rule it enforces. The rule is "the
-- terms of a signed letter cannot change"; the check was "the letter you are
-- writing to is not signed".
--
-- THE FIX: on an UPDATE, ask about BOTH parents and refuse if EITHER is signed.
-- Moving a line ONTO a signed letter was already refused and stays refused
-- (that is an INSERT's worth of new term on an agreement nobody re-signed);
-- moving one OFF is now refused too. The exception names which side objected,
-- because "the letter is signed" with two letters in the statement sends the
-- reader to the trigger source.
--
-- WHAT THIS DOES NOT CHANGE: the DELETE arm, the INSERT arm, and the ordinary
-- case where a line's parent does not move — `OLD.engagement_letter_id` and
-- `NEW.engagement_letter_id` are then the same id and the second lookup is the
-- same answer. Both triggers (`trg_el_line_freeze`, `trg_el_clause_freeze`) are
-- left in place and the function body is swapped underneath them, exactly as
-- 0019 did: recreating a trigger is a window, however short, in which a signed
-- letter's terms are editable.
--
-- Independent of 0023 and of everything else in flight. It rewrites one
-- function that has existed since 0017 and touches no column.

SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION crm.refuse_signed_child_change() RETURNS trigger AS $$
DECLARE
  old_parent uuid;
  new_parent uuid;
  frozen_id  uuid;
  moved      boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_parent := OLD.engagement_letter_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_parent := NEW.engagement_letter_id; END IF;

  -- The letter this row BELONGS TO is checked first, so a statement that both
  -- moves a row and edits it is refused by the side that owns the terms.
  IF old_parent IS NOT NULL
     AND (SELECT status FROM crm.engagement_letter WHERE id = old_parent) = 'signed' THEN
    frozen_id := old_parent;
    moved := new_parent IS DISTINCT FROM old_parent;
  ELSIF new_parent IS NOT NULL
     AND (SELECT status FROM crm.engagement_letter WHERE id = new_parent) = 'signed' THEN
    frozen_id := new_parent;
    moved := old_parent IS DISTINCT FROM new_parent;
  END IF;

  IF frozen_id IS NOT NULL THEN
    IF moved THEN
      RAISE EXCEPTION
        'engagement letter % is signed, so its terms are frozen — including which terms belong to it. This statement moves a % onto or off it. Supersede it with a new letter.',
        frozen_id, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION
      'engagement letter % is signed, so its terms are frozen. Supersede it with a new letter.',
      frozen_id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crm.refuse_signed_child_change() IS
  'Refuses any write to a line or clause of a SIGNED engagement letter, checking BOTH the letter the row belongs to and the one it is moving to. Checking only the latter (0017) let a term be moved off a signed letter onto a draft.';

RESET ROLE;
