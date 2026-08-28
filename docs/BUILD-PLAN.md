# BiB — Build Plan & Task Board

The single source of truth for what we're building, who owns it, and what's done.
Both developers work off this file. Commit changes to it like code.

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
- [ ] `(A)` **T2.1b** **Lead assignment**: round-robin over active staff behind an
  `AssignmentStrategy` port; territory once its axis is chosen with the client. *Acc: N leads
  captured with no owner distribute evenly; a territory rule overrides the rotation.*
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
- [ ] `(A)` **T2.4** **C5 spawn bridge**: signed EL emits the engine's job-creation trigger (event, not a direct call). *Acc: a signature produces a `contract.active` event the scheduler consumes.*

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
- [ ] `(B)` **T2.6** **P4 Scheduler** (pg-boss): recurring, due dates, triggers; spawns at T–X per config. *Acc: a monthly obligation spawns 12 instances a year out.*
- [ ] `(B)` **T2.7** **P3 Orchestrator**: walks the step graph, resolves each step's executor (agent | human | agent-with-approval). *Acc: a 3-step graph advances step to step, sequential + parallel + branch.*
- [ ] `(B)` **T2.8** **P5 Agent-runtime seam**: executor abstraction + `confidence_tier` rows; guardrail hooks (no auto-commit above tier). *Acc: a fake executor commits >0.95, queues 0.70–0.95, escalates <0.70.*
- [ ] `(B)` **T2.9** **P6 Verification queue**: routing role→skill→tier→load→SLA; **maker≠checker as a CHECK constraint**. *Acc: the actor who produced an output cannot be its approver (DB rejects it).*

**Milestone M2:** a signed engagement letter automatically spawns jobs that walk a configured step graph and land in a verification queue — the **engine runs end-to-end** with fake executors. *(This is the demoable core spine.)*

---

## Phase 3 · Close the loop  (~4–6 weeks)

### Lane B — delivery
- [ ] `(B)` **T3.1** **Work items**: `work_item` + `checklist_item` + `work_item_dependency` + `approval`; states/priorities as **rows not enums**. *Acc: a filing arrives pre-assigned to the client's Dept SPOC.*
- [ ] `(B)` **T3.2** **Obligations**: `obligation_template` → `obligation_instance`, statutory **and** internal-target dates, T–X lead time, financial-year periods. *Acc: an Indian quarter is Apr–Jun; March TDS exception resolves to 30 Apr.*
- [ ] `(B)` **T3.3** **Missed-deadline state**: past statutory date → partner decision queue (provisional filing vs late fee), logged. *Acc: a missed deadline is a state, not an error; partner choice writes an event.*

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

- [ ] **Composite tenant keys across `core`** — `core.organization`, `core.person`,
  `core.legal_entity`, `core.party_identifier` and `core.party_relationship` still reference
  their parents by id alone. Foreign-key checks run as a system operation RLS does not filter,
  so each is the hole 0006 closed for `config` and 0007 closed for `crm.lead`: one firm's row
  can attach to another firm's object. It leaks nothing — RLS still hides the row both ways —
  but the wall should make it unrepresentable rather than invisible. Found while building T2.1;
  its own migration and its own commit, so the constraint change is reviewed on its own.

## Parking lot / decisions to make (don't build on guesses)

- Dev vs QA cloud DB strategy (recommended: local seeded-from-cloud + shared QA). *Deferred by user.*
- zod 3 → 4 migration (unlocks `@hono/zod-openapi@1.x`) — own commit, later.
- Product name; which prior-vendor data (if any) migrates.
- Real-integration access: which portals/sandboxes the client can grant, and when.
