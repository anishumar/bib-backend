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
| **Sellable V1** | + billing, obligations, 2–3 service packs, **client portal + the Chaser**, both UIs at MVP, integrations as fakes — **agents still stubbed** (reordered 2026-09-01) | **5–7 months** |
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
- **THE CLIENT SIDE IS `(B)`'s, WHOLE (2026-09-01).** The portal is not a screen bolted onto
  somebody else's module — it is a second AUDIENCE over the same records, with its own access
  gate (Gate 4), its own identity model, and its own chasing loop. Splitting it across two
  lanes would split that gate across two heads, which is the one place in this product where
  that is unaffordable. So `T6.5`, `T6.6`, `T6.7`, the Gate 4 half of `G3.4`, and `T4.4` (the
  Chaser that gives the portal something to ask for) are all `(B)`. `(A)` continues on the
  commercial lane and the two U2 screens still open there (`T6.2`, `T6.3`).

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
Phase 6  CLIENT PORTAL (U1) + the Chaser (T4.4) — (B) owns the whole client side      │  — each module ships its screen when its  │
   ↓                                    │  API stabilizes (~week 4 onward)             │
Phase 4  Agents A1–A11 (split A/B) — layered on the runtime, guardrails first         └─────────────────────────────────────────────┘
   ↓
Phase 5  Service packs S1–S6 (config + connectors, parallelized)
   ↓
