-- Down for 0350. Client emails go back to the deployment's sender address
-- for every firm; Reply-To the SPOC is code, not this column.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant DROP COLUMN send_from_domains;

RESET ROLE;
