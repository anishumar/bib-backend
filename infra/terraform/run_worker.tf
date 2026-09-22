# The worker — dist/cmd/worker.js.
#
# ═══ TWO THINGS ABOUT THIS FILE ARE NOT WHAT THE BRIEF ASKED FOR, AND BOTH ARE
#     FACTS ABOUT CLOUD RUN RATHER THAN CHOICES MADE HERE ═══
#
# (1) IT IS A WORKER POOL, NOT A SERVICE.
#
# src/cmd/worker.ts opens no listening socket. There is no serve() call in it —
# compare src/cmd/server.ts, which calls serve({ fetch, port }) — because the
# worker is a pg-boss consumer plus an internal cron, and its own header says so
# at length: "not a route and not a cron entry calling curl ... a webhook that
# has to be poked by an external scheduler is one more thing that can be down
# without anybody noticing".
#
# Cloud Run's readiness check for a SERVICE is a TCP connection attempt to the
# container's port on every new revision, and a revision that accepts no
# connection never becomes ready — the deployment fails. So a Cloud Run service
# is structurally the wrong shape for this process: it would fail to deploy, and
# the error would talk about a port rather than about the fact that this program
# is not a server.
#
# A worker pool has no endpoint, no URL and no port, and it does not autoscale.
# That is exactly what this process is.
#
# (2) THE TERMINATION GRACE PERIOD CANNOT BE LENGTHENED, SO THE DRAIN IS
#     SHORTENED INSTEAD.
#
# The worker's own arithmetic wants about sixty seconds: it waits
# BIB_WORKER_SHUTDOWN_GRACE_MS (45000 by default, src/config/config.ts) for work
# in flight, then hard-stops fifteen seconds after that (src/cmd/worker.ts,
# `cfg.worker.shutdownGraceMs + 15_000`).
#
# Cloud Run gives every container — service, job and worker pool alike — a fixed
# TEN SECONDS between SIGTERM and SIGKILL. It is not a setting: there is no
# terminationGracePeriodSeconds on RevisionTemplate, none on
# WorkerPoolRevisionTemplate, and therefore no argument on either Terraform
# resource. There is no value to "get right" here; the field does not exist.
#
# So BIB_WORKER_SHUTDOWN_GRACE_MS is set to 7000 on this workload, which puts
# pg-boss's drain and the process's clean exit inside the window Cloud Run
# actually gives. WHAT THAT COSTS, STATED PLAINLY: a sweep that takes longer
# than seven seconds to finish is killed mid-flight on every deploy and every
# instance replacement.
#
# WHY THAT IS SURVIVABLE, AND IT IS THE SAME PROPERTY THE QUEUE WAS CHOSEN FOR:
# pg-boss is durable, so a job killed mid-flight is redelivered. CLAUDE.md calls
# at-least-once delivery "the whole design" of this engine and says the defence
# is structural rather than careful — "the job id is DERIVED from its cause,
# UNIQUE (tenant_id, source_kind, source_ref) makes the second insert conflict,
# and the event is recorded only when a row was actually created". A killed
# sweep re-runs and produces the same rows it already produced, or none.
#
# WHAT IS ACTUALLY LOST is the in-flight sweep's own progress and the log line
# saying it finished. That is a real reduction in a value the repo argued for at
# length, and it is a decision somebody should sign off rather than inherit from
# a comment. It is reported as a blocker, not buried here.

