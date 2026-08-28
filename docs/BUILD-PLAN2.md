# BiB — Build Plan 2: closing the demo gap

The companion board to `BUILD-PLAN.md`. That one plans the product **forward**; this one
closes the distance between what is built here and **the demo the client already approved**
(`10xcrm`, 56 tables, twelve modules). The analysis behind every task is `build2.md`, beside this file —
read a task's section reference before starting it, because the *why* is there and is not
repeated in full here.

**These are not new features.** Almost everything below existed, worked, and was demoed. The
rebuild carried the architecture across and re-derived the domain, so the losses cluster in
the places that were rewritten rather than ported. The party model was ported 1:1 and needs
nothing — which is the proof that the rest is oversight, not disagreement.

## How this board works

Same conventions as `BUILD-PLAN.md`:

- `(A)` / `(B)` is the owning lane. `(A/B)` needs both in the room.
- `*Acc:*` is the acceptance criterion. Not done until it passes.
- A task is done when `npm run check` is green **and** the acceptance holds, with the reasoning
  written under the task the way T2.5 and T2.5b did it.
- Every schema change follows `migrations/README.md`: `NNNN_name.{up,down}.sql`, immutable
  once applied, fix forward, `SET ROLE bib_owner` around DDL, downs use `IF EXISTS`, new
  business table ⇒ `tenant_id` + RLS + policy or an explicit `-- GLOBAL:` justification.

## Who owns what

The rule for this board, which differs from `BUILD-PLAN.md`'s lane split:

> **A gap in a module belongs to whoever built the module.** Anish built the entire
> commercial chain and the substrate solo, so a field the demo had and his tables do not is
> his to add — he holds the context for the code it threads through. New modules follow the
> original lane split.

That lands as:

- **(A) Anish** — party/core, lead, proposal, engagement letter, engagement, the config
  registry and catalogue, tenancy. Every gap in those.
- **(B) second dev** — the engine and delivery lane as `BUILD-PLAN.md` already assigns it:
  scheduler, orchestrator, work items, **the compliance calendar**, and the screens for them.
  The calendar is owned **outright**, its schema shape included: it was designed and shipped
  once in the demo, and G0.2 settled that it keeps that design here.

Where a task is owned by one lane but exists *for* the other, it says so. Those are the ones
to sequence deliberately rather than pick up when convenient.

## Migration numbering — agree this before either of you writes SQL

`0017` is the last applied migration. Two people adding migrations at once **will** collide
on `0018`, and a migration is immutable once applied anywhere, so a collision is not a rename
— it is one of you re-doing the work under a new number.

**Reserve ranges up front:** `(A)` takes **0018–0039**, `(B)` takes **0040+**. Cheap, and it
makes the two lanes' schema work genuinely parallel. Revisit when either range runs low.

## The estimate (read the caveats)

Rough, and the caveats from `BUILD-PLAN.md` apply unchanged. Phase G0 is days. G1 is the
large one — it is a whole document layer, and it is what the client actually saw. G4 is a
module — its shape is settled (G0.2), so the estimate is the build itself.

| Phase | Lane | Rough size |
|---|---|---|
| G0 · Blocking | A | 2–4 days |
| G1 · The document | A | 2–3 weeks |
| G2 · The catalogue | A (for B) | 3–5 days |
| G3 · Pipeline, people, ownership | A + B | 1–1.5 weeks |
| G4 · Compliance calendar | B | 2–3 weeks |

## Dependency spine

```
G0.1  entity on the line  (A)  ← nothing downstream works without it
   ↓
   ├─────────────────────────────┬──────────────────────────────┐
   ↓                             ↓                              ↓
G1  the document (A)        G2  the catalogue (A)          G4  calendar (B)
   ↓                             ↓                          G0.2 SETTLED: own tables
G1.7 prose blocks           G2.3 slaDays ──────────┐            ↓
G1.8 governing law                                 ↓        G4.1 + G4.1a templates
                                            G3.2 assignment (B) ↓
                                                   ↓        G4.2 instances
                                            BUILD-PLAN T3.1     ↓
                                              work items    G4.4 generator
                                                                ↓
                                                            G4.6 rules screen
```

