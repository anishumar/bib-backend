-- 0334 · Who a document is from and to, printed and frozen (audit 2026-10-03:
-- B12 / CA#1, CA#18, CA#22).
--
-- The "Tax Invoice" named the firm's company and the client and nothing else:
-- no address, no state, no tax registration, no PAN. The firm's company form
-- had nowhere to hold its tax number, and a client had no address anywhere.
-- Letters printed "Registered in IN" under the firm's name. This migration
-- holds what was missing and freezes what a document printed when it went out.
--
-- WHAT IS NOT HERE, ON PURPOSE (waits for the firm, via Sid): the CGST / SGST /
-- IGST split, SAC codes, the place of supply, bank details, an LUT for exports
-- and e-invoicing. Whether BiB's invoice must be the firm's legal tax invoice
-- is the client's decision; this prints what is held, and claims no more.
--
-- 1. A CLIENT'S BILLING ADDRESS (CA#22) on `core.party`: a client is a company
--    or a person, and a person has no legal-entity row. The same shape as a
--    company's registered address (`domain/party/address.ts`): the printed
--    `lines`, then `region` (the state), `postalCode` and `country`. The firm's
--    own companies keep theirs in `core.legal_entity.registered_address`,
--    which gains `region` and `postalCode` in the same jsonb; no column moves.
--    Tax numbers, PAN, phone and email are IDENTIFIERS (`core.party_identifier`)
--    for the firm's companies exactly as they already were for clients.
--
-- 2. `crm.print_identity(party, day)`: the ONE reading of who a party is on
--    paper, on a day: its name, its address (billing, else registered), its
--    country, and the identifiers in force that day (the tax registration,
--    PAN, company number, phone, email) and its website. Security invoker, so
--    it reads under the caller's tenant like any other query.
--
-- 3. `printed_parties` on an invoice and a letter: that reading for both
--    parties, WRITTEN ONCE, by the statement that issues the invoice or sends
--    the letter, and never again (a trigger each). An issued invoice re-renders
--    with the names, addresses and numbers it went out with, whatever is
--    corrected afterwards (the copy-of-record note of 2026-09-29 asked for
--    exactly this). NULL on everything issued or sent before 0334: those
--    re-render as they always printed, byte for byte, and the render source
--    takes NULL on a document that is out to mean "the print before 0334".

SET ROLE bib_owner;

ALTER TABLE core.party
  ADD COLUMN billing_address jsonb
    CONSTRAINT party_billing_address_shape_chk
      CHECK (billing_address IS NULL OR (jsonb_typeof(billing_address) = 'object'
             AND jsonb_typeof(billing_address -> 'lines') = 'array'));

COMMENT ON COLUMN core.party.billing_address IS
  'Where this party is billed (0334): {"lines": [...], "region", "postalCode", "country"}. Printed in an invoice''s Billed to block. NULL is no address recorded.';

ALTER TABLE crm.invoice
  ADD COLUMN printed_parties jsonb
    CONSTRAINT invoice_printed_parties_shape_chk
      CHECK (printed_parties IS NULL OR jsonb_typeof(printed_parties) = 'object');

COMMENT ON COLUMN crm.invoice.printed_parties IS
  'The supplier and the client as the invoice printed them, written by the issuing statement and never again (0334): {"issuer": print_identity, "recipient": print_identity}. NULL on a draft, and on every invoice issued before 0334, which re-renders as it always printed.';

ALTER TABLE crm.engagement_letter
  ADD COLUMN printed_parties jsonb
    CONSTRAINT el_printed_parties_shape_chk
      CHECK (printed_parties IS NULL OR jsonb_typeof(printed_parties) = 'object');

COMMENT ON COLUMN crm.engagement_letter.printed_parties IS
  'The firm''s company and the client as the letter printed them, written by the sending statement and never again (0334). NULL on a draft, and on every letter sent before 0334, which re-renders as it always printed.';

CREATE FUNCTION crm.print_identity(p_party uuid, p_on date) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH ident AS (
    SELECT i.type, i.value::text AS value, i.is_primary, i.valid_from, i.created_at
      FROM core.party_identifier i
     WHERE i.party_id = p_party
       AND i.voided_at IS NULL
       AND i.valid_from <= p_on
       AND (i.valid_to IS NULL OR i.valid_to >= p_on)
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'name', p.display_name,
           'address', coalesce(p.billing_address, le.registered_address),
           'country', coalesce(coalesce(p.billing_address, le.registered_address) ->> 'country', le.jurisdiction),
           'taxId', (SELECT jsonb_build_object('type', x.type, 'value', x.value) FROM ident x
                      WHERE x.type IN ('gstin', 'trn', 'vat', 'ein')
                      ORDER BY array_position(ARRAY['gstin', 'trn', 'vat', 'ein'], x.type),
                               x.is_primary DESC, x.valid_from DESC, x.created_at DESC LIMIT 1),
           'pan', (SELECT x.value FROM ident x WHERE x.type = 'pan'
                    ORDER BY x.is_primary DESC, x.valid_from DESC, x.created_at DESC LIMIT 1),
           'companyNumber', (SELECT jsonb_build_object('type', x.type, 'value', x.value) FROM ident x
                              WHERE x.type IN ('cin', 'llpin', 'uen', 'crn')
                              ORDER BY array_position(ARRAY['cin', 'llpin', 'uen', 'crn'], x.type),
                                       x.is_primary DESC, x.valid_from DESC, x.created_at DESC LIMIT 1),
           'phone', (SELECT x.value FROM ident x WHERE x.type = 'phone'
                      ORDER BY x.is_primary DESC, x.valid_from DESC, x.created_at DESC LIMIT 1),
           'email', (SELECT x.value FROM ident x WHERE x.type = 'email'
                      ORDER BY x.is_primary DESC, x.valid_from DESC, x.created_at DESC LIMIT 1),
           'website', o.website
         ))
    FROM core.party p
    LEFT JOIN core.legal_entity le ON le.party_id = p.id AND le.tenant_id = p.tenant_id
    LEFT JOIN core.organization o ON o.party_id = p.id AND o.tenant_id = p.tenant_id
   WHERE p.id = p_party
$$;

COMMENT ON FUNCTION crm.print_identity(uuid, date) IS
  'Who a party is on paper on a day (0334): name, address (billing, else registered), country, and the identifiers in force (tax registration, PAN, company number, phone, email), and website. What an invoice or a letter freezes into printed_parties when it goes out.';

REVOKE ALL ON FUNCTION crm.print_identity(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.print_identity(uuid, date) TO bib_app;

-- Written ONCE: by the statement that issues the invoice, or sends the letter.
CREATE FUNCTION crm.refuse_printed_parties_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  going_out boolean := OLD.status = 'draft' AND NEW.status <> 'draft';
BEGIN
  IF NEW.printed_parties IS DISTINCT FROM OLD.printed_parties AND NOT going_out THEN
    RAISE EXCEPTION
      '% % prints its parties as they stood when it went out, and that does not change. A correction is a new document.',
      TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoice_printed_parties
  BEFORE UPDATE OF printed_parties ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_printed_parties_change();

CREATE TRIGGER trg_el_printed_parties
  BEFORE UPDATE OF printed_parties ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_printed_parties_change();

RESET ROLE;
