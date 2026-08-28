-- 0021 · Which of the firm's own entities is contracting (G1.2)
--
-- A document says WHERE the work is — `crm.engagement_letter.jurisdiction`,
-- chosen at drafting and stored permanently — and has never said WHO on our
-- side is contracting. That is not a decoration. The firm operates several of
-- its own legal entities, and which one signs decides the governing law, the
-- courts, the tax treatment and who a client's counterparty actually is. The
-- letter that started this whole review was issued by the US entity and printed
-- Indian law and Delhi courts, and nothing in the schema could have caught it
-- because nothing in the schema knew who had issued it.
--
-- THE FIRM'S RULE, in its own words: "jahan ka client hota hai, wahan ki
-- entity" — the entity of the country the client is in — "with flexibility to
-- choose. But mostly UAE" where the firm has no entity. That is three things:
-- a default keyed on the client's country, an override per document, and a
-- FALLBACK for every country the firm is not in. All three are DATA here, not
-- an `if` in a service: the countries a firm operates in change without a
-- deploy, and the day the firm opens in Singapore the rule is one row.
--
-- STORED, NOT DERIVED. `issuing_entity_party_id` is a snapshot on the document,
-- resolved once when it is drafted. The preference rows below are the rule as
-- it stands TODAY; a letter must always say who actually issued it, and if that
-- were re-derived at read time then changing the rule next year would silently
-- restate every document ever issued. Same argument the letter's own
-- `jurisdiction` already makes, and the same one the pinned clause versions
-- make.
--
-- THE FOREIGN KEY POINTS AT `core.party`, not `core.legal_entity` — the same
-- decision G0.1 settled for the line's entity, and for a compatible reason: the
-- firm's own entities are parties in its own book, and nothing today requires
-- the firm to have registered itself as a legal entity before it can issue a
-- document. Tightening it later is one composite key and one constraint swap.
--
-- ── Why this migration REFUSES rather than backfills ────────────────────────
--
-- 0018's precedent, and 0020's, for the same two reasons — the freeze
-- (`trg_el_freeze`, 0019) refuses an UPDATE to a signed letter by any role, and
-- there is no honest value to write. NOT ONE ROW has ever recorded who issued
-- it; picking the firm's own party and writing it into thirty-three signed
-- contracts would put a contracting party into a legal document that the
-- document never named. That is worse than having no column at all, because it
-- would look like a fact.

SET ROLE bib_owner;

DO $$
DECLARE
  proposal_count bigint;
  letter_count   bigint;
