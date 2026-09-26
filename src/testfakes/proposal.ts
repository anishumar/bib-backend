// In-memory port fakes for the proposal use case. `implements` each port — the
// compile-time assertion that they stay in step with the real adapters — so
// quoting's rules can be tested with zero infrastructure.
//
// What is NOT faked, and where the real answers live:
//
//   THE TOTALS. This fake computes them with scaled-integer arithmetic below,
//   which is exact for the same reason `numeric` is: it never touches a float.
//   It is still a SECOND implementation of a formula that lives in
//   crm.proposal_line_amount (0013), and the migration is the authority — so
//   tests/proposal/pricing.integration.test.ts checks the two agree on the
//   awkward numbers rather than trusting this one.
//
//   RLS, the one-line-per-position index, and the composite key that holds a
//   line to its proposal's currency. All database properties, proven against
//   real Postgres.
import { FakeClientStructure, FakePartyStanding } from "./party";
import { FakeStaffDirectory } from "./lead";
import { FakeFirmTimeZone } from "./tenancy";
import { FakeClock } from "./clock";
import type { Proposal, ProposalLine, ProposalStatus } from "../domain/proposal/model";
import { VIEW_DEDUPE_MINUTES } from "../domain/proposal/model";
import { readServiceBody } from "../domain/config/model";
import { resolveTerms } from "../domain/document/model";
import type {
  DecisionNotice,
  FiledPdf,
  NewClientAnswer,
  NewProposal,
  NewProposalEmail,
  NewProposalLine,
  PinnedService,
  PolicyDirectory,
  ProposalEmail,
  ProposalLetter,
  ProposalLinks,
  ProposalMailer,
  ProposalPdfs,
  ProposalFilters,
  ProposalRecord,
  ProposalRepository,
  ProposalRevision,
  ProposalSummary,
  ServiceCatalogue,
  SharedProposalRecord,
} from "../usecase/proposal/ports";
import type { Deps } from "../usecase/proposal/service";
import { FakeIds } from "./ids";
import { FakeTokenFactory } from "./identity";
import { RecordingEventSink } from "./ledger";
import { makeDocumentIdentity } from "./document";
import type { DocumentService } from "../usecase/document/service";
import type { FakePreferenceRepo } from "./document";

export class FakeProposalRepo implements ProposalRepository {
  readonly rows: Proposal[] = [];
  readonly lines: (ProposalLine & { removed: boolean })[] = [];
  /**
   * The catalogue the pins resolve against, so `describe` returns the PINNED
   * service the way the Postgres adapter's join does instead of a null that
   * says "this fake does not do that part".
   *
   * The SAME instance the use case quotes from (`makeProposalFakes` wires one),
   * so a test registers a service in one place and the read model cites it — and
   * a fake that could disagree with the adapter about which version a line
   * resolved to would be worse than no fake at all. Left null when a test builds
   * the repo by hand: `service: null` is a real answer the port already allows.
   */
  catalogue: FakeServiceCatalogue | null = null;
  /** Display names for the parties a test quotes, so a joined read returns
   *  something a screen could render rather than a uuid. */
  partyNames = new Map<string, string>();
  /** The digests attachShareToken has issued, and what they open. */
  readonly shareDigests = new Map<string, string>();
  /** The emails recordEmail kept, with the digest each carried (0085). */
  readonly emails: NewProposalEmail[] = [];
  /** The client answers recordClientAnswer kept (0085). */
  readonly answers: NewClientAnswer[] = [];
  /** Filed PDFs a test's `FakeProposalPdfs` produced, by version id — what
   *  `findPdf` resolves, as the join on files.document_version does. */
  readonly pdfs = new Map<string, FiledPdf>();
  /** The firm's name, as it appears on the document a recipient reads. */
  firmName = "Harbour Point Advisory";

