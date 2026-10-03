-- 0323 · `invoice:issue`: issuing an invoice is no longer the whole of
-- administering the firm (audit 2026-10-03, CA#6).
--
-- Issuing and cancelling an invoice and issuing a credit note needed
-- `tenant:admin`, the same right that edits the roster and the roles. A firm
-- had to make its accounts person a full administrator, or route every invoice
-- through a partner. `invoice:issue` is that one act on its own, and the firm
-- moves it on its roles screen like any other permission.
--
-- NOTHING CHANGES FOR ANY FIRM TODAY. The permission goes to EVERY role that
-- carries `tenant:admin` now, the firm's own as well as the defaults, so the
-- people who could issue yesterday can issue tomorrow and nobody else can. This
-- is unlike 0321 and the role migrations before it, which upgraded only a role
-- still byte-for-byte the default and left a firm's own alone: there, leaving
-- one alone gave nothing away. Here it would take issuing away from a firm
-- that renamed its partner role, on the day of a deploy.
--
--   * a PUBLISHED role carrying tenant:admin and not invoice:issue: archived
--     and re-published with it, as every role change is (a published version
--     is frozen);
--   * a DRAFT of such a role is edited in place, so publishing it later does
--     not take issuing away again;
--   * ARCHIVED versions are history and stay as they were.
--
-- Re-runnable: a role already carrying invoice:issue is left alone.

SET ROLE bib_owner;

-- The role set as the code now defines it (DEFAULT_ROLES). Keep the literal on
-- ONE line: tests/config/seed-parity.test.ts reads the NEWEST migration carrying
-- this marker. Nothing below upgrades from it: the rule is "carries
-- tenant:admin", which covers the defaults and every firm's own. It is checked
-- against that rule instead, so the two cannot disagree.
CREATE TEMP TABLE role_seed_0323(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_0323 VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record","billing:skip","invoice:issue"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write","billing:skip"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM role_seed_0323, jsonb_each(role_seed_0323.roles) AS r
     WHERE jsonb_exists(r.value -> 'permissions', 'tenant:admin')
       <> jsonb_exists(r.value -> 'permissions', 'invoice:issue')
  ) THEN
    RAISE EXCEPTION '0323: a default role carries one of tenant:admin and invoice:issue without the other';
  END IF;
END $$;

-- ── Drafts: edited in place ─────────────────────────────────────────────────
UPDATE config.version v
   SET body = jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["invoice:issue"]'::jsonb)
  FROM config.entry e
 WHERE e.id = v.entry_id
   AND e.tenant_id = v.tenant_id
   AND e.kind = 'role'
   AND v.status = 'draft'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND jsonb_exists(v.body -> 'permissions', 'tenant:admin')
   AND NOT jsonb_exists(v.body -> 'permissions', 'invoice:issue');

-- ── Published: archived and published again with it ─────────────────────────
CREATE TEMP TABLE role_issue_upgrade ON COMMIT DROP AS
SELECT v.id AS version_id,
       v.tenant_id,
       v.entry_id,
       jsonb_set(v.body, '{permissions}', (v.body -> 'permissions') || '["invoice:issue"]'::jsonb) AS new_body
  FROM config.version v
  JOIN config.entry e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id AND e.kind = 'role'
 WHERE v.status = 'published'
   AND jsonb_typeof(v.body -> 'permissions') = 'array'
   AND jsonb_exists(v.body -> 'permissions', 'tenant:admin')
   AND NOT jsonb_exists(v.body -> 'permissions', 'invoice:issue');

UPDATE config.version
   SET status = 'archived', archived_at = now()
 WHERE id IN (SELECT version_id FROM role_issue_upgrade);

INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT u.tenant_id,
       u.entry_id,
       (SELECT max(v2.version) + 1 FROM config.version v2 WHERE v2.entry_id = u.entry_id),
       'published',
       u.new_body,
       now()
  FROM role_issue_upgrade u;

RESET ROLE;
