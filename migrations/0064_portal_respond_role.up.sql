-- 0064 · `portal:respond`, and the first role that says which SURFACE it is for
--
-- ── WHAT THIS CLOSES ───────────────────────────────────────────────────────
--
-- `AuthzService.permissionsOf` has returned `[]` for every CLIENT_PORTAL session
-- since gate 2 was built, and CLAUDE.md was careful to call that ARITHMETIC
-- rather than policy:
--
--     gate 2 admits a portal session only to PORTAL_PATHS
--     every path in PORTAL_PATHS requires no permission
--     -> therefore no permission is reachable by a portal session
--
-- The second line stopped being true today. T6.6's action centre gives a client
-- contact three verbs — upload the file we asked for, answer the question,
-- approve the thing — and those are the first portal routes in this product that
-- need a permission. `tests/api/portal-permissions.test.ts` was written to go RED
-- on exactly this day, and it did, which is that test doing its job.
--
-- ── WHY THE FIX IS AN AUDIENCE ON THE ROLE, NOT A SPECIAL CASE ────────────
--
-- Simply dropping the blanket `[]` is worse than leaving it, because nothing in
-- this product refuses a mismatched role in EITHER direction:
--
--   · `manager` on a CLIENT_PORTAL membership is accepted today. Reporting its
--     five permissions would break `permissionsOf`'s one promise — that a screen
--     is told only what will actually work — and every one of those five is
--     refused by gate 2 before gate 3 is consulted.
--   · `portal:respond` on `associate` is equally accepted. That would hand a
--     colleague a permission that only means something OUTSIDE the firm, and the
--     portal handlers refuse a staff session anyway — so it would appear on
--     `/auth/me` and work nowhere.
--
-- So a role declares which audience it was written for, and a role written for
-- the other one grants NOTHING. `audience` on the MEMBERSHIP is which app you
-- are in; `audience` on the ROLE is which app this list of permissions was
-- written for; they have to agree. That is the fix CLAUDE.md has named since the
-- gate was built, and it costs exactly this migration.
--
-- ── THE FIELD IS OPTIONAL, AND THAT IS FORCED RATHER THAN CHOSEN ─────────
--
-- A published config version is FROZEN and `validateBody` rejects unknown keys
-- at the write, so the role rows every existing firm holds cannot grow a field
-- in place — bringing them forward means archiving and publishing a new version,
-- which is what this file does. But a firm that has EDITED a role is left alone
-- (see below), and its body will go on having no `audience` indefinitely. So
-- `readRoleAudience` reads an absent one as STAFF, which is correct for all four
-- roles that existed before today, including `client_contact`: its permission
-- list was empty, so it granted nothing under either reading.
--
-- ── TWO ROLES CHANGE, AND ONE OF THEM DOES NOT EXIST YET ─────────────────
--
--   · `client_contact` gains `portal:respond` and the portal audience. It stays
--     the DEFAULT a portal invite assigns: every contact invited before today
--     holds it, and giving it nothing would take away an ability they were about
--     to be given rather than granting one.
--   · `client_viewer` is NEW — "this contact may only look". It has no entry to
--     upgrade, so it is INSERTED for every firm, which is a different statement
--     from the upgrade above and is why the two are separate blocks. A firm that
--     already defines a role by that key is left entirely alone.
--
-- WHO IS LEFT ALONE, unchanged from 0012, 0045, 0056 and 0060: any firm whose
-- published `client_contact` body is not byte-for-byte the old default. They made
-- a decision about that role, and silently adding a permission to it would
-- overrule a choice somebody took deliberately. Those firms get `client_viewer`
-- anyway — adding a role they do not have overrules nothing.
--
-- READING IS NOT BEHIND THIS PERMISSION AND MUST NOT BECOME SO. Being invited
-- and being granted a company IS the authorisation to read that company's
-- status: `crm.portal_access` is a row somebody wrote, with a granter, a date and
-- a ledger event, and gate 4 enforces it. `client_viewer` with no permissions at
-- all therefore sees the whole portal and cannot act, which is exactly what a
-- read-only contact should be.

SET ROLE bib_owner;

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test finds the marked line and parses what is between its first quote
-- and the closing '::jsonb.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

-- What 0060 wrote, and what createTenant has written since. A firm whose role
-- still says exactly this has never touched it. Array order matters to jsonb
-- equality and is the order both writers use.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);

-- ── one: bring the unchanged roles forward ────────────────────────────────
--
-- Every published role version that is still exactly the old default AND whose
-- default has changed — here, `client_contact` alone. Computed once into a temp
-- table rather than as CTEs of one statement, because the archive and the insert
-- must not be visible to the one-published-version-per-entry index at the same
-- time. 0060's shape, unchanged.
CREATE TEMP TABLE role_upgrade ON COMMIT DROP AS
WITH changed AS (
  SELECT n.key, n.value AS new_body, o.value AS old_body
  FROM role_seed_new, jsonb_each(role_seed_new.roles) AS n
  JOIN role_seed_old ON true
  JOIN LATERAL jsonb_each(role_seed_old.roles) AS o ON o.key = n.key
  WHERE n.value IS DISTINCT FROM o.value
)
SELECT v.id AS version_id, v.tenant_id, v.entry_id, c.new_body
FROM config.version v
JOIN config.entry e ON e.id = v.entry_id AND e.kind = 'role'
JOIN changed c      ON c.key = e.key
WHERE v.status = 'published'
  AND v.body = c.old_body;

UPDATE config.version
   SET status = 'archived', archived_at = now()
 WHERE id IN (SELECT version_id FROM role_upgrade);

-- The next number for the ENTRY, not the archived version's plus one: a firm
-- may be sitting on an unpublished draft, and (entry_id, version) is unique.
INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT u.tenant_id,
       u.entry_id,
       (SELECT max(v2.version) + 1 FROM config.version v2 WHERE v2.entry_id = u.entry_id),
       'published',
       u.new_body,
       now()
FROM role_upgrade u;

-- ── two: the role that does not exist yet ─────────────────────────────────
--
-- `client_viewer` has no entry anywhere, so there is nothing to archive and
-- nothing to compare against a default. Every firm gets it, INCLUDING the ones
-- excluded from the upgrade above: adding a role a firm does not have overrules
-- no decision anybody took, while changing one they edited would.
--
-- `ON CONFLICT DO NOTHING` against `(tenant_id, kind, key)` rather than a NOT
-- EXISTS, because a firm that has already defined a role by this key made that
-- decision and this migration is not entitled to a view about it.
--
-- The INSERT is wrapped in a CTE because `CREATE TABLE ... AS` takes a query and
-- not a data-modifying statement; `WITH ins AS (INSERT ... RETURNING)` is how
-- Postgres lets one be the source of the other.
CREATE TEMP TABLE role_added ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO config.entry (tenant_id, kind, key)
  SELECT t.id, 'role', 'client_viewer'
  FROM tenancy.tenant t
  ON CONFLICT (tenant_id, kind, key) DO NOTHING
  RETURNING id, tenant_id
)
SELECT ins.id AS entry_id, ins.tenant_id FROM ins;

INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT a.tenant_id,
       a.entry_id,
       1,
       'published',
       role_seed_new.roles -> 'client_viewer',
       now()
FROM role_added a, role_seed_new;

RESET ROLE;
