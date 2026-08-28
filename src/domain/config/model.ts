// The master configuration registry (P2) — nouns + pure rules, stdlib only.
//
// One spine, several KINDS. The spine is the part that is hard to get right and
// expensive to change later: how a configured thing is versioned, published,
// and PINNED. The kinds are just body shapes riding on it.
//
// Pinning is the reason the spine exists. A consumer that must not move — a job
// walking a workflow, a proposal quoted from the catalogue — stores the id of
// the version it started on and reads that row forever. Editing a published
// version would silently rewrite work already in flight, so a published version
// is frozen (by a trigger, in migration 0005) and a change is a NEW version.
// Which of the two reads a consumer wants is the CONSUMER's decision and is
// always explicit:
//
//   live   — the published version, right now. Roles read this way: a firm that
//            removes a permission expects it gone this afternoon, not whenever
//            the sessions holding a pin expire.
//   pinned — the version id stored at the time. Jobs and quotes read this way.
//
// Adding a kind is a code change, not a config change, because each kind needs a
// body validator and a kind without one would accept anything. The database
// CHECK on config.entry.kind is the other half of that agreement.
import type { Permission } from "../authz/model";
import { PERMISSIONS, isPermission } from "../authz/model";
import type { Amount, Money } from "../money/model";
import { MAX_AMOUNT_SCALE, isAmount, isCurrencyCode, normalizeCurrency } from "../money/model";

/** The configured things this pass knows about. `workflow_template` and
 *  `rule_pack` join them when T2.7 and T4.3 actually read them — designing
 *  those bodies against no consumer is how a schema ends up wrong in a way a
 *  migration has to undo.
 *
 *  `policy` (0010) is the first NON-CATALOGUE kind — a rule the firm sets for
 *  itself rather than something it sells — which is what makes it the honest
 *  test of whether this spine generalises. */
export type ConfigKind = "service" | "role" | "policy";

export const CONFIG_KINDS: readonly ConfigKind[] = ["service", "role", "policy"];

export function isConfigKind(v: string): v is ConfigKind {
  return (CONFIG_KINDS as readonly string[]).includes(v);
}

/** draft is working state; published is in force and frozen; archived was in
 *  force and still resolves, because something may be pinned to it. */
export type VersionStatus = "draft" | "published" | "archived";

export interface ConfigEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: ConfigKind;
  /** The firm's own handle: `gst-filing`, `partner`. */
  readonly key: string;
}

export interface ConfigVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly entryId: string;
  readonly version: number;
  readonly status: VersionStatus;
  readonly body: Record<string, unknown>;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
}

/** An entry and what it says right now — null when nothing is published yet. */
export interface PublishedEntry {
  readonly entry: ConfigEntry;
  readonly published: ConfigVersion | null;
}

/**
 * How a pinned version is NAMED in a log, an error, or on a screen:
 * `role:partner@2`, `service:gst-filing@7`. The build plan writes rule packs as
 * `gst-in@2026.07`; this is the same idea with a monotonic number instead of a
 * date, which is what the table actually stores.
 *
 * Derived, never a column — a stored copy would eventually disagree with the
 * row it names.
 */
export function configRef(kind: ConfigKind, key: string, version: number): string {
  return `${kind}:${key}@${String(version)}`;
}

/**
 * A key is a handle, not a title: lowercase, url-safe, stable. The label a
 * person reads lives in the body and can be changed freely; the key cannot,
 * because pins and references are written against it.
 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
export const MAX_KEY_LENGTH = 64;

export function isValidKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

// ── Body shapes, one per kind ────────────────────────────────────────────────

/** A role, as a firm defines it. The permission SET is the product's; which of
 *  them this role holds is the firm's. */
export interface RoleBody {
  readonly label: string;
  readonly permissions: readonly Permission[];
}

/** How a service is charged. A closed set because quoting (T2.2) branches on
 *  it — free text here would become an `if` nobody can enumerate. */
export type BillingBasis = "fixed" | "hourly" | "retainer" | "per_unit";

export const BILLING_BASES: readonly BillingBasis[] = [
  "fixed",
  "hourly",
  "retainer",
  "per_unit",
];

/**
 * A catalogue row: what the firm sells, and what it ASKS for it — never what it
 * charged any particular client.
 *
 * The list price is the one thing here that makes pinning worth having. A
 * proposal line stores the `version.id` it was quoted from, so reopening a
 * proposal sent nine months ago answers both halves of the most useful
 * commercial question in the object: what our list price was then, and what we
 * actually charged. The negotiated number lives on the proposal line, with its
 * own currency, FX rate and discount — putting it here would mean publishing a
 * config version per client, and the discount would end up on the proposal
 * anyway.
 *
 * This is T2.5's deferral paying off as intended: the field arrives as a new
 * VERSION of each service, not a migration.
 */
