-- 0386 · FinCompliance reads files into lines: the read, the standard line and
--         the sheet layouts a firm has seen (docs/FIN_BUILD_PLAN.md F2.5, F2.6,
--         F2.9 CSV half, F2.11 sheet side).
--
-- ── fin.read: ONE row per intake item, whatever became of it ───────────────
--
-- The read sweep (`usecase/fin/read.ts`) offers each intake item to the
-- readers in turn and writes exactly one row: `staged` (its lines wait for a
-- person to commit them, F2.8), `needs_person` (with a `problem` code saying
-- why) or `failed` (a reader threw on the file). `read_once` makes a second
-- run, a crash mid-run or two overlapping runs harmless: the insert conflicts,
-- and the ledger event is written only for rows actually created. A file with
-- no row yet is simply unread; a reader that answers `later` (the AI reader
-- with no key, F2.4) writes nothing, so the item is offered again next run.
--
-- `problem` is NULL exactly when the read is staged. The control figures are
-- checked for EVERY read with lines, whoever read it (`domain/fin/control.ts`):
-- opening plus the lines makes the closing, the printed running balance is
-- continuous, the printed line count and total agree. A read whose figures do
-- NOT agree keeps its lines, so a person can see them, and goes to that person
-- as `needs_person` / `control_mismatch`; `control_ok` is false on exactly
-- those rows. A staged read is one whose control passed, by a CHECK.
--
-- `reader` is NULL only for `no_reader` (a file no registered reader takes,
-- the pack's `company_profile.json` among them). `model` and `prompt_version`
-- are the AI reader's provenance, both or neither ("extraction got worse in
-- March" needs something to blame).
--
-- The read's version IS its intake item's version, by a composite key rather
-- than by the sweep's care: `intake_item_version_key` below.
--
-- ── fin.transaction_line: the standard line (F2.5) ─────────────────────────
--
-- One row per `LineDraft` (`domain/fin/lines.ts`), in three shapes picked by
-- `line_kind`: a document (an invoice, a credit note, a receipt, a customs
-- permit, one POS summary), a statement transaction (bank or card), or one
-- employee's month of payroll. Typed columns for every field of all three,
-- NULL where the draft has null; a CHECK per kind says its required fields
-- are there, and another that a line carries no other kind's fields. Money is
-- `numeric`, read from decimal strings, never a float.
--
-- `proposed` is the draft EXACTLY as the reader produced it, and it is frozen
-- by a trigger (ground rule 2: what the machine proposed and what a person
-- applied are both kept for ever). The typed columns start equal to it; F2.8
-- lets a person correct them, with its own UPDATE grant and migration.
--
-- Payroll lines carry employees' names and statement narrations name people
-- ("SALARY JAN TEO BOON KEAT"). That is fine in this table, which can be
-- erased, and is why nothing here reaches the ledger. So the freeze has ONE
-- exception, and it is the one erasure needs: a name or a narration inside
-- `proposed` may be set to JSON null, and nothing else in it may change. An
-- NRIC/FIN is never stored whole (the readers keep its last four characters).
--
-- ── fin.source_format: a sheet layout this firm has seen (F2.6) ─────────────
--
-- The column map the sheet reader worked out for a header row, kept so that
-- "the second file of a known layout needs no mapping". The key is the
-- FINGERPRINT: sha256 of the container (csv or xlsx) and the normalised header
-- cells, computed by the reader (`domain/fin/sheet.ts`, `layoutKey`). The doc
-- kind is NOT part of it, because it is what a known layout decides: a key
-- cannot include the answer it is looked up to find.
--
-- Two kinds of row, and both are kept:
--   · LEARNT (confirmed_* NULL): the reader mapped an unknown layout without
--     ambiguity AND the file's own figures agreed. At most one per fingerprint
--     per firm (`source_format_learnt_once`), so two runs learn it once.
--   · CONFIRMED by a person (confirmed_* set): the learnt map confirmed, or a
--     map a person set or corrected. Any number; the NEWEST is the one read
--     with. A correction is a new row, never an edit, so the machine's map and
--     every person's stay readable and no UPDATE grant is needed.
-- A layout learnt at one firm is that firm's: the table is tenant-scoped like
-- everything in `fin`, and no firm reads with another's map.
--
-- `learnt_from_intake_item_id` names the file a layout was learnt from. An
-- intake item rather than a read, because the layout is stored BEFORE the read
-- row (the read points at the layout it was read with); an intake item has
-- exactly one read, so it names that read as well.
--
-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- SELECT and INSERT only, on all three. Staging (F2.8) brings the UPDATEs it
-- needs with its own migration. No DELETE, as on every business table.
--
-- Every unique constraint here is scoped to the firm: `read_once` (one read
-- per intake item), `transaction_line_position_once` (one line per position in
-- a read), `source_format_learnt_once` (one learnt layout per fingerprint).

SET ROLE bib_owner;

-- The key the read's composite foreign key needs: an intake item together with
-- the version it took in.
ALTER TABLE fin.intake_item
  ADD CONSTRAINT intake_item_version_key UNIQUE (id, document_version_id, tenant_id);

CREATE TABLE fin.source_format (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenancy.tenant (id),
  fingerprint                 text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  container                   text NOT NULL CHECK (container IN ('csv', 'xlsx')),
  -- The header row's cells as printed, so a person confirming the map sees
  -- the sheet's own words beside each field.
  header                      text[] NOT NULL CHECK (cardinality(header) > 0),
  -- 1-based, as the sheet numbers its rows, in the file it was learnt from.
  -- A later file is matched on the header itself, wherever it sits.
  header_row                  integer NOT NULL CHECK (header_row >= 1),
  doc_kind                    text NOT NULL
    CONSTRAINT source_format_doc_kind_check
    CHECK (doc_kind IN ('bank_statement', 'card_statement', 'payroll', 'cpf_submission', 'pos_summary')),
  -- Field name → 0-based column.
  column_map                  jsonb NOT NULL CHECK (jsonb_typeof(column_map) = 'object'),
  -- NULL for a layout with no day in it (a CPF submission).
  date_format                 text
    CONSTRAINT source_format_date_format_check
    CHECK (date_format IN ('iso', 'dmy', 'mdy', 'dmy_short', 'mdy_short', 'd_mon_y', 'mon_d_y', 'ddmmyyyy', 'yyyymmdd')),
  amount_style                text NOT NULL
    CONSTRAINT source_format_amount_style_check
    CHECK (amount_style IN ('signed', 'debit_credit', 'cr_dr_suffix', 'dr_cr_column')),
  learnt_from_intake_item_id  uuid,
  -- The learnt row a person confirmed, when this row is that confirmation.
  based_on_format_id          uuid,
  -- By id alone: `tenancy.user_account` is GLOBAL (ADR-02).
  confirmed_by_user_id        uuid REFERENCES tenancy.user_account (id),
  confirmed_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT source_format_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT source_format_confirmed_both CHECK ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL)),
  -- A layout the machine learnt names the file it learnt it from.
  CONSTRAINT source_format_learnt_has_source CHECK (confirmed_at IS NOT NULL OR learnt_from_intake_item_id IS NOT NULL),
  -- Only a person's row is based on another.
  CONSTRAINT source_format_based_on_is_confirmation CHECK (based_on_format_id IS NULL OR confirmed_at IS NOT NULL),
  FOREIGN KEY (learnt_from_intake_item_id, tenant_id) REFERENCES fin.intake_item (id, tenant_id),
  FOREIGN KEY (based_on_format_id, tenant_id) REFERENCES fin.source_format (id, tenant_id)
);

