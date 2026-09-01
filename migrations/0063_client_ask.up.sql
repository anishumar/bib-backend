-- 0063 · The client-directed ask — the row that says WE ARE WAITING ON YOU
--
-- ── WHAT IS MISSING, AND WHY "HELD UP" WAS NOT IT ──────────────────────────
--
-- T6.5's portal shows a "Held up" section built from `delivery.work_item`'s
-- `blocked_reason`, verbatim, under a line saying whose words they are. That
-- section is honest and it is not an ask, because NOTHING IN THIS SCHEMA
-- RECORDS WHO A TASK IS WAITING ON. `work_item_state.is_blocked` means the firm
-- cannot proceed, and the same sentence reads
--
--     "the client has not sent the Maharashtra purchase register"
--
-- as readily as
--
--     "the GST portal is down".
--
-- A client reading the second one has nothing to do about it, and a portal that
-- put an ANSWER box under both would be inviting a client to fix Infosys's
-- servers. So the ask is a row of its own: raised deliberately, addressed to one
-- client, with somewhere to answer it and a state that says whether it has been.
--
-- ── WHERE IT LIVES: `delivery`, NOT `crm` ─────────────────────────────────
--
-- `crm` is the RELATIONSHIP — leads, proposals, engagements, who may sign in.
-- `delivery` is the WORK — jobs, work items, obligations, escalations. An ask
-- exists because a piece of work cannot move; it is raised from the work item by
-- the person doing it, and its answer becomes evidence in that job's file. It is
-- delivery, and putting it in `crm` because a client can see it would file every
-- portal-visible row by its audience rather than by what it is.
--
-- ── IT HANGS OFF A WORK ITEM, AND THAT IS WHAT MAKES THE WALL SOLID ────────
--
-- `work_item_id` is NOT NULL. Shrestha, 2026-09-01, against two alternatives:
--
--   · a `(subject_kind, subject_ref)` pair, `delivery.job`'s idiom, so an ask
--     could hang off an obligation or a job as well. Rejected because that pair
--     CANNOT carry a foreign key (0037 states the whole trade), and without one
--     the wall column below is a value somebody hopes is right rather than one
--     the database guarantees. Every filing raises its own work item anyway
--     (T3.2), so the reach is the same and the guarantee is not.
--   · a standalone ask, attached to nothing. Rejected because T6.6's acceptance
--     line is *"a client upload files itself against the job that asked for
--     it"* — an ask attached to nothing has no job to file anything against.
--
-- ── `client_party_id` IS ITS OWN COLUMN, AND IT CANNOT DISAGREE ───────────
--
-- CLAUDE.md's rule since 0059: a grant names a PARTY, and each table names its
-- own column — `delivery.work_item` has `client_party_id`,
-- `delivery.obligation_instance` has `entity_party_id`, `files.document` has
-- `party_id`. Gate 4 filters on the column the table itself carries, and a
-- guessed join is a wall with a hole in it.
--
-- So this table carries its own. What is new here is that it does not have to be
-- TRUSTED: the foreign key is composite over `(work_item_id, client_party_id,
-- tenant_id)`, so a row whose wall column disagrees with the work item it names
-- cannot be written at all. The denormalisation is for the policy; the FK is
-- what stops the denormalisation drifting. That needs a matching unique
-- constraint on `work_item`, added below — its `id` is already a primary key, so
-- the extra columns only ride along.
--
-- It also means `client_party_id` needs no FK to `core.party` of its own: the
-- work item's own composite FK already guarantees it is a party of this firm.
--
-- ── NO DUE DATE. NOT ONE. ─────────────────────────────────────────────────
--
-- The portal's rule, unchanged and load-bearing here: no deadline this product
-- invented reaches a client. The firm has never given its turnaround times
-- (client ask 3.4), so "please send this by Friday" would be a promise nobody
-- made, quoted back at the firm. `raised_at` is on the row and elapsed time is a
-- fact — which is also all T4.4's chaser needs to decide when to chase.
--
-- ── RAISING AN ASK DOES NOT BLOCK THE WORK ITEM ───────────────────────────
--
-- Two different facts, deliberately uncoupled. A task can be waiting on the
-- client for one thing and still moving on three others, and a firm that wants
-- "asking blocks it" can set the state itself. Wiring them together here would
-- make that the product's opinion rather than the firm's.

SET ROLE bib_owner;

