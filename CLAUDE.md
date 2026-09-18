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

**AND SINCE T6.5 THERE IS SOMETHING BEHIND THEM** — `GET /api/v1/portal/home`, the first portal
route that returns a business record, with its own section near the end of this file. Read it
before adding a second one: a portal read is three things, and gate 2's exact-path match is a
constraint on what a portal route may even look like.

**ALL FOUR ARE BUILT SINCE 0059** — gate 4 was the last, and it went in BEFORE the portal
screens rather than with them: a portal read written against no gate has to be written twice,
and the second version is the one nobody reviews. It is `crm.portal_access` (which companies a
portal LOGIN was granted, effective-dated, one row per company), `tenancy.membership.party_id`
(which PERSON a login is — a different question, and the half that also lets the org chart hold
the majority of a firm who have no login), `withPortal` in `src/db/tenant.ts`, and RESTRICTIVE
policies written in terms of `crm.portal_sees()`.

**ACCESS IS GRANTED, NEVER DERIVED, and that is the decision in it.** `core.party_relationship`
already knows a company is in a group, and reading portal access out of that graph is one join
and is wrong: the screen that writes relationships is the CRM screen, so recording "Cobalt is
part of the Kaveri group" would silently hand a Cobalt contact the group's filings, reviewed by
nobody, because a CRM edit is not reviewed as an access-control change. There is deliberately no
default and no widening — a group's contact who should see four companies gets four rows —
because whether one contact sees a whole group is a fact about the ENGAGEMENT and the firm has
never been asked (G0.1: four companies file four sets of returns).

**"Unset" and "empty" are different values, and that distinction IS the safety.** `app.portal`
is `'on'` only inside `withPortal`, so every staff request takes the first branch of
`portal_sees()` and the restrictive policies cost it nothing. A portal session with no grants
sets an EMPTY list and sees nothing. Skipping the call because the list is empty would leave the
session looking like STAFF — the one mistake here that is silent, because every read would
succeed. `withPortal` has no variant that takes no parties, on purpose: "I did not ask the grant
table" is not a scope.

**THE GRANT PATH IS `usecase/portalaccess`, and `portal:grant` is the NINTH permission
(0060).** Not `tenant:admin` — a firm that wants the partner who owns a client relationship to
invite that client's CFO, without also handing them the roster and the roles, could not express
it. Not `party:write` either, which G3.2 gave client OWNERSHIP on the stated ground that naming
a Key Manager grants nobody anything: this is the opposite kind of act, and the only permission
in the product that hands somebody OUTSIDE the firm a view of the firm's work. The READS carry
it too, because the list names a client's own people and what each may see.

**ONE CLIENT PER GRANT, always.** A contact who should see four of a group's companies is
granted four times — four rows, four events, four answers to "who decided this". The service has
no method that takes a list and none that walks a relationship.

**Every refusal in that service is one the DATABASE cannot make.** The composite foreign keys
prove the membership and the party are this firm's; nothing in SQL says the login is a
CLIENT_PORTAL one that still works, or that the party is not a client the firm has archived. The
exclusion constraint still refuses an overlapping duplicate under concurrency — the service is
what a person is TOLD before they meet it.

**REMOVE MEANS NOW (decided 2026-09-01, migration 0061).** `validTo` is the FIRST DAY NOT IN
FORCE and `end` defaults to TODAY, so the access is gone on the next request. It defaulted to
tomorrow for one commit, on the reasoning that keeping the day whole stops somebody who read a
document this morning showing as never having been allowed to — and **walking it over HTTP
settled it the other way**: the firm presses remove, asks what the session can see, and the
client is still there. That reads as a bug and is one when somebody is removed for cause. The
row now understates that person by part of a day and nothing is lost, because
`portal_access.ended` carries the INSTANT — the row is date-grained, the ledger is not.

0061 relaxed the CHECK to `valid_to >= valid_from` so that **granted at 10:00, revoked at 10:01**
is representable at all: an EMPTY range, in force on no day. `daterange(d, d, '[)')` is empty and
`&&` never matches it, so the exclusion constraint keeps working and an empty grant cannot block
the re-grant after it. **CREATING one that way is still refused, by the service** — a grant in
force on no day is a typo at the moment of granting, while ending one is a decision somebody took
twenty seconds later. The database allows the shape; the service allows only the act.

**A policy per table as each portal read lands, never a sweep.** `delivery.work_item` is guarded
by 0059 because it is the one business table carrying `client_party_id` directly, and
`delivery.obligation_instance` by 0062 — on `entity_party_id`, because that is the column THAT
table names (see the portal section below for why no join reaches the client from there). The column that
names the client differs per table and a guessed join is a wall with a hole in it; until each
gets its line, those tables are unreachable through gate 2, which is a real defence and not a
permanent one. `tests/portal/gate4.integration.test.ts` is the proof and it TRIES — it asks for
the other client's row by id, and it was checked by dropping the policy and watching five of its
six tests go red.

Gate 1 is RLS; gates 2 and 3 are prefix middleware (`api/guards.ts`),
both **denied by default** — a `CLIENT_PORTAL` session reaches only `PORTAL_PATHS`, and a
route absent from `ROUTE_PERMISSIONS` is refused for everyone. **Roles are config rows the
firm owns** (T2.5), read through the `PermissionSource` port; the swap changed no call site,
which is what the port was there for. `DEFAULT_ROLES` in `domain/authz/model.ts` is now only
the SEED a new tenant's rows are written from — nothing consults it at request time, and
there is deliberately no fallback to it (see the configuration registry below). A role the
firm does not define carries nothing and says so (`UNKNOWN_ROLE`), because a firm locked out
by a typo must not look like policy working as intended. The fee axis is `AuthzService.seesFees()` / `withFeeVisibility()` — it
**redacts** money rather than omitting the record, so "you may not see this" never looks
like "there is no fee".

## The configuration registry — data, not code (P2 / T2.5)

The things a firm changes weekly are rows, not deploys: `config.entry` is the thing being
configured (`tenant × kind × key` — "the GST filing service", "the partner role") and
`config.version` is what it said at a point in time. Ten kinds ship today — `service`, `role`, `policy`, `clause`, `dunning`, `workflow_template`,
`confidence_tier`, `verification_policy`, `compliance_policy` and `escalation`; `rule_pack` joins them when T4.3
actually reads it.
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
`client_assignment.axis_id` needs a real row to point at.

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

## A `date` column is a DAY, and postgres.js hands it back as a UTC instant

**Measured, not reasoned about:** `postgres.js` materialises a `date` column at **UTC midnight** —
`'2026-08-20'::date` comes back as `2026-08-20T00:00:00.000Z` in every zone. So an adapter reads
its **UTC fields** (`toDay` / `toDayOrNull` in `infrastructure/postgres/day.ts`) and never its
local ones, which name the day that instant falls on where the process runs — the day BEFORE,
west of Greenwich.

**The trap is the one that looks safer.** `getFullYear()/getMonth()/getDate()` reads like the
careful choice: no string slicing and no `UTC`, which in this codebase is usually what to be
suspicious of. `engagement-repository.ts` used it and carried a comment asserting the opposite,
`proposal-repository.ts` copied both, and nothing went red — the failure only appears west of
Greenwich and nothing here runs there. It would have surfaced as an engagement's `effective_from`
a day early on a laptop in New York, which is the base every SLA due date is counted from.

`tests/architecture/calendar-day.test.ts` bans the local getters in `infrastructure/postgres/` and
demonstrates the day being lost via `Intl`, so it fails on a UTC runner too — a behavioural test
alone proves nothing here, because east of Greenwich both implementations pass.

**Better still, where a query is being written anyway: `SELECT some_date::text`.** No `Date` is
constructed and no zone is involved. The compliance calendar does exactly that; copy it.

**This is a different question from "today".** `clock.now().toISOString().slice(0, 10)` is the
SERVER's day and is the honest fallback for a caller that did not say which day it is on — see
the client-assignment section. That one is answered by the caller sending `asOf`; this one is
answered by reading the right fields.

## A `timestamptz` is an INSTANT, and `::text` is not a format any browser must accept (T6.10)

The section above is about a `date`. This is its OPPOSITE and the two are constantly confused:
a DAY must never be parsed, an INSTANT must be — because the day a moment falls on is the
READER's question and only their browser can answer it. **The field's TYPE decides which rule
applies**, and getting it backwards is silent east and west of Greenwich.

**`SELECT now()::text` gives `2026-09-01 19:54:05.712839+00`.** ECMAScript pins the one string
`Date` is REQUIRED to accept — `YYYY-MM-DDTHH:mm:ss.sssZ`, a literal `T` and EXACTLY three
fractional digits — and leaves everything else to each engine. **V8 takes the Postgres form**
(measured, in `tests/architecture/instant-format.test.ts`), which is why every gate here was
green with it: node, curl, `smoke` and every browser walk on this machine parsed it and landed
on the right instant. JavaScriptCore historically does not, and every portal screen guards with
`Number.isNaN(at.getTime()) ? iso : …` — so the failure was never a crash, it was a client on an
iPhone reading `2026-09-01 19:54:05.712839+00` where the firm meant "1 Sep 2026".

**AND THE SECOND BUG IN THE SAME CAST IS THE WORSE ONE.** `timestamptz::text` renders in the
SESSION's `TimeZone`, not in UTC. `src/db/pool.ts` sets none, so it is the SERVER's — UTC in the
compose container, which is the only reason every string anyone here has looked at ended `+00`.
`render-source.ts` took an invoice's printed date from `created_at.slice(0, 10)` when
`issued_on` was null, so **the date on a numbered tax document an auditor reads depended on
`postgresql.conf`**: the same row slices to the 1st under UTC and the 2nd under `Asia/Kolkata`,
measured in `instant-format.integration.test.ts`. It is `day.ts`'s bug in different clothes — a
DAY derived from an INSTANT by a zone nobody chose.

**So `infrastructure/postgres/instant.ts` holds two helpers and both pin the zone.**
`isoInstant(expr, alias?)` writes `to_char(x AT TIME ZONE 'UTC',
'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` — byte for byte what JS `toISOString()` produces — and
`utcDayOf(expr, alias)` writes `(x AT TIME ZONE 'UTC')::date::text` for the cases that wanted a
day all along. `.MS` is three digits deliberately: `.US` is six, closer to what Postgres stores,
and back outside the spec, which is back to each engine deciding. NULL in, NULL out, so an
unanswered ask keeps its honest `null`. No `Date` is constructed at any point — `day.ts`'s
reason: a value that is never parsed cannot be parsed wrong.

**The guard is a GREP as well as an assertion**, for `calendar-day.test.ts`'s reason: a
behavioural test proves nothing when both formats pass everywhere this is developed, and the
failure is in a browser nobody here runs. `instant-format.test.ts` bans `_at::text` across
`infrastructure/postgres/` — `_at::date::text` deliberately NOT matched, because asking SQL for
the day is the right answer — and bans the format literal outside `instant.ts`, so there is
exactly ONE expression for the integration test to measure against a real server.

**When you want a day out of an instant, do not slice it.** `utcDayOf`, or the same expression
written out, the way `portal-home-repository.ts` and `escalation-repository.ts` already do. A
slice hides which zone answered.

**And postgres.js rounds a timestamp-shaped PARAMETER to milliseconds** — it turns it into a JS
`Date` on the way out. Found by measuring: the integration test's subject came back with three
fractional digits where the server stores six, until it was written as a SQL literal. Nothing
stores through that path today, but a test that means to observe precision cannot bind it.

## The firm's own timezone — which calendar a MONTH is cut on (T6.11, 0071)

The third rule in this family, and the one that decides a PERIOD. Keep all three apart:

| Question | Answer | Where |
|---|---|---|
| What DAY is this `date` column? | Read its UTC fields — postgres.js built it at UTC midnight | `day.ts` |
| When did this `timestamptz` happen, for a reader? | The READER's own zone, client-side | T6.9 |
| Which MONTH or DAY does this instant belong to, for the FIRM? | **`tenancy.tenant.time_zone`** | 0071 |
| What is TODAY for a SWEEP, which has no caller to send its day? | **the firm's zone** — `dayInZone(clock.now(), timeZoneFor(tenant))`, per firm, per pass | T6.14 |

**IT WAS THE SERVER'S, AND NOBODY CHOSE THAT.** `x_at::date` uses the session's `TimeZone`,
which `src/db/pool.ts` does not set. So `/portal/month` answered *"what did you do for me in
September"* on the database server's calendar: for an Indian firm a document filed at 02:00 IST
on 1 October is 20:30 UTC on 30 September and landed in SEPTEMBER, **on a client's own page**.
The chaser had the same bug with a sharper edge — `(asOf::date - raised_at::date)` decides which
rung has been reached, so a request raised after 18:30 UTC counted a day older and a D+3
reminder went out on day 2.

**THE FIRM'S ZONE, NOT THE READER'S, AND THAT IS THE DESIGN.** A digest is a STATEMENT BY THE
FIRM about a period, so it needs ONE boundary — otherwise the partner in Delhi and the client's
CFO in Dubai open the same September and see different documents in it, and the one missing a
row cannot tell whether it was filed late or whether their screen drew the line elsewhere. An
invoice's date is one date for the same reason. T6.9's rule is untouched and points the other
way: a MOMENT shown to a person is shown where they are.

**DEFAULT `'UTC'`, so applying 0071 changed no firm's behaviour** — `work_split_axis` and
`client_request_routing`'s position, third time. **A column, not a registry kind**: nobody will
ask what a firm's timezone said last March, and a frozen historical value would be actively
wrong, because moving offices means every future digest uses the new zone.

**It DOES restate what a past digest DISPLAYS**, deliberately: the page is computed on read, so
changing the zone re-cuts historical months at their edges. Every accounting product behaves
this way, and pinning a zone onto each month as it passed would mean a firm that corrected a
wrong setting could never fix the months it got wrong.

