// The document store's HTTP surface (T3.6) — transport only. Each handler
// parses the validated input, calls exactly one use-case method, and maps the
// result field by field. Never forwards a domain object: zod-openapi documents a
// response without validating it, so a field on the wire but not in the schema
// is one the generated frontend client cannot see.
//
// TWO THINGS HERE ARE UNLIKE EVERY OTHER HANDLER IN THIS REPO, and both are
// worth stating rather than discovering:
//
//   * A request body that is not JSON. Uploads are `multipart/form-data`,
//     because a base64 field in a JSON body inflates a scanned PDF by a third
//     and has to be buffered twice. The form is declared in the route so the
//     generated client and the docs both know its shape.
//
//   * A response body that is not JSON. `/content` returns the bytes. This is
//     THE acceptance criterion — "every byte via an RLS-checked route, no
//     pre-signed URL escape" — so it is worth being explicit about what that
//     buys: a pre-signed URL is a capability that outlives the session that
//     minted it and is checked by a storage vendor rather than by this product,
//     which means it answers to none of the four scoping gates. Bytes leaving
//     through a route mean every one of them passed RLS on the way out.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { FileStoreService } from "../../usecase/filestore/service";
import type { BrandAssetRecord, DocumentLinkRecord, DocumentRecord } from "../../usecase/filestore/ports";
import type { DocumentVersion } from "../../domain/filestore/model";
import {
  BRAND_ASSET_KINDS,
  DOCUMENT_KINDS,
  SUBJECT_KINDS,
  contentDispositionFor,
  isBrandAssetKind,
  isDocumentKind,
} from "../../domain/filestore/model";
import { InvalidTitle, UnsupportedMediaType } from "../../domain/filestore/errors";
import { scopeOf } from "../scope";

export interface FileStoreDeps {
  readonly service: FileStoreService;
}

// ── Response schemas ────────────────────────────────────────────────────────

const VersionSchema = z
  .object({
    id: z.string().uuid(),
    // The document this version belongs to. Present because bytes are fetched
    // at `/documents/{documentId}/...` and a version handed out on its own —
    // a brand asset carries one — was otherwise unreachable: the caller had a
    // version id and no way to build the URL. Found by building the screen,
    // which is the fourth time that has been the thing that found it.
    documentId: z.string().uuid(),
    versionNo: z.number().int(),
    contentHash: z.string().openapi({
      description:
        "Lower-case hex SHA-256 of the bytes. The same value an engagement letter commits to, " +
        "so 'is the file the client holds the one we issued' is a comparison rather than a " +
        "matter of trust.",
    }),
    byteSize: z.number().int(),
    mediaType: z.string(),
    filename: z.string(),
    createdAt: z.string(),
  })
  .openapi("DocumentVersion");

const CreatedBySchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    email: z.string(),
  })
  .openapi("DocumentUploader");

const DocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    origin: z.enum(["generated", "uploaded"]).openapi({
      description:
        "Whether the product made this file or a person supplied it. An uploaded document is " +
        "the only copy in existence; a generated one could be produced again.",
    }),
    isClientVisible: z.boolean().openapi({
      description:
        "Whether the client this belongs to can see it in their portal library (T6.7). Set " +
        "from the document's KIND when it is stored — a challan yes, a working paper no — " +
        "and changeable either way from this endpoint's sibling. Enforced by a policy in the " +
        "database, never by a query: a portal read that forgot to filter would return your " +
        "own working papers with a 200.",
    }),
    kind: z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]).openapi({
      description:
        "What the document is. A CLOSED set — the product's own document types, mirrored by " +
        "the CHECK in migration 0037. Declared as an enum and not a bare string so the " +
        "generated client keeps the closure: a screen that has to switch on this should get a " +
        "compile error when a kind is added, not a silent default.",
    }),
    partyId: z.string().uuid().nullable(),
    partyName: z.string().nullable().openapi({
      description: "The client's name, joined so a list never has to fetch one row per document.",
    }),
    createdBy: CreatedBySchema.nullable().openapi({
      description:
        "Who uploaded it. NULL means the system generated it, or the person's account has " +
        "been erased. The email is what distinguishes those from a person whose display name " +
        "is simply unset — the same arrangement the audit trail's actor uses.",
    }),
    versionCount: z.number().int(),
    latestVersion: VersionSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Document");

