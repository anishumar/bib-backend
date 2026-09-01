-- 0068 · The CLIENT's own request — the first row in this product a client
--        creates, addressed to the firm
--
-- ── WHAT IS MISSING ────────────────────────────────────────────────────────
--
-- After T6.5, T6.6 and T6.7 a client can read their status, answer what the
-- firm asked, find last year's challan and see what they owe. Every one of
-- those is a REPLY. There is still no row in this schema through which a client
-- can start a sentence, so
--
--     "send me last year's balance sheet"
--
-- is a phone call — which is the thing the portal exists to stop. The library
-- covers the half where the firm has already filed the document AND marked it
-- visible; it cannot cover "we never had that from you" or "we need a fresh
-- copy of the engagement letter", and a self-serve surface with no way to ask
-- is a reading room.
--
-- ── THIS IS NOT `delivery.client_ask` REVERSED, AND THAT IS STRUCTURAL ─────
--
-- 0063's `work_item_id` is NOT NULL, deliberately and with its whole argument
-- written out: the composite foreign key over `(work_item_id, client_party_id,
-- tenant_id)` is what makes the wall column a GUARANTEE rather than a
-- convention. A client's own request has no work item. It may get one — the
-- firm may decide this is a job — and it may never, because "please call me
-- about the notice" is not work anybody raises a task for.
--
-- Widening that column to NULL would take 0063's guarantee away from every row
-- in that table to make room for rows of a different shape. So: its own table,
-- and it pays for the wall differently. See below, because the difference is
-- the one genuinely new thing in this migration.
--
-- ── WHERE IT LIVES: `delivery`, for 0063's reason ─────────────────────────
--
-- `crm` is the RELATIONSHIP, `delivery` is the WORK. A client asking for a
-- document, a copy, a call or a correction is asking the firm to DO something,
-- and where the firm acts on it that act is delivery. 0063 already refused the
-- other criterion out loud: filing a row in `crm` because a client can see it
-- would file every portal-visible row by its AUDIENCE rather than by what it
-- is.
--
-- One shape is knowingly left outside: "we would like you to do our payroll as
-- well" is a LEAD, and this table will collect some of those in its `body`
-- because a client types what they type. Turning one into a lead is a firm-side
-- act on the commercial lane, not something this table should try to detect.
--
-- ── `client_party_id` IS SUPPLIED BY THE CLIENT, AND THE DATABASE REFUSES A
--    WRONG ONE ────────────────────────────────────────────────────────────
--
-- Every wall column before this one was READ from a parent inside the write —
-- 0063 takes it from the work item, its response table takes it from the ask —
-- so a caller could not name a party at all. Here there is no parent. A contact
-- granted three of the firm's companies must SAY which one they are writing
-- about, so the value arrives from the browser.
--
-- What stops it being another firm's client, or another client of this firm, is
-- `WITH CHECK (crm.portal_sees(client_party_id))` on the restrictive policy
-- below. That arm has been on every gate-4 policy since 0059 and 0062, both of
-- which said in their own comments that no portal write path existed yet and
-- that this is why the rule would not have to be built into one. T6.6 was the
-- first write; this is the first write where the WITH CHECK is the ONLY thing
-- standing between a supplied id and the row. It is enough — a portal session's
-- granted parties come from `crm.portal_access` through `withPortal`, never
-- from the request — and it is enforced by the database rather than by a
-- handler, which is the whole point.
--
-- The composite FK to `core.party (id, tenant_id)` is a second, different
-- guarantee: the party belongs to this firm. `party_id_tenant_key` (0007) is
-- already there for it.
--
-- ── FOUR STATES, AND THE TWO ENDINGS BELONG TO DIFFERENT PEOPLE ───────────
--
-- open      — raised, the firm has not replied.
-- answered  — the firm replied. NOT closed: the firm answering does not finish
--             a client's request any more than a client answering finishes the
--             firm's ask (0063). A client who was sent the wrong year's balance
--             sheet needs somewhere to say so.
-- closed    — THE FIRM is done with it. Shrestha, 2026-09-02, against the
--             symmetric reading where the raiser closes: the queue is the
--             firm's and keeping it clean is the firm's job, and a client who
--             got what they wanted will never come back to tick a box. Those
--             rows would sit open for ever and the inbox would stop being read.
-- withdrawn — THE CLIENT no longer wants it. Never the firm: "we decided you
--             did not need this" is a refusal, and a refusal is a `closed` with
--             a reply saying so.
--
-- Which of the two endings a session may write is decided by which repository
-- it goes through — the firm's runs `withTenant`, the client's `withPortal` —
-- and not by a column anybody could pass.
--
-- ── NO TOPIC, NO KIND, NO ROUTING, NO DUE DATE ───────────────────────────
--
-- All four are absences somebody will want to fill, so each is written down.
--
-- NO KIND (Shrestha, 2026-09-02). 0063 carries `ask_kind` because the action
-- centre RENDERS a different control for each of its three values. Nothing
-- branches on the kind of a request — every one of them is a sentence and a
-- reply — so a vocabulary here would be a field nobody reads, which is a field
-- that stops being filled in accurately and then starts being trusted.
--
-- NO ROUTING (Shrestha, 2026-09-02). Requests land in ONE firm-wide list. The
-- firm has never said whether an inbound request belongs to the client's
-- partner, to a Dept, or to whoever is free — and this codebase already carries
-- one arbitrary answer to a question of that shape (a shipped rule with no
-- service inherits some engagement's Dept) which is on the board as open. A
-- second guess would be the same mistake with a different table. When the
-- routing rule arrives it is a column and an index, not a rewrite.
--
-- NO DUE DATE, and this one is not open. The firm has never given its
-- turnaround times, so "we will reply by Friday" would be a promise nobody made
-- quoted back at the firm. `raised_at` is on the row and elapsed time is a fact
-- anybody can compute.

SET ROLE bib_owner;

CREATE TABLE delivery.client_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- WHICH COMPANY this is about, and the column gate 4 filters on. Supplied by
  -- the client and refused by the policy's WITH CHECK when it is not one of
  -- theirs — see the header, this is the first table where that arm is the only
  -- thing between a request parameter and the row.
  client_party_id uuid NOT NULL,

  -- The one line the firm's inbox shows, and the client's own words.
  subject         text NOT NULL CHECK (length(btrim(subject)) > 0),

  -- What they actually want, at length. NOT NULL: a request with a subject and
  -- no body is a headline, and the firm would have to ring them to find out
  -- what it means, which is the call this table exists to remove.
  body            text NOT NULL CHECK (length(btrim(body)) > 0),

  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'answered', 'closed', 'withdrawn')),

  -- The client's own contact. A portal session's user account, like
  -- `client_ask_response.responded_by` — the second column in this schema whose
  -- human is routinely somebody outside the firm.
  raised_by       uuid NOT NULL REFERENCES tenancy.user_account(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),

  -- The FIRST reply from the firm, so "how long did they take to come back"
  -- survives a second one. 0063 keeps `first_answered_at` for the mirror image
  -- of this reason.
  first_replied_at timestamptz,

  -- ── `settled_*` RATHER THAN `closed_*`, AND THE NAME IS THE POINT ───────
  --
  -- 0063 calls these `closed_by`/`closed_at` because only the firm ever ends an
  -- ask, so one name covered both its endings. Here the two endings belong to
  -- opposite sides of the wall: `closed` is written by somebody at the firm and
  -- `withdrawn` by somebody at the client. A column called `closed_by` holding
  -- a client contact on half its rows would read as the firm having closed it,
  -- which is exactly the fact a partner would be reading this row to establish.
  settled_by      uuid REFERENCES tenancy.user_account(id),
  settled_at      timestamptz,

  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- The pair-checking composite the reply table's FK needs, for 0063's reason:
  -- the reply carries its own `client_party_id` and must not be able to
  -- disagree with the request it belongs to.
  CONSTRAINT client_request_id_client_tenant_key UNIQUE (id, client_party_id, tenant_id),

  -- The party is one of THIS firm's. Not a substitute for the policy above it —
  -- that one decides whether the writer may name this party at all; this one
  -- decides whether the party exists here.
  CONSTRAINT client_request_party_fkey
    FOREIGN KEY (client_party_id, tenant_id)
    REFERENCES core.party (id, tenant_id),

  -- The status and the timestamps say the same thing or the row is refused.
  -- 0063's constraint, and its reason: two representations of one fact is how a
  -- list filtered on `status` and a report joined on `settled_at` come to
  -- disagree about the same week.
  --
  -- The ELSE arm says nothing about `first_replied_at` on purpose — a client
  -- may withdraw a request the firm has already replied to, and a firm may
  -- close one it never replied to (a duplicate of the one above it).
  CONSTRAINT client_request_status_agrees CHECK (
    CASE status
      WHEN 'open'     THEN first_replied_at IS NULL     AND settled_at IS NULL
      WHEN 'answered' THEN first_replied_at IS NOT NULL AND settled_at IS NULL
      ELSE settled_at IS NOT NULL AND settled_by IS NOT NULL
    END
  ),

  CONSTRAINT client_request_settled_after_raised CHECK (
    settled_at IS NULL OR settled_at >= raised_at
  )
);

