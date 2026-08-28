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
export type ConfigKind = "service" | "role" | "policy" | "clause";

export const CONFIG_KINDS: readonly ConfigKind[] = ["service", "role", "policy", "clause"];

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
  /**
   * The newest DRAFT sitting beside what is in force, or null when there is
   * none. Newest rather than "the" draft, because 0005's unique index is
   * partial on `published` — any number of drafts may sit beside it — and the
   * one a screen is about to publish is the last one written.
   *
   * It is here because a list that omitted it made the screen fetch each entry
   * again to find out whether anything was waiting, which is precisely the
   * per-row lookup CLAUDE.md says means the join belongs in the query. Worse,
   * once an entry HAD a published version its draft was invisible, so a firm
   * could draft a revision and have nowhere to publish it from.
   */
  readonly pendingDraft: ConfigVersion | null;
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

export function isBillingBasis(v: string): v is BillingBasis {
  return (BILLING_BASES as readonly string[]).includes(v);
}

/**
 * How often a service RECURS — which is NOT how it is priced.
 *
 * `billingBasis` answers "what is the unit of the price" (fixed / hourly /
 * retainer / per_unit); this answers "how often does the work come round". They
 * vary independently and routinely do: a monthly compliance service is commonly
 * billed quarterly. An engagement letter line's `billing_frequency` DEFAULTS
 * from this and is then the letter's own field, because what a particular
 * client is billed is a commercial term of that document, not a property of the
 * catalogue.
 *
 * A closed set for the same reason `billingBasis` is one: a consumer branches
 * on it. `custom` is the honest escape: some services recur on a schedule
 * stated in `scope` prose ("within 15 days of each board meeting") that no
 * closed set can hold, and a scheduler must read `custom` as "a person decides"
 * rather than as a period.
 */
export type ServiceRecurrence = "one_time" | "monthly" | "quarterly" | "annually" | "custom";

export const SERVICE_RECURRENCES: readonly ServiceRecurrence[] = [
  "one_time",
  "monthly",
  "quarterly",
  "annually",
  "custom",
];

export function isServiceRecurrence(v: string): v is ServiceRecurrence {
  return (SERVICE_RECURRENCES as readonly string[]).includes(v);
}

/**
 * The form the two reporting axes (`module`, `group`) are written in.
 *
 * NOT a closed enum, and that is the tenant wall talking: FRC / TRC / RAA is one
 * firm's org chart and this product is sold to many. Firm number two names its
 * departments something else, and a deploy is the wrong price for that.
 *
 * But a bare free string is not enough either, because the entire job of
 * `module` is to be GROUPED BY — and "frc", "FRC " and "FRC" are one department
 * to a person and three groups to Postgres, which splits a revenue report
 * silently and looks like a working dashboard. So the canonical form is required
 * AT THE WRITE, with an error saying how to fix it, rather than normalised at
 * the read: a body is stored verbatim (that is what makes a published version
 * freezable), so a read-time fix would come too late for the
 * `GROUP BY body->>'module'` that runs in SQL.
 *
 * Spaces are allowed inside because the firm's own delivery teams have them —
 * "VCFO CONSOLE" is a real one.
 */
const REPORTING_AXIS_PATTERN = /^[A-Z0-9]+(?:[ _-][A-Z0-9]+)*$/;
export const MAX_REPORTING_AXIS_LENGTH = 48;

export function isReportingAxis(v: string): boolean {
  return v.length <= MAX_REPORTING_AXIS_LENGTH && REPORTING_AXIS_PATTERN.test(v);
}

/** The firm's own service code is short by nature — "A1", "H1", "R7". The cap
 *  is what turns a pasted description into an error at the write instead of a
 *  ruined column on an issued proposal. */
export const MAX_SERVICE_REF_LENGTH = 32;

