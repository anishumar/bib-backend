# The frontend — `next start` on Cloud Run.
#
# THIS SERVICE HOLDS NOTHING, and that is the design rather than an omission. It
# has a service account with no role bindings at all (iam.tf), no Secret Manager
# reference, no VPC attachment and no database access. Everything it needs to
# know is one public API origin, and that origin was baked into the image at
# build time.

# THE FRONTEND PIPELINE LANDED, so this block now matches the other three.
#
# It did not, briefly, and the consequence was exactly what the note that used
# to sit here predicted in reverse: bib-frontend/cloudbuild.yaml built and
# deployed the real image, then the next `terraform apply` — run to change an
# unrelated environment variable — read var.frontend_image, still at its
# placeholder default, and rolled the service back to Google's hello container.
# The deploy had "succeeded" twenty minutes earlier and the page said
# "It's running!" with a unicorn on it.
#
# That is the failure ignore_changes exists to prevent, and the reason it is
# worth stating twice: an image reverting is not reported as an error by the
# thing that reverted it.
resource "google_cloud_run_v2_service" "frontend" {
  name     = "bib-frontend"
  project  = var.project_id
  location = var.region

  ingress             = var.run_ingress
  deletion_protection = var.run_deletion_protection

  template {
    service_account = google_service_account.frontend.email

    scaling {
      min_instance_count = var.frontend_min_instances
      max_instance_count = var.frontend_max_instances
    }

    # NO vpc_access block. The browser talks to the API directly — CORS with
    # credentials, exactly as bib-frontend/next.config.ts describes, with "no
    # dev-only rewrite proxying /api to the backend" precisely so that the rules
    # exercised locally are the rules that apply here. This server therefore
    # never calls the API itself and has nothing to reach inside the VPC.

    containers {
      image = var.frontend_image

      ports {
        # 3000, AND THIS IS NOT THE CLOUD RUN DEFAULT. bib-frontend/package.json
        # starts the server with `next start -p 3000`, and an explicit -p wins
        # over the PORT variable Cloud Run injects. So the container listens on
        # 3000 whatever Cloud Run asks for, and the port declared here has to
        # agree with the flag rather than with the platform. Changing one
        # without the other produces a revision that never passes its start-up
        # check, and the error names a port rather than a package.json.
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = var.frontend_cpu
          memory = var.frontend_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  # ── NEXT_PUBLIC_API_BASE_URL IS NOT HERE, AND CANNOT BE ─────────────────────
  #
  # It is a NEXT_PUBLIC_ variable, which Next inlines into the client bundle at
  # BUILD time, and bib-frontend/next.config.ts additionally reads it to compile
  # the Content-Security-Policy's connect-src. Setting it as a runtime
  # environment variable on this service would change nothing about the
  # JavaScript the browser downloads, and would leave somebody looking at a
  # correct-looking configuration wondering why every API call is blocked by
  # CSP. It is a build argument, and outputs.tf prints the value the image must
  # be built with.

  depends_on = [google_project_service.enabled]

  # Terraform sets the image once, at create; bib-frontend/cloudbuild.yaml owns
  # it from then on. Same path as a Service elsewhere in this config — one
  # `template`, not the Job's two.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "frontend_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.frontend.location
  name     = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
