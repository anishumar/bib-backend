-- The last-administrator guard, as a rule the database keeps.
--
-- ── THE RACE THE APPLICATION GUARD CANNOT CLOSE ────────────────────────────
--
-- `TenancyService.requireAdministratorSurvives` reads the roster, works out
-- what it would look like after the change, and refuses if nobody would be left
-- able to administer the firm. It is correct and it is a check-then-act: the
-- read and the write are two statements, and two callers fit between them.
--
-- Two administrators, each deactivating the other at the same moment. Both
-- read a roster with two administrators in it. Both conclude that one would
-- survive. Both writes land. The firm now has none — which is the exact state
-- the guard exists to prevent, reached by satisfying it twice. Same story for
-- two concurrent role changes.
--
-- It is unrecoverable from inside the product: configuration writes need
-- `tenant:admin`, so there is nobody left who can put it back. The fix is a
-- database session, which is not a thing a customer has.
--
-- ── WHY A TRIGGER RATHER THAN A CONSTRAINT ─────────────────────────────────
--
-- The invariant spans rows ("at least one active staff member holds a role that
-- carries tenant:admin") and reaches into another schema for what a role means,
-- so no CHECK or unique index can express it. A trigger can, and unlike the
-- application guard it runs INSIDE the transaction that does the writing.
--
-- ── HOW IT BEATS THE RACE ──────────────────────────────────────────────────
--
-- The advisory lock. Under READ COMMITTED each statement takes a fresh
-- snapshot, so the two transactions above serialise on the lock and the second
-- one's count runs after the first has committed — it sees the world the first
-- one left, plus its own change, and refuses. Without the lock both counts run
-- against snapshots taken before either commit and both pass.
--
-- ── AND WHY IT ONLY FIRES ON THE CHANGE THAT COULD CAUSE IT ────────────────
--
-- Only when the row being updated STOPS being an active staff administrator.
-- An update that does anything else cannot have removed the last one, and
-- checking anyway would put a lock and a count on every membership write.
--
-- INSERT is not covered, deliberately: adding a membership can only add an
-- administrator or leave the count alone. That also keeps provisioning clear —
-- a brand-new firm granting its first membership has no administrator yet, and
-- a trigger that fired there would refuse the write that is about to create
-- one.
--
-- The `audience = 'STAFF'` filter on both sides is the same rule the
-- application guard follows: gate 2 admits a CLIENT_PORTAL session to the
-- portal routes and nothing else, so a portal role carrying `tenant:admin`
-- administers precisely nothing and must not count as the survivor.
SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION tenancy.is_administering_role(p_tenant uuid, p_role text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM config.entry e
    JOIN config.version v ON v.entry_id = e.id AND v.tenant_id = e.tenant_id
    WHERE e.tenant_id = p_tenant
      AND e.kind = 'role'
      AND e.key = p_role
      AND v.status = 'published'
      AND jsonb_exists(v.body -> 'permissions', 'tenant:admin')
      -- An absent audience reads as STAFF: every role written before the field
      -- existed was a staff role, and that is the fail-closed direction.
      AND COALESCE(v.body ->> 'audience', 'STAFF') = 'STAFF'
  );
$$;

CREATE OR REPLACE FUNCTION tenancy.administrator_survives()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  was_admin boolean;
  is_admin  boolean;
  survivors integer;
BEGIN
  was_admin := OLD.is_active
    AND OLD.audience = 'STAFF'
    AND tenancy.is_administering_role(OLD.tenant_id, OLD.role);

  IF NOT was_admin THEN
    RETURN NEW;
  END IF;

  is_admin := NEW.is_active
    AND NEW.audience = 'STAFF'
    AND tenancy.is_administering_role(NEW.tenant_id, NEW.role);

  -- Still one. Nothing was taken away.
  IF is_admin THEN
    RETURN NEW;
  END IF;

  -- Serialise every firm against itself for the rest of this transaction. The
  -- constant claims a lock class of our own so an unrelated feature hashing a
  -- tenant id the same way does not queue behind us; the object id is 31 bits
  -- of the uuid, so two firms may collide and wait on each other for a
  -- millisecond, which costs nothing and can never produce a wrong answer.
  PERFORM pg_advisory_xact_lock(
    hashtext('tenancy.administrator_survives'),
    ('x' || substr(replace(NEW.tenant_id::text, '-', ''), 1, 8))::bit(32)::int
  );

  SELECT count(*) INTO survivors
  FROM tenancy.membership m
  WHERE m.tenant_id = NEW.tenant_id
    AND m.id <> NEW.id
    AND m.is_active
    AND m.audience = 'STAFF'
    AND tenancy.is_administering_role(m.tenant_id, m.role);

  IF survivors = 0 THEN
    RAISE EXCEPTION
      'this would leave % with nobody able to administer it', NEW.tenant_id
      USING ERRCODE = '23514',
            HINT = 'give somebody else a role carrying tenant:admin first';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER administrator_survives
  BEFORE UPDATE ON tenancy.membership
  FOR EACH ROW EXECUTE FUNCTION tenancy.administrator_survives();

COMMENT ON FUNCTION tenancy.administrator_survives() IS
  'The last-administrator guard, inside the transaction that writes. The application checks first and says something useful; this is what makes the check hold when two of them run at once.';

RESET ROLE;
