-- 0061 · "remove access" means NOW — so a grant may end on the day it started
--
-- ── WHAT WAS DECIDED, AND WHY IT NEEDS DDL ─────────────────────────────────
--
-- 0059/0060 shipped with `end` defaulting to TOMORROW, on the reasoning that
-- `valid_to` is the FIRST DAY NOT IN FORCE, so ending "today" keeps access
-- through the end of the day and nobody who read a document this morning shows
-- as never having been allowed to.
--
-- WALKING IT OVER HTTP IS WHAT SETTLED IT. End the grant, ask for the scope,
-- and the client is still in it until midnight. That reads as a bug to whoever
-- pressed the button, and it IS one when the contact is being removed for
-- cause — a CFO who left this morning, a login the firm believes it has just
-- closed. Shrestha's call (2026-09-01): remove means remove.
--
-- The audit cost is real and is smaller than it looks. The ROW now says the
-- grant was in force `[from, today)`, which understates a person who read
-- something at 09:00 by part of a day — but `portal_access.ended` carries the
-- INSTANT, so "when was it taken away" is still answerable to the second. The
-- row is date-grained; the ledger is not. Losing an hour of row precision to
-- close a hole immediately is the right way round.
--
-- ── AND THIS IS THE CASE THAT COULD NOT BE EXPRESSED AT ALL ────────────────
--
-- Granted by mistake at 10:00, revoked at 10:01. Under `valid_to > valid_from`
-- that write is REFUSED, and the firm's only options were to leave the access
-- standing until tomorrow or to have never made the mistake. An empty range —
-- `[2026-09-01, 2026-09-01)` — is exactly the right record of it: a grant that
-- existed as a decision and was in force on no day.
--
-- `isInForceOn` already answers false for it with no change (`on < valid_to` is
-- false when the two are equal), and `daterange(d, d, '[)')` is EMPTY, which
-- `&&` never matches — so the exclusion constraint keeps working and an empty
-- grant can never block the re-grant that follows it.
--
-- ── WHAT STAYS REFUSED, AND THE ASYMMETRY IS DELIBERATE ────────────────────
--
-- CREATING a grant with `valid_to = valid_from` is still refused, by the
-- SERVICE. Writing a grant that is in force on no day is a typo at the moment
-- of granting — it reads as "granted" on every screen and lets nobody in — and
-- there is no reason to type it. ENDING one on the day it began is a decision
-- somebody took deliberately, twenty seconds later. The database allows the
-- shape; the service allows the act that produces it.

SET ROLE bib_owner;

ALTER TABLE crm.portal_access
  DROP CONSTRAINT portal_access_dates_ordered;

-- Half-open still: valid_to is the FIRST DAY NOT IN FORCE. Equal dates are now
-- allowed and mean an EMPTY range — granted and withdrawn before it was ever in
-- force. A valid_to BEFORE valid_from stays impossible: that is not a short
-- grant, it is a wrong one.
ALTER TABLE crm.portal_access
  ADD CONSTRAINT portal_access_dates_ordered CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  );

RESET ROLE;
