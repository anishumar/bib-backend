# FinCompliance build plan: the tracker

**Owner:** Anish, building the whole module. **Started:** 2026-10-10. **Branch:** `feat/fin` (and `feat/fin-*` off it).
**Source:** *FinCompliance MVP Plan v3.2* (10 Oct 2026) for scope, and the 10x training pack at `../fincompliace/SG_BiB_Training_Data_Pack` for testing.
**Board ids:** F2 is T4.7 (Intake), F4 and F5 are T4.10 (Validation), F6 is T4.3 (Rule-Match) and F7 is T4.6 (Rule-Pack Watcher). All four are still marked "Not in v1 (2026-10-05)" in `MERGE_BUILD-PLAN.md`, and re-scoping them there is task F0.1.

## How to use this file

- Tick a box (`- [x]`) only when its **check** passes, and add the commit sha at the end of the line.
- Every task's gate is `npm run check` passing. A task that adds a migration also needs `npm run test:integration` to pass.
- Count progress (done, then total):
  `grep -c '^ *- \[x\]' docs/FIN_BUILD_PLAN.md; grep -c '^ *- \[[ x]\]' docs/FIN_BUILD_PLAN.md`
- Add a line to the **Log** at the bottom when a phase closes or a decision is taken.

## Ground rules (from v3.2, not up for re-debate per task)

1. **Rules and arithmetic decide; AI only reads documents and drafts.** Coding, posting, reconciliation and checks are deterministic.
2. **A machine may say "check this"; only a person commits.** Only a person decides that an obligation applies, and only a person files a return.
3. **Nothing a machine detects becomes an active rule by itself.** One person proposes and a *different* person approves, enforced by a database CHECK.
4. **Fin can fail without BiB failing.**
   - Fin has its own folders, its own `fin` schema and its own process (a Cloud Run Job).
   - Core never imports fin.
   - Switches: a global `BIB_FIN_ENABLED` and a per-firm column.
   - Collection (templates and asks) and the calendar live in **core**, so they keep working with fin off.
5. **Every fin table** has `tenant_id`, RLS, a policy, and composite `(id, tenant_id)` foreign keys (`tenant-keys.integration.test.ts` enforces this).
6. **`99_Ground_Truth` never enters the pipeline.** It is only read by the scorecard.
7. **Synthetic data lives in a sandbox tenant**, never in 10x's live firm.

## Open decisions

Each one names the tasks it blocks.

- [ ] **10x:** in production, is BiB the books, or does it post journals into Xero or QuickBooks? Blocks the scope of F3.4–F3.9 and decides whether F3.10 is needed.
- [ ] **10x:** confirm the monthly list taken from the Retainer Workflow tab. Blocks the F1.7 seed.
- [ ] **10x:** who confirms rules and later changes (two people, one a partner); the materiality amount; who sees flagged items. Blocks F4.6, F5.2 and F7.4.
- [ ] **10x:** should "patterns against history" show beside the exceptions? Blocks the placement in F5.5.
- [ ] **10x:** Form C on 30 Nov or 15 Dec; "56 annual" vs 11 + 9. Blocks F6.3 and F6.4.
- [ ] **Team:** who now owns what. v3.2 has Shrestha and Ritvik on fin starting Mon 12 Oct; tell them and agree before the first push.
- [ ] **Team:** migration numbers.
  - Fin tables reference recent core tables, so fin migrations must sit *above* them. Fin starts at **0381**.
  - Range (B) ends at 0400, so a new block above 0400 needs agreeing with Shrestha (see `migrations/README.md`).
