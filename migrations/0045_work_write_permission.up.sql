-- 0045 · `work:write`, carried to the firms that already exist
--
-- Saying a step of a client's work is DONE is its own act, and this migration
-- exists because it needed its own permission (T2.7).
--
-- It is not `party:write` — that is about the client record, not the work — and
-- it is deliberately separate from reading the work board, because the row this
-- permission gates is the record of WHO DID THE WORK. That record is what T2.9's
-- maker-checker rule compares, so it is worth exactly as much as the gate in
-- front of it.
--
-- A new permission is not free, and the cost is the reason this file exists.
-- Since T2.5 every firm holds its roles as config rows and a published version
-- is FROZEN, so adding one to a default role means publishing a NEW VERSION for
-- the firms that have not customised that role. The rule and its cost are in
-- CLAUDE.md; tests/config/seed-parity.test.ts holds the build red until the
-- newest seed and DEFAULT_ROLES agree, which is why the marker below carries the
-- whole role set and not just the part that changed. 0012 is the precedent and
-- this follows it exactly.
--
-- WHO GETS IT: partner, manager AND associate — everyone who delivers. Unlike
-- `proposal:approve`, which is an authority, this is the ordinary act of doing
-- the job. An associate who could not tick off the step they just performed
-- would have to ask somebody else to, which puts a false name on the record —
-- the precise failure the column exists to prevent.
--
-- WHO DOES NOT: `client_contact`, which holds nothing on the staff surface and
-- is refused by the audience gate before a permission is ever consulted.
--
-- WHO IS LEFT ALONE: any firm whose published role body is not byte-for-byte the
-- old default. They made a decision about that role, and silently adding a
-- permission to it would overrule a choice somebody took deliberately.

SET ROLE bib_owner;

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test finds the marked line and parses what is between its first quote
-- and the closing '::jsonb.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);  -- @default-roles-seed

-- What 0012 wrote, and what createTenant has written since. A firm whose role
-- still says exactly this has never touched it. Array order matters to jsonb
-- equality and is the order both writers use.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);

-- Every published role version that is still exactly the old default AND whose
-- default has changed. Computed once into a temp table rather than as CTEs of
-- one statement, because the archive and the insert must not be visible to the
-- one-published-version-per-entry index at the same instant.
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
