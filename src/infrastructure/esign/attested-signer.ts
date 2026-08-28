// The e-sign implementation registered today: a signature a person ATTESTS to.
//
// It is not a mock of a signing ceremony. It is how most firms in this market
// actually sign — the client signs on paper, or in a provider the firm already
// uses, and somebody at the firm records that it happened along with the
// reference. Recording that faithfully is a real product behaviour, which is
// why this adapter stores what it was told rather than pretending to have run a
// ceremony it did not run.
//
// What it CANNOT do is prove the client signed. It records an assertion by a
// member of staff, and the audit trail says exactly that: the signature method
// on the letter is `attested`, so nobody reading it later can mistake a
// colleague's word for a cryptographic signature.
//
// HONEST REGISTRY (CLAUDE.md): this is the third stub in the codebase, after the
// dev auth resolver and the logging mailer, and it gets the same treatment —
// `validateServer` refuses to boot a production-like environment with it. Adding
// a fourth without that treatment is not allowed.
import type { ESignProvider } from "../../usecase/engagement/ports";

export class AttestedSigner implements ESignProvider {
  readonly method = "attested";

  sign(input: {
    readonly tenantId: string;
    readonly letterId: string;
    readonly signedByName: string;
    readonly contentHash: string;
    readonly reference?: string | undefined;
  }): Promise<{ readonly reference: string | null }> {
    // The firm's own reference for the paper copy or the provider envelope —
    // whatever it is, it is the only thread back to the physical evidence, so
    // it is stored verbatim and never invented.
    return Promise.resolve({ reference: input.reference ?? null });
  }
}
