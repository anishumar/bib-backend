// In-memory port fakes for the client portal's library (T6.7).
//
// `implements` the repository the Postgres adapter implements, which is a
// compile-time assertion that the fake and the real thing stay in step.
//
// ── WHAT THIS DOES NOT REPRODUCE, AND MUST NOT PRETEND TO ────────────────
//
// GATE 4, AND THE `is_client_visible` NARROWING WITH IT. This fake filters on
// the granted parties in TypeScript, which is the OPPOSITE of how the real
// adapter works — that one hands them to `withPortal` and lets the RESTRICTIVE
// policies do it, and its SQL never mentions `party_id` or `is_client_visible`
// at all. So a green unit test here says the SERVICE resolves and passes the
// scope, and says NOTHING about whether the wall holds.
//
// The wall is proven where it lives:
// `tests/portal/library.integration.test.ts` asks for another client's document
// BY ID against real Postgres, asks for a working paper filed against its own
// client, and drops each policy to watch the assertions go red. A unit test that
// "proved" gate 4 with a filter in a fake would be the most dangerous file in
// this repository.
import type { DocumentVersion } from "../domain/filestore/model";
import type {
  PortalDigest,
  PortalDocumentRow,
  PortalInvoiceRow,
} from "../domain/portallibrary/model";
import type {
  PortalBlobStore,
  PortalLibraryRepository,
  PortalScopeSource,
} from "../usecase/portallibrary/ports";

interface StoredDoc {
  readonly row: PortalDocumentRow;
  readonly clientPartyId: string;
  /** What 0066's narrowing decides. Held here so a test can put an INVISIBLE
   *  document in the store and assert the service never invents one — see the
   *  header for why that assertion is about the service and not the wall. */
  readonly isClientVisible: boolean;
  readonly version: DocumentVersion;
}

interface StoredInvoice {
  readonly row: PortalInvoiceRow;
  readonly clientPartyId: string;
}

/** One store behind the fake, because there is one database behind the adapter. */
export class FakeLibraryStore {
  readonly documents: StoredDoc[] = [];
  readonly invoices: StoredInvoice[] = [];

  document(input: {
    documentId: string;
    clientPartyId: string;
    title?: string;
    kind?: PortalDocumentRow["kind"];
    companyName?: string;
    filename?: string;
    storageKey?: string;
    isClientVisible?: boolean;
    addedOn?: string;
  }): this {
    const filename = input.filename ?? "challan.pdf";
    this.documents.push({
      clientPartyId: input.clientPartyId,
      isClientVisible: input.isClientVisible ?? true,
      row: {
        documentId: input.documentId,
        title: input.title ?? "GST challan",
        kind: input.kind ?? "statutory_filing",
        companyName: input.companyName ?? "Cobalt Foods Private Limited",
        filename,
        byteSize: 1024,
        mediaType: "application/pdf",
        contentHash: "a".repeat(64),
        addedOn: input.addedOn ?? "2026-03-14T09:00:00.000Z",
        aboutWhat: "GSTR-3B — Cobalt Foods — Feb 2026",
      },
      version: {
        id: `${input.documentId}-v1`,
        tenantId: "t",
        documentId: input.documentId,
        versionNo: 1,
        contentHash: "a".repeat(64),
        byteSize: 1024,
        mediaType: "application/pdf",
        filename,
        storageKey: input.storageKey ?? `blobs/${input.documentId}`,
        createdBy: null,
        createdAt: input.addedOn ?? "2026-03-14T09:00:00.000Z",
      },
    });
    return this;
  }

  invoice(input: {
    invoiceId: string;
    clientPartyId: string;
    number?: string;
    outstanding?: string;
    issuedOn?: string;
  }): this {
    this.invoices.push({
      clientPartyId: input.clientPartyId,
      row: {
        invoiceId: input.invoiceId,
        number: input.number ?? "INV/2026-27/0001",
        issuedBy: "10x Global Advisory LLP",
        billedTo: "Cobalt Foods Private Limited",
        status: "issued",
        currency: "INR",
        total: "11800.0000",
        paid: "0.0000",
        credited: "0.0000",
        outstanding: input.outstanding ?? "11800.0000",
        issuedOn: input.issuedOn ?? "2026-03-01",
        dueOn: "2026-03-31",
      },
    });
    return this;
  }
}

