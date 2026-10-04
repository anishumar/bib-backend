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
  // NO DEFAULT, and that is the whole point of this line.
  //
  // It defaulted to `development`, which is not a neutral value: it is the one
  // that turns ON trusting an `x-user-id` header as proof of identity, serves
  // the OpenAPI spec, drops `Secure` from the session cookie and accepts the
  // mailer that prints sign-in links to the log. A deployment that forgot this
  // one variable got all of that, silently, and every other check in
  // `validate.ts` is gated on this value so none of them would fire either.
  //
  // Defaults are for things whose absence is harmless. The environment label is
  // a security control — `isProductionLike` reads it — so an unset one is a
  // question nobody answered, and the honest response to that is to refuse to
  // boot and say which variable is missing. Local work sets it in `.env`; the
  // example file carries it too.
  BIB_ENVIRONMENT: z.enum(["development", "qa", "uat", "production"], {
    required_error:
      "BIB_ENVIRONMENT is not set. It decides whether dev header auth, the docs, an " +
      "insecure cookie and the logging mailer are allowed, so there is no safe default: " +
      "set it to development, qa, uat or production.",
  }),
  BIB_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BIB_PORT: z.coerce.number().int().positive().default(8080),
  BIB_DATABASE_URL: z.string().min(1),
  BIB_APP_DATABASE_URL: z.string().min(1),
  BIB_DB_POOL_APP: z.coerce.number().int().positive().default(10),
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
  // Which mailer is registered. 'log' writes the magic link to the log instead
  // of sending it and production-like refuses to boot on it; 'smtp' is the real
  // one and carries whatever provider the firm already has — Google Workspace,
  // Microsoft 365, SES or Postmark all speak it, which is why ONE adapter is
  // enough and no vendor is named here.
  BIB_MAIL_TRANSPORT: z.enum(["log", "smtp"]).default("log"),
  // ── What the letters come FROM, and how they reach the server ────────────
  //
  // Optional in the SCHEMA and required by `validate.ts` when the transport is
  // 'smtp', because "which transport" and "is that transport configured" are
  // different failures and only the second can name the missing variable.
  //
  // The From address is not cosmetic: a portal invite arrives unasked, from a
  // firm the reader may not be expecting mail from, so it has to be an address
  // at a domain the client recognises or the letter reads as phishing.
  BIB_MAIL_FROM: z.string().email().optional(),
  BIB_MAIL_FROM_NAME: z.string().min(1).optional(),
  BIB_SMTP_HOST: z.string().min(1).optional(),
  // 587 is submission-with-STARTTLS, which is what every provider above wants.
  // 465 is implicit TLS and is the one case `secure` defaults to true for.
  BIB_SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  BIB_SMTP_USER: z.string().min(1).optional(),
  BIB_SMTP_PASSWORD: z.string().min(1).optional(),
  // NEVER `z.coerce.boolean()` — `Boolean("false")` is true, and this one
  // decides whether the connection is encrypted from the first byte.
  BIB_SMTP_SECURE: z.enum(["true", "false"]).optional(),
  // How an engagement letter gets signed. Only `attested` exists — a person at
  // the firm records that the client signed, on paper or in a provider the firm
  // already uses. It records an assertion, not a signature, so a production-like
  // environment refuses to boot on it (validate.ts). A real provider adapter
  // becomes a second value here.
  // SameSite for the session cookie. Lax is right when the app and the API
  // share a registrable domain, and is the DEFAULT because that is the intended
  // deployment.
  //
  // It stops working — silently, and only in a browser — the moment they do
  // not. Cloud Run's *.run.app is on the Public Suffix List, so
  // two services under it are different SITES, not merely different origins:
  // the browser never attaches the cookie to the API call,
  // every request arrives anonymous, and the app shows "no authenticated
  // session" immediately after a login that returned 200 and a Set-Cookie.
  //
  // api/origin.ts already anticipated this and says so: the ORIGIN guard is
  // "the half that survives a deployment change" and does not depend on
  // SameSite, so raising this to None does not leave CSRF undefended.
  BIB_SESSION_COOKIE_SAMESITE: z.enum(["Lax", "None"]).default("Lax"),
  BIB_ESIGN_PROVIDER: z.enum(["attested", "docusign"]).default("attested"),
  // ── DocuSign (JWT Grant) ──────────────────────────────────────────────────
  // Optional HERE and checked where the signer is CONSTRUCTED, in setup/server.
  // The reason is least privilege: the worker runs the same validateServer and
  // must therefore set BIB_ESIGN_PROVIDER to something non-stub to boot, but it
  // never signs anything — setup/worker.ts constructs no signer at all. Demanding
  // these in the schema would hand the worker a private key it has no use for,
  // which is exactly the secret sprawl the internal-key split exists to prevent.
  // MUST carry the scheme: the transport does `new URL(oauthBase).host` to build
  // the JWT's `aud`, and a bare host throws there. `.url()` refuses one at boot
  // with a readable message instead of at the first signature with a stack trace.
  BIB_DOCUSIGN_OAUTH_BASE: z.string().url().default("https://account.docusign.com"),
  BIB_DOCUSIGN_INTEGRATION_KEY: z.string().min(1).optional(),
  BIB_DOCUSIGN_USER_ID: z.string().min(1).optional(),
  // Null is a real answer: the adapter discovers the account and its base URI
  // from userinfo when this is unset, which is the ordinary single-account case.
  BIB_DOCUSIGN_ACCOUNT_ID: z.string().min(1).optional(),
  BIB_DOCUSIGN_PRIVATE_KEY: z.string().min(1).optional(),
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
  // HOW MANY proxies, when they are trusted. X-Forwarded-For is a list the
  // client starts and each hop appends to, so the only entries that mean
  // anything are the right-hand ones a proxy wrote. This says how far in from
  // that end the real client is. One load balancer is 1; a CDN in front of one
  // is 2. Too high hands the key back to the caller — see api/ratelimit.ts.
  BIB_TRUSTED_PROXY_HOPS: z.coerce.number().int().positive().max(10).default(1),
  // ── the worker (T2.6) ──
  // A cron expression rather than an interval, because "every day at 06:00 in
  // the firm's morning" is a business cadence and an interval drifts. Default
  // hourly: the spawn sweep only has to be finer than the lead times it feeds,
  // and an hour costs one query per firm.
  BIB_WORKER_SPAWN_CRON: z.string().min(1).default("0 * * * *"),
  // DAILY, unlike the spawn sweep's hourly. The ladder's rungs are counted in
  // DAYS, so sweeping more often re-reads the same answer and buys nothing —
  // and the one thing it could buy, a reminder arriving at 3am, is not wanted.
  BIB_WORKER_DUNNING_CRON: z.string().min(1).default("0 7 * * *"),
  // HOURLY (0322), at five past. The weekly summary of pending advances goes
  // out at each FIRM's own weekday and hour in its own zone (Your firm), so the
  // sweep has to look every hour; for every firm whose slot has not come, or
  // whose week is already sent, it does nothing.
  BIB_WORKER_ADVANCE_DIGEST_CRON: z.string().min(1).default("5 * * * *"),
  // EVERY MINUTE (0323): the notification outbox reads each firm's new ledger
  // events. The bell is how a colleague learns a task landed on them, and a
  // minute is the finest pg-boss cron there is. A run with nothing new is one
  // indexed read per firm.
  BIB_WORKER_NOTIFY_CRON: z.string().min(1).default("* * * * *"),
  // EVERY FIVE MINUTES, and much finer than the other two on purpose. This one
  // is not a clock-driven policy — it is the engine noticing that work became
  // ready, and the person waiting on the next step is a colleague at their desk.
  // An hour here would mean a filing sitting done while nobody is told the
  // review may start. The sweep is cheap: one indexed read per firm, over the
  // partial index that excludes finished jobs.
  BIB_WORKER_ORCHESTRATOR_CRON: z.string().min(1).default("*/5 * * * *"),
  // ONCE A DAY, not every five minutes. A statutory due date does not move
  // between breakfast and lunch, and the sweep materialises a YEAR ahead — so
  // running it hourly would re-propose thousands of rows the unique key would
  // reject, to discover nothing. 02:15 is after midnight in every Indian time
  // zone offset, so "today" has actually rolled over.
  BIB_WORKER_OBLIGATION_CRON: z.string().min(1).default("15 2 * * *"),
  // DAILY, and EARLY — 06:15, before the compliance sweep's own 02:15 has been
  // acted on by anybody and while there is still a working day left to do
  // something about what it says. The ladder counts in days like the dunning
  // one, so sweeping more often re-reads the same answer; the one thing it
  // could buy is a partner woken at 3am, which is not wanted.
  BIB_WORKER_ESCALATION_CRON: z.string().min(1).default("15 6 * * *"),
  // How long a shutdown waits for a sweep already in flight. Long enough for the
  // slowest one, finite so a wedged handler cannot hold a deploy open forever.
  BIB_WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(45_000),
  BIB_RATELIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  BIB_RATELIMIT_GENERAL_PER_MINUTE: z.coerce.number().int().positive().default(300),

  // ── Document storage (T3.6) ───────────────────────────────────────────────
  // Where uploaded bytes live. The filesystem adapter is a STUB — per-pod and
  // not restart-safe — and validateServer refuses a production-like boot with
  // it, so this default is a local-development convenience and nothing more.
  BIB_STORAGE_BACKEND: z.enum(["filesystem", "gcs"]).default("filesystem"),
  // The bucket is optional for the same reason the DocuSign keys are: the worker
  // must name a non-stub backend to pass validateServer, yet constructs no blob
  // store. setup/server checks it when it builds the adapter.
  BIB_GCS_BUCKET: z.string().min(1).optional(),
  BIB_GCS_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  BIB_STORAGE_ROOT: z.string().min(1).default(".data/blobs"),
  // The largest file the store accepts. A MEMORY BUDGET, not a preference: the
  // whole file is held in memory to be hashed before it is written, so this is
  // what one upload request can cost the process. 25 MB fits a scanned
  // multi-page PDF, which is what this product actually receives.
  BIB_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Which browser origins may call the API. Comma-separated, exact matches
  // only. Unset falls back to BIB_APP_BASE_URL — the app that receives magic
  // links is the app that calls the API, so one origin covers both by default.
  BIB_CORS_ORIGINS: z.string().optional(),

  // ── Which build is running (V0.2) ─────────────────────────────────────────
  // Stamped into the image by the Dockerfile from its COMMIT_SHA and BUILD_TIME
  // build args, and reported by GET /health, so "which commit is QA on, and did
  // that migration go out" is answered by asking the API rather than a person.
  // Unset locally, and an image built without the args (`gcloud builds submit
  // --tag`) has them EMPTY, not absent: Docker turns an ARG with no value into
  // an empty ENV. Both read as "not stamped" and /health says null, never a
  // guessed value. A value that is present must be well-formed, so a garbled
  // stamp fails the boot instead of reporting a SHA nobody can check out.
  BIB_BUILD_COMMIT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, "a git commit SHA: 7 to 40 lowercase hex characters")
      .optional(),
  ),
  BIB_BUILD_TIME: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().datetime({ message: "an ISO-8601 UTC instant, e.g. 2026-09-28T18:30:00Z" }).optional(),
  ),
});

