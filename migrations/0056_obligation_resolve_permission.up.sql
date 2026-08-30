-- 0056 · `obligation:resolve`, carried to the firms that already exist
--
-- Deciding what happens about a deadline that has already passed is its own
-- act, and this migration exists because it needed its own permission (T3.3).
--
-- ── WHY NOT `tenant:admin`, WHICH IS ALREADY PARTNER-ONLY ─────────────────
--
-- It would have worked on day one and been wrong by month two. `tenant:admin`
-- is "administer the firm" — who works here, what their roles are, every
-- setting. A firm that wants its senior manager to decide filings without also
-- handing them the ability to add users and rewrite roles could not express
-- that: it would have to grant full admin, which is the "handed out more than
-- they meant to" failure `ADMIN_PERMISSION` is already annotated about.
--
-- A separate permission makes the firm's actual question answerable from
-- `/admin/roles` without a deploy. That is the whole point of holding roles as
-- config rows.
--
-- ── WHY NOT `work:write`, WHICH EVERY DELIVERER ALREADY HAS ───────────────
--
-- `work:write` is the ordinary act of doing the job — ticking off the step you
-- just performed. This is not that. Choosing between a provisional filing and
-- accepting a late fee commits the CLIENT'S money and moves liability onto the
-- firm, and it is the one decision in the delivery lane that a client may
-- later dispute. An associate who could make it silently would be making it
-- with the partner's authority and none of their sight.
--
-- WHO GETS IT: partner only, and that is the floor rather than the answer. A
-- firm that decides a manager should hold it says so on a screen.
--
-- WHO DOES NOT: manager and associate, by default, today. `client_contact`
-- holds nothing on the staff surface and is refused by the audience gate before
-- a permission is ever consulted.
--
-- WHO IS LEFT ALONE: any firm whose published role body is not byte-for-byte
-- the old default. They made a decision about that role, and silently adding a
-- permission to it would overrule a choice somebody took deliberately.
--
-- 0012 and 0045 are the precedent and this follows them exactly, including the
-- cost: a published version is FROZEN, so bringing an unchanged role forward
-- means archiving it and publishing a new version rather than an UPDATE.

SET ROLE bib_owner;

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test finds the marked line and parses what is between its first quote
-- and the closing '::jsonb.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);  -- @default-roles-seed

-- What 0045 wrote, and what createTenant has written since. A firm whose role
-- still says exactly this has never touched it. Array order matters to jsonb
-- equality and is the order both writers use.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);

-- Every published role version that is still exactly the old default AND whose
-- default has changed — here, `partner` alone. Computed once into a temp table
-- rather than as CTEs of one statement, because the archive and the insert must
-- not be visible to the one-published-version-per-entry index at the same
-- instant.
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

RESET ROLE;
