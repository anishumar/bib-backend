#!/usr/bin/env bash
#
# Seed 10x Global — a whole firm, on a database with nothing else in it.
#
# ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────
#
# It is not the smoke walk. Smoke proves properties and leaves behind names like
# "Rotation Prospect 7 Private Limited". This leaves behind a firm you can put
# on a projector: real-looking people with a reporting line, Depts and delivery
# teams, published processes, a compliance calendar with dates in it, clients
# with work on somebody's desk, an invoice half paid and one 75 days overdue.
#
# THE LOGINS ARE FIXED — `siddharth@10xglobal.in`, not `siddharth-1788079646@`.
# That is only safe on a clean database, so this script REFUSES to run on one
# that already holds the firm rather than quietly making a second one. The way
# back is `npm run demo:fresh`, which destroys the volume and starts over.
#
# ── THE PROBLEM CORNER IS DELIBERATE ─────────────────────────────────────────
#
# Most of what this creates is healthy. A small, clearly-labelled corner is not,
# and every piece of it is a state this product exists to make visible:
#
#   · a client with no SPOC for one Dept  → work lands on its KEY MANAGER to
#                                            hand out, with the reason (2026-09-27)
#   · a client with TWO SPOCs for one Dept → the router refuses to choose
#   · an associate with no manager recorded → an escalation that reaches NOBODY
#   · fifty-odd shipped rules with no formula → the calendar's coverage tab
#   · an invoice 75 days overdue             → the dunning ladder waiting on a
#                                              partner at the credit-hold rung
#
# Show them or hide them; they are all in one place at the end of the run and
# the printout says which is which.
#
#   ./scripts/demo-seed.sh                 # against a running API on :8080
#
set -euo pipefail

API=${API:-http://localhost:8080}
H='content-type: application/json'
KEY=${BIB_DEMO_KEY:-local-dev-internal-key-not-for-any-real-environment}
A="authorization: Bearer $KEY"
PASSWORD=${BIB_DEMO_PASSWORD:-'10x Global demo 2026'}

# ── THE ONE THING THIS SCRIPT MUST NEVER DO ─────────────────────────────────
#
# It seeds FIXED logins with a FIXED password. That is exactly what makes the
# demo usable — `siddharth@10xglobal.in` is written in DEMO.md and typed by
# whoever is presenting — and it is also a set of published credentials. Run
# against anything but a throwaway local database, it puts them there.
#
# So the API has to be a local one, or BIB_DEMO_PASSWORD has to be set
# deliberately. Naming the variable in the refusal is the point: somebody who
# genuinely means to seed a shared environment says so in one line, and nobody
# does it by leaving $API pointing at yesterday's tunnel.
case "$API" in
  http://localhost:*|http://127.0.0.1:*|http://[::1]:*|https://localhost:*)
    ;;
  *)
    if [ -z "${BIB_DEMO_PASSWORD:-}" ]; then
      echo "refusing to seed $API with the built-in demo password." >&2
      echo >&2
      echo "This script creates five FIXED logins (siddharth@10xglobal.in and four" >&2
      echo "others) with a password that is committed in this repository. That is safe" >&2
      echo "on a throwaway local database and nowhere else." >&2
      echo >&2
      echo "Either point API at localhost, or set BIB_DEMO_PASSWORD to something you" >&2
      echo "chose:  BIB_DEMO_PASSWORD=\"$(openssl rand -base64 24 2>/dev/null || echo '<a password>')\" $0" >&2
      exit 1
    fi
    ;;
esac

DOMAIN=10xglobal.in

J=$(mktemp -d)
trap 'rm -rf "$J"' EXIT

# Dates the demo depends on. An invoice must be genuinely overdue for the
# dunning ladder to have climbed it, and a task must be genuinely late for the
# escalation ladder to have fired — so these are computed, never typed.
day() { python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=$1)).isoformat())"; }
TODAY=$(day 0)
LONG_AGO=$(day -75)
LAST_MONTH=$(day -32)
LAST_WEEK=$(day -8)
YESTERDAY=$(day -1)
DUE_SOON=$(day 14)
NEXT_MONTH=$(day 30)

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '  · %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# Read one field out of a JSON response, and STOP if it is not there.
#
# Without this the script cheerfully carries on with an empty id and builds a
# half-firm that looks fine until the demo opens the one screen that is broken.
# The overwhelmingly common cause is the rate limiter: this makes ~230 requests
# in a couple of minutes against a 300-a-minute budget.
#
# The field name arrives as ARGV, never interpolated into the Python source —
# quoting a name into a program that is itself inside two layers of shell
# quoting is how this broke the first time.
field() {
  python3 -c '
import sys, json
raw = sys.stdin.read()
want = sys.argv[1]
try:
    body = json.loads(raw)
except ValueError:
    sys.exit("\n  the API did not return JSON:\n  " + raw[:300])
if want not in body:
    err = body.get("error", {}) if isinstance(body, dict) else {}
    note = ""
    if err.get("code") == "RATE_LIMITED":
        note = ("\n\n  RATE LIMITED. 300 requests a minute from one address, shared with"
                "\n  `npm run smoke`. Wait 60 seconds, then run it again.")
    sys.exit("\n  expected %r in the response and it was not there."
             "\n  the API said: %s%s" % (want, err.get("message") or raw[:300], note))
print(body[want])' "$1"
}

# Pull a value out of a response with a one-line Python expression over `d`.
# Used for the reads where the answer is nested — a version id inside a list,
# an axis id matched by code.
#
# IT DIAGNOSES LIKE `field` DOES, and that is not decoration. A bare
# `json.load(...)['versions']` against a rate-limited response raises `KeyError:
# 'versions'` and sends the reader hunting through the API for a field that is
# there — the actual answer, "you have spent your 300 requests", is in the body
# nobody printed. This script makes ~230 requests in a couple of minutes.
pick() {
  python3 -c '
import sys, json

def die(*lines):
    for line in ("",) + lines:
        print("  " + line, file=sys.stderr)
    sys.exit(1)

raw = sys.stdin.read()
try:
    d = json.loads(raw)
except ValueError:
    die("the API did not return JSON:", raw[:300])

err = d.get("error") if isinstance(d, dict) else None
if err:
    lines = ["the API refused the read: " + (err.get("message") or raw[:300])]
    if err.get("code") == "RATE_LIMITED":
        lines += ["",
                  "RATE LIMITED. 300 requests a minute from one address, shared with",
                  "`npm run smoke` and anything else pointed at this API.",
                  "Wait 60 seconds and run `npm run demo:fresh` again."]
    die(*lines)

try:
    print(eval(sys.argv[1]))
except Exception as exc:
    die("could not read " + repr(sys.argv[1]) + " out of the response.",
        type(exc).__name__ + ": " + str(exc),
        "body: " + raw[:400])' "$1"
}

# Every write is checked. A create that the API REFUSED used to print a tidy
# "· Statutory audit" and carry on, because the step line was built from the
# REQUEST body — so the firm ended up without the service, and the run failed
# four sections later reading a version of something that was never written.
# That is exactly the half-firm `field` was written to prevent, reached from the
# write side instead of the read side.
#
# An empty body is success: several of these routes answer 204.
ok() {
  python3 -c '
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)
try:
    d = json.loads(raw)
except ValueError:
    sys.exit(0)
err = d.get("error") if isinstance(d, dict) else None
if err:
    print("", file=sys.stderr)
    print("  the API refused a write: " + (err.get("message") or raw[:400]), file=sys.stderr)
    if err.get("reason"):
        print("  reason: " + str(err["reason"]), file=sys.stderr)
    sys.exit(1)
'
}

post()  { curl -s -XPOST "$API$1" -H "$H" -H "$A" -d "$2"; }
as()    { curl -s -b "$J/$1.txt" "${@:2}"; }
asp()   { curl -s -b "$J/$1.txt" -XPOST -H "$H" "${@:2}"; }
asput() { curl -s -b "$J/$1.txt" -XPUT  -H "$H" "${@:2}"; }
aspat() { curl -s -b "$J/$1.txt" -XPATCH -H "$H" "${@:2}"; }

# ─────────────────────────────────────────────────────────────────────────────

say "Provisioning the firm"

# REFUSED RATHER THAN DUPLICATED. The logins below are fixed addresses, and
# `ensureUser` is idempotent by design — so a second run would link the same
# people to a SECOND firm and every one of them would meet "Choose a firm" at
# sign-in instead of the workspace. That is a confusing way to find out the
# database was not clean.
EXISTING=$(post /internal/v1/tenants \
  "{\"name\":\"10x Global\",\"slug\":\"10x-global\",\"reportingCurrency\":\"INR\"}")
