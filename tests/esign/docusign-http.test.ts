// The half of the DocuSign integration that talks to DocuSign.
//
// Three things are worth proving here and they are all things that fail at the
// worst possible moment otherwise. The ASSERTION, because a JWT that is wrong
// in any one of five claims is rejected with a message that names none of them.
// The TOKEN CACHE, because the token endpoint is rate limited and a signature
// is a burst of requests. And the ERROR MAPPING, because the first time anybody
// runs this it will answer `consent_required`, and the only useful response to
// that is a URL.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GlobalFetchHttp, JwtGrantDocusign } from "../../src/infrastructure/esign/docusign-http";
import type { DocusignConnection } from "../../src/infrastructure/esign/docusign-http";
import { FakeClock } from "../../src/testfakes/clock";
import {
  ACCOUNT,
  ENVELOPE,
  FakeHttp,
  HASH,
  LETTER,
  RecordingLogger,
  envelopeJson,
  json,
  refusal,
} from "./fakes";

// One keypair for the file. Generating RSA is the slowest thing in this suite
// and nothing here depends on the key being fresh.
const KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const INTEGRATION_KEY = "5b2ff9a0-63e1-4a4b-9a2d-0d5f6c3e7a11";
const USER = "7c1a2b3d-4e5f-4061-8a2b-9c0d1e2f3a44";

function connection(overrides: Partial<DocusignConnection> = {}): DocusignConnection {
  return {
    oauthBase: "https://account.docusign.com",
    integrationKey: INTEGRATION_KEY,
    userId: USER,
    accountId: ACCOUNT,
    privateKeyPem: KEYS.privateKey,
    ...overrides,
  };
}

function transport(
  http: FakeHttp,
  overrides: Partial<DocusignConnection> = {},
  clock = new FakeClock(),
): { docusign: JwtGrantDocusign; log: RecordingLogger; clock: FakeClock } {
  const log = new RecordingLogger();
  return { docusign: new JwtGrantDocusign(connection(overrides), http, log, clock), log, clock };
}

