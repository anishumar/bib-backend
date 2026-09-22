// The e-sign provider that CHECKS a signature rather than asking for one.
//
// ── THE PROBLEM THIS FILE EXISTS TO SOLVE, STATED BEFORE THE CODE ────────────
//
// `ESignProvider.sign` is synchronous: it is called, it answers, and the very
// next statements in `EngagementService.sign` write the letter to `signed`,
// fan it out into engagements and record `engagement_letter.signed`. DocuSign
// is not synchronous and cannot be made so. An envelope is created, sent, and
// then a human being signs it — minutes later, or on Monday, or never. Neither
// embedded signing nor in-person signing changes that: a recipient view is a
// URL that lives five minutes and is consumed in a browser this server is not
// watching, and DocuSign's own guidance is to learn of completion from Connect
// rather than from the redirect the signer's browser happens to follow.
//
// So an adapter whose `sign()` CREATES an envelope has only one thing it could
// return: the id of a document nobody has signed yet. The caller would then
// record the letter as signed, create billable engagements against it, and emit
// the activation event — and `signed` is terminal, in the domain
// (`canTransition` refuses to leave it) and in Postgres (migration 0019's
// freeze trigger permits three columns to move afterwards and nothing else).
// The mistake would be permanent and would look exactly like a real contract.
// `usecase/engagement/ports.ts` forbids it in one sentence — "a letter must
// never be recorded as signed because a provider call failed quietly" — and a
// letter recorded as signed because an envelope was merely SENT is the same
// error with a worse alibi.
//
// ── WHAT THIS ADAPTER DOES INSTEAD ───────────────────────────────────────────
//
// It reads `reference` as the id of an envelope that is ALREADY FINISHED, and
// it verifies four things against DocuSign before it will hand a reference
// back:
//
//   1. The envelope exists in the account this deployment is authorised for.
//   2. Its status is `completed` — everybody DocuSign was asked to route it to
//      has signed. Any other status is refused, by name.
//   3. Its `bib_content_hash` custom field equals the hash the use case
//      computed over the canonical terms a moment ago. This is the binding: it
//      is what makes "signed" mean "signed THESE words" rather than "signed
//      something".
//   4. Its `bib_letter_id` custom field names this letter, so one letter's
//      envelope cannot be pasted into another letter's form.
//
// By the time `sign()` is called there is nothing left to wait for, which is
// why a synchronous port is honest here. And what it returns is strictly
// stronger than what `attested` returns: not a colleague's word that a client
// signed, but DocuSign's own record that they did, tied to these exact terms.
//
// ── WHAT IT DELIBERATELY DOES NOT DO: SEND ───────────────────────────────────
//
// Nothing in this codebase creates a DocuSign envelope yet, and creating one
// cannot live behind this port. An envelope must be raised when the terms
// freeze — at `send()`, since `isEditable` is draft-only — and that needs a use
// case that can reach the rendered PDF and the client's email address, neither
// of which `EngagementService` has. It needs somewhere for the letter to sit
// while it is out, which the four-state machine has no room for. And it needs
// somewhere for completion to arrive, which means a Connect receiver and a
// sixth public path. All of that is above this file. What this file can do is
// own the two custom-field NAMES the binding depends on, exported below, so the
// send path and the check agree by importing the same constants rather than by
// two people typing the same string.
import { SignatureIncomplete } from "../../domain/engagement/errors";
import type { Logger } from "../../platform/log";
import type { ESignProvider } from "../../usecase/engagement/ports";

/**
 * THE BINDING, as two field names.
 *
 * DocuSign envelope custom fields are the only part of an envelope that
 * survives the round trip unaltered and is readable without downloading the
 * document: they are set at creation and returned verbatim by the envelope
 * read. Anything else that could carry the hash — the email subject, the
 * document name, a tab — is either editable by the sender afterwards or
 * requires pulling the PDF back and re-hashing bytes this product never hashed
 * in the first place (`contentHash` is a digest of the canonical TERMS, not of
 * the rendering).
 *
 * Whoever builds the send path imports these. A second spelling of
 * `bib_content_hash` anywhere would produce envelopes this adapter refuses,
 * with a message about a missing field and no clue that it is a typo.
 */
export const DOCUSIGN_LETTER_ID_FIELD = "bib_letter_id";
export const DOCUSIGN_CONTENT_HASH_FIELD = "bib_content_hash";

/** One envelope custom field, name and value, as DocuSign returns it. */
export interface DocusignCustomField {
  readonly name: string;
  readonly value: string;
}

/**
 * One recipient's progress, and NOTHING that identifies them.
 *
 * The name and the email address stay inside the transport. Nothing above this
 * line needs them — the signatory's name reaches the letter from the form, not
 * from DocuSign — and the engagement use case goes out of its way to keep names
 * out of the event log because that log cannot be erased. Carrying them across
 * this seam would only create a second place they could end up.
 */
export interface DocusignRecipient {
  readonly status: string;
  readonly signedAtISO: string | null;
}

