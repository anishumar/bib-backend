// The proposal by email (0085): its PDF through the document store, and the two
// addresses its letters link to.
//
// Closures over `FileStoreService` rather than a port the proposal use case
// imports, so neither use case learns the other exists — the arrangement
// `signed-copies.ts` has, and every cross-module seam in `setup/`.
//
// THE PDF IS A DOCUMENT LIKE ANY RENDER. `render` files it on the proposal with
// role `rendered` — the same filing `POST /documents/render` does — so the PDF
// of record is the one on the proposal's own page, with its content hash, and
// not a second copy somewhere only the email knows about. A proposal is not
// client-visible by default (`clientVisibleByDefault`), so filing it puts
// nothing in the client's portal library.
import type { FileStoreService } from "../usecase/filestore/service";
import type { ProposalLinks, ProposalPdfs } from "../usecase/proposal/ports";

export function proposalPdfs(files: FileStoreService): ProposalPdfs {
  return {
    file: async (tenantId, proposalId, actor) => {
      const record = await files.render({
        tenantId,
        kind: "proposal",
        subjectKind: "proposal",
        subjectRef: proposalId,
        actor,
      });
      return {
        documentId: record.document.id,
        versionId: record.latestVersion.id,
        contentHash: record.latestVersion.contentHash,
        filename: record.latestVersion.filename,
      };
    },
    bytes: async (tenantId, pdf) => {
      const fetched = await files.fetchBytes({
        tenantId,
        documentId: pdf.documentId,
        versionId: pdf.versionId,
      });
      return fetched.bytes;
    },
  };
}

/**
 * The web app's pages, from the deployment's own origin — the base the
 * sign-in letters already link from (`BIB_APP_BASE_URL`). The token is
 * percent-encoded like theirs; its characters are URL-safe today, and the
 * encoding is what keeps that from being an assumption.
 */
export function proposalLinks(appBaseUrl: string): ProposalLinks {
  const base = appBaseUrl.replace(/\/+$/, "");
  return {
    shareUrl: (token) => `${base}/p/${encodeURIComponent(token)}`,
    staffUrl: (proposalId) => `${base}/proposals/${encodeURIComponent(proposalId)}`,
  };
}