export type Environment = z.infer<typeof EnvSchema>["BIB_ENVIRONMENT"];

export interface DbConfig {
  readonly ownerUrl: string;
  readonly appUrl: string;
  /** Parsed out of appUrl so cmd/migrate can set the role's password. */
  readonly appPassword: string;
  readonly appPoolSize: number;
}

export interface AuthConfig {
  readonly sessionCookieName: string;
  readonly sessionCookieSecure: boolean;
  /** SameSite for the session cookie. `None` is required when the app and the
   *  API are on different registrable domains, and demands Secure. */
  readonly sessionCookieSameSite: "Lax" | "None";
  /** Base URL of the frontend, used to build magic links. */
  readonly appBaseUrl: string;
  /** Whether the dev x-user-id principal resolver is registered. */
  readonly devAuthEnabled: boolean;
  readonly mailTransport: "log" | "smtp";
  readonly esignProvider: "attested" | "docusign";
  /** The provisioning callers. Each key carries only its own capabilities. */
  readonly internalClients: readonly InternalClient[];
}

/** How the server reaches an SMTP relay. Null when no host is configured. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (465). False means STARTTLS on 587/25 —
   *  which nodemailer still upgrades; it is not "unencrypted". */
  readonly secure: boolean;
  /** Null is a real answer: a relay on a private network may take no login. */
  readonly user: string | null;
  readonly password: string | null;
}

