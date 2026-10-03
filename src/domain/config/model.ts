// The master configuration registry (P2) — nouns + pure rules.
//
// One internal import, and it is the same argument `domain/scheduler` makes for
// reaching across to `domain/serviceaxis`: `ConfidenceTiers` and what counts as a
// valid confidence are one concept that `domain/agent` already owns, and
// restating the range check here would create two notions of "valid" free to
// drift — with the drift landing on whether a machine may file unattended. The
// wall forbids reaching OUT of domain, not across it.
import type { ConfidenceTiers } from "../agent/model";
import { isConfidence, tiersAreCoherent } from "../agent/model";
// The same argument, one kind later: what a verification rule IS, and which of
// them read a rank, is one concept `domain/verification` already owns. Restating
// it here would create two notions of a valid rule free to drift — with the
// drift landing on who may sign off a statutory filing.
import type { VerificationPolicy } from "../verification/model";
import { VERIFICATION_RULES, isVerificationRule, rulePer } from "../verification/model";
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
import type { Permission, RoleAudience } from "../authz/model";
import { PERMISSIONS, ROLE_AUDIENCES, isPermission, isRoleAudience } from "../authz/model";
import type { Amount, Money } from "../money/model";
import { MAX_AMOUNT_SCALE, isAmount, isCurrencyCode, normalizeCurrency } from "../money/model";

/** The configured things this pass knows about. `rule_pack` joins them when
 *  T4.3 actually reads it — designing a body against no consumer is how a
 *  schema ends up wrong in a way a migration has to undo. `workflow_template`
 *  arrived on exactly those terms: it was deferred at T2.5 and is here now
 *  because T2.7's orchestrator reads it.
 *
 *  `policy` (0010) is the first NON-CATALOGUE kind — a rule the firm sets for
 *  itself rather than something it sells — which is what makes it the honest
 *  test of whether this spine generalises. */
export type ConfigKind =
  | "service"
  | "role"
  | "policy"
  | "clause"
  | "dunning"
  | "workflow_template"
  | "confidence_tier"
  | "verification_policy"
  | "compliance_policy"
  | "escalation"
  | "chaser"
  | "nudge";

export const CONFIG_KINDS: readonly ConfigKind[] = [
  "service",
  "role",
  "policy",
  "clause",
  "dunning",
  "workflow_template",
  "confidence_tier",
  "verification_policy",
  "compliance_policy",
  "escalation",
  "chaser",
  "nudge",
];

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
 *  them this role holds is the firm's, and which SURFACE it is for is the
 *  product's again — a firm renames a role and picks its permissions, it does
 *  not decide that "Client contact" is a staff role. */
export interface RoleBody {
  readonly label: string;
  /** STAFF | CLIENT_PORTAL. Optional and absent means STAFF — see
   *  `RoleDefinition.audience` for why an applied version cannot grow one. */
  readonly audience?: RoleAudience;
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
  /**
   * The `workflow_template` key that says HOW this service is delivered (T2.7).
   *
   * On the SERVICE, because the process is a property of the work: a GST filing
   * and a statutory audit are not done the same way, and a firm-wide default
   * would be a process that fits nothing. The key rather than a version id — the
   * catalogue points at the CURRENT process, and the JOB is what pins the
   * version it started on. Pinning here would freeze every service to whatever
   * the process was the day it was catalogued.
   *
   * Optional like every field past the first six, and null is a real answer:
   * the firm has not written this service's process yet. A job for it WAITS,
   * visibly, rather than running a process nobody wrote.
   */
  readonly workflowTemplateKey: string | null;
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

/**
 * The one `confidence_tier` entry a firm publishes (T2.8).
 *
 * A fixed key because there is one answer per firm today, not one per agent —
 * there are no agents, so there is no accuracy record any per-agent number could
 * be set from, and a threshold chosen by guessing is worse than one that does
 * not exist. When agents exist and differ, this becomes a key per agent and
 * nothing above it changes.
 */
export const CONFIDENCE_TIER_KEY = "default";

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
    case "dunning":
      return validateDunningBody(body);
    case "workflow_template":
      return validateWorkflowTemplateBody(body);
    case "confidence_tier":
      return validateConfidenceTierBody(body);
    case "verification_policy":
      return validateVerificationPolicyBody(body);
    case "compliance_policy":
      return validateCompliancePolicyBody(body);
    case "escalation":
      return validateEscalationBody(body);
    case "chaser":
      return validateChaserBody(body);
    case "nudge":
      return validateNudgeBody(body);
  }
}

const TIER_FIELDS = ["autoCommitAt", "reviewAt"];

/**
 * How sure a machine has to be before it may act unattended (T2.8).
 *
 * **In the registry rather than in a table, and the reason is the question it
 * has to answer.** "Why did this commit on its own?" is asked a year later, and
 * the only true answer is "the bar was 0.95 that day". A published version is
 * frozen and a run PINS the one it was judged under, so that answer survives the
 * firm raising the bar afterwards. `staff_grade` went the other way for the
 * opposite reason: nobody asks what a rung meant last March.
 *
 * Two numbers and no more. A per-agent threshold is a knob nobody can fill
 * today — there are no agents, so there is no accuracy record to set it from —
 * and a knob set by guessing is worse than one that does not exist.
 */
function validateConfidenceTierBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, TIER_FIELDS);
  if (unknown) return unknown;

  const autoCommitAt = body["autoCommitAt"];
  if (typeof autoCommitAt !== "number" || !isConfidence(autoCommitAt)) {
    return (
      `"autoCommitAt" must be a number between 0 and 1, got ${describe(autoCommitAt)}. A ` +
      `machine acts unattended only STRICTLY above it, which is what makes 1 mean "never" — ` +
      `the one edit that stops every unattended commit without a deploy.`
    );
  }

  const reviewAt = body["reviewAt"];
  if (typeof reviewAt !== "number" || !isConfidence(reviewAt)) {
    return `"reviewAt" must be a number between 0 and 1, got ${describe(reviewAt)}`;
  }

  if (!tiersAreCoherent({ autoCommitAt, reviewAt })) {
    return (
      `"reviewAt" (${String(reviewAt)}) is above "autoCommitAt" (${String(autoCommitAt)}), ` +
      `which describes no possible routing. Equal is allowed and means the machine either ` +
      `commits or escalates, with nothing merely proposed.`
    );
  }
  return null;
}

/** Read a published `confidence_tier` body back. Null when the body does not
 *  parse, which the caller reads as "the firm has published nothing usable" and
 *  therefore falls back to asking a person — never to a threshold this code
 *  invented. */
export function readConfidenceTierBody(body: Record<string, unknown>): ConfidenceTiers | null {
  if (validateConfidenceTierBody(body) !== null) return null;
  const autoCommitAt = body["autoCommitAt"];
  const reviewAt = body["reviewAt"];
  if (typeof autoCommitAt !== "number" || typeof reviewAt !== "number") return null;
  return { autoCommitAt, reviewAt };
}

const VERIFICATION_POLICY_FIELDS = ["label", "rule", "minGradeRank", "minGradeCode"];

/**
 * Who may check somebody else's work (T2.9) — the registry's eighth kind.
 *
 * **A kind rather than a column on the tenant, and the reason is the question
 * it has to answer.** "Who was allowed to approve this filing in March?" is
 * asked in an audit, and the only true answer is the rule that was in force
 * that March. A published version is frozen and an approval PINS the version it
 * was opened under, so raising the bar in April restates nothing.
 *
 * **Several per firm, not one.** SQC 1 requires an engagement quality control
 * reviewer to be both suitably qualified AND independent of the engagement
 * team, while an ordinary manager review is precisely the opposite — your own
 * manager, who is on your engagement. Those are two rules inside one process,
 * so a workflow STEP names the policy that governs it and a firm publishes as
 * many as it has kinds of review. `confidence_tier` went the other way, with a
 * fixed key, because there is genuinely one answer per firm there.
 *
 * `minGradeRank` is the RANK, resolved when the policy is written and stored as
 * the number — the opposite of what a `service` body does with an axis code,
 * for a reason that only applies here. A stored code would be re-resolved
 * against today's ladder on every read, and would answer the March question
 * with April's row, defeating the freeze this kind exists for. `minGradeCode`
 * rides along for display and nothing compares it.
 */
function validateVerificationPolicyBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, VERIFICATION_POLICY_FIELDS);
  if (unknown) return unknown;

  const label = body["label"];
  if (typeof label !== "string" || label.trim() === "") {
    return `"label" must be a non-empty string — what a person reading the step sees, like "Manager review"`;
  }

  const rule = body["rule"];
  if (typeof rule !== "string" || !isVerificationRule(rule)) {
    return (
      `"rule" must be one of ${VERIFICATION_RULES.join(", ")}. "rank_threshold" is the firm's ` +
      `stated rule ("Manager or above is fine"); "reporting_line" is the tighter reading ` +
      `("manager means engagement manager") and stalls when that person is away; ` +
      `"reporting_line_or_rank" is both. Got ${describe(rule)}`
    );
  }

  const { usesRank } = rulePer(rule);
  const minGradeRank = body["minGradeRank"];
  const minGradeCode = body["minGradeCode"];

  if (usesRank) {
    if (typeof minGradeRank !== "number" || !Number.isInteger(minGradeRank) || minGradeRank < 1) {
      return (
        `"minGradeRank" must be a whole number above zero — the rank of the lowest grade that ` +
        `may check, taken from the firm's own ladder. Rule ${JSON.stringify(rule)} tests it. ` +
        `Got ${describe(minGradeRank)}`
      );
    }
    if (typeof minGradeCode !== "string" || minGradeCode.trim() === "") {
      return (
        `"minGradeCode" must name the grade "minGradeRank" came from, so a screen can say ` +
        `"Manager" rather than "rank 7". It is never compared — the rank is`
      );
    }
    return null;
  }

  // `reporting_line` tests no rank at all, so carrying one would be a knob that
  // looks live and is not — the shape this codebase keeps catching.
  if (minGradeRank !== null && minGradeRank !== undefined) {
    return (
      `rule "reporting_line" checks only who the maker reports to, so it must not carry a ` +
      `"minGradeRank" — a threshold nothing reads is a setting that looks live. Use ` +
      `"reporting_line_or_rank" to have both.`
    );
  }
  if (minGradeCode !== null && minGradeCode !== undefined) {
    return `rule "reporting_line" tests no grade, so "minGradeCode" must be null`;
  }
  return null;
}

