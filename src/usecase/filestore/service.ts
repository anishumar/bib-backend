// The document store use case — storing bytes, versioning them, and attaching
// them to things. No I/O, no SQL, no HTTP: everything outside arrives as an
// injected port, so this reads as a description of what the business does and is
// testable with in-memory fakes and zero infrastructure.
import { isDrawableImage } from "../../domain/render/model";
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type {
  BrandAssetKind,
  DocumentKind,
  DocumentLink,
  DocumentVersion,
  SubjectKind,
} from "../../domain/filestore/model";
import {
  RENDERED_ROLE,
  SUBJECT_KINDS,
  clientVisibleByDefault,
  hasCopyOfRecord,
  isSubjectKind,
  normaliseMediaType,
  renderedFilename,
  safeFilename,
} from "../../domain/filestore/model";
import {
  AlreadyAttached,
  CopyOfRecordStays,
  LinkNotFound,
  BrandAssetNotFound,
  BytesMissing,
  ContentTooLarge,
  DocumentNotFound,
  DraftNotShareable,
  EmptyContent,
  InvalidFilename,
  InvalidTitle,
  UnknownSubjectKind,
  BrandAssetNotDrawable,
  UnsupportedMediaType,
  VersionNotFound,
} from "../../domain/filestore/errors";
import type {
  BlobStore,
  BrandAssetRecord,
  ContentDigest,
  DocumentLinkRecord,
  DocumentRecord,
  DocumentStoreRepository,
  SubjectDocument,
} from "./ports";
import type { DocumentRenderer, FirmTimeZone, RenderSource } from "../render/ports";
import {
  CopyAlreadyMade,
  NotRenderable,
  PreviewNotCallersToday,
  SourceNotFound,
} from "../../domain/render/errors";
import type { PlacedAnchor } from "../../domain/render/model";
import { dayInZone, isCallersToday } from "../../domain/scheduler/zone";
import type { Clock } from "../../platform/clock";

export interface Deps {
  readonly documents: DocumentStoreRepository;
  readonly blobs: BlobStore;
  readonly digest: ContentDigest;
  readonly ids: IdGen;
  readonly events: EventSink;
  /**
   * Turning one of the product's own records into bytes (T3.8).
   *
   * Two ports and not one, because they answer different questions: the SOURCE
   * knows what an engagement letter contains, the RENDERER knows what a page
   * looks like, and neither should learn the other's job. A renderer holding a
   * repository would duplicate read logic that already exists.
   */
  readonly renderer: DocumentRenderer;
  readonly renderSource: RenderSource;
  /**
   * The largest file this store accepts, in bytes.
   *
   * A memory budget, not a preference: the whole file is held in memory to be
   * hashed before it is stored, so this number is how much one request can cost
   * the process. Config-supplied because the right value depends on what a firm
   * uploads, and hardcoding it would make raising it a deploy.
   */
  readonly maxUploadBytes: number;
  /** "Today" for a preview is the FIRM's day (T6.11): the day Send will date
   *  a draft on. */
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
}

/**
 * A document drawn and handed back, filed nowhere (2026-09-28).
 *
 * What a screen needs to SHOW the PDF instead of an imitation of it: the bytes,
 * their hash (so "this is what Send will produce" is a comparison), where each
 * editable piece was drawn, and which of the issuing company's marks the page
 * wanted and found none of.
 */
export interface DocumentPreview {
  readonly reference: string;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly pageCount: number;
  readonly anchors: readonly PlacedAnchor[];
  /** The day a DRAFT was dated as if sent (it has no date of its own yet), or
   *  null when the document printed its own. */
  readonly datedAsIfSent: string | null;
  readonly issuingEntity: { readonly partyId: string; readonly name: string } | null;
  /** The marks this page draws when the issuer has them, and it has none of. */
  readonly missingBrand: readonly ("logo" | "proposal_cover")[];
}

export interface StoreDocumentInput {
  readonly tenantId: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly partyId: string | null;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly actor: Actor;
  /** Attach it as it is stored — the ordinary case, since a file is almost
   *  always uploaded ONTO something. */
  readonly attachTo?:
    | { readonly subjectKind: string; readonly subjectRef: string; readonly role: string | null }
    | undefined;
}

