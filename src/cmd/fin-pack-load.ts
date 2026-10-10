// cmd/fin-pack-load — load the 10x training pack into a sandbox firm
// (docs/FIN_BUILD_PLAN.md F0.10). Development only.
//
//   npm run fin:pack                               # all five companies
//   npm run fin:pack -- --companies A,E            # some of them
//   npm run fin:pack -- --slug fin-sandbox-2       # a second sandbox
//   npm run fin:pack -- --dry-run                  # list, upload nothing
//
// Against a RUNNING API (`npm run dev`), over HTTP, exactly as a person and the
// platform would: the firm is provisioned through /internal with the local
// platform key, fin is switched on there, and everything after that is a staff
// session — clients created on the Clients API, files uploaded through
// POST /api/v1/documents, so every upload is a real `document.stored` the fin
// job then takes in. No database credential is touched.
//
// Start the API with mail and e-sign stubbed so nothing leaves the machine:
//   BIB_MAIL_TRANSPORT=log BIB_ESIGN_PROVIDER=attested npm run dev
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
//
//   * any API that is not on this machine — it creates a login with a password
//     it prints;
//   * a slug that already exists — a second run into the same firm would upload
//     every file again and fin would take each in twice; pick a new --slug;
//   * the answer key: `99_Ground_Truth` is never walked (see cmd/fin-pack.ts).
//
// Folders 00-07 go up in pack order, as kind `other` against each company. The
// month-by-month replay through the monthly asks comes with F1.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { load } from "../config/config";
import { mediaTypeFor, packFiles } from "./fin-pack";
import type { PackFile } from "./fin-pack";

interface Args {
  readonly pack: string;
  readonly api: string;
  readonly slug: string;
  readonly companies: readonly string[] | undefined;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[], port: number): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const companies = value("--companies");
  return {
    pack: resolve(value("--pack") ?? "../fincompliace/SG_BiB_Training_Data_Pack"),
    api: value("--api") ?? `http://localhost:${String(port)}`,
    slug: value("--slug") ?? "fin-sandbox",
    companies: companies === undefined ? undefined : companies.split(",").map((c) => c.trim().toUpperCase()),
    dryRun: argv.includes("--dry-run"),
  };
}