export interface ServiceBody {
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  /** ISO 3166 codes the service is offered in; empty means everywhere. */
  readonly jurisdictions: readonly string[];
  readonly billingBasis: BillingBasis;
  /**
   * What the firm asks for this service, per unit of its billing basis — per
   * hour for `hourly`, per month for `retainer`, per item for `per_unit`, for
   * the whole engagement for `fixed`.
   *
   * OPTIONAL, and that is not laziness: an hourly or retainer service often has
   * no list price until an engagement is scoped, and a firm that has not set one
   * must be able to say so. Null means "we quote it"; it never means zero.
   */
  readonly listPrice: Money | null;
}

/**
 * A rule the firm sets for itself. The first — and for now the only — one is
 * the discount limit T2.2 checks.
 *
 * One entry per policy, keyed by what it governs (`discount`), rather than one
 * fat "settings" row: the registry versions and publishes an ENTRY, so a shared
 * row would mean changing the discount limit republishes every unrelated
 * setting beside it, and the history of each becomes unreadable.
 */
export interface PolicyBody {
  /**
   * The largest discount anybody may put on a proposal line without
   * `proposal:approve` signing it off. A decimal STRING, 0–100, for the same
   * reason amounts are: "12.5" through a float is not reliably 12.5, and a
   * limit that is a hair under what it says refuses a discount that should
   * pass.
   */
  readonly maxDiscountPercent: Amount;
}

const POLICY_FIELDS = ["maxDiscountPercent"];

/** The key of the one policy this product reads today. A firm may define other
 *  `policy` entries; nothing consults them until something does, and that is
 *  the honest state rather than a promise. */
export const DISCOUNT_POLICY_KEY = "discount";

function validatePolicyBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, POLICY_FIELDS);
  if (unknown) return unknown;

  const max = body["maxDiscountPercent"];
  if (typeof max !== "string" || !isAmount(max) || Number(max) > 100) {
    return (
      `"maxDiscountPercent" must be a decimal STRING between "0" and "100" — "15", "12.5" — ` +
      `never a number, for the same reason an amount is not: a float does not hold 12.5 ` +
      `exactly, and a limit a hair under what it says refuses a discount that should pass. ` +
      `Got ${describe(max)}`
    );
  }
  return null;
}

/**
 * The discount limit a stored policy body carries, or null when the firm has
 * not published one.
 *
 * Null is NOT "no limit". The caller treats an unpublished policy as zero — any
 * discount at all needs approval — because a firm that has never set a limit has
 * not decided that anything goes, and the fail-open reading of that silence is
 * the one nobody can audit. See usecase/proposal/service.ts, where the error
 * says exactly that and how to fix it.
 */
export function readMaxDiscountPercent(body: Record<string, unknown>): Amount | null {
  const max = body["maxDiscountPercent"];
  return typeof max === "string" && isAmount(max) ? max : null;
}

/**
 * Validate a body against its kind. Returns the PROBLEM, or null when it is
 * fine — the caller turns the problem into `InvalidBody`, so the message names
 * the field, the bad value and the valid set rather than saying "invalid".
 *
 * Unknown keys are rejected rather than ignored. A body is stored verbatim and
 * read back by name, so `permission: [...]` for `permissions: [...]` would be
 * accepted, saved, and grant nothing — a config change that appears to work and
 * does not is the worst outcome available here.
 */
export function validateBody(kind: ConfigKind, body: Record<string, unknown>): string | null {
  switch (kind) {
    case "role":
      return validateRoleBody(body);
    case "service":
      return validateServiceBody(body);
    case "policy":
      return validatePolicyBody(body);
  }
}

const ROLE_FIELDS = ["label", "permissions"];

function validateRoleBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, ROLE_FIELDS);
  if (unknown) return unknown;

  const label = body["label"];
  if (typeof label !== "string" || label.trim() === "") {
    return `"label" must be a non-empty string, got ${describe(label)}`;
  }

  const permissions = body["permissions"];
  if (!Array.isArray(permissions)) {
    return `"permissions" must be an array, got ${describe(permissions)}`;
  }
  for (const p of permissions) {
    if (typeof p !== "string" || !isPermission(p)) {
      return (
        `"permissions" contains ${describe(p)}, which is not a permission this product checks. ` +
        `Valid: ${PERMISSIONS.join(", ")}`
      );
    }
  }
  return null;
}

