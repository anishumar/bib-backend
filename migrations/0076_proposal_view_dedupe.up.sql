-- `view_count` on a shared proposal is a number anybody holding the link can
-- turn.
--
-- The share route is public by design — a proposal goes to somebody who has no
-- login and will not get one — and every open increments the count. So the
-- figure a partner reads as "the client looked at this four times" is really
-- "this URL was requested four times", and a page refresh, a link preview in a
-- chat app, or a bored recipient makes it say anything. Only the per-address
-- rate limit stood between the number and nonsense.
--
-- The LEDGER half of this was already right: `proposal.viewed` is recorded once,
-- on the first view, so the audit trail was never spammed. This is about the
-- counter.
--
-- ── WHAT THIS COLUMN BUYS ──────────────────────────────────────────────────
--
-- Somewhere to compare against. With `first_viewed_at` alone there is no way to
-- tell a second open from a second refresh; with the LAST view recorded, the
-- count can advance only when the previous one was long enough ago to be a
-- separate act of reading. Half an hour is the window the service uses, which
-- makes the number mean "sittings", which is what a partner reads it as anyway.
--
-- It is also the more useful of the two dates on its own: "they opened it again
-- yesterday" is a fact a partner acts on, and nothing recorded it.
--
-- Backfilled from `first_viewed_at`, which is the only view instant that exists
-- — for a proposal viewed once they are the same fact, and for one viewed more
-- the earlier date is the conservative answer.
SET ROLE bib_owner;

ALTER TABLE crm.proposal
  ADD COLUMN last_viewed_at timestamptz;

UPDATE crm.proposal SET last_viewed_at = first_viewed_at WHERE first_viewed_at IS NOT NULL;

COMMENT ON COLUMN crm.proposal.last_viewed_at IS
  'When the share link was last opened. Written on every view; `view_count` advances only when the previous view was outside the de-duplication window, so the count means SITTINGS rather than requests — the link is public and a refresh is not a reading.';

RESET ROLE;
