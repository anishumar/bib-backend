# Cloud SQL for PostgreSQL — the one resource in this directory that cannot be
# recreated. Everything else here can be destroyed and re-applied at the cost of
# a few minutes; this holds the firm's client book, its engagement letters and
# an append-only audit ledger, and there is no second copy of any of it.

resource "google_sql_database_instance" "bib" {
  name    = "bib-${local.env}"
  project = var.project_id
  region  = var.region

  # POSTGRES_17, CHOSEN, against a Cloud SQL default that is now 18.
  #
  # The floor is stated by the migrations themselves. migrations/0300 line 84
  # reads "NULLS NOT DISTINCT (Postgres 15+; this product runs 17)" and line 90
  # depends on it: without UNIQUE NULLS NOT DISTINCT the recurring-period key
  # admits duplicates on a null period_start, which is a second set of tasks and
  # eventually a second invoice for work already done. So 15 is the floor.
  #
  # 17 rather than 18 is the deliberate half. The repo's own comment says what
  # this product RUNS, the test suite has only ever been executed against it,
  # and 18 is merely what Cloud SQL hands out to somebody who does not choose.
  # Postgres 17 does not reach extended support until 2030, so there is no
  # clock forcing this. Moving to 18 is a decision with a test run behind it,
  # not a default inherited from a provider.
  #
  # pg-boss (12.28.0, src/infrastructure/pgboss/boss-queue.ts) wants 13 or
  # higher and is satisfied either way.
  database_version = "POSTGRES_17"

  # BOTH deletion switches, on purpose, because they stop different people.
  #
  # This one is Terraform's: it makes `terraform destroy` and any plan that
  # would replace this instance fail before anything happens.
  deletion_protection = true

  settings {
    tier = var.db_tier

    # ENTERPRISE rather than ENTERPRISE_PLUS. The one thing Plus would buy that
    # is visible in this configuration is 35 days of transaction log retention
    # instead of 7 (see backup_configuration below). Seven days of
    # point-in-time recovery answers "somebody ran the wrong UPDATE on Tuesday";
    # thirty-five answers a question the daily backups already answer, at
    # roughly double the instance price.
    edition = "ENTERPRISE"

    # REGIONAL — a synchronous standby in a second zone, with automatic
    # failover. The whole product refuses to serve without its database: both
    # process shells run assertTenantWall and assertLedgerAppendOnly at boot
    # (src/cmd/server.ts, src/cmd/worker.ts) and exit(1) if either cannot be
    # answered. A zonal instance therefore does not degrade during a zone
    # incident, it takes the API and the worker down with it and keeps them
    # down, because Cloud Run will go on restarting containers that go on
    # failing their boot check.
    # REGIONAL by default, for the reason argued directly above. A non-production
    # environment may set this to ZONAL and roughly halve the bill — it is the
    # single largest line on it — accepting that a zone incident takes the whole
    # environment down until the zone returns. That is a trade a QA environment
    # can make and production cannot, so it is a variable with the safe default
    # rather than a value edited in place when somebody wants a cheap instance.
    availability_type = var.db_availability_type

    disk_type = "PD_SSD"
    disk_size = var.db_disk_size_gb

    # Autoresize with a ceiling. The floor matters because Postgres does not
    # degrade when it runs out of disk, it stops accepting writes; the ceiling
    # matters because "grow forever" turns a runaway query into an invoice.
    disk_autoresize       = true
    disk_autoresize_limit = var.db_disk_size_gb * 4

    ip_configuration {
      # NO PUBLIC IP. This is the reason network.tf exists. The app role is
      # NOBYPASSRLS and every business table carries a policy, but RLS defends
      # against one tenant reading another — it does not defend against a
      # password reaching somebody on the internet. There is no second wall
      # behind a public database.
      ipv4_enabled    = false
      private_network = google_compute_network.bib.id

      # ENCRYPTED_ONLY refuses an unencrypted connection at the server. It
      # costs no code change: postgres.js maps a `sslmode` query parameter onto
      # its own `ssl` option (node_modules/postgres/src/index.js, line 443), so
      # appending ?sslmode=require to the URL stored in Secret Manager is the
      # whole client-side story. secrets.tf says the same thing where the
      # operator will actually read it.
      ssl_mode = "ENCRYPTED_ONLY"

      # Lets Google-managed services inside the private path reach the instance
      # without a public address of their own.
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = var.db_backup_start_time
      location                       = var.region
      point_in_time_recovery_enabled = true

      # 7 is the ENTERPRISE ceiling, not a preference — the provider rejects
      # anything above it on this edition. It is also what decides how far back
      # a point-in-time restore can reach, which is the number that matters
      # when the thing being recovered from is a bad migration rather than a
      # lost disk.
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = var.db_retained_backups
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day  = var.db_maintenance_day
      hour = var.db_maintenance_hour

      # "stable" takes patches a release cycle after "canary". This database
      # has one instance and one product on it; being early to a Cloud SQL
      # patch buys nothing and a REGIONAL failover during a maintenance restart
      # is a few seconds every process has to survive.
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled = true

      # Query text is recorded WITHOUT literals. That is not a performance
      # setting, it is the same rule CLAUDE.md applies to the audit ledger —
      # "PII stays out of any append-only log (erasability)". A client's name
      # or PAN captured into a query-insights sample is personal data in a
      # store nobody can erase per-subject.
      record_application_tags = false
      record_client_address   = false
    }

    # BOTH deletion switches, part two. This one is GCP's: it refuses the
    # delete from the API, from gcloud and from the console, so it stops
    # somebody who is not running Terraform at all. The Terraform-level flag
    # above stops a plan; this stops a person with a browser.
    deletion_protection_enabled = true

    # Only the automated backup window and the maintenance window run outside
    # business hours; everything else about this instance is on all the time.
    activation_policy = "ALWAYS"

    user_labels = local.labels
  }

  # The peering has to exist before an instance can be given an address out of
  # it. Without this the first apply fails with a message about an unallocated
  # range that reads as a quota problem.
  depends_on = [
    google_service_networking_connection.private_services,
    google_project_service.enabled,
  ]

  lifecycle {
    # The tier is the one setting an operator legitimately changes from the
    # console during an incident, and having the next apply quietly change it
    # back would be a second incident.
    ignore_changes = [settings[0].tier]
  }
}

