#!/usr/bin/env bash
#
# A smoke test for the whole running stack — the things unit tests cannot check
# because they need a real server, a real database, and a real request.
#
# It seeds a firm with three people (a partner, an associate, a client contact),
# then walks the properties the product actually depends on: the provisioning
# key, the session wall, the audience and role gates, the party model, the
# effective-dated relationships, the configuration registry (a published
# version is frozen; a firm cannot strand itself), the lead pipeline (a
# duplicate capture merges rather than creating), firm administration (a
# revoked membership stops the very next request), rate limiting, CORS, and
# the audit trail.
#
# Run:  npm run dev   (in another terminal)
#       npm run smoke
#
# It prints the seeded logins at the end so you can carry on in the UI.
# Verify the BiB backend end to end. Needs: the API on :8080, a migrated DB.
set -u
API=${API:-http://localhost:8080}
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

chk "a firm with no reporting currency is refused" 400 \
  "$(code -XPOST $API/internal/v1/tenants -H "$H" -H "$A" -d "{\"name\":\"No Books\",\"slug\":\"nobooks-$S\"}")"

# Seed a firm: one partner, one associate, one client contact. The reporting
# currency is required and has no default anywhere — it is what every FX rate
# stored later is struck against, so it cannot be corrected afterwards.
TENANT=$(curl -s -XPOST $API/internal/v1/tenants -H "$H" -H "$A" \
  -d "{\"name\":\"Harbour Point\",\"slug\":\"demo-$S\",\"reportingCurrency\":\"INR\"}")
T=$(echo "$TENANT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "the firm keeps its reporting currency" INR \
  "$(echo "$TENANT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["reportingCurrency"])')"
for spec in "partner:STAFF:true" "associate:STAFF:false" "client:CLIENT_PORTAL:false"; do
  R=${spec%%:*}; rest=${spec#*:}; AUD=${rest%%:*}; VIS=${rest##*:}
  ROLE=$R; [ "$R" = "client" ] && ROLE=client_contact
  U=$(curl -s -XPOST $API/internal/v1/users -H "$H" -H "$A" -d "{\"email\":\"$R-$S@example.com\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  echo "$U" > $J/$R.id
  curl -s -o /dev/null -XPOST $API/internal/v1/memberships -H "$H" -H "$A" \
    -d "{\"tenantId\":\"$T\",\"userId\":\"$U\",\"audience\":\"$AUD\",\"role\":\"$ROLE\",\"commercialVisibility\":$VIS}"
  curl -s -o /dev/null -XPUT $API/internal/v1/users/$U/password -H "$H" -H "$A" -d '{"password":"correct horse battery staple"}'
  curl -s -c $J/$R.txt -o /dev/null -XPOST $API/api/v1/auth/login -H "$H" -d "{\"email\":\"$R-$S@example.com\",\"password\":\"correct horse battery staple\"}"
done
echo "  (seeded firm ${T:0:8}… with partner, associate, client contact)"

# Fail loudly and early if the seed logins did not take. The usual cause is this
# script's own rate-limit section (section 9) from a run less than a minute ago:
# the sign-in bucket is 10/minute per address, and seeding spends three of them.
# Without this check every later assertion answers 401 and the output blames a
# dozen unrelated things for one throttled login.
if [ "$(code -b $J/partner.txt $API/api/v1/auth/me)" != "200" ]; then
  printf "\n  \033[31m✗\033[0m the seeded partner could not sign in.\n"
  echo "    Almost always the sign-in rate limit from a previous run — wait a minute and retry."
  exit 1
fi

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

# Party 360, as a screen has to read it. All three of these were unreachable
# through any route until the client screen had to render them: the subtype
# detail, the legal entities (a write with NO read — registerLegalEntity had no
# counterpart at all), and the name of the party at the other end of a
# relationship instead of its uuid.
PROFILE=$(curl -s -b $J/partner.txt $API/api/v1/parties/$ORG | python3 -c '
import sys, json
d = json.load(sys.stdin)
rel = d["relationships"][0]
print("%s/%s/%s/%s" % (
    d["organization"]["legalName"],
    len(d["legalEntities"]),
    rel["counterparty"]["displayName"],
    rel["direction"]))')
chk "the 360 carries what the form captured"   "Meridian Textiles Private Limited/1/Priya Menon/incoming" "$PROFILE"

echo "  who was a director on a given date (effective dating):"
for D in 2020-06-01 2025-06-01; do
  N=$(curl -s -b $J/partner.txt "$API/api/v1/parties/$ORG?asOf=$D" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["relationships"]))')
  printf "    on %s -> %s relationship(s)\n" "$D" "$N"
done

echo; echo "── 6. The configuration registry — services and roles are data ─────"
chk "associate may read the catalogue"     200 "$(code -b $J/associate.txt $API/api/v1/config/service)"
chk "associate may NOT change it"          403 "$(code -b $J/associate.txt -XPOST $API/api/v1/config/service -H "$H" -d '{"key":"sneaky","body":{"name":"X","billingBasis":"fixed"}}')"
SVC='{"key":"gst-filing","body":{"name":"GST monthly filing","category":"indirect-tax","jurisdictions":["IN"],"billingBasis":"fixed","listPrice":{"amount":"25000.00","currency":"INR"}}}'
chk "partner defines a service"            201 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$SVC")"
chk "a misspelt field is refused"          400 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d '{"key":"advisory","body":{"name":"A","billing":"fixed"}}')"
chk "a price given as a number is refused" 400 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d '{"key":"advisory","body":{"name":"A","billingBasis":"fixed","listPrice":{"amount":1499.5,"currency":"INR"}}}')"
NOTLIVE=$(curl -s -b $J/partner.txt $API/api/v1/config/service | python3 -c 'import sys,json;print(json.load(sys.stdin)["entries"][0]["published"])')
chk "defining does not put it in force"    None "$NOTLIVE"
chk "publishing does"                      200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/gst-filing/versions/1/publish -H "$H")"
chk "publishing it twice is refused"       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/gst-filing/versions/1/publish -H "$H")"

# A published version is frozen: v2 supersedes it, and v1 keeps the body it had.
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/service/gst-filing/versions -H "$H" -d '{"body":{"name":"GST monthly filing (2026 scope)","billingBasis":"fixed","listPrice":{"amount":"27500.00","currency":"INR"}}}'
chk "a second version publishes"           200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/gst-filing/versions/2/publish -H "$H")"
FROZEN=$(curl -s -b $J/partner.txt $API/api/v1/config/service/gst-filing | python3 -c '
import sys, json
vs = {v["version"]: v for v in json.load(sys.stdin)["versions"]}
print("%s/%s" % (vs[1]["status"], vs[1]["body"]["name"] == "GST monthly filing"))')
chk "the version it replaced is frozen"    "archived/True" "$FROZEN"
# The half of that which money depends on: a proposal pinned to v1 must still be
# able to say what our list price WAS, after the catalogue moved on.
WASPRICE=$(curl -s -b $J/partner.txt $API/api/v1/config/service/gst-filing | python3 -c '
import sys, json
vs = {v["version"]: v for v in json.load(sys.stdin)["versions"]}
print("%s->%s" % (vs[1]["body"]["listPrice"]["amount"], vs[2]["body"]["listPrice"]["amount"]))')
chk "and keeps the list price it had"      "25000.00->27500.00" "$WASPRICE"

# The role registry is the same machinery — and it refuses to strand the firm.
# Drafting a partner role with no tenant:admin is fine; PUBLISHING it is not,
# because nobody would then be able to put it back.
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/role/partner/versions -H "$H" \
  -d '{"body":{"label":"Partner","permissions":["party:read","party:write","ledger:read"]}}'
chk "a firm cannot remove its last admin"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/role/partner/versions/2/publish -H "$H")"

# The thing that was impossible before T2.5: a firm's own word for a role.
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/role -H "$H" \
  -d '{"key":"rm","body":{"label":"Relationship manager","permissions":["party:read","config:read"]}}'
chk "a firm can add a role of its own"     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/role/rm/versions/1/publish -H "$H")"

