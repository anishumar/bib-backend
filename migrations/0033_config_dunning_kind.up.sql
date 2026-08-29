-- 0033 · `dunning` joins the configuration registry's kinds
--
-- The ladder a firm chases receivables with — D+3, D+7, D+15 — is the registry's
-- own test case: numbers a partner changes, that must not need a deploy, and
-- whose history matters ("which ladder was in force when we put them on hold").
--
-- Adding a kind is a code change as well as this one, and deliberately: each
-- kind needs a body validator in `domain/config/model.ts`, and a kind without
-- one accepts anything. `validateDunningBody` is that validator.
--
-- Nothing is seeded. A firm with no published ladder chases nobody, which is the
-- safe direction — the alternative is this product inventing an escalation
-- policy and sending a client a letter the firm never approved.
SET ROLE bib_owner;

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning'));

RESET ROLE;
