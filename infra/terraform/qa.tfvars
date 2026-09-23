# bib-qa — the QA environment.
#
# Sized DELIBERATELY smaller than the defaults in variables.tf, which are
# production values. Every line below that differs from a default is a cost
# decision, not a preference, and each states what it gives up.

project_id  = "bib-qa"
alert_email = "me.anishumar@gmail.com"

# ── Sizing: QA ──────────────────────────────────────────────────────────────
# ZONAL halves the largest line on the bill. What it gives up is argued at
# length in sql.tf: a zone incident does not degrade this environment, it takes
# it down until the zone returns, because the boot check fails and Cloud Run
# restarts the containers forever. Acceptable here, never in production.
db_availability_type = "ZONAL"
db_tier              = "db-custom-1-3840"

# Scale to zero when nobody is using it. The worker CANNOT — its cron lives in
# the process, so instance count 1 is a correctness floor, not a capacity one.
api_min_instances      = 0
frontend_min_instances = 0
worker_instance_count  = 1

# ── Mail: Gmail SMTP ────────────────────────────────────────────────────────
# Port 587 is STARTTLS, so smtp_secure is FALSE and the connection is still
# encrypted — nodemailer upgrades it. `true` means implicit TLS from the first
# byte, which is port 465 only.
#
# mail_from is the BARE address: BIB_MAIL_FROM is validated with zod's .email()
# and rejects the "Name <addr>" form. The display name is its own variable, and
# it is the PRODUCT's name rather than any firm's — one server serves every
# tenant, and each letter names the firm in its own text.
smtp_host      = "smtp.gmail.com"
smtp_port      = 587
smtp_secure    = false
smtp_user      = "anishumar786@gmail.com"
mail_from      = "anishumar786@gmail.com"
mail_from_name = "10xcrm"

# The password is NOT here. It is a Secret Manager version (bib-smtp-password),
# written with gcloud after the apply — this file is committed.

# DocuSign's DEVELOPER account (0080): letters are sent and signed for real,
# on DocuSign's demo platform (envelopes are stamped "demonstration document").
# The integration key, user id and RSA key are Secret Manager versions, written
# with gcloud — never here. An integration key works against exactly one OAuth
# host, so a demo key needs account-d.
docusign_account_id     = "fc0bd293-3898-4778-97ef-883d89a79960"
docusign_oauth_base_uri = "https://account-d.docusign.com"

# A tainted Cloud Run resource cannot be replaced while this is on, and in a QA
# environment a failed revision is something to recreate, not to protect.
run_deletion_protection = false

# lb.tf is disabled, so the LB-only default would make both services
# unreachable: Ready, allUsers granted, and every request answered by Google's
# 404 before it reaches the container.
run_ingress = "INGRESS_TRAFFIC_ALL"

# The app and the API are two separate *.run.app services, and *.run.app is on
# the Public Suffix List — so they are different SITES and a Lax cookie is never
# sent. Symptom: login returns 200 with a Set-Cookie, and the very next request
# is UNAUTHORIZED. Origin guard still covers CSRF (src/api/origin.ts).
session_cookie_samesite = "None"
