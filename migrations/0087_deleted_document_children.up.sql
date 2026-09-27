-- 0087 · A deleted draft's lines, terms, fee groups and prose are final too
--
-- 0086 made a deleted proposal or letter FINAL — a trigger refuses any change to
-- the row — and left its CHILDREN to the services, which refuse first
-- (`draftOrThrow`, `editableOrThrow`). Walking the letter page after deleting a
-- draft found the one writer that does not come through either: the document's
-- own PROSE (`crm.document_block`) is written by the document use case, which
-- never asks about the document it belongs to. Its only wall was the
-- signed-letter freeze, so the exclusions and the cover letter of a DELETED
-- draft were still editable — through the page, which offered the controls, and
-- through the API behind it.
--
-- So the wall moves down a level, onto every table that is part of a proposal's
-- or a letter's content: its lines, its clauses, its fee groups and its prose.
-- One function, resolving the parent from whichever of `proposal_id` /
-- `engagement_letter_id` the row carries — `crm.document_block` carries either —
-- and checking BOTH the row's old parent and its new one, so a row can be moved
-- neither off a deleted document nor onto one (the shape
-- `crm.refuse_signed_child_change()` has, for the same reason).
--
-- ── WHY `object_not_in_prerequisite_state` (55000) AND NOT `restrict_violation`
--
-- The block adapter already translates 23001 on this table into "this letter is
-- SIGNED, so its prose is frozen" (`DocumentBlockFrozen`), and on the letter's
-- child tables 23001 is what the signed freeze raises. A deleted draft is not
-- signed, and meeting that sentence would send somebody to supersede a letter
-- nobody ever sent. 55000 is used nowhere else in this database, so the adapter
-- can say the right thing by the CODE alone, never by parsing a message.
--
-- INSERT and UPDATE only: `bib_app` holds no DELETE grant on any of these tables,
-- and 0086's guards on the parents are UPDATE-only for the same reason. Each
-- trigger is named `…_parent_not_deleted` so it sorts AFTER the signed freeze on
-- its table (BEFORE triggers fire in name order): a change to a SIGNED letter's
-- terms must be refused as that. The two can never both apply anyway — a signed
-- letter is never deleted.

SET ROLE bib_owner;

CREATE FUNCTION crm.refuse_change_under_deleted_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parents uuid[] := '{}';
  col     text;
  gone    text;
BEGIN
  FOREACH col IN ARRAY ARRAY['proposal_id', 'engagement_letter_id'] LOOP
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> col) IS NOT NULL THEN
      parents := parents || (to_jsonb(OLD) ->> col)::uuid;
    END IF;
    IF (to_jsonb(NEW) ->> col) IS NOT NULL THEN
      parents := parents || (to_jsonb(NEW) ->> col)::uuid;
    END IF;
  END LOOP;

  SELECT d.ref INTO gone
    FROM (SELECT ref, deleted_at FROM crm.proposal WHERE id = ANY (parents)
          UNION ALL
          SELECT ref, deleted_at FROM crm.engagement_letter WHERE id = ANY (parents)) d
   WHERE d.deleted_at IS NOT NULL
   LIMIT 1;

  IF gone IS NOT NULL THEN
    RAISE EXCEPTION
      '% was deleted as made by mistake, so nothing on it changes again — including its % rows. Draft a new document if the work is real.',
      gone, TG_TABLE_NAME
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_proposal_line_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.proposal_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

CREATE TRIGGER trg_el_line_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

CREATE TRIGGER trg_el_clause_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_clause
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

CREATE TRIGGER trg_el_fee_group_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_fee_group
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

CREATE TRIGGER trg_doc_block_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.document_block
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();

RESET ROLE;
