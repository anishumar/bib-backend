-- 0312 · A document follows the company that issues it (T6.18, 2026-09-28)
--
-- The firm has four companies of its own (India, UAE, Singapore, US), and a
-- client is quoted and contracted by ONE of them. Two things in the schema did
-- not follow that, and both are here because this build owns one number.
--
-- ── 1. THE STANDARD PROSE, PER ISSUING COMPANY ─────────────────────────────
--
-- `crm.standard_document_block` held ONE set per firm, scoped only by the
-- country a document is written for. The firm's UAE company does not say what
-- its Indian company says — its commercial notes name a different tax, its
-- exclusions a different regulator — and "per country of the CLIENT" cannot
-- express "per company of OURS".
--
-- `issuing_entity_party_id` NULL is the firm-wide DEFAULT set, which is every
-- row that exists today, so nothing changes for a firm that never writes a
-- company's own lines. The rule that reads it is `blocksFor` in the domain,
-- PER KIND: when the issuer has any active row of a kind, those rows are its
-- set of that kind; otherwise the default rows of that kind are. The existing
-- `jurisdiction` filter applies inside whichever set was chosen.
--
-- Composite key to the party, the tenant wall's rule. Whether the party is one
-- of the FIRM's companies (`crm.is_firm_entity`) is the service's refusal, not
-- a wall: a company stops being named in a preference row without its prose
-- becoming wrong, and a trigger would refuse the edit that fixes it.
--
-- ── 2. A DRAFT'S CURRENCY CAN CHANGE WHILE IT QUOTES NOTHING ───────────────
--
-- A proposal line carries its proposal's currency through
-- `proposal_line_proposal_fkey (proposal_id, tenant_id, currency)`, so a
-- mixed-currency document is unrepresentable (0011). The key had no ON UPDATE
-- action, so a proposal's currency could not move once ANY line had ever
-- existed — including a line pulled off the draft a minute later, which is
-- `removed_at` and never gone. The builder picks the issuer, and so the
-- currency, on step 1; going back to step 1 after trying a service on step 2
-- was a dead end.
--
-- ON UPDATE CASCADE, and the service changes the currency only while the
-- draft has NO LIVE line (`CURRENCY_LOCKED_BY_LINES`). What cascades is
-- therefore only lines struck off a DRAFT: never sent, never offered to
-- anybody, the argument 0086 made for deleting a draft outright. A sent
-- proposal's currency never changes — the service refuses anything but a
-- draft — so no line a client read is ever relabelled.

SET ROLE bib_owner;

-- ── 1 ───────────────────────────────────────────────────────────────────────
ALTER TABLE crm.standard_document_block
  ADD COLUMN IF NOT EXISTS issuing_entity_party_id uuid;

ALTER TABLE crm.standard_document_block
  DROP CONSTRAINT IF EXISTS std_block_issuing_entity_fkey;
ALTER TABLE crm.standard_document_block
  ADD CONSTRAINT std_block_issuing_entity_fkey
    FOREIGN KEY (issuing_entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- The read this exists for: one company's set (or the default set) of one
-- kind, in order. NULLs index like any value, so the default set uses it too.
CREATE INDEX IF NOT EXISTS idx_std_block_issuer
  ON crm.standard_document_block (tenant_id, issuing_entity_party_id, kind, sort_order);

-- ── 2 ───────────────────────────────────────────────────────────────────────
ALTER TABLE crm.proposal_line
  DROP CONSTRAINT IF EXISTS proposal_line_proposal_fkey;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id, currency)
    REFERENCES crm.proposal (id, tenant_id, currency)
    ON UPDATE CASCADE;

RESET ROLE;
