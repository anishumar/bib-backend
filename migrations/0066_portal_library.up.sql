-- 0066 · The self-serve library (T6.7) — the client's own documents and their
--        own invoices, and the switch that decides which documents those are
--
-- ── WHAT THE BOARD ASKS FOR ────────────────────────────────────────────────
--
-- *"Self-serve library (docs/challans/invoices). Acc: a client finds last year's
-- challan without emailing anyone."* Two tables' reads land here, one at a time,
-- each scoped on the column that table itself carries — the rule 0059 set and
-- 0062, 0063 and 0065 have each followed since.
--
--   files.document   → party_id        (already policied in 0063, NARROWED here)
--   crm.invoice      → party_id        (who is BILLED — new here)
--
-- ── THE HOLE 0063 LEFT, AND IT ONLY BECAME ONE TODAY ─────────────────────
--
-- `document_portal_scope` (0063) is `crm.portal_sees(party_id)` and nothing
-- else, and that was CORRECT while the only route that reached a document was a
-- client reading back the filename of a file they had just sent. There was no
-- route that LISTED documents, so the policy was never asked a broad question.
--
-- T6.7 is that route. And the moment a list exists, `party_id` alone hands the
-- client every working paper the firm has ever filed against them — the audit
-- team's notes, the queries they raised internally, the draft they rejected.
-- That is not a leak across the tenant wall; it is worse in the way that
-- matters commercially, because every row of it is genuinely about that client
-- and a partner would still never send it.
--
-- **This is `is_client_visible` for the second time.** 0051 put that flag on
-- `delivery.work_item` and it sat unread until 0062; T6.5's walk then found the
-- portal showing *"Decide the credit hold on INV/2026-27/0003"* to a client,
-- because the flag defaulted TRUE and nothing had ever set it false. The lesson
-- is taken here rather than re-learnt:
--
--   · the DEFAULT IS FALSE, so an import, an agent, or a future INSERT that has
--     never heard of this column publishes NOTHING. False is the safe direction
--     and it is the one a forgetful writer lands on.
--   · it is enforced as the POLICY, not as a filter in the query. A portal read
--     that forgets a WHERE returns an internal note with a 200; a portal read
--     that forgets a policy returns nothing at all.
--   · and it is its OWN policy, guarded by `crm.is_portal_session()`, rather
--     than an extra AND on 0063's. THAT IS NOT STYLE — see the note on
--     `document_portal_visible` below. Writing it as a bare AND hid every
--     working paper from the FIRM, and the integration suite said so.
--   · and the sensible day-one value is set by the APPLICATION from the
--     document's KIND (`FileStoreService`), not by this DEFAULT. A challan, an
--     invoice, a credit note and a signed engagement letter are documents the
--     client is a party to; a working paper is the firm's own thinking. That
--     mapping is a judgement about the firm's business, and it belongs where a
--     firm's screen can override it in both directions — which is the half a
--     kind-based POLICY would have made impossible.
--
-- ── THE BACKFILL PUBLISHES NOTHING, AND THAT IS THE WHOLE POINT ──────────
--
-- Exactly one set of rows is set TRUE: documents a client SENT THEMSELVES
-- through the portal, which they can already read the filename of today. Making
-- those invisible would be this migration taking something away.
--
-- Everything else stays FALSE, including every statutory filing already in the
-- store. A backfill that published a firm's existing documents to its clients
-- because a migration ran overnight is precisely the failure mode this column
-- exists to prevent, and "the library is empty until somebody decides" is the
-- correct first state for a feature whose failure mode is disclosure. The demo
-- seed marks its own filings visible, which is what makes the acceptance line
-- walkable without changing the rule.
--
-- ── AND THE INVOICE, WHICH 0062 SAID OUT LOUD WAS NOT HERE ───────────────
--
-- *"Documents and invoices are NOT here either. They are T6.6/T6.7's reads."*
-- 0063 did documents. This does invoices, on `crm.invoice.party_id` — the
-- client who is BILLED, which is the column that table carries and is NOT the
-- entity the work was delivered to (0027's own distinction, and G0.1's).
--
-- A DRAFT INVOICE MAY NOT REACH A CLIENT, and that is in the policy rather than
-- in a query for `is_client_visible`'s reason: a draft is a demand nobody has
-- made yet, and a client who saw one would either pay it or argue about it, both
-- of which are worse than not seeing it. `cancelled` IS visible — a client
-- holding a copy of an invoice the firm has withdrawn must be able to see that
-- it was withdrawn, and hiding it would leave them believing they still owe it.
--
-- The three tables that hang off an invoice — lines, payments, credit notes —
-- carry no party column and get an EXISTS on the parent, which INHERITS the
-- parent's own RLS. That is 0063's `document_version` arrangement, for 0063's
-- reason: one edit decides both, and the child cannot drift from the parent.
-- `crm.invoice_balance`, `invoice_totals` and `invoice_line_amount` are all
-- `security_invoker = true`, so they follow these policies with nothing written
-- for them here — which is what that flag was for.
--
-- ── NOT HERE, DELIBERATELY ───────────────────────────────────────────────
--
-- `crm.dunning_action` gets NO policy. It records that the firm chased a client
-- for MONEY and at which rung, and whether a client may see their own dunning
-- history is a question for a firm rather than a guess — the same answer 0065
-- gave about `crm.client_freeze`. Gate 2 contains it: no portal route reads that
-- table, and `PORTAL_PATHS` is denied by default. A portal route whose subject
-- is that table needs its own line here first.

