-- 0345 down · daily exchange rates. Nothing outside the `fx` schema references
-- it: documents keep the rate they were given (0344), so dropping the feed's
-- history loses suggestions and "at today's rate" values, never a term.

SET ROLE bib_owner;

DROP FUNCTION IF EXISTS fx.rate_after(text, text, date);
DROP FUNCTION IF EXISTS fx.rate_on(text, text, date);
DROP TABLE IF EXISTS fx.daily_rate;

RESET ROLE;

DROP SCHEMA IF EXISTS fx;
