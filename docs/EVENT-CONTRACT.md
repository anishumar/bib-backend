# The event contract (T1.1)

The interface where the two lanes meet. The commercial lane (A) and the delivery lane (B)
build in parallel and collide in exactly two places: **this contract** and the engine's
trigger contract (T2.5). Agree this one, and the lanes barely touch afterwards.

Nothing here is prose-only. Every rule below is enforced in
`src/domain/ledger/model.ts` and `src/usecase/ledger/service.ts`, and tested in
`tests/ledger/`. If a rule and this document disagree, the code is right and this file is
a bug.

---

## 1 · What the ledger is

One append-only table, `ledger.event`, holding one row per thing that happened. It is
three products at once, which is why it is built in Phase 1 rather than "later":

- **the audit trail** — the regulator's question, years from now, about who did what;
- **the trigger source** — the scheduler consumes `contract.activated` (T2.4) rather than
  the commercial lane calling the engine directly;
- **the AI's memory** — every approved position and outcome, per client (A11).

It cannot be reconstructed retroactively. History not captured is history gone, so the
capture goes in before the things that make history.

## 2 · The one call

```ts
// In your use case's Deps — depend on the PORT, never on LedgerService.
import type { EventSink } from "../ledger/ports";

export interface Deps {
  readonly events: EventSink;
  // …your own ports
}

await this.deps.events.recordEvent({
  tenantId,
  verb: "proposal.sent",       // from the registry — a closed set
  objectId: proposal.id,       // the row it happened to
  actor: { type: "human", id: ctx.principal.userId },
  payload: { engagementId, channel: "email" },   // ids and machine facts
});
```

The composition root (`src/setup/server.ts`) injects the single `LedgerService`. There is
one implementation of this contract in the process, and no service is ever handed the
Postgres adapter — so no event can reach the table without passing every check below.

## 3 · The five rules

### 3.1 The verb comes from a closed registry

`EVENT_VERBS` in `src/domain/ledger/model.ts`. Past tense, dotted, `<subject>.<happened>`.
An unregistered verb is refused at the write.

This is stricter than it looks, and deliberately. In an append-only log a typo is
permanent: `invoice.sented` creates a verb nothing queries, and the event silently drops
out of every timeline, dashboard and trigger that matters. There is no migration that
fixes it afterwards.

**Adding a verb is a one-line change** to that registry plus a row in §6 here. That is the
intended cost: cheap to do, impossible to do accidentally.

### 3.2 `object_type` is derived, never passed

Each registry entry declares the kind of row its verb applies to. The caller passes only
`objectId`. A verb and its object type therefore cannot disagree, and no one has to
remember the mapping.

If a verb genuinely applies to two kinds of object, that is two verbs.

### 3.3 Every event names its actor

`human | agent | system`. A human or an agent **must** carry a uuid id; only `system`
(a scheduler tick, a boot job) may be anonymous. Enforced in the domain and by
`event_actor_identified_chk` in the database.

Once agents write to these tables this column is the only way to answer *who did this* —
and both the regulator and the maker≠checker rule (T2.9) will ask.

### 3.4 The payload carries no personal data

The payload is **ids and machine facts**. Personal data — email, phone, PAN, DIN, DOB,
address, bank details, a person's name — is refused, at any nesting depth, in any casing.

The reason is erasability. The ledger cannot be edited or deleted, by anyone, ever. If a
DPDP/GDPR erasure request required mutating it, we would have to choose between breaking
the law and breaking the audit trail. So personal data lives in an ordinary erasable row
and the event references it **by id**:

```ts
// ✗ refused
payload: { email: "priya@example.com", pan: "ABCDE1234F" }
// ✓ the same information, erasable
payload: { partyId, identifierId, identifierType: "pan" }
```

A company's `legalName`, `gstin` or `cin` is a business fact about an entity, not personal
data, and stays allowed.

Also bounded: **64 KiB** and **8 levels deep**. An event summarises what happened; the
artefact belongs in documents (P8), referenced by id.

### 3.5 Idempotency is opt-in, by key

Anything an external system can deliver twice — a webhook, a retried job, a racing pod —
passes `idempotencyKey`. The event id is then derived (uuid v5) from it, the replay
collides on the primary key, and the second delivery observes the row the first one
created. Without a key, two identical calls are two events, which is correct for two real
clicks.

**Include the tenant id in the key.** Ids are globally unique but the ledger is
tenant-scoped: a key that collides across tenants produces a row RLS then hides, and the
adapter raises rather than guess.

## 3.6 Every event needs a tenant — and what that excludes

The ledger is tenant-scoped (RLS, like every other business table), so an event that has
no tenant has nowhere to live. That is not a gap to work around; it is the wall doing its
job. Two consequences, both found by wiring the first consumers:

- **Creating a global `user_account` is not recorded.** Identity lives above tenant
  (ADR-02), so a fresh login belongs to no firm's timeline. The fact a firm actually cares
  about — *this person gained access to us* — is `membership.granted`, which does have a
  tenant. The verb `user.registered` was in the first draft of this registry and has been
  removed for exactly this reason.
- **`session.started` is recorded when a session becomes active IN A TENANT** — at login
  when there is one membership to select, and at `switch-tenant` when the user chooses.
  A partner who belongs to two firms and has not yet chosen has a valid session that no
  firm can see, which is the correct answer: neither firm has been accessed yet.

If you find yourself wanting to record something that has no tenant, it is either
platform-level (and belongs in logs, not the ledger) or you have not yet found the
tenant-scoped fact underneath it.

## 4 · When to write, and the honest limit

Record the event **after** the change it describes has committed.

