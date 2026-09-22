# Four service accounts, one per workload, and nothing shared between them.
#
# THE REASON FOR FOUR RATHER THAN ONE is the same reason src/config/config.ts
# gives for BIB_INTERNAL_KEYS carrying a key per caller: "one key that opens
# every route is an escalation path". A single runtime identity across the API,
# the worker, the migrate job and the frontend would mean the frontend — which
# holds no credential at all and renders public marketing pages as readily as a
# client portal — could read the DocuSign signing key, and the migrate job's
# cloudsqlsuperuser URL would be readable by the process the internet talks to.
#
# Every grant below is either per-secret or per-bucket. There is not one
# project-wide secretmanager.secretAccessor in this file, and adding one would
# quietly undo every distinction it draws.

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "bib-api"
  display_name = "bib API (Cloud Run service)"
  description  = "Runtime identity of dist/cmd/server.js."
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "bib-worker"
  display_name = "bib worker (Cloud Run worker pool)"
  description  = "Runtime identity of dist/cmd/worker.js — the pg-boss queue and the internal cron."
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "migrate" {
  project      = var.project_id
  account_id   = "bib-migrate"
  display_name = "bib migrate (Cloud Run job)"
  description  = "Runtime identity of dist/cmd/migrate.js. Holds the only credential that can create roles and extensions."
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "frontend" {
  project      = var.project_id
  account_id   = "bib-frontend"
  display_name = "bib frontend (Cloud Run service)"
  description  = "Runtime identity of the Next.js server. Deliberately holds nothing."
  depends_on   = [google_project_service.enabled]
}

# ── Cloud SQL ────────────────────────────────────────────────────────────────
#
# roles/cloudsql.client on the three workloads that open a connection. The
# frontend is absent from this list and that is the point of listing them one at
# a time rather than looping over all four: a Next.js server that could reach
# the database is one stray import away from doing it, outside every one of the
# four scoping gates the API enforces.
#
# An honest note about this role: these workloads connect over a PRIVATE IP with
# an ordinary TCP connection and a password, not through the Cloud SQL Auth
# Proxy, and in that arrangement the IAM role is not what authorises the
# connection — the password is. The role is granted anyway because it is
# required the moment anything moves to the connector or to IAM database
# authentication, and because it is the cheap side of the doubt: it grants the
# ability to connect, never the ability to read a row.
resource "google_project_iam_member" "cloudsql_client" {
  for_each = {
    api     = google_service_account.api.email
    worker  = google_service_account.worker.email
    migrate = google_service_account.migrate.email
  }

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${each.value}"
}

# ── Secrets, one binding per (secret, reader) pair ───────────────────────────
#
# Read this map as the answer to "who can read what", because that is exactly
# what it is. Every entry is defended by the comment beside it; an entry added
# without one is a widening nobody argued for.
locals {
  secret_readers = {
    # The API is the only process that composes a mailer, a blob store and an
    # e-sign provider (src/setup/server.ts), so it is the only one that holds
    # their credentials.
    "app-database-url/api"         = { secret = "app-database-url", sa = google_service_account.api.email }
    "runtime-database-url/api"     = { secret = "runtime-database-url", sa = google_service_account.api.email }
    "internal-keys/api"            = { secret = "internal-keys", sa = google_service_account.api.email }
    "smtp-password/api"            = { secret = "smtp-password", sa = google_service_account.api.email }
    "docusign-integration-key/api" = { secret = "docusign-integration-key", sa = google_service_account.api.email }
    "docusign-user-id/api"         = { secret = "docusign-user-id", sa = google_service_account.api.email }
    "docusign-private-key/api"     = { secret = "docusign-private-key", sa = google_service_account.api.email }

    # The worker reads and writes every firm's data in turn, so it needs the app
    # role. It gets NO smtp password and NO DocuSign key, because
    # src/setup/worker.ts composes neither a Mailer nor an ESignProvider —
    # CLAUDE.md states the rule the chaser and the nudge both follow, that they
    # send nothing and no mailer is injected. If a transport is ever wired into
    # the worker, this is the line that has to change with it.
    "app-database-url/worker"      = { secret = "app-database-url", sa = google_service_account.worker.email }
    "runtime-database-url/worker"  = { secret = "runtime-database-url", sa = google_service_account.worker.email }
    "internal-keys-offline/worker" = { secret = "internal-keys-offline", sa = google_service_account.worker.email }

    # The migrate job needs the powerful URL to create roles and extensions, and
    # it ALSO needs the app URL — not to connect with, but because
    # src/cmd/migrate.ts sets bib_app's password from cfg.db.appPassword, which
    # src/config/config.ts parses out of BIB_APP_DATABASE_URL. Without it the
    # role would exist with a password nobody set.
    "owner-database-url/migrate"    = { secret = "owner-database-url", sa = google_service_account.migrate.email }
    "app-database-url/migrate"      = { secret = "app-database-url", sa = google_service_account.migrate.email }
    "internal-keys-offline/migrate" = { secret = "internal-keys-offline", sa = google_service_account.migrate.email }
  }
}

resource "google_secret_manager_secret_iam_member" "readers" {
  for_each = local.secret_readers

  project   = var.project_id
  secret_id = google_secret_manager_secret.bib[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa}"
}

# ── The blob bucket ──────────────────────────────────────────────────────────
#
# objectAdmin on ONE bucket, for ONE identity.
#
# objectAdmin rather than storage.admin because the BlobStore port has exactly
# two methods, put and get, and no method that administers a bucket — CLAUDE.md
# is explicit that it "has no `delete` and must not grow one", since storage is
# content-addressed and two documents can share a blob. storage.admin would add
# the ability to change the bucket's own IAM policy, which is the ability to
# publish a firm's engagement letters.
#
# The API alone, because src/setup/worker.ts constructs no blob store. The
# trigger for adding the worker is precise: the first worker sweep that renders
# or stores a document.
resource "google_storage_bucket_iam_member" "api_objects" {
  bucket = google_storage_bucket.blobs.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# ── What is deliberately NOT granted: roles/logging.logWriter ────────────────
#
# It would be the reflex, and here it is dead weight. src/cmd/server.ts and
# src/cmd/worker.ts log through pino, which writes JSON to stdout, and Cloud Run
# collects stdout through its own service agent rather than through the
# workload's identity — so the logs arrive, correctly severity-parsed, with no
# role on these accounts at all. Granting logWriter would let each workload
# write log entries to arbitrary log names via the Logging API, which is a
# capability nothing in this codebase uses and which can be used to bury
# evidence in a project whose audit story is meant to be the ledger.
