// Sentinel errors for FinCompliance. They live in the domain so the meaning is
// owned here; `api/domainerr.ts` maps them to HTTP status codes. Match with
// `instanceof`, never a string search.
//
// Every code added here is a COMPILE error until `api/domainerr.ts` maps it.

export class FinError extends Error {
  constructor(
    readonly code: FinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type FinErrorCode =
  | "FIN_NOT_ENABLED"
  | "FIN_PDF_UNREADABLE"
  | "FIN_IMAGE_UNREADABLE";

/** Fin is switched off for this firm. A 404, as the plan says: to a firm
 *  without it, fin's routes are not there — and a 403 would read as "you lack
 *  a permission", which no role change can fix. */
export class FinNotEnabled extends FinError {
  constructor() {
    super(
      "FIN_NOT_ENABLED",
      "FinCompliance is not switched on for this firm. It is enabled per firm by the platform " +
        "(tenancy.tenant.fin_enabled_since); nothing under /api/v1/fin answers until it is.",
    );
  }
}

// ── Reading a file (F2.3) ────────────────────────────────────────────────────
//
// Raised by the PDF and image adapters behind `usecase/fin/reading.ts`, in the
// fin job, about a file a CLIENT sent. Nothing about them is the server's
// fault, so they are never a 500; a reader turns them into `needs_person` with
// the matching `ReadProblem`, and the file goes to a person as "could not be
// read", never away.

/** Why a PDF has no text to give. */
export type PdfUnreadableReason = "damaged" | "encrypted" | "too_large";

/** The bytes are not a PDF this can open: not a PDF at all or damaged past
 *  reading, locked with a password, or past the size a reader accepts. */
export class PdfUnreadable extends FinError {
  constructor(
    readonly reason: PdfUnreadableReason,
    detail: string,
  ) {
    super("FIN_PDF_UNREADABLE", `${PDF_SENTENCES[reason]} (${detail})`);
  }
}

const PDF_SENTENCES: Readonly<Record<PdfUnreadableReason, string>> = {
  damaged:
    "This file could not be opened as a PDF: it is not a PDF, or it is damaged. Ask the client to " +
    "download it again from the bank or the supplier and send that copy.",
  encrypted:
    "This PDF is protected by a password, so its text cannot be read. Ask the client for a copy " +
    "without the password (most banks' statement download has the option).",
  too_large:
    "This PDF is larger than a statement or an invoice can be, so it was not opened. Ask the " +
    "client to send it month by month.",
};

/** Why an image could not be made ready for reading. */
export type ImageUnreadableReason = "unsupported" | "damaged" | "too_large";

/** The bytes are not an image this can decode: a format it does not read (an
 *  iPhone's HEIC, see the adapter), damaged, or larger than it will decode. */
export class ImageUnreadable extends FinError {
  constructor(
    readonly reason: ImageUnreadableReason,
    detail: string,
  ) {
    super("FIN_IMAGE_UNREADABLE", `${IMAGE_SENTENCES[reason]} (${detail})`);
  }
}

const IMAGE_SENTENCES: Readonly<Record<ImageUnreadableReason, string>> = {
  unsupported:
    "This image is in a format that cannot be read here. Ask the client to send it as a JPEG or " +
    "PNG (on an iPhone: Settings, Camera, Formats, Most Compatible).",
  damaged: "This image could not be decoded: the file is damaged or is not an image.",
  too_large:
    "This image has more pixels than a photo of a document needs, so it was not opened. Ask the " +
    "client to send a smaller copy.",
};
