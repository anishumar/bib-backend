// In-memory port fakes for the engagement use case. `implements` each port, so
// the rules can be tested with zero infrastructure.
//
// What is NOT faked, and where the real answers live: the signature FREEZE and
// the one-engagement-per-line constraint are triggers and indexes in migration
// 0017, proven against real Postgres in
// tests/engagement/letter.integration.test.ts. A fake that simulated them would
// be asserting its own behaviour.
import { FakeClientStructure, FakePartyStanding } from "./party";
import { FakeFirmTimeZone } from "./tenancy";
import { FakeClock } from "./clock";
import type {
  Engagement,
  EngagementLetter,
  FeeGroup,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../domain/engagement/model";
import { sectionCode } from "../domain/engagement/model";
import { readClauseBody, readServiceBody } from "../domain/config/model";
import { resolveTerms } from "../domain/document/model";
import type {
  AcceptedQuoteDirectory,
  BillableEngagement,
  ClauseLibrary,
  ContentHasher,
  ESignProvider,
  EngagementRepository,
  FeeGroupEdit,
  FirmSignatory,
  FirmSignatureImage,
  FirmSignatureRecord,
  LetterFilters,
  LetterRecord,
  LetterSummary,
  LinePricing,
  NewEngagement,
  NewFeeGroup,
  NewLetter,
  NewLetterClause,
  NewLetterLine,
  PinnedService,
  QuotedProposal,
  SignatureRecord,
  EnvelopeProgress,
  LetterDocument,
  LetterPdf,
  NewSignatureRequest,
  SignatureDispatch,
  SignatureOutcome,
  SignatureRequest,
  SignatureRequestRepository,
  SignatureSigner,
  SignatureTenants,
  SignedCopyFiler,
} from "../usecase/engagement/ports";
import type { Deps } from "../usecase/engagement/service";
import { FakeIds } from "./ids";
import { RecordingEventSink } from "./ledger";
import type { DocumentService } from "../usecase/document/service";
import { makeDocumentIdentity } from "./document";
import type { FakePreferenceRepo } from "./document";

export class FakeEngagementRepo implements EngagementRepository {
  readonly letters: EngagementLetter[] = [];
  readonly lines: (LetterLine & { removed: boolean })[] = [];
  readonly clauses: LetterClause[] = [];
  readonly engagements: Engagement[] = [];
  /** Fee groups, struck-off ones included — the table keeps them too (0083). */
  readonly feeGroups: (FeeGroup & { removed: boolean })[] = [];
  /**
   * Clause bodies this fake should return INSTEAD of the library's, keyed by
   * version id. Empty in every test, and it exists for the case where a test
   * wants a body the library does not hold.
   *
   * It used to be the ONLY source, and that was a drift worth naming: a line's
   * pin resolved through `catalogue` — the same library the service pins from —
   * while a CLAUSE's pin resolved through this map, which nothing ever wrote
   * to. So every clause in the fake's read model came back with an empty title
   * and empty text, and no test noticed, because none of them read a clause's
   * wording until G1.8 needed to. The Postgres adapter joins the pinned version
   * for both; the fake now does the same, and this is an override rather than
   * the source.
   */
  readonly clauseBodies = new Map<string, Record<string, unknown>>();
  /**
   * The library the SERVICE pins resolve against, so `describeLetter` returns
   * the pinned catalogue row the way the Postgres adapter's join does instead of
   * a null that says "this fake does not do that part".
   *
   * The SAME instance the use case drafts from (`makeEngagementFakes` wires
   * one), so a service a test publishes is the one a line's pin cites — a fake
   * that could disagree with the adapter about which version resolved would be
   * worse than no fake at all. Left null when a test builds the repo by hand:
   * `service: null` is a real answer the port already allows.
   */
  catalogue: FakeClauseLibrary | null = null;
  partyNames = new Map<string, string>();
  /** The accounts behind a firm signatory, so the read model can join a name
   *  the way the Postgres adapter does. */
  userNames = new Map<string, string>();

  create(l: NewLetter): Promise<EngagementLetter> {
    const row: EngagementLetter = {
      id: l.id,
      tenantId: l.tenantId,
      ref: l.ref,
      partyId: l.partyId,
      issuingEntityPartyId: l.issuingEntityPartyId,
      proposalId: l.proposalId,
      jurisdiction: l.jurisdiction,
      title: l.title,
      status: "draft",
      layout: l.layout,
      currency: l.currency,
      fxRate: l.fxRate,
      fxRateDate: l.fxRateDate,
      advanceRequired: l.advanceRequired,
      advanceAmount: l.advanceAmount,
      advanceRecordedAt: null,
      advanceRecordedBy: null,
      sentAt: null,
      signedAt: null,
      signedByName: null,
      signatureMethod: null,
      signatureReference: null,
      signedContentHash: null,
      signedByTitle: null,
      withdrawnAt: null,
      background: l.background,
      addressedToPartyId: l.addressedToPartyId,
      issuedOn: l.issuedOn,
      supersedesId: l.supersedesId,
      effectiveFrom: l.effectiveFrom,
      firmSignatoryUserId: null,
      firmSignatoryTitle: null,
      firmSignatureVersionId: null,
      firmSignedAt: null,
      deletedAt: null,
      deletedByUserId: null,
    };
    this.letters.push(row);
    return Promise.resolve(row);
  }

  findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return Promise.resolve(
      this.letters.find((l) => l.tenantId === tenantId && l.id === letterId) ?? null,
    );
  }

  addLine(l: NewLetterLine): Promise<LetterLine> {
    const live = this.lines.filter((x) => x.engagementLetterId === l.engagementLetterId && !x.removed);
    const row = {
      id: l.id,
      tenantId: l.tenantId,
      engagementLetterId: l.engagementLetterId,
      entityPartyId: l.entityPartyId,
      serviceVersionId: l.serviceVersionId,
      description: l.description,
      position: live.length + 1,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      currency: l.currency,
      discountPercent: l.discountPercent,
      effectiveFrom: l.effectiveFrom,
      jurisdiction: l.jurisdiction,
      billingFrequency: l.billingFrequency,
      scopeOverride: l.scopeOverride,
      clientObligationsOverride: l.clientObligationsOverride,
      volumeLimitsOverride: l.volumeLimitsOverride,
      exclusionsOverride: l.exclusionsOverride,
      oopEstimate: l.oopEstimate,
      pricingNote: l.pricingNote,
      feeGroupId: l.feeGroupId,
      removed: false,
    };
    this.lines.push(row);
    return Promise.resolve(strip(row));
  }

  setLinePricing(
    _tenantId: string,
    letterId: string,
    lineId: string,
    pricing: LinePricing,
  ): Promise<LetterLine> {
    const index = this.lines.findIndex(
      (l) => l.id === lineId && l.engagementLetterId === letterId && !l.removed,
    );
    const current = this.lines[index];
    if (current === undefined) throw new Error(`fake: no live line ${lineId}`);
    // The same one-statement write the adapter makes: group and price move
    // together, so no reader sees a line that is both.
    const updated = { ...current, ...pricing };
    this.lines[index] = updated;
    return Promise.resolve(strip(updated));
  }

  addFeeGroup(g: NewFeeGroup): Promise<FeeGroup> {
    const live = this.feeGroups.filter(
      (x) => x.engagementLetterId === g.engagementLetterId && !x.removed,
    );
    const row = {
      id: g.id,
      tenantId: g.tenantId,
      engagementLetterId: g.engagementLetterId,
      // After the last LIVE group, as the adapter numbers it.
      position: live.reduce((max, x) => Math.max(max, x.position), 0) + 1,
      title: g.title,
      billingFrequency: g.billingFrequency,
      amount: g.amount,
      currency: g.currency,
      paymentTerms: g.paymentTerms,
      feeDescription: g.feeDescription,
      intro: g.intro,
      deliverables: g.deliverables,
      clientObligations: g.clientObligations,
      removed: false,
    };
    this.feeGroups.push(row);
    return Promise.resolve(stripGroup(row));
  }

  editFeeGroup(
    _tenantId: string,
    letterId: string,
    groupId: string,
    edit: FeeGroupEdit,
  ): Promise<FeeGroup> {
    const index = this.feeGroups.findIndex(
      (g) => g.id === groupId && g.engagementLetterId === letterId && !g.removed,
    );
    const current = this.feeGroups[index];
    if (current === undefined) throw new Error(`fake: no live fee group ${groupId}`);
    // `undefined` is "not mentioned" — the adapter's CASE, spelled out.
    const updated = {
      ...current,
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(edit.billingFrequency === undefined ? {} : { billingFrequency: edit.billingFrequency }),
      ...(edit.amount === undefined ? {} : { amount: edit.amount }),
      ...(edit.paymentTerms === undefined ? {} : { paymentTerms: edit.paymentTerms }),
      ...(edit.feeDescription === undefined ? {} : { feeDescription: edit.feeDescription }),
      ...(edit.intro === undefined ? {} : { intro: edit.intro }),
      ...(edit.deliverables === undefined ? {} : { deliverables: edit.deliverables }),
      ...(edit.clientObligations === undefined
        ? {}
        : { clientObligations: edit.clientObligations }),
    };
    this.feeGroups[index] = updated;
    return Promise.resolve(stripGroup(updated));
  }

  removeFeeGroup(_tenantId: string, letterId: string, groupId: string): Promise<void> {
    const group = this.feeGroups.find(
      (g) => g.id === groupId && g.engagementLetterId === letterId && !g.removed,
    );
    if (group) group.removed = true;
    return Promise.resolve();
  }

  listFeeGroups(tenantId: string, letterId: string): Promise<readonly FeeGroup[]> {
    return Promise.resolve(this.liveGroups(tenantId, letterId).map(stripGroup));
  }

  removeLine(_tenantId: string, letterId: string, lineId: string): Promise<void> {
    const line = this.lines.find((l) => l.id === lineId && l.engagementLetterId === letterId);
    if (line) line.removed = true;
    return Promise.resolve();
  }

  listLines(tenantId: string, letterId: string): Promise<readonly LetterLine[]> {
    return Promise.resolve(this.liveLines(tenantId, letterId).map(strip));
  }

  addClause(c: NewLetterClause): Promise<LetterClause> {
    const row: LetterClause = {
      id: c.id,
      tenantId: c.tenantId,
      engagementLetterId: c.engagementLetterId,
      clauseVersionId: c.clauseVersionId,
      position: this.clauses.filter((x) => x.engagementLetterId === c.engagementLetterId).length + 1,
    };
    this.clauses.push(row);
    return Promise.resolve(row);
  }

  listClauses(tenantId: string, letterId: string): Promise<readonly LetterClause[]> {
    return Promise.resolve(
      this.clauses
        .filter((c) => c.tenantId === tenantId && c.engagementLetterId === letterId)
        .sort((a, b) => a.position - b.position),
    );
  }

  setStatus(
    tenantId: string,
    letterId: string,
    status: LetterStatus,
    at: string,
  ): Promise<EngagementLetter> {
    return Promise.resolve(
      this.replace(tenantId, letterId, (l) => ({
        ...l,
        status,
        sentAt: status === "draft" ? null : (l.sentAt ?? at),
        withdrawnAt: status === "withdrawn" ? at : null,
      })),
    );
  }

  markSent(
    tenantId: string,
    letterId: string,
    at: string,
    issuedOnFallback: string,
    firm: FirmSignatureRecord | null,
  ): Promise<EngagementLetter> {
    return Promise.resolve(
      this.replace(tenantId, letterId, (l) => ({
        ...l,
        status: "sent" as const,
        sentAt: l.sentAt ?? at,
        // The same coalesce the SQL does: a letter the drafter dated keeps its
        // date, one they did not is dated the day it went out.
        issuedOn: l.issuedOn ?? issuedOnFallback,
        firmSignatoryUserId: firm?.userId ?? null,
        firmSignatoryTitle: firm?.title ?? null,
        firmSignatureVersionId: firm?.signatureVersionId ?? null,
        firmSignedAt: firm?.signedAt ?? null,
      })),
    );
  }

  findSuccessor(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return Promise.resolve(
      this.letters.find(
        (l) =>
          l.tenantId === tenantId &&
          l.supersedesId === letterId &&
          l.status !== "withdrawn" &&
          l.deletedAt === null,
      ) ?? null,
    );
  }

  /** The adapter's WHERE clause: a draft, not yet deleted — else null. */
  markDeleted(
    tenantId: string,
    letterId: string,
    deletedByUserId: string | null,
  ): Promise<EngagementLetter | null> {
    const index = this.letters.findIndex((l) => l.tenantId === tenantId && l.id === letterId);
    const current = this.letters[index];
    if (!current || current.status !== "draft" || current.deletedAt !== null) {
      return Promise.resolve(null);
    }
    const next: EngagementLetter = {
      ...current,
      deletedAt: "2026-06-01T09:30:00.000Z",
      deletedByUserId,
    };
    this.letters[index] = next;
    return Promise.resolve(next);
  }

  signAndFanOut(
    tenantId: string,
    letterId: string,
    signature: SignatureRecord,
    engagements: readonly NewEngagement[],
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }> {
    const letter = this.replace(tenantId, letterId, (l) => ({
      ...l,
      status: "signed" as const,
      signedAt: signature.signedAt,
      signedByName: signature.signedByName,
      signatureMethod: signature.signatureMethod,
      signatureReference: signature.signatureReference,
      signedContentHash: signature.signedContentHash,
      signedByTitle: signature.signedByTitle,
    }));
    const created = engagements.map((e) => {
      const row: Engagement = {
        id: e.id,
        tenantId: e.tenantId,
        engagementLetterId: e.engagementLetterId,
        engagementLetterLineId: e.engagementLetterLineId,
        partyId: e.partyId,
        entityPartyId: e.entityPartyId,
        status: e.status,
        activatedAt: e.activatedAt,
        effectiveFrom: e.effectiveFrom,
        endsOn: null,
      };
      this.engagements.push(row);
      return row;
    });
    return Promise.resolve({ letter, engagements: created });
  }

  recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    at: string,
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }> {
    const letter = this.replace(tenantId, letterId, (l) => ({
      ...l,
      advanceRecordedAt: at,
      advanceRecordedBy: recordedByUserId,
    }));
    const released: Engagement[] = [];
    this.engagements.forEach((e, i) => {
      if (e.engagementLetterId === letterId && e.status === "pending_advance") {
        const updated: Engagement = { ...e, status: "active", activatedAt: at };
        this.engagements[i] = updated;
        released.push(updated);
      }
    });
    return Promise.resolve({ letter, released });
  }

  listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]> {
    return Promise.resolve(
      this.engagements.filter((e) => e.tenantId === tenantId && e.engagementLetterId === letterId),
    );
  }

  /**
   * The join the adapter does in SQL, done here over the same in-memory rows.
   *
   * The one thing it must reproduce is WHERE THE MONEY COMES FROM: the LETTER
   * LINE's agreed amount and discount, never the catalogue's list price. A fake
   * that read the pin would let a test pass on a version that quietly bills a
   * negotiated discount away.
   */
  listBillable(tenantId: string, partyId: string): Promise<readonly BillableEngagement[]> {
    const rows = this.engagements
      .filter((e) => e.tenantId === tenantId && e.partyId === partyId)
      .map((e) => {
        const line = this.lines.find((l) => l.id === e.engagementLetterLineId);
        const letter = this.letters.find((l) => l.id === e.engagementLetterId);
        if (!line || !letter) return null;
        const groups = this.liveGroups(tenantId, letter.id);
        const rank = groups.findIndex((g) => g.id === line.feeGroupId);
        const group = groups[rank];
        const row: BillableEngagement = {
          engagementId: e.id,
          entityPartyId: e.entityPartyId,
          entityName: `Entity ${e.entityPartyId.slice(-2)}`,
          letterId: letter.id,
          letterRef: letter.ref,
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
          pricingNote: line.pricingNote,
          currency: line.currency,
          discountPercent: line.discountPercent,
          // The group's period for a grouped line, as the adapter coalesces it.
          billingFrequency: group?.billingFrequency ?? line.billingFrequency,
          status: e.status,
          effectiveFrom: e.effectiveFrom,
          endsOn: e.endsOn,
          feeGroup:
            group === undefined
              ? null
              : {
                  id: group.id,
                  code: sectionCode(rank),
                  title: group.title,
                  amount: group.amount,
                  billingFrequency: group.billingFrequency,
                  lineCount: this.liveLines(tenantId, letter.id).filter(
                    (l) => l.feeGroupId === group.id,
                  ).length,
                },
        };
        return row;
      })
      .filter((r): r is BillableEngagement => r !== null);
    return Promise.resolve(rows);
  }

  async describeLetter(tenantId: string, letterId: string): Promise<LetterRecord | null> {
    const letter = await this.findLetter(tenantId, letterId);
    if (letter === null) return null;
    const lines = this.liveLines(tenantId, letterId);
    const clauses = await this.listClauses(tenantId, letterId);
    const groups = this.liveGroups(tenantId, letterId);
    return {
      letter,
      party: {
        id: letter.partyId,
        displayName: this.partyNames.get(letter.partyId) ?? letter.partyId,
      },
      issuingEntity: {
        id: letter.issuingEntityPartyId,
        displayName: this.partyNames.get(letter.issuingEntityPartyId) ?? letter.issuingEntityPartyId,
      },
      addressedTo:
        letter.addressedToPartyId === null
          ? null
          : {
              id: letter.addressedToPartyId,
              displayName:
                this.partyNames.get(letter.addressedToPartyId) ?? letter.addressedToPartyId,
            },
      // The three firm-signature columns move together in the schema, so one
      // check settles the block here too.
      firmSignatory:
        letter.firmSignatoryUserId === null ||
        letter.firmSignatoryTitle === null ||
        letter.firmSignedAt === null
          ? null
          : {
              userId: letter.firmSignatoryUserId,
              displayName: this.userNames.get(letter.firmSignatoryUserId) ?? null,
              title: letter.firmSignatoryTitle,
              signedAt: letter.firmSignedAt,
            },
      supersedes: this.refOf(tenantId, letter.supersedesId),
      supersededBy: this.refOf(
        tenantId,
        this.letters.find(
          (l) =>
            l.tenantId === tenantId &&
            l.supersedesId === letter.id &&
            l.status !== "withdrawn" &&
            l.deletedAt === null,
        )?.id ?? null,
      ),
      feeGroups: groups.map((g, i) => ({
        group: stripGroup(g),
        code: sectionCode(i),
        lineIds: lines.filter((l) => l.feeGroupId === g.id).map((l) => l.id),
      })),
      // The entity name resolves through the same map the client's does — the
      // fake stands in for the join the Postgres adapter actually makes.
      lines: lines.map((l) => ({
        line: strip(l),
        entity: {
          id: l.entityPartyId,
          displayName: this.partyNames.get(l.entityPartyId) ?? l.entityPartyId,
        },
        service: pinnedServiceOf(this.catalogue, l.serviceVersionId),
        // The SAME `resolveTerms` the Postgres adapter calls, over the same
        // pinned body — a second override-else-catalogue rule in here would
        // disagree with the adapter on the case the rule exists for.
        terms: resolveTerms(
          {
            scope: l.scopeOverride,
            clientObligations: l.clientObligationsOverride,
            volumeLimits: l.volumeLimitsOverride,
            exclusions: l.exclusionsOverride,
          },
          pinnedServiceOf(this.catalogue, l.serviceVersionId),
        ),
        net: net(l),
      })),
      clauses: clauses.map((c) => {
        // The PINNED version, the way the adapter's join reads it — with the
        // override map first for a test that wants a body the library lacks.
        const pin = this.catalogue?.pinned(c.clauseVersionId) ?? null;
        const body = readClauseBody(this.clauseBodies.get(c.clauseVersionId) ?? pin?.body ?? {});
        return {
          clause: c,
          key: pin?.key ?? c.clauseVersionId,
          version: pin?.version ?? 1,
          title: body.title,
          text: body.text,
          governingLaw: body.governingLaw,
          courts: body.courts,
        };
      }),
      totals: totals(lines, groups, letter.currency),
      engagements: this.engagements.filter((e) => e.engagementLetterId === letterId),
      deletedBy:
        letter.deletedByUserId === null
          ? null
          : {
              userId: letter.deletedByUserId,
              displayName: this.userNames.get(letter.deletedByUserId) ?? null,
              email: `${letter.deletedByUserId}@example.test`,
            },
    };
  }

  listLetters(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    const matching = this.letters.filter(
      (l) =>
        l.tenantId === tenantId &&
        l.deletedAt === null &&
        (filters.status === undefined || l.status === filters.status) &&
        (filters.partyId === undefined || l.partyId === filters.partyId),
    );
    return Promise.resolve(
      matching.map((letter) => {
        const lines = this.liveLines(tenantId, letter.id);
        return {
          letter,
          party: {
            id: letter.partyId,
            displayName: this.partyNames.get(letter.partyId) ?? letter.partyId,
          },
          issuingEntity: {
            id: letter.issuingEntityPartyId,
            displayName:
              this.partyNames.get(letter.issuingEntityPartyId) ?? letter.issuingEntityPartyId,
          },
          totals: totals(lines, this.liveGroups(tenantId, letter.id), letter.currency),
          lineCount: lines.length,
        };
      }),
    );
  }

  /** A letter identified the way lineage prints it. Null in, null out. */
  private refOf(tenantId: string, letterId: string | null): { id: string; ref: string } | null {
    if (letterId === null) return null;
    const letter = this.letters.find((l) => l.tenantId === tenantId && l.id === letterId);
    return letter === undefined ? null : { id: letter.id, ref: letter.ref };
  }

  private liveGroups(tenantId: string, letterId: string): (FeeGroup & { removed: boolean })[] {
    return this.feeGroups
      .filter((g) => g.tenantId === tenantId && g.engagementLetterId === letterId && !g.removed)
      .sort((a, b) => a.position - b.position);
  }

  private liveLines(tenantId: string, letterId: string): (LetterLine & { removed: boolean })[] {
    return this.lines
      .filter((l) => l.tenantId === tenantId && l.engagementLetterId === letterId && !l.removed)
      .sort((a, b) => a.position - b.position);
  }

  private replace(
    tenantId: string,
    letterId: string,
    change: (l: EngagementLetter) => EngagementLetter,
  ): EngagementLetter {
    const index = this.letters.findIndex((l) => l.tenantId === tenantId && l.id === letterId);
    const current = this.letters[index];
    if (index === -1 || current === undefined) throw new Error(`fake: no letter ${letterId}`);
    const updated = change(current);
    this.letters[index] = updated;
    return updated;
  }
}

