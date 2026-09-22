# Deploy runbook — production

The only environment. There is no qa, no uat and no staging, by decision, so
everything below is about the one place customers are.

Companion files: `cloudbuild.yaml` (what a deploy actually does, in order, with
the argument for that order) and `.github/workflows/deploy.yml` (what runs it).
If this document and those files disagree, they are right and this is a bug —
`CLAUDE.md`'s rule about the event contract, applied to the thing that ships it.

---

## 1 · What is deployed

Four processes out of two repositories, and **one backend image carrying three
of them**. `tsup` compiles `src/cmd/{server,worker,migrate}.ts` from one
source tree, so they ship together and are selected by the container's command.
A separately built migrate image can be built from a different commit than the
code it is migrating for, and the schema that results matches neither revision.

| Cloud Run resource | Command | What it is |
|---|---|---|
| `bib-api` — service | `node dist/cmd/server.js` | The Hono API. `/health` is a static handler with no database round-trip, which is what makes it a correct startup probe: the database check is already the process refusing to boot. |
| `bib-worker` — **worker pool** | `node dist/cmd/worker.js` | pg-boss plus five internal cron schedules. Not a webhook, and `src/cmd/worker.ts` says so in its own header. A worker pool has no URL and does not scale on requests, which is the shape this is. |
| `bib-migrate` — **job** | `node dist/cmd/migrate.js` | One-shot, pre-deploy, `--max-retries 0`. |
| `bib-frontend` — service | `node server.js` | Next.js. Built from the **other repository** — see §8. |

The backend image's port is `BIB_PORT` and **not** Cloud Run's injected `PORT`:
`src/config/config.ts` is the only file in the product that reads the
environment and it never reads `PORT`. Its default is 8080, which is also Cloud
Run's, so the two agree exactly as long as nobody moves either. If you set
`--port` on the service, set `BIB_PORT` to the same number in the same change.

---

## 2 · First-time setup

Everything in this section is Terraform's, and it is written out here because a
runbook that says "apply the Terraform" is useless the morning somebody has to
work out why the apply was wrong.

### 2.1 · The database

**Cloud SQL for PostgreSQL 17**, reached at **private IP over Direct VPC
egress**, port 5432. The two obvious alternatives are both closed, and neither
is a matter of taste:

- **The unix-socket DSN form does not parse.** `config.ts` extracts the app
  role's password with `new URL(BIB_APP_DATABASE_URL)`, and
  `postgres://bib_app:secret@/bib?host=/cloudsql/p:r:i` throws `Invalid URL` in
  Node 22 — so the process dies in config loading with
  "BIB_APP_DATABASE_URL is not a valid postgres URL", before any of the gates.
- **A Cloud SQL Auth Proxy sidecar on 127.0.0.1 is refused by the boot gate.**
  `validate.ts`'s `looksLocal()` matches `localhost`, `127.0.0.1` and `::1`, and
  a production-like environment throws on all three. That check is there to
  stop a public environment pointing at a developer's database and it cannot
  tell the two cases apart, which is the correct trade.

So the DSN is `postgres://bib_app:<password>@<private-ip>:5432/bib`, and the
api, the worker and the job all need VPC egress to reach it.

The four contrib extensions the migrations create — `pgcrypto` and `citext`
(0001), `pg_trgm` (0002), `btree_gist` (0049) — are all available on Cloud SQL
for PostgreSQL 17, so nothing in the migration path needs a custom image.

**Read §7 before the first migrate: `cmd/migrate.ts` as written cannot
succeed against Cloud SQL, and the fix is somebody's decision rather than a
deploy detail.**

### 2.2 · Artifact Registry

One Docker repository in the deploy region:

```
gcloud artifacts repositories create bib \
  --repository-format=docker --location="$REGION"
```

Images are `$REGION-docker.pkg.dev/$PROJECT/bib/bib-backend:<commit sha>`.
**There is no `:latest`.** A moving tag in a deployment record turns "what was
running on the 14th" into a guess, and Cloud Run pins the digest when the
revision is created anyway, so a mutable tag buys nothing and costs the one
question a rollback has to answer.

### 2.3 · Secrets

Secret Manager, mounted as environment variables by Terraform. The pipeline
never passes `--set-env-vars` or `--set-secrets`, so configuration changes are
a Terraform apply and a deploy is only ever an image.

