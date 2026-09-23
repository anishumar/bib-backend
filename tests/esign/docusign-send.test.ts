// The half of DocuSign that SENDS (0080): what an envelope for a letter
// contains, how DocuSign's statuses become the four answers the sweep acts on,
// and — the property the whole feature rests on — that an envelope this
// product raised is one the verifier then ACCEPTS once the client signs.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JwtGrantDocusign } from "../../src/infrastructure/esign/docusign-http";
import { DocusignDispatch } from "../../src/infrastructure/esign/docusign-dispatch";
import {
  DOCUSIGN_CONTENT_HASH_FIELD,
  DOCUSIGN_LETTER_ID_FIELD,
  DocusignSigner,
} from "../../src/infrastructure/esign/docusign-signer";
import { CLIENT_DATE_ANCHOR, CLIENT_SIGN_ANCHOR } from "../../src/domain/render/model";
import { FakeClock } from "../../src/testfakes/clock";
import { SignerUnavailable } from "../../src/domain/engagement/errors";
import { ACCOUNT, ENVELOPE, FakeHttp, HASH, LETTER, RecordingLogger, envelopeJson, json, refusal } from "./fakes";

const KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function transport(http: FakeHttp): JwtGrantDocusign {
  return new JwtGrantDocusign(
    {
      oauthBase: "https://account-d.docusign.com",
      integrationKey: "5b2ff9a0-63e1-4a4b-9a2d-0d5f6c3e7a11",
      userId: "7c1a2b3d-4e5f-4061-8a2b-9c0d1e2f3a44",
      accountId: ACCOUNT,
      privateKeyPem: KEYS.privateKey,
    },
    http,
    new RecordingLogger(),
    new FakeClock(new Date("2026-07-02T11:00:00Z")),
  );
}

const RAISE = {
  letterId: LETTER,
  ref: "EL-2026-0007",
  title: "Meridian — FY27 compliance",
  contentHash: HASH,
  signer: { name: "Priya Menon", email: "priya@meridian.example" },
  document: { bytes: new Uint8Array([37, 80, 68, 70, 45]), filename: "EL-2026-0007.pdf" },
};

function posted(http: FakeHttp): Record<string, unknown> {
  const create = http.requests.find((r) => r.method === "POST" && r.url.endsWith("/envelopes"));
  if (create?.body === undefined) throw new Error("no envelope was created");
  return JSON.parse(create.body) as Record<string, unknown>;
}

