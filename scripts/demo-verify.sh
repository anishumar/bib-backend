#!/usr/bin/env bash
#
# Walk the seeded firm end to end and check it is actually what the seed says.
#
#   npm run demo:verify          # after npm run demo:fresh
#
# ── WHY THIS IS SEPARATE FROM THE SEED ───────────────────────────────────────
#
# The seed checks every WRITE was accepted. That is not the same as checking the
# firm came out right: a write can be accepted and produce nothing — a
# compliance rule that generates no calendar, a ladder that fires on nobody, a
# SPOC arrangement that routes work to the wrong desk. Those are the failures a
# demo finds on a projector.
#
# So this reads the firm back and asserts the FACTS, the deliberate problems
# included. A problem that stops being visible fails here as loudly as one that
# appears: "0 escalations reached nobody" would mean the row a partner most
# needs to see has quietly gone.
#
# ── IT LEAVES THE FIRM EXACTLY AS IT FOUND IT ────────────────────────────────
#
# Every write it makes, it undoes. It raises its OWN task to test the review
# rule rather than spending the one the seed left waiting — the first version
# approved that one, so a second run failed on "0 waiting to be checked" and,
# worse, the demo lost the row that shows the review queue.
#
# ── WHAT IT DOES NOT COVER, AND WHERE THAT LIVES ─────────────────────────────
#
# THE TENANT WALL. Proving one firm cannot read another's needs a second firm,
# and creating one here would leave the demo database holding a stray tenant
# nobody can delete (`bib_app` has no DELETE grant, by design). That is what
# `npm run smoke` is for, on its own throwaway firms. Run smoke before a
# release; run this before a demo.
#
set -euo pipefail

API=${API:-http://localhost:8080}
H='content-type: application/json'
PASSWORD=${BIB_DEMO_PASSWORD:-'10x Global demo 2026'}
DOMAIN=10xglobal.in
TODAY=$(python3 -c 'import datetime;print(datetime.date.today().isoformat())')

J=$(mktemp -d)
trap 'rm -rf "$J"' EXIT

PASS=0
FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
pass() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

login() {
  curl -s -c "$J/$1.txt" -o /dev/null -XPOST "$API/api/v1/auth/login" -H "$H" \
    -d "{\"email\":\"$2\",\"password\":\"$PASSWORD\"}"
}
as()   { curl -s -b "$J/$1.txt" "${@:2}"; }
asp()  { curl -s -b "$J/$1.txt" -XPOST -H "$H" "${@:2}"; }
code() { curl -s -o /dev/null -w '%{http_code}' -b "$J/$1.txt" "${@:2}"; }
pcode() { curl -s -o /dev/null -w '%{http_code}' -b "$J/$1.txt" -XPOST -H "$H" "${@:2}"; }

# Never swallows a failure: a read that cannot answer prints what came back.
# The first version of this walk read three list keys wrong and reported
# "0 escalation notices" at a firm holding 56 of them.
pick() {
  python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except ValueError:
    print("  the API did not return JSON: " + raw[:200], file=sys.stderr); sys.exit(1)
try:
    print(eval(sys.argv[1]))
except Exception as exc:
    print("  could not read " + repr(sys.argv[1]) + ": " + type(exc).__name__ + ": " + str(exc),
          file=sys.stderr)
    print("  body: " + raw[:300], file=sys.stderr)
    sys.exit(1)' "$1"
}

# ASSERT A VALUE, printing BOTH sides when it does not hold. "expected 3, got 0"
# is a bug report; "check failed" is a second debugging session.
is() {
  if [ "$3" = "$2" ]; then pass "$1"; else bad "$1" "expected $2, got ${3:-<read failed>}"; fi
}
# Most of the interesting cases here are REFUSALS, and a refusal that stops
# refusing is the failure nobody notices.
status() {
  if [ "$3" = "$2" ]; then pass "$1 ($3)"; else bad "$1" "expected HTTP $2, got $3"; fi
}
at_least() {
  if [ "${3:-x}" -ge "$2" ] 2>/dev/null; then pass "$1 ($3)"; else bad "$1" "expected at least $2, got ${3:-<read failed>}"; fi
}

# ─────────────────────────────────────────────────────────────────────────────

say "Signing everybody in"
for who in partner:siddharth manager:ravi ananya:ananya farhan:farhan; do
  login "${who%%:*}" "${who##*:}@$DOMAIN"
done
login portal "meera@cobaltfoods.in"

ME=$(as partner "$API/api/v1/auth/me")
ANANYA_ID=$(as ananya "$API/api/v1/auth/me" | pick "d['userId']")
is "the partner's session names its FIRM, not a uuid" "10x Global" "$(pick "d['tenantName']" <<< "$ME")"
is "...and its role"                                  "partner"    "$(pick "d['role']" <<< "$ME")"
is "...and it can see fees"                           "True"       "$(pick "d['commercialVisibility']" <<< "$ME")"
is "an associate cannot see fees"                     "False"      "$(as ananya "$API/api/v1/auth/me" | pick "d['commercialVisibility']")"
# A portal session holds a role and reaches none of the staff surface, so what
# it is TOLD it may do has to be empty — a screen offers only what will work.
is "a portal session is told it may do nothing"       "0"          "$(as portal "$API/api/v1/auth/me" | pick "len(d['permissions'])")"

say "The gates"
status "anonymous is refused the board"        401 "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/work-items")"
status "a portal session is refused the book"  403 "$(code portal "$API/api/v1/clients")"
status "an associate is refused the roster"    403 "$(code ananya "$API/api/v1/tenancy/members")"
status "...and the firm's numbers"             403 "$(code ananya "$API/api/v1/dashboard/overview")"
status "a partner reaches the numbers"         200 "$(code partner "$API/api/v1/dashboard/overview")"
status "...and the roster"                     200 "$(code partner "$API/api/v1/tenancy/members")"

