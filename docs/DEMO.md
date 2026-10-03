# Demo runbook — 10x Global

A live walk through everything built, in the order the business actually happens:
**the firm exists → people join → it says what it sells → a prospect arrives → a
quote → an agreement → the work → the bill → the money → the chase.**

Every step below is real. Nothing is mocked, no screen is a picture, and each
one writes to Postgres and to an append-only audit log you can open at the end.

---

## Before the meeting (2 minutes)

Three terminals, in this order.

```bash
# 1 — the API
cd bib-backend && nvm use && npm run dev          # :8080

# 2 — the app
cd bib-frontend && nvm use && npm run dev         # :3000

# 3 — a fresh firm, with a worked example already in it
cd bib-backend && npm run demo:fresh

# 4 — and check it actually came out right
cd bib-backend && npm run demo:verify
```

`demo:fresh` DESTROYS the local database volume and rebuilds it: it drops the
Postgres volume, re-migrates, and seeds 10x Global from nothing. That is what
lets the logins be FIXED addresses — `siddharth@10xglobal.in`, not
`siddharth-1788079646@10xglobal.example`, which is not something anybody wants
to read off a terminal while a client watches. `npm run demo` on its own seeds
without wiping, and REFUSES if the firm is already there rather than quietly
making a second one: two firms holding those addresses turns every sign-in into
"Choose a firm".

`demo:verify` reads the firm back and asserts 73 facts about it — the account
teams, the calendar, the ladder, every refusal, and every one of the deliberate
problems. **A write being accepted is not the same as the firm coming out
right**, which is why it is a second command: a rule can be valid and generate
nothing, a ladder can be published and fire on nobody. It leaves the firm
exactly as it found it, so run it as often as you like.

The seed prints five logins and, at the end, the list of things that are
deliberately broken and worth showing.

> **Node 22 is required.** `nvm use` reads `.nvmrc`. On Node 20 the queue library
> installs as an empty folder and the API will not start.
>
> **Do not run `npm run smoke` immediately before the seed.** They share one
> rate-limit budget (300 requests a minute from one address) and the seed spends
> about 120. If you do, the seed stops and tells you to wait 60 seconds.

**Logins** — fixed addresses, one password for all five, printed by the seed:

| Who | Address | Why they are in the demo |
|---|---|---|
| **Siddharth Rao** — partner | `siddharth@10xglobal.in` | Does everything. Start here. |
| **Ravi Iyer** — manager | `ravi@10xglobal.in` | Owns the UK desk, and checks Ananya's work. |
| **Ananya Nair** — associate | `ananya@10xglobal.in` | **No fee visibility** — the money disappears for her. |
| **Farhan Qureshi** — associate | `farhan@10xglobal.in` | **Reports to nobody** — his escalations reach nobody. |
| **Meera Menon** — client contact | `meera@cobaltfoods.in` | A *client* login. Signs in at `/portal` — her own app, four tabs, and nothing of the firm's. Proves the wall. |

### The problem corner — deliberate, and the sharpest part of the demo

Everything else in the firm is healthy. These five are not, and each is a state
this product exists to make visible rather than hide:

| What | What it shows |
|---|---|
| Harbour Provisions has no SPOC on any Dept | Work lands **unassigned with the reason**, never on a guessed desk |
| Lakeview has **two** SPOCs on TRC | The router refuses to choose, and says so |
| Farhan reports to nobody | An escalation that **reached nobody** — the row a partner has to act on |
| Harbour is not registered as a legal entity | Its calendar is empty, and `/calendar` → *Not covered* says why |
| 53 of the 57 shipped rules have no formula | The partner's real job: answering them. Four are answered already. |
| One invoice is 75 days overdue | A **credit hold waiting on a partner** — the rung a machine may reach and may not apply |

> One caution: sign-ins are rate limited. If you log in and out repeatedly and
> get refused, wait a minute — that is the product defending itself, and it is
> worth saying out loud rather than apologising for.

---

## The journey

### 1 · A firm gets created — before anybody can log in

Say this rather than show it, because it happens on a service-to-service API no
browser can reach:

> "Creating a firm is not something a user does. It is a provisioning call
> behind its own key, and the key that can set somebody's password is
> deliberately not the key that can create firms — otherwise one leaked
> credential becomes 'create a user, make them partner, set their password, log
> in as them'."

**Worth landing:** the firm had to state its **reporting currency** at creation
and nothing can change it later. Every exchange rate the system ever stores is
struck against it, so changing it would not restate history — it would silently
invalidate it.

### 2 · Sign in → the workspace  ·  `http://localhost:3000`

Log in as **Siddharth**.