describe("raising an envelope for a letter", () => {
  it("posts one SENT envelope to the account's own host, with the PDF and one signer", async () => {
    const http = new FakeHttp().withDefaults({ baseUri: "https://demo.docusign.net" });
    http.on("/envelopes", () => json(201, { envelopeId: ENVELOPE, status: "sent" }));
    const dispatch = new DocusignDispatch(transport(http));

    const { envelopeId } = await dispatch.raise(RAISE);

    expect(envelopeId).toBe(ENVELOPE);
    const create = http.requests.find((r) => r.method === "POST" && r.url.endsWith("/envelopes"));
    expect(create?.url).toBe(`https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}/envelopes`);
    expect(create?.headers["content-type"]).toBe("application/json");
    const body = posted(http);
    expect(body).toMatchObject({
      status: "sent",
      emailSubject: "Please sign: Meridian — FY27 compliance (EL-2026-0007)",
      documents: [
        {
          documentId: "1",
          name: "EL-2026-0007.pdf",
          fileExtension: "pdf",
          documentBase64: Buffer.from(RAISE.document.bytes).toString("base64"),
        },
      ],
      recipients: { signers: [{ name: "Priya Menon", email: "priya@meridian.example", recipientId: "1" }] },
    });
  });

  it("places the signature and the date on the anchors the renderer prints, and refuses a PDF without them", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes", () => json(201, { envelopeId: ENVELOPE }));
    await new DocusignDispatch(transport(http)).raise(RAISE);

    const tabs = (posted(http) as { recipients: { signers: { tabs: Record<string, Record<string, string>[]> }[] } })
      .recipients.signers[0]?.tabs;
    expect(tabs?.["signHereTabs"]?.[0]).toMatchObject({
      anchorString: CLIENT_SIGN_ANCHOR,
      // One of the four units DocuSign accepts; `points` is refused with
      // INVALID_REQUEST_PARAMETER, which the first real send found.
      anchorUnits: "pixels",
      anchorIgnoreIfNotPresent: "false",
    });
    expect(tabs?.["dateSignedTabs"]?.[0]).toMatchObject({ anchorString: CLIENT_DATE_ANCHOR });
  });

  it("stamps BOTH binding fields, under the verifier's own names, hidden from the signer", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes", () => json(201, { envelopeId: ENVELOPE }));
    await new DocusignDispatch(transport(http)).raise(RAISE);

    expect(posted(http)["customFields"]).toEqual({
      textCustomFields: [
        { name: DOCUSIGN_LETTER_ID_FIELD, value: LETTER, show: "false", required: "false" },
        { name: DOCUSIGN_CONTENT_HASH_FIELD, value: HASH, show: "false", required: "false" },
      ],
    });
  });

  it("clips a subject DocuSign would refuse, rather than failing the send", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes", () => json(201, { envelopeId: ENVELOPE }));
    await new DocusignDispatch(transport(http)).raise({ ...RAISE, title: "x".repeat(300) });

    expect(String(posted(http)["emailSubject"]).length).toBeLessThanOrEqual(100);
  });

  it("turns DocuSign's refusal into SignerUnavailable, in DocuSign's words", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes", () =>
      json(400, { errorCode: "INVALID_EMAIL_ADDRESS_FOR_RECIPIENT", message: "The email address for the recipient is invalid." }),
    );

    const attempt = new DocusignDispatch(transport(http)).raise(RAISE);

    await expect(attempt).rejects.toBeInstanceOf(SignerUnavailable);
    expect(await refusal(attempt)).toMatch(/INVALID_EMAIL_ADDRESS_FOR_RECIPIENT/);
  });
});

describe("the round trip", () => {
  it("an envelope this product raised, once completed, VERIFIES against the same letter and hash", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes", () => json(201, { envelopeId: ENVELOPE }));
    const docusign = transport(http);
    await new DocusignDispatch(docusign).raise(RAISE);

    // DocuSign hands back exactly the fields it was given, now completed.
    const stamped = (posted(http)["customFields"] as { textCustomFields: { name: string; value: string }[] })
      .textCustomFields.map((f) => ({ name: f.name, value: f.value }));
    http.on(`/envelopes/${ENVELOPE}`, () => json(200, envelopeJson({ textFields: stamped })));

    const verified = await new DocusignSigner(docusign, new RecordingLogger()).sign({
      tenantId: "t",
      letterId: LETTER,
      signedByName: "Priya Menon",
      contentHash: HASH,
      reference: ENVELOPE,
    });
    expect(verified.reference).toBe(ENVELOPE);
  });
});

describe("where an envelope has got to", () => {
  function reading(status: string | null): DocusignDispatch {
    const http = new FakeHttp().withDefaults();
    http.on(`/envelopes/${ENVELOPE}`, () =>
      status === null ? json(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" }) : json(200, envelopeJson({ status })),
    );
    return new DocusignDispatch(transport(http));
  }

  it.each([
    ["completed", "completed"],
    ["declined", "declined"],
    ["voided", "voided"],
    ["deleted", "voided"],
    ["sent", "out"],
    ["delivered", "out"],
    ["signed", "out"],
    ["correct", "out"],
  ])("reads %s as %s", async (status, state) => {
    await expect(reading(status).progress(ENVELOPE)).resolves.toEqual({ state, detail: status });
  });

  it("reads an envelope the account does not hold as MISSING, never voided — a wrong account must not withdraw every letter", async () => {
    await expect(reading(null).progress(ENVELOPE)).resolves.toEqual({ state: "missing", detail: "not found" });
  });
});

describe("finding an envelope already raised for a letter", () => {
  it("searches by the letter-id field, from a day before the request, and skips dead ones", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes?", () =>
      json(200, {
        envelopes: [
          { envelopeId: "11111111-1111-1111-1111-111111111111", status: "voided" },
          { envelopeId: ENVELOPE, status: "sent" },
        ],
      }),
    );

    const found = await new DocusignDispatch(transport(http)).findForLetter(LETTER, "2026-07-02T11:00:00.000Z");

    expect(found).toBe(ENVELOPE);
    const search = new URL(http.requests.find((r) => r.url.includes("/envelopes?"))?.url ?? "");
    expect(search.searchParams.get("custom_field")).toBe(`${DOCUSIGN_LETTER_ID_FIELD}=${LETTER}`);
    expect(search.searchParams.get("from_date")).toBe("2026-07-01T11:00:00.000Z");
  });

  it("answers null when every envelope for the letter is dead, or there is none", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/envelopes?", () => json(200, { envelopes: [{ envelopeId: ENVELOPE, status: "declined" }] }));
    await expect(new DocusignDispatch(transport(http)).findForLetter(LETTER, "2026-07-02T11:00:00Z")).resolves.toBeNull();

    const empty = new FakeHttp().withDefaults();
    empty.on("/envelopes?", () => json(200, { resultSetSize: "0" }));
    await expect(new DocusignDispatch(transport(empty)).findForLetter(LETTER, "2026-07-02T11:00:00Z")).resolves.toBeNull();
  });
});

