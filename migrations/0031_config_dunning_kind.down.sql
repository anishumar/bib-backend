-- Reverses 0031. Refuses if any firm has published a dunning ladder, which is
-- correct: going back means that configuration is no longer representable.
SET ROLE bib_owner;

ALTER TABLE config.entry DROP CONSTRAINT IF EXISTS entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause'));

RESET ROLE;
