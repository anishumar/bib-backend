# Tenancy and RLS

The tenant wall beyond the essentials in CLAUDE.md: composite keys, gate 4 / portal access, gates
2 and 3, and the fee wall.

## The tenant wall (detail)

### Composite foreign keys
- Every reference between tenant-scoped tables carries the tenant: composite `UNIQUE (id,
  tenant_id)` on the target, referenced as `(fk_id, tenant_id)`. **Why:** a foreign-key check is a
  system operation RLS does not filter, so an id-only reference lets one firm's row hang off another
  firm's object with no policy violation anywhere.
- `tests/architecture/tenant-keys.integration.test.ts` asks the catalogue, not a list: **a new
  tenant-scoped FK fails the build until it carries `tenant_id`.**
- The raw pool (`src/db/pool.ts`) is importable only by `db/`, `infrastructure/`, `setup/` (arch
  rule), so a handler or use case never holds an unscoped connection.
- `src/db/boot-check.ts` refuses to start if the app role can bypass RLS or RLS is off on
  `tenancy.membership`.

### Gate 4 — record scope for portal logins (0059)
All four gates are built since 0059. Gate 4 went in BEFORE the portal screens (a portal read
written against no gate gets written twice). Pieces:
- `crm.portal_access` — which companies a portal LOGIN was granted, effective-dated, one row per
  company.
- `tenancy.membership.party_id` — which PERSON a login is (also lets the org chart hold staff with
  no login).
- `withPortal` in `src/db/tenant.ts`, and RESTRICTIVE policies written with `crm.portal_sees()`.
- `withPortal(` is called by four adapters: the portal-home, portal-ask, portal-library and
  portal-request repositories (see `client-portal.md`).
- The first portal route returning a business record is `GET /api/v1/portal/home` (T6.5); a portal
  read is three things — see `client-portal.md` before adding one.

**Access is GRANTED, never derived.** Reading access out of `core.party_relationship` (group
membership) is one join and wrong: the CRM screen writes relationships, so recording "Cobalt is part
of the Kaveri group" would hand a Cobalt contact the group's filings, unreviewed. No default, no
widening — whether one contact sees a whole group is a fact about the ENGAGEMENT the firm has not
been asked (G0.1: four companies file four sets of returns). (Q064 later added an explicit
"also grant the group" act; see `client-portal.md`.)

**"Unset" and "empty" are different values, and that is the safety.** `app.portal` is `'on'` only
inside `withPortal`, so staff requests take the first branch of `portal_sees()` and the restrictive
policies cost nothing. A portal session with no grants sets an EMPTY list and sees nothing; skipping
the call because the list is empty would leave it looking like STAFF and every read would succeed
silently. `withPortal` has no variant without parties, on purpose.

**The grant path is `usecase/portalaccess`; `portal:grant` is the NINTH permission (0060).** Not
`tenant:admin` (a firm wants the relationship partner to invite a client's CFO without handing over
the roster and roles); not `party:write` (naming a Key Manager grants nothing; this is the only
permission that hands someone OUTSIDE the firm a view of its work). The READS carry it too — the
list names a client's people and what each may see.

**One client per grant, always.** A contact for four companies gets four rows, four events. The
service has no list method and none that walks a relationship.

**Every refusal in the service is one the DATABASE cannot make.** Composite FKs prove membership and
party are this firm's; nothing in SQL says the login is a still-working CLIENT_PORTAL one or that the
party is not archived. The exclusion constraint still refuses an overlapping duplicate under
concurrency; the service is what a person is TOLD first.

**Remove means NOW (decided 2026-09-01, 0061).** `validTo` is the FIRST DAY NOT IN FORCE and `end`
defaults to TODAY, so access is gone on the next request (walking it over HTTP settled it: tomorrow
read as a bug, and is one when someone is removed for cause). `portal_access.ended` carries the
INSTANT — the row is date-grained, the ledger is not.
- 0061 relaxed the CHECK to `valid_to >= valid_from` so "granted 10:00, revoked 10:01" is
  representable: an EMPTY range, `daterange(d, d, '[)')`, which `&&` never matches, so the exclusion
  constraint still works and an empty grant never blocks a re-grant.
- **CREATING an empty grant is still refused by the service** (a typo at grant time). The database
  allows the shape; the service allows only the act.

