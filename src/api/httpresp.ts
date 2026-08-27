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
