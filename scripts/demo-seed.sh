#!/usr/bin/env bash
#
# Seed a PRESENTABLE firm for a live demo.
#
# This is not the smoke walk. Smoke proves properties and leaves behind names
# like "Rotation Prospect 7 Private Limited"; this leaves behind a firm you can
# put on a projector — real-looking clients, a signed engagement letter, an
# invoice half paid, and one overdue debt sitting on a partner's desk waiting
# for a decision.
#
# Every screen in the app has something to show when this finishes. It also
# leaves room to CREATE things live: the catalogue, the standard prose and the
# territories are set up, so drafting a second proposal on stage works.
#
#   ./scripts/demo-seed.sh          # against a running API on :8080
#
# It prints the logins at the end. Run it again for a fresh firm — each run
# makes its own, so a demo that goes sideways is one re-run away from clean.
set -euo pipefail

API=${API:-http://localhost:8080}
H='content-type: application/json'
KEY=${BIB_DEMO_KEY:-local-dev-internal-key-not-for-any-real-environment}
A="authorization: Bearer $KEY"
PASSWORD=${BIB_DEMO_PASSWORD:-'10x Global demo 2026'}

S=$(date +%s)
J=$(mktemp -d)
trap 'rm -rf "$J"' EXIT

# Dates the demo depends on: an invoice must be genuinely overdue for the
# dunning ladder to have climbed it.
TODAY=$(python3 -c 'import datetime;print(datetime.date.today().isoformat())')
LONG_AGO=$(python3 -c 'import datetime;print((datetime.date.today()-datetime.timedelta(days=75)).isoformat())')
DUE_SOON=$(python3 -c 'import datetime;print((datetime.date.today()+datetime.timedelta(days=14)).isoformat())')

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
step() { printf '  · %s\n' "$1"; }

# Read one field out of a JSON response, and STOP if it is not there.
#
# Without this the script cheerfully carries on with an empty id and builds a
# half-firm that looks fine until the demo opens the one screen that is broken.
# The overwhelmingly common cause is the rate limiter: this makes ~120 requests
# in a few seconds and shares a 300-a-minute budget with `npm run smoke`.
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
    sys.exit("\n  the API did not return JSON:\n  " + raw[:200])
if want not in body:
    err = body.get("error", {}) if isinstance(body, dict) else {}
    note = ""
    if err.get("code") == "RATE_LIMITED":
        note = ("\n\n  RATE LIMITED. This script and `npm run smoke` share one budget"
                "\n  of 300 requests a minute from one address. Wait 60 seconds,"
                "\n  then run it again.")
    sys.exit("\n  expected %r in the response and it was not there."
             "\n  the API said: %s%s" % (want, err.get("message") or raw[:200], note))
print(body[want])' "$1"
}

post()  { curl -s -XPOST "$API$1" -H "$H" -H "$A" -d "$2"; }
as()    { curl -s -b "$J/$1.txt" "${@:2}"; }
asp()   { curl -s -b "$J/$1.txt" -XPOST -H "$H" "${@:2}"; }

say "Provisioning the firm"
T=$(post /internal/v1/tenants "{\"name\":\"10x Global\",\"slug\":\"10x-global-$S\",\"reportingCurrency\":\"INR\"}" | field id)
step "10x Global — books in INR"

# Four people, and the roles are the firm's own seeded set.
mkperson() {
  local label=$1 email=$2 role=$3 audience=$4 fees=$5
  local u
  u=$(post /internal/v1/users "{\"email\":\"$email\"}" | field id)
  post /internal/v1/memberships \
    "{\"tenantId\":\"$T\",\"userId\":\"$u\",\"audience\":\"$audience\",\"role\":\"$role\",\"commercialVisibility\":$fees}" > /dev/null
  curl -s -o /dev/null -XPUT "$API/internal/v1/users/$u/password" -H "$H" -H "$A" -d "{\"password\":\"$PASSWORD\"}"
  curl -s -c "$J/$label.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  echo "$u" > "$J/$label.id"
  step "$email — $role"
}

