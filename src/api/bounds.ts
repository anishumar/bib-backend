// The ceilings every request string is measured against.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The 5 September audit counted about 515 request string fields with no
// `.max()` — titles, descriptions, note bodies, prompts. Each one is a row an
// authenticated user can grow without limit, and there was no ceiling at any
// layer below them either: no body limit, so a single request could carry
// whatever the process would buffer.
//
// The body limit in `router.ts` is the floor of this defence and it does most
// of the work: nothing can arrive that is larger than the whole body. This file
// is the second half — a bound on any ONE string, so a caller cannot spend the
// entire body allowance on a single `note` and store it.
//
// It is enforced two ways, on purpose:
//
//   * `boundedStrings()` walks every JSON body and refuses an over-long string
//     wherever it appears. One control, no schema to remember, and it covers
//     routes nobody has written yet — the same argument the prefix auth guards
//     make for themselves.
//
//   * The named constants below are used in the schemas where the limit is a
//     PRODUCT fact rather than a safety net — a password, an email address, a
//     token — because those want to be in the OpenAPI spec so the frontend's
//     generated client knows them.
//
// The generic bound is deliberately generous. It is not a validation rule about
// what a title should look like; it is the point past which a string is not
// data any more.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./guards";
import { toEnvelope } from "./httpresp";

/** The longest any single string in a JSON request body may be. Roughly
 *  twenty-five pages of prose — past anything a person types into this product
 *  and far short of what the body limit allows. */
export const MAX_FIELD_CHARS = 50_000;

/** How deep a JSON body may nest. A guard against a body whose only cost is its
 *  shape: deeply nested arrays are cheap to write and expensive to walk. */
const MAX_BODY_DEPTH = 32;

/** An email address. RFC 5321 caps a path at 254 octets, and nothing this
 *  product stores comes close. */
export const MAX_EMAIL_LENGTH = 254;

/** A magic-link, invite or share token. Every one this server issues is a
 *  256-bit value in base64url — 43 characters. The cap leaves room for a format
 *  change and refuses anything that is plainly not one of ours. */
export const MAX_TOKEN_LENGTH = 512;

/**
 * Refuse a JSON body carrying a string longer than `MAX_FIELD_CHARS`, or
 * nested deeper than the product ever nests.
 *
 * Only JSON. Multipart bodies are the upload routes, whose size is bounded by
 * `BIB_MAX_UPLOAD_BYTES` at the edge and checked again by the store; walking
 * one here would mean parsing a scanned PDF to look at its text fields.
 *
 * `c.req.json()` caches its result on the request, so the validator that runs
 * next reads the parsed body rather than a consumed stream. A body that is not
 * valid JSON is left alone: the route's own validator produces the 400 for
 * that, with the message it already has.
 */
export function boundedStrings(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().includes("application/json")) {
      await next();
      return undefined;
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // Not JSON, or empty. The route's validator answers that.
      await next();
      return undefined;
    }
    const offence = firstOffence(body, 0);
    if (offence !== null) {
      return c.json(
        toEnvelope({ status: 400, code: "VALIDATION", message: offence }),
        400,
      );
    }
    await next();
    return undefined;
  };
}

/** The first thing wrong with this body, as the sentence to answer with, or
 *  null. Iterative in spirit but written recursively with an explicit depth
 *  budget, which is what stops a hostile shape recursing without limit. */
function firstOffence(value: unknown, depth: number): string | null {
  if (depth > MAX_BODY_DEPTH) {
    return `the request body nests deeper than ${String(MAX_BODY_DEPTH)} levels`;
  }
  if (typeof value === "string") {
    return value.length > MAX_FIELD_CHARS
      ? `a field in the request body is longer than the ${String(MAX_FIELD_CHARS)} characters this API stores`
      : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const offence = firstOffence(item, depth + 1);
      if (offence !== null) return offence;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key.length > MAX_FIELD_CHARS) {
        return `a field NAME in the request body is longer than the ${String(MAX_FIELD_CHARS)} characters this API stores`;
      }
      const offence = firstOffence(item, depth + 1);
      if (offence !== null) return offence;
    }
  }
  return null;
}
