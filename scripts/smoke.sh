#!/usr/bin/env bash
#
# A smoke test for the whole running stack — the things unit tests cannot check
# because they need a real server, a real database, and a real request.
#
# It seeds a firm with three people (a partner, an associate, a client contact),
# then walks the properties the product actually depends on: the provisioning
# key, the session wall, the audience and role gates, the party model, the
# effective-dated relationships, the configuration registry (a published
# version is frozen; a firm cannot strand itself), the catalogue's own words
# (a Dept is demanded in the form it will be GROUPED BY; an SLA is read off the
# version a document pinned), whose law a clause names (a code to compare and
# the words to print, never one without the other), the lead pipeline (a
# duplicate capture merges rather than creating; an opportunity has its own
# name, and a closed one says why), whose desk an unclaimed lead lands on,
# firm administration (a revoked membership stops the very next request),
# rate limiting, CORS, and the audit trail.
#
# Run:  npm run dev   (in another terminal)
#       npm run smoke
#
# It prints the seeded logins at the end so you can carry on in the UI.
# Verify the BiB backend end to end. Needs: the API on :8080, a migrated DB.
set -u
API=${API:-http://localhost:8080}
# OVERRIDABLE, like API above. This default is the .env.example key, which
# validateServer refuses in any production-like environment — so against a
# deployed instance the whole walk would 401 on its first provisioning call
# with nothing explaining why. Pass the real one:
#   API=https://bib-api-xxxx.run.app KEY=$(gcloud secrets versions access latest \
#     --secret=bib-internal-keys | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["key"])') \
#   npm run smoke
KEY=${KEY:-local-dev-internal-key-not-for-any-real-environment}
H='content-type: application/json'
A="authorization: Bearer $KEY"
# THE SECOND KEY, and it is not optional against anything public.
#
# validateServer REFUSES a production-like boot where one client holds
# credential.set alongside other capabilities, because those three calls —
# create a user, grant them partner, set their password — are a complete
# escalation path behind one key. So a real deployment necessarily has TWO,
# and this walk sets a password on every persona it creates.
#
# Defaulting to $KEY keeps a local run working with the single all-capability
# dev key. Against a deployed environment, pass both:
#   CRED_KEY=$(gcloud secrets versions access latest --secret=bib-internal-keys \
#     | python3 -c 'import json,sys;print([c["key"] for c in json.load(sys.stdin) if "credential.set" in c["capabilities"]][0])')
CRED_KEY=${CRED_KEY:-$KEY}
# THE FRONTEND'S ORIGIN, which must be on the API's BIB_CORS_ORIGINS for the
# CORS check (section 18). Overridable like API; by default the first origin the
# backend beside this script is configured with, else :3000. It was always
# :3000, so a server on another port (a worktree, :8127 with its web on :3127)
# failed the check while CORS worked (audit 2026-10-03).
ORIGIN=${ORIGIN:-$(grep -E '^BIB_CORS_ORIGINS=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d '\r" ')}
ORIGIN=${ORIGIN:-http://localhost:3000}
AC="authorization: Bearer $CRED_KEY"
# The scratch directory for this run's cookie jars and captured responses.
#
# `mktemp -d` returns a POSIX path (/tmp/tmp.XXXX). Bash understands it; on
# Windows the `python3` on PATH is native Windows Python, which does NOT — it
# looks for C:\tmp\... and raises FileNotFoundError. Every `json.load(open($J/…))`
# in this script then fails, the variable it was feeding comes back empty, later
# URLs become `/api/v1/leads//stage`, no route matches, and THIRTY-EIGHT CHECKS
# REPORT 403 as though a permission were missing. It cost a full investigation
# across both lanes before anyone looked at the path.
#
# `cygpath -m` converts it to a mixed path (C:/Users/…) that bash and Windows
# Python both resolve. A no-op everywhere else, because cygpath does not exist
# there — so this is the whole fix, and nothing below has to think about it.
J=$(mktemp -d)
if command -v cygpath >/dev/null 2>&1; then J=$(cygpath -m "$J"); fi
S=$(date +%s)
ok=0; bad=0
chk() { # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %-52s %s\n" "$1" "$3"; ok=$((ok+1));
  else printf "  \033[31m✗\033[0m %-52s got %s, expected %s\n" "$1" "$3" "$2"; bad=$((bad+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# THE WALK PACES ITSELF UNDER THE LIMITER (S7, 2026-10-05). It makes ~300
# requests from one address against a general limiter of 300 a minute
# (BIB_RATELIMIT_GENERAL_PER_MINUTE, a sliding window), and for a year it ran
# in a few seconds with no headroom: the next section, or a second run inside a
# minute, drowned in 429s that read like a pile of broken features (G1.8 cost an
# investigation; so did the sign-in bucket, which is what the message at the end
# of `seed` is about).
#
# So every request goes through `curl()` below, which keeps its own sliding
# window in $REQLOG (a file, because most calls run in a `$(...)` subshell) and,
# once SMOKE_BUDGET requests (default 250) fall inside the last minute, waits
# until the oldest of them has left it. The limit is NOT raised and is still
# what the walk meets; the walk now behaves like a polite client instead of
# assuming it has the address to itself. A run that waits says so on stderr.
# Sections can be added again; each 250 requests costs about a minute.
REQLOG=$(mktemp)
SMOKE_BUDGET=${SMOKE_BUDGET:-250}
curl() {
  local now inwin oldest wait
  now=$(date +%s)
  read -r inwin oldest < <(awk -v n="$now" '$1 > n - 60 { c++; if (!o) o = $1 } END { print c + 0, o + 0 }' "$REQLOG")
  if [ "$inwin" -ge "$SMOKE_BUDGET" ]; then
    wait=$((oldest + 61 - now))
    if [ "$wait" -gt 0 ]; then
      printf '  … %s requests in the last minute; waiting %ss for the limiter\n' "$inwin" "$wait" >&2
      sleep "$wait"
    fi
    now=$(date +%s)
  fi
  echo "$now" >> "$REQLOG"
  command curl "$@"
}
#
# WHAT WAS TRIMMED FROM THIS WALK, AND WHY, so it is not added back by reflex:
# a handful of checks that only asserted "this malformed body answers 400". Each
# is covered by a unit test, and since `api/domainerr.ts` gained a compile-time
# exhaustiveness default, an UNMAPPED error code is a build failure rather than
# a 500 discovered by walking the API. That was the specific thing those checks
# used to catch (it is how G3.3's 500s were found), so their value fell sharply
# the day the guard landed. What stays here is end-to-end behaviour: the walks,
# the gates, and the refusals that are business rules rather than shapes.
#
# If you add a section and the run starts failing from the middle onward with
# `got 429`, the walk has outgrown the limit — check that before checking the
# feature. The fix is to spend fewer requests here, not to raise the product's
# default: a limit the smoke walk cannot live under is one a real client cannot
# either, and finding that out is part of what this script is for.
#
# THE REAL-WORLD VERSION OF THIS IS WORTH SEEING, because the walk is not the
# only client that shares one address: a firm behind a single office NAT gateway
# puts all of its staff in ONE bucket. 300/min is comfortable for a handful of
# browsers and is not obviously comfortable for forty people on a Monday
# morning. That is a product question about BIB_RATELIMIT_GENERAL_PER_MINUTE and
# the key the edge limiter uses — not something to fix by quietly raising a
# number so a test goes green. It is on the board.

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
  curl -s -o /dev/null -XPUT $API/internal/v1/users/$U/password -H "$H" -H "$AC" -d '{"password":"correct horse battery staple"}'
  curl -s -c $J/$R.txt -o /dev/null -XPOST $API/api/v1/auth/login -H "$H" -d "{\"email\":\"$R-$S@example.com\",\"password\":\"correct horse battery staple\"}"
done
echo "  (seeded firm ${T:0:8}… with partner, associate, client contact)"

# Fail loudly and early if the seed logins did not take. The usual cause is this
# script's own rate-limit section (section 17) from a run less than a minute ago:
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
chk "associate may create a party"    201 "$(code -b $J/associate.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Acme Ltd","jurisdiction":"IN","entityType":"private_limited"}')"
chk "associate may NOT sweep the log" 403 "$(code -b $J/associate.txt $API/api/v1/events)"
chk "partner may sweep the log"       200 "$(code -b $J/partner.txt $API/api/v1/events)"

echo; echo "── 5. The party model + the audit trail ────────────────────────────"
ORG=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Meridian Textiles Private Limited","tradeName":"Meridian","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
# Q076: a client company comes with its country and type, in one act; one
# without them, or abroad with no year end, is refused.
chk "a client company needs its country" 400 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Nowhere Ltd","jurisdiction":"AE","entityType":"fzco"}')"
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

echo; echo "── 7. The catalogue's own words — what the firm sells, in full ─────"
# G2.1-G2.3. `ServiceBody` was six fields while the firm's own services master
# carried seventeen, so revenue could not be grouped by Dept, a proposal could
# not cite the firm's service code, and an engagement letter had no words to
# assemble itself from. NO MIGRATION: a catalogue row is CONFIG, so the ten
# fields arrive as a new VERSION of a service — which is the one thing the
# registry's spine was built to make cheap.
FULLSVC='{"key":"bookkeeping","body":{"name":"Monthly bookkeeping","ref":"A1","description":"Books written up monthly","category":"accounting","module":"FRC","group":"VCFO CONSOLE","jurisdictions":["IN"],"billingBasis":"retainer","recurrence":"monthly","slaDays":30,"listPrice":{"amount":"18000.00","currency":"INR"},"pricingNote":"Plus statutory fees at actuals","scope":"Maintain the books of account monthly.","clientObligations":"Records by the 5th of the following month.","volumeLimits":"Under 1,000 entries; under 8 bank accounts.","exclusions":"Statutory audit is not included."}}'
chk "a service filed, scoped and priced"    201 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$FULLSVC")"
chk "…and it goes into force"               200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/bookkeeping/versions/1/publish -H "$H")"
# The read is the whole point. A body is stored VERBATIM, so a field the write
# accepts and the read cannot hand back is a field that does not exist, in the
# one way that looks from the outside exactly like a field that does.
ROUNDTRIP=$(curl -s -b $J/partner.txt $API/api/v1/config/service/bookkeeping | python3 -c '
import sys, json
want = {
    "ref": "A1", "module": "FRC", "group": "VCFO CONSOLE",
    "recurrence": "monthly", "slaDays": 30,
    "pricingNote": "Plus statutory fees at actuals",
    "scope": "Maintain the books of account monthly.",
    "clientObligations": "Records by the 5th of the following month.",
    "volumeLimits": "Under 1,000 entries; under 8 bank accounts.",
    "exclusions": "Statutory audit is not included.",
}
b = next(v["body"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1)
lost = sorted(f for f, v in want.items() if b.get(f) != v)
print("%d of %d" % (len(want) - len(lost), len(want)) if not lost else "lost %s" % lost)')
chk "…and every new field reads back"       "10 of 10" "$ROUNDTRIP"

# The two reporting axes are demanded in CANONICAL form at the WRITE, because a
# body is stored verbatim and the whole job of the field is to be GROUPED BY:
# "frc" beside "FRC" is one Dept reported as two half-sized ones that both look
# plausible, and a read-time fix comes long after the SQL has already split it.
LOWMOD='{"key":"lowmod","body":{"name":"X","billingBasis":"fixed","module":"frc"}}'
LOWGRP='{"key":"lowgrp","body":{"name":"X","billingBasis":"fixed","group":"Fincompliance"}}'
chk "a Dept in lower case is refused"       400 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$LOWMOD")"
chk "…and a delivery team, the same way"    400 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$LOWGRP")"
# A refusal that says "invalid" teaches nobody the form, so it has to name the
# field, the shape wanted, and what it actually got.
SAYS=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$LOWMOD" | python3 -c '
import sys, json
m = json.load(sys.stdin)["error"]["message"]
print("/".join(w for w in ("module", "Upper case", "frc") if w in m))')
chk "…naming the field and the valid form"  "module/Upper case/frc" "$SAYS"

# `recurrence` is how often the work comes round; `billingBasis` is what the
# price is per. They vary independently — a monthly service is routinely billed
# quarterly — so a billing basis offered as a recurrence is refused, not coerced.
BADREC='{"key":"badrec","body":{"name":"X","billingBasis":"fixed","recurrence":"retainer"}}'
chk "a recurrence that is a billing basis"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service -H "$H" -d "$BADREC")"

# Every one of the ten is OPTIONAL, and that is load-bearing rather than
# lenient: a published version is FROZEN, so a required field would strand every
# version already published. gst-filing v1 above is one — quoted on a proposal,
# uneditable, and with no honest value to invent for a field it never stated.
BARE=$(curl -s -b $J/partner.txt $API/api/v1/config/service/gst-filing | python3 -c '
import sys, json
new = ("ref", "module", "group", "recurrence", "slaDays", "pricingNote",
       "scope", "clientObligations", "volumeLimits", "exclusions")
b = next(v["body"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1)
print("%d/%s" % (sum(1 for f in new if f in b), b["name"]))')
chk "a version older than the fields reads" "0/GST monthly filing" "$BARE"

# THE ONE T3.1 IS BLOCKED ON. A work item copies `slaDays` AT CREATION, off the
# version the document PINNED, so a later catalogue revision cannot make
# finished work retroactively late. Revise the SLA, then read it back through a
# line that pinned the version before the revision.
BKV2='{"body":{"name":"Monthly bookkeeping","billingBasis":"retainer","recurrence":"monthly","slaDays":90}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/service/bookkeeping/versions -H "$H" -d "$BKV2"
chk "the firm revises the SLA to 90 days"   200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/bookkeeping/versions/2/publish -H "$H")"
BKV1=$(curl -s -b $J/partner.txt $API/api/v1/config/service/bookkeeping | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
SLAORG=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Pinecrest Retail Private Limited","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
SLADRAFT='{"partyId":"'$SLAORG'","title":"Pinecrest - bookkeeping","currency":"INR","fxRate":"1","fxRateDate":"2026-06-01","validUntil":"2027-01-31"}'
SLAPR=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/proposals -H "$H" -d "$SLADRAFT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
SLALINE='{"serviceVersionId":"'$BKV1'","description":"Monthly bookkeeping, 12 months","quantity":"12","unitAmount":"18000.00"}'
chk "a line pins the version before it"     201 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$SLAPR/lines -H "$H" -d "$SLALINE")"
PIN=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$SLAPR | python3 -c '
import sys, json
s = json.load(sys.stdin)["lines"][0]["service"]
print("%s %s" % (s["key"], s["version"]))')
PINKEY=${PIN%% *}; PINVER=${PIN##* }
# THE CHECK THAT PROVES T3.1 IS UNBLOCKED. A work item snapshots the SLA in
# force when it is created, read off the PINNED version — so the SLA has to come
# back ON THE LINE, in the same call. Until G2.1's read-model half it did not,
# and this check had to resolve the pin itself through two more config calls.
# Reading it here from lines[0].service is the whole point.
PINNEDSLA=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$SLAPR | python3 -c '
import sys, json
print(json.load(sys.stdin)["lines"][0]["service"]["slaDays"])')
LIVESLA=$(curl -s -b $J/partner.txt $API/api/v1/config/service/$PINKEY | python3 -c '
import sys, json
vs = json.load(sys.stdin)["versions"]
print(next(v for v in vs if v["status"] == "published")["body"].get("slaDays"))')
chk "…and the LINE carries the SLA promised then" 30 "$PINNEDSLA"
chk "…while the catalogue has moved on"           90 "$LIVESLA"
chk "…and the line cites the firm's own code"     "$(curl -s -b $J/partner.txt $API/api/v1/config/service/$PINKEY | python3 -c '
import sys, json
print(next(v for v in json.load(sys.stdin)["versions"] if v["version"] == 1)["body"].get("ref"))')" \
  "$(curl -s -b $J/partner.txt $API/api/v1/proposals/$SLAPR | python3 -c '
import sys, json
print(json.load(sys.stdin)["lines"][0]["service"]["ref"])')"

# G1.6. `unit_amount` used to be NOT NULL, so "as mutually agreed" had to be
# quoted as zero — which says something completely different to a client. The
# total is now a FLOOR when anything is unpriced, and the count is what stops a
# partner reading a wholly-unpriced document's zero as free work.
#
# A line with NEITHER a fee NOR a reason is quoted at the catalogue's list
# price for the version it pins (audit 2026-10-03, B09): a login that cannot see
# fees sends neither, and its lines used to come out "as mutually agreed". So
# "unpriced" is now something a person SAYS, with the reason, and only then.
chk "a line with no fee and no reason takes the list price" 201 \
  "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$SLAPR/lines -H "$H" -d '{"serviceVersionId":"'$BKV1'","description":"Clean-up, at list","quantity":"1"}')"
chk "…and one with a reason is left unpriced" 201 \
  "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$SLAPR/lines -H "$H" -d '{"serviceVersionId":"'$BKV1'","description":"Clean-up, scope TBD","quantity":"1","pricingNote":"As mutually agreed once the ledger is seen."}')"
# A proposal's `totals` is one row per currency, its main currency first (0344).
UNPRICED=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$SLAPR | python3 -c '
import sys, json
d = json.load(sys.stdin)
listed = next(l for l in d["lines"] if l["description"] == "Clean-up, at list")
line = next(l for l in d["lines"] if l["description"] == "Clean-up, scope TBD")
print("%s/%s/%s/%s/%s" % (d["totals"][0]["unpricedLineCount"], d["totals"][0]["net"], listed["net"], line["priced"], line["net"]))')
# 216000 before these two, plus bookkeeping v1's list price (18000) for the one
# that said nothing; the one with a reason adds nothing and is counted.
chk "…the total says how much it does NOT cover" "1/234000.0000/18000.0000/False/None" "$UNPRICED"

# G1.6's overrides are what make an issued document reproducible: the letter
# carries its own wording, so a later catalogue revision cannot change what a
# signed document says. The catalogue's words stay readable beside it.
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/proposals/$SLAPR/lines -H "$H" \
  -d '{"serviceVersionId":"'$BKV1'","description":"Bookkeeping, tailored","quantity":"1","unitAmount":"5000.00","scopeOverride":"Ledgers only. No payroll."}'
TAILORED=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$SLAPR | python3 -c '
import sys, json
line = next(l for l in json.load(sys.stdin)["lines"] if l["description"].endswith("tailored"))
print("%s/%s" % (line["terms"]["scope"]["tailored"], line["terms"]["scope"]["text"]))')
chk "a tailored scope says it was tailored" "True/Ledgers only. No payroll." "$TAILORED"

echo; echo "── 8. Whose law governs — a clause says it in two halves ───────────"
# G1.8, the SCHEMA half. A clause could state its terms only in prose, so
# "governed by the laws of India" on a letter issued by the UAE entity was a
# sentence no machine could compare — and a human review let exactly that
# through once, on a letter that reached a client. The code makes the term
# comparable, the words make it printable, and neither does the other's job.
#
# The WIRING half is built now: `addClause` resolves where the ISSUING ENTITY is
# registered and refuses a term that is not its. Proven at the end of this
# section, on the letter the firm actually caught.
LAWCLAUSE='{"key":"governing-law-in","body":{"title":"Governing law and jurisdiction","text":"This engagement is governed by the laws of the Republic of India.","jurisdictions":["IN"],"governingLaw":{"jurisdiction":"IN","text":"the laws of the Republic of India"},"courts":{"jurisdiction":"IN","text":"the courts at Bengaluru"}}}'
chk "a clause names its law and its courts" 201 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$LAWCLAUSE")"
chk "…and publishes"                        200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/clause/governing-law-in/versions/1/publish -H "$H")"
TERMS=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/governing-law-in | python3 -c '
import sys, json
b = next(v["body"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1)
print("%s %s/%s %s" % (b["governingLaw"]["jurisdiction"], b["governingLaw"]["text"],
                       b["courts"]["jurisdiction"], b["courts"]["text"]))')
chk "…and both halves read back"            "IN the laws of the Republic of India/IN the courts at Bengaluru" "$TERMS"

# A HALF term is refused, in both directions. A code with no words prints
# nothing where a law was supposed to be; words with no code are invisible to
# the equality test the code exists for.

# The code is demanded in canonical UPPER CASE at the write, for the same reason
# the Dept is: a body is stored verbatim, so "in" is what a comparison gets.

# The other half of OPTIONAL, and the reason it has to be. Every clause
# published before G1.8 states neither term, is FROZEN, and is PINNED by letters
# already issued — so the accessor falls back rather than throwing and those
# letters keep resolving. Proved where it would actually break: on a letter that
# pins one of each and has to print both.
PLAINCLAUSE='{"key":"confidentiality","body":{"title":"Confidentiality","text":"Each party keeps the other in confidence.","jurisdictions":[]}}'
chk "a clause stating neither term"         201 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$PLAINCLAUSE")"
chk "…publishes just the same"              200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/clause/confidentiality/versions/1/publish -H "$H")"
LAWV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/governing-law-in | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
PLAINV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/confidentiality | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
LAWORG=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Harbour Ridge Advisory Private Limited","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
LAWELDRAFT='{"partyId":"'$LAWORG'","jurisdiction":"IN","title":"Harbour Ridge - terms","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}'
LAWEL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d "$LAWELDRAFT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# ── G1.8, the WIRING half ──────────────────────────────────────────────────
# FAIL-CLOSED FIRST, and this is the state every firm starts in. `createTenant`
# seeds the firm's own entity as an organization with no `core.legal_entity`
# row, because nothing knows the firm's country at creation — so there is
# nothing to compare a governing law against, and the clause is refused rather
# than printed unchecked. 409, not 400: the request is fine, a row is missing.
chk "an unregistered issuer refuses a law"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$LAWEL/clauses -H "$H" -d '{"clauseVersionId":"'$LAWV'"}')"
chk "…while a clause naming no law goes on" 204 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$LAWEL/clauses -H "$H" -d '{"clauseVersionId":"'$PLAINV'"}')"

# Register the firm's own entity in India, and the same clause is now checkable
# and correct. This is the whole remedy the refusal above asks for.
FIRMENT=$(curl -s -b $J/partner.txt $API/api/v1/firm-entities/preferences | python3 -c '
import sys, json
print(next(p["firmEntityPartyId"] for p in json.load(sys.stdin)["preferences"] if p["clientJurisdiction"] == "*"))')
chk "register the firm entity in IN"        201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/organizations/$FIRMENT/legal-entities -H "$H" -d '{"jurisdiction":"IN","entityType":"private_limited"}')"
REGD=$(curl -s -b $J/partner.txt $API/api/v1/firm-entities/preferences | python3 -c '
import sys, json
print(next(p["firmEntity"]["jurisdiction"] for p in json.load(sys.stdin)["preferences"] if p["clientJurisdiction"] == "*"))')
chk "…and the rule screen shows where"      "IN" "$REGD"
chk "…now the Indian clause goes on"        204 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$LAWEL/clauses -H "$H" -d '{"clauseVersionId":"'$LAWV'"}')"

PRINTED=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$LAWEL | python3 -c '
import sys, json
cs = {c["key"]: c["text"] for c in json.load(sys.stdin)["clauses"]}
print("%s/%s" % (cs["governing-law-in"][:8], cs["confidentiality"][:10]))')
chk "…and the letter prints both"           "This eng/Each party" "$PRINTED"

# The STRUCTURED terms reach the wire beside the prose. Without this the two
# fields could be stored, validated and refused against, and then reach nothing:
# a renderer asking "whose law does this letter name" had a paragraph to read,
# which is the position the firm's original letter was written from.
STRUCT=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$LAWEL | python3 -c '
import sys, json
cs = {c["key"]: c for c in json.load(sys.stdin)["clauses"]}
law, plain = cs["governing-law-in"], cs["confidentiality"]
print("%s/%s/%s" % (law["governingLaw"]["jurisdiction"], law["courts"]["text"],
                    plain["governingLaw"] is None))')
chk "…and hands over the terms structured"  "IN/the courts at Bengaluru/True" "$STRUCT"

# THE ACCEPTANCE, and the sharpest finding of the original project: the real
# letter was issued by the firm's US entity to a US client and its standard
# terms named Indian law and Delhi courts. A human review let it out. Here the
# firm opens a US entity, routes US clients to it, and the SAME Indian clause is
# refused on the letter that entity issues — note the clause is scoped to IN
# and the letter is written for US, so the message has to say which check bit.
USORG=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"10x Global Inc.","jurisdiction":"US","entityType":"other","financialYearEnd":"12-31"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
chk "the firm opens a US entity"            200 "$(code -b $J/partner.txt $API/api/v1/parties/$USORG)"
chk "…and routes US clients to it"          200 "$(code -b $J/partner.txt -XPOST $API/api/v1/firm-entities/preferences -H "$H" -d '{"clientJurisdiction":"US","firmEntityPartyId":"'$USORG'","note":"US clients contract with the US entity."}')"
USLAW='{"key":"governing-law-us","body":{"title":"Governing law and jurisdiction","text":"This engagement is governed by the laws of the State of Delaware.","jurisdictions":[],"governingLaw":{"jurisdiction":"US","text":"the laws of the State of Delaware"},"courts":{"jurisdiction":"US","text":"the state and federal courts of Delaware"}}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$USLAW"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause/governing-law-us/versions/1/publish -H "$H"
USLAWV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/governing-law-us | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
# An UNSCOPED Indian-law clause, which is what the real one was: `jurisdictions`
# is empty, so the pre-existing check passes it and every word of it is true.
ANYLAW='{"key":"governing-law-any","body":{"title":"Governing law","text":"This engagement is governed by the laws of the Republic of India.","jurisdictions":[],"governingLaw":{"jurisdiction":"IN","text":"the laws of the Republic of India"},"courts":{"jurisdiction":"IN","text":"the courts at New Delhi"}}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause -H "$H" -d "$ANYLAW"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/clause/governing-law-any/versions/1/publish -H "$H"
ANYLAWV=$(curl -s -b $J/partner.txt $API/api/v1/config/clause/governing-law-any | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
USELDRAFT='{"partyId":"'$LAWORG'","jurisdiction":"US","title":"Harbour Ridge US - terms","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}'
USEL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d "$USELDRAFT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
ISSUER=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$USEL | python3 -c '
import sys, json
print(json.load(sys.stdin)["issuingEntity"]["displayName"])')
chk "a US letter is issued by the US entity" "10x Global Inc." "$ISSUER"
chk "…and it REFUSES Indian governing law"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$USEL/clauses -H "$H" -d '{"clauseVersionId":"'$ANYLAWV'"}')"
WHY=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$USEL/clauses -H "$H" -d '{"clauseVersionId":"'$ANYLAWV'"}' | python3 -c '
import sys, json
e = json.load(sys.stdin)["error"]
print("%s/%s" % (e["reason"], "IN" in e["message"] and "US" in e["message"]))')
chk "…naming both sides of the mismatch"    "CLAUSE_LAW_NOT_ISSUERS/True" "$WHY"
chk "…while ITS OWN law goes on"            204 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$USEL/clauses -H "$H" -d '{"clauseVersionId":"'$USLAWV'"}')"

echo; echo "── 9. The lead pipeline — dedup before create ──────────────────────"
PAN2=AAACL5678M
LEAD1='{"source":"inbound","title":"FY26 statutory audit","kind":"organization","name":"Lakeview Foods Private Limited","identifiers":[{"type":"pan","value":"'$PAN2'"},{"type":"email","value":"ops-'$S'@lakeview.example"}]}'
curl -s -o $J/lead1.json -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$LEAD1"
chk "capture a new lead"               201 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"outbound","title":"Bookkeeping retainer","kind":"organization","name":"Northwind Traders","identifiers":[{"type":"email","value":"hello-'$S'@northwind.example"}]}')"

# The acceptance: the same prospect, reached a different way, does not become a
# second party or a second opportunity.
LEAD2='{"source":"referral","title":"Transfer pricing study","kind":"organization","name":"Lakeview Foods Pvt Ltd","identifiers":[{"type":"pan","value":"'$PAN2'"},{"type":"phone","value":"+91 98180 11223"}]}'
MERGE=$(curl -s -o $J/merge.json -w '%{http_code}' -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$LEAD2")
chk "a duplicate does not create a lead" 200 "$MERGE"
SAME=$(python3 -c '
import json, sys
a = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])
print("%s/%s" % (a["lead"]["id"] == b["lead"]["id"], b["merged"]))' "$(cat $J/lead1.json)" "$(cat $J/merge.json)" 2>/dev/null || echo "?")
chk "…it lands on the existing one"     "True/True" "$SAME"
# OPEN is the three terminal stages' complement, and `abandoned` is one of them
# since 0030 — the same list the assignment rotation counts desks with. Left as
# ("converted","lost") it happens to answer 2 here only because nothing is
# abandoned yet, which is a check that would go quietly wrong the day one is.
ONE=$(curl -s -b $J/partner.txt "$API/api/v1/leads" | python3 -c '
import sys, json
leads = json.load(sys.stdin)["leads"]
print(len([r for r in leads if r["lead"]["stage"] not in ("converted","lost","abandoned")]))')
chk "two captures, two open leads"      2 "$ONE"
# The pipeline read names its prospect rather than handing a screen a uuid.
NAMED=$(curl -s -b $J/partner.txt "$API/api/v1/leads" | python3 -c '
import sys, json
print(sorted(r["party"]["displayName"] for r in json.load(sys.stdin)["leads"])[0])')
chk "…and each one names its prospect"  "Lakeview Foods Private Limited" "$NAMED"

chk "a lead with no way to reach them"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"inbound","title":"Unreachable","kind":"organization","name":"Anonymous Ltd","identifiers":[{"type":"cin","value":"U17110MH2019PTC123456"}]}')"
chk "a source we cannot report on"      400 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"linkedin","title":"Unreportable source","kind":"person","name":"A N Other","identifiers":[{"type":"email","value":"x-'$S'@y.example"}]}')"

LID=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["lead"]["id"])' "$(cat $J/lead1.json)")
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

echo; echo "── 10. A lead has a name, and a closed one says why ────────────────"
# G3.1. Before `title`, every pipeline row rendered the CLIENT's name, so a firm
# quoting one client for two things saw the same row twice with nothing to tell
# them apart.
#
# HOW MANY OPPORTUNITIES ONE CLIENT MAY HAVE AT ONCE: exactly one, and that is
# the schema's answer rather than a limitation of this test.
# `lead_one_open_per_party` is a UNIQUE index over the OPEN stages, and the
# capture path enforces the same rule earlier and more kindly by MERGING — which
# section 9 proves. So a client's second opportunity is a second ROW only once
# the first has closed, and Lakeview's audit converted up there, which makes its
# transfer pricing study a real one.
LKV=$(python3 -c 'import json;print(json.load(open("'$J'/lead1.json"))["lead"]["partyId"])')
SECOND='{"source":"referral","title":"FY27 transfer pricing study","kind":"organization","name":"Lakeview Foods Private Limited","identifiers":[{"type":"pan","value":"'$PAN2'"}]}'
chk "a second opportunity, once one closed" 201 \
  "$(curl -s -o $J/second.json -w '%{http_code}' -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$SECOND")"
chk "…on the party the firm already had"    "True/False" "$(python3 -c '
import json
d = json.load(open("'$J'/second.json"))
print("%s/%s" % (d["matchedExistingParty"], d["merged"]))')"
# THE ACCEPTANCE LINE: one client, two opportunities, told apart on the list by
# what each one is FOR — not by a uuid and not by the client name twice over.
BOTH=$(curl -s -b $J/partner.txt "$API/api/v1/leads" | python3 -c '
import sys, json
rs = [r for r in json.load(sys.stdin)["leads"] if r["lead"]["partyId"] == "'$LKV'"]
print("%d/%d/%d" % (len(rs), len({r["party"]["displayName"] for r in rs}),
                    len({r["lead"]["title"] for r in rs})))')
chk "…one client, one name, two titles"     "2/1/2" "$BOTH"

# A title of nothing is the blank row the column was added to prevent, and
# whitespace satisfies both NOT NULL and the wire's `min(1)` — so the refusal
# has to come from the RULE. The reason code is checked for exactly that: a 400
# alone could have been the shape validator agreeing by accident.
BLANK='{"source":"inbound","title":"   ","kind":"organization","name":"Nameless Ventures Private Limited","identifiers":[{"type":"email","value":"hello-'$S'@nameless.example"}]}'
chk "a title of nothing but spaces"         400 \
  "$(curl -s -o $J/blank.json -w '%{http_code}' -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$BLANK")"
chk "…refused by the rule, not the shape"   BLANK_TITLE \
  "$(python3 -c 'import json;print(json.load(open("'$J'/blank.json"))["error"]["reason"])')"

# `abandoned` is NOT a synonym for `lost`, and that is the whole point of it: a
# prospect who went quiet is a FOLLOW-UP problem, one who chose a competitor is
# a PRICING problem. They are the firm's two fixable failures and they have
# opposite remedies, so a pipeline that collapses them can report a conversion
# rate and never say which of the two to go and fix.
# Both are captured straight into the unassigned queue on purpose (`ownerUserId`
# null), so closing them says nothing about anybody's desk.
QUIET='{"source":"inbound","title":"Payroll outsourcing","kind":"organization","name":"Silverbirch Interiors Private Limited","ownerUserId":null,"identifiers":[{"type":"email","value":"admin-'$S'@silverbirch.example"}]}'
BEATEN='{"source":"outbound","title":"Internal audit retainer","kind":"organization","name":"Cobalt Mills Private Limited","ownerUserId":null,"identifiers":[{"type":"email","value":"cfo-'$S'@cobaltmills.example"}]}'
QID=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$QUIET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lead"]["id"])')
BID=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$BEATEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lead"]["id"])')
chk "an unwon close with no reason"         400 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads/$BID/stage -H "$H" -d '{"stage":"lost"}')"
GONEQUIET='{"stage":"abandoned","lostReason":"Three calls and two emails since June, no reply."}'
UNDERCUT='{"stage":"lost","lostReason":"Went with their existing auditor, who quoted under us."}'
chk "they went quiet — abandoned"           200 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads/$QID/stage -H "$H" -d "$GONEQUIET")"
chk "they chose a competitor — lost"        200 "$(code -b $J/partner.txt -XPOST $API/api/v1/leads/$BID/stage -H "$H" -d "$UNDERCUT")"
APART=$(curl -s -b $J/partner.txt "$API/api/v1/leads?stage=abandoned" | python3 -c '
import sys, json
rs = json.load(sys.stdin)["leads"]
print("%d/%s" % (len(rs), rs[0]["lead"]["title"] if rs else "none"))')
chk "…and the two are separate stages"      "1/Payroll outsourcing" "$APART"
WHY=$(curl -s -b $J/partner.txt $API/api/v1/leads/$BID | python3 -c '
import sys, json
l = json.load(sys.stdin)["lead"]
print("%s/%s/%s" % (l["stage"], l["closedAt"] is not None, l["lostReason"][:15]))')
chk "…in the closer's own words, read back" "lost/True/Went with their" "$WHY"

# The other direction, and it is the one a CHECK constraint also holds
# (`lead_lost_reason_scope_chk`): a reason on a lead that did not close unwon is
# a sentence in a column nothing ever reads. The second Lakeview opportunity is
# open, so it is the honest place to try it.
LKVID=$(python3 -c 'import json;print(json.load(open("'$J'/second.json"))["lead"]["id"])')
NOTLOST='{"stage":"qualified","lostReason":"they said we were expensive"}'
chk "a reason on a lead that is not closed" 400 \
  "$(curl -s -o $J/notapp.json -w '%{http_code}' -b $J/partner.txt -XPOST $API/api/v1/leads/$LKVID/stage -H "$H" -d "$NOTLOST")"
chk "…only lost and abandoned take one"     LOST_REASON_NOT_APPLICABLE \
  "$(python3 -c 'import json;print(json.load(open("'$J'/notapp.json"))["error"]["reason"])')"

echo; echo "── 11. A lead with no owner lands on a desk ────────────────────────"
# T2.1b. The rotation state is DERIVED, not stored: an unclaimed lead goes to
# the active staff member with the FEWEST OPEN LEADS, ties broken by user id.
# A pointer column would go stale the moment somebody joins or leaves — the
# joiner waits a full lap, the leaver stalls the rotation — while a query cannot.
#
# Leads captured earlier in this script are already on desks and count toward
# "fewest", so the expectation below is computed from the state we are actually
# in rather than assumed to start at zero.
PARTNERUID=$(cat $J/partner.id); ASSOCUID=$(cat $J/associate.id); CLIENTUID=$(cat $J/client.id)
curl -s -o $J/desks-before.json -b $J/partner.txt "$API/api/v1/leads"
for i in 1 2 3 4; do
  ROT='{"source":"inbound","title":"Rotation check '$i'","kind":"organization","name":"Rotation Test '$i' Private Limited","identifiers":[{"type":"email","value":"desk'$i'-'$S'@rotation.example"}]}'
  curl -s -o $J/rot$i.json -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$ROT"
done
curl -s -o $J/desks-after.json -b $J/partner.txt "$API/api/v1/leads"
chk "a capture naming no owner gets a desk" yes "$(python3 -c '
import json
print("yes" if json.load(open("'$J'/rot1.json"))["lead"]["ownerUserId"] else "no")')"
# WHICH RULE chose, not just who. "The rotation picked Anand" and "the partner
# picked Anand" are different facts and only the first is evidence about whether
# assignment is working at all.
ROTID=$(python3 -c 'import json;print(json.load(open("'$J'/rot1.json"))["lead"]["id"])')
RULE=$(curl -s -b $J/partner.txt "$API/api/v1/objects/lead/$ROTID/events" | python3 -c '
import sys, json
e = next(r["event"] for r in json.load(sys.stdin)["events"] if r["event"]["verb"] == "lead.captured")
print("%s/%s" % (e["payload"]["ownerAssignedBy"], e["payload"]["ownerUserId"] is not None))')
chk "…and the ledger names the RULE"        "round_robin/True" "$RULE"

# THE ACCEPTANCE LINE: four captures, and the firm's two active staff take two
# each. The client contact is CLIENT_PORTAL and is not a candidate — a lead on a
# desk that cannot reach the workspace is an opportunity nobody is working.
python3 -c '
import collections, json
STAFF = ["'$PARTNERUID'", "'$ASSOCUID'"]
def desks(path):
    c = collections.Counter({u: 0 for u in STAFF})
    for r in json.load(open(path))["leads"]:
        if r["lead"]["stage"] in ("converted", "lost", "abandoned"): continue
        if r["owner"]: c[r["owner"]["userId"]] += 1
    return c
before = desks("'$J'/desks-before.json")
after = desks("'$J'/desks-after.json")
# What the rule PROMISES from the desks as they actually stood: hand each of the
# four to whichever desk is smallest at that moment, ties to the lower user id.
want = dict(before)
for _ in range(4):
    want[min(STAFF, key=lambda u: (want[u], u))] += 1
print(sorted(after[u] - before[u] for u in STAFF))
print("as the rule says" if all(after[u] == want[u] for u in STAFF)
      else "%s, wanted %s" % (dict(after), want))
print(sum(1 for r in json.load(open("'$J'/desks-after.json"))["leads"]
          if r["owner"] and r["owner"]["userId"] == "'$CLIENTUID'"))
print("    desks, before and after: %s -> %s"
      % ([before[u] for u in STAFF], [after[u] for u in STAFF]))' > $J/desks.txt
chk "four captures, two to each desk"       "[2, 2]" "$(sed -n 1p $J/desks.txt)"
chk "…each one to the emptiest desk then"   "as the rule says" "$(sed -n 2p $J/desks.txt)"
chk "…and never to the client contact"      0 "$(sed -n 3p $J/desks.txt)"
sed -n 4p $J/desks.txt

# T2.1b's OTHER half: a territory rule OVERRIDES the rotation. Kept to five
# requests because the walk was close to its per-minute budget (see the note by
# `code()`), so this proves the override and the fall-through and nothing else —
# the refusals and the revoked-desk case are unit and integration tests.
chk "the firm gives one desk the UK"        200 "$(code -b $J/partner.txt -XPOST $API/api/v1/territory-rules -H "$H" -d '{"jurisdiction":"GB","ownerUserId":"'$ASSOCUID'","note":"UK desk"}')"
chk "an associate cannot move a territory"  403 "$(code -b $J/associate.txt -XPOST $API/api/v1/territory-rules -H "$H" -d '{"jurisdiction":"GB","ownerUserId":"'$ASSOCUID'"}')"
curl -s -o $J/gb.json -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" \
  -d '{"source":"inbound","title":"UK holdco setup","kind":"organization","name":"Thames Holdings Ltd","jurisdiction":"GB","identifiers":[{"type":"email","value":"uk-'$S'@thames.example"}]}'
GBID=$(python3 -c 'import json;print(json.load(open("'$J'/gb.json"))["lead"]["id"])')
GBRULE=$(curl -s -b $J/partner.txt "$API/api/v1/objects/lead/$GBID/events" | python3 -c '
import sys, json
e = next(r["event"] for r in json.load(sys.stdin)["events"] if r["event"]["verb"] == "lead.captured")
print("%s/%s" % (e["payload"]["ownerAssignedBy"], e["payload"]["ownerUserId"] == "'$ASSOCUID'"))')
# The associate is the BUSIER desk by now, so the rotation would not have picked
# them — which is the only way to tell an override from a coincidence.
chk "…a UK lead lands on that desk"         "territory/True" "$GBRULE"
UNKNOWN=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d '{"source":"inbound","title":"Unknown country","kind":"organization","name":"Somewhere Trading","identifiers":[{"type":"email","value":"any-'$S'@somewhere.example"}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["lead"]["jurisdiction"] is None)')
chk "…and a lead with no country is fine"   "True" "$UNKNOWN"

# A rotation never overrules a person. Naming an owner at capture consults no
# strategy at all, and the timeline says so — `requested` is the ABSENCE of a
# policy, which is a materially different fact from the rotation happening to
# pick the same colleague.
PICKED='{"source":"referral","title":"Referral from the bank","kind":"organization","name":"Ridgeway Metals Private Limited","ownerUserId":"'$ASSOCUID'","identifiers":[{"type":"email","value":"finance-'$S'@ridgeway.example"}]}'
curl -s -o $J/picked.json -b $J/partner.txt -XPOST $API/api/v1/leads -H "$H" -d "$PICKED"
chk "a named owner keeps the lead"          yes "$(python3 -c '
import json
d = json.load(open("'$J'/picked.json"))
print("yes" if d["lead"]["ownerUserId"] == "'$ASSOCUID'" else d["lead"]["ownerUserId"])')"
PICKEDID=$(python3 -c 'import json;print(json.load(open("'$J'/picked.json"))["lead"]["id"])')
chk "…and the ledger says a person chose"   requested "$(curl -s -b $J/partner.txt "$API/api/v1/objects/lead/$PICKEDID/events" | python3 -c '
import sys, json
e = next(r["event"] for r in json.load(sys.stdin)["events"] if r["event"]["verb"] == "lead.captured")
print(e["payload"]["ownerAssignedBy"])')"

echo; echo "── 12. Proposals — quoted from the catalogue, and the discount gate ─"
# The catalogue version a line PINS: v1, which the firm has since superseded by
# v2. A quote reopened later must still read v1's list price, not today's.
SVCV1=$(curl -s -b $J/partner.txt $API/api/v1/config/service/gst-filing | python3 -c '
import sys, json
print(next(v["id"] for v in json.load(sys.stdin)["versions"] if v["version"] == 1))')
PID=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["lead"]["partyId"])' "$(cat $J/lead1.json)")
# Q076: a lead's prospect has no registration, and no proposal is drafted for
# a company with no country. The firm records it first, as on the client page.
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/parties/organizations/$PID/legal-entities -H "$H" -d '{"jurisdiction":"IN","entityType":"private_limited"}'

# NOTE ON QUOTING: every JSON body below is built into a variable FIRST. A
# backslash-escaped body written inline — -d "{\"a\":\"b\"}" — is unescaped by
# the OUTER quotes of "$(code ...)" before the command substitution runs, and
# bash then brace-expands the {a,b} that is left. curl silently receives several
# mangled URLs. It happens to work for a single-field body, which is why the
# pattern survived this long.

# Per-country quoting: the client is billed in AED, the firm's books are in INR
# (the reporting currency it was created with), and the rate is struck once.
# A POST THAT SAYS JSON SENDS JSON. Send takes an optional body, and a
# body-less POST declaring `content-type: application/json` is a malformed
# request the API refuses ("Malformed JSON in request body", 400) before any
# rule runs. That is what turned the whole proposal chain below red (audit
# 2026-10-03). So every Send here sends an empty object.
NOBODY='{}'
DRAFT='{"partyId":"'$PID'","title":"Lakeview - FY26 compliance","currency":"AED","fxRate":"23.4500","fxRateDate":"2026-06-01","validUntil":"2027-01-31"}'
PROP=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/proposals -H "$H" -d "$DRAFT")
PRID=$(echo "$PROP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "partner drafts a proposal in AED"     AED "$(echo "$PROP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["currency"])')"
chk "an empty proposal cannot be sent"     409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H" -d "$NOBODY")"

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
chk "no policy means any discount blocks"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H" -d "$NOBODY")"
POLICY='{"key":"discount","body":{"maxDiscountPercent":"15"}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/policy -H "$H" -d "$POLICY"
chk "the firm publishes a discount limit"  200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/policy/discount/versions/1/publish -H "$H")"
chk "40% is still past the 15% limit"      409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H" -d "$NOBODY")"
chk "the associate may not sign it off"    403 "$(code -b $J/associate.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
chk "the partner may"                      200 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
chk "…nothing to approve a second time"  409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/discount-approval -H "$H")"
SENT=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/send -H "$H" -d "$NOBODY")
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
print("%s/%s/%s" % (l["service"]["listPrice"]["amount"], p["totals"][0]["gross"], p["totals"][0]["net"]))')
chk "list price then, and what we charged" "25000.00/14400.0000/8640.0000" "$QUOTED"

# The FIFTH axis. The associate has no commercial visibility, so they see the
# document and not the money — redacted, never a 403, because "you may not see
# the fee" and "there is no proposal" are different answers.
REDACTED=$(curl -s -b $J/associate.txt $API/api/v1/proposals/$PRID | python3 -c '
import sys, json
p = json.load(sys.stdin)
print("%s/%s/%s" % (p["totals"][0]["net"], p["totals"][0]["currency"], p["lines"][0]["description"][:3]))')
chk "an associate sees the work, not the money" "None/AED/GST" "$REDACTED"

# Staff no longer ACCEPT through /decision (0317): a client's yes given
# outside the link is recorded, with how and when, by acceptance:record (a
# partner). The firm here is on UTC, so "today" is the UTC day.
ACCEPT='{"decision":"accepted"}'
RECORDED="{\"channel\":\"call\",\"acceptedOn\":\"$(date -u +%F)\",\"acceptedByName\":\"Smoke Client\",\"note\":\"Said yes on a call.\"}"
chk "accepting through /decision is refused" 409 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/decision -H "$H" -d "$ACCEPT")"
chk "the partner records the client's yes"  200 "$(code -b $J/partner.txt -XPOST $API/api/v1/proposals/$PRID/acceptance -H "$H" -d "$RECORDED")"

# The share link: the one route in this product with no session behind it. A
# proposal goes to somebody who has no login and will not get one.
BADTOK='{"token":"not-a-link"}'
GOODTOK='{"token":"'$SHARE'"}'
chk "an unknown link tells you nothing"    404 "$(code -XPOST $API/api/v1/proposals/shared -H "$H" -d "$BADTOK")"
SEEN=$(curl -s -XPOST $API/api/v1/proposals/shared -H "$H" -d "$GOODTOK")
chk "the recipient opens it, with no session" "Harbour Point" "$(echo "$SEEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["firmName"])')"
chk "…and reads what they were quoted"    8640.0000 "$(echo "$SEEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["totals"][0]["net"])')"
# Its own read model, not the staff one with fields nulled: a field added for
# colleagues cannot reach a client's screen by default.
INSIDES=$(echo "$SEEN" | python3 -c '
import sys, json
k = json.load(sys.stdin).keys()
print(",".join(sorted(f for f in ("partyId","leadId","fxRate","discountApprovedBy") if f in k)) or "none")')
chk "the client sees none of the firm's insides" none "$INSIDES"
# The count is SITTINGS, not requests (VIEW_DEDUPE_MINUTES): a second open
# inside half an hour is a refresh or a link preview, and must not read to a
# partner as the client coming back.
curl -s -o /dev/null -XPOST $API/api/v1/proposals/shared -H "$H" -d "$GOODTOK"
VIEWS=$(curl -s -b $J/partner.txt $API/api/v1/proposals/$PRID | python3 -c 'import sys,json;print(json.load(sys.stdin)["proposal"]["viewCount"])' 2>/dev/null || echo "?")
chk "two opens in one sitting count once"  1 "$VIEWS"

echo; echo "── 13. Engagement letters — the document that creates obligations ──"
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
ENT1=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Lakeview Foods Private Limited","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
ENT2=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Lakeview Logistics Private Limited","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')

# An advance is required, so the fee gate is live for this walk.
ELDRAFT='{"partyId":"'$PID'","jurisdiction":"IN","title":"Lakeview - FY26 engagement","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28","advanceRequired":true,"advanceAmount":"10000"}'
EL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d "$ELDRAFT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "an advance with no amount is refused"  400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$PID'","jurisdiction":"IN","title":"x","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28","advanceRequired":true}')"
# WHO THE PROVIDER SHOULD ASK (0080). Required when the deployment signs
# through DocuSign, which raises an envelope at send; ignored under `attested`,
# which asks nobody. Sent either way so the walk is the same on both.
SIGNER='{"signer":{"name":"A Director","email":"client-'$S'@example.com"}}'
chk "an empty letter cannot go out"          409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H" -d "$SIGNER")"