/** The longest SLA this product will store: ten years from signing. Not a
 *  policy — a fat-finger guard. The mistake it catches is a DATE typed into a
 *  day count (20260315), which would otherwise make a work item due in the year
 *  57000 and look like a feature working. */
export const MAX_SLA_DAYS = 3650;

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
 * This is T2.5's deferral paying off as intended: G2.1–G2.3 restored TEN fields
 * the old services master carried, and every one of them arrives as a new
 * VERSION of each service rather than as a migration. (9ca823f's subject says
 * eleven and is immutable history; its eleventh added line is
 * `StoredServiceBody`'s narrowed re-declaration of `billingBasis`, which is not
 * a new field. Ten new beside the original six is the sixteen below, and the
 * sixteen `SERVICE_FIELDS` the validator accepts.)
 *
 * EVERY FIELD BEYOND THE FIRST SIX IS OPTIONAL, and that is not indecision. A
 * published version is FROZEN, so a field made required would strand every
 * service version already published: they cannot be edited to carry it, and
 * there is no honest value to invent for a body that never said it. Absent
 * therefore reads as "the firm has not stated this" — a real answer at every
 * field below, and one no consumer may quietly turn into a default.
 */
export interface ServiceBody {
  readonly name: string;
  /**
   * The firm's OWN service code — "A1", "H1", "R7" — the handle that runs
   * through its services master, its proposals and its engagement letters
   * alike.
   *
   * DECISION (§4.8 asks for it to be settled and written down): the code lives
   * HERE, in the body, and NOT on `config.entry.key`. Three things settle it.
   *
   *   1. A key is lowercase and url-safe by rule (`isValidKey`); the firm's code
   *      is "A1". Storing "a1" so it passes and upper-casing it to print is a
   *      rendering lie, and the acceptance is that a proposal cites the code the
   *      firm actually uses.
   *   2. A key is the PIN TARGET. Every proposal line and letter line resolves
   *      through `config.entry`, so the key must never move — while a firm
   *      renumbering its services master is an ordinary Tuesday. In the body
   *      that renumber is a new version, which is the mechanism we already have;
   *      on the key it would be a rewrite of documents already issued.
   *   3. The registry guarantees a key is unique per (tenant, kind). The firm's
   *      master guarantees nothing of the sort — codes get reused across a
   *      restructure and some rows have none — so an import would either fail or
   *      invent codes to satisfy a constraint the firm never had.
   *
   * Null for a service the firm's master has no code for.
   */
  readonly ref: string | null;
  readonly description: string | null;
  readonly category: string | null;
  /**
   * The Dept — FRC / TRC / RAA at the firm this was designed against.
   *
   * THE REVENUE REPORTING AXIS: the firm's own dashboard splits revenue by it,
   * and a SPOC is assigned per module (G3.2), which is why a client buying work
   * in two Depts has two SPOCs rather than one account manager.
   */
  readonly module: string | null;
  /**
   * The delivery team — FINCOMPLIANCE, VCFO CONSOLE, PAYROLL.
   *
   * DELIBERATELY NOT NESTED UNDER `module`. FINCOMPLIANCE delivers under both
   * FRC and TRC, so the two are independent dimensions of one service and not a
   * hierarchy. Modelling group as a child of module would make that service
   * unfileable and force a duplicate catalogue row per Dept — which is a second
   * row somebody has to keep in step, and a revenue figure counted twice.
   * Nothing cross-validates the two, for exactly that reason.
   */
  readonly group: string | null;
  /** ISO 3166 codes the service is offered in; empty means everywhere. */
  readonly jurisdictions: readonly string[];
  readonly billingBasis: BillingBasis;
  /**
   * How often the work comes round. See `ServiceRecurrence` — this is not
   * `billingBasis`.
   *
   * Null means the firm has not stated one, and a consumer must NOT read that as
   * `one_time`: defaulting an unstated recurrence would put a `billing_frequency`
   * on an engagement letter that nobody chose and nobody could trace.
   */
  readonly recurrence: ServiceRecurrence | null;
  /**
   * The turnaround the firm commits to, in whole days FROM SIGNING OF THE
   * ENGAGEMENT LETTER. That is the firm's own rule, and it is why this is a day
   * count and not a date: the clock starts at an event the catalogue cannot
   * know about.
   *
   * A number, not a decimal string. The money rule does not reach here — this
   * counts days, not currency, and 30 is exactly 30 in a float.
   *
   * READ IT OFF A PINNED VERSION. A work item copies this value at creation
   * (T3.1) precisely so that a later catalogue revision cannot make finished
   * work retroactively late; reading it live would do exactly that, to work
   * already delivered.
   *
   * Null is "no SLA stated" and it is NOT zero. Zero means due on the day the
   * letter is signed — a commitment somebody made. Null means nobody made one,
   * and a consumer that turns null into 0 invents a breach out of silence.
   */
  readonly slaDays: number | null;
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
  /**
   * WHY there is no list price — "As mutually agreed", "Quoted per jurisdiction
   * on request".
   *
   * `listPrice: null` can say there is no price and cannot say why, and the
   * difference matters to whoever opens the catalogue to quote: "we price this
   * per client" and "nobody has got round to pricing this" are different states
   * that looked identical.
   *
   * Not conditioned on `listPrice` being null. A priced service legitimately
   * carries a note too — "plus statutory fees at actuals" — and a rule refusing
   * that would push the sentence into `description`, where no document prints it
   * next to the money.
   */
  readonly pricingNote: string | null;
  /**
   * THE FOUR SCOPE BLOCKS — `scope`, `clientObligations`, `volumeLimits`,
   * `exclusions`. What an engagement letter is assembled from, and what protects
   * the firm when a client says "we thought that was included".
   *
   * PROSE, AS THE FIRM STATES IT: "under 1,000 entries", "under 8 bank
   * accounts". NOT parsed into typed limits, and that is a decision rather than a
   * shortcut. Nothing in this product is metered, and when a client goes past a
   * ceiling the firm RE-ASSESSES THE ENGAGEMENT — it does not auto-charge. Typed
   * limits would model an enforcement mechanism that does not exist and cannot
   * exist without a usage feed, and the first thing anybody would do with them is
   * trust a number no code compares. If metered billing is ever wanted, that is
   * the point to add structure: with the meter, not years before it.
   *
   * A letter copies these words and may override them per document (G1.6), so
   * the catalogue's wording is the DEFAULT and never the record of what was
   * agreed.
   *
   * What the firm will do.
   */
  readonly scope: string | null;
  /** What the CLIENT must do — "records by the 5th", "bank statements monthly".
   *  Half of every scope dispute lives here, and it is the half a firm forgets
   *  to write down until the second time. */
  readonly clientObligations: string | null;
  /** The ceilings the price assumes — "under 1,000 entries; under 8 bank
   *  accounts". A ceiling, not a meter: see the four-blocks note above. */
  readonly volumeLimits: string | null;
  /** What is NOT included. Stated explicitly, because on a signed document
   *  silence reads as included. */
  readonly exclusions: string | null;
}