-- The composites the ask's own foreign keys need. `id` is the primary key of
-- both tables, so neither adds uniqueness that was not already true — they exist
-- so a child table can reference the row AND the party it belongs to in ONE
-- constraint, and have the database check the pair rather than each half.
--
-- That is the whole mechanism behind "each table names its own column" being a
-- guarantee here instead of a convention: the wall column is denormalised, and
-- these are what stop the denormalisation drifting.
ALTER TABLE delivery.work_item
  ADD CONSTRAINT work_item_id_client_tenant_key UNIQUE (id, client_party_id, tenant_id);

-- `party_id` is NULLABLE here, which a UNIQUE constraint allows and which is
-- exactly what makes the response's foreign key refuse a firm-owned document:
-- there is no row whose `party_id` equals a NOT NULL client party unless the
-- document really belongs to that client.
ALTER TABLE files.document
  ADD CONSTRAINT document_id_party_tenant_key UNIQUE (id, party_id, tenant_id);

-- ── the ask ────────────────────────────────────────────────────────────────

CREATE TABLE delivery.client_ask (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- What the ask is about. NOT NULL — see the header.
  work_item_id    uuid NOT NULL,

  -- WHO is being asked, as a client party. This is the column gate 4 filters on,
  -- and the composite FK below is what stops it disagreeing with the work item.
  client_party_id uuid NOT NULL,

  -- What kind of answer closes it. The product's own vocabulary and therefore a
  -- CHECK, not a config kind: these three are the three things the action centre
  -- can RENDER a control for, and a firm inventing a fourth would get a row the
  -- portal cannot draw. `document.kind` took the same decision for the same
  -- reason (0037).
  ask_kind        text NOT NULL CHECK (ask_kind IN ('document', 'question', 'approval')),

  -- What the firm wants, in the firm's own words, shown to the client verbatim
  -- under a line saying whose words they are. It is the only field that says
  -- what is actually wanted; without it the action centre is a list of blanks.
  prompt          text NOT NULL CHECK (length(btrim(prompt)) > 0),

  -- What an uploaded answer will be FILED AS. Mirrors 0037's CHECK, which is the
  -- duplication that vocabulary already accepted — a firm does not invent a new
  -- kind of engagement letter, and `domain/filestore/model.ts` holds the same
  -- list a third time with a test that fails if they drift.
  --
  -- Present exactly when the ask wants a document: an approval with a document
  -- kind is a field nobody set deliberately, and a document ask without one
  -- leaves the filing decision to whatever the upload route happens to default
  -- to.
  document_kind   text CHECK (document_kind IN (
                    'proposal', 'engagement_letter', 'invoice', 'credit_note',
                    'identity_proof', 'statutory_filing', 'working_paper',
                    'correspondence', 'brand_asset', 'other'
                  )),

  -- ── the four states, and why the client's answer is not the last one ─────
  --
  -- open      — raised, nothing back yet. This is what "waiting on YOU" means.
  -- answered  — the client responded. NOT closed, and that is Shrestha's call
  --             (2026-09-01): the firm looks at what arrived and decides. A
  --             client who sent the wrong register would otherwise see the ask
  --             marked done, and the firm would have to raise a second one that
  --             reads as a fresh request rather than "that was not it".
  -- closed    — the firm got what it needed.
  -- withdrawn — the firm no longer needs it. A different fact from `closed` and
  --             kept apart, because "we found it ourselves" and "you sent it"
  --             are different answers to "did I actually have to do that".
  --
  -- A CHECK rather than a state table: this is the PRODUCT's vocabulary, not the
  -- firm's. `work_item_state` and `obligation_state` are rows a firm edits
  -- because its own words for progress are its own; these four are what the
  -- portal branches on, and a fifth would be a screen nobody wrote.
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'answered', 'closed', 'withdrawn')),

  raised_by       uuid NOT NULL REFERENCES tenancy.user_account(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),

  -- The FIRST response, so "how long did they take" survives a second one. The
  -- responses themselves are rows; this is the instant the status turned.
  first_answered_at timestamptz,

  closed_by       uuid REFERENCES tenancy.user_account(id),
  closed_at       timestamptz,

  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_ask_id_tenant_key UNIQUE (id, tenant_id),

  -- And the same pair-checking composite this table's own FK uses, for the same
  -- reason: the response table below carries its own `client_party_id` and must
  -- not be able to disagree with the ask it answers.
  CONSTRAINT client_ask_id_client_tenant_key UNIQUE (id, client_party_id, tenant_id),

  -- The composite that makes the wall column a guarantee rather than a hope.
  CONSTRAINT client_ask_work_item_fkey
    FOREIGN KEY (work_item_id, client_party_id, tenant_id)
    REFERENCES delivery.work_item (id, client_party_id, tenant_id),

  -- A document kind exactly when a document is wanted.
  CONSTRAINT client_ask_document_kind_pair CHECK (
    (ask_kind = 'document') = (document_kind IS NOT NULL)
  ),

  -- The status and the timestamps say the same thing or the row is refused.
  -- Two representations of one fact is how a list filtered on `status` and a
  -- report joined on `closed_at` come to disagree about the same week.
  CONSTRAINT client_ask_status_agrees CHECK (
    CASE status
      WHEN 'open'     THEN first_answered_at IS NULL     AND closed_at IS NULL
      WHEN 'answered' THEN first_answered_at IS NOT NULL AND closed_at IS NULL
      ELSE closed_at IS NOT NULL AND closed_by IS NOT NULL
    END
  ),

  CONSTRAINT client_ask_closed_after_raised CHECK (
    closed_at IS NULL OR closed_at >= raised_at
  )
);

