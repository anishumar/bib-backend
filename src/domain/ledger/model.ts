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
  "session.started":             { objectType: "user_account",        lane: "platform",   description: "A user's session became active in THIS tenant — at login, or when the org switcher selected it." },
  "party.created":               { objectType: "party",               lane: "platform",   description: "An organization or person party was created." },
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
  "engagement_letter.signed":    { objectType: "engagement_letter",   lane: "commercial", description: "An engagement letter was signed by the client." },
  "contract.activated":          { objectType: "engagement",          lane: "commercial", description: "A signed engagement letter became an active engagement. THE spawn trigger the scheduler consumes (T2.4)." },
  "invoice.issued":              { objectType: "invoice",             lane: "commercial", description: "An invoice was issued and its number frozen." },
  "invoice.cancelled":           { objectType: "invoice",             lane: "commercial", description: "An invoice was cancelled by credit note; the number is never reused." },
  "payment.recorded":            { objectType: "payment",             lane: "commercial", description: "A payment was received and applied." },
  "credit_note.issued":          { objectType: "credit_note",         lane: "commercial", description: "A credit note was issued against an invoice." },
  "dunning.escalated":           { objectType: "invoice",             lane: "commercial", description: "A receivable moved up the dunning ladder." },
  "document.attached":           { objectType: "document",            lane: "commercial", description: "A document version was linked to an object." },

  // ── delivery lane (B) · configure → schedule → execute → verify ────────────
  "workflow_template.published": { objectType: "workflow_template",   lane: "delivery",   description: "A workflow template version was published; running jobs pin the version they started on." },
  "rule_pack.activated":         { objectType: "rule_pack",           lane: "delivery",   description: "A rule-pack version became active. Never written by an agent." },
  "job.spawned":                 { objectType: "job",                 lane: "delivery",   description: "The scheduler created a job from a trigger or a recurrence." },
  "job.step_advanced":           { objectType: "job",                 lane: "delivery",   description: "The orchestrator moved a job from one step to the next." },
  "job.completed":               { objectType: "job",                 lane: "delivery",   description: "A job reached a terminal step." },
  "work_item.assigned":          { objectType: "work_item",           lane: "delivery",   description: "A work item was routed to a person." },
  "work_item.completed":         { objectType: "work_item",           lane: "delivery",   description: "A work item was finished." },
  "obligation.spawned":          { objectType: "obligation_instance", lane: "delivery",   description: "A statutory or internal obligation instance was created for a period." },
  "obligation.filed":            { objectType: "obligation_instance", lane: "delivery",   description: "An obligation was discharged (filed / paid / submitted)." },
  "obligation.missed":           { objectType: "obligation_instance", lane: "delivery",   description: "A statutory date passed undischarged. A state, not an error." },
  "agent_run.completed":         { objectType: "agent_run",           lane: "delivery",   description: "An agent produced an output, with its confidence score in the payload." },
  "agent_run.escalated":         { objectType: "agent_run",           lane: "delivery",   description: "An agent refused to act and handed the work to a human." },
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
