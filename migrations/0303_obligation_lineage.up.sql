-- 0303 · One filing, one row — across a change in the law
--
-- ── THE HOLE 0057 LEFT, STATED BY 0057 ITSELF ──────────────────────────────
--
-- 0057 gave a rule a window, so an AMENDMENT closes the old rule at a day and
-- opens its successor on the same day. The generator honours the window, so a
-- period is only ever PROPOSED by the rule that governs it. That was not
-- enough, and the reason is the reach-back: the nightly sweep materialises a
-- year ahead. On the day a partner records "from 1 October the law says the
-- 11th", the old rule has already produced October, November and the rest of
-- the year for every client — and the successor, whose window covers exactly
-- those periods, produces them AGAIN. Different `template_id`, so the re-run
-- key `(tenant, template, entity, period_start)` does not see a clash, and the
-- calendar shows every return twice with nothing reporting an error.
--
-- ── A LINEAGE: WHAT "THE SAME FILING" MEANS ACROSS A SUPERSESSION ─────────
--
-- A successor keeps its predecessor's identity (same jurisdiction, same name,
-- same period shape — `supersedeRule` carries all three over), so "GSTR-3B for
-- Kaveri Foods, October 2026" is ONE obligation whichever rule in the chain
-- dates it. `lineage_id` names the chain: the first rule's own id, inherited by
-- every successor through `supersedes_id`. It is DERIVED, never supplied —
-- the trigger below computes it on insert and refuses to let it move — so a
-- caller cannot get it wrong, and every hand-written INSERT in a test or a
-- script keeps working without knowing it exists.
--
-- The calendar row carries it too, and the new unique key is on it:
-- `(tenant, lineage, entity, period_start)`. That is the wall. However the rows
-- got there — a sweep, a redelivery, a successor spawned the moment it was
-- written — the database holds one filing per entity per period per chain.
--
-- ── WHY IT IS DENORMALISED ONTO THE INSTANCE, AND WHAT STOPS IT DRIFTING ───
--
-- A unique key cannot reach through a join, so the instance has to hold the
-- lineage itself. 0067 set the pattern for keeping such a column honest: the
-- template gets a composite unique `(id, lineage_id, tenant_id)` that is no
-- stronger than its primary key, and the instance references the PAIR. A row
-- whose lineage disagreed with its template's cannot exist — not by care, by a
-- foreign key. The instance's trigger fills it from the template on insert and
-- whenever `template_id` changes (the handover in `supersede` re-pins rows).
--
-- ── WHAT THIS DOES TO EXISTING DATA ────────────────────────────────────────
--
-- Nothing a firm can see. Every rule gets the lineage its chain implies; a rule
-- nobody superseded is its own lineage, which is all but a handful of rows. If
-- a database ALREADY holds a duplicated filing — a supersession made after the
-- sweep, before this migration — the unique key cannot be created and the
-- migration stops with the rows named. Which copy to keep is a person's
-- decision (one may be on somebody's desk), and `bib_app` holds no DELETE on
-- this table for exactly that reason; resolve them, then run it again.

SET ROLE bib_owner;

-- ── the rule ────────────────────────────────────────────────────────────────

ALTER TABLE delivery.obligation_template ADD COLUMN lineage_id uuid;

WITH RECURSIVE chain (id, tenant_id, root) AS (
  SELECT id, tenant_id, id
  FROM delivery.obligation_template
  WHERE supersedes_id IS NULL
  UNION ALL
  SELECT t.id, t.tenant_id, c.root
  FROM delivery.obligation_template t
  JOIN chain c ON t.supersedes_id = c.id AND t.tenant_id = c.tenant_id
)
UPDATE delivery.obligation_template t
SET lineage_id = c.root
FROM chain c
WHERE t.id = c.id;

ALTER TABLE delivery.obligation_template ALTER COLUMN lineage_id SET NOT NULL;

ALTER TABLE delivery.obligation_template
  -- The lineage is a rule at this firm, carried with the tenant like every
  -- other reference here (`tenant-keys.integration.test.ts`).
  ADD CONSTRAINT obligation_template_lineage_tenant_fkey
    FOREIGN KEY (lineage_id, tenant_id)
    REFERENCES delivery.obligation_template (id, tenant_id),
  -- No stronger than the primary key. It exists so the calendar row can
  -- reference the (rule, lineage) PAIR and have the database check it.
  ADD CONSTRAINT obligation_template_id_lineage_tenant_key
    UNIQUE (id, lineage_id, tenant_id);

CREATE OR REPLACE FUNCTION delivery.obligation_template_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.supersedes_id IS NULL THEN
      NEW.lineage_id := NEW.id;
    ELSE
      SELECT p.lineage_id INTO NEW.lineage_id
      FROM delivery.obligation_template p
      WHERE p.id = NEW.supersedes_id AND p.tenant_id = NEW.tenant_id;
      IF NEW.lineage_id IS NULL THEN
        RAISE EXCEPTION
          'obligation rule % supersedes %, which is not a rule at this firm',
          NEW.id, NEW.supersedes_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. A rule's chain is part of what every filing it dated means, so it
  -- does not move once written. A different chain is a different rule.
  IF NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION
      'obligation rule %: which rule it replaces is fixed when it is written; write a new rule instead',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER obligation_template_lineage
  BEFORE INSERT OR UPDATE OF lineage_id, supersedes_id ON delivery.obligation_template
  FOR EACH ROW EXECUTE FUNCTION delivery.obligation_template_lineage();

COMMENT ON COLUMN delivery.obligation_template.lineage_id IS
  'The first rule in this rule''s supersession chain (its own id if it replaces nothing). Derived by trigger from supersedes_id; never supplied, never changed.';

-- ── the calendar row ────────────────────────────────────────────────────────

ALTER TABLE delivery.obligation_instance ADD COLUMN lineage_id uuid;

UPDATE delivery.obligation_instance i
SET lineage_id = t.lineage_id
FROM delivery.obligation_template t
WHERE t.id = i.template_id AND t.tenant_id = i.tenant_id;

ALTER TABLE delivery.obligation_instance ALTER COLUMN lineage_id SET NOT NULL;

DO $$
DECLARE
  clashes integer;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1
    FROM delivery.obligation_instance
    GROUP BY tenant_id, lineage_id, entity_party_id, period_start
    HAVING count(*) > 1
  ) d;
  IF clashes > 0 THEN
    RAISE EXCEPTION
      '0303: % filing(s) already appear twice under one rule and its successor. Find them with: SELECT tenant_id, lineage_id, entity_party_id, period_start, array_agg(id) FROM delivery.obligation_instance GROUP BY 1,2,3,4 HAVING count(*) > 1; decide which copy stands, move the other off the calendar by hand, and migrate again',
      clashes;
  END IF;
