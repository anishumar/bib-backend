-- 0326 · Invoice integrity (audit 2026-10-03, billing cluster).
--
--   1. A STRUCK-OFF LINE NO LONGER HOLDS ITS POSITION (B04). 0027's
--      `invoice_line_position_unique (invoice_id, position)` counted lines struck
--      off a draft, while `addLine` numbers the next line from the live ones: a
--      draft with lines 1 and 2, line 2 struck off, could not take another line
--      (duplicate key, a 500). Scoped to LIVE lines, as the proposal, letter and
--      fee-group positions already are. Concurrent adds are serialised on the
--      invoice row by the repository (B36).

SET ROLE bib_owner;

-- ── 1. Positions among live lines only ─────────────────────────────────────
ALTER TABLE crm.invoice_line DROP CONSTRAINT invoice_line_position_unique;
-- CONSCIOUSLY SCOPED: one live line per position per invoice. A struck-off line
-- keeps the position it had, for the record, and frees it.
CREATE UNIQUE INDEX invoice_line_position_unique
  ON crm.invoice_line (invoice_id, position) WHERE removed_at IS NULL;

RESET ROLE;
