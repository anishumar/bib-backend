-- 0074 — the inverse sentence for `parent_of`, so all six read as English.
--
-- `core.relationship_type` stores a relationship BOTH ways round, because one
-- row is read from two ends: on Priya's page it is "Priya is a director of
-- Cobalt Foods", and on Cobalt Foods' page it is "Cobalt Foods has director
-- Priya". `label` carries the first sentence and `inverse_label` the second.
--
-- WHY THIS IS A MIGRATION AND NOT A COMPONENT'S PROBLEM. Five of the six
-- inverse labels are verb phrases that complete "{to} … {from}" on their own —
-- `has director`, `employs`, `serves`, `has shareholder`,
-- `has authorised signatory`. `parent_of`'s is a NOUN phrase, `a subsidiary
-- of`, so the same template produces "Cobalt Logistics a subsidiary of Cobalt
-- Foods" — a missing verb, on the one relationship type this product uses most,
-- because a group's companies are how a portal contact reaches a sister
-- company.
--
-- The alternative was a screen that special-cased one code, which is a copy of
-- this table's data living in a component — the exact thing
-- GET /api/v1/parties/relationship-types was added to stop.
--
-- Nothing references the old string: the column had no reader at all until that
-- route existed, which is why this is a one-line data fix and not a rewrite.
UPDATE core.relationship_type
   SET inverse_label = 'is a subsidiary of'
 WHERE code = 'parent_of';