echo; echo "── 7. The lead pipeline — dedup before create ──────────────────────"
PAN2=AAACL5678M
LEAD1='{"source":"inbound","kind":"organization","name":"Lakeview Foods Private Limited","identifiers":[{"type":"pan","value":"'$PAN2'"},{"type":"email","value":"ops-'$S'@lakeview.example"}]}'
curl -s -o $J/lead1.json -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$LEAD1"
chk "capture a new lead"               201 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"outbound","kind":"organization","name":"Northwind Traders","identifiers":[{"type":"email","value":"hello-'$S'@northwind.example"}]}')"

# The acceptance: the same prospect, reached a different way, does not become a
# second party or a second opportunity.
LEAD2='{"source":"referral","kind":"organization","name":"Lakeview Foods Pvt Ltd","identifiers":[{"type":"pan","value":"'$PAN2'"},{"type":"phone","value":"+91 98180 11223"}]}'
MERGE=$(curl -s -o $J/merge.json -w '%{http_code}' -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$LEAD2")
chk "a duplicate does not create a lead" 200 "$MERGE"
SAME=$(python3 -c '
import json
a = json.load(open("'$J'/lead1.json")); b = json.load(open("'$J'/merge.json"))
print("%s/%s" % (a["lead"]["id"] == b["lead"]["id"], b["merged"]))' 2>/dev/null || echo "?")
chk "…it lands on the existing one"     "True/True" "$SAME"
ONE=$(curl -s -b $J/partner.txt "$API/api/v1/leads" | python3 -c '
import sys, json
leads = json.load(sys.stdin)["leads"]
print(len([r for r in leads if r["lead"]["stage"] not in ("converted","lost")]))')
chk "two captures, two open leads"      2 "$ONE"
# The pipeline read names its prospect rather than handing a screen a uuid.
NAMED=$(curl -s -b $J/partner.txt "$API/api/v1/leads" | python3 -c '
import sys, json
print(sorted(r["party"]["displayName"] for r in json.load(sys.stdin)["leads"])[0])')
chk "…and each one names its prospect"  "Lakeview Foods Private Limited" "$NAMED"

chk "a lead with no way to reach them"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"inbound","kind":"organization","name":"Anonymous Ltd","identifiers":[{"type":"cin","value":"U17110MH2019PTC123456"}]}')"
chk "a source we cannot report on"      400 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"linkedin","kind":"person","name":"A N Other","identifiers":[{"type":"email","value":"x-'$S'@y.example"}]}')"

LID=$(python3 -c 'import json;print(json.load(open("'$J'/lead1.json"))["lead"]["id"])')
chk "move it through the pipeline"      200 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads/$LID/stage -H "$H" -d '{"stage":"qualified"}')"
chk "assign it to the associate"        200 "$(code -b $J/partner.txt -XPUT $API/api/v1/leads/$LID/owner -H "$H" -d "{\"ownerUserId\":\"$(cat $J/associate.id)\"}")"
chk "not to a client contact"           409 "$(code -b $J/partner.txt -XPUT $API/api/v1/leads/$LID/owner -H "$H" -d "{\"ownerUserId\":\"$(cat $J/client.id)\"}")"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/leads/$LID/stage -H "$H" -d '{"stage":"converted"}'
chk "a finished lead cannot reopen"     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads/$LID/stage -H "$H" -d '{"stage":"contacted"}')"

