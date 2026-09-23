// The only file in this product that knows what DocuSign is.
//
// ── WHY THERE IS NO VENDOR SDK HERE ──────────────────────────────────────────
//
// `docusign-esign` is a generated client: a second HTTP stack, a second
// configuration object and a callback-era API surface, dragged in for four
// endpoints — a token, a userinfo, an envelope read, and one day an envelope
// create. `nodemailer-transport.ts` makes the same argument for SMTP and it is
// the same argument here: the integration is small enough that the SDK would
// buy nothing except a rewrite the first time it went a major version. Node 22
// has `fetch`, and `node:crypto` signs RS256 — which is the whole of JWT Grant.
//
// ── WHY JWT GRANT AND NOT AUTHORIZATION CODE ─────────────────────────────────
//
// Nobody is at a keyboard. This runs on the server, in a request a member of
// the firm started, and it needs to read an envelope in the firm's DocuSign
// account without a human consenting each time. JWT Grant is exactly that: a
// self-signed assertion impersonating one named user, exchanged for a token
// that lives an hour. The price is a one-off act of administration that no
// amount of code can replace — an administrator must grant consent to the
// integration key for `signature impersonation` ONCE, and until they do, every
// token request answers `consent_required`. That failure is mapped below into
// the only message that helps: the URL to open.
//
// ── WHAT IS DISCOVERED RATHER THAN CONFIGURED ────────────────────────────────
//
// The REST base URI. DocuSign accounts live in different regions on different
// hostnames, and the account's own is returned by `/oauth/userinfo` alongside
// its id. Configuring it would mean a variable that is wrong in a way nothing
// detects until an envelope read 404s. Discovery is rate limited per hour per
// user, so the answer is cached for the life of the process — it cannot change
// under a running server, because the account an integration key is consented
// for is not something that moves.
import { createPrivateKey, createSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Clock } from "../../platform/clock";
import { systemClock } from "../../platform/clock";
import type { Logger } from "../../platform/log";
// Every fault on the way to DocuSign is one named kind, so the API answers 502
// with the provider's own words instead of 500 "internal error". Imports point
// inward: infrastructure may name a domain error, and this is why.
import { SignerUnavailable } from "../../domain/engagement/errors";
import type {
  DocusignCustomField,
  DocusignEnvelope,
  DocusignRecipient,
  DocusignTransport,
} from "./docusign-signer";
import type { DocusignEnvelopeDefinition, DocusignSendTransport } from "./docusign-dispatch";

/** What this adapter needs to reach DocuSign. Mirrors `DocusignConfig` in
 *  `config/config.ts` and is declared HERE on purpose: an adapter never imports
 *  the config module — `setup/` maps one to the other, the way it already does
 *  for the SMTP relay and the blob store's root path. */
export interface DocusignConnection {
  /** `https://account.docusign.com` in production; `https://account-d.docusign.com`
   *  is the developer sandbox. It is NOT the REST host — that is discovered. */
  readonly oauthBase: string;
  /** The integration key (DocuSign also calls it the client id), which is the
   *  JWT's `iss`. */
  readonly integrationKey: string;
  /** The API user the server impersonates, as a GUID. An email address here is
   *  the single most common JWT Grant mistake and DocuSign rejects it with a
   *  message that does not say so. */
  readonly userId: string;
  /** Which of the impersonated user's accounts to work in. Null means "the
   *  one DocuSign marks as their default", which is right for the common case
   *  of a user in exactly one account. */
  readonly accountId: string | null;
  /** The RSA private key whose public half is registered on the integration
   *  key, in PEM. */
  readonly privateKeyPem: string;
}

// ── The HTTP seam ────────────────────────────────────────────────────────────
//
// Narrow on purpose, and in this file's own vocabulary rather than `fetch`'s.
// A test can then drive every branch below — a token that expires, a consent
// refusal, a 404 envelope, a malformed body — with an object rather than a
// socket, and the branches are where all the judgement in this file lives.

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  /** Read the reply as BYTES — a PDF decoded as text is a PDF destroyed. */
  readonly binary?: boolean | undefined;
}

