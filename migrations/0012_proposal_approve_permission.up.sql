-- 0012 · `proposal:approve`, carried to the firms that already exist
--
-- A discount past the firm's published limit needs somebody to authorise it
-- (T2.2). That authority is NOT `tenant:admin`: the person who manages logins
-- and the person who may sign off forty percent off are different people at any
-- real firm, and conflating them means the only way to let a partner approve a
-- quote is to also let them grant themselves everything. It is not the
-- commercial-visibility axis either — that axis governs SEEING money and
-- redacts it (domain/authz/model.ts); authorising a price is a different verb.
--
-- So it is a new permission, and a new permission is not free. Since T2.5 every
-- firm holds its roles as config rows, and a published version is frozen — so
-- adding one to a default role means publishing a NEW VERSION for the firms
-- that have not customised that role. That is what this migration is. The rule
-- and its cost are stated in CLAUDE.md; tests/config/seed-parity.test.ts holds
-- the build red until the newest seed and DEFAULT_ROLES agree, which is why the
-- marker below carries the whole role set and not just the part that changed.
--
-- WHO GETS IT: `partner` only. A manager runs delivery for a book of clients;
-- signing off a discount the firm's own policy forbids is the commercial
-- decision above that. A firm that wants managers approving can publish its own
-- role this afternoon, with no deploy — which is the entire point of T2.5.
--
-- WHO IS LEFT ALONE: any firm whose published `partner` body is not byte-for-
-- byte the old default. They made a decision about that role; silently adding a
-- permission to it would overrule a choice somebody made deliberately, and this
-- is the one subject where that is least acceptable.

SET ROLE bib_owner;

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test finds the marked line and parses what is between its first quote
-- and the closing "'"'"'::jsonb.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);  -- @default-roles-seed

-- What 0005 wrote, and what createTenant has written ever since. A firm whose
-- role still says exactly this has never touched it. Array order matters to
-- jsonb equality and is the order both writers use.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb);

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