SET ROLE bib_owner;

-- ── which of a client's documents the client may actually see ─────────────

ALTER TABLE files.document
  ADD COLUMN is_client_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN files.document.is_client_visible IS
  'Whether this document appears in the client portal''s library. DEFAULT FALSE so a writer that has never heard of this column publishes nothing; set from the document KIND by FileStoreService at insert, and flippable both ways from the firm''s own screen. Enforced by document_portal_scope, never by a WHERE clause.';

-- The library's own question, asked once per portal page: this client's visible
-- documents, newest first. Partial, because the invisible ones are never the
-- answer to it.
CREATE INDEX idx_document_client_visible
  ON files.document (tenant_id, party_id, created_at DESC)
  WHERE is_client_visible AND party_id IS NOT NULL;

-- THE BACKFILL. Only what a client can already read — see the header.
--
-- Identified through `client_ask_response.document_id` rather than through
-- `origin = 'uploaded'` or a link role: a response row is the RECORD of a client
-- having sent it, and it is the only one of the three that cannot also be true
-- of a file somebody at the firm uploaded.
UPDATE files.document d
   SET is_client_visible = true
 WHERE EXISTS (
   SELECT 1
     FROM delivery.client_ask_response r
    WHERE r.document_id = d.id
      AND r.tenant_id   = d.tenant_id
 );

-- A SECOND POLICY, NOT AN EXTRA `AND` ON 0063's — AND THE DIFFERENCE IS THE
-- WHOLE OF WHY THIS PARAGRAPH EXISTS.
--
-- The obvious edit is `ALTER POLICY document_portal_scope … USING
-- (crm.portal_sees(party_id) AND is_client_visible)`. It was written that way
-- first and it is WRONG, which the integration suite said within a minute: a
-- RESTRICTIVE policy applies to EVERY session, and `crm.portal_sees` returns
-- true for a staff one — so the second condition has nothing making it
-- conditional, and the firm loses sight of its own working papers. Same edit on
-- `crm.invoice` below hid every DRAFT invoice from the people writing them.
--
-- 0062 had already solved this and the shape is copied from it exactly:
-- `work_item_portal_visible` is `NOT crm.is_portal_session() OR
-- is_client_visible`. The guard is what makes a client-only rule client-only,
-- and a narrowing written without one narrows the workspace.
--
-- Separate rather than folded in for a second reason: 0063 owns
-- `document_portal_scope`, and this file leaves it byte-for-byte as it was. The
-- down is then a DROP rather than a restore of somebody else's text.
--
-- `document_version_portal_scope` and `document_link_portal_scope` need no edit:
-- both are an EXISTS on this row, so RLS on the parent is evaluated inside them
-- and they inherit this policy for free. That is the whole reason 0063 wrote
-- them that way, and it is what keeps the storage KEY unreachable.
CREATE POLICY document_portal_visible ON files.document AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR is_client_visible)
  WITH CHECK (NOT crm.is_portal_session() OR is_client_visible);

-- ── the invoice, and the three tables that hang off it ────────────────────

-- Gate 4, on the column this table carries: `party_id` is WHO IS BILLED.
--
-- The status test is part of the wall and not a nicety. A draft invoice is a
-- demand nobody has made; a cancelled one is a demand withdrawn, and a client
-- holding a copy of it has to be able to see that.
--
-- No `ENABLE ROW LEVEL SECURITY` on any of these four: 0027 and 0028 enabled it
-- when they created them, and a RESTRICTIVE policy on a table with RLS off is a
-- wall around an open door.
CREATE POLICY invoice_portal_scope ON crm.invoice AS RESTRICTIVE
  USING      (crm.portal_sees(party_id))
  WITH CHECK (crm.portal_sees(party_id));

-- The status test, GUARDED — for the reason spelt out above `document_portal_visible`.
-- Without `NOT crm.is_portal_session()` this hides every draft invoice from the
-- firm that is writing it, which is what the first draft of this file did.
CREATE POLICY invoice_portal_issued ON crm.invoice AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR status IN ('issued', 'cancelled'))
  WITH CHECK (NOT crm.is_portal_session() OR status IN ('issued', 'cancelled'));

-- The children carry no party column, so each asks its PARENT — which inherits
-- the parent's own RLS, including the status test above. One edit decides all
-- four, and a child cannot drift from the invoice it belongs to.
CREATE POLICY invoice_line_portal_scope ON crm.invoice_line AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.invoice_line.invoice_id
       AND i.tenant_id = crm.invoice_line.tenant_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.invoice_line.invoice_id
       AND i.tenant_id = crm.invoice_line.tenant_id
  ));

-- A client asking *"have I paid this?"* is the second email this library exists
-- to stop, after *"where is my challan?"*. `crm.invoice_balance` is
-- security_invoker, so it answers correctly the moment these three exist.
CREATE POLICY payment_portal_scope ON crm.payment AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.payment.invoice_id
       AND i.tenant_id = crm.payment.tenant_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.payment.invoice_id
       AND i.tenant_id = crm.payment.tenant_id
  ));

CREATE POLICY credit_note_portal_scope ON crm.credit_note AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.credit_note.invoice_id
       AND i.tenant_id = crm.credit_note.tenant_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crm.invoice i
     WHERE i.id = crm.credit_note.invoice_id
       AND i.tenant_id = crm.credit_note.tenant_id
  ));

RESET ROLE;
