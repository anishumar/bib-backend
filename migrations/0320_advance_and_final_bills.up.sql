-- 0320 · The advance and the final bill (auto-invoice, phase 2)
--
-- Phase 1 billed recurring work by period. Two kinds of bill were still left to
-- memory, and both are where a CA firm loses money:
--
--   * THE ADVANCE. Until now a letter's advance was a tick ("Record advance")
--     that started the work with no tax invoice and no payment behind it.
--     Ashish (2026-10-01): every advance is a GST tax invoice, and the work
--     starts when it is PAID; a part payment starts it only when an admin says
--     so. One advance for the whole letter, or one per service; a letter has
--     one or the other, never both (the user, 2026-10-01).
--   * THE FINAL BILL of a one-time service (an audit, an incorporation), due
--     when its job is done, for the BALANCE after the advance. A letter-wide
--     advance comes off the letter's earliest bills first, monthly ones
--     included; an advance left over, or a client who leaves early, is given
--     back by a credit note.
--
-- ── A bill due now has a KIND ───────────────────────────────────────────────
--
--   'period'  0318's: one period of recurring work.
--   'advance' the letter's advance (engagement_letter_id, no engagement) or one
--             service's (engagement_letter_id AND engagement_id). Raised on an
--             invoice of its own, which is what makes the advance's money
--             answerable: that invoice's net, less what was credited on it.
--   'final'   a one-time service whose work is done (an engagement, or a
--             one-time fee group once every service in it is done).
--
-- An advance or a final bill is not for a period. Its period columns hold the
-- day it fell due (advance) or the work's span (final), counted as ONE WHOLE
-- DAY of one, so the generated `amount` is the full amount and nothing is
-- pro-rated. Making them nullable would put a null into every reader of
-- 0318's rows for a distinction `kind` already makes.
--
-- ── The advance taken off a bill (FIFO) ─────────────────────────────────────
--
-- `advance_invoice_id` + `advance_applied` (BEFORE tax, as the letter states
-- the advance: the user, 2026-10-01) say how much of which advance invoice a
-- bill was reduced by when it was raised. It counts only while that bill is
-- raised (its invoice not cancelled) or COVERED: a bill the advance paid in
-- full raises no invoice at all (`covered_at`), because a zero invoice would
-- still draw a number from the gapless series. A cancelled invoice gives its
-- advance back with its bills, by derivation, exactly as 0318 reopens them.
--
-- ── When the work started ───────────────────────────────────────────────────
--
-- `released_at` / `released_how` / `released_by_user_id` on an advance bill:
-- paid in full, or an admin approved starting on a part payment.
--
-- ── Giving it back ──────────────────────────────────────────────────────────
--
-- A refund is a credit note on the advance invoice with a new closed reason,
-- `advance_refund`. Its "To refund" list is DERIVED; a firm that keeps an
-- unused advance (a cancellation fee, say) says why on the advance bill
-- (`refund_waived_*`), so the list does not hold it forever.

SET ROLE bib_owner;

-- ── Per-service advance on a letter line ────────────────────────────────────
--
-- Nullable, no default: a letter already signed is untouched (no NOT NULL can
-- be added to a letter line again, CLAUDE.md), and the content hash prints it
-- only where set. Frozen with the letter by the child trigger like every
-- column. A grouped line has no price of its own, so no advance of its own
-- either: a fee group's advance is the letter's.

ALTER TABLE crm.engagement_letter_line
  ADD COLUMN advance_amount numeric(18,4),
  ADD CONSTRAINT el_line_advance_amount_chk CHECK (advance_amount IS NULL OR advance_amount > 0),
  ADD CONSTRAINT el_line_grouped_has_no_advance_chk CHECK (fee_group_id IS NULL OR advance_amount IS NULL);

COMMENT ON COLUMN crm.engagement_letter_line.advance_amount IS
  'This service''s own advance, before tax (0320). NULL = none. A letter has a letter-wide advance (engagement_letter.advance_required) or per-service ones, never both.';

