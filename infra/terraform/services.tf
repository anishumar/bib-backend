# The project APIs everything below depends on.
#
# Enabling an API is not idempotent in the way it looks: a resource created
# against a disabled API fails with a message about the API rather than about
# the resource, and the failure arrives partway through an apply that has
# already created other things. So these are declared first and depended on
# explicitly by the resources that need them, rather than left to luck about
# graph ordering.
locals {
  project_services = [
    "artifactregistry.googleapis.com",     # the docker repository images are pushed to
    "cloudresourcemanager.googleapis.com", # project-level IAM bindings
    "compute.googleapis.com",              # VPC, subnet, load balancer, addresses
    "iam.googleapis.com",                  # the four workload service accounts
    "logging.googleapis.com",              # the log bucket and sink
    "monitoring.googleapis.com",           # uptime check, alert policies, notification channel
    "run.googleapis.com",                  # three services, one worker pool, one job
    "secretmanager.googleapis.com",        # every credential the boot gate demands
    "servicenetworking.googleapis.com",    # private services access, which Cloud SQL private IP is built on
    "sqladmin.googleapis.com",             # the Postgres instance
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.project_services)

  project = var.project_id
  service = each.value

  # NEVER disable on destroy, and this is the setting most worth arguing about
  # in this file. A project API is project-wide, not Terraform-wide: disabling
  # compute.googleapis.com on a `terraform destroy` would take down anything
  # else in the project that happens to use Compute Engine, including resources
  # this configuration has never heard of. Worse, disabling an API can DELETE
  # the resources behind it. The cost of leaving an API enabled on a project
  # nobody uses any more is zero.
  disable_on_destroy = false

  # Same reasoning one step earlier: Terraform must not go hunting for
  # dependent services to disable on our behalf.
  disable_dependent_services = false
}
