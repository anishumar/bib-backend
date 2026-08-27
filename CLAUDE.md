# CLAUDE.md — bib-backend

This file is loaded into every Claude session in this repo. It is the architecture, in
force at all times. **Read it before writing a single line.** The rules here are not style
preferences — most are enforced by the build (`npm run check`) and CI, so breaking one does
not merge. When something is unclear, stop and ask; do not fill the gap with a guess.

> Companion docs: `HANDOFF.md` (why we're building this + the decisions), `CONTRIBUTING.md`
> (the PR gate), `migrations/README.md` (the migration rules). The reference implementation
> of these patterns is `/Users/anishumar/Desktop/10xcrm` — read its `CLAUDE.md` for the
> deeper rationale.

## What this is

The backend for **BiB (Business in a Box)** — a multi-tenant **B2B2C** SaaS for professional-
services firms. Many firms (tenants); each firm's staff **and** its clients log in. Sold to
customers, so it must be scalable, reliable, and operable by a small team. Stack: **Node +
TypeScript**, Postgres + RLS, Hono, postgres.js, hexagonal architecture. Frontend is a
separate app; this repo is the API/backend only.

## No bandaids — the absolute rules

- **No TODO / FIXME / placeholder / stub-that-lies.** Finished code, or an explicit
  `ErrNotImplemented`-style stub that fails honestly. Enforced by ESLint (`no-warning-comments`).
- **No `any`.** Enforced. An `any` is a hole in the wall.
- **No unhandled promises.** Enforced (`no-floating-promises`).
- **`process.env` is read only in `src/config`.** The environment is an external system with
  one adapter. Enforced (`no-restricted-properties`).
- **No `console` outside `src/cmd`.** Use the injected logger.
- Actionable errors only: name the variable, the bad value, the valid set. Never
  "connection error".

## The one architecture rule: imports point inward

```
domain  ──▶  usecase  ──▶  api / infrastructure  ──▶  setup  ──▶  cmd
```
A layer may only depend on layers to its left. Enforced by dependency-cruiser
(`npm run arch`, and re-run inside `tests/architecture/arch.test.ts`).

| Directory | Is | May import | May NOT import |
|---|---|---|---|
| `src/domain/<agg>` | nouns + sentinel errors, pure | **stdlib only** | anything internal |
| `src/usecase/<area>` | services + `ports.ts` (the seams) | domain, platform | infra, api, db, config, setup |
| `src/api` | HTTP transport (router, handlers, envelope) | usecase, domain, platform | infrastructure, db |
| `src/infrastructure/<vendor>` | driven adapters (postgres, SDKs) | usecase (to implement ports), domain, db | api |
| `src/db` | the pool + tenant resolver + boot check | config | domain, usecase, api |
| `src/config` | the env adapter | — | domain, usecase |
| `src/platform` | tiny primitives (ids, callctx) | stdlib | everything else |
| `src/setup` | **composition root — the only place concrete meets interface** | everything | — |
| `src/cmd` | process shell (server, migrate) | setup, config | domain/usecase/api directly |

**Ports live next to the use case that needs them** (`usecase/<area>/ports.ts`), never in a
shared `ports/` package. Adapters translate the vendor's types into ours at the door — no
vendor type crosses into domain/usecase; no vendor value becomes a domain enum constant.

## The tenant wall — the highest-consequence rule

A tenant leak fails silently (no crash, just one firm seeing another's data). So it is
defended in **three independent places**, and you must not weaken any of them:

1. **RLS** — every business table has `tenant_id NOT NULL` + `ENABLE ROW LEVEL SECURITY` + a
   policy. The app role `bib_app` is `NOBYPASSRLS`.
2. **The resolver** — tenant-scoped data is reached **only** through `withTenant` /
   `withIdentity` in `src/db/tenant.ts`, which `SET LOCAL app.tenant_id` inside a
   transaction. The raw pool (`src/db/pool.ts`) is importable only by `db/`,
   `infrastructure/`, `setup/` — enforced by the arch rule. A handler or use case can never
   hold an unscoped connection.
3. **The boot check** — `src/db/boot-check.ts` refuses to start the process if the app role
   can bypass RLS or RLS is disabled on `membership`.

**Identity is above tenant (ADR-02):** a login belongs to a global `user`, never a tenant.
`membership(user × tenant × audience × role)` is the join. `user_account` and `tenant` are
GLOBAL tables (marked so in the migration); everything else is tenant-scoped.

**The four scoping gates** every read answers to: (1) tenant [RLS], (2) audience
[STAFF | CLIENT_PORTAL], (3) role, (4) record-scope [portal user sees only its own parties].
Fee/commercial visibility is a **fifth, orthogonal** axis — a flag on membership, never a role.

## Domain non-negotiables (compliance + money)

- Money = amount + currency + FX-rate + rate-date. `numeric`, never float.
- Legal-deadline dates are jurisdiction-local, not UTC.
- Every unique constraint is consciously scoped (state it in the migration comment).
- Idempotency by derived id (`platform/ids.ts` `derivedId`) on external callbacks.
- PII stays out of any append-only log (erasability).
- Soft delete only. Every state transition writes an event naming its actor.

## Migrations

`migrations/NNNN_name.{up,down}.sql`, immutable once applied, fix forward with a new number.
`SET ROLE bib_owner` around DDL. New business table ⇒ `tenant_id` + RLS + policy, or an
explicit `-- GLOBAL:` justification. See `migrations/README.md`.

## Config is an adapter

`src/config/config.ts` is the only `process.env` reader. Add a key in exactly two places:
the zod schema there **and** `.env.example`. Parse into typed values at the boundary; never
pass a raw string where a number/enum is meant. Validate in `validate.ts` — fail closed.

## How to add things

- **A route** → add to `src/api/router.ts` (all routes in one file) + a handler method in
  `src/api/handler/`. Handler parses, calls one use-case method, maps the result. No rules in it.
- **A business rule** → `usecase/<area>/service.ts`. If it needs something external, declare a
  port in `ports.ts` and inject it; never import an adapter.
- **An external system** (DB table, vendor API) → an adapter in `infrastructure/`, implementing
  a port with `implements`. Wire it in `setup/`.
- **A new module** → mirror `tenancy/`: `domain/<agg>`, `usecase/<area>`, `infrastructure/`,
  handler + routes, fakes in `testfakes/`, tests. Every business table gets the tenancy rules above.

## The commands

```bash
npm run dev        # tsx watch — local server
npm run migrate    # apply migrations (owner role; ensures bib_owner/bib_app)
npm run check      # typecheck + lint + arch + test  ← the gate; run before every push
npm test           # vitest (unit + the architecture test)
npm run test:integration   # the checks only a real Postgres can make (RLS, append-only
                           # ledger). Needs a migrated local DB; not in `check`.
npm run arch       # the import wall, standalone
```

CI runs `npm run check` on every PR; a pre-push hook runs it locally. If the gate is red,
the work is not done — fix it, do not disable the rule. If a rule is genuinely wrong, that is
a design conversation in the PR, landed as its own commit with the reasoning — never a quiet
exception or an import moved to dodge the matcher.

## Authentication

A request becomes a `Principal` through the **`PrincipalResolver`** in `api/principal.ts` —
a session cookie (or `Authorization: Bearer`) resolved against `tenancy.session`. Sessions
are server-side because they must be **revocable**: a firm that dismisses someone expects
access to stop that afternoon, not when a token expires. The token is only ever a SHA-256
digest at rest and only ever leaves in an httpOnly cookie — never in a response body.

`Principal` carries `tenantId` and `audience`, which are **null until an org is chosen**:
a user with several memberships must call `POST /api/v1/auth/switch-tenant`. Anything that
needs a tenant checks for it; nothing guesses.

HONEST REGISTRY: the dev `x-user-id` resolver and the logging mailer are the only stubs
left, both gated on config, and `validateServer` refuses to boot a production-like
environment with either. Do not add a third without the same treatment.

## The audit ledger

Every state transition writes an event. Depend on the **`EventSink`** port
(`usecase/ledger/ports.ts`) and call `recordEvent()` — never on `LedgerService`, never on a
ledger adapter. The verb comes from the closed registry in `domain/ledger/model.ts`;
`object_type` is derived from it; the payload holds ids and machine facts and **no personal
data** (refused at the write — the log cannot be erased). Record the event *after* the
change it describes has committed. The full contract is `docs/EVENT-CONTRACT.md`; read it
before emitting your first event.

## First module

`tenancy`, `party` and the `ledger` are built. Next, in order: `crm`, then `billing` — the
flagship slice. Reuse the platform's auth and notifications; do not rebuild them.
