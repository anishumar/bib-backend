-- 0065 · The chaser (T4.4) — the escalation ladder aimed OUTWARD, and the one
--        thing that stops it
--
-- ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
--
-- T6.6 built the row that says WE ARE WAITING ON YOU. Nothing sends a second
-- one. At a real firm that gap is the whole job: somebody opens a spreadsheet on
-- Monday, works out who has not replied, and types the same sentence again — and
-- the board is explicit that this is the only task on it that reduces the firm's
-- OWN chasing hours.
--
-- ── IT IS T4.5's LADDER, AND DELIBERATELY NOT T4.5's TABLE ────────────────
--
-- `delivery.escalation_notice` (0058) records that somebody INSIDE the firm was
-- told its own work had gone quiet. This records that a CLIENT was reminded, and
-- they are not the same fact:
--
--   · the reader is different — one is a colleague's queue, the other is a
--     client's page, and no query wants both;
--   · the target is different — an escalation resolves to a person, a rank, or
--     nobody, while a chase always goes to the client the ask names;
--   · and the STOP is different, which is the half below.
--
-- Sharing the table would mean every escalation query carrying "and not the
-- outward ones" forever, which is the shape of a filter somebody eventually
-- forgets.
--
-- ── NOTHING IS SET BY DEFAULT, AND THAT IS THE RULE NOT A GAP ────────────
--
-- The ladder is a `chaser` config entry and a firm that has published none
-- chases NOBODY. Same as T4.5's ladder and the dunning ladder before it: a
-- cadence this product invented is one the firm never agreed to — and unlike an
-- escalation, which lands on a colleague, this one lands on the CLIENT, who
-- feels it. The demo publishes one; nothing else does.
--
-- ── AND THE ONE THING THAT STOPS IT ──────────────────────────────────────
--
-- The board's acceptance line is *"respects ladder config; stops on escalation
-- freeze"*, and **escalation freeze did not exist anywhere in this product** —
-- not a table, not a column, not a config kind. So it is built here, and its
-- shape was a client fact rather than a guess. Shrestha, 2026-09-01:
--
--   · IT IS ON THE CLIENT, effective-dated. The board's own sentence is *"a
--     client already in a dispute is not being auto-chased while a partner is
--     negotiating"* — a dispute is with a client, not with one task. A per-ask
--     snooze would make a partner silence seven asks one at a time and would be
--     silent again the moment an eighth was raised.
--   · IT STOPS THE CHASER AND NOT T4.5. A freeze is about what the CLIENT hears.
--     Stopping the inward ladder as well would make a dispute the one moment a
--     firm goes blind to its own late work, which is exactly when it can least
--     afford to.
--   · A REASON IS REQUIRED. "Why is this client not being chased" is asked
--     months later by somebody who did not set it, and a freeze with no reason
--     is indistinguishable from one somebody forgot to lift.
--
-- Half-open `[valid_from, valid_to)` like `crm.portal_access`,
-- `crm.client_assignment`, `core.party_relationship` and `party_identifier`:
-- `valid_to` is the FIRST DAY NOT IN FORCE. Two date conventions in one schema
-- is an off-by-one waiting for a handover, and "was this client frozen on 14
-- March" has to be answerable a year later — which a freeze lifted by DELETE
-- answers with silence.

SET ROLE bib_owner;

-- ── the ladder is a new kind of configuration ─────────────────────────────
--
-- Not the `escalation` kind reused. Its rung carries `watch`, `notify` and
-- `minGradeRank`, and a chase has none of the three: there is ONE thing chased
-- (an open ask) and it always goes to the client the ask names. Squeezing it in
-- would mean three fields every chaser rung must set to a value nobody reads,
-- and a validator that could no longer refuse a rung that made no sense.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation',
  'chaser'
]));

-- ── a client the firm is not chasing ───────────────────────────────────────

