# CLAUDE.md — bib-backend

Loaded into every session in this repo: the rules in force, then an index into `docs/claude/`,
where the reasoning, the decisions and the history of each area live. Most rules are enforced by
`npm run check` and CI, so breaking one does not merge. When something is unclear, stop and ask;
do not fill the gap with a guess.

Companion docs: `HANDOFF.md` (why the product exists, the ADRs) · `CONTRIBUTING.md` (the PR gate)
· `migrations/README.md` (migration rules) · `docs/MERGE_BUILD-PLAN.md` (the live task board;
`docs/BUILD-PLAN.md` is superseded) · `docs/EVENT-CONTRACT.md` (read before emitting an event) ·
the approved demo repo `10xcrm` (`/Users/anishumar/Desktop/10xcrm` on Anish's machine) is prior art.

## What this is

The API for **BiB (Business in a Box)**: multi-tenant **B2B2C** SaaS for professional-services
firms. Many firms (tenants); each firm's staff **and** its clients log in. Sold to customers, so
it must scale, stay reliable and be operable by a small team. Node + TypeScript, Hono,
postgres.js, Postgres + RLS, hexagonal. The frontend is a separate repo and a separate origin.

Two processes: the API (`src/cmd/server.ts`, composed in `setup/server.ts`) and the worker
(`src/cmd/worker.ts`, `setup/worker.ts`) that runs the sweeps on pg-boss. A module is one
`src/usecase/<area>` with its `domain/`, adapters and handler; `ls src/usecase` is the list.

## No bandaids — the absolute rules

- **No TODO / FIXME / placeholder / stub-that-lies.** Finished code, or an explicit stub that
  fails honestly. ESLint `no-warning-comments`.
- **No `any`.** **No unhandled promises** (`no-floating-promises`).
- **`process.env` is read only in `src/config`** (`no-restricted-properties`).
- **No `console` outside `src/cmd`.** Use the injected logger; use cases hold no logger.
- **Actionable errors only**: name the variable, the bad value, the valid set.
- **A red gate means the work is not done.** Fix it; never disable the rule. A rule that is
  genuinely wrong is argued in the PR and changed in its own commit, never dodged.
- **Stub adapters are gated** (dev `x-user-id` resolver, logging mailer, attested e-sign signer,
  filesystem blob store): `validateServer` refuses them in a production-like boot and
  `tests/config/boot-gates.test.ts` proves each refusal. A new stub gets the same treatment.

## The layer rule: imports point inward

```
domain  ──▶  usecase  ──▶  api / infrastructure  ──▶  setup  ──▶  cmd
```
A layer depends only on layers to its left. Enforced by dependency-cruiser (`npm run arch`, and
re-run in `tests/architecture/arch.test.ts`).

| Directory | Is | May import | May NOT import |
|---|---|---|---|
| `src/domain/<agg>` | nouns + sentinel errors, pure | stdlib only | anything internal |
| `src/usecase/<area>` | services + `ports.ts` | domain, platform | infra, api, db, config, setup |
| `src/api` | HTTP transport (router, handlers, envelope) | usecase, domain, platform | infrastructure, db |
| `src/infrastructure/<vendor>` | driven adapters | usecase (ports), domain, db | api |
| `src/db` | pool + tenant resolver + boot check | config | domain, usecase, api |
| `src/config` | the env adapter | — | domain, usecase |
| `src/platform` | tiny primitives (ids, callctx) | stdlib | everything else |
| `src/setup` | **composition root: the only place concrete meets interface** | everything | — |
| `src/cmd` | process shell (server, worker, migrate) | setup, config | domain/usecase/api |

**Ports live beside the use case that needs them** (`usecase/<area>/ports.ts`), never in a shared
package. Two use cases never import each other: each declares the one method it needs and
`setup/` satisfies it (in BOTH processes when both run it). Adapters translate vendor types at
the door; no vendor type or value crosses into domain/usecase.

## The tenant wall — a leak is silent, so it is defended three times

1. **RLS.** Every business table: `tenant_id NOT NULL` + `ENABLE ROW LEVEL SECURITY` + a policy.
   The app role `bib_app` is `NOBYPASSRLS`. **Every reference between tenant-scoped tables
   carries the tenant**: a composite `UNIQUE (id, tenant_id)` on the target, referenced as
   `(fk_id, tenant_id)` (an FK check bypasses RLS). `tests/architecture/tenant-keys.integration.test.ts`
   reads the catalogue, so a new id-only FK fails the build.
2. **The resolver.** Tenant data is reached only through `withTenant` / `withIdentity` /
   `withPortal` (`src/db/tenant.ts`, `SET LOCAL` inside a transaction). The raw pool is importable
   only by `db/`, `infrastructure/`, `setup/`.
3. **The boot check.** `src/db/boot-check.ts` refuses to start if the app role can bypass RLS.

- **Identity is above tenant (ADR-02).** A login is a global `user_account`; `membership(user ×
  tenant × audience × role)` is the join. `user_account` and `tenant` are GLOBAL tables; so is
  the `fx` rate table. Everything else is tenant-scoped (or carries a `-- GLOBAL:` justification).
- **Four scoping gates** on every read: (1) tenant [RLS], (2) audience [STAFF | CLIENT_PORTAL],
  (3) role, (4) record scope [a portal login sees only the companies it was GRANTED,
  `crm.portal_access`]. Gates 2 and 3 are prefix middleware (`api/guards.ts`), **denied by
  default**: a portal session reaches only `PORTAL_PATHS`; a route absent from `ROUTE_PERMISSIONS`
  is refused to everyone. Roles are config rows the firm owns; there is no fallback to defaults.
- **Fees are a fifth, orthogonal axis** — a flag on membership, never a role. Money is REDACTED
  (null), never the record omitted; setting a figure needs seeing it (`requireFees`); a document
  that prints fees is refused whole.
- **A portal read is three things**: an entry in `PORTAL_PATHS`, an entry in the permission
  tables, and a query through `withPortal` with a RESTRICTIVE policy on every table it reads.
  A restrictive narrowing must be written `NOT crm.is_portal_session() OR <condition>` or it
  narrows the firm's own workspace too.
- App-facing routes take the tenant from the **session**, never the path (`api/scope.ts`).

Details: `docs/claude/tenancy-and-rls.md`, `docs/claude/client-portal.md`.

## Money

- Money = amount + currency + FX rate + rate date. `numeric` in the database, **never a float and
  never a JS number**. Amounts travel and sit in JSON as **decimal strings** (`"1499.50"`); only
  the database adds them up. The rate is stored even when the currencies match (1, dated).
- The firm's **reporting currency is a column on `tenancy.tenant`** (0009), required at creation,
  never updated: every stored rate is struck against it. Normalise a currency code before
  comparing or storing (`domain/money/model.ts`).
- A proposal or letter may price lines in several currencies (0344); a tax invoice is one
  currency. Nothing is converted silently; a stored rate is the record.
- Totals and balances are `security_invoker` views (a plain view runs as its owner and bypasses
  RLS). There is no `paid` status or `amount_paid` cache: balances are computed.

## Records: the ledger, and nothing is deleted

- **Every state transition writes an event.** Depend on the `EventSink` port
  (`usecase/ledger/ports.ts`) and call `recordEvent()` after the change commits. The verb comes
  from the closed registry in `domain/ledger/model.ts`. The payload holds ids, codes, counts and
  machine facts, **never personal data or prose** (names, notes, reasons stay on the erasable
  row). The actor's name is a read-time join, never stored. Read `docs/EVENT-CONTRACT.md` first.
- **No hard deletes.** `bib_app` holds no DELETE grant on business tables (the few exceptions are
  listed in `ledger-and-records.md`). A client made by mistake is ARCHIVED; a lead or draft
  made by mistake is `deleted_at` (0086, hidden, final); a line struck off a draft is
  `removed_at`; a wrong invoice is CANCELLED; a reversal is a new signed row.
- **Append-only is a GRANT, not a trigger.** Schema default privileges give `bib_app` UPDATE on
  every new table, so an append-only table REVOKEs before it GRANTs (check with
  `has_table_privilege`).
- Every unique constraint is consciously scoped (say so in the migration comment). External
  callbacks are idempotent by derived id (`platform/ids.ts` `derivedId`). Every trigger the
  engine touches is at-least-once: idempotence is a unique key + `ON CONFLICT DO NOTHING`, and
  the event is written only when a row was created.

## Dates, instants and whose calendar

The field's TYPE decides the rule, and getting it backwards is silent east or west of UTC.

- **A `date` column is a DAY.** postgres.js returns it at UTC midnight: read its UTC fields
  (`toDay` in `infrastructure/postgres/day.ts`) or select `::text`. Never `getFullYear/
  getMonth/getDate` in an adapter (`tests/architecture/calendar-day.test.ts`).
- **A `timestamptz` is an INSTANT.** Emit it with `isoInstant` (`infrastructure/postgres/
  instant.ts`), never `_at::text` (session-zone, not ISO). A day from an instant names its zone
  (`utcDayOf`, `AT TIME ZONE`): never a slice, never a bare `_at::date` (`instant-format.test.ts`).
- **"Today" and "this month" for the FIRM** are `tenancy.tenant.time_zone`:
  `dayInZone(clock.now(), zone)`, resolved per firm per pass in every sweep. Never `CURRENT_DATE`
  or the server's day (`firm-day-reads.test.ts`). Reminders to people stay on the firm's day.
- **A company's document** (invoice date and number year, letter, proposal, engagement dates,
  billing periods) uses that company's zone and year, else the firm's (0337; `crm.issuer_zone`,
  `companyCalendars`). **A filing** uses its own zone (`FILING_ZONE`).
