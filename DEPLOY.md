# Deploying bib — start here

This is the short path from nothing to a running environment, in the order that
works. `docs/deploy/runbook.md` is the long reference; read this first, because
**the order is not obvious and three of the steps cannot be swapped.**

Everything below was done once, against `bib-qa`, on 2026-09-22. Every failure
described is one that actually happened, not one that might.

---

## 0 · Tools

| Tool | Version | Why it matters |
|---|---|---|
| Node | **22.22.1** (`.nvmrc`) | pg-boss needs `>=22.12`. `npm` does not enforce `engines`, so the wrong version runs the tests fine and the worker not at all. `nvm use`. |
| Terraform | **>= 1.9** | `versions.tf` requires it. 1.5.7 refuses the config outright. |
| gcloud | any current | Worker pools need `gcloud beta` **and** `export CLOUDSDK_PYTHON_SITEPACKAGES=1`, or the command dies with an unrelated-looking Python error. |
| Docker | optional | Cloud Build builds the images. You do not need a local engine. |

On Apple Silicon, install gcloud from Google's `darwin-arm` tarball rather than
Homebrew if your Homebrew is the Intel build at `/usr/local` — it cannot compile
dependencies natively and fails in `openssl` with `-march=westmere`.

---

## 1 · The project

```bash
gcloud projects create <id> --name="bib <env>"
gcloud config set project <id>
gcloud billing projects link <id> --billing-account=<ACCOUNT_ID>
```

**Check `billingEnabled: true` in the output.** A billing account that is
`open: false` links successfully and funds nothing; APIs then refuse with
`UREQ_PROJECT_BILLING_NOT_OPEN`. Creating a second billing account does not help
— an unactivated account is unactivated whichever one it is.

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com compute.googleapis.com \
  servicenetworking.googleapis.com vpcaccess.googleapis.com \
  iam.googleapis.com storage.googleapis.com cloudresourcemanager.googleapis.com
```

---

## 2 · Terraform state bucket

```bash
gcloud storage buckets create gs://<id>-tfstate --location=<region> --uniform-bucket-level-access
gcloud storage buckets update gs://<id>-tfstate --versioning --public-access-prevention
```

Verify with `gcloud storage buckets describe` and look for
**`versioning_enabled: true`** — the field is `versioning_enabled`, not
`versioning.enabled`, and querying the wrong path returns `null` and looks like
failure.

---

## 3 · The variables file

Copy `infra/terraform/qa.tfvars` and change what differs. Three variables all
default to the **production-safe** value and must be overridden for a throwaway
environment:

| Variable | Prod default | Non-prod | Consequence of the default |
|---|---|---|---|
| `run_ingress` | `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` | `INGRESS_TRAFFIC_ALL` | With `lb.tf` disabled there are **zero** entry points. Service is Ready, `allUsers` is granted, and every request gets Google's 404 before reaching the container. |
| `session_cookie_samesite` | `Lax` | `None` | Two `*.run.app` services are different **sites** (public suffix). The browser accepts the cookie and never sends it: login returns 200 and the next request is `UNAUTHORIZED`. |
| `db_availability_type` | `REGIONAL` | `ZONAL` | Cost. `REGIONAL` is roughly double and is the right default — read the argument in `sql.tf` before changing it for anything real. |

`run_deletion_protection = false` is also worth setting outside production: a
Cloud Run resource that failed to create is *tainted* and cannot be replaced
while protection is on.

---

## 4 · THE ORDER THAT MATTERS

> **Secret *versions* must exist before Cloud Run resources are created.**

Terraform creates the secret **containers** and deliberately creates **no
versions** — that is what keeps passwords out of the state file, and it is the
right decision. But Cloud Run resolves `versions/latest` at create time, and a
revision that fails to find one is permanently unready. Cloud Run then refuses
to *update* a service whose current revision never became ready, and reports the
**original** failure on every subsequent attempt — so you will see
`Secret ... versions/latest was not found` long after the version exists.

If you hit that state: delete the service and the worker pool, then re-apply.

### 4a · First apply — infrastructure only

```bash
cd infra/terraform
terraform init -backend-config="bucket=<id>-tfstate"
terraform apply -var-file=<env>.tfvars
```

Cloud SQL, VPC, secrets, service accounts, buckets and Artifact Registry
succeed. The four Cloud Run resources fail. **That is expected.**

### 4b · Database users and secret versions

Terraform intentionally creates no `google_sql_user` — `src/cmd/migrate.ts` owns
`bib_owner` and `bib_app`, and a second writer of those roles could flip
`NOBYPASSRLS` between runs, which is the entire tenant wall.

```bash
gcloud sql users set-password postgres --instance=<inst> --password=<generated>
gcloud sql users create bib_runtime --instance=<inst> --password=<generated>
```

Then write **nine** secret versions. Three database URLs, and they are three
different logins on purpose:

| Secret | Login | Why |
|---|---|---|
| `bib-owner-database-url` | `postgres` | migrate only — creating extensions needs `cloudsqlsuperuser` |
| `bib-runtime-database-url` | `bib_runtime` | API + worker. Their owner pool is never queried; this exists because the zod schema requires the variable |
| `bib-app-database-url` | `bib_app` | the RLS-constrained role. **migrate sets this password from the secret**, so generate it first |

`bib-internal-keys` must contain **two** clients: `credential.set` alone on its
own key, everything else on another. The boot gate refuses them combined —
create-user, grant-partner, set-password is a complete escalation path.

`bib-internal-keys-offline` needs at least one capability (`.min(1)`); it is held
by processes that serve no HTTP, so nothing can use it.

`bib-docusign-private-key` **must be a valid RSA PEM even if DocuSign is not in
use** — it is parsed in `JwtGrantDocusign`'s constructor, so a placeholder string
crash-loops the API. `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.

