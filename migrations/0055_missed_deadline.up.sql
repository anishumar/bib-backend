-- 0055 · a missed deadline is a state, and the decision about it is a record (T3.3)
--
-- T3.2 built a calendar that knows a filing is late. 0054 gave it a way to
-- close. What neither did is the moment in between: the statutory date has
-- passed, nothing was filed, and somebody has to CHOOSE — file it provisionally,
-- accept the late fee, file a nil return, or say it never applied. In a CA firm
-- that moment is where money and liability are settled, and today it happens on
-- WhatsApp and is written down nowhere. Eighteen months later a client asks why
-- a late fee was accepted and the firm has no answer.
--
-- `obligation.missed` has been a REGISTERED VERB WITH NO WRITER since T3.2 —
-- exactly the trap 0054 closed for `obligation.filed`, left open a second time.
-- This migration is what finally writes it.
--
-- ── THE SWEEP NEEDS A DESTINATION, AND `needs_decision` IS NOT ONE ──────────
--
-- The obvious rule is "move it to the state with `needs_decision`". That works
-- only while a firm has exactly one, and nothing says it must: a firm may well
-- want `missed` and, later, `disputed` — both waiting on a person, only one of
-- them where a passed statutory date belongs. With two, "where does the sweep
-- send this row" is a coin toss.
--
-- So `is_missed` is a DESTINATION flag, in the family `is_initial` and
-- `is_filed` already belong to, and `needs_decision` stays what it is: a
-- BEHAVIOUR — this state is waiting on a human, so `canStillBeMissed` is false
-- and the sweep will not pick the row up twice. The two are different questions
-- and 0054's whole argument was that collapsing two different questions into
-- one flag is how a rule ends up right by accident.
--
--   destinations   is_initial · is_filed · is_missed · is_resolution
--                  "a row moves HERE when X happens" — at most one each
--   behaviours     is_terminal · needs_decision
--                  "once a row is here, this is true of it"
--
-- ── AND `resolved` NEEDS ONE TOO, FOR 0054'S OWN REASON ────────────────────
--
-- 0054 could not use `is_terminal` to find where a filing lands, because a firm
-- starts with TWO terminal states and the other one is `resolved`. The mirror
-- of that problem is this one: `resolved` cannot be found by "terminal and not
-- filed" either, because that is a definition by subtraction that breaks the
-- moment a firm adds a third terminal state. `is_resolution` names it.
--
-- ── WHY THE OPTIONS ARE ROWS AND NOT A CHECK ───────────────────────────────
--
-- The four shipped options come from the previous vendor's app, where they were
-- a hardcoded TypeScript literal. They are ALSO the firm's own described
-- practice — and that is precisely why they seed `unconfirmed` rather than
-- confirmed: the practice was described in a conversation, not confirmed
-- against this list, and the same open question is recorded against them as
-- against the India rule pack's dates. A partner confirms them on a screen,
-- which is an UPDATE, not a migration.
--
-- Rows also make the one question a partner actually asks answerable:
-- "how many did we accept a late fee on this quarter?" is a GROUP BY over a
-- column, and free text cannot be grouped. The reason stays free text BESIDE
-- the option, because the list can never hold "the client's accountant was on
-- leave and the books arrived on the 19th" — and that is the half nobody
-- remembers later.
--
-- ── `closes_without_filing` IS THE FORK, AND IT IS THE FIRM'S TO SET ───────
--
-- A partner's answer decides two different things, and only one of them is the
-- reason:
--
--   "file it late / provisionally / nil"  the obligation is NOT over. It goes
--                                         back to work, and when that work
--                                         finishes 0054 files it — late, with
--                                         `daysLate` on the event. Nothing here
--                                         has to know how that ends.
--   "it never applied"                    the obligation IS over, and it will
--                                         never be filed. It lands in the
--                                         firm's resolution state.
--
-- Which of the two an option means is a COLUMN on the option, not a branch in
-- code, so a firm adding "client deregistered mid-year" says what it means
-- without a deploy.
--
-- ── THE FLOOR IS DELIBERATELY NOT DECIDED HERE ─────────────────────────────
--
-- Generation reaches back 90 days, so a firm onboarding in September with
-- engagements dated May gets four months of obligations whose dates have all
-- passed — and would get a decision queue with hundreds of rows on its first
-- morning, every one of them a filing the firm already made in Excel. The one
-- screen whose whole value is being trusted would stop being trusted on day one.
--
-- The answer is a date the FIRM sets — "our calendar goes live from here, do
-- not ask me about anything before it" — and it lives in the config registry as
-- `compliance_policy`, versioned and published like every other rule a firm
-- sets for itself. It is deliberately UNSET by default: no published policy
-- means no floor, which is the behaviour this system already has, and the knob
-- exists so the answer can be given on a screen rather than guessed here.

