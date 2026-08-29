// The ledger domain — the event contract itself (T1.1). Nouns + pure rules,
// stdlib only. This file is the vocabulary BOTH lanes write against: the
// commercial lane and the delivery lane meet here and at the engine's trigger
// contract, so a change to it is a cross-lane conversation, not a local edit.
//
// Three rules give the log its value, and all three are enforced below rather
// than trusted:
//   1. The verb is from a CLOSED registry. An unregistered verb is a typo, and
//      a typo in an append-only log is permanent: it creates a verb nothing
//      queries and silently drops the event out of every timeline that matters.
//   2. object_type is DERIVED from the verb, never passed in — so the pair can
//      never disagree and no caller has to remember the mapping.
//   3. The payload carries ids and machine facts, never personal data. Erasure
//      (DPDP / GDPR) must never require mutating an immutable log, so personal
//      data stays in erasable rows and is referenced by id from here.
//
// The prose version, with worked examples, is docs/EVENT-CONTRACT.md.

/** Who acted. `system` is the platform itself (a scheduler tick, a boot job);
 *  `agent` is an AI executor; `human` is a logged-in person. */
export type ActorType = "human" | "agent" | "system";

export interface Actor {
  readonly type: ActorType;
  /** The user id (human) or the registered agent id. Null only for `system`. */
  readonly id: string | null;
}

/** The `system` actor, as a value — so a scheduler or migration job does not
 *  have to construct one and get the null right. */
export const SYSTEM_ACTOR: Actor = { type: "system", id: null };

export interface DomainEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly verb: EventVerb;
  readonly objectType: string;
  readonly objectId: string;
  readonly payload: Record<string, unknown>;
  /** When it happened in the business. ISO 8601 with offset. */
  readonly occurredAt: string;
  /** When we learned of it. ISO 8601 with offset. Set by the database. */
  readonly recordedAt: string;
}

// ── The verb registry — the agreed vocabulary ────────────────────────────────

/** Which lane owns the verb. Documentation, not a permission: any service may
 *  read any event; the lane says who is expected to WRITE it. */
export type Lane = "platform" | "commercial" | "delivery";

export interface VerbSpec {
  /** The kind of row `objectId` points at. Derived, never passed by a caller. */
  readonly objectType: string;
  readonly lane: Lane;
  readonly description: string;
}

/**
 * Every verb the system may record. Past tense, dotted, `<subject>.<happened>`.
 *
 * Adding one is a one-line change here plus a line in docs/EVENT-CONTRACT.md —
 * deliberately cheap, deliberately visible. The registry is code and not a
 * database table precisely so that adding a verb is reviewed like code; a
 * lookup table would let a typo become a permanent new verb at runtime.
 */
