// The seams of the client import.
//
// Three kinds of port, and the split is the design:
//
//   · the STORE — the staging row, this module's own table;
//   · the DIRECTORY — what the firm already has, read in one snapshot so the
//     validator can be pure. Row shapes are declared HERE in this module's
//     vocabulary rather than imported from another use case, so neither use
//     case depends on the other;
//   · the WRITERS — the party, assignment and engagement services, narrowed to
//     the methods an import calls. The composition root hands in the real
//     services. This module has NO write path of its own to any table but the
//     staging row: an imported client goes through the same doors as a typed
//     one, and is therefore the same thing.

import type { Actor } from "../../domain/ledger/model";
import type {
  ImportReport,
  ImportRows,
  IsoDate,
  KnownAxis,
  KnownService,
} from "../../domain/clientimport/model";
import type { IdentifierType } from "../../domain/party/model";

// ── The staging row ──────────────────────────────────────────────────────────

export type ImportStatus = "staged" | "confirmed";

export interface ImportFileNames {
  readonly clients: string;
  readonly people: string | null;
  readonly engagements: string | null;
}

export type OutcomeAction = "created" | "skipped" | "failed";

export interface OutcomeRow {
  readonly sheet: "clients" | "people" | "engagements";
  readonly lineNo: number;
  readonly name: string;
  readonly action: OutcomeAction;
  /** What was made, or why it was not. */
  readonly detail: string | null;
  /** The party the row became, when it did. */
  readonly partyId: string | null;
}

export interface LetterOutcome {
  readonly clientName: string;
  readonly currency: string;
  readonly action: OutcomeAction;
  readonly detail: string | null;
  readonly letterId: string | null;
  /** The engagement-sheet rows the letter carries. */
  readonly lineNos: readonly number[];
  readonly engagementIds: readonly string[];
}

/** What happened to one Portal Invite=TRUE row. `invited` sent a fresh
 *  login and mail; `granted` added this company to an email that already
 *  holds a portal login at this firm — no second mail; `already granted` is
 *  a re-run, both the login and this exact grant already exist. */
export type PortalInviteAction = "invited" | "granted" | "already granted" | "failed";

export interface PortalInviteOutcome {
  readonly clientName: string;
  readonly email: string;
  readonly action: PortalInviteAction;
  readonly detail: string | null;
}

export interface ImportOutcome {
  readonly rows: readonly OutcomeRow[];
  readonly letters: readonly LetterOutcome[];
  readonly portalInvites: readonly PortalInviteOutcome[];
  readonly created: {
    readonly clients: number;
    readonly entities: number;
    /** PARTIES created — not people ROWS. One director of three companies is
     *  three rows and one person, so these two numbers differ on purpose. */
    readonly people: number;
    /** Directorships, signatory roles and the like — one per people row that
     *  loaded, whether or not it also created the person. */
    readonly roles: number;
    readonly assignments: number;
    readonly letters: number;
    readonly engagements: number;
    readonly portalInvites: number;
  };
  readonly skipped: number;
  readonly failed: number;
}

export interface Person {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string;
}

export interface StagedImport {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ImportStatus;
  readonly fileNames: ImportFileNames;
  readonly rows: ImportRows;
  readonly report: ImportReport;
  readonly outcome: ImportOutcome | null;
  readonly stagedBy: Person;
  readonly stagedAt: string;
  readonly confirmedBy: Person | null;
  readonly confirmedAt: string | null;
}

/** The list a screen shows — everything but the sheet and the report. */
export interface StagedImportSummary {
  readonly id: string;
  readonly status: ImportStatus;
  readonly fileNames: ImportFileNames;
  readonly blocking: number;
  readonly warnings: number;
  readonly counts: ImportReport["counts"];
  readonly stagedBy: Person;
  readonly stagedAt: string;
  readonly confirmedAt: string | null;
}

export interface NewStagedImport {
  readonly id: string;
  readonly tenantId: string;
  readonly fileNames: ImportFileNames;
  readonly rows: ImportRows;
  readonly report: ImportReport;
  readonly stagedBy: string;
}