export interface HttpReply {
  readonly status: number;
  /** The reply as text. For a binary request, the bytes decoded as UTF-8 —
   *  only meaningful for an error body, which DocuSign sends as JSON. */
  readonly body: string;
  /** The raw bytes, present when the request asked for `binary`. */
  readonly bytes?: Uint8Array | undefined;
}

export interface Http {
  send(request: HttpRequest): Promise<HttpReply>;
}

/**
 * The real one, over node's global fetch.
 *
 * The timeout is not optional politeness. This runs inside a request a member
 * of the firm is waiting on, and `fetch` with no signal waits as long as the
 * other end cares to — a DocuSign region having a bad afternoon would hold a
 * connection, a worker thread and a database transaction's worth of attention
 * open indefinitely. Twenty seconds is long enough for a token round trip on a
 * bad link and short enough to give the person a real answer.
 */
export class GlobalFetchHttp implements Http {
  constructor(private readonly timeoutMs: number = 20_000) {}

  async send(request: HttpRequest): Promise<HttpReply> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      // Absent rather than undefined: `exactOptionalPropertyTypes` means the
      // key must not be present at all on a GET, and fetch is entitled to
      // object to a body it was handed on one.
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (request.binary === true) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, body: new TextDecoder().decode(bytes), bytes };
    }
    return { status: response.status, body: await response.text() };
  }
}

/** How early a token is treated as expired. DocuSign tokens live an hour; a
 *  minute of margin covers the clock drift between this host and theirs and
 *  the flight time of the request the token is about to be used on. */
const EXPIRY_MARGIN_MS = 60_000;

/** The assertion's own life. One hour is DocuSign's maximum and there is no
 *  reason to ask for less: it is minted fresh for every token exchange and
 *  never stored. */
const ASSERTION_LIFETIME_SECONDS = 3600;

/** Reading envelopes needs `signature`; doing it as somebody else needs
 *  `impersonation`. Both must be consented to, together, or the token call
 *  fails in a way that names neither. */
const SCOPE = "signature impersonation";

export class JwtGrantDocusign implements DocusignTransport, DocusignSendTransport {
  private readonly key: KeyObject;

  /** The token and when to stop believing in it. */
  private token: { readonly value: string; readonly expiresAtMs: number } | null = null;

  /** THE STAMPEDE GUARD. Several requests can reach an expired token in the
   *  same millisecond, and each would mint an assertion and post it. DocuSign
   *  rate limits the token endpoint, so the second through the tenth of those
   *  are not merely wasteful — they are how a busy minute turns into an outage.
   *  One in-flight promise, shared. */
  private minting: Promise<string> | null = null;

  private account: { readonly accountId: string; readonly baseUri: string } | null = null;
  private discovering: Promise<{ accountId: string; baseUri: string }> | null = null;