ELLINE='{"entityPartyId":"'$ENT1'","serviceVersionId":"'$SVCV1'","description":"GST monthly filing, 12 months","quantity":"12","unitAmount":"2000","discountPercent":"0"}'
ELLINE2='{"entityPartyId":"'$ENT2'","serviceVersionId":"'$SVCV1'","description":"GST monthly filing, Logistics","quantity":"12","unitAmount":"1500","discountPercent":"0"}'
NOENT='{"serviceVersionId":"'$SVCV1'","description":"whose company?","quantity":"1","unitAmount":"1","discountPercent":"0"}'
chk "a letter line must name an entity"      400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$NOENT")"
# …AND ONE OF THE CLIENT'S OWN (F-10-1). Any party of the firm used to pass, so
# another client's company could be put on this client's letter and its work
# would land in this client's portal. Recorded under the client — the way the
# client page and the import record a group — the same line goes through.
chk "…and one the client is recorded as holding" 409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE")"
for E in $ENT1 $ENT2; do
  curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/parties/relationships -H "$H" -d '{"fromPartyId":"'$PID'","toPartyId":"'$E'","type":"parent_of","validFrom":"2020-04-01"}'
done
chk "agree a service"                        201 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE")"
chk "…and one for the sister company"      201 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE2")"
chk "a letter with no terms cannot go out"   409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H" -d "$SIGNER")"
chk "a UAE clause on an Indian letter"       400 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/clauses -H "$H" -d '{"clauseVersionId":"'$AEV'"}')"
chk "the right clause goes on"               204 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/clauses -H "$H" -d '{"clauseVersionId":"'$SCOPEV'"}')"
# CA#2 (audit 2026-10-03): a letter whose cover page says nothing ("Dear X, /
# Yours sincerely,") cannot go out. This firm has no standard opening, so the
# drafter writes one on the letter, as a person at a new firm does.
chk "a letter with no opening cannot go out" 409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H" -d "$SIGNER")"
OPENING='{"kind":"cover","body":"This letter confirms the services you have engaged us for.","sortOrder":1'
chk "write the letter's opening"             201 "$(code -b $J/partner.txt -XPOST $API/api/v1/document-blocks -H "$H" -d "$OPENING"',"engagementLetterId":"'$EL'"}')"
chk "now it can be sent"                     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/send -H "$H" -d "$SIGNER")"

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
# 0322 (Ashish): the advance holds no work. Signing starts every engagement.
chk "…and starts, advance or not (0322)"  active "$(echo "$SIGNED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["engagements"][0]["status"])')"
chk "a signed letter cannot be edited"       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/lines -H "$H" -d "$ELLINE")"
chk "…nor withdrawn"                       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL/withdraw -H "$H")"

