-- 0383 · A document kind for a client's books: `books_input`
--         (docs/FIN_BUILD_PLAN.md, open decision settled 2026-10-10: Anish, option B).
--
-- ── WHY A KIND OF ITS OWN ────────────────────────────────────────────────────
--
-- FinCompliance reads the files a client sends for their books — purchase
-- and sales invoices, bank and card statements, payroll sheets, receipts —
-- and before this there was no honest label for them:
--
--   * `invoice` and `credit_note` mean the FIRM's own commercial documents.
--     They sit behind the fee wall (`showsFees`, audit 2026-10-03 B01), so a
--     client's purchase invoice filed as `invoice` would open only for staff
--     who see the firm's fees — and fin, which leaves the fee-wall kinds alone
--     rather than list a fee document to everybody, would skip it SILENTLY.
--     A month of a client's invoices gone from their books with nothing saying
--     so is the worst way this module could fail.
--   * `other` is everything else, so fin taking `other` would spend reading
--     effort (and AI cost) on meeting notes and scans nobody meant for it.
--
-- `books_input` says what the file is FOR. Fin takes this kind and no other
-- (`domain/fin/intake.ts`), so what reaches the books is exactly what somebody
-- filed for them. The request templates (F1) file a client's monthly uploads
-- under it; a person uploading on the firm's side chooses it from the list.
--
-- Not behind the fee wall — it is the client's data, not the firm's price —
-- and not shown back to the client by default: they supplied it and already
-- hold it, `identity_proof`'s reasoning. Both are decided in
-- `domain/filestore/model.ts`, whose switches are exhaustive.
--
-- Two CHECKs carry the list: the document's own (0037) and the kind an ask
-- files its upload under (0063). Both widen; nothing existing changes kind.

SET ROLE bib_owner;

ALTER TABLE files.document DROP CONSTRAINT document_kind_check;
ALTER TABLE files.document ADD CONSTRAINT document_kind_check CHECK (kind IN (
  'proposal', 'engagement_letter', 'invoice', 'credit_note',
  'identity_proof', 'statutory_filing', 'working_paper',
  'correspondence', 'brand_asset', 'other', 'books_input'
));

ALTER TABLE delivery.client_ask DROP CONSTRAINT client_ask_document_kind_check;
ALTER TABLE delivery.client_ask ADD CONSTRAINT client_ask_document_kind_check CHECK (document_kind IN (
  'proposal', 'engagement_letter', 'invoice', 'credit_note',
  'identity_proof', 'statutory_filing', 'working_paper',
  'correspondence', 'brand_asset', 'other', 'books_input'
));

RESET ROLE;
