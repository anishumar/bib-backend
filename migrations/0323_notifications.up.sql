-- 0323 · Notifications: the bell, and who gets told what (2026-10-03)
--
-- Until this, the product told a colleague something had happened in exactly
-- two ways: a row on My day, which is read only when somebody opens it, and the
-- weekly advance summary email. A task assigned at 10:00 to somebody who does
-- not open My day until tomorrow is a task nobody knew about for a day, and
-- Ashish's own words for the advance ("system notification/email" to the
-- CEO/COO) were met by the email half only.
--
-- ── MY DAY IS STATE, A NOTIFICATION IS AN EVENT ────────────────────────────
--
-- My day answers "what is on my desk right now", and a row leaves it when the
-- work does. A notification answers "something happened that you should know
-- about": it arrives once, it is read or not, and it stays in the list as
-- history. Neither replaces the other, and this table does not restate My day.
--
-- ── WHERE THE ROWS COME FROM ───────────────────────────────────────────────
--
-- Two writers, both in the worker, both idempotent on `dedupe_key`:
--
--   1. THE LEDGER AS AN OUTBOX. Every state transition already writes an event,
--      AFTER the change committed (docs/EVENT-CONTRACT.md §4), so an event in
--      the ledger is a thing that really happened. A one-minute queue reads each
--      firm's new events from `fanout_cursor`, maps a verb to a category and its
--      recipients, and inserts. No producer had to change, and a module that
--      forgets to notify is impossible because the ledger is already enforced.
--   2. A REMINDER SWEEP, only where no event exists: an advance turning overdue
--      is a date passing, not an act, so nothing is ever written at that moment.
--
-- ── WHY THE TEXT IS NOT STORED ─────────────────────────────────────────────
--
-- `payload` holds ids, a stage and, where there is one, an amount as a decimal
-- string. The sentence is rendered when it is READ, for that reader:
--   · the FEE AXIS. A colleague who may not see fees must never see an amount,
--     and that is decided by the reader's own flag at read time, the same way
--     the weekly digest decides it per recipient. An amount baked into stored
--     text could not be taken back.
--   · a client renamed tomorrow reads with its new name in yesterday's rows.
--
-- ── WHAT IS DELIBERATELY NOT IN THE LEDGER ─────────────────────────────────
--
-- Reading a notification is a person's screen state, not a business event, and
-- a notification being CREATED is a consequence of an event the ledger already
-- holds. Neither is recorded. A firm changing its DEFAULTS is a firm's decision
-- about who hears what, and that one is (`tenant.notification_defaults_set`).

-- The schema is created by the migration's own connection, which may create
-- one; `bib_owner` may not, and owns it from here (0003 and 0037 do the same).
CREATE SCHEMA IF NOT EXISTS notify AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA notify FROM PUBLIC;

SET ROLE bib_owner;

-- ── notification ────────────────────────────────────────────────────────────

CREATE TABLE notify.notification (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- A login, not a membership: identity is above tenant (ADR-02), and the
  -- tenant is the column beside it. The service only ever addresses an ACTIVE
  -- STAFF member of this firm; a deactivated one keeps what they had.
  recipient_user_id uuid NOT NULL REFERENCES tenancy.user_account(id),

  -- The category's key from the registry in `domain/notify/model.ts`. Code,
  -- not a CHECK list, for the reason the ledger's verbs are code: a category is
  -- a recipient rule and a sentence, and neither lives in SQL.
  category          text NOT NULL CHECK (category ~ '^[a-z][a-z_]*$'),

  -- What it is ABOUT, to link it and to resolve it. Polymorphic like
  -- `ledger.event.object_type`, so it carries no foreign key; it points at
  -- this firm's row because the writer only ever reads this firm's rows.
  source_type       text NOT NULL CHECK (source_type ~ '^[a-z][a-z_]*$'),
  source_id         uuid NOT NULL,

  -- Ids and machine facts only. The sentence is rendered at read time.
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(payload) = 'object'),

  -- The ledger event that caused it, when one did. A reminder has none.
  event_id          uuid,
  -- Who did the thing, when a person did ("Priya assigned you a task"). The
  -- name is joined at read time, never stored.
  actor_user_id     uuid REFERENCES tenancy.user_account(id),

  -- What makes a second write of the same fact a no-op: the event and the
  -- category for an outbox row, the source and the STAGE for a reminder. Per
  -- recipient, through the unique index below.
  dedupe_key        text NOT NULL CHECK (btrim(dedupe_key) <> ''),

  created_at        timestamptz NOT NULL DEFAULT now(),
  read_at           timestamptz,
  -- The work it was about is over (the task finished, the advance was paid).
  -- Kept, shown as resolved, and no longer counted as unread: a red badge for
  -- something already done is noise. The escalation ladder's rule — a notice
  -- ends when the WORK ends — but as a column, because the sources are many
  -- and the unread count has to be one cheap query.
  resolved_at       timestamptz
);

COMMENT ON TABLE notify.notification IS
  'One thing one colleague should know happened. Written by the worker from the ledger (or a reminder sweep), read only by its recipient. The sentence is rendered at read time so the fee axis applies to the reader.';

CREATE UNIQUE INDEX idx_notification_dedupe
  ON notify.notification (tenant_id, recipient_user_id, dedupe_key);

-- The list: one person's, newest first.
CREATE INDEX idx_notification_inbox
  ON notify.notification (tenant_id, recipient_user_id, created_at DESC, id DESC);

