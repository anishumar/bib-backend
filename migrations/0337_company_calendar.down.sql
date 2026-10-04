SET ROLE bib_owner;

DROP FUNCTION IF EXISTS crm.issuer_zone(uuid, uuid);

ALTER TABLE crm.invoice_series DROP COLUMN IF EXISTS start_month;

DROP TRIGGER IF EXISTS trg_legal_entity_time_zone_known ON core.legal_entity;
DROP FUNCTION IF EXISTS core.assert_known_entity_time_zone();

ALTER TABLE core.legal_entity DROP COLUMN IF EXISTS time_zone;

COMMENT ON COLUMN core.legal_entity.financial_year_end IS NULL;

RESET ROLE;
