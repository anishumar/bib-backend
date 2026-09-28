// Setup readiness (V2.6) — no I/O, no SQL, no HTTP. The rules are in
// `domain/readiness`; this reads the facts on the firm's own day and hands them
// over.
import { readinessLines } from "../../domain/readiness/model";
import type { ReadinessLine } from "../../domain/readiness/model";
import { dayInZone } from "../../domain/scheduler/zone";
import type { Clock } from "../../platform/clock";
import type { FirmTimeZone, ReadinessFactSource } from "./ports";

export interface Deps {
  readonly facts: ReadinessFactSource;
  readonly timeZones: FirmTimeZone;
  readonly clock: Clock;
}

export interface Readiness {
  /** The firm's day the lines were computed on. */
  readonly asOf: string;
  readonly lines: readonly ReadinessLine[];
}

export class ReadinessService {
  constructor(private readonly deps: Deps) {}

  /**
   * The firm's setup, line by line.
   *
   * Computed on every read and never stored: fixing a gap turns its line done
   * on the next load, and nothing can say "done" about a firm that has since
   * come undone.
   */
  async readiness(tenantId: string): Promise<Readiness> {
    const day = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const facts = await this.deps.facts.factsFor(tenantId, day);
    return { asOf: day, lines: readinessLines({ ...facts, day }) };
  }
}
