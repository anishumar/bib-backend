# build2 — the demo vs the rebuild

A field-level comparison of the **demo CRM that the client approved** against the
**rebuilt backend + frontend**, and the list of what the new structure still has to grow
before it can do what the demo did.

| | Path | What it is |
|---|---|---|
| **Old** | `Desktop/10xcrm` | Next.js monolith, Drizzle, 24 migrations, **56 tables**. The demo shown to the client. |
| **New** | `Desktop/ANISH10XCRM/bib-backend` | Node + TypeScript + Hono, hexagonal, 17 SQL migrations, **26 tables/views**. |
| **New** | `Desktop/ANISH10XCRM/bib-frontend` | Next.js 16, typed client generated from `/openapi.json`. |

The two `bib-*` repos are `github.com/anishumar/bib-frontend` and `bib-backend` at
`main`; `10xcrm` is the pre-rebuild demo, which is not on GitHub.

**Checking any claim here.** Every "missing" below means *absent from the new schema at the
commit above*, and each is checkable in one command:

```bash
# the new schema, authoritatively — every table and column
psql -d bib -Atc "select t||': '||cols from (
  select table_schema||'.'||table_name t,
         string_agg(column_name, ', ' order by ordinal_position) cols
  from information_schema.columns
  where table_schema in ('tenancy','core','crm','config','ledger')
  group by 1,2) s order by t;"

# the old schema, for the same table
sed -n '/export const deal =/,/^);/p' 10xcrm/src/db/schema/deal.ts
```

Field rationale in quotes ("jahan ka client hota hai…", "Per Company", "Manager or above")
is the firm's own wording, carried over from the old schema's comments — those files are
the source, not this document.

> **One correction to the brief.** `Desktop/10xglobal` is the *marketing website* for the
> client (routes: `our-firm`, `geographies`, `managed-services`, `deals-transactions`) plus
> the proposal HTML/PDF. It contains no CRM. The demo product is `Desktop/10xcrm`, and that
> is what everything below is compared against.

---

## 1. The verdict, up front

**The rebuild is a better system that currently does less.** The architecture is a
straight upgrade — the tenant wall is now enforced by Postgres rather than by discipline,
the domain is testable, and the API is a real contract. But the demo the client approved
covered **twelve modules**; the rebuild has finished **four**.

The important finding is *where* the gap sits. It is **not** in the client and people
records — those were ported across almost column-for-column. It is concentrated in:

1. **The document layer.** The old proposal/engagement letter carried ~20 fields the new one
   does not: the issuing entity, the reference number, the background prose, per-line scope
   overrides, out-of-pocket estimates, effective dates, and the standard prose blocks. The
   new document is commercially rigorous (FX, pinned catalogue, discount approval) but
   **cannot yet print the letter the firm actually sends.**
2. **The entity dimension on delivery.** The old model made an engagement `service × one
   legal entity` — the firm's own confirmed "Per Company" rule. The new engagement hangs off
   the client party instead. See §5.1; this is the one finding I would fix before anything else.
3. **Eight modules not yet built** — work, billing, obligations, documents, intake/AI,
   notifications, brand, calendar. Most are scheduled in `bib-backend/docs/BUILD-PLAN.md`.
   A handful are not scheduled anywhere (§6).

---

## 2. Architecture: side by side

