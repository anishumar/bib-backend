-- 0385 · An ask may name the day it is wanted by, and the request template it
--         was raised from (docs/FIN_BUILD_PLAN.md F1.3, 2026-10-10).
--
-- ── THIS REVERSES A RECORDED DECISION, AND SAYS SO ─────────────────────────
--
-- 0063 wrote "NO DUE DATE. NOT ONE." into this table's header, and CLAUDE.md's
-- T6.6 section says "NO DUE DATE, ANYWHERE, AND ITS ABSENCE IS THE API's OWN
-- STATEMENT". The reason was sound on the day it was written: the firm had
-- never given its turnaround times (client ask 3.4), so "please send this by
-- Friday" would have been a promise nobody made, quoted back at the firm.
--
-- That reason no longer holds for the asks this migration exists for. A
-- REQUEST TEMPLATE (FinCompliance v3.2 §11, F1) is the firm itself writing down
-- "for each month, ask the client for its sales invoices, purchase invoices,
-- bank statements and expense claims, and want them by the 5th". The due day
-- is then the FIRM's stated date, published in its own configuration, and not
-- one this product invented — which is exactly the line 0063 drew. A monthly
-- close cannot run on "how long has this been outstanding": the books for
-- October are late on 6 November whether or not anybody has counted days.
--
-- So `due_on` is a column, NULLABLE, and null keeps meaning what it always
-- meant: nobody stated a day. Every ask raised before this migration has none,
-- and an ask a person raises by hand still has none unless that person types
-- one. Nothing here invents a date for an ask that was not given one.
--
-- ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────────
--
--   · THE CHASER STILL COUNTS FROM `raised_at`. T4.4's rungs are "D+3 after we
--     asked", and an ask with a due day is chased on exactly the same clock as
--     one without. Re-basing the ladder on `due_on` would make one firm's
--     ladder mean two different things depending on how an ask was raised, and
--     is a decision for a firm to ask for, not a side effect of a column.
--   · Raising an ask still does not block the task (0063).
--   · `answered` is still not `closed` (0063).
--   · The client is still read from the work item inside the INSERT, never
--     supplied by a caller (0063).
--
-- ── THE TEMPLATE IT CAME FROM: three columns, all set or all null ─────────
--
-- `request_template_version_id` PINS the config version the ask was raised
-- from, the way a job pins its `workflow_template` (T2.7): "what did the
-- template say when this was asked" is answered by that row for ever, however
-- often the firm republishes. Composite `(id, tenant_id)` to `config.version`,
-- because a foreign-key check runs as a system operation RLS does not filter,
-- and an id-only reference would let one firm's ask hang off another firm's
-- template (the tenant wall; `tenant-keys.integration.test.ts`).
--
-- `request_template_key` and `request_item_key` are the template's config KEY
-- and the item's key inside it. The template key is the config entry's key
-- copied onto the row, deliberately DENORMALISED, because it is what the
-- idempotency below has to be keyed on: the VERSION changes every time the
-- firm republishes the template, and a sweep keyed on the version would raise
-- October's bank-statement ask a second time the day after a typo was fixed.
-- Nothing in SQL ties the key to the version's own entry (config.version
-- carries no key); the one writer, the sweep, takes both from the same pinned
-- version, which is where that guarantee lives.
--
-- All three or none (a CHECK): an ask half-attached to a template is one the
-- sweep cannot recognise as already raised, and would raise again. A hand-raised
-- ask has none of them.
--
-- ── IDEMPOTENT BY INDEX, THE ENGINE'S RULE ────────────────────────────────
--
-- The requests sweep (F1.4) runs at-least-once, like everything the delivery
-- engine touches (T2.6): pg-boss redelivers, a pass re-reads what it has seen.
-- A second ask for the same item on the same task is a second request on the
-- client's screen for a thing they were already asked for, so it must be
-- unwritable rather than unlikely. The partial UNIQUE index on
-- `(tenant_id, work_item_id, request_template_key, request_item_key)` is that
-- wall; the sweep's INSERT is `ON CONFLICT DO NOTHING` against it, and the
-- ledger event is written only for a row actually created. Scoped to the TASK:
-- a work item is one period of one client's work (T6.13), so "October's bank
-- statements for Cobalt" is one row and November's is another. Partial,
-- because a hand-raised ask names no template and two of them asking for the
-- same thing on one task are two deliberate acts.
--
-- ── `raised_by` MAY NOW BE NULL, BUT ONLY FOR A TEMPLATE'S ASK ────────────
--
-- 0063 made `raised_by` NOT NULL: "an ask is a request from a person to a
-- person". A template's ask is raised by the sweep on the firm's behalf, and
-- the honest value for "which person raised this" is nobody — the ledger
-- records it as the SYSTEM actor for the same reason, the chaser's position.
-- Writing the publisher of the template, or the task's assignee, would put a
-- name on a row for an act that person did not perform that day. So the NOT
-- NULL is relaxed and replaced by the narrower rule: a person raised it, or a
-- template did. A hand-raised ask with no person stays unwritable.
--
-- ── GRANTS ────────────────────────────────────────────────────────────────
--
-- None needed. 0063 granted `bib_app` SELECT, INSERT, UPDATE on the TABLE, not
-- column by column, and a table-level privilege covers columns added later.
-- Still never DELETE: an ask is a fact about what the firm asked for.
SET ROLE bib_owner;

ALTER TABLE delivery.client_ask
  ADD COLUMN due_on date,
  ADD COLUMN request_template_version_id uuid,
  ADD COLUMN request_template_key text,
  ADD COLUMN request_item_key text,
  ALTER COLUMN raised_by DROP NOT NULL,
  ADD CONSTRAINT client_ask_template_version_fkey
    FOREIGN KEY (request_template_version_id, tenant_id)
    REFERENCES config.version (id, tenant_id),
  ADD CONSTRAINT client_ask_template_all_or_none CHECK (
    (request_template_version_id IS NULL) = (request_template_key IS NULL)
    AND (request_template_key IS NULL) = (request_item_key IS NULL)
  ),
  ADD CONSTRAINT client_ask_raised_by_person_or_template CHECK (
    raised_by IS NOT NULL OR request_template_version_id IS NOT NULL
  );

-- UNIQUE SCOPE: one ask per (firm, task, template, item), and only for asks a
-- template raised. See the header.
CREATE UNIQUE INDEX client_ask_template_item_once
  ON delivery.client_ask (tenant_id, work_item_id, request_template_key, request_item_key)
  WHERE request_item_key IS NOT NULL;

COMMENT ON COLUMN delivery.client_ask.due_on IS
  'The day the FIRM wants this by, when it stated one (0385, F1.3): a request template''s due offset, or a day a person typed. NULL = none stated, which every ask before 0385 is. The chaser still counts from raised_at.';
COMMENT ON COLUMN delivery.client_ask.request_template_version_id IS
  'The request_template config version this ask was raised from, pinned (0385). NULL = raised by hand. All three template columns or none.';
COMMENT ON COLUMN delivery.client_ask.request_template_key IS
  'The request template''s config key, copied so the sweep''s idempotency survives a republish (0385).';
COMMENT ON COLUMN delivery.client_ask.request_item_key IS
  'The item''s key inside the request template (0385).';

RESET ROLE;