# 0320: the advance is a TAX INVOICE, not a tick. 0322: signing drafts it at the
# company's default tax rate; this firm has none, so no draft is made (never a
# guessed 0%) and the advance says why. It is raised like any bill (here at 0%
# so the total is the advance) and issued.
NODRAFT=$(curl -s -b $J/partner.txt "$API/api/v1/billing/advances" | python3 -c '
import sys, json
a = [x for x in json.load(sys.stdin)["advances"] if x["letter"]["id"] == "'$EL'"]
print("%s/%s" % (a[0]["stage"], a[0]["draftBlocked"]) if len(a) == 1 else "count=%d" % len(a))')
chk "no tax rate: no automatic draft, and it says so" "not_raised/no_tax_rate" "$NODRAFT"
ADVDUE=$(curl -s -b $J/partner.txt "$API/api/v1/billing/dues?partyId=$PID" | python3 -c '
import sys, json
ds = [d for d in json.load(sys.stdin)["dues"] if d["kind"] == "advance"]
print(ds[0]["id"] if len(ds) == 1 else "count=%d" % len(ds))')
ADVINV=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/billing/raise -H "$H" -d '{"dueIds":["'$ADVDUE'"],"lines":[{"dueId":"'$ADVDUE'","taxPercent":"0"}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["invoiceId"])')
chk "signing wrote the advance bill; it is raised and issued" 200 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$ADVINV/issue -H "$H")"
chk "…and the client pays it"              201 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$ADVINV/payments -H "$H" -d '{"amount":"10000","receivedOn":"2026-08-29","method":"bank_transfer"}')"
ACTIVE=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$EL | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("%s/%s/%s" % (d["engagements"][0]["status"], len(d["clauses"]), d["clauses"][0]["text"][:8]))')
chk "the engagement is active, terms pinned" "active/1/The firm" "$ACTIVE"
# A read model carries NAMES, not ids: this is exactly where a group client's
# companies have to be told apart, so a column of uuids is what it must not be.
NAMED=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$EL | python3 -c '
import sys, json
print("|".join(sorted(l["entity"]["displayName"] for l in json.load(sys.stdin)["lines"])))')
chk "…and the lines name their companies" "Lakeview Foods Private Limited|Lakeview Logistics Private Limited" "$NAMED"