/**
 * Read a published `verification_policy` body back.
 *
 * Null when the body does not parse, and the caller reads that as "the firm has
 * published no usable rule for this step" — which falls back to maker != checker
 * alone, never to a threshold this code invented. Same contract as
 * `readConfidenceTierBody`, and for the same reason.
 */
export function readVerificationPolicyBody(
  body: Record<string, unknown>,
): VerificationPolicy | null {
  if (validateVerificationPolicyBody(body) !== null) return null;
  const label = body["label"];
  const rule = body["rule"];
  if (typeof label !== "string" || typeof rule !== "string" || !isVerificationRule(rule)) {
    return null;
  }
  const minGradeRank = body["minGradeRank"];
  const minGradeCode = body["minGradeCode"];
  return {
    label,
    rule,
    minGradeRank: typeof minGradeRank === "number" ? minGradeRank : null,
    minGradeCode: typeof minGradeCode === "string" ? minGradeCode : null,
  };
}

/**
 * When this firm's compliance calendar goes live — the registry's ninth kind
 * (T3.3, 0055).
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * Obligation generation reaches back ninety days, so a firm onboarding in
 * September with engagements dated May gets four months of obligations whose
 * statutory dates have all passed. Every one of them is genuinely late by the
 * arithmetic — and every one of them was filed months ago, in the Excel this
 * product replaces. Without a floor, a firm's first morning on the decision
 * queue is several hundred rows of questions it already answered, and the one
 * screen whose entire value is being trusted stops being trusted immediately.
 *
 * ── AND WHY IT IS THE FIRM'S ANSWER RATHER THAN OURS ──────────────────────
 *
 * "Do we ask about periods that closed before we started using this?" is a
 * question about how a firm wants to migrate, and it has been sitting open
 * since before the rebuild. A number picked here would be that question
 * answered by whoever wrote the constant. So it is a published policy: the firm
 * sets a date on a screen, the registry versions it, and the ledger shows who
 * moved it — which matters, because moving this date forward makes filings stop
 * being asked about, and that is exactly the kind of change an audit asks about
 * later.
 *
 * ── UNSET IS A REAL ANSWER ────────────────────────────────────────────────
 *
 * A firm that has published nothing has NO floor: every overdue obligation
 * reaches the queue, which is the behaviour the system already has. Unlike the
 * discount policy — where silence means "nothing is allowed" because the
 * fail-open reading cannot be audited — the safe direction here is to show MORE
 * rather than less. A hidden missed deadline is the failure this whole module
 * exists to prevent.
 */
export interface CompliancePolicyBody {
  /**
   * The earliest STATUTORY date the missed-deadline sweep will ask about.
   * `YYYY-MM-DD`, or null for "no floor, ask about everything".
   *
   * A day, never an instant, for the reason every date in the compliance module
   * is: "the 20th" in a process running in one zone is the 19th in another, and
   * for a statutory deadline that is a penalty rather than a rounding error.
   */
  readonly missedFromOn: string | null;
  /**
   * The month the firm's FINANCIAL YEAR begins, 1–12, or null when the firm
   * has not said (T6.13). April is 4.
   *
   * A firm-level fact, and the one the per-period spawn needs before it can
   * cut a quarterly or annual service into periods: a quarter is aligned to
   * the financial year, so "Q2" means Jul–Sep for an Indian firm and Apr–Jun
   * for one on the calendar year, and the difference is a whole quarter of
   * work in the wrong job. A monthly service needs no such fact and spawns
   * without it. An obligation rule carries its OWN `fiscalYearStartMonth`,
   * per jurisdiction, and that stays: the law's year is the law's, this is
   * the firm's.
   *
   * Null is "not stated", never "January". A quarterly service at a firm that
   * has not answered produces no jobs and the sweep says so, which is the
   * shape every silent default in this module was replaced with.
   */
  readonly fiscalYearStartMonth: number | null;
}

const COMPLIANCE_POLICY_FIELDS = ["missedFromOn", "fiscalYearStartMonth"];

/** One entry per firm. There is one calendar, so there is one go-live date —
 *  unlike `policy`, which is keyed by what it governs because a firm has many
 *  unrelated limits. */
export const COMPLIANCE_POLICY_KEY = "default";

/** `YYYY-MM-DD`, and a real day — the fourth copy of this check in `domain/`,
 *  which is the duplication a schema-less layer pays instead of importing
 *  sideways between modules. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(v: string): boolean {
  if (!CALENDAR_DAY.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validateCompliancePolicyBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, COMPLIANCE_POLICY_FIELDS);
  if (unknown) return unknown;

  const from = body["missedFromOn"];
  if (from !== null && from !== undefined) {
    if (typeof from !== "string" || !isCalendarDay(from)) {
      return (
        `"missedFromOn" must be a calendar day as "YYYY-MM-DD" — "2026-04-01" — or null for ` +
        `no floor at all. A day and never a timestamp: a statutory date is the same day in ` +
        `every zone, and an instant is not. Got ${describe(from)}`
      );
    }
  }

  const fy = body["fiscalYearStartMonth"];
  if (fy !== null && fy !== undefined) {
    if (typeof fy !== "number" || !Number.isInteger(fy) || fy < 1 || fy > 12) {
      return (
        `"fiscalYearStartMonth" must be a whole month number from 1 to 12 — 4 for a financial ` +
        `year that starts in April — or null when the firm has not said. Got ${describe(fy)}`
      );
    }
  }
  return null;
}

/**
 * The go-live date a stored compliance policy carries, or null when the firm
 * has not set one.
 *
 * Null is "no floor" rather than "unknown", and both the unpublished case and
 * an explicit null land there on purpose — a firm that has never answered and a
 * firm that answered "ask me about everything" want the same behaviour, and
 * distinguishing them would only produce a third code path nobody reads.
 */
export function readMissedFromOn(body: Record<string, unknown>): string | null {
  const from = body["missedFromOn"];
  return typeof from === "string" && isCalendarDay(from) ? from : null;
}

/**
 * The month the firm's financial year starts, off a stored compliance policy,
 * or null when it has not said. Null is NOT January — see the body type.
 */
export function readFiscalYearStartMonth(body: Record<string, unknown>): number | null {
  const fy = body["fiscalYearStartMonth"];
  return typeof fy === "number" && Number.isInteger(fy) && fy >= 1 && fy <= 12 ? fy : null;
}

