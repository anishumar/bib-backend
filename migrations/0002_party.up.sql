-- 0002 · party model (the core object graph)
--
-- Everything with a counterparty is a party: client groups, their legal
-- entities, directors, employees, vendors, and the firm's own staff. Modelling
-- directors/employees/shareholders as separate tables would put the same human
-- in many places with nothing joining them; here they are all effective-dated
-- RELATIONSHIPS between parties. This is the shared core both lanes build on.
--
-- Same tenant-wall pattern as 0001: every tenant-scoped table gets RLS keyed on
-- app.tenant_id, and bib_app is NOBYPASSRLS so it binds every business query.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram search on display_name

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA core FROM PUBLIC;
GRANT USAGE ON SCHEMA core TO bib_app;

SET ROLE bib_owner;

-- ── party ── the abstract counterparty. Two subtypes: organization, person.
CREATE TABLE core.party (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  kind         text NOT NULL CHECK (kind IN ('organization', 'person')),
  display_name text NOT NULL,          -- denormalised so lists/search span both subtypes
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_party_updated_at BEFORE UPDATE ON core.party
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_party_tenant ON core.party (tenant_id);
CREATE INDEX idx_party_name_trgm ON core.party USING gin (display_name gin_trgm_ops);

-- ── organization ── a party that is a company/firm/trust/authority.
CREATE TABLE core.organization (
  party_id     uuid PRIMARY KEY REFERENCES core.party(id),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  legal_name   text NOT NULL,
  trade_name   text,
  industry     text,
  website      text,
  is_firm_self boolean NOT NULL DEFAULT false,   -- the firm operating this tenant; one per tenant
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organization_updated_at BEFORE UPDATE ON core.organization
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE UNIQUE INDEX organization_firm_self_key ON core.organization (tenant_id) WHERE is_firm_self;

-- ── person ── a party that is a human being.
CREATE TABLE core.person (
  party_id      uuid PRIMARY KEY REFERENCES core.party(id),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  full_name     text NOT NULL,
  nationality   text,
  date_of_birth date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_person_updated_at BEFORE UPDATE ON core.person
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── legal_entity ── an organization registered in a jurisdiction: the thing an
-- engagement is delivered to and a statutory obligation attaches to. A client
-- with four entities in four countries has many engagements — which is why a
-- "client" cannot be the root of the model.
CREATE TABLE core.legal_entity (
  party_id           uuid PRIMARY KEY REFERENCES core.organization(party_id),
  tenant_id          uuid NOT NULL REFERENCES tenancy.tenant(id),
  jurisdiction       text NOT NULL,                 -- ISO 3166-1 alpha-2: IN, SG, AE, US, GB
  entity_type        text NOT NULL,                 -- private_limited, llp, pte_ltd, fzco… data, not an enum
  incorporated_on    date,
  financial_year_end text,                          -- MM-DD; drives statutory deadlines later
  registered_address jsonb,
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'dormant', 'under_strike_off', 'struck_off', 'dissolved')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_legal_entity_updated_at BEFORE UPDATE ON core.legal_entity
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_legal_entity_jurisdiction ON core.legal_entity (tenant_id, jurisdiction);

-- ── party_identifier ── registration numbers and contact handles as ROWS, not
-- columns. An Indian company holds one PAN but one GSTIN PER STATE, so a gstin
-- column is wrong on day one. Dedup (phone+PAN+email) becomes one uniform
-- lookup rather than three. Type is a CLOSED set — each carries known validation.
CREATE TABLE core.party_identifier (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  party_id     uuid NOT NULL REFERENCES core.party(id),
  type         text NOT NULL CHECK (type IN (
                 'pan', 'gstin', 'cin', 'llpin', 'tan', 'din',
                 'uen', 'trn', 'ein', 'crn',
                 'vat', 'passport', 'email', 'phone', 'other')),
  value        citext NOT NULL,
  jurisdiction text,                                -- IN-MH for a state-scoped GSTIN, IN, SG…
  is_primary   boolean NOT NULL DEFAULT false,
  valid_from   date NOT NULL,
  valid_to     date,                                -- null = still in force
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_party_identifier_updated_at BEFORE UPDATE ON core.party_identifier
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_party_identifier_party ON core.party_identifier (party_id);
CREATE INDEX idx_party_identifier_lookup ON core.party_identifier (tenant_id, type, value);

-- ── relationship_type ── a GLOBAL, product-owned lookup (like a currency list).
-- The set is open to US, not to a tenant: HR adds reports_to, the cap table adds
-- beneficial_owner_of. A firm-editable set is a later feature (a screen); for now
-- these are the product's standard types. No tenant_id, no RLS, read-only to the app.
CREATE TABLE core.relationship_type (
  code          text PRIMARY KEY,
  label         text NOT NULL,           -- reads as "{from} is {label} {to}"
  inverse_label text NOT NULL,
  category      text NOT NULL            -- governance, employment, ownership, commercial…
);
INSERT INTO core.relationship_type (code, label, inverse_label, category) VALUES
  ('director_of',             'a director of',              'has director',              'governance'),
  ('authorised_signatory_of', 'an authorised signatory of', 'has authorised signatory',  'governance'),
  ('shareholder_of',          'a shareholder of',           'has shareholder',           'ownership'),
  ('parent_of',               'the parent of',              'a subsidiary of',           'ownership'),
  ('employee_of',             'an employee of',             'employs',                   'employment'),
  ('client_of',               'a client of',                'serves',                    'commercial');

-- ── party_relationship ── the single most important table. Directorship,
-- shareholding, employment, parent/subsidiary, authorised-signatory, client-of —
-- all here, EFFECTIVE-DATED. Compliance never asks "who is a director"; it asks
-- "who was a director on 31 March". Retrofitting the dates later means rewriting
-- every module on top, so valid_from/valid_to are not optional.
CREATE TABLE core.party_relationship (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  from_party_id uuid NOT NULL REFERENCES core.party(id),
  to_party_id   uuid NOT NULL REFERENCES core.party(id),
  type          text NOT NULL REFERENCES core.relationship_type(code),
  valid_from    date NOT NULL,
  valid_to      date,                               -- null = open-ended, still in force
  attributes    jsonb NOT NULL DEFAULT '{}',        -- shareholding %, share class, designation, DIN…
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_relationship_dates_chk CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT party_relationship_not_self_chk CHECK (from_party_id <> to_party_id)
);
CREATE TRIGGER trg_party_relationship_updated_at BEFORE UPDATE ON core.party_relationship
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_party_relationship_from ON core.party_relationship (tenant_id, from_party_id, type);
CREATE INDEX idx_party_relationship_to ON core.party_relationship (tenant_id, to_party_id, type);

-- THE TENANT WALL on every tenant-scoped table. tenant_id must equal
-- app.tenant_id (NULLIF(..., '') so the unset/pooled-placeholder case is NULL →
-- predicate false → zero rows, never an error). relationship_type is global
-- product data and is deliberately NOT under RLS.
ALTER TABLE core.party              ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.organization       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.person             ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.legal_entity       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.party_identifier   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.party_relationship ENABLE ROW LEVEL SECURITY;

CREATE POLICY party_isolation ON core.party
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY organization_isolation ON core.organization
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY person_isolation ON core.person
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY legal_entity_isolation ON core.legal_entity
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY party_identifier_isolation ON core.party_identifier
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY party_relationship_isolation ON core.party_relationship
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- Grants. RLS still applies to bib_app; these decide verbs, never rows.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE ON TABLES TO bib_app;

-- relationship_type is OURS, not the tenant's: readable by the app, never
-- writable by it. (A firm-editable set arrives later as its own screen.)
REVOKE INSERT, UPDATE ON core.relationship_type FROM bib_app;
