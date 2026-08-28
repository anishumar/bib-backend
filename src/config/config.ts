// Package config: the environment is an external system, and this is its
// adapter. Nothing else in the codebase reads process.env — the ESLint rule
// `no-restricted-properties` makes that a build error outside this directory.
//
// Load once, validate before boot (see validate.ts), hand typed values to the
// composition root. usecase and domain never see this module at all.
//
// dotenv is imported here — and ONLY here — so loading the .env file is part of
// the environment adapter. A missing .env is not an error: in production the
// environment is the source and there is no file.
import "dotenv/config";
import { z } from "zod";
import { CAPABILITIES } from "../api/capabilities";
import type { InternalClient } from "../api/capabilities";

const EnvSchema = z.object({
  BIB_ENVIRONMENT: z.enum(["development", "qa", "uat", "production"]).default("development"),
  BIB_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BIB_PORT: z.coerce.number().int().positive().default(8080),
  BIB_DATABASE_URL: z.string().min(1),
  BIB_APP_DATABASE_URL: z.string().min(1),
  BIB_DB_POOL_APP: z.coerce.number().int().positive().default(10),
  BIB_DB_POOL_OWNER: z.coerce.number().int().positive().default(2),
  // Serve the OpenAPI spec + Swagger UI. Unset ⇒ on for local dev, off for
  // production-like — the spec lists every endpoint, so a public environment
  // opts in explicitly rather than leaking it by default.
  BIB_DOCS_ENABLED: z.enum(["true", "false"]).optional(),

  // ── Auth (T1.7) ───────────────────────────────────────────────────────────
  BIB_SESSION_COOKIE_NAME: z.string().min(1).default("bib_session"),
  // Unset ⇒ on for production-like, off locally (a Secure cookie is dropped by
  // the browser over plain http, which would silently break local development).
  BIB_SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Where a magic link sends the user: the FRONTEND's redemption page, not this
  // API. Two different origins, so it cannot be inferred from the request.
  BIB_APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  // The honest registry, as a switch. When on, the dev x-user-id header is
  // accepted as a principal. validate.ts refuses it in production-like.
  BIB_DEV_AUTH_ENABLED: z.enum(["true", "false"]).optional(),
  // Only 'log' is implemented — it writes the magic link to the log instead of
  // sending it. The enum grows when a real transport lands; production-like
  // refuses to boot on 'log'.
  BIB_MAIL_TRANSPORT: z.enum(["log"]).default("log"),
  // The provisioning callers, as JSON: [{name, key, capabilities[]}]. Each
  // caller has its OWN key carrying only what it needs — one key that opens
  // every route is an escalation path (create a user, grant them partner, set
  // their password, sign in as them). No default and no optionality: an unset
  // value would mean the provisioning API is open, and that is not a state
  // this process may boot in.
  BIB_INTERNAL_KEYS: z.string().min(1),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Whether X-Forwarded-For may be believed. Must match the deployment: behind
  // a load balancer, off means every client shares the balancer's address and
  // one bucket throttles everyone; with no proxy in front, ON lets any client
  // invent its own key and opt out of rate limiting entirely.
  BIB_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  BIB_RATELIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  BIB_RATELIMIT_GENERAL_PER_MINUTE: z.coerce.number().int().positive().default(300),

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Which browser origins may call the API. Comma-separated, exact matches
  // only. Unset falls back to BIB_APP_BASE_URL — the app that receives magic
  // links is the app that calls the API, so one origin covers both by default.
  BIB_CORS_ORIGINS: z.string().optional(),
});

export type Environment = z.infer<typeof EnvSchema>["BIB_ENVIRONMENT"];

export interface DbConfig {
  readonly ownerUrl: string;
  readonly appUrl: string;
  /** Parsed out of appUrl so cmd/migrate can set the role's password. */
  readonly appPassword: string;
  readonly appPoolSize: number;
  readonly ownerPoolSize: number;
}

export interface AuthConfig {
  readonly sessionCookieName: string;
  readonly sessionCookieSecure: boolean;
  /** Base URL of the frontend, used to build magic links. */
  readonly appBaseUrl: string;
  /** Whether the dev x-user-id principal resolver is registered. */
  readonly devAuthEnabled: boolean;
  readonly mailTransport: "log";
  /** The provisioning callers. Each key carries only its own capabilities. */
  readonly internalClients: readonly InternalClient[];
}

export interface CorsConfig {
  /** Exact origins allowed to send credentialed requests. Never a wildcard. */
  readonly origins: readonly string[];
}

export interface RateLimitConfig {
  readonly trustProxy: boolean;
  /** Per client, per minute, on the unauthenticated sign-in routes. */
  readonly authPerMinute: number;
  /** Per client, per minute, everywhere else. */
  readonly generalPerMinute: number;
}

export interface Config {
  readonly environment: Environment;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly port: number;
  readonly db: DbConfig;
  /** Whether to serve the OpenAPI spec and Swagger UI. */
  readonly docsEnabled: boolean;
  readonly auth: AuthConfig;
  readonly rateLimit: RateLimitConfig;
  readonly cors: CorsConfig;
}

/**
 * Load configuration from the environment. Throws — with an actionable message
 * naming the offending variables — if anything required is missing or malformed.
 * A process that cannot be configured must fail here, at boot, not at 3 a.m.
 */
