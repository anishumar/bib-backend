// cmd/worker-once — run the sweep once and exit (T2.6).
//
// The scheduled worker waits for its cron; this is the same sweep with no queue
// in front of it, so the engine can be demonstrated and smoke-tested on demand
// instead of by waiting an hour. **A different entry point, never a different
// rule** — it calls the same `SchedulerService.sweepActivations` the queue
// handler calls, so anything true here is true there.
//
//   npm run worker:once
//
// It runs EVERY sweep the worker does — spawn, orchestrate, dunning, the
// compliance calendar, the escalation ladder, the chaser and the proactive
// nudge — because that is what the worker does, and an entry point that
// mirrored part of the process would be a worse lie than none at all.
//
// THE COUNT IN THIS COMMENT HAS NOW GONE STALE TWICE. It said THREE until T4.5
// and FIVE until T6.7, and on the second occasion it was worse than stale: T4.4
// registered the chaser on the worker's queue and never added it here, so this
// command claimed to run everything and quietly ran everything but the one
// sweep aimed at clients. There is no count in this sentence any more, and the
// list is the list.
import pino from "pino";
import { load } from "../config/config";
import { wireWorker } from "../setup/worker";

async function main(): Promise<void> {
  const cfg = load();
  const log = pino({ level: cfg.logLevel });
  const wired = wireWorker(cfg, log);

  try {
    // No queue is started: `wireWorker` builds the graph, and only `run()`
    // touches pg-boss. This path therefore needs no DDL rights on the pgboss
    // schema, which is what makes it usable from a smoke test.
    const reports = await wired.scheduler.sweepActivations();
    const spawned = reports.reduce((n, r) => n + r.spawned, 0);
    const already = reports.reduce((n, r) => n + r.alreadySpawned, 0);
    const tasksFailed = reports.reduce((n, r) => n + r.tasksFailed, 0);
    const periods = reports.reduce((n, r) => n + r.periodsSpawned, 0);
    const periodsGrew = reports.reduce((n, r) => n + r.periodsExtended, 0);
    const noFiscalYear = reports.reduce((n, r) => n + r.awaitingFiscalYear, 0);
    const skipped = reports.filter((r) => r.failure !== undefined);

    // PRINTED FIRST, and loudly. A firm the sweep could not run at all is the
    // one thing on this screen somebody has to act on — and before T3.1 found
    // it, one such firm silently stopped every firm after it in the list.
    for (const r of skipped) {
      console.log(`
  !! firm ${r.tenantId} was SKIPPED: ${r.failure ?? ""}`);
    }
    if (tasksFailed > 0) {
      // The job stands; the task did not. Separate numbers because they are
      // separate facts, and because a job with nothing on anybody's desk looks
      // exactly like a job nobody has started.
      console.log(
        `
  !! ${String(tasksFailed)} engagement(s) got a job but NO TASK — the work is ` +
          `recorded as owed and is on nobody's desk`,
      );
    }

    if (spawned === 0 && already === 0 && periods === 0 && periodsGrew === 0) {
      console.log(
        "\n  nothing to spawn — no activated contract is without a job, and every recurring " +
          "engagement has a job for every period that has begun.\n",
      );
    } else {
      console.log(`\n  spawned ${String(spawned)} job(s) across ${String(reports.length)} firm(s)`);
      // Printed rather than dropped: it is the number that shows idempotency
      // working. Running this twice SHOULD spawn nothing the second time, and a
      // silent second run looks identical to a broken one.
      if (already > 0) {
        console.log(`  ${String(already)} activation(s) already had a job — nothing done`);
      }
      // THE PER-PERIOD SPAWN (T6.13). Its own lines because it is its own
      // fact: a month began, not a letter was signed.
      if (periods > 0) {
        console.log(
          `  spawned ${String(periods)} period job(s) — a month or quarter that has begun`,
        );
      }
      if (periodsGrew > 0) {
        console.log(`  ${String(periodsGrew)} period job(s) gained an engagement`);
      }
      console.log();
    }
    // PRINTED WHETHER OR NOT ANYTHING SPAWNED. A quarterly service at a firm
    // that has not said when its year starts gets no job and no error, and
    // this line is the difference between "nothing is owed" and "nothing
    // could be cut".
    if (noFiscalYear > 0) {
      console.log(
        `  ${String(noFiscalYear)} quarterly/annual engagement(s) got NO period job — the firm ` +
          `has not published fiscalYearStartMonth on its compliance policy\n`,
      );
    }

    // EVERY sweep, because every sweep is what the worker does. Running only
    // one here would make this entry point a partial mirror of the process it
    // exists to stand in for — and the engine would be demonstrable only by
    // waiting for a cron.
    // ORCHESTRATE BEFORE CHASING, and in the same order the worker's crons put
    // them: a job spawned a moment ago should have its steps written on the same
    // run, so `worker:once` shows the whole engine rather than a job that will
    // start "next time".
    const walked = await wired.orchestrator.sweep();
    const started = walked.reduce((n, r) => n + r.started, 0);
    const advanced = walked.reduce((n, r) => n + r.advanced, 0);
    const onDesks = walked.reduce((n, r) => n + r.awaitingPeople, 0);
    const finished = walked.reduce((n, r) => n + r.completed, 0);
    const noProcess = walked.reduce((n, r) => n + r.awaitingTemplate, 0);

    if (started === 0 && advanced === 0 && noProcess === 0) {
      console.log("  nothing to walk — no job has a step that can move.\n");
    } else {
      if (started > 0) console.log(`  started ${String(started)} job(s) — steps written`);
      if (advanced > 0) console.log(`  moved ${String(advanced)} step(s)`);
      // The two numbers somebody has to ACT on, and they are different people.
      if (onDesks > 0) console.log(`  ${String(onDesks)} step(s) are waiting for a person`);
      if (noProcess > 0) {
        console.log(
          `  ${String(noProcess)} job(s) are waiting for a workflow template to be published`,
        );
      }
      if (finished > 0) console.log(`  ${String(finished)} job(s) completed`);
      console.log();
    }

    const dunning = await wired.dunning.sweep();
    const escalated = dunning.reduce((n, r) => n + r.escalated, 0);
    const waiting = dunning.reduce((n, r) => n + r.awaitingApproval, 0);

    if (escalated === 0) {
      console.log("  nothing to chase — no receivable has reached a rung it has not had.\n");
    } else {
      console.log(`  climbed ${String(escalated)} dunning rung(s)`);
      // The number somebody has to ACT on: the worker reached a credit hold or
      // a legal step and stopped, and nothing further happens without a partner.
      if (waiting > 0) {
        console.log(`  ${String(waiting)} terminal step(s) are waiting for a partner`);
      }
      console.log();
    }

    // BILLING DUES (0318): only firms that turned auto-billing on.
    const billing = await wired.billing.sweep();
    for (const r of billing) {
      if (r.failure !== undefined) console.log(`  billing: firm ${r.tenantId} could not be visited — ${r.failure}`);
    }
    const dues = billing.reduce((n, r) => n + r.created, 0);
    const noYear = billing.reduce((n, r) => n + r.awaitingFiscalYear, 0);
    if (dues === 0) {
      console.log("  no bill has fallen due that is not already on the list.");
    } else {
      console.log(`  ${String(dues)} bill(s) fell due and are waiting to be raised`);
    }
    if (noYear > 0) {
      console.log(`  ${String(noYear)} quarterly or yearly bill(s) wait for the firm's financial year to be set`);
    }
    // THE ADVANCE AND THE FINAL BILL (0320): letters still owing an advance
    // bill (every firm), and one-time work finished with no final bill yet.
    const advances = await wired.advanceBills.catchUp();
    const finals = await wired.finalBills.sweep();
    for (const r of [...advances, ...finals]) {
      if (r.failure !== undefined) console.log(`  advance/final bills: firm ${r.tenantId} could not be visited — ${r.failure}`);
    }
    const advanceCount = advances.reduce((n, r) => n + r.created, 0);
    const finalCount = finals.reduce((n, r) => n + r.created, 0);
    if (advanceCount > 0) console.log(`  ${String(advanceCount)} advance bill(s) written for signed letters`);
    if (finalCount > 0) console.log(`  ${String(finalCount)} final bill(s) written for finished one-time work`);
    console.log();

    // THE COMPLIANCE CALENDAR (T3.2), last, and after the spawn on purpose: an
    // engagement activated a moment ago should have its filings materialised on
    // the same run rather than "next time".
    const calendar = await wired.obligations.sweep();
    const brokenCalendars = calendar.filter((r) => r.failure !== undefined);
    for (const r of brokenCalendars) {
      console.log(`  ! firm ${r.tenantId}: calendar sweep FAILED — ${r.failure ?? ""}`);
    }
    const generated = calendar.reduce((n, r) => n + r.created, 0);
    const restoredFilings = calendar.reduce((n, r) => n + r.restored, 0);
    const raisedTasks = calendar.reduce((n, r) => n + r.raised, 0);
    const uncovered = calendar.reduce((n, r) => n + r.uncoveredEngagements, 0);

    if (generated === 0 && restoredFilings === 0 && raisedTasks === 0) {
      console.log(
        "  nothing to generate — no live engagement's service carries a filing that dates " +
          "(filings are added to services in the Catalogue).",
      );
    } else {
      if (generated > 0) console.log(`  generated ${String(generated)} obligation(s)`);
      if (restoredFilings > 0) {
        console.log(`  brought back ${String(restoredFilings)} filing(s) a service carries again`);
      }
      if (raisedTasks > 0) {
        console.log(`  raised ${String(raisedTasks)} task(s) at T-X`);
      }
    }
    // PRINTED WHETHER OR NOT ANYTHING GENERATED, and that is the point. An
    // empty calendar with nothing said about it is indistinguishable from
    // broken software; this line is the difference between "nothing is owed"
    // and "nothing was worked out, and here is where to look".
    if (uncovered > 0) {
      console.log(
        `  ${String(uncovered)} live engagement(s) produced NO calendar rows — ` +
          `open /calendar/coverage to see why (most will be advisory work with no ` +
          `compliance rule, which is normal)`,
      );
    }
    console.log();

    // THE ESCALATION LADDER (T4.5), last and after the calendar on purpose: a
    // filing that reached its internal target on this very run should be able
    // to escalate on the same one rather than "tomorrow".
    const ladder = await wired.escalations.sweep();
    for (const r of ladder.filter((x) => x.failure !== undefined)) {
      console.log(`  ! firm ${r.tenantId}: escalation sweep FAILED — ${r.failure ?? ""}`);
    }
    const climbed = ladder.reduce((n, r) => n + r.raised, 0);
    const unresolved = ladder.reduce((n, r) => n + r.unresolved, 0);

    if (climbed === 0) {
      console.log("  nothing to escalate — no open work has reached a rung it has not had.");
    } else {
      console.log(`  climbed ${String(climbed)} escalation rung(s)`);
      // The number somebody has to ACT on, and it is not a failure of the
      // sweep: the rung fired and reached nobody, because the firm has no
      // reporting line above that person or nobody holds the grade it names.
      if (unresolved > 0) {
        console.log(
          `  ${String(unresolved)} of them reached NOBODY — the queue says why on each row`,
        );
      }
    }
    console.log();

    // THE CHASER (T4.4). After the ladder because both are daily sweeps and
    // neither depends on the other, and because this is the order the worker
    // registers them in — an entry point that ran them in a different order
    // would be a second arrangement nobody chose.
    //
    // IT WAS MISSING FROM THIS FILE UNTIL T6.7, which is the whole reason the
    // header above no longer counts anything.
    const chases = await wired.chaser.sweep();
    for (const r of chases.filter((x) => x.failure !== undefined)) {
      console.log(`  ! firm ${r.tenantId}: chaser sweep FAILED — ${r.failure ?? ""}`);
    }
    const chased = chases.reduce((n, r) => n + r.sent, 0);
    const frozen = chases.reduce((n, r) => n + r.frozen, 0);
    if (chased === 0) {
      // TWO CAUSES, AND THE LINE MUST NOT PICK ONE. The first draft asserted
      // the firm had published no ladder, and the demo publishes one — so the
      // command was telling a partner something demonstrably false about their
      // own configuration on the run that proved it. Both reasons are named.
      console.log(
        "  nothing to chase — either no open client ask has reached a rung it has not had, " +
          "or this firm has published no chaser ladder, which means it chases nobody.",
      );
    } else {
      console.log(`  raised ${String(chased)} client reminder(s)`);
    }
    // THE NUMBER THAT EXPLAINS A QUIET WEEK, and the one nobody would think to
    // print: a sweep that sent nothing because every client is frozen and one
    // that sent nothing because it is broken look identical from the outside.
    if (frozen > 0) {
      console.log(
        `  ${String(frozen)} ask(s) skipped — their client is frozen (a dispute somebody is negotiating)`,
      );
    }
    console.log();

    // THE PROACTIVE NUDGE (T6.7). Last, and after the calendar for the same
    // reason the escalation ladder is: a filing generated on this very run
    // should be able to be nudged about on the same one rather than "tomorrow".
    const nudged = await wired.nudges.sweep();
    for (const r of nudged.filter((x) => x.failure !== undefined)) {
      console.log(`  ! firm ${r.tenantId}: nudge sweep FAILED — ${r.failure ?? ""}`);
    }
    const told = nudged.reduce((n, r) => n + r.sent, 0);
    if (told === 0) {
      console.log(
        "  nothing to nudge about — either no unfiled obligation has reached a rung it has " +
          "not had, or this firm has published no nudge ladder, which means it tells nobody.",
      );
    } else {
      console.log(`  told clients about ${String(told)} upcoming filing(s)`);
    }
    console.log();

    // SIGNATURES (0080). Nothing to ask when the provider sends nothing, and
    // the line says which of the two quiet answers this is.
    const settled = await wired.engagement.settleSignatures();
    for (const r of settled.filter((x) => x.failure !== undefined)) {
      console.log(`  ! firm ${r.tenantId}: signature sweep FAILED — ${r.failure ?? ""}`);
    }
    for (const r of settled) {
      for (const f of r.failed) {
        console.log(`  ! letter ${f.letterId}: not settled — ${f.reason}`);
      }
    }
    const signedNow = settled.reduce((n, r) => n + r.signed, 0);
    const pulledNow = settled.reduce((n, r) => n + r.withdrawn, 0);
    const stillOut = settled.reduce((n, r) => n + r.stillOut, 0);
    if (signedNow === 0 && pulledNow === 0) {
      console.log(
        stillOut === 0
          ? "  no envelope is out for signature — or the e-sign provider sends none (attested)."
          : `  ${String(stillOut)} envelope(s) out for signature, none finished yet`,
      );
    } else {
      if (signedNow > 0) console.log(`  ${String(signedNow)} letter(s) signed by the client`);
      if (pulledNow > 0) console.log(`  ${String(pulledNow)} letter(s) withdrawn — declined or voided`);
    }
    const copiesNow = settled.reduce((n, r) => n + r.copiesFiled, 0);
    if (copiesNow > 0) console.log(`  filed the signed copy and certificate for ${String(copiesNow)} letter(s)`);
    console.log();
  } finally {
    await wired.pools.close();
  }
}

main().catch((err: unknown) => {
  console.error("worker:once failed:", err);
  process.exit(1);
});