say "The firm, as it was set up"
MEMBERS=$(as partner "$API/api/v1/tenancy/members")
is "five people on the roster"    "5" "$(pick "len(d['members'])" <<< "$MEMBERS")"
# THE FIX THIS SEED FORCED. `/internal/v1/users` could not name an account, so
# a firm's founding partner rendered as an email address everywhere, forever.
is "every one of them has a NAME" "5" "$(pick "sum(1 for m in d['members'] if m['displayName'])" <<< "$MEMBERS")"
is "four are on a grade"          "4" "$(pick "sum(1 for m in d['members'] if m['grade'])" <<< "$MEMBERS")"

STRUCT=$(as partner "$API/api/v1/tenancy/structure")
is "three Depts"              "3"    "$(pick "sum(1 for a in d['axes'] if a['axis']=='dept')" <<< "$STRUCT")"
is "three delivery teams"     "3"    "$(pick "sum(1 for a in d['axes'] if a['axis']=='team')" <<< "$STRUCT")"
is "work is cut by Dept"      "dept" "$(pick "d['workSplitAxis']" <<< "$STRUCT")"
is "five services published"  "5"    "$(as partner "$API/api/v1/config/service" | pick "len(d['entries'])")"
is "four processes published" "4"    "$(as partner "$API/api/v1/config/workflow_template" | pick "len(d['entries'])")"

say "Who owns whom"
party() { as partner "$API/api/v1/parties" | pick "next(p['id'] for p in d['parties'] if p['displayName'].startswith('$1'))"; }
COBALT=$(party "Cobalt Foods")
LAKEVIEW=$(party "Lakeview")

TEAM=$(as partner "$API/api/v1/parties/$COBALT/assignments")
is "Cobalt has one Key Manager"        "1" "$(pick "sum(1 for a in d['inForce'] if a['role']=='key_manager')" <<< "$TEAM")"
is "...and three SPOCs"                "3" "$(pick "sum(1 for a in d['inForce'] if a['role']=='spoc')" <<< "$TEAM")"
# A READ MODEL CARRIES NAMES, and this product has been caught six times.
is "...and every one names its holder" "0" \
   "$(pick "sum(1 for a in d['inForce'] if not a['holderName'] and not a['holderEmail'])" <<< "$TEAM")"
# ONE ON EVERY DEPT THIS CLIENT BUYS UNDER. The shipped compliance rules name no
# service — a vendor pack cannot know a firm's catalogue keys — so a filing they
# raise inherits the Dept of whichever of the entity's engagements it attached
# to. Leaving RAA empty therefore put "no SPOC is recorded for Risk, Assurance &
# Advisory" on seventeen GST and payroll cards. Found by looking at the board.
is "...one of them on RAA"             "1" \
   "$(pick "sum(1 for a in d['inForce'] if a['axis'] and a['axis']['code']=='RAA')" <<< "$TEAM")"
is "Lakeview has TWO SPOCs on TRC (deliberate)" "2" \
   "$(as partner "$API/api/v1/parties/$LAKEVIEW/assignments" | pick "sum(1 for a in d['inForce'] if a['axis'] and a['axis']['code']=='TRC')")"

