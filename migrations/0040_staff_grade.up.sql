-- 0040 · staff grades — the seniority axis, and the one comparison it exists for
--
-- FIRST MIGRATION IN THE (B) RANGE. The board splits the numbers so two people
-- can add schema in parallel without colliding on 0018: (A) holds 0018–0039,
-- (B) holds 0040+. That leaves a gap, which `migrations/README.md` otherwise
-- forbids — the deviation and its reasoning are recorded there rather than left
-- to be discovered here. The migrator sorts filenames and applies whatever is
-- unapplied; it does not require contiguity, so a later 0018 lands after this
-- one and that is fine as long as the two ranges stay independent. This one
-- touches only tenancy, which nothing in (A)'s range is changing.
--
-- ── WHY A TABLE AT ALL ──────────────────────────────────────────────────────
--
-- Role and seniority are different axes and the product has only had the first.
-- A `member` may be an Article or a Senior Manager: the ROLE says what they may
-- reach, the GRADE says how senior they are. Nothing in the schema could tell
-- them apart, so the firm's own review rule — *"Manager or above is fine"* —
-- had nothing to compare and T2.9's verification routing had nothing to route
-- on.
--
-- That rule is the whole design brief, and it is deliberately small: ONE
-- comparison against an integer. No skill matrix, no tier-and-load routing.
-- The firm stated a single threshold, and inventing structure it did not ask
-- for is the mistake T2.1 avoided by refusing to guess a territory axis.
--
-- ── THE THREE CHOICES WORTH DEFENDING ───────────────────────────────────────
--
-- 1. `rank` is NOT UNIQUE. Two rungs may share a number, because nothing ever
--    compares WITHIN a rung — only across the threshold. Making it unique would
--    turn "add Article below Analyst" into a renumbering transaction over every
--    row, to buy an ordering guarantee nobody reads.
--
-- 2. `is_active`, not `deleted_at`. The distinction is load-bearing and is the
--    same one `obligation_template.is_active` will make: `deleted_at` means the
--    row was a MISTAKE, `is_active` means the firm has MOVED ON. A rung
--    somebody held in 2026 is part of why they were allowed to approve
--    something in 2026, so it has to stay readable forever. Soft-deleting it
--    would make an audit answer "unknown grade" where the honest answer is
--    "Deputy Manager, a rung we no longer promote through".
--
-- 3. `membership.grade_id` is NULLABLE, and that is not a migration
--    convenience. The firm's HR sheet carries six designations its own
--    hierarchy does not place — Article, Intern, Trainee, Head, Public
--    Relations Officer, CEO. Leaving those people UNRANKED is the honest
--    state. A plausible invented rank is indistinguishable from a real one, and
--    this is the column that decides who may sign off a statutory filing, so a
--    wrong guess here is worse than a null almost anywhere else in the system.
--    A client-portal membership has no grade either, and never will.
--
-- ── WHERE THE TEN RUNGS COME FROM ───────────────────────────────────────────
--
-- 10x Global's own hierarchy, as the firm gave it on 22 Aug 2026, carried
-- across from the pre-rebuild demo. Not a product default somebody invented:
-- the firm's HR designations map onto exactly these ten, which is what makes
-- them the confirmed list rather than a plausible one.
--
-- Every EXISTING tenant is backfilled with them below, for the same reason
-- 0005 backfilled roles: gate-3-style reads have no built-in table to fall back
-- on, so a firm with an empty ladder is a firm where nobody can review. New
-- firms get theirs from DEFAULT_GRADES at createTenant, and
-- `tests/staffgrade/seed-parity.test.ts` holds the build red until the two
-- agree — SQL cannot import TypeScript, but the drift between them is
-- preventable and quiet-and-expensive if it is not prevented.

SET ROLE bib_owner;