  constructor(
    private readonly connection: DocusignConnection,
    private readonly http: Http,
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {
    this.key = readPrivateKey(connection.privateKeyPem);
  }

  async envelope(envelopeId: string): Promise<DocusignEnvelope | null> {
    const account = await this.accountOf();
    const url =
      `${account.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(account.accountId)}` +
      `/envelopes/${encodeURIComponent(envelopeId)}?include=recipients,custom_fields`;

    const reply = await this.authorized({ method: "GET", url });
    // 404 is an ANSWER, not a fault: the id was typed by a person and it names
    // nothing in this account. `DocusignSigner` turns that into a refusal that
    // says so; a throw here would surface as a 500 and tell them nothing.
    if (reply.status === 404) return null;
    if (reply.status !== 200) {
      throw new SignerUnavailable(
        `DocuSign refused to read envelope ${envelopeId} in account ${account.accountId}: ` +
          `HTTP ${reply.status}. ${detail(reply.body)} Check that BIB_DOCUSIGN_ACCOUNT_ID names ` +
          `the account the envelope was raised in, and that the user named by ` +
          `BIB_DOCUSIGN_USER_ID has access to it.`,
      );
    }

    return readEnvelope(parseJson(reply.body, `the envelope ${envelopeId} read`), envelopeId);
  }

  // ── Sending (0080) ─────────────────────────────────────────────────────────

  async createEnvelope(
    definition: DocusignEnvelopeDefinition,
  ): Promise<{ readonly envelopeId: string }> {
    const account = await this.accountOf();
    const body = {
      emailSubject: definition.emailSubject,
      emailBlurb: definition.emailBlurb,
      // `sent`, not `created`: a created envelope is a draft in somebody's
      // DocuSign folder that the client never hears about.
      status: "sent",
      documents: [
        {
          documentId: "1",
          name: definition.document.name,
          fileExtension: "pdf",
          documentBase64: definition.document.base64,
        },
      ],
      recipients: {
        signers: [
          {
            recipientId: "1",
            routingOrder: "1",
            name: definition.signer.name,
            email: definition.signer.email,
            tabs: {
              // `anchorIgnoreIfNotPresent: false` makes DocuSign REFUSE an
              // envelope whose document has no anchor, rather than send one the
              // client has nowhere to sign on.
              signHereTabs: [anchorTab(definition.signAnchor, "-14")],
              dateSignedTabs: [anchorTab(definition.dateAnchor, "-2")],
            },
          },
        ],
      },
      customFields: {
        textCustomFields: definition.customFields.map((f) => ({
          name: f.name,
          value: f.value,
          show: "false",
          required: "false",
        })),
      },
    };
    const reply = await this.authorized({
      method: "POST",
      url: `${this.accountUrl(account)}/envelopes`,
      body: JSON.stringify(body),
    });
    if (reply.status !== 201 && reply.status !== 200) {
      throw new SignerUnavailable(
        `DocuSign refused to create the envelope for ${definition.signer.email}: HTTP ` +
          `${reply.status}. ${detail(reply.body)}`,
      );
    }
    const payload = record(parseJson(reply.body, "the envelope create"));
    const envelopeId = payload === null ? null : text(payload["envelopeId"]);
    if (envelopeId === null) {
      throw new SignerUnavailable(
        `DocuSign answered the envelope create with HTTP ${reply.status} and no envelopeId. ` +
          `Body: ${clip(reply.body)}`,
      );
    }
    return { envelopeId };
  }

  async envelopesWithField(
    name: string,
    value: string,
    since: string,
  ): Promise<readonly { readonly envelopeId: string; readonly status: string }[]> {
    const account = await this.accountOf();
    // DocuSign requires `from_date` on every status search, and matches a
    // custom field given as `name=value` in one parameter.
    const query = new URLSearchParams({
      from_date: since,
      custom_field: `${name}=${value}`,
    }).toString();
    const reply = await this.authorized({
      method: "GET",
      url: `${this.accountUrl(account)}/envelopes?${query}`,
    });
    if (reply.status !== 200) {
      throw new SignerUnavailable(
        `DocuSign refused to search for envelopes carrying ${name}=${value}: HTTP ` +
          `${reply.status}. ${detail(reply.body)}`,
      );
    }
    const payload = record(parseJson(reply.body, "the envelope search"));
    return (payload === null ? [] : list(payload["envelopes"])).flatMap((raw) => {
      const envelope = record(raw);
      if (envelope === null) return [];
      const envelopeId = text(envelope["envelopeId"]);
      const status = text(envelope["status"]);
      return envelopeId === null || status === null ? [] : [{ envelopeId, status }];
    });
  }

  async envelopeDocument(
    envelopeId: string,
    which: "combined" | "certificate",
  ): Promise<Uint8Array> {
    const account = await this.accountOf();
    // `combined` WITHOUT the certificate: the signed letter as the client holds
    // it. The certificate is fetched on its own so the two can be filed with
    // different visibility — the client's copy, and the firm's audit record.
    const path = which === "combined" ? "combined?certificate=false" : "certificate";
    const reply = await this.authorized({
      method: "GET",
      url: `${this.accountUrl(account)}/envelopes/${encodeURIComponent(envelopeId)}/documents/${path}`,
      binary: true,
    });
    if (reply.status !== 200 || reply.bytes === undefined || reply.bytes.byteLength === 0) {
      throw new SignerUnavailable(
        `DocuSign would not hand over the ${which === "combined" ? "signed letter" : "certificate of completion"} ` +
          `for envelope ${envelopeId}: HTTP ${reply.status}. ${detail(reply.body)}`,
      );
    }
    return reply.bytes;
  }

  async voidEnvelope(envelopeId: string, reason: string): Promise<void> {
    const account = await this.accountOf();
    const reply = await this.authorized({
      method: "PUT",
      url: `${this.accountUrl(account)}/envelopes/${encodeURIComponent(envelopeId)}`,
      body: JSON.stringify({ status: "voided", voidedReason: reason }),
    });
    if (reply.status !== 200) {
      throw new SignerUnavailable(
        `DocuSign refused to void envelope ${envelopeId}, so the client could still sign it: ` +
          `HTTP ${reply.status}. ${detail(reply.body)} Nothing was withdrawn.`,
      );
    }
  }

  private accountUrl(account: { accountId: string; baseUri: string }): string {
    return `${account.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(account.accountId)}`;
  }

  // ── The token ──────────────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached !== null && this.clock.now().getTime() < cached.expiresAtMs) return cached.value;
    if (this.minting !== null) return this.minting;

    const minting = this.mintToken();
    this.minting = minting;
    try {
      return await minting;
    } finally {
      this.minting = null;
    }
  }