say "The compliance calendar - generated, never typed"
RULES=$(as partner "$API/api/v1/obligation-rules")
at_least "compliance rules on file"  57  "$(pick "len(d['rules'])" <<< "$RULES")"
at_least "...waiting on a fact"      40  "$(pick "sum(1 for r in d['rules'] if r.get('unresolvedReason'))" <<< "$RULES")"
is "...four confirmed by the partner" "4" "$(pick "sum(1 for r in d['rules'] if r['status']=='confirmed')" <<< "$RULES")"

CAL=$(as partner "$API/api/v1/calendar")
at_least "filings generated"       100 "$(pick "len(d['rows'])" <<< "$CAL")"
# PER ENTITY, never per client. G0.1: a group of two companies files two sets of
# returns, and a calendar showing one is the bug that rule exists to stop.
at_least "...for Cobalt Foods"     10  "$(pick "sum(1 for r in d['rows'] if r['entityName'].startswith('Cobalt Foods'))" <<< "$CAL")"
at_least "...and Cobalt Logistics" 10  "$(pick "sum(1 for r in d['rows'] if r['entityName'].startswith('Cobalt Logistics'))" <<< "$CAL")"
# Every shipped date came from a vendor's document, not from the firm. A row
# that does not say so makes a plausible wrong deadline look checked.
is "every row says whether its rule is confirmed" "0" \
   "$(pick "sum(1 for r in d['rows'] if 'ruleUnconfirmed' not in r)" <<< "$CAL")"
is "...and the two the partner confirmed are marked so" "0" \
   "$(pick "sum(1 for r in d['rows'] if r['rulePack']=='firm@2026' and r['ruleUnconfirmed'])" <<< "$CAL")"

# AN EMPTY CALENDAR HAS THREE MEANINGS and only one is anybody's to fix, so a
# gap must carry a reason. This is the point of the coverage tab.
GAPS=$(as partner "$API/api/v1/calendar/coverage")
at_least "engagements the calendar could not cover" 1 "$(pick "len(d['gaps'])" <<< "$GAPS")"
is "...every one of them says WHY" "0" "$(pick "sum(1 for g in d['gaps'] if not g.get('reason'))" <<< "$GAPS")"

say "The board"
BOARD=$(as partner "$API/api/v1/work-items")
at_least "work items in hand"                15 "$(pick "len(d['items'])" <<< "$BOARD")"
at_least "...raised from the calendar at T-X" 10 "$(pick "sum(1 for i in d['items'] if i['isStatutoryDue'])" <<< "$BOARD")"
at_least "...late"                            2 "$(pick "sum(1 for i in d['items'] if i['dueOn'] and i['dueOn'] < '$TODAY')" <<< "$BOARD")"
at_least "...on nobody's desk"                1 "$(pick "sum(1 for i in d['items'] if i['assignee'] is None)" <<< "$BOARD")"
# THE SENTENCE IS THE FEATURE. Without it "two SPOCs, pick one" and "nobody has
# got to it" look identical, and only one of them is somebody's to fix.
is "...and every unassigned one says WHY"     "0" \
   "$(pick "sum(1 for i in d['items'] if i['assignee'] is None and not i['assignmentNote'])" <<< "$BOARD")"
at_least "blocked work carries a written reason" 1 \
   "$(pick "sum(1 for i in d['items'] if i['state']['isBlocked'] and i['blockedReason'])" <<< "$BOARD")"
is "finished work is off the board by default" "0" \
   "$(pick "sum(1 for i in d['items'] if i['state']['isTerminal'])" <<< "$BOARD")"
at_least "...and back when asked for"         1 \
   "$(as partner "$API/api/v1/work-items?includeDone=true" | pick "sum(1 for i in d['items'] if i['state']['isTerminal'])")"
# G0.1 ON THE BOARD: a card naming only the billing client is four identical
# cards for a group of four companies.
is "every card names the company the work is FOR" "0" \
   "$(pick "sum(1 for i in d['items'] if not i['entityName'] and not i['clientName'])" <<< "$BOARD")"

