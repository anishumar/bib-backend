-- 0011 · C3 proposals (T2.2) — the first money in this schema
--
-- A proposal is a DOCUMENT ABOUT A PARTY, built from catalogue rows, quoted in
-- one currency. Two decisions shape everything below, both settled on the board
-- before any of it was written:
--
-- 1. THE CATALOGUE ROW IS PINNED; THE QUOTED MONEY IS THE PROPOSAL'S. A line
--    holds `service_version_id` — the frozen config.version it was quoted from
--    (0005) — plus the amount actually asked for. The alternative, versioning a
--    priced line in the registry, collapses on one example: a negotiated
--    discount for one client would mean publishing a config version per client,
--    and the discount would end up on the proposal anyway.
--
--    What the pin buys is the most useful commercial fact in the object.
--    Reopening a proposal sent nine months ago answers BOTH halves — what our
--    list price was then, and what we actually charged — because the archived
--    version still resolves and still carries its listPrice.
--
-- 2. ONE PROPOSAL, ONE CURRENCY, ONE RATE. "Per-country quoting" means quoting
--    an Abu Dhabi client in AED while the firm's books read in INR (0009). The
--    rate is struck ONCE, when the proposal is drafted, and lives on the
--    proposal: a document whose lines each converted at their own rate would
--    have a total that depends on the order somebody added them. The lines are
--    held to the proposal's currency by a composite foreign key rather than by
--    a rule in the application, so a line in another currency is unrepresentable
--    rather than merely unlikely.
--
--    The rate is stored even when the currencies match (1.0, dated), so "did we
--    convert this?" is never inferred from a null.
--
-- Money is `numeric`, never float, everywhere here. There is no stored total:
-- it is derived from the lines, because a stored copy eventually disagrees with
-- the rows it claims to sum and nothing says which is right.
--
-- There is no timeline table. The timeline IS the ledger — drafting, sending,
-- approving a discount and the decision all write events against the proposal's
-- id, so GET /api/v1/objects/proposal/{id}/events is the history.

SET ROLE bib_owner;

-- Composite-key targets, the shape 0006 established. Each is redundant with a
-- primary key on id alone, which is exactly why adding it is safe: it
-- constrains no data, it only gives a foreign key something to point at that
-- carries the tenant with it. Foreign-key checks run as a system operation RLS
-- does not filter, so without these one firm's proposal could hang off another
-- firm's lead or pin another firm's catalogue version.
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE config.version
  ADD CONSTRAINT version_id_tenant_key UNIQUE (id, tenant_id);