  private async mintToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: this.assertion(),
    }).toString();

    const reply = await this.http.send({
      method: "POST",
      url: `${trimSlash(this.connection.oauthBase)}/oauth/token`,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });

    if (reply.status !== 200) throw this.tokenRefusal(reply);

    const payload = record(parseJson(reply.body, "the DocuSign token response"));
    const value = payload === null ? null : text(payload["access_token"]);
    if (value === null) {
      throw new SignerUnavailable(
        `DocuSign returned HTTP 200 from /oauth/token with no access_token in it. Body: ` +
          `${clip(reply.body)}`,
      );
    }
    // `expires_in` is seconds and DocuSign has always sent 3600. It is read
    // rather than assumed, and falls back to the assertion's own lifetime if it
    // is missing, so a shorter token would be honoured rather than used past
    // its life.
    const lifetimeSeconds =
      payload !== null && typeof payload["expires_in"] === "number" && payload["expires_in"] > 0
        ? payload["expires_in"]
        : ASSERTION_LIFETIME_SECONDS;

    this.token = {
      value,
      expiresAtMs: this.clock.now().getTime() + lifetimeSeconds * 1000 - EXPIRY_MARGIN_MS,
    };
    return value;
  }

  /**
   * The assertion, signed here rather than by a library.
   *
   * A JWT is three base64url segments and the third is an RS256 signature over
   * the first two. `node:crypto` does that in four lines, and a JWT dependency
   * would exist to save those four lines while adding a package that parses
   * tokens this product never receives.
   *
   * `aud` is the OAuth HOST and not the URL — `account.docusign.com`, no scheme
   * and no path. DocuSign rejects the URL form with `invalid_grant`, which says
   * nothing about which of the five claims was wrong, so it is derived from the
   * configured base rather than written out twice.
   */
  private assertion(): string {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const header = segment({ alg: "RS256", typ: "JWT" });
    const claims = segment({
      iss: this.connection.integrationKey,
      sub: this.connection.userId,
      aud: new URL(this.connection.oauthBase).host,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      scope: SCOPE,
    });
    const signingInput = `${header}.${claims}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.key, "base64url");
    return `${signingInput}.${signature}`;
  }

  /**
   * The token endpoint's refusals, translated into something a person can act
   * on.
   *
   * DocuSign answers all of these with `{"error": "...", "error_description":
   * "..."}` and the descriptions are written for somebody who already knows
   * what went wrong. `consent_required` is the one that matters most: it is not
   * a misconfiguration, it is a step of administration nobody has performed
   * yet, and the only useful thing to say is which URL to open.
   */
  private tokenRefusal(reply: HttpReply): Error {
    const payload = record(parseJson(reply.body, "the DocuSign token refusal"));
    const code = payload === null ? null : text(payload["error"]);
    const described = payload === null ? null : text(payload["error_description"]);

    if (code === "consent_required") {
      return new SignerUnavailable(
        `DocuSign has not been granted consent to act as the user in ` +
          `BIB_DOCUSIGN_USER_ID=${this.connection.userId}. This is a one-off step and no ` +
          `configuration change will substitute for it: a DocuSign administrator must open ` +
          `${this.consentUrl()} (appending &redirect_uri= one of the redirect URIs registered ` +
          `on the integration key) and approve it. Until then no envelope can be verified.`,
      );
    }
    if (code === "invalid_client") {
      return new SignerUnavailable(
        `DocuSign does not recognise BIB_DOCUSIGN_INTEGRATION_KEY=` +
          `${this.connection.integrationKey} at ${this.connection.oauthBase}. An integration ` +
          `key exists in ONE environment: keys made in the developer sandbox work only against ` +
          `BIB_DOCUSIGN_OAUTH_BASE=https://account-d.docusign.com, and production keys only ` +
          `against https://account.docusign.com. ${described ?? ""}`.trim(),
      );
    }
    if (code === "invalid_grant") {
      return new SignerUnavailable(
        `DocuSign rejected the JWT assertion (invalid_grant). The usual causes, in the order ` +
          `they happen: BIB_DOCUSIGN_USER_ID=${this.connection.userId} is an email address ` +
          `rather than the user's GUID; BIB_DOCUSIGN_PRIVATE_KEY is not the key whose public ` +
          `half is registered on integration key ${this.connection.integrationKey}; or this ` +
          `host's clock is far enough from DocuSign's that the assertion looks expired. ` +
          `${described ?? ""}`.trim(),
      );
    }
    return new SignerUnavailable(
      `DocuSign refused to issue a token: HTTP ${reply.status}${code === null ? "" : ` ${code}`}. ` +
        `${described ?? clip(reply.body)} Check BIB_DOCUSIGN_OAUTH_BASE, ` +
        `BIB_DOCUSIGN_INTEGRATION_KEY, BIB_DOCUSIGN_USER_ID and BIB_DOCUSIGN_PRIVATE_KEY.`,
    );
  }

  private consentUrl(): string {
    const query = new URLSearchParams({
      response_type: "code",
      scope: SCOPE,
      client_id: this.connection.integrationKey,
    }).toString();
    return `${trimSlash(this.connection.oauthBase)}/oauth/auth?${query}`;
  }

  // ── Which account, and on which host ───────────────────────────────────────

  private async accountOf(): Promise<{ accountId: string; baseUri: string }> {
    const known = this.account;
    if (known !== null) return known;
    if (this.discovering !== null) return this.discovering;

    const discovering = this.discoverAccount();
    this.discovering = discovering;
    try {
      const found = await discovering;
      this.account = found;
      return found;
    } finally {
      this.discovering = null;
    }
  }

  private async discoverAccount(): Promise<{ accountId: string; baseUri: string }> {
    const reply = await this.authorized({
      method: "GET",
      url: `${trimSlash(this.connection.oauthBase)}/oauth/userinfo`,
    });
    if (reply.status !== 200) {
      throw new SignerUnavailable(
        `DocuSign refused to describe the user in BIB_DOCUSIGN_USER_ID=` +
          `${this.connection.userId}: HTTP ${reply.status}. ${detail(reply.body)}`,
      );
    }

    const payload = record(parseJson(reply.body, "the DocuSign userinfo response"));
    const accounts = payload === null ? [] : list(payload["accounts"]).map(record);
    const usable = accounts.flatMap((a) => {
      if (a === null) return [];
      const id = text(a["account_id"]);
      const base = text(a["base_uri"]);
      if (id === null || base === null) return [];
      return [{ accountId: id, baseUri: trimSlash(base), isDefault: a["is_default"] === true }];
    });

    if (usable.length === 0) {
      throw new SignerUnavailable(
        `DocuSign reports no accounts for the user in BIB_DOCUSIGN_USER_ID=` +
          `${this.connection.userId}. Either the GUID names nobody, or that user has been ` +
          `removed from every account.`,
      );
    }

    // A CONFIGURED ACCOUNT IS AN ASSERTION, SO IT IS CHECKED. Silently falling
    // back to the default when the configured id is not among them would make a
    // typo look like a working deployment right up to the first envelope read
    // in the wrong account.
    const wanted = this.connection.accountId;
    const chosen =
      wanted === null
        ? (usable.find((a) => a.isDefault) ?? usable[0])
        : usable.find((a) => a.accountId === wanted);
    if (chosen === undefined) {
      throw new SignerUnavailable(
        `BIB_DOCUSIGN_ACCOUNT_ID=${wanted ?? ""} is not an account the user in ` +
          `BIB_DOCUSIGN_USER_ID=${this.connection.userId} belongs to. Valid: ` +
          `${usable.map((a) => a.accountId).join(", ")}`,
      );
    }

    // Said once per process, because "which DocuSign account is this server
    // bound to" is the first question asked when a verification refuses and the
    // answer is otherwise nowhere.
    this.log.info(
      { accountId: chosen.accountId, baseUri: chosen.baseUri, configured: wanted !== null },
      "docusign account resolved",
    );
    return { accountId: chosen.accountId, baseUri: chosen.baseUri };
  }

  /**
   * A call carrying a token, retried ONCE when DocuSign says the token is no
   * good.
   *
   * The cache expires a token a minute early precisely so this should not
   * happen — but "should not happen" here depends on two clocks agreeing, and
   * the cost of being wrong is a firm told their signature could not be
   * verified when the truth is that a token aged out mid-request. One retry
   * with a freshly minted token distinguishes the two, and a second 401 is a
   * real refusal that must surface.
   */
  private async authorized(request: {
    method: "GET" | "POST" | "PUT";
    url: string;
    body?: string;
    binary?: boolean;
  }): Promise<HttpReply> {
    const headers = async (): Promise<Record<string, string>> => ({
      authorization: `Bearer ${await this.accessToken()}`,
      accept: request.binary === true ? "application/pdf" : "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    });
    const first = await this.http.send({ ...request, headers: await headers() });
    if (first.status !== 401) return first;

    this.log.warn(
      { url: request.url },
      "docusign rejected the access token — minting a new one and retrying once",
    );
    this.token = null;
    return this.http.send({ ...request, headers: await headers() });
  }
}

/** A tab DocuSign places on the first match of `anchor`, nudged up onto the
 *  printed line. Offsets are strings because DocuSign's JSON says so.
 *
 *  `pixels`, and NOT `points`: DocuSign accepts pixels, inches, mms and cms
 *  and refuses the envelope outright on anything else ("Invalid value for
 *  'anchorStringUnit'" — found by the first real send). Its pixel is 1/72 in,
 *  which is a PDF point, so the offsets mean what the renderer measured. */
function anchorTab(anchor: string, yOffset: string): Record<string, string> {
  return {
    anchorString: anchor,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: yOffset,
    anchorIgnoreIfNotPresent: "false",
  };
}

/**
 * The private key, read once at construction so a bad one is a BOOT failure.
 *
 * This is the same instinct `validateServer` follows: a credential that cannot
 * work should stop the process while somebody is watching it start, not at the
 * first signature of the quarter. The escaped-newline branch is not
 * defensiveness for its own sake — a PEM travelling through an environment
 * variable arrives with literal backslash-n from most secret stores and every
 * shell that has ever quoted one, and `createPrivateKey` answers that with a
 * message about ASN.1 that helps nobody.
 */
function readPrivateKey(pem: string): KeyObject {
  const restored = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  try {
    return createPrivateKey(restored.trim());
  } catch (err) {
    throw new SignerUnavailable(
      `BIB_DOCUSIGN_PRIVATE_KEY is not a readable RSA private key: ` +
        `${err instanceof Error ? err.message : String(err)}. Valid: the PEM DocuSign generated ` +
        `with the integration key's RSA keypair, beginning "-----BEGIN RSA PRIVATE KEY-----" ` +
        `and including its line breaks.`,
    );
  }
}

/** One JWT segment: JSON, then base64url — which is base64 with two characters
 *  swapped and the padding dropped, and which node encodes natively. */
function segment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * JSON, or a refusal that quotes what arrived instead.
 *
 * A proxy, a captive portal or a DocuSign status page returns HTML with a 200
 * on it often enough to be worth naming. `JSON.parse`'s own message — "Unexpected
 * token < in JSON at position 0" — has sent people to read this code rather
 * than their network.
 */
function parseJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SignerUnavailable(
      `DocuSign answered ${what} with something that is not JSON. First bytes: ${clip(body)}`,
    );
  }
}

