-- Down for 0068.
--
-- Both tables go, and with them every request a client has made and every reply
-- the firm has sent — the honest consequence of rolling back a feature rather
-- than something to soften. There is nothing to preserve them into.
--
-- ── NOTHING HERE CAN FAIL HALFWAY, AND THAT IS CHECKED RATHER THAN HOPED ──
--
-- 0067's first down dropped its table and only then tried to narrow a CHECK
-- that a published row refused — so the refusal landed AFTER the drops and left
-- the schema in a state neither migration describes, with the constraint gone
-- entirely. `npm run migrate` wraps a file in a transaction and would have
-- rolled that back; a DOWN is run by hand, against a database somebody is
-- trying to rescue, and that is the case it has to be safe in.
--
-- This one has no constraint to re-narrow. 0068 added no member to any existing
-- vocabulary, widened nothing, and touched no table that existed before it: the
-- two composites it reaches for — `core.party (id, tenant_id)` from 0007 and
-- `files.document (id, party_id, tenant_id)` from 0063 — were added by those
-- migrations and belong to them, so this file leaves both alone. Dropping
-- `document_id_party_tenant_key` here would break 0063's own response table.
--
-- The order is children first: the reply's foreign keys point at the request.

SET ROLE bib_owner;

DROP TABLE IF EXISTS delivery.client_request_reply;
DROP TABLE IF EXISTS delivery.client_request;

RESET ROLE;
