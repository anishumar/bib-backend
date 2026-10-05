#!/usr/bin/env bash
# G3.2 end to end, through the real API: a client gets an account team, the Key
# Manager is handed over, and "who was the SPOC in March" is asked and answered.
#
# What this proves that a unit test cannot: the routes exist, they are reachable
# with the permission the table says, the wire shape carries NAMES rather than
# uuids, and the handover really is two contiguous rows in Postgres rather than
# an edit that happens to look right in a fake.
#
# Leaves a firm behind with three logins printed, for opening the screens.
set -euo pipefail
API=http://localhost:8080
H='content-type: application/json'
KEY=local-dev-internal-key-not-for-any-real-environment
A="authorization: Bearer $KEY"
PW='10x Global demo 2026'
S=$(date +%s)
J=$(mktemp -d); trap 'rm -rf "$J"' EXIT
pass=0; fail=0
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" < "$J/body"; }
call() { local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then curl -s -b "$J/p.txt" -c "$J/p.txt" -o "$J/body" -w '%{http_code}' -X "$m" "$API$p" -H "$H" -d "$b" > "$J/st"
  else curl -s -b "$J/p.txt" -c "$J/p.txt" -o "$J/body" -w '%{http_code}' -X "$m" "$API$p" > "$J/st"; fi
  cat "$J/st"; }
ok() { # ok <label> <got> <want>
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-52s %s\n' "$1" "$2"; pass=$((pass+1))
  else printf '  \033[31m✗\033[0m %-52s got %s, wanted %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

echo "── setting up a firm with two Depts and two people ────────────────"
TEN=$(curl -s -XPOST "$API/internal/v1/tenants" -H "$H" -H "$A" -d "{\"name\":\"Harbour Point\",\"slug\":\"harbour-$S\",\"reportingCurrency\":\"INR\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# A bootstrap admin, provisioned the platform's way. `/internal/v1/users` takes
# an email and nothing else — a display name is the FIRM's fact about a
# colleague, so it is set through the roster, which needs a session. Hence one
# unnamed account to open the door with.
BOOT_EMAIL="boot-$S@example.com"
BOOT=$(curl -s -XPOST "$API/internal/v1/users" -H "$H" -H "$A" -d "{\"email\":\"$BOOT_EMAIL\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -XPUT "$API/internal/v1/users/$BOOT/password" -H "$H" -H "$A" -d "{\"password\":\"$PW\"}"
curl -s -o /dev/null -XPOST "$API/internal/v1/memberships" -H "$H" -H "$A" -d "{\"tenantId\":\"$TEN\",\"userId\":\"$BOOT\",\"audience\":\"STAFF\",\"role\":\"partner\",\"commercialVisibility\":true}"
curl -s -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" -d "{\"email\":\"$BOOT_EMAIL\",\"password\":\"$PW\"}"
curl -s -b "$J/p.txt" -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"

# Named colleagues, through the roster the firm actually uses. This is also what
# makes the NAME assertions below meaningful: a screen must never have to fetch
# a person per row to render the account team.
invite() { # invite <email> <role> <name>
  call POST /api/v1/tenancy/members "{\"email\":\"$1\",\"audience\":\"STAFF\",\"role\":\"$2\",\"commercialVisibility\":true,\"displayName\":\"$3\"}" >/dev/null
  local uid; uid=$(jget 'd["userId"]')
  curl -s -o /dev/null -XPUT "$API/internal/v1/users/$uid/password" -H "$H" -H "$A" -d "{\"password\":\"$PW\"}"
  echo "$uid"; }

PARTNER_EMAIL="priya-$S@example.com"
ANITA_EMAIL="anita-$S@example.com"
BHAVNA_EMAIL="bhavna-$S@example.com"
PARTNER=$(invite "$PARTNER_EMAIL" partner "Priya Menon")
ANITA=$(invite "$ANITA_EMAIL" manager "Anita Rao")
BHAVNA=$(invite "$BHAVNA_EMAIL" manager "Bhavna Shah")

curl -s -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" -d "{\"email\":\"$PARTNER_EMAIL\",\"password\":\"$PW\"}"
curl -s -b "$J/p.txt" -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"

call POST /api/v1/tenancy/structure/axes '{"axis":"dept","code":"FRC","name":"Financial Reporting & Compliance","sortOrder":1}' >/dev/null
FRC=$(jget 'd["id"]')
call POST /api/v1/tenancy/structure/axes '{"axis":"dept","code":"TRC","name":"Tax & Regulatory Compliance","sortOrder":2}' >/dev/null
TRC=$(jget 'd["id"]')
call POST /api/v1/parties/organizations '{"legalName":"Bharat Steel Private Limited","tradeName":"Bharat Steel","jurisdiction":"IN","entityType":"private_limited"}' >/dev/null
CLIENT=$(jget 'd["partyId"]')
echo "  firm $TEN · client $CLIENT"
echo

echo "── 1. an empty account team is a real answer, not a 404 ───────────"
ok "a client nobody owns yet" "$(call GET "/api/v1/parties/$CLIENT/assignments" "")" 200
ok "…and it says nobody" "$(jget 'len(d["inForce"])')" 0
ok "a party that does not exist is a 404" \
   "$(call GET "/api/v1/parties/00000000-0000-4000-8000-0000000000ff/assignments" "")" 404
echo

echo "── 2. the firm's own arrangement: one KM, one SPOC per Dept ───────"
ok "Key Manager from 1 Jan" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"key_manager\",\"userId\":\"$PARTNER\",\"validFrom\":\"2026-01-01\"}")" 201
KM1=$(jget 'd["id"]')
ok "…carries the holder's NAME, not a uuid" "$(jget 'd["holderName"]')" "Priya Menon"
ok "FRC SPOC from 1 Jan" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"axisId\":\"$FRC\",\"userId\":\"$ANITA\",\"validFrom\":\"2026-01-01\"}")" 201
SPOC1=$(jget 'd["id"]')
ok "…names the Dept, not a uuid" "$(jget 'd["axis"]["code"]')" FRC
ok "TRC SPOC from 1 Jan" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"axisId\":\"$TRC\",\"userId\":\"$BHAVNA\",\"validFrom\":\"2026-01-01\"}")" 201
call GET "/api/v1/parties/$CLIENT/assignments" "" >/dev/null
ok "three people hold this client today" "$(jget 'len(d["inForce"])')" 3
echo

echo "── 3. the shape rules, refused with a sentence ────────────────────"
ok "a SPOC with no Dept" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"userId\":\"$ANITA\"}")" 400
ok "a Key Manager carrying a Dept" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"key_manager\",\"axisId\":\"$FRC\",\"userId\":\"$ANITA\"}")" 400
ok "the same person twice on one Dept" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"axisId\":\"$FRC\",\"userId\":\"$ANITA\"}")" 409
ok "somebody who does not work here" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" '{"role":"spoc","axisId":"'"$FRC"'","userId":"00000000-0000-4000-8000-0000000000fe"}')" 409
echo