  create(p: NewProposal): Promise<Proposal> {
    const row: Proposal = {
      id: p.id,
      tenantId: p.tenantId,
      ref: p.ref,
      partyId: p.partyId,
      issuingEntityPartyId: p.issuingEntityPartyId,
      leadId: p.leadId,
      title: p.title,
      status: "draft",
      currency: p.currency,
      fxRate: p.fxRate,
      fxRateDate: p.fxRateDate,
      validUntil: p.validUntil,
      sentAt: null,
      decidedAt: null,
      discountApprovedBy: null,
      discountApprovedAt: null,
      firstViewedAt: null,
      lastViewedAt: null,
      viewCount: 0,
      declinedReason: null,
      background: p.background,
      addressedToPartyId: p.addressedToPartyId,
      preparedByUserId: p.preparedByUserId,
      sentPdfVersionId: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  /** Display names and addresses for the colleagues a test names as having
   *  prepared a proposal, so the read model carries what the adapter's join
   *  would. Unknown ids read as an account with no name. */
  readonly accounts = new Map<string, { displayName: string | null; email: string }>();
  /** Email identifiers for the people a test names under "Prepared for" —
   *  what Send offers to email it to (0085). */
  readonly partyEmails = new Map<string, string>();

  revise(tenantId: string, proposalId: string, change: ProposalRevision): Promise<Proposal | null> {
    const current = this.rows.find((r) => r.tenantId === tenantId && r.id === proposalId);
    // The adapter's WHERE clause: a proposal no longer a draft is not touched.
    if (current?.status !== "draft") return Promise.resolve(null);
    return Promise.resolve(
      this.replace(tenantId, proposalId, (p) => ({
        ...p,
        title: change.title ?? p.title,
        validUntil: change.validUntil === undefined ? p.validUntil : change.validUntil,
        background: change.background === undefined ? p.background : change.background,
        addressedToPartyId:
          change.addressedToPartyId === undefined ? p.addressedToPartyId : change.addressedToPartyId,
        preparedByUserId:
          change.preparedByUserId === undefined ? p.preparedByUserId : change.preparedByUserId,
      })),
    );
  }

  findById(tenantId: string, proposalId: string): Promise<Proposal | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === proposalId) ?? null,
    );
  }

  addLine(l: NewProposalLine): Promise<ProposalLine> {
    const live = this.lines.filter((x) => x.proposalId === l.proposalId && !x.removed);
    const row = {
      id: l.id,
      tenantId: l.tenantId,
      proposalId: l.proposalId,
      entityPartyId: l.entityPartyId,
      serviceVersionId: l.serviceVersionId,
      description: l.description,
      position: live.length + 1,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      currency: l.currency,
      discountPercent: l.discountPercent,
      jurisdiction: l.jurisdiction,
      billingFrequency: l.billingFrequency,
      scopeOverride: l.scopeOverride,
      clientObligationsOverride: l.clientObligationsOverride,
      volumeLimitsOverride: l.volumeLimitsOverride,
      exclusionsOverride: l.exclusionsOverride,
      oopEstimate: l.oopEstimate,
      pricingNote: l.pricingNote,
      removed: false,
    };
    this.lines.push(row);
    return Promise.resolve(stripRemoved(row));
  }

  removeLine(_tenantId: string, proposalId: string, lineId: string): Promise<void> {
    const line = this.lines.find((l) => l.id === lineId && l.proposalId === proposalId);
    if (line) line.removed = true;
    return Promise.resolve();
  }

  listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]> {
    return Promise.resolve(this.liveLines(tenantId, proposalId).map(stripRemoved));
  }

  setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
    declinedReason: string | null,
  ): Promise<Proposal> {
    return Promise.resolve(
      this.replace(tenantId, proposalId, (p) => ({
        ...p,
        status,
        sentAt: status === "draft" ? null : (p.sentAt ?? at),
        decidedAt: ["accepted", "rejected", "expired"].includes(status) ? at : null,
        declinedReason,
      })),
    );
  }

  recordDiscountApproval(
    tenantId: string,
    proposalId: string,
    approvedByUserId: string,
    at: string,
  ): Promise<Proposal> {
    return Promise.resolve(
      this.replace(tenantId, proposalId, (p) => ({
        ...p,
        discountApprovedBy: approvedByUserId,
        discountApprovedAt: at,
      })),
    );
  }

  attachShareToken(tenantId: string, proposalId: string, digest: string): Promise<void> {
    this.replace(tenantId, proposalId, (p) => p);
    // ONE live link per proposal, as the column is: a new digest replaces the
    // old one, so the earlier link stops opening anything (0085's reissue).
    for (const [d, id] of this.shareDigests) if (id === proposalId) this.shareDigests.delete(d);
    this.shareDigests.set(digest, proposalId);
    return Promise.resolve();
  }

  async findShared(tenantId: string, digest: string): Promise<SharedProposalRecord | null> {
    const proposalId = this.shareDigests.get(digest);
    if (proposalId === undefined) return null;
    const proposal = await this.findById(tenantId, proposalId);
    if (proposal === null) return null;
    const lines = this.liveLines(tenantId, proposalId);
    return {
      id: proposal.id,
      ref: proposal.ref,
      firmName: this.firmName,
      issuedBy:
        this.partyNames.get(proposal.issuingEntityPartyId) ?? proposal.issuingEntityPartyId,
      addressedTo: this.partyNames.get(proposal.partyId) ?? proposal.partyId,
      title: proposal.title,
      status: proposal.status,
      currency: proposal.currency,
      validUntil: proposal.validUntil,
      sentAt: proposal.sentAt,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitAmount: l.unitAmount,
        discountPercent: l.discountPercent,
        net: netOf(l),
        // The recipient reads the reason where the figure would be.
        pricingNote: l.pricingNote,
        billingFrequency: l.billingFrequency,
        oopEstimate: l.oopEstimate,
      })),
      totals: totalsOf(lines, proposal.currency),
      answer: (() => {
        const a = this.answers.find((x) => x.tenantId === tenantId && x.proposalId === proposalId);
        return a === undefined
          ? null
          : { decision: a.decision, signerName: a.signerName, decidedAt: a.decidedAt };
      })(),
    };
  }

  recordView(tenantId: string, proposalId: string, at: string): Promise<boolean> {
    let wasFirst = false;
    this.replace(tenantId, proposalId, (p) => {
      wasFirst = p.viewCount === 0;
      // The count advances only outside the de-duplication window; the DATE
      // moves every time. See VIEW_DEDUPE_MINUTES: the share link is public, so
      // counting requests counted refreshes and link previews.
      const separate =
        p.lastViewedAt === null ||
        Date.parse(at) - Date.parse(p.lastViewedAt) > VIEW_DEDUPE_MINUTES * 60 * 1000;
      return {
        ...p,
        viewCount: p.viewCount + (separate ? 1 : 0),
        firstViewedAt: p.firstViewedAt ?? at,
        lastViewedAt: at,
      };
    });
    return Promise.resolve(wasFirst);
  }

  async describe(tenantId: string, proposalId: string): Promise<ProposalRecord | null> {
    const proposal = await this.findById(tenantId, proposalId);
    if (proposal === null) return null;
    const lines = this.liveLines(tenantId, proposalId);
    return {
      proposal,
      party: {
        id: proposal.partyId,
        displayName: this.partyNames.get(proposal.partyId) ?? proposal.partyId,
      },
      issuingEntity: {
        id: proposal.issuingEntityPartyId,
        displayName:
          this.partyNames.get(proposal.issuingEntityPartyId) ?? proposal.issuingEntityPartyId,
      },
      lines: lines.map((l) => ({
        line: stripRemoved(l),
        // Null is a real answer here, not an unresolved join: a proposal line
        // may name no entity at all.
        entity:
          l.entityPartyId === null
            ? null
            : {
                id: l.entityPartyId,
                displayName: this.partyNames.get(l.entityPartyId) ?? l.entityPartyId,
              },
        service: pinnedServiceOf(this.catalogue, l.serviceVersionId),
        // The SAME `resolveTerms` the Postgres adapter calls, over the same
        // pinned body: a fake with its own override-else-catalogue rule would
        // disagree with the adapter on the one case the rule exists for.
        terms: resolveTerms(
          {
            scope: l.scopeOverride,
            clientObligations: l.clientObligationsOverride,
            volumeLimits: l.volumeLimitsOverride,
            exclusions: l.exclusionsOverride,
          },
          pinnedServiceOf(this.catalogue, l.serviceVersionId),
        ),
        net: netOf(l),
      })),
      totals: totalsOf(lines, proposal.currency),
      approvedBy: null,
      addressee:
        proposal.addressedToPartyId === null
          ? null
          : {
              id: proposal.addressedToPartyId,
              displayName:
                this.partyNames.get(proposal.addressedToPartyId) ?? proposal.addressedToPartyId,
              email: this.partyEmails.get(proposal.addressedToPartyId) ?? null,
            },
      preparedBy:
        proposal.preparedByUserId === null
          ? null
          : {
              userId: proposal.preparedByUserId,
              displayName: this.accounts.get(proposal.preparedByUserId)?.displayName ?? null,
              email:
                this.accounts.get(proposal.preparedByUserId)?.email ??
                `${proposal.preparedByUserId}@example.test`,
            },
      firmName: this.firmName,
      sentPdf:
        proposal.sentPdfVersionId === null
          ? null
          : (this.pdfs.get(proposal.sentPdfVersionId) ?? null),
      emails: this.emails
        .filter((e) => e.tenantId === tenantId && e.proposalId === proposalId)
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .map((e) => ({
          id: e.id,
          to: e.toEmail,
          note: e.note,
          sentAt: e.sentAt,
          sentBy:
            e.sentBy === null
              ? null
              : {
                  userId: e.sentBy,
                  displayName: this.accounts.get(e.sentBy)?.displayName ?? null,
                  email: this.accounts.get(e.sentBy)?.email ?? `${e.sentBy}@example.test`,
                },
          pdfContentHash: this.pdfs.get(e.pdfVersionId)?.contentHash ?? "",
        })),
      clientDecision: (() => {
        const a = this.answers.find((x) => x.tenantId === tenantId && x.proposalId === proposalId);
        if (a === undefined) return null;
        return {
          decision: a.decision,
          signerName: a.signerName,
          statement: a.statement,
          decidedAt: a.decidedAt,
          ipAddress: a.ipAddress,
          userAgent: a.userAgent,
          emailedTo: this.emails.find((e) => e.id === a.emailId)?.toEmail ?? null,
          pdf: a.pdfVersionId === null ? null : (this.pdfs.get(a.pdfVersionId) ?? null),
        };
      })(),
    };
  }

  list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]> {
    const matching = this.rows.filter(
      (p) =>
        p.tenantId === tenantId &&
        (filters.status === undefined || p.status === filters.status) &&
        (filters.partyId === undefined || p.partyId === filters.partyId),
    );
    return Promise.resolve(
      matching.map((proposal) => {
        const lines = this.liveLines(tenantId, proposal.id);
        return {
          proposal,
          party: {
            id: proposal.partyId,
            displayName: this.partyNames.get(proposal.partyId) ?? proposal.partyId,
          },
          issuingEntity: {
            id: proposal.issuingEntityPartyId,
            displayName:
              this.partyNames.get(proposal.issuingEntityPartyId) ?? proposal.issuingEntityPartyId,
          },
          totals: totalsOf(lines, proposal.currency),
          lineCount: lines.length,
        };
      }),
    );
  }

  // ── 0085 ────────────────────────────────────────────────────────────────

  findIdByShareDigest(_tenantId: string, digest: string): Promise<string | null> {
    return Promise.resolve(this.shareDigests.get(digest) ?? null);
  }

  pinSentPdf(tenantId: string, proposalId: string, versionId: string): Promise<string> {
    // The adapter's coalesce: the first pin stands.
    const pinned = this.replace(tenantId, proposalId, (p) => ({
      ...p,
      sentPdfVersionId: p.sentPdfVersionId ?? versionId,
    }));
    return Promise.resolve(pinned.sentPdfVersionId ?? versionId);
  }

  findPdf(_tenantId: string, versionId: string): Promise<FiledPdf | null> {
    return Promise.resolve(this.pdfs.get(versionId) ?? null);
  }

  recordEmail(email: NewProposalEmail): Promise<ProposalEmail> {
    this.emails.push(email);
    return Promise.resolve({
      id: email.id,
      tenantId: email.tenantId,
      proposalId: email.proposalId,
      toEmail: email.toEmail,
      note: email.note,
      pdfVersionId: email.pdfVersionId,
      sentBy: email.sentBy,
      sentAt: email.sentAt,
    });
  }

  findEmailByLink(
    tenantId: string,
    proposalId: string,
    digest: string,
  ): Promise<ProposalEmail | null> {
    const found = [...this.emails]
      .reverse()
      .find((e) => e.tenantId === tenantId && e.proposalId === proposalId && e.linkDigest === digest);
    return Promise.resolve(found ?? null);
  }

  recordClientAnswer(answer: NewClientAnswer): Promise<Proposal | null> {
    const current = this.rows.find((r) => r.tenantId === answer.tenantId && r.id === answer.proposalId);
    // The adapter's WHERE: only while it is sent.
    if (current?.status !== "sent") return Promise.resolve(null);
    this.answers.push(answer);
    return Promise.resolve(
      this.replace(answer.tenantId, answer.proposalId, (p) => ({
        ...p,
        status: answer.decision,
        decidedAt: answer.decidedAt,
        declinedReason: answer.declinedReason,
      })),
    );
  }

  private liveLines(
    tenantId: string,
    proposalId: string,
  ): (ProposalLine & { removed: boolean })[] {
    return this.lines
      .filter((l) => l.tenantId === tenantId && l.proposalId === proposalId && !l.removed)
      .sort((a, b) => a.position - b.position);
  }

  private replace(
    tenantId: string,
    proposalId: string,
    change: (p: Proposal) => Proposal,
  ): Proposal {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === proposalId);
    const current = this.rows[index];
    if (index === -1 || current === undefined) {
      throw new Error(`fake: no proposal ${proposalId}`);
    }
    const updated = change(current);
    this.rows[index] = updated;
    return updated;
  }
}

