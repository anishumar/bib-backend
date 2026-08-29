# BiB — Build Plan & Task Board (merged)

The single source of truth for what we're building, who owns it, and what's done.
Both developers work off this file. Commit changes to it like code.

**This file is the merge of two boards.** The forward product plan (`T` tasks) and the work
that closes the gap to the pre-rebuild demo the client approved (`G` tasks) — folded into one
so neither of us has to read two files to know what to pick up next. `docs/build2.md` is the
field-level analysis the `G` tasks come from; read a task's section reference (§4.5, §5.1)
before starting it, because the reasoning is there and is not repeated in full here.

Where a `G` task and a `T` task are the same work, they are **one task**, not two —
obligations (T3.2) and the compliance calendar are the same module, and it is written once,
below, with everything the demo taught us folded in.

## How this board works

- **Owners:** `(A)` = Anish · `(B)` = second developer (senior). `(A/B)` = pairs or either.
- **Task IDs** like `T2.4` are stable — reference them in commits and when asking Claude
  to check something ("mark T2.4 done").
- **Definition of Done (every task):** the change is merged to `main`, `npm run check`
  is green (typecheck + lint + arch + tests), AND the task's stated acceptance holds.
  No task is "done" on a branch that fails the gate.
- **Marking done:** tell your Claude session "verify and mark T2.4" — it inspects the
  code against the acceptance line, and only then ticks the box and updates this file.
  Claude never ticks a box it hasn't verified against the acceptance criterion.
- **`[~]`** = in progress · **`[ ]`** = not started · **`[x]`** = done & verified.
- **`G` tasks** close the gap to the approved demo (`10xcrm`, 56 tables, twelve modules).
  They are not new features: almost every one existed, worked, and was demoed. They sit in the
  phase they belong to rather than in a section of their own, because the dependency is what
  matters — `G0.1` blocks `T3.2`, and a board that hid that would be worse than two files.
- **Gap ownership rule:** a gap in a module belongs to **whoever built the module**, which is
  not always the lane letter on the original task. Anish built the config registry (`T2.5`,
  labelled `(B)`), so its missing fields are `(A)`. He holds the context for the code it
  threads through.

## The estimate (read the caveats)

Two senior devs, full-time, Claude-assisted, **full-stack incl. both UIs**. Ranges, not promises.

| Milestone | What it includes | Estimate |
|---|---|---|
| **Demoable core** | Spine + engine end-to-end + 1 service pack + workspace UI; agents stubbed (humans in loop) | **10–14 weeks** |
| **Sellable V1** | + billing, obligations, 2–3 service packs, core agents, both UIs at MVP, integrations as fakes | **5–7 months** |
| **Full BiB** | All 11 flows, all 11 agents, all 6 service packs, both UIs polished, real integrations | **9–13 months** |

**The wildcard is P11 (real integrations).** MCA / GST / GSP / TRACES / banking are
externally gated — sandbox access, credentials, and portal quirks are outside our control
and can dwarf the code effort. We build every connector as a **port with a fake first**
(the pattern is already in place), so the product is demoable and testable without them;
the real adapters are a separate track that starts whenever the client grants access.
**Do not put real integrations on the critical path for a demo.**

## The two lanes

They meet at the **audit ledger (P7)** and the **engine's trigger contract**. Agree those
two interfaces first (T1.1, T2.5), then the lanes run parallel with minimal collision.

- **(A) Commercial lane:** party → leads → proposals → engagement letter → billing →
  documents → dashboards → the drafting/context/intake agents → deal-shaped service packs.
- **(B) Delivery lane:** audit ledger → config registry → scheduler → orchestrator →
  agent runtime → verification queue → work/obligations → the rule/compute/monitor agents →
  compliance-shaped service packs.
- **UI:** each dev builds the screens for the modules they built the backend for
  (vertical ownership), against the OpenAPI surface. **UI is not a late phase** — the
  frontend app is scaffolded in Phase 1 (T1.8) and the staff workspace (U2) grows
  vertically alongside each module from ~week 4. Phase 6 is the **client portal + polish**,
  not the start of UI.

## Dependency spine

```
[DONE] Substrate — tenancy, RLS wall, config, ports, OpenAPI
   ↓
Phase 1  Core spine:  P7 ledger (B) · Party+identifiers (A) · RBAC+fee-visibility (B)
                      + Frontend foundation (T1.8): app shell + design system + OpenAPI client
   ↓
Phase 2  Commercial (A): leads→proposals→EL→spawn   ∥   Engine (B): config→scheduler→orchestrator→runtime→verify
   ↓                                    ┌─────────────────────────────────────────────┐
Phase 3  Close loop: work+obligations (B) · billing+docs+dashboards (A)               │
   ↓                                    │  U2 (staff workspace) grows vertically here  │
Phase 4  Agents A1–A11 (split A/B) — layered on the runtime, guardrails first         │  — each module ships its screen when its  │
   ↓                                    │  API stabilizes (~week 4 onward)             │
Phase 5  Service packs S1–S6 (config + connectors, parallelized)                      └─────────────────────────────────────────────┘
   ↓
Phase 6  Client portal (U1) + cross-app polish — NOT the start of UI
   ↓
Phase 7  Real integrations P11 — external-gated, its own track
```

---

## Migration numbering — agree this before either of us writes SQL

`0017` is the last applied migration. Two people adding migrations at once **will** collide on
`0018`, and a migration is immutable once applied anywhere, so a collision is not a rename —
it is one of us redoing the work under a new number.

**Proposed:** `(A)` takes **0018–0039**, `(B)` takes **0040+**. Cheap, and it makes the two
lanes' schema work genuinely parallel. Revisit when either range runs low.

---

## Phase 0 · Substrate — DONE

- [x] `(A)` **T0.1** Tenancy: `tenant` / `user_account` / `membership`, global identity above tenant.
- [x] `(A)` **T0.2** RLS tenant wall: NOBYPASSRLS app role, `withTenant()`, boot check refuses to serve if wall is down.
- [x] `(A)` **T0.3** Config-as-adapter: only `src/config` reads env; fail-closed boot validators.
- [x] `(A)` **T0.4** Hexagonal layering enforced by dependency-cruiser + typed ESLint (arch is a test).
- [x] `(A)` **T0.5** Ports pattern with local fakes; honest registry (dev principal, real SSO deferred).
- [x] `(A)` **T0.6** OpenAPI: zod DTOs generate `/openapi.json` + gated `/docs`; validation → one shared envelope.

---

## Phase 1 · Core spine  (~3–4 weeks) — everything below depends on this

