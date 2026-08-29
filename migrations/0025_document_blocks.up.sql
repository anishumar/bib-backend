-- 0025 · The prose a document carries besides its priced lines (G1.7)
--
-- Three lists appear on every proposal and every engagement letter and have no
-- home anywhere in this schema: the general scope EXCLUSIONS, the COMMERCIAL
-- notes ("All fees are exclusive of GST as applicable"), and the TEAM the firm
-- will deploy. They are not clauses — a clause is a term of the contract, drawn
-- from a versioned library and pinned. These are the document's own prose, and
-- a firm edits them the way it edits a bulleted list.
--
-- ── ONE ROW PER LINE, NOT ONE BLOB PER BLOCK ───────────────────────────────
--
-- The whole shape follows from how they are EDITED: a line at a time, added,
-- reordered, struck out. A single `exclusions text` column makes "delete the
-- third exclusion" a string operation — split on newlines, drop an element,
-- rejoin — with nothing stable for a UI to attach an edit control to, no way to
-- reorder without rewriting the whole value, and a merge conflict every time
-- two people touch different lines. A row has an id.
--
-- `is_heading` is what keeps that decision from costing anything. The team
-- block is a table with headings ("Engagement Partner", "Delivery Team") and
-- the exclusions list has section breaks; without it, either the prose goes
-- back into one blob or every heading becomes a second table.
--
-- ── THE STANDARD SET IS COPIED, NOT REFERENCED ─────────────────────────────
--
-- `standard_document_block` is what the firm maintains; `document_block` is
-- what a document SAYS. A new document copies the standard set at creation and
-- owns its rows from then on.
--
-- A reference would be cheaper and would be wrong in the one way that matters:
-- editing the standard exclusions would silently rewrite what every issued
-- proposal and every SIGNED letter says. That is the same argument the config
-- registry's pinning makes, reached from the other direction — and here a copy
-- beats a pin, because these lines are meant to be EDITED per document (a
-- client negotiates an exclusion away), which a pinned version cannot express.
--
-- ── `jurisdiction` IS LOAD-BEARING ─────────────────────────────────────────
--
-- "All fees are exclusive of GST as applicable" is wrong on a UAE proposal, and
-- that is not hypothetical: it is a mistake the firm already caught in its own
-- template. NULL means "print this everywhere"; a code means "only on a
-- document written for that country". The same distinction G1.8 draws for a
-- clause, one table down.
--
-- ── OWNERSHIP: ONE TABLE, TWO NULLABLE PARENTS ─────────────────────────────
--
-- `proposal_id` and `engagement_letter_id`, exactly one of them set, enforced
-- by a CHECK. Two tables would be the local precedent (`proposal_line` and
-- `engagement_letter_line` are separate) — but those two differ in substance:
-- an EL line's entity is NOT NULL and a proposal line's is not, one carries
-- `removed_at` and `effective_from`, one carries the overrides. A block is the
-- same object on both documents, with the same columns and the same rules, so
-- two tables would duplicate the freeze trigger, the copy, the repository and
-- the API to express a difference that does not exist.
--
-- The composite foreign keys are MATCH SIMPLE, so a NULL parent id skips the
-- check entirely — which is what makes one table with two parents safe here.
--
-- ── THE SIGNED-LETTER FREEZE APPLIES, AND FOR FREE ─────────────────────────
--
-- `crm.refuse_signed_child_change()` (0017, rewritten by 0024) resolves its
-- parent from `NEW.engagement_letter_id` / `OLD.engagement_letter_id`, which
-- this table has. A block on a signed letter is therefore frozen exactly as a
-- line and a clause are, and a block on a proposal is untouched because its
-- `engagement_letter_id` is NULL and the function's guards are IS NOT NULL.
-- The exclusions a client agreed to are part of what they agreed to.

SET ROLE bib_owner;

