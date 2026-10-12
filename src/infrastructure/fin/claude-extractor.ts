// The AI reader's model: Claude, over the Messages API (docs/FIN_BUILD_PLAN.md
// F2.4). This file is the ONLY one in the product that imports the Anthropic
// SDK, and nothing the SDK defines leaves it: the port takes our request and
// answers our `ExtractionAttempt`, with the SDK's errors turned into our own
// transport codes at this door.
//
// ── ONE TOOL, AND THE MODEL IS TOLD TO CALL IT ───────────────────────────────
//
// The answer is a call to `record_document` with STRICT tool use, so the input
// arrives matching the tool's JSON schema. `tool_choice` is `auto`, with
// parallel calls off, and the prompt names the tool: forcing the call (`any` or
// a named tool) is refused with a 400 by Sonnet 5.5 and Opus 5.5, the models
// this is built for. `auto` does not guarantee a call, so an answer without one
// is `no_tool_call` and the reader asks once more.
//
// ── NOTHING ELSE IS READ FROM THE ENVIRONMENT ────────────────────────────────
//
// The SDK would read `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
// `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` by itself, and that would be a second
// reader of the environment beside `src/config` and a way for a stray variable
// to change where the firm's documents are sent. So every one of them is passed
// explicitly: the key from config, no auth token, the API's own base URL, and no
// SDK logging (its debug log would print requests). Retries are off as well
// (`maxRetries: 0`): a 429 or a 529 is ONE recorded call, the file waits for the
// next run, and the reader's breaker sees every failure.
//
// ── THE KEY NEVER COMES BACK OUT ─────────────────────────────────────────────
//
// What this returns carries codes, token counts and the provider's request id;
// never an error message, a header or a body. So a refused key, a malformed
// request or a proxy echoing headers cannot put the key in a log line, a usage
// row or a file's status.
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import {
  DOCUMENT_TOOL_DESCRIPTION,
  DOCUMENT_TOOL_NAME,
  documentToolSchema,
} from "../../domain/fin/extraction";
import type { TransportFailure } from "../../domain/fin/extraction-usage";
import type {
  AnswerStop,
  DocumentExtractor,
  ExtractionAttempt,
  ExtractionContent,
  ExtractionRequest,
} from "../../usecase/fin/extract-ports";
import { PROMPT_VERSION, REQUEST_SETTINGS, SYSTEM_PROMPT, userInstruction } from "./claude-prompt";

/** The transport, as the SDK takes it; tests hand it recorded responses. */
export type ClaudeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClaudeExtractorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Absent in production (the SDK's own); a recorded transport in tests. */
  readonly fetch?: ClaudeFetch;
}

/** The API this sends to, stated rather than read from ANTHROPIC_BASE_URL. */
export const ANTHROPIC_API = "https://api.anthropic.com";

export class ClaudeExtractor implements DocumentExtractor {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: ClaudeExtractorOptions) {
    this.#model = options.model;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_API,
      webhookKey: null,
      timeout: options.timeoutMs,
      maxRetries: 0,
      logLevel: "off",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async extract(request: ExtractionRequest): Promise<ExtractionAttempt> {
    const params = this.params(request);
    let reply: { readonly data: unknown; readonly requestId: string | null };
    try {
      const { data, request_id } = await this.#client.messages.create(params).withResponse();
      reply = { data, requestId: request_id ?? null };
    } catch (err) {
      const failure = transportFailure(err);
      // Anything else came from this program, not from the provider, and is
      // not dressed up as an outage.
      if (failure === null) throw err;
      return this.failed(failure, err instanceof APIError ? (err.requestID ?? null) : null);
    }
    // A 200 that is not a message (a proxy's page, a garbled body) is the far
    // side's fault: one failed call, recorded, and the file waits.
    if (!isMessage(reply.data)) return this.failed("server_error", reply.requestId);
    return answered(reply.data, reply.requestId);
  }

  private failed(failure: TransportFailure, requestId: string | null): ExtractionAttempt {
    return { kind: "failed", model: this.#model, promptVersion: PROMPT_VERSION, requestId, failure };
  }

  private params(request: ExtractionRequest): Anthropic.MessageCreateParamsNonStreaming {
    const schema = documentToolSchema();
    return {
      model: this.#model,
      max_tokens: REQUEST_SETTINGS.maxTokens,
      // Thinking is left to its default, adaptive, on every model this is
      // built for (Sonnet 5.5 and Opus 5.5 refuse to turn it off); the effort
      // level is what bounds it.
      output_config: { effort: REQUEST_SETTINGS.effort },
      tools: [
        {
          name: DOCUMENT_TOOL_NAME,
          description: DOCUMENT_TOOL_DESCRIPTION,
          input_schema: {
            type: "object",
            properties: schema.properties,
            required: [...schema.required],
            additionalProperties: schema.additionalProperties,
          },
          strict: true,
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      // The cached prefix ends here: tools render first, then this, and both
      // are the same on every call.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            contentBlock(request.content),
            { type: "text", text: userInstruction(request.owner, request.correction) },
          ],
        },
      ],
    };
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function contentBlock(content: ExtractionContent): Anthropic.ContentBlockParam {
  if (content.kind === "pdf") {
    // Sent as a PDF, not rasterised: the provider reads each page as text AND
    // as an image, which is what a scanned page with a printed stamp needs.
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64(content.bytes) },
    };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: content.mediaType, data: base64(content.bytes) },
  };
}

/** Enough of a Messages API reply to read: content, usage and the model. */
function isMessage(data: unknown): data is Anthropic.Message {
  if (data === null || typeof data !== "object") return false;
  const m = data as { content?: unknown; usage?: unknown; model?: unknown };
  if (!Array.isArray(m.content) || typeof m.model !== "string") return false;
  if (m.usage === null || typeof m.usage !== "object") return false;
  const u = m.usage as { input_tokens?: unknown; output_tokens?: unknown };
  return typeof u.input_tokens === "number" && typeof u.output_tokens === "number";
}

function stopOf(message: Anthropic.Message): { readonly stop: AnswerStop; readonly output: unknown } {
  if (message.stop_reason === "refusal") return { stop: "refused", output: null };
  // A cut-off answer may hold half a tool call; it is not read, even if a
  // tool_use block is there.
  if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
    return { stop: "truncated", output: null };
  }
  const call = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === DOCUMENT_TOOL_NAME,
  );
  return call === undefined ? { stop: "no_tool_call", output: null } : { stop: "tool_call", output: call.input };
}

function answered(message: Anthropic.Message, requestId: string | null): ExtractionAttempt {
  const { stop, output } = stopOf(message);
  return {
    kind: "answered",
    model: message.model,
    promptVersion: PROMPT_VERSION,
    requestId,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
    stop,
    output,
  };
}

/**
 * The SDK's error as our transport code, or null for an error that is not the
 * provider's answer. Most specific first: a timeout IS a connection error in
 * the SDK's classes, and a connection error IS an `APIError`.
 */
export function transportFailure(err: unknown): TransportFailure | null {
  // A reply body that is not JSON: the SDK's parse of the far side's bytes.
  if (err instanceof SyntaxError) return "server_error";
  if (err instanceof APIConnectionTimeoutError) return "timeout";
  if (err instanceof APIConnectionError) return "connection";
  if (!(err instanceof APIError)) return null;
  const status: unknown = err.status;
  // No status is a request that never got an answer (an abort).
  if (typeof status !== "number") return "connection";
  if (status === 429) return "rate_limited";
  if (status === 529 || err.type === "overloaded_error") return "overloaded";
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 413) return "too_large";
  if (status >= 500) return "server_error";
  return "bad_request";
}