describe("fetching the signed copies", () => {
  it("downloads the signed letter WITHOUT the certificate, and the certificate on its own, as bytes", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 0xff, 0x00, 0x9c]);
    const cert = new Uint8Array([37, 80, 68, 70, 0x01]);
    const http = new FakeHttp().withDefaults();
    http.on("/documents/combined", () => ({ status: 200, body: "", bytes: pdf }));
    http.on("/documents/certificate", () => ({ status: 200, body: "", bytes: cert }));

    const copies = await new DocusignDispatch(transport(http)).signedCopies(ENVELOPE);

    // Bytes that are not valid UTF-8 survive — a PDF read as text would not.
    expect(copies.signed.bytes).toEqual(pdf);
    expect(copies.certificate.bytes).toEqual(cert);
    const combined = http.requests.find((r) => r.url.includes("/documents/combined"));
    expect(combined?.url).toContain(`/envelopes/${ENVELOPE}/documents/combined?certificate=false`);
    expect(combined?.binary).toBe(true);
    expect(combined?.headers["accept"]).toBe("application/pdf");
  });

  it("refuses an empty or failed download in DocuSign's words, rather than filing nothing as something", async () => {
    const http = new FakeHttp().withDefaults();
    http.on("/documents/combined", () => ({ status: 200, body: "", bytes: new Uint8Array() }));
    http.on("/documents/certificate", () =>
      ({ status: 404, body: JSON.stringify({ errorCode: "ENVELOPE_DOES_NOT_EXIST" }), bytes: new Uint8Array() }),
    );

    const message = await refusal(new DocusignDispatch(transport(http)).signedCopies(ENVELOPE));

    expect(message).toMatch(/would not hand over/);
  });
});

describe("voiding", () => {
  it("PUTs status voided with the reason", async () => {
    const http = new FakeHttp().withDefaults();
    http.on(`/envelopes/${ENVELOPE}`, () => json(200, {}));

    await new DocusignDispatch(transport(http)).void(ENVELOPE, "EL-2026-0007 was withdrawn by the firm");

    const put = http.requests.find((r) => r.method === "PUT");
    expect(put?.url).toContain(`/envelopes/${ENVELOPE}`);
    expect(JSON.parse(put?.body ?? "{}")).toEqual({
      status: "voided",
      voidedReason: "EL-2026-0007 was withdrawn by the firm",
    });
  });

  it("says plainly that nothing was withdrawn when DocuSign refuses the void", async () => {
    const http = new FakeHttp().withDefaults();
    http.on(`/envelopes/${ENVELOPE}`, () =>
      json(400, { errorCode: "ENVELOPE_CANNOT_VOID_INVALID_STATE", message: "Only envelopes in the 'Sent' or 'Delivered' states may be voided." }),
    );

    const message = await refusal(new DocusignDispatch(transport(http)).void(ENVELOPE, "withdrawn"));

    expect(message).toMatch(/ENVELOPE_CANNOT_VOID_INVALID_STATE/);
    expect(message).toMatch(/Nothing was withdrawn/);
  });
});