CREATE TRIGGER trg_client_request_updated_at BEFORE UPDATE ON delivery.client_request
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- The FIRM's question, and the only one its screen asks: what have clients
-- asked us for that we have not finished. Partial, because a firm-wide inbox
-- with no routing is only usable if it is short, and the finished ones are not
-- part of it.
CREATE INDEX idx_client_request_live
  ON delivery.client_request (tenant_id, raised_at DESC)
  WHERE status IN ('open', 'answered');

-- The CLIENT's question: everything I have asked you, including the finished
-- ones — their own history is theirs to read, and it is short.
CREATE INDEX idx_client_request_client
  ON delivery.client_request (tenant_id, client_party_id, raised_at DESC);

ALTER TABLE delivery.client_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_request_isolation ON delivery.client_request
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Gate 4. RESTRICTIVE so it ANDs with the isolation policy rather than OR-ing
-- with it — OR is how a second policy widens a table somebody meant to narrow.
--
-- A STAFF session is untouched: `crm.portal_sees` is true whenever `app.portal`
-- is not 'on', so the firm reads the whole inbox and this policy costs nothing.
-- That is the first test written for it.
CREATE POLICY client_request_portal_scope ON delivery.client_request AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (crm.portal_sees(client_party_id));

-- SELECT, INSERT, UPDATE — never DELETE, the schema's rule. A withdrawn request
-- is a fact about what a client asked for and then did not need.
GRANT SELECT, INSERT, UPDATE ON delivery.client_request TO bib_app;

