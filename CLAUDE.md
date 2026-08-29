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
   **And every reference between tenant-scoped tables carries the tenant with it** — a
   composite `UNIQUE (id, tenant_id)` on the target, referenced as `(fk_id, tenant_id)`. A
   foreign-key check runs as a system operation RLS does not filter, so an id-only reference
   lets one firm's row hang off another firm's object with no policy violation anywhere. It
   leaks nothing and the wall is still supposed to forbid it.
   `tests/architecture/tenant-keys.integration.test.ts` asks the catalogue rather than a
   list, so a table added next month is covered the day it exists — **a new tenant-scoped FK
   fails the build until it carries `tenant_id`.**
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
`config.version` is what it said at a point in time. Eight kinds ship today — `service`, `role`, `policy`, `clause`, `dunning`, `workflow_template`,
`confidence_tier` and `verification_policy`; `rule_pack` joins them when T4.3 actually reads it.
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

## Firm administration — the roster is the other half of access control

`/api/v1/tenancy/members` is a firm running itself: who works here, what their role is, and
whether they still have access. It is the app-facing counterpart to `/internal/v1/memberships`,
which stays what it always was — the PLATFORM creating firms, behind a key no browser holds.

**Revocation is real now.** `is_active` and its grant have existed since migration 0001, and
`resolveSession` has re-read the membership on *every* request since T1.7 so that cutting
access lands on the next request rather than at token expiry. Nothing ever wrote it until
T2.5b: the verb `membership.revoked` was registered and emitted by nobody. If you find another
registered verb with no writer, treat it the same way — as a feature that looks finished.

Two guards, and between them they cover both routes to the same unrecoverable state:

- **A role must be published before it can be assigned** (`RoleDirectory.knownRoles`). Handing
  somebody a role the registry does not define is the `UNKNOWN_ROLE` lockout by hand.
- **A firm must keep an active administrator** (`hasActiveAdministrator`, asked about the
  roster the firm *would* have). The registry refuses to publish a role set where no role
  carries `tenant:admin`; the roster refuses to remove the last person holding one.

All four routes are `tenant:admin`, the read included — the roster lists colleagues' email
addresses, and a general staff directory is a wider decision than this screen.

## Seniority is a third axis, and it grants nothing (G3.3)

`tenancy.staff_grade` is the firm's own ladder and `membership.grade_id` puts a person on a
rung. Keep it clear of the other axes: **role** says what somebody may REACH (permissions,
gate 3), **commercial visibility** says whether they see money, **grade** says how SENIOR
they are, and **`reports_to_user_id`** (T2.9) says who checks their work. A grade carries no
permission at all, and neither does a reporting line.

It exists for exactly one comparison — the firm's stated review rule is *"Manager or above is
fine"* — so `rank` is a plain integer and there is no skill matrix and no tier-and-load
routing. **T2.9 is now its consumer** and confirmed the shape: a `verification_policy` stores a
`minGradeRank` and compares it, and nothing anywhere reads a skill or a load. T3.1's review step
is the other.

Four things about it are decisions, not details:

- **`rank` is not unique and not contiguous.** Nothing compares WITHIN a rung, only across the
  threshold. Requiring uniqueness would turn "insert a rung below this one" into a renumbering
  of the whole ladder, to buy an ordering guarantee nothing reads.
- **`is_active`, never a delete** — and `bib_app` holds no DELETE grant on the table, so that
  is enforced rather than remembered. `deleted_at` would mean the row was a MISTAKE; this means
  the firm has MOVED ON. A rung somebody held in 2026 is part of why they could approve
  something in 2026, so it stays readable forever and the roster still renders it, marked
  retired. What retiring changes is only that nobody NEW may be put on it.
- **`grade_id` is nullable, and ungraded is a real answer.** A portal contact has no rung. Nor
  does somebody whose designation the firm's own hierarchy never ranked — Article, Intern,
  Trainee, Head, Public Relations Officer and CEO are all in use at the firm and none of them
  is placed. This is the value that decides who may sign off a statutory filing, so a
  plausible invented rank is worse than a null: it is indistinguishable from a real one. The
  firm adds them itself, ranked as it chooses, from `/admin/grades`.
- **It is a TABLE, not a registry kind**, even though a firm edits it. `membership.grade_id`
  wants a real foreign key, and the ladder is read whole on every roster load rather than one
  entry at a time. The registry's versioning and pinning would buy nothing here: nobody asks
  what a rung meant last March, they ask who is on it now. Same shape of deviation as T3.2's
  obligation templates, and recorded here for the same reason.

`DEFAULT_GRADES` (`domain/staffgrade/model.ts`) is the ten rungs 10x Global gave on 22 Aug
2026, seeded at `createTenant` through the `GradeLadderSeeder` port — a firm with no ladder is
one where nobody meets the review threshold. Changing them costs a migration, and
`tests/staffgrade/seed-parity.test.ts` holds the build red until the newest seed and the code
agree; the same arrangement `DEFAULT_ROLES` has, for the same reason.

## The firm's own delivery structure — and who decides how work is split (G2.4)

`tenancy.service_axis` is ONE table holding the firm's TWO lists, discriminated by `axis`:
**Depts** (FRC / TRC / RAA — the revenue axis, what a SPOC covers) and **delivery teams**
(FINCOMPLIANCE, VCFO CONSOLE, PAYROLL — who does the work). They CROSS: one team commonly
delivers under several Depts, so they are independent dimensions and never a hierarchy —
nesting them would force a duplicate catalogue row per Dept and count its revenue twice.

One table rather than the demo's two, because the two were structurally identical and would
have meant two repositories, two services and two fakes free to drift. `axis` is a CHECKed
discriminator, doing what `config.entry.kind` and `delivery.job.source_kind` do: the engine's
vocabulary, the same at every firm. The firm owns the ROWS.

**It lives in `tenancy`, not the config registry**, for `staff_grade`'s reason: a Dept is the
firm's own structure, `is_active` is a distinction the registry cannot express, and G3.2's
`client_assignment.module_id` needs a real row to point at.

**A `service` body still stores the CODE, not a foreign key**, and that is not a shortcut. A
published config version is FROZEN — the freeze is what lets a nine-month-old proposal still
show the price it was sent at — so a migration rewriting published bodies would break the one
guarantee the registry exists to make. The table is therefore the LIST the code is checked
against, at the write, through the `AxisDirectory` port. Consequences, all intended: a rename
changes `name` and never `code`; a body naming a retired code still reads and simply cannot be
written again; and **a firm with no rows on an axis is checked against nothing on that axis**,
because a list the firm has never written is not a list to validate against.