// `audience` is last because it arrived last (T6.6) and because the "Valid: ..."
// message reads best as what-it-is, what-it-may-do, where-it-applies.
const ROLE_FIELDS = ["label", "permissions", "audience"];

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

  // OPTIONAL, and its absence is a real value rather than a gap: every role row
  // published before T6.6 has no `audience`, a published version is frozen, and
  // `readRoleAudience` reads the absence as STAFF — which is right for all four
  // of the roles that existed then.
  const audience = body["audience"];
  if (audience !== undefined && (typeof audience !== "string" || !isRoleAudience(audience))) {
    return (
      `"audience" is which surface this role is written for, and ${describe(audience)} is not ` +
      `one. Valid: ${ROLE_AUDIENCES.join(", ")}. A role written for one audience grants ` +
      `NOTHING to a session in the other — a staff role on a client-portal login, and equally ` +
      `a portal permission on a colleague's role.`
    );
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
  "workflowTemplateKey",
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

  const workflowKey = body["workflowTemplateKey"];
  if (workflowKey !== undefined && workflowKey !== null) {
    // Validated as a KEY, not merely as a string, because it resolves against
    // `config.entry.key` — the same shape every other pin target has. Whether a
    // template with this key EXISTS is not checked here: this function is pure,
    // and a firm may catalogue a service before writing its process. The
    // orchestrator is where the absence shows up, and it says so rather than
    // running a process nobody wrote.
    if (typeof workflowKey !== "string" || !isValidKey(workflowKey)) {
      return (
        `"workflowTemplateKey" must be a config key — lowercase, url-safe — naming the ` +
        `workflow_template that says how this service is delivered, or null when the firm has ` +
        `not written that process yet. Got ${describe(workflowKey)}`
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

/**
 * Which surface a stored role is written for.
 *
 * ABSENT MEANS STAFF, and that reading is the whole reason `audience` could be
 * added at all. A published config version is FROZEN, so the role rows every
 * existing firm holds cannot grow a field; they were all written for the staff
 * workspace, and the one that was not — `client_contact` — carried no
 * permissions, so it granted nothing under either reading. Anything unrecognised
 * reads as STAFF too, which is the fail-closed direction: an unknown value must
 * not turn a role into one a client contact can use.
 */
export function readRoleAudience(body: Record<string, unknown>): RoleAudience {
  const audience = body["audience"];
  return typeof audience === "string" && isRoleAudience(audience) ? audience : "STAFF";
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
  return {
    label: definition.label,
    permissions: [...definition.permissions],
    // Written only when the role declares one, so a staff role's body is
    // byte-for-byte what it has always been. That matters beyond tidiness: the
    // role-upgrade migrations (0012, 0045, 0056, 0060, 0064) find a firm that
    // has never edited a role by comparing its body to the old default with
    // jsonb equality, and an added key would make every one of those firms look
    // like a firm that had made a decision.
    ...(definition.audience === undefined ? {} : { audience: definition.audience }),
  };
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
    workflowTemplateKey: readText(body["workflowTemplateKey"]),
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

/**
 * A config body as a login that cannot see fees reads it (B09, audit
 * 2026-10-03): a SERVICE's `listPrice` is the one figure any kind carries, and
 * it is nulled (not dropped, so "you may not see this" never looks like a
 * field nobody wrote). Every other kind, and every other field, is as stored.
 * A new object: the stored body is never touched.
 */
export function bodyWithoutFees(kind: ConfigKind, body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (kind !== "service" || !("listPrice" in body)) return { ...body };
  return { ...body, listPrice: null };
}

/** Whether writing this kind writes a price (B09): a service carries its list
 *  price, so a login that cannot see fees cannot define, draft or publish one. */
export function kindCarriesFees(kind: ConfigKind): boolean {
  return kind === "service";
}

// ── The dunning ladder (T3.5) ──────────────────────────────────────────────

/**
 * What the firm does, and when, about a receivable nobody has paid.
 *
 * A CONFIG KIND rather than a table, and this one fits the registry's own test
 * exactly: D+3, D+7 and D+15 are the firm's numbers, they change, and a partner
 * should be able to move them without a deploy. Versioning earns its keep here
 * too — "which ladder was in force when we put them on hold" is a question that
 * gets asked, and a published version is frozen.
 *
 * ONE ENTRY HOLDS THE WHOLE LADDER, not one entry per rung. The rungs are read
 * together and their ORDER is the meaning; splitting them would make "the
 * ladder" a thing nobody could publish atomically, and a firm could end up
 * halfway between two ladders with D+3 from the old one and D+15 from the new.
 */
export interface DunningBody {
  readonly steps: readonly DunningStep[];
}

export interface DunningStep {
  /** The rung's own key — `d3`, `d7`, `final`. Recorded on every action, so a
   *  row stays readable after the ladder moves under it. Never an index: an
   *  index shifts when a firm inserts a rung, silently renaming history. */
  readonly key: string;
  /** Days past the due date. 0 means the due date itself. */
  readonly afterDays: number;
  readonly action: DunningAction;
  readonly label: string;
}

/**
 * `credit_hold` and `legal` are the two a machine may reach and may not APPLY —
 * they are the things a firm cannot take back with an apology, so they land
 * pending a partner's decision. That is a property of the ACTION, stated here,
 * rather than a flag a firm could clear on a rung by accident.
 */
export type DunningAction = "reminder" | "call" | "credit_hold" | "legal";

export const DUNNING_ACTIONS: readonly DunningAction[] = [
  "reminder",
  "call",
  "credit_hold",
  "legal",
];

const TERMINAL_ACTIONS: readonly DunningAction[] = ["credit_hold", "legal"];

export function isDunningAction(v: string): v is DunningAction {
  return (DUNNING_ACTIONS as readonly string[]).includes(v);
}

/** Whether a rung needs a person. The single place that question is answered,
 *  so the sweep, the API and the schema cannot disagree about it. */
export function needsApproval(action: DunningAction): boolean {
  return TERMINAL_ACTIONS.includes(action);
}

const DUNNING_FIELDS = ["steps"];

function validateDunningBody(body: Record<string, unknown>): string | null {
  const unknown = Object.keys(body).find((k) => !DUNNING_FIELDS.includes(k));
  if (unknown !== undefined) return `unknown field ${JSON.stringify(unknown)}`;

  const steps = body["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    return "steps must be a non-empty array — a ladder with no rungs chases nobody";
  }

  const keys = new Set<string>();
  let previousDays = -1;
  for (const [index, raw] of steps.entries()) {
    if (typeof raw !== "object" || raw === null) return `steps[${String(index)}] must be an object`;
    const step = raw as Record<string, unknown>;

    const key = step["key"];
    if (typeof key !== "string" || key.trim() === "") {
      return `steps[${String(index)}].key must be a non-empty string`;
    }
    // Duplicate keys would collide on `UNIQUE (tenant, invoice, step)` and the
    // second rung would silently never fire — a ladder that looks like it has
    // four rungs and climbs three.
    if (keys.has(key)) return `steps[${String(index)}].key ${JSON.stringify(key)} appears twice`;
    keys.add(key);

    const afterDays = step["afterDays"];
    if (typeof afterDays !== "number" || !Number.isInteger(afterDays) || afterDays < 0) {
      return `steps[${String(index)}].afterDays must be a non-negative whole number of days`;
    }
    // ASCENDING, and refused rather than sorted. A ladder given out of order is
    // a firm that has made a mistake about its own escalation, and quietly
    // reordering it would hide that — while leaving "which rung is next" to
    // depend on how the array happened to be written.
    if (afterDays <= previousDays) {
      return `steps[${String(index)}].afterDays must be greater than the rung before it (${String(previousDays)})`;
    }
    previousDays = afterDays;

    const action = step["action"];
    if (typeof action !== "string" || !isDunningAction(action)) {
      return `steps[${String(index)}].action must be one of ${DUNNING_ACTIONS.join(", ")}`;
    }

    const label = step["label"];
    if (typeof label !== "string" || label.trim() === "") {
      return `steps[${String(index)}].label must be a non-empty string — somebody reads it`;
    }
  }
  return null;
}

/**
 * A stored dunning body, read back.
 *
 * Falls back to an EMPTY ladder rather than throwing, for the reason every
 * reader in this file does: a pinned version must always resolve. An empty
 * ladder chases nobody, which is the safe direction — the alternative would be
 * inventing rungs a firm never published and sending a client a letter it never
 * approved.
 */
export function readDunningBody(body: Record<string, unknown>): DunningBody {
  const raw = body["steps"];
  if (!Array.isArray(raw)) return { steps: [] };
  const steps: DunningStep[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const step = item as Record<string, unknown>;
    const key = step["key"];
    const afterDays = step["afterDays"];
    const action = step["action"];
    const label = step["label"];
    if (
      typeof key !== "string" ||
      typeof afterDays !== "number" ||
      typeof action !== "string" ||
      !isDunningAction(action)
    ) {
      continue;
    }
    steps.push({
      key,
      afterDays,
      action,
      label: typeof label === "string" ? label : key,
    });
  }
  return { steps };
}

/**
 * The rungs that are DUE on an invoice: past their day, and not already taken.
 *
 * Pure, and it is the whole rule the sweep applies. `daysOverdue` is computed
 * by the caller from ISO dates — no `Date` arithmetic here, because a due date
 * is a calendar fact in a jurisdiction and a UTC instant moves it by a day for
 * anyone east or west of Greenwich.
 *
 * Returns EVERY due rung rather than only the next one. A firm whose worker was
 * down for a week should not need seven sweeps to catch up — and each rung is
 * idempotent by its own unique key, so replaying them is safe.
 */
export function dueDunningSteps(
  ladder: DunningBody,
  daysOverdue: number,
  taken: ReadonlySet<string>,
): readonly DunningStep[] {
  return ladder.steps.filter((s) => daysOverdue >= s.afterDays && !taken.has(s.key));
}

// ── The escalation ladder (T4.5) ───────────────────────────────────────────

/**
 * What the firm does, and when, about its OWN work going quiet.
 *
 * The sibling of `dunning` and deliberately not the same entry: that ladder
 * chases a CLIENT about money, this one tells a COLLEAGUE about a deadline.
 * They run on different dates, are read by different people, and a firm will
 * want to change one without touching the other — which a shared entry, frozen
 * and published as a whole, would not allow.
 *
 * A config kind for the reason `dunning` is one: "three days past the internal
 * target and your manager hears about it" is the firm's number, it changes, and
 * "which ladder was in force when this fired" is asked afterwards. NOTHING IS
 * SEEDED — a firm with no published ladder escalates nobody, which is the safe
 * direction. A number this product invented would train everybody to ignore the
 * one screen whose entire value is being believed.
 */
export interface EscalationBody {
  readonly rungs: readonly EscalationRung[];
}

/**
 * The three things a rung can watch, each anchored to a date that already
 * exists. No new date is invented here, and that is the constraint that keeps
 * this honest: an escalation counted from a deadline this product made up would
 * be an escalation nobody could argue with or check.
 *
 *   work_item_due         `work_item.due_on` — the SLA the client was promised,
 *                         snapshotted at creation (G2.3, T3.1).
 *   work_item_unassigned  days since the item was created while NOBODY holds
 *                         it. It has no due date to be late against — T3.1
 *                         leaves an item unassigned rather than guessing a
 *                         wrong SPOC — so the only honest clock is its age.
 *   obligation_target     `obligation_instance.internal_target_on` — the firm's
 *                         own T-X. THE ONE THIS MODULE EXISTS FOR: 0052 says so
 *                         in its own comment, and finding out you are late on
 *                         the day you are late is useless.
 */
export type EscalationWatch = "work_item_due" | "work_item_unassigned" | "obligation_target";

export const ESCALATION_WATCHES: readonly EscalationWatch[] = [
  "work_item_due",
  "work_item_unassigned",
  "obligation_target",
];

export function isEscalationWatch(v: string): v is EscalationWatch {
  return (ESCALATION_WATCHES as readonly string[]).includes(v);
}

/**
 * Who a rung tells.
 *
 * `manager` resolves through `membership.reports_to_user_id` — the firm's own
 * chart, which G3.3 built and `usecase/verification` already walks. It is NOT
 * blocked on G3.4: that task links a login to a PARTY, which answers "which
 * person is this", a different question from "who does this login report to".
 *
 * `grade_at_least` is not resolved to a person at all, and that is the whole
 * point of it — see `min_grade_rank` in migration 0058. "Tell a partner" means
 * every partner can see it, because an escalation routed to one desk is an
 * escalation that dies while that desk is on leave.
 */
export type EscalationTarget = "assignee" | "manager" | "grade_at_least";

export const ESCALATION_TARGETS: readonly EscalationTarget[] = [
  "assignee",
  "manager",
  "grade_at_least",
];

export function isEscalationTarget(v: string): v is EscalationTarget {
  return (ESCALATION_TARGETS as readonly string[]).includes(v);
}

export interface EscalationRung {
  /** The rung's own key — `nudge`, `manager`, `partner`. Recorded on every
   *  notice, so a row stays readable after the ladder moves under it. Never an
   *  index, for `DunningStep.key`'s reason: an index shifts when a firm inserts
   *  a rung and every notice already raised is silently renamed. */
  readonly key: string;
  readonly watch: EscalationWatch;
  /** Days past the date this rung's watch names. 0 means the day itself. */
  readonly afterDays: number;
  readonly notify: EscalationTarget;
  /** The rung a person must hold to see it, when `notify` is `grade_at_least`.
   *  Null otherwise, and the validator refuses the two mismatches — a rank on a
   *  rung that does not use it is a number nobody reads, and a missing one on a
   *  rung that does would escalate to everybody. */
  readonly minGradeRank: number | null;
  readonly label: string;
}

/**
 * A rung of the OUTWARD ladder (T4.4) — when the firm sends a client a reminder
 * about something it asked for and has not had back.
 *
 * ── ITS OWN KIND, AND NOT THE `escalation` KIND WITH FIELDS UNUSED ───────
 *
 * `EscalationRung` carries `watch`, `notify` and `minGradeRank`, and a chase has
 * none of the three: there is ONE thing chased — an open `client_ask` — and it
 * always goes to the client that ask names. Reusing that shape would mean three
 * fields every chaser rung sets to a value nobody reads, and a validator that
 * could no longer refuse a rung that made no sense.
 *
 * ── AND IT HAS NO TARGET AND NO CHANNEL ─────────────────────────────────
 *
 * No channel is on the rung because there is nowhere to send one yet: P10
 * transport is Phase 7, so a chase RAISES the reminder and the client's own
 * action centre shows it. A `channel: "email"` written now would be a field
 * nothing reads and a promise the product cannot keep — the trap this codebase
 * calls a control that looks live and is inert.
 */
export interface ChaserRung {
  /** The rung's own key — `first`, `second`, `final`. Recorded on every chase,
   *  so a row stays readable after the ladder moves under it. Never an index:
   *  an index shifts when a firm inserts a rung and every chase already sent is
   *  silently renamed. `DunningStep.key` and `EscalationRung.key` before it. */
  readonly key: string;
  /** Days since the ask was RAISED. 0 means the day it was raised — allowed,
   *  and a firm that writes it means "remind them the same day", which is a
   *  cadence somebody may genuinely want on a same-day filing. */
  readonly afterDays: number;
  /** What the firm calls this rung. Shown to nobody outside the firm yet; it is
   *  what a colleague reads on the ask's history. */
  readonly label: string;
}

export interface ChaserBody {
  readonly rungs: readonly ChaserRung[];
}

const CHASER_FIELDS = ["rungs"];
const CHASER_RUNG_FIELDS = ["key", "afterDays", "label"];

/**
 * ASCENDING, STRICTLY, across the whole array — and this is where a chaser
 * differs from an escalation and matches DUNNING.
 *
 * `validateEscalationBody` allows each `watch` its own order because its three
 * watches are three independent ladders sharing an entry. A chaser has ONE
 * subject, so its rungs are one sequence and a firm that wrote D+7 before D+3
 * has made a mistake about its own chasing. Refused rather than sorted: quietly
 * reordering hides the mistake, and this ladder's output lands on a client.
 */
function validateChaserBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, CHASER_FIELDS);
  if (unknown) return unknown;

  const rungs = body["rungs"];
  if (!Array.isArray(rungs) || rungs.length === 0) {
    return (
      "rungs must be a non-empty array — a chaser ladder with no rungs reminds nobody, and " +
      "that is what publishing NO ladder already means. An empty one is a firm believing it " +
      "has turned chasing on."
    );
  }

  const keys = new Set<string>();
  let previous = -1;
  for (const [index, raw] of rungs.entries()) {
    if (typeof raw !== "object" || raw === null) return `rungs[${String(index)}] must be an object`;
    const rung = raw as Record<string, unknown>;

    const unknownRung = unknownFields(rung, CHASER_RUNG_FIELDS);
    if (unknownRung) return `rungs[${String(index)}]: ${unknownRung}`;

    const key = rung["key"];
    if (typeof key !== "string" || key.trim() === "") {
      return `rungs[${String(index)}].key must be a non-empty string`;
    }
    // A duplicate key collides on `client_ask_chase_once` and the second rung
    // would silently never fire — a ladder that looks like it has three rungs
    // and climbs two.
    if (keys.has(key)) return `rungs[${String(index)}].key ${JSON.stringify(key)} appears twice`;
    keys.add(key);

    const afterDays = rung["afterDays"];
    if (typeof afterDays !== "number" || !Number.isInteger(afterDays) || afterDays < 0) {
      return `rungs[${String(index)}].afterDays must be a non-negative whole number of days`;
    }
    if (afterDays <= previous) {
      return (
        `rungs[${String(index)}].afterDays must be greater than the rung before it ` +
        `(${String(previous)}) — a chaser has one subject, so its rungs are one sequence`
      );
    }
    previous = afterDays;

    const label = rung["label"];
    if (typeof label !== "string" || label.trim() === "") {
      return `rungs[${String(index)}].label must be a non-empty string`;
    }
  }
  return null;
}

/**
 * A stored chaser ladder, read back — the ONE reader for `kind='chaser'`.
 *
 * A malformed rung is DROPPED rather than defaulted, the same fail-closed
 * reading `readEscalationBody` takes: a rung with no usable `afterDays` read as
 * 0 would remind a client the moment the firm asked, which is the loudest
 * possible misreading of a cadence somebody wrote down carefully.
 */
export function readChaserBody(body: Record<string, unknown>): ChaserBody {
  const raw = body["rungs"];
  if (!Array.isArray(raw)) return { rungs: [] };
  const rungs: ChaserRung[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rung = item as Record<string, unknown>;
    const key = rung["key"];
    const afterDays = rung["afterDays"];
    const label = rung["label"];
    if (
      typeof key !== "string" ||
      typeof afterDays !== "number" ||
      !Number.isInteger(afterDays) ||
      afterDays < 0
    ) {
      continue;
    }
    rungs.push({
      key,
      afterDays,
      label: typeof label === "string" && label.trim() !== "" ? label : key,
    });
  }
  // Sorted on the way OUT, never on the way in. The validator refuses an
  // out-of-order ladder so a firm learns about its own mistake; this is a
  // stored body that may predate a rule or have been hand-edited, and a sweep
  // taking rungs out of order would chase in the wrong sequence rather than
  // refusing to chase at all.
  return { rungs: [...rungs].sort((a, b) => a.afterDays - b.afterDays) };
}

/**
 * A rung of the PROACTIVE ladder (T6.7) — when the firm tells a client a filing
 * of theirs is coming up.
 *
 * ── ITS OWN KIND, AND IT IS NOT `chaser` WITH A MINUS SIGN ──────────────
 *
 * A `ChaserRung` counts FORWARD from the day the firm asked for something and
 * wants an answer back. This counts BACKWARD from a date the LAW set and wants
 * nothing back at all. Reusing `chaser` would need a sign convention on
 * `afterDays`, which is a firm being asked to write `-3` into a field called
 * "after" and hold two ideas in one number — and migration 0067 states the rest
 * of the argument.
 *
 * ── AND IT HAS NO CHANNEL EITHER ────────────────────────────────────────
 *
 * Same reason `ChaserRung` has none: P10 transport is Phase 7, so a nudge is
 * RAISED and the client's own filings list shows it. A `channel: "email"`
 * written now would be a field nothing reads and a promise the product cannot
 * keep.
 */
export interface NudgeRung {
  /** The rung's own key — `week`, `three_days`, `eve`. Recorded on every nudge
   *  so a row stays readable after the ladder moves under it. Never an index. */
  readonly key: string;
  /** Days BEFORE the statutory date. 0 means the day it is due — allowed, and a
   *  firm that writes it means "tell them this morning", which on a same-day
   *  deadline is the most useful rung on the ladder. */
  readonly beforeDays: number;
  /** What the firm calls this rung, for its own screens. */
  readonly label: string;
}

export interface NudgeBody {
  readonly rungs: readonly NudgeRung[];
}

const NUDGE_FIELDS = ["rungs"];
const NUDGE_RUNG_FIELDS = ["key", "beforeDays", "label"];

/**
 * DESCENDING, STRICTLY — and that is the one line where this validator is the
 * mirror of the chaser's rather than a copy of it.
 *
 * `validateChaserBody` demands ascending `afterDays` because its ladder runs
 * away from a day in the past. This one runs TOWARDS a day in the future, so its
 * sequence is 7, then 3, then 1: the same "one subject, one sequence" rule,
 * pointing the other way. A firm that wrote 1 before 7 has made a mistake about
 * its own cadence — refused rather than sorted, because quietly reordering hides
 * it and this ladder's output lands on a client.
 */
function validateNudgeBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, NUDGE_FIELDS);
  if (unknown) return unknown;

  const rungs = body["rungs"];
  if (!Array.isArray(rungs) || rungs.length === 0) {
    return (
      "rungs must be a non-empty array — a nudge ladder with no rungs tells nobody anything, " +
      "and that is what publishing NO ladder already means. An empty one is a firm believing " +
      "it has turned reminders on."
    );
  }

  const keys = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (const [index, raw] of rungs.entries()) {
    if (typeof raw !== "object" || raw === null) return `rungs[${String(index)}] must be an object`;
    const rung = raw as Record<string, unknown>;

    const unknownRung = unknownFields(rung, NUDGE_RUNG_FIELDS);
    if (unknownRung) return `rungs[${String(index)}]: ${unknownRung}`;

    const key = rung["key"];
    if (typeof key !== "string" || key.trim() === "") {
      return `rungs[${String(index)}].key must be a non-empty string`;
    }
    // A duplicate key collides on `obligation_nudge_once` and the second rung
    // would silently never fire — a ladder that looks like it has three rungs
    // and climbs two.
    if (keys.has(key)) return `rungs[${String(index)}].key ${JSON.stringify(key)} appears twice`;
    keys.add(key);

    const beforeDays = rung["beforeDays"];
    if (typeof beforeDays !== "number" || !Number.isInteger(beforeDays) || beforeDays < 0) {
      return (
        `rungs[${String(index)}].beforeDays must be a non-negative whole number of days ` +
        `before the statutory date`
      );
    }
    if (beforeDays >= previous) {
      return (
        `rungs[${String(index)}].beforeDays must be SMALLER than the rung before it ` +
        `(${String(previous)}) — a nudge ladder counts down to a deadline, so 7 comes ` +
        `before 3 comes before 1`
      );
    }
    previous = beforeDays;

    const label = rung["label"];
    if (typeof label !== "string" || label.trim() === "") {
      return `rungs[${String(index)}].label must be a non-empty string`;
    }
  }
  return null;
}

/**
 * A stored nudge ladder, read back — the ONE reader for `kind='nudge'`.
 *
 * A malformed rung is DROPPED rather than defaulted, the fail-closed reading
 * `readChaserBody` and `readEscalationBody` both take. A rung with no usable
 * `beforeDays` read as 0 would tell a client about a filing on the morning it is
 * due and never before, which is the loudest possible misreading of a cadence
 * somebody wrote down carefully.
 */
export function readNudgeBody(body: Record<string, unknown>): NudgeBody {
  const raw = body["rungs"];
  if (!Array.isArray(raw)) return { rungs: [] };
  const rungs: NudgeRung[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rung = item as Record<string, unknown>;
    const key = rung["key"];
    const beforeDays = rung["beforeDays"];
    const label = rung["label"];
    if (
      typeof key !== "string" ||
      typeof beforeDays !== "number" ||
      !Number.isInteger(beforeDays) ||
      beforeDays < 0
    ) {
      continue;
    }
    rungs.push({
      key,
      beforeDays,
      label: typeof label === "string" && label.trim() !== "" ? label : key,
    });
  }
  // Sorted on the way OUT, DESCENDING — furthest from the deadline first, which
  // is the order the sweep climbs them in. Never on the way in: the validator
  // refuses an out-of-order ladder so a firm learns about its own mistake, while
  // this is a stored body that may predate a rule or have been hand-edited.
  return { rungs: [...rungs].sort((a, b) => b.beforeDays - a.beforeDays) };
}

const ESCALATION_FIELDS = ["rungs"];
const RUNG_FIELDS = ["key", "watch", "afterDays", "notify", "minGradeRank", "label"];

function validateEscalationBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, ESCALATION_FIELDS);
  if (unknown) return unknown;

  const rungs = body["rungs"];
  if (!Array.isArray(rungs) || rungs.length === 0) {
    return "rungs must be a non-empty array — a ladder with no rungs tells nobody anything";
  }

  const keys = new Set<string>();
  // ASCENDING WITHIN EACH WATCH, not across the whole array — and this is the
  // one place this validator deliberately differs from dunning's. The three
  // watches are three independent ladders sharing an entry: "day 3 on an
  // unassigned item" and "day 1 past a filing's internal target" are both
  // sensible and neither is out of order. Requiring one global order would
  // force a firm to write a ladder it does not mean.
  const previousByWatch = new Map<string, number>();
  for (const [index, raw] of rungs.entries()) {
    if (typeof raw !== "object" || raw === null) return `rungs[${String(index)}] must be an object`;
    const rung = raw as Record<string, unknown>;

    const unknownRung = unknownFields(rung, RUNG_FIELDS);
    if (unknownRung) return `rungs[${String(index)}]: ${unknownRung}`;

    const key = rung["key"];
    if (typeof key !== "string" || key.trim() === "") {
      return `rungs[${String(index)}].key must be a non-empty string`;
    }
    // Duplicate keys collide on the notice table's unique index, and the second
    // rung would silently never fire — a ladder that looks like it has four
    // rungs and climbs three.
    if (keys.has(key)) return `rungs[${String(index)}].key ${JSON.stringify(key)} appears twice`;
    keys.add(key);

    const watch = rung["watch"];
    if (typeof watch !== "string" || !isEscalationWatch(watch)) {
      return `rungs[${String(index)}].watch must be one of ${ESCALATION_WATCHES.join(", ")}`;
    }

    const afterDays = rung["afterDays"];
    if (typeof afterDays !== "number" || !Number.isInteger(afterDays) || afterDays < 0) {
      return `rungs[${String(index)}].afterDays must be a non-negative whole number of days`;
    }
    const previous = previousByWatch.get(watch) ?? -1;
    // Refused rather than sorted, exactly as the dunning ladder refuses: a
    // ladder given out of order is a firm that has made a mistake about its own
    // escalation, and quietly reordering it hides that.
    if (afterDays <= previous) {
      return (
        `rungs[${String(index)}].afterDays must be greater than the rung before it on the same ` +
        `watch (${String(previous)})`
      );
    }
    previousByWatch.set(watch, afterDays);

    const notify = rung["notify"];
    if (typeof notify !== "string" || !isEscalationTarget(notify)) {
      return `rungs[${String(index)}].notify must be one of ${ESCALATION_TARGETS.join(", ")}`;
    }

    const rank = rung["minGradeRank"];
    if (notify === "grade_at_least") {
      if (typeof rank !== "number" || !Number.isInteger(rank)) {
        return (
          `rungs[${String(index)}].minGradeRank must be a whole number when notify is ` +
          `"grade_at_least" — without it the rung would be visible to everybody. Got ` +
          `${describe(rank)}`
        );
      }
    } else if (rank !== undefined && rank !== null) {
      return (
        `rungs[${String(index)}].minGradeRank belongs only to a "grade_at_least" rung; this one ` +
        `notifies ${JSON.stringify(notify)}, so the rank would be a number nobody reads`
      );
    }

    // `work_item_unassigned` with `notify: assignee` is the one combination
    // that can never do anything: the watch's whole definition is that nobody
    // holds the item. Refused here rather than discovered as a rung that
    // silently notifies nobody every night.
    if (watch === "work_item_unassigned" && notify === "assignee") {
      return (
        `rungs[${String(index)}] watches unassigned work and notifies its assignee — there is ` +
        `never one, which is what "unassigned" means. Notify a manager or a grade instead`
      );
    }

    const label = rung["label"];
    if (typeof label !== "string" || label.trim() === "") {
      return `rungs[${String(index)}].label must be a non-empty string — somebody reads it`;
    }
  }
  return null;
}

