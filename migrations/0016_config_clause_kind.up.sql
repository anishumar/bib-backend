-- 0016 · a fourth config kind: `clause`
--
-- The clause library T2.3 assembles an engagement letter from. It is config for
-- the same reason services are: a firm changes its limitation-of-liability
-- wording, and doing that must not be a deploy.
--
-- It is also where PINNING matters most. A service pin answers a commercial
-- question — what our list price was then. A clause pin answers a legal one:
-- exactly what wording the client agreed to. A live read would answer that with
-- today's text, which is the wrong answer in the only conversation where the
-- question ever comes up.
--
-- Bodies are PLAIN TEXT, not templates (agreed 2026-08-28, recorded on the
-- board). A placeholder syntax invented before anyone has asked for one is a
-- vocabulary nobody chose; if it turns out every letter interpolates a client
-- name, the fix is a new clause version, not a migration.
--
-- The body validator is in domain/config/model.ts. A kind without one accepts
-- anything, which is why the CHECK below and that file are two halves of one
-- agreement.

SET ROLE bib_owner;

ALTER TABLE config.entry
  DROP CONSTRAINT entry_kind_check,
  ADD CONSTRAINT entry_kind_check CHECK (kind IN ('service', 'role', 'policy', 'clause'));

RESET ROLE;
