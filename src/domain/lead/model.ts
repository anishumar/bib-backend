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
 */
export type LeadStage = "new" | "contacted" | "qualified" | "converted" | "lost";

export const LEAD_STAGES: readonly LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
];

export function isLeadStage(v: string): v is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(v);
}

/** The stages a lead never leaves. Reaching one closes the opportunity and
 *  stamps closed_at; the database CHECK keeps the two in step. */
export const TERMINAL_STAGES: readonly LeadStage[] = ["converted", "lost"];

export function isTerminalStage(stage: LeadStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function isOpen(stage: LeadStage): boolean {
  return !isTerminalStage(stage);
}

export interface Lead {
  readonly id: string;
  readonly tenantId: string;
  /** The party this opportunity is about. Never null — a lead with no party is
   *  the duplicate-prospect problem this model exists to avoid. */
  readonly partyId: string;
  readonly source: LeadSource;
  readonly stage: LeadStage;
  /** Whose desk it is on, or null for the unassigned queue. */
  readonly ownerUserId: string | null;
  readonly notes: string | null;
  readonly capturedAt: string;
  readonly closedAt: string | null;
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
 * a TERMINAL stage, because a converted or lost lead is finished; a prospect who
 * returns is a new opportunity, which is exactly what the one-open-lead-per-party
 * index leaves room for.
 */
export function canMoveStage(from: LeadStage, to: LeadStage): boolean {
  if (isTerminalStage(from)) return false;
  return from !== to;
}