if ! T=$(echo "$EXISTING" | field id 2>/dev/null); then
  cat <<'EOF'

  10x Global is already on this database, and this script will not make a
  second one — the logins are fixed addresses and two firms holding them turns
  every sign-in into "Choose a firm".

  Start over with a clean database:

      docker compose down -v && docker compose up -d
      cd bib-backend && npm run migrate && ./scripts/demo-seed.sh

EOF
  exit 1
fi
step "10x Global — books in INR, slug 10x-global"

# ── The people ───────────────────────────────────────────────────────────────
#
# Four staff and one client contact. The roles are the firm's OWN seeded set —
# a role the registry has not published is refused, which is the guard working.

mkperson() {
  local label=$1 email=$2 role=$3 audience=$4 fees=$5 name=$6
  local u
  u=$(post /internal/v1/users "{\"email\":\"$email\",\"displayName\":\"$name\"}" | field id)
  post /internal/v1/memberships \
    "{\"tenantId\":\"$T\",\"userId\":\"$u\",\"audience\":\"$audience\",\"role\":\"$role\",\"commercialVisibility\":$fees}" > /dev/null
  curl -s -o /dev/null -XPUT "$API/internal/v1/users/$u/password" -H "$H" -H "$A" \
    -d "{\"password\":\"$PASSWORD\"}"
  curl -s -c "$J/$label.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  echo "$u" > "$J/$label.id"
  step "$name — $role"
}

say "The people"
mkperson partner   "siddharth@$DOMAIN" partner        STAFF         true  "Siddharth Rao"
mkperson manager   "ravi@$DOMAIN"      manager        STAFF         true  "Ravi Iyer"
mkperson ananya    "ananya@$DOMAIN"    associate      STAFF         false "Ananya Nair"
mkperson farhan    "farhan@$DOMAIN"    associate      STAFF         false "Farhan Qureshi"
mkperson client    "meera@cobaltfoods.in" client_contact CLIENT_PORTAL false "Meera Menon"

PARTNER_ID=$(cat "$J/partner.id"); MANAGER_ID=$(cat "$J/manager.id")
ANANYA_ID=$(cat "$J/ananya.id");   FARHAN_ID=$(cat "$J/farhan.id")

# The roster, so grades and the reporting line can be set by MEMBERSHIP id.
mship() { as partner "$API/api/v1/tenancy/members" | pick "next(m['membership']['id'] for m in d['members'] if m['email']=='$1')"; }
M_PARTNER=$(mship "siddharth@$DOMAIN")
M_MANAGER=$(mship "ravi@$DOMAIN")
M_ANANYA=$(mship "ananya@$DOMAIN")
M_FARHAN=$(mship "farhan@$DOMAIN")

say "The seniority ladder, and who reports to whom"
# The rungs are SEEDED at tenant creation; this puts people on them. Read by
# CODE rather than assumed by rank — a firm may re-rank its own ladder.
grade() { as partner "$API/api/v1/tenancy/grades" | pick "next(g['id'] for g in d['grades'] if g['code']=='$1')"; }
G_PARTNER=$(grade partner); G_MANAGER=$(grade manager); G_ASSOCIATE=$(grade associate)
asput partner "$API/api/v1/tenancy/members/$M_PARTNER/grade" -d "{\"gradeId\":\"$G_PARTNER\"}" | ok
asput partner "$API/api/v1/tenancy/members/$M_MANAGER/grade" -d "{\"gradeId\":\"$G_MANAGER\"}" | ok
asput partner "$API/api/v1/tenancy/members/$M_ANANYA/grade"  -d "{\"gradeId\":\"$G_ASSOCIATE\"}" | ok
asput partner "$API/api/v1/tenancy/members/$M_FARHAN/grade"  -d "{\"gradeId\":\"$G_ASSOCIATE\"}" | ok
step "Siddharth partner · Ravi manager · Ananya and Farhan associates"

asput partner "$API/api/v1/tenancy/members/$M_MANAGER/reports-to" -d "{\"reportsToUserId\":\"$PARTNER_ID\"}" | ok
asput partner "$API/api/v1/tenancy/members/$M_ANANYA/reports-to"  -d "{\"reportsToUserId\":\"$MANAGER_ID\"}" | ok
step "Ravi → Siddharth,  Ananya → Ravi"
# PROBLEM CORNER (1). Farhan reports to nobody. Every rung addressed to "the
# assignee's manager" therefore reaches NOBODY on his work, which is the row
# `/work-items` marks in danger tone and counts above the table.
warn "Farhan has no manager recorded — on purpose. His escalations reach nobody."

say "The firm's own entity, and where it is registered"
# G1.8 needs this: a governing-law clause is refused on a letter issued by an
# entity with no registered jurisdiction, because there is nothing to check it
# against. Every firm starts in that state.
FIRMENT=$(as partner "$API/api/v1/firm-entities/preferences" \
  | pick "next(p['firmEntityPartyId'] for p in d['preferences'] if p['clientJurisdiction']=='*')")
asp partner "$API/api/v1/parties/organizations/$FIRMENT/legal-entities" \
  -d '{"jurisdiction":"IN","entityType":"private_limited"}' | ok
# PUT, not POST — naming a successor REPLACES the standing signatory rather
# than adding a second one, and there is only ever one.
asput partner "$API/api/v1/tenancy/firm-signatory" \
  -d "{\"userId\":\"$PARTNER_ID\",\"title\":\"Managing Partner\"}" | ok
step "10x Global registered in IN · Siddharth signs its letters"

# ── How the firm is shaped ───────────────────────────────────────────────────
#
# Two lists, never a tree. A Dept is the revenue axis; a delivery team is who
# does the work; one team commonly delivers under several Depts.

say "Depts, delivery teams, and how work is cut"
axis() { asp partner "$API/api/v1/tenancy/structure/axes" -d "{\"axis\":\"$1\",\"code\":\"$2\",\"name\":\"$3\",\"sortOrder\":$4}" > /dev/null; step "$1 - $2 - $3"; }
axis dept FRC "Financial Reporting & Compliance" 1
axis dept TRC "Tax & Regulatory Compliance"      2
axis dept RAA "Risk, Assurance & Advisory"       3
axis team FINCOMPLIANCE "FinCompliance"  1
axis team "VCFO CONSOLE" "vCFO Console"  2
axis team PAYROLL       "Payroll"        3

# Work is cut by DEPT. That is what makes a client's tax filings one job and its
# bookkeeping another, and it is what routes each to a different SPOC.
asput partner "$API/api/v1/tenancy/structure/work-split" -d '{"workSplitAxis":"dept"}' | ok
step "one client's work is cut by Dept"

dept() { as partner "$API/api/v1/tenancy/structure" | pick "next(a['id'] for a in d['axes'] if a['code']=='$1' and a['axis']=='dept')"; }
AX_FRC=$(dept FRC); AX_TRC=$(dept TRC); AX_RAA=$(dept RAA)

# ── The rules the firm runs on ───────────────────────────────────────────────

say "Who may check whose work"
asp partner "$API/api/v1/config/verification_policy" \
  -d '{"key":"manager_review","body":{"label":"A manager or above checks it","rule":"rank_threshold","minGradeRank":7,"minGradeCode":"manager"}}' | ok
asp partner "$API/api/v1/config/verification_policy/manager_review/versions/1/publish" | ok
step "manager_review — rank threshold at manager. Maker ≠ checker is not a setting."

say "How the firm does its work"
wf() {
  asp partner "$API/api/v1/config/workflow_template" -d "$1" | ok
  local key; key=$(pick "d['key']" <<< "$1")
  asp partner "$API/api/v1/config/workflow_template/$key/versions/1/publish" | ok
  step "$(pick "d['body']['label']" <<< "$1")"
}
wf '{"key":"gst-monthly","body":{"label":"GST monthly filing","steps":[
 {"key":"collect","label":"Collect the books from the client","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":null},
 {"key":"reconcile","label":"Reconcile 2B against the purchase register","executor":"human","dependsOn":["collect"],"condition":null,"verificationPolicyKey":null},
 {"key":"prepare","label":"Prepare GSTR-1 and GSTR-3B","executor":"human","dependsOn":["reconcile"],"condition":null,"verificationPolicyKey":"manager_review"},
 {"key":"file","label":"File on the GST portal","executor":"human","dependsOn":["prepare"],"condition":{"fact":"jurisdiction","op":"equals","value":"IN"},"verificationPolicyKey":null},
 {"key":"archive","label":"File the acknowledgement","executor":"human","dependsOn":["file"],"condition":null,"verificationPolicyKey":null}]}}'
