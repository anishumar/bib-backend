# Every knob, with a production default wherever a default can be honest.
#
# The rule applied throughout: a variable gets a default when the value is a
# reasonable answer for any firm running this product, and gets NO default when
# the value is a fact about one deployment that nobody can guess. A project id
# with a plausible-looking default is a resource created in the wrong project.

# ── Identity of the deployment ───────────────────────────────────────────────

variable "project_id" {
  description = "The GCP project that holds every resource in this configuration."
  type        = string
}

variable "region" {
  description = "The single region everything runs in."
  type        = string

  # asia-south1 (Mumbai) is the defensible default and not a coin toss. This is
  # an India compliance product: the calendar it generates is Indian statute
  # (migrations/0052+), the worker's sweep cadences are argued in Indian time
  # zone offsets (src/config/config.ts, "02:15 is after midnight in every Indian
  # time zone offset"), and the first customer's letters go out from an .in
  # domain. Data residency for a firm's client book is a question a professional
  # services firm in this market will be asked by its own clients, and answering
  # it with "Iowa" starts a conversation nobody wants to have.
  default = "asia-south1"
}

# ── The two public domains ───────────────────────────────────────────────────
#
# THESE ARE INPUTS, NEVER OUTPUTS, AND THAT IS FORCED RATHER THAN PREFERRED.
#
# The frontend reads NEXT_PUBLIC_API_BASE_URL, which Next bakes into the bundle
# at BUILD time and also compiles into the Content-Security-Policy's connect-src
# (bib-frontend/next.config.ts). So the API's public origin has to be known
# before the frontend image is built. Meanwhile the API's BIB_CORS_ORIGINS has
# to be exactly the frontend's origin, and validateServer refuses a wildcard, an
# empty list, any http:// and any localhost (src/config/validate.ts).
#
# Each side therefore needs the other's final domain, and neither can be
# discovered from a Cloud Run service that does not exist yet. A generated
# *.run.app URL cannot serve either purpose: it is not stable across a service
# being recreated, and a rebuild of the frontend would be required every time it
# moved. Both domains are decided by a person, written here, and pointed at the
# load balancer's IP afterwards.

variable "api_domain" {
  description = "Public hostname of the API, e.g. api.example.com. Must match NEXT_PUBLIC_API_BASE_URL in the frontend image."
  type        = string

  # Unused while lb.tf is disabled. Empty rather than removed: the load
  # balancer comes back with a real domain, and deleting the variable would
  # mean rediscovering what it was called.
  default = ""
}

variable "app_domain" {
  description = "Public hostname of the frontend, e.g. app.example.com. Becomes the API's one allowed CORS origin."
  type        = string

  # Unused while lb.tf is disabled. Empty rather than removed: the load
  # balancer comes back with a real domain, and deleting the variable would
  # mean rediscovering what it was called.
  default = ""
}

# ── Container images ─────────────────────────────────────────────────────────
#
# Every one of these defaults to Google's public hello container, and the reason
# is a chicken-and-egg that bites on day one: a Cloud Run service cannot be
# created from an image that does not exist, and nothing exists in Artifact
# Registry until the registry itself has been created by this configuration and
# something has pushed to it. With a placeholder, the first `terraform apply`
# converges and produces a registry, a database, secrets and a load balancer.
# The deploy pipeline then pushes real images and re-applies with these four
# variables set to immutable digests.
#
# DIGESTS, NOT TAGS, once real. A tag is a mutable pointer, so `:latest` makes a
# plan that shows no change deploy different code than the plan that preceded
# it, and makes a rollback unexpressible.

