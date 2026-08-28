-- 0019 · The signed-letter freeze stops enumerating columns (G1.0)
--
-- THE BUG. `crm.refuse_signed_change()` (0017) compared an EXPLICIT LIST of
-- `crm.engagement_letter` columns. A column not in that list was SILENTLY
-- EDITABLE AFTER SIGNATURE — no error, no log line, nothing to notice. Six
-- columns were already in that hole the day 0017 shipped:
--
--   proposal_id         where the letter came from
--   sent_at             when it went out
--   signature_reference the provider's envelope id / the paper reference —
--                       half of the evidence that the signature is real
--   withdrawn_at        a signed letter cannot be withdrawn; nothing said so
--   created_at          when it existed from
--   id                  the identity of the document itself
--
-- and G1.1–G1.8 are about to add a dozen more (`ref`, `issuing_entity_party_id`,
-- `background`, `addressed_to_party_id`, `issued_on`, `effective_from`, the
-- firm's signature block, the line detail), every one of which is part of what
-- the client agreed to. This migration lands FIRST, before any of those columns
-- exists, so each one is protected the day it is created rather than the day
-- somebody remembers.
--
-- THE FIX: INVERT THE RULE. Enumerate what may STILL MOVE — three columns, all
-- of which have a written reason — and refuse everything else by comparing the
-- whole row. `to_jsonb(NEW) - mutable` against `to_jsonb(OLD) - mutable` is the
-- entire test, so the freeze's coverage is a property of the TABLE rather than
-- of a list somebody maintains alongside it. The asymmetry that made this easy
-- to miss also goes away: the line and clause triggers already refuse ANY write
-- to a signed letter's children, and now the head trigger reads the same way.
--
-- WHY THE ALLOW-LIST IS A FUNCTION and not an array literal inside the trigger:
-- so that the test which proves the freeze can ASK for it instead of keeping a
-- second copy. A list duplicated in a test drifts from the one in force, and
-- the drift is invisible in exactly the direction that matters — the test still
-- passes while the freeze has been widened.
--
-- WHAT IS DELIBERATELY NOT CHANGED: the line and clause triggers
-- (`crm.refuse_signed_child_change`) already refuse any write and need nothing;
-- the DELETE arm is 0017's, unchanged; and nothing here relaxes the freeze —
-- the set of columns a signed letter may still move is exactly the set 0017
-- intended, minus the six it left open by accident.

SET ROLE bib_owner;

-- ── THE ALLOW-LIST ── the only columns of a signed engagement letter that may
-- still change, each with the reason it is here:
--
--   advance_recorded_at / advance_recorded_by
--     The advance-fee gate. A person attests that the money arrived AFTER the
--     letter is signed — that is the whole sequence — and recording it is what
--     releases the engagements from `pending_advance`. It records a fact about
--     the world, not a term of the agreement.
--   updated_at
--     Written by `trg_el_updated_at` on every UPDATE. It is bookkeeping about
--     the row, not content of the document. It is listed even though that
--     trigger currently fires AFTER this one (`trg_el_freeze` sorts first, and
--     Postgres runs same-event triggers in name order), because relying on
--     trigger ORDER for correctness means a trigger renamed in 2027 freezes the
--     advance gate solid and nobody connects the two.
--
-- Adding a fourth entry means arguing that the thing it names is not part of
-- what the client agreed to. `tests/architecture/signed-letter-freeze.integration.test.ts`
-- holds the build red until somebody does that argument out loud.
CREATE OR REPLACE FUNCTION crm.signed_letter_mutable_columns() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ARRAY['advance_recorded_at', 'advance_recorded_by', 'updated_at'] $$;

COMMENT ON FUNCTION crm.signed_letter_mutable_columns() IS
  'The columns of a signed crm.engagement_letter that may still be written. Everything else is frozen by crm.refuse_signed_change(). One definition, two consumers: the trigger and the test that proves it.';

CREATE OR REPLACE FUNCTION crm.refuse_signed_change() RETURNS trigger AS $$
DECLARE
  mutable  CONSTANT text[] := crm.signed_letter_mutable_columns();
  changed  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION
        'engagement letter % is signed and cannot be deleted: it is the record of what the client agreed to. Supersede it with a new letter instead.',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'signed' THEN
    RETURN NEW;
  END IF;

  -- The whole row, minus the three columns above. A column added next month is
  -- inside this comparison the moment it exists.
  IF to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable THEN
    -- Name the columns. "Frozen" with no subject sends the reader to the
    -- trigger source to work out which field their statement touched.
    SELECT string_agg(c.key, ', ' ORDER BY c.key)
      INTO changed
      FROM jsonb_each(to_jsonb(NEW) - mutable) AS c
     WHERE c.value IS DISTINCT FROM (to_jsonb(OLD) -> c.key);

    RAISE EXCEPTION
      'engagement letter % is signed and frozen: it is the record of what the client agreed to, and it must read tomorrow exactly as it reads today. This statement changes %. Supersede it with a new letter instead of editing this one.',
      OLD.id, coalesce(changed, 'its columns') USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself is 0017's and is not recreated: CREATE OR REPLACE FUNCTION
-- swaps the body under it. Recreating the trigger would drop and re-add it,
-- which is a window — however short — in which a signed letter is editable.

RESET ROLE;