wf '{"key":"tds-quarterly","body":{"label":"TDS quarterly return","steps":[
 {"key":"extract","label":"Extract deductions for the quarter","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":null},
 {"key":"challans","label":"Match challans to deductions","executor":"human","dependsOn":["extract"],"condition":null,"verificationPolicyKey":"manager_review"},
 {"key":"file","label":"File 24Q and 26Q","executor":"human","dependsOn":["challans"],"condition":null,"verificationPolicyKey":null}]}}'
wf '{"key":"monthly-books","body":{"label":"Monthly bookkeeping and MIS","steps":[
 {"key":"post","label":"Post the month'"'"'s entries","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":null},
 {"key":"reconcile","label":"Reconcile the bank","executor":"human","dependsOn":["post"],"condition":null,"verificationPolicyKey":null},
 {"key":"pack","label":"Draw up the management pack","executor":"human","dependsOn":["reconcile"],"condition":null,"verificationPolicyKey":"manager_review"}]}}'
wf '{"key":"statutory-audit","body":{"label":"Statutory audit","steps":[
 {"key":"plan","label":"Plan the audit","executor":"human","dependsOn":[],"condition":null,"verificationPolicyKey":null},
 {"key":"fieldwork","label":"Fieldwork","executor":"human","dependsOn":["plan"],"condition":null,"verificationPolicyKey":null},
 {"key":"report","label":"Draft the audit report","executor":"human","dependsOn":["fieldwork"],"condition":null,"verificationPolicyKey":"manager_review"}]}}'

say "What the firm sells"
service() {
  asp partner "$API/api/v1/config/service" -d "$1" | ok
  local key; key=$(pick "d['key']" <<< "$1")
  asp partner "$API/api/v1/config/service/$key/versions/1/publish" | ok
  step "$(pick "d['body']['name']" <<< "$1")  ($(pick "d['body']['module']" <<< "$1"))"
}
service '{"key":"gst-monthly","body":{"name":"GST monthly filing","ref":"A1","module":"TRC","group":"FINCOMPLIANCE","description":"GSTR-1 and GSTR-3B, monthly.","billingBasis":"fixed","recurrence":"monthly","slaDays":10,"listPrice":{"amount":"6000.00","currency":"INR"},"jurisdictions":["IN"],"workflowTemplateKey":"gst-monthly","scope":"Preparation and filing of GSTR-1 and GSTR-3B from books provided by the client.","clientObligations":"Books closed and shared by the 5th of the following month.","volumeLimits":"Up to 200 invoices a month.","exclusions":"Departmental representation, refunds and annual return."}}'
service '{"key":"tds-quarterly","body":{"name":"TDS quarterly return","ref":"A4","module":"TRC","group":"FINCOMPLIANCE","description":"Form 24Q and 26Q.","billingBasis":"fixed","recurrence":"quarterly","slaDays":15,"listPrice":{"amount":"9000.00","currency":"INR"},"jurisdictions":["IN"],"workflowTemplateKey":"tds-quarterly"}}'
service '{"key":"bookkeeping","body":{"name":"Bookkeeping and MIS","ref":"F2","module":"FRC","group":"VCFO CONSOLE","description":"Monthly bookkeeping with a management pack.","billingBasis":"retainer","recurrence":"monthly","slaDays":12,"listPrice":{"amount":"25000.00","currency":"INR"},"jurisdictions":["IN"],"workflowTemplateKey":"monthly-books"}}'
service '{"key":"statutory-audit","body":{"name":"Statutory audit","ref":"R1","module":"RAA","group":"FINCOMPLIANCE","description":"Audit under the Companies Act.","billingBasis":"fixed","recurrence":"annually","slaDays":60,"listPrice":{"amount":"175000.00","currency":"INR"},"jurisdictions":["IN"],"workflowTemplateKey":"statutory-audit"}}'
service '{"key":"payroll","body":{"name":"Payroll processing","ref":"P1","module":"FRC","group":"PAYROLL","description":"Monthly payroll, payslips and statutory deductions.","billingBasis":"fixed","recurrence":"monthly","slaDays":5,"listPrice":{"amount":"12000.00","currency":"INR"},"jurisdictions":["IN"]}}'
# The LAST one names no process on purpose: a job for it walks nothing and the
# engine screen says "waiting for a process — nobody has written how this
# service is delivered", which is a real state and not a fault.
warn "Payroll names no process — its job will sit visibly waiting for one."

say "Money rules"
asp partner "$API/api/v1/config/policy" -d '{"key":"discount","body":{"maxDiscountPercent":"15"}}' | ok
asp partner "$API/api/v1/config/policy/discount/versions/1/publish" | ok
step "discounts over 15% need a partner"

# The ladder the worker climbs on money. The last two rungs are the ones it may
# reach and may NOT apply — those wait for a person. The key MUST be `default`.
asp partner "$API/api/v1/config/dunning" -d '{"key":"default","body":{"steps":[
  {"key":"first-reminder","label":"First reminder","afterDays":3,"action":"reminder"},
  {"key":"second-reminder","label":"Second reminder","afterDays":7,"action":"reminder"},
  {"key":"call-the-client","label":"Call the client","afterDays":15,"action":"call"},
  {"key":"credit-hold","label":"Put the client on credit hold","afterDays":45,"action":"credit_hold"},
  {"key":"legal","label":"Refer to lawyers","afterDays":90,"action":"legal"}]}}' > /dev/null
asp partner "$API/api/v1/config/dunning/default/versions/1/publish" | ok
step "dunning: D+3, D+7, D+15, credit hold D+45, lawyers D+90"

say "When the firm hears its own work has gone quiet"
# NOTHING IS SEEDED by the product — a firm with no published ladder escalates
# nobody, deliberately. This is the firm publishing one.
#
# `grade_at_least` is not resolved to a person: "tell a partner" means EVERY
# partner can see it, because an escalation routed to one desk dies while that
# desk is on leave.
asp partner "$API/api/v1/config/escalation" -d '{"key":"default","body":{"rungs":[
  {"key":"unassigned-nudge","watch":"work_item_unassigned","afterDays":2,"notify":"manager","minGradeRank":null,"label":"Nobody has picked this up in two days"},
  {"key":"unassigned-partner","watch":"work_item_unassigned","afterDays":5,"notify":"grade_at_least","minGradeRank":9,"label":"Still nobody after five days - a partner should look"},
  {"key":"due-assignee","watch":"work_item_due","afterDays":1,"notify":"assignee","minGradeRank":null,"label":"This was due yesterday"},
  {"key":"due-manager","watch":"work_item_due","afterDays":3,"notify":"manager","minGradeRank":null,"label":"Three days past the promise - the manager hears about it"},
  {"key":"due-partner","watch":"work_item_due","afterDays":7,"notify":"grade_at_least","minGradeRank":9,"label":"A week late - a partner hears about it"},
  {"key":"target-assignee","watch":"obligation_target","afterDays":0,"notify":"assignee","minGradeRank":null,"label":"The internal target for this filing is today"},
  {"key":"target-manager","watch":"obligation_target","afterDays":3,"notify":"manager","minGradeRank":null,"label":"Three days past the internal target"}]}}' > /dev/null
asp partner "$API/api/v1/config/escalation/default/versions/1/publish" | ok
step "7 rungs across all three watches — unassigned, due, and the internal target"

say "When the firm reminds a CLIENT"
# THE OUTWARD LADDER (T4.4). Nothing is seeded by the product — a firm with no
# published `chaser` entry chases NOBODY, and that rule is sharper than the
# escalation one: an escalation nobody asked for lands on a colleague, a chase
# lands on the client, who reads it as the firm's opinion of them. This is the
# firm publishing one.
#
# D+3, D+7, D+15 — the board's own numbers. NOTHING HAS FIRED ON A FRESH DEMO
# and that is correct rather than a gap: every ask below is raised today, so no
# ask is three days old yet. The firm's ask panel and the client's action centre
# both say nothing about reminders, which is the true state of a firm on its
# first day and not an empty screen hiding a broken sweep.
asp partner "$API/api/v1/config/chaser" -d '{"key":"default","body":{"rungs":[
  {"key":"first","afterDays":3,"label":"A gentle reminder"},
  {"key":"second","afterDays":7,"label":"A second reminder"},
  {"key":"final","afterDays":15,"label":"A final reminder"}]}}' > /dev/null
asp partner "$API/api/v1/config/chaser/default/versions/1/publish" | ok
step "chasing an unanswered ask: D+3, D+7, D+15 — and a freeze stops it"