PARTNER_EMAIL="siddharth-$S@10xglobal.example"
MANAGER_EMAIL="ravi-$S@10xglobal.example"
ASSOCIATE_EMAIL="ananya-$S@10xglobal.example"
CLIENT_EMAIL="finance-$S@cobaltfoods.example"

mkperson partner   "$PARTNER_EMAIL"   partner        STAFF         true
mkperson manager   "$MANAGER_EMAIL"   manager        STAFF         true
mkperson associate "$ASSOCIATE_EMAIL" associate      STAFF         false
mkperson client    "$CLIENT_EMAIL"    client_contact CLIENT_PORTAL false

say "The firm's own entity, and where it is registered"
# G1.8 needs this: a governing-law clause is refused on a letter issued by an
# entity with no registered jurisdiction, because there is nothing to check it
# against. Every firm starts in that state.
FIRMENT=$(as partner "$API/api/v1/firm-entities/preferences" | python3 -c '
import sys, json
print(next(p["firmEntityPartyId"] for p in json.load(sys.stdin)["preferences"] if p["clientJurisdiction"] == "*"))')
asp partner "$API/api/v1/parties/organizations/$FIRMENT/legal-entities" \
  -d '{"jurisdiction":"IN","entityType":"private_limited"}' > /dev/null
step "10x Global registered in IN"

say "What the firm sells"
service() {
  asp partner "$API/api/v1/config/service" -d "$1" > /dev/null
  local key
  key=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])' <<< "$1")
  asp partner "$API/api/v1/config/service/$key/versions/1/publish" > /dev/null
  step "$(python3 -c 'import sys,json;print(json.load(sys.stdin)["body"]["name"])' <<< "$1")"
}
service '{"key":"gst-monthly","body":{"name":"GST monthly filing","ref":"A1","module":"TRC","group":"FINCOMPLIANCE","description":"GSTR-1 and GSTR-3B, monthly.","billingBasis":"fixed","recurrence":"monthly","slaDays":10,"listPrice":{"amount":"6000.00","currency":"INR"},"jurisdictions":["IN"],"scope":"Preparation and filing of GSTR-1 and GSTR-3B from books provided by the client.","clientObligations":"Books closed and shared by the 5th of the following month.","volumeLimits":"Up to 200 invoices a month.","exclusions":"Departmental representation, refunds and annual return."}}'
service '{"key":"tds-quarterly","body":{"name":"TDS quarterly return","ref":"A4","module":"TRC","group":"FINCOMPLIANCE","description":"Form 24Q and 26Q.","billingBasis":"fixed","recurrence":"quarterly","slaDays":15,"listPrice":{"amount":"9000.00","currency":"INR"},"jurisdictions":["IN"]}}'
service '{"key":"statutory-audit","body":{"name":"Statutory audit","ref":"R1","module":"RAA","group":"AUDIT","description":"Audit under the Companies Act.","billingBasis":"fixed","recurrence":"year","slaDays":60,"listPrice":{"amount":"175000.00","currency":"INR"},"jurisdictions":["IN"]}}'
service '{"key":"bookkeeping","body":{"name":"Bookkeeping and MIS","ref":"F2","module":"FRC","group":"VCFO CONSOLE","description":"Monthly bookkeeping with a management pack.","billingBasis":"retainer","recurrence":"monthly","slaDays":12,"listPrice":{"amount":"25000.00","currency":"INR"}}}'

say "The rules the firm runs on"
asp partner "$API/api/v1/config/policy" -d '{"key":"discount","body":{"maxDiscountPercent":"15"}}' > /dev/null
asp partner "$API/api/v1/config/policy/discount/versions/1/publish" > /dev/null
step "discounts over 15% need a partner"

# The ladder the worker climbs. The last two rungs are the ones it may reach
# and may NOT apply — those wait for a person.
# The key MUST be `default` — that is the one the sweep reads.
asp partner "$API/api/v1/config/dunning" -d '{"key":"default","body":{"steps":[
  {"key":"first-reminder","label":"First reminder","afterDays":3,"action":"reminder"},
  {"key":"second-reminder","label":"Second reminder","afterDays":7,"action":"reminder"},
  {"key":"call-the-client","label":"Call the client","afterDays":15,"action":"call"},
  {"key":"credit-hold","label":"Put the client on credit hold","afterDays":45,"action":"credit_hold"},
  {"key":"legal","label":"Refer to lawyers","afterDays":90,"action":"legal"}]}}' > /dev/null
