-- 0389 · FinCompliance: what every call to the AI reader was, and what it cost
--         (docs/FIN_BUILD_PLAN.md F2.4).
--
-- ── ONE ROW PER CALL, AND EVERY CALL GETS ONE ───────────────────────────────
--
-- The AI reader (usecase/fin/extract.ts) writes a row for every attempt it
-- makes on an intake item: the read, its one retry, and the calls that failed
-- in transit. Each carries the model that ANSWERED (the provider's own report,
-- or the model asked when nothing answered), the prompt version and the tokens
-- the provider reported. T2.8's rule, kept from the first row: "extraction got
-- worse in March" needs something to blame and something to revert, and
-- adding the columns later would mean backfilling a fact nobody recorded.
--
-- It is also the ONLY record of spend. A firm's monthly budget
-- (BIB_FIN_AI_MONTHLY_TOKENS) is summed from these rows in the firm's own month,
-- and the reader's "has the provider refused this file before, while answering
-- others?" is asked of them. So a call that wrote no row is a call the budget
-- never saw: the row is written as soon as the call returns, before anything
-- is decided about its answer.
--
-- ── APPEND-ONLY BY GRANT ─────────────────────────────────────────────────────
--
-- `bib_app` holds SELECT and INSERT and nothing else, the arrangement the
-- ledger and `files.document_version` have: a cost record somebody can edit is
-- not one. The REVOKE comes first because a later migration may give the `fin`
-- schema default privileges (0317's lesson in `crm`), and a table that quietly
-- inherited UPDATE would look append-only and not be.
--
-- ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
--
-- No document content, no error message, no header: codes and counts. The
-- provider's request id is kept, because it is what Anthropic's support asks
-- for, and it names a request, not a person.
--
-- Tenant-scoped like every fin table: `tenant_id`, RLS and a policy, and the
-- intake item it is about is referenced WITH its tenant, so a row of one firm
-- can never hang off another firm's file.

SET ROLE bib_owner;

CREATE TABLE fin.extraction_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenancy.tenant (id),
  intake_item_id      uuid NOT NULL,
  model               text NOT NULL CHECK (length(btrim(model)) > 0),
  prompt_version      text NOT NULL CHECK (length(btrim(prompt_version)) > 0),
  -- 1 for the read, 2 for its one retry. Not capped at 2 here: how many times
  -- the reader asks is the reader's policy, and this table records what it did.
  attempt             smallint NOT NULL CHECK (attempt >= 1),
  -- As the provider reported them. A call that got no answer used none that
  -- anybody reported, so it records zeros rather than a guess.
  input_tokens        integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens       integer NOT NULL CHECK (output_tokens >= 0),
  cache_write_tokens  integer NOT NULL CHECK (cache_write_tokens >= 0),
  cache_read_tokens   integer NOT NULL CHECK (cache_read_tokens >= 0),
  -- `ok` is a reading the validator accepted; the four after it are answers
  -- that were not a reading; `transport_error` is no answer at all.
  outcome             text NOT NULL CHECK (outcome IN (
                        'ok', 'invalid_output', 'no_tool_call', 'truncated', 'refused',
                        'transport_error')),
  -- Why there was no answer (domain/fin/extraction-usage.ts names each).
  failure             text CHECK (failure IN (
                        'rate_limited', 'overloaded', 'server_error', 'timeout', 'connection',
                        'auth', 'bad_request', 'too_large')),
  -- What the model said the file is, on every `ok` answer: a statement or a
  -- payroll record is classified and not read, and this is where that answer
  -- is kept for the person the file then goes to.
  doc_class           text CHECK (doc_class IN (
                        'purchase_invoice', 'sales_invoice', 'credit_note', 'receipt',
                        'customs_permit', 'pos_summary', 'bank_statement', 'card_statement',
                        'payroll', 'bundle', 'not_books')),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(btrim(provider_request_id)) > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extraction_usage_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT extraction_usage_failure_iff_transport_error
    CHECK ((outcome = 'transport_error') = (failure IS NOT NULL)),
  CONSTRAINT extraction_usage_class_iff_ok
    CHECK ((outcome = 'ok') = (doc_class IS NOT NULL)),
  FOREIGN KEY (intake_item_id, tenant_id) REFERENCES fin.intake_item (id, tenant_id)
);

-- The month's spend: a firm's rows from the start of its month.
CREATE INDEX idx_extraction_usage_month
  ON fin.extraction_usage (tenant_id, created_at);

-- One file's history: its refusals, and what was spent on it.
CREATE INDEX idx_extraction_usage_item
  ON fin.extraction_usage (tenant_id, intake_item_id, created_at);

ALTER TABLE fin.extraction_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY extraction_usage_isolation ON fin.extraction_usage
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON fin.extraction_usage FROM bib_app;
GRANT SELECT, INSERT ON fin.extraction_usage TO bib_app;

COMMENT ON TABLE fin.extraction_usage IS
  'Every call the AI document reader made (0389, F2.4): model, prompt version, tokens, outcome. Append-only by grant; the monthly AI budget is summed from it.';

RESET ROLE;
