#!/usr/bin/env bash
#
# Destroy the local database and rebuild 10x Global from nothing.
#
#   npm run demo:fresh
#
# ── WHY THIS EXISTS AS ONE COMMAND ───────────────────────────────────────────
#
# `demo-seed.sh` uses FIXED logins — `siddharth@10xglobal.in` — because a demo
# where somebody has to read `siddharth-1788079646@10xglobal.example` off a
# terminal is a demo that stalls at the login screen. Fixed addresses are only
# safe on a database that does not already hold them, so the seed refuses to run
# twice and this is the way back.
#
# IT DESTROYS THE VOLUME. Everything in the local database goes: every firm,
# every login, every invoice, every row that smoke or a walk left behind. That
# is the point of it — the alternative is a database that grows a firm per run
# until nobody can tell which one the demo is in.
#
# It does NOT touch the API server. postgres.js reconnects on its own once the
# container is back and the roles exist again, so a `npm run dev` in another
# terminal carries on. If it does not, restart it — the boot check runs only at
# startup and a server that came up against the old database has nothing to say
# about the new one.
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
BACKEND=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$BACKEND/.." && pwd)   # the workspace holding docker-compose.yml
API=${API:-http://localhost:8080}

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Destroying the database volume"
(cd "$ROOT" && docker compose down -v)
# A container left over from an earlier compose project name holds the name and
# blocks the recreate, with an error that reads like Docker is broken. Removing
# it is safe: the volume is already gone, so there is nothing in it to lose.
docker rm -f bib-postgres > /dev/null 2>&1 || true
# `--wait` blocks on the compose healthcheck rather than on a sleep loop of our
# own. The container answers TCP well before Postgres will accept a connection,
# so "is the port open" is the wrong question and was the one that made this
# fall through to a migrate that could not connect.
(cd "$ROOT" && docker compose up -d --wait)
docker exec bib-postgres pg_isready -U postgres -d bib

say "Applying migrations"
(cd "$BACKEND" && npm run migrate --silent)

say "Waiting for the API to reconnect"
# The server holds a pool against a database that has just been replaced. It
# reconnects on its own — this only waits for it, and says so plainly if it
# does not, because "seed failed" is a confusing way to learn the server needs
# a restart.
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ]; then break; fi
  curl -s -o /dev/null --max-time 1 "$API/health" || true
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" != "200" ]; then
  cat <<EOF

  The API is not answering on $API.

  Start it, or restart it if it was already running — it was holding a pool
  against the database this script has just replaced:

      cd bib-backend && npm run dev

  Then:  npm run demo

EOF
  exit 1
fi

exec bash "$HERE/demo-seed.sh"
