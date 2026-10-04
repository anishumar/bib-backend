-- 0364 · `advance:manage`: raise an advance with no engagement letter, and map
-- or re-map it to the work it pays for (Q046, Ashish, 2026-10-04: "Managers
-- and above").
--
-- WHO GETS IT ON THE DAY OF THE DEPLOY. Every role, the firm's own as well as
-- the defaults, that carries `billing:skip` or `tenant:admin` today. Those two
-- are "managers and above" in every firm: `billing:skip` is the Manager's and
-- the Partner's by default (0321), `tenant:admin` is the admins'. A firm that
-- renamed its Manager role keeps the meaning; an Associate gets nothing. 0335's
-- method, for 0335's reason: re-publishing only a role still byte-for-byte the
-- default would leave a firm's own manager role without it.
--
--   * a PUBLISHED role carrying either and not advance:manage: archived and
--     re-published with it, as every role change is (a published version is
--     frozen);
--   * a DRAFT of such a role is edited in place, so publishing it later does
--     not take the permission away again;
--   * ARCHIVED versions are history and stay as they were.
--
-- Re-runnable: a role already carrying advance:manage is left alone.

SET ROLE bib_owner;

-- The role set as the code now defines it (DEFAULT_ROLES). Keep the literal on
-- ONE line: tests/config/seed-parity.test.ts reads the NEWEST migration carrying
-- this marker. Checked against this migration's own rule below, so the two
-- cannot disagree.
CREATE TEMP TABLE role_seed_0364(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_0364 VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record","billing:skip","invoice:issue","advance:manage"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write","billing:skip","advance:manage"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM role_seed_0364, jsonb_each(role_seed_0364.roles) AS r
     WHERE (jsonb_exists(r.value -> 'permissions', 'tenant:admin')
            OR jsonb_exists(r.value -> 'permissions', 'billing:skip'))
       <> jsonb_exists(r.value -> 'permissions', 'advance:manage')
  ) THEN
    RAISE EXCEPTION '0364: a default role disagrees with the rule (billing:skip or tenant:admin => advance:manage)';
  END IF;
END $$;

-- ── Drafts: edited in place ─────────────────────────────────────────────────
UPDATE config.version v
   SET body = jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["advance:manage"]'::jsonb)
  FROM config.entry e
 WHERE e.id = v.entry_id
   AND e.tenant_id = v.tenant_id
   AND e.kind = 'role'
   AND v.status = 'draft'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND (jsonb_exists(v.body -> 'permissions', 'tenant:admin')
        OR jsonb_exists(v.body -> 'permissions', 'billing:skip'))
   AND NOT jsonb_exists(v.body -> 'permissions', 'advance:manage');

-- ── Published: archived and published again with it ─────────────────────────
CREATE TEMP TABLE role_advance_upgrade ON COMMIT DROP AS
SELECT v.id AS version_id,
       v.tenant_id,
       v.entry_id,
       jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["advance:manage"]'::jsonb) AS new_body
  FROM config.version v
  JOIN config.entry e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id AND e.kind = 'role'
 WHERE v.status = 'published'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND (jsonb_exists(v.body -> 'permissions', 'tenant:admin')
        OR jsonb_exists(v.body -> 'permissions', 'billing:skip'))
   AND NOT jsonb_exists(v.body -> 'permissions', 'advance:manage');

UPDATE config.version
   SET status = 'archived', archived_at = now()
 WHERE id IN (SELECT version_id FROM role_advance_upgrade);

INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT u.tenant_id,
       u.entry_id,
       (SELECT max(v2.version) + 1 FROM config.version v2 WHERE v2.entry_id = u.entry_id),
       'published',
       u.new_body,
       now()
  FROM role_advance_upgrade u;

RESET ROLE;
