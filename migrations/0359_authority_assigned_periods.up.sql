-- 0359 · A client's return period, as the tax authority assigned it (Q073)
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- The UAE's FTA gives every VAT registrant its own tax period: monthly, or
-- quarterly on one of three staggers (quarters starting Jan/Apr/Jul/Oct,
-- Feb/May/Aug/Nov or Mar/Jun/Sep/Dec). A client on the February stagger files
-- for February-April, due 28 May. It follows neither the rule's year nor the
-- client's year end (0358), so no rule could cut it. 10x (Ashish, Q073):
-- "Yes, will provide" each client's quarter.
--
-- Xero, Zoho Books and QuickBooks UAE keep this on the organisation's VAT
-- settings (frequency and period start). Karbon and TaxDome have nothing; a
-- firm types recurring jobs by hand.
--
-- ── THE ROW ─────────────────────────────────────────────────────────────────
--
-- `core.legal_entity_return_period`: one per client company per TAX, the tax
-- named as a rule's `module` is ("VAT"), upper-case. GENERIC: nothing here says
-- UAE, so Saudi VAT or a UK VAT stagger is the same row.
--   frequency    monthly | quarterly
--   first_month  quarterly only: the first month of its first quarter in the
--                calendar year, 1, 2 or 3 (Jan, Feb or Mar). Monthly: null.
-- A company changing stagger is the same row updated: filings already
-- generated stay, new periods follow, and the overlap guard of 0358 keeps the
-- two cuts from both covering a month.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────
--
-- `period_basis = 'authority_assigned'`: the rule's periods are the client's
-- assigned ones for the rule's module. A client with none recorded gets NO
-- filing (never a guess) and is listed on Setup. Such a rule must name its
-- module, which is what it is matched on.

SET ROLE bib_owner;

CREATE TABLE core.legal_entity_return_period (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),
  entity_party_id uuid NOT NULL,
  tax             text NOT NULL,
  frequency       text NOT NULL,
  first_month     smallint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT legal_entity_return_period_entity_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT legal_entity_return_period_one_per_tax UNIQUE (tenant_id, entity_party_id, tax),
  CONSTRAINT legal_entity_return_period_tax_shape CHECK (tax ~ '^[A-Z0-9][A-Z0-9 _-]{0,39}$'),
  CONSTRAINT legal_entity_return_period_frequency_check CHECK (frequency IN ('monthly', 'quarterly')),
  CONSTRAINT legal_entity_return_period_first_month CHECK (
    (frequency = 'monthly' AND first_month IS NULL)
    OR (frequency = 'quarterly' AND first_month BETWEEN 1 AND 3)
  )
);

COMMENT ON TABLE core.legal_entity_return_period IS
  'A client company''s return period as the tax authority assigned it, per tax (a rule''s module, e.g. VAT): '
  'monthly, or quarterly from first_month (1 Jan/Apr/Jul/Oct, 2 Feb/May/Aug/Nov, 3 Mar/Jun/Sep/Dec) (Q073, 0359).';

CREATE TRIGGER trg_legal_entity_return_period_updated_at
  BEFORE UPDATE ON core.legal_entity_return_period
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

ALTER TABLE core.legal_entity_return_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY legal_entity_return_period_isolation ON core.legal_entity_return_period
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- A period nobody assigns any more is taken off: a fact about the client that
-- stopped being true, not a record anybody has to explain (the filings it
-- produced stay).
GRANT SELECT, INSERT, UPDATE, DELETE ON core.legal_entity_return_period TO bib_app;

-- ── the rule's third basis ──────────────────────────────────────────────────

ALTER TABLE delivery.obligation_template DROP CONSTRAINT obligation_template_period_basis_check;
ALTER TABLE delivery.obligation_template
  ADD CONSTRAINT obligation_template_period_basis_check
    CHECK (period_basis IN ('rule_calendar', 'client_year_end', 'authority_assigned'));
ALTER TABLE delivery.obligation_template
  ADD CONSTRAINT obligation_template_assigned_needs_module
    CHECK (period_basis <> 'authority_assigned' OR (module IS NOT NULL AND btrim(module) <> ''));

ALTER TABLE delivery.obligation_instance DROP CONSTRAINT obligation_instance_period_basis_check;
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_period_basis_check
    CHECK (period_basis IN ('rule_calendar', 'client_year_end', 'rule_fallback', 'authority_assigned'));

RESET ROLE;
