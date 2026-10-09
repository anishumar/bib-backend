# Firm setup and structure

Setup readiness, new-firm calendar, the roster, the grade ladder, and the firm's Depts / delivery
teams and work split.

## Setup readiness (V2.6, 2026-09-28)

`GET /api/v1/tenancy/readiness` (`tenant:admin`). Each line is `done`, `to_do` naming its gaps, or
`nothing_to_check`. Setting up a firm is ~16 ordered steps and several fail SILENTLY (no SPOC = work
on nobody's desk, no ladder escalates nothing, an unconfirmed rule files nothing); the QA firm
stopped half-way on 27 Sep 2026 and no screen said so.

- **Computed on every read, never stored or ticked.** Rules in `domain/readiness/model.ts` (pure,
  `tests/readiness/model.test.ts`); `PostgresReadinessFacts` reads every fact in ONE `withTenant` on
  the FIRM's day (`dayInZone`) so all lines describe one moment
  (`tests/readiness/readiness.integration.test.ts` rebuilds the QA state and fixes gaps).
- **Each fact restates a rule the product already applies**, so a line never disagrees with what it
  predicts: a service's Dept = the LIVE version's `module` (routing's rule); an assignment or portal
  grant is in force on `day` half-open; a rule generates when active, dated, not event-driven,
  confirmed and linked (the generator's predicate).
- **Sixteen lines, in this order** (`READINESS_KEYS`, `src/domain/readiness/model.ts`):
  1. `company_details` — every firm company, not archived or retired, has a country and a
     registered address.
  2. `time_zone` — not done while UTC (every firm's old default); `ref` offers the ONE zone the
     companies' countries settle, never applied.
  3. `staff` — a second active staff login.
  4. `deadlines` — compliance_policy `missedFromOn` and `fiscalYearStartMonth`.
  5. `services` — a live service.
  6. `tax_invoice` (S5) — an Indian company's GSTIN and bank account, each service's SAC and rate;
     nothing to check without an Indian company (see `invoicing-and-gst.md`).
  7. `standard_terms` — a published clause (no letter can be written without one).
  8. `reporting_lines` — only where a PUBLISHED check rule is `reporting_line` alone (`_or_rank`
     falls back to rank); the firm's top rung is never asked for a manager, an ungraded person is.
  9. `request_routing` — not `none`.
  10. `processes` — every live service names a published `workflow_template`.
  11. `compliance_rules` — at least one generating, and no linked rule left unconfirmed (which
      services OUGHT to file is not ours to say).
  12. `ladders` — escalation, chaser and nudge each PUBLISHED (never their days: decision D3 open).
  13. `client_details` (Q076) — client companies quoted or engaged missing country/type, or abroad
      year end (see `clients-and-import.md`).
  14. `account_team` — every client with an active engagement has a Key Manager and a SPOC for each
      Dept its services name.
  15. `portal_contacts` — each such client has a live portal login.
  16. `return_periods` (S3) — clients on an authority-assigned rule with no period recorded (see
      `compliance-calendar.md`). Kept LAST so a line added beside it in another branch merges.
- **The API ships codes, the screen ships words.** `gaps[].missing` is a closed vocabulary per line
  (documented on the schema); `id`/`ref` let the screen link the client or service.
- **Nothing to check is not done (audit 2026-10-03, CA#15).** With no relevant subject,
  `reporting_lines`, `processes`, `account_team`, `portal_contacts` answer `state:
  nothing_to_check` (`done: false`); the screen counts only lines that apply. `done` stays on the
  wire.
- The firm's own GSTIN/PAN: since 0334 a firm company's GSTIN and PAN are its party identifiers
  (`PATCH /firm-entities/{id}`), checked by `tax_invoice`.

**A NEW FIRM STARTS ON ITS COUNTRY'S CALENDAR WHEN THE COUNTRY SETTLES IT (F07).**
`POST /internal/v1/tenants` takes optional `country` and `timeZone`: a named zone wins; else a country
with ONE zone (`zoneForCountry`, IN -> Asia/Kolkata); else UTC and Setup asks. **Never from the
currency** (a Dubai firm may keep rupee books). `tenant.created` records `timeZone` and `timeZoneFrom`
(`provisioning` | `country` | `unset`). Existing firms were NOT moved (their call; Setup flags UTC).
The setting is on Your firm.

## Firm administration — the roster

- `/api/v1/tenancy/members` is the firm running itself (who works here, role, access). The platform's
  `/internal/v1/memberships` stays the PLATFORM creating firms, behind a key no browser holds.
- **Revocation is real.** `resolveSession` re-reads the membership on EVERY request (T1.7), so
  cutting access lands on the next request. `membership.revoked` was registered and emitted by nobody
  until T2.5b (the "registered verb with no writer" trap, rule in CLAUDE.md).
- Two guards closing both routes to the same unrecoverable state:
  - **A role must be published before it can be assigned** (`RoleDirectory.knownRoles`) — otherwise
    `UNKNOWN_ROLE` lockout by hand.
  - **A firm must keep an active administrator** (`hasActiveAdministrator`, asked of the roster the
    firm WOULD have). The registry refuses a role set with no `tenant:admin`; the roster refuses
    removing the last holder. (0078 `last_administrator_wall` holds it in the database too.)
- All four routes are `tenant:admin`, the read included — the roster lists colleagues' emails, and a
  general staff directory is a wider decision. (Pickers use `/tenancy/colleagues`, `party:read`; see
  `clients-and-import.md`.)

## Seniority is a third axis, and it grants nothing (G3.3)

`tenancy.staff_grade` is the firm's ladder; `membership.grade_id` puts a person on a rung. Axes kept
apart: **role** = what you may REACH (gate 3); **commercial visibility** = whether you see money;
**grade** = how SENIOR; **`reports_to_user_id`** (T2.9) = who checks your work. A grade carries no
permission, nor does a reporting line.
- It exists for one comparison — the firm's review rule *"Manager or above is fine"* — so `rank` is a
  plain integer; no skill matrix, no tier-and-load routing. Consumers: T2.9's
  `verification_policy.minGradeRank` and T3.1's review step.
- **`rank` is not unique and not contiguous.** Nothing compares within a rung; uniqueness would make
  "insert a rung below" a renumbering.
- **`is_active`, never a delete** — `bib_app` has no DELETE grant on the table. Retired = the firm
  MOVED ON (not a mistake): a rung held in 2026 explains approvals in 2026, stays readable, renders
  marked retired; only NEW placements are refused.
- **`grade_id` is nullable; ungraded is a real answer.** Portal contacts; and designations the firm
  never ranked (Article, Intern, Trainee, Head, Public Relations Officer, CEO are in use at the firm,
  unplaced). This decides who may sign off a statutory filing, so a plausible invented rank is worse
  than null. The firm adds them at `/admin/grades`.
- **A TABLE, not a registry kind**: `membership.grade_id` wants a real FK, the ladder is read whole
  per roster load, and nobody asks what a rung meant last March (same deviation as T3.2's obligation
  templates).
- `DEFAULT_GRADES` (`domain/staffgrade/model.ts`) = the ten rungs 10x Global gave on 22 Aug 2026,
  seeded at `createTenant` via `GradeLadderSeeder` (a firm with no ladder has nobody meeting the
  review threshold). Changing them costs a migration; `tests/staffgrade/seed-parity.test.ts` keeps
  seed and code in step (same arrangement as `DEFAULT_ROLES`).

## The firm's own delivery structure, and how work is split (G2.4)

- `tenancy.service_axis` = ONE table, the firm's TWO lists, discriminated by `axis`: **Depts** (FRC /
  TRC / RAA — revenue axis, what a SPOC covers) and **delivery teams** (FINCOMPLIANCE, VCFO CONSOLE,
  PAYROLL — who does the work). **They CROSS** (a team delivers under several Depts): independent
  dimensions, never a hierarchy — nesting would duplicate catalogue rows per Dept and double-count
  revenue.
- One table not the demo's two (structurally identical; two repos/services/fakes would drift). `axis`
  is a CHECKed discriminator (like `config.entry.kind`, `delivery.job.source_kind`); the firm owns the
  ROWS.
- **In `tenancy`, not the registry** (staff_grade's reason): firm structure, `is_active` is a
  distinction the registry cannot express, and `client_assignment.axis_id` (G3.2) needs a real row.
- **A `service` body stores the CODE, not an FK** — published versions are frozen (that's what lets a
  nine-month-old proposal show its price), so a migration may not rewrite bodies. The table is the
  LIST the code is checked against at write, via the `AxisDirectory` port. Consequences (intended): a
  rename changes `name`, never `code`; a body naming a retired code still reads but cannot be written
  again; **a firm with no rows on an axis is checked against nothing on that axis.**
- **`tenancy.tenant.work_split_axis` (`none` | `dept` | `team`)** = how the firm cuts ONE client's
  work into jobs. A COLUMN (like `firm_signatory_user_id`): freely changeable, and changing it
  RESTATES NOTHING — existing jobs keep their rows, the next engagement splits the new way. (Opposite
  of `reporting_currency`, a column because it must never change.)
- **`none` is the DEFAULT and a real answer**, not "unconfigured": a fifteen-person practice has
  neither layer, a single-P&L firm teams only, a multi-partner firm the reverse. `none` = T2.6's
  behaviour exactly (one job per engagement).
- Both roads to a broken state are closed: choosing an axis whose list is empty is refused, and so is
  retiring the last active row on the chosen axis.
- `groupByAxis`'s consumer is T2.7's spawn (0046; see `delivery-engine-and-workflow.md`). Wiring it
  found the `none` branch returned ONE bucket for everything (would have merged every line of every
  letter on the default) while eleven unit tests were green — a registered thing with no reader is
  unproven (rule in CLAUDE.md).
