-- 0070 · Whose desk a client's request lands on — and the switch that decides
--        whether anybody's does
--
-- ── WHAT 0068 LEFT OPEN, AND WHY IT WAS LEFT ──────────────────────────────
--
-- 0068 shipped the inbox with NO routing and said so at length: the firm has
-- never stated whether an inbound request belongs to the client's partner, to a
-- Dept, or to whoever is free, and this schema already carries one arbitrary
-- answer to a question of that shape. Its own header promised that when the
-- rule arrived it would be *"a column and an index, not a rewrite"*. This is
-- that column and that index.
--
-- What has NOT happened is the firm stating a rule. So this migration does not
-- encode one: it gives the firm a SWITCH that is OFF, and gives everybody a way
-- to assign a request by hand whatever the switch says.
--
-- ── THE ONLY DERIVABLE TARGET IS THE KEY MANAGER, AND THAT IS STRUCTURAL ──
--
-- `crm.client_assignment` (0049) holds two roles and a SPOC is not reachable
-- from here: `client_assignment_axis_matches_role` makes `axis_id` NOT NULL for
-- one, because a SPOC covers a Dept or a delivery team. A client's request
-- names no service, so there is no axis to look a SPOC up by — picking one
-- would mean choosing an axis on the firm's behalf, which is EXACTLY the
-- arbitrary answer 0068 refused to give and which a shipped rule with no
-- service already gives elsewhere in this schema.
--
-- The Key Manager needs no axis. It is one person per client at a time (an
-- exclusion constraint says so), it is the firm's own record of who owns the
-- relationship, and *"the person who owns this client"* is the only answer to
-- *"whose is this request"* that this database can derive without inventing
-- anything.
--
-- ── SO THE SETTING IS A COLUMN ON THE TENANT, LIKE `work_split_axis` ──────
--
-- 0043 put `work_split_axis` on `tenancy.tenant` rather than in the config
-- registry and gave the reason: it is freely changeable and changing it
-- RESTATES NOTHING — work already cut stays cut, the next piece is cut the new
-- way. This setting behaves identically: requests already assigned keep their
-- assignee, the next one is routed the new way. The registry's versioning,
-- freezing and pinning would buy nothing, because nobody will ever ask what
-- this setting said last March.
--
-- **`none` IS THE DEFAULT AND IT IS A REAL ANSWER, not "unconfigured"** —
-- 0043's words about its own column, and true here for a sharper reason: `none`
-- reproduces 0068's behaviour EXACTLY, so applying this migration changes no
-- firm's behaviour at all. A firm that wants routing switches it on, which is
-- the same position `dunning`, `confidence_tier` and the escalation ladder all
-- take: nothing is seeded, because a rule this product invented is one nobody
-- agreed to.
--
-- ── AND UNASSIGNED-WITH-A-SENTENCE IS THE POINT, NOT A FALLBACK ───────────
--
-- 0051 built this exact pair for work items and its header is worth repeating,
-- because the temptation here is the same: when the rule cannot name somebody,
-- the answer is NOBODY plus a note saying which reason — never a guess.
--
--   *"a wrong assignee is worse than none: it sits on a desk whose owner
--     believes it is not theirs, while unassigned work is visible in a queue
--     that gets chased"*
--
-- A client whose Key Manager has just left, or who never had one, produces an
-- unassigned request with a sentence saying so. `assignment_note` is therefore
-- not decoration — it is the difference between "nobody has got to it" and
-- "the rule ran and could not decide", and only one of those is somebody's to
-- fix.

SET ROLE bib_owner;

-- ── whose desk ─────────────────────────────────────────────────────────────

ALTER TABLE delivery.client_request
  -- `tenancy.user_account` is a GLOBAL table (identity is above tenant,
  -- ADR-02), so this foreign key cannot carry the tenant and does not pretend
  -- to. That somebody is an ACTIVE member of THIS firm is a service check,
  -- exactly as it is for `client_assignment.user_id` and
  -- `work_item.assignee_user_id` — a membership goes inactive long after the
  -- row was written and no foreign key can express "active".
  ADD COLUMN assignee_user_id uuid REFERENCES tenancy.user_account (id),

  -- Why NOBODY, when the rule could not decide. See the header.
  ADD COLUMN assignment_note  text;

