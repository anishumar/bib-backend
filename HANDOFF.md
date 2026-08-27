# BiB Backend — Setup Brief (session handoff)

> Read this first, top to bottom. It is self-contained: every decision, the conventions to
> follow, and the source material by absolute path.
>
> **STATUS (resolved):** §1 decided → **Node/TypeScript**, standalone product. The scaffold
> is built and green: hexagonal layers, the RLS tenant wall (verified), the enforced import
> wall, lint/arch/CI gates, and the **`tenancy` module** end-to-end. The authoritative rules
> now live in `CLAUDE.md`; this file is the background. Next module: `crm`.

## 0 · Mission

Build the **backend infrastructure for BiB (Business in a Box)** — a multi-tenant **B2B2C**
SaaS for cross-border professional-services firms (CA / CS / legal / payroll / vCFO).
It must be **scalable, reliable, and sellable to many firms**, where **both firm staff and
their clients log in**. It is a *separate product* from the existing `10xcrm` repo, which is
kept frozen as a **reference implementation**, not modified.

The BiB business/process model is fully specified in the flowcharts (see §7): 11 process
flows + an 11-agent registry. The architecture completes all 11 because they are **one
engine + rule packs (config) + connectors (adapters)**, all riding on a tenancy + audit-log
substrate.

---

## 1 · THE ONE OPEN DECISION — resolve before schema

**Language: Node/TS vs Go.** Everything else is locked. It hinges on one question:

- **Standalone product**, own repo/deploy/on-call → **Node/TS**. Reuse the proven `10xcrm`
  TS substrate (saves months), share zod types with the TS frontend, best fit for a
  90%-CRUD/workflow/document domain. **This is the current lean**, given BiB is framed as a
  separately-sold product.
- **Run by the Zaap team on the shared Go platform** (sharing `platform-lib-zoop`, archtest,
  ArgoCD, shared Aurora) → **Go**, for fleet consistency.

The **crown-jewel conventions are identical either way** (SQL migrations, RLS, hexagonal,
config-as-adapter, fail-closed). Only the tooling differs (archtest ↔ dependency-cruiser,
slog ↔ pino, viper ↔ zod, platform-lib-zoop ↔ a small internal shared pkg). If Node,
migrations can still run via the `golang-migrate` binary so that convention stays 1:1.

---

## 2 · Decisions locked (ADRs)

- **ADR-01 · Tenant isolation** — Pool model: shared Postgres/Aurora + **RLS per tenant**.
  Build the `tenant → connection` **resolver seam** now (returns one cluster for all today);
  do **not** build per-tenant clusters/regions. Revisit when a customer demands own DB/region.
- **ADR-02 · Identity above tenant** — A login belongs to a **person, never a tenant**.
  Global `user`; `membership(user × tenant × audience × role)`, many per user. Client and
  tenant are **distinct in the product**; no client→tenant promotion machinery (party model
  keeps it possible later).
- **ADR-03 · Auth / SSO** — Minimal now (password + magic link) **behind a port**; lean on
  existing platform auth. **Buy SSO (WorkOS / SAML / SCIM) only when an enterprise deal
  requires it.**
- **Conventions** — Follow the **Zaap standard verbatim** (digest in §5) + the **tenancy
  addendum** (§6). This is the PR review gate.
- **Structure** — Modular monolith, **hexagonal**, mirroring the Zaap service skeleton, with
  seams ready to split into services later. Build A (one deploy + worker); extract services
  only when a real driver appears.