Phase 7  Real integrations P11 — external-gated, its own track
```

> **THE ORDER CHANGED (2026-09-01): PHASE 6 RUNS BEFORE PHASE 4.** Decision by Shrestha, and
> the reason is what the firm is actually paying people to do today. Everything Phase 3 built
> makes the FIRM's own work visible; not one line of it reduces the hours the firm spends
> **chasing its clients** for documents, answers and approvals — which at a CA firm is where
> the manual time goes, and is what every competitor in this market leads with. The portal
> plus `T4.4` (the Chaser) closes that loop. Agents are the bigger technical bet and they get
> better inputs after a portal exists: a client who uploads through a portal produces the
> clean, attributed documents that A1 Intake and A6 Validation want, and a firm with no
> portal feeds those agents mailbox attachments.
>
> **`T4.4` moves INTO Phase 6 and keeps its id** — ids on this board are stable and a task
> that changes number is a task nobody can find in a commit message. Its line now sits in the
> Phase 6 block; Phase 4 keeps a pointer where it used to be.
>
> Milestones move with the phases: **M5 (Sellable V1) is now reached at the end of Phase 6
> with agents still stubbed**, and **M4 (the autonomy loop) after Phase 4**. That is the
> honest order — a sellable V1 that chases clients and has humans in the loop is a product;
> a set of agents with no client-facing surface is not.

---

## Migration numbering — agree this before either of us writes SQL

`0017` is the last applied migration. Two people adding migrations at once **will** collide on
`0018`, and a migration is immutable once applied anywhere, so a collision is not a rename —
it is one of us redoing the work under a new number.

**Proposed:** `(A)` takes **0018–0039**, `(B)` takes **0040+**.

> **`(A)` has taken 0018–0033, and 0034 is next.** One slip worth recording rather than
> quietly fixing: the dunning migrations were first written as `0030`/`0031`, and **`0030` was
> already `0030_lead_title_and_lost_reason`** (G3.1). The migrator keys on the full filename,
> so both would have applied and nothing would have broken — which is exactly why it would
> have survived review and confused whoever read the directory next. Caught before the branch
> was pushed and renumbered to `0032`/`0033`. **Check `ls migrations/` before choosing a
> number; the range is not a guarantee that the number inside it is free.** Cheap, and it makes the two
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
- [x] `(A)` **T2.1b** **Lead assignment**: round-robin over active staff behind an
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
  > **[x] Territory built (2026-08-29). Migration 0026, and the acceptance now holds in both
  > halves: a territory rule OVERRIDES the rotation, proven where the two answers differ.**
  >
  > **The axis was not a conversation nobody had — it was a MISSING COLUMN.** Every previous
  > note said "the axis has never been chosen with the client", which was true and hid the
  > concrete blocker: `crm.lead` held a title, a party, a source, a stage and an owner, so
  > whichever axis was chosen, there was nothing on a lead to match it against.
  >
  > **`lead.jurisdiction` earns its place even if territory is never switched on**, which is
  > what makes it the safe axis to commit to. Every other stage of this product already keys on
  > a jurisdiction — a proposal's issuing entity, a letter's own, a clause's scope, a standard
  > prose block's — and the pipeline was the only one that did not record it. Concretely:
  > `ProposalService.draft` TAKES `clientJurisdiction` and nothing supplied it, so a lead that
  > converted re-asked a question the firm had answered at capture, and the answer decides
  > which of the firm's own entities contracts. **This is still a choice a client can overrule**
  > — if the firm wants industry or service line instead, that is a second column and a second
  > rule table, and nothing here has to move.
  >
  > **A TABLE, not a registry kind** — `crm.territory_rule` is `firm_entity_preference`'s twin,
  > answering the same question of a different subject ("whose desk covers X" beside "which of
  > our entities serves X"). `UNIQUE (tenant, jurisdiction)` is the property that matters and a
  > registry kind cannot express it; its key must also be lower case, so a country code would
  > be stored in a case the rest of the product refuses.
  >
  > **NO WILDCARD ROW, and that is the difference from 0021.** A document that cannot name who
  > is contracting is not a document, so preferences need a `'*'` fallback. Assignment already
  > has a better one: the ROTATION. A lead from a country no rule covers goes to the emptiest
  > desk — a real decision, not a catch-all row somebody has to remember to maintain.
  >
  > **The port changed shape, and it had to.** `policy` was a FIELD on the strategy, read by the
  > service off `deps.assignment.policy`. That was right with one rule and became a lie with
  > two: a composite answers per LEAD, not per wiring, and the field would have labelled every
  > territory-decided capture `round_robin` — destroying the one thing `ownerAssignedBy` exists
  > for. `assign` now returns `{ lead, policy }`.
  >
  > **Ordering is the composition root's, not a branch inside a strategy.** `FirstMatchAssignment`
  > takes an array; the ORDER is the firm's precedence, stated once and visibly in `setup/`. A
  > third rule is a line there.
  >
  > **A rule NEVER overrules a person**, and a rule whose desk has gone declines rather than
  > parking leads where nobody sees them: the active-staff check is a JOIN inside the strategy's
  > own statement, not trust in the row, because a membership is revoked long after the rule was
  > written and no foreign key can express "active". Both checked — at write time by the service
  > and at assignment time by the query — and only the second sees a leaver.
  >
  > **One bug caught by the integration test the fakes could not:** the rotation adapter's
  > `RETURNING` list did not carry the new column, so a lead came back from assignment having
  > silently lost its jurisdiction. And `tests/api/openapi.test.ts` caught a second — the lead
  > handler's `toRecordBody` SPREAD the domain object under a comment claiming it named fields
  > one by one, which is the `/auth/me` bug exactly. Both fixed; the handler now lists its
  > fields.
  >
  > Gate: `npm run check` 727 · `test:integration` 226 · `smoke` **215 passed, 0 failed**.
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

- [x] `(B)` **G2.4** **Depts and delivery teams become the firm's own LISTS, and the firm says which one splits its work.** `tenancy.service_axis` (one table, `axis` in `dept`|`team`, code/name/order/`is_active`) + `tenancy.tenant.work_split_axis` in `none`|`dept`|`team`, default `none`. A service body still stores the CODE; the list is what that code is checked against, at the write. *Acc: `FINCOMPLIANCE` and `FIN COMPLIANCE` cannot become two teams; a firm renames a Dept without touching a published service version; a firm with neither layer is unaffected.* — **Not from build2.md. This task came out of designing T2.7**, and it is on the board because the alternative was to build the orchestrator on a field a typo can silently fork.
  > **Done (2026-08-29). Migration 0043 — `(B)` range.**
  >
  > **WHY THIS EXISTS.** G2.1 gave `ServiceBody` two axes — `module` (the Dept: FRC / TRC /
  > RAA) and `group` (the delivery team: FINCOMPLIANCE, VCFO CONSOLE, PAYROLL) — as free text
  > in canonical form. That was enough while they were only GROUPED BY on a dashboard: a split
  > revenue figure is wrong in a way somebody notices at month end. It stops being enough at
  > T2.7, where the orchestrator gives each group of an engagement's lines its own job.
  > `FINCOMPLIANCE` and `FIN COMPLIANCE` are BOTH canonical, they are one team to a person,
  > and they would silently become two jobs — one client's work split across two checklists
  > with nobody told. Not a report to correct at month end; work nobody is looking at.
  >
  > **THE PRODUCT DECISION, taken with `(B)`'s reviewer on 2026-08-29 and worth arguing with
  > before changing.** Neither layer is universal. A fifteen-person practice has neither; a
  > single-P&L firm has delivery teams and no revenue split; a multi-partner firm has the
  > opposite. So **which axis splits work is the FIRM's setting, not the product's rule** —
  > `none` is the default, it reproduces T2.6's behaviour exactly (one engagement, one job),
  > and merging this changed no firm's behaviour until somebody chooses. A default of `dept`
  > would have silently re-cut every future engagement on the installation to save one click.
  >
  > **ONE TABLE, NOT TWO.** The demo used `service_module` and `service_group` — structurally
  > identical, and here that would have meant two repositories, two services, two route sets
  > and two fakes, all free to drift. `axis` is a CHECKed discriminator, doing what
  > `config.entry.kind` and `delivery.job.source_kind` do: the ENGINE's vocabulary, the same at
  > every firm. What the firm owns is the rows.
  >
  > **`tenancy`, NOT `config`.** These read like catalogue metadata and are not: a Dept is the
  > firm's org structure. **This unblocks G3.2** — `client_assignment.module_id` needs a real
  > row to point at ("each client will defacto have two SPOC, one from TRC and one from FRC"),
  > which today it cannot have because a Dept is a string inside a frozen JSON body.
  > `staff_grade` (0040) is the same shape for the same reason and this table copies it.
  >
  > **THE BODY STILL STORES A STRING, and the obvious move is the wrong one.** Replacing
  > `body->>'module'` with a foreign key would mean rewriting PUBLISHED versions, and that
  > freeze is what lets a proposal sent nine months ago show the price it was sent at. So the
  > body keeps its code, the table is the list of codes it must be one of, and the check is at
  > the WRITE in the config use case (`AxisDirectory`, one adapter over one table serving both
  > use cases — declared twice as this codebase does, implemented once as T3.5 argued). A
  > rename therefore changes `name` and never `code`; a body naming a retired code still READS
  > and simply cannot be written again.
  >
  > **HONEST PARTIAL — SAY THIS OUT LOUD.** `groupByAxis` is written, tested against the
  > firm's own three-service example, and **has no caller**: `work_split_axis` is a setting
  > nothing reads yet, because the thing that reads it is T2.7. That is exactly the "feature
  > that looks finished" shape `CLAUDE.md` warns about — a registered verb with no writer — so
  > **the screen says so in as many words** ("Not in effect yet… until then every signed
  > engagement produces one job, whatever is chosen here"). T2.7 is what makes it true.
  >
  > **AND A SECOND THING NOT CLOSED.** A firm with NO rows on an axis is checked against
  > nothing on that axis — the field behaves exactly as before this task. That is deliberate
  > (a list the firm has never written is not a list to validate against, and a brand-new firm
  > must not be made to fill in an org chart before it can file a service), and it is why the
  > smoke walk still passes unchanged. The residue: a firm that files services under free text
  > and only LATER writes its list keeps whatever it published, because published bodies are
  > frozen and nothing rewrites them. Those services still GROUP correctly — T2.7 groups by the
  > code itself — they just have no row to take a display name from. Re-publishing one forces
  > the fix. The picker offers such a code marked "no longer on this firm's list" rather than
  > blanking the field, because a form whose submit rewrites the whole body would otherwise
  > drop a Dept nobody meant to drop.
  >
  > **Two roads to one broken state, both closed.** Choosing an axis whose list is empty is
  > refused, and so is retiring the last active row on the axis already chosen. Closing only
  > the first leaves the second open, and the second is the one somebody actually walks — a
  > firm restructures by retiring rows one at a time.
  >
  > **Screen built alongside**, as the rule says: `/admin/structure` — both lists, retire and
  > restore, and the split chooser with an empty list's option DISABLED and the reason beside
  > it. `/catalogue`'s two text boxes became pickers, and stay text boxes for a firm with no
  > list, because that is the API's actual rule rendered honestly rather than a disabled empty
  > dropdown claiming the service cannot be filed.
  >
  > Gate: `npm run check` **837** · `test:integration` **268** · `smoke` **227 passed, 0
  > failed** (unchanged — the point of the `none` default). Plus a scripted HTTP walk of all
  > five routes on a freshly seeded firm: empty-list refusal, `frc`→`FRC` normalisation, the
  > cross-axis code that is allowed, the split becoming choosable once a list exists, an
  > unknown Dept refused 404 and a retired one 409, and nine structure events in the ledger
  > carrying codes and never display names.
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
  > **Superseded in part by G2.4 (2026-08-29):** "one job per engagement" is now the
  > behaviour of `work_split_axis = 'none'`, which is the default and what every existing firm
  > has. A firm that chooses to split by Dept or delivery team gets one job per group instead,
  > from T2.7. `UNIQUE (tenant_id, source_kind, source_ref)` is what T2.7 has to widen, and
  > that is stated here so it is found from the task that set the rule.
  >
  > One read route (`GET /api/v1/jobs`), because **a write with no read is not a stored
  > fact** — nothing outside the database could otherwise confirm a signed contract produced
  > work. Read-only: advancing a job belongs to the orchestrator, and a route that could mark
  > work done without doing it is not a route.
  >
  > Gate: `check` 460 · `test:integration` 120 · `smoke` 130 — including the walk that signs a
  > two-line letter, sweeps, and gets **one job per engagement rather than one per letter**,
  > which is G0.1's "Per Company" rule showing up in the engine.
- [x] `(B)` **T2.7** **P3 Orchestrator**: walks the step graph, resolves each step's executor (agent | human | agent-with-approval). *Acc: a 3-step graph advances step to step, sequential + parallel + branch.*
  > **CORRECTION (2026-08-29), and it was mine.** The line above previously said T2.7 would
  > turn "one job per engagement" into "one job per (engagement, group)". **That is backwards**,
  > and reading the code rather than the board is what found it: `crm.engagement` carries
  > `UNIQUE (engagement_letter_line_id)` — one engagement per LINE — so a letter with three
  > service lines already becomes three engagements and three jobs. Grouping therefore MERGES
  > jobs; it does not split them. Nothing built for G2.4 is wrong because of this — the lists,
  > the setting and `groupByAxis` are all unaffected — only what the grouping is applied TO.
  >
  > **And the grouping key is `(entity, team)`, never the team alone.** Confirmed with `(B)`'s
  > reviewer on 2026-08-29: merging across legal entities would break the firm's own
  > client-confirmed "Per Company" rule (G0.1), under which vCFO for four companies is four
  > engagements because each company files its own returns. So work is merged WITHIN one
  > entity and never across.
  >
  > **G2.4 is the prerequisite and is DONE.** The rule needed the axis to be a list a typo
  > cannot fork, and `groupByAxis` (`domain/serviceaxis/model.ts`) is already written and
  > tested against the firm's own three-service example — including that an unfiled line joins
  > a `null` bucket rather than being dropped. **T2.7 is its first and only caller**, and until
  > it lands `work_split_axis` is a setting nothing reads; `/admin/structure` says so on the
  > screen.
  >
  > ── **DONE, EXCEPT THE MERGE. Read this whole block before ticking it.** ────────────────
  >
  > **The acceptance is met.** A three-step graph advances step to step, and sequential,
  > parallel and branch all work — proven by 69 unit tests, 16 integration tests, and an
  > end-to-end walk on a real firm where a partner wrote a four-step process, the worker
  > pinned it and wrote the rows, a person ticked a step off, the conditional step SKIPPED
  > with its reason, and the ledger recorded all of it.
  >
  > **What is NOT done: the grouping/merge.** `groupByAxis` still has no caller, and one
  > engagement is still one job. That was scoped INTO this task and is not finished, so the
  > box is `[~]` and not `[x]`. It is the next thing, and it is now well specified: merge an
  > engagement letter's engagements by `(entity_party_id, axis code)`, widen
  > `delivery.job`'s `UNIQUE (tenant_id, source_kind, source_ref)`, and settle the one
  > question it raises — what happens when the services in a merged group name DIFFERENT
  > workflow templates.
  >
  > **Migrations 0044 (`job_step` + the registry's sixth kind) and 0045 (`work:write`).**
  >
  > **THE TEMPLATE IS CONFIG, and that is the whole point of the task.** "How we do a GST
  > filing" lives in a partner's head today. `workflow_template` is the registry's sixth kind
  > — deferred at T2.5 on the stated grounds that a body designed against no consumer ends up
  > wrong, and built now because the consumer exists. The validator refuses a cycle, a
  > dependency on a step that does not exist, and a duplicate key, all at the WRITE, because
  > each of them produces a job that sits half-finished with nothing saying why.
  >
  > **THE GRAPH IS `dependsOn`, and all three shapes fall out of one rule.** A step is ready
  > when every step it depends on has SETTLED in a way that clears its dependents. Sequential
  > is a chain; parallel is two steps on one dependency; branch is a skip, and **a skip CLEARS
  > its dependents while a failure does NOT** — that difference is why there are two terminal
  > states and not one. The cascade is the other half: skipping only the conditional step
  > leaves everything downstream waiting forever.
  >
  > **AGENTS ARE OPTIONAL, AND THAT IS A PRODUCT DECISION, not a stopgap.** Taken with `(B)`'s
  > reviewer on 2026-08-29: the first goal is to get the work that happens in people's heads
  > and spreadsheets INTO the product, standardised. So `human` is the ordinary executor, a
  > firm can write its entire process with every step human and it runs today, and a step
  > becomes an agent's later by changing ONE field. The runtime consequence is stated as a
  > rule: **a template may say `agent` before any agent exists, and the job does not fail —
  > the step waits for a person.** `NoAgentsBuiltYet` is the honest implementation of a true
  > statement rather than a stub, which is why it is NOT gated on config the way the dev auth
  > resolver is: a firm running entirely on human steps is a supported permanent state.
  >
  > **TWO REAL BUGS, BOTH FOUND BY RUNNING IT** — neither by a unit test, which is the third
  > entry in this project's ledger of that lesson:
  >
  >   **The service was read at its PINNED version**, faithfully to how price and scope
  >   resolve — and it meant every engagement signed before a firm wrote its first process
  >   pinned a service version naming no template, so those jobs could never pick one up. A
  >   firm adopting this product with work in flight would watch its existing engagements wait
  >   forever while only new ones moved. The workflow key is read LIVE now: a client agreed to
  >   the service, not to our internal steps, and pinning already happens one level down where
  >   it belongs — the JOB pins the workflow version.
  >
  >   **`listRunnable` excluded `blocked`**, so a job waiting on a person vanished from the
  >   work board AND from the sweep. It would never be looked at again unless somebody
  >   completed a step through the one API path that advances inline. `blocked` is the
  >   commonest state a job is in.
  >
  > **A skipped step is kept and shown, never hidden.** `skipped` is not `done`: "we did not do
  > this, and here is why" is the question asked when a filing is questioned. The reason is a
  > column the schema INSISTS on for a skip and a failure and forbids everywhere else, because
  > the note is only ever written by somebody already in a hurry. The ledger carries the FACT
  > and its values rather than the prose — a sentence does not GROUP BY, and this log cannot
  > be erased.
  >
  > **AN UNRESOLVED FACT KEEPS THE STEP.** A service that never stated its recurrence must not
  > quietly lose a review step because a field was left blank. An extra review costs an hour; a
  > missing one costs a filing. Proven both ways end to end — the same template skipped the
  > step for a service that said `monthly` and kept it for one that said nothing.
  >
  > **`work:write` is a new permission and cost a migration (0045)**, exactly as CLAUDE.md
  > says a new permission does. Saying a filing is done is not reading the board, and the row
  > it gates is the record of WHO did the work — which is what T2.9's maker-checker rule will
  > compare. Partner, manager AND associate get it: an associate who could not tick off the
  > step they performed would have to ask somebody else to, putting a false name on the record.
  >
  > **`job_step.performed_by` exists and is unused by any rule yet.** Deliberate: T2.9 needs it
  > as a COLUMN to express maker != checker as a database constraint, and adding it later means
  > backfilling a fact nobody recorded.
  >
  > **Screens built alongside**: `/work` (the delivery board — the first screen this half of
  > the product has ever had; `GET /api/v1/jobs` had been a write with no read since T2.6) and
  > `/work/[jobId]`, which shows the process, marks a skipped step "not needed" with its
  > reason, says "waiting for you — no agent built for this yet" on an agent step nobody has
  > built, and has the Done button that makes the whole thing usable with zero agents.
  >
  > **The screen to WRITE a process is BUILT (2026-08-29, after the first pass).** It was the
  > honest gap here for a few hours and it closed for the reason it was a gap: an engine whose
  > only entrance is a curl command is not a product a firm can use, and `(B)`'s reviewer hit
  > exactly that within minutes of the first pass landing. `/admin/workflows` — write the
  > steps, say who does each and what it waits for, save as a DRAFT, and put a version in
  > force as a separate act (the catalogue's pattern, not the roles screen's: publishing
  > changes the path every future job walks). `/catalogue` gained the one field that connects
  > a service to a process, as a picker over PUBLISHED processes only — a draft is not in
  > force, and offering one would point a service at something no job will follow.
  >
  > Proven in a browser, not asserted: a process written on the screen, published, picked on a
  > service, and the row read back out of `config.version` carrying the key.
  >
  > **Still open, and it is a CLIENT question:** which facts a branch may test. The mechanism
  > is built and proven over `recurrence` and `jurisdiction` — two facts that already exist,
  > not guesses — and the closed set grows by adding a member, a case in the fact resolver and
  > a line of documentation. Asked of Sidharth; **answered on 2026-08-30, and the answer was
  > "not yet"** — *"I think this will be applicable only once we start using"* — with a
  > compliance-applicability spreadsheet attached that belongs to T3.2. `StepFact` was
  > therefore NOT extended.
  >
  > **The condition SHAPE was widened on 2026-08-30, and only the shape.** `{ fact, equals }`
  > became `{ fact, op, value }` with four operators — `equals`, `not_equals`, `in`, `not_in`
  > — all of which compare a string and all of which work on the two facts that exist. `in` /
  > `not_in` close a real gap: three jurisdictions needed three templates before.
  >
  > **`gte` / `lte` were deliberately NOT added**, even though the firm's spreadsheet makes a
  > threshold its commonest rule, because nothing stores a turnover to compare. The asymmetry
  > is the point: adding an operator later is backward compatible against a frozen body,
  > changing the shape later is not — so the shape moved the day the need was known and the
  > operators wait for T3.2's data.
  >
  > The legacy `{ fact, equals }` is frozen into every version published before this and
  > **still parses, forever**; `readStepCondition` normalises it so the evaluator sees one
  > shape. A bug was found writing this and it is worth knowing: the first `explain` was a
  > ternary chain, and an unrecognised operator fell through to the `not_in` arm and called
  > `.join` on a string — so a template naming an unknown operator crashed the sweep instead of
  > keeping the step. `compare` had already returned "keep" correctly; the EXPLANATION threw.
  > Found by the test written for exactly that case. `scripts/step-operators-walk.sh` proves
  > all four against a real job, plus the legacy shape beside them.
  >
  > Gate: `npm run check` **906** · `test:integration` **284** · `smoke` **229 passed, 0
  > failed** (unchanged — the smoke is at its request budget, so the engine is demonstrated by
  > `worker:once` and a scripted walk, which is how T3.5's ladder is demonstrated too).
  >
  > ── **THE MERGE, 2026-08-29 — and this is what closes the box.** ─────────────────────────
  >
  > **Migration 0046.** `groupByAxis` has its caller. One client, one company, one delivery
  > team, one letter, three services -> ONE checklist. Run against a seeded firm and watched:
  > FinCompliance's GST + TDS merged into one job, Payroll got its own, and the SAME client's
  > second company got its own FinCompliance job — the Per Company rule holding on screen.
  >
  > **The key is `(engagement_letter_id, entity_party_id, axis code, workflow key)`**, and
  > every part earns its place:
  >
  >   `entity_party_id` — the firm's own Per Company rule. vCFO for four companies is four
  >   engagements because each files its own returns. **The firm says three sub-companies get
  >   three separate LETTERS**, so within a letter the entity is normally constant and this
  >   looks redundant — it is not. `engagement_letter_line.entity_party_id` is per LINE and
  >   NOT NULL (0018), so the schema permits a mixed letter whatever the practice is. The key
  >   makes the rule hold rather than leaving the practice to hold it. **See the open question
  >   below: the demo repo records the OPPOSITE as a closed client answer.**
  >
  >   `engagement_letter_id` — a job has to be able to FINISH. Two letters months apart are
  >   two contracts; letting the second join the first's open checklist grows one job for the
  >   life of the client relationship.
  >
  >   the axis code — the firm's own `work_split_axis` (G2.4).
  >
  >   **the workflow key — the open question from the first pass, decided.** Two services
  >   naming two processes are two processes by the firm's own account; merging them invents
  >   an order nobody wrote over step keys that can collide. Degrades well: services on one
  >   team usually name one process or none, so the merge still happens, and "no process" is
  >   its own group. The cost is that a splitting firm can see two cards for one team — so the
  >   card names its process's team and lists its services, rather than looking like a
  >   duplicate.
  >
  > **A BUG IN `groupByAxis` ITSELF, found by wiring the caller.** Its `none` branch returned
  > ONE bucket holding everything, documented as "T2.6's behaviour, unchanged" — and it is the
  > opposite. T2.6 gives one job per ENGAGEMENT, so one bucket would have MERGED every line of
  > every letter for every firm on the default setting: the exact silent re-cut G2.4 promised
  > would not happen until a firm chooses. Eleven unit tests were green on it, because nothing
  > consumed it. `none` now merges nothing. **Third time on this project the consumer, not the
  > test, found the bug.**
  >
  > **TWO uniqueness rules, and they are not the same rule.** `job_engagement UNIQUE
  > (tenant_id, engagement_id)` is ABSOLUTE and forever — one engagement's work exists in
  > exactly one job, which is what stops a second set of tasks and a second invoice. The job
  > table's own key became PARTIAL (`WHERE status NOT IN ('done','cancelled')`): at most one
  > OPEN job per group, because a group whose checklist finished must be able to get a new one
  > when a later line's advance lands months later. Attaching new work to a finished checklist
  > is work nobody looks at again.
  >
  > **`job.scope_extended` is a new verb**, for the second line of a letter joining a
  > checklist already in flight. Proven live: first sweep opened the job, the second advance
  > was recorded, the next sweep said "nothing to spawn" and the ledger carries
  > `job.scope_extended` with ONLY the engagement that joined.
  >
  > **`source_ref` stops naming a row.** For a merged job it is the group key, derived (uuid
  > v5, its own namespace). Which is why **the work board no longer renders a uuid** — the old
  > comment there called that an outstanding gap; the merge made it unavoidable, since a
  > derived key is not even a uuid somebody could look up. `GET /api/v1/jobs` carries the
  > company, the client, the team and the SERVICE NAMES now, in one query for the page.
  >
  > **A THIRD BUG, found over HTTP.** `SchedulerError` had NO entry in `api/domainerr.ts` — it
  > had never been reachable, because the list route never looks a job up. The new
  > `GET /api/v1/jobs/{jobId}` is its first surface and answered **500 to an unknown job while
  > its own OpenAPI said 404**. Mapped. Same failure as `StaffGradeError`, third occurrence,
  > and CLAUDE.md already warns about it.
  >
  > **`GET /api/v1/jobs/{jobId}` also closes a real gap**: `/api/v1/jobs` lists only what is
  > RUNNABLE, so a FINISHED job's steps were readable with nothing saying whose work they were.
  >
  > **NOT done, and named rather than implied:** nothing re-cuts jobs that already exist when a
  > firm changes `work_split_axis` — that is the stated design (`G2.4`: changing it restates
  > nothing), and it means a firm that switches mid-year has two shapes of job on its board
  > until the old ones finish. No screen says so yet.
  >
  > **AND A CLIENT FACT IS IN DISPUTE — do not settle it from this file.** `(B)`'s reviewer
  > states that three sub-companies get three separate engagement letters. The pre-rebuild demo
  > records the OPPOSITE as a CLOSED question answered by the firm's owner — `docs/OPEN-QUESTIONS.md`
  > Q20: *"One EL."* One document, many entities bound by the parent's signature, which is
  > exactly why `entity_party_id` sits on the LINE and not the document. Both readings are
  > safe under this design, because the merge never crosses entities either way. It is on the
  > board because it decides whether the drafting screens should let one letter name several
  > companies, and that is `(A)`'s lane.
  >
  > Gate after the merge: `npm run check` **920** · `test:integration` **293** · `smoke`
  > **229 passed, 0 failed**.

- [x] `(B)` **T2.8** **P5 Agent-runtime seam**: executor abstraction + `confidence_tier` rows; guardrail hooks (no auto-commit above tier). *Acc: a fake executor commits >0.95, queues 0.70–0.95, escalates <0.70.*
  > **Done (2026-08-29). Migration 0047 — `delivery.agent_run` + `confidence_tier`, the
  > registry's seventh kind.**
  >
  > **A GUARDRAIL BUILT BEFORE THE THING IT GUARDS, and that is the order, not an accident.**
  > There are no agents. The product's plan is to get what firms do manually INTO the product
  > first — standardised and visible, which T2.7 finished — and only then replace some of it
  > with machines. So this task builds the rails while nothing is on them, exactly as the
  > board asks above Phase 4: **guardrails first, then capabilities**. A rule written after
  > the thing it restrains gets written by whoever is already shipping that thing, and this
  > rule decides whether a machine may file a return with the firm's name on it.
  >
  > **THE GUARDRAIL IS A CHECK, NOT A SERVICE RULE.** `build2.md` in the firm's own terms:
  > *"a rule that lives in a form is a rule that a script, an import or an AI agent walks
  > straight past."* Here the rule is ABOUT agents, so an agent walking past it is the
  > literal failure mode. A CHECK cannot read config, so **the thresholds that applied are
  > COPIED onto the run** — same move as `job.split_code` and `job_step.executor`, and it
  > buys the constraint AND the answer to "why was this allowed" surviving the firm raising
  > its bar next quarter. `guardrail.integration.test.ts` proves all of it as the OWNER role,
  > going around the application entirely.
  >
  > **`> `, NOT `>=`, AND IT IS LOAD-BEARING.** A machine acts unattended only STRICTLY above
  > the bar, which makes **1.0 a real off switch** — one edit stops every unattended commit,
  > with no deploy, on the morning somebody needs it. With `>=` no value would mean "never".
  >
  > **NOTHING IS SEEDED, and no firm's behaviour changed.** Roles and the grade ladder are
  > seeded because a firm without them is BROKEN. A firm without thresholds is not broken, it
  > is cautious: `ASK_A_PERSON` = `(autoCommitAt 1, reviewAt 0)`, expressed in the same two
  > numbers so nothing needs a special case. The discount policy's rule reached from the same
  > direction — *no published policy means ZERO, not "no limit"*.
  >
  > **THE FIRM'S OWN INSTRUCTION OUTRANKS THE NUMBERS**, which is why the 0.95/0.70 figures
  > were not a blocking client question. The real control is per step on the template —
  > `human` / `agent_with_approval` / `agent`, chosen by whoever knows what the step does —
  > and `agent_with_approval` NEVER commits however sure the machine was. `approval_required`
  > is stored on the run so the CHECK can express that, and so "was this queued because it
  > was unsure, or because we always check this step" has an answer. **The numbers are still
  > not the client's**: the demo says outright they *"come from another vendor's document and
  > the firm has never been asked"*. What the firm HAS confirmed is Q47 (closed 2026-08-21) —
  > unattended creation is wanted at all: *"Yes of course it should be created through AI, and
  > there should be a manual option too."* `SUGGESTED_TIERS` is exported, published
  > deliberately, and never seeded.
  >
  > **THE GAP THIS CLOSED, and it had been there since T2.7.** `agent_with_approval` was
  > blocked by `waitsForAPerson` BEFORE `agents.run` was reached — the machine produced
  > nothing and the person had nothing to approve, while the kind's own comment said "the
  > machine produces the output and a PERSON decides whether it stands". `runsAMachine` is
  > now a separate question from `waitsForAPerson`, because they are separate questions.
  >
  > **`proposed` AND `applied` BOTH SURVIVE, FOREVER** — `build2.md` §5.2, listed there as one
  > of the demo's hardest-won rules with no home yet. Two CHECKs keep the number honest rather
  > than merely collected: a `corrected` must ACTUALLY differ and an `accepted` must not.
  >
  > **`agent_run.completed` and `agent_run.escalated` were registered verbs with NO WRITER** —
  > the shape this codebase keeps catching. They have one now. `agent_run.decided` is new, and
  > carries WHICH of the three outcomes and never the values: accepted-vs-corrected is the
  > accuracy signal, and an agent's output can hold a client's own data in a log that cannot
  > be erased.
  >
  > **A FOURTH BUG FOUND BY RUNNING IT.** A correction identical to the proposal was refused by
  > the CHECK and reached the browser as **500 "internal error"** — a raw `PostgresError`
  > belongs to no domain family. It is refused in WORDS by the service now, with the CHECK
  > still underneath as the wall for anything that never reaches the service. Fourth time on
  > this project that a real request found what unit tests could not.
  >
  > **Screens**: `/work/[jobId]` shows the proposal — the confidence WITH the bar it was
  > judged against, because "0.82" alone means nothing — and offers Accept / Correct / Reject
  > INSTEAD of the Done button while one is undecided. The API refuses the Done button there,
  > so offering it would be a slower error.
  >
  > **Proven live** against a seeded firm: a queued run rendered over HTTP with its bar and
  > provenance, the plain Done button answered 409, a no-op correction answered 409 with an
  > actionable message, a real correction stored BOTH values, and an acceptance applied the
  > proposal itself and finished the step.
  >
  > **HONEST LIMITS, named rather than implied:**
  >   · **No screen publishes the thresholds.** A firm can only set them through the generic
  >     config API today. Deliberate: there are no agents, so there is nothing to auto-commit,
  >     and a screen for a knob with no consumer is the "feature that looks finished" shape.
  >     It belongs with the first real agent (T4.x).
  >   · ~~The job screen was not opened in a browser.~~ **It was, on the retry — and opening it
  >     found a fifth bug.** The step's own label still read *"waiting for you — no agent built
  >     for this yet"* while a proposal sat underneath saying one had just run: `StepState` was
  >     deciding on the executor alone, which was the whole truth until T2.8 and stopped being
  >     it. It reads the proposal now, and says the two machine-answered cases apart — *"a
  >     machine answered — waiting for you to check it"* against *"a machine could not answer
  >     this — waiting for you to decide"*. Both rendered and looked at, with the bar, the
  >     provenance and Accept / Correct / Reject in place of Done.
  >   · ~~**`escalated` and `queued` land in the same place** — a blocked step on the job page.
  >     Routing them to the right person by role, grade, load and SLA is T2.9, and this task
  >     deliberately does not build half a queue.~~ **CLOSED by T2.9 (2026-08-30)**: both now
  >     open a `step_approval` and appear on `/work`'s To check tab. Note the routing that was
  >     actually needed — the firm's own published rule, a rank threshold or a reporting line.
  >     "Role, grade, load and SLA" was this board repeating a line the client never gave; see
  >     T2.9.
  >
  > Gate: `npm run check` **942** · `test:integration` **308** · `smoke` **229 passed, 0
  > failed**.
- [x] `(B)` **T2.9** **P6 Verification queue**: routing by the firm's own published rule — a rank threshold, a reporting line, or both; **maker≠checker as a CHECK constraint**. *Acc: the actor who produced an output cannot be its approver (DB rejects it).*
  > **Done (2026-08-30). Migration 0048 — `delivery.step_approval`,
  > `tenancy.membership.reports_to_user_id`, and `verification_policy`, the registry's eighth
  > kind.**
  >
  > **THE BOARD'S OWN LINE WAS WRONG AND IS CORRECTED ABOVE.** It said *"routing
  > role→skill→tier→load→SLA"*. The firm never asked for four of those five. G3.3's note
  > already said so in this file — *"`rank` exists because that is the whole routing rule the
  > firm actually stated — one threshold, no skill matrix, no tier-and-load"* — and `build2.md`
  > says it again. That five-part line came from a generic plan, not from the client, and it is
  > the second time this board has been caught carrying a plausible-looking fact the firm never
  > gave (the first was G3.3's "nine grades, Article to Associate Director", which was ten
  > rungs, Analyst to Partner). **No skill matrix, no tier, no load was built.**
  >
  > **WHAT WAS BUILT INSTEAD IS A CHOICE, BECAUSE THE CLIENT GAVE TWO ANSWERS.** The demo's own
  > open question S3 records both, on different days: *"Manager or above is fine"* — a rank
  > threshold — and *"manager means engagement manager"* — a named person. They are different
  > controls (a threshold lets anyone senior enough check anyone's work; a reporting line
  > stalls the morning that one person is on leave) and S3's own note says *"this is the
  > maker-checker control and not a line to draw on the firm's behalf"*. So the firm draws it,
  > from `/admin/verification`, choosing between `rank_threshold`, `reporting_line` and
  > `reporting_line_or_rank`. The third exists because the demo raised the leave-day objection
  > against the second and left it open; offering only two would be handing the firm a problem
  > that was already known.
  >
  > **AND IT IS PER STEP, NOT PER FIRM — which came out of the industry research, not the
  > board.** SQC 1, ICAI's own quality-control standard and what a CA firm is actually audited
  > against, requires an engagement quality control reviewer to be BOTH *"suitably qualified"*
  > (a rank test) AND *"independent of the engagement team"* — which a reporting line is the
  > opposite of, since your manager is on your engagement. An ordinary manager review and an
  > EQCR sign-off are therefore two different rules inside ONE process, and a single firm-wide
  > switch could not express a firm that does both. A firm publishes as many policies as it has
  > kinds of review, and a workflow step names the one that governs it.
  >
  > **THE ACCEPTANCE LINE IS A CHECK, AND THE MAKER IS DERIVED SO THE CHECK CANNOT BE FOOLED.**
  > `step_approval_maker_is_not_checker` compares two columns. If a writer could set both, the
  > way past it is to name somebody else as the maker and approve as yourself — so a BEFORE
  > INSERT trigger reads `submitted_by` from `job_step.performed_by` and a BEFORE UPDATE trigger
  > freezes it. `maker-checker.integration.test.ts` proves all of it as the OWNER role, going
  > round the application entirely, including that attack specifically.
  >
  > **THE TENANT WALL CAUGHT A REAL BUG IN THIS MIGRATION.** `policy_version_id` referenced
  > `config.version(id)` by id alone, which would have let one firm's approval pin another
  > firm's review rule — a foreign-key check runs as a system operation RLS does not filter, so
  > it violates no policy anywhere. `tenant-keys.integration.test.ts` failed on the first run
  > after the table existed and named the constraint. It is composite now. That test asks the
  > catalogue rather than a list, which is exactly why it covered a table added the same day.
  >
  > **`escalated` AND `queued` NOW LAND ON SOMEBODY'S DESK.** T2.8's stated honest limit — both
  > ended up as a blocked step on a job page and went to nobody — is closed. `/work` has a **To
  > check** tab showing the WHOLE FIRM's queue, not "mine": under a rank threshold there is no
  > "mine", and a list filtered to what the viewer can act on hides that six filings have been
  > waiting a week because nobody senior enough has looked. Each row carries the viewer's own
  > verdict instead, and the ones they cannot take say why.
  >
  > **`output.approved` AND `output.rejected` WERE REGISTERED VERBS WITH NO WRITER** — the shape
  > this codebase keeps catching, and the fourth time it has been closed rather than found.
  > They have one now. Neither carries the note: "sent back" is the fact, and WHY is prose that
  > can name a client in a log that cannot be erased.
  >
  > **A REJECTION IS NOT THE WORK.** The step stays `blocked`, the reason is kept, and the redo
  > opens a SECOND approval row — so "this took two goes" survives, which is the only signal
  > anywhere that explains where a week went. The same shape a retried agent run takes in 0047.
  >
  > **THE PERMISSION FLOOR CLOSES Q41, WITHOUT INVENTING A ROLE RULE.** `isEligible` requires
  > `work:write` before it applies the firm's rule, on the ground that approving somebody's
  > filing is the same kind of act as saying it was done — which that permission already gates.
  > Without it a read-only Management membership carrying a Senior Manager grade would pass a
  > rank threshold and be able to sign off a statutory filing, which is Q41 exactly and has
  > never been answered. This does not decide the client's question; it applies a permission
  > the firm already controls, and the firm can widen it on the roles screen.
  >
  > **Screens**: `/admin/verification` (new — the founder picks the rule, and the banner says
  > out loud that maker≠checker is NOT a setting on the page, because a control somebody thinks
  > is configurable is one they look for a way around), `/admin/people` gains **Reports to**,
  > `/admin/workflows` gains a per-step *"who checks it"* picker over PUBLISHED rules only, and
  > `/work/[jobId]` shows *"finished — waiting to be checked"* with Approve / Send back — or,
  > for the maker, the sentence instead of the buttons.
  >
  > **Proven in a browser, not asserted.** A firm seeded through the real API: a signed letter
  > spawned a job, Priya (Associate) finished a checked step and it did NOT finish, Anand
  > (Manager) sent it back with a reason, she redid it, he approved it and the job moved on —
  > and the record still says PRIYA did the work, not the approver. Opened as all three people:
  > the manager sees Approve / Send back, and **the maker sees "You did this work — somebody
  > else has to."** Over HTTP the maker's approval is a 403 in words, not a constraint
  > violation. No console errors.
  >
  > **HONEST LIMITS, named rather than implied:**
  >   · **`excludeEngagementTeam` is NOT built**, and SQC 1 wants it. "Engagement team" is an
  >     axis this schema cannot yet name honestly — the Dept-vs-delivery-team question (G2.4)
  >     is open with the client — and writing an independence rule on a guessed axis would be
  >     deciding who may sign off an audit. It belongs with the answer.
  >   · **The reporting line is NOT effective-dated.** The firm's staff sheet carries birth
  >     dates and no joining dates, and nothing records when a reporting line STARTED, so "who
  >     was my manager in March" has no honest answer in the column. The ledger's
  >     `membership.reports_to_changed` answers "when did it change" from today forward. Same
  >     decision, and the same reason, as G3.3's note about not inventing a rank.
  >   · **NO SLA, NO DUE DATE, NO ESCALATION.** The queue is ordered oldest-first by when the
  >     work was submitted. `service.slaDays` exists and has no real numbers in it — the firm
  >     has not given its internal turnaround times (client ask 3.4) and has not confirmed the
  >     escalation matrix (3.3). Ordering by a deadline this product invented would be a
  >     priority the firm never set. It belongs with T3.1, which is where `slaDays` is already
  >     earmarked.
  >   · **S3 is not answered, it is made configurable.** That is the right resolution for a
  >     product sold to other firms from day one, and it is the directive already at the top of
  >     the demo's CLAUDE.md — but it is not the same as the client having chosen. Nobody has
  >     told us which rule 10x itself wants, and no policy is seeded.
  >
  > Gate: `npm run check` **1014** · `test:integration` **338** · `smoke` **229 passed, 0
  > failed**.

**Milestone M2:** a signed engagement letter automatically spawns jobs that walk a configured step graph and land in a verification queue — the **engine runs end-to-end** with fake executors. *(This is the demoable core spine.)*

---

## Phase 3 · Close the loop  (~4–6 weeks)

### Lane B — delivery
> **G0.1 has landed (2026-08-28, migration 0018).** Every line, engagement and
> `contract.activated` event now carries `entity_party_id`, so this lane has the join it keys
> on. Note the dev-database reset it requires — see G0.1.

- [x] `(B)` **G3.2** **Client ownership — `crm.client_assignment`.** New tenant-scoped table: `client_party_id`, `role` in `key_manager` | `spoc`, **`axis_id`** (the Dept OR delivery team for a SPOC, null for a key manager, enforced by CHECK), `user_id`, `valid_from` / `valid_to`. *Acc: a client has one Key Manager, effective-dated SPOCs per Dept, and "who was SPOC in March" is answerable.* — **§4.2. T3.1's own acceptance line depends on this** — nothing else in the schema can answer "the client's Dept SPOC". Confirmed firm practice, not a guess: *"each client will de facto have two SPOC — one from TRC team and one from FRC team"*, and a client buying RAA work has three, which is why it is a row per Dept rather than two columns. Depends on G2.1 for `module`.
  > **Done (2026-08-30). Migration 0049.** `npm run check` **1061** · `npm run test:integration`
  > **355** · `npm run smoke` **229/229** · `scripts/client-assignment-walk.sh` **34/34** ·
  > screens opened in the browser.
  >
  > **THE ACCEPTANCE LINE WAS CHANGED ABOVE, and this is the one thing to read here.** The
  > board said *one SPOC per Dept*; Shrestha's instruction (2026-08-30) is that **in general a
  > Dept may have more than one** — leave cover, a joint SPOC on a group, a fortnight's
  > handover run in parallel. So there is deliberately **no "one SPOC per axis" constraint**,
  > the consequence is stated rather than discovered ("who was the SPOC in March" may answer
  > with a LIST, and every reader takes a list), and what T3.1 does with two SPOCs is T3.1's
  > decision made with its screen in hand. The direction is also the cheap one to reverse:
  > dropping a constraint later is one line; ADDING one later fails against whatever overlap
  > the firm has already recorded, and somebody then has to choose which real assignment to
  > delete. `ownership.integration.test.ts` tests the ABSENCE so a later tidy-up cannot put it
  > back without deciding to.
  >
  > **`axis_id`, not `module_id` — a deliberate widening, for the standing directive.** 0043
  > made Depts and delivery teams ONE list with an `axis` discriminator precisely because
  > neither layer is universal; pinning a SPOC to `dept` leaves a firm with only delivery teams
  > nowhere to put one. It costs 10x Global nothing — they point their SPOCs at their Depts and
  > get exactly what the board asked for, from a picker rather than a migration. It also avoids
  > answering the open FINCOMPLIANCE question in DDL. What IS still enforced, because it is
  > structural: a SPOC has an axis, a Key Manager never does.
  >
  > **One Key Manager at a time, and history stays unambiguous — by an EXCLUSION constraint,
  > not a partial unique index.** An index over open rows constrains only TODAY; two CLOSED
  > rows overlapping in March slip past it and the acceptance line fails with a constraint that
  > looked like it covered this. `btree_gist` + `daterange(valid_from, valid_to, '[)')`, plus a
  > second exclusion that refuses the SAME person twice on one axis (de-duplication, not
  > policy). Both proven against real Postgres.
  >
  > **Half-open `[valid_from, valid_to)`, against the demo's inclusive bound.** Every
  > effective-dated thing in BiB is half-open (`party_relationship`, `party_identifier`,
  > `isInForceOn`), and copying the demo would have shown TWO SPOCs on every changeover day —
  > the exact ambiguity this table exists to remove. A handover closes at D and opens at D.
  >
  > **A handover is two rows and never an edit**, in ONE transaction: the exclusion constraint
  > refuses the incoming row until the outgoing one is closed, so two calls would leave a
  > client with nobody in charge when the insert failed.
  >
  > **Two bugs, both found by OPENING THE PAGE, and they are the same bug from two sides —
  > #8 and #9.** At 04:11 in Delhi, `new Date().toISOString().slice(0,10)` is **yesterday**.
  > The panel rendered "as of 29-08" on the thirtieth (#8). Fixing the screen was not enough:
  > the client assigned from the form then vanished from its holder's own book (#9), because
  > the SERVER's today is UTC's and `listForUser` / `listOpenForClient` were asking
  > `CURRENT_DATE`. **A calendar day is the CALLER's fact and cannot be derived on the
  > server**, so `GET /api/v1/my-clients` takes `asOf`, `listOpenForClient` takes the date, and
  > the browser sends its LOCAL one. `CURRENT_DATE` is gone from this module's SQL.
  >
  > **The wider version of that is NOT fixed and is not mine to fix here:** `clock.now()
  > .toISOString().slice(0,10)` is the codebase's convention for "today" in `invoice`,
  > `dunning` and `lead` too, and every one of them is a day out for a firm east of Greenwich
  > in the morning. Changing four modules' behaviour belongs in its own task with its own
  > argument. **This module's defaults still use it** — they are the honest fallback for an API
  > caller that did not say — and every path the screens use sends an explicit date.
  >
  > **Permissions: `party:read` / `party:write`, not `tenant:admin`.** Naming a Key Manager
  > grants nobody anything; it is a fact about a client, like its identifiers and its leads. A
  > `client:assign` of its own would cost a migration to reach every existing firm (T2.5's
  > rule), and a firm wanting it tighter can publish a role without `party:write` today.
  >
  > **HONEST GAP, and it is the same one `/leads` already has.** Assigning needs `party:write`,
  > which a manager holds — but the two PICKERS the form needs (the roster, the firm's Depts)
  > are `tenant:admin` reads, so a manager is permitted to assign and is shown no form. The
  > screen degrades exactly as the pipeline's owner dropdown does rather than being fixed here
  > on a whim: widening either read is a decision about who may see the firm's roster and it
  > belongs in one place for both screens.
  >
  > Four routes, and the screens: **`/clients/[partyId]`** gains an Account team panel with an
  > **"as of" date box** — the acceptance line, on screen — and the history below it;
  > **`/clients`** gains a **My clients** tab that reads the assignments rather than filtering
  > the party list. Two ledger verbs, and a handover's `client_assignment.created` carries
  > `handedOverFrom` so one act does not read as two unrelated events on one day.
  >
  > **Still not decided, and deliberately left open:** which axis 10x actually assigns SPOCs
  > per (the FINCOMPLIANCE conflict — a DATA question this schema expresses either way), and
  > whether a SPOC could ever be a client-side contact rather than staff (assumed staff; the
  > roster is what refuses a stranger, because the FK points at a GLOBAL table).

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
- [x] `(B)` **G3.4** **`membership.party_id` — the login-to-person link.** ~~*Acc: "escalate to this assignee's manager" resolves through the org chart.*~~ **→ Gate 4 (record-scope), and it moves to Phase 6 with U1.** — **§4.3.** On `membership` and not `user_account`, because `party` is tenant-scoped and `user_account` deliberately is not: the same human may hold logins at two firms and is a different party in each. Nullable both ways — a portal user is not staff, and most of a firm has a place in the chart and no login.
  > **CORRECTED (2026-08-30), and the correction is that this task's ACCEPTANCE IS ALREADY MET
  > by somebody else's work.** The line above was written when the escalation ladder was the
  > reason to pull this forward from U1. **T2.9 built the org chart a different way and it
  > works**: `tenancy.membership.reports_to_user_id` (migration 0048) is a direct user → user
  > reporting line, with `PUT /tenancy/members/{id}/reports-to`, a `membership.reports_to_changed`
  > event, and live consumers in `usecase/verification` and `usecase/workitem`. "Escalate to
  > this assignee's manager" resolves today, through `membership`, without `party_id` existing.
  >
  > **So `(B)`'s lane is NOT waiting on `(A)` for anything.** T3.3 can be picked up now. The
  > parking-lot question — *"pull `membership.party_id` forward from U1, or make `(B)`'s
  > escalation wait"* — is answered by events: neither. It was overtaken.
  >
  > **CLOSED 2026-09-01.** What was left of this task was Gate 4 and only Gate 4 — which parties
  > a CLIENT PORTAL session may see — and it is now built, written and READ: migrations 0059
  > (the wall), 0060 (the writer and `portal:grant`), 0061 (remove means now) and 0062 (the
  > second and third policies, landing with the first portal read). Its consumer is T6.5's
  > status home; **the full record is in the Phase 6 U1 block**, including the decision that a
  > filing is scoped by its ENTITY because that is the column that table names.
  >
  > **The reporting line and this column are not redundant, and it is worth saying why**, so
  > nobody later "simplifies" one into the other. `reports_to_user_id` answers *who does this
  > LOGIN escalate to* — staff, inside one firm. `party_id` would answer *which PERSON is this
  > login* — which is what lets a portal contact be scoped to their own company's records, and
  > what would let the firm's org chart include the majority of a firm who have a place in it
  > and no login at all. Different questions.
  >
  > **REASSIGNED TO `(B)` (2026-09-01), with the phase order change.** The gap-ownership rule
  > on this board says a gap belongs to whoever built the module — and what is left of this
  > task is not the `membership` column, it is **Gate 4**, whose only consumer is the portal
  > `(B)` now owns end to end. The gate and the screens it protects belong in one head. It is
  > also `(B)`'s territory by history: `membership` has taken its last three columns from that
  > lane (grade in G3.3, `reports_to_user_id` in T2.9, the fee flag in T1.6). **It is the
  > FIRST thing in Phase 6** — every portal read is refused or allowed by it, and building the
  > screens first would mean writing every query twice.

- [x] `(B)` **T3.1** **Work items**: `work_item` + `checklist_item` + `work_item_dependency` + `work_item_approval`; states/priorities as **rows not enums**. *Acc: a filing arrives pre-assigned to the client's Dept SPOC.*
  > **Done (2026-08-30). Migrations 0050 (the vocabulary) and 0051 (the work).** Both blockers
  > were open: G2.3's `slaDays` (A, 28 Aug) and G3.2's SPOC (B, 30 Aug).
  >
  > **THE ACCEPTANCE LINE, AS A CHAIN OF COLUMNS.** `engagement_letter.party_id` → the CLIENT ·
  > `line.entity_party_id` → WHICH company · `line.service_version_id` → `body.module = "FRC"`
  > → `tenancy.service_axis` → `crm.client_assignment (client, 'spoc', dept, on date)` → the
  > assignee. Every link is a column, which is what makes the routing a QUERY rather than a
  > rule somebody remembers. Proven end to end in `npm run smoke`.
  >
  > **`work_item` IS NOT `job_step`, AND MERGING THEM WOULD HAVE COST BOTH HALVES.** A JOB is
  > HOW work gets done — which template, which steps, which agent — and its states are the
  > engine's, identical at every firm. A WORK ITEM is WHAT is owed and WHOSE it is, and its
  > states are the firm's own words. Merge them and ad hoc work ("prepare the board minutes")
  > has no home at all, and a firm ends up renaming the engine's mechanics to get its own board
  > to read properly. `work_item.job_id` is nullable in both directions.
  >
  > **THE FLAGS ARE THE WHOLE DESIGN, and they are what makes "rows not enums" mean anything.**
  > Rows buy the firm its vocabulary and immediately take something away: a CHECK cannot say
  > "a blocked item owes a reason", because it cannot see a word in another table. The naive
  > fix is `code = 'blocked'` in code — which hardcodes the very name the firm was promised it
  > could change, and the first rename switches the rule off silently. So MEANING lives in
  > booleans (`is_initial`, `is_terminal`, `is_blocked` · `is_default`, `is_statutory_default`)
  > and NAMES live in text. **Nothing in the product compares a code.** The smoke walk renames
  > "Blocked" to "Stuck" and then proves the reason is still demanded, which is the only way to
  > test a promise like this.
  >
  > **`is_statutory_default` is the firm's rule made mechanical** — *"due dates that are
  > statutory should anyway be high priority"* — a FLAG rather than the constant `'high'`, so a
  > firm that decides statutory work is Critical moves a tick. Work spawned from an ENGAGEMENT
  > is deliberately **not** statutory: an engagement's SLA is the firm's own promise, and
  > defaulting it true would put every piece of advisory work on the statutory priority and
  > make the flag meaningless the day it matters. T3.2's obligations set it, from the law.
  >
  > **TWO SPOCs, OR NONE — the decision G3.2 deferred to here, taken (Shrestha, 2026-08-30).**
  > Exactly one → assign. None, or more than one → UNASSIGNED with an `assignment_note` saying
  > which. Falling back to the Key Manager and taking the first SPOC are both rules the firm
  > never gave, and a WRONG assignee is worse than none: it sits on a desk whose owner believes
  > it is not theirs, whereas unassigned work is visible in a queue that gets chased. The note
  > is what makes that queue clearable rather than a pile — `/work-items`' Unassigned tab is
  > the screen it exists for.
  >
  > **`slaDays` is PINNED and the Dept is LIVE, in the same row, and that asymmetry is
  > argued.** A catalogue revision must not make finished work retroactively late (G2.3), so
  > the SLA is snapshotted from the version the client SIGNED. But a client agreed to the
  > service, not to which of our departments delivers it, so the Dept is read from what is
  > published NOW — the same rule `unspawnedActivations` already applies to the grouping facts,
  > and the two must not drift or a job cut by one Dept would put its task on another's desk.
  > The smoke walk publishes a third `bookkeeping` version to prove both halves at once.
  >
  > **The due date's base is `crm.engagement.effective_from`, a `date` column** — not
  > `signed_at`, which is a timestamptz. Turning an instant into a calendar day is a day out
  > for anybody east or west of UTC, and the firm already has the calendar-native field.
  >
  > **A SECOND approval table beside `step_approval`, and the rule is NOT duplicated.**
  > `delivery.work_item_approval` exists because a step approval hangs off a `job_step`, so
  > work with no template could never be reviewed — and *"every task is mostly reviewed"* is
  > the client's words about the TASK. What is reused unchanged is T2.9's `isEligible`,
  > `VerificationPolicy` and the grade/reporting-line comparison: one answer to "who checks
  > whose work" at this firm, two tables recording the answers. `submitted_by` is DERIVED from
  > the item's assignee and FROZEN by trigger, exactly as T2.9's is — a maker the writer could
  > choose is not a maker-checker control.
  >
  > **A dependency is enforced on STARTING, not on finishing**, because that is what it says:
  > "this cannot start until that is finished". Cancelling stays allowed — cancelling something
  > that never started is a real act, and refusing it would trap the item.
  >
  > **`escalated_level` / `escalated_at` are deliberately NOT built.** The demo has them, and
  > the escalation ladder is T3.3 and G3.4. A column with no writer is the "feature that looks
  > finished" this codebase keeps being caught by. Stated here rather than ticked quietly.
  >
  > ── **THREE REAL BUGS THIS TASK FOUND, and none of them was in T3.1** ──
  >
  > **1. `sweepActivations` promised per-tenant isolation since T2.6 and did not do it.** Its
  > own comment said *"one firm's failure must not stop the others"*; a throw in
  > `spawnForTenant` propagated straight out of the loop and every firm after it was skipped,
  > silently. One firm with no work-item states stopped the calendar for every client of every
  > firm on the box. Each firm is caught now and the failure is REPORTED (`SweepReport.failure`,
  > printed by `worker:once`) rather than swallowed — a silently skipped firm is worse than a
  > stopped sweep, because a stopped one gets noticed. Two tests in `tests/scheduler/`.
  >
  > **2. A work-item failure must never lose the JOB.** They are two facts: a job is the record
  > that work is OWED, a task is whose desk it lands on. `spawnForEngagements` is caught inside
  > the sweep and counted (`tasksFailed`), so the job stands and the number is printed.
  >
  > **3. PATCH WAS MISSING FROM THE CORS ALLOWLIST, since CORS was added.** T3.1 registered the
  > first routes that use it. The browser answers the preflight 204, reads the header, sees
  > PATCH is not on it and DISCARDS the request — no server log, no status code, surfacing as
  > "TypeError: Failed to fetch" and reading as a dead endpoint. **`npm run smoke` could never
  > have caught it**: curl does not preflight, and every one of those PATCH calls passed. Found
  > by clicking a checkbox on `/admin/work-vocabulary`. `tests/api/cors-methods.test.ts` now
  > reads every verb the handlers register and fails if the list falls behind — verified by
  > negative control (removing PATCH turns exactly that test red).
  >
  > **Also corrected: 0051's own comment was wrong.** It called the cross-tenant-state branch of
  > `enforce_work_item_state_facts` "unreachable behind the composite FK". A BEFORE INSERT
  > trigger runs AHEAD of constraint validation, so the trigger gets there FIRST and answers
  > with a sentence naming the state and the firm. Both defences are real; the trigger is the
  > outer one. Found by the integration test, which asserts both.
  >
  > **Screens** (`../bib-frontend`): **`/work-items`** the board — Mine · Unassigned ·
  > Everything, overdue first, the browser's own calendar day; **`/work-items/[id]`** the task —
  > checklist, dependencies, every review including the ones that sent it back; and
  > **`/admin/work-vocabulary`**, which is the standing directive made visible: the firm renames
  > a state, adds a ninth, or moves what statutory work gets, from a screen.
  >
  > **Two things the screen found that the types were happy with:** the Owner fact printed the
  > assignment note AND the callout below repeated it verbatim, and a two-word state name
  > wrapped inside its pill and rendered as a broken circle. Both fixed.
  >
  > ── **THE REVIEW QUEUE HAD NO SCREEN** (found 2026-08-31, by using it) ──
  >
  > `GET /api/v1/work-item-checks` shipped with this task and had ONE caller for five months: a
  > banner on `/work-items` linking to `checks[0]`. With two tasks pending there was no way to
  > reach the second — a partner submitted a task and, signed in as somebody else, no screen
  > listed it. This is the "write with no read" shape CLAUDE.md warns about, one step along:
  > the read existed and nothing rendered it.
  >
  > **`/work-items` has a fifth tab, "To check"** — the Escalated tab's precedent, because a
  > check is a different KIND of row from a task, so it gets its own renderer and the
  > Board/List toggle is hidden while it is open. The WHOLE firm's queue, oldest first, no due
  > date anywhere. Approve and Send back are on the ROW (the note field opens inline, because
  > the API refuses a rejection without one), and the maker gets the SENTENCE instead of the
  > buttons. The banner now opens the tab and says how many of the queue are the reader's own.
  >
  > **The API gained the verdict rather than the screen joining per row.** `viewer: { eligible,
  > reason }` on every queue row, roster resolved once — the arrangement T2.9's `/api/v1/checks`
  > already had, and the alternative was `/checkers` per row, which is the per-row join this
  > codebase has been caught by five times and answers for the whole roster when a row needs one
  > person. `reason` is the SENTENCE and not a code, because this module's `/checkers` already
  > returns prose and one refusal must not be worded two ways.
  >
  > Gate: `npm run check` **1394 tests** (2 new over the queue's verdict) · `demo:verify`
  > **71/71** · walked as maker and checker.
  >
  > Gate: `npm run check` **1172 tests** · `test:integration` **382** (27 new, real Postgres) ·
  > `npm run smoke` **253/253** · every screen opened in the browser.

> ### The client's own applicability rules arrived (2026-08-30) — read this before T3.2
>
> Sidharth sent **`docs/India_Compliance_Calendar_Applicability_Business_in_a_Box.xlsx`** in
> answer to *"what causes a step to be added or skipped"*, with the words *"I think this will
> be applicable only once we start using. But I guess we can give rule based logics here."*
>
> **It is not an answer to that question, and it is worth more than one.** The question was
> about STEP conditions inside a process (T2.7). The file is **55 obligations across 12
> modules with their applicability tests** — which is T3.2's specification, not T2.7's. He has
> said plainly that step-level skip rules do not exist yet and will emerge in use, so
> `StepFact` was deliberately NOT extended on the strength of it.
>
> **The `Primary Driver` column is the closed set of facts this firm actually branches on**, and
> it clusters: turnover / financial threshold (~12), transaction or corporate event (~13),
> State (~6), registration status (~6), entity type and size (~5), employee count (~4),
> industry (~4), cross-border (~6).
>
> **THE FINDING THAT CHANGES A DESIGN: the firm's commonest rule is a THRESHOLD, and nothing
> in this schema stores the numbers it compares.** No turnover, no employee count, no paid-up
> capital, no listed status. So `obligation_template` must be designed with **numeric
> comparison and the fields to compare**, not equality — and the two arrive together, because
> an operator without a fact to read is a control that looks live and is inert.
>
> The condition SHAPE was widened for this ahead of time — see the note under T2.7.

- [x] `(B)` **T3.2** **Obligations — the compliance calendar.** `obligation_template` → `obligation_instance`, statutory **and** internal-target dates, T–X lead time, financial-year periods. *Acc: an Indian quarter is Apr–Jun; March TDS exception resolves to 30 Apr; a monthly obligation spawns twelve instances a year out; re-running the generator changes nothing.*
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

  > **Done (2026-08-30). Migrations 0052 (`obligation_template` + `_exception` + `obligation_state`)
  > and 0053 (`obligation_instance`).** Every line of the acceptance is proven, and three of the
  > four are proven as ARITHMETIC in `tests/obligation/periods.test.ts` because they are pure: an
  > Indian quarter is Apr–Jun (and a calendar-year country's is Jan–Mar, same code, one field);
  > March TDS resolves to 30 April while the other eleven months are the 7th; a monthly rule gives
  > twelve periods a year out. The fourth needs a store, so it is `service.test.ts`: twelve
  > obligations on the first run, ZERO on the second, structurally — `UNIQUE (tenant, template,
  > entity, period_start)` with `ON CONFLICT DO NOTHING`, never a read-then-write, because the
  > sweep can run concurrently with itself after a redelivery.
  >
  > **THE 55-ROW SHEET IS ALL THERE, AS 57 ROWS, AND ONLY TEN OF THEM PRODUCE A DATE.** That ratio
  > is the deliverable, not a shortfall. `domain/obligation/rulepack-in.ts` encodes a due date ONLY
  > where the firm's own sheet states one — not where it is publicly known, not where the author
  > remembers it. MSME-1 is genuinely due 31 October and 30 April and the pack does not say so,
  > because the sheet says *"applicable half-yearly deadlines"*; `tests/obligation/rulepack.test.ts`
  > PINS the generating count at ten and names all ten, so "helpfully" dating an undated obligation
  > fails the build rather than shipping. The 57 is 55 sheet lines plus two: GSTR-1 and GSTR-3B each
  > occupy one line describing TWO regimes ("Monthly / Quarterly"), and folding them would have
  > meant inventing the QRMP date or losing the monthly one.
  >
  > The forty-seven that cannot compute carry `unresolved_reason` in the firm's own terms and appear
  > on the rules screen saying what they still need. The demo handed those back BY NAME in a log; a
  > log is not an answer. *"We read your sheet, here is the one fact we still need for AOC-4"* is a
  > far better question to put to a partner than *"what is your compliance calendar"*.
  >
  > **THE SILENT HOLE IS CLOSED BY DERIVATION, NOT BY A SETTING — and this is the design decision
  > worth reading.** A recurring engagement now gets one task PER PERIOD from the calendar, so
  > `spawnForEngagements` must not also add its own (due `effective_from + slaDays`, never
  > completable, indistinguishable from a real task — four hundred clients times three services is
  > twelve hundred of them). The obvious mechanism is a flag on the service. A flag can be WRONG,
  > and being wrong means SILENCE: no engagement task and no calendar rows either. So the
  > discriminator is DERIVED (`ObligationCoverage`, `infrastructure/postgres/obligation-coverage.ts`)
  > from the generator's own predicate — an active rule, with a formula, not event-driven, naming
  > this engagement's service and the entity's country. **The failure then inverts: a firm with no
  > rules is not covered, so it gets exactly the behaviour it had before T3.2 existed, and the board
  > can never end up empty.**
  >
  > On top of that, `GET /api/v1/calendar/coverage` names every live engagement the calendar
  > produced nothing for AND WHY, in five reasons of which none is an error — the commonest,
  > `no_rule_names_this_service`, is the ordinary state of advisory work. The worker logs the count
  > every sweep and `worker:once` prints it whether or not anything generated, because an empty
  > calendar with nothing said about it is indistinguishable from broken software.
  >
  > **`obligation_template` is its own table and not a config-registry kind, and the cost is paid
  > rather than waved through.** The registry would have given versioning, publishing, freezing and
  > pinning; it was set aside because the generator reads every rule in one set-based pass, an
  > exception needs a real FK to the rule it modifies, and this shape is proven. So `rule_pack` is
  > part of the rule's IDENTITY (a revision is a new row, never an edit), `supersedes_id` is the
  > chain, and an instance pins its template — which is what makes *"why was this due then?"*
  > answerable. **Written into `CLAUDE.md` with the reasoning**, as the repo's own rule requires.
  >
  > **Everything seeds `unconfirmed`, India included, and every lead time seeds ZERO.** The dates
  > came from a previous vendor's document; T–X is the firm's own working practice and appears
  > nowhere in the sheet. A guessed lead time is a commitment the firm never made, so the zero is a
  > blank a partner fills in on `/admin/obligation-rules` — visibly useless until they do.
  >
  > **THRESHOLDS ARE STILL NOT BUILT, AND THIS TASK IS WHY THAT IS NOW A DECISION RATHER THAN A
  > GAP.** The note above this task argues the firm's commonest rule is a threshold and that a
  > numeric operator must arrive with the fact it compares. It has not, deliberately: generation
  > scope is DECIDED as "only where an engagement exists", which means *"does Tax Audit apply?"* is
  > already answered by the client having BOUGHT it. A turnover store would be a table with no
  > writer — nothing in the product captures one, and books integration is Phase 7 — so `gte`/`lte`
  > would still be a control that looks live and is inert. **The threshold layer belongs with the
  > compliance-engine reading** (generate for every entity, uncovered = a sales lead), which is
  > `obligation_instance.engagement_id` being nullable and is a question nobody has put to the firm.
  > Every rule's `applicabilityNote` carries the sheet's own threshold text verbatim, so the day
  > that question is answered the specification is already here.
  >
  > **What USING the screens found, none of which any test caught:**
  >
  > - **The batch insert never ran.** postgres.js infers a JSON type for a string parameter and
  >   encodes it AGAIN, so a plain `::jsonb` produced a jsonb STRING and every sweep died with
  >   *"cannot call jsonb_to_recordset on a non-array"*. Casting to text first fixes it. The unit
  >   tests use a fake repository and the integration test inserted rows by hand, so **neither ever
  >   executed the statement** — only `npm run worker:once` did.
  > - **The coverage reason was wrong on the commonest case.** It compared the rule's
  >   `service_entry_id` to the engagement's, which is never true for a rule that names NO service —
  >   and every rule in the shipped pack names none, because a pack cannot know a firm's catalogue
  >   keys. A firm that had just loaded 57 rules was told none of them named its services. Fixed to
  >   the generator's own predicate, and a fifth reason added: `entity_not_registered`, which was the
  >   real answer and is a one-field fix somebody can actually make.
  > - **A lead time moved nothing for twelve months.** The sweep materialises a year ahead and
  >   generation is idempotent, so setting T–X changed only periods that did not exist yet.
  >   `redateUnstarted` now moves the INTERNAL target of everything nobody has started — never the
  >   statutory date, and never a filing already raised as a task, because that has a date its owner
  >   is working to.
  > - **Two id-only foreign keys**, caught by `tenant-keys.integration.test.ts` rather than by me:
  >   `service_entry_id` and `supersedes_id` both had to carry the tenant. That test asks the
  >   catalogue rather than a list, which is why a table written today is covered the day it exists.
  > - Grammar and prose on the rules screen ("1 are triggered", *"Once a year, day 15 3 months
  >   after"*, and an event-driven rule claiming *"30 days after the period ends"* when it has no
  >   period at all). The types were perfectly happy with every one of them.
  >
  > `/calendar` (with its coverage tab) and `/admin/obligation-rules` are the screens; both are on
  > the workspace home and the admin bar. **The whole chain was walked in the browser**: load the
  > pack, register a company, sweep, watch 162 obligations appear, set a lead time on the rules
  > screen, sweep again, and find *"GSTR-3B — Lakeview Foods Private Limited — Aug 2026"* on the
  > board due 20 September at **High** — the statutory-default priority flag doing its job, from the
  > law, with nobody setting it.
  >
  > **THE OPEN HALF NAMED HERE ON 2026-08-30 IS NOW CLOSED. Migration 0054.** What was missing:
  > `filed_on` was READ in four places and WRITTEN in none, so every calendar row said "Pending"
  > forever, `/calendar`'s "include filed and resolved" checkbox could not change what it
  > returned, and `obligation.filed` was a registered verb with no writer — the shape `CLAUDE.md`
  > warns about twice. `ObligationService.reconcileFiling` is the writer, and the whole chain was
  > walked against a running server. **T3.2's own acceptance line never depended on this**, which
  > is why the tick stood; what follows is the close of the loop.
  >
  > **"TERMINAL" WAS THE WRONG RULE, ON BOTH SIDES OF THE JOIN, AND THAT IS THE DESIGN FINDING.**
  > The note above said *mark an obligation filed when its work item reaches a terminal state*.
  > Both halves of that sentence are ambiguous and both resolve the wrong way if left alone:
  >
  > - **0050 seeds TWO terminal work item states — `completed` AND `cancelled`.** A task is
  >   cancelled for ordinary reasons: the client left, the entity was deregistered, somebody
  >   raised it twice. Reading `is_terminal` alone would record that a statutory return had been
  >   FILED because a person tidied their board. That is not a missing feature, it is a FALSE
  >   STATEMENT about a filing, and it is worse than the "Pending forever" it replaces.
  > - **0052 seeds TWO terminal obligation states — `filed` AND `resolved`.** `resolved` is
  >   T3.3's, the end of a deadline already missed. A filing nobody had to decide anything about
  >   does not belong in the decision queue.
  >
  > So each side gained ONE flag: `work_item_state.is_success` ("the work was DONE, not
  > abandoned") and `obligation_state.is_filed` ("a finished filing lands here"). **Flags, never
  > a `code`** — this module's own rule, and a firm renaming Filed to "Submitted" must not switch
  > the mechanism off. `filedState()` mirrors `initialState()`; a partial unique index caps the
  > second at one per firm; CHECKs refuse either flag on a state that is not terminal.
  >
  > **BOTH DEFAULT TO FALSE, and the direction is chosen.** A firm adding its own terminal state
  > gets `false` until somebody ticks it, so the failure is an obligation that stays OPEN —
  > visible, on the calendar, in front of the person who can fix it. `true` would have failed the
  > other way: filings recorded that never happened, silently, on the rows that matter most.
  >
  > **RECONCILIATION, NOT A TRANSITION.** `reconcileFiling(tenantId, workItemId, discharged)`
  > takes the CURRENT answer and makes the obligation agree, and `moveToState` calls it on every
  > move. Three things fall out: it is idempotent by construction (the guard is the repository's
  > own `WHERE filed_on IS NULL`, so a double-click writes ONE `obligation.filed`); reopening is
  > not a special case but the same call with a different answer; and there is no order to get
  > wrong. **A reopened or cancelled task UN-FILES** — `moveToState` already clears `completedAt`
  > on the way back, a calendar still saying "Filed" while somebody works the same thing is a
  > second rule about one fact, and filed is TERMINAL, so `canStillBeMissed` would be false
  > forever and T3.3 could never flag it. Un-filing lets the missed sweep self-correct. The
  > withdrawal is a registered verb (`obligation.filing_reversed`), never a quiet UPDATE.
  >
  > **The cycle is real and is broken in `setup/`.** The calendar raises a task (`WorkItemRaiser`)
  > and finishing that task files the obligation (`ObligationFiling`). Neither use case imports
  > the other; each declares the one method it needs and the composition root satisfies both with
  > a closure, in the API and the worker alike.
  >
  > **`filed_on` IS THE UTC DAY — DECIDED (Shrestha, 2026-08-30), and the cost is stated.** East
  > of Greenwich a filing made after midnight local records the previous day, which is the
  > on-time/late boundary on a statutory record. It is survivable only because the work item's
  > `completed_at` keeps the exact instant, so `filed_on` is a convenience projection and the
  > truth is not lost. The general fix — a firm timezone, or the caller's day on every route —
  > is still open and still shared with `invoice`, `dunning` and `lead`.
  >
  > **`work_item.completed` no longer fires for a CANCELLED task**, decided in the same breath:
  > the verb's own description is *"what did we finish last month"*, and counting cancellations
  > poisons every report built on it. `work_item.state_changed` now carries `isSuccess`, so
  > "what did we abandon" is answerable without a verb of its own.
  >
  > **WHAT RUNNING IT FOUND, AND NOTHING ELSE COULD HAVE.** `/calendar`'s checkbox was inert for
  > TWO reasons and only one was known. The second: `includeSettled: z.coerce.boolean()`.
  > Coercion is `Boolean(value)`, a query string carries TEXT, and **`Boolean("false")` is
  > `true`** — so `?includeSettled=false` meant "include them", the filter was permanently on,
  > and unticking the box was ignored. Every layer behaved: the parameter parsed, the route
  > answered 200, the SQL ran. The two branches are indistinguishable until a row is actually
  > terminal, which nothing could make one until this task. It is now
  > `z.enum(["true","false"]).transform(...)`, which also puts the accepted values in the spec —
  > and regenerating the client turned the frontend's boolean into a COMPILE ERROR, which is the
  > seam doing exactly what it is for. `tests/api/query-booleans.test.ts` bans the coercion in
  > every handler, because the instance is fixed and the CLASS is what recurs.
  >
  > **An honesty fix carried in the same commit:** `NoInitialState` and `NoFiledState` both told
  > a partner to *"mark one on the compliance vocabulary screen"*. **That screen does not exist**
  > — the obligation states have no editing surface at all, unlike the work board's
  > `/admin/work-vocabulary`. Both messages now say what is true (the rows were changed outside
  > the product), and the missing screen is an open item below rather than something an error
  > message pretends into existence.
  >
  > **STILL OPEN AFTER THIS, and named rather than left:** the obligation-state vocabulary has no
  > screen, so a firm cannot rename its own compliance states or move the two flags. It belongs
  > with T4.3's rules page and is the standing directive's bar (*change it from a screen, not a
  > deploy*) unmet for this one vocabulary. The work board's equivalent gained the new flag on
  > `/admin/work-vocabulary` in this commit, offered only on a state already marked finished.
  >
  > Gate: `npm run check` **1280 tests** · `test:integration` **409** (6 new, real Postgres:
  > the two CHECKs, the partial unique index, its per-tenant scope, and 0054's backfill asserted
  > against the CATALOGUE and proved non-vacuous). **The smoke budget is still spent — ~296 of
  > 300 — and nothing was added to it.**
  >
  > **WHAT WAS DONE IN THE BROWSER, AND WHAT WAS NOT — stated exactly, because the difference is
  > the whole reason this project insists on the browser.**
  >
  > **Driven by CLICKING, and this is the acceptance:** `/calendar` opened at **162 rows, every
  > one "Pending"**. Clicked "on the board →" on GSTR-3B / Lakeview Logistics / Aug 2026, chose
  > **Completed** in the state dropdown, clicked **Save**. Back on `/calendar` the tab read
  > **Due (161)** — the filed row had left the default view, which is the checkbox's "off"
  > branch doing something for the first time in this product. Ticking **"Include filed and
  > resolved"** (a real click) took it to **162** and the row read
  > *"2026-09-20 · **Filed** 2026-08-30"* — the state pill and the filed date, both of which
  > could not exist before this task. `/admin/work-vocabulary` renders the new **"Done, not
  > dropped"** column: ticked on Completed, **clear on Cancelled**, and DISABLED on every
  > non-terminal row. No console errors and no CORS failures on any page.
  >
  > **NOT driven by clicking:** after the first Save, the extension's synthetic clicks stopped
  > reaching React in that tab — the button was enabled, `elementFromPoint` confirmed the click
  > landed on it, and no request was made, no handler ran, no error appeared. It failed the same
  > way for every later transition and on the vocabulary page too, so it is the automation and
  > not the product; the same calls succeed from the page's own `fetch`. **Reopen, cancel and the
  > vocabulary toggle were therefore verified by fetch issued FROM the page** — real browser,
  > real cookie, real cross-origin preflight, which is stronger than curl and weaker than a
  > click. Results: Completed → **Filed 2026-08-30**, default view 161; Cancelled → **Pending,
  > `filed_on` null**, default view 162 (a cancellation un-files, and files nothing); the
  > vocabulary **PATCH** — the very verb T3.1 found missing from the CORS allowlist — answered
  > **200** cross-origin with credentials, and ticking "done" on a state that is not terminal was
  > refused **400** with the sentence a partner can act on. The ledger carries all sixteen events
  > in order, `obligation.filed` with `daysLate: -21`.
  >
  > **The demo data was left exactly as it was found** (task Not Started, obligation Pending,
  > `filed_on` null, Cancelled back to `is_success = false`).
  >
  > **What is still owed, and it is small:** clicking Save on a state move a SECOND time in one
  > session, and clicking the new vocabulary tick. Both were exercised at the API from the
  > browser; neither has been exercised by a finger. Worth retrying at the top of T3.3, whose
  > screens will need the same controls anyway.

- [x] `(B)` **T3.3** **Missed-deadline state**: past statutory date → partner decision queue (provisional filing vs late fee), logged. *Acc: a missed deadline is a state, not an error; partner choice writes an event.*
  > **Done (2026-08-30). Migrations 0055 and 0056.** Both halves of the acceptance hold: the
  > sweep MOVES a row to a state and throws nothing, and the partner's choice writes
  > `obligation.resolved` naming the option. Gates on the merged tree: `check` **1356**,
  > `test:integration` **429**.
  >
  > **`obligation.missed` was a registered verb with no writer — the SAME trap 0054 closed for
  > `obligation.filed`, left open a second time.** If you find a third, treat it the same way.
  >
  > ── THE SWEEP NEEDED A DESTINATION, AND `needs_decision` IS NOT ONE ──────────────
  >
  > The obvious rule is "move it to the state with `needs_decision`", and it works only while a
  > firm has exactly one. Nothing says it must: `missed` and, later, `disputed` are both waiting
  > on a person and only one of them is where a passed statutory date belongs. So `is_missed` is
  > a DESTINATION flag, and `is_resolution` is its sibling for the reason 0054 could not use
  > `is_terminal` — a firm has two terminal states and "terminal and not filed" is a definition
  > by subtraction that breaks the day a firm adds a third. The vocabulary now reads:
  >
  > | | |
  > |---|---|
  > | **destinations** `is_initial` · `is_filed` · `is_missed` · `is_resolution` | *a filing moves HERE when X happens* — at most one holder each, partial unique index, and the service refuses to leave the firm with none |
  > | **behaviours** `is_terminal` · `needs_decision` | *once a filing is here, this is true of it* — any number of states |
  >
  > A CHECK refuses `is_missed` on a state that does not need a decision: without it a firm
  > could point the sweep at an ordinary working state and every overdue filing would move there
  > in silence, which is indistinguishable from the product not working.
  >
  > ── THE OPTIONS ARE ROWS, AND UNCONFIRMED ────────────────────────────────────────
  >
  > `delivery.obligation_resolution_option` seeds the demo's four — provisional filing · late fee
  > · nil return · not applicable — and there is deliberately **no "ignore"**. They are rows and
  > not a CHECK for two reasons: a firm edits its own list on a screen, and *"how many late fees
  > did we accept this quarter"* is a `GROUP BY` that free text cannot answer. They seed
  > **`unconfirmed`**, the same word `obligation_template.status` uses, because the demo's own
  > `docs/OPEN-QUESTIONS.md` still carries them as **Q57 `OPEN`** — *"taken from the firm's own
  > described practice"* is not the same as confirmed against this list.
  >
  > **`closes_without_filing` is the fork, and it is a COLUMN rather than a branch.** False —
  > file provisionally, accept the late fee, file a nil return — means the filing still has to
  > happen, so the obligation goes back to the INITIAL state, `raise` puts it on a desk again,
  > and 0054 records it filed, late, with `daysLate` on the event. True — it never applied —
  > ends it in the resolution state. A firm adding *"client deregistered mid-year"* says which it
  > means without a deploy.
  >
  > ── AND WHY GOING BACK TO WORK DOES NOT LOOP ─────────────────────────────────────
  >
  > An obligation sent back has a statutory date in the past **forever**, so without a second
  > fact the next sweep re-flags it and the partner is asked the same question every morning
  > until the filing is made. `resolved_at` is that fact, and it is why this is a column rather
  > than only a ledger event: the sweep's WHERE clause cannot read the ledger. Proven by running
  > the worker twice after a decision — the row stayed put and `obligation.missed` stayed at 3.
  >
  > ── THE REASON IS MANDATORY, AND IT IS NOT IN THE LOG ────────────────────────────
  >
  > Refused by the service AND by `obligation_instance_resolution_chk` (all three columns or
  > none, and a blank reason is not a reason), because a partner in a hurry meets the form and an
  > import does not. But `obligation.resolved` carries the OPTION and never the reason: it is a
  > partner's free text about a client and may name a person, which §3.4 keeps out of a log that
  > cannot be erased. **So the reason lives in the erasable row and nowhere else, and 0055's own
  > down migration says that rollback is the one operation that loses it.**
  >
  > ── THE GO-LIVE FLOOR: A KNOB, NOT AN ANSWER (`compliance_policy`, the registry's 9th kind) ──
  >
  > Generation reaches ninety days back, so a firm onboarding in September with engagements dated
  > May gets four months of obligations whose dates have all passed — every one of them already
  > filed in Excel. Its first decision queue would be hundreds of answered questions, and the one
  > screen whose whole value is being trusted would not be. **This is the demo's Q56, also still
  > `OPEN`**, and its own note calls the ninety days *"a working value, not a decision"*.
  >
  > So the firm sets a date on a screen and the registry versions it — which also answers *"why
  > did these forty filings stop being asked about?"* a year later. **UNSET means NO FLOOR**, the
  > behaviour the system already had: unlike the discount policy, where silence means zero
  > because the fail-open reading cannot be audited, the safe direction here is to show MORE. A
  > hidden missed deadline is the failure this module exists to prevent.
  >
  > ── `obligation:resolve`, THE EIGHTH PERMISSION (0056) ───────────────────────────
  >
  > Partner-only by default, and its own permission rather than `tenant:admin` — which is
  > partner-only today and would have worked on day one and been wrong by month two. A firm
  > wanting its senior manager to decide filings without also handing them the ability to add
  > users and rewrite roles could not express that, and roles are config rows precisely so it
  > can. Not `work:write` either: that is the ordinary act of ticking off the step you performed,
  > and this commits the CLIENT'S money. 0012 and 0045 are the precedent, including the cost —
  > a published version is frozen, so the migration archives and republishes for the firms that
  > have not customised the role, and leaves alone the ones that have.
  >
  > ── THE SCREENS ─────────────────────────────────────────────────────────────────
  >
  > `/calendar` gains a third tab, **toned whenever it is non-empty rather than only when
  > selected** — every other badge there is a filter, this one is a queue of undecided client
  > money. `daysLate` is computed from the day the BROWSER sends (G3.2's lesson: a UTC day is
  > yesterday in Delhi each morning, and this is the screen about exactly that). The form is
  > collapsed until somebody acts, and it names where the filing goes next **before** the click,
  > so a partner never has to know which option means which.
  >
  > **`/admin/obligation-vocabulary` is new, and it closes the standing directive's one unmet
  > vocabulary.** 0052 held these as rows so a firm could rename them and nothing could write
  > them; every *"mark another state as the X one"* message in this module was describing a
  > control that did not exist — including `NoFiledState`'s, whose comment said so and has now
  > been corrected. The four destinations are RADIOS, because a checkbox that refuses to be
  > unticked reads as broken.
  >
  > ── A REAL BUG THAT SHIPPED IN T3.2, FOUND WHILE WIRING THIS ─────────────────────
  >
  > **`ObligationError` had no entry in `api/domainerr.ts`.** Every refusal the compliance
  > calendar made — a rule not found, a jurisdiction typed wrong, an exception month already
  > taken — has been answering **500 "internal error"** since T3.2. It is exactly the failure
  > that file's own header describes `StaffGradeError` having, made a second time, and invisible
  > for the same reason: unit tests assert on the thrown sentinel and are perfectly happy. It
  > surfaced because T3.3's refusals are read by a partner on a screen — *"say why"* answering
  > 500 with no message would have been the third time. Mapped now, and confirmed over HTTP:
  > a blank reason answers **400** with its own sentence, a second decision **409**.
  >
  > ── WHAT RUNNING IT PROVED, AND WHAT IS OWED ─────────────────────────────────────
  >
  > Walked in the browser as the partner: the badge counted 3, the queue rendered oldest-first
  > (100 · 55 · 10 days late), the form's fork hint appeared on selecting an option, and
  > **clicking Record decision wrote the whole chain** — state back to `pending`, reason stored,
  > `resolved_at` stamped, `obligation.resolved` in the ledger carrying the option and no reason.
  > The badge then read 2. Two further sweeps did not re-flag it.
  >
  > **The rename promise was proven END TO END**: the missed state was renamed to *"Late —
  > partner to decide"*, another obligation was back-dated, and the sweep flagged it into the
  > renamed state. The demo's `stateByCode('missed')` would have broken there in silence.
  >
  > **Owed, and it is tooling rather than product:** the extension's synthetic clicks stopped
  > reaching React after the first successful save — the same wall recorded at the top of T3.2 —
  > so the CLOSING fork and every vocabulary write were exercised over HTTP with a real session
  > and a real permission check, not with a finger. Both refusals answered correctly
  > (`LAST_DESTINATION_STATE` 409, `ALREADY_DECIDED` 409). Retry at the top of the next task.
  >
  > **Demo data was CHANGED and is not restored.** Seven obligations across the two `demo-*`
  > firms were back-dated so anything could be overdue at all (their engagements are recent, so
  > the earliest real statutory date was 2026-09-07), and three decisions were recorded against
  > them. The state name was put back to "Missed"; the ledger events are append-only and stay.


### Lane A — money & documents
- [x] `(A)` **T3.4** **C6 Invoicing**: **gapless per-entity series** (trigger-frozen), IRN field, `invoice`/`invoice_line`, balance is a sum. *Acc: numbers cannot be edited; a gap is impossible under concurrency.*
  > **Done (2026-08-29). Migration 0027.** Both halves of the acceptance are proven against
  > real Postgres, because neither can be proven anywhere else.
  >
  > **THE MECHANISM IS A COUNTER ROW UNDER `SELECT … FOR UPDATE`, IN THE SAME TRANSACTION AS
  > THE INSERT.** That is why `InvoiceRepository.create` both allocates and writes: the obvious
  > split — `nextNumber()` then `create()` — cannot be gapless however carefully it is called,
  > because between the two the caller may fail and the number is spent. The signature IS the
  > guarantee, the same argument `AssignmentStrategy.assign` makes about fairness, reached from
  > money instead.
  >
  > **A SEQUENCE WOULD HAVE BEEN WRONG AND UNFIXABLE.** `nextval` survives rollback by design —
  > that is what makes sequences fast and lock-free — so an aborted transaction burns its number
  > forever. `max(number)+1` is wrong differently: it reads a snapshot, so two concurrent
  > invoices both see 40. The board already named the right mechanism and this is it.
  >
  > **Verified by a NEGATIVE CONTROL, not by going green.** Deleting `FOR UPDATE` from the
  > adapter turns exactly one test red — six simultaneous invoices no longer get six consecutive
  > numbers — so the lock is demonstrably load-bearing rather than decorative.
  >
  > **This is the deliberate opposite of `document_ref_series` (0020),** which BURNS a number
  > when a draft fails. A gap in `PR-2026-0007` is honest; a gap in a tax invoice series is
  > something an auditor is entitled to read as a suppressed sale. Both files say so, pointing
  > at each other, because the next person will meet one of them first.
  >
  > **One correction taken BEFORE the migration was committed**, and it would have shipped a
  > schema that fails on a real customer: `UNIQUE (tenant_id, number)` — one number per firm,
  > which is what a person quoting "invoice 41" assumes — is wrong, because the series is per
  > ENTITY and a firm's two companies each correctly issue their own `INV/2026-27/0001`. It
  > would have failed on the second entity's first invoice, discovered by whichever customer
  > opened a second company. Scoped to `(tenant, entity, number)`, with a per-entity `prefix`
  > on the series so a firm CAN tell them apart when it wants to.
  >
  > **Cancelling does not release the number.** The row stays in the sequence saying it was
  > cancelled — which is exactly what an auditor needs in order to see where a number went — and
  > the integration test asserts the stored sequence numbers are 1..N with nothing missing,
  > whatever happened along the way.
  >
  > **There is no `paid` status, deliberately.** What has been paid is the sum of the payments
  > against it (T3.5); a status saying "paid" beside a balance saying otherwise is the classic
  > way those two disagree, and only one of them is arithmetic. Totals are VIEWS in `numeric`,
  > `security_invoker`, exactly as the proposal's are.
  >
  > **The IRN's honest limit:** nothing in this product talks to the IRP. `registerIrn` records
  > an answer obtained elsewhere, the same shape as the advance-fee attestation, and it is
  > set-once. The real connector is T7.1.
  >
  > **`financial_year_of` exists twice** — in SQL because a CHECK cannot call TypeScript, and in
  > the domain because the application composes the number before it writes the row. An
  > integration test asks both the same boundary dates, because two copies of a rule is exactly
  > how 31 March ends up answered differently on the two sides.
  >
  > Gate: `npm run check` 766 · `test:integration` 243 · `smoke` **225 passed, 0 failed**.
- [x] `(A)` **T3.5** **Payments + dunning**: `payment`, `credit_note` (reason CHECK), ladder D+3/D+7/D+15 → terminal (credit hold/legal, partner sign-off). *Acc: worker climbs the ladder; terminal needs partner approval.*
  > **Done (2026-08-29). Migrations 0028, 0029, 0032, 0033.** Payments, credit notes AND the
  > dunning ladder — the acceptance holds in both halves: the worker climbs the ladder, and the
  > terminal rung needs a partner.
  >
  > **THE LADDER IS CONFIG, the fifth registry kind.** D+3, D+7, D+15 are the firm's numbers and
  > they change, so a partner edits them without a deploy — and "which ladder was in force when
  > we put them on hold" is answerable because a published version is frozen. ONE entry holds
  > the whole ladder rather than one per rung: the rungs are read together and their ORDER is
  > the meaning, and splitting them would let a firm end up halfway between two ladders.
  >
  > **THE TERMINAL RUNG IS THE ACCEPTANCE.** Credit hold and legal action are the two things on
  > this ladder a firm cannot take back with an apology, so the worker may CLIMB to them and may
  > not APPLY them: the row lands `pending_approval` and a partner decides. Enforced in the
  > schema (`dunning_action_gate_chk`, and a decider that is NOT NULL exactly when a decision
  > exists) rather than only in the sweep, because a rule in a worker is one a second worker, a
  > script or an agent walks past. **A rejection is recorded as loudly as an approval** — "we
  > considered legal action and decided against it" is a fact somebody wants three months later.
  >
  > **AT-LEAST-ONCE, like everything the engine touches.** `UNIQUE (tenant, invoice, step)` makes
  > a second chase impossible, and the event is written only when a row was actually created —
  > so a redelivered message and a restarted worker leave one row and one event. The sweep takes
  > EVERY due rung, not just the next: a firm whose worker was down for a week should not need
  > seven sweeps to catch up.
  >
  > **A correction to my own reporting, found by a test.** `alreadyTaken` was documented as "the
  > redelivery case", by analogy with the scheduler's counter. It is not: `dueDunningSteps`
  > filters out rungs already had, so an ordinary second sweep never reaches the insert and the
  > counter is ZERO. What it actually counts is the genuine race — two workers overlapping —
  > which is the only case the pre-filter is too late for. Both the comment and the test now say
  > so, and a second test drives two concurrent sweeps to prove it.
  >
  > **Two duplications caught at the composition root rather than shipped.** A second
  > `PostgresTenantDirectory` and a second `FakeTenantDirectory` — two pieces of SQL and two
  > fakes answering "which firms exist", which would eventually disagree about which firms a
  > sweep walks. The PORT is declared twice, deliberately, as this codebase does; the ADAPTER is
  > one. TypeScript reported it as a duplicate identifier, which is where it should be caught.
  >
  > **It actually runs.** The sweep is registered on its own queue at its own cadence (DAILY, not
  > the spawn sweep's hourly — the rungs are counted in days, and the one thing a faster sweep
  > would change is a chaser landing at 3am), and `npm run worker:once` runs BOTH sweeps, because
  > an entry point mirroring half the worker is a worse lie than none.
  >
  > **THE BALANCE IS A SUM, and there is no `paid` flag anywhere.** Both a flag and an
  > `amount_paid` column are caches of an addition, and both drift the first time a payment is
  > corrected — leaving an invoice that says "paid" beside arithmetic that says otherwise, where
  > only one of the two is evidence. `crm.invoice_balance` computes invoiced − paid − credited
  > in `numeric`, `security_invoker`, over three tables.
  >
  > **A PAYMENT IS SIGNED.** A bounced cheque is a NEGATIVE payment with its own date and its
  > own note — two rows that tell the story — rather than the original row edited into something
  > that never happened. `bib_app` holds no DELETE grant, so it is the only honest way to
  > express a reversal, and `isSignedAmount` joins `isAmount` in the money domain to say which
  > fields may go negative and which may not. Overpayment is ALLOWED: a client settling two
  > invoices with one transfer is real, and the balance simply goes negative.
  >
  > **THE CREDIT REASON IS MANDATORY AND CLOSED**, which was the demo's hardest-won finding
  > about revenue — without it "the numbers always reconcile; WHY forty thousand came off does
  > not". Closed rather than free text because *"how much did we write off to service failures
  > last year"* is a GROUP BY, and prose does not group. The reason is in the ledger payload
  > too: an event recording the amount and not the category would reproduce exactly the
  > blindness the column exists to remove.
  >
  > **A SECOND CORRECTION TO 0027, found by building on it.** `crm.invoice_series` had no
  > `document_type` — an omission, and the proof is one table over, where `crm.document_ref_series`
  > has had one since 0020. A credit note is its own legal document with its own consecutive
  > series, and borrowing the invoice counter would interleave two series into one sequence:
  > an invoice number missing because a credit note took it is a number an auditor cannot
  > account for, which is worse than having no gap rule at all. 0028 widens the key; `crm.invoice`
  > gains a `series_type` pinned by a CHECK so its foreign key survives rather than being dropped.
  >
  > **AND A REAL BUG THAT SHIPPED IN T3.4, fixed forward by 0029.**
  > `invoice_issued_has_date_chk` was written as `(status = 'issued') = (issued_on IS NOT NULL)`,
  > which forbids the ordinary act of **cancelling an issued invoice**: the status moves to
  > `cancelled` while `issued_on` stays set — correctly, because the document WAS issued and a
  > copy is with the client. Every cancellation test in T3.4 cancelled a DRAFT, the one state
  > where both sides of the equality are false and it happens to hold; T3.5's first payment test
  > cancelled an issued one and found it. The rule is three cases, not an equality between two
  > independent facts, and it is now written that way. A regression test sits in T3.4's own file,
  > where it should have been.
  >
  > Gate: `npm run check` 795 · `test:integration` 255 · `smoke` **227 passed, 0 failed**
  > (the smoke walk is at its request budget and gained no section here — the ladder is a
  > WORKER, and `worker:once` is how it is demonstrated).
- [x] `(A)` **T3.6** **P8 Documents + P9 client data**: `document`/`document_version`/`document_link` content-hashed, storage **port**; every byte via RLS-checked route. *Acc: a doc attaches to any object; no pre-signed URL escape.*
  > **Done (2026-08-29). Migration 0037, and a new `files` schema.** Both halves of the
  > acceptance are proven against a running server, not asserted: a PDF uploaded, attached to a
  > party, listed back through `/subjects/party/{id}/documents`, downloaded, and the bytes
  > compared byte-for-byte with the file on disk — the stored `content_hash` equals its real
  > sha256. A second firm's partner gets **404 on the document AND on its bytes**.
  >
  > **A NEW SCHEMA, and it is not tidiness.** `crm.document_block` (G1.7) and
  > `crm.document_ref_series` (0020) already exist and neither is about a FILE. A
  > `crm.document` beside `crm.document_block` would read as "the document a block belongs
  > to", which is the opposite of what it is. And this store attaches across the whole product
  > — party, lead, proposal, letter, engagement, invoice, job — so it is not CRM's to own.
  >
  > **THE ACCEPTANCE'S SECOND HALF IS THE INTERESTING ONE.** "No pre-signed URL escape" is not
  > a missing feature, it is the design: a pre-signed URL is a capability that outlives the
  > session that minted it and is checked by a storage vendor rather than by this product,
  > which means it answers to **none of the four scoping gates**. Bytes leave through
  > `GET /documents/{id}/content` only, and the version row that names the storage key is
  > fetched under RLS — so the key is unreachable before it could be used. Proven live.
  >
  > **VERSIONS ARE APPEND-ONLY BY GRANT, NOT BY TRIGGER.** `bib_app` holds SELECT and INSERT on
  > `files.document_version` and nothing else, the same arrangement the `ledger` schema has. A
  > trigger is a rule the table carries; a missing grant is a permission the role does not
  > hold, and an import or an agent walks past the first and not the second. The integration
  > test asserts `has_table_privilege(... 'UPDATE') = false` rather than only that an UPDATE
  > threw, because those are different claims.
  >
  > **CONTENT-ADDRESSED, and the cost is stated rather than discovered.** The storage key is
  > derived from the sha256, so a client re-sending the file they already sent stores one blob
  > — the ordinary case, not an edge one. The consequence: **two documents can share a blob**,
  > so nothing may delete bytes because one document that referenced them went away. The
  > `BlobStore` port therefore has **no delete method**, matching `bib_app` holding no DELETE
  > grant anywhere in this database.
  >
  > **`subject_ref` HAS NO FOREIGN KEY, and cannot.** It follows `delivery.job`'s
  > `(source_kind, source_ref)` (0041) rather than inventing a second idiom. The containment is
  > the CHECK on `subject_kind`: a dangling link is possible within a KNOWN vocabulary, never a
  > pointer to anything at all. `linksOf` resolves the subject to a label with a LEFT JOIN per
  > kind, so an unresolvable link shows as unresolved instead of rendering blank — the
  > read-model rule applied to the one case where the join can legitimately fail.
  >
  > **`brand_asset` landed here** — it was in "deliberately NOT on this board" with the note
  > that PDF cannot ship without it, and it is one small table over the store this migration
  > already builds. **Keyed on the ENTITY, not the firm**: G1.2's rule applied to paper, because
  > a letter issued by the US entity printing the Indian logo is the same class of error as one
  > printing Indian governing law (G1.8). A partial unique index (`WHERE is_active`) makes "the
  > current logo" a lookup rather than a sort, and superseded marks stay readable.
  >
  > **The honest registry gained its FOURTH stub**, with the treatment `attested-signer.ts`
  > says a fourth must get: `validateServer` refuses a production-like boot on
  > `BIB_STORAGE_BACKEND=filesystem`. Two failures, and the first is the nastier because it is
  > intermittent — replicas do not share a disk, so a file uploaded through one pod is a 500
  > through the others depending on which one the balancer picks; and a container filesystem
  > does not survive a restart, leaving metadata that outlives its bytes. `tests/config/
  > boot-gates.test.ts` now covers all four.
  >
  > **Two codes were added to the error vocabulary, deliberately.** `PAYLOAD_TOO_LARGE` (413) is
  > not VALIDATION — the request is well formed and it is the SIZE that is refused, so a client
  > can offer "compress and retry" instead of "invalid file". `UPSTREAM_FAILURE` (502) is not
  > INTERNAL — it means the metadata is intact and STORAGE lost the bytes, which is the first
  > thing anybody woken at night needs to know.
  >
  > **NOT DONE, and split out on purpose: rendering. See T3.8.** The `DocumentRenderer` port was
  > written and then deliberately deleted before commit, on this repo's own rule — T2.5 deferred
  > `workflow_template` because "a body designed against no consumer ends up wrong", and a
  > renderer interface with nothing implementing it is exactly that. It gets designed against
  > real letters and real invoices, in T3.8.
  >
  > Gate: `npm run check` **939** (was 906) · `test:integration` **296** · `smoke` **229 passed,
  > 0 failed** (unchanged).

- [x] `(A)` **T3.8** **Render a document a client can be sent.** *Acc: an engagement letter and an invoice each render to a file, stored as a `generated` document version, whose content hash a re-render of unchanged data reproduces exactly.*
  > **Done (2026-08-30). No migration — it is all code over T3.6's store.**
  >
  > **THE ENGINE DECISION, MADE AND ARGUED: pdf-lib, not a headless browser.** The obvious
  > approach is HTML + CSS through Chromium and it was rejected on one requirement that
  > outranks fidelity here — **a rendered document's content hash is evidence.** Chromium does
  > not promise byte-identical output across versions (font hinting, image encoders and the PDF
  > writer all move), so a firm upgrading a base image would watch every re-render stop matching
  > with nothing to say why. It also puts ~300 MB of browser in the container.
  >
  > pdf-lib is pure JS, MIT, four pure-JS dependencies, no native modules. **The cost, stated
  > rather than discovered: layout is hand-built** — there is no CSS and no automatic table, so
  > `infrastructure/render/pdf-renderer.ts` carries a small column-and-flow engine. That is the
  > honest price of reproducible bytes, and it is a one-file decision behind `DocumentRenderer`.
  >
  > **DETERMINISM PROVEN THREE WAYS.** pdf-lib writes CreationDate, ModDate and a Producer
  > string from the clock and its own version by default; all three are pinned from the
  > DOCUMENT's issue date. A unit test renders twice **1.1 seconds apart** and compares hashes,
  > with a control that asserts the bytes DO change when content changes. And end to end
  > against a real letter: three renders through the API, one hash, **one blob on disk** —
  > because the store is content-addressed, re-rendering costs nothing.
  >
  > **THE DECOMPOSITION T3.6 DELIBERATELY STOPPED SHORT OF.** `RenderableDocument` is a neutral
  > description; `RenderSource` (Postgres) knows what an engagement letter contains;
  > `DocumentRenderer` (pdf-lib) knows what a page looks like. Neither learns the other's job,
  > which is what T3.6's note said the follow-up had to get right.
  >
  > ── **TWO REAL LIMITS, BOTH FOUND BY RUNNING IT** ─────────────────────────────
  >
  > **1. The built-in PDF fonts cover Latin-1 and NOTHING ELSE — the rupee sign is undrawable.**
  > In an Indian compliance product. Found on the first render. Money is therefore written with
  > its ISO code (`INR 216,000.00`), which is independently the better choice on a cross-border
  > document anyway — G1.8 exists because the same letter may be read in Dubai, where a bare
  > symbol is ambiguous. **The renderer refuses rather than mangling**: `UnrenderableText` names
  > the character, its code point and the field it appeared in, because silently dropping a
  > letter from a client's name on a legal document is worse than producing nothing. **A client
  > whose name is not Latin-1 — Devanagari, Chinese — cannot have a document rendered today.**
  > That is the real limit and the fix is embedding a Unicode font (see the open item below).
  >
  > **2. The guard immediately caught MY OWN bug**, which is the best evidence it works: the
  > "not stated" fallback used an em dash (U+2014). Now the word "Not stated", which is better
  > on a legal document anyway — a dash in a fee column is ambiguous between "nothing" and
  > "nobody said".
  >
  > **One more found by rendering an invoice**: the source read `invoice_line_amount.amount`,
  > and that view exposes `gross`/`net`/`tax`. A column that does not exist, invisible to every
  > unit test because the fake does not have a schema.
  >
  > **Screens**: the Files panel gained a **Generate PDF** button on `/engagement-letters/[id]`
  > and `/invoices/[id]` only — the two things that can be rendered. Pressing it twice is safe
  > and the panel says so.
  >
  > Gate: `npm run check` **1303** · `test:integration` **416** · `smoke` **261 passed, 0
  > failed**. Verified in a browser: a real letter rendered, downloaded, and its file's sha256
  > compared to the stored content hash — equal.

- [x] `(A)` **T3.9** **Embed a Unicode font in the renderer.** *Acc: a client whose registered name is in Devanagari gets a correct PDF, and `₹` prints.*
  > **Done (2026-08-30). No migration — dependencies and one new file.**
  >
  > **"EMBED A UNICODE FONT" TURNED OUT TO BE THE WRONG SHAPE, and measuring said so.** There is
  > no single file that covers what this product needs at a size worth shipping. Asking
  > `hasGlyphForCodePoint` of the actual files:
  >
  > | subset | covers |
  > |---|---|
  > | `latin` | the basic range, and the em dash. **No rupee sign.** |
  > | `latin-ext` | the rupee sign, Polish, the ruble. **Not the basic range.** |
  > | `devanagari` | Devanagari, and the rupee sign again |
  >
  > So it is a **CHAIN with fallback**: text is segmented into runs and each is drawn with the
  > first font that can draw it, which is what a browser does and what pdf-lib leaves to the
  > caller. Adjacent characters resolving to the same font are merged, so ordinary English is
  > one run and one draw call.
  >
  > **THE GUARD IS NOW DERIVED FROM THE FONTS, not a hardcoded range.** T3.8's version tested
  > against Latin-1 by hand; it now asks the loaded chain. It therefore cannot lie about what
  > the renderer can draw, and it narrows on its own the day a font is added.
  >
  > **LICENSING, which is why this was its own task.** Noto Sans, **OFL-1.1**, which expressly
  > permits embedding and redistribution — and it arrives as an npm dependency
  > (`@fontsource/noto-sans`) rather than a binary committed here, so it is versioned, auditable
  > and updated like anything else. Nobody has to decide whether a font in `git log` was
  > licensed.
  >
  > **SUBSETTING IS WHAT MAKES THREE FONTS FREE.** `subset: true` embeds only the glyphs used, so
  > a letter in plain English carries a few hundred bytes of Latin and *nothing* of the other
  > two. A document mixing Devanagari, Latin-Extended and the rupee sign is **15 KB**.
  >
  > **DETERMINISM SURVIVES**, which was the one thing that could have killed this: the fonts are
  > files embedded identically every time, and subsetting is a function of the glyphs used. The
  > test that renders twice 1.1 seconds apart still passes, and a real letter rendered twice
  > through the live API produced one hash.
  >
  > ── **THE DEPENDENCY FIGHT, recorded so nobody repeats it** ────────────────────
  >
  > `fontkit` 2.x was tried FIRST and is wrong: it changed the subset API pdf-lib 1.x calls, so
  > every font fails with `subset.encodeStream is not a function`.
  >
  > `@pdf-lib/fontkit` is the bundle pdf-lib expects — and it is compiled with regenerator and
  > shipped WITHOUT its runtime, so it throws `regeneratorRuntime is not defined` the moment it
  > walks a font with complex shaping tables. **Latin does not have them and Devanagari does**,
  > so it failed only on the script this task exists to support, and only on the last test.
  > `regenerator-runtime` is imported once in `font-set.ts` with that whole explanation beside
  > it. It is a shim for an upstream packaging defect, not a bandaid, and saying which is the
  > point of the comment.
  >
  > **The ISO code stays.** `INR 216,000.00` was originally forced (the symbol was undrawable)
  > and is now a product decision on the reason that was always stronger: this is a cross-border
  > product, and a bare symbol is ambiguous to a reader in Dubai or Delaware. A firm that wants
  > `₹` can have it by changing one function — which it could not before.
  >
  > **What is still refused: CJK**, and every script the chain does not carry. Adding one is
  > another font in the chain rather than a change of approach, and the error names the
  > character, its code point, the field, and what the chain does carry.
  >
  > Gate: `npm run check` **1306** · `test:integration` **416** · `smoke` **261 passed, 0
  > failed**. Verified by looking at the PDF: a Devanagari client name, `₹216,000.00`, Société
  > Générale · Zürich, an em dash, and Devanagari and Latin mixed inside one table row.

- [x] `(A)` **T3.7** **C7 dashboards** (read models): MRR, DSO, ageing by client/service/owner. *Acc: figures reconcile to underlying rows, not cached columns.*
  > **Done (2026-08-30). Migration 0038 — two VIEWS and no tables.**
  >
  > **The acceptance decided the whole design.** "Figures reconcile to underlying rows, not
  > cached columns" means there is no `mrr` column anywhere and no nightly job that fills one:
  > `crm.engagement_mrr` and `crm.receivable_ageing` are views over the rows, exactly as
  > `crm.invoice_totals` (0027) is. Proven rather than asserted — the integration test computes
  > MRR a second time from the base tables, never touching the view, and asserts the two are
  > equal. Against the dev database that is **₹31,20,000 both ways**.
  >
  > The cost, stated: they recompute on every read. Right at this size, and when it stops being
  > right the answer is a materialised view with a stated refresh — never a column somebody
  > updates by hand, which is the thing the acceptance forbids.
  >
  > **THE REAL FEATURE IS `excluded_because`, NOT THE MRR NUMBER.** Four things are not monthly
  > recurring revenue and each is named rather than dropped: `one_time` (charged once — real
  > revenue, not recurring), `custom_frequency` (the firm said custom BECAUSE no formula fits;
  > guessing invents revenue), `no_frequency_stated`, and `unpriced` (G1.6's real state — work
  > agreed and not yet priced). **The first run against the dev database found 1,490 engagements
  > stating no frequency against 34 that counted.** A total that silently dropped them would
  > have read ₹31.2 lakh and looked complete. This is G1.6's "an unpriced line stops being a
  > lie" applied to a headline figure.
  >
  > **Every figure is converted at the rate stored on the DOCUMENT**, never one looked up today
  > — the letter's `fx_rate` for a fee, the invoice's for a receivable. Re-converting at
  > today's rate would change last quarter's MRR every morning, which is the exact thing 0009's
  > reporting-currency rule exists to prevent. Proven: 100 USD/month on a letter struck at 80
  > contributes ₹8,000.
  >
  > **DSO returns NULL when the firm billed nothing, never 0.** "0 days" reads as excellent
  > collections; the truth is there is not enough billing to say. It is the one calculation in
  > TypeScript rather than SQL, because the division is a DEFINITION and belongs somewhere
  > readable and tested. The window is 90 days and is a constant, not a parameter — two screens
  > computing DSO over different windows would produce two numbers both called DSO.
  >
  > **THE FEE AXIS GATES HERE RATHER THAN REDACTING, and it is the first place in the product
  > that does.** Everywhere else `withFeeVisibility` nulls an amount and leaves the record, so
  > "you may not see this" never looks like "there is no fee". That is wrong when the whole
  > response is money: a redacted dashboard is a page of nulls, which says "this firm has no
  > revenue". So the routes refuse with a message naming the fix, and the home page offers the
  > link only on `commercialVisibility`. **Worth knowing: a partner does NOT have it by
  > default** — it is a separate flag on the membership, and a partner without it is refused.
  >
  > **`security_invoker = true` on both views**, and the integration test is the only thing that
  > would ever catch its absence: a plain view runs as its OWNER, who is not subject to the row
  > policies, so a totals view over tenant-scoped tables would be a hole straight through the
  > tenant wall that every other test would pass.
  >
  > **Two things the screens found in my own code before anyone else could**: the first cut of
  > the ageing total summed the buckets in TypeScript (`Number` + `toFixed`) — breaking the rule
  > this product keeps everywhere, that only the database adds money up — and is now one query
  > with GROUPING SETS. And the overview handler forwarded the service's own object straight to
  > the wire; the compiler refused it, because the domain carries `bucket` and `reason` as
  > strings while the wire declares closed enums. That is `api/domainerr.ts`'s trick working on
  > a response instead of an error.
  >
  > Screens: `/dashboard`. Gate: `npm run check` **1287** · `test:integration` **416**.

**Milestone M3:** full compliance cycle (spawn → work → verify → file → invoice → collect) runs with humans in the loop; money is gapless and auditable.

---

## Phase 4 · Agents A1–A11  (~5–7 weeks) — guardrails first, then capabilities

> **THIS PHASE NOW RUNS AFTER PHASE 6** (decided 2026-09-01 — see the dependency spine for
> the reasoning). **`T4.4` (A8 Chaser) has moved into Phase 6** and keeps its id; its line
> lives in the U1 block. Nothing else here moved.

Runtime guardrails (from T2.8) must hold for **all**: never commit above tier · never
contact a regulator autonomously · never invent data (flag, don't fill) · every action →
P7 with confidence · can't approve own output.

- [ ] `(B)` **T4.1** **A4 Computation** (deterministic, code not LLM): GST/TDS/payroll/challans, reproducible. *Acc: recompute delta = 0.*
- [ ] `(B)` **T4.2** **A7 Reconciliation**: ledger↔books, payment↔invoice matching. *Acc: no force-match; unmatched ages into a queue.*
- [ ] `(B)` **T4.3** **A3 Rule-Match**: facts → section/rate/form/due-date from **versioned** rule pack + confidence. *Acc: refuses to answer outside its pack version.*
- → `(B)` **T4.4** **A8 Chaser** — **MOVED TO PHASE 6**, where the portal it asks through is built. Same id, same acceptance; the line is in the U1 block.
- [x] `(B)` **T4.5** **A9 Monitor** (no human trigger): SLA timers, T–X countdowns, stale items, reassignment triggers. *Acc: alerts + spawns tasks only, never acts itself.*
  > **Done (2026-08-31). Migration 0058.** Gates on the merged tree: `check` **1391** ·
  > `notice.integration` **6/6** · `worker:once` climbed **14 rungs at a seeded firm, 7 of them
  > reaching NOBODY**, and the second run climbed none. Built out of order and the reason is
  > below; T4.1–T4.4 are untouched and were not needed.
  >
  > ── 0052 SAID THIS OUT LOUD AND NOTHING EVER FIRED ───────────────────────────────
  >
  > `0052_obligation_rule.up.sql:204` — *"the escalation ladder fires on the internal target
  > rather than the statutory"* — and `0053`'s header names the date it would watch. On the
  > morning this was written the live database held **7 work items overdue, 5 of them on
  > NOBODY's desk**, and **2 filings past `internal_target_on` with the statutory date still
  > ahead**. Every one of those was a row this product already had and never looked at.
  > `information_schema` held **zero** columns matching `%escalat%`.
  >
  > ── IT IS NOT AN AGENT, AND THAT IS WRITTEN DOWN RATHER THAN ASSUMED ─────────────
  >
  > A9 sits in Phase 4 with the agents and deliberately does NOT go through T2.8's runtime.
  > `AgentRuntime.run` is `{ tenantId, jobId, stepKey }` — step-scoped — and this has neither
  > a job nor a step: *"no human trigger"* is its own line above. It produces no proposal, so
  > there is no confidence for a tier to govern and nothing for a person to accept or correct.
  > Forcing it through would have meant a fake job and a confidence of **1.0 for arithmetic
  > over two dates**, and that number would then sit in the accuracy record making the real
  > agents look better than they are. The shape it matches is `usecase/dunning`: a clock, a
  > firm's published ladder, an idempotent write. **No new date is invented anywhere** — all
  > three watches are anchored to columns T3.1 and T3.2 already wrote.
  >
  > ── THE LADDER IS THE REGISTRY'S TENTH KIND, AND NOTHING IS SEEDED ───────────────
  >
  > `dunning` (0033) is the precedent followed exactly: one entry holds the whole ladder, a
  > published version is frozen, and *"which ladder was in force when this fired"* stays
  > answerable. **A firm with no published ladder escalates nobody** — and the wrong default
  > here does not merely annoy, it teaches everybody to ignore the one queue whose entire
  > value is being believed. `GET /api/v1/escalations` therefore returns `ladderPublished`,
  > because an empty queue at a firm that never wrote a ladder and an empty queue at a firm
  > where everything is on time are the same picture and only one means the product works.
  >
  > **Ascending is per WATCH, not across the array** — the one place this validator differs
  > from dunning's. The three watches are three independent ladders sharing an entry, and one
  > global order would force a firm to write a ladder it does not mean.
  >
  > ── WHO IT REACHES: THREE ANSWERS, AND THE THIRD IS A RANK ───────────────────────
  >
  > `assignee` · `manager` · `grade_at_least`. **The manager hop resolves TODAY, through
  > `membership.reports_to_user_id`** — G3.4 is about linking a login to a PARTY, which is a
  > different question, and the note under G3.4 already said so. `grade_at_least` is
  > deliberately NOT resolved to a person: an escalation routed to one partner is one that
  > dies while that partner is on leave, so `min_grade_rank` is stored and the reader's own
  > rank is what matches. **All three can reach NOBODY** — nobody holds it, nobody is above
  > them, nobody holds the rank — and the notice fires anyway with a sentence saying which.
  > T3.1's `assignment_note` is the same decision: 7 of the 14 rungs the first real sweep
  > climbed reached nobody, and those are the rows a partner actually has to act on.
  >
  > ── WHY THERE IS A TABLE AT ALL, AND WHY IT HAS NO `cleared_at` ──────────────────
  >
  > **THE SWEEP'S `WHERE` CLAUSE CANNOT READ THE LEDGER** — T3.3's `resolved_at` lesson, and
  > worth repeating because it is not obvious. Without `delivery.escalation_notice` the same
  > rung fires every morning for as long as the work stays open. `cleared_at` was considered
  > and refused: an escalation about a task is live exactly while that task is not terminal,
  > and one about unassigned work exactly while nobody holds it. A column restating a fact
  > two tables away is one that can disagree with it. **Proven by running it**: cancelling a
  > task dropped its three notices from the queue (14 → 11) and reopening it brought them
  > back (→ 14) with nothing re-raised.
  >
  > ── THE BOUNDARY WITH T3.3, WHICH IS WHY THESE STAYED TWO SWEEPS ─────────────────
  >
  > `obligation_target` fires between the firm's own T–X and the statutory date, and **stops
  > the moment the statutory date passes** — from there T3.3 owns the filing, it is in the
  > partner's decision queue, and two systems shouting about one filing is how both get
  > ignored. `obligation.escalated` is its own verb beside `obligation.missed` for the same
  > reason: one is the warning, the other is the money already gone.
  >
  > ── A REAL BUG THE SWEEP FOUND IN ITS OWN READ MODEL ─────────────────────────────
  >
  > The first walk produced 14 notices, three addressed to a partner BY NAME — and the queue
  > rendered a **blank space** beside "told". `tenancy.user_account.display_name` is nullable
  > and is genuinely empty at seeded firms. `raisedToName: string | null` collapsed *"told
  > somebody whose name we do not hold"* into *"told nobody"*, which is the exact shape the
  > document panel already recorded (`createdByName`) — **the email is the discriminator, not
  > the id**. Both people are now `{ userId, displayName, email }`, the shape `EventRecord.actor`
  > has. A read model carrying a name and not an email is not a read model; that is six times.
  >
  > ── THE SCREENS ─────────────────────────────────────────────────────────────────
  >
  > `/work-items` gains a fourth tab, **Escalated**, with its own renderer — it is not the
  > board sliced, it is the record that somebody was TOLD about work. **No dismiss, no snooze,
  > no acknowledge**: a notice ends when the work moves, and a button that emptied the queue
  > without anything happening would make it decoration. `/admin/escalation-ladder` is new —
  > draft and publish, `tenant:admin`, a grade picker rather than a number, and the one
  > impossible combination (watch unassigned work, notify its assignee) is moved off rather
  > than left to 400.
  >
  > **No new permission.** Reading is `party:read`, exactly as T3.3's decision queue is, and
  > for its stated reason: a queue narrowed to what you personally may act on hides that six
  > tasks have been escalated for a week because nobody senior enough looked.
  >
  > ── WHAT THE BROWSER WALK FOUND, AND IT WAS TWO THINGS ──────────────────────────
  >
  > The chain was first exercised over HTTP with a real session — the empty queue with
  > `ladderPublished:false`, three validator refusals each naming the rung and the fix,
  > publish, sweep, the queue, `?mine=true` (7 of 14 for a rank-10 partner), the live-join
  > proof above, and the ledger payloads. **The extension then connected and the screens were
  > walked**, which found two faults typechecking was perfectly happy with:
  >
  > **THE `FOR` COLUMN READ AS WRONG.** A row titled *"TDS deposit — Lakeview LOGISTICS"* sat
  > over a cell saying *"Lakeview Foods"* — correct data (one is billed, the other files) and
  > indistinguishable from a bug. The board already solves this and this screen had not
  > copied it: **G0.1, a group of four companies files four sets of returns**, so `entityName`
  > now sits beneath the client exactly as `WorkRow` puts it there. `clientName` is null on a
  > filing rather than being backfilled from the entity — an obligation has no client at all,
  > and the queue shows an em dash and names the company underneath.
  >
  > **A HINT INSIDE A `<FieldRow>` COLUMN, FOR THE THIRD TIME IN THIS APP.** `.field-row` is
  > `align-items: end`, so a field carrying a hint stands taller and its INPUT rides up above
  > the ones beside it. The ladder form's two text boxes sat at two different heights and the
  > Remove button floated between them. The frontend `CLAUDE.md` has recorded this twice
  > already, T6.4 re-made it, and this is the third — hints go in a `<p className="field-hint">`
  > UNDER the row, and a button gets its own line because `.field-row > *` is `flex: 1 1 160px`
  > and turns one into a banner.
  >
  > **The form was then re-opened and re-checked, and found two more.** `"Everybody at a grade
  > and above"` rendered as `"Everybody at a grade and abo"` — choosing that option ADDS a
  > fourth column to the row and every select narrows, which no other state of the form shows.
  > It reads `"A grade and above"` now. And the two hint halves were concatenated into one
  > run-on paragraph: what a rung WATCHES and who it TELLS are separate answers and a reader
  > checks one at a time, so they are two lines.
  >
  > **The synthetic-click wall is worth recording precisely, because a way through it exists.**
  > The extension's clicks and keypresses stopped reaching React — the same wall at the top of
  > T3.2 and T3.3 — including on a FRESH tab, so "it only happens after the first interaction"
  > is not the rule. What works is `javascript_tool` calling `.click()` on the element: React's
  > synthetic event system handles that, and the whole form was driven and eyeballed that way.
  > Reach for it as soon as a second click does nothing rather than retrying the first.
  >
  > **Demo data was CHANGED and is not restored.** At `demo-1788079646`: the partner was put
  > on the Partner rung, two reporting lines were recorded, and an escalation ladder was
  > published. 14 notices and 14 ledger events followed; the events are append-only and stay.