const DocumentsResponse = z
  .object({ documents: z.array(DocumentSchema) })
  .openapi("DocumentsResponse");

const VersionsResponse = z
  .object({ versions: z.array(VersionSchema) })
  .openapi("DocumentVersionsResponse");

const LinkSchema = z
  .object({
    id: z.string().uuid(),
    subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]).openapi({
      description:
        "What the document is attached to. A CLOSED set, and the closure is load-bearing: the " +
        "reference below carries no foreign key, so this is the only thing keeping a link " +
        "inside a vocabulary anything can resolve.",
    }),
    subjectRef: z.string().uuid(),
    subjectLabel: z.string().nullable().openapi({
      description:
        "What the subject is called. NULL when it does not resolve — a subject reference " +
        "carries no foreign key, so a dangling link is possible and is shown as unresolved " +
        "rather than rendered blank.",
    }),
    role: z.string().nullable(),
    createdAt: z.string(),
    withdrawnAt: z.string().nullable().openapi({
      description:
        "When the document was taken OFF this subject, or null while it is still attached. A " +
        "withdrawn link is kept and shown as history rather than deleted (0302).",
    }),
  })
  .openapi("DocumentLink");

const LinksResponse = z.object({ links: z.array(LinkSchema) }).openapi("DocumentLinksResponse");

const BrandAssetSchema = z
  .object({
    id: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    entityName: z.string(),
    kind: z.enum(["logo", "signature", "letterhead"]),
    documentVersionId: z.string().uuid(),
    version: VersionSchema,
    createdAt: z.string(),
  })
  .openapi("BrandAsset");

const BrandAssetsResponse = z
  .object({ assets: z.array(BrandAssetSchema) })
  .openapi("BrandAssetsResponse");

function versionToWire(v: DocumentVersion): z.infer<typeof VersionSchema> {
  return {
    id: v.id,
    documentId: v.documentId,
    versionNo: v.versionNo,
    contentHash: v.contentHash,
    byteSize: v.byteSize,
    mediaType: v.mediaType,
    filename: v.filename,
    createdAt: v.createdAt,
  };
}

function toWire(r: DocumentRecord): z.infer<typeof DocumentSchema> {
  return {
    id: r.document.id,
    title: r.document.title,
    origin: r.document.origin,
    kind: r.document.kind,
    partyId: r.document.partyId,
    partyName: r.partyName,
    isClientVisible: r.document.isClientVisible,
    createdBy: r.createdBy,
    versionCount: r.versionCount,
    latestVersion: versionToWire(r.latestVersion),
    createdAt: r.document.createdAt,
    updatedAt: r.document.updatedAt,
  };
}

function linkToWire(r: DocumentLinkRecord): z.infer<typeof LinkSchema> {
  return {
    id: r.link.id,
    subjectKind: r.link.subjectKind,
    subjectRef: r.link.subjectRef,
    subjectLabel: r.subjectLabel,
    role: r.link.role,
    createdAt: r.link.createdAt,
    withdrawnAt: r.link.withdrawnAt,
  };
}