/**
 * A stored escalation body, read back.
 *
 * Falls back to an EMPTY ladder rather than throwing, for the reason every
 * reader in this file does: a pinned version must always resolve. An empty
 * ladder escalates nobody, which is the safe direction — the alternative is
 * inventing rungs a firm never published and putting a partner's name on work
 * they were never told about.
 */
export function readEscalationBody(body: Record<string, unknown>): EscalationBody {
  const raw = body["rungs"];
  if (!Array.isArray(raw)) return { rungs: [] };
  const rungs: EscalationRung[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rung = item as Record<string, unknown>;
    const key = rung["key"];
    const watch = rung["watch"];
    const afterDays = rung["afterDays"];
    const notify = rung["notify"];
    const rank = rung["minGradeRank"];
    const label = rung["label"];
    if (
      typeof key !== "string" ||
      typeof watch !== "string" ||
      !isEscalationWatch(watch) ||
      typeof afterDays !== "number" ||
      typeof notify !== "string" ||
      !isEscalationTarget(notify)
    ) {
      continue;
    }
    // A `grade_at_least` rung with no usable rank is DROPPED rather than
    // defaulted. Reading it as rank 0 would make it visible to the whole firm,
    // which is the loudest possible misreading of a rung the firm wrote to
    // reach its seniors.
    if (notify === "grade_at_least" && (typeof rank !== "number" || !Number.isInteger(rank))) {
      continue;
    }
    rungs.push({
      key,
      watch,
      afterDays,
      notify,
      minGradeRank: notify === "grade_at_least" && typeof rank === "number" ? rank : null,
      label: typeof label === "string" ? label : key,
    });
  }
  return { rungs };
}