/** The library a test controls: register what it wants pinnable. */
export class FakeClauseLibrary implements ClauseLibrary {
  private readonly versions = new Map<
    string,
    { kind: string; status: string; key: string; version: number; body: Record<string, unknown> }
  >();

  publishClause(versionId: string, key: string, body: Record<string, unknown>): string {
    this.versions.set(versionId, { kind: "clause", status: "published", key, version: 1, body });
    return versionId;
  }

  publishService(versionId: string, key: string, body: Record<string, unknown>): string {
    this.versions.set(versionId, { kind: "service", status: "published", key, version: 1, body });
    return versionId;
  }

  add(
    versionId: string,
    row: { kind: string; status: string; key: string; version: number; body: Record<string, unknown> },
  ): void {
    this.versions.set(versionId, row);
  }

  /** The same lookup `readPinnedVersion` does, without the promise — so
   *  `FakeEngagementRepo.describeLetter` can resolve each line's pin the way a
   *  JOIN does rather than awaiting once per line. */
  pinned(
    versionId: string,
  ): { key: string; version: number; body: Record<string, unknown> } | null {
    return this.versions.get(versionId) ?? null;
  }

  readPinnedVersion(
    _tenantId: string,
    versionId: string,
  ): Promise<{
    readonly kind: string;
    readonly status: string;
    readonly key: string;
    readonly version: number;
    readonly body: Record<string, unknown>;
  } | null> {
    return Promise.resolve(this.versions.get(versionId) ?? null);
  }
}