export interface AddVersionInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly actor: Actor;
}

export interface AttachInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly role: string | null;
  readonly actor: Actor;
}

export interface WithdrawInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly actor: Actor;
}

export interface FetchedBytes {
  readonly version: DocumentVersion;
  readonly bytes: Uint8Array;
}

export class FileStoreService {
  constructor(private readonly deps: Deps) {}

  /**
   * Store a file and, usually, attach it to something in the same act.
   *
   * The order matters and is not arbitrary: **bytes first, row second.** A blob
   * with no row is invisible and costs storage; a row with no blob is a document
   * the product offers and cannot open. The first is waste, the second is a lie,
   * and if this is ever interrupted it should be the waste that happens.
   */
  async store(input: StoreDocumentInput): Promise<DocumentRecord> {
    const title = input.title.trim();
    if (title.length === 0) throw new InvalidTitle();

    const filename = safeFilename(input.filename);
    if (filename === null) throw new InvalidFilename(input.filename);

    const mediaType = normaliseMediaType(input.mediaType);
    if (mediaType === null) throw new UnsupportedMediaType(input.mediaType);

    if (input.bytes.byteLength === 0) throw new EmptyContent(filename);
    if (input.bytes.byteLength > this.deps.maxUploadBytes) {
      throw new ContentTooLarge(input.bytes.byteLength, this.deps.maxUploadBytes);
    }

    // Validated BEFORE anything is written, so a bad subject kind does not leave
    // a stored document behind that nobody asked for on its own.
    const attachTo = input.attachTo;
    const subjectKind = attachTo ? this.requireSubjectKind(attachTo.subjectKind) : null;

    const contentHash = this.deps.digest.ofBytes(input.bytes);
    const { storageKey } = await this.deps.blobs.put({
      tenantId: input.tenantId,
      contentHash,
      bytes: input.bytes,
    });

    const documentId = this.deps.ids.newId();
    const record = await this.deps.documents.create(
      {
        id: documentId,
        tenantId: input.tenantId,
        title,
        origin: "uploaded",
        kind: input.kind,
        partyId: input.partyId,
        // ── THE FIRST VALUE, FROM THE KIND (T6.7) ──────────────────────
        //
        // Not the column's DEFAULT, which is FALSE and stays FALSE — that one
        // is for a writer who has never heard of this field, and it has to be
        // the safe direction. This is the judgement: a challan or an invoice is
        // a document the client is a party to, a working paper is the firm's
        // own thinking. It is a starting position and never a wall — the wall
        // is 0066's policy, and the firm's own screen can flip this either way.
        isClientVisible: clientVisibleByDefault(input.kind),
        createdBy: input.actor.type === "human" ? input.actor.id : null,
      },
      {
        id: this.deps.ids.newId(),
        tenantId: input.tenantId,
        documentId,
        contentHash,
        byteSize: input.bytes.byteLength,
        mediaType,
        filename,
        storageKey,
        createdBy: input.actor.type === "human" ? input.actor.id : null,
      },
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.stored",
      objectId: documentId,
      actor: input.actor,
      // Ids and machine facts only — never the filename or the title, both of
      // which routinely carry a client's name ("Kaveri Foods PAN.pdf"), and the
      // ledger is append-only and must stay erasable by row.
      payload: {
        kind: input.kind,
        origin: "uploaded",
        versionNo: record.latestVersion.versionNo,
        contentHash,
        byteSize: input.bytes.byteLength,
        mediaType,
      },
    });

    if (attachTo && subjectKind) {
      await this.attach({
        tenantId: input.tenantId,
        documentId,
        subjectKind,
        subjectRef: attachTo.subjectRef,
        role: attachTo.role,
        actor: input.actor,
      });
    }