| | Old (`10xcrm`) | New (`bib-*`) |
|---|---|---|
| **Shape** | One Next.js app. UI and data in one process. | Two repos: API service + browser app. |
| **How the UI gets data** | **Server actions** — 15 `"use server"` files called directly from components. 1 HTTP route in the whole app. | **56 HTTP endpoints** with an OpenAPI spec; the frontend's types are *generated* from it (`npm run api:generate`). |
| **Tenant isolation** | RLS in `policies.sql`, applied by convention. | RLS on every tenant table, app role is `NOBYPASSRLS`, and **the server refuses to boot if the wall is down**. |
| **Layering** | Convention, plus a `server-only` import guard. | **Enforced.** dependency-cruiser + typed ESLint make a layering violation a build error; the arch check runs as a test. |
| **Schema** | Drizzle TS, 24 generated migrations. | Hand-written SQL, immutable, fix-forward. CHECK constraints carry rules the app used to. |
| **Cross-tenant FK safety** | Plain foreign keys. | **Composite `(id, tenant_id)` foreign keys** — one firm's proposal cannot reference another firm's lead, even though FK checks bypass RLS. |
| **Money** | `numeric` on the line. | `numeric` + **one currency and one FX rate per document**, held by a composite key so a mixed-currency line is unrepresentable. |
| **Totals** | Stored columns on `invoice` (`subtotal`, `total`). | **Views** (`proposal_totals`, `proposal_line_amount`) — derived, so they cannot drift. |
| **Audit** | `event` table, append-only by grant. | `ledger.event` — append-only by grant **and** by trigger, closed verb registry (38 verbs), PII refused at the port. |
| **Config** | A lookup table per concern (`work_item_state`, `dunning_step`, `confidence_tier`…). | One versioned registry: `config.entry` + `config.version`, published versions **frozen by trigger**, documents pin the version they used. |
| **Tests** | 29 files. | **373 tests**, including live-Postgres RLS proofs. |
| **Background work** | `pg-boss` worker (`npm run worker`). | Not yet built — the scheduler is Phase 2, lane B. |
| **PDF / mail / storage** | `pdfkit`, `nodemailer`, `@aws-sdk/client-s3` — all wired. | Mail is a `log` transport; **no PDF renderer and no storage adapter yet**. |

**Net:** the new system is meaningfully harder to get wrong. Roughly thirty of the old
system's rules lived in application code or in a form; in the new one they are CHECK
constraints, triggers and composite keys. That is the right trade — it just has not been
paid for across the whole surface yet.

---

## 3. Module coverage: 56 tables → 26

| Module | Old tables | New | Status |
|---|---|---|---|
| Tenancy / identity | `tenant`, `user_account`, `membership`, `session`, `credential_token`, `staff_grade` | `tenancy.*` (6) | ✅ Built — **minus `staff_grade`** |
| Party / client / people | `party`, `organization`, `person`, `legal_entity`, `party_identifier`, `relationship_type`, `party_relationship` | `core.*` (7) | ✅ **Ported 1:1** |
| Audit | `event` | `ledger.event` | ✅ Built, stronger |
| Catalogue | `service`, `service_module`, `service_group`, `fee_schedule` | `config.entry` + `config.version` (`kind='service'`) | ⚠️ Built, **most fields dropped** (§4.8) |
| Deals / pipeline | `deal` | `crm.lead` | ⚠️ Built, fields missing (§4.4) |
| Proposals & ELs | `deal_document`, `deal_document_line`, `deal_document_block`, `standard_document_block` | `crm.proposal*`, `crm.engagement_letter*` | ⚠️ Built, **~20 fields missing** (§4.5, §4.6) |
| Clauses / governing law | `clause_set`, `clause`, `firm_entity_preference` | `config` `kind='clause'` + `engagement_letter_clause` | ⚠️ Partial — **no governing law, no issuing-entity rule** |
| Engagements | `engagement`, `client_assignment` | `crm.engagement` | ⚠️ Built, **wrong grain** (§5.1); **no assignment at all** |
| Work / tasks | `work_item`, `work_item_state`, `work_item_priority`, `checklist_item`, `work_item_dependency`, `approval` | — | 📋 Planned T3.1 |
| Compliance calendar | `obligation_template`, `obligation_instance`, `obligation_state`, `obligation_template_exception` | — | 📋 Planned T3.2 / T3.3 |
| Billing | `invoice`, `invoice_line`, `invoice_series`, `invoice_state`, `payment`, `credit_note`, `dunning_step` | — | 📋 Planned T3.4 / T3.5 |
| Documents / files | `document`, `document_version`, `document_type`, `document_link` | — | 📋 Planned T3.6 |
| Intake / AI | `communication`, `agent_run`, `agent_action`, `confidence_tier`, `routing_rule` | — | 📋 Planned Phase 4 |
| Notifications | `notification` | — | ❌ **Not in the plan** |
| Brand assets | `brand_asset` | — | ❌ **Not in the plan** |

