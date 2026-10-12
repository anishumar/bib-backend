// cmd/fin-extract-one — read ONE local file with the configured AI provider and
// print what the AI reader made of it (docs/FIN_BUILD_PLAN.md F2.4). For the
// first try with a key, and for looking at one document the scorecard got
// wrong. Development only.
//
//   npm run fin:extract-one -- <file>
//   npm run fin:extract-one -- <file> --client "Lumen Cloudworks Pte Ltd" --uen 202134890G --gst M2-9588401-7
//
// It calls the real provider, so it spends real tokens: one or two calls. It
// stores nothing (no firm, no intake item); the calls are printed instead of
// recorded.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
//
//   * BIB_FIN_AI_PROVIDER=none, which would read nothing;
//   * any path with a `99_` segment: the training pack's answer key grades the
//     reader and must never be read BY it (ground rule 6);
//   * a file that is not there.
//
// Whose books: from --client / --uen / --gst, else, for a file inside a
// training-pack company folder, that company's `00_Reference/company_profile.json`
// (an input the pack gives every reader, not the answer key), else nobody.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { load } from "../config/config";
import { validateServer } from "../config/validate";
import { extractOneFile } from "../setup/fin";
import type { LocalBooksOwner } from "../setup/fin";
import { mediaTypeFor } from "./fin-pack";

function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

/** The pack company folder this file sits in, if any (`Company_A_Lumen_Cloudworks`). */
function packCompanyDir(file: string): string | null {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (/^Company_[A-Z]_/.test(basename(dir))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function ownerFromPack(file: string): LocalBooksOwner | null {
  const company = packCompanyDir(file);
  if (company === null) return null;
  const profile = join(company, "00_Reference", "company_profile.json");
  if (!existsSync(profile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(profile, "utf8")) as {
      legal_name?: unknown;
      uen?: unknown;
      gst_reg_no?: unknown;
    };
    if (typeof parsed.legal_name !== "string") return null;
    return {
      names: [parsed.legal_name],
      uen: typeof parsed.uen === "string" ? parsed.uen : null,
      gstNo: typeof parsed.gst_reg_no === "string" ? parsed.gst_reg_no : null,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = argv.find((a, i) => !a.startsWith("--") && (i === 0 || !(argv[i - 1] ?? "").startsWith("--")));
  if (target === undefined) {
    console.log("usage: npm run fin:extract-one -- <file> [--client NAME] [--uen UEN] [--gst GST_NO]");
    process.exitCode = 2;
    return;
  }
  const file = resolve(target);
  if (file.split(sep).some((segment) => segment.startsWith("99_"))) {
    console.log(
      `  refused: ${file} is inside an answer key (99_Ground_Truth). It grades the reader and is never read by it.`,
    );
    process.exitCode = 2;
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    console.log(`  refused: ${file} is not a file.`);
    process.exitCode = 2;
    return;
  }

  const cfg = load();
  validateServer(cfg);
  if (cfg.finAi.provider === "none") {
    console.log(
      "  refused: BIB_FIN_AI_PROVIDER=none, so there is no provider to read with. Set " +
        "BIB_FIN_AI_PROVIDER=anthropic and BIB_FIN_ANTHROPIC_API_KEY in .env.",
    );
    process.exitCode = 2;
    return;
  }

  const client = flag(argv, "--client");
  const owner: LocalBooksOwner | null =
    client !== null
      ? { names: [client], uen: flag(argv, "--uen"), gstNo: flag(argv, "--gst") }
      : ownerFromPack(file);

  const filename = basename(file);
  console.log(`  reading ${filename} with ${cfg.finAi.model}`);
  console.log(
    owner === null
      ? "  books owner: not given (--client), so the model judges purchase or sale on its own"
      : `  books owner: ${owner.names.join(" / ")}${owner.uen === null ? "" : `, UEN ${owner.uen}`}${owner.gstNo === null ? "" : `, GST ${owner.gstNo}`}`,
  );

  const result = await extractOneFile(
    cfg,
    { bytes: new Uint8Array(readFileSync(file)), filename, mediaType: mediaTypeFor(filename) },
    owner,
  );

  console.log(`  route: ${result.route}`);
  for (const call of result.calls) {
    const u = call.usage;
    console.log(
      `  call ${String(call.attempt)}: ${call.outcome}${call.failure === null ? "" : ` (${call.failure})`}` +
        `${call.docClass === null ? "" : `, read as ${call.docClass}`} · ${call.model} · ${call.promptVersion} · ` +
        `tokens in ${String(u.inputTokens)}, out ${String(u.outputTokens)}, ` +
        `cache write ${String(u.cacheWriteTokens)}, cache read ${String(u.cacheReadTokens)}` +
        `${call.requestId === null ? "" : ` · ${call.requestId}`}`,
    );
  }
  console.log(JSON.stringify(result.outcome, null, 2));
}

main().catch((err: unknown) => {
  console.error("fin:extract-one failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
