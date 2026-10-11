# BiB AI Copilot: design (v1 / MVP)

Status: design approved in conversation, section by section, 2026-10-11 (Shrestha). This file is
the written spec for review. Branch `feat/ai-copilot` in both repos. Nothing here is built yet.

## 1. What it is

A copilot for a firm's STAFF, in a side panel on every screen and on `/copilot`. It answers
questions from the firm's own BiB records and does a fixed set of jobs in BiB (tasks, clients,
client asks, leads, proposals, engagement letters) on the user's behalf, never with more power
than the user has, and never without the user confirming the exact change.

**Hard requirement:** if the copilot breaks in production, the rest of BiB keeps working.

### Non-goals for v1

- The client portal (clients get a copilot in a later phase).
- Issuing invoices, recording payments, credit notes, signing, deleting anything, firm settings
  (roles, rules, processes), portal access. Even where the user's role allows them.
- Long-term memory written automatically from conversations.
- Any second AI vendor (no router model, no OpenAI Decisions API, no TypeSafe Jev).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Staff only; read + write | Shrestha |
| D2 | A write never exceeds the user's role | Tools call the same API routes as the screens, with the user's own session |
| D3 | Every write shows a confirm card; the API call happens only on Confirm; the copilot asks for what is missing first and never guesses a value | Human in the loop (Salesforce Agentforce, HubSpot Breeze, Zoho Zia do the same) |
| D4 | v1 includes proposal and engagement letter create AND send | Shrestha: "ye impt hai" |
| D5 | Side panel on every screen + full page | Page context ("make a proposal for this client") |
| D6 | Separate Cloud Run service `bib-copilot`, same repo and image | Isolation (§4) |
| D7 | Main model Claude Sonnet 5.5 (`claude-sonnet-5-5`); Haiku 5.5 (`claude-haiku-5-5`) writes summaries | Cost; Opus 5.5 only for a flow the eval proves Sonnet fails |
| D8 | Scope: BiB + general finance/tax/accounting knowledge, labelled as general and never used as a value in a write; anything else declined in one line | Shrestha chose option B |
| D9 | Memory: append-only chat, summary on return after idle or when long, long-term memory only from the user's own words | §9 |
| D10 | Per-firm monthly budget set by BiB; 80% bell to the firm's admins; 100% stops the copilot only | §11 |
| D11 | Copilot OFF for every firm by default; switching it on sets the budget | No firm is special in code; 10x Global is a tenant like any other |
| D12 | Chats kept 90 days after last activity, deletable by the user any time, readable only by that user | Actions live on in the audit trail |
| D13 | Migrations for the copilot use **55555–66666** | Shrestha; see §10.4 |
| D14 | Development and eval spend capped at **$20** for the whole MVP | Shrestha; §15 |

## 3. Architecture

```
Browser ──► bib-api (:8080)        unchanged except the copilot token, the `via` column,
   │            ▲                  the budget-alert route and a separate rate bucket
   │            │ tools call /api/v1 routes with the copilot token
   └──► bib-copilot (:8090) ──► Anthropic (Sonnet 5.5 / Haiku 5.5)
              │
              └─► schema `copilot` (own DB login role, own pool)
```

- Same repo, same Docker image as the API and the worker; entry `node dist/cmd/copilot.js`
  (locally `npm run copilot`).
- **The main API never imports copilot code.** An architecture test (dependency-cruiser) fails
  `npm run check` if anything outside the copilot files imports them.
- **The copilot never reaches business tables.** Its database login role (`bib_copilot`,
  `NOBYPASSRLS`) has rights on schema `copilot` only. Every business read and write goes through
  the API, so Gate 3 (role permissions, `api/permissions.ts`), fee redaction (`api/handler/*`),
  validation, rate limits and the ledger apply exactly as for a screen.

### 3.1 Code layout (backend)

