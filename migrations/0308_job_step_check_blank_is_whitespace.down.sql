-- 0308 down · 0307's two CHECKs as they were, `btrim` over spaces only.
--
-- Safe to run by hand, twice, and halfway (the 0067 lesson). The old rule is
-- strictly weaker than the new one, so every row the new CHECKs accepted the
-- old ones accept too, and re-adding them cannot be refused by the data. Each
-- statement names its constraint with IF EXISTS on the way out, and the table
-- is never left without a rule on either column once this has finished.

SET ROLE bib_owner;

ALTER TABLE delivery.job_step_check
  DROP CONSTRAINT IF EXISTS job_step_check_label_is_text,
  DROP CONSTRAINT IF EXISTS job_step_check_not_applicable_says_why;

ALTER TABLE delivery.job_step_check
  ADD CONSTRAINT job_step_check_label_is_text CHECK (length(btrim(label)) > 0),
  ADD CONSTRAINT job_step_check_not_applicable_says_why CHECK (
    CASE WHEN outcome = 'not_applicable'
         THEN note IS NOT NULL AND length(btrim(note)) > 0 AND length(note) <= 500
         ELSE note IS NULL
    END
  );

RESET ROLE;
