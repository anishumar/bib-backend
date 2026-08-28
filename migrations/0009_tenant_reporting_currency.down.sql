-- Reverses 0009. Dropping the column loses which currency each firm's stored
-- rates were struck against, so this is only ever safe before any money row
-- exists — which, at 0009, is the case: proposal lines land in 0010.
SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  DROP CONSTRAINT IF EXISTS tenant_reporting_currency_iso4217;
ALTER TABLE tenancy.tenant
  DROP COLUMN IF EXISTS reporting_currency;

RESET ROLE;
