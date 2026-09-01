-- 0069 · `portal:request` — the second permission held by somebody outside the
--        firm, and the first that lets them START something
--
-- ── WHY IT IS NOT `portal:respond` ────────────────────────────────────────
--
-- 0064 built `portal:respond` for T6.6's three verbs — upload the file we asked
-- for, answer the question, approve the thing — and every one of them is a
-- REPLY to something the firm raised. 0068's request is the client speaking
-- first, and Shrestha's call (2026-09-02) is that the two are different
-- authorities rather than one:
--
--     "jo humne maanga wo bhej sakta hai" and "humse naya kaam maang sakta hai"
--
-- are not the same sentence about the same person. A firm with a junior contact
-- at a client — the accounts clerk who sends the registers every month — may
-- well want that person sending documents and NOT opening requests the firm is
-- then expected to act on. Folding this into `portal:respond` would take that
-- choice away, and there would be no way to give it back without splitting the
-- permission later, which is a migration and a role edit at every firm.
--
-- ── AND WHY NOT SIMPLY LEAVE IT UNGATED ──────────────────────────────────
--
-- Reading is not a permission on this surface and must not become one: being
-- invited and being granted a company IS the authorisation to read that
-- company's status (0064 says this, twice). But a request is a WRITE that
-- creates work for the firm, and `client_viewer` — "this contact may only look"
-- — exists precisely so a firm can hand somebody a window and no lever. An
-- ungated request route would put a lever back on that role and the firm would
-- have no way to take it off.
--
-- `client_viewer` therefore still holds nothing, and a firm that wants its
-- read-only contact to be able to ask for things adds this one permission to
-- that role on the admin screen. That is the difference between a default and a
-- decision.
--
-- ── WHAT CHANGES, AND WHO IS LEFT ALONE ──────────────────────────────────
--
-- `client_contact` gains `portal:request` beside `portal:respond`. It stays the
-- default a portal invite assigns, so every contact invited before today gains
-- the ability with it — which is granting something rather than taking one
-- away, the same direction 0064 moved in.
--
-- LEFT ALONE, unchanged from 0012, 0045, 0056, 0060 and 0064: any firm whose
-- published `client_contact` body is not byte-for-byte the current default. They
-- made a decision about that role, and silently adding a permission to it would
-- overrule a choice somebody took deliberately.
--
-- `client_viewer` is not touched at all. 0064 inserted it for every firm and it
-- is not changing here, so this migration has one block where that one had two.

SET ROLE bib_owner;

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test finds the marked line and parses what is between its first quote
-- and the closing '::jsonb — and it reads the NEWEST migration carrying this
-- marker, which from today is this file rather than 0064.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

-- What 0064 wrote, and what `createTenant` has written since. A firm whose role
-- still says exactly this has never touched it. Array order matters to jsonb
-- equality and is the order both writers use.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);

-- Every published role version that is still exactly the old default AND whose
-- default has changed — here, `client_contact` alone. Computed once into a temp
-- table rather than as CTEs of one statement, because the archive and the
-- insert must not be visible to the one-published-version-per-entry index at
-- the same time. 0060's shape, unchanged through 0064.
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