export function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  let appPassword: string;
  try {
    appPassword = new URL(env.BIB_APP_DATABASE_URL).password;
  } catch {
    throw new Error("BIB_APP_DATABASE_URL is not a valid postgres URL");
  }

  // production/uat/qa are public and count as production-like (mirrors
  // isProductionLike, computed here from the raw env before Config exists).
  const productionLike =
    env.BIB_ENVIRONMENT === "production" ||
    env.BIB_ENVIRONMENT === "uat" ||
    env.BIB_ENVIRONMENT === "qa";
  const docsEnabled =
    env.BIB_DOCS_ENABLED !== undefined ? env.BIB_DOCS_ENABLED === "true" : !productionLike;

  return {
    environment: env.BIB_ENVIRONMENT,
    logLevel: env.BIB_LOG_LEVEL,
    port: env.BIB_PORT,
    docsEnabled,
    auth: {
      sessionCookieName: env.BIB_SESSION_COOKIE_NAME,
      sessionCookieSecure:
        env.BIB_SESSION_COOKIE_SECURE !== undefined
          ? env.BIB_SESSION_COOKIE_SECURE === "true"
          : productionLike,
      appBaseUrl: env.BIB_APP_BASE_URL,
      devAuthEnabled:
        env.BIB_DEV_AUTH_ENABLED !== undefined
          ? env.BIB_DEV_AUTH_ENABLED === "true"
          : !productionLike,
      mailTransport: env.BIB_MAIL_TRANSPORT,
      internalClients: parseInternalClients(env.BIB_INTERNAL_KEYS),
    },
    cors: {
      origins:
        env.BIB_CORS_ORIGINS === undefined
          ? [env.BIB_APP_BASE_URL]
          : env.BIB_CORS_ORIGINS.split(",")
              .map((o) => o.trim())
              .filter((o) => o !== ""),
    },
    rateLimit: {
      trustProxy: env.BIB_TRUST_PROXY === "true",
      authPerMinute: env.BIB_RATELIMIT_AUTH_PER_MINUTE,
      generalPerMinute: env.BIB_RATELIMIT_GENERAL_PER_MINUTE,
    },
    db: {
      ownerUrl: env.BIB_DATABASE_URL,
      appUrl: env.BIB_APP_DATABASE_URL,
      appPassword,
      appPoolSize: env.BIB_DB_POOL_APP,
      ownerPoolSize: env.BIB_DB_POOL_OWNER,
    },
  };
}

const InternalClientsSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      key: z.string().min(32, "each internal key must be at least 32 characters"),
      capabilities: z.array(z.enum(CAPABILITIES as [string, ...string[]])).min(1),
    }),
  )
  .min(1, "at least one provisioning client must be configured");

/** Parses BIB_INTERNAL_KEYS. A malformed value here means the provisioning
 *  surface cannot be authorized, so it fails at boot rather than defaulting to
 *  anything — there is no safe default for "who may create firms". */
function parseInternalClients(raw: string): readonly InternalClient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `BIB_INTERNAL_KEYS is not valid JSON. Expected ` +
        `[{"name":"ops","key":"<32+ chars>","capabilities":["tenant.provision"]}] — ` +
        `known capabilities: ${CAPABILITIES.join(", ")}`,
    );
  }
  const result = InternalClientsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(`BIB_INTERNAL_KEYS is invalid:\n${issues}`);
  }
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const client of result.data) {
    if (names.has(client.name)) throw new Error(`BIB_INTERNAL_KEYS: duplicate client name ${client.name}`);
    if (keys.has(client.key)) {
      throw new Error(
        `BIB_INTERNAL_KEYS: two clients share a key, so the audit trail cannot tell them apart`,
      );
    }
    names.add(client.name);
    keys.add(client.key);
  }
  return result.data as readonly InternalClient[];
}

/** Real auth + secrets are mandatory here. QA and UAT are public, so they count
 *  as production — an empty secret there is as dangerous as in prod. The
 *  environment label is a security control, not a log field. */
export function isProductionLike(cfg: Config): boolean {
  return (
    cfg.environment === "production" ||
    cfg.environment === "uat" ||
    cfg.environment === "qa"
  );
}

/** A log-safe view: never log the Config wholesale — connection URLs carry
 *  passwords. Log this instead. */
export function redacted(cfg: Config): Record<string, unknown> {
  return {
    environment: cfg.environment,
    logLevel: cfg.logLevel,
    port: cfg.port,
    docsEnabled: cfg.docsEnabled,
    // The internal key is a credential; redacted() exists so a config dump is
    // safe to log, and this is exactly the field that would make it unsafe.
    // Every key is a credential; redacted() exists so a config dump is safe to
    // log, and these are exactly the fields that would make it unsafe.
    auth: {
      ...cfg.auth,
      internalClients: cfg.auth.internalClients.map((c) => ({
        name: c.name,
        key: "***",
        capabilities: c.capabilities,
      })),
    },
    rateLimit: cfg.rateLimit,
    cors: cfg.cors,
    db: {
      ownerUrl: maskUrl(cfg.db.ownerUrl),
      appUrl: maskUrl(cfg.db.appUrl),
      appPoolSize: cfg.db.appPoolSize,
      ownerPoolSize: cfg.db.ownerPoolSize,
    },
  };
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "***";
  }
}