| Path | Holds |
|---|---|
| `src/domain/copilot/` | Pure rules: conversation, message, pending action states, budget and cost arithmetic (bigint micro-USD, never a JS number), compaction triggers |
| `src/usecase/copilot/` | The agent loop, tool registry, prompt assembly; `ports.ts` (LanguageModel, BibApi, stores, Clock) |
| `src/infrastructure/anthropic/` | LanguageModel adapter over `@anthropic-ai/sdk`: one streamed call per loop step |
| `src/infrastructure/bibapi/` | HTTP client to `/api/v1` with the copilot token |
| `src/infrastructure/postgres/copilot-*.ts` | Repositories for schema `copilot` |
| `src/api/copilot/` | The copilot service's own routes |
| `src/config/` | The copilot's settings (keys, model ids, limits, internal keys); `process.env` is read nowhere else |
| `src/setup/copilot.ts`, `src/cmd/copilot.ts` | Wiring and entrypoint |
| `src/testfakes/` | `FakeLanguageModel` (scripted responses) |

### 3.2 One question

1. Panel → `POST /copilot/v1/conversations/{id}/messages` with the text, the page context and
   the browser's zone, `Authorization: Bearer cpt_…`.
2. Copilot → API `GET /api/v1/auth/me` with that token: user, firm, role, permissions, fee
   visibility. Nothing else authenticates a copilot request.
3. Firm switch on? Budget reservation succeeds (§11)? Otherwise a plain refusal.
4. Assemble the request (§9.1) and run the loop: model → tool → model … at most 8 model calls
   and 90 seconds.
   - A **read** tool calls the API and returns a trimmed result.
   - A **write** tool never calls a write route: it validates, resolves names, and saves a
     pending action (a card) for the user.
5. Stream text, progress lines (from tool names, e.g. "Looking up the client") and cards to
   the panel over SSE.
6. Save every message, record the real cost, release the rest of the reservation.
7. **Confirm** on a card executes exactly the saved steps (§7). The model is not asked again.

## 4. Isolation and failure

| Failure | User sees | What stays safe |
|---|---|---|
| Copilot service down or crashing | Panel: "Copilot is not available right now" + Try again | All of BiB (separate service; Cloud Run restarts it) |
| Anthropic 5xx, timeout, 429 | SDK retries twice, then "The AI service is slow right now, try again shortly" | Reservation released; nothing written (writes happen only on Confirm) |
| Safety refusal | Server-side fallback (`fallbacks: "default"`), then one polite line | n/a |
| Browser loses the stream | Answer completes server-side and is saved; panel reloads it | Spend not wasted |
| API refuses a tool call (4xx) | The model explains or asks, using the API's message | The API's own rules held |
| Step fails during Confirm | Card shows ✓/✗ per step; retry resumes at the failed step | Done steps never run twice |
| Budget used up | "This month's copilot limit is reached. Talk to your admin." | Rest of BiB |
| Bad copilot deploy | Roll back the `bib-copilot` revision only | API untouched |

**Kill switches:** `BIB_COPILOT_ENABLED=false` (service answers "copilot is off"), the firm's
switch (§11), and the frontend flag `NEXT_PUBLIC_BIB_COPILOT` (no panel at all).

**Boot validation** (the `validateServer` pattern, a fifth honest-registry stub): a
production-like copilot boot is refused with the fake model registered or with no Anthropic key.
Dev, QA and prod use different keys from different Anthropic workspaces, held in each
environment's own secrets, so a dev key cannot reach production by configuration alone.

## 5. Copilot token (main API change)

- `POST /api/v1/copilot/token`, session cookie, STAFF audience with a chosen firm only. Returns
  `{ token: "cpt_…", expiresAt }`, 15 minutes. The panel refreshes it before expiry and holds it
  in memory only (never localStorage).
- Stored as a hash, linked to the session that minted it. Resolution runs the same checks as
  `IdentityService.resolveSession` (revoked, idle-out, account disabled, membership removed), so
  ending the session ends every token it minted.
- The resolved principal carries `via: "copilot"`.
- **Refused for a copilot token:** `POST /auth/password`, `/auth/logout`, `/auth/switch-tenant`,
  `/api/v1/copilot/token` itself, and all of `/internal`.
- **Audit:** `ledger.event` gains a nullable `via` column. Actor stays the human
  (`actor_type = human`). The API sets `via = 'copilot'` for every event written during a
  copilot-token request through a request-scoped context read by the event repository, so no
  `recordEvent` call site changes.
- Copilot-token requests count against their **own** rate bucket, so the copilot cannot spend
  the user's screen budget.
- `POST /api/v1/copilot/budget-alert` (copilot token only): raises the 80% bell to the firm's
  admins through the existing notifications (0323), at most once per firm per month.