/**
 * A stored service body, read back.
 *
 * Every field falls back rather than throwing, for the same reason
 * `readClauseBody` does: a PINNED version must always resolve, and a body that
 * somehow lacks a field must not make a document — or a work item's SLA —
 * unreadable. Bodies are validated at the write, so a fallback only ever fires
 * for a hand edit or for a body published before the field existed.
 *
 * `billingBasis` is the one field with no honest fallback. It is required at the
 * write, so `null` here says "this stored body does not have one" instead of
 * inventing `fixed` and printing a price basis the firm never chose.
 */
export interface StoredServiceBody extends Omit<ServiceBody, "billingBasis"> {
  readonly billingBasis: BillingBasis | null;
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
 * One clause of an engagement letter.
 *
 * PLAIN TEXT, not a template. A substitution syntax invented before anybody has
 * asked for one is a vocabulary nobody chose, and it drags a rendering engine
 * and an escaping story in behind it. If it turns out every letter needs the
 * client's name interpolated, the fix is a new clause VERSION — not a
 * migration — which is exactly why plain text is a safe bet to take first.
 *
 * `jurisdictions` is the same shape services use: ISO 3166 codes, empty meaning
 * everywhere. The LETTER decides which jurisdiction it is written for and picks
 * clauses accordingly; this only says where a clause is applicable — which is
 * NOT the same fact as whose law it names. See `governingLaw`.
 */
export interface ClauseBody {
  readonly title: string;
  readonly text: string;
  readonly jurisdictions: readonly string[];
  /**
   * WHOSE LAW governs, when this clause is the one that says so.
   *
   * The sharpest finding of the project this product was designed against: the
   * real engagement letter was issued by the firm's US entity to a US client,
   * and its standard terms named Indian law and Delhi courts. The verdict was
   * flat — "No. This is wrong. For US it's US. For UAE it's DIFC in Dubai."
   *
   * `jurisdictions` above did not and could not catch that. It says where a
   * clause may be USED; this says what it SAYS. The clause that went out on
   * that letter was applicable in India and named Indian law, and both of those
   * were true — the letter was the wrong place for it. With no field holding
   * the law, the bug is representable again, and nothing in the codebase can
   * see it.
   *
   * Null is the ordinary case rather than an omission: confidentiality, fee and
   * limitation-of-liability clauses name no law at all. It is OPTIONAL for the
   * same reason every field G2.1-G2.3 added is — a published version is FROZEN,
   * so a required field would strand every clause already published and pinned
   * by an issued letter, with no honest value to backfill into terms that never
   * said it.
   *
   * DELIBERATELY NOT CROSS-VALIDATED against `jurisdictions`. A firm may write
   * English law into clauses it uses in three countries, and refusing that here
   * would make one firm's rule a product rule. The check the finding actually
   * asks for is against the ISSUING ENTITY's jurisdiction, which is G1.8's
   * other half (it needs G1.2's `issuing_entity_party_id`, so it is not here).
   */
  readonly governingLaw: JurisdictionalTerm | null;
  /**
   * WHERE a dispute is heard.
   *
   * A second field rather than a sentence inside `governingLaw`, because they
   * are two choices and a firm that has made one has not thereby made the
   * other. Independently optional for that reason: putting a forum on a signed
   * document that nobody chose is the same class of bug as putting a law on it.
   *
   * It carries a jurisdiction of its own because the forum is not derivable
   * from the law: "the DIFC Courts, Dubai" is the firm's own answer for the
   * UAE, and the DIFC is a common-law enclave with its own courts sitting in
   * AE. The seat is what a mismatch check has to compare — half the bug the
   * firm caught was the courts, not the law.
   */
  readonly courts: JurisdictionalTerm | null;
}

/**
 * A term of the contract that belongs to a JURISDICTION: the code that makes it
 * comparable, and the words the document prints. Both halves, because neither
 * can do the other's job.
 *
 *   - The code cannot print. "the laws of the State of Delaware" does not
 *     follow from "US" — US law is state law — and "the DIFC Courts, Dubai"
 *     does not follow from "AE".
 *   - The words cannot be compared. G1.8's acceptance is that a letter issued
 *     by the US entity CANNOT print Indian governing law, and that refusal is a
 *     machine equality test against the issuing entity's jurisdiction. A human
 *     review already let this through once, on a letter that went to a client,
 *     which is the whole reason prose alone is not enough.
 *
 * So the two travel in one object and are validated together: a stored term is
 * never half a statement — a code nobody can print, or a sentence nobody can
 * check.
 */
export interface JurisdictionalTerm {
  /** ISO 3166-1 alpha-2, upper case. The comparable half. */
  readonly jurisdiction: string;
  /** What the letter actually says. The printable half. */
  readonly text: string;
}

/**
 * A jurisdiction code as this product stores it: ISO 3166-1 alpha-2.
 *
 * Duplicated from `domain/engagement/model.ts` on purpose rather than imported.
 * The config registry is UPSTREAM of the engagement module — the engagement
 * side already reads clause bodies through `readClauseBody` — so an import in
 * this direction inverts the dependency and turns into a cycle the day the
 * engagement domain reads a config body. One regex is the cheaper of the two
 * prices, and `tests/config/clause.test.ts` asserts the two agree, so they
 * cannot drift apart quietly.
 */
const JURISDICTION_CODE_PATTERN = /^[A-Z]{2}$/;

const CLAUSE_FIELDS = ["title", "text", "jurisdictions", "governingLaw", "courts"];

/** The two jurisdictional terms a clause may carry, with what each one is FOR.
 *  The message has to say that, because somebody filing "DIFC" needs to know
 *  whether they are naming a legal system or a courthouse. */
const CLAUSE_TERMS = [
  {
    field: "governingLaw",
    what: "whose law governs the engagement",
    example: '{ "jurisdiction": "US", "text": "the laws of the State of Delaware" }',
  },
  {
    field: "courts",
    what: "which courts hear a dispute",
    example: '{ "jurisdiction": "AE", "text": "the DIFC Courts, Dubai" }',
  },
] as const;

const TERM_FIELDS = ["jurisdiction", "text"];

function validateClauseBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, CLAUSE_FIELDS);
  if (unknown) return unknown;

  const title = body["title"];
  if (typeof title !== "string" || title.trim() === "") {
    return `"title" must be a non-empty string, got ${describe(title)}`;
  }
  const text = body["text"];
  if (typeof text !== "string" || text.trim() === "") {
    // An empty clause would publish, pin, and appear on a signed document as
    // nothing — a term the client agreed to that says nothing at all.
    return `"text" must be a non-empty string — a clause with no words is a term the client ` +
      `would be agreeing to that says nothing. Got ${describe(text)}`;
  }
  const jurisdictions = body["jurisdictions"];
  if (jurisdictions !== undefined) {
    if (!Array.isArray(jurisdictions)) {
      return `"jurisdictions" must be an array of ISO country codes, got ${describe(jurisdictions)}`;
    }
    for (const j of jurisdictions) {
      if (typeof j !== "string" || j.trim() === "") {
        return `"jurisdictions" contains ${describe(j)}; each entry is a code like "IN" or "AE"`;
      }
    }
  }

  for (const term of CLAUSE_TERMS) {
    const problem = validateJurisdictionalTerm(term, body[term.field]);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * One jurisdictional term — `governingLaw` or `courts`.
 *
 * Absent and null are both fine and mean the same thing: this clause does not
 * state it. What is refused is a HALF term, for the reason the two halves exist
 * at all — a code with no words prints nothing where a law was supposed to be,
 * and words with no code are invisible to the mismatch check that is the point
 * of the field.
 */
function validateJurisdictionalTerm(
  term: (typeof CLAUSE_TERMS)[number],
  raw: unknown,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return (
      `"${term.field}" is ${term.what} — an object like ${term.example}, or null when this ` +
      `clause does not state it. Got ${describe(raw)}`
    );
  }

  const value = raw as Record<string, unknown>;
  const unknown = unknownFields(value, TERM_FIELDS);
  if (unknown) return `"${term.field}" has ${unknown}`;

  const jurisdiction = value["jurisdiction"];
  if (typeof jurisdiction !== "string" || !JURISDICTION_CODE_PATTERN.test(jurisdiction)) {
    return (
      `"${term.field}.jurisdiction" must be an ISO 3166-1 alpha-2 code in UPPER CASE — "US", ` +
      `"AE", "IN". It is not decoration: it is compared against the jurisdiction of the entity ` +
      `ISSUING the letter, so that terms naming another country's law are refused rather than ` +
      `signed. A body is stored verbatim, so "us" would be stored as written. ` +
      `Got ${describe(jurisdiction)}`
    );
  }

  const text = value["text"];
  if (typeof text !== "string" || text.trim() === "") {
    return (
      `"${term.field}.text" must be a non-empty string — ${term.example} — because the code ` +
      `cannot print: "the laws of the State of Delaware" does not follow from "US", and "the ` +
      `DIFC Courts, Dubai" does not follow from "AE". Got ${describe(text)}`
    );
  }
  return null;
}

