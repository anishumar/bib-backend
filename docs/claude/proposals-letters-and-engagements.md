# Proposals, letters and engagements

Scope: the proposal (T2.2), its share link and email (0085), the engagement letter (T2.3) and its freeze, DocuSign (0080), firm signatories (0343), copy-as-new-draft (0316), recorded acceptance (0317), and an engagement's end / pause / resume (0314). What a document says is `document-content-and-issuers.md`; how it renders is `rendering-and-document-store.md`; deleting a draft is `ledger-and-records.md`.

## Proposals (T2.2)

A proposal is a document about a party, built from catalogue rows. Not negotiable without a conversation:

- **The catalogue row is PINNED; the quoted money belongs to the proposal.** `proposal_line` holds `service_version_id` (the frozen `config.version`) plus the amount actually asked: a quote reopened nine months later answers both "our list price then" and "what we charged".
- **One rate struck on the proposal, stored even when currencies match.** Originally "one proposal, one currency" via a composite FK; lines may now be priced in several currencies (0344, see CLAUDE.md Money). Nothing is converted silently.
- **The arithmetic is in the schema** (`crm.proposal_line_amount`, `crm.proposal_totals`, 0013), in `numeric`, as `security_invoker` views (a plain view runs as its owner and would bypass RLS).
- **Discount limit = a `policy` config row read LIVE. No published policy means ZERO, not "no limit".** Going past it needs `proposal:approve` (its own permission, not `tenant:admin`, not the fee axis).
- The fee axis's first consumer: money is **redacted** (null), so an associate without commercial visibility sees client, services and quantities.

**The share link is a `PUBLIC_PATH`, the first not about obtaining a session.**

- Token `<tenant_id>.<secret>`: the tenant rides inside so resolving a link is an ordinary `withTenant` read (no digest lookup across all firms on a money table). Only the SHA-256 digest is stored; the token arrives in the BODY (paths land in access logs and Referer); malformed, unknown and withdrawn all answer the same.
- Adding another public entry needs a written argument; `tests/api/auth-coverage.test.ts` holds the build red until it exists. **`PUBLIC_PATHS` is nine** since 0085 (the eighth `…/shared/answer`, ninth `…/shared/pdf`). Paths are chosen so no staff route matches: `shared/decision` would have collided with `{proposalId}/decision`.
- A view is **a count and one event**: `view_count` counts SITTINGS (an open within `VIEW_DEDUPE_MINUTES` = 30 of the last does not advance it: refreshes and link previews are not reading); `proposal.viewed` is recorded once. Per-view analytics does not belong in an append-only log.

## The proposal by email, and the client's own answer (0085)

**Decided 2026-09-26 (user):** bib emails the proposal itself (PDF attached, Accept / Decline buttons) and the CLIENT answers on the share link's page. Four answers: buttons open a confirm page (not DocuSign, reply-parsing, AMP or Outlook Actionable Messages: each works in one client and needs vendor approval); a NAME plus a tick against a statement to accept; the firm's own mailbox as sender; an email to the preparer when the client answers (no confirmation copy to the client, no reminders, no first-open notice).

