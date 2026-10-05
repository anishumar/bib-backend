-- 0363 · The ad-hoc advance: an advance invoice raised BEFORE the engagement
-- letter, kept on a list until it is mapped to the work it pays for (Q044-Q048,
-- Ashish and the user, 2026-10-04/05; design: bib/prompts/build-2026-10-05/
-- S4-advance/DESIGN.md).
--
-- WHY NOT A `billing_due` OF KIND 'advance'. That row names a LETTER (its
-- subject check and its currency key both say so), and there is at most one per
-- letter or per service. An advance with no letter does not fit it, and one
-- advance split over two services would be two sources on ONE invoice: every
-- query that sums by `advance_invoice_id` (the pool's `applied`, the take's
-- re-check, the credit-note cap) would count each take twice. So:
--
--   crm.adhoc_advance       one per advance raised with no letter: its invoice
--                           (an ordinary tax invoice, numbered at issue), who
--                           raised it and the note. The invoice IS the advance:
--                           its money is the invoice's net, read, never copied.
--   crm.advance_allocation  one row per "map": part of it pointed at a service
--                           (and optionally one job of it), or at a whole
--                           signed letter (the letter named it, scenario 1).
--                           Append and end, never erased: a re-map ends the old
--                           row (keeping what bills already took) and writes a
--                           new one, so the table is the history.
--   crm.engagement_letter_advance
--                           an advance a DRAFT letter names ("Advance received:
--                           INV-..."), frozen with the letter's other terms.
--   crm.billing_due.advance_allocation_id
--                           which allocation a bill took from.
--
-- `crm.advance_pool` learns the two new kinds of row (`source`), and
-- `crm.invoice_manager_share` says whose revenue each part of an invoice is.

SET ROLE bib_owner;

-- ── The advance ─────────────────────────────────────────────────────────────

CREATE TABLE crm.adhoc_advance (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenancy.tenant (id),
  invoice_id        uuid NOT NULL,
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note              text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  raised_by_user_id uuid NOT NULL REFERENCES tenancy.user_account (id),
  raised_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adhoc_advance_id_tenant_key UNIQUE (id, tenant_id),
  -- What an allocation's key reaches, so its currency and invoice are the
  -- advance's by construction.
  CONSTRAINT adhoc_advance_full_key UNIQUE (id, tenant_id, invoice_id, currency),
  CONSTRAINT adhoc_advance_one_per_invoice UNIQUE (tenant_id, invoice_id),
  -- In the invoice's currency, by key.
  CONSTRAINT adhoc_advance_invoice_fkey
    FOREIGN KEY (invoice_id, tenant_id, currency) REFERENCES crm.invoice (id, tenant_id, currency)
);

CREATE INDEX idx_adhoc_advance_raised ON crm.adhoc_advance (tenant_id, raised_at DESC);

COMMENT ON TABLE crm.adhoc_advance IS
  'An advance invoice raised with no engagement letter (0363, Q044): on "Advances to be adjusted" until mapped to services. The invoice is an ordinary tax invoice; its net is the advance, before tax.';

-- ── Where its money goes ────────────────────────────────────────────────────

CREATE TABLE crm.advance_allocation (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  adhoc_advance_id     uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  currency             text NOT NULL,
  -- The target: a service (and optionally one job of it), or a signed letter.
  engagement_id        uuid,
  job_id               uuid,
  engagement_letter_id uuid,
  amount               numeric(18,4) NOT NULL CHECK (amount > 0),
  -- Whose revenue this part is, frozen when it was mapped (Q045: "diff
  -- managers"). Null: nobody could be named; the report shows it as such.
  manager_user_id      uuid REFERENCES tenancy.user_account (id),
  how                  text NOT NULL CHECK (how IN ('by_hand', 'letter_signed')),
  reason               text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  created_by_user_id   uuid REFERENCES tenancy.user_account (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Ended (re-mapped or freed): what bills had taken by then stays mapped
  -- (`kept_amount`), the rest goes back to the advance's unmapped balance.
  ended_at             timestamptz,
  ended_by_user_id     uuid REFERENCES tenancy.user_account (id),
  end_reason           text,
  kept_amount          numeric(18,4),
  CONSTRAINT advance_allocation_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT advance_allocation_bill_key UNIQUE (id, tenant_id, invoice_id),
  CONSTRAINT advance_allocation_advance_fkey
    FOREIGN KEY (adhoc_advance_id, tenant_id, invoice_id, currency)
    REFERENCES crm.adhoc_advance (id, tenant_id, invoice_id, currency),
  CONSTRAINT advance_allocation_engagement_fkey
    FOREIGN KEY (engagement_id, tenant_id) REFERENCES crm.engagement (id, tenant_id),
  CONSTRAINT advance_allocation_job_fkey
    FOREIGN KEY (job_id, tenant_id) REFERENCES delivery.job (id, tenant_id),
  CONSTRAINT advance_allocation_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id) REFERENCES crm.engagement_letter (id, tenant_id),
  -- A service, or a letter; a job only within a service.
  CONSTRAINT advance_allocation_one_target_chk CHECK (
    (engagement_id IS NULL) <> (engagement_letter_id IS NULL)
    AND (job_id IS NULL OR engagement_id IS NOT NULL)
  ),
  -- A letter maps what it named when it is signed; a person maps a service.
  CONSTRAINT advance_allocation_how_chk CHECK (
    (how = 'letter_signed') = (engagement_letter_id IS NOT NULL)
  ),
  CONSTRAINT advance_allocation_ended_chk CHECK (
    (ended_at IS NULL) = (kept_amount IS NULL)
    AND (ended_at IS NULL) = (end_reason IS NULL)
    AND (ended_by_user_id IS NULL OR ended_at IS NOT NULL)
    AND (kept_amount IS NULL OR (kept_amount >= 0 AND kept_amount <= amount))
    AND (end_reason IS NULL OR (btrim(end_reason) <> '' AND length(end_reason) <= 500))
  )
);

CREATE INDEX idx_advance_allocation_advance ON crm.advance_allocation (tenant_id, adhoc_advance_id);
CREATE INDEX idx_advance_allocation_engagement
  ON crm.advance_allocation (tenant_id, engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX idx_advance_allocation_letter
  ON crm.advance_allocation (tenant_id, engagement_letter_id) WHERE engagement_letter_id IS NOT NULL;
-- A letter maps each advance it named ONCE, whatever happened to that mapping
-- since: the catch-up after signing must not map it again after a re-map.
CREATE UNIQUE INDEX advance_allocation_letter_once
  ON crm.advance_allocation (tenant_id, adhoc_advance_id, engagement_letter_id)
  WHERE how = 'letter_signed';

COMMENT ON TABLE crm.advance_allocation IS
  'Part of an ad-hoc advance mapped to a service (optionally one job of it) or to a signed letter (0363, Q045/Q048). Effective amount = kept_amount once ended, else amount. Comes off that work''s earliest bills, before tax, as the letter''s own advance does.';

-- THE TARGET IS THE ADVANCE'S CLIENT, COMPANY AND CURRENCY, as a wall for every
-- writer (the service refuses first, with the sentence): the advance is in the
-- issuing company's tax books, so another company's invoice cannot take it; an
-- AED advance is never converted into an INR service's.
CREATE FUNCTION crm.check_advance_allocation_target() RETURNS trigger AS $$
DECLARE
  adv record;
  tgt record;
BEGIN
  SELECT i.party_id, i.entity_party_id, i.currency
    INTO adv
    FROM crm.invoice i
   WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id;

  IF NEW.engagement_id IS NOT NULL THEN
    SELECT e.party_id, l.issuing_entity_party_id AS issuer, upper(ll.currency) AS currency
      INTO tgt
      FROM crm.engagement e
      JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
      JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
     WHERE e.id = NEW.engagement_id AND e.tenant_id = NEW.tenant_id;
  ELSE
    SELECT l.party_id, l.issuing_entity_party_id AS issuer, upper(l.currency) AS currency
      INTO tgt
      FROM crm.engagement_letter l
     WHERE l.id = NEW.engagement_letter_id AND l.tenant_id = NEW.tenant_id;
  END IF;

  IF tgt.party_id IS DISTINCT FROM adv.party_id THEN
    RAISE EXCEPTION 'an advance is mapped only to its own client''s work' USING ERRCODE = 'check_violation';
  END IF;
  IF tgt.issuer IS DISTINCT FROM adv.entity_party_id THEN
    RAISE EXCEPTION 'an advance is mapped only to work its own company signed' USING ERRCODE = 'check_violation';
  END IF;
  IF tgt.currency IS DISTINCT FROM upper(adv.currency) THEN
    RAISE EXCEPTION 'an advance in % is not mapped to work billed in %', adv.currency, tgt.currency
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM delivery.job j
        WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id
          AND j.source_kind IN ('engagement', 'engagement_period')
          AND j.source_ref = NEW.engagement_id) THEN
    RAISE EXCEPTION 'the job is not one of this service''s' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_advance_allocation_target
  BEFORE INSERT ON crm.advance_allocation
  FOR EACH ROW EXECUTE FUNCTION crm.check_advance_allocation_target();

-- What a person may change on an allocation: only that it ended.
CREATE FUNCTION crm.refuse_advance_allocation_change() RETURNS trigger AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended allocation does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.adhoc_advance_id, NEW.invoice_id, NEW.currency, NEW.engagement_id,
      NEW.job_id, NEW.engagement_letter_id, NEW.amount, NEW.manager_user_id, NEW.how, NEW.reason,
      NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.adhoc_advance_id, OLD.invoice_id, OLD.currency, OLD.engagement_id,
      OLD.job_id, OLD.engagement_letter_id, OLD.amount, OLD.manager_user_id, OLD.how, OLD.reason,
      OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'an allocation is ended and mapped again, never edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_advance_allocation_only_ends
  BEFORE UPDATE ON crm.advance_allocation
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_advance_allocation_change();

-- ── The advances a draft letter names (Q048, scenario 1) ────────────────────

CREATE TABLE crm.engagement_letter_advance (
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  -- Named `engagement_letter_id` on purpose: 0019's child freeze and 0087's
  -- deleted-parent guard find the parent by that name.
  engagement_letter_id uuid NOT NULL,
  adhoc_advance_id     uuid NOT NULL,
  currency             text NOT NULL,
  amount               numeric(18,4) NOT NULL CHECK (amount > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_letter_advance_pkey PRIMARY KEY (engagement_letter_id, adhoc_advance_id),
  -- The letter's own currency, and the advance's: they are one.
  CONSTRAINT engagement_letter_advance_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency),
  CONSTRAINT engagement_letter_advance_advance_fkey
    FOREIGN KEY (adhoc_advance_id, tenant_id) REFERENCES crm.adhoc_advance (id, tenant_id)
);

CREATE INDEX idx_engagement_letter_advance_advance
  ON crm.engagement_letter_advance (tenant_id, adhoc_advance_id);

CREATE FUNCTION crm.check_letter_names_own_advance() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM crm.adhoc_advance a
         JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id
         JOIN crm.engagement_letter l ON l.id = NEW.engagement_letter_id AND l.tenant_id = NEW.tenant_id
        WHERE a.id = NEW.adhoc_advance_id AND a.tenant_id = NEW.tenant_id
          AND a.currency = NEW.currency
          AND i.party_id = l.party_id
          AND i.entity_party_id = l.issuing_entity_party_id) THEN
    RAISE EXCEPTION 'a letter names only an advance of its own client, company and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_advance_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.engagement_letter_advance
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();
CREATE TRIGGER trg_el_advance_parent_not_deleted
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_advance
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_change_under_deleted_document();
CREATE TRIGGER trg_el_advance_z_own_advance
  BEFORE INSERT OR UPDATE ON crm.engagement_letter_advance
  FOR EACH ROW EXECUTE FUNCTION crm.check_letter_names_own_advance();
CREATE TRIGGER trg_el_advance_updated_at BEFORE UPDATE ON crm.engagement_letter_advance
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

COMMENT ON TABLE crm.engagement_letter_advance IS
  'An ad-hoc advance a letter names as already received (0363, Q048 scenario 1): printed on the letter, mapped to the letter when it is signed (min of this amount and what is left unmapped then).';

-- ── Which allocation a bill took from ───────────────────────────────────────

ALTER TABLE crm.billing_due
  ADD COLUMN advance_allocation_id uuid,
  -- The allocation's invoice IS the advance invoice the bill names.
  ADD CONSTRAINT billing_due_advance_allocation_fkey
    FOREIGN KEY (advance_allocation_id, tenant_id, advance_invoice_id)
    REFERENCES crm.advance_allocation (id, tenant_id, invoice_id),
  ADD CONSTRAINT billing_due_advance_allocation_chk CHECK (
    advance_allocation_id IS NULL OR advance_invoice_id IS NOT NULL
  );

CREATE INDEX idx_billing_due_advance_allocation
  ON crm.billing_due (tenant_id, advance_allocation_id) WHERE advance_allocation_id IS NOT NULL;

GRANT UPDATE (advance_allocation_id) ON crm.billing_due TO bib_app;

COMMENT ON COLUMN crm.billing_due.advance_allocation_id IS
  'The ad-hoc advance allocation this bill was reduced from (0363). Null: the letter''s own advance, or none.';

-- ── What is left of each advance ────────────────────────────────────────────
--
-- Rebuilt with the same columns first (CREATE OR REPLACE), then:
--   source             'letter_bill' (the letter's own advance, as 0320),
--                      'allocation' (part of an ad-hoc advance mapped to work),
--                      'unmapped' (what of an ad-hoc advance is mapped nowhere;
--                      no bill ever takes from it: it has no target).
--   allocation_id, adhoc_advance_id, fee_group_id (the mapped service's group,
--   so a grouped bill finds it), job_period_start (a job's period narrows the
--   take to the bill whose period holds it), issued_on (oldest money first).
-- `sum(remaining)` per invoice is still "what of it no bill has taken", which is
-- what the credit-note cap reads.
CREATE OR REPLACE VIEW crm.advance_pool WITH (security_invoker = true) AS
SELECT a.id AS advance_due_id,
       a.tenant_id,
       a.party_id,
       a.currency,
       a.engagement_letter_id,
       a.engagement_id,
       i.id     AS invoice_id,
       i.number AS invoice_number,
       t.net    AS invoice_net,
       t.total  AS invoice_total,
       coalesce(c.credited, 0) AS credited,
       least(coalesce(la.net, a.amount, t.net), t.net)
         - coalesce(c.credited, 0) * t.net / nullif(t.total, 0) AS advance_net,
       coalesce(u.applied, 0) AS applied,
       round(least(coalesce(la.net, a.amount, t.net), t.net)
         - coalesce(c.credited, 0) * t.net / nullif(t.total, 0)
         - coalesce(u.applied, 0), 2) AS remaining,
       'letter_bill'::text AS source,
       NULL::uuid AS allocation_id,
       NULL::uuid AS adhoc_advance_id,
       NULL::uuid AS fee_group_id,
       NULL::date AS job_period_start,
       i.issued_on
  FROM crm.billing_due a
  JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id AND i.status = 'issued'
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN crm.invoice_line_amount la
    ON la.invoice_line_id = a.invoice_line_id AND la.tenant_id = a.tenant_id
  LEFT JOIN (
    SELECT cn.invoice_id, cn.tenant_id, sum(cn.amount) AS credited
      FROM crm.credit_note cn
     GROUP BY cn.invoice_id, cn.tenant_id
  ) c ON c.invoice_id = i.id AND c.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT b.advance_invoice_id, b.tenant_id, sum(b.advance_applied) AS applied
      FROM crm.billing_due b
      LEFT JOIN crm.invoice bi ON bi.id = b.invoice_id AND bi.tenant_id = b.tenant_id
     WHERE b.advance_invoice_id IS NOT NULL
       AND b.advance_allocation_id IS NULL
       AND b.skipped_at IS NULL
       AND (b.covered_at IS NOT NULL OR bi.status IN ('draft', 'issued'))
     GROUP BY b.advance_invoice_id, b.tenant_id
  ) u ON u.advance_invoice_id = i.id AND u.tenant_id = i.tenant_id
 WHERE a.kind = 'advance'

UNION ALL

-- Each allocation: its effective amount, less what bills took from IT.
SELECT NULL::uuid AS advance_due_id,
       al.tenant_id,
       i.party_id,
       al.currency,
       al.engagement_letter_id,
       al.engagement_id,
       i.id, i.number, t.net, t.total,
       coalesce(c.credited, 0),
       coalesce(al.kept_amount, al.amount),
       coalesce(u.applied, 0),
       round(coalesce(al.kept_amount, al.amount) - coalesce(u.applied, 0), 2),
       'allocation'::text,
       al.id,
       al.adhoc_advance_id,
       ll.fee_group_id,
       j.period_start,
       i.issued_on
  FROM crm.advance_allocation al
  JOIN crm.invoice i ON i.id = al.invoice_id AND i.tenant_id = al.tenant_id AND i.status = 'issued'
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN crm.engagement e ON e.id = al.engagement_id AND e.tenant_id = al.tenant_id
  LEFT JOIN crm.engagement_letter_line ll
    ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
  LEFT JOIN delivery.job j ON j.id = al.job_id AND j.tenant_id = al.tenant_id
  LEFT JOIN (
    SELECT cn.invoice_id, cn.tenant_id, sum(cn.amount) AS credited
      FROM crm.credit_note cn
     GROUP BY cn.invoice_id, cn.tenant_id
  ) c ON c.invoice_id = i.id AND c.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT b.advance_allocation_id, b.tenant_id, sum(b.advance_applied) AS applied
      FROM crm.billing_due b
      LEFT JOIN crm.invoice bi ON bi.id = b.invoice_id AND bi.tenant_id = b.tenant_id
     WHERE b.advance_allocation_id IS NOT NULL
       AND b.skipped_at IS NULL
       AND (b.covered_at IS NOT NULL OR bi.status IN ('draft', 'issued'))
     GROUP BY b.advance_allocation_id, b.tenant_id
  ) u ON u.advance_allocation_id = al.id AND u.tenant_id = al.tenant_id

