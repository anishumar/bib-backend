-- Reverses 0016. Any `clause` rows go first: the narrower CHECK cannot be added
-- while rows violate it, and silently deleting a firm's contract wording to make
-- a constraint fit would be the worst possible reading of "down".
SET ROLE bib_owner;

DELETE FROM config.version v
  USING config.entry e
  WHERE v.entry_id = e.id AND e.kind = 'clause';
DELETE FROM config.entry WHERE kind = 'clause';

ALTER TABLE config.entry
  DROP CONSTRAINT IF EXISTS entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check CHECK (kind IN ('service', 'role', 'policy'));

RESET ROLE;