| Secret | Variable | Notes |
|---|---|---|
| `bib-app-database-url` | `BIB_APP_DATABASE_URL` | **With the password in it.** The gate refuses an empty one, and `cmd/migrate.ts` sets the role's password FROM this URL — so this secret is the source of truth for `bib_app`'s password, not a copy of it. |
| `bib-owner-database-url` | `BIB_DATABASE_URL` | The migrate job's. See below for what the api and the worker get. |
| `bib-internal-keys` | `BIB_INTERNAL_KEYS` | JSON. Regenerate every key: `openssl rand -hex 32`. |
| `bib-smtp-password` | `BIB_SMTP_PASSWORD` | An app password, never the mailbox's own. |
| the e-sign adapter's credentials | the e-sign adapter's variables | DocuSign. Named by that workstream — this pipeline does not invent them. |
| the object store's configuration | the object store's variables | GCS. Same. |

**`BIB_DATABASE_URL` is required by every process and dialled by one.**
`config.ts` declares it `z.string().min(1)` with no default, so the api and the
worker refuse to load config without it; `src/db/pool.ts` builds an owner pool
from it and nothing in `setup/server.ts` or `setup/worker.ts` ever uses that
pool, and postgres.js connects lazily, so no connection is made. Giving those
two the real owner DSN would put migration-capable credentials on every api pod
for a pool that is never opened. Give them
`postgres://bib_owner@<private-ip>:5432/bib` instead — a syntactically real DSN
naming a role that `cmd/migrate.ts` deliberately creates **NOLOGIN**, so if
something ever does dial it, it fails closed and says why.

**`credential.set` sits on a key of its own.** `validateServer` refuses a boot
where any internal client holds it alongside another capability, and the reason
is in the refusal: create a user, grant them partner, set their password, sign
in as them — three calls with one key.

### 2.4 · Configuration that the gate will check

Set by Terraform, and every one of these has a refusal behind it (§6):

```
BIB_ENVIRONMENT=production
BIB_DEV_AUTH_ENABLED        unset (or false)
BIB_SESSION_COOKIE_SECURE   unset — it defaults to true here
BIB_CORS_ORIGINS            the frontend's exact https origin
BIB_APP_BASE_URL            the frontend's origin
BIB_TRUST_PROXY=true
BIB_TRUSTED_PROXY_HOPS=1    Cloud Run's front end is one hop; a CDN in front is 2
BIB_MAIL_TRANSPORT=smtp     plus BIB_SMTP_HOST and BIB_MAIL_FROM
BIB_ESIGN_PROVIDER          the DocuSign value, once that adapter exists
BIB_STORAGE_BACKEND         the GCS value, once that adapter exists
```

And one that is this deployment's own, on the worker pool only:

```
BIB_WORKER_SHUTDOWN_GRACE_MS=8000
```

**Not 45000, and that is a platform limit rather than a preference.** Cloud Run
gives a container exactly **10 seconds** between SIGTERM and SIGKILL — for
services, jobs and worker pools alike — and it is not configurable. The
default asks for 45 seconds of drain plus a hard stop 15 seconds above that, so
on this platform neither timer ever fires: SIGKILL arrives first, every time.
Eight seconds is a drain that can actually complete inside the window.

**The correctness cost is nothing, and that is a property of the engine rather
than luck.** Every sweep in this product is at-least-once by design: the job id
is derived from its cause, `UNIQUE (tenant_id, source_kind, source_ref)` makes
the second insert conflict, and the event is recorded only when a row was
actually created. A sweep killed halfway is re-run and lands on the same rows.
What the shortened drain costs is tidiness — a sweep three firms into a pass
gets killed rather than finishing — and the next tick picks it up.

**Do not read the worker's own header as a promise that 45 seconds happens
here.** It is a correct description of the process's intent and an incorrect
description of this platform.

### 2.5 · Workload Identity Federation and the deploy identity

No service-account keys. `google-github-actions/auth` recommends federation,
and new organizations have `iam.disableServiceAccountKeyCreation` set by
default — but the operative reason is simpler: a JSON key in a repository
secret is a password that works from anywhere, forever, and the token this
workflow mints lasts an hour and is bound to this repository.

- a workload identity pool and an OIDC provider for `token.actions.githubusercontent.com`,
  **with an attribute condition pinning `assertion.repository` to
  `anishumar/bib-backend`**. Without that condition the provider trusts every
  repository on GitHub.
