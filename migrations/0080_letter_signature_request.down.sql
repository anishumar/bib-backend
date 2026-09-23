-- 0080 down. Drops the request rows with the table: they are the plumbing that
-- obtained a signature, and a signed letter records its envelope id in
-- `signature_reference` on its own frozen row, so no evidence goes with them.
SET ROLE bib_owner;

DROP TABLE crm.letter_signature_request;

RESET ROLE;
