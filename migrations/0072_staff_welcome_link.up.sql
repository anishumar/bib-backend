-- A third kind of magic link: the one a colleague is SENT rather than asks for.
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
--
-- Adding somebody to a firm sent them nothing. The roster showed them, the
-- membership was real, gate 3 would have admitted them — and no message ever
-- left the building, so a person who was not told out of band never learned
-- they had an account. `POST /api/v1/tenancy/members` said so in its own
-- description: *"No email is sent — they sign in with a magic link."* True, and
-- only if somebody tells them to go and get one.
--
-- ── WHY IT IS NOT ONE OF THE TWO PURPOSES ALREADY HERE ─────────────────────
--
--   `invite` is redeemed ONLY by setting a password (`acceptPortalInvite`), and
--   staff have no password to set — there is no product route that sets one.
--   A staff invite redeemed as an `invite` would demand a step that does not
--   exist for them.
--
--   `login` opens a session, which is right, but it carries a FIFTEEN MINUTE
--   life (MAGIC_LINK_TTL_MINUTES) and that figure is deliberate: a login link
--   is PULLED, by somebody standing at their keyboard who pressed a button ten
--   seconds ago. A welcome letter is PUSHED at a person who may open it on
--   Monday. It needs days, and widening `login` to days would quietly lengthen
--   every sign-in link in the product to buy it.
--
-- So: a third value, with its own TTL (STAFF_WELCOME_TTL_HOURS = 72) and the
-- same everything else — hashed at rest, single use, expiring. It redeems at
-- the sign-in route alongside `login`, because what it grants IS a session.
--
-- The column has been CHECKed since 0004 and `isUsableMagicLink` reads it, so a
-- link of one kind is not usable as another. Widening the CHECK is the whole
-- change; the meaning is in the code that writes and reads it.
SET ROLE bib_owner;

ALTER TABLE tenancy.magic_link
  DROP CONSTRAINT magic_link_purpose_check;

ALTER TABLE tenancy.magic_link
  ADD CONSTRAINT magic_link_purpose_check
  CHECK (purpose IN ('login', 'invite', 'welcome'));

COMMENT ON COLUMN tenancy.magic_link.purpose IS
  'Which door this link opens. `login` is pulled by the account holder and lives minutes; `welcome` is pushed to a new colleague and lives 72 hours, and both redeem into a session. `invite` is the client portal''s, redeems ONLY by setting a password, and never opens a session on its own.';

RESET ROLE;