export interface ClientImportStore {
  create(row: NewStagedImport): Promise<StagedImport>;
  find(tenantId: string, importId: string): Promise<StagedImport | null>;
  list(tenantId: string): Promise<readonly StagedImportSummary[]>;
  confirm(
    tenantId: string,
    importId: string,
    outcome: ImportOutcome,
    confirmedBy: string,
    confirmedAt: string,
  ): Promise<StagedImport>;
}

// ── Reading a spreadsheet ────────────────────────────────────────────────────

/** Bytes to a rectangular grid of strings. Throws `SheetUnreadable` for
 *  anything that is not a `.csv` or `.xlsx` with a worksheet in it. */
export interface SheetReader {
  grid(bytes: Uint8Array, filename: string): (readonly string[])[];
}

// ── What the firm already has ────────────────────────────────────────────────

export interface FirmFacts {
  /** The firm's own organization party, which a `client_of` row points at. */
  readonly selfPartyId: string | null;
  readonly reportingCurrency: string | null;
}

export interface OrganizationOnFile {
  readonly partyId: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly displayName: string;
  readonly registered: boolean;
  readonly jurisdiction: string | null;
  /** The `parent_of` parent in force today, if any. */
  readonly parentPartyId: string | null;
  readonly archived: boolean;
}

export interface IdentifierHolder {
  readonly type: IdentifierType;
  /** Normalised, as stored. */
  readonly value: string;
  readonly partyId: string;
}

export interface PersonOnFile {
  /** Normalised email, as stored. */
  readonly email: string;
  readonly partyId: string;
  readonly name: string;
  /**
   * The roles they already hold, as `${toPartyId}:${type}`.
   *
   * Carried because a people row is one ROLE, not one person, and the same
   * person legitimately appears on several — a director of three companies in
   * one group is three rows. Without this the import cannot tell "this person
   * exists, give them the new role" from "this exact role is already recorded,
   * do nothing", and `core.party_relationship` has no uniqueness constraint to
   * catch the difference for us. A re-run of the same sheet has to be boring.
   */
  readonly roles: readonly string[];
}

export interface StaffMember {
  readonly email: string;
  readonly userId: string;
}

export interface ClauseOnFile {
  readonly versionId: string;
  /** Empty means the clause applies everywhere. */
  readonly jurisdictions: readonly string[];
  readonly governingLawJurisdiction: string | null;
  readonly courtsJurisdiction: string | null;
}

export interface EngagementInForce {
  readonly entityPartyId: string;
  /** The catalogue ENTRY the line's pinned version belongs to. */
  readonly serviceId: string;
}

export interface ImportDirectory {
  firm(tenantId: string): Promise<FirmFacts>;
  liveServices(tenantId: string): Promise<readonly KnownService[]>;
  axes(tenantId: string): Promise<readonly KnownAxis[]>;
  activeStaff(tenantId: string): Promise<readonly StaffMember[]>;
  relationshipTypes(): Promise<readonly string[]>;
  clauses(tenantId: string): Promise<readonly ClauseOnFile[]>;
  /** Every organization at the firm except the firm itself, archived included;
   *  the group parent is the one in force on `onDate`. */
  organizations(tenantId: string, onDate: IsoDate): Promise<readonly OrganizationOnFile[]>;
  identifierHolders(
    tenantId: string,
    wanted: readonly { readonly type: IdentifierType; readonly value: string }[],
  ): Promise<readonly IdentifierHolder[]>;
  peopleByEmail(tenantId: string, emails: readonly string[]): Promise<readonly PersonOnFile[]>;
  engagementsInForce(tenantId: string, onDate: IsoDate): Promise<readonly EngagementInForce[]>;
  /** The compliance go-live floor, or null for no floor. */
  missedFromOn(tenantId: string): Promise<IsoDate | null>;
}

// ── The writers — the real services, narrowed ────────────────────────────────