export interface MailConfig {
  /** The envelope and header From. Null until somebody sets it — `validate.ts`
   *  refuses a real transport without one, because a letter from a stranger's
   *  domain is one a client is right to distrust. */
  readonly from: string | null;
  /** The display name beside it — the FIRM's name is not usable here: one
   *  server serves every tenant, and the letter names the firm in its own
   *  text instead. */
  readonly fromName: string | null;
  readonly smtp: SmtpConfig | null;
}

/** Which build this process is (V0.2). Null when the image was not stamped. */
export interface BuildConfig {
  readonly commit: string | null;
  /** When the image was built, as an ISO-8601 UTC instant. */
  readonly builtAt: string | null;
}

export interface CorsConfig {
  /** Exact origins allowed to send credentialed requests. Never a wildcard. */
  readonly origins: readonly string[];
}

export interface RateLimitConfig {
  readonly trustProxy: boolean;
  /** How many trusted proxies stand in front. Only read when trustProxy. */
  readonly trustedProxyHops: number;
  /** Per client, per minute, on the unauthenticated sign-in routes. */
  readonly authPerMinute: number;
  /** Per client, per minute, everywhere else. */
  readonly generalPerMinute: number;
}

export interface StorageConfig {
  /** Which blob adapter is registered. `filesystem` is a stub — see the honest
   *  registry check in validate.ts. */
  readonly backend: "filesystem" | "gcs";
  /** Root directory for the filesystem adapter. */
  readonly root: string;
  /** Bucket for the gcs adapter. Null when the backend is not `gcs`. */
  readonly bucket: string | null;
  /** How long one GCS call may take before it is abandoned. */
  readonly timeoutMs: number;
  /** Largest accepted upload, in bytes. A memory budget. */
  readonly maxUploadBytes: number;
}

