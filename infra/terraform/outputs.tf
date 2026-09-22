# What an operator needs after an apply, and nothing they do not.
#
# No output here is a secret or resolves to one. An output is written to the
# state file and printed by `terraform output` without a password prompt, so a
# database URL or a key belongs in Secret Manager and is named here only by the
# secret it lives in.

# No load_balancer_ip or dns_records_required while lb.tf is disabled: there is
# no global address to report and no A record to create. Both come back with the
# load balancer, together with the domains they describe.

output "api_url" {
  description = "The API's run.app URL. This is what BIB_CORS_ORIGINS is checked against and what the frontend image must be built with."
  value       = google_cloud_run_v2_service.api.uri
}

output "frontend_url" {
  description = "The frontend's run.app URL. Open this to reach the product."
  value       = google_cloud_run_v2_service.frontend.uri
}

output "frontend_build_arg" {
  description = "NEXT_PUBLIC_API_BASE_URL. A BUILD argument, not a runtime variable — see the note at the foot of run_frontend.tf."
  value       = local.api_origin
}

output "api_cors_origin" {
  description = "The single value in BIB_CORS_ORIGINS. It must equal the origin the frontend is actually served from, exactly."
  value       = local.app_origin
}

output "artifact_registry_repository" {
  description = "Docker repository to push the four images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.bib.repository_id}"
}

output "sql_instance_connection_name" {
  description = "Cloud SQL connection name, for gcloud sql connect and for anything that ever moves to the Auth Proxy."
  value       = google_sql_database_instance.bib.connection_name
}

output "sql_private_ip" {
  description = "The private address the three database URLs must point at. It is RFC1918, so validateServer's localhost check passes — it only rejects localhost, 127.0.0.1 and ::1."
  value       = google_sql_database_instance.bib.private_ip_address
}

output "blob_bucket" {
  description = "The value of BIB_GCS_BUCKET on the API and worker."
  value       = google_storage_bucket.blobs.name
}

output "service_accounts" {
  description = "The four workload identities, one per deployable."
  value = {
    api      = google_service_account.api.email
    worker   = google_service_account.worker.email
    migrate  = google_service_account.migrate.email
    frontend = google_service_account.frontend.email
  }
}

output "secrets_awaiting_a_version" {
  description = "Every secret this configuration creates. All of them are EMPTY after an apply — Terraform creates containers, never payloads — and every workload referencing one fails to start until a version exists."
  value       = sort([for k, s in local.secrets : s.id])
}

output "migrate_job" {
  description = "The job the deploy pipeline executes between pushing images and updating the services."
  value       = google_cloud_run_v2_job.migrate.name
}

output "cloud_run_urls" {
  description = "The generated run.app URLs. Both services have ingress restricted to the load balancer, so these do NOT answer — they are here for gcloud and console navigation, not for use."
  value = {
    api      = google_cloud_run_v2_service.api.uri
    frontend = google_cloud_run_v2_service.frontend.uri
  }
}
