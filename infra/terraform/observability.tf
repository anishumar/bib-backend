# Logging, one uptime check, and three alerts.
#
# THE SHAPE OF WHAT IS HERE, and why it is small: this product's own record of
# what happened is the audit ledger, a Postgres table that is append-only by
# GRANT and keeps every state transition with its actor forever. Cloud Logging
# is not that, and must not be treated as that. What lives here is OPERATIONAL
# telemetry — is the API answering, is it answering 5xx, is the worker throwing
# — with a retention measured in weeks rather than years.
#
# Nothing here parses or reshapes application logs, because nothing needs to:
# both process shells log through pino, which writes one JSON object per line to
# stdout with a `level` field, and Cloud Logging reads that natively. A logging
# shim would be a layer between the application and the only thing that reads
# it, added to solve a problem that does not exist.

resource "google_logging_project_bucket_config" "bib" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "bib-${local.env}"
  description    = "Operational logs for the bib API, worker, migrate job and frontend."
  retention_days = var.log_retention_days
}

resource "google_logging_project_sink" "bib" {
  name        = "bib-${local.env}"
  project     = var.project_id
  destination = "logging.googleapis.com/projects/${var.project_id}/locations/${var.region}/buckets/${google_logging_project_bucket_config.bib.bucket_id}"

  # Every Cloud Run resource type, present and future, matched by pattern
  # rather than enumerated. Worker pools are new enough that the exact resource
  # type string is not something to hard-code from memory, and a sink with a
  # wrong literal in it does not fail — it silently routes nothing, which is
  # the failure that is only discovered during an incident.
  filter = "resource.type=~\"cloud_run.*\""

  # The sink does NOT stop these entries also reaching the project's _Default
  # bucket. That is intentional: this bucket exists so that retention and
  # location are ours to set, not to divert logs away from the place every
  # operator already knows how to look.
  unique_writer_identity = true

  depends_on = [google_project_service.enabled]
}

# ── NO sink_writer IAM BINDING, and that is not an omission ──────────────────
#
# The usual pattern grants roles/logging.bucketWriter to the sink's
# writer_identity. That is correct when a sink writes ACROSS projects, and wrong
# here: this sink's destination is a log bucket in the SAME project, constructed
# from var.project_id above, so Cloud Logging routes the entries internally and
# mints no writer identity at all.
#
# Measured rather than reasoned about — the sink exists and reports:
#   gcloud logging sinks describe ... --format='value(writerIdentity)'  ->  (empty)
# with unique_writer_identity = true set. So the binding resolved to
# member = "" and the API refused the whole plan:
#   Error: invalid value "" for member
#
# A `count` guard on writer_identity != "" would read as the careful fix and
# breaks a FRESH apply instead, where the sink does not exist yet and the
# attribute is unknown at plan time — "count depends on resource attributes that
# cannot be determined until apply". Since the destination is always same-project
# here, the honest answer is that the binding is never needed.

# ── Where an alert goes ──────────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "bib ${local.env} alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.enabled]
}

# ── The uptime check ─────────────────────────────────────────────────────────

resource "google_monitoring_uptime_check_config" "api" {
  project      = var.project_id
  display_name = "bib API /health"
  timeout      = "10s"
  period       = var.uptime_check_period

  http_check {
    # /health and not /ready, and the difference decides what this alert means.
    # src/api/router.ts mounts both ahead of every guard, with the comment "Ops
    # — always auth-free. Deliberately mounted BEFORE the guards: a load
    # balancer cannot hold a credential". /health says the process is up;
    # /ready additionally consults the database. An uptime check on /ready would
    # page for a Cloud SQL failover that the application recovers from on its
    # own, and it would conflate two causes in one alert.
    path           = "/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      # Stripped of its scheme: a monitored_resource wants a HOST, and passing
      # "https://x.run.app" here makes the check resolve a name with a scheme in
      # it and fail forever in a way that reads like the API is down.
      host = replace(google_cloud_run_v2_service.api.uri, "https://", "")
    }
  }

  # Checked from every region Google offers, which is the default when none is
  # named. That is the right choice even though the product's users are in one
  # country: a check from one region cannot tell a dead API from a dead path
  # between one probe and Mumbai, and the difference is the difference between
  # waking somebody up and not.

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "uptime" {
  project      = var.project_id
  display_name = "bib API is not answering /health"
  combiner     = "OR"

  conditions {
    display_name = "uptime check failing"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.api.uptime_check_id}\"",
      ])

      # Five minutes of failures from more than one probe location before this
      # fires. A single probe failing once is a network event somewhere on the
      # internet; the product has not stopped working, and paging on it is how
      # an alert channel becomes one nobody reads.
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }
}

