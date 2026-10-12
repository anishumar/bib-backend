# FinCompliance: handoff (2026-10-12)

**From:** Anish (built with Claude agents). **To:** Shrestha, who continues on these branches, backend and frontend.
**Read first:** [`FIN_BUILD_PLAN.md`](FIN_BUILD_PLAN.md) (the tracker: ground rules, open decisions, every task with its check, the "Wave 3 contract") and [`FIN_FLOW.md`](FIN_FLOW.md) (the whole flow in plain words). `CLAUDE.md` has the house rules.

## Where things stand

`feat/fin` (backend and frontend) holds everything finished and checked: F0 (fin's own schema, process, switches, wall, sandbox loader), F1 (request templates, due dates, the monthly requests sweep), F0.8 (the "Files received" screen), F2.1–F2.2 (intake and routing), and the wave 3 contract (commits `01c4316`, `16d8399`). Gates passed on `feat/fin` before wave 3: backend `check` 3679 unit and `test:integration` about 1161, frontend `check`.

**Wave 3** was built by six agents in parallel, one branch each, branched from `16d8399`. They were stopped by an API session limit before finishing. Each branch's work is saved as found, ending in a `WIP wave 3 (…)` commit. **Every branch typechecks cleanly**, but `npm run check` and `npm run test:integration` were NOT run on the WIP commits. The commits before each WIP commit were made by the agents after their own checks.

| Backend branch | Tasks | Migration | State |
|---|---|---|---|
| `feat/fin-w3-patterns` | F5.1–F5.6: history patterns (spike, new vendor, recurring missing, frequency change, GL drift), explanation text, learning from decisions, 3-month gate, `scripts/fin-backtest.ts` | none | 3 finished commits + small WIP (backtest tuning). Pure code, no DB. |
| `feat/fin-w3-readers` | F2.3, F2.7, F2.9 (PDF half), F2.10: PDF text (pdfjs-dist), image normaliser (sharp), ZIP with limits, the `pdf_text` bank/card statement reader, `finFileReaders()` in `setup/fin.ts` | none | 3 finished commits + small WIP. |
| `feat/fin-w3-asks` | F0.6: fin read failure → 503 `FIN_UNAVAILABLE` (`infrastructure/fin/unavailable.ts`); F1.6: several files per ask (portal) and staff "upload for the client" | `0390_client_ask_on_behalf` | F0.6 committed; F1.6 is WIP. |
| `feat/fin-w3-findings` | F4.1 `fin.rule_parameter` (SG GST/CPF/SDL, dated), F4.2 `fin.finding` + append-only `fin.finding_decision`, F4.3/F4.5 pure checks, `books:write` permission, findings routes, backtest against seeded exceptions | `0387_fin_findings`, `0388_books_write_permission` | All WIP. |
| `feat/fin-w3-lines` | F2.5 `fin.read` + `fin.transaction_line` (`proposed` frozen) + `fin.source_format`; F2.6 sheet reader with layouts learnt; control totals; the read sweep in `fin:once`; `GET /api/v1/fin/reads[/{id}]` | `0386_fin_lines` | All WIP. |
| `feat/fin-w3-extract` | F2.4: the AI reader (`vision`): Claude adapter with forced tool call, zod validation, retry once, circuit breaker, run cap, monthly budget per firm, `fin.extraction_usage`, `BIB_FIN_AI_*` config, `npm run fin:extract-one` | `0389_fin_extraction_usage` | All WIP. |

| Frontend branch | What | State |
|---|---|---|
| `feat/fin` | Files received screen, request templates screen, due days | done |
| `feat/fin-w3-asks` | F1.6 UI: multiple files on the portal action centre, "Upload for the client" on the work item's asks panel, regenerated `schema.d.ts` | one commit (`3c0932e`), checks not confirmed |

## What to do next, in order

1. **Verify each branch on its own** (its own database, see below): `npm run check` and `npm run test:integration`. Fix what is red. Read the WIP diff before trusting it.
2. **Merge into `feat/fin`** in this order: patterns → readers → asks → findings → lines → extract. Expect conflicts only in the shared files every agent appended to: `src/setup/fin.ts`, `src/api/router.ts`, `src/api/permissions.ts`, `src/api/domainerr.ts`, `src/api/handler/fin.ts`, `src/domain/fin/errors.ts`, `src/domain/ledger/model.ts`, `docs/EVENT-CONTRACT.md`, `tests/api/{auth-coverage,openapi}.test.ts`. Keep both sides each time.
3. **Wire after the merge** (each is small):
   - The read sweep's reader list in `setup/fin.ts`: `sheet` (lines), then `pdf_text` (readers, `finFileReaders()`), then `vision` (extract). Without an API key the vision reader answers `later`, so PDFs and images wait unread instead of going to a person.
   - Use `infrastructure/fin/unavailable.ts` (asks) in the new fin adapters (lines, findings, extract) so their read failures are 503s too.
   - Migration `0391`: the foreign key from `fin.finding_line.line_id` to `fin.transaction_line (id, tenant_id)` (findings could not add it, because lines is another branch).
   - The route to confirm or save a sheet layout (lines has the service method, `saveFormat`/`confirmFormat`) on `books:write` (from findings).
   - Regenerate the frontend's `schema.d.ts` against the merged backend.
4. **Gates on the merged branch**, then `npm run migrate` on the local `bib` DB (0386–0391) and `npm run fin:once` against the sandbox firm (`fin-sandbox`, about 1,169 files already taken in). The sheets and digital statements should be read; PDFs and photos wait for the AI key.
5. **Write it up**: tick the tasks in `FIN_BUILD_PLAN.md` with done-notes and commit shas, add a Log row, and add the fin sections to `CLAUDE.md` (reads and lines, readers, the AI reader, findings, patterns).
6. **Then the next phase**: F2.8 staging (review by exception, commit gated on `books:write`), F3 (masters, counterparty key, coding, posting, bank reconciliation, trial balance, GST F5), F4.4 bank checks, F4.6–F4.7 findings on the desk, F5 profile table, the scorecard (S), F6, F7, F9. The order and checks are in the tracker.

## How to work safely here

- **Node 22** for everything (`nvm use 22`). On Node 20, `tests/fx/feeds.test.ts` fails, as it does on `main`.
- **The local `.env` sends real DocuSign envelopes and real Gmail.** Start the API, worker or `worker:once` with `BIB_MAIL_TRANSPORT=log BIB_ESIGN_PROVIDER=attested`. Fin needs `BIB_FIN_ENABLED=true`.
- **One database per branch while branches are apart.** Migrations 0386–0390 are on different branches, so applying them to one shared database out of order breaks it. Each worktree had its own: `createdb bib_fin_x`, point the two `BIB_*DATABASE_URL`s in that worktree's `.env` at it, `npm run migrate` (about 2 seconds from empty).
- **`99_Ground_Truth` in the training pack is the answer key.** It is never an input to a reader or a check. Tests and backtests may read it as the expected answer, and skip when the pack is absent.
- **Migrations:** fin uses 0381 upward. Range (B) ends at 0400, so agree the block above it before going past.
- **The AI reader needs an Anthropic API key** and 10x's OK before real client documents go to a provider. To turn it on: `BIB_FIN_AI_PROVIDER=anthropic` and `BIB_FIN_ANTHROPIC_API_KEY=…` in `.env` (never committed). The training pack is synthetic, so it may be used for the first runs.
- **Pinned dependencies** added for wave 3: `pdfjs-dist@6.3.289`, `sharp@0.35.4` (native: check it loads in the Docker image before deploying), `@anthropic-ai/sdk@0.128.0`.

## Open decisions (from the tracker; they block the tasks named there)

- 10x: is BiB the books, or does it post journals to Xero/QuickBooks? (F3 scope)
- 10x: who confirms rules; the materiality amount; who sees flagged items. (F4.6, F5.2, F7.4)
- 10x: Form C date; the monthly list for "Monthly close". (F6.3, F1.7 seed)
- Team: per-step desks (F1.8); a "you have new requests" email; the `/internal/v1/tenants/{id}/status` 500 (system actor with a name).