CREATE TRIGGER trg_client_ask_updated_at BEFORE UPDATE ON delivery.client_ask
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- The portal's own question — "what is waiting on me" — asked on every load of
-- the action centre. Partial, because that question is only ever about the ones
-- that are not finished.
CREATE INDEX idx_client_ask_open
  ON delivery.client_ask (tenant_id, client_party_id, raised_at DESC)
  WHERE status IN ('open', 'answered');

-- The firm's question: what have we asked this client for, on this task.
CREATE INDEX idx_client_ask_work_item
  ON delivery.client_ask (tenant_id, work_item_id, raised_at DESC);

ALTER TABLE delivery.client_ask ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_ask_isolation ON delivery.client_ask
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Gate 4, one table at a time as the rule says. RESTRICTIVE, so it ANDs with the
-- isolation policy above rather than OR-ing with it — OR is how a second policy
-- widens a table somebody meant to narrow.
--
-- WITH CHECK matters on this one in a way it did not on 0059's or 0062's, and
-- this is the first time it does: a portal session WRITES here. Answering an ask
-- inserts into the table below, whose own policy is written the same way, and
-- both are reached through `withPortal` rather than `withTenant`. So a contact
-- cannot answer an ask addressed to another of the firm's clients even by
-- naming its id — the database refuses the row, not a handler.
CREATE POLICY client_ask_portal_scope ON delivery.client_ask AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (crm.portal_sees(client_party_id));

-- SELECT, INSERT, UPDATE — never DELETE, the whole schema's rule. An ask that
-- was withdrawn is a fact about what the firm asked for and then did not need;
-- deleting it takes that with it. The status is how one goes away.
GRANT SELECT, INSERT, UPDATE ON delivery.client_ask TO bib_app;

