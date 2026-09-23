// The provider's signed copies, filed through the document store (0080).
//
// A closure over `FileStoreService.store` rather than a port the engagement use
// case imports, so neither use case learns the other exists — the arrangement
// every cross-module seam in `setup/` has.
//
// WHICH KIND DECIDES WHO SEES IT. The signed letter is filed as
// `engagement_letter`, which `clientVisibleByDefault` shows in the client's
// portal library — it is the client's own contract. The certificate of
// completion is `other`: the provider's audit record of who opened and signed
// it and from where, which is the firm's evidence and not a document the
// client was sent.
import { SYSTEM_ACTOR } from "../domain/ledger/model";
import type { SignedCopyFiler } from "../usecase/engagement/ports";
import type { FileStoreService } from "../usecase/filestore/service";

export function signedCopyFiler(files: FileStoreService): SignedCopyFiler {
  return {
    file: async (input) => {
      await files.store({
        tenantId: input.tenantId,
        title: input.title,
        kind: input.which === "signed" ? "engagement_letter" : "other",
        partyId: input.partyId,
        filename: input.document.filename,
        mediaType: "application/pdf",
        bytes: input.document.bytes,
        actor: SYSTEM_ACTOR,
        attachTo: {
          subjectKind: "engagement_letter",
          subjectRef: input.letterId,
          role: input.which === "signed" ? "signed" : "certificate_of_completion",
        },
      });
    },
  };
}
