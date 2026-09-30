-- 0317 · A client's acceptance given outside bib, recorded by a partner
--
-- Decided 2026-09-30 (Shrestha): a proposal or an engagement letter is sent,
-- and the client says yes by email or on a call without pressing the button
-- on the link or signing in DocuSign. Until now that left two different holes:
--
--   * a PROPOSAL could be marked accepted by ANY member of staff holding
--     `party:write`, associate included, through `/decision`, and nothing
--     recorded how the client had said yes;
--   * a LETTER out with DocuSign could not be accepted at all: the form that
--     records a signature by hand is hidden while an envelope is out, and the
--     DocuSign verifier refuses a signature with no envelope behind it. The
--     letter sat at `sent`, so no engagement, no job and no task existed for
--     work the client had agreed to.
--
-- ── THE FOUR ANSWERS, not to be re-made ────────────────────────────────────
--
--   1. Only a new permission, `acceptance:record`, may record one, and by
--      default only a partner holds it. Accepting commits the firm (a letter
--      starts the work and the billing), so it is not an associate's act; and
--      it is its own permission rather than `proposal:approve` (a discount
--      sign-off) or `tenant:admin` (the roster), so a firm can hand it to a
--      senior manager without handing over either.
--   2. A LETTER needs the client's own email (or letter) filed as evidence: a
--      letter is the contract, and "the partner says the client agreed" is all
--      the firm would hold in a dispute otherwise. A PROPOSAL needs how, when,
--      who and a note; a file is optional there (the letter comes next).
--   3. Only while the document is `sent`. A proposal past its validity date is
--      expired and is COPIED as a new draft (0316), never accepted late.
--   4. On a letter still out with DocuSign the envelope is VOIDED first, so the
--      client cannot also sign it; one DocuSign reports signed is refused and
--      left for the sweep.
--
-- ── WHY A TABLE, AND WHY ONE FOR BOTH ─────────────────────────────────────
--
-- `crm.proposal_client_decision` (0085) is the CLIENT's own answer on the link
-- — an IP address, a browser, the statement they ticked — and its CHECKs say
-- so. This is a different fact with different evidence: a colleague stating
-- what the client said somewhere else. One table for both documents because
-- the evidence is the same shape and a screen reads it the same way; exactly
-- one parent, by CHECK.
--
-- Append-only by GRANT (SELECT, INSERT): it is the record of who said the
-- client agreed, and editing it afterwards would be rewriting that.

SET ROLE bib_owner;

CREATE TABLE crm.recorded_acceptance (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenancy.tenant (id),
  proposal_id           uuid,
  engagement_letter_id  uuid,
  -- How the client said yes. A closed set so "how many letters did we accept
  -- on a phone call" is a GROUP BY and not a reading exercise.
  channel               text NOT NULL CHECK (channel IN ('email', 'call', 'meeting', 'letter', 'other')),
  -- The day the CLIENT said yes, which is not the day it was recorded.
  accepted_on           date NOT NULL,
  -- Who said yes on the client's side, and in what capacity when known.
  accepted_by_name      text NOT NULL CHECK (length(btrim(accepted_by_name)) > 0 AND length(accepted_by_name) <= 200),
  accepted_by_title     text CHECK (accepted_by_title IS NULL OR (length(btrim(accepted_by_title)) > 0 AND length(accepted_by_title) <= 200)),
  note                  text NOT NULL CHECK (length(btrim(note)) > 0 AND length(note) <= 2000),
  -- The client's email or letter, filed in the document store against the
  -- same proposal or letter. Required on a letter (answer 2).
  evidence_document_id  uuid,
  recorded_by_user_id   uuid NOT NULL REFERENCES tenancy.user_account (id),
  recorded_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recorded_acceptance_one_parent_chk CHECK (
    (proposal_id IS NULL) <> (engagement_letter_id IS NULL)
  ),
  CONSTRAINT recorded_acceptance_letter_evidence_chk CHECK (
    engagement_letter_id IS NULL OR evidence_document_id IS NOT NULL
  ),
  CONSTRAINT recorded_acceptance_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  CONSTRAINT recorded_acceptance_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id),
  CONSTRAINT recorded_acceptance_document_fkey
    FOREIGN KEY (evidence_document_id, tenant_id) REFERENCES files.document (id, tenant_id)
);

-- One per document: an accepted proposal or a signed letter is terminal, so a
-- second record could only be a second opinion about the same yes.
CREATE UNIQUE INDEX recorded_acceptance_one_per_proposal
  ON crm.recorded_acceptance (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX recorded_acceptance_one_per_letter
  ON crm.recorded_acceptance (tenant_id, engagement_letter_id) WHERE engagement_letter_id IS NOT NULL;

ALTER TABLE crm.recorded_acceptance ENABLE ROW LEVEL SECURITY;
CREATE POLICY recorded_acceptance_isolation ON crm.recorded_acceptance
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The crm schema's DEFAULT PRIVILEGES hand bib_app INSERT, SELECT and UPDATE
-- on every new table, so append-only has to be said with a REVOKE: the GRANT
-- alone left UPDATE in place (found by asking has_table_privilege).
REVOKE ALL ON crm.recorded_acceptance FROM bib_app;
GRANT SELECT, INSERT ON crm.recorded_acceptance TO bib_app;

COMMENT ON TABLE crm.recorded_acceptance IS
  'A client''s acceptance of a proposal or engagement letter given OUTSIDE bib (email, call, meeting), recorded by a colleague holding acceptance:record (0317). Append-only; one per document; a letter''s row names the client''s email as evidence.';

-- ── The permission ─────────────────────────────────────────────────────────
--
-- `partner` gains `acceptance:record`. LEFT ALONE, as in 0012, 0045, 0056,
-- 0060, 0064 and 0069: any firm whose published `partner` body is not
-- byte-for-byte the current default. They made a decision about that role.

-- The role set as the code now defines it. Keep the literal on ONE line: the
-- parity test reads the NEWEST migration carrying this marker.
CREATE TEMP TABLE role_seed_new(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_new VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant","acceptance:record"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);  -- @default-roles-seed

-- What 0069 wrote, and what `createTenant` has written since.
CREATE TEMP TABLE role_seed_old(roles jsonb) ON COMMIT DROP;
INSERT INTO role_seed_old VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin","proposal:approve","work:write","obligation:resolve","portal:grant"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read","work:write"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read","work:write"]},"client_contact":{"label":"Client contact","permissions":["portal:respond","portal:request"],"audience":"CLIENT_PORTAL"},"client_viewer":{"label":"Client contact (read only)","permissions":[],"audience":"CLIENT_PORTAL"}}'::jsonb);

-- 0060's shape, unchanged through 0069.
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
