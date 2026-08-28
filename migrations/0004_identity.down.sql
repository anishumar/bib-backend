-- Reverse of 0004. Dropping these logs every user out and discards their
-- password hashes; user_account itself (the identity) is untouched.
SET ROLE bib_owner;
DROP TABLE IF EXISTS tenancy.magic_link;
DROP TABLE IF EXISTS tenancy.session;
DROP TABLE IF EXISTS tenancy.credential;
RESET ROLE;
