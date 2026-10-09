# Ledger and records

Scope: the audit ledger, read models (names not ids), the no-hard-delete rule and its exceptions, and deleting a mistake (0086). Parties and archiving are in `clients-and-import.md`.

## The audit ledger

- Every state transition writes an event. Depend on the **`EventSink`** port (`usecase/ledger/ports.ts`) and call `recordEvent()`; never on `LedgerService` or a ledger adapter. Record the event **after** the change it describes has committed. Contract: `docs/EVENT-CONTRACT.md` (read before the first event).
- The verb comes from the closed registry in `domain/ledger/model.ts`; `object_type` is derived from it. A verb that carries money names its fields in `domain/ledger/fees.ts` (`tests/ledger/fees.test.ts`).
- The payload holds ids, codes, counts and machine facts, **no personal data** (refused at the write; the log cannot be erased). Names, notes, reasons and titles stay on the erasable row.
- **The actor's NAME is a read-time join, never stored.** The row keeps only `actor_id`. `EventRecord` carries the account as it stands now; an erased account stops resolving and the event survives. The join is a LEFT join: `actor: null` is a real answer (system and agent actors have no account). The smoke check greps the stored `event` half of each record, not the whole response; grepping both would call the join a leak.
- Append-only is a GRANT, not a trigger: REVOKE before GRANT (default privileges give `bib_app` UPDATE on new tables). Check with `has_table_privilege`.

## Read models, not aggregates

An aggregate carries ids (`partyId`, `ownerUserId`); a list that must SHOW them returns a joined read model (`MemberRecord`, `LeadRecord`, `ProposalRecord`, Party 360 relationships). Five modules shipped before anything rendered them and every list showed uuids. Rules, all test-enforced:

- **A read model carries names, not just ids.** If a screen would fetch per row, the join belongs in the query. (Learnt five times.)
- **A write with no read is not a stored fact.** `registerLegalEntity` wrote a jurisdiction, incorporation date and financial-year end no route could return; the 360 read omitted the organization/person subtype. Found by building the screen. When you add a write, name the read that proves it.
- **Handlers map field by field; never forward a domain object.** `role` and `commercialVisibility` were on the wire for six tasks while `/auth/me`'s schema documented four fields: zod-openapi documents a response without validating it, so an unmapped field is invisible to the generated client.
- **A caller is told what it may do.** `/auth/me` carries the permissions its role HOLDS (never the vocabulary it does not), so a screen offers only what will work. The same shape recurs per record: `deleteRefusal`, `issueBlocked`, `viewer.mayComplete`.
- Build the screen alongside the module.

## Nothing is hard-deleted

- `bib_app` holds **no DELETE grant on any business table**; removal is impossible at the database level, not merely unimplemented. Nothing in `core` is soft-deleted either.
- Exactly four tables allow DELETE, none a record of the firm's business: checklist lines and task dependencies (0051, no history of their own), dead sessions and sign-in links (0075).
- Soft deletes that exist: `removed_at` on `crm.proposal_line`, `crm.engagement_letter_line`, `crm.document_block`, `crm.engagement_letter_fee_group` (0083; a line struck off a document before it went out); `deleted_at` (+ `deleted_by_user_id`) on `crm.lead`, `crm.proposal`, `crm.engagement_letter` (0086). Both rest on one argument: it was never OFFERED to anybody and nothing rests on it.
- Otherwise: a client is ARCHIVED (G0.3, `clients-and-import.md`); a wrong invoice is CANCELLED (its number is drawn at draft creation from the gapless series, so an invoice is never deleted, T3.4); a reversal is a new signed row.
- Legal-deadline dates are jurisdiction-local, not UTC. PII stays out of any append-only log. Every unique constraint is consciously scoped (say so in the migration comment).

## Deleting a mistake: lead, draft proposal, draft letter (0086)