SET ROLE bib_owner;

-- ── the two destination flags ──────────────────────────────────────────────

ALTER TABLE delivery.obligation_state
  ADD COLUMN is_missed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.obligation_state.is_missed IS
  'Where an obligation lands when its statutory date passes undischarged. A destination, not a description: needs_decision says a human must act, which can be true of several states, while this says which one the sweep writes.';

ALTER TABLE delivery.obligation_state
  ADD COLUMN is_resolution boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery.obligation_state.is_resolution IS
  'Where an obligation lands when a partner decides it will never be filed. The other terminal state; is_filed is where one lands when it WAS filed.';

-- A row the sweep moves here is a row waiting on a person. Without this a firm
-- could tick is_missed on an ordinary working state, and every overdue filing
-- would vanish into it silently instead of reaching a queue.
ALTER TABLE delivery.obligation_state
  ADD CONSTRAINT obligation_state_missed_chk
    CHECK (NOT (is_missed AND NOT needs_decision));

-- A resolution is an ENDING. `obligation_state_terminal_chk` (0052) already
-- refuses terminal-and-needs-decision, so this also keeps is_resolution and
-- is_missed apart without a third constraint saying so.
ALTER TABLE delivery.obligation_state
  ADD CONSTRAINT obligation_state_resolution_chk
    CHECK (NOT (is_resolution AND NOT is_terminal));

-- At most ONE destination per state. Two would make "what does this state mean"
-- unanswerable, and the four rules that read these flags would each pick a
-- different answer.
ALTER TABLE delivery.obligation_state
  ADD CONSTRAINT obligation_state_one_destination_chk
    CHECK (
      is_initial::int + is_filed::int + is_missed::int + is_resolution::int <= 1
    );

-- AT MOST ONE per firm, 0052's and 0054's partial-unique trick a third and
-- fourth time. Postgres cannot enforce AT LEAST one; the seed below and
-- tests/obligation/seed-parity.test.ts are what guarantee the floor, and the
-- service refuses to clear the last holder.
CREATE UNIQUE INDEX idx_obligation_state_one_missed
  ON delivery.obligation_state (tenant_id) WHERE is_missed;

CREATE UNIQUE INDEX idx_obligation_state_one_resolution
  ON delivery.obligation_state (tenant_id) WHERE is_resolution;

-- ── what a partner may choose, as the firm's own list ──────────────────────

CREATE TABLE delivery.obligation_resolution_option (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  code       text NOT NULL CHECK (btrim(code) <> ''),
  name       text NOT NULL CHECK (btrim(name) <> ''),

  -- The fork. False means the filing still has to happen and the obligation
  -- goes back to work; true means it never will and the obligation ends.
  closes_without_filing boolean NOT NULL DEFAULT false,

  -- The same word `obligation_template.status` uses, and for the same reason:
  -- these four came from a previous vendor's app and match what the firm
  -- described, but nobody has confirmed the LIST. A screen shows the difference
  -- rather than presenting a guess as settled.
  status text NOT NULL DEFAULT 'unconfirmed'
    CHECK (status IN ('unconfirmed', 'confirmed')),

  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT obligation_resolution_option_code_key UNIQUE (tenant_id, code),
  -- The composite every child FK in this codebase points at, so a row in one
  -- firm can never reference an option in another.
  CONSTRAINT obligation_resolution_option_tenant_key UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_obligation_resolution_option_updated_at
  BEFORE UPDATE ON delivery.obligation_resolution_option
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

CREATE INDEX idx_obligation_resolution_option_order
  ON delivery.obligation_resolution_option (tenant_id, sort_order);

ALTER TABLE delivery.obligation_resolution_option ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_resolution_option_isolation ON delivery.obligation_resolution_option
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── what was decided about one obligation, and why ─────────────────────────

ALTER TABLE delivery.obligation_instance
  ADD COLUMN resolution_option_id uuid,
  ADD COLUMN resolution_reason    text,
  ADD COLUMN resolved_at          timestamptz;

COMMENT ON COLUMN delivery.obligation_instance.resolution_reason IS
  'Why the partner chose what they chose, in their own words. Mandatory with a decision: the option says WHAT was done and can be counted, this says why and is the half nobody remembers eighteen months later.';

COMMENT ON COLUMN delivery.obligation_instance.resolved_at IS
  'When a decision was recorded. Also the sweep guard: an obligation somebody has already decided about is never flagged missed a second time, even after it goes back to work with its statutory date still in the past.';

-- All three or none. A decision with no reason is the thing this feature exists
-- to prevent, and a reason attached to no decision is a note nobody can act on.
-- Enforced here as well as in the service because it is the whole point.
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_resolution_chk
    CHECK (
      (resolution_option_id IS NULL AND resolution_reason IS NULL AND resolved_at IS NULL)
      OR (resolution_option_id IS NOT NULL AND resolution_reason IS NOT NULL
          AND resolved_at IS NOT NULL AND btrim(resolution_reason) <> '')
    );

ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_resolution_tenant_fkey
    FOREIGN KEY (resolution_option_id, tenant_id)
    REFERENCES delivery.obligation_resolution_option (id, tenant_id);

-- The decision queue's own index: everything past its statutory date that
-- nobody has decided about, oldest first. Partial, because a decided or filed
-- obligation is never in this list and within a year those are most of the
-- table — the same argument `idx_obligation_instance_unraised` makes.
CREATE INDEX idx_obligation_instance_undecided
  ON delivery.obligation_instance (tenant_id, statutory_due_on)
  WHERE filed_on IS NULL AND resolved_at IS NULL;

-- ── the registry's ninth kind ──────────────────────────────────────────────
--
-- `compliance_policy` holds the floor date described at the top of this file.
-- Adding a kind is a code change too: `validateCompliancePolicyBody` in
-- `domain/config/model.ts` is its validator, and a kind without one accepts
-- anything.
ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier', 'verification_policy',
                    'compliance_policy'));