/**
 * The firm's standing signatory, as a test controls it.
 *
 * Starts empty, because that is the state every firm is in until somebody names
 * one — and a letter sent by a firm that has named nobody must still go out.
 */
export class FakeFirmSignatory implements FirmSignatory {
  private current: { userId: string; title: string } | null = null;

  name(userId: string, title: string): void {
    this.current = { userId, title };
  }

  firmSignatory(_tenantId: string): Promise<{ userId: string; title: string } | null> {
    return Promise.resolve(this.current);
  }
}

/** The signature IMAGE in force for an entity (0081). Per entity, because the
 *  mark is — one signatory for the firm, that entity's own mark on its paper. */
export class FakeFirmSignatureImage implements FirmSignatureImage {
  private readonly byEntity = new Map<string, string>();

  set(entityPartyId: string, versionId: string): void {
    this.byEntity.set(entityPartyId, versionId);
  }

  activeSignatureVersion(_tenantId: string, entityPartyId: string): Promise<string | null> {
    return Promise.resolve(this.byEntity.get(entityPartyId) ?? null);
  }
}

/** A signer a test can make fail — because "the provider was down" must not
 *  leave a letter recorded as signed. */
export class FakeSigner implements ESignProvider {
  readonly method = "fake";
  failNext = false;
  readonly signed: { letterId: string; contentHash: string }[] = [];