**`tenancy.tenant.work_split_axis` (`none` | `dept` | `team`) is how the firm cuts ONE
client's work into separate jobs**, and it is a COLUMN for `firm_signatory_user_id`'s reason:
freely changeable, and changing it RESTATES NOTHING — jobs already created keep their rows,
the next engagement is split the new way. The opposite of `reporting_currency`, which is a
column because it must never change.

**`none` is the DEFAULT and a real answer, not "unconfigured".** Not every firm has these
layers: a fifteen-person practice has neither, a single-P&L firm has teams and no Depts, a
multi-partner firm the reverse. `none` reproduces T2.6's behaviour exactly, which is why this
migration changed no firm's behaviour until somebody chooses.

Two roads to the same broken state are both closed: choosing an axis whose list is empty is
refused, and so is retiring the last active row on the axis already chosen. Closing only one
leaves the other open, and the second is the one somebody actually walks.

**`groupByAxis`'s one caller now exists** — T2.7's spawn (migration 0046), and see the
orchestrator section below for the whole key. Note what wiring it found: the `none` branch
returned ONE bucket holding everything, called "T2.6's behaviour, unchanged" in its own
comment, and it was the opposite — T2.6 gives one job per ENGAGEMENT, so that would have
merged every line of every letter for every firm on the DEFAULT setting. Eleven unit tests
were green on it because nothing consumed it. If you find another registered thing with no
reader, treat it the same way: it is not proven, whatever its tests say.

## Lists return read models, not aggregates

An aggregate carries ids — `partyId`, `ownerUserId`, `userId` — which is right for the
aggregate and useless for anything that has to SHOW it. A list endpoint therefore returns a
joined read model: `MemberRecord` (membership + email + name), `LeadRecord` (lead + party +
owner). The alternative is a lookup per row, and screens that render uuids.

This was learnt the expensive way. Five modules shipped before anything had to render any of
them, and every list was designed against tests, which are perfectly happy with uuids. **Build
the screen alongside the module**, as the build plan already says — it is the only thing that
asks the questions tests do not.

Two rules that came out of it, and both are now enforced by tests:

