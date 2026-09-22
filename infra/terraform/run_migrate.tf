# The migrator — dist/cmd/migrate.js as a Cloud Run JOB.
#
# A job and not a service, because this program applies SQL and exits. Its own
# header says it is "meant to run as a one-shot job (locally by hand, in prod as
# a pre-deploy job), never as a long-lived process".
#
# TWO CONSTRAINTS THIS RESOURCE HAS TO RESPECT, AND NEITHER IS OBVIOUS FROM THE
# OUTSIDE:
#
# (1) THE IMAGE MUST SHIP migrations/ BESIDE dist/. src/cmd/migrate.ts resolves
#     its SQL with join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
#     which from /app/dist/cmd/migrate.js is /app/migrations. An image built
#     with only dist/ in it produces a job that succeeds having applied nothing,
#     which is the worst available outcome: the deploy goes green and the
#     services then fail their boot checks against a schema that was never
#     created.
#
# (2) IT CONNECTS AS THE CLOUD SQL `postgres` USER, NOT AS bib_owner. The
#     migrations create four extensions — pgcrypto and citext (0001), pg_trgm
#     (0002), btree_gist (0049) — and on Cloud SQL only a member of
#     cloudsqlsuperuser may create one. 0049's own comment states the same fact
#     from the local side: an extension "needs CREATE on the DATABASE, which
#     bib_owner deliberately does not hold. The migrator connects as
#     BIB_DATABASE_URL, which does". secrets.tf holds that URL and only this
#     workload's service account can read it.

resource "google_cloud_run_v2_job" "migrate" {
  name     = "bib-migrate"
  project  = var.project_id
  location = var.region

  # FALSE here, unlike the two services. A job holds no state and serves no
  # traffic; deletion protection on it would only ever get in the way of
  # recreating it, and there is nothing to lose by doing so.
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.migrate.email

      # NO RETRIES, and this is the setting most worth defending in this file.
      # A failed migration has left the database in whatever state the failing
      # statement left it — src/cmd/migrate.ts wraps each FILE in a transaction,
      # so a failure rolls that file back, but a run that applied 0300 and then
      # failed on 0301 has half the intended change applied and recorded.
      # Retrying blindly re-runs from the next pending file against a database
      # somebody now needs to look at. A human reads the log and decides.
      max_retries = 0

      # Fifteen minutes. Long enough for the first run against an empty database,
      # which applies every migration in migrations/ in one execution, and short
      # enough that a job wedged on a lock does not hold a deploy open all
      # afternoon.
      timeout = "900s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.bib.id
          subnetwork = google_compute_subnetwork.run.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image = var.migrate_image

        # Same shared image, same reason as the worker — and here the failure is
        # worse than silent: a Job running the API never exits, so the deploy
        # would block on a migration that was never applied.
        command = ["node", "dist/cmd/migrate.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        # This job does NOT call validateServer — src/cmd/migrate.ts calls
        # load() and nothing else — so it needs only the variables the zod
        # schema requires, and none of the ones the production gate inspects.
        # That is why there is no CORS origin, no mail transport and no storage
        # backend here: adding them would imply this process is subject to a
        # gate it never reaches.
        env {
          name  = "BIB_ENVIRONMENT"
          value = local.env
        }
        env {
          name  = "BIB_LOG_LEVEL"
          value = var.log_level
        }
        env {
          name = "BIB_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.bib["owner-database-url"].secret_id
              version = "latest"
            }
          }
        }
        # Not a connection — a PASSWORD. src/cmd/migrate.ts sets bib_app's
        # password from cfg.db.appPassword, which src/config/config.ts parses
        # out of this URL. Without it the app role exists with a password
        # nobody set, and every later boot fails authentication.
        env {
          name = "BIB_APP_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.bib["app-database-url"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "BIB_INTERNAL_KEYS"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.bib["internal-keys-offline"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  # ── WHY run_execution_token IS NOT SET ──────────────────────────────────────
  #
  # The provider offers start_execution_token and run_execution_token, either of
  # which would make `terraform apply` execute this job. Both are deliberately
  # absent.
  #
  # Migrations belong to the DEPLOY, not to the infrastructure plan. The correct
  # order is: build the image, push it, run this job once, wait for it to
  # succeed, and only then update the services to the new image — because the
  # services' boot checks assert against the schema the job just applied. Tying
  # execution to an apply gets that order wrong in both directions: an apply
  # that changes a load balancer label would run migrations, and an apply that
  # updates the service image would run them in the same graph as the update
  # rather than before it.
  #
  # README.md has the gcloud command the pipeline runs between the push and the
  # service update.

  depends_on = [
    google_project_service.enabled,
    google_sql_database.bib,
    google_secret_manager_secret_iam_member.readers,
  ]

  # WHO OWNS THE IMAGE TAG. Terraform sets it ONCE, at create, from var.migrate_image;
  # after that cloudbuild.yaml owns it and Terraform must not argue.
  #
  # The deploy steps run `gcloud run ... --image=...:$COMMIT_SHA` against the migrate job,
  # so the live image is whatever shipped last. Without this block the next
  # `terraform apply` — run for something unrelated, a firewall rule, an alert —
  # would read var.migrate_image, still see its placeholder default, and quietly roll
  # production back to Google's hello container. Nobody would connect the
  # outage to the change they were actually making.
  #
  # NOTE the path: a Job nests `template` twice where a Service and a worker
  # pool nest it once, so these three are not interchangeable.
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}