/**
 * A stored clause body, read back for assembly onto a letter. Falls back rather
 * than throwing: a pinned version always resolves, and a body that somehow lacks
 * a field should not make a signed document unreadable. That property is why
 * `governingLaw` and `courts` join it as nulls rather than as a validation the
 * read repeats — every clause published before G1.8 is frozen and has neither,
 * and every one of them must still read.
 */
export function readClauseBody(body: Record<string, unknown>): ClauseBody {
  const title = body["title"];
  const text = body["text"];
  const jurisdictions = body["jurisdictions"];
  return {
    title: typeof title === "string" ? title : "",
    text: typeof text === "string" ? text : "",
    jurisdictions: Array.isArray(jurisdictions)
      ? jurisdictions.filter((j): j is string => typeof j === "string")
      : [],
    governingLaw: readJurisdictionalTerm(body["governingLaw"]),
    courts: readJurisdictionalTerm(body["courts"]),
  };
}

/**
 * A jurisdictional term out of a stored body. Absent, malformed and half-stated
 * all read as null — the reading `readServiceListPrice` gives a half price, for
 * a sharper reason: neither half of this is a statement on its own, and null is
 * a true answer ("this clause names no law") where an invented half is not.
 *
 * The code is normalised on the way out, like a currency and unlike the words:
 * it is COMPARED, and "us" and "US" are the same country beyond any doubt, so a
 * hand-edited body still answers the mismatch check instead of quietly falling
 * out of it. The words are handed back verbatim — they are printed on a signed
 * document, and this is not the place to re-render what a firm wrote.
 */
