-- 0010 · a third config kind: `policy`
--
-- The registry's first NON-CATALOGUE consumer, and a fair test of whether the
-- spine generalises past "things the firm sells". A policy is a rule the firm
-- sets for itself and changes when it wants to — the first one being the
-- maximum discount somebody may give without a partner approving it (T2.2).
--
-- It belongs here rather than in a column on some table for the reason
-- CLAUDE.md gives: it differs per firm and changes, so it is data. And unlike
-- the reporting currency in 0009 — which is a fact about a firm's books that
-- silently invalidates history if it moves — a discount limit changing next
-- month is exactly what a limit is FOR. Publish is the right affordance.
--
-- Read LIVE, not pinned: a firm that lowers its limit expects the new one to
-- apply this afternoon, the same reasoning that makes roles a live read. A
-- proposal already approved is not re-judged, because the check happens at the
-- moment of approval and its outcome is recorded on the proposal.
--
-- The body validator is in domain/config/model.ts. A kind without one accepts
-- anything, which is why the CHECK below and that file are two halves of one
-- agreement — neither is safe to change alone.

SET ROLE bib_owner;

ALTER TABLE config.entry
  DROP CONSTRAINT entry_kind_check,
  ADD CONSTRAINT entry_kind_check CHECK (kind IN ('service', 'role', 'policy'));

RESET ROLE;
