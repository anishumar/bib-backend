# Notifications and mail

The SMTP transport and its letters, who a letter is from, and the in-app bell with its email
copies. The proposal email itself is in `proposals-letters-and-engagements.md`.

## Mail — the transport (T7.0)

- **Ports.** `Mailer` (`usecase/identity/ports.ts`) has five methods: `sendMagicLink`,
  `sendPortalInvite`, `sendStaffWelcome`, `sendPortalWelcome`, `sendPasswordReset`. Other letters
  are declared beside their use case: `sendProposal` / `sendDecisionNotice`
  (`usecase/proposal/ports.ts`), `sendAdvanceDigest` (`usecase/billing/ports.ts`),
  `sendNotifications` (`usecase/notify/ports.ts`). `SmtpMailer` and `LoggingMailer` implement all.
- **Why it had to exist:** with only the log mailer a client could not be invited to the portal
  (an invite meant copying a URL out of a server log), and `validateServer` refuses `log` in a
  production-like environment, so nothing could deploy. `log` stays the local stub, still refused
  in public (honest registry, `auth-and-sessions.md`).
- **Plain SMTP, not a vendor SDK.** Google Workspace, Microsoft 365, SES and Postmark all speak it;
  switching provider is `.env`. `nodemailer-transport.ts` is the ONLY file that imports the driver;
  `smtp-mailer.ts` holds the letters and knows nothing of transport, so letters test without a
  socket.
- **The invite must not read as phishing** (unasked, unknown sender, asks to set a password): it
  names the firm in the SUBJECT, says why they receive it and what they will be able to do, and
  tells them to check with their own contact rather than reply. `firmName` is on the port for
  that sentence; `tests/identity/letters.test.ts` asserts each part.
- **A firm's name is data.** A newline would append headers to Subject; `&` / `<` would become
  HTML markup. Both handled at the door and tested; blank after stripping = absent.
- **The expiry names its zone** ("4 September 2026, 14:05 UTC"): an email has no browser to ask
  (T6.10's rule, `dates-and-timezones.md`).

### A failed send: swallowed on sign-in, raised on invite (a security decision)

- **`requestMagicLink` SWALLOWS it.** Unknown or deactivated addresses already return early and the
  route answers 202 either way; a thrown send would make 500 mean "has an account" — an
  enumeration oracle built from an error path.
- **`invitePortalContact` LETS IT OUT.** No account to be quiet about, a firm member is watching,
  and a silent failure is a client who never gets in.
- **The failure is logged in the ADAPTER** — the only layer that knows a send failed and may hold a
  logger (no use case takes one). Without it the swallow makes a broken relay silent.

### Resend

`POST /api/v1/portal-invites/{membershipId}/resend` (`PortalInviteService.resend` →
`IdentityService.resendPortalInvite`). A failed relay (bounce, typo, quota) used to leave a contact
created, granted and permanently uninvitable. **Same address only**: the input carries the
membership id and nothing that reaches the letter; changing the address would let any firm login
move a client's portal access to a mailbox of its choosing (a new door, needing its own event and
probably an approval — not built). Checks in order: this firm's row, a CLIENT_PORTAL login, still
active; identity then refuses once the contact has a credential (`auth-and-sessions.md`
§ Passwords). The event is written AFTER the send.

## Who a letter is from (0085, CA#12, Q059 / 0350)

- `Letter` has `fromName`, `replyTo`, `attachments` and `fromAddress`. The envelope ADDRESS is
  `BIB_MAIL_FROM`, the one the relay authenticates, unless `fromAddress` is allowed (Q059 below).
- **Every letter sent FOR a firm goes out under the firm's display name (CA#12, audit
  2026-10-03):** the proposal, the portal invite, both welcomes, the decision notice and the weekly
  advances summary set `fromName`. Only the sign-in link and the password reset (a global account,
  no one firm) keep `BIB_MAIL_FROM_NAME` — so that setting should be the PRODUCT's name on a
  deployment serving more than one firm.
- `BIB_MAIL_FROM` is one address per deployment (bib-qa: a personal Gmail, display name "10xcrm").
  The user chose the firm's own mailbox; until its SMTP login is set, bib-qa mail comes from that
  Gmail under the firm's name. A sender per firm on one deployment is **not built**; per-firm
  addresses or domains wait for Sid and Anish (infrastructure).