Legend: ✅ done · ⚠️ built but incomplete · 📋 scheduled in BUILD-PLAN.md · ❌ not scheduled anywhere

**Screens.** Old: `clients`, `people`, `deals` (+ document builder), `work`, `invoices`,
`calendar` (+ rules), `services`, `setup` (entities / grades / dunning).
New: `clients`, `leads`, `proposals`, `engagement-letters`, `catalogue`, `audit`,
`admin/people`, `admin/roles`, `p/[token]` (client-facing share link).

---

## 4. The field list — what to add

Only genuine gaps are listed. Where the new schema already matches, it says so.

### 4.1 Client — `core.organization` + `core.legal_entity`

**Good news: these are a 1:1 port.** `legal_name`, `trade_name`, `industry`, `website`,
`is_firm_self`, `jurisdiction`, `entity_type`, `incorporated_on`, `financial_year_end`,
`registered_address`, `status` — all present, same types, same partial unique index on
`is_firm_self`. Identifiers (PAN / GSTIN-per-state / CIN / TRN / UEN / EIN) and the
effective-dated relationship table came across whole.

Three things are missing:

| Field | Type | Why it is needed |
|---|---|---|
| `deleted_at` | `timestamptz` | **On every `core` table.** `CLAUDE.md` says "soft delete only", but no core table has the column and no `DELETE` endpoint exists. A client created by mistake today cannot be removed *or* archived. |
| `onboarded_on` / lifecycle | `date` / `text` | The old model tracked a client through `party_relationship('client_of')` dates. That works, but there is no direct "is this an active client, a prospect, or a former client" answer without walking relationships. A view may be the right shape rather than a column. |
| `firm_entity_preference` | table | Which of the firm's own entities serves a client in a given country — see §4.7. |

### 4.2 Client ownership — `client_assignment` (**entire table missing**)

This is the biggest *client-level* gap, and it is confirmed firm practice rather than a
guess: *"each client will de facto have two SPOCs — one from TRC and one from FRC."*

```sql
CREATE TABLE crm.client_assignment (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  client_party_id uuid NOT NULL,          -- composite FK to core.party (id, tenant_id)
  role            text NOT NULL CHECK (role IN ('key_manager','spoc')),
  module_id       uuid,                   -- the Dept for a SPOC; NULL for key_manager
  user_id         uuid NOT NULL REFERENCES tenancy.user_account(id),
  valid_from      date NOT NULL,          -- effective-dated: "who was SPOC when this went wrong"
  valid_to        date
);
```

Two roles at two levels: **Key Manager** — one per client, owns pricing, renewals and
escalation. **SPOC** — one per client *per Dept*, which is why it is a row rather than two
fixed columns (a client buying RAA work as well has three).

Without it: no "my clients" screen, no routing target for intake, and T3.1's own acceptance
criterion — *"a filing arrives pre-assigned to the client's Dept SPOC"* — has nothing to read.

### 4.3 People — `core.person`

**Also a 1:1 port**: `full_name`, `nationality`, `date_of_birth`, plus identifiers
(passport, email, phone) and effective-dated `director_of` / `employee_of` /
`shareholder_of` relationships with `attributes` for shareholding percentage, share class
and DIN. Nothing is missing at the person level.

The gap is on the **staff** side:

