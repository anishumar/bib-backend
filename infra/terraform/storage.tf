# The blob bucket — where uploaded and rendered bytes live.
#
# src/infrastructure/storage/filesystem-blob-store.ts states the problem this
# bucket solves, in its own header, better than a comment here could: the
# filesystem adapter "is per-POD, not per-product. Two replicas do not share a
# filesystem, so a file uploaded through one is a 500 through the other" — and
# "a container filesystem does not survive a restart. The metadata would outlive
# the bytes, and the product would list documents it cannot open". Cloud Run
# runs several instances by definition and replaces them without warning, so
# both failures are certainties here rather than risks.

resource "google_storage_bucket" "blobs" {
  name     = "${var.project_id}-bib-blobs"
  project  = var.project_id
  location = var.region

  # UNIFORM, never per-object ACLs. With ACLs switched on, a single object can
  # carry a grant that the bucket's IAM policy says nothing about — so "who can
  # read this firm's documents" stops being answerable by reading one policy and
  # becomes a question you can only answer by walking every object. The document
  # store's whole position is that bytes leave by ONE route (CLAUDE.md: "there
  # is no pre-signed URL"), and that claim is not checkable under per-object
  # ACLs.
  uniform_bucket_level_access = true

  # Belt and braces on top of it: even an IAM binding that named allUsers or
  # allAuthenticatedUsers would be refused.
  public_access_prevention = "enforced"

  versioning {
    # Versioning exists here for one specific failure, and it is worth naming
    # because storage is CONTENT-ADDRESSED and so an overwrite is normally
    # harmless: the key derives from the sha256, so re-storing a file writes
    # identical bytes. What versioning protects against is the abnormal case —
    # a deletion or a truncation by something that should not have been writing
    # at all. CLAUDE.md is explicit that "nothing may delete bytes because one
    # document went away", since two documents can share a blob; this is that
    # rule with a recovery path behind it.
    enabled = true
  }

  lifecycle_rule {
    # Noncurrent versions are the recovery window, not an archive. Thirty days
    # is long enough to notice and undo; keeping them forever would mean the
    # bucket grows with every overwrite of bytes that were identical anyway.
    condition {
      num_newer_versions = 1
      age                = 30
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    # Abort multipart uploads nobody finished. Without this, an upload that
    # drops halfway leaves fragments that are billed and that no object listing
    # shows, so the bill is the only place they appear.
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  # NEVER force_destroy. A `terraform destroy` against a bucket holding a firm's
  # signed engagement letters should fail loudly and leave the bucket standing.
  force_destroy = false

  # No CORS configuration, deliberately. The browser never talks to this bucket:
  # bytes are served by the API, from one route, after the version row naming
  # the storage key has been read under RLS. A CORS rule here would be the first
  # half of a pre-signed-URL design that CLAUDE.md refuses — "the port has no
  # method that returns a URL, and adding one is the thing not to do".

  depends_on = [google_project_service.enabled]
}

# ── The variable this bucket is useless without ──────────────────────────────
#
# BIB_GCS_BUCKET is a NEW environment variable this deployment introduces,
# and it is the GCS counterpart of the existing BIB_STORAGE_ROOT. run_api.tf and
# run_worker.tf both set it to the bucket created above.
#
# Both halves now exist. config.ts reads
# `BIB_STORAGE_BACKEND: z.enum(["filesystem", "gcs"])` and setup/server.ts
# chooses through `blobStoreFor(cfg)`, so `storage_backend = "gcs"` is accepted
# at load() and builds a real GCS store.
#
# The bucket is checked where the store is CONSTRUCTED rather than in
# validateServer, and that asymmetry is deliberate: the worker runs the same
# gate and must name a non-stub backend to boot, but setup/worker.ts builds no
# blob store at all. Demanding a bucket of it would hand the worker a
# dependency it never uses.
#
# That is reported rather than worked around. Relaxing the gate to get a box up
# would put a product that loses uploaded documents on the internet.
