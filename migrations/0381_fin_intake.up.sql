-- 0381 · FinCompliance starts: the per-firm switch, the `fin` schema, and the
--         intake item (docs/FIN_BUILD_PLAN.md F0.4, F2.1).
--
-- ── WHAT FIN IS, AND WHY IT HAS ITS OWN SCHEMA ──────────────────────────────
--
-- FinCompliance reads the files clients send (invoices, statements, payroll),
-- turns them into the firm's books and flags what looks wrong. It runs as its
-- own process (`cmd/fin-once.ts`, a Cloud Run Job every ten minutes) so that
-- a fin failure can never stop the CRM: nothing in core imports fin
-- (`.dependency-cruiser.cjs`, `core-never-imports-fin`), and every fin table
-- lives here, in `fin`, with foreign keys pointing INTO core and never out.
--
-- ── THE SWITCH: tenancy.tenant.fin_enabled_since ────────────────────────────
--
-- NULL is off, and every firm starts off, so applying this changed no firm's
-- behaviour. A timestamp rather than a boolean because the instant is also
-- the CUT: fin takes the files stored FROM that moment, never a firm's years
-- of earlier uploads, which were filed by hand and are already in its books.
-- It is set by the platform, not by a firm's own screen — the pilot is one
-- test firm — and there is deliberately no UPDATE grant for `bib_app`.
--
-- ── fin.intake_item: one row per stored file fin has picked up ──────────────
--
-- The fin job finds document versions stored since the switch that have no
-- intake item yet (an anti-join, the delivery engine's own idiom) and writes
-- one. `UNIQUE (tenant_id, document_version_id)` makes a second run, a crash
-- mid-run or two overlapping runs harmless: the insert conflicts and the event
-- is written only for rows actually created.
--
-- It reads `files.document_version` rather than replaying `document.stored`
-- payloads: the same at-least-once property, without parsing a version number
-- out of jsonb, and the filestore still knows nothing about fin.
--
-- `route` is which reader the file goes to. `manual` is a real outcome, not
-- a failure: a file fin cannot read lands on a person's desk as "not read",
-- and is never discarded (T4.7's acceptance line).

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  ADD COLUMN fin_enabled_since timestamptz;

COMMENT ON COLUMN tenancy.tenant.fin_enabled_since IS
  'When FinCompliance was switched on for this firm (0381). NULL = off. Fin reads only files stored from this instant.';

RESET ROLE;

CREATE SCHEMA IF NOT EXISTS fin AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA fin FROM PUBLIC;

SET ROLE bib_owner;

CREATE TABLE fin.intake_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant (id),
  document_version_id  uuid NOT NULL,
  -- Whose file, copied from `files.document.party_id` at intake. Nullable for
  -- the same reason it is there: a file stored against no client is still a
  -- file somebody has to look at.
  client_party_id      uuid,
  -- Copied, not joined, because they are what the route was decided FROM, and
  -- the decision has to stay explainable if the version row is ever read
  -- differently.
  media_type           text NOT NULL CHECK (length(btrim(media_type)) > 0),
  byte_size            bigint NOT NULL CHECK (byte_size > 0),
  route                text NOT NULL CHECK (route IN ('sheet', 'pdf', 'image', 'archive', 'manual')),
  -- What decided the route: the declared media type, the filename's extension
  -- when the media type said nothing useful, or neither (route = manual).
  route_basis          text NOT NULL CHECK (route_basis IN ('media_type', 'extension', 'none')),
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intake_item_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT intake_item_once UNIQUE (tenant_id, document_version_id),
  CONSTRAINT intake_item_manual_has_no_basis CHECK ((route = 'manual') = (route_basis = 'none')),
  FOREIGN KEY (document_version_id, tenant_id) REFERENCES files.document_version (id, tenant_id),
  FOREIGN KEY (client_party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

CREATE INDEX idx_intake_item_recent
  ON fin.intake_item (tenant_id, created_at DESC, id DESC);

ALTER TABLE fin.intake_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_item_isolation ON fin.intake_item
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT USAGE ON SCHEMA fin TO bib_app;
-- Append-only by grant: an intake item records that fin picked a file up and
-- where it sent it. Later stages write their own rows; none rewrites this one.
GRANT SELECT, INSERT ON fin.intake_item TO bib_app;

RESET ROLE;
