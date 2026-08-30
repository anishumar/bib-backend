-- 0052 · what the LAW asks of an entity — the rules, their exceptions, and the
--        firm's own words for where an obligation has got to (T3.2)
--
-- The first half of T3.2. `delivery.obligation_instance` (0053) hangs off all
-- three tables here, and they arrive first for the same reason 0050 came before
-- 0051: an instance cannot exist before there is a rule that produced it and a
-- state to create it in.
--
-- ── THE ONE IDEA THIS WHOLE TABLE RESTS ON: AN OBLIGATION IS NOT A TASK ─────
--
-- The obligation is what the LAW requires of the ENTITY — Kaveri Foods must
-- file GSTR-3B for August by 20 September. The task is what somebody at the
-- firm must DO about it. Merge them and the calendar can never be GENERATED,
-- only typed in by hand, which is the exact Excel work this product replaces.
--
-- Nobody adds a row to the calendar. It falls out of three things that already
-- exist: which entities there are (0002), what each one bought (0017/0018), and
-- what the law says about that combination — this file. If a human could add a
-- calendar entry, the calendar could drift from the law, and then it is Excel
-- again, only now inside Postgres.
--
-- ── WHY THESE ARE THEIR OWN TABLES AND NOT A CONFIG-REGISTRY KIND ──────────
--
-- `CLAUDE.md` prescribes the registry for a template or a rule pack. It was
-- weighed and set aside, by both devs, for three reasons:
--
--   1. The generator asks for EVERY rule at once and joins them to entities.
--      The registry answers one key at a time — it is built for pinning a
--      version onto a document, not for a set-based sweep.
--   2. An exception needs a REAL foreign key to the rule it modifies
--      (`obligation_template_exception.template_id` below). Inside a jsonb body
--      that relationship is a string somebody has to remember to keep true.
--   3. This shape is proven. It ran in the approved demo and produced a real
--      calendar; the registry shape for it has never been built.
--
-- THE COST, STATED HERE RATHER THAN DISCOVERED LATER: the registry would have
-- supplied versioning, publishing, freezing and pinning for free, and this
-- table now has to supply them itself. That is what `rule_pack`, `status`,
-- `supersedes_id` and the UNIQUE key below are for, and they are not
-- decoration:
--
--   * A REVISION IS A NEW ROW. The unique key includes `rule_pack`, so
--     'gst-in@2026.07' and 'gst-in@2027.04' coexist; the old row is retired
--     with `is_active = false` and stays readable forever.
--   * `supersedes_id` is the chain. Without it, "this rule replaced that one"
--     lives only in whoever did it.
--   * An INSTANCE PINS ITS TEMPLATE (0053's `template_id`), so a filing made
--     last year can still say which version of the rules produced its date.
--
-- Without all of that, *"why was this due then?"* is unanswerable — and that is
-- the one question an audit actually asks.
--
-- ── EVERYTHING SEEDS `unconfirmed`, INDIA INCLUDED ─────────────────────────
--
-- These dates came from a PREVIOUS VENDOR'S document, not from the firm. They
-- are public facts and they check out — but the firm's OWN practice may be
-- earlier than the statutory date, and only the firm can say so.
--
-- This is not decoration either. A due date is a RULE, and a wrong one costs
-- the client a penalty rather than costing us an afternoon. A plausible-looking
-- wrong rule is the dangerous kind precisely because nobody re-reads a date that
-- looks right. So the screen marks every one of them, and confirming one is an
-- UPDATE a partner makes, not a migration somebody asks an engineer for.
--
-- ── THE DUE RULE IS DATA, NOT A FORMULA STRING ─────────────────────────────
--
-- Two shapes cover every computable rule the firm has given us, and both are
-- columns Postgres can CHECK rather than text somebody has to parse:
--
--   day_of_month  `due_month_offset` months after the period ends, then
--                 `due_day_of_month`. "The 20th of the month following."
--                 Advance Tax falls out of it too, at offset 0: Q1 Apr-Jun ends
--                 30 June, offset 0, day 15 -> 15 June, which is correct and is
--                 BEFORE the period ends. The shape did not need widening.
--   days_after    `due_days_after` days after the period ends. "Within 30 days
--                 of allotment", "within 180 days of year end".
--
-- A THIRD SHAPE IS DELIBERATELY ABSENT. India's QRMP scheme makes GSTR-3B
-- quarterly below a turnover threshold, and inventing a condition language
-- before seeing a real condition produces the wrong abstraction. When one
-- arrives it becomes a COLUMN here, not a rewrite. The same argument
-- `StepOperator` makes in `domain/config/model.ts` about `gte`/`lte`, and it is
-- the same answer: the operator arrives with the fact it compares, and nothing
-- in this schema stores a turnover yet.
--
-- ── `due_rule` IS NULLABLE, AND THAT IS THE MOST IMPORTANT DECISION HERE ────
--
-- The firm's own applicability sheet (2026-08-30) holds 55 obligations. Around
-- a dozen are formulas. The rest are not, and the vagueness is CORRECT rather
-- than sloppy:
--
--   "11th of following month"              -> a formula.
--   "Within statutory period after AGM"    -> depends on the AGM date.
--   "State-specific"                       -> PT is a different day in MH and KA.
--   "Within 7 working days from month-end" -> working days are not days, and
--                                             there is no holiday calendar here.
--   "Within 30 days of allotment"          -> an event, and nothing here knows
--                                             the event happened.
--
-- The demo converted what it could and handed the rest back BY NAME in a log.
-- A log is not an answer. So all 55 become ROWS: the computable ones carry a
-- due rule and generate; the rest carry `due_rule IS NULL` and a mandatory
-- `unresolved_reason` in the firm's own terms, and appear on the rules screen
-- saying exactly what is missing.
--
-- THE POINT IS THAT THE SYSTEM CAN NEVER GO QUIET. A firm looking for GSTR-9C
-- and not finding it on the calendar is told, on a screen, that the rule exists
-- and why it cannot produce a date — never left to wonder whether the software
-- is broken. "We read your sheet, here is the one fact we still need" is also a
-- far better question to put to a partner than "what is your compliance
-- calendar".
--
-- ── STATES ARE ROWS, AND CODE READS FLAGS AND NEVER CODES ──────────────────
--
-- Exactly 0050's argument, and the demo got this half wrong in a way worth
-- naming: its sweep looked up states by the literal strings 'pending' and
-- 'in_progress'. That hardcodes the very names the firm was promised it could
-- change, and the first rename would silently switch the rule off. So MEANING
-- lives in booleans and NAMES live in text, and no code in this repo compares
-- `obligation_state.code` to anything.

SET ROLE bib_owner;

-- ── the rule ───────────────────────────────────────────────────────────────
CREATE TABLE delivery.obligation_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- ISO 3166-1 alpha-2, the same form `crm.engagement_letter.jurisdiction` and
  -- `core.legal_entity.jurisdiction` take, so the generator's join is an
  -- equality and not a normalisation.
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),

  -- Which kind of company this reaches — 'private_limited', 'llp', 'fzco'.
  -- NULL MEANS EVERY ENTITY TYPE, and that is the common case rather than the
  -- exception: GST does not care what shape the company is.
  entity_type text CHECK (entity_type IS NULL OR btrim(entity_type) <> ''),

  -- The service that makes this the FIRM's problem, as a `config.entry` — the
  -- catalogue key, NOT a `config.version`.
  --
  -- The entry and not the version, and the two readings differ: a version is
  -- what a document PROMISED and must never move, which is why proposal and
  -- letter lines pin one. A rule is about what the firm SELLS, which is the
  -- entry, and a firm publishing v4 of 'gst-filing' has not stopped owing its
  -- clients GSTR-3B. Pinning a version here would quietly stop generating the
  -- day somebody edited the catalogue.
  --
  -- NULL is meaningful and is the broader reading: the entity owes the filing
  -- whether or not this firm was engaged for it. Generation today runs only
  -- where an engagement exists (see 0053), so a NULL here is representable and
  -- reaches nothing. Which of the two the firm ultimately wants is unanswered,
  -- and this column holds both without deciding.
  service_entry_id uuid,

  -- The firm's own grouping from its sheet — 'GST', 'TDS', 'MCA', 'Payroll'.
  -- Free text and NOT `ServiceBody.module`: that one is the revenue axis
  -- (FRC/TRC/RAA) and this one is the statute's, and a client can buy FRC work
  -- that produces GST obligations. Two axes, deliberately uncrossed, the same
  -- argument `module` and `group` make in the catalogue.
  module text CHECK (module IS NULL OR btrim(module) <> ''),

  -- 'GSTR-3B', 'TDS deposit', 'AOC-4'. What the filing is called.
  name text NOT NULL CHECK (btrim(name) <> ''),
  -- Who it is filed with — 'GST', 'Income Tax', 'MCA', 'EPFO', 'RBI'.
  authority text CHECK (authority IS NULL OR btrim(authority) <> ''),

  -- `half_yearly` is here and is not in the demo: MSME-1 is explicitly
  -- half-yearly on the firm's sheet, and rounding it to quarterly would have
  -- produced four filings a year for an obligation that has two.
  --
  -- `event` has no period and therefore no schedule — a director changes and a
  -- clock starts. It generates nothing today because nothing here knows the
  -- event happened. It is a row anyway so the firm can SEE that we know about
  -- FC-GPR and DIR-12, which is the whole reason `due_rule` is nullable.
  recurrence text NOT NULL
              CHECK (recurrence IN ('monthly', 'quarterly', 'half_yearly', 'annual', 'event')),

  -- Which month the financial year starts in — 4 for India, 1 for a calendar
  -- year. ON THE RULE rather than hidden in code, because it differs by country
  -- and because an Indian QUARTER is Apr-Jun, not Jan-Mar. Computing quarters
  -- on the calendar would put every Indian quarterly filing in the wrong period
  -- and the due date that follows from it would be wrong too.
  fiscal_year_start_month integer NOT NULL DEFAULT 1
              CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

  -- NULL = "this rule is real, and we cannot compute its date yet". See the
  -- long note above; `obligation_due_rule_chk` is what makes that honest.
  due_rule         text CHECK (due_rule IN ('day_of_month', 'days_after')),
  due_month_offset integer CHECK (due_month_offset >= 0),
  due_day_of_month integer CHECK (due_day_of_month BETWEEN 1 AND 31),
  due_days_after   integer CHECK (due_days_after >= 0),

  -- Why this rule cannot produce a date, in the firm's own words: "depends on
  -- the AGM date", "State-specific", "working days, and we hold no holiday
  -- calendar". Mandatory exactly when there is no due rule — an unexplained
  -- blank is indistinguishable from an unfinished import, and the screen would
  -- have nothing to say.
  unresolved_reason text CHECK (unresolved_reason IS NULL OR btrim(unresolved_reason) <> ''),

  -- T-X. How many days before the statutory date the firm starts.
  --
  -- The FIRM's practice, not the law, and the two are different numbers. The
  -- escalation ladder fires on the internal target rather than the statutory
  -- date, because finding out you are late on the day you are late is useless.
  -- Seeds at 0 for every rule: nobody has told us the firm's lead times, and a
  -- guessed one would be a commitment the firm never made.
  lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),

  -- Which version of the rules this came from — 'gst-in@2026.07'. Part of the
  -- unique key, which is what makes a revision a new ROW rather than an edit.
  rule_pack text NOT NULL CHECK (btrim(rule_pack) <> ''),

  -- The rule this one replaced, when it replaced one. The chain the registry
  -- would have given for free.
  supersedes_id uuid,

  -- Has the FIRM confirmed this against the statute? Everything seeds
  -- `unconfirmed`, India included. See the note above.
  status text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed')),

  -- `is_active` says the firm has MOVED ON; `deleted_at` would say the row was
  -- a MISTAKE, and there is no DELETE grant on this schema. Instances sitting
  -- against a retired rule still read; the rule simply stops generating.
  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- THE SHAPE OF A DUE RULE, ENFORCED. Each kind names exactly its own columns
  -- and leaves the others null, so a rule cannot half-describe itself and no
  -- reader has to guess which fields are live. The third branch is the one that
  -- carries the firm's 43 non-computable obligations.
  CONSTRAINT obligation_due_rule_chk CHECK (
    (due_rule = 'day_of_month'
       AND due_month_offset IS NOT NULL AND due_day_of_month IS NOT NULL
       AND due_days_after IS NULL AND unresolved_reason IS NULL) OR
    (due_rule = 'days_after'
       AND due_days_after IS NOT NULL
       AND due_month_offset IS NULL AND due_day_of_month IS NULL
       AND unresolved_reason IS NULL) OR
    (due_rule IS NULL
       AND due_month_offset IS NULL AND due_day_of_month IS NULL
       AND due_days_after IS NULL AND unresolved_reason IS NOT NULL)
  ),

  -- A rule that replaces another must not replace ITSELF — a one-row cycle that
  -- would make the chain infinite to walk.
  CONSTRAINT obligation_template_supersedes_not_self CHECK (supersedes_id IS DISTINCT FROM id),

  -- ONE RULE PER (firm, jurisdiction, name, pack). The pack is in the key on
  -- purpose: it is what lets 'gst-in@2026.07' and 'gst-in@2027.04' both exist,
  -- which is the versioning this table had to build for itself.
  CONSTRAINT obligation_template_key UNIQUE (tenant_id, jurisdiction, name, rule_pack),

  -- The composite the tenant wall runs on, so a child row can never reach a
  -- rule belonging to another firm even if RLS were somehow off.
  CONSTRAINT obligation_template_tenant_key UNIQUE (id, tenant_id),

  -- BOTH references carry the tenant, and both were written id-only first —
  -- `tests/architecture/tenant-keys.integration.test.ts` asks the catalogue
  -- rather than a list and refused the build until they did. That is the rule
  -- CLAUDE.md states and the reason it is not a style preference: a foreign-key
  -- check runs as a SYSTEM operation the row policies do not filter, so an
  -- id-only reference lets one firm's rule name another firm's catalogue
  -- service with no policy violation anywhere. It leaks nothing and the wall is
  -- still supposed to forbid it.
  CONSTRAINT obligation_template_service_tenant_fkey
    FOREIGN KEY (service_entry_id, tenant_id) REFERENCES config.entry (id, tenant_id),
  -- Self-referential, and composite for the same reason: a rule may only ever
  -- supersede one of its OWN firm's rules.
  CONSTRAINT obligation_template_supersedes_tenant_fkey
    FOREIGN KEY (supersedes_id, tenant_id)
    REFERENCES delivery.obligation_template (id, tenant_id)
);
CREATE TRIGGER trg_obligation_template_updated_at BEFORE UPDATE ON delivery.obligation_template
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- The generator's own query: every live rule for a jurisdiction, in one read.
CREATE INDEX idx_obligation_template_lookup
  ON delivery.obligation_template (tenant_id, jurisdiction)
  WHERE is_active;