UNION ALL

-- What of an ad-hoc advance is mapped nowhere: its invoice's net, less credit
-- notes at their pre-tax share, less every allocation's effective amount.
SELECT NULL::uuid AS advance_due_id,
       aa.tenant_id,
       i.party_id,
       aa.currency,
       NULL::uuid,
       NULL::uuid,
       i.id, i.number, t.net, t.total,
       coalesce(c.credited, 0),
       t.net - coalesce(c.credited, 0) * t.net / nullif(t.total, 0) - coalesce(m.mapped, 0),
       0::numeric,
       round(t.net - coalesce(c.credited, 0) * t.net / nullif(t.total, 0) - coalesce(m.mapped, 0), 2),
       'unmapped'::text,
       NULL::uuid,
       aa.id,
       NULL::uuid,
       NULL::date,
       i.issued_on
  FROM crm.adhoc_advance aa
  JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id AND i.status = 'issued'
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT cn.invoice_id, cn.tenant_id, sum(cn.amount) AS credited
      FROM crm.credit_note cn
     GROUP BY cn.invoice_id, cn.tenant_id
  ) c ON c.invoice_id = i.id AND c.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT al.adhoc_advance_id, al.tenant_id, sum(coalesce(al.kept_amount, al.amount)) AS mapped
      FROM crm.advance_allocation al
     GROUP BY al.adhoc_advance_id, al.tenant_id
  ) m ON m.adhoc_advance_id = aa.id AND m.tenant_id = aa.tenant_id;