-- One or the other, as a wall: the service refuses first with a sentence, and
-- these refuse the writers that are not the service. Named to sort after the
-- freeze triggers on both tables, because a change to a signed letter must be
-- refused as that.
CREATE FUNCTION crm.refuse_line_advance_beside_letter_advance() RETURNS trigger AS $$
BEGIN
  IF NEW.advance_amount IS NOT NULL AND EXISTS (
       SELECT 1 FROM crm.engagement_letter l
        WHERE l.id = NEW.engagement_letter_id AND l.advance_required) THEN
    RAISE EXCEPTION
      'engagement letter % already asks for one advance for the whole letter; a service cannot have its own as well.',
      NEW.engagement_letter_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_line_z_one_kind_of_advance
  BEFORE INSERT OR UPDATE OF advance_amount ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_line_advance_beside_letter_advance();

CREATE FUNCTION crm.refuse_letter_advance_beside_line_advance() RETURNS trigger AS $$
BEGIN
  IF NEW.advance_required AND NOT OLD.advance_required AND EXISTS (
       SELECT 1 FROM crm.engagement_letter_line ll
        WHERE ll.engagement_letter_id = NEW.id AND ll.advance_amount IS NOT NULL
          AND ll.removed_at IS NULL) THEN
    RAISE EXCEPTION
      'engagement letter % has services with their own advance; it cannot also ask for one for the whole letter.',
      NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_z_one_kind_of_advance
  BEFORE UPDATE OF advance_required ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_letter_advance_beside_line_advance();

-- ── The kinds of bill ───────────────────────────────────────────────────────

ALTER TABLE crm.billing_due
  ADD COLUMN kind text NOT NULL DEFAULT 'period'
    CONSTRAINT billing_due_kind_chk CHECK (kind IN ('period', 'advance', 'final')),
  ADD COLUMN engagement_letter_id      uuid,
  ADD COLUMN advance_invoice_id        uuid,
  ADD COLUMN advance_applied           numeric(18,4),
  ADD COLUMN covered_at                timestamptz,
  ADD COLUMN released_at               timestamptz,
  ADD COLUMN released_how              text,
  ADD COLUMN released_by_user_id       uuid REFERENCES tenancy.user_account (id),
  ADD COLUMN refund_waived_at          timestamptz,
  ADD COLUMN refund_waived_by_user_id  uuid REFERENCES tenancy.user_account (id),
  ADD COLUMN refund_waive_reason       text;

ALTER TABLE crm.billing_due DROP CONSTRAINT billing_due_one_subject_chk;
ALTER TABLE crm.billing_due
  -- What is billed. An advance names its letter, and the one service it is
  -- for when it is per service; a period or final bill names an engagement or
  -- a fee group, never both, exactly as 0318.
  ADD CONSTRAINT billing_due_one_subject_chk CHECK (
    CASE kind
      WHEN 'advance' THEN engagement_letter_id IS NOT NULL AND fee_group_id IS NULL
      ELSE engagement_letter_id IS NULL AND (engagement_id IS NULL) <> (fee_group_id IS NULL)
    END
  ),
  -- The letter's currency, by key: an advance is billed in what it was agreed in.
  ADD CONSTRAINT billing_due_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency),
  -- And the advance taken off a bill is from an invoice in the bill's currency.
  ADD CONSTRAINT billing_due_advance_invoice_fkey
    FOREIGN KEY (advance_invoice_id, tenant_id, currency)
    REFERENCES crm.invoice (id, tenant_id, currency),
  ADD CONSTRAINT billing_due_advance_applied_chk CHECK (
    (advance_invoice_id IS NULL) = (advance_applied IS NULL)
    AND (advance_applied IS NULL OR advance_applied > 0)
    AND (advance_applied IS NULL OR kind <> 'advance')
  ),
  -- Covered in full by the advance: no invoice, and the advance says by which.
  ADD CONSTRAINT billing_due_covered_chk CHECK (
    covered_at IS NULL OR (advance_invoice_id IS NOT NULL AND invoice_id IS NULL)
  ),
  ADD CONSTRAINT billing_due_released_chk CHECK (
    (released_at IS NULL) = (released_how IS NULL)
    AND (released_at IS NULL OR kind = 'advance')
    AND (released_how IS NULL OR released_how IN ('paid', 'approved'))
    AND (released_how IS DISTINCT FROM 'approved' OR released_by_user_id IS NOT NULL)
    AND (released_by_user_id IS NULL OR released_at IS NOT NULL)
  ),
  ADD CONSTRAINT billing_due_refund_waived_chk CHECK (
    (refund_waived_at IS NULL) = (refund_waive_reason IS NULL)
    AND (refund_waived_at IS NULL) = (refund_waived_by_user_id IS NULL)
    AND (refund_waived_at IS NULL OR kind = 'advance')
    AND (refund_waive_reason IS NULL OR (btrim(refund_waive_reason) <> '' AND length(refund_waive_reason) <= 500))
  );

