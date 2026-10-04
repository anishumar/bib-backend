-- 0350 · The domains a firm may send client email FROM (Q059, 2026-10-05).
--
-- Sid (4 Oct): client emails should come "preferably from the email of SPOC".
-- Every client email now carries Reply-To the client's SPOC (or Key Manager)
-- and their name in the display name; that needs no setting. Sending FROM that
-- person's own address needs the firm's mail domain to authorise the relay
-- (SPF and DKIM at the domain, and the relay allowed to send for it). Until it
-- does, a From in that domain is refused or lands in spam, so it is a list the
-- firm fills in only once that is set up: empty by default, and an address
-- whose domain is not on it never becomes a From.
--
-- Lower-case bare domains (`10xglobal.in`), at most twenty. The service
-- normalises and checks each one; the CHECK is the wall behind it.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  ADD COLUMN send_from_domains text[] NOT NULL DEFAULT '{}'
  CONSTRAINT tenant_send_from_domains_chk CHECK (
    cardinality(send_from_domains) <= 20
    AND array_to_string(send_from_domains, ',') ~ '^([a-z0-9][a-z0-9.-]*\.[a-z]{2,63}(,[a-z0-9][a-z0-9.-]*\.[a-z]{2,63})*)?$'
  );

COMMENT ON COLUMN tenancy.tenant.send_from_domains IS
  'Q059: mail domains the relay is authorised to send for (SPF/DKIM set up). A client email whose SPOC''s address is in one of them goes FROM that address; otherwise from the deployment''s sender with Reply-To the SPOC. Empty by default.';

RESET ROLE;