-- ── what the client actually did ───────────────────────────────────────────
--
-- A SEPARATE TABLE, AND APPEND-ONLY. Response columns on the ask would make
-- "they sent the wrong file, then the right one" an UPDATE that destroys the
-- first — and a client's answer is evidence in a compliance file, which is the
-- same argument `files.document_version`, `crm.client_assignment` and the ledger
-- each reached on their own. A document ask that takes three files is then a
-- shape rather than a special case, and so is an approval that was declined in
-- March and given in April.
CREATE TABLE delivery.client_ask_response (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  ask_id          uuid NOT NULL,

  -- Its own wall column, exactly as the ask has one — and held to the ask's by
  -- the composite FK below, for the same reason. Gate 4 filters this table on
  -- the column this table carries; it does not reach through to the ask.
  client_party_id uuid NOT NULL,

  -- WHAT the client did. Not a copy of `ask_kind`: a client answering a document
  -- ask in words ("we do not hold one — the shop closed in 2019") is a real and
  -- useful response, and forcing it to be a file would make the honest answer
  -- unsayable.
  response_kind   text NOT NULL CHECK (response_kind IN ('document', 'answer', 'decision')),

  -- The client's own words. Optional beside a document or a decision — a
  -- declined approval almost always comes with a reason, and a file usually
  -- comes with a sentence about it.
  answer_text     text,

  -- The uploaded file, for a document response.
  document_id     uuid,

  -- ── AND WHY A CLIENT'S APPROVAL IS NOT `work_item_approval` ─────────────
  --
  -- `delivery.work_item_approval` and `delivery.step_approval` are the FIRM's
  -- maker-checker (T2.9): a second qualified person at the firm has checked the
  -- work, gated on `work:write`, refused when checker = maker, and governed by
  -- the firm's SQC policy. That is a statement about the QUALITY of the work.
  --
  -- A client approving is a statement about what the client WANTS — an
  -- instruction, or consent. Recording it in those tables would make a client's
  -- "yes" count as a checker's sign-off, and the firm's own review would then
  -- appear to have been done by somebody outside the firm. Different fact,
  -- different row, and the two must never be counted together.
  decision        text CHECK (decision IN ('approved', 'declined')),

  responded_by    uuid NOT NULL REFERENCES tenancy.user_account(id),
  responded_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_ask_response_ask_fkey
    FOREIGN KEY (ask_id, client_party_id, tenant_id)
    REFERENCES delivery.client_ask (id, client_party_id, tenant_id),

  -- ── THE DOCUMENT MUST BELONG TO THE CLIENT WHO SENT IT ─────────────────
  --
  -- Composite over `(document_id, client_party_id, tenant_id)` against
  -- `files.document (id, party_id, tenant_id)`, so a response cannot point at a
  -- file belonging to another client — or at one of the firm's OWN documents,
  -- whose `party_id` is NULL and therefore matches no NOT NULL value here. That
  -- second half is the one worth having: without it, a response could cite the
  -- firm's letterhead as the client's answer.
  --
  -- MATCH SIMPLE — the default — is doing real work: when `document_id` is NULL,
  -- as it is for every answer and every decision, the constraint is not checked
  -- at all. So one FK covers the document case and stays out of the way of the
  -- other two.
  CONSTRAINT client_ask_response_document_fkey
    FOREIGN KEY (document_id, client_party_id, tenant_id)
    REFERENCES files.document (id, party_id, tenant_id),

  -- Exactly the payload the kind promises, and nothing from another kind. A
  -- response row carrying both a decision and a document is two answers, and
  -- whichever one a reader happens to look at first becomes the record.
  CONSTRAINT client_ask_response_payload CHECK (
    CASE response_kind
      WHEN 'document' THEN document_id IS NOT NULL AND decision IS NULL
      WHEN 'answer'   THEN document_id IS NULL AND decision IS NULL
                           AND length(btrim(coalesce(answer_text, ''))) > 0
      ELSE                 document_id IS NULL AND decision IS NOT NULL
    END
  ),

  -- An empty string is not a note. Null is.
  CONSTRAINT client_ask_response_note_not_blank CHECK (
    answer_text IS NULL OR length(btrim(answer_text)) > 0
  )
);

CREATE INDEX idx_client_ask_response_ask
  ON delivery.client_ask_response (tenant_id, ask_id, responded_at);

ALTER TABLE delivery.client_ask_response ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_ask_response_isolation ON delivery.client_ask_response
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY client_ask_response_portal_scope ON delivery.client_ask_response AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (crm.portal_sees(client_party_id));

-- APPEND-ONLY BY GRANT, not by trigger — `files.document_version` and the
-- `ledger` schema have exactly this arrangement, and 0037 states why: a trigger
-- is a rule the table carries and a missing grant is a permission the role does
-- not hold, and an import or an agent walks past the first and not the second.
--
-- The REVOKE is required rather than tidy: 0041 set ALTER DEFAULT PRIVILEGES on
-- this schema to grant SELECT, INSERT, UPDATE on every table created in it, so a
-- new table here is writable unless something says otherwise. That default is
-- right for the ask above and wrong for this one.
GRANT SELECT, INSERT ON delivery.client_ask_response TO bib_app;
REVOKE UPDATE ON delivery.client_ask_response FROM bib_app;