- **The buttons do not answer**: mail scanners open every link. A button opens `/p/<token>?answer=accept|decline` with the answer READY; the answer is `POST /proposals/shared/answer` (a name; `confirmed` against `acceptanceStatement` for acceptance). The statement is composed once in the domain (`acceptanceStatement(ref, client)`), sent on the shared view and recorded, so what the box said is what the firm keeps.
- **Stored, none of it is the link:**
  - **PDF of record** `crm.proposal.sent_pdf_version_id`: the one render the client was sent (attachment, `POST /proposals/shared/pdf`, what an answer is recorded against). Filed through `FileStoreService.render`, PINNED at Send (since 2026-09-28; `coalesce` in `pinSentPdf` so racing renders cite one file), never re-rendered (a render reads today's brand assets). Best-effort like the email: a failed render leaves it sent and the next reader files it.
  - **Each email** `crm.proposal_email`: address, note, PDF version, DIGEST of the link carried; written only once the mail server took it.
  - **The client's answer** `crm.proposal_client_decision`: name, statement (acceptances only, CHECK), the email whose link was used (digest), the PDF, address and browser as the rate limiter derived them. One per proposal. Written with the status in ONE transaction whose UPDATE repeats `status = 'sent'` (`recordClientAnswer`), so two tabs land one answer (integration test races them). A colleague's recorded decision writes no row.
- **Ledger, no PII:** `proposal.emailed` carries email id + PDF hash; `proposal.accepted`/`rejected` from the link carry `via: "share_link"`, `emailId`, `pdfContentHash`, SYSTEM actor; `proposal.link_reissued` is the other new verb.
- **Send may email; failure is an answer.** `POST /proposals/{id}/send` takes optional `{ email: { to, note? } }`. The address is checked (no mailer: `EMAIL_UNAVAILABLE` 501) BEFORE anything moves; afterwards a render/relay failure returns `email.status = "failed"` beside the link (throwing would lose the link, readable once). `POST /proposals/{id}/reissue` issues a NEW link (old one stops: one live link per proposal), optionally emails it; only while `sent`.
- **The mail** (`SmtpMailer.sendProposal`): firm's display name via `fromName`, replies to the preparer, "Nothing is decided by opening it." The preparer's notice (`sendDecisionNotice`) is best-effort. **The worker gets `mailer: null`** (reads quotes only, holds no SMTP password). Sender policy: `notifications-and-mail.md`.
- **Not built:** confirmation copy to the client, reminders before expiry, first-open notice, a portal-authenticated answer.

## Engagement letters (T2.3)

A proposal is what the firm OFFERED; a letter is what both sides AGREED, so everything is stricter.

- **Signature FREEZES, by a trigger** (0017), not a service check: a court asks "what did they sign". A change after signature is a NEW LETTER; the old stays readable.
- **Clauses are the registry's fourth kind and PINNED** (a live read would answer with today's wording). A clause scoped to another jurisdiction is refused.
- **The letter stores its OWN jurisdiction**, chosen at drafting, never derived at read time.
- **Needs lines AND clauses before it can go out** (no clauses = a contract enforceable as whatever a court reads into it).
- **A line names the ENTITY the work is for, not the client.** Engagement = `service × ONE LEGAL ENTITY` (the firm's "Per Company" rule: vCFO for four companies = four engagements). `entity_party_id` NOT NULL on the letter line and engagement, nullable on a proposal line (a prospect may hold no company; Incorporation's entity is its own OUTPUT). **`party_id` stays**: the client is BILLED, the entity is DELIVERED TO; invoicing needs the first, the compliance calendar the second (an entity owes GSTR-3B). The entity is in `canonicalContent` (the signature commits to it) and on `contract.activated`.
- **Signing fans out one engagement per line in ONE transaction**; `UNIQUE (engagement_letter_line_id)` makes a double fan-out impossible.
- **The freeze names what may still MOVE, never what is protected.** Line/clause triggers refuse any write to a signed letter's children. The letter's own `crm.refuse_signed_change` once compared an enumerated column list, so six later columns were silently editable. **0019** compares the whole row (`to_jsonb(NEW) - mutable` vs OLD) exempting only `crm.signed_letter_mutable_columns()`: `advance_recorded_at`, `advance_recorded_by`, `updated_at`. **A new letter column is frozen the day it exists; a FOURTH exemption needs an argument.** `tests/architecture/signed-letter-freeze.integration.test.ts` asks the catalogue for every column.
- **No NOT NULL column can be added to a letter line once real signed letters exist** (the freeze refuses the backfill, by design; 0018 refuses rather than work around it). A new required field on an issued document is a nullable column required only for letters drafted after it.
- **The advance-fee gate is real.** Engagements start `pending_advance`; `contract.activated` (T2.4's scheduler trigger) is not emitted until the advance is recorded. Honest limit: a person attests the money arrived. Advance handling: `billing-and-advances.md`.
- A BEFORE trigger on a signed/issued row sorts after the freeze, so a change is refused as that.

## Sending a letter for signature: DocuSign (0080)

`ESignProvider` VERIFIES a signature that exists; `SignatureDispatch` ASKS for one. Under `BIB_ESIGN_PROVIDER=docusign`, `send()` records whom to ask (`crm.letter_signature_request`), marks the letter sent, renders its PDF and raises an envelope stamped `bib_letter_id` + `bib_content_hash` (what the verifier then checks). The worker's signature sweep asks DocuSign how each envelope has ended: `completed` → `sign()` (verifier, hash, fan-out and activation run as for a person), `declined`/`voided` → withdrawn with `signatureOutcome` on the event. Under `attested` nothing is sent.

- **`sent` IS "out for signature"** (decided 2026-09-23); no fifth state. Provider/whom/asked-yet is the request row, read as `signing` on the letter view.
- **A letter is never signed because an envelope went out.** `signed` is terminal and frozen; raising and signing are two moments in two processes.
- **A DocuSign fault never undoes a send.** Fault kept on the request (`last_failure`); `POST …/signature-request` retries. **A retry never mails a second contract**: one UPDATE with the whole condition in its WHERE, and before raising the dispatcher asks DocuSign for a live envelope already carrying this letter's id (the reply to a create can be lost).
- **Withdrawing asks DocuSign first**: a live envelope is VOIDED before the letter moves; an already-completed one is refused (`ENVELOPE_ALREADY_SIGNED`, 409) and left for the sweep; a void DocuSign refuses withdraws nothing.
- **An envelope DocuSign does not hold is `missing`, never `voided`** (found by the first real run): likeliest cause is the wrong account, and reading it as voided would withdraw every letter out for signature in one sweep. The sweep reports and moves nothing.
- **bib keeps its own copy of every signed contract**: on completion the sweep files DocuSign's signed PDF as `engagement_letter` (client-visible, portal library) and the certificate as `other` (firm audit record), a pass of its own (`copies_filed_at`); both fetched before either filed.
- **The request is not a term**: second name in `NOT_TERMS`; the evidence envelope id is copied onto the frozen `signature_reference`.
- **Anchors are a shared constant**: the renderer prints `CLIENT_SIGN_ANCHOR` / `CLIENT_DATE_ANCHOR` in page colour; the dispatcher searches the same strings; `anchorIgnoreIfNotPresent` false (a PDF without them is refused).
- **The book import never raises an envelope** (`send(…, { migrated: true })`), like `migrationSigner`: a 2023 letter was signed on paper.
- **Both processes hold the DocuSign credential** (`setup/esign.ts`) and the bucket; the worker is composed with `letterPdf: null` and never raises. Not built: a Connect webhook (the sixth public route; completion is within five minutes instead), reminders/resends from bib.

## Who signs for the firm: a list, and a choice on each letter (0343, Q005)

Client (Ashish, 30 Sep 2026): add signatories and a dropdown at finalising the EL. 0022 gave the firm ONE signatory.

- **The list is `tenancy.firm_signatory`** (tenant-scoped, RLS, composite keys): a staff member, the capacity they sign in, their OWN signature image (`files.document_version`), `is_active`. Firm-wide, whichever company issues (Shrestha, 2026-10-04). One entry per person; retired, never deleted. Routes `/api/v1/tenancy/signatories` (read `config:read`, write `tenant:admin`); `PUT /tenancy/firm-signatory` still works (lists the person, makes them default).
- **The DEFAULT stays on `tenancy.tenant.firm_signatory_*`** (the owner rule T6.17, job desk and preview read it there). Held by a KEY: the tenant's `(id, user, title)` references the list's `(tenant_id, user_id, title)` ON UPDATE CASCADE, so the default is always on the list and a title rename moves both. First signatory becomes default; the default cannot be retired until another is named (`DEFAULT_SIGNATORY_CANNOT_RETIRE`). `SignatoryRepository.makeDefault` replaces `TenantRepository.setFirmSignatory`.
- **A letter chooses on the DRAFT** (`crm.engagement_letter.chosen_signatory_id`, null = default at send) via `PATCH /engagement-letters/{id}` `chosenSignatoryId`, because the preview must print the right name before send. `send()` still SNAPSHOTS person, title and image into 0022/0081's columns (the record). A retired choice is refused when chosen and at send (`SIGNATORY_RETIRED`, 409) before anything is written (`EngagementService.signerFor` runs before the request opens). 0019's freeze covers the column (added with no backfill).
- **The signature image is a PERSON's (`signerFor`).** Their own first; only the DEFAULT with none falls back to the issuing company's `brand_asset` signature (what every pre-0343 letter carried); anyone else prints a bare rule. Printing the company mark over another partner's name would forge a document. The preview reads the same rule in SQL; `tests/render/preview.integration.test.ts` proves it is byte-identical to Send.
- **Not in `canonicalContent`** (the hash already carries `firmSignatoryUserId` + title; adding the choice would move the hash of every letter in flight).
- **Not decided:** the owner rule's last resort is still the FIRM default, not the letter's chosen signatory; copy-as-new-draft does not carry the choice.

## Copy as new draft (0316)

**Decided 2026-09-30 (Shrestha):** a proposal DECLINED or EXPIRED, and a letter WITHDRAWN (including declined in DocuSign), can be copied into a new draft with a new reference. `POST /proposals/{id}/copy`, `POST /engagement-letters/{id}/copy` (`party:write`); `copyAsDraft` on `ProposalService` / `EngagementService`. Not to be re-made: only those statuses (sent is still with the client, accepted goes on to a letter, signed is superseded); the link is STORED both ways (`copied_from_id` on the new row, `copies` read back); amounts, discounts and wording come across EXACTLY.

- **The source never changes** (pointer is on the NEW row, so the signed freeze is not asked for an exception). `proposal.copied` / `engagement_letter.copied` against the OLD; the new gets its ordinary `*.drafted` with `copiedFromId`.
- **Every piece goes through the hand-built draft's door** (`draftProposal`/`draftLetter`, `addLine`, `addFeeGroup`, `addClause`), so every check applies. A line that can no longer be added (company archived since) or an addressee no longer in the structure is SKIPPED AND REPORTED, never failing the copy; the screen lands on the draft with `?copied=partial`.
- **Prose comes whole** (`DocumentService.seedBlocksCopied`, instead of `seedBlocks`, never after it): every kind incl. cover and acceptance; a line keeps its standard `sourceId` only if never edited.
- **A letter's terms come at the library's CURRENT wording** (a new letter is a new contract): each clause key re-added at its published version; one retired or no longer fitting country/law is in `skippedClauses`.
- **Not copied**: status and dates, share link, PDF of record, client's answer, signature request, discount APPROVAL (asks again). A past validity/start date is left off.
- A sent proposal past its date counts as expired: the copy expires it first. Each detail read carries `copyRefusal` (sentence or null).

## A client's yes given outside bib: the recorded acceptance (0317)

**Decided 2026-09-30 (Shrestha):** the client says yes by email or call without pressing Accept or signing in DocuSign. `POST /proposals/{id}/acceptance`, `POST /engagement-letters/{id}/acceptance`, on **`acceptance:record`, the twelfth permission, partner-only by default** (0317 publishes it onto every partner role still at the default). Not to be re-made: that permission (not `proposal:approve`/`tenant:admin`); a LETTER needs the client's email FILED against it (`evidenceDocumentId`, a live `document_link` to the letter; CHECK and service), a proposal needs how, when, who and a note (file optional); only while `sent` (a lapsed proposal is expired and copied, never accepted late); a letter's envelope still out is VOIDED first and the request settled; one DocuSign reports signed is refused (`EnvelopeAlreadySigned`) and left for the sweep.

- **`/decision` no longer accepts** (409 `ACCEPT_THROUGH_RECORD`); declining unchanged on `party:write`. `ProposalService.decide` still takes "accepted" for internal callers.
- **`crm.recorded_acceptance`**: one per document (partial unique indexes), exactly one parent (CHECK), channel a closed set, **append-only by GRANT** (0317 REVOKEs before GRANT; found via `has_table_privilege`). Written INSIDE the transaction that moves the document (`recordAcceptance`, `signAndFanOut`'s new last argument); `infrastructure/postgres/recorded-acceptance.ts` is the one insert/read and re-checks the evidence link as the wall.
- **A letter is signed through the ordinary path** (hash, freeze, fan-out, advance gate) via the attested `migrationSigner`, `signatureMethod = "recorded_acceptance"` (`RECORDED_ACCEPTANCE_METHOD`), reference naming channel and day. The evidence link is asked BEFORE the void, so a wrong file voids nothing. One window left: a sweep reading the envelope as voided between void and settle would withdraw the letter.
- **Ledger says HOW** (`via: "recorded"`, `channel`, `recordedAcceptanceId`) on `proposal.accepted` / `engagement_letter.signed`; name and note stay on the erasable row. Both detail reads carry `recordedAcceptance`.
- `smoke.sh` and `demo-seed.sh` record acceptance on the UTC day (both firms run on UTC).

## An engagement ends, pauses and resumes (V2.3, 0314)

Until 0314 only `active`/`pending_advance` was written, so a client who left kept a job, a task every month and MRR. **Four decisions (user, 2026-09-28), not to be re-made:**

1. **Ending changes status at once** (`completed`, or `cancelled` when `endsOn` is before `effectiveFrom`), so MRR (`status = 'active'`) drops the day it is recorded. `ends_on` is the LAST day served, inclusive. The work up to it still happens: `activeRecurring` also offers ended engagements (active first), `periodsToMaterialise` stops at `endsOn`, `subjectsFor` returns them and the generator skips a period that STARTS after `endsOn` (THE CEILING: a firm that served September files September's return, due in October). `lifecycle.integration.test.ts` goes red with the ceiling removed.
2. **Ending withdraws only untouched upcoming filings for periods AFTER the end**, same transaction, via T6.16's `withdrawUncovered` (one code path, a `WithdrawalScope`), reason `engagement_ended`; chains locked in id order first. Jobs already on the board for later periods are NOT cancelled: the answer lists them (`openJobsAfterEnd`) and the job page cancels (V2.4, `delivery-engine-and-workflow.md`).
3. **Pause stops new jobs and filings** (both read `active`). Resume sets `resumed_on` (firm's day): a recurring period that ENDED before it never spawns, the month the pause ended in does, and the generator back-fills filings that fell due meanwhile (missed if past, for a partner).
4. **A client may be archived once nothing is live** (0314 rewrote `core.refuse_archive_with_references()`): an open lead, a draft or sent proposal/letter, a `pending_advance`/`active`/`paused` engagement refuse; history does not. For a client who leaves: End each engagement, then Archive. Both spawn feeds also skip an archived client/company.

Walls are ONE-DIRECTIONAL: an end record implies an ended status, a pause stamp implies `paused`, never the reverse (integration suites leave `cancelled` rows with no end record). The reason is prose about a client: on the row (`end_reason`), never in the ledger (`engagement.ended` carries ids, days, counts). Routes `POST /engagements/{id}/end | pause | resume` (`party:write`), `EngagementLifecycleService` (own use case so 15 `EngagementService` constructions did not change), `PostgresEngagementLifecycle`. `isDay` accepts 2026-02-31 (V8 rolls it to March), so the end date uses `isCalendarDay`.