function readEnvelope(payload: unknown, requestedId: string): DocusignEnvelope {
  const rec = record(payload);
  if (rec === null) {
    throw new SignerUnavailable(`DocuSign answered the envelope ${requestedId} read with a non-object body`);
  }
  const status = text(rec["status"]);
  if (status === null) {
    throw new SignerUnavailable(
      `DocuSign answered the envelope ${requestedId} read with no status on it, so there is ` +
        `nothing to decide from`,
    );
  }
  return {
    id: text(rec["envelopeId"]) ?? requestedId,
    status,
    completedAtISO: text(rec["completedDateTime"]),
    customFields: readCustomFields(rec["customFields"]),
    recipients: readRecipients(rec["recipients"]),
  };
}

/** Both kinds. Envelopes raised by this product use text fields, but a firm's
 *  own template may define the same name as a list field, and a binding that
 *  depended on which kind somebody chose would be a binding in name only. */
function readCustomFields(value: unknown): readonly DocusignCustomField[] {
  const rec = record(value);
  if (rec === null) return [];
  return [...list(rec["textCustomFields"]), ...list(rec["listCustomFields"])].flatMap((raw) => {
    const field = record(raw);
    if (field === null) return [];
    const name = text(field["name"]);
    const fieldValue = text(field["value"]);
    if (name === null || fieldValue === null) return [];
    return [{ name, value: fieldValue }];
  });
}