export const EVENT_VERBS = {
  // ── platform · tenancy + party (the spine) ─────────────────────────────────
  "tenant.created":              { objectType: "tenant",              lane: "platform",   description: "A firm was registered as a tenant." },
  "membership.granted":          { objectType: "membership",          lane: "platform",   description: "A user was given a role in a tenant, for one audience." },
  "membership.revoked":          { objectType: "membership",          lane: "platform",   description: "A membership was deactivated. The person's next request stops — resolveSession re-reads this on every one." },
  "membership.restored":         { objectType: "membership",          lane: "platform",   description: "A deactivated membership was reinstated." },
  "membership.role_changed":     { objectType: "membership",          lane: "platform",   description: "A member's role at a firm changed, and with it everything gate 3 lets them do." },
  "membership.grade_changed":    { objectType: "membership",          lane: "platform",   description: "A member's SENIORITY changed — a different axis from role. It decides who may sign off another person's work, so who moved whom, and when, is exactly what gets asked about later." },

  // ── platform · the seniority ladder (G3.3) ────────────────────────────────
  // Separate from role: the role says what somebody may REACH, the grade says
  // how senior they are. A firm owns its own ladder, so every change to it is
  // recorded — a rung's rank is what the review threshold compares against, and
  // moving one silently changes who may approve a statutory filing.
  "staff_grade.created":         { objectType: "staff_grade",         lane: "platform",   description: "A firm added a rung to its own hierarchy — one its starting ladder did not have." },
  "staff_grade.updated":         { objectType: "staff_grade",         lane: "platform",   description: "A rung was renamed, re-ranked, or stopped/resumed being promoted through. The payload carries both sides of whatever changed. Never a delete: a rung somebody held is part of why they could approve something." },
  // ── platform · the firm's own delivery structure (G2.4) ───────────────────
  // Depts (the revenue axis) and delivery teams (who does the work) are the
  // firm's own org chart, and once `work_split_axis` names one of them it also
  // decides how a client's work is cut into separate jobs. Retiring a Dept
  // therefore changes what the engine does next, which is why it is recorded
  // rather than left as a boolean nobody can date.
  "service_axis.created":        { objectType: "service_axis",        lane: "platform",   description: "A firm added a Dept or a delivery team to its own structure." },
  "service_axis.updated":        { objectType: "service_axis",        lane: "platform",   description: "A Dept or delivery team was renamed or reordered. The payload names the CODE and says which of the two changed — the code is what every service body joins on and it never moves." },
  "service_axis.retired":        { objectType: "service_axis",        lane: "platform",   description: "A firm stopped filing new work under a Dept or delivery team. NOT a delete: services already naming it keep it and still read." },
  "service_axis.reactivated":    { objectType: "service_axis",        lane: "platform",   description: "A retired Dept or delivery team was brought back into use." },
  "work_split_axis.changed":     { objectType: "tenant",              lane: "platform",   description: "A firm changed how one client's work is cut into separate jobs — by Dept, by delivery team, or not at all. The payload carries BOTH sides: \"what did it used to be\" is the question asked when a job looks split the wrong way." },
  "grade_ladder.seeded":         { objectType: "tenant",              lane: "platform",   description: "A new tenant's seniority ladder was initialised from the product defaults. One event, not one per rung." },
  "session.started":             { objectType: "user_account",        lane: "platform",   description: "A user's session became active in THIS tenant — at login, or when the org switcher selected it." },
  "party.created":               { objectType: "party",               lane: "platform",   description: "An organization or person party was created." },
  "party.archived":              { objectType: "party",               lane: "platform",   description: "A party was put away — hidden from pickers and lists. NOT a delete: parties are permanent, the row still resolves by id forever, and every document pointing at it still renders. Refused while a lead, proposal, engagement letter, letter line or engagement still points at it (migration 0035)." },
  "party.unarchived":            { objectType: "party",               lane: "platform",   description: "An archived party was brought back into the pickers and lists." },
  "legal_entity.registered":     { objectType: "legal_entity",        lane: "platform",   description: "An organization was registered as a legal entity in a jurisdiction." },
  "party_identifier.added":      { objectType: "party_identifier",    lane: "platform",   description: "A PAN / GSTIN / handle was attached to a party." },
  "party_relationship.recorded": { objectType: "party_relationship",  lane: "platform",   description: "An effective-dated relationship between two parties was recorded." },
  "party_relationship.ended":    { objectType: "party_relationship",  lane: "platform",   description: "A relationship was closed with a valid_to date." },

  // ── platform · the configuration registry (P2 / T2.5) ─────────────────────
  // Configuration decides what everyone else may do, so who changed it, when,
  // and to which version is exactly what gets asked about later. Only versions
  // that took EFFECT are recorded: a draft changes nothing until it is
  // published, and the publish names the person who made it real.
  "config_entry.created":        { objectType: "config_entry",        lane: "platform",   description: "A configured thing (a service, a role) was defined, with its first draft." },
  "config_version.published":    { objectType: "config_version",      lane: "platform",   description: "A configuration version took effect and froze. Anything pinned to the version it replaced still reads that one." },
  "config_version.archived":     { objectType: "config_version",      lane: "platform",   description: "A configuration version stopped being what is in force. It stays readable — pins resolve to it forever." },
  "config_registry.seeded":      { objectType: "tenant",              lane: "platform",   description: "A new tenant's configuration registry was initialised from the product defaults. One event, not one per row." },
  "firm_entity_preference.set":  { objectType: "firm_entity_preference", lane: "platform", description: "The firm said which of its OWN entities issues documents to clients in a country — or set the fallback that answers for every country it has no entity in. A commercial and legal decision (it settles governing law, courts and who the client's counterparty is), so who made it is the point of the record." },
  "territory_rule.set":          { objectType: "territory_rule",       lane: "commercial", description: "The firm said whose desk covers leads from a country — or moved one. It decides who a new opportunity lands on before anybody has looked at it, so who drew the line and when is the record. The NOTE is not in the payload: it is prose a person wrote, and this log cannot be erased." },
  "standard_document_block.set": { objectType: "standard_document_block", lane: "platform", description: "The firm changed its STANDARD prose — an exclusion, a commercial note, a line of the team block — or retired one. It is logged because the standard set is what every document written from here on will say, and 'why does this letter carry this exclusion' is answered by who changed it and when. The BODY is not in the payload: it is prose a person wrote, this log cannot be erased, and the row keeps it where it can be." },
  "firm_signatory.set":          { objectType: "tenant",              lane: "platform",   description: "The firm named who binds it — the person and the capacity printed under 'Yours sincerely' on every letter it sends from now on. Authority to bind is an audit question and a DIFFERENT fact from who operated the system, which is this event's actor. objectType is the tenant because the standing signatory is a column on it, the same shape config_registry.seeded uses." },

  // ── commercial lane (A) · sell → bill → collect ────────────────────────────
  "lead.captured":               { objectType: "lead",                lane: "commercial", description: "A lead entered the pipeline." },
  "lead.merged":                 { objectType: "lead",                lane: "commercial", description: "A duplicate capture landed on an existing open lead instead of starting a rival one." },
  "lead.stage_changed":          { objectType: "lead",                lane: "commercial", description: "A lead moved through the pipeline. Reaching a terminal stage closes it." },
  "lead.owner_assigned":         { objectType: "lead",                lane: "commercial", description: "A lead was put on somebody's desk, or taken off it." },
  "proposal.drafted":            { objectType: "proposal",            lane: "commercial", description: "A proposal was drafted for a party — the first row in its own timeline, and the only record of what was quoted before it went out." },
  "proposal.discount_approved":  { objectType: "proposal",            lane: "commercial", description: "A discount past the firm's published limit was signed off, by somebody holding proposal:approve. The whole value of the record is WHO." },
  "proposal.sent":               { objectType: "proposal",            lane: "commercial", description: "A proposal was sent to a prospect." },
  "proposal.viewed":             { objectType: "proposal",            lane: "commercial", description: "The recipient opened the proposal from its share link. Recorded ONCE, on the first open; the running count lives on the row, because a client refreshing a page is not fifty facts about the business." },
  "proposal.accepted":           { objectType: "proposal",            lane: "commercial", description: "A proposal was accepted." },
  "proposal.rejected":           { objectType: "proposal",            lane: "commercial", description: "A proposal was declined by the recipient." },
  "proposal.expired":            { objectType: "proposal",            lane: "commercial", description: "A proposal passed its validity date. Written LAZILY — nothing here runs on a timer, so it is recorded the first time somebody tries to act on the proposal." },
  "engagement_letter.drafted":   { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter was drafted — the first row in the timeline of a document that will create obligations." },
  "engagement_letter.sent":      { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter went to the client for signature." },
  "engagement_letter.withdrawn": { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter was pulled before signature. A SIGNED one is never withdrawn — it is superseded by a new letter." },
  "engagement_letter.signed":    { objectType: "engagement_letter",   lane: "commercial", description: "The client signed. The letter freezes at this moment (a trigger, migration 0017) and one engagement is created per line." },
  "engagement_letter.advance_recorded": { objectType: "engagement_letter", lane: "commercial", description: "The advance fee was recorded as received, which releases every engagement the letter created. Recorded by a person until payments (T3.5) can confirm it." },
  "contract.activated":          { objectType: "engagement",          lane: "commercial", description: "An engagement's COMMERCIAL gates opened: the client signed, and the advance was recorded when the letter required one. THE spawn trigger the scheduler consumes (T2.4) — written by T2.3, which is the module that causes it. The fee gate is real rather than advisory: no advance, no event. Since G1.5 the payload carries `effectiveFrom`, the day the work actually begins, which is NOT always the day this is emitted — a letter signed in September can open engagements that begin in October. Consumers MUST schedule from that date and not from this event's timestamp; it is emitted at the commercial gate rather than held until the date because nothing in this service runs on a timer, and an engagement nobody was told about is worse than one scheduled early." },
  "invoice.raised":              { objectType: "invoice",             lane: "commercial", description: "An invoice was created and its number ALLOCATED from the entity's gapless series. Registered because the allocation is the audit-relevant moment, not the sending: a consecutive series is evidence, and 'which number went to which client, when, decided by whom' is the question an auditor asks about a gap. The number is in the payload for the same reason." },
  "invoice.issued":              { objectType: "invoice",             lane: "commercial", description: "An invoice was issued and its number frozen." },
  "invoice.cancelled":           { objectType: "invoice",             lane: "commercial", description: "An invoice was cancelled by credit note; the number is never reused." },
  "payment.recorded":            { objectType: "payment",             lane: "commercial", description: "A payment was received and applied." },
  "credit_note.issued":          { objectType: "credit_note",         lane: "commercial", description: "A credit note was issued against an invoice." },
  "invoice.registered":          { objectType: "invoice",             lane: "commercial", description: "The government e-invoice registry's identifier (IRN) was recorded against an invoice. Its honest limit: nothing in this product talks to the IRP, so this records an answer obtained elsewhere — the same shape as the advance-fee attestation. The real connector is T7.1." },
  "invoice_series.set":          { objectType: "invoice_series",      lane: "commercial", description: "The firm named what one of its entities' invoice numbers READ as. It changes future numbers only — every issued invoice keeps the number it was issued with, because the freeze trigger refuses to move one." },
  "dunning.decided":             { objectType: "invoice",             lane: "commercial", description: "A partner approved or rejected a TERMINAL dunning step — credit hold or legal action. Both outcomes are recorded: 'we considered legal action and decided against it' is a fact somebody wants three months later, and a rejection that vanished would leave the ladder looking as though it never got there. objectType is the invoice, because 'what happened to this receivable' is the timeline anybody reads." },
  "dunning.escalated":           { objectType: "invoice",             lane: "commercial", description: "A receivable moved up the dunning ladder." },
  "document.attached":           { objectType: "document",            lane: "commercial", description: "A document version was linked to an object." },

  // ── delivery lane (B) · configure → schedule → execute → verify ────────────
  "workflow_template.published": { objectType: "workflow_template",   lane: "delivery",   description: "A workflow template version was published; running jobs pin the version they started on." },
  "rule_pack.activated":         { objectType: "rule_pack",           lane: "delivery",   description: "A rule-pack version became active. Never written by an agent." },
  "job.spawned":                 { objectType: "job",                 lane: "delivery",   description: "The scheduler created a job from a trigger or a recurrence. The payload names every engagement in it and how it was cut, because a merged job's cause is several engagements and its source_ref is a derived group key that names no row." },
  "job.scope_extended":          { objectType: "job",                 lane: "delivery",   description: "Work joined a job that was ALREADY OPEN — the second line of an engagement letter, whose advance arrived after the first. Its own verb rather than a second job.spawned, because 'why did this job gain a service on the 14th' is a question somebody asks and a spawn event cannot answer it. The payload carries only the engagements that actually joined." },
  "job.template_pinned":         { objectType: "job",                 lane: "delivery",   description: "A job resolved the firm's published process and PINNED the version it will walk. Recorded because everything the job does afterwards is explained by this one row: editing the process later never moves a job already walking it, and the version id is what answers 'which wording of it' a year later." },
  "job.started":                 { objectType: "job",                 lane: "delivery",   description: "A job's steps were written from its pinned template and the work began. One event, not one per step." },
  "job.step_advanced":           { objectType: "job",                 lane: "delivery",   description: "A job's step moved — set aside for a person, taken by an agent, or finished. The payload carries both sides and who was expected to do it." },
  "job.step_skipped":            { objectType: "job",                 lane: "delivery",   description: "A step will not happen: its condition did not hold, or something it depends on was skipped. NOT the same as done, and recorded as loudly, because 'we did not do this and here is why' is the question asked when a filing is questioned. The payload carries the FACT and its values, never the prose note — a sentence does not GROUP BY." },
  "job.step_failed":             { objectType: "job",                 lane: "delivery",   description: "An agent could not complete a step. Terminal for the step; the job blocks, because a machine giving up is a thing a person then has to decide about." },
  "job.completed":               { objectType: "job",                 lane: "delivery",   description: "A job reached a terminal step." },
  "work_item.assigned":          { objectType: "work_item",           lane: "delivery",   description: "A work item was routed to a person." },
  "work_item.completed":         { objectType: "work_item",           lane: "delivery",   description: "A work item was finished." },
  "obligation.spawned":          { objectType: "obligation_instance", lane: "delivery",   description: "A statutory or internal obligation instance was created for a period." },
  "obligation.filed":            { objectType: "obligation_instance", lane: "delivery",   description: "An obligation was discharged (filed / paid / submitted)." },
  "obligation.missed":           { objectType: "obligation_instance", lane: "delivery",   description: "A statutory date passed undischarged. A state, not an error." },
  "agent_run.completed":         { objectType: "agent_run",           lane: "delivery",   description: "An agent produced an output, with its confidence score in the payload." },
  "agent_run.escalated":         { objectType: "agent_run",           lane: "delivery",   description: "An agent refused to act and handed the work to a human. Its output is kept and offered as material, not as an answer." },
  "agent_run.decided":           { objectType: "agent_run",           lane: "delivery",   description: "A person accepted, corrected or rejected what a machine proposed. The payload carries WHICH of the three and never the values — accepted vs corrected is the entire accuracy signal, and an agent's output can hold a client's own data, which may not enter a log that cannot be erased." },
  "output.approved":             { objectType: "verification",        lane: "delivery",   description: "A checker approved an output. Never the same actor that produced it." },
  "output.rejected":             { objectType: "verification",        lane: "delivery",   description: "A checker rejected an output and sent it back." },
} as const satisfies Record<string, VerbSpec>;

export type EventVerb = keyof typeof EVENT_VERBS;

export function isEventVerb(v: string): v is EventVerb {
  return Object.prototype.hasOwnProperty.call(EVENT_VERBS, v);
}

/** The object type a verb names. Callers never pass one, so a verb and its
 *  object can never disagree. */
export function objectTypeFor(verb: EventVerb): string {
  return EVENT_VERBS[verb].objectType;
}

/** Registered verbs sharing a prefix — used to make "unknown verb" errors name
 *  the near misses instead of dumping the whole registry. */
export function verbsWithPrefix(prefix: string): readonly string[] {
  return Object.keys(EVENT_VERBS).filter((v) => v.startsWith(`${prefix}.`));
}

/** The naming convention every registry key must satisfy: lowercase snake_case
 *  segments, exactly two, separated by a dot. Asserted over the registry by a
 *  unit test, so a malformed verb cannot be added. */
export function isWellFormedVerb(v: string): boolean {
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(v);
}

// ── Pure rules ───────────────────────────────────────────────────────────────

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** An actor is well formed when a human or agent names itself and only the
 *  platform is anonymous. Mirrors the event_actor_identified_chk constraint. */
export function isIdentifiedActor(actor: Actor): boolean {
  if (actor.type === "system") return actor.id === null;
  return actor.id !== null && isUuid(actor.id);
}

/** Timestamps on the wire are ISO 8601 with an explicit offset — a bare local
 *  time has no meaning across the jurisdictions this product serves. */
export function isIsoTimestamp(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

/**
 * Payload keys that carry personal data. The log is append-only and therefore
 * un-erasable, so these must live in a normal row and be referenced by id:
 * write `{ partyId }`, never `{ email }`; write `{ identifierId }`, never
 * `{ pan }`. The set is deliberately about IDENTIFYING A PERSON — a company's
 * legal_name or GSTIN is a business fact and stays allowed.
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  "email", "email_address", "personal_email",
  "phone", "phone_number", "mobile", "mobile_number", "whatsapp",
  "aadhaar", "aadhar", "uidai", "ssn", "nric", "passport", "passport_number",
  "pan", "din", "date_of_birth", "dob", "birth_date",
  "full_name", "first_name", "last_name", "middle_name", "father_name", "maiden_name",
  "address", "residential_address", "street", "postal_code", "zip",
  "bank_account", "account_number", "account_no", "iban", "ifsc", "card_number",
  "password", "password_hash", "otp", "token", "secret", "api_key", "signature_image",
]);

/** camelCase / kebab-case / spaced keys all normalise to snake_case, so the
 *  denylist cannot be side-stepped by spelling. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/** A payload is a flat set of machine facts; this is the ceiling below which
 *  the personal-data scan is exhaustive. */
export const MAX_PAYLOAD_DEPTH = 8;

/**
 * The path of the first personal-data key found in a payload, or null. Walks
 * nested objects and arrays: burying an email one level down is the same leak.
 * Beyond MAX_PAYLOAD_DEPTH it stops looking — a payload that deep is not the
 * flat set of machine facts this log is for, and is rejected on those grounds
 * by `isPayloadTooDeep`.
 */
export function findPiiKey(payload: unknown, path = ""): string | null {
  return walk(payload, path, 0);
}

function walk(value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_PAYLOAD_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = walk(item, `${path}[${String(i)}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (PII_KEYS.has(normalizeKey(key))) return here;
    const hit = walk(child, here, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export function isPayloadTooDeep(payload: unknown): boolean {
  return depthOf(payload, 0) > MAX_PAYLOAD_DEPTH;
}

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_PAYLOAD_DEPTH || value === null || typeof value !== "object") return depth;
  let deepest = depth;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1));
    if (deepest > MAX_PAYLOAD_DEPTH) return deepest;
  }
  return deepest;
}

/** A payload is a summary, not a document store: 64 KiB is generous for ids and
 *  machine facts and small enough that the log stays scannable at volume. Large
 *  artefacts belong in documents (P8), referenced by id. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Serialised size, or null if the value cannot be serialised at all (a cycle,
 *  a BigInt). Both are caller bugs and are reported as such. */
export function payloadByteLength(payload: Record<string, unknown>): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    return null;
  }
}

/**
 * The idempotency namespace for derived event ids (platform/ids.ts `derivedId`).
 * A retried webhook or a racing pod that passes the same idempotency key derives
 * the SAME uuid and re-lands on the existing row instead of double-recording.
 *
 * This constant is part of the on-disk contract: if another service or language
 * ever derives event ids, it MUST use these exact bytes. Changing it silently
 * breaks deduplication against every event already written.
 */
export const EVENT_ID_NAMESPACE = "4f7d2a1e-9b3c-5d6e-8a0f-1c2b3d4e5f60";