  sign(input: {
    readonly letterId: string;
    readonly contentHash: string;
    readonly reference?: string | undefined;
  }): Promise<{ readonly reference: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("fake e-sign provider is unavailable"));
    }
    this.signed.push({ letterId: input.letterId, contentHash: input.contentHash });
    return Promise.resolve({ reference: input.reference ?? `fake-envelope-${input.letterId}` });
  }
}

/** Deterministic and content-sensitive: same content, same digest; a changed
 *  term, a different one. That is all the service asks of a hasher. */
export class FakeHasher implements ContentHasher {
  hash(content: string): string {
    let h = 0n;
    for (const ch of content) h = (h * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (2n ** 64n);
    return h.toString(16).padStart(64, "0");
  }
}

// ── Sending for signature (0080) ───────────────────────────────────────────

/** The request table, in memory, with the claim modelled as the SQL states it:
 *  no envelope, not settled, and no claim newer than `staleBefore`. */
export class FakeSignatureRequestRepo implements SignatureRequestRepository {
  readonly rows = new Map<string, SignatureRequest & { claimedAt: string | null }>();

  private byLetter(tenantId: string, letterId: string) {
    return [...this.rows.values()].find((r) => r.tenantId === tenantId && r.letterId === letterId);
  }

  private strip(r: SignatureRequest & { claimedAt: string | null }): SignatureRequest {
    const { claimedAt: _claimedAt, ...rest } = r;
    return rest;
  }

