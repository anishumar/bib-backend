-- 0394 down. Refuses while any proposal line is in a group: dropping the
-- column would leave those lines with no price and no reason.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.proposal_line WHERE fee_group_id IS NOT NULL) THEN
    RAISE EXCEPTION 'proposal lines are priced by fee groups; price them on their own before rolling back 0394';
  END IF;
END $$;

DROP VIEW crm.proposal_fee_item;

DROP TRIGGER trg_proposal_fee_group_currencies ON crm.proposal_fee_group;

CREATE OR REPLACE FUNCTION crm.check_document_currencies(kind text, doc uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  main    text;
  ref     text;
  orphan  text;
  repeats boolean;
BEGIN
  IF kind = 'proposal' THEN
    SELECT p.currency, p.ref INTO main, ref FROM crm.proposal p WHERE p.id = doc;
    IF main IS NULL THEN RETURN; END IF;
    SELECT l.currency INTO orphan
      FROM crm.proposal_line l
     WHERE l.proposal_id = doc AND l.removed_at IS NULL AND l.currency <> main
       AND NOT EXISTS (SELECT 1 FROM crm.proposal_fx_rate r
                        WHERE r.proposal_id = doc AND r.currency = l.currency)
     LIMIT 1;
    SELECT EXISTS (SELECT 1 FROM crm.proposal_fx_rate r
                    WHERE r.proposal_id = doc AND r.currency = main) INTO repeats;
  ELSE
    SELECT el.currency, el.ref INTO main, ref FROM crm.engagement_letter el WHERE el.id = doc;
    IF main IS NULL THEN RETURN; END IF;
    SELECT x.currency INTO orphan
      FROM (SELECT l.currency FROM crm.engagement_letter_line l
             WHERE l.engagement_letter_id = doc AND l.removed_at IS NULL
            UNION
            SELECT g.currency FROM crm.engagement_letter_fee_group g
             WHERE g.engagement_letter_id = doc AND g.removed_at IS NULL) x
     WHERE x.currency <> main
       AND NOT EXISTS (SELECT 1 FROM crm.engagement_letter_fx_rate r
                        WHERE r.engagement_letter_id = doc AND r.currency = x.currency)
     LIMIT 1;
    SELECT EXISTS (SELECT 1 FROM crm.engagement_letter_fx_rate r
                    WHERE r.engagement_letter_id = doc AND r.currency = main) INTO repeats;
  END IF;

  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION '% has fees in % and no exchange rate for %. Give % a rate first.',
      coalesce(ref, 'This document'), orphan, orphan, orphan
      USING ERRCODE = 'check_violation';
  END IF;
  IF repeats THEN
    RAISE EXCEPTION '% is already in %, so it needs no second rate for it.',
      coalesce(ref, 'This document'), main
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP TRIGGER trg_proposal_line_group_is_live ON crm.proposal_line;
DROP FUNCTION crm.refuse_proposal_line_in_removed_fee_group();
DROP TRIGGER trg_proposal_fee_group_keeps_its_lines ON crm.proposal_fee_group;
DROP FUNCTION crm.refuse_proposal_fee_group_without_its_lines();

DROP INDEX crm.idx_proposal_line_fee_group;
ALTER TABLE crm.proposal_line DROP CONSTRAINT proposal_line_unpriced_needs_reason_chk;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL);
ALTER TABLE crm.proposal_line
  DROP CONSTRAINT proposal_line_grouped_is_unpriced_chk,
  DROP CONSTRAINT proposal_line_fee_group_fkey,
  DROP COLUMN fee_group_id;

DROP TABLE crm.proposal_fee_group;

RESET ROLE;
