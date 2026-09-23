// The e-sign provider asked to SEND — the half `docusign-signer.ts` said was
// "above this file" (0080).
//
// ── WHAT THIS FILE DECIDES, AND WHAT IT LEAVES TO THE TRANSPORT ──────────────
//
// The judgement is here: what an envelope for a letter contains, how the
// binding fields are stamped, where the client signs, and which of DocuSign's
// many envelope statuses end a signature request. The transport
// (`docusign-http.ts`) knows tokens, hosts and JSON, and nothing about letters.
// That split is `smtp-mailer.ts`'s, for the same reason: the rules can be read
// and tested without a socket.
//
// ── THE BINDING IS STAMPED HERE AND CHECKED THERE ────────────────────────────
//
// `DOCUSIGN_LETTER_ID_FIELD` and `DOCUSIGN_CONTENT_HASH_FIELD` are imported
// from the verifier, never re-typed: an envelope raised with a second spelling
// would be refused at signing with a message about a missing field.
import type {
  EnvelopeProgress,
  LetterDocument,
  SignatureDispatch,
  SignatureSigner,
} from "../../usecase/engagement/ports";
import { CLIENT_DATE_ANCHOR, CLIENT_SIGN_ANCHOR } from "../../domain/render/model";
import { DOCUSIGN_CONTENT_HASH_FIELD, DOCUSIGN_LETTER_ID_FIELD } from "./docusign-signer";
import type { DocusignEnvelope } from "./docusign-signer";

/** An envelope definition as this product raises one — already in DocuSign's
 *  own vocabulary, because the transport's job is to post it, not to reshape
 *  it. */
export interface DocusignEnvelopeDefinition {
  readonly emailSubject: string;
  readonly emailBlurb: string;
  readonly document: {
    readonly name: string;
    readonly base64: string;
  };
  readonly signer: SignatureSigner;
  readonly signAnchor: string;
  readonly dateAnchor: string;
  readonly customFields: readonly { readonly name: string; readonly value: string }[];
}

/** What sending needs from DocuSign, declared in this file's vocabulary for
 *  the reason `DocusignTransport` is declared beside the verifier. */
export interface DocusignSendTransport {
  /** Creates the envelope with status `sent`, so DocuSign emails the signer. */
  createEnvelope(definition: DocusignEnvelopeDefinition): Promise<{ readonly envelopeId: string }>;
  /** Envelope ids carrying this custom field value, created since `since`. */
  envelopesWithField(
    name: string,
    value: string,
    since: string,
  ): Promise<readonly { readonly envelopeId: string; readonly status: string }[]>;
  envelope(envelopeId: string): Promise<DocusignEnvelope | null>;
  voidEnvelope(envelopeId: string, reason: string): Promise<void>;
  envelopeDocument(envelopeId: string, which: "combined" | "certificate"): Promise<Uint8Array>;
}

/** DocuSign statuses that END a request, and what each means for the letter.
 *  `deleted` is a voided envelope somebody also removed from their folders. */
const ENDED: Readonly<Record<string, EnvelopeProgress["state"]>> = {
  completed: "completed",
  declined: "declined",
  voided: "voided",
  deleted: "voided",
};

/** Envelopes that can never be signed. One of these found for a letter is not
 *  the envelope to reuse — the letter needs a live one, or none. */
const DEAD = new Set(["voided", "deleted", "declined"]);

export class DocusignDispatch implements SignatureDispatch {
  /** Must equal `DocusignSigner.method`: the request row records this, and the
   *  signer that verifies what this raised records the same word on the
   *  letter. */
  readonly method = "docusign";

  constructor(private readonly transport: DocusignSendTransport) {}

  async findForLetter(letterId: string, since: string): Promise<string | null> {
    // A day's margin before the request was recorded: the lookup exists for a
    // reply lost AFTER DocuSign acted, which is seconds after the row, and
    // DocuSign's `from_date` is compared on its own clock.
    const from = new Date(new Date(since).getTime() - 24 * 3600_000).toISOString();
    const found = await this.transport.envelopesWithField(DOCUSIGN_LETTER_ID_FIELD, letterId, from);
    const live = found.find((e) => !DEAD.has(e.status.trim().toLowerCase()));
    return live === undefined ? null : live.envelopeId;
  }

  async raise(input: {
    readonly letterId: string;
    readonly ref: string;
    readonly title: string;
    readonly contentHash: string;
    readonly signer: SignatureSigner;
    readonly document: LetterDocument;
  }): Promise<{ readonly envelopeId: string }> {
    return this.transport.createEnvelope({
      // DocuSign caps the subject at 100 characters and refuses the envelope
      // over it; a long letter title is clipped rather than failing the send.
      emailSubject: clip(`Please sign: ${input.title} (${input.ref})`, 100),
      emailBlurb:
        `Please review and sign engagement letter ${input.ref}. ` +
        `If you were not expecting this, check with your contact at the firm before signing.`,
      document: { name: input.document.filename, base64: Buffer.from(input.document.bytes).toString("base64") },
      signer: input.signer,
      signAnchor: CLIENT_SIGN_ANCHOR,
      dateAnchor: CLIENT_DATE_ANCHOR,
      customFields: [
        { name: DOCUSIGN_LETTER_ID_FIELD, value: input.letterId },
        { name: DOCUSIGN_CONTENT_HASH_FIELD, value: input.contentHash },
      ],
    });
  }

  async progress(envelopeId: string): Promise<EnvelopeProgress> {
    const envelope = await this.transport.envelope(envelopeId);
    // NOT FOUND IS ITS OWN ANSWER, NEVER `voided`. It reads like "the envelope
    // is gone", and the first real run showed what acting on that costs: the
    // likeliest cause is this deployment pointed at the WRONG ACCOUNT
    // (BIB_DOCUSIGN_ACCOUNT_ID changed, a sandbox key in production), and
    // mapping it to `voided` would withdraw every letter out for signature in
    // one sweep — permanently, since `withdrawn` is terminal. `missing` lets
    // the sweep report it and move nothing, and lets a person still withdraw.
    if (envelope === null) return { state: "missing", detail: "not found" };
    const status = envelope.status.trim().toLowerCase();
    return { state: ENDED[status] ?? "out", detail: status };
  }

  async void(envelopeId: string, reason: string): Promise<void> {
    await this.transport.voidEnvelope(envelopeId, clip(reason, 200));
  }

  async signedCopies(
    envelopeId: string,
  ): Promise<{ readonly signed: LetterDocument; readonly certificate: LetterDocument }> {
    const [signed, certificate] = await Promise.all([
      this.transport.envelopeDocument(envelopeId, "combined"),
      this.transport.envelopeDocument(envelopeId, "certificate"),
    ]);
    return {
      signed: { bytes: signed, filename: `signed-${envelopeId}.pdf` },
      certificate: { bytes: certificate, filename: `certificate-of-completion-${envelopeId}.pdf` },
    };
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
