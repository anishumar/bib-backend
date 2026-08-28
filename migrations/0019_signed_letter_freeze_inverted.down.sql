-- Reverses 0019, newest object first. Re-runnable.
--
-- Restores 0017's ENUMERATED freeze verbatim, because that is what "down" has
-- to mean — a down that left the stricter rule in place would make 0019
-- irreversible while claiming otherwise. Note what going back costs: six
-- columns (id, proposal_id, sent_at, signature_reference, withdrawn_at,
-- created_at) become silently editable on a signed letter again.
SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION crm.refuse_signed_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION
        'engagement letter % is signed and cannot be deleted: it is the record of what the client agreed to. Supersede it with a new letter instead.',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'signed' THEN
    RETURN NEW;
  END IF;

  IF NEW.status              IS DISTINCT FROM OLD.status
     OR NEW.party_id         IS DISTINCT FROM OLD.party_id
     OR NEW.tenant_id        IS DISTINCT FROM OLD.tenant_id
     OR NEW.jurisdiction     IS DISTINCT FROM OLD.jurisdiction
     OR NEW.title            IS DISTINCT FROM OLD.title
     OR NEW.currency         IS DISTINCT FROM OLD.currency
     OR NEW.fx_rate          IS DISTINCT FROM OLD.fx_rate
     OR NEW.fx_rate_date     IS DISTINCT FROM OLD.fx_rate_date
     OR NEW.advance_required IS DISTINCT FROM OLD.advance_required
     OR NEW.advance_amount   IS DISTINCT FROM OLD.advance_amount
     OR NEW.signed_at        IS DISTINCT FROM OLD.signed_at
     OR NEW.signed_by_name   IS DISTINCT FROM OLD.signed_by_name
     OR NEW.signature_method IS DISTINCT FROM OLD.signature_method
     OR NEW.signed_content_hash IS DISTINCT FROM OLD.signed_content_hash THEN
    RAISE EXCEPTION
      'engagement letter % is signed and frozen: it is the record of what the client agreed to, and it must read tomorrow exactly as it reads today. Supersede it with a new letter instead of editing this one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS crm.signed_letter_mutable_columns();

RESET ROLE;