export interface PartyWriter {
  createOrganization(
    input: {
      readonly tenantId: string;
      readonly legalName: string;
      readonly tradeName?: string | undefined;
      readonly industry?: string | undefined;
      readonly website?: string | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly partyId: string }>;
  createPerson(
    input: { readonly tenantId: string; readonly fullName: string },
    actor: Actor,
  ): Promise<{ readonly partyId: string }>;
  registerLegalEntity(
    input: {
      readonly tenantId: string;
      readonly organizationPartyId: string;
      readonly jurisdiction: string;
      readonly entityType: string;
      readonly incorporatedOn?: string | undefined;
      readonly financialYearEnd?: string | undefined;
      readonly registeredAddress?: Record<string, unknown> | undefined;
    },
    actor: Actor,
  ): Promise<unknown>;
  addIdentifier(
    input: {
      readonly tenantId: string;
      readonly partyId: string;
      readonly type: IdentifierType;
      readonly value: string;
      readonly jurisdiction?: string | undefined;
      readonly isPrimary?: boolean | undefined;
      readonly validFrom: string;
    },
    actor: Actor,
  ): Promise<unknown>;
  addRelationship(
    input: {
      readonly tenantId: string;
      readonly fromPartyId: string;
      readonly toPartyId: string;
      readonly type: string;
      readonly validFrom: string;
    },
    actor: Actor,
  ): Promise<unknown>;
}

export interface AssignmentWriter {
  assign(
    input: {
      readonly tenantId: string;
      readonly clientPartyId: string;
      readonly role: string;
      readonly axisId?: string | null | undefined;
      readonly userId: string;
      readonly validFrom?: string | undefined;
    },
    actor: Actor,
  ): Promise<unknown>;
}

export interface LetterWriter {
  draft(
    input: {
      readonly tenantId: string;
      readonly partyId: string;
      readonly jurisdiction: string;
      readonly title: string;
      readonly currency: string;
      readonly fxRate: string;
      readonly fxRateDate: string;
      readonly advanceRequired: boolean;
      readonly background?: string | undefined;
      readonly issuedOn?: string | undefined;
      readonly effectiveFrom?: string | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly id: string }>;
  addLine(input: {
    readonly tenantId: string;
    readonly letterId: string;
    readonly entityPartyId: string;
    readonly serviceVersionId: string;
    readonly description: string;
    readonly quantity: string;
    readonly unitAmount?: string | undefined;
    readonly discountPercent: string;
    readonly effectiveFrom?: string | undefined;
    readonly jurisdiction?: string | undefined;
    readonly billingFrequency?: string | undefined;
    readonly pricingNote?: string | undefined;
  }): Promise<unknown>;
  addClause(tenantId: string, letterId: string, clauseVersionId: string): Promise<void>;
  send(tenantId: string, letterId: string, actor: Actor): Promise<unknown>;
  sign(
    input: {
      readonly tenantId: string;
      readonly letterId: string;
      readonly signedByName: string;
      readonly reference?: string | undefined;
    },
    actor: Actor,
  ): Promise<{ readonly engagements: readonly { readonly engagement: { readonly id: string } }[] }>;
}

// ── The portal — a THIRD kind of write, and deliberately not through a
// service that assumes it is inviting a person the firm has already met.
// `PortalInviteWriter` is the real `PortalInviteService.invite`, narrowed;
// `PortalAccessGranter` is the real `PortalAccessService.grant`, narrowed —
// used only when the email already holds a login at this firm, so a second
// company is a GRANT, never a second invite. `PortalMemberFinder` has no real
// service behind it: no use case answers "does this email already have a
// portal login here", so the composition root satisfies it with a closure
// over the roster, the same move `usecase/obligation`'s filing reconciliation
// documents for the same reason — two use cases that would otherwise have to
// import each other to ask one small question.

export interface PortalInviteWriter {
  invite(
    input: {
      readonly tenantId: string;
      readonly email: string;
      readonly clientPartyId: string;
      readonly validFrom?: string | undefined;
      readonly invitedBy: string;
    },
    actor: Actor,
  ): Promise<{ readonly membershipId: string }>;
}

export interface PortalAccessGranter {
  grant(
    input: {
      readonly tenantId: string;
      readonly membershipId: string;
      readonly clientPartyId: string;
      readonly validFrom?: string | undefined;
      readonly grantedBy: string;
    },
    actor: Actor,
  ): Promise<{ readonly id: string }>;
}

export interface PortalMemberFinder {
  /** The existing CLIENT_PORTAL membership for this email at this firm, if
   *  one was created by an earlier row in this sheet, an earlier import, or a
   *  manual invite from `/clients/[partyId]`. Null when this is a fresh
   *  address. */
  findClientMembership(tenantId: string, email: string): Promise<{ readonly membershipId: string } | null>;
}