Read it as: **G0.1 gates everything** — including G4, because an obligation attaches to an
entity. G2.3 and G3.2 gate `T3.1` in the main plan. G4 is otherwise `(B)`'s to run
independently now that G0.2 is settled.

---

## Phase G0 · Blocking — before any other task on this board

- [ ] `(A)` **G0.1** **The entity a line is for.** Add `entity_party_id` to
  `crm.proposal_line` (nullable), `crm.engagement_letter_line` (NOT NULL) and
  `crm.engagement` (NOT NULL), each with a composite `(entity_party_id, tenant_id)` FK to
  `core.party`, plus indexes on `(tenant_id, entity_party_id)`. Thread it through
  `domain/{proposal,engagement}/model.ts`, both `ports.ts`, both services, both Postgres
  repositories, both handlers, both fakes, and the smoke script. In
  `usecase/engagement/service.ts` the fan-out takes the entity **from the line**
  (`entityPartyId: line.entityPartyId`) while keeping `partyId: letter.partyId` — the client
  is who is billed, the entity is who the work is delivered to, and a firm needs both.
  *Acc: an EL line names an entity; signing fans out an engagement carrying it; a letter line
  with no entity is refused by the DATABASE, not by the service.* — **§5.1.** The migration is
  written and tested in `build2.md`; it applies clean and its down is re-runnable. Nullable on
  the proposal line is deliberate and not laziness: Incorporation is a service the firm sells
  whose line cannot name an entity, because that entity is the line's own output.
  > **Why this is first.** `obligation_instance` keys on an entity — an entity owes GSTR-3B, a
  > client does not. Without this column the compliance calendar has no join available and
  > cannot be built at all, which makes G4 unstartable and `core.legal_entity` reachable from
  > nothing downstream. All three tables are empty today, so it is one additive migration; after
  > T3.2 it is a rewrite of the calendar.

- [x] `(B)` **G0.2** **Where obligation templates live — DECIDED: their own tables.** The
  demo's structure, carried across as-is: `obligation_template` with real columns
  (`jurisdiction`, `entity_type`, `recurrence`, `due_rule`, `due_month_offset`,
  `due_day_of_month`, `due_days_after`, `lead_time_days`, `rule_pack`, `status`) plus
  `obligation_template_exception` and `obligation_state`.
  > **Decided between both devs.** The alternative was a fifth `kind` in the config registry,
  > which is what `CLAUDE.md` prescribes for a template or a rule pack. It was weighed and set
  > aside: the generator queries these rules rather than reading one at a time, the exception
  > rows want a real foreign key to the rule they modify, and this shape is already proven —
  > it ran in the demo and generated a real calendar.
  >
  > **The cost, stated rather than discovered later.** The registry would have supplied
  > versioning, publishing, freezing and pinning for free, and tax rules change — so
  > `obligation_template` has to carry that weight itself. `rule_pack` (e.g. `gst-in@2026.07`)
  > and `status` are not decoration; they are the whole of it, and G4.1 owns building them
  > properly. A filing made last year was made under last year's rules, and without a pinned
  > rule-pack version *"why was this due then?"* is unanswerable.
  >
  > `obligation_instance` was never in question — thousands of rows of transactional data is
  > not configuration.

- [ ] `(B)` **G0.2a** **Write the deviation into `CLAUDE.md`.** Add a sentence to the
  configuration-registry section naming obligation templates as a deliberate exception, with
  the reason. *Acc: someone reading `CLAUDE.md` cold understands why obligations have their own
  tables while services, roles, policies and clauses do not.* — The repo's own rule for this,
  from `CLAUDE.md`: *"If a rule is genuinely wrong, that is a design conversation in the PR,
  landed as its own commit with the reasoning — never a quiet exception."* An undocumented
  deviation reads as an oversight to the next person, and the next person may be either of you
  in six months.

- [ ] `(A)` **G0.3** **Decide soft delete on `core`.** `CLAUDE.md` says *"Soft delete only"*,
  but no `core` table has `deleted_at` and no `DELETE` route exists, so a client created by
  mistake can be neither removed nor archived. Either add the column across `core` and filter
  every read, or write down that parties are permanent and the ledger plus
  `legal_entity.status` is the answer. *Acc: either the column exists and reads filter it, or
  the decision is a paragraph in `CLAUDE.md`.* — **§4.1.** Lower stakes than it looks: the
  honest answer may well be "permanent". What is not acceptable is a stated rule the schema
  does not implement, because the next person reads the rule and assumes the column.