echo; echo "── 14. Firm administration — the roster, and revocation ────────────"
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

echo; echo "── 15. Seniority — the ladder, and who is on it ────────────────────"
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

echo; echo "── 16. Archiving a party — hidden from pickers, never removed ──────"
# G0.3. Parties are permanent: there is no deleted_at in `core` and no DELETE
# route. Archiving means "keep this out of the pickers", and the asymmetry
# below IS the design — the LIST hides an archived party while reading ONE by
# id always resolves it, because a signed engagement letter's counterparty has
# to render forever.
# One call, body AND status — archiving twice is refused, so a second request
# just to read the code would be testing the refusal, not the archive.
ARCHCODE=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/archive -H "$H" -o $J/archive.json -w '%{http_code}')
chk "archive a party the firm mistyped"  200 "$ARCHCODE"
chk "…and it is stamped, not removed"  "yes" \
  "$(python3 -c 'import json;print("yes" if json.load(open("'$J'/archive.json")).get("archivedAt") else "no")')"
chk "…and it is gone from the picker"   0 \
  "$(curl -s -b $J/partner.txt "$API/api/v1/parties" | python3 -c 'import sys,json;print(sum(1 for p in json.load(sys.stdin)["parties"] if p["id"]=="'$ORG'"))')"
chk "…but returns when asked for"       1 \
  "$(curl -s -b $J/partner.txt "$API/api/v1/parties?includeArchived=true" | python3 -c 'import sys,json;print(sum(1 for p in json.load(sys.stdin)["parties"] if p["id"]=="'$ORG'"))')"