CREATE UNIQUE INDEX source_format_learnt_once
  ON fin.source_format (tenant_id, fingerprint) WHERE confirmed_at IS NULL;
CREATE INDEX idx_source_format_lookup
  ON fin.source_format (tenant_id, fingerprint, created_at DESC);

CREATE TABLE fin.read (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  intake_item_id       uuid NOT NULL,
  document_version_id  uuid NOT NULL,
  -- Whose file, copied from the intake item. NULL when it was stored against
  -- no client, as there.
  client_party_id      uuid,
  reader               text
    CONSTRAINT read_reader_check
    CHECK (reader IN ('sheet', 'pdf_text', 'vision')),
  doc_kind             text NOT NULL
    CONSTRAINT read_doc_kind_check
    CHECK (doc_kind IN ('purchase_invoice', 'sales_invoice', 'credit_note', 'receipt', 'customs_permit',
                        'pos_summary', 'bank_statement', 'card_statement', 'payroll', 'cpf_submission',
                        'master', 'unknown')),
  status               text NOT NULL
    CONSTRAINT read_status_check
    CHECK (status IN ('staged', 'needs_person', 'failed')),
  problem              text
    CONSTRAINT read_problem_check
    CHECK (problem IN ('no_reader', 'unrecognised_layout', 'control_mismatch', 'unreadable', 'encrypted',
                       'too_large', 'ai_unavailable', 'ai_invalid_output', 'ai_budget_reached')),
  format_id            uuid,
  -- What the file printed about itself and what the check made of it:
  -- `{ printed, checked, problems }`. NULL when the read produced no draft.
  control              jsonb CHECK (control IS NULL OR jsonb_typeof(control) = 'object'),
  control_ok           boolean,
  confidence           numeric CHECK (confidence >= 0 AND confidence <= 1),
  model                text CHECK (model IS NULL OR length(btrim(model)) > 0),
  prompt_version       text CHECK (prompt_version IS NULL OR length(btrim(prompt_version)) > 0),
  line_count           integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT read_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT read_version_key UNIQUE (id, document_version_id, tenant_id),
  CONSTRAINT read_once UNIQUE (tenant_id, intake_item_id),
  CONSTRAINT read_problem_iff_not_staged CHECK ((status = 'staged') = (problem IS NULL)),
  CONSTRAINT read_reader_unless_no_reader CHECK ((reader IS NULL) = (problem IS NOT DISTINCT FROM 'no_reader')),
  CONSTRAINT read_model_both CHECK ((model IS NULL) = (prompt_version IS NULL)),
  CONSTRAINT read_control_both CHECK ((control IS NULL) = (control_ok IS NULL)),
  -- IS TRUE, not the bare column: a CHECK passes on NULL, and a staged read
  -- whose control was never checked must not.
  CONSTRAINT read_staged_passed_control CHECK (status <> 'staged' OR control_ok IS TRUE),
  CONSTRAINT read_mismatch_is_control CHECK (
    (problem IS NOT DISTINCT FROM 'control_mismatch') = (control_ok IS NOT DISTINCT FROM false)
  ),
  -- Lines come only from a draft, and every draft is checked.
  CONSTRAINT read_lines_were_checked CHECK (line_count = 0 OR control IS NOT NULL),
  FOREIGN KEY (intake_item_id, document_version_id, tenant_id)
    REFERENCES fin.intake_item (id, document_version_id, tenant_id),
  FOREIGN KEY (document_version_id, tenant_id) REFERENCES files.document_version (id, tenant_id),
  FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  FOREIGN KEY (format_id, tenant_id) REFERENCES fin.source_format (id, tenant_id)
);

