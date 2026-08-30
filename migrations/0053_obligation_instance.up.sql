-- 0053 · the calendar itself — one row per entity, per rule, per period (T3.2)
--
-- The second half of T3.2. 0052 holds what the LAW says; this holds what that
-- means for one company in one month, and it is the table the whole product is
-- pointed at: the Excel a CA firm keeps for four hundred clients, generated
-- instead of typed.
--
-- ── NOBODY INSERTS INTO THIS TABLE BY HAND ─────────────────────────────────
--
-- Every row falls out of a cross product the system already knows: rules
-- (0052) x entities that bought the service (crm.engagement, 0017/0018) x the
-- periods between two dates. There is no create endpoint and there will not be
-- one. If a human could add a row, the calendar could drift from the statute,
-- and a calendar that can drift is Excel with extra steps.
--
-- ── THE UNIQUE KEY IS THE WHOLE IDEMPOTENCY STORY ──────────────────────────
--
-- `(tenant_id, template_id, entity_party_id, period_start)`. The generator runs
-- every night, forever, over a window that reaches ninety days back and a year
-- forward — so it re-proposes the same rows hundreds of times, and the second
-- proposal must change nothing. `ON CONFLICT DO NOTHING` against this key is
-- what makes that true, and it is a CONSTRAINT rather than a read-then-write
-- because the sweep can run concurrently with itself after a redelivery, and
-- only the database can arbitrate that correctly.
--
-- That is the acceptance line "re-running the generator changes nothing", and
-- it holds structurally rather than by care.
--
-- ── TWO DATES, AND THE DIFFERENCE BETWEEN THEM IS THE POINT ────────────────
--
--   statutory_due_on   what the LAW says. Missing it is a penalty — the
--                      client's money.
--   internal_target_on what the FIRM gave itself, T-X earlier. Missing that is
--                      an internal problem and still recoverable, which is why
--                      it is the one that raises the task and the one the
--                      escalation ladder will watch.
--
-- A single "due date" column would have collapsed the two and quietly picked
-- one, and whichever it picked would be wrong for the other purpose.
--
-- ── KEYED ON THE ENTITY, NEVER ON THE CLIENT ───────────────────────────────
--
-- `entity_party_id`, which is 0018's column. A client with four companies owes
-- four sets of filings, and each set has its own GSTIN, its own registration
-- and its own penalties. Keying on the client would merge them into one, which
-- is precisely the mistake `core.legal_entity` exists to prevent.
--
-- ── `engagement_id` IS NULLABLE ON PURPOSE, AND IT IS A PRODUCT QUESTION ────
--
-- An entity owes GSTR-3B whether or not this firm files it. Generating only
-- where an engagement exists is a CRM — "track OUR work". Generating for every
-- entity and marking which is ours is a compliance engine — "track THEIR
-- compliance", where every uncovered obligation is a sales lead.
--
-- DECIDED for now: only where an engagement exists, which is the smaller and
-- more defensible of the two. The column stays nullable so the other reading is
-- a config change rather than a migration. The firm has not been asked which it
-- ultimately wants, and this schema does not answer it for them.
--
-- ── `work_item_id` IS WHERE AN OBLIGATION BECOMES SOMEBODY'S JOB ───────────
--
-- The one place the two halves of the system are joined, and it is a nullable
-- column rather than a merged table for the reason 0052 opens with. The
-- obligation exists from the day the rule and the engagement do; the task
-- appears at T-X. Null means "known, not yet started", and a year of those is
-- the calendar's normal state rather than a backlog.

SET ROLE bib_owner;

