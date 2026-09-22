# bib — GCP infrastructure

Terraform for the whole product: the API, the worker, the migrate job and the
frontend, on Cloud Run, with Cloud SQL for PostgreSQL behind a private IP.

**One environment.** `production`, and only production. There is no workspace,
no per-environment module and no `environment` variable — the boot gate in
`src/config/validate.ts` treats `production`, `uat` and `qa` identically, and
the decision on this deployment is that only the first will exist. A second
environment would be a second state file and a second tfvars, not a `count`.

## Where this lives, and the one open question about that

It is in `bib-backend/`, and it describes four workloads across **two
independent git repositories** — `bib-backend` and `bib-frontend` — with no
shared parent repo. The backend repo was chosen because it already carries CI
and the production boot gate, which is where the constraints on this
configuration come from.

The consequence, stated rather than discovered: **the frontend service is
deployed from configuration that lives in the backend repo.** If the right
answer is a third repository for infrastructure, that decision is cheap now and
expensive later — moving it after the first apply means moving state.

## Layout

| File | What it holds |
|---|---|
| `versions.tf` | Terraform + provider versions, the GCS state backend, shared locals |
| `variables.tf` | Every input, with production defaults where a default can be honest |
| `services.tf` | The project APIs everything else depends on |
| `network.tf` | VPC, the Direct VPC egress subnet, private services access for Cloud SQL |
| `sql.tf` | The Postgres 17 instance, backups, PITR, both deletion locks |
| `storage.tf` | The blob bucket |
| `registry.tf` | Artifact Registry |
| `secrets.tf` | Secret **containers** — never a value |
| `iam.tf` | Four service accounts, and every grant argued one at a time |
| `run_api.tf` | The API service |
| `run_worker.tf` | The worker **pool** — read its header first |
| `run_frontend.tf` | The frontend service |
| `run_migrate.tf` | The migrate **job** |
| `lb.tf` | Global external ALB, custom domains, managed certificate, http→https |
| `observability.tf` | Log bucket and sink, uptime check, three alerts |
| `outputs.tf` | What an operator needs after an apply |

## Bootstrap, in order

The order matters. Several steps cannot succeed before the one above them.

**1. Create the state bucket.** Once, by hand. A bucket that holds the state
cannot be created by the configuration whose state it holds.

```sh
gcloud storage buckets create gs://<PROJECT>-bib-tfstate \
  --project=<PROJECT> --location=asia-south1 --uniform-bucket-level-access
gcloud storage buckets update gs://<PROJECT>-bib-tfstate --versioning
```

**2. Configure and initialise.**

```sh
cp backend.hcl.example backend.hcl                 # fill in the bucket
cp terraform.tfvars.example terraform.tfvars       # fill in project, domains, mail, DocuSign, alerts
terraform init -backend-config=backend.hcl
```

**3. First apply, with placeholder images.** Every image variable defaults to
Google's public hello container, because a Cloud Run service cannot be created
from an image that does not exist and nothing has been pushed to a registry that
did not exist a minute ago.

```sh
terraform apply
```

This produces the registry, the database, the secrets, the bucket, the service
accounts and the load balancer. It does **not** produce a working product: every
secret is empty, so every workload that references one fails to start.

**4. Point DNS at the load balancer.** `terraform output dns_records_required`
prints the two A records. The managed certificate cannot validate until they
resolve, and provisioning then takes up to about an hour.

**5. Set the Cloud SQL `postgres` password.** Not set by Terraform, because
`google_sql_user` would put it in the state file.

```sh
gcloud sql users set-password postgres \
  --instance=bib-production --project=<PROJECT> --prompt-for-password
```

**6. Populate every secret version.** `terraform output secrets_awaiting_a_version`
lists them. The database URLs need the private IP, which
`terraform output sql_private_ip` prints.

```sh
# The app role's URL. The password here is the one cmd/migrate will SET on
# bib_app in step 8 — it is parsed out of this URL by src/config/config.ts, so
# choose it now and use the same value in both places.
printf 'postgres://bib_app:%s@%s:5432/bib?sslmode=require' "$APP_PW" "$SQL_IP" \
  | gcloud secrets versions add bib-app-database-url --data-file=- --project=<PROJECT>

# The migrator's URL — the Cloud SQL `postgres` user from step 5. Only the
# migrate job's service account can read this one.
printf 'postgres://postgres:%s@%s:5432/bib?sslmode=require' "$PG_PW" "$SQL_IP" \
  | gcloud secrets versions add bib-owner-database-url --data-file=- --project=<PROJECT>

# BIB_DATABASE_URL for the API and worker. A least-privileged login, NOT the
# value above — see the long note in secrets.tf.
printf 'postgres://bib_ops:%s@%s:5432/bib?sslmode=require' "$OPS_PW" "$SQL_IP" \
  | gcloud secrets versions add bib-runtime-database-url --data-file=- --project=<PROJECT>

# Provisioning keys. TWO clients, because validateServer refuses credential.set
# alongside anything else: those three calls are a complete escalation path.
printf '[{"name":"provisioning","key":"%s","capabilities":["tenant.provision","user.provision","membership.grant"]},{"name":"credentials","key":"%s","capabilities":["credential.set"]}]' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" \
  | gcloud secrets versions add bib-internal-keys --data-file=- --project=<PROJECT>

# A value that authorises nothing, for the two workloads that serve no HTTP.
printf '[{"name":"offline","key":"%s","capabilities":["tenant.provision"]}]' \
  "$(openssl rand -hex 32)" \
  | gcloud secrets versions add bib-internal-keys-offline --data-file=- --project=<PROJECT>

gcloud secrets versions add bib-smtp-password            --data-file=- --project=<PROJECT>
gcloud secrets versions add bib-docusign-integration-key --data-file=- --project=<PROJECT>
gcloud secrets versions add bib-docusign-user-id         --data-file=- --project=<PROJECT>
gcloud secrets versions add bib-docusign-private-key     --data-file=key.pem --project=<PROJECT>
```

