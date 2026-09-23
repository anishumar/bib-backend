# Secret Manager — the CONTAINERS, never the payloads.
#
# THE RULE THIS FILE FOLLOWS, STATED ONCE: Terraform creates the secret and the
# IAM that says who may read it, and it never creates a version. Not one
# credential value appears in this directory, in a tfvars file, or in the state
# file. Versions are written out of band, by a person, with the gcloud commands
# in README.md.
#
# The cost is real and is accepted: `terraform apply` produces a set of secrets
# with no versions, and every Cloud Run workload that references one will fail
# to start until somebody adds one. That failure is loud, immediate, and names
# the secret. The alternative — Terraform generating passwords — moves every one
# of these values into a state file in a bucket, which is a different place to
# have to defend and a place where a `terraform show` prints them.

locals {
  # Each entry: the secret's id, and what belongs in it. The description is
  # written for the person populating it at 2am, so it says what the value LOOKS
  # like rather than what it is called.
  secrets = {
    "app-database-url" = {
      id          = "bib-app-database-url"
      description = "BIB_APP_DATABASE_URL. Full URL with the password inline: postgres://bib_app:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require"
    }
    "owner-database-url" = {
      id          = "bib-owner-database-url"
      description = "BIB_DATABASE_URL for the MIGRATE JOB ONLY. The Cloud SQL 'postgres' user: postgres://postgres:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require"
    }
    "runtime-database-url" = {
      id          = "bib-runtime-database-url"
      description = "BIB_DATABASE_URL for the API and worker. A LEAST-PRIVILEGED login — see the long note in this file. Never the migrate job's value."
    }
    "internal-keys" = {
      id          = "bib-internal-keys"
      description = "BIB_INTERNAL_KEYS for the API. A JSON array of provisioning clients, with credential.set alone on its own client and its own key."
    }
    "internal-keys-offline" = {
      id          = "bib-internal-keys-offline"
      description = "BIB_INTERNAL_KEYS for the worker and migrate job. One throwaway client carrying tenant.provision — the schema requires at least one capability — held by a process that serves no HTTP, so no route exists to use it."
    }
    "smtp-password" = {
      id          = "bib-smtp-password"
      description = "BIB_SMTP_PASSWORD. An app password for the relay account, never the account's own password."
    }
    "docusign-integration-key" = {
      id          = "bib-docusign-integration-key"
      description = "The DocuSign integration key (client id) for the JWT grant."
    }
    "docusign-user-id" = {
      id          = "bib-docusign-user-id"
      description = "The DocuSign API user id (a GUID) the JWT grant impersonates."
    }
    "docusign-private-key" = {
      id          = "bib-docusign-private-key"
      description = "The RSA private key for the DocuSign JWT grant, PEM, newlines and all."
    }
  }
}

resource "google_secret_manager_secret" "bib" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.value.id
  labels    = local.labels

  # Automatic replication. The alternative, user-managed replication pinned to
  # the region, would put these values in exactly one place — which reads as the
  # tighter choice and is the wrong one here: a regional Secret Manager outage
  # would then stop every Cloud Run instance from starting, because a secret
  # reference is resolved at instance start. These are credentials for services
  # that are themselves global or regional; the residency argument that governs
  # the DATABASE (sql.tf) does not transfer to a password.
  replication {
    auto {}
  }

  # Versions are populated by hand, so Terraform must not fight whoever does it,
  # and must not report a diff every plan because a version appeared.
  lifecycle {
    ignore_changes = [labels]
  }

  depends_on = [google_project_service.enabled]
}

# ── Why there are THREE database URLs and not two ────────────────────────────
#
# src/config/config.ts requires BOTH BIB_DATABASE_URL and BIB_APP_DATABASE_URL
# on EVERY process — neither is optional in the zod schema — and
# src/db/pool.ts::createPools builds an owner pool from the first on every boot
# of the API and the worker. So the API's environment must contain something in
# BIB_DATABASE_URL whether or not the API has any business holding an owner
# connection.
#
# The migrate job genuinely needs a powerful one. It connects with that URL to
# create the cluster roles, and the migrations create four extensions —
# pgcrypto and citext (0001), pg_trgm (0002), btree_gist (0049) — which on
# Cloud SQL only a member of cloudsqlsuperuser may create. 0049's own comment
# says installing an extension "needs CREATE on the DATABASE, which bib_owner
# deliberately does not hold. The migrator connects as BIB_DATABASE_URL, which
# does". On Cloud SQL the role that does is `postgres`.
#
# Handing that same URL to the API would put a cloudsqlsuperuser credential in
# the environment of the one process the internet can reach — in a product whose
# entire thesis is a tenant wall enforced by a NOBYPASSRLS role. So there is a
# third secret. What goes in it: a login with CONNECT on the database and
# nothing else. Nothing in src/setup/server.ts or src/setup/worker.ts queries
# pools.owner — the boot checks use pools.app — and postgres.js opens no socket
# until a query is issued, so in practice that pool never connects at all. If
# something ever DOES query it, this arrangement fails with a permission error
# naming the role, which is the right way to find out.
#
# THE PROPER FIX IS NOT TERRAFORM'S. It is making BIB_DATABASE_URL optional for
# the server and worker in src/config/config.ts, so that neither process holds
# an owner pool it never uses. That file is owned by the config workstream and
# is reported to it rather than edited here.