say "The escalation ladder"
ESC=$(as partner "$API/api/v1/escalations")
is "the firm has published a ladder"          "True" "$(pick "d['ladderPublished']" <<< "$ESC")"
at_least "notices raised"                     10 "$(pick "len(d['rows'])" <<< "$ESC")"
# NOT RESOLVED TO A PERSON, deliberately: an escalation routed to one partner
# dies while that partner is on leave.
at_least "...addressed to a RANK, not a desk" 1 "$(pick "sum(1 for e in d['rows'] if e['target']=='grade_at_least')" <<< "$ESC")"
# THE ROW A PARTNER MOST NEEDS. A rung fired and reached nobody — no manager is
# recorded above the holder. 0 here means the problem corner has gone.
at_least "...that reached NOBODY (deliberate)" 1 \
   "$(pick "sum(1 for e in d['rows'] if e['raisedTo'] is None and e['target']!='grade_at_least')" <<< "$ESC")"
is "every notice names the work it is about"  "0" "$(pick "sum(1 for e in d['rows'] if not e['subjectTitle'])" <<< "$ESC")"
# `raisedToName` was null-collapsed once already: "told somebody we hold no name
# for" rendered identically to "told nobody".
is "...and one sent to a person names them"   "0" \
   "$(pick "sum(1 for e in d['rows'] if e['raisedTo'] and not (e['raisedTo'].get('displayName') or e['raisedTo'].get('email')))" <<< "$ESC")"
# 403, not 404: a route absent from ROUTE_PERMISSIONS is denied by default. What
# is asserted is that no such route EXISTS — a control that emptied this queue
# without anything happening would make it decoration.
is "...and there is no way to dismiss one"    "403" "$(pcode partner "$API/api/v1/escalations/x/dismiss")"

say "The engine"
JOBS=$(as partner "$API/api/v1/jobs")
at_least "jobs the engine is walking"       4 "$(pick "len(d['jobs'])" <<< "$JOBS")"
is "every job names its client and company" "0" \
   "$(pick "sum(1 for j in d['jobs'] if not j['clientName'] or not j['entityName'])" <<< "$JOBS")"

say "Who may check whose work"
at_least "work the seed left waiting to be checked" 1 \
   "$(pick "sum(1 for i in d['items'] if i['hasOpenReview'])" <<< "$BOARD")"

# THE WALK RAISES ITS OWN and does not spend the seeded one — see the header.
P_ANY=$(as partner "$API/api/v1/work-vocabulary" | pick "d['priorities'][0]['id']")
TMP=$(asp partner "$API/api/v1/work-items" \
  -d "{\"clientPartyId\":\"$COBALT\",\"entityPartyId\":\"$COBALT\",\"title\":\"Verification walk - raised and cancelled by demo:verify\",\"priorityId\":\"$P_ANY\",\"assigneeUserId\":\"$ANANYA_ID\"}" \
  | pick "d['id']")
asp ananya "$API/api/v1/work-items/$TMP/review" -d '{}' > /dev/null
APPROVAL=$(as partner "$API/api/v1/work-item-checks" | pick "next(c['id'] for c in d['checks'] if c['workItemId']=='$TMP')")

# MAKER != CHECKER IS NOT A SETTING. Ananya submitted it, so Ananya may not
# approve it — a database constraint refuses it, not only the service.
status "the maker may not check her own work" 403 \
   "$(pcode ananya "$API/api/v1/work-item-checks/$APPROVAL/decide" -d '{"decision":"approved"}')"
status "a manager may"                        200 \
   "$(pcode manager "$API/api/v1/work-item-checks/$APPROVAL/decide" -d '{"decision":"approved","notes":"Checked by the verification walk."}')"

S_CANCELLED=$(as partner "$API/api/v1/work-vocabulary" \
  | pick "next(s['id'] for s in d['states'] if s['isTerminal'] and not s['isSuccess'])")
pcode partner "$API/api/v1/work-items/$TMP/state" -d "{\"stateId\":\"$S_CANCELLED\"}" > /dev/null
pass "...and the walk cancels its own task, so the board is unchanged"

say "The refusals"
VOCAB=$(as partner "$API/api/v1/work-vocabulary")
S_BLOCKED=$(pick "next(s['id'] for s in d['states'] if s['isBlocked'])" <<< "$VOCAB")
ANY=$(pick "next(i['id'] for i in d['items'] if not i['state']['isBlocked'] and not i['state']['isTerminal'])" <<< "$BOARD")
WAS=$(pick "next(i['state']['id'] for i in d['items'] if i['id']=='$ANY')" <<< "$BOARD")

# A BLOCKED STATE OWES A REASON — the service refuses it and so does a trigger,
# so a script or an import cannot walk past it either.
status "moving work to a blocked state with no reason" 400 \
   "$(pcode partner "$API/api/v1/work-items/$ANY/state" -d "{\"stateId\":\"$S_BLOCKED\"}")"