---

## Phase G1 · The document — make the letter printable  (A)

This is the phase that closes the demo gap the client would actually notice. Anish's document
head is stronger commercially than the demo's — FX struck once, discount approval, content
hashing, share links — and cannot yet print the letter the firm sends. **All of it is his:
he built proposals and engagement letters.**

Sequence it as written; G1.1–G1.5 are one migration's worth of head fields and can land
together if that reads better than five.

- [ ] `(A)` **G1.1** **Document reference.** `ref text NOT NULL`, `UNIQUE (tenant_id, ref)` on
  proposal and engagement letter — `EL-US-2026-0007`. *Acc: a letter has a number a client can
  quote back on the phone, and two letters cannot share it.* — **§4.5.** Neither document has
  any human-facing identifier today. Decide the generator alongside: per-entity per-year is the
  shape the demo's `invoice_series` used, and the same reasoning applies (a sequence keeps its
  number on rollback).

- [ ] `(A)` **G1.2** **Issuing entity, and the rule that picks it.**
  `issuing_entity_party_id uuid NOT NULL` on both documents, plus a `firm_entity_preference`
  table (`client_jurisdiction` including `'*'`, `firm_entity_party_id`, `note`) holding the
  fallback and any deliberate exception. *Acc: a letter names which of the firm's own entities
  is contracting; a client in a country the firm has no entity in resolves through the
  fallback, not through an `if`.* — **§4.5, §4.7.** The firm's rule is *"jahan ka client hota
  hai, wahan ki entity"*, with *"flexibility to choose. But mostly UAE"* where it has none.
  The letter carries a bare `jurisdiction text` today, which says where but never **who**.
  Stored rather than derived, because it is a snapshot: the client's default may change and an
  issued letter must always say who actually issued it.