**"Now" is the FIRM's day, never one the portal caller sends (F-07-1, fixed 2026-09-25, the
2026-09-23 audit's one High).** `?asOf=` had been passed to `scopedClientsForUser`, so a contact
removed today read everything with `?asOf=yesterday`, and a future grant was readable today.
- `scopedClientsForUser(tenantId, userId)` takes NO day and resolves on the firm's own (`dayInZone`,
  tenant zone); `grant` and `end` default to that day, so both ends of "remove means now" use one
  clock. The four portal scope ports lost their day parameter — no caller's day can reach the grant
  set by construction.
- `asOf` survives only on `/portal/home`, where it cuts the DISPLAY, and must be a real calendar day
  (F-07-4); library, ask and request routes dropped it. The request service reads the Key Manager on
  the firm's day too.
- `scopeFor(…, on)` keeps its day: it is the STAFF "who could see this in March" read, behind
  `portal:grant`.
- Test: `tests/portal/grants-firm-day.integration.test.ts` (asks as yesterday and tomorrow; watched
  go red with the check pinned to yesterday).

**A policy per table as each portal read lands, never a sweep.**
- `delivery.work_item` — 0059 (the one business table carrying `client_party_id` directly).
- `delivery.obligation_instance` — 0062, on `entity_party_id` (the column THAT table names; no join
  reaches the client from there, see `client-portal.md`), plus 0309's
  `obligation_instance_portal_live` so a filing withdrawn from a service never reaches a client, in
  the guarded shape `NOT crm.is_portal_session() OR withdrawn_at IS NULL` (rule in CLAUDE.md).
- The client-naming column differs per table and a guessed join is a wall with a hole. Tables without
  their line are unreachable through gate 2 — a real defence, not a permanent one.
- Proof: `tests/portal/gate4.integration.test.ts` asks for the other client's row by id; dropping the
  policy turned five of its six tests red.

### Gates 2 and 3
- Gate 1 is RLS; gates 2 (audience) and 3 (role) are prefix middleware in `api/guards.ts`, both
  **denied by default**: a `CLIENT_PORTAL` session reaches only `PORTAL_PATHS`; a route absent from
  `ROUTE_PERMISSIONS` is refused for everyone.
- **Roles are config rows the firm owns** (T2.5), read through the `PermissionSource` port.
  `DEFAULT_ROLES` (`domain/authz/model.ts`) is only the SEED for a new tenant; nothing consults it at
  request time and there is no fallback to it (see `config-registry.md`).
- A role the firm does not define carries nothing and says so (`UNKNOWN_ROLE`) — a firm locked out by
  a typo must not look like policy working.
- Fee axis: `AuthzService.seesFees()` / `withFeeVisibility()` **redact** money rather than omit the
  record, so "you may not see this" never looks like "there is no fee".

## The fee wall covers PDFs, writes and the timeline too (audit 2026-10-03, `fix/audit-money`)

- **Documents.** `showsFees(kind)` (`domain/filestore/model.ts`): a proposal, engagement letter,
  invoice and credit note open (`/content`, `/versions/{v}/content`), render and preview only for a
  login that sees fees. **Refused WHOLE by kind, never redacted** — a figure prints in too many
  places to promise a redaction catches them all. `Document.showsFees` is on the wire so a screen
  offers Download only where it works.
- **Writes.** Seeing a figure and setting one are one question. `AuthzService.requireFees(p, what)`
  throws `FeesNotVisible` (403, `FEES_NOT_VISIBLE`) and guards: manual invoice, invoice lines,
  payments, credit notes, an advance's refund; a lead's value (capture and details; the details value
  is OPTIONAL, absent keeps it); every write of a `service` config (it carries the list price).
- **Reads.** `listPrice` null on `/config/service*`; a lead's `estimatedValue` null; the client
  import's line fee null; the timeline nulls each verb's money fields, named in
  `domain/ledger/fees.ts` (`tests/ledger/fees.test.ts` fails on a money-shaped payload key nobody
  named, so a new verb is decided, not missed).
- **A line with neither `unitAmount` nor `pricingNote`** on a proposal or letter is quoted at the
  pinned version's list price in the document's currency (`SERVICE_HAS_NO_LIST_PRICE` when none) —
  how a drafter who cannot see fees adds a priced service.
- **Issuing is `invoice:issue`** (0335), not `tenant:admin`: issue, cancel, credit notes, an
  advance's refund or keep. 0335 gave it to every role that held `tenant:admin`.