function brandAssetToWire(r: BrandAssetRecord): z.infer<typeof BrandAssetSchema> {
  return {
    id: r.asset.id,
    entityPartyId: r.asset.entityPartyId,
    entityName: r.entityName,
    kind: r.asset.kind,
    documentVersionId: r.asset.documentVersionId,
    version: versionToWire(r.version),
    createdAt: r.asset.createdAt,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

// `z.any()` for the file with an explicit OpenAPI type, which is the documented
// way to describe a binary part: zod has no File schema that survives spec
// generation, and `z.instanceof(File)` produces an empty schema in the output.
const binaryPart = z.any().openapi({ type: "string", format: "binary" });

const UploadForm = z
  .object({
    file: binaryPart,
    title: z.string().min(1).openapi({
      description:
        "What somebody scanning a client's file sees. Required and not defaulted from the " +
        "filename, because 'scan_0043.pdf' is not a title.",
    }),
    kind: z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]),
    partyId: z.string().uuid().optional(),
    subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]).optional(),
    subjectRef: z.string().uuid().optional(),
    role: z.string().optional(),
  })
  .openapi("UploadDocumentForm");

const NewVersionForm = z.object({ file: binaryPart }).openapi("NewDocumentVersionForm");

const RenderRequest = z
  .object({
    kind: z.enum(["engagement_letter", "invoice"]).openapi({
      description: "What to render. Deliberately narrow — the API says what it can do.",
    }),
    subjectRef: z.string().uuid(),
    // NO `partyId`. It was here, and it decided which client's portal library
    // the rendered PDF lands in — so a stale or invented id filed one client's
    // invoice under another, where `clientVisibleByDefault("invoice")` shows it
    // to them. The record already knows whose it is and the service reads it
    // there. Left OUT of the schema rather than accepted-and-ignored so the
    // generated client stops sending it.
  })
  .openapi("RenderDocumentRequest");

const AttachRequest = z
  .object({
    subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]),
    subjectRef: z.string().uuid(),
    role: z.string().nullable().optional(),
  })
  .openapi("AttachDocumentRequest");

const WithdrawRequest = z
  .object({
    subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]),
    subjectRef: z.string().uuid(),
  })
  .openapi("WithdrawDocumentRequest");

const SetBrandAssetRequest = z
  .object({ documentVersionId: z.string().uuid() })
  .openapi("SetBrandAssetRequest");

const DocumentParam = z.object({ documentId: z.string().uuid() });
const VersionParam = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});
const SubjectParam = z.object({
  subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]),
  subjectRef: z.string().uuid(),
});
const BrandAssetParam = z.object({
  entityPartyId: z.string().uuid(),
  kind: z.enum(BRAND_ASSET_KINDS as unknown as [string, ...string[]]),
});

