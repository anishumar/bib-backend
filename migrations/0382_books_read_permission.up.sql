-- 0382 · `books:read`: see FinCompliance's view of a client's books — the
-- files fin has taken in, and (as later phases land) the lines read from them,
-- the findings and the working papers (docs/FIN_BUILD_PLAN.md F0.7).
--
-- WHO GETS IT ON THE DAY OF THE DEPLOY. Every role, the firm's own as well as
-- the defaults, that carries `work:write` today: the people who do a client's
-- work are the people who read what fin made of that client's files. By
-- default that is the Partner, the Manager and the Associate — FinCompliance
-- MVP Plan v3.2 §17, "10x to confirm". 0364's method, for 0364's reason:
-- re-publishing only a role still byte-for-byte the default would leave a
-- firm's own renamed role without it.
--
--   * a PUBLISHED role carrying work:write and not books:read: archived and
--     re-published with it (a published version is frozen);
--   * a DRAFT of such a role is edited in place, so publishing it later does
--     not take the permission away again;
--   * ARCHIVED versions are history and stay as they were.
--
-- Re-runnable: a role already carrying books:read is left alone.
--
-- A firm with fin switched off (every firm but the pilot's) holds a permission
-- that opens nothing: `/api/v1/fin/*` answers 404 for it.

SET ROLE bib_owner;

-- The role set as the code now defines it (DEFAULT_ROLES). Keep the literal on
-- ONE line: tests/config/seed-parity.test.ts reads the NEWEST migration carrying
-- this marker. Checked against this migration's own rule below, so the two
-- cannot disagree.
CREATE TEMP TABLE role_seed_0382(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_0382 VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record","billing:skip","invoice:issue","advance:manage","books:read"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write","billing:skip","advance:manage","books:read"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write","books:read"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM role_seed_0382, jsonb_each(role_seed_0382.roles) AS r
     WHERE jsonb_exists(r.value -> 'permissions', 'work:write')
       <> jsonb_exists(r.value -> 'permissions', 'books:read')
  ) THEN
    RAISE EXCEPTION '0382: a default role disagrees with the rule (work:write => books:read)';
  END IF;
END $$;

-- ── Drafts: edited in place ─────────────────────────────────────────────────
UPDATE config.version v
   SET body = jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["books:read"]'::jsonb)
  FROM config.entry e
 WHERE e.id = v.entry_id
   AND e.tenant_id = v.tenant_id
   AND e.kind = 'role'
   AND v.status = 'draft'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND jsonb_exists(v.body -> 'permissions', 'work:write')
   AND NOT jsonb_exists(v.body -> 'permissions', 'books:read');

-- ── Published: archived and published again with it ─────────────────────────
CREATE TEMP TABLE role_books_upgrade ON COMMIT DROP AS
SELECT v.id AS version_id,
       v.tenant_id,
       v.entry_id,
       jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["books:read"]'::jsonb) AS new_body
  FROM config.version v
  JOIN config.entry e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id AND e.kind = 'role'
 WHERE v.status = 'published'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND jsonb_exists(v.body -> 'permissions', 'work:write')
   AND NOT jsonb_exists(v.body -> 'permissions', 'books:read');

UPDATE config.version
   SET status = 'archived', archived_at = now()
 WHERE id IN (SELECT version_id FROM role_books_upgrade);

INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT u.tenant_id,
       u.entry_id,
       (SELECT max(v2.version) + 1 FROM config.version v2 WHERE v2.entry_id = u.entry_id),
       'published',
       u.new_body,
       now()
  FROM role_books_upgrade u;

RESET ROLE;