const SERVICE_FIELDS = [
  "name",
  "description",
  "category",
  "jurisdictions",
  "billingBasis",
  "listPrice",
];
const LIST_PRICE_FIELDS = ["amount", "currency"];

function validateServiceBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, SERVICE_FIELDS);
  if (unknown) return unknown;

  const name = body["name"];
  if (typeof name !== "string" || name.trim() === "") {
    return `"name" must be a non-empty string, got ${describe(name)}`;
  }
  for (const field of ["description", "category"]) {
    const v = body[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return `"${field}" must be a string or null, got ${describe(v)}`;
    }
  }
  const jurisdictions = body["jurisdictions"];
  if (jurisdictions !== undefined) {
    if (!Array.isArray(jurisdictions)) {
      return `"jurisdictions" must be an array of ISO country codes, got ${describe(jurisdictions)}`;
    }
    for (const j of jurisdictions) {
      if (typeof j !== "string" || j.trim() === "") {
        return `"jurisdictions" contains ${describe(j)}; each entry is a code like "IN" or "SG"`;
      }
    }
  }
  const basis = body["billingBasis"];
  if (typeof basis !== "string" || !(BILLING_BASES as readonly string[]).includes(basis)) {
    return `"billingBasis" must be one of ${BILLING_BASES.join(", ")}, got ${describe(basis)}`;
  }
  return validateListPrice(body["listPrice"]);
}

/**
 * The list price, when there is one.
 *
 * Absent and null are both "we quote it" — a service the firm has not priced is
 * an ordinary state, not an incomplete row. What is refused is a HALF price:
 * an amount with no currency is a number nobody can act on, and a currency with
 * no amount says nothing at all.
 */
function validateListPrice(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return (
      `"listPrice" must be an object like { "amount": "25000.00", "currency": "INR" }, or null ` +
      `for a service the firm quotes case by case. Got ${describe(raw)}`
    );
  }
  const price = raw as Record<string, unknown>;
  const unknown = unknownFields(price, LIST_PRICE_FIELDS);
  if (unknown) return `"listPrice" has ${unknown}`;

  const amount = price["amount"];
  if (typeof amount !== "string" || !isAmount(amount)) {
    // A string, not a number, and the message says why: a float cannot hold
    // 1499.50 exactly, and the error is invisible in one line and material in a
    // total.
    return (
      `"listPrice.amount" must be a non-negative decimal STRING with at most ` +
      `${String(MAX_AMOUNT_SCALE)} decimal places — "25000", "1499.50" — never a number, because ` +
      `a float cannot hold 1499.50 exactly. Got ${describe(amount)}`
    );
  }

  const currency = price["currency"];
  if (typeof currency !== "string" || !isCurrencyCode(normalizeCurrency(currency))) {
    return (
      `"listPrice.currency" must be an ISO 4217 code — three letters, like "INR" or "AED". ` +
      `An amount without one is a number nobody can act on. Got ${describe(currency)}`
    );
  }
  return null;
}

function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return null;
  return (
    `unknown field${extra.length > 1 ? "s" : ""} ${extra.map((e) => JSON.stringify(e)).join(", ")}. ` +
    `A body is stored verbatim and read back by name, so a misspelt field would save and do nothing. ` +
    `Valid: ${allowed.join(", ")}`
  );
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return JSON.stringify(v);
  }
  return Array.isArray(v) ? "an array" : "an object";
}

// ── Reading a stored body back ───────────────────────────────────────────────

/**
 * The permissions a stored role body carries.
 *
 * Filters to permissions the product still checks, which is the fail-closed
 * reading of the two things that can put an unknown one in a stored row: a hand
 * edit, or a permission being REMOVED from the code while rows still name it.
 * In both cases the permission does not exist, so it grants nothing. Bodies are
 * validated at the write, so this only ever fires for those two.
 */
export function readRolePermissions(body: Record<string, unknown>): readonly Permission[] {
  const raw = body["permissions"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Permission => typeof p === "string" && isPermission(p));
}

/** The role's display name, falling back to its key when a stored body somehow
 *  has none — a role with no label is still a role that works. */
export function readRoleLabel(body: Record<string, unknown>, key: string): string {
  const label = body["label"];
  return typeof label === "string" && label.trim() !== "" ? label : key;
}

/** The body a seeded role is written with — the one place the seed's SHAPE is
 *  stated, so tenancy provisioning and the migration agree on more than the
 *  permission list. */
export function roleBodyOf(definition: RoleBody): Record<string, unknown> {
  return { label: definition.label, permissions: [...definition.permissions] };
}
