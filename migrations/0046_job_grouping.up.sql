-- 0046 · merged delivery — one job for one client's work under one team, and
--        the link that says which engagements are in it (T2.7, the grouping half)
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
--
-- A client signs one engagement letter with three services on it — GST filing,
-- TDS return, bookkeeping — all three delivered by the same team. Today that is
-- THREE jobs and three checklists, because `crm.engagement` carries
-- `UNIQUE (engagement_letter_line_id)`: one engagement per LINE, so a letter
-- with three lines already fans out to three. Same team, same client, same
-- month, ticked off in three places.
--
-- So the grouping this task owes MERGES jobs. It does not split them. The board
-- said the opposite for a day and reading this constraint is what corrected it.
--
-- ── THE KEY, AND WHY EVERY PART OF IT IS THERE ──────────────────────────────
--
--   (engagement_letter_id, entity_party_id, split axis code, workflow key)
--
-- `entity_party_id` — THE ONE THAT IS NOT NEGOTIABLE. The firm's own rule,
-- confirmed by its owner, is Per Company: vCFO work for four companies is four
-- engagements because each company files its own returns, under its own
-- registrations, on its own dates. Merging across legal entities would put two
-- companies' filings on one checklist. In this firm's practice one letter names
-- one entity anyway — three sub-companies get three letters, not one letter
-- with three companies on it — but `crm.engagement_letter_line.entity_party_id`
-- is per LINE (0018) and the schema therefore ALLOWS a mixed letter. Practice
-- says it will not happen; the key says it cannot matter if it does.
--
-- `engagement_letter_id` — a job has to be able to FINISH. An entity that signs
-- a letter in April and another in July has signed two contracts, and letting
-- July's work join April's still-open checklist would grow one job for the life
-- of the client relationship. Two contracts, two pieces of delivery.
--
-- the axis code — the firm's own answer to "what splits our work", from
-- `tenancy.tenant.work_split_axis` (G2.4). `none` merges nothing at all, which
-- is the default and reproduces the behaviour every existing firm has today.
--
-- the workflow key — because a template IS "how we do this". If a firm wrote
-- one process for GST filing and a different one for TDS, it has said they are
-- two processes; forcing them into one checklist would invent an ordering
-- between them that nobody wrote, over step keys that can collide. In practice
-- the services of one team usually name one process (or none), so the merge
-- still happens. `null` — no process written — is its own group, and those jobs
-- wait exactly as they do today.
--
-- ── TWO DIFFERENT UNIQUENESS RULES, AND THEY ARE NOT THE SAME RULE ──────────
--
-- `delivery.job` had `UNIQUE (tenant_id, source_kind, source_ref)` doing all the
-- idempotency. That cannot survive the merge: a merged job's cause is several
-- engagements, not one, so `source_ref` becomes the GROUP's derived id and the
-- guarantee has to move to where the real risk is. Two rules now:
--
--   `job_engagement UNIQUE (tenant_id, engagement_id)` — ABSOLUTE and forever.
--   One engagement's work exists in exactly one job, whatever its status. This
--   is the guarantee that actually matters: a second job for work already owed
--   is a second set of tasks on somebody's desk and a second invoice at the end
--   of it. Every route into the engine is at-least-once — pg-boss redelivers, a
--   sweep re-reads events it has seen, a worker dies mid-transaction — and this
--   is what makes the second attempt lose structurally rather than carefully.
--
--   at most one OPEN job per group — a PARTIAL unique index, `WHERE status NOT
--   IN ('done','cancelled')`. Partial on purpose: a group's job finishes, and
--   months later a fourth line of the same letter activates. Attaching new work
--   to a finished checklist means work nobody will look at again, so that
--   engagement gets a fresh job for the same group. Legal, correct, and only
--   expressible if the constraint applies to open jobs alone.
--
-- ── EVERY JOB GETS LINK ROWS, INCLUDING THE UNMERGED ONES ───────────────────
--
-- A firm on `none` still writes one row here per job. `source_ref` goes back to
-- being nothing but an idempotency key, and "what is this job FOR" has exactly
-- one answer everywhere — a link table — rather than one answer for single jobs
-- and another for merged ones. The subject read joins through here for both.

SET ROLE bib_owner;