/**
 * The rungs DUE on one piece of work: watching this date, past their day, and
 * not already climbed on it.
 *
 * Pure, and it is the whole rule the sweep applies — `dueDunningSteps`'s shape,
 * with the watch as the extra filter. `daysPast` is computed by the caller from
 * ISO dates: no `Date` arithmetic here, because a due date is a calendar fact
 * and a UTC instant moves it by a day for anyone east or west of Greenwich.
 *
 * Returns EVERY due rung rather than only the next. A firm whose worker was
 * down for a week should not need seven sweeps to catch up, and each rung is
 * idempotent by its own unique key, so replaying is safe.
 */
export function dueEscalationRungs(
  ladder: EscalationBody,
  watch: EscalationWatch,
  daysPast: number,
  climbed: ReadonlySet<string>,
): readonly EscalationRung[] {
  return ladder.rungs.filter(
    (r) => r.watch === watch && daysPast >= r.afterDays && !climbed.has(r.key),
  );
}

/** One entry per firm. There is one escalation ladder, the same way there is
 *  one compliance go-live date — unlike `policy`, which is keyed by what it
 *  governs because a firm has many unrelated limits. */
export const ESCALATION_KEY = "default";

// ── workflow_template: what a firm's process actually IS (T2.7) ──────────────
//
// Deferred at T2.5 on the stated grounds that designing a body against no
// consumer is how a schema ends up wrong. The consumer exists now: T2.7's
// orchestrator reads a template, writes one `delivery.job_step` per step, and
// walks them.
//
// ── WHY THIS IS CONFIG AND NOT CODE ─────────────────────────────────────────
//
// "How we do a GST filing" is the firm's own knowledge, and today it lives in a
// partner's head. Every firm's is different and every firm's CHANGES. As code it
// would be a deploy per process change, at every firm, forever.
//
// As config it gets the registry's versioning and freezing for free — which is
// the whole reason a job PINS the version it started on. "Why did that filing
// have no review step?" has to be answerable with "because the process in force
// when it started did not have one", not with "the template has changed three
// times since".
//
// ── THE GRAPH IS `dependsOn`, NOT AN ORDER ──────────────────────────────────
//
// One field gives all three shapes the acceptance asks for, and no simpler field
// gives all three:
//
//   SEQUENTIAL  each step depends on the one before it
//   PARALLEL    two steps depend on the SAME step, so both become ready at once
//   BRANCH      a step carries a `condition`; when it does not hold, that step
//               and everything downstream of it is skipped
//
// An ordered array with a "parallel" flag was the other candidate, and it cannot
// express "D waits for both B and C" without inventing groups. A dependency list
// says it directly, and it is what the orchestrator has to evaluate at every
// tick anyway.