echo "── 4. a Dept MAY have a second SPOC (Shrestha, 2026-08-30) ────────"
ok "Bhavna joins FRC alongside Anita" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"axisId\":\"$FRC\",\"userId\":\"$BHAVNA\",\"validFrom\":\"2026-01-01\"}")" 201
SPOC2=$(jget 'd["id"]')
call GET "/api/v1/parties/$CLIENT/assignments" "" >/dev/null
ok "FRC now has two" "$(jget 'len([a for a in d["inForce"] if a["axis"] and a["axis"]["code"]=="FRC"])')" 2
ok "ending one leaves the other" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments/$SPOC2/end" '{"validTo":"2026-02-01"}')" 200
echo

echo "── 5. the handover: two rows, contiguous, never an edit ───────────"
ok "a new Key Manager from 1 April" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"key_manager\",\"userId\":\"$ANITA\",\"validFrom\":\"2026-04-01\"}")" 201
call GET "/api/v1/parties/$CLIENT/assignments" "" >/dev/null
ok "the outgoing row was CLOSED, not overwritten" \
   "$(jget '[a["validTo"] for a in d["all"] if a["id"]=="'"$KM1"'"][0]')" 2026-04-01
ok "…and it still names who it was" \
   "$(jget '[a["holderName"] for a in d["all"] if a["id"]=="'"$KM1"'"][0]')" "Priya Menon"
ok "exactly one Key Manager today" \
   "$(jget 'len([a for a in d["inForce"] if a["role"]=="key_manager"])')" 1