  open(request: NewSignatureRequest): Promise<SignatureRequest> {
    const existing = this.byLetter(request.tenantId, request.letterId);
    if (existing !== undefined) {
      if (existing.envelopeId === null) {
        const updated = { ...existing, signer: request.signer, requestedBy: request.requestedBy };
        this.rows.set(existing.id, updated);
        return Promise.resolve(this.strip(updated));
      }
      return Promise.resolve(this.strip(existing));
    }
    const row = {
      id: request.id,
      tenantId: request.tenantId,
      letterId: request.letterId,
      provider: request.provider,
      signer: request.signer,
      requestedBy: request.requestedBy,
      envelopeId: null,
      raisedAt: null,
      lastFailure: null,
      attempts: 0,
      outcome: null,
      settledAt: null,
      copiesFiledAt: null,
      createdAt: "2026-07-01T09:00:00.000Z",
      claimedAt: null,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(this.strip(row));
  }

  findForLetter(tenantId: string, letterId: string): Promise<SignatureRequest | null> {
    const row = this.byLetter(tenantId, letterId);
    return Promise.resolve(row === undefined ? null : this.strip(row));
  }

  claim(
    tenantId: string,
    requestId: string,
    at: string,
    staleBefore: string,
  ): Promise<SignatureRequest | null> {
    const row = this.rows.get(requestId);
    if (
      row === undefined ||
      row.tenantId !== tenantId ||
      row.envelopeId !== null ||
      row.outcome !== null ||
      (row.claimedAt !== null && row.claimedAt >= staleBefore)
    ) {
      return Promise.resolve(null);
    }
    const claimed = { ...row, claimedAt: at, attempts: row.attempts + 1 };
    this.rows.set(requestId, claimed);
    return Promise.resolve(this.strip(claimed));
  }

  recordRaised(
    _tenantId: string,
    requestId: string,
    envelopeId: string,
    at: string,
  ): Promise<SignatureRequest> {
    const row = this.mustGet(requestId);
    const raised = { ...row, envelopeId, raisedAt: at, claimedAt: null, lastFailure: null };
    this.rows.set(requestId, raised);
    return Promise.resolve(this.strip(raised));
  }

  recordFailure(_tenantId: string, requestId: string, failure: string): Promise<SignatureRequest> {
    const row = this.mustGet(requestId);
    const failed = { ...row, lastFailure: failure, claimedAt: null };
    this.rows.set(requestId, failed);
    return Promise.resolve(this.strip(failed));
  }

  listAwaiting(tenantId: string): Promise<readonly SignatureRequest[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.tenantId === tenantId && r.outcome === null && r.envelopeId !== null)
        .map((r) => this.strip(r)),
    );
  }

