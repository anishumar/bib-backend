-- 0387 down · FinCompliance findings and the dated values. Nothing outside
-- `fin` references these tables. Dropping them loses every finding and every
-- decision taken on one; the lines they pointed at (0386) are untouched.

SET ROLE bib_owner;

DROP POLICY IF EXISTS finding_decision_isolation ON fin.finding_decision;
DROP TABLE IF EXISTS fin.finding_decision;

DROP POLICY IF EXISTS finding_line_isolation ON fin.finding_line;
DROP TABLE IF EXISTS fin.finding_line;

DROP POLICY IF EXISTS finding_isolation ON fin.finding;
DROP TABLE IF EXISTS fin.finding;

DROP FUNCTION IF EXISTS fin.facts_are_flat(jsonb);

DROP TABLE IF EXISTS fin.rule_parameter;

RESET ROLE;