/** The assertion out of the one form-encoded body that carried one. */
function assertionFrom(http: FakeHttp): { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: string; signature: string } {
  const posted = http.requests.find((r) => r.url.includes("/oauth/token"));
  if (posted === undefined || posted.body === undefined) throw new Error("no token request was made");
  const assertion = new URLSearchParams(posted.body).get("assertion");
  if (assertion === null) throw new Error("the token request carried no assertion");
  const [header = "", claims = "", signature = ""] = assertion.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${claims}`,
    signature,
  };
}

function ready(): FakeHttp {
  const http = new FakeHttp().withDefaults();
  http.on("/envelopes/", () => json(200, envelopeJson()));
  return http;
}

describe("the JWT assertion", () => {
  it("carries exactly the six claims DocuSign asks for", async () => {
    const http = ready();
    const t = transport(http, {}, new FakeClock(new Date("2026-07-02T11:00:00Z")));
    await t.docusign.envelope(ENVELOPE);

    const { header, claims } = assertionFrom(http);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "scope", "sub"]);
    expect(claims["iss"]).toBe(INTEGRATION_KEY);
    expect(claims["sub"]).toBe(USER);
    expect(claims["scope"]).toBe("signature impersonation");
    expect(claims["iat"]).toBe(Math.floor(Date.parse("2026-07-02T11:00:00Z") / 1000));
    expect(claims["exp"]).toBe(Math.floor(Date.parse("2026-07-02T11:00:00Z") / 1000) + 3600);
  });

  it("uses the OAuth HOST as aud, never the URL", async () => {
    // The URL form is rejected as invalid_grant, which says nothing about which
    // claim was wrong. Deriving it from the configured base is what keeps the
    // sandbox and production from needing two different spellings.
    const http = ready();
    const t = transport(http, { oauthBase: "https://account-d.docusign.com" });
    await t.docusign.envelope(ENVELOPE);

    expect(assertionFrom(http).claims["aud"]).toBe("account-d.docusign.com");
  });

  it("is signed with RS256 by the configured private key", async () => {
    const http = ready();
    const t = transport(http);
    await t.docusign.envelope(ENVELOPE);

    const { signingInput, signature } = assertionFrom(http);
    const verified = createVerify("RSA-SHA256")
      .update(signingInput)
      .verify(KEYS.publicKey, Buffer.from(signature, "base64url"));
    expect(verified).toBe(true);
  });

  it("posts it as a JWT bearer grant, form encoded", async () => {
    const http = ready();
    await transport(http).docusign.envelope(ENVELOPE);

    const posted = http.requests.find((r) => r.url.includes("/oauth/token"));
    expect(posted?.method).toBe("POST");
    expect(posted?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(posted?.body ?? "").get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
  });

  it("refuses a private key that is not one, at construction, naming the variable", () => {
    // A boot failure while somebody is watching the process start, rather than
    // a 500 at the first signature of the quarter.
    expect(() => transport(new FakeHttp(), { privateKeyPem: "not a key" })).toThrow(
      /BIB_DOCUSIGN_PRIVATE_KEY/,
    );
  });

  it("accepts a PEM whose newlines were escaped on the way through the environment", async () => {
    // Which is how one arrives from most secret stores and every shell that has
    // quoted one. The alternative is a message about ASN.1.
    const http = ready();
    const escaped = KEYS.privateKey.replace(/\n/g, "\\n");
    const t = transport(http, { privateKeyPem: escaped });

    await expect(t.docusign.envelope(ENVELOPE)).resolves.not.toBeNull();
  });
});

describe("the token cache", () => {
  it("mints once and reuses it for the rest of the hour", async () => {
    const http = ready();
    const clock = new FakeClock(new Date("2026-07-02T11:00:00Z"));
    const t = transport(http, {}, clock);

    await t.docusign.envelope(ENVELOPE);
    clock.advanceMinutes(50);
    await t.docusign.envelope(ENVELOPE);

    expect(http.countOf("/oauth/token")).toBe(1);
  });

  it("mints again a minute before expiry rather than a minute after", async () => {
    // The margin covers the drift between this host's clock and DocuSign's,
    // plus the flight time of the request the token is about to be used on.
    const http = ready();
    const clock = new FakeClock(new Date("2026-07-02T11:00:00Z"));
    const t = transport(http, {}, clock);

    await t.docusign.envelope(ENVELOPE);
    clock.advanceMinutes(59.5);
    await t.docusign.envelope(ENVELOPE);

    expect(http.countOf("/oauth/token")).toBe(2);
  });

  it("mints one token for a burst, not one per caller", async () => {
    // The token endpoint is rate limited, so a busy minute that minted a token
    // per request would turn into an outage rather than a slowdown.
    const http = ready();
    const t = transport(http);

    await Promise.all([
      t.docusign.envelope(ENVELOPE),
      t.docusign.envelope(ENVELOPE),
      t.docusign.envelope(ENVELOPE),
    ]);

    expect(http.countOf("/oauth/token")).toBe(1);
  });

  it("mints a fresh token and retries once when DocuSign rejects the one it held", async () => {
    const http = new FakeHttp().withDefaults();
    let rejections = 1;
    http.on("/envelopes/", () => {
      if (rejections > 0) {
        rejections -= 1;
        return json(401, { errorCode: "AUTHORIZATION_INVALID_TOKEN", message: "expired" });
      }
      return json(200, envelopeJson());
    });
    const t = transport(http);

    await expect(t.docusign.envelope(ENVELOPE)).resolves.not.toBeNull();
    expect(http.countOf("/oauth/token")).toBe(2);
    expect(t.log.lines.some((l) => l.level === "warn")).toBe(true);
  });
});

describe("what the token endpoint's refusals are turned into", () => {
  function refusing(body: unknown, status = 400): FakeHttp {
    const http = new FakeHttp().withDefaults();
    http.on("/oauth/token", () => json(status, body));
    return http;
  }

  it("turns consent_required into the URL an administrator has to open", async () => {
    // It is not a misconfiguration. It is a step of administration nobody has
    // performed, and no amount of editing environment variables substitutes.
    const t = transport(refusing({ error: "consent_required" }));
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("BIB_DOCUSIGN_USER_ID");
    expect(err).toContain("https://account.docusign.com/oauth/auth?");
    expect(err).toContain(`client_id=${INTEGRATION_KEY}`);
    expect(err).toContain("signature+impersonation");
  });

  it("turns invalid_client into the sandbox-versus-production mistake", async () => {
    const t = transport(refusing({ error: "invalid_client", error_description: "no client" }));
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("BIB_DOCUSIGN_INTEGRATION_KEY");
    expect(err).toContain("account-d.docusign.com");
  });

  it("turns invalid_grant into the three things it actually means", async () => {
    const t = transport(refusing({ error: "invalid_grant", error_description: "no" }));
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("BIB_DOCUSIGN_USER_ID");
    expect(err).toContain("BIB_DOCUSIGN_PRIVATE_KEY");
    expect(err).toMatch(/clock/);
  });

  it("names every variable involved when the refusal is one it has not met", async () => {
    const t = transport(refusing({ error: "server_error" }, 503));
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("BIB_DOCUSIGN_OAUTH_BASE");
    expect(err).toContain("503");
  });

  it("says so plainly when a 200 carries no token", async () => {
    const t = transport(refusing({ token_type: "Bearer" }, 200));
    await expect(t.docusign.envelope(ENVELOPE)).rejects.toThrow(/no access_token/);
  });

  it("quotes what arrived when it is not JSON at all", async () => {
    // A captive portal or a vendor status page, returned with a 200 on it.
    const http = new FakeHttp().withDefaults();
    http.on("/oauth/token", () => ({ status: 200, body: "<html>maintenance</html>" }));
    const t = transport(http);

    await expect(t.docusign.envelope(ENVELOPE)).rejects.toThrow(/not JSON/);
  });
});

describe("which account, and on which host", () => {
  it("uses the configured account's own base URI, not a guessed one", async () => {
    const http = new FakeHttp().withDefaults({ baseUri: "https://eu.docusign.net" });
    http.on("/envelopes/", () => json(200, envelopeJson()));
    const t = transport(http);

    await t.docusign.envelope(ENVELOPE);
    const read = http.urls().find((u) => u.includes("/envelopes/"));
    expect(read).toBe(
      `https://eu.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes/${ENVELOPE}` +
        `?include=recipients,custom_fields`,
    );
  });

  it("asks who it is exactly once per process", async () => {
    const http = ready();
    const t = transport(http);

    await t.docusign.envelope(ENVELOPE);
    await t.docusign.envelope(ENVELOPE);

    expect(http.countOf("/oauth/userinfo")).toBe(1);
  });

  it("takes the default account when none is configured", async () => {
    const http = new FakeHttp();
    http.on("/oauth/token", () => json(200, { access_token: "t", expires_in: 3600 }));
    http.on("/oauth/userinfo", () =>
      json(200, {
        accounts: [
          { account_id: "other", is_default: false, base_uri: "https://na1.docusign.net" },
          { account_id: ACCOUNT, is_default: true, base_uri: "https://na4.docusign.net" },
        ],
      }),
    );
    http.on("/envelopes/", () => json(200, envelopeJson()));
    const t = transport(http, { accountId: null });

    await t.docusign.envelope(ENVELOPE);
    expect(http.urls().some((u) => u.includes(`/accounts/${ACCOUNT}/`))).toBe(true);
  });

  it("refuses a configured account the user does not belong to, and lists the ones they do", async () => {
    // Falling back to the default here would make a typo look like a working
    // deployment until the first envelope was read in the wrong account.
    const http = new FakeHttp().withDefaults({ accountId: "the-real-one" });
    const t = transport(http, { accountId: "a-typo" });
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("BIB_DOCUSIGN_ACCOUNT_ID=a-typo");
    expect(err).toContain("the-real-one");
  });

  it("says which account it is bound to, once, in the log", async () => {
    const http = ready();
    const t = transport(http);
    await t.docusign.envelope(ENVELOPE);

    expect(t.log.lines.filter((l) => l.msg === "docusign account resolved")).toHaveLength(1);
  });
});