function readJurisdictionalTerm(raw: unknown): JurisdictionalTerm | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const term = raw as Record<string, unknown>;
  const jurisdiction = term["jurisdiction"];
  const text = term["text"];
  if (typeof jurisdiction !== "string" || typeof text !== "string") return null;
  if (text.trim() === "") return null;
  const normalised = jurisdiction.trim().toUpperCase();
  return JURISDICTION_CODE_PATTERN.test(normalised) ? { jurisdiction: normalised, text } : null;
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
    case "clause":
      return validateClauseBody(body);
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

// Order is the order the "Valid: ..." message lists them in, so it reads as the
// shape of a catalogue row: what it is, how it is filed, how it is sold, what it
// promises, what it covers.
const SERVICE_FIELDS = [
  "name",
  "ref",
  "description",
  "category",
  "module",
  "group",
  "jurisdictions",
  "billingBasis",
  "recurrence",
  "slaDays",
  "listPrice",
  "pricingNote",
  "scope",
  "clientObligations",
  "volumeLimits",
  "exclusions",
];
const LIST_PRICE_FIELDS = ["amount", "currency"];

/** The two reporting axes, with what each one is FOR — the error has to say
 *  that, because "must match a pattern" tells a person nothing about whether
 *  they are filing a Dept or a delivery team. */