const ListQuery = z.object({
  partyId: z.string().uuid().optional(),
  kind: z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// The bytes. `z.any()` because the body is not JSON and there is nothing for a
// schema to describe beyond its media type.
const binaryResponse = {
  description: "The document's bytes",
  content: { "application/octet-stream": { schema: z.any() } },
};

// ── Routes ──────────────────────────────────────────────────────────────────

const uploadRoute = createRoute({
  method: "post",
  path: "/api/v1/documents",
  tags: ["documents"],
  summary: "Store a file, and usually attach it to something in the same act",
  description:
    "Multipart, because base64 in a JSON body inflates a scanned PDF by a third. Supplying " +
    "subjectKind and subjectRef attaches the document as it is stored, which is the ordinary " +
    "case — a file is almost always uploaded ONTO something.",
  request: {
    body: { content: { "multipart/form-data": { schema: UploadForm } }, required: true },
  },
  responses: {
    201: { description: "Stored", content: { "application/json": { schema: DocumentSchema } } },
    400: errorResponse("Empty file, unusable filename or media type, or an unknown subject kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write"),
    413: errorResponse("The file is larger than BIB_MAX_UPLOAD_BYTES"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/documents",
  tags: ["documents"],
  summary: "The firm's documents, newest first",
  request: { query: ListQuery },
  responses: {
    200: { description: "Documents", content: { "application/json": { schema: DocumentsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/documents/{documentId}",
  tags: ["documents"],
  summary: "One document, with its latest version",
  request: { params: DocumentParam },
  responses: {
    200: { description: "The document", content: { "application/json": { schema: DocumentSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
    404: errorResponse("No such document at this firm"),
  },
});

const contentRoute = createRoute({
  method: "get",
  path: "/api/v1/documents/{documentId}/content",
  tags: ["documents"],
  summary: "The latest version's bytes",
  description:
    "The only way bytes leave this product. There is no pre-signed URL: every byte passes RLS " +
    "on the way out, which a capability checked by a storage vendor could not.",
  request: { params: DocumentParam },
  responses: {
    200: binaryResponse,
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
    404: errorResponse("No such document at this firm"),
    502: errorResponse("The storage backend has lost the bytes this version names"),
  },
});

const versionContentRoute = createRoute({
  method: "get",
  path: "/api/v1/documents/{documentId}/versions/{versionId}/content",
  tags: ["documents"],
  summary: "A NAMED version's bytes — the copy they actually signed",
  request: { params: VersionParam },
  responses: {
    200: binaryResponse,
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
    404: errorResponse("No such document, or no such version of it"),
    502: errorResponse("The storage backend has lost the bytes this version names"),
  },
});

const clientVisibilityRoute = createRoute({
  method: "patch",
  path: "/api/v1/documents/{documentId}/client-visibility",
  tags: ["documents"],
  summary: "Share this document with its client, or stop sharing it",
  description:
    "A DISCLOSURE decision, and it is recorded as one — its own audit verb rather than a " +
    "document edit, because 'when did this become visible to the client' is asked after " +
    "something has reached somebody it should not have. " +
    "Every document gets a sensible first value from its KIND when it is stored: a challan, " +
    "an invoice, a credit note and a signed engagement letter are things the client is a " +
    "party to; a working paper is your own thinking. This is how you disagree with that in " +
    "either direction. " +
    "A document with no `partyId` is the firm's own and belongs to no client, so there is " +
    "nobody to share it with — it answers 404.",
  request: {
    params: DocumentParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ isClientVisible: z.boolean() })
            .openapi("SetDocumentClientVisibility"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Changed", content: { "application/json": { schema: DocumentSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write documents"),
    404: errorResponse("No such document at this firm, or it belongs to no client"),
  },
});

const versionsRoute = createRoute({
  method: "get",
  path: "/api/v1/documents/{documentId}/versions",
  tags: ["documents"],
  summary: "Every version, newest first",
  request: { params: DocumentParam },
  responses: {
    200: { description: "Versions", content: { "application/json": { schema: VersionsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
    404: errorResponse("No such document at this firm"),
  },
});

const addVersionRoute = createRoute({
  method: "post",
  path: "/api/v1/documents/{documentId}/versions",
  tags: ["documents"],
  summary: "Supersede a document with new bytes",
  description:
    "Never a replace. Every earlier version stays readable, because 'which version did the " +
    "client sign' is asked every time a filing is questioned.",
  request: {
    params: DocumentParam,
    body: { content: { "multipart/form-data": { schema: NewVersionForm } }, required: true },
  },
  responses: {
    201: { description: "Stored", content: { "application/json": { schema: VersionSchema } } },
    400: errorResponse("Empty file, or an unusable filename or media type"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write"),
    404: errorResponse("No such document at this firm"),
    413: errorResponse("The file is larger than BIB_MAX_UPLOAD_BYTES"),
  },
});

const renderRoute = createRoute({
  method: "post",
  path: "/api/v1/documents/render",
  tags: ["documents"],
  summary: "Produce a PDF of one of the firm's own documents",
  description:
    "Renders an engagement letter or an invoice, stores it as a `generated` document and " +
    "attaches it to the record it came from. Re-rendering unchanged data produces the SAME " +
    "bytes and therefore the same content hash — the store is content-addressed, so calling " +
    "this twice costs one blob.",
  request: {
    body: { content: { "application/json": { schema: RenderRequest } }, required: true },
  },
  responses: {
    201: { description: "Rendered and stored", content: { "application/json": { schema: DocumentSchema } } },
    400: errorResponse("The document contains a character the renderer cannot draw"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write"),
    404: errorResponse("No such record at this firm"),
    501: errorResponse("Nothing knows how to render that kind of document yet"),
  },
});

const attachRoute = createRoute({
  method: "post",
  path: "/api/v1/documents/{documentId}/links",
  tags: ["documents"],
  summary: "Attach an existing document to something else as well",
  description:
    "The same file legitimately belongs to more than one thing — a PAN card is the party's and " +
    "is also evidence on the engagement that needed it.",
  request: {
    params: DocumentParam,
    body: { content: { "application/json": { schema: AttachRequest } }, required: true },
  },
  responses: {
    201: { description: "Attached", content: { "application/json": { schema: LinkSchema } } },
    400: errorResponse("Unknown subject kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write"),
    404: errorResponse("No such document at this firm"),
    409: errorResponse("Already attached to that subject"),
  },
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/api/v1/documents/{documentId}/links/withdraw",
  tags: ["documents"],
  summary: "Take a document off something it was attached to",
  description:
    "Withdrawn, never deleted: the link stays as history, marked with when and by whom, and " +
    "the document leaves that subject's file list. The bytes and every other attachment are " +
    "untouched. Attaching it again afterwards is an ordinary attach.",
  request: {
    params: DocumentParam,
    body: { content: { "application/json": { schema: WithdrawRequest } }, required: true },
  },
  responses: {
    200: { description: "Withdrawn", content: { "application/json": { schema: LinkSchema } } },
    400: errorResponse("Unknown subject kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write"),
    404: errorResponse("No such document at this firm, or it is not attached to that subject"),
  },
});

const linksRoute = createRoute({
  method: "get",
  path: "/api/v1/documents/{documentId}/links",
  tags: ["documents"],
  summary: "Everything this document is attached to",
  request: { params: DocumentParam },
  responses: {
    200: { description: "Links", content: { "application/json": { schema: LinksResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
    404: errorResponse("No such document at this firm"),
  },
});

const subjectDocumentsRoute = createRoute({
  method: "get",
  path: "/api/v1/subjects/{subjectKind}/{subjectRef}/documents",
  tags: ["documents"],
  summary: "Every document attached to one thing",
  description:
    "The read a client page, an engagement page or a job page makes to show its file list.",
  request: { params: SubjectParam },
  responses: {
    200: { description: "Documents", content: { "application/json": { schema: DocumentsResponse } } },
    400: errorResponse("Unknown subject kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
  },
});

const brandAssetsRoute = createRoute({
  method: "get",
  path: "/api/v1/firm-entities/{entityPartyId}/brand-assets",
  tags: ["documents"],
  summary: "The marks in force for one of the firm's own entities",
  request: { params: z.object({ entityPartyId: z.string().uuid() }) },
  responses: {
    200: { description: "Active assets", content: { "application/json": { schema: BrandAssetsResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read"),
  },
});

const setBrandAssetRoute = createRoute({
  method: "put",
  path: "/api/v1/firm-entities/{entityPartyId}/brand-assets/{kind}",
  tags: ["documents"],
  summary: "Put a logo, signature or letterhead in force",
  description:
    "Keyed on the ENTITY and not the firm: a firm with an Indian and a US entity signs on two " +
    "letterheads, and a letter issued by one printing the other's mark is the same class of " +
    "error as one printing the wrong governing law. Supersedes rather than edits — the mark in " +
    "force when a document was issued stays resolvable.",
  request: {
    params: BrandAssetParam,
    body: { content: { "application/json": { schema: SetBrandAssetRequest } }, required: true },
  },
  responses: {
    200: { description: "In force", content: { "application/json": { schema: BrandAssetSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such document version at this firm"),
  },
});

/**
 * The uploaded part, as bytes.
 *
 * `parseBody` rather than the validated form value, because zod cannot describe
 * a File and `z.any()` therefore passes whatever arrived through untouched — so
 * the check that it IS a file has to happen here, in the one place that knows.
 */
async function filePart(
  c: { req: { parseBody: () => Promise<Record<string, unknown>> } },
): Promise<{ bytes: Uint8Array; filename: string; mediaType: string }> {
  const body = await c.req.parseBody();
  const part = body["file"];
  if (typeof part === "string" || part === undefined || !(part instanceof File)) {
    // Deliberately the media-type error rather than a generic 400: the only way
    // to reach here is sending the field as a text value, and naming what was
    // expected is more use than "invalid request".
    throw new UnsupportedMediaType(typeof part === "string" ? "text/plain" : "none");
  }
  return {
    bytes: new Uint8Array(await part.arrayBuffer()),
    filename: part.name,
    // A browser that cannot guess sends an empty type. The service refuses it
    // rather than defaulting to octet-stream, because a stored media type is
    // what a download's Content-Type header says, and guessing there is how a
    // PDF ends up rendering as text in a client's browser.
    mediaType: part.type,
  };
}

/** Bytes out, with the headers a browser needs to save the file under its own
 *  name. `attachment` and never `inline`: this store holds files supplied by
 *  clients, and rendering one in the origin of the app would make an uploaded
 *  HTML file same-origin script. */
function bytesResponse(bytes: Uint8Array, version: DocumentVersion): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": version.mediaType,
      "content-length": String(bytes.byteLength),
      // RFC 6266, both forms. A filename in Devanagari used to make this header
      // unbuildable and the route answered 500 — see contentDispositionFor.
      "content-disposition": contentDispositionFor(version.filename),
      // The media type here was supplied by whoever uploaded the file, so the
      // browser must be told not to look past it. Without this an uploaded HTML
      // or SVG file can be sniffed into something the browser executes —
      // `attachment` already makes that hard, and this closes it.
      "x-content-type-options": "nosniff",
      etag: `"${version.contentHash}"`,
      // NOT `max-age=31536000, immutable`, which is what this said.
      //
      // The BYTES are immutable, so that was true of the bytes. It was not true
      // of the permission to read them: a document can be hidden from a client,
      // a portal grant can be revoked, a person can leave the firm — and a year
      // in a disk cache means the browser keeps answering from a copy it took
      // while the answer was still yes. `no-store` is the norm for a file whose
      // only authorisation is a cookie, and re-fetching a document is cheap
      // compared with one leaving through a cache after access was withdrawn.
      "cache-control": "private, no-store",
    },
  });
}

export function registerFileStoreRoutes(app: OpenAPIHono<AppEnv>, deps: FileStoreDeps): void {
  app.openapi(uploadRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const form = c.req.valid("form");
    const file = await filePart(c);

    const title = typeof form.title === "string" ? form.title : "";
    if (title.trim().length === 0) throw new InvalidTitle();
    const kind = typeof form.kind === "string" && isDocumentKind(form.kind) ? form.kind : "other";

    const subjectKind = typeof form.subjectKind === "string" ? form.subjectKind : undefined;
    const subjectRef = typeof form.subjectRef === "string" ? form.subjectRef : undefined;

    const record = await deps.service.store({
      tenantId: s.tenantId,
      title,
      kind,
      partyId: typeof form.partyId === "string" ? form.partyId : null,
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
      actor: s.actor,
      attachTo:
        subjectKind !== undefined && subjectRef !== undefined
          ? {
              subjectKind,
              subjectRef,
              role: typeof form.role === "string" && form.role.length > 0 ? form.role : null,
            }
          : undefined,
    });
    return c.json(toWire(record), 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const documents = await deps.service.list({
      tenantId: s.tenantId,
      partyId: q.partyId,
      kind: q.kind !== undefined && isDocumentKind(q.kind) ? q.kind : undefined,
      limit: q.limit,
    });
    return c.json({ documents: documents.map(toWire) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    return c.json(toWire(await deps.service.get(s.tenantId, documentId)), 200);
  });

  app.openapi(contentRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const { bytes, version } = await deps.service.fetchBytes({ tenantId: s.tenantId, documentId });
    return bytesResponse(bytes, version);
  });

  app.openapi(versionContentRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId, versionId } = c.req.valid("param");
    const { bytes, version } = await deps.service.fetchBytes({
      tenantId: s.tenantId,
      documentId,
      versionId,
    });
    return bytesResponse(bytes, version);
  });

  app.openapi(clientVisibilityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const { isClientVisible } = c.req.valid("json");
    const record = await deps.service.setClientVisible({
      tenantId: s.tenantId,
      documentId,
      visible: isClientVisible,
      actor: s.actor,
    });
    return c.json(toWire(record), 200);
  });

  app.openapi(versionsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const versions = await deps.service.versions(s.tenantId, documentId);
    return c.json({ versions: versions.map(versionToWire) }, 200);
  });

  app.openapi(addVersionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const file = await filePart(c);
    const version = await deps.service.addVersion({
      tenantId: s.tenantId,
      documentId,
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
      actor: s.actor,
    });
    return c.json(versionToWire(version), 201);
  });

  app.openapi(renderRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const record = await deps.service.render({
      tenantId: s.tenantId,
      kind: body.kind,
      // The subject a rendered document attaches to is the record it was
      // rendered FROM, always — there is no case where a firm wants the PDF of
      // an invoice filed against something else.
      subjectKind: body.kind,
      subjectRef: body.subjectRef,
      actor: s.actor,
    });
    return c.json(toWire(record), 201);
  });

  app.openapi(attachRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const link = await deps.service.attach({
      tenantId: s.tenantId,
      documentId,
      subjectKind: body.subjectKind,
      subjectRef: body.subjectRef,
      role: body.role ?? null,
      actor: s.actor,
    });
    return c.json(linkToWire(link), 201);
  });

  app.openapi(withdrawRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const link = await deps.service.withdraw({
      tenantId: s.tenantId,
      documentId,
      subjectKind: body.subjectKind,
      subjectRef: body.subjectRef,
      actor: s.actor,
    });
    return c.json(linkToWire({ link, subjectLabel: null }), 200);
  });

  app.openapi(linksRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { documentId } = c.req.valid("param");
    const links = await deps.service.linksOf(s.tenantId, documentId);
    return c.json({ links: links.map(linkToWire) }, 200);
  });

  app.openapi(subjectDocumentsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { subjectKind, subjectRef } = c.req.valid("param");
    const documents = await deps.service.listForSubject(s.tenantId, subjectKind, subjectRef);
    return c.json({ documents: documents.map(toWire) }, 200);
  });

  app.openapi(brandAssetsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { entityPartyId } = c.req.valid("param");
    const assets = await deps.service.brandAssets(s.tenantId, entityPartyId);
    return c.json({ assets: assets.map(brandAssetToWire) }, 200);
  });

  app.openapi(setBrandAssetRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { entityPartyId, kind } = c.req.valid("param");
    const { documentVersionId } = c.req.valid("json");
    if (!isBrandAssetKind(kind)) {
      // Unreachable through the router — the param schema is the same closed set
      // — and present because the type needs narrowing and a cast here would be
      // the kind of hole CLAUDE.md's no-`any` rule exists to prevent.
      throw new UnsupportedMediaType(kind);
    }
    const asset = await deps.service.setBrandAsset({
      tenantId: s.tenantId,
      entityPartyId,
      kind,
      documentVersionId,
      actor: s.actor,
    });
    return c.json(brandAssetToWire(asset), 200);
  });
}

export const fileStoreRoutes = {
  upload: uploadRoute,
  render: renderRoute,
  list: listRoute,
  get: getRoute,
  content: contentRoute,
  versionContent: versionContentRoute,
  versions: versionsRoute,
  addVersion: addVersionRoute,
  attach: attachRoute,
  withdraw: withdrawRoute,
  links: linksRoute,
  subjectDocuments: subjectDocumentsRoute,
  brandAssets: brandAssetsRoute,
  setBrandAsset: setBrandAssetRoute,
} as const;