resource "google_monitoring_alert_policy" "api_5xx" {
  project      = var.project_id
  display_name = "bib API is returning 5xx"
  combiner     = "OR"

  conditions {
    display_name = "5xx rate above threshold"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_count\"",
        "resource.type=\"cloud_run_revision\"",
        "resource.label.\"service_name\"=\"${google_cloud_run_v2_service.api.name}\"",
        "metric.label.\"response_code_class\"=\"5xx\"",
      ])

      # A RATE, not a count, so that this means the same thing at ten requests a
      # minute and at ten thousand. 0.2/s is roughly one 5xx every five seconds
      # sustained for five minutes.
      #
      # Worth knowing when reading this alert: a 500 from this API is more often
      # a real fault than a rejected request. The handlers map domain refusals
      # onto 4xx through api/domainerr.ts, and CLAUDE.md records twice that an
      # unmapped error family answering 500 was a BUG both times — once for
      # StaffGradeError and once for ObligationError, each invisible to unit
      # tests. A rise here is a reason to look at what is unmapped.
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.2

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }
}

# ── The worker, which no uptime check can see ────────────────────────────────
#
# A worker pool has no endpoint, so there is nothing to probe. What it does have
# is a log stream, and the things that go wrong in it announce themselves there
# with a severity: src/cmd/worker.ts logs "boot check failed — refusing to run"
# and exits, and "drain did not finish — hard stop"; the sweeps report a firm
# they failed on rather than dying, because CLAUDE.md's rule is that "a silently
# skipped firm is worse than a stopped sweep, which at least gets noticed".
#
# That last sentence is the whole reason this metric exists. The engine is built
# to keep going past a failure, so a failure is not visible as an outage — it is
# visible as a log line and nothing else.

resource "google_logging_metric" "run_errors" {
  project = var.project_id
  name    = "bib/run_errors"

  filter = join(" AND ", [
    "resource.type=~\"cloud_run.*\"",
    "severity>=ERROR",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "run_errors" {
  project      = var.project_id
  display_name = "bib is logging errors"
  combiner     = "OR"

  conditions {
    display_name = "error-severity log entries from any bib workload"

    condition_threshold {
      # THE RESOURCE CLAUSE IS MANDATORY, AND ITS SYNTAX IS NOT THE SINK'S.
      #
      # Two different refusals from the same API, in order, and each disproves
      # the obvious reading of the other:
      #
      #   resource.type=~"cloud_run.*"   ->  syntax error ... token '=~'
      #   (clause removed entirely)      ->  must specify a restriction on
      #                                      "resource.type"
      #
      # So =~ is LOGGING filter syntax — correct fifteen lines up in
      # google_logging_metric.run_errors, invalid here — and dropping the clause
      # is not the fix either, because a monitoring condition is REQUIRED to name
      # a resource type. starts_with() is how a monitoring filter says the thing
      # =~ says in a logging one.
      #
      # A prefix rather than "cloud_run_revision" deliberately: this metric counts
      # errors from every Cloud Run shape this deployment runs — the API's
      # revisions, the worker POOL and the migrate JOB — and an exact match would
      # quietly drop two thirds of them while still looking like it worked.
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${google_logging_metric.run_errors.name}\"",
        "resource.type=starts_with(\"cloud_run\")",
      ])

      # Deliberately sensitive — anything sustained over five minutes. An error
      # log from this codebase is not routine: the logger is injected, `console`
      # is banned outside src/cmd by ESLint, and errors are required to be
      # actionable and to name the variable, the value and the valid set. A
      # steady trickle of them means something is wrong, not that something is
      # chatty.
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }
}