say "When the firm tells a client a filing is coming up"
# THE PROACTIVE LADDER (T6.7), and it counts the other way: 7, then 3, then 1
# day BEFORE a statutory date. Its own config kind rather than a rung of the
# chaser with a minus sign — a chase is about something the firm asked for and
# has not had back, a nudge asks for nothing and names a date the LAW set.
#
# THIS ONE DOES FIRE on a fresh demo, because the calendar below materialises a
# year of filings and some of them are inside a week.
asp partner "$API/api/v1/config/nudge" -d '{"key":"default","body":{"rungs":[
  {"key":"week","beforeDays":7,"label":"A week to go"},
  {"key":"three_days","beforeDays":3,"label":"Three days to go"},
  {"key":"eve","beforeDays":1,"label":"Due tomorrow"}]}}' > /dev/null
asp partner "$API/api/v1/config/nudge/default/versions/1/publish" | ok
step "telling a client about their own filing: T-7, T-3, T-1 — a freeze does NOT stop this"

say "The clauses a letter is written from"
clause() {
  asp partner "$API/api/v1/config/clause" -d "$1" | ok
  local key; key=$(pick "d['key']" <<< "$1")
  asp partner "$API/api/v1/config/clause/$key/versions/1/publish" | ok
  step "$(pick "d['body']['title']" <<< "$1")"
}
clause '{"key":"governing-law-in","body":{"title":"Governing law and jurisdiction","text":"This engagement is governed by the laws of the Republic of India, and the courts at Bengaluru have exclusive jurisdiction.","jurisdictions":[],"governingLaw":{"jurisdiction":"IN","text":"the laws of the Republic of India"},"courts":{"jurisdiction":"IN","text":"the courts at Bengaluru"}}}'
clause '{"key":"confidentiality","body":{"title":"Confidentiality","text":"Each party keeps the other in confidence, and neither discloses the other'"'"'s information without consent.","jurisdictions":[]}}'
clause '{"key":"limitation","body":{"title":"Limitation of liability","text":"Liability under this engagement is limited to the fees paid for it.","jurisdictions":[]}}'
clause '{"key":"termination","body":{"title":"Termination","text":"Either party may end this engagement on thirty days written notice. Work in hand is billed to the date of termination.","jurisdictions":[]}}'

say "The prose every document is written with"
block() { asp partner "$API/api/v1/document-blocks/standard" -d "$1" > /dev/null; }
block '{"kind":"exclusion","body":"Statutory fees, filing fees and stamp duty are not included.","sortOrder":1}'
block '{"kind":"exclusion","body":"Representation before any court or tribunal.","sortOrder":2}'
block '{"kind":"exclusion","body":"Any period before the effective date of this engagement.","sortOrder":3}'
block '{"kind":"commercial","body":"All fees are exclusive of GST as applicable.","sortOrder":1,"jurisdiction":"IN"}'
block '{"kind":"commercial","body":"Invoices are payable within 14 days.","sortOrder":2}'
block '{"kind":"team","body":"Engagement Partner","sortOrder":1,"isHeading":true}'
block '{"kind":"team","body":"Siddharth Rao - signs off every filing.","sortOrder":2}'
block '{"kind":"team","body":"Delivery Team","sortOrder":3,"isHeading":true}'
block '{"kind":"team","body":"Ravi Iyer (Manager), with Ananya Nair and Farhan Qureshi.","sortOrder":4}'
# THE COVER LETTER'S OPENING, in the firm's own words (its July 2026 engagement
# letter). A letter with nothing on its cover page cannot be sent (CA#2, audit
# 2026-10-03), and the product writes no letter prose of its own.
block '{"kind":"cover","body":"This Engagement Letter confirms that you have engaged us to provide the services described in Annexure 1.","sortOrder":1}'
block '{"kind":"cover","body":"Please sign this letter in the space provided below to indicate your agreement.","sortOrder":2}'
step "3 exclusions, 2 commercial notes (one India-only), a team block, the cover letter's opening"

say "Territories"
asp partner "$API/api/v1/territory-rules" \
  -d "{\"jurisdiction\":\"GB\",\"ownerUserId\":\"$MANAGER_ID\",\"note\":\"Ravi covers the UK desk\"}" | ok
step "GB → Ravi. Everywhere else falls to the rotation."

# ── The book ─────────────────────────────────────────────────────────────────

say "The book"
org() { asp partner "$API/api/v1/parties/organizations" -d "{\"legalName\":\"$1\"}" | field partyId; }
entity() { asp partner "$API/api/v1/parties/organizations/$1/legal-entities" -d "$2" > /dev/null; }
ident()  { asp partner "$API/api/v1/parties/$1/identifiers" -d "$2" > /dev/null; }

COBALT=$(org "Cobalt Foods Private Limited")
entity "$COBALT" '{"jurisdiction":"IN","entityType":"private_limited","incorporatedOn":"2019-06-11","financialYearEnd":"03-31"}'
ident  "$COBALT" '{"type":"pan","value":"AAACC1234F","validFrom":"2019-06-11"}'
ident  "$COBALT" '{"type":"gstin","value":"29AAACC1234F1Z5","validFrom":"2019-07-01"}'
step "Cobalt Foods Private Limited — PAN and a Karnataka GSTIN"

# THE GROUP. G0.1: four companies file four sets of returns, so a board showing
# only the billing client is four identical cards. This is the second company.
COBALT_LOG=$(org "Cobalt Logistics Private Limited")
entity "$COBALT_LOG" '{"jurisdiction":"IN","entityType":"private_limited","incorporatedOn":"2021-04-02","financialYearEnd":"03-31"}'
ident  "$COBALT_LOG" '{"type":"pan","value":"AAACC9911K","validFrom":"2021-04-02"}'
ident  "$COBALT_LOG" '{"type":"gstin","value":"27AAACC9911K1Z2","validFrom":"2021-05-01"}'
# `parent_of`, FROM the parent — the type vocabulary is a table
# (`core.relationship_type`) holding six codes, and `subsidiary_of` is not one of
# them. The direction is what carries the meaning.
asp partner "$API/api/v1/parties/relationships" \
  -d "{\"fromPartyId\":\"$COBALT\",\"toPartyId\":\"$COBALT_LOG\",\"type\":\"parent_of\",\"validFrom\":\"2021-04-02\"}" | ok
step "Cobalt Logistics Private Limited — a Maharashtra GSTIN, Cobalt Foods is its parent"

LAKEVIEW=$(org "Lakeview Organics Private Limited")
entity "$LAKEVIEW" '{"jurisdiction":"IN","entityType":"private_limited","incorporatedOn":"2020-11-03","financialYearEnd":"03-31"}'
ident  "$LAKEVIEW" '{"type":"pan","value":"AAACL5678M","validFrom":"2021-02-01"}'
ident  "$LAKEVIEW" '{"type":"gstin","value":"29AAACL5678M1Z8","validFrom":"2021-02-01"}'
step "Lakeview Organics Private Limited"

# PROBLEM CORNER (2). Registered NOWHERE. A compliance rule matches an entity's
# jurisdiction exactly, so this one produces no calendar at all and the coverage
# tab names it with `entity_not_registered` — which is a real answer, and the
# reason that reason exists.
HARBOUR=$(org "Harbour Provisions Private Limited")
ident "$HARBOUR" '{"type":"pan","value":"AAACH3344P","validFrom":"2023-01-09"}'
warn "Harbour Provisions has no legal entity registered — its calendar will be empty, with a reason."

# ── The client's own contact, let in (T6.5) ──────────────────────────────────
#
# Without this row Meera signs in and the portal correctly says "the firm has
# not given you access to a company yet" — which is the right screen for that
# state and the wrong first impression of a demo. ACCESS IS GRANTED, NEVER
# DERIVED: this is one company, one row, one event, one answer to "who decided
# this". Cobalt Logistics is deliberately NOT granted even though Cobalt Foods
# is its parent — the relationship above says so and access does not read it, so
# the portal shows Foods' filings and not the subsidiary's until somebody
# decides otherwise. That is the wall being visible rather than a gap.
M_MEERA=$(mship "meera@cobaltfoods.in")
asp partner "$API/api/v1/portal-access/memberships/$M_MEERA"   -d "{\"clientPartyId\":\"$COBALT\",\"validFrom\":\"$LAST_MONTH\"}" | ok
step "Meera Menon may read Cobalt Foods — and nothing else"

DIRECTOR=$(asp partner "$API/api/v1/parties/persons" -d '{"fullName":"Priya Menon"}' | field partyId)
asp partner "$API/api/v1/parties/relationships" \
  -d "{\"fromPartyId\":\"$DIRECTOR\",\"toPartyId\":\"$COBALT\",\"type\":\"director_of\",\"validFrom\":\"2019-06-11\"}" | ok
step "Priya Menon — director of Cobalt since 2019"

# ── Who at the firm owns whom ────────────────────────────────────────────────

