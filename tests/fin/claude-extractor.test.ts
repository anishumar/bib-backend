// The Claude adapter (F2.4, infrastructure/fin/claude-extractor.ts) against a
// RECORDED transport: the SDK takes a `fetch`, and this one answers with
// responses shaped like the Messages API's own, a tool call, a 429 and a 529
// among them. Nothing here reaches the network, and there is no key: the one
// used is a made-up string whose only job is to prove it never comes back out.
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_TOOL_DESCRIPTION,
  DOCUMENT_TOOL_NAME,
  documentToolSchema,
} from "../../src/domain/fin/extraction";
import { ANTHROPIC_API, ClaudeExtractor } from "../../src/infrastructure/fin/claude-extractor";
import type { ClaudeFetch } from "../../src/infrastructure/fin/claude-extractor";
import {
  PROMPT_VERSION,
  REQUEST_SETTINGS,
  SYSTEM_PROMPT,
  userInstruction,
} from "../../src/infrastructure/fin/claude-prompt";
import type { ExtractionAttempt, ExtractionRequest } from "../../src/usecase/fin/extract-ports";
import { parseDocumentReading } from "../../src/usecase/fin/extract-output";

const KEY = "sk-ant-api03-NOT-A-REAL-KEY-must-never-leak-0123456789abcdef";
const MODEL = "claude-sonnet-5-5";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_011CTk3qWJ7p2nXb8Ld5Ys9V", ...headers },
  });
}

/** A transport that answers from a list and keeps what it was sent. */
type Answer = Response | ((init?: RequestInit) => Promise<Response>);

function recorded(...answers: Answer[]): { fetch: ClaudeFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const queue = [...answers];
  const fetch: ClaudeFetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error("recorded transport: no answer left"));
    return typeof next === "function" ? next(init) : Promise.resolve(next);
  };
  return { fetch, sent };
}

/** What Claude sent back for Lumen Cloudworks' Singa Mobile invoice (A-X01). */
const TOOL_INPUT = {
  docType: "purchase_invoice",
  docTypeConfidence: 0.99,
  fields: {
    counterpartyName: { value: "Singa Mobile and Fibre Pte Ltd", status: "read", confidence: 0.99 },
    counterpartyUen: { value: "201811234K", status: "read", confidence: 0.97 },
    counterpartyGstNo: { value: "201811234K", status: "read", confidence: 0.96 },
    docNumber: { value: "K03467", status: "read", confidence: 0.99 },
    docDate: { value: "21 Apr 2025", status: "read", confidence: 0.98 },
    currency: { value: "SGD", status: "read", confidence: 0.98 },
    fxRate: { value: null, status: "not_printed", confidence: 0.95 },
    net: { value: "575.00", status: "read", confidence: 0.98 },
    gstRate: { value: "8%", status: "read", confidence: 0.97 },
    gst: { value: "46.00", status: "read", confidence: 0.98 },
    total: { value: "621.00", status: "read", confidence: 0.99 },
    servicePeriodFrom: { value: "April 2025", status: "read", confidence: 0.9 },
    servicePeriodTo: { value: "April 2025", status: "read", confidence: 0.9 },
    creditNoteRef: { value: null, status: "not_printed", confidence: 0.97 },
  },
  overallConfidence: 0.96,
};

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_01JX7r2Q9aVqfK3cW8mBd1Tz",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "EuYBCkQYAiJAm1fLxR0k3Zq" },
      {
        type: "tool_use",
        id: "toolu_01Hq9cV2Nw8bR4kT6pLs3Xy7",
        name: DOCUMENT_TOOL_NAME,
        input: TOOL_INPUT,
        caller: { type: "direct" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 3812,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2716,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: 734,
      output_tokens_details: { thinking_tokens: 211 },
      server_tool_use: null,
      service_tier: "standard",
      inference_geo: "global",
    },
    ...over,
  };
}

function apiError(status: number, type: string, text: string): Response {
  return json(status, { type: "error", error: { type, message: text }, request_id: "req_011CTk9ErrRqf2" });
}

