-- 0330 · notes on a task, and the maker's note on a review (audit 2026-10-03, CA#30)
--
-- ── WHAT THE ROLEPLAY COULD NOT SAY ─────────────────────────────────────────
--
-- An article working "File GSTR-3B for September" had nowhere to write
-- "challan shared with the client on WhatsApp", and nothing to say to the
-- checker when she sent it: the only prose a task carried was its description
-- and the CHECKER's note on a send-back. So two things, both small:
--
--   · `delivery.work_item_note` — a running list of notes on one task. Each row
--     is one person's sentence at one moment. APPEND-ONLY: `bib_app` gets
--     SELECT and INSERT, never UPDATE or DELETE, because a note somebody acted
--     on that later reads differently is worse than no note. A correction is a
--     second note.
--   · `work_item_approval.request_note` — what the MAKER said when sending the
--     work to be checked, on the review it opened. On the review row and not in
--     the notes list, so the review history reads "she said / he said" round by
--     round, beside the checker's own `notes`.
--
-- ── THE LEDGER CARRIES THAT A NOTE WAS WRITTEN, NEVER WHAT IT SAYS ──────────
--
-- `work_item.note_added` names the note's id. The text is prose about a
-- client's work and routinely names a person, and the ledger cannot be erased:
-- the same rule 0051 applies to a block reason and T2.9 to a send-back note.
--
-- ── BOUNDS ──────────────────────────────────────────────────────────────────
--
-- Not blank (whitespace is what JavaScript's `trim()` strips, 0308's
-- definition, so the service and the wall agree on what "blank" means) and at
-- most 2,000 characters: a note, not a document. The service trims before it
-- writes, so a stored note never starts or ends with whitespace.

SET ROLE bib_owner;

ALTER TABLE delivery.work_item_approval
  ADD COLUMN request_note text;

ALTER TABLE delivery.work_item_approval
  ADD CONSTRAINT work_item_approval_request_note_is_text CHECK (
    request_note IS NULL OR (
      request_note ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
      AND length(request_note) <= 2000
    )
  );

COMMENT ON COLUMN delivery.work_item_approval.request_note IS
  'What the maker said when sending the work to be checked (CA#30). Prose; never in the ledger.';

CREATE TABLE delivery.work_item_note (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenancy.tenant(id),
  work_item_id   uuid NOT NULL,
  -- By id alone: `tenancy.user_account` is GLOBAL (ADR-02) and carries no
  -- tenant. The service writes the session's user and nobody else.
  author_user_id uuid NOT NULL REFERENCES tenancy.user_account (id),
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_note_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT work_item_note_work_item_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id),
  CONSTRAINT work_item_note_body_is_text CHECK (
    body ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
    AND length(body) <= 2000
  )
);

-- The task page's read: one task's notes, oldest first.
CREATE INDEX idx_work_item_note_item
  ON delivery.work_item_note (tenant_id, work_item_id, created_at);

ALTER TABLE delivery.work_item_note ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_item_note_isolation ON delivery.work_item_note
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- APPEND-ONLY. 0041's default privileges on this schema grant SELECT, INSERT
-- and UPDATE; a note is never edited, so UPDATE is taken back here.
GRANT SELECT, INSERT ON delivery.work_item_note TO bib_app;
REVOKE UPDATE, DELETE ON delivery.work_item_note FROM bib_app;

RESET ROLE;