- **Frontend** — Separate **TS / Next** app: two route groups, staff workspace + client
  portal. (Not this session's scope; backend first.)

---

## 3 · The four scoping gates (the B2B2C core)

Every business query answers to four independent questions. Conflating any two is the
retrofit trap.

| Gate | Question | Enforced by |
|------|----------|-------------|
| 1 · tenant | Firm A cannot see Firm B | **RLS** + `SET LOCAL app.tenant_id` |
| 2 · audience | staff workspace vs client portal, same data | `membership.audience` in usecase |
| 3 · role | which actions the caller may take | role check in usecase |
| 4 · record scope | portal user sees only their own company's rows | 2nd RLS/usecase predicate |

**Fee/commercial visibility is a fifth, orthogonal axis** — a flag on the membership, never
folded into role (delivery staff see the work, not the money).

Identity shape:
```
user (global — one login, one email)
  └─ membership (user × tenant × audience × role)   many per user
       audience = STAFF | CLIENT_PORTAL
       scope    = which parties this portal user may see
```

---

## 4 · Service map + build order

One service (or module, if monolith) per bounded context. Build the first three — they carry
the flagship slice end to end. **Do not build all before a paying tenant.**

| Service | BiB context | Order |
|---------|-------------|-------|
| `tenancy` | tenants, memberships, the four gates, org-switch | **1** |
| `crm` | leads → clients → proposals → engagement letters | **2** |
| `billing` | invoicing, gapless series, dunning, collections | **3** |
| `config` | services, workflow templates, rule packs, SLAs | then |
| `work` | job/task engine: orchestrator, scheduler, verification queue, confidence tiers | then |
| `document` | documents + client data + OCR | then |
| `ledger` | immutable audit log (append-only) | then |
| `agent` | AI runtime, confidence tiers, RAG — **server-side**, tiered Claude Haiku/Sonnet/Opus | last |

Reuse existing platform **auth** and **notifications** rather than rebuilding.

---

## 5 · Zaap conventions digest (the standard — inherited verbatim)

The source docs were pasted into the previous chat and are **not files**; this digest
preserves the load-bearing rules. Follow all of them.

**Repo skeleton (per service):** `cmd/{server,migrate}` · `internal/{api,usecase,domain,
infrastructure,repository/postgres,platform,telemetry,config,setup,testfakes}` ·
`migrations/` · `tests/architecture/` · `.env.example` · `Makefile` · `docker-compose.yaml`.
One file per concern named after the concern (no `utils.go`). `internal/` for everything.

**Hexagonal — the one rule: imports point inward.**
- `domain` imports **only stdlib** — small, boring, no I/O, no vendor. Nouns + sentinel errors.
- `usecase` imports only `domain`. Holds services + `ports.go` (interfaces = the seams).
  **Ports live next to the usecase that needs them**, never a shared `internal/ports/`.
- `api` (driving adapters: HTTP/webhooks/S2S/cron) imports usecase/domain, never infra.
- `infrastructure` (driven adapters: postgres/vendor SDKs) imports usecase to satisfy ports.
- `setup` is the **only** place a concrete type meets an interface (composition root).
- **Anti-corruption:** adapters take `raw []byte → our domain type`. No vendor type crosses
  the door. No vendor value in a domain enum (that's a 2nd adapter, not a 2nd constant).
- **Sentinel errors in domain; HTTP status mapping in `api`** via a closed `domainerr` set +
  `Map(err)`. Never string-match errors; use `errors.Is`. Closed error-code set:
  VALIDATION/UNAUTHORIZED/FORBIDDEN/NOT_FOUND/CONFLICT/RATE_LIMITED/NOT_IMPLEMENTED/INTERNAL.

**Migrations (highest-density, hardest to undo):**
- `NNNN_snake_case.{up,down}.sql`, 4-digit, monotonic, no gaps. Every up has a down.
- **Immutable once applied anywhere** — never edit/renumber; fix forward with a new number.
- `0001` is the bootstrap: roles, schema, `REVOKE … FROM PUBLIC`, grants,
  `ALTER DEFAULT PRIVILEGES`, `pgcrypto`, shared `public.set_updated_at()`.
- Wrap DDL in `SET ROLE <owner>; … RESET ROLE;`. Downs use `IF EXISTS`, run newest-first,
  and **never drop shared/cluster resources** other schemas depend on. Seeds are idempotent
  (`ON CONFLICT DO NOTHING`); reference data → migrations, test fixtures → not.
- Migrate as a one-shot job (ArgoCD PreSync / equivalent) as a **DDL role**, never the app's
  DML login.

**Config is an adapter:** one loader package is the **only** importer of the config lib
(viper/zod). `os.Getenv` (or `process.env`) appears **only** there. Bind keys explicitly
(the list is the contract), parse into **types at the boundary** (durations, lists, domain
types), validate at boot. Secrets get a masked `String()`. Env label
(`APP_ENVIRONMENT`) is a **security control**: production-like includes QA/UAT.

**Enforcement (this is what makes it real, not aspirational):**
- **Architecture-as-test** (Go: archtest; TS: dependency-cruiser / eslint-boundaries):
  domain/usecase must not import adapters; `os.Getenv`/`process.env` only in config; CI red
  on violation, one `t.Run`/rule named as a sentence.
- **Compile-time port assertions** in every adapter + fake (`var _ Port = (*Impl)(nil)`; TS:
  `satisfies` / explicit implements).
- **Honest registry** — three states: registered / implemented-but-unregistered / absent.
  Half-built connectors compile and satisfy the port but can't be reached until registered;
  config refuses to boot if it names an unregistered provider.
- **Fail-closed boot validators** — crash-loop beats silent degradation. Bad config/wiring →
  process refuses to start with an **actionable** message (name the var, the bad value, the
  valid set).
- **Failure policy in the doc comment** per outbound dependency (best-effort vs must-succeed
  + why). **A bad outcome is not an error** — status code belongs to the protocol.
- **Idempotency by derived id** (`UUIDv5(namespace, providerId)`) on external callbacks; if
  two services/langs derive the same id, the namespace is **byte-identical** with a
  cross-repo comment.
- **No TODOs / placeholder code** merge gate — finished, or an explicit `ErrNotImplemented`
  stub. Tests beside code; real-Postgres integration tests separate and explicit.

---

## 6 · Tenancy addendum (net-new on top of Zaap — Zaap isolates by *service*, not *tenant*)

- **Every business table:** `tenant_id uuid NOT NULL` + RLS enabled + isolation policy.
  Global reference tables (statutory rule packs, country lists) are the explicit exception —
  mark `-- GLOBAL: not tenant-scoped`.
- **DML login is `NOBYPASSRLS`.** Owner / migration-runner / DML-login role split as Zaap;
  the app role simply cannot see across the wall.
- **`SET LOCAL app.tenant_id`** inside each request transaction (never on the pooled
  connection — leaks on the pooler). Thread it through the platform call-context.
- **All DB access goes through the `tenant → connection` resolver** (ADR-01).
- **The tenant wall, defended in three places** (the highest-consequence risk — a leak fails
  silently, like every Zaap outage): **(1) RLS** at the DB · **(2) fail-closed boot
  validator** that refuses to start if the DML role can bypass RLS or tenant-context wiring
  is absent · **(3) arch test** asserting the raw pool is reachable only via the resolver.
- **Client-portal record-scope** = the same RLS mechanism with a tighter `USING`:
  `tenant_id = app.tenant_id AND party_id = ANY(app.visible_parties)`.

`0001` gains RLS as a *delta*, not a rewrite:
```sql
SET ROLE crm_owner;
ALTER ROLE svc_crm NOBYPASSRLS;                 -- the tenant wall
CREATE TABLE crm.client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,                       -- every business row
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crm.client ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm.client
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
RESET ROLE;
```

**Domain non-negotiables (compliance + money):** money = amount + currency + FX-rate +
rate-date (`numeric`, never float); legal-deadline dates are jurisdiction-local, not UTC
(financial-year ≠ calendar quarter); every unique constraint consciously scoped
(email global; invoice number gapless per-entity-per-tenant under lock); idempotency keys on
every external callback; **PII kept out of the append-only ledger** (erasable row by id, for
GDPR/DPDP); soft delete only; every state transition writes an **event naming its actor**
(`human | agent | system`).

---

## 7 · Source material (read as needed, by absolute path)

- **Reference implementation & patterns to reuse (if Node):**
  `/Users/anishumar/Desktop/10xcrm/` — read `CLAUDE.md` first (full architecture rationale),
  then `src/` (multi-tenant RLS via `withTenant`/`tenant-context.ts`, party model, append-only
  `event` log, ports/adapters, deal lifecycle state machine, obligations, gapless invoice
  numbering, three Postgres roles, onboarding/`firm:create`). **462 passing tests** — this is
  the proven substrate to extract, not reimplement, if Node/TS is chosen.
- **BiB process flows (all 11) + agent registry + module map:**
  `/Users/anishumar/Desktop/10xcrm/BiB-System-Workflows-v2.19.html` — another vendor's
  proposal. Treat **domain facts** as evidence (statutory dates, dedupe = phone+PAN+email,
  agent guardrails); do **not** lift its module numbering/branding.
- **Command Center UX prototype:** `/Users/anishumar/Desktop/10xcrm/file.txt` — a React mock;
  UX/interaction reference (revenue-lifecycle state machine is the strong part). Its patterns
  (RBAC-in-view, hardcoded FX, browser-side AI call, single-tenant) are anti-patterns — do
  not inherit.
- **Published artifacts (WebFetch to read):**
  - Login & tenancy flow (the four gates): https://claude.ai/code/artifact/d541104d-c771-48af-b3be-17dbf2e30697
  - BiB Backend Conventions v0.1 (tenancy addendum): https://claude.ai/code/artifact/ed938efb-bbe2-48dd-bab5-7677cebac7f8

---

## 8 · First actions for the next session

1. **Resolve §1** (Node/TS vs Go) — one question: standalone product, or run on the shared
   Zaap Go platform? Lean: Node/TS.
2. **Scaffold the repo** in the chosen stack, mirroring the Zaap skeleton (§5), with the
   layer/import wall configured and the architecture-as-test harness in place from commit 1.
3. **`tenancy` first:** the `0001` bootstrap migration with roles + RLS (§6), the
   `tenant → connection` resolver, the global `user` + `membership` schema, and the
   fail-closed boot validator asserting the tenant wall.
4. Then `crm`, then `billing` — the flagship slice, staff side first, client portal after.

**Local dev note (from setting up `10xcrm` on this machine):** Docker is unavailable
(Colima is x86-under-Rosetta and won't start; Docker Desktop uninstalled). There is a native
Homebrew **Postgres 18 on `localhost:5432`** with `pgcrypto/citext/pg_trgm/btree_gist` and
**pgvector 0.8.6** installed. Use it directly, or fix the container runtime, when standing up
the new project's DB.