/** An envelope, reduced to what a signature check actually asks of it. */
export interface DocusignEnvelope {
  /** DocuSign's own spelling of the id, which is what gets stored — never the
   *  caller's, which may differ in case. */
  readonly id: string;
  readonly status: string;
  readonly completedAtISO: string | null;
  readonly customFields: readonly DocusignCustomField[];
  readonly recipients: readonly DocusignRecipient[];
}

/**
 * The one thing this adapter needs from DocuSign.
 *
 * Declared HERE, in this file's vocabulary, for the reason `smtp-mailer.ts`
 * gives for `MailTransport`: the file with the judgement in it should have no
 * vendor in it. `docusign-http.ts` is the only file in the product that knows
 * what an integration key or a JWT assertion is, and the rules below can be
 * read and tested without a socket, a token, or a mock of somebody else's API.
 */
export interface DocusignTransport {
  /** The envelope, or null when the account this deployment is authorised for
   *  holds no such envelope. Null rather than a throw because "no such
   *  envelope" is an answer a person typed, not a fault — the same reason the
   *  repositories return null from their finders. */
  envelope(envelopeId: string): Promise<DocusignEnvelope | null>;
}

/**
 * A DocuSign envelope id is a GUID, and checking that here buys a better
 * failure than DocuSign's.
 *
 * The field this arrives in is a free-text box a person types into, and the
 * example the signature screen shows today is "paper-001". Handing that to
 * DocuSign earns a 400 about a malformed request, which surfaces as a 500 with
 * nothing in it for the person who typed. Refusing it before the call lets the
 * message say what the field now means and what one looks like.
 */
const ENVELOPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DocuSign's envelope lifecycle, said in terms a firm can act on. `completed`
 *  is absent on purpose: it is the only value that is not a refusal. */
const NOT_SIGNED_YET: Readonly<Record<string, string>> = {
  created: "the envelope was drafted and never sent, so the client has not seen it",
  sent: "the envelope is out and the client has not opened it yet",
  delivered: "the client has opened the envelope and has not finished signing",
  signed: "some recipients have signed and the envelope has not finished routing",
  declined: "a recipient REFUSED to sign, and the letter must not be recorded as signed",
  voided: "the envelope was cancelled, and a cancelled envelope is not a contract",
  deleted: "the envelope was deleted, so there is no evidence left to stand behind",
};

/** Which recipient states mean that person actually signed. DocuSign reports a
 *  signer as `completed`; `signed` appears on some routing configurations and
 *  means the same thing from this side. */
const RECIPIENT_DONE = new Set(["completed", "signed"]);

export class DocusignSigner implements ESignProvider {
  /** Recorded on the letter as `signature_method`, and it is the whole point of
   *  the field: a reader years later can tell a DocuSign envelope from a
   *  colleague's attestation without asking anybody. */
  readonly method = "docusign";

  constructor(
    private readonly transport: DocusignTransport,
    private readonly log: Logger,
  ) {}

