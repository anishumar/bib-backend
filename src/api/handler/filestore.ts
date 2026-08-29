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

const DocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    origin: z.enum(["generated", "uploaded"]).openapi({
      description:
        "Whether the product made this file or a person supplied it. An uploaded document is " +
        "the only copy in existence; a generated one could be produced again.",
    }),
    kind: z.string(),
    partyId: z.string().uuid().nullable(),
    partyName: z.string().nullable().openapi({
      description: "The client's name, joined so a list never has to fetch one row per document.",
    }),
    createdByName: z.string().nullable().openapi({
      description: "Who uploaded it. Null means the system generated it.",
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
    subjectKind: z.string(),
    subjectRef: z.string().uuid(),
    subjectLabel: z.string().nullable().openapi({
      description:
        "What the subject is called. NULL when it does not resolve — a subject reference " +
        "carries no foreign key, so a dangling link is possible and is shown as unresolved " +
        "rather than rendered blank.",
    }),
    role: z.string().nullable(),
    createdAt: z.string(),
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
    createdByName: r.createdByName,
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

const AttachRequest = z
  .object({
    subjectKind: z.enum(SUBJECT_KINDS as unknown as [string, ...string[]]),
    subjectRef: z.string().uuid(),
    role: z.string().nullable().optional(),
  })
  .openapi("AttachDocumentRequest");

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
      "content-disposition": `attachment; filename="${version.filename.replace(/"/g, "")}"`,
      // The bytes are immutable — a version never changes — so this is safe to
      // cache hard, and the hash is a natural strong validator.
      etag: `"${version.contentHash}"`,
      "cache-control": "private, max-age=31536000, immutable",
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
  list: listRoute,
  get: getRoute,
  content: contentRoute,
  versionContent: versionContentRoute,
  versions: versionsRoute,
  addVersion: addVersionRoute,
  attach: attachRoute,
  links: linksRoute,
  subjectDocuments: subjectDocumentsRoute,
  brandAssets: brandAssetsRoute,
  setBrandAsset: setBrandAssetRoute,
} as const;