-- ── the thread ─────────────────────────────────────────────────────────────
--
-- APPEND-ONLY, and a separate table for `client_ask_response`'s reason: a reply
-- column on the request would make "they sent the wrong year, then the right
-- one" an UPDATE that destroys the first, and both sides' words here are
-- evidence about what was asked for and what was sent.
--
-- BOTH SIDES WRITE INTO ONE TABLE. Two tables — the firm's replies and the
-- client's follow-ups — would need every reader to merge them by timestamp to
-- show a conversation, and a merge done in three places eventually disagrees
-- about the order of two rows written in the same second.
CREATE TABLE delivery.client_request_reply (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  request_id      uuid NOT NULL,

  -- Its own wall column, held to the request's by the composite FK below. Gate
  -- 4 filters this table on the column this table carries; it does not reach
  -- through to the request.
  client_party_id uuid NOT NULL,

  -- ── WHO IS TALKING, AND WHY IT IS STORED RATHER THAN DERIVED ──────────
  --
  -- The screen branches on this on both surfaces, and the alternative is
  -- deriving it — "is `written_by` a staff account?" — which is a join that
  -- decides how a message is ATTRIBUTED. A contact who was once staff, or an
  -- account whose membership was revoked, would silently change sides in an old
  -- conversation. It is a fact about the message, so it is on the message.
  --
  -- And it cannot be forged from the portal: the policy below refuses a portal
  -- session any value but 'client'. The adapters set it; the database enforces
  -- it.
  author_side     text NOT NULL CHECK (author_side IN ('firm', 'client')),

  -- NOT NULL even when a document is attached. A file arriving on somebody's
  -- screen with no sentence beside it is the firm making the client guess which
  -- of the three things they asked for this is — and one line of typing is a
  -- cheap price for a thread that reads as a conversation a year later.
  body            text NOT NULL CHECK (length(btrim(body)) > 0),

  -- ── WHAT THE FIRM ATTACHES IS A DOCUMENT IT HAS ALREADY FILED ─────────
  --
  -- The composite is 0063's, over `(document_id, client_party_id, tenant_id)`
  -- against `files.document (id, party_id, tenant_id)`, and both halves earn
  -- their place again. A reply cannot cite another client's file, and it cannot
  -- cite one of the FIRM's own: `party_id` is NULL on those and no NULL matches
  -- a NOT NULL value here.
  --
  -- That second half is a deliberate narrowing rather than an accident. The
  -- answer to "send me last year's balance sheet" is a document already filed
  -- against that client — and making it reach them is 0066's
  -- `is_client_visible`, which the service flips when the reply is written,
  -- because attaching a document to a message addressed to a client IS the
  -- decision to show it to them. A firm that wants to send something it has not
  -- filed yet files it first, against the client, which is the ordinary act.
  --
  -- MATCH SIMPLE — the default — means the constraint is not checked at all
  -- when `document_id` is NULL, which is most replies.
  document_id     uuid,

  written_by      uuid NOT NULL REFERENCES tenancy.user_account(id),
  written_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_request_reply_request_fkey
    FOREIGN KEY (request_id, client_party_id, tenant_id)
    REFERENCES delivery.client_request (id, client_party_id, tenant_id),

  CONSTRAINT client_request_reply_document_fkey
    FOREIGN KEY (document_id, client_party_id, tenant_id)
    REFERENCES files.document (id, party_id, tenant_id),

  -- Only the firm attaches. A client with a file to send has an upload route
  -- already (T6.6), against an ask on a work item, where it lands in the job's
  -- own file — and a second, thread-shaped upload path would put a client's
  -- document somewhere nobody working the job is looking.
  CONSTRAINT client_request_reply_document_is_the_firms CHECK (
    document_id IS NULL OR author_side = 'firm'
  )
);

