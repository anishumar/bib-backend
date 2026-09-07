-- 0079 · A firm's existing book, staged — the row a bulk client import lives in
--        between "here is the spreadsheet" and "yes, load it"
--
-- ── WHY A STAGING ROW AT ALL ───────────────────────────────────────────────
--
-- Every firm arrives with its clients on spreadsheets — 10x Global with about
-- four hundred of them — and the screens are for the clients that arrive
-- AFTER that. Typing four hundred existing companies through five screens is
-- not onboarding, it is data entry somebody abandons halfway, and a system that
-- is half true is worse than the spreadsheet it replaced: the calendar is empty
-- for exactly the clients everybody assumes are "in the system".
--
-- The import is two acts, and they are two HTTP requests: upload-and-validate,
-- then confirm. Between them the parsed rows and the report have to live
-- somewhere the second request can find them, because
--
--   · the JSON body limit is 256 KB and four hundred clients with their people
--     and engagements do not fit in one, so the file goes up once, as
--     multipart, and is never re-sent;
--   · the person confirming must confirm WHAT THEY SAW — the report they read
--     is the one stored here, not a re-run that could differ;
--   · "who uploaded what, and who pressed confirm" is a question the audit
--     trail answers only if the act has an id to hang the events on.
--
-- ── WHAT THIS TABLE DOES NOT HOLD ──────────────────────────────────────────
--
-- Not one client. Confirming an import creates parties, legal entities,
-- identifiers, relationships, assignments and engagement letters through the
-- SAME services the screens call, so an imported client is indistinguishable
-- from a typed one — same events, same triggers, same calendar. An importer
-- with its own INSERTs is how two subtly different notions of "a client" end
-- up in one database, and the second is always the one missing an event.
--
-- So the rows here are the SHEET as parsed (`rows`), the VERDICT on it
-- (`report`) and, after confirmation, what actually happened (`outcome`) —
-- which is not the same as the report, because the world can change between
-- the two requests and the confirm re-checks.
--
-- ── PERSONAL DATA, DELIBERATELY IN AN ERASABLE ROW ─────────────────────────
--
-- `rows` carries names, emails, phone numbers and registration numbers — a
-- director's email is personal data. That is why it is a table row and not an
-- event payload: the ledger cannot be erased and this can. The two events the
-- import records (`client_import.staged`, `client_import.confirmed`) carry
-- COUNTS and this row's id, never a name.
--
-- ── WHERE IT LIVES: `crm` ──────────────────────────────────────────────────
--
-- `crm` is the RELATIONSHIP, `delivery` is the WORK. Loading a firm's book is
-- the firm recording who it serves, alongside `crm.lead` and
-- `crm.client_assignment`; nothing about it is work the firm delivers, and the
-- rows it produces land in `core` and `crm`.
--
-- ── THE LAST NUMBER IN (B)'s RANGE ─────────────────────────────────────────
--
-- (B) holds 0057–0079 and this is 0079. The next (B) migration needs a fresh
-- block agreed with (A) on the board, exactly as migrations/README.md says a
-- range is a block to be re-issued, not a territory.

SET ROLE bib_owner;

CREATE TABLE crm.client_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- `staged` is validated and waiting; `confirmed` is loaded. There is no
  -- `rejected`: a sheet with blocking errors is staged too — the report is the
  -- whole point, and the firm fixes the sheet and uploads again. Nothing ever
  -- confirms a staged import whose report still carries a blocking error; the
  -- service refuses, and the confirm re-validates before writing anything.
  status        text NOT NULL DEFAULT 'staged'
                  CHECK (status IN ('staged', 'confirmed')),

  -- Which files came up, by the name the browser gave them. Read back on the
  -- screen so a person can tell two uploads apart.
  file_names    jsonb NOT NULL,

  -- The sheet as parsed: { clients: [...], people: [...], engagements: [...] }.
  -- Kept in the product's own row vocabulary, not the sheet's headers, so the
  -- confirm needs no parser and a header rename later cannot change what an
  -- old import meant.
  rows          jsonb NOT NULL,

  -- The verdict the uploader read: per-row blocking errors and warnings, the
  -- counts, and what the confirm would create.
  report        jsonb NOT NULL,

  -- What the confirm actually did, per row, with the ids it created. NULL
  -- until confirmed, and the CHECK below keeps it that way.
  outcome       jsonb,

  staged_by     uuid NOT NULL REFERENCES tenancy.user_account(id),
  staged_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_by  uuid REFERENCES tenancy.user_account(id),
  confirmed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- The composite target the tenant wall asks every referencing key to name
  -- (see migration 0015). Nothing references this row today; the key is here
  -- so the day something does, it can do it the right way.
  CONSTRAINT client_import_id_tenant_key UNIQUE (id, tenant_id),

  -- The status and the confirmation columns agree, all three at once: a
  -- confirmed import has an outcome, a moment and a person, and a staged one
  -- has none of them.
  CONSTRAINT client_import_status_agrees CHECK (
    (status = 'confirmed') = (confirmed_at IS NOT NULL)
    AND (confirmed_at IS NULL) = (confirmed_by IS NULL)
    AND (confirmed_at IS NULL) = (outcome IS NULL)
  ),
  CONSTRAINT client_import_confirmed_after_staged CHECK (
    confirmed_at IS NULL OR confirmed_at >= staged_at
  )
);

CREATE TRIGGER trg_client_import_updated_at
  BEFORE UPDATE ON crm.client_import
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The list a screen shows: this firm's imports, newest first.
CREATE INDEX idx_client_import_tenant_staged
  ON crm.client_import (tenant_id, staged_at DESC);

ALTER TABLE crm.client_import ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_import_isolation ON crm.client_import
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- SELECT, INSERT, UPDATE — never DELETE, the schema's rule. A staged import
-- that was never confirmed is a fact about what somebody uploaded.
GRANT SELECT, INSERT, UPDATE ON crm.client_import TO bib_app;

RESET ROLE;