say "The account teams"
assign() { asp partner "$API/api/v1/parties/$1/assignments" -d "$2" > /dev/null; }
assign "$COBALT" "{\"role\":\"key_manager\",\"userId\":\"$PARTNER_ID\",\"validFrom\":\"$LAST_MONTH\"}"
assign "$COBALT" "{\"role\":\"spoc\",\"userId\":\"$ANANYA_ID\",\"axisId\":\"$AX_TRC\",\"validFrom\":\"$LAST_MONTH\"}"
assign "$COBALT" "{\"role\":\"spoc\",\"userId\":\"$MANAGER_ID\",\"axisId\":\"$AX_FRC\",\"validFrom\":\"$LAST_MONTH\"}"
assign "$COBALT" "{\"role\":\"spoc\",\"userId\":\"$MANAGER_ID\",\"axisId\":\"$AX_RAA\",\"validFrom\":\"$LAST_MONTH\"}"
step "Cobalt — Siddharth owns it, Ananya on TRC, Ravi on FRC and RAA"
# EVERY DEPT COVERED, and that is not tidiness. The shipped rules name no
# service (a vendor pack cannot know a firm's catalogue keys), so a filing they
# raise inherits the Dept of whichever of the entity's engagements it attached
# to — which for Cobalt was the audit. Leaving RAA empty therefore put "no SPOC
# is recorded for Risk, Assurance & Advisory" on seventeen GST and payroll
# cards. The behaviour is worth a conversation; a demo is not the place to have
# it, so every Dept this client buys under has somebody on it.

assign "$LAKEVIEW" "{\"role\":\"key_manager\",\"userId\":\"$MANAGER_ID\",\"validFrom\":\"$LAST_MONTH\"}"
# PROBLEM CORNER (4). TWO SPOCs on one Dept is a legitimate arrangement the API
# allows, and it is the other half of the unassigned queue: "two SPOCs for TRC,
# pick one" is a different job from "nobody has got to it".
assign "$LAKEVIEW" "{\"role\":\"spoc\",\"userId\":\"$ANANYA_ID\",\"axisId\":\"$AX_TRC\",\"validFrom\":\"$LAST_MONTH\"}"
assign "$LAKEVIEW" "{\"role\":\"spoc\",\"userId\":\"$FARHAN_ID\",\"axisId\":\"$AX_TRC\",\"validFrom\":\"$LAST_WEEK\"}"
step "Lakeview — Ravi owns it"
warn "Lakeview has TWO SPOCs on TRC — the router will refuse to choose."

assign "$HARBOUR" "{\"role\":\"key_manager\",\"userId\":\"$MANAGER_ID\",\"validFrom\":\"$LAST_WEEK\"}"
# PROBLEM CORNER (3). Harbour has a Key Manager and NO SPOC on any Dept, which
# is what a client looks like the week it is signed. Since 2026-09-27 the work
# the engine raises for it goes to the Key Manager to HAND OUT, with a sentence
# on the task saying so and why (the owner rule, `resolveOwner`); until then it
# sat on nobody's desk.
warn "Harbour has no SPOC on any Dept - its work will land on Ravi, its Key Manager, to hand out."

# ── The compliance rules ─────────────────────────────────────────────────────

say "The compliance rules"
# IDEMPOTENT, and it usually creates NOTHING — `createTenant` already seeds the
# pack through the `ObligationRuleSeeder` port, so a new firm has all 57 before
# anybody asks. Called anyway: it is what a firm on an older tenant runs, and a
# demo that skips it would not prove the button works. The number that means
# something is the TOTAL, so that is what is read back.
asp partner "$API/api/v1/obligation-rules/seed-india" | ok
SHIPPED=$(as partner "$API/api/v1/obligation-rules" | pick "len(d['rules'])")
step "$SHIPPED shipped India rules on file — most are waiting on a fact, which is the honest state"

# THE FIRM ANSWERS THE SHIPPED RULES; it does not write rules beside them.
#
# The first version of this seed wrote a firm rule called "GSTR-3B - monthly"
# while the pack already held one called "GSTR-3B", so Cobalt Foods carried the
# SAME statutory return on its calendar twice - 28 filings each. Two rows for
# one return is worse than none: whichever one somebody files, the other stays
# open and reads as a missed deadline. Found by counting the calendar, not by
# any test - both rules were valid, both generated, and nothing was refused.
#
# What a real firm does is exactly what the product is built for. A partner
# goes down the 57 shipped rules, sets the lead time the firm actually works to,
# and adds each filing to the SERVICE that owes it (T6.16). Since 0309 a rule
# reaches a client only through a service in the catalogue, and adding an
# unconfirmed one there confirms it in the same act, so this is also the
# partner confirming the four dates. Before T6.16 this PATCHed status alone and
# the rule, on no service, reached every engagement of every company: Cobalt
# Logistics carried TDS returns it never bought.
entry_id() { as partner "$API/api/v1/config/service/$1" | pick "d['entry']['id']"; }
file_under() {
  local name=$1 svc=$2 lead=$3 id sid
  id=$(as partner "$API/api/v1/obligation-rules" | pick "next(r['id'] for r in d['rules'] if r['name'] == '$name')")
  aspat partner "$API/api/v1/obligation-rules/$id" -d "{\"leadTimeDays\":$lead}" | ok
  sid=$(entry_id "$svc")
  asp partner "$API/api/v1/services/$sid/filings" -d "{\"ruleId\":\"$id\"}" | ok
  step "$name - added to $svc, which confirms it; work starts T-$lead"
}
file_under "GSTR-3B"                  gst-monthly   6
file_under "GSTR-1"                   gst-monthly   6
file_under "TDS deposit"              tds-quarterly 4
file_under "Quarterly TDS statements" tds-quarterly 10
warn "the other 53 stay UNCONFIRMED and on no service - they add nothing to the calendar, and the rules screen says so."

# ── Pipeline, quote, letter ──────────────────────────────────────────────────

say "The pipeline"
asp partner "$API/api/v1/leads" -d "{\"source\":\"referral\",\"title\":\"FY27 statutory audit\",\"kind\":\"organization\",\"name\":\"Lakeview Organics Private Limited\",\"jurisdiction\":\"IN\",\"identifiers\":[{\"type\":\"pan\",\"value\":\"AAACL5678M\"}]}" | ok
step "a referral, deduplicated onto Lakeview by PAN"
asp partner "$API/api/v1/leads" -d '{"source":"inbound","title":"UK holding company setup","kind":"organization","name":"Thames Provisions Ltd","jurisdiction":"GB","identifiers":[{"type":"email","value":"ops@thamesprovisions.example"}]}' | ok
step "a UK lead — the territory rule puts it on Ravi's desk"
asp partner "$API/api/v1/leads" -d '{"source":"inbound","title":"Payroll for 40 staff","kind":"organization","name":"Nilgiri Textiles Private Limited","jurisdiction":"IN","identifiers":[{"type":"email","value":"cfo@nilgiritextiles.example"}]}' | ok
step "an inbound website enquiry"

say "A quote, agreed"
# QUANTITY IS HOW MANY EACH BILLING PERIOD (decided 2026-10-03): a monthly line
# at quantity 12 bills twelve times every month. These lines are one each; how
# long the work runs is the letter's dates, never the quantity. They read
# quantity 12 (and 4) until the audit of 2026-10-03, which put the demo's
# monthly recurring revenue at INR 5,70,000 instead of INR 49,500.
sv() { as partner "$API/api/v1/config/service/$1" | pick "next(v['id'] for v in d['versions'] if v['version']==1)"; }
V_GST=$(sv gst-monthly); V_BOOK=$(sv bookkeeping); V_AUDIT=$(sv statutory-audit)
V_TDS=$(sv tds-quarterly); V_PAY=$(sv payroll)

PROP=$(asp partner "$API/api/v1/proposals" -d "{\"partyId\":\"$COBALT\",\"title\":\"Cobalt Foods - FY27 compliance\",\"clientJurisdiction\":\"IN\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}" | field id)
line() { asp partner "$API/api/v1/proposals/$PROP/lines" -d "$1" > /dev/null; }
line "{\"serviceVersionId\":\"$V_GST\",\"entityPartyId\":\"$COBALT\",\"description\":\"GST monthly filing - Cobalt Foods\",\"quantity\":\"1\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}"
line "{\"serviceVersionId\":\"$V_GST\",\"entityPartyId\":\"$COBALT_LOG\",\"description\":\"GST monthly filing - Cobalt Logistics\",\"quantity\":\"1\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}"
line "{\"serviceVersionId\":\"$V_TDS\",\"entityPartyId\":\"$COBALT\",\"description\":\"TDS quarterly return\",\"quantity\":\"1\",\"unitAmount\":\"9000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}"
line "{\"serviceVersionId\":\"$V_BOOK\",\"entityPartyId\":\"$COBALT\",\"description\":\"Bookkeeping and MIS\",\"quantity\":\"1\",\"unitAmount\":\"25000.00\",\"discountPercent\":\"10\",\"jurisdiction\":\"IN\"}"
line "{\"serviceVersionId\":\"$V_AUDIT\",\"entityPartyId\":\"$COBALT\",\"description\":\"Statutory audit FY27\",\"quantity\":\"1\",\"unitAmount\":\"175000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}"
line "{\"serviceVersionId\":\"$V_PAY\",\"entityPartyId\":\"$COBALT\",\"description\":\"Payroll processing\",\"quantity\":\"1\",\"unitAmount\":\"12000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}"
asp partner "$API/api/v1/proposals/$PROP/send" | ok
# The client said yes on a call; the partner records it (0317). The firm runs
# on UTC, so the day is the UTC one.
asp partner "$API/api/v1/proposals/$PROP/acceptance" -d "{\"channel\":\"call\",\"acceptedOn\":\"$(date -u +%F)\",\"acceptedByName\":\"Priya Menon\",\"note\":\"Priya called to accept the quote as sent.\"}" | ok
step "six lines across two companies, sent and accepted — PR number allocated"

