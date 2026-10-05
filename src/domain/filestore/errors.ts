// Sentinel errors — the closed vocabulary of ways a document-store operation
// fails. They live in the domain so the meaning is owned here; the api layer
// maps them to HTTP status codes (domainerr.ts). Match with `instanceof`, never
// string search.
//
// Every code added here is a COMPILE error until `api/domainerr.ts` maps it —
// its switch ends `default: return unmapped(err.code)` and `unmapped` takes
// `never`. That is deliberate, and it is why `StaffGradeError` cannot happen
// twice (G3.3 shipped answering 500 to every refusal).

export class FileStoreError extends Error {
  constructor(
    readonly code: FileStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type FileStoreErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "EMPTY_CONTENT"
  | "CONTENT_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CONTENT_NOT_OF_TYPE"
  | "BRAND_ASSET_NOT_DRAWABLE"
  | "INVALID_FILENAME"
  | "INVALID_TITLE"
  | "UNKNOWN_SUBJECT_KIND"
  | "ALREADY_ATTACHED"
  | "BYTES_MISSING"
  | "BRAND_ASSET_NOT_FOUND"
  | "LINK_NOT_FOUND"
  | "COPY_OF_RECORD_STAYS"
  | "DRAFT_NOT_SHAREABLE";

export class DocumentNotFound extends FileStoreError {
  constructor(id: string) {
    super("DOCUMENT_NOT_FOUND", `No document ${JSON.stringify(id)} at this firm`);
  }
}

export class VersionNotFound extends FileStoreError {
  constructor(documentId: string, versionNo: number | null) {
    super(
      "VERSION_NOT_FOUND",
      versionNo === null
        ? `document ${JSON.stringify(documentId)} has no versions, which should be impossible, ` +
            `because a document is created with its first version in one transaction. Treat this ` +
            `as data corruption rather than an ordinary miss.`
        : `document ${JSON.stringify(documentId)} has no version ${versionNo}`,
    );
  }
}

export class EmptyContent extends FileStoreError {
  constructor(filename: string) {
    // Not silent, and not stored. A zero-byte upload is always a failed one,
    // and accepting it means a client sees "PAN card attached" over nothing —
    // which is worse than an error, because it looks like the work is done.
    super(
      "EMPTY_CONTENT",
      `${JSON.stringify(filename)} is zero bytes. An empty file is a failed upload, not a ` +
        `document: storing it would show as an attachment over nothing.`,
    );
  }
}

export class ContentTooLarge extends FileStoreError {
  constructor(byteSize: number, limitBytes: number) {
    super(
      "CONTENT_TOO_LARGE",
      `This file is ${byteSize} bytes and the limit is ${limitBytes} ` +
        `(BIB_MAX_UPLOAD_BYTES). Raise the limit deliberately if the firm genuinely needs it: ` +
        `the whole file is held in memory to be hashed, so the limit is a memory budget and not ` +
        `an arbitrary preference.`,
    );
  }
}

export class UnsupportedMediaType extends FileStoreError {
  constructor(raw: string) {
    super(
      "UNSUPPORTED_MEDIA_TYPE",
      `${JSON.stringify(raw)} is not a media type this store can record. Expected ` +
        `type/subtype, like "application/pdf" or "image/png".`,
    );
  }
}

/** F-14-1: the bytes are not the type they were sent as (`contentMatchesType`). */
export class ContentNotOfType extends FileStoreError {
  constructor(mediaType: string, filename: string) {
    super(
      "CONTENT_NOT_OF_TYPE",
      `${filename} was sent as ${mediaType}, but its contents are not a file of that type. ` +
        "Open it on your computer to check it is the file you meant, save it again in its own " +
        "format, and upload that.",
    );
  }
}

export class InvalidFilename extends FileStoreError {
  constructor(raw: string) {
    super(
      "INVALID_FILENAME",
      `${JSON.stringify(raw)} leaves nothing usable as a filename once path separators and ` +
        `control characters are removed. The filename is a label shown to people, never a path.`,
    );
  }
}

export class InvalidTitle extends FileStoreError {
  constructor() {
    super(
      "INVALID_TITLE",
      `A document needs a title: it is what somebody scanning a client's file sees, and the ` +
        `filename is not always legible ("scan_0043.pdf")`,
    );
  }
}

export class UnknownSubjectKind extends FileStoreError {
  constructor(raw: string, known: readonly string[]) {
    // Names the valid set, per CLAUDE.md. This one matters more than most: the
    // subject reference has no foreign key, so this refusal is the ONLY thing
    // standing between a typo and a link nothing can ever resolve.
    super(
      "UNKNOWN_SUBJECT_KIND",
      `${JSON.stringify(raw)} is not something a document can be attached to. Known: ` +
        `${known.join(", ")}. This is checked rather than trusted because a subject reference ` +
        `carries no foreign key: an unknown kind would be a link nothing can follow.`,
    );
  }
}

export class AlreadyAttached extends FileStoreError {
  constructor(subjectKind: string, subjectRef: string) {
    super(
      "ALREADY_ATTACHED",
      `This document is already attached to ${subjectKind} ${JSON.stringify(subjectRef)}. ` +
        `Attaching the same file to the same thing twice is a double-click, not a second fact.`,
    );
  }
}

export class LinkNotFound extends FileStoreError {
  constructor(subjectKind: string, subjectRef: string) {
    super(
      "LINK_NOT_FOUND",
      `This document is not attached to ${subjectKind} ${JSON.stringify(subjectRef)}, so ` +
        `there is nothing to take off. It may already have been withdrawn.`,
    );
  }
}

/**
 * Taking an issued invoice's or a sent letter's copy of record off it
 * (2026-09-29). It is the document the client holds, and with it gone the
 * store would draw a new one from today's rows: the rename the copy of record
 * exists to keep out would be back in through a side door.
 */
export class CopyOfRecordStays extends FileStoreError {
  constructor(title: string) {
    super(
      "COPY_OF_RECORD_STAYS",
      `${title} is the copy the client was given, so it stays on the record. To correct an ` +
        `issued invoice, raise a credit note and a new invoice.`,
    );
  }
}

/**
 * A DRAFT is the firm's own and is never shared with the client (B10, audit
 * 2026-10-03). The Share switch on a "Draft, firm only" copy put a draft
 * invoice in the client's portal library, which is the bug the copy of record
 * (2026-09-29) had closed. A draft copy stays a draft copy after the record
 * goes out: the PDF says "Draft" on it.
 */
export class DraftNotShareable extends FileStoreError {
  constructor(title: string) {
    super(
      "DRAFT_NOT_SHAREABLE",
      `${title} is a draft, and a draft is never shown to the client. Issue the invoice, or send ` +
        `the letter or proposal, and share the copy that went out.`,
    );
  }
}

export class BytesMissing extends FileStoreError {
  constructor(storageKey: string) {
    // The row says the bytes exist and the store disagrees. This is never an
    // ordinary 404 to the caller — the metadata is intact, so the honest answer
    // is that the storage backend has lost something, and saying "not found"
    // would send whoever reads it looking for a deleted document instead.
    super(
      "BYTES_MISSING",
      `The storage backend has no object at ${JSON.stringify(storageKey)}, but a version row ` +
        `says it should. The document's metadata is intact and its bytes are not: this is a ` +
        `storage fault, not a missing document.`,
    );
  }
}

/**
 * A logo or signature in a format the renderer cannot draw.
 *
 * REFUSED AT THE UPLOAD, which is the whole point of it. `RenderableImage` has
 * always said "anything else is refused by the caller rather than silently
 * dropped" and the render source did the opposite: a `.webp` logo stored
 * perfectly, passed the brand screen's `accept="image/*"`, and then vanished on
 * every document with nothing anywhere saying why. The person who can fix that
 * is standing on the brand screen at the moment of upload; by render time they
 * are a client looking at a letter with no letterhead.
 *
 * A LETTERHEAD IS NOT REFUSED. It is legitimately a PDF — the full stationery a
 * firm prints on — and nothing draws it as an image, so the drawable formats are
 * not its rule.
 */
export class BrandAssetNotDrawable extends FileStoreError {
  constructor(kind: string, mediaType: string) {
    super(
      "BRAND_ASSET_NOT_DRAWABLE",
      `A ${kind.replace(/_/g, " ")} is drawn onto the documents this entity issues, and the renderer can only ` +
        `draw PNG and JPEG: ${JSON.stringify(mediaType)} cannot be. Upload a .png or .jpg. ` +
        `A signature needs a transparent background, so PNG is the one to use for that.`,
    );
  }
}

export class BrandAssetNotFound extends FileStoreError {
  constructor(entityPartyId: string, kind: string) {
    super(
      "BRAND_ASSET_NOT_FOUND",
      `This firm's entity ${JSON.stringify(entityPartyId)} has no active ${kind}`,
    );
  }
}
