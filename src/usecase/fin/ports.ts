// FinCompliance's seams (docs/FIN_BUILD_PLAN.md). Adapters live in
// `infrastructure/fin/`; nothing in core implements or calls these.
import type { DocumentKind } from "../../domain/filestore/model";
import type { IntakeRoute, RouteBasis } from "../../domain/fin/intake";

/** Which firms fin works for. The switch is `tenancy.tenant.fin_enabled_since`
 *  (0381), set by the platform; NULL is off. */
export interface FinFirms {
  /** Active firms with fin switched on — the one read above RLS, ids only, as
   *  every sweep's tenant list is. */
  enabledFirmIds(): Promise<readonly string[]>;
  /** When fin was switched on for this firm (ISO 8601), or null when it is off
   *  or the firm is not active. */
  enabledSince(tenantId: string): Promise<string | null>;
}

/** A stored file fin has not taken in yet. */
export interface IntakeCandidate {
  readonly documentVersionId: string;
  readonly clientPartyId: string | null;
  readonly mediaType: string;
  readonly byteSize: number;
  /** Read to choose a route when the media type says nothing useful, and not
   *  kept: the row copies only what the route was decided from. */
  readonly filename: string;
}

export interface IntakeCandidateSource {
  /**
   * Document versions of these kinds, supplied by a person, stored since the
   * firm switched fin on, that have no intake item yet. Oldest first, at most
   * `limit`.
   */
  untaken(
    tenantId: string,
    kinds: readonly DocumentKind[],
    limit: number,
  ): Promise<readonly IntakeCandidate[]>;
}

export interface NewIntakeItem {
  readonly id: string;
  readonly tenantId: string;
  readonly documentVersionId: string;
  readonly clientPartyId: string | null;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly route: IntakeRoute;
  readonly routeBasis: RouteBasis;
}

/** One intake item as the staff screen reads it. */
export interface IntakeItemView {
  readonly id: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly title: string;
  readonly filename: string;
  readonly clientPartyId: string | null;
  readonly clientName: string | null;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly route: IntakeRoute;
  readonly routeBasis: RouteBasis;
  /** ISO 8601 instant. */
  readonly takenAt: string;
}

/** Which intake items a staff screen asks for, newest first. */
export interface IntakeFilter {
  readonly clientPartyId: string | null;
  readonly route: IntakeRoute | null;
  /** The id of the last item on the previous page; null for the newest page.
   *  The adapter reads that row's own instant, so no rounding can skip or
   *  repeat a row between pages. */
  readonly before: string | null;
  readonly limit: number;
}

/** How many files fin has taken in, by reader — for one client or the firm. */
export interface IntakeSummary {
  readonly total: number;
  readonly byRoute: Readonly<Record<IntakeRoute, number>>;
}

export interface IntakeRepository {
  /** True when the row was created; false when this version was already taken
   *  in (a second run, or two runs at once). Never throws for that case. */
  insert(item: NewIntakeItem): Promise<boolean>;
  list(tenantId: string, filter: IntakeFilter): Promise<readonly IntakeItemView[]>;
  summary(tenantId: string, clientPartyId: string | null): Promise<IntakeSummary>;
}