# A second proposal left as a DRAFT, so the pipeline is not all closed business.
PROP2=$(asp partner "$API/api/v1/proposals" -d "{\"partyId\":\"$LAKEVIEW\",\"title\":\"Lakeview Organics - FY27 audit\",\"clientJurisdiction\":\"IN\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}" | field id)
asp partner "$API/api/v1/proposals/$PROP2/lines" -d "{\"serviceVersionId\":\"$V_AUDIT\",\"entityPartyId\":\"$LAKEVIEW\",\"description\":\"Statutory audit FY27\",\"quantity\":\"1\",\"unitAmount\":\"175000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}" | ok
step "a second proposal left in draft — something to send live on stage"

say "The letter that creates the work"
LETTER=$(asp partner "$API/api/v1/engagement-letters" -d "{\"partyId\":\"$COBALT\",\"proposalId\":\"$PROP\",\"jurisdiction\":\"IN\",\"title\":\"Cobalt Foods - FY27 engagement\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\",\"background\":\"10x Global has been asked to take on the Cobalt group's indirect tax compliance, payroll, monthly bookkeeping and the FY27 statutory audit.\",\"addressedToPartyId\":\"$DIRECTOR\",\"issuedOn\":\"$LAST_MONTH\",\"effectiveFrom\":\"$LAST_MONTH\"}" | field id)
lline() { asp partner "$API/api/v1/engagement-letters/$LETTER/lines" -d "$1" > /dev/null; }
lline "{\"serviceVersionId\":\"$V_GST\",\"entityPartyId\":\"$COBALT\",\"description\":\"GST monthly filing - Cobalt Foods\",\"quantity\":\"1\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}"
lline "{\"serviceVersionId\":\"$V_GST\",\"entityPartyId\":\"$COBALT_LOG\",\"description\":\"GST monthly filing - Cobalt Logistics\",\"quantity\":\"1\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}"
lline "{\"serviceVersionId\":\"$V_TDS\",\"entityPartyId\":\"$COBALT\",\"description\":\"TDS quarterly return\",\"quantity\":\"1\",\"unitAmount\":\"9000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"quarterly\",\"jurisdiction\":\"IN\"}"
lline "{\"serviceVersionId\":\"$V_BOOK\",\"entityPartyId\":\"$COBALT\",\"description\":\"Bookkeeping and MIS\",\"quantity\":\"1\",\"unitAmount\":\"25000.00\",\"discountPercent\":\"10\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}"
lline "{\"serviceVersionId\":\"$V_AUDIT\",\"entityPartyId\":\"$COBALT\",\"description\":\"Statutory audit FY27\",\"quantity\":\"1\",\"unitAmount\":\"175000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"one_time\",\"jurisdiction\":\"IN\"}"
lline "{\"serviceVersionId\":\"$V_PAY\",\"entityPartyId\":\"$COBALT\",\"description\":\"Payroll processing\",\"quantity\":\"1\",\"unitAmount\":\"12000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}"
for c in governing-law-in confidentiality limitation termination; do
  CV=$(as partner "$API/api/v1/config/clause/$c" | pick "next(v['id'] for v in d['versions'] if v['version']==1)")
  asp partner "$API/api/v1/engagement-letters/$LETTER/clauses" -d "{\"clauseVersionId\":\"$CV\"}" | ok
done
# The signer is asked for only when the deployment signs through DocuSign; the
# demo runs `attested`, which ignores it.
asp partner "$API/api/v1/engagement-letters/$LETTER/send" \
  -d '{"signer":{"name":"Priya Menon","email":"priya.menon@example.com"}}' | ok
asp partner "$API/api/v1/engagement-letters/$LETTER/signature" \
  -d "{\"signedByName\":\"Priya Menon\",\"signedByTitle\":\"Director\",\"signedOn\":\"$LAST_MONTH\"}" | ok
step "signed a month ago — engagements fanned out, one per line"

# ── Billing ──────────────────────────────────────────────────────────────────

say "Billing"
inv() {
  asp partner "$API/api/v1/invoices"     -d "{\"partyId\":\"$COBALT\",\"entityPartyId\":\"$FIRMENT\",\"currency\":\"INR\",\"dueOn\":\"$1\"}" | field id
}
# THE OLD, UNPAID ONE FIRST, so the series runs in date order. Issued through
# the product, due today; then its two dates are moved back as if it had gone
# out three months ago on 15-day terms (src/cmd/demo-history.ts, demo history
# only). The product will not issue an invoice already overdue (B21, audit
# 2026-10-03), which is what this seed used to do.
I3=$(inv "$TODAY")
asp partner "$API/api/v1/invoices/$I3/lines" -d '{"description":"Statutory audit - FY26","quantity":"1","unitAmount":"175000.00","taxPercent":"18"}' | ok
asp partner "$API/api/v1/invoices/$I3/issue" | ok
(cd "$(dirname "$0")/.." && npx tsx src/cmd/demo-history.ts "$I3" 90 75 | sed 's/^/    /')
step "one 75 days overdue: the ladder will climb it to the credit-hold rung"

I1=$(inv "$DUE_SOON")
asp partner "$API/api/v1/invoices/$I1/lines" -d '{"description":"GST monthly filing - April to June","quantity":"6","unitAmount":"6000.00","taxPercent":"18"}' | ok
asp partner "$API/api/v1/invoices/$I1/lines" -d '{"description":"Bookkeeping and MIS - April to June","quantity":"3","unitAmount":"22500.00","taxPercent":"18"}' | ok
asp partner "$API/api/v1/invoices/$I1/issue" | ok
asp partner "$API/api/v1/invoices/$I1/payments" -d "{\"amount\":\"50000.00\",\"receivedOn\":\"$TODAY\",\"method\":\"bank_transfer\",\"reference\":\"UTR8842190\"}" | ok
step "one issued and part paid"

# A DRAFT CANCELLED BEFORE IT WENT OUT. Since 0322 a draft draws no number, so
# this one never took one and the series has no hole; it never reaches the
# client's portal either (F06, 0326).
I2=$(inv "$DUE_SOON")
asp partner "$API/api/v1/invoices/$I2/lines" -d '{"description":"Raised against the wrong entity","quantity":"1","unitAmount":"6000.00","taxPercent":"18"}' | ok
asp partner "$API/api/v1/invoices/$I2/cancel" | ok
step "one drafted against the wrong entity and cancelled before it went out: no number spent"

# ── The engine, run once ─────────────────────────────────────────────────────

say "Running the worker — jobs, the calendar, the ladders"
(cd "$(dirname "$0")/.." && npm run worker:once 2>&1 | sed 's/^/    /') || true

# ── The board ────────────────────────────────────────────────────────────────
#
# Everything above produced work; this makes the BOARD readable. Hand-raised
# tasks are real work too — "prepare the board minutes" has no engagement, no
# process and no template, and is still owned, due and reviewable.

say "The board"
vocab() { as partner "$API/api/v1/work-vocabulary"; }
st()  { vocab | pick "next(s['id'] for s in d['states'] if s['$1'] is True)"; }
stn() { vocab | pick "next(s['id'] for s in d['states'] if s['name']=='$1')"; }
pr()  { vocab | pick "next(p['id'] for p in d['priorities'] if p['code']=='$1')"; }

S_INITIAL=$(st isInitial)
S_BLOCKED=$(st isBlocked)
S_DONE=$(vocab | pick "next(s['id'] for s in d['states'] if s['isTerminal'] and s['isSuccess'])")
S_PROGRESS=$(vocab | pick "next((s['id'] for s in d['states'] if not s['isTerminal'] and not s['isBlocked'] and not s['isInitial']), None)")
P_HIGH=$(vocab | pick "min(d['priorities'], key=lambda p: p['rank'])['id']")

