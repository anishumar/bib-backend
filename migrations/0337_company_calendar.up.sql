-- 0337: each of the firm's companies may keep its own financial year and time
-- zone. Sid, 2026-10-04: "region wise financial year selection and time zone to
-- be considered". Design: bib/prompts/company-calendar/SPEC.md; the research it
-- rests on: bib/reports/Per company fiscal year and timezone.md.
--
-- WHERE IT LIVES. On core.legal_entity, beside the jurisdiction: an entity's
-- year end and its clock are legal facts about the entity, and the same two
-- columns will answer for a CLIENT entity's filings (Part B of the spec).
-- financial_year_end has been there since 0002 and was never read; a firm
-- company now stores the last day of the month before its year starts.
--
-- NULL MEANS THE FIRM'S, AND NOTHING IS BACKFILLED. Applying this changes no
-- firm's behaviour until it sets a value: the principle 0071 kept.
SET ROLE bib_owner;

ALTER TABLE core.legal_entity ADD COLUMN time_zone text;

COMMENT ON COLUMN core.legal_entity.time_zone IS
  'IANA zone whose calendar DAY dates this entity''s documents: for a firm company its invoices, '
  'letters, proposals, bill dates and billing periods. NULL = the firm''s tenancy.tenant.time_zone. '
  'Reminders to people stay on the firm''s day (0337).';

COMMENT ON COLUMN core.legal_entity.financial_year_end IS
  'MM-DD, the last day of the entity''s financial year. For a firm company (0337) the last day of a '
  'month: its invoice series year and its quarters and years are cut from the month after. NULL = '
  'the firm''s year (the compliance policy''s fiscalYearStartMonth).';

-- The firm's own trigger function (0071) checks NEW.time_zone too, but it is
-- written for a NOT NULL column; this one lets NULL through, which means "the
-- firm's".
CREATE FUNCTION core.assert_known_entity_time_zone() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- `pg_timezone_names` is the database's own list, so this cannot drift from
    -- what `AT TIME ZONE` accepts when a document is dated. An offset such as
    -- +05:30 is not on it, which is right: an offset cannot follow daylight
    -- saving, and the US company's clock moves twice a year.
    IF NEW.time_zone IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
      RAISE EXCEPTION
        'core.legal_entity.time_zone must be an IANA time zone this database knows; % is not (try Asia/Dubai, America/New_York)',
        NEW.time_zone
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER trg_legal_entity_time_zone_known
  BEFORE INSERT OR UPDATE OF time_zone ON core.legal_entity
  FOR EACH ROW EXECUTE FUNCTION core.assert_known_entity_time_zone();

-- A SERIES KEEPS THE YEAR IT STARTED WITH. Its label (2026-27, or 2026 for a
-- year that starts in January) was formatted from the LIVE setting, so changing
-- the year mid-series relabelled the numbers still to come. The month is fixed
-- when the row is created. Existing rows take the firm's current start month,
-- else April, so every label already drawn reads the same; the DEFAULT is that
-- same April, the year every series used before a firm could say otherwise, for
-- a raw insert that names none. The application always names it.
ALTER TABLE crm.invoice_series ADD COLUMN start_month smallint NOT NULL DEFAULT 4
  CONSTRAINT invoice_series_start_month_check CHECK (start_month BETWEEN 1 AND 12);

UPDATE crm.invoice_series s
   SET start_month = (v.body ->> 'fiscalYearStartMonth')::smallint
  FROM config.entry e
  JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
 WHERE e.tenant_id = s.tenant_id
   AND e.kind = 'compliance_policy' AND e.key = 'default'
   AND jsonb_typeof(v.body -> 'fiscalYearStartMonth') = 'number'
   AND (v.body ->> 'fiscalYearStartMonth') ~ '^(1[0-2]|[1-9])$';

COMMENT ON COLUMN crm.invoice_series.start_month IS
  'The month this series'' financial year starts in, fixed when its first number is drawn: the label '
  '(2026-27, or 2026 for a January year) is formatted from it, never from the live setting (0337).';

-- The zone a document of one of the firm's companies is dated in: the
-- company's own, else the firm's.
CREATE FUNCTION crm.issuer_zone(p_tenant uuid, p_party uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT le.time_zone FROM core.legal_entity le
      WHERE le.tenant_id = p_tenant AND le.party_id = p_party),
    (SELECT t.time_zone FROM tenancy.tenant t WHERE t.id = p_tenant))
$$;

COMMENT ON FUNCTION crm.issuer_zone(uuid, uuid) IS
  'The IANA zone a firm company''s documents are dated in: its own core.legal_entity.time_zone, else the firm''s tenancy.tenant.time_zone (0337).';

RESET ROLE;
