-- Reverses 0013. proposal_totals reads proposal_line_amount, so it goes first.
SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.proposal_totals;
DROP VIEW IF EXISTS crm.proposal_line_amount;

RESET ROLE;