/**
 * Who performs a step.
 *
 * **`human` is the ordinary answer, and that is the point.** A firm can write
 * its entire process with every step `human` and it runs end to end TODAY —
 * which is the first goal: get the work that lives in people's heads and in
 * spreadsheets into the product, standardised. Agents are an optimisation
 * applied later, one step at a time, by changing this one field. No template
 * rewrite, no migration.
 *
 * `agent_with_approval` is not "an agent that is a bit careful". It is a
 * DIFFERENT thing from both: the machine produces the output and a person
 * decides whether it stands, which is two records rather than one, and is what
 * T2.9's maker-checker rule is built on.
 */
export type StepExecutor = "human" | "agent" | "agent_with_approval";

export const STEP_EXECUTORS: readonly StepExecutor[] = [
  "human",
  "agent",
  "agent_with_approval",
];

export function isStepExecutor(v: string): v is StepExecutor {
  return (STEP_EXECUTORS as readonly string[]).includes(v);
}

/**
 * The facts a step's condition may test.
 *
 * A CLOSED SET, deliberately, and small. The alternative offered itself and was
 * refused: a little expression language is a vocabulary nobody chose, that no
 * partner can write and no test can cover, and it drags a parser and an
 * evaluation-order story in behind it.
 *
 * Both facts here already EXIST and are unambiguous — this is not a guess about
 * the firm's process. `recurrence` is the service's own, from `ServiceBody`;
 * `jurisdiction` is that of the entity the work is delivered to.
 *
 * **Which facts the firm actually branches on is an open question with the
 * client** — asked, not answered. Adding one is a member here, a case in the
 * orchestrator's fact resolver, and a line of documentation: deliberately cheap,
 * because the answer will name facts nobody has thought of yet.
 */
export type StepFact = "recurrence" | "jurisdiction";

export const STEP_FACTS: readonly StepFact[] = ["recurrence", "jurisdiction"];

export function isStepFact(v: string): v is StepFact {
  return (STEP_FACTS as readonly string[]).includes(v);
}

/**
 * How a condition compares its fact.
 *
 * A CLOSED SET, for `StepFact`'s reason: a little expression language is a
 * vocabulary nobody chose, no partner can write and no test can cover.
 *
 * **All four operate on a STRING fact, because both facts this engine can
 * resolve are strings.** There is deliberately no `gte` / `lte` here yet, and
 * that is not an oversight — it is the same rule this codebase keeps being
 * caught by. The firm's own compliance list (2026-08-30) shows its single most
 * common driver is a THRESHOLD — *"turnover > ₹1 Cr"*, *"AATO ≥ ₹5 Cr"* — but
 * nothing in this schema stores a turnover, an employee count or a paid-up
 * capital. A `gte` offered today would sit in a picker beside `jurisdiction`,
 * compare a string, and be a control that looks live and is inert.
 *
 * They arrive with the first NUMERIC fact, which arrives with the data, which
 * is T3.2's `obligation_template`. **Adding an operator later is backward
 * compatible** — a frozen body naming `equals` still reads. Changing the SHAPE
 * later would not have been, which is why the shape moved now and the operators
 * did not.
 */
export type StepOperator = "equals" | "not_equals" | "in" | "not_in";

export const STEP_OPERATORS: readonly StepOperator[] = [
  "equals",
  "not_equals",
  "in",
  "not_in",
];

export function isStepOperator(v: string): v is StepOperator {
  return (STEP_OPERATORS as readonly string[]).includes(v);
}

/** Whether an operator compares against a LIST rather than a single value. The
 *  one structural difference between them, and the validator and the screen
 *  both ask it rather than restating the membership. */
export function operatorTakesList(op: StepOperator): boolean {
  return op === "in" || op === "not_in";
}

/**
 * When a step applies at all. `null` means always.
 *
 * The value is compared exactly against the resolved fact, which is why both
 * facts are already normalised where they are stored.
 *
 * **A fact the job cannot resolve does NOT skip the step, under ANY operator** —
 * see `usecase/orchestrator`. That rule is easy to get subtly wrong on a
 * negative operator, where "the fact is not X" reads as true when the fact is
 * unknown; it is not true, it is unknown, and skipping on an unknown is how a
 * review step quietly stops happening.
 *
 * ── THE LEGACY SHAPE ────────────────────────────────────────────────────────
 *
 * Bodies written before this operator existed carry `{ fact, equals }` and no
 * `op`. They are read as `equals` forever, and never rewritten: a published
 * config version is FROZEN, which is the whole point of the registry, so the
 * old shape is not a migration to run but a shape to keep parsing. Both are
 * accepted on the way in; only the new one is written.
 */
export interface StepCondition {
  readonly fact: StepFact;
  readonly op: StepOperator;
  /** A single value for `equals` / `not_equals`; a non-empty list for `in` /
   *  `not_in`. `operatorTakesList` is the one place that mapping lives. */
  readonly value: string | readonly string[];
}

/**
 * WHO DOES A STEP, as a band of the firm's own grade ladder (2026-09-18).
 *
 * The firm's first real process says "Analyst / Associate / Senior Associate"
 * on eight steps and "Manager" on the ninth, and a `WorkflowStep` had nowhere
 * to hold that — "who does it" was documentation, and any member of staff could
 * tick any step. Rank AND code, both, exactly as `verification_policy` stores
 * its threshold: the rank is what is compared, the code is what a person reads
 * after the ladder has been re-ranked. Either end open (null) is an open band —
 * "Manager or above" is `min` only. Null on the whole field means anybody,
 * which is every step of every process written before this existed.
 */
export interface StepPerformer {
  readonly minGradeRank: number | null;
  readonly minGradeCode: string | null;
  readonly maxGradeRank: number | null;
  readonly maxGradeCode: string | null;
}

/**
 * ONE LINE OF A STEP'S OWN LIST (T6.15, 2026-09-25): a sub-step the doer ticks,
 * or a review point the checker ticks.
 *
 * The firm's first real process has bullets under every step ("Collect:
 * bank statements, sales data, purchase data ...", "Identify: unreconciled
 * transactions, bank charges ...", and on the manager's review "Check: P&L
 * movements, balance sheet movements ..."), and a `WorkflowStep` had nowhere to
 * put them. The firm asked for a proper checkbox per line and for the step to
 * stay shut until every line is ticked or marked not applicable.
 *
 * A KEY and a label, for `WorkflowStep.key`'s reason: a tick is stored against
 * the key, so renaming a line in a later version never re-labels a tick
 * somebody made against the old wording, and a position would silently move
 * every tick when a firm inserts a line.
 */
export interface ChecklistLine {
  readonly key: string;
  readonly label: string;
}

/** At most this many lines in one list. The firm's longest bullet list is
 *  eight; forty is a step nobody could hold in their head, and past it the
 *  answer is two steps rather than a longer list. */
export const MAX_CHECKLIST_LINES = 40;

/** A line's label, trimmed, is at most this long. It is read on a checkbox. */
export const MAX_CHECKLIST_LABEL = 200;

export interface WorkflowStep {
  /**
   * The step's own key — `collect`, `reconcile`, `review`. Recorded on every
   * `job_step` row, so the row stays readable after the template moves under it.
   *
   * Never an index: an index shifts when a firm inserts a step, silently
   * renaming the history of every job that ever ran. The same argument
   * `DunningStep.key` makes.
   */
  readonly key: string;
  /** What a person reads on the work board. */
  readonly label: string;
  readonly executor: StepExecutor;
  /** Step keys that must be finished or skipped before this one may start.
   *  Empty means it starts as soon as the job does. */
  readonly dependsOn: readonly string[];
  /** When this step applies at all. Null means always. */
  readonly condition: StepCondition | null;
  /**
   * The `verification_policy` key that says WHO checks this step once it is
   * done (T2.9). Null means nobody does — which is what every step did before
   * this field, and is the right default: a firm that has written no review
   * rule must not have one invented for it.
   *
   * The KEY and not a version id, and this is the one place in a workflow body
   * that deliberately reads live. A job PINS its template so editing the
   * process never rewrites work in flight; the review RULE is different, and
   * the difference is what an audit asks about. `step_approval` pins the policy
   * version at the moment a check is opened, which is when "who was allowed to
   * approve this" is actually decided. Pinning it a second time on the template
   * would freeze a firm's review rule to whenever it last edited its process.
   */
  readonly verificationPolicyKey: string | null;
  /** Who is expected to do it — see `StepPerformer`. Null means anybody. */
  readonly performer: StepPerformer | null;
  /**
   * The step's SUB-STEPS (T6.15): ticked, or marked not applicable with a
   * reason, by whoever does the step, and all of them before it can be marked
   * done. Empty means the step is ticked as a whole, which is what every step
   * of every process published before this field meant.
   *
   * Refused on an `agent` step. Nobody would ever tick them there, so a machine
   * acting on its own would finish the step with its list still open, which is
   * a gate with a hole in it. `agent_with_approval` may carry them: the person
   * accepting the machine's answer is the one saying the work is done, and the
   * orchestrator holds them to the list at that moment.
   */
  readonly checklist: readonly ChecklistLine[];
  /**
   * The step's REVIEW POINTS (T6.15): ticked by whoever CHECKS the step, and
   * all of them before it can be approved. Sending it back is never held up by
   * them, because the checker may find the problem at point three.
   *
   * A separate list rather than more sub-steps, and that was decided with the
   * firm (2026-09-25): on its manager review step the process says "Check: P&L
   * movements, balance sheet movements ...", and the person DOING that step is
   * the associate whose work is being reviewed. On the doer's list, the
   * associate would tick "P&L movements reviewed", and the record would say the
   * wrong person checked it. So these follow the check, and a step that names no
   * check may carry none.
   */
  readonly reviewPoints: readonly ChecklistLine[];
}

