# Security and operations

Scope: CORS, rate limiting, server-side DB limits, upload and xlsx bounds, release-hardening facts (S7, 2026-10-05), `/health` and which build is live. Sign-in, sessions and passwords are `auth-and-sessions.md`.

## CORS: the frontend is a separate origin

- Every frontend call is cross-origin. `BIB_CORS_ORIGINS` is an **exact allowlist**, never a reflection of `Origin`: with `credentials: true`, reflecting lets any site make authenticated requests with the user's cookie and read the replies. Boot refuses a wildcard, an empty list, and any `http://` or localhost origin in a production-like environment.
- CORS is mounted **ahead of the rate limiter**, so a preflight is answered and stopped before it spends the budget (a browser preflights every credentialed POST; otherwise each login costs two of ten attempts a minute). `/internal` gets no CORS at all (service-to-service; its preflight 404ing is correct).
- **curl does not preflight.** CORS gaps only show in a browser; `tests/api/cors-methods.test.ts` checks every registered verb is allowed.

## Rate limiting

- Two limiters defend different things; neither substitutes. The edge (`api/ratelimit.ts`) keys on **client address**; the identity use case keys on the **account** (a botnet spreads guesses over a thousand addresses; it cannot spread whose password it attacks). Both mounted by prefix, like the auth guards.
- `ScryptPasswordHasher` caps concurrent hashes (memory-hard, ~32 MB each, and login is unauthenticated by definition).
- The store is a port with an in-process implementation: **per-process, so behind N pods every limit is N times looser.** Fine at one pod; the interface is async so Redis drops in.
- **The signed-in surface is counted per SESSION (audit 2026-10-03, B28 / F15 / CA#14).** Keying on the address put a whole office behind one NAT in one 300/min bucket, and the frontend read the resulting 429 on `/auth/me` as "signed out".

| Request | Bucket | Key |
|---|---|---|
| a sign-in route (`PUBLIC_PATHS`) | `auth` (10/min) | the address |
| `/api/v1/*` whose credential resolves | `general` (300/min) | `session:` + SHA-256 of the session id (`sessionRateLimit`, mounted straight after `sessionGuard`) |
| `/api/v1/*` with no/unresolved credential | `general` | the address, charged AFTER the lookup failed; an address that has spent it is refused BEFORE the next lookup (`RateLimiter.peek`) |
| `/internal`, `/health`, docs | `general` | the address |

  The third row stops the session key being a way out (a fresh cookie per request would buy a fresh bucket and a free lookup). Cost: an address that spent its budget on bad credentials holds back everyone at it until the window clears. Numbers (`BIB_RATELIMIT_*`) did not move. Tests: `tests/api/auth-coverage.test.ts` "the rate limit keys a signed-in caller on the SESSION", `tests/platform/ratelimit.test.ts` "peeks without counting". Not bounded: someone who signs in N times holds N buckets (sign-in stays on address and account budgets; a per-USER key is the next step if it matters).
- Sign-in is rate limited, so two `npm run smoke` runs inside a minute throttle; browser walks must pace too (a 429 bounces to /login).

## Release hardening (S7, 2026-10-05)

`release/2026-10-final` = `release/2026-10-05` + S1-S5, then hardening only (feature freeze until 10x finishes UAT).

- **Smoke paces itself.** `scripts/smoke.sh` sends every request through a `curl()` wrapper with a sliding window in a temp file, waiting once `SMOKE_BUDGET` (250) fall inside a minute. The product's limit is not raised. Smoke **refuses a remote API** unless `SMOKE_WRITES_TO_A_DEPLOYED_API=yes`; after a deploy run `scripts/postdeploy-check.sh`, which only reads (F-18-6).
- **Slow tests get room per file**, never globally: PDF render files, `auth-coverage` and the architecture test set `vi.setConfig({ testTimeout: 30_000 })` with the reason beside it.
- **Every app connection carries server-side limits** (F-06-2): `statement_timeout` (`BIB_DB_STATEMENT_TIMEOUT_MS`, 30 s), `idle_in_transaction_session_timeout` (60 s), connect 10 s. A legitimately long statement must be made shorter, not the limit longer.
- **An upload's bytes must be its type** (F-14-1): `contentMatchesType` in the filestore domain; `CONTENT_NOT_OF_TYPE`. A test fixture that uploads must carry the type's signature (`%PDF-`, the PNG header…).
- **The xlsx reader is bounded** (F-9-2): 50 MB a part, 100 MB a workbook, 1,000 columns, 20,000 rows of content.
- **`uuid` is overridden for gaxios** (`package.json` `overrides`); keep until `@google-cloud/storage` stops pinning gaxios 6.
- **`GET/PUT /tenancy/firm-signatory` are deprecated** (spec flag + `Deprecation` header); the demo seed uses the list. Remove once tools outside the repo have moved.
- **A GST tax invoice prints "Original for recipient"** (`RenderableDocument.copyMark`); other documents' bytes do not move.
- Merge follow-ups a textual merge missed, now fixed: the ad-hoc advance's invoice gets `refreshTax` like the desk's; Setup counts sixteen lines; the revenue report reads `invoice_manager_share` and follows an advance's allocations to their letters.
- Companion S7 rules in other files: a period job's task waits for its period (`delivery-engine-and-workflow.md`), a quarterly service on the client's own tax quarter (`billing-and-advances.md`).

## Which build is live (V0.2)

`GET /health` answers `{ status, commit, builtAt }`. The Dockerfile turns its `COMMIT_SHA` / `BUILD_TIME` build args into `BIB_BUILD_COMMIT` / `BIB_BUILD_TIME`; `config.ts` validates both (7-40 hex SHA, ISO instant; an EMPTY value, which Docker makes of an arg nobody passed, reads as not stamped); `cloudbuild.yaml` passes both. `gcloud builds submit --tag` passes no build args, so that image answers `commit: null`: say "not stamped", never guess. `/health` is in the OpenAPI spec (unlike `/ready`) and has its own CORS, because the account page's Technical details reads it through the generated client.