/** A catalogue a test controls: register the versions it wants quotable. */
export class FakeServiceCatalogue implements ServiceCatalogue {
  private readonly versions = new Map<
    string,
    { kind: string; status: string; key: string; version: number; body: Record<string, unknown> }
  >();

  /** Add a published service. Returns the version id, which is what a proposal
   *  line pins. */
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
   *  `FakeProposalRepo.describe` can resolve a line's pin the way a JOIN does,
   *  in one pass, rather than awaiting once per line. */
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

/** The firm's discount limit. Starts as null — no policy published — because
 *  that is the state every firm is in until somebody sets one, and the
 *  fail-closed reading of it is the rule most worth testing. */
export class FakePolicyDirectory implements PolicyDirectory {
  maxPercent: string | null = null;

  maxDiscountPercent(_tenantId: string): Promise<string | null> {
    return Promise.resolve(this.maxPercent);
  }
}

/**
 * The two letters of 0085, KEPT rather than sent, so a test reads exactly what
 * the use case asked the adapter to write. `failWith` makes the next sends
 * reject, the way a mail server that will not take a letter does.
 */
export class FakeProposalMailer implements ProposalMailer {
  readonly letters: ProposalLetter[] = [];
  readonly notices: DecisionNotice[] = [];
  failWith: Error | null = null;