- **Q059 (0350), client emails come from the client's person.** `PostgresClientSenders`
  (`infrastructure/postgres/client-senders.ts`): a proposal about ONE Dept is from that Dept's
  SPOC; anything else (several Depts, portal letters) from the client's Key Manager; in force on
  the firm's day, active staff; a resend takes the first company the contact sees that HAS a Key
  Manager. From name "Priya Sharma, 10x Global", Reply-To Priya. The From ADDRESS is hers only when
  her domain is in `tenancy.tenant.send_from_domains` (0350: CHECKed lower-case domains, max 20;
  `GET/PUT /api/v1/tenancy/mail-senders`, `tenant:admin`, ledger `tenant.send_domains_set`);
  otherwise `BIB_MAIL_FROM`. Nobody in the seat: as before. Only `Letter.fromAddress` can change
  the envelope address; staff letters, magic links and resets never set it.
- **Not emailed to clients at all:** invoices, engagement letters (DocuSign sends them) and
  reminders (the chaser has no channel, `escalation-chaser-nudge.md`).
- **Which processes hold the relay.** The API does. The worker has held the SMTP settings since
  0322 (`setup/worker.ts`, `mailerFor(cfg, log)` for the advance digest and notification emails;
  Terraform `run_worker.tf` + `iam.tf`), but its proposal service is still composed with
  `mailer: null` (it only reads quotes; an email asked of it is refused by name, 0085).

## Notifications: the bell and its email (0323, 0324)

My day is STATE (what is on my desk now; leaves when the work does). A notification is an EVENT:
arrives once, read or not, links to its source, stays as history. Design and Ashish's open
questions: `bib/prompts/notifications/DESIGN.md`.

- **Schema `notify` (0323).** `notification.payload` holds ids and machine facts, never a sentence:
  `domain/notify/model.ts` `renderNotification` writes the words AT READ TIME for that reader, so
  the fee axis applies to the reader (`seesFees`; no amount otherwise) and a renamed client reads
  right in old rows. `dedupe_key` unique per (firm, recipient): `event:<eventId>:<category>` from
  the outbox, `stage:<category>:<source>:<stage>` for a reminder. `resolved_at` = the work is over
  (shown "Done", not unread).
- **Two walls on the inbox.** RLS on the tenant PLUS a RESTRICTIVE policy on
  `app.notify_recipient`, set only by `withRecipient` (`db/tenant.ts`); every inbox method also
  filters on the recipient. Unset = the worker (writes for many people). Each guard was removed in
  turn in `tests/notify/inbox.integration.test.ts` and the other held. No route takes a user id;
  an admin reads only their own inbox; anybody else's id is 404.
- **No DELETE grant.** Retention is `notify.prune(before)`, SECURITY DEFINER: only the scoped
  firm's read-or-resolved rows, never newer than 30 days, nothing with no firm in scope. `bib_app`
  may UPDATE only `read_at` and `resolved_at`. Pruned daily on the escalation cron.
- **Categories are a closed registry** (`NOTIFY_CATEGORIES`, 17, `domain/notify/model.ts`):
  `task_assigned`, `step_assigned`, `check_requested`, `escalation`, `lead_assigned`, `lead_new`,
  `client_request`, `client_answered`, `proposal_decided`, `letter_signed`, `bill_to_raise`,
  `advance_reminder`, `advance_summary`, `advance_unmapped`, `payment_received`,
  `dunning_decision`, `filing_missed`. The firm sets defaults per category and channel
  (`notify.firm_default`, `tenant:admin`, ledger `tenant.notification_defaults_set`); a person
  overrides (`notify.user_preference`, not ledgered). Person > firm > product. `escalation` and
  `filing_missed` in-app cannot be switched off by anybody (409). Nothing seeded: absence = the
  product default.
