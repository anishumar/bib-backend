-- 0307 down · no sub-step or review-point marks, and step_approval back to its
--             two-column key.
--
-- DESTROYS EVERY MARK. The ticks on sub-steps and review points exist nowhere
-- else (by design, there is no ledger event per tick), so somebody rescuing a
-- database should copy `delivery.job_step_check` first. The templates' lines
-- are untouched: they are in `config.version` bodies, which are frozen, and a
-- body naming lines this schema no longer records still parses.
--
-- Safe to run by hand, twice, and halfway (the 0067 lesson): the table goes
-- first, because its composite foreign key depends on the key dropped second,
-- and nothing here can be refused by the data, so there is no point at which a
-- refusal leaves a constraint half-removed. Both statements are IF EXISTS.
SET ROLE bib_owner;

DROP TABLE IF EXISTS delivery.job_step_check;

ALTER TABLE delivery.step_approval
  DROP CONSTRAINT IF EXISTS step_approval_id_step_tenant_key;

RESET ROLE;