/** The people who were asked to SIGN, and only them. Carbon copies and
 *  certified deliveries complete without anybody signing anything, so counting
 *  them would defeat the check `DocusignSigner` makes. */
function readRecipients(value: unknown): readonly DocusignRecipient[] {
  const rec = record(value);
  if (rec === null) return [];
  return [...list(rec["signers"]), ...list(rec["inPersonSigners"])].flatMap((raw) => {
    const recipient = record(raw);
    if (recipient === null) return [];
    const status = text(recipient["status"]);
    if (status === null) return [];
    return [{ status, signedAtISO: text(recipient["signedDateTime"]) }];
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A vendor's error body, quoted rather than summarised. DocuSign's REST errors
 *  carry `errorCode` and `message`, and when they do not, the raw body is still
 *  the most informative thing available. */
function detail(body: string): string {
  const rec = record(safeJson(body));
  const code = rec === null ? null : text(rec["errorCode"]);
  const message = rec === null ? null : text(rec["message"]);
  if (code === null && message === null) return clip(body);
  return `${code ?? ""} ${message ?? ""}`.trim();
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Enough of a body to recognise it, and not enough to fill a log with a
 *  vendor's HTML. */
function clip(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? JSON.stringify(flat) : `${JSON.stringify(flat.slice(0, 300))}…`;
}
