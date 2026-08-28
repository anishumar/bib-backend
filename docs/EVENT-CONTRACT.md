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
| `membership.granted` | membership | A user was given a role in a tenant, for one audience. |
| `membership.revoked` | membership | A membership was deactivated. The person's next request stops — the session resolver re-reads this every time. |
| `membership.restored` | membership | A deactivated membership was reinstated. |
| `membership.role_changed` | membership | A member's role changed, and with it everything gate 3 lets them do. |
| `session.started` | user_account | A user's session became active in THIS tenant — at login, or via the org switcher. |
| `party.created` | party | An organization or person party was created. |
| `party.archived` | party | A party was put away — hidden from pickers and lists. NOT a delete: parties are permanent, the row still resolves by id forever, and every document pointing at it still renders. Refused while a lead, proposal, engagement letter, letter line or engagement still points at it (migration 0035). |
| `party.unarchived` | party | An archived party was brought back into the pickers and lists. |
| `legal_entity.registered` | legal_entity | An organization was registered in a jurisdiction. |
| `party_identifier.added` | party_identifier | A PAN / GSTIN / handle was attached to a party. |
| `party_relationship.recorded` | party_relationship | An effective-dated relationship was recorded. |
| `party_relationship.ended` | party_relationship | A relationship was closed with a valid_to date. |

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
| `lead.merged` | lead | A duplicate capture landed on an existing open lead instead of starting a rival one. |
| `lead.stage_changed` | lead | A lead moved through the pipeline. Reaching a terminal stage closes it. |
| `lead.owner_assigned` | lead | A lead was put on somebody's desk, or taken off it. |
| `proposal.drafted` | proposal | A proposal was drafted for a party — the first row in its own timeline, and the only record of what was quoted before it went out. |
| `proposal.discount_approved` | proposal | A discount past the firm's published limit was signed off by somebody holding `proposal:approve`. The whole value of the record is WHO. |
| `proposal.sent` | proposal | A proposal was sent to a prospect. |
| `proposal.viewed` | proposal | The recipient opened it from its share link. Recorded ONCE, on the first open; the running count lives on `crm.proposal.view_count`, because a client refreshing a page is not fifty facts about the business. The actor is `system` — the recipient has no account, and inventing a user id for somebody who has never logged in would be worse than saying plainly that a link was opened. |
| `proposal.accepted` | proposal | Accepted. |
| `proposal.rejected` | proposal | A proposal was declined by the recipient. |
| `proposal.expired` | proposal | A proposal passed its validity date. Written LAZILY — nothing here runs on a timer, so it is recorded the first time somebody tries to act on the proposal. |
| `engagement_letter.drafted` | engagement_letter | An engagement letter was drafted — the first row in the timeline of a document that will create obligations. |
| `engagement_letter.sent` | engagement_letter | It went to the client for signature. |
| `engagement_letter.withdrawn` | engagement_letter | Pulled before signature. A SIGNED letter is never withdrawn — it is superseded by a new one. |
| `engagement_letter.signed` | engagement_letter | The client signed. The letter freezes at this moment (a trigger, 0017) and one engagement is created per line. Payload carries the signature METHOD and the content hash, never the signer's name — that is personal data and lives in the erasable row. |
| `engagement_letter.advance_recorded` | engagement_letter | The advance fee was recorded as received, releasing every engagement the letter created. Recorded by a person until payments (T3.5) can confirm it. |
| `contract.activated` | engagement | An engagement became active and work may begin. **The spawn trigger the scheduler consumes (T2.4)** — written by T2.3, which is the module that causes it. Held back until the advance is recorded when the letter requires one. |
| `invoice.issued` | invoice | An invoice was issued and its number frozen. |
| `invoice.cancelled` | invoice | Cancelled by credit note; the number is never reused. |
| `payment.recorded` | payment | A payment was received and applied. |
| `credit_note.issued` | credit_note | Issued against an invoice. |
| `dunning.escalated` | invoice | A receivable moved up the ladder. |
| `document.attached` | document | A document version was linked to an object. |

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
| `job.spawned` | job | The scheduler created a job from a trigger or a recurrence. |
| `job.step_advanced` | job | The orchestrator moved a job to the next step. |
| `job.completed` | job | A job reached a terminal step. |
| `work_item.assigned` | work_item | Routed to a person. |
| `work_item.completed` | work_item | Finished. |
| `obligation.spawned` | obligation_instance | An obligation instance was created for a period. |
| `obligation.filed` | obligation_instance | Discharged (filed / paid / submitted). |
| `obligation.missed` | obligation_instance | A statutory date passed undischarged. A state, not an error (T3.3). |
| `agent_run.completed` | agent_run | An agent produced an output; confidence in the payload. |
| `agent_run.escalated` | agent_run | An agent refused to act and handed the work to a human. |
| `output.approved` | verification | A checker approved an output. Never the actor that produced it. |
| `output.rejected` | verification | Sent back. |

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
