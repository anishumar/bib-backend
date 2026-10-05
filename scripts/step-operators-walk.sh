#!/usr/bin/env bash
# The four operators, against a real job walking a real published process.
#
# The client is an INDIAN entity, so:
#   in    ["IN","AE"]  -> KEPT
#   not_in["IN"]       -> SKIPPED
#   not_equals "IN"    -> SKIPPED
#   equals "AE"        -> SKIPPED
#   equals "IN"        -> KEPT
# and one step naming a fact the service never states, which must be KEPT.
set -euo pipefail
API=http://localhost:8080
H='content-type: application/json'
KEY=local-dev-internal-key-not-for-any-real-environment
A="authorization: Bearer $KEY"
PW='10x Global demo 2026'
S=$(date +%s)
J=$(mktemp -d); trap 'rm -rf "$J"' EXIT
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$J/body"; }
call() { local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then curl -s -b "$J/p.txt" -c "$J/p.txt" -o "$J/body" -w '%{http_code}' -X "$m" "$API$p" -H "$H" -d "$b" > "$J/st"
  else curl -s -b "$J/p.txt" -c "$J/p.txt" -o "$J/body" -w '%{http_code}' -X "$m" "$API$p" > "$J/st"; fi
  cat "$J/st"; }

TEN=$(curl -s -XPOST "$API/internal/v1/tenants" -H "$H" -H "$A" -d "{\"name\":\"Ops\",\"slug\":\"ops-$S\",\"reportingCurrency\":\"INR\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
U=$(curl -s -XPOST "$API/internal/v1/users" -H "$H" -H "$A" -d "{\"email\":\"ops-$S@example.com\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -XPUT "$API/internal/v1/users/$U/password" -H "$H" -H "$A" -d "{\"password\":\"$PW\"}"
curl -s -o /dev/null -XPOST "$API/internal/v1/memberships" -H "$H" -H "$A" -d "{\"tenantId\":\"$TEN\",\"userId\":\"$U\",\"audience\":\"STAFF\",\"role\":\"partner\",\"commercialVisibility\":true}"
curl -s -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" -d "{\"email\":\"ops-$S@example.com\",\"password\":\"$PW\"}"
curl -s -b "$J/p.txt" -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"

echo "-- publishing a process using all four operators, plus the legacy shape --"
call POST /api/v1/config/workflow_template '{"key":"ops","body":{"label":"Operators","steps":[
 {"key":"always","label":"Always","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":null},
 {"key":"eq_in","label":"equals IN","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","op":"equals","value":"IN"},"verificationPolicyKey":null},
 {"key":"eq_ae","label":"equals AE","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","op":"equals","value":"AE"},"verificationPolicyKey":null},
 {"key":"ne_in","label":"not_equals IN","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","op":"not_equals","value":"IN"},"verificationPolicyKey":null},
 {"key":"in_list","label":"in IN,AE","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","op":"in","value":["IN","AE"]},"verificationPolicyKey":null},
 {"key":"notin_list","label":"not_in IN","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","op":"not_in","value":["IN"]},"verificationPolicyKey":null},
 {"key":"legacy","label":"legacy equals IN","executor":"human","dependsOn":[],"condition":{"fact":"jurisdiction","equals":"IN"},"verificationPolicyKey":null}]}}'
echo " <- define"
call POST /api/v1/config/workflow_template/ops/versions/1/publish ""; echo " <- publish"

call POST /api/v1/config/service '{"key":"s","body":{"name":"S","billingBasis":"fixed","jurisdictions":["IN"],"listPrice":{"amount":"1000.00","currency":"INR"},"recurrence":"monthly","workflowTemplateKey":"ops","slaDays":null}}' >/dev/null
call POST /api/v1/config/service/s/versions/1/publish ""; echo " <- service"
SVCV=$(jget 'd["id"]')

call POST /api/v1/parties/organizations '{"legalName":"Bharat Steel Private Limited","jurisdiction":"IN","entityType":"private_limited"}' >/dev/null
CLIENT=$(jget 'd["partyId"]')
TODAY=$(python3 -c 'import datetime;print(datetime.date.today().isoformat())')
call POST /api/v1/engagement-letters "{\"partyId\":\"$CLIENT\",\"jurisdiction\":\"IN\",\"title\":\"T\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}" >/dev/null
EL=$(jget 'd["id"]')
call POST "/api/v1/engagement-letters/$EL/lines" "{\"entityPartyId\":\"$CLIENT\",\"serviceVersionId\":\"$SVCV\",\"description\":\"S\",\"quantity\":\"1\",\"unitAmount\":\"1000\",\"discountPercent\":\"0\"}" >/dev/null
call POST /api/v1/config/clause '{"key":"c","body":{"title":"Scope","text":"Scope.","jurisdictions":["IN"]}}' >/dev/null
call POST /api/v1/config/clause/c/versions/1/publish "" >/dev/null
CV=$(jget 'd["id"]')
call POST "/api/v1/engagement-letters/$EL/clauses" "{\"clauseVersionId\":\"$CV\"}" >/dev/null
call POST "/api/v1/engagement-letters/$EL/send" "" >/dev/null
call POST "/api/v1/engagement-letters/$EL/signature" '{"signedByName":"R","reference":"p1"}'; echo " <- signed"
npm --prefix "$BACKEND" run worker:once >/dev/null 2>&1 || true

call GET /api/v1/jobs "" >/dev/null
JOB=$(jget 'd["jobs"][0]["id"]')
call GET "/api/v1/jobs/$JOB/steps" "" >/dev/null
echo
echo "-- the entity is IN. what the engine did: --"
python3 -c "
import sys,json
d=json.load(sys.stdin)
want={'always':'not skipped','eq_in':'not skipped','eq_ae':'skipped','ne_in':'skipped',
      'in_list':'not skipped','notin_list':'skipped','legacy':'not skipped'}
bad=0
for s in d['steps']:
    got='skipped' if s['status']=='skipped' else 'not skipped'
    exp=want.get(s['stepKey'],'?')
    ok='ok ' if got==exp else 'BAD'
    if got!=exp: bad+=1
    print('  [%s] %-12s %-11s  %s' % (ok, s['stepKey'], got, (s['outcomeNote'] or '')[:74]))
print()
print('  ALL AS EXPECTED' if bad==0 else '  %d WRONG' % bad)
" < "$J/body"