  sendProposal(letter: ProposalLetter): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.letters.push(letter);
    return Promise.resolve();
  }

  sendDecisionNotice(notice: DecisionNotice): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.notices.push(notice);
    return Promise.resolve();
  }
}

/**
 * Rendering and filing, without a renderer: each `file` produces a NEW
 * version, as `FileStoreService.render` files a new document each time, and
 * registers it with the repository fake so `findPdf` resolves it the way the
 * join does. `failWith` makes the render throw.
 */
export class FakeProposalPdfs implements ProposalPdfs {
  readonly filed: FiledPdf[] = [];
  failWith: Error | null = null;
  constructor(private readonly repo: FakeProposalRepo) {}

  file(_tenantId: string, proposalId: string): Promise<FiledPdf> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const n = this.filed.length + 1;
    const ref = this.repo.rows.find((r) => r.id === proposalId)?.ref ?? proposalId;
    // Uuid-shaped, because the API's schema says these are uuids and a fake
    // that the wire would refuse proves nothing about the wire.
    const pdf: FiledPdf = {
      documentId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      versionId: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
      contentHash: String(n).repeat(64).slice(0, 64),
      filename: `${ref}.pdf`,
    };
    this.filed.push(pdf);
    this.repo.pdfs.set(pdf.versionId, pdf);
    return Promise.resolve(pdf);
  }

  bytes(_tenantId: string, pdf: FiledPdf): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(`%PDF-fake ${pdf.versionId}`));
  }
}