- **A caller's `asOf` on a write** is held to the firm's (or company's) day ±1
  (`isCallersToday`, `NOT_CALLERS_TODAY`); a record that belongs to another day has its own field.
- **A moment shown to a person** is rendered in the reader's zone, client-side; an email names
  its zone in words.
- Period and deadline arithmetic is pure, on `YYYY-MM-DD` strings, no `Date`; quarters align to
  the financial year. A date must be a real day (`isCalendarDay`, `domain/day.ts`).

Details: `docs/claude/dates-and-timezones.md`.

## Migrations

- `migrations/NNNN_name.{up,down}.sql`. Lanes: **(A) 0080–0299, (B) 0300–0400**; the number is
  not the apply order, so never depend on another lane's lower number. See `migrations/README.md`.
- **Immutable once applied**: never edit or renumber; fix forward with a new number. A number
  drawn and shipped is never renumbered.
- `SET ROLE bib_owner` around DDL. A new business table gets `tenant_id` + RLS + policy +
  composite keys, or an explicit `-- GLOBAL:` justification.
- `npm run migrate` wraps each file in a transaction, but a down is run by hand against a
  database somebody is rescuing: add a replacement constraint before dropping the old one.
- A published config body is frozen, so changing a default role or default grade ladder is a
  migration republishing it for firms still at the default (`tests/config/seed-parity.test.ts`,
  `tests/staffgrade/seed-parity.test.ts`). A new permission is such a migration.
- A signed letter is frozen whole (0019): a new `crm.engagement_letter` column is frozen the day
  it exists, and no NOT NULL column can be added to a letter line.

## Config is an adapter

`src/config/config.ts` is the only `process.env` reader. Add a key in two places: the zod schema
there **and** `.env.example`. Parse into typed values at the boundary; validate in
`validate.ts` and fail closed.

## Traps that recur

Each of these shipped at least once and passed every unit test.

- **An error family or code not mapped in `api/domainerr.ts` answers 500.** Each family's switch
  ends `default: return unmapped(err.code)` (`never`), so a new code is a compile error until
  mapped. Map it in the same commit.
- **A registered verb, flag or column with no writer — or no reader — is unfinished**, whatever
  its tests say. When you add a write, name the read that proves it.
- **If you add SQL, run it** (a fake repository proves nothing about the statement). postgres.js
  re-encodes a string parameter as JSON (write `${json}::text::jsonb`), sends parameters untyped
  (`${d}::date + ${n}::int`), and rounds a timestamp parameter to milliseconds.
- **A boolean query parameter is never `z.coerce.boolean()`** (`Boolean("false")` is true). Use
  `z.enum(["true","false"]).transform(...)`; `tests/api/query-booleans.test.ts` guards it.
- **BEFORE triggers fire in name order**: a wall trigger on a frozen table is named to sort after
  the freeze, so a change to a signed or issued row is refused as that.
- **A rule a writer must not walk past is a constraint or trigger, not a service check**; the
  service checks first so a person is TOLD in words, the database is the wall for imports,
  scripts and agents.
- **A published config body is frozen**: a new field is optional and absent means the old
  behaviour; never rewrite published bodies.
- **Lists return read models with names, not ids**; handlers map field by field and never
  forward a domain object (zod-openapi documents without validating, so an unmapped field is
  invisible to the generated client). A read tells the caller what it may do (`/auth/me`
  permissions, `deleteRefusal`, `issueBlocked`, `viewer.mayComplete`), so a screen offers only
  what will work.
- **curl does not preflight.** CORS gaps only show in a browser; `tests/api/cors-methods.test.ts`
  checks every registered verb is allowed.
- **Nothing is invented for the firm**: no seeded ladder, threshold, due date or rule a firm has
  not confirmed. Absent config means the safe direction for that feature (stated per feature).
- **One statement of a rule.** When two readers must agree (generator and coverage, router and
  preview, sweep and Work vs Billing), they call one function or one SQL fragment.

## How to add things

- **A route** → `src/api/router.ts` (all routes in one file) + a handler method in
  `src/api/handler/`. The handler parses, calls one use-case method, maps the result field by
  field. Add it to `ROUTE_PERMISSIONS` (or `NO_PERMISSION_REQUIRED`); `tests/api/auth-coverage.test.ts`
  enumerates every registered route. A public route (`PUBLIC_ROUTES`) needs an argument written
  beside it; `/internal/…` is the platform's S2S surface (`ROUTE_CAPABILITIES`).
- **A business rule** → `usecase/<area>/service.ts`; anything external is a port in `ports.ts`,
  injected. Never import an adapter.
- **Something a firm changes without a deploy** → a `kind` in the configuration registry: a body
  validator in `domain/config/model.ts` + the `config.entry` CHECK. Versioning, publishing,
  freezing and pinning exist (`docs/claude/config-registry.md`).
- **An external system** → an adapter in `infrastructure/` implementing the port; wire it in
  `setup/` (and in the worker if the worker runs it).
- **A new module** → mirror `tenancy/`: `domain/<agg>`, `usecase/<area>`, `infrastructure/`,
  handler + routes, fakes in `testfakes/`, tests. **Build the screen alongside it**; the screen
  asks the questions tests do not.
- **A ledger verb** → the registry in `domain/ledger/model.ts`; if it carries money, name the
  fields in `domain/ledger/fees.ts` (`tests/ledger/fees.test.ts`).
- **A new feature's notes** → a `docs/claude/` file (new or extended) and at most one index line
  below. Never a new section here.

## The commands

```bash
npm run dev              # API, tsx watch, :8080 (/health, /docs, /openapi.json)
npm run worker           # the worker process (sweeps, queues), tsx watch
npm run worker:once      # every sweep once, no queue in front: a different entry, never a different rule
npm run migrate          # apply pending migrations (owner role; ensures bib_owner/bib_app)
npm run check            # typecheck + lint + arch + test  <- THE GATE; pre-push hook and CI run it
npm test                 # vitest: unit + the architecture test (no services needed)
npm run test:integration # needs a migrated local DB; NOT in `check`; single-threaded
npm run arch             # the import wall alone
npm run smoke            # end-to-end against a RUNNING server; paces itself (SMOKE_BUDGET); Git Bash
npm run demo:fresh       # DESTROYS the local database volume, re-migrates, seeds 10x Global
npm run demo:verify      # reads the demo firm back and asserts its facts
npm run build            # tsup -> dist/
```

A single test: `npx vitest run tests/lead/service.test.ts -t "duplicate capture"`; an integration
file: `npx vitest run --config vitest.integration.config.ts tests/ledger/immutability.integration.test.ts`.
Unit and integration are split by filename (`*.integration.test.ts`). Slow files raise their own
timeout (`vi.setConfig`), never the global one.

## Comments — short, and only the why

- Write WHY, never WHAT the code already says. Default is one line; a short block only for a
  non-obvious decision, a trap, or a client fact — cite its id (Q071, T6.15, 0339).
- No history ("used to", "before 0086"), no restating the code, no repeating a rule documented
  elsewhere — point to it (`see docs/claude/<topic>.md`).
- Exported types/functions: a one-line doc comment unless the contract is genuinely subtle.
- Aim for ≤ ~15 comment lines per 100 lines of code. Long design reasoning belongs in
  `docs/claude/`, not in source.
- This file holds rules + the index only. A new feature adds or extends a `docs/claude/` file
  and at most one index line here — never a new section in CLAUDE.md.

## Index — read the file before working on the area

| Working on | Read |
|---|---|
| RLS, composite keys, portal grants (gate 4), roles as rows, the fee wall | `docs/claude/tenancy-and-rls.md` |
| Config registry: kinds, publish/freeze/pin, role seeding | `docs/claude/config-registry.md` |
| Setup readiness, roster, grades, Depts/teams, work split axis | `docs/claude/firm-setup-and-structure.md` |
| Sign-in, sessions, internal keys, public routes, passwords | `docs/claude/auth-and-sessions.md` |
| CORS, rate limits, DB timeouts, uploads, release hardening, `/health` | `docs/claude/security-and-operations.md` |
| Mail transport, senders, notifications (bell + email) | `docs/claude/notifications-and-mail.md` |
| Ledger detail, read models, DELETE grants, deleting a mistake (0086) | `docs/claude/ledger-and-records.md` |
| Parties, archiving, identifiers, Key Manager/SPOC, leads, client import | `docs/claude/clients-and-import.md` |
| Proposals, letters, DocuSign, signatories, acceptance, multi-currency, engagement lifecycle | `docs/claude/proposals-letters-and-engagements.md` |
| Document prose, governing law, firm companies/issuers, Annexure, proposal layout, who a document names | `docs/claude/document-content-and-issuers.md` |
| PDF rendering, fonts, preview, anchors, document store and bytes | `docs/claude/rendering-and-document-store.md` |
| Invoice numbering, correctness, GST, TDS, round off, dunning | `docs/claude/invoicing-and-gst.md` |
| Billing dues, advances (letter and ad-hoc), final bills, bill dates | `docs/claude/billing-and-advances.md` |
| Dashboard revenue, by manager/originator, Work vs Billing | `docs/claude/revenue-and-reports.md` |
| Day vs instant, firm and company timezones, fiscal years, `asOf` | `docs/claude/dates-and-timezones.md` |
| Worker, jobs, orchestrator steps, sub-steps, agent guardrail | `docs/claude/delivery-engine-and-workflow.md` |
| Tasks, maker-checker, review rules, owner rule, routing | `docs/claude/work-items-and-review.md` |
| Compliance calendar, rules, missed deadlines, service links, international filings | `docs/claude/compliance-calendar.md` |
| Escalation ladder, chaser, freeze, nudges | `docs/claude/escalation-chaser-nudge.md` |
| Client portal: home, asks, library, requests, group grants | `docs/claude/client-portal.md` |
