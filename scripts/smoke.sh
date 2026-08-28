#!/usr/bin/env bash
#
# A smoke test for the whole running stack — the things unit tests cannot check
# because they need a real server, a real database, and a real request.
#
# It seeds a firm with three people (a partner, an associate, a client contact),
# then walks the properties the product actually depends on: the provisioning
# key, the session wall, the audience and role gates, the party model, the
# effective-dated relationships, rate limiting, CORS, and the audit trail.
#
# Run:  npm run dev   (in another terminal)
#       npm run smoke
#
# It prints the seeded logins at the end so you can carry on in the UI.
# Verify the BiB backend end to end. Needs: the API on :8080, a migrated DB.
set -u
API=http://localhost:8080
KEY=local-dev-internal-key-not-for-any-real-environment
H='content-type: application/json'
A="authorization: Bearer $KEY"
J=$(mktemp -d)
S=$(date +%s)
ok=0; bad=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-52s %s\n" "$1" "$3"; ok=$((ok+1));
  else printf "  \033[31m✗\033[0m %-52s got %s, expected %s\n" "$1" "$3" "$2"; bad=$((bad+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo; echo "── 1. The provisioning surface needs a platform key ────────────────"
chk "no key is refused"        401 "$(code -XPOST $API/internal/v1/tenants -H "$H" -d '{}')"
chk "wrong key is refused"     401 "$(code -XPOST $API/internal/v1/tenants -H "$H" -H 'authorization: Bearer wrong' -d '{}')"
chk "an undeclared route is refused" 403 "$(code -XPOST $API/internal/v1/nope -H "$H" -H "$A" -d '{}')"

# Seed a firm: one partner, one associate, one client contact.
T=$(curl -s -XPOST $API/internal/v1/tenants -H "$H" -H "$A" -d "{\"name\":\"Harbour Point\",\"slug\":\"demo-$S\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
for spec in "partner:STAFF:true" "associate:STAFF:false" "client:CLIENT_PORTAL:false"; do
  R=${spec%%:*}; rest=${spec#*:}; AUD=${rest%%:*}; VIS=${rest##*:}
  ROLE=$R; [ "$R" = "client" ] && ROLE=client_contact
  U=$(curl -s -XPOST $API/internal/v1/users -H "$H" -H "$A" -d "{\"email\":\"$R-$S@example.com\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  curl -s -o /dev/null -XPOST $API/internal/v1/memberships -H "$H" -H "$A" \
    -d "{\"tenantId\":\"$T\",\"userId\":\"$U\",\"audience\":\"$AUD\",\"role\":\"$ROLE\",\"commercialVisibility\":$VIS}"
  curl -s -o /dev/null -XPUT $API/internal/v1/users/$U/password -H "$H" -H "$A" -d '{"password":"correct horse battery staple"}'
  curl -s -c $J/$R.txt -o /dev/null -XPOST $API/api/v1/auth/login -H "$H" -d "{\"email\":\"$R-$S@example.com\",\"password\":\"correct horse battery staple\"}"
done
echo "  (seeded firm ${T:0:8}… with partner, associate, client contact)"

echo; echo "── 2. Authentication: nothing is reachable without a session ───────"
chk "anonymous cannot list parties"        401 "$(code $API/api/v1/parties)"
chk "anonymous cannot read the audit trail" 401 "$(code $API/api/v1/events)"
chk "a signed-in partner can"               200 "$(code -b $J/partner.txt $API/api/v1/parties)"

echo; echo "── 3. Gate 2 — a client contact cannot reach the staff workspace ───"
chk "client: firm's client book"      403 "$(code -b $J/client.txt $API/api/v1/parties)"
chk "client: firm's audit trail"      403 "$(code -b $J/client.txt $API/api/v1/events)"
chk "client: own session is fine"     200 "$(code -b $J/client.txt $API/api/v1/auth/me)"
chk "client: own memberships"         200 "$(code -b $J/client.txt $API/api/v1/tenancy/me/memberships)"

echo; echo "── 4. Gate 3 — role decides what staff may do ──────────────────────"
chk "associate may read parties"      200 "$(code -b $J/associate.txt $API/api/v1/parties)"
chk "associate may create a party"    201 "$(code -b $J/associate.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Acme Ltd"}')"
chk "associate may NOT sweep the log" 403 "$(code -b $J/associate.txt $API/api/v1/events)"
chk "partner may sweep the log"       200 "$(code -b $J/partner.txt $API/api/v1/events)"

echo; echo "── 5. The party model + the audit trail ────────────────────────────"
ORG=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Meridian Textiles Private Limited","tradeName":"Meridian"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
chk "register a legal entity"  201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/organizations/$ORG/legal-entities -H "$H" -d '{"jurisdiction":"IN","entityType":"private_limited"}')"
chk "attach a PAN"             201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/identifiers -H "$H" -d '{"type":"pan","value":"AABCM1234K","validFrom":"2019-06-01"}')"
chk "reject an invalid PAN"    400 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/identifiers -H "$H" -d '{"type":"pan","value":"NOTAPAN","validFrom":"2019-06-01"}')"
chk "two GSTINs, one entity"   201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/identifiers -H "$H" -d '{"type":"gstin","value":"27AABCM1234K1Z5","jurisdiction":"IN-MH","validFrom":"2019-06-01"}')"
chk "…and a second state"      201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/identifiers -H "$H" -d '{"type":"gstin","value":"29AABCM1234K1Z2","jurisdiction":"IN-KA","validFrom":"2019-06-01"}')"
DIR=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/persons -H "$H" -d '{"fullName":"Priya Menon"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
REL=$(printf '{"fromPartyId":"%s","toPartyId":"%s","type":"director_of","validFrom":"2019-06-01","validTo":"2024-03-31"}' "$DIR" "$ORG")
chk "record a directorship"    201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/relationships -H "$H" -d "$REL")"
chk "malformed JSON is 400, not 500" 400 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/relationships -H "$H" -d '{not json')"

