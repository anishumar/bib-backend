-- 0392: proposal and letter numbers by the issuing company's country and year.
--
-- `27IN501` (a letter) and `PL27IN501` (a proposal): the financial year by the
-- year it ENDS (FY 2026-27 is 27), the issuing company's ISO country, and a
-- number from that country's run for that year, starting at the firm's first
-- number. Asked for by the user on 2026-10-13 for 10x Global.
--
-- ONE RUN PER COUNTRY, not per company: the reference names no company, so two
-- companies in one country would both draw `27IN501`. Documents already
-- numbered keep `EL-2026-0007`: they have gone to clients, and a signed letter
-- is frozen. The old series table stays as the history of those numbers.

SET ROLE bib_owner;

CREATE TABLE crm.document_ref_country_series (
  tenant_id     uuid    NOT NULL REFERENCES tenancy.tenant(id),
  document_type text    NOT NULL CHECK (document_type IN ('proposal', 'engagement_letter')),
  jurisdiction  text    NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  fy_end_year   integer NOT NULL CHECK (fy_end_year BETWEEN 2000 AND 9999),
  last_number   integer NOT NULL CHECK (last_number >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_ref_country_series_pkey PRIMARY KEY (tenant_id, document_type, jurisdiction, fy_end_year)
);

CREATE TRIGGER trg_document_ref_country_series_updated_at
  BEFORE UPDATE ON crm.document_ref_country_series
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

ALTER TABLE crm.document_ref_country_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_ref_country_series_isolation ON crm.document_ref_country_series
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The firm's first number of every run. A firm row exists only once it has
-- said one; with none, runs start at 1.
CREATE TABLE crm.document_numbering (
  tenant_id    uuid    PRIMARY KEY REFERENCES tenancy.tenant(id),
  first_number integer NOT NULL CHECK (first_number BETWEEN 1 AND 999999),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_document_numbering_updated_at
  BEFORE UPDATE ON crm.document_numbering
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

ALTER TABLE crm.document_numbering ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_numbering_isolation ON crm.document_numbering
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Both shapes: the numbers already issued, and the new ones.
ALTER TABLE crm.proposal
  DROP CONSTRAINT proposal_ref_shape_chk,
  ADD CONSTRAINT proposal_ref_shape_chk
    CHECK (ref ~ '^PR-[0-9]{4}-[0-9]{4,}$' OR ref ~ '^PL[0-9]{2}[A-Z]{2}[0-9]{3,}$');
ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT el_ref_shape_chk,
  ADD CONSTRAINT el_ref_shape_chk
    CHECK (ref ~ '^EL-[0-9]{4}-[0-9]{4,}$' OR ref ~ '^[0-9]{2}[A-Z]{2}[0-9]{3,}$');

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON crm.document_ref_country_series TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.document_numbering TO bib_app;