echo "  the lead's timeline, which is the ledger and not a second table:"
curl -s -b $J/partner.txt "$API/api/v1/objects/lead/$LID/events" | python3 -c '
import sys, json
for r in reversed(json.load(sys.stdin)["events"]):
    print("    %-24s %s" % (r["event"]["verb"], json.dumps(r["event"]["payload"])[:64]))'

echo; echo "── 8. Proposals — quoted from the catalogue, and the discount gate ─"
# The catalogue version a line PINS: v1, which the firm has since superseded by
# v2. A quote reopened later must still read v1's list price, not today's.
SVCV1=$(curl -s -b $J/partner.txt $API/api/v1/config/service/gst-filing | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
PID=$(python3 -c 'import json;print(json.load(open("'$J'/lead1.json"))["lead"]["partyId"])')

# NOTE ON QUOTING: every JSON body below is built into a variable FIRST. A
# backslash-escaped body written inline — -d "{\"a\":\"b\"}" — is unescaped by
# the OUTER quotes of "$(code ...)" before the command substitution runs, and
# bash then brace-expands the {a,b} that is left. curl silently receives several
# mangled URLs. It happens to work for a single-field body, which is why the
# pattern survived this long.

# Per-country quoting: the client is billed in AED, the firm's books are in INR
# (the reporting currency it was created with), and the rate is struck once.
DRAFT='{"partyId":"'$PID'","title":"Lakeview - FY26 compliance","currency":"AED","fxRate":"23.4500","fxRateDate":"2026-06-01","validUntil":"2027-01-31"}'
PROP=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/proposals -H "$H" -d "$DRAFT")
PRID=$(echo "$PROP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "partner drafts a proposal in AED"     AED "$(echo "$PROP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["currency"])')"
chk "an empty proposal cannot be sent"     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H")"

NOSUCH='{"serviceVersionId":"00000000-0000-0000-0000-0000000000ff","description":"x","unitAmount":"1"}'
FLOATY='{"serviceVersionId":"'$SVCV1'","description":"x","unitAmount":1499.5}'
LINE='{"serviceVersionId":"'$SVCV1'","description":"GST monthly filing, 12 months","quantity":"12","unitAmount":"1200.00","discountPercent":"40"}'
# The entity is OPTIONAL on a proposal and required on an engagement letter: a
# prospect may hold no company yet, and Incorporation is a line whose entity is
# its own output. This line deliberately names none.
chk "a line must pin a real service"       404 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/lines -H "$H" -d "$NOSUCH")"
chk "an amount given as a number"          400 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/lines -H "$H" -d "$FLOATY")"
chk "quote a line, 40% off"                201 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/lines -H "$H" -d "$LINE")"