export interface WorkflowTemplateBody {
  readonly label: string;
  readonly steps: readonly WorkflowStep[];
}

const WORKFLOW_FIELDS = ["label", "steps"];
const WORKFLOW_STEP_FIELDS = [
  "key",
  "label",
  "executor",
  "dependsOn",
  "condition",
  "verificationPolicyKey",
  "performer",
  "checklist",
  "reviewPoints",
];
const PERFORMER_FIELDS = ["minGradeRank", "minGradeCode", "maxGradeRank", "maxGradeCode"];
const CHECKLIST_LINE_FIELDS = ["key", "label"];

/**
 * One of a step's two lists (T6.15), validated in isolation. Returns the
 * complaint or null.
 *
 * ABSENT AND NULL ARE BOTH "NO LINES", and that is forced rather than chosen:
 * every template published before this field has neither list, a published
 * version is FROZEN, and a body that stopped parsing would take the jobs pinned
 * to it along with it. The process editor always writes both as arrays.
 *
 * Keys are unique within ONE list and may repeat across the two, because the
 * two are different lists ticked by different people, and a tick is stored
 * against its list as well as its key.
 */
function validateChecklistLines(
  at: string,
  field: "checklist" | "reviewPoints",
  raw: unknown,
): string | null {
  if (raw === null || raw === undefined) return null;
  const what = field === "checklist" ? "sub-steps" : "review points";
  if (!Array.isArray(raw)) {
    return `${at}.${field} must be a list of ${what}, each { key, label }, or left out for none. Got ${describe(raw)}`;
  }
  if (raw.length > MAX_CHECKLIST_LINES) {
    return (
      `${at}.${field} has ${String(raw.length)} ${what}, and one step holds at most ` +
      `${String(MAX_CHECKLIST_LINES)}. Split the step in two instead: a list that long is ` +
      `a step nobody can hold in their head.`
    );
  }
  const seen = new Set<string>();
  for (const [index, line] of raw.entries()) {
    const here = `${at}.${field}[${String(index)}]`;
    if (typeof line !== "object" || line === null || Array.isArray(line)) {
      return `${here} must be { key, label }. Got ${describe(line)}`;
    }
    const l = line as Record<string, unknown>;
    const unknown = unknownFields(l, CHECKLIST_LINE_FIELDS);
    if (unknown) return `${here}: ${unknown}`;
    const key = l["key"];
    if (typeof key !== "string" || !isValidStepKey(key)) {
      return (
        `${here}.key must be a lowercase handle (2 to 40 characters: letters, digits, "-" or "_"), ` +
        `like "s1" or "bank_statements". A tick is stored against it. Got ${describe(key)}`
      );
    }
    if (seen.has(key)) {
      return `${here}.key ${JSON.stringify(key)} appears twice in this step's ${what}. Each line needs its own key.`;
    }
    seen.add(key);
    const label = l["label"];
    if (typeof label !== "string" || label.trim() === "" || label.trim().length > MAX_CHECKLIST_LABEL) {
      return (
        `${here}.label must be 1 to ${String(MAX_CHECKLIST_LABEL)} characters once spaces are ` +
        `trimmed; somebody reads it beside a checkbox. Got ${describe(label)}`
      );
    }
  }
  return null;
}

/** A stored list, read back. Absent or unreadable reads as NO lines, like every
 *  optional step field before it; the label is trimmed so a tick copies what
 *  the screen shows. */
function readChecklistLines(raw: unknown): readonly ChecklistLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
    .filter((l) => typeof l["key"] === "string" && typeof l["label"] === "string")
    .map((l) => ({ key: l["key"] as string, label: (l["label"] as string).trim() }));
}

/** The band, validated in isolation. Returns the complaint or null. */
function validateStepPerformer(at: string, p: unknown): string | null {
  if (p === null || p === undefined) return null;
  if (typeof p !== "object" || Array.isArray(p)) {
    return `${at}.performer must be an object — { minGradeRank, minGradeCode, maxGradeRank, maxGradeCode } — or null for anybody. Got ${describe(p)}`;
  }
  const b = p as Record<string, unknown>;
  const unknown = unknownFields(b, PERFORMER_FIELDS);
  if (unknown) return `${at}.performer: ${unknown}`;
  for (const side of ["min", "max"] as const) {
    const rank = b[`${side}GradeRank`];
    const code = b[`${side}GradeCode`];
    if (rank !== null && rank !== undefined && (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0)) {
      return `${at}.performer.${side}GradeRank must be a whole number from the firm's grade ladder, or null for an open end. Got ${describe(rank)}`;
    }
    if (code !== null && code !== undefined && (typeof code !== "string" || code.trim() === "")) {
      return `${at}.performer.${side}GradeCode must be the grade's code — "analyst", "manager" — or null. Got ${describe(code)}`;
    }
    if ((rank === null || rank === undefined) !== (code === null || code === undefined)) {
      return `${at}.performer.${side}GradeRank and ${side}GradeCode go together: both the rank that is compared and the code a person reads, or both null for an open end.`;
    }
  }
  const min = b["minGradeRank"];
  const max = b["maxGradeRank"];
  if ((min === null || min === undefined) && (max === null || max === undefined)) {
    return `${at}.performer has both ends open, which means anybody — say null instead, so the intent is on the row.`;
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    return `${at}.performer runs from rank ${String(min)} down to ${String(max)} — the lower rank goes first.`;
  }
  return null;
}

/** A stored band, read back; absent reads as null (anybody), like every
 *  optional step field before it. */
function readStepPerformer(p: unknown): StepPerformer | null {
  if (p === null || p === undefined || typeof p !== "object") return null;
  const b = p as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    minGradeRank: num(b["minGradeRank"]),
    minGradeCode: str(b["minGradeCode"]),
    maxGradeRank: num(b["maxGradeRank"]),
    maxGradeCode: str(b["maxGradeCode"]),
  };
}

/** A step key is a lowercase handle, like a config key and for the same reason:
 *  it is compared, stored on every row, and read in an audit trail. */
const STEP_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/;

export function isValidStepKey(key: string): boolean {
  return STEP_KEY_PATTERN.test(key);
}

