// The lead domain — the commercial pipeline's nouns and pure rules. Stdlib
// only, plus the party vocabulary it shares (domain may import domain).
//
// A lead is an OPPORTUNITY about a party, not a second copy of one. That single
// decision is what makes dedup meaningful: two captures of the same company
// resolve to the same party, and the second appends to the first's timeline
// instead of starting a rival record.
import type { IdentifierType } from "../party/model";

/** Where the opportunity came from. A closed set: reporting on source is the
 *  point of recording it, and free text turns "referral" into four spellings
 *  within a month. */
export type LeadSource = "referral" | "inbound" | "outbound" | "event" | "partner" | "other";

export const LEAD_SOURCES: readonly LeadSource[] = [
  "referral",
  "inbound",
  "outbound",
  "event",
  "partner",
  "other",
];

export function isLeadSource(v: string): v is LeadSource {
  return (LEAD_SOURCES as readonly string[]).includes(v);
}

/**
 * Where the opportunity has got to.
 *
 * A closed set in code for this pass, agreed rather than assumed (2026-08-28).
 * The code branches on these names, so a firm cannot rename them yet and
 * `UnknownStage` says exactly that. They become a config kind when the pipeline
 * screen (T6.2) exists and a firm asks — designing a firm-editable stage
 * vocabulary before either exists is the same trap T2.5 avoided by deferring
 * workflow templates.
 *
 * `abandoned` is NOT a synonym for `lost` (G3.1, build2 §4.4). A prospect who
 * went quiet is a FOLLOW-UP problem; a prospect who chose a competitor is a
 * PRICING problem. They are the firm's two fixable failures and they have
 * opposite remedies, so collapsing them into one stage means the pipeline can
 * report a conversion rate and never say which of the two to go and fix.
 */
export type LeadStage =
  | "new"
  | "contacted"
  | "qualified"
  | "converted"
  | "lost"
  | "abandoned";

export const LEAD_STAGES: readonly LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
  "abandoned",
];

export function isLeadStage(v: string): v is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(v);
}

/** The stages a lead never leaves. Reaching one closes the opportunity and
 *  stamps closed_at; the database CHECK keeps the two in step. */
export const TERMINAL_STAGES: readonly LeadStage[] = ["converted", "lost", "abandoned"];