export class FakePortalLibraryRepo implements PortalLibraryRepository {
  constructor(private readonly store: FakeLibraryStore = new FakeLibraryStore()) {}

  documents(
    _tenantId: string,
    clientPartyIds: readonly string[],
    filter: { readonly kind?: string | undefined; readonly limit: number },
  ): Promise<readonly PortalDocumentRow[]> {
    const granted = new Set(clientPartyIds);
    return Promise.resolve(
      this.store.documents
        .filter((d) => granted.has(d.clientPartyId) && d.isClientVisible)
        .filter((d) => filter.kind === undefined || d.row.kind === filter.kind)
        .slice(0, filter.limit)
        .map((d) => d.row),
    );
  }

  findVersion(
    _tenantId: string,
    clientPartyIds: readonly string[],
    documentId: string,
  ): Promise<DocumentVersion | null> {
    const granted = new Set(clientPartyIds);
    const found = this.store.documents.find(
      (d) => d.row.documentId === documentId && granted.has(d.clientPartyId) && d.isClientVisible,
    );
    // Null for all three cases, indistinguishably — see the port's own note.
    return Promise.resolve(found?.version ?? null);
  }

  invoices(
    _tenantId: string,
    clientPartyIds: readonly string[],
  ): Promise<readonly PortalInvoiceRow[]> {
    const granted = new Set(clientPartyIds);
    return Promise.resolve(
      this.store.invoices.filter((i) => granted.has(i.clientPartyId)).map((i) => i.row),
    );
  }

  digest(
    _tenantId: string,
    clientPartyIds: readonly string[],
    range: { readonly from: string; readonly to: string },
    // Ignored, deliberately: this fake stores days as `YYYY-MM-DD` already, so
    // there is no instant for a zone to convert. The zone's whole effect is on
    // SQL, and it is proven against a real database.
    _timeZone?: string,
  ): Promise<Omit<PortalDigest, "month">> {
    const granted = new Set(clientPartyIds);
    const inRange = (day: string) => day >= range.from && day < range.to;
    return Promise.resolve({
      filed: [],
      documentsAdded: this.store.documents
        .filter((d) => granted.has(d.clientPartyId) && d.isClientVisible)
        .filter((d) => inRange(d.row.addedOn.slice(0, 10)))
        .map((d) => ({ label: d.row.title, companyName: d.row.companyName, on: d.row.addedOn.slice(0, 10) })),
      invoiced: this.store.invoices
        .filter((i) => granted.has(i.clientPartyId))
        .filter((i) => i.row.issuedOn !== null && inRange(i.row.issuedOn))
        .map((i) => ({ label: i.row.number, companyName: i.row.billedTo, on: i.row.issuedOn ?? "" })),
      asksAnswered: [],
    });
  }
}

/** The grants a portal session resolves to. Satisfies the port structurally,
 *  the same way `PortalAccessService` does in `setup/`. */
export class FakeLibraryScope implements PortalScopeSource {
  private readonly byUser = new Map<string, { clientPartyId: string; clientName: string }[]>();

  grant(userId: string, clientPartyId: string, clientName = "Cobalt Foods Private Limited"): this {
    const held = this.byUser.get(userId) ?? [];
    held.push({ clientPartyId, clientName });
    this.byUser.set(userId, held);
    return this;
  }

  scopedCompanies(
    _tenantId: string,
    userId: string,
  ): Promise<readonly { readonly clientPartyId: string; readonly clientName: string }[]> {
    return Promise.resolve(this.byUser.get(userId) ?? []);
  }
}

/** Bytes by key. Deliberately answers null for a key it has never been given,
 *  which is what `BytesMissing` exists for: the row says there is a file and the
 *  disk does not have it. */
export class FakeLibraryBlobs implements PortalBlobStore {
  private readonly bytes = new Map<string, Uint8Array>();

  put(storageKey: string, bytes: Uint8Array): this {
    this.bytes.set(storageKey, bytes);
    return this;
  }

  get(input: { readonly storageKey: string }): Promise<Uint8Array | null> {
    return Promise.resolve(this.bytes.get(input.storageKey) ?? null);
  }
}