  settle(_tenantId: string, requestId: string, outcome: SignatureOutcome, at: string): Promise<void> {
    const row = this.mustGet(requestId);
    if (row.outcome === null) this.rows.set(requestId, { ...row, outcome, settledAt: at });
    return Promise.resolve();
  }

  listUnfiled(tenantId: string): Promise<readonly SignatureRequest[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.tenantId === tenantId && r.outcome === "completed" && r.copiesFiledAt === null)
        .map((r) => this.strip(r)),
    );
  }

  recordCopiesFiled(_tenantId: string, requestId: string, at: string): Promise<void> {
    const row = this.mustGet(requestId);
    if (row.copiesFiledAt === null) this.rows.set(requestId, { ...row, copiesFiledAt: at });
    return Promise.resolve();
  }

  private mustGet(requestId: string) {
    const row = this.rows.get(requestId);
    if (row === undefined) throw new Error(`fake: no signature request ${requestId}`);
    return row;
  }
}

/** A provider a test drives: it records what it was asked to send, reports
 *  whatever state a test sets for an envelope, and can be made to fail. */
export class FakeDispatch implements SignatureDispatch {
  readonly method = "fake";
  readonly raised: {
    letterId: string;
    contentHash: string;
    signer: SignatureSigner;
    document: LetterDocument;
  }[] = [];
  readonly voided: { envelopeId: string; reason: string }[] = [];
  /** What `progress` answers, per envelope. Absent means still out. */
  readonly states = new Map<string, EnvelopeProgress["state"]>();
  /** An envelope the provider already holds for a letter, as `findForLetter`
   *  would find after a lost reply. */
  readonly existing = new Map<string, string>();
  failRaise: string | null = null;
  failProgress: string | null = null;

