-- 0302 · Taking a document OFF something — withdrawn, never deleted
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
--
-- 0037 gave `files.document_link` SELECT and INSERT and nothing else, and its
-- header said detaching was "deliberately not implemented: whether an
-- attachment made in error should vanish or remain visible as withdrawn is a
-- question for a firm, not a guess". The firm has now answered (Shrestha,
-- 2026-09-25): it stays visible as WITHDRAWN. A PAN card attached to the
-- wrong engagement was still attached to it for a fortnight, and "what was
-- filed against this engagement" has to say so — the alternative, a row that
-- vanishes, rewrites that history with no trace, which is exactly what 0037
-- refused UPDATE to prevent.
--
-- So: two nullable columns, a column-level UPDATE grant that reaches ONLY
-- them, and a trigger that refuses to move a link once it is withdrawn. The
-- link row is otherwise as immutable as it was; `bib_app` still cannot change
-- what a document is attached to, only say that it no longer is.
--
-- ── THE UNIQUE KEY MOVES TO THE LIVE ROWS ──────────────────────────────────
--
-- `document_link_once` refused a second (document, subject) pair outright. A
-- link withdrawn in error must be attachable again, so the constraint becomes
-- a PARTIAL unique index over rows that are still in force. The history keeps
-- every withdrawn row; only one may be live at a time.
SET ROLE bib_owner;

ALTER TABLE files.document_link
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by uuid REFERENCES tenancy.user_account (id),
  -- A withdrawer with no withdrawal is impossible; a withdrawal with no
  -- withdrawer is the system acting, which the service refuses but the
  -- schema does not have to.
  ADD CONSTRAINT document_link_withdrawer_needs_withdrawal
    CHECK (withdrawn_by IS NULL OR withdrawn_at IS NOT NULL);

ALTER TABLE files.document_link DROP CONSTRAINT document_link_once;
CREATE UNIQUE INDEX document_link_once
  ON files.document_link (tenant_id, document_id, subject_kind, subject_ref)
  WHERE withdrawn_at IS NULL;

-- Once withdrawn, frozen. The column grant already stops every other column
-- moving; this stops the withdrawal itself being undone or re-dated. Putting a
-- document back is a NEW link, which the partial index above allows.
CREATE OR REPLACE FUNCTION files.refuse_withdrawn_link_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'document link % was withdrawn at % and cannot change; attach the document again if it belongs here',
      OLD.id, OLD.withdrawn_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_link_withdrawn_is_final
  BEFORE UPDATE ON files.document_link
  FOR EACH ROW EXECUTE FUNCTION files.refuse_withdrawn_link_change();

GRANT UPDATE (withdrawn_at, withdrawn_by) ON files.document_link TO bib_app;

RESET ROLE;