# ── Why BIB_INTERNAL_KEYS is ONE secret and not two ──────────────────────────
#
# The boot gate's rule is about CLIENTS inside the value, not about how the
# value is stored. src/config/validate.ts refuses any client holding
# credential.set alongside other capabilities, because those three calls —
# create a user, grant them partner, set their password — are a complete
# escalation path behind one key. BIB_INTERNAL_KEYS is a single JSON string
# parsed into a list, so the compliant value is one secret whose payload has TWO
# objects with TWO different keys:
#
#   [{"name":"provisioning","key":"<64 hex>","capabilities":["tenant.provision","user.provision","membership.grant"]},
#    {"name":"credentials","key":"<64 hex>","capabilities":["credential.set"]}]
#
# Splitting it into two Secret Manager entries would need two environment
# variables, and there is only one. Each key must be at least 32 characters
# (config.ts) and must not be the committed example value, which validate.ts
# rejects by name: generate both with `openssl rand -hex 32`.

# ── What is NOT here: a session secret ───────────────────────────────────────
#
# There is no bib-session-secret, because there is nothing to put in it. This
# product does not sign session tokens: sessions are server-side rows in
# tenancy.session, the token is stored only as a SHA-256 digest, and it is
# re-resolved against the database on every request so that revocation lands
# immediately (src/api/principal.ts, and CLAUDE.md's auth section). There is no
# BIB_SESSION_SECRET in src/config/config.ts to point a secret at. Creating one
# would be an empty container implying a mechanism that does not exist.

# ── What is NOT here: DocuSign's base URIs ───────────────────────────────────
#
# The DocuSign account id, API base URI and OAuth host are plain variables, not
# secrets: they are addresses, they appear in DocuSign's own console and in
# every support ticket, and putting them behind Secret Manager would mean a
# secret version bump to change a hostname. The integration key, the user id and
# the private key ARE secrets, and all three together are the credential: the
# JWT grant needs the full set, so leaking two of them narrows the attack to
# guessing one PEM.
#
# These are read now: config.ts is
# `BIB_ESIGN_PROVIDER: z.enum(["attested", "docusign"])` and setup/server.ts
# builds the signer through `esignFor(cfg, log)`, which names every missing
# credential in one message rather than failing on the first.
#
# Since 0080 a letter CAN be signed in production through DocuSign. Sending a
# letter raises an envelope (API), and the worker's signature sweep learns how
# it ended and signs or withdraws the letter — so BOTH processes hold these
# three secrets. The letter stays `sent` while its envelope is out; there is no
# fifth state. A Connect webhook would make completion immediate instead of
# within five minutes, and is not built.
#
# The values must be REAL for any of it to work: an integration key made in
# DocuSign, the impersonated user's GUID, that key's RSA private key, and a
# one-off consent to `signature impersonation`. A placeholder PEM boots (it
# parses) and every envelope then fails with DocuSign's own refusal, shown on
# the letter page.

# ── Why the worker and the migrate job get a DIFFERENT internal-keys value ───
#
# src/config/config.ts requires BIB_INTERNAL_KEYS on every process — no default
# and no optionality, with the stated reason that "an unset value would mean the
# provisioning API is open, and that is not a state this process may boot in" —
# and the zod schema further requires at least one client holding at least one
# capability, so an empty list will not parse.
#
# But the provisioning API is served by src/api/router.ts, which only the API
# process mounts. The worker pool has no HTTP surface at all (src/cmd/worker.ts
# never calls serve()), and the migrate job exits after applying SQL. A key
# neither of them can ever be presented with is a key neither of them needs to
# hold.
#
# So they get their own secret, containing one client with one capability and a
# freshly generated key that is written nowhere else:
#
#   [{"name":"offline","key":"<64 hex, used by nothing>","capabilities":["tenant.provision"]}]
#
# The value satisfies the schema and authorises nothing, because no route exists
# in either process to present it to. What this buys is concrete: an attacker
# who reads the worker's environment does not thereby hold the platform's
# provisioning credentials.
