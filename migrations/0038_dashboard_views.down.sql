-- Down for 0038. Newest-first, IF EXISTS throughout.
--
-- Safe in a way most downs here are not: these are VIEWS, so dropping them
-- destroys no data. Every figure they produce is derived from rows that stay
-- exactly where they are, and re-applying the up migration reproduces each one
-- byte for byte. That is the whole point of the acceptance criterion — a cached
-- column would have made this down migration lossy.

SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.receivable_ageing;
DROP VIEW IF EXISTS crm.engagement_mrr;

RESET ROLE;