**VALIDATED BY A TRIGGER, because a CHECK cannot.** The only ways to ask Postgres whether a zone
exists are `pg_timezone_names` (a subquery) and `AT TIME ZONE` (STABLE) — neither is allowed in
a CHECK. 0070 put its own rule in a trigger for the same reason.

**AND `Intl.supportedValuesOf("timeZone")` IS THE WRONG LIST — measured, not assumed.** It omits
`UTC` and `Asia/Kolkata`, which are this product's default and its first customer's zone, and it
canonicalises Kolkata to `Asia/Calcutta`, **which this database does not know**. Validating
against it would refuse both correct values and recommend a broken one. `isTimeZone` constructs
an `Intl.DateTimeFormat` instead, and separately refuses an OFFSET (`+05:30`), which `Intl` takes
and `pg_timezone_names` does not — with a product reason that is better than the technical one:
an offset cannot express daylight saving, so a firm on `+01:00` would cut its months an hour
wrong for half the year. `tests/portallibrary/digest-timezone.integration.test.ts` pins the
measurement so a tzdata upgrade surfaces there rather than on a firm's settings screen.

**One adapter, many ports.** `PostgresFirmTimeZone` satisfies `usecase/chaser`'s `FirmTimeZone`,
`usecase/portallibrary`'s, `usecase/serviceaxis`'s `TimeZoneSetting`, `usecase/scheduler`'s
(T6.13) — and since T6.14 the escalation, nudge, obligation, dunning and orchestrator use cases'
too, each declared beside the use case that needs it. Two implementations would be two answers to
the same question, and a chaser counting days in one zone while the digest cuts months in another
is a disagreement nobody would look for.

**EVERY DAILY SWEEP CUTS "TODAY" ON THE FIRM'S CALENDAR (T6.14, 2026-09-18).** A sweep has no
caller to send `asOf`, and `clock.now().toISOString().slice(0, 10)` is yesterday in India until
05:30 — so for five and a half hours every night a T-X task was not raised, a filing due yesterday
was not yet MISSED, a D+1 rung had not fired, a D-1 nudge asked about the wrong day, and a step
opening at 01:00 was placed against the assignment in force the day before. The per-period spawn
(T6.13) and the chaser (T6.11) already asked the firm; the other five now do, through
`firmDay(tenantId)` = `dayInZone(now, timeZoneFor(tenantId))`, resolved per firm inside the
pass rather than once for all firms. **`filed_on` is the one exception and stays the UTC day**, by
the 2026-08-30 decision recorded under 0054, with `completed_at` keeping the instant; the
`today()` that remains in `usecase/obligation` exists for it alone. The routes that take a date
from the browser are untouched — the caller's day is still the caller's. The PORTAL resolves it
BEFORE `withPortal` opens — `tenancy.tenant` has no portal policy and must not grow one (T6.9's
rule about the Key Manager).

`tests/architecture/instant-format.test.ts` bans a bare `_at::date` across the adapters, beside
the `_at::text` ban it already carried. Same family, same reason: **name the zone**.

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

HONEST REGISTRY: the dev `x-user-id` resolver, the logging mailer, the **attested e-sign
signer** and the filesystem blob store are the stubs, all gated on config, and `validateServer`
refuses to boot a production-like environment with any of them. `tests/config/boot-gates.test.ts`
proves each refusal — a gate that stops refusing breaks nothing and is therefore silent. Do not
add another without the same treatment.

**The mailer is the first of them to have a real counterpart** — see the section below. The stub
stays, and so does its gate: `log` is still what a developer wants locally, and is still refused
in public. What changed is that `smtp` is now a thing to point the switch at.

## Mail — the transport that had to exist before anything could be deployed (T7.0)

`Mailer` (`usecase/identity/ports.ts`) has two methods and both are load-bearing outside this
system: `sendMagicLink` and `sendPortalInvite`. Until T7.0 the only implementation wrote them to
a log, which had two consequences nobody had stated as facts:

- **A CLIENT COULD NOT BE INVITED TO THE PORTAL AT ALL.** `logging-mailer.ts` said so in its own
  comment — *"the person on the other end of `to` is a CLIENT, not a colleague, so this one
  silently not arriving is a client who cannot get in"* — and an invite therefore meant somebody
  at the firm copying a URL out of a server log. Five portal tasks shipped screens no outside
  reader could reach.
- **AND THE PRODUCT COULD NOT BOOT IN PRODUCTION**, because `validateServer` refuses `log` there.
  Not "would behave oddly": the process stops. So this blocked deploying anything at all, not
  only the portal.

**It is plain SMTP and not a vendor SDK.** Google Workspace, Microsoft 365, Amazon SES and
Postmark all speak it, a firm in this market already has one of them, and switching provider is
then `.env` rather than a rewrite. `nodemailer-transport.ts` is the ONLY file in the product that
imports the driver; `smtp-mailer.ts` holds the letters and knows nothing about how they travel.
That split is what makes the letters testable without a socket, and the letters are the half with
judgement in them.

**THE INVITE HAS TO WORK AT NOT BEING PHISHING.** It arrives unasked, at somebody who never
signed up, from an address they have no reason to recognise, and asks them to open a link and set
a password — feature for feature, a phishing email. So it names the firm in the SUBJECT, says why
they are receiving it, says what they will be able to do, and tells them to check with their own
contact rather than replying. `firmName` exists on the port for exactly that sentence, and
`tests/identity/letters.test.ts` asserts each one rather than trusting this paragraph.

**A FIRM'S NAME IS DATA.** It reaches a Subject header, where a newline would let it append
headers of its own, and it reaches HTML, where a real company name carrying `&` or `<` would
become markup. Both are handled at the door and both are tested; blank-after-stripping is treated
as absent.

**THE EXPIRY NAMES ITS ZONE.** An email has no browser to ask, so the choice is between a zone
nobody chose and a zone said out loud — the same answer `instant.ts` (T6.10) gives for every date
this product renders. *"4 September 2026, 14:05 UTC"*.

### A failed send answers differently on the two paths, and that is a security decision

**`requestMagicLink` SWALLOWS it.** Everything in that method is built to tell the caller nothing
— an unknown or deactivated address returns early and the route answers 202 either way — and a
thrown send would undo all of it: 202 for an address with no account, 500 for one with an account
whose letter would not go. That is an **enumeration oracle assembled out of an error path**, and
it was unreachable while a log was the only mailer, because writing to a log cannot fail.

**`invitePortalContact` LETS IT OUT.** There is no account to be quiet about, a member of the firm
is watching a screen, and a silent failure is a client who never gets in.

**The failure is shouted about in the ADAPTER**, which is the only layer that knows a send failed
and the only one that may hold a logger — no use case in this product takes one. Without that line
the swallow above would make a broken relay completely silent.

**WHAT IS STILL MISSING, and it is now operationally real: there is no RESEND.**
`PortalInviteService` refuses a second invite to somebody who already has a membership, and its
own comment says re-inviting *"belongs on its own route when a screen needs it"*. With a log-only
mailer that never mattered because a send could not fail. With a relay it can — a bounce, a typo
in an address, a quota — and the contact is then created, granted, and permanently uninvitable.
It needs the question behind it answered first (*did they lose the link, or has somebody else
taken over that mailbox?*), so it is written down rather than guessed at.

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

## Who owns a client — the Key Manager and the SPOCs (G3.2)

`crm.client_assignment` (migration 0049) is who at the firm looks after a client, effective-
dated. **Key Manager** — one at a time, owns the relationship. **SPOC** — the day-to-day
contact for one Dept or delivery team; the firm's own practice is one per Dept (*"each client
will defacto have two SPOC, one from TRC and one from FRC"*), and a client buying RAA work has
three, which is why it is a row per assignment and not two columns.

It is in `crm` and not `tenancy` because it is the firm describing a RELATIONSHIP with a
client, not describing itself the way `staff_grade` and `service_axis` do.

**`axis_id`, not `module_id`**, and the widening is deliberate: 0043 made Depts and delivery
teams one list precisely because neither layer is universal, so pinning a SPOC to `dept` leaves
a firm with only teams nowhere to put one. It costs 10x Global nothing and it avoids settling
the open Dept-vs-team question in DDL. What IS enforced is structural — a SPOC has an axis, a
Key Manager never does.

**A DEPT MAY HAVE MORE THAN ONE SPOC, and that is a decision.** Shrestha, 2026-08-30, against
the board's own acceptance line: leave cover, a joint SPOC on a group, a fortnight's parallel
handover. So there is no "one per axis" constraint, "who was the SPOC in March" may answer with
a LIST, and every reader takes one. `ownership.integration.test.ts` tests the ABSENCE, so a
later tidy-up cannot add it back without somebody deciding to — and note the asymmetry that
chose the direction: dropping a constraint later is one line, adding one later fails against
whatever overlap the firm has already recorded.

**Two EXCLUSION constraints, not a partial unique index.** One Key Manager at a time per
client, and no duplicate (same person, same role, same axis, overlapping). An index over OPEN
rows constrains only today — two CLOSED rows overlapping in March would slip past it and leave
"who was the Key Manager in March" answering with two names, which is the acceptance criterion
failing behind a constraint that looked like it covered this. `btree_gist` +
`daterange(valid_from, valid_to, '[)')`.

**Half-open, `[valid_from, valid_to)`** — `valid_to` is the FIRST DAY NOT IN FORCE, like
`party_relationship`, `party_identifier` and `isInForceOn`. The demo used an inclusive bound and
copying it would have shown two SPOCs on every changeover day. **A handover closes the old row
at D and opens the new one at D**, in ONE transaction, and is never an `UPDATE` of `user_id`:
overwriting who the SPOC is destroys the only record of who it WAS.

