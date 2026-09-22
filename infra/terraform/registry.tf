# Artifact Registry — where the four images live.
#
# One repository, not one per workload. The backend's three deployables are
# built from ONE tsup build (dist/cmd/server.js, dist/cmd/worker.js,
# dist/cmd/migrate.js), so splitting them across repositories would either mean
# pushing the same layers three times or maintaining three build paths for one
# artifact. The frontend joins them because the access story is identical.

resource "google_artifact_registry_repository" "bib" {
  provider = google

  project       = var.project_id
  location      = var.region
  repository_id = "bib"
  description   = "Container images for the bib API, worker, migrate job and frontend."
  format        = "DOCKER"

  docker_config {
    # IMMUTABLE TAGS. Once :v41 names a digest it names that digest forever, so
    # a tag in a Cloud Run revision, in a deploy log or in an incident timeline
    # keeps meaning what it meant. Without this, "we rolled back to :v41" is a
    # sentence with no verifiable content.
    immutable_tags = true
  }

  cleanup_policies {
    id     = "keep-recent-tagged"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state = "UNTAGGED"
      # Thirty days. An untagged image is normally a build that was superseded
      # before it was deployed, but it is occasionally the digest a Cloud Run
      # revision is still pinned to after its tag moved — so the window is long
      # enough that a rollback to last month's revision still finds its layers.
      older_than = "2592000s"
    }
  }

  # Not a dry run: the policies above actually delete. A cleanup policy left in
  # dry-run mode looks configured in the console, reports what it would have
  # done in logs nobody reads, and the repository grows anyway.
  cleanup_policy_dry_run = false

  labels = local.labels

  depends_on = [google_project_service.enabled]
}
