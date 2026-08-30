-- Down for 0052. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `delivery.set_updated_at` is 0041's and every table in the schema
-- uses it, so the triggers go and the function stays.
--
-- Undoing this takes the firm's compliance rules with it — which dates it
-- confirmed against the statute, the lead times it set, the exceptions it wrote
-- and the reasons it gave for them. None of that exists anywhere else. The seed
-- can restore the product's five state names and the shipped rule pack; it can
-- never restore a partner's confirmations.
--
-- It will REFUSE while 0053 is applied, because `delivery.obligation_instance`
-- carries foreign keys into all three tables. That is correct and deliberate:
-- down migrations run newest-first, so 0053's down goes first and this one then
-- succeeds. A CASCADE here would silently take every generated obligation at
-- every firm.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_obligation_state_updated_at ON delivery.obligation_state;
DROP POLICY  IF EXISTS obligation_state_isolation ON delivery.obligation_state;
DROP INDEX   IF EXISTS delivery.idx_obligation_state_order;
DROP INDEX   IF EXISTS delivery.idx_obligation_state_one_initial;
DROP TABLE   IF EXISTS delivery.obligation_state;

DROP TRIGGER IF EXISTS trg_obligation_exception_updated_at
  ON delivery.obligation_template_exception;
DROP POLICY  IF EXISTS obligation_exception_isolation
  ON delivery.obligation_template_exception;
DROP INDEX   IF EXISTS delivery.idx_obligation_exception_template;
DROP INDEX   IF EXISTS delivery.idx_obligation_exception_key;
DROP TABLE   IF EXISTS delivery.obligation_template_exception;

DROP TRIGGER IF EXISTS trg_obligation_template_updated_at ON delivery.obligation_template;
DROP POLICY  IF EXISTS obligation_template_isolation ON delivery.obligation_template;
DROP INDEX   IF EXISTS delivery.idx_obligation_template_service;
DROP INDEX   IF EXISTS delivery.idx_obligation_template_lookup;
DROP TABLE   IF EXISTS delivery.obligation_template;

RESET ROLE;
