-- 0081 · The firm's signature IMAGE, pinned to the letter that carries it.
--
-- ── THE MARK WAS STORED AND NOTHING EVER DREW IT ─────────────────────────────
--
-- `files.brand_asset` has accepted `kind = 'signature'` since 0037 and the brand
-- screen has uploaded one since the day it shipped. Nothing read it back:
-- `render-source.ts` fetched `kind = 'logo'` and only that, `RenderableDocument`
-- had a single `logo` field, and `SignatureBlock` carried text and anchors and
-- no image. So the firm's half of every letter rendered as a blank rule over a
-- printed name, and the file the partner uploaded was versioned, hashed, filed
-- and read by nobody. The seventh registered thing this codebase has found with
-- a writer and no reader, after `membership.revoked`, `obligation.filed`, the
-- escalation ladder's comment, `is_client_visible`, `files.document.party_id`
-- and `delivery.client_ask_chase`.
--
-- ── WHY THIS IS A COLUMN AND NOT A LOOKUP AT RENDER TIME ─────────────────────
--
-- This is the whole reason the migration exists, and it is a correctness
-- argument rather than a performance one.
--
-- The obvious implementation resolves the mark the way the logo already does —
-- `WHERE kind = 'signature' AND is_active`, at render time. `POST
-- /api/v1/documents/render` re-renders any letter on demand, including a signed
-- one, and its own description promises that re-rendering unchanged data
-- produces the SAME bytes. So the day a partner succeeds another and the firm
-- replaces the file, re-rendering a letter from 2026 would stamp the NEW
-- partner's signature over the OLD partner's printed name. That is a forged
-- document produced by an ordinary admin action, and the content hash moves with
-- it, so `signed_content_hash` — the one thing that proves the file a client
-- holds is the file the firm issued — stops matching at the same moment.
--
-- 0022 already settled this for the other half of the same fact. Its own words
-- about `firm_signatory_user_id`: "The letter's own three columns are the
-- SNAPSHOT taken when it goes out, for the same reason `issuing_entity_party_id`
-- is a snapshot: changing the firm's signatory next year must not restate who
-- signed a letter in 2026." The image is part of that fact and is snapshotted
-- beside it, written by `markSent` in the same statement as the other three.
--
-- It also makes the brand screen's own promise true. That screen says, under
-- every Replace button, "Replacing keeps the current file on record, so a
-- document issued under it still shows what it carried at the time." Today that
-- sentence is FALSE for the logo, which is resolved live. The logo is left alone
-- here deliberately — pinning it is the same one-line change against
-- `crm.invoice` as well, and it is a separate decision about documents already
-- issued rather than a rider on this one.
--
-- ── NULLABLE, AND NULL IS AN HONEST ANSWER ───────────────────────────────────
--
-- Every letter already sent has no pinned mark and renders exactly as it does
-- today: a rule and a printed name. That is not a gap to backfill. Back-filling
-- would take today's signature image and print it on a document that never
-- carried one, which is the same forgery this column exists to prevent, reached
-- from the other direction. It is also what makes deploying this safe for
-- envelopes already out with DocuSign — their PDFs re-render byte-identical, so
-- the `bib_content_hash` stamped on the live envelope still matches.
--
-- ── THE FREEZE COVERS IT FOR FREE, AND THAT IS 0019 WORKING ──────────────────
--
-- 0019 inverted the signed-letter freeze: the trigger compares the whole row
-- minus the short allow-list `crm.signed_letter_mutable_columns()` publishes, so
-- a column added later is frozen the day it exists. Nothing here touches that
-- function — this is not a fourth exemption, and it does not need to be, because
-- the write happens at SEND and a letter is only frozen once SIGNED.
--
-- ── THE TENANT TRAVELS WITH THE REFERENCE ────────────────────────────────────
--
-- A composite foreign key, like every other reference between tenant-scoped
-- tables here. A foreign-key check runs as a system operation RLS does not
-- filter, so an id-only reference would let one firm's letter print another
-- firm's signature with no policy violation anywhere — which is the worst
-- available shape of this bug, since the thing being borrowed IS somebody's
-- signature.
SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter
  -- The `files.document_version` whose bytes are the firm's mark on THIS letter.
  -- A version and not a `brand_asset` id: the asset row is the SLOT ("the
  -- signature for this entity") and its `is_active` flag moves, while a version
  -- is immutable bytes with a content hash. Pointing at the slot would pin
  -- nothing.
  ADD COLUMN firm_signature_version_id uuid,

  ADD CONSTRAINT el_firm_signature_version_tenant_fkey
    FOREIGN KEY (firm_signature_version_id, tenant_id)
      REFERENCES files.document_version (id, tenant_id);

COMMENT ON COLUMN crm.engagement_letter.firm_signature_version_id IS
  'The firm signature image this letter was issued under, pinned at send. Null on '
  'letters sent before 0081 and on firms that have uploaded no signature — both '
  'render a bare rule, which is what they carried. Never resolved live: replacing '
  'the firm''s signature must not restate a letter already issued.';

RESET ROLE;