- [ ] `(B)` **T4.6** **A10 Rule-Pack Watcher**: reads CBDT/CBIC/MCA notices → drafts version diffs for approval. *Acc: never auto-activates a version.*
- [ ] `(A)` **T4.7** **A1 Intake**: OCR, classify, extract, dedupe, attach. Extraction **port** with deterministic fake. *Acc: ambiguous doc routes to human, isn't discarded.*
- [ ] `(A)` **T4.8** **A2 Enrichment**: MCA/GST/public lookups → fill record, flag conflicts. *Acc: never overwrites human-entered data.*
- [ ] `(A)` **T4.9** **A5 Drafting**: returns, proposals, letters, DD reports, query responses. *Acc: sends nothing externally; asserts no unverified fact.*
- [ ] `(A)` **T4.10** **A6 Validation**: completeness, cross-checks vs books/prior periods, anomaly scan. *Acc: flags only, never fixes.*
- [ ] `(A)` **T4.11** **A11 Context Writer** (pgvector RAG): approved positions/outcomes → per-client context, **hard tenancy wall**. *Acc: cross-client retrieval is impossible (RLS-filtered vector search).*

**Milestone M4 (now AFTER M5, with the phase reorder):** the confidence-routed autonomy loop works — agents draft, machines check, humans approve, everything scored and logged.

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

