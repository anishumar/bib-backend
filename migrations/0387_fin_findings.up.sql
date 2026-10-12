-- 0387 · FinCompliance findings: the dated values the rule checks read, the
--        findings they raise, and a person's decision on each
--        (docs/FIN_BUILD_PLAN.md F4.1, F4.2).
--
-- Ground rule 2, in tables: a machine may say "check this", and only a person
-- decides what it means. `fin.finding` is the machine's sentence and is never
-- edited; `fin.finding_decision` is the person's answer and is never edited
-- either. A finding's status is its LATEST decision, and open when it has none.
--
-- ── fin.rule_parameter: THE LAW, DATED (F4.1) ───────────────────────────────
--
-- GLOBAL: the GST rate on 1 March 2025 and the CPF ceiling in June are the same
-- for every firm in this product, as a day's dollar is in fx.daily_rate
-- (0345). So the table has no tenant_id and no RLS, `bib_app` may only SELECT
-- it, and only a migration writes it (later F7, with a proposer and a
-- different approver). A firm cannot edit the law, and a check never reads one
-- firm's opinion of it.
--
-- Half-open, like every effective-dated row in this product: `valid_to` is the
-- FIRST DAY NOT IN FORCE, NULL while nothing has replaced the value. The
-- exclusion constraint refuses two values for one (jurisdiction, key) on the
-- same day, so "which rate applied on 31 December 2023" has exactly one
-- answer. A day no row covers means the value is NOT SEEDED, never that the
-- law was silent: a check that finds nothing in force checks nothing, rather
-- than guessing.
--
-- `value` is jsonb because the values have different shapes (a rate, a
-- ceiling, a table of age bands). `domain/fin/parameters.ts` is the one reader
-- and refuses a value it cannot read; amounts and percentages are decimal
-- STRINGS in it, as everywhere else. `source` is the official citation, so a
-- partner asking "says who?" is answered by the row.
--
-- ── WHAT IS SEEDED, AND WHAT IS NOT ─────────────────────────────────────────
--
-- Singapore, checked against the official pages named in `source` on
-- 2026-10-11, and every 2025 value against the training pack's answer key
-- (`99_Ground_Truth/payroll_truth.csv`, all five companies: every row the
-- pack does not mark as a seeded error recomputes to the cent).
--
-- Left out on purpose, so a check skips rather than guesses:
--   * CPF rates before 2025 and from 2027 (2027's are announced; nothing here
--     reads them yet, and F7 is where an announced change is approved);
--   * the graduated rates for wages of S$750 or less, and for a permanent
--     resident's first two years (a payroll line does not say which year);
--   * the CPF ceilings before 2024;
--   * how the SDL is rounded (the statute says 0.25%, not which way a half
--     cent goes; the check allows a cent either side).
--
-- ── fin.finding: ONE ROW PER THING A CHECK SAID (F4.2) ─────────────────────
--
-- One row per `FindingDraft` (domain/fin/finding.ts). `lane` keeps the two
-- kinds apart for good: `rule` is a fixed rule broken and counts toward the
-- exception score; `pattern` is a comparison with the client's own history
-- and never does (F5).
--
-- `dedupe_key` is UNIQUE PER FIRM, the conscious scope: the key is built from
-- the firm's own line ids and the check, so two firms never share one, and a
-- re-run of the same checks over the same lines produces the same keys and
-- raises nothing new (ON CONFLICT DO NOTHING; the event is written only for a
-- row actually created).
--
-- `facts` is a flat object of machine facts (amounts as decimal strings,
-- counts, days, codes). Flat is a CHECK, so nothing nests a document inside a
-- finding. Names stay on the lines the finding points at.
--
-- Append-only by GRANT (SELECT, INSERT): what a check said is evidence, and a
-- person's answer is a new row in fin.finding_decision, never an edit here.
--
-- ── fin.finding_line: WHICH LINES IT IS ABOUT ──────────────────────────────
--
-- `fin.transaction_line` is migration 0386 (F2.5), built in parallel and not
-- in this branch. So `line_id` carries NO foreign key yet: the coordinator
-- adds `FOREIGN KEY (line_id, tenant_id) REFERENCES fin.transaction_line (id,
-- tenant_id)` in the migration that merges the two, when both exist. The key
-- to the finding is here, composite, as the tenant wall requires.
--
-- ── fin.finding_decision: A PERSON'S ANSWER (F4.2) ─────────────────────────
--
-- Ask the client, correct, or dismiss. APPEND-ONLY BY GRANT: changing one's
-- mind is a second row, and the first one stays as the record of what was
-- decided and why.
--
-- A DISMISSAL CARRIES A REASON CODE, AND ONLY A DISMISSAL DOES: a CHECK, so an
-- import or a script meets the same wall a hurried person meets on the form
-- (T3.3's reason, 0055). `other` needs words: `reason_text` is required for it,
-- and "blank" is 0308's definition, the whitespace JavaScript's `trim()`
-- strips, spelled as code points rather than a locale's `[[:space:]]`. The
-- words stay in this erasable row; `fin.finding_decided` carries the CODE.
--
-- WHO DECIDED is a member of THIS firm's staff, by a composite foreign key to
-- `tenancy.membership (tenant_id, user_id, audience)` with the audience pinned
-- to STAFF. A key to `tenancy.user_account` alone would be satisfied by any
-- login anywhere, because that table is global; this one says the person
-- works here. That the membership is still ACTIVE is the service's check: a
-- person who has left keeps the decisions they made, so the key cannot ask it.

SET ROLE bib_owner;

-- ── fin.rule_parameter ──────────────────────────────────────────────────────
-- GLOBAL: the law is the same for every firm (see above). No tenant_id, no RLS,
-- SELECT only for the app.

CREATE TABLE fin.rule_parameter (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ISO 3166 alpha-2, as the rest of the product names a country.
  jurisdiction  text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  -- Dotted, lower case: `gst.standard_rate`, `cpf.ow_ceiling`.
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  valid_from    date NOT NULL,
  -- The first day NOT in force. NULL while nothing has replaced it.
  valid_to      date,
  value         jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  -- The official citation the value was taken from.
  source        text NOT NULL CHECK (length(btrim(source)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_parameter_range CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- One value per day, per key, per country. Ranges compared as ranges
  -- (0049's shape), so two CLOSED rows cannot overlap either.
  CONSTRAINT rule_parameter_one_value_a_day EXCLUDE USING gist (
    jurisdiction WITH =,
    key          WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

INSERT INTO fin.rule_parameter (jurisdiction, key, valid_from, valid_to, value, source) VALUES
  ('SG', 'gst.standard_rate', '2007-07-01', '2023-01-01', '{"percent": "7"}',
   'IRAS, "Goods and Services Tax (GST) rates" (iras.gov.sg/quick-links/tax-rates/goods-and-services-tax-(gst)-rates): 7% from 1 Jul 2007 to 31 Dec 2022.'),
  ('SG', 'gst.standard_rate', '2023-01-01', '2024-01-01', '{"percent": "8"}',
   'IRAS, "Goods and Services Tax (GST) rates"; the increase announced in Budget 2022: 8% from 1 Jan 2023 to 31 Dec 2023.'),
  ('SG', 'gst.standard_rate', '2024-01-01', NULL, '{"percent": "9"}',
   'IRAS, "Goods and Services Tax (GST) rates"; the increase announced in Budget 2022: 9% from 1 Jan 2024. Every 2025 document in the training pack recomputes at 9%.'),

  ('SG', 'cpf.ow_ceiling', '2024-01-01', '2025-01-01', '{"amount": "6800.00", "per": "month"}',
   'CPF Board, "What is the Ordinary Wage (OW) ceiling?" (cpf.gov.sg/service/article/what-is-the-ordinary-wage-ow-ceiling): S$6,800 from 1 Jan to 31 Dec 2024.'),
  ('SG', 'cpf.ow_ceiling', '2025-01-01', '2026-01-01', '{"amount": "7400.00", "per": "month"}',
   'CPF Board, "What is the Ordinary Wage (OW) ceiling?": S$7,400 from 1 Jan to 31 Dec 2025. Matches every capped 2025 row of the training pack''s payroll_truth.csv.'),
  ('SG', 'cpf.ow_ceiling', '2026-01-01', NULL, '{"amount": "8000.00", "per": "month"}',
   'CPF Board, "What is the Ordinary Wage (OW) ceiling?": S$8,000 from 1 Jan 2026.'),

  ('SG', 'cpf.annual_salary_ceiling', '2016-01-01', NULL, '{"amount": "102000.00", "per": "year"}',
   'CPF Board, "What is the Ordinary Wage (OW) ceiling?" (annual salary ceiling S$102,000 from 2016) and "CPF Contribution Changes from 1 January 2026" (cpf.gov.sg/conrate2023): the Additional Wage ceiling stays S$102,000 less the Ordinary Wages subject to CPF in the year.'),

  ('SG', 'cpf.rates', '2025-01-01', '2026-01-01',
   '{"aboveMonthlyWage": "750", "bands": [
      {"aboveAge": 0,  "employer": "17",   "employee": "20"},
      {"aboveAge": 55, "employer": "15.5", "employee": "17"},
      {"aboveAge": 60, "employer": "12",   "employee": "11.5"},
      {"aboveAge": 65, "employer": "9",    "employee": "7.5"},
      {"aboveAge": 70, "employer": "7.5",  "employee": "5"}]}',
   'CPF Board, "CPF contribution rates from 1 Jan 2025" (cpf.gov.sg, employer obligations, Table 1: citizens and permanent residents from the third year, monthly wages above S$750). Total rounded to the nearest dollar, the employee''s share rounded down. Every 2025 row of the training pack recomputes to the dollar.'),
  ('SG', 'cpf.rates', '2026-01-01', '2027-01-01',
   '{"aboveMonthlyWage": "750", "bands": [
      {"aboveAge": 0,  "employer": "17",   "employee": "20"},
      {"aboveAge": 55, "employer": "16",   "employee": "18"},
      {"aboveAge": 60, "employer": "12.5", "employee": "12.5"},
      {"aboveAge": 65, "employer": "9",    "employee": "7.5"},
      {"aboveAge": 70, "employer": "7.5",  "employee": "5"}]}',
   'CPF Board, "What are the changes to the CPF contribution rates for senior workers from 1 January 2026?" (cpf.gov.sg/service/article): monthly wages above S$750. Ends on 1 Jan 2027, when the announced 2027 rates replace the bands above 55 to 65; those are not seeded.'),

  ('SG', 'cpf.contributing_passes', '2016-01-01', NULL, '{"passTypes": ["citizen", "pr"]}',
   'Central Provident Fund Act 1953 and CPF Board employer guidance: contributions are payable for Singapore citizens and permanent residents; Employment Pass, S Pass and Work Permit holders do not contribute. Seeded from 2016, as far back as the other CPF rows; the rule is older.'),

  ('SG', 'sdl.levy', '2008-10-01', NULL, '{"percent": "0.25", "minimum": "2.00", "maximum": "11.25"}',
   'SkillsFuture Singapore, via GoBusiness "About Skills Development Levy" (gobusiness.gov.sg/skills-development-levy-faqs/sdl-about): 0.25% of each employee''s monthly remuneration, at least S$2 and at most S$11.25 (the first S$4,500), from 1 Oct 2008; payable for every employee, foreigners included.');

GRANT SELECT ON fin.rule_parameter TO bib_app;

-- ── fin.finding ─────────────────────────────────────────────────────────────

-- "Flat" for `facts`: every value a string, a number, a boolean or null. An
-- IMMUTABLE function so a CHECK may call it.
CREATE FUNCTION fin.facts_are_flat(facts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(jsonb_typeof(f.value) IN ('string', 'number', 'boolean', 'null')), true)
    FROM jsonb_each(facts) AS f
$$;

CREATE TABLE fin.finding (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenancy.tenant (id),
  lane             text NOT NULL CHECK (lane IN ('rule', 'pattern')),
  -- `doc.duplicate_invoice`, `payroll.cpf_ow_ceiling`, `pattern.spike`. The
  -- screen's words are keyed on it.
  check_key        text NOT NULL CHECK (check_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  client_party_id  uuid NOT NULL,
  -- The period the finding belongs to: the month (or year) being checked.
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  facts            jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object' AND fin.facts_are_flat(facts)),
  dedupe_key       text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 500),
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finding_id_tenant_key UNIQUE (id, tenant_id),
  -- Scoped to the firm, consciously (see above).
  CONSTRAINT finding_once UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT finding_period_ordered CHECK (period_end >= period_start),
  FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

-- The staff list: newest first, per firm and per client.
CREATE INDEX idx_finding_recent ON fin.finding (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_finding_client ON fin.finding (tenant_id, client_party_id, created_at DESC, id DESC);

ALTER TABLE fin.finding ENABLE ROW LEVEL SECURITY;
CREATE POLICY finding_isolation ON fin.finding
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON fin.finding TO bib_app;

-- ── fin.finding_line ────────────────────────────────────────────────────────

CREATE TABLE fin.finding_line (
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant (id),
  finding_id  uuid NOT NULL,
  -- fin.transaction_line (0386). The key is added when the two branches merge.
  line_id     uuid NOT NULL,
  PRIMARY KEY (tenant_id, finding_id, line_id),
  FOREIGN KEY (finding_id, tenant_id) REFERENCES fin.finding (id, tenant_id)
);

-- "What has been said about this line": the lookup a line's own screen makes.
CREATE INDEX idx_finding_line_line ON fin.finding_line (tenant_id, line_id);

ALTER TABLE fin.finding_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY finding_line_isolation ON fin.finding_line
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON fin.finding_line TO bib_app;

-- ── fin.finding_decision ────────────────────────────────────────────────────

CREATE TABLE fin.finding_decision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  finding_id           uuid NOT NULL,
  decision             text NOT NULL CHECK (decision IN ('ask_client', 'correct', 'dismiss')),
  reason_code          text CHECK (reason_code IN ('price_change', 'one_off', 'seasonal', 'expected', 'other')),
  -- The person's own words about a client. In this erasable row and nowhere
  -- else: the ledger event carries the code.
  reason_text          text,
  decided_by_user_id   uuid NOT NULL,
  -- Pinned, so the key below can only name a STAFF membership.
  decided_by_audience  text NOT NULL DEFAULT 'STAFF' CHECK (decided_by_audience = 'STAFF'),
  decided_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finding_decision_id_tenant_key UNIQUE (id, tenant_id),
  FOREIGN KEY (finding_id, tenant_id) REFERENCES fin.finding (id, tenant_id),
  -- A person who works at THIS firm (see above).
  CONSTRAINT finding_decision_by_staff FOREIGN KEY (tenant_id, decided_by_user_id, decided_by_audience)
    REFERENCES tenancy.membership (tenant_id, user_id, audience),

  -- F4.2's check: a dismissal names a reason code, and nothing else does.
  CONSTRAINT finding_decision_dismissal_has_reason CHECK ((decision = 'dismiss') = (reason_code IS NOT NULL)),
  -- `other` says why in words; the words, when given, are words (0308's
  -- blank) and fit on a screen; and only a dismissal carries them. The CASE
  -- because `reason_code` is nullable and a NULL CHECK passes.
  CONSTRAINT finding_decision_other_says_why CHECK (
    CASE
      WHEN reason_code IS NULL THEN reason_text IS NULL
      WHEN reason_code = 'other' THEN reason_text IS NOT NULL
        AND reason_text ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
        AND length(reason_text) <= 2000
      ELSE reason_text IS NULL
        OR (reason_text ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
            AND length(reason_text) <= 2000)
    END
  )
);

-- A finding's decisions, newest first: its status is the first of them.
CREATE INDEX idx_finding_decision_finding ON fin.finding_decision (tenant_id, finding_id, decided_at DESC, id DESC);

ALTER TABLE fin.finding_decision ENABLE ROW LEVEL SECURITY;
CREATE POLICY finding_decision_isolation ON fin.finding_decision
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only by grant: a decision is never edited and never removed.
GRANT SELECT, INSERT ON fin.finding_decision TO bib_app;

RESET ROLE;