-- The bell polls this every minute for every signed-in colleague, so it is a
-- partial index and nothing else.
CREATE INDEX idx_notification_unread
  ON notify.notification (tenant_id, recipient_user_id)
  WHERE read_at IS NULL AND resolved_at IS NULL;

-- Resolving by source: "this task is finished, close what was about it".
CREATE INDEX idx_notification_open_source
  ON notify.notification (tenant_id, source_type, source_id)
  WHERE resolved_at IS NULL;

ALTER TABLE notify.notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_isolation ON notify.notification
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- THE SECOND WALL: one colleague's inbox. Every inbox route runs inside
-- `withRecipient`, which sets `app.notify_recipient` to the SESSION's user, and
-- then this restrictive policy hides every other person's rows even from a
-- query that forgot its WHERE. Unset means the worker, which writes for many
-- recipients and resolves by source; that is the same unset-versus-set split
-- `app.portal` makes (0059), and the service is still the first guard.
CREATE POLICY notification_recipient ON notify.notification AS RESTRICTIVE
  USING (
    NULLIF(current_setting('app.notify_recipient', true), '') IS NULL
    OR recipient_user_id = NULLIF(current_setting('app.notify_recipient', true), '')::uuid
  );

-- ── fanout_cursor ─────────────────────────────────────────────────────────────
--
-- How far through one firm's ledger the outbox has read. The read goes back a
-- window BEHIND this on every run, because two transactions can commit in the
-- other order from their `recorded_at`, and a cursor read alone would step over
-- the one that committed late. What is read twice is refused by the dedupe key.
-- A firm with no row starts from the moment it gets one: switching this on
-- does not replay a firm's whole history into everybody's bell.

CREATE TABLE notify.fanout_cursor (
  tenant_id        uuid PRIMARY KEY REFERENCES tenancy.tenant(id),
  recorded_through timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notify.fanout_cursor ENABLE ROW LEVEL SECURITY;
CREATE POLICY fanout_cursor_isolation ON notify.fanout_cursor
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── firm_default / user_preference ─────────────────────────────────────────
--
-- The product's defaults are CODE (the category registry), and these rows are
-- only what a firm or a person changed. Nothing is seeded: a category added in
-- a later release reaches every firm with its default, instead of reaching
-- only the firms created after it. A row with `enabled` is an override in
-- either direction; there is no DELETE grant, so "back to the default" is the
-- row set to the default's value.

CREATE TABLE notify.firm_default (
  tenant_id          uuid NOT NULL REFERENCES tenancy.tenant(id),
  category           text NOT NULL CHECK (category ~ '^[a-z][a-z_]*$'),
  channel            text NOT NULL CHECK (channel IN ('in_app', 'email', 'push')),
  enabled            boolean NOT NULL,
  updated_by_user_id uuid REFERENCES tenancy.user_account(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category, channel)
);

ALTER TABLE notify.firm_default ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_default_isolation ON notify.firm_default
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE notify.user_preference (
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  user_id    uuid NOT NULL REFERENCES tenancy.user_account(id),
  category   text NOT NULL CHECK (category ~ '^[a-z][a-z_]*$'),
  channel    text NOT NULL CHECK (channel IN ('in_app', 'email', 'push')),
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, category, channel)
);

ALTER TABLE notify.user_preference ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_preference_isolation ON notify.user_preference
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── retention, without a DELETE grant ──────────────────────────────────────
--
-- `bib_app` holds no DELETE grant on any table in this database, and this
-- migration does not hand out the first one. Old notifications are pruned by
-- ONE function that can delete only what retention means: rows of the firm the
-- transaction is scoped to, already read or resolved, and at least 30 days old
-- whatever the caller passes. An unread, unresolved row is never pruned. With
-- no firm in scope it deletes nothing, because NULL matches no tenant.
CREATE FUNCTION notify.prune(p_before timestamptz) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, notify
AS $$
  WITH gone AS (
    DELETE FROM notify.notification
     WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND created_at < LEAST(p_before, now() - interval '30 days')
       AND (read_at IS NOT NULL OR resolved_at IS NOT NULL)
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION notify.prune(timestamptz) FROM PUBLIC;

-- ── the outbox's read of the ledger ─────────────────────────────────────────
--
-- The ledger's indexes are on `occurred_at` (business time, which a callback
-- may report in the past). The outbox reads by `recorded_at` — when the row
-- arrived — so it needs its own. An index is not a mutation; the ledger stays
-- append-only.
CREATE INDEX IF NOT EXISTS idx_event_tenant_recorded
  ON ledger.event (tenant_id, recorded_at);

-- ── grants ──────────────────────────────────────────────────────────────────
--
-- UPDATE on a notification is two columns: whether it was read and whether its
-- work is over. Nothing rewrites who it was for or what it said.
GRANT USAGE ON SCHEMA notify TO bib_app;
GRANT SELECT, INSERT ON notify.notification TO bib_app;
GRANT UPDATE (read_at, resolved_at) ON notify.notification TO bib_app;
GRANT SELECT, INSERT, UPDATE ON notify.fanout_cursor TO bib_app;
GRANT SELECT, INSERT, UPDATE ON notify.firm_default TO bib_app;
GRANT SELECT, INSERT, UPDATE ON notify.user_preference TO bib_app;
GRANT EXECUTE ON FUNCTION notify.prune(timestamptz) TO bib_app;

RESET ROLE;