## Phase 6 · Client portal (U1) + the Chaser  (~4–6 weeks) — **THIS IS NEXT, BEFORE PHASE 4**

> **Reordered 2026-09-01, and `(B)` owns the whole of it.** Phase 3 made the FIRM's work
> visible; it did nothing about the hours the firm spends chasing its own clients, which is
> where the manual time at a CA firm actually goes. This phase closes that loop, and `T4.4`
> (the Chaser) comes with it — a portal with nothing asking through it is a filing cabinet,
> and a chaser with no portal is email. Reasoning in full on the dependency spine.
>
> **`M5 (Sellable V1)` is reached at the END of this phase**, with agents still stubbed and
> humans in the loop. `M4` moves to the end of Phase 4.

**UI does NOT start here.** The staff workspace (U2) is built **vertically from ~week 4** —
each dev skins their own modules as the API stabilizes (the T6.1–T6.4 tasks below land during
Phases 2–5, not now). This phase is the **client-facing portal (U1)** and cross-app polish.

### U2 · 10X workspace (staff) — built vertically during Phases 2–5, tracked here
- [x] `(B)` **T6.1** App shell, auth'd nav, work board (Kanban), verification queue screen. *(with Ph2–3)*
  > **DONE 2026-08-31, and walked in the browser before the box was ticked.**
  >
  > · **App shell** — built, by `(A)`'s design system (frontend `a099fdf`): `AppShell`, a
  >   sidebar in sections, a theme switch. The per-screen navs are gone, which was the point.
  > · **Auth'd nav** — built. Every sidebar entry carries `needs: "<permission>"` and the fee
  >   axis carries a `when` predicate, all resolved from `/auth/me`. A link is offered only to
  >   somebody who can use it, and the API still refuses independently.
  > · **Verification queue** — built (T2.9). `/work`'s "To check" tab, the WHOLE FIRM's queue
  >   with `viewer.eligible` and, when false, the reason in words.
  > · **Work board (Kanban)** — was NOT built; `/work-items` was a tabbed TABLE. It is now
  >   `work-items/board.tsx`.
  >
  > **WHAT THE WALK PROVED, rather than what the types allowed.** Ticking "include finished
  > work" produced the **Completed** and **Cancelled** columns; the rest of the time they are
  > absent, which is the terminal-state rule. And the board rendered a column headed **"Stuck"**
  > — the firm renamed "Blocked" in an earlier session, and the board says the firm's word
  > because the columns are its rows. That is the promise 0050 made, kept on the screen where it
  > shows most, demonstrated rather than asserted. **The auth'd nav was walked as a NON-ADMIN
  > too**: signed in as the associate, the whole Administration section, the audit trail and
  > "The firm's numbers" all disappear — permissions, `ledger:read` and the fee axis
  > respectively — and the board still renders, because `/work-vocabulary` is `party:read` like
  > the board itself.
  >
  > **What the board is, and the two decisions in it.** The COLUMNS are the firm's own
  > `work_item_state` rows, ordered by its own `sortOrder` — 0050 made them rows precisely so a
  > firm could rename "Blocked" to "Stuck", and a board with hardcoded columns takes that back
  > on the screen where it shows most. A state with no items still gets a column, because
  > "nothing is under review" is a fact worth seeing and a board that changed shape as work
  > moved would be unreadable week to week.
  >
  > **THERE IS NO DRAG-AND-DROP, deliberately.** Moving an item into a state the firm has
  > flagged `is_blocked` REQUIRES a written reason — the service refuses without one and so
  > does a trigger — so a drag would produce a refusal with nowhere to type the answer. And
  > every state change writes an audit event naming its actor, which is not a thing to make one
  > pixel of slippage away from. A card links to the item, where the state picker already opens
  > the reason box the moment a blocked state is chosen.
  >
  > **Board or list is a VIEW, not a fourth tab.** The three tabs are three different questions
  > — whose desk, nobody's desk, everybody's desk. Drawing is a different axis, and a fourth tab
  > would have left "Mine, as a board" nowhere to live.
  >
  > ── **FIVE THINGS LOOKING AT IT FOUND, and typechecking was happy with all five** ──
  >
  > 1. **The card read `2026-05-22 · late High`** — one phrase, with the priority looking like
  >    part of the lateness. The LIST never showed it because its two facts sit in two table
  >    cells; on a card they share a line, and a card is what somebody scans fastest.
  > 2. **The column count sat at the far edge** of a wide column, disconnected from the state it
  >    counts. `space-between` did that; it sits beside the name now.
  > 3. **Four fields at four different heights** in the rule editor. `.field-row` is
  >    `align-items: end`, so a field carrying a hint stands taller and its INPUT rides up.
  >    `/admin/workflows` learnt this and it is written in the frontend `CLAUDE.md`; T6.4
  >    re-made it. Every hint now sits below its row.
  > 4. **Writing a new rule always failed on the first press.** The form opened on "it depends
  >    on something this system does not hold" with an empty reason, so the first Write was
  >    always a refusal. "Waiting on a fact" is the SHIPPED PACK's condition — forty-seven rules
  >    imported from a document — not the state somebody typing a rule is in. They are writing
  >    it because they know when it is due, so a new rule now defaults to computing a date.
  > 5. **`/calendar`'s new deep link told a lie on one reason.** `nothing_due_yet` means the
  >    rules match, can compute dates, and simply have no period in the window yet — nothing is
  >    blocked — and the link beside it said "47 rules →" into a banner reading "the rules that
  >    blocked this engagement's calendar". The link is now offered only where the reason has a
  >    fix, which the `REASONS` table already recorded.
  >
  > **The supersede screen (0057) was walked in the same pass**, on a throwaway rule so the
  > shipped pack stayed clean: written from the "Write a rule" form, handed over at 2026-09-01
  > with the pack error firing live on the default (`firm@2026` was the rule's own pack), the
  > was/now formula comparison updating as the day was typed, **"Handed over. 24 filings added
  > to the calendar."**, and then the predecessor row showing *hands over on 2026-09-01* against
  > the successor's *governs periods from 2026-09-01*. Opening the predecessor offers no "the
  > law changed" button at all — it shows the notice instead, which is what the API would answer.
  > Both rules and their 24 filings were deleted afterwards, scoped by `tenant_id`.
- [ ] `(A)` **T6.2** Client 360 (as-of date), leads pipeline, proposal/EL builder. *(first screen ~week 4–5, with Ph1–2)*
- [ ] `(A)` **T6.3** Invoicing + collections screens, leadership dashboards (MRR/DSO/ageing). *(with Ph3)*
- [x] `(B)` **T6.4** Compliance calendar + rules screen (config a partner can edit — the "row with a screen" bar). *(with Ph3)*
  > The calendar view, the partner's decision queue (T3.3), and a rules page a partner can actually use — **including confirming an `unconfirmed` rule**, which is what makes T3.2's seeding honest rather than a permanent asterisk. *Acc: a partner changes a due-date rule without a deploy, and the screen shows which rules the firm has not yet confirmed.* Config held as rows is only half the promise if editing it still needs a developer — that is the "row with a screen" bar. The demo's `10xcrm/src/app/calendar/rules/` is 627 lines and is the working spec.
  >
  > **DONE.** The calendar, the decision queue and the confirmation tick shipped with T3.2/T3.3;
  > the half that had not was the FORMULA. The API had taken a full `dueRule`, a new rule and
  > exceptions since T3.2 **with no caller anywhere** — the screen wrote three fields out of
  > twelve — so forty-seven shipped rules were never going to start generating however well the
  > firm knew the answer. Walked in the browser: answered `DPDP compliance` and watched **4
  > filings appear**, added a March carve-out and watched **those 4 move**, withdrew it and
  > watched them move back. That test data was reverted afterwards; see the open items.
  >
  > **An edit MOVES the calendar that is already there, and says how much.** Generation is
  > idempotent on `(tenant, template, entity, period_start)` and the sweep materialises a year
  > ahead, so without this a partner corrects a formula and the next twelve months keep the old
  > date forever — the trap `redateUnstarted` was built for, reached from the other side. So
  > `redateUnstarted` is gone and `listUnstarted` + `restate` replace it, re-deriving dates with
  > **`scheduleFor` — the generator's own function**, never arithmetic in SQL, which would be a
  > second implementation of the due-date rules that parts company the first time an exception is
  > involved. Every rule write returns a `RuleEffect` (`restated` / `locked` / `spawned`) and the
  > screen shows all three: **`locked` is the half nobody would ask for** — the filings already on
  > somebody's desk, left alone — and a partial change reported as a whole one is how a deadline
  > moves without anybody being told.
  >
  > **It restates the STATUTORY date, and that is a deliberate reversal.** A lead time is the
  > firm's own practice and the law's date is not in question there; when the FORMULA changes, the
  > old statutory date was this system's guess from a vendor's document and the new one is the
  > firm's answer. Leaving a date we now know to be wrong, on the grounds that the law's date is
  > not ours to change, would keep a wrong legal deadline out of respect for the law.
  >
  > **The period shape is locked once rows exist** (`PERIOD_SHAPE_LOCKED`, 409). `recurrence` and
  > `fiscalYearStartMonth` decide where a period BEGINS and `period_start` is the dedup key, so
  > moving either under existing rows orphans all of them, the next sweep generates a second copy
  > of work already done, and nothing reports an error. Editable exactly while the rule has
  > produced nothing — which is the state of all forty-seven a partner has to answer.
  >
  > **Answering a rule fills the calendar NOW; creating one does not.** `updateRule` generates on
  > the CROSSING into producing dates, because the partner has just been asked a question and is
  > owed the result of their answer. `createRule` deliberately does not: somebody writing a rule
  > types the formula first and the March carve-out second, so generating on the first save would
  > put a year of filings on the calendar from a half-written rule. A brand-new rule is what the
  > nightly sweep is for, and the screen says so rather than leaving somebody watching an empty
  > calendar.
  >
  > **What was decided rather than asked, and on what.** Industry practice on effective-dated
  > regulatory data separates a CORRECTION (the fact was recorded wrong — fix it, and everything
  > derived from it) from an AMENDMENT (the law changed from a date — a new record, the old one
  > still explaining what it explained). This schema already encodes which is which: `status`
  > `unconfirmed` means nobody has checked the date against the statute, so an edit there is a
  > correction; a period-specific legal change is an EXCEPTION, which is what a CBDT or GST
  > extension actually is and which was already built. So a formula edit is in-place and restates,
  > an exception is the amendment path, and effective-dated supersession is NOT built — below.
  >
  > **The count is the control, and there is no onboarding checklist.** "47 waiting on a fact" is
  > now a button that filters. A separate "answer these 47" checklist was considered and refused:
  > a checklist measures COMPLETION, and most firms will rightly never answer rules their clients
  > do not owe, so a permanent 12/47 is a product nagging about work nobody should do. The
  > outcome-linked surface already existed and was unread — `CoverageGap.blockedRuleIds` has been
  > on `/calendar/coverage` since T3.2 with no consumer, so every engagement there sent a partner
  > to a list of fifty-seven to find the two that concerned them. The coverage tab now deep-links
  > `?rules=...` and the rules screen focuses exactly those.
  >
  > **A firm's own rules go in `firm@<year>`**, prefilled and editable, kept clear of the shipped
  > `gst-in@...` / `in-firm-sheet@...` namespace so re-seeding a vendor pack can never collide
  > with an answer the firm wrote itself. The unique key is `(tenant, jurisdiction, name,
  > rule_pack)`, so the namespace is the collision boundary rather than a label.
  >
  > **`restate`'s SQL is executed by an integration test, not a fake.**
  > `tests/obligation/restate.integration.test.ts` runs the real repository. It uses the same
  > `jsonb_to_recordset(...::text::jsonb)` construction whose sibling four hundred lines above
  > needed the double cast to run at all — a bug found by RUNNING the worker, because the unit
  > tests use a fake and the old integration test inserted rows by hand. It also proves the WHERE
  > clause refuses a row somebody picked up between the read and the write, which is what makes
  > the reported count honest.
  >
  > **Found by reading the ledger after using the screen:** `obligation_rule.updated` carried what
  > an edit did to the calendar and the two exception verbs did not. Both carry `restated` and
  > `locked` now. Neither carries the note — prose does not `GROUP BY`, and this log cannot be
  > erased.
  >
  > ~~**STILL OPEN**: a CONFIRMED rule whose formula the law genuinely changes mid-life should
  > become a new row with `supersedes_id` and a cutover.~~ **BUILT 2026-08-31, migration 0057.**
  > See below.
  >
  > ── **SUPERSESSION — the amendment, as against the correction (0057)** ──
  >
  > A rule now has a WINDOW: `effective_from` / `effective_to`, half-open, both nullable, both
  > null on every row that exists — so applying it moved no calendar and changed no firm's
  > behaviour.
  >
  > **The window is tested against the PERIOD START, never the due date**, and that is the
  > decision the whole thing turns on. The rule governing a filing is the one in force for the
  > PERIOD BEING FILED: August's return is August's law even though it falls due on 20
  > September, so a change effective 1 September must not reach back and restate August.
  > Testing the due date would move every date by exactly one period and look entirely
  > plausible. `governsPeriod` in the domain names it once, so the generator and the screen
  > cannot disagree.
  >
  > **Half-open, and the demo already made the inclusive mistake once.** `effective_to` is the
  > first day NOT in force, so a rule ending on the 1st and its successor starting on the 1st
  > govern one period each. Inclusive bounds gave the demo two SPOCs on every changeover day;
  > the same error here is two filings for one return, generated under different template ids
  > that the re-run key `(tenant, template, entity, period_start)` cannot deduplicate.
  >
  > **`supersede` is ONE repository method and one transaction, and that is the point.** Each
  > half alone is a silently broken calendar in opposite directions: a closed predecessor with
  > no successor stops the firm's clients being told about a filing they still owe, and a
  > successor written while the predecessor is still open puts every later return on the
  > calendar TWICE. `supersede.integration.test.ts` proves the rollback specifically — a
  > successor colliding on the rule's identity leaves the predecessor OPEN — because that is
  > the property a fake cannot establish and the one that costs money when it is wrong.
  >
  > **The predecessor is CLOSED, not retired.** Retiring stops it generating at all, including
  > for periods before the cutover that the ninety-day reach-back has not materialised yet — a
  > client onboarded last month would silently lose the period it was engaged for. A window
  > says WHICH PERIODS each row governs, which is the actual question; `is_active` says whether
  > the row is switched on, which is not.
  >
  > **Three refusals, each with a sentence:** a cutover at or before the rule's own start
  > (`CUTOVER_BEFORE_START` — the rule would govern nothing), a successor reusing the
  > predecessor's pack (`SUCCESSOR_NEEDS_ITS_OWN_PACK` — a pack is part of the identity, so it
  > would collide on the unique key), and superseding a rule that already hands over
  > (`ALREADY_SUPERSEDED`, 409 — two successors covering one period is two filings for one
  > return). All three fire BEFORE the write, so a refusal never leaves a half-closed rule.
  >
  > **`obligation_rule.superseded` is the new verb**, carrying the cutover, both packs and both
  > formulas — "which rule was this return due under" is the question an audit asks, and the
  > answer moved on a date. The contract-parity test caught it missing from
  > `EVENT-CONTRACT.md` on the first run, which is that test doing exactly its job.
  >
  > **Walked through the real API with a real session**, on a throwaway rule so the shipped 57
  > were untouched: created, superseded at 2026-09-01, and the successor generated **24 filings
  > starting exactly 2026-09-01** — not a day earlier, though the generation window reaches
  > back to June — with **zero periods duplicated per entity**. Both refusals answered 409 and
  > 400 with their sentences. The rows were then deleted, scoped by `tenant_id` this time.
  > **The screen was walked too** — see T6.1's note, which records the whole pass and the five
  > faults it found.