-- ── proposal ── what the firm offered, to whom, in what money.
CREATE TABLE crm.proposal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- Who it is for. A party, like everything with a counterparty in this
  -- product — never a name typed onto a document.
  party_id    uuid NOT NULL,

  -- The opportunity it came out of, when there is one. NULLABLE on purpose: a
  -- firm quoting an existing client for more work has no lead, and inventing
  -- one to satisfy a column would put rows in the pipeline that nobody is
  -- working.
  lead_id     uuid,

  title       text NOT NULL CHECK (btrim(title) <> ''),

  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),

  -- THE QUOTE CURRENCY, and the rate back to the firm's reporting currency
  -- (tenancy.tenant.reporting_currency, 0009). Struck once, here, for the whole
  -- document — see the note at the top.
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fx_rate      numeric(20,10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date date NOT NULL,

  -- When the offer lapses. A DATE, not a timestamp: "valid until 30 September"
  -- is a day in the client's calendar, and midnight UTC is somebody else's
  -- evening. Nullable — an open-ended quote is a real thing.
  valid_until  date,

  sent_at      timestamptz,
  decided_at   timestamptz,

  -- A discount past the firm's published policy needs somebody to say so, and
  -- WHO said so is the whole value of the record. Both columns or neither: an
  -- approval with no approver is an audit trail that answers nothing.
  discount_approved_by uuid REFERENCES tenancy.user_account(id),
  discount_approved_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- The status and its dates, kept in step. A proposal that claims to be sent
  -- with no sent_at makes "how long do quotes take to close" unanswerable, and
  -- nobody notices the gap until they ask.
  CONSTRAINT proposal_sent_when_left_draft_chk CHECK (
    (status = 'draft' AND sent_at IS NULL) OR
    (status <> 'draft' AND sent_at IS NOT NULL)
  ),
  CONSTRAINT proposal_decided_when_closed_chk CHECK (
    (status IN ('accepted', 'rejected', 'expired') AND decided_at IS NOT NULL) OR
    (status IN ('draft', 'sent')                   AND decided_at IS NULL)
  ),
  CONSTRAINT proposal_approval_is_whole_chk CHECK (
    (discount_approved_by IS NULL     AND discount_approved_at IS NULL) OR
    (discount_approved_by IS NOT NULL AND discount_approved_at IS NOT NULL)
  ),

  -- The tenant travels with every reference.
  CONSTRAINT proposal_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT proposal_lead_tenant_fkey
    FOREIGN KEY (lead_id, tenant_id) REFERENCES crm.lead (id, tenant_id),

  -- What the lines point back at: the proposal, its tenant AND its currency, in
  -- one key. That is what makes a line in a different currency from its own
  -- proposal impossible to write rather than merely wrong.
  CONSTRAINT proposal_id_tenant_currency_key UNIQUE (id, tenant_id, currency)
);
CREATE TRIGGER trg_proposal_updated_at BEFORE UPDATE ON crm.proposal
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── proposal_line ── one thing offered, at one price.
CREATE TABLE crm.proposal_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  proposal_id uuid NOT NULL,

  -- THE PIN. The frozen catalogue version this line was quoted from, so the
  -- list price at the time survives the catalogue moving on. NOT NULL: a
  -- proposal is "catalogue-built" (T2.2), and a free-text line with no service
  -- behind it is how a catalogue stops describing what the firm sells.
  service_version_id uuid NOT NULL,

  -- What the document SAYS on this line. Written down rather than read through
  -- the pin every time it is displayed, because the two answer different
  -- questions: the pin answers "what did we sell", this answers "what did the
  -- client read". A firm routinely tailors the wording per proposal.
  description text NOT NULL CHECK (btrim(description) <> ''),

  -- Where it sits on the page. Explicit, because a document's line order is
  -- meaningful and "whatever the query returned" is not an order.
  position    integer NOT NULL CHECK (position > 0),

  quantity    numeric(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- The price asked, per unit of the service's billing basis. `currency` is
  -- carried on the line so that an amount and what it is denominated in are
  -- never separated — and is then held equal to the proposal's by the composite
  -- key below, so the redundancy cannot become a disagreement.
  unit_amount numeric(18,4) NOT NULL CHECK (unit_amount >= 0),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  discount_percent numeric(5,2) NOT NULL DEFAULT 0
                   CHECK (discount_percent >= 0 AND discount_percent <= 100),

  -- SOFT DELETE (CLAUDE.md). A line pulled from a draft is still something the
  -- firm considered offering, and on a sent proposal it is something the client
  -- may have read. Reads filter on this; nothing removes the row.
  removed_at  timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Tenant, and currency, and the proposal, in one reference.
  CONSTRAINT proposal_line_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id, currency)
    REFERENCES crm.proposal (id, tenant_id, currency),
  CONSTRAINT proposal_line_service_version_tenant_fkey
    FOREIGN KEY (service_version_id, tenant_id) REFERENCES config.version (id, tenant_id)
);
CREATE TRIGGER trg_proposal_line_updated_at BEFORE UPDATE ON crm.proposal_line
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- UNIQUE SCOPE: one line per position, per proposal — and PARTIAL, so a removed
-- line does not hold its slot against the line that replaced it. Two lines at
-- position 3 is a document that renders differently each time it is read.
CREATE UNIQUE INDEX proposal_line_one_per_position
  ON crm.proposal_line (proposal_id, position) WHERE removed_at IS NULL;

-- The reads this exists for: a proposal's lines in document order, and "what
-- have we quoted this client". Tenant-first, because RLS filters on that.
CREATE INDEX idx_proposal_line_proposal ON crm.proposal_line (proposal_id, position);
CREATE INDEX idx_proposal_tenant_status ON crm.proposal (tenant_id, status, created_at DESC);
CREATE INDEX idx_proposal_tenant_party  ON crm.proposal (tenant_id, party_id, created_at DESC);

-- THE TENANT WALL, identical in shape to 0001/0002/0003/0005/0007.
ALTER TABLE crm.proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_isolation ON crm.proposal
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.proposal_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_line_isolation ON crm.proposal_line
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- Grants. No DELETE on either table: a proposal that went nowhere is
-- `rejected`, and a line pulled from one is `removed_at`. What the firm offered
-- and withdrew is the record.
GRANT SELECT, INSERT, UPDATE ON crm.proposal      TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.proposal_line TO bib_app;
