# The VPC, the subnet Cloud Run attaches to, and the peering Cloud SQL's private
# IP is built on.
#
# There is exactly one reason this network exists: the database must not have a
# public IP. Everything here is in service of that, and if Cloud SQL were
# reachable over the internet none of this file would be needed.

resource "google_compute_network" "bib" {
  name    = "bib-${local.env}"
  project = var.project_id

  # No automatic subnets. The auto mode creates a subnet in every region Google
  # has, each with a range this configuration did not choose, which is a large
  # amount of address space allocated on our behalf and a large amount of
  # surface nobody is looking at. One region, one subnet, both written down.
  auto_create_subnetworks = false

  # Regional routing: this deployment is one region by decision, and global
  # routing buys cross-region reachability that nothing here has.
  routing_mode = "REGIONAL"

  depends_on = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "run" {
  name          = "bib-run-${local.env}"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.bib.id
  ip_cidr_range = var.run_subnet_cidr

  # Cloud Run instances attached here reach Google APIs — Secret Manager on the
  # way up, Cloud Storage for every blob the document store writes — and with
  # egress set to PRIVATE_RANGES_ONLY that traffic must resolve inside the VPC.
  # Private Google Access is what makes it resolve without a public address.
  private_ip_google_access = true

  # Flow logs are off deliberately rather than by omission. This subnet carries
  # application traffic to one database and one object store; the answers flow
  # logs give — who talked to whom, how much — are answers Cloud Run's own
  # request logs and Cloud SQL's insights already give with more context, and
  # the logs are billed per gigabyte ingested.
}

# ── Private services access ──────────────────────────────────────────────────
#
# Cloud SQL with a private IP does not sit in our subnet. Google runs the
# instance in a project of its own and peers that project's network into ours;
# the address the instance answers on is allocated from a range WE reserve and
# hand over. That is what these two resources are, and the order is not
# negotiable: the range must exist before the connection, and the connection
# before any instance that asks for a private address.

resource "google_compute_global_address" "private_services" {
  name          = "bib-private-services-${local.env}"
  project       = var.project_id
  network       = google_compute_network.bib.id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_services_prefix_length
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.bib.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  # ABANDON on destroy, which sounds careless and is the safe answer. Deleting
  # a service networking connection while a Cloud SQL instance still hangs off
  # it leaves the apply stuck on a peering that cannot be removed, and the
  # recovery involves support. The instance itself carries deletion protection
  # in two places (sql.tf), so a `destroy` that reaches this resource is already
  # a destroy that was meant.
  deletion_policy = "ABANDON"

  # If a previous attempt left a half-created peering behind — the common
  # outcome of an apply interrupted at exactly this resource — retry over it
  # rather than failing every subsequent apply forever.
  update_on_creation_fail = true

  depends_on = [google_project_service.enabled]
}

# ── What is deliberately NOT here: Cloud NAT ─────────────────────────────────
#
# There is no Cloud Router and no Cloud NAT in this file, and that follows from
# the egress setting every workload uses: PRIVATE_RANGES_ONLY. Under it, only
# RFC1918 traffic is routed through this VPC — the Cloud SQL peering range and
# nothing else. Everything public the product talks to (the SMTP relay, the
# DocuSign API) leaves by Cloud Run's own internet path, which does not touch
# this network at all. A NAT gateway would therefore be a billed resource with
# no traffic behind it.
#
# THE CONSEQUENCE, STATED SO THAT NOBODY DISCOVERS IT AT 3AM: switching any
# workload's egress to ALL_TRAFFIC without adding a Cloud Router and a Cloud NAT
# first takes away every outbound connection to the internet. Portal invites
# stop arriving, engagement letters stop reaching DocuSign, and the API goes on
# answering 200 to everything else — so the failure looks like a mail problem,
# not a network one.