| Field / table | Why |
|---|---|
| `staff_grade` (`code`, `name`, `rank`, `is_active`) | The firm's nine grades, Article → Associate Director. `rank` exists because the routing rule is a single comparison: *"Manager or above is fine."* Absent from the new schema **and** from the build plan. |
| `membership.grade_id` | Seniority is a separate axis from role. A `member` can be an Article or a Senior Manager; the role says what they may reach, the grade says how senior they are. |
| `membership.party_id` | **The link from a login to the person in the org chart.** Without it, "escalate to this assignee's manager" is unanswerable even with the chart loaded. It belongs on `membership`, not `user_account`, because `party` is tenant-scoped and `user_account` deliberately is not. BUILD-PLAN calls this "Gate 4 (record-scope)" and defers it to U1. |

### 4.4 Deals — `crm.lead`

The new `lead` is cleaner in two ways (a closed `source` enum; stage dates enforced by
CHECK) and thinner in four:

| Old `deal` field | New `lead` | Add |
|---|---|---|
| `title` | ❌ **absent** | A lead has no name. Lists must render the party name instead, and two opportunities with the same client are indistinguishable. **Add `title text NOT NULL`.** |
| `lost_reason` | ❌ absent (only free `notes`) | The capture-or-lose column. *Why* it was lost is obvious the day it closes and written down nowhere. Without it, "what fee actually closes deals like this" has no `GROUP BY`. Deliberately free text: a dropdown of five reasons produces five reasons, and the useful one is always the sixth. |
| `status = 'abandoned'` | ❌ collapsed into `lost` | A client who went quiet is not a client who chose a competitor. Collapsing them destroys the only signal separating a **pricing** problem from a **follow-up** problem. **Add `abandoned` to the stage CHECK.** |
| `opened_on` / `closed_on` (`date`) | `captured_at` / `closed_at` (`timestamptz`) | Equivalent — no action. |
| — | `notes` ✅ | New. Keep. |
| *(in neither)* | | `expected_value` + `currency`, and `expected_close_on`. Neither system can forecast a pipeline. Cheap to add while the table is young. |

Also worth a decision: `lead_one_open_per_party` permits **one open lead per party**, so a
firm quoting an existing client for a second, unrelated service cannot open a second lead.
Confirm that is intended.

### 4.5 Proposal & engagement letter — the head

The new document head is stronger commercially (`currency` + `fx_rate` + `fx_rate_date`
struck once for the whole document, `discount_approved_by/at`, `signed_content_hash`,
share links with `view_count`) and much weaker as a *document*:

