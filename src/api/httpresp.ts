// The error-envelope shape, written in exactly one place so every route fails
// the same way: {"error":{code, reason?, message}}.
import type { ErrorCode, MappedError } from "./domainerr";

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly reason?: string;
  };
}

export function toEnvelope(m: MappedError): ErrorEnvelope {
  return {
    error: m.reason === undefined
      ? { code: m.code, message: m.message }
      : { code: m.code, message: m.message, reason: m.reason },
  };
}

/**
 * The headers an error answer carries beside its envelope. Today only
 * `Retry-After`, on an answer that will pass by waiting (503 `UNAVAILABLE`).
 * One function, so the router and a test that stands in for it send the same
 * headers; CORS already exposes `Retry-After` to the browser (router.ts).
 */
export function errorHeaders(m: MappedError): Record<string, string> {
  return m.retryAfterSeconds === undefined ? {} : { "Retry-After": String(m.retryAfterSeconds) };
}