- a deploy service account the provider may impersonate
  (`roles/iam.workloadIdentityUser`), holding: `roles/cloudbuild.builds.editor`,
  `roles/artifactregistry.writer`, `roles/run.developer`, and
  `roles/iam.serviceAccountUser` on the runtime service accounts it deploys as.
- a Cloud Build service account with `roles/artifactregistry.writer`,
  `roles/run.developer`, `roles/logging.logWriter` and
  `roles/iam.serviceAccountUser`.

Then, in the repository's `production` environment, four variables (none of
them secret — they are identifiers, and the trust policy is what makes them
usable):

```
GCP_PROJECT_ID
GCP_REGION                    where Cloud Run and Artifact Registry live
GCP_ARTIFACT_REPOSITORY       "bib"
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_DEPLOY_SERVICE_ACCOUNT
GCP_BUILD_REGION              optional; unset means Cloud Build's "global" pool
```

### 2.6 · One Terraform detail that will bite

**The image field must be exempt from drift detection.** Every deploy changes
`bib-api`, `bib-worker` and `bib-migrate`'s image to the commit that was just
built; the next `terraform apply` will otherwise roll production back to
whatever tag is written in the `.tf` file, silently and with a green plan.
`lifecycle { ignore_changes = [ … containers[0].image ] }` on all three.

---

## 3 · A routine deploy

Merge to `main`. That is the whole procedure.

`deploy.yml` then runs, in this order, and stops at the first thing that fails:

1. **the gate** — `npm ci && npm run check`. `ci.yml` runs the same command on
   the same push; GitHub orders the two workflows not at all, so this is run
   again here rather than assumed.
2. **`gcloud builds submit --config cloudbuild.yaml`**, with `_COMMIT_SHA` set
   to `github.sha`. Everything below happens inside Cloud Build.
3. **build and push** `bib-backend:<sha>`.
4. **migrate** — `gcloud run jobs update` sets the image and `--max-retries 0`,
   `gcloud run jobs execute --wait` blocks, and then **the execution is read
   back**. `--wait`'s documentation says only that it waits; it promises
   nothing about its exit code, so a pipeline that trusts it goes green over a
   failed migration and rolls out the code that needed it. The step demands
   `succeededCount=1` and `failedCount=0`.
5. **`bib-api`**, then **`bib-worker`**. The api first because both processes
   fail the same way on a bad configuration and the api fails it where somebody
   is watching; a worker pool that crash-loops is silent until a sweep does not
   run.

**A green deploy is not a serving revision.** `gcloud run deploy` returns
successfully when Cloud Run accepts the revision, and both processes can still
exit(1) in `validateServer` or in the boot checks a second later — in which
case traffic stays on the previous revision and the product carries on
unchanged. That is why the last step prints what is actually serving, and why
§6 exists.

### Watching the migrate step

```
gcloud run jobs executions list --job=bib-migrate --region="$REGION" --limit=5
```

Its log is the job's own output: `roles ✓`, then one `applied ✓ NNNN_name` per
file, or `nothing pending`.

---

## 4 · Rollback

**A rollback moves traffic to a revision that already exists.** No build, no CI
run, no image. Cloud Run keeps every revision it has ever created, and each one
is pinned to a digest.

```
gcloud run revisions list --service=bib-api --region="$REGION"
gcloud run services update-traffic bib-api --region="$REGION" \
  --to-revisions=bib-api-00042-abc=100
```

Same for `bib-frontend`. **The worker pool is different**: it has no traffic
split, because it has no traffic. Roll it back by deploying the previous image
explicitly:

```
gcloud run worker-pools deploy bib-worker --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT/bib/bib-backend:<the previous sha>"
```

which is where the SHA tag earns its keep — the previous image is a value you
can read off the previous revision, not a guess.

### What a rollback does NOT do

**It does not roll back the database.** Migrations in this product are
immutable once applied and fixed forward with a new number (`CLAUDE.md`,
`migrations/README.md`); the `.down.sql` files exist to be run by hand against
a database somebody is rescuing, and 0067's own history records a down
migration that failed halfway and left a constraint gone entirely.

So a rollback recovers **code**, against a schema that is still the new one.
That is survivable in the direction this pipeline runs — a migration lands
before the code that uses it, so the old code meets a schema with extra things
in it — and it is exactly why the order in §3 is not negotiable. If a
migration itself is the fault, the fix is a new migration with a new number,
deployed forward.

---

