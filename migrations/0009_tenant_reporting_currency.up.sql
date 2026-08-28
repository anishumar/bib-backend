-- 0009 · a firm's books have a currency, and it is not a config row
--
-- PREREQUISITE FOR T2.2. "Per-country quoting" means quoting an Abu Dhabi
-- client in AED while the firm's pipeline, targets and revenue read in INR.
-- Every priced line therefore stores an FX rate — and a rate is meaningless
-- without knowing what it converts TO. Nothing in the schema carried a currency
-- at all before this, so the reporting currency had to exist before the first
-- money column did.
--
-- WHY A COLUMN AND NOT A `config` KIND. The registry is for what a firm changes
-- and re-publishes; this is the one thing about money it must not change. Every
-- rate ever stored was struck against this currency, so changing it later does
-- not restate history — it silently invalidates it, and every converted total
-- in the product becomes wrong with no error anywhere. A Publish button is the
-- wrong affordance for that. It is set once, at creation, and there is
-- deliberately no route that updates it.
--
-- GLOBAL: tenancy.tenant is the platform's registry of firms — it IS the set of
-- tenants, so it has no tenant_id and no RLS. See 0001.

SET ROLE bib_owner;

-- Added nullable, backfilled, then made NOT NULL — in that order, and with no
-- DEFAULT at any point. A default would mean a firm can be provisioned without
-- anybody stating what its books are in, which is precisely the silent-wrong
-- outcome above wearing a different hat. New rows must say.
ALTER TABLE tenancy.tenant
  ADD COLUMN reporting_currency text;

-- The firms that predate the column. INR because this product's first market is
-- India — the party model's identifiers are PAN and GSTIN, and every tenant in
-- any environment today was created for it. If that is ever wrong for a real
-- firm it is wrong loudly (their totals read in the wrong currency on the first
-- screen), not silently.
UPDATE tenancy.tenant SET reporting_currency = 'INR' WHERE reporting_currency IS NULL;

ALTER TABLE tenancy.tenant
  ALTER COLUMN reporting_currency SET NOT NULL,
  -- ISO 4217 alphabetic, uppercase. A pattern rather than an enumerated list:
  -- onboarding a firm in a currency we have not seen must not be a deploy, and
  -- the check that would actually matter — whether an FX source quotes it — is
  -- not one the database can make.
  ADD CONSTRAINT tenant_reporting_currency_iso4217
    CHECK (reporting_currency ~ '^[A-Z]{3}$');

RESET ROLE;
