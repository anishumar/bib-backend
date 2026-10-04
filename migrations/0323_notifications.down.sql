-- 0323 down · notifications. Drops the `notify` schema whole: nothing outside
-- it references a row in it, and the ledger index goes with it.

SET ROLE bib_owner;

DROP INDEX IF EXISTS ledger.idx_event_tenant_recorded;

DROP FUNCTION IF EXISTS notify.prune(timestamptz);

DROP POLICY IF EXISTS user_preference_isolation ON notify.user_preference;
DROP TABLE IF EXISTS notify.user_preference;

DROP POLICY IF EXISTS firm_default_isolation ON notify.firm_default;
DROP TABLE IF EXISTS notify.firm_default;

DROP POLICY IF EXISTS fanout_cursor_isolation ON notify.fanout_cursor;
DROP TABLE IF EXISTS notify.fanout_cursor;

DROP POLICY IF EXISTS notification_recipient ON notify.notification;
DROP POLICY IF EXISTS notification_isolation ON notify.notification;
DROP INDEX IF EXISTS notify.idx_notification_open_source;
DROP INDEX IF EXISTS notify.idx_notification_unread;
DROP INDEX IF EXISTS notify.idx_notification_inbox;
DROP INDEX IF EXISTS notify.idx_notification_dedupe;
DROP TABLE IF EXISTS notify.notification;

RESET ROLE;

DROP SCHEMA IF EXISTS notify;
