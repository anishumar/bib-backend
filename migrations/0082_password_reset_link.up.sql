-- A fourth kind of magic link: the one somebody asks for because they have
-- forgotten the password they already set.
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
--
-- There was no way — for anybody, staff or client — to reset or change a
-- password from inside the product. The only route that has ever written a
-- credential is `PUT /internal/v1/users/{userId}/password`, behind the platform
-- key, whose own description says *"Self-service password change arrives with
-- the portal."* The portal arrived; this did not.
--
-- What that left is two different holes in the same wall:
--
--   A CLIENT CONTACT sets a password once, on the `invite` link, and that link
--   is spent. Forget it and `resendPortalInvite` refuses them by design
--   (`InvitationAlreadyAccepted`) — re-issuing would be the firm resetting its
--   own client's password, which the invite flow exists to prevent. Their only
--   remaining door is the sign-in link, which is a way IN and not a way to fix
--   the password, so they arrive at the same dead end on the next visit and
--   every visit after it.
--
--   A COLLEAGUE, conversely, has usually never had a password at all —
--   `welcomeStaff` hands over a session and nothing else. So the firm's staff
--   cannot set a first one, and anybody the platform DID seed a password for
--   cannot rotate it without asking the platform.
--
-- ── WHY IT IS NOT ONE OF THE THREE PURPOSES ALREADY HERE ───────────────────
--
--   `login` and `welcome` OPEN A SESSION (SESSION_OPENING_PURPOSES). A reset
--   link must not: whoever holds it has proved only that they can read the
--   mailbox, and the act it authorises is REPLACING the credential. Redeeming
--   one at the sign-in route would hand out a session without the password
--   ever being changed, which is the mirror image of the bug `purpose` was
--   first read to prevent.
--
--   `invite` is the closest — it, too, redeems only by setting a password — and
--   it is still wrong, on both of its ends. It lives seven days, because a
--   CLIENT who lets one expire has to go back to the firm and ask a human; a
--   reset is PULLED by somebody standing at their keyboard who pressed a button
--   a moment ago, so it lives thirty minutes (PASSWORD_RESET_TTL_MINUTES) and
--   widening `invite` to buy that would shorten every invitation in the product.
--   And `resendPortalInvite` refuses to issue an `invite` once a credential
--   exists, which is exactly the population this link is FOR.
--
-- So: a fourth value, with its own TTL and the same everything else — hashed at
-- rest, single use, expiring, and superseding the live ones before it so that a
-- person who presses the button three times is not left holding three password
-- setters. Widening the CHECK is the whole change; the meaning is in the code
-- that writes and reads it.
SET ROLE bib_owner;

ALTER TABLE tenancy.magic_link
  DROP CONSTRAINT magic_link_purpose_check;

ALTER TABLE tenancy.magic_link
  ADD CONSTRAINT magic_link_purpose_check
  CHECK (purpose IN ('login', 'invite', 'welcome', 'reset'));

COMMENT ON COLUMN tenancy.magic_link.purpose IS
  'Which door this link opens. `login` is pulled by the account holder and lives minutes; `welcome` is pushed to a new colleague and lives 72 hours, and both redeem into a session. `invite` is the client portal''s, redeems ONLY by setting a password, and never opens a session on its own. `reset` is the forgotten-password link: pulled like `login`, lives 30 minutes, and redeems ONLY by replacing the password — a session comes out of that, but never out of the link by itself.';

RESET ROLE;
