-- 0067 · The proactive nudge (T6.7) — the half T4.4 deliberately left, and it
--        is NOT the chaser with a minus sign
--
-- ── WHY IT IS NOT A RUNG OF THE CHASER'S LADDER ────────────────────────────
--
-- T4.4's board line reads *"reminder ladders (T–3 daily, D+3/7/15)"* and only
-- the D+ half was built. The reason it stopped there is the whole design of this
-- file (Shrestha, 2026-09-01): **a filing approaching its statutory date asks the
-- client for NOTHING.**
--
-- A chase is about an OPEN ASK — the firm wants a document and has not had it,
-- the client owes them an answer, and the count of reminders is evidence when
-- the filing goes late. A nudge is about an OBLIGATION — *"your GSTR-3B is due
-- on the 20th"* — and it wants nothing back. Different subject, different
-- direction, different cadence, and one thing that follows from all three:
--
--   · the chase counts FORWARD from when the firm asked (`afterDays`, ascending)
--   · the nudge counts BACKWARD from a date the LAW set (`beforeDays`,
--     DESCENDING — 7, then 3, then 1)
--
-- Bending `chaser`'s ladder to carry both would need a sign convention on
-- `afterDays`, and a firm writing `-3` into a field called "after" is a firm
-- being asked to hold two ideas in one number.
--
-- ── THE WALL COLUMN IS `entity_party_id`, WHICH IS NOT THE CLIENT ────────
--
-- A grant names a party and each table names its own column. `client_ask` has
-- `client_party_id` because an ask is addressed to whoever the WORK is for;
-- `obligation_instance` has `entity_party_id` because *"the ENTITY, never the
-- client"* (0053), and a filing belongs to the company the law names. So this
-- table carries `entity_party_id`, held to the obligation's by a composite
-- foreign key exactly as 0063 and 0065 hold theirs — the denormalised wall
-- column CANNOT DISAGREE rather than being trusted.
--
-- The consequence is the one 0062 already stated and is worth re-stating because
-- it looks like a bug the first time somebody meets it: a contact granted Cobalt
-- Foods is nudged about Cobalt Foods' filings and NOT about its subsidiary's,
-- even though the subsidiary's TASK is on their page. Reaching the subsidiary's
-- filings would mean joining `crm.engagement`, a nullable join and the exact
-- derivation 0059 refused. A contact who should see both gets two grants.
--
-- ── AND THE FREEZE DOES NOT STOP IT ──────────────────────────────────────
--
-- 0065's `crm.client_freeze` stops the CHASER and this table is not in its
-- reach, which is a decision and not an omission (Shrestha, 2026-09-01):
--
--   · **The date is the LAW's, not the firm's.** Everything else the portal
--     refuses to show a client is a deadline this product or this firm invented
--     — `internal_target_on`, a turnaround time nobody promised. A statutory
--     date is the one date that travels, and going quiet about it because a fee
--     is in dispute exposes the client to a penalty and the firm to a claim for
--     having known and said nothing. A dispute about an audit fee is not a
--     reason to let somebody miss a GST return.
--   · **And structurally it could not reach anyway.** A freeze is keyed on
--     `client_party_id`; an obligation carries `entity_party_id`. Joining the
--     two is the nullable `crm.engagement` derivation this schema has now
--     refused three times. The rule and the decision agree, which is usually the
--     sign the rule was right.
--
-- If a firm ever wants a nudge freeze, it is its own effective-dated row on the
-- ENTITY, and it needs its own migration and its own argument.
--
-- ── NOTHING IS SET BY DEFAULT ────────────────────────────────────────────
--
-- Its own config kind, and a firm that has published no `nudge` entry nudges
-- NOBODY. Third time this rule is written down (dunning, escalation, chaser) and
-- it is not weaker here for being ordinary: a client who did not ask to be
-- reminded about their own filings reads an unasked-for reminder as the firm
-- managing them.

SET ROLE bib_owner;

-- ── the ladder is a new kind of configuration ─────────────────────────────
--
-- Rewritten in full rather than added to, because `entry_kind_check` is a CHECK
-- and there is no way to extend one in place. The list is the union of every
-- kind up to and including this one.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry ADD CONSTRAINT entry_kind_check CHECK (kind = ANY (ARRAY[
  'service', 'role', 'policy', 'clause', 'dunning', 'workflow_template',
  'confidence_tier', 'verification_policy', 'compliance_policy', 'escalation',
  'chaser', 'nudge'
]));