- [x] `(A/B)` **T1.1** Agree the **domain-event vocabulary** + ledger write API (the interface both lanes call). *Acc: a written `event` contract + a `recordEvent()` port stub both lanes import.* — `docs/EVENT-CONTRACT.md` + closed verb registry (`domain/ledger/model.ts`, 38 verbs across both lanes); `EventSink.recordEvent()` in `usecase/ledger/ports.ts` is the one call both lanes import. object_type derived from the verb, actor mandatory, PII refused, idempotency by derived id. One rename: the plan's `contract.active` is registered as `contract.activated` (every verb is past tense) — T2.4 unchanged.
- [x] `(B)` **T1.2** **P7 audit ledger**: append-only `event` (tenant, actor_type human|agent|system, actor_id, verb, object_ref, payload, occurred_at); app role SELECT+INSERT only. *Acc: no UPDATE/DELETE grant; a test proves an update is rejected.* — migration `0003_ledger`, `ledger` schema, RLS + two clocks (occurred_at / recorded_at). Immutability twice over: `bib_app` holds SELECT+INSERT only, and a trigger rejects UPDATE/DELETE/**TRUNCATE** for every role incl. the owner. `assertLedgerAppendOnly` refuses to boot otherwise. 11 live-Postgres tests (`npm run test:integration`) prove the update, delete, truncate and cross-tenant reads are all rejected.
- [x] `(A)` **T1.3** **Party model**: `party` / `organization` / `person` / `legal_entity`, all effective-dated, with RLS from line one. *Acc: create a company + a director as parties; RLS isolates across tenants.* — migration `0002_party`, `core` schema, full vertical slice (domain/usecase/repos/API); RLS proven live (Firm A's org → 404 under Firm B, B's party list empty).
- [x] `(A)` **T1.4** **`party_relationship`** (from, to, type, valid_from, valid_to, attributes) — directorship, employment, shareholding, client-of. *Acc: "who was a director on 31 Mar" resolves by date.* — `isInForceOn` + as-of `partyProfile`; verified in unit tests and live.
- [x] `(A)` **T1.5** **`party_identifier`** — PAN, GSTIN (many per entity), TRN, CIN, effective-dated. *Acc: an entity holds ≥2 GSTINs; lookup by identifier works.* — closed-set CHECK, PAN/GSTIN validation + normalization, dedup lookup; verified holding 2 state GSTINs live.
- [x] `(A)` **G0.3** **Decide soft delete on `core`** — decided: **parties are permanent.** No `deleted_at` anywhere in `core`, and the decision is a paragraph in `CLAUDE.md`. *Acc: the decision is written down — and the column that answers the real complaint exists.* — **§4.1.**
  > **Both halves, because the binary the task offered was the wrong one.** The written decision
  > was the honest answer, but it left the actual complaint — *a client created by mistake* —
  > unanswered, so `core.party.archived_at` (migration **0035**) landed beside it. One column on
  > one table, not `deleted_at` across seven behind a filter every read from now on has to
  > remember to write. It means *keep this out of the pickers*, and nothing more.
  >
  > **The asymmetry IS the design.** The LIST hides archived parties and takes a flag to include
  > them; reading ONE party by id **always** resolves, archived or not. A signed engagement
  > letter's counterparty has to render forever — the same principle 0017's freeze protects.
  >
  > **Archiving is refused by a TRIGGER, not by the service**, while a lead, a proposal, a
  > proposal line's entity, a letter, a letter line's entity or an engagement still points at
  > the party — and the refusal NAMES them, in document-chain order, so the person reading it
  > knows what to close first. A service check is one an import, an agent or a psql session
  > walks straight past. It costs nothing on ordinary writes: `BEFORE UPDATE OF archived_at`
  > with a `WHEN` clause on the NULL → NOT NULL transition, so a rename fires nothing at all.
  >
  > **Found by review, not by building, and both are now fixed.** The guard first shipped with
  > five probes and missed `crm.proposal_line.entity_party_id` — one field at three stages of one
  > document chain, with the first stage unprotected, giving a rule nobody could state. Migration
  > **0036** adds it; it is the *cheapest* of the six, since `idx_proposal_line_entity` has
  > existed since 0018. And the archive `UPDATE` carried no `archived_at IS NULL` predicate, so
  > two concurrent archives both succeeded and wrote **two** `party.archived` events for one
  > archive, into a log that cannot be corrected. The transition is now the lock, the way
  > `signAndFanOut` and `recordAdvance` already do it.
  >
  > `bib_app` still holds **no DELETE grant on any table in this database**, so removal remains
  > impossible at the database level rather than merely unimplemented.
  >
  > Gate: `npm run check` 386 · `test:integration` 111 · `smoke` 119.
- [x] `(B)` **T1.6** **RBAC + fee-visibility axis**: role on membership enforced; commercial visibility is a separate boolean gate. *Acc: a delivery role sees a work item but not its fee, proven in a test.* — all three parts done. **Gate 2 (audience)** shipped first because it was a live hole, not scheduled work: a `CLIENT_PORTAL` login could read the firm's whole client book. **Gate 3 (role)** is a seeded four-role matrix behind a `PermissionSource` port, enforced by prefix middleware against one central route table — **deny by default**, so a route with no declared permission is refused for everyone and a structural test fails if one is added. **The fee axis** is a flag on membership, never derived from a role, with `withFeeVisibility()` redacting money in place. *Acceptance note, stated rather than reinterpreted:* the criterion names a `work_item`, which is T3.1 — the mechanism is proven against a representative fee-bearing record and applies unchanged when the real table exists. Gate 4 (record-scope) needs the user-to-party link and lands with U1.
- [x] `(B)` **T1.7** **Real principal adapter** (session) replacing the dev `x-user-id` stub; client-portal audience wired. *Acc: prod boot refuses the dev resolver (honest registry).* — migration `0004_identity` (credential / session / magic_link, GLOBAL per ADR-02). Password (scrypt, no dependency) **and** magic link, both behind ports; server-side revocable sessions in an httpOnly cookie, token never in a response body. `Principal` now carries `sessionId + tenantId + audience`, with the org switch (`POST /auth/switch-tenant`) re-checking the membership. Verified live end to end, and **the acceptance holds twice**: a `BIB_ENVIRONMENT=qa` boot refuses `BIB_DEV_AUTH_ENABLED` *and* the logging mailer, by name.
- [x] `(A/B)` **T1.8** **Frontend foundation** (separate app — "clean separation"): Next.js shell, auth flow against the session adapter, design system/tokens, and a **typed API client generated from `/openapi.json`**. Runs in parallel with the backend spine — whoever has slack. *Acc: the app boots, authenticates, and calls a real endpoint (e.g. `me/memberships`) through the generated client; regenerating the client after an API change is one command.* — **its own repo: `../bib-frontend`.** Next 16 + React 19, `openapi-typescript` + `openapi-fetch` (`npm run api:generate` is the one command), design tokens in `globals.css`, login → httpOnly session cookie → authenticated calls. **No dev proxy on purpose** — the app talks cross-origin locally exactly as it will in production, which is what surfaced the backend's missing CORS. Verified against the running API: login 200 + cookie, `/auth/me` 200, `/tenancy/me/memberships` 200, `/parties` 200 (5 rows). *Caveat:* driven with node's fetch replicating browser headers, not a real browser.

> **Backend prerequisite found while doing this:** the API had **no CORS at all** — preflight 404, no `access-control-*` headers — so a browser on another origin could not call it and T1.8's acceptance was unreachable. Fixed in `81cb889` (exact-origin allowlist, credentials, mounted ahead of the rate limiter so preflights do not spend the login budget).

> **M1 backend is closed.** Every tenancy, party and session write now records an event
> naming its actor, and the party routes moved from `/internal/v1/tenants/{tenantId}/…` to
> `/api/v1/parties/…` with the tenant taken from the session — a caller can no longer name
> the firm they would like to write to. What remains for M1 is T1.8, the frontend's first
> authenticated call.

**Milestone M1 — reached.** A client company with entities, directors and multiple GSTINs
exists, tenant-isolated, with every write landing in the ledger naming its actor; the
frontend boots, authenticates and renders a real authenticated call through its generated
client. Phase 1 is complete. Gate 4 (record-scope) and `/internal` authorization remain
open and are recorded above; neither blocks Phase 2.

**Milestone M1:** a client company with entities, directors, and multiple GSTINs exists, tenant-isolated, every write landing in the ledger — **and the frontend app renders its first authenticated call**. *(Maps to C2 client records + P1/P7; UI foundation ready for the first screen.)*

---

## Phase 2 · Commercial spine (A)  ∥  Engine (B)  (~4–6 weeks)

### Lane A — sell
- [x] `(A)` **T2.1** **C1 Leads & pipeline**: source, owner (round-robin/territory), dedupe on **phone+PAN+email before create**. *Acc: a duplicate lead merges to the existing party, appends timeline.*
  > **Done (2026-08-28), with one half deliberately deferred — see below.** A lead is an
  > opportunity ABOUT A PARTY, not a second copy of one: capture resolves the party by
  > identifier *before* anything is written, and `crm.lead` (migration 0007) carries only
  > source, stage and owner. **At most one OPEN lead per party**, as a partial unique index —
  > that index IS the merge rule, and it is what makes the acceptance true rather than a
  > convention someone could forget. A prospect who went cold and came back is a second lead
  > behind the same party, so a conversion rate counts two attempts rather than one that took
  > nine months.
  >
  > Dedup matches on the NORMALISED value through the party module, so "Priya@Example.COM " and
  > "+91 98765-43210" find their prospects. Three refusals, all before any write: no contact
  > identifier at all (nobody can follow it up, and dedup would never fire), a proposed owner
  > who is not active STAFF here, and **details pointing at two different parties** — that last
  > is not a merge, it means the firm's own records hold the counterparty twice, and choosing
  > one would attach the opportunity to whichever the query returned first.
  >
  > **No timeline table.** Capture, merge, stage moves and reassignment all write to the ledger
  > against the lead's id, so `GET /api/v1/objects/lead/{id}/events` is the history — carrying
  > `identifierType`, never the identifier, because an email or a PAN in a log that cannot be
  > erased is exactly what the event contract forbids. Two verbs added (`lead.stage_changed`,
  > `lead.owner_assigned`).
  >
  > Routes reuse `party:read` / `party:write` rather than inventing `lead:*`: a lead IS a party
  > here, so a role that can already list every prospect through `/api/v1/parties` gains nothing
  > from a second permission — and since T2.5, a new permission costs a migration to reach
  > existing firms. A firm that does want the pipeline kept from delivery staff can now publish
  > its own role instead, with no deploy.
  >
  > **Agreed at the start (2026-08-28), and both are real gaps, not omissions:**
  > **(1) Owner assignment is MANUAL.** Round-robin and territory are not built. Round-robin was
  > buildable today; territory is not, because nothing in the schema has a territory concept and
  > the axis — geography, industry, service line — has never been chosen. Guessing it means a
  > mapping table with data in it before anyone finds out it is the wrong axis. **T2.1 therefore
  > does not fully meet its own line on this board**, and that is the trade, not an oversight.
  > **(2) Stages and sources are closed sets in code**, not config kinds, so a firm cannot yet
  > rename them. They join the registry when the pipeline screen (T6.2) exists and a firm asks —
  > designing a firm-editable pipeline vocabulary against neither is the same trap T2.5 avoided
  > by deferring workflow templates.
  >
  > Gate: `npm run check` 252 tests · `test:integration` 44 · `smoke` 46.
- [x] `(A)` **G3.1** **Lead: name it, and learn from it.** `title text NOT NULL` on `crm.lead`; `lost_reason text`; add `abandoned` to the stage CHECK and to the terminal-stage constraint. *Acc: two opportunities with the same client are distinguishable in a list; a lost deal records why in the closer's own words; "went quiet" and "chose a competitor" are different rows.* — **§4.4.** A lead has no name at all today, so every list renders the party instead. `lost_reason` is deliberately free text: a dropdown of five reasons produces five reasons, and the useful one is always the sixth. Collapsing `abandoned` into `lost` destroys the only signal separating a **pricing** problem from a **follow-up** problem. While here, confirm `lead_one_open_per_party` is intended — it stops a firm opening a second lead to quote an existing client for unrelated work.
  > **Done (2026-08-28), migration 0030.** `title` arrived add-nullable → backfill from the
  > party's display name → `SET NOT NULL`, with **no default**, deliberately: a default is
  > both permanent and meaningless, and every future insert that omitted a title would get
  > it silently. It is a SNAPSHOT, not a view — a title tracking `display_name` would rewrite
  > history when a client renames.
  >
  > `lost_reason` is free text, and that is the decision rather than laziness. Scoped by CHECK
  > to `lost` / `abandoned` and refused blank. **`abandoned` is a real terminal stage**, in the
  > stage CHECK, in the closed-date constraint, and — the easy one to miss — inside
  > `lead_one_open_per_party`'s `WHERE`, so an abandoned lead stops holding its client's slot.
  >
  > **`lead_one_open_per_party` is confirmed intended**, and it changes what the acceptance
  > line means: a firm may hold exactly ONE live opportunity per client, so two opportunities
  > are distinguishable by title only once the first has closed. Recorded rather than changed.
  > **One gap found by smoke and left open:** a duplicate capture returns `200 / merged: true`
  > carrying the EXISTING title and silently discards the new one — nothing in the response
  > says a title was dropped. The service comment acknowledges the cost; the response shape
  > does not surface it.
- [~] `(A)` **T2.1b** **Lead assignment**: round-robin over active staff behind an
  `AssignmentStrategy` port; territory once its axis is chosen with the client. *Acc: N leads
  captured with no owner distribute evenly; a territory rule overrides the rotation.*
  > **CORRECTED after review (was ticked; now `[~]`).** Round-robin is built, tested and
  > merged — but the acceptance line has two halves and reads *"a territory rule OVERRIDES the
  > rotation"*. Nothing implements, selects between, or asserts a territory override: the port
  > seam exists and the prose explaining the absence exists, and that is all. The reason is
  > still the right one — the axis has never been chosen with the client — but a task whose
  > acceptance is half unbuilt is not done, and ticking it made this board say something untrue.
  > **Done (2026-08-28), and no migration — that is the result, not an omission.** An
  > `AssignmentStrategy` port with one implementation: round-robin over active STAFF.
  >
  > **The rotation state lives nowhere.** It is DERIVED — the lead goes to the active staff
  > member with the fewest OPEN leads, ties broken by user id so the choice is total. A stored
  > pointer is a second source of truth about a fact `crm.lead` already holds exactly, and it
  > goes stale the moment the roster moves: the person it points at leaves and the rotation
  > stalls; somebody joins on Monday and waits a full lap. Deriving it self-heals.
  >
  > **Stated honestly:** this routes by CURRENT DESK LOAD, not lifetime turn. On a level
  > pipeline they are identical, which is the acceptance; they diverge when somebody closes
  > faster and their emptier desk receives more. That is capacity routing, and it is a choice —
  > strict lifetime rotation is a different strategy behind the same port.
  >
  > Fairness under concurrency is a per-tenant transaction-scoped advisory lock plus
  > `AND owner_user_id IS NULL`, so a manual assignment landing in between wins — a rotation
  > never overrules a person. Six simultaneous claims divide 2/2/2; with the lock removed the
  > same test gives 4/6/5, which is how it was checked.
  >
  > **Territory is still not built, and still for the reason T2.1 gave:** its axis — geography,
  > industry, service line — has never been chosen with the client. The port is shaped so it
  > drops in without touching a caller.
- [x] `(A)` **T2.2** **C3 Proposals**: catalogue-built, scope + pricing, per-country quoting, send/track (views, expiry). *Acc: a proposal renders from catalogue rows; discount over limit blocks on approval.*
  > **Agreed design, before building (2026-08-28).** Settled in discussion; recorded here because
  > it decides the schema and money is the area CLAUDE.md is strictest about.
  >
  > **The catalogue row is pinned; the quoted money belongs to the proposal.** A
  > `proposal_line` holds `service_version_id` (FK to the frozen `config.version`) plus its own
  > `unit_amount, currency, fx_rate, fx_rate_date` and discount. The alternative — versioning
  > the whole priced line in the registry — collapses on one example: a negotiated discount for
  > one client would mean publishing a config version per client, and the discount would end up
  > on the proposal anyway.
  >
  > **The service body gains an optional list price**, and that is what makes the pin worth
  > having: reopening a proposal sent nine months ago answers "what was our list price then, and
  > what did we actually charge?" — the most useful commercial fact in the object, free from the
  > frozen version. Optional because an hourly or retainer service may have no list price until
  > an engagement is scoped. This is T2.5's deferral paying off exactly as intended: adding the
  > field is **a new version of each service, not a migration**.
  >
  > **PREREQUISITE — no tenant has a reporting currency, and nothing in the schema has a currency
  > at all.** "Per-country quoting" means quoting in AED and reporting in INR; an FX rate is
  > meaningless without knowing *converted to what*. It goes as a **column on `tenancy.tenant`,
  > set at creation — NOT a config row.** The registry is for what a firm changes, and a
  > reporting currency changed after the fact silently invalidates every historical conversion,
  > because every stored rate was struck against it. That is a property of the firm's books, and
  > a Publish button is the wrong affordance for it. Store the rate even when the currencies
  > match (1.0, dated), so rows are uniform and "did we convert this?" is never inferred.
  >
  > **The discount limit IS config** — it differs per firm and changes — so it needs a new
  > registry kind (`policy`, `{ maxDiscountPercent }`). That gives the spine its third consumer
  > and its first non-catalogue one, which is a fair test of whether it generalises.
  >
  > **Order:** (1) reporting currency on `tenancy.tenant`; (2) list price into the service body;
  > (3) T2.2 proper; (4) the proposal screen in the same push. Steps 1–2 are about an hour and
  > de-risk the money modelling, which is the expensive part to get wrong.
  >
  > **Step 1 done (2026-08-28).** Migration **0009** puts `reporting_currency` on
  > `tenancy.tenant` — added nullable, backfilled to `INR` for the firms that predate it, then
  > `NOT NULL` with a `^[A-Z]{3}$` CHECK and **no DEFAULT at any layer**: not on the column, not
  > in `createTenant`, not on the wire. A default would mean a firm provisioned without anybody
  > saying what its books are in, which is the same silent-wrong outcome the design is arranged
  > against — every rate stored later is struck against this code, so it cannot be corrected
  > afterwards. There is deliberately no route or port method that updates it; changing a firm's
  > reporting currency is a restatement of history, not an UPDATE.
  >
  > `domain/money/model.ts` opens with the currency code — normalise (trim + uppercase, so `inr`
  > and `INR` cannot split a total in Postgres) and validate. A pattern rather than an enumerated
  > ISO 4217 list: onboarding a firm that bills in a currency we have not seen must not be a
  > deploy, and the check worth making — whether an FX source quotes the pair — belongs to an
  > adapter at conversion time. FX rates land with step 3, against a real priced line.
  >
  > `tenant.created` carries the currency in its payload — a machine fact, not personal data —
  > because the column only ever answers what the currency IS, and the question years from now
  > is what it WAS on day one. The create-tenant handler now maps field by field rather than
  > returning the aggregate, and `tests/api/openapi.test.ts` holds its response against the
  > spec, so `Tenant` is the second route covered by that guard.
  >
  > Gate: `npm run check` 291 tests · `test:integration` 61 · `smoke` 61.
  >
  > **Step 2 done (2026-08-28).** `ServiceBody` gains `listPrice: Money | null` — **no
  > migration**, which is the deferral in T2.5 paying off exactly as it was supposed to: the
  > field arrives as a new VERSION of each service. Optional, because an hourly or retainer
  > service often has no list price until an engagement is scoped, and a firm that has not set
  > one must be able to say so; null means "we quote it", never zero. What the validator refuses
  > is a HALF price — an amount with no currency is a number nobody can act on, a currency with
  > no amount says nothing.
  >
  > **Amounts are decimal STRINGS** (`domain/money/model.ts`: `Amount`, `isAmount`, `Money`),
  > and the validator says so in the error, because the reason is not obvious: a float cannot
  > hold 1499.50 exactly, and the discrepancy is invisible in one line and material in a total.
  > Scale caps at four places, not two — minor units run 0 (JPY) to 3 (KWD), and unit rates
  > need a fourth. Non-negative, because this validates prices; a credit is a different thing
  > with its own sign, and allowing "-500" here would make a discount representable twice.
  >
  > The smoke walk now publishes v1 at 25000.00, supersedes it at 27500.00, and asserts v1 still
  > reads 25000.00 — the pinning story told in money, which is what a proposal reopened nine
  > months later actually needs.
  >
  > Gate after step 2: `npm run check` 299 tests · `test:integration` 61 · `smoke` 63.
  >
  > **Step 3a done (2026-08-28)** — the aggregate, the pricing, the policy kind and the discount
  > gate. That is the acceptance criteria: a proposal renders from catalogue rows, and a discount
  > over the limit blocks on approval. **3b is the public view link and `proposal.viewed`**, kept
  > as its own step so a new unauthenticated surface is reviewable on its own rather than buried
  > in a schema commit; **step 4 is the screen.**
  >
  > `crm.proposal` + `crm.proposal_line` (0011). A line pins `service_version_id` and carries the
  > money actually asked for. **One proposal, one currency, one rate** — and the lines are held
  > to the proposal's currency by a composite foreign key on `(id, tenant_id, currency)`, so a
  > mixed-currency document is unrepresentable rather than merely unlikely.
  >
  > **A DEVIATION from the design recorded above, with its reason.** That note put `fx_rate` and
  > `fx_rate_date` on the LINE, beside its amount. They are on the PROPOSAL instead: once the
  > composite key guarantees every line shares the document's currency, per-line rates buy
  > nothing and cost a total that depends on the order somebody added the lines. The Money value
  > that must stay together — amount + currency — still does, on the line. The rate is a property
  > of the document, struck once, and stored even when the currencies match (1.0, dated).
  >
  > **The arithmetic lives in the schema** (0013), as two `security_invoker` views:
  > `proposal_line_amount` holds the discount formula once, `proposal_totals` aggregates it.
  > `security_invoker` is load-bearing — a plain view runs as its OWNER, which is not subject to
  > the row policies, so a totals view over a tenant-scoped table would be a hole straight
  > through the tenant wall. There is an integration test that asserts exactly that.
  >
  > **`policy` is the registry's third kind and its first non-catalogue one** (0010) — the fair
  > test of whether the spine generalises past "things the firm sells", and it did: no new
  > machinery, one body validator. Read LIVE, because a firm that lowers its limit expects it to
  > apply this afternoon. **No published policy is read as ZERO, not as "no limit"**: a firm that
  > never set one has not decided that anything goes, and the fail-open reading of that silence
  > is the one nobody can audit. The error says so and names the fix.
  >
  > **`proposal:approve` is its own permission** (0012), not `tenant:admin` and not the fee axis.
  > The person who manages logins and the person who may sign off forty percent are different
  > people at any real firm; and the fee axis governs SEEING money, not authorising a price. It
  > cost a migration to reach existing firms — the T2.5 rule working as intended, including the
  > firm in the local database sitting on an unpublished draft v2, which got v3 rather than a
  > unique-constraint failure. Only `partner` gets it; a firm that wants managers approving
  > publishes its own role, no deploy.
  >
  > **The fee axis has its first real consumer.** Proposals redact money rather than hiding the
  > document: an associate without commercial visibility sees the client, the services and the
  > quantities, and nulls where the amounts are. Honest note — the handler uses
  > `AuthzService.seesFees()` with an explicit field-by-field mapping rather than
  > `withFeeVisibility()`, because that helper returns `Record<string, unknown>` and does not fit
  > a typed OpenAPI response. The helper is still without a consumer.
  >
  > **Two bugs the end-to-end walk caught that the tests did not**, both worth recording because
  > they say what each layer is for. (1) A bare parameter inside a `CASE` whose other branch is
  > `NULL` has no type to infer, so Postgres called it text and refused to assign it to a
  > `timestamptz` — it only fired on the status transitions, and the integration test drafted and
  > priced without ever SENDING anything. Coverage added. (2) A second discount approval
  > succeeded, recording two sign-offs in a log that cannot be corrected for one decision a
  > person made once.
  >
  > And one in the smoke script itself: a JSON body written inline as `-d "{\"a\":\"b\"}"`
  > inside `"$(code ...)"` is unescaped by the OUTER quotes before the substitution runs, and
  > bash then brace-expands what is left — curl silently receives several mangled URLs. It
  > happens to work for a single-field body, which is why the pattern survived seven sections.
  > Bodies are built into variables first now, with a note saying why.
  >
  > **Still not done on this line:** send/track's TRACK half (3b), and the screen (4).
  >
  > Gate after step 3a: `npm run check` 329 tests · `test:integration` 73 · `smoke` 80.
  >
  > **Step 3b done (2026-08-28)** — send/track's TRACK half. `POST /api/v1/proposals/shared` is
  > the **fourth entry in `PUBLIC_PATHS`**, and the first whose justification is not "this exists
  > to obtain a session". A proposal goes to somebody who has no login and will not get one —
  > that is what a proposal IS. Requiring a session would mean creating an account for every
  > prospect a firm quotes, which is absurd AND a worse posture than a bearer link: it leaves
  > real accounts lying around for people who never became clients.
  >
  > **The token carries its own tenant** (`<tenant_id>.<secret>`, migration 0014), and that is
  > the decision the rest rests on. Resolving a link has no session and therefore no
  > `app.tenant_id`, so the obvious design — find the proposal by digest across all firms — needs
  > a read RLS does not scope, on a table that holds money. Putting the tenant in the token makes
  > it an ordinary `withTenant` read instead. The uuid is not a secret: whoever holds the token
  > already holds a capability into that firm. An integration test presents a real digest under
  > another firm's scope and gets nothing.
  >
  > The rest of what makes it safe rather than merely necessary: 256 bits from the OS CSPRNG,
  > SHA-256 digest at rest (so the send response is the only place the link is ever readable), in
  > the **body rather than the path** so it does not land in access logs, browser history or a
  > Referer, read-only, one answer for malformed / unknown / withdrawn, and the tight rate-limit
  > bucket automatically — the router derives that bucket from `PUBLIC_PATHS`, so the two cannot
  > drift.
  >
  > **`SharedProposal` is its own read model, not the staff one with fields nulled.** A field
  > added for colleagues then cannot reach a client's screen by default. No party id, no lead, no
  > exchange rate, no approver, no catalogue version.
  >
  > **A view is a count and one event.** `view_count` rises on every open, because "they have
  > looked at it four times" is real commercial signal; `proposal.viewed` is recorded once, on the
  > first, because the ledger holds state transitions and a client refreshing a page is not fifty
  > facts about the business. The actor is `system` — the recipient has no account, and inventing
  > a user id for somebody who has never logged in would be worse.
  >
  > **Deliberately NOT built: accepting from the link.** Binding a firm to a click on an
  > unauthenticated link is a bigger decision than this task, so staff record the decision. Said
  > here rather than left as a silent omission.
  >
  > All five proposal verbs now have a writer. When T2.2 started, four of them had none.
  >
  > Gate after step 3b: `npm run check` 340 tests · `test:integration` 77 · `smoke` 85.
  >
  > **Step 4 done (2026-08-28)** — the screens, in `bib-frontend`: `/proposals`,
  > `/proposals/[proposalId]`, and `/p/[token]`, which is that app's first page with no session
  > behind it. **T2.2 is complete.**
  >
  > The rule this board set after five modules shipped against tests alone paid again — the
  > screen found two things no test could:
  >
  > **(1) A catalogue priced in INR beside a line quoted in AED.** Both render with their own
  > symbol, but two columns headed "List then" and "Quoted" invite a comparison that is not
  > valid. The screen now says "not comparable" when the currencies differ. Converting would
  > need a rate between the catalogue's currency and the quote's, and the only rate a proposal
  > carries goes to the firm's REPORTING currency — so this is a real gap in the model, not a
  > presentation problem, and it is recorded as one. If firms routinely price catalogues in one
  > currency and quote in another, the service body eventually needs a price per currency rather
  > than a price.
  >
  > **(2) `numeric(14,4)` reads back as "12.0000"** — the column being precise, not a person's
  > idea of twelve. Trimmed for display only; the string sent back to the API is never
  > reformatted.
  >
  > And one thing found while wiring it: **`viewCount` and `firstViewedAt` were on the row and
  > not on the wire.** Tracking data a screen cannot read is tracking nobody does. Added to the
  > response, unredacted — whether the client has opened the document is not money.
  >
  > **Money never becomes a JavaScript number, on either side.** The frontend hands the decimal
  > string to `Intl.NumberFormat`, which formats it exactly; `format(Number(amount))` would undo
  > at the last possible moment the thing the string exists for. It cost one line in
  > `tsconfig.json` (`ES2023.Intl`) and one guarded assertion.
  >
  > Walked end to end against the running API, including the awkward case: 1499.50 × 12 less
  > 12.5% comes back exactly 15744.75.
  > **Catching up the screens that predate the rule (2026-08-28).** `parties` and `leads` had
  > working APIs and no UI at all — they shipped before "build the screen alongside the module"
  > existed. `/clients`, `/clients/[partyId]` and `/leads` close that, and building them found
  > three API gaps that five modules of tests had not:
  >
  > **(1) `registerLegalEntity` was a WRITE WITH NO READ.** A jurisdiction, an incorporation
  > date and a financial-year end could be stored and then returned by no route in the product.
  > That is the most serious of the three and the least visible: every test passed, because a
  > test asserts on what the writer returned.
  > **(2) Party 360 omitted the subtype.** Legal name, trade name, industry, nationality, date
  > of birth — all captured by the create form, all unreachable afterwards, so a client page
  > could render a display name and nothing else.
  > **(3) Relationships carried uuids.** `director_of → 2b9d5209-…`. The fifth time this
  > codebase has learnt that a read model needs names; `RelationshipRecord` now joins the
  > counterparty and says which END the party asked about is standing at, because "Priya is a
  > director of Meridian" and "Meridian has Priya as a director" are one row read two ways.
  >
  > No migration — the data was always there. Gate: `npm run check` 342 · `test:integration` 77
  > · `smoke` 86.
  >
  > **And the last two: the catalogue and the audit trail (2026-08-28).** `/catalogue` (services
  > + the discount policy, read on `config:read`, written on `tenant:admin`) and `/audit` (the
  > firm's whole trail, and any object's timeline via `?type=&id=`). **Every module now has a
  > screen** — ten routes against forty-four.
  >
  > The audit screen found the same class of gap a fourth time, in the place it matters most:
  > **the trail named its actor by uuid, and nothing a `ledger:read` holder can call resolved
  > it.** `EventRecord` now joins the account — at READ time, deliberately, because the stored
  > row must keep only the id: personal data cannot go into a log erasure is unable to mutate.
  > An erased account stops resolving and the event survives, which is what erasability
  > requires. Storing the name would have made erasure impossible; omitting the join left the
  > trail unreadable.
  >
  > That change made the smoke's "no personal data in the log" check fail, correctly — it
  > grepped the whole response and could not tell a stored field from a joined one. It now
  > reads the `event` half only, and a second check asserts every human act resolves to a
  > person, so the two halves of the property are tested apart instead of conflated.
  >
  > Gate: `npm run check` 344 · `test:integration` 77 · `smoke` 87.
  >
> **The composite tenant-key sweep is done (2026-08-28).** The gap 0007 recorded and
> deliberately did not half-fix: six references inside `core` — organization, person,
> legal_entity, party_identifier, and BOTH ends of party_relationship — pointed at their
> parent by id alone. A foreign-key check runs as a system operation RLS does not filter, so
> one firm holding another's party id could hang a row off it with no policy violation
> anywhere. It leaked nothing; the wall is supposed to forbid it anyway.
>
> Migration **0015** closes them. The identifier one was the worst in practice: identifiers
> are what lead capture deduplicates on, so a crossed row would have made one firm's capture
> resolve to another firm's party — a real leak with no RLS violation in it.
>
> **The lasting part is not the migration, it is the guard.**
> `tests/architecture/tenant-keys.integration.test.ts` asks the CATALOGUE the same question
> the sweep asked — every FK from a tenant-scoped table to a tenant-scoped table that does not
> carry `tenant_id` — rather than enumerating tables. So T2.3's tables are covered the day
> they exist, and the failure names the offending constraint and the fix. Verified by dropping
> a constraint and watching it go red, because a guard nobody has seen fail is not a guard.
>
> Gate: `npm run check` 344 · `test:integration` 81 · `smoke` 87.

- [x] `(A)` **T2.3** **C4 Engagement letter**: clause library (per jurisdiction, versioned), e-sign **port** (fake), advance-fee gate. *Acc: signing fans out one EL into one engagement per line.*
  > **PROPOSED design, not yet agreed (2026-08-28).** Written before building, the way T2.2's
  > was. Six decisions and four open questions; the questions are marked and none of them is
  > answerable from the code.
  >
  > **What an engagement letter IS here.** A proposal is what the firm OFFERED. An engagement
  > letter is what both sides AGREED, and it is the document that creates obligations — which
  > makes it the first object in this product with legal weight rather than commercial weight.
  > Everything below follows from that one difference.
  >
  > **(1) TWO tables, because a letter and the work it sells are different lifetimes.**
  > `crm.engagement_letter` is the document; `crm.engagement` is one ongoing piece of work sold
  > by it. Signing fans one letter out into one engagement PER LINE — that is the acceptance —
  > and it is the engagement, not the letter, that the delivery lane schedules against from T2.4
  > on. A letter is signed once and never changes; an engagement runs for a year, is paused,
  > renewed, or closed.
  >
  > **(2) The EL is BUILT FROM a proposal but does not depend on one.** `proposal_id` is
  > nullable: a renewal or a walk-in engagement has no proposal, and inventing one to satisfy a
  > column would put rows in the pipeline nobody is working — the same reasoning that makes a
  > proposal's `lead_id` nullable. Each EL line pins the same frozen `service_version_id` the
  > proposal line did and carries its OWN money, because the agreed price may differ from the
  > quoted one and both facts have to survive.
  >
  > **(3) The clause library is the registry's fourth kind (`clause`).** Body:
  > `{ title, text, jurisdictions[] }`, versioned and published like everything else, and **the
  > EL pins the clause versions it was assembled from**. Pinning's third real consumer, and the
  > one where it matters most: "what exactly did they sign" is a question a court asks, and a
  > live read would answer it with today's wording.
  >
  > **(4) SIGNATURE FREEZES, by a trigger.** Not a status check in the service. The precedent is
  > migration 0005's config freeze, and the reason is stronger here: an application-level rule
  > protects against the application, and "what did they sign" must also be protected against a
  > migration, a backfill and a 2 a.m. psql session. A `signed_content_hash` is stored alongside
  > the pins so the document is both reconstructible AND verifiable — no PDF, because document
  > storage does not exist yet and pretending otherwise would be the stub-that-lies.
  >
  > **(5) The e-sign port, and THE STUB REGISTRY.** `ESignProvider` is a port; the fake records
  > a signature that staff attest to ("signed on paper", "signed via <provider>, ref X") — which
  > is not a toy, it is how most Indian firms actually sign today. CLAUDE.md's honest registry
  > says the dev auth resolver and the logging mailer are the only stubs and *"do not add a
  > third without the same treatment"*: so this one is config-gated and `validateServer` refuses
  > to boot a production-like environment with it. That rule is the reason this is stated here
  > rather than discovered in review. The provider callback is external, so it is idempotent by
  > derived id.
  >
  > **This keeps the public surface at FOUR paths.** A client-facing signing ceremony would be a
  > fifth `PUBLIC_PATH`, and the proposal share link's paragraph sets the bar. Staff-recorded
  > signature clears it without a new unauthenticated surface; the real ceremony arrives with a
  > real provider or with U1.
  >
  > **(6) The advance-fee gate, and its honest limit.** Engagements fan out as
  > `pending_advance`, not `active`, when the letter requires one — and **T2.4's
  > `contract.activated` is not emitted until the advance is recorded**, so the gate is real
  > rather than advisory: no advance, no jobs. What T2.3 CANNOT do is confirm the money
  > arrived, because billing (T3.4) and payments (T3.5) do not exist. So the advance is marked
  > received by a person, and that is replaced by the payments module later. Same shape as
  > T2.1's manual assignment: the gap is the trade, recorded, not an oversight.
  >
  > **ANSWERED (2026-08-28), and the reasoning, so a later disagreement has something to argue
  > with:**
  > **(a) Clauses are PLAIN TEXT.** Templating means a rendering engine and an escaping story,
  > and a placeholder syntax invented before anyone has asked for one is a vocabulary nobody
  > chose. The T2.5-shaped answer: text now, templates when a firm asks. **The risk is stated:
  > if in practice every letter interpolates the client's name, this is wrong on day one** —
  > and it is a new clause VERSION to fix, not a migration, which is exactly why it is a safe
  > bet to take.
  > **(b) The letter stores its OWN jurisdiction**, defaulted from the client's legal entity
  > when there is one. Not derived at read time from the relationship, for the same reason the
  > proposal stores its own currency: a legal document has to record the jurisdiction it was
  > WRITTEN for, permanently, and deriving it later from a mutable row would silently restate
  > it. This also sidesteps the Dubai-client-of-an-Indian-firm case rather than guessing at it —
  > whoever drafts says which.
  > **(c) `party:write`, not a new permission.** A new one costs a migration to reach existing
  > firms (T2.5's rule), and the distinction nobody has asked for is not worth paying it for. A
  > firm that wants signing held back from delivery staff can publish its own role this
  > afternoon. Revisit when one asks — `proposal:approve` is the precedent for what "asked for"
  > looks like.
  > **(d) A change after signature is a NEW LETTER.** Signature freezes, so an amendment is a
  > new document that supersedes the old one, and the old one stays readable as what was
  > actually signed. **Firms do issue addenda in practice**, and this is the answer most likely
  > to be revisited — but a superseding letter can represent an addendum, whereas a mutable
  > signed document cannot represent anything safely.
  >
  > One consequence worth naming: **T2.3 writes `contract.activated`, not T2.4.** That verb has
  > been registered with no writer since T1.1, and this is the module that causes it — T2.4 is
  > the CONSUMER side (the scheduler reacting to it). Same treatment the four proposal verbs
  > got.
  >
  > **DONE (2026-08-28), to the design above.** Migrations **0016** (the `clause` kind) and
  > **0017** (four tables, two freeze triggers). The acceptance holds as a CONSTRAINT rather
  > than a convention: `UNIQUE (engagement_letter_line_id)` makes a second fan-out impossible,
  > and the signature plus its engagements are one transaction, because a signature with no
  > engagements is a client committed to work nobody scheduled.
  >
  > The freeze is proven against the OWNER role — the role migrations run as — which is the
  > whole reason it is a trigger. The pin is proven by rewriting and republishing a clause and
  > checking the signed letter still reads the old wording.
  >
  > **The third stub got the treatment CLAUDE.md demands, and then some.** `AttestedSigner`
  > records that somebody at the firm SAYS the client signed; `validateServer` refuses a
  > production-like boot on it. Writing that gate exposed that the OTHER TWO gates had no test
  > either — dev auth and the logging mailer could both have been deleted and the build would
  > have stayed green, because a gate that stops refusing breaks nothing. `boot-gates.test.ts`
  > covers all three, and was checked by inverting one and watching it go red.
  >
  > **What the end-to-end walk found:** `ADVANCE_AMOUNT_REQUIRED` answered 409 when it should
  > answer 400. It had been filed with the other advance errors, but "advanceRequired with no
  > amount" is a malformed REQUEST and not a state the letter is in — there is no letter yet.
  >
  > `contract.activated` now has a writer, as agreed. **T2.4 is the consumer side only**, which
  > makes it smaller than the board implies.
  >
  > **The screens landed with it** (`/engagement-letters`, `/engagement-letters/[letterId]`),
  > so T2.3 did not repeat the debt the first five modules left. **This is the first module all
  > session where building the screen found NO API gap** — the read model carried names, the
  > pinned clause text, the signature method and the engagements, because the lesson had
  > already been paid for four times over.
  >
  > What the screen did add is a rule about what to OFFER: the clause picker shows only
  > published clauses that apply to the letter's jurisdiction and are not already on it. The API
  > refuses the rest, and offering something whose only outcome is an error is a slower error,
  > not honesty.
  >
  > Gate: `npm run check` 373 · `test:integration` 92 · `smoke` 104.
  >
  > **The questions as they were asked, kept for the record:**
  > **(a)** Does a clause body hold finished text, or a template with placeholders? Templating
  > means a rendering engine and an escaping story; plain text now, templates when a firm asks,
  > is the T2.5-shaped answer — but if every EL needs the client's name interpolated, plain text
  > is wrong on day one.
  > **(b)** Which jurisdiction selects the clauses — the client's `legal_entity` jurisdiction,
  > or the firm's? For a Dubai client of an Indian firm these differ and the answer decides
  > whether the EL references a legal entity or just a party.
  > **(c)** Is recording a signature its own permission, or `party:write`? It creates
  > contractual obligations and spawns work, which argues for its own; a new permission costs a
  > migration to reach existing firms (T2.5's rule), which argues for reuse until a firm asks.
  > **(d)** Can an engagement be amended after signature, or is a change a NEW letter? A new
  > letter is the legally clean answer and the one this codebase's instincts favour; firms in
  > practice issue addenda.
- [x] `(A)` **G0.1** ~~BLOCKING~~ — **the entity a line is for.** `entity_party_id` on `crm.proposal_line` (nullable), `crm.engagement_letter_line` (NOT NULL) and `crm.engagement` (NOT NULL), each with a composite `(entity_party_id, tenant_id)` FK to `core.party`, threaded through both domain models, both `ports.ts`, both services, both repositories, both handlers, both fakes and the smoke script. *Acc: an EL line names an entity; signing fans out an engagement carrying it; a letter line with no entity is refused by the DATABASE, not by the service.* — **§5.1.**
  > **Done (2026-08-28), migration 0018.** The fan-out now takes the entity **from the line**
  > and keeps `partyId: letter.partyId` — the client is who is BILLED, the entity is who the
  > work is DELIVERED TO, and both are stored. `core.legal_entity` is reachable from
  > downstream for the first time, and T3.2 has its join.
  >
  > **Three deliberate additions to §5.1's plan**, each because building it asked a question
  > the analysis had not:
  >
  > **(1) The entity is in `canonicalContent`, so the SIGNATURE commits to it.** It is a term,
  > and one of the most material — the same service for a different company of the same group
  > is a different agreement at a different price. Leaving it out would have meant the hash
  > says two such letters are identical, and the one dimension the delivery lane schedules
  > against would sit outside what the signature proves. A test signs two letters differing
  > only in the entity and asserts the hashes differ.
  >
  > **(2) The read model carries the entity's NAME, not just its id** — the rule CLAUDE.md
  > says has now been learnt five times, and a letter's lines are precisely where a group
  > client's four companies have to be told apart. A `JOIN core.party` on the letter read, a
  > `LEFT JOIN` on the proposal read because a proposal line naming no entity is a real line.
  >
  > **(3) `contract.activated` carries `entityPartyId`.** That event is what T2.4's scheduler
  > consumes and T3.2 generates from. A consumer that had to join back to the line to find out
  > which company it was scheduling for would be reading the one fact the trigger exists to
  > deliver out of a second table.
  >
  > **The migration REFUSES rather than backfilling, and that mattered.** §5.1's precondition —
  > *"all three tables are empty"* — held on a clean database and on neither of ours: smoke
  > runs had left 176 proposal lines, 91 EL lines and 91 engagements, and **every one of those
  > EL lines belonged to a signed letter**. `trg_el_line_freeze` (0017) refuses any write to
  > them, by any role, so the three-step add-nullable/backfill/`SET NOT NULL` fails at step two
  > — and that is the freeze WORKING. There is also no honest value: no row ever recorded an
  > entity, so writing the client into one puts a term into a signed document that the document
  > never said. 0018 therefore raises a named exception if either table holds rows, and says
  > what to do about it. **Both dev databases need dropping and re-seeding** (`npm run migrate`
  > then `npm run smoke`); nothing else does, because there is no production data.
  >
  > **The forward consequence, written down because G1 hits it eight more times:** once real
  > signed letters exist, **no NOT NULL column can ever be added to `crm.engagement_letter_line`
  > again.** A new required field on an issued document is then a nullable column required only
  > for letters drafted after it. That is a property of a frozen contract, not a defect, and
  > 0018's exception message says so to whoever reads it next.
  >
  > Left where §5.1 left it: the FK points at `core.party`, not `core.legal_entity`. Whether an
  > EL line may only name a company the firm has already incorporated is still the open product
  > decision in the parking lot.
  >
  > Gate: `npm run check` 375 tests · `test:integration` 94 · `smoke` 109.

- [x] `(A)` **G1.0** **The freeze trigger enumerates columns — extend it with every field G1 adds.** `crm.refuse_signed_change()` (0017) compares an explicit list of `engagement_letter` columns; a column not in that list is **silently editable after signature**. G1.1–G1.5 add at least eight (`ref`, `issuing_entity_party_id`, `background`, `addressed_to_party_id`, `issued_on`, `effective_from`, the firm signatory block), and every one of them is part of what the client agreed to. *Acc: a test updates each new column on a signed letter and expects `restrict_violation`; adding a column to `engagement_letter` without adding it to the trigger fails the build.* — Found while building G0.1. The line and clause triggers refuse ANY change so they need nothing; only the head's does this column by column, and the asymmetry is easy to miss because the same migration defines both.
  > **Done (2026-08-28), migration 0019 — and the fix inverts the rule rather than extending it.**
  > `crm.refuse_signed_change()` compared an ENUMERATED list, so a column added later was
  > silently editable after signature until somebody remembered — and six already were. 0019
  > compares the WHOLE ROW (`to_jsonb(NEW) - mutable` vs `to_jsonb(OLD) - mutable`) and exempts
  > only the short allow-list published by `crm.signed_letter_mutable_columns()`: today
  > `advance_recorded_at`, `advance_recorded_by`, `updated_at`.
  >
  > **A new column on `crm.engagement_letter` is now frozen the day it exists**, and adding a
  > FOURTH exemption is the thing that needs an argument. `tests/architecture/
  > signed-letter-freeze.integration.test.ts` asks the CATALOGUE for every column and holds the
  > build red until somebody makes it — which is what caught the twelve columns G1.1–G1.5 then
  > added, on the run after they landed.

- [x] `(A)` **G1.1** **Document reference.** `ref text NOT NULL`, `UNIQUE (tenant_id, ref)` on proposal and engagement letter — `EL-US-2026-0007`. *Acc: a letter has a number a client can quote back on the phone, and two letters cannot share it.* — **§4.5.** Neither document has any human-facing identifier. Decide the generator alongside: per-entity per-year is the shape the demo used, and the same reasoning applies as in T3.4 — a sequence keeps its number on rollback.
  > **Done, migration 0020 — and it REFUSES rather than backfilling.** `PR-YYYY-NNNN` /
  > `EL-YYYY-NNNN`, `UNIQUE (tenant_id, ref)`, shape enforced by CHECK, minted from a sequence
  > so a rollback burns a number instead of reissuing one. Gaps are honest here and fatal in
  > T3.4 — an invoice series must be gapless, which is a different and harder problem, and 0020
  > deliberately does not solve it.
  >
  > The refusal is the interesting part: a signed letter is frozen, and **no document already
  > sent carries a number the client could quote back**, so minting one now would put a
  > reference on our copy that appears nowhere on theirs. The migration says so by name and
  > says what to do instead. Both dev databases were rebuilt from zero.
- [x] `(A)` **G1.2** **Issuing entity, and the rule that picks it.** `issuing_entity_party_id uuid NOT NULL` on both documents, plus a `firm_entity_preference` table (`client_jurisdiction` including `'*'`, `firm_entity_party_id`, `note`) holding the fallback and any deliberate exception. *Acc: a letter names which of the firm's own entities is contracting; a client in a country the firm has no entity in resolves through the fallback, not through an `if`.* — **§4.5, §4.7.** The firm's rule is *"jahan ka client hota hai, wahan ki entity"*, with *"flexibility to choose. But mostly UAE"* where it has none. The letter carries a bare `jurisdiction text` today, which says **where** but never **who**. Stored rather than derived, because it is a snapshot: the client's default may change and an issued letter must always say who actually issued it.
  > **Done, migration 0021.** `issuing_entity_party_id NOT NULL` on both documents, plus
  > `firm_entity_preference` (`client_jurisdiction` including `'*'`) holding the fallback and
  > any deliberate exception — so a client in a country the firm has no entity in resolves
  > through a ROW, not through an `if`.
  >
  > **Every tenant is seeded with its own entity and that fallback at creation**, beside its
  > roles and its ladder, because `NOT NULL` means a firm without the row could not draft a
  > proposal at all — and telling a firm to configure that before it can quote anybody is a
  > worse first day than the problem it solves. The entity seeded is the firm ITSELF, right for
  > a firm operating one company and a starting point for one operating several; the note on
  > the row says nobody chose it.
- [x] `(A)` **G1.3** **The prose a letter opens and closes with.** `background text`, `addressed_to_party_id uuid`, `issued_on date`, `declined_reason text`, `supersedes_id uuid`. *Acc: a letter addresses a named person care-of the client organization, opens with why this client is buying this, and a rejected proposal records why.* — **§4.5.** `addressedTo` is currently a computed string (the party's display name), so the document cannot address an individual. `supersedes_id` matters more than it looks: the model already refuses to edit a signed letter — *"supersede it with a new letter instead"* — and gives that instruction nowhere to be recorded.
- [x] `(A)` **G1.4** **The firm's own signature block.** `firm_signatory_user_id`, `firm_signatory_title`, `firm_signed_at` on the letter; `signed_by_title` beside the existing `signed_by_name`; `firm_signatory_user_id` + `firm_signatory_title` on `tenancy.tenant` as the default. *Acc: a letter prints both signatures — the client's acceptance and "Yours sincerely, …, Director" — and records who bound the firm.* — **§4.5, §4.9.** Only the client's half is modelled, so the firm's block renders as a blank line. Authority to bind is an audit question, and a different fact from who operated the system — the ledger already records the second. One signatory for the whole firm (*"unki ek hi signature rahegi"*), as a row rather than a hardcode, so a successor is an `UPDATE`.
- [x] `(A)` **G1.5** **Effective dates.** `effective_from date` on the letter **and** on the line. *Acc: a letter signed in September can open engagements that begin in October, and one line on it can begin on a different date from the rest.* — **§4.5, §4.6.** Signing currently starts everything immediately, so a letter agreeing that the outgoing accountant finishes August cannot be written down — the firm is issued August's filings and tasks for work it has not taken on. Per line as well as per document, because per line can express a single shared date and the reverse cannot; null on the line means "whatever the letter says", null on the letter means the signature date.
  > **G1.3, G1.4 and G1.5 landed together in migration 0022** — twelve columns on the letter and
  > one on the line, all of them terms, and every one of them caught by G1.0's structural freeze
  > test until it was added to the trigger. That is the forcing function working exactly once
  > as designed.
- [x] `(A)` **G1.6** **Line detail.** On both line tables: `jurisdiction text`, `billing_frequency text`, the four overrides (`scope_override`, `client_obligations_override`, `volume_limits_override`, `exclusions_override`), `oop_estimate_min` / `oop_estimate_max` / `oop_currency`, `pricing_note text`, **and relax `unit_amount` to nullable.** *Acc: a line can say "as mutually agreed" with a reason instead of a price; editing one client's scope wording does not touch the catalogue; a line carries an out-of-pocket range separate from the fee.* — **§4.6.** Two of these are sharper than the rest. `unit_amount numeric NOT NULL CHECK (>= 0)` makes an unpriced line **unrepresentable** — it has to be quoted as zero, which says something different to a client, and several real lines are genuinely "as mutually agreed". The four overrides are what make an issued document reproducible: the letter carries its own wording, so a later catalogue revision cannot change what a signed document says.
  > **Done (2026-08-29), migrations 0023 and 0024.** The nine columns are the easy half. The
  > hard half was `unit_amount`, and the answer is on the board because it changes what a
  > number on a screen MEANS.
  >
  > **A total is no longer one number.** `sum()` skips a NULL price, so the figure is exact for
  > what it covers and silently UNDERSTATES the document. Coalescing to zero is worse — the
  > line is then *in* the total at a price nobody agreed. So `unpricedLineCount` rides beside
  > `net` everywhere: the totals view, both read models, the wire, and the recipient's shared
  > view. Non-zero means `net` is a **floor**. The deciding case is the wholly-unpriced
  > document: three "as mutually agreed" lines sum to zero, and the count is the only thing
  > between that zero and a partner reading it as free work. Per line, `net` is NULL and not 0,
  > and `priced: boolean` sits beside `unitAmount` UNREDACTED — without it a colleague who
  > cannot see money reads every line as "as mutually agreed".
  >
  > A line with no price must carry a `pricingNote` saying why, and a discount off an unpriced
  > line is refused — it would otherwise hold a proposal at the approval gate over a discount
  > that does not exist.
  >
  > **The OOP range takes no composite currency FK**, and that is the point of it: if the
  > estimate had to be in the document's currency it would already be in `currency`. It exists
  > because it routinely is not — which also settles the arithmetic, since the `fx_rate` is
  > struck for the fee currency and an OOP range is therefore never summed into anything.
  >
  > **Migration 0024 was not planned, and it closes a real hole in 0017.**
  > `crm.refuse_signed_child_change` resolved the parent letter from `NEW` on UPDATE — so
  > repointing a **signed** letter's line at a draft letter of the same firm and currency
  > SUCCEEDED: a term silently removed from a signed agreement, totals changed, nothing raised.
  > Found by extending G1.0's catalogue-driven freeze sweep to the LINE table, which nothing
  > covered. Verified against the live schema before and after. 0024 checks both parents.
  >
  > **`canonicalContent` changed**, so a `signed_content_hash` taken before this cannot be
  > re-derived. Nothing in the product re-derives one and the freeze is what actually holds a
  > signed letter still — but the alternative was a signature that did not cover the client's
  > own scope wording, which is worse.
  >
  > Gate: `npm run check` 643 · `test:integration` 204 · `smoke` 182.
- [x] `(A)` **G1.7** **The prose blocks.** `document_block` (`kind` in `exclusion` / `commercial` / `team`, `body`, `is_heading`, `sort_order`) owned by a document, and `standard_document_block` (the same plus `jurisdiction` and `is_active`) as the firm's standard set, **copied** onto each new document at creation. *Acc: a firm edits its standard exclusions and the next letter changes while every issued letter still says what it said; a UAE proposal does not print an Indian tax note.* — **§4.7.** One row per line rather than one blob per block, because that is how they are edited — a line at a time, reordered, removed — and a single text column makes "delete the third exclusion" a string operation with nothing for the UI to attach an edit control to. `jurisdiction` is load-bearing: *"All fees are exclusive of GST as applicable"* is wrong on a UAE proposal in exactly the way the firm already caught in its own template.
  > **Done (2026-08-29). Migration 0025.** Both halves of the acceptance hold end to end: a firm
  > rewrites its standard exclusion and the letter already issued still says what it said while
  > the NEXT one carries the change, and a UAE letter does not print the Indian GST note.
  >
  > **COPIED, not referenced, and that is the whole design.** `standard_document_block` is what
  > the firm maintains; `document_block` is what a document SAYS. A reference would be cheaper
  > and would silently rewrite what every issued proposal and SIGNED letter says the firm
  > excluded. It is the config registry's pinning argument reached from the other direction —
  > and here a copy beats a pin, because these lines are meant to be EDITED per document (a
  > client negotiates an exclusion away), which a pinned version cannot express.
  >
  > **ONE TABLE, TWO NULLABLE PARENTS**, exactly one set by CHECK — against the local precedent
  > of separate line tables, and the reason is that those two differ in substance (an EL line's
  > entity is NOT NULL, one carries `removed_at` and `effective_from`, one carries the
  > overrides). A block is the same object on both documents, so two tables would duplicate the
  > freeze trigger, the copy, the repository and the API to express a difference that does not
  > exist. The composite FKs are MATCH SIMPLE, so a NULL parent skips its check.
  >
  > **The signed-letter freeze applies for free** — `crm.refuse_signed_child_change()` resolves
  > its parent from `engagement_letter_id`, which this table has, and its guards are IS NOT
  > NULL so a proposal's blocks are untouched. The exclusions a client agreed to are part of
  > what they agreed to.
  >
  > **`removed_at` is the THIRD soft delete in the product**, and CLAUDE.md enumerates the other
  > two by name, so it is argued rather than assumed: it is the same thing they are — a line
  > struck off a document in draft — and "delete the third exclusion" is half of why this is a
  > row per line at all. `bib_app` holds no DELETE grant on any table, so it is the only honest
  > way to express removal.
  >
  > **A NEW GUARD, and it found something the moment it existed.** The freeze sweep enumerated
  > the COLUMNS of a line from the catalogue but never the child TABLES — `line` and `clause`
  > were frozen because somebody wrote two CREATE TRIGGER statements, and a third child table
  > would have arrived unprotected with every test green. It is now asked of the catalogue. On
  > its first run it named **`crm.engagement`**, which is a DELIBERATE exception now written
  > down rather than left as a hole: signing CREATES those rows, so a freeze over them would
  > refuse the act of signing, and `recordAdvance` moves them afterwards by design. The line is
  > **what the letter SAYS is frozen; what the letter CAUSED has its own lifecycle**, and adding
  > a second name to that list is what needs an argument.
  >
  > **The verb registry earned its keep twice.** `standard_document_block.set` had to be
  > registered and documented in `EVENT-CONTRACT.md` before it could be emitted, and the
  > exhaustiveness guard added with G1.8 caught all six new `DocumentError` codes as a COMPILE
  > error the moment they were declared — the G3.3 bug, refusing to happen a second time.
  >
  > Gate: `npm run check` 716 · `test:integration` 222 · `smoke` **211 passed, 0 failed**.

- [x] `(A)` **G1.8** **Governing law and courts.** Extend `ClauseBody` — currently `{title, text, jurisdictions[]}` — or add a clause-set concept carrying `governing_law` and `courts`, resolved from the **issuing entity's** jurisdiction (G1.2). *Acc: a letter issued by the US entity cannot print Indian governing law.* — **§4.7.** The sharpest finding of the original project: the real letter was issued by 10x US to a US client and its standard terms named Indian law and Delhi courts. The firm's verdict was flat — *"No. This is wrong. For US it's US. For UAE it's DIFC in Dubai etc."* Clauses are tagged by jurisdiction today, which is not the same thing: nothing anywhere holds the governing law, so the bug the firm already caught is representable again.
  > **[~] Schema half done (2026-08-28); the wiring half is still open.** `ClauseBody` gains
  > `governingLaw` and `courts`, each a `JurisdictionalTerm | null` — an ISO 3166-1 code AND
  > the words the document prints. **Both halves, because neither does the other's job:** "the
  > laws of the State of Delaware" does not follow from `US`, and "the DIFC Courts, Dubai" does
  > not follow from `AE`; while prose alone is invisible to the machine comparison this task's
  > acceptance actually asks for — a human review already let this letter out once. Validated
  > together (a half term is refused), demanded in canonical upper case at the write, optional
  > so that clause versions already published and pinned by issued letters still read.
  >
  > **[x] Wiring half done (2026-08-29). A letter issued by the US entity cannot print Indian
  > governing law — proven end-to-end in smoke, on the letter the firm actually caught.**
  >
  > **The comparison is against the ISSUING ENTITY, and that is the whole point.** Not against
  > the letter's own jurisdiction, and not against the clause's `jurisdictions` — which was
  > satisfied by the real bug and always would be. The clause that went out was applicable
  > EVERYWHERE and every word of it was true; the letter was the wrong place for it. The test
  > `…and jurisdictions could not have caught it` asserts exactly that, so the distinction
  > cannot quietly collapse into the older check.
  >
  > **BOTH terms are checked**, because half the bug the firm caught was the courts. A clause
  > naming Delaware law and a Singapore seat is refused on a US letter, and a check comparing
  > only `governingLaw` would pass it.
  >
  > **An UNREGISTERED issuer is refused too, and this is the case that decides whether the
  > check is worth anything.** `seedFirmEntity` writes a `core.organization` and no
  > `core.legal_entity` row — nothing knows the firm's country at `createTenant` — so every
  > firm's default issuing entity has no jurisdiction, and that is exactly the position the
  > original letter was written from. Passing there would put the check everywhere except
  > where the bug lives. It is a 409, not a 400: the request is well formed and resending
  > changes nothing, and the message names the entity to register. **It costs no existing
  > flow** — a clause naming no law is untouched, and `governingLaw` was added the day before,
  > so no letter anywhere pins a clause this can refuse.
  >
  > **THE LIMIT, written down rather than discovered:** a deliberate foreign choice is now
  > unrepresentable. An Indian entity contracting under English law, or naming a neutral
  > arbitral seat, is a real arrangement in cross-border work and this refuses it. That is the
  > firm's own rule applied as a product rule, and it is the safer direction to be wrong in —
  > a wrong law on an issued document reached a client once, and a refusal is visible in a way
  > a bad clause is not. Making the exception representable belongs on the LETTER (a term it
  > records as chosen on purpose) and is a decision nobody has taken.
  >
  > **`LetterClauseRecord` carries the structured terms now**, read from the PINNED version, so
  > a signed letter answers with what the client agreed to. Without it the two fields could be
  > stored, validated and refused against — and then reach nothing.
  >
  > **Two things found while wiring it, neither of them G1.8:**
  >
  > 1. **The fake's clause read model returned empty titles and empty text, and had since
  >    T2.3.** A LINE's pin resolved through the shared library; a CLAUSE's pin resolved
  >    through a `clauseBodies` map **nothing ever wrote to**. No test noticed because none
  >    read a clause's wording until this one had to. It now resolves through the same library,
  >    the way the Postgres adapter's join does, with the map demoted to an override.
  > 2. **`api/domainerr.ts` could silently answer 500 for any unmapped code, in every family.**
  >    That is the G3.3 bug — `StaffGradeError` shipped with no entry and every refusal
  >    answered 500 — and its note asked the next person to remember. Each family's switch now
  >    ends `default: return unmapped(err.code)` where `unmapped` takes `never`, so **an
  >    unmapped code is a COMPILE error naming itself**, on the day it is added. Verified by
  >    deleting a case and watching the build go red. Runtime still returns 500 rather than
  >    throwing, because a mapper that crashes turns a mislabelled error into no response.
  >
  > Also on the wire, because a write with no read is not a stored fact: the firm-entity
  > preferences screen now shows where each of the firm's own entities is REGISTERED. That is
  > the column that makes the rule legible — "a client in AE is served by this company" reads
  > differently once you can see the company is registered in IN — and it is where a firm sees
  > which of its entities the refusal above applies to before it hits one.

> **Milestone G1 (inside Phase 2):** an engagement letter generated from this system is the
> letter the firm actually sends — numbered, issued by a named entity, addressed to a person,
> with its own scope wording, its exclusions, both signatures and the right governing law.

- [x] `(A/B)` **T2.4** **C5 spawn bridge**: signed EL emits the engine's job-creation trigger (event, not a direct call). *Acc: a signature produces a `contract.active` event the scheduler consumes.*
  > **Closed by T2.6, with no work left for `(A)`.** The acceptance has two halves and they
  > shipped in different tasks: T2.3 already emitted `contract.activated` on signature, and
  > T2.6's scheduler is what consumes it. Verified end to end in `smoke` §10c. Ticked here
  > rather than left open so nobody plans time against it.

### Lane B — the engine
- [x] `(B)` **T2.5** **P2 Master configuration registry**: services, workflow templates (**versioned**), rule packs (`gst-in@2026.07`), SLAs — data, not code. *Acc: a new service is a config row; running jobs pin their template version.*
  > **Agreed scope for the first pass (2026-08-28):** build the **versioned-config spine** (how a
  > row is versioned, published, and *pinned* — a running job must stay on the version it
  > started on, or editing a workflow silently rewrites jobs in flight), plus the two registries
  > that already have consumers waiting: **services** (the catalogue T2.2 proposals build from)
  > and **roles** (replacing the hardcoded matrix behind the existing `PermissionSource` port,
  > so a firm can use its own vocabulary). **Workflow templates and rule packs are deliberately
  > deferred** until the orchestrator (T2.7) and rule-match agent (T4.3) actually read them —
  > designing those shapes against no consumer is how a schema ends up wrong in a way migrations
  > have to undo. This is why T2.5 comes before T2.1: the plan says agree it before the lanes
  > split, and T2.2 depends on the catalogue.
  >
  > **Done (2026-08-28), to that scope.** `config.entry` (the configured thing) + `config.version`
  > (what it said, when) in migration 0005, with the two kinds `service` and `role`. Publishing
  > **freezes** a version — a trigger, so it binds `bib_owner` and a psql session, not only the
  > app — and archives the one it replaced; a partial unique index keeps exactly one version in
  > force. **Pinning works**: `readPinned(versionId)` resolves an archived version with the body
  > it had, proven against real Postgres. Both reads are explicit and the CONSUMER chooses —
  > roles read live, because a firm that removes a permission expects it gone that afternoon.
  >
  > Gate 3 now reads the firm's own role rows through the unchanged `PermissionSource` port; the
  > swap touched no call site, which is what the port existed for. `StaticPermissionSource` is
  > deleted and `DEFAULT_ROLES` is only the seed. **Every tenant gets a complete role set inside
  > `createTenant`** (a `RoleRegistrySeeder` port) and 0005 backfilled the firms that predate it,
  > because both read-time fallbacks are worse: merging with product defaults means a firm can
  > never remove a permission, and defaulting only when a tenant has no rows means its first
  > published role locks out everyone holding another. New permission `config:read`; **writes use
  > `tenant:admin`** rather than a `config:write`, since whoever publishes a role version can
  > grant themselves everything — and a publish leaving no role with `tenant:admin` is refused,
  > as it cannot be undone from inside the product. Four verbs added to the event contract;
  > drafts are not recorded, because the log holds what took effect.
  >
  > Migration **0006** follows it with a composite foreign key `(entry_id, tenant_id)`: FK checks
  > run as a system operation RLS does not filter, so 0005 alone let one firm hang a version off
  > another firm's entry. It leaked nothing, but the wall should make that unrepresentable, not
  > merely invisible. Separate number because 0005 was already applied — fix forward, no
  > exception for the same afternoon.
  >
  > Gate: `npm run check` 219 tests · `test:integration` 33 · `smoke` 36. **Not built, and not
  > pretending to be:** workflow templates and rule packs (deferred above), retiring or deleting
  > an entry (removing a role locks out its members and removing a service breaks pins — that
  > needs a confirmation flow that says how many rows are affected, which is a screen and a
  > decision), and any caching of the permission read (one indexed query per authenticated
  > request, uncached on purpose so a revoked permission is revoked now).
- [x] `(B)` **T2.5b** **Firm administration**: the roster, role assignment, and revocation —
  the app-facing half of membership. *Acc: an admin adds a colleague, changes their role, and
  revokes access; the revoked session stops on its NEXT request.*
  > **Found while looking for the first admin screen (2026-08-28).** T2.5 shipped role
  > DEFINITION on the product surface, so a firm could invent a role and give it to nobody:
  > membership existed only on `/internal`, behind a platform key no browser may hold. No route
  > listed a firm's people, changed a role, or removed anybody.
  >
  > **The sharp part: `membership.revoked` was a registered event verb that nothing wrote.**
  > `is_active` and its grant have existed since 0001, and `resolveSession` has re-read the
  > membership on every request since T1.7 — a real per-request cost — precisely so revocation
  > lands immediately. The switch was never connected. A firm that dismissed somebody could not
  > stop their access. `tests/tenancy/administration.integration.test.ts` now proves the whole
  > path against a real session: revoke, and the very next request loses its tenant and role.
  >
  > Four routes under `/api/v1/tenancy/members`, all `tenant:admin` including the read (the
  > roster lists colleagues' email addresses; a general staff directory is a wider decision).
  > The roster is a joined read model — membership plus email and name — so a screen shows
  > people rather than uuids. Migration 0008 adds `user_account.display_name`, global per
  > ADR-02: the same human at two firms is one person with one name.
  >
  > Two guards, closing both routes to one unrecoverable state. **A role must be published
  > before it can be assigned** — enforced on the provisioning path too, since `/internal` can
  > lock somebody out just as easily. **A firm must keep an active administrator**, asked about
  > the roster it *would* have, so it covers a demotion and a deactivation alike, including an
  > admin acting on themselves. Three verbs written: `membership.revoked` at last,
  > `membership.restored`, `membership.role_changed`.
  >
  > Gate: `npm run check` 278 tests · `test:integration` 54 · `smoke` 58. The screens are in
  > `../bib-frontend` (`/admin/people`, `/admin/roles`) — the first vertical slice of U2, and
  > the first time any of the last five modules has had a UI. Building them immediately turned
  > up two API gaps: nothing published the PERMISSION VOCABULARY, so a picker could only be
  > built by retyping the list; and `/auth/me` still cannot tell a screen what the session may
  > do. The first is fixed; the second is above.
- [x] `(A)` **G2.1** **Catalogue: identity and reporting axes.** Add `ref`, `module`, `group` to `ServiceBody` (or settle `ref` onto `config.entry.key` and write down which). *Acc: revenue can be grouped by Dept; a proposal cites the firm's own service code.* — **§4.8.** `(A)` despite sitting under a `(B)` task: Anish built the registry, and the gap-ownership rule follows the builder. `module` is FRC / TRC / RAA, the axis the firm's own dashboard splits revenue by, and the axis a SPOC is assigned per (G3.2). `group` is the delivery team and is deliberately **not** nested under module — FINCOMPLIANCE appears under both FRC and TRC, so they are independent dimensions of one service rather than a hierarchy. No migration: these arrive as a new VERSION of each service, which is T2.5's deferral paying off again.
  > **Done (2026-08-28); acceptance only reached on 2026-08-29.** `ref` is settled onto the
  > BODY, not `config.entry.key`: a key is lowercase by rule while the code is `A1`, and the
  > key is the pin target every issued document resolves through, while a services-master
  > renumber is an ordinary Tuesday. `module` and `group` are independent dimensions, not a
  > hierarchy — FINCOMPLIANCE delivers under both FRC and TRC, so nesting would force a
  > duplicate row per Dept and count its revenue twice. Both are free-form firm codes (this
  > product is sold to many firms) but demanded in CANONICAL form at the WRITE, because the
  > whole job of the field is to be `GROUP BY`-ed and `frc` beside `FRC` splits one Dept into
  > two half-sized ones that both look plausible. A body is stored verbatim, so a read-time
  > fix would come too late for the SQL that groups.
  >
  > **It was ticked a day early and taken back.** Storing the fields is not the acceptance —
  > *"a proposal CITES the firm's own service code"* is, and no read model returned `ref`, so
  > a screen still needed a registry call per line. The read-model half closes it:
  > `ProposalLineRecord.service` / `LetterLineRecord.service` now carry `ref`, `module`,
  > `group`, `billingBasis`, `recurrence`, `slaDays`, `listPrice`, `pricingNote` and the four
  > prose blocks, resolved through `readServiceBody` off the body the repositories were
  > already selecting. **The same gap covered `slaDays`, and closing it is what unblocked
  > `(B)`'s T3.1** — smoke asserts the line says 30 while the live catalogue says 90.

- [x] `(A)` **G2.2** **Catalogue: the four scope blocks.** Add `scope`, `clientObligations`, `volumeLimits`, `exclusions` to `ServiceBody`. *Acc: an engagement letter is assembled from the catalogue's own words, and G1.6's overrides have something to override.* — **§4.8.** These are what protect the firm in a dispute. Store them as the firm states them — *"under 1,000 entries; under 8 bank accounts"* — not parsed into typed limits: nothing is metered, and when a client exceeds a ceiling the firm re-assesses the engagement rather than auto-charging. If metered billing is ever wanted, that is the point to add structure, not before.
  > **Done (2026-08-28); acceptance only reached on 2026-08-29 with G1.6.** Prose, exactly as
  > the firm states it — *"under 1,000 entries; under 8 bank accounts"* — and deliberately NOT
  > parsed into typed limits: nothing is metered, and a client who exceeds a ceiling gets the
  > engagement re-assessed rather than auto-charged.
  >
  > **Also ticked a day early and taken back**, for the same reason as G2.1: a grep for the
  > four blocks across `src/` returned nothing outside `domain/config/model.ts` — zero
  > consumers, while the acceptance says a letter is ASSEMBLED from them. Both halves exist
  > now: the catalogue's words on `service`, and G1.6's per-document override beside them,
  > resolved in ONE place with **which one won** visible to the caller. That last part is the
  > value — a screen that cannot tell a standard scope from a negotiated one has not assembled
  > a document, it has printed one.

- [x] `(A)` **G2.3** **Catalogue: `slaDays`, `recurrence`, `pricingNote`.** *Acc: a work item created from an engagement snapshots the SLA in force at creation; a service can recur monthly while being billed quarterly; a service with no list price can say why.* — **§4.8. This one gates `(B)`: T3.1 cannot meet its acceptance without `slaDays`.** The firm's rule is *"task is due from signing of EL"* and *"SLA is per service"*, and a work item copies the value at creation so a later catalogue revision cannot make finished work retroactively late. `recurrence` is not `billingBasis`: the latter says how a service is priced (fixed / hourly / retainer / per_unit), the former how often it recurs, and the EL line's `billing_frequency` (G1.6) defaults from it. `pricingNote` gives `listPrice: null` a reason — "As mutually agreed" currently has no home.
  > **Done (2026-08-28) — this is the one that unblocked `(B)`'s T3.1.** `slaDays` is whole
  > days from signing of the EL, read off a PINNED version, so a later catalogue revision
  > cannot make finished work retroactively late. `recurrence` (one_time / monthly / quarterly
  > / annually / custom) is NOT `billingBasis`: one says how often work comes round, the other
  > what the price is a price OF. `pricingNote` gives `listPrice: null` a reason.
  >
  > **Every one of the ten fields is OPTIONAL, and that is load-bearing.** A published config
  > version is FROZEN, so a required field would strand every version already published —
  > which cannot be edited to carry it and has no honest value to invent. Absence reads as
  > null, never as a default. **No migration:** these arrive as a new VERSION of each service,
  > which is precisely what T2.5's deferral was deferred for.
- [x] `(B)` **T1.6b** **What a portal session is told it may do.** `permissionsOf` returns `[]` for a `CLIENT_PORTAL` session whatever role it holds. *Acc: a `CLIENT_PORTAL` membership carrying `manager` reports no permissions, a STAFF one is unchanged, and a permission-gated portal route fails the build.*
  > **Found by reading a screen, not a test (2026-08-29).** Nothing refuses `manager` on a
  > `CLIENT_PORTAL` membership — the roster's Add form offers every published role against
  > either surface, and the API accepts the pair. **It leaks nothing**: gate 2 runs before
  > gate 3 and answers 403 to every staff route, verified live against all seven. But
  > `/auth/me` reported `["party:read","party:write","ledger:read","config:read"]`, and not
  > one of them was reachable — which is precisely the 403-by-surprise that field exists to
  > prevent (`CLAUDE.md`: *"so a screen offers only what will work"*).
  >
  > The empty set is arithmetic, not policy: gate 2 admits a portal session only to
  > `PORTAL_PATHS`, and every one of those needs no permission. **U1 breaks that assumption**
  > the moment it adds a permission-gated portal route, so
  > `tests/api/portal-permissions.test.ts` reads both tables and goes red when it does,
  > naming the decision. The real fix is a role that declares its audience; it costs a
  > migration and belongs with U1, when there is a portal screen to design it against.
  >
  > The API still ACCEPTS the pair, deliberately — which roles are portal roles is not a fact
  > the system records yet, and inventing that rule now would put it in the one place a firm
  > cannot change. `/admin/people` therefore says so plainly when the surface is Client portal
  > and the chosen role carries permissions, rather than filtering the dropdown and hiding a
  > real state from the admin looking at it.
- [x] `(A/B)` **T0.7** **The smoke script runs on Windows.** *Acc: `npm run smoke` reports 125 passed, 0 failed on a Windows checkout.*
  > `mktemp -d` returns a POSIX path; on Windows the `python3` on PATH is native Windows
  > Python, which cannot resolve `/tmp/tmp.XXXX`. Three `json.load(open(...))` calls raised
  > FileNotFoundError, `$LID` came back empty, every later URL became
  > `/api/v1/leads//stage`, no route matched, and **38 checks reported 403**. It reads as a
  > permissions failure and it is not one. Same family as `22ffaa1` (the arch test could not
  > spawn depcruise on Windows) — the second time a Unix assumption has cost real
  > investigation, so the rule is written beside `J=$(mktemp -d)`: **JSON reaches python on
  > stdin or as argv, never as a filename.**

- [x] `(B)` **T2.6** **P4 Scheduler** (pg-boss): recurring, due dates, triggers; spawns at T–X per config. *Acc: a monthly obligation spawns 12 instances a year out.*
  > **Done (2026-08-29) — and read the acceptance note: half of that line belongs to T3.2.**
  >
  > The engine's first moving part. A SECOND PROCESS (`npm run worker`), because compliance
  > work runs for months and pauses on a human decision, and that does not belong inside a
  > request. `npm run worker:once` runs the same sweep with no queue in front of it — a
  > different entry point, never a different rule.
  >
  > **The trigger half is complete and proven end to end.** `contract.activated` has been
  > emitted since T2.3; nothing consumed it, and `job.spawned` / `job.step_advanced` /
  > `job.completed` were registered verbs with no writer — the exact "feature that looks
  > finished" `CLAUDE.md` warns about. The scheduler reads the LEDGER for activations with no
  > job (an anti-join), so the commercial lane still has no idea an engine exists. **That
  > closes `(A)`'s T2.4** — see its entry.
  >
  > **The recurrence half is arithmetic, and its first consumer is T3.2.** `periodsFrom`,
  > `dueDateFor`, `internalTargetFor` and `runnableAtFor` are pure functions over ISO date
  > strings: twelve monthly periods a year out, quarters aligned to the FINANCIAL year
  > (Apr–Jun for India, not "three months from whenever you asked"), a due day clamped to a
  > short month, T–X never landing after the statutory date. 20 tests, no clock in any of
  > them. What does not exist yet is the `obligation_template` rows to run it over — that is
  > T3.2. **So the acceptance is met at the mechanism and not yet at the data**, the same
  > shape of honest partial T1.6 recorded, and it is stated here rather than ticked quietly.
  >
  > **Node 22 + pg-boss 12 — this affects `(A)` and the deploy target.** pg-boss needs
  > >=22.12 and the repo declared >=20; Node 20 left maintenance in April 2026, so CI was on
  > an unsupported runtime anyway. `engines`, the CI workflow and the tsup target moved
  > together.
  >
  > **Two decisions worth arguing with before changing them.** `delivery.job` is OURS and is
  > not pg-boss's row: pg-boss's is a delivery ATTEMPT, retried and eventually deleted, with
  > no tenant and no RLS; ours is a business fact that outlives every retry and is what T2.7
  > advances. And `UNIQUE (tenant_id, source_kind, source_ref)` is the whole design — every
  > trigger here is at-least-once, so the second attempt must CONFLICT rather than insert,
  > because a second job is a second set of tasks and eventually a second invoice.
  >
  > **Migration 0042 exists because of a privilege, found by RUNNING the worker.** pg-boss
  > issues `CREATE SCHEMA IF NOT EXISTS`, and PostgreSQL checks the database ACL BEFORE the
  > existence check — so it fails with 42501 even when the schema is already there. Granting
  > bib_app CREATE on the DATABASE would let the app role create objects anywhere, to buy a
  > statement that has nothing to do. So 0041 owns the namespace, `createSchema: false` stops
  > pg-boss trying, and bib_app has CREATE on that one schema. Every unit test was green
  > while this was broken; it only appears at worker start, in a process nobody watches.
  >
  > One read route (`GET /api/v1/jobs`), because **a write with no read is not a stored
  > fact** — nothing outside the database could otherwise confirm a signed contract produced
  > work. Read-only: advancing a job belongs to the orchestrator, and a route that could mark
  > work done without doing it is not a route.
  >
  > Gate: `check` 460 · `test:integration` 120 · `smoke` 130 — including the walk that signs a
  > two-line letter, sweeps, and gets **one job per engagement rather than one per letter**,
  > which is G0.1's "Per Company" rule showing up in the engine.
- [ ] `(B)` **T2.7** **P3 Orchestrator**: walks the step graph, resolves each step's executor (agent | human | agent-with-approval). *Acc: a 3-step graph advances step to step, sequential + parallel + branch.*
- [ ] `(B)` **T2.8** **P5 Agent-runtime seam**: executor abstraction + `confidence_tier` rows; guardrail hooks (no auto-commit above tier). *Acc: a fake executor commits >0.95, queues 0.70–0.95, escalates <0.70.*
- [ ] `(B)` **T2.9** **P6 Verification queue**: routing role→skill→tier→load→SLA; **maker≠checker as a CHECK constraint**. *Acc: the actor who produced an output cannot be its approver (DB rejects it).*

**Milestone M2:** a signed engagement letter automatically spawns jobs that walk a configured step graph and land in a verification queue — the **engine runs end-to-end** with fake executors. *(This is the demoable core spine.)*

---

## Phase 3 · Close the loop  (~4–6 weeks)

### Lane B — delivery
> **G0.1 has landed (2026-08-28, migration 0018).** Every line, engagement and
> `contract.activated` event now carries `entity_party_id`, so this lane has the join it keys
> on. Note the dev-database reset it requires — see G0.1.

- [ ] `(B)` **G3.2** **Client ownership — `client_assignment`.** New tenant-scoped table: `client_party_id`, `role` in `key_manager` | `spoc`, `module_id` (the Dept for a SPOC, null for a key manager, enforced by CHECK), `user_id`, `valid_from` / `valid_to`. *Acc: a client has one Key Manager and one SPOC per Dept, effective-dated, and "who was SPOC in March" is answerable.* — **§4.2. T3.1's own acceptance line depends on this** — nothing else in the schema can answer "the client's Dept SPOC". Confirmed firm practice, not a guess: *"each client will de facto have two SPOC — one from TRC team and one from FRC team"*, and a client buying RAA work has three, which is why it is a row per Dept rather than two columns. Depends on G2.1 for `module`.
- [x] `(B)` **G3.3** **`staff_grade` + `membership.grade_id`.** The firm's own grade ladder, with `rank` and `is_active`. *Acc: the review rule "Manager or above" is one comparison against `rank`, and a grade the firm stopped promoting through stays readable.* — **§4.3.** `rank` exists because that is the whole routing rule the firm actually stated — one threshold, no skill matrix, no tier-and-load. `is_active` rather than `deleted_at`, and the distinction is deliberate: `deleted_at` means the row was a mistake, `is_active` means the firm has moved on — and a rung somebody once held is part of why they could approve something in 2026. Needed by T2.9's verification routing and T3.1's review step.
  > **Done (2026-08-28). Migration 0040 — the first in the `(B)` range.**
  >
  > **The board's own line was wrong and is corrected above.** It said *"the firm's nine grades, Article to Associate Director"*, which came from `seed-blocks.ts` — but that list is the ENGAGEMENT LETTER's team-composition prose ("Article: CA pursuing candidate who has cleared Intermediate Level"), not a hierarchy. The hierarchy the firm actually gave is **ten rungs, Analyst → Partner**, dated 22 Aug 2026 in `starter-pack.ts`, and confirmed by `scripts/import-staff.ts` — *"only the ten rungs the firm actually gave"* — which maps the real HR sheet designations onto exactly those ten. Those ten are what `DEFAULT_GRADES` holds and what 0040 backfills.
  >
  > **Six real designations are deliberately unranked**: Article, Intern, Trainee, Head, Public Relations Officer and CEO are all in use and none is placed by the hierarchy the firm sent (the demo's own S2, carried forward honestly). `membership.grade_id` is NULLABLE so those people are visibly ungraded rather than wrongly ranked — this is the value that decides who may sign off a statutory filing, and a plausible wrong rank is indistinguishable from a real one. **The admin screen is the answer to it**: a firm adds `Article` at the rank it chooses, and re-ranks the rungs above it, with no deploy.
  >
  > **Seeded at `createTenant`** through a `GradeLadderSeeder` port, exactly as roles are — a firm with no ladder is one where nobody meets the review threshold. One event for the whole ladder, not ten. `tests/staffgrade/seed-parity.test.ts` holds the build red until `DEFAULT_GRADES` and the newest seed migration agree, the same arrangement roles have.
  >
  > **`rank` is NOT unique and not contiguous.** Nothing compares within a rung, only across the threshold, so uniqueness would turn "insert Article below Analyst" into a renumbering of every row to buy an ordering guarantee nobody reads.
  >
  > **The composite key is the load-bearing part.** `(grade_id, tenant_id)` → `staff_grade (id, tenant_id)`: a foreign-key check runs as a system operation RLS does not filter, so an id-only reference would let one firm's membership hang off another firm's rung with every policy satisfied. Proven against real Postgres in `tests/staffgrade/ladder.integration.test.ts`.
  >
  > Five routes, all `tenant:admin` — list / add / edit (name AND rank) / retire / assign. Screens in `../bib-frontend`: new `/admin/grades`, and a grade column plus picker on `/admin/people`. Building them found nothing new in the API, which is the first time that has happened — the read-model rule was applied up front (`MemberRecord.grade` carries the name and rank, never the uuid).
  >
  > **One real bug the smoke walk caught that the tests did not:** `api/domainerr.ts` had no mapping for `StaffGradeError`, so every refusal answered 500 instead of 400/404/409. Unit tests assert on the thrown sentinel and are perfectly happy; only an end-to-end request sees the status code. A new error family needs a line in that file.
  >
  > Gate: `npm run check` 421 tests · `test:integration` 105 · `smoke` **125 passed, 0 failed**.
  >
  > **CORRECTION, and it matters because the first version of this note sent somebody to the wrong place.** This entry originally recorded 38 failing smoke checks in sections 7–9 (leads, proposals, engagement letters) as pre-existing breakage in `(A)`'s lane. **That was wrong. Nothing was broken in either lane.** The smoke script fed `python3` a `mktemp -d` path, and on Windows the `python3` on PATH is native Windows Python, which cannot resolve `/tmp/tmp.XXXX` and raises FileNotFoundError. `$LID` came back empty, every later URL became `/api/v1/leads//stage`, no route matched, and thirty-eight checks reported **403** — which reads exactly like a missing permission and sent the investigation into the authorization code twice. Fixed by passing JSON to python on stdin or as argv, never as a filename; the reasoning sits beside `J=$(mktemp -d)` so the next person does not rediscover it. **`(A)` should not spend any time on those 38.**
- [ ] `(A)` **G3.4** **`membership.party_id` — the login-to-person link.** *Acc: "escalate to this assignee's manager" resolves through the org chart.* — **§4.3.** On `membership` and not `user_account`, because `party` is tenant-scoped and `user_account` deliberately is not: the same human may hold logins at two firms and is a different party in each. Nullable both ways — a portal user is not staff, and most of a firm has a place in the chart and no login. This is **Gate 4 (record-scope)**, which T1.6 deferred to U1; it is pulled forward here because `(B)`'s escalation ladder needs it before the portal does. **Agree the timing rather than assuming it.**

- [ ] `(B)` **T3.1** **Work items**: `work_item` + `checklist_item` + `work_item_dependency` + `approval`; states/priorities as **rows not enums**. *Acc: a filing arrives pre-assigned to the client's Dept SPOC.*
  > Blocked on **G3.2** (the SPOC the acceptance names) and **G2.3** (`slaDays`, snapshotted at creation so a catalogue revision cannot make finished work retroactively late). From the demo, worth carrying across: `is_statutory_due` is what makes priority derivable — *"due dates that are statutory should anyway be high priority"* — and `blocked_reason` + `blocked_at` are the capture-or-lose pair, because "Blocked" as a state records that work is stuck and never why, and a year later "are our delays ours or the client's" has no query that can answer it.

- [ ] `(B)` **T3.2** **Obligations — the compliance calendar.** `obligation_template` → `obligation_instance`, statutory **and** internal-target dates, T–X lead time, financial-year periods. *Acc: an Indian quarter is Apr–Jun; March TDS exception resolves to 30 Apr; a monthly obligation spawns twelve instances a year out; re-running the generator changes nothing.*
  > **The one idea that makes this work: an obligation is not a task.** The obligation is what the LAW requires of the ENTITY — Kaveri Foods must file GSTR-3B for August by 20 September. The task is what somebody at the firm must DO about it. Merge them and the calendar can never be generated, only typed in by hand, which is the exact Excel work being replaced. Nobody adds a row to this calendar: it falls out of which entities exist, what each bought, and what the law says about that combination. If a human could add an entry, the calendar could drift from the law — and then it is Excel again, only now inside Postgres.
  >
  > **DECIDED (both devs): obligation templates keep their own tables, not a config-registry kind.** `CLAUDE.md` prescribes the registry for a template or a rule pack, and it was weighed and set aside — the generator queries these rules rather than reading one at a time, the exception rows want a real foreign key to the rule they modify, and this shape is proven: it ran in the demo and generated a real calendar. **The cost, stated rather than discovered later:** the registry would have supplied versioning, publishing, freezing and pinning for free. So `rule_pack` (e.g. `gst-in@2026.07`) and `status` are not decoration — a revision must be a NEW template row rather than an edit, an instance must pin the version that produced it, and a superseded row stays readable. Without that, *"why was this due then?"* is unanswerable. **This deviation gets written into `CLAUDE.md` with its reasoning** — the repo's own rule is that a rule that seems wrong is a design conversation landed with its reasoning, never a quiet exception.
  >
  > **The pieces**, from `10xcrm/src/db/schema/obligation.ts` and `10xcrm/src/worker/` — worth re-reading before designing anything:
  > - **`obligation_template`** — `jurisdiction`, `entity_type` (null = every type, the common case: GST does not care what shape the company is), a nullable `service` link, `name`, `authority`, `recurrence`, `fiscal_year_start_month`, the due rule (`day_of_month` with month-offset + day, or `days_after`), `lead_time_days`, `rule_pack`, `status`, `is_active`. Two due-rule kinds cover everything known so far and both are DATA, not a formula string. A third is deliberately absent: India's QRMP scheme is conditional, and inventing a condition language before seeing a real condition produces the wrong abstraction — when one arrives it becomes a column, not a rewrite.
  > - **Everything seeds `unconfirmed`, India included.** Those dates came from a previous vendor's document, and the firm's own practice may be earlier than the statutory date. A due date is a RULE, a wrong one costs the client a penalty, and a plausible-looking wrong rule is the dangerous kind precisely because nobody re-reads it. Confirming one is an `UPDATE`, not a migration.
  > - **`obligation_instance`** — keyed on **`entity_party_id`** (G0.1's column: a client with four companies owes four sets of filings), `period_start` / `period_end` / `period_label`, **two dates**, a nullable `engagement_id`, a `work_item_id` once T3.1 exists. `UNIQUE (template_id, entity_party_id, period_start)` is what makes the generator safe to re-run — and it will be re-run, every month, forever.
  > - **The two dates are the point of the whole table.** `statutory_due_on` is what the law says and missing it is the client's money. `internal_target_on` is T–X, the firm's own, and it is the one the escalation ladder watches — because finding out you are late on the day you are late is useless.
  > - **`obligation_template_exception`** — a row against the rule, keyed by the month the filed PERIOD ends in, carrying the same due-rule shapes plus a mandatory note. March TDS is due 30 April while the other eleven months are due on the 7th. A template holds one formula, and reading only the normal half produces a rule that is right eleven months a year and quietly wrong every April — the worst available failure, because nobody re-reads a date that looks right and the cost lands on the client. **Not a condition language:** the firm said its only exceptions are month-based and only on TDS.
  > - **States as ROWS**, with `is_terminal` and `needs_decision` flags, because the vocabulary is unconfirmed and renaming one should be an `UPDATE`.
  > - **Generation scope — DECIDED: only where an engagement exists.** The CRM reading, *"track our work"*. Keep `engagement_id` nullable anyway so the compliance-engine reading (*"track their compliance"*, where every uncovered obligation is a sales lead) stays a config change rather than a migration. The firm has not been asked which it ultimately wants.

- [ ] `(B)` **T3.3** **Missed-deadline state**: past statutory date → partner decision queue (provisional filing vs late fee), logged. *Acc: a missed deadline is a state, not an error; partner choice writes an event.*
  > **The decision AND its reason are both recorded** (`resolution`, `resolution_reason`, `resolved_at`). In a CA firm this moment is where money and liability are decided, and today it happens on WhatsApp and is written down nowhere. The reason is the capture-or-lose half: in eighteen months nobody remembers why a late fee was accepted rather than a provisional filing made, and that is exactly the thing worth knowing. Writes `obligation.missed`, then `obligation.filed` or a resolution.

### Lane A — money & documents
- [ ] `(A)` **T3.4** **C6 Invoicing**: **gapless per-entity series** (trigger-frozen), IRN field, `invoice`/`invoice_line`, balance is a sum. *Acc: numbers cannot be edited; a gap is impossible under concurrency.*
- [ ] `(A)` **T3.5** **Payments + dunning**: `payment`, `credit_note` (reason CHECK), ladder D+3/D+7/D+15 → terminal (credit hold/legal, partner sign-off). *Acc: worker climbs the ladder; terminal needs partner approval.*
- [ ] `(A)` **T3.6** **P8 Documents + P9 client data**: `document`/`document_version`/`document_link` content-hashed, storage **port**; every byte via RLS-checked route. *Acc: a doc attaches to any object; no pre-signed URL escape.*
- [ ] `(A)` **T3.7** **C7 dashboards** (read models): MRR, DSO, ageing by client/service/owner. *Acc: figures reconcile to underlying rows, not cached columns.*

**Milestone M3:** full compliance cycle (spawn → work → verify → file → invoice → collect) runs with humans in the loop; money is gapless and auditable.

---

## Phase 4 · Agents A1–A11  (~5–7 weeks) — guardrails first, then capabilities

Runtime guardrails (from T2.8) must hold for **all**: never commit above tier · never
contact a regulator autonomously · never invent data (flag, don't fill) · every action →
P7 with confidence · can't approve own output.

- [ ] `(B)` **T4.1** **A4 Computation** (deterministic, code not LLM): GST/TDS/payroll/challans, reproducible. *Acc: recompute delta = 0.*
- [ ] `(B)` **T4.2** **A7 Reconciliation**: ledger↔books, payment↔invoice matching. *Acc: no force-match; unmatched ages into a queue.*
- [ ] `(B)` **T4.3** **A3 Rule-Match**: facts → section/rate/form/due-date from **versioned** rule pack + confidence. *Acc: refuses to answer outside its pack version.*
- [ ] `(B)` **T4.4** **A8 Chaser**: reminder ladders (T–3 daily, D+3/7/15), portal asks, escalation. *Acc: respects ladder config; stops on escalation freeze.*
- [ ] `(B)` **T4.5** **A9 Monitor** (no human trigger): SLA timers, T–X countdowns, stale items, reassignment triggers. *Acc: alerts + spawns tasks only, never acts itself.*
- [ ] `(B)` **T4.6** **A10 Rule-Pack Watcher**: reads CBDT/CBIC/MCA notices → drafts version diffs for approval. *Acc: never auto-activates a version.*
- [ ] `(A)` **T4.7** **A1 Intake**: OCR, classify, extract, dedupe, attach. Extraction **port** with deterministic fake. *Acc: ambiguous doc routes to human, isn't discarded.*
- [ ] `(A)` **T4.8** **A2 Enrichment**: MCA/GST/public lookups → fill record, flag conflicts. *Acc: never overwrites human-entered data.*
- [ ] `(A)` **T4.9** **A5 Drafting**: returns, proposals, letters, DD reports, query responses. *Acc: sends nothing externally; asserts no unverified fact.*
- [ ] `(A)` **T4.10** **A6 Validation**: completeness, cross-checks vs books/prior periods, anomaly scan. *Acc: flags only, never fixes.*
- [ ] `(A)` **T4.11** **A11 Context Writer** (pgvector RAG): approved positions/outcomes → per-client context, **hard tenancy wall**. *Acc: cross-client retrieval is impossible (RLS-filtered vector search).*

**Milestone M4:** the confidence-routed autonomy loop works — agents draft, machines check, humans approve, everything scored and logged.

---

## Phase 5 · Service packs S1–S6  (~4–6 weeks) — mostly config + connectors

Each pack = rule-pack rows + step-graph config + pack-specific connectors + screens.
They parallelize heavily because the engine already exists.

- [ ] `(A)` **T5.1** **S1 Market entry** (incorporation): SPICe+/name-check/PAN-TAN-GST, CS-approval gate. *Acc: flow ends by arming the compliance calendar.*
- [ ] `(B)` **T5.2** **S2 Managed services** (recurring compliance — the volume engine): TDS/GST/PF/ESI/ROC packs. *Acc: statutory dates drive spawns; T–X lead times honored.*
- [ ] `(A)` **T5.3** **S3 Deals**: DD checklist, data room, SHA/SSA markup, CP/CS tracker, rights monitor. *Acc: CP/CS chased like statutory deadlines.*
- [ ] `(B)` **T5.4** **S4 Audit**: query-loop pattern, working papers, deadline calendar. *Acc: positions stored for cross-year consistency.*
- [ ] `(B)` **T5.5** **S5 Litigation**: same query-loop engine, hearings/submissions. *Acc: reuses S4 engine + a rule pack, not new code.*
- [ ] `(A)` **T5.6** **S6 Exit / M&A**: data room from stages 1–5, buyer Q&A, closing, post-closing obligations. *Acc: data room assembles from existing indexed docs.*

---

## Phase 6 · Client portal (U1) + polish  (~4–6 weeks)

**UI does NOT start here.** The staff workspace (U2) is built **vertically from ~week 4** —
each dev skins their own modules as the API stabilizes (the T6.1–T6.4 tasks below land during
Phases 2–5, not now). This phase is the **client-facing portal (U1)** and cross-app polish.

### U2 · 10X workspace (staff) — built vertically during Phases 2–5, tracked here
- [ ] `(B)` **T6.1** App shell, auth'd nav, work board (Kanban), verification queue screen. *(with Ph2–3)*
- [ ] `(A)` **T6.2** Client 360 (as-of date), leads pipeline, proposal/EL builder. *(first screen ~week 4–5, with Ph1–2)*
- [ ] `(A)` **T6.3** Invoicing + collections screens, leadership dashboards (MRR/DSO/ageing). *(with Ph3)*
- [ ] `(B)` **T6.4** Compliance calendar + rules screen (config a partner can edit — the "row with a screen" bar). *(with Ph3)*
  > The calendar view, the partner's decision queue (T3.3), and a rules page a partner can actually use — **including confirming an `unconfirmed` rule**, which is what makes T3.2's seeding honest rather than a permanent asterisk. *Acc: a partner changes a due-date rule without a deploy, and the screen shows which rules the firm has not yet confirmed.* Config held as rows is only half the promise if editing it still needs a developer — that is the "row with a screen" bar. The demo's `10xcrm/src/app/calendar/rules/` is 627 lines and is the working spec.

### U1 · Client portal (client) — the real Phase 6 work
- [ ] `(A)` **T6.5** Invite + secure login, per-contact roles, status home.
- [ ] `(A)` **T6.6** Action centre: uploads (virus-scan/OCR/auto-file), questions, one-tap approvals.
- [ ] `(B)` **T6.7** Self-serve library (docs/challans/invoices), proactive nudges, monthly digest.

**Milestone M5 (Sellable V1):** both UIs at MVP over the full backend, 2–3 service packs live, core agents on, integrations faked.

---

## Phase 7 · Real integrations P11 — EXTERNAL-GATED, own track

Built as ports (fakes already exist). Each real adapter starts when the client grants
sandbox access + credentials. **Not on any demo's critical path.**

- [ ] `(B)` **T7.1** GST / GSP + TRACES (filing, IRN e-invoicing).
- [ ] `(B)` **T7.2** MCA (RUN, SPICe+, AGILE-PRO) — RPA if no API.
- [ ] `(A)` **T7.3** Accounting: Zoho / Tally / QuickBooks / Xero (books pull at T–3).
- [ ] `(A)` **T7.4** Banking feed (payment reconciliation), payments (Razorpay/Stripe).
- [ ] `(A)` **T7.5** E-sign (DocuSign/Zoho Sign), email (Gmail/M365), WhatsApp (P10 transport).

---

## Known-open security work

- [x] **Rate limiting** — done. Two limiters that defend different things: the edge keys on
  client address (10/min on the sign-in routes, 300/min elsewhere), the identity use case
  keys on the ACCOUNT (10 password attempts/hour, 3 sign-in emails/hour), because a botnet
  spreads across addresses but cannot spread which account it is attacking. Plus a
  concurrency cap of 6 on scrypt, bounding hash memory to ~192 MB however the requests
  arrive. *Limitation, by design:* the store is per-process, so behind N pods every limit is
  N times looser — it is a port, and Redis replaces it when there is a second pod.
- [x] **`/internal` authorization** — done. Each caller has its own key with its own
  capabilities (`tenant.provision` / `user.provision` / `membership.grant` /
  `credential.set`), enforced from one deny-by-default table, so a provisioning route with
  no entry is refused to every key. `credential.set` grants a login as somebody, so boot
  refuses it sharing a key with any other capability in a production-like environment —
  it is the step that completes the escalation path. Provisioning events now carry
  `provisionedBy`, because "system did it" cannot be traced to a system.

- [x] **`/auth/me` carries the caller's permissions** — done. It also documented only four of
  the six fields it was already sending (`role` and `commercialVisibility` reached the wire
  undocumented for six tasks, because the handler forwarded the domain Principal and
  zod-openapi documents a response without validating it). Handlers now map field by field,
  and `tests/api/openapi.test.ts` compares the spec's Principal against what the route
  actually sends. The frontend gates its admin links on the permissions rather than showing
  them to everyone.

- [x] **Lead reads name their prospect** — done, same pass. `GET /api/v1/leads` returned
  `partyId` and `ownerUserId` and nothing renderable; it now returns a joined read model, the
  shape the roster already uses. The owner carries an email as well as a name, which is the
  first real answer to the staff-directory question the roster's admin-only read deferred —
  revisit the two together when a directory screen exists.

- [ ] **Response shapes are documented but not VERIFIED.** zod-openapi describes a response
  without validating it, so a handler can send a field its schema never mentions — which is
  exactly how `/auth/me` shipped two undocumented fields for six tasks. One test now checks
  that route; nothing checks the other thirty. A general assertion — every route's response
  parsed against its own schema in strict mode — would close the class rather than the
  instance. Found the hard way (2026-08-28).

- [x] **Composite tenant keys across `core`** — done, and this line was **stale for eight
  tasks**. Migration **0015** swept all six references (`core.organization`, `core.person`,
  `core.legal_entity`, `core.party_identifier` and both ends of `core.party_relationship`)
  and `tests/architecture/tenant-keys.integration.test.ts` has asked the catalogue about them
  ever since. The board said open; the schema said closed. Verified against the live
  catalogue before ticking, not against this file.

  **What was actually still open is the GUARD, and it is now fixed.** The test held the
  schema list as a five-name array — `core`, `crm`, `config`, `tenancy`, `ledger` — under a
  comment asking the next person to extend it. Nobody did: **T2.6 created `delivery` and the
  array still said five**, so `delivery.job` sat outside the check from the day it existed.
  Nothing was crossed, but the guard was not what made that true. The schemas are now
  DERIVED the same way the constraints are — any schema holding a table with a `tenant_id`
  column is tenant-scoped by definition — with only the catalogue schemas and `pgboss`
  excluded, and the exclusion's reason written beside it.

  A derived guard has one failure mode a listed one does not: **matching nothing and passing
  vacuously**, which still reads as coverage. So a second test asserts the discovery itself
  finds all six schemas before the rule is applied at all. Both were proven by a negative
  control rather than by going green — a table with an id-only FK, created in a schema that
  did not exist when the guard was written, turned the build red and named itself.

## From the demo, deliberately NOT on this board

Everything below existed in the approved demo and is scheduled nowhere here. Listed so nobody
has to re-derive whether it was forgotten. Each needs a yes or a no rather than silence.

| Thing | Why it matters | Whose call |
|---|---|---|
| `notification` (in-app inbox) | The firm asked for it directly — *"email aur in-app — in-app kar do abhi"*. In neither the schema nor this plan. | A/B |
| `brand_asset` (logo, signature image) | PDF generation cannot ship without it, and PDF is not scheduled either. | A |
| `communication` (email / WhatsApp threading) | T4.7 (A1 Intake) has nothing to attach to without it. | A |
| `credit_note.reason` mandatory | Carry the CHECK across when T3.5 lands. Without it revenue leakage is invisible — the numbers always reconcile; *why* 40,000 came off does not. | A |
| Maker ≠ checker as a CHECK constraint | Already T2.9's acceptance. Named here only so it is not quietly downgraded to a service rule — a rule in a form is one a script, an import or an agent walks straight past. | B |
| Gapless invoice numbering | Already T3.4's acceptance, and the mechanism is named correctly there (a locked counter row, not a sequence — a sequence keeps its number on rollback and burns 41 forever). | A |
| AI `proposed` kept beside `applied` | Phase 4. Keeping only the corrected value is the obvious thing to do and throws the entire accuracy signal away. | B |
| Lead `expected_value` / `expected_close_on` | **Not a regression** — neither system had it. A suggestion: nothing anywhere forecasts a pipeline, and the table is young. | A |
| Client lifecycle (`onboarded_on`) | **Not a regression.** Derivable by walking `party_relationship('client_of')`; probably a view, not a column. | A |

---

## Parking lot / decisions to make (don't build on guesses)

- Dev vs QA cloud DB strategy (recommended: local seeded-from-cloud + shared QA). *Deferred by user.*
- zod 3 → 4 migration (unlocks `@hono/zod-openapi@1.x`) — own commit, later.
- Product name; which prior-vendor data (if any) migrates.
- Real-integration access: which portals/sandboxes the client can grant, and when.
- ~~**Migration ranges**~~ — settled: `(A)` 0018–0039, `(B)` 0040+. `(A)` has taken **0018**.
- ~~**G0.3** — soft delete on `core`~~ — **settled (2026-08-28): parties are permanent.** No
  `deleted_at` anywhere in `core`; `core.party.archived_at` (0035) hides a party from pickers and
  nothing more, and the decision is a paragraph in `CLAUDE.md`. Left open by it, and found by
  review rather than by building: **the refusal is archive-time only.** Nothing stops a NEW
  reference being created against an already-archived party — lead capture's `resolve()` matches
  on identifier without consulting `archived_at`, so a capture carrying an archived party's PAN
  attaches to it. Nothing renders blank (reading one party by id never filters), so this is a
  state the design says should not exist rather than corruption. The invariant the schema actually
  holds is *"nothing pointed at it at the instant it was archived"*, which is weaker than the
  `CLAUDE.md` paragraph reads. Decide later whether capture should refuse an archived party or
  quietly unarchive it — both are defensible and neither should be guessed.
- **G3.4** — pull `membership.party_id` forward from U1, or make `(B)`'s escalation wait.
- **G1.1** — the document reference generator: per entity per year, or one continuous series.
- ~~**G0.1** — must an EL line name an entity the firm has already incorporated?~~ **Settled
  (2026-08-28): no.** The key stays on `core.party`, and Incorporation is why. That service
  sells the CREATION of the entity, so a letter for it has no `legal_entity` row to name yet
  — the firm records a `proposed` organization party, the line names that, and the
  `core.legal_entity` row is added to the SAME party once the company exists. The entity
  therefore keeps one identity from quote to compliance calendar. Tightening the key to
  `core.legal_entity` would make an Incorporation engagement letter unwritable, which is the
  opposite of the trade it looked like.
- ~~Where obligation templates live~~ — **settled**: their own tables, owned by `(B)`. See
  T3.2. The versioning the registry would have given free is now built by hand, and the
  deviation is written into `CLAUDE.md`.
