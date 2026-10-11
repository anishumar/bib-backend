// The OpenAPI seam. `@hono/zod-openapi` re-exports a `z` extended with a
// `.openapi()` method; every schema in the api layer imports `z` FROM HERE, so
// the same zod object that validates a request also describes it in the spec —
// one source of truth, no hand-written swagger.yaml to drift.
//
// This is transport, not business: it lives in api/, describes the wire, and is
// invisible to usecase and domain. Swapping to a gRPC edge would delete this
// file and nothing inward would notice.
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES } from "./domainerr";
import { toEnvelope } from "./httpresp";
import type { AppEnv } from "./guards";

export { z };

/** The one error shape, as a schema — the runtime twin of ErrorEnvelope in
 *  httpresp.ts, so every documented failure matches what the code actually
 *  returns. */
export const ErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      reason: z.string().optional(),
    }),
  })
  .openapi("ErrorEnvelope");

/** A standard error response entry for a route's `responses` map. */
export function errorResponse(description: string): {
  description: string;
  content: { "application/json": { schema: typeof ErrorEnvelopeSchema } };
} {
  return {
    description,
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  };
}

/** The `Retry-After` header a 503 carries, in seconds (`errorHeaders`). */
const RetryAfterHeaders = z.object({
  "Retry-After": z.string().openapi({
    description: "How many seconds to wait before asking again.",
    example: "30",
  }),
});

/**
 * A 503 entry: the error envelope, code `UNAVAILABLE`, plus `Retry-After`. For a
 * route whose stage of the product can stop answering while the rest works
 * (FinCompliance, F0.6), so the generated client knows the status exists.
 */
export function unavailableResponse(description: string): {
  description: string;
  headers: typeof RetryAfterHeaders;
  content: { "application/json": { schema: typeof ErrorEnvelopeSchema } };
} {
  return {
    description,
    headers: RetryAfterHeaders,
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  };
}

/**
 * The app factory. Its `defaultHook` is the whole reason validation stays
 * honest: when the framework rejects a request against a route's schema, the
 * failure is mapped to the SAME envelope every other error uses, rather than
 * emitting Hono's default shape. So adopting OpenAPI added zero new error
 * formats — there is still exactly one.
 */
export function createOpenAPIApp(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const reason = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return c.json(
          toEnvelope({
            status: 400,
            code: "VALIDATION",
            message: "request failed validation",
            reason,
          }),
          400,
        );
      }
      return undefined;
    },
  });
}
