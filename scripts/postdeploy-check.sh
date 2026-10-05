#!/usr/bin/env bash
# THE CHECK TO RUN AFTER A DEPLOY. It only READS (F-18-6, S7, 2026-10-05).
#
#   API=https://bib-api-xxxx.run.app WEB=https://bib-web-xxxx.run.app \
#     COMMIT=<sha you deployed> bash scripts/postdeploy-check.sh
#
# The runbook used to say "run npm run smoke against the deployed API". Smoke
# provisions throwaway firms and sets a known password on every person it
# creates, and nothing deletes a firm: each run left a live firm with public
# credentials on QA (audit 2026-09-23, F-18-6). Smoke is for a local or a
# throwaway database. This script makes no write: it asks the deployed API
# whether it is up, which build it is, whether the wall refuses a stranger,
# and whether the frontend's origin may call it.
set -u
API=${API:?set API to the deployed API, e.g. https://bib-api-xxxx.run.app}
WEB=${WEB:-}
COMMIT=${COMMIT:-}
ok=0; bad=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; ok=$((ok+1));
  else printf "  \033[31m✗\033[0m %-48s got %s, expected %s\n" "$1" "$3" "$2"; bad=$((bad+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "── Read-only checks against $API"
HEALTH=$(curl -s "$API/health")
chk "/health answers ok" ok "$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))' <<< "$HEALTH" 2>/dev/null)"
LIVE=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit") or "")' <<< "$HEALTH" 2>/dev/null)
if [ -n "$COMMIT" ]; then
  chk "the build is the one deployed" "${COMMIT:0:7}" "${LIVE:0:7}"
else
  printf "  · live build: %s (pass COMMIT= to check it)\n" "${LIVE:-not reported}"
fi
chk "/ready answers" 200 "$(code "$API/ready")"
chk "a stranger is refused (401)" 401 "$(code "$API/api/v1/parties")"
chk "a stranger cannot read the ledger" 401 "$(code "$API/api/v1/events")"
chk "provisioning wants its key" 401 "$(code -XPOST "$API/internal/v1/tenants" -H 'content-type: application/json' -d '{}')"
if [ -n "$WEB" ]; then
  ALLOW=$(curl -s -o /dev/null -D - -XOPTIONS "$API/api/v1/auth/me" \
    -H "Origin: $WEB" -H 'Access-Control-Request-Method: GET' \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin" {print $2}')
  chk "the frontend's origin may call the API (CORS)" "$WEB" "$ALLOW"
  chk "the frontend answers" 200 "$(code -L "$WEB/login")"
else
  printf "  · pass WEB= to check the frontend and CORS\n"
fi
echo
printf "  %s passed, %s failed (nothing was written)\n" "$ok" "$bad"
[ "$bad" -eq 0 ]
