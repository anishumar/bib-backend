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
// It runs ALL FIVE sweeps — spawn, orchestrate, dunning, the compliance
// calendar and the escalation ladder — because all five are what the worker
// does, and an entry point that mirrored part of the process would be a worse
// lie than none at all. It said THREE until T4.5, by which point it had run
// four for two tasks: a count in a comment is a fact that rots, so the list is
// spelt out.
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

    if (spawned === 0 && already === 0) {
      console.log("\n  nothing to spawn — no activated contract is without a job.\n");
    } else {
      console.log(`\n  spawned ${String(spawned)} job(s) across ${String(reports.length)} firm(s)`);
      // Printed rather than dropped: it is the number that shows idempotency
      // working. Running this twice SHOULD spawn nothing the second time, and a
      // silent second run looks identical to a broken one.
      if (already > 0) {
        console.log(`  ${String(already)} activation(s) already had a job — nothing done`);
      }
      console.log();
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

    // THE COMPLIANCE CALENDAR (T3.2), last, and after the spawn on purpose: an
    // engagement activated a moment ago should have its filings materialised on
    // the same run rather than "next time".
    const calendar = await wired.obligations.sweep();
    const brokenCalendars = calendar.filter((r) => r.failure !== undefined);
    for (const r of brokenCalendars) {
      console.log(`  ! firm ${r.tenantId}: calendar sweep FAILED — ${r.failure ?? ""}`);
    }
    const generated = calendar.reduce((n, r) => n + r.created, 0);
    const raisedTasks = calendar.reduce((n, r) => n + r.raised, 0);
    const uncovered = calendar.reduce((n, r) => n + r.uncoveredEngagements, 0);

    if (generated === 0 && raisedTasks === 0) {
      console.log("  nothing to generate — no live engagement is covered by a rule that dates.");
    } else {
      if (generated > 0) console.log(`  generated ${String(generated)} obligation(s)`);
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
  } finally {
    await wired.pools.close();
  }
}

main().catch((err: unknown) => {
  console.error("worker:once failed:", err);
  process.exit(1);
});