asp partner "$API/api/v1/config/dunning/default/versions/1/publish" > /dev/null
step "dunning: D+3, D+7, D+15, then credit hold at D+45 (partner decides)"

say "The clauses a letter is written from"
clause() {
  asp partner "$API/api/v1/config/clause" -d "$1" > /dev/null
  local key; key=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])' <<< "$1")
  asp partner "$API/api/v1/config/clause/$key/versions/1/publish" > /dev/null
  step "$(python3 -c 'import sys,json;print(json.load(sys.stdin)["body"]["title"])' <<< "$1")"
}
clause '{"key":"governing-law-in","body":{"title":"Governing law and jurisdiction","text":"This engagement is governed by the laws of the Republic of India, and the courts at Bengaluru have exclusive jurisdiction.","jurisdictions":[],"governingLaw":{"jurisdiction":"IN","text":"the laws of the Republic of India"},"courts":{"jurisdiction":"IN","text":"the courts at Bengaluru"}}}'
clause '{"key":"confidentiality","body":{"title":"Confidentiality","text":"Each party keeps the other in confidence, and neither discloses the other'"'"'s information without consent.","jurisdictions":[]}}'
clause '{"key":"limitation","body":{"title":"Limitation of liability","text":"Liability under this engagement is limited to the fees paid for it.","jurisdictions":[]}}'

say "The prose every document is written with"
block() { asp partner "$API/api/v1/document-blocks/standard" -d "$1" > /dev/null; }
block '{"kind":"exclusion","body":"Statutory fees, filing fees and stamp duty are not included.","sortOrder":1}'
block '{"kind":"exclusion","body":"Representation before any court or tribunal.","sortOrder":2}'
block '{"kind":"exclusion","body":"Any period before the effective date of this engagement.","sortOrder":3}'
block '{"kind":"commercial","body":"All fees are exclusive of GST as applicable.","sortOrder":1,"jurisdiction":"IN"}'
block '{"kind":"commercial","body":"Invoices are payable within 14 days.","sortOrder":2}'
block '{"kind":"team","body":"Engagement Partner","sortOrder":1,"isHeading":true}'
block '{"kind":"team","body":"Siddharth — signs off every filing.","sortOrder":2}'
block '{"kind":"team","body":"Delivery Team","sortOrder":3,"isHeading":true}'
block '{"kind":"team","body":"Ravi (Manager) and Ananya (Associate).","sortOrder":4}'
step "3 exclusions, 2 commercial notes (one India-only), a team block"

say "Territories"
asp partner "$API/api/v1/territory-rules" \
  -d "{\"jurisdiction\":\"GB\",\"ownerUserId\":\"$(cat "$J/manager.id")\",\"note\":\"Ravi covers the UK desk\"}" > /dev/null
step "GB → Ravi. Everywhere else falls to the rotation."

say "The book"
org() {
  local id
  id=$(asp partner "$API/api/v1/parties/organizations" -d "{\"legalName\":\"$1\"}" | field partyId)
  echo "$id"
}
COBALT=$(org "Cobalt Foods Private Limited")
asp partner "$API/api/v1/parties/organizations/$COBALT/legal-entities" -d '{"jurisdiction":"IN","entityType":"private_limited","incorporatedOn":"2019-06-11","financialYearEnd":"03-31"}' > /dev/null
asp partner "$API/api/v1/parties/$COBALT/identifiers" -d '{"type":"pan","value":"AAACC1234F","validFrom":"2019-06-11"}' > /dev/null
asp partner "$API/api/v1/parties/$COBALT/identifiers" -d '{"type":"gstin","value":"29AAACC1234F1Z5","validFrom":"2019-07-01"}' > /dev/null
step "Cobalt Foods Private Limited — PAN and a Karnataka GSTIN"

