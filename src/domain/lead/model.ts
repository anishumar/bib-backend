// Lead domain: the pipeline's nouns and pure rules. A lead is an OPPORTUNITY
// about a party, not a copy of one, so dedup resolves two captures of the same
// company to one party and the second appends to the first's timeline.
import type { IdentifierType } from "../party/model";

/** Where the opportunity came from. A closed set: free text breeds four spellings of "referral". */
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
 * Pipeline stage. Closed in code (agreed 2026-08-28), so a firm cannot rename
 * one yet (`UnknownStage`); it becomes a config kind once the pipeline screen
 * (T6.2) exists and a firm asks, as T2.5 deferred workflow templates.
 *
 * `abandoned` is not `lost` (G3.1, build2 §4.4): went quiet is a FOLLOW-UP
 * problem, chose a competitor is a PRICING problem. One stage for both would
 * hide which of the two to fix.
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

/** Stages a lead never leaves; reaching one stamps closed_at (a DB CHECK keeps them in step). */
export const TERMINAL_STAGES: readonly LeadStage[] = ["converted", "lost", "abandoned"];

export function isTerminalStage(stage: LeadStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function isOpen(stage: LeadStage): boolean {
  return !isTerminalStage(stage);
}

/** Unwon terminal stages, which owe a lost reason. `converted` never takes one;
 *  the DB says so too (`lead_lost_reason_scope_chk`, 0030) for imports and psql. */
export const CLOSED_UNWON_STAGES: readonly LeadStage[] = ["lost", "abandoned"];

export function recordsLostReason(stage: LeadStage): boolean {
  return CLOSED_UNWON_STAGES.includes(stage);
}

export interface Lead {
  readonly id: string;
  readonly tenantId: string;
  /** The opportunity's own name, not the client's, so two quotes for one client
   *  are told apart. Never blank: `lead_title_present_chk` (0030), since "  "
   *  satisfies NOT NULL. */
  readonly title: string;
  /** Never null: a lead with no party is the duplicate-prospect problem. */
  readonly partyId: string;
  readonly source: LeadSource;
  readonly stage: LeadStage;
  /** Whose desk it is on, or null for the unassigned queue. */
  readonly ownerUserId: string | null;
  /**
   * Where the PROSPECT is: ISO 3166-1 alpha-2, or null when unknown (a capture
   * is never refused for it). Territory assignment matches on it, with no
   * wildcard rule: the rotation answers for null. Also the
   * `clientJurisdiction` `ProposalService.draft` needs to pick the contracting entity.
   */
  readonly jurisdiction: string | null;
  /** An ESTIMATE, not a quote (0310); null is ordinary. Always in the firm's
   *  reporting currency, so values compare and filter across the firm. */
  readonly estimatedValue: LeadValue | null;
  readonly notes: string | null;
  /**
   * Why it did not close won, as FREE TEXT (a dropdown never holds the useful
   * sixth reason). Null when open or converted (the DB refuses otherwise), and
   * on leads closed before 0030, meaning nobody was asked. Unlike `notes`, it
   * is written once, at the close.
   */
  readonly lostReason: string | null;
  readonly capturedAt: string;
  readonly closedAt: string | null;
  /** Set when DELETED as entered by mistake (0086). Not an unwon stage: there
   *  was no real prospect, so it leaves the pipeline and every count. The row
   *  stays, resolves by id, and is FINAL. */
  readonly deletedAt: string | null;
  /** Who deleted it, for the page; null only when nobody human did. The
   *  ledger's `lead.deleted` names the actor either way. */
  readonly deletedByUserId: string | null;
}

/** Amount is a DECIMAL STRING, never a JS number (the money rule). */
export interface LeadValue {
  readonly amount: string;
  readonly currency: string;
}

/** Up to 16 digits and 2 decimals, no sign or separators: what `numeric(18,2)`
 *  holds. "5,00,000" and "5e5" are refused, never reinterpreted. */
const ESTIMATED_VALUE_PATTERN = /^\d{1,16}(?:\.\d{1,2})?$/;

export function isEstimatedValue(v: string): boolean {
  return ESTIMATED_VALUE_PATTERN.test(v);
}

/** Canonical spelling (no leading zeros, two places, as Postgres returns
 *  `numeric(18,2)`), applied before writing so "500000" and "500000.00" compare
 *  equal. String work only: never a JS number. */
export function normalizeEstimatedValue(v: string): string {
  const [whole = "0", fraction = ""] = v.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  return `${digits}.${fraction.padEnd(2, "0")}`;
}

/**
 * Capture dedups on **phone, PAN, email**: what a lead actually arrives with
 * (PAN is the strong one, one per entity). GSTIN/CIN would be safe but seldom
 * arrive at capture. Adding a type later only finds more duplicates; removing
 * one cannot un-merge, so the set starts narrow. Matching is on the normalised
 * value (`normalizeIdentifier`, domain/party/model.ts).
 */
export const DEDUP_IDENTIFIER_TYPES: readonly IdentifierType[] = ["email", "phone", "pan"];

export function isDedupIdentifier(type: IdentifierType): boolean {
  return DEDUP_IDENTIFIER_TYPES.includes(type);
}

/** What a capture matched, before any write. More than one party is not a
 *  merge: the firm already holds the counterparty twice, and picking one would
 *  be arbitrary. */
export interface DedupMatch {
  readonly parties: readonly string[];
  /** Supplied identifiers that already exist, by input position, so only the
   *  new ones are attached. */
  readonly existingByIndex: ReadonlyMap<number, string>;
}

export function matchedParty(match: DedupMatch): string | null {
  return match.parties.length === 1 ? (match.parties[0] ?? null) : null;
}

export function isAmbiguous(match: DedupMatch): boolean {
  return match.parties.length > 1;
}

/**
 * Any open stage may move to any other (real pipelines go backwards); a
 * TERMINAL stage never moves. A returning prospect is a new lead, which the
 * one-open-lead-per-party index allows; since 0030 it treats `abandoned` as closed too.
 */
export function canMoveStage(from: LeadStage, to: LeadStage): boolean {
  if (isTerminalStage(from)) return false;
  return from !== to;
}

/**
 * Why a lead may NOT be deleted, or null when it may (0086). Deletion is for a
 * lead ENTERED BY MISTAKE:
 *   deleted   — it already was; final.
 *   converted — a win is not a mistake.
 *   closed    — lost/abandoned is in the pipeline's numbers, so only an
 *               administrator may (often how a mistake was put away).
 *   proposals — a live proposal came from it; delete that first.
 * WHO before WHAT: a caller who may not delete a closed lead is told so before
 * being sent to delete its proposals.
 */
export type LeadDeletionBlock =
  | { readonly kind: "deleted" }
  | { readonly kind: "converted" }
  | { readonly kind: "closed"; readonly stage: LeadStage }
  | { readonly kind: "proposals"; readonly refs: readonly string[] };

export function leadDeletionBlock(
  lead: Pick<Lead, "stage" | "deletedAt">,
  liveProposalRefs: readonly string[],
  callerAdministers: boolean,
): LeadDeletionBlock | null {
  if (lead.deletedAt !== null) return { kind: "deleted" };
  if (lead.stage === "converted") return { kind: "converted" };
  if (recordsLostReason(lead.stage) && !callerAdministers) {
    return { kind: "closed", stage: lead.stage };
  }
  if (liveProposalRefs.length > 0) return { kind: "proposals", refs: liveProposalRefs };
  return null;
}

/** Which rule picks the desk for an unclaimed lead. A closed type, so each
 *  strategy names itself on the timeline and reports grouped by it survive a
 *  new one. Territory's axis is the prospect's country (T2.1b, 0026). */
export type AssignmentPolicy = "round_robin" | "territory";

/** Whose desk covers leads from a country (T2.1b): one row per country per
 *  firm, the twin of `crm.firm_entity_preference`. No wildcard row: the
 *  rotation is the fallback. */
export interface TerritoryRule {
  readonly id: string;
  readonly tenantId: string;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly jurisdiction: string;
  readonly ownerUserId: string;
  /** Why the firm drew the line here. Null on a row nobody has explained. */
  readonly note: string | null;
}

/** How a lead's owner was chosen, recorded on `lead.captured`. `requested`
 *  means a person named the owner and no strategy ran: a different fact from
 *  the rotation picking the same person. */
export type OwnerSource = "requested" | AssignmentPolicy;
