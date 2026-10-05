#!/usr/bin/env bash
#
# T2.9 end to end, through the real API, on a firm this script creates.
#
# The whole point is to reach a CHECK by the product's own path — a signed
# engagement letter with its advance recorded spawns a job, the job walks the
# firm's published process, and a step that names a verification rule stops
# instead of finishing. Then the two refusals that matter are exercised as real
# HTTP: the maker approving their own work, and somebody below the firm's bar.
#
# It prints the logins and the job ids at the end, and leaves ONE check open, so
# the screens have something to show and can be opened as three different people.
#
#   BACKEND=. ./scripts/verification-walk.sh     # against a running API on :8080
#
# Not part of `npm run smoke`: that walk is at its request budget, which is why
# T2.7's engine and T3.5's ladder are demonstrated the same way. This is the
# scripted equivalent for the verification queue.
set -euo pipefail

API=${API:-http://localhost:8080}
H='content-type: application/json'
KEY=${BIB_DEMO_KEY:-local-dev-internal-key-not-for-any-real-environment}
A="authorization: Bearer $KEY"
PW='10x Global demo 2026'

S=$(date +%s)
J=$(mktemp -d)
trap 'rm -rf "$J"' EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '  · %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %-52s %s\n' "$1" "${2:-}"; }
bad()  { printf '  \033[31m✗\033[0m %-52s %s\n' "$1" "${2:-}"; FAILED=1; }
FAILED=0

# Assert an HTTP status, printing the body when it is not what we expected —
# a bare "expected 200 got 409" is how you end up guessing.
expect() { # expect <what> <want> <file-with-status-last-line>
  local want="$2" got; got=$(tail -1 "$3")
  if [ "$got" = "$want" ]; then ok "$1" "$got"; else bad "$1" "want $want got $got"; head -c 400 "$3"; echo; fi
}

call() { # call <cookiejar> <method> <path> [body] -> writes $J/out (body + status line)
  local jar="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -b "$jar" -c "$jar" -o "$J/body" -w '%{http_code}' -X "$method" "$API$path" -H "$H" -d "$body" > "$J/status"
  else
    curl -s -b "$jar" -c "$jar" -o "$J/body" -w '%{http_code}' -X "$method" "$API$path" > "$J/status"
  fi
  cat "$J/body" > "$J/out"; echo >> "$J/out"; cat "$J/status" >> "$J/out"
}

# Through STDIN, never by path: python3 here is the Windows interpreter and it
# cannot open a Git Bash /tmp path.
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$J/body"; }

