// cmd/fin-once — one run of FinCompliance, then exit (docs/FIN_BUILD_PLAN.md F0.5).
//
// This IS the fin process, not a demo of one. In an environment it runs as a
// Cloud Run Job every ten minutes; locally it is `npm run fin:once`. Each run
// does every fin sweep once and exits, and each sweep finds its work as "what
// has no result yet", so a run that never happened is caught up by the next.
// No queue, no long-lived process: a fin crash ends one run and the API and the
// core worker never notice.
//
// It exits at once, touching nothing, when BIB_FIN_ENABLED is off — the kill
// switch has to work without a database to ask.
//
// It runs every sweep fin has, and the list below is the list.
import pino from "pino";
import { load, redacted } from "../config/config";
import { validateServer } from "../config/validate";
import { assertLedgerAppendOnly, assertTenantWall } from "../db/boot-check";
import { wireFinJob } from "../setup/fin";

async function main(): Promise<void> {
  const cfg = load();
  const log = pino({ level: cfg.logLevel });

  if (!cfg.fin.enabled) {
    console.log("  fin is switched off (BIB_FIN_ENABLED is not \"true\") — nothing to do.");
    return;
  }

  // The same gate the API and the worker pass. The fin job reads every enabled
  // firm in turn with no session to constrain it, only the tenant context it
  // sets for itself, so it depends on the wall being up as much as they do.
  validateServer(cfg);
  log.debug({ config: redacted(cfg) }, "config loaded");

  const wired = wireFinJob(cfg);
  try {
    await assertTenantWall(wired.pools.app);
    await assertLedgerAppendOnly(wired.pools.app);

    // INTAKE (F2.1): files clients supplied, each sent to a reader.
    const intake = await wired.intake.sweep();
    // A firm the sweep could not run at all is the one thing here somebody has
    // to act on, so it is printed first.
    for (const r of intake.filter((x) => x.failure !== undefined)) {
      console.log(`  !! firm ${r.tenantId}: intake FAILED — ${r.failure ?? ""}`);
    }
    if (intake.length === 0) {
      console.log("  no firm has fin switched on (tenancy.tenant.fin_enabled_since) — nothing to take in.");
    }
    const taken = intake.reduce((n, r) => n + r.taken, 0);
    const manual = intake.reduce((n, r) => n + r.manual, 0);
    const already = intake.reduce((n, r) => n + r.alreadyTaken, 0);
    const backlog = intake.filter((r) => r.more).length;
    // The firms that took something in, not the firms visited: a firm with
    // fin on and nothing new is not part of "across".
    const firmsWithFiles = intake.filter((r) => r.taken > 0).length;
    if (intake.length > 0) {
      console.log(
        taken === 0
          ? `  nothing to take in at ${String(intake.length)} firm(s) — every file supplied since fin was switched on has been.`
          : `  took in ${String(taken)} file(s) at ${String(firmsWithFiles)} of ${String(intake.length)} firm(s) with fin on`,
      );
    }
    if (manual > 0) console.log(`  ${String(manual)} of them fit no reader and wait for a person`);
    // Printed because it is the number that shows idempotency working: two
    // runs at once take each file once.
    if (already > 0) console.log(`  ${String(already)} file(s) were taken in by another run first`);
    if (backlog > 0) console.log(`  ${String(backlog)} firm(s) have more files waiting for the next run`);
    console.log();

    // READING (F2.5): every file taken in, offered to the readers. After the
    // intake, so a file taken in on this run is read on it.
    const reads = await wired.reads.sweep();
    for (const r of reads.filter((x) => x.failure !== undefined)) {
      console.log(`  !! firm ${r.tenantId}: reading FAILED — ${r.failure ?? ""}`);
    }
    // Per item, after the firms: a fault an operator fixes (bytes missing from
    // the store) leaves the file unread; a reader that threw parks it as
    // `failed`. Either way, somebody has to look.
    for (const r of reads) {
      for (const f of r.failures) {
        const what = f.reader === null ? "left unread" : `failed in the ${f.reader} reader`;
        console.log(`  !! firm ${r.tenantId}: intake item ${f.intakeItemId} ${what} — ${f.error}`);
      }
    }
    const read = reads.reduce((n, r) => n + r.read, 0);
    const staged = reads.reduce((n, r) => n + r.staged, 0);
    const toPerson = reads.reduce((n, r) => n + r.needsPerson, 0);
    const failed = reads.reduce((n, r) => n + r.failed, 0);
    const lines = reads.reduce((n, r) => n + r.lines, 0);
    const later = reads.reduce((n, r) => n + r.later, 0);
    const alreadyRead = reads.reduce((n, r) => n + r.alreadyRead, 0);
    const readBacklog = reads.filter((r) => r.more).length;
    const why = new Map<string, number>();
    for (const r of reads) {
      for (const [problem, n] of Object.entries(r.byProblem)) why.set(problem, (why.get(problem) ?? 0) + (n ?? 0));
    }
    if (reads.length > 0) {
      console.log(
        read === 0
          ? "  nothing to read — every file taken in that a reader takes has been read."
          : `  read ${String(read)} file(s): ${String(staged)} staged for a person to commit (${String(lines)} line(s)), ` +
              `${String(toPerson)} for a person to read, ${String(failed)} failed`,
      );
    }
    if (why.size > 0) {
      console.log(`  for a person because: ${[...why].map(([problem, n]) => `${problem} ${String(n)}`).join(", ")}`);
    }
    // The AI reader answers `later` while it has no key or budget: those files
    // are offered again next run, not lost.
    if (later > 0) console.log(`  ${String(later)} file(s) left for a later run (a reader is not available now)`);
    if (alreadyRead > 0) console.log(`  ${String(alreadyRead)} file(s) were read by another run first`);
    if (readBacklog > 0) console.log(`  ${String(readBacklog)} firm(s) have more files to read on the next run`);
    console.log();
  } finally {
    await wired.pools.close();
  }
}

main().catch((err: unknown) => {
  console.error("fin:once failed:", err);
  process.exit(1);
});
