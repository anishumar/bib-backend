-- 0326 down · Back to 0027/0028/0066/0322 as they were.
--
-- REFUSES while two lines of one invoice share a position (a line added after
-- another was struck off): 0027's constraint cannot hold them both.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.invoice_line GROUP BY invoice_id, position HAVING count(*) > 1) THEN
    RAISE EXCEPTION
      '0326 down: some invoices have a struck-off line and a live line at the same position. 0027''s constraint cannot hold both; renumber them first.';
  END IF;
END;
$$;

-- ── 1. Positions ───────────────────────────────────────────────────────────
DROP INDEX crm.invoice_line_position_unique;
ALTER TABLE crm.invoice_line
  ADD CONSTRAINT invoice_line_position_unique UNIQUE (invoice_id, position);

RESET ROLE;