END $$;

ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_lineage_tenant_fkey
    FOREIGN KEY (template_id, lineage_id, tenant_id)
    REFERENCES delivery.obligation_template (id, lineage_id, tenant_id),
  -- THE WALL. One filing per entity, per period, per chain of rules.
  ADD CONSTRAINT obligation_instance_lineage_key
    UNIQUE (tenant_id, lineage_id, entity_party_id, period_start);

CREATE OR REPLACE FUNCTION delivery.obligation_instance_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT t.lineage_id INTO NEW.lineage_id
  FROM delivery.obligation_template t
  WHERE t.id = NEW.template_id AND t.tenant_id = NEW.tenant_id;
  -- A rule that is not this firm's is refused HERE, under the name of the
  -- constraint it breaks. Left to run on, the row would fail on the lineage's
  -- NOT NULL first, and "null value in lineage_id" hides the real reason — a
  -- row reaching across the tenant wall.
  IF NEW.lineage_id IS NULL THEN
    RAISE EXCEPTION
      'obligation_instance_template_tenant_fkey: rule % is not a rule at firm %',
      NEW.template_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER obligation_instance_lineage
  BEFORE INSERT OR UPDATE OF template_id, lineage_id ON delivery.obligation_instance
  FOR EACH ROW EXECUTE FUNCTION delivery.obligation_instance_lineage();

COMMENT ON COLUMN delivery.obligation_instance.lineage_id IS
  'Copied from the template by trigger. Carries the one-filing-per-period wall across a supersession; see 0303.';

RESET ROLE;