**Decided 2026-09-27 (user):** something created by mistake can be DELETED while nothing depends on it and it has not left the firm; a deletion HIDES rather than erases ("gone from every list, picker and count; the audit log notes who deleted it"). Every other way out records a business outcome (`lost`, `abandoned`, `rejected`, `expired`, `withdrawn`, `cancelled`); a test lead closed as `lost` is a lost deal that never existed. This is "there was no prospect, there was no offer".

**Two columns, not a status.** A deleted row KEEPS its stage/status (a deletion is not an outcome; no vocabulary gains a value). It:

- **leaves every list and everything that counts one**: pipeline (any stage filter), quotes, letters, rotation desk load (`lead-assignment.ts`), `lead_one_open_per_party` and `findOpenForParty` (a deleted open lead must not merge a new capture into the mistake), `el_one_live_successor_per_letter`, `findSuccessor` and `supersededBy`, and the party archive guard. **A new read of these tables must decide what a deleted row means to it.**
- **still resolves by id** and says so (ledger events keep its id; the page shows who deleted it and when).
- **is FINAL** (like a withdrawn document link, 0302): a trigger refuses any change to a deleted row; services refuse first (`liveLeadOrThrow`, `draftOrThrow`, `editableOrThrow`, `withdraw`, `decide`) checking deletion BEFORE status. **So are its lines, clauses, fee groups and prose (0087)**: `crm.refuse_change_under_deleted_document()` on five child tables checks the old and new parent and raises **55000** (`object_not_in_prerequisite_state`, used nowhere else) so the block adapter says `DOCUMENT_DELETED` rather than the signed freeze's 23001 sentence. There is no Restore; bringing one back is a migration relaxing the guards, on purpose.

**When allowed** (one pure rule per aggregate: `leadDeletionBlock`, `proposalDeletionBlock`, `letterDeletionBlock`; one refusal each; a guard trigger per table for non-service writers):

| | Deletable when | Refused with |
|---|---|---|
| lead | never converted; no LIVE proposal drafted from it; already `lost`/`abandoned` is administrator-only | `LEAD_CONVERTED`, `LEAD_HAS_PROPOSALS` (409), `CLOSED_LEAD_NEEDS_ADMIN` (403) |
| proposal | a `draft`; no LIVE letter cites it | `PROPOSAL_NOT_DELETABLE`, `PROPOSAL_CITED_BY_LETTER` (409) |
| letter | a `draft` | `LETTER_NOT_DELETABLE` (409; a sent letter is WITHDRAWN, a signed one superseded) |

"Live" = not deleted, so deleting in order always works: letter, then the quote it cites, then the lead. The closed-lead rule is about WHO (it changes pipeline numbers), so it is the service's (`AuthzService.can(principal, "tenant:admin")`); the trigger allows the row. A deletion changes nothing else in the same statement (the trigger compares the rest of the row).

- **The page is told first:** `GET /leads/{id}` (own `LeadView`; a pipeline row is never deleted), `GET /proposals/{id}`, `GET /engagement-letters/{id}` carry `deletedBy` and `deleteRefusal` (the code and sentence the DELETE would be refused with, or null).
- **Nothing new may point at a deleted row** (0305's rule from the other side): no proposal from a deleted lead (`LEAD_DELETED`, via the narrow `LeadStanding` port), no letter citing a deleted quote (`QUOTE_DELETED`, checked BEFORE `QUOTE_NOT_ACCEPTED`). Triggers under both, `check_violation`, ids only in the message.
- **Verbs** `lead.deleted`, `proposal.deleted`, `engagement_letter.deleted`; payloads carry party and stage/reference, never a title. Three `DELETE` routes on `party:write` (whoever may make the mistake may take it back).
- **A proposal or letter reference is never reused**; a gap is one honest reason for that.
- **Deliberately not here:** a client or contact made by mistake (ARCHIVED, G0.3), a mistyped identifier (V2.5 / 0315, `clients-and-import.md`), which references count as ONGOING work for the archive guard in general, a catalogue service or config entry nobody used, and Restore.