-- A note beside a NAME is a stale sentence contradicting the person it sits
-- next to — 0051's constraint, copied with its reason. Assigning a request
-- clears the note in the same UPDATE.
ALTER TABLE delivery.client_request
  ADD CONSTRAINT client_request_note_only_when_unassigned CHECK (
    assignee_user_id IS NULL OR assignment_note IS NULL
  );

-- An empty string is not a note. Null is.
ALTER TABLE delivery.client_request
  ADD CONSTRAINT client_request_note_not_blank CHECK (
    assignment_note IS NULL OR length(btrim(assignment_note)) > 0
  );

-- "What is on MY desk", which is the question the assignee column exists to
-- answer. Partial on the live statuses, like `idx_client_request_live`, and on
-- the same pair — a settled request is nobody's work whoever it is assigned to.
CREATE INDEX idx_client_request_assignee
  ON delivery.client_request (tenant_id, assignee_user_id, raised_at DESC)
  WHERE status IN ('open', 'answered');

-- "What has the rule failed to place", which is the OTHER queue and the one
-- that would otherwise be invisible. 0051 makes the same argument for work
-- items: unassigned work is only chased if somebody can list it.
CREATE INDEX idx_client_request_unassigned
  ON delivery.client_request (tenant_id, raised_at DESC)
  WHERE assignee_user_id IS NULL AND status IN ('open', 'answered');

COMMENT ON COLUMN delivery.client_request.assignee_user_id IS
  'Whose desk this request is on. Null is ORDINARY — the firm may route nothing '
  '(tenancy.tenant.client_request_routing = ''none'', the default), and a rule that '
  'could not name somebody leaves this null with assignment_note saying why.';

-- ── and whether anybody's desk it lands on at all ─────────────────────────

ALTER TABLE tenancy.tenant
  ADD COLUMN client_request_routing text NOT NULL DEFAULT 'none';

ALTER TABLE tenancy.tenant
  ADD CONSTRAINT tenant_client_request_routing_chk
    CHECK (client_request_routing IN ('none', 'key_manager'));

COMMENT ON COLUMN tenancy.tenant.client_request_routing IS
  'How a client-raised request is routed when it arrives. ''none'' is the DEFAULT and a '
  'real answer — it reproduces 0068''s behaviour exactly, so this column changed no firm''s '
  'behaviour on the day it was added. ''key_manager'' routes to crm.client_assignment''s '
  'key_manager for that client. A SPOC is NOT an option and cannot become one without an '
  'axis: a request names no service, so there is nothing to pick a Dept by.';

-- ── AND A PORTAL SESSION CANNOT MOVE A REQUEST ONTO A DESK ───────────────
--
-- `bib_app` holds UPDATE on this table (0068 — withdrawing is an UPDATE), and
-- `client_request_portal_scope`'s WITH CHECK only ever looks at
-- `client_party_id`. So without this, a portal session could UPDATE its OWN
-- request and set `assignee_user_id` to any account it liked: not a leak, but a
-- client silently putting their request on a chosen partner's desk, or taking
-- it off the one the firm's rule chose.
--
-- No route does that today — the portal writes exactly three things, and none
-- of them names this column. But 0068 made `author_side` unforgeable in the
-- DATABASE for the stated reason that an adapter is code somebody can edit and
-- a WITH CHECK is not, and leaving the neighbouring column forgeable would be
-- that argument abandoned one migration later. The moment a fourth portal write
-- exists — a client correcting their own subject, say — is the moment it bites,
-- and that is exactly when nobody re-reads this policy.
--
-- IT IS A TRIGGER AND NOT A POLICY, and that is forced rather than chosen: a
-- WITH CHECK sees only the NEW row, so "did this column CHANGE" is not
-- expressible in one. The trigger compares OLD and NEW and fires only for a
-- portal session, so the firm's own assign path costs nothing.
CREATE FUNCTION delivery.refuse_portal_assignee_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF crm.is_portal_session()
       AND (NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
            OR NEW.assignment_note IS DISTINCT FROM OLD.assignment_note)
    THEN
      RAISE EXCEPTION
        'a client portal session may not change who a request is assigned to'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER trg_client_request_portal_assignee
  BEFORE UPDATE ON delivery.client_request
  FOR EACH ROW EXECUTE FUNCTION delivery.refuse_portal_assignee_change();

RESET ROLE;