-- ── bringing every firm that already exists forward ───────────────────────
--
-- `ON CONFLICT … DO UPDATE`, touching the NEW columns only — 0054's arrangement
-- and its reasoning: `name` and `sort_order` are left alone because a firm may
-- already have renamed or reordered its own vocabulary, and this migration has
-- no business undoing that.
--
-- Matching by `code` here is the one-time data migration reading the seed it
-- wrote itself. The ban this codebase enforces is on RULES that compare a code
-- at run time; from here on the rules read the flags.

INSERT INTO delivery.obligation_state
  (tenant_id, code, name, is_initial, is_terminal, needs_decision, is_filed, is_missed, is_resolution, sort_order)
SELECT t.id, s."code", s."name", s."isInitial", s."isTerminal", s."needsDecision", s."isFiled", s."isMissed", s."isResolution", s."sortOrder"
FROM tenancy.tenant t
-- The literal stays on ONE line, opening with a quote and closing with '::jsonb —
-- that shape is what tests/obligation/seed-parity.test.ts parses, and it reads
-- the NEWEST migration carrying the marker, which is now this one.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"pending","name":"Pending","isInitial":true,"isTerminal":false,"needsDecision":false,"isFiled":false,"isMissed":false,"isResolution":false,"sortOrder":10},{"code":"in_progress","name":"In Progress","isInitial":false,"isTerminal":false,"needsDecision":false,"isFiled":false,"isMissed":false,"isResolution":false,"sortOrder":20},{"code":"filed","name":"Filed","isInitial":false,"isTerminal":true,"needsDecision":false,"isFiled":true,"isMissed":false,"isResolution":false,"sortOrder":30},{"code":"missed","name":"Missed","isInitial":false,"isTerminal":false,"needsDecision":true,"isFiled":false,"isMissed":true,"isResolution":false,"sortOrder":40},{"code":"resolved","name":"Resolved","isInitial":false,"isTerminal":true,"needsDecision":false,"isFiled":false,"isMissed":false,"isResolution":true,"sortOrder":50}]'::jsonb) -- @default-obligation-states-seed
  AS s("code" text, "name" text, "isInitial" boolean, "isTerminal" boolean,
       "needsDecision" boolean, "isFiled" boolean, "isMissed" boolean,
       "isResolution" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO UPDATE
  SET is_missed = EXCLUDED.is_missed, is_resolution = EXCLUDED.is_resolution;

-- The four options, for every firm that already exists and — via `createTenant`
-- — for every firm from now on. `DO NOTHING`: a firm that has already made its
-- own list keeps it.
INSERT INTO delivery.obligation_resolution_option
  (tenant_id, code, name, closes_without_filing, sort_order)
SELECT t.id, o."code", o."name", o."closesWithoutFiling", o."sortOrder"
FROM tenancy.tenant t
-- Same one-line rule as above; parsed by tests/obligation/seed-parity.test.ts.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"provisional_filing","name":"File provisionally","closesWithoutFiling":false,"sortOrder":10},{"code":"late_fee","name":"Accept the late fee","closesWithoutFiling":false,"sortOrder":20},{"code":"nil_return","name":"Nil return","closesWithoutFiling":false,"sortOrder":30},{"code":"not_applicable","name":"Not applicable to this entity","closesWithoutFiling":true,"sortOrder":40}]'::jsonb) -- @default-resolution-options-seed
  AS o("code" text, "name" text, "closesWithoutFiling" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO NOTHING;

RESET ROLE;