function validateWorkflowTemplateBody(body: Record<string, unknown>): string | null {
  const unknown = unknownFields(body, WORKFLOW_FIELDS);
  if (unknown) return unknown;

  const label = body["label"];
  if (typeof label !== "string" || label.trim() === "") {
    return `"label" must be a non-empty string — it is what a partner picks this process by`;
  }

  const steps = body["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    return `"steps" must be a non-empty array — a process with no steps is not a process`;
  }

  const keys = new Set<string>();
  const parsed: { key: string; dependsOn: string[] }[] = [];

  for (const [index, raw] of steps.entries()) {
    const at = `steps[${String(index)}]`;
    if (typeof raw !== "object" || raw === null) return `${at} must be an object`;
    const step = raw as Record<string, unknown>;

    const stepUnknown = unknownFields(step, WORKFLOW_STEP_FIELDS);
    if (stepUnknown) return `${at}: ${stepUnknown}`;

    const key = step["key"];
    if (typeof key !== "string" || !isValidStepKey(key)) {
      return (
        `${at}.key must be a lowercase handle (2-40 chars, letters, digits, "-" or "_") — ` +
        `"reconcile", "manager_review". It is stored on every job's row and read in the ` +
        `audit trail, which is why it is a handle and not a sentence.`
      );
    }
    // A duplicate key would make two rows collide on `UNIQUE (job, step_key)`,
    // and the second step would silently never exist — a process that looks
    // like it has six steps and runs five.
    if (keys.has(key)) return `${at}.key ${JSON.stringify(key)} appears twice`;
    keys.add(key);

    const stepLabel = step["label"];
    if (typeof stepLabel !== "string" || stepLabel.trim() === "") {
      return `${at}.label must be a non-empty string — somebody reads it on the work board`;
    }

    const executor = step["executor"];
    if (typeof executor !== "string" || !isStepExecutor(executor)) {
      return (
        `${at}.executor must be one of ${STEP_EXECUTORS.join(", ")}. "human" is the ordinary ` +
        `answer: a process written entirely of human steps runs today, and a step becomes an ` +
        `agent's later by changing this one field.`
      );
    }

    const dependsOn = step["dependsOn"];
    if (!Array.isArray(dependsOn)) {
      return `${at}.dependsOn must be an array of step keys — empty for a step that starts first`;
    }
    const deps: string[] = [];
    for (const d of dependsOn) {
      if (typeof d !== "string") return `${at}.dependsOn contains ${describe(d)}, not a step key`;
      if (d === key) return `${at}.dependsOn names its own step, which can never be satisfied`;
      if (deps.includes(d)) return `${at}.dependsOn names ${JSON.stringify(d)} twice`;
      deps.push(d);
    }
    parsed.push({ key, dependsOn: deps });

    const condition = step["condition"];
    if (condition !== null && condition !== undefined) {
      if (typeof condition !== "object") return `${at}.condition must be an object or null`;
      const c = condition as Record<string, unknown>;
      // BOTH SHAPES, and the legacy one is not deprecated — it is FROZEN into
      // every version published before operators existed, and a published body
      // can never be rewritten. `equals` alone means `op: "equals"` forever.
      const cUnknown = unknownFields(c, ["fact", "op", "value", "equals"]);
      if (cUnknown) return `${at}.condition: ${cUnknown}`;
      const fact = c["fact"];
      if (typeof fact !== "string" || !isStepFact(fact)) {
        return (
          `${at}.condition.fact must be one of ${STEP_FACTS.join(", ")}. The set is closed on ` +
          `purpose — a free expression is a language nobody can write or test — and it grows ` +
          `by adding a member here when the firm names a condition it actually uses.`
        );
      }

      const legacyEquals = c["equals"];
      const hasLegacy = legacyEquals !== undefined;
      const hasOp = c["op"] !== undefined || c["value"] !== undefined;
      // Refused rather than silently preferring one. A body carrying both is
      // somebody's half-finished edit, and guessing which half they meant is
      // how a step quietly starts applying to the wrong clients.
      if (hasLegacy && hasOp) {
        return (
          `${at}.condition carries both the old "equals" and the newer "op"/"value". Use one: ` +
          `"equals" is the shape published before operators existed and still reads, and ` +
          `{ "op": "equals", "value": … } is what to write now.`
        );
      }

      if (hasLegacy) {
        if (typeof legacyEquals !== "string" || legacyEquals.trim() === "") {
          return `${at}.condition.equals must be a non-empty string`;
        }
      } else {
        const op = c["op"];
        if (typeof op !== "string" || !isStepOperator(op)) {
          return (
            `${at}.condition.op must be one of ${STEP_OPERATORS.join(", ")}. All four compare a ` +
            `STRING, because both facts this engine can resolve are strings — a numeric ` +
            `comparison arrives with the first numeric fact and not before.`
          );
        }
        const value = c["value"];
        if (operatorTakesList(op)) {
          if (!Array.isArray(value) || value.length === 0) {
            return (
              `${at}.condition.value must be a non-empty array for "${op}" — ` +
              `["IN", "AE", "SG"]. An empty list matches nothing, which is a step that never ` +
              `runs rather than a condition somebody meant.`
            );
          }
          for (const v of value) {
            if (typeof v !== "string" || v.trim() === "") {
              return `${at}.condition.value contains ${describe(v)}, not a non-empty string`;
            }
          }
        } else if (typeof value !== "string" || value.trim() === "") {
          return `${at}.condition.value must be a non-empty string for "${op}"`;
        }
      }
    }

    // Shape only. That the key names a policy this firm has actually PUBLISHED
    // is checked at the write by the service, through a directory port — the
    // same division `service` bodies make about an axis code, and for the same
    // reason: this file may not reach a database, and a body frozen years ago
    // must still parse after the policy it names has been retired.
    const policyKey = step["verificationPolicyKey"];
    if (policyKey !== undefined && policyKey !== null) {
      if (typeof policyKey !== "string" || !isValidKey(policyKey)) {
        return (
          `${at}.verificationPolicyKey must be the key of a published verification_policy — ` +
          `"manager_review", "eqcr" — or null for a step nobody checks. Got ${describe(policyKey)}`
        );
      }
    }

    const performerProblem = validateStepPerformer(at, step["performer"]);
    if (performerProblem) return performerProblem;

    // The two lists (T6.15): each well formed on its own, then the two rules
    // that are about the STEP rather than the list.
    const checklistProblem = validateChecklistLines(at, "checklist", step["checklist"]);
    if (checklistProblem) return checklistProblem;
    const reviewProblem = validateChecklistLines(at, "reviewPoints", step["reviewPoints"]);
    if (reviewProblem) return reviewProblem;

    // A machine acting on its own never ticks anything, so a step it finishes
    // unattended would close with its sub-steps still open. Refused at the
    // write, where a partner can fix it, rather than left as a gate with a hole
    // in it. `agent_with_approval` is fine: a person accepts the answer, and is
    // held to the list when they do.
    const hasChecklist = Array.isArray(step["checklist"]) && step["checklist"].length > 0;
    if (hasChecklist && executor === "agent") {
      return (
        `${at} (step ${JSON.stringify(key)}): sub-steps are ticked by a person, and this step is ` +
        `done by a machine on its own. Choose 'A person' or 'Automatically, then a person ` +
        `approves'.`
      );
    }

    // Review points are ticked by whoever CHECKS the step. A step that names no
    // check has nobody to tick them, and the lines would sit there looking like
    // a control while gating nothing.
    const hasReviewPoints = Array.isArray(step["reviewPoints"]) && step["reviewPoints"].length > 0;
    if (hasReviewPoints && (policyKey === null || policyKey === undefined)) {
      return (
        `${at} (step ${JSON.stringify(key)}): review points are ticked by whoever checks this ` +
        `step, and this step names no check. Choose who checks it, or move these to the sub-steps.`
      );
    }
  }

  // Every dependency must name a step this template HAS. A typo would otherwise
  // produce a step that can never become ready, in a job that would sit
  // half-finished forever with nothing saying why.
  for (const step of parsed) {
    for (const dep of step.dependsOn) {
      if (!keys.has(dep)) {
        return (
          `step ${JSON.stringify(step.key)} depends on ${JSON.stringify(dep)}, which this ` +
          `template does not have. Steps: ${[...keys].join(", ")}`
        );
      }
    }
  }

  const cycle = findStepCycle(parsed);
  if (cycle !== null) {
    return (
      `the steps form a cycle — ${cycle.join(" -> ")} — so none of them could ever start. ` +
      `Refused here rather than at run time, because a job that deadlocks is discovered by ` +
      `somebody wondering why nothing happened.`
    );
  }

  return null;
}

/**
 * The first dependency cycle, as the path that closes it, or null.
 *
 * Depth-first with an on-stack marker. Returned as a PATH rather than a boolean
 * because "these three steps form a cycle" is fixable and "this template is
 * invalid" is not — the same reason every refusal in this file names the value.
 */
function findStepCycle(
  steps: readonly { key: string; dependsOn: readonly string[] }[],
): readonly string[] | null {
  const deps = new Map(steps.map((s) => [s.key, s.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function walk(key: string): readonly string[] | null {
    const seen = state.get(key);
    if (seen === "done") return null;
    if (seen === "visiting") return [...path.slice(path.indexOf(key)), key];

    state.set(key, "visiting");
    path.push(key);
    for (const dep of deps.get(key) ?? []) {
      const found = walk(dep);
      if (found !== null) return found;
    }
    path.pop();
    state.set(key, "done");
    return null;
  }

  for (const step of steps) {
    const found = walk(step.key);
    if (found !== null) return found;
  }
  return null;
}

/**
 * One stored condition, in the shape the engine evaluates — the ONE place the
 * legacy `{ fact, equals }` becomes `{ fact, op, value }`.
 *
 * Normalised HERE and nowhere else, so the orchestrator's evaluator never has
 * to know two shapes existed. A published version is frozen, so the old shape
 * is permanent rather than a migration waiting to happen, and every consumer
 * reading it through this function sees one shape forever.
 */
function readStepCondition(raw: unknown): StepCondition | null {
  if (raw === null || raw === undefined) return null;
  const c = raw as Record<string, unknown>;
  const fact = c["fact"] as StepFact;
  const legacy = c["equals"];
  if (typeof legacy === "string") return { fact, op: "equals", value: legacy };
  const op = c["op"];
  const value = c["value"];
  if (typeof op !== "string" || !isStepOperator(op)) return null;
  if (operatorTakesList(op)) {
    return Array.isArray(value) ? { fact, op, value: [...(value as string[])] } : null;
  }
  return typeof value === "string" ? { fact, op, value } : null;
}

/**
 * A stored workflow body, read back — the ONE reader for `kind='workflow_template'`.
 *
 * Returns null rather than throwing when the body is not one, for the reason
 * `readDunningLadder` gives: a caller resolving a PINNED version is reading
 * history, and history that fails to parse is a fact about the past rather than
 * an exception to raise at whoever asked.
 */
export function readWorkflowTemplate(
  body: Record<string, unknown>,
): WorkflowTemplateBody | null {
  if (validateWorkflowTemplateBody(body) !== null) return null;
  const steps = (body["steps"] as Record<string, unknown>[]).map(
    (s): WorkflowStep => ({
      key: s["key"] as string,
      label: s["label"] as string,
      executor: s["executor"] as StepExecutor,
      dependsOn: [...((s["dependsOn"] as string[] | undefined) ?? [])],
      condition: readStepCondition(s["condition"]),
      // Absent reads as null, not as a parse failure. Every template published
      // before T2.9 has no such field, and those are processes a firm is
      // running today — a body that stopped parsing would take their jobs with
      // it. "Nobody checks this step" is exactly what those templates meant.
      verificationPolicyKey:
        typeof s["verificationPolicyKey"] === "string" ? s["verificationPolicyKey"] : null,
      performer: readStepPerformer(s["performer"]),
      // Absent reads as NO lines, and must: every template published before
      // T6.15 has neither list, a published version is frozen, and a job
      // pinned to one of them behaves exactly as it did before.
      checklist: readChecklistLines(s["checklist"]),
      reviewPoints: readChecklistLines(s["reviewPoints"]),
    }),
  );
  return { label: body["label"] as string, steps };
}
