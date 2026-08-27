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

### Platform — tenancy + party (built)

| Verb | Object | Means |
|---|---|---|
| `tenant.created` | tenant | A firm was registered as a tenant. |
| `user.registered` | user_account | A global identity was created for an email. |
| `membership.granted` | membership | A user was given a role in a tenant, for one audience. |
| `membership.revoked` | membership | A membership was deactivated. |
| `session.started` | user_account | A user authenticated. |
| `party.created` | party | An organization or person party was created. |
| `legal_entity.registered` | legal_entity | An organization was registered in a jurisdiction. |
| `party_identifier.added` | party_identifier | A PAN / GSTIN / handle was attached to a party. |
| `party_relationship.recorded` | party_relationship | An effective-dated relationship was recorded. |
| `party_relationship.ended` | party_relationship | A relationship was closed with a valid_to date. |

### Commercial lane (A) — sell → bill → collect

| Verb | Object | Means |
|---|---|---|
| `lead.captured` | lead | A lead entered the pipeline. |
| `lead.merged` | lead | A duplicate lead was merged into an existing party. |
| `proposal.sent` | proposal | A proposal was sent to a prospect. |
| `proposal.viewed` | proposal | The recipient opened it. |
| `proposal.accepted` | proposal | Accepted. |
| `proposal.rejected` | proposal | Declined or expired. |
| `engagement_letter.signed` | engagement_letter | The client signed. |
| `contract.activated` | engagement | **The spawn trigger the scheduler consumes (T2.4).** |
| `invoice.issued` | invoice | An invoice was issued and its number frozen. |
| `invoice.cancelled` | invoice | Cancelled by credit note; the number is never reused. |
| `payment.recorded` | payment | A payment was received and applied. |
| `credit_note.issued` | credit_note | Issued against an invoice. |
| `dunning.escalated` | invoice | A receivable moved up the ladder. |
| `document.attached` | document | A document version was linked to an object. |

### Delivery lane (B) — configure → schedule → execute → verify

| Verb | Object | Means |
|---|---|---|
| `workflow_template.published` | workflow_template | A template version was published; running jobs pin their version. |
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
GET /internal/v1/tenants/{tenantId}/events?limit=50
GET /internal/v1/tenants/{tenantId}/objects/{objectType}/{objectId}/events
```

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
