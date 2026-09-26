-- 0309 down · back to one service per rule, and no withdrawn filings
--
-- WRITTEN TO BE RUN BY HAND, against a database somebody is trying to rescue
-- (0067's lesson): everything that can refuse runs BEFORE anything is
-- destroyed, and every step is safe to run twice.
--
-- ── WHAT IT REFUSES ────────────────────────────────────────────────────────
--
-- A WITHDRAWN FILING. The schema before 0309 has no way to keep a filing off
-- the calendar, so dropping the columns would put every withdrawn row back in
-- front of the firm, on the client's portal, into the nudges and into the
-- missed sweep, overturning a partner's removal with nobody deciding it. So the
-- down stops and names them. To go back anyway, decide first: add each filing
-- back to its service in the catalogue (the generator restores the rows), or
-- leave 0309 applied.
--
-- ── WHAT IT CANNOT RESTORE, AND SAYS SO ────────────────────────────────────
--
--   · A filing linked to TWO OR MORE services fits in the old one column only
--     as one of them. It keeps the EARLIEST link, which is the narrower,
--     safe direction: fewer clients reached, and the coverage screen names
--     the gap. A NOTICE gives the count.
--   · A filing linked to NO service goes back to NULL, which the code before
--     0309 reads as EVERY SERVICE. A confirmed one will reach every live
--     engagement in its country again: the behaviour that produced the 98
--     filings of 2026-09-18, and exactly the behaviour that code had. A NOTICE
--     gives the count.
--   · Removed links (the history) are dropped with the table.

SET ROLE bib_owner;

-- ── 1. refuse, before anything changes ─────────────────────────────────────
DO $$
DECLARE
  withdrawn integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'delivery' AND table_name = 'obligation_instance'
      AND column_name = 'withdrawn_at'
  ) THEN
    EXECUTE 'SELECT count(*) FROM delivery.obligation_instance WHERE withdrawn_at IS NOT NULL'
      INTO withdrawn;
  END IF;
  IF withdrawn > 0 THEN
    RAISE EXCEPTION
      '0309 down: % filing(s) were taken off the calendar when a service stopped including them, and the schema before 0309 cannot keep them off. Find them with: SELECT id, tenant_id, template_id, entity_party_id, period_label, withdrawn_at FROM delivery.obligation_instance WHERE withdrawn_at IS NOT NULL; add each filing back to its service in the catalogue first, or leave 0309 applied',
      withdrawn;
  END IF;
END $$;

-- ── 2. the old column, filled from the live links ──────────────────────────
ALTER TABLE delivery.obligation_template ADD COLUMN IF NOT EXISTS service_entry_id uuid;

DO $$
DECLARE
  several integer;
  none_confirmed integer;
BEGIN
  IF to_regclass('delivery.obligation_rule_service') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO several FROM (
    SELECT 1 FROM delivery.obligation_rule_service
    WHERE unlinked_at IS NULL
    GROUP BY tenant_id, lineage_id
    HAVING count(*) > 1
  ) s;

  -- The earliest live link of each chain, on every row of the chain: the old
  -- column was per row, and every row of a chain governed the same service.
  UPDATE delivery.obligation_template t
  SET service_entry_id = pick.service_entry_id
  FROM (
    SELECT DISTINCT ON (tenant_id, lineage_id) tenant_id, lineage_id, service_entry_id
    FROM delivery.obligation_rule_service
    WHERE unlinked_at IS NULL
    ORDER BY tenant_id, lineage_id, linked_at, id
  ) pick
  WHERE t.tenant_id = pick.tenant_id
    AND t.lineage_id = pick.lineage_id
    AND t.service_entry_id IS NULL;

  SELECT count(*) INTO none_confirmed
  FROM delivery.obligation_template t
  WHERE t.service_entry_id IS NULL AND t.status = 'confirmed' AND t.is_active
    AND t.due_rule IS NOT NULL AND t.recurrence <> 'event';

  IF several > 0 THEN
    RAISE NOTICE
      '0309 down: % filing(s) were on more than one service; each now names only the service it was first added to',
      several;
  END IF;
  IF none_confirmed > 0 THEN
    RAISE NOTICE
      '0309 down: % confirmed rule(s) with a formula are on no service; the code before 0309 reads that as every service, so they will reach every live engagement in their country',
      none_confirmed;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'obligation_template_service_tenant_fkey'
  ) THEN
    ALTER TABLE delivery.obligation_template
      ADD CONSTRAINT obligation_template_service_tenant_fkey
        FOREIGN KEY (service_entry_id, tenant_id) REFERENCES config.entry (id, tenant_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_obligation_template_service
  ON delivery.obligation_template (tenant_id, service_entry_id)
  WHERE service_entry_id IS NOT NULL;

-- ── 3. the withdrawn columns: the policy first, because it names one ───────
DROP POLICY IF EXISTS obligation_instance_portal_live ON delivery.obligation_instance;
ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_withdrawn_chk,
  DROP COLUMN IF EXISTS withdrawn_reason,
  DROP COLUMN IF EXISTS withdrawn_by_user_id,
  DROP COLUMN IF EXISTS withdrawn_at;

-- ── 4. the link table, and the key that proved a link names a service ──────
DROP TABLE IF EXISTS delivery.obligation_rule_service;
DROP FUNCTION IF EXISTS delivery.refuse_rule_service_change();
ALTER TABLE config.entry DROP CONSTRAINT IF EXISTS config_entry_id_tenant_kind_key;

RESET ROLE;