-- ── the ladder ──────────────────────────────────────────────────────────────
CREATE TABLE tenancy.staff_grade (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  -- The firm's stable handle for a rung. Scoped per tenant, so two firms may
  -- both have a `manager` meaning different things — which they do.
  code       text NOT NULL,
  name       text NOT NULL,
  -- 1 = most junior, so "Manager or above" is `rank >= manager.rank`. Not
  -- unique, not required to be contiguous: a firm inserting a rung between two
  -- others should not have to rewrite the ladder to do it.
  rank       integer NOT NULL CHECK (rank > 0),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Consciously scoped: a code identifies a rung WITHIN a firm. Two firms
  -- sharing `manager` is normal and must stay possible.
  UNIQUE (tenant_id, code),
  -- The composite-key target. Redundant with the primary key on id alone, which
  -- is exactly why it is safe to add: it constrains no data, it only gives a
  -- foreign key something to point at that carries the tenant with it. See 0015
  -- for the full argument — an id-only reference lets one firm's membership
  -- hang off another firm's grade, because a foreign-key check runs as a system
  -- operation RLS does not filter.
  UNIQUE (id, tenant_id)
);

CREATE TRIGGER trg_staff_grade_updated_at BEFORE UPDATE ON tenancy.staff_grade
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The ladder is always read whole and always in order — a picker, a roster
-- column, a threshold comparison. One index serves all three.
CREATE INDEX idx_staff_grade_tenant_rank ON tenancy.staff_grade (tenant_id, rank);

-- Tenant-scoped, so the wall applies. Only the tenant clause here, unlike
-- membership's: there is no identity-mode read of a ladder — nothing asks "this
-- user's grades across firms", because a grade is meaningless outside the firm
-- that defined it.
ALTER TABLE tenancy.staff_grade ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_grade_isolation ON tenancy.staff_grade
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── the link from a login to a rung ─────────────────────────────────────────
ALTER TABLE tenancy.membership
  ADD COLUMN grade_id uuid;

ALTER TABLE tenancy.membership
  ADD CONSTRAINT membership_grade_tenant_fkey
    FOREIGN KEY (grade_id, tenant_id)
    REFERENCES tenancy.staff_grade (id, tenant_id);

RESET ROLE;

-- Grants are not repeated: ALTER DEFAULT PRIVILEGES in 0001 already gives
-- bib_app SELECT, INSERT, UPDATE on tables bib_owner creates in this schema. RLS
-- still applies — bib_app is NOBYPASSRLS and owns nothing.

-- ── backfill ────────────────────────────────────────────────────────────────
--
-- Every firm that predates this migration gets the same ten rungs. The marker
-- comment is read by the parity test; keep the literal on ONE line and keep the
-- `'…'::jsonb` shape, because that is what the test parses.
WITH seed(grades) AS (VALUES ('[{"code":"analyst","name":"Analyst","rank":1},{"code":"senior_analyst","name":"Senior Analyst","rank":2},{"code":"associate","name":"Associate","rank":3},{"code":"senior_associate","name":"Senior Associate","rank":4},{"code":"assistant_manager","name":"Assistant Manager","rank":5},{"code":"deputy_manager","name":"Deputy Manager","rank":6},{"code":"manager","name":"Manager","rank":7},{"code":"senior_manager","name":"Senior Manager","rank":8},{"code":"director","name":"Director","rank":9},{"code":"partner","name":"Partner","rank":10}]'::jsonb)),  -- @default-grades-seed
grade_row AS (
  SELECT
    g->>'code'          AS code,
    g->>'name'          AS name,
    (g->>'rank')::int   AS rank
  FROM seed, jsonb_array_elements(seed.grades) AS g
)
INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
SELECT t.id, r.code, r.name, r.rank
FROM tenancy.tenant t CROSS JOIN grade_row r;

-- Nobody is GRADED by this migration, deliberately. Which of the firm's people
-- is a Manager is a fact only the firm holds, and the whole point of the
-- nullable column above is that an ungraded person is visibly ungraded rather
-- than quietly wrong. The admin screen is where that gets filled in.
