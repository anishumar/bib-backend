-- 0308 · "blank" on a sub-step or review-point mark means the whitespace the service trims (T6.15)
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- 0307 promised two things in words that its CHECKs did not keep: a line's
-- label is text, and a "not applicable" says why. Both were written as
-- `length(btrim(x)) > 0`, and `btrim` with no second argument strips SPACES
-- only. A reason made of a newline and a tab, or of a non-breaking space,
-- passes: `length(btrim(E'\n\t'))` is 2. The service refuses those (JavaScript's
-- `trim()` strips every kind of whitespace), and so does the fake the unit tests
-- run against, so the fake was modelling a database rule that did not exist,
-- and an import or a script could store a "not applicable" whose reason reads
-- as blank. Found by review, measured on the local database.
--
-- ── WHY A NEW NUMBER ───────────────────────────────────────────────────────
--
-- 0307 is applied (locally, with marks in it), so it is fixed forward, the
-- migration rule: an applied file is frozen, and a down and up of 0307 to
-- correct it in place would destroy every mark on the table, which exist
-- nowhere else by design.
--
-- ── THE RULE, ONCE ─────────────────────────────────────────────────────────
--
-- "Has a character that is not whitespace", where whitespace is exactly the set
-- ECMAScript's `trim()` strips: the space and tab family, the line terminators,
-- the no-break space and the byte-order mark, and every Unicode space
-- separator. Spelled out as code points rather than `[[:space:]]`, because what
-- that class matches depends on the database's locale and it does not include
-- the no-break space under the one this runs on; the service's rule does not
-- depend on a locale, and the wall under it must not either. The two ends of
-- the one definition, `String.prototype.trim` and this pattern, are tested
-- against each other in `step-checks.integration.test.ts`.
--
-- The other 65 `btrim(x) <> ''` constraints in this schema are left as they
-- are. They guard text a person types into a form the service trims, the
-- house's settled pattern, and none of them is a promise about a REASON the way
-- this one is; widening them is a sweep with its own argument, not a rider on
-- this fix.

SET ROLE bib_owner;

ALTER TABLE delivery.job_step_check
  DROP CONSTRAINT IF EXISTS job_step_check_label_is_text,
  DROP CONSTRAINT IF EXISTS job_step_check_not_applicable_says_why;

ALTER TABLE delivery.job_step_check
  ADD CONSTRAINT job_step_check_label_is_text CHECK (
    label ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  ),
  -- The CASE for 0307's reason: `outcome` is nullable, and a plain equality
  -- would make the CHECK NULL on an open line, which passes.
  ADD CONSTRAINT job_step_check_not_applicable_says_why CHECK (
    CASE WHEN outcome = 'not_applicable'
         THEN note IS NOT NULL
              AND note ~ '[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
              AND length(note) <= 500
         ELSE note IS NULL
    END
  );

RESET ROLE;