- **A read model carries names, not just ids** — and this has now been learnt five times
  (`MemberRecord`, `LeadRecord`, `ProposalRecord`, and Party 360's relationships). If a
  screen would have to fetch something per row to render it, the join belongs in the query.
- **A write with no read is not a stored fact.** `registerLegalEntity` wrote a jurisdiction,
  an incorporation date and a financial-year end that no route could ever return; the same
  360 read omitted the organization/person subtype, so a client page could show a display
  name and nothing else. Both were found by building the screen, not by a test — tests are
  perfectly happy asserting on what the writer returned. When you add a write, name the read
  that proves it.
- **Handlers map field by field; they never forward a domain object.** `role` and
  `commercialVisibility` were on the wire for six tasks while `/auth/me`'s schema documented
  four fields, because the handler returned the Principal straight through and zod-openapi
  documents a response without validating it. In a codebase whose frontend generates its
  whole client from that spec, an undocumented field is one the browser cannot see.
- **A caller is told what it may do.** `/auth/me` carries the permissions its role holds — what
  it HOLDS, never the vocabulary it does not — so a screen offers only what will work instead
  of discovering the answer from a 403.

## Domain non-negotiables (compliance + money)

- Money = amount + currency + FX-rate + rate-date. `numeric`, never float. The rate is stored
  even when the currencies match (1.0, dated), so "did we convert this?" is never inferred.
  **Amounts cross the wire and sit in JSON bodies as decimal STRINGS** ("1499.50"), because a
  float cannot hold that value exactly and the error is invisible in one line and material in
  a total. Only the database adds them up.
- **A firm's reporting currency is a column on `tenancy.tenant`, not a config row** (0009).
  Every rate the product stores is struck against it, so changing it later does not restate
  history — it silently invalidates it, and a Publish button is the wrong affordance for that.
  Required at creation with no default anywhere in the stack, and nothing updates it.
  `domain/money/model.ts` holds the shared primitives; normalise a currency code before you
  compare or store it.
- Legal-deadline dates are jurisdiction-local, not UTC.
- Every unique constraint is consciously scoped (state it in the migration comment).
- Idempotency by derived id (`platform/ids.ts` `derivedId`) on external callbacks.
- PII stays out of any append-only log (erasability).
- **Nothing is hard-deleted, and nothing in `core` is soft-deleted either.** `bib_app` holds
  no DELETE grant on a single table in this database, so removal is impossible at the
  database level rather than merely unimplemented. The only soft deletes in the product are
  `removed_at` on `crm.proposal_line`, `crm.engagement_letter_line` and `crm.document_block`
  — all three the same thing, a line struck off a document before it went out. A fourth needs
  the same argument: it is a LINE OF A DOCUMENT, removed while that document was a draft.
  Every state transition writes an event naming its actor.

**Parties are permanent — there is no `deleted_at` in `core` and there never will be (G0.3).**
A client created by mistake is ARCHIVED, not removed: `core.party.archived_at` (migration 0035)
means "keep this out of the pickers and lists", and nothing more. A real company's lifecycle is
answered by the ledger and by `core.legal_entity.status`, which knows the states a registrar
recognises. The reason is one sentence: a signed engagement letter's counterparty must always
resolve. So the LIST hides archived parties and takes a flag to include them, while reading ONE
party by id ALWAYS returns it, archived or not — that asymmetry is the whole design, and it is
why this is one column on one table rather than `deleted_at` across `core` behind a filter every
read from now on has to remember to write. Archiving is refused **by a trigger** while a lead, a
proposal, a proposal line's entity, an engagement letter, a letter line's entity or an engagement
still points at the party, and the refusal names them. A trigger rather than a service check
because an import or an agent walks straight past a service, and it costs nothing on ordinary
writes: `BEFORE UPDATE OF archived_at`, with a `WHEN` clause on the NULL → NOT NULL transition, so
a rename fires nothing. **Read that guard as "you cannot put away a client you are still working
with", not as "an archived party is unreferenced"** — it is checked at the moment of archiving and
is not an invariant afterwards. Nothing stops a NEW reference being made to an archived party, and
lead capture in particular resolves by identifier without consulting `archived_at`, so a capture
carrying an archived party's PAN attaches to it. Making that the stronger invariant is a decision
nobody has taken; it is on the board as an open item, not an oversight.

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
                           # registry, the lead pipeline, firm administration, rate
                           # limits, CORS and the audit trail. Prints logins to
                           # continue in the UI. Sign-in is rate limited: two runs
                           # inside a minute throttle, and the script says so.
npm run arch       # the import wall, standalone
```

**A new error family — or a new code in an existing one — is a COMPILE error until it is mapped.**
Every family's switch in `api/domainerr.ts` ends `default: return unmapped(err.code)`, and
`unmapped` takes `never`. Without it an unmapped code fell out of its `if` and landed on the final
`return 500`: that is how `StaffGradeError` shipped with every refusal answering 500 instead of
400/404/409, invisible to unit tests, which assert on the thrown sentinel and are perfectly happy.

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

**What a portal session is TOLD it may do is empty, whatever role it holds.** Nothing
refuses a staff role on a `CLIENT_PORTAL` membership — `manager` on a portal login is
accepted — and that leaks nothing, because gate 2 runs before gate 3 and refuses every staff
route. But `permissionsOf` used to report the role's four permissions, none of them
reachable, which breaks the one promise `/auth/me` makes: *a screen offers only what will
work*. It returns `[]` for a portal session now. That is arithmetic rather than policy —
gate 2 admits a portal session only to `PORTAL_PATHS`, and none of those needs a permission —
and `tests/api/portal-permissions.test.ts` reads both tables so the build goes red the day U1
adds a permission-gated portal route. The real fix, a role that declares its audience, costs
a migration and belongs with U1.

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

HONEST REGISTRY: the dev `x-user-id` resolver, the logging mailer and the **attested e-sign
signer** are the only stubs, all three gated on config, and `validateServer` refuses to boot a
production-like environment with any of them. `tests/config/boot-gates.test.ts` proves each
refusal — a gate that stops refusing breaks nothing and is therefore silent. Do not add a
fourth without the same treatment.

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

**The actor's NAME is a read-time join, never a stored field.** `EventRecord` carries the
account as it stands now; the row keeps only `actor_id`. That is what lets erasure work — an
erased account stops resolving and the event survives — and it is why the read is a LEFT join
and `actor: null` is a real answer (system and agent actors have no account either). The
smoke check guarding this greps the **stored `event` half** of each record, not the whole
response: grepping both would call the join a leak, and that distinction is the design.

## Proposals — the first module that stores money (T2.2)

A proposal is a document about a party, built from catalogue rows. Three rules shape it and
none is negotiable without a conversation:

- **The catalogue row is PINNED; the quoted money belongs to the proposal.** A
  `proposal_line` holds `service_version_id` — the frozen `config.version` — plus the amount
  actually asked for. That is what lets a quote reopened nine months later answer both halves
  of the only commercial question anyone asks: what our list price was then, and what we
  charged.
- **One proposal, one currency, one rate.** The rate is struck once, on the proposal, and the
  lines are held to its currency by a composite foreign key — a mixed-currency document is
  unrepresentable, not merely discouraged. The rate is stored even when the currencies match.
- **The arithmetic is in the schema** (`crm.proposal_line_amount`, `crm.proposal_totals`,
  migration 0013), written once, in `numeric`. Both are `security_invoker` views: a plain view
  runs as its owner, which is not subject to the row policies, so a totals view over a
  tenant-scoped table would be a hole straight through the tenant wall.

The discount limit is a `policy` config row read LIVE. **No published policy means ZERO, not
"no limit"** — a firm that never set one has not decided that anything goes. Going past it
needs `proposal:approve`, which is its own permission rather than `tenant:admin` (the person
who manages logins is not automatically the person who may sign off forty percent off) and
is not the fee axis (that governs SEEING money, not authorising a price).

Proposals are also the fee axis's first real consumer: money is **redacted**, so an associate
without commercial visibility sees the client, the services and the quantities, and nulls
where the amounts are.

**The share link is the fourth `PUBLIC_PATH`, and the first that is not about obtaining a
session.** A proposal goes to somebody who has no login and will not get one. The token is
`<tenant_id>.<secret>` — the tenant travels inside it so that resolving a link is still an
ordinary `withTenant` read, because the alternative is a digest lookup across every firm on a
table that holds money. Only the SHA-256 digest is stored, the token arrives in the BODY (a
path lands in access logs and Referer headers), the route is read-only, and malformed,
unknown and withdrawn all answer the same way so it cannot enumerate anything. Adding a fifth
entry to that set needs a paragraph as good as this one — `tests/api/auth-coverage.test.ts`
holds the build red until somebody writes it.

A view is **a count and one event**: `view_count` rises on every open, `proposal.viewed` is
recorded once. Per-view analytics does not belong in an append-only log.

## Engagement letters — the document that creates obligations (T2.3)

A proposal is what the firm OFFERED; an engagement letter is what both sides AGREED. That one
difference makes everything here stricter than its proposal counterpart.

- **Signature FREEZES, by a trigger** (0017), not a check in the service — because "what did
  they sign" is a question a court asks, and an application rule cannot answer it against a
  migration or a psql session. A change after signature is a NEW LETTER; the old one stays
  readable as what was actually agreed.
- **Clauses are the registry's fourth kind and are PINNED.** Pinning's best argument: a live
  read would answer "what exactly did they agree to" with today's wording. A clause scoped to
  another jurisdiction is refused rather than quietly included.
- **The letter stores its OWN jurisdiction**, chosen at drafting. Not derived from the
  client's registrations at read time — a legal document records the jurisdiction it was
  written FOR, permanently.
- **A letter needs lines AND clauses before it can go out.** No lines commits nobody to
  anything; no clauses is the dangerous one, because a signed contract with no terms is
  enforceable as whatever a court reads into it.
- **A line names the ENTITY the work is for, and it is not the client.** An engagement is
  `service × ONE LEGAL ENTITY` — the firm's own "Per Company" rule, so vCFO for a group of
  four companies is four engagements. `entity_party_id` is NOT NULL on the letter line and on
  the engagement, nullable on a proposal line (a prospect may hold no company yet, and
  Incorporation is a line whose entity is its own OUTPUT). **`party_id` stays alongside it**:
  the client is who is BILLED, the entity is who the work is DELIVERED TO, and invoicing needs
  the first while the compliance calendar needs the second — an entity owes GSTR-3B, a client
  does not. The entity is inside `canonicalContent`, so the signature commits to it, and it
  travels on `contract.activated` so the scheduler need not join back to find it.
- **Signing fans out one engagement per line, in ONE transaction.** A signature with no
  engagements is a client committed to work nobody scheduled; engagements with no signature is
  work nobody agreed to. `UNIQUE (engagement_letter_line_id)` makes a double fan-out
  impossible rather than unlikely.
- **The freeze names what may still MOVE, never what is protected.** The line and clause
  triggers refuse *any* write to a signed letter's children. The letter's own
  (`crm.refuse_signed_change`) once compared an **enumerated list of columns**, so a column
  added later was silently editable after signature until somebody remembered to add it —
  and six already were. Migration **0019** inverted it: the trigger compares the whole row
  (`to_jsonb(NEW) - mutable` vs `to_jsonb(OLD) - mutable`) and exempts only the short
  allow-list published by `crm.signed_letter_mutable_columns()` — today
  `advance_recorded_at`, `advance_recorded_by`, `updated_at`. **A new column on
  `crm.engagement_letter` is frozen the day it exists; adding a FOURTH exemption is the thing
  that needs an argument**, and `tests/architecture/signed-letter-freeze.integration.test.ts`
  asks the catalogue for every column and holds the build red until somebody makes it.
- **Once real signed letters exist, no NOT NULL column can be added to a letter line again.**
  The freeze refuses the backfill, by design, and there is no honest value to write into a
  document that never said it. A new required field on an issued document is then a nullable
  column required only for letters drafted after it. Migration 0018 refuses rather than
  working around this, and its exception message says so.
- **The advance-fee gate is real.** Engagements start `pending_advance`, and
  `contract.activated` — the trigger T2.4's scheduler consumes — is not emitted until the
  advance is recorded. **Its honest limit:** a person attests the money arrived, because
  payments (T3.5) do not exist. The gate is enforced; its confirmation is an attestation.

## What a document SAYS — its prose, and whose law it names (G1.7, G1.8)

Two things sit beside a document's priced lines, and neither is a clause.

**The prose blocks are COPIED onto a document, never referenced.** `crm.standard_document_block`
is what the firm maintains — its exclusions, its commercial notes, its team block — and
`crm.document_block` is what one proposal or one letter actually says. A new document copies the
standard set at creation and owns those rows from then on, so editing the standard exclusions
changes the NEXT document and never one already issued. That is the config registry's pinning
argument reached from the other direction, and here a copy beats a pin because these lines are
meant to be edited per document: a client negotiates an exclusion away, which a pinned version
cannot express.

**One row per line, not one blob per block**, because that is how they are edited — a line at a
time, reordered, struck out. A single `exclusions text` column makes "delete the third exclusion"
a string operation with nothing stable for a screen to attach a control to. `is_heading` is what
keeps that from costing anything: the team block is a table with headings.

**`jurisdiction` on a standard line is load-bearing.** NULL prints everywhere; a code prints only
on a document written for that country. "All fees are exclusive of GST as applicable" is wrong on
a UAE proposal, and it is a mistake the firm already caught in its own template. The filter is
`blocksFor` in the domain: retired lines are never copied, an unscoped line always is, a scoped
one only to its own country — and an UNKNOWN country (`*`, an ordinary state on a proposal) takes
only what is true everywhere, because that is the safe direction.

One table with two nullable parents and a CHECK, against the local precedent of separate line
tables — those two differ in substance, a block does not. It inherits the signed-letter freeze for
free, since `crm.refuse_signed_child_change()` resolves its parent from `engagement_letter_id`.

**Whose law a letter names is checked against the ISSUING ENTITY.** `ClauseBody` carries
`governingLaw` and `courts`, each an ISO code AND the words the document prints — the code cannot
print ("the laws of the State of Delaware" does not follow from `US`) and the words cannot be
compared. `addClause` refuses a term that is not the issuing entity's, which is the firm's sharpest
finding made unrepresentable: its real letter was issued by the US entity and named Indian law and
Delhi courts, and a human review let it out.

That check is **not** the clause's `jurisdictions` field, and conflating them loses the bug. That
field says where a clause may be USED; the real clause was applicable everywhere and every word of
it was true. This says what the clause SAYS, against who is actually contracting.

**An unregistered issuer is refused too**, and it is the case that decides whether the check is
worth anything: `seedFirmEntity` writes an organization with no `core.legal_entity` row, so every
firm's default issuer has no jurisdiction — which is exactly the position the original letter was
written from. Its limit, stated: a deliberate foreign choice (English law under an Indian entity, a
neutral arbitral seat) is now unrepresentable. Making the exception representable belongs on the
LETTER and is a decision nobody has taken.

## Invoicing — the one number in this product that may not gap (T3.4)

A proposal reference may gap: `PR-2026-0007` missing means somebody abandoned a quote, and
`crm.document_ref_series` burns numbers on purpose. **A tax invoice number may not.** Under
Indian GST a series must be consecutive, and an auditor who finds one missing is entitled to
read it as a suppressed sale.

So `InvoiceRepository.create` **both allocates and writes**, and the signature is the
guarantee. The mechanism is a counter row taken under `SELECT … FOR UPDATE` inside the same
transaction as the insert: a second writer blocks until the first commits or rolls back, and
a rollback releases the number because the counter never moved. **Never a sequence** —
`nextval` survives rollback by design, which is what makes it wrong here and unfixable
afterwards. Never `max(number)+1`, which reads a snapshot.

The series is per **(entity, financial year)**, because two of a firm's companies each file
their own returns and each owes its own consecutive series. Both correctly issue
`INV/2026-27/0001`, which is why `UNIQUE` is scoped to `(tenant, entity, number)`; the
`prefix` on the series row is how a firm tells them apart when it wants to. The financial
year is 1 April and that is hardcoded — right for India, wrong for the UK and the US, and
generalising it through `core.legal_entity.financial_year_end` would make a series' year
depend on a mutable column, which is a decision a firm has to take.

**The number, the series and an issued invoice's money are frozen by a trigger**, not by a
service check — "why is invoice 41 now numbered 43" is a question an auditor asks, and an
application rule is one an import or a psql session walks past. A wrong invoice is CANCELLED
and reissued; the cancelled row stays in the sequence saying so, which is exactly what shows
where a number went.

**There is no `paid` status, and no `amount_paid` column.** Both are caches of an addition
and both drift the first time a payment is corrected, leaving an invoice that says "paid"
beside arithmetic that says otherwise — and only one of them is evidence.
`crm.invoice_balance` computes invoiced − paid − credited in `numeric`. Totals are
`security_invoker` views, like the proposal's.

**A payment is SIGNED** (T3.5). A bounced cheque is a negative payment with its own date and
note — two rows that tell the story — not the original row edited into something that never
happened; `bib_app` holds no DELETE grant, so this is the only honest way to express a
reversal. `isSignedAmount` sits beside `isAmount` in the money domain precisely so that which
fields may go negative is a decision somebody took rather than a regex nobody read.
Overpayment is allowed. Money attaches only to an ISSUED invoice — a draft has asked for
nothing, a cancelled one is a refund — enforced by a trigger as well as the service.

**A credit note is its own document with its own consecutive series**, keyed
`document_type = 'credit_note'`; interleaving it with the invoice series would leave an
invoice number an auditor cannot account for. **Its reason is mandatory and closed**, because
without it the numbers always reconcile and *why* money came off does not — and "how much did
we write off to service failures" is a GROUP BY, which free text cannot answer. The reason
travels in the ledger payload for the same reason.

## Chasing a receivable — and the one rung a machine may not climb (T3.5)

The dunning ladder is **config**, the registry's fifth kind: D+3, D+7, D+15 are the firm's
numbers and they change, so a partner edits them without a deploy. One entry holds the whole
ladder rather than one per rung — the rungs are read together and their order is the meaning.

**The terminal rungs are `credit_hold` and `legal`, and the worker may reach them and may not
apply them.** They are the two things on this ladder a firm cannot take back with an apology,
so the row lands `pending_approval` and a partner decides. That is enforced in the schema —
`dunning_action_gate_chk`, plus a decider that is NOT NULL exactly when a decision exists —
and not only in the sweep, because a rule in a worker is one a second worker, a script or an
agent walks straight past. A rejection is recorded as loudly as an approval: *we considered
legal action and decided against it* is a fact somebody wants three months later.

**Chasing is at-least-once, like everything the engine touches.** `UNIQUE (tenant_id,
invoice_id, step)` makes a second chase impossible and the event is written only when a row
was actually created, so a redelivered message leaves one row and one event. The sweep takes
every DUE rung rather than only the next, so a week of downtime does not need seven sweeps.

`DunningService` is its own use case, not part of invoicing: invoicing answers *what does this
client owe*, which is arithmetic over rows; this answers *what will the firm do about it*,
which is policy on a clock. They meet at `outstanding()` and nowhere else — which is also why
paying an invoice stops the chasing with no flag for anybody to clear.

## The document store — bytes, and the one route they leave by (T3.6)

`files.document` / `document_version` / `document_link` / `brand_asset` (migration 0037). **A
new schema, and not tidiness:** `crm.document_block` (G1.7) is PROSE inside a proposal and
`crm.document_ref_series` (0020) hands out `PR-2026-0007`. A `crm.document` beside
`crm.document_block` would read as "the document a block belongs to". `domain/document` is
the words; `domain/filestore` is the bytes. They meet only where a rendered letter becomes a
file.

**Bytes leave by ONE route and there is no pre-signed URL.** That is a design position, not a
missing feature: a pre-signed URL is a capability that outlives the session that minted it and
is checked by a storage vendor, so it answers to **none of the four scoping gates**. The
version row naming the storage key is read under RLS, which makes the key unreachable before
it could be used. If object storage ever replaces the filesystem adapter, this stays true —
the port has no method that returns a URL, and adding one is the thing not to do.

**`document_version` is append-only by GRANT, not by trigger.** `bib_app` holds SELECT and
INSERT and nothing else, the same arrangement the `ledger` schema has. A trigger is a rule the
table carries; a missing grant is a permission the role does not hold, and an import or an
agent walks past the first and not the second. `document_link` has no UPDATE either — changing
what a document is attached to, in place, rewrites "what was filed against this engagement"
with no trace. **Detaching is deliberately not implemented**: whether an attachment made in
error should vanish or remain visible as withdrawn is a question for a firm, not a guess.

**Storage is content-addressed, and the cost is the interesting half.** The key derives from
the sha256, so a client re-sending a file stores one blob. The consequence is that **two
documents can share a blob**, so nothing may delete bytes because one document went away —
which is why `BlobStore` has no `delete` and must not grow one. A retention or erasure
requirement is a deliberate feature with reference counting behind it.

**`subject_ref` carries no foreign key and cannot** — it points at a different table depending
on `subject_kind`, following `delivery.job`'s `(source_kind, source_ref)` idiom rather than a
second one for the same shape. The CHECK on `subject_kind` is the containment: a dangling link
is possible within a KNOWN vocabulary, never a pointer to anything at all. Adding a kind is a
migration AND a case in `linksOf`'s label resolution — a kind nothing can resolve is a link
nobody can follow.

**Brand assets are keyed on the ENTITY, never the firm.** G1.2's rule applied to paper: a firm
signing on two letterheads must not print the Indian logo on a letter its US entity issued.
Superseding is an insert plus a cleared flag under a partial unique index (`WHERE is_active`),
so the mark in force when a document was issued stays resolvable.

**The filesystem blob store is the FOURTH honest-registry stub** and gets the same treatment as
the first three: `validateServer` refuses a production-like boot on it. Replicas do not share a
disk (an upload through one pod is a 500 through the others, intermittently), and a container
filesystem does not survive a restart, leaving metadata that outlives its bytes.

**Rendering is NOT here.** A `DocumentRenderer` port was written and deleted before commit,
under this file's own rule that a contract designed against no consumer ends up wrong (the
reason T2.5 deferred `workflow_template`). It is T3.8, and the constraint that decides its
engine is stated there: a document's content hash is evidence, so the renderer must be
deterministic.

## The delivery engine — a second process, and at-least-once everywhere (T2.6)

`npm run worker` is a SEPARATE PROCESS from the API, with its own composition root
(`setup/worker.ts`). Compliance work runs for months and pauses on a human decision, which
does not belong inside a request. `npm run worker:once` runs the same sweep with no queue in
front of it — a different entry point, never a different rule.

**The engine hears about work through the LEDGER, never through a call.** `contract.activated`
is written because a contract activated, not because anything downstream wants to know; the
scheduler reads activations that have no job yet (an anti-join). So the commercial lane does
not know an engine exists, the ledger is a durable and replayable queue by construction, and
T3.5's payments will read the same event without engagement changing again.

**EVERY TRIGGER IS AT-LEAST-ONCE, and that is the whole design.** pg-boss redelivers on a
crash, the sweep re-reads events it has seen, a restart leaves a message unacknowledged. None
of it may produce a second job, because a second job is a second set of tasks for staff and
eventually a second invoice. It is structural rather than careful: the job id is DERIVED from
its cause, `UNIQUE (tenant_id, source_kind, source_ref)` makes the second insert conflict, and
the event is recorded only when a row was actually created. A terminal job is final — work
that must happen again is a NEW job with its own cause.

**`delivery.job` is not pg-boss's row.** pg-boss's is a delivery ATTEMPT: retried, archived,
eventually deleted, carrying no tenant and obeying no RLS. Ours is a business fact — "we owe
this client this work, it is on step 3, here is what caused it" — tenant-scoped and outliving
every retry. pg-boss carries the trigger; the table carries the work.

**pg-boss migrates its own tables, and that is a real exception to the migration rule.** The
line is drawn exactly: migration 0042 creates the `pgboss` schema and grants `bib_app` CREATE
on **that schema and no other**, and `createSchema: false` stops pg-boss issuing its own
`CREATE SCHEMA` — which fails with 42501 regardless, because PostgreSQL checks the database
ACL before the existence check. Granting the app role CREATE on the database would have bought
a statement that has nothing to do, at the price of letting it create objects anywhere.

**The date arithmetic is pure and has no `Date` in it.** `domain/scheduler/model.ts` works in
ISO strings: a filing period is a calendar fact in a jurisdiction, not an instant, and a UTC
`Date` moves a period boundary by a day for anyone east or west of it. A quarter is aligned to
the FINANCIAL year (Apr–Jun for India), which is the calculation that looks right three times
out of four if nobody thinks about it. T3.2's calendar is its first real consumer.

## The orchestrator — a process a firm writes down, and steps a person can tick (T2.7)

T2.6 gave a signed engagement a JOB. This gives the job a PROCESS. The point of the task is
plain: "how we do a GST filing" lives in a partner's head, and this is where it gets written
down once and walked automatically.

**The template is `workflow_template`, the registry's sixth kind** — deferred at T2.5 on the
stated grounds that a body designed against no consumer ends up wrong, and built now because
the orchestrator reads it. The validator refuses a CYCLE, a dependency on a step that does not
exist, and a duplicate step key, all at the WRITE — each of them produces a job that sits
half-finished with nothing saying why, and a partner looking at a screen can fix what a worker
at 3am cannot.

**The graph is `dependsOn`, and all three shapes fall out of ONE rule**: a step is ready when
every step it depends on has settled in a way that clears its dependents. Sequential is a
chain, parallel is two steps on one dependency, branch is a skip. **A skip CLEARS its
dependents; a failure does NOT** — that is why there are two terminal-but-not-done states, and
collapsing them would either strand a graph or release work that was waiting on a machine that
gave up. `cascadeSkips` is the other half of a branch: skipping only the conditional step
leaves everything downstream waiting forever.

**AGENTS ARE OPTIONAL, and this is a product decision, not a stopgap.** `human` is the ordinary
executor. A firm can write its whole process with every step human and it runs TODAY; a step
becomes an agent's later by changing one field, with no template rewrite and no migration. The
rule that follows: **a template may say `agent` before any agent exists, and the job does not
fail — the step waits for a person.** `NoAgentsBuiltYet` is the honest implementation of a true
statement about this product, which is why it is NOT gated on config the way the dev auth
resolver, the logging mailer and the attested signer are: those are stubs for something that
must exist before launch, and a firm running entirely on human steps is a supported permanent
way to use this.

**The pin is the point, and it is at the JOB.** `delivery.job.template_version_id` is written
ONCE (`WHERE template_version_id IS NULL`, in SQL, so two workers cannot both set it), and from
then on the job resolves that version and never what is in force. Editing a process must never
rewrite a job already walking it. **The SERVICE, by contrast, is read LIVE** — through the
letter line's pinned version to the ENTRY and back out to what is published now. A client
agreed to the service, its price and its scope; they did not agree to our internal steps. That
started as the opposite and was a real bug: every engagement signed before a firm wrote its
first process pinned a service version naming no template, so those jobs could never pick one
up.

**`delivery.job_step` is rows, not a blob on the job**, for three reasons and the third
decides it: dashboards need "how many are stuck on review" without a scan, work is handed out
by an indexed column, and **T2.9's maker != checker can only be a DATABASE constraint if who
performed a step is a column**. `performed_by` therefore exists now and no rule reads it yet —
adding it later means backfilling a fact nobody recorded.

**A skipped step is kept and shown.** `skipped` is not `done`, and the schema INSISTS on a
reason for a skip and a failure while forbidding one everywhere else, because that note is only
ever written by somebody already in a hurry. The ledger carries the FACT and its values, never
the prose: a sentence does not `GROUP BY`, and this log cannot be erased.

**AN UNRESOLVED FACT KEEPS THE STEP.** A service that never stated its recurrence must not
quietly lose a review because a field was blank. An extra review costs an hour; a missing one
costs a filing. Read `evaluateCondition` before "simplifying" it into an else.

**`listRunnable` includes `blocked`**, and leaving it out was the second real bug here: a job
waiting on a person vanished from the work board AND from the sweep, so nothing would ever look
at it again. Only `done` and `cancelled` are excluded — those never move.

**Step conditions test a CLOSED set of facts** (`recurrence`, `jurisdiction`), both of which
already exist, with a CLOSED set of operators (`equals`, `not_equals`, `in`, `not_in`). A
little expression language was refused: it is a vocabulary nobody chose, no partner can write
and no test can cover. Adding a fact is a member of `StepFact`, a case in the orchestrator's
resolver, and a line of documentation.

**THERE IS NO `gte` / `lte`, AND THAT IS THE SAME RULE AS EVERYTHING ELSE HERE.** The firm's
own compliance list (given 2026-08-30) makes a THRESHOLD its single commonest driver —
*"turnover > ₹1 Cr"*, *"AATO ≥ ₹5 Cr"*, *"net worth ≥ ₹500 Cr"* — but nothing in this schema
stores a turnover, an employee count, a paid-up capital or a listed status. A numeric operator
today would sit in a picker beside `jurisdiction`, compare a string, and do nothing: a control
that looks live and is inert. It arrives with the first NUMERIC FACT, which arrives with the
data, which is T3.2.

**The SHAPE moved and the operators did not, and the asymmetry is deliberate.** Adding an
operator later is backward compatible — a frozen body naming `equals` still reads. Changing
`{ fact, equals }` into `{ fact, op, value }` later would not have been, because every body
published in between would carry the old shape forever. So the shape changed the day the need
was known and the operators wait for their data. **The legacy `{ fact, equals }` is not
deprecated — it is frozen into every version published before operators existed, and
`readStepCondition` normalises it to `op: "equals"` on the way out so the evaluator only ever
sees one shape.**

**AN UNRESOLVED FACT KEEPS THE STEP — under EVERY operator, and the negative ones are the
subtle half.** "The jurisdiction is not IN" reads as true when the jurisdiction is unknown, and
it is not true, it is unknown. Evaluating `not_equals` against a null would let a blank field
SATISFY a condition, which is the same failure as skipping on one, reached from the opposite
side. The null check is therefore before the operator is even looked at.

**`work:write` (migration 0045) is what a person needs to say a step is done.** Its own
permission, because the row it gates is the record of who did the work.

**ONE CLIENT, ONE TEAM, ONE LETTER — ONE CHECKLIST (migration 0046).** `crm.engagement`
carries `UNIQUE (engagement_letter_line_id)`, so a three-line letter is ALREADY three
engagements and three jobs. The grouping therefore MERGES; it never splits. The key is
**`(engagement_letter_id, entity_party_id, axis code, workflow key)`** and every part is
load-bearing:

- **`entity_party_id` is the one that is not negotiable.** The firm's Per Company rule: vCFO
  for four companies is four engagements because each files its own returns. Merging across
  entities would put two companies' filings on one checklist. Keep it in the key even though
  a letter normally names one entity — `engagement_letter_line.entity_party_id` is per LINE
  and NOT NULL (0018), so the schema permits a mixed letter and the key is what makes the
  rule hold rather than the practice holding it.
- **`engagement_letter_id`** — a job has to be able to FINISH. Two letters months apart are
  two contracts, and without this one job grows for the life of the client relationship.
- **the workflow key** — two services naming two processes are two processes by the firm's
  own account, and merging them invents an order nobody wrote over step keys that can
  collide. In practice a team's services name one process or none, so the merge still
  happens.

**`none` merges NOTHING** — one job per engagement, exactly what every firm has today. It is
a real answer, not "unconfigured", and a default that merged would have silently re-cut every
firm's work.

**Two uniqueness rules, and they are different rules.** `job_engagement UNIQUE (tenant_id,
engagement_id)` is ABSOLUTE and forever: one engagement's work exists in exactly one job,
which is what stops a second set of tasks and a second invoice. `delivery.job`'s own key is
PARTIAL (`WHERE status NOT IN ('done','cancelled')`) — at most one OPEN job per group,
because a group whose checklist finished must get a NEW one when a later line's advance lands
months later. Attaching new work to a finished checklist is work nobody looks at again.

**Every job has link rows, merged or not**, so "what is this job FOR" has one answer
everywhere. `source_ref` is back to being nothing but an idempotency key, and for a merged job
it names NO row — it is the group key, derived. **Which is why a job list can never render it:
`GET /api/v1/jobs` carries the company, the client and the SERVICE NAMES**, in one query for
the page, and `GET /api/v1/jobs/{jobId}` exists because the list is only what is RUNNABLE and a
finished job's steps were otherwise readable with nothing saying whose work they were.

**`job.scope_extended`** is the verb for a later line joining a checklist already in flight —
its own verb, because "why did this job gain a service on the 14th" is a question a spawn event
cannot answer.

**What does NOT happen:** changing `work_split_axis` re-cuts nothing that already exists. That
is G2.4's stated design, and it means a firm that switches mid-year has two shapes of job on
its board until the old ones finish.

## The agent guardrail — built before there is an agent (T2.8)

There are still no agents, and `NoAgentsBuiltYet` is still wired in `setup/`. This task built
the RAILS: what a machine would be allowed to do with what it produced, before anything
produces anything. That order is the board's (*guardrails first, then capabilities*) and it is
the product's — get manual work into the product standardised, then replace some of it.

**The guardrail is a CHECK in migration 0047, not a rule in the orchestrator.** `build2.md` in
the firm's words: *a rule that lives in a form is a rule that a script, an import or an AI agent
walks straight past* — and here the rule is ABOUT agents. A CHECK cannot read config, so
**`delivery.agent_run` copies the thresholds that applied** onto every row, the same move
`job.split_code` and `job_step.executor` make. It also makes "why was this allowed" survive the
firm raising its bar next quarter.

**A machine acts unattended only STRICTLY above the bar.** `>` and not `>=`, so **1.0 means
never** — one edit stops every unattended commit with no deploy. Do not "tidy" that comparison.

**Three answers, not two.** `committed` · `queued` (the machine answered, a person says whether
it stands) · `escalated` (it was not sure enough to answer). The middle one is the point:
"commit or don't" throws away a usable draft every time the machine is unsure, which is most of
the time, and a firm redoing the work by hand has bought nothing.

**`confidence_tier` is the registry's SEVENTH kind, not a table**, and the reason is the
question it answers: *why did this commit on its own?* is asked a year later and the only true
answer is "the bar was 0.95 that day". A run PINS the version it was judged under. `staff_grade`
went the other way for the opposite reason — nobody asks what a rung meant last March.

**NOTHING IS SEEDED, and shipping this changed no firm's behaviour.** No published tier means
`ASK_A_PERSON` — `(autoCommitAt 1, reviewAt 0)`, so nothing commits and everything proposes,
expressed in the same two numbers so no code has a special case. The discount policy's rule
from the same direction: *no published policy means ZERO, not "no limit"*. `SUGGESTED_TIERS`
(0.95 / 0.70) is a starting point a firm publishes deliberately — and those numbers are **not
the client's**: the demo records them as inherited from another vendor and never agreed.

**THE TEMPLATE OUTRANKS THE NUMBERS.** `agent_with_approval` never commits, whatever the
confidence — the firm said a person signs this step off, and that is a decision by somebody who
knows what the step does. `approval_required` is stored on the run so the CHECK can express it,
and so "unsure" and "always checked" stay different facts. **This is why the thresholds are not
the load-bearing product decision**, and why `runsAMachine` is a separate question from
`waitsForAPerson` — conflating them was a real bug: `agent_with_approval` was blocked before
`agents.run` was reached, so the machine produced nothing and the person had nothing to approve.

**`proposed` and `applied` both survive forever** (`build2.md` §5.2). Keeping only the corrected
value throws away the entire accuracy signal — the only evidence that could ever justify moving
a threshold. Two CHECKs keep it honest: a `corrected` must ACTUALLY differ, an `accepted` must
not. A rejection must say why, and does NOT finish the step: throwing away an answer is not
doing the work.

**Nothing about a run can be rewritten** — a trigger refuses edits to the proposal, the
confidence, the thresholds, the decision or the provenance. A person's verdict is the one half
that legitimately arrives later. `model` and `prompt_version` are NOT NULL from the start,
because *"extraction got worse in March"* needs something to blame and something to revert, and
adding them later means backfilling a fact nobody recorded.

**Ticking Done behind a proposal is refused** (`PROPOSAL_UNDECIDED`): it would record that a
person did the work and leave what the machine said undecided forever.

## Who may check somebody else's work (T2.9)

Two rules, and only one of them is the firm's.

**MAKER != CHECKER is the product's, and it is not a setting.** `step_approval_maker_is_not_checker`
in migration 0048, for `build2.md`'s stated reason — *a rule that lives in a form is a rule that
a script, an import or an AI agent walks straight past*. `isEligible` applies it too, so a
person is TOLD rather than shown a constraint violation, and the wall underneath still holds for
everything that never reaches this code. `maker-checker.integration.test.ts` proves it as the
OWNER role.

**`submitted_by` IS DERIVED AND FROZEN, and that is what makes the CHECK worth anything.** It
compares two columns; if a writer could set both, the way past it is to name somebody else as
the maker and approve as yourself. A BEFORE INSERT trigger reads it from
`job_step.performed_by` and a BEFORE UPDATE trigger refuses to let it move. The application
cannot set it, the fakes model that, and the integration test attacks it specifically. **Do not
add a `submittedBy` to any write path.**

**WHO ELSE may check is the firm's, and it is a `verification_policy` — the registry's EIGHTH
kind.** The client gave two answers on different days and they are different controls:
*"Manager or above is fine"* (a rank threshold) and *"manager means engagement manager"* (a
reporting line, which stalls the morning that person is on leave). The demo's own S3 says this
is *"the maker-checker control and not a line to draw on the firm's behalf"*, so the firm draws
it: `rank_threshold` · `reporting_line` · `reporting_line_or_rank`. **Nothing is seeded.**

**It is a kind and not a column for `confidence_tier`'s reason**: *who was allowed to approve
this filing in March?* is an audit question, a published version is frozen, and an approval PINS
the version it opened under. `minGradeRank` stores the RANK, not the code — the opposite of what
a `service` body does with an axis code, because a stored code would be re-resolved against
today's ladder and answer March's question with April's row.

**And a firm publishes SEVERAL, because a step names one.** SQC 1 — ICAI's own quality-control
standard — wants an engagement quality control reviewer to be both *suitably qualified* (a rank
test) and *independent of the engagement team*, which a reporting line is the opposite of. An
ordinary manager review and an EQCR sign-off are two rules inside one process. `excludeEngagementTeam`
is deliberately NOT built: "engagement team" is the Dept-vs-delivery-team axis the client has
not settled (G2.4), and an independence rule written on a guessed axis would decide who may sign
off an audit.

**`membership.reports_to_user_id` is a FOURTH axis and grants nothing** — role says what you may
reach, commercial visibility whether you see money, grade how senior you are, and this one who
checks your work under a reporting-line rule. It exists because nothing else in this schema
records a staff reporting relationship: `core.party_relationship` is between PARTIES and a
member of staff is a `user_account` plus a membership, never a party. **Not effective-dated**,
and that is stated rather than implied: nothing records when a reporting line STARTED, so the
column answers "now" and the ledger answers "when did it change". Two refusals a database cannot
make are the service's — a manager who is not an active STAFF member of this firm (the FK points
at a GLOBAL table and would accept a stranger), and a loop, which a CHECK cannot see past one
row and which would silently leave everybody in it with no eligible checker.

**A checked step does NOT finish.** It stays `blocked` — a fourth cause of that state, and the
work is DONE there — `performed_by` is recorded, and an approval opens. A review that does not
hold up the work downstream is a review nobody has to do. Approving finishes the step and
advances the job in the same call; **rejecting moves nothing**, keeps the reason, and the redo
opens a SECOND row so "this took two goes" survives.

**`work:write` is a FLOOR under the firm's rule, never the whole answer.** Approving somebody's
filing writes to the record of whether the work stands, so it needs the permission that already
gates saying it was done. Without that floor a read-only Management membership carrying a Senior
Manager grade would pass a rank threshold — which is the demo's Q41, still unanswered. This does
not invent a role rule; it applies one the firm controls on the roles screen.

**T2.9 lives on `OrchestratorService`, not in a service of its own**, the same judgement T2.8
made about `decideProposal`: a check is part of a STEP's lifecycle. Splitting it would mean a
handler calling two use cases or two services holding each other, since opening a check happens
when work finishes and finishing work happens when a check passes. The RULE is pure in
`domain/verification`.

**The queue is the WHOLE FIRM's, and every row carries the viewer's verdict.** Under a rank
threshold there is no "mine", and a list filtered to what you can act on hides that six filings
have waited a week because nobody senior enough looked. **Ordered oldest-first, with no due
date anywhere**: the firm has not given its turnaround times (client ask 3.4) or its escalation
matrix (3.3), and a deadline this product invented is a priority the firm never set. `slaDays`
stays earmarked for T3.1.

## First module

`tenancy`, `party`, the `ledger`, the `config` registry, the `lead` pipeline, `proposals`,
`engagement letters`, the `staff grade` ladder, the firm's `service axis` lists, the
`scheduler`, the `orchestrator` and `invoicing` are built.
Next: T2.9's verification queue, G3.2's client assignment, T3.6's documents and T3.7's dashboards.
Reuse the platform's auth, notifications and config; do not rebuild them.

**Assignment is territory first, rotation second (T2.1b).** `FirstMatchAssignment` in `setup/`
takes an ordered array and the ORDER is the firm's precedence — a third rule is a line there, not
a branch inside a strategy. `crm.territory_rule` says whose desk covers a country, keyed on
`crm.lead.jurisdiction` (where the PROSPECT is, nullable because it is often unknown at capture).
There is deliberately **no wildcard rule**: the rotation is the fallback, and it is a better one
than a catch-all row somebody has to maintain. A rule never overrules a person, and a rule whose
desk has been revoked DECLINES — checked as a join inside the strategy's own statement, because a
membership goes inactive long after the rule was written and no foreign key can express "active".

`AssignmentStrategy.assign` returns `{ lead, policy }` rather than the strategy declaring a
`policy` field. With one rule a field was fine; with two it lies, because which rule chose is a
fact about the LEAD. `lead.captured`'s `ownerAssignedBy` is the whole point — "the rotation chose
Anand" and "the UK desk rule chose Anand" are different facts, and only the first is evidence
about whether the rotation is working.

**A lead is a party.** The pipeline does not keep its own copy of a prospect: capture resolves
a party by identifier FIRST (phone + PAN + email, normalised), and `crm.lead` holds only what
is about the opportunity — source, stage, owner. At most one OPEN lead per party, enforced by
a partial unique index, which is what makes a duplicate capture *append* rather than compete.
Capture goes through `PartyService` behind the lead use case's own `ProspectDirectory` port,
so prospects get the same validation and the same `party.created` events as any other party.
A lead has no timeline table: its history is the ledger.
