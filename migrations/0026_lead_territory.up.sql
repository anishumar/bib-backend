-- 0026 · Where a prospect IS, and whose desk covers it (T2.1b)
--
-- T2.1b's acceptance has two halves and only one was built: "N leads captured
-- with no owner distribute evenly" (round-robin, done) and "A TERRITORY RULE
-- OVERRIDES THE ROTATION" (nothing). The board recorded the reason honestly —
-- the axis had never been chosen — and this migration chooses it, because the
-- reason it could not be chosen turns out to be concrete rather than a
-- conversation nobody had:
--
--   A LEAD HAS NO AXIS ON IT. Not geography, not industry, not service line.
--   `crm.lead` holds a title, a party, a source, a stage and an owner. There
--   was nothing for a territory rule to MATCH, so "which axis" was unanswerable
--   in the sense that mattered: whichever one was picked, the column did not
--   exist.
--
-- ── WHY GEOGRAPHY, AND WHY THIS COLUMN EARNS ITS PLACE ANYWAY ──────────────
--
-- `lead.jurisdiction` is worth adding even if territory assignment is never
-- switched on, which is what makes it the safe axis to commit to:
--
--   * Every other document in this product already keys on a jurisdiction — a
--     proposal's issuing entity (`issuerFor(tenant, clientJurisdiction)`), a
--     letter's own jurisdiction, a clause's scope, a standard prose block's.
--     The pipeline was the only stage that did not record it.
--   * `ProposalService.draft` TAKES `clientJurisdiction` and nothing supplies
--     it. A lead that converts re-asks a question the firm answered at capture,
--     and the answer decides which of the firm's own entities contracts.
--
-- NULLABLE, because a prospect's country genuinely is not always known when
-- somebody phones in — and an unknown country must not stop a capture. The
-- rotation is what answers for it, which is the honest fallback and the reason
-- there is no wildcard rule (see below).
--
-- Upper case is demanded rather than normalised, for the reason G1.8 gives
-- about a clause's terms: the value is COMPARED, and 'in' is what a comparison
-- would get.
--
-- ── THE RULE IS A TABLE, AND IT IS `firm_entity_preference`'S TWIN ─────────
--
-- CLAUDE.md's default for firm-editable data is a config-registry kind. This is
-- the same deviation `staff_grade` records, and here the precedent is exact:
-- `crm.firm_entity_preference` answers "which of our entities serves a client
-- in country X" as one row per country, and this answers "whose desk covers a
-- lead in country X". Same key, same shape, same screen. The registry's
-- versioning and pinning would buy nothing — nobody asks whose territory the UK
-- was last March, they ask whose it is now — and `UNIQUE (tenant, jurisdiction)`
-- is the property that matters, which a registry kind cannot express (its key
-- must be lower case, so a country code would be stored in a case the rest of
-- the product refuses).
--
-- ── NO WILDCARD ROW, DELIBERATELY, AND IT IS THE DIFFERENCE FROM 0021 ──────
--
-- `firm_entity_preference` needs a `'*'` fallback because a document that
-- cannot name who is contracting is not a document — there has to be an answer.
-- Assignment already has a better fallback than a wildcard: the ROTATION. A
-- lead in a country no rule covers goes to the emptiest desk, which is what the
-- firm wants and is a real decision rather than a catch-all row somebody has to
-- remember to maintain.

SET ROLE bib_owner;

-- Where the PROSPECT is. Not where the work is, and not where the firm is.
ALTER TABLE crm.lead ADD COLUMN jurisdiction text
  CONSTRAINT lead_jurisdiction_code_chk CHECK (jurisdiction ~ '^[A-Z]{2}$');

COMMENT ON COLUMN crm.lead.jurisdiction IS
  'ISO 3166-1 alpha-2, where the PROSPECT is. Nullable: often unknown at capture, and the rotation answers for an unknown country. Feeds territory assignment (T2.1b) and the issuing-entity rule when the lead converts.';

CREATE TABLE crm.territory_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- Scoped consciously: ONE desk per country per firm. Two rules for IN is not
  -- an operation anybody wants — it is an ambiguity a strategy would have to
  -- break arbitrarily, and arbitrary is the one thing an assignment rule must
  -- never be. So "set the rule for IN" is the only honest verb, as it is for
  -- crm.firm_entity_preference.
  jurisdiction  text NOT NULL
                CONSTRAINT territory_rule_code_chk CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  -- tenancy.user_account is GLOBAL (a login belongs to a person, never a
  -- tenant — ADR-02), so this is an id-only reference by design, exactly as
  -- crm.lead.owner_user_id is. The tenant-key guard asks only about references
  -- between TENANT-SCOPED tables, and correctly does not flag this one.
  --
  -- Whether that user is still active STAFF here is NOT a constraint: a
  -- membership is revoked without anybody remembering the territory table, and
  -- a foreign key cannot express "active". The strategy checks it at assignment
  -- time and DECLINES, so a rule naming somebody who left falls through to the
  -- rotation instead of parking leads on a dead desk.
  owner_user_id uuid NOT NULL REFERENCES tenancy.user_account (id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT territory_rule_one_per_country UNIQUE (tenant_id, jurisdiction)
);

ALTER TABLE crm.territory_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY territory_rule_isolation ON crm.territory_rule
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_territory_rule_updated
  BEFORE UPDATE ON crm.territory_rule
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

GRANT SELECT, INSERT, UPDATE ON crm.territory_rule TO bib_app;

COMMENT ON TABLE crm.territory_rule IS
  'Whose desk covers leads from a country. One row per country per firm; no wildcard, because the round-robin rotation is the fallback. Twin of crm.firm_entity_preference.';

RESET ROLE;