ok "backdating onto the incumbent is refused" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"key_manager\",\"userId\":\"$BHAVNA\",\"validFrom\":\"2026-04-01\"}")" 409
echo

echo "── 6. THE ACCEPTANCE LINE: who was the SPOC in March? ─────────────"
ok "hand FRC over to Bhavna on 1 May" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments/$SPOC1/end" '{"validTo":"2026-05-01"}')" 200
ok "…and record her from 1 May" \
   "$(call POST "/api/v1/parties/$CLIENT/assignments" "{\"role\":\"spoc\",\"axisId\":\"$FRC\",\"userId\":\"$BHAVNA\",\"validFrom\":\"2026-05-01\"}")" 201

call GET "/api/v1/parties/$CLIENT/assignments?asOf=2026-03-15" "" >/dev/null
ok "on 15 March the FRC SPOC was" \
   "$(jget '[a["holderName"] for a in d["inForce"] if a["role"]=="spoc" and a["axis"]["code"]=="FRC"][0]')" "Anita Rao"
ok "…and the Key Manager was" \
   "$(jget '[a["holderName"] for a in d["inForce"] if a["role"]=="key_manager"][0]')" "Priya Menon"

call GET "/api/v1/parties/$CLIENT/assignments?asOf=2026-06-15" "" >/dev/null
ok "on 15 June the FRC SPOC was" \
   "$(jget '[a["holderName"] for a in d["inForce"] if a["role"]=="spoc" and a["axis"]["code"]=="FRC"][0]')" "Bhavna Shah"

# The changeover day is the one an INCLUSIVE upper bound gets wrong, and it is
# why every period in this product is half-open.
call GET "/api/v1/parties/$CLIENT/assignments?asOf=2026-04-30" "" >/dev/null
ok "30 April — the last day of the old SPOC" \
   "$(jget '[a["holderName"] for a in d["inForce"] if a["role"]=="spoc" and a["axis"]["code"]=="FRC"][0]')" "Anita Rao"
call GET "/api/v1/parties/$CLIENT/assignments?asOf=2026-05-01" "" >/dev/null
ok "1 May — the first day of the new one, and only one" \
   "$(jget 'len([a for a in d["inForce"] if a["role"]=="spoc" and a["axis"]["code"]=="FRC"])')" 1
echo

echo "── 7. my clients ──────────────────────────────────────────────────"
ok "the partner's book is empty now — he handed it over" \
   "$(call GET /api/v1/my-clients "" >/dev/null; jget 'len(d["clients"])')" 0
curl -s -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" -d "{\"email\":\"$ANITA_EMAIL\",\"password\":\"$PW\"}"
curl -s -b "$J/p.txt" -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"
call GET /api/v1/my-clients "" >/dev/null
ok "Anita holds it (Key Manager since April)" "$(jget 'len(d["clients"])')" 1
ok "…listed ONCE, by name" "$(jget 'd["clients"][0]["displayName"]')" "Bharat Steel"
ok "…and it says why it is hers" "$(jget 'd["clients"][0]["roles"][0]')" key_manager
echo

echo "── 8. the audit trail ─────────────────────────────────────────────"
curl -s -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" -d "{\"email\":\"$PARTNER_EMAIL\",\"password\":\"$PW\"}"
curl -s -b "$J/p.txt" -c "$J/p.txt" -o /dev/null -XPOST "$API/api/v1/auth/org" -H "$H" -d "{\"tenantId\":\"$TEN\"}"
call GET "/api/v1/objects/client_assignment/$KM1/events" "" >/dev/null
ok "the closed Key Manager row has its own timeline" "$(jget 'len(d["events"]) >= 1')" True
call GET "/api/v1/events?verb=client_assignment.created" "" >/dev/null
ok "a handover names the row it closed" \
   "$(jget 'any(e["event"]["payload"].get("handedOverFrom")=="'"$KM1"'" for e in d["events"])')" True
echo

printf '  %d passed, %d failed\n\n' "$pass" "$fail"
echo "  Log in to the UI as:  $PARTNER_EMAIL / $PW"
echo "                        $ANITA_EMAIL  (Key Manager of Bharat Steel)"
echo "                        $BHAVNA_EMAIL (FRC and TRC SPOC)"
echo "  Client page:          http://localhost:3000/clients/$CLIENT"
[ "$fail" -eq 0 ]
