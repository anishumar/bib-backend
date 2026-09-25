-- 0306 · A commercial document names the RIGHT parties, not merely this firm's (F-10-1)
--
-- ── THE HOLE THE 2026-09-23 AUDIT FOUND ────────────────────────────────────
--
-- Every reference between commercial tables carries `(id, tenant_id)`, so a
-- row can only point at something of the SAME FIRM. That is the tenant wall,
-- and it holds. What it never said is that the thing pointed at is about the
-- SAME CLIENT, or plays the right PART:
--
--   * `crm.invoice.entity_party_id` is the firm's own company issuing a tax
--     invoice, and the gapless series is keyed on it. Any party of the firm
--     could be named — a client included — and the first such invoice opened a
--     numbered GST series in that client's name, which can never be renumbered.
--   * `crm.invoice.party_id` could name one of the firm's own companies: the
--     firm billing itself, a valid-looking write nobody wanted.
--   * `crm.invoice_line.engagement_id` could name ANOTHER client's engagement,
--     and the invoice PDF that lands in the billed client's portal then carries
--     somebody else's scope of work.
--   * `crm.engagement_letter.proposal_id` could name a quote made to a
--     different client, so the ledger's "drafted from quote" lineage lied.
--
-- The services now refuse each of these with a sentence (F-10-1). These
-- triggers are the wall under them, for the writers that are not those
-- services — an import, an agent, a script, a psql session — exactly as 0305
-- put a trigger under its own refusal.
--
-- ── "ONE OF THE FIRM'S OWN COMPANIES", DEFINED ONCE ────────────────────────
--
-- `crm.is_firm_entity` is the firm itself (`core.organization.is_firm_self`,
-- one per tenant) or any company a `crm.firm_entity_preference` row names as
-- the issuer for some country. That is exactly the list the invoice screen's
-- "Charged by" picker is built from, and the application asks THIS function
-- rather than restating it, so the picker, the service and the wall cannot
-- disagree about which companies are the firm's.
--
-- A consequence worth seeing: a company the firm stops naming in every
-- preference row stops being able to issue NEW invoices, while everything it
-- already issued stays exactly as it is (these fire on INSERT, and on UPDATE
-- only when the reference itself changes).
--
-- ── WHAT IS DELIBERATELY NOT A TRIGGER ─────────────────────────────────────
--
-- The letter's addressee and each line's company are checked against the
-- CLIENT'S STRUCTURE — who is recorded under it, and who holds a role in it —
-- ON A DAY. Relationships are effective-dated and are ended and back-dated as
-- a firm learns about them, so a trigger would be judging a signed letter by
-- a structure that changed after it was signed. That rule lives in the
-- service, where "on the firm's today, at the moment of drafting" is the
-- question actually being asked.
--
-- The issuing entity on a proposal and a letter is refused by the service and
-- NOT walled here: an invoice's issuer opens a legal number series, a quote's
-- does not, and ten integration fixtures write proposals and letters with
-- whatever entity they built. Walling the invoice is the one the audit asked
-- for, and the one whose mistake cannot be undone.

-- EVERY TRIGGER HERE IS NAMED TO SORT AFTER THE FREEZE ON ITS TABLE
-- (`trg_invoice_number_freeze`, `trg_invoice_line_freeze`, `trg_el_freeze`).
-- BEFORE triggers fire in name order, and a change to an issued invoice or a
-- signed letter must be refused as that, not as a question about who it names.

SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION crm.is_firm_entity(p_tenant uuid, p_party uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM core.organization o
                  WHERE o.tenant_id = p_tenant AND o.party_id = p_party AND o.is_firm_self)
      OR EXISTS (SELECT 1 FROM crm.firm_entity_preference f
                  WHERE f.tenant_id = p_tenant AND f.firm_entity_party_id = p_party)
$$;

COMMENT ON FUNCTION crm.is_firm_entity(uuid, uuid) IS
  'One of the firm''s own companies: the firm itself, or an issuer a firm_entity_preference row names (0306). The one definition the invoice picker, the services and the triggers share.';

-- ── The invoice: issued BY the firm, TO somebody who is not the firm ───────

CREATE OR REPLACE FUNCTION crm.invoice_names_the_right_parties() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Ids, never names, in these messages: they reach a server log, and a
  -- client's name is theirs to have erased.
  IF TG_OP = 'INSERT' OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id THEN
    IF NOT crm.is_firm_entity(NEW.tenant_id, NEW.entity_party_id) THEN
      RAISE EXCEPTION
        'party % is not one of the firm''s own companies, so it cannot issue an invoice',
        NEW.entity_party_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.party_id IS DISTINCT FROM OLD.party_id THEN
    IF crm.is_firm_entity(NEW.tenant_id, NEW.party_id) THEN
      RAISE EXCEPTION
        'party % is one of the firm''s own companies, so an invoice cannot bill it',
        NEW.party_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_parties
  BEFORE INSERT OR UPDATE OF party_id, entity_party_id ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION crm.invoice_names_the_right_parties();

-- An archived client gains no new invoice either — 0305's rule, reaching the
-- one commercial document it did not list. The same function, so the message
-- and the SQLSTATE are the ones every other commercial table already gives.
CREATE TRIGGER trg_invoice_party_not_archived
  BEFORE INSERT OR UPDATE OF party_id ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('party_id');

-- A series belongs to a company that issues invoices. `setSeriesPrefix` can
-- open one before any invoice exists, so the series is walled on its own.
CREATE OR REPLACE FUNCTION crm.invoice_series_is_the_firms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT crm.is_firm_entity(NEW.tenant_id, NEW.entity_party_id) THEN
    RAISE EXCEPTION
      'party % is not one of the firm''s own companies, so it has no invoice series',
      NEW.entity_party_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_series_is_the_firms
  BEFORE INSERT ON crm.invoice_series
  FOR EACH ROW EXECUTE FUNCTION crm.invoice_series_is_the_firms();

-- ── An invoice line bills the billed client's own engagement ───────────────

CREATE OR REPLACE FUNCTION crm.invoice_line_bills_the_clients_engagement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.engagement_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.engagement_id IS NOT DISTINCT FROM OLD.engagement_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM crm.engagement e
      JOIN crm.invoice i ON i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id
     WHERE e.id = NEW.engagement_id
       AND e.tenant_id = NEW.tenant_id
       AND e.party_id = i.party_id
  ) THEN
    RAISE EXCEPTION
      'engagement % is not an engagement of the client invoice % bills',
      NEW.engagement_id, NEW.invoice_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_line_is_the_clients
  BEFORE INSERT OR UPDATE OF engagement_id ON crm.invoice_line
  FOR EACH ROW EXECUTE FUNCTION crm.invoice_line_bills_the_clients_engagement();

-- ── A letter drafted from a quote is drafted from THAT CLIENT'S quote ──────

CREATE OR REPLACE FUNCTION crm.letter_quote_is_the_clients() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposal_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.proposal_id IS NOT DISTINCT FROM OLD.proposal_id
     AND NEW.party_id IS NOT DISTINCT FROM OLD.party_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm.proposal p
     WHERE p.id = NEW.proposal_id
       AND p.tenant_id = NEW.tenant_id
       AND p.party_id = NEW.party_id
  ) THEN
    RAISE EXCEPTION
      'proposal % is not a quote to the client engagement letter % is for',
      NEW.proposal_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_el_quote_is_the_clients
  BEFORE INSERT OR UPDATE OF proposal_id, party_id ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.letter_quote_is_the_clients();

RESET ROLE;