CREATE INDEX idx_read_recent ON fin.read (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_read_status ON fin.read (tenant_id, status);

CREATE TABLE fin.transaction_line (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  read_id              uuid NOT NULL,
  client_party_id      uuid,
  document_version_id  uuid NOT NULL,
  -- Order within the read, from 1.
  position             integer NOT NULL CHECK (position >= 1),
  line_kind            text NOT NULL
    CONSTRAINT transaction_line_kind_check
    CHECK (line_kind IN ('document', 'statement', 'payroll')),
  -- Provenance: the 1-based page of a PDF, the 1-based row of a sheet.
  page                 integer CHECK (page >= 1),
  row_no               integer CHECK (row_no >= 1),

  -- A document (DocumentLineDraft).
  doc_type             text
    CONSTRAINT transaction_line_doc_type_check
    CHECK (doc_type IN ('purchase_invoice', 'sales_invoice', 'credit_note', 'receipt', 'customs_permit', 'pos_summary')),
  counterparty_name    text,
  counterparty_uen     text,
  counterparty_gst_no  text,
  doc_number           text,
  doc_date             date,
  fx_rate              numeric CHECK (fx_rate > 0),
  net                  numeric,
  gst_rate             numeric CHECK (gst_rate >= 0),
  gst                  numeric,
  total                numeric,
  service_period_from  date,
  service_period_to    date,
  credit_note_ref      text,

  -- A document's currency as printed, or a statement's (required there).
  currency             text CHECK (currency ~ '^[A-Z]{3}$'),

  -- A statement transaction (StatementLineDraft). IN positive, OUT negative.
  statement_type       text
    CONSTRAINT transaction_line_statement_type_check
    CHECK (statement_type IN ('bank', 'card')),
  account_ref          text,
  txn_date             date,
  value_date           date,
  narration            text,
  reference            text,
  amount               numeric,
  balance              numeric,
  original_currency    text CHECK (original_currency ~ '^[A-Z]{3}$'),
  original_amount      numeric,

  -- One employee's month (PayrollLineDraft).
  period               text CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  employee_ref         text CHECK (employee_ref IS NULL OR length(btrim(employee_ref)) > 0),
  employee_name        text,
  pass_type            text
    CONSTRAINT transaction_line_pass_type_check
    CHECK (pass_type IN ('citizen', 'pr', 'employment_pass', 's_pass', 'work_permit')),
  age                  integer CHECK (age BETWEEN 0 AND 130),
  ordinary_wage        numeric,
  additional_wage      numeric,
  gross_pay            numeric,
  cpf_employee         numeric,
  cpf_employer         numeric,
  sdl                  numeric,
  fwl                  numeric,
  net_pay              numeric,

  -- Field names the reader was not sure of; staging shows exactly these.
  uncertain            text[] NOT NULL DEFAULT '{}' CHECK (array_position(uncertain, NULL) IS NULL),
  status               text NOT NULL DEFAULT 'staged'
    CONSTRAINT transaction_line_status_check
    CHECK (status IN ('staged', 'committed', 'rejected')),
  -- The draft exactly as the reader produced it. Frozen (see the trigger).
  proposed             jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object' AND proposed ->> 'kind' = line_kind),
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT transaction_line_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT transaction_line_position_once UNIQUE (tenant_id, read_id, position),

  -- Each kind's required fields are there.
  CONSTRAINT transaction_line_document_complete CHECK (line_kind <> 'document' OR doc_type IS NOT NULL),
  CONSTRAINT transaction_line_statement_complete CHECK (
    line_kind <> 'statement'
    OR (statement_type IS NOT NULL AND txn_date IS NOT NULL AND narration IS NOT NULL
        AND amount IS NOT NULL AND currency IS NOT NULL)
  ),
  CONSTRAINT transaction_line_payroll_complete CHECK (
    line_kind <> 'payroll' OR (period IS NOT NULL AND employee_ref IS NOT NULL)
  ),
  -- And it carries no other kind's.
  CONSTRAINT transaction_line_document_only CHECK (
    line_kind = 'document'
    OR num_nonnulls(doc_type, counterparty_name, counterparty_uen, counterparty_gst_no, doc_number, doc_date,
                    fx_rate, net, gst_rate, gst, total, service_period_from, service_period_to, credit_note_ref) = 0
  ),
  CONSTRAINT transaction_line_statement_only CHECK (
    line_kind = 'statement'
    OR num_nonnulls(statement_type, account_ref, txn_date, value_date, narration, reference, amount, balance,
                    original_currency, original_amount) = 0
  ),
  CONSTRAINT transaction_line_payroll_only CHECK (
    line_kind = 'payroll'
    OR num_nonnulls(period, employee_ref, employee_name, pass_type, age, ordinary_wage, additional_wage,
                    gross_pay, cpf_employee, cpf_employer, sdl, fwl, net_pay) = 0
  ),
  CONSTRAINT transaction_line_payroll_has_no_currency CHECK (line_kind <> 'payroll' OR currency IS NULL),

  -- The line's version is its read's, which is its intake item's.
  FOREIGN KEY (read_id, document_version_id, tenant_id)
    REFERENCES fin.read (id, document_version_id, tenant_id),
  FOREIGN KEY (read_id, tenant_id) REFERENCES fin.read (id, tenant_id),
  FOREIGN KEY (document_version_id, tenant_id) REFERENCES files.document_version (id, tenant_id),
  FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

-- What the machine proposed is kept for ever. Erasing a person's name or a
-- narration (set to JSON null) is the one change allowed, and only to those
-- keys; the line's place and provenance never move either.
CREATE OR REPLACE FUNCTION fin.refuse_proposed_change() RETURNS trigger AS $$
DECLARE
  erasable CONSTANT text[] := ARRAY['employeeName', 'narration', 'counterpartyName'];
  k text;
BEGIN
  IF NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
     OR NEW.read_id             IS DISTINCT FROM OLD.read_id
     OR NEW.position            IS DISTINCT FROM OLD.position
     OR NEW.line_kind           IS DISTINCT FROM OLD.line_kind
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.page                IS DISTINCT FROM OLD.page
     OR NEW.row_no              IS DISTINCT FROM OLD.row_no
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'fin.transaction_line % keeps its read, its place and where it was read from for ever.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.proposed IS DISTINCT FROM OLD.proposed THEN
    IF (NEW.proposed - erasable) IS DISTINCT FROM (OLD.proposed - erasable) THEN
      RAISE EXCEPTION
        'fin.transaction_line % keeps what the reader proposed for ever. Correct the line itself; the proposal stays as it was read.', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    FOREACH k IN ARRAY erasable LOOP
      IF (NEW.proposed -> k) IS DISTINCT FROM (OLD.proposed -> k)
         AND (NEW.proposed -> k) IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION
          'fin.transaction_line %: "%" in what the reader proposed may only be erased (set to null), never rewritten.', OLD.id, k
          USING ERRCODE = 'restrict_violation';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_transaction_line_proposed_frozen
  BEFORE UPDATE ON fin.transaction_line
  FOR EACH ROW EXECUTE FUNCTION fin.refuse_proposed_change();

ALTER TABLE fin.source_format    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.read             ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.transaction_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY source_format_isolation ON fin.source_format
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY read_isolation ON fin.read
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY transaction_line_isolation ON fin.transaction_line
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only by grant for now: a read records what a reader made of a file, a
-- line what it proposed, a layout what was learnt or confirmed. F2.8 adds the
-- staging UPDATEs with its own migration.
GRANT SELECT, INSERT ON fin.source_format    TO bib_app;
GRANT SELECT, INSERT ON fin.read             TO bib_app;
GRANT SELECT, INSERT ON fin.transaction_line TO bib_app;

RESET ROLE;