**"TODAY" IS THE CALLER'S FACT, NOT THE SERVER'S — this module is the first to take that
seriously.** `clock.now().toISOString().slice(0, 10)` is a day out for a firm east of Greenwich
every morning, and opening the screen at 04:11 in Delhi found both halves of it: the panel said
"as of 29-08" on the thirtieth, and then a client assigned from that form was missing from its
holder's own book because `CURRENT_DATE` on a UTC server had not reached it. So `GET
/api/v1/my-clients` takes `asOf`, `listOpenForClient` takes the date, `CURRENT_DATE` appears
nowhere in this module's SQL, and the browser sends its LOCAL calendar day. **The defaults still
use the server's day**, which is the honest fallback for a caller that did not say — and the
same one-liner is still the convention in `invoice`, `dunning` and `lead`, which have the same
bug and their own task to fix it in.

`party:read` to see an account team, `party:write` to change one — not `tenant:admin`. Naming a
Key Manager grants nobody anything; it is a fact about a client, like its identifiers. Its
honest limit is on the SCREEN: the assign form needs the roster and the Dept list, both
`tenant:admin` reads, so a manager who may assign is shown no form — exactly the shape
`/leads`'s owner dropdown already has, left consistent with it rather than fixed on a whim.

## Rendering a document — and why the engine is pdf-lib (T3.8)

**A rendered document's content hash is evidence.** `crm.engagement_letter.signed_content_hash`
exists so "is the file the client holds the one we issued" is a comparison rather than a matter
of trust, and `files.document_version.content_hash` is what it compares against. So the
renderer must be a **pure function of its input**: re-rendering unchanged data has to reproduce
the bytes exactly.

That single requirement chose the engine. A headless browser gives better fidelity and cannot
promise byte-stability across versions — font hinting, image encoders and the PDF writer all
move between Chromium releases, so a base-image upgrade would silently stop every re-render
matching. pdf-lib is pure JS with no native modules and draws exactly what it is told. **The
cost is that layout is hand-built**: there is no CSS and no automatic table, and
`infrastructure/render/pdf-renderer.ts` carries a small column-and-flow engine. It is one file
behind `DocumentRenderer`, so the decision is reversible — but a replacement has to answer the
determinism question first.

**pdf-lib writes CreationDate, ModDate and a Producer string from the clock and its own
version.** All three are pinned from the document's own issue date. Without that, the test that
renders twice passes inside one millisecond and the property fails in production.

**Three collaborators, and none of them learns another's job.** `RenderableDocument`
(`domain/render`) is a neutral description — no fonts, no margins, no page size.
`RenderSource` (Postgres) knows what an engagement letter contains. `DocumentRenderer` knows
what a page looks like. A renderer holding repositories would duplicate read logic that already
exists in two services, and the duplicate is the one that drifts.

**Fonts are a CHAIN, not a font (T3.9).** No single file covers what this product needs at a
size worth shipping — measured, not assumed: Noto Sans `latin` has the em dash and *not* the
rupee sign, `latin-ext` has the rupee sign and *not* the basic range, `devanagari` has both plus
Devanagari. So text is segmented into runs and each is drawn with the first font that can draw
it. Adjacent characters on the same font merge, so ordinary English is one run and one draw.

Noto Sans is **OFL-1.1** and arrives as an npm dependency rather than a binary in this repo, so
it is versioned and auditable. `subset: true` embeds only the glyphs used, which is what makes
three fonts free: a plain English letter carries a few hundred bytes of Latin and nothing of the
other two.

`font-set.ts` imports `regenerator-runtime` and the reason is written beside it — a shim for an
upstream packaging defect in `@pdf-lib/fontkit`, which throws only on fonts with complex shaping
tables and therefore only on Devanagari. Do not remove it, and do not "upgrade" to `fontkit` 2.x:
it changed the subset API pdf-lib calls.

**The guard is derived from the fonts, never a hardcoded range**, so it cannot lie about what
the renderer can draw and it narrows on its own when a font is added. **It REFUSES rather than
mangling** — `UnrenderableText` names the character, its code point, the field and what the
chain does carry — because dropping a letter from a client's name on a legal document is worse
than producing nothing. CJK is the honest remaining gap.

Money still prints with its ISO code (`INR 216,000.00`), and that is now a product decision
rather than a limit: this is a cross-border product, and a bare symbol is ambiguous to a reader
in Dubai or Delaware. One function changes it.

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

**WHOSE DESK A STEP SITS ON (0301, 2026-09-18).** `performed_by` said who DID a step and nothing
said who was EXPECTED to; the firm's first real process names "Analyst / Associate / Senior
Associate" on eight steps and "Manager" on the ninth, and any member of staff could tick any
step. So a template step carries a `performer` BAND — `{minGradeRank, minGradeCode, maxGradeRank,
maxGradeCode}`, rank compared and code read, either end open, null for anybody — and a job step
carries `assignee_user_id`. At `createSteps` every human step inside its band defaults to the
job's Dept SPOC (`StepDeskResolver`, read from `crm.client_assignment` by the adapter because the
work item use case owns the same lookup and the two must not import each other); outside the
band it starts on nobody's desk rather than on a desk the process forbids. `assignStep` takes,
hands over or releases, checks the roster and the band, and writes `job.step_assigned` with
`how`. `completeStep` refuses somebody else's step (`NotYourStep` — take it first, one click and
one ledger row) and a performer outside the band (`PerformerOutOfBand`). `describeSteps` computes
`viewer.mayComplete` where the refusal is, so the button and the 409 cannot disagree; `my-steps`
is the desk. `tests/orchestrator/desk.test.ts`.

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

## Work items — the row on somebody's desk, and the firm's own words for it (T3.1)

`delivery.work_item` + `checklist_item` + `work_item_dependency` + `work_item_approval`
(0051), over `work_item_state` + `work_item_priority` (0050).

**IT IS NOT `job_step`, and merging them would have cost both halves.** A JOB is HOW work
gets done — which template, which steps, which agent — and its states are the ENGINE's,
identical at every firm. A WORK ITEM is WHAT is owed and WHOSE it is, and its states are the
FIRM's own words. Merge them and ad hoc work ("prepare the board minutes") has no home at
all, and a firm ends up renaming the engine's mechanics to get its own board to read
properly. `work_item.job_id` is nullable in both directions: many items may share one merged
job, and an item may have no job.

**MEANING IS A FLAG; NAMES ARE THE FIRM'S. Nothing in the product compares a state's or a
priority's `code`.** Rows buy the firm its vocabulary and immediately take something away: a
CHECK cannot say "a blocked item owes a reason", because it cannot see a word in another
table. The naive fix is `code = 'blocked'` — which hardcodes the very name the firm was
promised it could change, and the first rename switches the rule off *silently*. So
`is_initial` / `is_terminal` / `is_blocked` and `is_default` / `is_statutory_default` / `rank`
carry every rule, and `enforce_work_item_state_facts` (a trigger, because a CHECK cannot join)
reads those flags. **The smoke walk renames "Blocked" to "Stuck" and then proves the reason is
still demanded** — the only way to test a promise like this.

**"At most one" is a partial unique index; "at least one" is the service.** A firm may never
end up with no starting state, no default priority or no statutory default — each leaves it
unable to create a single task — and Postgres cannot express a constraint over the ABSENCE of
rows. So the floor lives in `WorkVocabularyService`, and marking another row moves the flag in
the SAME statement rather than leaving a window with none.

**`is_statutory_default` is the firm's own rule made mechanical** — *"due dates that are
statutory should anyway be high priority"*. A flag rather than the constant `'high'`, so a
firm that decides statutory work is Critical moves a tick. **Work spawned from an ENGAGEMENT
is deliberately NOT statutory:** an engagement's SLA is the firm's own promise, and defaulting
it true would put every piece of advisory work on the statutory priority and make the flag
meaningless the day it matters. T3.2's obligations set it, from the law.

**Routing refuses to guess, and the refusal is a SENTENCE.** One SPOC for the service's Dept →
assigned. None, or more than one (G3.2 allows several) → UNASSIGNED with `assignment_note`
saying which. Falling back to the Key Manager and taking the first SPOC are both rules the
firm never gave, and **a wrong assignee is worse than none**: it sits on a desk whose owner
believes it is not theirs, while unassigned work is visible in a queue that gets chased. The
note is what makes that queue clearable rather than a pile.

**`slaDays` is PINNED and the Dept is LIVE, on the same row.** A catalogue revision must not
make finished work retroactively late (G2.3), so the SLA is snapshotted from the version the
client SIGNED. A client agreed to the service and not to which of our departments delivers it,
so the Dept comes from what is published NOW — the same rule `unspawnedActivations` applies to
the grouping facts, and **the two must not drift**, or a job cut by one Dept would put its task
on another's desk. The due date's base is `crm.engagement.effective_from`, a `date` column,
never `signed_at`: turning an instant into a calendar day is a day out either side of midnight
UTC.

**A SECOND approval table, and the RULE is not duplicated.** `work_item_approval` exists
because `step_approval` hangs off a `job_step`, so work with no template could never be
reviewed — and *"every task is mostly reviewed"* is the client's words about the TASK. What is
reused unchanged is T2.9's `isEligible`, `VerificationPolicy` and the grade/reporting-line
comparison: one answer to "who checks whose work", two tables recording the answers.
`submitted_by` is DERIVED from the item's assignee and FROZEN by trigger, exactly as T2.9's is.
**Do not add a `submittedBy` to any write path.**

**A dependency is enforced on STARTING, never on finishing** — "this cannot start until that
is finished" is what it says. Cancelling stays allowed: cancelling something that never
started is a real act, and refusing it would trap the item. The cycle check walks the edge
list in the domain, because reachability is not expressible in a CHECK — the database catches
only the self-edge.

**`escalated_level` / `escalated_at` are still deliberately NOT built, and T4.5 did not add
them.** The demo has them. The ladder keeps its own rows in `delivery.escalation_notice`
instead, because a level on the item answers only *how far up* and loses when, which rung,
whether anybody was actually reached, and what a second reason for escalating the same task
was. A column with no writer is the feature that looks finished; two columns that lose the
question is the feature that looks answered.

### Three things this task found, and none was in T3.1

**`sweepActivations` promised per-tenant isolation from T2.6 and did not do it.** Its own
comment said *"one firm's failure must not stop the others"*; a throw in `spawnForTenant`
propagated out of the loop and every firm after it was skipped, silently. One firm with no
work vocabulary stopped the calendar for every client of every firm. Each firm is caught now
and the failure is REPORTED — `SweepReport.failure`, printed by `worker:once` — because a
silently skipped firm is worse than a stopped sweep, which at least gets noticed.

**A work-item failure must never lose the JOB.** Two facts: a job is the record that work is
OWED, a task is whose desk it lands on. `spawnForEngagements` is caught inside the sweep and
counted as `tasksFailed`; the job stands.

**PATCH WAS MISSING FROM THE CORS ALLOWLIST, since CORS was added.** T3.1 registered the first
routes that use it. The browser answers the preflight 204, reads the header, sees its method
is absent and DISCARDS the request — no server log, no status code, surfacing as "TypeError:
Failed to fetch" and reading as a dead endpoint. **`npm run smoke` could never have caught it:
curl does not preflight.** Found by clicking a checkbox on a screen.
`tests/api/cors-methods.test.ts` reads every verb the handlers register and fails if the list
falls behind.

**And a comment in 0051 was wrong until the integration test ran.** A BEFORE INSERT trigger
runs AHEAD of constraint validation, so `enforce_work_item_state_facts` catches a cross-tenant
state BEFORE the composite foreign key does, and answers with a sentence naming the state and
the firm. Both defences are real; the trigger is the outer one.

## The compliance calendar — generated, never typed (T3.2)

`delivery.obligation_template` + `_exception` + `obligation_state` (0052) and
`delivery.obligation_instance` (0053).

**AN OBLIGATION IS NOT A TASK, and everything here follows from that.** The obligation is what
the LAW requires of the ENTITY — Kaveri Foods must file GSTR-3B for August by 20 September. The
task (`delivery.work_item`) is what somebody at the firm must DO about it. Merge them and the
calendar can never be GENERATED, only typed, which is the exact Excel this product replaces.
Nobody adds a row: it falls out of which entities exist, what each bought, and what the law says
about that combination. **There is no create endpoint for an instance and there must not be one**
— if a human could add a calendar entry, the calendar could drift from the statute.

**These are their own tables and NOT a config-registry kind — the deviation `CLAUDE.md` requires
to be written down with its reasoning.** The registry is prescribed for a template or a rule
pack, and it was weighed and set aside for three reasons: the generator reads EVERY rule in one
set-based pass while the registry answers one key at a time; an exception needs a real foreign
key to the rule it modifies, which inside a jsonb body is a string somebody has to keep true; and
this shape is proven — it ran in the approved demo and produced a real calendar.

**The cost is stated rather than discovered later, and paid.** The registry would have supplied
versioning, publishing, freezing and pinning for free, so this table supplies them itself:
`rule_pack` is part of the rule's IDENTITY (the unique key is `(tenant, jurisdiction, name,
rule_pack)`), which makes a revision a NEW ROW and never an edit; `supersedes_id` is the chain;
retiring is `is_active` and the old row stays readable forever; and an instance PINS its template.
Without all four, *"why was this due then?"* — the one question an audit actually asks — is
unanswerable. The same shape of deviation `staff_grade` makes, and recorded here for the same
reason.

**`due_rule` IS NULLABLE, and that is the most consequential decision in the module.** The firm's
own applicability sheet holds 55 obligations; ten of them are formulas. The rest are not, and the
vagueness is CORRECT: *"within a statutory period after the AGM"* depends on an AGM date,
*"State-specific"* is a different day in Maharashtra and Karnataka, *"within 7 working days"*
needs a holiday calendar nothing here holds. The demo converted what it could and handed the rest
back BY NAME in a log. **A log is not an answer**, so all of them are ROWS: the computable ones
carry a due rule and generate, the rest carry a mandatory `unresolved_reason` in the firm's own
terms and say on the rules screen exactly what they still need.

`domain/obligation/rulepack-in.ts` therefore follows one rule without exception: **a due date is
encoded ONLY where the firm's own sheet states one.** Not where it is publicly known, not where
you remember it. MSME-1 is genuinely due 31 October and 30 April and the pack does not say so.
`tests/obligation/rulepack.test.ts` PINS the generating count at ten and names all ten, so
"helpfully" dating an undated obligation is a red build rather than a wrong date reaching a
client. A fake VALUE is survivable; a fake RULE is not.

**The date arithmetic is pure and has no `Date` in it.** `domain/obligation/model.ts` works in
`YYYY-MM-DD` strings: every date it produces is a statutory deadline somebody is held to, so it
has to be exhaustively testable, and a function that reaches for `new Date()` cannot be. The
fiscal year is on the RULE (4 for India), because an Indian quarter runs Apr–Jun and computing
quarters on the calendar is the mistake that looks right three times out of four.

**The exception is a ROW against the rule, keyed on the month the PERIOD ends in** — not the month
it is due, because the due month is exactly what the exception changes. March's TDS is due 30
April while the other eleven months are the 7th; a template holds one formula, and reading only
the normal half gives a rule that is right eleven months a year and quietly wrong every April.
That is the worst failure available: nobody re-reads a date that looks right, and the cost lands
on the client as a penalty. Withdrawing an exception is `is_active = false`, never a DELETE —
`bib_app` holds no DELETE grant on any of the four tables.

**Two dates, and the difference is the point.** `statutory_due_on` is the law's and missing it is
the client's money; `internal_target_on` is T–X, the firm's own, and it is the actionable one —
finding out you are late on the day you are late is useless. Every screen orders by the internal
target. **ANY DATE-CHANGING EDIT RE-DATES WHAT IS ALREADY GENERATED** (`listUnstarted` +
`restate`, T6.4), because the sweep materialises a year ahead and generation is idempotent on
`(tenant, template, entity, period_start)`: without it a partner changes a rule and watches
nothing happen for twelve months. It moves only rows nobody has started — a task on a desk keeps
the date its owner is working to — and the caller REPORTS how many it therefore could not touch,
because a partial change presented as a whole one is how a deadline moves without anybody being
told.

It re-derives with **`scheduleFor`, the generator's own function**, never arithmetic in an UPDATE:
a second implementation of the due-date rules parts company from the first the moment an exception
is involved, which is exactly the case a partner is most likely to be editing.

**And it restates the STATUTORY date, which is the reverse of what the lead-time-only version
did.** A lead time is the firm's own practice and the law's date is not in question there. When
the FORMULA changes it is the other way round: the old statutory date was this system's guess from
a vendor's document, and the new one is the firm's answer. Leaving a date now known to be wrong,
on the grounds that the law's date is not ours to change, keeps a wrong legal deadline out of
respect for the law.

**States are ROWS and NOTHING compares a `code`** — 0050's argument, and the demo got this half
wrong in a way worth naming: its sweep looked states up by the literal strings `'pending'` and
`'in_progress'`, which hardcodes the very names the firm was promised it could change. Meaning
lives in `is_initial` / `is_terminal` / `needs_decision`; "can this still be missed" is derived
from the last two rather than stored as a third.

### Closing a filing — and why "terminal" is the wrong rule on BOTH sides (0054)

T3.2 shipped with `filed_on` READ in four places and WRITTEN in none, so every row said "Pending"
forever and `obligation.filed` was a registered verb with no writer. The obvious close — *the work
item reached a terminal state, so the obligation is filed* — is **ambiguous in both halves**, and
each resolves the wrong way if left alone:

- **0050 seeds TWO terminal work item states, `completed` AND `cancelled`.** Tasks are cancelled
  for ordinary reasons: the client left, the entity was deregistered, it was raised twice. Reading
  `is_terminal` alone records that a statutory return was FILED because somebody tidied their
  board — not a missing feature but a FALSE STATEMENT about a filing, and worse than the "Pending
  forever" it replaces.
- **0052 seeds TWO terminal obligation states, `filed` AND `resolved`.** `resolved` is T3.3's —
  the end of a deadline already missed, which a partner chose. A filing nobody had to decide
  anything about does not belong in the decision queue.

So each side carries ONE flag: **`work_item_state.is_success`** ("the work was DONE, not
abandoned") and **`obligation_state.is_filed`** ("a finished filing lands here"). Flags rather than
codes, for this module's own reason — a firm renaming Filed to "Submitted" must not switch the
mechanism off. `filedState()` mirrors `initialState()`, a partial unique index caps `is_filed` at
one per firm, and a CHECK refuses either flag on a state that is not terminal. **Both default to
FALSE**, so a firm's own new terminal state leaves an obligation OPEN and visible rather than
recording a filing that never happened — the safe direction, chosen.

**`ObligationFiling.reconcileFiling` is the only writer, and it RECONCILES rather than transitions.**
It takes the current answer to "is this discharged" — terminal AND successful — and makes the
obligation agree, and `moveToState` calls it on every move. Idempotent by construction (the guard
is the repository's `WHERE filed_on IS NULL`, so a double-click writes one event), reopening is the
same call with a different answer rather than a second path, and there is no order to get wrong.
**A reopened or cancelled task UN-FILES**, because `moveToState` already clears `completedAt` on the
way back, and because filed is terminal — `canStillBeMissed` would be false forever and T3.3 could
never flag it. Un-filing lets the missed sweep self-correct, and the withdrawal is its own verb
(`obligation.filing_reversed`), never a quiet UPDATE.

**The two use cases now name each other, and the cycle is broken in `setup/`.** The calendar raises
a task (`WorkItemRaiser`); finishing that task files the obligation (`ObligationFiling`). Neither
file imports the other — each declares the one method it needs and the composition root satisfies
both with a closure, in the API and the worker alike. **Both processes must have it**, or a filing
would close when a person ticked a task and not when the worker did.

**`work_item.completed` fires only for a SUCCESSFUL terminal state.** It fired for any terminal one
until 0054, so cancellations counted as work the firm finished — and the verb's own description is
*"what did we finish last month"*. `work_item.state_changed` carries `isSuccess`, so "what did we
abandon" stays answerable without a verb of its own.

**`filed_on` is the UTC day, DECIDED rather than defaulted (Shrestha, 2026-08-30).** East of
Greenwich a filing made after midnight local records the previous day, which is exactly the
on-time/late boundary. It is survivable only because `work_item.completed_at` keeps the instant, so
`filed_on` is a projection and the truth is not lost. The general fix is still open and still shared
with `invoice`, `dunning` and `lead`.

**A boolean query parameter is NEVER `z.coerce.boolean()`.** Coercion is `Boolean(value)`, a query
string carries TEXT, and `Boolean("false")` is `true` — so `?includeSettled=false` meant "include
them" and `/calendar`'s checkbox was inert whatever the screen said. Every layer behaved: it parsed,
answered 200, and ran the wrong branch, which is indistinguishable from the right one until a row is
actually terminal. Use `z.enum(["true","false"]).transform((v) => v === "true")`, which also puts
the accepted values in the spec. `tests/api/query-booleans.test.ts` holds the build red on the whole
class; JSON bodies are unaffected and `z.coerce.number()` is fine.

**The obligation states have a screen since T3.3** — `/admin/obligation-vocabulary`, the
counterpart of `/admin/work-vocabulary`. Until it existed, every *"mark another state as the X
one"* message in this module described a control nobody could reach, and `NoFiledState`'s own
comment said so; both are corrected. A refusal here may now name the screen, because there is one.

**Generation scope is DECIDED: only where an engagement exists.** `engagement_id` stays nullable
so the compliance-engine reading (generate for every entity; every uncovered obligation is a sales
lead) is a config change rather than a migration. The firm has not been asked which it wants, and
this schema does not answer it for them. **The floor matters as much as the scope:** generation
reaches ninety days back so a client who signed last month gets the period already under way, and
`CalendarSubject.effectiveFrom` stops that same reach-back inventing missed deadlines — onboard
four hundred clients without it and a partner's decision queue fills with thousands of deadlines
nobody ever had.

**THRESHOLDS ARE STILL NOT BUILT, AND THAT IS NOW A DECISION.** The firm's commonest applicability
rule is a threshold, and `StepOperator` still has no `gte`/`lte` for the same reason it never did:
nothing in this schema stores a turnover, an employee count or a paid-up capital. Under the decided
scope it does not need to — *"does Tax Audit apply?"* is answered by the client having BOUGHT it.
The threshold layer belongs with the compliance-engine reading, and every seeded rule carries the
sheet's own threshold text in `applicabilityNote` so the specification is ready the day that
question is answered.

### A missed deadline is a state, and the decision about it is a record (T3.3, 0055/0056)

`obligation.missed` was a REGISTERED VERB WITH NO WRITER from T3.2 until now — the same trap 0054
closed for `obligation.filed`, left open a second time. The sweep writes it, and nothing about that
path throws, retries or hides: a passed statutory date moves a row to a state and asks a person.

**THE SWEEP NEEDS A DESTINATION, AND `needs_decision` IS NOT ONE.** "Move it to the state with
`needs_decision`" works only while a firm has exactly one, and nothing says it must — `missed` and
later `disputed` are both waiting on a person and only one is where a passed date belongs. So the
vocabulary is now two kinds of flag, and the split is the thing to keep:

- **destinations** — `is_initial` · `is_filed` · `is_missed` · `is_resolution`. *A filing moves HERE
  when X happens.* At most one holder each (partial unique index), never none (the service refuses,
  naming what would stop working), and a state may hold at most one of the four (a CHECK).
- **behaviours** — `is_terminal` · `needs_decision`. *Once a filing is here, this is true of it.*
  Any number of states may carry them.

`is_resolution` exists for 0054's own reason reached from the other side: a firm has two terminal
states, and "terminal and not filed" is a definition by subtraction that breaks the day it adds a
third. A CHECK also refuses `is_missed` on a state that does not need a decision — without it a
firm could point the sweep at an ordinary working state and every overdue filing would move there
in silence.

**THE OPTIONS ARE ROWS AND SEED `unconfirmed`.** `delivery.obligation_resolution_option` holds the
firm's answers — provisional filing · late fee · nil return · not applicable, and deliberately no
"ignore", because a passed deadline is a fork with consequences either way and a dismissable one
would hide what the queue exists to surface. Rows rather than a CHECK for two reasons: a firm edits
its own list on a screen, and *"how many late fees did we accept this quarter"* is a `GROUP BY` that
free text cannot answer. `unconfirmed` because the demo's `docs/OPEN-QUESTIONS.md` carries them as
**Q57, still OPEN** — described in a conversation is not confirmed against a list.

**`closes_without_filing` IS THE FORK, AND IT IS A COLUMN.** False means the filing still has to
happen: back to the INITIAL state, `raise` puts it on a desk again, and 0054 files it late with
`daysLate` on the event. True means it never will: into the resolution state, and over. A firm
adding *"client deregistered mid-year"* says which it means without a deploy.

**`resolved_at` IS ALSO THE LOOP GUARD.** An obligation sent back to work has a statutory date in
the past forever, so without it the next sweep re-flags the row and the partner is asked the same
question every morning until the filing is made. That is why it is a column and not only a ledger
event — the sweep's WHERE clause cannot read the ledger.

**THE REASON IS MANDATORY AND IS NOT IN THE LOG.** Refused by the service and by
`obligation_instance_resolution_chk` (all three columns or none; a blank reason is not a reason),
because a partner in a hurry meets the form and an import does not. `obligation.resolved` carries
the OPTION and never the reason: it is free text about a client and may name a person, which §3.4
keeps out of a log that cannot be erased. So the reason exists in the erasable row and nowhere else.

**THE GO-LIVE FLOOR IS A KNOB, NOT AN ANSWER.** `compliance_policy` (the registry's ninth kind, key
`default`) holds `missedFromOn`. Generation reaches ninety days back, so a firm onboarding with
older engagements gets months of obligations whose dates have all passed and were filed in Excel —
its first decision queue would be hundreds of answered questions. This is the demo's **Q56, also
still OPEN**, and its own note calls the ninety days *"a working value, not a decision"*, so the
firm sets the date and the registry versions it. **UNSET means NO FLOOR**, which is the behaviour
the system already had — and the OPPOSITE default from the discount policy, deliberately: there,
silence means zero because a fail-open reading cannot be audited; here the failure to avoid is a
hidden missed deadline, so the safe direction is to show more.

**`obligation:resolve` IS THE EIGHTH PERMISSION (0056), partner-only by default.** Not
`tenant:admin`, though that is partner-only today: a firm wanting a senior manager to decide filings
without also handing them the roster and the roles could not express that, and roles are config rows
precisely so it can. Not `work:write` either — that is the ordinary act of ticking off the step you
performed, and this commits the CLIENT'S money and is the one delivery decision a client may later
dispute. 0012 and 0045 are the precedent, cost included.

**`ObligationError` HAD NO ENTRY IN `api/domainerr.ts`, AND HAD NOT SINCE T3.2.** Every refusal the
compliance calendar made answered **500 "internal error"** — precisely the failure this file already
records `StaffGradeError` having, made a second time, and invisible for the same reason: unit tests
assert on the thrown sentinel. It surfaced only because T3.3's refusals are read by a partner on a
screen. If you add an error family, the mapping is part of the same commit.

### Editing a rule, and the two things that are not the same edit (T6.4)

The rules screen could write three fields; the API had taken a full `dueRule`, a new rule and
exceptions since T3.2 **with no caller anywhere**. So forty-seven of the fifty-seven shipped rules
were never going to start generating however well the firm knew the answer, and "config a partner
can edit without a deploy" was true of a quarter of the row. That is the gap T6.4 closed, and
three decisions in it are worth keeping.

**A CORRECTION AND AN AMENDMENT ARE DIFFERENT OPERATIONS, and `status` already says which is
which.** Effective-dated regulatory data separates "we recorded the fact wrong" — fix it, and
everything derived from it — from "the law changed from a date" — a new record, the old one still
explaining what it explained. Everything here ships `unconfirmed` precisely because nobody has
checked it against the statute, so an edit there is a CORRECTION and restates in place. A
period-specific legal change is an EXCEPTION, which is what a CBDT or GST extension actually is
and which 0052 already built. **Effective-dated supersession is NOT built**, and the blocker is
concrete rather than a preference: the generation window is `today−90 … today+365` for every
generating rule, so a superseding row would immediately re-generate periods the retired one
already produced — different `template_id`, so the re-run key does not catch it, and the calendar
would show each filing twice. It needs an `effective_from` on the template.

**AN EXCEPTION IS A DATE CHANGE TOO, and adding one moves rows that already exist.** March's TDS
is generated eleven months before anybody writes the carve-out saying March is due on 30 April.
Before T6.4 the exception was right on paper and absent from every row it was written for — the
same silence 0054 and T3.3 each closed once. Withdrawing one restates the same way.

**THE PERIOD SHAPE IS PART OF THE IDENTITY ONCE ROWS EXIST** (`PERIOD_SHAPE_LOCKED`, 409, and not
400 — the request is well formed and what refuses it is the filings the rule has produced).
`recurrence` and `fiscal_year_start_month` decide where a period BEGINS and `period_start` is the
re-run key, so moving either under existing rows orphans all of them, the next sweep generates a
second copy of work already done, and nothing reports an error. They are editable exactly while
the rule has produced nothing — the state of all forty-seven a partner has to answer.

**ANSWERING A RULE FILLS THE CALENDAR NOW; WRITING ONE DOES NOT.** `updateRule` generates for that
template alone when the rule CROSSES into producing dates, because the partner has just been asked
a question and is owed the result of their answer. `createRule` deliberately does not: somebody
writing a rule types the formula first and the March carve-out second, so generating on the first
save fills a year of calendar from a half-written rule. A brand-new rule is what the nightly sweep
is for. Neither path raises tasks or flags anything missed — those are the sweep's, and having
them fall out of a config edit would let a partner correcting a typo put work on somebody's desk.

**Every rule write returns a `RuleEffect`** — `restated` / `locked` / `spawned` — and both
exception verbs carry the first two on the event, which they did not until reading the ledger
after using the screen showed `obligation_rule.updated` carrying it and them not. Never the note:
prose does not `GROUP BY` and this log cannot be erased.

**A RULE HAS A WINDOW, AND IT IS TESTED AGAINST THE PERIOD START (0057).**
`effective_from` / `effective_to`, half-open, both nullable and both null on every row that
existed before it — so applying it moved no calendar. It is what makes an AMENDMENT expressible
at all: the correction path edits in place, and this one closes a rule at a day and opens its
successor on the same day.

**The period start, never the due date.** The rule that governs a filing is the one in force for
the PERIOD BEING FILED — August's return is August's law even though it falls due on 20
September. `governsPeriod` in the domain names it once, so the generator and the screen cannot
disagree; testing the due date instead would shift every date by exactly one period and look
entirely plausible.

**Half-open, `[from, to)`,** like `client_assignment` and `party_identifier`. The demo used an
inclusive bound on assignments and showed two SPOCs on every changeover day; the same mistake
here is two rules governing one period, which is two filings for one return under template ids
the re-run key cannot deduplicate.

**`supersede` is ONE method and one transaction**, because each half alone is a silently broken
calendar in opposite directions: a closed predecessor with no successor stops the firm's clients
being told about a filing they still owe, and an un-closed predecessor puts every later return on
the calendar twice. `supersede.integration.test.ts` proves the ROLLBACK specifically — a
colliding successor leaves the predecessor open — which is the property a fake cannot establish.

**The predecessor is CLOSED, not retired**, and the difference is not cosmetic. Retiring stops it
generating at all, including for periods before the cutover that the ninety-day reach-back has
not materialised yet, so a client onboarded last month would silently lose the period it was
engaged for. A window says WHICH PERIODS a row governs; `is_active` says whether it is switched
on. Different questions.

**`restate`'s SQL is executed by an integration test, not a fake.** It uses the same
`jsonb_to_recordset(…::text::jsonb)` construction as the batch insert, whose double cast exists
because postgres.js re-encodes a string parameter as JSON and every sweep died on it — found by
RUNNING the worker, since the unit tests use a fake and the old integration test inserted rows by
hand. `tests/obligation/restate.integration.test.ts` also proves the WHERE clause refuses a row
somebody picked up between the read and the write, which is what makes the reported count honest.

### A rule generates only once the FIRM has confirmed it (2026-09-18)

`status` was `unconfirmed | confirmed` from T3.2 and INFORMATIONAL: the sweep generated from
every active formula regardless. Loading the first real firm found what that costs. Its one
service was bookkeeping, which EXCLUDES GST filing in the partner's own words; the fifty-seven
shipped rules name no service, so the eleven with a formula reached every live engagement at
every Indian company — 98 filings, 17 tasks on an associate's desk, and the client's own portal
listing returns the firm never took on as MISSED. A calendar row is a claim about a client, and
a pack cannot make one.

So `coverageOf` has a fifth answer, `unconfirmed`, and only `generating` generates — in the
domain predicate, in `listGenerating`, in `gaps` (reason `rules_unconfirmed`) and in
`obligation-coverage.ts`, which `coverage.integration.test.ts` runs against one database. **A
rule the firm WRITES is created `confirmed`** (it is the firm's own statement of the law, and a
brand-new rule is still what the nightly sweep is for); **a rule a pack SEEDS is not**, and
confirming it is the crossing that fills the calendar there and then, exactly as answering a
formula does. Scoping it to a service at the same time is what keeps a filing off the clients
who did not buy it.

**And the compliance floor now clips GENERATION, not only the missed decision.** A filing whose
statutory date falls before `compliance_policy.missedFromOn` is not generated at all — the same
rule the per-period spawn applies to months (T6.13). Before this the ninety-day reach-back put
June's and July's returns on the calendar of a firm that went live in September, and raised
their tasks.

### The silent hole, and why the cure is a derivation rather than a setting

A recurring engagement now gets one task PER PERIOD from the calendar, so `spawnForEngagements`
must not also raise its own — that row is due `effective_from + slaDays`, can never be completed
while the engagement runs a year, and is indistinguishable from a real task. Four hundred clients
times three recurring services is twelve hundred of them.

The obvious mechanism is a flag on the service. **A flag can be WRONG, and being wrong means
SILENCE**: no engagement task and no calendar rows either. So the discriminator is DERIVED —
`ObligationCoverage` asks the GENERATOR'S OWN PREDICATE (an active rule, with a formula, not
event-driven, naming this engagement's service and the entity's country). **The failure then
inverts: a firm with no rules is not covered, so it gets exactly the behaviour it had before this
existed, and the board can never end up empty.**

`GET /api/v1/calendar/coverage` is the other half: every live engagement the calendar produced
nothing for, WITH A REASON, and **none of the five reasons is an error** — the commonest,
`no_rule_names_this_service`, is the ordinary state of advisory work. The worker logs the count
every sweep and `worker:once` prints it whether or not anything generated. An empty calendar with
nothing said about it is indistinguishable from broken software, and that is the failure this
whole mechanism exists to prevent.

### What running it found, and what none of the tests did

- **The batch insert never executed.** postgres.js infers a JSON type for a string parameter and
  encodes it AGAIN, so `${json}::jsonb` produced a jsonb STRING and every sweep died with *"cannot
  call jsonb_to_recordset on a non-array"*. `::text::jsonb` is the fix. Unit tests use a fake
  repository and the integration test inserted rows by hand, so **neither ever ran the statement**.
  If you add a repository method with non-trivial SQL, run it.
- **The coverage reason was wrong on its commonest case** — it required a rule to name the
  engagement's service, and every rule in the shipped pack names none (a pack cannot know a firm's
  catalogue keys). Fixed to the generator's predicate, and `entity_not_registered` added, which was
  the real answer.
- **Two id-only foreign keys**, caught by `tenant-keys.integration.test.ts` and not by review.
  `service_entry_id` and `supersedes_id` both carry the tenant now.

`/calendar` and `/admin/obligation-rules` are the screens, and the whole chain was walked in the
browser — load the pack, register a company, sweep, set a lead time, sweep, and find the GSTR-3B
task on the board at High priority, from the law, with nobody setting it.

## The escalation ladder — the sweep that tells somebody, and the one thing it may not do (T4.5)

`delivery.escalation_notice` (migration 0058) plus `escalation`, the configuration registry's
TENTH kind. It watches three dates the product already holds and raises a notice; it changes
nothing else, ever.

**0052 SAID THIS OUT LOUD AND NOTHING EVER FIRED.** Its own comment reads *"the escalation
ladder fires on the internal target rather than the statutory"*, and until T4.5 nothing did.
On the morning it was built the live database held **7 work items overdue, 5 of them on nobody's
desk**, and **2 filings past `internal_target_on` with the statutory date still ahead** — all
rows this product already had and never looked at. If you find another comment describing a
mechanism, check whether the mechanism exists: this is the third one.

**IT IS NOT AN AGENT, and the deviation is recorded rather than assumed.** A9 sits in Phase 4
with the agent capabilities and deliberately does not run through T2.8's runtime.
`AgentRuntime.run` is `{ tenantId, jobId, stepKey }` — step-scoped — and this has neither a job
nor a step, because *"no human trigger"* is its own line on the board. It produces no proposal,
so there is no confidence for a tier to govern and nothing for a person to accept or correct.
Forcing it through would have meant inventing a fake job and a confidence of **1.0 for
arithmetic over two dates**, and that number would then sit in the accuracy record making the
first real agents look better than they are. The shape it matches is `usecase/dunning`.

**IT NEVER ACTS, and that is structural rather than a rule to remember.** `EscalationService`
holds five read ports and one write; there is no seam on it through which a task could be
reassigned, a filing moved or a client contacted. `alerts + spawns tasks only, never acts
itself` is enforced by what does not exist.

**THREE WATCHES, AND NO NEW DATE IS INVENTED.** `work_item_due` reads the SLA T3.1 snapshotted
at creation; `work_item_unassigned` counts from `created_at`, because an item the router refused
to guess an owner for has no other clock; `obligation_target` reads T3.2's `internal_target_on`.
An escalation counted from a deadline this software made up would be one nobody could argue
with or check, and there must not be a fourth watch that needs one.

**NOTHING IS SEEDED.** A firm with no published ladder escalates nobody — the same safe
direction `dunning` and `confidence_tier` take, and here the failure mode is sharper than noise:
a threshold this product invented teaches everybody to ignore the one queue whose whole value is
being believed. `GET /api/v1/escalations` therefore returns **`ladderPublished`**, because an
empty queue at a firm that never wrote a ladder and an empty queue at a firm where everything is
on time are the same picture, and only one of them means the product is working.

**Ascending is per WATCH, not across the array** — the one place this validator differs from
dunning's. The three watches are three independent ladders sharing an entry, and a global order
would force a firm to write a ladder it does not mean.

**WHO IT REACHES: `assignee` · `manager` · `grade_at_least`, and all three can reach NOBODY.**
The manager hop resolves TODAY through `membership.reports_to_user_id`; **G3.4 is not a blocker
for it**, because that task links a login to a PARTY, which answers a different question.
`grade_at_least` is deliberately NOT resolved to a person — an escalation routed to one partner
is one that dies while that partner is on leave — so `min_grade_rank` is stored and the reader's
own rank is what matches. When nobody can be named the notice still fires, carrying a sentence
saying which of the three reasons: T3.1's `assignment_note` decision, and the first real sweep
raised 14 rungs of which **7 reached nobody** — the rows a partner actually has to act on.

**THE TABLE EXISTS BECAUSE THE SWEEP'S `WHERE` CLAUSE CANNOT READ THE LEDGER.** T3.3's
`resolved_at` lesson, and it is worth repeating because it is not obvious: without a row, the
same rung fires every morning for as long as the work stays open. Idempotence is the two partial
unique indexes and `ON CONFLICT DO NOTHING`, and the event is written only when a row was
actually created — `dunning`'s arrangement exactly.

**AND THERE IS NO `cleared_at`.** An escalation about a task is live exactly while that task is
not terminal, and one about unassigned work exactly while nobody holds it, so the queue reads a
JOIN. A column restating a fact two tables away is one that can disagree with it. Proven by
running it: cancelling a task dropped its three notices and reopening it brought them back, with
nothing re-raised.

**THE BOUNDARY WITH T3.3 IS WHY THESE ARE TWO SWEEPS.** `obligation_target` fires between the
firm's own T–X and the statutory date and **stops the moment the statutory date passes** — from
there the filing is in the partner's decision queue and two systems shouting about one filing is
how both get ignored. `obligation.escalated` is its own verb beside `obligation.missed` for the
same reason: one is the warning that exists so the other never happens.

**Reading the queue is `party:read` and there is no write route at all.** No acknowledge, no
dismiss, no snooze — a notice ends when the WORK ends, and a control that emptied the queue
without anything happening would make it decoration. The unfiltered queue is the default, T3.3's
decision for its stated reason; `?mine=true` is a convenience resolved from the caller's own
membership and never from the wire.

### What running it found — a read model with a name and no email

The first real sweep produced 14 notices, three of them addressed to a partner BY NAME, and the
queue rendered a **blank space** beside "told". `tenancy.user_account.display_name` is nullable
and is genuinely empty at seeded firms, so `raisedToName: string | null` collapsed *"told
somebody whose name we do not hold"* into *"told nobody"* — the exact shape `createdByName` had
in T3.6, and the audit trail's rule stated once more: **the email is the discriminator, not the
id.** Both people on the row are `{ userId, displayName, email }` now, the shape
`EventRecord.actor` has. That is the sixth time a read model has been caught, and the first
where the missing half was the email rather than the name.

## The client portal — the first read written for somebody outside the firm (T6.5)

`usecase/portalhome` + `GET /api/v1/portal/home` + migration 0062. Gate 4 shipped in 0059 and
its writer in 0060; until this there was still **nothing for a client to look at** —
`PORTAL_PATHS` held four routes and not one returned a business record, so an invited contact
signed in and landed on a blank page, which is indistinguishable from broken software.

**A PORTAL READ IS THREE THINGS AND MISSING ANY ONE IS A HOLE.** An entry in `PORTAL_PATHS`
(gate 2 is denied by default), an entry in `NO_PERMISSION_REQUIRED` or `ROUTE_PERMISSIONS`
(gate 3 is too), and the query through **`withPortal` — never `withTenant`** — with its own
RESTRICTIVE policy on every table it reads. `PostgresPortalHomeRepository` is the only adapter
in the product that uses `withPortal`, and it should stay countable on one hand.

**GATE 2 MATCHES `{param}` TEMPLATES SINCE T6.6, AND THAT WAS ITS OWN COMMIT.** It was
`PORTAL_PATHS.has(c.req.path)` — an exact match on the concrete path — until the action centre,
so a portal route carrying a path parameter was unreachable whatever was written in that set,
and the status home is one parameter-less aggregate read because of it. `compilePortalPaths`
compiles the list the way `decideRoute` compiles `ROUTE_PERMISSIONS`.

**What contains that widening is a test, not care.** A matcher is strictly more permissive than
a set, and what it guards is the gate that stops a client contact reading the firm's whole book.
So `auth-coverage.test.ts` asserts, over EVERY route the router has registered, that
`isPortalPath(concrete(path))` equals plain membership of that route's TEMPLATE in the list — a
pattern that swallowed a staff route turns it red and names the route. `asTemplate()` is the
other half and was not optional: Hono registers a parameter as `:name` while both permission
tables are keyed by `{name}`, so `PORTAL_PATHS.has("/x/:id")` is always false and a templated
portal route would have looked undeclared to every sweep in that file.

**THE QUERIES LOOK LIKE QUERIES THAT FORGOT TO FILTER, ON PURPOSE.** Neither statement names
`client_party_id`, `entity_party_id` or `is_client_visible` in a WHERE clause: the wall is under
the query, not in it. Repeating the filter would feel safer and would silently disarm the
negative control — `tests/portal/portal-reads.integration.test.ts` drops a policy and expects
these reads to start leaking, and each of its assertions was watched go red and back.

**A GRANT NAMES A PARTY; EACH TABLE NAMES ITS OWN.** `delivery.work_item` carries
`client_party_id` and `delivery.obligation_instance` carries `entity_party_id` ("the ENTITY,
never the client" — 0053), so the two policies scope on different columns and a contact granted
Cobalt Foods sees Cobalt Foods' filings and NOT its subsidiary's, while still seeing the
subsidiary's TASK (that row names Foods as its client). Reaching the subsidiary's filings would
mean joining `crm.engagement` — a **nullable** join, and the derivation 0059 refused. A contact
who should see both gets two grants. Shrestha, 2026-09-01: strict, no join.

**`is_client_visible` HAD A WRITER AND NO READER FROM 0051 UNTIL NOW** — the fourth registered
thing this codebase has found with no reader. It is enforced as a SECOND restrictive policy
(0062) rather than a filter in the query, for gate 4's own reason: a portal read that forgets it
returns an internal note with a 200. `/work-items/[workItemId]` grew the switch that sets it in
the same commit — a flag the portal enforces and no screen can change is a wall built against a
value nobody can move.

**NAME TABLES ARE NOT SCOPED BY WHAT THEY NAME.** The read joins `core.party`,
`work_item_state`, `obligation_state` and `obligation_template` for NAMES and none of them gets a
policy. `crm.portal_sees(id)` on `core.party` would blank the ENTITY on a row the reader is
already allowed to see — T4.5's blank-space bug, on purpose. What contains them is gate 2, which
0059 already accepted as a real defence; **a portal route whose SUBJECT is one of those tables
needs its own line in a migration first.**

**NO DUE DATE THIS PRODUCT INVENTED REACHES A CLIENT.** `statutoryDueOn` travels only where
`is_statutory_due` is set; everything else answers with the day the work OPENED. The firm has
never given its turnaround times (client ask 3.4), and this reader could quote the date back at
it. `internal_target_on` is not on the response at all — T–X is the firm's own working margin and
showing it turns it into the deadline.

**"HELD UP" IS NOT "WAITING ON YOU", AND THE NAME WAS HONEST ON PURPOSE.** Nothing in T6.5's
schema recorded who a task waits on: `work_item_state.is_blocked` means the firm cannot proceed
and `blocked_reason` reads *"the client has not sent the purchase register"* as readily as *"the
GST portal is down"*. The section shows the reason **verbatim**, under a line saying whose words
they are. T6.6 built the row that says it properly — see the section below — and this one stays,
because the two are different facts and a firm may be waiting on more than one thing at once.

**RECENTLY FILED IS KEYED ON `filed_on`, NEVER ON THE STATE BEING TERMINAL.** 0052 seeds two
terminal states and `resolved` is T3.3's end of a deadline already MISSED. Calling that "filed"
is a false statement about a statutory return — 0054's failure, reached from the reading side.

**THE STATUS HOME NEEDS NO PERMISSION, AND PER-CONTACT ROLES WAIT FOR T6.6.** Being invited and
granted a company IS the authorisation to read that company's status: `crm.portal_access` is a
row somebody wrote, with a granter, a date and a ledger event, and gate 4 enforces it. A
permission on top is a second answer to a settled question and every portal login would hold it.
What a contact may DO — upload, answer, approve — is what genuinely needs a role that declares
its AUDIENCE (a migration; `AuthzService.permissionsOf` and
`tests/api/portal-permissions.test.ts` hold the build red the day a portal route wants one). It
lands with T6.6, where those verbs exist, because a permission nothing checks is a lie on a
screen.

**A STAFF SESSION IS REFUSED RATHER THAN ANSWERED EMPTY.** Gate 2 admits a portal session to
`PORTAL_PATHS` and says nothing about a staff one reaching it; a colleague would hold no grants
and get an empty page reading as "this client has nothing going on". A wrong answer that looks
right is worse than a refusal.

### What running it found, and what none of the tests did

- **`date + $n` IS AMBIGUOUS TO POSTGRES.** postgres.js sends every parameter untyped, so
  `${asOf}::date + ${90}` died with *"operator is not unique: date + unknown"*. It typechecked,
  it linted, the unit tests use a fake repository — and it surfaced as a **500 on the first real
  request**. `::int` on the window is the fix, and it is T3.2's `::text::jsonb` lesson again: **if
  you add SQL, run it.**
- **THE PAGE SAID EVERYTHING TWICE.** The calendar raises a task per obligation, so the first
  response carried "GSTR-3B — Cobalt Foods — Jul 2026" as a filing AND as a task. To the firm
  those are two things; to a client they are one thing listed twice. The work query now excludes
  a task whose obligation is on the same page — and the asymmetry falls out of RLS rather than
  being coded: an obligation for a company that was NOT granted is invisible to the subquery, so
  `NOT EXISTS` is true and its task stays, which is right, because that task is then the only
  trace of the work the client can see.
- **"FILINGS COMING UP" WAS A HEADING THAT LIED.** The top five rows were past their statutory
  date and marked Missed. Only opening the page shows that; a heading wrong about the rows
  beneath it would have had a client scrolling past the lines that matter.
- **THE DEMO PUT AN INTERNAL DECISION ON THE CLIENT'S PAGE.** *"Decide the credit hold on
  INV/2026-27/0003"* — because `is_client_visible` defaults TRUE and nothing had ever set it
  false. The flag was working; the seed had never used it.

## The client-directed ask — the first thing a client can DO (T6.6)

`delivery.client_ask` + `client_ask_response` (migration 0063), `usecase/clientask`, and two
adapters. T6.5's "Held up" section was honest and blunt: `blocked_reason` is a note the firm
wrote to ITSELF, and a portal that put an answer box under it would be inviting a client to fix
the GST portal. An ask is raised deliberately, addressed to one client, and carries somewhere to
answer it.

**IT LIVES IN `delivery` AND HANGS OFF A WORK ITEM, AND THE SECOND HALF IS WHAT MAKES THE WALL
SOLID.** `crm` is the relationship; an ask exists because WORK cannot move. `work_item_id` is NOT
NULL, so its `client_party_id` — the column gate 4 filters on — is held to the work item's by a
COMPOSITE foreign key over `(work_item_id, client_party_id, tenant_id)`. **The denormalised wall
column cannot disagree**, rather than being trusted; and nothing on either surface accepts a
client party at all, because it is read from the work item inside the INSERT. A `(subject_kind,
subject_ref)` pair would have been more flexible and could carry no foreign key, which is exactly
the guarantee this needs.

**`answered` IS NOT `closed`.** The client responding turns an ask answered; the FIRM decides
whether what arrived was what it needed. A client who sent last quarter's register would otherwise
see the ask marked done, and the firm would have to raise a second one that reads as a fresh
request rather than "that was not it". `withdrawn` is kept apart from `closed` for the client's
sake — "you sent it" and "never mind" are different answers to "did I have to?".

**NO DUE DATE, ANYWHERE, AND ITS ABSENCE IS THE API's OWN STATEMENT.** The portal's rule
unchanged. `raised_at` is on the row and elapsed time is a fact, which is also all T4.4's chaser
needs. **Raising an ask does not block the task**, deliberately: coupling them would make that the
product's opinion rather than the firm's.

**RESPONSES ARE APPEND-ONLY BY GRANT**, the arrangement `files.document_version` and the `ledger`
schema have. A client's answer is evidence, and "the wrong file, then the right one" is a history.
`first_answered_at` is written `coalesce(first_answered_at, now())` so a later response never
restates when they first replied — that number is what a firm reaches for when a filing goes late.

**A CLIENT'S APPROVAL IS NOT `work_item_approval`.** That table and `step_approval` are the firm's
maker-checker (T2.9) — a second qualified person has CHECKED the work, gated on `work:write`,
refused when checker = maker. A client approving is an INSTRUCTION. Recording it there would make
a client's "yes" count as a checker's sign-off.

### The write side of gate 4, exercised for the first time

`PostgresPortalAskRepository` is the SECOND adapter in this product to use `withPortal` and the
FIRST to write through it. 0059 and 0062 both put `WITH CHECK` on their restrictive policies while
saying no portal write path existed — *"which is why it will not have to be built with the rule
inside it"* — and the promise held: **not one statement in that file names `client_party_id`.**
`party_id` on an uploaded document and `client_party_id` on a response are both taken from the ask
inside the INSERT, and the ask itself is read under the portal scope, so an unreachable ask writes
nothing at all.

0063 adds five policies: `delivery.client_ask`, `delivery.client_ask_response`, and the three
document-store tables 0037 wrote `party_id` for and left unguarded. **NULL there means the firm's
own and denies correctly by arithmetic** — `crm.portal_sees(NULL)` is `NULL = ANY(...)`, which is
not true — and that is written into the migration precisely because it does not look deliberate:
somebody "tidying" it to `OR party_id IS NULL` would hand every client the firm's stationery
cupboard. `document_version` and `document_link` are guarded by an EXISTS on the PARENT, which
inherits the parent's own RLS, so one edit decides both — and it is what finally makes T3.6's *"no
pre-signed URL, the key is unreachable"* claim true rather than aspirational.

`tests/portal/client-ask.integration.test.ts` proves all of it by negative control: 16 tests, and
dropping the five policies turns 3, 1, 5, 2 and 1 of them red.

### Per-contact roles, and the day `permissionsOf` stopped being arithmetic

`AuthzService.permissionsOf` returned `[]` for every CLIENT_PORTAL session, and CLAUDE.md was
careful to call that ARITHMETIC: gate 2 admitted a portal session only to `PORTAL_PATHS`, and none
of those needed a permission. `tests/api/portal-permissions.test.ts` was written to go red the day
the second line stopped being true. **`portal:respond` is that day**, and it did.

The fix is the one this file always named: **a role declares its AUDIENCE, and a role written for
the other one grants nothing** (`roleServes`). It runs BOTH ways, and the second direction is the
one nobody expects — nothing refuses `manager` on a portal membership, and nothing refuses
`portal:respond` on `associate` either, which would hand a colleague a permission that only means
something outside the firm. `can()` now applies the same rule as `permissionsOf`; the two used to
disagree deliberately, and that was safe only while gate 2 covered for gate 3.

`audience` on `RoleBody` is **optional and absent means STAFF**, and that is forced rather than
chosen: a published config version is FROZEN and `validateBody` rejects unknown keys, so every
role row every firm already holds cannot grow the field. `roleBodyOf` writes it only when the role
declares one, so a staff role's body stays byte-for-byte what it was — which is what the role
upgrade migrations (0012, 0045, 0056, 0060, 0064) compare against to tell a firm that has never
edited a role from one that has.

**`client_contact` may respond; `client_viewer` may only look — and both see everything.** Reading
is authorised by the grant (`crm.portal_access`), never by a permission, which is what makes a
read-only contact coherent rather than crippled.

### There is no virus scanner, no OCR and no auto-filing — and no PORT for one

The board asked for all three. There is no scanner in this product and no agent runtime
(`NoAgentsBuiltYet` is still what `setup/` wires), so each would be a contract written against
nothing — and T3.6 wrote a `DocumentRenderer` port and **deleted it before commit** under exactly
that rule. A `scan()` returning "clean" is a lie with a function signature; one that threw would
make uploads impossible.

So what is true is said instead: a client-supplied file is stored **unscanned**, the firm's screen
says so beside it, and the download route's `content-disposition: attachment` — never `inline` —
is the one protection that does exist, and has been there since T3.6 for this exact reason. When a
scanner arrives it arrives with a consumer.

### What running it found, and what none of the tests did

- **THE PAGE SAID THE REQUEST TWICE.** The action centre showed *"Please send the Maharashtra
  purchase register"* with a file picker under it; two sections lower "Held up" printed the
  identical sentence with nothing to do about it. T6.5's own duplication bug in a new costume.
  `PortalWorkRow.hasOpenAsk` now answers it, and the asymmetry falls out of RLS the way the
  filings dedupe already did: an ask the reader was not granted is invisible to the EXISTS, so
  the blocked reason is shown — which is right, because it is then the only thing on the page
  that says what is wanted.
- **THE FOOTER STARTED LYING.** *"sending files across is not here yet — email 10x Global as you
  do now"*, one paragraph below a working file picker. Nothing in a typecheck, a lint or a test
  can see a sentence go stale.
- **A READ-ONLY CONTACT WAS PROMISED SOMETHING.** *"if you sent the wrong thing, you can still
  send another"*, beside a card with no controls on it.
- **AND A TEST WAS LOOKING IN THE WRONG PLACE.** `tests/filestore/model.test.ts` was pinned to
  `0037_document_store.up.sql`, and 0063 widened `subject_kind` by dropping that CHECK and adding
  a new one — which an applied migration must do. The test went on reading seven members out of a
  constraint the database no longer had, and would have stayed green while the union and the live
  CHECK disagreed: **exactly the drift it exists to catch, hidden by where it was looking.** It
  reads the NEWEST carrier now, the way `seed-parity.test.ts` already did and said why.
  `linksOf` gained its `work_item` case in the same pass — 0063's comment claimed both halves of
  *"a kind nothing can resolve is a link nobody can follow"* were present, and only one was.

## The chaser — the same ladder aimed OUTWARD (T4.4)

`usecase/chaser` + migration 0065. T6.6 built the row that says WE ARE WAITING ON YOU and
nothing sent a second one; at a real firm that gap is the job, and it is the only task on the
board that reduces the firm's own chasing hours.

**IT IS T4.5's MECHANISM AND DELIBERATELY NOT T4.5's TABLE.** Rungs keyed by name, a threshold
in days, the threshold copied onto the row when it fires, at-least-once, nothing set by
default. But `escalation_notice` records that a COLLEAGUE was told, and this records that a
CLIENT was reminded: different reader, different target, different stop. Sharing the table
would put "and not the outward ones" in every escalation query forever.

**ITS OWN CONFIG KIND, for the same reason.** An `EscalationRung` carries `watch`, `notify` and
`minGradeRank`; a chase has one subject (an open `client_ask`) and one recipient (the client
that ask names). Reusing the kind would mean three fields every chaser rung sets to a value
nobody reads, and a validator that could no longer refuse a rung that made no sense.

**IT SENDS NOTHING, AND THAT IS THE BOARD'S HARD LIMIT MET STRUCTURALLY.** Transport is P10
(Phase 7), so a chase RAISES a reminder and the client's own action centre shows it. No mailer
is injected: an honest logging stub would put a line in an operator's log saying a client was
emailed, which is the same class of lie as a `scan()` returning clean. `ChaserService`'s
dependency list is asserted in a test, so a transport appearing in it goes red first.

**IT CHASES OPEN ASKS ONLY.** An answered ask is back with the firm, and reminding somebody
about something they have already sent is the most annoying thing a chaser can do — and what a
spreadsheet-driven human chaser gets wrong every week. It also skips an ask whose task the firm
marked invisible to the client.

**AT-LEAST-ONCE, AND EVIDENCE-GRADE.** `client_ask_chase_once` makes a redelivery unwritable,
the ledger event is emitted only for rows actually created, and the table is APPEND-ONLY BY
GRANT: *"we reminded you four times"* is what a firm says when a filing goes late, and a record
it can edit is not evidence. The actor is the SYSTEM, honestly — which is also why there is no
"chase now" route: a person pressing it would make that actor a lie on some rows and not
others.

### Escalation freeze — the acceptance line named a thing that did not exist

*"stops on escalation freeze"*, and this product had no freeze: not a table, not a column, not
a config kind. So half of T4.4 was building one, and its shape was a CLIENT FACT rather than a
guess (Shrestha, 2026-09-01):

- **On the CLIENT, effective-dated.** The board's own case is a dispute, and a dispute is with
  a client rather than with one task. A per-ask snooze would make a partner silence seven asks
  one at a time and go silent again the moment an eighth was raised.
- **It stops the OUTWARD ladder only.** T4.5 goes on telling the firm its own work is late,
  because a dispute is the worst possible moment to go blind to that.
- **A reason is required.** "Why is this client not being chased" is asked months later by
  somebody who did not set it, and a freeze with no reason cannot be told apart from one
  nobody remembered to lift. It is on the ROW and never in the ledger — a partner's words about
  a client, in a log that cannot be erased (§3.4, the split `obligation.resolved` makes).

Half-open `[valid_from, valid_to)`, like every other effective-dated row here. Lifting defaults
to TODAY — 0061's decision applied a second time, so pressing resume means the next sweep
chases rather than midnight. Setting a freeze in force on no day is still refused by the
service, while lifting one produces exactly that shape twenty seconds later: the database
allows the shape, the service allows only the act.

**No portal policy on `crm.client_freeze`, deliberately.** Gate 2 contains it — no portal route
reads that table — and whether a client may see they have been frozen is a question for a firm,
not a guess. A portal route whose subject is that table needs its own line in a migration
first.

### What building it found

**A CONSTRAINT THAT WAS WRONG, and only the integration test could say so.**
`crm.client_freeze` first carried `client_ask`'s both-or-neither pairing on `(valid_to,
lifted_by)` — which refuses a freeze that ENDS on a known day, *"frozen until the 30th, while
we are in mediation"*, the shape a partner is most likely to want. The true invariant runs one
way only: a LIFTER with no end date is impossible, because lifting IS setting the end date.
0065 was uncommitted and applied only locally, so it was corrected in place and proven by a
full down/up round trip rather than papered over with an 0066.

**AND THE T–3 HALF OF THE BOARD'S LINE IS NOT BUILT, on purpose.** A filing approaching its
statutory date asks the client for nothing until the firm raises an ask about it: *"your GSTR-3B
is due in 3 days"* is a NUDGE, not a request, and it belongs with T6.7's proactive nudges, which
have a different subject and a different cadence. There is no screen for the ladder either — it
is reachable through the generic config API, and an editor belongs with the first firm that
wants to change one.

## The self-serve library — and the flag that decides what is in it (T6.7)

`usecase/portallibrary` + migration 0066. The board's line is *"a client finds last year's
challan without emailing anyone"*, and reading it word by word decides the whole design: LAST
YEAR'S means no window, CHALLAN means the BYTES rather than a filename, and WITHOUT EMAILING
ANYONE means the empty state has to say which kind of empty it is.

**THE HOLE 0063 LEFT, AND IT ONLY BECAME ONE HERE.** `document_portal_scope` was
`crm.portal_sees(party_id)` and nothing else, which was CORRECT while the only route reaching a
document was a client reading back the filename of a file they had just sent. There was no route
that LISTED documents, so the policy was never asked a broad question. The moment one exists,
`party_id` alone hands the client every working paper the firm has ever filed against them — the
audit team's notes, the queries they raised internally, the draft they rejected. Not a leak across
the tenant wall; worse in the way that matters commercially, because every row of it is genuinely
about that client and a partner would still never send it.

**So `files.document.is_client_visible` is `delivery.work_item.is_client_visible` for the second
time**, and the lesson is taken rather than re-learnt. THREE mechanisms, deliberately not one:

- the **DATABASE DEFAULT IS FALSE**, so an import, an agent, or an INSERT that has never heard of
  the column publishes NOTHING. False is the direction a forgetful writer lands on.
- the **first sensible value comes from the KIND**, in `FileStoreService`. `clientVisibleByDefault`
  says a challan, an invoice, a credit note and a signed engagement letter are documents the client
  is a party to, and a working paper is the firm's own thinking. That is a judgement about a firm's
  business, which is why it is not the default and not the policy.
- and it is **enforced as a POLICY**, never as a `WHERE`. A portal read that forgets a filter
  returns an internal working paper with a 200.

**A SECOND POLICY, NOT AN EXTRA `AND` — AND WRITING IT THE OBVIOUS WAY BROKE THE FIRM'S OWN
WORKSPACE.** The first draft was `ALTER POLICY document_portal_scope … USING
(crm.portal_sees(party_id) AND is_client_visible)`. A RESTRICTIVE policy applies to EVERY session
and `portal_sees` returns true for a staff one, so the second condition had nothing making it
conditional: the firm lost sight of its own working papers, and the same edit on `crm.invoice` hid
every DRAFT invoice from the people writing them. The integration suite said so within a minute.
0062 had already solved this — `work_item_portal_visible` is `NOT crm.is_portal_session() OR
is_client_visible` — and 0066 copies that shape exactly. **A narrowing written without the guard
narrows the workspace.**

**AND THE FLAG HAS A SWITCH, IN THE SAME TASK AS THE POLICY.** `PATCH
/api/v1/documents/{documentId}/client-visibility`, its own ledger verb
(`document.client_visibility_set` — a disclosure decision, not a document edit), and a column on
the `<Documents>` panel. T6.5 named this exact failure on the work item's copy of the flag: *a flag
the portal enforces and no screen can change is a wall built against a value nobody can move.*

### The invoice, which 0062 said out loud was not here

*"Documents and invoices are NOT here either. They are T6.6/T6.7's reads."* `crm.invoice.party_id`
is who is BILLED — the column that table carries, and NOT the entity the work was delivered to
(0027's own distinction, and G0.1's). **A DRAFT MAY NOT REACH A CLIENT and that is in the policy**,
for `is_client_visible`'s reason: a draft is a demand nobody has made yet, and a client who saw one
would either pay it or argue about it. `cancelled` IS visible — a client holding a copy of a
withdrawn invoice must be able to see that it was withdrawn.

Lines, payments and credit notes carry no party column and get an EXISTS on the parent, which is
0063's `document_version` arrangement: one edit decides all four and a child cannot drift from its
invoice. `crm.invoice_balance`, `invoice_totals` and `invoice_line_amount` are all
`security_invoker = true`, so they follow with nothing written for them — which is what that flag
is for, and why 0066 wrote four table policies and no view policy.

`crm.dunning_action` gets NO policy, deliberately: whether a client may see their own dunning
history is a question for a firm rather than a guess, the same answer 0065 gave about
`crm.client_freeze`.

### Bytes on the client's side — T3.6's rule extended, not bent

`GET /api/v1/portal/documents/{documentId}/content` is the second route in this product that
returns bytes and the first on the client's side. **One route, no pre-signed URL**: the VERSION row
naming the storage key is read under `withPortal` and only then is the key handed to the blob
store, so the key is unreachable before it could be used, and `PortalBlobStore` has no method that
returns a URL. `content-disposition: attachment`, never `inline` — and here it is sharper than for
staff, because this store holds files supplied by CLIENTS and rendering one inline would make an
uploaded HTML file same-origin script in a portal another client is also signed into.

`PostgresPortalLibraryRepository` is the THIRD adapter using `withPortal`, so this file's *"it
should stay countable on one hand"* is now half spent. The next one needs an argument.

### The monthly digest is a SCREEN, and that is stated rather than discovered

The board asks for a digest. A digest is something that ARRIVES, and transport is P10 (Phase 7) —
so this ships as the thing behind the email rather than as the email, and `/portal/month` says so
on the page. `ChaserService`'s arrangement and its reason: an honest stub that logged "digest sent"
would put a line in an operator's log saying a client was emailed, which is the same class of lie
as a `scan()` returning clean.

It is NOT a second copy of the status home. The home answers *what is outstanding today* over a
rolling ninety days; this is bounded by a calendar MONTH and reaches back as far as a client cares
to look. A month is refused rather than coerced — `2026-13` read as January 2027 answers a question
nobody asked with data that looks entirely right.

## The proactive nudge — the same ladder pointed the other way (T6.7)

`usecase/nudge` + migration 0067. T4.4's board line was *"T–3 daily, D+3/7/15"* and only the D+
half was built, with the reason written down: **a filing approaching its statutory date asks the
client for NOTHING.**

**IT IS NOT THE CHASER WITH A MINUS SIGN.** A chase is about an open `client_ask` — the firm wants
something back, and the count of reminders is evidence when a filing goes late. A nudge is about an
`obligation_instance`, wants nothing back, and names a date the LAW set. So the chase counts
FORWARD from when the firm asked (`afterDays`, validated ASCENDING) and the nudge counts BACKWARD
from a statutory date (`beforeDays`, validated strictly DESCENDING — 7, then 3, then 1). Its own
config kind, because bending the chaser's would need a sign convention on a field called "after".

**THE WALL COLUMN IS `entity_party_id`, WHICH IS NOT THE CLIENT.** 0053's rule — *"the ENTITY,
never the client"* — so a contact granted Cobalt Foods is nudged about Cobalt Foods' filings and
NOT its subsidiary's, even though the subsidiary's TASK is on their page. Reaching them would mean
joining `crm.engagement`, the nullable derivation this schema has now refused three times. A
contact who should see both gets two grants.

**AND THE FREEZE DOES NOT STOP IT.** `crm.client_freeze` stops the CHASER only, and that is a
decision with two halves that happen to agree. The date is the LAW's, not the firm's: everything
else this portal refuses to show a client is a deadline somebody invented, and going quiet about a
statutory one because a fee is in dispute exposes the client to a penalty and the firm to a claim
for having known and said nothing. And structurally it could not reach anyway — a freeze is keyed
on `client_party_id` and an obligation carries `entity_party_id`. If a firm ever wants one, it is
its own effective-dated row on the ENTITY, with its own migration and its own argument.

**NOTHING BY DEFAULT, at-least-once, append-only by grant, and no transport** — the chaser's four
properties for the chaser's four reasons. `tests/nudge/service.test.ts` asserts the dependency list
STRUCTURALLY, and it asserts the ABSENCE of a freeze port as well as the absence of a mailer: a
port that took freezes and ignored them would be worse than none.

**It never offers a filing already discharged or already PAST its date.** `filed_on IS NULL` and
not a terminal-state test — 0052 seeds two terminal states and T3.3's `resolved` is the end of a
deadline already MISSED, so calling that "coming up" would be 0054's false statement reached from
the other side. And `days_until >= 0` is both a CHECK and the query's own predicate: *"due in −5
days"* is not a sentence, and a filing past its date is a missed deadline with its own screen.

## What the chaser's rows waited for, and what T6.7 decided about them

`delivery.client_ask_chase` (0065) had a WRITER, a portal policy and a ledger event, and **nothing
rendered any of it** — the sixth registered thing this codebase has found in that state, after
`membership.revoked`, `obligation.filed`, the escalation ladder's comment, `is_client_visible` and
`files.document.party_id`. 0065's own comment claimed the client's action centre showed *"how many
times it has been reminded and when"*, and that was false on the day it was written. 0065 is
applied and immutable, so this is the correction: only half of that sentence ships, and the half
that does not is a decision.

**Both surfaces read it now, and they read it DIFFERENTLY on purpose.**

- The FIRM gets every rung — `AskRecord.chases`, with the key, the threshold that fired and the
  day. That half was never a decision: a colleague who cannot see that the sweep has already
  chased this client three times will chase it a fourth time by hand, which is the work T4.4
  exists to remove. It is also where *"we asked you four times"* needs evidence behind it, which
  is why the table is append-only by GRANT.
- The CLIENT gets a DATE and no tally — `PortalAskRow.lastRemindedAt`, a `max()`. *"We have
  reminded you 4 times"* is an accusation printed on somebody's own page, and on a daily rung it
  reads "9 times" within a fortnight. What a client can act on is WHEN: *"you last heard from us
  on the 12th"* tells them whether they missed a message. Shrestha, 2026-09-01.

The nudge's reader lands in the same task that creates it, for the same reason:
`PortalFilingRow.lastNudgedAt`, also a date and also not a count.

### What building and walking T6.7 found, and what none of the tests did

- **THE NARROWING HID THE FIRM'S OWN PAPERS FROM THE FIRM.** Above, at length. Caught by
  `tests/portal/library.integration.test.ts`'s first assertion — *"a STAFF session is untouched"* —
  which is the first thing to check whenever a restrictive policy lands, and the one that gets
  blamed on everything else first.
- **A CLIENT'S OWN UPLOAD BECAME UNREADABLE TO THEM.** `PostgresPortalAskRepository` inserts the
  document and did not set the new flag, so it defaulted FALSE. It leaked nothing — it made the
  INSERT fail the policy's own `WITH CHECK`, because a portal session cannot write a row it could
  not then read. The wall telling the truth: what a client sends, a client sees. The firm's
  default-by-kind mapping does not apply there and must not — the kind was chosen by the FIRM when
  it raised the ask, and a client who sent a file filed as `working_paper` would lose sight of the
  thing they sent because of a filing decision they never saw.
- **`subject_kind = 'work_item'` HAD NO FIRM-SIDE READER EITHER.** 0063 added it so a client's
  upload files itself against the job that asked for it, and `/work-items/[workItemId]` had no
  `<Documents>` panel at all — the ask panel named each response's filename and nothing else on
  that page listed a file. The panel is there now, and it is where the visibility switch lives.
- **A DOWN MIGRATION FAILED HALFWAY, AND ONLY RUNNING IT SHOWED THAT.** 0067's first down
  dropped its table and its composite key and only then tried to narrow `entry_kind_check`
  back — which a database holding a published `nudge` entry refuses, as its own comment
  predicted. What the comment missed is that the refusal lands AFTER the drops, leaving the
  constraint gone entirely: the exact failure 0066's down carries a paragraph about. It ADDs
  the narrow constraint under a temporary name FIRST now, so the refusal happens with nothing
  destroyed, then swaps it in. `npm run migrate` wraps each file in a transaction and would
  have rolled it back — **a down is run by hand, against a database somebody is trying to
  rescue, and that is the case it has to be safe in.**
- **`worker:once` CLAIMED TO RUN EVERYTHING AND DID NOT.** Its header said "ALL FIVE sweeps", and
  T4.4 registered the chaser on the worker's queue without adding it here — so the command quietly
  ran everything except the one sweep aimed at clients. The count in that comment has now gone
  stale twice; there is no count in it any more, and the list is the list.
- **AND THE SWEEP'S "NOTHING TO DO" LINE TOLD A PARTNER SOMETHING FALSE.** It read *"a firm that
  has published no chaser ladder chases nobody"* on a run where the demo had just published one.
  Two causes, and a line that picks one is worse than a line that names both.

## The client's own request — the first row a CLIENT creates (T6.8)

`delivery.client_request` + `client_request_reply` (migration 0068), `portal:request` (0069),
`usecase/clientrequest`, and two adapters. After T6.5, T6.6 and T6.7 a client could read their
status, answer what the firm asked, find last year's challan and see what they owed — and every
one of those is a REPLY. This is the first row in the schema a client CREATES.

**IT IS NOT `client_ask` REVERSED, AND THAT IS STRUCTURAL.** 0063's `work_item_id` is NOT NULL
with its whole argument written out: the composite FK over `(work_item_id, client_party_id,
tenant_id)` is what makes the wall column a GUARANTEE rather than a convention. A client's own
request has no work item and may never get one — *"please call me about the notice"* is not work
anybody raises a task for — so widening that column to NULL would take 0063's guarantee away
from every row in that table to make room for rows of a different shape. Its own table, and it
pays for the wall differently.

**THE WALL COLUMN IS SUPPLIED BY THE CALLER, UNIQUELY IN THIS PRODUCT, AND `WITH CHECK` IS WHAT
HOLDS.** Every one before it was READ from a parent inside the write, so no caller could name a
party at all. There is no parent here: a contact granted three of the firm's companies has to
SAY which one they are writing about, so the value arrives from the browser and
`WITH CHECK (crm.portal_sees(client_party_id))` refuses any other. 0059 and 0062 each wrote that
arm while noting no portal write path existed *"which is why it will not have to be built with
the rule inside it"* — this is the case that collects on it.

**The service ALSO refuses a party outside the session's scope, and that is a SENTENCE rather
than the wall.** What the policy refuses with is a Postgres RLS violation, which reaches a client
as a 500 and tells them nothing. Delete the service check and the write is still refused; delete
the POLICY and it is not. `tests/portal/client-request.integration.test.ts` demonstrates the
difference by going straight to `withPortal`, past the service, the way an edited adapter would.

**`author_side` IS STORED, AND THE POLICY IS WHY THAT IS SAFE.** The reply table's WITH CHECK
carries a second clause — `NOT crm.is_portal_session() OR author_side = 'client'` — so a portal
session physically cannot write a reply signed as the firm. Deriving it instead ("is the author a
staff account?") is a join that decides ATTRIBUTION, and a contact who was once staff, or an
account whose membership was revoked, would silently change sides in an old conversation.

**AND THAT GUARD IS 0062's SHAPE FOR THE HARD REASON, NOT THE TIDY ONE.** A bare `author_side =
'client'` on a RESTRICTIVE policy applies to STAFF too. Dropping the guard as a negative control
turns **two** tests red and both are the FIRM locked out of its own table — it can no longer reply
to a client, nor send one a document. T6.7's hour-long trap, reproduced exactly, which is why the
first test in that file is *"a STAFF session is untouched"*.

**FOUR STATES, AND THE TWO ENDINGS BELONG TO DIFFERENT PEOPLE** (Shrestha, 2026-09-02).
`open` → `answered` (the firm came back at least once, which is the same fact as
`first_replied_at IS NOT NULL` and is tied to it by a CHECK) → `closed` (**the FIRM**) or
`withdrawn` (**the CLIENT**). The queue is the firm's and a client who got what they wanted will
never come back to tick a box, so the firm closes; and the firm can never write `withdrawn`,
because *"we decided you did not need this"* is a refusal, which is a close with a reply saying
so. **Which ending a session may write falls out of WHICH REPOSITORY it goes through** — the
firm's runs `withTenant` and hard-codes `closed`, the client's runs `withPortal` and hard-codes
`withdrawn` — never from a status argument anybody could pass. The columns are
`settled_by`/`settled_at` rather than 0063's `closed_by`, because that name holding a client
contact on half its rows would read as the firm having closed it.

**A CLIENT'S FOLLOW-UP DOES NOT MOVE THE STATUS.** Sending `answered` back to `open` would break
the CHECK above or force it to be loosened, and a loosened one is how a list filtered on `status`
and a report joined on `settled_at` come to disagree about the same week. Who is holding the
conversation is `lastWordWith`, computed off the thread, and the firm's inbox shows both.

**NO ROUTING, AND IT IS OPEN RATHER THAN DECIDED.** One firm-wide list, no assignee column, no
`?clientPartyId=` filter. The firm has never said whether an inbound request belongs to the
client's partner, to a Dept, or to whoever is free — and this codebase already carries one
arbitrary answer to a question of that shape. When the rule arrives it is a column and an index,
not a rewrite. **NO KIND either**: 0063 carries `ask_kind` because the action centre renders a
different control per value, and nothing branches on the kind of a request. **AND NO DUE DATE**,
which is not open — the firm has never given its turnaround times.

**A FIRM REPLY MAY ATTACH A DOCUMENT ALREADY FILED AGAINST THAT CLIENT, AND SENDING IT IS WHAT
SHARES IT.** The adapter flips `files.document.is_client_visible` (0066) in the SAME transaction,
because attaching a document to a message addressed to a client IS the decision to show it to
them — a reply naming a file the client cannot open would be that default quietly swallowing the
answer. It is deliberately not an upload: a client's own files go through T6.6's route, where
they land in the job's file, and a second thread-shaped path would put them where nobody working
the job is looking. The composite FK is 0063's, and both halves earn their place again — another
client's document is refused, and so is one of the firm's OWN, whose `party_id` is NULL and
matches no NOT NULL value.

**`portal:request` IS THE ELEVENTH PERMISSION AND THE SECOND HELD OUTSIDE THE FIRM (0069).** Not
a widening of `portal:respond`: everything that one covers is a REPLY to something the firm
raised, and this lets somebody START work the firm is then expected to do. A firm may well want
the clerk who sends the registers every month to go on sending them and not to open requests, and
folding the two together would take that choice away with no way to give it back short of
splitting the permission later. `client_contact` carries both; `client_viewer` carries neither
and still sees the whole portal, because reading is authorised by the GRANT.

**NO TRANSPORT, AND THE ABSENCE IS ASSERTED STRUCTURALLY.** `ClientRequestService`'s dependency
list is pinned in `tests/clientrequest/service.test.ts` the way `ChaserService`'s and
`NudgeService`'s are, so a mailer appearing in `Deps` turns the build red and the argument goes on
the board first. Said honestly: a client raises a request and **the firm finds out when somebody
opens the inbox**. P10 is what fixes that, in both directions.

**AND THE FIRM'S READER SHIPPED IN THE SAME TASK.** `/client-requests`, `party:read` to read and
`work:write` to act — this file's own rule after seven things shipped with a writer and nobody
looking.

### Whose desk it lands on (T6.9, migration 0070)

T6.8 shipped with no routing and promised that when the rule arrived it would be *"a column and
an index, not a rewrite"*. **The firm still has not stated a rule**, so 0070 does not encode one:
it gives the firm a SWITCH that is OFF and gives everybody a way to assign by hand whatever it
says. `tenancy.tenant.client_request_routing` is `none` | `key_manager`, `none` is the DEFAULT
and reproduces T6.8's behaviour exactly — so applying it changed no firm's behaviour.

**A COLUMN ON THE TENANT, never a registry kind** — `work_split_axis`'s argument (0043): freely
changeable, restates nothing, and nobody will ever ask what it said last March.

**A SPOC IS NOT AN OPTION AND CANNOT BECOME ONE.** `client_assignment_axis_matches_role` (0049)
makes `axis_id` NOT NULL for a SPOC, because a SPOC covers a Dept or a delivery team. A client's
request names no service, so there is no axis to look one up by. The Key Manager needs no axis,
is one per client (an exclusion constraint), and is the only target this database can derive
without inventing something.

**A WRONG ASSIGNEE IS WORSE THAN NONE** (0051, again): the rule names the right person or NOBODY,
with `assignment_note` naming the FIX. **Under `none` there is NO note** — a firm that routes
nothing has not failed to route anything, and a sentence on every row of a uniformly unassigned
inbox says what the empty column beside it already says.

**THE KEY MANAGER IS READ UNDER `withTenant`, BEFORE THE PORTAL TRANSACTION OPENS.**
`crm.client_assignment` names the firm's own people and has no portal policy — and must not grow
one for this. The service resolves the answer and hands it to the portal insert, so a portal
session never asks that table anything, and the answer never travels back: `PortalRequestRow`
carries no assignee at all.

**AND A PORTAL SESSION CANNOT FORGE ONE.** `bib_app` holds UPDATE on `client_request` and the
portal policy's WITH CHECK only looks at `client_party_id`, so without a guard a client could
UPDATE their own request onto a chosen partner's desk. **A trigger, not a policy, and that is
forced**: a WITH CHECK sees only the NEW row and this is a question about whether a column
CHANGED. Dropping it turns 2 integration tests red.

### What walking it found

- **`className="row gap"` HAS NEVER DONE WHAT IT LOOKS LIKE.** `.row` is `justify-content:
  space-between` and **`.gap` is defined nowhere in the design system**, so a row of buttons is
  flung to opposite edges. Measured on the live page: the client's **Approve and Decline buttons
  were 941px apart** on one card. `.cluster` is the class for that; ten occurrences across five
  files now use it. It was in committed T6.6/T6.7 code and only a screenshot could see it.
- **A TIMESTAMP IS NOT A `date` COLUMN, AND THE RULE POINTS THE OTHER WAY.** This file's
  calendar-day rule is about `YYYY-MM-DD`, where reading the UTC fields is the fix. For an
  INSTANT it is the bug: a request raised at 00:20 in Delhi rendered as the day before, because
  00:20 IST is 18:50 UTC. **The field's TYPE decides which rule applies.**
- **THE FIRM'S SCREEN SAID ONE THING TWICE** — a "Waiting on us" chip beside a raw `open` chip.
  This codebase's duplication bug for the fourth time.

## Loading a firm's existing book — the client import (T6.12)

`usecase/clientimport` + `crm.client_import` (migration 0079 — **the last number in (B)'s
range**). Every firm arrives as spreadsheets and the screens are for the clients that arrive
after that; typing four hundred companies through five screens is data entry somebody abandons
halfway, and a half-true book is worse than none, because the calendar is empty for exactly the
clients everybody assumes are in.

**TWO ACTS, TWO REQUESTS, ONE STAGED ROW.** `POST /api/v1/client-imports` (multipart: a
clients sheet, optional people and engagements sheets, `.csv` or `.xlsx` read by the
dependency-free reader in `infrastructure/sheet/`) parses, checks every row against ONE snapshot
of what the firm already has, and stores rows + report. Nothing else is written.
`POST …/confirm` re-checks — the firm's records may have moved — and then walks the plan. The
staged row is where the sheet lives between the two, because the JSON limit is 256 KB and
because the person confirming must confirm what they READ.

**EVERYTHING GOES THROUGH THE SAME DOORS AS THE SCREENS, enforced by what the module does not
have.** Its three writer ports are `PartyService`, `ClientAssignmentService` and
`EngagementService`, narrowed structurally; the only table it writes is its own. So an imported
client is a client — `party.created`, `legal_entity.registered`, `client_assignment.created`,
`engagement_letter.signed`, `contract.activated` — and from there the scheduler and the calendar
do what they do for a typed one. The import's own two verbs carry COUNTS only.

**A MIGRATED ENGAGEMENT IS A REAL SIGNED LETTER**, because `crm.engagement` cannot exist without
a letter line (0017). One letter per client per currency, dated from its earliest engagement,
`advanceRequired: false`, clauses chosen by `clausesFor` (apply to the country, name no other
country's law), sent, then signed with the sheet's Signatory (or a sentence saying the name is
on the paper) and the paper letter's whereabouts in the reference. **The signature day is TODAY
and cannot be backdated** — `signedOn` in `demo-seed.sh` has always been silently dropped by zod
— which is honest: the attestation happened on import day. `issuedOn` and `effectiveFrom` do
backdate, and `effectiveFrom` is what the calendar reaches back from.

**Consequences stated in the report rather than discovered:** a letter's country must have a
clause in the firm's library or every line for it is BLOCKING; a firm with no
`compliance_policy` floor and engagements older than ninety days gets a WARNING naming the
count, because every filing already made in Excel will otherwise show as MISSED — walked, and
that is exactly what happened.

**BLOCKING is the sheet's fault; a warning is worth a look.** A row already on file (by
registration number first, name second) is SKIPPED, never updated — a sheet that disagrees with
the database is a question for the firm. The second run is boring by design, and that is what
makes a partial first run recoverable: **confirm is NOT one transaction**, each service call
commits alone, and a row that fails halfway is reported with what it got done.

**The account team goes on the group's row.** A group's companies are billed on the group's
letter and their work is routed by the group's SPOCs; a SPOC typed on a company's own row is
recorded on that company and routes nothing. The template says so; the validator does not
guess.

`tenant:admin` on every route, because one confirm creates parties, letters and assignments in
one act, and the report names the roster by email.

## First module

`tenancy`, `party`, the `ledger`, the `config` registry, the `lead` pipeline, `proposals`,
`engagement letters`, the `staff grade` ladder, the firm's `service axis` lists, the
`scheduler`, the `orchestrator`, `invoicing`, `work items` and the `compliance calendar` are built.
T3.3's missed-deadline state and T3.7's dashboards are built. The escalation ladder is BUILT
(T4.5) and did not need G3.4 — its manager hop reads `membership.reports_to_user_id`, and G3.4
answers a different question. **The CLIENT PORTAL is COMPLETE through T6.8** — status home,
action centre, self-serve library, invoices, a month view, and the client's own request —
**and gate 4 is closed**; see the five portal sections above. **T6.8 is what made it two-way**:
everything before it was a reply. **The CHASER is built (T4.4) and so is the PROACTIVE NUDGE (T6.7)**,
and both have readers on both sides. **Phase 6 is finished and milestone M5 is reached.** Phase 6
ran BEFORE Phase 4's agents.
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
