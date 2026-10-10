#!/usr/bin/env bash
# OPEN A DEPLOYED DATABASE FROM A LAPTOP, through the Cloud SQL Auth Proxy.
# The step-by-step for a new developer is qa-database-access.md in the
# bib-docs repo (github.com/anishumar/bib-docs).
#
#   npm run db:qa                      # = bash scripts/db.sh connect qa
#
# Opens a tunnel on 127.0.0.1:5433 (BIB_DB_PORT to change it) and keeps it open
# until Ctrl+C. You log in as your own Google account: no password, the proxy
# fetches a token that lives an hour. Point pgAdmin (or psql) at it with the
# settings this prints. One-time setup per laptop:
# gcloud auth application-default login.
#
# Who may connect, and whether they may read or write, is set by an admin in
# the Cloud console (see the admin section of that guide), not in this repo.
set -euo pipefail

usage() { echo "usage: bash scripts/db.sh connect <env>   (env: qa)" >&2; exit 2; }
[ $# -eq 2 ] && [ "$1" = connect ] || usage
env=$2

case "$env" in
  qa) project=bib-qa ;;
  *) echo "Unknown environment '$env'. Known: qa." >&2; exit 2 ;;
esac
# The instance is named bib-production in every project (Terraform's local.env).
instance="$project:asia-south1:bib-production"

gcloud=$(command -v gcloud || echo "$HOME/google-cloud-sdk/bin/gcloud")
[ -x "$gcloud" ] || { echo "gcloud is not installed: https://cloud.google.com/sdk/docs/install" >&2; exit 1; }
command -v cloud-sql-proxy >/dev/null || {
  echo "cloud-sql-proxy is not installed. One of:" >&2
  echo "  brew install cloud-sql-proxy" >&2
  echo "  gcloud components install cloud-sql-proxy" >&2
  exit 1
}
account=$("$gcloud" config get account 2>/dev/null || true)
[ -n "$account" ] && "$gcloud" auth print-access-token >/dev/null 2>&1 || {
  echo "Not signed in to Google Cloud. Run: gcloud auth login" >&2; exit 1
}
# IAM login needs Application Default Credentials: the proxy refuses
# --auto-iam-authn together with --gcloud-auth.
"$gcloud" auth application-default print-access-token >/dev/null 2>&1 || {
  echo "One-time setup missing. Run: gcloud auth application-default login" >&2
  echo "(sign in as $account), then npm run db:$env again." >&2
  exit 1
}

port=${BIB_DB_PORT:-5433}
cat <<EOF

  $env database on 127.0.0.1:$port  (Ctrl+C to close)

  pgAdmin → Register → Server
    Host      127.0.0.1
    Port      $port
    Database  bib
    Username  $account
    Password  leave empty (the proxy logs you in)
    SSL mode  disable (the proxy already encrypts)

  psql "host=127.0.0.1 port=$port dbname=bib user=$account sslmode=disable"

EOF
exec cloud-sql-proxy "$instance" --port "$port" --auto-iam-authn
