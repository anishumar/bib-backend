// The DocuSign fakes, in the house shape: they `implements` the real seam and
// expose plain arrays of what they were asked, so an assertion reads as a
// sentence about behaviour rather than a query against a mocking library.
//
// They live under `tests/` rather than in `src/testfakes/` because there is
// nothing above the adapter that needs them: `src/testfakes/engagement.ts` has
// a `FakeSigner` already, and it is the ESignProvider port that the use case
// wants faked. What is faked HERE is the layer below the adapter — DocuSign
// itself, at two depths. `FakeDocusignTransport` stands in for the envelope
// read, which is what the signing RULES are tested against;
// `FakeHttp` stands in for the network, which is what the JWT, the token cache
// and the error mapping are tested against.
import type {
  Http,
  HttpReply,
  HttpRequest,
} from "../../src/infrastructure/esign/docusign-http";
import type {
  DocusignEnvelope,
  DocusignTransport,
} from "../../src/infrastructure/esign/docusign-signer";
import {
  DOCUSIGN_CONTENT_HASH_FIELD,
  DOCUSIGN_LETTER_ID_FIELD,
} from "../../src/infrastructure/esign/docusign-signer";
import type { Logger } from "../../src/platform/log";

/** A logger a test can read back. The adapter's one log line is evidence — it
 *  says which envelope a contract rests on — so a test is entitled to assert
 *  what is, and is not, in it. */
export class RecordingLogger implements Logger {
  readonly lines: { level: "info" | "warn" | "error"; obj: unknown; msg?: string }[] = [];

  info(obj: unknown, msg?: string): void {
    this.lines.push({ level: "info", obj, ...(msg === undefined ? {} : { msg }) });
  }
  warn(obj: unknown, msg?: string): void {
    this.lines.push({ level: "warn", obj, ...(msg === undefined ? {} : { msg }) });
  }
  error(obj: unknown, msg?: string): void {
    this.lines.push({ level: "error", obj, ...(msg === undefined ? {} : { msg }) });
  }

  /** Everything logged, flattened, for the "no names in here" assertion. */
  text(): string {
    return JSON.stringify(this.lines);
  }
}

/** DocuSign's envelope read, without DocuSign. */
export class FakeDocusignTransport implements DocusignTransport {
  readonly asked: string[] = [];
  private readonly known = new Map<string, DocusignEnvelope>();

  /**
   * An answer computed at the moment it is asked for, which is what the
   * through-the-service test needs: the content hash an envelope must carry is
   * not known until `EngagementService.sign` has computed it, and that happens
   * one statement before this is called.
   */
  answer: ((envelopeId: string) => DocusignEnvelope | null) | null = null;

  put(envelope: DocusignEnvelope): void {
    this.known.set(envelope.id.toLowerCase(), envelope);
  }

  envelope(envelopeId: string): Promise<DocusignEnvelope | null> {
    this.asked.push(envelopeId);
    if (this.answer !== null) return Promise.resolve(this.answer(envelopeId));
    return Promise.resolve(this.known.get(envelopeId.toLowerCase()) ?? null);
  }
}

/** A completed envelope bound to a letter and its terms — the shape every
 *  refusal test starts from and then spoils in exactly one way. */
export function anEnvelope(
  overrides: {
    readonly id?: string;
    readonly status?: string;
    readonly completedAtISO?: string | null;
    readonly letterId?: string | null;
    readonly contentHash?: string | null;
    readonly recipientStatuses?: readonly string[];
  } = {},
): DocusignEnvelope {
  const fields: { name: string; value: string }[] = [];
  const letterId = overrides.letterId === undefined ? LETTER : overrides.letterId;
  const contentHash = overrides.contentHash === undefined ? HASH : overrides.contentHash;
  if (letterId !== null) fields.push({ name: DOCUSIGN_LETTER_ID_FIELD, value: letterId });
  if (contentHash !== null) {
    fields.push({ name: DOCUSIGN_CONTENT_HASH_FIELD, value: contentHash });
  }
  return {
    id: overrides.id ?? ENVELOPE,
    status: overrides.status ?? "completed",
    completedAtISO:
      overrides.completedAtISO === undefined ? "2026-07-02T11:04:00.0000000Z" : overrides.completedAtISO,
    customFields: fields,
    recipients: (overrides.recipientStatuses ?? ["completed"]).map((status) => ({
      status,
      signedAtISO: status === "completed" ? "2026-07-02T11:03:58.0000000Z" : null,
    })),
  };
}