echo "  who was a director on a given date (effective dating):"
for D in 2020-06-01 2025-06-01; do
  N=$(curl -s -b $J/partner.txt "$API/api/v1/parties/$ORG?asOf=$D" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["relationships"]))')
  printf "    on %s -> %s relationship(s)\n" "$D" "$N"
done

echo; echo "── 6. Rate limiting ────────────────────────────────────────────────"
last=""
for i in $(seq 1 12); do last=$(code -XPOST $API/api/v1/auth/login -H "$H" -d '{"email":"nobody@example.com","password":"guess"}'); done
chk "brute force is throttled"  429 "$last"

echo; echo "── 7. CORS — the frontend is a separate origin ─────────────────────"
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin' | tr -d '\r' | awk '{print $2}')
chk "allowed origin gets a preflight" "http://localhost:3000" "$ACAO"
EVIL=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci '^access-control-allow-origin' | tr -d '\r')
chk "unlisted origin gets none"        0 "$EVIL"

echo; echo "── 8. The audit trail, as recorded ─────────────────────────────────"
curl -s -b $J/partner.txt "$API/api/v1/events?limit=12" | python3 -c '
import sys, json
for e in reversed(json.load(sys.stdin)["events"]):
    who = e["actorType"] + ("" if e["actorId"] is None else "/" + e["actorId"][:8])
    print("    %-30s %-12s %s" % (e["verb"], who, json.dumps(e["payload"])[:60]))'
LEAK=$(curl -s -b $J/partner.txt "$API/api/v1/events?limit=50" | grep -c "Priya Menon\|AABCM1234K\|@example.com")
chk "no personal data in the log" 0 "$LEAK"

echo; echo "───────────────────────────────────────────────────────────────────"
printf "  %s passed, %s failed\n\n" "$ok" "$bad"
echo "  Log in to the UI as:  partner-$S@example.com / correct horse battery staple"
echo "                        associate-$S@example.com  (no audit trail)"
echo "                        client-$S@example.com     (blocked from the workspace)"
[ "$bad" -eq 0 ]