const PDF: ExtractionRequest = {
  content: { kind: "pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) },
  owner: { names: ["Lumen Cloudworks Pte Ltd"], uen: "202134890G", gstNo: "M2-9588401-7" },
  correction: null,
};

function extractor(fetch: ClaudeFetch, timeoutMs = 120_000): ClaudeExtractor {
  return new ClaudeExtractor({ apiKey: KEY, model: MODEL, timeoutMs, fetch });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the request it sends", () => {
  it("asks for one strict tool call, caches the stable prefix, and sends the PDF as a document", async () => {
    const t = recorded(json(200, message()));
    await extractor(t.fetch).extract(PDF);

    expect(t.sent).toHaveLength(1);
    const req = t.sent[0];
    expect(req?.url).toBe(`${ANTHROPIC_API}/v1/messages`);
    expect(req?.method).toBe("POST");
    const body = req?.body ?? {};
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(REQUEST_SETTINGS.maxTokens);
    expect(body.output_config).toEqual({ effort: REQUEST_SETTINGS.effort });
    // Sonnet 5.5 and Opus 5.5 refuse a forced call and refuse thinking off.
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body).not.toHaveProperty("thinking");
    expect(body.tools).toEqual([
      {
        name: DOCUMENT_TOOL_NAME,
        description: DOCUMENT_TOOL_DESCRIPTION,
        input_schema: JSON.parse(JSON.stringify(documentToolSchema())) as unknown,
        strict: true,
      },
    ]);
    expect(body.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjc=" } },
          { type: "text", text: userInstruction(PDF.owner, null) },
        ],
      },
    ]);
  });

  it("sends a shrunk image as an image block, and the retry's problems after the cached prefix", async () => {
    const t = recorded(json(200, message()));
    await extractor(t.fetch).extract({
      content: { kind: "image", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" },
      owner: null,
      correction: ["overallConfidence: must be at most 1"],
    });
    const body = t.sent[0]?.body ?? {};
    const content = (body.messages as { content: { type: string; text?: string; source?: unknown }[] }[])[0]?.content;
    expect(content?.[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
    expect(content?.[1]?.text).toContain("Books owner: not known");
    expect(content?.[1]?.text).toContain("- overallConfidence: must be at most 1");
    // The system prompt, the cached part, is the same whatever the file.
    expect(body.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  });

  it("sends the configured key and nothing the environment says: no token, no other host", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "a-token-from-the-environment");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://somewhere-else.example.com");
    const t = recorded(json(200, message()));
    await extractor(t.fetch).extract(PDF);
    const req = t.sent[0];
    expect(req?.url.startsWith(ANTHROPIC_API)).toBe(true);
    expect(req?.headers.get("x-api-key")).toBe(KEY);
    expect(req?.headers.get("authorization")).toBeNull();
    expect(req?.headers.get("anthropic-version")).not.toBeNull();
  });
});

describe("the answer it returns", () => {
  it("returns the tool call's input, the model that answered, the tokens and the request id", async () => {
    const t = recorded(json(200, message({ model: "claude-sonnet-5-5" })));
    const attempt = await extractor(t.fetch).extract(PDF);
    expect(attempt).toEqual({
      kind: "answered",
      model: "claude-sonnet-5-5",
      promptVersion: PROMPT_VERSION,
      requestId: "req_011CTk3qWJ7p2nXb8Ld5Ys9V",
      usage: { inputTokens: 3812, outputTokens: 734, cacheWriteTokens: 0, cacheReadTokens: 2716 },
      stop: "tool_call",
      output: TOOL_INPUT,
    });
    // And the recorded input is a reading the validator accepts.
    expect(parseDocumentReading(attempt.kind === "answered" ? attempt.output : null).ok).toBe(true);
  });

  it("reads the cache write on a cold prefix", async () => {
    const t = recorded(
      json(200, message({ usage: { input_tokens: 3812, output_tokens: 700, cache_creation_input_tokens: 2716, cache_read_input_tokens: 0 } })),
    );
    const attempt = await extractor(t.fetch).extract(PDF);
    expect(attempt.kind === "answered" ? attempt.usage : null).toEqual({
      inputTokens: 3812,
      outputTokens: 700,
      cacheWriteTokens: 2716,
      cacheReadTokens: 0,
    });
  });

  it("says when the model answered in prose instead of calling the tool", async () => {
    const t = recorded(
      json(200, message({ content: [{ type: "text", text: "This is an invoice from Singa Mobile." }], stop_reason: "end_turn" })),
    );
    const attempt = await extractor(t.fetch).extract(PDF);
    expect(attempt).toMatchObject({ kind: "answered", stop: "no_tool_call", output: null });
  });

  it("does not read a tool call that was cut off", async () => {
    const t = recorded(json(200, message({ stop_reason: "max_tokens" })));
    expect(await extractor(t.fetch).extract(PDF)).toMatchObject({ stop: "truncated", output: null });
  });

  it("says when the model declined", async () => {
    const t = recorded(
      json(200, message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } })),
    );
    expect(await extractor(t.fetch).extract(PDF)).toMatchObject({ stop: "refused", output: null });
  });
});