COMMENT ON VIEW crm.advance_pool IS
  'What is left of each advance on an issued invoice, before tax (0320; 0363 adds `source`): the letter''s own advance bills, each ad-hoc allocation, and what of an ad-hoc advance is still unmapped (never taken by a bill). Derived, never stored.';

-- ── Whose revenue each part of an invoice is (Q045) ─────────────────────────
--
-- One row per invoice and manager, BEFORE tax. An ordinary invoice: its own
-- manager and its whole net, exactly as revenue read it before. An ad-hoc
-- advance invoice: each allocation's effective amount to the allocation's
-- manager (frozen when mapped), the rest to the invoice's own manager. Credit
-- notes are not here: a revenue report takes them off as it always has, by the
-- invoice's own manager, because a credit note on an ad-hoc advance may take
-- only its unmapped part.
CREATE VIEW crm.invoice_manager_share WITH (security_invoker = true) AS
SELECT i.id AS invoice_id, i.tenant_id, i.manager_user_id, t.net AS net_share, 'invoice'::text AS basis
  FROM crm.invoice i
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
 WHERE NOT EXISTS (SELECT 1 FROM crm.adhoc_advance aa WHERE aa.invoice_id = i.id AND aa.tenant_id = i.tenant_id)
UNION ALL
SELECT al.invoice_id, al.tenant_id, al.manager_user_id, sum(coalesce(al.kept_amount, al.amount)), 'allocation'
  FROM crm.advance_allocation al
 GROUP BY al.invoice_id, al.tenant_id, al.manager_user_id