- [ ] `(A)` **G1.3** **The prose the letter opens and closes with.** `background text`,
  `addressed_to_party_id uuid`, `issued_on date`, `declined_reason text`, `supersedes_id uuid`.
  *Acc: a letter addresses a named person care-of the client organization, opens with why this
  client is buying this, and a rejected proposal records why.* — **§4.5.** `addressedTo` is
  currently a computed string (the party's display name), so the document cannot address an
  individual. `supersedes_id` matters more than it looks: the model already refuses to edit a
  signed letter — *"supersede it with a new letter instead"* — and gives that instruction
  nowhere to be recorded.

- [ ] `(A)` **G1.4** **The firm's own signature block.** `firm_signatory_user_id`,
  `firm_signatory_title`, `firm_signed_at` on the letter; `signed_by_title` beside the existing
  `signed_by_name`; `firm_signatory_user_id` + `firm_signatory_title` on `tenancy.tenant` as the
  default. *Acc: a letter prints both signatures — the client's acceptance and "Yours sincerely,
  …, Director" — and records who bound the firm.* — **§4.5, §4.9.** Only the client's half is
  modelled, so the firm's block renders as a blank line. Authority to bind is an audit
  question, not decoration, and it is a different fact from who operated the system — the
  ledger already records the second.

- [ ] `(A)` **G1.5** **Effective dates.** `effective_from date` on the letter **and** on the
  line. *Acc: a letter signed in September can open engagements that begin in October, and one
  line on it can begin on a different date from the rest.* — **§4.5, §4.6.** Signing currently
  starts everything immediately, so a letter agreeing that the outgoing accountant finishes
  August cannot be written down — the firm is issued August's filings and tasks for work it has
  not taken on. Per line as well as per document because per line can express a single shared
  date and the reverse cannot; null on the line means "whatever the letter says", null on the
  letter means the signature date.

- [ ] `(A)` **G1.6** **Line detail.** On both line tables: `jurisdiction text`,
  `billing_frequency text`, the four overrides (`scope_override`,
  `client_obligations_override`, `volume_limits_override`, `exclusions_override`),
  `oop_estimate_min` / `oop_estimate_max` / `oop_currency`, `pricing_note text`, **and relax
  `unit_amount` to nullable.** *Acc: a line can say "as mutually agreed" with a reason instead
  of a price; editing one client's scope wording does not touch the catalogue; a line carries
  an out-of-pocket range separate from the fee.* — **§4.6.** Two of these are sharper than the
  rest. `unit_amount numeric NOT NULL CHECK (>= 0)` makes an unpriced line **unrepresentable** —
  it has to be quoted as zero, which says something different to a client, and several real
  lines are genuinely "as mutually agreed". And the four overrides are what make an issued
  document reproducible: the letter carries its own wording, so a later catalogue revision
  cannot change what a signed document says.

- [ ] `(A)` **G1.7** **The prose blocks.** `document_block` (`kind` ∈ `exclusion` /
  `commercial` / `team`, `body`, `is_heading`, `sort_order`) owned by a document, and
  `standard_document_block` (the same plus `jurisdiction` and `is_active`) as the firm's
  standard set, **copied** onto each new document at creation. *Acc: a firm edits its standard
  exclusions and the next letter changes while every issued letter still says what it said;
  a UAE proposal does not print an Indian tax note.* — **§4.7.** One row per line rather than
  one blob per block, because that is how they are edited — a line at a time, reordered,
  removed — and a single text column makes "delete the third exclusion" a string operation
  with nothing for the UI to attach an edit control to. `jurisdiction` is load-bearing: *"All
  fees are exclusive of GST as applicable"* is wrong on a UAE proposal in exactly the way the
  firm already caught in its own template.

- [ ] `(A)` **G1.8** **Governing law and courts.** Extend `ClauseBody` — currently
  `{title, text, jurisdictions[]}` — or add a clause-set concept carrying `governing_law` and
  `courts` resolved from the **issuing entity's** jurisdiction (G1.2). *Acc: a letter issued by
  the US entity cannot print Indian governing law.* — **§4.7.** The sharpest finding of the
  original project: the real letter was issued by 10x US to a US client and its standard terms
  named Indian law and Delhi courts. The firm's verdict was flat — *"No. This is wrong. For US
  it's US. For UAE it's DIFC in Dubai etc. We can standardise that."* Clauses are tagged by
  jurisdiction today, which is not the same thing: nothing anywhere holds the governing law,
  so the bug the firm caught is representable again.

**Milestone G1:** an engagement letter generated from this system is the letter the firm
actually sends — numbered, issued by a named entity, addressed to a person, with its own scope
wording, its exclusions, both signatures and the right governing law.

---

## Phase G2 · The catalogue — restore what delivery reads  (A, built for B)

Owned by `(A)` because Anish built the registry. **Sequenced by `(B)`'s needs**: G2.3 blocks
`T3.1` in the main plan, so it is the one to pull forward if the lanes are running in
parallel.

The registry itself is an improvement on the demo's `fee_schedule` — versioning and per-line
pinning are things the old system had to copy text to achieve. The loss is in `ServiceBody`,
which is `{name, description, category, jurisdictions[], billingBasis, listPrice}` where the
demo's `service` carried eleven more.

- [ ] `(A)` **G2.1** **Identity and reporting axes.** Add `ref`, `module`, `group` to
  `ServiceBody` (or settle `ref` onto `config.entry.key` and write down which). *Acc: revenue
  can be grouped by Dept; a proposal cites the firm's own service code.* — **§4.8.** `module`
  is FRC / TRC / RAA, the axis the firm's own dashboard splits revenue by, and the axis a SPOC
  is assigned per (G3.1). `group` is the delivery team and is deliberately **not** nested under
  module — FINCOMPLIANCE appears under both FRC and TRC, so they are independent dimensions of
  one service rather than a hierarchy.

- [ ] `(A)` **G2.2** **The four scope blocks.** Add `scope`, `clientObligations`,
  `volumeLimits`, `exclusions` to `ServiceBody`. *Acc: an engagement letter is assembled from
  the catalogue's own words, and G1.6's overrides have something to override.* — **§4.8.**
  These are what protect the firm in a dispute. Store them as the firm states them —
  *"≤1,000 entries; ≤8 bank accounts"* — not parsed into typed limits: nothing is metered, and
  when a client exceeds a ceiling the firm re-assesses the engagement rather than auto-charging.

- [ ] `(A)` **G2.3** **`slaDays`, `recurrence`, `pricingNote`.** *Acc: a work item created from
  an engagement snapshots the SLA in force at creation; a service can recur monthly while being
  billed quarterly; a service with no list price can say why.* — **§4.8.** **This one gates
  `(B)`.** The firm's rule is *"task is due from signing of EL"* and *"SLA is per service"*, and
  `T3.1`'s work items are meant to copy `sla_days` at creation so a later catalogue revision
  cannot make finished work retroactively late. `recurrence` is not `billingBasis`: the latter
  says how a service is priced (fixed / hourly / retainer / per_unit), the former how often it
  recurs, and the EL line's `billing_frequency` (G1.6) defaults from it.

---

## Phase G3 · Pipeline, people and ownership

- [ ] `(A)` **G3.1** **Lead: name it and learn from it.** `title text NOT NULL` on `crm.lead`;
  `lost_reason text`; add `abandoned` to the stage CHECK and to the terminal-stage constraint.
  *Acc: two opportunities with the same client are distinguishable in a list; a lost deal
  records why in the closer's own words; "went quiet" and "chose a competitor" are different
  rows.* — **§4.4.** A lead has no name at all today. `lost_reason` is deliberately free text —
  a dropdown of five reasons produces five reasons and the useful one is always the sixth.
  Collapsing `abandoned` into `lost` destroys the only signal separating a **pricing** problem
  from a **follow-up** problem. While here, confirm `lead_one_open_per_party` is intended: it
  stops a firm opening a second lead to quote an existing client for unrelated work.

- [ ] `(B)` **G3.2** **Client ownership — `client_assignment`.** New tenant-scoped table:
  `client_party_id`, `role` ∈ `key_manager` | `spoc`, `module_id` (the Dept for a SPOC, null
  for a key manager, enforced by CHECK), `user_id`, `valid_from` / `valid_to`. *Acc: a client
  has one Key Manager and one SPOC per Dept, effective-dated, and "who was SPOC in March" is
  answerable.* — **§4.2.** `(B)` owns it because `T3.1`'s acceptance criterion is *"a filing
  arrives pre-assigned to the client's Dept SPOC"* and nothing else reads it. Confirmed firm
  practice, not a guess: *"each client will de facto have two SPOC — one from TRC team and one
  from FRC team"*, and a client buying RAA work has three, which is why it is a row per Dept
  rather than two columns. Depends on G2.1 for `module`.

- [ ] `(B)` **G3.3** **`staff_grade` + `membership.grade_id`.** The firm's nine grades, Article
  → Associate Director, with `rank` and `is_active`. *Acc: the review rule "Manager or above"
  is one comparison against `rank`, and a grade the firm stopped promoting through stays
  readable.* — **§4.3.** `rank` exists because that is the whole routing rule the firm actually
  stated — one threshold, no skill matrix, no tier-and-load. `is_active` rather than
  `deleted_at`, and the distinction is deliberate throughout the demo: `deleted_at` means the
  row was a mistake, `is_active` means the firm has moved on from it — and a rung somebody once
  held is part of why they could approve something in 2026. Needed by `T2.9`'s verification
  routing and `T3.1`'s review step.

- [ ] `(A)` **G3.4** **`membership.party_id` — the login-to-person link.** *Acc: "escalate to
  this assignee's manager" resolves through the org chart.* — **§4.3.** On `membership` and not
  `user_account`, because `party` is tenant-scoped and `user_account` deliberately is not: the
  same human may hold logins at two firms and is a different party in each. Nullable both
  ways — a portal user is not staff, and most of a firm has a place in the chart and no login.
  `BUILD-PLAN.md` already carries this as **Gate 4 (record-scope)** and defers it to U1; it is
  listed here because `(B)`'s escalation ladder needs it sooner than the portal does. **Agree
  the timing rather than assuming it.**

---

## Phase G4 · The compliance calendar  (B)

The module the whole product is for, and `(B)`'s work throughout — it is `T3.2`, `T3.3` and
`T6.4` in the main plan. **Blocked only on G0.1** — an obligation attaches to an entity, and
until a line carries one there is no join to generate against. G0.2 is settled, so the shape
is yours and the rest of this phase runs without waiting on `(A)`.

Reference implementation: `10xcrm/src/db/schema/obligation.ts` and `10xcrm/src/worker/`. The
schema comments there carry the reasoning and are worth re-reading before designing anything.

- [ ] `(B)` **G4.1** **`obligation_template`** — tenant-scoped, RLS, its own table (G0.2):
  `jurisdiction`, `entity_type` (null = every type, the common case — GST does not care what
  shape the company is), a nullable `service` link, `name`, `authority`, `recurrence`,
  `fiscal_year_start_month`, the due rule (`day_of_month` with month-offset + day, or
  `days_after`), `lead_time_days`, `rule_pack`, `status`, `is_active`. *Acc: seeding India's GST
  and TDS rules is data entry, not a migration; every seeded rule starts `unconfirmed`.* — Two
  kinds of due rule cover everything known so far and both are data rather than a formula
  string. A third is deliberately absent: real rules like India's QRMP scheme are conditional,
  and inventing a condition language before seeing a real condition produces the wrong
  abstraction — when one arrives it becomes a column, not a rewrite. **Everything seeds
  `unconfirmed`, India included** — those dates came from a previous vendor's document, and the
  firm's own practice may be earlier than the statutory date. A due date is a rule, a wrong one
  costs the client a penalty, and a plausible-looking wrong rule is the dangerous kind precisely
  because nobody re-reads it.

- [ ] `(B)` **G4.1a** **Rule-pack versioning, on the table.** `rule_pack` is pinned by the
  instance that used it, a revision is a **new template row** rather than an edit, and a
  superseded row stays readable. *Acc: a filing made under `gst-in@2026.07` still resolves to
  the rule as it read then, after `gst-in@2027.04` is active; and changing a live rule cannot
  silently restate last year's calendar.* — **This is the bill for G0.2.** Choosing tables over
  the registry means the freezing and pinning `config.version` already implements has to be
  built here instead: publish-freezes, supersede-rather-than-edit, and an instance that stores
  which template version produced it. Do not leave it as a `text` column nobody enforces — that
  is the failure mode the registry exists to prevent, and *"why was this due then?"* is the
  question it answers.

- [ ] `(B)` **G4.2** **`obligation_instance` + states.** Tenant-scoped table keyed on
  **`entity_party_id`** (G0.1's column, on the entity — a client with four companies owes four
  sets of filings), with `period_start` / `period_end` / `period_label`, **two dates**
  (`statutory_due_on` and `internal_target_on`), a nullable `engagement_id`, a `work_item_id`
  once `T3.1` exists, and states as **rows** with `is_terminal` and `needs_decision` flags.
  `UNIQUE (template_id, entity_party_id, period_start)`. *Acc: the generator is safe to re-run —
  and it will be re-run, every month, forever.* — The two dates are the point of the whole
  table. `statutory_due_on` is what the law says and missing it is the client's money;
  `internal_target_on` is `T–X`, the firm's own, and it is the one the escalation ladder watches
  because finding out you are late on the day you are late is useless. States as rows because
  the vocabulary is unconfirmed — renaming one should be an `UPDATE`.

- [ ] `(B)` **G4.3** **Template exceptions.** A row against the rule, keyed by the month the
  filed **period** ends in, carrying the same three due-rule shapes plus a mandatory note.
  *Acc: March TDS resolves to 30 April while the other eleven months resolve to the 7th.* —
  A template holds one formula, and reading only the normal half produces a rule that is right
  eleven months a year and quietly wrong every April — the worst available failure, because
  nobody re-reads a date that looks right and the cost lands on the client. **Not a condition
  language**: the firm said its only exceptions are month-based and only on TDS, and a generic
  predicate engine built for one confirmed shape is the wrong abstraction guessed early.

- [ ] `(B)` **G4.4** **The generator.** Materialise instances from templates × entities ×
  periods, at `T–X`, on the scheduler from `T2.6`. **Generate only where an engagement exists**
  — decided: this is the CRM reading, *"track our work"*. Keep `engagement_id` nullable anyway
  so the compliance-engine reading (*"track their compliance"*, where every uncovered
  obligation is a sales lead) stays a config change rather than a migration. *Acc: a monthly
  obligation spawns twelve instances a year out; an Indian quarter runs Apr–Jun, not Jan–Mar;
  re-running changes nothing.* — Nobody adds a row to this calendar by hand. It falls out of
  which entities exist, what each bought, and what the law says about that combination. If a
  human could add an entry the calendar could drift from the law — and then it is Excel again,
  only now it is Excel inside Postgres.

- [ ] `(B)` **G4.5** **Missed-deadline state.** Past the statutory date and undischarged ⇒ a
  partner decision queue (provisional filing vs late fee), with the decision **and its reason**
  recorded. Writes `obligation.missed`, then `obligation.filed` or a resolution. *Acc: a missed
  deadline is a state a partner resolves, not an error the system hides.* — This is `T3.3`. In
  a CA firm that moment is where money and liability are decided, and today it happens on
  WhatsApp and is written down nowhere. The reason is the capture-or-lose half: in eighteen
  months nobody remembers why a late fee was accepted rather than a provisional filing made.

- [ ] `(B)` **G4.6** **The calendar and rules screens** in `../bib-frontend`. The calendar view,
  the partner's decision queue, and **a rules editing page a partner can use** — including
  confirming an `unconfirmed` rule. *Acc: a partner changes a due-date rule without a deploy,
  and the screen shows which rules the firm has not yet confirmed.* — This is `T6.4`, and the
  *"row with a screen"* bar: config held as rows is only half the promise if editing it still
  needs a developer. The demo's `10xcrm/src/app/calendar/rules/` is 627 lines and is the spec.

**Milestone G4:** the compliance calendar generates itself from entities, engagements and
rules; a partner can edit the rules and resolve a missed deadline; nothing in it was typed in
by hand.

---

## Deliberately not on this board

Listed so nobody has to re-derive whether they were forgotten. All existed in the demo; none
is scheduled here, and each needs a yes or a no rather than silence.

| Thing | Why it is parked | Whose call |
|---|---|---|
| `notification` (in-app inbox) | The firm asked for it — *"email aur in-app — in-app kar do abhi"* — and it is in neither schema nor `BUILD-PLAN.md`. | A/B |
| `brand_asset` (logo, signature image) | PDF generation cannot ship without it, and PDF is not scheduled either. | A |
| `communication` (email/WhatsApp threading) | `T4.7` A1 Intake has nothing to attach to without it. | A |
| `credit_note.reason` mandatory | Belongs with `T3.5`; carry the CHECK across when billing lands. Without it revenue leakage is invisible — the numbers always reconcile, *why* ₹40,000 came off does not. | A |
| Maker ≠ checker as a CHECK constraint | Already `T2.9`'s acceptance in `BUILD-PLAN.md`. Named here only so it is not quietly downgraded to a service rule. | B |
| Gapless invoice numbering | Already `T3.4`'s acceptance, and the plan names the mechanism correctly (a locked counter row, not a sequence — a sequence keeps its number on rollback and burns 41 forever). | A |
| AI `proposed` kept beside `applied` | Phase 4. Keeping only the corrected value is the obvious thing to do and throws the entire accuracy signal away. | B |
| Lead `expected_value` / `expected_close_on` | **Not a regression** — neither system had it. A suggestion: there is no pipeline forecast anywhere, and the table is young. | A |
| Client lifecycle (`onboarded_on`) | **Not a regression.** Derivable by walking `party_relationship('client_of')`; probably a view, not a column. | A |

---

## Parking lot / decisions to make

- ~~**G0.2** — obligation templates: registry kind or their own tables.~~ **Settled: their
  own tables, owned by `(B)`.** The versioning the registry would have given free is now
  G4.1a's job, and the deviation gets written into `CLAUDE.md` in G0.2a.
- **G0.3** — soft delete on `core`, or a written decision that parties are permanent.
- **G3.4** — pull `membership.party_id` forward from U1, or make `(B)`'s escalation wait.
- **G1.1** — the reference-number generator: per entity per year, or one continuous series.
- Migration ranges: `(A)` 0018–0039, `(B)` 0040+. Confirm before either lane writes SQL.
- Does an engagement letter line have to name an entity the firm has already incorporated?
  If yes, G0.1's foreign key tightens to `core.legal_entity` and needs a composite key on it
  first. Left at `core.party` deliberately — that is a product decision, not a schema one.