describe("reading an envelope", () => {
  it("returns the fields and the signers the check depends on", async () => {
    const t = transport(ready());
    const envelope = await t.docusign.envelope(ENVELOPE);

    expect(envelope?.id).toBe(ENVELOPE);
    expect(envelope?.status).toBe("completed");
    expect(envelope?.completedAtISO).toBe("2026-07-02T11:04:00.0000000Z");
    expect(envelope?.customFields).toEqual([
      { name: "bib_letter_id", value: LETTER },
      { name: "bib_content_hash", value: HASH },
    ]);
    expect(envelope?.recipients).toEqual([
      { status: "completed", signedAtISO: "2026-07-02T11:03:58.0000000Z" },
    ]);
  });

  it("reads a custom field a firm's template defined as a list rather than text", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes/", () =>
      json(
        200,
        envelopeJson({
          textFields: [{ name: "bib_letter_id", value: LETTER }],
          listFields: [{ name: "bib_content_hash", value: HASH }],
        }),
      ),
    );
    const t = transport(http);

    const envelope = await t.docusign.envelope(ENVELOPE);
    expect(envelope?.customFields).toContainEqual({ name: "bib_content_hash", value: HASH });
  });

  it("counts signers and ignores carbon copies", async () => {
    // A carbon copy completes without anybody signing anything, so counting one
    // would defeat the recipient check the signer makes.
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes/", () => json(200, envelopeJson({ signerStatuses: [], carbonCopies: 2 })));
    const t = transport(http);

    expect((await t.docusign.envelope(ENVELOPE))?.recipients).toEqual([]);
  });

  it("answers null for an envelope this account does not hold", async () => {
    // An answer, not a fault: the id was typed by a person. The signer turns it
    // into a refusal that says which account was searched.
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes/", () => json(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" }));
    const t = transport(http);

    await expect(t.docusign.envelope(ENVELOPE)).resolves.toBeNull();
  });

  it("throws with DocuSign's own error text on any other refusal", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes/", () =>
      json(403, { errorCode: "USER_LACKS_PERMISSIONS", message: "not permitted" }),
    );
    const t = transport(http);
    const err = await refusal(t.docusign.envelope(ENVELOPE));

    expect(err).toContain("USER_LACKS_PERMISSIONS");
    expect(err).toContain("BIB_DOCUSIGN_ACCOUNT_ID");
  });

  it("refuses an envelope body with no status, rather than deciding from nothing", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes/", () => json(200, { envelopeId: ENVELOPE }));
    const t = transport(http);

    await expect(t.docusign.envelope(ENVELOPE)).rejects.toThrow(/no status/);
  });
});

describe("the fetch adapter", () => {
  it("exists and holds a timeout, because nothing else bounds this call", () => {
    // The timeout is the whole reason this wrapper is not a bare `fetch`: this
    // runs inside a request somebody at the firm is waiting on.
    expect(new GlobalFetchHttp(5000)).toBeInstanceOf(GlobalFetchHttp);
  });
});