# The firm has published no discount policy, so silence is not permission: any
# discount at all needs sign-off until somebody sets a limit.
chk "no policy means any discount blocks"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H")"
POLICY='{"key":"discount","body":{"maxDiscountPercent":"15"}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/policy -H "$H" -d "$POLICY"
chk "the firm publishes a discount limit"  200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/policy/discount/versions/1/publish -H "$H")"
chk "40% is still past the 15% limit"      409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H")"
chk "the associate may not sign it off"    403 "$(code -b $J/associate.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
chk "the partner may"                      200 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
chk "…nothing to approve a second time"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
SENT=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H")
chk "now it sends"                         sent "$(echo "$SENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["proposal"]["status"])')"
# The link, returned ONCE — only its digest is stored, so this response is the
# only place it can ever be read.
SHARE=$(echo "$SENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["shareToken"])')
MORE='{"serviceVersionId":"'$SVCV1'","description":"one more","unitAmount":"1"}'
chk "a sent proposal cannot be edited"     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/lines -H "$H" -d "$MORE")"

# The pin, and the arithmetic, as a screen reads them: 12 x 1200.00 = 14400.00
# gross, 40% off = 8640.00 net — computed in numeric, never in JavaScript.
QUOTED=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$PRID | python3 -c '
import sys, json
p = json.load(sys.stdin); l = p["lines"][0]
print("%s/%s/%s" % (l["service"]["listPrice"]["amount"], p["totals"]["gross"], p["totals"]["net"]))')
chk "list price then, and what we charged" "25000.00/14400.0000/8640.0000" "$QUOTED"

# The FIFTH axis. The associate has no commercial visibility, so they see the
# document and not the money — redacted, never a 403, because "you may not see
# the fee" and "there is no proposal" are different answers.
REDACTED=$(curl -s -b $J/associate.txt $API/api/v1/proposals/$PRID | python3 -c '
import sys, json
p = json.load(sys.stdin)
print("%s/%s/%s" % (p["totals"]["net"], p["totals"]["currency"], p["lines"][0]["description"][:3]))')
chk "an associate sees the work, not the money" "None/AED/GST" "$REDACTED"

ACCEPT='{"decision":"accepted"}'
REJECT='{"decision":"rejected"}'
chk "the client accepts it"                200 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/decision -H "$H" -d "$ACCEPT")"
chk "and cannot change their mind here"    409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/decision -H "$H" -d "$REJECT")"