- **The ledger is the outbox.** `domain/notify/fanout.ts` `planFor(event)` maps a verb to
  categories, an audience BY RELATIONSHIP (assignee, Key Manager, invoice/bill manager, eligible
  checkers via T2.9's `eligibleCheckers`, a permission, a grade) and what it resolves.
  `usecase/notify/fanout.ts` `NotificationFanout` resolves people as the firm stands now, keeps
  active staff, drops the actor (nobody hears of their own act) and anyone whose bell is off.
  Queue `notify.fanout` every minute (`BIB_WORKER_NOTIFY_CRON`).
  - Cursor per firm (`notify.fanout_cursor`); each run re-reads a 10-minute window behind it (late
    commits), refused by the dedupe key; the limit counts NEW events only. **The first cursor
    starts one window AHEAD of now**, or the first runs replay pre-start events (caught by the
    integration test).
  - **Resolving is causal:** only rows caused before the resolving event (`resolve`'s
    `causedBefore`), so re-reading an old "task finished" never closes the next round's.
  - A task raised BY HAND with an assignee writes `work_item.created` (`assigned: true`) and no
    `work_item.assigned`; only `origin: manual` is read from `created` (spawned tasks write both).
    Found by the walk.
- **Advance reminders** (`AdvanceReminders`, queue `notify.advance-reminders`, hourly): no event
  exists when a day passes, so it reads `AdvanceDesk.list` and writes one row per stage
  (`draft_overdue`, `unpaid_overdue`, `escalated`) per person — the chasers (SPOC, KM, partner),
  plus admins while it waits for an admin; escalated = admins + partner. A stage left, or an
  advance no longer pending, is resolved. The weekly summary reaches admins' bells via
  `tenant.advance_digest_sent`. See `billing-and-advances.md`.
- **Routes** (`api/handler/notification.ts`, `NO_PERMISSION_REQUIRED` except PUT firm-defaults):
  list (cursor by the millisecond the client was handed), `unread-count` (capped 100, one partial
  index, built to be polled once a minute per visible tab), mark read, read-all up to an instant,
  preferences, firm-defaults. Not in `PORTAL_PATHS`.
- **Check-to-decide reaches the sender's MANAGER** (DESIGN.md §J, Q2) when that manager may check it
  (T2.9's rule); otherwise every eligible checker, so a check is never silent. The maker of a task
  check is the task's HOLDER: `trg_work_item_approval_derive_maker` fills `submitted_by` from the
  task whatever the insert said.
- **Email (0324, DESIGN.md §J).** Every category is on by email by default; each person may switch
  their own off. HOW is the category's (`emailMode`): `escalation` and `filing_missed` at once
  (`NotificationEmails.sendInstant`, on the outbox's every-minute queue, one letter per person per
  run, rows under 24 h old); everything else in ONE email a day at the firm's hour in the firm's
  zone (`sendDigests`, queue `notify.email-digest`, hourly; `dailyDigestDue`), unread and
  unresolved only, reaching back 7 days. `emailed_at` is CLAIMED before the send and released if
  the relay refuses; the daily email is claimed per firm, person and day (`notify.email_digest`),
  so a doubled worker sends one; a refused daily email's rows stay unemailed for the next day. The
  firm's hour: `notify.firm_setting` (no row = 09:00), shown on GET firm-defaults, set by PUT
  `/notifications/digest-hour` (`tenant:admin`, ledger `tenant.notification_digest_hour_set`). The
  words are the bell's (`readRecords`, one query for both) with the reader's fee visibility;
  `SmtpMailer.sendNotifications` names the firm in the subject (header-safe) and links every
  notification, the list and `/account`.
- **Q066, a new lead tells its owner and every admin** (2026-10-05, 0350 branch). The outbox reads
  `lead.captured`: the owner hears `lead_assigned` ("The firm's rule gave you a lead" when the
  rotation chose); every holder of `tenant:admin` hears `lead_new`, except the creator and the
  owner (an `Announce` may name people it skips: `except`). Closing a lead resolves both. The API
  still runs the assignment strategy only when no owner is SENT; the form makes the choice
  explicit.
- Client requests reach staff through the outbox (`client_request.raised` / `assigned` /
  `replied` / `closed` / `withdrawn` → category `client_request`); see `client-portal.md`.
- **Not built:** push (phase 2), client-portal notifications. "Bill to raise" reaches the bill's
  manager (else KM) only, not the boss-escalation or no-price SPOC paths My day has.
- Tests: `tests/notify/*.test.ts` (incl. `letter.test`), `inbox.integration`,
  `fanout.integration`, `email.integration`. One-firm run on the shared DB (outbox, reminders,
  emails): `bib/demo-assets/tools/nt-notify-tenant.mts`. Walk: `nt-walk.mjs` (42/42, Mailpit).
  Q066/Q059: `tests/notify/fanout*`, `tests/mail/model.test.ts`, `tests/clientmail/*` (incl.
  `senders.integration`); walk `qw-walk.mjs` (38/38, Mailpit headers).