- Both new routes are declared in `api/permissions.ts` (deny by default) and pinned by
  `tests/api/auth-coverage.test.ts`; their refusals get a mapped error family in
  `api/domainerr.ts`, never a 500.

## 6. Tools

```ts
{
  name: "list_my_overdue_work",
  kind: "read",                      // read | write | send
  calls: ["GET /api/v1/work-items"], // the API routes it uses
  input: z.object({ /* … */ }),      // sent to Claude as a strict JSON schema
  shape: (json) => ({ /* … */ }),    // only the fields the model needs
}
```

- **Permission is derived, not declared.** A tool's permission is the union of its routes'
  entries in `ROUTE_PERMISSIONS`. The user's permissions come from `/auth/me`. A tool the user
  cannot run is not in the request at all. A test asserts every route a tool names exists in the
  API's route table.
- **The tool list is fixed per role** and sorted, so the cached prefix is identical across turns
  and users of that role.
- Inputs are validated with zod before a tool runs (tools are `strict: true` and use
  `eager_input_streaming: true`); a malformed input goes back to the model as an error result.
- **Fees:** a null amount from the API is passed as `"Hidden"`, never `0`.
- **Money:** the model never adds, converts or compares amounts across currencies. Totals come
  from the API (e.g. receivables per currency). The system prompt says so.
- **Lists** are capped (about 50 rows) and say how many more exist and how to narrow.
- **Records carry links** (`/clients/<id>`), so answers link to the screen.
- **Dates:** "overdue", "due this week" are computed by the API with `asOf`, as the screens do.
  The model resolves phrases like "next Friday" and the card prints the full date.

### 6.1 v1 tool areas (about 30-35 tools; final names and routes fixed in the plan)

- **Read:** my day; work items (filters: mine, overdue, assignee, state); one work item;
  escalations and checks waiting; search clients, colleagues and leads by name; client 360
  (account team, engagements); compliance calendar and why a client's calendar is empty;
  invoices, receivables, bills to raise, advances (fee-visible users only); leads, proposals,
  letters; firm numbers (dashboard); proposal reference data (catalogue by country, the firm's
  companies, signatories, standard terms).
- **Write:** create task, assign, change state (reason when blocked), add note; create client,
  correct details, set Key Manager / SPOC; ask the client for a document or answer; capture
  lead, change stage; create and edit a draft proposal; create and edit a draft engagement letter
  (including from an accepted proposal); remember (long-term memory).
- **Send:** send proposal; send engagement letter.

## 7. Writes: ask, card, confirm

1. The model calls a write tool. The tool **prepares**: checks the API's request schema for
   required fields, checks the firm's readiness facts for important optional ones (e.g. no Key
   Manager, no SPOC for a Dept), resolves names to ids. Missing or ambiguous → returned to the
   model, which asks the user. Two people named Asha → it asks which.
2. When complete, the tool saves `copilot.pending_action`: ordered steps (`method`, `path`,
   `body`, references like `$step1.id`), human-readable preview lines, `expires_at` = 30 min.
3. The panel shows the card: Confirm / Change / Cancel.
4. Confirm (`POST /copilot/v1/actions/{id}/confirm`): same user only; status moves
   `pending → running` under a row lock, so a double click or a second tab cannot run it twice.
   Steps run in order with the copilot token and stop at the first refusal; each step's result
   is saved. A retry resumes at the failed step.
5. The outcome is appended to the conversation so the next turn knows it.