/** DocuSign's JWT Grant credentials, as configured. Every field but the OAuth
 *  host is nullable because only the API process signs; see BIB_ESIGN_PROVIDER. */
export interface DocusignConfig {
  readonly oauthBase: string;
  readonly integrationKey: string | null;
  readonly userId: string | null;
  readonly accountId: string | null;
  readonly privateKeyPem: string | null;
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
  readonly build: BuildConfig;
  readonly worker: WorkerConfig;
  readonly storage: StorageConfig;
  readonly docusign: DocusignConfig;
  readonly mail: MailConfig;
}

export interface WorkerConfig {
  /** When the spawn sweep runs. A cron expression, not an interval. */
  readonly spawnCron: string;
  /** How often the dunning ladder is climbed. Daily by default: the rungs are
   *  counted in DAYS, so sweeping more often only re-reads the same answer. */
  readonly dunningCron: string;
  /** When the weekly advance summary looks for firms whose slot has come
   *  (0322). Hourly: each firm chooses its own weekday and hour. */
  readonly advanceDigestCron: string;
  /** How often the notification outbox reads the ledger (0323). Every minute. */
  readonly notifyCron: string;
  readonly orchestratorCron: string;
  readonly obligationCron: string;
  /** When the escalation ladder is climbed (T4.5). Daily: the rungs are
   *  counted in DAYS, so a finer cadence re-reads the same answer. */
  readonly escalationCron: string;
  /** How long `stop()` waits for work in flight before the hard stop. */
  readonly shutdownGraceMs: number;
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
      sessionCookieSameSite: env.BIB_SESSION_COOKIE_SAMESITE,
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
      esignProvider: env.BIB_ESIGN_PROVIDER,
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
    build: {
      commit: env.BIB_BUILD_COMMIT ?? null,
      builtAt: env.BIB_BUILD_TIME ?? null,
    },
    rateLimit: {
      trustProxy: env.BIB_TRUST_PROXY === "true",
      trustedProxyHops: env.BIB_TRUSTED_PROXY_HOPS,
      authPerMinute: env.BIB_RATELIMIT_AUTH_PER_MINUTE,
      generalPerMinute: env.BIB_RATELIMIT_GENERAL_PER_MINUTE,
    },
    mail: {
      from: env.BIB_MAIL_FROM ?? null,
      fromName: env.BIB_MAIL_FROM_NAME ?? null,
      // No host means no relay, whatever the other variables say. That keeps
      // "is it configured" a single question for validate.ts to ask.
      smtp:
        env.BIB_SMTP_HOST === undefined
          ? null
          : {
              host: env.BIB_SMTP_HOST,
              port: env.BIB_SMTP_PORT,
              secure:
                env.BIB_SMTP_SECURE !== undefined
                  ? env.BIB_SMTP_SECURE === "true"
                  : env.BIB_SMTP_PORT === 465,
              user: env.BIB_SMTP_USER ?? null,
              password: env.BIB_SMTP_PASSWORD ?? null,
            },
    },
    storage: {
      backend: env.BIB_STORAGE_BACKEND,
      root: env.BIB_STORAGE_ROOT,
      bucket: env.BIB_GCS_BUCKET ?? null,
      timeoutMs: env.BIB_GCS_TIMEOUT_MS,
      maxUploadBytes: env.BIB_MAX_UPLOAD_BYTES,
    },
    docusign: {
      oauthBase: env.BIB_DOCUSIGN_OAUTH_BASE,
      integrationKey: env.BIB_DOCUSIGN_INTEGRATION_KEY ?? null,
      userId: env.BIB_DOCUSIGN_USER_ID ?? null,
      accountId: env.BIB_DOCUSIGN_ACCOUNT_ID ?? null,
      privateKeyPem: env.BIB_DOCUSIGN_PRIVATE_KEY ?? null,
    },
    worker: {
      spawnCron: env.BIB_WORKER_SPAWN_CRON,
      dunningCron: env.BIB_WORKER_DUNNING_CRON,
      advanceDigestCron: env.BIB_WORKER_ADVANCE_DIGEST_CRON,
      notifyCron: env.BIB_WORKER_NOTIFY_CRON,
      orchestratorCron: env.BIB_WORKER_ORCHESTRATOR_CRON,
      obligationCron: env.BIB_WORKER_OBLIGATION_CRON,
      escalationCron: env.BIB_WORKER_ESCALATION_CRON,
      shutdownGraceMs: env.BIB_WORKER_SHUTDOWN_GRACE_MS,
    },
    db: {
      ownerUrl: env.BIB_DATABASE_URL,
      appUrl: env.BIB_APP_DATABASE_URL,
      appPassword,
      appPoolSize: env.BIB_DB_POOL_APP,
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
    build: cfg.build,
    db: {
      ownerUrl: maskUrl(cfg.db.ownerUrl),
      appUrl: maskUrl(cfg.db.appUrl),
      appPoolSize: cfg.db.appPoolSize,
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