task() { asp partner "$API/api/v1/work-items" -d "$1" | field id; }

# LATE, and on Ananya's desk. Two rungs of the ladder have already passed it.
W_LATE=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"GSTR-3B - Cobalt Foods - July\",\"description\":\"2B reconciled; the portal rejected the first upload and it has not been retried.\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$ANANYA_ID\",\"dueOn\":\"$LAST_WEEK\",\"isStatutoryDue\":true}")
asp partner "$API/api/v1/work-items/$W_LATE/checklist" -d '{"label":"Download 2B"}' | ok
asp partner "$API/api/v1/work-items/$W_LATE/checklist" -d '{"label":"Reconcile against the purchase register"}' | ok
asp partner "$API/api/v1/work-items/$W_LATE/checklist" -d '{"label":"Upload GSTR-1"}' | ok
asp partner "$API/api/v1/work-items/$W_LATE/checklist" -d '{"label":"File GSTR-3B"}' | ok
CL1=$(as partner "$API/api/v1/work-items/$W_LATE" | pick "d['checklist'][0]['id']")
CL2=$(as partner "$API/api/v1/work-items/$W_LATE" | pick "d['checklist'][1]['id']")
asp partner "$API/api/v1/work-items/$W_LATE/checklist/$CL1" -d '{"done":true}' | ok
asp partner "$API/api/v1/work-items/$W_LATE/checklist/$CL2" -d '{"done":true}' | ok
step "GSTR-3B July — a week late, 2 of 4 ticked, on Ananya's desk"

# LATE, and on FARHAN's desk — who reports to nobody. This is the escalation
# that reaches NOBODY, and it is the row the board marks in danger tone.
W_NOBODY=$(task "{\"clientPartyId\":\"$LAKEVIEW\",\"entityPartyId\":\"$LAKEVIEW\",\"title\":\"TDS 26Q - Lakeview - Q1\",\"description\":\"Challans matched; the return has not been uploaded.\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$FARHAN_ID\",\"dueOn\":\"$LAST_WEEK\",\"isStatutoryDue\":true}")
step "TDS 26Q Q1 — a week late, on Farhan's desk"

# BLOCKED, with the written reason the service and a trigger both insist on.
W_BLOCKED=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT_LOG\",\"title\":\"GSTR-3B - Cobalt Logistics - July\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$ANANYA_ID\",\"dueOn\":\"$YESTERDAY\",\"isStatutoryDue\":true}")
asp partner "$API/api/v1/work-items/$W_BLOCKED/state" \
  -d "{\"stateId\":\"$S_BLOCKED\",\"blockedReason\":\"The client has not shared the Maharashtra purchase register. Chased on the 3rd and the 9th.\"}" | ok
step "Cobalt Logistics July — blocked, with the reason on the card"

# ONE THAT DEPENDS ON ANOTHER. Starting is refused while it is unfinished —
# that is what a dependency SAYS.
W_DEP=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"File the July acknowledgement\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$ANANYA_ID\",\"dueOn\":\"$TODAY\"}")
asp partner "$API/api/v1/work-items/$W_DEP/dependencies" -d "{\"dependsOnWorkItemId\":\"$W_LATE\"}" | ok
step "…and one waiting on it"

# IN REVIEW. Ananya did it, so Ananya may not check it — the database refuses
# it. It goes to Ravi, who is a manager.
W_REVIEW=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"Management pack - June\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$ANANYA_ID\",\"dueOn\":\"$YESTERDAY\"}")
asp ananya "$API/api/v1/work-items/$W_REVIEW/review" -d '{}' | ok
step "Management pack June — waiting to be checked (Ananya made it, so Ananya cannot)"

# DONE, so the board has something behind the "include finished work" switch.
W_DONE=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"GSTR-3B - Cobalt Foods - June\",\"assigneeUserId\":\"$ANANYA_ID\",\"dueOn\":\"$LAST_MONTH\",\"isStatutoryDue\":true}")
asp partner "$API/api/v1/work-items/$W_DONE/state" -d "{\"stateId\":\"$S_DONE\"}" | ok
step "GSTR-3B June — filed, behind the finished-work switch"

# IN PROGRESS, on the manager's own desk, so "Mine" is not empty for Ravi.
W_RAVI=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"FY27 audit planning memo\",\"assigneeUserId\":\"$MANAGER_ID\",\"dueOn\":\"$NEXT_MONTH\"}")
if [ "$S_PROGRESS" != "None" ]; then
  asp partner "$API/api/v1/work-items/$W_RAVI/state" -d "{\"stateId\":\"$S_PROGRESS\"}" | ok
fi
step "FY27 audit planning memo — with Ravi, in progress"

# ON THE PARTNER'S OWN DESK. Without these, signing in as Siddharth opens the
# board on an EMPTY "Mine" tab — which is the correct answer for a partner who
# holds no tasks, and a poor first thing to show. A partner really does hold
# work: the things only a partner may sign.
W_P1=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"Sign off the FY27 audit engagement\",\"description\":\"Independence confirmation and the engagement quality review before fieldwork opens.\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$PARTNER_ID\",\"dueOn\":\"$DUE_SOON\"}")
W_P2=$(task "{\"clientPartyId\":\"$LAKEVIEW\",\"entityPartyId\":\"$LAKEVIEW\",\"title\":\"Price the Lakeview audit before the proposal goes out\",\"assigneeUserId\":\"$PARTNER_ID\",\"dueOn\":\"$YESTERDAY\"}")
# NOT CLIENT-VISIBLE, and it is the row that shows why that flag exists (T6.5).
# `is_client_visible` defaults TRUE — the client's own answer, "clients would be
# able to see their tasks" — and the exceptions are MARKED rather than the rule
# inverted. This is an exception: deciding whether to put a client on credit hold
# is the firm talking to itself about that client's money, and the description
# names the rung the ladder stopped on. Walking the portal is what found it
# sitting on Meera's page.
W_P3=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"Decide the credit hold on INV/2026-27/0003\",\"description\":\"75 days overdue. The ladder has climbed to the credit-hold rung and stopped - only a partner may apply it.\",\"priorityId\":\"$P_HIGH\",\"assigneeUserId\":\"$PARTNER_ID\",\"dueOn\":\"$TODAY\",\"isClientVisible\":false}")
step "three on Siddharth's own desk - one late, one due today, one the client cannot see"

# ── WHAT THE FIRM IS WAITING ON THE CLIENT FOR (T6.6) ──────────────────────
#
# Three asks on Meera's action centre, one per kind, so the portal's three
# controls all have something to draw — and one of them ALREADY ANSWERED, so
# "with the firm" is not an empty heading either.
#
# THE FIRST ONE IS THE POINT OF THE WHOLE TASK. `W_BLOCKED` above carries the
# blocked reason *"The client has not shared the Maharashtra purchase register"*,
# and until now that sentence was the only thing on the client's page saying what
# was wanted — under a heading that read HELD UP, because nothing in the schema
# recorded who a task was waiting on. Now the same task carries a row that says
# it, addressed to Meera, with somewhere to answer it. The blocked reason stays:
# the two are different facts and the firm may be waiting on more than one thing.
ask() { asp partner "$API/api/v1/work-items/$1/asks" -d "$2" | pick "d['askId']"; }

A_REGISTER=$(ask "$W_BLOCKED" '{"askKind":"document","documentKind":"working_paper","prompt":"Please send the Maharashtra purchase register for July - a PDF or an Excel export is fine."}')
A_QUESTION=$(ask "$W_LATE" '{"askKind":"question","prompt":"Two invoices from Nashik Traders are not in your 2B. Were they cancelled, or is the supplier late in filing?"}')
A_APPROVE=$(ask "$W_REVIEW" '{"askKind":"approval","prompt":"May we file the June management pack as it stands? It shows the Nashik write-off as an exceptional item."}')

# ANSWERED, NOT CLOSED — the distinction the status column exists for. Meera
# replied; the firm has not said it was what it needed, so the ask sits under
# "with the firm" on her page and stays open on the task.
asp client "$API/api/v1/portal/asks/$A_QUESTION/answer"   -d '{"answerText":"Both were cancelled in July. Nashik Traders has issued credit notes - I will send them if you need them."}' | ok
step "three asks on Meera's action centre, one of them already answered"

# UNASSIGNED, and OLD, so the unassigned rungs of the ladder have fired.
W_HARBOUR=$(task "{\"clientPartyId\":\"$HARBOUR\",\"entityPartyId\":\"$HARBOUR\",\"title\":\"Onboarding - collect Harbour's incorporation papers\",\"description\":\"Nothing can be filed for this client until it is registered as a legal entity.\",\"dueOn\":\"$LAST_WEEK\"}")
step "Harbour onboarding - a week late, and nobody holds it"