CREATE TABLE delivery.obligation_instance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- THE PIN. Which version of the rules produced this date — see 0052's note on
  -- `rule_pack`. A revision is a new template row, so this reference alone
  -- answers "why was this due then?" years later.
  template_id uuid NOT NULL,

  -- Whose obligation it is. The ENTITY, never the client.
  entity_party_id uuid NOT NULL,

  -- The engagement that makes it the firm's work. Nullable — see above.
  engagement_id uuid,

  -- The period being filed for, and a label a human reads: "Aug 2026",
  -- "Q2 FY2026-27", "FY2026-27". The label is STORED rather than derived at
  -- read time because it depends on the rule's fiscal year, and a rule that is
  -- later retired must not change how a filing already made is described.
  period_start date NOT NULL,
  period_end   date NOT NULL,
  period_label text NOT NULL CHECK (btrim(period_label) <> ''),

  statutory_due_on  date NOT NULL,
  internal_target_on date NOT NULL,

  state_id uuid NOT NULL,

  -- The task raised for it, once one has been. NOT unique across the table:
  -- one work item per obligation is what the generator writes, but the reverse
  -- constraint belongs on the work item and 0051 already carries the one that
  -- matters (one per engagement).
  work_item_id uuid,

  -- When it was actually discharged. Set when the obligation's work item
  -- reaches a terminal state — the firm ticks the task it was already working,
  -- and the calendar follows, rather than asking anyone to tick two things.
  filed_on date,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A period that ends before it starts is not a period. Cheap, and it catches
  -- an off-by-one in the fiscal-year arithmetic at the write rather than in a
  -- filing six months later.
  CONSTRAINT obligation_instance_period_chk CHECK (period_end >= period_start),

  -- T-X CAN NEVER BE AFTER T. A lead time longer than the gap between period
  -- end and deadline would otherwise produce an internal target AFTER the legal
  -- one, which reads on the screen as slack that does not exist. The domain
  -- clamps it; this refuses to store it if the clamp is ever removed.
  CONSTRAINT obligation_instance_target_chk CHECK (internal_target_on <= statutory_due_on),

  -- THE RE-RUN KEY. See the note at the top — this is the acceptance line.
  CONSTRAINT obligation_instance_key
    UNIQUE (tenant_id, template_id, entity_party_id, period_start),

  CONSTRAINT obligation_instance_tenant_key UNIQUE (id, tenant_id),

  -- Every reference is composite, so a row can never reach across the tenant
  -- wall even if RLS were somehow off — the rule the whole schema follows.
  CONSTRAINT obligation_instance_template_tenant_fkey
    FOREIGN KEY (template_id, tenant_id)
    REFERENCES delivery.obligation_template (id, tenant_id),
  CONSTRAINT obligation_instance_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT obligation_instance_engagement_tenant_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id),
  CONSTRAINT obligation_instance_state_tenant_fkey
    FOREIGN KEY (state_id, tenant_id) REFERENCES delivery.obligation_state (id, tenant_id),
  CONSTRAINT obligation_instance_work_item_tenant_fkey
    FOREIGN KEY (work_item_id, tenant_id) REFERENCES delivery.work_item (id, tenant_id)
);
CREATE TRIGGER trg_obligation_instance_updated_at BEFORE UPDATE ON delivery.obligation_instance
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ── the reads these exist for ──────────────────────────────────────────────
--
-- The calendar screen, ordered on the INTERNAL target rather than the statutory
-- date, because that is the actionable one: a list sorted by the legal deadline
-- tells you when you are already too late. Partial on undischarged rows —
-- within a year the filed ones are almost the whole table and never the answer.
CREATE INDEX idx_obligation_instance_due
  ON delivery.obligation_instance (tenant_id, internal_target_on)
  WHERE filed_on IS NULL;
-- One entity's compliance position — the client page's panel, and the portal's
-- scope later.
CREATE INDEX idx_obligation_instance_entity
  ON delivery.obligation_instance (tenant_id, entity_party_id, statutory_due_on);
-- "What has this rule ever produced" — the rules screen, and how a partner
-- checks a lead-time change before making it.
CREATE INDEX idx_obligation_instance_template
  ON delivery.obligation_instance (tenant_id, template_id);
-- THE COVERAGE QUERY: which engagements the calendar has produced nothing for.
-- An anti-join, so it needs the engagement side indexed and only on live rows.
CREATE INDEX idx_obligation_instance_engagement
  ON delivery.obligation_instance (tenant_id, engagement_id)
  WHERE engagement_id IS NOT NULL;
-- The raise pass: everything at or past its internal target with no task yet.
-- Partial on exactly that set, which is a handful of rows out of a year's worth.
CREATE INDEX idx_obligation_instance_unraised
  ON delivery.obligation_instance (tenant_id, internal_target_on)
  WHERE work_item_id IS NULL AND filed_on IS NULL;

ALTER TABLE delivery.obligation_instance ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_instance_isolation ON delivery.obligation_instance
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- SELECT, INSERT, UPDATE — never DELETE, inherited from 0041's ALTER DEFAULT
-- PRIVILEGES on this schema. There is no way to un-owe a filing: a rule that
-- turned out not to apply is retired (`is_active`), and the instances it
-- already produced stay, because "we thought you owed this and you did not" is
-- a fact somebody may have to explain.

RESET ROLE;
