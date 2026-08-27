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

export interface Config {
  readonly environment: Environment;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly port: number;
  readonly db: DbConfig;
  /** Whether to serve the OpenAPI spec and Swagger UI. */
  readonly docsEnabled: boolean;
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
    db: {
      ownerUrl: env.BIB_DATABASE_URL,
      appUrl: env.BIB_APP_DATABASE_URL,
      appPassword,
      appPoolSize: env.BIB_DB_POOL_APP,
      ownerPoolSize: env.BIB_DB_POOL_OWNER,
    },
  };
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