LAKEVIEW=$(org "Lakeview Organics Private Limited")
asp partner "$API/api/v1/parties/organizations/$LAKEVIEW/legal-entities" -d '{"jurisdiction":"IN","entityType":"private_limited"}' > /dev/null
asp partner "$API/api/v1/parties/$LAKEVIEW/identifiers" -d '{"type":"pan","value":"AAACL5678M","validFrom":"2021-02-01"}' > /dev/null
step "Lakeview Organics Private Limited"

DIRECTOR=$(asp partner "$API/api/v1/parties/persons" -d '{"fullName":"Priya Menon"}' | field partyId)
asp partner "$API/api/v1/parties/relationships" \
  -d "{\"fromPartyId\":\"$DIRECTOR\",\"toPartyId\":\"$COBALT\",\"type\":\"director_of\",\"validFrom\":\"2019-06-11\"}" > /dev/null
step "Priya Menon — director of Cobalt since 2019"

say "The pipeline"
asp partner "$API/api/v1/leads" -d "{\"source\":\"referral\",\"title\":\"FY27 statutory audit\",\"kind\":\"organization\",\"name\":\"Lakeview Organics Private Limited\",\"jurisdiction\":\"IN\",\"identifiers\":[{\"type\":\"pan\",\"value\":\"AAACL5678M\"}]}" > /dev/null
step "a referral, deduplicated onto Lakeview by PAN"
asp partner "$API/api/v1/leads" -d '{"source":"inbound","title":"UK holding company setup","kind":"organization","name":"Thames Provisions Ltd","jurisdiction":"GB","identifiers":[{"type":"email","value":"ops@thamesprovisions.example"}]}' > /dev/null
step "a UK lead — the territory rule puts it on Ravi's desk"

say "A quote, agreed"
GSTV=$(as partner "$API/api/v1/config/service/gst-monthly" | python3 -c 'import sys,json;print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"]==1))')
BOOKV=$(as partner "$API/api/v1/config/service/bookkeeping" | python3 -c 'import sys,json;print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"]==1))')
PROP=$(asp partner "$API/api/v1/proposals" -d "{\"partyId\":\"$COBALT\",\"title\":\"Cobalt Foods — FY27 compliance\",\"clientJurisdiction\":\"IN\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\"}" | field id)
asp partner "$API/api/v1/proposals/$PROP/lines" -d "{\"serviceVersionId\":\"$GSTV\",\"entityPartyId\":\"$COBALT\",\"description\":\"GST monthly filing, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"jurisdiction\":\"IN\"}" > /dev/null
asp partner "$API/api/v1/proposals/$PROP/lines" -d "{\"serviceVersionId\":\"$BOOKV\",\"entityPartyId\":\"$COBALT\",\"description\":\"Bookkeeping and MIS, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"25000.00\",\"discountPercent\":\"10\",\"jurisdiction\":\"IN\"}" > /dev/null
asp partner "$API/api/v1/proposals/$PROP/send" > /dev/null
asp partner "$API/api/v1/proposals/$PROP/decision" -d '{"decision":"accepted"}' > /dev/null
step "sent and accepted — PR number allocated"

say "The letter that creates the work"
LETTER=$(asp partner "$API/api/v1/engagement-letters" -d "{\"partyId\":\"$COBALT\",\"proposalId\":\"$PROP\",\"jurisdiction\":\"IN\",\"title\":\"Cobalt Foods — FY27 engagement\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\",\"background\":\"10x Global has been asked to take on Cobalt Foods' indirect tax compliance and monthly bookkeeping for FY 2026-27.\",\"addressedToPartyId\":\"$DIRECTOR\",\"issuedOn\":\"$TODAY\",\"effectiveFrom\":\"$TODAY\"}" | field id)
asp partner "$API/api/v1/engagement-letters/$LETTER/lines" -d "{\"serviceVersionId\":\"$GSTV\",\"entityPartyId\":\"$COBALT\",\"description\":\"GST monthly filing, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"6000.00\",\"discountPercent\":\"0\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}" > /dev/null
asp partner "$API/api/v1/engagement-letters/$LETTER/lines" -d "{\"serviceVersionId\":\"$BOOKV\",\"entityPartyId\":\"$COBALT\",\"description\":\"Bookkeeping and MIS, 12 months\",\"quantity\":\"12\",\"unitAmount\":\"25000.00\",\"discountPercent\":\"10\",\"billingFrequency\":\"monthly\",\"jurisdiction\":\"IN\"}" > /dev/null
for c in governing-law-in confidentiality limitation; do
  CV=$(as partner "$API/api/v1/config/clause/$c" | python3 -c 'import sys,json;print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"]==1))')
  asp partner "$API/api/v1/engagement-letters/$LETTER/clauses" -d "{\"clauseVersionId\":\"$CV\"}" > /dev/null