export const ENVELOPE = "44e3e5a5-1f2e-4d0b-9d48-0b0f2c2e6a21";
export const LETTER = "00000000-0000-0000-0000-0000000000e1";
export const TENANT = "00000000-0000-0000-0000-0000000000aa";
export const HASH = "b1946ac92492d2347c6235b4d2611184f1b19a1b3b2d3e4f5061728394a5b6c7";

/**
 * The network, as a routing table.
 *
 * Routes are matched by URL substring and the most recently registered wins,
 * so a test can set up the happy path once and then override the single call it
 * is interested in. An unrouted request throws rather than returning a default,
 * because a silent 200 from a URL nobody expected is how a test comes to prove
 * the wrong thing.
 */
export class FakeHttp implements Http {
  readonly requests: HttpRequest[] = [];
  private readonly routes: { match: string; answer: (request: HttpRequest) => HttpReply }[] = [];

  on(match: string, answer: (request: HttpRequest) => HttpReply): this {
    this.routes.unshift({ match, answer });
    return this;
  }

  /** The two calls every envelope read makes first, answered plausibly. */
  withDefaults(options: { readonly accountId?: string; readonly baseUri?: string } = {}): this {
    const accountId = options.accountId ?? ACCOUNT;
    const baseUri = options.baseUri ?? "https://na4.docusign.net";
    this.on("/oauth/token", () =>
      json(200, { access_token: "a-token", token_type: "Bearer", expires_in: 3600 }),
    );
    this.on("/oauth/userinfo", () =>
      json(200, {
        sub: "a-user",
        accounts: [{ account_id: accountId, is_default: "true", base_uri: baseUri }],
      }),
    );
    return this;
  }

  send(request: HttpRequest): Promise<HttpReply> {
    this.requests.push(request);
    const route = this.routes.find((r) => request.url.includes(r.match));
    if (route === undefined) {
      throw new Error(
        `FakeHttp was asked for ${request.method} ${request.url}, which no route matches. ` +
          `Routed: ${this.routes.map((r) => r.match).join(", ")}`,
      );
    }
    return Promise.resolve(route.answer(request));
  }

  /** The URLs asked for, in order — enough to assert that a cached token was
   *  reused rather than re-minted. */
  urls(): string[] {
    return this.requests.map((r) => r.url);
  }

  countOf(match: string): number {
    return this.requests.filter((r) => r.url.includes(match)).length;
  }
}

export const ACCOUNT = "3d1f8c7a-5b2e-4c9d-8a1f-2b3c4d5e6f70";

export function json(status: number, value: unknown): HttpReply {
  return { status, body: JSON.stringify(value) };
}

/** DocuSign's own envelope JSON, as the REST API shapes it — nested custom
 *  fields, nested recipients, and its seven-decimal timestamps. The transport's
 *  parsing is the thing under test, so the fixture has to look like the wire
 *  and not like the interface. */
export function envelopeJson(
  overrides: {
    readonly envelopeId?: string;
    readonly status?: string;
    readonly textFields?: readonly { name: string; value: string }[];
    readonly listFields?: readonly { name: string; value: string }[];
    readonly signerStatuses?: readonly string[];
    readonly carbonCopies?: number;
  } = {},
): Record<string, unknown> {
  return {
    envelopeId: overrides.envelopeId ?? ENVELOPE,
    status: overrides.status ?? "completed",
    completedDateTime: "2026-07-02T11:04:00.0000000Z",
    customFields: {
      textCustomFields:
        overrides.textFields ??
        [
          { name: DOCUSIGN_LETTER_ID_FIELD, value: LETTER },
          { name: DOCUSIGN_CONTENT_HASH_FIELD, value: HASH },
        ],
      listCustomFields: overrides.listFields ?? [],
    },
    recipients: {
      signers: (overrides.signerStatuses ?? ["completed"]).map((status, i) => ({
        recipientId: String(i + 1),
        name: "Priya Menon",
        email: "priya@example.test",
        status,
        signedDateTime: "2026-07-02T11:03:58.0000000Z",
      })),
      carbonCopies: Array.from({ length: overrides.carbonCopies ?? 0 }, (_, i) => ({
        recipientId: `cc-${String(i + 1)}`,
        name: "Partner",
        email: "partner@example.test",
        status: "completed",
      })),
    },
  };
}

/**
 * The MESSAGE of a refusal, or a failure saying none arrived.
 *
 * Every refusal in this adapter is judged on what it says — the variable, the
 * bad value and the valid set — so the assertions are about a string, and
 * `rejects.toThrow` gives a matcher rather than the text. Insisting a refusal
 * happened at all is the other half: a test that quietly passed because the
 * call succeeded would be asserting nothing.
 */
export async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected this call to refuse, and it answered instead");
}
