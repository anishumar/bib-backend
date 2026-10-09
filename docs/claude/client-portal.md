# Client portal

What a CLIENT_PORTAL login can read and do: status home (T6.5), asks (T6.6), library and invoices
(T6.7), the client's own requests (T6.8/T6.9), and group grants (Q064). Gate 4 and the grant
table are in `tenancy-and-rls.md`; the chaser and nudge readers are in `escalation-chaser-nudge.md`.

## The client portal — the first read for somebody outside the firm (T6.5)

`usecase/portalhome` + `GET /api/v1/portal/home` + migration 0062.

- **A portal read is three things; missing any one is a hole.** An entry in `PORTAL_PATHS` (gate
  2, denied by default), an entry in `NO_PERMISSION_REQUIRED` or `ROUTE_PERMISSIONS` (gate 3,
  denied by default), and the query through **`withPortal`, never `withTenant`**, with its own
  RESTRICTIVE policy on every table it reads. `withPortal(` is called by four adapters today:
  `portal-home`, `portal-ask`, `portal-library` and `portal-request` repositories. A fifth needs an
  argument.
- **Gate 2 matches `{param}` templates since T6.6** (its own commit). It was an exact
  `PORTAL_PATHS.has(c.req.path)`, which made any portal route with a path parameter unreachable
  (why the status home is one parameter-less aggregate). `compilePortalPaths` compiles the list the
  way `decideRoute` compiles `ROUTE_PERMISSIONS`.
  - **Contained by a test, not care:** `auth-coverage.test.ts` asserts over EVERY registered route
    that `isPortalPath(concrete(path))` equals membership of that route's TEMPLATE in the list; a
    pattern swallowing a staff route goes red and names it. `asTemplate()` is required: Hono
    registers `:name`, both permission tables are keyed `{name}`.
- **The queries look like queries that forgot to filter, on purpose.** No WHERE names
  `client_party_id`, `entity_party_id` or `is_client_visible`: the wall is under the query.
  Repeating the filter would disarm the negative control in
  `tests/portal/portal-reads.integration.test.ts` (drops a policy, expects a leak; each assertion
  watched go red).