variable "api_image" {
  description = "Image for the API service. Override with an Artifact Registry digest."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "worker_image" {
  description = "Image for the worker pool. Override with an Artifact Registry digest."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "migrate_image" {
  description = "Image for the migrate job. MUST ship migrations/ beside dist/ — src/cmd/migrate.ts resolves them two directories above itself."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "frontend_image" {
  description = "Image for the frontend service. NEXT_PUBLIC_API_BASE_URL is baked into it at build time."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# ── Networking ───────────────────────────────────────────────────────────────

variable "run_subnet_cidr" {
  description = "IPv4 range of the subnet Cloud Run attaches to with Direct VPC egress."
  type        = string

  # /24, not the /26 minimum, and the arithmetic is the reason. Direct VPC
  # egress consumes about two addresses per running instance at steady state,
  # and a Cloud Run JOB task holds its address for seven minutes after it
  # finishes. A /26 is 64 addresses, so the whole platform — API instances,
  # worker instances, frontend instances and every migrate execution still
  # cooling down — would share a ceiling of roughly thirty concurrent
  # instances. Running out does not degrade gracefully: new instances simply
  # fail to start, under load, which is exactly when they are being asked for.
  # A /24 costs nothing (these are private addresses in a VPC nothing else
  # uses) and moves the ceiling somewhere nobody has to think about it.
  default = "10.80.0.0/24"
}

variable "private_services_prefix_length" {
  description = "Prefix length of the range reserved for private services access (Cloud SQL's peering)."
  type        = number

  # /16 because the range is allocated ONCE and consumed by every managed
  # service that ever peers into this VPC, and Google's own guidance is that it
  # cannot be enlarged in place after services are attached to it. Widening it
  # later means detaching Cloud SQL, which means downtime on the one resource
  # that cannot be recreated.
  default = 16
}

# ── Cloud SQL ────────────────────────────────────────────────────────────────

variable "db_tier" {
  description = "Cloud SQL machine type."
  type        = string

  # 2 vCPU / 7.5 GB. The floor is set by what actually connects, not by load:
  # the API holds BIB_DB_POOL_APP (10) plus an owner pool, the worker holds its
  # own, and pg-boss opens connections of its own on top (src/infrastructure/
  # pgboss/boss-queue.ts). A shared-core tier caps max_connections low enough
  # that a second API instance starting during a deploy can exhaust it, and the
  # symptom is a boot check failing rather than anything that says "connections".
  default = "db-custom-2-7680"
}

variable "db_disk_size_gb" {
  description = "Initial disk size. The instance also has autoresize enabled, so this is a floor and not a ceiling."
  type        = number
  default     = 50
}

variable "db_backup_start_time" {
  description = "Daily backup start, HH:MM in UTC."
  type        = string

  # 18:30 UTC is midnight in India. The backup window and the maintenance
  # window below are both placed in the firm's night rather than the region's,
  # for the reason every cron default in src/config/config.ts is argued from:
  # the people using this product are in IST, and a maintenance restart at
  # 14:00 local is an outage in the middle of a working day.
  default = "18:30"
}

variable "db_maintenance_day" {
  description = "Day of week for the maintenance window, 1 (Monday) to 7 (Sunday)."
  type        = number
  default     = 7
}

variable "db_maintenance_hour" {
  description = "Hour of day for the maintenance window, 0-23, UTC."
  type        = number

  # 19:00 UTC = 00:30 IST, Sunday night into Monday.
  default = 19
}

variable "db_retained_backups" {
  description = "How many automated backups to keep."
  type        = number
  default     = 30
}

# ── Cloud Run sizing ─────────────────────────────────────────────────────────

variable "api_min_instances" {
  description = "Minimum API instances kept warm."
  type        = number

  # One, not zero. A cold start here is not the usual few hundred milliseconds
  # of framework boot: src/cmd/server.ts runs validateServer, then
  # assertTenantWall and assertLedgerAppendOnly against Postgres before it
  # listens (src/db/boot-check.ts). Every one of those is a round trip to a
  # database in another subnet, on a connection that has to be established
  # first. Scaling to zero would put that on the first user of the morning.
  default = 1
}

variable "api_max_instances" {
  description = "Maximum API instances."
  type        = number

  # The rate limiter's store is IN-PROCESS (src/api/ratelimit.ts, and CLAUDE.md
  # says so out loud: "per-process, so behind N pods every limit is N times
  # looser"). BIB_RATELIMIT_AUTH_PER_MINUTE is 10, so ten instances means a
  # hundred sign-in attempts a minute against one account before anything
  # throttles. This ceiling is therefore a SECURITY parameter as much as a cost
  # one, and raising it without moving the limiter to Redis loosens brute-force
  # protection by exactly the factor it is raised by.
  default = 10
}

variable "frontend_min_instances" {
  description = "Minimum frontend instances kept warm."
  type        = number
  default     = 1
}

variable "frontend_max_instances" {
  description = "Maximum frontend instances."
  type        = number
  default     = 10
}

variable "worker_instance_count" {
  description = "How many worker pool instances run. See run_worker.tf: this is not a scaling knob."
  type        = number

  # ONE, and raising it is not a capacity decision — it is a correctness one.
  # The worker runs an INTERNAL cron (BIB_WORKER_*_CRON), so a second instance
  # is a second scheduler firing the same sweeps at the same minute. The sweeps
  # are built to survive that — every trigger in the delivery engine is
  # at-least-once and deduplicated by a derived id and a unique key, which
  # CLAUDE.md calls "the whole design" — but surviving duplicate work is not a
  # reason to buy it.
  default = 1
}

variable "worker_shutdown_grace_ms" {
  description = "BIB_WORKER_SHUTDOWN_GRACE_MS for the worker pool. Read the header of run_worker.tf before changing it."
  type        = number

  # 7000, against a repo default of 45000, and this is the single most
  # consequential value in this directory. The whole argument is in
  # run_worker.tf; the short version is that Cloud Run's SIGTERM-to-SIGKILL
  # window is a fixed 10 seconds that no API field, and therefore no Terraform
  # argument, can lengthen — so a 45-second drain is not a long drain here, it
  # is a drain that never completes.
  default = 7000
}

variable "api_cpu" {
  description = "CPU limit for one API instance."
  type        = string
  default     = "1"
}

variable "api_memory" {
  description = "Memory limit for one API instance."
  type        = string

  # 1Gi and not 512Mi because BIB_MAX_UPLOAD_BYTES is 25 MB and
  # src/config/config.ts calls that "a MEMORY BUDGET, not a preference: the
  # whole file is held in memory to be hashed before it is written". Several
  # concurrent uploads plus the pdf-lib renderer's font subsetting is the
  # working set this has to hold.
  default = "1Gi"
}

variable "worker_cpu" {
  description = "CPU limit for one worker instance."
  type        = string
  default     = "1"
}

variable "worker_memory" {
  description = "Memory limit for one worker instance."
  type        = string
  default     = "1Gi"
}

variable "frontend_cpu" {
  description = "CPU limit for one frontend instance."
  type        = string
  default     = "1"
}

variable "frontend_memory" {
  description = "Memory limit for one frontend instance."
  type        = string
  default     = "512Mi"
}

# ── Application configuration that is not secret ─────────────────────────────

variable "log_level" {
  description = "BIB_LOG_LEVEL for the API, worker and migrate job."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: debug, info, warn, error — the values src/config/config.ts accepts for BIB_LOG_LEVEL."
  }
}

variable "storage_backend" {
  description = "BIB_STORAGE_BACKEND. Must be a value the zod enum in src/config/config.ts accepts — see the note in storage.tf."
  type        = string
  default     = "gcs"
}

variable "esign_provider" {
  description = "BIB_ESIGN_PROVIDER. Must be a value the zod enum in src/config/config.ts accepts — see the note in secrets.tf."
  type        = string
  default     = "docusign"
}

variable "mail_from" {
  description = "BIB_MAIL_FROM — the envelope and header From on every magic link and portal invite."
  type        = string
}

variable "mail_from_name" {
  description = "BIB_MAIL_FROM_NAME — the display name beside it. The firm's own name, since one server serves every tenant."
  type        = string
}

variable "smtp_host" {
  description = "BIB_SMTP_HOST. Plain SMTP: Google Workspace, Microsoft 365, SES and Postmark all speak it."
  type        = string
}

variable "smtp_port" {
  description = "BIB_SMTP_PORT. 587 is submission with STARTTLS; 465 is implicit TLS."
  type        = number
  default     = 587
}

variable "smtp_user" {
  description = "BIB_SMTP_USER. The password is a Secret Manager entry, never a variable."
  type        = string
}

variable "smtp_secure" {
  description = "BIB_SMTP_SECURE — implicit TLS from the first byte. True only for port 465."
  type        = bool
  default     = false
}

variable "docusign_account_id" {
  description = "The DocuSign account GUID envelopes are created under."
  type        = string
}

variable "docusign_oauth_base_uri" {
  description = "DocuSign OAuth host used for the JWT grant, e.g. https://account.docusign.com."
  type        = string
  default     = "https://account.docusign.com"
}

# ── Operations ───────────────────────────────────────────────────────────────

variable "alert_email" {
  description = "Where uptime and error alerts go. A distribution list, not a person — a channel that leaves when somebody does is a channel nobody notices going quiet."
  type        = string
}

variable "log_retention_days" {
  description = "Retention on the dedicated log bucket."
  type        = number

  # 30 days covers an incident review. It is deliberately NOT the retention of
  # the audit ledger, which is a Postgres table that is append-only by GRANT and
  # keeps every state transition forever. Logs are operational telemetry here,
  # not evidence, and conflating the two would make somebody think the ledger
  # expires.
  default = 30
}

variable "uptime_check_period" {
  description = "How often the uptime check runs, as a duration string."
  type        = string
  default     = "60s"
}

variable "db_availability_type" {
  description = "REGIONAL (production: survives a zone incident) or ZONAL (roughly half the cost; a zone incident takes the environment down)."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.db_availability_type)
    error_message = "db_availability_type must be REGIONAL or ZONAL."
  }
}

variable "run_deletion_protection" {
  description = "Cloud Run deletion protection. TRUE in production. FALSE in a throwaway environment, where a service that failed to create is TAINTED and cannot be replaced until this is off."
  type        = bool
  default     = true
}

variable "run_ingress" {
  description = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER when a load balancer fronts Cloud Run (the default, and the only safe value when one exists). INGRESS_TRAFFIC_ALL when serving directly on run.app URLs, where the LB-only setting leaves the service unreachable."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.run_ingress)
    error_message = "run_ingress must be one of INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER, INGRESS_TRAFFIC_INTERNAL_ONLY."
  }
}

variable "session_cookie_samesite" {
  description = "SameSite for the session cookie. Lax when the app and API share a registrable domain; None when they do not, which includes any two *.run.app services (a public suffix, so each is its own site)."
  type        = string
  default     = "Lax"

  validation {
    condition     = contains(["Lax", "None"], var.session_cookie_samesite)
    error_message = "session_cookie_samesite must be Lax or None."
  }
}
