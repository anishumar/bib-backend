-- 0032 · The dunning ladder (T3.5) — chasing a receivable, and the one rung a
-- machine may not climb
--
-- ── WHAT THIS TABLE IS, AND WHY IT IS NOT DERIVED ──────────────────────────
--
-- Which rung a receivable has reached could ALMOST be computed: the due date is
-- known, the clock is known, and the ladder is config. It is not derived, and
-- the reason is that a rung is not a fact about time — IT IS A RECORD THAT
-- SOMETHING WAS SENT. Deriving it would mean the answer to "has this client
-- been chased" changed when somebody edited the ladder, and a client who
-- received two reminders would look like a client who received one.
--
-- ── AT-LEAST-ONCE, LIKE EVERYTHING THE ENGINE TOUCHES ──────────────────────
--
-- The sweep re-reads invoices it has seen, pg-boss redelivers on a crash, and a
-- restart leaves a message unacknowledged. None of that may chase a client
-- twice — a second reminder to somebody who has already paid is the kind of
-- mistake a firm hears about. It is structural rather than careful:
-- `UNIQUE (tenant_id, invoice_id, step)` makes the second insert conflict, and
-- the event is recorded only when a row was actually created. The same shape
-- `delivery.job` uses, for the same reason.
--
-- ── THE TERMINAL RUNG NEEDS A PERSON ───────────────────────────────────────
--
-- Credit hold and legal action are the two things on this ladder that a firm
-- cannot take back with an apology. So the worker may CLIMB to the terminal
-- rung and may not APPLY it: the row lands `pending_approval`, and a partner
-- approves or rejects it. That is the acceptance line ("terminal needs partner
-- approval") and it is enforced here rather than in the sweep, because a rule
-- in a worker is one that a second worker, a script or an agent walks past.
--
-- `approved_by` is NOT NULL exactly when the state is `approved`, which is the
-- shape that makes "who put this client on credit hold" answerable — the
-- question somebody asks three months later, and the reason the column exists
-- at all.
--
-- ── THE LADDER ITSELF IS CONFIG, NOT THIS TABLE ────────────────────────────
--
-- D+3, D+7, D+15 are the firm's numbers and they change. They live in the
-- configuration registry as the `dunning` kind — versioned, published, frozen —
-- so a partner edits the ladder without a deploy. This table records what
-- HAPPENED under whichever ladder was in force; `step` is the rung's own key,
-- carried across so a row stays readable after the ladder moves under it.

SET ROLE bib_owner;

-- The key this table needs to point at. `crm.invoice` carries
-- UNIQUE (id, tenant_id, currency) — the key a LINE uses, because a line must
-- also be held to the invoice's currency — and a dunning action has no currency
-- of its own to offer. Redundant with the primary key on `id`, which is exactly
-- why it is safe: it constrains no data, it only gives a foreign key something
-- to point at that carries the tenant with it. Same move 0015 made across
-- `core` and 0027 made on `crm.engagement`.
ALTER TABLE crm.invoice ADD CONSTRAINT invoice_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE crm.dunning_action (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant (id),
  invoice_id   uuid NOT NULL,
  -- The rung's key as the ladder named it ('d3', 'd7', 'final'), NOT an index.
  -- An index would shift when a firm inserts a rung, silently renaming history.
  step         text NOT NULL CHECK (btrim(step) <> ''),
  -- How many days past due this rung fires at, snapshotted from the ladder in
  -- force AT THE MOMENT IT FIRED. Copied rather than joined for the same reason
  -- a work item snapshots its SLA: a later edit to the ladder must not make a
  -- reminder that went out on time look late.
  after_days   integer NOT NULL CHECK (after_days >= 0),
  action       text NOT NULL CHECK (action IN ('reminder', 'call', 'credit_hold', 'legal')),
  -- `taken` for the rungs a machine may climb; the two terminal actions land
  -- `pending_approval` and go no further without a person.
  state        text NOT NULL DEFAULT 'taken'
               CHECK (state IN ('taken', 'pending_approval', 'approved', 'rejected')),
  approved_by  uuid REFERENCES tenancy.user_account (id),
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- THE IDEMPOTENCY GUARANTEE. A sweep that runs twice, a redelivered message
  -- and a restarted worker all try to insert the same (invoice, step); exactly
  -- one succeeds. A client is chased once per rung, structurally.
  CONSTRAINT dunning_action_once_per_step UNIQUE (tenant_id, invoice_id, step),
  CONSTRAINT dunning_action_invoice_tenant_fkey
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES crm.invoice (id, tenant_id),
  -- A decision has a decider and a moment, or it has neither. Half of it stored
  -- is "somebody approved this, we do not know who" — which is the one thing
  -- this row exists to be able to answer.
  CONSTRAINT dunning_action_decided_chk CHECK (
    (state IN ('approved', 'rejected')) = (approved_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- Only the terminal actions are ever gated. A reminder that sat waiting for a
  -- partner would be a ladder that never climbs.
  CONSTRAINT dunning_action_gate_chk CHECK (
    state = 'taken' OR action IN ('credit_hold', 'legal')
  )
);

CREATE INDEX idx_dunning_invoice ON crm.dunning_action (invoice_id, after_days);
CREATE INDEX idx_dunning_pending
  ON crm.dunning_action (tenant_id, created_at) WHERE state = 'pending_approval';

ALTER TABLE crm.dunning_action ENABLE ROW LEVEL SECURITY;
CREATE POLICY dunning_action_isolation ON crm.dunning_action
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::uuid);

CREATE TRIGGER trg_dunning_action_updated
  BEFORE UPDATE ON crm.dunning_action
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- A decision is final. Reversing "we put them on credit hold" by editing the
-- row would leave no trace that it ever happened, and the ladder's whole value
-- is that it is a record of what the firm did to a client.
CREATE FUNCTION crm.refuse_dunning_reversal() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('approved', 'rejected') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION
      'dunning action % was already %, and a decision about a client is not editable. Take the next step instead.',
      OLD.id, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.step IS DISTINCT FROM OLD.step
     OR NEW.action IS DISTINCT FROM OLD.action THEN
    RAISE EXCEPTION
      'dunning action % records what was done to a client and against which invoice; that cannot be rewritten.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_dunning_action_freeze
  BEFORE UPDATE ON crm.dunning_action
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_dunning_reversal();

GRANT SELECT, INSERT, UPDATE ON crm.dunning_action TO bib_app;

COMMENT ON TABLE crm.dunning_action IS
  'What the firm has actually done to chase a receivable. One row per (invoice, rung), so a re-run of the sweep cannot chase a client twice. Terminal rungs (credit_hold, legal) land pending_approval and need a partner.';

RESET ROLE;