## 5 · Running the migrate job by hand

For a schema change you want to apply without shipping code, or to re-run one
that failed:

```
gcloud run jobs execute bib-migrate --region="$REGION" --wait
gcloud run jobs executions describe <execution> --region="$REGION" \
  --format='value(status.succeededCount, status.failedCount)'
```

Read the second line, for the pipeline's reason: `--wait` blocking is not
`--wait` reporting.

**It is safe to re-run, always.** Each file is applied inside its own
transaction and recorded in `tenancy.schema_migrations` in the same
transaction, so a file that threw is rolled back whole and the files before it
stay applied. "Half a migration" is not a state this can be in. An already
applied file is skipped, and a run with nothing to do prints
`applied · nothing pending`.

The job runs with the **owner** URL and does two things the SQL files cannot:
ensures the cluster roles exist with the right attributes, and sets `bib_app`'s
password from `BIB_APP_DATABASE_URL`. Which means **rotating that secret and
re-running this job is how the app role's password is rotated** — change the
secret, run the job, roll the api and the worker. In that order: the role's
password changes when the job runs, so a pod holding the old one keeps its open
connections and fails on the next new one.

---

## 6 · The boot gate refused to start a process

Both processes run `validateServer(cfg)` and then `assertTenantWall` +
`assertLedgerAppendOnly`, and `process.exit(1)` on any failure. **The message
in the log names the variable, the bad value and what was expected** — that is
the house rule for errors, and it holds here, so read it before this table.
Cloud Run will show it on the failed revision; the crash loop itself tells you
nothing.

### Configuration — refused only when `BIB_ENVIRONMENT` is production-like

| The refusal says | Set |
|---|---|
| `BIB_APP_DATABASE_URL points at localhost` | The Cloud SQL **private IP**. A proxy sidecar on 127.0.0.1 hits this too — §2.1. |
| `BIB_APP_DATABASE_URL has no password` | The secret is missing the password, or the URL was edited to drop it. `cmd/migrate.ts` reads the password from this same URL. |
| `BIB_DEV_AUTH_ENABLED is true` | Remove it. It accepts an `x-user-id` header as proof of identity. |
| `BIB_INTERNAL_KEYS still uses the key from .env.example` | Regenerate every key: `openssl rand -hex 32`. The committed value is public. |
| `client … holds credential.set alongside other capabilities` | Split the JSON: `credential.set` gets a client and a key of its own. |
| `BIB_CORS_ORIGINS contains "*"` / `is empty` / `contains http://…` | The frontend's exact `https://` origin, comma-separated. Not a wildcard — it cannot be combined with credentialed requests. |
| `BIB_SESSION_COOKIE_SECURE=false` | Remove the variable. It defaults to true here. |
| `BIB_TRUSTED_PROXY_HOPS must be at least 1` | 1 behind Cloud Run's front end; 2 if a CDN is in front of it. |
| `BIB_MAIL_TRANSPORT=log` | `smtp`, with `BIB_SMTP_HOST` and `BIB_MAIL_FROM`. |
| `BIB_ESIGN_PROVIDER=attested` | The DocuSign provider value. **See §7** — this one is not just a setting today. |
| `BIB_STORAGE_BACKEND=filesystem` | The GCS backend value. **See §7**, same. |

And two that fire in **every** environment, because they are about whether the
transport somebody chose can work at all: `BIB_MAIL_TRANSPORT=smtp` with no
`BIB_SMTP_HOST`, and the same with no `BIB_MAIL_FROM`.

### The two that are not configuration

These read the database, and no environment variable will fix either.

**`tenant wall check: the app role 'bib_app' has BYPASSRLS`** — the role can see
across every tenant and RLS is decorative. It means somebody, or something,
altered the role after `cmd/migrate.ts` set it: the job asserts
`NOBYPASSRLS` on every run. Check it, and check who can:

```sql
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('bib_app','bib_owner');
```

**`tenant wall check: RLS is not enabled on tenancy.membership`** — or
`tenancy.membership is missing — run migrations first`. The second is the
ordinary one on a fresh database: the migrate job did not run, or ran against a
different database than the one the api is pointed at. Compare the host in
`BIB_APP_DATABASE_URL` with the host in the job's `BIB_DATABASE_URL`.

**`ledger check: …`** — a GRANT on `ledger.event` has been widened. The ledger
is append-only **by grant**, not by trigger, so `bib_app` holding UPDATE or
DELETE there is a role that can rewrite history. Same question as above: what
issued that GRANT, and does it still exist.