-- ── gate 4 reaches the document store (T3.6's tables) ──────────────────────
--
-- 0037 wrote `files.document.party_id` with this exact day in view — *"This is
-- the column Gate 4 (record-scope) will filter the client portal on, which is
-- why it is here before the portal needs it"* — and it has had no policy since.
-- This is that line, and it is added now because the upload route is what
-- reads it, one table as its read lands rather than a sweep.
--
-- ── NULL MEANS THE FIRM'S OWN, AND IT DENIES CORRECTLY BY ACCIDENT ────────
--
-- `party_id` is nullable: a firm's own letterhead belongs to no client. Under a
-- portal session `crm.portal_sees(NULL)` is `NULL = ANY (granted)`, which is
-- NULL, which is not true, which is zero rows — so the firm's own documents are
-- invisible to a client without a second clause. That is the right answer and it
-- is written down HERE because it does not look deliberate in the SQL: somebody
-- reading `crm.portal_sees(party_id)` and remembering the column is nullable
-- would reasonably add `AND party_id IS NOT NULL`, which changes nothing, or
-- `OR party_id IS NULL`, which hands every client the firm's whole stationery
-- cupboard. 0062's note flagged this as *"a decision waiting for the document
-- library rather than one taken now"*; it is taken now, and it is: strict.
--
-- A staff session is untouched — `app.portal` is unset, the first arm of
-- `crm.portal_sees` is true, and the policy costs nothing.
CREATE POLICY document_portal_scope ON files.document AS RESTRICTIVE
  USING      (crm.portal_sees(party_id))
  WITH CHECK (crm.portal_sees(party_id));

-- ── AND THE BYTES, WHICH HAVE NO PARTY COLUMN OF THEIR OWN ───────────────
--
-- `files.document_version` carries a content hash, a size and a storage key, and
-- nothing that names a client. It has no independent identity: `document_id` is
-- NOT NULL with a composite foreign key, so a version is part of its document
-- and nothing else.
--
-- **This is not the "guessed join" the rule forbids, and the difference is worth
-- stating because the shapes look alike.** 0059 refused deriving ACCESS from
-- `core.party_relationship` — a nullable, editable link between two things that
-- each exist on their own, written by somebody describing the world rather than
-- granting anything. This is the owning relation of a child row. There is no
-- other document a version could belong to and no edit that could move it.
--
-- And the subquery is not a second wall to keep in step with the first: RLS
-- applies to it too, for `bib_app`, which holds no BYPASSRLS. So the parent's
-- policies — tenant isolation AND the portal scope just above — decide the
-- EXISTS, and a version is readable exactly when its document is. Changing what
-- a client may see is one edit, above, not two that can drift apart.
--
-- Written now rather than when bytes first leave, because a version row is what
-- the download route resolves the storage key from: with the document guarded
-- and the version not, a portal session could read another client's storage key
-- and its content hash. There would be no route that returned them today — and
-- "no route yet" is the gate 0059 refused to rely on.
CREATE POLICY document_version_portal_scope ON files.document_version AS RESTRICTIVE
  USING (
    NOT crm.is_portal_session()
    OR EXISTS (
         SELECT 1
         FROM files.document d
         WHERE d.id = document_version.document_id
           AND d.tenant_id = document_version.tenant_id
       )
  )
  WITH CHECK (
    NOT crm.is_portal_session()
    OR EXISTS (
         SELECT 1
         FROM files.document d
         WHERE d.id = document_version.document_id
           AND d.tenant_id = document_version.tenant_id
       )
  );

-- ── a document may now be attached to a work item ─────────────────────────
--
-- `files.document_link.subject_kind` is a closed vocabulary and adding a member
-- is *"a migration AND a case in whatever resolves a subject to a name — a kind
-- nothing can resolve is a link nobody can follow"* (0037). Both halves are
-- here: this CHECK, and `linksOf`'s label resolution in
-- `infrastructure/postgres/filestore-repository.ts`.
--
-- It earns its place on T6.6's acceptance line, which is that a client upload
-- *files itself against the job that asked for it*. The ask names the work item;
-- without this the file would be reachable only through the ask, and the person
-- who asked for it — looking at the work item — would not see it arrive.
--
-- `job` was already here and is not the same thing: a job is the ENGINE's run of
-- a process, a work item is the row on somebody's desk. The ask hangs off the
-- second, so the link does too.
ALTER TABLE files.document_link
  DROP CONSTRAINT document_link_subject_kind_check;
ALTER TABLE files.document_link
  ADD CONSTRAINT document_link_subject_kind_check CHECK (subject_kind IN (
    'party', 'lead', 'proposal', 'engagement_letter',
    'engagement', 'invoice', 'job', 'work_item'
  ));

-- The link table needs gate 4 too, and its read lands in this task: the portal's
-- upload WRITES one, so the WITH CHECK arm is what stops a portal session
-- attaching anything to a document it does not own. The USING arm matters for
-- the same reason `document_version`'s does — "what is this file attached to"
-- names another client's engagements and invoices, and nothing should be able
-- to ask it here and get an answer.
--
-- Same shape, same argument — the parent document decides, under its own RLS.
CREATE POLICY document_link_portal_scope ON files.document_link AS RESTRICTIVE
  USING (
    NOT crm.is_portal_session()
    OR EXISTS (
         SELECT 1
         FROM files.document d
         WHERE d.id = document_link.document_id
           AND d.tenant_id = document_link.tenant_id
       )
  )
  WITH CHECK (
    NOT crm.is_portal_session()
    OR EXISTS (
         SELECT 1
         FROM files.document d
         WHERE d.id = document_link.document_id
           AND d.tenant_id = document_link.tenant_id
       )
  );

RESET ROLE;