export function isTerminalStage(stage: LeadStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function isOpen(stage: LeadStage): boolean {
  return !isTerminalStage(stage);
}

/**
 * The terminal stages that did NOT win, and therefore owe an explanation.
 *
 * `converted` is deliberately absent: a won deal has no lost reason, and a field
 * that accepted one on it would collect notes nothing ever reads. The database
 * says the same thing (`lead_lost_reason_scope_chk`, migration 0030), because a
 * rule only in TypeScript is one an import or a psql session walks straight
 * past.
 */
export const CLOSED_UNWON_STAGES: readonly LeadStage[] = ["lost", "abandoned"];

export function recordsLostReason(stage: LeadStage): boolean {
  return CLOSED_UNWON_STAGES.includes(stage);
}

export interface Lead {
  readonly id: string;
  readonly tenantId: string;
  /**
   * What this opportunity is called.
   *
   * The opportunity's OWN name, not the client's. Before it existed every list
   * rendered `party.displayName`, so a firm quoting one client for two things
   * saw the same row twice with nothing distinguishing them — and the read
   * model already carries the party name beside this, so a title that merely
   * repeated it would add nothing.
   *
   * Never empty and never whitespace: `lead_title_present_chk` in migration
   * 0030 says so at the table, because "  " satisfies NOT NULL and renders as
   * the same blank row the column was added to prevent.
   */
  readonly title: string;
  /** The party this opportunity is about. Never null — a lead with no party is
   *  the duplicate-prospect problem this model exists to avoid. */
  readonly partyId: string;
  readonly source: LeadSource;
  readonly stage: LeadStage;
  /** Whose desk it is on, or null for the unassigned queue. */
  readonly ownerUserId: string | null;
  /**
   * Where the PROSPECT is — ISO 3166-1 alpha-2, or null when nobody has said.
   *
   * Null is ordinary and must stay cheap: a prospect's country often is not
   * known when they phone in, and a capture must never be refused for it. The
   * rotation is what answers for an unknown country, which is why there is no
   * wildcard territory rule.
   *
   * It is the axis territory assignment matches on, and it is also the answer
   * `ProposalService.draft` needs for `clientJurisdiction` — which decides
   * which of the firm's own entities contracts. The pipeline was the only stage
   * of this product that did not record a jurisdiction.
   */
  readonly jurisdiction: string | null;
  /**
   * What the opportunity could be worth — an ESTIMATE, not a quote (0310).
   *
   * Null is ordinary: nobody knows the value when a prospect first phones in,
   * and a capture must never be refused for it. The currency travels with the
   * amount, and the service writes the firm's reporting currency, so every lead
   * in a firm compares with every other and a value filter means something.
   */
  readonly estimatedValue: LeadValue | null;
  readonly notes: string | null;
  /**
   * Why it did not close won, in the closer's own words.
   *
   * FREE TEXT, and that is the decision rather than the easy option: a dropdown
   * of five reasons produces five reasons and the useful one is always the
   * sixth. Null on an open lead and on a converted one (the database refuses
   * anything else); null on a lead closed before 0030, which honestly means
   * nobody was asked.
   *
   * Distinct from `notes`, which is about the opportunity while it is live.
   * This is the one sentence somebody writes at the moment they know the answer
   * and will not be able to reconstruct a month later.
   */
  readonly lostReason: string | null;
  readonly capturedAt: string;
  readonly closedAt: string | null;
}

/** An amount and its currency. The amount is a DECIMAL STRING, never a JS
 *  number — the product-wide money rule. */
export interface LeadValue {
  readonly amount: string;
  readonly currency: string;
}

/**
 * The shape an estimate is accepted in: up to sixteen whole digits and two
 * decimal places, no sign, no separators — what `numeric(18,2)` holds exactly.
 * "5,00,000" and "5e5" are refused rather than guessed at, because a value a
 * person typed wrong and the system reinterpreted is worse than a refusal.
 */
const ESTIMATED_VALUE_PATTERN = /^\d{1,16}(?:\.\d{1,2})?$/;

export function isEstimatedValue(v: string): boolean {
  return ESTIMATED_VALUE_PATTERN.test(v);
}

/**
 * The one spelling of an estimate: no leading zeros, exactly two places —
 * what Postgres hands back from `numeric(18,2)`. Canonical BEFORE it is
 * written, so "500000" and "500000.00" are one value to every comparison,
 * including "did this edit change anything". Pure string work: the amount
 * never passes through a JS number.
 */
export function normalizeEstimatedValue(v: string): string {
  const [whole = "0", fraction = ""] = v.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  return `${digits}.${fraction.padEnd(2, "0")}`;
}

// ── Dedup ────────────────────────────────────────────────────────────────────

/**
 * The identifiers a capture is deduplicated on: **phone, PAN, email**.
 *
 * These three because they are what a lead actually ARRIVES with — a web form,
 * a business card, a referral email — and a dedup key nobody supplies never
 * fires. PAN is the strong one: a legal identity, one per entity. Email and
 * phone are weaker but are what a prospect hands over.
 *
 * A registration number like GSTIN or CIN would be safe to match on too, and is
 * left out only because a lead seldom carries one at capture. That direction is
 * the safe one to be wrong in: ADDING a type here later can only find more
 * duplicates, while removing one cannot un-merge the records already joined by
 * it. So the set starts narrow and grows when a firm's actual intake shows what
 * it receives.
 *
 * Matching is on the NORMALISED value (domain/party/model.ts
 * `normalizeIdentifier`), so "Priya@Example.COM " and "priya@example.com" are
 * the same prospect, and " +91 98765 43210" and "+919876543210" are one phone.
 */
export const DEDUP_IDENTIFIER_TYPES: readonly IdentifierType[] = ["email", "phone", "pan"];

export function isDedupIdentifier(type: IdentifierType): boolean {
  return DEDUP_IDENTIFIER_TYPES.includes(type);
}

/**
 * What a capture matched, before anything is written.
 *
 * `parties` is the DISTINCT set of parties the supplied identifiers resolved
 * to. More than one is not a merge — it means the firm's data already holds
 * the same counterparty twice, and picking one would silently attach the
 * opportunity to whichever the query happened to return first.
 */
export interface DedupMatch {
  readonly parties: readonly string[];
  /** Which supplied identifiers already exist, by their position in the input,
   *  so the caller attaches only the genuinely new ones. */
  readonly existingByIndex: ReadonlyMap<number, string>;
}

export function matchedParty(match: DedupMatch): string | null {
  return match.parties.length === 1 ? (match.parties[0] ?? null) : null;
}

export function isAmbiguous(match: DedupMatch): boolean {
  return match.parties.length > 1;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Whether a lead may move from one stage to another.
 *
 * Deliberately permissive in one direction and absolute in the other: any open
 * stage may move to any other, because real pipelines go backwards — a
 * "qualified" prospect who stops answering is "contacted" again, and a workflow
 * that forbids it just teaches people to lie to it. What is refused is leaving
 * a TERMINAL stage, because a converted, lost or abandoned lead is finished; a
 * prospect who returns is a new opportunity, which is exactly what the
 * one-open-lead-per-party index leaves room for — and since 0030 that index
 * treats `abandoned` as closed too, so going quiet does not lock a prospect out
 * of the pipeline for good.
 */
export function canMoveStage(from: LeadStage, to: LeadStage): boolean {
  if (isTerminalStage(from)) return false;
  return from !== to;
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * How a firm decides whose desk an unclaimed lead lands on.
 *
 * ONE member, and that is the honest state of it rather than a stub. Round
 * robin is buildable against what the schema already holds — the roster and the
 * pipeline. **Territory is not**, because nothing here has a territory concept
 * and its axis (geography, industry, service line) has never been chosen with
 * the client. Inventing one means a mapping table with a firm's data in it
 * before anybody finds out it is the wrong axis, and a mapping table with rows
 * in it is far harder to withdraw than an empty seam.
 *
 * It is a CLOSED TYPE with one member rather than a bare string so that the day
 * an axis is agreed, `"territory"` is a one-line change here, the new strategy
 * names itself on the timeline, and every report that groups leads by how they
 * were assigned keeps working across the change.
 */
export type AssignmentPolicy = "round_robin" | "territory";

/**
 * Whose desk covers leads from a country (T2.1b).
 *
 * One row per country per firm — the twin of `crm.firm_entity_preference`, and
 * the same question asked of a different table: that one answers "which of our
 * entities serves a client in X", this one answers "whose desk covers a lead
 * from X". There is deliberately NO wildcard: assignment already has a better
 * fallback than a catch-all row, which is the rotation.
 */
export interface TerritoryRule {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly jurisdiction: string;
  readonly ownerUserId: string;
  /** Why the firm drew the line here. Null on a row nobody has explained. */
  readonly note: string | null;
}

/**
 * Where a lead's owner came from — recorded on `lead.captured`, so a firm can
 * ask "did a person put this here, or did the rotation?" a year later.
 *
 * `requested` is not a policy; it is the absence of one. Somebody named the
 * owner at capture and no strategy was consulted, which is a materially
 * different fact from the rotation happening to pick the same person.
 */
export type OwnerSource = "requested" | AssignmentPolicy;