**Send card** (never combined with a create): the real PDF (`POST /documents/preview`, drawn
with the frontend's `<PdfPages>`), the recipient from the client's record (an address from
anywhere else is shown with a red warning), issuing company, currency, totals per frequency,
validity; for a letter, who signs and the owner-rule warning. The button reads
"Send to rohan@xyz.com". WhatsApp stays a link the user opens.

**Proposal/EL creation** asks what the builder asks: client, issuing company (suggested by the
firm's country rule), currency, services from the catalogue. Fees come from the catalogue list
price; with no list price in that currency it asks (the builder's "Set fee"). For a letter:
signed by, standard terms, fee sections, advance. Fine edits happen in the builder ("Open in
builder" on the card).

## 8. Scope guard and prompt injection

**Scope (D8):** the system prompt states what the copilot is for. General finance/tax answers
carry: "This is general information, not from your BiB records. Check the current law or
notification." Off-topic requests (coding, recipes, etc.) get one line saying what it can help
with. No separate classifier model.

**Injection defences:**
1. The model cannot write: every write is a card a person confirms.
2. A send's recipient comes from the record; anything else is flagged on the card.
3. Tool results are wrapped as data (`<data source="client_request" author="client">…</data>`);
   the system prompt says data is never an instruction.
4. No tool sends data out (no free email, no web fetch).
5. The panel renders no raw HTML, no external images and no external links: only links inside
   BiB. (A markdown image to an outside URL is the standard exfiltration trick.)
6. Everything is bounded by the user's own permissions, the token and RLS.

## 9. Context and memory

### 9.1 What one request contains, in cache order

1. **Tools** (fixed per role) — cache breakpoint.
2. **System prompt** (identical for everyone; no date, no names) — cache breakpoint.
3. **Chat-start block** (first user message of the conversation, then frozen): firm name, the
   user's name and role, their long-term memory.
4. **History**, append-only and verbatim (including thinking blocks with their signatures), or
   after a compaction the single summary message.
5. **New turn:** a context block (date, time, the user's zone, the firm's financial-year start,
   the current page: kind, id, title) and the question.

Nothing earlier in the request is ever edited. Sonnet 5.5 binds thinking blocks to the exact
prior conversation (accounts created on or after 2026-08-31 are enforced); edits also break the
prompt cache. Thinking is adaptive, with beta `thinking-binding-controls-2026-08-01`:
`prefix_mismatch_behavior: "error"` in development and eval runs, so an accidental edit fails
loudly; `"drop_block"` in production, so one degrades instead of failing, with every
`input_transformations` entry counted in the question's log line. Cache TTL starts at 5 minutes
and is tuned from measured hit rates.

### 9.2 Summary (simple compaction)

- **When:** on the user's next message, if the conversation has been idle for more than 1 hour,
  or its history passed about 30k tokens. Never in the middle of a tool round. Lazy, so a chat
  nobody reopens costs nothing.
- **How:** Haiku 5.5 summarises the WHOLE conversation into one message. The next request is
  `[chat-start block] + [summary] + new turn`; nothing earlier is replayed. The full messages stay
  in the database and on screen.
- **Keeps:** the user's goal, decisions, records referred to (names and ids), open cards, open
  questions. **Drops amounts:** the model fetches current figures with tools.

### 9.3 Long-term memory

- Written only when the user asks ("remember that I handle FRC clients"), through an inline
  confirm ("Remember: 'handles FRC clients'? Yes / No"). Never extracted automatically, so text
  a client wrote can never become memory.
- Preferences and working context only: never amounts, client status, or other people's
  personal details. About 30 items (about 2k tokens). The user can list, edit and delete them.
- A change applies from the next conversation (the chat-start block is frozen).

### 9.4 A conversation is bound to the access it started with

Each conversation stores the role and fee visibility it began under. If either changes, the
conversation opens read-only ("Your access changed. Start a new chat."), because its history
may hold figures the user may no longer see.

## 10. Data

### 10.1 Tables (schema `copilot`)

| Table | Holds |
|---|---|
| `conversation` | tenant, user, title, created/last activity, started-under role and fee visibility, current summary, state |
| `message` | conversation, sequence, role, the exact content blocks sent/received, display text, cost |
| `memory` | tenant, user, text, created |
| `pending_action` | conversation, steps, preview, status, per-step results, expiry |
| `usage` | tenant, user, conversation (nullable after deletion), model, tokens by kind, cost micro-USD, outcome |
| `firm_setting` | tenant, enabled, monthly budget micro-USD |
| `setting_change` | tenant, operator key name, when, from, to (append-only by grant) |
| `reservation` | tenant, month, amount, released |

### 10.2 Row-level security and keys

Every table has `tenant_id NOT NULL`, RLS and a policy, and every reference between them carries
the tenant (`(id, tenant_id)` composite keys), so `tenant-keys.integration.test.ts` covers the
schema the day it exists. Conversations, messages, memory and pending actions are also walled by
user: a scope like `withRecipient` (firm AND whose, a RESTRICTIVE policy on a session setting), so
one user can never read another's chat, admins included (D12). Admins read only aggregated
`usage`. The copilot's own boot check refuses to start if `bib_copilot` can bypass RLS.

### 10.3 Retention and deletion

`bib_copilot` holds **no DELETE grant**, the house rule. Deletion goes through two SECURITY
DEFINER functions, the `notify.prune` pattern: `copilot.delete_conversation(id)` deletes one
conversation (with its messages, summary and cards) only for the user and firm in scope, and
`copilot.prune(before)` removes the scoped firm's conversations whose last activity is more than
90 days old. A daily job calls the second. `usage` rows stay, without content, for billing.
Memory stays until the user removes it (the same function pattern).

### 10.4 Migrations

Range **55555–66666** (D13). `cmd/migrate.ts` sorts filenames as strings and records applied
versions, so `55555_*` runs after every `0xxx` file and a later `0xxx` still applies. Copilot
migrations may depend on `0xxx` objects, never the reverse. The first one also records the range
in `migrations/README.md`. The `bib_copilot` login role is created by `migrate`'s role setup
like `bib_app`, with its password from config.

## 11. Budget and metering

- `firm_setting` is written only by BiB: the copilot service's `/internal` surface, guarded like
  the API's (its own `BIB_COPILOT_INTERNAL_KEYS`, same JSON shape, capability `copilot.manage`),
  writing under `withTenant` for the tenant named in the path, and locally `npm run copilot:firm
  -- --tenant <id> --on --budget <usd>`. A firm admin cannot change it. The copilot cannot write
  the ledger (no rights on that schema), so every change is also a row in the append-only
  `copilot.setting_change` (who, when, from, to).
- Amounts leave the service as decimal strings in USD, never JS numbers.
- The month is the firm's calendar month in the firm's time zone (UTC when the firm has not set
  one, BiB's existing rule).
- **Reservation:** before a question, under a row lock: `spent + reserved + max_question_cost ≤
  budget`, else refuse. `max_question_cost` is computed from the caps and the price table (8
  calls × worst-case input and capped output; about $1.85 on Sonnet 5.5). After the answer the
  real cost (from the response's `usage`) is recorded and the rest released.
- 80% → `budget-alert` (§5). 100% → refusal message.
- **Backstop outside our code:** each environment (dev, QA, prod) is its own Anthropic workspace
  with a spend limit.

## 12. Limits

| Level | Starting value |
|---|---|
| One question | 8 model calls, 90 s, output 8,000 tokens per call, trimmed tool results |
| One user | one question in flight, about 10 per minute |
| One firm | about 10 questions in flight |
| Database | pool of 5, 5 s statement timeout |
| API | separate rate bucket for copilot tokens |

## 13. Model configuration

- Main: `claude-sonnet-5-5`, streaming, adaptive thinking, `output_config.effort` starting at
  `low` for plain reads and `medium` for multi-step work, tuned by the eval.
  `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`.
- Summaries: `claude-haiku-5-5`.
- Cost table in code: Sonnet 5.5 $2 in / $10 out / $0.20 cache read / $2.50 5-min cache write per
  million tokens; Haiku 5.5 $0.10 / $0.50 (prompts up to 100K). Updated when Anthropic's prices
  change; costs are recomputed from `usage`, never estimated.

## 14. Frontend

- **Panel** mounted once in `AppShell`, opened from the top bar; the conversation survives page
  changes. About 420px beside the page at ≥1280px, over it below that, full screen on a phone.
  `/copilot` uses the same components (the existing `copilot-chat.tsx` shape).
- **Page context:** record pages (client, proposal, letter, task, job, invoice) call
  `useCopilotContext({ kind, id, title })`; other pages send the route only.
- **Streaming** with `fetch` + a reader (EventSource cannot send the Bearer token).
- **Config that fails silently if forgotten:** add the copilot origin
  (`NEXT_PUBLIC_BIB_COPILOT_URL`) to `connect-src` in `next.config.ts`, and the frontend origin to
  the copilot service's CORS. Both checked in a browser walk.
- **Components:** `ActionCard`, `SendCard` (with `<PdfPages>`), `MemoryChip`,
  `UnavailableNotice`; a safe markdown renderer (no HTML, internal links only).
- **States:** firm off → no button (unreleased features are not shown); service down → notice +
  retry; budget used → notice; access changed → read-only chat.
- **Screens:** "My memory" on `/account`; "Copilot usage" on Your firm, admins only.
- Wave 4 copy rules (short, English, no em dashes). Answers come in the user's language.
  `--brand` on the copilot's mark; only the user's message is a chip.
- **Accessibility:** the panel is a landmark, opens and closes from the keyboard, focus is
  managed, and a screen reader hears the finished answer once, not every token.

## 15. Testing and the $20 plan

### 15.1 Free (in `npm run check` or integration, no key, no money)

- Agent loop with `FakeLanguageModel`: tool → result → text, refusal, timeout, step cap.
- **Cache stability:** two consecutive requests share tools and system byte-for-byte and the
  history only grows (Anthropic's three-step check, as a test).
- Domain: cost arithmetic, reservation, card states, compaction triggers, tool filtering.
- Architecture: the main API never imports copilot code.
- Integration: RLS (user A cannot read user B's chat; firm wall), copilot token refused on the
  §5 routes, `via` written to the ledger, concurrent reservations.
- Browser walk (Playwright) at 1440 / 1280 / 390: open panel, ask, confirm a card, send a
  proposal (Mailpit), an associate attempting a partner action.
- **Recorded responses:** real model transcripts from a paid run are replayed in tests for free
  until the prompt or tools change.

These prove the structural safety guarantees: permissions (API), fee hiding (API), firm wall
(RLS), no autonomous writes (code), recipient from record (code), no external links (panel),
cache-stable history (code).

### 15.2 Paid, on demand only

- **Development** runs on Haiku 5.5 at low effort (plumbing only).
- **Core eval:** 40 questions on the demo firm (`npm run demo:fresh`), Sonnet 5.5: reads,
  writes (card contents), proposal/EL, ask-for-missing, dates, off-topic, borderline, injection,
  after-summary. Checked by code wherever possible; free text by a Sonnet 5.5 judge through the
  Batch API (50% off). Off-topic and injection questions run three times.

| Item | About |
|---|---|
| Development on Haiku | $2 |
| 4 core eval runs × ~$2.2 | $9 |
| Judge | $0.3 |
| Safety repeats | $0.5 |
| Shrestha's own testing (~100 questions) | $5 |
| Buffer | $3 |
| **Total** | **~$20** |

The dev workspace has a **$20 hard spend limit**. This is development spend; a firm's real use
in QA or production comes out of that firm's monthly budget (§11).

### 15.3 Deploy gate

- Structural guarantees (15.1): 100%.
- Model-decided safety (off-topic, injection): zero failures in the core eval.
- Everything else: about 90%, each failure reviewed by Shrestha.
- The 40-question eval is a smoke-level check. The full ~150-question eval runs when the budget
  allows, before rollout to more firms.

## 16. Phases

| Phase | Builds | Shrestha can try |
|---|---|---|
| P0 Foundation | copilot service, config + boot validation, migrations, copilot token + `via` + rate bucket, loop + fake model, Anthropic adapter, SSE, basic panel, 3 read tools | "what is overdue for me" |
| P1 Reads + memory | all read tools, scope guard, date/page context, chat list, summary, long-term memory, first eval | any question, an old chat, "remember…" |
| P2 Writes | cards, ask-for-missing, task / client / KM-SPOC / ask / lead | "create a client…" |
| P3 Proposal + EL | create, PDF preview, send card | "make XYZ's proposal and send it" |
| P4 Budget + limits | firm switch, reservation, 80% bell, usage screen, kill switches | hitting the limit |
| P5 Hardening | eval runs, effort tuning, `run_copilot.tf` for Anish | QA deploy, on Shrestha's go |

## 17. Dependencies and open items

| Item | Owner | Needed by |
|---|---|---|
| Anthropic dev workspace + API key, $20 spend limit | Shrestha / Anish | end of P0 (P0 runs on the fake model until then) |
| 10x's consent to their data going to Anthropic (EL clause; BiB's own terms with the firm) | Shrestha with Sid | before any QA use on 10x's data |
| `run_copilot.tf`, secrets, Anthropic QA/prod workspaces | Anish | P5, before QA |
| `/internal` exposure on QA and the provisioning-key takeover path | separate security task, parked | before production |