---

## 7 · What is not finished, stated rather than discovered

**The api and the worker cannot boot in production until two adapters exist.**
`BIB_ESIGN_PROVIDER` is `z.enum(["attested"])` and `BIB_STORAGE_BACKEND` is
`z.enum(["filesystem"])` in `config.ts` today, so even the correct value fails
zod parsing before `validate.ts` is reached — and both values that DO parse are
refused by the gate. The DocuSign signer and the GCS blob store are other
workstreams'; `config.ts` has to widen both enums in the same change. Until
then this pipeline builds, pushes and migrates correctly, and `bib-api` and
`bib-worker` revisions crash-loop on `validateServer`. That is sequencing, not
a defect, but it means the deploy cannot be proven end to end on its own.

**The migrate job will fail against Cloud SQL as `cmd/migrate.ts` is written
today.** `ensureRoles()` issues:

```sql
ALTER ROLE bib_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '…'
```

PostgreSQL 17 lets a non-superuser change `BYPASSRLS` only if it holds that
property itself, and lets a `CREATEROLE` non-superuser change `SUPERUSER` not
at all. Cloud SQL's `postgres` user has `CREATEROLE`, `CREATEDB` and `LOGIN`,
and is not a superuser — by design, and not something a flag turns on. This is
the **first** statement the job runs, before a single migration file is read.

The fix is a decision about the tenant wall rather than a deploy detail, so it
is not made here. The recommendation, for whoever owns it: **keep the assertion
and split it** — `CREATE ROLE bib_app` with no attribute clause (NOBYPASSRLS is
the default), `ALTER ROLE` only `LOGIN NOCREATEDB NOCREATEROLE PASSWORD`, and
then a `SELECT rolbypassrls FROM pg_roles WHERE rolname='bib_app'` that throws
a named error if it is true. That is strictly stronger than the line it
replaces, because it also catches a role somebody else altered — which is
exactly the failure §6's first boot check exists to report.

---

## 8 · The frontend

`bib-frontend` is a **separate git repository**, so its source is not in the
tarball `gcloud builds submit` uploads from this one, and neither
`cloudbuild.yaml` nor `deploy.yml` can build it. It needs its own workflow in
its own repository. What that workflow has to get right is short and easily got
wrong:

```
docker build \
  --build-arg NEXT_PUBLIC_API_BASE_URL="https://api.example.com" \
  -t "$REGION-docker.pkg.dev/$PROJECT/bib/bib-frontend:$SHA" .
docker push "$REGION-docker.pkg.dev/$PROJECT/bib/bib-frontend:$SHA"
gcloud run deploy bib-frontend --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT/bib/bib-frontend:$SHA"
```

**`NEXT_PUBLIC_API_BASE_URL` is a BUILD-time value with two consumers, and the
second is the one that will waste an afternoon.** `src/lib/api/client.ts` reads
it, which is obvious; `next.config.ts` also bakes it into the
Content-Security-Policy's `connect-src`. Build with the wrong value and the
browser blocks every API call with nothing in any server log — no request ever
leaves the page, so the API's access log is empty and the failure looks like a
dead backend. Changing the API's origin means **rebuilding** the frontend
image, not redeploying it.

The frontend does not depend on the migrate job and must not be ordered behind
it: it is static JavaScript talking to the API over HTTP, and the schema is the
API's problem.

---

## 9 · Local development, for completeness

The database lives in `docker-compose.yml` **in the workspace root**, one level
above this repository — which is also a directory that is not a git repository,
so that file cannot be tracked from where `scripts/demo-fresh.sh` looks for it.
It is reconstructed and works; the durable fix is one line in that script
(`ROOT=$BACKEND`) and the compose file moving to `bib-backend/`, where it would
be reviewed like everything else.

```
docker compose up -d --wait      # from the workspace root
npm run migrate                  # with BIB_DATABASE_URL naming the superuser
npm run demo:fresh               # destroys the volume and rebuilds the demo firm
```

`BIB_DATABASE_URL` must name `postgres` against that container, not `bib_owner`:
`cmd/migrate.ts` creates `bib_owner` **NOLOGIN** and then grants it to the
connected role, which a role cannot do to itself. `README.md` says the same
thing as "adjust `BIB_DATABASE_URL` to a superuser locally".