  async sign(input: {
    readonly tenantId: string;
    readonly letterId: string;
    readonly signedByName: string;
    readonly contentHash: string;
    readonly reference?: string | undefined;
  }): Promise<{ readonly reference: string | null }> {
    const typed = (input.reference ?? "").trim();
    if (typed === "") {
      throw new SignatureIncomplete(
        `a DocuSign envelope id in "reference", and this one is empty. With ` +
          `BIB_ESIGN_PROVIDER=docusign the reference is not a note — it is the envelope this ` +
          `firm sent for signature, and it is what gets checked. Valid: a 36-character ` +
          `envelope id such as 44e3e5a5-1f2e-4d0b-9d48-0b0f2c2e6a21, copied from the envelope ` +
          `in DocuSign Manage or from its URL`,
      );
    }
    if (!ENVELOPE_ID.test(typed)) {
      throw new SignatureIncomplete(
        `a DocuSign envelope id in "reference", and ${JSON.stringify(typed)} is not one. With ` +
          `BIB_ESIGN_PROVIDER=docusign the reference must be a 36-character envelope id such ` +
          `as 44e3e5a5-1f2e-4d0b-9d48-0b0f2c2e6a21 — eight, four, four, four then twelve ` +
          `hexadecimal characters separated by hyphens`,
      );
    }

    const envelope = await this.transport.envelope(typed);
    if (envelope === null) {
      throw new SignatureIncomplete(
        `an envelope this firm can actually see, and DocuSign holds no envelope ` +
          `${JSON.stringify(typed)} in the account this server signs in to. Either the id is ` +
          `mistyped, or the envelope was raised in a different DocuSign account from the one ` +
          `BIB_DOCUSIGN_ACCOUNT_ID names`,
      );
    }

    // THE STATUS GATE, and the reason this adapter exists in this shape. Every
    // value other than `completed` describes a letter that is not signed, and
    // three of them — declined, voided, deleted — describe one that never will
    // be. Recording any of them as a signature would be a false contract that
    // cannot be undone.
    const status = envelope.status.trim().toLowerCase();
    if (status !== "completed") {
      const explanation =
        NOT_SIGNED_YET[status] ?? "DocuSign reports a status this server does not recognise";
      throw new SignatureIncomplete(
        `a COMPLETED DocuSign envelope, and envelope ${envelope.id} is ` +
          `${JSON.stringify(envelope.status)}: ${explanation}. Valid: completed. Nothing is ` +
          `recorded until DocuSign says every recipient has signed`,
      );
    }

    // THE BINDING. `contentHash` was computed over the canonical terms seconds
    // ago, in the caller, precisely so that what the provider vouched for and
    // what gets stored are the same bytes. An envelope that does not carry it
    // proves somebody signed SOMETHING; that is not what a letter records.
    //
    // Compared case-insensitively after trimming because the value makes a
    // round trip through a vendor's storage and a hex digest that came back
    // upper-cased is the same digest. The comparison is not a secret check —
    // there is nothing here for a timing attacker to learn — so a plain string
    // compare is the honest instrument.
    const stamped = field(envelope.customFields, DOCUSIGN_CONTENT_HASH_FIELD);
    if (stamped === null) {
      throw new SignatureIncomplete(
        `an envelope bound to these terms, and envelope ${envelope.id} carries no ` +
          `${DOCUSIGN_CONTENT_HASH_FIELD} custom field. Envelopes raised by this product stamp ` +
          `the hash of the letter's terms onto the envelope when they create it; one raised by ` +
          `hand in the DocuSign web app does not, and cannot be checked against this letter`,
      );
    }
    if (stamped.toLowerCase() !== input.contentHash.trim().toLowerCase()) {
      throw new SignatureIncomplete(
        `an envelope bound to THESE terms. Envelope ${envelope.id} was raised over content ` +
          `hash ${JSON.stringify(stamped)} and this letter's terms hash to ` +
          `${JSON.stringify(input.contentHash)}. The client signed a different document — ` +
          `raise a fresh envelope from the letter as it now reads`,
      );
    }

    // THE SECOND HALF OF THE BINDING, and the cheaper mistake to make: the
    // right client, the right firm, the right month, and the wrong letter.
    // Whoever copies an id out of DocuSign Manage is reading a list of subject
    // lines, and a firm that sends the same services to the same client twice
    // has two of them that read alike. The hash would catch it only if the
    // terms differed; the letter id catches it either way, which is why it is
    // required rather than checked when present.
    const letterId = field(envelope.customFields, DOCUSIGN_LETTER_ID_FIELD);
    if (letterId === null) {
      throw new SignatureIncomplete(
        `an envelope that names the letter it was raised for, and envelope ${envelope.id} ` +
          `carries no ${DOCUSIGN_LETTER_ID_FIELD} custom field. The send path stamps both ` +
          `fields together, so an envelope carrying one and not the other did not come from ` +
          `this product and cannot be attributed to a letter`,
      );
    }
    if (letterId !== input.letterId) {
      throw new SignatureIncomplete(
        `the envelope raised for THIS letter. Envelope ${envelope.id} belongs to letter ` +
          `${JSON.stringify(letterId)} and this is letter ${JSON.stringify(input.letterId)}. ` +
          `Find the envelope raised for this letter, or raise one`,
      );
    }

    // A completed envelope with no completed recipient should not exist. It is
    // checked anyway because the cost of being wrong is a permanent false
    // contract, and because an envelope with every recipient set to receive a
    // copy and nobody set to sign is a real configuration mistake that DocuSign
    // will happily complete.
    if (!envelope.recipients.some((r) => RECIPIENT_DONE.has(r.status.trim().toLowerCase()))) {
      throw new SignatureIncomplete(
        `at least one recipient who signed, and DocuSign reports envelope ${envelope.id} as ` +
          `completed with none. An envelope whose recipients were all copied rather than asked ` +
          `to sign completes without a signature on it`,
      );
    }

    // The one line worth having in an operator's log. A signature is the moment
    // a firm becomes contractually bound, and this says which envelope the
    // binding rests on and when DocuSign says it finished — the thread back to
    // the evidence if the letter is ever disputed. No name and no email
    // address: the letter itself is where the signatory is recorded, and that
    // row can be erased where a log line cannot.
    this.log.info(
      {
        tenantId: input.tenantId,
        letterId: input.letterId,
        envelopeId: envelope.id,
        completedAt: envelope.completedAtISO,
      },
      "docusign envelope verified as completed and bound to this letter's terms",
    );

    // DocuSign's spelling of the id, not the caller's. What is stored is what
    // the vendor will answer to when somebody looks it up in five years.
    return { reference: envelope.id };
  }
}

/** A custom field by name, case-insensitively — DocuSign preserves the case it
 *  was given, and one day somebody will create an envelope with a capital B. */
function field(fields: readonly DocusignCustomField[], name: string): string | null {
  const found = fields.find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
  if (found === undefined) return null;
  const value = found.value.trim();
  return value === "" ? null : value;
}