-- "Which rules cover the thing this client bought" — the coverage screen, and
-- the join the generator makes per rule.
CREATE INDEX idx_obligation_template_service
  ON delivery.obligation_template (tenant_id, service_entry_id)
  WHERE service_entry_id IS NOT NULL;

ALTER TABLE delivery.obligation_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_template_isolation ON delivery.obligation_template
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── the one period a rule does not apply to itself ─────────────────────────
--
-- Real statutes are not uniform. TDS is deposited by the 7th of the following
-- month for eleven months of the year, and March's is due on 30 APRIL. The four
-- quarterly TDS statements have the same shape: 31 Jul, 31 Oct, 31 Jan, and
-- then 31 MAY -- two months after its quarter rather than one.
--
-- A template holds ONE formula, and reading only the normal half produces a rule
-- that is right eleven months a year and quietly wrong every April. That is the
-- worst available failure: nobody re-reads a date that looks right, and the cost
-- lands on the client as a penalty rather than on us as an afternoon.
--
-- So the exception is a ROW AGAINST THE RULE, keyed by the month the filed
-- PERIOD ends in -- not the month it is DUE in, because the due month is exactly
-- what the exception changes, and keying on it would mean asking the answer to
-- find the question. `period_end_month = 3` reads "when the period being filed
-- ended in March".
--
-- DELIBERATELY NOT A CONDITION LANGUAGE. Asked directly, the firm said its only
-- exceptions are month-based and only on TDS. A generic predicate engine built
-- for one confirmed shape is the wrong abstraction guessed early -- the same
-- reason `due_rule` still has two kinds.
CREATE TABLE delivery.obligation_template_exception (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  template_id uuid NOT NULL,

  -- The month the PERIOD ends in, 1-12. March is 3 whatever the financial year
  -- does — this is a calendar month, because that is how the statute names the
  -- exception ("the deduction for March").
  period_end_month integer NOT NULL CHECK (period_end_month BETWEEN 1 AND 12),

  -- NOT nullable here, unlike the template's own. An exception exists only to
  -- state a DIFFERENT date; one that cannot compute a date says nothing at all,
  -- and a row that says nothing is worse than no row because the screen would
  -- show it as a carve-out.
  due_rule         text NOT NULL CHECK (due_rule IN ('day_of_month', 'days_after')),
  due_month_offset integer CHECK (due_month_offset >= 0),
  due_day_of_month integer CHECK (due_day_of_month BETWEEN 1 AND 31),
  due_days_after   integer CHECK (due_days_after >= 0),

  -- Why this period is different, in the firm's own words. MANDATORY: an
  -- exception with no stated reason is unreviewable — a partner checking the
  -- calendar against the statute cannot tell a real carve-out from somebody's
  -- typo. The same spirit as T3.3's `resolution_reason`.
  note text NOT NULL CHECK (btrim(note) <> ''),

  -- WITHDRAWING AN EXCEPTION IS `is_active = false`, NEVER A DELETE. `bib_app`
  -- holds no DELETE grant on a single table in this database and this one is
  -- not going to be the first: an exception is why a filing was due on the day
  -- it was, and a partner who withdraws one in June must not erase the reason
  -- April's return was dated as it was.
  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT obligation_exception_due_rule_chk CHECK (
    (due_rule = 'day_of_month'
       AND due_month_offset IS NOT NULL AND due_day_of_month IS NOT NULL
       AND due_days_after IS NULL) OR
    (due_rule = 'days_after'
       AND due_days_after IS NOT NULL
       AND due_month_offset IS NULL AND due_day_of_month IS NULL)
  ),

  CONSTRAINT obligation_exception_template_tenant_fkey
    FOREIGN KEY (template_id, tenant_id)
    REFERENCES delivery.obligation_template (id, tenant_id)
);
CREATE TRIGGER trg_obligation_exception_updated_at
  BEFORE UPDATE ON delivery.obligation_template_exception
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- ONE LIVE exception per period-month per rule. Two rows claiming March would
-- make the due date depend on row order, which is not a rule at all — but a
-- WITHDRAWN March exception must not block a replacement, so the uniqueness is
-- partial rather than a table constraint. The same shape `delivery.job`'s own
-- key takes, and for the same reason: the constraint is about what is IN FORCE.
CREATE UNIQUE INDEX idx_obligation_exception_key
  ON delivery.obligation_template_exception (tenant_id, template_id, period_end_month)
  WHERE is_active;