function isLocal(api: string): boolean {
  try {
    const host = new URL(api).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Api {
  private cookie: string | null = null;
  constructor(
    private readonly base: string,
    private readonly platformKey: string,
  ) {}

  /** One call, waiting out the rate limiter rather than failing on it: the
   *  pack is a thousand uploads and the local limit is a few hundred a minute. */
  private async send(path: string, init: RequestInit, attempt = 0): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, init);
    if (res.status === 429 && attempt < 20) {
      const wait = Number(res.headers.get("retry-after") ?? "5");
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000);
      return this.send(path, init, attempt + 1);
    }
    return res;
  }

  async platform(method: string, path: string, body: unknown): Promise<Response> {
    return this.send(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.platformKey}` },
      body: JSON.stringify(body),
    });
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.send("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in as ${email} failed: ${String(res.status)} ${await res.text()}`);
    const session = res.headers.getSetCookie().find((c) => c.includes("="));
    if (session === undefined) throw new Error("sign-in answered without a session cookie");
    this.cookie = session.split(";")[0] ?? null;
  }

  async staff(method: string, path: string, body: unknown): Promise<Response> {
    return this.send(path, {
      method,
      headers: { "content-type": "application/json", cookie: this.cookie ?? "" },
      body: JSON.stringify(body),
    });
  }

  async upload(form: FormData): Promise<Response> {
    return this.send("/api/v1/documents", { method: "POST", headers: { cookie: this.cookie ?? "" }, body: form });
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: ${String(res.status)} ${text}`);
  return JSON.parse(text) as T;
}

interface Profile {
  readonly legal_name: string;
}

function profileOf(companyDir: string): Profile {
  return JSON.parse(readFileSync(join(companyDir, "00_Reference", "company_profile.json"), "utf8")) as Profile;
}

function summarise(files: readonly PackFile[]): void {
  const byCompany = new Map<string, Map<string, number>>();
  for (const f of files) {
    const folders = byCompany.get(f.company) ?? new Map<string, number>();
    folders.set(f.folder, (folders.get(f.folder) ?? 0) + 1);
    byCompany.set(f.company, folders);
  }
  for (const [company, folders] of byCompany) {
    const parts = [...folders].map(([folder, n]) => `${folder} ${String(n)}`).join(", ");
    console.log(`  ${company}: ${parts}`);
  }
}

async function main(): Promise<void> {
  const cfg = load();
  const args = parseArgs(process.argv.slice(2), cfg.port);
  const files = packFiles(args.pack, args.companies);
  if (files.length === 0) throw new Error(`no company folders (Company_X_...) found under ${args.pack}`);

  console.log(`\n  pack: ${args.pack}`);
  console.log(`  ${String(files.length)} file(s) to upload (99_Ground_Truth left out):`);
  summarise(files);
  if (args.dryRun) {
    console.log("\n  --dry-run: nothing uploaded.\n");
    return;
  }

  if (!isLocal(args.api)) {
    throw new Error(`refusing to load ${args.api}: the sandbox gets a login with a printed password, so the API must be on this machine`);
  }
  const key = cfg.auth.internalClients.find((c) =>
    ["tenant.provision", "user.provision", "membership.grant", "credential.set"].every((cap) =>
      (c.capabilities as readonly string[]).includes(cap),
    ),
  );
  if (key === undefined) {
    throw new Error("no BIB_INTERNAL_KEYS client carries tenant.provision, user.provision, membership.grant and credential.set");
  }
  const api = new Api(args.api, key.key);

  // ── The firm ────────────────────────────────────────────────────────────
  const created = await api.platform("POST", "/internal/v1/tenants", {
    name: "Fin Sandbox (10x training pack)",
    slug: args.slug,
    reportingCurrency: "SGD",
    country: "SG",
    timeZone: "Asia/Singapore",
  });
  if (created.status === 409) {
    throw new Error(`a firm with slug "${args.slug}" already exists. Loading again would upload every file twice; use --slug <new-slug>.`);
  }
  const tenant = await json<{ id: string }>(created, "creating the sandbox firm");

  const email = `fin+${args.slug}@sandbox.bib.local`;
  const password = randomBytes(12).toString("base64url");
  const user = await json<{ id: string }>(
    await api.platform("POST", "/internal/v1/users", { email, displayName: "Fin Sandbox Partner" }),
    "creating the sandbox login",
  );
  await json(
    await api.platform("POST", "/internal/v1/memberships", {
      tenantId: tenant.id,
      userId: user.id,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    }),
    "making the login a partner",
  );
  const pw = await api.platform("PUT", `/internal/v1/users/${user.id}/password`, { password });
  if (!pw.ok) throw new Error(`setting the password failed: ${String(pw.status)} ${await pw.text()}`);
  await json(await api.platform("PUT", `/internal/v1/tenants/${tenant.id}/fin`, { enabled: true }), "switching fin on");
  await api.login(email, password);
  console.log(`\n  firm ${args.slug} (${tenant.id}) provisioned, fin switched on`);

  // ── The clients, and their files ─────────────────────────────────────────
  const failures: string[] = [];
  let uploaded = 0;
  const companies = [...new Set(files.map((f) => f.companyDir))];
  for (const companyDir of companies) {
    const profile = profileOf(companyDir);
    const party = await json<{ partyId: string }>(
      await api.staff("POST", "/api/v1/parties/organizations", {
        legalName: profile.legal_name,
        jurisdiction: "SG",
        entityType: "pte_ltd",
        financialYearEnd: "12-31",
      }),
      `creating client ${profile.legal_name}`,
    );
    const theirs = files.filter((f) => f.companyDir === companyDir);
    for (const f of theirs) {
      const form = new FormData();
      const bytes = readFileSync(f.absPath);
      form.set("file", new Blob([bytes], { type: mediaTypeFor(f.relPath) }), basename(f.relPath));
      form.set("title", f.relPath);
      form.set("kind", "other");
      form.set("partyId", party.partyId);
      const res = await api.upload(form);
      if (res.ok) uploaded += 1;
      else failures.push(`${f.company} ${f.relPath}: ${String(res.status)} ${await res.text()}`);
    }
    console.log(`  ${profile.legal_name}: ${String(theirs.length)} file(s)`);
  }

  console.log(`\n  uploaded ${String(uploaded)} of ${String(files.length)} file(s)`);
  for (const f of failures) console.log(`  !! ${f}`);
  console.log(`\n  sign in:  ${email}`);
  console.log(`  password: ${password}`);
  console.log("\n  next:     BIB_FIN_ENABLED=true npm run fin:once\n");
}

main().catch((err: unknown) => {
  console.error("fin:pack failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