CREATE TABLE crm.client_freeze (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  client_party_id uuid NOT NULL,

  -- Half-open: valid_to is the FIRST DAY NOT IN FORCE. Null = still frozen.
  valid_from      date NOT NULL,
  valid_to        date,

  -- WHY, and it is NOT NULL. See the header: a freeze with no reason cannot be
  -- told apart from one somebody forgot to lift, and the person asking is
  -- usually not the person who set it.
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),

  set_by          uuid NOT NULL REFERENCES tenancy.user_account(id),
  -- Who lifted it, when somebody did.
  --
  -- ── AND `valid_to` WITHOUT A LIFTER IS A REAL STATE ────────────────────
  --
  -- The obvious CHECK here is the one `client_ask` has on its closure — both or
  -- neither — and it is WRONG on this table, which trying it is what showed. A
  -- firm may set a freeze that ENDS on a known day ("frozen until the 30th,
  -- while we are in mediation"), and that row has an end date and no lifter
  -- because nobody has lifted anything: the firm scheduled it. Requiring a
  -- lifter there would refuse the one shape a partner is most likely to want.
  --
  -- The true invariant is the other direction: a LIFTER with no end date is
  -- impossible, because lifting IS setting the end date.
  lifted_by       uuid REFERENCES tenancy.user_account(id),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_freeze_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT client_freeze_client_fkey
    FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id),

  -- LIFTING IS ALLOWED TO BE IMMEDIATE, and that is 0061's decision applied a
  -- second time. `valid_to = valid_from` is an EMPTY range, in force on no day,
  -- which is what "set at 10:00, lifted at 10:01" looks like when the row is
  -- date-grained. The row then understates that freeze by part of a day and
  -- nothing is lost, because the ledger carries the instant.
  --
  -- SETTING one that way is still refused by the service: a freeze in force on
  -- no day is a typo at the moment of freezing, while lifting one is a decision
  -- taken twenty seconds later. The database allows the shape; the service
  -- allows only the act.
  CONSTRAINT client_freeze_dates_ordered CHECK (valid_to IS NULL OR valid_to >= valid_from),

  CONSTRAINT client_freeze_lifted_needs_an_end CHECK (
    lifted_by IS NULL OR valid_to IS NOT NULL
  ),

  -- One client cannot be frozen twice over the same days. Ranges compared AS
  -- RANGES and not a partial index over open rows: two CLOSED freezes
  -- overlapping in March slip past that, and March is exactly when somebody
  -- asks why nothing was sent.
  CONSTRAINT client_freeze_no_overlap EXCLUDE USING gist (
    tenant_id       WITH =,
    client_party_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE TRIGGER trg_client_freeze_updated_at BEFORE UPDATE ON crm.client_freeze
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The sweep's own question, asked once per tenant per run: which of this firm's
-- clients are frozen today. Partial, because that question is always about now.
CREATE INDEX idx_client_freeze_open
  ON crm.client_freeze (tenant_id, client_party_id)
  WHERE valid_to IS NULL;

ALTER TABLE crm.client_freeze ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_freeze_isolation ON crm.client_freeze
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── NO PORTAL POLICY ON THIS TABLE, AND THAT IS DELIBERATE ────────────────
--
-- A freeze is the firm's own decision about how it is treating a client, and its
-- reason is a partner's words about that client — *"in dispute over the FY26
-- audit fee"*. Gate 2 contains it: no portal route reads this table, and
-- `PORTAL_PATHS` is denied by default. **A portal route whose subject is this
-- table needs its own line here first**, and the answer to whether a client may
-- see that they have been frozen is a question for a firm, not a guess.

GRANT SELECT, INSERT, UPDATE ON crm.client_freeze TO bib_app;

-- ── one rung climbed on one ask ────────────────────────────────────────────

CREATE TABLE delivery.client_ask_chase (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  ask_id          uuid NOT NULL,

  -- Its own wall column, held to the ask's by the composite below — 0063's
  -- arrangement, for 0063's reason. Gate 4 filters this table on the column this
  -- table carries; it does not reach through to the ask.
  client_party_id uuid NOT NULL,

  -- The rung's own KEY, never its index. `DunningStep.key`'s argument and
  -- `escalation_notice.rung_key`'s after it: an index shifts when a firm inserts
  -- a rung, and every chase already recorded is silently renamed.
  rung_key        text NOT NULL CHECK (length(btrim(rung_key)) > 0),

  -- Copied from the rung at the moment it fired, like `escalation_notice` and
  -- like `work_item.sla_days_snapshot`: a firm changing its cadence in April
  -- must not restate what it did in March.
  after_days      integer NOT NULL CHECK (after_days >= 0),

  -- How long the ask had actually been open. Positive; the sweep only ever runs
  -- after the threshold. Stored so the queue reads without recomputing it.
  days_open       integer NOT NULL CHECK (days_open >= 0),

  chased_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_ask_chase_ask_fkey
    FOREIGN KEY (ask_id, client_party_id, tenant_id)
    REFERENCES delivery.client_ask (id, client_party_id, tenant_id),

  -- AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES. The queue may redeliver
  -- and a week of downtime takes every due rung in one sweep, so the same rung
  -- on the same ask must be unwritable twice. This is what makes the event
  -- honest as well: it is emitted only when a row was actually created.
  CONSTRAINT client_ask_chase_once UNIQUE (tenant_id, ask_id, rung_key)
);

CREATE INDEX idx_client_ask_chase_ask
  ON delivery.client_ask_chase (tenant_id, ask_id, chased_at DESC);

ALTER TABLE delivery.client_ask_chase ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_ask_chase_isolation ON delivery.client_ask_chase
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Gate 4, one table as its read lands. The client's action centre shows how many
-- times it has been reminded and when — which is a fact about them, and one a
-- firm should be willing to show: a client who is being chased weekly can see
-- that they are, and a client who was never reminded has that on the record too.
CREATE POLICY client_ask_chase_portal_scope ON delivery.client_ask_chase AS RESTRICTIVE
  USING      (crm.portal_sees(client_party_id))
  WITH CHECK (crm.portal_sees(client_party_id));

-- APPEND-ONLY BY GRANT — `client_ask_response`, `document_version` and the
-- ledger all have this arrangement, and 0063's note gives the reason: a trigger
-- is a rule the table carries, a missing grant is a permission the role does not
-- hold, and an import or an agent walks past the first and not the second. Here
-- it matters because a chase is evidence in the other direction: *"we asked you
-- four times"* is what a firm says when a filing goes late, and a record it can
-- edit is not evidence.
--
-- The REVOKE is required rather than tidy: 0041's ALTER DEFAULT PRIVILEGES
-- grants UPDATE on every table created in this schema.
GRANT SELECT, INSERT ON delivery.client_ask_chase TO bib_app;
REVOKE UPDATE ON delivery.client_ask_chase FROM bib_app;

RESET ROLE;