BEGIN
  SELECT count(*) INTO proposal_count FROM crm.proposal;
  SELECT count(*) INTO letter_count   FROM crm.engagement_letter;

  IF proposal_count > 0 OR letter_count > 0 THEN
    RAISE EXCEPTION
      'migration 0021 adds a NOT NULL issuing entity to crm.proposal (% rows) and crm.engagement_letter (% rows), and neither can be backfilled: a signed letter is frozen by trg_el_freeze (0017, rewritten by 0019) so the UPDATE is refused by design, and no row has ever recorded who issued it — so any value written here would name a contracting party the document never named. This product has no production data — drop and re-create the database, run `npm run migrate`, then `npm run smoke` to re-seed. If you are reading this WITH REAL ISSUED DOCUMENTS in the table, do NOT disable the freeze: add issuing_entity_party_id as a NULLABLE column instead and require it only for documents drafted after this migration.',
      proposal_count, letter_count
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ── crm.firm_entity_preference ── the rule, as rows.
--
-- `client_jurisdiction` is the KEY: which of our entities serves clients in
-- that country. `'*'` is the FALLBACK — the row that answers for every country
-- the firm has no entity in, which for this firm is "mostly UAE". A wildcard
-- ROW rather than a nullable column, so the fallback is looked up by exactly
-- the same query as every deliberate exception and cannot be forgotten by a
-- code path that handles the specific case and not the general one.
--
-- `note` is why the row exists — "we bill APAC out of Singapore because of the
-- treaty". Firms make these decisions for reasons and the reason is worth more
-- than the row six months later.
CREATE TABLE crm.firm_entity_preference (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant(id),
  -- ISO 3166-1 alpha-2, or the wildcard. Stored normalised (upper case) so that
  -- 'ae' and 'AE' are one key to Postgres as well as to a person.
  client_jurisdiction  text NOT NULL
                       CHECK (client_jurisdiction = '*' OR client_jurisdiction ~ '^[A-Z]{2}$'),
  -- One of the FIRM's own parties. See the note above on why this is
  -- core.party rather than core.legal_entity.
  firm_entity_party_id uuid NOT NULL,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- UNIQUE SCOPE: one answer per country, per firm. Two rows for 'AE' is a rule
  -- whose result depends on which one the query happened to read first, and
  -- nobody would ever notice which.
  CONSTRAINT firm_entity_preference_one_per_jurisdiction UNIQUE (tenant_id, client_jurisdiction),
  CONSTRAINT firm_entity_preference_entity_tenant_fkey
    FOREIGN KEY (firm_entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT firm_entity_preference_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE TRIGGER trg_firm_entity_preference_updated_at
  BEFORE UPDATE ON crm.firm_entity_preference
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── the documents ── who issued it, permanently.
ALTER TABLE crm.proposal
  ADD COLUMN issuing_entity_party_id uuid NOT NULL,
  ADD CONSTRAINT proposal_issuing_entity_tenant_fkey
    FOREIGN KEY (issuing_entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

ALTER TABLE crm.engagement_letter
  ADD COLUMN issuing_entity_party_id uuid NOT NULL,
  ADD CONSTRAINT el_issuing_entity_tenant_fkey
    FOREIGN KEY (issuing_entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- Tenant first: RLS has already narrowed to a tenant by the time any of these
-- is used, and "what has this entity of ours issued" is the question an audit
-- of one of the firm's own companies asks.
CREATE INDEX idx_proposal_issuing_entity ON crm.proposal (tenant_id, issuing_entity_party_id);
CREATE INDEX idx_el_issuing_entity       ON crm.engagement_letter (tenant_id, issuing_entity_party_id);

-- ── every firm owns a fallback from the moment it exists ────────────────────
--
-- The same shape migration 0005 used for the role registry, and for the same
-- reason: `issuing_entity_party_id` is NOT NULL, so a firm with no preference
-- row could not draft anything at all, and "configure this before you can
-- write a proposal" is not a state to leave existing firms in. New firms get
-- theirs in `createTenant`, through a port, exactly as they get their roles.
--
-- The entity seeded is the FIRM ITSELF — `core.organization.is_firm_self`, the
-- flag this schema has carried since 0002 with nothing ever writing it. A firm
-- that operates one entity is now correct with no configuration at all; a firm
-- that operates several adds its entities and a row per country, and the note
-- on this row says plainly that nobody chose it.
DO $$
DECLARE
  t record;
  new_party uuid;
BEGIN
  FOR t IN
    SELECT tt.id, tt.name FROM tenancy.tenant tt
     WHERE NOT EXISTS (
       SELECT 1 FROM crm.firm_entity_preference p
        WHERE p.tenant_id = tt.id AND p.client_jurisdiction = '*'
     )
  LOOP
    SELECT o.party_id INTO new_party
      FROM core.organization o
     WHERE o.tenant_id = t.id AND o.is_firm_self
     LIMIT 1;

    IF new_party IS NULL THEN
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (t.id, 'organization', t.name)
      RETURNING id INTO new_party;

      INSERT INTO core.organization (party_id, tenant_id, legal_name, is_firm_self)
      VALUES (new_party, t.id, t.name, true);
    END IF;

    INSERT INTO crm.firm_entity_preference
      (tenant_id, client_jurisdiction, firm_entity_party_id, note)
    VALUES (t.id, '*', new_party,
            'Seeded by migration 0021: the firm itself issues its own documents until it says otherwise.');
  END LOOP;
END $$;

-- THE TENANT WALL, identical in shape to every other business table.
ALTER TABLE crm.firm_entity_preference ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_entity_preference_isolation ON crm.firm_entity_preference
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- Grants, and no DELETE — the same shape as every other table in `crm`. A firm
-- that no longer wants Singapore clients served by its Singapore entity points
-- that row at a different entity, which is the operation firms actually
-- perform; the row itself is the rule's key and outlives any one answer. The
-- fallback row in particular must always exist, because a document that cannot
-- name who is contracting is not a document.
GRANT SELECT, INSERT, UPDATE ON crm.firm_entity_preference TO bib_app;