describe("a call that got no answer is our code, never the SDK's", () => {
  it.each([
    [429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", "rate_limited"],
    [529, "overloaded_error", "Overloaded", "overloaded"],
    [500, "api_error", "Internal server error", "server_error"],
    [401, "authentication_error", "invalid x-api-key", "auth"],
    [403, "permission_error", "Your API key does not have permission to use the specified resource.", "auth"],
    [402, "billing_error", "Your credit balance is too low", "auth"],
    [400, "invalid_request_error", "tool_choice: type \"tool\" and \"any\" are not supported for this model.", "bad_request"],
    [404, "not_found_error", "model: claude-sonnet-5-5", "bad_request"],
    [413, "request_too_large", "Request exceeds the maximum allowed number of bytes.", "too_large"],
  ])("%i %s is %s, asked once (the SDK does not retry)", async (status, type, text, failure) => {
    const t = recorded(apiError(status, type, text), json(200, message()));
    const attempt = await extractor(t.fetch).extract(PDF);
    expect(attempt).toEqual({
      kind: "failed",
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      requestId: "req_011CTk3qWJ7p2nXb8Ld5Ys9V",
      failure,
    });
    expect(t.sent).toHaveLength(1);
  });

  it("is a timeout when the provider does not answer in time", async () => {
    // A provider that never answers: only the SDK's own timeout ends it.
    const hang = (init?: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    const t = recorded(hang);
    const attempt = await extractor(t.fetch, 20).extract(PDF);
    expect(attempt).toMatchObject({ kind: "failed", failure: "timeout" });
  });

  it("is a server error when a 200 is not a message at all, so it is recorded and the file waits", async () => {
    const html = new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
    const garbled = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
    const noUsage = json(200, { type: "message", model: MODEL, content: [] });
    for (const body of [html, garbled, noUsage]) {
      expect(await extractor(recorded(body).fetch).extract(PDF)).toMatchObject({ kind: "failed", failure: "server_error" });
    }
  });

  it("is a connection failure when the network fails", async () => {
    const t = recorded(() => Promise.reject(new TypeError("fetch failed")));
    expect(await extractor(t.fetch).extract(PDF)).toMatchObject({ kind: "failed", failure: "connection", requestId: null });
  });
});

describe("the key never comes back out", () => {
  it("is in no attempt, whatever happened to the call", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.resolve(json(200, message())),
      () => Promise.resolve(apiError(401, "authentication_error", `invalid x-api-key ${KEY}`)),
      () => Promise.resolve(apiError(400, "invalid_request_error", `bad request echoing ${KEY}`)),
      () => Promise.resolve(apiError(429, "rate_limit_error", "slow down")),
      () => Promise.resolve(apiError(529, "overloaded_error", "Overloaded")),
      () => Promise.reject(new TypeError(`fetch failed for ${KEY}`)),
    ];
    const attempts: ExtractionAttempt[] = [];
    for (const answer of answers) attempts.push(await extractor(recorded(answer).fetch).extract(PDF));
    expect(attempts.map((a) => a.kind)).toEqual(["answered", "failed", "failed", "failed", "failed", "failed"]);
    for (const a of attempts) expect(JSON.stringify(a)).not.toContain(KEY);
    expect(JSON.stringify(attempts)).not.toContain("NOT-A-REAL-KEY");
  });

  it("does not show in the extractor however it is printed", () => {
    const e = extractor(recorded().fetch);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(inspect(e, { depth: 5 })).not.toContain(KEY);
  });
});

// ── THE VERSION NAMES THE WHOLE REQUEST ──────────────────────────────────────
//
// A hash of everything that shapes the model's answer apart from the model:
// the system prompt, the tool, the per-file message and the settings. If this
// goes red you changed one of them: bump PROMPT_VERSION in claude-prompt.ts
// (fin-doc@2) and pin the new hash here, so no two different requests are ever
// recorded under one version.
describe("the prompt version", () => {
  it("pins fin-doc@1 to exactly this request", () => {
    const shaped = JSON.stringify({
      system: SYSTEM_PROMPT,
      toolName: DOCUMENT_TOOL_NAME,
      toolDescription: DOCUMENT_TOOL_DESCRIPTION,
      schema: documentToolSchema(),
      settings: REQUEST_SETTINGS,
      perFile: [
        userInstruction(PDF.owner, null),
        userInstruction(null, ["a: b"]),
        userInstruction({ names: ["A Pte Ltd", "A"], uen: null, gstNo: null }, null),
      ],
    });
    const hash = createHash("sha256").update(shaped).digest("hex");
    expect({ version: PROMPT_VERSION, hash }).toEqual({
      version: "fin-doc@1",
      hash: "8806de6aa4de38ae8b0b3e0174acb24dd7a9ab590dfc1e3e1a12d8a3e83fb48e",
    });
  });
});