say "1. A firm, and three people at three levels"
SLUG="t29-$S"
TEN=$(curl -s -XPOST "$API/internal/v1/tenants" -H "$H" -H "$A" \
  -d "{\"name\":\"T2.9 Test LLP\",\"slug\":\"$SLUG\",\"reportingCurrency\":\"INR\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
step "tenant $TEN"

# THE PARTNER comes in through the platform's own surface — somebody has to
# exist before anybody can be invited. The other two come in through the ROSTER,
# which is how a firm actually adds people and is the only route that takes a
# display NAME. The internal route takes an email and nothing else.
PARTNER_E="partner-$S@example.com"; MANAGER_E="manager-$S@example.com"; ASSOC_E="assoc-$S@example.com"

PARTNER=$(curl -s -XPOST "$API/internal/v1/users" -H "$H" -H "$A"   -d "{\"email\":\"$PARTNER_E\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -XPUT "$API/internal/v1/users/$PARTNER/password" -H "$H" -H "$A" -d "{\"password\":\"$PW\"}"
curl -s -o /dev/null -XPOST "$API/internal/v1/memberships" -H "$H" -H "$A"   -d "{\"tenantId\":\"$TEN\",\"userId\":\"$PARTNER\",\"audience\":\"STAFF\",\"role\":\"partner\",\"commercialVisibility\":true}"

login() { curl -s -c "$2" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H"   -d "{\"email\":\"$1\",\"password\":\"$PW\"}";
  curl -s -b "$2" -c "$2" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"; }
login "$PARTNER_E" "$J/p.txt"

invite() { # invite <email> <role> <name> -> user id
  call "$J/p.txt" POST "/api/v1/tenancy/members"     "{\"email\":\"$1\",\"audience\":\"STAFF\",\"role\":\"$2\",\"commercialVisibility\":true,\"displayName\":\"$3\"}"
  local uid; uid=$(jget 'd["userId"]')
  curl -s -o /dev/null -XPUT "$API/internal/v1/users/$uid/password" -H "$H" -H "$A" -d "{\"password\":\"$PW\"}"
  echo "$uid"
}
MANAGER=$(invite "$MANAGER_E" manager "Anand Rao")
ASSOC=$(invite "$ASSOC_E" associate "Priya Nair")
step "partner, manager and associate on the roster"

login "$MANAGER_E" "$J/m.txt"
login "$ASSOC_E"   "$J/a.txt"
ok "three sessions, org selected"

say "2. Grades and the reporting line — the two facts the rules compare"
GRADES=$(curl -s -b "$J/p.txt" "$API/api/v1/tenancy/grades")
gid() { echo "$GRADES" | python3 -c "import sys,json;print(next(g['id'] for g in json.load(sys.stdin)['grades'] if g['code']=='$1'))"; }
G_ASSOC=$(gid associate); G_MGR=$(gid manager); G_PARTNER=$(gid partner)

MEMBERS=$(curl -s -b "$J/p.txt" "$API/api/v1/tenancy/members")
mid() { echo "$MEMBERS" | python3 -c "import sys,json;print(next(m['membership']['id'] for m in json.load(sys.stdin)['members'] if m['membership']['userId']=='$1'))"; }
M_ASSOC=$(mid "$ASSOC"); M_MGR=$(mid "$MANAGER"); M_PARTNER=$(mid "$PARTNER")

setgrade() { call "$J/p.txt" PUT "/api/v1/tenancy/members/$1/grade" "{\"gradeId\":\"$2\"}"; }
setgrade "$M_ASSOC" "$G_ASSOC";   expect "Priya is an Associate (rank 3)" 200 "$J/out"
setgrade "$M_MGR" "$G_MGR";       expect "Anand is a Manager (rank 7)" 200 "$J/out"
setgrade "$M_PARTNER" "$G_PARTNER"; expect "Sidharth is a Partner (rank 10)" 200 "$J/out"

call "$J/p.txt" PUT "/api/v1/tenancy/members/$M_ASSOC/reports-to" "{\"reportsToUserId\":\"$MANAGER\"}"
expect "Priya reports to Anand" 200 "$J/out"

# THE TWO REFUSALS A DATABASE CANNOT MAKE.
call "$J/p.txt" PUT "/api/v1/tenancy/members/$M_MGR/reports-to" "{\"reportsToUserId\":\"$ASSOC\"}"
expect "a reporting LOOP is refused" 400 "$J/out"
call "$J/p.txt" PUT "/api/v1/tenancy/members/$M_MGR/reports-to" "{\"reportsToUserId\":\"$PARTNER\"}"
expect "…and an ordinary chain is not" 200 "$J/out"

say "3. The firm's rule: who may check work"
call "$J/p.txt" POST "/api/v1/config/verification_policy" \
  '{"key":"manager_review","body":{"label":"Manager review","rule":"rank_threshold","minGradeRank":7,"minGradeCode":"manager"}}'
expect "a rank threshold is written as a draft" 201 "$J/out"

# The validator's own rule: a reporting-line policy may not carry a threshold
# nothing reads.
call "$J/p.txt" POST "/api/v1/config/verification_policy" \
  '{"key":"bad_rule","body":{"label":"Nonsense","rule":"reporting_line","minGradeRank":7,"minGradeCode":"manager"}}'
expect "a knob nothing reads is refused" 400 "$J/out"

call "$J/p.txt" POST "/api/v1/config/verification_policy/manager_review/versions/1/publish" ""
expect "…and the good one goes in force" 200 "$J/out"

say "4. The process, with one step that is checked"
call "$J/p.txt" POST "/api/v1/config/workflow_template" \
  '{"key":"gst-monthly","body":{"label":"GST monthly filing","steps":[
     {"key":"prepare","label":"Prepare the return","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":"manager_review"},
     {"key":"file","label":"File it on the portal","executor":"human","dependsOn":["prepare"],"condition":null,"verificationPolicyKey":null}]}}'
expect "a two-step process, the first one checked" 201 "$J/out"
call "$J/p.txt" POST "/api/v1/config/workflow_template/gst-monthly/versions/1/publish" ""
expect "…published" 200 "$J/out"

say "5. A service that is delivered by that process"
call "$J/p.txt" POST "/api/v1/config/service" \
  '{"key":"gst-filing","body":{"name":"GST monthly filing","billingBasis":"fixed","jurisdictions":["IN"],"listPrice":{"amount":"15000.00","currency":"INR"},"recurrence":"monthly","workflowTemplateKey":"gst-monthly","slaDays":null}}'
expect "a service pointing at the process" 201 "$J/out"
call "$J/p.txt" POST "/api/v1/config/service/gst-filing/versions/1/publish" ""
expect "…published" 200 "$J/out"
SVCV=$(jget 'd["id"]')

say "6. A client, a signed letter, and the advance that starts the engine"
call "$J/p.txt" POST "/api/v1/parties/organizations" \
  '{"legalName":"Ravi Textiles Private Limited","jurisdiction":"IN","entityType":"private_limited"}'
expect "a client company, registered in India (Q076)" 201 "$J/out"
CLIENT=$(jget 'd["partyId"]')

TODAY=$(python3 -c 'import datetime;print(datetime.date.today().isoformat())')
call "$J/p.txt" POST "/api/v1/engagement-letters"   "{\"partyId\":\"$CLIENT\",\"jurisdiction\":\"IN\",\"title\":\"Ravi Textiles - FY26\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}"
expect "an engagement letter" 201 "$J/out"
EL=$(jget 'd["id"]')

call "$J/p.txt" POST "/api/v1/engagement-letters/$EL/lines"   "{\"entityPartyId\":\"$CLIENT\",\"serviceVersionId\":\"$SVCV\",\"description\":\"GST monthly filing, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"15000\",\"discountPercent\":\"0\"}"
expect "…with the service agreed on it" 201 "$J/out"

# A letter with no clauses has no terms, and the API refuses to send one. Not
# this task's rule — T2.3's — but the walk has to satisfy it to reach a job.
call "$J/p.txt" POST "/api/v1/config/clause"   '{"key":"scope","body":{"title":"Scope of work","text":"We will prepare and file the monthly GST returns described in this letter.","jurisdictions":["IN"]}}'
expect "a scope clause" 201 "$J/out"
call "$J/p.txt" POST "/api/v1/config/clause/scope/versions/1/publish" ""
expect "…published" 200 "$J/out"
CLAUSEV=$(jget 'd["id"]')
call "$J/p.txt" POST "/api/v1/engagement-letters/$EL/clauses" "{\"clauseVersionId\":\"$CLAUSEV\"}"
expect "…and on the letter" 204 "$J/out"

call "$J/p.txt" POST "/api/v1/engagement-letters/$EL/send" ""
expect "sent to the client" 200 "$J/out"

call "$J/p.txt" POST "/api/v1/engagement-letters/$EL/signature"   '{"signedByName":"Ravi Kumar","reference":"paper-001"}'
expect "signed — one engagement per line" 200 "$J/out"

# No advance was required on this letter, so signing is the trigger. The gate
# itself is smoke's to prove; this walk only needs work to exist.
say "7. The worker turns the letter into work"
(cd "$(dirname "$0")" >/dev/null 2>&1 || true)
npm --prefix "$BACKEND" run worker:once >/dev/null 2>&1 || npm --prefix "$BACKEND" run worker:once | tail -5
call "$J/p.txt" GET "/api/v1/jobs" ""
JOB=$(jget 'd["jobs"][0]["id"]' 2>/dev/null || echo "")
if [ -z "$JOB" ]; then bad "a job was spawned"; cat "$J/body"; exit 1; fi
ok "a job was spawned" "$JOB"

call "$J/p.txt" GET "/api/v1/jobs/$JOB/steps" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
print('    ' + ' | '.join('%s=%s' % (s['stepKey'], s['status']) for s in d['steps']))" < "$J/body"

say "8. Priya does the work — and it does NOT just finish"
call "$J/a.txt" POST "/api/v1/jobs/$JOB/steps/prepare/complete" ""
expect "the associate finishes the step" 200 "$J/out"
STATUS=$(jget 'd["status"]')
[ "$STATUS" = "blocked" ] && ok "…and the step is HELD, not done" "$STATUS" \
                          || bad "…the step finished without a check" "$STATUS"

call "$J/p.txt" GET "/api/v1/checks" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
c=d['checks'][0]
print('    waiting: %s · by %s · rule %s' % (c['stepLabel'], c['submittedByName'], c['rule']))" < "$J/body"
CHECK=$(jget 'd["checks"][0]["id"]')

say "9. THE ACCEPTANCE LINE, over HTTP"
call "$J/a.txt" POST "/api/v1/checks/$CHECK/decide" '{"decision":"approved","notes":null}'
expect "the MAKER cannot approve her own work" 403 "$J/out"
python3 -c "
import sys,json;d=json.load(sys.stdin);print('    said: ' + d['error']['message'][:110])" < "$J/body" < "$J/body"

say "10. …and the firm's own rule, on top of it"
# The partner did not do the work, and is above the bar — so this is about the
# BAR, not about the maker. A second associate would be the cleaner subject, but
# the manager is the one the firm's rule actually names.
call "$J/m.txt" POST "/api/v1/checks/$CHECK/decide" '{"decision":"rejected","notes":""}'
expect "sending it back with no reason is refused" 400 "$J/out"

call "$J/m.txt" POST "/api/v1/checks/$CHECK/decide" \
  '{"decision":"rejected","notes":"The March input credit is on the wrong period."}'
expect "the manager sends it back, with a reason" 200 "$J/out"
STATUS=$(jget 'd["status"]')
[ "$STATUS" = "blocked" ] && ok "…and the step is STILL waiting — a rejection is not the work" "$STATUS" \
                          || bad "…the step moved on a rejection" "$STATUS"

say "11. She redoes it, and that is a SECOND check"
call "$J/a.txt" POST "/api/v1/jobs/$JOB/steps/prepare/complete" ""
expect "the associate submits again" 200 "$J/out"
call "$J/p.txt" GET "/api/v1/jobs/$JOB/checks" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
print('    ' + ' | '.join('%s:%s' % (c['decision'], (c['notes'] or '')[:28]) for c in d['checks']))
assert len(d['checks'])==2, 'expected two checks, got %d' % len(d['checks'])" < "$J/body"
ok "…the rejection survives beside it — 'this took two goes'"
CHECK2=$(jget 'd["checks"][1]["id"]')

say "12. Approved, and the job moves"
call "$J/m.txt" POST "/api/v1/checks/$CHECK2/decide" '{"decision":"approved","notes":null}'
expect "the manager approves" 200 "$J/out"
STATUS=$(jget 'd["status"]'); PERF=$(jget 'd["performedBy"]')
[ "$STATUS" = "done" ] && ok "…the step is done" "$STATUS" || bad "…step not done" "$STATUS"
[ "$PERF" = "$ASSOC" ] && ok "…and PRIYA is still on the record, not the approver" "" \
                       || bad "…the approver overwrote who did the work" "$PERF"

call "$J/p.txt" GET "/api/v1/jobs/$JOB/steps" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
print('    ' + ' | '.join('%s=%s' % (s['stepKey'], s['status']) for s in d['steps']))" < "$J/body"

call "$J/p.txt" GET "/api/v1/checks" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
assert d['checks']==[], 'queue should be empty'" < "$J/body"
ok "the queue is empty again"

say "13. The audit trail — two verbs that had no writer until today"
call "$J/p.txt" GET "/api/v1/events?limit=40" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
vs=[r['event']['verb'] for r in d['events']]
for v in ('output.approved','output.rejected','membership.reports_to_changed'):
    print(('    [yes] ' if v in vs else '    [NO ] ') + v)
" < "$J/body"

say "14. A second client, left WAITING — so the screens have something to show"
call "$J/p.txt" POST "/api/v1/parties/organizations" '{"legalName":"Meridian Foods Private Limited","jurisdiction":"IN","entityType":"private_limited"}'
CLIENT2=$(jget 'd["partyId"]')
call "$J/p.txt" POST "/api/v1/engagement-letters" "{\"partyId\":\"$CLIENT2\",\"jurisdiction\":\"IN\",\"title\":\"Meridian Foods - FY26\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}"
EL2=$(jget 'd["id"]')
call "$J/p.txt" POST "/api/v1/engagement-letters/$EL2/lines" "{\"entityPartyId\":\"$CLIENT2\",\"serviceVersionId\":\"$SVCV\",\"description\":\"GST monthly filing, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"15000\",\"discountPercent\":\"0\"}"
call "$J/p.txt" POST "/api/v1/engagement-letters/$EL2/clauses" "{\"clauseVersionId\":\"$CLAUSEV\"}"
call "$J/p.txt" POST "/api/v1/engagement-letters/$EL2/send" ""
call "$J/p.txt" POST "/api/v1/engagement-letters/$EL2/signature" '{"signedByName":"Meera Shah","reference":"paper-002"}'
npm --prefix "$BACKEND" run worker:once >/dev/null 2>&1 || true
call "$J/p.txt" GET "/api/v1/jobs" ""
JOB2=$(python3 -c "
import sys,json;d=json.load(sys.stdin)
print(next(j['id'] for j in d['jobs'] if j['id'] != '$JOB'))" < "$J/body")
call "$J/a.txt" POST "/api/v1/jobs/$JOB2/steps/prepare/complete" ""
expect "Priya finishes it and it goes to the queue" 200 "$J/out"
call "$J/p.txt" GET "/api/v1/checks" ""
python3 -c "
import sys,json;d=json.load(sys.stdin)
assert len(d['checks'])==1, d
print('    one check open, for the screens')" < "$J/body"

printf '\n\033[1m───────────────────────────────────────────────────────────\033[0m\n'
if [ "$FAILED" = "1" ]; then printf '  \033[31mSOMETHING FAILED\033[0m\n'; else printf '  \033[32mall good\033[0m\n'; fi
cat <<EOF

  Open the screens as:
    $PARTNER_E   (partner  — admin, sees everything)
    $MANAGER_E   (manager  — can check Priya's work)
    $ASSOC_E     (associate — did the work, cannot check it)
  password: $PW

  Job (finished; shows the rejection and the redo):
        http://localhost:3000/work/$JOB
  Job (WAITING to be checked — open this one):
        http://localhost:3000/work/$JOB2
  The queue:
        http://localhost:3000/work
  Rule: http://localhost:3000/admin/verification
EOF