const REPORTING_AXES = [
  {
    field: "module",
    what: "the Dept revenue is reported by",
    examples: '"FRC", "TRC", "RAA"',
  },
  {
    field: "group",
    what: "the delivery team, an axis independent of module",
    examples: '"FINCOMPLIANCE", "VCFO CONSOLE", "PAYROLL"',
  },
] as const;

/** The four blocks an engagement letter is assembled from. Kept as one list
 *  because they are validated identically and they fail identically. */
const SCOPE_BLOCK_FIELDS = ["scope", "clientObligations", "volumeLimits", "exclusions"];

function validateServiceBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, SERVICE_FIELDS);
  if (unknown) return unknown;

  const name = body["name"];
  if (typeof name !== "string" || name.trim() === "") {
    return `"name" must be a non-empty string, got ${describe(name)}`;
  }

  const ref = body["ref"];
  if (ref !== undefined && ref !== null) {
    if (typeof ref !== "string" || ref.trim() !== ref || ref === "" ||
        ref.length > MAX_SERVICE_REF_LENGTH) {
      return (
        `"ref" is the firm's OWN service code — "A1", "H1", "R7" — a non-empty string of at ` +
        `most ${String(MAX_SERVICE_REF_LENGTH)} characters with no surrounding whitespace, or ` +
        `null for a service the firm's master has no code for. It is printed on proposals and ` +
        `joined on, so " A1" and "A1" must not both exist. Got ${describe(ref)}`
      );
    }
  }

  for (const field of ["description", "category"]) {
    const v = body[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return `"${field}" must be a string or null, got ${describe(v)}`;
    }
  }

  for (const axis of REPORTING_AXES) {
    const v = body[axis.field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !isReportingAxis(v)) {
      return (
        `"${axis.field}" is ${axis.what} — ${axis.examples}, or null when the firm does not ` +
        `file this service under one. Upper case, digits, and single spaces, hyphens or ` +
        `underscores between words, at most ${String(MAX_REPORTING_AXIS_LENGTH)} characters, ` +
        `and no surrounding whitespace: this axis is GROUPED BY, and "frc" beside "FRC" ` +
        `silently splits a revenue report in two. Got ${describe(v)}`
      );
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
  if (typeof basis !== "string" || !isBillingBasis(basis)) {
    return `"billingBasis" must be one of ${BILLING_BASES.join(", ")}, got ${describe(basis)}`;
  }

  const recurrence = body["recurrence"];
  if (recurrence !== undefined && recurrence !== null) {
    if (typeof recurrence !== "string" || !isServiceRecurrence(recurrence)) {
      return (
        `"recurrence" must be one of ${SERVICE_RECURRENCES.join(", ")}, or null when the firm ` +
        `has not stated one. It is how often the service RECURS, which is not how it is priced ` +
        `— that is "billingBasis" (${BILLING_BASES.join(", ")}), and a monthly service billed ` +
        `quarterly needs both. Got ${describe(recurrence)}`
      );
    }
  }

  const slaDays = body["slaDays"];
  if (slaDays !== undefined && slaDays !== null && !isSlaDays(slaDays)) {
    return (
      `"slaDays" must be a whole number of days from 0 to ${String(MAX_SLA_DAYS)} — 7, 30, 90 — ` +
      `counted from signing of the engagement letter, or null for a service with no stated SLA. ` +
      `A NUMBER, not a string: this counts days rather than money, so a float holds it exactly. ` +
      `Null is not zero — zero commits the firm to the day of signing. Got ${describe(slaDays)}`
    );
  }

  for (const field of SCOPE_BLOCK_FIELDS) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      return (
        `"${field}" must be a string or null — the firm's own words, stored as the firm states ` +
        `them ("under 1,000 entries", "under 8 bank accounts") rather than parsed into typed ` +
        `limits, because nothing here is metered and going past a ceiling means the firm ` +
        `re-assesses the engagement. Got ${describe(v)}`
      );
    }
    if (v.trim() === "") {
      return (
        `"${field}" is empty. Use null for a block this service does not state: an empty string ` +
        `prints on an engagement letter as a heading with nothing under it, which is a term the ` +
        `client would be agreeing to that says nothing. Got ${describe(v)}`
      );
    }
  }

  const pricingNote = body["pricingNote"];
  if (pricingNote !== undefined && pricingNote !== null) {
    if (typeof pricingNote !== "string" || pricingNote.trim() === "") {
      return (
        `"pricingNote" must be a non-empty string — "As mutually agreed", "Plus statutory fees ` +
        `at actuals" — or null. It is why there is no list price, so an empty one leaves ` +
        `"listPrice": null saying no more than it already did. Got ${describe(pricingNote)}`
      );
    }
  }

  return validateListPrice(body["listPrice"]);
}