# The share link: the one route in this product with no session behind it. A
# proposal goes to somebody who has no login and will not get one.
BADTOK='{"token":"not-a-link"}'
GOODTOK='{"token":"'$SHARE'"}'
chk "an unknown link tells you nothing"    404 "$(code -XPOST $API/api/v1/proposals/shared -H "$H" -d "$BADTOK")"
SEEN=$(curl -s -XPOST $API/api/v1/proposals/shared -H "$H" -d "$GOODTOK")
chk "the recipient opens it, with no session" "Harbour Point" "$(echo "$SEEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["firmName"])')"
chk "…and reads what they were quoted"    8640.0000 "$(echo "$SEEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["totals"]["net"])')"
# Its own read model, not the staff one with fields nulled: a field added for
# colleagues cannot reach a client's screen by default.
INSIDES=$(echo "$SEEN" | python3 -c '
import sys, json
k = json.load(sys.stdin).keys()
print(",".join(sorted(f for f in ("partyId","leadId","fxRate","discountApprovedBy") if f in k)) or "none")')
chk "the client sees none of the firm's insides" none "$INSIDES"
curl -s -o /dev/null -XPOST $API/api/v1/proposals/shared -H "$H" -d "$GOODTOK"
VIEWS=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$PRID | python3 -c 'import sys,json;print(json.load(sys.stdin)["proposal"]["viewCount"])' 2>/dev/null || echo "?")
chk "every open is counted"                2 "$VIEWS"

echo; echo "── 9. Engagement letters — the document that creates obligations ───"
# Terms come from the clause library, the registry's fourth kind. A clause is
# PINNED, so a signed letter reads as what was agreed rather than as what the
# library says today.
SCOPE='{"key":"scope","body":{"title":"Scope of work","text":"The firm will perform the services listed above.","jurisdictions":[]}}'
AECLAUSE='{"key":"liability-ae","body":{"title":"Liability (UAE)","text":"As permitted by UAE law.","jurisdictions":["AE"]}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$SCOPE"
chk "publish a clause"                     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/clause/scope/versions/1/publish -H "$H")"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$AECLAUSE"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause/liability-ae/versions/1/publish -H "$H"
SCOPEV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/scope | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
AEV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/liability-ae | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')

# TWO COMPANIES OF THE SAME CLIENT. An engagement is `service x one legal
# entity` — the firm's own "Per Company" rule — so this letter has to fan out
# into two engagements that differ in exactly that field. Before G0.1 every
# engagement carried the CLIENT and the group's companies were indistinguishable
# on the one object the compliance calendar generates against.
ENT1=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Lakeview Foods Private Limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
ENT2=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Lakeview Logistics Private Limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')

# An advance is required, so the fee gate is live for this walk.
ELDRAFT='{"partyId":"'$PID'","jurisdiction":"IN","title":"Lakeview - FY26 engagement","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28","advanceRequired":true,"advanceAmount":"10000"}'
EL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d "$ELDRAFT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "an advance with no amount is refused"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$PID'","jurisdiction":"IN","title":"x","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28","advanceRequired":true}')"
chk "an empty letter cannot go out"          409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H")"

ELLINE='{"entityPartyId":"'$ENT1'","serviceVersionId":"'$SVCV1'","description":"GST monthly filing, 12 months","quantity":"12","unitAmount":"2000","discountPercent":"0"}'
ELLINE2='{"entityPartyId":"'$ENT2'","serviceVersionId":"'$SVCV1'","description":"GST monthly filing, Logistics","quantity":"12","unitAmount":"1500","discountPercent":"0"}'
NOENT='{"serviceVersionId":"'$SVCV1'","description":"whose company?","quantity":"1","unitAmount":"1","discountPercent":"0"}'
chk "a letter line must name an entity"      400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$NOENT")"
chk "agree a service"                        201 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE")"
chk "…and one for the sister company"      201 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE2")"
chk "a letter with no terms cannot go out"   409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H")"
chk "a UAE clause on an Indian letter"       400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/clauses -H "$H" -d '{"clauseVersionId":"'$AEV'"}')"
chk "the right clause goes on"               204 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/clauses -H "$H" -d '{"clauseVersionId":"'$SCOPEV'"}')"
chk "now it can be sent"                     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H")"

