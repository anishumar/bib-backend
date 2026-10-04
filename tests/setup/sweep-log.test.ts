// What the worker logs about each sweep (audit 2026-10-03, B32, B11, B13): a
// failure is always logged at error, whatever else the report says.
import { describe, expect, it } from "vitest";
import { logDunningSweep, logOrchestratorSweep, logSpawnSweep } from "../../src/setup/sweep-log";
import type { Logger } from "../../src/platform/log";

class RecordingLog implements Logger {
  readonly lines: { level: string; obj: unknown; msg: string | undefined }[] = [];
  info(obj: unknown, msg?: string): void {
    this.lines.push({ level: "info", obj, msg });
  }
  warn(obj: unknown, msg?: string): void {
    this.lines.push({ level: "warn", obj, msg });
  }
  error(obj: unknown, msg?: string): void {
    this.lines.push({ level: "error", obj, msg });
  }
}

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const nothing = {
  tasksFailed: 0,
  spawned: 0,
  alreadySpawned: 0,
  extended: 0,
  periodsSpawned: 0,
  periodsExtended: 0,
  awaitingFiscalYear: 0,
};

describe("the spawn sweep's log (B32)", () => {
  it("logs a firm whose spawn failed, though it spawned nothing", () => {
    const log = new RecordingLog();
    logSpawnSweep(log, [{ tenantId: A, ...nothing, failure: "no work states" }, { tenantId: B, ...nothing, spawned: 2 }]);
    expect(log.lines.map((l) => [l.level, (l.obj as { tenantId: string }).tenantId])).toEqual([
      ["error", A],
      ["info", B],
    ]);
    expect(log.lines[0]?.obj).toMatchObject({ failure: "no work states" });
  });

  it("logs period jobs and tasks that could not be routed, and stays quiet about a quiet firm", () => {
    const log = new RecordingLog();
    logSpawnSweep(log, [
      { tenantId: A, ...nothing, periodsSpawned: 3 },
      { tenantId: B, ...nothing, tasksFailed: 1 },
      { tenantId: B, ...nothing },
    ]);
    expect(log.lines.map((l) => l.level)).toEqual(["info", "warn"]);
  });
});

describe("the orchestrator and dunning sweeps' logs (B11, B13)", () => {
  it("logs a failed firm at error and the next firm's work as usual", () => {
    const log = new RecordingLog();
    const walk = { started: 0, advanced: 0, awaitingPeople: 0, completed: 0, awaitingTemplate: 0 };
    logOrchestratorSweep(log, [{ tenantId: A, ...walk, failure: "boom" }, { tenantId: B, ...walk, started: 1 }]);
    expect(log.lines.map((l) => l.level)).toEqual(["error", "info"]);

    const dun = new RecordingLog();
    logDunningSweep(dun, [
      { tenantId: A, escalated: 0, alreadyTaken: 0, awaitingApproval: 0, failure: "boom" },
      { tenantId: B, escalated: 1, alreadyTaken: 0, awaitingApproval: 0 },
    ]);
    expect(dun.lines.map((l) => l.level)).toEqual(["error", "info"]);
  });
});