| Field | Type | Why |
|---|---|---|
| `ref` | `text`, unique per tenant | The human-facing number — `EL-US-2026-0007`. **Neither document has one.** This is what a client quotes back on the phone and what an audit cites. |
| `issuing_entity_party_id` | `uuid` → `core.party` | **Which of the firm's own entities issues this.** Confirmed rule: *"jahan ka client hota hai, wahan ki entity"*, with a stated fallback where the firm has no entity there. The EL carries a bare `jurisdiction text` instead, which cannot name *who* is contracting. Stored rather than derived: it is a snapshot, and a letter must always say who actually issued it, even after the client's default changes. |
| `background` | `text` | The BACKGROUND paragraph — why this client is buying this, in prose. Every real letter opens with one. |
| `addressed_to_party_id` | `uuid` → `core.party` | The addressee: a named person, care-of the client organization, as the real EL does. The API exposes a computed `addressedTo` **string** (the party's display name), so the document cannot address an individual. |
| `supersedes_id` | `uuid` | Document lineage. `engagement_letter.proposal_id` covers proposal → EL; letter → letter is absent. The model explicitly forbids editing a signed letter ("supersede it with a new letter instead") without giving it anywhere to record that it did. |
| `firm_signatory_user_id`, `firm_signatory_title`, `firm_signed_at` | | **The firm's own signature block.** A real letter carries two signatures: the client's acceptance *and* "Yours sincerely, …, Director". Only the client's is modelled, so the firm's block renders as a blank line and nothing records who committed the firm. Authority to bind is an audit question, not a decoration. |
| `signed_by_title` | `text` | The new schema keeps `signed_by_name` but drops the capacity the client signed in. |
| `effective_from` | `date` | **When the engagements this letter opens actually begin — which is not when it was signed.** Without it, a letter agreeing that the outgoing accountant finishes August cannot be written down at all: signing sets everything live immediately and the firm is issued filings for work it has not taken on. Null falls back to the signature date, which is the ordinary case. |
| `issued_on` | `date` | The document's own date, distinct from `sent_at`. |
| `declined_reason` | `text` | `proposal.status = 'rejected'` records *that* it was, never *why*. |
| clause set pinning | | Partly covered: `engagement_letter_clause` pins a `clause_version_id` per clause, which is good. But there is no *set*, so no per-jurisdiction governing law — see §4.7. |

### 4.6 Document lines — `proposal_line` / `engagement_letter_line`

Both new line tables are identical and carry seven meaningful columns. The old line carried
seventeen.

| Field | Type | Why |
|---|---|---|
| **`entity_party_id`** | `uuid` | **The fan-out key, and the most important missing column in the schema.** Each line names the service *and* the client entity it is for, so on signature each line becomes exactly one engagement = service × one legal entity. Nullable for a *proposal* (a prospect may hold no entities, and an Incorporation line's entity is that line's own *output*); required on an *EL* via CHECK. See §5.1. |
| `jurisdiction` | `text` | Where the work is, when no entity names it. A proposal is built by picking countries and then the services offered in them, so the country is the thing the user actually chose. On an EL it is the entity's own jurisdiction, carried so both kinds print and group the same way. |
| `billing_frequency` | `text` | month / quarter / year / one-time / custom. *"Some monthly, some quarterly, some annually"* — and it is a property of **this deal**, not of the catalogue service: A1 is a monthly service that some clients are billed quarterly for. The new schema has `billingBasis` on the catalogue only. |
| `effective_from` | `date` | Per line, because per line can express a single shared date and the reverse cannot. An Incorporation line starts the day it is signed; a GST line on the same letter may start next period. |
| `scope_override`, `client_obligations_override`, `volume_limits_override`, `exclusions_override` | `text` ×4 | Per-document edits to the four scope blocks. All null in the normal case, and then the catalogue text prints. **This is what makes an issued document reproducible** — the letter carries its own wording, so a later catalogue revision cannot change what a signed document says. Without them, tailoring one client's proposal silently rewrites the standard scope for every proposal issued afterwards. |
| `oop_estimate_min`, `oop_estimate_max`, `oop_currency` | `numeric`, `numeric`, `text` | Out-of-pocket expenses — *"approx. USD 5,000–6,000"*, reimbursed at actuals and separate from the professional fee. A range, because that is how the firm writes it. |
| `pricing_note` | `text` | Why there is no amount. Several real lines are genuinely "as mutually agreed" — and since `unit_amount` is `NOT NULL CHECK (>= 0)`, **the new schema cannot represent an unpriced line at all.** It would have to be quoted as zero, which is a different statement to a client. |
| `description` / `sort_order` | | ✅ Both present (`description`, `position`). |

### 4.7 Prose blocks, clauses and governing law

| Missing | Why |
|---|---|
| `deal_document_block` (`kind` ∈ exclusion / commercial / team, `body`, `is_heading`, `sort_order`) | The three prose lists every letter carries besides its priced lines: general scope exclusions, commercial notes ("All fees are exclusive of GST as applicable"), and the team-deployment table. **One row per line, not one blob per block**, because that is how they are edited — a line at a time, reordered, removed. A single text column makes "delete the third exclusion" a string operation. |
| `standard_document_block` (+ `jurisdiction`, `is_active`) | The firm's standard set, **copied** onto each new document so that revising it changes the next letter and never a previous one. `jurisdiction` is load-bearing: "exclusive of GST" printed on a UAE proposal is wrong in exactly the way the firm already caught in its own template. |
| `clause_set.governing_law` + `.courts` | **The sharpest finding of the original project.** The real letter was issued by 10x US to a US client and its standard terms named Indian law and Delhi courts. The firm's verdict: *"No. This is wrong. For US it's US. For UAE it's DIFC in Dubai."* Governing law is a property of the **issuing entity's** jurisdiction, resolved at generation. The new `ClauseBody` is `{title, text, jurisdictions[]}` — clauses are tagged by jurisdiction, but **there is no governing-law or courts field anywhere**, so the exact bug the firm caught is representable again. |
| `firm_entity_preference` (`client_jurisdiction` including `'*'`, `firm_entity_party_id`) | Q19's rule as rows: which firm entity issues for a client in a given country, plus the fallback where the firm has no entity there (*"mostly UAE"*). Data, not an `if (country === …)`. |

### 4.8 Service catalogue — `config` `kind='service'`

The new `ServiceBody` is `{name, description, category, jurisdictions[], billingBasis,
listPrice}`. The versioning and per-line pinning are a real improvement over the old
`fee_schedule`. The field loss is heavy:

| Old field | Add back as | Why |
|---|---|---|
| `ref` (`A1`, `H1`, `R7`) | `ServiceBody.ref` or `config.entry.key` | The firm's own code — the join key that runs through the services master, proposals and engagement letters alike. Decide which of the two carries it and write it down. |
| `module_id` (Dept: FRC / TRC / RAA) | `ServiceBody.module` | **The revenue reporting axis** — the firm's dashboard splits revenue by it. Also what a SPOC is assigned per (§4.2). |
| `group_id` (FINCOMPLIANCE, VCFO CONSOLE, PAYROLL…) | `ServiceBody.group` | The delivery axis. Deliberately *not* nested under module — FINCOMPLIANCE appears under both FRC and TRC, so they are independent dimensions of the same service, not a hierarchy. |
| `recurrence` | `ServiceBody.recurrence` | month / quarter / year / one-time / custom. `billingBasis` (fixed / hourly / retainer / per_unit) answers *how it is priced*, not *how often it recurs*. Both are needed, and the EL line needs the second to derive its `billing_frequency` default. |
| `scope`, `client_obligations`, `volume_limits`, `exclusions` | `ServiceBody.*` | The four blocks the engagement letter is assembled from. **These are what protect the firm in a dispute**, and §4.6's overrides have nothing to override without them. |
| `sla_days` | `ServiceBody.slaDays` | *"Task is due from signing of EL"*, *"SLA is per service"*. Copied onto a work item at creation so a catalogue revision cannot make finished work retroactively late. T3.1 needs it and nothing currently supplies it. |
| `fee_schedule.pricing_note` | `ServiceBody.pricingNote` | `listPrice: null` can say there is no list price but not why. "As mutually agreed" has no home. |
| `fee_schedule.valid_from` / `valid_to` | — | Mostly covered: version history already answers "when did the price change". No action needed beyond confirming that reading is intended. |

### 4.9 Tenant / firm

| Field | Why |
|---|---|
| `firm_signatory_user_id`, `firm_signatory_title` | *"Unki ek hi signature rahegi, Siddharth ki"* — one signatory for the whole firm, whichever entity issues. A row rather than a hardcode, so a successor is an `UPDATE` and it stays true for a second tenant. |
| `brand_asset` (logo, signature image, scoped tenant / legal_entity / user) | The images that end up inside generated documents. Not scheduled anywhere, and PDF generation cannot ship without it. |

---

## 5. Two structural findings

### 5.1 The engagement lost its entity — fix this first

The old model, confirmed by the client as **"Per Company"**: an engagement is
`service × one legal entity`. vCFO for a group of four companies is **four engagements**,
not one. This is precisely why a "client" cannot be the root of the model — GST attaches to
the Indian entity and to nothing else.

The new `crm.engagement` fans out one row per EL line, which is right, but sets
`party_id: letter.partyId` — **the client, not the entity**
(`bib-backend/src/usecase/engagement/service.ts:328`). Since `engagement_letter_line`
carries no `entity_party_id`, the entity dimension does not exist anywhere in the
commercial chain.

Consequences, in order of severity:

- **The compliance calendar cannot be generated.** `obligation_instance` keys on
  `entity_party_id` — an entity owes GSTR-3B; a client does not. T3.2 has no join available.
- A group client's four entities cannot be told apart on a letter, an engagement, or an invoice.
- `core.legal_entity` — carefully modelled with jurisdiction, entity type and financial
  year end — is currently reachable from nothing downstream.

**Fix**, as `0018_engagement_entity.up.sql` — additive, and both tables are empty today:

Proposal lines and EL lines are separate tables, and they want different strictness:

```sql
SET ROLE bib_owner;

-- A proposal line MAY name the entity: a prospect may hold none yet, and an
-- Incorporation line's entity is that line's own output. Nullable on purpose.
ALTER TABLE crm.proposal_line
  ADD COLUMN entity_party_id uuid,
  ADD CONSTRAINT proposal_line_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- An EL line MUST. On signature each line becomes exactly one engagement, and an
-- engagement is service x one legal entity. NOT NULL rather than a rule in the
-- service, so an import or an agent cannot walk past it.
ALTER TABLE crm.engagement_letter_line
  ADD COLUMN entity_party_id uuid NOT NULL,
  ADD CONSTRAINT el_line_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

ALTER TABLE crm.engagement
  ADD COLUMN entity_party_id uuid NOT NULL,
  ADD CONSTRAINT engagement_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

CREATE INDEX idx_engagement_entity ON crm.engagement (tenant_id, entity_party_id);

RESET ROLE;
```

*Verified against the schema at the commit above — applied inside a transaction and rolled
back, `DDL OK`.* The bare `NOT NULL` is only safe because all three tables are empty
(`proposal_line`, `engagement_letter_line`, `engagement` = 0 rows). If yours are not, it is
the usual three steps: add nullable, backfill, `SET NOT NULL`.

Then in `usecase/engagement/service.ts` the fan-out takes the entity from the line rather
than the client from the letter — `entityPartyId: line.entityPartyId` beside the existing
`partyId: letter.partyId`. **Keep both.** The client is who is billed; the entity is who the
work is delivered to. Invoicing needs the first, the calendar needs the second.

A stricter variant, if wanted: point the FK at `core.legal_entity (party_id, tenant_id)`
instead of `core.party`, so a line cannot name a person or an unregistered organization.
That currently fails with *"no unique constraint matching given keys for referenced table
legal_entity"* — it needs `ALTER TABLE core.legal_entity ADD CONSTRAINT
legal_entity_id_tenant_key UNIQUE (party_id, tenant_id)` first, the same pattern 0007 and
0011 already use on `party`, `lead` and `version`. One extra key, and the guarantee moves
from code review into the database.

Doing this now is one migration. Doing it after T3.2 means rewriting the calendar.

### 5.2 The demo's hardest rules moved from code into the database — finish the move

The rebuild converted a great deal of application logic into constraints, and that is the
right direction. Three of the old system's hardest-won rules have no home yet:

- **Maker ≠ checker as a database CHECK** — *"a rule that lives in a form is a rule that a
  script, an import or an AI agent walks straight past."* (`approval`, T3.1)
- **Gapless invoice numbering** under concurrency, via a counter row taken under
  `SELECT … FOR UPDATE` rather than a sequence — a sequence keeps its number on rollback and
  would burn 41 forever. (T3.4 — planned, and the plan names the mechanism correctly.)
- **AI `proposed` vs `applied` kept side by side forever** — keeping only the corrected value
  is the obvious thing to do and throws away the entire accuracy signal. (Phase 4 — the plan
  mentions confidence tiers; make sure both columns survive into the schema.)

---

## 6. Dropped, not deferred — decide explicitly

These existed in the approved demo and appear in **neither** the new schema nor
`BUILD-PLAN.md`. Each needs a yes or a no rather than silence:

| Thing | Consequence of leaving it out |
|---|---|
| `staff_grade` + `membership.grade_id` | The review rule *"Manager or above"* has nothing to compare. |
| `client_assignment` (Key Manager / Dept SPOC) | T3.1's own acceptance criterion cannot be met. |
| `notification` | No in-app inbox. The firm asked for it directly: *"Email aur in-app — in-app kar do abhi."* |
| `brand_asset` | No logo or signature inside a generated PDF. |
| `firm_entity_preference` + `issuing_entity_party_id` | The firm cannot say which of its own entities is contracting. |
| `clause_set.governing_law` / `.courts` | The US-letter-cites-Delhi-courts bug becomes representable again. |
| `standard_document_block` | Exclusions and commercial notes must be hardcoded in the renderer. |
| `credit_note.reason` (mandatory, CHECK) | Revenue leakage becomes invisible — the numbers always reconcile; *why* ₹40,000 came off does not. |
| `communication` (email / WhatsApp threading) | No client conversation history, and A1 Intake has nothing to attach to. |
| `deal.lost_reason` / `abandoned` | Pipeline analytics cannot separate a pricing problem from a follow-up problem. |

---

## 7. What the new system does better — do not regress these

1. **The tenant wall is real.** `NOBYPASSRLS` + a boot check that refuses to serve + composite
   `(id, tenant_id)` foreign keys. Cross-tenant leakage is structurally impossible rather than
   merely unlikely.
2. **Config versions are frozen by trigger**, and documents pin the version they used. The old
   system copied text to achieve the same guarantee; pinning is stronger and cheaper.
3. **One currency and one FX rate per document**, enforced by a composite key. The old schema
   allowed a mixed-currency document whose total depended on the order lines were added.
4. **Totals are views.** A stored total eventually disagrees with the rows it claims to sum,
   and nothing says which is right.
5. **The ledger is immutable twice over** — grants *and* a trigger that also rejects TRUNCATE.
6. **Signed content hashing** (`signed_content_hash`) — the old system recorded that a
   signature happened; the new one can prove *what* was signed.
7. **Shared proposal links** with `first_viewed_at` / `view_count` — genuinely new capability.
8. **The architecture is a test.** dependency-cruiser runs inside the suite, so erosion fails CI.

---

## 8. Suggested order

**Before anything else**

1. `entity_party_id` on `engagement_letter_line` + `crm.engagement` (§5.1) — one migration
   now, a rewrite later.
2. `deleted_at` on the `core` tables, or a written decision that parties are never removed (§4.1).

**To make the document printable** — this is what the client saw and approved

3. Head fields: `ref`, `issuing_entity_party_id`, `background`, `addressed_to_party_id`,
   `effective_from`, `issued_on`, the firm signatory block (§4.5).
4. Line fields: `jurisdiction`, `billing_frequency`, `effective_from`, the four scope
   overrides, the OOP range, `pricing_note` — and relax `unit_amount NOT NULL` (§4.6).
5. Prose blocks + standard blocks + governing law / courts + `firm_entity_preference` (§4.7).

**To unblock the delivery lane**

6. Catalogue fields: `ref`, `module`, `group`, `recurrence`, the four scope blocks,
   `sla_days` (§4.8).
7. `client_assignment` + `staff_grade` + `membership.party_id` (§4.2, §4.3).

**Then the planned phases** — T3.1 work, T3.2 obligations, T3.4 billing, T3.6 documents —
which by then have the fields they depend on.

Items 3–5 are additive columns on tables with no production data. Doing them before T3.x
costs days; doing them afterwards costs a migration across live engagements and issued
letters.