- [ ] **Team:** `client_ask.due_on` reverses T6.6's recorded decision of "no due date, anywhere". Write the reason into the F1.3 migration and into CLAUDE.md.
- [ ] **Team:** the chaser sends no email (T4.4), so decide whether there is a "you have new requests" email. It is needed before real clients only.
- [ ] **Team:** per-step desks. Today a job's steps go to whoever holds the job's task (if their grade fits), and only review goes to someone else (maker ≠ checker). Decide whether "Reconcile desk ≠ Process desk" is needed (F1.8).
- [ ] **Team:** the extraction model is chosen by the scorecard per format (digital, scanned, photo), not up front.
- [ ] **Team (found while building F0.10, not fin's bug):** `PUT /internal/v1/tenants/{id}/status` passes the caller's NAME as a system actor's id, and the ledger accepts a system actor only with a null id. So suspending or reinstating a firm through that route fails with a 500 on any real change, and no test calls it over HTTP. The fin switch avoids this by using the system actor with the caller in the payload (`by`). Fix the status route the same way.
- [x] **Team:** which document kind a client's books files are stored as. **Decided 2026-10-10 (Anish): option B, a new kind `books_input`.** It shipped in migration `0383_books_input_kind` (both CHECKs widened, and the parity tests now read the named constraints). It is outside the fee wall and not client-visible by default. Fin takes `books_input` and nothing else. The frontend has labels for it: "Client's books (invoices, statements, payroll)" for staff and "Records you sent" on the portal. The pack loader files as `books_input`.
- [ ] **F0.1 Plan and board.** This file exists. Re-scope T4.3, T4.6, T4.7 and T4.10 in `docs/MERGE_BUILD-PLAN.md`, pointing to the F-ids. Bring `bib-docs/backend/MERGE_BUILD-PLAN.md` back in line with it.
  ✔ Both board files agree, and the four T-ids point here.
- [x] **F0.2 Import wall.** Create `src/domain/fin/`, `src/usecase/fin/` and `src/infrastructure/fin/`. Add a dependency-cruiser rule `core-never-imports-fin` in `.dependency-cruiser.cjs`. Only `src/setup/fin.ts` and `src/setup/server.ts` may wire fin.
  ✔ `npm run arch` fails on a deliberate core→fin import, and passes once it is removed.
  *Done 2026-10-10. The allowed seams are `api/router.ts`, `api/domainerr.ts` (the error mapper, caught by the rule on its first run), `setup/fin.ts`, `setup/server.ts`, `cmd/fin-once.ts` and `testfakes/fin.ts`.*
- [x] **F0.3 Kill switch.** Add `BIB_FIN_ENABLED` to the zod schema in `src/config/config.ts`, to `.env.example` and to `validate.ts`. It defaults to off.
  ✔ It is a unit-tested config parse, and an unset value means off.
  *Done 2026-10-10 (`tests/fin/config.test.ts`). Also added `BIB_FIN_DB_POOL`, default 3, max 10.*
- [x] **F0.4 Schema.** Migration `0381_fin_schema` covers:
  - `CREATE SCHEMA fin` with grants to `bib_app`
  - `tenancy.tenant.fin_enabled boolean NOT NULL DEFAULT false`
  - a `down` migration.
  ✔ `npm run migrate` is clean on a fresh database and on the dev database. `npm run test:integration` passes (tenant keys).
  *Done 2026-10-10 as `0381_fin_intake`. The switch is `fin_enabled_since timestamptz` (NULL = off): the instant is also the cut, so a firm's earlier uploads are never taken in. `fin.intake_item` landed in the same migration (F2.1), so the schema arrived with a consumer. Fresh database: 0001→0382 clean. Integration suite: 1130 passing.*
- [x] **F0.5 Fin process.** Add `src/cmd/fin-once.ts` and `src/setup/fin.ts`.
  - Each run executes every sweep once, then exits.
  - It exits at once when the global flag is off, and skips firms that have `fin_enabled = false`.
  - Its own pool is capped at 3 connections, with a statement timeout.
  - Add an npm script `fin:once`.
  ✔ `npm run fin:once` exits 0 with the flag off and with it on and no work. The pool size is asserted in a test.
  *Done 2026-10-10. It also runs the tenant-wall and append-only-ledger boot checks, and is a `tsup` entry (`dist/cmd/fin-once.js`) for the Cloud Run Job.*
- [ ] **F0.6 API surface.** Add a `/api/v1/fin/*` route group in `src/api/router.ts`.
  - It answers 404 when fin is off, and 503 `FIN_UNAVAILABLE` on a fin timeout. Map the code in `api/domainerr.ts`; an unmapped code is a compile error.
  - Every route is listed in `ROUTE_PERMISSIONS`.
  ✔ Handler tests cover 404 when off, 503 on timeout, and 403 without the permission.
  *Partly done 2026-10-10. `GET /api/v1/fin/intake` exists. With the global flag off the route is not registered (404); with a firm's switch off it answers 404 `FIN_NOT_ENABLED`. It is in `ROUTE_PERMISSIONS` and in the auth-coverage sweep. Fin reads set a 5s statement timeout. **Still open:** 503 `FIN_UNAVAILABLE` needs a 503 status and code added to the shared error envelope (`api/domainerr.ts`), and that is a cross-cutting change.*
- [x] **F0.7 Permissions: `books:read`.** Add it to `domain/authz/model.ts` and `DEFAULT_ROLES` (Partner, Manager, Associate), with a migration that gives it to every role carrying `work:write`.
  ✔ `tests/config/seed-parity.test.ts` passes.
  *Done 2026-10-10 as `0382_books_read_permission`, using 0364's method. The other three land with the routes that first check them, because this codebase forbids a permission nothing checks ("a lie on a screen"): `books:write` with F2.8 (staging commit), `compliance:determine` with F6.1, and `compliance:approve` with F7.4.*
- [ ] **F0.8 Frontend shell.** Add `bib-frontend/src/app/fin/` with a layout and the app's **first** `error.tsx` boundary. The nav entry is hidden when fin is off.
  ✔ With fin forced to throw, only the fin panel shows the error. Frontend `npm run check` passes.
- [ ] **F0.9 Infra.** In `infra/terraform/`, add:
  - `run_fin.tf`: a Cloud Run **Job**, modelled on `run_migrate.tf`
  - a Cloud Scheduler trigger every 10 minutes (no scheduler exists in Terraform yet)
  - IAM to run the job.
  ✔ `terraform plan` against `qa.tfvars` shows only fin resources. It is applied in F9.
- [x] **F0.10 Sandbox and pack loader.** Add a script that:
  - creates a sandbox tenant
  - creates companies A–E as clients
  - loads folders `00`–`07` month by month through asks and uploads.
  It refuses any path under `99_Ground_Truth`.
  ✔ The loader runs end to end. A test proves that a `99_` path is refused.
  *Done 2026-10-10. `npm run fin:pack` works over HTTP against a running local API:
  - it provisions the firm through `/internal` and switches fin on with the new `PUT /internal/v1/tenants/{id}/fin` (`tenant.provision`, ledger `tenant.fin_enabled` / `tenant.fin_disabled`, which F9.4 needs too);
  - it signs in as a sandbox partner, creates companies A–E as clients and uploads folders 00–07 as kind `other`;
  - it refuses a non-local API and an existing slug, and `--dry-run` uploads nothing.*
  *First real run: 1,168 files uploaded in about 3 minutes. Six `fin:once` runs took in all 1,168: pdf 840, sheet 222, image 101, and manual 5 (the `company_profile.json` files, since JSON has no reader).*
  *Still to come: the month-by-month replay through the monthly asks arrives with F1.*

## F1: Collection (core)

Estimate: 3–4 days. This is v3.2 §11.

- [ ] **F1.1 `request_template` config kind (the 13th).**
  - Add it to `CONFIG_KINDS` (`domain/config/model.ts:53`) with a body validator in `validateBody`.
  - The body is a list of items, each with `key`, `label`, `kind` (`document`, `question` or `approval`), `required`, `finHint`, `sendOffsetDays` and `dueOffsetDays`. A `document` item that feeds the books files its upload as `books_input` (0383).
  - Add a migration widening `entry_kind_check`.
  - Fix the stale "ten kinds" wording in CLAUDE.md.
  ✔ Validator tests refuse a duplicate key, an unknown kind, and a due date before the send date. Publish and read work over HTTP.
- [ ] **F1.2 Step → template reference.** A `WorkflowStep` (or a checklist sub-step) carries an optional `requestTemplateKey`, and the job pins the template version.
  ✔ Validator tests pass. A job pinned to version 1 keeps version 1 after version 2 is published.
- [ ] **F1.3 Ask fields.** Add a migration for `client_ask.due_on`, plus the template version and item-key reference. Add a unique key on `(tenant_id, work_item_id, template_item_key)`. Write the reversal of T6.6 into the migration header and into CLAUDE.md.
  ✔ The integration test refuses a duplicate. The old asks with no template still read correctly.
- [ ] **F1.4 Requests sweep.**
  - New queue `delivery.requests` and a cron setting `BIB_WORKER_REQUESTS_CRON` in `setup/worker.ts`.
  - It runs an anti-join: period work items whose step names a template, and items not yet raised on or after the send date.
  - It raises asks through `ClientAskService.raise`, and also runs from `worker:once`.
  ✔ Running it twice raises the asks once. A ledger event is written only for rows actually created.
- [ ] **F1.5 Due date shown.** The portal action centre and the staff screens show `due_on`, and the chaser still works.
  ✔ A browser walk as a client and as staff.
- [ ] **F1.6 Uploads.** Allow multi-file upload on one ask, and staff "upload on behalf" of a client.
  ✔ Uploading 3 files to one ask stores 3 versions. An on-behalf upload is recorded with the staff actor.
- [ ] **F1.7 Templates screen and seed.** Add an admin screen for request templates, and seed **"Monthly close"**: sales invoices, purchase invoices, bank statements and expense claims, due on the 5th.
  ✔ A sandbox client receives 4 asks on the send date.
- [ ] **F1.8 Per-step desk (only if the decision above says yes).** Extend the owner rule so that a step can name its own Dept or desk.
  ✔ Two steps of one job land on two different people.

### F1 contract (fixed 2026-10-10, before the work was split)

Agents A and B and the sweep (C) build against these shapes. A change goes through the plan owner, not into one branch.

**`request_template` body** (`domain/config/model.ts`, Agent A):
```ts
interface RequestTemplateItem {
  key: string;            // STEP_KEY_PATTERN, unique within the template
  label: string;          // what the client reads; trimmed, 1–500 chars
  askKind: "document" | "question" | "approval";
  documentKind: DocumentKind | null;  // present exactly when askKind = "document"
  sendOffsetDays: number; // integer 0–90, counted from the period's LAST day
  dueOffsetDays: number;  // integer 1–120, and greater than sendOffsetDays
}
interface RequestTemplateBody { label: string; items: RequestTemplateItem[] }  // 1–30 items
```
- No `required` and no `finHint`. Nothing reads them yet, and this codebase refuses a field designed against no consumer. They come with their consumers.
- Pure helper `requestDates(periodEnd, item) → { sendOn, dueOn }`, using `addDays` from `domain/scheduler/model.ts`.
- **Example:** October's "Monthly close" has `periodEnd` 2025-10-31, `sendOffsetDays` 1 and `dueOffsetDays` 5. The client is asked on 1 Nov, due 5 Nov.

**Step link** (Agent A): `WorkflowStep.requestTemplateKey: string | null`. Absent or null means none, so every published process still reads. It holds a config KEY, read live like `verificationPolicyKey`: the ASK records the version it was raised from.

**Ask fields** (Agent B, migration `0385`): `delivery.client_ask` gains
- `due_on date`
- `request_template_version_id uuid`, with a composite FK to `config.version (id, tenant_id)`
- `request_template_key text`
- `request_item_key text`

The last three are all set or all null. A partial UNIQUE index on `(tenant_id, work_item_id, request_template_key, request_item_key)` makes the sweep idempotent. `ClientAskService.raiseFromTemplate(...)` returns `{ created: boolean }` and writes `client_ask.raised` only when created. The staff and portal wire shapes gain `dueOn: string | null`.

**Migrations:** A takes `0384`, B takes `0385`. The sweep (C) takes `0386` only if it needs one.

## F2: Intake and standardise (T4.7)

Estimate: 4–5 days, plus 6–10 days of readers, plus scan tuning. This is v3.2 §12.

- [x] **F2.1 Intake items.** Add `fin.intake_item`, read from `document.stored` ledger events with a cursor (the same idiom as `notify.fanout_cursor`). Use an anti-join so each document version gets exactly one item.
  ✔ Replaying the cursor creates no duplicates. The fin job crashing mid-run is caught up on the next run.
  *Done 2026-10-10, with one change of method. It anti-joins `files.document_version` instead of replaying `document.stored` payloads: the same at-least-once property, without parsing a version number out of jsonb. A second run takes nothing and writes no event (unit and integration tests). Fin takes uploads of kind `other`, `correspondence`, `statutory_filing` and `working_paper`, and leaves out KYC, brand assets and every fee-wall kind (see the open decision on document kinds). Batches are 200 per firm per run, and `more` reports a backlog.*
- [x] **F2.2 Router.** Sniff the file type and route it to `sheet`, `pdf_text`, `vision`, `unpack` or `manual`. Unknown types go to `manual` on the desk as "not read".
  ✔ Each pack format is routed correctly (a table-driven test).
  *Done 2026-10-10 (`domain/fin/intake.ts`). The declared media type wins; a generic or unknown type falls back to the extension; neither gives `manual`. The route and its basis are stored on the row.*
- [ ] **F2.3 New dependencies behind ports.** Add PDF text extraction, image downscaling and ZIP reading, each behind a port in `usecase/fin/ports.ts`. Vendor types never cross the port.
  ✔ `npm run arch` passes, and every port has a fake in `testfakes/`.
- [ ] **F2.4 Extractor port.**
  - A deterministic fake, plus a Claude adapter using tool use with a JSON schema.
  - Output is validated with zod; on failure it retries once, then goes to manual.
  - A circuit breaker, a per-run item cap and a monthly budget cap.
  - Every call records `model`, `prompt_version` and tokens in `fin.extraction_usage`.
  ✔ Fake-driven tests cover success, invalid JSON then retry then manual, and the open breaker. The cap is enforced.
- [ ] **F2.5 Standard line.** Add `fin.transaction_line` with these fields:
  - doc type, counterparty, GST registration number, doc number, date
  - currency and SGD rate, net, GST code, GST, total
  - service period and credit-note reference
  - provenance: document version, page and row.
  ✔ Every pack document type maps to a line, and every line links back to its file.
- [ ] **F2.6 Sheets.** Remember a column map per layout in `fin.source_format` (today's sheet reader mapping is hard-coded for client import). Check control totals.
  ✔ The second file of a known layout needs no mapping. A control-total mismatch becomes a finding.
- [ ] **F2.7 ZIP.** Enforce size, count and depth limits, and refuse executables.
  ✔ A zip bomb fixture and an `.exe` fixture are both refused.
- [ ] **F2.8 Staging.** Add an API and a screen for review by exception. Commit is gated on a new `books:write` permission (added here, with a role-seed migration).
  - Confident lines are accepted as a batch, and only flagged fields are shown.
  - **Nothing counts until a person commits.**
  - The confidence bar comes from the `confidence_tier` kind, or copies its rules (`>` not `>=`, so 1.0 means never auto-accept).
  - Both what the model proposed and what the person applied are kept.
  ✔ A browser walk. An uncommitted line is invisible to F3 and F4.
- [ ] **F2.9 Bank statements.** Read 5 PDF and 5 CSV layouts, including the scanned months.
  ✔ Opening balance, closing balance and line count match `statement_files_manifest.csv` for every file.
- [ ] **F2.10 Card statements.** Handle foreign-currency lines and overseas fees.
  ✔ Line counts and totals match the card statements.
- [ ] **F2.11 Payroll.** Read the 5 Excel templates (formulas read as values) and the CPF submission CSVs.
  ✔ Per employee per month, the numbers match `payroll_truth.csv` (the input side).
- [ ] **F2.12 POS and customs.** Read company C's daily POS CSVs and company B's customs permit advices.
  ✔ Totals match `documents_manifest.csv`.

## F3: Coding and books

Estimate: 10–15 days. This is v3.2 §14, and its scope depends on the "is BiB the books" decision.

- [ ] **F3.1 Masters import.** Import the chart of accounts, GST codes, the vendor, customer and employee masters, and the opening trial balance.
  ✔ All 5 companies load, and the opening trial balance totals zero.
- [ ] **F3.2 Counterparty key.** Match on UEN, then GST registration number, then normalised name. An unknown counterparty goes to a person, never a guess.
  ✔ Every pack counterparty resolves, and an unknown one goes to the desk.
- [ ] **F3.3 Coding.** The master gives the GL account, GST code, claimable flag and withholding rate. Company E's purchase GST is not claimable.
  ✔ GL, GST code and claimable flag match `documents_manifest.csv`.
- [ ] **F3.4 Posting.**
  - Double-entry templates for purchase, sales, credit note, customs import GST, retention and cut-off accrual.
  - Amounts are SQL `numeric`, and every entry balances (enforced by a check).
  - Duplicates and prior-year invoices are never posted.
  ✔ Posting matches `ledger_truth.csv` line for line, for the document-driven entries.
- [ ] **F3.5 Bank reconciliation.** Matching runs in three passes:
  1. exact amount and reference
  2. combined payments (a bounded subset-sum)
  3. part payments, with the remainder going to F4.
  ✔ At least 95% of bank lines match the correct documents (`bank_transactions_truth.csv` → `matched_doc_ids`).
- [ ] **F3.6 Card matching.**
  ✔ Matches `card_transactions_truth.csv`, and spends with no document are flagged.
- [ ] **F3.7 Settlement postings** follow the bank and card matches.
  ✔ Ledger cash equals each statement's closing balance.
- [ ] **F3.8 Trial balance and proofs.** The trial balance totals zero, and each statement's running balance continues from the previous month.
  ✔ It matches `trial_balance_truth.xlsx` account by account, **to the cent**.
- [ ] **F3.9 GST F5 from the ledger.**
  ✔ Boxes 6, 7 and 8 per quarter match exactly for A–D.
- [ ] **F3.10 Journal CSV export** (only if BiB is not the books). Use the books software's import format.
  ✔ The file imports into the target format's validator.

## F4: Rule exceptions and findings (T4.10)

Estimate: 6–7 days. This is v3.2 §13, lane A.

- [ ] **F4.1 Dated values.** Add `fin.rule_parameter`: GST 8% until the end of 2023 and 9% from 2024; CPF 2025 (ceiling S$7,400) and 2026 (S$8,000); SDL at 0.25% with a minimum of S$2 and a maximum of S$11.25.
  ✔ Golden cases on each side of every date boundary.
- [ ] **F4.2 Findings.** Add `fin.finding` and `fin.finding_decision`. The decision is ask client, correct, or dismiss. A dismissal must give a reason code (`price_change`, `one_off`, `seasonal`, `expected`, `other` plus text).
  ✔ A CHECK refuses a dismissal with no reason. Decisions are append-only.
- [ ] **F4.3 Document checks (27 seeded):**
  - [ ] duplicate invoice (same counterparty key, number and amount)
  - [ ] GST rate wrong for the date
  - [ ] GST charged with no supplier GST number (invalid tax invoice, BL)
  - [ ] out of period
  - [ ] cut-off (service period before the period end)
  - [ ] client not GST-registered
  - [ ] credit note
- [ ] **F4.4 Bank checks (15 seeded):**
  - [ ] short payment
  - [ ] unmatched payment
  - [ ] unidentified receipt
- [ ] **F4.5 Payroll checks (5 seeded):**
  - [ ] CPF Ordinary Wage ceiling
  - [ ] CPF age band
  - [ ] CPF on a Work Permit holder
  - [ ] CPF on an Employment Pass holder
  - [ ] missing SDL
- [ ] **F4.6 Findings to the desk.**
  - A ledger event, e.g. `fin.finding_raised`, with a notify category and a `planFor` case so the bell rings.
  - The owner comes from `resolveOwner`.
  - "Ask client" goes through a port to `ClientAskService`; fin never writes core tables.
  ✔ A finding rings the right person's bell, and "ask client" creates a portal ask.
- [ ] **F4.7 Findings panels** on the client and task pages, each in its own error boundary.
  ✔ A browser walk.

## F5: Patterns against history (T4.10, pulled forward from phase 1b)

Estimate: 3–5 days. Always shown in **its own panel**, and **never** counted in the exception score.

- [ ] **F5.1 Profile.** Add `fin.counterparty_profile`, one row per client × counterparty × GL account. It holds the monthly amounts, median, MAD, cadence, last seen and count, and is rebuilt after each commit from the monthly summaries.
  ✔ Unit tests on the median and MAD, including a past spike that must not move the baseline.
- [ ] **F5.2 Checks.**
  - [ ] **Spike:** history of at least 3 months, amount at or above materiality, and (robust z > 6 or more than 3× the median). The thresholds are per-firm values.
  - [ ] **New vendor** above materiality.
  - [ ] **Recurring vendor missing** this period, judged from its cadence.
  - [ ] **Frequency change**, e.g. two invoices in a month from a vendor who bills monthly.
  - [ ] **GL drift:** a vendor coded to a different account than usual.
- [ ] **F5.3 Explanation text.**
  ✔ It renders as: "Vendor X: S$300,000 this month; usually S$21k–30k (median S$24.5k over 6 months), 12× normal".
- [ ] **F5.4 Learning from decisions.**
  - `price_change` resets the baseline from that month.
  - `one_off` leaves that invoice out of the baseline.
  - `seasonal` compares against the same month last year.
  - A check that is mostly dismissed for a client raises that client's threshold.
  ✔ A test for each reason code.
- [ ] **F5.5 Gating.** The checks stay off until a client has 3 months of committed history, and appear in a separate panel.
  ✔ No pattern finding exists for a client with 2 months of history.
- [ ] **F5.6 Backtest.** A script replays the pack Jan–Dec, with the checks switching on from April. It runs on answer-key lines first, then on pipeline lines.
  ✔ Prints the flags per client-month per check. Proposed targets: **≤ 2 per client-month** on the clean pack, and **100%** of injected 10× spikes caught.

## F6: Compliance intelligence (T4.3)

Estimate: 5–7 days. This is v3.2 §15.

- [ ] **F6.1 Compliance profile** on the client company (core). Add `compliance:determine` here (Partner by default), with a role-seed migration. Fields: year end, first GST quarter-end, GST registered, has employees, has foreign employees, pays non-residents, audit required, FS filing required. Only a person sets it (`compliance:determine`).
  ✔ The permission is enforced, and every change is in the ledger.
- [ ] **F6.2 Rule conditions** read the profile, e.g. CPF only when the client has employees.
  ✔ Golden cases on each condition.
- [ ] **F6.3 Fixed-date due rule** for Form C (30 Nov of the YA, with 15 Dec as a dated option until YA 2027).
  ✔ The generated date matches the Year Planner.
- [ ] **F6.4 Load 10x's 30 SG rules** through supersede of `sg-draft@2026.10` (`rulepack-intl.ts:85`), **not** as a second pack beside it, which would create a duplicate rule chain. A partner confirms each rule.
  ✔ Exactly one rule chain per filing. An unconfirmed rule generates nothing.
- [ ] **F6.5 Calendar check.**
  ✔ For each sample profile, the generated dates equal the Year Planner's dates.
- [ ] **F6.6 Evaluator `sg.gst.registration@1`:** a running total of taxable supplies against S$1,000,000, which suggests a profile change when crossed (company E).
  ✔ Golden cases, and E gets a signal, not an F5.
- [ ] **F6.7 Evaluator `sg.gst.f5_draft@1`:** a draft of boxes 1–8 as a working paper on the F5 filing task.
  ✔ It matches F3.9.
- [ ] **F6.8 Evaluator `sg.wht.payment@1`:** withholding tax due by the 15th of the second month after payment, at the rate for the payment type (company D).
  ✔ Golden cases for company D.
- [ ] **F6.9 Signals** appear on the Key Manager's desk as "indicative". They never change a profile or a filing by themselves, and never reach the portal.
  ✔ A test proves that no portal route can read a signal.

## F7: Law changes (T4.6)

Estimate: 4–6 days. This is v3.2 §16.

- [ ] **F7.1 Tables:** `fin.rule_change`, `law_source`, `law_item` and `watch_run`. A CHECK enforces approver ≠ proposer.
  ✔ The integration test refuses self-approval.
- [ ] **F7.2 Watcher**, daily at 06:00 Singapore time. Sources: SSO RSS, IRAS e-Tax guides and news, ACRA news, and the CPF employer hub (by page comparison where there is no feed).
  ✔ A fixture feed produces items, and a quiet source produces a health item.
- [ ] **F7.3 Law update desk item and daily email** (the mail transport from T7.0 exists). Closing an item means "no change for us", with a reason, or turning it into a proposal.
  ✔ A browser walk, and the email appears in the log transport.
- [ ] **F7.4 Proposal to approval.** Add `compliance:approve` here (Partner by default), with a role-seed migration.
  - A different person approves.
  - Golden cases must pass.
  - The affected clients are listed, and each one's owner is told.
  - Only an enacted or in-force change applies.
  ✔ An end-to-end test on a sample rate change.
- [ ] **F7.5 Weekly digest** of non-matching items, and watcher health items.
  ✔ Nothing is dropped silently (a test proves every item reaches a digest or the desk).

## S: Scorecard

Estimate: 2–3 days, built alongside the phases. This is v3.2 §18.

- [ ] **S.1 One command** (`scripts/fin-scorecard.ts`) runs the pipeline on folders 00–07 and compares the results with `99_Ground_Truth`. It reports A–D tuned and E held out (unseen) separately.
- [ ] **S.2 Stage 1, extraction:** digital **≥ 98%**, scanned **≥ 90%**, photo **≥ 85%** field accuracy (after F2.5).
- [ ] **S.3 Stage 2, bank reconciliation:** **≥ 95%** of lines matched correctly (after F3.5).
- [ ] **S.4 Stage 3, ledger:** the trial balance per account and F5 boxes 6/7/8 per quarter match **exactly to the cent** (after F3.9).
- [ ] **S.5 Stage 4, exceptions:** **47 of 47** caught, and every extra flag is listed one by one and explained (after F4.5).
- [ ] **S.6 Calendar:** generated dates equal the Year Planner's (after F6.5).
- [ ] **S.7 Patterns backtest** numbers are reported in their own section and do not count toward stage 4 (after F5.6).

## F9: Ship to QA

Estimate: 2–3 days.

- [ ] **F9.1 Isolation drill.** Make the fin job fail, make the AI unreachable, turn the flag off, and slow a fin query.
  ✔ The CRM is unaffected in each case, recorded in the Log.
- [ ] **F9.2 Gates.** Backend `npm run check` and `npm run test:integration` pass; frontend `npm run check` passes; a migration order audit (`migrations/README.md`) shows no diff.
- [ ] **F9.3 Deploy.**
  - `terraform apply` for F0.9.
  - Migrate QA.
  - Deploy the API, worker, fin job and frontend (manual gcloud deploys; the pre-push hook needs Node 22).
  ✔ `/version` shows the new build, and the fin job runs on schedule.
- [ ] **F9.4 Enable for a test firm only.** Fin stays off for 10x's live firm. Use `PUT /internal/v1/tenants/{id}/fin` with a key carrying `tenant.provision`.
  ✔ Check `fin_enabled` per tenant on QA.
- [ ] **F9.5 Browser walk** as staff and as a client on the pack: every screen, the review load, and minutes per client-month.
- [ ] **F9.6 Walkthrough with 10x.**

---

## Milestones ("done means", from v3.2 §22)

The dates are v3.2's, which assumed two people. With one person, expect about twice as long; reset the dates after F0.

### M1: end to end on test data (v3.2: Tue 20 Oct)
- [ ] The scorecard runs in one command and reports stage 1 per format and stage 4 for the 27 document exceptions, with A–D and E shown separately.
- [ ] F5 boxes 6/7/8 match the answer key per quarter for A–D, and E gets a GST threshold signal.
- [ ] 10x's 30 rules plus profiles generate the Year Planner's dates.
- [ ] "Monthly close" raises asks with due dates in a sandbox portal. Uploads of any type are read or put on the desk as manual, and staff review by exception.
- [ ] `npm run check` passes, the flow is walked in a browser, and with the flag off the CRM is untouched.

### M2: ready for 10x, on QA (v3.2: Sat 31 Oct)
- [ ] The scorecard covers all four stages, 47 of 47 exceptions with extras listed, and the trial balance and F5 come from the ledger.
- [ ] The vendor-pattern panel works on the pack (F5, pulled forward).
- [ ] Law updates work both ways with second-person approval, and withholding tax works for company D.
- [ ] The isolation drill passes, fin is deployed to QA in a test firm, and it has been walked through with 10x.

**If M2 runs late, drop in this order** (from v3.2 §7): law-desk screens first (keep the email and desk items), then withholding tax, then payroll templates beyond the first three, then combined-payment matching.

### Phase 1b (v3.2: 16 Nov – 11 Dec)
- [ ] Form C-S evaluator; card-to-receipt matching; FX gains and losses; payroll postings; journal export; AI law summaries; Done gates; a dedicated database role.

## Later (not tracked yet)
India pack (GST and TDS evaluators, Tally intake); GSTR-2B and IRAS register checks; InvoiceNow (Peppol) intake; more watchers (India, UAE, US); client reports.

---

## Log

| Date | Task | Commit | Note |
|---|---|---|---|
| 2026-10-10 | F0.1 | — | Plan written on `feat/fin`, from v3.2 checked against the code. |
| 2026-10-10 | F0.2–F0.5, F0.7, F2.1, F2.2 | d530d7c | First vertical slice: an upload in a fin-enabled firm is taken in by `npm run fin:once`, routed, and listed at `GET /api/v1/fin/intake`. Migrations 0381–0382. `npm run check` passes (3560 tests) and `npm run test:integration` passes (1130) **on Node 22**. On Node 20, `tests/fx/feeds.test.ts` fails the same way on `main`, so that failure predates fin. |
| 2026-10-10 | F0.10 | (this commit) | Training-pack loader and the `/internal` fin switch. Loaded all 1,168 pack files into a local sandbox, and fin took them all in (pdf 840 · sheet 222 · image 101 · manual 5). Found that `/internal/v1/tenants/{id}/status` cannot record its event (system actor with a non-null id); listed under open decisions. `check` 3574 and `test:integration` 1131 pass on Node 22. |
| 2026-10-10 | decision | (this commit) | Document kind for books files: option B. `0383_books_input_kind`; fin takes only `books_input`. Frontend `feat/fin` adds the labels and regenerated API types. Checked against the real API: a `books_input` upload is taken in and an `other` upload is left alone. The 1,168 sandbox files were loaded as `other` before this, so their intake items stand; a fresh `fin:pack` files as `books_input`. `check` 3575 and `test:integration` 1131 pass. |
