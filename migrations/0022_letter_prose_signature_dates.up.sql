-- 0022 · What a letter SAYS, who bound the FIRM to it, and when it STARTS
--        (G1.3 + G1.4 + G1.5)
--
-- Three tasks, one migration, because they are three halves of one document.
-- The letter this product generates today has no opening paragraph, no
-- addressee, no date of its own, nowhere to record that it replaces an earlier
-- agreement, only one of its two signatures, and no way to say that the work
-- starts in October. Each of those is a column; together they are the difference
-- between a data structure and a letter a firm would actually send.
--
-- ── G1.3 · the prose a letter opens and closes with ─────────────────────────
--
--   background            why THIS client is buying THIS. Every real letter
--                         opens with one, in prose, and it is the paragraph the
--                         client reads first.
--   addressed_to_party_id the addressee — a named PERSON, care-of the client
--                         organization. `party_id` is who is BILLED and stays
--                         exactly what it was; this is who the letter is
--                         written TO. The API's `addressedTo` has been a
--                         COMPUTED STRING (the party's display name) since
--                         T2.2, which is why the document could not address an
--                         individual at all: there was no individual to store.
--   issued_on             the document's OWN date — what is printed under the
--                         letterhead. Distinct from `sent_at`, which is when
--                         this system transmitted it. A letter dated 1
--                         September and sent on the 3rd is ordinary.
--   supersedes_id         document lineage, letter → letter. `proposal_id`
--                         already covers proposal → letter. This one matters
--                         more than it looks: `crm.refuse_signed_change()`
--                         refuses to edit a signed letter and tells the caller
--                         to "supersede it with a new letter instead" — and
--                         until now the product gave that instruction nowhere
--                         to be recorded, so the successor and the letter it
--                         replaced were two unrelated documents.
--
-- `declined_reason` (the fifth field of G1.3) goes on crm.proposal, not here:
-- it is the document with a `rejected` status. An engagement letter has no
-- `rejected` — a client who declines simply never signs, and the FIRM withdraws
-- the letter (domain/engagement/model.ts states this and it is unchanged).
--
-- ── G1.4 · the firm's own signature block ───────────────────────────────────
--
-- A real engagement letter carries TWO signatures: the client's acceptance and
-- "Yours sincerely, <name>, Director". Only the client's half was modelled, so
-- the firm's block rendered as a blank line and nothing recorded who committed
-- the firm. That is an AUDIT question — authority to bind — and it is a
-- DIFFERENT FACT from who operated the system, which the ledger already records
-- as the event's actor and must keep recording. Both are kept: the actor stays
-- the person who pressed send, and the payload carries the signatory.
--
-- `firm_signatory_user_id` + `firm_signatory_title` also land on
-- `tenancy.tenant`, as the firm-wide DEFAULT — "unki ek hi signature rahegi".
-- One signatory for the whole firm, whichever entity issues, as a ROW rather
-- than a hardcode, so a successor is an UPDATE and it stays true for a second
-- tenant. The letter's own three columns are the SNAPSHOT taken when it goes
-- out, for the same reason `issuing_entity_party_id` is a snapshot: changing
-- the firm's signatory next year must not restate who signed a letter in 2026.
--
-- `el_firm_signature_is_whole_chk` gives the firm half the all-or-nothing
-- property `el_signature_is_whole_chk` (0017) gave the client's. A name with no
-- capacity, or a capacity with no date, is a signature block nobody can read as
-- evidence — and half a signature is worse than none because it looks complete.
--
-- `signed_by_title` sits beside the existing `signed_by_name`: the capacity the
-- CLIENT signed in. Deliberately NOT added to 0017's whole-signature check —
-- that constraint is applied and immutable, and more importantly the capacity
-- is not always known when a wet signature is attested. It is optional, and a
-- letter signed without one is still verifiable.
--
-- ── G1.5 · effective dates ──────────────────────────────────────────────────
--
-- Signing currently starts everything immediately, so a letter agreeing that
-- the outgoing accountant finishes August cannot be written down — and the firm
-- is issued August's filings for work it has not taken on. `effective_from` on
-- the LETTER and on the LINE fixes that, and it is on both because per-line can
-- express a single shared date and the reverse cannot: an Incorporation line
-- starts the day it is signed while the GST line beside it starts next period.
--
--   null on the LINE   → whatever the letter says
--   null on the LETTER → the signature date
--
-- Both nullable, so the ordinary letter says nothing and behaves exactly as it
-- does today.
--
-- ── The fan-out, and what "activated" now means ─────────────────────────────
--
-- This is the part that is not a column, and it is written here because the
-- next person to read the fan-out will come looking:
--
-- `crm.engagement.effective_from` is NOT NULL and is RESOLVED ONCE, at
-- signature, from line → letter → signature date. Stored rather than derived
-- through two joins every time, because it is a term of a frozen contract: the
-- letter cannot change, so neither can the answer, and the delivery lane should
-- not have to reconstruct it.
--
-- THE STATUS COLUMN IS UNCHANGED, deliberately, and the reasoning is the whole
-- decision. `active` keeps meaning what it has always meant here: the
-- COMMERCIAL gates are open — the client signed, and the advance was recorded
-- when one was required. Whether work has BEGUN is `effective_from <=
-- current_date`, which is a fact about the calendar rather than a state
-- somebody transitions the row into. The product reports that narrowing as the
-- state `pending_start` (domain/engagement/model.ts `engagementState`), so an
-- engagement effective in October reads as `pending_start` today, in every read
-- the product does.
--
-- Why not a STORED `pending_start` status: something would have to move the row
-- to `active` on the day, and nothing in this service runs on a timer (the same
-- constraint that makes `proposal.expired` lazy). A stored state that nothing
-- can leave is worse than the problem it fixes — it would silently strand every
-- future-dated engagement — and CLAUDE.md's rule about registered verbs with no
-- writer is the same rule wearing a different hat.
--
-- Why `contract.activated` is still emitted at signature: it is the trigger the
-- OTHER lane's scheduler (T2.4) consumes, and it now CARRIES `effectiveFrom`.
-- Withholding it until the effective date would need that same missing timer,
-- and would leave a September-signed October engagement invisible to delivery
-- with nothing to make it visible later. Handing the scheduler the engagement
-- AND the date it begins is what actually stops August filings being issued —
-- the acceptance — because the scheduler is the component that owns a clock and
-- already has to plan future periods for any recurring service.

SET ROLE bib_owner;

-- ── the letter's head ───────────────────────────────────────────────────────
--
-- Every column here is NULLABLE, and that is not laziness. 0018's rule, restated
-- by 0020 and 0021: once real signed letters exist, a NOT NULL column can never
-- be added to an issued document again — the freeze refuses the backfill by
-- design, and there is no honest value to write into a document that never said
-- it. These columns are new facts about letters drafted from now on, and a
-- letter written yesterday genuinely has no background paragraph.
ALTER TABLE crm.engagement_letter
  -- G1.3
  ADD COLUMN background            text,
  ADD COLUMN addressed_to_party_id uuid,
  ADD COLUMN issued_on             date,
  ADD COLUMN supersedes_id         uuid,
  -- G1.5
  ADD COLUMN effective_from        date,
  -- G1.4
  ADD COLUMN signed_by_title       text,
  ADD COLUMN firm_signatory_user_id uuid REFERENCES tenancy.user_account(id),
  ADD COLUMN firm_signatory_title   text,
  ADD COLUMN firm_signed_at         timestamptz,

  -- Empty prose is not prose. The same shape as `title`'s check in 0017: a
  -- column that is either absent or says something, never a blank that renders
  -- as a heading with nothing under it.
  ADD CONSTRAINT el_background_not_blank_chk
    CHECK (background IS NULL OR btrim(background) <> ''),
  ADD CONSTRAINT el_signed_by_title_not_blank_chk
    CHECK (signed_by_title IS NULL OR btrim(signed_by_title) <> ''),
  ADD CONSTRAINT el_firm_signatory_title_not_blank_chk
    CHECK (firm_signatory_title IS NULL OR btrim(firm_signatory_title) <> ''),

  -- THE TENANT TRAVELS WITH THE REFERENCE, both times. A foreign-key check runs
  -- as a system operation RLS does not filter, so an id-only reference would
  -- let one firm's letter be addressed to another firm's contact, or claim to
  -- supersede another firm's contract, with no policy violation anywhere.
  ADD CONSTRAINT el_addressed_to_tenant_fkey
    FOREIGN KEY (addressed_to_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  ADD CONSTRAINT el_supersedes_tenant_fkey
    FOREIGN KEY (supersedes_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id),

  -- A document cannot replace itself. Cheap, and it closes the one-node cycle
  -- that the argument below would otherwise have to hand-wave past.
  ADD CONSTRAINT el_supersedes_not_self_chk CHECK (supersedes_id IS DISTINCT FROM id),

  -- THE FIRM'S HALF, all or nothing — 0017's `el_signature_is_whole_chk` for
  -- the other signature. Who bound the firm, in what capacity, on what date:
  -- any one of the three alone is a block that looks signed and proves nothing.
  ADD CONSTRAINT el_firm_signature_is_whole_chk CHECK (
    (firm_signatory_user_id IS NULL
       AND firm_signatory_title IS NULL
       AND firm_signed_at IS NULL)
    OR
    (firm_signatory_user_id IS NOT NULL
       AND firm_signatory_title IS NOT NULL
       AND firm_signed_at IS NOT NULL)
  );

-- ── one live successor per letter ───────────────────────────────────────────
--
-- UNIQUE SCOPE: per firm, per superseded letter, among letters that were not
-- withdrawn. Two live letters both claiming to replace the same agreement is a
-- question with no answer — which one is in force? — and it is the kind of
-- thing nobody notices until a dispute.
--
-- WITHDRAWN is excluded on purpose: drafting a replacement, pulling it, and
-- drafting a better one is an ordinary afternoon. A total unique index would
-- make the first abandoned attempt block the real successor forever.
CREATE UNIQUE INDEX el_one_live_successor_per_letter
  ON crm.engagement_letter (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL AND status <> 'withdrawn';

-- ── only a SIGNED letter is superseded, and that is what forbids a cycle ────
--
-- The rule itself: a DRAFT is edited, a SENT letter that was never signed is
-- WITHDRAWN, and only a letter the client actually agreed to has anything worth
-- replacing. `crm.refuse_signed_change()` says exactly this in the message it
-- raises, so the schema now backs the instruction it gives.
--
-- WHY THERE CAN BE NO CYCLE, which is the question a self-referencing column
-- always has to answer. Three facts, and they compose:
--
--   1. an edge A→B can only be created when B is already `signed`;
--   2. a signed letter is FROZEN (`trg_el_freeze`, 0017/0019) — its own
--      `supersedes_id` can never change afterwards, by any role;
--   3. `el_supersedes_not_self_chk` rules out A→A.
--
-- So every edge points at a row that was already signed, and therefore already
-- frozen, before the edge existed. A cycle needs some edge pointing FORWARD to
-- a row whose edge was written later — which (2) makes impossible, because that
-- row's edge was fixed at the moment it was signed and every edge out of it
-- predates its own freeze. The lineage is a DAG by construction rather than by
-- a recursive check somebody has to remember to run.
--
-- Trigger ORDER: Postgres fires same-event triggers in NAME order, so
-- `trg_el_freeze` runs before `trg_el_supersedes`. That is the order we want —
-- an attempt to rewrite a signed letter's lineage is refused as a freeze
-- violation, which is the more accurate complaint — but nothing here DEPENDS on
-- it: both refuse, and both raise restrict_violation.
CREATE OR REPLACE FUNCTION crm.refuse_bad_supersedes() RETURNS trigger AS $$
DECLARE
  target_status text;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only when the lineage is actually being written. An UPDATE that touches
  -- something else must not re-litigate a link that was legal when it was made.
  IF TG_OP = 'UPDATE' AND NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id THEN
    RETURN NEW;
  END IF;

  SELECT status INTO target_status
    FROM crm.engagement_letter
   WHERE id = NEW.supersedes_id AND tenant_id = NEW.tenant_id;

  IF target_status IS NULL THEN
    -- Reachable as the OWNER role, which RLS does not filter and which the
    -- composite foreign key alone would let through only after this trigger.
    RAISE EXCEPTION
      'engagement letter % cannot supersede %: there is no such letter at this firm.',
      NEW.id, NEW.supersedes_id USING ERRCODE = 'restrict_violation';
  END IF;

  IF target_status <> 'signed' THEN
    RAISE EXCEPTION
      'engagement letter % cannot supersede %: that letter is %, and only a SIGNED letter is superseded. A draft is edited; a letter that went out and was never signed is withdrawn. Superseding is for the agreement the client actually made.',
      NEW.id, NEW.supersedes_id, target_status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_supersedes
  BEFORE INSERT OR UPDATE ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_bad_supersedes();

-- ── the line's own start date ───────────────────────────────────────────────
--
-- Nullable, meaning "whatever the letter says". Nullable is also the only
-- option: 0018 refuses to add a NOT NULL column to this table once issued
-- letters exist, and it is the right answer anyway — a line that says nothing
-- about its start date is the ordinary case, not a gap.
ALTER TABLE crm.engagement_letter_line
  ADD COLUMN effective_from date;

-- ── the engagement's resolved start date ────────────────────────────────────
--
-- NOT NULL, and it is the one new column here that can be: `crm.engagement`
-- carries no freeze (it is a living object — it is paused, renewed, closed) and
-- there IS an honest value for every row that already exists. An engagement
-- created before this migration began at its letter's signature, because that
-- is the only thing the fan-out could have meant. So this is backfilled rather
-- than refused — the opposite call from 0020 and 0021, and for the opposite
-- reason: there, writing a value would have invented a fact; here, NOT writing
-- one would discard a fact we have.
ALTER TABLE crm.engagement
  ADD COLUMN effective_from date;

-- The UTC day of the signature, matching how the application resolves it (see
-- `utcDay` in domain/engagement/model.ts). Two pods in two regions must not
-- disagree about which day a contract started.
UPDATE crm.engagement e
   SET effective_from = (l.signed_at AT TIME ZONE 'UTC')::date
  FROM crm.engagement_letter l
 WHERE l.id = e.engagement_letter_id
   AND l.signed_at IS NOT NULL;

DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned FROM crm.engagement WHERE effective_from IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'migration 0022 cannot resolve a start date for % engagement(s): their letter has no signed_at, which should be impossible — the fan-out only runs at signature and el_signature_is_whole_chk (0017) requires the timestamp. Those rows were created around the application rather than through it. Inspect them (SELECT e.id, e.engagement_letter_id, l.status FROM crm.engagement e JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id WHERE e.effective_from IS NULL) and decide what date they actually started on; do not guess one here.',
      orphaned USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE crm.engagement
  ALTER COLUMN effective_from SET NOT NULL;

-- "Which engagements begin on or before this date" is the question the delivery
-- lane asks every time it plans. Tenant first, because RLS has already narrowed
-- to one by the time it is asked.
CREATE INDEX idx_engagement_effective ON crm.engagement (tenant_id, effective_from);

-- ── the proposal records WHY it was declined ────────────────────────────────
--
-- `status = 'rejected'` records THAT a client said no, never why — and "why"
-- is the only part of a lost quote that is worth anything later. Free text on
-- purpose: a firm's real reasons ("went with their existing CA", "budget
-- pulled") do not fit a picklist somebody would have to guess at now.
--
-- Constrained to the status it belongs to. A reason on an accepted proposal is
-- either a mis-set field or a note somebody put in the wrong place, and both
-- read as fact to whoever finds it.
ALTER TABLE crm.proposal
  ADD COLUMN declined_reason text,
  ADD CONSTRAINT proposal_declined_reason_not_blank_chk
    CHECK (declined_reason IS NULL OR btrim(declined_reason) <> ''),
  ADD CONSTRAINT proposal_declined_reason_when_rejected_chk
    CHECK (declined_reason IS NULL OR status = 'rejected');

-- ── the firm's standing signatory ───────────────────────────────────────────
--
-- GLOBAL: tenancy.tenant is the platform's registry of firms — it IS the set of
-- tenants, so it has no tenant_id and no RLS. See 0001 and 0009.
--
-- WHY A COLUMN HERE and not a `config` kind: the registry is for what a firm
-- changes and re-publishes with a version history, and this has exactly one
-- current answer with no meaningful history of its own — the history that
-- matters is on the LETTERS, each of which snapshots the signatory it went out
-- with. Same argument `reporting_currency` (0009) makes, minus the
-- irreversibility: a successor here is a plain UPDATE, which is the whole point
-- of it being a row rather than a hardcode.
--
-- The user is referenced by id alone, like `advance_recorded_by` (0017): a
-- user_account is GLOBAL, so there is no tenant to carry alongside it. That the
-- signatory actually WORKS at this firm is a membership question, which no
-- foreign key on a global table can express — TenancyService.setFirmSignatory
-- checks it against an active STAFF membership before writing, and refuses by
-- name when it fails.
ALTER TABLE tenancy.tenant
  ADD COLUMN firm_signatory_user_id uuid REFERENCES tenancy.user_account(id),
  ADD COLUMN firm_signatory_title   text,
  ADD CONSTRAINT tenant_firm_signatory_title_not_blank_chk
    CHECK (firm_signatory_title IS NULL OR btrim(firm_signatory_title) <> ''),
  -- Both or neither, the same all-or-nothing property the letter's own block
  -- has: a name with no capacity cannot be printed as "Yours sincerely, X, ___"
  -- and a capacity with no name is nobody.
  ADD CONSTRAINT tenant_firm_signatory_is_whole_chk CHECK (
    (firm_signatory_user_id IS NULL     AND firm_signatory_title IS NULL) OR
    (firm_signatory_user_id IS NOT NULL AND firm_signatory_title IS NOT NULL)
  );

RESET ROLE;

-- No new tables, so no new grants and no new policies: every column added here
-- lives on a table that already has its RLS policy and its grants, and inherits
-- both. The one table outside the wall is tenancy.tenant, which is GLOBAL by
-- design and documented as such in 0001.