/** A day count the product will store: a whole, non-negative number of days
 *  inside the fat-finger cap. `Number.isInteger` also rejects NaN and Infinity,
 *  which both arrive from a JSON body that did arithmetic on its way here. */
function isSlaDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_SLA_DAYS;
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

/**
 * A stored catalogue body, read back — the ONE reader for `kind='service'`.
 *
 * Everything downstream of the catalogue reads through here rather than reaching
 * into `body["slaDays"]` itself, because the two consumers that matter both read
 * a PINNED, frozen version:
 *
 *   - a work item copies `slaDays` at creation (T3.1), so a catalogue revision
 *     next quarter cannot make finished work retroactively late;
 *   - an engagement letter is assembled from the four scope blocks and defaults
 *     its `billing_frequency` from `recurrence` (G1.6).
 *
 * Both are reading a body that may predate the field they want, which is why
 * every fallback here is a null that means "the firm never stated this" and
 * never a value invented to keep a caller happy.
 */
export function readServiceBody(body: Record<string, unknown>): StoredServiceBody {
  const jurisdictions = body["jurisdictions"];
  const basis = body["billingBasis"];
  const recurrence = body["recurrence"];
  const slaDays = body["slaDays"];
  return {
    // A body with no name still has to print as something, and the caller
    // already holds the key to fall back to — so "" here rather than a guess
    // this function cannot make.
    name: readText(body["name"]) ?? "",
    ref: readText(body["ref"]),
    description: readText(body["description"]),
    category: readText(body["category"]),
    module: readText(body["module"]),
    group: readText(body["group"]),
    jurisdictions: Array.isArray(jurisdictions)
      ? jurisdictions.filter((j): j is string => typeof j === "string")
      : [],
    billingBasis: typeof basis === "string" && isBillingBasis(basis) ? basis : null,
    recurrence:
      typeof recurrence === "string" && isServiceRecurrence(recurrence) ? recurrence : null,
    slaDays: isSlaDays(slaDays) ? slaDays : null,
    listPrice: readServiceListPrice(body["listPrice"]),
    pricingNote: readText(body["pricingNote"]),
    scope: readText(body["scope"]),
    clientObligations: readText(body["clientObligations"]),
    volumeLimits: readText(body["volumeLimits"]),
    exclusions: readText(body["exclusions"]),
  };
}

/**
 * A stored string, or null when there is nothing to print.
 *
 * Blank collapses to null on purpose: absent and "" are the same fact to every
 * consumer here — a document with no exclusions block, a service with no code —
 * and leaving them as two states means every caller downstream writes the same
 * `?.trim() !== ""` test, and one of them eventually forgets.
 */
function readText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The list price out of a stored body. Absent, malformed or half-stated all read
 * as no list price, which is a real state — a service the firm quotes case by
 * case — rather than an error a frozen row could never be edited to fix.
 *
 * The currency is normalised on the way out (the amount is not): a code is
 * COMPARED and grouped, so "inr" beside "INR" splits a total, while "1499.5" and
 * "1499.50" are the same number to the `numeric` that adds them up.
 */
function readServiceListPrice(raw: unknown): Money | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const price = raw as Record<string, unknown>;
  const amount = price["amount"];
  const currency = price["currency"];
  if (typeof amount !== "string" || !isAmount(amount)) return null;
  if (typeof currency !== "string") return null;
  const normalised = normalizeCurrency(currency);
  return isCurrencyCode(normalised) ? { amount, currency: normalised } : null;
}
