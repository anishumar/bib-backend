-- Drops the originator. Who set it stays in the ledger
-- (`engagement_letter.originator_set`); the code that reads it goes with this down.
SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.letter_originator_in_force;
DROP TABLE IF EXISTS crm.letter_originator;

RESET ROLE;