/**
 * For a test that composes the proposal service against real Postgres and
 * never emails: a PDF asked of it is a failure that names the omission, not a
 * fake file the database would refuse to pin (0085's foreign key).
 */
export const UNWIRED_PROPOSAL_PDFS: ProposalPdfs = {
  file: () => Promise.reject(new Error("this test composes no document store for proposal PDFs")),
  bytes: () => Promise.reject(new Error("this test composes no document store for proposal PDFs")),
};

/** Links from a fixed origin, so a test can read them back. */
export const FAKE_PROPOSAL_LINKS: ProposalLinks = {
  shareUrl: (token) => `https://app.example.test/p/${token}`,
  staffUrl: (proposalId) => `https://app.example.test/proposals/${proposalId}`,
};

export function makeProposalFakes(): Deps & {
  /** Which parties are archived; empty unless a test archives one (0305). */
  parties: FakePartyStanding;
  proposals: FakeProposalRepo;
  catalogue: FakeServiceCatalogue;
  policies: FakePolicyDirectory;
  shareTokens: FakeTokenFactory;
  /** The firm's issuing-entity rule, so a test can change it or empty it. */
  firmEntities: FakePreferenceRepo;
  /** The clock, as the FAKE and not as the port. A share-link test has to be
   *  able to move it: `view_count` de-duplicates opens inside a window, and
   *  without a movable clock there is no way to write a second reading. */
  clock: FakeClock;
  events: RecordingEventSink;
  /** The same DocumentService `documents` is, as the SERVICE rather than the
   *  narrow port — so a test can write a document's own prose and then read it
   *  back through the proposal's share link. */
  prose: DocumentService;
  /** Whom a client's proposal may be prepared for (F-10-1, 0084). */
  structure: FakeClientStructure;
  timeZones: FakeFirmTimeZone;
  /** Who works here — whom "Prepared by" may name (0084). */
  staff: FakeStaffDirectory;
  /** The letters of 0085, kept rather than sent. */
  mailer: FakeProposalMailer;
  pdfs: FakeProposalPdfs;
} {
  // The REAL DocumentService over in-memory ports: quoting must fail here if
  // the rule that picks an issuing entity stops working, and a stub that
  // recorded being asked would let it pass.
  const identity = makeDocumentIdentity();
  // ONE catalogue, wired into both the use case and the read model, so a service
  // a test publishes is the same one a line's pin resolves to. Two instances
  // would let the fake read model cite a version the use case never saw.
  const catalogue = new FakeServiceCatalogue();
  const proposals = new FakeProposalRepo();
  proposals.catalogue = catalogue;
  return {
    proposals,
    catalogue,
    policies: new FakePolicyDirectory(),
    parties: new FakePartyStanding(),
    documents: identity.documents,
    prose: identity.documents,
    firmEntities: identity.firmEntities,
    // The identity fake, reused: both ports want the same guarantee, and a
    // second predictable-token fake would be the same class with a new name.
    shareTokens: new FakeTokenFactory(),
    structure: new FakeClientStructure(),
    timeZones: new FakeFirmTimeZone(),
    staff: new FakeStaffDirectory(),
    mailer: new FakeProposalMailer(),
    pdfs: new FakeProposalPdfs(proposals),
    links: FAKE_PROPOSAL_LINKS,
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-06-01T09:00:00Z")),
    events: new RecordingEventSink(),
  };
}

