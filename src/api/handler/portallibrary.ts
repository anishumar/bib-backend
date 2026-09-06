// The client portal's LIBRARY (T6.7) — transport only.
//
// ── FOUR THINGS EVERY ROUTE HERE NEEDS, AND ONE MORE THAN T6.6 HAD ────────
//
//   · an entry in `PORTAL_PATHS` — gate 2 is denied by default
//   · an entry in `NO_PERMISSION_REQUIRED` — gate 3 is denied by default too,
//     and these four are all READS, so none of them is behind `portal:respond`.
//     Reading is authorised by the GRANT and never by a permission, which is
//     what makes `client_viewer` coherent rather than crippled: a read-only
//     contact can find last year's challan, which is the acceptance line.
//   · the query through `withPortal` — never `withTenant`
//   · a RESTRICTIVE policy on every table it touches, and on `files.document`
//     that policy was NARROWED by 0066 rather than merely relied on. This is
//     the first route in the product that LISTS documents, and until it existed
//     `crm.portal_sees(party_id)` was never asked a broad question.
//
// ── AND THE ONE THAT IS NEW: BYTES LEAVE HERE ────────────────────────────
//
// `/content` is the second route in this product that returns bytes and the
// first on the client's side. T3.6's position holds unchanged and gets stronger
// rather than weaker for being extended:
//
//   · ONE ROUTE, NO PRE-SIGNED URL. A pre-signed URL is a capability that
//     outlives the session that minted it and is checked by a storage vendor, so
//     it answers to NONE of the four gates. The version row naming the storage
//     key is read under RLS, which makes the key unreachable before it could be
//     used — and `PortalBlobStore` has no method that returns a URL. Adding one
//     is the thing not to do.
//   · `content-disposition: attachment`, NEVER `inline`, and here the reason is
//     sharper than it was for staff: this store holds files supplied by
//     CLIENTS, and rendering one inline would make an uploaded HTML file
//     same-origin script in a portal a different client is also signed into.
//
// ── A STAFF SESSION IS REFUSED RATHER THAN ANSWERED EMPTY ────────────────
//
// T6.5's rule, third time. A colleague holds no portal grants, so the library
// would read as "this client has no documents" rather than "you are looking at
// the wrong app". A wrong answer that looks right is worse than a refusal.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";
import type { PortalLibraryService } from "../../usecase/portallibrary/service";
import type { DocumentVersion } from "../../domain/filestore/model";
import { DOCUMENT_KINDS, contentDispositionFor } from "../../domain/filestore/model";
import type {
  PortalDigest,
  PortalDocumentRow,
  PortalInvoiceRow,
} from "../../domain/portallibrary/model";

export interface PortalLibraryDeps {
  readonly service: PortalLibraryService;
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Month = z.string().regex(/^\d{4}-\d{2}$/);
const DocumentParam = z.object({ documentId: z.string().uuid() });

// Money on the wire is a DECIMAL STRING and never a number — the product's rule,
// and it does not bend for a read. `z.number()` here would make the generated
// frontend client parse `"1180.0000"` into a float, which is the whole failure
// this rule exists to prevent, on the one screen a client checks arithmetic on.
const Money = z.string();

const DocumentSchema = z
  .object({
    documentId: z.string().uuid(),
    title: z.string(),
    kind: z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]).openapi({
      description:
        "What the document is. A CLOSED set — declared as an enum so a screen that switches " +
        "on it gets a compile error when a kind is added rather than a silent default.",
    }),
    companyName: z.string().openapi({
      description:
        "Which of YOUR companies it belongs to. Never null on this surface: a document with " +
        "no company is the firm's own, and you are not shown those.",
    }),
    filename: z.string(),
    byteSize: z.number().int(),
    mediaType: z.string(),
    contentHash: z.string().openapi({
      description:
        "Lower-case hex SHA-256 of the file. Here so that 'is the copy I already hold the " +
        "one you gave me' is a comparison rather than a matter of trust.",
    }),
    addedOn: z.string(),
    aboutWhat: z.string().nullable().openapi({
      description:
        "What it relates to, in words — the job it was filed against, or the invoice it " +
        "belongs to. Null is a real answer: a document may be filed against your company and " +
        "no particular job.",
    }),
  })
  .openapi("PortalDocument");