chk "…and STILL resolves by id"       200 "$(code -b $J/partner.txt $API/api/v1/parties/$ORG)"
chk "archiving twice is refused"        409 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/archive -H "$H" -o /dev/null)"
chk "bring it back"                     200 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/unarchive -H "$H" -o /dev/null)"
chk "…and unarchiving twice is refused" 409 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$ORG/unarchive -H "$H" -o /dev/null)"
# The refusal that matters, and it is enforced by a TRIGGER, not by the service:
# $PID is the party the lead in section 7 is about.
REFCODE=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/$PID/archive -H "$H" -o $J/refused.json -w '%{http_code}')
chk "a party a lead points at cannot be archived" 409 "$REFCODE"
chk "…and the refusal names what refers to it" "yes" \
  "$(python3 -c 'import json,sys;print("yes" if "lead" in json.dumps(json.loads(sys.argv[1])) else "no")' "$(cat $J/refused.json)")"

echo; echo "── 16b. The delivery engine — a signed contract becomes a job ───────"
# T2.6. The engagement letter above was signed AND its advance recorded, so
# `contract.activated` is in the ledger. Nothing has acted on it yet: the
# scheduler is a separate process, and this is the sweep it runs.
BEFORE=$(curl -s -b $J/partner.txt $API/api/v1/jobs | python3 -c '
import sys, json
print(len(json.load(sys.stdin)["jobs"]))')
chk "no job before the sweep runs"        0 "$BEFORE"

# The same code path the cron drives — a different entry point, never a
# different rule. It needs no queue, so it needs no DDL rights either.
(cd "$(dirname "$0")/.." && npm run --silent worker:once > /dev/null 2>&1)

AFTER=$(curl -s -b $J/partner.txt $API/api/v1/jobs | python3 -c '
import sys, json
print(len(json.load(sys.stdin)["jobs"]))')
# TWO, and that is the point rather than an accident. The letter above has a
# line for each of two sister companies, signing fanned it out into one
# engagement PER COMPANY — the firm's own "Per Company" rule (G0.1) — and the
# engine turns each into its own job. One job for "the client" would be the bug.
#
# ONCE, NOT PER MONTH, and that is the catalogue speaking. A PERIOD job (T6.13)
# is for a service whose body says monthly, quarterly or annually, and
# `gst-filing` here says none (section 6 publishes it with no recurrence; the
# product never defaults one). So each engagement owes ONE job, with no period.
# This check expected a period job from T6.13 on and was red since: the service
# is called "GST monthly filing", but a name is not a recurrence (audit
# 2026-10-03). The period job is proven below, on bookkeeping, which is monthly.
chk "one job per engagement, not per letter" 2 "$AFTER"
SHAPE=$(curl -s -b $J/partner.txt $API/api/v1/jobs | python3 -c '
import sys, json
j = json.load(sys.stdin)["jobs"][0]
print("%s/%s/%s/%s" % (j["sourceKind"], j["status"], j["templateVersionId"] is None, j["periodLabel"] is not None))')
chk "…owed once (no recurrence), pending, no graph yet" "engagement/pending/True/False" "$SHAPE"

# THE property the whole engine rests on. Every trigger is at-least-once, and a
# second job is a second set of tasks and eventually a second invoice.
(cd "$(dirname "$0")/.." && npm run --silent worker:once > /dev/null 2>&1)
AGAIN=$(curl -s -b $J/partner.txt $API/api/v1/jobs | python3 -c '
import sys, json
print(len(json.load(sys.stdin)["jobs"]))')
chk "a second sweep spawns nothing"       2 "$AGAIN"

# The trail says a clock did it, not whoever signed the letter.
SPAWNER=$(curl -s -b $J/partner.txt "$API/api/v1/events?limit=60" | python3 -c '
import sys, json
for r in json.load(sys.stdin)["events"]:
    if r["event"]["verb"] == "job.spawned":
        print("%s/%s" % (r["event"]["actorType"], r["actor"] is None)); break
else:
    print("no job.spawned event")')
chk "spawned by the system, not a person" "system/True" "$SPAWNER"

echo; echo "── 16b-2. Work items — what is owed, and whose desk it is on ───────"
# T3.1. The sweep above created two JOBS. A job is HOW work gets done — which
# template, which steps. It has no assignee, no due date and no state in the
# firm's own words, which is what this section is about.
#
# The two work items it produced are the HONEST GAP first: `gst-filing` is filed
# under no Dept and states no SLA, so there is nothing to route on and nothing
# to date from. The item is created anyway — losing the task because we could
# not decide who it belonged to is the worst failure available here — and it
# says WHY in a sentence, which is what makes an unassigned queue something a
# person can clear.
WI=$API/api/v1/work-items
SPAWNED=$(curl -s -b $J/partner.txt $WI | python3 -c '
import sys, json
items = json.load(sys.stdin)["items"]
mine = [i for i in items if i["engagementId"] is not None]
print("%d/%s/%s" % (
    len(mine),
    all(i["assignee"] is None for i in mine),
    all(i["dueOn"] is None for i in mine)))')
chk "one work item per engagement"        "2/True/True" "$SPAWNED"
UNROUTED=$(curl -s -b $J/partner.txt $WI | python3 -c '
import sys, json
items = [i for i in json.load(sys.stdin)["items"] if i["engagementId"] is not None]
print("Dept" in (items[0]["assignmentNote"] or ""))')
chk "…and each says WHY nobody has it"    "True" "$UNROUTED"

# A SECOND sweep must add nothing. Every route into it is at-least-once, and a
# second work item is a second task on a desk for work already being done.
(cd "$(dirname "$0")/.." && npm run --silent worker:once > /dev/null 2>&1)
AGAINWI=$(curl -s -b $J/partner.txt $WI | python3 -c '
import sys, json
print(len([i for i in json.load(sys.stdin)["items"] if i["engagementId"] is not None]))')
chk "a second sweep creates no second task" 2 "$AGAINWI"

# THE ACCEPTANCE LINE. Now do it properly: a Dept the firm actually has, a SPOC
# on the client for it, and a service filed under that Dept with an SLA. The
# filing then arrives pre-assigned, dated from the day the work begins.
FRC=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/tenancy/structure/axes -H "$H" -d '{"axis":"dept","code":"FRC","name":"Financial Reporting and Compliance"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
PARTNERID=$(cat $J/partner.id)
chk "the client gets a SPOC for FRC"      201 "$(code -b $J/partner.txt -XPOST $API/api/v1/parties/$PID/assignments -H "$H" -d '{"role":"spoc","axisId":"'$FRC'","userId":"'$PARTNERID'","validFrom":"2020-01-01"}')"

# `bookkeeping` is the service filed under FRC (section 5) — and section 5 also
# revised it to a 90-day SLA and dropped the Dept, which makes it the perfect
# service to prove the PINNED/LIVE split with. A third version puts the Dept
# back on what is IN FORCE, and the letter line pins version ONE.
#
# So the work item that comes out should carry BOTH answers at once:
#   · slaDaysSnapshot 30 — from the version the client actually SIGNED. A
#     catalogue revision must not make finished work retroactively late.
#   · Dept FRC — from what is published TODAY. A client agreed to the service,
#     not to which of our departments delivers it.
BKV3='{"body":{"name":"Monthly bookkeeping","billingBasis":"retainer","recurrence":"monthly","slaDays":90,"module":"FRC"}}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/config/service/bookkeeping/versions -H "$H" -d "$BKV3"
chk "the firm files bookkeeping under FRC again" 200 "$(code -b $J/partner.txt -XPOST $API/api/v1/config/service/bookkeeping/versions/3/publish -H "$H")"
BOOKV=$BKV1
EL2=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$PID'","jurisdiction":"IN","title":"Lakeview - bookkeeping","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL2/lines -H "$H" -d '{"entityPartyId":"'$ENT1'","serviceVersionId":"'$BOOKV'","description":"Monthly bookkeeping","quantity":"12","unitAmount":"18000","discountPercent":"0"}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL2/clauses -H "$H" -d '{"clauseVersionId":"'$SCOPEV'"}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/document-blocks -H "$H" -d "$OPENING"',"engagementLetterId":"'$EL2'"}'
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL2/send -H "$H" -d "$SIGNER"
curl -s -o /dev/null -b $J/partner.txt -XPOST $API/api/v1/engagement-letters/$EL2/signature -H "$H" -d '{"signedByName":"A Director","reference":"paper-002"}'
(cd "$(dirname "$0")/.." && npm run --silent worker:once > /dev/null 2>&1)

# Bookkeeping is MONTHLY, so since T6.13 what arrives is this MONTH's task,
# from a period job, named for its month ("Monthly bookkeeping · Oct 2026").
# This looked for the bare service name and found nothing from T6.13 on (audit
# 2026-10-03); the fourth field is the period job the section above defers to.
ROUTED=$(curl -s -b $J/partner.txt $WI | python3 -c '
import sys, json
items = json.load(sys.stdin)["items"]
b = [i for i in items if i["title"].startswith("Monthly bookkeeping")]
if not b:
    print("no bookkeeping work item"); raise SystemExit
i = b[0]
print("%s/%s/%s/%s" % (
    i["assignee"] is not None,
    i["slaDaysSnapshot"],
    i["deptName"],
    i["title"] != "Monthly bookkeeping"))')
chk "A FILING ARRIVES PRE-ASSIGNED TO ITS DEPT SPOC" "True/30/Financial Reporting and Compliance/True" "$ROUTED"
# Said twice on purpose. The 30 above came from the version the client signed
# and the FRC came from the one in force now, and getting either from the other
# would be a different product: a firm could not re-file a service without
# re-dating every task, or could re-date finished work by editing a catalogue.
DUE=$(curl -s -b $J/partner.txt $WI | python3 -c '
import sys, json
i = next(i for i in json.load(sys.stdin)["items"] if i["title"].startswith("Monthly bookkeeping"))
print(i["dueOn"] is not None and len(i["dueOn"]) == 10)')
chk "…dated from the day the work begins, plus the SLA" "True" "$DUE"

echo; echo "── 16b-3. The firm's own words for work, and the rules on them ─────"
# The states and priorities are ROWS, seeded at createTenant. The whole point is
# that a firm may rename any of them from a screen — so the FLAGS carry the
# meaning and nothing in the product ever compares a name.
VOCAB=$API/api/v1/work-vocabulary
SEEDED=$(curl -s -b $J/partner.txt $VOCAB | python3 -c '
import sys, json
v = json.load(sys.stdin)
print("%d/%d/%d/%d" % (
    len(v["states"]), len(v["priorities"]),
    sum(1 for s in v["states"] if s["isInitial"]),
    sum(1 for p in v["priorities"] if p["isStatutoryDefault"])))')
chk "a new firm starts with eight and four" "8/4/1/1" "$SEEDED"
chk "an associate may READ the vocabulary"  200 "$(code -b $J/associate.txt $VOCAB)"
chk "…but not change it"                    403 "$(code -b $J/associate.txt -XPOST $VOCAB/states -H "$H" -d '{"code":"x1","name":"X"}')"

STARTID=$(curl -s -b $J/partner.txt $VOCAB | python3 -c '
import sys, json
print(next(s["id"] for s in json.load(sys.stdin)["states"] if s["isInitial"]))')
# The floor a partial unique index cannot enforce: AT MOST one is a constraint,
# at LEAST one is not, and a firm with none could not create a single task.
chk "un-marking the only starting state is refused" 409 \
  "$(code -b $J/partner.txt -XPATCH $VOCAB/states/$STARTID -H "$H" -d '{"isInitial":false}')"
chk "…and so is retiring it"                        409 \
  "$(code -b $J/partner.txt -XPATCH $VOCAB/states/$STARTID -H "$H" -d '{"isActive":false}')"
chk "a state cannot be terminal AND blocked"        400 \
  "$(code -b $J/partner.txt -XPOST $VOCAB/states -H "$H" -d '{"code":"odd","name":"Odd","isTerminal":true,"isBlocked":true}')"
# THE RENAME, which is the whole promise. The behaviour has to survive it, and
# the two checks in the next section are what prove it did.
BLOCKID=$(curl -s -b $J/partner.txt $VOCAB | python3 -c '
import sys, json
print(next(s["id"] for s in json.load(sys.stdin)["states"] if s["isBlocked"]))')
chk "the firm renames Blocked to Stuck"     200 "$(code -b $J/partner.txt -XPATCH $VOCAB/states/$BLOCKID -H "$H" -d '{"name":"Stuck"}')"

echo; echo "── 16b-4. Raising work by hand, blocking it, getting it checked ────"
ADHOC=$(curl -s -b $J/partner.txt -XPOST $WI -H "$H" -d '{"clientPartyId":"'$PID'","title":"Prepare the board minutes"}')
ADHOCID=$(echo "$ADHOC" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "ad hoc work is real work"            "True" "$(echo "$ADHOC" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["jobId"] is None and d["engagementId"] is None)')"
# An associate CAN raise and move work — the role is "does the work", and
# `work:write` is exactly the permission this table is for. The line that
# separates them is the VOCABULARY, two checks above: an associate reads the
# firm's states and cannot change what they MEAN.
chk "an associate may raise work too"     201 "$(code -b $J/associate.txt -XPOST $WI -H "$H" -d '{"clientPartyId":"'$PID'","title":"Chase the bank confirmation"}')"
chk "…and a client contact cannot see any" 403 "$(code -b $J/client.txt $WI)"

# THE CAPTURE-OR-LOSE PAIR, against the RENAMED state. A rule keyed on the code
# would have gone quiet on the rename two checks ago, silently.
chk "moving to Stuck with no reason is refused" 400 \
  "$(code -b $J/partner.txt -XPOST $WI/$ADHOCID/state -H "$H" -d '{"stateId":"'$BLOCKID'"}')"
chk "…and accepted with one"                    200 \
  "$(code -b $J/partner.txt -XPOST $WI/$ADHOCID/state -H "$H" -d '{"stateId":"'$BLOCKID'","blockedReason":"Ramesh has not sent the register"}')"
# The reason stays on the row and NEVER enters the log, which cannot be erased.
LEAKED=$(curl -s -b $J/partner.txt "$API/api/v1/events?limit=40" | python3 -c '
import sys, json
print("Ramesh" in json.dumps(json.load(sys.stdin)["events"]))')
chk "…and the reason is not in the audit log" "False" "$LEAKED"

# Maker != checker, over HTTP. The partner owns the task, so the partner cannot
# be the one who says it is right.
curl -s -o /dev/null -b $J/partner.txt -XPOST $WI/$ADHOCID/assignee -H "$H" -d '{"assigneeUserId":"'$PARTNERID'"}'
REVIEW=$(curl -s -b $J/partner.txt -XPOST $WI/$ADHOCID/review -H "$H" -d '{}')
REVIEWID=$(echo "$REVIEW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "the maker is DERIVED from the assignee" "True" \
  "$(echo "$REVIEW" | python3 -c 'import sys,json;print(json.load(sys.stdin)["submittedBy"] == "'$PARTNERID'")')"
chk "a second review cannot be opened"      409 "$(code -b $J/partner.txt -XPOST $WI/$ADHOCID/review -H "$H" -d '{}')"
chk "THE MAKER CANNOT BE THE CHECKER"       403 \
  "$(code -b $J/partner.txt -XPOST $API/api/v1/work-item-checks/$REVIEWID/decide -H "$H" -d '{"decision":"approved"}')"
chk "a rejection with no note is refused"   400 \
  "$(code -b $J/associate.txt -XPOST $API/api/v1/work-item-checks/$REVIEWID/decide -H "$H" -d '{"decision":"rejected"}')"

echo; echo "── 16c. The prose a document carries — copied, never referenced ────"
# G1.7. Three lists appear on every document besides its priced lines: the
# EXCLUSIONS, the COMMERCIAL notes and the TEAM block. They are not clauses — a
# clause is a term drawn from a versioned library and pinned — they are the
# document's own prose, and a firm edits them a line at a time.
#
# The acceptance has two halves that pull opposite ways: editing the standard
# set must change the NEXT document and never an issued one (so it is a COPY),
# and a UAE document must not print an Indian tax note.
STD=$API/api/v1/document-blocks/standard
chk "the standard set starts empty"     "0" "$(curl -s -b $J/partner.txt $STD | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["blocks"]))')"
chk "an exclusion, true everywhere"     201 "$(code -b $J/partner.txt -XPOST $STD -H "$H" -d '{"kind":"exclusion","body":"Statutory fees are not included.","sortOrder":1}')"
# The one that must not leave India. This is the mistake the firm already caught
# in its own template, so it is the check that matters most in this section.
chk "…and the GST note, scoped to IN"   201 "$(code -b $J/partner.txt -XPOST $STD -H "$H" -d '{"kind":"commercial","body":"All fees are exclusive of GST as applicable.","sortOrder":1,"jurisdiction":"IN"}')"
chk "an associate cannot edit the set"  403 "$(code -b $J/associate.txt -XPOST $STD -H "$H" -d '{"kind":"exclusion","body":"x","sortOrder":9}')"
chk "…but can read what it will print"  200 "$(code -b $J/associate.txt $STD)"

# A letter written for IN gets both lines; one written for AE gets only the one
# that is true everywhere.
BLKEL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$LAWORG'","jurisdiction":"IN","title":"Harbour Ridge - prose","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
INBLK=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$BLKEL | python3 -c '
import sys, json
bs = json.load(sys.stdin)["blocks"]
print("%d/%s" % (len(bs), any("GST" in b["body"] for b in bs)))')
chk "an Indian letter prints the GST note" "2/True" "$INBLK"
AEEL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$LAWORG'","jurisdiction":"AE","title":"Harbour Ridge - UAE","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
AEBLK=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$AEEL | python3 -c '
import sys, json
bs = json.load(sys.stdin)["blocks"]
print("%d/%s" % (len(bs), any("GST" in b["body"] for b in bs)))')
chk "…and a UAE one does NOT"           "1/False" "$AEBLK"

# The COPY, which is the whole argument against a reference: the firm rewrites
# its standard exclusion, and the letter already issued still says what it said.
STDID=$(curl -s -b $J/partner.txt $STD | python3 -c '
import sys, json
print(next(b["id"] for b in json.load(sys.stdin)["blocks"] if b["body"].startswith("Statutory")))')
chk "the firm rewrites its exclusion"   200 "$(code -b $J/partner.txt -XPATCH $STD/$STDID -H "$H" -d '{"body":"Statutory fees, filing fees and stamp duty are not included."}')"
UNCHANGED=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$BLKEL | python3 -c '
import sys, json
print(any(b["body"] == "Statutory fees are not included." for b in json.load(sys.stdin)["blocks"]))')
chk "…the issued letter is untouched"   "True" "$UNCHANGED"
NEXTEL=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/engagement-letters -H "$H" -d '{"partyId":"'$LAWORG'","jurisdiction":"IN","title":"Harbour Ridge - after","currency":"INR","fxRate":"1","fxRateDate":"2026-08-28"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
CHANGED=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$NEXTEL | python3 -c '
import sys, json
print(any("stamp duty" in b["body"] for b in json.load(sys.stdin)["blocks"]))')
chk "…while the NEXT letter carries it" "True" "$CHANGED"

# "Delete the third exclusion" — the sentence this table's shape exists for.
# Against one text column it is a string operation with nothing for a screen to
# attach a control to.
BLKID=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$NEXTEL | python3 -c '
import sys, json
print(next(b["id"] for b in json.load(sys.stdin)["blocks"] if b["kind"] == "exclusion"))')
chk "strike one line off the letter"    204 "$(code -b $J/partner.txt -XDELETE $API/api/v1/document-blocks/$BLKID)"
LEFT=$(curl -s -b $J/partner.txt $API/api/v1/engagement-letters/$NEXTEL | python3 -c '
import sys, json
print(len([b for b in json.load(sys.stdin)["blocks"] if b["kind"] == "exclusion"]))')
chk "…and the others are untouched"     "0" "$LEFT"

echo; echo "── 16d. Invoicing — the one number that may not gap ─────────────────"
# T3.4. A proposal reference may gap: PR-2026-0007 missing means somebody
# abandoned a quote. A TAX INVOICE NUMBER MAY NOT — an auditor is entitled to
# read a missing one as a suppressed sale — so the counter is a row taken under
# SELECT ... FOR UPDATE inside the same transaction as the ISSUE (0322: a draft
# has no number), and a rollback releases the number. That property is proven
# against real Postgres in tests/invoice/numbering.integration.test.ts,
# including six simultaneous issues; what this section walks is the surface and
# the freeze.
INVC=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/parties/organizations -H "$H" -d '{"legalName":"Cobalt Foods Private Limited","jurisdiction":"IN","entityType":"private_limited"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["partyId"])')
INV1=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices -H "$H" -d '{"partyId":"'$INVC'","entityPartyId":"'$FIRMENT'","currency":"INR","fxRate":"1","fxRateDate":"2026-08-29","seriesDate":"2026-08-29"}')
chk "a draft has no number yet (0322)"    "None" "$(python3 -c 'import sys,json;print(json.load(sys.stdin)["number"])' <<< "$INV1")"
INV1ID=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' <<< "$INV1")
chk "an empty invoice cannot be issued"   409 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/issue -H "$H")"
chk "a line goes on"                      204 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/lines -H "$H" -d '{"description":"GST filing, 12 months","quantity":"12","unitAmount":"2000","discountPercent":"10","taxPercent":"18"}')"
# The arithmetic is the schema's, in numeric: 24000 gross, less 10%, plus 18%.
TOT=$(curl -s -b $J/partner.txt $API/api/v1/invoices/$INV1ID | python3 -c '
import sys, json
t = json.load(sys.stdin)["totals"]
print("%s/%s/%s" % (t["net"], t["tax"], t["total"]))')
chk "…and the totals come from the schema" "21600.0000/3888.0000/25488.0000" "$TOT"
chk "…an associate cannot issue it"       403 "$(code -b $J/associate.txt -XPOST $API/api/v1/invoices/$INV1ID/issue -H "$H")"
# 0002: the firm's series already holds the advance invoice raised in 14.
chk "…the partner can, and it is numbered then" "INV/2026-27/0002" "$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/issue -H "$H" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("number"))')"
chk "…and then its lines are fixed"       409 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/lines -H "$H" -d '{"description":"One more thing","quantity":"1","unitAmount":"500"}')"

# Cancelling an ISSUED invoice does not release its number (the row stays in
# the sequence saying so). A DRAFT cancelled before issue never drew one
# (0322), so it leaves no hole at all.
INV2ID=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices -H "$H" -d '{"partyId":"'$INVC'","entityPartyId":"'$FIRMENT'","currency":"INR","fxRate":"1","fxRateDate":"2026-08-29","seriesDate":"2026-08-29"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
chk "a draft cancelled before issue spends no number" "cancelled/None" "$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV2ID/cancel -H "$H" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("%s/%s" % (d.get("status"), d.get("number")))')"
SEQ=$(curl -s -b $J/partner.txt "$API/api/v1/invoices" | python3 -c '
import sys, json
inv = [r["invoice"] for r in json.load(sys.stdin)["invoices"]]
print(sorted(i["sequenceNumber"] for i in inv if i["sequenceNumber"] is not None))')
chk "…the series is 1..N with nothing missing" "[1, 2]" "$SEQ"

# THE FEE AXIS, on the module where it matters most. An invoice is money end to
# end, so a delivery colleague seeing the work but not what it was worth is the
# whole point of the axis — and invoicing shipped without it until the demo
# walk-through caught it, because every test asserts as the partner.
ASSOCTOT=$(curl -s -b $J/associate.txt $API/api/v1/invoices/$INV1ID | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("%s/%s/%s" % (d["totals"]["total"], d["lines"][0]["unitAmount"], d["party"]["displayName"]))')
chk "an associate sees the work, not the money" "None/None/Cobalt Foods Private Limited" "$ASSOCTOT"
PARTNERTOT=$(curl -s -b $J/partner.txt $API/api/v1/invoices/$INV1ID | python3 -c '
import sys, json
print(json.load(sys.stdin)["totals"]["total"])')
chk "…while the partner sees both"            "25488.0000" "$PARTNERTOT"

echo; echo "── 16e. What a client still owes — the balance is a SUM ─────────────"
# T3.5. There is no `paid` flag and no `amount_paid` column: both are caches of
# an addition and both drift the first time a payment is corrected, leaving an
# invoice that says "paid" beside arithmetic that says otherwise. Only one of
# those two is evidence, so only one of them exists.
PAY1=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/payments -H "$H" -d '{"amount":"10000","receivedOn":"2026-08-29","method":"bank_transfer","reference":"UTR-'$S'"}')
chk "a payment is recorded"               "10000" "$(python3 -c 'import sys,json;print(json.load(sys.stdin)["amount"].split(".")[0])' <<< "$PAY1")"
BAL=$(curl -s -b $J/partner.txt $API/api/v1/invoices/$INV1ID/balance | python3 -c '
import sys, json
b = json.load(sys.stdin)
print("%s/%s" % (b["paid"], b["outstanding"]))')
chk "…and the balance is the arithmetic"  "10000.0000/15488.0000" "$BAL"
# A bounced cheque is a NEGATIVE payment: two rows that tell the story, not one
# row edited into something that never happened.
chk "a reversal is a negative payment"    201 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/payments -H "$H" -d '{"amount":"-10000","receivedOn":"2026-08-30","method":"cheque","note":"Returned unpaid"}')"
BACK=$(curl -s -b $J/partner.txt $API/api/v1/invoices/$INV1ID/balance | python3 -c 'import sys,json;print(json.load(sys.stdin)["outstanding"])')
chk "…and it puts the debt back"          "25488.0000" "$BACK"

# A credit note is its OWN document with its OWN consecutive series — not an
# invoice with a minus sign. And the REASON is mandatory: without it the numbers
# always reconcile and why the money came off does not.
CN=$(curl -s -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/credit-notes -H "$H" -d '{"amount":"5488","reason":"service_failure","note":"Filed late, ours"}')
chk "…and it gets its own series"         "CN/2026-27/0001" "$(python3 -c 'import sys,json;print(json.load(sys.stdin)["number"])' <<< "$CN")"
chk "…more than was billed is refused"    409 "$(code -b $J/partner.txt -XPOST $API/api/v1/invoices/$INV1ID/credit-notes -H "$H" -d '{"amount":"999999","reason":"goodwill"}')"
# The collections read model: what is left, and WHOSE it is. The name and the
# number are joined by the API — a screen rendering one row per debt must not
# fetch a party per row, and building that screen is what found this missing.
OWED=$(curl -s -b $J/partner.txt $API/api/v1/receivables | python3 -c '
import sys, json
rs = {r["balance"]["invoiceId"]: r for r in json.load(sys.stdin)["receivables"]}
r = rs.get("'$INV1ID'")
print("absent" if r is None else "%s/%s/%s" % (r["balance"]["outstanding"], r["number"], r["party"]["displayName"]))')
chk "…the receivable names whose it is" "20000.0000/INV/2026-27/0002/Cobalt Foods Private Limited" "$OWED"

echo; echo "── 16f. The compliance calendar — generated, never typed ────────────"
# T3.2. What this section can prove that a unit test cannot: the firm got its
# rules AT PROVISIONING, the gates on them are the ones intended, and — the one
# that matters most — an empty calendar EXPLAINS ITSELF.
#
# EIGHT REQUESTS, and that number was chosen rather than landed on. The walk was
# already at ~288 of a 300/minute budget before this section, and the header
# says the fix is to spend fewer requests here rather than raise the product's
# default. So this covers the seeding, both gates and the coverage answer, and
# nothing that a unit test already covers: the date arithmetic, the March TDS
# exception and the re-run idempotency are all in tests/obligation/.
#
# (That budget was ~296 of 300 here; since S7 the walk paces itself, see the
# note by `curl()` at the top. The limiter's key is still a known-open item.)
RULES=$(curl -s -b $J/partner.txt $API/api/v1/obligation-rules)
# A NEW FIRM IS NEVER LOOKING AT AN EMPTY RULES SCREEN. Fifty-seven rules from
# the firm's own applicability sheet arrive with the tenant — ten that produce
# dates, and forty-seven that say, by name, what they are still waiting for.
#
# "Ten that produce dates" is ten with a FORMULA, counted as the pack counts
# them. It was counted as coverage == "generating", which stopped being true of
# any pack row on 2026-09-18 (they seed unconfirmed) and is doubly untrue since
# T6.16: a rule generates only once the catalogue puts it on a service.
COUNTS=$(python3 -c '
import sys, json
rs = json.load(sys.stdin)["rules"]
dated = [r for r in rs if r["dueRule"] is not None and r["recurrence"] != "event"]
print("%d/%d" % (len(rs), len(dated)))' <<< "$RULES")
chk "a new firm is seeded with the India pack" "57/10" "$COUNTS"
# ON NO SERVICE, so NONE generates (T6.16, decision 1). Read from the same
# response: the budget has no request to spare, and none is needed.
UNUSED=$(python3 -c '
import sys, json
rs = json.load(sys.stdin)["rules"]
print("yes" if all(r["usedIn"] == [] and r["coverage"] != "generating" for r in rs) else "no")' <<< "$RULES")
chk "…and none is on a service, so none generates yet" yes "$UNUSED"
# EVERY ONE OF THEM UNCONFIRMED, India included: the dates came from a previous
# vendor's document, not from a partner ticking them against the statute.
UNCONF=$(python3 -c '
import sys, json
rs = json.load(sys.stdin)["rules"]
print("yes" if all(r["status"] == "unconfirmed" for r in rs) else "no")' <<< "$RULES")
chk "…and every date is marked unconfirmed"  yes "$UNCONF"
# THE FORTY-SEVEN ARE NOT FAILURES. Each carries the firm's own words for what
# is missing, and a rule with no formula and no reason would be indistinguishable
# from an unfinished import.
REASONED=$(python3 -c '
import sys, json
rs = [r for r in json.load(sys.stdin)["rules"] if r["dueRule"] is None]
print("yes" if rs and all(r["unresolvedReason"] for r in rs) else "no")' <<< "$RULES")
chk "…and every rule with no formula says why" yes "$REASONED"
GSTR=$(python3 -c '
import sys, json
r = next(r for r in json.load(sys.stdin)["rules"] if r["name"] == "GSTR-3B")
print("%s/%s/%s" % (r["recurrence"], r["dueRule"]["dueMonthOffset"], r["dueRule"]["dueDayOfMonth"]))' <<< "$RULES")
chk "…GSTR-3B is the 20th of the month after" "monthly/1/20" "$GSTR"

# THE ANSWER TO AN EMPTY CALENDAR, which is the whole reason this endpoint
# exists. This firm has live engagements and no matching rules, so it MUST get a
# reason rather than a blank screen — a firm that cannot tell "nothing is owed"
# from "a rule is missing" cannot tell either from broken software.
COVER=$(curl -s -b $J/partner.txt $API/api/v1/calendar/coverage | python3 -c '
import sys, json
gaps = json.load(sys.stdin)["gaps"]
print("yes" if gaps and all(g["reason"] for g in gaps) else "no")')
chk "an uncovered engagement says WHY"      yes "$COVER"

# The gates. Reading the calendar is `party:read` — what a client owes is
# delivery state and everybody on the team needs it. WRITING a rule is
# `tenant:admin`, a deliberate step up from `work:write`: a wrong due date costs
# the CLIENT a penalty, and confirming one is a partner taking responsibility.
chk "an associate may read the calendar"    200 "$(code -b $J/associate.txt $API/api/v1/calendar)"
chk "…but may not write a compliance rule"  403 "$(code -b $J/associate.txt -XPOST $API/api/v1/obligation-rules -H "$H" -d '{"jurisdiction":"IN","name":"Made up","recurrence":"annual","dueRule":null,"unresolvedReason":"x","rulePack":"x@1"}')"
# And the audience gate, ahead of the role gate: a client contact reaches the
# portal paths and nothing else, so the whole firm's calendar is not one of them.
chk "…and a client contact reaches none of it" 403 "$(code -b $J/client.txt $API/api/v1/calendar)"

echo; echo "── 17. Rate limiting ───────────────────────────────────────────────"
last=""
for i in $(seq 1 12); do last=$(code -XPOST $API/api/v1/auth/login -H "$H" -d '{"email":"nobody@example.com","password":"guess"}'); done
chk "brute force is throttled"  429 "$last"

echo; echo "── 18. CORS — the frontend is a separate origin ────────────────────"
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin' | tr -d '\r' | awk '{print $2}')
chk "allowed origin gets a preflight" "$ORIGIN" "$ACAO"
EVIL=$(curl -s -D - -o /dev/null -X OPTIONS $API/api/v1/auth/login -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci '^access-control-allow-origin' | tr -d '\r')
chk "unlisted origin gets none"        0 "$EVIL"

echo; echo "── 19. The audit trail, as recorded ────────────────────────────────"
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
printf "  %s requests, paced under %s a minute\n\n" "$(wc -l < "$REQLOG" | tr -d ' ')" "$SMOKE_BUDGET"
echo "  Log in to the UI as:  partner-$S@example.com / correct horse battery staple"
echo "                        associate-$S@example.com  (no audit trail)"
echo "                        client-$S@example.com     (blocked from the workspace)"
[ "$bad" -eq 0 ]
