// What every call to the AI reader costs, and how its answer is recorded
// (docs/FIN_BUILD_PLAN.md F2.4, migration 0389 `fin.extraction_usage`). Pure.
//
// ── EVERY CALL IS A ROW ──────────────────────────────────────────────────────
//
// The model, the prompt version and the tokens of every attempt, including the
// ones that failed and the retry, because "extraction got worse in March" and
// "why did this firm's bill double" are both answered from that table and from
// nothing else. The vocabularies below are the table's CHECKs, written once.
//
// ── THE BUDGET UNIT ──────────────────────────────────────────────────────────
//
// A firm's monthly budget is counted in INPUT-TOKEN EQUIVALENTS, not in money
// and not in raw tokens. Money would need a price table this product would have
// to keep current, per model; raw tokens would count an output token (five
// times the price) the same as an input one, and a cache read (a tenth) the
// same too, so caching would look like spending. The weights below are
// Anthropic's own price ratios and they hold for every current model, so the
// budget moves with what is actually spent whichever model the scorecard picks,
// and it converts to money by one multiplication: by that model's input price.

/** What one attempt came back as. `transport_error` means no answer at all;
 *  the four between mean the model answered but not with a usable reading. */
export const USAGE_OUTCOMES = [
  "ok",
  "invalid_output",
  "no_tool_call",
  "truncated",
  "refused",
  "transport_error",
] as const;

export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

/**
 * Why a call got no answer. Our codes, never the SDK's classes: the adapter
 * translates at the door (CLAUDE.md, "no vendor type crosses a port").
 *
 * - `rate_limited` (429), `overloaded` (529), `server_error` (other 5xx),
 *   `timeout` and `connection` are the provider's trouble: the file waits and is
 *   offered again next run, and enough of them in a row open the breaker.
 * - `auth` (401, 402, 403) will fail every call, so it opens the breaker at once.
 * - `bad_request` (400, 404, 409, 422) is most often OUR request or the model
 *   name, which fails every call, so it counts toward the breaker; a file the
 *   provider refuses while it reads others goes to a person (see the reader).
 * - `too_large` (413) is about this file alone, and goes to a person.
 */
export const TRANSPORT_FAILURES = [
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "connection",
  "auth",
  "bad_request",
  "too_large",
] as const;

export type TransportFailure = (typeof TRANSPORT_FAILURES)[number];

/** Tokens as the provider reported them for one call. Cache writes and reads
 *  are counted apart from `inputTokens`, as the Messages API reports them. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export const NO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/** Anthropic's price ratios, in units of one input token. A cache write is at
 *  the five-minute rate (the only one the reader uses); a cache read is 0.1 or
 *  less on every current model, so 0.1 errs on the side of spending less. */
export const TOKEN_WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

/** One call (or a month of them) in input-token equivalents, rounded up: the
 *  budget is a ceiling, so a fraction is never given away. */
export function weighedTokens(u: TokenUsage): number {
  return Math.ceil(
    u.inputTokens * TOKEN_WEIGHTS.input +
      u.cacheWriteTokens * TOKEN_WEIGHTS.cacheWrite +
      u.cacheReadTokens * TOKEN_WEIGHTS.cacheRead +
      u.outputTokens * TOKEN_WEIGHTS.output,
  );
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

// ── What is sent, and the limits on it ───────────────────────────────────────

/**
 * The longest edge an image is shrunk to before it is sent. 2048 px keeps the
 * small print of a thermal receipt legible (it is what a person zooming in
 * would need), stays under the 2576 px the current models read without
 * rescaling, so the model sees exactly the pixels that were billed, and is
 * about 4,000 image tokens at a phone photo's 4:3. A full-resolution phone
 * photo (4000 px) would be downscaled by the provider anyway, after the bytes
 * were sent.
 */
export const VISION_MAX_EDGE = 2048;

/** The provider's limit on one image, after shrinking (base64 is counted
 *  separately, on the request). A normalised receipt is well under 1 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The largest PDF sent as it is. The provider takes 32 MB per REQUEST and the
 * PDF travels as base64 (a third larger), so 20 MB leaves room for the prompt.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * The most pages one file may have for the AI reader. It reads ONE document per
 * file, and an invoice or a receipt is one to three pages (a long telco bill
 * perhaps a dozen); a longer file is a bundle or a statement a person should
 * split, and each page costs 1,500 to 3,000 tokens whether or not it says
 * anything. Checked only where a page counter is wired.
 */
export const MAX_PDF_PAGES = 20;
