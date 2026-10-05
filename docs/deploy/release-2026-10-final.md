# Release 2026-10-final: S1-S5 on top of release/2026-10-05, then hardening

> **For Anish.** Merge only **`release/2026-10-final`**, in both repos. It CONTAINS
> `release/2026-10-05` (company calendar, Work vs Billing, signatories, multi-currency) and the five
> build sessions of 5 Oct (S1-S5), so merging it replaces merging any of them. Nothing is merged to
> `main` yet and nothing is on QA. The same note is in the backend repo at
> `docs/deploy/release-2026-10-final.md`.
>
> **After this release: feature freeze until 10x finishes UAT** (Shrestha, 2026-10-05). Only bug
> fixes. The test sheet for 10x is `bib/qa/BiB_UAT_10x_2026-10.xlsx`.

Prepared by Shrestha's session S7 on 2026-10-05.

## What is in it, in plain words

From `release/2026-10-05` (see its note, `docs/deploy/release-2026-10-05.md`):
- each company's own financial year and time zone (Q036); arrears bills on the period's last day (Q042);
- Work vs Billing (Q041); several signatories (Q005); several currencies and the daily FX rate (Q006, Q008-Q011).

From the five sessions of 5 Oct:
1. **S1 quick wins.**
   - A new lead must be assigned, and its owner and the admins hear of it (Q066).
   - Automatic billing starts from a month the firm picks (Q027).
   - Client emails carry the SPOC's name and Reply-To (Q059).
   - A group's portal contact can be given the sister companies (Q064).
   - A client company needs a country and kind, and abroad a year end; it is quoted only once registered (Q076).
2. **S2.**
   - A yearly service is billed on its filing's due date, with "Raise invoice now" (Q071).
   - Each letter records who won it, and there is a Revenue report by manager or originator (Q049).
3. **S3.**
   - Finishing a GST month job files that month's returns (Q063).
   - Each filing is judged on its own country's clock (Q070 Part B).
   - A client can carry the VAT period its authority assigned (Q073).
   - Draft UAE, Singapore and US rule packs (Q074).
4. **S4.** An advance taken before the letter can be raised, mapped to services, re-mapped and reminded (Q044-Q048).
5. **S5.** The GST tax invoice (Rule 46) and the TDS line (Q056 without e-invoicing, Q057).

S7, finishing promised work (each its own commit, approved by Shrestha):
6. The **Revenue report** splits an ad-hoc advance by the managers and the letters it was mapped to.
7. **A filing's filed date is its own country's day**, not the server's UTC day. A return filed at
   04:30 IST read as the day before.
8. **Q071(d):** a quarterly service like UAE VAT is billed on the client's own VAT quarter (Feb-Apr...),
   on each quarter's last day. Quarters already billed are never re-cut.
9. **A period job's task cannot be marked done before its period ends** (`JOB_PERIOD_NOT_ENDED`). Inside
   the month the job has no steps yet, so an early "done" filed returns no checklist ran for.
10. **A GST tax invoice is marked "Original for recipient"** (Rule 48).
11. Two merge follow-ups the textual merge missed:
    - an ad-hoc advance's invoice gets its GST split like any other draft;
    - Setup counts sixteen lines.

S7 hardening (no features):
12. **Gates with nothing excused.**
    - Smoke paces itself under the 300/min limit and refuses to run against a deployed API.
    - The slow PDF / route tests get their own 30 s timeout. The global default stays 5 s.
13. **Nothing unfinished on a screen.**
    - `/copilot` answers 404 unless `NEXT_PUBLIC_BIB_COPILOT=on` (nothing sets it).
    - `GET/PUT /tenancy/firm-signatory` are **deprecated**, not removed. QA tools still call them. They carry a `Deprecation` header and the spec flag.
14. **Security (audit of 2026-09-23), the code items.**
    - **F-06-2:** statement, idle-in-transaction and connect timeouts on every app connection.
    - **F-17-1:** `uuid` 11.1.1 for gaxios via an npm override; hono 4.13.13.
    - **F-14-1:** an upload's bytes must match its type (`CONTENT_NOT_OF_TYPE`).
    - **F-9-2:** the xlsx reader has size, column and row bounds.
    - **F-18-6:** the runbook now runs `scripts/postdeploy-check.sh`, which only reads.
    - F-06-1 was already fixed by 0336.
15. **The board tells the truth.**
    - T6.17 and T6.18 verified and ticked.
    - Everything built since is listed as T6.19-T6.31.
    - T4/T5/T7 and S6 are marked "Not in v1".

## Commits

| Repo | base `release/2026-10-05` | release head |
|---|---|---|
| bib-backend | 021345e | **the head of release/2026-10-final** (this note) |
| bib-frontend | 1770ee8 | **the head of release/2026-10-final** |