-- ── the third cause ─────────────────────────────────────────────────────────
--
-- `engagement` stays and keeps its meaning: a job for exactly one engagement.
-- That is every row written before today and every row a `none` firm writes
-- after it, and calling those something else would restate history. A merged
-- job is a genuinely different kind of cause — its `source_ref` names no row in
-- any table, it is a derived group id — and the CHECK is what makes adding a
-- kind a deliberate change rather than a typo that invents one.
ALTER TABLE delivery.job DROP CONSTRAINT job_source_kind_check;
ALTER TABLE delivery.job
  ADD CONSTRAINT job_source_kind_check
    CHECK (source_kind IN ('engagement', 'obligation', 'engagement_group'));

-- ── how this job was cut, recorded on the job ───────────────────────────────
--
-- Both are COPIED from the firm's setting and the live service body at spawn,
-- and both are redundant against a join — deliberately, for the two reasons
-- `job_step.executor` already argues.
--
-- The work board renders "FINCOMPLIANCE" on every card, and deriving it would
-- mean joining through the link table to N engagements to N service versions
-- and parsing JSON, per row, per render.
--
-- And it must not move. The grouping was decided from what was published AT
-- SPAWN; a firm that re-files a service under a different team next quarter has
-- not changed why this job was cut the way it was. Same argument the pinned
-- template version makes one level up.
ALTER TABLE delivery.job
  ADD COLUMN split_axis text NOT NULL DEFAULT 'none'
             CHECK (split_axis IN ('none', 'dept', 'team')),
  -- The Dept or team this job's work was filed under. NULL is a real answer in
  -- two different ways and neither is an error: `none` never has one, and a
  -- firm that DOES split has services nobody has filed yet — the catalogue
  -- screen says "filed under no Dept" rather than hiding them, and their work
  -- groups together under this null rather than being dropped.
  ADD COLUMN split_code text,
  ADD CONSTRAINT job_split_code_needs_an_axis CHECK (
    split_axis <> 'none' OR split_code IS NULL
  );

-- ── at most one OPEN job per cause ──────────────────────────────────────────
--
-- Replaces the plain UNIQUE. See the note above for why it has to be partial;
-- the absolute rule moved to `job_engagement`.
ALTER TABLE delivery.job DROP CONSTRAINT job_tenant_id_source_kind_source_ref_key;
CREATE UNIQUE INDEX idx_job_open_per_source
  ON delivery.job (tenant_id, source_kind, source_ref)
  WHERE status NOT IN ('done', 'cancelled');

-- ── which engagements a job delivers ────────────────────────────────────────
CREATE TABLE delivery.job_engagement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  job_id        uuid NOT NULL,
  engagement_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- THE RULE. One engagement, one job, forever — see the note above.
  CONSTRAINT job_engagement_one_job_per_engagement UNIQUE (tenant_id, engagement_id),

  -- Composite both times, because a foreign-key check runs as a system
  -- operation RLS does not filter: an id-only reference between two
  -- tenant-scoped tables would let one firm's row hang off another firm's.
  -- Silent if it ever happened, which is why it is made unrepresentable.
  CONSTRAINT job_engagement_job_tenant_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  CONSTRAINT job_engagement_engagement_tenant_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id)
);

-- "What is in this job" — read whole, on the job screen and by the subject
-- resolution the orchestrator runs when a job starts.
CREATE INDEX idx_job_engagement_job ON delivery.job_engagement (tenant_id, job_id);

-- Tenant-scoped, so the wall applies.
ALTER TABLE delivery.job_engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_engagement_isolation ON delivery.job_engagement
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- SELECT, INSERT, UPDATE — inherited from 0041's ALTER DEFAULT PRIVILEGES on
-- this schema, and never DELETE. Unlinking an engagement from the job that
-- delivered it would erase the only record of what that work was.

-- ── backfill: every job that already exists gets its link row ───────────────
--
-- Joined to `crm.engagement` rather than inserted blind. `source_ref` is not a
-- foreign key (it names different tables for different kinds), so a job whose
-- engagement is not there would fail the FK and take the whole migration with
-- it. Such a job should not exist; if one does, it comes out of this with no
-- link and its subject reads as null — which is exactly how it already behaves
-- today, rather than a new failure invented by this migration.
INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id)
SELECT j.tenant_id, j.id, e.id
FROM delivery.job j
JOIN crm.engagement e ON e.id = j.source_ref AND e.tenant_id = j.tenant_id
WHERE j.source_kind = 'engagement'
ON CONFLICT DO NOTHING;

RESET ROLE;