- The session is an **httpOnly cookie**. No token in local storage, nothing a
  script on the page can read.
- The home screen lists only what this person may actually do. That is not the
  browser hiding buttons — the API tells the session which permissions it holds,
  and every one is checked again server-side.

### 3 · Who works here  ·  **Administration → People**

Four people. Point at **Ananya** and note she has no commercial visibility.

Then **Roles**: these are the *firm's own* roles, stored as published versions —
not a list we shipped. Add a permission to a role and it takes effect on the
next request.

Then **Grades**: the firm's ladder, Analyst → Partner. A grade grants **nothing**
— it exists for one comparison, "Manager or above may sign this off". Roles say
what you may *reach*; grades say how *senior* you are. Retiring a rung never
deletes it, because a rung somebody held is part of why they could approve
something in 2026.

### 4 · What the firm sells  ·  **Catalogue**

Four services, each with its code, its department, its SLA and its list price.

**The point to make:** publishing a version **freezes** it. Notice there is no
Edit — only "new version". That is what lets a quote from nine months ago still
resolve to the price that was live when it was sent.

### 5 · The rules documents are written from  ·  **Administration → Standard prose**

Exclusions, commercial notes, the team block.

Point at **"All fees are exclusive of GST as applicable" — scoped to IN.**

> "This is a real mistake this firm caught in its own template: that sentence on
> a UAE proposal is wrong. So it is a rule, not a habit."

**And the load-bearing bit:** these are **copied** onto each document, never
referenced. Editing this page changes the *next* letter and nothing already
issued — otherwise fixing a typo would silently rewrite what a signed agreement
says the firm excluded.

### 6 · Whose desk gets the work  ·  **Administration → Territories**

`GB → Ravi`. Everywhere else falls through to the rotation, which gives a lead
to whoever is holding the fewest. There is deliberately **no catch-all row**: the
rotation is a better fallback than a row somebody has to remember to maintain.

### 7 · The book  ·  **Clients**

Open **Cobalt Foods**. Identifiers (PAN, a Karnataka GSTIN), the registration,
and **Priya Menon — director since 2019**.

> "Relationships are effective-dated, so 'who was a director on 31 March' is a
> question this answers — which is the question that actually gets asked."

### 8 · A prospect arrives  ·  **Pipeline**

Two leads. The referral was **deduplicated onto Lakeview by PAN** — capture
resolves the party *before* creating anything, so the same prospect reached twice
does not become two clients.

The UK lead went to **Ravi** — that is the territory rule beating the rotation.
Open the audit trail later and it says *which rule chose*, not just who got it.

**Do live:** capture a lead with the same PAN as Lakeview. It merges instead of
duplicating.

### 9 · The quote  ·  **Proposals**

Open the Cobalt proposal.

- Every line is **pinned** to the catalogue version it was quoted from. It shows
  the list price *as it was then* beside what was actually charged.
- **Do live:** add a line with a 40% discount and try to send. It is **refused** —
  the firm's limit is 15%, and going past it needs a partner's approval. That
  limit is a config row the firm owns, not a number in our code.

### 10 · The agreement  ·  **Engagement letters**

Open the Cobalt letter. This is the densest screen in the product.

- Its **number**, the **entity issuing it**, who it is **addressed to**.
- Its **terms** — each clause pinned, with **governing law and courts** shown.
- Its **exclusions, notes and team** — the prose copied at drafting.
- Signed by **Priya Menon, Director** — and the screen now offers no edits.

**Three things to say here, and they are the heart of the product:**

1. **A signed letter cannot be edited — the database refuses, not the app.** A
   change is a *new letter*. The old one stays readable as what was actually
   agreed, because "what did they sign" is a question a court asks.
2. **The governing law is checked against the entity issuing the letter.** On the
   real project, a letter issued by the firm's US company named *Indian* law and
   *Delhi* courts, and a human review let it through. Now it is refused.
3. **Signing created the work.** Scroll to the engagements — one per line,
   fanned out in the same transaction as the signature. A signature with no
   engagements would be a client committed to work nobody scheduled.

### 11 · The engine picked it up (say it, then prove it in the audit log)

> "Nothing called the delivery engine. It read the audit log, saw a contract go
> active, and created the jobs — so the commercial side does not know an engine
> exists. That is what lets the two halves be built by two people."

Two delivery jobs now exist for the two engagements. Every trigger is
at-least-once and the job id is derived from its cause, so a retry or a crash
**cannot** produce a second set of tasks for staff — and eventually a second
invoice.

### 12 · The bill  ·  **Invoices**