SIGNED=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/signature -H "$H" -d '{"signedByName":"A Director","reference":"paper-001"}')
chk "the client signs"                       signed "$(echo "$SIGNED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["letter"]["status"])')"
chk "…and one engagement per line appears" 2 "$(echo "$SIGNED" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["engagements"]))')"
# G0.1: the entity comes from the LINE, the client from the LETTER, and both are
# stored. Invoicing needs who is billed; the calendar needs who the work is for.
chk "…each naming its own company"         ok "$(echo "$SIGNED" | python3 -c '
import sys, json
got = {e["entityPartyId"] for e in json.load(sys.stdin)["engagements"]}
print("ok" if got == {"'$ENT1'", "'$ENT2'"} else "got %s" % sorted(got))')"
chk "…and all billed to the client"        "$PID" "$(echo "$SIGNED" | python3 -c '
import sys, json
ids = {e["partyId"] for e in json.load(sys.stdin)["engagements"]}
print(ids.pop() if len(ids) == 1 else "MIXED")')"
chk "…held back by the advance"            pending_advance "$(echo "$SIGNED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["engagements"][0]["status"])')"
chk "a signed letter cannot be edited"       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE")"
chk "…nor withdrawn"                       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/withdraw -H "$H")"

# Nothing may spawn while the advance is outstanding — the gate is real.
BEFORE=$(curl -s -b $J/partner.txt "$API/api/v1/objects/engagement_letter/$EL/events" | python3 -c '
import sys, json
print(sum(1 for r in json.load(sys.stdin)["events"] if r["event"]["verb"] == "contract.activated"))')
chk "no spawn trigger before the advance"    0 "$BEFORE"
chk "record the advance"                     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/advance -H "$H")"
chk "…and it cannot be recorded twice"     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/advance -H "$H")"
ACTIVE=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$EL | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("%s/%s/%s" % (d["engagements"][0]["status"], len(d["clauses"]), d["clauses"][0]["text"][:8]))')
chk "the engagement is released, terms pinned" "active/1/The firm" "$ACTIVE"
# A read model carries NAMES, not ids: this is exactly where a group client's
# companies have to be told apart, so a column of uuids is what it must not be.
NAMED=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$EL | python3 -c '
import sys, json
print("|".join(sorted(l["entity"]["displayName"] for l in json.load(sys.stdin)["lines"])))')
chk "…and the lines name their companies" "Lakeview Foods Private Limited|Lakeview Logistics Private Limited" "$NAMED"

echo; echo "── 10. Firm administration — the roster, and revocation ─────────────"
chk "associate cannot see the roster"    403 "$(code -b $J/associate.txt $API/api/v1/tenancy/members)"
ROSTER=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/members | python3 -c '
import sys, json
print(len(json.load(sys.stdin)["members"]))')
chk "partner sees all three people"      3 "$ROSTER"
NEW='{"email":"newjoiner-'$S'@example.com","audience":"STAFF","role":"associate","commercialVisibility":false,"displayName":"Rahul Iyer"}'
chk "add a colleague by email"           201 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/members -H "$H" -d "$NEW")"
chk "…and not twice"                     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/members -H "$H" -d "$NEW")"
chk "a role the firm never published"    409 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/members -H "$H" -d '{"email":"x-'$S'@example.com","audience":"STAFF","role":"rainmaker","commercialVisibility":false}')"

# The associate has a live session from section 2. Revoke their membership and
# watch that SESSION stop — the token is untouched and unexpired.
# By EMAIL, not by role: the colleague added above is also an active associate,
# and picking "the first active associate" revoked the wrong person — a green
# tick for a revocation that never touched the session under test.
AMID=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/members | python3 -c '
import sys, json
for m in json.load(sys.stdin)["members"]:
    if m["email"] == "associate-'$S'@example.com":
        print(m["membership"]["id"]); break')