const InvoiceSchema = z
  .object({
    invoiceId: z.string().uuid(),
    number: z.string(),
    issuedBy: z.string().openapi({
      description: "Which of the firm's own companies charged you — the one printed on it.",
    }),
    billedTo: z.string(),
    status: z.enum(["issued", "cancelled"]).openapi({
      description:
        "A DRAFT invoice is not on this surface and cannot be — it is a demand nobody has " +
        "made yet. A `cancelled` one IS here, deliberately: if you hold a copy of an invoice " +
        "the firm has withdrawn, you need to be able to see that it was withdrawn.",
    }),
    currency: z.string(),
    total: Money.openapi({ description: "Net of discount, including tax. A decimal STRING." }),
    paid: Money,
    credited: Money,
    outstanding: Money.openapi({
      description:
        "total − paid − credited, derived and never stored: a `paid` flag is a cache of this " +
        "subtraction and drifts the first time a payment is corrected.",
    }),
    issuedOn: IsoDate.nullable(),
    dueOn: IsoDate.nullable().openapi({
      description:
        "The date the firm asked to be paid by — THE ONE INVENTED DATE THIS SURFACE CARRIES, " +
        "and it is here because it is already printed on the invoice you hold. Hiding it " +
        "would mean this page disagreeing with a document you have, and you cannot pay to a " +
        "date nobody will show you. Every other date in this portal is either the LAW's or " +
        "the day something opened.",
    }),
  })
  .openapi("PortalInvoice");

const DigestRowSchema = z
  .object({
    label: z.string(),
    companyName: z.string().nullable(),
    on: IsoDate,
  })
  .openapi("PortalDigestRow");

const DigestSchema = z
  .object({
    month: Month,
    filed: z.array(DigestRowSchema),
    documentsAdded: z.array(DigestRowSchema),
    invoiced: z.array(DigestRowSchema),
    asksAnswered: z.array(DigestRowSchema).openapi({
      description:
        "What YOU sent back, in that month. Here deliberately — a month that listed only the " +
        "firm's output would read as an invoice for attention rather than as an account of " +
        "the work. Dated on when you FIRST replied, so a second file sent later does not " +
        "move it.",
    }),
  })
  .openapi("PortalDigest");

const documentsRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/documents",
  tags: ["portal"],
  summary: "Your own documents",
  description:
    "CLIENT_PORTAL sessions only, and no permission — being granted a company IS the " +
    "authorisation to read that company's records, which is why a read-only contact can find " +
    "last year's challan without asking anybody. NOT WINDOWED: unlike the status home, this " +
    "reaches back as far as there are documents, because 'where is the thing you filed for me " +
    "in March' is the question it exists to answer. What appears here is what the firm marked " +
    "visible — a working paper about you is not a document of yours.",
  request: {
    query: z.object({
      kind: z
        .enum(DOCUMENT_KINDS as unknown as [string, ...string[]])
        .optional()
        .openapi({ description: "Narrow to one kind. Nothing widens the list." }),
      asOf: IsoDate.optional().openapi({
        description:
          "The day to answer for, in the CALLER's calendar — it decides which grants are in " +
          "force. Defaults to the server's own day, which is not the reader's.",
      }),
    }),
  },
  responses: {
    200: {
      description: "The library",
      content: { "application/json": { schema: z.object({ documents: z.array(DocumentSchema) }) } },
    },
    400: errorResponse("asOf is not an ISO date, or kind is not a known document kind"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
  },
});

// The bytes. `z.any()` because the body is not JSON and there is nothing for a
// schema to describe beyond its media type.
const binaryResponse = {
  description: "The document's bytes, as an attachment",
  content: { "application/octet-stream": { schema: z.any() } },
};

const contentRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/documents/{documentId}/content",
  tags: ["portal"],
  summary: "Download one of your documents",
  description:
    "The bytes of the LATEST version. Served with `content-disposition: attachment` and never " +
    "`inline` — this store also holds files clients have uploaded, and rendering one in the " +
    "app's own origin would make an uploaded HTML file same-origin script.\n\n" +
    "THERE IS NO PRE-SIGNED URL AND THERE WILL NOT BE ONE. A URL that outlives the session " +
    "that minted it is checked by a storage vendor rather than by this product, so it answers " +
    "to none of the scoping rules that decide what you may read. Every byte leaves through " +
    "this route, having passed them.",
  request: { params: DocumentParam, query: z.object({ asOf: IsoDate.optional() }) },
  responses: {
    200: binaryResponse,
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
    404: errorResponse(
      "No such document you can reach. Deliberately the same answer for a document that does " +
        "not exist, one belonging to another of the firm's clients, and one the firm has not " +
        "shared with you — the row was filtered by the database, so nothing here is in a " +
        "position to tell them apart, and a 403 would confirm it exists.",
    ),
    502: errorResponse("The document exists and its bytes could not be read from storage"),
  },
});

const invoicesRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/invoices",
  tags: ["portal"],
  summary: "Your invoices, and what is still outstanding",
  description:
    "CLIENT_PORTAL sessions only, and no permission. Drafts are not here — see the `status` " +
    "field. Amounts are decimal STRINGS, never numbers.",
  request: { query: z.object({ asOf: IsoDate.optional() }) },
  responses: {
    200: {
      description: "The invoices",
      content: { "application/json": { schema: z.object({ invoices: z.array(InvoiceSchema) }) } },
    },
    400: errorResponse("asOf is not an ISO date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
  },
});

const digestRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/digest",
  tags: ["portal"],
  summary: "One month of what the firm did for you",
  description:
    "A calendar month — filings made, documents added, invoices raised, and what you sent " +
    "back. NOT a second copy of the status home, which answers 'what is outstanding today' " +
    "over a rolling ninety days: this is bounded by a MONTH and reaches back as far as you " +
    "care to look.\n\n" +
    "IT IS A SCREEN AND NOT AN EMAIL, and that is stated rather than left to be discovered: " +
    "there is no message transport in this product yet, so nothing is sent anywhere. When " +
    "there is one, this is what it will send.",
  request: {
    query: z.object({
      month: Month.openapi({ description: "YYYY-MM. Refused rather than coerced if it is not." }),
      asOf: IsoDate.optional(),
    }),
  },
  responses: {
    200: { description: "The month", content: { "application/json": { schema: DigestSchema } } },
    400: errorResponse("month is not a YYYY-MM, or its month is not between 01 and 12"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
  },
});

export function registerPortalLibraryRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: PortalLibraryDeps,
): void {
  app.openapi(documentsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { kind, asOf } = c.req.valid("query");
    const documents = await deps.service.documents(s.tenantId, s.userId, { kind, asOf });
    return c.json({ documents: documents.map(toDocumentWire) }, 200);
  });

  app.openapi(contentRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { documentId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const { bytes, version } = await deps.service.download(s.tenantId, s.userId, documentId, asOf);
    return bytesResponse(bytes, version);
  });

  app.openapi(invoicesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { asOf } = c.req.valid("query");
    const invoices = await deps.service.invoices(s.tenantId, s.userId, asOf);
    return c.json({ invoices: invoices.map(toInvoiceWire) }, 200);
  });

  app.openapi(digestRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { month, asOf } = c.req.valid("query");
    return c.json(toDigestWire(await deps.service.digest(s.tenantId, s.userId, month, asOf)), 200);
  });
}

/** See the header: a staff session is refused rather than answered empty. A
 *  second copy of `portalask.ts`'s, deliberately — the sentence names the STAFF
 *  route that answers the same question, and those differ per surface. */
function refuseStaff(audience: string | null | undefined) {
  if (audience === "CLIENT_PORTAL") return null;
  return toEnvelope({
    status: 403,
    code: "FORBIDDEN",
    message:
      "this is the client portal's own surface and needs a client-portal session. The firm's " +
      "view of the same records is /api/v1/documents and /api/v1/invoices.",
  });
}

/**
 * Bytes out, with the headers a browser needs to save the file under its own
 * name.
 *
 * A second copy of `filestore.ts`'s and not a shared helper, for the reason that
 * file gives about its own `filePart`: this one is on the surface a CLIENT
 * reaches, and a change made for the staff route should not silently change what
 * leaves the building to somebody outside the firm.
 */
function bytesResponse(bytes: Uint8Array, version: DocumentVersion): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": version.mediaType,
      "content-length": String(bytes.byteLength),
      // `attachment` and NEVER `inline`. See the header. Both RFC 6266 forms,
      // because a challan named in Hindi is ordinary here and the old
      // single-form header could not be built for one at all.
      "content-disposition": contentDispositionFor(version.filename),
      // The media type came from whoever uploaded the file — on THIS surface,
      // possibly from the client. The browser must not look past it.
      "x-content-type-options": "nosniff",
      etag: `"${version.contentHash}"`,
      // `no-store`, not a year. The bytes never change; who may read them does.
      // A shared or disk cache holding one client's challan is the one way
      // these bytes reach the wrong browser after passing every gate correctly,
      // and a revoked portal grant must take effect on the next request rather
      // than at the end of a cache lifetime.
      "cache-control": "private, no-store",
    },
  });
}

/** Field by field. On THIS surface an accidental field is one that reached
 *  somebody outside the firm. */
function toDocumentWire(r: PortalDocumentRow): z.infer<typeof DocumentSchema> {
  return {
    documentId: r.documentId,
    title: r.title,
    kind: r.kind,
    companyName: r.companyName,
    filename: r.filename,
    byteSize: r.byteSize,
    mediaType: r.mediaType,
    contentHash: r.contentHash,
    addedOn: r.addedOn,
    aboutWhat: r.aboutWhat,
  };
}

function toInvoiceWire(r: PortalInvoiceRow): z.infer<typeof InvoiceSchema> {
  return {
    invoiceId: r.invoiceId,
    number: r.number,
    issuedBy: r.issuedBy,
    billedTo: r.billedTo,
    status: r.status,
    currency: r.currency,
    total: r.total,
    paid: r.paid,
    credited: r.credited,
    outstanding: r.outstanding,
    issuedOn: r.issuedOn,
    dueOn: r.dueOn,
  };
}

function toDigestWire(d: PortalDigest): z.infer<typeof DigestSchema> {
  const rows = (xs: PortalDigest["filed"]) =>
    xs.map((r) => ({ label: r.label, companyName: r.companyName, on: r.on }));
  return {
    month: d.month,
    filed: rows(d.filed),
    documentsAdded: rows(d.documentsAdded),
    invoiced: rows(d.invoiced),
    asksAnswered: rows(d.asksAnswered),
  };
}