Today the event is written in its own transaction, not the caller's — the repositories are
per-aggregate and none of them share a unit of work. So the two failure modes are not
symmetric, and we choose the survivable one:

| Order | If the second step fails | Verdict |
|---|---|---|
| change, then event | a real change with no event — a gap in the log, detectable by reconciliation | **acceptable, and what we do** |
| event, then change | an event asserting something that never happened | **unacceptable — the log must not lie** |

A shared unit of work (`withTenant` spanning both) is the fix when a module needs strict
atomicity; the port shape above does not change when it lands, because the caller's code
is identical either way.

## 5 · What the database guarantees

Migration `0003_ledger`, proven in `tests/ledger/immutability.integration.test.ts`:

- **`bib_app` holds SELECT + INSERT only.** No UPDATE, no DELETE — and the schema's
  default privileges withhold them too, so a future table in `ledger` is append-only
  without anyone remembering.
- **A trigger rejects UPDATE / DELETE / TRUNCATE for every role**, including `bib_owner`
  and a superuser session. Grants stop the application; the trigger stops the 2 a.m. psql
  session.
- **RLS** on `tenant_id`, same wall as every other business table. One firm's audit trail
  is invisible to another.
- **Two clocks.** `occurred_at` is business time (an external callback may report a past
  moment); `recorded_at` is when we learned of it. Reconciliation needs both.
- **The boot check** (`assertLedgerAppendOnly`) re-verifies the grants and RLS on every
  start. A process that could rewrite history refuses to serve.

A correction is a **new event**. There is no other kind.

## 6 · The vocabulary

Owned per lane. Reading is unrestricted — the lane says who is expected to *write* it.
The authoritative list is `EVENT_VERBS`; this table is its rendering.

### Platform — tenancy + party (built, and wired)

