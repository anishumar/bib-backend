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

Gates 1–3 are built. Gate 1 is RLS; gates 2 and 3 are prefix middleware (`api/guards.ts`),
both **denied by default** — a `CLIENT_PORTAL` session reaches only `PORTAL_PATHS`, and a
route absent from `ROUTE_PERMISSIONS` is refused for everyone. **Roles are config rows the
firm owns** (T2.5), read through the `PermissionSource` port; the swap changed no call site,
which is what the port was there for. `DEFAULT_ROLES` in `domain/authz/model.ts` is now only
the SEED a new tenant's rows are written from — nothing consults it at request time, and
there is deliberately no fallback to it (see the configuration registry below). A role the
firm does not define carries nothing and says so (`UNKNOWN_ROLE`), because a firm locked out
by a typo must not look like policy working as intended. Gate 4 needs the user-to-party link
and lands with U1. The fee axis is `AuthzService.seesFees()` / `withFeeVisibility()` — it
**redacts** money rather than omitting the record, so "you may not see this" never looks
like "there is no fee".

## The configuration registry — data, not code (P2 / T2.5)

The things a firm changes weekly are rows, not deploys: `config.entry` is the thing being
configured (`tenant × kind × key` — "the GST filing service", "the partner role") and
`config.version` is what it said at a point in time. Two kinds ship today, `service` and
`role`; `workflow_template` and `rule_pack` join them when T2.7 and T4.3 actually read them.
Adding a kind is a code change, because each kind needs a body validator in
`domain/config/model.ts` and a kind without one accepts anything.

**Publishing freezes.** A published version's body can never change — enforced by a trigger
in migration 0005, so it binds the owner role and the psql session too, not just the app.
Publishing a new version archives the one it replaces; archived versions stay readable
forever. That is what makes a PIN meaningful, and pinning is the whole point: a consumer
that must not move stores a `version.id` and reads that row for the rest of its life, so
editing a workflow never rewrites jobs already walking it. The registry never pins on a
consumer's behalf — **the consumer decides**, and both reads are explicit: `list`/`describe`
for what is in force now, `readPinned` for what it said then. Roles read live, because a
firm that removes a permission expects it gone that afternoon.

**Every tenant owns a complete role set from the moment it exists** — `createTenant` seeds
it through the `RoleRegistrySeeder` port, and migration 0005 backfilled the firms that
predate it. There is no read-time fallback to the product defaults, deliberately: merging
with them means a firm can never actually remove a permission, and using them only when a
tenant has no rows means the first role a firm publishes locks out everyone holding another.
A tenant with no role rows is a real fault and gate 3 says so loudly.

**Changing a default role now costs a migration.** `DEFAULT_ROLES` is what a NEW tenant is
seeded from; every existing firm already holds its roles as rows, and a published version is
frozen. So adding a permission to a default role means a migration that publishes a new
version for the firms that have not customised that role — leaving the ones that have alone,
because a firm that edited its own role made a decision. `tests/config/seed-parity.test.ts`
holds the build red until the newest seed migration and `DEFAULT_ROLES` agree.

**Writing config requires `tenant:admin`, not a `config:write` of its own.** Whoever can
publish a role version can grant themselves everything, so the permission has to say that at
the moment somebody decides to hand it out. Reading is `config:read` — an associate quotes
from the catalogue. And a publish that would leave no role carrying `tenant:admin` is
refused: it is unrecoverable from inside the product.

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
  App-facing routes take the tenant from the **session**, never from the path — see
  `api/handler/party.ts`. `/internal/…` is the platform's own S2S surface (provisioning).
- **A business rule** → `usecase/<area>/service.ts`. If it needs something external, declare a
  port in `ports.ts` and inject it; never import an adapter.
- **Something a firm should be able to change without a deploy** (a catalogue, a template, a
  rule pack) → a `kind` in the configuration registry, not a table of its own. A body
  validator in `domain/config/model.ts` and an entry in the `config.entry` CHECK; the
  versioning, publishing, freezing and pinning already exist.
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
npm run smoke              # end-to-end against a RUNNING server: seeds a firm with three
                           # roles and walks every gate, the party model, the config
                           # registry, rate limits, CORS and the audit trail. Prints
                           # logins to continue in the UI.
