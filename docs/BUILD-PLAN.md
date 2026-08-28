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
- [ ] `(A)` **T2.2** **C3 Proposals**: catalogue-built, scope + pricing, per-country quoting, send/track (views, expiry). *Acc: a proposal renders from catalogue rows; discount over limit blocks on approval.*
- [ ] `(A)` **T2.3** **C4 Engagement letter**: clause library (per jurisdiction, versioned), e-sign **port** (fake), advance-fee gate. *Acc: signing fans out one EL into one engagement per line.*
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
  > Gate: `npm run check` 274 tests · `test:integration` 54 · `smoke` 58.
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
