-- 0321 · Billing safeguards (auto-invoice review, 2026-10-02).
--
-- An end-to-end review of 0318-0320 found three things the schema has to
-- carry; the rest of the fixes are in the services.
--
--   1. `crm.billing_due.claimed_at`: a person settling a bill (raising,
--      linking, skipping, refunding its advance) CLAIMS it first, and the bills
--      whose advance a raise will take from. A second person's claim then fails
--      BEFORE an invoice number is drawn. Without it two raises of one bill made
--      two numbered invoices, two raises of one advance both spent its last,
--      and a double click refunded an advance twice. A claim older than two
--      minutes is free again (a crashed request must not lock a bill for good).
--   2. `tenancy.tenant.auto_billing_since`: the firm's day automatic billing
--      was last switched ON. A one-time service's final bill is written only
--      for work finished since then: switching on wrote a final bill for every
--      audit the firm had ever finished, already billed by hand, each overdue.
--   3. The permission `billing:skip`: skipping a bill (it will not be billed)
--      gives up revenue, so it is its own permission on the firm's roles (the
--      user, 2026-10-02: "permission bana do iski and jispe woh hogi woh kr
--      skata with a reason"). By default the Partner and the Manager hold it;
--      a firm moves it on its roles screen.

SET ROLE bib_owner;

-- ── 1. The claim ────────────────────────────────────────────────────────────

ALTER TABLE crm.billing_due ADD COLUMN claimed_at timestamptz;

COMMENT ON COLUMN crm.billing_due.claimed_at IS
  'Somebody is settling this bill right now (0321): set before an invoice number is drawn, cleared after. Older than two minutes counts as free.';

GRANT UPDATE (claimed_at) ON crm.billing_due TO bib_app;

-- ── 2. When the switch went on ──────────────────────────────────────────────

ALTER TABLE tenancy.tenant ADD COLUMN auto_billing_since date;

COMMENT ON COLUMN tenancy.tenant.auto_billing_since IS
  'The firm''s day automatic billing was last switched on (0321). Final bills are written only for work finished on or after it. Null while it has never been on through the app.';

-- A firm already on counts from today: what it finished before was billed by hand.
UPDATE tenancy.tenant
   SET auto_billing_since = (now() AT TIME ZONE time_zone)::date
 WHERE auto_billing;

-- ── 3. The permission ───────────────────────────────────────────────────────
--
-- `partner` and `manager` gain `billing:skip`. LEFT ALONE, as in 0012, 0045,
-- 0056, 0060, 0064, 0069 and 0317: any firm whose published body of that role
-- is not byte-for-byte the current default. They made a decision about it.

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test reads the NEWEST migration carrying this marker.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record","billing:skip"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write","billing:skip"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

-- What 0317 wrote, and what `createTenant` has written since.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);

-- 0060's shape, unchanged through 0317.
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

INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT u.tenant_id,
       u.entry_id,
       (SELECT max(v2.version) + 1 FROM config.version v2 WHERE v2.entry_id = u.entry_id),
       'published',
       u.new_body,
       now()
FROM role_upgrade u;

RESET ROLE;