W_ORPHAN=$(task "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"FY27 statutory audit - open the file\",\"description\":\"Audit is filed under RAA and this client has no SPOC there.\",\"dueOn\":\"$DUE_SOON\"}")
step "FY27 audit — nobody holds it"

# ── One filing actually MADE ─────────────────────────────────────────────────
#
# Everything above leaves the calendar entirely unfiled, so every screen that
# shows finished compliance work — the client portal's "recently filed" among
# them — renders empty at a firm that has been running for a month. That is not
# what the demo is showing.
#
# It goes through the PRODUCT's own path and not a psql UPDATE: a person ticks
# the TASK, and `reconcileFiling` (0054) closes the obligation behind it. Filing
# is not something anybody marks twice, and this is the demo of that.
say "One filing actually made"
# FROM THE CALENDAR, not from the board. The board's own statutory rows include
# the hand-raised "GSTR-3B - Cobalt Foods - July" above, which carries the
# statutory flag and NO obligation behind it — ticking that one moves a card and
# files nothing, which is exactly what the first version of this step did.
# `workItemId` on a calendar row is the link that makes the tick reach a filing.
FILED_TASK=$(as partner "$API/api/v1/calendar" | pick "next((r['workItemId'] for r in d['rows'] if r['workItemId'] and r['entityName'].startswith('Cobalt Foods')), None)")
if [ "$FILED_TASK" != "None" ]; then
  asp partner "$API/api/v1/work-items/$FILED_TASK/state" -d "{\"stateId\":\"$S_DONE\"}" | ok
  step "a statutory task ticked - and the calendar entry behind it now says Filed"
else
  warn "no statutory task to tick - the calendar raised none"
fi

# ── AND THE CHALLAN ITSELF, so the library has something in it (T6.7) ───────
#
# T6.7's acceptance line is *"a client finds last year's challan without emailing
# anyone"*, and until this the demo had no documents AT ALL — the library would
# have rendered empty and the walk would have proved nothing.
#
# It goes through the PRODUCT's own upload route, so `is_client_visible` is set
# the way it is set for every other document: by `clientVisibleByDefault(kind)`,
# which is TRUE for a `statutory_filing`. Nothing here passes that flag, and
# nothing can — it is not on the form. A `working_paper` uploaded the same way
# would land invisible, which is the other half of the same decision and is what
# migration 0066 exists for.
#
# Attached to the WORK ITEM, which is how a filing's document reaches the client
# with a label they recognise: the task's title carries the period.
if [ "$FILED_TASK" != "None" ]; then
  # THE TITLE NAMES NO PARTICULAR RETURN, and that is not laziness.
  # `FILED_TASK` is whatever the calendar happened to raise and tick for
  # Cobalt Foods — it was a TDS statement on this run and may be a GSTR-3B
  # on the next. The first version of this file called it a GSTR-3B
  # acknowledgement and the portal rendered it under "Quarterly TDS
  # statements — Q1 FY2026-27", which is a document contradicting the job it
  # is filed against on a CLIENT's own page. The link already carries the
  # period; the title says what the thing IS.
  CHALLAN_FILE="$J/filing-acknowledgement.txt"
  printf 'Filing acknowledgement
ARN AA2708260012345
Cobalt Foods Private Limited
' > "$CHALLAN_FILE"
  curl -s -b "$J/partner.txt" -XPOST "$API/api/v1/documents"     -F "file=@$CHALLAN_FILE"     -F "title=Filing acknowledgement"     -F "kind=statutory_filing"     -F "partyId=$COBALT"     -F "subjectKind=work_item"     -F "subjectRef=$FILED_TASK"     -F "role=filed_copy" | ok
  step "the filed challan, in the client's own library — visible because of what it IS"

  # THE OTHER HALF, and it is what makes the first half mean anything. A working
  # paper about the same client, uploaded the same way, lands INVISIBLE — so the
  # walk can open the portal library and see that the firm's own thinking about
  # this client is not in it.
  WP_FILE="$J/open-queries.txt"
  printf 'Open queries - Cobalt Foods FY26
1. Nashik write-off: partner to confirm treatment
' > "$WP_FILE"
  curl -s -b "$J/partner.txt" -XPOST "$API/api/v1/documents"     -F "file=@$WP_FILE"     -F "title=Open queries - Cobalt FY26"     -F "kind=working_paper"     -F "partyId=$COBALT"     -F "subjectKind=work_item"     -F "subjectRef=$FILED_TASK" | ok
  step "and a working paper about the same client, which the client cannot see"
fi

say "Running the worker again, so the ladders have climbed the new work"
(cd "$(dirname "$0")/.." && npm run worker:once 2>&1 | sed 's/^/    /') || true

# ── What is actually there ───────────────────────────────────────────────────

say "What the firm now looks like"

# NO `|| echo 0` ON ANY OF THESE. The first version had one on every line and
# it read the wrong key on three of them — `escalations` answers `rows`, so did
# `calendar`, and coverage answers `gaps` — so the summary reported "0
# escalation notices" at a firm holding 56 of them, and the run looked clean.
# A summary that cannot fail is a summary nobody can trust. `pick` stops the
# script now, which is the whole point of it.
n() { as partner "$API$1" | pick "len(d['$2'])"; }

BOARD=$(as partner "$API/api/v1/work-items?includeDone=true" | pick "len(d['items'])")
ESCAL=$(n /api/v1/escalations rows)
# A rung that reached NOBODY: no assignee to tell, no manager recorded, or no
# active member holding the rank it names. These are the rows a partner has to
# act on, and every other row already has a name against it.
NOBODY=$(as partner "$API/api/v1/escalations" | pick "sum(1 for e in d['rows'] if e['raisedTo'] is None and e['target'] != 'grade_at_least')")
GRADE=$(as partner "$API/api/v1/escalations" | pick "sum(1 for e in d['rows'] if e['target'] == 'grade_at_least')")
CAL=$(n /api/v1/calendar rows)
UNCOV=$(n /api/v1/calendar/coverage gaps)
JOBS=$(n /api/v1/jobs jobs)
CHECKS=$(n /api/v1/work-item-checks checks)
PENDING=$(n /api/v1/dunning/pending actions)
RULES=$(n /api/v1/obligation-rules rules)
WAITING=$(as partner "$API/api/v1/obligation-rules" | pick "sum(1 for r in d['rules'] if r.get('unresolvedReason'))")
UNASSIGNED=$(as partner "$API/api/v1/work-items" | pick "sum(1 for i in d['items'] if i['assignee'] is None)")

printf '  %-36s %s
' "work items on the board"          "$BOARD"
printf '  %-36s %s
' "  …on nobody's desk"              "$UNASSIGNED"
printf '  %-36s %s
' "jobs the engine is walking"       "$JOBS"
printf '  %-36s %s
' "waiting to be checked"            "$CHECKS"
printf '  %-36s %s
' "escalation notices"               "$ESCAL"
printf '  %-36s %s
' "  …addressed to a RANK"           "$GRADE"
printf '  %-36s %s
' "  …that reached NOBODY"           "$NOBODY"
printf '  %-36s %s
' "filings on the calendar"          "$CAL"
printf '  %-36s %s
' "engagements with NO calendar"     "$UNCOV"
printf '  %-36s %s
' "compliance rules"                 "$RULES"
printf '  %-36s %s
' "  …waiting on a fact"             "$WAITING"
printf '  %-36s %s
' "dunning decisions for a partner"  "$PENDING"

cat <<EOF

───────────────────────────────────────────────────────────────────────────
  10x Global is ready.   $(date '+%H:%M')

  App        http://localhost:3000
  Password   $PASSWORD   (all five)

  Siddharth Rao   partner     siddharth@$DOMAIN
  Ravi Iyer       manager     ravi@$DOMAIN
  Ananya Nair     associate   ananya@$DOMAIN        ← no fee visibility
  Farhan Qureshi  associate   farhan@$DOMAIN        ← no fee visibility, no manager
  Meera Menon     portal      meera@cobaltfoods.in

  THE PROBLEM CORNER — all deliberate, all worth showing:
    · Harbour has no SPOC at all        → its work goes to Ravi (Key Manager) to hand out
    · Lakeview has TWO SPOCs on TRC     → the router refuses to choose
    · Farhan reports to nobody          → his escalations reach NOBODY
    · Harbour Provisions is unregistered → its calendar is empty, with a reason
    · $WAITING shipped rules have no formula   → the calendar's coverage tab
    · one invoice is 75 days overdue    → a credit hold waiting on a partner

  Sign in as Siddharth.
───────────────────────────────────────────────────────────────────────────
EOF