UNION ALL
SELECT i.id, i.tenant_id, i.manager_user_id, t.net - coalesce(m.mapped, 0), 'unmapped'
  FROM crm.adhoc_advance aa
  JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT al.adhoc_advance_id, al.tenant_id, sum(coalesce(al.kept_amount, al.amount)) AS mapped
      FROM crm.advance_allocation al
     GROUP BY al.adhoc_advance_id, al.tenant_id
  ) m ON m.adhoc_advance_id = aa.id AND m.tenant_id = aa.tenant_id;

COMMENT ON VIEW crm.invoice_manager_share IS
  'Whose revenue each part of an invoice is, before tax (0363, Q045): an ordinary invoice to its manager; an ad-hoc advance split by its allocations'' managers, the rest to the invoice''s manager.';

-- ── The monthly reminder's day (Q047) ───────────────────────────────────────

ALTER TABLE tenancy.tenant
  ADD COLUMN advance_unmapped_day smallint NOT NULL DEFAULT 1
    CONSTRAINT tenant_advance_unmapped_day_chk CHECK (advance_unmapped_day BETWEEN 1 AND 28);

COMMENT ON COLUMN tenancy.tenant.advance_unmapped_day IS
  'The day of the month (1-28) the raiser of each advance still to be adjusted, and the admins, are reminded (0363, Q047): from the firm''s daily-email hour, in its zone, once a month.';

-- ── The walls and the grants ────────────────────────────────────────────────

ALTER TABLE crm.adhoc_advance ENABLE ROW LEVEL SECURITY;
CREATE POLICY adhoc_advance_isolation ON crm.adhoc_advance
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.advance_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY advance_allocation_isolation ON crm.advance_allocation
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.engagement_letter_advance ENABLE ROW LEVEL SECURITY;
CREATE POLICY engagement_letter_advance_isolation ON crm.engagement_letter_advance
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only: an advance is raised and stays; an allocation is written and
-- may only be ENDED (the trigger above holds the rest).
GRANT SELECT, INSERT ON crm.adhoc_advance TO bib_app;
GRANT SELECT, INSERT ON crm.advance_allocation TO bib_app;
GRANT UPDATE (ended_at, ended_by_user_id, end_reason, kept_amount) ON crm.advance_allocation TO bib_app;
-- A draft letter's named advances are edited like its other terms; the freeze
-- refuses every change once it is signed.
GRANT SELECT, INSERT, UPDATE, DELETE ON crm.engagement_letter_advance TO bib_app;
GRANT SELECT ON crm.advance_pool TO bib_app;
GRANT SELECT ON crm.invoice_manager_share TO bib_app;

RESET ROLE;