-- One bill per subject and kind. 0318's two indexes become the PERIOD kind's.
DROP INDEX crm.billing_due_engagement_period;
DROP INDEX crm.billing_due_fee_group_period;
CREATE UNIQUE INDEX billing_due_engagement_period
  ON crm.billing_due (tenant_id, engagement_id, period_start)
  WHERE kind = 'period' AND engagement_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_fee_group_period
  ON crm.billing_due (tenant_id, fee_group_id, period_start)
  WHERE kind = 'period' AND fee_group_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_letter_advance
  ON crm.billing_due (tenant_id, engagement_letter_id)
  WHERE kind = 'advance' AND engagement_id IS NULL;
CREATE UNIQUE INDEX billing_due_engagement_advance
  ON crm.billing_due (tenant_id, engagement_id)
  WHERE kind = 'advance' AND engagement_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_engagement_final
  ON crm.billing_due (tenant_id, engagement_id)
  WHERE kind = 'final' AND engagement_id IS NOT NULL;
CREATE UNIQUE INDEX billing_due_fee_group_final
  ON crm.billing_due (tenant_id, fee_group_id)
  WHERE kind = 'final' AND fee_group_id IS NOT NULL;
CREATE INDEX idx_billing_due_advance_invoice
  ON crm.billing_due (tenant_id, advance_invoice_id) WHERE advance_invoice_id IS NOT NULL;

-- What a person may change: how a bill was settled, never what was owed.
GRANT UPDATE (advance_invoice_id, advance_applied, covered_at,
              released_at, released_how, released_by_user_id,
              refund_waived_at, refund_waived_by_user_id, refund_waive_reason)
  ON crm.billing_due TO bib_app;

COMMENT ON COLUMN crm.billing_due.kind IS
  'period (0318: one period of recurring work), advance (the letter''s, or one service''s), or final (a one-time service whose work is done) (0320).';
COMMENT ON COLUMN crm.billing_due.advance_applied IS
  'How much of advance_invoice_id (before tax) this bill was reduced by when raised (0320). Counts while the bill is raised or covered.';
COMMENT ON COLUMN crm.billing_due.covered_at IS
  'The advance paid this bill in full, so no invoice was raised (0320).';
COMMENT ON COLUMN crm.billing_due.released_at IS
  'An advance bill: when the work it held back started (0320), because its invoice was paid in full or an admin approved a part payment (released_how).';

-- ── What is left of each advance ────────────────────────────────────────────
--
-- One row per advance bill on an ISSUED invoice: the advance's money before
-- tax (its own line's net when raised from the bill, else the bill, never more
-- than the invoice's net), less what credit notes took off it at their pre-tax
-- share (`amount × net / total`, as revenue by company reads a credit note),
-- less what bills have taken from it (counted while raised or covered).
-- DERIVED, never stored, for the reason `invoice_balance` gives: a stored
-- "left" drifts the first time an invoice is cancelled. security_invoker, so
-- the tenant wall still applies.
CREATE VIEW crm.advance_pool WITH (security_invoker = true) AS
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
         - coalesce(u.applied, 0), 2) AS remaining
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
       AND b.skipped_at IS NULL
       AND (b.covered_at IS NOT NULL OR bi.status IN ('draft', 'issued'))
     GROUP BY b.advance_invoice_id, b.tenant_id
  ) u ON u.advance_invoice_id = i.id AND u.tenant_id = i.tenant_id
 WHERE a.kind = 'advance';

GRANT SELECT ON crm.advance_pool TO bib_app;

COMMENT ON VIEW crm.advance_pool IS
  'What is left of each advance on an issued invoice, before tax: its money, less credit notes at their pre-tax share, less what bills have taken from it (0320). Derived, never stored.';

-- ── The refund's own reason ─────────────────────────────────────────────────

ALTER TABLE crm.credit_note DROP CONSTRAINT credit_note_reason_check;
ALTER TABLE crm.credit_note
  ADD CONSTRAINT credit_note_reason_check
    CHECK (reason IN ('service_failure', 'billing_error', 'goodwill',
                      'scope_change', 'duplicate_invoice', 'bad_debt',
                      'advance_refund'));

RESET ROLE;
