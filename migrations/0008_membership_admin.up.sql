-- 0008 · firm administration: a roster with names, and revocation that works
--
-- Two small changes, and the second one is the point.
--
-- 1. user_account gains a display name. Nothing in the system stored a person's
--    NAME — only their email — so any roster would have listed email addresses,
--    and every screen built after it would have inherited that. It lives here
--    rather than on membership because identity is above tenant (ADR-02): the
--    same human at two firms is one person with one name, maintained once.
--
--    Nullable, because the accounts that already exist do not have one and a
--    person is perfectly usable without it — the roster falls back to the email.
--    It is an ordinary erasable row, so it carries no ledger consequence: events
--    keep naming a userId and never a person.
--
-- 2. An index for the roster read. Until now nothing ever asked "who works at
--    this firm" — membership was only ever read BY USER (the org switcher), which
--    is what idx_membership_user serves. The admin screen asks the other question.
--
-- What is NOT here is the interesting part: `is_active` already exists, and 0001
-- already grants UPDATE on this table. Everything needed to revoke access has
-- been in the database since the first migration, and `resolveSession` has been
-- re-reading it on EVERY request since T1.7 precisely so that revocation takes
-- effect immediately. Nothing ever wrote it. This migration adds no capability
-- there — the missing piece was always the API, and that is where 0008's real
-- change lives (usecase/tenancy/service.ts, setMemberActive).

SET ROLE bib_owner;

ALTER TABLE tenancy.user_account
  ADD COLUMN display_name text;

-- "Who works at this firm, and who still has access" — the roster read. Partial
-- on nothing: deactivated members belong in the list, because an admin needs to
-- see who was removed and be able to put them back.
CREATE INDEX idx_membership_tenant_active ON tenancy.membership (tenant_id, is_active);

RESET ROLE;
