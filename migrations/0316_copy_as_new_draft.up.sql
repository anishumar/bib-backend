-- 0316 · Copy as new draft: a rejected or expired proposal, or a withdrawn letter, starts the next one
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- A client who turns a quote down usually wants it changed, not gone: a lower
-- fee, one service fewer, a narrower scope. The product had no way back from
-- `rejected`, `expired` or `withdrawn` except typing the whole document again,
-- ten or fifteen lines with their scope, volume limits and exclusions. Decided
-- 2026-09-30 (Shrestha): a closed proposal or letter can be COPIED into a new
-- draft, amounts, discounts and wording exactly as they were.
--
-- ── WHAT THIS STORES, AND WHAT IT DOES NOT ─────────────────────────────────
--
-- One column per document, on the NEW row: which document it was copied from.
-- The old row is never touched, so a rejected quote stays exactly what the
-- client rejected, and a letter's signed-letter freeze (0019) is not asked to
-- make an exception. "Copied to" on the old document's page is the same column
-- read the other way.
--
-- Composite keys, like every reference between tenant-scoped rows: an id-only
-- key would let one firm's draft point at another firm's document. A document
-- is never copied from itself.
--
-- WHICH documents may be copied (rejected or expired proposals, withdrawn
-- letters) is the service's rule and not a wall here: the pointer records where
-- a draft came from, which is true whatever the source's status became later.

SET ROLE bib_owner;

ALTER TABLE crm.proposal
  ADD COLUMN copied_from_id uuid,
  ADD CONSTRAINT proposal_copied_from_fk
    FOREIGN KEY (copied_from_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  ADD CONSTRAINT proposal_not_copied_from_itself_chk
    CHECK (copied_from_id IS DISTINCT FROM id);

CREATE INDEX proposal_copied_from_idx
  ON crm.proposal (tenant_id, copied_from_id)
  WHERE copied_from_id IS NOT NULL;

ALTER TABLE crm.engagement_letter
  ADD COLUMN copied_from_id uuid,
  ADD CONSTRAINT el_copied_from_fk
    FOREIGN KEY (copied_from_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id),
  ADD CONSTRAINT el_not_copied_from_itself_chk
    CHECK (copied_from_id IS DISTINCT FROM id);

CREATE INDEX el_copied_from_idx
  ON crm.engagement_letter (tenant_id, copied_from_id)
  WHERE copied_from_id IS NOT NULL;

RESET ROLE;
