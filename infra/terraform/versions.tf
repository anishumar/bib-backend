# Terraform, the providers, and where the state lives.
#
# THE STATE BUCKET IS NOT MANAGED BY THIS CONFIGURATION, and that is not an
# oversight. A bucket that holds the state file cannot be created by the
# configuration whose state it holds: the first `terraform init` needs the
# bucket to already exist, and a later `terraform destroy` would try to delete
# the bucket out from under the state it is writing. So it is two gcloud
# commands in README.md, run once, by hand, and everything after that is
# Terraform's.
#
# The bucket NAME is deliberately absent from this block. A `backend` block
# cannot interpolate a variable — that is a Terraform restriction, not a style
# choice — so the alternative is a project-specific literal committed to a repo
# that is not project-specific. It arrives through `-backend-config` instead;
# backend.hcl.example is the file to copy.
terraform {
  required_version = ">= 1.9.0"

  backend "gcs" {
    # bucket = supplied by -backend-config (see backend.hcl.example)
    prefix = "bib/production"
  }

  required_providers {
    google = {
      source = "hashicorp/google"
      # Floor rather than a pin. The floor is real: Cloud Run WORKER POOLS
      # (google_cloud_run_v2_worker_pool, which run_worker.tf depends on
      # entirely) only reached GA in the 7.x line, so an older provider fails
      # with "invalid resource type" rather than with anything that explains
      # itself. The ceiling is the next major, because a Google provider major
      # moves required arguments.
      version = ">= 7.0.0, < 8.0.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.0.0, < 8.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = local.labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  default_labels = local.labels
}

locals {
  # One environment, said once. The repo's boot gate treats production, uat and
  # qa identically (isProductionLike in src/config/config.ts), and the decision
  # on this deployment is that only the first of the three will ever exist — so
  # there is no workspace, no per-environment module and no environment
  # variable here. If a second environment is ever wanted, it is a second state
  # file and a second tfvars, not a `count` on every resource in this directory.
  env = "production"

  labels = {
    app         = "bib"
    environment = local.env
    managed_by  = "terraform"
  }

  # The two public origins, derived once. Everything downstream — the API's
  # BIB_CORS_ORIGINS, its BIB_APP_BASE_URL and the uptime check — reads these
  # rather than re-assembling a scheme and a host, because a mismatch between
  # any two of them is a browser-side failure with no server-side log.
  #
  # RUN.APP URLS, NOT CUSTOM DOMAINS. lb.tf is disabled (see lb.tf.disabled):
  # there is no domain yet, and a managed certificate for a name we do not own
  # never validates — it would sit in PROVISIONING forever while the uptime
  # check alerted on a host that does not resolve.
  #
  # Cloud Run mints these at create, so they are known-after-apply rather than
  # inputs. The dependency runs one way: the API reads the frontend's URI for
  # CORS, and the frontend reads nothing from the API (its API base URL is baked
  # into the image at build time), so there is no cycle.
  api_origin = google_cloud_run_v2_service.api.uri
  app_origin = google_cloud_run_v2_service.frontend.uri
}