done
asp partner "$API/api/v1/engagement-letters/$LETTER/send" > /dev/null
asp partner "$API/api/v1/engagement-letters/$LETTER/signature" -d '{"signedByName":"Priya Menon","signedByTitle":"Director"}' > /dev/null
step "signed — engagements fanned out, one per line"

say "Billing"
inv() {
  asp partner "$API/api/v1/invoices" \
    -d "{\"partyId\":\"$COBALT\",\"entityPartyId\":\"$FIRMENT\",\"currency\":\"INR\",\"fxRate\":\"1\",\"fxRateDate\":\"$TODAY\",\"dueOn\":\"$1\",\"seriesDate\":\"$2\"}" | field id
}
# 1 — issued, part paid. The balance is a sum, and this shows it moving.
I1=$(inv "$DUE_SOON" "$TODAY")
asp partner "$API/api/v1/invoices/$I1/lines" -d '{"description":"GST monthly filing — April to June","quantity":"3","unitAmount":"6000.00","taxPercent":"18"}' > /dev/null
asp partner "$API/api/v1/invoices/$I1/lines" -d '{"description":"Bookkeeping and MIS — April to June","quantity":"3","unitAmount":"22500.00","taxPercent":"18"}' > /dev/null
asp partner "$API/api/v1/invoices/$I1/issue" > /dev/null
asp partner "$API/api/v1/invoices/$I1/payments" -d "{\"amount\":\"50000.00\",\"receivedOn\":\"$TODAY\",\"method\":\"bank_transfer\",\"reference\":\"UTR8842190\"}" > /dev/null
step "one issued and part paid"

# 2 — CANCELLED, and deliberately in the MIDDLE of the series. This is the
# demo's sharpest single fact: 0002 is withdrawn, keeps its number, and 0003
# follows it. A consecutive series with nothing missing is what an auditor
# checks, and a cancelled invoice is how you show where a number went.
I2=$(inv "$DUE_SOON" "$TODAY")
asp partner "$API/api/v1/invoices/$I2/lines" -d '{"description":"Raised against the wrong entity","quantity":"1","unitAmount":"6000.00","taxPercent":"18"}' > /dev/null
asp partner "$API/api/v1/invoices/$I2/cancel" > /dev/null
step "one cancelled — it KEEPS its number, in the middle of the series"

# 3 — genuinely overdue, so the ladder has something to climb.
I3=$(inv "$LONG_AGO" "$LONG_AGO")
asp partner "$API/api/v1/invoices/$I3/lines" -d '{"description":"Statutory audit — FY26","quantity":"1","unitAmount":"175000.00","taxPercent":"18"}' > /dev/null
asp partner "$API/api/v1/invoices/$I3/issue" > /dev/null
step "one 75 days overdue — the ladder will climb it"

say "Running the worker once, so the ladder has climbed"
(cd "$(dirname "$0")/.." && npm run worker:once > /dev/null 2>&1) || true
PENDING=$(as partner "$API/api/v1/dunning/pending" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["actions"]))')
step "$PENDING decision(s) now waiting for a partner"

cat <<EOF

───────────────────────────────────────────────────────────────────
  10x Global is ready.   $(date '+%H:%M')

  App        http://localhost:3000
  Password   $PASSWORD   (all four)

  Siddharth (partner)    $PARTNER_EMAIL
  Ravi (manager)         $MANAGER_EMAIL
  Ananya (associate)     $ASSOCIATE_EMAIL      ← no fee visibility
  Cobalt finance         $CLIENT_EMAIL   ← client portal

  Sign in as Siddharth. The runbook is docs/DEMO.md.
───────────────────────────────────────────────────────────────────
EOF