CREATE INDEX idx_obligation_exception_template
  ON delivery.obligation_template_exception (tenant_id, template_id)
  WHERE is_active;

ALTER TABLE delivery.obligation_template_exception ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_exception_isolation ON delivery.obligation_template_exception
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── where an obligation has got to, in the firm's own words ────────────────
--
-- ROWS, for 0050's reason: the firm has not been asked what to call these, and
-- a renamed state must be an UPDATE rather than a migration.
--
-- THE FLAGS ARE THE DESIGN. `code` is for people; every rule in the codebase
-- reads a boolean:
--
--   is_initial      what a newly generated obligation starts in   (at most one)
--   is_terminal     nothing further happens
--   needs_decision  a partner has to choose what happens next — T3.3's queue
--
-- "Can this still be missed?" is `NOT is_terminal AND NOT needs_decision`,
-- derived rather than stored, so a firm adding a ninth state does not have to
-- know about a flag whose meaning is already implied by two others.
CREATE TABLE delivery.obligation_state (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  code       text NOT NULL CHECK (btrim(code) <> ''),
  name       text NOT NULL CHECK (btrim(name) <> ''),
  is_initial     boolean NOT NULL DEFAULT false,
  is_terminal    boolean NOT NULL DEFAULT false,
  needs_decision boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A state cannot both be over and be waiting on somebody. `missed` needs a
  -- decision and is therefore NOT terminal, which is the entire point of T3.3:
  -- a missed deadline is a state a partner resolves, not an ending.
  CONSTRAINT obligation_state_terminal_chk CHECK (NOT (is_terminal AND needs_decision)),

  CONSTRAINT obligation_state_code_key UNIQUE (tenant_id, code),
  CONSTRAINT obligation_state_tenant_key UNIQUE (id, tenant_id)
);
CREATE TRIGGER trg_obligation_state_updated_at BEFORE UPDATE ON delivery.obligation_state
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- AT MOST ONE initial state per firm — 0050's partial-unique trick, and its
-- stated limit applies here too: Postgres cannot enforce AT LEAST one, so the
-- service refuses to clear the last one and the seed guarantees a firm starts
-- with it.
CREATE UNIQUE INDEX idx_obligation_state_one_initial
  ON delivery.obligation_state (tenant_id) WHERE is_initial;
