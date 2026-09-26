-- 0309 · A service lists its compliance filings; a filing is written once (T6.16)
--
-- ── WHAT WAS WRONG WITH ONE COLUMN ─────────────────────────────────────────
--
-- 0052 gave a rule `service_entry_id`: AT MOST ONE service, and NULL meant
-- "every service". Both halves cost the firm something real.
--
--   · NULL = every service is how 98 GST filings reached a bookkeeping-only
--     client on 2026-09-18. Every shipped pack row names no service (a pack
--     cannot know a firm's catalogue keys), so the day a partner confirmed one
--     it reached every live engagement at every company in its country,
--     including a client whose one service EXCLUDES the filing, whose portal
--     then called the returns "missed".
--   · ONE service per rule means a filing two services both owe (GSTR-3B for
--     "GST monthly" and for "Full compliance") had to be written twice, as two
--     rules with two lineages, which is two filings for one return the day a
--     client holds both.
--
-- The firm's own model (the user, 2026-09-26): when a firm builds a service in
-- the catalogue it adds that service's compliance filings THERE; a service may
-- carry any number; a filing written once is offered to the next service from
-- a list and never written again.
--
-- ── DECIDED, AND NOT TO BE RE-DECIDED ──────────────────────────────────────
--
--   1. A rule linked to NO service generates NOTHING. "Every service" is gone
--      as a generating reading.
--   2. Removing a rule from a service WITHDRAWS the untouched upcoming filings
--      it produced for that service's clients, unless another linked service
--      of the same client still covers them. Withdrawn is kept and marked,
--      never deleted.
--   3. The catalogue is the one place a rule is linked to a service. The rules
--      screen stays as the library.
--
-- ── THE LINK IS ON THE CHAIN, NEVER ON ONE ROW ─────────────────────────────
--
-- `lineage_id` (0303) names a rule's supersession chain: the first rule's own
-- id, inherited by every successor. A link names the chain, so when the law
-- changes and a rule is superseded its services come with it and nothing is
-- copied. A link naming a successor's row instead would silently fall off the
-- day the law changed, and the calendar would go quiet for every client of
-- that service from the cutover on.
--
-- ── TWO FACTS A FOREIGN KEY PROVES, NOT A TRIGGER ─────────────────────────
--
--   · THE LINEAGE IS A ROOT. 0303 gave the template `UNIQUE (id, lineage_id,
--     tenant_id)`. A root is the one row whose id IS its lineage, so the link
--     carries `lineage_root`, a generated copy of `lineage_id`, and references
--     the triple: the referenced row must have id = lineage_id = the link's
--     lineage. A link naming a successor's own id cannot exist.
--   · THE ENTRY IS A SERVICE. `config.entry` holds roles, clauses, policies and
--     seven other kinds beside services. It gains `UNIQUE (id, tenant_id,
--     kind)`, no stronger than its primary key, and the link carries
--     `service_kind`, a generated constant 'service', in its reference. A link
--     to a role cannot exist.
--
-- Both are 0067's move and 0303's move again: a denormalised column kept
-- honest by the key rather than by care, so an import, a script or a psql
-- session that never heard of the service is held to it too.
--
-- ── HISTORY IS KEPT: UNLINKING IS A COLUMN, NEVER A DELETE ─────────────────
--
-- `bib_app` holds no DELETE on this table (0041's defaults, restated below).
-- Removing a filing from a service sets `unlinked_at`, the uniqueness is a
-- PARTIAL index over live links, and adding it back is a NEW row. "GSTR-3B was
-- on this service from March to June" stays answerable, the shape 0302 gave a
-- withdrawn document link. `bib_app` may UPDATE only the two unlink columns,
-- and a trigger freezes a link once it has been removed.
--
-- ── THE DATA MOVE ──────────────────────────────────────────────────────────
--
-- One live link per DISTINCT (lineage, service) a template names. It is a
-- SYSTEM act, so `linked_by_user_id` is NULL on those rows and `linked_at` is
-- the moment this migration ran, which is the honest answer: nothing recorded
-- when a partner picked the service. A chain whose rows named two different
-- services (a supersession that re-pointed the service) gets both links; the
-- old column could say that only one period at a time.
--
-- A template with NULL `service_entry_id` gets NO link. Under decision 1 it
-- stops generating, and that is the decision: it is exactly the rule that
-- reached every client before. NO `obligation_instance` row is touched: rows
-- already on the calendar stay where they are, because nobody unlinked
-- anything. Locally (2026-09-26) no template named a service, so this moved
-- nothing and four confirmed rules at one firm stopped generating new rows.
--
-- ── THEN THE COLUMN GOES ───────────────────────────────────────────────────
--
-- Two sources of truth for "which service owes this" is how readers drift in
-- this codebase: `obligation-coverage.ts` read NULL one way while
-- `subjectsFor` read it the other, and a recurring client got two tasks for
-- one filing. So `service_entry_id` is dropped with its foreign key and its
-- index, and nothing can read it the old way by accident.
--
-- ── WITHDRAWN FILINGS ──────────────────────────────────────────────────────
--
-- `withdrawn_at` / `withdrawn_by_user_id` / `withdrawn_reason` on the calendar
-- row. A withdrawn row is NOT a terminal state and NOT filed or decided: it is
-- a filing the firm is no longer doing, taken off the calendar and kept. The
-- reason is a closed set so "why" can be grouped; `service_unlinked` is the
-- only one today. The CHECK below also says a withdrawn row is UNTOUCHED (no
-- task, not filed, not decided), so a write that forgot its guard is refused
-- by the database rather than leaving a filed return marked withdrawn.
--
-- ── RELINKING BRINGS THEM BACK: RESTORE IN PLACE, THE KEY UNCHANGED ────────
--
-- `obligation_instance_lineage_key (tenant, lineage, entity, period_start)` is
-- 0303's wall. A withdrawn row still holds its key, so the generator's
-- `ON CONFLICT DO NOTHING` would skip that period forever. The two answers
-- were a partial key that ignores withdrawn rows, or restoring the row. This
-- restores it, for three reasons:
--
--   · ONE ROW PER PERIOD, EVER. A partial key leaves the withdrawn row AND a
--     new one for the same return. Anything already naming the filing (a
--     nudge, an escalation notice, the ledger's `obligation.spawned`) would
--     name the dead copy.
--   · THE WALL STAYS EXACTLY AS 0303 BUILT IT, a table constraint the
--     generator's own insert and a hand-written INSERT both meet, with no
--     inference clause every writer has to remember.
--   · THE GENERATOR IS WHAT RESTORES, NOT ONLY THE LINK. A client taking a
--     second linked service, or an engagement going live again, proposes the
--     same period through the same insert; a restore that only the link
--     route performed would leave those skipped. So the generator's write
--     restores a withdrawn untouched row it proposes, re-dated by
--     `scheduleFor` (the one date function; never arithmetic in SQL),
--     re-pinned to the rule that governs the period and to the engagement
--     that now reaches it.
--
-- ── THE PORTAL NEVER SEES ONE ──────────────────────────────────────────────
--
-- A RESTRICTIVE policy in 0062's guarded shape, `NOT crm.is_portal_session()
-- OR withdrawn_at IS NULL`. NEVER the bare narrowing: `portal_sees()` is true
-- for a staff session, so an unguarded restrictive clause applies to the FIRM
-- too, and it would hide the firm's own withdrawn rows from the firm, which is
-- 0066's hour-long trap (CLAUDE.md, T6.7) and would make the restore unable
-- to find the rows it restores. The portal SQL names no `withdrawn_at` either:
-- the wall is under the query, where the negative control can test it.

SET ROLE bib_owner;

-- ── refuse before anything changes ─────────────────────────────────────────
--
-- A template naming an entry that is not a SERVICE cannot become a link (the
-- key below refuses it). Nothing in the product can write one, since
-- `ServiceDirectory.serviceKey` has always checked the kind, so this is a row
-- somebody wrote by hand. Which service was meant is a person's decision, and
-- dropping the reference silently would turn a scoped rule into an unlinked
-- one. Stop, name them, and let somebody decide.
DO $$
DECLARE
  wrong integer;
BEGIN
  SELECT count(*) INTO wrong
  FROM delivery.obligation_template t
  JOIN config.entry e ON e.id = t.service_entry_id AND e.tenant_id = t.tenant_id
  WHERE e.kind <> 'service';
  IF wrong > 0 THEN
    RAISE EXCEPTION
      '0309: % compliance rule(s) name a catalogue entry that is not a service, so they cannot be linked to one. Find them with: SELECT t.id, t.name, e.kind, e.key FROM delivery.obligation_template t JOIN config.entry e ON e.id = t.service_entry_id WHERE e.kind <> ''service''; point each at the service it was meant for, or clear it, and migrate again',
      wrong;
  END IF;
END $$;

-- ── the service kind, provable by a key ────────────────────────────────────

ALTER TABLE config.entry
  -- No stronger than the primary key. It exists so a reference can say WHICH
  -- KIND of entry it points at and have the database check it.
  ADD CONSTRAINT config_entry_id_tenant_kind_key UNIQUE (id, tenant_id, kind);

-- ── the link ───────────────────────────────────────────────────────────────

CREATE TABLE delivery.obligation_rule_service (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- The CHAIN, by its root rule's id (0303). Every row in the chain, the
  -- current one and every predecessor still governing its own periods, is
  -- linked by this one row.
  lineage_id  uuid NOT NULL,
  -- Generated, never written: the root test. See the header.
  lineage_root uuid NOT NULL GENERATED ALWAYS AS (lineage_id) STORED,

  -- The catalogue ENTRY, not a version, for 0052's reason: a firm publishing
  -- v4 of a service has not stopped owing its clients the filing. A link
  -- hangs off the service's identity, so it is not frozen by publishing, needs
  -- no new version, and holds for a service that has only a draft.
  service_entry_id uuid NOT NULL,
  -- Generated, never written: the kind test. See the header.
  service_kind text NOT NULL GENERATED ALWAYS AS ('service') STORED,

  linked_at   timestamptz NOT NULL DEFAULT now(),
  -- The person who added it, from the catalogue. NULL only for a SYSTEM link:
  -- the rows this migration moved, and nothing else writes one.
  -- `tenancy.user_account` is GLOBAL (ADR-02), so this is the one kind of
  -- id-only reference the tenant wall allows.
  linked_by_user_id uuid REFERENCES tenancy.user_account (id),

  -- Removed from the service. BOTH OR NEITHER: an unlink is always a person
  -- pressing Remove in the catalogue, the only writer there is, so a removal
  -- with nobody behind it is a bug and the database says so.
  unlinked_at timestamptz,
  unlinked_by_user_id uuid REFERENCES tenancy.user_account (id),

  CONSTRAINT obligation_rule_service_unlinked_chk
    CHECK ((unlinked_at IS NULL) = (unlinked_by_user_id IS NULL)),
  CONSTRAINT obligation_rule_service_unlinked_after_linked_chk
    CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at),

  CONSTRAINT obligation_rule_service_tenant_key UNIQUE (id, tenant_id),

  -- The chain's ROOT at this firm. Composite with the tenant, like every
  -- reference here (`tenant-keys.integration.test.ts`).
  CONSTRAINT obligation_rule_service_lineage_root_fkey
    FOREIGN KEY (lineage_id, lineage_root, tenant_id)
    REFERENCES delivery.obligation_template (id, lineage_id, tenant_id),
  -- A SERVICE at this firm.
  CONSTRAINT obligation_rule_service_service_fkey
    FOREIGN KEY (service_entry_id, tenant_id, service_kind)
    REFERENCES config.entry (id, tenant_id, kind)
);

-- ONE LIVE LINK PER (chain, service). Partial, because a removed link must not
-- block adding the filing back, and the removed row is the history. The same
-- shape 0302 gave a document link and 0052 gave an exception.
CREATE UNIQUE INDEX obligation_rule_service_live_key
  ON delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
  WHERE unlinked_at IS NULL;
-- "Which filings does this service carry": the catalogue's read, and the join
-- every generation predicate makes from an engagement's pinned service.
CREATE INDEX idx_obligation_rule_service_service
  ON delivery.obligation_rule_service (tenant_id, service_entry_id)
  WHERE unlinked_at IS NULL;

ALTER TABLE delivery.obligation_rule_service ENABLE ROW LEVEL SECURITY;
CREATE POLICY obligation_rule_service_isolation ON delivery.obligation_rule_service
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No portal policy, deliberately: no portal route reads this table, and gate 2
-- contains it. A portal route whose SUBJECT is this table needs its own line
-- in a migration first (0062's rule).

-- Once removed, frozen; and while live, only the removal may move. The column
-- grant below already stops `bib_app` touching anything else; the trigger
-- holds the owner role and a psql session to it as well.
CREATE FUNCTION delivery.refuse_rule_service_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unlinked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'obligation_rule_service %: this filing was removed from the service at %, and a removal is final; add the filing to the service again instead',
      OLD.id, OLD.unlinked_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
     OR NEW.service_entry_id IS DISTINCT FROM OLD.service_entry_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
     OR NEW.linked_by_user_id IS DISTINCT FROM OLD.linked_by_user_id THEN
    RAISE EXCEPTION
      'obligation_rule_service %: which filing is on which service, and who added it, is fixed when it is written; remove it and add the filing again instead',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER obligation_rule_service_frozen
  BEFORE UPDATE ON delivery.obligation_rule_service
  FOR EACH ROW EXECUTE FUNCTION delivery.refuse_rule_service_change();

-- SELECT and INSERT, and UPDATE of the two removal columns only. Never DELETE.
-- 0041's default privileges would have granted UPDATE on every column, so the
-- table grant is taken back and the column grant stated.
GRANT SELECT, INSERT ON delivery.obligation_rule_service TO bib_app;
REVOKE UPDATE ON delivery.obligation_rule_service FROM bib_app;
GRANT UPDATE (unlinked_at, unlinked_by_user_id) ON delivery.obligation_rule_service TO bib_app;

COMMENT ON TABLE delivery.obligation_rule_service IS
  'Which catalogue services owe which compliance filing (T6.16). One row per link, on the rule''s CHAIN (lineage_id), removed by unlinked_at and never deleted. A rule linked to no service generates nothing.';

-- ── the data move ──────────────────────────────────────────────────────────

INSERT INTO delivery.obligation_rule_service
  (tenant_id, lineage_id, service_entry_id, linked_at, linked_by_user_id)
SELECT DISTINCT t.tenant_id, t.lineage_id, t.service_entry_id, now(), NULL::uuid
FROM delivery.obligation_template t
WHERE t.service_entry_id IS NOT NULL;

-- ── and the column it replaces ─────────────────────────────────────────────

DROP INDEX IF EXISTS delivery.idx_obligation_template_service;
ALTER TABLE delivery.obligation_template
  DROP CONSTRAINT IF EXISTS obligation_template_service_tenant_fkey,
  DROP COLUMN service_entry_id;

-- ── withdrawn filings ──────────────────────────────────────────────────────

ALTER TABLE delivery.obligation_instance
  ADD COLUMN withdrawn_at timestamptz,
  -- Who removed the filing from the service that owed it. Null only for a
  -- system act; the one writer today is a person's unlink. GLOBAL target.
  ADD COLUMN withdrawn_by_user_id uuid REFERENCES tenancy.user_account (id),
  -- WHY, from a closed set, so "how many filings came off because a service
  -- stopped including them" is a GROUP BY. One member today.
  ADD COLUMN withdrawn_reason text CHECK (withdrawn_reason IN ('service_unlinked')),
  -- All three together, the user excepted for a system act; and a withdrawn
  -- row is UNTOUCHED. A filing somebody started, filed or decided about is
  -- never withdrawn, so a writer that forgot the guard meets this instead of
  -- leaving a filed return marked as taken off.
  ADD CONSTRAINT obligation_instance_withdrawn_chk CHECK (
    (withdrawn_at IS NULL AND withdrawn_by_user_id IS NULL AND withdrawn_reason IS NULL)
    OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL
        AND work_item_id IS NULL AND filed_on IS NULL AND resolved_at IS NULL)
  );

COMMENT ON COLUMN delivery.obligation_instance.withdrawn_at IS
  'Set when the service that owed this filing stopped including it and nothing else covers the client (T6.16, 0309). Out of the calendar, the portal, the nudges, the escalation ladder, the raise and the missed sweep; cleared by the generator when a linked service proposes the period again.';

-- ── the portal never sees a withdrawn row ──────────────────────────────────
--
-- RESTRICTIVE, so it ANDs with isolation (gate 1) and 0062's entity scope
-- (gate 4). GUARDED: see the header for why the bare form would hide the
-- firm's own rows from the firm.
CREATE POLICY obligation_instance_portal_live ON delivery.obligation_instance AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR withdrawn_at IS NULL)
  WITH CHECK (NOT crm.is_portal_session() OR withdrawn_at IS NULL);

RESET ROLE;
