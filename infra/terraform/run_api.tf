# The API — dist/cmd/server.js on Cloud Run.

locals {
  # Plain environment. Every name here is a key in the zod schema in
  # src/config/config.ts; a name that is not is silently ignored by the process,
  # which is the failure mode this list is written carefully to avoid.
  api_env = {
    # No default exists for this one, on purpose — config.ts refuses to boot
    # without it, because "the environment label is a security control" and an
    # unset one silently turns on dev header auth, the docs, an insecure cookie
    # and the logging mailer.
    BIB_ENVIRONMENT = local.env
    BIB_LOG_LEVEL   = var.log_level

    # BIB_PORT, set explicitly to the value the container port below also uses.
    # Cloud Run injects PORT; this application never reads it (src/cmd/server.ts
    # listens on cfg.port, which comes from BIB_PORT). The two default to the
    # same 8080 today, so leaving this out would work by coincidence — and stop
    # working the day somebody changes one of them.
    BIB_PORT = "8080"

    # Where a magic link sends the user: the FRONTEND's redemption page.
    BIB_APP_BASE_URL = local.app_origin

    # THE ONE ALLOWED ORIGIN. validateServer refuses a wildcard, an empty list,
    # any http:// and any localhost, and src/api/router.ts matches exactly —
    # "never a reflection of whatever Origin arrived", because with
    # credentials: true a reflected origin lets any site on the internet make
    # authenticated requests with a user's cookie and read the answers.
    BIB_CORS_ORIGINS = local.app_origin

    # Behind the global external load balancer built in lb.tf. The pair has to
    # be right or the rate limiter breaks in one of two silent ways, both
    # described in src/config/config.ts: with trust off every client shares the
    # balancer's address and one bucket throttles the whole customer base; with
    # trust on and no proxy in front, any caller invents its own key per request
    # and opts out of rate limiting entirely.
    #
    # ONE is the hop count for one load balancer. IT BECOMES TWO THE DAY A CDN
    # IS PUT IN FRONT, and nothing will tell you: X-Forwarded-For simply grows
    # an entry, the limiter reads one position too far to the left, and the
    # value it reads is the one the caller wrote.
    BIB_TRUST_PROXY        = "true"
    BIB_TRUSTED_PROXY_HOPS = "1"

    # smtp, because validateServer refuses `log` in production: "the logging
    # mailer does not send email — it prints the sign-in link". A portal invite
    # that never arrives is a client who cannot get in.
    # See variables.tf: Lax is silently broken across two run.app services.
    BIB_SESSION_COOKIE_SAMESITE = var.session_cookie_samesite

    BIB_MAIL_TRANSPORT = "smtp"
    BIB_MAIL_FROM      = var.mail_from
    BIB_MAIL_FROM_NAME = var.mail_from_name
    BIB_SMTP_HOST      = var.smtp_host
    BIB_SMTP_PORT      = tostring(var.smtp_port)
    BIB_SMTP_USER      = var.smtp_user
    BIB_SMTP_SECURE    = var.smtp_secure ? "true" : "false"

    # The object store, and the variable that names the bucket. Both are LIVE:
    # config.ts accepts "gcs" and setup/server.ts builds the adapter from them.
    BIB_STORAGE_BACKEND = var.storage_backend
    BIB_GCS_BUCKET      = google_storage_bucket.blobs.name

    # The e-sign provider, and the three non-secret facts about the account.
    # See secrets.tf for which parts of DocuSign's credential are secrets and
    # which are addresses.
    BIB_ESIGN_PROVIDER      = var.esign_provider
    BIB_DOCUSIGN_ACCOUNT_ID = var.docusign_account_id
    BIB_DOCUSIGN_OAUTH_BASE = var.docusign_oauth_base_uri
  }

  # Environment that comes from Secret Manager. The value never passes through
  # Terraform — Cloud Run resolves the reference when the instance starts, which
  # is also why a missing secret version fails as a start-up error naming the
  # secret rather than as an application error naming nothing.
  api_secret_env = {
    BIB_APP_DATABASE_URL         = "app-database-url"
    BIB_DATABASE_URL             = "runtime-database-url"
    BIB_INTERNAL_KEYS            = "internal-keys"
    BIB_SMTP_PASSWORD            = "smtp-password"
    BIB_DOCUSIGN_INTEGRATION_KEY = "docusign-integration-key"
    BIB_DOCUSIGN_USER_ID         = "docusign-user-id"
    BIB_DOCUSIGN_PRIVATE_KEY     = "docusign-private-key"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "bib-api"
  project  = var.project_id
  location = var.region

  # DEFAULT: only the load balancer may reach this service, and the generated
  # run.app URL stops answering. That is the point when an LB exists — with two
  # entry points, one of them is the one whose CORS origin, forwarded-for chain
  # and TLS certificate nobody checked, and it is also the URL that ends up in
  # somebody's bookmark.
  #
  # BUT WITH lb.tf DISABLED IT LEAVES ZERO ENTRY POINTS. The service comes up
  # Ready, allUsers holds run.invoker, and every request is answered by Google's
  # own 404 page before it reaches the container — which reads exactly like a
  # routing bug in the app and is not one. So an environment running on run.app
  # URLs sets this to INGRESS_TRAFFIC_ALL, and the reason the usual objection
  # does not apply there is that there is only ever one entry point to begin with.
  ingress = var.run_ingress

  # This is the process that serves the product. A destroy that reaches it
  # should have to be spelled out.
  deletion_protection = var.run_deletion_protection

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    # Direct VPC egress, not a Serverless VPC Access connector. Google's own
    # documentation heads the section "Direct VPC egress (recommended)", and the
    # difference that matters here is operational rather than architectural: a
    # connector is a set of billed VM instances that has to be sized, watched
    # and upgraded, and it is a second thing between the API and the database
    # that can be the cause of an outage. Direct egress attaches the Cloud Run
    # instance to the subnet itself. The price is address space, which
    # network.tf answers with a /24.
    vpc_access {
      network_interfaces {
        network    = google_compute_network.bib.id
        subnetwork = google_compute_subnetwork.run.id
      }

      # PRIVATE_RANGES_ONLY: the Cloud SQL peering range goes through the VPC,
      # and the SMTP relay and the DocuSign API leave by Cloud Run's own
      # internet path. Changing this to ALL_TRAFFIC without first adding a Cloud
      # NAT takes away every outbound connection to the internet — see the note
      # at the foot of network.tf.
      egress = "PRIVATE_RANGES_ONLY"
    }

    # The Cloud Run default, written down. Shortening it would cut off the
    # slowest legitimate request this API serves, which is a 25 MB upload being
    # hashed in memory (BIB_MAX_UPLOAD_BYTES, and src/config/config.ts calls it
    # "a MEMORY BUDGET, not a preference").
    timeout = "300s"

    containers {
      image = var.api_image

      ports {
        name = "http1"
        # 8080, matching BIB_PORT above rather than relying on Cloud Run's
        # default happening to agree with the application's.
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.api_cpu
          memory = var.api_memory
        }

        # CPU throttled between requests. The API is request-driven: it holds no
        # timer, no queue and no sweep — all of that is the worker's — so paying
        # for CPU while an instance is idle buys nothing. The worker pool is the
        # opposite case and run_worker.tf says so.
        cpu_idle = true

        # Start-up CPU boost, because boot here is not cheap: validateServer,
        # then assertTenantWall and assertLedgerAppendOnly against Postgres, all
        # before the socket is opened.
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret = google_secret_manager_secret.bib[env.value].secret_id

              # "latest", so rotating a credential is a new secret version and a
              # new revision rather than an edit to this file. The cost is that
              # a bad version is picked up by the next instance to start; the
              # benefit is that an emergency rotation does not need a Terraform
              # run, which is what an emergency rotation must not need.
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        # /health, which src/api/router.ts mounts BEFORE every guard with the
        # comment "Ops — always auth-free ... a load balancer cannot hold a
        # credential". So this needs no exception anywhere in the auth stack.
        http_get {
          path = "/health"
          port = 8080
        }

        # The budget is deliberately generous: initial delay plus period times
        # threshold has to cover config validation and two round trips to
        # Postgres on a cold connection. A revision that fails its startup probe
        # does not serve, so being impatient here turns a slow database into a
        # failed deploy.
        initial_delay_seconds = 5
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 12
      }

      # No liveness probe, deliberately. src/cmd/server.ts already exits the
      # process on a failed boot check, and a liveness probe on /health would
      # add a second restart trigger that fires on a transient blip — which,
      # with a database-dependent boot sequence behind it, is how a brief
      # database hiccup becomes a restart loop.
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.readers,
  ]

  # WHO OWNS THE IMAGE TAG. Terraform sets it ONCE, at create, from var.api_image;
  # after that cloudbuild.yaml owns it and Terraform must not argue.
  #
  # The deploy steps run `gcloud run ... --image=...:$COMMIT_SHA` against the API service,
  # so the live image is whatever shipped last. Without this block the next
  # `terraform apply` — run for something unrelated, a firewall rule, an alert —
  # would read var.api_image, still see its placeholder default, and quietly roll
  # production back to Google's hello container. Nobody would connect the
  # outage to the change they were actually making.
  #
  # NOTE the path: a Job nests `template` twice where a Service and a worker
  # pool nest it once, so these three are not interchangeable.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

# The load balancer reaches Cloud Run as an unauthenticated caller; `ingress`
# above is what actually restricts who may do that, and the API's own guards are
# what restrict what they may then reach. src/api/guards.ts denies by default on
# both the audience and the permission axis, and tests/api/auth-coverage.test.ts
# holds the build red if a route outside the allowlists answers anything but 401
# to an anonymous caller — so "public invoker" here means "the product's own
# front door", not "open".
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