CREATE INDEX idx_obligation_state_order
  ON delivery.obligation_state (tenant_id, sort_order);

ALTER TABLE delivery.obligation_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_state_isolation ON delivery.obligation_state
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- SELECT, INSERT, UPDATE — never DELETE, inherited from 0041's ALTER DEFAULT
-- PRIVILEGES on this schema. Retiring a rule is `is_active`; a DELETE would
-- take every instance's explanation of its own due date with it.

-- ── the firms that existed before this migration ───────────────────────────
--
-- Exactly what `createTenant` writes for a new firm from now on, backfilled for
-- the ones already here — 0040's and 0050's arrangement, and
-- `tests/obligation/seed-parity.test.ts` fails the build if this list and
-- `DEFAULT_OBLIGATION_STATES` ever drift.
--
-- Five names, and they are the previous vendor's vocabulary carried across the
-- rebuild — STILL UNCONFIRMED, including for 10x itself. Recorded rather than
-- hidden, and the reason these are rows.
INSERT INTO delivery.obligation_state
  (tenant_id, code, name, is_initial, is_terminal, needs_decision, sort_order)
SELECT t.id, s."code", s."name", s."isInitial", s."isTerminal", s."needsDecision", s."sortOrder"
FROM tenancy.tenant t
-- The literal stays on ONE line, opening with a quote and closing with '::jsonb.
-- That shape is what tests/obligation/seed-parity.test.ts parses, and the marker
-- is what binds it to DEFAULT_OBLIGATION_STATES — SQL cannot import TypeScript,
-- so the duplication is unavoidable and the DRIFT is what the test prevents.
CROSS JOIN LATERAL jsonb_to_recordset('[{"code":"pending","name":"Pending","isInitial":true,"isTerminal":false,"needsDecision":false,"sortOrder":10},{"code":"in_progress","name":"In Progress","isInitial":false,"isTerminal":false,"needsDecision":false,"sortOrder":20},{"code":"filed","name":"Filed","isInitial":false,"isTerminal":true,"needsDecision":false,"sortOrder":30},{"code":"missed","name":"Missed","isInitial":false,"isTerminal":false,"needsDecision":true,"sortOrder":40},{"code":"resolved","name":"Resolved","isInitial":false,"isTerminal":true,"needsDecision":false,"sortOrder":50}]'::jsonb) -- @default-obligation-states-seed
  AS s("code" text, "name" text, "isInitial" boolean, "isTerminal" boolean,
       "needsDecision" boolean, "sortOrder" integer)
ON CONFLICT (tenant_id, code) DO NOTHING;

RESET ROLE;
