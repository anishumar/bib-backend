// An invoice's issued copy (2026-09-29): its PDF through the document store,
// filed as Issue writes the status.
//
// A closure over `FileStoreService`, as `proposal-delivery.ts` is, so the
// invoice use case never learns the document store exists. The store decides
// what the file IS: an issued invoice's first copy is its copy of record, and
// the store refuses a second (`hasCopyOfRecord`).
import type { Logger } from "../platform/log";
import type { FileStoreService } from "../usecase/filestore/service";
import type { IssuedCopies } from "../usecase/invoice/ports";

export function invoiceIssuedCopies(files: FileStoreService, log: Logger): IssuedCopies {
  return {
    file: async (tenantId, invoiceId, actor) => {
      try {
        await files.render({
          tenantId,
          kind: "invoice",
          subjectKind: "invoice",
          subjectRef: invoiceId,
          actor,
        });
      } catch (err) {
        // The invoice IS issued; its paper is not. Nothing is undone for it:
        // the page offers "Make the issued copy", which answers with the
        // renderer's own sentence (a character it cannot draw, say).
        log.warn(
          { tenantId, invoiceId, error: err instanceof Error ? err.message : String(err) },
          "issued invoice was not filed as a PDF",
        );
      }
    },
  };
}