locals {
  worker_env = {
    BIB_ENVIRONMENT = local.env
    BIB_LOG_LEVEL   = var.log_level

    # The worker runs validateServer exactly as the API does — src/cmd/worker.ts
    # calls it with the reasoning that a worker "is if anything MORE dependent
    # on the wall being up than a request handler is". So every gated variable
    # has to be present and has to pass, even the ones the worker never uses:
    # an empty BIB_CORS_ORIGINS or BIB_MAIL_TRANSPORT=log stops this process
    # booting just as surely as it stops the API.
    BIB_APP_BASE_URL = local.app_origin
    BIB_CORS_ORIGINS = local.app_origin

    # The transport and the two variables validateServer inspects when it is
    # `smtp` — the relay host and the From address — and DELIBERATELY NOT the
    # password. src/setup/worker.ts composes no Mailer at all: CLAUDE.md records
    # that the chaser and the nudge "send nothing", that no mailer is injected,
    # and that ChaserService's dependency list is asserted by a test so a
    # transport appearing in it turns the build red. A credential this process
    # cannot use is a credential it should not hold.
    BIB_MAIL_TRANSPORT = "smtp"
    BIB_MAIL_FROM      = var.mail_from
    BIB_SMTP_HOST      = var.smtp_host

    # Same shape: the gate refuses `filesystem` and `attested`, so the values
    # have to be the real ones, while the credentials behind them stay with the
    # API. src/setup/worker.ts constructs neither a BlobStore nor an
    # ESignProvider.
    BIB_STORAGE_BACKEND     = var.storage_backend
    BIB_GCS_BUCKET          = google_storage_bucket.blobs.name
    BIB_ESIGN_PROVIDER      = var.esign_provider
    BIB_DOCUSIGN_ACCOUNT_ID = var.docusign_account_id
    BIB_DOCUSIGN_OAUTH_BASE = var.docusign_oauth_base_uri

    # The value the header of this file is about.
    BIB_WORKER_SHUTDOWN_GRACE_MS = tostring(var.worker_shutdown_grace_ms)
  }

  worker_secret_env = {
    BIB_APP_DATABASE_URL = "app-database-url"
    BIB_DATABASE_URL     = "runtime-database-url"
    BIB_INTERNAL_KEYS    = "internal-keys-offline"
  }
}

resource "google_cloud_run_v2_worker_pool" "worker" {
  name     = "bib-worker"
  project  = var.project_id
  location = var.region

  # Same lock as the two services. Nothing here is stateful — pg-boss's queue
  # lives in Postgres — but a destroyed worker pool stops every sweep in the
  # product, silently, because no request fails when the thing that runs the
  # compliance calendar stops running.
  deletion_protection = var.run_deletion_protection

  scaling {
    # MANUAL, and there is no autoscaling to fall back to — a worker pool does
    # not autoscale. The count is one, and run_worker's variable explains why
    # raising it is a correctness question rather than a capacity one: the cron
    # lives INSIDE this process, so a second instance is a second scheduler.
    scaling_mode          = "MANUAL"
    manual_instance_count = var.worker_instance_count
  }

  template {
    service_account = google_service_account.worker.email

    vpc_access {
      network_interfaces {
        network    = google_compute_network.bib.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.worker_image

      # THE IMAGE IS SHARED AND ITS CMD IS THE API. One image carries server,
      # worker and migrate (they share dist/ and a single build), so whichever
      # workload does NOT want the default must say so. Without this the worker
      # pool silently ran a second copy of the API: healthy, reachable, and
      # sweeping nothing — no job would ever spawn and nobody would be paged,
      # because the thing that was down had no endpoint to fail.
      command = ["node", "dist/cmd/worker.js"]

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
      }

      # NO ports block and no probe. A worker pool has neither, which is the
      # whole reason this process is deployed as one.

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.bib[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  # CPU IS ALWAYS ALLOCATED HERE, and it is not a setting on this resource
  # because it cannot be anything else: a worker pool instance has no request
  # lifecycle to be throttled between. That is the second reason this process
  # belongs in a pool rather than a service — a Cloud Run service with
  # cpu_idle = true would throttle the instance to near zero between requests
  # that never come, and the internal cron would simply stop firing.

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.readers,
  ]

  # WHO OWNS THE IMAGE TAG. Terraform sets it ONCE, at create, from var.worker_image;
  # after that cloudbuild.yaml owns it and Terraform must not argue.
  #
  # The deploy steps run `gcloud run ... --image=...:$COMMIT_SHA` against the worker pool,
  # so the live image is whatever shipped last. Without this block the next
  # `terraform apply` — run for something unrelated, a firewall rule, an alert —
  # would read var.worker_image, still see its placeholder default, and quietly roll
  # production back to Google's hello container. Nobody would connect the
  # outage to the change they were actually making.
  #
  # NOTE the path: a Job nests `template` twice where a Service and a worker
  # pool nest it once, so these three are not interchangeable.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}