- **A grant names a party; each table names its own column.** `delivery.work_item` scopes on
  `client_party_id`, `delivery.obligation_instance` on `entity_party_id` ("the ENTITY, never the
  client", 0053). So a contact granted Cobalt Foods sees Foods' filings, NOT its subsidiary's, but
  does see the subsidiary's TASK (that row names Foods as client). Reaching the subsidiary's filings
  would need the nullable `crm.engagement` join 0059 refused. **Decided (Shrestha, 2026-09-01):
  strict, no join**; a contact who should see both gets two grants.
- **`is_client_visible` is a SECOND restrictive policy (0062)**, not a query filter: a portal read
  that forgets it returns an internal note with a 200. It had a writer and no reader from 0051
  (rule in CLAUDE.md). `/work-items/[workItemId]` has the switch that sets it.
- **Name tables are not scoped by what they name.** The read joins `core.party`,
  `work_item_state`, `obligation_state`, `obligation_template` for NAMES with no policy;
  `crm.portal_sees(id)` on `core.party` would blank the entity on an allowed row. Gate 2 contains
  them. **A portal route whose SUBJECT is one of those tables needs its own policy migration first.**
- **No due date the product invented reaches a client.** `statutoryDueOn` travels only where
  `is_statutory_due` is set; otherwise the day the work OPENED. `internal_target_on` (T-X, the
  firm's margin) is not on the response at all. The firm has never given turnaround times (client
  ask 3.4).
- **"Held up" is not "waiting on you".** `work_item_state.is_blocked` + `blocked_reason` can mean
  "client has not sent the register" or "GST portal is down", so the section shows the reason
  **verbatim** under a line saying whose words they are. T6.6's ask is the row that says "waiting
  on you"; both stay (different facts, possibly at once).
- **Recently filed is keyed on `filed_on`, never on a terminal state** (`resolved` is T3.3's end
  of a MISSED deadline; see `compliance-calendar.md`).
- **The status home needs no permission.** Being invited and granted a company (`crm.portal_access`,
  with granter, date, event) IS the authorisation to read its status. What a contact may DO needs a
  role that declares its audience (built in T6.6, below).
- **A STAFF session is refused, not answered empty** (it holds no grants; an empty page would read
  "this client has nothing going on").

### What running it found

- **`date + $n` is ambiguous** to Postgres (postgres.js sends params untyped): `${asOf}::date +
  ${90}` 500'd on the first real request; `::int` on the window fixed it (rule in CLAUDE.md).
- **The page said everything twice**: the calendar raises a task per obligation, so a filing
  appeared as filing AND task. The work query excludes a task whose obligation is on the same page;
  an obligation for an ungranted company is invisible to the subquery under RLS, so its task stays
  (the only trace the client can see).
- **"Filings coming up" lied**: the top rows were past their statutory date and Missed.
- **The demo put an internal decision on the client's page** ("Decide the credit hold on
  INV/2026-27/0003") because `is_client_visible` defaulted TRUE and the seed never set it false.

## The client-directed ask — the first thing a client can DO (T6.6)

`delivery.client_ask` + `client_ask_response` (0063), `usecase/clientask`, two adapters. An ask is
raised deliberately, addressed to one client, with somewhere to answer; `blocked_reason` is the
firm's note to itself and gets no answer box.

- **It lives in `delivery` and hangs off a work item.** `work_item_id` NOT NULL, and
  `client_party_id` (gate 4's column) is held to the work item's by a COMPOSITE FK over
  `(work_item_id, client_party_id, tenant_id)`: the denormalised wall column cannot disagree.
  Nothing on either surface accepts a client party; it is read from the work item inside the
  INSERT. A `(subject_kind, subject_ref)` pair was rejected: it can carry no FK.
- **`answered` is not `closed`.** The client answering makes it answered; the FIRM decides whether
  it was what it needed (else the client sees "done" for last quarter's register). `withdrawn` is
  separate from `closed` ("you sent it" vs "never mind").
- **No due date anywhere**, and its absence is the API's statement. `raised_at` is on the row
  (all T4.4's chaser needs). **Raising an ask does not block the task** (that would be the
  product's opinion, not the firm's).
- **Responses are append-only by GRANT** (like `files.document_version` and `ledger`): an answer
  is evidence. `first_answered_at = coalesce(first_answered_at, now())`, so a later response never
  restates the first reply time.
- **A client's approval is NOT `work_item_approval`.** That and `step_approval` are the firm's
  maker-checker (T2.9, `work:write`, checker != maker); a client approving is an INSTRUCTION.

### The write side of gate 4, exercised for the first time

- `PostgresPortalAskRepository` was the first adapter to WRITE through `withPortal`. 0059/0062 had
  put `WITH CHECK` on their restrictive policies in advance; **not one statement in that file names
  `client_party_id`**. `party_id` on an uploaded document and `client_party_id` on a response are
  taken from the ask inside the INSERT, and the ask is read under portal scope, so an unreachable
  ask writes nothing.
- 0063 adds five policies: `delivery.client_ask`, `delivery.client_ask_response`, and the three
  document-store tables 0037 left unguarded. **`party_id` NULL means the firm's own and denies by
  arithmetic** (`crm.portal_sees(NULL)` is `NULL = ANY(...)`, not true); written into the migration
  because it does not look deliberate. **Never "tidy" it to `OR party_id IS NULL`** (hands every
  client the firm's stationery). `document_version` and `document_link` are guarded by an EXISTS on
  the parent, inheriting its RLS; this is what makes T3.6's "key is unreachable" true.
- `tests/portal/client-ask.integration.test.ts`: 16 tests; dropping the five policies turns 3, 1,
  5, 2 and 1 red.

### Per-contact roles — `permissionsOf` stopped being arithmetic

- `permissionsOf` returned `[]` for every portal session; `tests/api/portal-permissions.test.ts`
  was written to go red when a portal route needed a permission. **`portal:respond` was that day.**
- **A role declares its AUDIENCE and a role written for the other one grants nothing**
  (`roleServes`), both ways: `manager` on a portal membership and `portal:respond` on `associate`
  both grant nothing. `can()` applies the same rule as `permissionsOf` (they used to differ, safe
  only while gate 2 covered for gate 3).
- **`audience` on `RoleBody` is optional; absent = STAFF** (forced: published versions are frozen
  and `validateBody` rejects unknown keys). `roleBodyOf` writes it only when declared, so a staff
  role's body stays byte-identical, which the role-upgrade migrations (0012, 0045, 0056, 0060,
  0064) compare against to spot a firm that never edited a role.
- **`client_contact` may respond; `client_viewer` may only look; both see everything.** Reading is
  authorised by the grant (`crm.portal_access`), never by a permission.

### There is no virus scanner, no OCR and no auto-filing — and no PORT for one

- No scanner and no agent runtime (`NoAgentsBuiltYet`) exist, so a port would be a contract against
  nothing (T3.6 deleted a `DocumentRenderer` port for that reason). A `scan()` returning "clean" is
  a lie; one that threw would block uploads.
- So: a client file is stored **unscanned**, the firm's screen says so beside it, and the download
  route's `content-disposition: attachment` (never `inline`, since T3.6) is the one protection.
  A scanner arrives with a consumer.

### What running it found

- **The request said twice**: an ask and "Held up" printed the same sentence. `PortalWorkRow.hasOpenAsk`
  answers it; an ungranted ask is invisible to the EXISTS under RLS, so the blocked reason shows
  then (the only thing saying what is wanted).
- **Stale page copy**: a footer saying files could not be sent, under a working picker; a read-only
  contact promised "you can still send another". No gate sees a sentence go stale.
- **A test was looking in the wrong place**: `tests/filestore/model.test.ts` was pinned to
  `0037_document_store.up.sql` after 0063 replaced the `subject_kind` CHECK, so it read a
  constraint the database no longer had. It reads the NEWEST carrier now (as `seed-parity.test.ts`
  does). `linksOf` gained its `work_item` case at the same time (0063 had claimed both halves of "a
  kind nothing can resolve is a link nobody can follow" and shipped one).

## The self-serve library — and the flag that decides what is in it (T6.7)

`usecase/portallibrary` + 0066. Board line: "a client finds last year's challan without emailing
anyone": LAST YEAR'S = no window; CHALLAN = the bytes; WITHOUT EMAILING = the empty state says which
kind of empty it is.

- **The hole 0063 left.** `document_portal_scope` was `crm.portal_sees(party_id)` alone, fine while
  no route LISTED documents. A listing route with `party_id` alone hands the client every working
  paper filed against them (audit notes, internal queries, rejected drafts).
- **`files.document.is_client_visible`, with three mechanisms:**
  - **DB default FALSE**: an import, agent or unaware INSERT publishes nothing.
  - **First value from the KIND** in `FileStoreService` (`clientVisibleByDefault`): challan,
    invoice, credit note and signed engagement letter are the client's; a working paper is not.
  - **Enforced as a POLICY**, never a `WHERE`.
- **A second policy, not an extra `AND`.** The first draft (`ALTER POLICY document_portal_scope ...
  USING (crm.portal_sees(party_id) AND is_client_visible)`) hid the firm's own working papers, and
  the same edit on `crm.invoice` hid every DRAFT from its writers: a RESTRICTIVE policy applies to
  every session and `portal_sees` is true for staff. 0066 copies 0062's guard shape
  (`NOT crm.is_portal_session() OR is_client_visible`; rule in CLAUDE.md).
- **The flag has a switch, same task:** `PATCH /api/v1/documents/{documentId}/client-visibility`,
  ledger `document.client_visibility_set` (a disclosure decision), a column on the `<Documents>`
  panel.

### The invoice

- `crm.invoice.party_id` is who is BILLED, not the entity served (0027, G0.1). **A DRAFT may not
  reach a client, in the policy.** `cancelled` IS visible (a client holding a withdrawn invoice must
  see it was withdrawn).
- Lines, payments and credit notes carry no party column: EXISTS on the parent (0063's
  `document_version` arrangement). `crm.invoice_balance`, `invoice_totals`, `invoice_line_amount`
  are `security_invoker = true`, so 0066 wrote four table policies and no view policy.
- **`crm.dunning_action` gets NO portal policy**: whether a client sees their dunning history is the
  firm's question (as 0065 answered for `crm.client_freeze`).

### Bytes on the client's side — T3.6's rule extended

- `GET /api/v1/portal/documents/{documentId}/content`: **one route, no pre-signed URL**. The
  version row naming the storage key is read under `withPortal` before the key reaches the blob
  store; `PortalBlobStore` has no URL method (see `rendering-and-document-store.md`).
- `content-disposition: attachment`, never `inline`: this store holds CLIENT-supplied files, and an
  uploaded HTML file inline would be same-origin script in a portal another client is signed into.

### The monthly digest is a SCREEN

- `/portal/month` is the thing behind a digest email, and says so; it sends nothing (an honest
  "digest sent" log line would claim a client was emailed).
- Not a copy of the status home (rolling 90 days, what is outstanding): bounded by a calendar MONTH,
  any month back. **A bad month is refused, not coerced** (`2026-13` is not January 2027). Months
  are cut on the firm's zone (see `dates-and-timezones.md`).

### What building T6.7 found

- **The narrowing hid the firm's own papers from the firm**, caught by the first assertion of
  `tests/portal/library.integration.test.ts`, "a STAFF session is untouched": check it first
  whenever a restrictive policy lands.
- **A client's own upload became unreadable to them**: `PostgresPortalAskRepository` did not set
  the new flag, so the INSERT failed the policy's `WITH CHECK` (a portal session cannot write a row
  it could not then read). What a client sends, a client sees: the kind-default mapping must NOT
  apply there (the kind was chosen by the firm when raising the ask).
- **`subject_kind = 'work_item'` had no firm-side reader**: `/work-items/[workItemId]` had no
  `<Documents>` panel. It has one now, holding the visibility switch.

## The client's own request — the first row a CLIENT creates (T6.8)

`delivery.client_request` + `client_request_reply` (0068), `portal:request` (0069),
`usecase/clientrequest`, two adapters.

- **Not `client_ask` reversed.** A request has no work item and may never get one ("please call me
  about the notice"); making 0063's `work_item_id` nullable would remove its composite-FK guarantee
  for every ask. Own table.
- **The wall column is supplied by the caller (uniquely), and `WITH CHECK` holds it.** A contact
  granted three companies must SAY which; `WITH CHECK (crm.portal_sees(client_party_id))` refuses
  any other.
- **The service also refuses an out-of-scope party, as a SENTENCE** (the policy's RLS violation
  would reach a client as a 500). Delete the service check and the write is still refused; delete
  the policy and it is not. `tests/portal/client-request.integration.test.ts` goes straight to
  `withPortal` to show it.
- **`author_side` is stored.** The reply table's WITH CHECK adds `NOT crm.is_portal_session() OR
  author_side = 'client'`, so a portal session cannot sign as the firm. Deriving it (is the author
  staff?) would let a former-staff contact or revoked membership change sides in old threads.
  Without the guard shape, dropping it as a negative control turns two tests red, both the FIRM
  locked out (cannot reply, cannot send a document): T6.7's trap again.
- **Four states; the two endings belong to different people** (Shrestha, 2026-09-02): `open` ->
  `answered` (firm replied at least once; tied to `first_replied_at IS NOT NULL` by a CHECK) ->
  `closed` (**the FIRM**) or `withdrawn` (**the CLIENT**). The firm never writes `withdrawn` ("we
  decided you did not need this" is a close with a reply). Which ending a session may write falls
  out of the repository: the firm's (`withTenant`) hard-codes `closed`, the client's (`withPortal`)
  hard-codes `withdrawn`. Columns `settled_by`/`settled_at`, not `closed_by`.
- **A client's follow-up does not move the status** (would break or loosen the CHECK). Who holds
  the conversation is `lastWordWith`, computed off the thread; the inbox shows both.
- **No kind** (nothing branches on it, unlike `ask_kind`). **No due date** (the firm has never
  given turnaround times). Routing: see T6.9 below.
- **A firm reply may attach a document already filed against that client, and sending it shares
  it**: the adapter sets `files.document.is_client_visible` (0066) in the same transaction. Not an
  upload (a client's files go through T6.6's route into the job's file). 0063's composite FK
  refuses another client's document and the firm's own (`party_id` NULL).
- **`portal:request` is the ELEVENTH permission and the second held outside the firm (0069).** Not
  a widening of `portal:respond` (replies only); this STARTS work. `client_contact` holds both;
  `client_viewer` neither, and still sees the whole portal (reading is by grant).
- **Who hears of it.** The client is emailed nothing: `ClientRequestService`'s deps hold no mailer,
  pinned in `tests/clientrequest/service.test.ts` (as `ChaserService`'s and `NudgeService`'s are).
  Staff are told through the notification outbox since 0323: category `client_request`, from
  `client_request.raised/assigned/replied/closed/withdrawn` (see `notifications-and-mail.md`).
- The firm's reader shipped in the same task: `/client-requests`, `party:read` to read,
  `work:write` to act.

### Whose desk it lands on (T6.9, 0070)

- **The firm has stated no routing rule**, so 0070 adds a SWITCH that is OFF plus hand assignment:
  `tenancy.tenant.client_request_routing` = `none` (DEFAULT, T6.8's behaviour) | `key_manager`.
  A tenant column, not a registry kind (`work_split_axis`'s argument, 0043).
- **A SPOC cannot be an option**: a SPOC has a NOT NULL `axis_id` (0049
  `client_assignment_axis_matches_role`) and a request names no service. The Key Manager needs no
  axis and is one per client.
- **A wrong assignee is worse than none** (0051): the rule names the right person or NOBODY, with
  `assignment_note` naming the fix. **Under `none` there is no note.**
- **The Key Manager is read under `withTenant` BEFORE the portal transaction opens**;
  `crm.client_assignment` has no portal policy and must not grow one. `PortalRequestRow` carries no
  assignee.
- **A portal session cannot forge an assignee**: `bib_app` holds UPDATE on `client_request` and the
  portal WITH CHECK only checks `client_party_id`, so a **trigger** refuses a change of the column (a
  WITH CHECK sees only NEW). Dropping it turns 2 integration tests red.

### What walking it found

- Frontend: `className="row gap"` never worked (`.row` is space-between, `.gap` is undefined); use
  `.cluster` (Approve/Decline were 941px apart).
- A request raised at 00:20 in Delhi rendered as the day before: an INSTANT is not a `date` column
  (see `dates-and-timezones.md`).
- The firm's screen showed "Waiting on us" beside a raw `open` chip: the duplication bug a fourth
  time.

## A group's contact and its sisters (Q064, S1, 0350 branch)

- Access stays GRANTED: one row and one event per company.
- `PostgresPortalGroup.groupOf`: ownership (`parent_of`, `shareholder_of`) both ways, any depth (one
  hop never reaches a sister), organizations only, never the firm's own, an archived company or
  another tenant's, in force on the firm's day, depth 20.
- `grantGroupOf` grants the rest through `grant` (same refusals), skipping companies already held.
  `POST /portal-invites {alsoGroup}` grants before the letter goes;
  `POST /portal-access/memberships/{id}/group`; `GET /portal-access/clients/{id}/group` returns the
  group and `contactsMissing` (contacts who see another company of it, not this one): **offered,
  never granted silently.**
- Tests: `tests/portalaccess/service.test.ts`, `tests/portal/group.integration`.