// ── Exact decimal arithmetic, for the fake only ─────────────────────────────
//
// Scaled integers via BigInt, at the same four decimal places the columns use.
// A float would make this fake disagree with Postgres on exactly the numbers
// worth testing, which would be worse than not computing totals at all.

const SCALE = 4n;
const UNIT = 10n ** SCALE;

function toScaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  const padded = (fraction + "0000").slice(0, 4);
  return BigInt(whole) * UNIT + BigInt(padded);
}

function fromScaled(v: bigint): string {
  const whole = v / UNIT;
  const fraction = (v % UNIT).toString().padStart(4, "0");
  return `${whole.toString()}.${fraction}`;
}

/** round(a * b, 4) over scaled integers — half-up, matching Postgres `round`. */
function mulRound(a: bigint, b: bigint): bigint {
  const product = a * b;
  const half = UNIT / 2n;
  return (product + half) / UNIT;
}

// AN UNPRICED LINE IS NOT ZERO HERE EITHER. `null` in, `null` out — matching
// `numeric` NULL through `crm.proposal_line_amount` — and the line is COUNTED
// instead, so this fake and the view agree about what a total leaves out. A
// fake that quietly treated it as zero would make the unit tests green on
// exactly the number the migration exists to stop anybody printing.

function grossOf(l: Pick<ProposalLine, "unitAmount" | "quantity">): bigint | null {
  if (l.unitAmount === null) return null;
  return mulRound(toScaled(l.unitAmount), toScaled(l.quantity));
}