The `?sslmode=require` is not decoration: the instance runs `ENCRYPTED_ONLY`, and
postgres.js maps a `sslmode` query parameter onto its own `ssl` option
(`node_modules/postgres/src/index.js:443`), so this is the whole client-side
story and needs no code change.

**7. Build and push the four images.** `terraform output artifact_registry_repository`
prints the repository. The frontend must be built with
`NEXT_PUBLIC_API_BASE_URL` set to `terraform output frontend_build_arg` — it is
baked into the bundle and compiled into the page's Content-Security-Policy, so
it cannot be supplied at runtime. The migrate image must ship `migrations/`
beside `dist/`.

**8. Run the migrate job, and wait for it.**

```sh
gcloud run jobs execute bib-migrate --region=asia-south1 --project=<PROJECT> --wait
```

This is deliberately not wired into `terraform apply` — see the comment at the
foot of `run_migrate.tf`.

**9. Apply again with real image digests.**

```sh
terraform apply -var api_image=... -var worker_image=... -var migrate_image=... -var frontend_image=...
```

Digests, not tags. A tag is mutable, so `:latest` makes a plan that shows no
change deploy different code, and makes a rollback unexpressible.

## The deploy pipeline, once bootstrapped

Build → push → **execute `bib-migrate` and wait** → update the services. The
order is load-bearing: both process shells run `assertTenantWall` and
`assertLedgerAppendOnly` before they serve, so a service updated ahead of its
migration crash-loops against a schema that does not have what it expects.

## Four things that are true today and will stop a production boot

These are reported here because Terraform cannot fix any of them, and because
the correct response to each is a change in a specific file rather than a
relaxed gate.

**1. `BIB_STORAGE_BACKEND` and `BIB_ESIGN_PROVIDER` are one-value enums.**
`src/config/config.ts` reads `z.enum(["filesystem"])` and `z.enum(["attested"])`,
so setting `gcs` or `docusign` makes zod reject the entire configuration at
`load()` — before `validateServer` is reached. Leaving them at the values the
enums accept makes `validateServer` refuse to boot production, because both are
honest-registry stubs. **Production cannot boot in either direction** until
those enums widen and `src/setup/server.ts` registers the two adapters. The
bucket, its IAM bindings and the DocuSign secret containers are correct and
inert until then.

**2. `cmd/migrate` will fail on Cloud SQL as written.** `src/cmd/migrate.ts`
runs `ALTER ROLE bib_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB
NOCREATEROLE PASSWORD '…'`. The Cloud SQL `postgres` user is not a true
superuser — it holds `CREATEROLE`, `CREATEDB` and `LOGIN` and not `SUPERUSER` —
and PostgreSQL refuses an `ALTER ROLE` that *mentions* `SUPERUSER` or
`BYPASSRLS` from a role lacking that attribute, whether or not the value
changes. The fix is in `src/cmd/migrate.ts`: drop `NOSUPERUSER` and
`NOBYPASSRLS` from that statement and rely on `CREATE ROLE`'s defaults plus the
runtime guarantee that already exists — `src/db/boot-check.ts` refuses to start
either process if `rolbypassrls` is true, so the attribute stays enforced, just
verified rather than asserted.

**3. The worker's drain is shortened from 45s to 7s.** Cloud Run's
SIGTERM-to-SIGKILL window is a fixed ten seconds with no field to change it, on
services, jobs and worker pools alike. The full argument, including why pg-boss's
durability makes it survivable and exactly what is lost, is the header of
`run_worker.tf`. It is a reduction in a value this repo argued for at length and
should be signed off, not inherited.

**4. There are no images.** Neither repo has a Dockerfile yet, so day one runs
on the placeholder image variables and the Cloud Run resources cannot be
validated end to end until the docker workstream lands.

## Things deliberately absent

- **Cloud NAT.** Every workload uses `PRIVATE_RANGES_ONLY` egress, so public
  traffic never enters the VPC and a NAT would have nothing behind it. Switching
  any workload to `ALL_TRAFFIC` without adding one first removes every outbound
  internet connection — see the foot of `network.tf`.
- **DNS.** The zone for a firm's own domain is usually not in this project. Two
  A records, by hand.
- **`google_sql_user` for bib_owner and bib_app.** `cmd/migrate` owns those
  roles and re-asserts `NOBYPASSRLS` on every run. Two writers of the one
  attribute the tenant wall depends on is one too many.
- **A session secret.** There is nothing to put in it: sessions are server-side
  rows, the token is stored as a SHA-256 digest, and no such variable exists.
- **CDN.** It would make `BIB_TRUSTED_PROXY_HOPS = 1` wrong, silently, and the
  rate limiter would start reading the caller-written end of `X-Forwarded-For`.