| Verb | Object | Means |
|---|---|---|
| `tenant.created` | tenant | A firm was registered as a tenant. Payload carries `slug` and `reportingCurrency` — the currency its books are kept in, recorded here because it is the one money fact that can never be restated later. |
| `tenant.suspended` | tenant | A firm was suspended by the PLATFORM. Every session pointed at it loses its tenant context on its next request, because the session resolver reads `tenant.status` on every one. Not a firm's own act: the route is `PUT /internal/v1/tenants/{tenantId}/status`. |
| `tenant.reinstated` | tenant | A suspended firm was let back in. Sessions that outlived the suspension resume on their next request. |
| `membership.granted` | membership | A user was given a role in a tenant, for one audience. |
| `membership.revoked` | membership | A membership was deactivated. The person's next request stops — the session resolver re-reads this every time. |
| `membership.restored` | membership | A deactivated membership was reinstated. |
| `membership.role_changed` | membership | A member's role changed, and with it everything gate 3 lets them do. |
| `membership.grade_changed` | membership | A member's SENIORITY changed — a different axis from role. It decides who may sign off another person's work, so who moved whom, and when, is exactly what gets asked about later. |
| `membership.reports_to_changed` | membership | Who a member reports to changed (T2.9). Read by one thing — a `reporting_line` verification policy deciding who may check their work. The column is deliberately NOT effective-dated (nothing records when a reporting line started), so this trail is where "who was my manager in March" is asked. |
| `staff_grade.created` | staff_grade | A firm added a rung to its own hierarchy — one its starting ladder did not have. |
| `staff_grade.updated` | staff_grade | A rung was renamed, re-ranked, or stopped/resumed being promoted through. The payload carries both sides of whatever changed. Never a delete: a rung somebody held is part of why they could approve something. |
| `service_axis.created` | service_axis | A firm added a Dept or a delivery team to its own structure. |
| `service_axis.updated` | service_axis | A Dept or delivery team was renamed or reordered. The payload names the CODE and says which of the two changed — the code is what every service body joins on and it never moves. The display NAME is not in the payload: it is a label a person wrote, and the row keeps it where it can be corrected. |
| `service_axis.retired` | service_axis | A firm stopped filing new work under a Dept or delivery team. NOT a delete: services already naming it keep it and still read. |
| `service_axis.reactivated` | service_axis | A retired Dept or delivery team was brought back into use. |
| `work_split_axis.changed` | tenant | A firm changed how one client's work is cut into separate jobs — by Dept, by delivery team, or not at all. The payload carries BOTH sides, because "what did it used to be" is the question asked when a job looks split the wrong way. |
| `tenant.time_zone_changed` | tenant | A firm changed which calendar its months and days are cut on — the client month view and the chaser's day arithmetic. The payload carries BOTH sides, because "why did that filing move month" is asked afterwards and the old value is the answer. It is a DISPLAY-boundary change and nothing stored moves, which is why the event is the only record that it happened. |
| `grade_ladder.seeded` | tenant | A new tenant's seniority ladder was initialised from the product defaults. One event, not one per rung. |
| `firm_signatory.set` | tenant | The firm named who binds it — the person and the capacity printed under "Yours sincerely" on every letter it sends from now on. Authority to bind is an audit question and a DIFFERENT fact from who operated the system, which is this event's actor. |
| `firm_entity_preference.set` | firm_entity_preference | The firm said which of its OWN entities issues documents to clients in a country — or set the fallback that answers for every country it has no entity in. A commercial and legal decision (it settles governing law, courts and who the client's counterparty is), so who made it is the point of the record. |
| `territory_rule.set` | territory_rule | The firm said whose desk covers leads from a country — or moved one. It decides who a new opportunity lands on before anybody has looked at it, so who drew the line and when is the record. The NOTE is not in the payload: it is prose a person wrote, and this log cannot be erased. |
| `standard_document_block.set` | standard_document_block | The firm changed its STANDARD prose — an exclusion, a commercial note, a line of the team block — or retired one. It is logged because the standard set is what every document written from here on will say, and 'why does this letter carry this exclusion' is answered by who changed it and when. The BODY is not in the payload: it is prose a person wrote, this log cannot be erased, and the row keeps it where it can be. |
| `session.started` | user_account | A user's session became active in THIS tenant — at login, or via the org switcher. |
| `party.created` | party | An organization or person party was created. |
| `party.archived` | party | A party was put away — hidden from pickers and lists. NOT a delete: parties are permanent, the row still resolves by id forever, and every document pointing at it still renders. Refused while a lead, proposal, engagement letter, letter line or engagement still points at it (migration 0035) — a DELETED lead, proposal or letter does not count (0086). |
| `party.unarchived` | party | An archived party was brought back into the pickers and lists. |
| `firm_entity.edited` | party | One of the firm's OWN companies had its name, entity type or registered address changed (T6.18). Payload: `fields` (which of `name`, `entityType`, `registeredAddress` changed) — never the name or the address, which the row keeps. |
| `legal_entity.registered` | legal_entity | An organization was registered in a jurisdiction. |
| `party_identifier.added` | party_identifier | A PAN / GSTIN / handle was attached to a party. |
| `party_relationship.recorded` | party_relationship | An effective-dated relationship was recorded. |
| `party_relationship.ended` | party_relationship | A relationship was closed with a valid_to date. |
| `client_assignment.created` | client_assignment | Somebody at the firm was put in charge of a client — the Key Manager, or a SPOC for one Dept or delivery team. A key-manager handover carries `handedOverFrom`. |
| `client_assignment.ended` | client_assignment | An assignment was closed — somebody stopped holding a client with nobody named in their place. NOT a delete. |
| `client_import.staged` | client_import | A spreadsheet of the firm's existing clients was uploaded, checked against what the firm already has, and STAGED with its report. Nothing else was written. Payload: row and finding COUNTS — the sheet carries names, emails and registration numbers, and this log cannot be erased. |
| `client_import.confirmed` | client_import | A staged import was loaded through the ordinary party, assignment and engagement services, so every client, letter and assignment it created has its own event. Payload: created, skipped and failed, by count. |
| `portal_access.granted` | portal_access | A client-portal login was allowed to read one client's records. ONE CLIENT PER EVENT — a contact who may see four companies has four grants and four of these. Never derived from a group relationship. |
| `portal_access.ended` | portal_access | A portal login stopped being able to read a client's records. NOT a delete: the payload carries the FIRST DAY NOT IN FORCE. |
| `portal_invitation.resent` | membership | A client contact's portal invitation was sent again — SAME person, SAME address, which is the only shape that route has. Recorded because it is the one act here that mails a credential to somebody outside the firm on a staff member's say-so, and the question asked afterwards is who kept sending it. Payload: `supersededLinks`, how many still-live invitations this one spent. No email — that is personal data (3.4) and is also the fact the route cannot change. |

> **`membership.revoked` was registered from the first draft of this contract and written by
> nothing for six tasks.** The vocabulary was agreed before the capability existed, and a verb
> that nothing emits is easy to mistake for a feature that works. It is written now, by
> `TenancyService.setMemberActive`. If you add a verb here for something not yet built, say so
> in its description — the registry is a promise about what the log contains.

### Platform — the configuration registry (P2 / T2.5, built and wired)

Configuration decides what everyone else may do, so who changed it, when, and to which
version is exactly what gets asked about afterwards.

| Verb | Object | Means |
|---|---|---|
| `config_entry.created` | config_entry | A configured thing (a service, a role) was defined, with its first draft. |
| `config_version.published` | config_version | A version took effect and froze. Anything pinned to the version it replaced still reads that one. |
| `config_version.archived` | config_version | A version stopped being what is in force. It stays readable — pins resolve to it forever. |
| `config_registry.seeded` | tenant | A new tenant's registry was initialised from the product defaults, inside `createTenant`. |

> **Drafts are not recorded, and seeding is one event.** A draft changes nothing about what
> the firm does, and this log holds what took *effect* — `config_version.published` is where
> that happens and it names whoever made it real. Seeding writes four roles and records one
> event for the lot: eight rows in a new firm's timeline for a single fact would bury the
> events a person actually caused.

### Commercial lane (A) — sell → bill → collect

| Verb | Object | Means |
|---|---|---|
| `lead.captured` | lead | A lead entered the pipeline. |
| `lead.merged` | lead | A duplicate capture landed on an existing open lead instead of starting a rival one. Payload carries `titleDiscarded` — WHETHER the capture's title was dropped, never the title itself, which names the counterparty and is sometimes a person's name (§3.4). The words go back to the caller on the response (`discardedTitle`) and are stored nowhere. |
| `lead.stage_changed` | lead | A lead moved through the pipeline. Reaching a terminal stage closes it. |
| `lead.owner_assigned` | lead | A lead was put on somebody's desk, or taken off it. |
| `lead.details_changed` | lead | Where the prospect is (`jurisdictionFrom`/`jurisdictionTo`) or what the opportunity could be worth (`estimatedValueFrom`/`estimatedValueTo`, decimal strings, in `currency`) was set or corrected. Recorded only when one of them actually changed. Neither is personal data: a country code and an amount name nobody. It does NOT re-run assignment — moving a live lead is `lead.owner_assigned`, a person's act. |
| `lead.deleted` | lead | A lead entered by mistake was deleted (0086): out of the pipeline, its lists and every count, still readable by id, and final. NOT an outcome — `lost` and `abandoned` are what happened to a real prospect; this says there was none, which is why the conversion rate is better for it rather than worse. Refused once converted, and while a live proposal was drafted from it (a trigger, as well as the service); a lead already closed as lost or abandoned is deleted by an administrator only, because it changes the pipeline's numbers. Payload: `partyId` and the `stage` it had reached — never the title, which names the counterparty (§3.4). |
| `proposal.drafted` | proposal | A proposal was drafted for a party — the first row in its own timeline, and the only record of what was quoted before it went out. |
| `proposal.deleted` | proposal | A DRAFT made by mistake was deleted before it went out (0086): off the list of quotes, still readable by id, and final. Its reference is not reused — a proposal reference may gap, and a deleted draft is one honest reason why. Refused once sent, and while a live engagement letter cites it. Payload: `ref` and `partyId` — never the title. |
| `proposal.discount_approved` | proposal | A discount past the firm's published limit was signed off by somebody holding `proposal:approve`. The whole value of the record is WHO. |
| `proposal.issuer_changed` | proposal | A DRAFT was moved to another of the firm's own companies (T6.18): who would contract with the client changed before anything went out, and its prose was replaced with that company's standard set (D9). Payload: `fromIssuingEntityPartyId`, `toIssuingEntityPartyId`, `proseReplaced`, `editedLinesReplaced`. |
| `proposal.currency_changed` | proposal | A DRAFT's currency, or its rate back to the firm's reporting currency, changed (T6.18) — the currency only while the draft quoted nothing. Payload: `fromCurrency`, `toCurrency`, `fromFxRate`, `toFxRate`, `fxRateDate`. |
| `proposal.discount_approval_lapsed` | proposal | A draft's discount sign-off stopped covering it (T6.18): a line's discount was RAISED, or a line added, past the firm's limit after the approval was given, so the draft needs signing off again before it can be sent. Payload: `previouslyApprovedByUserId`, `lineId`, `discountPercent`, `limitPercent`. |
| `proposal.sent` | proposal | A proposal was sent to a prospect. |
| `proposal.emailed` | proposal | bib emailed a sent proposal to the client — the PDF of record attached, with Accept and Decline buttons that open its link (0085). Recorded once the mail server took it. Payload: `partyId`, `emailId`, `pdfContentHash`, `noteWritten` — never the address, which is personal and lives in the erasable `crm.proposal_email` row. |
| `proposal.link_reissued` | proposal | A sent proposal was given a NEW link and the old one stopped working (0085). Payload: `partyId`, and `emailed` — whether bib emailed the new one. |
| `proposal.viewed` | proposal | The recipient opened it from its share link. Recorded ONCE, on the first open; the running count lives on `crm.proposal.view_count`, because a client refreshing a page is not fifty facts about the business. The actor is `system` — the recipient has no account, and inventing a user id for somebody who has never logged in would be worse than saying plainly that a link was opened. |
| `proposal.accepted` | proposal | Accepted. Recorded by a colleague — or, with `via: "share_link"` in the payload and `system` as the actor, by the client on the link's page (0085); that payload also carries `emailId` (null when the link was not one bib emailed) and `pdfContentHash`. The name, statement, address and browser are in the erasable `crm.proposal_client_decision` row, never here. |
| `proposal.rejected` | proposal | A proposal was declined by the recipient. `via: "share_link"` marks one the client gave on the link's page (0085), as on an acceptance. |
| `proposal.expired` | proposal | A proposal passed its validity date. Written LAZILY — nothing here runs on a timer, so it is recorded the first time somebody tries to act on the proposal. |
| `engagement_letter.drafted` | engagement_letter | An engagement letter was drafted — the first row in the timeline of a document that will create obligations. |
| `engagement_letter.drafted_from_proposal` | engagement_letter | A letter was written up FROM an accepted quote (T3.5b), carrying its lines, prices, discounts and scope overrides across. Recorded BESIDE `drafted`, not instead of it — the draft is the same act either way, and this is the extra fact. Payload: `proposalId`, `linesCopied`, `linesSkipped`, and whether a person had to state the country or name a fallback company. Counts only: what would say WHICH lines were dropped is the client's own wording. |
| `engagement_letter.sent` | engagement_letter | It went to the client for signature. |
| `engagement_letter.signature_requested` | engagement_letter | An e-signature provider accepted an envelope for a SENT letter and asked the client to sign (0080). Payload: `provider`, `envelopeId`. Never the signer's name or address — they live in `crm.letter_signature_request`, which can be erased. A letter withdrawn because the client declined or the envelope was voided carries `signatureOutcome` on `engagement_letter.withdrawn`. |
| `engagement_letter.withdrawn` | engagement_letter | Pulled before signature. A SIGNED letter is never withdrawn — it is superseded by a new one. |
| `engagement_letter.deleted` | engagement_letter | A DRAFT letter made by mistake was deleted before it went out for signature (0086): off the list of letters, still readable by id, and final. Not `withdrawn`, which is a letter the client has seen and the firm pulled. Payload: `ref` and `partyId`. |
| `engagement_letter.signed` | engagement_letter | The client signed. The letter freezes at this moment (a trigger, 0017) and one engagement is created per line. Payload carries the signature METHOD and the content hash, never the signer's name — that is personal data and lives in the erasable row. |
| `engagement_letter.advance_recorded` | engagement_letter | The advance fee was recorded as received, releasing every engagement the letter created. Recorded by a person until payments (T3.5) can confirm it. |
| `contract.activated` | engagement | An engagement became active and work may begin. **The spawn trigger the scheduler consumes (T2.4)** — written by T2.3, which is the module that causes it. Held back until the advance is recorded when the letter requires one. |
| `invoice.raised` | invoice | An invoice was created and its number ALLOCATED from the entity's gapless series. Registered because the allocation is the audit-relevant moment, not the sending: a consecutive series is evidence, and 'which number went to which client, when, decided by whom' is the question an auditor asks about a gap. The number is in the payload for the same reason. |
| `invoice.issued` | invoice | An invoice was issued and its number frozen. |
| `invoice.cancelled` | invoice | Cancelled by credit note; the number is never reused. |
| `payment.recorded` | payment | A payment was received and applied. |
| `credit_note.issued` | credit_note | Issued against an invoice. |
| `invoice.registered` | invoice | The government e-invoice registry's identifier (IRN) was recorded against an invoice. Its honest limit: nothing in this product talks to the IRP, so this records an answer obtained elsewhere — the same shape as the advance-fee attestation. The real connector is T7.1. |
| `invoice_series.set` | invoice_series | The firm named what one of its entities' invoice numbers READ as. It changes future numbers only — every issued invoice keeps the number it was issued with, because the freeze trigger refuses to move one. |
| `dunning.decided` | invoice | A partner approved or rejected a TERMINAL dunning step — credit hold or legal action. Both outcomes are recorded: 'we considered legal action and decided against it' is a fact somebody wants three months later, and a rejection that vanished would leave the ladder looking as though it never got there. objectType is the invoice, because 'what happened to this receivable' is the timeline anybody reads. |
| `dunning.escalated` | invoice | A receivable moved up the ladder. |
| `document.stored` | document | Bytes were stored — a new document, or a further version of one. The payload carries `kind`, `origin`, `versionNo`, `contentHash`, `byteSize` and `mediaType`, and **never the filename or the title**: both routinely name a client (`Kaveri Foods PAN.pdf`), and this log is append-only and has to stay erasable by row. `origin` (`generated` \| `uploaded`) is the load-bearing field — it says whether the product made the file and could make it again, or whether a person supplied the only copy that exists. |
| `document.client_visibility_set` | document | The firm shared one of a client's own documents with them through the portal, or stopped sharing it (T6.7). **Its own verb, not a flavour of `document.attached`** — this is a DISCLOSURE decision, and "when did this become visible to the client" is the question asked after something reached somebody it should not have. Payload carries the flag, the party and the kind; never the title or filename, which routinely name a client's own affairs. |
| `document.attached` | document | A document version was linked to an object. |
| `document.link_withdrawn` | document | A document was taken OFF something it was attached to (0302, decided 2026-09-25). Withdrawn, never deleted: the link row stays, marked with when and by whom, so "what was filed against this engagement" can still say "this, in error, for a fortnight". Payload carries `subjectKind`, `subjectRef` and the link's `role`; never the title or filename. |
| `brand_asset.set` | brand_asset | A logo, signature or letterhead was put in force for one of the firm's OWN entities. Keyed on the entity rather than the firm, because a firm signing on two letterheads is G1.2's rule applied to paper — a letter issued by the US entity printing the Indian logo is the same class of error as one printing Indian governing law (G1.8). Superseding is an insert plus a cleared flag, never an edit, so the mark in force when a document was issued stays resolvable. |

> **The lead's timeline IS this table.** T2.1 ships no timeline of its own: capture, merge,
> stage moves and reassignment all write against the lead's id, so
> `GET /api/v1/objects/lead/{id}/events` is its history — already immutable, already
> tenant-scoped, already free of personal data. A second table would have had to be kept in
> step with this one, and the day they disagreed nobody would know which was right.
>
> Note what those payloads carry: `identifierType`, never the identifier. An email address or
> a PAN is how a prospect is *reached*, it is personal data, and this log cannot be erased.

### Delivery lane (B) — configure → schedule → execute → verify

| Verb | Object | Means |
|---|---|---|
| `workflow_template.published` | workflow_template | A template version was published; running jobs pin their version. **Predates the registry** — when workflow templates become a config *kind* (T2.7), publishing one will already record `config_version.published`, and T2.7 decides whether this verb survives. |
| `rule_pack.activated` | rule_pack | A rule-pack version became active. Never written by an agent (A10). |
| `job.spawned` | job | The scheduler created a job from a trigger or a recurrence. The payload names every engagement in it and how it was cut (`splitAxis`, `splitCode`), because a merged job's cause is several engagements and its `source_ref` is a derived group key naming no row in any table. An `engagement_period` job (T6.13) also carries `periodStart`, `periodEnd` and `periodLabel` — which month or quarter the checklist is for — and is written once per period for as long as the engagement is active. |
| `job.scope_extended` | job | Work joined a job that was ALREADY OPEN — the second line of an engagement letter, whose advance arrived after the first. Its own verb rather than a second `job.spawned`, because "why did this job gain a service on the 14th" is a question somebody asks and a spawn event cannot answer it. The payload carries only the engagements that actually joined. |
| `job.template_pinned` | job | A job resolved the firm's published process and PINNED the version it will walk. Everything the job does afterwards is explained by this row: editing the process later never moves a job already walking it. |
| `job.started` | job | A job's steps were written from its pinned template and the work began. One event, not one per step. |
| `job.step_advanced` | job | A job's step moved — set aside for a person, taken by an agent, or finished. The payload carries both sides and who was expected to do it. When the step has sub-steps (T6.15) and it is finished or sent for checking, `subSteps: { total, done, notApplicable }`: counts only, never a line's label or a "not applicable" reason, read after the move so they are the list that was submitted. There is no event per tick; the row says who and when. A machine's COMMITTED answer on a step that names a check is sent for checking too (`from: running`, `to: blocked`, `awaitingCheck`), with no maker: 0048's unattended case. |
| `job.step_assigned` | job | A job's step was put on somebody's desk or taken off it (0301). `how`: `spoc`, `key_manager` or `partner` (the router at job start, naming the rung of the owner rule that chose, 2026-09-27), `taken`, `handover`, `released`, or `with_task` (the job's task was handed on and this unheld step went with it). User ids only. |
| `job.step_skipped` | job | A step will not happen: its condition did not hold (at the start, or after it had opened and before any work was recorded on it: `afterStart`, `from`, `assigneeUserId`, 0304), or something it depends on was skipped. NOT the same as done, and recorded as loudly. The payload carries the FACT and its values, never the prose note — a sentence does not GROUP BY, and this log cannot be erased. |
| `job.step_failed` | job | An agent could not complete a step. Terminal for the step; the job blocks. |
| `job.completed` | job | A job reached a terminal step. |
| `work_item.created` | work_item | Work landed on the board — spawned from an engagement, or raised by hand. `origin` says which, because "where did this task come from" is the first question asked about one nobody recognises. The TITLE is not in the payload: it is a service name today and prose the moment somebody edits it, and it routinely names a client. |
| `work_item.assigned` | work_item | Routed to a person, or taken off their desk. `how` distinguishes the ROUTER's answer from a human override (`manual`), and since 2026-09-27 which rung of the owner rule the router used: `spoc` (the client's Dept SPOC, G3.2), `key_manager` (no SPOC: the client's Key Manager, to hand out) or `partner` (no Key Manager either: the person who signs for the firm). Different answers to the same later question, and nothing else in the row tells them apart. **`catchUp: true` and `fromUserId`** (2026-09-27) mark the router deciding AGAIN because the client's account team was named after the task was created: the task was waiting on a fallback desk (or on nobody's, `fromUserId: null`) and moved to the rung's answer. `how` still names the rung; the actor is whoever named the team. |
| `work_item.updated` | work_item | A due date, priority or client-visibility edit, with both sides of each change. A MOVED DUE DATE is what answers "why was this late" — a payload saying only that something was edited could not. Title and description are prose about a client's work and stay off this log: THAT they changed is recorded, what they changed to is not. |
| `work_item.state_changed` | work_item | Moved between the firm's own states (T3.1 makes those ROWS, not an enum). Carries both state ids and the two FLAGS that changed what the row must hold — `isBlocked`, `isTerminal` — rather than the names, which are the firm's to rename. The block REASON is deliberately absent: prose a person wrote, routinely naming a colleague or a client, in a log that cannot be erased. |
| `work_item.completed` | work_item | Reached a state the firm has marked TERMINAL. Its own verb beside `state_changed`, because "what did we finish last month" cannot be answered from a generic move without knowing which states were terminal at the time. |
| `work_item.escalated` | work_item | A rung of the firm's escalation ladder was climbed on a task (T4.5): it is past the SLA it was created with, or nobody has picked it up. Payload carries `rungKey`, `watch`, `afterDays`, `daysPast` and `landedOn` — a person, a grade rank, or NOBODY with the product's own sentence saying why. That note is about this system's routing and never about a colleague, which is what makes it safe in a log that cannot be erased. Per notice, never per sweep. |
| `work_item.dependency_added` | work_item | One work item was made to wait on another. objectType is the WAITING item — that is whose timeline the delay belongs on. |
| `work_item.dependency_removed` | work_item | A dependency was lifted. The row is deleted and carries no history of its own, so this event is the only record that somebody removed the thing holding work back. |
| `work_item.review_requested` | work_item_approval | A work item was sent to be checked. Carries the PINNED policy version, so a firm raising its bar in April never restates what was allowed in March, and `hasMaker` — whether there is anybody for maker != checker to bite on at all. |
| `work_item.review_approved` | work_item_approval | A checker approved a work item. Never the person who did it — a CHECK constraint, not a UI rule. The note stays on the row. |
| `work_item.review_rejected` | work_item_approval | Sent back. Recorded as loudly as an approval: marking the task Completed later erases the fact that it was rejected at all, and how often work comes back is the only honest measure of whether the process works. |
| `work_item_state.created` | work_item_state | A firm added a state to its own work vocabulary. Logged because the FLAGS on it — starting, terminal, blocked — decide what every work item in that state must carry. |
| `work_item_state.updated` | work_item_state | Renamed, re-flagged, reordered or retired. Both sides of whatever changed: "it stopped being terminal on the 4th" is what explains a board that suddenly reads differently. Never a delete. |
| `work_item_priority.created` | work_item_priority | A firm added a priority to its own work vocabulary. |
| `work_item_priority.updated` | work_item_priority | Renamed, re-ranked, or made the default for ordinary or for STATUTORY work. The statutory default is the firm's rule "statutory due dates are high priority anyway" made mechanical, so moving it changes the urgency of every filing created afterwards. |
| `work_vocabulary.seeded` | tenant | A new tenant's work-item states and priorities were initialised from the product defaults. One event, not twelve. The names are the previous vendor's and are unconfirmed — which costs nothing, because they are rows. |
| `obligation_rule.created` | obligation_template | A compliance rule was written — what the law asks of an entity, and when (T3.2). Written in the catalogue FOR a service (T6.16), it also carries `services` and `spawned` (or `calendarFilled: false` and no count, when filling the calendar failed after the rule and its links were written; both events are recorded either way); each service then gets its own `obligation_rule.linked` with `onCreate: true`. |
| `obligation_rule.updated` | obligation_template | A rule was edited, confirmed against the statute, or retired. `status` → confirmed is a partner taking responsibility for a date. |
| `obligation_rule.exception_added` | obligation_template | A rule gained an exception for one period — March TDS due 30 April. The NOTE stays on the row; only the month and the replacement rule travel here. |
| `obligation_rule.exception_removed` | obligation_template | An exception was withdrawn, so the rule's own formula governs that period again. |
| `obligation_rule.superseded` | obligation_template | The LAW changed from a day, so a rule handed over to a successor. Not an edit and not a retirement: the predecessor goes on governing every period before the cutover, and the unstarted filings already on the calendar from the cutover on move to the successor (0303). Payload carries the cutover, both rule packs, both formulas, and counts: `handedOver`, `restated`, `kept`. |
| `obligation_rule.linked` | obligation_template | A compliance filing was added to a catalogue service (T6.16, 0309), so that service's clients owe it. The object is the rule's CHAIN (the first rule's id): a link is on the chain, so it survives the law changing. Payload: `lineageId`, `ruleId` (the rule in force), `serviceEntryId`, `serviceKey`, `serviceName` (the service's name at the write: the published version's, else the newest version's, the same name `usedIn` shows; null for a service with no version; a business fact like the rule's `name`, not personal data; absent on events written before 2026-09-26, so a reader falls back to `serviceKey`), `name`, `confirmed` (adding it confirmed an unconfirmed rule in the same act), and counts `spawned` / `restored`, which are THIS service's clients' filings only (the chain is filled whole, and rows landing on another service's engagements are not this link's). Recorded even when filling the calendar fails after the link was written: then it carries `calendarFilled: false` and no counts, because nobody knows how much was written, and the next sweep fills it. Linked in the same act as writing the rule, it carries `onCreate: true` and the counts are on `obligation_rule.created`. |
| `obligation_rule.unlinked` | obligation_template | A compliance filing was removed from a catalogue service (T6.16). That service's untouched, upcoming filings for clients no other linked service still covers are WITHDRAWN: kept on their rows and marked, never deleted. Payload: `lineageId`, `ruleId`, `serviceEntryId`, `serviceKey`, `serviceName` (as on `obligation_rule.linked`: named at the write, absent before 2026-09-26), `name`, and counts `withdrawn`, `kept`, `keptStarted`, `keptPastDue`, `keptCoveredElsewhere`, `repointed`. Counts, not a verb per row: the handover and a restate already work that way, and which filings came off is on each row (`withdrawn_at` / `withdrawn_by_user_id` / `withdrawn_reason`). |
| `obligation_rules.seeded` | tenant | A firm was given the shipped India rule pack. Payload counts what generates and what is waiting on a fact the firm has not given. |
| `obligation_vocabulary.seeded` | tenant | A new tenant's obligation states and resolution options were initialised from the product defaults. One event, not nine. |
| `obligation_state.created` | obligation_state | A firm added a state to its compliance vocabulary. The FLAGS are mechanism, not appearance: which state a generated filing starts in, where a finished one lands, where a passed deadline goes. |
| `obligation_state.updated` | obligation_state | Renamed, re-flagged, reordered or retired. Both sides of whatever changed — "it stopped being the missed state on the 4th" is the only thing that explains a decision queue which silently stopped filling. Never a delete. |
| `obligation_resolution_option.created` | obligation_resolution_option | A firm added an answer to its list of what may be decided about a passed deadline. Carries `closesWithoutFiling`, the fork between filing late and never filing. |
| `obligation_resolution_option.updated` | obligation_resolution_option | Renamed, re-pointed, confirmed, reordered or retired. Confirming matters on its own: the four shipped options came from a previous vendor's app and seed `unconfirmed`. |
| `obligation.spawned` | obligation_instance | An obligation instance was created for a period. Per instance, never per sweep. |
| `obligation.restored` | obligation_instance | A withdrawn filing came back because a linked service proposed its period again (T6.16). Written by the GENERATOR per row, like `obligation.spawned`: same row, same id, re-dated by `scheduleFor`. Carries `withdrawnAt`, the instant it had been taken off, because restoring clears that column. |
| `obligation.work_raised` | obligation_instance | An obligation reached T–X and became a task. The one place the calendar and the work board join. |
| `obligation.filed` | obligation_instance | Discharged (filed / paid / submitted). Written when the work item raised for it reaches a state flagged terminal **and** successful — a cancelled task is not a filing. |
| `obligation.filing_reversed` | obligation_instance | A recorded filing was taken back, because its work item was reopened or cancelled. |
| `obligation.missed` | obligation_instance | A statutory date passed undischarged and the sweep moved it to the firm's `is_missed` state. A state, not an error (T3.3). Per instance, never per sweep. |
| `obligation.resolved` | obligation_instance | A partner decided what happens about a deadline already missed. Payload carries the OPTION and `closesWithoutFiling`, never the free-text reason — that is a partner's words about a client, may name a person, and lives in the erasable row (§3.4). |
| `obligation.escalated` | obligation_instance | A filing passed the firm's OWN internal target (T-X) with the statutory date still ahead, and the ladder told somebody (T4.5). Deliberately NOT `obligation.missed`, which is the statutory date going by and the client's money already gone — this is the warning that exists so that never happens. Same payload shape as `work_item.escalated`. |
| `obligation.nudged` | obligation_instance | The firm told a client one of their filings is coming up (T6.7) — a rung of the PROACTIVE ladder, counting DOWN to the statutory date. **Per RUNG and only when the row was created**, like `client_ask.chased`. Deliberately not that verb: a chase is about something the firm ASKED FOR and has not had back, a nudge asks for nothing and names a date the LAW set — and a client freeze stops the one and not the other (0067). Actor is the SYSTEM. Payload carries the rung key, its threshold, days left and the date named; never the template name, which is prose about a client's affairs. |
| `client_ask.raised` | client_ask | The firm asked one of a client's own people for something, on a named task (T6.6). Payload carries `askKind` and the work item, NEVER the prompt — that is prose about a client's business and this log cannot be erased. |
| `client_ask.answered` | client_ask | A client's contact responded. **Per RESPONSE, not per ask**: "the wrong register on the 3rd, the right one on the 9th" is two facts. Carries the response kind and, for a decision, which way it went; never the client's words. **The actor is routinely somebody OUTSIDE the firm** — the first verb here for which that is true. |
| `client_ask.closed` | client_ask | The firm accepted what came back. Separate from `answered` on purpose: a client responding does not close an ask, the firm does. |
| `client_ask.withdrawn` | client_ask | The firm no longer needs it. Different from `closed` — "you sent it" and "never mind" are different answers to a client asking whether they had to. |
| `client_ask.chased` | client_ask | A rung of the OUTWARD ladder was climbed on an unanswered ask (T4.4). **Per RUNG and only when the row was created**, so "we reminded you four times" is supported by the count. Actor is the SYSTEM — a cron sent it, not a person. |
| `client_request.raised` | client_request | A client asked the FIRM for something, unprompted (T6.8). The first verb here whose human actor is outside the firm and is **starting** something rather than answering one of its asks. Its own object because a client's request hangs off nothing — no work item, and maybe never one, which is why it is not a `client_ask` reversed (0068). Payload carries the company only: **neither the subject nor the body**, both of which are the client's own words about their own affairs. |
| `client_request.replied` | client_request | Somebody added to the thread. **Per REPLY and by BOTH SIDES**, with `authorSide` saying which — one verb, because "who said what, when" on one request is one sequence. `documentAttached` records that the firm sent a file back; the filename is not here and neither side's words are. Attaching also flips `files.document.is_client_visible` in the same transaction (0066, 0068). |
| `client_request.assigned` | client_request | A client's request was put on somebody's desk (0070). **`by` says whether a PERSON or the RULE decided** — the only way to answer "is this routing rule finding anybody" later. **Per PLACEMENT**, including the rule's own at the moment a request arrives. When the rule places it the actor is the CLIENT CONTACT whose request caused it: naming the assignee would credit them with a decision they did not take. Taking a request OFF a desk is this verb with a null assignee. |
| `client_request.routing_set` | tenant | The firm changed how an arriving request is routed — `none` or `key_manager` (0070). **The object is the FIRM**, like the work-split setting. It restates nothing: requests already on a desk keep their assignee, so this event is the only record that the rule changed under work in flight. |
| `client_request.closed` | client_request | **The firm** is done with a client's request. Separate from `withdrawn` because the two endings belong to opposite sides of the wall — which is why 0068 names the columns `settled_by`/`settled_at`. The firm replying does not close one. Payload carries the reply count. |
| `client_request.withdrawn` | client_request | **The client** no longer wants it. Never written by the firm: "we decided you did not need this" is a refusal, and a refusal is a `closed` with a reply saying so. |
| `client_freeze.set` | client_freeze | A partner stopped the chaser on one client. **The reason is NOT in the payload** — a partner's words about a client, in a log that cannot be erased; it lives on the row (§3.4), the same split `obligation.resolved` makes. |
| `client_freeze.lifted` | client_freeze | Chasing resumed. Not a delete — the row stays, and the payload carries the FIRST DAY NOT IN FORCE. |
| `agent_run.completed` | agent_run | An agent produced an output; confidence in the payload. On a commit, `from`/`to`: `to: done`, or `to: blocked` with `awaitingCheck: true` when the step names a check, because a committed answer is still checked. |
| `agent_run.escalated` | agent_run | An agent refused to act and handed the work to a human. Its output is KEPT and offered as material rather than as an answer — throwing away a usable draft every time the machine is unsure is how a firm ends up redoing the work by hand anyway. |
| `agent_run.decided` | agent_run | A person accepted, corrected or rejected what a machine proposed. The payload carries WHICH of the three and never the values: accepted-vs-corrected is the entire accuracy signal and belongs in the log, while an agent's output can hold a client's own data, which may not enter a log that cannot be erased. |
| `output.approved` | verification | A checker approved an output. Never the actor that produced it. When the step has review points (T6.15), `reviewPoints: { total, done, notApplicable }` for THIS check: counts only. |
| `output.rejected` | verification | Sent back. Carries `reviewPoints` counts as `output.approved` does, because "sent back with two of six points ticked" is worth a GROUP BY; which two is prose that stays on the rows. |

> **One rename from the build plan.** T2.4 describes its trigger as a `contract.active`
> event. Registered here as **`contract.activated`** — every verb is past tense, and a
> vocabulary with one exception is a vocabulary people stop trusting. Same event, same
> role; T2.4's acceptance is unchanged.

## 7 · Reading events

Two questions, two routes (read-only — see below):

```
GET /api/v1/events?limit=50
GET /api/v1/objects/{objectType}/{objectId}/events
```

These moved off `/internal` when real sessions landed (T1.7): the tenant comes from the
session, so a caller can no longer name the firm whose audit trail they would like to read.
Both require `ledger:read`, which is a partner-and-manager permission — the firm's whole
trail names every client it has.

There is **no POST**. Events are written by the service that causes them, naming its own
actor. An endpoint that let a caller post an arbitrary event would make the audit trail
unfalsifiable in precisely the way an audit trail must not be.

## 8 · Adding a verb

1. Add the entry to `EVENT_VERBS` in `src/domain/ledger/model.ts` — verb, object type,
   lane, one-line description.
2. Add the row to §6 above.
3. `npm run check`. The registry's own test asserts the naming convention.

No migration. The vocabulary is code precisely so that it is reviewed like code — a lookup
table would let a typo become a permanent new verb at runtime.
