-- 0324 down · notifications by email.

SET ROLE bib_owner;

DROP POLICY IF EXISTS email_digest_isolation ON notify.email_digest;
DROP TABLE IF EXISTS notify.email_digest;

DROP POLICY IF EXISTS firm_setting_isolation ON notify.firm_setting;
DROP TABLE IF EXISTS notify.firm_setting;

DROP INDEX IF EXISTS notify.idx_notification_unemailed;
ALTER TABLE notify.notification DROP COLUMN IF EXISTS emailed_at;

RESET ROLE;