### U1 · Client portal (client) — the real Phase 6 work, and **all of it is `(B)`'s**

**Order matters here and it is not the numbering.** `G3.4` first (nothing may be read by a
portal session until the gate exists), then `T6.5` (who is looking), then `T6.6` and `T4.4`
together (what is asked for, and who does the asking), then `T6.7`.

- [x] `(B)` **G3.4** **Gate 4 — record-scope.** `membership.party_id`, and the rule that a portal session sees its OWN company's records and nothing else. *Acc: a portal login cannot read another client's anything, proven by a test that tries.* — full entry in Phase 3; **do this before any portal screen**, or every query gets written twice.
  > **THE WALL IS IN (2026-09-01, migration 0059). THE WRITE PATH IS NOT — and this box stays
  > `[~]` for exactly that reason.** What exists: `membership.party_id` (which PERSON a login
  > is), `crm.portal_access` (which COMPANIES it was granted, effective-dated, one row per
  > company), `withPortal` in `src/db/tenant.ts`, `crm.portal_sees()` and a RESTRICTIVE policy
  > on `delivery.work_item`.
  >
  > **The acceptance line is met and was proven by NEGATIVE CONTROL**, which is the only way
  > it is worth anything: `tests/portal/gate4.integration.test.ts` asks for the other client's
  > row BY ID and gets nothing, a portal session with no grants sees nothing at all, a write
  > is refused, the scope does not survive the transaction, and a STAFF session is untouched.
  > Dropping the policy turns five of those six red; putting it back turns them green.
  >
  > **THE WRITE PATH IS IN TOO (2026-09-01, migration 0060).** `usecase/portalaccess` —
  > grant, end, and the scope one session resolves to — with `portal_access.granted` /
  > `portal_access.ended` in the ledger, five staff-only routes, and **`portal:grant`, the
  > ninth permission**, partner-only by default. Not `tenant:admin` (a firm may want the
  > partner who owns the relationship to invite that client's CFO without also handing them
  > the roster) and not `party:write` (G3.2 gave client OWNERSHIP that permission on the
  > ground that naming a Key Manager grants nobody anything — this is the opposite kind of
  > act, and the only permission in the product that hands somebody OUTSIDE the firm a view
  > of the firm's work). The READS carry it too: the list names a client's own people.
  >
  > Every refusal in the service is one the database cannot make — a staff login, a revoked
  > one, an archived client — while the exclusion constraint still holds the duplicate under
  > concurrency. 21 unit tests; walked over HTTP against the seeded firm (409 for a staff
  > login, 409 for a duplicate, 403 for a manager, 200 to end, 409 to end twice, and the
  > ended row still on the history). `demo:verify` 71/71 after the walk's row was removed.
  >
  > **ANSWERED (2026-09-01, migration 0061): REMOVE MEANS NOW.** Shrestha's call. `end`
  > defaults to TODAY, so access is gone on the next request rather than at midnight — the
  > walk is what settled it: press remove, ask for the scope, and the client was still there.
  > The row now understates that person by part of a day and nothing is lost, because
  > `portal_access.ended` carries the INSTANT: the row is date-grained, the ledger is not.
  >
  > 0061 relaxed the CHECK to `valid_to >= valid_from`, which is what makes **granted at
  > 10:00, revoked at 10:01** representable at all — an EMPTY range, in force on no day.
  > `daterange(d, d, '[)')` is empty and `&&` never matches it, so the exclusion constraint
  > keeps working and an empty grant cannot block the re-grant after it. **Creating one that
  > way is still refused by the service**: a grant in force on no day is a typo at the moment
  > of granting, while ending one is a decision taken twenty seconds later. The database
  > allows the shape; the service allows only the act. Its `down` deliberately FAILS against
  > any empty row a firm has since recorded, rather than re-dating an access record.
  >
  > Proven over HTTP: granted, scope 1; ended, `validFrom == validTo`; scope EMPTY on the
  > next call; the row still on the history.
  >
  > **CLOSED 2026-09-01 with T6.5.** Both halves that were left have landed and have a consumer:
  > `/auth/me` carries `portalScope`, and `usecase/portalhome` resolves a session's grants ONCE
  > per request into `withPortal`. The acceptance line — *"a portal login cannot read another
  > client's anything, proven by a test that tries"* — now holds over a real read as well as
  > over a raw query: `tests/portal/portal-reads.integration.test.ts` asks for the other client's
  > filing BY ID and gets nothing, and every one of its assertions was watched go RED with its
  > policy dropped and green with it back.
  >
  > **Migration 0062 added the second and third policies**, one table at a time as the rule says:
  > `delivery.obligation_instance` on **`entity_party_id`** (that table names the ENTITY, never
  > the client — 0053), and `is_client_visible` on `delivery.work_item` as a SECOND restrictive
  > policy. The entity-scoping is a decision, taken with Shrestha on 2026-09-01: a contact
  > granted Cobalt Foods sees Foods' filings and NOT its subsidiary's, and reaching the
  > subsidiary would mean joining `crm.engagement` — a NULLABLE join, and exactly the derivation
  > 0059 refused. Two companies means two grants.
  >
  > **Decision recorded in the migration and in CLAUDE.md: access is GRANTED, never DERIVED.**
  > `core.party_relationship` could answer "this contact is in the Kaveri group" with one
  > join, and then a CRM edit — reviewed by nobody as an access change — would silently hand a
  > Cobalt contact the group's filings. No default and no widening: a contact who should see
  > four companies gets four rows. Whether a group's contact SHOULD see all four is a client
  > fact nobody has been asked (G0.1), and a join would have answered it for them.
- [x] `(B)` **T6.5** Invite + secure login, per-contact roles, status home. *Acc: a client contact signs in and sees only their own company.*
  > **STARTED 2026-09-01 — the SESSION is scoped now, which is the block everything else sits
  > on.** `/auth/me` carries `portalScope` for a CLIENT_PORTAL session: the companies it may
  > read TODAY, **by name**, resolved once here rather than looked up per screen. NULL for a
  > staff session and an EMPTY ARRAY for a contact who has been invited and granted nothing —
  > two different facts, and the portal must not draw them the same way ("does not apply"
  > versus "nothing yet, ask the firm").
  >
  > It resolves by USER and audience rather than by membership id, because a portal request
  > carries a principal that names neither the membership row nor anything but the audience —
  > and putting `membershipId` on the principal would ripple through identity, the resolver
  > and every test that builds one, to buy an id the join already has.
  >
  > Walked end to end against the seeded firm as the real portal contact
  > (`meera@cobaltfoods.in`): no grant → `[]`, granted → `["Cobalt Foods Private Limited"]`,
  > staff session → `null`, access removed → `[]` on the very next call, and `/work-items`
  > still **403** because gate 2 refuses the staff surface before any of this is consulted.
  >
  > **DONE 2026-09-01, and the acceptance line was walked in the browser** as
  > `meera@cobaltfoods.in`: sign in at `/login` → routed to `/portal` by AUDIENCE → "Hello,
  > Meera · What 10x Global is doing for Cobalt Foods Private Limited", with what is held up
  > (and the reason, verbatim), 22 filings still owed, 18 pieces of work under way and one
  > filing made. Lakeview's and Harbour's rows are nowhere on it, and `/work-items`,
  > `/clients` and `/calendar` all still answer **403** because gate 2 refuses the staff
  > surface before any of this is consulted.
  >
  > **What shipped:** migration 0062 (two more restrictive policies), `usecase/portalhome`,
  > `GET /api/v1/portal/home` — the fifth `PORTAL_PATH` and the first that returns a business
  > record — `PostgresPortalHomeRepository`, the ONE adapter in the product that uses
  > `withPortal`, and on the frontend `/portal` with its own frame, `/portal/accept-invite`
  > (the page the invite email had been pointing at since the invite flow shipped, and which
  > did not exist), and audience routing on `/login`.
  >
  > **GATE 2 IS AN EXACT PATH MATCH AND THAT SHAPED THE API.** `PORTAL_PATHS.has(c.req.path)`
  > compares the concrete path, unlike gate 3 which compiles templates — so a portal route with
  > a path parameter is unreachable whatever is written in that set. The status home is
  > therefore one parameter-less aggregate read. **T6.6 cannot add an upload route until that
  > matcher learns templates**, and that is a change to the audience gate, not a line in a set.
  >
  > **PER-CONTACT ROLES MOVE TO T6.6, deliberately.** They need a role that declares its
  > AUDIENCE and a migration, and their first real consumer is a verb — upload, answer, approve
  > — which does not exist yet. The status home needs no permission: being invited and granted
  > a company IS the authorisation, recorded as a row with a granter, a date and a ledger event.
  > Shipping the permission first would register something no route checks, which this codebase
  > has now paid for four times.
  >
  > **`is_client_visible` HAD A WRITER AND NO READER SINCE 0051** — the fourth of those. The
  > portal is its reader now, enforced as a POLICY rather than a filter, and
  > `/work-items/[workItemId]` grew the switch that sets it in the same commit: a flag the
  > portal enforces and no screen can change is a wall built against a value nobody can move.
  >
  > **Three things only opening the page could find**, all fixed: a heading reading "Filings
  > coming up" over five rows already past their date and marked Missed; the same filing listed
  > TWICE, once as the law's row and once as the firm's task (the calendar raises one per
  > obligation); and the demo showing *"Decide the credit hold on INV/2026-27/0003"* — an
  > internal decision about the client's money — on the client's own page, because
  > `is_client_visible` defaults true and nothing had ever set it false.
  >
  > **And one only running it could find:** postgres.js sends parameters untyped, so
  > `${asOf}::date + ${90}` is *"operator is not unique: date + unknown"* and the first real
  > request was a **500**. T3.2's `::text::jsonb` lesson, again.
  >
  > **The demo seed now grants Meera Cobalt Foods and files one obligation** (through the
  > product's own path — a person ticks the task and `reconcileFiling` closes the filing), so
  > all four sections of the portal have something in them. `demo:verify` stays **71/71**.
- [x] `(B)` **T6.6** Action centre: uploads (virus-scan/OCR/auto-file), questions, one-tap approvals. *Acc: a client upload files itself against the job that asked for it.*
  > **THREE THINGS T6.5 HANDED IT, stated so they are not rediscovered.**
  >
  > **1 · `PORTAL_PATHS` MUST LEARN TEMPLATES FIRST.** Gate 2 is an exact match on the concrete
  > path, so every route this task wants — an upload against a document, an answer to one
  > question, an approval of one thing — is unreachable until the audience gate matches
  > `{param}` the way gate 3 already does. Do it as its own change, with its own test: it
  > widens the gate that stops a client contact reading the firm's whole book.
  >
  > **2 · PER-CONTACT ROLES BELONG HERE, and this is where they finally have a consumer.**
  > "This contact may upload, that one may only look" needs a role that declares its AUDIENCE
  > (a migration — `DEFAULT_ROLES`, the seed-parity test, and `AuthzService.permissionsOf`,
  > which returns `[]` for every portal session today). `tests/api/portal-permissions.test.ts`
  > goes red the moment a portal route requires a permission, which is the reminder.
  >
  > **3 · THE CLIENT-DIRECTED ASK IS THIS TASK'S, and the portal is honest about not having it.**
  > T6.5's "Held up" section shows `work_item.blocked_reason` verbatim, under a line saying
  > whose words it is, because nothing in the schema records who a task is WAITING ON — the
  > same sentence reads "the client has not sent the register" or "the GST portal is down". A
  > row that says *we are waiting on YOU*, with somewhere to answer it, is what this builds.
  > Documents and invoices are also still absent from the portal, and the page says so out loud
  > rather than letting a client conclude the firm has not billed them.

  > **DONE 2026-09-01, and the acceptance line was walked in the browser** as
  > `meera@cobaltfoods.in`: a document ask, a question and an approval on the action centre;
  > uploaded a file against the one the firm raised on the blocked task; approved the
  > management pack with a reason; and the file arrived on the firm's own
  > `/work-items/[workItemId]` marked *"Answered — needs a look"* with the two buttons that
  > close it. **A second client's records stayed unreachable throughout** — an ask raised for
  > Lakeview answered **404** by id, was absent from the list, and `/clients` and
  > `/work-items` still answered **403**.
  >
  > **1 · THE GATE-2 MATCHER SHIPPED FIRST AND ALONE** (`19d5ae3`), before any route needed
  > it. `PORTAL_PATHS` now carries `{param}` templates compiled the way gate 3 compiles them.
  > What contains the widening is a test rather than care: `auth-coverage` asserts, over EVERY
  > registered route, that `isPortalPath(concrete(path))` equals plain membership of that
  > route's TEMPLATE. Watched go red with `/api/v1/work-items/{workItemId}` added to the list,
  > and the matcher's own unit test watched go red with the `$` anchor removed. `asTemplate()`
  > was the half that was not optional — Hono registers `:name` while both permission tables
  > are keyed by `{name}`, so a templated portal route would have looked undeclared.
  >
  > **2 · THE ASK LIVES IN `delivery` AND HANGS OFF A WORK ITEM** (0063). Not `crm`: an ask
  > exists because WORK cannot move. `work_item_id` is NOT NULL, and that is what lets its
  > `client_party_id` — the column gate 4 filters on — be held to the work item's by a
  > COMPOSITE foreign key. The wall column is denormalised and **cannot disagree**, rather
  > than being trusted; nothing on either surface accepts a client party at all, it is read
  > from the work item inside the INSERT. **No due date, and its absence is the API's own
  > statement.** `answered` is not `closed` (Shrestha's call): a client who sent last
  > quarter's register must not see the ask marked done. Responses are **append-only by
  > GRANT** — a client's answer is evidence.
  >
  > **THE WALL, ON THE WRITE SIDE FOR THE FIRST TIME.** 0059 and 0062 wrote `WITH CHECK` while
  > saying no portal write path existed, *"which is why it will not have to be built with the
  > rule inside it"*. This is that path and the promise held: not one statement in
  > `PostgresPortalAskRepository` — the product's SECOND `withPortal` adapter and the first
  > that writes — names `client_party_id`. Five new policies: the ask, its responses, and
  > `files.document`, `document_version` and `document_link`, which 0037 wrote `party_id` for
  > and which have had no policy since. NULL there means the firm's own and denies correctly,
  > which the migration states because it does not look deliberate in the SQL.
  > `document_version` is guarded by an EXISTS on its parent, and that is what finally makes
  > T3.6's *"no pre-signed URL, the key is unreachable"* claim TRUE.
  >
  > **PROVEN BY NEGATIVE CONTROL**, which is the only way it is worth anything:
  > `tests/portal/client-ask.integration.test.ts` is 16 tests, and dropping the five policies
  > turns 3, 1, 5, 2 and 1 of them red respectively — then green with each put back.
  >
  > **3 · PER-CONTACT ROLES LANDED HERE BECAUSE HERE IS WHERE THEY GET A CONSUMER** (0064).
  > `portal:respond` is the tenth permission and the only one held by somebody outside the
  > firm. `permissionsOf` returned `[]` for every portal session, which was ARITHMETIC and
  > documented as such; `portal-permissions.test.ts` was written to go red the day it stopped
  > being true, and it did. The fix is the one CLAUDE.md always named: **a role declares its
  > AUDIENCE and a role written for the other one grants nothing** — BOTH ways, because
  > `portal:respond` on `associate` is as wrong as `manager` on a portal login.
  > `client_contact` may respond, `client_viewer` may only look, and **both see everything**,
  > because reading is authorised by the grant and never by a permission. Walked: Meera as
  > `client_viewer` saw all three asks, was offered no control, and the API answered 403 with
  > *"role `client_viewer` does not carry `portal:respond`"*.
  >
  > **VIRUS-SCAN / OCR / AUTO-FILE: NONE, AND NO PORT EITHER.** There is no scanner and no
  > agent runtime (`NoAgentsBuiltYet` is still what `setup/` wires), so all three would be
  > contracts written against nothing — and T3.6 wrote a `DocumentRenderer` port and DELETED
  > IT BEFORE COMMIT under exactly that rule. A `scan()` returning "clean" is a lie with a
  > signature; one that threw would make uploads impossible. So it is SAID instead: the file
  > is stored unscanned, the firm's screen says *"not scanned"* beside it, and
  > `content-disposition: attachment` is the one protection that does exist. **Open for
  > Shrestha to overrule** — a real scanner arrives with a consumer.
  >
  > **WHAT WALKING IT FOUND, AND WHAT NONE OF THE TESTS DID — four things.**
  >
  > · **THE PAGE SAID THE REQUEST TWICE.** The action centre showed *"Please send the
  >   Maharashtra purchase register"* with a file picker under it, and "Held up" printed the
  >   identical sentence out of `blocked_reason` with nothing to do about it. T6.5's own
  >   duplication bug in a new costume. `hasOpenAsk` is on the row now and the held-up card
  >   points at the ask instead of repeating it — and the asymmetry falls out of RLS again: an
  >   ask the reader was not granted is invisible to the EXISTS, so the reason is shown, which
  >   is right, because it is then the only thing saying what is wanted.
  > · **THE FOOTER STARTED LYING.** *"sending files across is not here yet — email 10x Global
  >   as you do now"*, one paragraph below a working file picker. Nothing in a typecheck, a
  >   lint or a test can see a sentence go stale.
  > · **A READ-ONLY CONTACT WAS PROMISED SOMETHING.** *"if you sent the wrong thing, you can
  >   still send another"* — beside a card with no controls, and because all their asks were
  >   answered it was the only sentence about them on the page.
  > · **AND THE POINTER NAMED THE WRONG HEADING.** *"it is under Waiting on you"* on an ask
  >   that had been answered and therefore sat under "Sent — with the firm". Found by reading
  >   the page again after answering something on it.
  >
  > **AND ONE THE WALK FOUND IN A TEST RATHER THAN ON A SCREEN.**
  > `tests/filestore/model.test.ts` was PINNED TO 0037, and 0063 widened `subject_kind` by
  > dropping that CHECK and adding a new one — which an applied migration must do. So the test
  > went on reading seven members out of a constraint the database no longer had, and would
  > have stayed green while the union and the live CHECK disagreed: exactly the drift it
  > exists to catch, hidden by where it was looking. It reads the NEWEST carrier now, the way
  > `seed-parity` already did. `linksOf` gained its `work_item` case in the same pass — 0063's
  > comment claimed both halves were present and only one was.
  >
  > **The demo seed now carries three asks, one per kind, with the question already
  > ANSWERED** so "with the firm" is not an empty heading either. `demo:verify` stays
  > **71/71** — its *"a portal session is told it may do nothing"* check is now *"told exactly
  > what it may do"*, asserting the LIST rather than a count, because "one permission" would
  > pass with the wrong one.
- [x] `(B)` **T4.4** **A8 Chaser** (moved here from Phase 4, id unchanged): reminder ladders (T–3 daily, D+3/7/15), portal asks, escalation. *Acc: respects ladder config; stops on escalation freeze.*
  > **Why it is in this phase.** It is the only thing on the board that reduces the firm's own
  > chasing hours, and it has no honest surface without the portal — a reminder that points at
  > an email thread is the thing every firm already does badly. The ladder shape is already
  > proven: `T4.5`'s escalation ladder (0058) is the same mechanism aimed INWARD (the firm
  > hears that its own work went quiet), and this is it aimed OUTWARD at a client. Reuse it —
  > rungs, thresholds copied onto the row, and **nothing set by default**, because a chasing
  > cadence this product invented is one the firm never agreed to and the client feels.
  >
  > **Two hard limits, stated now rather than discovered:** it never contacts anybody outside
  > a channel the firm configured (P10 transport, Phase 7 — until then it raises the ask and
  > the portal shows it), and it **stops on escalation freeze** so a client already in a
  > dispute is not being auto-chased while a partner is negotiating.

  > **DONE 2026-09-01 (migration 0065).** `usecase/chaser` + `crm.client_freeze` +
  > `delivery.client_ask_chase` + a `chaser` config kind. The sweep is a cron on the
  > escalation ladder's own cadence; the API surface is the FREEZE only.
  >
  > **ESCALATION FREEZE DID NOT EXIST — not a table, not a column, not a config kind.** The
  > acceptance line named a concept this product had never built, so half of T4.4 was
  > building it, and its shape was a client fact rather than a guess. Shrestha, 2026-09-01:
  > **on the CLIENT, effective-dated** (the board's own case is a dispute, which is with a
  > client and not with one task — a per-ask snooze would make a partner silence seven asks
  > one at a time and go silent again on the eighth); **stopping the OUTWARD ladder only** (a
  > dispute is the worst possible moment for a firm to go blind to its own late work); and a
  > **reason is required**, because "why is this client not being chased" is asked months
  > later by somebody who did not set it.
  >
  > **THE OTHER HARD LIMIT IS MET BY THERE BEING NOTHING TO SEND THROUGH.** No mailer is
  > wired into `ChaserService` — a logging stub would put a line in an operator's log saying a
  > client was emailed, which is the same class of lie as a `scan()` returning clean. A chase
  > RAISES the reminder and the client's action centre shows it. `tests/chaser/service.test.ts`
  > asserts the dependency list STRUCTURALLY, so a transport appearing in `Deps` turns the
  > build red and somebody has to justify it on the board first.
  >
  > **NOTHING IS SET BY DEFAULT**, and it is sharper here than on T4.5: an escalation nobody
  > asked for lands on a colleague, a chase nobody asked for lands on the CLIENT. A firm that
  > has published no `chaser` entry chases nobody, and the sweep returns before it even reads
  > that firm's open asks. Its own config kind rather than the `escalation` kind reused — that
  > rung carries `watch`, `notify` and `minGradeRank`, and a chase has one subject and one
  > recipient, so reusing it would mean three fields nobody reads and a validator that could
  > no longer refuse a rung that made no sense.
  >
  > **It chases OPEN asks only.** An answered ask is back with the firm, and reminding somebody
  > about something they have already sent is the single most annoying thing a chaser can do —
  > and exactly what a spreadsheet-driven human chaser gets wrong every week. It also skips an
  > ask whose task the firm marked invisible: chasing about something that is not on the
  > client's page would be the product contradicting itself.
  >
  > **At-least-once, evidence-grade.** `client_ask_chase_once` makes a redelivery unwritable
  > and the ledger event is emitted only for rows actually created, so *"we reminded you four
  > times"* is a sentence the count supports. The table is APPEND-ONLY BY GRANT for the same
  > reason: a record the firm can edit is not evidence. The actor is the SYSTEM, honestly —
  > nobody decided to send this one, a cron did — which is also why there is no "chase now"
  > button.
  >
  > **AND BUILDING IT FOUND A CONSTRAINT THAT WAS WRONG.** `client_freeze` first carried
  > `client_ask`'s both-or-neither pairing on `(valid_to, lifted_by)`, and the integration test
  > refused a freeze that ENDS on a known day — *"frozen until the 30th, while we are in
  > mediation"* — which is the shape a partner is most likely to want. The true invariant is
  > one-directional: a LIFTER with no end date is impossible, because lifting IS setting the
  > end date. 0065 was uncommitted and applied only locally, so it was corrected in place and
  > the file was proven by a full down/up round trip.
  >
  > 13 integration tests over real Postgres, including the exclusion constraint refusing an
  > overlap AS RANGES, the empty range (0061's shape) not blocking a re-freeze after an
  > immediate lift, and `${asOf}::date - a.raised_at::date` returning the right number of
  > days — arithmetic no fake exercises and the thing that cost T6.5 a 500 on its first real
  > request. `check` **1481** · `test:integration` **487** · `demo:verify` **71**.
  >
  > **WHAT IS NOT BUILT, stated rather than left to be discovered:** the *T–3 daily* half of
  > this line. A filing approaching its statutory date asks the client for nothing until the
  > firm raises an ask about it — *"your GSTR-3B is due in 3 days"* is a NUDGE, not a request,
  > and it is `T6.7`'s "proactive nudges" with a different subject and a different cadence.
  > Shrestha's call, 2026-09-01.
  >
  > **THE SCREEN EXISTS NOW (2026-09-06): `/admin/client-reminders`**, and it holds BOTH
  > outward ladders — this one and T6.7's nudge — because a partner deciding how often the
  > firm speaks to the people who pay it is answering one question, and two screens invite two
  > answers. Separate kinds, separate entries, separate drafts, separate publishes, as 0065 and
  > 0067 require. Until it was built, a number that lands on a CLIENT was settable only by
  > curl: the freeze panel on `/clients/[partyId]` read the ladder and named its rungs, and
  > nothing in the product wrote it. Walked end to end — a draft saved, published, and the
  > freeze panel then read the new threshold back.
- [x] `(B)` **T6.7** Self-serve library (docs/challans/invoices), proactive nudges, monthly digest. *Acc: a client finds last year's challan without emailing anyone.*
  > **DONE 2026-09-01 (migrations 0066 and 0067).** `usecase/portallibrary` + `usecase/nudge`,
  > four portal routes, three portal screens, and the reader `client_ask_chase` had been
  > waiting for since T4.4. **The acceptance line was walked in the browser** as
  > `meera@cobaltfoods.in`: found the filed acknowledgement under *Documents*, downloaded it,
  > read the invoices with what is still outstanding, and opened September month by month —
  > **without asking anybody, and without an email**.
  >
  > **0 · THE HOLE T4.4 LEFT, CLOSED FIRST.** `delivery.client_ask_chase` had a writer, a
  > portal policy and a ledger event and NOTHING rendered any of it — the sixth registered
  > thing in this codebase found in that state. 0065's own comment claimed the client's action
  > centre showed *"how many times it has been reminded and when"*; that was false the day it
  > was written, and 0065 is applied and immutable, so the correction is here and in
  > `CLAUDE.md`. **Both surfaces read it now and they read it DIFFERENTLY on purpose.** The
  > FIRM gets every rung with its key, threshold and day — a colleague who cannot see three
  > chases will send a fourth by hand, which is the work T4.4 exists to remove, and *"we asked
  > you four times"* is where the append-only grant earns its keep. The CLIENT gets a DATE and
  > no tally (Shrestha, 2026-09-01): a count on somebody's own page is an accusation, and on a
  > daily rung it reads *"9 times"* within a fortnight. Proven by negative control — dropping
  > `client_ask_chase_portal_scope` turns 2 of the new tests red.
  >
  > **1 · THE LIBRARY, AND THE HOLE 0063 LEFT THAT ONLY BECAME ONE TODAY.**
  > `document_portal_scope` was `portal_sees(party_id)` alone, which was CORRECT while the only
  > route reaching a document was a client reading back a filename. **This is the first route
  > that LISTS documents**, and `party_id` alone hands the client every working paper the firm
  > has ever filed against them. So `files.document.is_client_visible` (0066), which is
  > `work_item.is_client_visible` for the second time — DB default FALSE so a forgetful writer
  > publishes nothing, first value from the KIND in the service, enforced as a POLICY, and **a
  > switch on the firm's screen in the same task**, because T6.5 already named *a wall built
  > against a value nobody can move*.
  >
  > **AND THE OBVIOUS WAY TO WRITE THAT NARROWING BROKE THE FIRM'S OWN WORKSPACE.** A bare
  > `AND is_client_visible` on a RESTRICTIVE policy applies to STAFF too — the firm lost sight
  > of its own working papers, and the same edit on `crm.invoice` hid every DRAFT from the
  > people writing them. 0062 had solved it already (`NOT crm.is_portal_session() OR …`) and
  > 0066 copies that shape. **The integration suite said so within a minute of the first
  > draft**, off its own first assertion: *"a STAFF session is untouched"*.
  >
  > **2 · INVOICES, which 0062 said out loud were not here.** `crm.invoice.party_id` — who is
  > BILLED, never a join. A DRAFT is refused **inside the policy** for `is_client_visible`'s
  > reason; a CANCELLED one is visible, because a client holding a copy of a withdrawn invoice
  > must be able to see it was withdrawn. Lines, payments and credit notes get an EXISTS on the
  > parent (0063's shape), and `crm.invoice_balance` follows for free because it is
  > `security_invoker`. `crm.dunning_action` gets NO policy — 0065's answer about
  > `client_freeze`, applied again.
  >
  > **BYTES LEAVE ON THE CLIENT'S SIDE FOR THE FIRST TIME, and T3.6's rule extends rather than
  > bends:** one route, no pre-signed URL, `content-disposition: attachment`. The version row
  > naming the storage key is read under `withPortal` and only then is the key given to the
  > blob store, so the key is unreachable before it could be used. `PostgresPortalLibraryRepository`
  > is the THIRD `withPortal` adapter — *"countable on one hand"* is half spent.
  >
  > **3 · THE NUDGE IS NOT THE CHASER WITH A MINUS SIGN** (0067). Its own config kind and its
  > own table: a chase counts FORWARD from when the firm asked and wants something back, a
  > nudge counts BACKWARD from a date the LAW set and wants nothing. The validator is the
  > MIRROR of the chaser's — strictly DESCENDING `beforeDays` where that one demands ascending
  > `afterDays`. Wall column `entity_party_id`, because 0053 says *the ENTITY, never the
  > client*.
  >
  > **AND THE FREEZE DOES NOT STOP IT** — a decision whose two halves happen to agree. A
  > statutory date is the LAW's and travels whether or not a fee is in dispute; going quiet
  > about one during a dispute exposes the client to a penalty and the firm to a claim. And
  > structurally it could not reach: a freeze is on `client_party_id`, an obligation on
  > `entity_party_id`, and joining them is the nullable derivation this schema has refused
  > three times. `tests/nudge/service.test.ts` asserts the ABSENCE of a freeze port as well as
  > the absence of a mailer.
  >
  > **4 · THE DIGEST IS A SCREEN, SAID PLAINLY.** No transport (P10 is Phase 7), so no mailer
  > is injected — the chaser's arrangement, for the chaser's reason. `/portal/month` says on
  > the page that nothing is sent. It is not a second copy of the status home: that answers
  > *what is outstanding today* over ninety rolling days, this is bounded by a calendar MONTH
  > and reaches back as far as a client cares to look.
  >
  > **5 · THE FOOTER LIED AGAIN, AND THE FIX IS NOT A THIRD REWRITE.** It named absences —
  > *"your invoices and the firm's own documents are not here yet"* — and T6.7 built both. A
  > sentence that enumerates what is MISSING goes stale every time somebody removes one. It
  > points at where things ARE now, and the portal grew a NAV, which is the actual fix: a
  > library reachable only by scrolling past four sections of today's news is not self-serve.
  >
  > **6 · AND THE PORTAL'S FRAME WAS RE-SHAPED AFTER LOOKING AT IT.** T6.5 argued for no
  > nav at all (one screen, no map); this task gave it four tabs; and then Shrestha opened
  > it — *"everything looks messy"*. The strip ran the full window with four small labels at
  > the far left, above a CENTRED column, so the nav and the thing it navigated did not line
  > up and the page read as half-built. Every gate was green. It is now `.shell` +
  > `.sidebar` + `.main`, reusing every class the staff workspace uses **with no new CSS** —
  > four flat links with icons, and deliberately none of the staff shell's groups, search
  > box or firm switcher. The rail's foot names the **company** where the staff one names a
  > role: `client_viewer` is the firm's word for what somebody may do, and showing it to a
  > client is a label about their own permissions that they cannot act on.
  >
  > The same pass turned `/portal/documents` from cards into a TABLE (cards are a two-minute
  > scroll at thirty rows, and that list has no window), put its search behind a threshold
  > of eight, and stopped a work item's title repeating the client's own company name —
  > which was wide enough to give the table a horizontal scrollbar with ONE row in it.
  > **None of that is visible in a page's TEXT**, which is what a walk usually reads: it
  > needed a screenshot.
  >
  > **THREE MORE THINGS BUILDING IT FOUND, none visible to a typecheck.**
  >
  > · **A CLIENT'S OWN UPLOAD BECAME UNREADABLE TO THEM.** The portal's ask adapter inserts the
  >   document and did not set the new flag, so it defaulted FALSE — which did not leak
  >   anything, it made the INSERT fail the policy's own `WITH CHECK`, because a portal session
  >   cannot write a row it could not then read. The wall telling the truth. The firm's
  >   default-by-kind mapping deliberately does not apply there: the kind was the FIRM's
  >   filing decision, and a client would lose sight of what they sent because of it.
  > · **`subject_kind = 'work_item'` HAD NO FIRM-SIDE READER EITHER.** 0063 added it so a
  >   client's upload lands where the person who asked is looking, and `/work-items/[id]` had
  >   no `<Documents>` panel at all. It has one now, and it is where the visibility switch
  >   lives.
  > · **AND A DOWN MIGRATION FAILED HALFWAY, WHICH ONLY RUNNING IT SHOWED.** 0067's first
  >   down dropped the table, dropped the composite key, and only then tried to narrow
  >   `entry_kind_check` back — which a database with a published `nudge` entry refuses, as
  >   its own comment predicted. What the comment did not predict is that the refusal lands
  >   AFTER the drops, leaving the schema in a state neither migration describes and the
  >   constraint gone entirely — the exact failure 0066's own down carries a paragraph about.
  >   It ADDs the narrow constraint under a temporary name first now, so the refusal happens
  >   with nothing destroyed, then swaps it in. `npm run migrate` wraps each file in a
  >   transaction and would have rolled it back; a DOWN is run by hand, against a database
  >   somebody is trying to rescue, and that is the case it has to be safe in. Both halves
  >   proven: the refusal leaves table, constraint and temp name untouched, and the full
  >   down/up round trip runs clean inside a rolled-back transaction with the entry removed.
  > · **`worker:once` CLAIMED TO RUN EVERYTHING AND DID NOT.** T4.4 registered the chaser on
  >   the worker's queue and never added it to that command, so it ran every sweep except the
  >   one aimed at clients — under a header that said "ALL FIVE". The count has gone stale
  >   twice; there is no count in it any more. Its "nothing to chase" line also asserted the
  >   firm had published no ladder on a run where the demo had just published one.
  >
  > **The demo seed now publishes both outward ladders and stocks the library** — a filed
  > acknowledgement the client CAN see and a working paper about the same client they CANNOT,
  > both through the product's own upload route, so the kind mapping is what decides and
  > nothing passes the flag. Nothing has been chased on a fresh demo, correctly: every ask is
  > raised today and no rung is due. `check` **1510** · `test:integration` **524** ·
  > `demo:verify` **71**.

- [x] `(B)` **T6.8** The client's own request — a client asks the FIRM for something, unprompted. *Acc: "send me last year's balance sheet" stops being a phone call.*
  > **DONE 2026-09-02 (migrations 0068 and 0069).** `usecase/clientrequest`, two adapters, seven
  > routes, an "Ask the firm" section on `/portal` and `/client-requests` on the firm's side.
  > **Walked in the browser end to end**: Meera raised a request at Cobalt Foods, Siddharth
  > answered it from the workspace attaching a document, and it appeared in her library — the
  > acceptance line, in one loop, with no email.
  >
  > **ADDED TO THE BOARD RATHER THAN FOUND ON IT.** Phase 6 was complete against U1 as written
  > and the portal was still a one-way street: a client could answer, upload, download and read,
  > and could not START a sentence. T6.7's library covers the half where the firm has already
  > filed the document AND marked it visible; it cannot cover *"we never had that from you"*.
  >
  > **1 · IT IS NOT `client_ask` REVERSED, AND THAT IS STRUCTURAL.** 0063's `work_item_id` is
  > NOT NULL with its whole argument written out — the composite FK over `(work_item_id,
  > client_party_id, tenant_id)` is what makes the wall column a GUARANTEE. A client's own
  > request has no work item and may never get one, so widening that column would take 0063's
  > guarantee away from every row in that table to make room for rows of a different shape.
  >
  > **2 · THE FIRST WALL COLUMN A CALLER SUPPLIES, AND THE FIRST WRITE WHERE `WITH CHECK` IS
  > THE ONLY THING HOLDING.** Every one before it was read from a parent inside the INSERT.
  > There is no parent here — a contact granted three companies must SAY which — so
  > `crm.portal_sees(client_party_id)` on the WITH CHECK arm is what refuses another client's
  > company. 0059 and 0062 both wrote that arm while saying no portal write path existed *"which
  > is why it will not have to be built with the rule inside it"*; this is the case that
  > collects on it. The service checks the scope first so the refusal is a SENTENCE and not an
  > RLS violation, and `tests/portal/client-request.integration.test.ts` demonstrates which of
  > the two is the wall by going straight to `withPortal`, past the service.
  >
  > **3 · `author_side` IS ENFORCED BY THE POLICY, WHICH IS WHY IT IS SAFE TO STORE.** The reply
  > table's WITH CHECK carries `NOT crm.is_portal_session() OR author_side = 'client'`, so a
  > contact posting `authorSide: "firm"` is refused by the DATABASE — not by a handler and not
  > by a zod schema, both of which are also true today and either of which somebody could later
  > simplify. Deriving it instead ("is the author a staff account?") is a join that decides
  > ATTRIBUTION, and an account whose membership changed would switch sides in an old
  > conversation.
  >
  > **AND THE GUARD IS 0062's SHAPE FOR THE HARD REASON.** A bare `author_side = 'client'` on a
  > RESTRICTIVE policy applies to STAFF too. Removing the guard as a negative control turned
  > **2** tests red and BOTH were the firm locked out of its own table — it could no longer
  > reply to a client, nor send one a document. That is T6.7's hour-long trap reproduced
  > exactly, and it is why the FIRST test in that file is *"a STAFF session is untouched"*.
  >
  > **4 · FOUR DECISIONS THAT ARE SHRESTHA'S, taken 2026-09-02 and not guessed:**
  >   · **The FIRM closes; the CLIENT withdraws.** Against the symmetric reading where the
  >     raiser closes: the queue is the firm's, and a client who got what they wanted will never
  >     come back to tick a box, so those rows would sit open for ever and the inbox would stop
  >     being read. The firm can never write `withdrawn` — *"we decided you did not need this"*
  >     is a refusal, which is a close with a reply saying so — and which ending a session may
  >     write falls out of WHICH REPOSITORY it goes through, not from a column anybody passes.
  >     0068 names the columns `settled_by`/`settled_at` rather than borrowing 0063's
  >     `closed_by`, because that name holding a client contact on half its rows would read as
  >     the firm having closed it.
  >   · **`portal:request` is the ELEVENTH permission and the SECOND held outside the firm** —
  >     not a widening of `portal:respond`. Everything that one covers is a REPLY to something
  >     the firm raised; this lets somebody START work the firm is expected to do, and a firm
  >     may well want the clerk who sends the registers every month to go on sending them and
  >     not to open requests. `client_viewer` holds neither and still sees everything, because
  >     reading is authorised by the GRANT.
  >   · **NO ROUTING.** One firm-wide list. The firm has never said whether an inbound request
  >     belongs to the client's partner, to a Dept, or to whoever is free — and this codebase
  >     already carries one arbitrary answer to a question of that shape (a service-less shipped
  >     rule inheriting some engagement's Dept), which is on this board as open. A second guess
  >     is the same mistake with a different table. **It is open, and it is the one thing on
  >     this task somebody will want to change first.**
  >   · **NO TOPIC OR KIND.** 0063 carries `ask_kind` because the action centre RENDERS a
  >     different control per value. Nothing branches on the kind of a request, and a vocabulary
  >     nobody reads stops being filled in accurately and then starts being trusted.
  >
  > **5 · THE ANSWER TO "SEND ME LAST YEAR'S BALANCE SHEET" IS 0066's SWITCH.** A firm reply may
  > attach a document ALREADY FILED against that client, and the adapter flips
  > `files.document.is_client_visible` in the same transaction — because attaching a document to
  > a message addressed to a client IS the decision to show it to them. No second upload path:
  > a client's own files go through T6.6's route, where they land in the job's file. The
  > composite FK is 0063's and both halves earn their place again — another client's document is
  > refused, and so is one of the firm's OWN (`party_id` NULL matches no NOT NULL value).
  >
  > **6 · NO TRANSPORT, AND THE ABSENCE IS ASSERTED STRUCTURALLY.** `ClientRequestService`'s
  > dependency list is pinned in a test the way `ChaserService`'s and `NudgeService`'s are, so a
  > mailer appearing in `Deps` turns the build red and the argument goes on this board first.
  > What this means honestly: a client raises a request and **the firm finds out when somebody
  > opens the inbox**. That is the same PULL the rest of the portal is, and P10 is what fixes
  > it — for this in both directions.
  >
  > **AND THE FIRM'S READER SHIPPED IN THE SAME TASK**, which is this board's own rule after
  > seven things shipped with a writer and nobody looking. `/client-requests`, a link in the
  > Delivery group, `party:read` to read and `work:write` to act.
  >
  > **WHAT WALKING IT FOUND, and none of it visible to a typecheck, a lint or a test:**
  >   · **`className="row gap"` HAS NEVER DONE WHAT IT LOOKS LIKE, AND IT IS IN COMMITTED
  >     T6.6/T6.7 CODE.** `.row` is `justify-content: space-between` and **`.gap` is not defined
  >     anywhere in the design system**. Measured on the live page: the client's **Approve and
  >     Decline buttons were 941px apart**, at opposite edges of one card, with the destructive
  >     one where the eye lands last. `.cluster` is the class meant for a row of buttons; ten
  >     occurrences across five files now use it, and the spread is 8px. A screenshot found
  >     this; the page's TEXT reads identically either way.
  >   · **A TIMESTAMP IS NOT A DATE COLUMN, AND THE RULE POINTS THE OTHER WAY.** The first draft
  >     rendered `raisedAt` by reading its UTC fields — which is the correct answer for a
  >     `YYYY-MM-DD` DATE and the wrong one for an INSTANT. A request raised at 00:20 in Delhi
  >     displayed **"01 Sep"**, the day before the client made it. It uses the reader's own zone
  >     now, which is what the action centre already did.
  >   · **THE FIRM'S SCREEN SAID ONE THING TWICE** — a "Waiting on us" chip beside a raw `open`
  >     chip, which is this codebase's duplication bug for the fourth time, and put a machine
  >     word on a partner's page. What replaced it says the three states a reader acts on, and
  >     the middle one — **the client came BACK** — is the one neither chip could express alone.
  >   · **THE DOCUMENT PICKER LOADED ON ITS OWN FOCUS AND WAS ALWAYS EMPTY.** A native `<select>`
  >     opens the instant it is clicked, so the options arrived after the reader was already
  >     looking at "Nothing attached". It loads when the REPLY BOX is touched now — typing a
  >     sentence is far longer than the round trip.
  >   · **AND THE FIRM'S SCREEN NEEDED A FIELD THE API DID NOT SEND.** `clientPartyId` is on the
  >     firm's wire now and deliberately not on the portal's: the inbox needs it to list that
  >     client's documents for the attachment picker, and a client reading their own page has no
  >     use for their own party id. The rule this board already has — when a screen wants
  >     something the API does not return, fix the API.
  >
  > **ONE THING LEFT OPEN AND NOT THIS TASK'S:** every portal timestamp crosses the wire as
  > Postgres `::text` (`2026-09-01 19:54:05.712839+00`, a SPACE rather than a `T`), which is not
  > ISO 8601. Chrome and Firefox parse it; Safari historically does not, and would render every
  > date on this surface as a raw string. It is the convention T6.5, T6.6 and T6.7 all set and
  > changing it is five adapters, so it is written down here rather than half-done.
  >
  > `check` **1529** · `test:integration` **543** · `demo:verify` **71** on a database rebuilt
  > from nothing.

- [x] `(B)` **T6.9** Routing for the client-request inbox — a switch the FIRM sets, never a rule this product invented. *Acc: a firm can have arriving requests land on the client's Key Manager, or on nobody, and say which.*
  > **DONE 2026-09-02 (migration 0070).** `assignee_user_id` + `assignment_note` on
  > `delivery.client_request`, `client_request_routing` on `tenancy.tenant`, Mine / Unassigned /
  > Everything on `/client-requests`, and the switch on `/admin/structure`. **Walked**: raised
  > one with routing OFF (nobody, no note), switched it on, raised another (landed on
  > Siddharth Rao, Cobalt's Key Manager) — and the first one was **untouched**.
  >
  > **THE FIRM STILL HAS NOT STATED A RULE, so this does not encode one.** T6.8 left routing
  > open because nobody had said who an inbound request belongs to, and that is still true. What
  > changed is that the firm now has a LEVER: `none` is the default, reproduces T6.8's behaviour
  > exactly, and means applying 0070 changed no firm's behaviour at all. Nothing is seeded — the
  > position `dunning`, `confidence_tier` and the escalation ladder all take.
  >
  > **A SPOC IS NOT AN OPTION, AND THAT IS STRUCTURAL RATHER THAN A CHOICE.**
  > `client_assignment_axis_matches_role` (0049) makes `axis_id` NOT NULL for a SPOC, because a
  > SPOC covers a Dept or a delivery team. **A client's request names no service**, so there is
  > no axis to look one up by — picking one would be exactly the arbitrary answer 0068 refused
  > to give, and which a service-less shipped rule already gives elsewhere in this schema. The
  > Key Manager needs no axis, is one person per client (an exclusion constraint says so), and
  > is the only answer to *"whose is this request"* this database can derive without inventing
  > anything. The admin screen SAYS a SPOC is impossible, because a partner reading a list of
  > two would otherwise assume the third is missing rather than unavailable.
  >
  > **A WRONG ASSIGNEE IS WORSE THAN NONE** — 0051's rule, applied again. There is no fallback
  > to the partner, to whoever is free, or to the last person who replied: the rule names the
  > right person or NOBODY, and when it names nobody it writes a note that names the FIX
  > (*"name one on the client's page, or take this request yourself"*). **Under `none` there is
  > NO note**, which is the subtle half: a firm that routes nothing has not FAILED to route
  > anything, and a sentence on every row of a uniformly unassigned inbox is noise saying what
  > the empty column beside it already says.
  >
  > **AND THE SWITCH RESTATES NOTHING** — `work_split_axis`'s behaviour and its reason, which is
  > also why the setting is a COLUMN on the tenant rather than a config kind: it is freely
  > changeable, and nobody will ever ask what it said last March. Proven in the walk rather than
  > asserted.
  >
  > **THE KEY MANAGER IS READ UNDER `withTenant`, BEFORE THE PORTAL TRANSACTION OPENS.**
  > `crm.client_assignment` names the firm's own people, has no portal policy and must not grow
  > one for this — so the server resolves the answer on the client's behalf and hands it to the
  > portal insert. The answer never comes back to the client either: `PortalRequestRow` carries
  > no assignee at all. A unit test asserts the lookup does not happen AT ALL under `none`.
  >
  > **AND A HOLE FROM T6.8 WAS FOUND AND CLOSED WHILE BUILDING THIS.** `bib_app` holds UPDATE on
  > `client_request` (withdrawing is an UPDATE) and the portal policy's WITH CHECK only ever
  > looks at `client_party_id` — so a portal session could have UPDATEd its OWN request and set
  > `assignee_user_id` to any account it liked. Not a leak; a client silently putting their
  > request on a chosen partner's desk. No route did it, but 0068 made `author_side` unforgeable
  > in the DATABASE on the stated ground that an adapter is code somebody can edit, and leaving
  > the neighbouring column forgeable would be that argument abandoned one migration later.
  > **It is a TRIGGER and not a policy, and that is forced**: a WITH CHECK sees only the NEW row,
  > and this is a question about whether a column CHANGED. Negative control run — dropping it
  > turns **2** tests red, and both are a portal session successfully forging the assignee.
  >
  > **WHAT THE SCREEN DOES:** three tabs, and **Unassigned is the one that would not exist on a
  > naive list** — work the rule could not place, or nobody has taken (0051's argument again:
  > unassigned work is only chased if somebody can list it). **"Take it" needs no roster**, so
  > it is the control everybody with `work:write` gets, and the full picker is the extra offered
  > only where `/tenancy/members` is readable — the same honest gap `/work-items/[id]`, the
  > pipeline's owner dropdown and the account team form all have.
  >
  > **`routing` travels with the LIST** (T4.5's `ladderPublished` decision): an inbox where
  > nothing is assigned because the firm routes nothing, and one where the rule ran and placed
  > nothing, are the same picture, and only one is somebody's to fix.
  >
  > `check` **1544** · `test:integration` **551** · `demo:verify` **71** on a rebuilt database.
  > Two rendering faults found by looking at the page: the assignee picker was a full-width
  > dropdown with no label sitting under two ghost buttons, and 0070 was corrected IN PLACE
  > (uncommitted and local, 0065's precedent) to add the trigger, proven by a full down/up round
  > trip.

- [x] `(B)` **T6.10** Every instant on the wire is ISO 8601 — the format Safari is REQUIRED to parse. *Acc: no adapter renders a `timestamptz` with `::text`, the format is written in one place, and what Postgres emits for it is measured against a real server rather than reasoned about.*
  > **DONE 2026-09-02. No migration** — this is the SELECT list, not the schema, so 0071 is still
  > free. `check` **1550** · `test:integration` **556** · `demo:verify` **71** · frontend
  > `check` clean and `api:generate` **byte-identical** (the type was and stays `z.string()`;
  > what changed is the value inside it, which is why no frontend file was touched).
  >
  > **T6.9 LEFT THIS OPEN AND UNDERSTATED IT AT "five adapters".** It is **24 select sites
  > across 10 adapters**, and only ELEVEN of them are the portal's — `client_ask`,
  > `client_assignment`, `obligation_instance`, `chaser` and `render-source` carry the same cast
  > on the FIRM's side. The rule shipped is therefore about the CLASS, not the surface: a
  > `timestamptz` leaves an adapter as ISO 8601 or it does not leave.
  >
  > **WHAT `::text` ACTUALLY GIVES: `2026-09-01 19:54:05.712839+00`.** ECMAScript pins the string
  > `Date` must accept — `YYYY-MM-DDTHH:mm:ss.sssZ`, a literal `T` and EXACTLY three fractional
  > digits — and everything else is each engine's choice. **V8 takes it**, which is measured in
  > the test and is why every gate in this repo was green: node, curl, smoke and every browser
  > walk on this machine parsed it and landed on the right instant. JavaScriptCore historically
  > does not, and every portal screen guards with `Number.isNaN(at.getTime()) ? iso : …` — so the
  > failure was never a crash. It was a client on an iPhone reading
  > `2026-09-01 19:54:05.712839+00` where the firm meant "1 Sep 2026".
  >
  > **AND THE SECOND BUG IN THE SAME CAST IS THE WORSE ONE, AND NOBODY HAD NAMED IT.**
  > `timestamptz::text` renders in the **SESSION's TimeZone**, not in UTC. `src/db/pool.ts` sets
  > none, so it is the SERVER's — UTC in the compose container, which is the only reason every
  > string anyone here has ever looked at ended `+00`. **`render-source.ts` sliced its invoice
  > date off that string** (`row.created_at.slice(0, 10)`, the fallback when `issued_on` is
  > null), so the date printed on a numbered tax document an auditor reads depended on a setting
  > in `postgresql.conf`. Measured, not argued: the same row under `TimeZone = Asia/Kolkata`
  > slices to **2026-09-02** and under UTC to **2026-09-01**. It is `day.ts`'s bug in different
  > clothes — a DAY derived from an INSTANT by a zone nobody chose.
  >
  > **THE FIX IS TWO HELPERS IN `infrastructure/postgres/instant.ts`, and both pin the zone.**
  > `isoInstant(expr, alias?)` →
  > `to_char(x AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, byte for byte what JS
  > `toISOString()` produces. `utcDayOf(expr, alias)` → `(x AT TIME ZONE 'UTC')::date::text`, for
  > the render source, which wanted a day all along. `.MS` is three digits **deliberately**:
  > `.US` is six, more faithful to what Postgres stores, and back outside the spec — which is
  > back to each engine deciding. NULL in, NULL out, so an unanswered ask keeps its honest
  > `null`.
  >
  > **THE GUARD IS A GREP, for `calendar-day.test.ts`'s reason** — a behavioural test proves
  > nothing when both formats pass everywhere this is developed, and the failure is in a browser
  > nobody here runs. `tests/architecture/instant-format.test.ts` bans `_at::text` across every
  > adapter (`_at::date::text` deliberately NOT matched — asking SQL for a day is the right
  > answer) and bans the format literal outside `instant.ts`, so there is exactly one thing for
  > the integration test to measure. **Negative control run:** one site reverted, the grep goes
  > red and names the file; restored, green.
  >
  > **AND WHAT POSTGRES EMITS IS MEASURED, in two server timezones.**
  > `instant-format.integration.test.ts` reads the same instant under `UTC`, `Asia/Kolkata` and
  > `America/New_York`: the helper does not move, the old `::text` does, and the day it slices to
  > changes. **The measurement corrected the test itself** — the subject was a bound parameter
  > first and came back `…05.712+00`, three digits where the server stores six, because
  > postgres.js turns a timestamp-shaped parameter into a JS `Date` on the way OUT and a `Date`
  > holds milliseconds. The driver had quietly rounded the precision the test existed to observe.
  > It is a SQL literal now.
  >
  > **WALKED END TO END ON BOTH SURFACES, over HTTP against the demo firm** — signed in as
  > `meera@cobaltfoods.in` and as `siddharth@10xglobal.in` and classified every date-shaped
  > string in every response: **11 instants, all ISO 8601; 167 `YYYY-MM-DD` days, correctly
  > untouched; ZERO non-ISO.** No screenshot: not one frontend file changed and `schema.d.ts` is
  > byte-identical, so there is no layout for one to catch — the risk here is the STRING, and the
  > string was read off the wire.
  >
  > **ONE THING LEFT OPEN, AND DELIBERATELY NOT HALF-DONE.** Three sites cast a `timestamptz`
  > with `::date` or compare it to a `date` — `portal-library-repository.ts`'s month digest
  > (twice) and `chaser-repository.ts`'s `(${asOf}::date - a.raised_at::date)` day arithmetic.
  > Those are session-zone dependent in exactly the same way, and today they behave as UTC
  > because the server does. **Pinning them to UTC would be deterministic and probably WRONG**:
  > for an Indian firm a document added at 02:00 IST on 1 October belongs in October's digest,
  > not September's, and a chase rung counted in UTC fires a day early east of Greenwich. The
  > question is *whose zone is a client's month*, which is the firm's to answer and is next to
  > the turnaround times nobody has given. It is a date-arithmetic decision, not a wire format,
  > so it stays a written-down question rather than a silent UTC pin.

- [x] `(B)` **T6.11** Whose calendar a client's MONTH is cut on — the firm's, not the database server's. *Acc: a firm sets its own zone, the month view and the chaser use it, and applying the migration changes no firm's behaviour.*
  > **DONE 2026-09-02 (migration 0071).** `check` **1572** · `test:integration` **565** ·
  > `demo:verify` **71** · frontend `check` clean. Walked in the browser: the control set the
  > zone, an OFFSET was refused **400** rather than 500, and it was set back to UTC.
  >
  > **T6.10 LEFT THIS OPEN AS A QUESTION AND IT TURNED OUT TO BE A LIVE BUG, not a latent one.**
  > `x_at::date` uses the SESSION's TimeZone, which `src/db/pool.ts` does not set — so
  > `/portal/month` answered *"what did you do for me in September"* on the database SERVER's
  > calendar. For an Indian firm that is wrong five and a half hours every night: a document
  > filed at **02:00 IST on 1 October** is 20:30 UTC on 30 September and landed in **September's
  > digest, on a client's own page**. The chaser had it worse — `(asOf::date - raised_at::date)`
  > decides which rung has been reached, so a request raised after 18:30 UTC counted a day older
  > and a **D+3 reminder went out on day 2**.
  >
  > **THE FIRM'S ZONE, NOT THE READER'S**, and that is the decision. A digest is a STATEMENT BY
  > THE FIRM about a period, so it needs ONE boundary — otherwise the partner in Delhi and the
  > client's CFO in Dubai open the same September and see different documents in it, and the one
  > missing a row cannot tell whether it was filed late or whether their screen drew the line
  > somewhere else. T6.9's rule is untouched and points the other way: a MOMENT is shown in the
  > reader's own zone. **The field's type still decides**; this adds a third question to that
  > family and CLAUDE.md now carries the three-row table.
  >
  > **DEFAULT `'UTC'`, so applying it changed no firm's behaviour** — `work_split_axis` (0043)
  > and `client_request_routing` (0070), third time. A COLUMN and not a registry kind: nobody
  > will ask what a firm's timezone said last March, and a frozen historical value would be
  > actively wrong, because moving offices means every FUTURE digest uses the new zone.
  >
  > **VALIDATED BY A TRIGGER, which a CHECK could not do** — the only ways to ask Postgres
  > whether a zone exists are `pg_timezone_names` (a subquery) and `AT TIME ZONE` (STABLE), and
  > neither is allowed in a CHECK. 0070's precedent. Proven both ways by hand and by a full
  > **down/up round trip**.
  >
  > **AND THE OBVIOUS JS API IS THE WRONG ONE — measured against this database, not assumed.**
  > `Intl.supportedValuesOf("timeZone")` **omits `UTC` and `Asia/Kolkata`** — this product's
  > default and its first customer's zone — and canonicalises Kolkata to `Asia/Calcutta`,
  > **which Postgres does not know**. Validating against it would have refused both correct
  > values and recommended a broken one. `isTimeZone` constructs a formatter instead, and
  > separately refuses an OFFSET (`+05:30`), which `Intl` takes and `pg_timezone_names` does not
  > — with the better reason being the product one: an offset cannot express daylight saving, so
  > a firm on `+01:00` would cut its months an hour wrong for half the year. The measurement is
  > PINNED in a test, so a tzdata upgrade surfaces there rather than on a settings screen.
  >
  > **THE PROOF IS AN INTEGRATION TEST, because no fake can hold it.** The library fake stores
  > days as `YYYY-MM-DD`, so it has no instant for a zone to convert and ignores the argument —
  > correctly. The whole effect is in SQL. The fixture sits on a boundary where the two zones
  > DISAGREE, which is the only kind that can fail; a document at midday would pass under the
  > broken implementation too. **Negative controls run twice:** the SQL reverted turns the
  > digest test red, and the `AT TIME ZONE` removed turns the new grep in
  > `instant-format.test.ts` red, which now bans a bare `_at::date` beside the `_at::text` ban
  > it already carried — same family, same reason, **name the zone**.
  >
  > **AND IT SHIPPED WITH THE SCREEN**, this board's own rule: a labelled select on
  > `/admin/structure`, beside the routing and work-split switches, with the firm's current value
  > always in the list so opening the page can never silently offer to change a deliberate
  > setting. `tenant.time_zone_changed` carries BOTH sides — *"why did that filing move month"*
  > is asked afterwards and the old value is the answer — and `contract-parity.test.ts` caught
  > the missing row in `EVENT-CONTRACT.md` before the commit did.
  >
  > **ONE THING FIXED IN PASSING, found by the console and nothing else:** a `<div>` inside a
  > `<p>` in `work-items/[workItemId]/client-asks.tsx` — invalid HTML, so the browser closed the
  > paragraph early, it LOOKED right, and React reported a hydration mismatch on every render of
  > that panel. Committed T6.6 code, invisible to typecheck, lint and every test.

**Phase 6 is COMPLETE, and T6.8 was added to it after the fact** — U1 as written (T6.5, T6.6,
T6.7), the chaser (T4.4), gate 4 (G3.4), the request that made the portal two-way, and T6.9's
routing for it, T6.10's wire format under all of them, and T6.11's calendar under the month view.
What is open on this board is `(A)`'s commercial lane — `T6.2` and `T6.3` — and Phase 7.

**Milestone M5 (Sellable V1) — now reached HERE, at the end of Phase 6:** both UIs at MVP over
the full backend, the client-facing loop closed (portal + chaser), integrations faked, **and
agents still stubbed with humans in the loop**. Stated that way deliberately: the earlier
wording said "core agents on", which was true when this phase ran after Phase 4 and is not
true now. A V1 that chases clients and keeps a human on every decision is sellable; the
agents raise the margin on it, they do not create it.

---

## Phase 7 · Real integrations P11 — EXTERNAL-GATED, own track

Built as ports (fakes already exist). Each real adapter starts when the client grants
sandbox access + credentials. **Not on any demo's critical path.**

**EXCEPT ONE, AND IT WAS FILED HERE BY ASSOCIATION RATHER THAN BY ARGUMENT.** Transactional
email needed no sandbox, no client negotiation and no new port — and it was the only thing
standing between this product and a production boot. T7.0 below carves it out; the rest of the
phase is unchanged and still externally gated.

- [x] `(B)` **T7.0** One real Mailer, so a client can be invited and the product can boot. *Acc: `BIB_MAIL_TRANSPORT=smtp` sends a real invite through a real relay, and boot refuses a half-configured one.*
  > **DONE 2026-09-02. No migration** — 0071 is still free. `check` **1567** ·
  > `test:integration` **559** · `demo:verify` **71**. The frontend is untouched.
  >
  > **A LANE NOTE FIRST, because this is `(A)`'s square on paper.** T7.5 reads *"E-sign, email
  > (Gmail/M365), WhatsApp"*. What is taken here is ONLY the two transactional letters behind
  > `usecase/identity`'s existing `Mailer` port — the sign-in link and the portal invite — because
  > they are the ones blocking `(B)`'s portal and the boot gate. **E-sign, WhatsApp, and the
  > NOTIFICATION side of email (chaser, nudge, digest, the request inbox) are untouched and stay
  > `(A)`'s in T7.5.** Nothing here went near `ChaserService`, `NudgeService` or
  > `ClientRequestService`, whose dependency lists are pinned structurally precisely so that a
  > transport arriving there is a decision somebody argues for first.
  >
  > **WHAT WAS ACTUALLY TRUE BEFORE THIS, and had never been written down as a fact:**
  >   · **A CLIENT COULD NOT BE INVITED TO THE PORTAL AT ALL.** `logging-mailer.ts` said it in
  >     its own comment — *"the person on the other end of `to` is a CLIENT, not a colleague, so
  >     this one silently not arriving is a client who cannot get in"* — and inviting therefore
  >     meant somebody at the firm copying a URL out of a server log into their own email. T6.5
  >     through T6.9 shipped five screens **no outside reader could reach**.
  >   · **AND THE PRODUCT COULD NOT BOOT IN PRODUCTION.** `validateServer` refuses `log` there,
  >     so this was not "reminders are quiet" — the process stops. It blocked deploying anything.
  >
  > **PLAIN SMTP, NOT A VENDOR SDK.** Google Workspace, Microsoft 365, SES and Postmark all speak
  > it; a firm in this market already has one, and changing provider becomes `.env` rather than a
  > rewrite. `nodemailer-transport.ts` is the only file that imports the driver and
  > `smtp-mailer.ts` holds the letters — which is what lets `letters.test.ts` read exactly what a
  > client receives without a socket.
  >
  > **THE INVITE IS, FEATURE FOR FEATURE, A PHISHING EMAIL** — unasked, unfamiliar sender, click
  > a link, set a password — so the letter works at not being one: the firm in the SUBJECT, why
  > they are receiving it, what they will be able to do, and *check with your contact rather than
  > replying*. A firm's name is DATA on both routes it takes: a newline in it would end a Subject
  > header and let it append a `Bcc:`, and `Shah & Shah <Chartered Accountants>` would become
  > markup. Both stripped and escaped at the door, both tested.
  >
  > **AND THE CHANGE OPENED A SECURITY HOLE, WHICH IS WHY IT IS CLOSED IN THE SAME COMMIT.**
  > `requestMagicLink` answers 202 for an unknown address and returns early — deliberately quiet
  > about whether an account exists. A THROWN send would have made it 202 for no account and
  > **500 for a real one whose letter would not go**: an enumeration oracle assembled entirely
  > out of an error path, with no code admitting to it. Unreachable while a log was the only
  > mailer, because writing to a log cannot fail; reachable the moment a relay can reject a
  > recipient or time out. It is swallowed there and thrown on the INVITE path, where the firm is
  > watching a screen and a silent failure is a client who never gets in — and shouted about in
  > the ADAPTER, the only layer that knows a send failed and the only one that may hold a logger.
  > **Negative control run:** the swallow removed, that one test goes red; restored, green.
  >
  > **SENT THROUGH A REAL RELAY, because a transport nobody has sent through is `::text::jsonb`
  > again** — that statement typechecked, linted, passed every unit test against a fake and died
  > on the first real call. `smtp.integration.test.ts` speaks about forty lines of SMTP on
  > 127.0.0.1 and asserts what arrives: `From: 10x Global <no-reply@10xglobal.in>`, the subject
  > naming the firm, `multipart/alternative` with both bodies. Nothing leaves the machine — a
  > hosted catcher would have made the suite depend on somebody's uptime to prove a local fact.
  >
  > **TWO BOOT GATES, and they are NOT gated on the environment** like every other one in that
  > file. `smtp` with no `BIB_SMTP_HOST` and `smtp` with no `BIB_MAIL_FROM` are refused
  > everywhere, because the question is not "is this stub acceptable here" but "can the transport
  > somebody chose work at all" — and the alternative is finding out at the first send, which is
  > the moment a real client is being invited.
  >
  > **WHAT THIS EXPOSES AND DOES NOT CLOSE: there is no RESEND, and it is now operationally
  > real.** `PortalInviteService` refuses a second invite to somebody who already has a
  > membership and its own comment defers the route. That cost nothing while a send could not
  > fail. With a relay it can — a bounce, a typo, a quota — and the contact is then created,
  > granted, and permanently uninvitable. The question behind it is unanswered (*did they lose
  > the link, or has somebody taken over that mailbox?*), so it is written down rather than
  > guessed at. **It should be the next thing built on this.**

- [x] `(B)` **T7.0a** The THIRD transactional letter: a colleague is told their account exists. *Acc: adding a STAFF member emails a 72-hour sign-in link naming the firm; a CLIENT_PORTAL membership made on that route still sends nothing; a refused relay does not undo the membership.*
  > **DONE 2026-09-03. Migration 0072** (`magic_link.purpose` widened to `login | invite |
  > welcome`). `check` **1592** · `test:integration` **570** · `demo:verify` **71** ·
  > frontend `check` clean. Frontend: `admin/people` + `api:generate`.
  >
  > **THE GAP WAS NAMED IN THE PRODUCT'S OWN WORDS AND NOBODY READ IT AS A BUG.** The invite
  > route's description said *"No email is sent — they sign in with a magic link"*, and the
  > People screen repeated it under the button. True, and only if somebody remembers to send a
  > separate message by hand. A firm that adds five people on a Monday has five colleagues who
  > do not know they have an account.
  >
  > **A THIRD PURPOSE RATHER THAN A LONGER `login`.** A sign-in link is PULLED — somebody
  > pressed a button ten seconds ago — and lives fifteen minutes. This one is PUSHED at a person
  > who may open it on Monday, so it lives seventy-two hours. Widening `login` to days to buy
  > that would have lengthened every sign-in link in the product. `invite` was not available
  > either: it redeems ONLY by setting a password, and no product route sets a staff password.
  >
  > **AND IT IS A SECOND USE CASE, NOT A LINE INSIDE `inviteMember`.** `PortalInviteService`
  > calls that same method with `audience: "CLIENT_PORTAL"` and then sends its own letter. A
  > welcome buried in the shared write would mail every client contact TWICE — once welcoming
  > them to a staff product they cannot use. `usecase/staffinvite` mirrors its neighbour
  > exactly, and the negative test is the first one in the file.
  >
  > **THE THIRD ANSWER TO A FAILED SEND.** `requestMagicLink` swallows (a throw would build an
  > enumeration oracle out of an error path); `invitePortalContact` throws (a client has no
  > other door). This one REPORTS: `invitationSent` on the response, and the screen says
  > *"added, but the letter did not go out"*. Throwing would be worse than useless — the
  > membership is already written, so a 500 leaves a member created, an admin believing the add
  > failed, and a retry refused as a duplicate. Staff are the case that can afford this: the
  > login page issues a fresh link to any active account, which is exactly what they had before.
  >
  > **VERIFIED OVER HTTP, not from a unit test.** A real add through a signed-in session
  > returned `invitationSent: true` with a 72-hour expiry; the link redeemed into a STAFF
  > session and the second redemption answered 401; a `CLIENT_PORTAL` add on the same route
  > wrote no letter at all. The down migration was run against a live `welcome` row inside a
  > transaction, to prove the delete-before-narrow order — 0067's mistake — actually holds.
  >
  > **WHAT IT DOES NOT CLOSE.** Still no RESEND, and this widens the surface: a colleague whose
  > welcome bounced is now in the same position as T7.0's client, minus the trap, because they
  > can self-serve from the login page. The resend route is still the next thing to build here.

- [x] `(B)` **T7.0b** The RESEND, and the screen that had never existed to put it on. *Acc: a client contact whose invitation bounced can be sent it again, to the SAME address and no other; issuing a new one spends every live one; a contact who has set a password is refused; and a firm can do all of it from a screen rather than curl.*
  > **DONE 2026-09-07. No migration** — the state it needed was already in `tenancy.credential`,
  > which 0004 describes in as many words: *"a user with no row here (invited, never set a
  > password) is a normal state"*. `check` **1610** · frontend `check` clean ·
  > `demo:verify` **71**. Frontend: the panel below, plus `api:generate`.
  >
  > **THE DECISION T7.0 WROTE DOWN AND REFUSED TO GUESS, ANSWERED.** *"Did they lose the link,
  > or has somebody else taken over the account?"* — **only the first.** The route takes a
  > MEMBERSHIP id and nothing else that could reach the letter; the address comes off the
  > account and there is no parameter that could change it. Allowing an address change would
  > mean anybody holding a firm login could move a client's portal access to a mailbox of their
  > choosing. That is a new door — it wants its own event and probably an approval — and it is
  > deliberately NOT built rather than arriving as a side effect of a button called "Send it
  > again". Shrestha's instruction was to take the safest production-standard call; this is it.
  >
  > **AND IT IS THE CLIENT'S ROUTE, NOT A GENERAL ONE.** `StaffInviteService` has the identical
  > hole and does not get a route, for the reason T7.0a already wrote down: the sign-in page
  > issues any active account a fresh link, so a colleague whose welcome bounced has a door. A
  > client contact who has never set a password has none at all.
  >
  > **A NEW ISSUE SPENDS THE OLD ONES, and that is not tidiness.** An `invite` link is redeemed
  > by SETTING A PASSWORD, so one still live after the contact has set theirs is a password
  > reset sitting in an inbox for a week. Before this route there was exactly one by
  > construction; a resend that issued a second without spending the first would turn that into
  > a growing pile. `consumeUnusedFor(userId, purpose, at)` is a new port with the expiry in the
  > predicate, so the count it returns — carried on the ledger event as `supersededLinks` — is
  > LIVE links replaced and not rows touched. Zero is the ordinary answer and is what a walk
  > actually produced when the first link had run out.
  >
  > **REFUSED ONCE THEY HAVE ACCEPTED, and this is the security call inside the security call.**
  > Re-issuing an invite to somebody who already has a password is the firm resetting its own
  > client's password — which is exactly what the invite flow exists to prevent (the firm never
  > holds it). `InvitationAlreadyAccepted` → 409, and the message points at the sign-in page,
  > which is the door somebody who forgot their password already has.
  >
  > **THROTTLED PER CONTACT, NOT PER SENDER**, because the cost of getting it wrong lands on an
  > inbox outside the firm. Unlike `requestMagicLink`'s budget this one is REPORTED as a 429:
  > there is no account to be coy about, and silence would look exactly like the send failing.
  >
  > **THE SCREEN DID NOT EXIST, AND THAT WAS THE BIGGER FIND.** `/admin/people` has said for
  > months — under the button, and in the outcome notice — *"invite a client's own people from
  > that client's page"*. There was no such thing. The whole portal-invite and gate-4 surface
  > (T6.5, G3.4) shipped API-only: **five routes with no caller anywhere in the frontend**, so
  > the only way a firm could let a client into the portal it had been sold was a curl command.
  > `clients/[partyId]/portal-contacts.tsx` is that screen — who at the client can see this,
  > whether each of them ever got in, who let them in, invite, resend, remove, and the closed
  > grants underneath.
  >
  > **AND THE SCREEN WANTED A FACT THE API DID NOT SEND**, which is this repo's own rule firing
  > again: `PortalAccess` now carries `contactAccepted`. It is a different fact from the dates —
  > a grant is in force from the day it was written whether or not the letter ever arrived, so a
  > contact can be fully granted and completely stuck, which is the exact state the resend
  > exists for. Without it, "Send it again" would have been a button whose commonest outcome is
  > a 409. An `EXISTS` over `tenancy.credential` in the three record queries; integration-tested,
  > because it is computed in SQL and nowhere else.
  >
  > **THREE THINGS THE WALK FOUND THAT NO PROBE COULD**, all on a panel that measured 0 on every
  > one of the nine and on contrast, rings and tab order in both themes:
  >
  >   1. **The throttle's refusal described the wrong act.** *"too many sign-in attempts for this
  >      account; retry in 3582s"* — nobody had attempted to sign in, the only account named was
  >      the client's, and `3582s` is a number a machine produced. `TooManyAttempts` now takes
  >      the sentence (the sign-in one is still the default, so that path did not move) and
  >      `retryIn()` says the wait the way a person says one, rounding UP so "come back in 59
  >      minutes" cannot land on the same refusal.
  >   2. **`disabled={busy}` on a panel of rows hands focus to an arbitrary button.** `busy`
  >      disabled EVERY row button, the browser blurred them, and `Button`'s own focus-restore
  >      (dc832ae) gave focus to whichever re-enabled first — measured: after inviting somebody,
  >      focus landed on another contact's **Remove access**. Only the pressed button is marked
  >      now, and with `loading` rather than `disabled`, which is what that component's own note
  >      has been arguing for.
  >   3. **`useSwapFocus` fired one render too early.** "Remove access" unmounts by succeeding,
  >      so focus goes to `<body>` — but the outcome notice was set BEFORE the reload, so the
  >      effect ran while the pressed button was still mounted and focused, correctly did
  >      nothing, and was asleep by the time the row went. Every write in the panel reloads
  >      first and sets the outcome second. The order is the fix.

- [x] `(B)` **T3.1c** "Send for review" moves the task, because two answers to one question is a bug. *Acc: a firm names one of its own states as "with a checker"; sending a task for review puts it there, and the board column, the header and the review queue stop disagreeing. A firm that names none keeps exactly the old behaviour.*
  > **DONE 2026-09-07. Migration 0073** (`work_item_state.is_under_review`). `check` **1616** ·
  > `test:integration` **576** · frontend `check` clean · `demo:verify` **71** either side of the
  > walk. Frontend: the vocabulary screen's tick box, the state picker's re-sync, and
  > `api:generate`.
  >
  > **THE DEFECT, AND THE COMMENT THAT WAS RIGHT ABOUT WHY IT EXISTED.** Press "Send for review"
  > and the buttons become Approve / Send back while the header goes on reading **In Progress** —
  > and the firm's own state called "Under Review" sits in the dropdown as a second answer to the
  > same question. `requestReview` said out loud why it did not move anything: *"There is no flag
  > saying which of the firm's states means that, and comparing the code is the one thing this
  > module never does."* That reasoning is correct, so 0073 adds the flag rather than working
  > around it.
  >
  > **A FLAG, NEVER A NAME.** States are ROWS the firm owns (0050) — it may call this one "QC" or
  > "With the reviewer" — so the only thing code may read is `is_under_review`, exactly as it
  > reads `is_blocked`, `is_terminal`, `is_initial` and `is_success`. There is deliberately no
  > fallback to a state NAMED "Under Review", and the seed does not tick it: a firm that has not
  > said gets exactly the behaviour that shipped before, which is a supported answer and not a
  > gap. The eight starting states came from a previous vendor and are still unconfirmed.
  >
  > **THE `NOT BLOCKED` CHECK IS THE SHARP ONE.** 0051's trigger demands a `blocked_reason` on
  > every row in a blocked state and sending work to be checked has no reason to give, so a firm
  > that ticked both would make every review request fail on a field the admin never saw. Not
  > terminal and not initial follow 0050's own pairs. Partial unique index: at most one per firm,
  > because "where does work go when it is sent to be checked" must not be a coin toss.
  >
  > **THREE STATES ARE LEFT ALONE and each has its own reason**: already there (nothing to do),
  > TERMINAL (moving it out would clear `completedAt` and reopen finished work as a side effect
  > of asking for a check), and the dependency rule is NOT applied — sending work to be checked
  > says the work has been done, and refusing to record that because a dependency is open would
  > be refusing a fact that already happened. A stale `blocked_reason` IS cleared on the way in:
  > the task is not stuck, it is with a checker, and the sentence would be read as the reason it
  > is where it is now.
  >
  > **THE MOVE IS AFTER THE APPROVAL.** Opening the check is the act; the state is how the board
  > renders it. A failed move leaves an open review on work that still reads "In Progress" —
  > where every firm was before this, survivable and visible. The reverse would move a task into
  > a column meaning "somebody is checking this" with nobody checking it. `movedToStateId` is on
  > the `review_requested` event (null when the firm has named no state) and the state change
  > carries `byReviewRequest: true`, because a person choosing from a dropdown and a review
  > moving it are the same WRITE and are not the same FACT.
  >
  > **TWO MORE THINGS THE WALK FOUND, both invisible to every gate:**
  >
  >   1. **The state picker never re-synced.** `useState(currentStateId)` reads the prop once at
  >      mount and that component never unmounts, so the screen showed "Not Started" on an item
  >      the API had already put in "Under Review" — undoing the entire change on the one screen
  >      it was for. Latent before 0073, because nothing else moved a state from outside. Fixed
  >      with React's own compare-and-set-during-render recipe rather than an effect (renders the
  >      wrong value once first) or a `key` (remounts, blurring whatever had focus).
  >   2. **The admin screen offered a tick that could not be saved.** "Not Started" is the
  >      starting state and the API refuses the pair, so the row was enabled and the answer was a
  >      refusal. This repo's own rule — offering what will fail is a slower error — applied to a
  >      row that was easy to miss because the other three impossible ones were already disabled.

- [x] `(A)` **T3.5b** The pipeline carries its terms forward, so a price is typed ONCE. *Acc: an accepted quote is written up as a letter with every line, price and discount carried; an invoice line is billed from the engagement the letter created, at the price it agreed; and `/invoices` says what is still owed.*
  > **DONE 2026-09-07. No migration** — `engagement_letter.proposal_id` (0017) and
  > `invoice_line.engagement_id` (0027) have both existed since their modules shipped, with
  > nothing offering either. `check` **1639** · `test:integration` **582** · frontend `check`
  > clean · `demo:verify` **71** either side of the walk.
  >
  > **THE FINDING, FROM THE 2026-09-07 WALK.** ₹1,75,000 was typed by hand THREE times: once on
  > the quote, once on the letter, once on the invoice. Nothing in the system would have caught
  > a fourth digit. The letter form had no reference to a proposal at all, the invoice line had
  > no link to the letter, and pressing "Client accepted" left a page with **zero controls** on
  > it — the next thing is a letter and the product neither said so nor offered it.
  >
  > **HOP ONE IS A WRITE: `POST /proposals/{id}/engagement-letter`.** Every line comes across
  > with its pinned service version, wording, quantity, price, discount, billing frequency, four
  > scope overrides and pricing note. The CURRENCY and the rate come from the quote and cannot
  > be overridden — changing the currency underneath copied amounts reinterprets every figure on
  > the document, which is the exact mistake this exists to end. NOT carried: the advance (a
  > proposal has none), the clauses (chosen against the LETTER's jurisdiction), the totals (a
  > number computed for a document being replaced).
  >
  > **THE TWO THINGS A QUOTE CANNOT ANSWER, AND NEITHER IS GUESSED.** A letter states ONE
  > country and a proposal states one PER LINE: when they agree that is the answer and the field
  > never appears; when they disagree the caller says which, because it settles governing law
  > and the courts. And a letter line MUST name the company the work is for while a proposal
  > line may not — a proposal is an offer and the prospect may hold no entity yet. Such a line
  > is filed against an explicitly stated fallback or **SKIPPED AND REPORTED**, never against a
  > company nobody chose: on a signed page a guessed party is indistinguishable from an agreed
  > one. The screen says which lines will stay behind BEFORE it carries, and the letter shows a
  > banner after, because a letter that dropped two of eight terms LOOKS complete.
  >
  > **HOP TWO IS A READ: `GET /parties/{id}/billable-engagements`**, and that is the design. A
  > letter is the whole contract; an invoice bills a PERIOD of it, and which period, which
  > company and which services go on one document are decisions somebody takes every month — a
  > bulk "invoice this letter" would produce a document nobody chose the shape of. The invoice
  > line's picker prefills from the LETTER LINE's agreed figure, never the catalogue's list
  > price, which would quietly bill a negotiated discount away. Rows behind the advance gate
  > come back MARKED rather than filtered out, so the screen can explain why a signed service
  > cannot be billed yet.
  >
  > **AND `/invoices` NOW SAYS WHAT IS OWED (4d).** `status` is about the DOCUMENT, so a
  > fully-settled invoice sat beside one 75 days overdue, both reading `issued` and both showing
  > their full value. From `crm.invoice_balance`, the same view `/receivables` reads. Still no
  > "paid" badge and there must not be one: paid is arithmetic over invoices, payments and
  > credit notes, and a cached flag drifts the first time a payment is corrected.
  >
  > **THE CATALOGUE PICKER FILLS THE BOXES BESIDE IT (4c)**, on both the proposal and the
  > letter. Picking "Statutory audit — ₹1,75,000.00" left the wording and the price empty, so
  > the figure the option had just printed was typed underneath it. Prefilled and EDITABLE, and
  > the price only when the catalogue's currency matches the document's — a USD list price in a
  > rupee box is worse than an empty field, because one is obviously unanswered.
  >
  > **THREE DEFECTS THE WALK FOUND, and the first is the sharpest:**
  >
  >   1. **THE API REFUSED A VALUE ITS OWN DATABASE HAD JUST PRODUCED.** `fx_rate` is
  >      `numeric(20,10)` on a proposal, a letter and an invoice, and all three validated it
  >      with `isAmount`, which allows FOUR places. Postgres prints the column at full scale, so
  >      a rate stored as "1" reads back as "1.0000000000" and re-submitting it answered *"must
  >      be a non-negative decimal STRING with at most four decimal places"*. Invisible for four
  >      tasks because every rate was typed by a person and a person can only type four; this is
  >      the first thing in the product that feeds a STORED rate back into a write, and it died
  >      on the first real click. `isExchangeRate` / `RateSchema` now match the column. **An
  >      existing test asserted the wrong rule** — it refused a nine-decimal rate the database
  >      stores exactly — and was corrected to the real boundary, eleven, past which Postgres
  >      rounds silently.
  >   2. **A CANCELLED INVOICE READ AS ₹7,080 OWED.** The balance view holds a row for every
  >      invoice whatever its status, so the new column showed the total of a document the firm
  >      had withdrawn. Only an ISSUED invoice carries a balance now — `/receivables`' own rule,
  >      so the two screens cannot disagree.
  >   3. **The letter page's Jest-worker 500** was a stale dev server, not the change. Noted
  >      because it cost time twice: `curl` the route before believing the console.

- [ ] `(B)` **T7.1** GST / GSP + TRACES (filing, IRN e-invoicing).
- [ ] `(B)` **T7.2** MCA (RUN, SPICe+, AGILE-PRO) — RPA if no API.
- [ ] `(A)` **T7.3** Accounting: Zoho / Tally / QuickBooks / Xero (books pull at T–3).
- [ ] `(A)` **T7.4** Banking feed (payment reconciliation), payments (Razorpay/Stripe).
- [ ] `(A)` **T7.5** E-sign (DocuSign/Zoho Sign), WhatsApp, and the NOTIFICATION side of email — the chaser, the nudge, the monthly digest and the request inbox. *The THREE transactional letters (sign-in link, portal invite, staff welcome) are done: T7.0 and T7.0a.*

---

## The local demo database is not clean, and this is the list

Not security, and not blocking — but it has to be true before anybody is onboarded onto this
data, and each line is something a session did on purpose and wrote down rather than left for
somebody to find.

- **T6.9's walk raised two requests at Cobalt Foods and switched the firm's routing on**, to
  prove that the setting restates nothing. Undone by `npm run demo:fresh`, which re-verified
  **71/71**; the routing column is back at its `none` default.
- **T6.8's walk raised a real request at Cobalt Foods, answered it as Siddharth, and flipped a
  working paper's client visibility on** to prove the attachment path end to end. All of it was
  undone by `npm run demo:fresh`, which re-verified **71/71** and re-ran `test:integration` at
  **543** on a database built from nothing — a stronger check on 0068 and 0069 than applying
  them as an increment.
- **T6.7's walk ran the chaser sweep as of a FUTURE day (`2026-09-12`) to see the reader it
  built**, which wrote 4 `client_ask_chase` rows, and flipped one document's client visibility
  on and off. Both were undone by `npm run demo:fresh`, which re-verified **71/71** — the
  recovery this list already names, used rather than described. The scratch script that ran
  the sweep was deleted; `worker:once` has no `--as-of` and should not grow one for a walk.
- **AND THE WALK FOUND ONE THING IN THE DEMO'S OWN DATA that is not T6.7's to fix.** The
  75-days-overdue invoice now renders on a CLIENT's page as *"issued 01 Sep 2026, due by 18
  Jun 2026"* — issued after it was due. The seed back-dates the series with `seriesDate` and
  the API stamps `issued_on` at the moment of issue, which nothing could back-date until now
  because no client ever saw both dates side by side. Harmless to the firm, incoherent to a
  client, and it belongs with whoever owns the invoicing lane.
- **T3.3's walk back-dated 7 obligations across both `demo-*` firms and recorded 3 decisions.**
  The state renamed to "Missed" was renamed back. The ledger events are append-only and stay.
- **T6.4's walk answered `DPDP compliance`, which generated 4 filings, then added and withdrew a
  March exception.** All of it was reverted afterwards: the 4 instances and the exception row
  were deleted as `bib_owner` and the rule's `due_rule` is `NULL` again with the shipped
  `unresolved_reason` restored byte for byte (verified against `rulepack-in.ts`, and every one of
  the 37 tenants now holds one identical string). **The revert's own mistake is recorded because
  it matters more than the walk:** the first restoring `UPDATE` carried no `tenant_id` filter and
  therefore rewrote that reason on **all 37 tenants**, not the one firm. It is recoverable only
  because nothing could ever have edited that column before this task — the formula editor is
  what T6.4 built — so the shipped text was provably still the true value everywhere. **A psql
  session gets no RLS.** Scope every manual `UPDATE` in this database by `tenant_id`, or use the
  app.
- **The ledger keeps all of it**, including the reverted rule edits, and that is correct: they
  happened.

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

- [x] **Two collections read models were columns of uuids** — found by building the screens,
  which is the fifth and sixth time this codebase has learnt the same lesson. `/receivables`
  returned a balance with `partyId` and no name and no invoice NUMBER, so a collections list
  rendered one anonymous row per debt; and the dunning queue returned a rung with an
  `invoiceId`, which asked a partner to approve putting **a uuid** on credit hold. Both now
  return joined records (`ReceivableRecord`, `PendingDunningRecord`) — and the dunning one
  carries what is outstanding **now**, because a debt settled since the rung fired is exactly
  the case somebody rejects, and a stale figure would hide it. The smoke walk asserts the name.

- [x] **Invoicing shipped without the fee axis** — found by walking the product for a client
  demo, which is the first time anybody had opened it as somebody OTHER than a partner. Every
  invoice figure was visible to a delivery colleague with `commercialVisibility: false`, while
  proposals and engagement letters had redacted correctly since T2.2. An invoice is money end
  to end, so it is the module where the axis matters most, and it was the one module that did
  not have it. Now redacted the same way — the record is shown, the money is not — with the
  line QUANTITY and the tax RATE deliberately surviving, because how much work was done is the
  work and a statutory rate is not a price. `npm run smoke` asserts both halves.

  **Why no test caught it:** every test in the suite acts as a partner. The fee axis has no
  general guard the way the tenant wall and the route-permission table do; each module wires it
  by hand, which means the next money-bearing module can forget it too. A catalogue-derived
  check — every route returning an amount is exercised under both visibilities — would close
  the class. Not built.

- [ ] `(A/B)` **The smoke suite has outgrown its own rate-limit budget, and reports it as 21 broken features.**
  The general limiter allows 300 requests a minute; the suite is now 261 checks and each is one
  or more requests. A run gets roughly 240 checks in, starts being throttled, and reports the
  rest as **empty values and wrong status codes** — which reads exactly like broken invoicing,
  broken collections and a broken tenant seed. Confirmed harmless: the same tree run against
  `BIB_RATELIMIT_GENERAL_PER_MINUTE=5000` is **261 passed, 0 failed**.
  > **This is the second time a smoke failure has pointed at the wrong place**, and that is why
  > it is a task rather than a note. The first was the Windows `python3`/`mktemp` trap, which
  > reported 38 checks as **403** and sent the investigation into the authorization code twice
  > before anyone questioned the harness. Same shape both times: the harness fails, the
  > assertion reports it as a product defect, and the message names a plausible wrong culprit.
  > **The fix is for the script to notice a 429 and say so** — one check of the status before
  > asserting, and a line saying the suite is over budget — not to raise the limit, which would
  > weaken a real control to make a test pass. Whoever picks it up should also decide whether
  > the suite should reset the limiter between sections; it is in-memory, so a restart clears it.

- [x] **A `date` column was read by its LOCAL fields in two adapters, and the comment explaining
  it had the fact backwards.** `postgres.js` returns a `date` at **UTC midnight** — measured
  against the database, not assumed. `engagement-repository.ts` read `getFullYear()/getMonth()/
  getDate()` and carried a comment saying the UTC read "would be wrong east of UTC";
  `proposal-repository.ts` copied both. Both were backwards: the LOCAL fields are the ones that
  move, a day BACK, west of Greenwich. Latent rather than live — nothing here runs west of
  Greenwich — but it would have shown up as `engagement.effective_from` a day early on a laptop
  in New York or in a pod in `us-east-1`, and that column is the base every SLA due date counts
  from. **`invoice` and `dunning` were already correct**; the four now share
  `infrastructure/postgres/day.ts`, which carries the measurement.
  > **How it was found is the part worth keeping.** The bug was looked for in the wrong place
  > first — on the belief that `toISOString().slice(0, 10)` was the fault, which is what the two
  > private comments said. Probing the actual driver reversed the answer. A comment is not a
  > measurement, and two files agreeing is not two measurements — it is one, copied.
  > `tests/architecture/calendar-day.test.ts` bans the local getters in the adapters and shows
  > the lost day through `Intl`, so it fails on a UTC runner as well; a behavioural test alone
  > passes on every machine this is developed on.

- [ ] **One office, one rate-limit bucket.** The edge limiter keys on client ADDRESS at
  300/min, which is comfortable for a handful of browsers and is not obviously comfortable for
  a firm of forty behind a single office NAT gateway — they share one bucket. Found by the
  smoke walk hitting the same ceiling from the other direction (it now spends 288 of 300, and
  the next section added to it will not fit). Two questions, and both are product decisions
  rather than a number to quietly raise: should the authenticated surface key on the SESSION
  rather than the address, and is 300 the right figure for the anonymous one. Raising the
  default to make a test green is the one answer that is definitely wrong.

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
| ~~`brand_asset` (logo, signature image)~~ | **Done — landed with T3.6** as `files.brand_asset`, keyed on the issuing ENTITY rather than the firm (G1.2 applied to paper). PDF generation is now scheduled too: **T3.8**. | A |
| `communication` (email / WhatsApp threading) | T4.7 (A1 Intake) has nothing to attach to without it. | A |
| ~~`credit_note.reason` mandatory~~ | **Done, and this row was stale.** It shipped WITH T3.5: `migrations/0028_payments_credit_notes.up.sql:161` has `reason text NOT NULL CHECK (reason IN (...))`, plus an index on `(tenant_id, reason, issued_on)` so "why did revenue come off" is a query and not a read-through. Found while picking up T3.6. | A |
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
- ~~**G3.4** — pull `membership.party_id` forward from U1, or make `(B)`'s escalation wait.~~
  **Answered by events (2026-08-30): neither.** T2.9 built the reporting line on `membership`
  itself (`reports_to_user_id`, 0048) and escalation resolves through it today. What is left of
  G3.4 is Gate 4, whose consumer is U1 — so it moves to Phase 6 rather than being pulled
  forward. See G3.4's own note.
- **G3.4, re-checked 2026-08-31 because a stale note said `(B)`'s escalation needed it.** It
  does not, and the note was wrong: T2.9's `membership.reports_to_user_id` (0048) already
  answers "escalate to this assignee's manager", with live consumers in `usecase/verification`
  and `usecase/workitem`. What is left of G3.4 is Gate 4 — which parties a CLIENT PORTAL
  session may see — it is `(A)`'s, its only consumer is U1, and building it now would be a
  column with no writer. It stays in Phase 6, which is on the far side of the pause.
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