-- ── The firm's standard set ────────────────────────────────────────────────
CREATE TABLE crm.standard_document_block (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant (id),
  kind        text NOT NULL CHECK (kind IN ('exclusion', 'commercial', 'team')),
  body        text NOT NULL CHECK (btrim(body) <> ''),
  is_heading  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL CHECK (sort_order > 0),
  -- NULL = every document. A code = only documents written for that country.
  -- Upper case is demanded here rather than normalised, for the reason G1.8
  -- gives: the value is compared, and 'in' is what a comparison would get.
  jurisdiction text CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  -- `is_active`, never a delete — the same distinction `staff_grade` draws.
  -- A retired standard line is one the firm has MOVED ON from; it stays
  -- readable because documents issued while it was in force copied it, and a
  -- reader asking "where did this line come from" needs it to resolve.
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Scoped consciously: the order is per KIND, not per table. The exclusions and
-- the team block are two independent lists and both start at 1. It is not
-- UNIQUE — a firm inserting a line between two others would otherwise have to
-- renumber the list to buy an ordering guarantee nothing reads, which is the
-- argument `staff_grade.rank` already settled.
CREATE INDEX idx_std_block_kind ON crm.standard_document_block (tenant_id, kind, sort_order);

ALTER TABLE crm.standard_document_block ENABLE ROW LEVEL SECURITY;
CREATE POLICY std_block_isolation ON crm.standard_document_block
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

-- The composite key a document block's copy-source could reference. Not
-- referenced today and deliberately so — see `source_id` below.
ALTER TABLE crm.standard_document_block
  ADD CONSTRAINT std_block_id_tenant_key UNIQUE (id, tenant_id);

CREATE TRIGGER trg_std_block_updated
  BEFORE UPDATE ON crm.standard_document_block
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── What a document actually says ──────────────────────────────────────────
CREATE TABLE crm.document_block (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant (id),
  proposal_id           uuid,
  engagement_letter_id  uuid,
  kind       text NOT NULL CHECK (kind IN ('exclusion', 'commercial', 'team')),
  body       text NOT NULL CHECK (btrim(body) <> ''),
  is_heading boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  -- Where the line came from, for a screen that wants to say "standard" beside
  -- an untouched line and "edited" beside a changed one. NOT a foreign key on
  -- purpose: the standard row may be retired or its body rewritten years later,
  -- and this must not stop it or acquire its new wording. It is a breadcrumb,
  -- and the copy above it is the fact.
  source_id  uuid,
  -- A line struck off a document before it went out. THE THIRD SOFT DELETE IN
  -- THE PRODUCT, and CLAUDE.md enumerates the other two by name, so this needs
  -- its reason stated rather than assumed: it is the SAME thing they are —
  -- `removed_at` on `crm.proposal_line` and `crm.engagement_letter_line` — a
  -- line removed from a document in draft, on a table whose rows are lines of a
  -- document. Removing a line is half of why this is a row per line at all; the
  -- motivating sentence was "delete the third exclusion", and `bib_app` holds
  -- no DELETE grant on any table in this database, so a soft delete is the only
  -- honest way to express it. It is NOT the `deleted_at`-across-`core` pattern
  -- G0.3 refused: one column, on one table, whose rows are already scoped to
  -- one document.
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Exactly one parent. Neither is a block belonging to nothing; both is a
  -- block on two documents, which is the referencing model this table exists
  -- to refuse.
  CONSTRAINT document_block_one_parent_chk CHECK (
    (proposal_id IS NOT NULL) <> (engagement_letter_id IS NOT NULL)
  ),
  -- MATCH SIMPLE: a NULL parent id skips its check, which is what lets one
  -- table carry both. Composite, because a foreign-key check runs as a system
  -- operation RLS does not filter — see CLAUDE.md's tenant wall.
  CONSTRAINT document_block_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  CONSTRAINT document_block_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id)
      REFERENCES crm.engagement_letter (id, tenant_id)
);

-- Partial on `removed_at IS NULL` as well as on the parent: every read of a
-- document's prose wants the live lines, and a struck-off one is read only when
-- somebody asks what changed.
CREATE INDEX idx_doc_block_proposal
  ON crm.document_block (proposal_id, kind, sort_order)
  WHERE proposal_id IS NOT NULL AND removed_at IS NULL;
CREATE INDEX idx_doc_block_letter
  ON crm.document_block (engagement_letter_id, kind, sort_order)
  WHERE engagement_letter_id IS NOT NULL AND removed_at IS NULL;

ALTER TABLE crm.document_block ENABLE ROW LEVEL SECURITY;
CREATE POLICY doc_block_isolation ON crm.document_block
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_doc_block_updated
  BEFORE UPDATE ON crm.document_block
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The signed-letter freeze, unchanged and reused. The function reads
-- NEW/OLD.engagement_letter_id, which is NULL for a proposal's blocks, and its
-- guards are IS NOT NULL — so proposals are untouched and a signed letter's
-- prose is as frozen as its terms.
CREATE TRIGGER trg_doc_block_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.document_block
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();

GRANT SELECT, INSERT, UPDATE ON crm.standard_document_block TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.document_block TO bib_app;

COMMENT ON TABLE crm.standard_document_block IS
  'The firm''s standard prose lists (exclusions, commercial notes, team). COPIED onto each new document, never referenced by one — editing these changes the next document and no issued one.';
COMMENT ON TABLE crm.document_block IS
  'The prose one document actually says. Owned by exactly one proposal or one engagement letter; a signed letter''s blocks are frozen by crm.refuse_signed_child_change().';
COMMENT ON COLUMN crm.document_block.removed_at IS
  'A line struck off a document while it was still a draft. The third soft delete in the product, and the same kind as the other two (crm.proposal_line, crm.engagement_letter_line) — bib_app holds no DELETE grant anywhere.';
COMMENT ON COLUMN crm.standard_document_block.jurisdiction IS
  'NULL prints everywhere; a code prints only on documents written for that country. "Exclusive of GST" on a UAE proposal is the mistake this exists to stop.';

RESET ROLE;