npm run arch       # the import wall, standalone
```

CI runs `npm run check` on every PR; a pre-push hook runs it locally. If the gate is red,
the work is not done — fix it, do not disable the rule. If a rule is genuinely wrong, that is
a design conversation in the PR, landed as its own commit with the reasoning — never a quiet
exception or an import moved to dodge the matcher.

## Authentication — two surfaces, both guarded by prefix

Authentication is **middleware on a path prefix** (`api/guards.ts`), never a check a handler
remembers to make. Three routes once shipped unauthenticated because the check lived in
each file and new files forgot; a prefix guard cannot be forgotten by a file that does not
exist yet.

- **`/internal/*`** — the platform's own provisioning API (create a tenant, grant a
  membership, register a user, set a password). No end user behind it, so **each caller has
  its own key** (`BIB_INTERNAL_KEYS`) carrying only the capabilities it needs, compared in
  constant time. One key opening every route was an escalation path: create a user, grant
  them partner in any firm, set their password, sign in as them. Capabilities live in
  `ROUTE_CAPABILITIES` (`api/capabilities.ts`) — **denied by default**, so a route with no
  entry is refused to every key. `credential.set` grants a *login as somebody*, so boot
  refuses it sharing a key with anything else in a production-like environment. Services
  record these writes as the **system** actor, with the caller's name in the payload —
  "system did it" cannot be traced to a system.
- **`/api/v1/*`** — the product. Requires a session. The only exceptions are the three
  routes that exist to *obtain* one, listed by exact path in `PUBLIC_PATHS`. Adding to that
  set needs a reason as good as theirs.
- **Audience (gate 2) is denied by default on that surface.** A `CLIENT_PORTAL` session
  reaches only `PORTAL_PATHS`; everything else is the STAFF workspace and answers 403.
  This product is B2B2C — a firm's staff *and* its clients log in here — so an
  authenticated, in-tenant session says nothing about which of the two the caller is. With
  the reverse default a client contact could list the firm's entire book of clients through
  the front door. When U1 lands, its routes join `PORTAL_PATHS` **and** need record-scope
  (gate 4): a portal user sees only the parties they represent.

Handlers read the resolved principal from the request context (`c.get("principal")`) and
call `scopeOf()` (`api/scope.ts`) when they need a tenant — 401 "not signed in" and 403
"signed in, but no org chosen" are different answers and both matter.

`tests/api/auth-coverage.test.ts` enumerates **every route the Hono instance has
registered** — not the OpenAPI spec, which lists only `app.openapi()` routes and is blind
to plain `app.get()` ones like `/health` and `/docs` — and fails if any route outside the
allowlists answers anything but 401 to an anonymous caller. **A new route is covered by it
automatically**, however it was registered. That is the point of it.

A request becomes a `Principal` through the **`PrincipalResolver`** in `api/principal.ts` —
a session cookie (or `Authorization: Bearer`) resolved against `tenancy.session`. Sessions
are server-side because they must be **revocable**: a firm that dismisses someone expects
access to stop that afternoon, not when a token expires. `resolveSession` therefore
re-checks the membership on **every** request — checking only at login and org-switch left
a deactivated member working for up to a fortnight. The token is only ever a SHA-256
digest at rest and only ever leaves in an httpOnly cookie — never in a response body.

`Principal` carries `tenantId` and `audience`, which are **null until an org is chosen**:
a user with several memberships must call `POST /api/v1/auth/switch-tenant`. Anything that
needs a tenant checks for it; nothing guesses.

HONEST REGISTRY: the dev `x-user-id` resolver and the logging mailer are the only stubs
left, both gated on config, and `validateServer` refuses to boot a production-like
environment with either. Do not add a third without the same treatment.

## CORS — the frontend is a separate origin

The frontend is its own app in its own repo, so every call it makes is cross-origin and the
API must say so or the browser discards the response. `BIB_CORS_ORIGINS` is an **exact
allowlist**, never a reflection of whatever `Origin` arrived: with `credentials: true`,
reflecting the origin lets any site on the internet make authenticated requests with the
user's cookie and read the replies. Boot refuses a wildcard, an empty list, and any
`http://` or localhost origin in a production-like environment.

CORS is mounted ahead of the rate limiter so a preflight is answered and stopped before it
spends the caller's budget — a browser preflights every credentialed POST, so otherwise
each login would cost two of ten attempts a minute. `/internal` gets no CORS at all: it is
service-to-service, and its preflight 404ing is the correct answer.

## Rate limiting

Two limiters, defending different things — neither substitutes for the other. The edge
(`api/ratelimit.ts`) keys on **client address**; the identity use case keys on the
**account**. A botnet spreads its guesses across a thousand addresses and walks past any
per-IP rule; what it cannot spread is whose password it is attacking. Both are mounted by
prefix, like the auth guards, for the same reason.

`ScryptPasswordHasher` additionally caps concurrent hashes: memory-hardness protects the
password *and* points a loaded gun at the server, since login is unauthenticated by
definition and each hash holds ~32 MB.

The store is a port with an in-process implementation — **per-process, so behind N pods
every limit is N times looser**. That is fine at one pod and is why the interface is async:
Redis drops in unchanged.

## The audit ledger

Every state transition writes an event. Depend on the **`EventSink`** port
(`usecase/ledger/ports.ts`) and call `recordEvent()` — never on `LedgerService`, never on a
ledger adapter. The verb comes from the closed registry in `domain/ledger/model.ts`;
`object_type` is derived from it; the payload holds ids and machine facts and **no personal
data** (refused at the write — the log cannot be erased). Record the event *after* the
change it describes has committed. The full contract is `docs/EVENT-CONTRACT.md`; read it
before emitting your first event.

## First module

`tenancy`, `party`, the `ledger` and the `config` registry are built. Next, in order: `crm`,
then `billing` — the flagship slice. Reuse the platform's auth, notifications and config; do
not rebuild them.