Merges, in this order (each `--no-ff`):
- backend: S1 6e6d036, S3 0dd7025, S2 2919e33, S5 cf90376, S4 aaeb59b;
- frontend: 538cfbb, 3a3c0f8, 0ecb258, 3b8aee4, 38ce349.

Conflicts (all resolved keeping both sides):
- `CLAUDE.md`;
- the client-import column list (Financial Year End + Tax Return Period);
- the billing imports (go-live + bill label);
- the ledger catalogue and EVENT-CONTRACT (`invoice.issued` + originator);
- `setup/server.ts` (companies' bank/LUT + early + adhoc);
- `desk.ts` settings (go-live + reminder day);
- the API test imports;
- the signed-letter freeze `NOT_TERMS` (originator + advance allocation);
- frontend Your firm (go-live, client emails, reminder day), the letter page imports, Invoices tabs and readiness words.

`schema.d.ts` was regenerated from the merged API.

## Migrations: run in order on QA's database

**0350, 0354, 0355, 0357, 0358, 0359, 0360, 0363, 0364, 0369, 0370, 0371.** All lane B. `npm run migrate`
applies them in this order. They come on top of release-2026-10-05's 0337-0339 and 0343-0345, if QA
does not have those yet.

| # | What | Data change |
|---|---|---|
| 0350 | `tenancy.tenant.send_from_domains` | none (empty list) |
| 0354 | bill dated by a filing (`billing_due.dated_by_filing_id`) | none |
| 0355 | `crm.letter_originator` + view | none (defaults read off the deal) |
| 0357 | `obligation_instance.filed_by_work_item_id` | backfilled from `work_item_id` |
| 0358 | `period_basis` on rules and filings | none; every rule stays `rule_calendar`. Down refuses while a rule follows the client's year end |
| 0359 | client return periods, `authority_assigned` basis | none. Down refuses while a rule uses it |
| 0360 | return periods are cleared, never deleted | none |
| 0363 | ad-hoc advance, allocations, `invoice_manager_share`, reminder day | `advance_pool` rebuilt; 0320 rows keep their numbers |
| 0364 | `advance:manage` on Partner/Manager/admin roles | roles re-published (0335's method) |
| 0369 | company bank accounts and LUTs | none |
| 0370 | GST snapshot on invoices, SAC on lines, views appended | existing invoices (tax_treatment NULL) compute exactly as before |
| 0371 | client TDS, `payment.tds_amount` | none |

**0375-0379 (S7's range) are unused.** The next free lane-B number is 0372 (S5's 0372-0374 are also free), then 0380.

- Round trip on a fresh database: 0371 → 0350 down, then up again. Clean.
- The integration suite on the round-tripped schema: **1,121 / 1,121**.

## Env vars and config

**Nothing must be set.** New settings, each with a safe default:

| Variable | Default | What |
|---|---|---|
| `BIB_DB_STATEMENT_TIMEOUT_MS` | 30000 | F-06-2: Postgres ends a statement after this |
| `BIB_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000 | F-06-2: and a transaction left idle |
| `BIB_DB_CONNECT_TIMEOUT_S` | 10 | connecting gives up |
| `NEXT_PUBLIC_BIB_COPILOT` (frontend) | unset | `on` shows `/copilot`; leave it unset |

`BIB_FX_*` came with release-2026-10-05; see its note.

- No Terraform change.
- **No deploy config was touched.**
- `package.json` gained an `overrides` block (uuid for gaxios) and hono ^4.13.13. Run `npm ci` as usual.

## Deploy

1. The GitHub `deploy` workflow still fails (the GCP auth secret is missing): deploy by hand as on 10-04,
   or set the secret first.
2. Backend first (migrations run, the worker gets the new queues), then the frontend.
3. Verify with `API=<api> WEB=<web> COMMIT=<sha> bash scripts/postdeploy-check.sh` (read-only).
   **Do not run `npm run smoke` against QA** (F-18-6): it creates firms with known passwords that
   cannot be deleted, and it now refuses a remote API anyway.

## After deploy, on QA (each only with Shrestha's yes)

1. **Q075:** Your firm → Companies, every 10x company April-March, and its time zone:
   - India `Asia/Kolkata`;
   - UAE `Asia/Dubai`;
   - Singapore `Asia/Singapore`;
   - US `America/Los_Angeles`.
2. **Automatic billing:**
   - run `scripts/billing-preflight.sql` first;
   - pick the go-live month ("Starts from");
   - only then switch it on.
3. **Sending domains (Q059):** leave Your firm → Client emails EMPTY until the mail provider is set up for
   10x's domain (SPF, DKIM, DMARC alignment). Until then, client emails show the SPOC's name and Reply-To,
   from `BIB_MAIL_FROM`.
4. **GST:**
   - each company's bank account;
   - the India company's GSTIN and this year's LUT;
   - each Indian service's SAC and GST rate (Setup lists the gaps).
   Drafts made before the deploy re-decide their tax when opened.
5. **Setup:** fill each client's country / kind / year end (Q076), and UAE clients' VAT periods (Q073).
6. **Rules:** "Filings for other countries" may be loaded, but link nothing to a service until 10x
   confirms `bib/qa/intl-rule-packs-draft-2026-10.xlsx` (Q074).
7. Hand 10x `bib/qa/BiB_UAT_10x_2026-10.xlsx`.

## Gates (2026-10-05, on `bib_final`)

| Gate | Result |
|---|---|
| `npm run migrate` from zero | 0350 → 0371 in order |
| Down 0371 → 0350, up again (fresh DB) | clean; integration on it 1,121 / 1,121 |
| Backend `npm run check` (foreground) | **172 files, 3,528 tests** |
| Integration, fresh DB, run twice | **1,113 / 1,113**, then **1,118 / 1,118** with smoke, demo and walk data in it |
| Smoke | **264 passed, 0 failed** (346 requests); again 264 / 0 with `SMOKE_BUDGET=120` (it waited six times) |
| `npm run demo` + `demo:verify` | **73 / 73** |
| `worker:once` on `bib_final` | every queue ran; per-firm failures only on integration tests' half-seeded firms (the sweep carries on) |
| Two full unit runs at once (load) | 3,522 / 3,522 each, no timeout |
| Frontend `api:generate` + `next typegen` + `npm run check` | green |
| `npm audit --omit=dev` | 1 left: nodemailer (high), see below |
| Routes with no screen | 339 routes, 9 without: 6 `/internal`, 2 deprecated firm-signatory, `GET /advances/{id}` (its list carries the same schema) |
| Browser walks (Playwright, `bib_final`) | **373 / 373**, see below |

### Browser walks

**373 / 373** on fresh fixtures, one walk at a time:
| Walk | Checks |
|---|---|
| cfy-walk (company year and clock) | 30/30 |
| q042-walk | 6/6 |
| sig-walk | 24/24 |
| mc-walk | 33/33 |
| wvb-walk | 50/50 |
| qw-walk (S1) | 38/38 |
| bdr-walk q071 | 38/38 |
| bdr-walk q049 | 29/29 |
| adv-walk (S4) | 50/50 |
| gst-walk (S5) | 46/46 |
| s3-vat-walk | 17/17 |
| **s7-walk (S7's own states)** | **12/12** |

Not counted, and why:
- **s3-walk** did not re-run cleanly. Two walk drivers overlapped for a while (one survived a stop), so S3's fixture went in twice; the walk then found no GSTR-1 Sep to link. S3's behaviour is held by `job-filings` / `intl-calendar` integration, s3-vat 17/17 and s7-walk's filed-day check.
- **ai-walk** passed its first 51 checks, then met a field label that release-2026-10-05's FX feed renamed ("Rate on").
- **ai-adv / ai-t3 / ai-t4 / nt** were not re-run: the machine ran short of memory, and the auto-invoice and notifications release is already in `main`.

Walk scripts that were stale against S1 (Q076 registration, Q027 go-live) or raced were fixed in `bib/demo-assets/tools`:
- cfy, q042;
- sig (send race);
- adv-fixture;
- gst-fixture;
- s3 (ids by name);
- ai-walk.

## Left for Anish and Shrestha: infrastructure and product, not changed here

| Item | What | Who |
|---|---|---|
| F-15-1 / F-15-2 / F-15-3 / F-15-5 / F-15-6 | the rate limiter is per instance (×N on Cloud Run, Redis behind the existing port); IPv6 /64 rotation; one office NAT = one bucket; 25 MB uploads in memory; `TRUSTED_PROXY_HOPS` vs a future load balancer | Anish (infra) |
| F-11-1 | CSP `script-src 'unsafe-inline'`: a nonce needs the frontend's serving set up for it | Anish |
| F-11-2 | `SameSite=None` because API and app are two `run.app` origins: one custom domain fixes it | Anish |
| F-16-1 | personal data cannot be erased (DPDP / GDPR request) | Shrestha (product decision) |
| Uploads | malware scanning at the storage layer; whether the portal keeps taking legacy `.doc` / `.xls` (can carry macros) | Anish + Shrestha |
| nodemailer <= 10.0.8 | high advisory (DNS cache across transports, address-parser DoS); fix is the 10.x major, a breaking change to the mail path | after UAT |
| F-02-1, F-07-2, F-07-3 and the Lows | unchanged; see `bib/important docs/00-README.md` | later |

## Known, and decided to wait for UAT

- A compliance rule's own Dept. Shrestha: "abhi blank rehne do, fix krlenge baad me". Today a rule takes the Dept of the service it is linked to.
- A credit note has no PDF of its own (so no GST Rule 53 layout). A new document, after UAT.
- The round-off line on a tax invoice: asked of 10x (Q087).
- SEZ recipients, pure-agent reimbursements and Form 16A tracking: not built (S5).
- An ad-hoc advance whose letter never comes: given back by credit note, as S4 built.