### 4c · Second apply

```bash
terraform apply -var-file=<env>.tfvars
```

---

## 5 · Images, then migrate, then everything else

```bash
# backend — one image, three entrypoints
gcloud builds submit --tag <region>-docker.pkg.dev/<id>/bib/bib-backend:<sha> --region=<region>

gcloud run jobs update bib-migrate --image=...:<sha> --region=<region>
gcloud run services update bib-api --image=...:<sha> --region=<region>
CLOUDSDK_PYTHON_SITEPACKAGES=1 gcloud beta run worker-pools update bib-worker --image=...:<sha> --region=<region>
```

**Run migrate before the API can start.** The API's boot check refuses to serve
until `bib_app` exists with the right attributes:

```
boot check failed — refusing to serve
password authentication failed for user "bib_app"
```

That is the check working, not a bug.

```bash
gcloud run jobs execute bib-migrate --region=<region> --wait
```

### The frontend is last, and needs the API's URL

`NEXT_PUBLIC_API_BASE_URL` is inlined at **build** time. Setting it on the Cloud
Run service does nothing.

```bash
API_URL=$(cd infra/terraform && terraform output -raw frontend_build_arg)
cd ../bib-frontend
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_API_BASE_URL=$API_URL,_COMMIT_SHA=<sha> --region=<region>
```

It must **exactly** equal an origin in the API's `BIB_CORS_ORIGINS`. Cloud Run
gives each service two URLs and both serve; use the one Terraform outputs. The
wrong one loads the page fine and then every API call is discarded by the
browser with no server log.

---

## 6 · Verify

```bash
curl -s <api>/health                      # {"status":"ok"}
curl -so /dev/null -w '%{http_code}' <api>/api/v1/parties    # 401
```

Then the real check — it provisions its own firm and walks every gate:

```bash
KEY=$(gcloud secrets versions access latest --secret=bib-internal-keys \
  | python3 -c 'import json,sys;print([c["key"] for c in json.load(sys.stdin) if "tenant.provision" in c["capabilities"]][0])') \
CRED_KEY=$(gcloud secrets versions access latest --secret=bib-internal-keys \
  | python3 -c 'import json,sys;print([c["key"] for c in json.load(sys.stdin) if "credential.set" in c["capabilities"]][0])') \
API=<api> npm run smoke
```

Expect **242 passed, 19 failed** (measured 2026-09-23). All 19 are documented in §7.

---

## 7 · Known failures, so you do not chase them

**Engagement letters cannot be signed.** `attested` is refused in production;
`docusign` only *verifies* an envelope carrying `bib_content_hash`, and nothing
in this codebase creates envelopes. In smoke this shows as 17 failures, all
cascading from one line: `the client signs`. Shipping real signing needs a send
path, a fifth letter state (migration + domain change) and a Connect webhook.

**`expected 57/10` India rules generating** — stale assertion. Pack-seeded rules
are `unconfirmed` and do not generate until a firm confirms them, by design.

**`expected http://localhost:3000`** — smoke's hardcoded dev origin.

---

## 8 · Two traps after you are live

**`terraform apply` can roll back your images.** Every Cloud Run resource has
`lifecycle { ignore_changes = [image] }` because the pipeline moves images by
SHA. Add a new workload without it and an unrelated apply — a firewall rule, an
alert threshold — will reset it to `cloudrun/container/hello`. Nothing reports
this as an error. It happened here, to the frontend.

**Logs need `--freshness`.** Without it you read ancient entries and diagnose a
fix as broken. The worker uses `resource.labels.worker_pool_name`, *not*
`service_name` — the obvious query silently returns nothing.

---

## 9 · Further reading

| | |
|---|---|
| `docs/deploy/runbook.md` | routine deploys, rollback, boot-gate reference |
| `docs/deploy/database.md` | Cloud SQL roles and the migration contract |
| `infra/terraform/README.md` | every resource and why it is shaped that way |
| `CLAUDE.md` | the architecture the above assumes |