function netScaled(
  l: Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">,
): bigint | null {
  const gross = grossOf(l);
  if (gross === null) return null;
  const keep = toScaled("100") - toScaled(l.discountPercent);
  return mulRound(mulRound(gross, keep), toScaled("0.01"));
}

function netOf(
  l: Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">,
): string | null {
  const net = netScaled(l);
  return net === null ? null : fromScaled(net);
}

function totalsOf(
  lines: readonly Pick<ProposalLine, "unitAmount" | "quantity" | "discountPercent">[],
  currency: string,
): ProposalRecord["totals"] {
  let gross = 0n;
  let net = 0n;
  let unpriced = 0;
  for (const line of lines) {
    const lineGross = grossOf(line);
    const lineNet = netScaled(line);
    if (lineGross === null || lineNet === null) {
      unpriced += 1;
      continue;
    }
    gross += lineGross;
    net += lineNet;
  }
  return {
    gross: fromScaled(gross),
    discount: fromScaled(gross - net),
    net: fromScaled(net),
    currency,
    unpricedLineCount: unpriced,
  };
}

/**
 * A line's pinned catalogue row, read the way the Postgres adapter reads it:
 * through `readServiceBody`, the one reader for `kind='service'`.
 *
 * Sharing that function is the whole value of doing it here — a fake that
 * mapped the body itself would be a second interpretation of a frozen jsonb, and
 * the two would disagree exactly where a body predates a field.
 */
function pinnedServiceOf(
  catalogue: FakeServiceCatalogue | null,
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

function stripRemoved(l: ProposalLine & { removed: boolean }): ProposalLine {
  const { removed: _removed, ...line } = l;
  return line;
}