chk "associate can still read parties"   200 "$(code -b $J/associate.txt $API/api/v1/parties)"
chk "revoke their access"                200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$AMID/active -H "$H" -d '{"isActive":false}')"
chk "their NEXT request is refused"      403 "$(code -b $J/associate.txt $API/api/v1/parties)"
chk "restore it"                         200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$AMID/active -H "$H" -d '{"isActive":true}')"
chk "and they are back, next request"    200 "$(code -b $J/associate.txt $API/api/v1/parties)"

# The firm must keep somebody who can administer it — reachable from both sides.
PMID=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/members | python3 -c '
import sys, json
for m in json.load(sys.stdin)["members"]:
    if m["membership"]["role"] == "partner":
        print(m["membership"]["id"]); break')
chk "the last admin cannot be demoted"   409 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$PMID/role -H "$H" -d '{"role":"manager"}')"
chk "…nor have their access revoked"     409 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$PMID/active -H "$H" -d '{"isActive":false}')"

echo; echo "── 10b. Seniority — the ladder, and who is on it ───────────────────"
# Grades are a THIRD axis: role says what somebody may reach, grade says how
# senior they are, and the firm's review rule ("Manager or above") compares the
# rank. A firm gets its ladder at creation, so this is not an empty list.
chk "associate cannot see the ladder"    403 "$(code -b $J/associate.txt $API/api/v1/tenancy/grades)"
RUNGS=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/grades | python3 -c '
import sys, json
print(len(json.load(sys.stdin)["grades"]))')
chk "a new firm already has a ladder"    10 "$RUNGS"
TOP=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/grades | python3 -c '
import sys, json
print(json.load(sys.stdin)["grades"][0]["code"])')
chk "most senior first"                  partner "$TOP"

# The rung the whole table exists for. Everything below assigns against it.
MGR=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/grades | python3 -c '
import sys, json
for g in json.load(sys.stdin)["grades"]:
    if g["code"] == "manager":
        print(g["id"]); break')

# Adding a rung the seed deliberately leaves out. The firm has real designations
# its own hierarchy never ranked — Article is the one it asks for first — and
# they arrive ranked by the firm rather than guessed by the product.
ART='{"code":"article","name":"Article","rank":1}'
chk "add a rung the seed omits"          201 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/grades -H "$H" -d "$ART")"
chk "…and not the same code twice"       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/grades -H "$H" -d "$ART")"
chk "a rank of zero is refused"          400 "$(code -b $J/partner.txt -XPOST $API/api/v1/tenancy/grades -H "$H" -d '{"code":"intern","name":"Intern","rank":0}')"
AID=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/grades | python3 -c '
import sys, json
for g in json.load(sys.stdin)["grades"]:
    if g["code"] == "article":
        print(g["id"]); break')

# Re-ranking is what makes inserting a rung possible at all — without it a firm
# would need an engineer with a SQL client to reorder its own hierarchy.
chk "rename and re-rank in one call"     200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/grades/$AID -H "$H" -d '{"name":"Articled Assistant","rank":2}')"
NEWRANK=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/grades | python3 -c '
import sys, json
for g in json.load(sys.stdin)["grades"]:
    if g["code"] == "article":
        print(g["rank"]); break')
chk "…the new rank stuck"                2 "$NEWRANK"

# Putting somebody on a rung, and the roster showing it by NAME rather than as
# the uuid it stores — the read-model rule, checked where a screen would break.
chk "put the new joiner on a rung"       200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$AMID/grade -H "$H" -d '{"gradeId":"'$MGR'"}')"
GNAME=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/members | python3 -c '
import sys, json
for m in json.load(sys.stdin)["members"]:
    if m["membership"]["id"] == "'$AMID'":
        print((m["grade"] or {}).get("name", "NONE")); break')
chk "the roster shows the rung by name"  Manager "$GNAME"
chk "a rung this firm never defined"     404 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$AMID/grade -H "$H" -d '{"gradeId":"00000000-0000-4000-8000-0000000009f9"}')"