-- ── the composite the nudge's foreign key needs ───────────────────────────
--
-- 0063's arrangement, third time. `id` is already the primary key so this adds
-- no uniqueness that was not true; it exists so a child can reference the row
-- AND the party it belongs to in ONE constraint and have the database check the
-- PAIR. That is what makes "each table names its own column" a guarantee here
-- rather than a convention — the wall column is denormalised, and this is what
-- stops the denormalisation drifting.
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_id_entity_tenant_key
  UNIQUE (id, entity_party_id, tenant_id);

-- ── one rung told to one client about one filing ──────────────────────────

CREATE TABLE delivery.obligation_nudge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenancy.tenant(id),

  obligation_id   uuid NOT NULL,

  -- The wall column, and it is the ENTITY's — see the header. Held to the
  -- obligation's by the composite foreign key below; gate 4 filters THIS table
  -- on the column THIS table carries and never reaches through to the parent.
  entity_party_id uuid NOT NULL,

  -- The rung's own KEY, never its index. `DunningStep.key`, then
  -- `escalation_notice.rung_key`, then `client_ask_chase.rung_key`: an index
  -- shifts when a firm inserts a rung and every row already written is silently
  -- renamed.
  rung_key        text NOT NULL CHECK (length(btrim(rung_key)) > 0),

  -- Copied from the rung at the moment it fired. A firm that moves its ladder
  -- from 7 days to 10 in April must not restate what it sent in March —
  -- `client_ask_chase.after_days` and `work_item.sla_days_snapshot` before it.
  before_days     integer NOT NULL CHECK (before_days >= 0),

  -- How many days were ACTUALLY left when it fired. Non-negative: a nudge is
  -- about something coming up, and a filing already past its date is a MISSED
  -- deadline (T3.3) with its own state and its own screen. "Due in -5 days" is
  -- not a sentence, and the sweep never produces one.
  days_until      integer NOT NULL CHECK (days_until >= 0),

  -- The date the nudge NAMED, snapshotted. The obligation carries it too and a
  -- revision creates a NEW instance rather than moving this one (0053's re-run
  -- key), so the two agree today — this is here so that "we told you it was due
  -- on the 20th" stays answerable even if that ever stops being true. A date
  -- quoted to a client is a statement the firm made.
  due_on          date NOT NULL,

  nudged_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT obligation_nudge_obligation_fkey
    FOREIGN KEY (obligation_id, entity_party_id, tenant_id)
    REFERENCES delivery.obligation_instance (id, entity_party_id, tenant_id),

  -- AT-LEAST-ONCE, like everything the engine touches. pg-boss redelivers, a
  -- worker restarts mid-pass, and the filing is still due tomorrow — so the same
  -- rung on the same filing must be unwritable twice. It is also what makes the
  -- ledger event honest: it is emitted only for rows actually created.
  CONSTRAINT obligation_nudge_once UNIQUE (tenant_id, obligation_id, rung_key)
);

-- The client's own question — "what have you told me about this filing" — and
-- the sweep's, which reads the rungs already sent per obligation.
CREATE INDEX idx_obligation_nudge_obligation
  ON delivery.obligation_nudge (tenant_id, obligation_id, nudged_at DESC);

ALTER TABLE delivery.obligation_nudge ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_nudge_isolation ON delivery.obligation_nudge
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Gate 4, one table as its read lands — and the read lands in the SAME task,
-- which is the rule this codebase learnt six times over. The client's own
-- filings list shows when they were last told about each one, so a client can
-- see the firm has been in touch and a firm can see it has.
CREATE POLICY obligation_nudge_portal_scope ON delivery.obligation_nudge AS RESTRICTIVE
  USING      (crm.portal_sees(entity_party_id))
  WITH CHECK (crm.portal_sees(entity_party_id));

-- APPEND-ONLY BY GRANT — `client_ask_chase`, `client_ask_response`,
-- `document_version` and the whole `ledger` schema have this arrangement, and
-- 0063's note gives the reason: a trigger is a rule the table carries, a missing
-- grant is a permission the role does not hold, and an import or an agent walks
-- past the first and not the second.
--
-- The REVOKE is required rather than tidy: 0041's ALTER DEFAULT PRIVILEGES
-- grants UPDATE on every table created in this schema.
GRANT SELECT, INSERT ON delivery.obligation_nudge TO bib_app;
REVOKE UPDATE ON delivery.obligation_nudge FROM bib_app;

RESET ROLE;