status "...and with one"                               200 \
   "$(pcode partner "$API/api/v1/work-items/$ANY/state" -d "{\"stateId\":\"$S_BLOCKED\",\"blockedReason\":\"Verification walk - moved back immediately.\"}")"
pcode partner "$API/api/v1/work-items/$ANY/state" -d "{\"stateId\":\"$WAS\"}" > /dev/null
pass "...and put back where it was"

# A LEAD IS A PARTY. A duplicate capture APPENDS rather than competing: the PAN
# resolves onto the party that already holds it.
BEFORE=$(as partner "$API/api/v1/parties" | pick "len(d['parties'])")
asp partner "$API/api/v1/leads" \
  -d '{"source":"referral","title":"Verification walk - duplicate capture","kind":"organization","name":"Cobalt Foods Pvt Ltd","jurisdiction":"IN","identifiers":[{"type":"pan","value":"AAACC1234F"}]}' > /dev/null
AFTER=$(as partner "$API/api/v1/parties" | pick "len(d['parties'])")
is "a lead carrying a known PAN makes NO second party" "$BEFORE" "$AFTER"

# THE FEE AXIS REDACTS, it does not omit. An associate sees the work and nulls
# where the money is — never a refusal, which reads as "there is no fee".
PROP=$(as partner "$API/api/v1/proposals" | pick "d['proposals'][0]['proposal']['id']")
status "an associate may READ a proposal" 200 "$(code ananya "$API/api/v1/proposals/$PROP")"
is "...with the money removed"            "True" \
   "$(as ananya "$API/api/v1/proposals/$PROP" | pick "all(l.get('unitAmount') is None for l in d.get('lines', []))")"
is "...and the partner sees it"           "True" \
   "$(as partner "$API/api/v1/proposals/$PROP" | pick "any(l.get('unitAmount') is not None for l in d.get('lines', []))")"

say "The money"
INV=$(as partner "$API/api/v1/invoices")
is "three invoices"                             "3" "$(pick "len(d['invoices'])" <<< "$INV")"
at_least "...one cancelled, keeping its number" 1 \
   "$(pick "sum(1 for i in d['invoices'] if i['invoice']['status']=='cancelled')" <<< "$INV")"
# CONSECUTIVE WITH NOTHING MISSING — the cancelled one included, which is
# exactly what shows an auditor where a number went.
is "...and the series has no gap"               "True" \
   "$(pick "sorted(i['invoice']['sequenceNumber'] for i in d['invoices']) == list(range(1, 1+len(d['invoices'])))" <<< "$INV")"
DUN=$(as partner "$API/api/v1/dunning/pending")
at_least "a dunning decision waiting on a partner" 1 "$(pick "len(d['actions'])" <<< "$DUN")"
# A queue of uuids asks somebody to approve something they cannot see.
# The client arrives as a joined PARTY REF, not a flat `clientName` — the same
# `{id, displayName}` shape every other read model here uses. What is being
# asserted is that a partner approving a credit hold can see whose it is, which
# invoice, and how much, rather than a row of uuids.
is "...naming the client, the invoice and the balance" "0" \
   "$(pick "sum(1 for a in d['actions'] if not a['party']['displayName'] or not a['invoiceNumber'] or not a['outstanding'])" <<< "$DUN")"
# The two rungs a machine may reach and may NOT apply.
is "...and it is a terminal rung"               "True" \
   "$(pick "all(a['action']['action'] in ('credit_hold','legal') for a in d['actions'])" <<< "$DUN")"

say "The audit trail"
TRAIL=$(as partner "$API/api/v1/events")
at_least "events recorded"          20 "$(pick "len(d['events'])" <<< "$TRAIL")"
# The actor's NAME is a read-time join and `null` is a real answer — the system
# and the platform have no account. What must never happen is a HUMAN actor id
# with no way to resolve it.
is "no human actor is unresolvable" "0" \
   "$(pick "sum(1 for e in d['events'] if e['event']['actorType']=='human' and e['event'].get('actorId') and e['actor'] is None)" <<< "$TRAIL")"

# ─────────────────────────────────────────────────────────────────────────────

printf '\n───────────────────────────────────────────────────────────────\n'
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m%s checks passed.\033[0m 10x Global is ready to demo.\n' "$PASS"
  printf '───────────────────────────────────────────────────────────────\n\n'
else
  printf '  \033[31m%s FAILED\033[0m, %s passed.\n' "$FAIL" "$PASS"
  printf '───────────────────────────────────────────────────────────────\n\n'
  exit 1
fi