# Retiring is not deleting. The rung stays readable on the person who holds it,
# because an approval they made has to keep explaining itself — it just stops
# being offered to anybody new.
chk "retire a rung"                      200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/grades/$MGR/active -H "$H" -d '{"isActive":false}')"
chk "…nobody new can be put on it"       409 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$PMID/grade -H "$H" -d '{"gradeId":"'$MGR'"}')"
STILL=$(curl -s -b $J/partner.txt $API/api/v1/tenancy/members | python3 -c '
import sys, json
for m in json.load(sys.stdin)["members"]:
    if m["membership"]["id"] == "'$AMID'":
        print((m["grade"] or {}).get("name", "NONE")); break')
chk "…the holder keeps it, still named"  Manager "$STILL"
chk "bring it back"                      200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/grades/$MGR/active -H "$H" -d '{"isActive":true}')"

# A grade grants nothing, so unlike a role it can strand nobody. The last
# administrator can be taken off the ladder; they cannot be demoted.
chk "the last admin CAN be un-graded"    200 "$(code -b $J/partner.txt -XPUT $API/api/v1/tenancy/members/$PMID/grade -H "$H" -d '{"gradeId":null}')"

echo; echo "── 11. Rate limiting ───────────────────────────────────────────────"
last=""
for i in $(seq 1 12); do last=$(code -XPOST $API/api/v1/auth/login -H "$H" -d '{"email":"nobody@example.com","password":"guess"}'); done
chk "brute force is throttled"  429 "$last"

echo; echo "── 12. CORS — the frontend is a separate origin ────────────────────"
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin' | tr -d '\r' | awk '{print $2}')
chk "allowed origin gets a preflight" "http://localhost:3000" "$ACAO"
EVIL=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci '^access-control-allow-origin' | tr -d '\r')
chk "unlisted origin gets none"        0 "$EVIL"

echo; echo "── 13. The audit trail, as recorded ────────────────────────────────"
curl -s -b $J/partner.txt "$API/api/v1/events?limit=12" | python3 -c '
import sys, json
for r in reversed(json.load(sys.stdin)["events"]):
    e = r["event"]
    who = e["actorType"]
    if r["actor"] is not None:
        who = r["actor"]["displayName"] or r["actor"]["email"].split("@")[0]
    print("    %-30s %-14s %s" % (e["verb"], who[:14], json.dumps(e["payload"])[:56]))'

# THE PROPERTY, tested precisely: personal data stays out of the STORED row.
# The actor's name is a read-time JOIN against the account as it stands now, so
# erasing that account stops it resolving and the event survives — which is what
# erasability requires and what storing a name would have made impossible.
#
# So the check reads the `event` half of each record, which IS the log, and
# ignores the `actor` half, which is not stored anywhere. Grepping the whole
# response would conflate the two and would have called the join a leak.
LEAK=$(curl -s -b $J/partner.txt "$API/api/v1/events?limit=50" | python3 -c '
import sys, json
stored = json.dumps([r["event"] for r in json.load(sys.stdin)["events"]])
print(sum(stored.count(s) for s in ("Priya Menon", "AABCM1234K", "@example.com")))')
chk "no personal data in the stored log" 0 "$LEAK"

# …and the other half of that: the read still says WHO, so the trail is
# attributable. `human/9895d76d…` is not an audit trail.
NAMED=$(curl -s -b $J/partner.txt "$API/api/v1/events?limit=50" | python3 -c '
import sys, json
rs = json.load(sys.stdin)["events"]
human = [r for r in rs if r["event"]["actorType"] == "human"]
print("yes" if human and all(r["actor"] is not None for r in human) else "no")')
chk "…and every human act names its actor" yes "$NAMED"

echo; echo "───────────────────────────────────────────────────────────────────"
printf "  %s passed, %s failed\n\n" "$ok" "$bad"
echo "  Log in to the UI as:  partner-$S@example.com / correct horse battery staple"
echo "                        associate-$S@example.com  (no audit trail)"
echo "                        client-$S@example.com     (blocked from the workspace)"
[ "$bad" -eq 0 ]