resource "google_sql_database" "bib" {
  name     = "bib"
  project  = var.project_id
  instance = google_sql_database_instance.bib.name

  # UTF8 throughout. The renderer draws Latin, Latin-ext and Devanagari from a
  # font chain (src/infrastructure/render/font-set.ts) and refuses characters it
  # cannot draw rather than mangling them; a database that mangled them first
  # would make that refusal unreachable.
  charset   = "UTF8"
  collation = "en_US.UTF8"
}

# ── WHAT IS DELIBERATELY NOT HERE: the roles ─────────────────────────────────
#
# There is no google_sql_user for bib_owner and none for bib_app, and adding one
# would be a mistake rather than a convenience.
#
# src/cmd/migrate.ts owns those two roles. It creates them if they are missing
# and then re-asserts bib_app's attributes on EVERY run, with the comment
# "NOBYPASSRLS is the load-bearing attribute — assert it every run". That single
# attribute is the whole tenant wall: src/db/boot-check.ts refuses to start
# either process if the app role can bypass RLS. A second writer of that role —
# Terraform, running on its own schedule, from a plan somebody approved without
# reading — could set the attribute the other way between two migrate runs, and
# the only thing that would notice is a boot check, after the fact.
#
# One owner per fact. The migrator owns the roles; Terraform owns the instance
# the roles live in.
#
# THE `postgres` USER'S PASSWORD is also not set here, and that is the same
# rule reached from the secrets side: setting it through google_sql_user would
# put the password in the state file. README.md has the one gcloud command that
# sets it, and secrets.tf explains why the migrate job connects as that user
# rather than as bib_owner.