    return record;
  }

  /**
   * A further version of a document that already exists.
   *
   * Deliberately not "replace". The previous version stays readable forever,
   * because "which version did the client sign" is asked every time a filing is
   * questioned, and a store that answered it with the newest file would be
   * confidently wrong.
   */
  async addVersion(input: AddVersionInput): Promise<DocumentVersion> {
    const existing = await this.deps.documents.findById(input.tenantId, input.documentId);
    if (!existing) throw new DocumentNotFound(input.documentId);

    const filename = safeFilename(input.filename);
    if (filename === null) throw new InvalidFilename(input.filename);

    const mediaType = normaliseMediaType(input.mediaType);
    if (mediaType === null) throw new UnsupportedMediaType(input.mediaType);

    if (input.bytes.byteLength === 0) throw new EmptyContent(filename);
    if (input.bytes.byteLength > this.deps.maxUploadBytes) {
      throw new ContentTooLarge(input.bytes.byteLength, this.deps.maxUploadBytes);
    }

    const contentHash = this.deps.digest.ofBytes(input.bytes);
    const { storageKey } = await this.deps.blobs.put({
      tenantId: input.tenantId,
      contentHash,
      bytes: input.bytes,
    });

    const version = await this.deps.documents.addVersion({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      documentId: input.documentId,
      contentHash,
      byteSize: input.bytes.byteLength,
      mediaType,
      filename,
      storageKey,
      createdBy: input.actor.type === "human" ? input.actor.id : null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.stored",
      objectId: input.documentId,
      actor: input.actor,
      payload: {
        kind: existing.document.kind,
        origin: existing.document.origin,
        versionNo: version.versionNo,
        contentHash,
        byteSize: input.bytes.byteLength,
        mediaType,
      },
    });

    return version;
  }

  /** Attach an existing document to something else as well. */
  async attach(input: AttachInput): Promise<DocumentLinkRecord> {
    const subjectKind = this.requireSubjectKind(input.subjectKind);

    const document = await this.deps.documents.findById(input.tenantId, input.documentId);
    if (!document) throw new DocumentNotFound(input.documentId);

    const already = await this.deps.documents.linksOf(input.tenantId, input.documentId);
    if (
      already.some(
        (l) =>
          l.link.withdrawnAt === null &&
          l.link.subjectKind === subjectKind &&
          l.link.subjectRef === input.subjectRef,
      )
    ) {
      throw new AlreadyAttached(subjectKind, input.subjectRef);
    }

    const link = await this.deps.documents.attach({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      documentId: input.documentId,
      subjectKind,
      subjectRef: input.subjectRef,
      role: input.role === null ? null : input.role.trim() || null,
      createdBy: input.actor.type === "human" ? input.actor.id : null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.attached",
      objectId: input.documentId,
      actor: input.actor,
      payload: { subjectKind, subjectRef: input.subjectRef, role: link.role },
    });

    return { link, subjectLabel: null };
  }

  async get(tenantId: string, documentId: string): Promise<DocumentRecord> {
    const record = await this.deps.documents.findById(tenantId, documentId);
    if (!record) throw new DocumentNotFound(documentId);
    return record;
  }

  /**
   * Share this document with the client it belongs to, or stop sharing it.
   *
   * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────
   *
   * `clientVisibleByDefault(kind)` gives every new document a sensible first
   * value and the policy in 0066 enforces it. Neither is a substitute for a
   * person being able to change it: T6.5 named this exact failure on
   * `delivery.work_item`'s copy of the same flag — *"a wall built against a
   * value nobody can move"* — and the fix there was a switch on the screen in
   * the same commit as the policy. This is that switch's endpoint.
   *
   * ── IT IS EVENTED, AND NOT AS A DOCUMENT EDIT ─────────────────────────
   *
   * `document.client_visibility_set` and never `document.attached`. Sharing a
   * file with somebody outside the firm is a DISCLOSURE decision, and "when did
   * this become visible to the client" is a question asked after something has
   * reached somebody it should not have. The payload carries the flag and the
   * party; never the title, which routinely names a client's own affairs.
   */
  async setClientVisible(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly visible: boolean;
    readonly actor: Actor;
  }): Promise<DocumentRecord> {
    const record = await this.deps.documents.setClientVisible({
      tenantId: input.tenantId,
      documentId: input.documentId,
      visible: input.visible,
    });
    // Null covers "no such document" AND "the firm's own document, which has no
    // client to share it with". Both are `DocumentNotFound` on this surface:
    // the second is a document that exists, so a distinct refusal would be
    // useful — but `partyId` is already on every read this caller has, so a
    // screen offering the control at all has the answer, and a second error
    // code for a state the UI cannot reach is a code nobody handles.
    if (!record) throw new DocumentNotFound(input.documentId);
    // B10: refused in the write itself, so nothing moved. Named by the title
    // the firm sees on the row.
    if (record === "draft") {
      const doc = await this.get(input.tenantId, input.documentId);
      throw new DraftNotShareable(doc.document.title);
    }

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.client_visibility_set",
      objectId: record.document.id,
      actor: input.actor,
      payload: {
        isClientVisible: record.document.isClientVisible,
        partyId: record.document.partyId,
        kind: record.document.kind,
      },
    });
    return record;
  }

  async list(input: {
    readonly tenantId: string;
    readonly partyId?: string | undefined;
    readonly kind?: DocumentKind | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly DocumentRecord[]> {
    return this.deps.documents.list({
      tenantId: input.tenantId,
      partyId: input.partyId,
      kind: input.kind,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
  }

  async listForSubject(
    tenantId: string,
    subjectKind: string,
    subjectRef: string,
  ): Promise<readonly SubjectDocument[]> {
    return this.deps.documents.listForSubject({
      tenantId,
      subjectKind: this.requireSubjectKind(subjectKind),
      subjectRef,
    });
  }

  async versions(tenantId: string, documentId: string): Promise<readonly DocumentVersion[]> {
    await this.get(tenantId, documentId);
    return this.deps.documents.versions(tenantId, documentId);
  }

  async linksOf(tenantId: string, documentId: string): Promise<readonly DocumentLinkRecord[]> {
    await this.get(tenantId, documentId);
    return this.deps.documents.linksOf(tenantId, documentId);
  }

  /**
   * Take a document OFF something it was attached to (0302, decided
   * 2026-09-25). Withdrawn, never deleted: the link row stays and says when
   * and by whom, because "what was filed against this engagement" has to be
   * able to answer "this, in error, for a fortnight". The bytes are untouched
   * and every other attachment stands. Putting it back is `attach` again.
   */
  async withdraw(input: WithdrawInput): Promise<DocumentLink> {
    const subjectKind = this.requireSubjectKind(input.subjectKind);
    const record = await this.get(input.tenantId, input.documentId);

    // The copy of record stays where it is (2026-09-29, `hasCopyOfRecord`).
    const here = await this.deps.documents.listForSubject({
      tenantId: input.tenantId,
      subjectKind,
      subjectRef: input.subjectRef,
    });
    if (here.some((d) => d.document.id === input.documentId && d.role === RENDERED_ROLE.copyOfRecord)) {
      throw new CopyOfRecordStays(record.document.title);
    }

    const withdrawn = await this.deps.documents.withdraw({
      tenantId: input.tenantId,
      documentId: input.documentId,
      subjectKind,
      subjectRef: input.subjectRef,
      // The instant is the database's, as `created_at` is on the same row.
      withdrawnBy: input.actor.type === "human" ? input.actor.id : null,
    });
    if (withdrawn === null) throw new LinkNotFound(subjectKind, input.subjectRef);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.link_withdrawn",
      objectId: input.documentId,
      actor: input.actor,
      payload: { subjectKind, subjectRef: input.subjectRef, role: withdrawn.role },
    });
    return withdrawn;
  }

  /**
   * The bytes themselves — the read every download route makes.
   *
   * **This is the only way bytes leave the product, and that is the acceptance
   * criterion "no pre-signed URL escape".** A pre-signed URL is a capability
   * that outlives the session that minted it and is checked by the storage
   * vendor rather than by this product, which means it answers to none of the
   * four scoping gates. Going through here means every byte passes RLS (the
   * repository read is inside `withTenant`) and, when Gate 4 lands, record
   * scope as well.
   *
   * `versionId` absent means the latest, which is what a download link uses;
   * naming one is how "the copy they actually signed" is fetched.
   */
  async fetchBytes(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly versionId?: string | undefined;
  }): Promise<FetchedBytes> {
    const record = await this.get(input.tenantId, input.documentId);

    let version = record.latestVersion;
    if (input.versionId !== undefined) {
      const named = await this.deps.documents.findVersion(input.tenantId, input.versionId);
      // The second half of the condition is the tenant wall's business, not
      // politeness: without it, a version id from another document — or one
      // guessed entirely — would serve bytes under this document's permission
      // check.
      if (!named || named.documentId !== input.documentId) {
        throw new VersionNotFound(input.documentId, null);
      }
      version = named;
    }

    const bytes = await this.deps.blobs.get({
      tenantId: input.tenantId,
      storageKey: version.storageKey,
    });
    if (bytes === null) throw new BytesMissing(version.storageKey);

    return { version, bytes };
  }

  /**
   * Render one of the product's own records and store the result.
   *
   * The rendered file is a DOCUMENT like any other — same store, same versions,
   * same content hash. That is what makes "the letter we sent on 3 September"
   * answerable: it is a version row, not a PDF regenerated on demand from rows
   * that have since moved on.
   *
   * **Re-rendering unchanged data produces the same bytes**, which is the whole
   * reason the renderer is deterministic — so this is safe to call twice, and
   * the content-addressed store writes one blob either way.
   */
  async render(input: {
    readonly tenantId: string;
    readonly kind: DocumentKind;
    readonly subjectKind: string;
    readonly subjectRef: string;
    // NO `partyId`. It used to be one, taken from the request body, and it
    // decided which client's portal library a rendered invoice appears in —
    // see `DescribedDocument` for what that let a caller do. The record knows
    // whose it is.
    readonly actor: Actor;
  }): Promise<DocumentRecord> {
    const subjectKind = this.requireSubjectKind(input.subjectKind);
    if (!this.deps.renderSource.supports(input.kind)) {
      throw new NotRenderable(input.kind, ["engagement_letter", "invoice", "proposal"]);
    }

    // A DRAFT IS DRAWN AS IT WILL GO OUT, on the firm's day (B42, audit
    // 2026-10-03): dated today on the firm's calendar, as Send or Issue will
    // date it, never the day it was first saved on Greenwich's. The same
    // description the preview draws, so the draft copy on file and the pages
    // on the screen agree. A record already out is described as it stands.
    const asIfSentOn = dayInZone(
      this.deps.clock.now().toISOString(),
      await this.deps.timeZones.timeZoneFor(input.tenantId),
    );
    const source = await this.deps.renderSource.describe({
      tenantId: input.tenantId,
      kind: input.kind,
      subjectRef: input.subjectRef,
      asIfSentOn,
    });
    if (source === null) throw new SourceNotFound(input.kind, input.subjectRef);
    const described = source.document;
    // A draft invoice has no number until it is issued (0322); its page prints
    // "Draft" where the number goes, which is no name for a file.
    const number = source.unnumbered === true ? null : described.reference;

    // WHAT THIS COPY IS (2026-09-29, `hasCopyOfRecord`). An invoice or a
    // letter still in draft is printed as the firm's own DRAFT copy, which its
    // client never sees. Once it has gone out, the first copy is the copy of
    // record and there is never a second: refused BEFORE anything is drawn or
    // stored.
    let role: string = RENDERED_ROLE.rendered;
    let title = number === null ? described.documentTitle : `${described.documentTitle} ${number}`;
    // CA#56: what it is, its number and whose, never "Draft-draft.pdf".
    const named = (draft: boolean): string =>
      renderedFilename({ kind: input.kind, reference: number, clientName: described.recipient.name, draft });
    let filename = named(false);
    let isClientVisible = clientVisibleByDefault(input.kind);
    if (hasCopyOfRecord(input.kind)) {
      if (source.isOut) {
        const filed = await this.deps.documents.listForSubject({
          tenantId: input.tenantId,
          subjectKind,
          subjectRef: input.subjectRef,
        });
        const ofRecord = filed.find((d) => d.role === RENDERED_ROLE.copyOfRecord);
        if (ofRecord !== undefined) {
          const zone = await this.deps.timeZones.timeZoneFor(input.tenantId);
          throw new CopyAlreadyMade(
            input.kind,
            described.reference,
            dayInZone(ofRecord.document.createdAt, zone),
          );
        }
        role = RENDERED_ROLE.copyOfRecord;
      } else {
        role = RENDERED_ROLE.draftCopy;
        title = `Draft ${title}`;
        filename = named(true);
        isClientVisible = false;
      }
    }

    const bytes = await this.deps.renderer.render(described);
    const contentHash = this.deps.digest.ofBytes(bytes);
    const { storageKey } = await this.deps.blobs.put({
      tenantId: input.tenantId,
      contentHash,
      bytes,
    });

    const documentId = this.deps.ids.newId();
    const record = await this.deps.documents.create(
      {
        id: documentId,
        tenantId: input.tenantId,
        title,
        origin: "generated",
        kind: input.kind,
        // WHOSE record this is, off the record itself. Never the caller's word
        // for it: a rendered invoice is client-visible by default, so a wrong
        // id here files one firm's invoice in another client's portal library.
        partyId: source.partyId,
        // Same rule for a rendered document. A generated engagement letter is
        // the one the client signed; a generated proposal is a quote that may
        // never be sent, which is why `proposal` is false in that mapping. A
        // DRAFT copy of an invoice or a letter is the firm's own (above).
        isClientVisible,
        createdBy: input.actor.type === "human" ? input.actor.id : null,
      },
      {
        id: this.deps.ids.newId(),
        tenantId: input.tenantId,
        documentId,
        contentHash,
        byteSize: bytes.byteLength,
        mediaType: this.deps.renderer.mediaType,
        filename,
        storageKey,
        createdBy: input.actor.type === "human" ? input.actor.id : null,
      },
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "document.stored",
      objectId: documentId,
      actor: input.actor,
      payload: {
        kind: input.kind,
        origin: "generated",
        versionNo: record.latestVersion.versionNo,
        contentHash,
        byteSize: bytes.byteLength,
        mediaType: this.deps.renderer.mediaType,
        renderer: this.deps.renderer.kind,
      },
    });

    await this.attach({
      tenantId: input.tenantId,
      documentId,
      subjectKind,
      subjectRef: input.subjectRef,
      role,
      actor: input.actor,
    });

    return record;
  }

  /**
   * Draw a record and hand the bytes back, FILING NOTHING (2026-09-28): no
   * blob, no document, no link, no event. The preview a screen shows in place
   * of an HTML imitation of the document — "the preview IS the PDF".
   *
   * **Why this is not a second way for bytes to leave.** T3.6's rule is about
   * STORED bytes: a stored file leaves only through `fetchBytes`, under RLS,
   * with no URL that outlives the session. This stores nothing and returns no
   * storage key; it draws rows the caller can already read under RLS (the
   * source reads inside `withTenant`) through the same renderer `render` uses,
   * so it can hand out nothing the caller could not have asked `render` to
   * file and then downloaded.
   *
   * **A draft is described as Send will leave it**, on the firm's day: a
   * proposal is dated that day; a letter is dated that day (or the caller's,
   * `asOf`, held to the firm's day or one either side as Send holds it) unless
   * the drafter set a date, and carries the firm's signature block when the
   * firm names a signatory. Rendering is deterministic, so an unedited draft
   * previews the very bytes Send produces on the same day — which a test proves
   * by hash. A document already out is drawn as it stands, which the freeze
   * makes the file of record.
   */
  async preview(input: {
    readonly tenantId: string;
    readonly kind: DocumentKind;
    readonly subjectRef: string;
    readonly asOf?: string | undefined;
  }): Promise<DocumentPreview> {
    if (!this.deps.renderSource.supports(input.kind)) {
      throw new NotRenderable(input.kind, ["engagement_letter", "invoice", "proposal"]);
    }
    const firmDay = dayInZone(
      this.deps.clock.now().toISOString(),
      await this.deps.timeZones.timeZoneFor(input.tenantId),
    );
    if (input.asOf !== undefined && !isCallersToday(input.asOf, firmDay)) {
      throw new PreviewNotCallersToday(input.asOf, firmDay);
    }
    // A proposal is dated by Send on the FIRM's day (`zoneDayOf(sent_at)`); a
    // letter on the caller's (`callersDay`); an invoice by Issue on the firm's
    // (B42: a draft invoice printed the UTC day it was first saved).
    const asIfSentOn = input.kind === "engagement_letter" ? (input.asOf ?? firmDay) : firmDay;

    const source = await this.deps.renderSource.describe({
      tenantId: input.tenantId,
      kind: input.kind,
      subjectRef: input.subjectRef,
      asIfSentOn,
    });
    if (source === null) throw new SourceNotFound(input.kind, input.subjectRef);
    const described = source.document;

    const drawn = await this.deps.renderer.renderWithAnchors(described);
    const missingBrand: ("logo" | "proposal_cover")[] = [];
    if (described.logo === null) missingBrand.push("logo");
    if (described.proposal !== undefined && described.proposal.cover.artwork === null) {
      missingBrand.push("proposal_cover");
    }
    return {
      reference: described.reference,
      bytes: drawn.bytes,
      contentHash: this.deps.digest.ofBytes(drawn.bytes),
      mediaType: this.deps.renderer.mediaType,
      pageCount: drawn.pageCount,
      anchors: drawn.anchors,
      datedAsIfSent: source.datedAsIfSent ?? null,
      issuingEntity: source.issuingEntity ?? null,
      missingBrand,
    };
  }

  /** Whether a document of this kind can be rendered — asked by a screen before
   *  it offers the button. */
  canRender(kind: DocumentKind): boolean {
    return this.deps.renderSource.supports(kind);
  }

  /**
   * Put a logo, signature, letterhead or proposal cover in force for one of the
   * firm's entities.
   *
   * Supersedes rather than edits: the mark in force when a document was issued
   * stays readable, which is the same argument `is_active` carries on the grade
   * ladder (G3.3).
   */
  async setBrandAsset(input: {
    readonly tenantId: string;
    readonly entityPartyId: string;
    readonly kind: BrandAssetKind;
    readonly documentVersionId: string;
    readonly actor: Actor;
  }): Promise<BrandAssetRecord> {
    const version = await this.deps.documents.findVersion(input.tenantId, input.documentVersionId);
    if (!version) throw new VersionNotFound(input.documentVersionId, null);

    // REFUSED HERE, not dropped at render time. A logo and a signature are DRAWN
    // onto every document the entity issues, and the renderer can embed PNG and
    // JPEG only; anything else stored fine and then disappeared from every
    // letter and invoice with nothing saying so. The letterhead is exempt on
    // purpose — it is legitimately a PDF and nothing draws it as an image. The
    // proposal cover (0084) is not: it IS the first page of every proposal.
    if (input.kind !== "letterhead" && !isDrawableImage(version.mediaType)) {
      throw new BrandAssetNotDrawable(input.kind, version.mediaType);
    }

    const asset = await this.deps.documents.setBrandAsset({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      entityPartyId: input.entityPartyId,
      kind: input.kind,
      documentVersionId: input.documentVersionId,
      createdBy: input.actor.type === "human" ? input.actor.id : null,
    });

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "brand_asset.set",
      objectId: asset.asset.id,
      actor: input.actor,
      payload: {
        entityPartyId: input.entityPartyId,
        kind: input.kind,
        documentVersionId: input.documentVersionId,
        contentHash: version.contentHash,
      },
    });

    return asset;
  }

  async brandAssets(tenantId: string, entityPartyId: string): Promise<readonly BrandAssetRecord[]> {
    return this.deps.documents.activeBrandAssets(tenantId, entityPartyId);
  }

  async requireBrandAsset(
    tenantId: string,
    entityPartyId: string,
    kind: BrandAssetKind,
  ): Promise<BrandAssetRecord> {
    const assets = await this.deps.documents.activeBrandAssets(tenantId, entityPartyId);
    const found = assets.find((a) => a.asset.kind === kind);
    if (!found) throw new BrandAssetNotFound(entityPartyId, kind);
    return found;
  }

  private requireSubjectKind(raw: string): SubjectKind {
    if (!isSubjectKind(raw)) throw new UnknownSubjectKind(raw, SUBJECT_KINDS);
    return raw;
  }
}