CREATE INDEX idx_client_request_reply_request
  ON delivery.client_request_reply (tenant_id, request_id, written_at);

ALTER TABLE delivery.client_request_reply ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_request_reply_isolation ON delivery.client_request_reply
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── AND A PORTAL SESSION CANNOT WRITE A REPLY THAT LOOKS LIKE THE FIRM'S ──
--
-- The USING arm is gate 4 as usual. The WITH CHECK arm carries a second clause,
-- and it is the reason `author_side` is safe to store rather than derive: under
-- a portal session the only writable value is 'client'. A contact who posted
-- `authorSide: "firm"` to the reply route would have the row refused by the
-- DATABASE — not by a handler, not by a zod schema, both of which are also
-- true today and either of which somebody could later "simplify".
--
-- Written in 0062's shape — `NOT crm.is_portal_session() OR <predicate>` — and
-- for the hard reason, not the tidy one: a bare `author_side = 'client'` on a
-- RESTRICTIVE policy applies to STAFF too, and the firm would find its own
-- replies refused. That is the exact edit that cost T6.7 an hour on
-- `files.document` and `crm.invoice`, and it is written here so the next person
-- reading this policy sees the guard is load-bearing.
CREATE POLICY client_request_reply_portal_scope ON delivery.client_request_reply AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (
    crm.portal_sees(client_party_id)
    AND (NOT crm.is_portal_session() OR author_side = 'client')
  );

-- Append-only BY GRANT, not by trigger — `files.document_version`, the `ledger`
-- schema and `client_ask_response` all take this arrangement, and 0037 says
-- why: a trigger is a rule the table carries and a missing grant is a
-- permission the role does not hold, and an import or an agent walks past the
-- first and not the second.
--
-- The REVOKE is required rather than tidy: 0041's ALTER DEFAULT PRIVILEGES on
-- this schema grants SELECT, INSERT, UPDATE on every table created in it.
GRANT SELECT, INSERT ON delivery.client_request_reply TO bib_app;
REVOKE UPDATE ON delivery.client_request_reply FROM bib_app;

RESET ROLE;