Three invoices — and **`0002` is cancelled, sitting in the middle of the series,
still carrying its number.** That is the whole point:

> "A quote reference may have gaps — somebody abandoned a draft. **An invoice
> number may not.** Under GST the series must be consecutive, and an auditor who
> finds one missing is entitled to read it as a suppressed sale. So a cancelled
> invoice keeps its number and stays in the sequence saying it was cancelled."

Open the part-paid invoice:
- lines with **per-line tax** (18% on fees, 0% on a recharge — on one document),
- **Invoiced / Paid / Credited / Outstanding**, every figure computed by the
  database. There is no "paid" badge anywhere, because a badge is a cache of a
  sum and it drifts the first time a payment is corrected.

**Do live:** record a payment. Watch outstanding move.

Mention: a bounced cheque is a **negative payment** beside the original, never an
edit of it. And a credit note asks **why** from a fixed list — without that, the
numbers always reconcile and *why* ₹40,000 came off does not.

### 13 · The chase  ·  **Receivables**

The invoice (`0001`, issued first so the series runs in date order) 75 days overdue has climbed the ladder on its own: reminders at D+3
and D+7, a call at D+15 — and then it **stopped**.

> "The worker may chase a client. Only a person may put one on **credit hold**.
> So it climbed to that rung, and it is sitting on the partner's desk."

The queue shows **the client, the invoice number, and what is outstanding now** —
because approving a credit hold against a uuid is not a decision anybody can make.

**Do live:** reject it with a reason. Rejecting is recorded as loudly as
approving — "we considered it and chose not to" is a fact somebody wants three
months later.

### 14 · Who may see what — the two walls

**Log out. Log in as Ananya (associate).**
- Proposals, letters and **invoices** still open — she does the work, and she can
  see that Cobalt Foods was billed for it.
- **Every figure is gone**, replaced by dashes — the totals, the unit amounts,
  the discount, what is outstanding. She is not refused the record; she is shown
  it without the money. "You may not see this" and "there is nothing here" are
  different answers, and a firm that refused the record would have delivery staff
  unable to see their own work.
- The **line quantities and the tax rate survive**, deliberately: how much work
  was done is the work, and a statutory rate is a fact about the service rather
  than a price.

**Log out. Log in as Cobalt finance (client contact).**
- She is **refused the workspace entirely**. Same product, same login page, and
  a client cannot reach a single staff screen — this is a B2B2C product where the
  firm's clients log in too, so that wall is denied-by-default.

### 15 · Everything that happened  ·  **Audit**

Every step of the last twenty minutes, in order, each naming **who** did it —
human, agent or system.

Two things to close on:
- **Append-only, enforced by the database.** Not "we don't delete" — the app
  cannot update or delete a row here, and neither can a database session.
- **Personal data is deliberately absent from the log.** The name you see is
  joined at read time from the account. That is what lets a person be erased
  while the record of what happened survives.

---

## If something goes wrong

| Symptom | What it is | Fix |
|---|---|---|
| Sign-in refused | Rate limit — too many logins in a minute | Wait 60 seconds |
| Blank screens, everything 401 | API restarted; session gone | Sign in again |
| `Cannot find module 'pg-boss'` | Running Node 20 | `nvm use` then `npm install` |
| Demo data looks wrong | — | Re-run `./scripts/demo-seed.sh` for a clean firm |
| A screen shows an error in red | That is the API's own message, verbatim | Read it aloud — they are written to be acted on |

## What is deliberately NOT built yet — say it before they ask

- **NOTHING LEAVES THE BUILDING.** There is no email, no WhatsApp and no SMS in this
  product (P10, Phase 7). So the chaser RAISES a reminder and the client's own action
  centre shows it; the nudge raises one and their filings list shows it; the "monthly
  digest" is a page they open rather than something that arrives, and `/portal/month`
  says so on the page. Say this before somebody asks why their inbox is empty — every
  one of those is a real record with a real reader, and none of them is a message.
- **No virus scanner, no OCR, no auto-filing.** A client-supplied file is stored
  exactly as it arrives, the firm's own screen says *"not scanned"* beside it, and
  `content-disposition: attachment` is the one protection that does exist. There is no
  scanner in this product and a `scan()` returning "clean" would be a lie with a
  function signature.
- **No way to PAY from the portal.** A client sees what they were billed and what is
  still outstanding; payments are P11 and nothing in this product takes money.
- **The AI agents** are designed and not built. The runtime seam they plug into
  exists, which is why they are a phase and not a rewrite.
- **Real integrations** (GST portal, MCA, banking) are externally gated on
  credentials. Every connector is built as a port with a working fake first, so
  the product is demoable and testable without them.