  findForLetter(letterId: string): Promise<string | null> {
    return Promise.resolve(this.existing.get(letterId) ?? null);
  }

  raise(input: {
    readonly letterId: string;
    readonly contentHash: string;
    readonly signer: SignatureSigner;
    readonly document: LetterDocument;
  }): Promise<{ readonly envelopeId: string }> {
    if (this.failRaise !== null) return Promise.reject(new Error(this.failRaise));
    this.raised.push({
      letterId: input.letterId,
      contentHash: input.contentHash,
      signer: input.signer,
      document: input.document,
    });
    return Promise.resolve({ envelopeId: `env-${String(this.raised.length)}-${input.letterId}` });
  }

  failCopies: string | null = null;

  signedCopies(
    envelopeId: string,
  ): Promise<{ readonly signed: LetterDocument; readonly certificate: LetterDocument }> {
    if (this.failCopies !== null) return Promise.reject(new Error(this.failCopies));
    return Promise.resolve({
      signed: { bytes: new Uint8Array([1, 2, 3]), filename: `${envelopeId}-signed.pdf` },
      certificate: { bytes: new Uint8Array([4, 5, 6]), filename: `${envelopeId}-certificate.pdf` },
    });
  }

  progress(envelopeId: string): Promise<EnvelopeProgress> {
    if (this.failProgress !== null) return Promise.reject(new Error(this.failProgress));
    const state = this.states.get(envelopeId) ?? "out";
    return Promise.resolve({ state, detail: state });
  }

  void(envelopeId: string, reason: string): Promise<void> {
    this.voided.push({ envelopeId, reason });
    this.states.set(envelopeId, "voided");
    return Promise.resolve();
  }
}

/** The document store, as the signed-copy port sees it: what was filed. */
export class FakeSignedCopyFiler implements SignedCopyFiler {
  readonly filed: { letterId: string; partyId: string; title: string; which: string; filename: string }[] = [];
  file(input: Parameters<SignedCopyFiler["file"]>[0]): Promise<void> {
    this.filed.push({
      letterId: input.letterId,
      partyId: input.partyId,
      title: input.title,
      which: input.which,
      filename: input.document.filename,
    });
    return Promise.resolve();
  }
}

export class FakeLetterPdf implements LetterPdf {
  readonly rendered: string[] = [];
  render(_tenantId: string, letterId: string): Promise<LetterDocument> {
    this.rendered.push(letterId);
    return Promise.resolve({ bytes: new Uint8Array([37, 80, 68, 70]), filename: `${letterId}.pdf` });
  }
}

export class FakeSignatureTenants implements SignatureTenants {
  constructor(readonly ids: readonly string[] = []) {}
  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

export function makeEngagementFakes(): Deps & {
  /** Which parties are archived; empty unless a test archives one (0305). */
  parties: FakePartyStanding;
  /** Each client's companies and people; a client nobody recorded is only
   *  itself, as a real client with no relationships is (F-10-1). */
  structure: FakeClientStructure;
  /** UTC unless a test sets the firm's zone. */
  timeZones: FakeFirmTimeZone;
  clock: FakeClock;
  letters: FakeEngagementRepo;
  library: FakeClauseLibrary;
  esign: FakeSigner;
  migrationSigner: FakeSigner;
  /** The accepted quotes on file, so a test can put one there — the concrete
   *  type rather than the port, like `letters` and `library` above, because a
   *  test needs `add()` and a cast at every call site is a worse way to say so. */
  quotes: FakeAcceptedQuotes;
  /** The firm's issuing-entity rule, so a test can change it or empty it. */
  firmEntities: FakePreferenceRepo;
  /** The same DocumentService `documents` is, as the SERVICE — so a test can
   *  write the firm's standard prose a letter is seeded from (T6.18). */
  prose: DocumentService;
  /** Who binds the firm, so a test can name one — or leave nobody. */
  firm: FakeFirmSignatory;
  events: RecordingEventSink;
  signatures: FakeSignatureRequestRepo;
} {
  // The REAL DocumentService over in-memory ports — see the note in
  // testfakes/proposal.ts. The two documents share one seam on purpose, so they
  // cannot disagree about which entity serves a client.
  const identity = makeDocumentIdentity();
  // ONE library, wired into both the use case and the read model, so a service a
  // test publishes is the same one a line's pin resolves to.
  const library = new FakeClauseLibrary();
  const letters = new FakeEngagementRepo();
  letters.catalogue = library;
  return {
    letters,
    library,
    documents: identity.documents,
    prose: identity.documents,
    parties: new FakePartyStanding(),
    structure: new FakeClientStructure(),
    timeZones: new FakeFirmTimeZone(),
    firmEntities: identity.firmEntities,
    firm: new FakeFirmSignatory(),
    firmSignatureImage: new FakeFirmSignatureImage(),
    quotes: new FakeAcceptedQuotes(),
    esign: new FakeSigner(),
    // Migrated letters: the same attested fake, so a test that sets
    // `migrated: true` sees the signature go through and can tell which
    // signer took it by `method`.
    migrationSigner: new FakeSigner(),
    hasher: new FakeHasher(),
    // Sending for signature is OFF by default — the attested shape every test
    // before 0080 was written against. A test that exercises DocuSign's path
    // sets `dispatch` and `letterPdf` (see `withDispatch`).
    signatures: new FakeSignatureRequestRepo(),
    dispatch: null,
    letterPdf: null,
    signedCopies: null,
    tenants: new FakeSignatureTenants(),
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-07-01T09:00:00Z")),
    events: new RecordingEventSink(),
  };
}

// ── Exact decimal arithmetic, for the fake only. Same reasoning as the proposal
// fake: a float would make it disagree with Postgres on the numbers worth
// testing, and the migration is the authority either way.

const UNIT = 10000n;

function scaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  return BigInt(whole) * UNIT + BigInt((fraction + "0000").slice(0, 4));
}

