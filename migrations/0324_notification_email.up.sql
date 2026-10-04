-- 0324 · Notifications by email (2026-10-04)
--
-- The answers for Ashish and Sid (bib/prompts/notifications/DESIGN.md §J): the
-- bell AND email. Escalations and missed filings go by email at once; every
-- other category goes in ONE email a day, at the firm's hour in the firm's
-- zone, listing what is still unread. Each person may switch their email off
-- per category (`notify.user_preference`, channel 'email', 0323).
--
-- Three things in the schema:
--
--   1. `notification.emailed_at`: when this notification went out by email,
--      instantly or in a daily email. A notification is emailed at most once;
--      the column is CLAIMED before the send and given back if the relay
--      refuses, so a doubled worker sends one letter.
--   2. `notify.firm_setting`: the firm's hour for the daily email. No row is
--      09:00, the answer given; every firm may change it (Your firm).
--   3. `notify.email_digest`: one row per firm, person and day, claimed before
--      anything is read, the weekly advance summary's pattern (0322): a
--      redelivered or doubled run sends one daily email.

SET ROLE bib_owner;

ALTER TABLE notify.notification ADD COLUMN emailed_at timestamptz;

COMMENT ON COLUMN notify.notification.emailed_at IS
  'When this notification went out by email (at once, or in the daily email). Null = not emailed. Claimed before the send and cleared if the relay refuses.';

-- What the minute-by-minute instant send looks for.
CREATE INDEX idx_notification_unemailed
  ON notify.notification (tenant_id, created_at)
  WHERE emailed_at IS NULL AND resolved_at IS NULL;

CREATE TABLE notify.firm_setting (
  tenant_id          uuid PRIMARY KEY REFERENCES tenancy.tenant(id),
  digest_hour        smallint NOT NULL DEFAULT 9 CHECK (digest_hour BETWEEN 0 AND 23),
  updated_by_user_id uuid REFERENCES tenancy.user_account(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notify.firm_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_setting_isolation ON notify.firm_setting
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE notify.email_digest (
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  user_id       uuid NOT NULL REFERENCES tenancy.user_account(id),
  -- The FIRM's day the email was for, not the server's.
  digest_day    date NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  notifications integer NOT NULL DEFAULT 0 CHECK (notifications >= 0),
  PRIMARY KEY (tenant_id, user_id, digest_day)
);

COMMENT ON TABLE notify.email_digest IS
  'One daily notification email per firm, person and day, claimed before anything is read so a doubled worker sends one. sent_at null with notifications > 0 = the relay refused; those notifications stay unemailed for the next day.';

ALTER TABLE notify.email_digest ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_digest_isolation ON notify.email_digest
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT UPDATE (emailed_at) ON notify.notification TO bib_app;
GRANT SELECT, INSERT, UPDATE ON notify.firm_setting TO bib_app;
GRANT SELECT, INSERT, UPDATE ON notify.email_digest TO bib_app;

RESET ROLE;