function unscaled(v: bigint): string {
  return `${(v / UNIT).toString()}.${(v % UNIT).toString().padStart(4, "0")}`;
}

function mul(a: bigint, b: bigint): bigint {
  return (a * b + UNIT / 2n) / UNIT;
}

// AN UNPRICED LINE IS NOT ZERO HERE EITHER: `null` in, `null` out, and the line
// is COUNTED instead — so this fake agrees with the SQL in the Postgres adapter
// about what a letter's totals leave out.

function grossOf(l: Pick<LetterLine, "unitAmount" | "quantity">): bigint | null {
  if (l.unitAmount === null) return null;
  return mul(scaled(l.unitAmount), scaled(l.quantity));
}

function netScaled(
  l: Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent">,
): bigint | null {
  const gross = grossOf(l);
  if (gross === null) return null;
  return mul(mul(gross, scaled("100") - scaled(l.discountPercent)), scaled("0.01"));
}

function net(
  l: Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent">,
): string | null {
  const value = netScaled(l);
  return value === null ? null : unscaled(value);
}

function totals(
  lines: readonly Pick<LetterLine, "unitAmount" | "quantity" | "discountPercent" | "feeGroupId">[],
  groups: readonly Pick<FeeGroup, "amount">[],
  currency: string,
): LetterRecord["totals"] {
  // Each group's fee once, as the adapter's cross join adds it (0083).
  let gross = groups.reduce((sum, g) => sum + scaled(g.amount), 0n);
  let n = gross;
  let unpriced = 0;
  for (const line of lines) {
    const lineGross = grossOf(line);
    const lineNet = netScaled(line);
    if (lineGross === null || lineNet === null) {
      // A grouped line is priced by its group, not left out.
      if (line.feeGroupId === null) unpriced += 1;
      continue;
    }
    gross += lineGross;
    n += lineNet;
  }
  return {
    gross: unscaled(gross),
    discount: unscaled(gross - n),
    net: unscaled(n),
    currency,
    unpricedLineCount: unpriced,
  };
}

/**
 * A line's pinned catalogue row, read the way the Postgres adapter reads it:
 * through `readServiceBody`, the one reader for `kind='service'`. Sharing that
 * function is the point — a fake that mapped the frozen jsonb itself would be a
 * second interpretation of it, and the two would disagree exactly where a body
 * predates a field.
 */
function pinnedServiceOf(
  catalogue: FakeClauseLibrary | null,
  versionId: string,
): PinnedService | null {
  const row = catalogue?.pinned(versionId);
  if (row === null || row === undefined) return null;
  const stored = readServiceBody(row.body);
  return {
    key: row.key,
    version: row.version,
    ref: stored.ref,
    name: stored.name === "" ? row.key : stored.name,
    module: stored.module,
    group: stored.group,
    billingBasis: stored.billingBasis,
    recurrence: stored.recurrence,
    slaDays: stored.slaDays,
    listPrice: stored.listPrice,
    pricingNote: stored.pricingNote,
    scope: stored.scope,
    clientObligations: stored.clientObligations,
    volumeLimits: stored.volumeLimits,
    exclusions: stored.exclusions,
  };
}

function strip(l: LetterLine & { removed: boolean }): LetterLine {
  const { removed: _removed, ...line } = l;
  return line;
}

function stripGroup(g: FeeGroup & { removed: boolean }): FeeGroup {
  const { removed: _removed, ...group } = g;
  return group;
}

/**
 * The accepted quote a letter is written up from (T3.5b).
 *
 * Holds whole quotes by id and answers null for anything else, which is the
 * one behaviour the adapter has that matters here: `draftFromQuote` says
 * something different about a proposal that is not there than about one that is
 * in the wrong state, and a fake that threw would collapse the two.
 */
export class FakeAcceptedQuotes implements AcceptedQuoteDirectory {
  readonly quotes = new Map<string, QuotedProposal>();

  add(quote: QuotedProposal): QuotedProposal {
    this.quotes.set(quote.proposal.id, quote);
    return quote;
  }

  findQuote(_tenantId: string, proposalId: string): Promise<QuotedProposal | null> {
    return Promise.resolve(this.quotes.get(proposalId) ?? null);
  }
}
